const { mergeConfigs } = require('../../../lib/hubSyncHandler')

// Smart merge used by Hub-Sync: globals (first) + org (second, takes precedence)
const merge = (globals, org) => mergeConfigs(globals, org, false)

describe('Hub-Sync smart merge does not duplicate entries', () => {
  it('matches milestones by title', () => {
    const entry = '  - title: v1\n    description: first\n    state: open\n'
    const result = merge(`milestones:\n${entry}`, `milestones:\n${entry}  - title: v2\n`)
    expect(result.milestones).toEqual([
      { title: 'v1', description: 'first', state: 'open' },
      { title: 'v2' }
    ])
  })

  it('lets the org override a matched milestone', () => {
    const result = merge('milestones:\n  - title: v1\n    state: open\n', 'milestones:\n  - title: v1\n    state: closed\n')
    expect(result.milestones).toEqual([{ title: 'v1', state: 'closed' }])
  })

  it('does not duplicate nested include/exclude lists on matched collaborators', () => {
    const collaborator = 'collaborators:\n  - username: thor\n    permission: push\n    include:\n      - repo-a\n      - repo-b\n'
    const result = merge(collaborator, collaborator.replace('repo-b', 'repo-c'))
    expect(result.collaborators).toEqual([
      { username: 'thor', permission: 'push', include: ['repo-a', 'repo-b', 'repo-c'] }
    ])
  })

  it('merges ruleset rules, bypass actors and conditions without duplicates', () => {
    const ruleset = `
rulesets:
  - name: protect-default
    enforcement: active
    bypass_actors:
      - actor_id: 1
        actor_type: OrganizationAdmin
        bypass_mode: always
    conditions:
      ref_name:
        include: ['~DEFAULT_BRANCH']
        exclude: ['refs/heads/old']
    rules:
      - type: deletion
      - type: pull_request
        parameters:
          required_approving_review_count: 1
`
    const orgRuleset = ruleset.replace('required_approving_review_count: 1', 'required_approving_review_count: 2')
    const [result] = merge(ruleset, orgRuleset).rulesets

    expect(result.bypass_actors).toEqual([{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }])
    expect(result.conditions).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/old'] } })
    expect(result.rules).toEqual([
      { type: 'deletion' },
      { type: 'pull_request', parameters: { required_approving_review_count: 2 } }
    ])
  })

  it('keeps bypass actors that share an id but have different types', () => {
    const result = merge(
      'bypass_actors:\n  - actor_id: 5\n    actor_type: Team\n',
      'bypass_actors:\n  - actor_id: 5\n    actor_type: Integration\n'
    )
    expect(result.bypass_actors).toEqual([
      { actor_id: 5, actor_type: 'Team' },
      { actor_id: 5, actor_type: 'Integration' }
    ])
  })

  it('keeps environment reviewers that share a type but have different ids', () => {
    const result = merge(
      'reviewers:\n  - type: Team\n    id: 1\n',
      'reviewers:\n  - type: Team\n    id: 2\n  - type: Team\n    id: 1\n'
    )
    expect(result.reviewers).toEqual([{ type: 'Team', id: 1 }, { type: 'Team', id: 2 }])
  })

  it('skips identical entries that have no identifying field', () => {
    const result = merge('items:\n  - color: red\n', 'items:\n  - color: red\n  - color: blue\n')
    expect(result.items).toEqual([{ color: 'red' }, { color: 'blue' }])
  })

  it('still merges labels by name and keeps globals-only entries', () => {
    const result = merge(
      'labels:\n  - name: bug\n    color: red\n  - name: feature\n    color: blue\n',
      'labels:\n  - name: bug\n    color: green\n  - name: docs\n    color: yellow\n'
    )
    expect(result.labels).toEqual([
      { name: 'bug', color: 'green' },
      { name: 'feature', color: 'blue' },
      { name: 'docs', color: 'yellow' }
    ])
  })

  it('preserves explicit nested nulls such as branch protection: null', () => {
    const result = merge(
      'branches:\n  - name: default\n    protection:\n      enforce_admins: true\n',
      'branches:\n  - name: default\n    protection: null\n'
    )
    expect(result.branches).toEqual([{ name: 'default', protection: null }])
  })
})
