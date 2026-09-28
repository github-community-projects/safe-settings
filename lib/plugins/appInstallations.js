/* eslint-disable camelcase */
const NopCommand = require('../nopcommand')
const AppOctokitClient = require('../appOctokitClient')

/**
 * AppInstallations plugin manages which repositories are accessible to
 * GitHub App installations in the organization.
 *
 * Unlike repo-targeting plugins (which extend Diffable), this plugin
 * operates at the org level — the "target" is an app installation,
 * not a repository.
 *
 * Supports:
 *   - Delta-based sync (incremental changes from config file diffs)
 *   - Full sync (compare desired state against live API state)
 *   - disable_plugins (skipped when disabled)
 *   - additive_plugins (only adds repos, never removes)
 */
class AppInstallations {
  /**
   * @param {boolean} nop - Dry-run mode
   * @param {object} github - Octokit client (installation-authenticated)
   * @param {object} appGithub - Octokit client (app-authenticated, for enterprise API)
   * @param {object} repo - { owner, repo } context
   * @param {string} enterpriseSlug - Enterprise slug from webhook payload
   * @param {object} log - Logger
   * @param {Array} errors - Shared errors array
   */
  constructor (nop, github, appGithub, repo, enterpriseSlug, log, errors) {
    this.nop = nop
    this.github = github
    this.repo = repo
    this.org = repo.owner
    this.log = log
    this.errors = errors || []
    this.additive = false

    if (appGithub && enterpriseSlug) {
      this.enterpriseClient = new AppOctokitClient({
        github: appGithub,
        enterpriseSlug,
        log
      })
    }
  }

  /**
   * Delta-based sync: process pre-computed per-app changes.
   *
   * @param {Array} appChanges - Array of per-app change objects:
   *   {
   *     app_slug: string,
   *     installation_id: number,
   *     repository_selection: Set<string> | Array<string> | 'all',  // repos to add
   *     repository_unselection: Set<string> | Array<string>,         // repos to remove
   *   }
   * @returns {Promise<Array>} NopCommand results (in nop mode) or empty
   */
  async syncDelta (appChanges) {
    const results = []

    if (!appChanges || appChanges.length === 0) return results

    for (const change of appChanges) {
      try {
        const appResults = await this._processAppChange(change)
        results.push(...appResults)
      } catch (e) {
        this.log.error(`Error processing app installation '${change.app_slug}': ${e.message}`)
        this.errors.push({
          owner: this.repo.owner,
          repo: this.repo.repo,
          msg: e.message,
          plugin: 'app_installations'
        })
        if (this.nop) {
          results.push(new NopCommand(
            'app_installations',
            this.repo,
            null,
            `Error: ${e.message}`,
            'ERROR'
          ))
        }
      }
    }

    return results
  }

  /**
   * Full sync: compute full desired state for all managed apps,
   * compare against live API state, and reconcile.
   *
   * @param {object} desiredState - Map of app_slug → {
   *   installation_id, repos: Set<string> | 'all', current_selection: 'all' | 'selected'
   * }
   * @returns {Promise<Array>} NopCommand results (in nop mode) or empty
   */
  async syncFull (desiredState) {
    const results = []

    if (!desiredState || Object.keys(desiredState).length === 0) return results

    if (!this.enterpriseClient) {
      const msg = 'Cannot sync app installations: enterprise client not configured. Ensure safe-settings is installed on the enterprise.'
      this.log.error(msg)
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR'))
      }
      return results
    }

    for (const [appSlug, desired] of Object.entries(desiredState)) {
      try {
        const appResults = await this._reconcileApp(appSlug, desired)
        results.push(...appResults)
      } catch (e) {
        this.log.error(`Error in full sync for app '${appSlug}': ${e.message}`)
        this.errors.push({
          owner: this.repo.owner,
          repo: this.repo.repo,
          msg: e.message,
          plugin: 'app_installations'
        })
        if (this.nop) {
          results.push(new NopCommand('app_installations', this.repo, null, `Error: ${e.message}`, 'ERROR'))
        }
      }
    }

    return results
  }

  /**
   * Reconcile a single app's desired state against its live installation state.
   * @private
   */
  async _reconcileApp (appSlug, desired) {
    const results = []
    const { installation_id, repos, current_selection } = desired

    // Desired = all repos in the org → toggle the installation to 'all'.
    if (repos === 'all') {
      if (current_selection === 'all') {
        this.log.debug(`App '${appSlug}': already set to all repositories, no change`)
        return results
      }
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, {
          msg: `App '${appSlug}': set repository_selection to 'all'`,
          additions: ['(all repositories)'],
          modifications: null,
          deletions: null
        }, { name: appSlug, type: 'app' }))
        return results
      }
      await this.enterpriseClient.setRepositorySelection(this.org, installation_id, 'all')
      this.log.debug(`App '${appSlug}': set repository_selection to 'all'`)
      return results
    }

    const desiredNames = repos instanceof Set ? repos : new Set(repos)

    // Installation is currently 'all' but desired is a specific set → switch
    // the installation to 'selected' with the desired repos. In additive mode
    // we must not narrow access, so leave 'all' untouched.
    if (current_selection === 'all') {
      if (this.additive) {
        this.log.debug(`App '${appSlug}': additive mode, leaving 'all' selection untouched`)
        return results
      }
      if (desiredNames.size === 0) {
        // The desired set is empty but the installation is 'all'. We cannot
        // narrow to zero repositories (the API rejects selecting none), so the
        // over-broad 'all' access would otherwise be silently preserved.
        // Surface this as an error so operators notice the (likely)
        // misconfiguration; the installation is left unchanged.
        const msg = `App '${appSlug}': desired repo set is empty, so safe-settings cannot narrow repository_selection from 'all' to 'selected' (the API rejects selecting zero repositories). Add at least one repository to the app's configuration, set the app to all repos at the org level, or remove the app_installations entry.`
        this.log.error(msg)
        this.errors.push({ owner: this.repo.owner, repo: this.repo.repo, msg, plugin: 'app_installations' })
        if (this.nop) {
          results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR', { name: appSlug, type: 'app' }))
        }
        return results
      }
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, {
          msg: `App '${appSlug}': narrow repository_selection from 'all' to selected`,
          additions: [...desiredNames],
          modifications: null,
          deletions: ['(all repositories)']
        }, { name: appSlug, type: 'app' }))
        return results
      }
      await this.enterpriseClient.setRepositorySelection(this.org, installation_id, 'selected', [...desiredNames])
      this.log.debug(`App '${appSlug}': set repository_selection to 'selected' with ${desiredNames.size} repos`)
      return results
    }

    // Installation is 'selected' → diff against live repos and add/remove.
    const liveRepos = await this.enterpriseClient.listInstallationRepos(this.org, installation_id)
    const liveRepoNames = new Set(liveRepos.map(r => r.name))

    const toAdd = [...desiredNames].filter(r => !liveRepoNames.has(r))
    const toRemove = this.additive
      ? [] // Additive mode: never remove
      : [...liveRepoNames].filter(r => !desiredNames.has(r))

    if (toAdd.length === 0 && toRemove.length === 0) {
      this.log.debug(`App '${appSlug}': no changes needed`)
      return results
    }

    // A 'selected' installation must retain at least one repository. When the
    // resolved desired set is empty we would have to remove every repo, which
    // the Enterprise API rejects (422). There is no valid reconciliation to
    // zero repos — surface a descriptive error instead of attempting it.
    if (desiredNames.size === 0) {
      const msg = `App '${appSlug}': cannot reconcile a 'selected' installation to zero repositories (the resolved repo set is empty). Add at least one repository to the app's configuration, set the app to all repos at the org level, or remove the app_installations entry.`
      this.log.error(msg)
      this.errors.push({ owner: this.repo.owner, repo: this.repo.repo, msg, plugin: 'app_installations' })
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR', { name: appSlug, type: 'app' }))
      }
      return results
    }

    if (this.nop) {
      results.push(new NopCommand('app_installations', this.repo, null, {
        msg: `App '${appSlug}' installation repos`,
        additions: toAdd.length > 0 ? toAdd : null,
        modifications: null,
        deletions: toRemove.length > 0 ? toRemove : null
      }, { name: appSlug, type: 'app' }))
      return results
    }

    // Apply additions BEFORE removals. In a swap (e.g. live={A}, desired={B})
    // removing first would momentarily drop the installation to zero repos,
    // which the Enterprise API rejects with 422 ('selected' installations must
    // keep at least one repo). Adding first guarantees the installation never
    // passes through an empty state. In full sync toAdd/toRemove are disjoint,
    // so ordering does not change the final repo set.
    if (toAdd.length > 0) {
      await this.enterpriseClient.addReposToInstallation(this.org, installation_id, toAdd)
      this.log.debug(`App '${appSlug}': added ${toAdd.length} repos`)
    }
    if (toRemove.length > 0) {
      try {
        await this.enterpriseClient.removeReposFromInstallation(this.org, installation_id, toRemove)
        this.log.debug(`App '${appSlug}': removed ${toRemove.length} repos`)
      } catch (e) {
        if (e && e.status === 422) {
          const msg = `App '${appSlug}': removing ${toRemove.length} repo(s) was rejected by the Enterprise API (422); a 'selected' installation must retain at least one repository.`
          this.log.error(msg)
          this.errors.push({ owner: this.repo.owner, repo: this.repo.repo, msg, plugin: 'app_installations' })
          return results
        }
        throw e
      }
    }

    return results
  }

  /**
   * Process a single app's delta change.
   * @private
   */
  async _processAppChange (change) {
    const results = []
    const { app_slug, installation_id } = change

    // Normalise selection/unselection to Sets. Delta changes computed by
    // Settings._buildAppChangesFromDelta arrive as arrays, while direct callers
    // and unit tests pass Sets — accept both. 'all' is a sentinel for the
    // whole-org toggle and is handled separately below.
    const repository_selection = change.repository_selection === 'all'
      ? 'all'
      : (change.repository_selection instanceof Set
          ? change.repository_selection
          : new Set(change.repository_selection || []))
    const repository_unselection = change.repository_unselection instanceof Set
      ? change.repository_unselection
      : new Set(change.repository_unselection || [])

    if (!this.enterpriseClient) {
      const msg = 'Cannot sync app installations: enterprise client not configured. Ensure safe-settings is installed on the enterprise.'
      this.log.error(msg)
      this.errors.push({
        owner: this.repo.owner,
        repo: this.repo.repo,
        msg,
        plugin: 'app_installations'
      })
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR'))
      }
      return results
    }

    const hasSelections = repository_selection === 'all' ||
      (repository_selection instanceof Set && repository_selection.size > 0)
    const hasUnselections = !this.additive &&
      (repository_unselection instanceof Set && repository_unselection.size > 0)

    if (!hasSelections && !hasUnselections) {
      return results
    }

    // Handle "all" selection — toggle the installation to 'all' via the API
    if (repository_selection === 'all') {
      if (this.nop) {
        results.push(new NopCommand(
          'app_installations',
          this.repo,
          null,
          {
            msg: `App '${app_slug}': set repository_selection to 'all'`,
            additions: ['(all repositories)'],
            modifications: null,
            deletions: null
          },
          { name: app_slug, type: 'app' }
        ))
        return results
      }

      await this.enterpriseClient.setRepositorySelection(this.org, installation_id, 'all')
      this.log.debug(`App '${app_slug}': set repository_selection to 'all'`)
      return results
    }

    // Handle specific repos
    if (this.nop) {
      const additions = hasSelections ? [...repository_selection] : null
      const deletions = hasUnselections ? [...repository_unselection] : null
      results.push(new NopCommand(
        'app_installations',
        this.repo,
        null,
        {
          msg: `App '${app_slug}' installation repos`,
          additions,
          modifications: null,
          deletions
        },
        { name: app_slug, type: 'app' }
      ))
      return results
    }

    // Apply additions BEFORE removals. Delta selection/unselection sets are
    // disjoint (Settings._buildAppChangesFromDelta drops any repo appearing in
    // both, selection winning), so ordering does not change the final set.
    // Adding first avoids a transient empty selection during a "swap" (e.g. a
    // suborg retargeted from repo-A to repo-B where the installation currently
    // holds only repo-A), which the Enterprise API rejects with 422 ('selected'
    // installations must keep at least one repo).
    if (hasSelections) {
      await this.enterpriseClient.addReposToInstallation(this.org, installation_id, [...repository_selection])
      this.log.debug(`App '${app_slug}': added ${repository_selection.size} repos`)
    }

    if (hasUnselections) {
      try {
        await this.enterpriseClient.removeReposFromInstallation(this.org, installation_id, [...repository_unselection])
        this.log.debug(`App '${app_slug}': removed ${repository_unselection.size} repos`)
      } catch (e) {
        if (e && e.status === 422) {
          // Delta does not fetch live installation state, so it cannot detect
          // up-front that a removal would drop the installation to zero repos.
          // Surface a descriptive error; the scheduled full sync reconciles the
          // correct end state.
          const msg = `App '${app_slug}': removing ${repository_unselection.size} repo(s) was rejected by the Enterprise API (422); a 'selected' installation must retain at least one repository. This will be reconciled on the next full sync.`
          this.log.error(msg)
          this.errors.push({ owner: this.repo.owner, repo: this.repo.repo, msg, plugin: 'app_installations' })
          return results
        }
        throw e
      }
    }

    return results
  }
}

module.exports = AppInstallations
