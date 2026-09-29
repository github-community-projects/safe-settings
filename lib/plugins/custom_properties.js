const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

module.exports = class CustomProperties extends Diffable {
  constructor (nop, github, repo, entries, log, errors) {
    const objectConfig = entries !== null && entries !== undefined && !Array.isArray(entries)
    const parsed = objectConfig ? CustomProperties.parseConfig(entries) : null
    super(nop, github, repo, parsed ? parsed.include : entries, log, errors)
    this.exclude = parsed ? parsed.exclude.map(item => new RegExp(item.name, 'i')) : []
    this.excludeAll = !!parsed?.errors.length
    if (parsed) {
      for (const error of parsed.errors) this.logError(error)
      // A malformed config may still set valid values, but must never clear one.
      if (this.excludeAll) this.entries = this.entries.filter(entry => entry.value !== null)
    }

    if (this.entries) {
      this.normalizeEntries()
    }
  }

  static parseConfig (config) {
    const result = { include: [], exclude: [], errors: [] }
    const invalid = detail => result.errors.push(`Invalid custom_properties config: ${detail}. No property values will be cleared.`)
    if (Array.isArray(config)) config = { include: config }
    if (!config || typeof config !== 'object' ||
        !Object.keys(config).some(key => key === 'include' || key === 'exclude')) {
      invalid('expected a list or an object with include and/or exclude')
      return result
    }
    if (Object.keys(config).some(key => key !== 'include' && key !== 'exclude')) invalid('unknown include/exclude option')
    for (const key of ['include', 'exclude']) {
      if (!(key in config)) continue
      if (!Array.isArray(config[key])) {
        invalid(`${key} must be an array`)
        continue
      }
      for (const entry of config[key]) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          invalid(`${key} entries must be objects`)
          continue
        }
        const name = key === 'include' ? (entry.name || entry.property_name) : entry.name
        if (typeof name !== 'string' || !name.length) {
          invalid(`${key} entries require a nonempty name`)
          continue
        }
        if (key === 'exclude') {
          if (Object.keys(entry).some(key => key !== 'name')) invalid('exclude entries only accept name')
          try {
            // Case-insensitive matching must not change regex escapes such as \D.
            new RegExp(name, 'i') // eslint-disable-line no-new
            result.exclude.push({ name })
          } catch (error) {
            invalid(`exclude pattern "${name}": ${error.message}`)
          }
        } else {
          const value = entry.value
          if (!(value === null || typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string')))) {
            invalid(`include value for "${name}" must be a string, string array or null`)
            continue
          }
          result.include.push({ name: name.toLowerCase(), value })
        }
      }
    }
    return result
  }

  // Consolidate only the new shape; plain-array layers retain their existing merger.
  static mergeConfigs (configs, mergeDeep, reportError) {
    if (!configs.some(config => config !== null && config !== undefined && !Array.isArray(config))) return undefined
    configs = configs.slice(configs.lastIndexOf(null) + 1).filter(config => config !== undefined)
    if (!configs.length) return null
    if (configs.every(Array.isArray)) {
      return mergeDeep.mergeDeep({}, ...configs.map(customProperties => ({ custom_properties: customProperties }))).custom_properties
    }
    const include = new Map()
    const exclude = new Map()
    const errors = []
    for (const config of configs) {
      const parsed = this.parseConfig(config)
      errors.push(...parsed.errors)
      for (const entry of parsed.include) {
        mergeDeep.validateOverride('custom_properties', include.get(entry.name), entry)
        mergeDeep.validateConfig('custom_properties', entry)
        include.set(entry.name, entry)
      }
      for (const pattern of parsed.exclude) exclude.set(pattern.name, pattern)
    }
    for (const error of errors) reportError(error)
    return {
      include: [...include.values()].filter(entry => !errors.length || entry.value !== null),
      exclude: errors.length ? [{ name: '.*' }] : [...exclude.values()]
    }
  }

  isProtected (name) {
    return !this.entries?.some(entry => entry.name === name) &&
      (this.excludeAll || this.exclude.some(pattern => pattern.test(name)))
  }

  // Force all names to lowercase to avoid comparison issues.
  normalizeEntries () {
    this.entries = this.entries.reduce((normalizedEntries, entry) => {
      if (!entry || typeof entry !== 'object') {
        return normalizedEntries
      }

      const entryName = entry.name || entry.property_name

      if (typeof entryName !== 'string') {
        return normalizedEntries
      }

      normalizedEntries.push({
        name: entryName.toLowerCase(),
        value: entry.value
      })

      return normalizedEntries
    }, [])
  }

  async find () {
    const { owner, repo } = this.repo
    const repoFullName = `${owner}/${repo}`

    this.log.debug(`Getting all custom properties for the repo ${repoFullName}`)

    const customProperties = await this.github.paginate(
      'GET /repos/{owner}/{repo}/properties/values',
      {
        owner,
        repo,
        per_page: 100
      }
    )
    this.log.debug(`Found ${customProperties.length} custom properties`)
    // Compare and apply the same managed set so protected values do not appear
    // as deletions (or trigger suborg re-evaluation) in a dry run.
    return this.normalize(customProperties).filter(property => !this.isProtected(property.name))
  }

  // Force all names to lowercase to avoid comparison issues.
  normalize (properties) {
    return properties.reduce((normalizedProperties, property) => {
      if (!property || typeof property !== 'object') {
        return normalizedProperties
      }

      const propertyName = property.property_name || property.name

      if (typeof propertyName !== 'string') {
        return normalizedProperties
      }

      normalizedProperties.push({
        name: propertyName.toLowerCase(),
        value: property.value
      })

      return normalizedProperties
    }, [])
  }

  comparator (existing, attrs) {
    return existing.name === attrs.name
  }

  changed (existing, attrs) {
    return attrs.value !== existing.value
  }

  async update ({ name }, { value }) {
    return this.modifyProperty('Update', { name, value })
  }

  async add ({ name, value }) {
    return this.modifyProperty('Create', { name, value })
  }

  // Custom Properties on repository does not support deletion, so we set the value to null
  async remove ({ name }) {
    if (this.isProtected(name)) return []
    return this.modifyProperty('Delete', { name, value: null })
  }

  async modifyProperty (operation, { name, value }) {
    const { owner, repo } = this.repo
    const repoFullName = `${owner}/${repo}`

    const params = {
      owner,
      repo,
      properties: [{
        property_name: name,
        value
      }]
    }

    if (this.nop) {
      return new NopCommand(
        this.constructor.name,
        this.repo,
        this.github.request.endpoint('PATCH /repos/{owner}/{repo}/properties/values', params),
        `${operation} Custom Property`
      )
    }

    try {
      this.log.debug(`${operation} Custom Property "${name}" for the repo ${repoFullName}`)
      await this.github.request('PATCH /repos/{owner}/{repo}/properties/values', params)
      this.log.debug(`Successfully ${operation.toLowerCase()}d Custom Property "${name}" for the repo ${repoFullName}`)
    } catch (e) {
      this.logError(`Error during ${operation} Custom Property "${name}" for the repo ${repoFullName}: ${e.message || e}`)
    }
  }
}
