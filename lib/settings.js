const path = require('path')
const { Eta } = require('eta')
const commetMessageTemplate = require('./commentmessage')
const errorTemplate = require('./error')
const Glob = require('./glob')
const NopCommand = require('./nopcommand')
const MergeDeep = require('./mergeDeep')
const Archive = require('./plugins/archive')
const DeploymentConfig = require('./deploymentConfig')
const env = require('./env')

// Valid `target` values for a disable_plugins entry.
const DISABLE_TARGETS = new Set(['self', 'children', 'all'])
// Valid declaration layers (where a disable_plugins entry can be authored).
const DISABLE_LEVELS = ['deployment', 'org', 'suborg', 'repo']
// For each declared layer + target, the set of layers from which to STRIP the
// named plugin's config. See plan-v3 matrix.
const DISABLE_STRIP_MATRIX = {
  deployment: {
    self: ['deployment'],
    children: ['org', 'suborg', 'repo'],
    all: ['deployment', 'org', 'suborg', 'repo']
  },
  org: {
    self: ['org'],
    children: ['suborg', 'repo'],
    all: ['org', 'suborg', 'repo']
  },
  suborg: {
    self: ['suborg'],
    children: ['repo'],
    all: ['suborg', 'repo']
  },
  repo: {
    self: ['repo'],
    children: ['repo'], // normalized; repo has no children
    all: ['repo']
  }
}
const CONFIG_PATH = env.CONFIG_PATH
const eta = new Eta({ views: path.join(__dirname) })
const SCOPE = { ORG: 'org', REPO: 'repo' } // Determine if the setting is a org setting or repo setting
// Maximum size (in characters) of a single PR comment / check-run summary body.
const COMMENT_LIMIT = 55536
const yaml = require('js-yaml')

// When a repo-yml change applies teams/properties/etc to a repo, the repo may
// change suborg config matches (via suborgteams/suborgproperties/suborgrepos).
// Re-run updateRepos for the same repo at most this many times. Depth=1 is the
// tightest cap: we resolve a single hop of newly-matched suborg per sync.
const MAX_REEVALUATION_DEPTH = 1

// ---------------------------------------------------------------------------
// NOP change-detection helpers
// ---------------------------------------------------------------------------

// Recursively determines whether a value is "empty" (null/undefined, empty
// array/object, or a structure containing only empty values).
function isDeepEmpty (value) {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0 || value.every(isDeepEmpty)
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return keys.length === 0 || keys.every(k => isDeepEmpty(value[k]))
  }
  return false
}

// Determines whether a NopCommand action represents no meaningful change.
// String actions (message-only NOP results) are treated as non-empty so they
// are not silently dropped from reporting.
function isEmptyChange (action) {
  if (!action) return true
  if (typeof action === 'string') return action.length === 0
  const { additions, deletions, modifications } = action
  if (additions === null && deletions === null && modifications === null) return true
  return isDeepEmpty(additions) && isDeepEmpty(deletions) && isDeepEmpty(modifications)
}

// Produce a canonical (key-sorted) clone so deep equality is order-independent.
function canonicalize (value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = canonicalize(value[key])
    return acc
  }, {})
}

function stableStringify (value) {
  return JSON.stringify(canonicalize(value))
}

/**
 * Determines which named entries in an array-based config section actually
 * changed between the base branch and the PR branch. Returns a Set of entry
 * names that differ. Uses name-indexed Maps (O(n)) and order-independent deep
 * equality to avoid false positives from key ordering.
 */
function getChangedEntryNames (baseEntries, prEntries) {
  const changed = new Set()
  if (!baseEntries && !prEntries) return changed
  if (!baseEntries || !Array.isArray(baseEntries)) {
    // All PR entries are new
    if (Array.isArray(prEntries)) prEntries.forEach(e => { if (e && e.name) changed.add(e.name) })
    return changed
  }
  if (!prEntries || !Array.isArray(prEntries)) {
    // All base entries are deleted
    baseEntries.forEach(e => { if (e && e.name) changed.add(e.name) })
    return changed
  }
  const baseByName = new Map()
  baseEntries.forEach(e => { if (e && e.name) baseByName.set(e.name, e) })
  const prByName = new Map()
  prEntries.forEach(e => { if (e && e.name) prByName.set(e.name, e) })
  // Added or modified entries
  for (const [name, prEntry] of prByName) {
    const baseEntry = baseByName.get(name)
    if (!baseEntry || stableStringify(baseEntry) !== stableStringify(prEntry)) {
      changed.add(name)
    }
  }
  // Deleted entries
  for (const name of baseByName.keys()) {
    if (!prByName.has(name)) changed.add(name)
  }
  return changed
}

/**
 * Filters a NOP action's arrays to only include entries whose 'name' is in the
 * changedNames set. Returns a new action with filtered arrays, or null if
 * nothing meaningful remains.
 */
function filterActionByChangedNames (action, changedNames) {
  if (!action || typeof action === 'string') return action

  const { additions, deletions, modifications, ...rest } = action

  const filterArray = (arr) => {
    if (!arr || !Array.isArray(arr)) return arr
    return arr.filter(entry => {
      if (!entry || typeof entry !== 'object') return true
      // Keep entries whose name is in the changed set
      if (entry.name && changedNames.has(entry.name)) return true
      // Keep entries without a name field (structural entries like conditions)
      if (!entry.name) return true
      return false
    })
  }

  const filtered = {
    ...rest,
    additions: filterArray(additions),
    deletions: filterArray(deletions),
    modifications: filterArray(modifications)
  }

  // Return null if everything was filtered out
  if (isEmptyChange(filtered)) return null
  return filtered
}

// ---------------------------------------------------------------------------
// NOP change-rendering helpers (collapsible, field-level diff summaries)
// ---------------------------------------------------------------------------

function buildChangeSections (changes, baseConfig, config) {
  return Object.keys(changes).map(plugin => {
    const repoSections = []
    Object.keys(changes[plugin]).forEach(repo => {
      const targetMap = new Map()
      changes[plugin][repo].forEach(action => {
        targetsForAction(plugin, repo, action, baseConfig, config).forEach(target => {
          if (!targetMap.has(target.target)) {
            targetMap.set(target.target, {
              target: target.target,
              rows: []
            })
          }
          targetMap.get(target.target).rows.push(...target.rows)
        })
      })
      repoSections.push({
        repo,
        targets: Array.from(targetMap.values()).filter(target => target.rows.length > 0)
      })
    })

    const filteredRepoSections = repoSections.filter(repoSection => repoSection.targets.length > 0)
    const changeCount = filteredRepoSections.reduce((count, repoSection) => {
      return count + repoSection.targets.reduce((targetCount, target) => targetCount + target.rows.length, 0)
    }, 0)
    const targetCount = filteredRepoSections.reduce((count, repoSection) => count + repoSection.targets.length, 0)
    const repoCount = filteredRepoSections.length
    const targetSingular = plugin.toLowerCase() === 'rulesets' ? 'policy' : 'setting'
    const targetPlural = plugin.toLowerCase() === 'rulesets' ? 'policies' : 'settings'
    const impactSummary = `${repoCount} ${pluralize(repoCount, 'repo', 'repos')}, ${targetCount} ${pluralize(targetCount, targetSingular, targetPlural)} changed`
    return {
      plugin,
      repoSections: filteredRepoSections,
      repoCount,
      targetCount,
      changeCount,
      impactSummary,
      summary: `${plugin} - ${impactSummary}`
    }
  }).filter(section => section.repoSections.length > 0)
}

function renderChangeSections (changeSections) {
  return changeSections.map(section => {
    const repoBlocks = section.repoSections.map(repoSection => {
      const targetBlocks = repoSection.targets.map(target => {
        return `- ${markdownInlineCode(target.target)}\n${renderFieldChangeList(target.rows, '  ')}`
      })
      return `**${markdownText(displayRepoName(repoSection.repo))}**\n${targetBlocks.join('\n')}`
    })

    return `<details>\n<summary>${escapeHtml(section.plugin)} — ${escapeHtml(section.impactSummary)}</summary>\n\n${repoBlocks.join('\n\n')}\n\n</details>`
  })
}

function affectedRepoCount (changeSections) {
  return new Set(changeSections.flatMap(section => {
    return section.repoSections.map(repoSection => displayRepoName(repoSection.repo))
  })).size
}

function displayRepoName (repo) {
  return repo && repo.endsWith('(org)') ? env.ADMIN_REPO : repo
}

function renderFieldChangeList (rows, indent = '') {
  return rows.map(row => {
    const marker = changeMarker(row.change)
    if (row.change === 'Info') {
      return `${indent}- ${marker} ${markdownText(row.after || row.before || row.field)}`
    }
    if (row.change === 'Modified') {
      return `${indent}- ${marker} ${markdownInlineCode(row.field)}\n${indent}  - before: ${markdownInlineCode(row.before, row.after)}\n${indent}  - after: ${markdownInlineCode(row.after, row.before)}`
    }
    const value = row.change === 'Deleted' ? row.before : row.after
    return `${indent}- ${marker} ${markdownInlineCode(row.field)}: ${markdownInlineCode(value)}`
  }).join('\n')
}

function changeMarker (change) {
  if (change === 'Added') return '+'
  if (change === 'Deleted') return '-'
  if (change === 'Modified') return '~'
  return 'i'
}

function targetsForAction (plugin, repo, action, baseConfig, config) {
  if (typeof action === 'string') {
    return [createTarget(plugin, [createFieldChangeRow('Info', 'message', '', action)])]
  }

  const configTargets = targetsFromConfigDiff(plugin, repo, action, baseConfig, config)
  if (configTargets) return configTargets

  const additions = normalizeChangeEntries(action && action.additions)
  const deletions = normalizeChangeEntries(action && action.deletions)
  const modifications = normalizeChangeEntries(action && action.modifications)

  const usedDeletions = new Set()
  const targets = []

  additions.forEach(entry => {
    const target = getChangeTarget(entry, plugin)
    targets.push(createTarget(target, rowsForAddedOrDeleted('Added', entry, target)))
  })

  modifications.forEach((entry, index) => {
    const target = getChangeTarget(entry, plugin)
    const match = findMatchingDeletion(entry, index, modifications, deletions, usedDeletions)
    if (match.index !== -1) usedDeletions.add(match.index)
    targets.push(createTarget(target, rowsForModification(match.entry, entry, target)))
  })

  deletions.forEach((entry, index) => {
    if (usedDeletions.has(index)) return
    const target = getChangeTarget(entry, plugin)
    targets.push(createTarget(target, rowsForAddedOrDeleted('Deleted', entry, target)))
  })

  if (targets.length === 0 && action && action.msg) {
    return [createTarget(plugin, [createFieldChangeRow('Info', 'message', '', action.msg)])]
  }

  return targets
}

function targetsFromConfigDiff (plugin, repo, action, baseConfig, config) {
  if (!baseConfig || !config || !action || typeof action === 'string') return null

  const pluginSection = plugin.toLowerCase()
  const isOrgRulesets = repo && repo.endsWith('(org)') && pluginSection === 'rulesets'
  const baseEntries = baseConfig[pluginSection]
  const prEntries = config[pluginSection]

  if (!isOrgRulesets) return null
  if (!Array.isArray(baseEntries) || !Array.isArray(prEntries)) return null

  const actionNames = getActionEntryNames(action)
  if (actionNames.size === 0) return null

  const changedNames = new Set(Array.from(getChangedEntryNames(baseEntries, prEntries)).filter(name => actionNames.has(name)))
  if (changedNames.size === 0) return null

  const targets = []
  Array.from(changedNames).sort().forEach(name => {
    const oldEntry = findEntryByIdentity(baseEntries, name)
    const newEntry = findEntryByIdentity(prEntries, name)
    let rows = []

    if (oldEntry && newEntry) {
      rows = rowsForModification(oldEntry, newEntry, name)
    } else if (newEntry) {
      rows = rowsForAddedOrDeleted('Added', newEntry, name)
    } else if (oldEntry) {
      rows = rowsForAddedOrDeleted('Deleted', oldEntry, name)
    }

    if (rows.length > 0) targets.push(createTarget(name, rows))
  })

  return targets.length > 0 ? targets : null
}

function getActionEntryNames (action) {
  const names = new Set()
  ;['additions', 'deletions', 'modifications'].forEach(actionField => {
    normalizeChangeEntries(action[actionField]).forEach(entry => {
      const identity = getEntryIdentityValue(entry)
      if (identity) names.add(identity)
    })
  })
  return names
}

function findEntryByIdentity (entries, identity) {
  return entries.find(entry => getEntryIdentityValue(entry) === identity)
}

function createTarget (target, rows) {
  return {
    target,
    rows: rows.filter(row => row)
  }
}

function normalizeChangeEntries (value) {
  if (isDeepEmpty(value)) return []
  return Array.isArray(value) ? value.filter(entry => !isDeepEmpty(entry)) : [value]
}

function findMatchingDeletion (entry, index, modifications, deletions, usedDeletions) {
  const identity = getChangeIdentity(entry)
  if (identity) {
    const matchIndex = deletions.findIndex((deletion, deletionIndex) => {
      if (usedDeletions.has(deletionIndex)) return false
      return getChangeIdentity(deletion) === identity
    })
    if (matchIndex !== -1) return { entry: deletions[matchIndex], index: matchIndex }
  }

  if (modifications.length === 1 && deletions.length === 1 && !usedDeletions.has(0)) {
    return { entry: deletions[0], index: 0 }
  }

  return { entry: null, index: -1 }
}

function getChangeIdentity (entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const field = MergeDeep.NAME_FIELDS.find(field => Object.prototype.hasOwnProperty.call(entry, field))
  if (!field) return null
  return `${field}:${formatValue(entry[field]).text}`
}

function getChangeTarget (entry, fallback) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return formatValue(entry).text || fallback
  return getEntryIdentityValue(entry) || fallback
}

function getEntryIdentityValue (entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const field = MergeDeep.NAME_FIELDS.find(field => Object.prototype.hasOwnProperty.call(entry, field))
  return field ? formatValue(entry[field]).text : null
}

function rowsForAddedOrDeleted (change, entry, target) {
  const flattened = flattenForSummary(entry, true)
  const fields = Object.keys(flattened)
  if (fields.length === 0) return [createFieldChangeRow(change, 'value', change === 'Added' ? '' : target, change === 'Added' ? target : '')]

  return fields.map(path => {
    const value = flattened[path]
    return createFieldChangeRow(change, path, change === 'Deleted' ? value : '', change === 'Deleted' ? '' : value)
  })
}

function rowsForModification (oldEntry, newEntry, target) {
  if (!oldEntry || typeof oldEntry !== 'object' || !newEntry || typeof newEntry !== 'object') {
    return rowsForAddedOrDeleted('Modified', newEntry, target)
  }

  const oldPaths = flattenForSummary(oldEntry, true)
  const newPaths = flattenForSummary(newEntry, true)
  const paths = Array.from(new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)])).sort()
  const rows = paths.map(path => {
    const hasOld = Object.prototype.hasOwnProperty.call(oldPaths, path)
    const hasNew = Object.prototype.hasOwnProperty.call(newPaths, path)
    if (hasOld && hasNew && comparableValue(oldPaths[path]) !== comparableValue(newPaths[path])) {
      return createFieldChangeRow('Modified', path, oldPaths[path], newPaths[path])
    }
    if (!hasOld && hasNew) {
      return createFieldChangeRow('Added', path, '', newPaths[path])
    }
    if (hasOld && !hasNew) {
      return createFieldChangeRow('Deleted', path, oldPaths[path], '')
    }
    return null
  }).filter(row => row)

  if (rows.length > 0) return rows
  return rowsForAddedOrDeleted('Modified', newEntry, target)
}

function createFieldChangeRow (change, field, before, after) {
  return {
    change,
    field,
    before,
    after
  }
}

function flattenForSummary (value, skipRootIdentity = false, prefix = '') {
  if (value === null || value === undefined || typeof value !== 'object') {
    return { [prefix || 'value']: formatValue(value) }
  }

  if (Array.isArray(value)) {
    return { [prefix || 'value']: formatValue(value) }
  }

  const result = {}
  Object.keys(value).forEach(key => {
    if (!prefix && skipRootIdentity && MergeDeep.NAME_FIELDS.includes(key)) return
    const path = prefix ? `${prefix}.${key}` : key
    const child = value[key]

    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(result, flattenForSummary(child, false, path))
    } else {
      result[path] = formatValue(child)
    }
  })

  return result
}

function formatValue (value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return value
  if (value === null) return { text: 'null', compare: 'null' }
  if (value === undefined) return { text: '', compare: '' }
  if (typeof value === 'string') return { text: value, compare: value }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: `${value}`, compare: `${value}` }
  if (Array.isArray(value) && value.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    const text = value.map(item => formatValue(item).text).join(', ')
    return { text, compare: text }
  }
  const json = JSON.stringify(value)
  return {
    text: truncate(json, 180),
    compare: json
  }
}

function comparableValue (value) {
  const displayValue = formatValue(value)
  return Object.prototype.hasOwnProperty.call(displayValue, 'compare') ? displayValue.compare : displayValue.text
}

function truncate (value, limit = 180) {
  if (!value || value.length <= limit) return value
  return `${value.substring(0, limit - 3)}...`
}

function truncateAroundDifference (value, otherValue, limit = 180) {
  if (!value || value.length <= limit) return value
  if (!otherValue || value === otherValue) return truncate(value, limit)

  let prefixLength = 0
  while (
    prefixLength < value.length &&
    prefixLength < otherValue.length &&
    value[prefixLength] === otherValue[prefixLength]
  ) {
    prefixLength++
  }

  let suffixLength = 0
  while (
    suffixLength < value.length - prefixLength &&
    suffixLength < otherValue.length - prefixLength &&
    value[value.length - 1 - suffixLength] === otherValue[otherValue.length - 1 - suffixLength]
  ) {
    suffixLength++
  }

  const contextLength = Math.floor((limit - 6) / 2)
  const start = Math.max(0, prefixLength - contextLength)
  const end = Math.min(value.length, value.length - suffixLength + contextLength)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < value.length ? '...' : ''
  return truncate(`${prefix}${value.substring(start, end)}${suffix}`, limit)
}

function truncateWithSuffix (value, limit, suffix) {
  if (!value || value.length <= limit) return value
  return `${value.substring(0, limit - suffix.length)}${suffix}`
}

function pluralize (count, singular, plural) {
  return count === 1 ? singular : plural
}

function markdownInlineCode (value, comparedWith) {
  return `\`${markdownText(value, comparedWith).replaceAll('`', '\\`')}\``
}

function markdownText (value, comparedWith) {
  const displayValue = formatValue(value)
  const otherDisplayValue = comparedWith === undefined ? null : formatValue(comparedWith)
  const text = otherDisplayValue
    ? truncateAroundDifference(displayValue.compare || displayValue.text, otherDisplayValue.compare || otherDisplayValue.text)
    : displayValue.text
  return escapeHtml(text)
    .replaceAll('\n', ' ')
}

function escapeHtml (value) {
  return `${value}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

class Settings {
  static fileCache = {}

  static async syncAll (nop, context, repo, config, ref, baseConfig, changedFiles = {}) {
    const settings = new Settings(nop, context, repo, config, ref, null, baseConfig)
    settings.setChangedConfigTargets(changedFiles.repos, changedFiles.subOrgs)
    try {
      await settings.loadConfigs()
      settings.trackChangedReposFromSubOrgConfigs()
      // settings.repoConfigs = await settings.getRepoConfigs()
      await settings.updateOrg()
      await settings.updateAll()
      await settings.updateChangedRepoConfigs(changedFiles.repos)
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
    return settings
  }

  static async syncSubOrgs (nop, context, suborg, repo, config, ref) {
    const settings = new Settings(nop, context, repo, config, ref, suborg)
    try {
      await settings.loadConfigs()
      await settings.updateAll()
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async syncSelectedRepos (nop, context, repos, subOrgs, config, ref, baseConfig, baseRef) {
    const settings = new Settings(nop, context, context.repo(), config, ref, null, baseConfig)
    settings.setChangedConfigTargets(repos, subOrgs)

    try {
      // Track repos affected by changed suborg config files so base-config
      // filtering knows which repo-level results to keep during NOP runs.
      settings.subOrgConfigs = await settings.getSubOrgConfigs()
      settings.trackChangedReposFromSubOrgConfigs()

      // Identify repos removed from suborg targeting due to targeting rule
      // changes in the suborg config file. These repos need processing so
      // their suborg-applied settings (e.g. rulesets) are cleaned up.
      if (subOrgs.length > 0 && baseRef) {
        const removedRepos = await settings.getReposRemovedFromSubOrgTargeting(subOrgs, baseRef)
        if (removedRepos.length > 0) {
          settings.log.debug(`Repos removed from suborg targeting: ${JSON.stringify(removedRepos)}`)
          // Add removed repos to changedRepoNames so NOP filtering keeps their results
          if (!settings.changedRepoNames) {
            settings.changedRepoNames = new Set()
          }
          for (const repoName of removedRepos) {
            settings.changedRepoNames.add(repoName)
          }
          // Process removed repos with org-only config (no suborg layer)
          for (const repoName of removedRepos) {
            if (settings.isRestricted(repoName)) continue
            if (settings.processedRepoNames.has(repoName)) continue
            const repo = { owner: context.repo().owner, repo: repoName }
            settings.repoConfigs = await settings.getRepoConfigs(repo)
            await settings.updateRepos(repo)
          }
        }
      }

      // Re-eval is enabled only for the per-repo iteration (repo-yml change
      // path). The trailing suborg iteration below already iterates all suborg
      // repos, so it is left with the flag off.
      settings.reevaluateOnChange = true
      for (const repo of repos) {
        settings.repo = repo
        await settings.loadConfigs(repo)
        if (settings.isRestricted(repo.repo)) {
          continue
        }
        await settings.updateRepos(repo)
      }
      settings.reevaluateOnChange = false
      for (const suborg of subOrgs) {
        settings.subOrgConfigMap = [suborg]
        settings.suborgChange = !!suborg
        await settings.loadConfigs()
        await settings.updateAll()
      }
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async sync (nop, context, repo, config, ref) {
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      // Repo-yml change path: re-evaluate suborg membership for this repo if
      // the applied changes (teams/custom_properties/new repo) cause it to
      // newly match a suborg config.
      settings.reevaluateOnChange = true
      await settings.loadConfigs(repo)
      if (settings.isRestricted(repo.repo)) {
        return
      }
      await settings.updateRepos(repo)
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async handleError (nop, context, repo, config, ref, nopcommand) {
    const settings = new Settings(nop, context, repo, config, ref)
    settings.appendToResults([nopcommand])
    await settings.handleResults()
  }

  constructor (nop, context, repo, config, ref, suborg, baseConfig) {
    this.ref = ref
    this.context = context
    this.installation_id = context.payload.installation.id
    this.github = context.octokit
    this.repo = repo
    this.config = config
    this.baseConfig = baseConfig || null
    this.nop = nop
    this.suborgChange = !!suborg
    // If suborg config has been updated, do not load the entire suborg config, and only process repos restricted to it.
    if (suborg) {
      this.subOrgConfigMap = [suborg]
    }
    this.log = context.log
    this.results = []
    this.errors = []
    this.configvalidators = {}
    this.overridevalidators = {}
    const overridevalidators = config.overridevalidators
    if (this.isIterable(overridevalidators)) {
      for (const validator of overridevalidators) {
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'overrideconfig', 'githubContext', validator.script)
        this.overridevalidators[validator.plugin] = { canOverride: f, error: validator.error }
      }
    }
    const configvalidators = config.configvalidators
    if (this.isIterable(configvalidators)) {
      for (const validator of configvalidators) {
        this.log.debug(`Logging each script: ${typeof validator.script}`)
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'githubContext', validator.script)
        this.configvalidators[validator.plugin] = { isValid: f, error: validator.error }
      }
    }
    this.mergeDeep = new MergeDeep(this.log, this.github, [], this.configvalidators, this.overridevalidators)
    // Suborg re-evaluation state (used only when reevaluateOnChange is true).
    // - reevaluationDepth: repo name -> number of re-evaluation passes done.
    // - reevaluatedRepos: repo name -> set of suborg source paths seen so far
    //   (used for stability comparison; if no new sources appear, we stop).
    this.reevaluateOnChange = false
    this.reevaluationDepth = new Map()
    this.reevaluatedRepos = new Map()
    this.processedRepoNames = new Set()
  }

  // Record which repo override files and suborg config files changed in the PR.
  // Used during NOP runs to keep repo-level results whose config actually
  // changed (and filter out pre-existing drift).
  setChangedConfigTargets (changedRepos = [], changedSubOrgs = []) {
    const repoNames = Array.isArray(changedRepos)
      ? changedRepos.map(repo => repo && repo.repo).filter(Boolean)
      : []

    this.changedRepoNames = new Set(repoNames)
    this.changedSubOrgConfigs = Array.isArray(changedSubOrgs) ? changedSubOrgs : []
  }

  // Expand changedSubOrgConfigs (changed suborg config files) into the set of
  // repos they affect, adding them to changedRepoNames.
  trackChangedReposFromSubOrgConfigs () {
    if (!Array.isArray(this.changedSubOrgConfigs) || this.changedSubOrgConfigs.length === 0 || !this.subOrgConfigs) {
      return
    }

    const changedSubOrgPaths = new Set(
      this.changedSubOrgConfigs
        .map(subOrg => subOrg && subOrg.path)
        .filter(Boolean)
    )

    if (changedSubOrgPaths.size === 0) {
      return
    }

    if (!this.changedRepoNames) {
      this.changedRepoNames = new Set()
    }

    Object.entries(this.subOrgConfigs).forEach(([repoName, subOrgConfig]) => {
      if (subOrgConfig && subOrgConfig.source && changedSubOrgPaths.has(subOrgConfig.source)) {
        this.changedRepoNames.add(repoName)
      }
    })
  }

  // Identify repos that were previously targeted by suborg config files but
  // are no longer targeted after the targeting rules changed. Loads the
  // previous version of each changed suborg file from `baseRef`, resolves its
  // targeting, and returns repo names present in the old targeting but absent
  // from the current `this.subOrgConfigs`.
  async getReposRemovedFromSubOrgTargeting (changedSubOrgs, baseRef) {
    if (!changedSubOrgs || changedSubOrgs.length === 0 || !baseRef) {
      return []
    }

    const removedRepos = []

    for (const suborg of changedSubOrgs) {
      const filePath = suborg.path
      if (!filePath) continue

      // Load the previous version of this suborg config file
      let previousData
      try {
        previousData = await this.loadYamlFromRef(filePath, baseRef)
      } catch (e) {
        this.log.debug(`Could not load previous suborg config from ref ${baseRef}: ${e.message}`)
        continue
      }

      if (!previousData) continue

      // Resolve repos targeted by the old config
      const previouslyTargetedRepos = new Set()

      // 1. suborgrepos: glob patterns (these are repo name patterns)
      if (previousData.suborgrepos && Array.isArray(previousData.suborgrepos)) {
        for (const repoPattern of previousData.suborgrepos) {
          previouslyTargetedRepos.add(repoPattern)
        }
      }

      // 2. suborgteams: resolve via GitHub API (team membership is live state)
      if (previousData.suborgteams && Array.isArray(previousData.suborgteams)) {
        try {
          const teamPromises = previousData.suborgteams.map(teamslug =>
            this.getReposForTeam(teamslug)
          )
          const teamResults = await Promise.all(teamPromises)
          for (const repos of teamResults) {
            for (const repo of repos) {
              previouslyTargetedRepos.add(repo.name)
            }
          }
        } catch (e) {
          this.log.debug(`Error resolving previous suborgteams: ${e.message}`)
        }
      }

      // 3. suborgproperties: resolve via GitHub API (property values are live state)
      if (previousData.suborgproperties && Array.isArray(previousData.suborgproperties)) {
        try {
          const subOrgRepositories = await this.getSubOrgRepositories(previousData.suborgproperties)
          for (const repo of subOrgRepositories) {
            previouslyTargetedRepos.add(repo.repository_name)
          }
        } catch (e) {
          this.log.debug(`Error resolving previous suborgproperties: ${e.message}`)
        }
      }

      // Find repos in previous targeting that are NOT in current targeting
      for (const repoName of previouslyTargetedRepos) {
        if (!this.getSubOrgConfig(repoName)) {
          removedRepos.push(repoName)
        }
      }
    }

    return [...new Set(removedRepos)]
  }

  // Load a YAML file from a specific git ref, bypassing the file cache.
  // Used to load previous versions of config files for comparison.
  async loadYamlFromRef (filePath, ref) {
    const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
    const params = Object.assign(repo, { path: filePath, ref })

    const response = await this.github.repos.getContent(params)

    if (Array.isArray(response.data)) {
      return null
    }

    if (typeof response.data.content !== 'string') {
      return null
    }

    return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
  }

  // Create a check in the Admin repo for safe-settings.
  async createCheckRun () {
    const startTime = new Date()
    let conclusion = 'success'
    let details = `Run on: \`${new Date().toISOString()}\``
    let summary = 'Safe-Settings finished successfully.'

    if (this.errors.length > 0) {
      conclusion = 'failure'
      summary = 'Safe-Settings finished with errors.'
      details = await eta.renderString(errorTemplate, this.errors)
    }

    // Use the latest commit to create the check against
    return this.github.repos.listCommits({
      owner: this.repo.owner,
      repo: env.ADMIN_REPO
    })
      .then(commits => {
        return this.github.checks.create(
          {
            owner: this.repo.owner,
            repo: env.ADMIN_REPO,
            name: 'Safe-Settings',
            head_sha: commits.data[0].sha,
            status: 'completed',
            started_at: startTime,
            conclusion,
            completed_at: new Date(),
            output: {
              title: 'Safe-Settings',
              summary,
              text: details.length > 55536 ? `${details.substring(0, 55536)}... (too many changes to report)` : details
            }
          }
        )
      })
      .then(res => {
        this.log.debug(`Created the check for Safe-Settings ${JSON.stringify(res)}`)
      }).catch(e => {
        if (e.status === 404) {
          this.log.error('Admin Repo Not found')
        }
        this.log.error(`Check for Safe-Settings failed with ${JSON.stringify(e)}`)
      })
  }

  logError (msg) {
    this.log.error(msg)
    this.errors.push({
      owner: this.repo.owner,
      repo: this.repo.repo,
      msg,
      plugin: this.constructor.name
    })
    // In NOP mode, also surface the error as an ERROR NopCommand so the NOP
    // check run conclusion reflects the failure. Without this, errors caught
    // by the syncAll/syncSelectedRepos top-level catch (e.g. invalid
    // disable_plugins entries) would go unnoticed by PR reviewers.
    if (this.nop) {
      const nopcommand = new NopCommand(this.constructor.name, this.repo, null, msg, 'ERROR')
      this.appendToResults([nopcommand])
    }
  }

  async handleResults () {
    const { payload } = this.context

    // Create a checkrun if not in nop mode
    if (!this.nop) {
      this.log.debug('Not run in nop')
      await this.createCheckRun()
      return
    }

    // Remove duplicate rows. The key includes endpoint + action.msg so that:
    // - per-operation NopCommands (individual add/update/remove from diffable
    //   plugins) survive alongside the overall diff-summary NopCommand, and
    // - distinct disable_plugins skip messages (each with a unique msg but
    //   the same empty endpoint) are all retained.
    this.results = this.results.filter((thing, index, self) => {
      return index === self.findIndex((t) => {
        return t.type === thing.type && t.repo === thing.repo && t.plugin === thing.plugin && t.endpoint === thing.endpoint && t.action?.msg === thing.action?.msg
      })
    })

    // When a base-branch config is available (NOP / dry-run on a PR), filter
    // out results that reflect pre-existing drift rather than changes the PR
    // actually introduces.
    if (this.baseConfig) {
      this.log.debug('Filtering NOP results using base config comparison')
      this.results = this.results.filter(res => {
        if (!res || res.type === 'ERROR') return true

        if (res.type === 'INFO' && res.action?.msg && res.action?.additions === null && res.action?.deletions === null && res.action?.modifications === null) {
          return true
        }

        const isOrgLevel = res.repo && res.repo.endsWith('(org)')
        const pluginSection = res.plugin ? res.plugin.toLowerCase() : null

        if (isOrgLevel && pluginSection === 'rulesets') {
          // Org-level rulesets: keep only rulesets whose definition changed.
          const changedNames = getChangedEntryNames(this.baseConfig.rulesets, this.config.rulesets)
          if (changedNames.size === 0) return false
          const filtered = filterActionByChangedNames(res.action, changedNames)
          if (!filtered) return false
          res.action = filtered
          return true
        }

        if (!isOrgLevel && pluginSection) {
          // Keep results for repos whose override/suborg config files changed.
          if (this.changedRepoNames && this.changedRepoNames.has(res.repo)) {
            return true
          }

          // Repo-level rulesets originate from override files, not the global
          // config — when no override changed for this repo it is drift.
          if (pluginSection === 'rulesets') {
            return false
          }

          // Other repo-level plugins: drop when the global config section for
          // this plugin is unchanged between base and PR.
          const baseSection = this.baseConfig[pluginSection]
          const prSection = this.config[pluginSection]
          if (baseSection !== undefined && prSection !== undefined) {
            if (JSON.stringify(baseSection) === JSON.stringify(prSection)) {
              return false
            }
          }
        }

        return true
      })
    }

    let error = false
    const stats = {
      reposProcessed: {},
      changes: {},
      errors: {},
      // Informational entries (type === 'INFO', all-null diff fields), e.g.
      // disable_plugins skip messages. Keyed by repo.
      infos: {}
    }
    this.results.forEach(res => {
      if (res) {
        stats.reposProcessed[res.repo] = true
        if (res.type === 'ERROR') {
          error = true
          if (!stats.errors[res.repo]) {
            stats.errors[res.repo] = []
          }
          const msg = res.action && (res.action.msg || res.action.message)
            ? (res.action.msg || res.action.message)
            : `${res.action}`
          stats.errors[res.repo].push({ msg })
        } else if (res.action?.additions === null && res.action?.deletions === null && res.action?.modifications === null) {
          // No diff data — informational message (e.g. disable_plugins skip).
          if (res.action?.msg) {
            if (!stats.infos[res.repo]) {
              stats.infos[res.repo] = []
            }
            stats.infos[res.repo].push(`[${res.plugin}] ${res.action.msg}`)
          }
        } else if (!isEmptyChange(res.action)) {
          if (!stats.changes[res.plugin]) {
            stats.changes[res.plugin] = {}
          }
          if (!stats.changes[res.plugin][res.repo]) {
            stats.changes[res.plugin][res.repo] = []
          }
          stats.changes[res.plugin][res.repo].push(res.action)
        }
      }
    })

    this.log.debug(`Stats ${JSON.stringify(this.results, null, 2)}`)

    stats.changeSections = buildChangeSections(stats.changes, this.baseConfig, this.config)
    stats.reposAffected = affectedRepoCount(stats.changeSections)
    stats.changeDetails = stats.changeSections.length > 0
      ? renderChangeSections(stats.changeSections).join('\n\n')
      : ''
    stats.checkRunDetails = stats.changeDetails.length > 50000
      ? 'Detailed changed-field output is available in the pull request comment.'
      : stats.changeDetails

    const renderedCommentMessage = await eta.renderString(commetMessageTemplate, stats)

    if (env.CREATE_PR_COMMENT === 'true') {
      const pluginSectionList = renderChangeSections(stats.changeSections)

      const errorRepos = Object.keys(stats.errors)
      const errorSection = errorRepos.length === 0
        ? '### Errors\n`None`'
        : `### Errors\n<details>\n<summary>:warning: Errors — ${errorRepos.length} ${pluralize(errorRepos.length, 'repo', 'repos')} affected</summary>\n\n${
          errorRepos.map(repo =>
            `**${repo}**:\n${stats.errors[repo].map(e => `* ${e.msg}`).join('\n')}`
          ).join('\n\n')
        }\n\n</details>`

      // Preserve disable_plugins informational messages in the PR comment.
      const infoRepos = Object.keys(stats.infos)
      const infoSection = infoRepos.length === 0
        ? ''
        : `### Informational messages\n<details>\n<summary>:information_source: Info — ${infoRepos.length} ${pluralize(infoRepos.length, 'repo', 'repos')}</summary>\n\n${
          infoRepos.map(repo =>
            `**${repo}**:\n${stats.infos[repo].map(msg => `* :information_source: ${msg}`).join('\n')}`
          ).join('\n\n')
        }\n\n</details>`

      const trailingSections = infoSection ? [errorSection, infoSection] : [errorSection]
      const bodySections = stats.changeSections.length === 0
        ? ['_No changes to apply._', ...trailingSections]
        : [...pluginSectionList, ...trailingSections]

      const repoCount = Object.keys(stats.reposProcessed).length
      const makeHeader = (page, total) => total > 1
        ? `#### :robot: Safe-Settings config changes detected (${page}/${total}):\n\n**Repos considered:** ${repoCount}\n**Repos affected:** ${stats.reposAffected}\n\n`
        : `#### :robot: Safe-Settings config changes detected:\n\n**Repos considered:** ${repoCount}\n**Repos affected:** ${stats.reposAffected}\n\n`

      // Reserve room for the largest possible header so pages never overflow
      // the comment limit regardless of the final page count.
      const headerOverhead = makeHeader(9999, 9999).length
      const bodyLimit = COMMENT_LIMIT - headerOverhead

      const pages = []
      let currentChunks = []
      let currentLength = 0
      const flushPage = () => {
        if (currentChunks.length > 0) {
          pages.push(currentChunks.join('\n\n'))
          currentChunks = []
          currentLength = 0
        }
      }
      for (const section of bodySections) {
        const sectionLength = section.length + 2
        if (currentChunks.length > 0 && currentLength + sectionLength > bodyLimit) {
          flushPage()
        }
        currentChunks.push(section)
        currentLength += sectionLength
      }
      flushPage()
      if (pages.length === 0) pages.push('')

      const totalPages = pages.length
      const pullRequest = payload.check_run.check_suite.pull_requests[0]

      for (let i = 0; i < pages.length; i++) {
        const body = `${makeHeader(i + 1, totalPages)}${pages[i]}`
        await this.github.issues.createComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          issue_number: pullRequest.number,
          body: truncateWithSuffix(body, COMMENT_LIMIT, '... (too many changes to report)')
        })
      }
    }

    const params = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      check_run_id: payload.check_run.id,
      status: 'completed',
      conclusion: error ? 'failure' : 'success',
      completed_at: new Date().toISOString(),
      output: {
        title: error ? 'Safe-Settings Dry-Run Finished with Error' : 'Safe-Settings Dry-Run Finished with success',
        summary: truncateWithSuffix(renderedCommentMessage, COMMENT_LIMIT, '... (too many changes to report)')
      }
    }

    this.log.debug(`Completing check run ${JSON.stringify(params)}`)
    await this.github.checks.update(params)
  }

  async loadConfigs (repo) {
    this.subOrgConfigs = await this.getSubOrgConfigs()
    this.repoConfigs = await this.getRepoConfigs(repo)
  }

  // ────────────────────────────────────────────────────────────────────────
  // disable_plugins helpers
  // ────────────────────────────────────────────────────────────────────────

  // Returns the set of plugin names that are valid `disable_plugins` targets.
  static getValidDisablePluginNames () {
    return new Set([...Object.keys(Settings.PLUGINS), 'repository', 'archive'])
  }

  // Normalize a raw `disable_plugins` list (mixed strings / objects) into
  // [{ plugin, target, declaredAt }]. Validates plugin names and target
  // values; throws on invalid entries. For declaredAt='repo', `children`
  // collapses to `all` (repo has no children).
  normalizeDisableEntries (rawList, declaredAt) {
    if (rawList === undefined || rawList === null) return []
    if (!Array.isArray(rawList)) {
      throw new Error(`disable_plugins at ${declaredAt} must be an array; got ${typeof rawList}`)
    }
    if (!DISABLE_LEVELS.includes(declaredAt)) {
      throw new Error(`Internal: invalid declaredAt '${declaredAt}'`)
    }
    const validPlugins = Settings.getValidDisablePluginNames()
    const normalized = []
    for (const raw of rawList) {
      let plugin
      let target = 'all'
      if (typeof raw === 'string') {
        plugin = raw
      } else if (raw && typeof raw === 'object') {
        plugin = raw.plugin
        if (raw.target !== undefined) target = raw.target
      } else {
        throw new Error(`disable_plugins entry at ${declaredAt} must be a string or {plugin, target}; got ${JSON.stringify(raw)}`)
      }
      if (!plugin || typeof plugin !== 'string') {
        throw new Error(`disable_plugins entry at ${declaredAt} is missing a valid 'plugin' name: ${JSON.stringify(raw)}`)
      }
      if (!validPlugins.has(plugin)) {
        throw new Error(`disable_plugins at ${declaredAt}: unknown plugin '${plugin}'. Valid: ${[...validPlugins].sort().join(', ')}`)
      }
      if (!DISABLE_TARGETS.has(target)) {
        throw new Error(`disable_plugins at ${declaredAt} for plugin '${plugin}': invalid target '${target}'. Valid: ${[...DISABLE_TARGETS].join(', ')}`)
      }
      if (declaredAt === 'repo' && target === 'children') {
        this.log.debug(`disable_plugins: normalizing repo-level target 'children' to 'all' for plugin '${plugin}' (repo has no children)`)
        target = 'all'
      }
      normalized.push({ plugin, target, declaredAt })
    }
    return normalized
  }

  // Aggregate disable_plugins entries from all four layers (deployment, org,
  // suborg matching repoName, repo override for repoName) and expand them via
  // the strip matrix into a Map<level, Set<pluginName>>. If repoName is
  // undefined, only deployment + org layers contribute (used by updateOrg).
  computeStripMap (repoName) {
    const stripMap = new Map()
    for (const level of DISABLE_LEVELS) stripMap.set(level, new Set())

    const layers = []
    // Deployment layer (singleton)
    const deploymentRaw = (DeploymentConfig && DeploymentConfig.config && DeploymentConfig.config.disable_plugins) || null
    if (deploymentRaw) layers.push(['deployment', deploymentRaw])
    // Org layer
    if (this.config && this.config.disable_plugins) {
      layers.push(['org', this.config.disable_plugins])
    }
    if (repoName !== undefined && repoName !== null) {
      const suborg = this.getSubOrgConfig(repoName)
      if (suborg && suborg.disable_plugins) {
        layers.push(['suborg', suborg.disable_plugins])
      }
      const repoOverride = this.getRepoOverrideConfig(repoName)
      if (repoOverride && repoOverride.disable_plugins) {
        layers.push(['repo', repoOverride.disable_plugins])
      }
    }

    for (const [declaredAt, rawList] of layers) {
      const entries = this.normalizeDisableEntries(rawList, declaredAt)
      for (const { plugin, target } of entries) {
        const affected = DISABLE_STRIP_MATRIX[declaredAt][target] || []
        for (const lvl of affected) {
          stripMap.get(lvl).add(plugin)
        }
      }
    }
    this.log.debug(`disable_plugins stripMap for repo=${repoName || '<org-exec>'}: ${JSON.stringify([...stripMap].map(([k, v]) => [k, [...v]]))}`)
    return stripMap
  }

  // True if the given plugin appears in ANY layer of the stripMap. Used by
  // gates around `repository` / `archive` (and updateOrg's rulesets /
  // custom_repository_roles) where the plugin runs per-org or per-repo and
  // there's no merge-time pipeline to strip into.
  isPluginDisabledAnywhere (stripMap, pluginName) {
    if (!stripMap) return false
    for (const set of stripMap.values()) {
      if (set.has(pluginName)) return true
    }
    return false
  }

  // Returns the declaredAt layer(s) responsible for disabling `pluginName`
  // in the given stripMap. Used to build informative NopCommand / log
  // messages. Note: stripMap layers are *target* layers, not declaration
  // layers — to report the source we re-walk the raw disable_plugins lists.
  whoDisabled (pluginName, repoName) {
    const sources = []
    const probe = (declaredAt, raw) => {
      if (!raw) return
      let entries = []
      try { entries = this.normalizeDisableEntries(raw, declaredAt) } catch { return }
      for (const e of entries) {
        if (e.plugin === pluginName) sources.push(`${declaredAt}(target=${e.target})`)
      }
    }
    probe('deployment', DeploymentConfig && DeploymentConfig.config && DeploymentConfig.config.disable_plugins)
    probe('org', this.config && this.config.disable_plugins)
    if (repoName !== undefined && repoName !== null) {
      const suborg = this.getSubOrgConfig(repoName)
      probe('suborg', suborg && suborg.disable_plugins)
      const repoOverride = this.getRepoOverrideConfig(repoName)
      probe('repo', repoOverride && repoOverride.disable_plugins)
    }
    return sources
  }

  // Apply strips to a `{ deployment, org, suborg, repo }` map of cloned
  // configs. Mutates clones in place and returns them. Emits NopCommand
  // entries when in nop mode.
  applyStrips (stripMap, sources, repoName) {
    if (!stripMap) return sources
    for (const [level, pluginSet] of stripMap) {
      const layer = sources[level]
      if (!layer) continue
      for (const plugin of pluginSet) {
        if (Object.prototype.hasOwnProperty.call(layer, plugin)) {
          delete layer[plugin]
          this.log.debug(`disable_plugins: stripped '${plugin}' from ${level} layer (repo=${repoName || '<org-exec>'})`)
          if (this.nop) {
            const declaredBy = this.whoDisabled(plugin, repoName).join(', ')
            const nopcommand = new NopCommand('disable_plugins', this.repo, null, `Plugin '${plugin}' stripped from ${level} layer (declared by: ${declaredBy || 'unknown'})`, 'INFO')
            this.appendToResults([nopcommand])
          }
        }
      }
    }
    return sources
  }

  // Emit a NopCommand recording that a per-execution-point plugin
  // (rulesets / custom_repository_roles / repository / archive) was skipped
  // because it appears in the stripMap.
  emitDisableSkip (pluginName, repoName) {
    if (!this.nop) return
    const declaredBy = this.whoDisabled(pluginName, repoName).join(', ')
    const nopcommand = new NopCommand('disable_plugins', this.repo, null, `Plugin '${pluginName}' skipped (declared by: ${declaredBy || 'unknown'})`, 'INFO')
    this.appendToResults([nopcommand])
  }

  async updateOrg () {
    // Org-execution stripMap: no repo context, so only deployment + org
    // disable_plugins contribute.
    const stripMap = this.computeStripMap()
    const additiveSet = this.normalizeAdditivePlugins()

    const rulesetsConfig = this.config.rulesets
    if (rulesetsConfig) {
      if (this.isPluginDisabledAnywhere(stripMap, 'rulesets')) {
        this.log.debug("disable_plugins: skipping org-level 'rulesets' plugin")
        this.emitDisableSkip('rulesets')
      } else {
        const RulesetsPlugin = Settings.PLUGINS.rulesets
        const rulesetsPlugin = new RulesetsPlugin(this.nop, this.github, this.repo, rulesetsConfig, this.log, this.errors, SCOPE.ORG)
        rulesetsPlugin.additive = additiveSet.has('rulesets')
        await rulesetsPlugin.sync().then(res => {
          if (this.nop && Array.isArray(res)) {
            res.forEach(r => { if (r) r.repo = `${this.repo.owner} (org)` })
          }
          this.appendToResults(res)
        })
      }
    }

    const customRepositoryRolesConfig = this.config.custom_repository_roles
    if (customRepositoryRolesConfig) {
      if (this.isPluginDisabledAnywhere(stripMap, 'custom_repository_roles')) {
        this.log.debug("disable_plugins: skipping org-level 'custom_repository_roles' plugin")
        this.emitDisableSkip('custom_repository_roles')
      } else {
        const CustomRepositoryRolesPlugin = Settings.PLUGINS.custom_repository_roles
        const customRepositoryRolesPlugin = new CustomRepositoryRolesPlugin(this.nop, this.github, this.repo, customRepositoryRolesConfig, this.log, this.errors)
        customRepositoryRolesPlugin.additive = additiveSet.has('custom_repository_roles')
        await customRepositoryRolesPlugin.sync().then(res => {
          this.appendToResults(res)
        })
      }
    }
  }

  async updateRepos (repo) {
    this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs()
    // Snapshot the set of suborg `source` paths that match this repo *before*
    // we apply any changes. We compare against the post-apply set below to
    // decide whether to re-evaluate (and to break stable loops).
    const preMatchedSuborgSources = this.reevaluateOnChange
      ? this.getAllMatchingSubOrgSources(repo.repo)
      : null
    // Keeping this as is instead of doing an object assign as that would cause `Cannot read properties of undefined (reading 'startsWith')` error
    // Copilot code review would recoommend using object assign but that would cause the error
    let repoConfig = this.config.repository
    if (repoConfig) {
      repoConfig = Object.assign(repoConfig, { name: repo.repo, org: repo.owner })
    }

    const subOrgConfig = this.getSubOrgConfig(repo.repo)

    // If suborg config has been updated then only restrict to the repos for that suborg
    if (this.subOrgConfigMap && !subOrgConfig) {
      this.log.debug(`Skipping... SubOrg config changed but this repo is not part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)
      return
    }

    this.log.debug(`Process normally... Not a SubOrg config change or SubOrg config was changed and this repo is part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)

    if (subOrgConfig) {
      let suborgRepoConfig = subOrgConfig.repository
      if (suborgRepoConfig) {
        suborgRepoConfig = Object.assign(suborgRepoConfig, { name: repo.repo, org: repo.owner })
        repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, suborgRepoConfig)
      }
    }

    // Overlay repo config
    // RepoConfigs should be preloaded but checking anyway
    const overrideRepoConfig = this.repoConfigs[`${repo.repo}.yml`]?.repository || this.repoConfigs[`${repo.repo}.yaml`]?.repository
    if (overrideRepoConfig) {
      repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, overrideRepoConfig)
    }
    if (repoConfig) {
      // Per-repo disable_plugins stripMap (used to gate repository + archive
      // plugins, which run per-repo outside the childPluginsList pipeline).
      const repoStripMap = this.computeStripMap(repo.repo)
      const repositoryDisabled = this.isPluginDisabledAnywhere(repoStripMap, 'repository')
      const archiveDisabled = this.isPluginDisabledAnywhere(repoStripMap, 'archive')

      // Track actual change signals from the plugins, used by the suborg
      // re-evaluation logic below to avoid an unnecessary live API round-trip
      // when nothing relevant actually changed.
      const changeSignals = { teamsChanged: false, propertiesChanged: false, renamed: false, created: false }
      try {
        this.log.debug(`found a matching repoconfig for this repo ${JSON.stringify(repoConfig)}`)

        // Run tech asset enrichment FIRST to validate and enrich the config
        // before other plugins process it
        if (repoConfig.tech_asset_enrichment) {
          const TechAssetEnrichment = Settings.PLUGINS.tech_asset_enrichment
          const enrichmentPlugin = new TechAssetEnrichment(
            this.nop,
            this.github,
            repo,
            repoConfig,
            this.log,
            this.errors
          )
          const enrichmentResults = await enrichmentPlugin.sync()
          this.appendToResults(enrichmentResults)
          // repoConfig is now enriched with additional custom properties
        }

        const childPlugins = this.childPluginsList(repo)
        const RepoPlugin = Settings.PLUGINS.repository

        let archivePlugin = null
        let shouldArchive = false
        let shouldUnarchive = false
        if (archiveDisabled) {
          this.log.debug(`disable_plugins: skipping 'archive' plugin for ${repo.repo}`)
          this.emitDisableSkip('archive', repo.repo)
        } else {
          archivePlugin = new Archive(this.nop, this.github, repo, repoConfig, this.log)
          const state = await archivePlugin.getState()
          shouldArchive = state.shouldArchive
          shouldUnarchive = state.shouldUnarchive
        }

        if (shouldUnarchive) {
          this.log.debug(`Unarchiving repo ${repo.repo}`)
          const unArchiveResults = await archivePlugin.sync()
          this.appendToResults(unArchiveResults)
        }

        if (repositoryDisabled) {
          this.log.debug(`disable_plugins: skipping 'repository' plugin for ${repo.repo}`)
          this.emitDisableSkip('repository', repo.repo)
        } else {
          const repoPluginInstance = new RepoPlugin(this.nop, this.github, repo, repoConfig, this.installation_id, this.log, this.errors)
          const repoResults = await repoPluginInstance.sync()
          this.appendToResults(repoResults)
          if (repoPluginInstance.renamed) changeSignals.renamed = true
          if (repoPluginInstance.created) changeSignals.created = true
        }

        const additiveSet = this.normalizeAdditivePlugins()
        const childPluginInstances = childPlugins.map(([Plugin, config, section]) => {
          const instance = new Plugin(this.nop, this.github, repo, config, this.log, this.errors)
          instance.additive = additiveSet.has(section)
          return [Plugin, instance]
        })
        const childResults = await Promise.all(
          childPluginInstances.map(([, instance]) => instance.sync())
        )
        this.appendToResults(childResults)

        // Collect change signals from relevant child plugins.
        for (const [Plugin, instance] of childPluginInstances) {
          if (!instance.hasChanges) continue
          if (Plugin === Settings.PLUGINS.teams) changeSignals.teamsChanged = true
          if (Plugin === Settings.PLUGINS.custom_properties) changeSignals.propertiesChanged = true
        }

        if (shouldArchive) {
          this.log.debug(`Archiving repo ${repo.repo}`)
          const archiveResults = await archivePlugin.sync()
          this.appendToResults(archiveResults)
        }
      } catch (e) {
        if (this.nop) {
          const nopcommand = new NopCommand(this.constructor.name, this.repo, null, `${e}`, 'ERROR')
          this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
          this.appendToResults([nopcommand])
          // throw e
        } else {
          throw e
        }
      }

      // Suborg re-evaluation: if a repo-yml change actually applied teams or
      // custom_properties (or this repo was just renamed/created), the repo
      // may newly match or stop matching a suborg config
      // (suborgteams/suborgproperties/suborgrepos). Refresh the suborg cache,
      // compare matched-source sets; if the set changed, re-run updateRepos
      // once for this repo. Bounded by
      // MAX_REEVALUATION_DEPTH and a stable-set check to prevent loops.
      await this.maybeReevaluateSuborg(repo, repoConfig, preMatchedSuborgSources, changeSignals)
    } else {
      this.log.debug(`Didnt find any a matching repoconfig for this repo ${JSON.stringify(repo)} in ${JSON.stringify(this.repoConfigs)}`)
      const childPlugins = this.childPluginsList(repo)
      const additiveSet = this.normalizeAdditivePlugins()
      return Promise.all(childPlugins.map(([Plugin, config, section]) => {
        const instance = new Plugin(this.nop, this.github, repo, config, this.log, this.errors)
        instance.additive = additiveSet.has(section)
        return instance.sync().then(res => {
          this.appendToResults(res)
        })
      }))
    }
  }

  async updateAll () {
    // this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs(this.github, this.repo, this.log)
    // this.repoConfigs = this.repoConfigs || await this.getRepoConfigs(this.github, this.repo, this.log)
    return this.eachRepositoryRepos(this.github, this.log).then(res => {
      this.appendToResults(res)
    })
  }

  async updateChangedRepoConfigs (changedRepos = []) {
    if (!Array.isArray(changedRepos) || changedRepos.length === 0) return

    const seen = new Set()
    for (const repo of changedRepos) {
      if (!repo || !repo.repo || seen.has(repo.repo)) continue
      seen.add(repo.repo)
      if (this.processedRepoNames.has(repo.repo)) continue
      await this.checkAndProcessRepo(repo.owner || this.repo.owner, repo.repo)
    }
  }

  getSubOrgConfig (repoName) {
    if (this.subOrgConfigs) {
      for (const pattern of Object.keys(this.subOrgConfigs)) {
        const glob = new Glob(pattern)
        if (glob.test(repoName)) {
          return this.subOrgConfigs[pattern]
        }
      }
    }
    return undefined
  }

  // Read-only helper used for suborg re-evaluation stability checks.
  // Returns the set of suborg `source` paths (i.e. the suborg config file path)
  // that match the given repo name. Apply-time behavior is unchanged:
  // `getSubOrgConfig` still returns the first match and
  // `storeSubOrgConfigIfNoConflicts` still forbids multi-suborg overlap at
  // config-load time -- so this set normally contains 0 or 1 entries. We
  // expose it as a Set so callers can detect the transition from {} -> {pathA}
  // when a repo newly matches a suborg after teams/properties are applied.
  getAllMatchingSubOrgSources (repoName) {
    const sources = new Set()
    if (!this.subOrgConfigs) {
      return sources
    }
    for (const pattern of Object.keys(this.subOrgConfigs)) {
      const glob = new Glob(pattern)
      if (glob.test(repoName)) {
        const source = this.subOrgConfigs[pattern]?.source
        if (source) {
          sources.add(source)
        }
      }
    }
    return sources
  }

  // Force a refresh of the cached suborg configs. Used by the re-eval loop
  // because suborgteams / suborgproperties resolution calls live GitHub APIs
  // and may now match the repo after teams/properties were applied in the
  // first pass.
  async reloadSubOrgConfigs () {
    this.subOrgConfigs = await this.getSubOrgConfigs()
  }

  // Decide whether applying this repo's config actually changed state that
  // could affect suborg matching. If no relevant change happened, skip the
  // re-eval API roundtrip entirely.
  //
  // Preferred path: use plugin-emitted change signals from the just-completed
  // sync (teams plugin actually added/removed/updated, custom_properties
  // plugin changed values, repository plugin renamed/created). These come
  // from the Diffable base class (`plugin.hasChanges`) and the Repository
  // plugin (`renamed`, `created`).
  //
  // Fallback (changeSignals omitted, e.g. unit tests calling the helper in
  // isolation): inspect the per-repo yml top-level shape for teams /
  // custom_properties / rename indicators.
  shouldConsiderReevaluation (repo, repoConfig, changeSignals) {
    if (changeSignals) {
      return !!(
        changeSignals.teamsChanged ||
        changeSignals.propertiesChanged ||
        changeSignals.renamed ||
        changeSignals.created
      )
    }
    const repoYml = this.repoConfigs && (
      this.repoConfigs[`${repo.repo}.yml`] || this.repoConfigs[`${repo.repo}.yaml`]
    )
    if (repoYml) {
      if (Array.isArray(repoYml.teams) && repoYml.teams.length > 0) return true
      if (Array.isArray(repoYml.custom_properties) && repoYml.custom_properties.length > 0) return true
    }
    if (repo && repo.oldname && repo.oldname !== repo.repo) return true
    if (repoConfig && repoConfig.oldname && repoConfig.oldname !== repoConfig.name) return true
    return false
  }

  // After applying changes to a repo, decide whether to re-run updateRepos
  // because the applied changes may have changed whether the repo matches a
  // suborg config. Loop prevention has two layers:
  //   1. Hard cap: MAX_REEVALUATION_DEPTH (=1) re-evaluation passes per repo.
  //   2. Stability check: stop if the set of matched suborg sources did not
  //      grow (no new suborg source appeared since the last pass).
  async maybeReevaluateSuborg (repo, repoConfig, preMatchedSuborgSources, changeSignals) {
    if (!this.reevaluateOnChange) return
    if (!preMatchedSuborgSources) return
    if (!this.shouldConsiderReevaluation(repo, repoConfig, changeSignals)) {
      this.log.debug(`Suborg re-eval: skipping for ${repo.repo} (no relevant changes from teams/custom_properties/repository plugins)`)
      return
    }

    const depth = this.reevaluationDepth.get(repo.repo) || 0
    if (depth >= MAX_REEVALUATION_DEPTH) {
      this.log.warn(`Suborg re-eval: max depth (${MAX_REEVALUATION_DEPTH}) reached for ${repo.repo}; stopping. Any further suborg matches will be picked up on the next sync.`)
      return
    }

    // Refresh suborg config cache; suborgteams/suborgproperties resolution
    // hits live GitHub APIs and may now match this repo.
    await this.reloadSubOrgConfigs()

    const newMatched = this.getAllMatchingSubOrgSources(repo.repo)

    // Stability check: if the source set did not change, we're done. A change
    // can be either a newly matched suborg or a removed match after teams or
    // custom_properties changed.
    let hasChanged = preMatchedSuborgSources.size !== newMatched.size
    if (!hasChanged) {
      for (const source of newMatched) {
        if (!preMatchedSuborgSources.has(source)) {
          hasChanged = true
          break
        }
      }
    }
    if (!hasChanged) {
      this.log.debug(`Suborg re-eval: stable for ${repo.repo} (matched sources: ${JSON.stringify(Array.from(newMatched))}); stopping.`)
      return
    }

    this.reevaluatedRepos.set(repo.repo, new Set([...preMatchedSuborgSources, ...newMatched]))
    this.reevaluationDepth.set(repo.repo, depth + 1)
    this.log.debug(`Suborg re-eval: suborg sources changed for ${repo.repo} after apply; re-running updateRepos (depth=${depth + 1}).`)

    // Reload repo-level configs for this repo so the next pass picks up any
    // state changes; then recurse. Depth cap above prevents infinite loops.
    this.repoConfigs = await this.getRepoConfigs(repo)
    await this.updateRepos(repo)
  }

  // Remove Org specific configs from the repo config
  returnRepoSpecificConfigs (config) {
    const newConfig = Object.assign({}, config) // clone
    delete newConfig.rulesets
    delete newConfig.custom_repository_roles
    delete newConfig.disable_plugins
    delete newConfig.additive_plugins
    return newConfig
  }

  // Shallow-clone a config object and strip metadata keys (`disable_plugins`,
  // `additive_plugins`) that are policy controls, not plugin section config.
  cloneAndStripDisableMeta (config) {
    if (!config) return {}
    const clone = Object.assign({}, config)
    delete clone.disable_plugins
    delete clone.additive_plugins
    return clone
  }

  // Parse and validate the `additive_plugins` list from the org-level config.
  // Returns a Set<string> of plugin names that should run in additive mode
  // (remove() calls suppressed). Logs an error for unknown or non-Diffable
  // plugin names and excludes them from the returned set.
  normalizeAdditivePlugins () {
    const raw = (this.config && this.config.additive_plugins) || []
    if (!Array.isArray(raw)) {
      this.logError(`additive_plugins must be an array; got ${typeof raw}`)
      return new Set()
    }
    const validPlugins = Settings.ADDITIVE_PLUGINS
    const result = new Set()
    for (const name of raw) {
      if (typeof name !== 'string') {
        this.logError(`additive_plugins: each entry must be a string plugin name; got ${JSON.stringify(name)}`)
        continue
      }
      if (!validPlugins.has(name)) {
        this.logError(`additive_plugins: unknown or non-Diffable plugin '${name}'. Valid: ${[...validPlugins].sort().join(', ')}`)
        continue
      }
      result.add(name)
    }
    return result
  }

  childPluginsList (repo) {
    const repoName = repo.repo
    const subOrgOverrideConfig = this.getSubOrgConfig(repoName)
    this.log.debug(`suborg config for ${repoName} is ${JSON.stringify(subOrgOverrideConfig)}`)
    const repoOverrideConfig = this.getRepoOverrideConfig(repoName)

    // Build clones of each layer and apply disable_plugins strips before the
    // existing mergeDeep pipeline runs. The deployment layer's strips affect
    // the OTHER three layers (per the matrix); the deployment config itself
    // is not merged into per-repo plugin config today.
    const stripMap = this.computeStripMap(repoName)
    const sources = {
      deployment: this.cloneAndStripDisableMeta((DeploymentConfig && DeploymentConfig.config) || {}),
      org: this.returnRepoSpecificConfigs(this.config),
      suborg: this.cloneAndStripDisableMeta(subOrgOverrideConfig),
      repo: this.cloneAndStripDisableMeta(repoOverrideConfig)
    }
    this.applyStrips(stripMap, sources, repoName)

    const overrideConfig = this.mergeDeep.mergeDeep({}, sources.org, sources.suborg, sources.repo)

    this.log.debug(`consolidated config is ${JSON.stringify(overrideConfig)}`)

    const childPlugins = []
    for (const [section, config] of Object.entries(overrideConfig)) {
      const baseConfig = this.config[section]
      if (Array.isArray(baseConfig) && Array.isArray(config)) {
        for (const baseEntry of baseConfig) {
          const newEntry = config.find(e => e.name === baseEntry.name)
          this.validate(section, baseEntry, newEntry)
        }
      } else {
        this.validate(section, baseConfig, config)
      }
      if (section !== 'repositories' && section !== 'repository') {
        // Ignore any config that is not a plugin
        if (section in Settings.PLUGINS) {
          this.log.debug(`Found section ${section} in the config. Creating plugin...`)
          const Plugin = Settings.PLUGINS[section]
          // Include sectionName as 3rd element so callers can thread the
          // additive_plugins flag without re-deriving the plugin key.
          childPlugins.push([Plugin, config, section])
        }
      }
    }
    return childPlugins
  }

  getRepoOverrideConfig (repoName) {
    return this.repoConfigs[`${repoName}.yml`] || this.repoConfigs[`${repoName}.yaml`] || {}
  }

  validate (section, baseConfig, overrideConfig) {
    const configValidator = this.configvalidators[section]
    if (configValidator) {
      this.log.debug(`Calling configvalidator for key ${section} `)
      if (!configValidator.isValid(overrideConfig, this.github)) {
        this.log.error(`Error in calling configvalidator for key ${section} ${configValidator.error}`)
        throw new Error(configValidator.error)
      }
    }
    const overridevalidator = this.overridevalidators[section]
    if (overridevalidator) {
      this.log.debug(`Calling overridevalidator for key ${section} `)
      if (!overridevalidator.canOverride(baseConfig, overrideConfig, this.github)) {
        this.log.error(`Error in calling overridevalidator for key ${section} ${overridevalidator.error}`)
        throw new Error(overridevalidator.error)
      }
    }
  }

  isRestricted (repoName) {
    const restrictedRepos = this.config.restrictedRepos
    // Skip configuring any restricted repos
    if (Array.isArray(restrictedRepos)) {
      if (this.includesRepo(repoName, restrictedRepos)) {
        this.log.debug(`Skipping retricted repo ${repoName}`)
        return true
      } else {
        this.log.debug(`${repoName} not in restricted repos ${restrictedRepos}`)
        return false
      }
    } else if (Array.isArray(restrictedRepos.include)) {
      if (this.includesRepo(repoName, restrictedRepos.include)) {
        this.log.debug(`Allowing ${repoName} in restrictedRepos.include [${restrictedRepos.include}]`)
        return false
      } else {
        this.log.debug(`Skipping repo ${repoName} not in restrictedRepos.include`)
        return true
      }
    } else if (Array.isArray(restrictedRepos.exclude)) {
      if (this.includesRepo(repoName, restrictedRepos.exclude)) {
        this.log.debug(`Skipping excluded repo ${repoName} in restrictedRepos.exclude`)
        return true
      } else {
        this.log.debug(`Allowing ${repoName} not in restrictedRepos.exclude [${restrictedRepos.exclude}]`)
        return false
      }
    }
    return false
  }

  includesRepo (repoName, restrictedRepos) {
    return restrictedRepos.map((restrictedRepo) => new Glob(restrictedRepo).test(repoName)).includes(true)
  }

  async eachRepositoryRepos (github, log) {
    log.debug('Fetching repositories')
    return github.paginate('GET /installation/repositories').then(repositories => {
      return Promise.all(repositories.map(repository => {
        const { owner, name } = repository
        return this.checkAndProcessRepo(owner.login, name)
      })
      )
    })
  }

  async checkAndProcessRepo (owner, name) {
    this.processedRepoNames.add(name)
    if (this.isRestricted(name)) {
      return null
    }
    return this.updateRepos({ owner, repo: name })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadConfigMap (params) {
    try {
      this.log.debug(` In loadConfigMap ${JSON.stringify(params)}`)
      const response = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!response) {
        return []
      }
      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        // const overrides = new Map()
        const overrides = response.data.map(d => { return { name: d.name, path: d.path } })
        // response.data.forEach(d =>  overrides.set(d.name, d.path))
        return overrides
      }
      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }
      const yaml = require('js-yaml')
      return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand('settings', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getRepoConfigMap () {
    try {
      this.log.debug(` In getRepoConfigMap ${JSON.stringify(this.repo)}`)
      // GitHub getContent api has a hard limit of returning 1000 entries without
      // any pagination. They suggest to use Tree api.
      // https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content

      // get <CONFIG_PATH>/repos directory sha to use in the getTree api
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH), ref: this.ref })
      const githubDirectoryContentResponse = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!githubDirectoryContentResponse) {
        throw new Error(`Error reading ${CONFIG_PATH} directory`)
      }

      const githubDirContent = githubDirectoryContentResponse.data
      const repoDirInfo = githubDirContent.filter(dir => dir.name === 'repos')[0]
      if (!repoDirInfo) {
        this.log.debug(`No repos directory in the ${env.ADMIN_REPO}/${CONFIG_PATH}`)
        return []
      }

      // read the repo contents using tree
      this.log.debug(`repos directory info ${JSON.stringify(repoDirInfo)}`)
      // const endpoint = `/repos/${this.repo.owner}/${repo.repo}/git/trees/${repoDirInfo.sha}`
      // this.log.debug(`endpoint: ${endpoint}`)
      const treeParams = Object.assign(repo, { tree_sha: repoDirInfo.sha, recursive: 0 })
      const response = await this.github.git.getTree(treeParams).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(this.github.git.getTree.endpoint(treeParams))} ${e}`)
      })

      if (!response || !response.data) {
        this.log.debug('repos directory exist but reading the tree failed')
        throw new Error('exception while reading the repos directory')
      }
      // throw error if truncated is true.
      if (response.data.truncated) {
        this.log.debug('not all repo files in  directory are read')
        throw new Error('not all repo files in  directory are read')
      }
      const treeInfo = response.data.tree
      // we emulated the existing loadConfigMap function as is by returning the
      // the same overrides list. This way the overall changes are minimal
      const overrides = treeInfo.map(d => { return { name: d.path, path: path.posix.join(CONFIG_PATH, 'repos', d.path) } })
      this.log.debug('Total overrides found in getRepoConfigMap are ' + overrides.length)
      return overrides
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getRepoConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigMap () {
    try {
      this.log.debug(` In getSubOrgConfigMap ${JSON.stringify(this.repo)}`)
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH, 'suborgs'), ref: this.ref })

      const response = await this.loadConfigMap(params)
      return response
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * If repo param is null load configs for all repos
   * If repo param is null and suborg change, load configs for suborg repos only
   * If repo partam is not null, load the config for a specific repo
   * @param {*} repo repo param
   * @returns repoConfigs object
   */
  async getRepoConfigs (repo) {
    try {
      const overridePaths = await this.getRepoConfigMap()
      const repoConfigs = {}

      for (const override of overridePaths) {
        // Don't load if already loaded
        if (repoConfigs[override.name]) {
          continue
        }
        // If repo is passed get only its config
        // else load all the config
        if (repo) {
          if (override.name === `${repo.repo}.yml` || override.name === `${repo.repo}.yaml`) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else if (this.suborgChange) {
          // If suborg change, only load repos that are part of the suborg
          if (this.getSubOrgConfig(override.name.split('.')[0])) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else {
          const data = await this.loadYaml(override.path)
          this.log.debug(`data = ${JSON.stringify(data)}`)
          repoConfigs[override.name] = data
        }
      }
      this.log.debug(`repo configs = ${JSON.stringify(repoConfigs)}`)
      return repoConfigs
    } catch (e) {
      if (this.nop) {
        this.log.error(e)
        const nopcommand = new NopCommand('getRepoConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigs () {
    try {
      // Get all suborg configs even though we might be here becuase of a suborg config change
      // we will filter them out if request is due to a suborg config change
      const overridePaths = await this.getSubOrgConfigMap()
      const subOrgConfigs = {}

      for (const override of overridePaths) {
        const data = await this.loadYaml(override.path)
        this.log.debug(`data = ${JSON.stringify(data)}`)

        if (!data) { return subOrgConfigs }

        subOrgConfigs[override.name] = data
        if (data.suborgrepos) {
          data.suborgrepos.forEach(repository => {
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repository, data)

            // In case support for multiple suborg configs for the same repo is required, merge the configs.
            //
            // Planned for the future to support multiple suborgrepos for the same repo
            //
            // if (existingConfigForRepo) {
            //   subOrgConfigs[repository] = this.mergeDeep.mergeDeep({}, existingConfigForRepo, data)
            // } else {
            //   subOrgConfigs[repository] = data
            // }

            subOrgConfigs[repository] = Object.assign({}, data, { source: override.path })
          })
        }
        if (data.suborgteams) {
          const promises = data.suborgteams.map((teamslug) => {
            return this.getReposForTeam(teamslug)
          })
          await Promise.all(promises).then(res => {
            res.forEach(r => {
              r.forEach(e => {
                this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, e.name, data)
              })
            })
          })
        }
        if (data.suborgproperties) {
          const subOrgRepositories = await this.getSubOrgRepositories(data.suborgproperties)
          subOrgRepositories.forEach(repo =>
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repo.repository_name, data)
          )
        }
      }

      // If this was result of a suborg config change, only return the repos that are part of the suborg config
      if (this.subOrgConfigMap) {
        this.log.debug(`SubOrg config was changed and the associated overridePaths is = ${JSON.stringify(this.subOrgConfigMap)}`)
        // enumerate the properties of the subOrgConfigs object and delete the ones that are not part of the suborg
        for (const [key, value] of Object.entries(subOrgConfigs)) {
          if (!this.subOrgConfigMap.some((overridePath) => {
            return overridePath.path === value.source
          }
          )) {
            delete subOrgConfigs[key]
          }
        }
      }
      return subOrgConfigs
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  storeSubOrgConfigIfNoConflicts (subOrgConfigs, overridePath, repoName, data) {
    const existingConfigForRepo = subOrgConfigs[repoName]
    if (existingConfigForRepo && existingConfigForRepo.source !== overridePath) {
      throw new Error(`Multiple suborg configs for ${repoName} in ${overridePath} and ${existingConfigForRepo?.source}`)
    }
    subOrgConfigs[repoName] = Object.assign({}, data, { source: overridePath })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadYaml (filePath) {
    try {
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, {
        path: filePath,
        ref: this.ref
      })
      const namespacedFilepath = `${this.repo.owner}/${filePath}`

      // If the filepath already exists in the fileCache, add the etag to the params
      // to check if the file has changed
      if (Settings.fileCache[namespacedFilepath]) {
        params.headers = {
          'If-None-Match': Settings.fileCache[namespacedFilepath].etag
        }
      }

      const response = await this.github.repos.getContent(params).catch(e => {
        if (e.status === 304) {
          this.log.debug(`Cache hit for file ${filePath}`)
          return {
            ...Settings.fileCache[namespacedFilepath],
            cached: true
          }
        }
        this.log.error(`Error getting settings ${e}`)
        throw e
      })

      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        return null
      }

      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }

      const content = yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}

      // Cache the content, as its either new or changed
      if (!response.cached) {
        this.log.debug(`Cache miss for file ${filePath}`)
        Settings.fileCache[namespacedFilepath] = {
          etag: response.headers.etag,
          data: response.data
        }
      }

      return content
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand(filePath, this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  appendToResults (res) {
    if (!this.nop || !res) {
      return
    }

    const input = (!Array.isArray(res) && this.isObject(res)) ? [res] : res
    const results = input.flat(3).filter(Boolean)

    this.results = this.results.concat(results)
  }

  async getReposForTeam (teamslug) {
    const options = this.github.rest.teams.listReposInOrg.endpoint.merge({
      org: this.repo.owner,
      team_slug: teamslug,
      per_page: 100
    })
    return this.github.paginate(options)
  }

  async getRepositoriesByProperty (organizationName, propertyFilter) {
    if (!organizationName || !propertyFilter) {
      throw new Error('Organization name and property filter are required')
    }

    const [name] = Object.keys(propertyFilter)
    const value = propertyFilter[name]

    try {
      const query = `props.${name}:${value}`
      const encodedQuery = encodeURIComponent(query)
      const options = this.github.request.endpoint((`/orgs/${organizationName}/properties/values?repository_query=${encodedQuery}`))
      return this.github.paginate(options)
    } catch (error) {
      throw new Error(`Failed to filter repositories for property ${name}: ${error.message}`)
    }
  }

  async getSubOrgRepositories (subOrgProperties) {
    const organizationName = this.repo.owner
    try {
      const repositories = await Promise.all(
        subOrgProperties.map(property =>
          this.getRepositoriesByProperty(organizationName, property)
        )
      )

      // Deduplicate repositories based on repository_name
      const uniqueRepos = repositories
        .flat()
        .reduce((unique, repo) => {
          unique.set(repo.repository_name, repo)
          return unique
        }, new Map())

      const result = Array.from(uniqueRepos.values())

      return result
    } catch (error) {
      throw new Error(`Failed to fetch suborg repositories: ${error.message}`)
    }
  }

  isObject (item) {
    return (item && typeof item === 'object' && !Array.isArray(item))
  }

  isIterable (obj) {
    // checks for null and undefined
    if (obj == null) {
      return false
    }
    return typeof obj[Symbol.iterator] === 'function'
  }
}

Settings.FILE_NAME = path.posix.join(CONFIG_PATH, env.SETTINGS_FILE_PATH)
Settings.FILE_PATH = path.posix.join(CONFIG_PATH, env.SETTINGS_FILE_PATH)
Settings.SUB_ORG_PATTERN = new Glob(`${CONFIG_PATH}/suborgs/*.yml`)
Settings.REPO_PATTERN = new Glob(`${CONFIG_PATH}/repos/*.yml`)

// Plugin names that support additive_plugins (all extend Diffable and have
// a meaningful remove() concept). Non-Diffable plugins (repository, archive,
// branches, validator) are intentionally excluded — listing them in
// additive_plugins will produce a validation error.
Settings.ADDITIVE_PLUGINS = new Set([
  'labels',
  'collaborators',
  'teams',
  'milestones',
  'autolinks',
  'environments',
  'custom_properties',
  'variables',
  'rulesets',
  'custom_repository_roles'
])

Settings.PLUGINS = {
  repository: require('./plugins/repository'),
  labels: require('./plugins/labels'),
  collaborators: require('./plugins/collaborators'),
  teams: require('./plugins/teams'),
  milestones: require('./plugins/milestones'),
  branches: require('./plugins/branches'),
  autolinks: require('./plugins/autolinks'),
  validator: require('./plugins/validator'),
  rulesets: require('./plugins/rulesets'),
  environments: require('./plugins/environments'),
  custom_properties: require('./plugins/custom_properties.js'),
  custom_repository_roles: require('./plugins/custom_repository_roles'),
  variables: require('./plugins/variables'),
  tech_asset_enrichment: require('./plugins/tech_asset_enrichment')
}

module.exports = Settings
module.exports.isEmptyChange = isEmptyChange
module.exports.isDeepEmpty = isDeepEmpty
module.exports.getChangedEntryNames = getChangedEntryNames
module.exports.filterActionByChangedNames = filterActionByChangedNames
