const { describe, it, beforeEach, afterEach } = require('node:test')
const { buildRepositoryTransferredEvent, initializeNock, loadInstance, mockAdminRepository, repository, teardownNock } = require('../common')

describe('repository.transferred trigger', function () {
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
    githubScope
      .get(`/repos/${repository.owner.login}/${repository.name}`)
      .reply(200, { ...repository, archived: false })

    await probot.receive(buildRepositoryTransferredEvent())
  })
})
