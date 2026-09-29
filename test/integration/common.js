const assert = require('node:assert/strict')
const { format, isDeepStrictEqual } = require('node:util')
const { mock } = require('node:test')
const nock = require('nock')
const any = require('@travi/any')
const settingsBot = require('../../index')
const settings = require('../../lib/settings')

const GITHUB_API = 'https://api.github.com'
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
const ERROR_LEVELS = new Set(['error', 'fatal'])

nock.disableNetConnect()

const repository = {
  default_branch: 'master',
  name: 'botland',
  owner: {
    name: 'bkeepers-inc',
    email: null
  }
}

// State for the currently running test. `node --test` runs each file in its
// own process and the tests within a file sequentially, so a single slot is
// enough to isolate one test from the next.
let current = null

/**
 * Minimal pino-compatible logger handed to Probot (and, through Probot, to the
 * app and its Octokit instances). Every error/fatal entry is recorded so that
 * teardown can fail the test even when production code catches and logs an
 * error instead of rethrowing it. Set LOG_LEVEL to echo entries to stderr.
 */
function createRecordingLogger (errors) {
  const threshold = LOG_LEVELS.indexOf(process.env.LOG_LEVEL)
  const build = bindings => {
    const log = { level: process.env.LOG_LEVEL || 'silent' }
    for (const [index, level] of LOG_LEVELS.entries()) {
      log[level] = (...args) => {
        const message = format(...args.map(arg => arg instanceof Error ? arg.stack : arg))
        if (ERROR_LEVELS.has(level)) errors.push(`[${level}] ${message}`)
        if (threshold !== -1 && index >= threshold) {
          process.stderr.write(`${level.toUpperCase()} ${JSON.stringify(bindings)} ${message}\n`)
        }
      }
    }
    log.child = childBindings => build({ ...bindings, ...childBindings })
    return log
  }
  return build({})
}

/**
 * Creates a real Probot instance with the settings app loaded and fully
 * initialized. Probot 14 is ESM-only, so it is imported dynamically.
 */
async function loadInstance () {
  assert.equal(current?.probot, undefined, 'loadInstance() called twice in one test')
  const state = current || beginTest()

  // The app runs `info()` on load (without awaiting it), which lists the app
  // installations. Answer that call once and wait for it below so it cannot
  // leak into, or race with, the per-test scopes.
  const startup = nock(GITHUB_API)
    .get('/app/installations')
    .query(true)
    .reply(200, [])
  const startupReplied = new Promise(resolve => startup.once('replied', resolve))

  const { createProbot } = await import('probot')
  // A `githubToken` selects Octokit's token auth strategy, which avoids the
  // app-auth JWT/installation-token calls that the nock scopes don't mock.
  // An empty `env` keeps a developer's APP_ID/PRIVATE_KEY/GHE_HOST from
  // changing the credentials or API base URL the fixtures are written for.
  const probot = createProbot({
    env: {},
    overrides: {
      appId: 1,
      githubToken: 'test',
      log: createRecordingLogger(state.errors)
    }
  })
  await probot.load(settingsBot)
  await startupReplied
  // Let the remainder of `info()` settle before the test delivers events.
  await new Promise(resolve => setImmediate(resolve))

  state.probot = probot
  return probot
}

function beginTest () {
  current = { errors: [], bodyMismatches: [] }
  // Mirror the Jest unit-suite guard: unexpected console.error output fails
  // the test. Calls are recorded (not thrown) so they can't be swallowed.
  mock.method(console, 'error', (...args) => {
    current.errors.push(`[console.error] ${format(...args)}`)
  })
  return current
}

function initializeNock () {
  if (!current) beginTest()
  return nock(GITHUB_API)
}

/**
 * Nock request-body matcher equivalent to Jest's `toMatchObject`. Mismatches
 * are recorded and reported by `teardownNock` to explain unmatched requests.
 */
function bodyMatching (expected) {
  return body => {
    if (matchesObject(body, expected)) return true
    current?.bodyMismatches.push(`expected body to match ${JSON.stringify(expected)}, got ${JSON.stringify(body)}`)
    return false
  }
}

function matchesObject (actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesObject(actual[index], value))
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) => key in actual && matchesObject(actual[key], value))
  }
  return isDeepStrictEqual(actual, expected)
}

/**
 * Asserts every expected request happened and that nothing was logged at
 * error level, then always resets nock and mocks so tests stay isolated.
 */
function teardownNock (githubScope) {
  const state = current
  current = null
  try {
    const problems = []
    if (!githubScope.isDone()) {
      problems.push(`Expected requests were not made:\n  ${githubScope.pendingMocks().join('\n  ')}`)
      problems.push(...(state?.bodyMismatches || []))
    }
    if (state?.errors.length) {
      problems.push(`Unexpected errors were logged:\n  ${state.errors.join('\n  ')}`)
    }
    assert.ok(problems.length === 0, problems.join('\n'))
  } finally {
    nock.cleanAll()
    mock.restoreAll()
  }
}

function buildPushEvent () {
  return {
    name: 'push',
    payload: {
      ref: 'refs/heads/master',
      repository,
      commits: [{ modified: [settings.FILE_PATH], added: [] }]
    }
  }
}

function buildRepositoryEditedEvent () {
  return {
    name: 'repository.edited',
    payload: {
      changes: { default_branch: { from: any.word() } },
      repository
    }
  }
}

function buildRepositoryCreatedEvent () {
  return {
    name: 'repository.created',
    payload: { repository }
  }
}

function buildTriggerEvent () {
  return any.fromList([buildPushEvent(), buildRepositoryCreatedEvent(), buildRepositoryEditedEvent()])
}

module.exports = {
  GITHUB_API,
  loadInstance,
  initializeNock,
  teardownNock,
  bodyMatching,
  buildTriggerEvent,
  buildRepositoryCreatedEvent,
  buildRepositoryEditedEvent,
  repository
}
