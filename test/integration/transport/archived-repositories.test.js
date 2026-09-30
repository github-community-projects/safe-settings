const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const Settings = require('../../../lib/settings')

const repo = { owner: 'test-org', repo: 'archived-fixture' }
const repoPath = `/repos/${repo.owner}/${repo.repo}`
const label = { name: 'archive-regression', color: 'abcdef', description: 'managed' }

async function fixture ({ archived = true, metadata = archived, repository = { description: 'desired' }, nop = false, smokeLifecycle = false } = {}) {
  const target = smokeLifecycle ? { ...repo, repo: 'smoke-archived-repo' } : repo
  const repoPath = `/repos/${target.owner}/${target.repo}`
  const { Octokit } = await import('octokit')
  const requests = []
  const errors = []
  const live = { name: target.repo, owner: { login: target.owner }, archived, description: 'before', topics: [] }
  const labels = []
  let exists = !smokeLifecycle
  const log = { debug () {}, info () {}, warn () {}, error: message => errors.push(message) }
  // Exercise real Octokit serialization/pagination and real plugins without
  // credentials or network. Writes deliberately succeed even while archived:
  // a missing guard must fail the request assertions, not an incomplete mock.
  const github = new Octokit({
    auth: 'test-token',
    log,
    retry: { enabled: false },
    throttle: { enabled: false },
    request: {
      fetch: async (url, options) => {
        const path = new URL(url).pathname
        const method = options.method
        const body = options.body ? JSON.parse(options.body) : undefined
        requests.push({ method, path, query: new URL(url).search, body })
        let data
        let status = 200
        if (method === 'GET' && path === '/installation/repositories') {
          data = { total_count: 1, repositories: [{ ...live, archived: smokeLifecycle ? live.archived : metadata }] }
        } else if (method === 'GET' && path === repoPath) {
          data = exists ? live : { message: 'Not Found' }
          status = exists ? 200 : 404
        } else if (smokeLifecycle && method === 'POST' && path === `/orgs/${target.owner}/repos`) {
          exists = true
          data = live
        } else if (smokeLifecycle && method === 'DELETE' && path === repoPath) {
          exists = false
          data = {}
        } else if (method === 'PATCH' && path === repoPath) {
          Object.assign(live, body)
          if (Object.hasOwn(body, 'archived')) live.archived = body.archived === true || body.archived === 'true'
          data = live
        } else if (method === 'GET' && path === `${repoPath}/labels`) {
          data = labels
        } else if (method === 'POST' && path === `${repoPath}/labels`) {
          labels.push(body)
          data = body
        } else if (smokeLifecycle && method === 'GET' && path.startsWith(`${repoPath}/labels/`)) {
          data = labels.find(label => path.endsWith(`/${label.name}`))
        } else {
          throw new Error(`Unexpected request: ${method} ${url}`)
        }
        const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
        Object.defineProperty(response, 'url', { value: String(url) })
        return response
      }
    }
  })
  const config = { restrictedRepos: {}, labels: [label] }
  if (repository !== null) config.repository = repository
  const settings = new Settings(nop, {
    payload: { installation: { id: 7 } },
    octokit: github,
    log
  }, { owner: repo.owner, repo: 'admin' }, config, 'main')
  settings.subOrgConfigs = {}
  settings.repoConfigs = {}
  const sync = async () => {
    await settings.eachRepositoryRepos(github, log)
    assert.deepEqual(settings.errors, [])
    assert.deepEqual(errors, [])
    assert.deepEqual([...settings.processedRepoNames], [repo.repo])
  }
  const writes = () => requests.filter(request => request.method !== 'GET')
  return { settings, github, log, requests, writes, live, labels, sync, errors, exists: () => exists }
}

for (const nop of [false, true]) {
  for (const repository of [null, {}, { archived: true }, { archived: 'true' }]) {
    test(`listing: archived ${JSON.stringify(repository)} skips every per-repo request (nop=${nop})`, async () => {
      const f = await fixture({ repository, nop })
      await f.sync()
      assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [['GET', '/installation/repositories']])
      assert.deepEqual(f.settings.results, [])
    })
  }
}

for (const metadata of [false, undefined]) {
  test(`listing metadata ${metadata} keeps live archive-state fallback`, async () => {
    const f = await fixture({ metadata: false })
    // Explicitly distinguish absent listing metadata from the default.
    f.settings.github.hook.after('request', response => {
      if (response.data.repositories && metadata === undefined) delete response.data.repositories[0].archived
    })
    await f.sync()
    assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [
      ['GET', '/installation/repositories'], ['GET', repoPath]
    ])
    assert.deepEqual(f.writes(), [])
  })
}

for (const repository of [null, {}]) {
  test(`unknown-state single repo guards ${repository === null ? 'labels-only' : 'repository'} path`, async () => {
    const f = await fixture({ repository })
    await f.settings.updateRepos(repo)
    assert.deepEqual(f.requests.map(({ method, path }) => [method, path]), [['GET', repoPath]])
    assert.deepEqual(f.settings.errors, [])
    assert.deepEqual(f.errors, [])
  })
}

test('labels-only known-active listing adds no archive lookup and really writes labels', async () => {
  const f = await fixture({ archived: false, repository: null })
  await f.sync()
  // Labels.find has its own repo GET; no additional Archive.getState GET.
  assert.equal(f.requests.filter(r => r.path === repoPath).length, 1)
  assert.deepEqual(f.writes().map(({ method, path, body }) => [method, path, body]), [
    ['POST', `${repoPath}/labels`, label]
  ])
})

test('labels-only unknown active state performs fallback then runs the real child plugin', async () => {
  const f = await fixture({ archived: false, repository: null })
  await f.settings.updateRepos(repo)
  assert.equal(f.requests.filter(r => r.path === repoPath).length, 2)
  assert.equal(f.writes().length, 1)
  assert.deepEqual(f.errors, [])
})

for (const desired of [false, 'false']) {
  test(`explicit archived:${desired} unarchives before repository/child writes without metadata leakage`, async () => {
    const f = await fixture({ repository: { archived: desired, description: 'desired' } })
    await f.sync()
    const writes = f.writes()
    assert.deepEqual(writes.map(({ method, path }) => [method, path]), [
      ['PATCH', repoPath], ['PATCH', repoPath], ['POST', `${repoPath}/labels`]
    ])
    assert.deepEqual(writes[0].body, { archived: false })
    assert.equal(writes[1].body.description, 'desired')
    assert.equal(writes.some(r => r.body.archived === true), false)
    assert.equal(f.requests.filter(r => r.method === 'GET' && r.path === repoPath).every(r => r.query === ''), true)
    assert.equal(f.live.archived, false)
    assert.deepEqual(f.labels, [label])
    assert.equal(Object.hasOwn(repo, 'archived'), false)
  })
}

test('explicit unarchive NOP reports archive, repository and child changes without writing', async () => {
  const f = await fixture({ nop: true, repository: { archived: false, description: 'desired' } })
  await f.sync()
  assert.deepEqual(f.writes(), [])
  assert.equal(f.live.archived, true)
  assert.deepEqual([...new Set(f.settings.results.map(row => row.plugin))].sort(), ['Archive', 'Labels', 'Repository'])
})

test('active repository changes and child writes precede archive', async () => {
  const f = await fixture({ archived: false, repository: { archived: true } })
  await f.sync()
  assert.deepEqual(f.writes().map(({ method, path }) => [method, path]), [
    ['POST', `${repoPath}/labels`], ['PATCH', repoPath]
  ])
  assert.deepEqual(f.writes().at(-1).body, { archived: true })
})

for (const [org, suborg, override, expectedSkip] of [
  [true, false, undefined, false],
  [false, true, undefined, true],
  [true, true, false, false],
  [false, false, true, true]
]) {
  test(`config precedence org=${org}, suborg=${suborg}, repo=${override} is resolved before skipping`, async () => {
    const f = await fixture({ repository: { archived: org } })
    f.settings.subOrgConfigs = { 'archived-*': { repository: { archived: suborg } } }
    if (override !== undefined) f.settings.repoConfigs = { [`${repo.repo}.yaml`]: { repository: { archived: override } } }
    await f.sync()
    if (expectedSkip) assert.equal(f.requests.length, 1)
    else assert.deepEqual(f.writes()[0].body, { archived: false })
  })
}

test('known-archived repo cannot be unarchived when the archive plugin is disabled', async () => {
  const f = await fixture({ repository: { archived: false } })
  f.settings.config.disable_plugins = ['archive']
  await f.sync()
  assert.equal(f.requests.length, 1)
})

test('disabling archive preserves active-repo updates without the archive state lookup', async () => {
  const f = await fixture({ archived: false })
  f.settings.config.disable_plugins = ['archive']
  await f.sync()
  assert.equal(f.requests.filter(r => r.path === repoPath && r.method === 'GET').length, 2)
  assert.equal(f.writes().length, 2)
})

test('repository restrictions and suborg selection still skip without any per-repo request', async () => {
  for (const selection of ['restricted', 'suborg']) {
    const f = await fixture({ repository: { archived: false } })
    if (selection === 'restricted') f.settings.config.restrictedRepos = { exclude: [repo.repo] }
    else f.settings.subOrgConfigMap = ['other-suborg']
    await f.sync()
    assert.equal(f.requests.length, 1)
  }
})

test('maintained phase 25 executes its complete lifecycle against real Settings and Octokit offline', async () => {
  const f = await fixture({ smokeLifecycle: true, archived: false })
  const source = fs.readFileSync(require.resolve('../../../smoke-test'), 'utf8')
  const phaseSource = source.slice(source.indexOf('async function phase25ArchivedRepositories ('), source.indexOf('\nasync function phase23ConfigLoading ('))
  const messages = []
  const failures = []
  const assertions = []
  const phase = vm.runInNewContext(`${phaseSource}\nphase25ArchivedRepositories`, {
    require: name => {
      assert.equal(name, './lib/settings')
      return Settings
    },
    process: { env: { GH_ORG: repo.owner } },
    ORG: repo.owner,
    ADMIN_REPO: 'admin',
    orgInstallation: { id: 7, target_type: 'Organization', account: { login: repo.owner } },
    octokit: f.github,
    URL,
    log: message => messages.push(message),
    logPhase () {},
    logFail: message => failures.push(message),
    assert: (condition, message) => {
      assertions.push(message)
      assert.ok(condition, message)
      return true
    }
  })
  await phase()
  assert.deepEqual(failures, [])
  assert.ok(assertions.length >= 30)
  assert.ok(messages.includes('Phase 25 complete'))
  assert.ok(messages.includes('Phase 25 owned fixture removed'))
  assert.equal(f.exists(), false)
})
