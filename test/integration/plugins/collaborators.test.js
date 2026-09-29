const { describe, it, beforeEach, afterEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const { CREATED, NO_CONTENT, OK } = require('http-status-codes')
const settings = require('../../../lib/settings')
const { bodyMatching, buildTriggerEvent, initializeNock, loadInstance, repository, teardownNock } = require('../common')

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
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}/contents/${settings.FILE_PATH}`)
      .reply(OK, { content: encodedConfig, name: 'settings.yml', type: 'file' })
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
      .put(`/repos/${repository.owner.name}/${repository.name}/collaborators/hubot`, bodyMatching({ permission: 'pull' }))
      .reply(CREATED)
    githubScope
      .delete(`/repos/${repository.owner.name}/${repository.name}/collaborators/travi`)
      .reply(NO_CONTENT)

    await probot.receive(buildTriggerEvent())
  })
})
