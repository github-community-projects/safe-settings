const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const nock = require('nock')
const { initializeNock, loadInstance, repository, teardownNock } = require('./common')

// Guards the premise of every other integration test: requests made by the
// Octokit client Probot hands to the app go through nock, and anything not
// mocked is blocked rather than reaching the network.
describe('nock interception of the Octokit HTTP transport', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('intercepts requests from the Probot Octokit client', async () => {
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}`)
      .matchHeader('authorization', 'token test')
      .reply(200, { name: repository.name, intercepted: true })

    const github = await probot.auth()
    const { data } = await github.rest.repos.get({ owner: repository.owner.name, repo: repository.name })

    assert.deepEqual(data, { name: repository.name, intercepted: true })
  })

  it('blocks requests that have no matching mock', async () => {
    const github = await probot.auth()

    await assert.rejects(
      github.request('GET /repos/{owner}/{repo}/unmocked', { owner: repository.owner.name, repo: repository.name, request: { retries: 0 } }),
      error => /Nock: (No match|Disallowed net connect)/.test(error.message)
    )
    await assert.rejects(fetch('https://example.com/'), /Nock: Disallowed net connect/)
    assert.equal(nock.isDone(), true)
  })
})
