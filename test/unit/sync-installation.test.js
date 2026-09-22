const plugin = require('../../index')

// The runtime config is fetched from the admin repo over the API. The
// installation fan-out under test does not depend on its contents.
jest.mock('../../lib/configManager', () => {
  return class ConfigManager {
    async loadGlobalSettingsYaml () {
      return {}
    }
  }
})

describe('syncInstallation', () => {
  let robot, Settings, installations

  const installation = (id, login) => ({ id, account: { login } })

  const createOctokit = () => ({
    paginate: jest.fn(() => Promise.resolve(installations)),
    rest: {
      apps: {
        listInstallations: { endpoint: { merge: jest.fn(() => ({})) } },
        getAuthenticated: jest.fn(() => Promise.resolve({ data: { slug: 'safe-settings' } }))
      }
    }
  })

  const createApp = () => plugin(robot, {}, Settings)

  beforeEach(() => {
    installations = []
    Settings = { syncAll: jest.fn(() => Promise.resolve({ errors: [] })) }
    robot = {
      on: jest.fn(),
      auth: jest.fn(() => Promise.resolve(createOctokit())),
      log: {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
      }
    }
  })

  describe('with multiple installations', () => {
    beforeEach(() => {
      installations = [installation(1, 'org-one'), installation(2, 'org-two')]
    })

    it('syncs every installation with its own owner', async () => {
      const app = createApp()

      const result = await app.syncInstallation()

      expect(Settings.syncAll).toHaveBeenCalledTimes(2)
      expect(Settings.syncAll.mock.calls.map(call => call[2])).toEqual([
        { repo: 'admin', owner: 'org-one' },
        { repo: 'admin', owner: 'org-two' }
      ])
      expect(result.results).toHaveLength(2)
      expect(result.errors).toEqual([])
    })

    it('passes the nop flag through to every installation', async () => {
      const app = createApp()

      await app.syncInstallation(true)

      expect(Settings.syncAll.mock.calls.map(call => call[0])).toEqual([true, true])
    })

    it('logs a single summary of the sync', async () => {
      const app = createApp()

      await app.syncInstallation()

      expect(robot.log.info).toHaveBeenCalledTimes(1)
      expect(robot.log.info).toHaveBeenCalledWith(expect.stringContaining('Synced 2 of 2 installation(s); 0 failed'))
    })

    it('aggregates errors reported by the individual syncs', async () => {
      Settings.syncAll
        .mockResolvedValueOnce({ errors: ['boom'] })
        .mockResolvedValueOnce({ errors: [] })
      const app = createApp()

      const result = await app.syncInstallation()

      expect(result.errors).toEqual(['boom'])
    })
  })

  describe('when an installation fails', () => {
    const failure = new Error('installation is suspended')

    beforeEach(() => {
      installations = [installation(1, 'org-one'), installation(2, 'org-two')]
      Settings.syncAll
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ errors: [] })
    })

    it('still syncs the remaining installations', async () => {
      const app = createApp()

      await app.syncInstallation()

      expect(Settings.syncAll).toHaveBeenCalledTimes(2)
      expect(Settings.syncAll.mock.calls[1][2]).toEqual({ repo: 'admin', owner: 'org-two' })
    })

    it('surfaces the failure in the returned errors', async () => {
      const app = createApp()

      const result = await app.syncInstallation()

      expect(result.errors).toEqual([failure])
      expect(result.results).toHaveLength(1)
    })

    it('logs the failing installation id and account', async () => {
      const app = createApp()

      await app.syncInstallation()

      expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1 for org-one'))
      expect(robot.log.info).toHaveBeenCalledWith(expect.stringContaining('Synced 1 of 2 installation(s); 1 failed'))
    })
  })

  describe('when a sync returns no result', () => {
    // In nop mode `syncAllSettings` reports the error via `handleError` and
    // returns nothing, which must not be mistaken for a successful sync.
    beforeEach(() => {
      installations = [installation(1, 'org-one'), installation(2, 'org-two')]
      Settings.syncAll
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ errors: [] })
    })

    it('counts the installation as failed and keeps it out of the results', async () => {
      const app = createApp()

      const result = await app.syncInstallation(true)

      expect(result.results).toEqual([{ errors: [] }])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain('installation 1 for org-one')
      expect(result.errors[0].message).toContain('returned no result')
    })

    it('still syncs the remaining installations', async () => {
      const app = createApp()

      await app.syncInstallation(true)

      expect(Settings.syncAll).toHaveBeenCalledTimes(2)
      expect(Settings.syncAll.mock.calls[1][2]).toEqual({ repo: 'admin', owner: 'org-two' })
    })

    it('reflects the failure in the summary log', async () => {
      const app = createApp()

      await app.syncInstallation(true)

      expect(robot.log.error).toHaveBeenCalledWith(expect.stringContaining('installation 1 for org-one'))
      expect(robot.log.info).toHaveBeenCalledWith(expect.stringContaining('Synced 1 of 2 installation(s); 1 failed'))
    })
  })

  describe('without any installation', () => {
    it('returns null and does not sync', async () => {
      const app = createApp()

      const result = await app.syncInstallation()

      expect(result).toBeNull()
      expect(Settings.syncAll).not.toHaveBeenCalled()
    })
  })
})
