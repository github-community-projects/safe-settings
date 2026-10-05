/**
 * Smart Array Merge Examples
 * 
 * This example demonstrates the intelligent array merging behavior of mergeConfigs
 * when using replaceArrays=false mode:
 * 
 * 1. Simple Arrays (primitives): Automatically deduplicates items
 *    - Example: ['team-a', 'team-b'] + ['team-b', 'team-c'] → ['team-a', 'team-b', 'team-c']
 * 
 * 2. Object Arrays: Matches objects by identifying properties (username, name, etc.)
 *    and merges matching items while appending new ones
 *    - Example: Collaborator 'alice' with permission 'push' gets updated to 'admin'
 *    - Example: New collaborator 'charlie' gets appended
 * 
 * 3. Real-World Hub-Sync: Global settings intelligently merge with org-specific overrides
 *    - Object properties from org settings override global settings
 *    - Arrays are smart-merged (not duplicated or lost)
 * 
 * This is ideal for configuration management where you want to layer settings
 * without losing data or creating duplicates.
 */

const { mergeConfigs } = require('../lib/hubSyncHandler')

console.log('='.repeat(60))
console.log('Smart Array Merge Examples')
console.log('='.repeat(60))

// Example 1: Simple array deduplication
console.log('\n1. Simple Team Array - Deduplication')
console.log('-'.repeat(60))

const teams1 = `
teams:
  - team-a
  - team-b
`

const teams2 = `
teams:
  - team-b
  - team-c
`

console.log('Config 1:', JSON.stringify({ teams: ['team-a', 'team-b'] }))
console.log('Config 2:', JSON.stringify({ teams: ['team-b', 'team-c'] }))
console.log('\nResult (smart merge):')
console.log(JSON.stringify(mergeConfigs(teams1, teams2, false), null, 2))

// Example 2: Complex object array with matching
console.log('\n2. Collaborators Array - Match and Merge by Username')
console.log('-'.repeat(60))

const collab1 = `
collaborators:
  - username: alice
    permission: push
  - username: bob
    permission: pull
`

const collab2 = `
collaborators:
  - username: alice
    permission: admin
  - username: charlie
    permission: push
`

console.log('Config 1:')
console.log(collab1.trim())
console.log('\nConfig 2:')
console.log(collab2.trim())
console.log('\nResult (alice updated to admin, bob kept, charlie added):')
console.log(JSON.stringify(mergeConfigs(collab1, collab2, false), null, 2))

// Example 3: Real-world hub-sync scenario
console.log('\n3. Real-World Hub-Sync Settings Merge')
console.log('-'.repeat(60))

const globalSettings = `
repository:
  description: "Global default description"
  private: true
  has_issues: true

collaborators:
  - username: global-admin
    permission: admin
  - username: regpaco
    permission: push

teams:
  - core
  - docs
`

const orgSettings = `
repository:
  description: "Org-specific override"
  has_wiki: true

collaborators:
  - username: regpaco
    permission: admin
  - username: beetlejuice
    permission: pull

teams:
  - docs
  - globalteam
`

console.log('Global Settings has: global-admin (admin), regpaco (push), teams: core, docs')
console.log('Org Settings has: regpaco (admin), beetlejuice (pull), teams: docs, globalteam')
console.log('\nResult (smart merge):')
const merged = mergeConfigs(globalSettings, orgSettings, false)
console.log(JSON.stringify(merged, null, 2))
console.log('\nNote: regpaco upgraded to admin, all collaborators preserved, teams deduplicated')

console.log('\n' + '='.repeat(60))
