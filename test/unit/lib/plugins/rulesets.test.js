/* eslint-disable no-undef */

const { when } = require('jest-when')
const Rulesets = require('../../../../lib/plugins/rulesets')
const version = {
  'X-GitHub-Api-Version': '2026-03-10'
}
const repo_conditions = {
  ref_name: {
    include: ['~ALL'],
    exclude: []
  }
}
const org_conditions = {
  ref_name: {
    include: ['~ALL'],
    exclude: []
  },
  repository_name: {
    include: ['~ALL'],
    exclude: ['admin']
  }
}

function generateRequestRuleset (id, name, conditions, checks, org = false) {
  request = {
    id,
    name,
    target: 'branch',
    enforcement: 'active',
    conditions,
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: checks
        }
      }
    ]
  }
  if (org) {
    request.source_type = 'Organization'
  } else {
    request.source_type = 'Repository'
  }
  if (checks.length === 0) {
    request.rules = []
  }
  return request
}

function generateResponseRuleset (id, name, conditions, checks, org = false) {
  response = {
    id,
    name,
    target: 'branch',
    enforcement: 'active',
    conditions,
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: checks
        }
      }
    ],
    headers: version
  }
  if (org) {
    response.source_type = 'Organization'
    response.org = 'jitran'
  } else {
    response.source_type = 'Repository'
    response.owner = 'jitran'
    response.repo = 'test'
  }
  if (checks.length === 0) {
    response.rules = []
  }
  return response
}

describe('Rulesets', () => {
  let github
  const log = jest.fn()
  log.debug = jest.fn()
  log.info = jest.fn()
  log.error = jest.fn()

  function configure (config, scope = 'repo', noop = false) {
    const errors = []
    return new Rulesets(noop, github, { owner: 'jitran', repo: 'test' }, config, log, errors, scope)
  }

  beforeEach(() => {
    github = {
      rest: {
        repos: {
          get: jest.fn().mockResolvedValue({
            data: {
              default_branch: 'main'
            }
          })
        }
      },
      request: jest.fn().mockImplementation(() => Promise.resolve('request'))
    }

    github.request.endpoint = jest.fn().mockImplementation((route, body) => ({ url: route, body }))
    github.request.endpoint.merge = jest.fn().mockReturnValue({
      method: 'GET',
      url: '/repos/jitran/test/rulesets',
      headers: version
    })
  })

  describe('sync', () => {
    it('syncs ruleset settings', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ]
          )
        ]
      )

      return plugin.sync().then(() => {
        expect(github.request).toHaveBeenLastCalledWith(
          'POST /repos/{owner}/{repo}/rulesets',
          generateResponseRuleset(
            1,
            'All branches',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ]
          )
        )
      })
    })

    it('in nop mode treats a missing repo as having no existing rulesets', async () => {
      const notFound = new Error('Not Found')
      notFound.status = 404
      github.paginate = jest.fn().mockRejectedValue(notFound)

      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches',
            repo_conditions,
            [
              { context: 'Status Check 1' }
            ]
          )
        ],
        'repo',
        true
      )

      const result = await plugin.sync()
      const flat = result.flat()
      const summary = flat.find(command => command.plugin === 'Rulesets' && command.action?.msg === 'Changes found')

      expect(flat.some(command => command.type === 'ERROR')).toBe(false)
      expect(summary.action).toEqual({
        msg: 'Changes found',
        additions: plugin.entries,
        modifications: [],
        deletions: []
      })
      expect(plugin.hasChanges).toBe(true)
      expect(github.request).not.toHaveBeenCalled()
    })
  })

  describe.each(['repo', 'org'])('identifier-less bypass actors (%s scope)', scope => {
    const actor = (actorType, actorId, bypassMode = 'always') => ({ actor_type: actorType, actor_id: actorId, bypass_mode: bypassMode })
    const policy = bypassActors => ({
      name: 'Bypass policy',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      bypass_actors: bypassActors,
      rules: []
    })

    it.each([false, true])('converges without mutating config or scheduling an update (nop=%p)', async nop => {
      const attrs = policy([actor('DeployKey', 123), actor('OrganizationAdmin', 1), actor('Integration', 42)])
      const before = structuredClone(attrs)
      const existing = { ...policy([actor('Integration', 42), actor('OrganizationAdmin', null), actor('DeployKey', null)]), id: 7 }
      const plugin = configure([attrs], scope, nop)
      plugin.find = jest.fn().mockResolvedValue([existing])

      expect(plugin.changed(existing, attrs)).toBe(false)
      expect(await plugin.sync()).toBeUndefined()
      expect(plugin.hasChanges).toBe(false)
      expect(github.request).not.toHaveBeenCalled()
      expect(attrs).toEqual(before)
    })

    it.each([false, true])('updates a real bypass_mode change and then converges (nop=%p)', async nop => {
      const attrs = policy([actor('DeployKey', 123, 'pull_request'), actor('OrganizationAdmin', 1)])
      const existing = { ...policy([actor('OrganizationAdmin', null), actor('DeployKey', null)]), id: 7 }
      const plugin = configure([attrs], scope, nop)
      plugin.find = jest.fn().mockResolvedValue([existing])

      expect(plugin.changed(existing, attrs)).toBe(true)
      const result = await plugin.sync()
      expect(plugin.hasChanges).toBe(true)
      const route = scope === 'org' ? 'PUT /orgs/{org}/rulesets/{id}' : 'PUT /repos/{owner}/{repo}/rulesets/{id}'
      if (nop) {
        expect(github.request).not.toHaveBeenCalled()
        expect(result.flat().filter(command => command.action.msg === 'Update Ruleset')).toHaveLength(1)
        expect(github.request.endpoint).toHaveBeenCalledWith(route, expect.objectContaining({ id: 7, bypass_actors: attrs.bypass_actors }))
      } else {
        expect(github.request).toHaveBeenCalledTimes(1)
        expect(github.request).toHaveBeenCalledWith(route, expect.objectContaining({ id: 7, bypass_actors: attrs.bypass_actors }))
      }

      plugin.find.mockResolvedValue([{ ...existing, bypass_actors: [actor('OrganizationAdmin', null), actor('DeployKey', null, 'pull_request')] }])
      github.request.mockClear()
      expect(await plugin.sync()).toBeUndefined()
      expect(plugin.hasChanges).toBe(false)
      expect(github.request).not.toHaveBeenCalled()
    })

    it('converges after resolving a team alias alongside an ignored DeployKey id', async () => {
      github.rest.teams = { getByName: jest.fn().mockResolvedValue({ data: { id: 42 } }) }
      const attrs = policy([{ name: 'developers', actor_type: 'Team', bypass_mode: 'always' }, actor('DeployKey', 123)])
      const plugin = configure([attrs], scope, true)
      plugin.find = jest.fn().mockResolvedValue([{ ...policy([actor('DeployKey', null), actor('Team', 42)]), id: 7 }])

      expect(await plugin.sync()).toBeUndefined()
      expect(plugin.hasChanges).toBe(false)
      expect(github.rest.teams.getByName).toHaveBeenCalledWith({ org: 'jitran', team_slug: 'developers' })
      expect(github.request).not.toHaveBeenCalled()
    })
  })

  describe('idempotent create when the ruleset already exists (retried/concurrent POST)', () => {
    function duplicateNameError () {
      const e = new Error('Validation Failed')
      e.status = 422
      e.response = { data: { errors: ['Name must be unique'] } }
      return e
    }

    function wireRequest (routeResults) {
      const calls = []
      const request = jest.fn().mockImplementation((route, body) => {
        calls.push({ route, body })
        const handler = routeResults[route]
        return handler ? handler() : Promise.resolve({ url: route })
      })
      request.endpoint = jest.fn().mockImplementation((route, body) => ({ url: route, body }))
      request.endpoint.merge = jest.fn().mockImplementation((route, body) => ({ method: 'GET', url: route, ...body }))
      github.request = request
      return calls
    }

    it('reconciles a repo ruleset by updating the existing one on 422 "Name must be unique"', async () => {
      const attrs = generateRequestRuleset(0, 'synk', repo_conditions, [])
      delete attrs.id
      const existing = generateResponseRuleset(42, 'synk', repo_conditions, [])
      const calls = wireRequest({
        'POST /repos/{owner}/{repo}/rulesets': () => Promise.reject(duplicateNameError())
      })
      github.paginate = jest.fn()
        .mockResolvedValueOnce([{ id: 42, name: 'synk', source_type: 'Repository' }])
        .mockResolvedValueOnce([existing])

      const plugin = configure([attrs])
      await plugin.add(attrs)

      const put = calls.find(c => c.route === 'PUT /repos/{owner}/{repo}/rulesets/{id}')
      expect(put).toBeDefined()
      expect(put.body.id).toBe(42)
    })

    it('reconciles an org ruleset by updating the existing one on 422 "Name must be unique"', async () => {
      const attrs = generateRequestRuleset(0, 'synk', org_conditions, [], true)
      delete attrs.id
      const existing = generateResponseRuleset(7, 'synk', org_conditions, [], true)
      const calls = wireRequest({
        'POST /orgs/{org}/rulesets': () => Promise.reject(duplicateNameError())
      })
      github.paginate = jest.fn()
        .mockResolvedValueOnce([{ id: 7, name: 'synk', source_type: 'Organization' }])
        .mockResolvedValueOnce([existing])

      const plugin = configure([attrs], 'org')
      await plugin.add(attrs)

      const put = calls.find(c => c.route === 'PUT /orgs/{org}/rulesets/{id}')
      expect(put).toBeDefined()
      expect(put.body.id).toBe(7)
    })

    it('does not reconcile (surfaces the error) for a 422 that is not a name-uniqueness violation', async () => {
      const attrs = generateRequestRuleset(0, 'synk', repo_conditions, [])
      delete attrs.id
      const other = new Error('Validation Failed')
      other.status = 422
      other.response = { data: { errors: ['Something else is invalid'] } }
      const calls = wireRequest({
        'POST /repos/{owner}/{repo}/rulesets': () => Promise.reject(other)
      })
      github.paginate = jest.fn()

      const plugin = configure([attrs])
      await plugin.add(attrs)

      expect(github.paginate).not.toHaveBeenCalled()
      expect(calls.some(c => c.route === 'PUT /repos/{owner}/{repo}/rulesets/{id}')).toBe(false)
    })
  })

  describe('when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and no status checks exist in GitHub', () => {
    it('it initialises the status checks with an empty list', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: '{{EXTERNALLY_DEFINED}}' }
            ]
          )
        ]
      )

      return plugin.sync().then(() => {
        expect(github.request).toHaveBeenLastCalledWith(
          'POST /repos/{owner}/{repo}/rulesets',
          generateResponseRuleset(
            1,
            'All branches',
            repo_conditions,
            []
          )
        )
      })
    })
  })

  describe('when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and status checks exist in GitHub', () => {
    it('skips the placeholder-only ruleset and updates the genuinely changed ones', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([
        generateRequestRuleset(
          1,
          'All branches 1',
          repo_conditions,
          [
            { context: 'Custom Check 1' },
            { context: 'Custom Check 2' }
          ]
        ),
        generateRequestRuleset(
          2,
          'All branches 2',
          repo_conditions,
          [
            { context: 'Custom Check 3' },
            { context: 'Custom Check 4' }
          ]
        ),
        generateRequestRuleset(
          3,
          'All branches 3',
          repo_conditions,
          [
            { context: 'Custom Check 5' },
            { context: 'Custom Check 6' }
          ]
        )
      ])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches 1',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: '{{EXTERNALLY_DEFINED}}' }
            ]
          ),
          generateRequestRuleset(
            2,
            'All branches 2',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ]
          ),
          generateRequestRuleset(
            3,
            'All branches 3',
            repo_conditions,
            []
          )
        ]
      )

      return plugin.sync().then(() => {
        // Ruleset 1 only differs by the {{EXTERNALLY_DEFINED}} placeholder, which
        // resolves to the live status checks, so it must not be updated at all.
        expect(github.request).toHaveBeenCalledTimes(2)
        expect(github.request).toHaveBeenNthCalledWith(
          1,
          'PUT /repos/{owner}/{repo}/rulesets/{id}',
          generateResponseRuleset(
            2,
            'All branches 2',
            repo_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ]
          )
        )
        expect(github.request).toHaveBeenNthCalledWith(
          2,
          'PUT /repos/{owner}/{repo}/rulesets/{id}',
          generateResponseRuleset(
            3,
            'All branches 3',
            repo_conditions,
            []
          )
        )
      })
    })
  })

  describe('[org] sync', () => {
    it('syncs ruleset settings', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches',
            org_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ],
            true
          )
        ],
        'org'
      )

      return plugin.sync().then(() => {
        expect(github.request).toHaveBeenLastCalledWith(
          'POST /orgs/{org}/rulesets',
          generateResponseRuleset(
            1,
            'All branches',
            org_conditions,
            [
              { context: 'Status Check 1' },
              { context: 'Status Check 2' }
            ],
            true
          )
        )
      })
    })
  })

  describe('[org] when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and no status checks exist in GitHub', () => {
    it('it initialises the status checks with an empty list', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches',
            org_conditions,
            [
              { context: 'Status Check 1' },
              { context: '{{EXTERNALLY_DEFINED}}' }
            ],
            true
          )
        ],
        'org'
      )

      return plugin.sync().then(() => {
        expect(github.request).toHaveBeenLastCalledWith(
          'POST /orgs/{org}/rulesets',
          generateResponseRuleset(
            1,
            'All branches',
            org_conditions,
            [],
            true
          )
        )
      })
    })
  })

  describe('[org] when {{EXTERNALLY_DEFINED}} is present in "required_status_checks" and status checks exist in GitHub', () => {
    it('reports no changes when only the placeholder differs from GitHub', () => {
      // Mock the GitHub API response
      github.paginate = jest.fn().mockResolvedValue([
        generateRequestRuleset(
          1,
          'All branches 1',
          org_conditions,
          [
            { context: 'Custom Check 1' },
            { context: 'Custom Check 2' }
          ],
          true
        )
      ])

      // Initialise safe-settings
      const plugin = configure(
        [
          generateRequestRuleset(
            1,
            'All branches 1',
            org_conditions,
            [
              { context: 'Status Check 1' },
              { context: '{{EXTERNALLY_DEFINED}}' }
            ],
            true
          )
        ],
        'org'
      )

      return plugin.sync().then(() => {
        // The placeholder resolves to the live status checks, so the ruleset is unchanged
        expect(github.request).not.toHaveBeenCalled()
      })
    })
  })

  describe('in nop mode', () => {
    beforeEach(() => {
      github.request.endpoint = Object.assign(
        jest.fn().mockImplementation((route, parms) => { return { url: route, body: parms } }),
        { merge: github.request.endpoint.merge }
      )
    })

    it('does not plan an update when {{EXTERNALLY_DEFINED}} matches the status checks in GitHub', () => {
      github.paginate = jest.fn().mockResolvedValue([
        generateRequestRuleset(1, 'All branches 1', repo_conditions, [{ context: 'Custom Check 1' }])
      ])

      const plugin = configure([
        generateRequestRuleset(1, 'All branches 1', repo_conditions, [{ context: '{{EXTERNALLY_DEFINED}}' }])
      ], 'repo', true)

      return plugin.sync().then(res => {
        // sync resolves with nothing when no changes are detected
        const messages = (res || []).flat(2).map(nopCommand => nopCommand.action?.msg)
        expect(messages).not.toContain('Update Ruleset')
      })
    })

    it('still plans an update when the config genuinely differs from GitHub', () => {
      github.paginate = jest.fn().mockResolvedValue([
        generateRequestRuleset(1, 'All branches 1', repo_conditions, [{ context: 'Custom Check 1' }])
      ])

      const plugin = configure([
        generateRequestRuleset(1, 'All branches 1', repo_conditions, [{ context: 'Other Check' }])
      ], 'repo', true)

      return plugin.sync().then(res => {
        const messages = res.flat(2).map(nopCommand => nopCommand.action?.msg)
        expect(messages).toContain('Update Ruleset')
      })
    })
  })

  describe('changed() method with required_reviewers', () => {
    it('detects when required_reviewers array changes from populated to empty', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Protect release branches',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/release/*'],
              exclude: []
            }
          },
          rules: [
            {
              type: 'pull_request',
              parameters: {
                required_approving_review_count: 1,
                dismiss_stale_reviews_on_push: false,
                require_code_owner_review: false,
                require_last_push_approval: false,
                required_review_thread_resolution: false,
                allowed_merge_methods: ['merge', 'squash', 'rebase'],
                required_reviewers: [
                  {
                    minimum_approvals: 1,
                    file_patterns: ['*.js'],
                    reviewer: {
                      id: 11721733,
                      type: 'Team'
                    }
                  }
                ]
              }
            }
          ]
        }
      ])

      // GitHub state after manual removal of required_reviewers
      const existingRuleset = {
        name: 'Protect release branches',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/release/*'],
            exclude: []
          }
        },
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              allowed_merge_methods: ['merge', 'squash', 'rebase'],
              required_reviewers: [] // Empty after manual removal
            }
          }
        ]
      }

      // YAML config (what safe-settings expects)
      const attrs = plugin.rulesets[0]

      // The changed() method should detect this difference
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })

    it('detects when bypass_actors array changes from populated to empty', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Main protection',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/main'],
              exclude: []
            }
          },
          bypass_actors: [
            {
              actor_type: 'OrganizationAdmin',
              bypass_mode: 'always'
            }
          ],
          rules: [
            {
              type: 'creation'
            }
          ]
        }
      ])

      // GitHub state after manual removal of bypass_actors
      const existingRuleset = {
        name: 'Main protection',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main'],
            exclude: []
          }
        },
        bypass_actors: [], // Empty after manual removal
        rules: [
          {
            type: 'creation'
          }
        ]
      }

      const attrs = plugin.rulesets[0]
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })

    it('detects when workflows array changes from populated to empty', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Workflow protection',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/main'],
              exclude: []
            }
          },
          rules: [
            {
              type: 'workflows',
              parameters: {
                do_not_enforce_on_create: false,
                workflows: [
                  {
                    path: '.github/workflows/test.yml',
                    repository_id: 123456
                  }
                ]
              }
            }
          ]
        }
      ])

      // GitHub state after manual removal of workflows
      const existingRuleset = {
        name: 'Workflow protection',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main'],
            exclude: []
          }
        },
        rules: [
          {
            type: 'workflows',
            parameters: {
              do_not_enforce_on_create: false,
              workflows: [] // Empty after manual removal
            }
          }
        ]
      }

      const attrs = plugin.rulesets[0]
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })

    it('detects when rules array has item added out-of-band', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Branch rules',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/main'],
              exclude: []
            }
          },
          rules: [
            {
              type: 'creation'
            }
          ]
        }
      ])

      // GitHub state where an extra rule was added manually
      const existingRuleset = {
        name: 'Branch rules',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main'],
            exclude: []
          }
        },
        rules: [
          {
            type: 'creation'
          },
          {
            type: 'deletion' // Extra rule added out-of-band
          }
        ]
      }

      const attrs = plugin.rulesets[0]
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })

    it('detects when required_reviewers item is modified with different file patterns', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Code review',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/main'],
              exclude: []
            }
          },
          rules: [
            {
              type: 'pull_request',
              parameters: {
                required_approving_review_count: 1,
                dismiss_stale_reviews_on_push: false,
                require_code_owner_review: false,
                require_last_push_approval: false,
                required_review_thread_resolution: false,
                allowed_merge_methods: ['merge'],
                required_reviewers: [
                  {
                    minimum_approvals: 1,
                    file_patterns: ['*.js', '*.ts'],
                    reviewer: {
                      id: 999,
                      type: 'Team'
                    }
                  }
                ]
              }
            }
          ]
        }
      ])

      // GitHub state where file patterns were manually changed
      const existingRuleset = {
        name: 'Code review',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main'],
            exclude: []
          }
        },
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              allowed_merge_methods: ['merge'],
              required_reviewers: [
                {
                  minimum_approvals: 1,
                  file_patterns: ['*.py'], // Different patterns
                  reviewer: {
                    id: 999,
                    type: 'Team'
                  }
                }
              ]
            }
          }
        ]
      }

      const attrs = plugin.rulesets[0]
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })

    it('detects when bypass_actors item is modified with different bypass_mode', () => {
      github.paginate = jest.fn().mockResolvedValue([])

      const plugin = configure([
        {
          name: 'Bypass config',
          target: 'branch',
          enforcement: 'active',
          conditions: {
            ref_name: {
              include: ['refs/heads/main'],
              exclude: []
            }
          },
          bypass_actors: [
            {
              actor_type: 'OrganizationAdmin',
              bypass_mode: 'always'
            }
          ],
          rules: [
            {
              type: 'creation'
            }
          ]
        }
      ])

      // GitHub state where bypass_mode was manually changed
      const existingRuleset = {
        name: 'Bypass config',
        target: 'branch',
        enforcement: 'active',
        conditions: {
          ref_name: {
            include: ['refs/heads/main'],
            exclude: []
          }
        },
        bypass_actors: [
          {
            actor_type: 'OrganizationAdmin',
            bypass_mode: 'pull_request' // Changed from 'always'
          }
        ],
        rules: [
          {
            type: 'creation'
          }
        ]
      }

      const attrs = plugin.rulesets[0]
      const result = plugin.changed(existingRuleset, attrs)
      expect(result).toBe(true)
    })
  })

  describe('name to id resolution', () => {
    function bypassRuleset (actorEntry) {
      return {
        name: 'Main protection',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
        bypass_actors: [Object.assign({ bypass_mode: 'always' }, actorEntry)],
        rules: [{ type: 'creation' }]
      }
    }

    function reviewerRuleset (reviewer) {
      return {
        name: 'Code review',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
        rules: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              required_reviewers: [
                { minimum_approvals: 1, file_patterns: ['*.js'], reviewer }
              ]
            }
          }
        ]
      }
    }

    it('resolves a Team bypass actor name to actor_id and strips the alias', async () => {
      github.rest.teams = { getByName: jest.fn().mockResolvedValue({ data: { id: 42 } }) }
      const plugin = configure([bypassRuleset({ name: 'my-team', actor_type: 'Team' })], 'org')

      await plugin.resolveNamesToIds()

      expect(github.rest.teams.getByName).toHaveBeenCalledWith({ org: 'jitran', team_slug: 'my-team' })
      expect(plugin.rulesets[0].bypass_actors[0]).toEqual({ actor_id: 42, actor_type: 'Team', bypass_mode: 'always' })
      expect(plugin.rulesets[0].bypass_actors[0].name).toBeUndefined()
    })

    it('resolves a User bypass actor login to actor_id', async () => {
      github.request = jest.fn().mockResolvedValue({ data: { id: 7 } })
      const plugin = configure([bypassRuleset({ name: 'octocat', actor_type: 'User' })], 'org')

      await plugin.resolveNamesToIds()

      expect(github.request).toHaveBeenCalledWith('GET /users/{username}', { username: 'octocat' })
      expect(plugin.rulesets[0].bypass_actors[0]).toEqual({ actor_id: 7, actor_type: 'User', bypass_mode: 'always' })
    })

    it('resolves an Integration (GitHub App) slug to actor_id', async () => {
      github.request = jest.fn().mockResolvedValue({ data: { id: 99 } })
      const plugin = configure([bypassRuleset({ name: 'my-app', actor_type: 'Integration' })], 'org')

      await plugin.resolveNamesToIds()

      expect(github.request).toHaveBeenCalledWith('GET /apps/{app_slug}', { app_slug: 'my-app' })
      expect(plugin.rulesets[0].bypass_actors[0].actor_id).toBe(99)
    })

    it('resolves built-in RepositoryRole names from the static map without an API call', async () => {
      github.request = jest.fn()
      const plugin = configure([
        bypassRuleset({ name: 'admin', actor_type: 'RepositoryRole' })
      ], 'org')

      await plugin.resolveNamesToIds()

      expect(github.request).not.toHaveBeenCalled()
      expect(plugin.rulesets[0].bypass_actors[0].actor_id).toBe(5)
    })

    it('pins the built-in RepositoryRole ids', async () => {
      const expected = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 }
      for (const [name, id] of Object.entries(expected)) {
        const plugin = configure([bypassRuleset({ name, actor_type: 'RepositoryRole' })], 'org')
        await plugin.resolveNamesToIds()
        expect(plugin.rulesets[0].bypass_actors[0].actor_id).toBe(id)
      }
    })

    it('resolves a custom RepositoryRole name via the custom-repository-roles API', async () => {
      github.request = jest.fn().mockResolvedValue({ data: { custom_roles: [{ id: 123, name: 'Security' }] } })
      const plugin = configure([bypassRuleset({ name: 'Security', actor_type: 'RepositoryRole' })], 'org')

      await plugin.resolveNamesToIds()

      expect(github.request).toHaveBeenCalledWith('GET /orgs/{org}/custom-repository-roles', { org: 'jitran' })
      expect(plugin.rulesets[0].bypass_actors[0].actor_id).toBe(123)
    })

    it('resolves a reviewer slug to id and strips the alias', async () => {
      github.rest.teams = { getByName: jest.fn().mockResolvedValue({ data: { id: 555 } }) }
      const plugin = configure([reviewerRuleset({ slug: 'reviewers', type: 'Team' })], 'org')

      await plugin.resolveNamesToIds()

      const reviewer = plugin.rulesets[0].rules[0].parameters.required_reviewers[0].reviewer
      expect(github.rest.teams.getByName).toHaveBeenCalledWith({ org: 'jitran', team_slug: 'reviewers' })
      expect(reviewer).toEqual({ id: 555, type: 'Team' })
      expect(reviewer.slug).toBeUndefined()
    })

    it('caches repeated lookups so each name resolves with a single API call', async () => {
      github.rest.teams = { getByName: jest.fn().mockResolvedValue({ data: { id: 42 } }) }
      const plugin = configure([
        {
          name: 'Multi',
          target: 'branch',
          enforcement: 'active',
          conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
          bypass_actors: [
            { name: 'my-team', actor_type: 'Team', bypass_mode: 'always' },
            { name: 'my-team', actor_type: 'Team', bypass_mode: 'pull_request' }
          ],
          rules: [{ type: 'creation' }]
        }
      ], 'org')

      await plugin.resolveNamesToIds()

      expect(github.rest.teams.getByName).toHaveBeenCalledTimes(1)
      expect(plugin.rulesets[0].bypass_actors.map(a => a.actor_id)).toEqual([42, 42])
    })

    it('leaves numeric actor_id untouched and makes no lookup (backward compatible)', async () => {
      github.rest.teams = { getByName: jest.fn() }
      github.request = jest.fn()
      const plugin = configure([bypassRuleset({ actor_id: 234, actor_type: 'Team' })], 'org')

      await plugin.resolveNamesToIds()

      expect(github.rest.teams.getByName).not.toHaveBeenCalled()
      expect(github.request).not.toHaveBeenCalled()
      expect(plugin.rulesets[0].bypass_actors[0]).toEqual({ actor_id: 234, actor_type: 'Team', bypass_mode: 'always' })
    })

    it('throws when both name and actor_id are provided', async () => {
      const plugin = configure([bypassRuleset({ name: 'my-team', actor_id: 1, actor_type: 'Team' })], 'org')
      await expect(plugin.resolveNamesToIds()).rejects.toThrow(/both 'name'.*and 'actor_id'/)
    })

    it('throws when both reviewer slug and id are provided', async () => {
      const plugin = configure([reviewerRuleset({ slug: 'reviewers', id: 1, type: 'Team' })], 'org')
      await expect(plugin.resolveNamesToIds()).rejects.toThrow(/both 'slug'.*and 'id'/)
    })

    it('throws when an actor_type does not support name resolution', async () => {
      const plugin = configure([bypassRuleset({ name: 'whoever', actor_type: 'DeployKey' })], 'org')
      await expect(plugin.resolveNamesToIds()).rejects.toThrow(/only supported for Team, User, Integration, and RepositoryRole/)
    })

    it('throws a clear error when a team slug cannot be resolved', async () => {
      const notFound = new Error('Not Found')
      notFound.status = 404
      github.rest.teams = { getByName: jest.fn().mockRejectedValue(notFound) }
      const plugin = configure([bypassRuleset({ name: 'ghost-team', actor_type: 'Team' })], 'org')
      await expect(plugin.resolveNamesToIds()).rejects.toThrow(/Unable to resolve Team slug 'ghost-team'/)
    })

    it('sync sends the resolved actor_id to the API', async () => {
      github.paginate = jest.fn().mockResolvedValue([])
      github.rest.teams = { getByName: jest.fn().mockResolvedValue({ data: { id: 42 } }) }
      const postCalls = []
      github.request = jest.fn().mockImplementation((route, body) => {
        if (route.startsWith('POST')) postCalls.push({ route, body })
        return Promise.resolve('request')
      })
      github.request.endpoint = jest.fn().mockImplementation((route, body) => ({ url: route, body }))
      github.request.endpoint.merge = jest.fn().mockReturnValue({ method: 'GET', url: '/orgs/jitran/rulesets', headers: version })

      const plugin = configure([bypassRuleset({ name: 'my-team', actor_type: 'Team' })], 'org')
      await plugin.sync()

      expect(postCalls).toHaveLength(1)
      expect(postCalls[0].route).toBe('POST /orgs/{org}/rulesets')
      expect(postCalls[0].body.bypass_actors).toEqual([{ actor_id: 42, actor_type: 'Team', bypass_mode: 'always' }])
    })

    it('sync surfaces a resolution failure as an error in nop mode', async () => {
      github.paginate = jest.fn().mockResolvedValue([])
      const plugin = configure([bypassRuleset({ name: 'my-team', actor_id: 1, actor_type: 'Team' })], 'org', true)

      const result = await plugin.sync()
      const flat = result.flat()
      expect(flat.some(command => command.type === 'ERROR')).toBe(true)
    })
  })
})
