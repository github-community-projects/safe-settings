const Settings = require('../../../lib/settings')
const CustomProperties = require('../../../lib/plugins/custom_properties')

describe('layered custom property ownership', () => {
  const repo = { owner: 'org', repo: 'service' }
  let context

  beforeEach(() => {
    context = {
      payload: { installation: { id: 123 } },
      octokit: { paginate: jest.fn().mockResolvedValue([]), request: jest.fn() },
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() }
    }
  })

  function settingsFor (org, suborg = {}, override = {}) {
    const settings = new Settings(false, context, repo, org, 'main')
    settings.subOrgConfigs = { service: suborg }
    settings.repoConfigs = { 'service.yml': override }
    return settings
  }

  function pluginFor (settings) {
    const entry = settings.childPluginsList(repo).find(([Plugin]) => Plugin === CustomProperties)
    if (!entry) return undefined
    const [Plugin, config] = entry
    const plugin = new Plugin(false, context.octokit, repo, config, context.log, settings.errors)
    plugin.additive = settings.normalizeAdditivePlugins().has('custom_properties')
    return plugin
  }

  it('mixes list/object layers, merges aliases case-insensitively and replaces multi-values', () => {
    const org = { custom_properties: [{ name: 'OWNER', value: 'org' }, { name: 'services', value: ['org'] }] }
    const suborg = {
      custom_properties: {
        include: [{ property_name: 'owner', value: 'suborg' }],
        exclude: [{ name: '^external-' }]
      }
    }
    const override = { custom_properties: [{ name: 'Owner', value: 'repo' }, { name: 'services', value: ['repo'] }] }
    const original = JSON.stringify([org, suborg, override])
    const plugin = pluginFor(settingsFor(org, suborg, override))
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'repo' }, { name: 'services', value: ['repo'] }])
    expect(plugin.isProtected('external-owner')).toBe(true)
    expect(JSON.stringify([org, suborg, override])).toBe(original)
  })

  it('accumulates exclusions and retains inherited includes through empty layers', () => {
    const plugin = pluginFor(settingsFor({
      custom_properties: { include: [{ name: 'owner', value: 'org' }], exclude: [{ name: '^org-' }] }
    }, { custom_properties: { exclude: [{ name: '^sub-' }] } }, { custom_properties: [] }))
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'org' }])
    expect(plugin.isProtected('org-owner')).toBe(true)
    expect(plugin.isProtected('sub-owner')).toBe(true)
    expect(plugin.isProtected('other')).toBe(false)
  })

  it('lets repo includes override inherited exclusion patterns', async () => {
    const settings = settingsFor({ custom_properties: { exclude: [{ name: '.*' }] } }, {}, {
      custom_properties: [{ property_name: 'OWNER', value: 'repo' }]
    })
    context.octokit.paginate.mockResolvedValue([{ property_name: 'owner', value: 'org' }, { property_name: 'external', value: 'keep' }])
    await pluginFor(settings).sync()
    expect(context.octokit.request.mock.calls.map(([, params]) => params.properties)).toEqual([
      [{ property_name: 'owner', value: 'repo' }]
    ])
  })

  it.each([{}, { include: [], exclude: '*' }, { exclude: [{ name: '*' }] }])('retains fail-closed errors from an inherited malformed layer %j', async malformed => {
    const settings = settingsFor({ custom_properties: malformed }, {}, {
      custom_properties: [{ name: 'owner', value: 'repo' }, { name: 'clear', value: null }]
    })
    context.octokit.paginate.mockResolvedValue([{ property_name: 'external', value: 'keep' }, { property_name: 'clear', value: 'keep' }])
    await pluginFor(settings).sync()
    expect(settings.errors.length).toBeGreaterThan(0)
    expect(settings.errors[0]).toMatchObject(repo)
    expect(context.octokit.request.mock.calls.map(([, params]) => params.properties)).toEqual([
      [{ property_name: 'owner', value: 'repo' }]
    ])
  })

  it('retains valid inherited includes when the repo object is malformed', () => {
    const settings = settingsFor({ custom_properties: [{ name: 'owner', value: 'org' }] }, {}, {
      custom_properties: { include: [{ name: 'team', value: 'repo' }], exclude: null }
    })
    const plugin = pluginFor(settings)
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'org' }, { name: 'team', value: 'repo' }])
    expect(plugin.isProtected('external')).toBe(true)
    expect(settings.errors).toHaveLength(1)
  })

  it('reports malformed layered configuration as an ERROR NOP command', () => {
    const settings = settingsFor({ custom_properties: { exclude: [{ name: '*' }] } })
    settings.nop = true
    pluginFor(settings)
    expect(settings.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ERROR', repo: 'service' })
    ]))
  })

  it('null resets inherited exclusions and includes', () => {
    const plugin = pluginFor(settingsFor({
      custom_properties: { include: [{ name: 'old', value: 'org' }], exclude: [{ name: '.*' }] }
    }, { custom_properties: null }, { custom_properties: { include: [{ name: 'new', value: 'repo' }] } }))
    expect(plugin.entries).toEqual([{ name: 'new', value: 'repo' }])
    expect(plugin.isProtected('external')).toBe(false)
  })

  it('repo null keeps the plugin inactive', async () => {
    const plugin = pluginFor(settingsFor({ custom_properties: { exclude: [{ name: '.*' }] } }, {}, { custom_properties: null }))
    await plugin.sync()
    expect(context.octokit.paginate).not.toHaveBeenCalled()
  })

  it('null discards malformed earlier layers without running the generic object merger', async () => {
    const settings = settingsFor(
      { custom_properties: { include: [null] } },
      { custom_properties: { include: [{ name: 'owner', value: 'suborg' }] } },
      { custom_properties: null }
    )
    await pluginFor(settings).sync()
    expect(context.octokit.paginate).not.toHaveBeenCalled()
    expect(settings.errors).toEqual([])
  })

  it('preserves a plain-array overlay after null resets an object layer', () => {
    const plugin = pluginFor(settingsFor(
      { custom_properties: { exclude: [{ name: '.*' }] } },
      { custom_properties: null },
      { custom_properties: [{ name: 'owner', value: 'repo' }] }
    ))
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'repo' }])
    expect(plugin.isProtected('external')).toBe(false)
  })

  it('preserves plain-array layering', () => {
    const plugin = pluginFor(settingsFor(
      { custom_properties: [{ name: 'owner', value: 'org' }] },
      { custom_properties: [{ name: 'team', value: 'suborg' }] },
      { custom_properties: [{ name: 'owner', value: 'repo' }] }
    ))
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'repo' }, { name: 'team', value: 'suborg' }])
  })

  it('applies disable stripping before ownership merging', () => {
    const settings = settingsFor({
      custom_properties: [{ name: 'owner', value: 'org' }]
    }, {}, {
      disable_plugins: [{ plugin: 'custom_properties', target: 'self' }],
      custom_properties: { include: [{ name: 'owner', value: 'repo' }], exclude: [{ name: '.*' }] }
    })
    const plugin = pluginFor(settings)
    expect(plugin.entries).toEqual([{ name: 'owner', value: 'org' }])
    expect(plugin.isProtected('external')).toBe(false)
  })

  it('leaves fully disabled custom properties uninstantiated', () => {
    const settings = settingsFor({
      disable_plugins: [{ plugin: 'custom_properties', target: 'all' }],
      custom_properties: { include: [], exclude: [{ name: '*' }] }
    })
    expect(pluginFor(settings)).toBeUndefined()
    expect(settings.errors).toEqual([])
  })

  it('threads org additive mode through mixed ownership layers', async () => {
    const settings = settingsFor({
      additive_plugins: ['custom_properties'],
      custom_properties: { exclude: [{ name: '^external-' }] }
    }, {}, { custom_properties: [{ name: 'owner', value: 'repo' }] })
    context.octokit.paginate.mockResolvedValue([{ property_name: 'obsolete', value: 'keep' }, { property_name: 'external', value: 'keep' }])
    await pluginFor(settings).sync()
    expect(context.octokit.request).toHaveBeenCalledTimes(1)
    expect(context.octokit.request.mock.calls[0][1].properties).toEqual([{ property_name: 'owner', value: 'repo' }])
  })

  it('recognizes object configuration for targeting re-evaluation without change signals', () => {
    const settings = settingsFor({}, {}, { custom_properties: { exclude: [] } })
    expect(settings.shouldConsiderReevaluation(repo, {})).toBe(true)
    expect(settings.shouldConsiderReevaluation(repo, {}, { propertiesChanged: false })).toBe(false)
  })
})
