const ErrorStash = require('./errorStash')
const NopCommand = require('../nopcommand')

/**
 * TechAssetEnrichment Plugin
 * 
 * Reads the tech-asset-uuid custom property from the repo configuration,
 * fetches additional metadata from an external service, and enriches
 * the configuration with tech-asset-tag, tech-asset-id, etc.
 * 
 * This runs BEFORE other plugins to enrich the configuration data.
 */
module.exports = class TechAssetEnrichment extends ErrorStash {
  constructor (nop, github, repo, settings, log, errors) {
    super(errors)
    this.github = github
    this.repo = repo
    this.settings = settings || {}
    this.log = log
    this.nop = nop
    
    // External service configuration may be passed as a full config or as this plugin's subsection.
    const enrichmentConfig = settings.tech_asset_enrichment || settings
    this.serviceUrl = enrichmentConfig.service_url || process.env.TECH_ASSET_SERVICE_URL
    this.serviceToken = enrichmentConfig.service_token || process.env.TECH_ASSET_SERVICE_TOKEN
  }

  /**
   * Fetch tech asset data from external service
   */
  async fetchTechAssetData (uuid) {
    try {
      // Example: fetch from your external service
      const response = await fetch(`${this.serviceUrl}/assets/${uuid}`, {
        headers: {
          'Authorization': `Bearer ${this.serviceToken}`,
          'Accept': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch tech asset data: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      this.log.error(`Error fetching tech asset data for UUID ${uuid}: ${error.message}`)
      throw error
    }
  }

  /**
   * Get the current tech-asset-uuid from the repo's custom properties
   */
  async getCurrentTechAssetUuid() {
    try {
      const { owner, repo } = this.repo
      const customProperties = await this.github.paginate(
        this.github.rest.repos.getCustomPropertiesValues,
        {
          owner,
          repo,
          per_page: 100
        }
      )

      const techAssetProperty = customProperties.find(
        prop => prop.property_name === 'tech-asset-uuid'
      )

      return techAssetProperty ? techAssetProperty.value : null
    } catch (error) {
      this.log.debug(`Could not fetch current tech-asset-uuid: ${error.message}`)
      return null
    }
  }

  /**
   * Validate the tech-asset-uuid exists in the external service
   */
  async validateTechAssetUuid(uuid) {
    if (!uuid) {
      return { valid: false, error: 'No tech-asset-uuid provided' }
    }

    try {
      const data = await this.fetchTechAssetData(uuid)
      return { valid: true, data }
    } catch (error) {
      return { valid: false, error: error.message }
    }
  }

  /**
   * Main sync method - validates and enriches configuration
   */
  async sync() {

    // Check if custom_properties includes tech-asset-uuid
    const customProps = this.settings.custom_properties || []
    const techAssetUuidProp = customProps.find(
      prop => prop.name === 'tech-asset-uuid' || prop.property_name === 'tech-asset-uuid'
    )

    if (!techAssetUuidProp) {
      this.log.debug(`No tech-asset-uuid found in config for ${this.repo.repo}`)
      return Promise.resolve()
    }

    const uuid = techAssetUuidProp.value

    // Validate the UUID with external service
    const validation = await this.validateTechAssetUuid(uuid)

    if (!validation.valid) {
      const errorMsg = `Invalid tech-asset-uuid '${uuid}': ${validation.error}`
      this.log.error(errorMsg)
      
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(
            this.constructor.name,
            this.repo,
            null,
            errorMsg,
            'ERROR'
          )
        ])
      }

      // Add a topic to flag the error
      try {
        const { data: topics } = await this.github.rest.repos.getAllTopics({
          owner: this.repo.owner,
          repo: this.repo.repo
        })
        
        if (!topics.names.includes('tech-asset-validation-error')) {
          topics.names.push('tech-asset-validation-error')
          await this.github.rest.repos.replaceAllTopics({
            owner: this.repo.owner,
            repo: this.repo.repo,
            names: topics.names
          })
        }
      } catch (e) {
        this.log.debug(`Could not add validation error topic: ${e.message}`)
      }

      throw new Error(errorMsg)
    }

    // Enrich the configuration with additional properties from external service
    const assetData = validation.data
    const enrichedProperties = [
      { name: 'tech-asset-uuid', value: uuid },
      { name: 'tech-asset-tag', value: assetData.tag },
      { name: 'tech-asset-id', value: assetData.id },
      { name: 'tech-asset-owner', value: assetData.owner },
      // Add any other properties from your service
    ]

    // Merge enriched properties back into settings
    // This modifies the settings object that will be used by subsequent plugins
    if (!this.settings.custom_properties) {
      this.settings.custom_properties = []
    }

    // Remove existing tech-asset-* properties to avoid duplicates
    this.settings.custom_properties = this.settings.custom_properties.filter(
      prop => !prop.name.startsWith('tech-asset-')
    )

    // Add enriched properties
    this.settings.custom_properties.push(...enrichedProperties)

    const msg = `Validated and enriched tech-asset-uuid: ${uuid} -> ${JSON.stringify(assetData)}`
    this.log.info(msg)

    if (this.nop) {
      return Promise.resolve([
        new NopCommand(
          this.constructor.name,
          this.repo,
          null,
          msg,
          'INFO'
        )
      ])
    }

    // Remove validation error topic if it exists
    try {
      const { data: topics } = await this.github.rest.repos.getAllTopics({
        owner: this.repo.owner,
        repo: this.repo.repo
      })
      
      if (topics.names.includes('tech-asset-validation-error')) {
        topics.names = topics.names.filter(t => t !== 'tech-asset-validation-error')
        await this.github.rest.repos.replaceAllTopics({
          owner: this.repo.owner,
          repo: this.repo.repo,
          names: topics.names
        })
      }
    } catch (e) {
      this.log.debug(`Could not remove validation error topic: ${e.message}`)
    }

    return Promise.resolve()
  }
}
