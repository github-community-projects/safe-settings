const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')
const Teams = require('../../lib/plugins/teams')

const repo = { owner: 'org', repo: 'repo' }
const team = { id: 42, slug: 'platform-engineering', name: 'Platform Engineering', permission: 'pull', description: null }
const protectedTeam = { id: 99, slug: 'renamed-protected-team', name: 'Security Managers', permission: 'admin' }
const permissionPath = '/orgs/org/teams/platform-engineering/repos/org/repo'

async function fixture (t, { rolesDenied = false, listFailure = false } = {}) {
  const { Octokit } = await import('octokit')
  const requests = []
  const writes = []
  const errors = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl)
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    res.setHeader('content-type', 'application/json')
    if (req.method === 'PUT' && url.pathname === permissionPath) {
      let body = ''
      for await (const chunk of req) body += chunk
      writes.push({ method: req.method, path: url.pathname, body: JSON.parse(body) })
      res.statusCode = 204
      res.end()
    } else if (req.method === 'GET' && url.pathname === '/repos/org/repo/teams') {
      if (url.searchParams.get('page') === '2') {
        res.statusCode = listFailure ? 403 : 200
        res.end(JSON.stringify(listFailure ? { message: 'Team listing denied' } : [team]))
      } else {
        res.setHeader('link', `<${baseUrl}/repos/org/repo/teams?page=2>; rel="next"`)
        res.end(JSON.stringify([protectedTeam]))
      }
    } else if (req.method === 'GET' && url.pathname === '/orgs/org/organization-roles') {
      res.statusCode = rolesDenied ? 403 : 200
      res.end(JSON.stringify(rolesDenied
        ? { message: 'Role listing denied' }
        : { total_count: 1, roles: [{ id: 8, name: 'Security Manager' }] }))
    } else if (req.method === 'GET' && url.pathname === '/orgs/org/organization-roles/8/teams') {
      res.end(JSON.stringify([{ id: 99, name: 'Security Managers' }]))
    } else {
      if (req.method !== 'GET') writes.push({ method: req.method, path: url.pathname })
      res.statusCode = 400
      res.end(JSON.stringify({ message: `Unexpected request: ${req.method} ${req.url}` }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const github = new Octokit({
    baseUrl,
    retry: { enabled: false },
    throttle: { enabled: false },
    log: { debug () {}, info () {}, warn () {}, error () {} }
  })
  const log = { debug () {}, info () {}, error () {} }
  const plugin = (nop = true, entries = [{ name: team.slug, permission: 'pull' }]) =>
    new Teams(nop, github, repo, structuredClone(entries), log, errors)
  return { plugin, requests, writes, errors, baseUrl }
}

test('find follows actual Octokit next links, filters by original display name and retains response fields', async t => {
  const { plugin, requests, writes, errors } = await fixture(t)
  assert.deepEqual(await plugin().find(), [{ ...team, name: team.slug }])
  assert.deepEqual(requests, [
    'GET /repos/org/repo/teams',
    'GET /repos/org/repo/teams?page=2',
    'GET /orgs/org/organization-roles',
    'GET /orgs/org/organization-roles/8/teams'
  ])
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

for (const nop of [true, false]) {
  test(`unchanged paginated teams with nop=${nop} return no result or hasChanges signal`, async t => {
    const { plugin, writes, errors } = await fixture(t)
    const instance = plugin(nop)
    assert.equal(await instance.sync(), undefined)
    assert.equal(instance.hasChanges, false)
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
  })

  test(`permission change with nop=${nop} targets only the actual team slug`, async t => {
    const { plugin, writes, errors, baseUrl } = await fixture(t)
    const instance = plugin(nop, [{ name: team.slug, permission: 'push' }])
    const result = await instance.sync()
    assert.equal(instance.hasChanges, true)
    if (nop) {
      const commands = result.flat(Infinity)
      assert.equal(commands.length, 2)
      assert.deepEqual(commands[0].action, {
        msg: 'Changes found',
        additions: [],
        modifications: [{ permission: 'push', name: team.slug }],
        deletions: []
      })
      assert.equal(commands[1].endpoint, `${baseUrl}${permissionPath}`)
      assert.deepEqual({ ...commands[1].body }, { team_id: team.id, org: 'org', permission: 'push' })
      assert.deepEqual(writes, [])
    } else {
      assert.deepEqual(writes, [{
        method: 'PUT',
        path: permissionPath,
        body: { team_id: team.id, org: 'org', permission: 'push' }
      }])
    }
    assert.deepEqual(errors, [])
  })
}

test('a denied roles response still normalizes records and prevents deletion', async t => {
  const { plugin, writes, errors } = await fixture(t, { rolesDenied: true })
  const instance = plugin(false, [])
  await instance.sync()
  assert.equal(instance.skipTeamDeletion, true)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})

test('a failed second team page never applies a partial list', async t => {
  const { plugin, writes, errors } = await fixture(t, { listFailure: true })
  const result = await plugin().sync()
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'ERROR')
  assert.match(result[0].action.msg, /Team listing denied/)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})
