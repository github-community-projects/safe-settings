const BATCH_SIZE = 50
const API_VERSION = '2026-03-10'

/**
 * AppOctokitClient wraps an Octokit client authenticated as the GitHub App at
 * the enterprise level and provides methods for managing GitHub App
 * installation repository access via the Enterprise Organization Installations
 * API.
 *
 * All endpoints are org-scoped under
 * `/enterprises/{enterprise}/apps/organizations/{org}/...` and operate on
 * repository **names** (not IDs). Add/remove are capped at 50 repos per call
 * and are auto-batched here.
 *
 * Prerequisites:
 *   - safe-settings must be installed on the enterprise with the
 *     "Enterprise organization installations" permission.
 *   - The enterprise slug is obtained from the webhook event payload
 *     (payload.enterprise.slug).
 *
 * @see https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/organization-installations
 *
 * @param {object} options
 * @param {object} options.github - Octokit client authenticated as the app at the enterprise installation
 * @param {string} options.enterpriseSlug - Enterprise slug from webhook payload
 * @param {object} options.log - Logger instance
 */
class AppOctokitClient {
  constructor ({ github, enterpriseSlug, log }) {
    this.github = github
    this.enterpriseSlug = enterpriseSlug
    this.log = log
  }

  /**
   * List the GitHub App installations on an enterprise-owned organization.
   * Returns array of installation objects with
   * { id, app_slug, client_id, repository_selection, ... }
   *
   * @param {string} org - Organization login name
   * @returns {Promise<Array>} List of installations
   */
  async listOrgInstallations (org) {
    try {
      const options = this.github.request.endpoint.merge(
        'GET /enterprises/{enterprise}/apps/organizations/{org}/installations',
        {
          enterprise: this.enterpriseSlug,
          org,
          headers: { 'X-GitHub-Api-Version': API_VERSION }
        }
      )
      return await this.github.paginate(options)
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        throw new Error(
          `Cannot access enterprise installations API. Ensure safe-settings is installed on the enterprise '${this.enterpriseSlug}' with 'Enterprise organization installations' permission. Error: ${e.message}`
        )
      }
      throw e
    }
  }

  /**
   * List repositories accessible to an app installation on an org.
   * Returns array of { id, name, full_name }.
   *
   * @param {string} org - Organization login name
   * @param {number} installationId - The installation ID
   * @returns {Promise<Array>} List of repository objects
   */
  async listInstallationRepos (org, installationId) {
    try {
      const options = this.github.request.endpoint.merge(
        'GET /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
        {
          enterprise: this.enterpriseSlug,
          org,
          installation_id: installationId,
          headers: { 'X-GitHub-Api-Version': API_VERSION }
        }
      )
      return await this.github.paginate(options)
    } catch (e) {
      this.log.error(`Error listing repos for installation ${installationId}: ${e.message}`)
      throw e
    }
  }

  /**
   * Toggle an installation's repository access between 'all' and 'selected'.
   * When setting 'selected', `repositories` (names) must contain at least one
   * repo. When setting 'all', `repositories` must be omitted.
   *
   * @param {string} org - Organization login name
   * @param {number} installationId - The installation ID
   * @param {('all'|'selected')} selection - Desired repository selection
   * @param {string[]} [repositories] - Repo names (required for 'selected')
   * @returns {Promise<void>}
   */
  async setRepositorySelection (org, installationId, selection, repositories) {
    const params = {
      enterprise: this.enterpriseSlug,
      org,
      installation_id: installationId,
      repository_selection: selection,
      headers: { 'X-GitHub-Api-Version': API_VERSION }
    }
    if (selection === 'selected') {
      params.repositories = repositories || []
    }
    this.log.debug(`Setting repository_selection='${selection}' for installation ${installationId}`)
    await this.github.request(
      'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
      params
    )
  }

  /**
   * Grant repository access to an org installation.
   * Automatically batches into chunks of 50 (API limit).
   *
   * @param {string} org - Organization login name
   * @param {number} installationId - The installation ID
   * @param {string[]} repositoryNames - Repo names to add
   * @returns {Promise<void>}
   */
  async addReposToInstallation (org, installationId, repositoryNames) {
    if (!repositoryNames || repositoryNames.length === 0) return

    for (const batch of this._chunk(repositoryNames, BATCH_SIZE)) {
      this.log.debug(`Adding ${batch.length} repos to installation ${installationId}`)
      await this.github.request(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/add',
        {
          enterprise: this.enterpriseSlug,
          org,
          installation_id: installationId,
          repositories: batch,
          headers: { 'X-GitHub-Api-Version': API_VERSION }
        }
      )
    }
  }

  /**
   * Remove repository access from an org installation.
   * Automatically batches into chunks of 50 (API limit).
   *
   * Note: the API returns 422 if you attempt to remove repos from an
   * installation set to 'all', or remove the last remaining repository.
   *
   * @param {string} org - Organization login name
   * @param {number} installationId - The installation ID
   * @param {string[]} repositoryNames - Repo names to remove
   * @returns {Promise<void>}
   */
  async removeReposFromInstallation (org, installationId, repositoryNames) {
    if (!repositoryNames || repositoryNames.length === 0) return

    for (const batch of this._chunk(repositoryNames, BATCH_SIZE)) {
      this.log.debug(`Removing ${batch.length} repos from installation ${installationId}`)
      await this.github.request(
        'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/remove',
        {
          enterprise: this.enterpriseSlug,
          org,
          installation_id: installationId,
          repositories: batch,
          headers: { 'X-GitHub-Api-Version': API_VERSION }
        }
      )
    }
  }

  /**
   * Split an array into chunks of the given size.
   * @private
   */
  _chunk (array, size) {
    const chunks = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }
}

module.exports = AppOctokitClient
