const Settings = require('../../../lib/settings')

describe('repository overrides during suborg synchronization', () => {
  let settings

  beforeEach(() => {
    const context = {
      payload: { installation: { id: 1 } },
      octokit: {},
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    }
    settings = new Settings(false, context, { owner: 'test-org', repo: 'admin' }, {})
    settings.suborgChange = true
    settings.subOrgConfigs = {}
  })

  describe.each(['yml', 'yaml'])('.%s files', extension => {
    it.each(['api.service', 'docs.api.service', '.github', 'docs.yml', 'plain', 'demo_api'])(
      'loads the override for suborg member %s',
      async repoName => {
        const name = `${repoName}.${extension}`
        const path = `.github/repos/${name}`
        const override = { repository: { has_wiki: false } }
        settings.subOrgConfigs[repoName] = { source: '.github/suborgs/backend.yml' }
        jest.spyOn(settings, 'getRepoConfigMap').mockResolvedValue([{ name, path }])
        jest.spyOn(settings, 'loadYaml').mockResolvedValue(override)

        settings.repoConfigs = await settings.getRepoConfigs()

        expect(settings.loadYaml).toHaveBeenCalledTimes(1)
        expect(settings.loadYaml).toHaveBeenCalledWith(path)
        expect(settings.getRepoOverrideConfig(repoName)).toEqual(override)
      }
    )

    it('matches a dotted repository against its full suborg glob', async () => {
      const name = `api.service.${extension}`
      const path = `.github/repos/${name}`
      settings.subOrgConfigs['api.*'] = { source: '.github/suborgs/backend.yml' }
      jest.spyOn(settings, 'getRepoConfigMap').mockResolvedValue([{ name, path }])
      jest.spyOn(settings, 'loadYaml').mockResolvedValue({ repository: { has_wiki: false } })

      const configs = await settings.getRepoConfigs()

      expect(configs[name]).toEqual({ repository: { has_wiki: false } })
      expect(settings.loadYaml).toHaveBeenCalledWith(path)
    })

    it('does not load an override just because its truncated name matches a suborg', async () => {
      const name = `api.service.${extension}`
      settings.subOrgConfigs.api = { source: '.github/suborgs/backend.yml' }
      jest.spyOn(settings, 'getRepoConfigMap').mockResolvedValue([
        { name, path: `.github/repos/${name}` }
      ])
      jest.spyOn(settings, 'loadYaml').mockResolvedValue({})

      const configs = await settings.getRepoConfigs()

      expect(configs).toEqual({})
      expect(settings.loadYaml).not.toHaveBeenCalled()
    })
  })
})
