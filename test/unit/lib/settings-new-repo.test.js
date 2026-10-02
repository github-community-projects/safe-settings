const Settings = require('../../../lib/settings')
const Repository = require('../../../lib/plugins/repository')
const Teams = require('../../../lib/plugins/teams')
const Rulesets = require('../../../lib/plugins/rulesets')
const NopCommand = require('../../../lib/nopcommand')

describe('Suborg membership before repository creation', () => {
  const repo = { owner: 'test-org', repo: 'demo-repo-service2' }
  const suborgPath = '.github/suborgs/expert-services.yml'
  const team = 'expert-services-developers'
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })
  let context
  let settings
  let suborg
  let getTeams
  let getProperties

  beforeEach(() => {
    context = {
      payload: {
        installation: { id: 123 },
        repository: { owner: { login: repo.owner }, name: 'admin' },
        check_run: { id: 42, check_suite: { pull_requests: [{ number: 1 }] } }
      },
      repo: () => ({ owner: repo.owner, repo: 'admin' }),
      octokit: {
        rest: {
          repos: {
            get: jest.fn().mockRejectedValue(notFound()),
            listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'head' }] })
          },
          checks: {
            create: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({})
          },
          issues: { createComment: jest.fn().mockResolvedValue({}) }
        }
      },
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }
    suborg = {
      suborgteams: [team],
      rulesets: [{ name: 'Protect release and production branches' }]
    }
    settings = new Settings(false, context, repo, { restrictedRepos: {} }, 'main')
    jest.spyOn(Settings.prototype, 'getSubOrgConfigMap').mockResolvedValue([{ name: 'expert-services.yml', path: suborgPath }])
    jest.spyOn(Settings.prototype, 'loadYaml').mockImplementation(async () => suborg)
    getTeams = jest.spyOn(Settings.prototype, 'getReposTeams').mockRejectedValue(notFound())
    getProperties = jest.spyOn(Settings.prototype, 'getRepoCustomPropertyValues').mockRejectedValue(notFound())
  })

  it.each(['teams', 'properties'])('treats %s as unmatched only when the repository is also missing', async selector => {
    if (selector === 'properties') suborg = { suborgproperties: [{ ownership: 'expert-services' }] }

    expect(await settings.getSubOrgConfigs(repo)).toEqual({})

    expect(context.octokit.rest.repos.get).toHaveBeenCalledTimes(1)
    expect(context.octokit.rest.repos.get).toHaveBeenCalledWith(repo)
    expect(context.log.error).not.toHaveBeenCalled()
    expect(settings.errors).toEqual([])
  })

  it('keeps later name-based matches and avoids repeated lookups for a missing repo', async () => {
    const byName = { suborgrepos: ['demo-repo-*'] }
    settings.getSubOrgConfigMap.mockResolvedValue([
      { name: 'first.yml', path: 'first.yml' },
      { name: 'second.yml', path: 'second.yml' },
      { name: 'by-name.yml', path: 'by-name.yml' }
    ])
    settings.loadYaml.mockImplementation(async path => path === 'by-name.yml'
      ? byName
      : { suborgteams: [team], suborgproperties: [{ ownership: 'expert-services' }] })

    expect(await settings.getSubOrgConfigs(repo)).toEqual({
      [repo.repo]: { ...byName, source: 'by-name.yml' }
    })
    expect(getTeams).toHaveBeenCalledTimes(1)
    expect(getProperties).not.toHaveBeenCalled()
    expect(context.octokit.rest.repos.get).toHaveBeenCalledTimes(1)
  })

  it.each(['teams', 'properties'])('does not hide a %s 404 for an existing repository', async selector => {
    if (selector === 'properties') suborg = { suborgproperties: [{ ownership: 'expert-services' }] }
    context.octokit.rest.repos.get.mockResolvedValue({ data: { name: repo.repo } })
    const error = notFound()
    const lookup = selector === 'teams' ? getTeams : getProperties
    lookup.mockRejectedValue(error)

    await expect(settings.getSubOrgConfigs(repo)).rejects.toBe(error)
  })

  it.each([403, 429, 500])('propagates lookup errors with status %i without checking existence', async status => {
    const error = Object.assign(new Error('Lookup failed'), { status })
    getTeams.mockRejectedValue(error)

    await expect(settings.getSubOrgConfigs(repo)).rejects.toBe(error)
    expect(context.octokit.rest.repos.get).not.toHaveBeenCalled()
  })

  it('propagates a failure to verify repository existence', async () => {
    const error = Object.assign(new Error('Cannot verify repository'), { status: 403 })
    context.octokit.rest.repos.get.mockRejectedValue(error)

    await expect(settings.getSubOrgConfigs(repo)).rejects.toBe(error)
  })

  it('retains genuine lookup failures in NOP results', async () => {
    settings.nop = true
    context.octokit.rest.repos.get.mockResolvedValue({ data: { name: repo.repo } })

    await settings.getSubOrgConfigs(repo)

    expect(settings.results).toEqual([
      expect.objectContaining({ type: 'ERROR', action: expect.objectContaining({ msg: 'Error: Not Found' }) })
    ])
    expect(context.log.error).toHaveBeenCalled()
  })

  it('does not add existence checks for successful cached lookups', async () => {
    settings.getSubOrgConfigMap.mockResolvedValue([
      { name: 'first.yml', path: 'first.yml' },
      { name: 'second.yml', path: 'second.yml' }
    ])
    suborg = { suborgteams: [team], suborgproperties: [{ ownership: 'expert-services' }] }
    getTeams.mockResolvedValue([])
    getProperties.mockResolvedValue([])

    expect(await settings.getSubOrgConfigs(repo)).toEqual({})

    expect(getTeams).toHaveBeenCalledTimes(1)
    expect(getProperties).toHaveBeenCalledTimes(1)
    expect(context.octokit.rest.repos.get).not.toHaveBeenCalled()
  })

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])('preserves creation with nop=%s and previous-phase suborg=%s', async (nop, hasSuborg) => {
    let created = false
    let addedTeam = false
    if (!hasSuborg) settings.getSubOrgConfigMap.mockResolvedValue([])
    const override = {
      repository: { name: repo.repo, force_create: true, archived: false },
      teams: [{ name: team, permission: 'push' }]
    }
    context.octokit.rest.repos.get.mockImplementation(async () => {
      if (!created) throw notFound()
      return { data: { name: repo.repo, archived: false } }
    })
    getTeams.mockImplementation(async () => {
      if (!created) throw notFound()
      return addedTeam ? [{ slug: team }] : []
    })
    jest.spyOn(Settings.prototype, 'getReposForTeam').mockImplementation(async () => {
      return [
        { name: 'test' },
        { name: 'demo-repo-service1', archived: true },
        ...(addedTeam ? [{ name: repo.repo }] : [])
      ]
    })
    jest.spyOn(Settings.prototype, 'getRepoConfigs').mockResolvedValue({ [`${repo.repo}.yml`]: override })
    jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
    const create = jest.spyOn(Repository.prototype, 'sync').mockImplementation(async function () {
      this.created = !created
      if (!this.nop) created = true
      return this.nop ? [new NopCommand('Repository', this.repo, null, 'Create Repo')] : []
    })
    const addTeam = jest.spyOn(Teams.prototype, 'sync').mockImplementation(async function () {
      this.hasChanges = !addedTeam
      if (!this.nop) addedTeam = true
      return []
    })
    const applyRulesets = jest.spyOn(Rulesets.prototype, 'sync').mockResolvedValue([])

    await Settings.syncSelectedRepos(nop, context, [repo], [], { restrictedRepos: {} }, 'main')

    expect(create).toHaveBeenCalled()
    expect(addTeam).toHaveBeenCalled()
    expect(context.log.error).not.toHaveBeenCalled()
    if (nop) {
      expect(created).toBe(false)
      expect(addedTeam).toBe(false)
      const check = context.octokit.rest.checks.update.mock.calls[0][0]
      expect(check.conclusion).toBe('success')
      expect(check.output.summary).toContain('Create Repo')
    } else {
      expect(created).toBe(true)
      expect(addedTeam).toBe(true)
      expect(applyRulesets).toHaveBeenCalledTimes(hasSuborg ? 1 : 0)
      if (hasSuborg) {
        expect(applyRulesets.mock.instances[0].entries).toEqual(suborg.rulesets)
        expect(applyRulesets.mock.instances[0].repo).toEqual(repo)
      }
      expect(context.octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('success')
    }
  })
})
