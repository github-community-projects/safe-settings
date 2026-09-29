/* eslint-disable no-undef */
const path = require('path')
const { spawnSync } = require('child_process')

jest.mock('node-cron', () => ({ schedule: jest.fn() }))

function installation (id, login) {
  return { id, account: { login } }
}

function client () {
  return {
    rest: {
      apps: {
        getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'safe-settings' } })
      },
      repos: {
        getContent: jest.fn().mockResolvedValue({ data: { content: '' } })
      }
    }
  }
}

describe('syncInstallation', () => {
  const originalEnv = process.env
  let robot, appClient, clients, syncAll, handleError

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv }
    for (const key of ['GH_ORG', 'GH_ENTERPRISE', 'CRON', 'ADMIN_REPO', 'CONFIG_PATH', 'SETTINGS_FILE_PATH']) {
      delete process.env[key]
    }
    process.env.DEPLOYMENT_CONFIG_FILE = path.join(__dirname, 'no-such-deployment-settings.yml')
    appClient = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn(options => options) } }
        }
      }
    }
    clients = new Map([[1, client()], [2, client()], [3, client()]])
    robot = {
      auth: jest.fn(async id => {
        if (id === undefined) return appClient
        if (!clients.has(id)) throw new Error(`Unexpected installation ${id}`)
        return clients.get(id)
      }),
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() },
      on: jest.fn()
    }
    syncAll = jest.fn().mockResolvedValue({ errors: [] })
    handleError = jest.fn()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  async function load (ghOrg, installations) {
    if (ghOrg !== undefined) process.env.GH_ORG = ghOrg
    appClient.paginate.mockResolvedValue(installations)
    const app = require('../../index')(robot, {}, { syncAll, handleError })
    // info() intentionally authenticates independently to read the app slug.
    await new Promise(resolve => setImmediate(resolve))
    robot.auth.mockClear()
    appClient.paginate.mockClear()
    return app
  }

  function expectSync (selected, nop = false) {
    const repo = { owner: selected.account.login, repo: process.env.ADMIN_REPO || 'admin' }
    expect(syncAll).toHaveBeenCalledTimes(1)
    expect(syncAll).toHaveBeenCalledWith(nop, expect.objectContaining({
      payload: { installation: selected },
      octokit: clients.get(selected.id),
      log: robot.log
    }), repo, expect.any(Object))
    expect(syncAll.mock.calls[0][1].repo()).toEqual(repo)
    expect(clients.get(selected.id).rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining(repo))
    expect(appClient.rest.apps.listInstallations.endpoint.merge).toHaveBeenCalledWith({ per_page: 100 })
  }

  it.each(['my-org', 'MY-ORG', 'My-Org'])('selects only the matching installation for GH_ORG=%s', async ghOrg => {
    const selected = installation(2, 'my-org')
    process.env.ADMIN_REPO = 'config'
    const app = await load(ghOrg, [installation(1, 'other-org'), selected])

    await app.syncInstallation()

    expectSync(selected)
    expect(robot.auth.mock.calls).toEqual([[], [2]])
    expect(clients.get(1).rest.repos.getContent).not.toHaveBeenCalled()
    expect(clients.get(1).rest.apps.getAuthenticated).toHaveBeenCalledTimes(1)
    expect(robot.log.info).toHaveBeenCalledWith('Syncing installation 2 on account my-org')
  })

  it.each([false, true])('rejects an absent target without authenticating or syncing another installation (nop=%s)', async nop => {
    const app = await load('my-org', [installation(1, 'other-org'), installation(2, 'another-org')])

    await expect(app.syncInstallation(nop)).rejects.toThrow(
      "No app installation found for GH_ORG 'my-org'. Installed on: [other-org, another-org]"
    )

    expect(robot.auth.mock.calls).toEqual([[]])
    expect(syncAll).not.toHaveBeenCalled()
    expect(handleError).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects an empty installation list with a configured target (nop=%s)', async nop => {
    const app = await load('my-org', [])

    await expect(app.syncInstallation(nop)).rejects.toThrow(
      "No app installation found for GH_ORG 'my-org'. Installed on: []"
    )
    expect(robot.auth.mock.calls).toEqual([[]])
    expect(syncAll).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('syncs every repository-owning installation with GH_ORG=%s', async ghOrg => {
    const installations = [installation(1, 'first-org'), installation(2, 'second-org')]
    const app = await load(ghOrg, installations)

    const result = await app.syncInstallation()

    expect(result).toEqual({ results: [{ errors: [] }, { errors: [] }], errors: [] })
    expect(robot.auth.mock.calls).toEqual([[], [1], [2]])
    expect(syncAll.mock.calls.map(call => call[2].owner)).toEqual(['first-org', 'second-org'])
    for (const selected of installations) {
      expect(clients.get(selected.id).rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({
        owner: selected.account.login, repo: 'admin'
      }))
    }
  })

  it('still returns null when there are no installations and no configured org', async () => {
    const app = await load(undefined, [])

    await expect(app.syncInstallation()).resolves.toBeNull()
    expect(syncAll).not.toHaveBeenCalled()
  })

  it('passes the NOP flag and retains the selected result and errors in the aggregate', async () => {
    const selected = installation(2, 'my-org')
    const result = { errors: [{ msg: 'existing sync error' }] }
    syncAll.mockResolvedValue(result)
    const app = await load('my-org', [installation(1, 'other-org'), selected])

    const aggregate = await app.syncInstallation(true)
    expect(aggregate).toEqual({ results: [result], errors: result.errors })
    expect(aggregate.results[0]).toBe(result)
    expect(robot.auth.mock.calls).toEqual([[], [2]])
    expectSync(selected, true)
  })

  it('preserves enterprise enrichment and selects an org rather than an enterprise account', async () => {
    const selected = { ...installation(2, 'my-org'), enterprise: { slug: 'My-Enterprise' } }
    const enterprise = { id: 3, target_type: 'Enterprise', account: { slug: 'my-enterprise' } }
    const app = await load('my-org', [installation(1, 'other-org'), enterprise, selected])

    await app.syncInstallation()

    expectSync(selected)
    expect(syncAll.mock.calls[0][1]).toMatchObject({
      enterpriseSlug: 'My-Enterprise',
      appGithub: clients.get(3)
    })
    expect(robot.auth.mock.calls).toEqual([[], [2], [], [3]])
    expect(clients.get(1).rest.repos.getContent).not.toHaveBeenCalled()
    expect(clients.get(3).rest.repos.getContent).not.toHaveBeenCalled()
  })

  it.each([
    [{ id: 1, target_type: 'Enterprise', account: { login: 'my-org', slug: 'my-org' } }],
    [{ id: 1, account: { login: 42 } }]
  ])('does not select enterprise or malformed accounts for a configured org: %j', async entries => {
    const app = await load('my-org', [entries])

    await expect(app.syncInstallation()).rejects.toThrow("No app installation found for GH_ORG 'my-org'")
    expect(robot.auth.mock.calls).toEqual([[]])
    expect(syncAll).not.toHaveBeenCalled()
  })

  it.each(['listing', 'authentication', 'config', 'sync'])('retains %s failures without syncing an untargeted installation', async stage => {
    const error = new Error(`${stage} failed`)
    const app = await load('my-org', [installation(1, 'other-org'), installation(2, 'my-org')])
    if (stage === 'listing') appClient.paginate.mockRejectedValue(error)
    if (stage === 'authentication') {
      robot.auth.mockImplementation(async id => {
        if (id !== undefined) throw error
        return appClient
      })
    }
    if (stage === 'config') clients.get(2).rest.repos.getContent.mockRejectedValue(error)
    if (stage === 'sync') syncAll.mockRejectedValue(error)

    if (stage === 'listing') {
      await expect(app.syncInstallation()).rejects.toBe(error)
    } else {
      await expect(app.syncInstallation()).resolves.toEqual({ results: [], errors: [error] })
    }
    if (stage !== 'sync') expect(syncAll).not.toHaveBeenCalled()
    expect(clients.get(1).rest.repos.getContent).not.toHaveBeenCalled()
  })

  it('returns the scheduled promise so node-cron reports targeting failures instead of success', async () => {
    process.env.CRON = '* * * * *'
    await load('my-org', [installation(1, 'other-org')])
    const schedule = require('node-cron').schedule
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function))

    await expect(schedule.mock.calls[0][1]()).rejects.toThrow("No app installation found for GH_ORG 'my-org'")
    expect(syncAll).not.toHaveBeenCalled()
  })

  it('reports a targeted NOP configuration failure without falling back to another installation', async () => {
    const failure = new Error('invalid target configuration')
    const app = await load('my-org', [installation(1, 'other-org'), installation(2, 'my-org')])
    clients.get(2).rest.repos.getContent.mockRejectedValue(failure)

    const result = await app.syncInstallation(true)

    expect(result.results).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain('installation 2 for my-org returned no result')
    expect(handleError).toHaveBeenCalledTimes(1)
    expect(handleError.mock.calls[0][2]).toEqual({ owner: 'my-org', repo: 'admin' })
    expect(robot.auth.mock.calls).toEqual([[], [2]])
    expect(clients.get(1).rest.repos.getContent).not.toHaveBeenCalled()
    expect(syncAll).not.toHaveBeenCalled()
  })

  it('awaits successful scheduled syncs', async () => {
    process.env.CRON = '* * * * *'
    await load('my-org', [installation(2, 'my-org')])
    const result = { errors: [] }
    syncAll.mockResolvedValue(result)

    await expect(require('node-cron').schedule.mock.calls[0][1]()).resolves.toEqual({ results: [result], errors: [] })
  })

  it('reports a failed execution through the real node-cron task lifecycle', async () => {
    process.env.CRON = '* * * * *'
    await load('my-org', [installation(1, 'other-org')])
    const callback = require('node-cron').schedule.mock.calls[0][1]
    const task = jest.requireActual('node-cron').createTask('* * * * *', callback)
    const failed = jest.fn()
    const finished = jest.fn()
    task.on('execution:failed', failed)
    task.on('execution:finished', finished)
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(task.execute()).rejects.toThrow("No app installation found for GH_ORG 'my-org'")
      expect(failed).toHaveBeenCalledTimes(1)
      expect(finished).not.toHaveBeenCalled()
      expect(logged).toHaveBeenCalled()
    } finally {
      task.destroy()
    }
  })

  it.each([false, true])('exits the real full-sync CLI nonzero on targeting failure (nop=%s)', nop => {
    const cli = spawnSync(process.execPath, ['-e', `
      const fs = require('fs')
      const vm = require('vm')
      const plugin = require(process.argv[1])
      const github = {
        paginate: async () => [{ id: 1, account: { login: 'other-org' } }],
        rest: { apps: {
          listInstallations: { endpoint: { merge: options => options } },
          getAuthenticated: async () => ({ data: { slug: 'safe-settings' } })
        } }
      }
      const robot = { auth: async () => github, on: () => {}, log: console, ready: async () => robot }
      vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), {
        require: name => {
          if (name === './') return (robot, options) => plugin(robot, options, {
            syncAll: () => { throw new Error('Wrong account synced') }
          })
          if (name === './lib/env') return { FULL_SYNC_NOP: process.env.FULL_SYNC_NOP === 'true' }
          if (name === 'probot') return { createProbot: () => robot }
          throw new Error('Unexpected dependency: ' + name)
        },
        process,
        console
      })
    `, require.resolve('../../index'), require.resolve('../../full-sync')], {
      encoding: 'utf8',
      env: { ...process.env, GH_ORG: 'my-org', FULL_SYNC_NOP: String(nop) },
      timeout: 10000
    })

    expect(cli.error).toBeUndefined()
    expect(cli.status).toBe(1)
    expect(cli.stdout).toContain(`Starting full sync with NOP=${nop}`)
    expect(cli.stdout).toContain("No app installation found for GH_ORG 'my-org'")
    expect(cli.stdout).not.toContain('Wrong account synced')
    expect(cli.stdout).not.toContain('Full sync completed successfully.')
  })
})

const flush = () => new Promise(resolve => setImmediate(resolve))

describe('syncInstallation fanout', () => {
  const installation = (id, login, targetType = 'Organization') => ({
    id, target_type: targetType, account: { login, type: targetType }
  })
  let plugin, ConfigManager, cron
  let robot, Settings, installations, appGithub, clients, loadConfig, savedEnv

  const createApp = async () => {
    const app = plugin(robot, {}, Settings)
    // Startup info() runs independently of the full-sync operation.
    await flush()
    robot.auth.mockClear()
    robot.log.info.mockClear()
    appGithub.paginate.mockClear()
    return app
  }

  beforeEach(() => {
    jest.resetModules()
    savedEnv = process.env
    process.env = { ...savedEnv }
    delete process.env.CRON
    delete process.env.GH_ENTERPRISE
    delete process.env.GH_ORG
    process.env.ADMIN_REPO = 'admin'
    process.env.CONFIG_PATH = '.github'
    process.env.SETTINGS_FILE_PATH = 'settings.yml'
    process.env.DEPLOYMENT_CONFIG_FILE = 'test/fixtures/no-deployment-settings.yml'
    plugin = require('../../index')
    ConfigManager = require('../../lib/configManager')
    cron = require('node-cron')
    installations = [installation(1, 'org-one'), installation(2, 'org-two')]
    clients = new Map()
    appGithub = {
      paginate: jest.fn(async () => installations),
      rest: { apps: { listInstallations: { endpoint: { merge: jest.fn(options => options) } } } }
    }
    robot = {
      on: jest.fn(),
      auth: jest.fn(async id => {
        if (id === undefined) return appGithub
        if (!clients.has(id)) {
          clients.set(id, {
            id,
            rest: { apps: { getAuthenticated: jest.fn(async () => ({ data: { slug: 'safe-settings' } })) } }
          })
        }
        return clients.get(id)
      }),
      log: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() }
    }
    Settings = {
      syncAll: jest.fn(async () => ({ errors: [] })),
      handleError: jest.fn(async () => {})
    }
    loadConfig = jest.spyOn(ConfigManager.prototype, 'loadGlobalSettingsYaml').mockResolvedValue({})
    cron.schedule.mockClear()
  })

  afterEach(() => {
    process.env = savedEnv
  })

  it.each([false, true])('syncs every installation with isolated owner, auth and NOP=%s', async nop => {
    const app = await createApp()
    const result = await app.syncInstallation(nop)

    expect(appGithub.paginate).toHaveBeenCalledWith({ per_page: 100 })
    expect(robot.auth.mock.calls).toEqual([[], [1], [2]])
    expect(Settings.syncAll).toHaveBeenCalledTimes(2)
    for (const [index, call] of Settings.syncAll.mock.calls.entries()) {
      const [actualNop, context, repo] = call
      expect(actualNop).toBe(nop)
      expect(context.payload).toEqual({ installation: installations[index] })
      expect(context.octokit).toBe(clients.get(index + 1))
      expect(repo).toEqual({ repo: 'admin', owner: installations[index].account.login })
      expect(context.repo()).toEqual(repo)
      expect(loadConfig.mock.instances[index].context).toBe(context)
    }
    expect(result).toEqual({ results: [{ errors: [] }, { errors: [] }], errors: [] })
    expect(robot.log.info.mock.calls).toEqual([
      ['Syncing installation 1 on account org-one'],
      ['Syncing installation 2 on account org-two'],
      ['Synced 2 of 2 installation(s); 0 failed']
    ])
  })

  it('waits for each authentication and sync before starting the next installation', async () => {
    const app = await createApp()
    let releaseAuth, releaseSync
    robot.auth.mockImplementationOnce(async () => appGithub)
      .mockImplementationOnce(() => new Promise(resolve => { releaseAuth = resolve }))
    Settings.syncAll.mockImplementationOnce(() => new Promise(resolve => { releaseSync = resolve }))

    const pending = app.syncInstallation()
    await flush()
    expect(robot.auth.mock.calls).toEqual([[], [1]])
    expect(Settings.syncAll).not.toHaveBeenCalled()
    releaseAuth(clients.get(1))
    await flush()
    expect(Settings.syncAll).toHaveBeenCalledTimes(1)
    expect(robot.auth.mock.calls).toEqual([[], [1]])
    releaseSync({ errors: [] })
    await pending
    expect(robot.auth.mock.calls).toEqual([[], [1], [2]])
    expect(Settings.syncAll).toHaveBeenCalledTimes(2)
  })

  it('retains returned results and errors while counting each failed installation once', async () => {
    const first = { errors: [{ owner: 'org-one', msg: 'first' }, { owner: 'org-one', msg: 'second' }] }
    const second = { errors: [] }
    Settings.syncAll.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const app = await createApp()
    const result = await app.syncInstallation()

    expect(result.results).toEqual([first, second])
    expect(result.results[0]).toBe(first)
    expect(result.errors).toEqual(first.errors)
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1 for org-one'))
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it('continues after installation authentication fails', async () => {
    const app = await createApp()
    const failure = new Error('installation suspended')
    robot.auth.mockImplementationOnce(async () => appGithub).mockRejectedValueOnce(failure)
    const result = await app.syncInstallation()

    expect(robot.auth.mock.calls).toEqual([[], [1], [2]])
    expect(Settings.syncAll).toHaveBeenCalledTimes(1)
    expect(Settings.syncAll.mock.calls[0][2].owner).toBe('org-two')
    expect(result).toEqual({ results: [{ errors: [] }], errors: [failure] })
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1 for org-one'))
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it.each([false, true])('continues after configuration loading fails in NOP=%s', async nop => {
    const failure = new Error('invalid configuration')
    loadConfig.mockRejectedValueOnce(failure)
    const app = await createApp()
    const result = await app.syncInstallation(nop)

    expect(loadConfig).toHaveBeenCalledTimes(2)
    expect(Settings.syncAll).toHaveBeenCalledTimes(1)
    expect(Settings.syncAll.mock.calls[0][2].owner).toBe('org-two')
    expect(result.results).toEqual([{ errors: [] }])
    expect(result.errors).toHaveLength(1)
    if (nop) {
      expect(Settings.handleError).toHaveBeenCalledTimes(1)
      expect(Settings.handleError.mock.calls[0][2]).toEqual({ owner: 'org-one', repo: 'admin' })
      expect(result.errors[0].message).toContain('returned no result')
    } else {
      expect(result.errors).toEqual([failure])
      expect(Settings.handleError).not.toHaveBeenCalled()
    }
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it.each([false, true])('continues after a sync rejects in NOP=%s', async nop => {
    const failure = new Error('sync failed')
    Settings.syncAll.mockRejectedValueOnce(failure)
    const app = await createApp()
    const result = await app.syncInstallation(nop)

    expect(Settings.syncAll).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ results: [{ errors: [] }], errors: [failure] })
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1 for org-one'))
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it('waits for NOP error reporting before starting the next installation', async () => {
    loadConfig.mockRejectedValueOnce(new Error('config'))
    let finishReporting
    Settings.handleError.mockImplementationOnce(() => new Promise(resolve => { finishReporting = resolve }))
    const app = await createApp()
    const pending = app.syncInstallation(true)
    await flush()
    expect(Settings.handleError).toHaveBeenCalledTimes(1)
    expect(robot.auth.mock.calls).toEqual([[], [1]])
    expect(Settings.syncAll).not.toHaveBeenCalled()
    finishReporting()
    const result = await pending
    expect(Settings.syncAll.mock.calls[0][2].owner).toBe('org-two')
    expect(result.errors[0].message).toContain('returned no result')
  })

  it('collects a rejected NOP error reporter and continues with later installations', async () => {
    loadConfig.mockRejectedValueOnce(new Error('config'))
    const failure = new Error('reporting failed')
    Settings.handleError.mockRejectedValueOnce(failure)
    const app = await createApp()
    const result = await app.syncInstallation(true)
    expect(result.errors).toEqual([failure])
    expect(Settings.syncAll.mock.calls[0][2].owner).toBe('org-two')
  })

  it.each([undefined, null])('treats missing result %s as failure, not success', async missing => {
    Settings.syncAll.mockResolvedValueOnce(missing)
    const app = await createApp()
    const result = await app.syncInstallation(true)

    expect(Settings.syncAll).toHaveBeenCalledTimes(2)
    expect(result.results).toEqual([{ errors: [] }])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain('installation 1 for org-one returned no result')
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('returned no result'))
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it('aggregates auth, config, thrown, missing and returned errors before a later success', async () => {
    installations = Array.from({ length: 6 }, (_, i) => installation(i + 1, `org-${i + 1}`))
    const authFailure = new Error('auth')
    const configFailure = new Error('config')
    const syncFailure = new Error('sync')
    const returnedError = { owner: 'org-5', msg: 'repository failure' }
    loadConfig.mockRejectedValueOnce(configFailure)
    Settings.syncAll.mockRejectedValueOnce(syncFailure)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ errors: [returnedError] })
    const app = await createApp()
    robot.auth.mockImplementationOnce(async () => appGithub).mockRejectedValueOnce(authFailure)

    const result = await app.syncInstallation()

    expect(robot.auth.mock.calls).toEqual([[], [1], [2], [3], [4], [5], [6]])
    expect(result.errors).toEqual([authFailure, configFailure, syncFailure, expect.any(Error), returnedError])
    expect(result.results).toEqual([{ errors: [returnedError] }, { errors: [] }])
    expect(Settings.syncAll.mock.calls.at(-1)[2].owner).toBe('org-6')
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 6 installation(s); 5 failed')
  })

  it('skips enterprise-only installations without dropping repo-owning user installations', async () => {
    installations.unshift({ id: 3, target_type: 'Enterprise', account: { slug: 'enterprise' } })
    installations.push(installation(4, 'personal-account', 'User'))
    const app = await createApp()
    const result = await app.syncInstallation()

    expect(robot.auth.mock.calls).toEqual([[], [1], [2], [4]])
    expect(Settings.syncAll.mock.calls.map(call => call[2].owner)).toEqual(['org-one', 'org-two', 'personal-account'])
    expect(result.errors).toEqual([])
    expect(robot.log.debug).toHaveBeenCalledWith(expect.stringContaining('Skipping enterprise installation 3'))
    expect(robot.log.info).toHaveBeenCalledWith('Synced 3 of 3 installation(s); 0 failed')
  })

  it.each([null, {}, { login: '' }])('reports malformed account %s instead of syncing an undefined owner', async account => {
    installations[0].account = account
    const app = await createApp()
    const result = await app.syncInstallation()

    expect(robot.auth.mock.calls).toEqual([[], [2]])
    expect(Settings.syncAll.mock.calls.map(call => call[2].owner)).toEqual(['org-two'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain('account login')
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1'))
  })

  it('preserves per-enterprise enrichment without using enterprise tokens as repo tokens', async () => {
    installations[0].enterprise = { slug: 'enterprise-one' }
    installations[1].enterprise = { slug: 'enterprise-two' }
    installations.push(
      { id: 3, target_type: 'Enterprise', account: { slug: 'enterprise-one' } },
      { id: 4, target_type: 'Enterprise', account: { slug: 'enterprise-two' } }
    )
    const app = await createApp()
    const result = await app.syncInstallation()

    expect(result.results).toHaveLength(2)
    const contexts = Settings.syncAll.mock.calls.map(call => call[1])
    expect(contexts[0].octokit).toBe(clients.get(1))
    expect(contexts[0].appGithub).toBe(clients.get(3))
    expect(contexts[0].enterpriseSlug).toBe('enterprise-one')
    expect(contexts[1].octokit).toBe(clients.get(2))
    expect(contexts[1].appGithub).toBe(clients.get(4))
    expect(contexts[1].enterpriseSlug).toBe('enterprise-two')
    expect(Settings.syncAll.mock.calls.map(call => call[2].owner)).toEqual(['org-one', 'org-two'])
  })

  it.each([[[]], [[{ id: 3, target_type: 'Enterprise', account: { slug: 'enterprise' } }]]])(
    'returns null when there are no repo-owning installations: %j',
    async entries => {
      installations = entries
      const app = await createApp()
      expect(await app.syncInstallation()).toBeNull()
      expect(Settings.syncAll).not.toHaveBeenCalled()
      expect(robot.auth.mock.calls).toEqual([[]])
    }
  )

  it('rejects an installation enumeration failure rather than returning success', async () => {
    const app = await createApp()
    const failure = new Error('enumeration failed')
    appGithub.paginate.mockRejectedValueOnce(failure)
    await expect(app.syncInstallation()).rejects.toBe(failure)
    expect(Settings.syncAll).not.toHaveBeenCalled()
    expect(robot.log.info).not.toHaveBeenCalled()
  })

  it('returns the scheduled sync promise and logs its aggregate failures', async () => {
    process.env.CRON = '* * * * *'
    Settings.syncAll.mockResolvedValueOnce({ errors: ['failed'] })
    await createApp()
    expect(cron.schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function))
    const pending = cron.schedule.mock.calls[0][1]()
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(Settings.syncAll).toHaveBeenCalledTimes(2)
    expect(robot.log.info).toHaveBeenCalledWith('Synced 1 of 2 installation(s); 1 failed')
  })

  it('logs and rejects scheduled enumeration failures for node-cron reporting', async () => {
    process.env.CRON = '* * * * *'
    await createApp()
    const failure = new Error('enumeration failed')
    appGithub.paginate.mockRejectedValueOnce(failure)
    await expect(cron.schedule.mock.calls[0][1]()).rejects.toBe(failure)
    await flush()
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('Scheduled full sync failed: Error: enumeration failed'))
    expect(Settings.syncAll).not.toHaveBeenCalled()
  })
})
