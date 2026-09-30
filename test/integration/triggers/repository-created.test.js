const { describe, it, beforeEach, afterEach } = require('node:test')
const { buildRepositoryCreatedEvent, initializeNock, loadInstance, mockAdminRepository, teardownNock } = require('../common')

describe('repository.created trigger', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('does not apply configuration when the repository does not have a settings.yml', async () => {
    mockAdminRepository(githubScope)

    await probot.receive(buildRepositoryCreatedEvent())
  })
})
