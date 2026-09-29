const { describe, it, beforeEach, afterEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const yaml = require('js-yaml')
const { bodyMatching, buildTriggerEvent, initializeNock, loadInstance, mockAdminRepository, repository, teardownNock } = require('../common')

describe('repository plugin', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('syncs repo settings', async () => {
    const pathToConfig = path.resolve(__dirname, '..', '..', 'fixtures', 'repository-config.yml')
    const configFile = Buffer.from(fs.readFileSync(pathToConfig, 'utf8'))
    const config = yaml.load(configFile.toString())
    const encodedConfig = configFile.toString('base64')
    mockAdminRepository(githubScope, encodedConfig, 2)
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}`)
      .times(2)
      .reply(200, {
        name: 'bar',
        delete_branch_on_merge: false,
        is_template: false,
        topics: []
      })
    githubScope
      .patch(`/repos/${repository.owner.name}/${repository.name}`, bodyMatching({
        name: repository.name,
        delete_branch_on_merge: config.repository.delete_branch_on_merge,
        is_template: config.repository.is_template
      }))
      .reply(200)

    await probot.receive(buildTriggerEvent())
  })
})
