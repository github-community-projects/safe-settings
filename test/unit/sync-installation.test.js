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

  it.each([undefined, ''])('preserves the first-installation default with GH_ORG=%s', async ghOrg => {
    const selected = installation(1, 'first-org')
    const app = await load(ghOrg, [selected, installation(2, 'second-org')])

    await app.syncInstallation()

    expectSync(selected)
    expect(robot.auth.mock.calls).toEqual([[], [1]])
    expect(clients.get(2).rest.repos.getContent).not.toHaveBeenCalled()
  })

  it('still returns null when there are no installations and no configured org', async () => {
    const app = await load(undefined, [])

    await expect(app.syncInstallation()).resolves.toBeNull()
    expect(syncAll).not.toHaveBeenCalled()
  })

  it('passes the NOP flag and returns the original sync result', async () => {
    const selected = installation(2, 'my-org')
    const result = { errors: [{ msg: 'existing sync error' }] }
    syncAll.mockResolvedValue(result)
    const app = await load('my-org', [installation(1, 'other-org'), selected])

    await expect(app.syncInstallation(true)).resolves.toBe(result)
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

  it.each(['listing', 'authentication', 'config', 'sync'])('preserves original %s failures', async stage => {
    const error = new Error(`${stage} failed`)
    const app = await load('my-org', [installation(2, 'my-org')])
    if (stage === 'listing') appClient.paginate.mockRejectedValue(error)
    if (stage === 'authentication') {
      robot.auth.mockImplementation(async id => {
        if (id !== undefined) throw error
        return appClient
      })
    }
    if (stage === 'config') clients.get(2).rest.repos.getContent.mockRejectedValue(error)
    if (stage === 'sync') syncAll.mockRejectedValue(error)

    await expect(app.syncInstallation()).rejects.toBe(error)
    if (stage !== 'sync') expect(syncAll).not.toHaveBeenCalled()
  })

  it('returns the scheduled promise so node-cron reports targeting failures instead of success', async () => {
    process.env.CRON = '* * * * *'
    await load('my-org', [installation(1, 'other-org')])
    const schedule = require('node-cron').schedule
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function))

    await expect(schedule.mock.calls[0][1]()).rejects.toThrow("No app installation found for GH_ORG 'my-org'")
    expect(syncAll).not.toHaveBeenCalled()
  })

  it('awaits successful scheduled syncs', async () => {
    process.env.CRON = '* * * * *'
    await load('my-org', [installation(2, 'my-org')])
    const result = { errors: [] }
    syncAll.mockResolvedValue(result)

    await expect(require('node-cron').schedule.mock.calls[0][1]()).resolves.toBe(result)
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
