const Settings = require('../../../lib/settings')
const Rulesets = require('../../../lib/plugins/rulesets')

describe('Centralized ruleset bypass actors', () => {
  const repo = { owner: 'test-org', repo: 'test-repo' }
  const actor = (actorType, actorId, bypassMode = 'always') => ({
    actor_type: actorType,
    ...(actorId === undefined ? {} : { actor_id: actorId }),
    bypass_mode: bypassMode
  })
  let context

  beforeEach(() => {
    const request = jest.fn().mockResolvedValue({})
    request.endpoint = jest.fn((url, body) => ({ url, body }))
    context = {
      payload: { installation: { id: 123 } },
      octokit: { request },
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    }
  })

  function configure (localActors, centralActors, layer, nop = false) {
    const policy = { name: 'Policy', target: 'branch', enforcement: 'active', bypass_actors: localActors, rules: [] }
    const config = { centralized_ruleset_bypass_actors: centralActors }
    const settings = new Settings(nop, context, repo, config, 'main')
    settings.repoConfigs = {}
    settings.getSubOrgConfigMap = jest.fn().mockResolvedValue([])
    if (layer === 'repo') settings.repoConfigs = { 'test-repo.yml': { rulesets: [policy] } }
    if (layer === 'suborg') settings.subOrgConfigs = { 'test-repo': { rulesets: [policy] } }
    if (layer === 'org') config.rulesets = [policy]
    if (layer === 'org-suborg') {
      settings.getSubOrgConfigMap.mockResolvedValue([{ name: 'suborg.yml', path: '.github/suborgs/suborg.yml' }])
      settings.loadYaml = jest.fn().mockResolvedValue({
        ruleset_scope: 'org', suborgproperties: [{ division: 'engineering' }], rulesets: [policy]
      })
    }
    return settings
  }

  async function run (settings, layer) {
    if (layer === 'org' || layer === 'org-suborg') {
      await settings.syncOrgLevelRulesets()
    } else {
      const [Plugin, entries] = settings.childPluginsList(repo).find(([, , section]) => section === 'rulesets')
      await new Plugin(settings.nop, context.octokit, repo, entries, context.log, settings.errors).sync()
    }
  }

  describe.each(['repo', 'suborg', 'org', 'org-suborg'])('%s rulesets', layer => {
    it.each([undefined, null, 1, 2].flatMap(localId =>
      [undefined, null, 1, 2].map(centralId => [localId, centralId])
    ))('replaces ignored local ID %p with centralized ID %p before comparison', async (localId, centralId) => {
      const local = ['OrganizationAdmin', 'DeployKey'].map(type => Object.freeze(actor(type, localId)))
      const centralized = ['OrganizationAdmin', 'DeployKey'].map(type => Object.freeze(actor(type, centralId, 'pull_request')))
      const settings = configure(Object.freeze(local), Object.freeze(centralized), layer)
      let merged
      jest.spyOn(Rulesets.prototype, 'find').mockImplementation(function () {
        merged = this.entries[0].bypass_actors
        return Promise.resolve(this.entries.map(entry => ({
          ...entry,
          id: 7,
          bypass_actors: ['DeployKey', 'OrganizationAdmin'].map(type => actor(type, null, 'pull_request'))
        })))
      })

      await run(settings, layer)

      expect(merged).toEqual(centralized)
      expect(merged).toHaveLength(2)
      merged.forEach((entry, index) => expect(entry).not.toBe(centralized[index]))
      expect(local).toEqual(['OrganizationAdmin', 'DeployKey'].map(type => actor(type, localId)))
      expect(centralized).toEqual(['OrganizationAdmin', 'DeployKey'].map(type => actor(type, centralId, 'pull_request')))
      expect(context.octokit.request).not.toHaveBeenCalled()
      expect(settings.errors).toEqual([])
    })
  })

  it.each([false, true])('applies the centralized mode once, preserves real IDs, and converges (nop=%p)', async nop => {
    const local = [actor('DeployKey', null), actor('Team', 42), actor('Team', 43), actor('Integration', 101)]
    const centralized = [actor('DeployKey', 99, 'pull_request'), actor('Team', 42, 'pull_request')]
    const settings = configure(local, centralized, 'repo', nop)
    const [, entries] = settings.childPluginsList(repo).find(([, , section]) => section === 'rulesets')
    const expected = [centralized[0], centralized[1], local[2], local[3]]
    const plugin = new Rulesets(nop, context.octokit, repo, entries, context.log, settings.errors)
    const existing = { ...entries[0], id: 7, bypass_actors: local }
    plugin.find = jest.fn().mockResolvedValue([existing])

    expect(entries[0].bypass_actors).toEqual(expected)
    const results = await plugin.sync()
    expect(plugin.hasChanges).toBe(true)
    if (nop) {
      const update = results.flat().find(command => command.action.msg === 'Update Ruleset')
      expect(update.body.bypass_actors).toEqual(expected)
      expect(context.octokit.request).not.toHaveBeenCalled()
    } else {
      expect(context.octokit.request).toHaveBeenCalledTimes(1)
      expect(context.octokit.request).toHaveBeenCalledWith('PUT /repos/{owner}/{repo}/rulesets/{id}', expect.objectContaining({
        id: 7, bypass_actors: expected
      }))
    }

    context.octokit.request.mockClear()
    plugin.find.mockResolvedValue([{
      ...existing,
      bypass_actors: [actor('DeployKey', null, 'pull_request'), centralized[1], local[2], local[3]]
    }])
    expect(await plugin.sync()).toBeUndefined()
    expect(plugin.hasChanges).toBe(false)
    expect(context.octokit.request).not.toHaveBeenCalled()
    expect(settings.errors).toEqual([])
  })
})
