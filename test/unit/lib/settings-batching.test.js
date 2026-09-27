const Settings = require('../../../lib/settings')
const NopCommand = require('../../../lib/nopcommand')
const env = require('../../../lib/env')
const Archive = require('../../../lib/plugins/archive')
const Repository = require('../../../lib/plugins/repository')
const Labels = require('../../../lib/plugins/labels')
const { spawnSync } = require('child_process')

describe('Repository sync batching', () => {
  let context
  let settings
  const admin = { owner: 'test-org', repo: 'admin' }

  function repositories (count) {
    return Array.from({ length: count }, (_, index) => ({
      owner: { login: admin.owner },
      name: `repo-${index}`,
      archived: index === 0
    }))
  }

  beforeEach(() => {
    context = {
      payload: { installation: { id: 123 } },
      repo: () => admin,
      octokit: {
        paginate: jest.fn().mockResolvedValue([]),
        rest: {
          repos: { listCommits: jest.fn().mockResolvedValue({ data: [{ sha: 'head' }] }) },
          checks: {
            create: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({})
          },
          issues: { createComment: jest.fn().mockResolvedValue({}) }
        }
      },
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    }
    settings = new Settings(false, context, admin, { restrictedRepos: {} }, 'main')
  })

  it.each([1, 10, 11, 23])('limits %i repositories to batches of ten and preserves result order', async count => {
    const repos = repositories(count)
    context.octokit.paginate.mockResolvedValue(repos)
    const pending = new Map()
    let active = 0
    let maxActive = 0
    const update = jest.spyOn(settings, 'updateRepos').mockImplementation(({ repo }) => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise(resolve => {
        pending.set(repo, () => {
          active--
          resolve([repo])
        })
      })
    })

    const sync = settings.eachRepositoryRepos(context.octokit, context.log)
    await new Promise(resolve => setImmediate(resolve))

    for (let offset = 0; offset < count; offset += 10) {
      const batch = repos.slice(offset, offset + 10)
      expect(active).toBe(batch.length)
      expect(update).toHaveBeenCalledTimes(offset + batch.length)
      // Finish out of order, leaving one repository pending in this batch.
      for (const repo of batch.slice(1).reverse()) pending.get(repo.name)()
      await new Promise(resolve => setImmediate(resolve))
      expect(active).toBe(1)
      expect(update).toHaveBeenCalledTimes(offset + batch.length)
      pending.get(batch[0].name)()
      await new Promise(resolve => setImmediate(resolve))
    }

    expect(await sync).toEqual(repos.map(repo => [repo.name]))
    expect(maxActive).toBe(Math.min(10, count))
    expect(active).toBe(0)
    expect(settings.processedRepoNames).toEqual(new Set(repos.map(repo => repo.name)))
    expect(update).toHaveBeenCalledWith({ owner: admin.owner, repo: 'repo-0' })
    expect(context.octokit.paginate).toHaveBeenCalledWith('GET /installation/repositories')
  })

  it.each([false, true])('continues after failures in every batch and records errors (nop=%s)', async nop => {
    settings.nop = nop
    const repos = repositories(23)
    const failures = new Map([
      ['repo-0', new Error('first batch failure')],
      ['repo-12', 'second batch failure'],
      ['repo-22', new Error('last batch failure')]
    ])
    context.octokit.paginate.mockResolvedValue(repos)
    const update = jest.spyOn(settings, 'updateRepos').mockImplementation(async ({ repo }) => {
      if (failures.has(repo)) throw failures.get(repo)
      return [repo]
    })

    const results = await settings.eachRepositoryRepos(context.octokit, context.log)

    expect(update).toHaveBeenCalledTimes(23)
    expect(results).toEqual(repos.filter(repo => !failures.has(repo.name)).map(repo => [repo.name]))
    expect(settings.processedRepoNames).toEqual(new Set(repos.map(repo => repo.name)))
    expect(settings.errors).toEqual(Array.from(failures, ([repo, reason]) => ({
      owner: admin.owner,
      repo,
      plugin: 'Settings',
      msg: `Error processing repository ${admin.owner}/${repo}: ${reason}`
    })))
    expect(context.log.error.mock.calls).toEqual(settings.errors.map(error => [error.msg]))
    expect(settings.results).toEqual(nop
      ? settings.errors.map(error => new NopCommand('Settings', error, null, error.msg, 'ERROR'))
      : [])
    expect(settings.repo).toBe(admin)
  })

  it('waits for the rest of a failing batch before starting later repositories', async () => {
    context.octokit.paginate.mockResolvedValue(repositories(11))
    let release
    const update = jest.spyOn(settings, 'updateRepos').mockImplementation(async ({ repo }) => {
      if (repo === 'repo-0') throw new Error('failed')
      if (repo === 'repo-1') await new Promise(resolve => { release = resolve })
      return repo
    })

    const sync = settings.eachRepositoryRepos(context.octokit, context.log)
    await new Promise(resolve => setImmediate(resolve))
    expect(update).toHaveBeenCalledTimes(10)
    release()
    expect(await sync).toEqual(repositories(11).slice(1).map(repo => repo.name))
    expect(update).toHaveBeenCalledTimes(11)
    expect(settings.errors).toHaveLength(1)
  })

  it('returns an empty array for an empty installation', async () => {
    const update = jest.spyOn(settings, 'updateRepos')

    expect(await settings.eachRepositoryRepos(context.octokit, context.log)).toEqual([])
    expect(update).not.toHaveBeenCalled()
    expect(settings.errors).toEqual([])
  })

  it('retains null, undefined and nested successful results without flattening', async () => {
    context.octokit.paginate.mockResolvedValue(repositories(3))
    jest.spyOn(settings, 'updateRepos')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([['last']])

    expect(await settings.eachRepositoryRepos(context.octokit, context.log))
      .toEqual([null, undefined, [['last']]])
  })

  it.each([
    [{ include: ['repo-0', 'repo-12'] }, ['repo-0', 'repo-12']],
    [{ exclude: ['repo-*'] }, []],
    [['repo-*'], []]
  ])('preserves repository restrictions %j across batches', async (restrictedRepos, included) => {
    settings.config.restrictedRepos = restrictedRepos
    const repos = repositories(13)
    context.octokit.paginate.mockResolvedValue(repos)
    const update = jest.spyOn(settings, 'updateRepos').mockImplementation(async ({ repo }) => repo)

    expect(await settings.eachRepositoryRepos(context.octokit, context.log))
      .toEqual(repos.map(repo => included.includes(repo.name) ? repo.name : null))
    expect(update.mock.calls).toEqual(included.map(repo => [{ owner: admin.owner, repo }]))
    expect(settings.processedRepoNames).toEqual(new Set(repos.map(repo => repo.name)))
    expect(settings.errors).toEqual([])
  })

  it('preserves suborg selection through the real repository-processing path', async () => {
    context.octokit.paginate.mockResolvedValue(repositories(13))
    settings.subOrgConfigMap = [{ name: 'selected', path: '.github/suborgs/selected.yml' }]
    settings.subOrgConfigs = { 'repo-0': {}, 'repo-12': {} }
    settings.repoConfigs = {}
    const sync = jest.fn().mockResolvedValue([])
    class Plugin {
      constructor (nop, github, repo) {
        this.repo = repo
      }

      sync () { return sync(this.repo) }
    }
    jest.spyOn(settings, 'childPluginsList').mockReturnValue([[Plugin, {}, 'labels']])

    await settings.eachRepositoryRepos(context.octokit, context.log)

    expect(sync.mock.calls).toEqual([
      [{ owner: admin.owner, repo: 'repo-0' }],
      [{ owner: admin.owner, repo: 'repo-12' }]
    ])
    expect(settings.errors).toEqual([])
  })

  it('propagates installation-list failures to the caller', async () => {
    const error = new Error('installation unavailable')
    context.octokit.paginate.mockRejectedValue(error)
    const update = jest.spyOn(settings, 'updateRepos')

    await expect(settings.eachRepositoryRepos(context.octokit, context.log)).rejects.toBe(error)
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['apply', 'pull-request', 'full-sync'])('reports failures and later successes through syncAll in %s mode', async mode => {
    const nop = mode !== 'apply'
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    if (mode === 'pull-request') {
      context.payload.repository = { owner: { login: admin.owner }, name: admin.repo }
      context.payload.check_run = { id: 42, check_suite: { pull_requests: [{ number: 1 }] } }
    }
    context.octokit.paginate.mockResolvedValue(repositories(12))
    jest.spyOn(Settings.prototype, 'loadConfigs').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'updateOrg').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
    const orgRulesets = jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    const changes = []
    const update = jest.spyOn(Settings.prototype, 'updateRepos').mockImplementation(async repo => {
      if (repo.repo === 'repo-0') throw new Error('unavailable')
      const change = new NopCommand('Labels', repo, null, {
        additions: [{ name: repo.repo }], deletions: [], modifications: []
      })
      changes.push(change)
      return [[change]]
    })
    const config = { restrictedRepos: {} }

    const result = await Settings.syncAll(nop, context, admin, config, 'main', config, {
      repos: [{ owner: admin.owner, repo: 'new-repo' }, { owner: admin.owner, repo: 'repo-0' }]
    })

    expect(orgRulesets).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(13)
    expect(update).toHaveBeenLastCalledWith({ owner: admin.owner, repo: 'new-repo' })
    expect(result.errors).toEqual([{
      owner: admin.owner,
      repo: 'repo-0',
      plugin: 'Settings',
      msg: `Error processing repository ${admin.owner}/repo-0: Error: unavailable`
    }])
    expect(result.results).toEqual(nop ? expect.arrayContaining(changes.slice(0, 11)) : [])
    if (mode === 'apply') {
      const check = context.octokit.rest.checks.create.mock.calls[0][0]
      expect(check.conclusion).toBe('failure')
      expect(check.output.text).toContain('repo-0')
      expect(check.output.text).toContain('unavailable')
    } else if (mode === 'pull-request') {
      const check = context.octokit.rest.checks.update.mock.calls[0][0]
      expect(check.conclusion).toBe('failure')
      const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
      for (const output of [check.output.summary, comment.body]) {
        expect(output).toContain('repo-0')
        expect(output).toContain('unavailable')
        expect(output).toContain('repo-11')
      }
    } else {
      expect(context.log.debug).toHaveBeenCalledWith({ results: result.results }, 'Dry-run results')
      expect(context.log.info).toHaveBeenCalledWith(expect.stringContaining('ERROR Settings repo-0'))
      expect(context.octokit.rest.checks.create).not.toHaveBeenCalled()
      expect(context.octokit.rest.checks.update).not.toHaveBeenCalled()
    }
  })

  it('continues through later suborgs and app installations after a repository failure', async () => {
    const subOrgs = [
      { name: 'first', path: '.github/suborgs/first.yml' },
      { name: 'second', path: '.github/suborgs/second.yml' }
    ]
    context.octokit.paginate.mockResolvedValue(repositories(12))
    jest.spyOn(Settings.prototype, 'getSubOrgConfigs').mockResolvedValue({})
    jest.spyOn(Settings.prototype, 'loadConfigs').mockResolvedValue()
    const orgRulesets = jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    const apps = jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
    const update = jest.spyOn(Settings.prototype, 'updateRepos').mockImplementation(async function ({ repo }) {
      if (this.subOrgConfigMap[0].name === 'first' && repo === 'repo-0') {
        throw new Error('first suborg failure')
      }
      return []
    })

    await Settings.syncSelectedRepos(false, context, [], subOrgs, { restrictedRepos: {} }, 'main')

    expect(update).toHaveBeenCalledTimes(24)
    expect(update).toHaveBeenLastCalledWith({ owner: admin.owner, repo: 'repo-11' })
    expect(orgRulesets).toHaveBeenCalledTimes(1)
    expect(apps).toHaveBeenCalledTimes(1)
    const check = context.octokit.rest.checks.create.mock.calls[0][0]
    expect(check.conclusion).toBe('failure')
    expect(check.output.text).toContain('first suborg failure')
  })

  it.each(['archive', 'repository', 'child'])('retains caught %s failures through real NOP processing and full-sync exit status', async stage => {
    const repos = repositories(12)
    const failedRepos = ['repo-0', 'repo-10']
    const fail = repo => {
      if (failedRepos.includes(repo.repo)) throw new Error(`${stage} failed for ${repo.repo}`)
    }
    context.octokit.paginate.mockResolvedValue(repos)
    jest.spyOn(Settings.prototype, 'getSubOrgConfigs').mockResolvedValue({})
    jest.spyOn(Settings.prototype, 'getRepoConfigs').mockResolvedValue({})
    jest.spyOn(Settings.prototype, 'updateOrg').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncAppInstallations').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'syncOrgLevelRulesets').mockResolvedValue()
    jest.spyOn(Settings.prototype, 'childPluginsList').mockReturnValue([[Labels, [], 'labels']])
    const archive = jest.spyOn(Archive.prototype, 'getState').mockImplementation(async function () {
      if (stage === 'archive') fail(this.repo)
      return { shouldArchive: false, shouldUnarchive: false }
    })
    jest.spyOn(Repository.prototype, 'sync').mockImplementation(async function () {
      if (stage === 'repository') fail(this.repo)
      return []
    })
    const labels = jest.spyOn(Labels.prototype, 'sync').mockImplementation(async function () {
      if (stage === 'child') fail(this.repo)
      return [new NopCommand('Labels', this.repo, null, {
        additions: [{ name: this.repo.repo }], modifications: [], deletions: []
      })]
    })

    const result = await Settings.syncAll(true, context, admin, {
      restrictedRepos: {}, repository: {}
    }, 'main')

    // Execute the real CLI entrypoint with this sync's error collection.
    const cli = spawnSync(process.execPath, ['-e', `
      const fs = require('fs')
      const vm = require('vm')
      const settings = JSON.parse(fs.readFileSync(0, 'utf8'))
      vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), {
        require: name => {
          if (name === './') return () => ({ syncInstallation: async () => settings })
          if (name === './lib/env') return { FULL_SYNC_NOP: true }
          if (name === 'probot') return { createProbot: () => ({ log: console }) }
          throw new Error('Unexpected dependency: ' + name)
        },
        process,
        console
      })
    `, require.resolve('../../../full-sync')], {
      input: JSON.stringify({ errors: result.errors }),
      encoding: 'utf8'
    })
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('Errors occurred during full sync.')
    expect(cli.stdout).not.toContain('Full sync completed successfully.')

    expect(archive).toHaveBeenCalledTimes(12)
    expect(labels.mock.instances.at(-1).repo).toEqual({ owner: admin.owner, repo: 'repo-11' })
    expect(result.processedRepoNames).toEqual(new Set(repos.map(repo => repo.name)))
    expect(result.repo).toBe(admin)
    expect(result.errors).toEqual(failedRepos.map(repo => ({
      owner: admin.owner, repo, plugin: 'Settings', msg: `Error: ${stage} failed for ${repo}`
    })))
    expect(result.results.filter(row => row.type === 'ERROR')).toEqual(
      result.errors.map(error => new NopCommand('Settings', error, null, error.msg, 'ERROR'))
    )
    expect(result.results.filter(row => row.plugin === 'Labels').map(row => row.repo))
      .toEqual(repos.filter(repo => !failedRepos.includes(repo.name)).map(repo => repo.name))
    expect(context.log.error.mock.calls).toEqual(result.errors.map(error => [error.msg]))

    context.payload.repository = { owner: { login: admin.owner }, name: admin.repo }
    context.payload.check_run = { id: 42, check_suite: { pull_requests: [{ number: 1 }] } }
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    await result.handleResults()
    const check = context.octokit.rest.checks.update.mock.calls[0][0]
    const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
    expect(check.conclusion).toBe('failure')
    for (const output of [check.output.summary, comment.body]) {
      for (const repo of failedRepos) expect(output).toContain(`**${repo}**`)
      expect(output).toContain('repo-11')
    }
  })

  it.each([false, true])('keeps logError default attribution (nop=%s)', nop => {
    settings.nop = nop

    settings.logError('configuration failed')

    expect(settings.errors).toEqual([{ ...admin, plugin: 'Settings', msg: 'configuration failed' }])
    expect(settings.results).toEqual(nop ? [new NopCommand('Settings', admin, null, 'configuration failed', 'ERROR')] : [])
  })
})
