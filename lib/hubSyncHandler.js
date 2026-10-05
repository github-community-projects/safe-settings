const { minimatch } = require('minimatch')
const env = require('./env')
const { getInstallations } = require('./installationCache')
const yaml = require('js-yaml')
const path = require('path')
const fs = require('fs')
const os = require('os')
const util = require('util')
const mergeBy = require('./mergeArrayBy')

/**
 * Attach a file-backed logger to robot.log that mirrors all log calls to a file.
 * It preserves the original behavior and appends each log line to a file, trimming
 * the file to the last `maxLines` entries (default 1000).
 *
 * Usage: call attachFileLogger(robot, { filePath: '/tmp/safe-settings.log', maxLines: 1000 })
 */
function attachFileLogger (robot, options = {}) {
  if (!robot || !robot.log) return
  if (robot.log.__fileLoggerAttached) return
  const filePath = options.filePath || process.env.SAFE_SETTINGS_LOG_FILE || path.join(process.cwd(), 'hubSyncHandler.log')
  const maxLines = Number(options.maxLines || process.env.SAFE_SETTINGS_LOG_FILE_MAX_LINES || 1000)
  const methods = ['info', 'warn', 'debug', 'error', 'fatal', 'trace', 'notice']

  methods.forEach(method => {
    const orig = (robot.log && robot.log[method]) ? robot.log[method].bind(robot.log) : (...args) => { /* no-op */ }
    robot.log[method] = (...args) => {
      // call original logger so console output still occurs
      try { orig(...args) } catch (e) { /* swallow */ }

      // Build a single-line message representation
      try {
        const msg = args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 2 }))).join(' ')
        const line = `${new Date().toISOString()} [${method.toUpperCase()}] ${msg}`
        // append and then trim to last `maxLines`
        fs.appendFile(filePath, line + os.EOL, err => {
          if (err) {
            try { orig(`Failed to append log to ${filePath}: ${err.message}`) } catch (e) { /* swallow */ }
            return
          }
          // trim asynchronously
          fs.promises.readFile(filePath, 'utf8').then(data => {
            const lines = data.split(/\r?\n/)
            // Remove a possible trailing empty line created by join
            if (lines.length && lines[lines.length - 1] === '') lines.pop()
            if (lines.length > maxLines) {
              const tail = lines.slice(-maxLines)
              return fs.promises.writeFile(filePath, tail.join(os.EOL) + os.EOL, 'utf8')
            }
            return Promise.resolve()
          }).catch(() => { /* don't break logging on trim failures */ })
        })
      } catch (e) {
        try { orig(`Failed to write log to ${filePath}: ${e && e.message ? e.message : e}`) } catch (e) { /* swallow */ }
      }
    }
  })

  robot.log.__fileLoggerAttached = true
}

/**
 * Get authenticated octokit client for an org installation
 * @param {import('probot').Probot} robot
 * @param {string} orgName
 * @returns {Promise<import('@octokit/rest').Octokit|null>} Authenticated client or null
 */
async function getOrgInstallation (robot, orgName) {
  const installs = await getInstallations(robot)
  const install = installs.find(i => i.account && i.account.type === 'Organization' && i.account.login.toLowerCase() === orgName.toLowerCase())
  if (!install) {
    return null
  }
  return await robot.auth(install.id)
}


// Helper to create a branch if not direct push
async function createBranchIfNeeded(githubClient, owner, repo, baseBranch, branchName, directPush, logger) {
  if (!directPush) {
    try {
      const baseRef = await githubClient.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
      const baseSha = baseRef.data.object.sha
      await githubClient.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha })
      logger.info(`Created branch ${branchName} in ${owner}/${repo}`)
    } catch (err) {
      if (err.status === 422) {
        logger.warn(`Branch ${branchName} already exists, continuing`)
      } else {
        throw err
      }
    }
  }
}

// Helper to create or update a file in a repo
async function createOrUpdateFile(githubClient, params, logger) {
  try {
    await githubClient.rest.repos.createOrUpdateFileContents(params)
    logger.info(`Committed ${params.path} to ${params.owner}/${params.repo}@${params.branch}`)
  } catch (err) {
    logger.error(`Failed to sync file ${params.path}: ${err.message}`)
    throw err
  }
}

// ============================================================================
// MANIFEST-BASED FILTERING FUNCTIONS
// ============================================================================

let manifestCache = null
let manifestCacheTime = 0
const MANIFEST_CACHE_TTL = 60000 // 1 minute

/**
 * Load and parse the manifest file with caching
 * @param {import('@octokit/rest').Octokit} octokit 
 * @param {string} ref - Git ref to load manifest from
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Parsed manifest or null if not found/invalid
 */
async function loadManifest(octokit, ref, logger) {
  const now = Date.now()
  
  // Return cached manifest if still valid
  if (manifestCache && (now - manifestCacheTime) < MANIFEST_CACHE_TTL) {
    logger.debug('Using cached manifest')
    return manifestCache
  }
  
  const manifestPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/globals/manifest.yml`
  
  try {
    const resp = await octokit.repos.getContent({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: env.SAFE_SETTINGS_HUB_REPO,
      path: manifestPath,
      ref: ref || 'main'
    })
    
    if (Array.isArray(resp.data)) {
      logger.warn(`Expected manifest file but got directory at ${manifestPath}`)
      return null
    }
    
    const manifestContent = Buffer.from(resp.data.content, resp.data.encoding).toString('utf8')
    const manifest = yaml.load(manifestContent)
    
    if (!manifest || !manifest.rules || !Array.isArray(manifest.rules)) {
      logger.warn('Invalid manifest: missing or invalid rules array')
      return null
    }
    
    // Normalize rules to new format (include/exclude)
    const normalized = normalizeManifestRules(manifest)
    
    // Cache the result
    manifestCache = normalized
    manifestCacheTime = now
    
    logger.debug(`Loaded manifest with ${normalized.rules.length} rule(s)`)
    return normalized
    
  } catch (err) {
    if (err.status === 404) {
      logger.warn(`Manifest not found at ${manifestPath} - defaulting to sync all`)
    } else {
      logger.error(`Failed to load manifest: ${err.message}`)
    }
    return null
  }
}

/**
 * Normalize manifest rules from old format to new include/exclude format
 * Supports backward compatibility with old "targets" and "files" arrays
 * @param {object} manifest - Raw manifest object
 * @returns {object} Normalized manifest
 */
function normalizeManifestRules(manifest) {
  const normalized = { rules: [] }
  
  for (const rule of manifest.rules) {
    const normalizedRule = {
      name: rule.name || 'unnamed-rule',
      enabled: rule.enabled !== false, // Default to true
      mergeStrategy: rule.mergeStrategy || 'merge',
      org_targets: null,
      files_to_sync: null
    }
    
    // Normalize org_targets
    if (rule.org_targets) {
      // New format already present
      normalizedRule.org_targets = {
        include: Array.isArray(rule.org_targets.include) ? rule.org_targets.include : [],
        exclude: Array.isArray(rule.org_targets.exclude) ? rule.org_targets.exclude : []
      }
    } else if (rule.targets) {
      // Old format - convert to include list
      normalizedRule.org_targets = {
        include: Array.isArray(rule.targets) ? rule.targets : [],
        exclude: []
      }
    } else {
      // No org targets specified - default to all
      normalizedRule.org_targets = {
        include: ['*'],
        exclude: []
      }
    }
    
    // Normalize files_to_sync
    if (rule.files_to_sync) {
      // New format already present
      normalizedRule.files_to_sync = {
        include: Array.isArray(rule.files_to_sync.include) ? rule.files_to_sync.include : [],
        exclude: Array.isArray(rule.files_to_sync.exclude) ? rule.files_to_sync.exclude : []
      }
    } else if (rule.files) {
      // Old format - convert to include list
      normalizedRule.files_to_sync = {
        include: Array.isArray(rule.files) ? rule.files : [],
        exclude: []
      }
    } else {
      // No files specified - default to all yml files
      normalizedRule.files_to_sync = {
        include: ['*.yml'],
        exclude: []
      }
    }
    
    normalized.rules.push(normalizedRule)
  }
  
  return normalized
}

/**
 * Check if an organization name matches any rule's org_targets
 * @param {string} orgName - Organization name to check
 * @param {object} manifest - Normalized manifest object
 * @param {object} logger - Logger instance
 * @returns {boolean} True if org should be included in sync
 */
function matchesOrgTargets(orgName, manifest, logger) {
  if (!manifest || !manifest.rules) {
    // No manifest - default to allowing all orgs
    return true
  }
  
  // Check each rule - org is included if ANY rule includes it
  for (const rule of manifest.rules) {
    if (!rule.enabled) continue
    
    const { include, exclude } = rule.org_targets
    
    // Check if excluded first
    const isExcluded = exclude.some(pattern => minimatch(orgName, pattern))
    if (isExcluded) {
      logger.debug(`Org ${orgName} excluded by rule '${rule.name}' (pattern matched exclude list)`)
      continue
    }
    
    // Check if included
    const isIncluded = include.some(pattern => minimatch(orgName, pattern))
    if (isIncluded) {
      logger.debug(`Org ${orgName} included by rule '${rule.name}'`)
      return true
    }
  }
  
  logger.info(`Org ${orgName} not matched by any manifest rule - excluding from sync`)
  return false
}

/**
 * Check if a file path matches any rule's files_to_sync
 * @param {string} filePath - Relative file path (e.g., 'settings.yml', 'repos/repo-x.yml')
 * @param {object} manifest - Normalized manifest object
 * @param {object} logger - Logger instance
 * @returns {boolean} True if file should be synced
 */
function matchesFilesToSync(filePath, manifest, logger) {
  if (!manifest || !manifest.rules) {
    // No manifest - default to allowing all files
    return true
  }
  
  // Extract just the filename/path relative to the org or globals folder
  const fileName = filePath.split('/').pop()
  const relPath = filePath.includes('/') ? filePath.split('/').slice(-2).join('/') : fileName
  
  // Check each rule - file is synced if ANY rule includes it
  for (const rule of manifest.rules) {
    if (!rule.enabled) continue
    
    const { include, exclude } = rule.files_to_sync
    
    // Check if excluded first
    const isExcluded = exclude.some(pattern => 
      minimatch(fileName, pattern) || minimatch(relPath, pattern) || minimatch(filePath, pattern)
    )
    if (isExcluded) {
      logger.debug(`File ${filePath} excluded by rule '${rule.name}'`)
      continue
    }
    
    // Check if included
    const isIncluded = include.some(pattern => 
      minimatch(fileName, pattern) || minimatch(relPath, pattern) || minimatch(filePath, pattern)
    )
    if (isIncluded) {
      logger.debug(`File ${filePath} included by rule '${rule.name}'`)
      return true
    }
  }
  
  logger.info(`File ${filePath} not matched by any manifest rule - excluding from sync`)
  return false
}

/**
 * Check if an org update should proceed based on manifest rules
 * @param {string} orgName - Organization name
 * @param {string} filePath - File being synced
 * @param {object} manifest - Normalized manifest
 * @param {object} logger - Logger instance
 * @returns {boolean} True if sync should proceed
 */
function shouldSyncOrgUpdate(orgName, filePath, manifest, logger) {
  // Check both org and file filters
  const orgMatches = matchesOrgTargets(orgName, manifest, logger)
  const fileMatches = matchesFilesToSync(filePath, manifest, logger)
  
  const shouldSync = orgMatches && fileMatches
  
  if (!shouldSync) {
    logger.info(`Skipping sync for ${orgName}/${filePath}: org_match=${orgMatches}, file_match=${fileMatches}`)
  }
  
  return shouldSync
}

/**
 * Filter a list of organizations by manifest rules
 * @param {string[]} orgNames - List of organization names
 * @param {object} manifest - Normalized manifest
 * @param {object} logger - Logger instance
 * @returns {string[]} Filtered list of organizations
 */
function filterOrgsByManifest(orgNames, manifest, logger) {
  if (!manifest) {
    return orgNames
  }
  
  return orgNames.filter(orgName => matchesOrgTargets(orgName, manifest, logger))
}

// ============================================================================
// END MANIFEST-BASED FILTERING FUNCTIONS
// ============================================================================

/**
 * Sync changed safe-settings organization files from the master admin PR
 * into the target organization's admin repository.
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 * @param {string} orgName Destination organization login (also folder name under organizations/)
 * @param {string} destRepo Destination repo name inside orgName (e.g. admin repo)
 * @param {string} destinationFolder Base folder in destination repo where content lives (e.g. .github or .github/safe-settings)
 */
async function syncHubOrgUpdate (robot, context, orgName, destRepo, destinationFolder) {
  attachFileLogger(robot)
  try {
    robot.log.info(`Syncing safe settings for organization: ${orgName}`)
    robot.log.info(`Organization: ${orgName}, Destination Repo: ${destRepo}, Destination Folder: ${destinationFolder}`)
    const pr = context.payload.pull_request
    if (!pr) {
      robot.log.warn('No pull_request payload found; aborting sync')
      return
    }
    const { owner: srcOwner, repo: srcRepo } = context.repo()
    const pull_number = pr.number
    const configRoot = env.CONFIG_PATH || '.github/'
    const sourceBase = (`${configRoot}/${env.SAFE_SETTINGS_HUB_PATH}/organizations`).replace(/\/$/, '')
    robot.log.debug(`sourceBase='${sourceBase}'`)
    robot.log.debug(`env.CONFIG_PATH='${env.CONFIG_PATH}', env.SAFE_SETTINGS_HUB_PATH='${env.SAFE_SETTINGS_HUB_PATH}'`)
    const files = await context.octokit.paginate(
      context.octokit.rest.pulls.listFiles,
      { owner: srcOwner, repo: srcRepo, pull_number, per_page: 100 }
    )
    robot.log.debug(`PR #${pull_number} contains ${files.length} changed file(s)`)
    if (files.length) robot.log.debug(`files=${files.map(f => f.filename).join(', ')}`)
    if (files.length) {
      try {
        robot.log.debug(`first file object = ${JSON.stringify(files[0], null, 2)}`)
        robot.log.debug(`file[0] keys = ${Object.keys(files[0] || {}).join(', ')}`)
      } catch (e) {
        robot.log.debug(`failed to stringify first file: ${e.message}`)
      }
      files.forEach((f, i) => {
        try {
          robot.log.debug(`FILE[${i}] raw=${JSON.stringify(f)}`)
          robot.log.debug(`FILE[${i}] filename=${JSON.stringify(f.filename)} length=${(f.filename || '').length}`)
        } catch (e) {
          robot.log.debug(`FILE[${i}] stringify error: ${e.message}`)
        }
      })
    }
    const orgPrefix = `${sourceBase}/${orgName}/`
    robot.log.debug(`files=${files.map(f => f.filename).join(', ')}`)
    robot.log.debug(`Path ${sourceBase}/${orgName}`)
    const relevant = files.filter(f => f.filename === `${sourceBase}/${orgName}` || f.filename.startsWith(orgPrefix))
    robot.log.debug(`Found ${relevant.length} changed file(s) relevant to org ${orgName}`)
    if (!relevant.length) {
      robot.log.info(`No files for org ${orgName} in PR #${pull_number}`)
      files.forEach(f => {
        const exact = f.filename === `${sourceBase}/${orgName}`
        const pref = f.filename.startsWith(orgPrefix)
        robot.log.info(`MATCH CHECK: file='${f.filename}' exact=${exact} prefix=${pref}`)
      })
      const altBase = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/organizations`
      const altPrefix = `${altBase}/${orgName}/`
      files.forEach(f => {
        const exactAlt = f.filename === `${altBase}/${orgName}`
        const prefAlt = f.filename.startsWith(altPrefix)
        robot.log.info(`ALT CHECK: file='${f.filename}' exactAlt=${exactAlt} prefAlt=${prefAlt}`)
      })
      return
    }
    
    // Load manifest and check if this org/files should be synced
    const manifest = await loadManifest(context.octokit, pr.head.sha, robot.log)
    
    // Check if org is allowed by manifest
    if (!matchesOrgTargets(orgName, manifest, robot.log)) {
      robot.log.info(`Organization ${orgName} excluded by manifest rules - skipping sync`)
      return
    }
    
    // Filter files based on manifest rules
    const filteredFiles = relevant.filter(f => {
      const relativePath = f.filename.replace(orgPrefix, '')
      return matchesFilesToSync(relativePath, manifest, robot.log)
    })
    
    if (!filteredFiles.length) {
      robot.log.info(`All ${relevant.length} file(s) for org ${orgName} were excluded by manifest rules - skipping sync`)
      return
    }
    
    robot.log.info(`After manifest filtering: ${filteredFiles.length} of ${relevant.length} file(s) will be synced`)
    
    const destOwner = orgName
    const destBase = (destinationFolder || env.CONFIG_PATH || '.github').replace(/\/$/, '')
    const destBaseBranch = 'main'
    const directPush = (env.SAFE_SETTINGS_HUB_DIRECT_PUSH === 'true' || env.SAFE_SETTINGS_HUB_DIRECT_PUSH === '1')
    const githubDest = await getOrgInstallation(robot, destOwner)
    if (!githubDest) {
      robot.log.warn(`Installation for destination org ${destOwner} not found; cannot sync`)
      return
    }
    robot.log.info(`Syncing from ${srcOwner}/${srcRepo} PR #${pull_number} to ${destOwner}/${destRepo}@${destBaseBranch} under ${destBase} (directPush=${directPush})`)
    const timestamp = Date.now()
    const branchName = directPush ? destBaseBranch : `safe-settings-sync/pr-${pull_number}-${orgName}-${timestamp}`
    await createBranchIfNeeded(githubDest, destOwner, destRepo, destBaseBranch, branchName, directPush, robot.log)
    // Check if settings.yml is being synced - if so, use merge logic
    const settingsFileChanged = filteredFiles.some(f => f.filename.endsWith('/settings.yml'))
    
    if (settingsFileChanged) {
      robot.log.info(`Detected settings.yml change - will merge with globals`)
      
      // Load and merge settings (in-memory only)
      const mergedContent = await loadAndMergeSettings(robot, context.octokit, orgName, pr.head.sha)
      
      if (mergedContent) {
        const destPath = `${destBase}/settings.yml`.replace(/\/+/g, '/')
        const encoded = Buffer.from(mergedContent, 'utf8').toString('base64')
        
        let existingSha
        try {
          const destGet = await githubDest.rest.repos.getContent({ owner: destOwner, repo: destRepo, path: destPath, ref: destBaseBranch })
          if (!Array.isArray(destGet.data)) existingSha = destGet.data.sha
        } catch (getErr) {
          if (getErr.status !== 404) throw getErr
        }
        
        await createOrUpdateFile(githubDest, {
          owner: destOwner,
          repo: destRepo,
          path: destPath,
          message: directPush ? `Direct sync safe-settings (merged) from ${srcOwner}/${srcRepo} PR #${pull_number}` : `Sync safe-settings (merged) from ${srcOwner}/${srcRepo} PR #${pull_number}`,
          content: encoded,
          branch: branchName,
          sha: existingSha,
          committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
          author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
        }, robot.log)
        
        robot.log.info(`Successfully synced merged settings.yml to ${destOwner}/${destRepo}`)
      }
    }
    
    // Sync other files (non-settings.yml) without merging
    for (const f of filteredFiles) {
      let relative
      if (f.filename === `${sourceBase}/${orgName}`) {
        continue
      } else {
        relative = f.filename.slice(orgPrefix.length)
      }
      
      // Skip settings.yml - already handled with merge above
      if (relative === 'settings.yml') {
        continue
      }
      
      const destPath = `${destBase}/${relative}`.replace(/\/+/g, '/')
      const srcContentResp = await context.octokit.rest.repos.getContent({ owner: srcOwner, repo: srcRepo, path: f.filename, ref: pr.head.sha })
      const data = srcContentResp.data
      if (Array.isArray(data)) {
        continue
      }
      const fileContent = Buffer.from(data.content, data.encoding).toString('utf8')
      const encoded = Buffer.from(fileContent, 'utf8').toString('base64')
      let existingSha
      try {
        const destGet = await githubDest.rest.repos.getContent({ owner: destOwner, repo: destRepo, path: destPath, ref: destBaseBranch })
        if (!Array.isArray(destGet.data)) existingSha = destGet.data.sha
      } catch (getErr) {
        if (getErr.status !== 404) throw getErr
      }
      await createOrUpdateFile(githubDest, {
        owner: destOwner,
        repo: destRepo,
        path: destPath,
        message: directPush ? `Direct sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}` : `Sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}`,
        content: encoded,
        branch: branchName,
        sha: existingSha,
        committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
        author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
      }, robot.log)
    }
    if (!directPush) {
      try {
        const prTitle = `Sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}`
        const prBody = `Automated sync of safe-settings for ${orgName} from ${srcOwner}/${srcRepo} PR #${pull_number}.`
        const created = await githubDest.rest.pulls.create({ owner: destOwner, repo: destRepo, title: prTitle, head: branchName, base: destBaseBranch, body: prBody })
        robot.log.info(`Created PR ${created.data.html_url} in ${destOwner}/${destRepo}`)
      } catch (prErr) {
        robot.log.error(`Failed to create PR in ${destOwner}/${destRepo}: ${prErr.message}`)
        throw prErr
      }
    } else {
      robot.log.info(`Changes pushed directly to ${destOwner}/${destRepo}@${destBaseBranch}`)
    }
  } catch (err) {
    robot.log.error(`syncSafeSettingConfig error for org ${orgName}: ${err.message}`)
  }
}

/**
 * Handle closed pull requests to sync safe-settings changes to target organizations.
 * Focus on the organization and repository specified in the pull request and if they belong to the Safe-Settings Hub.
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 */
async function hubSyncHandler (robot, context) {
  attachFileLogger(robot)
  const { payload } = context
  const { repository, pull_request } = payload || {}
  robot.log.info(`Received 'pull_request.closed' event: ${pull_request && pull_request.number}`)
  try {
    // Ensure the event is from the configured Safe-Settings Hub repo/org
    const isMasterRepo = repository && repository.name === env.SAFE_SETTINGS_HUB_REPO
    const isMasterOrg = repository && repository.owner && repository.owner.login === env.SAFE_SETTINGS_HUB_ORG

    if (!(isMasterRepo && isMasterOrg)) {
      robot.log.info(`Pull request.closed is not from master admin repo/org (${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}), ignoring`)
      return
    }

    robot.log.info(`Pull request closed on Safe-Settings Hub: (${repository.full_name})`)

    // Get the PR details
    const pr = pull_request
    const { owner, repo } = context.repo()
    const pull_number = pr.number

    // Paginate through all files changed in the PR
    const files = await context.octokit.paginate(
      context.octokit.rest.pulls.listFiles,
      { owner, repo, pull_number, per_page: 100 }
    )

    robot.log.info(`Files changed in PR #${pull_number}: ${files.map(f => f.filename).join(', ')}`)

    // Routing logic: check for 'globals' or 'organizations' folder changes
    const globalsChanged = files.some(f => /\/globals\//.test(f.filename))
    const orgsChanged = files.some(f => /\/organizations\//.test(f.filename))

    if (globalsChanged) {
      robot.log.debug('Detected changes in the globals folder. Routing to syncHubGlobalsUpdate(...).')
      await module.exports.syncHubGlobalsUpdate(robot, context, files)
    }

    if (orgsChanged) {
      robot.log.debug('Detected changes in the organizations folder. Routing to syncHubOrgUpdate(...).')
      // Only sync updates in organization subfolders, not files directly in organizations folder
      const baseSettingsPath = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}/organizations`
      const normalizedBase = baseSettingsPath.replace(/\/$/, '')
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Only match files in org subfolders: .../organizations/<org>/...
      const orgSubfolderPattern = new RegExp(`^${escapeRegex(normalizedBase)}/([^/]+)/.+`)
      const orgNamesSet = new Set()
      files.forEach(f => {
        const m = f.filename.match(orgSubfolderPattern)
        if (m && m[1]) {
          orgNamesSet.add(m[1])
        }
      })
      const orgNames = Array.from(orgNamesSet)
      robot.log.info(`Orgs updated in PR #${pull_number}: ${orgNames.join(', ')}`)
      for (const orgName of orgNames) {
        const destRepo = env.ADMIN_REPO
        const destinationFolder = env.CONFIG_PATH || '.github'
        await module.exports.syncHubOrgUpdate(robot, context, orgName, destRepo, destinationFolder)
      }
    }
  } catch (err) {
    robot.log.error(`Failed to sync safe settings: ${err && err.message ? err.message : err}`)
  }
}

/**
 * Handle updates in the globals folder and sync to destinations defined in manifest.yml rules
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 * @param {Array<Object>} files - Array of changed file objects from PR
 */
async function syncHubGlobalsUpdate (robot, context, files) {
  attachFileLogger(robot)
  robot.log.info(`Syncing safe settings for 'globals/'.`)
  
  // Get PR head SHA for loading manifest and files
  const pr = context.payload.pull_request
  const prHeadSha = pr ? pr.head.sha : 'main'
  
  // Load manifest with new filtering logic
  const manifest = await loadManifest(context.octokit, prHeadSha, robot.log)
  
  const changedGlobals = files.filter(f => /\/globals\//.test(f.filename))
  if (!changedGlobals.length) {
    robot.log.info('No changed files in globals folder.')
    return
  }
  
  // Get all org installations
  const installs = await getInstallations(robot)
  const allOrgLogins = installs.filter(i => i.account && i.account.type === 'Organization').map(i => i.account.login)
  
  // Filter orgs by manifest rules
  const filteredOrgLogins = filterOrgsByManifest(allOrgLogins, manifest, robot.log)
  robot.log.info(`After manifest filtering: ${filteredOrgLogins.length} of ${allOrgLogins.length} org(s) will receive updates`)
  
  if (!filteredOrgLogins.length) {
    robot.log.info('No organizations match manifest rules - skipping globals sync')
    return
  }
  
  for (const fileObj of changedGlobals) {
    const fileName = fileObj.filename.split('/').pop()
    if (fileName === 'manifest.yml') {
      robot.log.debug(`Skipping sync for manifest.yml (should only exist in hub)`)
      continue
    }
    
    // Check if file should be synced according to manifest
    if (!matchesFilesToSync(fileName, manifest, robot.log)) {
      robot.log.info(`File ${fileName} excluded by manifest rules - skipping`)
      continue
    }
    
    robot.log.debug(`Evaluating globals file: ${fileObj.filename}`)
    
    // Special handling for settings.yml - merge with each org's settings
    if (fileName === 'settings.yml') {
      robot.log.info(`Detected globals/settings.yml change - will merge with all org-specific settings.yml`)
      
      // Get all organizations from the organizations/ directory
      const orgsPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/organizations`
      let orgDirs = []
      try {
        const orgsResp = await context.octokit.repos.getContent({
          owner: env.SAFE_SETTINGS_HUB_ORG,
          repo: env.SAFE_SETTINGS_HUB_REPO,
          path: orgsPath,
          ref: prHeadSha
        })
        if (Array.isArray(orgsResp.data)) {
          orgDirs = orgsResp.data.filter(item => item.type === 'dir').map(item => item.name)
          
          // Filter orgDirs by manifest rules
          orgDirs = filterOrgsByManifest(orgDirs, manifest, robot.log)
          
          robot.log.info(`Found ${orgDirs.length} organizations to sync (after manifest filtering): ${orgDirs.join(', ')}`)
        }
      } catch (err) {
        robot.log.warn(`Could not list organizations directory: ${err.message}`)
      }
      
      // Merge and sync settings.yml for each org
      for (const orgName of orgDirs) {
        robot.log.info(`Processing merge for org: ${orgName}`)
        
        const destRepo = env.ADMIN_REPO
        const githubDest = await getOrgInstallation(robot, orgName)
        if (!githubDest) {
          robot.log.info(`Skipping org ${orgName}: no installation found.`)
          continue
        }
        
        // Check if destination repo exists
        let repoExists = false
        try {
          await githubDest.repos.get({ owner: orgName, repo: destRepo })
          repoExists = true
        } catch (err) {
          if (err.status === 404) {
            robot.log.info(`Skipping org ${orgName}: config repo '${destRepo}' does not exist.`)
            continue
          } else {
            throw err
          }
        }
        
        if (!repoExists) continue
        
        // Load and merge settings
        const mergedContent = await loadAndMergeSettings(robot, context.octokit, orgName, prHeadSha)
        if (!mergedContent) {
          robot.log.info(`No settings content to sync for org ${orgName}`)
          continue
        }
        
        const destPath = `${env.CONFIG_PATH}/settings.yml`
        const encoded = Buffer.from(mergedContent, 'utf8').toString('base64')
        
        let existingSha
        try {
          const destGet = await githubDest.repos.getContent({
            owner: orgName,
            repo: destRepo,
            path: destPath,
            ref: 'main'
          })
          if (!Array.isArray(destGet.data)) {
            existingSha = destGet.data.sha
          }
        } catch (err) {
          if (err.status !== 404) {
            robot.log.warn(`Error checking existing file: ${err.message}`)
          }
        }
        
        // Determine push strategy
        const directPush = (env.SAFE_SETTINGS_HUB_DIRECT_PUSH === 'true' || env.SAFE_SETTINGS_HUB_DIRECT_PUSH === '1')
        const timestamp = Date.now()
        const branchName = directPush ? 'main' : `safe-settings-sync/globals-${timestamp}`
        
        if (!directPush) {
          try {
            const baseRef = await githubDest.rest.git.getRef({ owner: orgName, repo: destRepo, ref: 'heads/main' })
            const baseSha = baseRef.data.object.sha
            await githubDest.rest.git.createRef({ owner: orgName, repo: destRepo, ref: `refs/heads/${branchName}`, sha: baseSha })
            robot.log.info(`Created branch ${branchName} in ${orgName}/${destRepo}`)
          } catch (err) {
            if (err.status === 422) {
              robot.log.warn(`Branch ${branchName} already exists, continuing`)
            } else {
              throw err
            }
          }
        }
        
        // Commit merged file
        try {
          await githubDest.rest.repos.createOrUpdateFileContents({
            owner: orgName,
            repo: destRepo,
            path: destPath,
            message: `Sync merged settings.yml from globals update (PR #${pr.number})`,
            content: encoded,
            branch: branchName,
            sha: existingSha,
            committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
            author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
          })
          robot.log.info(`Committed merged settings.yml to ${orgName}/${destRepo}@${branchName}`)
          
          // Create PR if not direct push
          if (!directPush) {
            try {
              const prTitle = `Sync settings.yml from globals update`
              const prBody = `Automated sync of merged settings.yml from globals/settings.yml update.\n\nThis PR contains the merged configuration from globals and org-specific settings.`
              const created = await githubDest.rest.pulls.create({
                owner: orgName,
                repo: destRepo,
                title: prTitle,
                head: branchName,
                base: 'main',
                body: prBody
              })
              robot.log.info(`Created PR ${created.data.html_url} in ${orgName}/${destRepo}`)
            } catch (prErr) {
              robot.log.error(`Failed to create PR in ${orgName}/${destRepo}: ${prErr.message}`)
            }
          }
        } catch (commitErr) {
          robot.log.error(`Failed to commit to ${orgName}/${destRepo}: ${commitErr.message}`)
        }
      }
      
      // Skip the regular sync logic for settings.yml
      continue
    }
    
    // For non-settings.yml files, sync to filtered orgs
    robot.log.debug(`Syncing ${fileName} to ${filteredOrgLogins.length} organization(s)`)
    
    for (const orgName of filteredOrgLogins) {
      robot.log.debug(`Preparing to sync file '${fileName}' to org '${orgName}'`)
      const destRepo = env.ADMIN_REPO
      const githubDest = await getOrgInstallation(robot, orgName)
      if (!githubDest) {
        robot.log.info(`Skipping org ${orgName}: no installation found.`)
        continue
      }
      
      // Check if destination repo exists
      let repoExists = false
      try {
        await githubDest.repos.get({ owner: orgName, repo: destRepo })
        repoExists = true
      } catch (err) {
        if (err.status === 404) {
          robot.log.info(`Skipping org ${orgName}: config repo '${destRepo}' does not exist.`)
          continue
        } else {
          throw err
        }
      }
      
      if (!repoExists) continue
      
      const destPath = `${env.CONFIG_PATH}/${fileName}`
      let exists = false
      let existingSha = undefined
      try {
        robot.log.debug(`Checking existence of ${destPath} in ${orgName}/${destRepo}`)
        const resp = await githubDest.repos.getContent({
          owner: orgName,
          repo: destRepo,
          path: destPath,
          ref: 'main'
          });
          if (!Array.isArray(resp.data)) {
            robot.log.debug(`Found ${destPath} in ${orgName}/${destRepo}`);
            exists = true;
            existingSha = resp.data.sha;
          }
        } catch (err) {
          if (err.status === 404) {
            robot.log.info(`File ${destPath} not found in ${orgName}/${destRepo} (this is fine for both merge strategies)`);
            exists = false;
            existingSha = undefined;
          } else {
            robot.log.error(`Error checking ${destPath} in ${orgName}/${destRepo}: ${err.message}`)
          throw err
        }
      }
      
      // Sync the file to this org
      robot.log.info(`Syncing ${fileName} to ${orgName}`)
      try {
        let srcContentResp
        const srcRef = prHeadSha
        srcContentResp = await context.octokit.repos.getContent({
          owner: env.SAFE_SETTINGS_HUB_ORG,
          repo: env.SAFE_SETTINGS_HUB_REPO,
          path: fileObj.filename,
          ref: srcRef
        })
        const data = srcContentResp.data
        if (Array.isArray(data)) {
          robot.log.debug(`Skipping directory ${fileObj.filename}`)
          continue
        }
        const fileContent = Buffer.from(data.content, data.encoding).toString('utf8')
        const encoded = Buffer.from(fileContent, 'utf8').toString('base64')
        const destBaseBranch = 'main'
        const directPush = (env.SAFE_SETTINGS_HUB_DIRECT_PUSH === 'true' || env.SAFE_SETTINGS_HUB_DIRECT_PUSH === '1')
        const timestamp = Date.now()
        const branchName = directPush ? destBaseBranch : `safe-settings-globals-sync/${orgName}-${fileName}-${timestamp}`
        await createBranchIfNeeded(githubDest, orgName, destRepo, destBaseBranch, branchName, directPush, robot.log)
        await createOrUpdateFile(githubDest, {
          owner: orgName,
          repo: destRepo,
          path: destPath,
          message: directPush ? `Direct sync globals file '${fileName}' from hub` : `Sync globals file '${fileName}' from hub`,
          content: encoded,
          branch: branchName,
          sha: exists ? existingSha : undefined,
          committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
          author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
        }, robot.log)
        if (!directPush) {
          try {
            const prTitle = `Sync globals file '${fileName}' from hub`
            const prBody = `Automated sync of globals file '${fileName}' from hub to ${orgName}.`
            const created = await githubDest.rest.pulls.create({ owner: orgName, repo: destRepo, title: prTitle, head: branchName, base: destBaseBranch, body: prBody })
            robot.log.info(`Created PR ${created.data.html_url} in ${orgName}/${destRepo}`)
          } catch (prErr) {
            robot.log.error(`Failed to create PR in ${orgName}/${destRepo}: ${prErr.message}`)
            throw prErr
          }
        } else {
          robot.log.info(`Changes pushed directly to ${orgName}/${destRepo}@${destBaseBranch}`)
        }
      } catch (syncErr) {
        robot.log.error(`Failed to sync globals file ${fileName} to ${orgName}: ${syncErr.message}`)
      }
    }
  }
}

/**
 * Retrieve settings files from remote organization admin repositories,
 * commit them into a branch in the hub repository, and open a pull request.
 * @param {import('probot').Probot} robot
 * @param {Array<string>} orgNames Array of organization names to retrieve settings from
 * @param {Object} options Options for the operation
 * @param {string} options.baseBranch Base branch to create new branches from (default: 'main')
 * @returns {Promise<Array<Object>>} Results of the operation for each organization
 */
async function retrieveSettingsFromOrgs (robot, orgNames = [], options = {}) {
  attachFileLogger(robot)
  const results = []
  try {
    if (!Array.isArray(orgNames) || orgNames.length === 0) return results

    const installs = await getInstallations(robot)

    const hubOwnerLogin = (env.SAFE_SETTINGS_HUB_ORG || '').toLowerCase()
    const hubRepoName = env.SAFE_SETTINGS_HUB_REPO
    if (!hubOwnerLogin || !hubRepoName) {
      throw new Error('SAFE_SETTINGS_HUB_ORG and SAFE_SETTINGS_HUB_REPO must be configured')
    }

    const hubInstall = installs.find(i => i.account && i.account.login && i.account.login.toLowerCase() === hubOwnerLogin)
    if (!hubInstall) throw new Error(`Installation for hub org ${env.SAFE_SETTINGS_HUB_ORG} not found`)

    const githubHub = await robot.auth(hubInstall.id)
    const baseBranch = options.baseBranch || 'main'

    // Read REIMPORT mode from environment variable (default: false for safe mode)
    const allowReimport = (env.SAFE_SETTINGS_HUB_REIMPORT || 'false').toLowerCase() === 'true'
    robot.log.info(`Import mode: REIMPORT=${allowReimport}`)

    // Resolve the base sha for creating branches
    let baseRef, baseSha
    try {
      baseRef = await githubHub.rest.git.getRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `heads/${baseBranch}` })
      baseSha = baseRef.data && baseRef.data.object && baseRef.data.object.sha
    } catch (refErr) {
      if (refErr && refErr.status === 404) {
        // Hub repo doesn't exist - return N/A for all requested orgs
        robot.log.warn(`Hub repository ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName} or branch '${baseBranch}' not found`)
        return orgNames.map(org => ({ org, status: 'N/A', reason: `hub_repo_not_found: ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName}` }))
      }
      throw refErr
    }

    // Helper: collect all files under a path in a repo (recursively)
    async function collectFilesFromRepo (githubClient, owner, repo, dirPath, ref = 'main') {
      const out = []
      
      // First verify the repo exists by checking for the ref
      try {
        await githubClient.rest.git.getRef({ owner, repo, ref: `heads/${ref}` })
      } catch (repoCheckErr) {
        if (repoCheckErr && repoCheckErr.status === 404) {
          const err404 = new Error(`Repository ${owner}/${repo} or branch '${ref}' not found`)
          err404.status = 404
          throw err404
        }
        throw repoCheckErr
      }
      
      async function walk (p) {
        try {
          const resp = await githubClient.repos.getContent({ owner, repo, path: p, ref })
          const data = resp.data
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.type === 'file') {
                try {
                  const fileResp = await githubClient.repos.getContent({ owner, repo, path: item.path, ref })
                  if (!Array.isArray(fileResp.data) && typeof fileResp.data.content === 'string') {
                    const decoded = Buffer.from(fileResp.data.content, fileResp.data.encoding || 'base64').toString('utf8')
                    out.push({ path: fileResp.data.path, content: decoded })
                  }
                } catch (fe) {
                  // skip unreadable files, but log
                  robot.log && robot.log.warn && robot.log.warn(`collectFilesFromRepo: failed to fetch ${item.path} from ${owner}/${repo}: ${fe.message}`)
                }
              } else if (item.type === 'dir') {
                await walk(item.path)
              } else {
                // skip other types (submodules, symlinks)
                robot.log && robot.log.debug && robot.log.debug(`Skipping unsupported item type ${item.type} at ${item.path}`)
              }
            }
          } else if (typeof data.content === 'string') {
            const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8')
            out.push({ path: data.path, content: decoded })
          }
        } catch (e) {
          if (e && e.status === 404) {
            // path does not exist on repo -> no files
            return
          }
          throw e
        }
      }
      await walk(dirPath)
      return out
    }

    // Iterate requested orgs and import their CONFIG_PATH into the hub repo under the organizations/<org> tree
    for (const orgName of orgNames) {
      try {
        if (!orgName) { results.push({ org: orgName, error: 'invalid org name' }); continue }
        robot.log.info(`Retrieving settings from org: ${orgName}`)

        // Existence check: skip if org folder already exists (only when REIMPORT=false)
        let isReimport = false
        if (!allowReimport) {
          try {
            const destOrgPath = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${orgName}`
            try {
              const destCheck = await githubHub.rest.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, path: destOrgPath, ref: baseBranch })
              if (Array.isArray(destCheck.data) && destCheck.data.length > 0) {
                robot.log.info(`Skipping ${orgName}: already present in hub (REIMPORT=false)`)
                results.push({ org: orgName, status: 'skipped', reason: 'already_imported' })
                continue
              }
            } catch (probeErr) {
              if (!(probeErr && probeErr.status === 404)) {
                robot.log && robot.log.warn && robot.log.warn(`Failed to probe hub destination for ${orgName}: ${probeErr.message}`)
                results.push({ org: orgName, error: `failed to check destination: ${probeErr.message}` })
                continue
              }
              // 404 -> not present, proceed with import
            }
          } catch (e) {
            robot.log && robot.log.warn && robot.log.warn(`Unexpected error while probing destination for ${orgName}: ${e.message}`)
            results.push({ org: orgName, error: `probe error: ${e.message}` })
            continue
          }
        } else {
          // REIMPORT=true: Check if content exists to distinguish import vs reimport in results
          try {
            const destOrgPath = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${orgName}`
            const destCheck = await githubHub.rest.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, path: destOrgPath, ref: baseBranch })
            if (Array.isArray(destCheck.data) && destCheck.data.length > 0) {
              isReimport = true
              robot.log.info(`Re-importing ${orgName}: REIMPORT=true, will update existing files`)
            }
          } catch (probeErr) {
            // 404 or other error -> treat as first import
            if (probeErr && probeErr.status === 404) {
              robot.log.info(`First import for ${orgName}: destination not found`)
            }
          }
        }

        const srcInstall = installs.find(i => i.account && i.account.login && i.account.login.toLowerCase() === orgName.toLowerCase())
        if (!srcInstall) {
          results.push({ org: orgName, error: 'installation not found for org' })
          continue
        }

        const githubSrc = await robot.auth(srcInstall.id)
        const adminRepo = env.ADMIN_REPO
        if (!adminRepo) {
          results.push({ org: orgName, error: 'ADMIN_REPO is not configured' })
          continue
        }

        const sourceBase = (env.CONFIG_PATH || '.github').replace(/\/$/, '')
        // collect files from the source admin repo under CONFIG_PATH
        let files
        try {
          files = await collectFilesFromRepo(githubSrc, orgName, adminRepo, sourceBase, 'main')
        } catch (collectErr) {
          if (collectErr && collectErr.status === 404) {
            robot.log.info(`Skipping ${orgName}: admin repo '${adminRepo}' not found`)
            results.push({ org: orgName, status: 'N/A', reason: `admin_repo_not_found: ${adminRepo}` })
            continue
          }
          throw collectErr
        }

        if (!files || files.length === 0) {
          results.push({ org: orgName, status: 'N/A', reason: 'no_files_at_config_path' })
          continue
        }

        const timestamp = Date.now()
        const branchName = `safe-settings-import/${orgName}/${timestamp}`.replace(/[^a-zA-Z0-9_\-./]/g, '-')

        // Instead of creating/updating files one-by-one, build a single tree and commit so the PR contains all files atomically
        try {
          const treeEntries = []
          for (const f of files) {
            // relative path under the sourceBase
            const rel = path.posix.relative(sourceBase, f.path)
            // Destination should be: CONFIG_PATH/SAFE_SETTINGS_HUB_PATH/organizations/<orgName>/<relative>
            const destBase = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}`
            const destPath = path.posix.join(destBase, 'organizations', orgName, rel).replace(/\/+/g, '/')
            treeEntries.push({ path: destPath, mode: '100644', type: 'blob', content: f.content })
          }

          // Get base commit and tree
          const baseCommitResp = await githubHub.rest.git.getCommit({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, commit_sha: baseSha })
          const baseTreeSha = baseCommitResp.data && baseCommitResp.data.tree && baseCommitResp.data.tree.sha

          // Create a new tree rooted at the base tree
          const createdTree = await githubHub.rest.git.createTree({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, tree: treeEntries, base_tree: baseTreeSha })

          if (createdTree.data.sha === baseTreeSha) {
            robot.log.info(`Skipping ${orgName}: imported settings match the hub base branch`)
            results.push({ org: orgName, status: 'skipped', reason: 'no_changes' })
            continue
          }

          // Create the branch only after confirming that the imported tree differs from the base tree
          try {
            await githubHub.rest.git.createRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `refs/heads/${branchName}`, sha: baseSha })
          } catch (createErr) {
            if (createErr && createErr.status === 422) {
              robot.log.info(`Branch ${branchName} already exists, continuing`)
            } else {
              throw createErr
            }
          }

          // Create a commit that points to the new tree
          const commitMessage = `Import safe-settings from ${orgName}`
          const newCommit = await githubHub.rest.git.createCommit({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, message: commitMessage, tree: createdTree.data.sha, parents: [baseSha] })

          // Update the branch ref to point to the new commit
          await githubHub.rest.git.updateRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `heads/${branchName}`, sha: newCommit.data.sha })

          robot.log.info(`Created commit ${newCommit.data.sha} on ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName}@${branchName} with ${treeEntries.length} files (mode: ${isReimport ? 'reimport' : 'initial'})`)
        } catch (commitErr) {
          robot.log.error(`Failed to create commit tree for ${orgName}: ${commitErr && commitErr.message ? commitErr.message : commitErr}`)
          results.push({ org: orgName, error: `failed to commit files: ${commitErr && commitErr.message ? commitErr.message : String(commitErr)}` })
          continue
        }

        // Create a PR in the hub repo for this branch
        try {
          const prTitle = isReimport ? `Re-import safe-settings from ${orgName}` : `Import safe-settings from ${orgName}`
          const prBody = isReimport
            ? `Automated re-import of settings from ${orgName} admin repo (${adminRepo}) into the hub.\n\n**Mode:** REIMPORT=true (reimport enabled)\n**Previous import detected:** Files will be updated with current org configuration.`
            : `Automated import of settings from ${orgName} admin repo (${adminRepo}) into the hub.`
          const created = await githubHub.rest.pulls.create({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, title: prTitle, head: branchName, base: baseBranch, body: prBody })
          results.push({ org: orgName, status: isReimport ? 'reimported' : 'imported', pr: created.data && created.data.html_url })
          robot.log.info(`Created PR ${created.data && created.data.html_url} for ${orgName}`)
        } catch (prErr) {
          robot.log.error(`Failed to create PR for ${orgName}: ${prErr && prErr.message ? prErr.message : prErr}`)
          results.push({ org: orgName, error: `failed to create PR: ${prErr && prErr.message ? prErr.message : String(prErr)}` })
        }
      } catch (errInner) {
        robot.log.error(`Error importing settings for org ${orgName}: ${errInner && errInner.message ? errInner.message : errInner}`)
        results.push({ org: orgName, error: errInner && errInner.message ? errInner.message : String(errInner) })
      }
    }

    return results
  } catch (err) {
    robot.log.error(`retrieveSettingsFromOrgs error: ${err && err.message ? err.message : err}`)
    throw err
  }
}

// Properties used to identify matching items in arrays
const NAME_FIELDS = ['name', 'username', 'actor_id', 'login', 'type', 'key_prefix', 'context']

/**
 * Load and merge global settings with org-specific settings (in-memory only).
 * Returns merged YAML string ready to be pushed to target repo.
 * Source files in the hub repo are NEVER modified.
 * 
 * @param {import('probot').Probot} robot - Robot instance for logging
 * @param {import('@octokit/rest').Octokit} githubHub - Authenticated GitHub client for hub repo
 * @param {string} orgName - Organization name
 * @param {string} prHeadSha - PR head SHA to read files from
 * @returns {Promise<string|null>} Merged YAML content or null if both files missing
 */
async function loadAndMergeSettings (robot, githubHub, orgName, prHeadSha) {
  const configRoot = env.CONFIG_PATH || '.github'
  const globalsPath = `${configRoot}/${env.SAFE_SETTINGS_HUB_PATH}/globals/settings.yml`
  const orgPath = `${configRoot}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${orgName}/settings.yml`
  
  let globalsContent = ''
  let orgContent = ''
  
  // Load globals/settings.yml (if exists)
  try {
    const globalsResp = await githubHub.rest.repos.getContent({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: env.SAFE_SETTINGS_HUB_REPO,
      path: globalsPath,
      ref: prHeadSha
    })
    if (!Array.isArray(globalsResp.data)) {
      globalsContent = Buffer.from(globalsResp.data.content, globalsResp.data.encoding).toString('utf8')
      robot.log.debug(`Loaded globals/settings.yml for merge (${globalsContent.length} bytes)`)
    }
  } catch (err) {
    if (err.status === 404) {
      robot.log.debug(`globals/settings.yml not found (this is OK)`)
    } else {
      robot.log.warn(`Error loading globals/settings.yml: ${err.message}`)
    }
  }
  
  // Load organizations/<org>/settings.yml (if exists)
  try {
    const orgResp = await githubHub.rest.repos.getContent({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: env.SAFE_SETTINGS_HUB_REPO,
      path: orgPath,
      ref: prHeadSha
    })
    if (!Array.isArray(orgResp.data)) {
      orgContent = Buffer.from(orgResp.data.content, orgResp.data.encoding).toString('utf8')
      robot.log.debug(`Loaded organizations/${orgName}/settings.yml for merge (${orgContent.length} bytes)`)
    }
  } catch (err) {
    if (err.status === 404) {
      robot.log.debug(`organizations/${orgName}/settings.yml not found (this is OK)`)
    } else {
      robot.log.warn(`Error loading organizations/${orgName}/settings.yml: ${err.message}`)
    }
  }
  
  // If both are empty, return null
  if (!globalsContent && !orgContent) {
    robot.log.info(`No settings.yml found in globals or organizations/${orgName}`)
    return null
  }
  
  // If only one exists, return it with header
  if (!globalsContent) {
    robot.log.info(`Using pure org settings (no globals found)`)
    const header = `# Auto-generated by Safe-Settings Hub-Sync
# Source: organizations/${orgName}/settings.yml only
# DO NOT EDIT THIS FILE DIRECTLY - Edit source files in ${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}

`
    return header + orgContent
  }
  if (!orgContent) {
    robot.log.info(`Using pure globals (no org-specific settings found)`)
    const header = `# Auto-generated by Safe-Settings Hub-Sync
# Source: globals/settings.yml only
# DO NOT EDIT THIS FILE DIRECTLY - Edit source files in ${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}

`
    return header + globalsContent
  }
  
  // Both exist - merge them (org takes precedence)
  robot.log.info(`Merging globals with organizations/${orgName}/settings.yml (org takes precedence)`)
  try {
    const merged = mergeConfigs(globalsContent, orgContent, false) // false = smart merge, org overrides globals
    const mergedYaml = yaml.dump(merged, { lineWidth: -1 })
    
    // Add header comment indicating auto-generation
    const header = `# Auto-generated by Safe-Settings Hub-Sync
# Merged from globals/settings.yml + organizations/${orgName}/settings.yml
# Organization settings take precedence over globals
# DO NOT EDIT THIS FILE DIRECTLY - Edit source files in ${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}

`
    
    return header + mergedYaml
  } catch (mergeErr) {
    robot.log.error(`Failed to merge settings: ${mergeErr.message}`)
    robot.log.error(`Error stack: ${mergeErr.stack}`)
    
    // Fallback to org-only if merge fails (only during sync, not validation)
    robot.log.warn(`Falling back to org-specific settings only`)
    const header = `# Auto-generated by Safe-Settings Hub-Sync (merge failed, using org only)
# DO NOT EDIT THIS FILE DIRECTLY - Edit source files in ${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}

`
    return header + orgContent
  }
}

/**
 * Merge two JSON/YAML configuration strings at the object level.
 * 
 * @param {string} json1 - First JSON/YAML content string (base)
 * @param {string} json2 - Second JSON/YAML content string (overlay - takes precedence)
 * @param {boolean} replaceArrays - If true (default), arrays in json2 replace arrays in json1.
 *                                   If false, arrays are merged intelligently:
 *                                   - Simple arrays: deduplicated (no duplicates added)
 *                                   - Object arrays: matched by name/username/etc and merged
 * @returns {Object} Merged configuration object
 * 
 * @example
 * const json1 = `
 * teams:
 *   - team-a
 *   - team-b
 * `
 * const json2 = `
 * teams:
 *   - team-b
 *   - team-c
 * `
 * 
 * // Replace mode (default): result = { teams: ['team-b', 'team-c'] }
 * const replaced = mergeConfigs(json1, json2)
 * // or explicitly: mergeConfigs(json1, json2, true)
 * 
 * // Smart merge mode: result = { teams: ['team-a', 'team-b', 'team-c'] }
 * const smartMerge = mergeConfigs(json1, json2, false)
 * mergeConfigs
 * @example
 * // Smart merge with objects
 * const json1 = `
 * collaborators:
 *   - username: alice
 *     permission: push
 * `
 * const json2 = `
 * collaborators:
 *   - username: alice
 *     permission: admin
 *   - username: bob
 *     permission: pull
 * `
 * // Result: alice updated to admin, bob added
 */
function mergeConfigs (json1, json2, replaceArrays = true) {
  // Parse input strings as YAML (which also handles JSON)
  const obj1 = yaml.load(json1) || {}
  const obj2 = yaml.load(json2) || {}

  // Perform the merge
  return deepMerge(obj1, obj2, replaceArrays)
}

/**
 * Deep merge two objects with configurable array handling
 * 
 * @param {*} target - Base object
 * @param {*} source - Overlay object (takes precedence)
 * @param {boolean} replaceArrays - Array merge strategy
 * @returns {*} Merged result
 */
function deepMerge (target, source, replaceArrays) {
  // Handle null/undefined
  if (source === null || source === undefined) {
    return target
  }
  if (target === null || target === undefined) {
    return source
  }

  // If source is not an object, it replaces target
  if (typeof source !== 'object' || source === null) {
    return source
  }

  // Handle arrays
  if (Array.isArray(source)) {
    if (Array.isArray(target)) {
      if (replaceArrays) {
        // Replace: return only source array
        return [...source]
      } else {
        // Smart merge: deduplicate primitives or merge objects by matching properties
        return smartMergeArrays(target, source)
      }
    }
    // Target is not an array, replace with source array
    return [...source]
  }

  // Handle objects (not arrays)
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    // Target is not a plain object, replace with source
    target = {}
  }

  const result = { ...target }

  // Merge source properties into result
  for (const key in source) {
    // Skip prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }

    const sourceValue = source[key]
    const targetValue = result[key]

    // Recursively merge if both are objects or arrays
    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      targetValue !== null &&
      typeof targetValue === 'object'
    ) {
      result[key] = deepMerge(targetValue, sourceValue, replaceArrays)
    } else {
      // For primitives, source overwrites target
      result[key] = sourceValue
    }
  }

  return result
}

/**
 * Smart merge two arrays: deduplicates primitives, or matches objects by name/username/etc and deep-merges them.
 * 
 * **Primitive arrays**: ['a', 'b'] + ['b', 'c'] → ['a', 'b', 'c']
 * 
 * **Object arrays** (via mergeBy):
 * - Matches by NAME_FIELDS (name, username, actor_id, login, type, key_prefix, context)
 * - Deep-merges matching objects (source properties override target, nested props preserved)
 * - Appends non-matching source objects
 * - Preserves target-only objects
 * 
 * Example (labels):
 * ```
 * target: [{ name: 'bug', color: 'red' }, { name: 'feature', color: 'blue' }]
 * source: [{ name: 'bug', color: 'green' }, { name: 'docs', color: 'yellow' }]
 * result: [{ name: 'bug', color: 'green' },    // updated
 *          { name: 'feature', color: 'blue' }, // preserved
 *          { name: 'docs', color: 'yellow' }]  // added
 * ```
 * 
 * @param {Array} target - Base array (primitives or objects)
 * @param {Array} source - Overlay array (primitives or objects)
 * @returns {Array} Merged array
 */
function smartMergeArrays (target, source) {
  // Check if arrays contain objects or primitives
  const hasObjects = source.some(item => item && typeof item === 'object' && !Array.isArray(item))
  
  if (!hasObjects) {
    // Primitives: deduplicate
    const result = [...target]
    source.forEach(item => {
      if (!result.includes(item)) {
        result.push(item)
      }
    })
    return result
  }
  
  // Objects: match by NAME_FIELDS and deep-merge
  // mergeBy(key, configvalidator, overridevalidator, properties, target, source, options, githubContext)
  return mergeBy(null, null, null, NAME_FIELDS, target, source, undefined, undefined)
}

/**
 * Validates hub-sync master files and reports results via PR comments and check runs.
 * This is the hub-sync equivalent of Settings.handleResults() - it validates YAML syntax,
 * tests merges, and creates formatted PR comments.
 *
 * @param {import('probot').Probot} robot - Probot robot instance
 * @param {import('probot').Context} context - GitHub context
 * @param {object} payload - Webhook payload
 * @param {object} pullRequest - Pull request object
 * @param {string[]} changedFiles - Hub-sync files that changed
 * @param {string} baseRef - Base branch ref
 */
async function validateAndReportHubSync (robot, context, payload, pullRequest, changedFiles, baseRef) {
  robot.log.info(`Hub-sync validation: Processing ${changedFiles.length} file(s)`)
  
  const syntaxErrors = []
  const syntaxSuccesses = []
  const mergeErrors = []
  const mergeSuccesses = []
  const warnings = []
  
  const hubPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}`.replace(/\/+/g, '/')
  const settingsPattern = new RegExp(`^${hubPath}/(globals|organizations/[^/]+)/settings\\.ya?ml$`)
  const orgsPattern = new RegExp(`^${hubPath}/organizations/([^/]+)/settings\\.ya?ml$`)
  
  const orgsWithSettingsChanges = new Set()
  let globalsSettingsChanged = false
  
  // Load manifest for filtering
  const manifest = await loadManifest(context.octokit, pullRequest.head.sha, robot.log)
  
  // Phase 1: YAML Syntax Validation - check all changed files
  for (const filePath of changedFiles) {
    robot.log.debug(`Validating YAML syntax: ${filePath}`)
    
    // Track if this is a settings.yml file (do this BEFORE validation so we track even if validation fails)
    if (settingsPattern.test(filePath)) {
      if (filePath.includes('/globals/settings.')) {
        globalsSettingsChanged = true
      }
      const orgMatch = filePath.match(orgsPattern)
      if (orgMatch && orgMatch[1]) {
        orgsWithSettingsChanges.add(orgMatch[1])
      }
    }
    
    try {
      const fileContent = await context.octokit.repos.getContent({
        owner: context.repo().owner,
        repo: context.repo().repo,
        path: filePath,
        ref: pullRequest.head.sha
      })
      
      if (Array.isArray(fileContent.data)) {
        syntaxErrors.push(`\`${filePath}\`: Expected a file but got a directory`)
        continue
      }
      
      if (!fileContent.data.content) {
        syntaxErrors.push(`\`${filePath}\`: No content found`)
        continue
      }
      
      const decoded = Buffer.from(fileContent.data.content, 'base64').toString()
      yaml.load(decoded) // Will throw on invalid YAML
      syntaxSuccesses.push(`\`${filePath}\``)
    } catch (e) {
      syntaxErrors.push(`\`${filePath}\`: ${e.message}`)
    }
  }
  
  // Filter organizations by manifest rules
  const allAffectedOrgs = Array.from(orgsWithSettingsChanges)
  const filteredOrgs = filterOrgsByManifest(allAffectedOrgs, manifest, robot.log)
  const excludedOrgs = allAffectedOrgs.filter(org => !filteredOrgs.includes(org))
  
  // Filter files by manifest rules
  const changedFilesList = changedFiles.map(f => {
    const fileName = f.split('/').pop()
    const willSync = matchesFilesToSync(fileName, manifest, robot.log)
    return { path: f, fileName, willSync }
  })
  const excludedFiles = changedFilesList.filter(f => !f.willSync)
  
  // Phase 2: Merged Configuration Validation - only for orgs with settings.yml changes
  if (orgsWithSettingsChanges.size > 0) {
    for (const orgName of orgsWithSettingsChanges) {
      robot.log.debug(`Testing merge for organization: ${orgName}`)
      try {
        const mergedYaml = await loadAndMergeSettings(
          robot,
          context.octokit,
          orgName,
          pullRequest.head.sha
        )
        
        if (!mergedYaml) {
          mergeErrors.push(`Organization \`${orgName}\` (settings.yml): Merge failed - no configuration found`)
          continue
        }
        
        // Parse and validate the merged YAML syntax
        yaml.load(mergedYaml)
        mergeSuccesses.push(`Organization \`${orgName}\` (settings.yml)`)
      } catch (e) {
        mergeErrors.push(`Organization \`${orgName}\` (settings.yml): ${e.message}`)
      }
    }
  }
  
  // Build PR comment with clear sections
  const totalSyntaxChecks = syntaxErrors.length + syntaxSuccesses.length
  const totalMergeChecks = mergeErrors.length + mergeSuccesses.length
  const hasErrors = syntaxErrors.length > 0 || mergeErrors.length > 0
  const conclusion = hasErrors ? 'failure' : 'success'
  const title = hasErrors
    ? 'Hub-Sync Master File Validation Failed'
    : 'Hub-Sync Master Files Validated Successfully'
  
  let commentBody = `#### :robot: Hub-Sync Master File Validation\n\n`
  commentBody += `**Files changed:** ${changedFiles.length}\n`
  
  // Show manifest filtering information
  if (manifest) {
    commentBody += `**Manifest rules:** ${manifest.rules.length} active rule(s)\n`
  } else {
    commentBody += `**Manifest rules:** No manifest found (all orgs/files will be synced)\n`
  }
  
  if (orgsWithSettingsChanges.size > 0) {
    commentBody += `**Organizations with changes:** ${allAffectedOrgs.join(', ')}\n`
    
    if (manifest) {
      if (filteredOrgs.length > 0) {
        commentBody += `**✅ Organizations that will receive updates:** ${filteredOrgs.join(', ')}\n`
      }
      if (excludedOrgs.length > 0) {
        commentBody += `**⛔ Organizations excluded by manifest:** ${excludedOrgs.join(', ')}\n`
        warnings.push(`${excludedOrgs.length} organization(s) excluded by manifest rules: ${excludedOrgs.join(', ')}`)
      }
    }
  }
  
  if (excludedFiles.length > 0 && manifest) {
    commentBody += `**⛔ Files excluded by manifest:** ${excludedFiles.map(f => f.fileName).join(', ')}\n`
    warnings.push(`${excludedFiles.length} file(s) excluded by manifest rules: ${excludedFiles.map(f => f.fileName).join(', ')}`)
  }
  
  commentBody += `\n`
  
  // Section 1: YAML Syntax Validation
  if (syntaxErrors.length > 0) {
    commentBody += `#### ❌ YAML Syntax Validation Failed (${syntaxSuccesses.length}/${totalSyntaxChecks})\n\n`
    commentBody += syntaxErrors.map(e => `- ${e}`).join('\n') + '\n\n'
    if (syntaxSuccesses.length > 0) {
      commentBody += `**Passed:**\n`
      commentBody += syntaxSuccesses.map(s => `- ${s} ✓`).join('\n') + '\n\n'
    }
  } else {
    commentBody += `#### ✅ YAML Syntax Validation Passed (${syntaxSuccesses.length}/${totalSyntaxChecks})\n\n`
    commentBody += syntaxSuccesses.map(s => `- ${s} ✓`).join('\n') + '\n\n'
  }
  
  // Section 2: Merged Configuration Validation (only if settings.yml files changed)
  if (totalMergeChecks > 0) {
    if (mergeErrors.length > 0) {
      commentBody += `#### ❌ Merged Configuration Validation Failed (${mergeSuccesses.length}/${totalMergeChecks})\n\n`
      commentBody += mergeErrors.map(e => `- ${e}`).join('\n') + '\n\n'
      if (mergeSuccesses.length > 0) {
        commentBody += `**Passed:**\n`
        commentBody += mergeSuccesses.map(s => `- ${s} ✓`).join('\n') + '\n\n'
      }
    } else {
      commentBody += `#### ✅ Merged Configuration Validation Passed (${mergeSuccesses.length}/${totalMergeChecks})\n\n`
      commentBody += mergeSuccesses.map(s => `- ${s} ✓`).join('\n') + '\n\n'
    }
  }
  
  // Warnings section (if any)
  if (warnings.length > 0) {
    commentBody += `#### ⚠️ Warnings (${warnings.length})\n\n`
    commentBody += warnings.map(w => `- ${w}`).join('\n') + '\n\n'
  }
  
  // Create PR comment
  try {
    await context.octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: pullRequest.number,
      body: commentBody
    })
  } catch (e) {
    robot.log.error(`Failed to create PR comment: ${e.message}`)
  }
  
  // Update check run
  const params = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    check_run_id: payload.check_run.id,
    status: 'completed',
    completed_at: new Date().toISOString(),
    conclusion,
    output: {
      title,
      summary: commentBody
    }
  }
  
  robot.log.info(`Hub-sync validation complete: ${conclusion} (syntax: ${syntaxErrors.length} errors, merge: ${mergeErrors.length} errors)`)
  return context.octokit.checks.update(params)
}

// Export all internal functions for testability
module.exports = {
  hubSyncHandler,
  retrieveSettingsFromOrgs,
  syncHubOrgUpdate,
  syncHubGlobalsUpdate,
  getOrgInstallation,
  mergeConfigs,
  loadAndMergeSettings,
  validateAndReportHubSync,
  // Manifest-based filtering functions
  loadManifest,
  normalizeManifestRules,
  matchesOrgTargets,
  matchesFilesToSync,
  shouldSyncOrgUpdate,
  filterOrgsByManifest
}
