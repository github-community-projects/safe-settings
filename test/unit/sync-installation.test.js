const plugin = require('../../index')
const ConfigManager = require('../../lib/configManager')
const cron = require('node-cron')

jest.mock('node-cron', () => ({ schedule: jest.fn() }))
jest.mock('../../lib/env', () => ({
  ADMIN_REPO: 'admin',
  CONFIG_PATH: '.github',
  SETTINGS_FILE_PATH: 'settings.yml',
  DEPLOYMENT_CONFIG_FILE_PATH: 'test/fixtures/no-deployment-settings.yml'
}))

const flush = () => new Promise(resolve => setImmediate(resolve))
const installation = (id, login, targetType = 'Organization') => ({
  id, target_type: targetType, account: { login, type: targetType }
})

describe('syncInstallation', () => {
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
    savedEnv = { ...process.env }
    delete process.env.CRON
    delete process.env.GH_ENTERPRISE
    delete process.env.GH_ORG
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
    expect(robot.log.info.mock.calls).toEqual([['Synced 2 of 2 installation(s); 0 failed']])
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

  it('logs scheduled enumeration failures without leaving an unhandled rejection', async () => {
    process.env.CRON = '* * * * *'
    await createApp()
    const failure = new Error('enumeration failed')
    appGithub.paginate.mockRejectedValueOnce(failure)
    await cron.schedule.mock.calls[0][1]()
    await flush()
    expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('Scheduled full sync failed: Error: enumeration failed'))
    expect(Settings.syncAll).not.toHaveBeenCalled()
  })
})
