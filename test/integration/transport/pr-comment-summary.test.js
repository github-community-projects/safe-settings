const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const vm = require('node:vm')
const { test } = require('node:test')
const Settings = require('../../../lib/settings')
const env = require('../../../lib/env')

const source = fs.readFileSync(require.resolve('../../../smoke-test'), 'utf8')
const phaseSource = source.slice(
  source.indexOf('async function phase27PrCommentSummary ('),
  source.indexOf('\nasync function phase23ConfigLoading (')
)

async function fixture (t, { lookupStatus = 404, failAt, failCleanup = false } = {}) {
  const { Octokit } = await import('octokit')
  const requests = []
  const comments = []
  const checks = []
  const assertions = []
  const logs = []
  const failures = []
  let deleted = false
  const repoPath = '/repos/test-org/smoke-pr-comment-summary'
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    let body = ''
    for await (const chunk of request) body += chunk
    const data = body ? JSON.parse(body) : {}
    const route = `${request.method} ${url.pathname}`
    requests.push({ route, data })
    response.setHeader('content-type', 'application/json')
    const reply = (status, value) => {
      response.statusCode = status
      response.end(status === 204 ? undefined : JSON.stringify(value))
    }
    if (route === failAt) return reply(403, { message: 'Controlled reporting failure' })
    if (route === `GET ${repoPath}`) return reply(lookupStatus, { message: 'Lookup response' })
    if (route === 'POST /orgs/test-org/repos') return reply(201, { default_branch: 'main' })
    if (route === `GET ${repoPath}/git/ref/heads%2Fmain`) return reply(200, { object: { sha: 'base-sha' } })
    if (route === `POST ${repoPath}/git/refs`) return reply(201, { ref: data.ref })
    if (route === `PUT ${repoPath}/contents/reporting-fixture.txt`) return reply(201, { commit: { sha: 'fixture-sha' } })
    if (route === `POST ${repoPath}/pulls`) return reply(201, { number: 1 })
    if (route === `POST ${repoPath}/check-runs`) {
      const check = { ...data, id: checks.length + 1, html_url: `https://github.com/test-org/smoke-pr-comment-summary/runs/${checks.length + 1}` }
      checks.push(check)
      return reply(201, check)
    }
    const checkId = url.pathname.match(/\/check-runs\/(\d+)$/)?.[1]
    if (checkId && request.method === 'PATCH') {
      Object.assign(checks[Number(checkId) - 1], data)
      return reply(200, checks[Number(checkId) - 1])
    }
    if (checkId && request.method === 'GET') return reply(200, checks[Number(checkId) - 1])
    if (route === `POST ${repoPath}/issues/1/comments`) {
      const comment = { ...data, id: comments.length + 1 }
      comments.push(comment)
      return reply(201, comment)
    }
    if (route === `GET ${repoPath}/issues/1/comments`) return reply(200, comments)
    if (route === `DELETE ${repoPath}`) {
      if (failCleanup) return reply(403, { message: 'Controlled cleanup failure' })
      deleted = true
      return reply(204)
    }
    reply(400, { message: `Unexpected request: ${route}` })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const octokit = new Octokit({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    retry: { enabled: false },
    throttle: { enabled: false },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
  const run = vm.runInNewContext(`${phaseSource}\nphase27PrCommentSummary`, {
    ORG: 'test-org',
    orgInstallation: { id: 123, account: { login: 'test-org' } },
    octokit,
    Buffer,
    URL,
    structuredClone,
    logPhase: message => logs.push(message),
    log: message => logs.push(message),
    logFail: message => failures.push(message),
    assert: (condition, message) => {
      assertions.push({ condition, message })
      return condition
    },
    require: name => {
      if (name === './lib/settings') return Settings
      if (name === './lib/env') return env
      throw new Error(`Unexpected smoke dependency ${name}`)
    }
  })
  return { run, requests, comments, checks, assertions, logs, failures, deleted: () => deleted }
}

test('phase 27 exercises real Settings and installed Octokit serialization/readback and owned cleanup', async t => {
  const state = await fixture(t)
  const flags = { ...env }
  await state.run()
  assert.deepEqual(env, flags, 'reporting flags restored')
  assert.equal(state.checks.length, 7)
  assert.equal(state.comments.length, 9)
  assert.equal(state.assertions.length, 46)
  assert(state.assertions.every(result => result.condition), 'all maintained assertions passed')
  assert.deepEqual(state.failures, [])
  assert(state.deleted())
  assert(state.logs.includes('Phase 27 complete'))
  assert.equal(state.requests.filter(item => item.route.startsWith('PATCH ')).length, 7)
  assert(state.comments.every(comment => comment.body.length <= 55536))
  assert(state.comments.some(comment => comment.body.length === 55536))
  assert(state.checks.every(check => check.output.summary.length <= 55536 && !check.output.summary.includes('I have reviewed')))
  assert.deepEqual(state.requests.filter(item => item.route.startsWith('DELETE ')).map(item => item.route),
    ['DELETE /repos/test-org/smoke-pr-comment-summary'])
})

for (const lookupStatus of [200, 403]) {
  test(`phase 27 refuses an existing or inaccessible fixture (HTTP ${lookupStatus}) without mutation`, async t => {
    const state = await fixture(t, { lookupStatus })
    await assert.rejects(state.run, lookupStatus === 200 ? /refuses to overwrite/ : /Lookup response/)
    assert.equal(state.requests.length, 1)
    assert.equal(state.deleted(), false)
  })
}

for (const failAt of [
  'POST /orgs/test-org/repos',
  'POST /repos/test-org/smoke-pr-comment-summary/pulls',
  'POST /repos/test-org/smoke-pr-comment-summary/issues/1/comments'
]) {
  test(`phase 27 preserves flags and removes only a successfully created fixture after ${failAt} fails`, async t => {
    const state = await fixture(t, { failAt })
    const flags = { ...env }
    await assert.rejects(state.run, /Controlled reporting failure/)
    assert.deepEqual(env, flags)
    assert.equal(state.deleted(), failAt !== 'POST /orgs/test-org/repos')
    assert(!state.logs.includes('Phase 27 complete'))
  })
}

test('phase 27 reports and propagates cleanup failure instead of claiming completion', async t => {
  const state = await fixture(t, {
    failAt: 'POST /repos/test-org/smoke-pr-comment-summary/pulls',
    failCleanup: true
  })
  await assert.rejects(state.run, error => {
    assert.equal(error.name, 'AggregateError')
    assert.deepEqual(Array.from(error.errors, item => item.message), ['Controlled reporting failure', 'Controlled cleanup failure'])
    return true
  })
  assert.deepEqual(state.failures, ['27: owned fixture cleanup failed: Controlled cleanup failure'])
  assert.equal(state.deleted(), false)
  assert(!state.logs.includes('Phase 27 complete'))
})
