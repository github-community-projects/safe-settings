// Installation cache with TTL for GitHub App installations.
// Provides a hybrid approach: live refresh when stale, fast reads otherwise.

let cachedInstallations = []
let cachedOrgLogins = []
let lastFetchedAt = null
let inFlightPromise = null

/**
 * Returns the TTL (time-to-live) in milliseconds for the installation cache.
 * Reads from INSTALLATION_CACHE_TTL_MS env variable, defaults to 60s, minimum 5s.
 */
const DEFAULT_TTL_MS = 60_000
function getTtlMs () {
  const v = parseInt(process.env.INSTALLATION_CACHE_TTL_MS, 10)
  return isNaN(v) || v < 5_000 ? DEFAULT_TTL_MS : v
}

/**
 * Fetches all GitHub App installations using the provided robot instance.
 * Returns an array of installation objects. Uses pagination for large orgs.
 * @param {Probot} robot - The Probot robot instance
 * @param {Object} opts - Options (perPage)
 * @returns {Promise<Array>} Array of installation objects
 */
async function fetchInstallations (robot, { perPage = 100 } = {}) {
  const github = await robot.auth()
  return github.paginate(
    github.rest.apps.listInstallations.endpoint.merge({ per_page: perPage })
  )
}

/**
 * Refreshes the installation cache by fetching live installations from GitHub.
 * Updates cachedInstallations, cachedOrgLogins, and lastFetchedAt.
 * Ensures only one refresh is in flight at a time.
 * @param {Probot} robot - The Probot robot instance
 * @param {Object} opts - Options for fetchInstallations
 * @returns {Promise<Array>} Array of installation objects
 */
async function refresh (robot, opts = {}) {
  if (inFlightPromise) return inFlightPromise
  inFlightPromise = (async () => {
    try {
      const installs = await fetchInstallations(robot, opts)
      cachedInstallations = installs
      cachedOrgLogins = installs
        .filter(i => i.account && i.account.type === 'Organization')
        .map(i => i.account.login)
        .sort()
      lastFetchedAt = new Date()
    } catch (e) {
      robot.log && robot.log.warn && robot.log.warn(`Installation cache refresh failed: ${e.message}`)
      throw e
    } finally {
      inFlightPromise = null
    }
    return cachedInstallations
  })()
  return inFlightPromise
}

/**
 * Starts a prefetch of installations to warm up the cache at startup.
 * Returns a promise for the refresh operation.
 * @param {Probot} robot - The Probot robot instance
 * @param {Object} opts - Options for refresh
 * @returns {Promise<Array>} Array of installation objects
 */
function startPrefetch (robot, opts = {}) {
  return refresh(robot, opts)
}

/**
 * Initialize cache (always prefetch once at startup) and log result.
 */

/**
 * Initializes the installation cache by prefetching installations at startup.
 * Logs the result and returns true/false for success/failure.
 * @param {Probot} robot - The Probot robot instance
 * @returns {Promise<boolean>} True if prefetch succeeded, false otherwise
 */
function initCache (robot) {
  return startPrefetch(robot)
    .then(installs => {
      robot.log && robot.log.info && robot.log.info(`Installation cache prefetched ${installs.length} installs (${cachedOrgLogins.length} orgs) [TTL=${getTtlMs()}ms]`)
      return true
    })
    .catch(e => {
      robot.log && robot.log.warn && robot.log.warn(`Installation cache prefetch failed: ${e.message}`)
      return false
    })
}

/**
 * Ensures the cache is fresh by checking TTL and refreshing if stale.
 * Called before serving cached installations to guarantee freshness.
 * @param {Probot} robot - The Probot robot instance
 */
async function ensureFresh (robot) {
  const ttl = getTtlMs()
  if (!lastFetchedAt || (Date.now() - lastFetchedAt.getTime()) > ttl) {
    try { await refresh(robot) } catch (_) { /* stale ok */ }
  }
}

/**
 * Returns the cached installations, refreshing if the cache is stale.
 * Always returns a copy of the cached array.
 * @param {Probot} robot - The Probot robot instance
 * @returns {Promise<Array>} Array of installation objects
 */
async function getInstallations (robot) {
  await ensureFresh(robot)
  return cachedInstallations.slice()
}

/**
 * Returns a copy of the cached organization logins (GitHub org names).
 * @returns {Array<string>} Array of org login strings
 */
function getOrgLogins () { return cachedOrgLogins.slice() }

/**
 * Returns the Date when installations were last fetched.
 * @returns {Date|null} Last fetched date or null if never fetched
 */
function getLastFetchedAt () { return lastFetchedAt }

/**
 * Test-only helper: Forces the cache to appear stale on next access.
 * Used for diagnostics and testing cache refresh logic.
 */
function __forceStale () {
  lastFetchedAt = new Date(Date.now() - (getTtlMs() + 10_000))
}

module.exports = {
  startPrefetch,
  initCache,
  refresh,
  getInstallations,
  getOrgLogins,
  getLastFetchedAt,
  // for tests / diagnostics
  _debug: () => ({ size: cachedInstallations.length, lastFetchedAt }),
  __forceStale
}
