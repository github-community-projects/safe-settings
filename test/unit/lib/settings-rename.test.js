const Settings = require('../../../lib/settings')

describe('Repo renames and GitHub rename redirects', () => {
  const owner = 'test-org'
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })
  let context
  let liveRepos
  let redirects
  let repoConfigs

  const findRepo = name => {
    const key = name.toLowerCase()
    const target = liveRepos.find(repo => repo.name.toLowerCase() === (redirects[key] || key))
    return target || liveRepos.find(repo => repo.name.toLowerCase() === key)
  }

  beforeEach(() => {
    liveRepos = []
    redirects = {}
    repoConfigs = {}
    context = {
      payload: {
        installation: { id: 123 },
        repository: { owner: { login: owner }, name: 'admin' },
        check_run: { id: 42, check_suite: { pull_requests: [{ number: 1 }] } }
      },
      repo: () => ({ owner, repo: 'admin' }),
      octokit: {
        rest: {
          repos: {
            get: jest.fn(async ({ repo }) => {
              const found = findRepo(repo)
              if (!found) throw notFound()
              return { data: { ...found } }
            }),
            update: jest.fn(async ({ repo, name }) => {
              const found = findRepo(repo)
              if (name && name !== found.name) {
                redirects[found.name.toLowerCase()] = name.toLowerCase()
                found.name = name
              }
              return { data: { ...found } }
            }),
            createInOrg: jest.fn().mockResolvedValue({ data: {} }),
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
    context.octokit.rest.repos.update.endpoint = params => ({ url: `/repos/${params.owner}/${params.repo}`, body: params })
    jest.spyOn(Settings.prototype, 'getSubOrgConfigMap').mockResolvedValue([])
    jest.spyOn(Settings.prototype, 'getRepoConfigs').mockImplementation(async repo => {
      if (!repo) return repoConfigs
      const file = `${repo.repo}.yml`
      return repoConfigs[file] ? { [file]: repoConfigs[file] } : {}
    })
    jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
  })

  afterEach(() => jest.restoreAllMocks())

  const config = { restrictedRepos: {}, repository: { description: 'managed' } }
  const liveRepo = (id, name) => ({ id, name, html_url: `https://github.com/${owner}/${name}`, description: 'managed', archived: false, owner: { login: owner } })
  const nopSummary = () => context.octokit.rest.checks.update.mock.calls[0][0].output.summary

  it('renames the repo named by a renamed config file', async () => {
    liveRepos = [liveRepo(1, 'repo11')]
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'managed' } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.update).toHaveBeenCalledTimes(1)
    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith({ owner, repo: 'repo11', name: 'repo11-renamed' })
    expect(liveRepos[0].name).toBe('repo11-renamed')
  })

  it('applies the renamed file to a repo that was already renamed', async () => {
    liveRepos = [liveRepo(1, 'repo11-renamed')]
    redirects = { repo11: 'repo11-renamed' }
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'from file' } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'main')

    expect(liveRepos[0].name).toBe('repo11-renamed')
    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo11-renamed', description: 'from file' }))
  })

  it('refuses a rename onto a name another repo already has', async () => {
    liveRepos = [liveRepo(1, 'repo11'), liveRepo(2, 'taken')]

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'taken', renamedFrom: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(context.log.error).toHaveBeenCalledWith('Cannot rename to **["taken"](https://github.com/test-org/taken)** because another repo already has that name')
    expect(context.octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('failure')
  })

  it('reports the rename in a dry run without renaming', async () => {
    liveRepos = [liveRepo(1, 'repo11')]

    await Settings.syncSelectedRepos(true, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'rename', config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(nopSummary()).toContain('**repo11-renamed**\n- `Repository`\n  - ~ `repository.name`\n    - before: `repo11`\n    - after: `repo11-renamed`')
  })

  it('previews the other changes in a renamed file on the repo that still has the old name', async () => {
    liveRepos = [liveRepo(1, 'repo11')]
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'from file', force_create: true } }

    await Settings.syncSelectedRepos(true, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'rename', config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(context.octokit.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(nopSummary()).toMatch(/\*\*repo11\*\*\n[^*]*~ `description`\n[^*]*after: `from file`/)
  })

  it('previews the other changes in a renamed file in a full sync dry run', async () => {
    liveRepos = [liveRepo(1, 'repo11')]
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'from file' } }
    context.octokit.paginate = jest.fn(async () => liveRepos.map(repo => ({ owner: { login: owner }, name: repo.name, archived: false })))

    await Settings.syncAll(true, context, context.repo(), config, 'rename', config, { repos: [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }] })

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(nopSummary()).toMatch(/\*\*repo11\*\*\n[^*]*~ `description`\n[^*]*after: `from file`/)
  })

  it('renames before a full sync loads suborg configs, so they are keyed by the new name', async () => {
    liveRepos = [liveRepo(1, 'repo11')]
    context.octokit.paginate = jest.fn(async () => liveRepos.map(repo => ({ owner: { login: owner }, name: repo.name, archived: false })))
    jest.spyOn(Settings.prototype, 'getSubOrgConfigs')

    await Settings.syncAll(false, context, context.repo(), config, 'main', null, { repos: [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }] })

    expect(Settings.prototype.getSubOrgConfigs.mock.invocationCallOrder[0])
      .toBeGreaterThan(context.octokit.rest.repos.update.mock.invocationCallOrder[0])
  })

  it('leaves a refused rename out of the app installation changes', async () => {
    liveRepos = [liveRepo(1, 'repo11'), liveRepo(2, 'taken'), liveRepo(3, 'other')]

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'taken', renamedFrom: 'repo11' }, { owner, repo: 'other' }], [], config, 'main', config, 'main')

    expect(Settings.prototype.syncAppInstallations).toHaveBeenCalledWith(expect.objectContaining({ changedRepos: [{ owner, repo: 'other' }] }))
  })

  it('refuses a rename from or to a restricted repo with an error', async () => {
    liveRepos = [liveRepo(1, 'repo11')]

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], { ...config, restrictedRepos: { exclude: ['repo11'] } }, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(context.log.error).toHaveBeenCalledWith('Cannot rename to **"repo11-renamed"** because **"repo11"** is restricted, so safe-settings cannot change it')
    expect(context.octokit.rest.checks.create.mock.calls[0][0].conclusion).toBe('failure')
  })

  it('renames before a full sync so the full sync only sees the new name', async () => {
    liveRepos = [{ ...liveRepo(1, 'repo11'), description: 'drifted' }]
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'from file' } }
    context.octokit.paginate = jest.fn(async () => liveRepos.map(repo => ({ owner: { login: owner }, name: repo.name, archived: false })))

    await Settings.syncAll(false, context, context.repo(), config, 'main', null, { repos: [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }] })

    const updates = context.octokit.rest.repos.update.mock.calls.map(call => call[0])
    expect(updates[0]).toEqual({ owner, repo: 'repo11', name: 'repo11-renamed' })
    expect(updates.slice(1).map(update => update.repo)).toEqual(['repo11-renamed'])
    expect(updates[1]).toEqual(expect.objectContaining({ description: 'from file' }))
    expect(Settings.prototype.syncAppInstallations.mock.invocationCallOrder[0])
      .toBeGreaterThan(context.octokit.rest.repos.update.mock.invocationCallOrder[0])
  })

  it.each([
    ['does not exist', {}, 'Cannot rename to **"repo11-renamed"** because no repo has this name'],
    ['redirects to a third name', { redirects: { repo11: 'other' }, live: [liveRepo(1, 'other')] }, 'Cannot rename to **"repo11-renamed"** because this repo was renamed to **"other"** outside safe-settings']
  ])('does not create the new repo when the old name %s', async (_, { redirects: redirectMap = {}, live = [] }, expectedError) => {
    liveRepos = live
    redirects = redirectMap
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'managed', force_create: true } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(context.log.error).toHaveBeenCalledWith(expectedError)
  })

  it('reports a skipped rename as an error in a dry run', async () => {
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'managed', force_create: true } }

    await Settings.syncSelectedRepos(true, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'rename', config, 'main')

    expect(context.octokit.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(context.octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('**repo11**:\n* Cannot rename to **"repo11-renamed"** because no repo has this name\n')
  })

  it('syncs the new name when the old name is gone and the new repo exists', async () => {
    liveRepos = [{ ...liveRepo(1, 'repo11-renamed'), description: 'drifted' }]
    repoConfigs['repo11-renamed.yml'] = { repository: { description: 'from file' } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo11-renamed', description: 'from file' }))
  })

  it.each([
    ['the rename', 'update'],
    ['looking up the old name', 'get']
  ])('keeps syncing other repos when %s fails', async (_, failingCall) => {
    liveRepos = [liveRepo(1, 'repo11'), { ...liveRepo(2, 'other'), description: 'drifted' }]
    const serverError = Object.assign(new Error('Server Error'), { status: 500 })
    const realCall = context.octokit.rest.repos[failingCall]
    context.octokit.rest.repos[failingCall] = jest.fn(async params => {
      if (params.repo === 'repo11') throw serverError
      return realCall(params)
    })
    context.octokit.rest.repos.update.endpoint = realCall.endpoint

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }, { owner, repo: 'other' }], [], config, 'main')

    expect(liveRepos[0].name).toBe('repo11')
    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ repo: 'other', description: 'managed' }))
    expect(context.log.error).toHaveBeenCalledWith('Could not rename to **"repo11-renamed"** (Server Error)')
  })

  it('refuses a rename when the renamed file still names another repo', async () => {
    liveRepos = [liveRepo(1, 'repo11')]
    repoConfigs['repo11-renamed.yml'] = { repository: { name: 'repo11', description: 'managed' } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(liveRepos[0].name).toBe('repo11')
    expect(context.log.error).toHaveBeenCalledWith('Cannot rename to **"repo11-renamed"** because the file sets repository.name to **"repo11"**. Remove repository.name or set it to **"repo11-renamed"**')
  })

  it('does not rename a repo back when its removed config file name redirects to it', async () => {
    liveRepos = [{ ...liveRepo(1, 'repo11-renamed'), description: 'drifted' }]
    redirects = { repo11: 'repo11-renamed' }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11' }], [], config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(liveRepos[0].name).toBe('repo11-renamed')
    expect(context.log.warn).toHaveBeenCalledWith(expect.stringContaining('redirects to repo11-renamed'))
  })

  it('does not rename a repo back when a full sync lists its old name', async () => {
    liveRepos = [{ ...liveRepo(1, 'repo11-renamed'), description: 'drifted' }]
    redirects = { repo11: 'repo11-renamed' }
    context.octokit.paginate = jest.fn().mockResolvedValue([{ owner: { login: owner }, name: 'repo11', archived: false }])

    await Settings.syncAll(false, context, context.repo(), config, 'main')

    expect(context.octokit.rest.repos.update).not.toHaveBeenCalled()
    expect(liveRepos[0].name).toBe('repo11-renamed')
  })

  it('keeps syncing a repo whose config file sets its current name explicitly', async () => {
    liveRepos = [{ ...liveRepo(1, 'repo11-renamed'), description: 'drifted' }]
    redirects = { repo11: 'repo11-renamed' }
    repoConfigs['repo11.yml'] = { repository: { name: 'repo11-renamed' } }

    await Settings.syncSelectedRepos(false, context, [{ owner, repo: 'repo11' }], [], config, 'main')

    expect(liveRepos[0].name).toBe('repo11-renamed')
    expect(context.octokit.rest.repos.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'repo11-renamed', description: 'managed' }))
  })

  it('still renames a repo back when BLOCK_REPO_RENAME_BY_HUMAN asks for it', async () => {
    liveRepos = [liveRepo(1, 'renamed-by-human')]
    redirects = { repo11: 'renamed-by-human' }
    const renameConfig = { ...config, repository: { name: 'repo11', oldname: 'renamed-by-human' } }

    await Settings.sync(false, context, { owner, repo: 'repo11' }, renameConfig, 'main')

    expect(liveRepos[0].name).toBe('repo11')
  })
})
