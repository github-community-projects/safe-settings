const { describe, it, beforeEach, afterEach } = require('node:test')
const path = require('path')
const fs = require('fs')
const { CREATED, NO_CONTENT, OK } = require('http-status-codes')
const settings = require('../../../lib/settings')
const { bodyMatching, buildTriggerEvent, initializeNock, loadInstance, repository, teardownNock } = require('../common')

describe('milestones plugin', function () {
  let probot, githubScope

  beforeEach(async () => {
    githubScope = initializeNock()
    probot = await loadInstance()
  })

  afterEach(() => {
    teardownNock(githubScope)
  })

  it('syncs milestones', async () => {
    const pathToConfig = path.resolve(__dirname, '..', '..', 'fixtures', 'milestones-config.yml')
    const configFile = Buffer.from(fs.readFileSync(pathToConfig, 'utf8'))
    const encodedConfig = configFile.toString('base64')
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}/contents/${settings.FILE_PATH}`)
      .reply(OK, { content: encodedConfig, name: 'settings.yml', type: 'file' })
    githubScope
      .patch(`/repos/${repository.owner.name}/${repository.name}`)
      .reply(200)
    githubScope
      .get(`/repos/${repository.owner.name}/${repository.name}/milestones?per_page=100&state=all`)
      .reply(
        OK,
        [
          {
            number: 42,
            title: 'existing-milestone',
            description: 'this milestone should get updated',
            state: 'open'
          },
          {
            number: 8,
            title: 'old-milestone',
            description: 'this milestone should get deleted',
            state: 'closed'
          }
        ]
      )
    githubScope
      .post(`/repos/${repository.owner.name}/${repository.name}/milestones`, bodyMatching({
        title: 'new-milestone',
        description: 'this milestone should get added',
        state: 'open'
      }))
      .reply(CREATED)
    githubScope
      .patch(`/repos/${repository.owner.name}/${repository.name}/milestones/42`, bodyMatching({
        title: 'existing-milestone',
        description: 'this milestone should get updated',
        state: 'closed'
      }))
      .reply(OK)
    githubScope
      .delete(`/repos/${repository.owner.name}/${repository.name}/milestones/8`)
      .reply(NO_CONTENT)

    await probot.receive(buildTriggerEvent())
  })
})
