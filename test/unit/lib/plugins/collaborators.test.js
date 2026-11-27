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

  describe('direct roles', () => {
    const collaborator = login => ({ login, permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } })
    const source = (type, roleName) => ({ roleName, source: { __typename: type } })
    const edge = (login, ...permissionSources) => ({ node: { login }, permissionSources })
    const page = (edges, endCursor = null) => ({ repository: { collaborators: { pageInfo: { hasNextPage: !!endCursor, endCursor }, edges } } })

    beforeEach(() => {
      github.graphql = jest.fn()
    })

    it('does not update a custom role the collaborator already holds directly', async () => {
      const plugin = configure([{ username: 'alice', permission: 'custom-role' }])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice')] })
      github.graphql.mockResolvedValueOnce(page([edge('alice', source('Organization', null), source('Repository', 'custom-role'), source('Team', 'custom-role'))]))
      await plugin.sync()
      expect(github.rest.repos.addCollaborator).not.toHaveBeenCalled()
      expect(github.graphql).toHaveBeenCalledWith(expect.any(String), { owner: 'bkeepers', repo: 'test', cursor: null })
    })

    it('compares built-in roles by their config names', async () => {
      const plugin = configure([
        { username: 'writer', permission: 'push' },
        { username: 'maintainer', permission: 'maintain' },
        { username: 'reader', permission: 'push' }
      ])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('writer'), collaborator('maintainer'), collaborator('reader')] })
      github.graphql.mockResolvedValueOnce(page([
        edge('writer', source('Repository', 'write')),
        edge('maintainer', source('Repository', 'maintain')),
        edge('reader', source('Repository', 'read'))
      ]))
      await plugin.sync()
      expect(github.rest.repos.addCollaborator).toHaveBeenCalledTimes(1)
      expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({ owner: 'bkeepers', repo: 'test', username: 'reader', permission: 'push' })
    })

    it('updates a role that is only held through a team', async () => {
      const plugin = configure([{ username: 'alice', permission: 'custom-role' }])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice')] })
      github.graphql.mockResolvedValueOnce(page([edge('alice', source('Repository', 'write'), source('Team', 'custom-role'))]))
      await plugin.sync()
      expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({ owner: 'bkeepers', repo: 'test', username: 'alice', permission: 'custom-role' })
    })

    it('reads all pages', async () => {
      const plugin = configure([{ username: 'alice', permission: 'custom-role' }, { username: 'bob', permission: 'custom-role' }])
      github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice'), collaborator('bob')] })
      github.graphql
        .mockResolvedValueOnce(page([edge('alice', source('Repository', 'custom-role'))], 'next'))
        .mockResolvedValueOnce(page([edge('bob', source('Repository', 'custom-role'))]))
      await plugin.sync()
      expect(github.graphql).toHaveBeenLastCalledWith(expect.any(String), { owner: 'bkeepers', repo: 'test', cursor: 'next' })
      expect(github.rest.repos.addCollaborator).not.toHaveBeenCalled()
    })

    describe('falls back to the update when the direct role is unknown', () => {
      it.each([
        ['no Repository source', [source('Team', 'custom-role')]],
        ['conflicting Repository sources', [source('Repository', 'custom-role'), source('Repository', 'admin')]]
      ])('%s', async (_, sources) => {
        const plugin = configure([{ username: 'alice', permission: 'custom-role' }])
        github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice')] })
        github.graphql.mockResolvedValueOnce(page([edge('alice', ...sources)]))
        await plugin.sync()
        expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({ owner: 'bkeepers', repo: 'test', username: 'alice', permission: 'custom-role' })
      })

      it('collaborator missing from the GraphQL result', async () => {
        const plugin = configure([{ username: 'alice', permission: 'push' }])
        github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice')] })
        github.graphql.mockResolvedValueOnce(page([]))
        await plugin.sync()
        expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({ owner: 'bkeepers', repo: 'test', username: 'alice', permission: 'push' })
      })

      it('GraphQL query fails, so effective permissions are compared', async () => {
        const plugin = configure([{ username: 'alice', permission: 'custom-role' }, { username: 'bob', permission: 'push' }])
        github.rest.repos.listCollaborators.mockResolvedValueOnce({ data: [collaborator('alice'), collaborator('bob')] })
        github.graphql.mockRejectedValueOnce(new Error('Forbidden'))
        await plugin.sync()
        expect(github.rest.repos.addCollaborator).toHaveBeenCalledTimes(1)
        expect(github.rest.repos.addCollaborator).toHaveBeenCalledWith({ owner: 'bkeepers', repo: 'test', username: 'alice', permission: 'custom-role' })
      })
    })
  })
})
