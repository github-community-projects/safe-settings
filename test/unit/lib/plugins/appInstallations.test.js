const AppInstallations = require('../../../../lib/plugins/appInstallations')

describe('AppInstallations', () => {
  let github
  let appGithub
  let log
  let errors

  beforeEach(() => {
    log = {
      debug: jest.fn(),
      error: jest.fn()
    }
    errors = []

    github = {
      paginate: jest.fn(),
      repos: {
        get: jest.fn()
      },
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    github.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }

    appGithub = {
      paginate: jest.fn(),
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    appGithub.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }
  })

  describe('syncDelta', () => {
    it('returns empty array for no changes', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([])
      expect(result).toEqual([])
    })

    it('returns empty array for null changes', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta(null)
      expect(result).toEqual([])
    })

    it('reports error when enterprise client is not configured', async () => {
      const plugin = new AppInstallations(true, github, null, { owner: 'org', repo: 'admin' }, null, log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'test-app',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set()
      }])

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
    })

    it('generates NopCommand in nop mode for specific repos', async () => {
      // Mock enterprise client listing repos
      appGithub.paginate.mockResolvedValue([])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a', 'repo-b']),
        repository_unselection: new Set(['repo-c'])
      }])

      expect(result).toHaveLength(1)
      expect(result[0].plugin).toBe('app_installations')
      expect(result[0].action.additions).toEqual(['repo-a', 'repo-b'])
      expect(result[0].action.deletions).toEqual(['repo-c'])
    })

    it('generates NopCommand in nop mode for "all" selection', async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: 'all',
        repository_unselection: new Set()
      }])

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['(all repositories)'])
    })

    it('suppresses unselections in additive mode', async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true

      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set(['repo-b'])
      }])

      expect(result).toHaveLength(1)
      // Should only have additions, no deletions
      expect(result[0].action.additions).toEqual(['repo-a'])
      expect(result[0].action.deletions).toBeNull()
    })

    it('processes additions before unselections in non-nop mode (422-safe swap)', async () => {
      const callOrder = []
      appGithub.request.mockImplementation((route) => {
        if (route.includes('/repositories/remove')) callOrder.push('remove')
        if (route.includes('/repositories/add')) callOrder.push('add')
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set(['repo-b'])
      }])

      // Additions are applied before removals so a "swap" never drops the
      // installation to zero repos (which the Enterprise API rejects with 422).
      // Selection/unselection are already disjoint (dedup), so ordering does not
      // affect the final set.
      expect(callOrder).toEqual(['add', 'remove'])
    })

    it('records a descriptive error when a delta removal is rejected with 422', async () => {
      appGithub.request.mockImplementation((route) => {
        if (route.includes('/repositories/remove')) {
          return Promise.reject(Object.assign(new Error('Unprocessable'), { status: 422 }))
        }
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(),
        repository_unselection: new Set(['repo-a'])
      }])

      // The 422 is caught and recorded, not thrown out of syncDelta.
      expect(Array.isArray(result)).toBe(true)
      expect(errors.some(e => /422/.test(e.msg))).toBe(true)
    })

    it('accepts array-based selection/unselection (Settings._buildAppChangesFromDelta output shape)', async () => {
      // Settings._buildAppChangesFromDelta returns arrays (not Sets). The
      // plugin must treat them the same as Sets, otherwise real add/remove
      // operations are silently skipped.
      const routes = []
      appGithub.request.mockImplementation((route) => {
        routes.push(route)
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: ['repo-a'],
        repository_unselection: ['repo-b']
      }])

      expect(routes.some(r => r.includes('/repositories/add'))).toBe(true)
      expect(routes.some(r => r.includes('/repositories/remove'))).toBe(true)
    })

    it('generates NopCommand for array-based selection/unselection in nop mode', async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: ['repo-a', 'repo-b'],
        repository_unselection: ['repo-c']
      }])

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['repo-a', 'repo-b'])
      expect(result[0].action.deletions).toEqual(['repo-c'])
    })
  })

  describe('syncFull', () => {
    it('returns empty array for no desired state', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({})
      expect(result).toEqual([])
    })

    it('reports error when enterprise client is missing', async () => {
      const plugin = new AppInstallations(true, github, null, { owner: 'org', repo: 'admin' }, null, log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']) }
      })
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
    })

    it('generates NopCommand with additions and deletions in nop mode', async () => {
      // Mock listInstallationRepos (live state)
      appGithub.paginate.mockResolvedValue([
        { name: 'existing-repo', id: 10 },
        { name: 'stale-repo', id: 20 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['existing-repo', 'new-repo'])
        }
      })

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['new-repo'])
      expect(result[0].action.deletions).toEqual(['stale-repo'])
    })

    it('suppresses deletions in additive mode during full sync', async () => {
      appGithub.paginate.mockResolvedValue([
        { name: 'existing-repo', id: 10 },
        { name: 'stale-repo', id: 20 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true

      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['existing-repo', 'new-repo'])
        }
      })

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['new-repo'])
      expect(result[0].action.deletions).toBeNull()
    })

    it('skips app when no changes needed', async () => {
      appGithub.paginate.mockResolvedValue([
        { name: 'repo-a', id: 10 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['repo-a'])
        }
      })

      expect(result).toEqual([])
    })

    it("toggles to 'all' when desired is all and current is selected", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncFull({
        copilot: { installation_id: 1, repos: 'all', current_selection: 'selected' }
      })

      expect(appGithub.request).toHaveBeenCalledWith(
        expect.stringContaining('/repositories'),
        expect.objectContaining({ repository_selection: 'all', installation_id: 1 })
      )
    })

    it('skips when desired is all and current is already all', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: 'all', current_selection: 'all' }
      })

      expect(result).toEqual([])
      expect(appGithub.request).not.toHaveBeenCalled()
    })

    it("narrows from 'all' to 'selected' when desired is a set", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']), current_selection: 'all' }
      })

      expect(appGithub.request).toHaveBeenCalledWith(
        expect.stringContaining('/repositories'),
        expect.objectContaining({ repository_selection: 'selected', repositories: ['repo-a'] })
      )
    })

    it("leaves 'all' untouched in additive mode", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']), current_selection: 'all' }
      })

      expect(result).toEqual([])
      expect(appGithub.request).not.toHaveBeenCalled()
    })

    it('applies additions before removals to avoid a transient empty selection (422-safe swap)', async () => {
      // live = {repo-a}; desired = {repo-b} → swap. Removing first could drop the
      // installation to zero repos (422); additions must be applied first.
      appGithub.paginate.mockResolvedValue([{ name: 'repo-a', id: 10 }])
      const routes = []
      appGithub.request.mockImplementation((route) => {
        routes.push(route)
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-b']), current_selection: 'selected' }
      })

      const addIdx = routes.findIndex(r => r.includes('/repositories/add'))
      const removeIdx = routes.findIndex(r => r.includes('/repositories/remove'))
      expect(addIdx).toBeGreaterThanOrEqual(0)
      expect(removeIdx).toBeGreaterThanOrEqual(0)
      expect(addIdx).toBeLessThan(removeIdx)
    })

    it("errors (without mutating) when the desired repo set is empty for a 'selected' installation", async () => {
      appGithub.paginate.mockResolvedValue([{ name: 'repo-a', id: 10 }])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(), current_selection: 'selected' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
      expect(errors.some(e => /zero repositories/i.test(e.msg))).toBe(true)
      expect(appGithub.request).not.toHaveBeenCalled()
    })

    it('records a descriptive error when removal is rejected with 422', async () => {
      appGithub.paginate.mockResolvedValue([
        { name: 'repo-a', id: 10 },
        { name: 'repo-b', id: 20 }
      ])
      appGithub.request.mockImplementation((route) => {
        if (route.includes('/repositories/remove')) {
          return Promise.reject(Object.assign(new Error('Unprocessable'), { status: 422 }))
        }
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      // desired = {repo-a}; live = {repo-a, repo-b} → toRemove = [repo-b]
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']), current_selection: 'selected' }
      })

      // The 422 is caught and recorded, not thrown out of syncFull.
      expect(Array.isArray(result)).toBe(true)
      expect(errors.some(e => /422/.test(e.msg))).toBe(true)
    })

    it("errors (without mutating) when narrowing 'all' to an empty desired set", async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(), current_selection: 'all' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
      expect(errors.some(e => /narrow repository_selection from 'all'/.test(e.msg))).toBe(true)
      // The over-broad 'all' installation must be left unchanged.
      expect(appGithub.request).not.toHaveBeenCalled()
    })

    it("leaves 'all' untouched (no error) for an empty desired set in additive mode", async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(), current_selection: 'all' }
      })

      expect(result).toEqual([])
      expect(errors).toEqual([])
      expect(appGithub.request).not.toHaveBeenCalled()
    })
  })
})
