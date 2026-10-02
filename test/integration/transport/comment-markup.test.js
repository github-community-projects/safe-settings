const assert = require('node:assert/strict')
const { test, beforeEach, afterEach } = require('node:test')
const { generateKeyPairSync } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const nock = require('nock')
const Settings = require('../../../lib/settings')
const NopCommand = require('../../../lib/nopcommand')
const env = require('../../../lib/env')
const { main } = require('../../live/comment-markup')

const apiUrl = 'https://api.github.com'
const target = { owner: 'test-org', repo: 'report-repo' }
const installation = { id: 99, app_id: 9, target_type: 'Organization', account: { login: target.owner } }
let originalCommentSetting

beforeEach(() => {
  nock.disableNetConnect()
  originalCommentSetting = env.CREATE_PR_COMMENT
  env.CREATE_PR_COMMENT = 'true'
})

afterEach(() => {
  try {
    assert(nock.isDone(), `Unconsumed HTTP fixtures: ${nock.pendingMocks().join(', ')}`)
  } finally {
    nock.cleanAll()
    nock.enableNetConnect()
    env.CREATE_PR_COMMENT = originalCommentSetting
  }
})

async function reporter (results) {
  const { Octokit } = await import('octokit')
  const octokit = new Octokit({
    auth: 'offline-token',
    retry: { enabled: false },
    throttle: { enabled: false },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
  const settings = new Settings(true, {
    payload: {
      installation: { id: installation.id },
      repository: { owner: { login: target.owner }, name: target.repo },
      check_run: { id: 42, check_suite: { pull_requests: [{ number: 7 }] } }
    },
    octokit,
    log: { debug () {}, info () {}, error: message => { throw new Error(message) } }
  }, target, {}, 'main')
  settings.results = results
  return settings
}

function change () {
  return new NopCommand('Repository', target, null, {
    additions: {}, deletions: { description: 'before' }, modifications: { description: 'after' }
  })
}

for (const kind of ['change', 'error', 'mixed', 'empty']) {
  test(`real Octokit posts ${kind} report bodies and completes the check`, async () => {
    const failure = new NopCommand('Repository', target, null, 'fixture failure', 'ERROR')
    const results = {
      change: [change()], error: [failure], mixed: [change(), failure], empty: []
    }[kind]
    const requests = []
    const scope = nock(apiUrl, { reqheaders: { authorization: 'token offline-token' } })
      .post('/repos/test-org/report-repo/issues/7/comments')
      .reply((_uri, body) => { requests.push({ method: 'POST', body }); return [201, { id: 100, ...body }] })
      .patch('/repos/test-org/report-repo/check-runs/42')
      .reply((_uri, body) => { requests.push({ method: 'PATCH', body }); return [200, { id: 42, ...body }] })

    await (await reporter(results)).handleResults()

    assert(scope.isDone())
    assert.deepEqual(requests.map(request => request.method), ['POST', 'PATCH'])
    const [comment, check] = requests.map(request => request.body)
    assert.equal(check.status, 'completed')
    assert.equal(check.conclusion, ['error', 'mixed'].includes(kind) ? 'failure' : 'success')
    assert(!Number.isNaN(Date.parse(check.completed_at)))
    for (const body of [comment.body, check.output.summary]) {
      assert(body.length <= 55536)
      assert.doesNotMatch(body, /<\/td>\s*<tr>|<tr>\s*<\/tr>/)
      if (kind === 'change' || kind === 'mixed') {
        assert.match(body, /<summary>Repository[^<]*1 repo, 1 setting changed<\/summary>/)
        assert(body.includes('- before: `before`\n    - after: `after`'))
      }
      if (kind === 'error' || kind === 'mixed') assert(body.includes('* fixture failure'))
      if (kind === 'empty') assert(body.includes('No changes to apply.'))
    }
  })
}

test('real Octokit posts each bounded page before completing a large report', async () => {
  const fields = Object.fromEntries(Array.from({ length: 220 }, (_, index) => [`field-${index}`, 'x'.repeat(160)]))
  const results = ['First', 'Second', 'Third'].map(plugin =>
    new NopCommand(plugin, target, null, { additions: fields, deletions: {}, modifications: {} })
  )
  const requests = []
  nock(apiUrl)
    .post('/repos/test-org/report-repo/issues/7/comments').times(3)
    .reply((_uri, body) => { requests.push(body); return [201, { id: requests.length, ...body }] })
    .patch('/repos/test-org/report-repo/check-runs/42')
    .reply((_uri, body) => { requests.push(body); return [200, { id: 42, ...body }] })

  await (await reporter(results)).handleResults()

  assert.equal(requests.length, 4)
  requests.slice(0, 3).forEach(({ body }, index) => {
    assert(body.includes(`config changes detected (${index + 1}/3)`))
    assert.equal((body.match(/`field-\d+`/g) || []).length, 220)
    assert.equal((body.match(/<details>/g) || []).length, 1)
    assert.equal((body.match(/<\/details>/g) || []).length, 1)
    assert(body.length <= 55536)
  })
  assert.equal(requests[3].conclusion, 'success')
  assert(requests[3].output.summary.includes('Detailed changed-field output is available in the pull request comment.'))
})

test('comments-disabled mode sends only a completed check', async () => {
  env.CREATE_PR_COMMENT = 'false'
  let output
  nock(apiUrl).patch('/repos/test-org/report-repo/check-runs/42')
    .reply((_uri, body) => { output = body.output; return [200, {}] })

  await (await reporter([change()])).handleResults()

  assert(output.summary.includes('`description`'))
})

for (const failure of ['comment', 'check']) {
  test(`real transport propagates ${failure} failure instead of reporting success`, async () => {
    const scope = nock(apiUrl).post('/repos/test-org/report-repo/issues/7/comments')
    if (failure === 'comment') {
      scope.reply(422, { message: 'Comment rejected' })
    } else {
      scope.reply(201, { id: 100 })
        .patch('/repos/test-org/report-repo/check-runs/42').reply(422, { message: 'Check rejected' })
    }
    await assert.rejects((await reporter([change()])).handleResults(), error => error.status === 422)
  })
}

function credentials (t) {
  const originalEnv = process.env
  process.env = {
    ...originalEnv,
    GH_ORG: 'test-org',
    APP_ID: '9',
    PRIVATE_KEY: generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    }).privateKey,
    CREATE_PR_COMMENT: 'true'
  }
  t.after(() => { process.env = originalEnv })
  return process.env
}

test('optional live entrypoint authenticates one verified installation and exercises only its owned fixture (offline responses)', async t => {
  credentials(t)
  const output = []
  t.mock.method(console, 'log', message => output.push(message))
  const fixture = '/repos/test-org/safe-settings-comment-markup-test'
  const repository = { id: 123, owner: { login: 'test-org' }, name: 'safe-settings-comment-markup-test', default_branch: 'main' }
  const writes = []
  let comment
  let check
  let commentId = 100
  let checkId = 42
  nock(apiUrl)
    .get('/app').reply(200, { id: 9 })
    .get('/orgs/test-org/installation').reply(200, installation)
    .post('/app/installations/99/access_tokens').reply(201, { token: 'offline-token', expires_at: '2099-01-01T00:00:00Z' })
  const scope = nock(apiUrl)
    .get(fixture).reply(404)
    .post('/orgs/test-org/repos', body => {
      writes.push(body)
      return body.name === repository.name && body.private && body.auto_init
    }).reply(201, repository)
    .get(uri => decodeURIComponent(uri) === `${fixture}/git/ref/heads/main`).reply(200, { object: { sha: 'base-sha' } })
    .post(`${fixture}/git/refs`, { ref: 'refs/heads/comment-markup-test', sha: 'base-sha' }).reply(201, {})
    .put(`${fixture}/contents/comment-markup.txt`, body => body.branch === 'comment-markup-test').reply(201, {})
    .post(`${fixture}/pulls`, body => body.head === 'comment-markup-test' && body.base === 'main')
    .reply(201, { number: 7, head: { sha: 'head-sha' } })

  for (const conclusion of ['failure', 'success']) {
    const id = checkId++
    const cid = commentId++
    scope.post(`${fixture}/check-runs`, body => body.head_sha === 'head-sha' && body.status === 'in_progress')
      .reply(201, { id })
      .post(`${fixture}/issues/7/comments`).reply((_uri, body) => {
        comment = { id: cid, body: body.body }
        writes.push(body)
        return [201, comment]
      })
      .patch(`${fixture}/check-runs/${id}`).reply((_uri, body) => {
        check = body
        return [200, { id, ...body }]
      })
      .get(`${fixture}/issues/comments/${cid}`)
      .matchHeader('accept', 'application/vnd.github.v3.full')
      .reply(() => [200, {
        ...comment,
        // These are HTTP fixtures, not evidence of GitHub rendering in CI.
        body_html: conclusion === 'failure'
          ? '<details><summary>Repository - 1 repo, 1 setting changed</summary><ul><li><code>description</code><ul><li>before: <code>markup-before</code></li><li>after: <code>markup-after</code></li></ul></li></ul></details><details><summary>Errors</summary><ul><li>markup-error</li></ul></details>'
          : '<p><em>No changes to apply.</em></p><p><code>None</code></p>'
      }])
      .get(`${fixture}/check-runs/${id}`).reply(() => [200, check])
  }
  scope.get(fixture).reply(200, repository)
    .delete(fixture).reply(204)
    .get(fixture).reply(404)

  await main()

  assert(scope.isDone())
  assert.equal(writes.length, 3)
  assert(writes[1].body.includes('`markup-after`'))
  assert(writes[2].body.includes('_No changes to apply._'))
  assert(output.includes('Live comment markup integration passed'))
})

test('optional live entrypoint rejects foreign installation metadata before token issuance or fixture access', async t => {
  credentials(t)
  nock(apiUrl).get('/app').reply(200, { id: 9 })
    .get('/orgs/test-org/installation').reply(200, { ...installation, account: { login: 'foreign' } })

  await assert.rejects(main(), /foreign/)
})

test('optional command fails closed without configuration and is excluded from default test commands', () => {
  const { scripts } = require('../../../package.json')
  assert.equal(scripts['integration:live:comment-markup'], 'node test/live/comment-markup.js')
  assert(!Object.keys(scripts).some(name => name.startsWith('test:') && scripts[name].includes('test/live/')))
  assert(scripts['test:integration'].includes('test/integration/**/*.test.js'))
  const child = spawnSync(process.execPath, [require.resolve('../../live/comment-markup')], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8'
  })
  assert.equal(child.status, 1)
  assert(child.stderr.includes('Set GH_ORG explicitly'))
  assert.equal(child.stdout, '')
})
