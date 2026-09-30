const { describe, it, beforeEach, afterEach } = require('node:test')
const { buildPushEvent, initializeNock, loadInstance, teardownNock } = require('../common')

describe('push trigger', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('does not apply configuration when not on the default branch', async () => {
    await probot.receive(buildPushEvent('wip'))
  })
})
