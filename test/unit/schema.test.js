const Ajv = require('ajv/dist/2020')
const Settings = require('../../lib/settings')

const files = ['settings', 'suborgs', 'repos']
const schemas = Object.fromEntries(files.map(file => [file, require(`../../schema/dereferenced/${file}.json`)]))
// GitHub includes OpenAPI annotations and formats outside JSON Schema's vocabulary.
const ajv = new Ajv({ strict: false, validateFormats: false })
const validators = Object.fromEntries(files.map(file => [file, ajv.compile(schemas[file])]))
const refCondition = { include: ['~DEFAULT_BRANCH'], exclude: [] }
const repositoryConditions = {
  repository_name: { include: ['service-*'], exclude: [], protected: false },
  repository_id: { repository_ids: [123] },
  repository_property: { include: [{ name: 'team', property_values: ['backend'] }], exclude: [] }
}
const ruleset = (overrides = {}) => ({
  name: 'Main protection',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: refCondition },
  rules: [{ type: 'deletion' }],
  ...overrides
})
const orgRuleset = (condition = 'repository_name') => ruleset({
  conditions: { ref_name: refCondition, [condition]: repositoryConditions[condition] }
})

function * nodes (node) {
  if (!node || typeof node !== 'object') return
  yield node
  for (const value of Object.values(node)) yield * nodes(value)
}

describe.each(files)('%s schema', file => {
  const schema = schemas[file]
  const validate = validators[file]
  const validRuleset = file === 'settings' ? orgRuleset() : ruleset()

  it('is fully dereferenced JSON Schema 2020-12 without OpenAPI nullable keywords', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    for (const node of nodes(schema)) {
      expect(node).not.toHaveProperty('nullable')
      expect(node).not.toHaveProperty('$ref')
    }
  })

  it('uses the pinned OpenAPI 3.1 description for every API reference', () => {
    const source = require(`../../schema/${file}.json`)
    const apiRefs = [...nodes(source)].map(node => node.$ref).filter(ref => ref && ref.startsWith('https:'))
    expect(apiRefs.length).toBeGreaterThan(0)
    for (const ref of apiRefs) {
      expect(ref).toMatch(/^https:\/\/raw\.githubusercontent\.com\/github\/rest-api-description\/main\/descriptions-next\/api\.github\.com\/api\.github\.com\.2026-03-10\.json#/)
    }
  })

  it.each([null, {}, [], false].map(value => [value]))('accepts protection deletion value %j', protection => {
    expect(validate({ branches: [{ name: 'main', protection }] })).toBe(true)
  })

  it('accepts required-but-nullable branch protection fields and nullable repository settings', () => {
    expect(validate({
      repositories: { security_and_analysis: null },
      branches: [{
        name: 'main',
        protection: {
          required_status_checks: null,
          enforce_admins: null,
          required_pull_request_reviews: null,
          restrictions: null,
          allow_force_pushes: null
        }
      }]
    })).toBe(true)
  })

  it.each([true, 'disabled', 1, ['main'], { enforce_admins: 'yes' }].map(value => [value]))('rejects invalid protection value %j', protection => {
    expect(validate({ branches: [{ name: 'main', protection }] })).toBe(false)
  })

  it('accepts valid rulesets', () => {
    expect(validate({ rulesets: [validRuleset] })).toBe(true)
  })

  it.each([
    ['missing name', { ...validRuleset, name: undefined }],
    ['missing enforcement', { ...validRuleset, enforcement: undefined }],
    ['unknown enforcement', { ...validRuleset, enforcement: 'enabled' }],
    ['unknown target', { ...validRuleset, target: 'unknown' }],
    ['unknown rule', { ...validRuleset, rules: [{ type: 'unknown' }] }],
    ['invalid ref condition', { ...validRuleset, conditions: { ...validRuleset.conditions, ref_name: { include: 1 } } }],
    ['invalid actor', { ...validRuleset, bypass_actors: [{ actor_type: 'unknown' }] }],
    ['invalid actor id', { ...validRuleset, bypass_actors: [{ actor_type: 'Team', actor_id: '123' }] }]
  ])('rejects rulesets with %s', (_label, entry) => {
    expect(validate({ rulesets: [entry] })).toBe(false)
  })

  it('accepts nullable bypass actor IDs and name/slug aliases', () => {
    const entry = {
      ...validRuleset,
      bypass_actors: [
        { actor_type: 'DeployKey', actor_id: null },
        { actor_type: 'Team', name: 'maintainers' },
        { actor_type: 'User', name: 'octocat' },
        { actor_type: 'RepositoryRole', name: 'custom-role' }
      ],
      rules: [{
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 1,
          required_review_thread_resolution: false,
          required_reviewers: [{
            minimum_approvals: 1,
            file_patterns: ['*.js'],
            reviewer: { type: 'Team', slug: 'maintainers' }
          }]
        }
      }]
    }
    expect(validate({ rulesets: [entry] })).toBe(true)
    entry.rules[0].parameters.required_reviewers[0].reviewer.slug = 123
    expect(validate({ rulesets: [entry] })).toBe(false)
    entry.rules = []
    entry.bypass_actors[1].name = 123
    expect(validate({ rulesets: [entry] })).toBe(false)
  })

  it('retains repository creation, team filtering and custom permission extensions', () => {
    expect(validate({
      repositories: { force_create: true, template: 'template-repo', auto_init: true, topics: ['backend'] },
      teams: [{ name: 'maintainers', permission: 'custom-role', privacy: 'closed', external_group: 'Developers', include: ['service-*'], exclude: ['archived-*'] }],
      collaborators: [{ username: 'octocat', permission: 'custom-role', include: ['service-*'], exclude: ['archived-*'] }]
    })).toBe(true)
    expect(validate({ repositories: { force_create: 'yes' } })).toBe(false)
    expect(validate({ teams: [{ name: 'maintainers', include: 'service-*' }] })).toBe(false)
    expect(validate({ collaborators: [{ username: 'octocat', exclude: 'archived-*' }] })).toBe(false)
  })

  it.each([
    [], [{ name: 'team' }], [{ name: 'team', value: 'api' }], [{ property_name: 'team', value: ['api', 'worker'] }],
    { include: [{ name: 'owner', value: null }] }, { exclude: [{ name: '^OWNER-\\D+$' }] },
    { include: [], exclude: [] }, { include: [{ name: 'owner', value: 'api' }], exclude: [{ name: '.*' }] }
  ].map(config => [config]))('accepts custom property configuration %j', customProperties => {
    expect(validate({ custom_properties: customProperties })).toBe(true)
  })

  it.each([
    {}, { bogus: [] }, { include: null }, { exclude: null }, { include: [], exclude: '*' },
    { include: [], typo: [] }, { exclude: [null] }, { exclude: [{}] }, { exclude: [{ name: 1 }] },
    { exclude: [{ name: '' }] }, { exclude: [{ name: '.*', typo: true }] }, { include: ['bad'] },
    { include: [{ name: 'bad' }] }, { include: [{ value: 'bad' }] }, { include: [{ name: 'bad', value: [1] }] },
    { include: [{ name: 'bad', value: {} }] }
  ].map(config => [config]))('rejects malformed custom property configuration %j', customProperties => {
    expect(validate({ custom_properties: customProperties })).toBe(false)
  })
})

describe('ruleset scope validation', () => {
  const properties = [{ team: 'backend' }]
  const scopes = [
    ['default repo scope', {}, {}, 'repo', false],
    ['default scope with properties', {}, { suborgproperties: properties }, 'repo', true],
    ['explicit repo scope overrides inherited org', { ruleset_scope: 'org' }, { ruleset_scope: 'repo', suborgproperties: properties }, 'repo', false],
    ['explicit org scope', {}, { ruleset_scope: 'org', suborgproperties: properties }, 'org', true],
    ['explicit org overrides inherited repo', { ruleset_scope: 'repo' }, { ruleset_scope: 'org', suborgproperties: properties }, 'org', true],
    ['inherited org scope', { ruleset_scope: 'org' }, { suborgproperties: properties }, 'org', true],
    ['inherited repo scope', { ruleset_scope: 'repo' }, { suborgproperties: properties }, 'repo', true],
    ['explicit org without properties falls back to repo', {}, { ruleset_scope: 'org' }, 'repo', false],
    ['explicit org with empty properties falls back to repo', {}, { ruleset_scope: 'org', suborgproperties: [] }, 'repo', false],
    ['inherited org without properties falls back to repo', { ruleset_scope: 'org' }, {}, 'repo', false],
    ['inherited org with empty properties falls back to repo', { ruleset_scope: 'org' }, { suborgproperties: [] }, 'repo', false]
  ]

  it.each(scopes)('%s matches runtime scope and validates supported condition shapes', (_label, config, suborg, effectiveScope, mayUseOrgConditions) => {
    expect(Settings.prototype.getEffectiveRulesetScope.call({ config }, suborg)).toBe(effectiveScope)
    // A standalone suborg schema cannot see the org default; permit either API
    // shape when a missing scope could inherit org, even if this fixture uses repo.
    expect(validators.suborgs({ ...suborg, rulesets: [ruleset()] })).toBe(true)
    for (const condition of Object.keys(repositoryConditions)) {
      expect(validators.suborgs({ ...suborg, rulesets: [orgRuleset(condition)] })).toBe(mayUseOrgConditions)
    }
  })

  it.each(Object.keys(repositoryConditions))('allows %s only for org rulesets', condition => {
    expect(validators.settings({ rulesets: [orgRuleset(condition)] })).toBe(true)
    expect(validators.repos({ rulesets: [orgRuleset(condition)] })).toBe(false)
  })

  it.each(['org', undefined])('rejects malformed org conditions with %s suborg scope', rulesetScope => {
    for (const condition of Object.keys(repositoryConditions)) {
      expect(validators.suborgs({
        ruleset_scope: rulesetScope,
        suborgproperties: properties,
        rulesets: [ruleset({ conditions: { ref_name: refCondition, [condition]: false } })]
      })).toBe(false)
    }
  })

  it('preserves org-only repository policy targets', () => {
    const entry = { ...orgRuleset(), target: 'repository', rules: [] }
    expect(validators.settings({ rulesets: [entry] })).toBe(true)
    expect(validators.suborgs({ ruleset_scope: 'org', suborgproperties: properties, rulesets: [entry] })).toBe(true)
    expect(validators.suborgs({ suborgproperties: properties, rulesets: [entry] })).toBe(true)
    expect(validators.suborgs({ ruleset_scope: 'repo', suborgproperties: properties, rulesets: [entry] })).toBe(false)
    expect(validators.repos({ rulesets: [entry] })).toBe(false)
  })

  it.each(['settings', 'suborgs'])('rejects unknown ruleset scopes in %s', file => {
    expect(validators[file]({ ruleset_scope: 'unknown', rulesets: [] })).toBe(false)
  })
})
