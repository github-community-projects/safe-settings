#!/usr/bin/env node

/**
 * Hub-Sync Smoke Test for safe-settings
 *
 * Exercises Hub-Sync end-to-end through an ALREADY RUNNING safe-settings app
 * that is configured for Hub-Sync. The test reuses the app's own settings
 * (from `.env` / the environment) instead of defining its own:
 *
 *   Hub repo     SAFE_SETTINGS_HUB_ORG / SAFE_SETTINGS_HUB_REPO (must exist)
 *   Hub path     CONFIG_PATH / SAFE_SETTINGS_HUB_PATH
 *   Target repo  ADMIN_REPO — Hub-Sync always writes to this repo in each target org
 *   App auth     APP_ID + PRIVATE_KEY (or PRIVATE_KEY_PATH)
 *
 * Smoke-test specific settings:
 *   HUB_SMOKE_TARGET_ORG  (required) sandbox target (spoke) org. The GitHub App
 *                         must be installed there (checked before setup), and
 *                         ADMIN_REPO must NOT exist there yet — setup creates
 *                         it, teardown deletes it.
 *   HUB_SMOKE_APP_URL     URL of the running app (default:
 *                         http://localhost:$PORT$SAFE_SETTINGS_HUB_URL_PREFIX)
 *
 * Usage:
 *   node smoke-test-hub-sync.js                  setup → phases 1-6 → teardown
 *   node smoke-test-hub-sync.js --interactive    pause after each phase
 *   node smoke-test-hub-sync.js --phase 1,2      setup → selected phases → teardown
 *   node smoke-test-hub-sync.js --teardown-only  clean up after an aborted/crashed run
 *
 * Phases (case IDs from docs/hubSyncHandler/usecase-merge-behavior.md):
 *   1  Import the target org into the Hub; the PR is closed, not merged (H1)
 *   2  Invalid YAML fails the check; closing the PR syncs nothing (F2, E2)
 *   3  Merge an org change and inspect the sync PR (A1/A2/A4/A5, C1/C3-C8, F1/F3)
 *   4  Remove an inherited section: check warning, still inherited (C2)
 *   5  Merge into a non-default Hub branch syncs nothing (E3)
 *   6  Import again is skipped as already_imported (H2)
 *   Phases 4 and 6 need phase 3, which is added automatically.
 *   A full run takes about 5-8 minutes (negative cases wait QUIET_WAIT_MS each).
 *
 * Hub requirements: the app must run with SAFE_SETTINGS_HUB_DIRECT_PUSH off, and
 * the Hub must not have an organizations/<HUB_SMOKE_TARGET_ORG> folder yet.
 * Phases 3-5 squash-merge test PRs into the Hub; teardown restores the changed
 * files with direct commits (which do not trigger Hub-Sync). Sync PRs in the
 * target repo are never merged and are removed with the target repo.
 *
 * Safety:
 *   - The target repo is created by the test and tagged with a marker in its
 *     description. Setup aborts if ADMIN_REPO already exists in the target org
 *     without the marker, and teardown only deletes a marked repo.
 *   - The Hub repo is never created or deleted. Test phases must register every
 *     Hub change (trackHubFile / trackHubBranch / trackHubPullRequest) so that
 *     teardown can revert it. The registry is persisted to STATE_FILE so
 *     `--teardown-only` can clean up after a crash.
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const yaml = require('js-yaml')

// ─── Configuration ───────────────────────────────────────────────────────────

function loadEnv () {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) throw new Error('.env file not found')
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  let currentKey = null
  let currentValue = ''
  let inMultiline = false

  for (const line of lines) {
    if (inMultiline) {
      currentValue += '\n' + line
      if (line.includes('"') || line.includes("'")) {
        const val = currentValue.replace(/^["']|["']$/g, '')
        if (!(currentKey in process.env)) process.env[currentKey] = val
        inMultiline = false
      }
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    currentKey = trimmed.slice(0, eqIdx).trim()
    currentValue = trimmed.slice(eqIdx + 1).trim()
    if ((currentValue.startsWith('"') && !currentValue.endsWith('"')) ||
        (currentValue.startsWith("'") && !currentValue.endsWith("'"))) {
      inMultiline = true
      continue
    }
    const val = currentValue.replace(/^["']|["']$/g, '')
    if (!(currentKey in process.env)) process.env[currentKey] = stripInlineComment(currentValue, val)
  }
}

// Like dotenv: unquoted values end at an inline " #" comment.
function stripInlineComment (raw, val) {
  if (/^["']/.test(raw)) return val
  return val.replace(/\s+#.*$/, '').trim()
}

loadEnv()

// Loaded after loadEnv() so they see the same settings as the running app.
const appEnv = require('./lib/env')
const { normalizeManifestRules, matchesOrgTargets } = require('./lib/hubSyncHandler')

const HUB_SMOKE_HUB_ORG = (process.env.SAFE_SETTINGS_HUB_ORG || '').trim()
const HUB_SMOKE_HUB_REPO = (process.env.SAFE_SETTINGS_HUB_REPO || '').trim()
const HUB_SMOKE_HUB_PATH = appEnv.SAFE_SETTINGS_HUB_PATH.trim()
const HUB_SMOKE_CONFIG_PATH = appEnv.CONFIG_PATH.trim()
const HUB_SMOKE_HUB_ROOT = `${HUB_SMOKE_CONFIG_PATH}/${HUB_SMOKE_HUB_PATH}`.replace(/\/+/g, '/')
const HUB_SMOKE_TARGET_ORG = (process.env.HUB_SMOKE_TARGET_ORG || '').trim()
const HUB_SMOKE_TARGET_REPO = appEnv.ADMIN_REPO.trim()
const HUB_SMOKE_APP_URL = (process.env.HUB_SMOKE_APP_URL ||
  `http://localhost:${process.env.PORT || 3000}${appEnv.SAFE_SETTINGS_HUB_URL_PREFIX}`).replace(/\/+$/, '')
const HUB_SMOKE_APP_ID = process.env.APP_ID
const HUB_SMOKE_PRIVATE_KEY = (() => {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
  const keyPath = path.resolve(__dirname, appEnv.PRIVATE_KEY_PATH)
  return fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : ''
})()

// Repos created by this test carry this marker; teardown only deletes marked repos.
const SMOKE_MARKER = '[safe-settings hub-sync smoke test]'
// Persisted registry of Hub changes to revert during teardown.
const STATE_FILE = path.join(__dirname, '.smoke-hub-sync-state.json')

const POLL_INTERVAL_MS = 5000
const MAX_POLL_MS = 120000
// How long negative tests wait to confirm that nothing was synced.
const QUIET_WAIT_MS = 60000
const CHECK_NAME = 'Safe-setting validator'
const RUN_ID = Date.now().toString(36)

const INTERACTIVE = process.argv.includes('--interactive')
const TEARDOWN_ONLY = process.argv.includes('--teardown-only')

const PHASE_ARG_IDX = process.argv.indexOf('--phase')
function parsePhaseSet (raw) {
  if (!raw) return null
  const nums = new Set()
  for (const part of raw.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      for (let i = parseInt(range[1], 10); i <= parseInt(range[2], 10); i++) nums.add(i)
    } else if (/^\d+$/.test(part.trim())) {
      nums.add(parseInt(part.trim(), 10))
    }
  }
  return nums.size > 0 ? nums : null
}
const ONLY_PHASES = PHASE_ARG_IDX !== -1 ? parsePhaseSet(process.argv[PHASE_ARG_IDX + 1]) : null
// Phases 4 (removed section) and 6 (re-import) build on the files merged in phase 3.
if (ONLY_PHASES && (ONLY_PHASES.has(4) || ONLY_PHASES.has(6))) ONLY_PHASES.add(3)

class InteractiveExit extends Error {
  constructor (action) {
    super(`interactive:${action}`)
    this.action = action
  }
}

// ─── Octokit clients (initialized in main) ───────────────────────────────────

let hubOctokit = null
let targetOctokit = null
let hubDefaultBranch = null
// Settings reported by the running app (GET /api/safe-settings/app/env).
let appSettings = {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passCount = 0
let failCount = 0
const failures = []

function log (msg) { console.log(`\x1b[36m[hub-smoke]\x1b[0m ${msg}`) }
function logPass (msg) { passCount++; console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`) }
function logFail (msg) { failCount++; failures.push(msg); console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`) }
function logWarn (msg) { console.log(`\x1b[33m  ⚠ ${msg}\x1b[0m`) }
function logPhase (msg) { console.log(`\n\x1b[35m═══ ${msg} ═══\x1b[0m`) }

function assert (condition, msg) {
  if (condition) logPass(msg)
  else logFail(msg)
  return condition
}

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function poll (fn, { timeout = MAX_POLL_MS, interval = POLL_INTERVAL_MS, desc = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await fn()
    if (result) return result
    await sleep(interval)
  }
  logWarn(`Timed out waiting for ${desc}`)
  return null
}

// ─── Interactive mode ────────────────────────────────────────────────────────

let skipNext = false

async function pause (phaseName) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(
      `\n\x1b[33m[interactive] "${phaseName}" complete.\x1b[0m\n` +
      '  \x1b[90mPress Enter to continue, \'s\' skip next, \'q\' quit+teardown, \'a\' abort (no teardown): \x1b[0m'
    )
    rl.once('line', (answer) => {
      const input = answer.trim().toLowerCase()
      if (input === 's') resolve('skip')
      else if (input === 'q') resolve('quit')
      else if (input === 'a') resolve('abort')
      else resolve('continue')
      rl.close()
    })
    rl.once('close', () => resolve('continue'))
  })
}

async function runPhase (label, fn) {
  if (skipNext) {
    log(`\x1b[33m[interactive] Skipping ${label}\x1b[0m`)
    skipNext = false
    return 'skipped'
  }
  await fn()
  if (!INTERACTIVE) return 'continue'
  const action = await pause(label)
  if (action === 'skip') skipNext = true
  return action
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function getRepo (octokit, owner, repo) {
  try {
    return (await octokit.rest.repos.get({ owner, repo })).data
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

const isSmokeRepo = repo => Boolean(repo && (repo.description || '').includes(SMOKE_MARKER))

async function getFileText (octokit, owner, repo, filePath, ref) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref })
    if (Array.isArray(data)) return null
    return Buffer.from(data.content, data.encoding || 'base64').toString('utf8')
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

async function createOrUpdateFile (octokit, owner, repo, filePath, content, branch, message) {
  let sha
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    sha = data.sha
  } catch { /* file doesn't exist */ }
  const params = { owner, repo, path: filePath, message, content: Buffer.from(content).toString('base64'), branch }
  if (sha) params.sha = sha
  return (await octokit.rest.repos.createOrUpdateFileContents(params)).data
}

async function deleteFileIfExists (octokit, owner, repo, filePath, branch, message) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    await octokit.rest.repos.deleteFile({ owner, repo, path: filePath, message, sha: data.sha, branch })
  } catch (e) {
    if (e.status !== 404) throw e
  }
}

// ─── Hub change registry (reverted during teardown) ──────────────────────────

function loadState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { hubFiles: [], hubBranches: [], hubPullRequests: [] }
  }
}

const state = loadState()

function saveState () {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

/**
 * Snapshot a Hub file's current content on the default branch before a test
 * changes it (directly or via a merged PR). Teardown restores the snapshot,
 * or deletes the file if it did not exist. Only the first snapshot is kept.
 */
async function trackHubFile (filePath) {
  if (state.hubFiles.some(f => f.path === filePath)) return
  const original = await getFileText(hubOctokit, HUB_SMOKE_HUB_ORG, HUB_SMOKE_HUB_REPO, filePath, hubDefaultBranch)
  state.hubFiles.push({ path: filePath, original })
  saveState()
}

function trackHubBranch (branch) {
  if (!state.hubBranches.includes(branch)) state.hubBranches.push(branch)
  saveState()
}

function trackHubPullRequest (number) {
  if (!state.hubPullRequests.includes(number)) state.hubPullRequests.push(number)
  saveState()
}

// ─── Running app checks ──────────────────────────────────────────────────────

/**
 * Verify the running app is reachable and uses the same Hub-Sync settings as
 * this test (both read the same `.env`, but the app may have been started
 * with a different environment).
 */
async function verifyRunningApp () {
  const url = `${HUB_SMOKE_APP_URL}/api/safe-settings/app/env`
  let body
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.json()
  } catch (e) {
    throw new Error(`safe-settings app is not reachable at ${url} (${e.message}). ` +
      'Start it with `npm start`, or set HUB_SMOKE_APP_URL.')
  }
  const appValues = Object.fromEntries((body.variables || []).map(v => [v.key, String(v.value ?? '').trim()]))
  const expected = {
    SAFE_SETTINGS_HUB_ORG: HUB_SMOKE_HUB_ORG,
    SAFE_SETTINGS_HUB_REPO: HUB_SMOKE_HUB_REPO,
    SAFE_SETTINGS_HUB_PATH: HUB_SMOKE_HUB_PATH,
    CONFIG_PATH: HUB_SMOKE_CONFIG_PATH,
    ADMIN_REPO: HUB_SMOKE_TARGET_REPO
  }
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => appValues[key] !== value)
    .map(([key, value]) => `${key} (app: '${appValues[key]}', test: '${value}')`)
  if (mismatches.length > 0) {
    throw new Error(`The running app uses different Hub-Sync settings: ${mismatches.join(', ')}. Restart the app after updating .env.`)
  }
  if (appValues.CRON) {
    logWarn('The running app has CRON set; scheduled syncs may run during the test')
  }
  if (/^(true|1)$/i.test(appValues.SAFE_SETTINGS_HUB_DIRECT_PUSH || '')) {
    throw new Error('The running app has SAFE_SETTINGS_HUB_DIRECT_PUSH enabled. Hub-Sync would commit straight to the target ' +
      'repo\'s default branch, and safe-settings would then apply the merged settings to the target org. ' +
      'Restart the app with SAFE_SETTINGS_HUB_DIRECT_PUSH=false to run this smoke test.')
  }
  appSettings = appValues
  logPass(`Running app at ${HUB_SMOKE_APP_URL} uses the same Hub-Sync settings`)
}

/**
 * Verify the Hub repo exists and its manifest lets Hub-Sync reach the target org.
 */
async function verifyHubRepo () {
  const hub = await getRepo(hubOctokit, HUB_SMOKE_HUB_ORG, HUB_SMOKE_HUB_REPO)
  if (!hub) throw new Error(`Hub repo ${HUB_SMOKE_HUB_ORG}/${HUB_SMOKE_HUB_REPO} not found (or the app cannot access it)`)
  hubDefaultBranch = hub.default_branch
  logPass(`Hub repo ${HUB_SMOKE_HUB_ORG}/${HUB_SMOKE_HUB_REPO} found (default branch: ${hubDefaultBranch})`)

  const manifestPath = `${HUB_SMOKE_HUB_ROOT}/globals/manifest.yml`
  const manifestText = await getFileText(hubOctokit, HUB_SMOKE_HUB_ORG, HUB_SMOKE_HUB_REPO, manifestPath, hubDefaultBranch)
  if (manifestText === null) {
    logWarn(`No ${manifestPath} in the Hub repo — Hub-Sync will sync to all orgs`)
    return
  }
  const manifest = yaml.load(manifestText)
  if (!manifest || !Array.isArray(manifest.rules)) {
    throw new Error(`${manifestPath} has no valid 'rules' list`)
  }
  const quietLogger = { debug () {}, info () {} }
  if (!matchesOrgTargets(HUB_SMOKE_TARGET_ORG, normalizeManifestRules(manifest), quietLogger)) {
    throw new Error(`No enabled rule in ${manifestPath} targets '${HUB_SMOKE_TARGET_ORG}', so Hub-Sync would skip it`)
  }
  logPass(`Hub manifest targets ${HUB_SMOKE_TARGET_ORG}`)

  // The test adds organizations/<target>/ and removes it in teardown, so it must not hold real data.
  const orgFolder = `${HUB_SMOKE_HUB_ROOT}/organizations/${HUB_SMOKE_TARGET_ORG}`
  try {
    await hubOctokit.rest.repos.getContent({ owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, path: orgFolder, ref: hubDefaultBranch })
    throw new Error(`The Hub repo already has ${orgFolder}. The smoke test creates and removes this folder, ` +
      'so use a target org that has no organization folder in the Hub.')
  } catch (e) {
    if (e.status !== 404) throw e
  }
  logPass(`Hub has no ${orgFolder} folder yet`)
}

// ─── Target repo ─────────────────────────────────────────────────────────────

const EMPTY_SETTINGS_YML = `# empty ${SMOKE_MARKER}\n`

async function createTargetRepo () {
  const existing = await getRepo(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO)
  if (existing) {
    if (!isSmokeRepo(existing)) {
      throw new Error(`${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} already exists and was not created by this smoke test. ` +
        'Use a sandbox org without an ADMIN_REPO for HUB_SMOKE_TARGET_ORG.')
    }
    log('  Removing leftover target repo from a previous run...')
    await targetOctokit.rest.repos.delete({ owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO })
    await poll(async () => (await getRepo(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO)) === null,
      { desc: 'leftover target repo to be deleted', timeout: 30000, interval: 2000 })
  }

  const { data } = await targetOctokit.rest.repos.createInOrg({
    org: HUB_SMOKE_TARGET_ORG,
    name: HUB_SMOKE_TARGET_REPO,
    private: true,
    auto_init: true,
    description: `Hub-Sync smoke test target (spoke) config repo. ${SMOKE_MARKER}`
  })
  // auto_init commits asynchronously; wait until the default branch exists.
  await poll(async () => {
    try {
      await targetOctokit.rest.repos.getBranch({ owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO, branch: data.default_branch })
      return true
    } catch { return null }
  }, { desc: 'target repo default branch', timeout: 30000, interval: 2000 })

  await createOrUpdateFile(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO,
    `${HUB_SMOKE_CONFIG_PATH}/settings.yml`, EMPTY_SETTINGS_YML, data.default_branch, 'Seed empty settings.yml for smoke test')
  assert(isSmokeRepo(await getRepo(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO)),
    `Target repo ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} created`)
}

async function deleteTargetRepo () {
  const repo = await getRepo(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO)
  if (!repo) {
    log(`  ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} does not exist, nothing to delete`)
    return
  }
  if (!isSmokeRepo(repo)) {
    logWarn(`${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} is not marked as a smoke-test repo — NOT deleting it`)
    return
  }
  await targetOctokit.rest.repos.delete({ owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO })
  log(`  Deleted ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO}`)
}

// ─── Hub-Sync test helpers ───────────────────────────────────────────────────

const hubPaths = {
  orgDir: () => `${HUB_SMOKE_HUB_ROOT}/organizations/${HUB_SMOKE_TARGET_ORG}`,
  orgSettings: () => `${hubPaths.orgDir()}/settings.yml`,
  orgRepoFile: () => `${hubPaths.orgDir()}/repos/smoke-repo.yml`,
  strayFile: () => `${HUB_SMOKE_HUB_ROOT}/organizations/smoke-stray-${RUN_ID}.yml`,
  globalsSettings: () => `${HUB_SMOKE_HUB_ROOT}/globals/settings.yml`
}
const targetSettingsPath = () => `${HUB_SMOKE_CONFIG_PATH}/settings.yml`
const targetRepoFilePath = () => `${HUB_SMOKE_CONFIG_PATH}/repos/smoke-repo.yml`

const isDeepEqual = (a, b) => require('util').isDeepStrictEqual(a, b)
// labels may be a plain list or { include: [...], exclude: [...] }
const labelList = labels => Array.isArray(labels) ? labels : (Array.isArray(labels?.include) ? labels.include : [])

/**
 * Create a Hub branch from `base` and commit the given files to it
 * ({ path: content }). The branch is registered for teardown.
 */
async function commitHubBranch (branch, files, base = hubDefaultBranch) {
  const owner = HUB_SMOKE_HUB_ORG
  const repo = HUB_SMOKE_HUB_REPO
  const { data: ref } = await hubOctokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  trackHubBranch(branch)
  await hubOctokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.object.sha })
  for (const [filePath, content] of Object.entries(files)) {
    await createOrUpdateFile(hubOctokit, owner, repo, filePath, content, branch, `Smoke test (${RUN_ID}): update ${path.basename(filePath)}`)
  }
}

async function openHubPr (branch, title, base = hubDefaultBranch) {
  const { data: pr } = await hubOctokit.rest.pulls.create({
    owner: HUB_SMOKE_HUB_ORG,
    repo: HUB_SMOKE_HUB_REPO,
    head: branch,
    base,
    title: `${title} ${SMOKE_MARKER}`,
    body: `Created by the Hub-Sync smoke test (run ${RUN_ID}). Teardown closes or reverts it.`
  })
  trackHubPullRequest(pr.number)
  log(`  Opened Hub PR #${pr.number} (${branch} → ${base})`)
  return pr
}

// Wait until every safe-settings check run on the commit has completed; returns the latest one.
async function waitForHubCheck (sha) {
  return poll(async () => {
    const { data } = await hubOctokit.rest.checks.listForRef({
      owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, ref: sha, check_name: CHECK_NAME
    })
    const runs = data.check_runs || []
    if (runs.length === 0 || runs.some(r => r.status !== 'completed')) return null
    return runs.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0]
  }, { desc: `'${CHECK_NAME}' check on ${sha.slice(0, 7)}` })
}

async function mergeHubPr (number) {
  const merged = await poll(async () => {
    try {
      await hubOctokit.rest.pulls.merge({ owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, pull_number: number, merge_method: 'squash' })
      return true
    } catch (e) {
      // 405: not mergeable yet (mergeability still being computed)
      if (e.status === 405) return null
      throw e
    }
  }, { desc: `Hub PR #${number} to be mergeable`, timeout: 60000, interval: 3000 })
  if (!merged) throw new Error(`Could not merge Hub PR #${number}`)
  log(`  Merged Hub PR #${number} (squash)`)
}

const syncBranchPrefix = hubPrNumber => `safe-settings-sync/pr-${hubPrNumber}-`

async function listSyncPrs (hubPrNumber) {
  const prs = await targetOctokit.paginate(targetOctokit.rest.pulls.list, {
    owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO, state: 'all', per_page: 100
  })
  return prs.filter(pr => pr.head.ref.startsWith(syncBranchPrefix(hubPrNumber)))
}

async function waitForSyncPr (hubPrNumber) {
  const prs = await poll(async () => {
    const found = await listSyncPrs(hubPrNumber)
    return found.length > 0 ? found : null
  }, { desc: `sync PR for Hub PR #${hubPrNumber} in ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO}` })
  return prs || []
}

// Negative check: wait QUIET_WAIT_MS, then confirm no sync branch exists for the Hub PR.
async function expectNoSync (hubPrNumber, caseLabel) {
  log(`  Waiting ${QUIET_WAIT_MS / 1000}s to confirm nothing is synced...`)
  await sleep(QUIET_WAIT_MS)
  const { data: refs } = await targetOctokit.rest.git.listMatchingRefs({
    owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO, ref: `heads/${syncBranchPrefix(hubPrNumber)}`
  })
  assert(refs.length === 0, `${caseLabel}: no sync branch created for Hub PR #${hubPrNumber}` +
    (refs.length ? ` (found: ${refs.map(r => r.ref).join(', ')})` : ''))
}

async function callImport () {
  const url = `${HUB_SMOKE_APP_URL}/api/safe-settings/hub/import`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgs: [HUB_SMOKE_TARGET_ORG] }),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) throw new Error(`POST ${url} returned HTTP ${res.status}`)
  const body = await res.json()
  if (!body.ok) throw new Error(`Import failed: ${body.error}`)
  return (body.results || []).find(r => r.org === HUB_SMOKE_TARGET_ORG) || {}
}

async function readTargetSettings (ref) {
  const text = await getFileText(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO, targetSettingsPath(), ref)
  return { text: text || '', parsed: text ? (yaml.load(text) || {}) : {} }
}

async function loadGlobals () {
  const text = await getFileText(hubOctokit, HUB_SMOKE_HUB_ORG, HUB_SMOKE_HUB_REPO, hubPaths.globalsSettings(), hubDefaultBranch)
  return text ? (yaml.load(text) || {}) : {}
}

/**
 * Build the org settings.yml used by phase 3 from what globals actually
 * defines. Cases whose prerequisites are missing in globals are skipped.
 */
function buildOrgSettings (globals) {
  const org = {}
  const cases = {}
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v)

  // C1: override one key, keep the rest
  if (isObject(globals.repository)) {
    org.repository = { description: `Hub-Sync smoke test ${RUN_ID}` }
    cases.c1 = true
  }

  // C6 / C7 / C8: labels matched by name (plain list or { include: [...] })
  const labelsNested = isObject(globals.labels)
  const globalLabels = labelList(globals.labels).filter(l => l && l.name)
  const orgLabels = []
  if (globalLabels[0]) {
    const color = String(globalLabels[0].color || '').replace('#', '').toLowerCase() === 'b60205' ? '0e8a16' : 'b60205'
    orgLabels.push({ ...globalLabels[0], color })
    cases.c6 = { name: globalLabels[0].name, color }
  }
  if (globalLabels[1]) {
    orgLabels.push({ ...globalLabels[1] })
    cases.c7 = { name: globalLabels[1].name }
  }
  const smokeLabel = { name: `smoke-${RUN_ID}`, color: 'ededed', description: 'Hub-Sync smoke test' }
  orgLabels.push(smokeLabel)
  cases.c8 = smokeLabel
  org.labels = labelsNested ? { include: orgLabels } : orgLabels

  // C5: nested null is preserved
  const smokeBranch = `smoke-${RUN_ID}`
  org.branches = [{ name: smokeBranch, protection: null }]
  cases.c5 = { name: smokeBranch }

  // C4: an empty list does not opt out
  const used = new Set(['repository', 'labels', 'branches'])
  const listSection = ['milestones', ...Object.keys(globals)]
    .find(k => !used.has(k) && Array.isArray(globals[k]) && globals[k].length > 0)
  if (listSection) {
    org[listSection] = []
    used.add(listSection)
    cases.c4 = { section: listSection }
  }

  // C3: null opts a whole section out
  const nullSection = ['autolinks', ...Object.keys(globals)]
    .find(k => !used.has(k) && globals[k] !== undefined && globals[k] !== null)
  if (nullSection) {
    org[nullSection] = null
    cases.c3 = { section: nullSection }
  }

  return { org, cases }
}

// ─── Phases ──────────────────────────────────────────────────────────────────

async function setup () {
  logPhase('Phase 0: Setup')

  log('Checking the running safe-settings app...')
  await verifyRunningApp()

  log('Checking the Hub repo...')
  await verifyHubRepo()

  log(`Creating target repo ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO}...`)
  await createTargetRepo()

  log('Setup complete')
}

// H1: import the target org's config into the Hub (PR is closed, never merged).
async function phaseImport () {
  logPhase('Phase 1: Import (H1)')
  const result = await callImport()
  if (!assert(result.status === 'imported' && result.pr, `H1: import returned 'imported' with a Hub PR (got: ${JSON.stringify(result)})`)) return

  const number = parseInt(String(result.pr).split('/').pop(), 10)
  trackHubPullRequest(number)
  const { data: pr } = await hubOctokit.rest.pulls.get({ owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, pull_number: number })
  trackHubBranch(pr.head.ref)

  const files = await hubOctokit.paginate(hubOctokit.rest.pulls.listFiles, {
    owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, pull_number: number, per_page: 100
  })
  assert(files.some(f => f.filename === hubPaths.orgSettings()),
    `H1: import PR #${number} adds ${hubPaths.orgSettings()}`)
  assert(pr.base.ref === hubDefaultBranch, `H1: import PR targets the Hub default branch (${pr.base.ref})`)

  await hubOctokit.rest.pulls.update({ owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, pull_number: number, state: 'closed' })
  log(`  Closed import PR #${number} without merging`)
}

// F2 + E2: invalid YAML fails the check; closing the PR without merging syncs nothing.
async function phaseInvalidYaml () {
  logPhase('Phase 2: Invalid YAML check + closed PR (F2, E2)')
  const branch = `smoke-hub/${RUN_ID}-invalid`
  await commitHubBranch(branch, { [hubPaths.orgSettings()]: 'repository:\n  description: [unclosed\n' })
  const pr = await openHubPr(branch, 'Smoke test: invalid YAML')

  const check = await waitForHubCheck(pr.head.sha)
  if (assert(check, `F2: '${CHECK_NAME}' check completed on Hub PR #${pr.number}`)) {
    assert(check.conclusion === 'failure', `F2: check concluded 'failure' (got: ${check.conclusion})`)
    assert((check.output?.summary || '').includes('YAML Syntax Validation Failed'), 'F2: check summary reports the YAML syntax error')
  }

  await hubOctokit.rest.pulls.update({ owner: HUB_SMOKE_HUB_ORG, repo: HUB_SMOKE_HUB_REPO, pull_number: pr.number, state: 'closed' })
  log(`  Closed Hub PR #${pr.number} without merging`)
  await expectNoSync(pr.number, 'E2')
}

// A1/A2/A4/A5, C1/C3–C8, F1/F3: merge an org change and inspect the sync PR.
async function phaseOrgSync () {
  logPhase('Phase 3: Organization sync + merge behavior (A, C, F1, F3)')
  const globals = await loadGlobals()
  if (Object.keys(globals).length === 0) logWarn('globals/settings.yml is missing or empty; merge cases (C) are limited')
  const { org, cases } = buildOrgSettings(globals)
  const repoFileContent = `# ${SMOKE_MARKER}\nrepository:\n  description: smoke repo ${RUN_ID}\n`

  for (const p of [hubPaths.orgSettings(), hubPaths.orgRepoFile(), hubPaths.strayFile()]) await trackHubFile(p)

  const branch = `smoke-hub/${RUN_ID}-org-sync`
  await commitHubBranch(branch, {
    [hubPaths.orgSettings()]: `# ${SMOKE_MARKER}\n${yaml.dump(org, { lineWidth: -1 })}`,
    [hubPaths.orgRepoFile()]: repoFileContent,
    [hubPaths.strayFile()]: `# ${SMOKE_MARKER} file directly under organizations/\nfoo: bar\n`
  })
  const pr = await openHubPr(branch, 'Smoke test: organization sync')

  const check = await waitForHubCheck(pr.head.sha)
  if (assert(check, `F1: '${CHECK_NAME}' check completed on Hub PR #${pr.number}`)) {
    const summary = check.output?.summary || ''
    assert(check.conclusion === 'success', `F1: check concluded 'success' (got: ${check.conclusion})`)
    assert(new RegExp(`will receive updates:\\*\\* .*\\b${HUB_SMOKE_TARGET_ORG}\\b`).test(summary), `F1: check lists ${HUB_SMOKE_TARGET_ORG} as receiving updates`)
    if (cases.c3) {
      assert(summary.includes('Inheritance Overrides') && summary.includes(`\`${cases.c3.section}\``),
        `F3/C3: check lists '${cases.c3.section}: null' under Inheritance Overrides`)
    }
  }

  await mergeHubPr(pr.number)
  const syncPrs = await waitForSyncPr(pr.number)
  if (!assert(syncPrs.length === 1, `A1/A5: exactly one sync PR opened in ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} (found ${syncPrs.length})`)) return
  const syncPr = syncPrs[0]
  log(`  Sync PR: ${syncPr.html_url}`)

  const syncFiles = (await targetOctokit.paginate(targetOctokit.rest.pulls.listFiles, {
    owner: HUB_SMOKE_TARGET_ORG, repo: HUB_SMOKE_TARGET_REPO, pull_number: syncPr.number, per_page: 100
  })).map(f => f.filename)
  assert(syncFiles.includes(targetSettingsPath()), `A1: sync PR updates ${targetSettingsPath()}`)
  assert(syncFiles.includes(targetRepoFilePath()), `A5: the same sync PR adds ${targetRepoFilePath()}`)
  assert(!syncFiles.some(f => f.includes('smoke-stray')), 'A4: file directly under organizations/ is not synced')

  const syncedRepoFile = await getFileText(targetOctokit, HUB_SMOKE_TARGET_ORG, HUB_SMOKE_TARGET_REPO, targetRepoFilePath(), syncPr.head.ref)
  assert(syncedRepoFile === repoFileContent, 'A2: repos/smoke-repo.yml is copied unchanged')

  const { text, parsed: s } = await readTargetSettings(syncPr.head.ref)
  assert(text.startsWith('# Auto-generated by Safe-Settings Hub-Sync'), 'A1: synced settings.yml is generated (merge header)')

  if (cases.c1) {
    const others = Object.keys(globals.repository).filter(k => k !== 'description')
    assert(s.repository?.description === org.repository.description, 'C1: org repository.description overrides globals')
    assert(others.every(k => isDeepEqual(s.repository?.[k], globals.repository[k])), `C1: other globals repository keys are kept (${others.length})`)
  } else logWarn('C1 skipped: globals has no repository section')

  if (cases.c3) {
    assert(!(cases.c3.section in s), `C3: '${cases.c3.section}' (null in org file) is not in the synced settings`)
    assert(text.includes(`# Not inherited from globals (set to null in org file): ${cases.c3.section}`), 'C3: header lists the opted-out section')
  } else logWarn('C3 skipped: globals has no section left to opt out of')

  if (cases.c4) {
    assert(isDeepEqual(s[cases.c4.section], globals[cases.c4.section]), `C4: '${cases.c4.section}: []' keeps the globals entries`)
  } else logWarn('C4 skipped: globals has no non-empty list section')

  const branchEntry = (s.branches || []).find(b => b && b.name === cases.c5.name)
  assert(branchEntry && 'protection' in branchEntry && branchEntry.protection === null, 'C5: nested protection: null is preserved')

  const labels = labelList(s.labels)
  if (cases.c6) {
    const matches = labels.filter(l => l && l.name === cases.c6.name)
    assert(matches.length === 1 && String(matches[0].color).replace('#', '') === cases.c6.color,
      `C6: label '${cases.c6.name}' merged into one entry with the org color (found ${matches.length})`)
  } else logWarn('C6 skipped: globals has no labels')
  if (cases.c7) {
    assert(labels.filter(l => l && l.name === cases.c7.name).length === 1, `C7: repeated globals label '${cases.c7.name}' is not duplicated`)
  } else logWarn('C7 skipped: globals has fewer than two labels')
  assert(labels.some(l => l && l.name === cases.c8.name), `C8: new label '${cases.c8.name}' is added`)
}

// C2 + F3: removing a section that globals defines keeps it inherited, with a warning.
async function phaseRemovedSection () {
  logPhase('Phase 4: Removed section is still inherited (C2, F3)')
  const globals = await loadGlobals()
  const current = yaml.load(await getFileText(hubOctokit, HUB_SMOKE_HUB_ORG, HUB_SMOKE_HUB_REPO, hubPaths.orgSettings(), hubDefaultBranch) || '') || {}
  if (!current.repository || !globals.repository) {
    logWarn('C2 skipped: needs a repository section in both globals and the org file from phase 3')
    return
  }
  const rest = { ...current }
  delete rest.repository
  const branch = `smoke-hub/${RUN_ID}-remove-section`
  await commitHubBranch(branch, { [hubPaths.orgSettings()]: `# ${SMOKE_MARKER}\n${yaml.dump(rest, { lineWidth: -1 })}` })
  const pr = await openHubPr(branch, 'Smoke test: remove inherited section')

  const check = await waitForHubCheck(pr.head.sha)
  if (assert(check, `F3: '${CHECK_NAME}' check completed on Hub PR #${pr.number}`)) {
    assert(check.conclusion === 'success', `F3: check still concludes 'success' with warnings (got: ${check.conclusion})`)
    assert((check.output?.summary || '').includes('`repository` was removed from'), 'C2: check warns that repository is still inherited')
  }

  await mergeHubPr(pr.number)
  const syncPrs = await waitForSyncPr(pr.number)
  if (!assert(syncPrs.length === 1, `C2: sync PR opened for Hub PR #${pr.number} (found ${syncPrs.length})`)) return
  const { parsed: s } = await readTargetSettings(syncPrs[0].head.ref)
  assert(isDeepEqual(s.repository, globals.repository), 'C2: synced settings still contain the globals repository section')
}

// E3: merging into a non-default Hub branch syncs nothing.
async function phaseNonDefaultBase () {
  logPhase('Phase 5: Merge into a non-default branch (E3)')
  const base = `smoke-hub/${RUN_ID}-base`
  await commitHubBranch(base, {})
  const branch = `smoke-hub/${RUN_ID}-non-default`
  await commitHubBranch(branch, { [hubPaths.orgSettings()]: `# ${SMOKE_MARKER}\nlabels:\n  - name: smoke-e3-${RUN_ID}\n    color: ededed\n` }, base)
  const pr = await openHubPr(branch, 'Smoke test: merge into non-default branch', base)
  await mergeHubPr(pr.number)
  await expectNoSync(pr.number, 'E3')
}

// H2: importing an org that is already in the Hub is skipped.
async function phaseReimport () {
  logPhase('Phase 6: Import again (H2)')
  if (/^true$/i.test(appSettings.SAFE_SETTINGS_HUB_REIMPORT || '')) {
    logWarn('H2 skipped: the running app has SAFE_SETTINGS_HUB_REIMPORT=true')
    return
  }
  const result = await callImport()
  if (result.pr) {
    const number = parseInt(String(result.pr).split('/').pop(), 10)
    trackHubPullRequest(number)
  }
  assert(result.status === 'skipped' && result.reason === 'already_imported',
    `H2: import is skipped as already_imported (got: ${JSON.stringify(result)})`)
}

async function teardown () {
  logPhase('Teardown')
  const owner = HUB_SMOKE_HUB_ORG
  const repo = HUB_SMOKE_HUB_REPO

  const hasHubChanges = state.hubPullRequests.length + state.hubBranches.length + state.hubFiles.length > 0
  if (hasHubChanges && !hubDefaultBranch) {
    hubDefaultBranch = (await getRepo(hubOctokit, owner, repo))?.default_branch
  }

  for (const number of [...state.hubPullRequests]) {
    try {
      const { data: pr } = await hubOctokit.rest.pulls.get({ owner, repo, pull_number: number })
      if (pr.state === 'open') {
        await hubOctokit.rest.pulls.update({ owner, repo, pull_number: number, state: 'closed' })
        log(`  Closed Hub PR #${number}`)
      }
      state.hubPullRequests = state.hubPullRequests.filter(n => n !== number)
      saveState()
    } catch (e) {
      logFail(`Could not close Hub PR #${number}: ${e.message}`)
    }
  }

  for (const branch of [...state.hubBranches]) {
    try {
      await hubOctokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` })
      log(`  Deleted Hub branch ${branch}`)
    } catch (e) {
      if (e.status !== 422 && e.status !== 404) {
        logFail(`Could not delete Hub branch ${branch}: ${e.message}`)
        continue
      }
    }
    state.hubBranches = state.hubBranches.filter(b => b !== branch)
    saveState()
  }

  // Restore in reverse order. Direct commits do not trigger Hub-Sync (only merged PRs do).
  for (const file of [...state.hubFiles].reverse()) {
    try {
      const current = await getFileText(hubOctokit, owner, repo, file.path, hubDefaultBranch)
      if (current !== file.original) {
        if (file.original === null) {
          await deleteFileIfExists(hubOctokit, owner, repo, file.path, hubDefaultBranch, `Smoke test teardown: remove ${file.path}`)
          log(`  Removed Hub file ${file.path}`)
        } else {
          await createOrUpdateFile(hubOctokit, owner, repo, file.path, file.original, hubDefaultBranch, `Smoke test teardown: restore ${file.path}`)
          log(`  Restored Hub file ${file.path}`)
        }
      }
      state.hubFiles = state.hubFiles.filter(f => f.path !== file.path)
      saveState()
    } catch (e) {
      logFail(`Could not restore Hub file ${file.path}: ${e.message}`)
    }
  }

  log('Deleting target repo...')
  try {
    await deleteTargetRepo()
  } catch (e) {
    logFail(`Could not delete ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO}: ${e.message}`)
  }

  const leftovers = state.hubPullRequests.length + state.hubBranches.length + state.hubFiles.length
  if (leftovers === 0) {
    fs.rmSync(STATE_FILE, { force: true })
  } else {
    logWarn(`${leftovers} Hub change(s) could not be reverted; see ${path.basename(STATE_FILE)} and re-run with --teardown-only`)
  }
  log('Teardown complete')
}

// ─── Main ────────────────────────────────────────────────────────────────────

function validateConfig () {
  const missing = []
  if (!HUB_SMOKE_HUB_ORG) missing.push('SAFE_SETTINGS_HUB_ORG')
  if (!HUB_SMOKE_HUB_REPO) missing.push('SAFE_SETTINGS_HUB_REPO')
  if (!HUB_SMOKE_TARGET_ORG) missing.push('HUB_SMOKE_TARGET_ORG')
  if (!HUB_SMOKE_APP_ID) missing.push('APP_ID')
  if (!HUB_SMOKE_PRIVATE_KEY) missing.push('PRIVATE_KEY (or PRIVATE_KEY_PATH)')
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}. ` +
      'The smoke test uses the running app\'s Hub-Sync settings from .env plus HUB_SMOKE_TARGET_ORG.')
  }
  if (HUB_SMOKE_HUB_ORG.toLowerCase() === HUB_SMOKE_TARGET_ORG.toLowerCase() &&
      HUB_SMOKE_HUB_REPO.toLowerCase() === HUB_SMOKE_TARGET_REPO.toLowerCase()) {
    throw new Error('SAFE_SETTINGS_HUB_REPO and ADMIN_REPO must differ when the Hub org is the target org')
  }
}

// Installation permissions each org needs for Hub-Sync and for this test.
const REQUIRED_PERMISSIONS = {
  hub: { contents: 'write', pull_requests: 'write', checks: 'write' },
  target: { administration: 'write', contents: 'write', pull_requests: 'write' }
}
// Webhook events the hub installation must deliver for Hub-Sync to run.
const REQUIRED_HUB_EVENTS = ['pull_request']

const PERMISSION_RANK = { read: 1, write: 2, admin: 3 }

async function listAppInstallations (app) {
  const byOrg = new Map()
  for await (const { installation } of app.eachInstallation.iterator()) {
    const login = installation.account?.login
    if (login) byOrg.set(login.toLowerCase(), installation)
  }
  return byOrg
}

/**
 * Check that the app is installed (and usable) on an org. Logs a pass/fail per
 * check and returns the installation, or null when the org cannot be used.
 */
function checkInstallation (installations, org, role) {
  const label = role === 'hub' ? `Hub org '${org}'` : `Target org '${org}'`
  const installation = installations.get(org.toLowerCase())
  if (!installation) {
    const installedOn = [...installations.values()].map(i => i.account.login).sort().join(', ')
    logFail(`${label}: the GitHub App (APP_ID ${HUB_SMOKE_APP_ID}) is not installed there, so Hub-Sync has no access to it. ` +
      `Install the app on '${org}' or choose another org. Installed on: ${installedOn || 'none'}`)
    return null
  }
  if (installation.suspended_at) {
    logFail(`${label}: the app installation is suspended (since ${installation.suspended_at})`)
    return null
  }

  const granted = installation.permissions || {}
  const missing = Object.entries(REQUIRED_PERMISSIONS[role])
    .filter(([name, level]) => (PERMISSION_RANK[granted[name]] || 0) < PERMISSION_RANK[level])
    .map(([name, level]) => `${name}:${level} (has: ${granted[name] || 'none'})`)
  if (missing.length > 0) {
    logFail(`${label}: the app installation is missing permissions: ${missing.join(', ')}. ` +
      'Update the app permissions and accept them for this org.')
    return null
  }

  if (role === 'hub') {
    const events = installation.events || []
    const missingEvents = REQUIRED_HUB_EVENTS.filter(e => !events.includes(e))
    if (missingEvents.length > 0) {
      logFail(`${label}: the app installation is not subscribed to: ${missingEvents.join(', ')}`)
      return null
    }
  }

  logPass(`${label}: app installed (installation ${installation.id}, ${installation.repository_selection} repositories)`)
  if (role === 'target' && installation.repository_selection === 'selected') {
    logWarn(`${label}: the app only has access to selected repositories; make sure '${HUB_SMOKE_TARGET_REPO}' is accessible once created`)
  }
  return installation
}

async function main () {
  validateConfig()

  const { App } = await import('octokit')
  const app = new App({ appId: HUB_SMOKE_APP_ID, privateKey: HUB_SMOKE_PRIVATE_KEY })

  log('Checking GitHub App installations...')
  const installations = await listAppInstallations(app)
  const hubInstallation = checkInstallation(installations, HUB_SMOKE_HUB_ORG, 'hub')
  const sameOrg = HUB_SMOKE_HUB_ORG.toLowerCase() === HUB_SMOKE_TARGET_ORG.toLowerCase()
  const targetInstallation = sameOrg ? hubInstallation : checkInstallation(installations, HUB_SMOKE_TARGET_ORG, 'target')
  if (sameOrg && hubInstallation) {
    // Hub and target share one installation, so it also needs the target permissions.
    const asTarget = checkInstallation(installations, HUB_SMOKE_TARGET_ORG, 'target')
    if (!asTarget) return finish()
  }
  if (!hubInstallation || !targetInstallation) {
    log('Pre-flight check failed — nothing was created.')
    return finish()
  }

  hubOctokit = await app.getInstallationOctokit(hubInstallation.id)
  targetOctokit = sameOrg ? hubOctokit : await app.getInstallationOctokit(targetInstallation.id)
  log('Authenticated as GitHub App installation(s)')

  console.log(`
\x1b[36m╔══════════════════════════════════════════════════╗
║   Safe-Settings Hub-Sync Smoke Test              ║
╚══════════════════════════════════════════════════╝\x1b[0m
  App:    ${HUB_SMOKE_APP_URL}
  Hub:    ${HUB_SMOKE_HUB_ORG}/${HUB_SMOKE_HUB_REPO} (${HUB_SMOKE_HUB_ROOT})
  Target: ${HUB_SMOKE_TARGET_ORG}/${HUB_SMOKE_TARGET_REPO} (${HUB_SMOKE_CONFIG_PATH})
`)

  if (TEARDOWN_ONLY) {
    await teardown()
    return finish()
  }

  if (INTERACTIVE) log('\x1b[33m[interactive] Mode enabled — will pause after each phase.\x1b[0m')

  const allPhases = [
    ['Phase 0: Setup', setup],
    ['Phase 1: Import (H1)', phaseImport],
    ['Phase 2: Invalid YAML check + closed PR (F2, E2)', phaseInvalidYaml],
    ['Phase 3: Organization sync + merge behavior (A, C, F1, F3)', phaseOrgSync],
    ['Phase 4: Removed section is still inherited (C2, F3)', phaseRemovedSection],
    ['Phase 5: Merge into a non-default branch (E3)', phaseNonDefaultBase],
    ['Phase 6: Import again (H2)', phaseReimport]
  ]
  const phases = ONLY_PHASES === null
    ? allPhases
    : allPhases.filter(([label]) => {
      const m = label.match(/^Phase (\d+)[:\s]/)
      return m !== null && (m[1] === '0' || ONLY_PHASES.has(parseInt(m[1], 10)))
    })
  if (ONLY_PHASES !== null) log(`\x1b[33m[phase filter] Running setup + phase(s) [${[...ONLY_PHASES].join(', ')}] + teardown.\x1b[0m`)

  let doTeardown = true
  try {
    for (const [label, fn] of phases) {
      const action = await runPhase(label, fn)
      if (action === 'abort') { doTeardown = false; break }
      if (action === 'quit') break
    }
  } catch (err) {
    if (err instanceof InteractiveExit) {
      if (err.action === 'abort') doTeardown = false
    } else {
      logFail(`Fatal error: ${err.message}`)
      if (process.env.SMOKE_VERBOSE) console.error(err.stack)
    }
  } finally {
    if (doTeardown) await teardown()
    else log('\x1b[33m[interactive] Aborted — teardown skipped. Clean up later with: npm run smoke-test:hub:teardown\x1b[0m')
  }

  finish()
}

function finish () {
  console.log(`
\x1b[36m╔══════════════════════════════════════╗
║   Results                            ║
╚══════════════════════════════════════╝\x1b[0m
  \x1b[32mPassed: ${passCount}\x1b[0m
  \x1b[31mFailed: ${failCount}\x1b[0m
`)
  if (failures.length > 0) {
    console.log('\x1b[31mFailures:\x1b[0m')
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
    console.log()
  }
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\x1b[31m${err.message}\x1b[0m`)
  process.exit(1)
})
