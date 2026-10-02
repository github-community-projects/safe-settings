#!/usr/bin/env node

/**
 * Simple example demonstrating the mergeConfigs function
 */

const { mergeConfigs } = require('../lib/hubSyncHandler')

console.log('═══════════════════════════════════════════════════')
console.log('  mergeConfigs() Function Examples')
console.log('═══════════════════════════════════════════════════\n')

// Example 1: Array Replace Mode
console.log('Example 1: Array Replace Mode (replaceArrays = true)')
console.log('─────────────────────────────────────────────────\n')

const json1 = `
teams:
  - team-a
  - team-b
`

const json2 = `
teams:
  - team-c
`

console.log('JSON-1:')
console.log(json1)
console.log('JSON-2:')
console.log(json2)

const replaced = mergeConfigs(json1, json2, true)
console.log('Result (replace=true):')
console.log(JSON.stringify(replaced, null, 2))
console.log('✓ Second array REPLACES first array\n')

// Example 2: Array Append Mode
console.log('Example 2: Array Append Mode (replaceArrays = false)')
console.log('─────────────────────────────────────────────────\n')

const appended = mergeConfigs(json1, json2, false)
console.log('Result (replace=false):')
console.log(JSON.stringify(appended, null, 2))
console.log('✓ Second array is APPENDED to first array\n')

// Example 3: Object Merging
console.log('Example 3: Object Merging')
console.log('─────────────────────────────────────────────────\n')

const global = `
repository:
  private: true
  has_issues: true
`

const org = `
repository:
  visibility: internal
  has_issues: false
`

console.log('Global Settings:')
console.log(global)
console.log('Organization Settings:')
console.log(org)

const merged = mergeConfigs(global, org, true)
console.log('Merged Result:')
console.log(JSON.stringify(merged, null, 2))
console.log('✓ Objects are merged, second takes precedence\n')

// Example 4: Complex Case with Both Arrays and Objects
console.log('Example 4: Complex Nested Structure')
console.log('─────────────────────────────────────────────────\n')

const complex1 = `
repository:
  settings:
    security:
      scanning: true
  teams:
    - admin-team
    - dev-team
labels:
  - bug
  - feature
`

const complex2 = `
repository:
  settings:
    security:
      alerts: true
  teams:
    - qa-team
labels:
  - enhancement
`

console.log('Config 1:')
console.log(complex1)
console.log('Config 2:')
console.log(complex2)

console.log('Result with REPLACE mode:')
const complexReplaced = mergeConfigs(complex1, complex2, true)
console.log(JSON.stringify(complexReplaced, null, 2))

console.log('\nResult with APPEND mode:')
const complexAppended = mergeConfigs(complex1, complex2, false)
console.log(JSON.stringify(complexAppended, null, 2))

// Example 5: Labels - Named Objects with Smart Merging
console.log('\n\nExample 5: Labels with Named Objects (Smart Merge by Name)')
console.log('─────────────────────────────────────────────────\n')

const baseLabels = `
labels:
  include:
    - name: bug
      color: CC0000
      description: An issue with the system
    - name: feature
      color: "336699"
      description: New functionality
    - name: documentation
      color: "0075ca"
      description: Documentation improvements
`

const overlayLabels = `
labels:
  include:
    - name: bug
      color: FF0000
      description: Bug reports and fixes
    - name: enhancement
      color: "84b6eb"
      description: New feature or request
`

console.log('Base Config (3 labels):')
console.log(baseLabels)
console.log('Overlay Config (2 labels):')
console.log(overlayLabels)

console.log('\nResult with REPLACE mode (replaceArrays=true):')
const labelsReplaced = mergeConfigs(baseLabels, overlayLabels, true)
console.log(JSON.stringify(labelsReplaced, null, 2))
console.log('✓ Entire labels array is REPLACED - only overlay labels remain\n')

console.log('Result with SMART MERGE mode (replaceArrays=false):')
const labelsSmartMerged = mergeConfigs(baseLabels, overlayLabels, false)
console.log(JSON.stringify(labelsSmartMerged, null, 2))
console.log('✓ Labels matched by NAME:')
console.log('  - "bug" label UPDATED (color & description changed)')
console.log('  - "feature" and "documentation" PRESERVED from base')
console.log('  - "enhancement" ADDED from overlay')
console.log('✓ Sub-properties (color, description) are merged per label\n')

// Example 6: Primitive Values - Simple Override
console.log('\n\nExample 6: Primitive Values (Strings, Numbers, Booleans)')
console.log('─────────────────────────────────────────────────\n')

const basePrimitives = `
policy_name: P1
role: "master controller"
version: 1.2
enabled: true
max_retries: 3
`

const overlayPrimitives = `
policy_name: P2
version: 2.0
description: "Updated policy"
`

console.log('Base Config:')
console.log(basePrimitives)
console.log('Overlay Config:')
console.log(overlayPrimitives)

console.log('Result (both modes behave the same for primitives):')
const primitivesMerged = mergeConfigs(basePrimitives, overlayPrimitives, true)
console.log(JSON.stringify(primitivesMerged, null, 2))
console.log('✓ Primitive values from overlay OVERRIDE base values:')
console.log('  - policy_name: P1 → P2 (overridden)')
console.log('  - version: 1.2 → 2.0 (overridden)')
console.log('  - role: "master controller" (preserved - not in overlay)')
console.log('  - enabled: true (preserved - not in overlay)')
console.log('  - max_retries: 3 (preserved - not in overlay)')
console.log('  - description: "Updated policy" (added from overlay)')
console.log('✓ Result: overlay values replace base, base-only values preserved\n')

// Example 7: Array Deduplication
console.log('\nExample 7: Array of Primitives (Deduplication)')
console.log('─────────────────────────────────────────────────\n')

const baseTags = `
tags:
  - typescript
  - nodejs
  - api
  - testing
`

const overlayTags = `
tags:
  - nodejs
  - docker
  - kubernetes
`

console.log('Base Config:')
console.log(baseTags)
console.log('Overlay Config:')
console.log(overlayTags)

console.log('\nResult with REPLACE mode (replaceArrays=true):')
const tagsReplaced = mergeConfigs(baseTags, overlayTags, true)
console.log(JSON.stringify(tagsReplaced, null, 2))
console.log('✓ Base tags REPLACED - only overlay tags remain\n')

console.log('Result with SMART MERGE mode (replaceArrays=false):')
const tagsSmartMerged = mergeConfigs(baseTags, overlayTags, false)
console.log(JSON.stringify(tagsSmartMerged, null, 2))
console.log('✓ Primitive arrays DEDUPLICATED:')
console.log('  - All base tags PRESERVED: typescript, nodejs, api, testing')
console.log('  - Duplicate "nodejs" NOT added again')
console.log('  - Unique overlay tags ADDED: docker, kubernetes')
console.log('✓ Result: union of both arrays with no duplicates\n')

console.log('\n═══════════════════════════════════════════════════')
console.log('  Usage Summary')
console.log('═══════════════════════════════════════════════════\n')
console.log('const mergeConfigs = require("./lib/mergeConfigs")\n')
console.log('// Replace arrays (default)')
console.log('mergeConfigs(json1, json2, true)\n')
console.log('// Append arrays')
console.log('mergeConfigs(json1, json2, false)\n')
