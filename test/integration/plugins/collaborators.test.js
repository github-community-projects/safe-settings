const { describe, it, beforeEach, afterEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const { CREATED, NO_CONTENT, OK } = require('http-status-codes')
const { bodyMatching, buildTriggerEvent, initializeNock, loadInstance, mockAdminRepository, repository, teardownNock } = require('../common')

describe('collaborators plugin', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('syncs collaborators', async () => {
    const pathToConfig = path.resolve(__dirname, '..', '..', 'fixtures', 'collaborators-config.yml')
    const configFile = Buffer.from(fs.readFileSync(pathToConfig, 'utf8'))
    const encodedConfig = configFile.toString('base64')
    mockAdminRepository(githubScope, encodedConfig)
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}`)
      .reply(OK, { ...repository, archived: false })
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}/collaborators?affiliation=direct`)
      .reply(
        OK,
        [
          { login: 'travi', permissions: { admin: true } },
          { login: 'bkeepers', permissions: { push: true } }
        ]
      )
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}/invitations`)
      .reply(OK, [])
    githubScope
      .put(`/repos/${repository.owner.name}/${repository.name}/collaborators/hubot`, bodyMatching({ permission: 'pull' }))
      .reply(CREATED)
    githubScope
      .delete(`/repos/${repository.owner.name}/${repository.name}/collaborators/travi`)
      .reply(NO_CONTENT)

    await probot.receive(buildTriggerEvent())
  })

  it('skips collaborator writes when the repository is archived', async () => {
    const pathToConfig = path.resolve(__dirname, '..', '..', 'fixtures', 'collaborators-config.yml')
    mockAdminRepository(githubScope, fs.readFileSync(pathToConfig).toString('base64'))
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}`)
      .reply(OK, { ...repository, archived: true })

    await probot.receive(buildTriggerEvent())
  })
})
