/* eslint-disable camelcase */
const yaml = require('js-yaml')
const fs = require('fs')
const cron = require('node-cron')
const ConfigManager = require('./lib/configManager')
const NopCommand = require('./lib/nopcommand')
const SettingsGenerator = require('./lib/settingsGenerator')
const AppOctokitClient = require('./lib/appOctokitClient')
const env = require('./lib/env')
const { setupRoutes } = require('./lib/routes')
const { initCache } = require('./lib/installationCache')
const { hubSyncHandler } = require('./lib/hubSyncHandler')
const { getProxyForUrl } = require('proxy-from-env')
const { setGlobalDispatcher, ProxyAgent } = require('undici')

const baseUrl = env.GHE_HOST ? `${env.GHE_PROTOCOL || 'https'}://${env.GHE_HOST}` : 'https://api.github.com'
const proxyAddress = getProxyForUrl(baseUrl)
if (proxyAddress) {
  setGlobalDispatcher(new ProxyAgent(proxyAddress))
}

let deploymentConfig

module.exports = (robot, { getRouter }, Settings = require('./lib/settings')) => {
  let appSlug = 'safe-settings'

  // Initialize all routes (static UI + API) via centralized module
  // Full-sync runs without Probot's web router; only initialize routes when
  // the runtime provides one.
  if (typeof getRouter === 'function') {
    setupRoutes(robot, getRouter)
    initCache(robot)
  }
  // Initialize installation cache (env-controlled prefetch)
  initCache(robot)

  // Cache of enterprise slug → enterprise installation id. Keyed by slug so a
  // cached id is never reused for a different enterprise (e.g. when the app
  // handles events from multiple enterprises).
  const cachedEnterpriseInstallationIds = new Map()
  async function syncAllSettings (nop, context, repo = context.repo(), ref, baseRef, changedFiles = {}) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)

      // Enrich context with enterprise info for app installation management
      await enrichContextWithEnterprise(context)

      // Load base branch config for NOP filtering (only show PR-introduced changes)
      let baseConfig = null
      if (nop && baseRef) {
        try {
          const baseConfigManager = new ConfigManager(context, baseRef)
          const baseRuntimeConfig = await baseConfigManager.loadGlobalSettingsYaml()
          baseConfig = Object.assign({}, deploymentConfig, baseRuntimeConfig)
        } catch (e) {
          robot.log.debug(`Could not load base config for NOP filtering: ${e.message}`)
        }
      }

      if (ref) {
        return Settings.syncAll(nop, context, repo, config, ref, baseConfig, changedFiles)
      } else {
        return Settings.syncAll(nop, context, repo, config)
      }
    } catch (e) {
      if (nop) {
        let filename = env.SETTINGS_FILE_PATH
        if (!deploymentConfig) {
          filename = env.DEPLOYMENT_CONFIG_FILE_PATH
          deploymentConfig = {}
        }
        const nopcommand = new NopCommand(filename, repo, null, e, 'ERROR')
        robot.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        await Settings.handleError(nop, context, repo, deploymentConfig, ref, nopcommand)
      } else {
        throw e
      }
    }
  }

  async function syncSettings (nop, context, repo = context.repo(), ref) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)
      return Settings.sync(nop, context, repo, config, ref)
    } catch (e) {
      if (nop) {
        let filename = env.SETTINGS_FILE_PATH
        if (!deploymentConfig) {
          filename = env.DEPLOYMENT_CONFIG_FILE_PATH
          deploymentConfig = {}
        }
        const nopcommand = new NopCommand(filename, repo, null, e, 'ERROR')
        robot.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        Settings.handleError(nop, context, repo, deploymentConfig, ref, nopcommand)
      } else {
        throw e
      }
    }
  }

  async function syncSelectedSettings (nop, context, repos, subOrgs, ref, baseRef) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)

      // Enrich context with enterprise info for app installation management
      await enrichContextWithEnterprise(context)

      // Load base branch config for NOP filtering (only show PR-introduced changes)
      let baseConfig = null
      if (nop && baseRef) {
        try {
          const baseConfigManager = new ConfigManager(context, baseRef)
          const baseRuntimeConfig = await baseConfigManager.loadGlobalSettingsYaml()
          baseConfig = Object.assign({}, deploymentConfig, baseRuntimeConfig)
        } catch (e) {
          robot.log.debug(`Could not load base config for NOP filtering: ${e.message}`)
        }
      }

      return Settings.syncSelectedRepos(nop, context, repos, subOrgs, config, ref, baseConfig, baseRef)
    } catch (e) {
      if (nop) {
        let filename = env.SETTINGS_FILE_PATH
        if (!deploymentConfig) {
          filename = env.DEPLOYMENT_CONFIG_FILE_PATH
          deploymentConfig = {}
        }
        const nopcommand = new NopCommand(filename, context.repo(), null, e, 'ERROR')
        robot.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        Settings.handleError(nop, context, context.repo(), deploymentConfig, ref, nopcommand)
      } else {
        throw e
      }
    }
  }

  async function renameSync (nop, context, repo = context.repo(), rename, ref) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      const renameConfig = Object.assign({}, config, rename)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)
      return Settings.sync(nop, context, repo, renameConfig, ref)
    } catch (e) {
      if (nop) {
        let filename = env.SETTINGS_FILE_PATH
        if (!deploymentConfig) {
          filename = env.DEPLOYMENT_CONFIG_FILE_PATH
          deploymentConfig = {}
        }
        const nopcommand = new NopCommand(filename, repo, null, e, 'ERROR')
        robot.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        Settings.handleError(nop, context, repo, deploymentConfig, ref, nopcommand)
      } else {
        throw e
      }
    }
  }
  /**
   * Lists all installations of the app using a JWT-authenticated client.
   *
   * @returns {Promise<Array>} All app installations
   */
  async function listAllInstallations () {
    const github = await robot.auth()
    return github.paginate(
      github.rest.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )
  }

  /**
   * Finds the enterprise installation matching the given slug from the app's
   * installation list. Returns null if none matches.
   *
   * @param {string} enterpriseSlug - Enterprise slug
   * @returns {Promise<object|null>} The matching enterprise installation
   */
  async function findEnterpriseInstallation (enterpriseSlug) {
    const installations = await listAllInstallations()
    return installations.find(
      i => i.target_type === 'Enterprise' && i.account && `${i.account.slug}`.toLowerCase() === enterpriseSlug.toLowerCase()
    ) || null
  }

  /**
   * Finds the enterprise installation for a given slug and returns an Octokit
   * client authenticated with the enterprise installation token, along with
   * the installation ID.
   *
   * Uses the cached enterprise installation ID for the given slug when
   * available to avoid re-listing installations. The cache is keyed by
   * enterprise slug so an id is never reused across enterprises. Returns null
   * if no matching enterprise installation is found.
   *
   * @param {string} enterpriseSlug - Enterprise slug
   * @returns {Promise<{ appGithub: object, installationId: number } | null>}
   */
  async function getEnterpriseAppClient (enterpriseSlug) {
    if (!enterpriseSlug) return null
    // Normalize the slug to lowercase for consistent cache keying
    enterpriseSlug = enterpriseSlug.toLowerCase()

    // Use the cached enterprise installation id for THIS slug if available.
    // Keying by slug ensures a cached id is never reused for a different
    // enterprise.
    const cachedId = cachedEnterpriseInstallationIds.get(enterpriseSlug)
    if (cachedId) {
      try {
        const appGithub = await robot.auth(cachedId)
        return { appGithub, installationId: cachedId }
      } catch (e) {
        cachedEnterpriseInstallationIds.delete(enterpriseSlug)
      }
    }

    // Find the installation targeting this enterprise
    const enterpriseInstallation = await findEnterpriseInstallation(enterpriseSlug)
    if (!enterpriseInstallation) {
      return null
    }
    cachedEnterpriseInstallationIds.set(enterpriseSlug, enterpriseInstallation.id)
    const enterpriseGithub = await robot.auth(enterpriseInstallation.id)
    return { appGithub: enterpriseGithub, installationId: enterpriseInstallation.id }
  }

  /**
   * Enriches the context with enterprise info for app installation management.
   * Extracts enterprise slug from the webhook payload, finds the enterprise
   * installation from the app's installation list, and creates an Octokit
   * client authenticated with the enterprise installation token.
   *
   * @param {object} context - Probot context
   */
  async function enrichContextWithEnterprise (context) {
    const { payload } = context
    const slugFromPayload = (payload.enterprise && payload.enterprise.slug) ||
      (payload.installation && payload.installation.enterprise && payload.installation.enterprise.slug)
    const enterpriseSlug = slugFromPayload || process.env.GH_ENTERPRISE

    if (!enterpriseSlug) return

    context.enterpriseSlug = enterpriseSlug
    try {
      const result = await getEnterpriseAppClient(enterpriseSlug)
      if (result) {
        context.appGithub = result.appGithub
      } else {
        robot.log.debug(`No enterprise installation found for slug '${enterpriseSlug}'. App installation management will not be available.`)
      }
    } catch (e) {
      robot.log.debug(`Could not create enterprise-authenticated client: ${e.message}`)
    }
  }

  /**
   * Loads the deployment config file from file system
   * Do this once when the app starts and then return the cached value
   *
   * @return The parsed YAML file
   */
  async function loadYamlFileSystem () {
    if (deploymentConfig === undefined) {
      const deploymentConfigPath = env.DEPLOYMENT_CONFIG_FILE_PATH
      if (fs.existsSync(deploymentConfigPath)) {
        deploymentConfig = yaml.load(fs.readFileSync(deploymentConfigPath))
      } else {
        deploymentConfig = { restrictedRepos: ['admin', '.github', 'safe-settings'] }
      }
    }
    return deploymentConfig
  }

  function getAllChangedSubOrgConfigs (payload) {
    const pattern = Settings.SUB_ORG_PATTERN

    const getMatchingFiles = (commits, type) =>
      commits.flatMap((c) => c[type].filter((file) => pattern.test(file)))

    // Include 'removed' so deleting a suborg config file is detected as a
    // change. The downstream delta logic loads the current version from the
    // head ref (which fails for a deleted file, yielding an empty config) and
    // diffs it against the base ref, correctly detecting removed entries such
    // as app_installations.
    const changes = [
      ...getMatchingFiles(payload.commits, 'added'),
      ...getMatchingFiles(payload.commits, 'modified'),
      ...getMatchingFiles(payload.commits, 'removed')
    ]

    return changes.map((file) => ({
      repo: file.match(/([^/]+)\.yml$/)[1],
      path: file
    }))
  }

  function getAllChangedRepoConfigs (payload, owner) {
    const pattern = Settings.REPO_PATTERN

    const getMatchingFiles = (commits, type) =>
      commits.flatMap((c) => c[type].filter((file) => pattern.test(file)))

    // Include 'removed' so deleting a repo config file is detected as a change.
    // The downstream delta logic loads the current version from the head ref
    // (which fails for a deleted file, yielding an empty config) and diffs it
    // against the base ref, correctly detecting removed entries such as
    // app_installations.
    const changes = [
      ...getMatchingFiles(payload.commits, 'added'),
      ...getMatchingFiles(payload.commits, 'modified'),
      ...getMatchingFiles(payload.commits, 'removed')
    ]

    return changes.map((file) => ({
      repo: file.match(/([^/]+)\.yml$/)[1],
      owner
    }))
  }

  function getChangedRepoConfigName (files, owner) {
    const pattern = Settings.REPO_PATTERN

    const modifiedFiles = files.filter((s) => pattern.test(s))

    return modifiedFiles.map((modifiedFile) => ({
      repo: modifiedFile.match(/([^/]+)\.yml$/)[1],
      owner
    }))
  }

  function getChangedSubOrgConfigName (files) {
    const pattern = Settings.SUB_ORG_PATTERN

    const modifiedFiles = files.filter((s) => pattern.test(s))

    return modifiedFiles.map((modifiedFile) => ({
      name: modifiedFile.match(/([^/]+)\.yml$/)[1],
      path: modifiedFile
    }))
  }
  async function createCheckRun (context, pull_request, head_sha, head_branch) {
    const { payload } = context
    // robot.log.debug(`Check suite was requested! for ${context.repo()} ${pull_request.number} ${head_sha} ${head_branch}`)
    const res = await context.octokit.rest.checks.create({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      name: 'Safe-setting validator',
      head_sha
    })
    robot.log.debug(JSON.stringify(res, null))
  }

  async function info () {
    const installations = await listAllInstallations()
    robot.log.debug(`installations: ${JSON.stringify(installations)}`)
    if (installations.length > 0) {
      const installation = installations[0]
      const github = await robot.auth(installation.id)
      const app = await github.rest.apps.getAuthenticated()
      appSlug = app.data.slug
      robot.log.info(`Validated the app is configured properly = \n${JSON.stringify(app.data, null, 2)}`)
    }

    await verifyAppInstallationsPlugin()
  }

  /**
   * Verifies that the app-installations plugin can function properly.
   *
   * When the `GH_ENTERPRISE` env variable is set, this:
   *   1. Finds the enterprise installation matching the slug.
   *   2. Mints an installation token for that enterprise installation.
   *   3. Confirms the token has permission to manage app installations in the
   *      target org (`GH_ORG`) by listing the org's app installations via the
   *      Enterprise organization installations API.
   *
   * If `GH_ENTERPRISE` is not set, this verification is skipped entirely.
   */
  async function verifyAppInstallationsPlugin () {
    const enterpriseSlug = process.env.GH_ENTERPRISE
    if (!enterpriseSlug) {
      robot.log.info('GH_ENTERPRISE is not set — skipping app-installations plugin verification')
      return
    }

    const org = process.env.GH_ORG
    if (!org) {
      robot.log.warn('GH_ENTERPRISE is set but GH_ORG is not — cannot verify app-installations plugin without a target org')
      return
    }

    try {
      const result = await getEnterpriseAppClient(enterpriseSlug)
      if (!result) {
        robot.log.warn(`No enterprise installation found for slug '${enterpriseSlug}'. App-installations plugin will not be able to manage app access. Ensure safe-settings is installed on the enterprise.`)
        return
      }

      const client = new AppOctokitClient({
        github: result.appGithub,
        enterpriseSlug,
        log: robot.log
      })

      // Confirm the token can list org app installations (validates permission)
      const orgInstallations = await client.listOrgInstallations(org)
      robot.log.info(`App-installations plugin verified: enterprise '${enterpriseSlug}' installation (id: ${result.installationId}) can manage apps in org '${org}' (${orgInstallations.length} installation(s) visible)`)
    } catch (e) {
      robot.log.error(`App-installations plugin verification failed for enterprise '${enterpriseSlug}' / org '${org}': ${e.message}`)
    }
  }

  async function syncInstallation (nop = false) {
    robot.log.trace('Fetching installations')
    let installations = (await listAllInstallations()).filter(installation => {
      // Enterprise installations supply app-management credentials, not repos.
      if (installation.target_type === 'Enterprise') {
        robot.log.debug(`Skipping enterprise installation ${installation.id} for repository sync`)
        return false
      }
      return true
    })

    if (env.GH_ORG) {
      const installation = installations.find(i =>
        typeof i.account?.login === 'string' && i.account.login.toLowerCase() === env.GH_ORG.toLowerCase()
      )
      if (!installation) {
        const accounts = installations.map(i => i.account?.login).join(', ')
        throw new Error(`No app installation found for GH_ORG '${env.GH_ORG}'. Installed on: [${accounts}]`)
      }
      installations = [installation]
    }

    if (installations.length === 0) {
      return null
    }

    const results = []
    const errors = []
    let failed = 0

    for (const installation of installations) {
      try {
        const owner = installation.account?.login
        if (typeof owner !== 'string' || !owner.trim()) {
          throw new Error(`Installation ${installation.id} has no account login for repository sync`)
        }
        robot.log.info(`Syncing installation ${installation.id} on account ${owner}`)
        const github = await robot.auth(installation.id)
        const context = {
          payload: {
            installation
          },
          octokit: github,
          log: robot.log,
          repo: () => { return { repo: env.ADMIN_REPO, owner } }
        }
        const result = await syncAllSettings(nop, context)
        if (!result) {
          // NOP configuration errors are reported without returning Settings.
          throw new Error(`Sync of installation ${installation.id} for ${owner} returned no result`)
        }
        results.push(result)
        if (result.errors?.length) {
          failed++
          errors.push(...result.errors)
          robot.log.error(`Sync of installation ${installation.id} for ${owner} reported ${result.errors.length} error(s)`)
        }
      } catch (e) {
        failed++
        robot.log.error(`Failed to sync installation ${installation.id} for ${installation.account?.login}: ${e}`)
        errors.push(e)
      }
    }

    robot.log.info(`Synced ${installations.length - failed} of ${installations.length} installation(s); ${failed} failed`)
    return { results, errors }
  }

  robot.on('push', async context => {
    const { payload } = context
    const { repository } = payload

    const adminRepo = repository.name === env.ADMIN_REPO
    const hubMasterRepo = repository.name === env.SAFE_SETTINGS_HUB_REPO && repository.owner.login === env.SAFE_SETTINGS_HUB_ORG
    if (!adminRepo && !hubMasterRepo) {
      return
    }

    const defaultBranch = payload.ref === 'refs/heads/' + repository.default_branch
    if (!defaultBranch) {
      robot.log.debug('Not working on the default branch, returning...')
      return
    }

    let repoChanges = getAllChangedRepoConfigs(payload, context.repo().owner)

    let subOrgChanges = getAllChangedSubOrgConfigs(payload)
    repoChanges = repoChanges.filter((r, i, arr) => arr.findIndex(item => item.repo === r.repo) === i)

    subOrgChanges = subOrgChanges.filter((s, i, arr) => arr.findIndex(item => item.repo === s.repo) === i)
    robot.log.debug(`deduped repos ${JSON.stringify(repoChanges)}`)
    robot.log.debug(`deduped subOrgs ${JSON.stringify(subOrgChanges)}`)

    const settingsModified = payload.commits.find(commit => {
      return commit.added.includes(Settings.FILE_PATH) ||
        commit.modified.includes(Settings.FILE_PATH)
    })
    if (settingsModified) {
      robot.log.debug(`Changes in '${Settings.FILE_PATH}' detected, doing a full synch...`)
      return syncAllSettings(false, context, context.repo(), payload.after, null, {
        repos: repoChanges,
        subOrgs: subOrgChanges
      })
    }

    if (repoChanges.length > 0 || subOrgChanges.length > 0) {
      return syncSelectedSettings(false, context, repoChanges, subOrgChanges, payload.after, payload.before)
    }

    robot.log.debug(`No changes in '${Settings.FILE_PATH}' detected, returning...`)
  })

  robot.on('create', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Branch Creation by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Branch Creation by Bot')
      return
    }
    robot.log.debug('Branch Creation by a Human')
    if (payload.repository.default_branch !== payload.ref) {
      robot.log.debug('Not default Branch')
      return
    }

    return syncSettings(false, context)
  })

  robot.on('branch_protection_rule', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Branch Protection edited by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Branch Protection edited by Bot')
      return
    }
    robot.log.debug('Branch Protection edited by a Human')
    return syncSettings(false, context)
  })

  robot.on('custom_property_values', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Custom Property Value Updated for a repo by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Custom Property Value edited by Bot')
      return
    }
    robot.log.debug('Custom Property Value edited by a Human')
    return syncSettings(false, context)
  })

  robot.on('repository_ruleset', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Repository Ruleset edited by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Repository Ruleset edited by Bot')
      return
    }

    robot.log.debug('Repository Repository edited by a Human')
    if (payload.repository_ruleset.source_type === 'Organization') {
      // For org-level events, we need to update the context since context.repo() won't work
      const updatedContext = Object.assign({}, context, {
        repo: () => { return { repo: env.ADMIN_REPO, owner: payload.organization.login } }
      })
      return syncAllSettings(false, updatedContext)
    } else {
      return syncSettings(false, context)
    }
  })

  const member_change_events = [
    'member',
    'team.added_to_repository',
    'team.removed_from_repository',
    'team.edited'
  ]

  robot.on(member_change_events, async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Repository member edited by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Repository member edited by Bot')
      return
    }
    robot.log.debug('Repository member edited by a Human')
    return syncSettings(false, context)
  })

  robot.on('repository.edited', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('repository.edited payload from ', JSON.stringify(sender))

    if (sender.type === 'Bot') {
      robot.log.debug('Repository Edited by a Bot')
      return
    }
    robot.log.debug('Repository Edited by a Human')

    return syncSettings(false, context)
  })

  robot.on('repository.renamed', async context => {
    if (env.BLOCK_REPO_RENAME_BY_HUMAN !== 'true') {
      robot.log.debug('"env.BLOCK_REPO_RENAME_BY_HUMAN" is \'false\' by default. Repo rename is not managed by Safe-settings. Continue with the default behavior.')
      return
    }
    const { payload } = context
    const { sender } = payload

    robot.log.debug(`repository renamed from ${payload.changes.repository.name.from} to ${payload.repository.name} by ', ${sender.login}`)

    if (sender.type === 'Bot') {
      robot.log.debug('Repository Edited by a Bot')
      if (sender.login === `${appSlug}[bot]`) {
        robot.log.debug('Renamed by safe-settings app')
        return
      }
      const oldPath = `.github/repos/${payload.changes.repository.name.from}.yml`
      const newPath = `.github/repos/${payload.repository.name}.yml`
      robot.log.debug(oldPath)
      try {
        const repofile = await context.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: payload.repository.owner.login,
          repo: env.ADMIN_REPO,
          path: oldPath,
          headers: {
            'X-GitHub-Api-Version': '2026-03-10'
          }
        })
        let content = Buffer.from(repofile.data.content, 'base64').toString()
        robot.log.debug(content)
        content = `# Repo Renamed and safe-settings renamed the file from ${payload.changes.repository.name.from} to ${payload.repository.name}\n# change the repo name in the config for consistency\n\n${content}`
        content = Buffer.from(content).toString('base64')
        try {
          // Check if a config file already exists for the renamed repo name
          await context.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: payload.repository.owner.login,
            repo: env.ADMIN_REPO,
            path: newPath,
            headers: {
              'X-GitHub-Api-Version': '2026-03-10'
            }
          })
        } catch (error) {
          if (error.status === 404) {
            // if the a config file does not exist, create one from the old one
            await context.octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
              owner: payload.repository.owner.login,
              repo: env.ADMIN_REPO,
              path: newPath,
              name: `${payload.repository.name}.yml`,
              content,
              message: `Repo Renamed and safe-settings renamed the file from ${payload.changes.repository.name.from} to ${payload.repository.name}`,
              sha: repofile.data.sha,
              headers: {
                'X-GitHub-Api-Version': '2026-03-10'
              }
            })
            robot.log.debug(`Created a new setting file ${newPath}`)
          } else {
            robot.log.error(error)
          }
        }
      } catch (error) {
        if (error.status === 404) {
          // nop
        } else {
          robot.log.error(error)
        }
      }
    } else {
      robot.log.debug('Repository Edited by a Human')
      // Create a repository config to reset the name back to the previous name
      const rename = { repository: { name: payload.changes.repository.name.from, oldname: payload.repository.name } }
      const repo = { repo: payload.changes.repository.name.from, owner: payload.repository.owner.login }
      return renameSync(false, context, repo, rename)
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // App installation target handler
  //
  // Note: We intentionally do NOT handle `installation.repositories_added` /
  // `installation.repositories_removed`. A GitHub App only receives those
  // events for its OWN installation, not for the managed apps (e.g. Copilot,
  // Dependabot) whose repository access safe-settings controls. They cannot
  // detect drift on managed apps, so drift is reconciled by the scheduled
  // (cron) full sync instead.
  // ────────────────────────────────────────────────────────────────────────

  robot.on('installation_target', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('Installation target changed by ', JSON.stringify(sender))
    if (sender.type === 'Bot') {
      robot.log.debug('Installation target changed by Bot')
      return
    }
    robot.log.debug('Installation target changed by a Human — triggering sync to revert drift')

    const orgLogin = (payload.organization && payload.organization.login) ||
      (payload.installation && payload.installation.account && payload.installation.account.login)
    if (!orgLogin) {
      robot.log.debug('Could not determine org login from installation_target event, skipping')
      return
    }
    const updatedContext = Object.assign({}, context, {
      repo: () => { return { repo: env.ADMIN_REPO, owner: orgLogin } }
    })
    return syncAllSettings(false, updatedContext)
  })

  robot.on('check_suite.requested', async context => {
    const { payload } = context
    const { repository } = payload
    const adminRepo = repository.name === env.ADMIN_REPO
    const hubMasterRepo = repository.name === env.SAFE_SETTINGS_HUB_REPO && repository.owner.login === env.SAFE_SETTINGS_HUB_ORG
    robot.log.debug(`Is Admin repo event ${adminRepo}, Is Hub-sync master repo ${hubMasterRepo}`)
    if (!adminRepo && !hubMasterRepo) {
      robot.log.debug('Not working on the Admin repo or Hub-sync master repo, returning...')
      return
    }
    const defaultBranch = payload.check_suite.head_branch === repository.default_branch
    if (defaultBranch) {
      robot.log.debug(' Working on the default branch, returning...')
      return
    }
    const {
      head_branch: headBranch,
      head_sha: headSha,
      pull_requests: pullRequests
    } = context.payload.check_suite

    if (!Array.isArray(pullRequests) || !pullRequests[0]) {
      robot.log.debug('Not working on a PR, returning...')
      return
    }
    const pull_request = payload.check_suite.pull_requests[0]
    return createCheckRun(context, pull_request, headSha, headBranch)
  })

  robot.on('pull_request.opened', async context => {
    robot.log.debug('Pull_request opened !')
    const { payload } = context
    const { repository } = payload
    const adminRepo = repository.name === env.ADMIN_REPO
    const hubMasterRepo = repository.name === env.SAFE_SETTINGS_HUB_REPO
    robot.log.debug(`Is Admin repo event ${adminRepo}, Is Hub-sync master repo ${hubMasterRepo}`)
    if (!adminRepo && !hubMasterRepo) {
      robot.log.debug('Not working on the Admin repo or Hub-sync master repo, returning...')
      return
    }
    const defaultBranch = payload.pull_request.head_branch === repository.default_branch
    if (defaultBranch) {
      robot.log.debug(' Working on the default branch, returning...')
      return
    }
    const pull_request = payload.pull_request
    return createCheckRun(context, pull_request, payload.pull_request.head.sha, payload.pull_request.head.ref)
  })

  robot.on('pull_request.reopened', async context => {
    robot.log.debug('Pull_request REopened !')
    const { payload } = context
    const { repository } = payload
    const pull_request = payload.pull_request
    const adminRepo = repository.name === env.ADMIN_REPO
    const hubMasterRepo = repository.name === env.SAFE_SETTINGS_HUB_REPO

    robot.log.debug(`Is Admin repo event ${adminRepo}, Is Hub-sync master repo ${hubMasterRepo}`)
    if (!adminRepo && !hubMasterRepo) {
      robot.log.debug('Not working on the Admin repo or Hub-sync master repo, returning...')
      return
    }

    const defaultBranch = payload.pull_request.head_branch === repository.default_branch
    if (defaultBranch) {
      robot.log.debug(' Working on the default branch, returning...')
      return
    }
    return createCheckRun(context, pull_request, payload.pull_request.head.sha, payload.pull_request.head.ref)
  })

  /**
   * @description Handle pull_request.closed events to support hub synchronization
   * @param {Object} context - The context object provided by Probot
   */
  robot.on('pull_request.closed', async context => {
    if (!context.payload.pull_request?.merged) return null
    try {
      await hubSyncHandler(robot, context)
    } catch (err) {
      robot.log.error(`pull_request.closed handler failed: ${err && err.message ? err.message : err}`)
    }
    return null
  })

  robot.on(['check_suite.rerequested'], async context => {
    robot.log.debug('Check suite was rerequested!')
    return createCheckRun(context)
  })

  robot.on(['check_suite.rerequested'], async context => {
    robot.log.debug('Check suite was rerequested!')
    return createCheckRun(context)
  })

  robot.on(['check_run.created'], async context => {
    robot.log.debug('Check run was created!')
    const { payload } = context
    const { repository } = payload
    const { check_run } = payload
    const { check_suite } = check_run
    const pull_request = check_suite.pull_requests[0]
    const source = payload.check_run.name === 'Safe-setting validator'
    if (!source) {
      robot.log.debug(' Not triggered by Safe-settings...')
      return
    }

    if (check_run.status === 'completed') {
      robot.log.debug(' Checkrun created as completed, returning')
      return
    }

    const adminRepo = repository.name === env.ADMIN_REPO
    const hubMasterRepo = repository.name === env.SAFE_SETTINGS_HUB_REPO && repository.owner.login === env.SAFE_SETTINGS_HUB_ORG
    robot.log.debug(`Is Admin repo event ${adminRepo}, Is Hub-sync master repo ${hubMasterRepo}`)
    if (!adminRepo && !hubMasterRepo) {
      robot.log.debug('Not working on the Admin repo or Hub-sync master repo, returning...')
      return
    }

    if (!pull_request) {
      robot.log.debug('Not working on a PR, returning...')
      return
    }

    let params = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      check_run_id: payload.check_run.id,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: { title: 'Starting NOP', summary: 'initiating...' }
    }
    robot.log.debug(`Updating check run ${JSON.stringify(params)}`)
    await context.octokit.rest.checks.update(params)

    params = Object.assign(context.repo(), { pull_number: pull_request.number })

    const changes = await context.octokit.rest.pulls.listFiles(params)
    const files = changes.data.map(f => { return f.filename })

    const settingsModified = files.includes(Settings.FILE_PATH)
    const repoChanges = getChangedRepoConfigName(files, context.repo().owner)
    const subOrgChanges = getChangedSubOrgConfigName(files)

    // Check if hub-sync master files changed - handle separately from Safe-Settings validation
    const hubPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}`.replace(/\/+/g, '/')
    const globalsPattern = new RegExp(`^${hubPath}/globals/.*\\.ya?ml$`)
    const orgsPattern = new RegExp(`^${hubPath}/organizations/([^/]+)/.*\\.ya?ml$`)
    const hubSyncFilesChanged = files.filter(f => globalsPattern.test(f) || orgsPattern.test(f))

    const baseRef = pull_request.base.ref || repository.default_branch

    if (hubSyncFilesChanged.length > 0) {
      robot.log.info(`Hub-sync master files detected: ${hubSyncFilesChanged.join(', ')}`)
      const { validateAndReportHubSync } = require('./lib/hubSyncHandler')
      return validateAndReportHubSync(robot, context, payload, pull_request, hubSyncFilesChanged, baseRef)
    }

    if (settingsModified) {
      robot.log.debug(`Changes in '${Settings.FILE_PATH}' detected, doing a full synch...`)
      return syncAllSettings(true, context, context.repo(), pull_request.head.ref, baseRef, {
        repos: repoChanges,
        subOrgs: subOrgChanges
      })
    }

    if (repoChanges.length > 0 || subOrgChanges.length > 0) {
      return syncSelectedSettings(true, context, repoChanges, subOrgChanges, pull_request.head.ref, baseRef)
    }

    // if no safe-settings changes detected, send a success to the check run
    params = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      check_run_id: payload.check_run.id,
      status: 'completed',
      completed_at: new Date().toISOString(),
      conclusion: 'success',
      output: { title: 'No Safe-settings changes detected', summary: 'No changes detected' }
    }
    robot.log.debug(`Completing check run ${JSON.stringify(params)}`)
    await context.octokit.rest.checks.update(params)
  })

  robot.on('repository.created', async context => {
    const { payload } = context
    const { sender } = payload
    robot.log.debug('repository.created payload from ', JSON.stringify(sender))
    return syncSettings(false, context)
  })

  robot.on('repository.archived', async context => {
    const { payload } = context
    const { sender } = payload

    if (sender.type === 'Bot') {
      robot.log.debug('Repository Archived by a Bot')
      return
    }
    robot.log.debug('Repository Archived by a Human')

    return syncSettings(false, context)
  })

  robot.on('repository.unarchived', async context => {
    const { payload } = context
    const { sender } = payload

    if (sender.type === 'Bot') {
      robot.log.debug('Repository Unarchived by a Bot')
      return
    }
    robot.log.debug('Repository Unarchived by a Human')

    return syncSettings(false, context)
  })

  /**
   * Generate safe-settings YAML from the current state of a repo / org /
   * collection-of-repos and open a PR against the admin repo with the result.
   *
   * @param {import('probot').Context} context
   * @param {object} opts
   * @param {'repo'|'org'|'custom-property'} opts.sourceType
   * @param {string} opts.sourceValue
   * @param {string} [opts.propertyName]
   * @param {boolean} [opts.overwrite]
   */
  async function generateSettings (context, opts) {
    const owner = context.repo().owner
    const github = context.octokit
    const generator = new SettingsGenerator(github, owner, { log: robot.log })

    const { filePath, yaml: content } = await generator.generate({
      sourceType: opts.sourceType,
      sourceValue: opts.sourceValue,
      propertyName: opts.propertyName
    })

    const targetPath = await resolveOutputPath(context, filePath, opts.overwrite)
    return openSettingsPR(context, targetPath, content, opts)
  }

  /**
   * Honor the overwrite/.sample rule against the admin repo: if overwrite is
   * false and the file already exists on the default branch, target a
   * `<name>.sample.yml` path instead.
   */
  async function resolveOutputPath (context, filePath, overwrite) {
    if (overwrite) return filePath
    const { owner } = context.repo()
    try {
      await context.octokit.rest.repos.getContent({ owner, repo: env.ADMIN_REPO, path: filePath })
      // File exists -> redirect to .sample
      return filePath.replace(/(\.ya?ml)$/i, '.sample$1')
    } catch (e) {
      if (e.status === 404) return filePath
      throw e
    }
  }

  /**
   * Create a branch on the admin repo, commit the generated file, and open a PR.
   */
  async function openSettingsPR (context, filePath, content, opts) {
    const github = context.octokit
    const { owner } = context.repo()
    const repo = env.ADMIN_REPO

    const repoInfo = await github.rest.repos.get({ owner, repo })
    const baseBranch = repoInfo.data.default_branch
    const baseRef = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
    const branchName = `safe-settings-generate/${opts.sourceType}-${opts.sourceValue}-${Date.now()}`.replace(/[^a-zA-Z0-9/_.-]/g, '-')

    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.object.sha
    })

    let existingSha
    try {
      const existing = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: branchName })
      existingSha = existing.data.sha
    } catch (e) {
      if (e.status !== 404) throw e
    }

    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      branch: branchName,
      message: `Generate ${filePath} from current ${opts.sourceType} settings`,
      content: Buffer.from(content).toString('base64'),
      sha: existingSha
    })

    const pr = await github.rest.pulls.create({
      owner,
      repo,
      title: `Generate safe-settings config for ${opts.sourceType}: ${opts.sourceValue}`,
      head: branchName,
      base: baseBranch,
      body: [
        `Auto-generated safe-settings configuration from the current state of \`${opts.sourceType}\` \`${opts.sourceValue}\`.`,
        '',
        `- File: \`${filePath}\``,
        `- Overwrite: \`${!!opts.overwrite}\``,
        '',
        'Review carefully before merging. Run in nop mode to confirm there are no unexpected diffs.'
      ].join('\n')
    })

    robot.log.info(`Opened settings-generation PR #${pr.data.number} (${filePath})`)
    return pr.data
  }

  // Trigger generation via a repository_dispatch event:
  //   event_type: safe-settings-generate
  //   client_payload: { source_type, source_value, overwrite, property_name? }
  robot.on('repository_dispatch', async context => {
    const { payload } = context
    if (payload.action !== 'safe-settings-generate') {
      robot.log.debug(`Ignoring repository_dispatch action "${payload.action}"`)
      return
    }
    const cp = payload.client_payload || {}
    const sourceType = cp.source_type
    const sourceValue = cp.source_value
    if (!sourceType || !sourceValue) {
      robot.log.error('repository_dispatch safe-settings-generate requires source_type and source_value')
      return
    }
    try {
      return await generateSettings(context, {
        sourceType,
        sourceValue,
        propertyName: cp.property_name,
        overwrite: cp.overwrite === true || cp.overwrite === 'true'
      })
    } catch (e) {
      robot.log.error(`Failed to generate settings: ${e.stack || e}`)
      throw e
    }
  })

  if (process.env.CRON) {
    /*
    # ┌────────────── second (optional)
    # │ ┌──────────── minute
    # │ │ ┌────────── hour
    # │ │ │ ┌──────── day of month
    # │ │ │ │ ┌────── month
    # │ │ │ │ │ ┌──── day of week
    # │ │ │ │ │ │
    # │ │ │ │ │ │
    # * * * * * *
    */
    cron.schedule(process.env.CRON, async () => {
      robot.log.debug('running a task every minute')
      try {
        return await syncInstallation()
      } catch (e) {
        robot.log.error(`Scheduled full sync failed: ${e}`)
        throw e
      }
    })
  }

  // Get info about the app
  info()

  return {
    syncInstallation,
    generateSettings
  }
}
