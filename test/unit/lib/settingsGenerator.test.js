/* eslint-disable no-undef */
const SettingsGenerator = require('../../../lib/settingsGenerator')
const {
  intersectConfigs,
  deepEqual,
  pruneEmpty,
  stripNoise,
  parsePropertyValue,
  toYaml
} = SettingsGenerator

const silentLog = { debug () {}, info () {}, warn () {}, error () {}, trace () {}, child () { return this } }

function makeGenerator (github = {}) {
  return new SettingsGenerator(github, 'my-org', { log: silentLog })
}

describe('SettingsGenerator helpers', () => {
  describe('deepEqual', () => {
    it('compares scalars, arrays and objects', () => {
      expect(deepEqual(1, 1)).toBe(true)
      expect(deepEqual('a', 'b')).toBe(false)
      expect(deepEqual([1, 2], [1, 2])).toBe(true)
      expect(deepEqual([1, 2], [2, 1])).toBe(false)
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    })
  })

  describe('stripNoise', () => {
    it('removes API-only keys recursively and drops nulls', () => {
      const input = {
        id: 5,
        node_id: 'abc',
        name: 'keep',
        created_at: 'x',
        nested: { url: 'u', value: 1, gone: null },
        list: [{ id: 1, ok: true }]
      }
      expect(stripNoise(input)).toEqual({
        name: 'keep',
        nested: { value: 1 },
        list: [{ ok: true }]
      })
    })
  })

  describe('pruneEmpty', () => {
    it('removes empty arrays, empty objects, null and undefined', () => {
      expect(pruneEmpty({
        a: [],
        b: {},
        c: null,
        d: undefined,
        e: [1],
        f: { x: 1 },
        g: 'value'
      })).toEqual({ e: [1], f: { x: 1 }, g: 'value' })
    })
  })

  describe('parsePropertyValue', () => {
    it('parses name=value', () => {
      expect(parsePropertyValue('Team=backend')).toEqual({ name: 'Team', value: 'backend' })
    })
    it('parses name:value', () => {
      expect(parsePropertyValue('Team:backend')).toEqual({ name: 'Team', value: 'backend' })
    })
    it('uses propertyName when provided', () => {
      expect(parsePropertyValue('backend', 'Team')).toEqual({ name: 'Team', value: 'backend' })
    })
    it('throws when value cannot be parsed', () => {
      expect(() => parsePropertyValue('backend')).toThrow(/name=value/)
    })
  })

  describe('toYaml', () => {
    it('serializes config to YAML', () => {
      const out = toYaml({ repository: { name: 'test' } })
      expect(out).toContain('repository:')
      expect(out).toContain('name: test')
    })
  })
})

describe('intersectConfigs', () => {
  it('returns the single config unchanged when only one provided', () => {
    const cfg = { repository: { has_issues: true } }
    expect(intersectConfigs([cfg])).toBe(cfg)
  })

  it('keeps only sections present in all configs', () => {
    const a = { repository: { has_issues: true }, labels: [{ name: 'bug' }] }
    const b = { repository: { has_issues: true } }
    expect(intersectConfigs([a, b])).toEqual({ repository: { has_issues: true } })
  })

  it('keeps only scalar object keys that match across all configs', () => {
    const a = { repository: { has_issues: true, has_wiki: true } }
    const b = { repository: { has_issues: true, has_wiki: false } }
    expect(intersectConfigs([a, b])).toEqual({ repository: { has_issues: true } })
  })

  it('keeps array items present (by identity + value) in every config', () => {
    const a = { labels: [{ name: 'bug', color: 'f00' }, { name: 'wip', color: '0f0' }] }
    const b = { labels: [{ name: 'bug', color: 'f00' }, { name: 'done', color: '00f' }] }
    expect(intersectConfigs([a, b])).toEqual({ labels: [{ name: 'bug', color: 'f00' }] })
  })

  it('drops array items whose value differs even if identity matches', () => {
    const a = { labels: [{ name: 'bug', color: 'f00' }] }
    const b = { labels: [{ name: 'bug', color: '00f' }] }
    expect(intersectConfigs([a, b])).toEqual({ labels: [] })
  })
})

describe('SettingsGenerator extractors', () => {
  it('repository() selects only configurable fields', async () => {
    const github = {
      rest: {
        repos: {
          get: jest.fn().mockResolvedValue({
            data: {
              id: 1,
              node_id: 'x',
              name: 'test',
              description: 'desc',
              has_issues: true,
              stargazers_count: 99,
              topics: ['a', 'b'],
              default_branch: 'main'
            }
          })
        }
      }
    }
    const generator = makeGenerator(github)
    const result = await generator.repository({ owner: 'my-org', repo: 'test' })
    expect(result).toEqual({
      name: 'test',
      description: 'desc',
      has_issues: true,
      default_branch: 'main',
      topics: ['a', 'b']
    })
  })

  it('labels() sanitizes to name/color/description', async () => {
    const generator = makeGenerator()
    generator.findExisting = jest.fn().mockResolvedValue([
      { id: 1, node_id: 'n', url: 'u', name: 'bug', color: 'cc0000', description: 'A bug', default: false }
    ])
    expect(await generator.labels({ owner: 'my-org', repo: 'r' })).toEqual([
      { name: 'bug', color: 'cc0000', description: 'A bug' }
    ])
  })

  it('teams() maps slug and permission', async () => {
    const generator = makeGenerator()
    generator.findExisting = jest.fn().mockResolvedValue([
      { id: 1, slug: 'core', name: 'Core Team', permission: 'push' }
    ])
    expect(await generator.teams({ owner: 'my-org', repo: 'r' })).toEqual([
      { name: 'core', permission: 'push' }
    ])
  })

  it('rulesets() strips source/source_type and noise', async () => {
    const generator = makeGenerator()
    generator.findExisting = jest.fn().mockResolvedValue([
      { id: 7, node_id: 'n', source: 'my-org/r', source_type: 'Repository', name: 'main', enforcement: 'active' }
    ])
    expect(await generator.rulesets({ owner: 'my-org', repo: 'r' }, 'repo')).toEqual([
      { name: 'main', enforcement: 'active' }
    ])
  })

  it('reformatBranchProtection flattens enabled wrappers', () => {
    const generator = makeGenerator()
    const out = generator.reformatBranchProtection({
      url: 'noise',
      enforce_admins: { enabled: true },
      required_linear_history: { enabled: false },
      required_pull_request_reviews: { required_approving_review_count: 2 }
    })
    expect(out).toEqual({
      enforce_admins: true,
      required_linear_history: false,
      required_pull_request_reviews: { required_approving_review_count: 2 }
    })
  })
})

describe('SettingsGenerator.buildSubOrgConfig', () => {
  it('prepends suborgproperties and intersects matching repos', async () => {
    const generator = makeGenerator()
    generator.findReposByProperty = jest.fn().mockResolvedValue(['repo-a', 'repo-b'])
    generator.buildRepoConfig = jest.fn()
      .mockResolvedValueOnce({ repository: { has_issues: true, has_wiki: true } })
      .mockResolvedValueOnce({ repository: { has_issues: true, has_wiki: false } })

    const result = await generator.buildSubOrgConfig('Team', 'backend')
    expect(result).toEqual({
      suborgproperties: [{ Team: 'backend' }],
      repository: { has_issues: true }
    })
  })

  it('returns just the selector when no repos match', async () => {
    const generator = makeGenerator()
    generator.findReposByProperty = jest.fn().mockResolvedValue([])
    const result = await generator.buildSubOrgConfig('Team', 'backend')
    expect(result).toEqual({ suborgproperties: [{ Team: 'backend' }] })
  })
})

describe('SettingsGenerator.generate', () => {
  it('resolves repo source to repos/<name>.yml', async () => {
    const generator = makeGenerator()
    generator.buildRepoConfig = jest.fn().mockResolvedValue({ repository: { name: 'r' } })
    const { filePath, config, yaml } = await generator.generate({ sourceType: 'repo', sourceValue: 'r' })
    expect(filePath).toBe('.github/repos/r.yml')
    expect(config).toEqual({ repository: { name: 'r' } })
    expect(yaml).toContain('name: r')
  })

  it('resolves org source to settings.yml', async () => {
    const generator = makeGenerator()
    generator.buildOrgConfig = jest.fn().mockResolvedValue({ rulesets: [] })
    const { filePath } = await generator.generate({ sourceType: 'org', sourceValue: 'my-org' })
    expect(filePath).toBe('.github/settings.yml')
  })

  it('resolves custom-property source to suborgs/<name>_<value>.yml', async () => {
    const generator = makeGenerator()
    generator.buildSubOrgConfig = jest.fn().mockResolvedValue({ suborgproperties: [{ Team: 'backend' }] })
    const { filePath } = await generator.generate({ sourceType: 'custom-property', sourceValue: 'Team=backend' })
    expect(filePath).toBe('.github/suborgs/Team_backend.yml')
  })

  it('throws on unsupported source type', async () => {
    const generator = makeGenerator()
    await expect(generator.generate({ sourceType: 'bogus', sourceValue: 'x' })).rejects.toThrow(/Unsupported source type/)
  })
})

describe('SettingsGenerator.findReposByProperty', () => {
  it('queries the org properties values API and returns repo names', async () => {
    const paginate = jest.fn().mockResolvedValue([
      { repository_name: 'repo-a' },
      { repository_name: 'repo-b' },
      { repository_name: null }
    ])
    const github = {
      request: { endpoint: jest.fn().mockReturnValue({ url: 'endpoint' }) },
      paginate
    }
    const generator = makeGenerator(github)
    const repos = await generator.findReposByProperty('Team', 'backend')
    expect(github.request.endpoint).toHaveBeenCalledWith(
      expect.stringContaining('/orgs/my-org/properties/values?repository_query=')
    )
    expect(repos).toEqual(['repo-a', 'repo-b'])
  })
})
