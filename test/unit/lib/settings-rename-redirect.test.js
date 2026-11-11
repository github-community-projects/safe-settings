const Settings = require('../../../lib/settings')

// GitHub answers requests for a renamed repo's old name with the renamed repo.
describe('Repos reached through a rename redirect', () => {
  const owner = 'test-org'
  const admin = { owner, repo: 'admin' }
  const config = { restrictedRepos: {}, repository: { has_wiki: true } }
  let context
  let childSync

  beforeEach(() => {
    context = {
      payload: { installation: { id: 123 } },
      repo: () => admin,
      octokit: {
        paginate: jest.fn().mockResolvedValue([{ owner: { login: owner }, name: 'old-name', archived: false }]),
        rest: {
          repos: {
            get: jest.fn().mockResolvedValue({ data: { name: 'new-name', archived: false, has_wiki: false, topics: [] } }),
            update: Object.assign(jest.fn().mockResolvedValue({}), { endpoint: jest.fn(() => ({})) })
          }
        }
      },
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }
    childSync = jest.fn().mockResolvedValue([])
    class ChildPlugin {
      sync () { return childSync() }
    }
    jest.spyOn(Settings.prototype, 'childPluginsList').mockReturnValue([[ChildPlugin, {}, 'labels']])
    jest.spyOn(Settings.prototype, 'getSubOrgConfigs').mockResolvedValue({})
    jest.spyOn(Settings.prototype, 'getRepoConfigs').mockResolvedValue({})
    jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'handleResults').mockResolvedValue()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const expectRepoLeftAlone = () => {
    expect(context.octokit.rest.repos.get).toHaveBeenCalledWith(expect.objectContaining({ owner, repo: 'old-name' }))
    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(childSync).not.toHaveBeenCalled()
    expect(context.log.warn).toHaveBeenCalledWith(`Skipping ${owner}/old-name: it was renamed to new-name`)
  }

  // A push lists old-name.yml as removed, in the commit that renames the file
  // or in a later merge commit that replays that removal.
  it('does not rename a repo back when its old config file is removed', async () => {
    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'old-name' }], [], config, 'head', null, 'base')

    expectRepoLeftAlone()
  })

  // With `archive` disabled a full sync does not fetch the repo before the
  // repository plugin runs, so the plugin itself has to notice the redirect.
  it.each([
    ['', {}],
    [' and the archive plugin is disabled', { disable_plugins: ['archive'] }]
  ])('does not rename a repo back when a full sync still lists its old name%s', async (_, extraConfig) => {
    const settings = new Settings(false, context, admin, { ...config, ...extraConfig }, 'main')
    await settings.loadConfigs()

    await settings.eachRepositoryRepos(context.octokit, context.log)

    expectRepoLeftAlone()
    expect(context.octokit.rest.repos.get).toHaveBeenCalledTimes(1)
    expect(settings.errors).toEqual([])
  })

  // Without the repository plugin nothing would rename the repo, but the old
  // name's settings would still land on the renamed repo.
  it.each([
    ['there is no repository config', { restrictedRepos: {} }],
    ['the repository plugin is disabled', { ...config, disable_plugins: ['repository'] }]
  ])('does not sync child plugins through the redirect when %s', async (_, childOnlyConfig) => {
    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'old-name' }], [], childOnlyConfig, 'head', null, 'base')

    expectRepoLeftAlone()
  })

  it('does not unarchive the renamed repo', async () => {
    context.octokit.rest.repos.get.mockResolvedValue({ data: { name: 'new-name', archived: true, topics: [] } })

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'old-name' }], [], { ...config, repository: { archived: false } }, 'head', null, 'base')

    expectRepoLeftAlone()
  })

  it('reports the skipped name once in a dry run', async () => {
    const appendToResults = jest.spyOn(Settings.prototype, 'appendToResults')

    await Settings.syncSelectedRepos(true, context, [{ owner, repo: 'old-name' }], [], config, 'head', null, 'base')

    const results = appendToResults.mock.calls.flatMap(([res]) => res).flat().filter(Boolean)
    expect(results).toEqual([expect.objectContaining({ type: 'WARNING', plugin: 'Repository', repo: 'old-name' })])
  })

  it('still follows the redirect when the config names the renamed repo', async () => {
    Settings.prototype.getRepoConfigs.mockResolvedValue({ 'old-name.yml': { repository: { name: 'new-name' } } })

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'old-name' }], [], config, 'head', null, 'base')

    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'old-name', name: 'new-name', has_wiki: true }))
    expect(childSync).toHaveBeenCalledTimes(1)
  })

  // BLOCK_REPO_RENAME_BY_HUMAN syncs the previous name with `oldname` set to
  // the live one, and relies on the redirect to rename the repo back.
  it('still renames a repo back when oldname asks for it', async () => {
    await Settings.sync(false, context, { owner, repo: 'old-name' }, { ...config, repository: { name: 'old-name', oldname: 'new-name' } })

    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'old-name', name: 'old-name' }))
  })

  it('still syncs a repo whose name was not redirected', async () => {
    context.octokit.rest.repos.get.mockResolvedValue({ data: { name: 'old-name', archived: false, has_wiki: false, topics: [] } })

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'old-name' }], [], config, 'head', null, 'base')

    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'old-name', name: 'old-name', has_wiki: true }))
    expect(childSync).toHaveBeenCalledTimes(1)
  })
})
