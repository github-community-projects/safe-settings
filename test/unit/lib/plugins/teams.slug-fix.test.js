const Teams = require('../../../../lib/plugins/teams')

describe('Teams - slug identity in dry-run comparisons', () => {
  const repo = { owner: 'org', repo: 'test' }
  const team = {
    id: 42,
    slug: 'platform-engineering',
    name: 'Platform Engineering',
    permission: 'push',
    description: null,
    notification_setting: 'notifications_enabled'
  }
  let github, errors, log

  beforeEach(() => {
    errors = []
    log = { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    github = {
      paginate: jest.fn(async route => {
        if (route === github.rest.repos.listTeams) return [team]
        if (route === 'GET /orgs/{org}/organization-roles') return []
        throw new Error(`Unexpected pagination route: ${route}`)
      }),
      rest: {
        repos: { listTeams: jest.fn() },
        teams: { getByName: jest.fn(), create: jest.fn(), addOrUpdateRepoPermissionsInOrg: jest.fn() }
      },
      request: Object.assign(jest.fn().mockResolvedValue({}), {
        endpoint: jest.fn().mockReturnValue({ url: 'endpoint', body: {} })
      })
    }
  })

  function configure (entries = [{ name: team.slug, permission: 'push' }], nop = true) {
    return new Teams(nop, github, repo, entries, log, errors)
  }

  function expectNoWrites () {
    expect(github.request).not.toHaveBeenCalled()
    expect(github.rest.teams.getByName).not.toHaveBeenCalled()
    expect(github.rest.teams.create).not.toHaveBeenCalled()
    expect(github.rest.teams.addOrUpdateRepoPermissionsInOrg).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  }

  it.each([true, false])('unchanged slug config is quiet with nop=%s', async nop => {
    const plugin = configure(undefined, nop)
    expect(await plugin.sync()).toBeUndefined()
    expect(plugin.hasChanges).toBe(false)
    expectNoWrites()
  })

  it('reports exactly one permission modification and one proposed PUT, not phantom additions or deletions', async () => {
    const plugin = configure([{ name: team.slug, permission: 'maintain' }])
    const result = (await plugin.sync()).flat(Infinity)
    expect(result).toHaveLength(2)
    expect(result[0].action).toEqual({
      msg: 'Changes found',
      additions: [],
      modifications: [{ name: team.slug, permission: 'maintain' }],
      deletions: []
    })
    expect(github.request.endpoint).toHaveBeenCalledWith(
      'PUT /orgs/:owner/teams/:team_slug/repos/:owner/:repo',
      { ...repo, org: repo.owner, team_id: team.id, team_slug: team.slug, permission: 'maintain' }
    )
    expect(plugin.hasChanges).toBe(true)
    expectNoWrites()
  })

  it('applies a real permission change to the slug exactly once', async () => {
    const plugin = configure([{ name: team.slug, permission: 'maintain' }], false)
    await plugin.sync()
    expect(github.request.mock.calls).toEqual([[
      'PUT /orgs/:owner/teams/:team_slug/repos/:owner/:repo',
      { ...repo, org: repo.owner, team_id: team.id, team_slug: team.slug, permission: 'maintain' }
    ]])
    expect(github.rest.teams.getByName).not.toHaveBeenCalled()
    expect(plugin.hasChanges).toBe(true)
    expect(errors).toEqual([])
  })

  it('normalizes a copy without dropping API metadata or mutating the response', async () => {
    const snapshot = structuredClone(team)
    const found = await configure().find()
    expect(found).toEqual([{ ...team, name: team.slug }])
    expect(found[0]).not.toBe(team)
    expect(team).toEqual(snapshot)
    expect(github.paginate).toHaveBeenCalledWith(github.rest.repos.listTeams, repo)
  })

  it.each([
    { name: 'legacy', permission: 'push' },
    { slug: null, name: 'legacy', permission: null },
    { slug: '', name: 'legacy' },
    { permission: 'push' }
  ])('preserves missing/empty slug and optional fields: %j', async record => {
    github.paginate.mockResolvedValueOnce([record])
    expect(await configure().find()).toEqual([record])
  })

  it('filters security managers by their original display name before normalizing retained teams', async () => {
    const protectedTeam = { id: 99, name: 'Security Managers', slug: 'renamed-protected-team', permission: 'admin' }
    github.paginate
      .mockResolvedValueOnce([team, protectedTeam])
      .mockResolvedValueOnce([{ id: 8, name: 'Security Manager' }])
      .mockResolvedValueOnce([{ name: 'Security Managers' }])
    const plugin = configure()
    expect(await plugin.find()).toEqual([{ ...team, name: team.slug }])
    expect(plugin.securityManagerTeamIdentifiers.has('security-managers')).toBe(true)
    expect(protectedTeam.name).toBe('Security Managers')
  })

  it('retains deletion protection when security-manager discovery fails', async () => {
    github.paginate
      .mockResolvedValueOnce([team])
      .mockRejectedValueOnce({ status: 403 })
    const plugin = configure([])
    const result = (await plugin.sync()).flat(Infinity)
    expect(result[0].action.deletions).toEqual([{ ...team, name: team.slug }])
    expect(result[1].action.msg).toMatch(/Skipping deletion.*security manager team discovery failed/)
    expect(plugin.skipTeamDeletion).toBe(true)
    expectNoWrites()
  })

  it('keeps additive teams rather than proposing DELETE endpoints', async () => {
    const plugin = configure([])
    plugin.additive = true
    const result = (await plugin.sync()).flat(Infinity)
    expect(result[0].action.deletions).toEqual([{ ...team, name: team.slug }])
    expect(result[1].action.msg).toMatch(/1 deletion\(s\) suppressed/)
    expect(result.every(command => command.endpoint === '')).toBe(true)
    expectNoWrites()
  })

  it('strips include/exclude selectors before comparing an included team', async () => {
    const plugin = configure([{ name: team.slug, permission: 'push', include: ['test*'], exclude: ['private-*'] }])
    expect(await plugin.sync()).toBeUndefined()
    expect(plugin.hasChanges).toBe(false)
    expectNoWrites()
  })

  it('still proposes removal by slug when a configured team is excluded', async () => {
    const plugin = configure([{ name: team.slug, permission: 'push', exclude: ['test*'] }])
    const result = (await plugin.sync()).flat(Infinity)
    expect(result[0].action.deletions).toEqual([{ ...team, name: team.slug }])
    expect(github.request.endpoint).toHaveBeenCalledWith(
      'DELETE /orgs/:owner/teams/:team_slug/repos/:owner/:repo',
      { ...repo, org: repo.owner, team_slug: team.slug }
    )
    expectNoWrites()
  })

  it.each([undefined, null])('does not discover teams when entries are %s', async entries => {
    const plugin = new Teams(true, github, repo, entries, log, errors)
    expect(await plugin.sync()).toBeUndefined()
    expect(plugin.hasChanges).toBe(false)
    expect(github.paginate).not.toHaveBeenCalled()
  })
})
