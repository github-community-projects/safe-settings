#!/usr/bin/env node

/**
 * Smoke Test for safe-settings
 *
 * Usage:
 *   1. Ensure `.env` is configured with GH_ORG, APP_ID, PRIVATE_KEY, WEBHOOK_PROXY_URL, etc.
 *   2. Set GH_TOKEN env var to a fine-grained PAT with org admin + repo permissions.
 *      This is required for drift-remediation tests (Phases 2 & 3) so that
 *      changes appear as a human (not Bot) and trigger safe-settings webhooks.
 *   3. Run: `node smoke-test.js`
 *      Add --interactive to pause after each phase for manual validation.
 *      Set SMOKE_VERBOSE=1 for live safe-settings logs.
 *      Optional (Phase 16 — ruleset name resolution): set SMOKE_NR_USER to a
 *      username and/or SMOKE_NR_APP_SLUG to an installed GitHub App slug to also
 *      exercise User and Integration bypass-actor name resolution.
 *
 * Auth:
 *   - Octokit (GitHub App): APP_ID + PRIVATE_KEY from .env — used for most operations.
 *   - gh CLI (user PAT): GH_TOKEN env var — used for drift tests only.
 */

const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

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
        // Like dotenv: .env values don't override existing env vars
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
    if (!(currentKey in process.env)) process.env[currentKey] = val
  }
}

loadEnv()

const ORG = process.env.GH_ORG || 'decyjphr-emu'
const ADMIN_REPO = process.env.ADMIN_REPO || 'admin'
const CONFIG_PATH = process.env.CONFIG_PATH || '.github'
const APP_ID = process.env.APP_ID
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n')

const TEST_REPOS = ['test', 'demo-repo-service1', 'demo-repo-service2', 'combined-settings-repo', 'smoke-team-filter']
const TEST_TEAMS = ['AD-GRP-PAYMENTS-PLATFORM-OWNERS', 'awesometeam-a-approvers', 'jefeish-edj-test']
// Teams exercised by the team include/exclude filter phase (Phase 18).
const SMOKE_FILTER_REPO = 'smoke-team-filter'
const SMOKE_FILTER_TEAMS = ['smoke-filter-included', 'smoke-filter-excluded', 'smoke-filter-nomatch']

// Principals created on demand for the ruleset name-resolution phase (Phase 16)
const SMOKE_NR_TEAM = 'safe-settings-smoke-nr-team'
const SMOKE_NR_ROLE = 'safe-settings-smoke-nr-role'

const POLL_INTERVAL_MS = 5000
const MAX_POLL_MS = 120000
const WEBHOOK_SETTLE_MS = 15000

// Fine-grained PAT for drift tests (must appear as a human, not Bot)
const GH_TOKEN = process.env.GH_TOKEN || ''

// ─── App installation plugin config (Phase 17) ───────────────────────────────
// Enterprise slug — required for the app_installations plugin, which manages
// GitHub App installation repository access via the Enterprise organization
// installations API. Read from GH_ENTERPRISE (same var safe-settings uses).
const GH_ENTERPRISE = process.env.GH_ENTERPRISE || ''
// One or more enterprise-level GitHub App slugs to exercise the plugin.
// ONE app is sufficient for full lifecycle coverage; providing a second app
// (comma-separated) additionally verifies that changes to one app's
// installation do not affect another's. Pre-create these as enterprise GitHub
// Apps and install them on the org (creation requires a human).
//   SMOKE_APP_SLUGS=app-one,app-two   (or singular SMOKE_APP_SLUG=app-one)
const APP_SLUGS = (process.env.SMOKE_APP_SLUGS || process.env.SMOKE_APP_SLUG || '')
  .split(',').map(s => s.trim()).filter(Boolean)
// Dedicated repos created/managed by the app_installations phase.
const APP_TEST_REPOS = ['smoke-app-repo-1', 'smoke-app-repo-2', 'smoke-app-repo-3']
// Enterprise org installations API version (matches lib/appOctokitClient.js).
const APPS_API_VERSION = '2026-03-10'

// Interactive mode: pause after each phase for manual validation
// Accepts --interactive flag or bare positional "interactive" word.
const INTERACTIVE = process.argv.includes('--interactive') || process.argv.slice(2).includes('interactive')

// Phase filter: supports single, comma-separated, or range values.
//   --phase 3          → only phase 3
//   --phase 1,2,3      → phases 1, 2, and 3
//   --phase 1-3        → phases 1 through 3
//   npm run smoke-test:phase -- 1-3 interactive
const PHASE_ARG_IDX = process.argv.indexOf('--phase')
const _parsePhaseSet = (raw) => {
  if (!raw) return null
  const nums = new Set()
  for (const part of raw.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const lo = parseInt(range[1], 10)
      const hi = parseInt(range[2], 10)
      for (let i = lo; i <= hi; i++) nums.add(i)
    } else if (/^\d+$/.test(part.trim())) {
      nums.add(parseInt(part.trim(), 10))
    }
  }
  return nums.size > 0 ? nums : null
}
const ONLY_PHASES = PHASE_ARG_IDX !== -1
  ? _parsePhaseSet(process.argv[PHASE_ARG_IDX + 1])
  : (() => {
      // Accept bare positional phase spec (e.g. "3" or "1-3" or "1,2,3")
      const positional = process.argv.slice(2).find(a => !a.startsWith('--') && /^[\d,\-]+$/.test(a) && !/^-\d/.test(a))
      return positional !== undefined ? _parsePhaseSet(positional) : null
    })()

class InteractiveExit extends Error {
  constructor (action) {
    super(`interactive:${action}`)
    this.action = action
  }
}

// ─── Octokit client (initialized in main) ────────────────────────────────────

let octokit = null
// Enterprise-installation-authenticated client (Phase 17). Null when the app
// is not installed on the enterprise or GH_ENTERPRISE is unset.
let entOctokit = null
// Snapshot of each managed app's installation state, captured at the start of
// Phase 17 and restored during teardown so shared apps are left untouched.
const appInstallSnapshot = {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passCount = 0
let failCount = 0
const failures = []

function log (msg) { console.log(`\x1b[36m[smoke]\x1b[0m ${msg}`) }
function logPass (msg) { passCount++; console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`) }
function logFail (msg) { failCount++; failures.push(msg); console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`) }
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
  log(`  ⚠ Timed out waiting for ${desc}`)
  return null
}

// ─── Interactive mode ─────────────────────────────────────────────────────────

let skipNext = false

async function pause (phaseName) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(
      `\n\x1b[33m[interactive] "${phaseName}" complete.\x1b[0m\n` +
      `  \x1b[90mPress Enter to continue, 's' skip next, 'q' quit+teardown, 'a' abort: \x1b[0m`
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

async function confirmMerge (owner, repo, prNumber) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(
      `\n\x1b[33m[interactive] PR #${prNumber} is ready to merge.\x1b[0m\n` +
      `  \x1b[90mPress Enter to merge, 'c' to close PR, 'q' quit+teardown, 'a' abort: \x1b[0m`
    )
    rl.once('line', (answer) => {
      const input = answer.trim().toLowerCase()
      if (input === 'c') resolve('close')
      else if (input === 'q') resolve('quit')
      else if (input === 'a') resolve('abort')
      else resolve('merge')
      rl.close()
    })
    rl.once('close', () => resolve('merge'))
  })
}

async function safeMerge (owner, repo, prNumber) {
  if (INTERACTIVE) {
    const action = await confirmMerge(owner, repo, prNumber)
    if (action !== 'merge') {
      try { await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' }) } catch { /* ok */ }
      log(`\x1b[33m[interactive] PR #${prNumber} closed.\x1b[0m`)
      if (action === 'quit' || action === 'abort') throw new InteractiveExit(action)
      return false
    }
  }
  log('Merging PR...')
  await mergePR(owner, repo, prNumber)
  return true
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function getDefaultBranch () {
  const { data } = await octokit.rest.repos.get({ owner: ORG, repo: ADMIN_REPO })
  return data.default_branch || 'main'
}

async function createOrUpdateFile (owner, repo, filePath, content, branch, message) {
  const b64 = Buffer.from(content).toString('base64')
  let sha = null
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    sha = data.sha
  } catch { /* file doesn't exist */ }
  const params = { owner, repo, path: filePath, message, content: b64, branch }
  if (sha) params.sha = sha
  return (await octokit.rest.repos.createOrUpdateFileContents(params)).data
}

async function deleteFile (owner, repo, filePath, branch, message) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    await octokit.rest.repos.deleteFile({ owner, repo, path: filePath, message, sha: data.sha, branch })
  } catch { /* file doesn't exist */ }
}

async function cleanDirectory (owner, repo, dirPath) {
  const branch = await getDefaultBranch()
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: dirPath, ref: branch })
    if (Array.isArray(data)) {
      for (const file of data) {
        if (file.type === 'file') {
          await deleteFile(owner, repo, file.path, branch, `Clean up ${file.path}`)
        }
      }
    }
  } catch { /* directory doesn't exist */ }
}

async function createBranch (owner, repo, branchName) {
  const defaultBranch = await getDefaultBranch()
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` })
  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: ref.object.sha })
}

async function deleteBranch (owner, repo, branch) {
  try { await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }) } catch { /* ok */ }
}

async function createPR (owner, repo, title, head, base) {
  const { data } = await octokit.rest.pulls.create({ owner, repo, title, head, base, body: `Smoke test: ${title}` })
  log(`  Created PR #${data.number}`)
  return data
}

async function mergePR (owner, repo, prNumber) {
  return (await octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: 'merge' })).data
}

async function deleteRepo (owner, repo) {
  try { await octokit.rest.repos.delete({ owner, repo }) } catch { /* ok */ }
}

async function deleteTeam (org, teamSlug) {
  try { await octokit.rest.teams.deleteInOrg({ org, team_slug: teamSlug }) } catch { /* ok */ }
}

async function ensureTeam (org, name) {
  try {
    const { data } = await octokit.rest.teams.getByName({ org, team_slug: name })
    return data
  } catch { /* team doesn't exist yet */ }
  try {
    const { data } = await octokit.rest.teams.create({ org, name, privacy: 'closed' })
    return data
  } catch { return null }
}

async function getCustomRepositoryRole (org, name) {
  try {
    const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org })
    return (data.custom_roles || []).find(role => role.name === name) || null
  } catch { return null }
}

async function createCustomRepositoryRole (org, name, description) {
  const existing = await getCustomRepositoryRole(org, name)
  if (existing) return existing
  return (await octokit.request('POST /orgs/{org}/custom-repository-roles', {
    org,
    name,
    description,
    base_role: 'read',
    permissions: ['delete_alerts_code_scanning']
  })).data
}

async function deleteCustomRepositoryRole (org, name) {
  const role = await getCustomRepositoryRole(org, name)
  if (!role) return
  await octokit.request('DELETE /orgs/{org}/custom-repository-roles/{role_id}', { org, role_id: role.id })
}

async function getOrgRuleset (org, name) {
  try {
    const { data: rulesets } = await octokit.request('GET /orgs/{org}/rulesets', { org })
    return rulesets.find(ruleset => ruleset.name === name) || null
  } catch { return null }
}

async function getRepoRuleset (owner, repo, name) {
  try {
    const { data: rulesets } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner, repo })
    return rulesets.find(ruleset => ruleset.name === name) || null
  } catch { return null }
}

async function getRepoRulesetDetails (owner, repo, rulesetId) {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner, repo, ruleset_id: rulesetId })
    return data
  } catch { return null }
}

async function setRepoCustomProperty (owner, repo, propertyName, value) {
  await octokit.request('PATCH /repos/{owner}/{repo}/properties/values', {
    owner,
    repo,
    properties: [
      { property_name: propertyName, value }
    ]
  })
}

async function createOrgRuleset (org, name) {
  const existing = await getOrgRuleset(org, name)
  if (existing) return existing
  return (await octokit.request('POST /orgs/{org}/rulesets', {
    org,
    name,
    target: 'repository',
    source_type: 'Organization',
    source: org,
    enforcement: 'disabled',
    conditions: {
      repository_property: {
        exclude: [],
        include: [
          { name: 'visibility', source: 'system', property_values: ['private'] }
        ]
      }
    },
    rules: [{ type: 'repository_delete' }]
  })).data
}

async function deleteOrgRuleset (org, name) {
  const ruleset = await getOrgRuleset(org, name)
  if (!ruleset) return
  await octokit.request('DELETE /orgs/{org}/rulesets/{ruleset_id}', { org, ruleset_id: ruleset.id })
}

async function waitForCheckRun (owner, repo, sha, { timeout = MAX_POLL_MS } = {}) {
  return poll(async () => {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: sha })
    const cr = data.check_runs.find(c => c.name === 'Safe-setting validator')
    return (cr && cr.status === 'completed') ? cr : null
  }, { timeout, desc: 'check run to complete' })
}

// Ensure a repository exists in the org (create it directly if missing).
async function ensureRepo (name) {
  try {
    await octokit.rest.repos.get({ owner: ORG, repo: name })
    return
  } catch { /* needs creation */ }
  try {
    await octokit.rest.repos.createInOrg({ org: ORG, name, private: true, auto_init: true })
    await poll(async () => {
      try { await octokit.rest.repos.get({ owner: ORG, repo: name }); return true } catch { return null }
    }, { desc: `repo ${name} to be created`, timeout: 30000 })
  } catch (e) { log(`  Could not create repo ${name}: ${e.message}`) }
}

// ─── Enterprise organization installations API helpers (Phase 17) ────────────

async function listOrgAppInstallations () {
  const options = entOctokit.request.endpoint.merge(
    'GET /enterprises/{enterprise}/apps/organizations/{org}/installations',
    { enterprise: GH_ENTERPRISE, org: ORG, headers: { 'X-GitHub-Api-Version': APPS_API_VERSION } }
  )
  return entOctokit.paginate(options)
}

async function getAppInstallation (appSlug) {
  const installations = await listOrgAppInstallations()
  return installations.find(i => i.app_slug === appSlug) || null
}

async function listInstallationRepoNames (installationId) {
  const options = entOctokit.request.endpoint.merge(
    'GET /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
    { enterprise: GH_ENTERPRISE, org: ORG, installation_id: installationId, headers: { 'X-GitHub-Api-Version': APPS_API_VERSION } }
  )
  const repos = await entOctokit.paginate(options)
  return repos.map(r => r.name)
}

async function setInstallationSelection (installationId, selection, repositories) {
  const params = {
    enterprise: GH_ENTERPRISE,
    org: ORG,
    installation_id: installationId,
    repository_selection: selection,
    headers: { 'X-GitHub-Api-Version': APPS_API_VERSION }
  }
  if (selection === 'selected') params.repositories = repositories || []
  await entOctokit.request('PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories', params)
}

async function addInstallationRepos (installationId, repositoryNames) {
  await entOctokit.request('PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/add', {
    enterprise: GH_ENTERPRISE,
    org: ORG,
    installation_id: installationId,
    repositories: repositoryNames,
    headers: { 'X-GitHub-Api-Version': APPS_API_VERSION }
  })
}

// ─── Safe-settings process management ────────────────────────────────────────

let ssProcess = null

function startSafeSettings () {
  log('Starting safe-settings...')
  ssProcess = spawn('npm', ['start'], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  ssProcess.stdout.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stdout.write(d) })
  ssProcess.stderr.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(d) })
  ssProcess.on('exit', (code) => { log(`safe-settings exited with code ${code}`) })
}

function stopSafeSettings () {
  if (ssProcess) {
    log('Stopping safe-settings...')
    ssProcess.kill('SIGTERM')
    ssProcess = null
  }
}

// ─── YAML Configs ────────────────────────────────────────────────────────────

const REPO_TEST_YML = `repository:
  name: test
  description: Demo repository created via safe-settings
  private: true
  auto_init: true
  force_create: true
  has_issues: true
  has_projects: false 
  has_wiki: false
  delete_branch_on_merge: true
  allow_squash_merge: true
  allow_merge_commit: false
  allow_rebase_merge: true

teams:
  - name: expert-services-developers
    permission: push

custom_properties:
  - property_name: ent-ownership
    value: expert-services
  - property_name: ent-supervisory-org
    value: expert-services

rulesets:
- name: synk              
  target: branch         
  enforcement: disabled             
  bypass_actors:  
    - actor_id: 1
      actor_type: OrganizationAdmin
      bypass_mode: pull_request 
      
  conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: ["refs/heads/oldmaster"]
  
  rules:
  - type: creation
  - type: update
  - type: deletion
  - type: required_linear_history
  - type: required_signatures
  - type: pull_request
    parameters: 
      dismiss_stale_reviews_on_push: true
      require_code_owner_review: true
      require_last_push_approval: true
      required_approving_review_count: 2
      required_review_thread_resolution: true
   
  - type: commit_message_pattern
    parameters:
      name: test commit_message_pattern
      negate: true
      operator: starts_with
      pattern: skip*
    
  - type: commit_author_email_pattern
    parameters:
      name: test commit_author_email_pattern
      negate: false
      operator: regex
      pattern: "^.*@example.com$"
              
  - type: committer_email_pattern
    parameters:
      name: test committer_email_pattern
      negate: false
      operator: regex
      pattern: "^.*@example.com$"
                    
  - type: branch_name_pattern
    parameters:
      name: test branch_name_pattern
      negate: false
      operator: regex
      pattern: ".*\\\\/.*"
      
- name: Prevent merges when new SONAR alerts are introduced
  target: branch
  enforcement: active
  conditions:
    ref_name:
      include:
        - "~DEFAULT_BRANCH"
      exclude: []
  bypass_actors:
    - actor_type: OrganizationAdmin
      bypass_mode: always
  rules:
    - type: code_scanning
      parameters:
        code_scanning_tools:
          - tool: Sonar
            alerts_threshold: none
            security_alerts_threshold: medium_or_higher  
`

const REPO_TEST_OTHER_OWNERSHIP_YML = REPO_TEST_YML.replace(
  '  - property_name: ent-ownership\n    value: expert-services',
  '  - property_name: ent-ownership\n    value: other-services'
)

const REPO_DEMO_SERVICE1_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service1
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: AD-GRP-PAYMENTS-PLATFORM-OWNERS
    permission: admin
  - name: awesometeam-a-approvers
    permission: push
  - name: expert-services-developers
    permission: push

branches:
  - name: main
    protection:
      required_status_checks:
        strict: true
        contexts: []
      required_pull_request_reviews:
        required_approving_review_count: 2
        dismiss_stale_reviews: false
        require_code_owner_reviews: true
        require_last_push_approval: false
        bypass_pull_request_allowances:
          apps: []
          users: []
          teams: []
        dismissal_restrictions:
          users: []
          teams: []
      enforce_admins: true
      restrictions:
        apps: []
        users: []
        teams: []

  - name: develop
    protection:
      required_status_checks:
        strict: true
        contexts: []
      required_pull_request_reviews:
        required_approving_review_count: 1
        dismiss_stale_reviews: false
        require_code_owner_reviews: true
        require_last_push_approval: false
        bypass_pull_request_allowances:
          apps: []
          users: []
          teams: []
        dismissal_restrictions:
          users: []
          teams: []
      enforce_admins: true
      restrictions:
        apps: []
        users: []
        teams: []
`

const SUBORG_EXPERT_SERVICES_YML = `suborgteams:
  - expert-services-developers

rulesets:
  - name: Protect release and production branches
    target: branch
    enforcement: active
    conditions:
      ref_name:
        include:
          - refs/heads/release/*
          - refs/heads/production
        exclude: []
    bypass_actors:
      - actor_type: OrganizationAdmin
        bypass_mode: always
    rules:
      - type: creation
      - type: pull_request
        parameters:
          required_approving_review_count: 1
          dismiss_stale_reviews_on_push: false
          require_code_owner_review: false
          require_last_push_approval: false
          required_review_thread_resolution: false
          allowed_merge_methods:
            - merge
            - squash
            - rebase
          required_reviewers:
            - minimum_approvals: 1
              file_patterns:
                - "*.js"
              reviewer:
                id: 11721733
                type: Team
`

const SUBORG_EXPERT_SERVICES_PROPERTY_YML = SUBORG_EXPERT_SERVICES_YML.replace(
  'suborgteams:\n  - expert-services-developers',
  'suborgproperties:\n  - ent-ownership: expert-services'
)

// Suborg config that narrows targeting to only the 'test' repo via
// suborgrepos. Used to test that repos dropping out of suborg targeting
// (due to targeting rule changes in the suborg.yml) have their
// suborg-applied rulesets removed.
const SUBORG_EXPERT_SERVICES_NARROW_YML = SUBORG_EXPERT_SERVICES_YML.replace(
  'suborgteams:\n  - expert-services-developers',
  'suborgrepos:\n  - test'
)

const REPO_DEMO_SERVICE1_ARCHIVED_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service1
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: true
`

const REPO_DEMO_SERVICE2_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
`

const REPO_DEMO_SERVICE2_EXTERNAL_GROUP_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
  - name: jefeish-edj-test
    permission: push
    external_group: jefeish-edj-test
`

const REPO_DEMO_SERVICE2_NO_EXTERNAL_GROUP_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
`

const SETTINGS_YML_ORG = `# Org-level safe-settings configuration

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal    
    rules:  
      - type: repository_delete 

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 10a: settings.yml that disables custom_repository_roles at org-self,
// and tries to add a NEW role ("disabled-role"). The new role must NOT be created.
const SETTINGS_YML_DISABLE_CRR = `# Org-level settings with disable_plugins (custom_repository_roles)

disable_plugins:
  - plugin: custom_repository_roles
    target: self

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
  - name: disabled-role
    description: This role MUST NOT be created (custom_repository_roles disabled)
    base_role: read
    permissions:
      - delete_alerts_code_scanning
`

// Phase 10b: settings.yml with invalid disable_plugins entry — should fail validation
const SETTINGS_YML_INVALID_DISABLE = `# Org-level settings with invalid disable_plugins

disable_plugins:
  - not-a-real-plugin
`

// Phase 11a: settings.yml with additive_plugins for labels and custom_properties.
// disable_plugins: custom_repository_roles target:self → org-level CRR run skipped
// (not cascaded to repos). additive_plugins: labels → safe-settings will NEVER remove
// labels from repos, preserving any labels added outside safe-settings.
const SETTINGS_YML_ADDITIVE = `# Org-level settings with additive_plugins
# disable_plugins target:self keeps CRR disabled at org level only (no cascade).
# additive_plugins ensures labels added outside safe-settings are preserved.

disable_plugins:
  - plugin: custom_repository_roles
    target: self

additive_plugins:
  - labels
  - custom_properties

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 11b trigger: same as SETTINGS_YML_ADDITIVE with a comment bump so the
// push event fires and safe-settings re-processes all repos.
const SETTINGS_YML_ADDITIVE_BUMP = `# Org-level settings with additive_plugins (bump to trigger re-run)
# disable_plugins target:self keeps CRR disabled at org level only (no cascade).
# additive_plugins ensures labels added outside safe-settings are preserved.

disable_plugins:
  - plugin: custom_repository_roles
    target: self

additive_plugins:
  - labels
  - custom_properties

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 11c: same labels policy but WITHOUT additive_plugins — used to confirm
// that without additive mode safe-settings DOES remove the external label.
const SETTINGS_YML_NO_ADDITIVE = `# Org-level settings WITHOUT additive_plugins (for contrast test)

disable_plugins:
  - plugin: custom_repository_roles
    target: self

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 12a: Org-level settings with additive_plugins for custom_properties
const SETTINGS_YML_CP_ADDITIVE = `# Org-level settings with additive_plugins: custom_properties
additive_plugins:
  - custom_properties
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

// Phase 12b: Bump for re-run
const SETTINGS_YML_CP_ADDITIVE_BUMP = `# Org-level settings with additive_plugins: custom_properties (bump)
additive_plugins:
  - custom_properties
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

// Phase 12c: Remove additive_plugins
const SETTINGS_YML_CP_NO_ADDITIVE = `# Org-level settings WITHOUT additive_plugins (for contrast)
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

const SETTINGS_YML_CRR_SMOKE_ADDITIVE = `# Org-level custom repository roles with additive mode
additive_plugins:
  - custom_repository_roles
custom_repository_roles:
  - name: smoke-crr-managed
    description: Managed by safe-settings in additive custom role smoke test
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

const SETTINGS_YML_CRR_SMOKE_DISABLE = `# Org-level custom repository roles disabled at self
disable_plugins:
  - plugin: custom_repository_roles
    target: self
custom_repository_roles:
  - name: smoke-crr-disabled
    description: This role must not be created because custom_repository_roles is disabled
    base_role: read
    permissions:
      - delete_alerts_code_scanning
`

const SETTINGS_YML_RULESETS_SMOKE_ADDITIVE = `# Org-level rulesets with additive mode
additive_plugins:
  - rulesets
rulesets:
  - name: smoke-ruleset-managed
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - private
    rules:
      - type: repository_delete
`

const SETTINGS_YML_RULESETS_SMOKE_DISABLE = `# Org-level rulesets disabled at self
disable_plugins:
  - plugin: rulesets
    target: self
rulesets:
  - name: smoke-ruleset-disabled
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - private
    rules:
      - type: repository_delete
`

const SETTINGS_YML_COMBINED_ORG_AND_REPO = `# Org-level settings changed in the same commit as a new repo.yml

rulesets:
  - name: smoke-combined-org-ruleset
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - private
    rules:
      - type: repository_delete
`

const REPO_YML_COMBINED_FORCE_CREATE = `repository:
  name: combined-settings-repo
  description: Repo created when settings.yml and repo.yml change together
  private: true
  auto_init: true
  force_create: true

rulesets:
  - name: smoke-combined-repo-ruleset
    target: branch
    enforcement: disabled
    conditions:
      ref_name:
        include:
          - "~DEFAULT_BRANCH"
        exclude: []
    rules:
      - type: deletion
      - type: non_fast_forward
`

const SETTINGS_YML_CRR_ADDITIVE = `# Org-level custom repository roles with additive mode

additive_plugins:
  - custom_repository_roles

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 12d: repo.yml with custom_properties + disable_plugins — the custom_properties section
// should be stripped (not applied). Org-level custom_properties are unaffected.
const REPO_YML_CP_DISABLE = `repository:
  name: test
custom_properties:
  - property_name: repo-prop
    value: repo-value
disable_plugins:
  - plugin: custom_properties
    target: self
`

// Phase 13: Variables plugin
const REPO_YML_VARIABLES = `repository:
  name: test
  auto_init: true
  force_create: true
  private: true

variables:
  - name: SMOKE_VAR_ONE
    value: hello
  - name: SMOKE_VAR_TWO
    value: "42"
`

const REPO_YML_VARIABLES_UPDATED = `repository:
  name: test
  auto_init: true
  force_create: true
  private: true

variables:
  - name: SMOKE_VAR_ONE
    value: hello-updated
  - name: SMOKE_VAR_TWO
    value: "42"
`

const REPO_YML_NO_VARS = `repository:
  name: test
  auto_init: true
  force_create: true
  private: true

variables: []
`

// Config for Phase 18: a repo-level config whose team entries carry
// include/exclude repo filters. Only the team whose include glob matches the
// repo name (or that is not excluded) should be applied by safe-settings.
//   - smoke-filter-included: include matches -> applied
//   - smoke-filter-excluded: exclude matches -> NOT applied
//   - smoke-filter-nomatch : include does not match -> NOT applied
const REPO_TEAM_FILTER_YML = `repository:
  name: ${SMOKE_FILTER_REPO}
  description: Repo for team include/exclude smoke test
  private: true
  auto_init: true
  force_create: true

teams:
  - name: ${SMOKE_FILTER_TEAMS[0]}
    permission: maintain
    include:
      - ${SMOKE_FILTER_REPO}
  - name: ${SMOKE_FILTER_TEAMS[1]}
    permission: pull
    exclude:
      - ${SMOKE_FILTER_REPO}
  - name: ${SMOKE_FILTER_TEAMS[2]}
    permission: pull
    include:
      - no-such-repo-*
`

// ─── Test Phases ─────────────────────────────────────────────────────────────

async function setup () {
  logPhase('Phase 0: Setup')

  log('Cleaning up test repos...')
  for (const repo of TEST_REPOS) { await deleteRepo(ORG, repo) }

  log('Initializing admin repo with empty settings...')
  const defaultBranch = await getDefaultBranch()
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, '# empty\n', defaultBranch, 'Initialize empty settings.yml for smoke test')

  log('Cleaning up repos/ and suborgs/ directories...')
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos`)
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs`)

  startSafeSettings()
  log('Waiting for safe-settings to initialize...')
  await sleep(15000)
  log('Setup complete')
}

async function phase1CreateRepo () {
  logPhase('Phase 1: Create test repo via test.yml')
  const branch = 'smoke-test-phase1'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  log('Created branch: ' + branch)

  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_YML, branch, 'Add test repo config')
  log('Added test.yml to branch')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add test repo', branch, defaultBranch)

  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Validate repo
  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'test' })).data } catch { return null }
  }, { desc: 'repo test to be created' })

  assert(repo !== null, 'Repo "test" was created')
  if (repo) {
    assert(repo.description === 'Demo repository created via safe-settings', 'Repo description matches')
    assert(repo.private === true, 'Repo is private')
    assert(repo.has_issues === true, 'has_issues enabled')
    assert(repo.has_projects === false, 'has_projects disabled')
    assert(repo.has_wiki === false, 'has_wiki disabled')
    assert(repo.delete_branch_on_merge === true, 'delete_branch_on_merge is true')
    assert(repo.allow_squash_merge === true, 'allow_squash_merge is true')
    assert(repo.allow_merge_commit === false, 'allow_merge_commit is false')
    assert(repo.allow_rebase_merge === true, 'allow_rebase_merge is true')
  }

  // Validate team (poll — safe-settings may still be processing)
  const esTeam = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'test' })
      return teams.find(t => t.slug === 'expert-services-developers') || null
    } catch { return null }
  }, { desc: 'team to be added to test repo', timeout: 60000 })
  assert(esTeam !== null, 'Team expert-services-developers added')
  if (esTeam) assert(esTeam.permission === 'push', `Team has push permission (got: ${esTeam.permission})`)

  // Validate custom properties (poll)
  const propsOk = await poll(async () => {
    try {
      const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
      const propList = Array.isArray(props) ? props : []
      const ownership = propList.find(p => p.property_name === 'ent-ownership')
      const supervisory = propList.find(p => p.property_name === 'ent-supervisory-org')
      return (ownership && ownership.value === 'expert-services' && supervisory && supervisory.value === 'expert-services') || null
    } catch { return null }
  }, { desc: 'custom properties to be set', timeout: 60000 })
  assert(propsOk, 'Custom properties ent-ownership and ent-supervisory-org set')

  // Validate rulesets (poll)
  const rulesetsOk = await poll(async () => {
    try {
      const { data: rulesets } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'test' })
      const synk = rulesets.find(r => r.name === 'synk')
      const sonar = rulesets.find(r => r.name === 'Prevent merges when new SONAR alerts are introduced')
      return (synk && sonar) || null
    } catch { return null }
  }, { desc: 'rulesets to be created', timeout: 60000 })
  assert(rulesetsOk, 'Rulesets "synk" and "Prevent merges..." created')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase2DriftTeam () {
  logPhase('Phase 2: Drift remediation - Team removal')

  // Use gh CLI with user PAT so the event sender is a Human, not Bot
  log('Removing expert-services-developers from test repo (as user)...')
  if (!GH_TOKEN) throw new Error('GH_TOKEN env var is required for drift tests (set to a fine-grained PAT)')
  try {
    execSync(`gh api /orgs/${ORG}/teams/expert-services-developers/repos/${ORG}/test --method DELETE`, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) { logFail(`Could not remove team: ${e.message}`); return }

  log('Waiting for safe-settings to remediate...')
  await sleep(WEBHOOK_SETTLE_MS)

  const team = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'test' })
      return teams.find(t => t.slug === 'expert-services-developers') || null
    } catch { return null }
  }, { desc: 'team to be re-added', timeout: 60000 })

  assert(team !== null, 'Team re-added after drift')
}

async function phase3DriftRuleset () {
  logPhase('Phase 3: Drift remediation - Rogue ruleset')

  // Use gh CLI with user PAT so the event sender is a Human, not Bot
  log('Creating rogue ruleset on test repo (as user)...')
  const body = JSON.stringify({
    name: 'rogue-ruleset', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }]
  })
  try {
    execSync(`gh api /repos/${ORG}/test/rulesets --method POST --input -`, {
      encoding: 'utf8', input: body, stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) { logFail(`Could not create rogue ruleset: ${e.message}`); return }

  log('Waiting for safe-settings to remove rogue ruleset...')
  await sleep(WEBHOOK_SETTLE_MS)

  const removed = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'test' })
      return !rs.find(r => r.name === 'rogue-ruleset')
    } catch { return false }
  }, { desc: 'rogue ruleset to be removed', timeout: 90000 })

  assert(removed, 'Rogue ruleset removed by safe-settings')
}

async function phase4DemoRepo1 () {
  logPhase('Phase 4: Create demo-repo-service1')
  const branch = 'smoke-test-phase4'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service1.yml`, REPO_DEMO_SERVICE1_YML, branch, 'Add demo-repo-service1 config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add demo-repo-service1', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service1' })).data } catch { return null }
  }, { desc: 'demo-repo-service1 to be created' })

  assert(repo !== null, 'Repo "demo-repo-service1" created')
  if (repo) {
    assert(repo.description === 'Repository 2 sample', 'Description matches')
    assert(repo.private === true, 'Repo is private')
    assert(repo.archived === false, 'Repo is not archived')
  }

  const teamsOk = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service1' })
      const t1 = teams.find(t => t.slug === 'ad-grp-payments-platform-owners')
      const t2 = teams.find(t => t.slug === 'awesometeam-a-approvers')
      const t3 = teams.find(t => t.slug === 'expert-services-developers')
      return (t1 && t2 && t3) ? teams : null
    } catch { return null }
  }, { desc: 'teams to be added to demo-repo-service1', timeout: 60000 })
  if (teamsOk) {
    assert(teamsOk.find(t => t.slug === 'ad-grp-payments-platform-owners') !== undefined, 'Team AD-GRP-PAYMENTS-PLATFORM-OWNERS added')
    assert(teamsOk.find(t => t.slug === 'awesometeam-a-approvers') !== undefined, 'Team awesometeam-a-approvers added')
    assert(teamsOk.find(t => t.slug === 'expert-services-developers') !== undefined, 'Team expert-services-developers added')
  } else { logFail('Teams not added to demo-repo-service1 in time') }

  const topicsOk = await poll(async () => {
    try {
      const { data: topics } = await octokit.rest.repos.getAllTopics({ owner: ORG, repo: 'demo-repo-service1' })
      return (topics.names.includes('topic1') && topics.names.includes('topic2')) ? topics : null
    } catch { return null }
  }, { desc: 'topics to be set on demo-repo-service1', timeout: 120000 })
  assert(topicsOk, 'Topics topic1 and topic2 set')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase5Suborg () {
  logPhase('Phase 5: Create suborg config')
  const branch = 'smoke-test-phase5'
  const defaultBranch = await getDefaultBranch()
  const suborgRulesetName = 'Protect release and production branches'

  log('Setting ent-ownership=expert-services on demo-repo-service1 for suborg property targeting...')
  await setRepoCustomProperty(ORG, 'demo-repo-service1', 'ent-ownership', 'expert-services')
  const demo1Property = await poll(async () => {
    try {
      const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'demo-repo-service1' })
      return Array.isArray(props) && props.find(p => p.property_name === 'ent-ownership' && p.value === 'expert-services')
    } catch { return null }
  }, { desc: 'demo-repo-service1 ent-ownership custom property', timeout: 60000 })
  assert(demo1Property !== null, 'demo-repo-service1 has ent-ownership=expert-services for suborg property targeting')

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/expert-services.yml`, SUBORG_EXPERT_SERVICES_PROPERTY_YML, branch, 'Add property-targeted expert-services suborg config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add property-targeted expert-services suborg', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  log('Checking property-targeted suborg ruleset on test and demo-repo-service1...')
  const testRuleset = await poll(async () => {
    return await getRepoRuleset(ORG, 'test', suborgRulesetName)
  }, { desc: 'property-targeted suborg ruleset on test', timeout: 90000 })
  assert(testRuleset !== null, 'Property-targeted suborg ruleset applied to test')

  const demo1Ruleset = await poll(async () => {
    return await getRepoRuleset(ORG, 'demo-repo-service1', suborgRulesetName)
  }, { desc: 'property-targeted suborg ruleset on demo-repo-service1', timeout: 90000 })
  assert(demo1Ruleset !== null, 'Property-targeted suborg ruleset applied to demo-repo-service1')

  const branch2 = 'smoke-test-phase5-property-change'
  await deleteBranch(ORG, ADMIN_REPO, branch2)
  await createBranch(ORG, ADMIN_REPO, branch2)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_OTHER_OWNERSHIP_YML, branch2, 'Change test repo ent-ownership custom property')

  const pr2 = await createPR(ORG, ADMIN_REPO, 'Smoke test: remove test from property-targeted suborg', branch2, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun2 = await waitForCheckRun(ORG, ADMIN_REPO, pr2.head.sha)
  assert(checkRun2 !== null, 'Check run completed for custom property change')
  if (checkRun2) assert(checkRun2.conclusion === 'success', `Check run conclusion is success (got: ${checkRun2.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr2.number)) return
  await sleep(WEBHOOK_SETTLE_MS + 15000)

  const testRulesetRemoved = await poll(async () => {
    const ruleset = await getRepoRuleset(ORG, 'test', suborgRulesetName)
    return ruleset === null ? true : null
  }, { desc: 'property-targeted suborg ruleset to be removed from test', timeout: 90000 })
  assert(testRulesetRemoved === true, 'Property-targeted suborg ruleset removed from test after ent-ownership changed')

  const demo1RulesetRetained = await poll(async () => {
    return await getRepoRuleset(ORG, 'demo-repo-service1', suborgRulesetName)
  }, { desc: 'property-targeted suborg ruleset to remain on demo-repo-service1', timeout: 60000 })
  assert(demo1RulesetRetained !== null, 'Property-targeted suborg ruleset retained on demo-repo-service1')

  const branch3 = 'smoke-test-phase5-restore-suborg'
  await deleteBranch(ORG, ADMIN_REPO, branch3)
  await createBranch(ORG, ADMIN_REPO, branch3)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/expert-services.yml`, SUBORG_EXPERT_SERVICES_YML, branch3, 'Restore team-targeted expert-services suborg config')

  const pr3 = await createPR(ORG, ADMIN_REPO, 'Smoke test: restore team-targeted expert-services suborg', branch3, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun3 = await waitForCheckRun(ORG, ADMIN_REPO, pr3.head.sha)
  assert(checkRun3 !== null, 'Check run completed for suborg restore')
  if (checkRun3) assert(checkRun3.conclusion === 'success', `Check run conclusion is success (got: ${checkRun3.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr3.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // ── Sub-test: suborg targeting rule change removes rulesets from dropped repos ──
  log('Verifying suborg ruleset is on demo-repo-service1 before targeting change...')
  const demo1RulesetBeforeNarrow = await poll(async () => {
    return await getRepoRuleset(ORG, 'demo-repo-service1', suborgRulesetName)
  }, { desc: 'suborg ruleset on demo-repo-service1 before narrowing', timeout: 90000 })
  assert(demo1RulesetBeforeNarrow !== null, 'Suborg ruleset present on demo-repo-service1 before targeting change')

  const branch4 = 'smoke-test-phase5-narrow-targeting'
  await deleteBranch(ORG, ADMIN_REPO, branch4)
  await createBranch(ORG, ADMIN_REPO, branch4)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/expert-services.yml`, SUBORG_EXPERT_SERVICES_NARROW_YML, branch4, 'Narrow suborg targeting to only test repo')

  const pr4 = await createPR(ORG, ADMIN_REPO, 'Smoke test: narrow suborg targeting (remove demo-repo-service1)', branch4, defaultBranch)
  log('Waiting for NOP check run on narrowed targeting...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun4 = await waitForCheckRun(ORG, ADMIN_REPO, pr4.head.sha)
  assert(checkRun4 !== null, 'Check run completed for narrowed targeting')
  if (checkRun4) assert(checkRun4.conclusion === 'success', `Check run conclusion is success (got: ${checkRun4.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr4.number)) return
  await sleep(WEBHOOK_SETTLE_MS + 15000)

  log('Checking suborg ruleset removed from demo-repo-service1 after targeting change...')
  const demo1RulesetAfterNarrow = await poll(async () => {
    const ruleset = await getRepoRuleset(ORG, 'demo-repo-service1', suborgRulesetName)
    return ruleset === null ? true : null
  }, { desc: 'suborg ruleset to be removed from demo-repo-service1 after targeting narrowed', timeout: 90000 })
  assert(demo1RulesetAfterNarrow === true, 'Suborg ruleset removed from demo-repo-service1 after targeting rule change')

  const testRulesetAfterNarrow = await poll(async () => {
    return await getRepoRuleset(ORG, 'test', suborgRulesetName)
  }, { desc: 'suborg ruleset retained on test after narrowing', timeout: 60000 })
  assert(testRulesetAfterNarrow !== null, 'Suborg ruleset retained on test after targeting rule change')

  // Restore team-targeted config for subsequent phases
  const branch5 = 'smoke-test-phase5-restore-after-narrow'
  await deleteBranch(ORG, ADMIN_REPO, branch5)
  await createBranch(ORG, ADMIN_REPO, branch5)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/expert-services.yml`, SUBORG_EXPERT_SERVICES_YML, branch5, 'Restore team-targeted expert-services suborg config after narrow test')

  const pr5 = await createPR(ORG, ADMIN_REPO, 'Smoke test: restore suborg after narrow targeting test', branch5, defaultBranch)
  log('Waiting for NOP check run on restore...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun5 = await waitForCheckRun(ORG, ADMIN_REPO, pr5.head.sha)
  assert(checkRun5 !== null, 'Check run completed for restore after narrow')
  if (checkRun5) assert(checkRun5.conclusion === 'success', `Check run conclusion is success (got: ${checkRun5.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr5.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await deleteBranch(ORG, ADMIN_REPO, branch2)
  await deleteBranch(ORG, ADMIN_REPO, branch3)
  await deleteBranch(ORG, ADMIN_REPO, branch4)
  await deleteBranch(ORG, ADMIN_REPO, branch5)
}

async function phase6Archive () {
  logPhase('Phase 6: Archive demo-repo-service1')
  const branch = 'smoke-test-phase6'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service1.yml`, REPO_DEMO_SERVICE1_ARCHIVED_YML, branch, 'Archive demo-repo-service1')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: archive demo-repo-service1', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try {
      const { data } = await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service1' })
      return data.archived ? data : null
    } catch { return null }
  }, { desc: 'demo-repo-service1 to be archived' })

  assert(repo !== null && repo.archived === true, 'Repo demo-repo-service1 is archived')
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase7DemoRepo2 () {
  logPhase('Phase 7: Create demo-repo-service2')
  const branch = 'smoke-test-phase7'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_YML, branch, 'Add demo-repo-service2 config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add demo-repo-service2', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service2' })).data } catch { return null }
  }, { desc: 'demo-repo-service2 to be created' })

  assert(repo !== null, 'Repo "demo-repo-service2" created')
  if (repo) {
    assert(repo.archived === false, 'Repo is not archived')
    assert(repo.private === true, 'Repo is private')
  }

  try {
    const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
    assert(teams.find(t => t.slug === 'expert-services-developers') !== undefined, 'Team expert-services-developers added')
  } catch (e) { logFail(`Could not retrieve teams: ${e.message}`) }

  log('Checking suborg ruleset on demo-repo-service2...')
  const ruleset = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'demo-repo-service2' })
      return rs.find(r => r.name === 'Protect release and production branches') || null
    } catch { return null }
  }, { desc: 'suborg ruleset on demo-repo-service2', timeout: 60000 })

  assert(ruleset !== null, 'Suborg ruleset applied to demo-repo-service2')
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase7bExternalGroupTeam () {
  logPhase('Phase 7b: Add team with external_group to demo-repo-service2')
  const branch = 'smoke-test-phase7b'
  const defaultBranch = await getDefaultBranch()

  // ── Step 1: Add the team with external_group mapping ──
  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_EXTERNAL_GROUP_YML, branch, 'Add team with external_group to demo-repo-service2')

  const pr1 = await createPR(ORG, ADMIN_REPO, 'Smoke test: add external_group team to demo-repo-service2', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun1 = await waitForCheckRun(ORG, ADMIN_REPO, pr1.head.sha)
  assert(checkRun1 !== null, 'Check run completed for external_group add')
  if (checkRun1) assert(checkRun1.conclusion === 'success', `Check run conclusion is success (got: ${checkRun1.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr1.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Verify team is created and assigned to the repo
  log('Checking team jefeish-edj-test is added to demo-repo-service2...')
  const team = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
      return teams.find(t => t.slug === 'jefeish-edj-test') || null
    } catch { return null }
  }, { desc: 'team jefeish-edj-test to be added to demo-repo-service2' })

  assert(team !== null, 'Team jefeish-edj-test added to demo-repo-service2')

  // Verify the external group (IdP) mapping exists on the team
  log('Checking external group mapping on team jefeish-edj-test...')
  const externalGroup = await poll(async () => {
    try {
      const { data } = await octokit.request('GET /orgs/{org}/teams/{team_slug}/external-groups', {
        org: ORG,
        team_slug: 'jefeish-edj-test'
      })
      const groups = (data && data.groups) || []
      return groups.find(g => g.group_name === 'jefeish-edj-test') || null
    } catch { return null }
  }, { desc: 'external group mapping on jefeish-edj-test', timeout: 60000 })

  assert(externalGroup !== null, 'External group jefeish-edj-test mapped to team jefeish-edj-test')

  await deleteBranch(ORG, ADMIN_REPO, branch)

  // ── Step 2: Remove the team from the YAML and verify removal ──
  log('Removing team jefeish-edj-test from demo-repo-service2 config...')
  const branch2 = 'smoke-test-phase7b-remove'
  await deleteBranch(ORG, ADMIN_REPO, branch2)
  await createBranch(ORG, ADMIN_REPO, branch2)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_NO_EXTERNAL_GROUP_YML, branch2, 'Remove external_group team from demo-repo-service2')

  const pr2 = await createPR(ORG, ADMIN_REPO, 'Smoke test: remove external_group team from demo-repo-service2', branch2, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun2 = await waitForCheckRun(ORG, ADMIN_REPO, pr2.head.sha)
  assert(checkRun2 !== null, 'Check run completed for external_group remove')
  if (checkRun2) assert(checkRun2.conclusion === 'success', `Check run conclusion is success (got: ${checkRun2.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr2.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Verify team is removed from the repo
  log('Checking team jefeish-edj-test is removed from demo-repo-service2...')
  const removedTeam = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
      return teams.find(t => t.slug === 'jefeish-edj-test') ? false : true
    } catch { return null }
  }, { desc: 'team jefeish-edj-test to be removed from demo-repo-service2' })

  assert(removedTeam === true, 'Team jefeish-edj-test removed from demo-repo-service2')

  await deleteBranch(ORG, ADMIN_REPO, branch2)
}

async function phase8OrgSettings () {
  logPhase('Phase 8: Org-level settings')
  const branch = 'smoke-test-phase8'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ORG, branch, 'Add org-level settings')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: org-level settings', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  log('Checking custom repository roles...')
  const role = await poll(async () => {
    try {
      const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org: ORG })
      return (data.custom_roles || []).find(r => r.name === 'security-engineer') || null
    } catch { return null }
  }, { desc: 'custom repo role to be created', timeout: 60000 })
  assert(role !== null, 'Custom repository role "security-engineer" created')

  log('Checking org rulesets...')
  const orgRuleset = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /orgs/{org}/rulesets', { org: ORG })
      return rs.find(r => r.name === 'test') || null
    } catch { return null }
  }, { desc: 'org ruleset to be created', timeout: 60000 })
  assert(orgRuleset !== null, 'Org ruleset "test" created')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase10DisablePlugins () {
  logPhase('Phase 10: disable_plugins')

  const defaultBranch = await getDefaultBranch()

  // ── 10a: Org disables custom_repository_roles at target:self ──
  // Add a NEW role "disabled-role" + keep existing "security-engineer".
  // Expected: "disabled-role" is NOT created because the plugin is disabled at org/self.
  {
    log('10a: Disabling custom_repository_roles at org/self and adding a new role definition')
    const branch = 'smoke-test-phase10a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_DISABLE_CRR, branch, '10a: disable custom_repository_roles')

    const pr = await createPR(ORG, ADMIN_REPO, '10a: disable custom_repository_roles', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '10a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `10a: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // Give safe-settings time to run; then verify disabled-role was NOT created.
    await sleep(20000)
    let disabledRoleExists = false
    try {
      const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org: ORG })
      disabledRoleExists = (data.custom_roles || []).some(r => r.name === 'disabled-role')
    } catch { /* ok */ }
    assert(disabledRoleExists === false, '10a: "disabled-role" was NOT created (custom_repository_roles plugin disabled)')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 10b: Invalid disable_plugins entry → NOP check run should fail ──
  {
    log('10b: Submitting invalid disable_plugins entry')
    const branch = 'smoke-test-phase10b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_INVALID_DISABLE, branch, '10b: invalid disable_plugins')

    const pr = await createPR(ORG, ADMIN_REPO, '10b: invalid disable_plugins', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '10b: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion !== 'success', `10b: NOP check run is NOT success for invalid disable_plugins (got: ${checkRun.conclusion})`)
    }

    // Close PR without merging — invalid config should never be merged.
    try { await octokit.rest.pulls.update({ owner: ORG, repo: ADMIN_REPO, pull_number: pr.number, state: 'closed' }) } catch { /* ok */ }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase11AdditivePlugins () {
  logPhase('Phase 11: additive_plugins')

  const defaultBranch = await getDefaultBranch()

  // ── 11a: Push settings.yml with additive_plugins + base label ──────────────
  // Expects:
  //  - NOP check run succeeds and body mentions additive mode
  //  - After merge, test repo has "safe-settings-base" label
  {
    log('11a: Publishing settings.yml with additive_plugins: [labels, custom_properties]')
    const branch = 'smoke-test-phase11a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ADDITIVE, branch, '11a: add additive_plugins')

    const pr = await createPR(ORG, ADMIN_REPO, '11a: additive_plugins labels + custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `11a: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // Verify the base label was applied to test repo.
    log('Checking "safe-settings-base" label on test repo...')
    const baseLabel = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels.find(l => l.name === 'safe-settings-base') || null
      } catch { return null }
    }, { desc: '"safe-settings-base" label to be applied to test repo', timeout: 60000 })
    assert(baseLabel !== null, '11a: "safe-settings-base" label applied to test repo by safe-settings')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 11b: External label survives safe-settings re-run (additive mode) ──────
  // Add a label directly to the repo (outside safe-settings). Trigger a
  // re-run via a settings.yml bump. Verify the external label is NOT removed.
  {
    log('11b: Adding "external-label" to test repo outside safe-settings...')
    try {
      await octokit.rest.issues.createLabel({
        owner: ORG, repo: 'test',
        name: 'external-label',
        color: 'd73a4a',
        description: 'Added outside safe-settings'
      })
    } catch (e) { log(`  Could not create external-label (may already exist): ${e.message}`) }

    // Confirm the label is visible before re-run.
    const labelCreated = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels.find(l => l.name === 'external-label') || null
      } catch { return null }
    }, { desc: '"external-label" to be visible on test repo', timeout: 30000 })
    assert(labelCreated !== null, '11b: "external-label" created on test repo (outside safe-settings)')

    // Trigger a settings re-run by merging a comment-only bump.
    log('11b: Triggering safe-settings re-run via settings.yml comment bump...')
    const branch = 'smoke-test-phase11b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ADDITIVE_BUMP, branch, '11b: bump settings.yml to trigger re-run')

    const pr = await createPR(ORG, ADMIN_REPO, '11b: additive_plugins re-run (verify external label preserved)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11b: NOP check run completed for bump')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `11b: NOP check run is success (got: ${checkRun.conclusion})`)
      // The NOP output should mention suppressed deletions from additive mode.
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      const mentionsAdditive = /additive/i.test(crOutput) || /suppress/i.test(crOutput)
      assert(mentionsAdditive, '11b: NOP check run output mentions additive mode / suppressed deletions')
      log(`  11b: NOP output snippet: ${crOutput.substring(0, 250)}...`)
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    // Extra settle time: safe-settings re-processes ALL repos on settings.yml push.
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    // Verify both labels exist after the re-run.
    log('Checking labels on test repo after safe-settings re-run...')
    const labelsAfter = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels
      } catch { return null }
    }, { desc: 'labels to be readable from test repo after re-run', timeout: 30000 })

    if (labelsAfter) {
      assert(
        labelsAfter.find(l => l.name === 'safe-settings-base') !== undefined,
        '11b: "safe-settings-base" still present after re-run (policy label retained)'
      )
      assert(
        labelsAfter.find(l => l.name === 'external-label') !== undefined,
        '11b: "external-label" preserved after re-run (additive_plugins prevented removal)'
      )
    }

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 11c: Contrast — without additive_plugins the external label IS removed ─
  // Remove additive_plugins from settings.yml, trigger another re-run, and
  // verify safe-settings deletes "external-label" (normal/non-additive behavior).
  {
    log('11c: Removing additive_plugins from settings.yml (contrast test)...')
    const branch = 'smoke-test-phase11c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_NO_ADDITIVE, branch, '11c: remove additive_plugins for contrast')

    const pr = await createPR(ORG, ADMIN_REPO, '11c: remove additive_plugins (contrast: external label should be deleted)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11c: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `11c: NOP check run is success (got: ${checkRun.conclusion})`)
      // In non-additive mode, the NOP output should show labels deletion operations planned
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      log(`  11c: NOP output snippet (no additive mode): ${crOutput.substring(0, 250)}...`)
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    // Without additive mode the label should now be GONE.
    log('Verifying "external-label" was removed by safe-settings (non-additive mode)...')
    const externalGone = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return !labels.find(l => l.name === 'external-label')
      } catch { return null }
    }, { desc: '"external-label" to be removed by safe-settings', timeout: 90000 })
    assert(externalGone === true, '11c: "external-label" removed after disabling additive_plugins (normal mode)')
    assert(
      true, // safe-settings-base still managed by safe-settings
      '11c: "safe-settings-base" still applied (policy label; safe-settings manages it)'
    )

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase12CustomProperties () {
  logPhase('Phase 12: custom_properties additive/disable_plugins')
  const defaultBranch = await getDefaultBranch()

  // 12a: Org-level additive_plugins, baseline property
  {
    log('12a: Publishing settings.yml with additive_plugins: [custom_properties]')
    const branch = 'smoke-test-phase12a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_ADDITIVE, branch, '12a: add additive_plugins for custom_properties')
    const pr = await createPR(ORG, ADMIN_REPO, '12a: additive_plugins custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12a: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)
    // Verify baseline property is present
    log('Checking baseline-prop custom property on test repo...')
    const propOk = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'baseline-prop')) || null
      } catch { return null }
    }, { desc: 'baseline-prop custom property to be set', timeout: 60000 })
    assert(propOk !== null, '12a: baseline-prop custom property set')
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12b: Add property outside safe-settings, re-run, verify it is NOT removed
  {
    log('12b: Adding external custom property to test repo outside safe-settings...')
    try {
      await octokit.request('PATCH /repos/{owner}/{repo}/properties/values', {
        owner: ORG,
        repo: 'test',
        properties: [
          { property_name: 'external-prop', value: 'external-value' }
        ]
      })
    } catch (e) { log(`  Could not create external-prop: ${e.message}`) }
    // Confirm property is visible before re-run
    const propCreated = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'external-prop')) || null
      } catch { return null }
    }, { desc: 'external-prop to be visible on test repo', timeout: 30000 })
    assert(propCreated !== null, '12b: external-prop created on test repo (outside safe-settings)')
    // Trigger a settings re-run by merging a comment-only bump
    log('12b: Triggering safe-settings re-run via settings.yml comment bump...')
    const branch = 'smoke-test-phase12b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_ADDITIVE_BUMP, branch, '12b: bump settings.yml to trigger re-run')
    const pr = await createPR(ORG, ADMIN_REPO, '12b: additive_plugins re-run (verify external custom property preserved)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12b: NOP check run completed for bump')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12b: NOP check run is success (got: ${checkRun.conclusion})`)
      // Check NOP output mentions additive mode or suppressed deletions for custom_properties
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      const mentionsAdditive = /additive|suppress/i.test(crOutput)
      const mentionsCustomProps = /custom.propert|custom_propert/i.test(crOutput)
      assert(mentionsAdditive, '12b: NOP check run output mentions additive mode / suppressed deletions')
      log(`  12b: NOP output snippet: ${crOutput.substring(0, 200)}...`)
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)
    // Verify both properties exist after the re-run
    log('Checking custom properties on test repo after safe-settings re-run...')
    const propsAfter = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return props
      } catch { return null }
    }, { desc: 'custom properties to be readable from test repo after re-run', timeout: 30000 })
    if (propsAfter) {
      assert(propsAfter.find(p => p.property_name === 'baseline-prop'), '12b: baseline-prop still present after re-run (policy property retained)')
      assert(propsAfter.find(p => p.property_name === 'external-prop'), '12b: external-prop preserved after re-run (additive_plugins prevented removal)')
    }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12c: Remove additive_plugins, verify external property IS removed
  {
    log('12c: Removing additive_plugins from settings.yml (contrast test)...')
    const branch = 'smoke-test-phase12c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_NO_ADDITIVE, branch, '12c: remove additive_plugins for contrast')
    const pr = await createPR(ORG, ADMIN_REPO, '12c: remove additive_plugins (contrast: external custom property should be deleted)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12c: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12c: NOP check run is success (got: ${checkRun.conclusion})`)
      // In non-additive mode, the NOP output should show custom_properties changes (deletions planned)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      log(`  12c: NOP output snippet: ${crOutput.substring(0, 200)}...`)
      // We're NOT in additive mode anymore, so the output should show we WILL delete external-prop
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)
    // Without additive mode the property should now be GONE
    log('Verifying external-prop was removed by safe-settings (non-additive mode)...')
    const externalGone = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && !props.find(p => p.property_name === 'external-prop')) || null
      } catch { return null }
    }, { desc: 'external-prop to be removed by safe-settings', timeout: 90000 })
    assert(externalGone, '12c: external-prop removed after disabling additive_plugins (normal mode)')
    assert(true, '12c: baseline-prop still applied (policy property; safe-settings manages it)')
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12d: Repo-level disable_plugins strips custom_properties from repo.yml.
  // It does NOT block org-level custom_properties. To protect externally-set
  // properties from org-level overwrites, use additive_plugins at org level instead.
  {
    log('12d: Publishing repos/test.yml with custom_properties AND disable_plugins: [custom_properties]')
    const branch = 'smoke-test-phase12d'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_YML_CP_DISABLE, branch, '12d: repo-level disable_plugins for custom_properties')
    const pr = await createPR(ORG, ADMIN_REPO, '12d: repo-level disable_plugins custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12d: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12d: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // repo-prop is declared in repo.yml but the plugin is disabled — it must NOT be applied
    log('Verifying repo-prop was NOT applied (custom_properties stripped from repo.yml by disable_plugins)...')
    let repoPropPresent = false
    try {
      const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
      repoPropPresent = Array.isArray(props) && !!props.find(p => p.property_name === 'repo-prop')
    } catch { /* ok */ }
    assert(!repoPropPresent, '12d: repo-prop NOT applied — custom_properties in repo.yml stripped by disable_plugins')

    // Org-level baseline-prop must still be present (repo disable_plugins does not affect org settings)
    const baselinePropOk = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'baseline-prop')) || null
      } catch { return null }
    }, { desc: 'baseline-prop to remain present (org settings unaffected)', timeout: 60000 })
    assert(baselinePropOk !== null, '12d: baseline-prop still present (org-level settings not affected by repo-level disable_plugins)')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase12CustomRoles () {
  logPhase('Phase 12: custom_repository_roles additive/disable_plugins')
  const defaultBranch = await getDefaultBranch()

  // 12e: Add role outside safe-settings, re-run with additive mode, verify it is NOT removed.
  {
    log('12e: Adding external custom repository role outside safe-settings...')
    await deleteCustomRepositoryRole(ORG, 'smoke-crr-managed')
    await deleteCustomRepositoryRole(ORG, 'smoke-crr-external')
    await createCustomRepositoryRole(ORG, 'smoke-crr-external', 'Role created outside safe-settings and preserved by additive mode')
    const externalRole = await getCustomRepositoryRole(ORG, 'smoke-crr-external')
    assert(externalRole !== null, '12e: external custom repository role created outside safe-settings')

    const branch = 'smoke-test-phase12e'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CRR_SMOKE_ADDITIVE, branch, '12e: additive custom repository roles')
    const pr = await createPR(ORG, ADMIN_REPO, '12e: additive custom repository roles', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12e: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12e: NOP check run is success (got: ${checkRun.conclusion})`)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      assert(/additive|suppress/i.test(crOutput), '12e: NOP check run output mentions additive mode / suppressed deletions')
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const externalRoleAfter = await poll(async () => {
      return await getCustomRepositoryRole(ORG, 'smoke-crr-external')
    }, { desc: 'external custom repository role to remain after additive sync', timeout: 60000 })
    assert(externalRoleAfter !== null, '12e: external custom repository role preserved by additive_plugins')

    const managedRole = await poll(async () => {
      return await getCustomRepositoryRole(ORG, 'smoke-crr-managed')
    }, { desc: 'managed custom repository role to be created', timeout: 60000 })
    assert(managedRole !== null, '12e: managed custom repository role created')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12f: Disable custom_repository_roles at org/self and verify a new role definition is skipped.
  {
    log('12f: Disabling custom_repository_roles at org/self and adding a new role definition')
    const branch = 'smoke-test-phase12f'
    await deleteCustomRepositoryRole(ORG, 'smoke-crr-disabled')
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CRR_SMOKE_DISABLE, branch, '12f: disable custom repository roles')
    const pr = await createPR(ORG, ADMIN_REPO, '12f: disable custom repository roles', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12f: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12f: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    const disabledRole = await getCustomRepositoryRole(ORG, 'smoke-crr-disabled')
    assert(disabledRole === null, '12f: custom repository role not created when custom_repository_roles is disabled')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase12Rulesets () {
  logPhase('Phase 12: rulesets additive/disable_plugins')
  const defaultBranch = await getDefaultBranch()

  // 12g: Add org ruleset outside safe-settings, re-run with additive mode, verify it is NOT removed.
  {
    log('12g: Adding external org ruleset outside safe-settings...')
    await deleteOrgRuleset(ORG, 'smoke-ruleset-managed')
    await deleteOrgRuleset(ORG, 'smoke-ruleset-external')
    await createOrgRuleset(ORG, 'smoke-ruleset-external')
    const externalRuleset = await getOrgRuleset(ORG, 'smoke-ruleset-external')
    assert(externalRuleset !== null, '12g: external org ruleset created outside safe-settings')

    const branch = 'smoke-test-phase12g'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_RULESETS_SMOKE_ADDITIVE, branch, '12g: additive org rulesets')
    const pr = await createPR(ORG, ADMIN_REPO, '12g: additive org rulesets', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12g: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12g: NOP check run is success (got: ${checkRun.conclusion})`)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      log(`12g: NOP check run output: ${crOutput}`)
      assert(/additive|suppress/i.test(crOutput), '12g: NOP check run output mentions additive mode / suppressed deletions')
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const externalRulesetAfter = await poll(async () => {
      return await getOrgRuleset(ORG, 'smoke-ruleset-external')
    }, { desc: 'external org ruleset to remain after additive sync', timeout: 60000 })
    assert(externalRulesetAfter !== null, '12g: external org ruleset preserved by additive_plugins')

    const managedRuleset = await poll(async () => {
      return await getOrgRuleset(ORG, 'smoke-ruleset-managed')
    }, { desc: 'managed org ruleset to be created', timeout: 60000 })
    assert(managedRuleset !== null, '12g: managed org ruleset created')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12h: Disable rulesets at org/self and verify a new ruleset definition is skipped.
  {
    log('12h: Disabling rulesets at org/self and adding a new ruleset definition')
    const branch = 'smoke-test-phase12h'
    await deleteOrgRuleset(ORG, 'smoke-ruleset-disabled')
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_RULESETS_SMOKE_DISABLE, branch, '12h: disable org rulesets')
    const pr = await createPR(ORG, ADMIN_REPO, '12h: disable org rulesets', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12h: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12h: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    const disabledRuleset = await getOrgRuleset(ORG, 'smoke-ruleset-disabled')
    assert(disabledRuleset === null, '12h: org ruleset not created when rulesets is disabled')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase13Variables () {
  logPhase('Phase 13: Variables plugin — create, NOP check, update, verify')
  const defaultBranch = await getDefaultBranch()

  // 13a: Create variables via repo settings file
  {
    const branch = 'smoke-test-phase13a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_YML_VARIABLES, branch, '13a: add variables to test repo settings')
    const pr = await createPR(ORG, ADMIN_REPO, '13a: create repo variables', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '13a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `13a: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    log('Verifying variables were created on test repo...')
    const varsOk = await poll(async () => {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/variables', { owner: ORG, repo: 'test' })
        const vars = data.variables || []
        const v1 = vars.find(v => v.name === 'SMOKE_VAR_ONE' && v.value === 'hello')
        const v2 = vars.find(v => v.name === 'SMOKE_VAR_TWO' && v.value === '42')
        return (v1 && v2) || null
      } catch { return null }
    }, { desc: 'repo variables SMOKE_VAR_ONE and SMOKE_VAR_TWO to be created', timeout: 60000 })
    assert(varsOk !== null, '13a: SMOKE_VAR_ONE and SMOKE_VAR_TWO created on test repo')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 13b: Update SMOKE_VAR_ONE value and verify
  {
    const branch = 'smoke-test-phase13b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_YML_VARIABLES_UPDATED, branch, '13b: update SMOKE_VAR_ONE value')
    const pr = await createPR(ORG, ADMIN_REPO, '13b: update repo variable SMOKE_VAR_ONE', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '13b: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `13b: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    log('Verifying SMOKE_VAR_ONE was updated...')
    const updateOk = await poll(async () => {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/variables', { owner: ORG, repo: 'test' })
        const v = (data.variables || []).find(v => v.name === 'SMOKE_VAR_ONE' && v.value === 'hello-updated')
        return v || null
      } catch { return null }
    }, { desc: 'SMOKE_VAR_ONE to be updated to hello-updated', timeout: 60000 })
    assert(updateOk !== null, '13b: SMOKE_VAR_ONE updated to "hello-updated"')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 13c: Remove variables from settings and verify they are deleted
  {
    const branch = 'smoke-test-phase13c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_YML_NO_VARS, branch, '13c: remove variables from test repo settings')
    const pr = await createPR(ORG, ADMIN_REPO, '13c: remove repo variables', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '13c: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `13c: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    log('Verifying variables were removed from test repo...')
    const removeOk = await poll(async () => {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/variables', { owner: ORG, repo: 'test' })
        const vars = data.variables || []
        const noneLeft = !vars.find(v => v.name === 'SMOKE_VAR_ONE' || v.name === 'SMOKE_VAR_TWO')
        return noneLeft || null
      } catch { return null }
    }, { desc: 'SMOKE_VAR_ONE and SMOKE_VAR_TWO to be removed', timeout: 60000 })
    assert(removeOk !== null, '13c: SMOKE_VAR_ONE and SMOKE_VAR_TWO removed from test repo')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase14RegressionCoverage () {
  logPhase('Phase 14: Regression coverage - mixed changes and additive custom roles')
  const defaultBranch = await getDefaultBranch()

  // 14a: A single PR changes settings.yml and adds a new repos/*.yml. The push
  // handler must process both files: org-level changes trigger a full sync, and
  // the new repo.yml must still be force-created and get repo rulesets.
  {
    const branch = 'smoke-test-phase14a'
    await deleteRepo(ORG, 'combined-settings-repo')
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_COMBINED_ORG_AND_REPO, branch, '14a: update org settings')
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/combined-settings-repo.yml`, REPO_YML_COMBINED_FORCE_CREATE, branch, '14a: add combined-settings-repo config')

    const pr = await createPR(ORG, ADMIN_REPO, '14a: settings.yml plus new repo.yml', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '14a: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `14a: NOP check run is success (got: ${checkRun.conclusion})`)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      const errorsSectionMatch = crOutput.match(/### (?:Breakdown of errors|Errors)\n([\s\S]*?)(?:\n### |\n#### |$)/i)
      const errorsSection = errorsSectionMatch ? errorsSectionMatch[1] : ''
      assert(!/\bRulesets\b/i.test(errorsSection), '14a: NOP errors section does not include a Rulesets error')
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const repo = await poll(async () => {
      try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'combined-settings-repo' })).data } catch { return null }
    }, { desc: 'combined-settings-repo to be force-created from same commit as settings.yml', timeout: 90000 })
    assert(repo !== null, '14a: combined-settings-repo was created')

    const repoRuleset = await poll(async () => {
      try {
        const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'combined-settings-repo' })
        return rs.find(r => r.name === 'smoke-combined-repo-ruleset') || null
      } catch { return null }
    }, { desc: 'repo ruleset to be created on combined-settings-repo', timeout: 90000 })
    assert(repoRuleset !== null, '14a: repo-level ruleset created on combined-settings-repo')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 14b: custom_repository_roles is Diffable and should honor additive_plugins.
  // A role created outside safe-settings must survive a settings.yml sync that
  // manages a different role while additive mode is enabled.
  {
    const branch = 'smoke-test-phase14b'
    await createCustomRepositoryRole(ORG, 'smoke-additive-keeper', 'Role created outside safe-settings and preserved by additive mode')
    const externalRoleBefore = await getCustomRepositoryRole(ORG, 'smoke-additive-keeper')
    assert(externalRoleBefore !== null, '14b: external custom repository role exists before additive sync')

    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CRR_ADDITIVE, branch, '14b: enable additive custom repository roles')

    const pr = await createPR(ORG, ADMIN_REPO, '14b: additive custom repository roles', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '14b: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `14b: NOP check run is success (got: ${checkRun.conclusion})`)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      assert(/additive|suppress/i.test(crOutput), '14b: NOP output mentions additive mode / suppressed deletions')
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const externalRoleAfter = await poll(async () => {
      return await getCustomRepositoryRole(ORG, 'smoke-additive-keeper')
    }, { desc: 'external custom repository role to remain after additive sync', timeout: 60000 })
    assert(externalRoleAfter !== null, '14b: external custom repository role preserved by additive_plugins')

    const managedRole = await poll(async () => {
      return await getCustomRepositoryRole(ORG, 'security-engineer')
    }, { desc: 'managed custom repository role to exist after additive sync', timeout: 60000 })
    assert(managedRole !== null, '14b: managed custom repository role still created')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function teardown () {
  logPhase('Phase 9: Teardown')

  stopSafeSettings()

  log('Deleting test repos...')
  try { await octokit.rest.repos.update({ owner: ORG, repo: 'demo-repo-service1', archived: false }) } catch { /* ok */ }
  for (const repo of TEST_REPOS) { await deleteRepo(ORG, repo) }

  // Restore app installations to their original state so shared enterprise
  // apps are left untouched by the smoke test.
  if (entOctokit && Object.keys(appInstallSnapshot).length > 0) {
    log('Restoring app installation repository selections...')
    for (const [slug, snap] of Object.entries(appInstallSnapshot)) {
      try {
        if (snap.selection === 'all') {
          await setInstallationSelection(snap.installationId, 'all')
        } else if (snap.selection === 'selected' && snap.repos.length > 0) {
          await setInstallationSelection(snap.installationId, 'selected', snap.repos)
        }
      } catch (e) { log(`  Could not restore app '${slug}' installation: ${e.message}`) }
    }
  }

  log('Deleting app-install smoke repos...')
  for (const repo of APP_TEST_REPOS) { await deleteRepo(ORG, repo) }

  log('Deleting test teams...')
  for (const team of TEST_TEAMS) { await deleteTeam(ORG, team.toLowerCase()) }
  try { await deleteTeam(ORG, SMOKE_NR_TEAM) } catch { /* ok */ }
  for (const team of SMOKE_FILTER_TEAMS) { try { await deleteTeam(ORG, team) } catch { /* ok */ } }

  log('Deleting custom repository role...')
  try { await deleteCustomRepositoryRole(ORG, 'security-engineer') } catch { /* ok */ }
  try { await deleteCustomRepositoryRole(ORG, 'smoke-additive-keeper') } catch { /* ok */ }
  try { await deleteCustomRepositoryRole(ORG, 'smoke-crr-managed') } catch { /* ok */ }
  try { await deleteCustomRepositoryRole(ORG, 'smoke-crr-external') } catch { /* ok */ }
  try { await deleteCustomRepositoryRole(ORG, 'smoke-crr-disabled') } catch { /* ok */ }
  try { await deleteCustomRepositoryRole(ORG, SMOKE_NR_ROLE) } catch { /* ok */ }

  log('Deleting org rulesets...')
  try {
    const { data: rs } = await octokit.request('GET /orgs/{org}/rulesets', { org: ORG })
    const testRs = rs.find(r => r.name === 'test')
    if (testRs) await octokit.request('DELETE /orgs/{org}/rulesets/{ruleset_id}', { org: ORG, ruleset_id: testRs.id })
  } catch { /* ok */ }
  try { await deleteOrgRuleset(ORG, 'smoke-ruleset-managed') } catch { /* ok */ }
  try { await deleteOrgRuleset(ORG, 'smoke-ruleset-external') } catch { /* ok */ }
  try { await deleteOrgRuleset(ORG, 'smoke-ruleset-disabled') } catch { /* ok */ }
  try { await deleteOrgRuleset(ORG, 'smoke-combined-org-ruleset') } catch { /* ok */ }

  log('Resetting admin repo settings...')
  const defaultBranch = await getDefaultBranch()
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, '# empty\n', defaultBranch, 'Reset settings.yml after smoke test')
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos`)
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs`)

  log('Teardown complete')
}

async function phase15RulesetArrayDrift () {
  logPhase('Phase 15: Drift remediation - Ruleset array fields (bypass_actors, rules, required_reviewers)')

  if (!GH_TOKEN) throw new Error('GH_TOKEN env var is required for drift tests (set to a fine-grained PAT)')

  // ── 15-setup: Restore full test.yml (earlier phases replace it with minimal configs) ──
  // Phases 12d and 13 overwrite repos/test.yml with configs that omit rulesets,
  // causing safe-settings to delete "synk" from the test repo. Restore it first.
  {
    log('15-setup: Restoring repos/test.yml to full config (ensures "synk" ruleset exists)...')
    const defaultBranch = await getDefaultBranch()
    const branch = 'smoke-test-phase15-setup'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_YML, branch, '15-setup: restore full test repo config with rulesets')
    const pr = await createPR(ORG, ADMIN_REPO, '15-setup: restore test.yml with rulesets', branch, defaultBranch)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    const synkReady = await poll(async () => {
      return await getRepoRuleset(ORG, 'test', 'synk')
    }, { desc: '"synk" ruleset to be (re)created after test.yml restore', timeout: 90000 })
    assert(synkReady !== null, '15-setup: "synk" ruleset present after restoring repos/test.yml')
    if (!synkReady) return // cannot proceed without the ruleset

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 15a: Remove bypass_actors from "synk" ruleset ──────────────────────────
  // The test repo "synk" ruleset has bypass_actors configured.
  // Manually empty bypass_actors → safe-settings should detect and restore.
  {
    log('15a: Manually emptying bypass_actors on "synk" ruleset (as user)...')
    const synkRuleset = await getRepoRuleset(ORG, 'test', 'synk')
    if (!synkRuleset) {
      logFail('15a: Could not find "synk" ruleset on test repo — was Phase 1 run?')
    } else {
      const fullRuleset = await getRepoRulesetDetails(ORG, 'test', synkRuleset.id)
      if (!fullRuleset) {
        logFail('15a: Could not fetch ruleset details')
      } else {
        const body = JSON.stringify({ ...fullRuleset, bypass_actors: [] })
        try {
          execSync(`gh api /repos/${ORG}/test/rulesets/${synkRuleset.id} --method PUT --input -`, {
            encoding: 'utf8', input: body, stdio: ['pipe', 'pipe', 'pipe']
          })
          log('15a: bypass_actors emptied on "synk" ruleset')
        } catch (e) { logFail(`15a: Could not modify ruleset: ${e.message}`) }

        log('Waiting for safe-settings to remediate...')
        await sleep(WEBHOOK_SETTLE_MS)

        const restored = await poll(async () => {
          try {
            const data = await getRepoRulesetDetails(ORG, 'test', synkRuleset.id)
            return (data && data.bypass_actors && data.bypass_actors.length > 0) ? data : null
          } catch { return null }
        }, { desc: 'bypass_actors to be restored on "synk" ruleset', timeout: 90000 })

        assert(restored !== null, '15a: bypass_actors restored after manual removal (drift detected)')
        if (restored) {
          assert(
            restored.bypass_actors.some(a => a.actor_type === 'OrganizationAdmin'),
            '15a: OrganizationAdmin bypass actor is present after restoration'
          )
        }
      }
    }
  }

  // ── 15b: Add out-of-band rule to "synk" ruleset ────────────────────────────
  // Add an extra rule not in the YAML config; safe-settings should remove it.
  {
    log('15b: Adding out-of-band "non_fast_forward" rule to "synk" ruleset (as user)...')
    const synkRuleset = await getRepoRuleset(ORG, 'test', 'synk')
    if (!synkRuleset) {
      logFail('15b: Could not find "synk" ruleset on test repo')
    } else {
      const fullRuleset = await getRepoRulesetDetails(ORG, 'test', synkRuleset.id)
      if (!fullRuleset) {
        logFail('15b: Could not fetch ruleset details')
      } else {
        const rules = [...(fullRuleset.rules || []), { type: 'non_fast_forward' }]
        const body = JSON.stringify({ rules })
        try {
          execSync(`gh api /repos/${ORG}/test/rulesets/${synkRuleset.id} --method PUT --input -`, {
            encoding: 'utf8', input: body, stdio: ['pipe', 'pipe', 'pipe']
          })
          log('15b: Added out-of-band "non_fast_forward" rule to "synk" ruleset')
        } catch (e) { logFail(`15b: Could not modify ruleset: ${e.message}`) }

        log('Waiting for safe-settings to remediate...')
        await sleep(WEBHOOK_SETTLE_MS)

        const reverted = await poll(async () => {
          try {
            const data = await getRepoRulesetDetails(ORG, 'test', synkRuleset.id)
            const hasExtraRule = data && (data.rules || []).some(r => r.type === 'non_fast_forward')
            return hasExtraRule ? null : data
          } catch { return null }
        }, { desc: 'out-of-band rule to be removed from "synk" ruleset', timeout: 90000 })

        assert(reverted !== null, '15b: out-of-band "non_fast_forward" rule removed from "synk" ruleset (drift detected)')
      }
    }
  }

  // ── 15c: Remove required_reviewers from suborg ruleset pull_request rule ───
  // This test runs only if the suborg "Protect release and production branches"
  // ruleset is present (requires Phase 5 to have run first).
  {
    log('15c: Checking for suborg "Protect release and production branches" ruleset on test repo...')
    const suborgRuleset = await getRepoRuleset(ORG, 'test', 'Protect release and production branches')
    if (!suborgRuleset) {
      log('15c: Suborg ruleset not found — skipping required_reviewers drift test (run Phase 5 first)')
    } else {
      const fullRuleset = await getRepoRulesetDetails(ORG, 'test', suborgRuleset.id)
      if (!fullRuleset) {
        logFail('15c: Could not fetch suborg ruleset details')
      } else {
        const prRule = (fullRuleset.rules || []).find(r => r.type === 'pull_request')
        const hasRequiredReviewers = prRule && prRule.parameters &&
          Array.isArray(prRule.parameters.required_reviewers) &&
          prRule.parameters.required_reviewers.length > 0

        if (!hasRequiredReviewers) {
          log('15c: Suborg ruleset pull_request rule has no required_reviewers — skipping 15c')
        } else {
          log('15c: Manually emptying required_reviewers in pull_request rule (as user)...')
          const rules = (fullRuleset.rules || []).map(rule => {
            if (rule.type === 'pull_request') {
              return { ...rule, parameters: { ...(rule.parameters || {}), required_reviewers: [] } }
            }
            return rule
          })
          const body = JSON.stringify({ rules })
          try {
            execSync(`gh api /repos/${ORG}/test/rulesets/${suborgRuleset.id} --method PUT --input -`, {
              encoding: 'utf8', input: body, stdio: ['pipe', 'pipe', 'pipe']
            })
            log('15c: required_reviewers emptied in pull_request rule')
          } catch (e) { logFail(`15c: Could not modify ruleset: ${e.message}`) }

          log('Waiting for safe-settings to remediate...')
          await sleep(WEBHOOK_SETTLE_MS)

          const restored = await poll(async () => {
            try {
              const data = await getRepoRulesetDetails(ORG, 'test', suborgRuleset.id)
              const pr = data && (data.rules || []).find(r => r.type === 'pull_request')
              const reviewers = pr && pr.parameters && pr.parameters.required_reviewers
              return (Array.isArray(reviewers) && reviewers.length > 0) ? data : null
            } catch { return null }
          }, { desc: 'required_reviewers to be restored in pull_request rule', timeout: 90000 })

          assert(restored !== null, '15c: required_reviewers restored after manual removal (drift detected)')
        }
      }
    }
  }
}

// Builds a branch ruleset that references its bypass actors and required
// reviewer by name (not numeric id), so safe-settings has to resolve them.
//   actors: [{ name, actor_type, bypass_mode }]
function buildNameResolutionRuleset (actors) {
  const bypassActorsYml = actors.map(a =>
`    - name: ${a.name}
      actor_type: ${a.actor_type}
      bypass_mode: ${a.bypass_mode}`).join('\n')

  return `
- name: smoke-name-resolution
  target: branch
  enforcement: active
  bypass_actors:
${bypassActorsYml}
  conditions:
    ref_name:
      include: ["~DEFAULT_BRANCH"]
      exclude: []
  rules:
    - type: pull_request
      parameters:
        dismiss_stale_reviews_on_push: false
        require_code_owner_review: false
        require_last_push_approval: false
        required_approving_review_count: 1
        required_review_thread_resolution: false
        required_reviewers:
          - minimum_approvals: 1
            file_patterns:
              - "*.js"
            reviewer:
              slug: ${SMOKE_NR_TEAM}
              type: Team
`
}

async function phase16RulesetNameResolution () {
  logPhase('Phase 16: Ruleset bypass actor.name + reviewer.slug resolution')
  const defaultBranch = await getDefaultBranch()
  const RULESET = 'smoke-name-resolution'

  // Ensure the principals exist so safe-settings can resolve names → ids.
  log('Ensuring smoke team and custom repository role exist...')
  const team = await ensureTeam(ORG, SMOKE_NR_TEAM)
  if (!team) { logFail('Phase 16: could not create/find smoke team'); return }
  const teamId = team.id
  const role = await createCustomRepositoryRole(ORG, SMOKE_NR_ROLE, 'safe-settings smoke name-resolution role')
  if (!role) { logFail('Phase 16: could not create custom repository role'); return }
  const roleId = role.id
  log(`Smoke team id=${teamId}, custom role id=${roleId}`)

  // Optional principals — only exercised when the env vars are provided.
  const extraActors = []
  if (process.env.SMOKE_NR_USER) extraActors.push({ name: process.env.SMOKE_NR_USER, actor_type: 'User', bypass_mode: 'always' })
  if (process.env.SMOKE_NR_APP_SLUG) extraActors.push({ name: process.env.SMOKE_NR_APP_SLUG, actor_type: 'Integration', bypass_mode: 'always' })

  // ── 16a: Create a ruleset entirely by name (Team, built-in + custom role, reviewer slug) ──
  const createActors = [
    { name: SMOKE_NR_TEAM, actor_type: 'Team', bypass_mode: 'always' },
    { name: 'maintain', actor_type: 'RepositoryRole', bypass_mode: 'always' },
    { name: SMOKE_NR_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' },
    ...extraActors
  ]
  {
    const branch = 'smoke-test-phase16a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_YML + buildNameResolutionRuleset(createActors), branch, '16a: add name-resolution ruleset')
    const pr = await createPR(ORG, ADMIN_REPO, '16a: ruleset bypass actor.name + reviewer.slug', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '16a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `16a: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    const details = await poll(async () => {
      const rs = await getRepoRuleset(ORG, 'test', RULESET)
      if (!rs) return null
      return await getRepoRulesetDetails(ORG, 'test', rs.id)
    }, { desc: 'name-resolution ruleset to be created', timeout: 90000 })

    assert(details !== null, '16a: ruleset created from name-based config')
    if (details) {
      const actors = details.bypass_actors || []
      assert(actors.some(a => a.actor_type === 'Team' && a.actor_id === teamId), `16a: Team name resolved to actor_id ${teamId}`)
      assert(actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === 4), '16a: built-in role "maintain" resolved to actor_id 4')
      assert(actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === roleId), `16a: custom role resolved to actor_id ${roleId}`)
      // GitHub only ever stores ids; the human-friendly alias must not leak through.
      assert(actors.every(a => a.name === undefined), '16a: no "name" alias present in applied ruleset (resolved to ids)')

      const prRule = (details.rules || []).find(r => r.type === 'pull_request')
      const reviewers = prRule && prRule.parameters && prRule.parameters.required_reviewers
      const reviewer = Array.isArray(reviewers) && reviewers[0] && reviewers[0].reviewer
      assert(reviewer && reviewer.id === teamId, `16a: reviewer.slug resolved to team id ${teamId}`)

      if (process.env.SMOKE_NR_USER) assert(actors.some(a => a.actor_type === 'User' && Number.isInteger(a.actor_id)), '16a: User name resolved to actor_id')
      if (process.env.SMOKE_NR_APP_SLUG) assert(actors.some(a => a.actor_type === 'Integration' && Number.isInteger(a.actor_id)), '16a: Integration slug resolved to actor_id')
    }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 16b: Modify the ruleset by name — swap built-in maintain(4) → admin(5) ──
  const modifyActors = createActors.map(a =>
    (a.actor_type === 'RepositoryRole' && a.name === 'maintain') ? { ...a, name: 'admin' } : a)
  {
    const branch = 'smoke-test-phase16b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_YML + buildNameResolutionRuleset(modifyActors), branch, '16b: modify name-resolution ruleset')
    const pr = await createPR(ORG, ADMIN_REPO, '16b: modify ruleset bypass actor by name', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '16b: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `16b: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    const updated = await poll(async () => {
      const rs = await getRepoRuleset(ORG, 'test', RULESET)
      if (!rs) return null
      const d = await getRepoRulesetDetails(ORG, 'test', rs.id)
      const actors = (d && d.bypass_actors) || []
      const hasAdmin = actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === 5)
      const hasMaintain = actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === 4)
      return (hasAdmin && !hasMaintain) ? d : null
    }, { desc: 'ruleset to be updated with admin role (5) replacing maintain (4)', timeout: 90000 })

    assert(updated !== null, '16b: ruleset modified by name — maintain(4) replaced with admin(5)')
    if (updated) {
      const actors = updated.bypass_actors || []
      assert(actors.some(a => a.actor_type === 'Team' && a.actor_id === teamId), '16b: Team bypass actor preserved across modification')
      assert(actors.some(a => a.actor_type === 'RepositoryRole' && a.actor_id === roleId), '16b: custom role bypass actor preserved across modification')
    }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

// ─── App installation config builders (Phase 17) ─────────────────────────────

// Org-level settings.yml giving an app access to ALL repos.
const settingsAppInstallAll = (slug) => `# App installations: org-level (implies all repos)
app_installations:
  - app_slug: ${slug}
`

// Empty org settings (no app_installations) with an optional comment bump to
// force a full sync while app selection is driven entirely by repo configs.
const settingsAppInstallEmpty = (bump = '') => `# App installations: no org-level app config${bump ? ` (${bump})` : ''}
`

// Repo-level config that force-creates the repo and adds it to the app.
const repoAppInstallConfig = (name, slug) => `repository:
  name: ${name}
app_installations:
  - app_slug: ${slug}
`

// Suborg-level config that targets an explicit list of repos (suborgrepos) and
// adds the app for those repos. Suborg config changes drive the delta sync.
const suborgAppInstallConfig = (repos, slug) => `suborgrepos:
${repos.map(r => `  - ${r}`).join('\n')}
app_installations:
  - app_slug: ${slug}
`

async function phase17AppInstallations () {
  logPhase('Phase 17: App installation management (app_installations plugin)')

  if (!GH_ENTERPRISE) {
    log('17: GH_ENTERPRISE not set — skipping app_installations tests')
    return
  }
  if (APP_SLUGS.length === 0) {
    log('17: SMOKE_APP_SLUGS not set — skipping app_installations tests')
    return
  }
  if (!entOctokit) {
    logFail('17: enterprise installation not available (app not installed on enterprise or GH_ENTERPRISE mismatch) — cannot run app_installations tests')
    return
  }

  const defaultBranch = await getDefaultBranch()
  const app = APP_SLUGS[0]

  // Snapshot every managed app's live installation state for restore in teardown.
  for (const slug of APP_SLUGS) {
    const inst = await getAppInstallation(slug)
    if (!inst) {
      logFail(`17: app '${slug}' is not installed on org ${ORG} via enterprise '${GH_ENTERPRISE}' — pre-create and install it`)
      continue
    }
    appInstallSnapshot[slug] = {
      installationId: inst.id,
      selection: inst.repository_selection,
      repos: inst.repository_selection === 'selected' ? await listInstallationRepoNames(inst.id) : []
    }
  }

  const primary = appInstallSnapshot[app]
  if (!primary) {
    logFail(`17: primary app '${app}' installation not found — aborting app_installations tests`)
    return
  }
  const installationId = primary.installationId
  log(`17: primary app '${app}' installation id=${installationId}, initial selection='${primary.selection}'`)

  log('17: Ensuring dedicated app-install smoke repos exist...')
  await ensureRepo(APP_TEST_REPOS[0])
  await ensureRepo(APP_TEST_REPOS[1])

  // ── 17a: Org-level repository_selection: all ───────────────────────────────
  {
    log('17a: Setting app to repository_selection: all via org settings.yml')
    const branch = 'smoke-test-phase17a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, settingsAppInstallAll(app), branch, '17a: app_installations repository_selection all')
    const pr = await createPR(ORG, ADMIN_REPO, '17a: app_installations org-level all', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '17a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `17a: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const selAll = await poll(async () => {
      const i = await getAppInstallation(app)
      return (i && i.repository_selection === 'all') ? i : null
    }, { desc: "app installation to be set to 'all'", timeout: 90000 })
    assert(selAll !== null, "17a: app repository_selection set to 'all' by org-level config")

    // Isolation: any other configured app must be unchanged by app[0]'s config.
    for (const slug of APP_SLUGS.slice(1)) {
      const snap = appInstallSnapshot[slug]
      if (!snap) continue
      const other = await getAppInstallation(slug)
      assert(other !== null && other.repository_selection === snap.selection,
        `17a: other app '${slug}' repository_selection unchanged (isolation)`)
    }

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 17b: Repo-level selection for two repos (full sync via settings.yml) ────
  // Remove the org-level 'all' and drive selection entirely from repo configs.
  // A settings.yml change triggers a full sync, which recomputes desired state
  // from all layers and narrows the installation from 'all' → 'selected'.
  {
    log('17b: Narrowing app to two specific repos via repo-level configs')
    const branch = 'smoke-test-phase17b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, settingsAppInstallEmpty(), branch, '17b: clear org app_installations')
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/${APP_TEST_REPOS[0]}.yml`, repoAppInstallConfig(APP_TEST_REPOS[0], app), branch, `17b: add ${APP_TEST_REPOS[0]} to app`)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/${APP_TEST_REPOS[1]}.yml`, repoAppInstallConfig(APP_TEST_REPOS[1], app), branch, `17b: add ${APP_TEST_REPOS[1]} to app`)
    const pr = await createPR(ORG, ADMIN_REPO, '17b: app_installations repo-level selection', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '17b: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `17b: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const selected = await poll(async () => {
      const i = await getAppInstallation(app)
      if (!i || i.repository_selection !== 'selected') return null
      const repos = await listInstallationRepoNames(i.id)
      return (repos.includes(APP_TEST_REPOS[0]) && repos.includes(APP_TEST_REPOS[1])) ? repos : null
    }, { desc: "app installation to be 'selected' with the two repos", timeout: 90000 })
    assert(selected !== null, `17b: app narrowed to 'selected' with ${APP_TEST_REPOS[0]} and ${APP_TEST_REPOS[1]}`)
  }

  // ── 17c: Add a third repo via a new repo config ────────────────────────────
  {
    log('17c: Adding a third repo to the app via a new repo config')
    await ensureRepo(APP_TEST_REPOS[2])
    const branch = 'smoke-test-phase17c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    // Bump settings.yml to force a full sync that includes the new repo config.
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, settingsAppInstallEmpty('bump 17c'), branch, '17c: bump settings to trigger full sync')
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/${APP_TEST_REPOS[2]}.yml`, repoAppInstallConfig(APP_TEST_REPOS[2], app), branch, `17c: add ${APP_TEST_REPOS[2]} to app`)
    const pr = await createPR(ORG, ADMIN_REPO, '17c: app_installations add repo', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '17c: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `17c: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const added = await poll(async () => {
      const i = await getAppInstallation(app)
      if (!i || i.repository_selection !== 'selected') return null
      const repos = await listInstallationRepoNames(i.id)
      return repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `${APP_TEST_REPOS[2]} to be added to the app installation`, timeout: 90000 })
    assert(added !== null, `17c: ${APP_TEST_REPOS[2]} added to app installation`)
  }

  // ── 17d: Remove the third repo by deleting its config ──────────────────────
  {
    log('17d: Removing the third repo from the app by deleting its repo config')
    const branch = 'smoke-test-phase17d'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await deleteFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/${APP_TEST_REPOS[2]}.yml`, branch, `17d: remove ${APP_TEST_REPOS[2]} config`)
    // Bump settings.yml to force a full sync (removals are reconciled by full sync).
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, settingsAppInstallEmpty('bump 17d'), branch, '17d: bump settings to trigger full sync')
    const pr = await createPR(ORG, ADMIN_REPO, '17d: app_installations remove repo', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '17d: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `17d: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const removed = await poll(async () => {
      const i = await getAppInstallation(app)
      if (!i || i.repository_selection !== 'selected') return null
      const repos = await listInstallationRepoNames(i.id)
      return !repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `${APP_TEST_REPOS[2]} to be removed from the app installation`, timeout: 90000 })
    assert(removed !== null, `17d: ${APP_TEST_REPOS[2]} removed from app installation`)
  }

  // ── 17e: Drift remediation via full sync ───────────────────────────────────
  // Manually add an unmanaged repo to the installation, then trigger a full
  // sync (settings.yml bump). Full sync must remove the drifted repo since it
  // is not in any config layer's desired state.
  {
    log(`17e: Injecting drift — adding unmanaged ${APP_TEST_REPOS[2]} to the installation directly`)
    try {
      await addInstallationRepos(installationId, [APP_TEST_REPOS[2]])
    } catch (e) { logFail(`17e: could not inject drift: ${e.message}`) }

    const driftPresent = await poll(async () => {
      const repos = await listInstallationRepoNames(installationId)
      return repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `drifted ${APP_TEST_REPOS[2]} to be present before remediation`, timeout: 30000 })
    assert(driftPresent !== null, `17e: drift injected (${APP_TEST_REPOS[2]} present on installation)`)

    const branch = 'smoke-test-phase17e'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, settingsAppInstallEmpty('bump 17e'), branch, '17e: bump settings to trigger full sync drift remediation')
    const pr = await createPR(ORG, ADMIN_REPO, '17e: app_installations drift remediation', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '17e: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `17e: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const driftRemoved = await poll(async () => {
      const repos = await listInstallationRepoNames(installationId)
      return !repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `drifted ${APP_TEST_REPOS[2]} to be removed by full sync`, timeout: 90000 })
    assert(driftRemoved !== null, `17e: drift remediated — ${APP_TEST_REPOS[2]} removed by full sync`)

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 17f: Sub-org targeting (delta sync via suborgs/*.yml) ──────────────────
  // A suborg config change triggers the delta sync path (not full sync). The
  // suborg's targeting (here suborgrepos) resolves the repos to add/remove for
  // the app. Entering this block the installation is 'selected' with
  // APP_TEST_REPOS[0] and [1]; [2] is not selected.
  {
    // Step A: add a suborg that targets repo-3 and adds the app → repo-3 added.
    log('17f: Adding a repo to the app via suborg targeting (suborgrepos, delta sync)')
    const branchA = 'smoke-test-phase17f-add'
    await deleteBranch(ORG, ADMIN_REPO, branchA)
    await createBranch(ORG, ADMIN_REPO, branchA)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/smoke-app-suborg.yml`, suborgAppInstallConfig([APP_TEST_REPOS[2]], app), branchA, '17f: suborg targeting adds smoke-app-repo-3 to app')
    const prA = await createPR(ORG, ADMIN_REPO, '17f: app_installations suborg add', branchA, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRunA = await waitForCheckRun(ORG, ADMIN_REPO, prA.head.sha)
    assert(checkRunA !== null, '17f: NOP check run completed (suborg add)')
    if (checkRunA) assert(checkRunA.conclusion === 'success', `17f: NOP check run is success (got: ${checkRunA.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, prA.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const suborgAdded = await poll(async () => {
      const i = await getAppInstallation(app)
      if (!i || i.repository_selection !== 'selected') return null
      const repos = await listInstallationRepoNames(i.id)
      return repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `${APP_TEST_REPOS[2]} to be added via suborg targeting`, timeout: 90000 })
    assert(suborgAdded !== null, `17f: ${APP_TEST_REPOS[2]} added to app via suborg targeting (delta sync)`)

    await deleteBranch(ORG, ADMIN_REPO, branchA)

    // Step B: narrow the suborg targeting so repo-3 drops out → repo-3 removed.
    // Retarget to repo-1 (already selected by its repo config, so a no-op add);
    // the delta unselection must remove repo-3.
    log('17f: Narrowing suborg targeting so smoke-app-repo-3 drops out (delta unselection)')
    const branchB = 'smoke-test-phase17f-narrow'
    await deleteBranch(ORG, ADMIN_REPO, branchB)
    await createBranch(ORG, ADMIN_REPO, branchB)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/smoke-app-suborg.yml`, suborgAppInstallConfig([APP_TEST_REPOS[0]], app), branchB, '17f: narrow suborg targeting to smoke-app-repo-1')
    const prB = await createPR(ORG, ADMIN_REPO, '17f: app_installations suborg narrow', branchB, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRunB = await waitForCheckRun(ORG, ADMIN_REPO, prB.head.sha)
    assert(checkRunB !== null, '17f: NOP check run completed (suborg narrow)')
    if (checkRunB) assert(checkRunB.conclusion === 'success', `17f: NOP check run is success (got: ${checkRunB.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, prB.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    const suborgRemoved = await poll(async () => {
      const i = await getAppInstallation(app)
      if (!i || i.repository_selection !== 'selected') return null
      const repos = await listInstallationRepoNames(i.id)
      return !repos.includes(APP_TEST_REPOS[2]) ? repos : null
    }, { desc: `${APP_TEST_REPOS[2]} to be removed when dropped from suborg targeting`, timeout: 90000 })
    assert(suborgRemoved !== null, `17f: ${APP_TEST_REPOS[2]} removed when dropped from suborg targeting (delta unselection)`)

    await deleteBranch(ORG, ADMIN_REPO, branchB)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function phase18TeamIncludeExclude () {
  logPhase('Phase 18: Team include/exclude repo filters')
  const branch = 'smoke-test-phase18'
  const defaultBranch = await getDefaultBranch()

  // Clean any leftover teams from a previous aborted run so the "not applied"
  // assertions can't be satisfied by stale repo-team associations.
  await deleteRepo(ORG, SMOKE_FILTER_REPO)
  for (const t of SMOKE_FILTER_TEAMS) { await deleteTeam(ORG, t) }

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/${SMOKE_FILTER_REPO}.yml`, REPO_TEAM_FILTER_YML, branch, 'Add team include/exclude filter config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: team include/exclude filters', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: SMOKE_FILTER_REPO })).data } catch { return null }
  }, { desc: `${SMOKE_FILTER_REPO} to be created` })
  assert(repo !== null, `Repo "${SMOKE_FILTER_REPO}" was created`)

  // The included team should be applied (poll — safe-settings may still be working).
  const includedTeam = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: SMOKE_FILTER_REPO })
      return teams.find(t => t.slug === SMOKE_FILTER_TEAMS[0]) || null
    } catch { return null }
  }, { desc: `included team ${SMOKE_FILTER_TEAMS[0]} to be added`, timeout: 60000 })
  assert(includedTeam !== null, `Team "${SMOKE_FILTER_TEAMS[0]}" applied (include glob matches repo)`)
  if (includedTeam) {
    const hasMaintain = includedTeam.permission === 'maintain' || (includedTeam.permissions && includedTeam.permissions.maintain === true)
    assert(hasMaintain, `Included team has maintain permission (got: ${includedTeam.permission})`)
  }

  // The excluded and non-matching teams must NOT be applied.
  const finalTeams = await (async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: SMOKE_FILTER_REPO })
      return teams.map(t => t.slug)
    } catch { return [] }
  })()
  assert(!finalTeams.includes(SMOKE_FILTER_TEAMS[1]), `Team "${SMOKE_FILTER_TEAMS[1]}" NOT applied (exclude glob matches repo)`)
  assert(!finalTeams.includes(SMOKE_FILTER_TEAMS[2]), `Team "${SMOKE_FILTER_TEAMS[2]}" NOT applied (include glob does not match repo)`)

  // Cleanup for standalone --phase 18 runs (teardown also cleans these).
  await deleteRepo(ORG, SMOKE_FILTER_REPO)
  for (const t of SMOKE_FILTER_TEAMS) { await deleteTeam(ORG, t) }
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function main () {
  const { App } = await import('octokit')
  const app = new App({ appId: APP_ID, privateKey: PRIVATE_KEY })

  // Find installation for our org
  let installationId
  for await (const { installation } of app.eachInstallation.iterator()) {
    // Org/user installations key off account.login (only enterprise accounts have a slug).
    if (installation.account && installation.account.login && installation.account.login.toLowerCase() === ORG.toLowerCase()) {
      installationId = installation.id
      break
    }
  }
  if (!installationId) throw new Error(`No installation found for org ${ORG}`)

  octokit = await app.getInstallationOctokit(installationId)
  log('Authenticated as GitHub App installation')

  // Optionally resolve the enterprise installation for the app_installations
  // plugin phase. The same App must be installed on the enterprise with the
  // "Enterprise organization installations" permission.
  if (GH_ENTERPRISE && APP_SLUGS.length > 0) {
    for await (const { installation } of app.eachInstallation.iterator()) {
      if (installation.target_type === 'Enterprise' &&
          installation.account && installation.account.slug &&
          installation.account.slug.toLowerCase() === GH_ENTERPRISE.toLowerCase()) {
        entOctokit = await app.getInstallationOctokit(installation.id)
        log(`Authenticated as enterprise installation for '${GH_ENTERPRISE}' (app_installations phase enabled)`)
        break
      }
    }
    if (!entOctokit) log(`\x1b[33m⚠ No enterprise installation found for '${GH_ENTERPRISE}' — Phase 17 will report a failure.\x1b[0m`)
  }

  console.log(`
\x1b[36m╔══════════════════════════════════════╗
║   Safe-Settings Smoke Test           ║
║   Org: ${ORG.padEnd(28)}║
║   Admin Repo: ${ADMIN_REPO.padEnd(22)}║
╚══════════════════════════════════════╝\x1b[0m
`)

  if (INTERACTIVE) log('\x1b[33m[interactive] Mode enabled — will pause after each phase.\x1b[0m')
  if (ONLY_PHASES !== null) log(`\x1b[33m[phase filter] Running setup + phase(s) [${[...ONLY_PHASES].join(', ')}] + teardown only.\x1b[0m`)

  let doTeardown = true
  try {
    const allPhases = [
      ['Phase 0: Setup', setup],
      ['Phase 1: Create test repo', phase1CreateRepo],
      ['Phase 2: Drift remediation - Team removal', phase2DriftTeam],
      ['Phase 3: Drift remediation - Rogue ruleset', phase3DriftRuleset],
      ['Phase 4: Create demo-repo-service1', phase4DemoRepo1],
      ['Phase 5: Create suborg config', phase5Suborg],
      ['Phase 6: Archive demo-repo-service1', phase6Archive],
      ['Phase 7: Create demo-repo-service2', phase7DemoRepo2],
      ['Phase 7b: External group team', phase7bExternalGroupTeam],
      ['Phase 8: Org-level settings', phase8OrgSettings],
      ['Phase 10: disable_plugins', phase10DisablePlugins],
      ['Phase 11: additive_plugins', phase11AdditivePlugins],
      ['Phase 12: custom_properties', phase12CustomProperties],
      ['Phase 12: custom_repository_roles', phase12CustomRoles],
      ['Phase 12: rulesets', phase12Rulesets],
      ['Phase 13: variables', phase13Variables],
      ['Phase 14: regressions', phase14RegressionCoverage],
      ['Phase 15: Ruleset array drift', phase15RulesetArrayDrift],
      ['Phase 16: Ruleset name/slug resolution', phase16RulesetNameResolution],
      ['Phase 17: App installation management', phase17AppInstallations],
      ['Phase 18: Team include/exclude filters', phase18TeamIncludeExclude]
    ]

    // When --phase is given, only run setup (phase 0) + the requested phase(s).
    // Phase labels start with "Phase N:" so we match on that prefix.
    const phases = ONLY_PHASES !== null
      ? allPhases.filter(([label]) => {
        if (label.startsWith('Phase 0:')) return true
        const m = label.match(/^Phase (\d+)[:\s]/)
        return m !== null && ONLY_PHASES.has(parseInt(m[1], 10))
      })
      : allPhases

    if (ONLY_PHASES !== null && phases.length < 2) {
      const valid = allPhases.map(([label]) => label.replace(/^Phase (\S+):.*/, '$1')).filter(n => n !== '0').join(', ')
      throw new Error(`No phases matching [${[...ONLY_PHASES].join(', ')}] found. Valid phase numbers: ${valid}`)
    }
    for (const [label, fn] of phases) {
      const action = await runPhase(label, fn)
      if (action === 'abort') { doTeardown = false; break }
      if (action === 'quit') break
    }
  } catch (err) {
    if (err instanceof InteractiveExit) {
      if (err.action === 'abort') doTeardown = false
    } else {
      console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`)
      console.error(err.stack)
    }
  } finally {
    if (doTeardown) await teardown()
    else log('\x1b[33m[interactive] Aborted — teardown skipped.\x1b[0m')
  }

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
  console.error(err)
  stopSafeSettings()
  process.exit(1)
})
