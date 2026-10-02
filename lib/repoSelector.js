const Glob = require('./glob')

/**
 * RepoSelector resolves a set of repository names from fixed criteria.
 *
 * Supported criteria:
 *   - name: explicit repo names (or glob patterns)
 *   - team: repos belonging to a GitHub team
 *   - custom_properties: repos matching custom property values
 *   - all: all repos visible to the installation
 *
 * @param {object} github - Authenticated Octokit client
 * @param {string} org - Organization name
 * @param {object} log - Logger instance
 */
class RepoSelector {
  constructor (github, org, log) {
    this.github = github
    this.org = org
    this.log = log
  }

  /**
   * Resolve repos from a list of criteria. Returns a Set of repo names.
   *
   * @param {object} criteria - Selection criteria
   * @param {boolean} [criteria.all] - Select all repos in the org
   * @param {string[]} [criteria.names] - Explicit repo names or glob patterns
   * @param {string[]} [criteria.teams] - Team slugs
   * @param {object[]} [criteria.custom_properties] - Array of { name: value } property filters
   * @returns {Promise<Set<string>>} Set of resolved repo names
   */
  async resolve (criteria) {
    if (!criteria) return new Set()

    // "all" takes precedence — return all repos without filtering
    if (criteria.all) {
      return this.getAllRepos()
    }

    const results = new Set()
    const promises = []

    if (criteria.names && Array.isArray(criteria.names)) {
      promises.push(this.resolveByName(criteria.names))
    }

    if (criteria.teams && Array.isArray(criteria.teams)) {
      promises.push(this.resolveByTeam(criteria.teams))
    }

    if (criteria.custom_properties && Array.isArray(criteria.custom_properties)) {
      promises.push(this.resolveByCustomProperties(criteria.custom_properties))
    }

    const resolved = await Promise.all(promises)
    for (const repoSet of resolved) {
      for (const name of repoSet) {
        results.add(name)
      }
    }

    return results
  }

  /**
   * Get all repos visible to the installation.
   */
  async getAllRepos () {
    const repos = new Set()
    const repositories = await this.github.paginate('GET /installation/repositories')
    for (const repo of repositories) {
      repos.add(repo.name)
    }
    return repos
  }

  /**
   * Resolve repos by explicit name or glob pattern.
   */
  async resolveByName (names) {
    const repos = new Set()
    const hasGlobs = names.some(n => n.includes('*') || n.includes('?'))

    if (hasGlobs) {
      // Need to fetch all repos and match against globs
      const allRepos = await this.github.paginate('GET /installation/repositories')
      for (const name of names) {
        const glob = new Glob(name)
        for (const repo of allRepos) {
          if (glob.test(repo.name)) {
            repos.add(repo.name)
          }
        }
      }
    } else {
      // Plain names — add directly
      for (const name of names) {
        repos.add(name)
      }
    }

    return repos
  }

  /**
   * Resolve repos by team membership.
   */
  async resolveByTeam (teams) {
    const repos = new Set()
    const teamPromises = teams.map(teamSlug => {
      const options = this.github.rest.teams.listReposInOrg.endpoint.merge({
        org: this.org,
        team_slug: teamSlug,
        per_page: 100
      })
      return this.github.paginate(options)
    })

    const results = await Promise.all(teamPromises)
    for (const teamRepos of results) {
      for (const repo of teamRepos) {
        repos.add(repo.name)
      }
    }

    return repos
  }

  /**
   * Resolve repos by custom property values.
   * Each entry in the array is an object { propertyName: propertyValue }.
   */
  async resolveByCustomProperties (properties) {
    const repos = new Set()
    const propPromises = properties.map(async (propertyFilter) => {
      const [name] = Object.keys(propertyFilter)
      const value = propertyFilter[name]

      const query = `props.${name}:${value}`
      const encodedQuery = encodeURIComponent(query)
      const options = this.github.request.endpoint(
        `/orgs/${this.org}/properties/values?repository_query=${encodedQuery}`
      )
      return this.github.paginate(options)
    })

    const results = await Promise.all(propPromises)
    for (const propRepos of results) {
      for (const repo of propRepos) {
        repos.add(repo.repository_name)
      }
    }

    return repos
  }
}

module.exports = RepoSelector
