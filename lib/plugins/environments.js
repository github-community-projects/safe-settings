const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

module.exports = class Environments extends Diffable {
  constructor (...args) {
    super(...args)

    if (this.entries) {
      // The config is shared across every repo in a suborg, so normalise a copy
      // rather than the caller's objects.
      this.entries = structuredClone(this.entries)
      // Force all names to lowercase to avoid comparison issues.
      this.entries.forEach(environment => {
        environment.name = environment.name.toLowerCase()
        if (environment.variables) {
          environment.variables.forEach(variable => {
            variable.name = variable.name.toLowerCase()
          })
        }
        // Expand custom_branch_policies to match GitHub schema.
        if (environment.deployment_branch_policy && environment.deployment_branch_policy.custom_branch_policies) {
          const policies = []
          environment.deployment_branch_policy.custom_branch_policies.forEach(policy => {
            if (typeof policy === 'string') {
              // Convert string policy to object with type 'branch'
              policies.push({ name: policy, type: 'branch' })
            } else if (typeof policy === 'object' && Array.isArray(policy.names)) {
              policy.names.forEach(name => {
                policies.push({ name: name, type: policy.type })
              })
            }
          })
          environment.deployment_branch_policy.custom_branch_policies = policies
        }
      })
    }
  }

  async nopifyRequest (url, options, description) {
    if (!this.nop) {
      await this.github.request(url, options)
    } else {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, url, description)
      ])
    }
  }

  async find () {
    const { data: { environments } } = await this.github.request('GET /repos/:org/:repo/environments', {
      org: this.repo.owner,
      repo: this.repo.repo
    })

    const environmentsMapped = []

    for (const environment of environments) {
      const mapped = {
        name: environment.name.toLowerCase(),
        repo: this.repo.repo,
        wait_timer: (environment.protection_rules.find(rule => rule.type === 'wait_timer') || { wait_timer: 0 }).wait_timer,
        prevent_self_review: (environment.protection_rules.find(rule => rule.type === 'required_reviewers') || { prevent_self_review: false }).prevent_self_review,
        reviewers: (environment.protection_rules.find(rule => rule.type === 'required_reviewers') || { reviewers: [] }).reviewers.map(reviewer => ({ id: reviewer.reviewer.id, type: reviewer.type })),
        deployment_branch_policy: environment.deployment_branch_policy === null
          ? null
          : {
              protected_branches: (environment.deployment_branch_policy || { protected_branches: false }).protected_branches,
              custom_branch_policies: (environment.deployment_branch_policy || { custom_branch_policies: false }).custom_branch_policies && (await this.github.request('GET /repos/:org/:repo/environments/:environment_name/deployment-branch-policies', {
                org: this.repo.owner,
                repo: this.repo.repo,
                environment_name: environment.name
              })).data.branch_policies.map(policy => ({
                name: policy.name,
                type: policy.type
              }))
            },
        variables: (await this.github.request('GET /repos/:org/:repo/environments/:environment_name/variables', {
          org: this.repo.owner,
          repo: this.repo.repo,
          environment_name: environment.name
        })).data.variables.map(variable => ({ name: variable.name.toLowerCase(), value: variable.value })),
        deployment_protection_rules: (await this.github.request('GET /repos/:org/:repo/environments/:environment_name/deployment_protection_rules', {
          org: this.repo.owner,
          repo: this.repo.repo,
          environment_name: environment.name
        })).data.custom_deployment_protection_rules.map(rule => ({
          app_id: rule.app.id,
          id: rule.id
        }))
      }
      environmentsMapped.push(mapped)
      // console.log(mapped);
    }
    return environmentsMapped
  }

  comparator (existing, attrs) {
    return existing.name === attrs.name
  }

  getChanged (existing, attrs) {
    if (!attrs.wait_timer) attrs.wait_timer = 0
    if (!attrs.prevent_self_review) attrs.prevent_self_review = false
    if (!attrs.reviewers) attrs.reviewers = []
    if (!attrs.deployment_branch_policy) attrs.deployment_branch_policy = null
    if (!attrs.variables) attrs.variables = []
    if (!attrs.deployment_protection_rules) attrs.deployment_protection_rules = []

    const waitTimer = existing.wait_timer !== attrs.wait_timer
    const preventSelfReview = existing.prevent_self_review !== attrs.prevent_self_review
    const reviewers = JSON.stringify(existing.reviewers.sort((x1, x2) => x1.id - x2.id)) !== JSON.stringify(attrs.reviewers.sort((x1, x2) => x1.id - x2.id))

    let existingCustomBranchPolicies = existing.deployment_branch_policy === null ? null : existing.deployment_branch_policy.custom_branch_policies
    if (typeof (existingCustomBranchPolicies) === 'object' && existingCustomBranchPolicies !== null) {
      existingCustomBranchPolicies = existingCustomBranchPolicies.sort((x1, x2) => x1.name.localeCompare(x2.name))
    }
    let attrsCustomBranchPolicies = attrs.deployment_branch_policy === null ? null : attrs.deployment_branch_policy.custom_branch_policies
    if (typeof (attrsCustomBranchPolicies) === 'object' && attrsCustomBranchPolicies !== null) {
      attrsCustomBranchPolicies = attrsCustomBranchPolicies.sort((x1, x2) => x1.name.localeCompare(x2.name))
    }
    let deploymentBranchPolicy
    if (existing.deployment_branch_policy === attrs.deployment_branch_policy) {
      deploymentBranchPolicy = false
    } else {
      deploymentBranchPolicy = (
        (existing.deployment_branch_policy === null && attrs.deployment_branch_policy !== null) ||
                (existing.deployment_branch_policy !== null && attrs.deployment_branch_policy === null) ||
                (existing.deployment_branch_policy.protected_branches !== attrs.deployment_branch_policy.protected_branches) ||
                 (JSON.stringify(existingCustomBranchPolicies) !== JSON.stringify(attrsCustomBranchPolicies))
      )
    }

    const variables = JSON.stringify(existing.variables.sort((x1, x2) => x1.name - x2.name)) !== JSON.stringify(attrs.variables.sort((x1, x2) => x1.name - x2.name))
    const deploymentProtectionRules = JSON.stringify(existing.deployment_protection_rules.map(x => ({ app_id: x.app_id })).sort((x1, x2) => x1.app_id - x2.app_id)) !== JSON.stringify(attrs.deployment_protection_rules.map(x => ({ app_id: x.app_id })).sort((x1, x2) => x1.app_id - x2.app_id))

    return { waitTimer, preventSelfReview, reviewers, deploymentBranchPolicy, variables, deploymentProtectionRules }
  }

  changed (existing, attrs) {
    const { waitTimer, preventSelfReview, reviewers, deploymentBranchPolicy, variables, deploymentProtectionRules } = this.getChanged(existing, attrs)

    return waitTimer || preventSelfReview || reviewers || deploymentBranchPolicy || variables || deploymentProtectionRules
  }

  async update (existing, attrs) {
    const { waitTimer, preventSelfReview, reviewers, deploymentBranchPolicy, variables, deploymentProtectionRules } = this.getChanged(existing, attrs)
    const baseRequestOptions = {
      org: this.repo.owner,
      repo: this.repo.repo,
      environment_name: attrs.name
    }

    if (waitTimer || preventSelfReview || reviewers || deploymentBranchPolicy) {
      const options = {
        org: this.repo.owner,
        repo: this.repo.repo,
        environment_name: attrs.name,
        wait_timer: attrs.wait_timer,
        prevent_self_review: attrs.prevent_self_review,
        reviewers: attrs.reviewers,
        deployment_branch_policy: attrs.deployment_branch_policy === null
          ? null
          : {
              protected_branches: attrs.deployment_branch_policy.protected_branches,
              custom_branch_policies: !!attrs.deployment_branch_policy.custom_branch_policies
            }
      }
      await this.nopifyRequest('PUT /repos/:org/:repo/environments/:environment_name', options, 'Update environment settings')
    }

    if (deploymentBranchPolicy && attrs.deployment_branch_policy && attrs.deployment_branch_policy.custom_branch_policies) {
      const existingPolicies = (await this.github.request('GET /repos/:org/:repo/environments/:environment_name/deployment-branch-policies', baseRequestOptions)).data.branch_policies

      for (const policy of existingPolicies) {
        await this.nopifyRequest('DELETE /repos/:org/:repo/environments/:environment_name/deployment-branch-policies/:branch_policy_id', {
          ...baseRequestOptions,
          branch_policy_id: policy.id
        }, 'Delete deployment branch policy')
      }

      for (const policy of attrs.deployment_branch_policy.custom_branch_policies) {
        await this.nopifyRequest(
          'POST /repos/:org/:repo/environments/:environment_name/deployment-branch-policies', {
            ...baseRequestOptions,
            name: policy.name,
            type: policy.type
          }, 'Create deployment branch policy')
      }
    }

    if (variables) {
      let existingVariables = [...existing.variables]

      for (const variable of attrs.variables) {
        const existingVariable = existingVariables.find((_var) => _var.name === variable.name)
        if (existingVariable) {
          // Maintain a list of existing variables that will be deleted after the patch/post loop
          existingVariables = existingVariables.filter(_var => _var.name !== variable.name)
          if (existingVariable.value !== variable.value) {
            await this.nopifyRequest(
              'PATCH /repos/:org/:repo/environments/:environment_name/variables/:variable_name', {
                ...baseRequestOptions,
                variable_name: variable.name,
                value: variable.value
              }, 'Update environment variable'
            )
          }
        } else {
          await this.nopifyRequest(
            'POST /repos/:org/:repo/environments/:environment_name/variables', {
              ...baseRequestOptions,
              name: variable.name,
              value: variable.value
            }, 'Create environment variable'
          )
        }
      }

      for (const variable of existingVariables) {
        await this.nopifyRequest(
          'DELETE /repos/:org/:repo/environments/:environment_name/variables/:variable_name', {
            ...baseRequestOptions,
            variable_name: variable.name
          }, 'Delete environment variable'
        )
      }
    }

    if (deploymentProtectionRules) {
      const existingRules = [...existing.deployment_protection_rules]

      for (const rule of attrs.deployment_protection_rules) {
        const existingRule = existingRules.find((_rule) => _rule.id === rule.id)

        if (!existingRule) {
          await this.nopifyRequest(
            'POST /repos/:org/:repo/environments/:environment_name/deployment_protection_rules', {
              ...baseRequestOptions,
              integration_id: rule.app_id
            }, 'Create deployment protection rule'
          )
        }
      }
      for (const rule of existingRules) {
        await this.nopifyRequest('DELETE /repos/:org/:repo/environments/:environment_name/deployment_protection_rules/:rule_id', {
          ...baseRequestOptions,
          rule_id: rule.id
        }, 'Delete deployment protection rule')
      }
    }
  }

  async add (attrs) {
    const baseRequestOptions = {
      org: this.repo.owner,
      repo: this.repo.repo,
      environment_name: attrs.name
    }

    await this.nopifyRequest(
      'PUT /repos/:org/:repo/environments/:environment_name', {
        ...baseRequestOptions,
        wait_timer: attrs.wait_timer,
        prevent_self_review: attrs.prevent_self_review,
        reviewers: attrs.reviewers,
        deployment_branch_policy: attrs.deployment_branch_policy == null
          ? null
          : {
              protected_branches: !!attrs.deployment_branch_policy.protected_branches,
              custom_branch_policies: !!attrs.deployment_branch_policy.custom_branch_policies
            }
      }, 'Update environment settings')

    if (attrs.deployment_branch_policy && attrs.deployment_branch_policy.custom_branch_policies) {
      for (const policy of attrs.deployment_branch_policy.custom_branch_policies) {
        await this.nopifyRequest(
          'POST /repos/:org/:repo/environments/:environment_name/deployment-branch-policies', {
            ...baseRequestOptions,
            name: policy.name,
            type: policy.type
          }, 'Create deployment branch policy'
        )
      }
    }

    if (attrs.variables) {
      for (const variable of attrs.variables) {
        await this.nopifyRequest(
          'POST /repos/:org/:repo/environments/:environment_name/variables', {
            ...baseRequestOptions,
            name: variable.name,
            value: variable.value
          }, 'Create environment variable'
        )
      }
    }

    if (attrs.deployment_protection_rules) {
      for (const rule of attrs.deployment_protection_rules) {
        await this.nopifyRequest(
          'POST /repos/:org/:repo/environments/:environment_name/deployment_protection_rules', {
            ...baseRequestOptions,
            integration_id: rule.app_id
          }, 'Create deployment protection rule'
        )
      }
    }
  }

  async remove (existing) {
    const baseRequestOptions = {
      org: this.repo.owner,
      repo: this.repo.repo,
      environment_name: existing.name
    }

    await this.nopifyRequest(
      'DELETE /repos/:org/:repo/environments/:environment_name', {
        ...baseRequestOptions
      }, 'Delete environment'
    )
  }

  sync () {
    const resArray = []
    if (this.entries) {
      const filteredEntries = this.filterEntries()
      return this.find().then(existingRecords => {
        // Remove any null or undefined values from the diffables (usually comes from repo override)
        for (const entry of filteredEntries) {
          for (const key of Object.keys(entry)) {
            if (entry[key] === null || entry[key] === undefined) {
              delete entry[key]
            }
          }
        }
        // For environments, we want to keep the entries with only name defined.

        const changes = []

        existingRecords.forEach(x => {
          if (!filteredEntries.find(y => this.comparator(x, y))) {
            const change = this.remove(x).then(res => {
              if (this.nop) {
                return resArray.push(res)
              }
              return res
            })
            changes.push(change)
          }
        })

        filteredEntries.forEach(attrs => {
          const existing = existingRecords.find(record => {
            return this.comparator(record, attrs)
          })

          if (!existing) {
            const change = this.add(attrs).then(res => {
              if (this.nop) {
                return resArray.push(res)
              }
              return res
            })
            changes.push(change)
          } else if (this.changed(existing, attrs)) {
            const change = this.update(existing, attrs).then(res => {
              if (this.nop) {
                return resArray.push(res)
              }
              return res
            })
            changes.push(change)
          }
        })

        if (this.nop) {
          return Promise.resolve(resArray)
        }
        return Promise.all(changes)
      }).catch(e => {
        if (this.nop) {
          if (e.status === 404) {
            // Ignore 404s which can happen in dry-run as the repo may not exist.
            return Promise.resolve(resArray)
          } else {
            resArray.push(new NopCommand(this.constructor.name, this.repo, null, `error ${e} in ${this.constructor.name} for repo: ${JSON.stringify(this.repo)} entries ${JSON.stringify(this.entries)}`, 'ERROR'))
            return Promise.resolve(resArray)
          }
        } else {
          this.logError(`Error ${e} in ${this.constructor.name} for repo: ${JSON.stringify(this.repo)} entries ${JSON.stringify(this.entries)}`)
        }
      })
    }
  }
}
