/* eslint-disable camelcase */
const yaml = require('js-yaml')
const fs = require('fs')
const cron = require('node-cron')
const Glob = require('./lib/glob')
const ConfigManager = require('./lib/configManager')
const NopCommand = require('./lib/nopcommand')
const env = require('./lib/env')
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
  async function syncAllSettings (nop, context, repo = context.repo(), ref) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)
      if (ref) {
        return Settings.syncAll(nop, context, repo, config, ref)
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
        Settings.handleError(nop, context, repo, deploymentConfig, ref, nopcommand)
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

  async function syncSelectedSettings (nop, context, repos, subOrgs, ref) {
    try {
      deploymentConfig = await loadYamlFileSystem()
      robot.log.debug(`deploymentConfig is ${JSON.stringify(deploymentConfig)}`)
      const configManager = new ConfigManager(context, ref)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      robot.log.debug(`config for ref ${ref} is ${JSON.stringify(config)}`)
      return Settings.syncSelectedRepos(nop, context, repos, subOrgs, config, ref)
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

    const changes = [
      ...getMatchingFiles(payload.commits, 'added'),
      ...getMatchingFiles(payload.commits, 'modified')
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

    const changes = [
      ...getMatchingFiles(payload.commits, 'added'),
      ...getMatchingFiles(payload.commits, 'modified')
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
    const github = await robot.auth()
    const installations = await github.paginate(
      github.rest.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )
    robot.log.debug(`installations: ${JSON.stringify(installations)}`)
    if (installations.length > 0) {
      const installation = installations[0]
      const github = await robot.auth(installation.id)
      const app = await github.rest.apps.getAuthenticated()
      appSlug = app.data.slug
      robot.log.debug(`Validated the app is configured properly = \n${JSON.stringify(app.data, null, 2)}`)
    }
  }

  async function syncInstallation (nop = false) {
    robot.log.trace('Fetching installations')
    const github = await robot.auth()

    const installations = await github.paginate(
      github.rest.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )

    if (installations.length === 0) {
      return null
    }

    // Sync every installation. A single failing installation must not prevent
    // the remaining ones from being synced, so each iteration is isolated and
    // its error is collected instead of thrown.
    const results = []
    const errors = []
    let failed = 0

    for (const installation of installations) {
      try {
        const owner = installation.account.login
        robot.log.debug(`Syncing installation ${installation.id} for ${owner}`)
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
          // In nop mode `syncAllSettings` reports the error and returns nothing.
          // Counting that as a success would silently hide a broken config, so
          // treat a missing result as a failure of this installation.
          failed++
          const msg = `Sync of installation ${installation.id} for ${owner} returned no result`
          robot.log.error(msg)
          errors.push(new Error(msg))
          continue
        }
        results.push(result)
        if (result.errors?.length) {
          errors.push(...result.errors)
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
    if (!adminRepo) {
      return
    }

    const defaultBranch = payload.ref === 'refs/heads/' + repository.default_branch
    if (!defaultBranch) {
      robot.log.debug('Not working on the default branch, returning...')
      return
    }

    const settingsModified = payload.commits.find(commit => {
      return commit.added.includes(Settings.FILE_PATH) ||
        commit.modified.includes(Settings.FILE_PATH)
    })
    if (settingsModified) {
      robot.log.debug(`Changes in '${Settings.FILE_PATH}' detected, doing a full synch...`)
      return syncAllSettings(false, context)
    }

    let repoChanges = getAllChangedRepoConfigs(payload, context.repo().owner)

    let subOrgChanges = getAllChangedSubOrgConfigs(payload)
    repoChanges = repoChanges.filter((r, i, arr) => arr.findIndex(item => item.repo === r.repo) === i)

    subOrgChanges = subOrgChanges.filter((s, i, arr) => arr.findIndex(item => item.repo === s.repo) === i)
    robot.log.debug(`deduped repos ${JSON.stringify(repoChanges)}`)
    robot.log.debug(`deduped subOrgs ${JSON.stringify(subOrgChanges)}`)

    if (repoChanges.length > 0 || subOrgChanges.length > 0) {
      return syncSelectedSettings(false, context, repoChanges, subOrgChanges)
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

  robot.on('check_suite.requested', async context => {
    const { payload } = context
    const { repository } = payload
    const adminRepo = repository.name === env.ADMIN_REPO
    robot.log.debug(`Is Admin repo event ${adminRepo}`)
    if (!adminRepo) {
      robot.log.debug('Not working on the Admin repo, returning...')
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
    robot.log.debug(`Is Admin repo event ${adminRepo}`)
    if (!adminRepo) {
      robot.log.debug('Not working on the Admin repo, returning...')
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

    robot.log.debug(`Is Admin repo event ${adminRepo}`)
    if (!adminRepo) {
      robot.log.debug('Not working on the Admin repo, returning...')
      return
    }

    const defaultBranch = payload.pull_request.head_branch === repository.default_branch
    if (defaultBranch) {
      robot.log.debug(' Working on the default branch, returning...')
      return
    }
    return createCheckRun(context, pull_request, payload.pull_request.head.sha, payload.pull_request.head.ref)
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
    robot.log.debug(`Is Admin repo event ${adminRepo}`)
    if (!adminRepo) {
      robot.log.debug('Not working on the Admin repo, returning...')
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

    if (settingsModified) {
      robot.log.debug(`Changes in '${Settings.FILE_PATH}' detected, doing a full synch...`)
      return syncAllSettings(true, context, context.repo(), pull_request.head.ref)
    }

    const repoChanges = getChangedRepoConfigName(files, context.repo().owner)
    const subOrgChanges = getChangedSubOrgConfigName(files)

    if (repoChanges.length > 0 || subOrgChanges.length > 0) {
      return syncSelectedSettings(true, context, repoChanges, subOrgChanges, pull_request.head.ref)
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
    cron.schedule(process.env.CRON, () => {
      robot.log.debug('running a task every minute')
      syncInstallation()
    })
  }

  // Get info about the app
  info()

  return {
    syncInstallation
  }
}
