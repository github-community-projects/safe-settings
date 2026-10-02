const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')
const Variables = require('../../../lib/plugins/variables')
const Environments = require('../../../lib/plugins/environments')
const NopCommand = require('../../../lib/nopcommand')

// Native Node loads the installed ESM Octokit and exercises its real fetch/paginate stack.
for (const [kind, Plugin] of [['repository', Variables], ['environment', Environments]]) {
  const environment = { name: 'Production', protection_rules: [], deployment_branch_policy: null }
  const endpoint = kind === 'repository' ? '/repos/org/repo/actions/variables' : '/repos/org/repo/environments/Production/variables'
  const variables = Array.from({ length: 101 }, (_, i) => ({
    name: `VAR_${String(i).padStart(3, '0')}`,
    value: `value-${i}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z'
  }))
  const normalized = records => records.map(({ name, value }) => ({
    name: kind === 'repository' ? name : name.toLowerCase(),
    value
  }))

  async function fixture (t, { records = variables, errorPage, status = 403, emptyLastPage = false, cursor = false, pageCap = 100 } = {}) {
    const { Octokit } = await import('octokit')
    const requests = []
    const mutations = []
    const errors = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, baseUrl)
      requests.push({ method: req.method, url })
      res.setHeader('content-type', 'application/json')
      if (req.method !== 'GET') {
        mutations.push({ method: req.method, path: url.pathname })
        res.end('{}')
      } else if (url.pathname === '/repos/org/repo/environments') {
        res.end(JSON.stringify({ environments: [environment] }))
      } else if (url.pathname.endsWith('/deployment_protection_rules')) {
        res.end(JSON.stringify({ custom_deployment_protection_rules: [] }))
      } else if (url.pathname === endpoint) {
        const requested = Number(url.searchParams.get('per_page') || 10)
        const perPage = Math.min(requested, pageCap)
        const page = cursor ? Number(url.searchParams.get('after') || 0) / perPage + 1 : Number(url.searchParams.get('page') || 1)
        if (page === errorPage) {
          res.statusCode = status
          res.end(JSON.stringify({ message: 'Variable listing denied' }))
          return
        }
        const start = (page - 1) * perPage
        if (start + perPage < records.length || (emptyLastPage && page === 1)) {
          res.setHeader('link', `<${baseUrl}${endpoint}?per_page=${requested}&${cursor ? `after=${start + perPage}` : `page=${page + 1}`}>; rel="next"`)
        }
        res.end(JSON.stringify({ total_count: records.length, variables: records.slice(start, start + perPage) }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ message: `Unexpected route ${url.pathname}` }))
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const github = new Octokit({ baseUrl, retry: { enabled: false }, throttle: { enabled: false }, log: { debug () {}, info () {}, warn () {}, error () {} } })
    const log = { debug () {}, info () {}, error () {} }
    const plugin = (nop = false, desired = normalized(records)) => new Plugin(
      nop, github, { owner: 'org', repo: 'repo' },
      kind === 'repository' ? structuredClone(desired) : [{ name: 'Production', variables: structuredClone(desired) }],
      log, errors
    )
    const pages = () => requests.filter(r => r.method === 'GET' && r.url.pathname === endpoint).map(r => ({
      page: Number(r.url.searchParams.get('page') || 1),
      per_page: Number(r.url.searchParams.get('per_page'))
    }))
    return { plugin, pages, mutations, errors, github }
  }

  test(`${kind}: reads all 101 records with per_page=100 and preserves shape`, async t => {
    const { plugin, pages } = await fixture(t)
    const result = await plugin().find()
    if (kind === 'repository') {
      assert.deepEqual(result, normalized(variables))
    } else {
      assert.deepEqual(result, [{
        name: 'production',
        repo: 'repo',
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null,
        variables: normalized(variables),
        deployment_protection_rules: []
      }])
    }
    assert.deepEqual(pages(), [{ page: 1, per_page: 100 }, { page: 2, per_page: 100 }])
  })

  test(`${kind}: follows cursor next links rather than assuming page=2`, async t => {
    const { plugin, github } = await fixture(t, { cursor: true })
    const reads = []
    github.hook.wrap('request', async (request, options) => {
      const response = await request(options)
      if (options.url.includes(endpoint)) {
        reads.push({
          url: github.request.endpoint(options).url,
          next: (response.headers.link || '').match(/<([^>]+)>;\s*rel="next"/)?.[1],
          count: response.data.variables.length
        })
      }
      return response
    })
    const result = await plugin().find()
    assert.deepEqual(kind === 'repository' ? result : result[0].variables, normalized(variables))
    assert.equal(reads.length, 2)
    assert.deepEqual(reads.map(page => page.count), [100, 1])
    assert.equal(reads[0].next, reads[1].url)
    assert.equal(new URL(reads[1].url).searchParams.get('after'), '100')
    assert.equal(reads[1].url.includes('page=2'), false)
  })

  test(`${kind}: follows all four pages when the server caps per_page=100 at 30`, async t => {
    const { plugin, pages, mutations, errors } = await fixture(t, { pageCap: 30 })
    const result = await plugin().find()
    assert.deepEqual(kind === 'repository' ? result : result[0].variables, normalized(variables))
    assert.deepEqual(pages(), [1, 2, 3, 4].map(page => ({ page, per_page: 100 })))
    await plugin().sync()
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  })

  for (const nop of [false, true]) {
    test(`${kind}: unchanged two-page ${nop ? 'NOP' : 'apply'} does not create or update variables`, async t => {
      const { plugin, mutations, pages, errors } = await fixture(t)
      const instance = plugin(nop)
      const result = await instance.sync()
      assert.deepEqual(mutations, [])
      assert.deepEqual(errors, [])
      assert.deepEqual(pages(), [{ page: 1, per_page: 100 }, { page: 2, per_page: 100 }])
      if (kind === 'repository') assert.equal(instance.hasChanges, false)
      if (nop) assert.ok(result === undefined || result.length === 0)
    })

    test(`${kind}: changed variable on page two ${nop ? 'NOP does not mutate' : 'is patched exactly once'}`, async t => {
      const { plugin, mutations, pages, errors } = await fixture(t)
      const desired = normalized(variables)
      desired[100].value = 'updated'
      await plugin(nop, desired).sync()
      assert.deepEqual(mutations, nop
        ? []
        : [{
            method: 'PATCH',
            path: kind === 'repository' ? `${endpoint}/VAR_100` : '/repos/org/repo/environments/production/variables/var_100'
          }])
      assert.deepEqual(errors, [])
      assert.deepEqual(pages(), [{ page: 1, per_page: 100 }, { page: 2, per_page: 100 }])
    })
  }

  for (const emptyLastPage of [false, true]) {
    test(`${kind}: handles an empty ${emptyLastPage ? 'final' : 'first'} page`, async t => {
      const records = emptyLastPage ? variables.slice(0, 100) : []
      const { plugin, pages } = await fixture(t, { records, emptyLastPage })
      const result = await plugin().find()
      assert.deepEqual(kind === 'repository' ? result : result[0].variables, normalized(records))
      assert.deepEqual(pages(), emptyLastPage ? [{ page: 1, per_page: 100 }, { page: 2, per_page: 100 }] : [{ page: 1, per_page: 100 }])
    })
  }

  for (const errorPage of [1, 2]) {
    test(`${kind}: find propagates API failure on page ${errorPage}`, async t => {
      const { plugin, mutations } = await fixture(t, { errorPage })
      await assert.rejects(plugin().find(), { status: 403, message: 'Variable listing denied' })
      assert.deepEqual(mutations, [])
    })
  }

  for (const nop of [false, true]) {
    test(`${kind}: failed second page ${nop ? 'returns NOP error' : 'is logged'} without partial writes`, async t => {
      const { plugin, mutations, errors } = await fixture(t, { errorPage: 2 })
      const result = await plugin(nop).sync()
      assert.deepEqual(mutations, [])
      if (nop) {
        assert.equal(result.length, 1)
        assert.ok(result[0] instanceof NopCommand)
        assert.match(JSON.stringify(result), /ERROR.*Variable listing denied|Variable listing denied.*ERROR/)
      } else {
        assert.equal(errors.length, 1)
        assert.match(errors[0].msg, /Variable listing denied/)
      }
    })
  }

  test(`${kind}: missing repository remains tolerated in NOP`, async t => {
    const { plugin, mutations, errors } = await fixture(t, { errorPage: 1, status: 404 })
    assert.deepEqual(await plugin(true).sync(), [])
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
  })
}
