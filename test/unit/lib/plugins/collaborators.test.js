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

  describe('built-in roles', () => {
    const flags = {
      admin: { admin: true, maintain: true, push: true, triage: true, pull: true },
      maintain: { admin: false, maintain: true, push: true, triage: true, pull: true },
      push: { admin: false, maintain: false, push: true, triage: true, pull: true },
      triage: { admin: false, maintain: false, push: false, triage: true, pull: true },
      pull: { admin: false, maintain: false, push: false, triage: false, pull: true }
    }

    Object.keys(flags).forEach(role => {
      it(`does not update a ${role} collaborator that already matches`, async () => {
        const plugin = configure([{ username: 'alice', permission: role }])
        github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [{ login: 'alice', permissions: flags[role] }] })
        await plugin.sync()
        expect(github.rest.repos.addCollaborator).not.toHaveBeenCalled()
      })
    })

    it('updates a collaborator whose role differs', async () => {
      const plugin = configure([{ username: 'alice', permission: 'maintain' }])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [{ login: 'alice', permissions: flags.push }] })
      await plugin.sync()
      expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({
        owner: 'bkeepers',
        repo: 'test',
        username: 'alice',
        permission: 'maintain'
      })
    })

    it('does not leak extra fields into the update payload', async () => {
      const plugin = configure([{ username: 'alice', permission: 'triage' }])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [{ login: 'alice', role_name: 'write', permissions: flags.push }] })
      await plugin.sync()
      expect(github.rest.repos.addCollaborator.mock.calls[0][0]).toEqual({
        owner: 'bkeepers',
        repo: 'test',
        username: 'alice',
        permission: 'triage'
      })
    })
  })

  describe('invitations', () => {
    const invite = (login, permissions) => ({ id: 7, invitee: { login }, permissions })

    const cases = [['admin', 'admin'], ['maintain', 'maintain'], ['write', 'push'], ['triage', 'triage'], ['read', 'pull']]
    cases.forEach(([api, role]) => {
      it(`does not update a pending ${api} invitation that already matches`, async () => {
        const plugin = configure([{ username: 'alice', permission: role }])
        github.rest.repos.listInvitations.mockResolvedValueOnce({ data: [invite('alice', api)] })
        await plugin.sync()
        expect(github.rest.repos.updateInvitation).not.toHaveBeenCalled()
        expect(github.rest.repos.deleteInvitation).not.toHaveBeenCalled()
      })
    })

    it('updates a pending invitation to maintain', async () => {
      const plugin = configure([{ username: 'alice', permission: 'maintain' }])
      github.rest.repos.listInvitations.mockResolvedValueOnce({ data: [invite('alice', 'read')] })
      await plugin.sync()
      expect(github.rest.repos.updateInvitation).toHaveBeenCalledWith({
        invitation_id: 7,
        permissions: 'maintain',
        owner: 'bkeepers',
        repo: 'test'
      })
    })

    it('updates a pending invitation to triage', async () => {
      const plugin = configure([{ username: 'alice', permission: 'triage' }])
      github.rest.repos.listInvitations.mockResolvedValueOnce({ data: [invite('alice', 'write')] })
      await plugin.sync()
      expect(github.rest.repos.updateInvitation).toHaveBeenCalledWith({
        invitation_id: 7,
        permissions: 'triage',
        owner: 'bkeepers',
        repo: 'test'
      })
    })
  })
})
