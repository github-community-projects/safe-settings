const { mergeConfigs } = require('../../../lib/hubSyncHandler')

describe('mergeConfigs', () => {
  describe('Array handling', () => {
    const json1 = `
teams:
  - team-a
  - team-b
`

    const json2 = `
teams:
  - team-c
`

    it('should replace arrays when replaceArrays=true', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        teams: ['team-c']
      })
    })

    it('should smart merge arrays when replaceArrays=false (deduplicate)', () => {
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        teams: ['team-a', 'team-b', 'team-c']
      })
    })

    it('should not create duplicates in smart merge mode', () => {
      const json1 = `
teams:
  - team-a
  - team-b
`
      const json2 = `
teams:
  - team-b
  - team-c
`
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        teams: ['team-a', 'team-b', 'team-c']
      })
    })

    it('should default to replace mode when replaceArrays not specified', () => {
      const result = mergeConfigs(json1, json2)
      expect(result).toEqual({
        teams: ['team-c']
      })
    })
  })

  describe('Object merging', () => {
    const json1 = `
repository:
  private: true
  has_issues: true
`

    const json2 = `
repository:
  visibility: internal
  has_issues: false
`

    it('should merge objects recursively', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        repository: {
          private: true,
          visibility: 'internal',
          has_issues: false
        }
      })
    })
  })

  describe('Complex nested structures', () => {
    const json1 = `
repository:
  settings:
    security:
      scanning: true
  teams:
    - team-a
    - team-b
labels:
  - name: bug
    color: red
`

    const json2 = `
repository:
  settings:
    security:
      alerts: true
  teams:
    - team-c
labels:
  - name: feature
    color: blue
`

    it('should handle complex nesting with array replace', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        repository: {
          settings: {
            security: {
              scanning: true,
              alerts: true
            }
          },
          teams: ['team-c']
        },
        labels: [
          { name: 'feature', color: 'blue' }
        ]
      })
    })

    it('should handle complex nesting with smart array merge', () => {
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        repository: {
          settings: {
            security: {
              scanning: true,
              alerts: true
            }
          },
          teams: ['team-a', 'team-b', 'team-c']
        },
        labels: [
          { name: 'bug', color: 'red' },
          { name: 'feature', color: 'blue' }
        ]
      })
    })

    it('should merge matching objects in arrays by name property', () => {
      const json1 = `
collaborators:
  - username: alice
    permission: push
  - username: bob
    permission: pull
`
      const json2 = `
collaborators:
  - username: alice
    permission: admin
  - username: charlie
    permission: push
`
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        collaborators: [
          { username: 'alice', permission: 'admin' },
          { username: 'bob', permission: 'pull' },
          { username: 'charlie', permission: 'push' }
        ]
      })
    })
  })

  describe('JSON input', () => {
    it('should handle JSON strings', () => {
      const json1 = JSON.stringify({ teams: ['team-a', 'team-b'] })
      const json2 = JSON.stringify({ teams: ['team-c'] })

      const replaced = mergeConfigs(json1, json2, true)
      expect(replaced).toEqual({ teams: ['team-c'] })

      const appended = mergeConfigs(json1, json2, false)
      expect(appended).toEqual({ teams: ['team-a', 'team-b', 'team-c'] })
    })
  })

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      const result = mergeConfigs('', 'teams: [team-a]', true)
      expect(result).toEqual({ teams: ['team-a'] })
    })

    it('should handle null/undefined values', () => {
      const json1 = 'a: 1\nb: 2'
      const json2 = 'b: null'

      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({ a: 1, b: null })
    })

    it('should skip prototype pollution', () => {
      const json1 = 'a: 1'
      const json2 = '__proto__: {polluted: true}'

      const result = mergeConfigs(json1, json2, true)
      expect(result.polluted).toBeUndefined()
    })
  })

  describe('Real-world example from documentation', () => {
    it('should merge global and org settings with replace', () => {
      const globalSettings = `
repository:
  private: true
`

      const orgSettings = `
repository:
  visibility: internal
`

      const result = mergeConfigs(globalSettings, orgSettings, true)
      expect(result).toEqual({
        repository: {
          private: true,
          visibility: 'internal'
        }
      })
    })
  })

  describe('Combined arrays and primitives', () => {
    it('should merge primitives and object arrays together (replace mode)', () => {
      const json1 = `
policy_name: P1
version: 1.2
enabled: true
labels:
  - name: bug
    color: red
  - name: feature
    color: blue
collaborators:
  - username: alice
    permission: push
`

      const json2 = `
policy_name: P2
description: "Updated policy"
labels:
  - name: enhancement
    color: green
collaborators:
  - username: alice
    permission: admin
  - username: bob
    permission: pull
`

      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        policy_name: 'P2',
        version: 1.2,
        enabled: true,
        description: 'Updated policy',
        labels: [
          { name: 'enhancement', color: 'green' }
        ],
        collaborators: [
          { username: 'alice', permission: 'admin' },
          { username: 'bob', permission: 'pull' }
        ]
      })
    })

    it('should merge primitives and object arrays together (smart merge mode)', () => {
      const json1 = `
policy_name: P1
version: 1.2
enabled: true
labels:
  - name: bug
    color: red
    priority: high
  - name: feature
    color: blue
collaborators:
  - username: alice
    permission: push
`

      const json2 = `
policy_name: P2
description: "Updated policy"
labels:
  - name: bug
    color: darkred
  - name: enhancement
    color: green
collaborators:
  - username: alice
    permission: admin
  - username: bob
    permission: pull
`

      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        policy_name: 'P2',
        version: 1.2,
        enabled: true,
        description: 'Updated policy',
        labels: [
          { name: 'bug', color: 'darkred', priority: 'high' },
          { name: 'feature', color: 'blue' },
          { name: 'enhancement', color: 'green' }
        ],
        collaborators: [
          { username: 'alice', permission: 'admin' },
          { username: 'bob', permission: 'pull' }
        ]
      })
    })

    it('should handle mixed primitive arrays and object arrays (smart merge)', () => {
      const json1 = `
name: Project A
tags:
  - typescript
  - nodejs
labels:
  - name: bug
    color: red
teams:
  - dev-team
  - qa-team
`

      const json2 = `
name: Project B
tags:
  - nodejs
  - docker
labels:
  - name: bug
    color: blue
  - name: feature
    color: green
teams:
  - qa-team
  - ops-team
`

      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        name: 'Project B',
        tags: ['typescript', 'nodejs', 'docker'],
        labels: [
          { name: 'bug', color: 'blue' },
          { name: 'feature', color: 'green' }
        ],
        teams: ['dev-team', 'qa-team', 'ops-team']
      })
    })

    it('should handle deeply nested structures with primitives and arrays', () => {
      const json1 = `
config:
  version: 1.0
  settings:
    security:
      enabled: true
      level: high
    features:
      - authentication
      - authorization
  policies:
    - name: default
      priority: 1
`

      const json2 = `
config:
  version: 2.0
  settings:
    security:
      level: critical
    features:
      - authorization
      - monitoring
  policies:
    - name: default
      priority: 5
      description: Updated policy
    - name: custom
      priority: 2
`

      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        config: {
          version: 2.0,
          settings: {
            security: {
              enabled: true,
              level: 'critical'
            },
            features: ['authentication', 'authorization', 'monitoring']
          },
          policies: [
            { name: 'default', priority: 5, description: 'Updated policy' },
            { name: 'custom', priority: 2 }
          ]
        }
      })
    })

    it('should preserve primitives when merging complex nested arrays', () => {
      const json1 = `
organization: acme-corp
type: enterprise
max_repos: 100
members:
  - username: alice
    role: admin
    active: true
  - username: bob
    role: member
    active: true
`

      const json2 = `
type: organization
description: ACME Corporation
members:
  - username: alice
    role: owner
  - username: charlie
    role: member
    active: false
`

      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        organization: 'acme-corp',
        type: 'organization',
        max_repos: 100,
        description: 'ACME Corporation',
        members: [
          { username: 'alice', role: 'owner', active: true },
          { username: 'bob', role: 'member', active: true },
          { username: 'charlie', role: 'member', active: false }
        ]
      })
    })
  })
})
