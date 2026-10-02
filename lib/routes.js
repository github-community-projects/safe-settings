/**
 * Router setup for Safe Settings UI & API endpoints
 * Centralizes Express/Next asset & API wiring away from core app logic.
 *
 * Exports:
 *   setupRoutes(robot, getRouter) -> configured router
 *
 * Responsibilities:
 *   - Serve static exported Next.js UI (from ui/out)
 *   - Dashboard HTML entry points
 *   - JSON API endpoints
 *
 * This version removes dependency on robot-level cached installation getters
 * (`robot.getCachedInstallations`, `robot.getOrganizationLogins`) and instead
 * fetches installations live per request. If performance becomes an issue,
 * a lightweight in-module memoization layer with short TTL can be reintroduced.
 */

const path = require('path')
const util = require('util')
const fs = require('fs')
const express = require('express')
const env = require('./env')
const { getInstallations: cacheGetInstallations, getOrgLogins, getLastFetchedAt } = require('./installationCache')

// Lightweight commit metadata cache (path+ref -> meta) with TTL to avoid
// repeated GitHub commit lookups across requests.
const COMMIT_META_TTL_MS = parseInt(process.env.COMMIT_META_TTL_MS || '300000') // 5m default
const _commitMetaCache = new Map() // key => { meta, expiresAt }
function getCachedCommitMeta (key) {
  const entry = _commitMetaCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { _commitMetaCache.delete(key); return null }
  return entry.meta
}
function setCachedCommitMeta (key, meta) {
  _commitMetaCache.set(key, { meta, expiresAt: Date.now() + COMMIT_META_TTL_MS })
}

function setupRoutes (robot, getRouter) {
  // Support for URL prefix (e.g., /safe-settings) when behind a proxy
  const basePath = env.SAFE_SETTINGS_HUB_URL_PREFIX || ''
  const mountPath = basePath || '/'
  
  // Root-level mount
  const router = getRouter(mountPath)

  // Ensure JSON/urlencoded body parsing is enabled for API endpoints
  router.use(express.json({ limit: '1mb' }))
  router.use(express.urlencoded({ extended: true }))

  // Static assets: produced by Next export/build step (ui/out)
  const rootDir = path.join(__dirname, '..') // lib -> project root
  const uiPath = path.join(rootDir, 'ui', 'out')
  router.use(express.static(uiPath))

  // HTML entrypoints (exported files). Adjust if you move/rename pages.
  // Redirect root route to /dashboard
  router.get('/', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard.html'))
  })

  router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard.html'))
  })

  router.get('/dashboard/organizations', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'organizations.html'))
  })

  router.get('/dashboard/settings', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'settings.html'))
  })

  router.get('/dashboard/safe-settings-hub', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'safe-settings-hub.html'))
  })

  router.get('/dashboard/env', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'env.html'))
  })

  router.get('/dashboard/help', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'help.html'))
  })

  router.get('/dashboard/logs', (req, res) => {
    res.sendFile(path.join(uiPath, 'dashboard', 'logs.html'))
  })

  // Apple touch icon (silence 404s). Replace file logic if you add a real 180x180 asset.
  const APPLE_TOUCH_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAQAAAA9zQYyAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==' // 180x180 transparent PNG
  router.get('/apple-touch-icon.png', (req, res) => {
    // If a real file exists at project root, serve it; otherwise fallback to embedded transparent PNG.
    const filePath = path.join(rootDir, 'apple-touch-icon.png')
    fs.access(filePath, fs.constants.R_OK, (err) => {
      if (!err) {
        return res.sendFile(filePath)
      }
      const buf = Buffer.from(APPLE_TOUCH_ICON_BASE64, 'base64')
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
      res.send(buf)
    })
  })

  /**
  * GET /api/safe-settings/installation
   * Returns live organization installation metadata + optional last commit info.
   * Query param: disableActivity=true to skip commit lookups (faster).
   */
  router.get('/api/safe-settings/installation', async (req, res) => {
    const disableActivity = req.query.disableActivity === 'true'
    const includeActivity = !disableActivity

    const crypto = require('crypto')
    function hashContent (str) {
      return crypto.createHash('sha256').update(str || '').digest('hex')
    }

    try {
      const installs = await cacheGetInstallations(robot)
      const orgLogins = getOrgLogins()
      const orgInstalls = installs.filter(i => i.account && i.account.type === 'Organization')
      const lastCommits = {}
      const syncStatus = {}
      let installationDtos

      if (includeActivity && env.ADMIN_REPO) {
        const orgs = orgLogins
        const limit = 1 // reduce concurrency for API rate safety
        const queue = [...orgs]
        robot.log.info(`Starting commit and sync status fetch for ${queue} organizations...`)

        const runners = []
        const runNext = async () => {
          while (queue.length) {
            const org = queue.shift()
            try {
              const install = installs.find(i => i.account && i.account.login && i.account.login.toLowerCase() === org.toLowerCase())
              if (!install) {
                lastCommits[org] = { na: true, hasConfigRepo: false }
                syncStatus[org] = false
                continue
              }
              const githubOrg = await robot.auth(install.id)
              let hasConfigRepo = false
              try {
                await githubOrg.repos.get({ owner: org, repo: env.ADMIN_REPO })
                hasConfigRepo = true
              } catch (repoErr) {
                if (repoErr.status === 404) {
                  hasConfigRepo = false
                } else {
                  robot.log.warn(`Repo existence check error for ${org}/${env.ADMIN_REPO}: ${repoErr.message}`)
                }
              }
              // --- SYNC CHECK ---
              let isInSync = false
              if (hasConfigRepo) {
                try {
                  const hubOrgDir = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${org}`
                  const hubRef = 'main'
                  robot.log.debug(`1. [SYNC DEBUG] Hub file path for org ${org}: ${hubOrgDir}`)
                  robot.log.debug(`2. [SYNC DEBUG] Hub file branch/ref for org ${org}: ${hubRef}`)
                  let orgFilesResp, hubFilesResp
                  try {
                    robot.log.debug(`3. [SYNC DEBUG] Org: ${org}`)
                    orgFilesResp = await githubOrg.repos.getContent({ owner: org, repo: env.ADMIN_REPO, path: env.CONFIG_PATH })
                    const orgNames = Array.isArray(orgFilesResp.data)
                      ? orgFilesResp.data.map(f => f.name).join(', ')
                      : (orgFilesResp.data && orgFilesResp.data.name ? orgFilesResp.data.name : '')
                    robot.log.debug(`4. [SYNC DEBUG] Org orgFilesResp file names: ${orgNames}`)
                  } catch (fetchErr) {
                    robot.log.error(`4a. [SYNC DEBUG] Error fetching org files: ${fetchErr.message}`)
                    orgFilesResp = { data: [] }
                  }

                  try {
                    robot.log.debug(`5. [SYNC DEBUG] Hub: ${env.SAFE_SETTINGS_HUB_ORG}`)
                    robot.log.debug(`5a. [SYNC DEBUG] Fetching hub files for: \n owner: ${env.SAFE_SETTINGS_HUB_ORG}, \n repo: ${env.SAFE_SETTINGS_HUB_REPO}, \n path: ${hubOrgDir}, \n ref: ${hubRef}`)
                    hubFilesResp = await githubOrg.repos.getContent({
                      owner: env.SAFE_SETTINGS_HUB_ORG,
                      repo: env.SAFE_SETTINGS_HUB_REPO,
                      path: hubOrgDir,
                      ref: hubRef
                    })
                    const hubNames = Array.isArray(hubFilesResp.data)
                      ? hubFilesResp.data.map(f => f.name).join(', ')
                      : (hubFilesResp.data && hubFilesResp.data.name ? hubFilesResp.data.name : '')
                    robot.log.debug(`6. [SYNC DEBUG] Hub hubFilesResp file names: ${hubNames}`)
                  } catch (fetchErr) {
                    if (fetchErr.status === 404) {
                      robot.log.debug(`6a. [SYNC DEBUG] Hub folder not found for org ${org} (expected if not yet imported): ${hubOrgDir}`)
                    } else {
                      robot.log.error(`6a. [SYNC DEBUG] Error fetching hub files: ${fetchErr}`)
                    }
                    hubFilesResp = { data: [] }
                  }

                  const orgFiles = Array.isArray(orgFilesResp.data) ? orgFilesResp.data.filter(f => f.type === 'file') : []
                  const hubFiles = Array.isArray(hubFilesResp.data) ? hubFilesResp.data.filter(f => f.type === 'file') : []

                  // Hub is source of truth - check if all hub files exist in org with matching content
                  if (hubFiles.length === 0) {
                    robot.log.debug(`6b. [SYNC DEBUG] Org ${org} not in sync - no hub content (not yet imported)`)
                    isInSync = false
                  } else {
                    // For each hub file, find corresponding org file and compare content
                    let allMatch = true
                    for (const hubFile of hubFiles) {
                      const hubFileName = hubFile.name
                      const orgFile = orgFiles.find(f => f.name === hubFileName)
                      
                      if (!orgFile) {
                        robot.log.debug(`6c. [SYNC DEBUG] Org ${org} not in sync - missing file ${hubFileName} in org`)
                        allMatch = false
                        break
                      }

                      // Compare file contents
                      robot.log.debug(`7. [SYNC DEBUG] Comparing file: ${hubFileName} for org ${org}`)
                      let orgContentResp, hubContentResp
                      try {
                        orgContentResp = await githubOrg.repos.getContent({ owner: org, repo: env.ADMIN_REPO, path: orgFile.path })
                      } catch (fetchErr) {
                        robot.log.error(`7a. [SYNC DEBUG] Error fetching org file ${orgFile.path}: ${fetchErr.message}`)
                        allMatch = false
                        break
                      }
                      try {
                        hubContentResp = await githubOrg.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: env.SAFE_SETTINGS_HUB_REPO, path: hubFile.path })
                      } catch (fetchErr) {
                        robot.log.error(`7b. [SYNC DEBUG] Error fetching hub file ${hubFile.path}: ${fetchErr.message}`)
                        allMatch = false
                        break
                      }
                      const orgContent = orgContentResp.data.content ? Buffer.from(orgContentResp.data.content, orgContentResp.data.encoding || 'base64').toString('utf8') : ''
                      const hubContent = hubContentResp.data.content ? Buffer.from(hubContentResp.data.content, hubContentResp.data.encoding || 'base64').toString('utf8') : ''
                      const orgHash = hashContent(orgContent)
                      const hubHash = hashContent(hubContent)
                      robot.log.debug(`8. [SYNC DEBUG] File: ${hubFileName}`)
                      robot.log.debug(`9. [SYNC DEBUG] Org hash: ${orgHash}`)
                      robot.log.debug(`10. [SYNC DEBUG] Hub hash: ${hubHash}`)
                      if (orgHash !== hubHash) {
                        robot.log.debug(`11. [SYNC DEBUG] Hash mismatch for file ${hubFileName} in org ${org}`)
                        allMatch = false
                        break
                      }
                    }
                    isInSync = allMatch
                  }
                } catch (syncErr) {
                  robot.log.error(`[SYNC DEBUG] Sync check error for org ${org}: ${syncErr.message}`)
                  isInSync = false
                }
              }
              syncStatus[org] = isInSync
              // --- END SYNC CHECK ---
              // Commit info (unchanged)
              let commits
              try {
                const pathPrefix = `${env.CONFIG_PATH.replace(/\/$/, '')}/organizations/${org}`
                commits = await githubOrg.repos.listCommits({ owner: org, repo: env.ADMIN_REPO, per_page: 1, path: pathPrefix })
              } catch (err) {
                if (err.status === 404) {
                  lastCommits[org] = { na: true, hasConfigRepo }
                  continue
                }
                if (err.status === 409) { // empty repo
                  lastCommits[org] = { hasConfigRepo }
                  continue
                }
                robot.log.warn(`Commit lookup error for ${org}/${env.ADMIN_REPO}: ${err.message}`)
                lastCommits[org] = { hasConfigRepo }
                continue
              }
              if (Array.isArray(commits.data) && commits.data.length) {
                const c = commits.data[0]
                const committedAt = (c.commit && c.commit.author && c.commit.author.date) || null
                const ageSeconds = committedAt ? Math.floor((Date.now() - new Date(committedAt).getTime()) / 1000) : null
                lastCommits[org] = { sha: c.sha, committed_at: committedAt, message: c.commit && c.commit.message ? c.commit.message.split('\n')[0] : null, age_seconds: ageSeconds, hasConfigRepo }
              } else {
                lastCommits[org] = { hasConfigRepo }
              }
            } catch (loopErr) {
              robot.log.warn(`Unexpected error gathering commit for org ${org}: ${loopErr.message}`)
              lastCommits[org] = { hasConfigRepo: false }
              syncStatus[org] = false
            }
          }
        }
        for (let i = 0; i < limit; i++) runners.push(runNext())
        await Promise.all(runners)
      }

      // Now that lastCommits and syncStatus are populated, build installationDtos
      installationDtos = orgInstalls.map(i => {
        const orgKey = i.account.login
        const commitInfo = lastCommits[orgKey] || {}
        return {
          id: i.id,
          account: orgKey,
          type: i.account.type,
          created_at: i.created_at,
          name: orgKey,
          sha: commitInfo.sha,
          committed_at: commitInfo.committed_at,
          message: commitInfo.message,
          age_seconds: commitInfo.age_seconds,
          hasConfigRepo: typeof commitInfo.hasConfigRepo === 'boolean' ? commitInfo.hasConfigRepo : false,
          isInSync: typeof syncStatus[orgKey] === 'boolean' ? syncStatus[orgKey] : false
        }
      })
      return res.json({ updatedAt: new Date().toISOString(), installations: installationDtos })
    } catch (e) {
      robot.log && robot.log.error && robot.log.error(e)
      res.status(500).json({ error: e.message || 'unexpected error' })
    }
  })

  /**
   * GET /api/safe-settings/hub/contents/*
   * Fetches a file or directory listing from the SAFE_SETTINGS_HUB_ORG / SAFE_SETTINGS_HUB_REPO
   * under the configured CONFIG_PATH (default .github).
   *
   * Examples:
  *   /api/safe-settings/hub/contents/                -> list CONFIG_PATH root
  *   /api/safe-settings/hub/contents/repos/foo.yml   -> get specific file
  *   /api/safe-settings/hub/contents/repos?ref=main  -> list directory at ref
  *   /api/safe-settings/hub/contents?recursive=true&maxDepth=2&fetchContent=false -> recursive listing without file bodies
  * Note: recursive now defaults to true. Pass recursive=false for single-level listing.
   */
  async function hubContent (req, res) {
    let fullPath, ref
    try {
      // Use cached installations (TTL-based freshness)
      const installs = await cacheGetInstallations(robot)
      const install = installs.find(i => i.account && i.account.type === 'Organization' && i.account.login && i.account.login.toLowerCase() === env.SAFE_SETTINGS_HUB_ORG.toLowerCase())
      if (!install) {
        return res.status(404).json({ error: `Installation for org ${env.SAFE_SETTINGS_HUB_ORG} not found` })
      }

      const github = await robot.auth(install.id)
      const wildcardPath = req.params[0] || '' // from the * in the route
      ref = req.query.ref || 'main'
      fullPath = wildcardPath ? path.posix.join(env.CONFIG_PATH, wildcardPath) : env.CONFIG_PATH
      // recursive defaults to true unless explicitly disabled with recursive=false
      const recursive = req.query.recursive !== 'false'
      let maxDepth = parseInt(req.query.maxDepth, 5)
      if (isNaN(maxDepth) || maxDepth < 1) maxDepth = 5 // safety default
      if (maxDepth > 8) maxDepth = 5 // hard cap to avoid abuse
      // Unified flag: fetchContent (default true). No other legacy params supported.
      const fetchContent = req.query.fetchContent !== 'false'

      // Commit metadata fetch with global shared cache + per-request memoization
      const perRequestCommitCache = new Map()
      const fetchCommitMeta = async (p) => {
        if (perRequestCommitCache.has(p)) return perRequestCommitCache.get(p)
        const cacheKey = `${ref}::${p}`
        const cached = getCachedCommitMeta(cacheKey)
        if (cached) { perRequestCommitCache.set(p, cached); return cached }
        let meta
        try {
          const commits = await github.repos.listCommits({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: env.SAFE_SETTINGS_HUB_REPO, per_page: 1, path: p })
            .then(r => Array.isArray(r.data) ? r.data : [])
          if (commits.length) {
            const c = commits[0]
            const committedAt = c.commit && c.commit.author && c.commit.author.date
            const ageSeconds = committedAt ? Math.floor((Date.now() - new Date(committedAt).getTime()) / 1000) : null
            meta = {
              lastCommitSha: c.sha,
              lastCommitAt: committedAt,
              lastCommitMessage: c.commit && c.commit.message ? c.commit.message.split('\n')[0] : null,
              lastCommitAgeSeconds: ageSeconds
            }
          } else {
            meta = { lastCommitSha: null, lastCommitAt: null, lastCommitMessage: null, lastCommitAgeSeconds: null }
          }
        } catch {
          meta = { lastCommitSha: null, lastCommitAt: null, lastCommitMessage: null, lastCommitAgeSeconds: null }
        }
        setCachedCommitMeta(cacheKey, meta)
        perRequestCommitCache.set(p, meta)
        return meta
      }

      // Helper to fetch a single file (returns null on failure)
      const fetchFile = async (p) => {
        try {
          const fileResp = await github.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: env.SAFE_SETTINGS_HUB_REPO, path: p, ref })
          if (Array.isArray(fileResp.data)) return null
          // file
          const commitMeta = await fetchCommitMeta(fileResp.data.path)
          if (fetchContent && typeof fileResp.data.content === 'string') {
            const decoded = Buffer.from(fileResp.data.content, fileResp.data.encoding || 'base64').toString('utf8')
            return {
              type: fileResp.data.type,
              name: path.posix.basename(p),
              path: fileResp.data.path,
              sha: fileResp.data.sha,
              size: fileResp.data.size,
              encoding: 'utf8',
              content: decoded,
              originalEncoding: fileResp.data.encoding || 'base64',
              ...commitMeta
            }
          }
          // metadata-only response
          return {
            type: fileResp.data.type,
            name: path.posix.basename(p),
            path: fileResp.data.path,
            sha: fileResp.data.sha,
            size: fileResp.data.size,
            content: null,
            originalEncoding: fileResp.data.encoding || 'base64',
            ...commitMeta
          }
        } catch (e) {
          robot.log.warn(`Failed to fetch file ${p}: ${e.message}`)
          return null
        }
      }

      // Recursive traversal with depth limiting and basic cycle protection
      const seen = new Set()
      // Concurrency limiter for directory entry processing
      const MAX_DIR_CONCURRENCY = parseInt(process.env.DIR_ENTRY_CONCURRENCY || '6')
      async function mapWithLimit (items, mapper) {
        const out = []
        let i = 0
        const running = new Set()
        async function run () {
          if (i >= items.length) return
          const idx = i++
          const p = Promise.resolve(mapper(items[idx], idx)).then(r => { out[idx] = r; running.delete(p) })
          running.add(p)
          if (running.size >= MAX_DIR_CONCURRENCY) await Promise.race(running)
          return run()
        }
        await run()
        await Promise.all([...running])
        return out
      }

      const traverseDir = async (dirPath, depth = 0) => {
        if (depth >= maxDepth) {
          const commitMeta = await fetchCommitMeta(dirPath)
          return { type: 'dir', name: path.posix.basename(dirPath), path: dirPath, depth, truncated: true, entries: [], ...commitMeta }
        }
        if (seen.has(dirPath)) {
          const commitMeta = await fetchCommitMeta(dirPath)
          return { type: 'dir', name: path.posix.basename(dirPath), path: dirPath, depth, cycle: true, entries: [], ...commitMeta }
        }
        seen.add(dirPath)
        let listing
        try {
          const resp = await github.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: env.SAFE_SETTINGS_HUB_REPO, path: dirPath, ref })
          if (!Array.isArray(resp.data)) {
            // Not a directory; fetch as file instead
            const f = await fetchFile(dirPath)
            return f || { type: 'file', path: dirPath, error: 'unreadable' }
          }
          listing = resp.data
        } catch (e) {
          const commitMeta = await fetchCommitMeta(dirPath)
          return { type: 'dir', name: path.posix.basename(dirPath), path: dirPath, error: e.status === 404 ? 'not_found' : e.message, entries: [], ...commitMeta }
        }

        const entries = await mapWithLimit(listing, async (item) => {
          if (item.type === 'file') {
            if (fetchContent) {
              const f = await fetchFile(item.path)
              if (f) return f
              const commitMeta = await fetchCommitMeta(item.path)
              return { type: 'file', name: item.name, path: item.path, sha: item.sha, size: item.size, content: null, ...commitMeta }
            }
            const commitMeta = await fetchCommitMeta(item.path)
            return { type: 'file', name: item.name, path: item.path, sha: item.sha, size: item.size, content: null, ...commitMeta }
          } else if (item.type === 'dir') {
            return traverseDir(item.path, depth + 1)
          }
          const commitMeta = await fetchCommitMeta(item.path)
          return { type: item.type, name: item.name, path: item.path, unsupported: true, ...commitMeta }
        })
        const commitMeta = await fetchCommitMeta(dirPath)
        return { type: 'dir', name: path.posix.basename(dirPath), path: dirPath, depth, entries, ...commitMeta }
      }

      let response
      try {
        response = await github.repos.getContent({
          owner: env.SAFE_SETTINGS_HUB_ORG,
          repo: env.SAFE_SETTINGS_HUB_REPO,
          path: fullPath,
          ref
        })
      } catch (apiError) {
        robot.log.error(`GitHub API error details: status=${apiError.status}, message=${apiError.message}`)
        if (apiError.response && apiError.response.data) {
          robot.log.error(`GitHub API response: ${JSON.stringify(apiError.response.data)}`)
        }
        throw apiError
      }

      const data = response.data
      if (Array.isArray(data)) {
        if (recursive) {
          const tree = await traverseDir(fullPath, 0)
          return res.json({
            recursive: true,
            maxDepth,
            ref,
            fetchContent,
            ...tree
          })
        } else {
          // non-recursive (original behavior)
          const entries = await Promise.all(data.map(async d => {
            if (d.type === 'file') {
              if (fetchContent) {
                const f = await fetchFile(d.path)
                if (f) return f
              }
              return {
                name: d.name,
                path: d.path,
                type: d.type,
                sha: d.sha,
                size: d.size,
                content: null
              }
            }
            return {
              name: d.name,
              path: d.path,
              type: d.type,
              sha: d.sha,
              size: d.size,
              content: null
            }
          }))
          return res.json({
            type: 'dir',
            path: fullPath,
            entries,
            ref,
            fetchContent
          })
        }
      }

      if (typeof data.content === 'string') {
        if (fetchContent) {
          const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8')
          return res.json({
            type: data.type,
            path: data.path,
            sha: data.sha,
            size: data.size,
            encoding: 'utf8',
            content: decoded,
            originalEncoding: data.encoding || 'base64',
            ref,
            fetchContent: true
          })
        }
        return res.json({
          type: data.type,
          path: data.path,
          sha: data.sha,
          size: data.size,
          content: null,
          ref,
          fetchContent: false
        })
      }
      // Unsupported type (symlink, submodule, etc.)
      return res.status(415).json({ error: 'Unsupported content type returned by GitHub API' })
    } catch (e) {
      if (e.status === 404) {
        robot.log.error(`Hub content 404: ${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO} path=${fullPath} ref=${ref}`)
        return res.status(404).json({ 
          error: 'Not found',
          details: {
            org: env.SAFE_SETTINGS_HUB_ORG,
            repo: env.SAFE_SETTINGS_HUB_REPO,
            path: fullPath,
            ref
          }
        })
      }
      robot.log && robot.log.error && robot.log.error(e)
      return res.status(500).json({ error: e.message || 'unexpected error' })
    }
  }

  router.get('/api/safe-settings/hub/content', hubContent)
  router.get('/api/safe-settings/hub/content/*', hubContent)

  /**
   * GET /api/safe-settings/app/env
   * Returns key/value pairs parsed from the project .env file excluding
   * standard GitHub App infrastructure variables.
   * Query params:
   *   includeInfra=true  -> include normally excluded infrastructure vars
   */
  router.get('/api/safe-settings/app/env', (req, res) => {
    try {
      // Define a blacklist of sensitive environment variable keys to exclude
      const ENV_BLACKLIST = ['PRIVATE_KEY_PATH'];
      
      // Parse .env file to extract comments
      const envFilePath = path.join(rootDir, '.env');
      const commentMap = new Map();
      
      try {
        const envFileContent = fs.readFileSync(envFilePath, 'utf8');
        const lines = envFileContent.split(/\r?\n/);
        
        lines.forEach(line => {
          // Match lines like: KEY=value # comment
          const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*[^#]*#\s*(.+)$/);
          if (match) {
            const [, key, comment] = match;
            commentMap.set(key, comment.trim());
          }
        });
      } catch (e) {
        // If .env file doesn't exist or can't be read, continue without comments
        robot.log && robot.log.debug && robot.log.debug('Could not read .env file for comments:', e.message);
      }
      
      const variables = Object.entries(env)
        .filter(([key]) => !ENV_BLACKLIST.includes(key))
        .map(([key, value]) => ({ 
          key, 
          value, 
          description: commentMap.get(key) || 'NA'
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return res.json({ updatedAt: new Date().toISOString(), count: variables.length, variables });
    } catch (e) {
      robot.log && robot.log.error && robot.log.error(e);
      return res.status(500).json({ error: e.message || 'unexpected error' });
    }
  })


  // POST /api/safe-settings/hub/import
  // Body: { orgs: ['org1','org2'] }
  router.post('/api/safe-settings/hub/import', async (req, res) => {
    try {
      const body = req.body || {}
      const orgs = Array.isArray(body.orgs) ? body.orgs : (body.org ? [body.org] : null)
      if (!orgs || !orgs.length) {
        return res.status(400).json({ error: 'Missing orgs in request body. Expected JSON { orgs: ["org1","org2"] }' })
      }
      // lazy-require to avoid circular require issues during module load
      const { retrieveSettingsFromOrgs } = require('./hubSyncHandler')
      const results = await retrieveSettingsFromOrgs(robot, orgs)
      // Always return 200 with results, even if some/all orgs failed
      return res.json({ ok: true, results })
    } catch (e) {
      robot.log && robot.log.error && robot.log.error(e)
      // Return 200 with error indicator for UI instead of 500
      return res.status(200).json({ ok: false, error: e.message || 'unexpected error', results: [] })
    }
  })


  // GET /api/safe-settings/hub/log
  // Returns parsed log entries (JSON): [{ timestamp, level, message }, ...]
  router.get('/api/safe-settings/hub/log', async (req, res) => {
    const lines = parseInt(req.query.lines || process.env.SAFE_SETTINGS_LOG_FILE_MAX_LINES || '1000', 10)
    const levelsQuery = req.query.levels // comma-separated e.g. 'ERROR,WARN'
    const allowedLevels = levelsQuery ? new Set(String(levelsQuery).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) : null

    const candidates = []
    if (process.env.SAFE_SETTINGS_LOG_FILE) candidates.push(process.env.SAFE_SETTINGS_LOG_FILE)
    candidates.push(path.join(rootDir, 'hubSyncHandler.log')) // Primary log file for hub-sync
    candidates.push(path.join(rootDir, 'safe-settings.log'))
    candidates.push(path.join(rootDir, '..', 'safe-settings.log'))
    candidates.push(path.join(rootDir, 'ui', 'safe-settings.log'))

    let found = null
    for (const p of candidates) {
      if (!p) continue
      try {
        const st = await fs.promises.stat(p)
        if (st && st.isFile()) { found = p; break }
      } catch (e) {
        // ignore
      }
    }
    if (!found) return res.status(404).json({ error: 'Log file not found' })

    try {
      const data = await fs.promises.readFile(found, 'utf8')
      const arr = data.split(/\r?\n/).filter(Boolean)
      const tail = arr.slice(-lines)
      const parsed = tail.map(line => {
        // Expecting format: 2025-09-10T12:34:56.789Z [INFO] message
        const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[([A-Z]+)\]\s+(.*)$/)
        if (m) {
          return { timestamp: m[1], level: m[2], message: m[3], raw: line }
        }
        // fallback: try to extract level in brackets
        const m2 = line.match(/\[([A-Z]+)\]\s*(.*)$/)
        if (m2) return { timestamp: null, level: m2[1], message: m2[2], raw: line }
        return { timestamp: null, level: 'UNKNOWN', message: line, raw: line }
      })
      const filtered = allowedLevels ? parsed.filter(p => allowedLevels.has(String(p.level).toUpperCase())) : parsed
      return res.json({ count: filtered.length, entries: filtered })
    } catch (err) {
      return res.status(500).json({ error: err && err.message ? err.message : String(err) })
    }
  })

  // Alias for backwards compatibility
  router.get('/api/safe-settings/logs', (req, res, next) => {
    req.url = '/api/safe-settings/hub/log' + (req._parsedUrl.search || '')
    next('route')
  })

  // GET /api/safe-settings/sync-logs
  // Returns only sync-related log entries (filtered by [SYNC or containing 'sync')
  router.get('/api/safe-settings/sync-logs', async (req, res) => {
    const lines = parseInt(req.query.lines || process.env.SAFE_SETTINGS_LOG_FILE_MAX_LINES || '1000', 10)
    const levelsQuery = req.query.levels // comma-separated e.g. 'ERROR,WARN'
    const allowedLevels = levelsQuery ? new Set(String(levelsQuery).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) : null

    const candidates = []
    if (process.env.SAFE_SETTINGS_LOG_FILE) candidates.push(process.env.SAFE_SETTINGS_LOG_FILE)
    candidates.push(path.join(rootDir, 'hubSyncHandler.log')) // Primary log file for hub-sync
    candidates.push(path.join(rootDir, 'safe-settings.log'))
    candidates.push(path.join(rootDir, '..', 'safe-settings.log'))
    candidates.push(path.join(rootDir, 'ui', 'safe-settings.log'))

    let found = null
    for (const p of candidates) {
      if (!p) continue
      try {
        const st = await fs.promises.stat(p)
        if (st && st.isFile()) { found = p; break }
      } catch (e) {
        // ignore
      }
    }
    if (!found) return res.status(404).json({ error: 'Log file not found' })

    try {
      const data = await fs.promises.readFile(found, 'utf8')
      const arr = data.split(/\r?\n/).filter(Boolean)
      const tail = arr.slice(-lines * 3) // Get more lines to ensure we have enough sync entries
      const parsed = tail.map(line => {
        // Expecting format: 2025-09-10T12:34:56.789Z [INFO] message
        const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[([A-Z]+)\]\s+(.*)$/)
        if (m) {
          return { timestamp: m[1], level: m[2], message: m[3], raw: line }
        }
        // fallback: try to extract level in brackets
        const m2 = line.match(/\[([A-Z]+)\]\s*(.*)$/)
        if (m2) return { timestamp: null, level: m2[1], message: m2[2], raw: line }
        return { timestamp: null, level: 'UNKNOWN', message: line, raw: line }
      })
      
      // Filter for sync-related entries
      const syncFiltered = parsed.filter(p => {
        const msg = p.message.toLowerCase()
        return msg.includes('sync') || msg.includes('[sync')
      })
      
      // Apply level filter if specified
      const filtered = allowedLevels 
        ? syncFiltered.filter(p => allowedLevels.has(String(p.level).toUpperCase())) 
        : syncFiltered
      
      // Limit to requested number of lines
      const final = filtered.slice(-lines)
      
      return res.json({ count: final.length, entries: final, syncOnly: true })
    } catch (err) {
      return res.status(500).json({ error: err && err.message ? err.message : String(err) })
    }
  })

  return router
}

module.exports = { setupRoutes }
