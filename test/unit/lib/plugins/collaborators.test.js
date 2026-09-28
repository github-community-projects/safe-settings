const Collaborators = require('../../../../lib/plugins/collaborators')

describe('Collaborators', () => {
  let github

  function configure (config) {
    const log = { debug: jest.fn(), info: jest.fn(), error: console.error }
    return new Collaborators(undefined, github, { owner: 'bkeepers', repo: 'test' }, config, log)
  }

  beforeEach(() => {
    github = {
      rest: {
        repos: {
          listInvitations: jest.fn().mockResolvedValue([]),
          deleteInvitation: jest.fn().mockResolvedValue(),
          updateInvitation: jest.fn().mockResolvedValue(),
          listCollaborators: jest.fn().mockResolvedValue([]),
          removeCollaborator: jest.fn().mockResolvedValue(),
          addCollaborator: jest.fn().mockResolvedValue()
        }
      }
    }
  })

  describe('sync', () => {
    it('syncs collaborators', () => {
      const plugin = configure([
        { username: 'bkeepers', permission: 'admin' },
        { username: 'added-user', permission: 'push' },
        { username: 'updated-permission', permission: 'push' },
        { username: 'DIFFERENTcase', permission: 'push' }
      ])

      github.rest.repos.listCollaborators.mockResolvedValueOnce({
        data: [
          { login: 'bkeepers', permissions: { admin: true, push: true, pull: true } },
          { login: 'updated-permission', permissions: { admin: false, push: false, pull: true } },
          { login: 'removed-user', permissions: { admin: false, push: true, pull: true } },
          { login: 'differentCase', permissions: { admin: false, push: true, pull: true } }
        ]
      })

      return plugin.sync().then(() => {
        expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          username: 'added-user',
          permission: 'push'
        })

        expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          username: 'updated-permission',
          permission: 'push'
        })

        expect(github.rest.repos.addCollaborator).toHaveBeenCalledTimes(2)

        expect(github.rest.repos.removeCollaborator).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          username: 'removed-user'
        })

        expect(github.rest.repos.removeCollaborator).toHaveBeenCalledTimes(1)
      })
    })
  })
})
