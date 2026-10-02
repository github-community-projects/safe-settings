/* eslint-disable camelcase */
const yaml = require('js-yaml')
const Settings = require('./settings')
const MergeDeep = require('./mergeDeep')
const env = require('./env')

/**
 * SettingsGenerator
 *
 * The reverse of safe-settings: read the *current* configuration of a repo /
 * org / collection-of-repos from the GitHub API and emit safe-settings YAML
 * (`repos/<name>.yml`, `settings.yml`, `suborgs/<name>.yml`).
 *
 * The heavy lifting (knowing which API to call to read current state) already
 * lives in each plugin's `find()` method, so wherever possible we instantiate
 * the existing plugin in nop mode with empty entries and reuse its `find()`.
 * The raw API shape is then reduced to the configurable subset that the
 * safe-settings schema understands.
 */

// Keys that are pure API noise and should never appear in generated config.
const NOISE_KEYS = new Set([
  'id', 'node_id', 'url', 'html_url', 'repository_url', 'labels_url', 'events_url',
  'created_at', 'updated_at', 'pushed_at', 'creator', '_links', 'current_user_can_bypass'
])

function makeLogger () {
  const noop = () => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop }
  logger.child = () => logger
  return logger
}

/**
 * Recursively strip API-only noise keys from an arbitrary value.
 * Used for sections (rulesets, environments) whose API shape is large and
 * not worth hand-mapping field by field.
 */
function stripNoise (value) {
  if (Array.isArray(value)) {
    return value.map(stripNoise)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (NOISE_KEYS.has(k)) continue
      if (v === null || v === undefined) continue
      out[k] = stripNoise(v)
    }
    return out
  }
  return value
}

/** Remove sections whose value is empty (undefined, [], {} ). */
function pruneEmpty (config) {
  const out = {}
  for (const [section, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (!Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 0) continue
    out[section] = value
  }
  return out
}

class SettingsGenerator {
  /**
   * @param {object} github An authenticated octokit instance.
   * @param {string} owner The org / owner login.
   * @param {object} [opts]
   * @param {object} [opts.log] Logger; defaults to a silent logger.
   */
  constructor (github, owner, opts = {}) {
    this.github = github
    this.owner = owner
    this.log = opts.log || makeLogger()
    this.errors = []
  }

  /**
   * Instantiate a Diffable plugin in nop mode with empty entries and return
   * its `find()` result (the current state read from GitHub).
   *
   * @param {string} section Plugin/section name (key of Settings.PLUGINS).
   * @param {object} repo { owner, repo }
   * @param {string} [scope] Optional scope passed to plugins that accept it
   *   (rulesets uses 'org' | 'repo').
   */
  async findExisting (section, repo, scope) {
    const Plugin = Settings.PLUGINS[section]
    if (!Plugin) throw new Error(`Unknown plugin section: ${section}`)
    const instance = new Plugin(true, this.github, repo, [], this.log, this.errors, scope)
    return instance.find()
  }

  // --- Section extractors -------------------------------------------------

  async repository (repo) {
    const { data } = await this.github.rest.repos.get(repo)
    const fields = [
      'name', 'description', 'homepage', 'private', 'visibility',
      'has_issues', 'has_projects', 'has_wiki', 'has_downloads', 'is_template',
      'default_branch', 'allow_squash_merge', 'allow_merge_commit',
      'allow_rebase_merge', 'allow_auto_merge', 'delete_branch_on_merge',
      'allow_update_branch', 'squash_merge_commit_title', 'squash_merge_commit_message',
      'merge_commit_title', 'merge_commit_message', 'web_commit_signoff_required',
      'archived'
    ]
    const out = {}
    for (const f of fields) {
      if (data[f] !== undefined && data[f] !== null) out[f] = data[f]
    }
    if (Array.isArray(data.topics) && data.topics.length > 0) out.topics = data.topics
    return out
  }

  async labels (repo) {
    const existing = await this.findExisting('labels', repo)
    return (existing || []).map(({ name, color, description }) => ({
      name,
      color: color ? String(color) : undefined,
      description: description || undefined
    }))
  }

  async collaborators (repo) {
    const existing = await this.findExisting('collaborators', repo)
    return (existing || [])
      .filter(c => c && c.username)
      .map(({ username, permission }) => ({ username, permission }))
  }

  async teams (repo) {
    const existing = await this.findExisting('teams', repo)
    return (existing || []).map(t => ({
      name: t.slug || t.name,
      permission: t.permission
    }))
  }

  async milestones (repo) {
    const existing = await this.findExisting('milestones', repo)
    return (existing || []).map(({ title, description, state }) => ({
      title,
      description: description || undefined,
      state: state || undefined
    }))
  }

  async autolinks (repo) {
    const existing = await this.findExisting('autolinks', repo)
    return (existing || []).map(({ key_prefix, url_template, is_alphanumeric }) => ({
      key_prefix,
      url_template,
      is_alphanumeric
    }))
  }

  async custom_properties (repo) {
    const existing = await this.findExisting('custom_properties', repo)
    return (existing || []).filter(p => p && p.value !== null && p.value !== undefined)
  }

  async variables (repo) {
    const existing = await this.findExisting('variables', repo)
    return (existing || []).map(({ name, value }) => ({ name, value }))
  }

  async environments (repo) {
    const existing = await this.findExisting('environments', repo)
    return stripNoise(existing || [])
  }

  async rulesets (repo, scope = 'repo') {
    const existing = await this.findExisting('rulesets', repo, scope)
    return (existing || []).map(rs => {
      const { source, source_type, ...rest } = stripNoise(rs)
      return rest
    })
  }

  async custom_repository_roles (repo) {
    const existing = await this.findExisting('custom_repository_roles', repo)
    return (existing || []).map(({ id, ...rest }) => rest)
  }

  async branches (repo) {
    let branchList
    try {
      branchList = await this.github.paginate(this.github.rest.repos.listBranches, {
        owner: repo.owner,
        repo: repo.repo,
        protected: true,
        per_page: 100
      })
    } catch (e) {
      this.log.debug(`Could not list protected branches for ${repo.repo}: ${e.message}`)
      return []
    }

    const result = []
    for (const b of branchList || []) {
      try {
        const { data } = await this.github.rest.repos.getBranchProtection({
          owner: repo.owner,
          repo: repo.repo,
          branch: b.name
        })
        result.push({ name: b.name, protection: this.reformatBranchProtection(data) })
      } catch (e) {
        this.log.debug(`Could not read branch protection for ${repo.repo}#${b.name}: ${e.message}`)
      }
    }
    return result
  }

  /**
   * Convert the GitHub branch-protection API response into the flatter shape
   * used by safe-settings config (boolean toggles instead of `{ enabled }`).
   * Mirrors Branches.reformatAndReturnBranchProtection.
   */
  reformatBranchProtection (protection) {
    if (!protection) return protection
    const p = stripNoise(protection)
    const flatten = key => {
      if (p[key] && typeof p[key] === 'object' && 'enabled' in p[key]) {
        p[key] = p[key].enabled
      }
    }
    flatten('required_conversation_resolution')
    flatten('allow_deletions')
    flatten('required_linear_history')
    flatten('enforce_admins')
    flatten('required_signatures')
    flatten('allow_force_pushes')
    flatten('block_creations')
    flatten('lock_branch')
    return p
  }

  // --- Scope builders -----------------------------------------------------

  /**
   * Build the full repo-level config object for a single repository.
   * @param {string} repoName
   * @returns {Promise<object>} pruned config (empty sections removed)
   */
  async buildRepoConfig (repoName) {
    const repo = { owner: this.owner, repo: repoName }
    const sections = [
      'repository', 'labels', 'collaborators', 'teams', 'milestones',
      'branches', 'autolinks', 'custom_properties', 'variables',
      'environments'
    ]
    const config = {}
    for (const section of sections) {
      try {
        config[section] = await this[section](repo)
      } catch (e) {
        this.log.warn(`Failed to extract ${section} for ${repoName}: ${e.message}`)
      }
    }
    try {
      config.rulesets = await this.rulesets(repo, 'repo')
    } catch (e) {
      this.log.warn(`Failed to extract rulesets for ${repoName}: ${e.message}`)
    }
    return pruneEmpty(config)
  }

  /**
   * Build the org-level (settings.yml) config. At org scope we can only read
   * org-level rulesets and custom repository roles.
   * @returns {Promise<object>}
   */
  async buildOrgConfig () {
    const repo = { owner: this.owner, repo: env.ADMIN_REPO }
    const config = {}
    try {
      config.rulesets = await this.rulesets(repo, 'org')
    } catch (e) {
      this.log.warn(`Failed to extract org rulesets: ${e.message}`)
    }
    try {
      config.custom_repository_roles = await this.custom_repository_roles(repo)
    } catch (e) {
      this.log.warn(`Failed to extract custom repository roles: ${e.message}`)
    }
    return pruneEmpty(config)
  }

  /**
   * Build a suborg config for all repos that carry a custom property value.
   * Settings common to ALL matching repos are kept (intersection).
   * @param {string} propertyName
   * @param {string|boolean} propertyValue
   * @returns {Promise<object>}
   */
  async buildSubOrgConfig (propertyName, propertyValue) {
    const repos = await this.findReposByProperty(propertyName, propertyValue)
    if (repos.length === 0) {
      return { suborgproperties: [{ [propertyName]: propertyValue }] }
    }

    const configs = []
    for (const repoName of repos) {
      configs.push(await this.buildRepoConfig(repoName))
    }

    const common = intersectConfigs(configs)
    return Object.assign(
      { suborgproperties: [{ [propertyName]: propertyValue }] },
      pruneEmpty(common)
    )
  }

  /**
   * High level entry point. Resolve the target file path and config content
   * for a given source descriptor.
   *
   * @param {object} source
   * @param {'repo'|'org'|'custom-property'} source.sourceType
   * @param {string} source.sourceValue For 'repo' the repo name; for 'org' the
   *   org login; for 'custom-property' a `name=value` pair (or just the value
   *   if `propertyName` is supplied separately).
   * @param {string} [source.propertyName] Custom property name (alternative to
   *   encoding it in sourceValue).
   * @returns {Promise<{ filePath: string, config: object, yaml: string }>}
   */
  async generate ({ sourceType, sourceValue, propertyName } = {}) {
    let config
    let filePath
    const base = env.CONFIG_PATH

    switch (sourceType) {
      case 'repo': {
        config = await this.buildRepoConfig(sourceValue)
        filePath = `${base}/repos/${sourceValue}.yml`
        break
      }
      case 'org': {
        config = await this.buildOrgConfig()
        filePath = `${base}/${env.SETTINGS_FILE_PATH}`
        break
      }
      case 'custom-property':
      case 'custom-property-name': {
        const { name, value } = parsePropertyValue(sourceValue, propertyName)
        config = await this.buildSubOrgConfig(name, value)
        filePath = `${base}/suborgs/${name}_${value}.yml`
        break
      }
      default:
        throw new Error(`Unsupported source type: ${sourceType}`)
    }

    return { filePath, config, yaml: toYaml(config) }
  }

  /**
   * Discover repository names that have a given custom property value.
   * Mirrors Settings.getRepositoriesByProperty.
   * @returns {Promise<string[]>}
   */
  async findReposByProperty (propertyName, propertyValue) {
    const query = `props.${propertyName}:${propertyValue}`
    const encodedQuery = encodeURIComponent(query)
    const options = this.github.request.endpoint(
      `/orgs/${this.owner}/properties/values?repository_query=${encodedQuery}`
    )
    const results = await this.github.paginate(options)
    return (results || [])
      .map(r => r.repository_name)
      .filter(Boolean)
  }
}

// --- Intersection helpers -------------------------------------------------
const NAME_FIELDS = (MergeDeep.NAME_FIELDS || [])
  .concat(['title'])

function identityOf (item) {
  if (!item || typeof item !== 'object') return undefined
  const prop = NAME_FIELDS.find(p => Object.prototype.hasOwnProperty.call(item, p))
  return prop ? `${prop}:${item[prop]}` : undefined
}

function deepEqual (a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    return ak.every(k => deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Reduce a list of config objects to the parts that are identical across ALL
 * of them.
 *  - scalars: kept only if equal everywhere
 *  - arrays: items kept only if an item with the same identity (NAME_FIELDS)
 *    AND deep-equal value is present in every config
 *  - objects: recursively intersected
 * @param {object[]} configs
 * @returns {object}
 */
function intersectConfigs (configs) {
  if (!configs || configs.length === 0) return {}
  if (configs.length === 1) return configs[0]

  const result = {}
  // Only consider sections present in every config.
  const commonSections = Object.keys(configs[0]).filter(section =>
    configs.every(c => Object.prototype.hasOwnProperty.call(c, section))
  )

  for (const section of commonSections) {
    const values = configs.map(c => c[section])
    result[section] = intersectValues(values)
  }
  return result
}

function intersectValues (values) {
  const [first] = values

  if (Array.isArray(first)) {
    if (!values.every(Array.isArray)) return undefined
    const kept = []
    for (const item of first) {
      const id = identityOf(item)
      const presentEverywhere = values.every(arr =>
        arr.some(other => (id !== undefined
          ? identityOf(other) === id && deepEqual(other, item)
          : deepEqual(other, item)))
      )
      if (presentEverywhere) kept.push(item)
    }
    return kept
  }

  if (first && typeof first === 'object') {
    if (!values.every(v => v && typeof v === 'object' && !Array.isArray(v))) return undefined
    const out = {}
    const commonKeys = Object.keys(first).filter(k =>
      values.every(v => Object.prototype.hasOwnProperty.call(v, k))
    )
    for (const k of commonKeys) {
      const intersected = intersectValues(values.map(v => v[k]))
      if (intersected !== undefined) out[k] = intersected
    }
    return out
  }

  // scalar
  return values.every(v => deepEqual(v, first)) ? first : undefined
}

/** Serialize a config object to YAML. */
function toYaml (config) {
  return yaml.dump(config, { lineWidth: -1, noRefs: true })
}

/**
 * Parse a custom-property source value. Accepts either a `name=value` pair, a
 * `name:value` pair, or just a value when `propertyName` is supplied.
 * @returns {{ name: string, value: string }}
 */
function parsePropertyValue (sourceValue, propertyName) {
  if (propertyName) {
    return { name: propertyName, value: sourceValue }
  }
  const match = /^([^=:]+)[=:](.+)$/.exec(String(sourceValue || ''))
  if (!match) {
    throw new Error(
      `custom-property source requires a "name=value" pair (got "${sourceValue}")`
    )
  }
  return { name: match[1].trim(), value: match[2].trim() }
}

module.exports = SettingsGenerator
module.exports.SettingsGenerator = SettingsGenerator
module.exports.intersectConfigs = intersectConfigs
module.exports.intersectValues = intersectValues
module.exports.deepEqual = deepEqual
module.exports.stripNoise = stripNoise
module.exports.pruneEmpty = pruneEmpty
module.exports.toYaml = toYaml
module.exports.parsePropertyValue = parsePropertyValue
