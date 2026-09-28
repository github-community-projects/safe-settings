const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

module.exports = class CustomProperties extends Diffable {
  constructor (...args) {
    super(...args)

    if (this.entries) {
      this.normalizeEntries()
    }
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
    return this.normalize(customProperties)
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
