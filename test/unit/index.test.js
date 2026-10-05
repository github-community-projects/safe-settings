jest.mock('probot', () => ({ Probot: class Probot {} }))
const { Probot } = require('probot')
const plugin = require('../../index')
jest.mock('../../lib/hubSyncHandler', () => ({ hubSyncHandler: jest.fn() }))
const { hubSyncHandler } = require('../../lib/hubSyncHandler')

describe.skip('plugin', () => {
  let app, event, sync, github

  beforeEach(() => {
    class Octokit {
      static defaults() {
        return Octokit
      }

      constructor() {
        this.config = {
          get: jest.fn().mockReturnValue({})
        }
        this.repos = {
          getContent: jest.fn(() => Promise.resolve({ data: { content: '' } }))
        }
      }

      auth() {
        return this
      }
    }

    app = new Probot({ secret: 'abcdef', Octokit })
    github = {
      repos: {
        getContents: jest.fn(() => Promise.resolve({ data: { content: '' } }))
      }
    }
    app.auth = () => Promise.resolve(github)
    app.log = { debug: jest.fn(), error: console.error }
    event = {
      name: 'push',
      payload: JSON.parse(JSON.stringify(require('../fixtures/events/push.settings.json')))
    }
    sync = jest.fn()

    plugin(app, {}, { sync, FILE_NAME: '.github/settings.yml' })
    jest.clearAllMocks()

  })

  describe('with settings modified on master', () => {
    it('syncs settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('on another branch', () => {
    beforeEach(() => {
      event.payload.ref = 'refs/heads/other-branch'
    })

    it('does not sync settings', async () => {
      await app.receive(event)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  describe('with other files modified', () => {
    beforeEach(() => {
      event.payload = require('../fixtures/events/push.readme.json')
    })

    it('does not sync settings', async () => {
      await app.receive(event)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  describe('default branch changed', () => {
    beforeEach(() => {
      event = {
        name: 'repository.edited',
        payload: require('../fixtures/events/repository.edited.json')
      }
    })

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('member event', () => {
    beforeEach(() => {
      event = {
        name: 'member',
        payload: require('../fixtures/events/member.json')
      }
    })

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('team added to repository', () => {
    beforeEach(() => {
      event = {
        name: 'team.added_to_repository',
        payload: require('../fixtures/events/team.added_to_repository.json')
      }
    })

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('team removed from repository', () => {
    beforeEach(() => {
      event = {
        name: 'team.removed_from_repository',
        payload: require('../fixtures/events/team.removed_from_repository.json')
      }
    })

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('team access changed', () => {
    beforeEach(() => {
      event = {
        name: 'team.edited',
        payload: require('../fixtures/events/team.edited.json')
      }
    })

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })

  describe('repository created', () => {
    event = {
      name: 'repository.created',
      payload: {}
    }

    it('does sync settings', async () => {
      await app.receive(event)
      expect(sync).toHaveBeenCalled()
    })
  })
})
