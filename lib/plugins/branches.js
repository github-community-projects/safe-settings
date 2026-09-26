const ErrorStash = require('./errorStash')
const NopCommand = require('../nopcommand')
const MergeDeep = require('../mergeDeep')
const Overrides = require('./overrides')
const ignorableFields = []
const previewHeaders = { accept: 'application/vnd.github.hellcat-preview+json,application/vnd.github.luke-cage-preview+json,application/vnd.github.zzzax-preview+json' }
const overrides = {
  contexts: {
    action: 'reset',
    type: 'array'
  }
}

// GitHub API requires these fields to be present in updateBranchProtection calls
// See: https://docs.github.com/rest/branches/branch-protection#update-branch-protection
const requiredBranchProtectionDefaults = {
  required_status_checks: null,
  enforce_admins: null,
  restrictions: null
}

module.exports = class Branches extends ErrorStash {
  constructor (nop, github, repo, settings, log, errors) {
    super(errors)
    this.github = github
    this.repo = repo
    this.branches = structuredClone(settings)
    this.log = log
    this.nop = nop
  }

  sync () {
    return this.github.rest.repos.get(this.repo).then((currentRepo) => {
      return Promise.all(
        this.branches
          .filter(branch => branch.protection !== undefined)
          .map(branch => {
            const branchResults = []
            // If branch protection is empty
            if (this.isEmpty(branch.protection)) {
              let p = Object.assign(this.repo, { branch: branch.name })
              if (branch.name === 'default') {
                p = Object.assign(this.repo, { branch: currentRepo.data.default_branch })
                this.log.debug(`Deleting default branch protection for branch ${currentRepo.data.default_branch}`)
              }
              // Hack to handle closures and keep params from changing
              const params = Object.assign({}, p)
              if (this.nop) {
                branchResults.push(
                  new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.deleteBranchProtection.endpoint(params), 'Delete Branch Protection')
                )
                return Promise.resolve(branchResults)
              }

              return this.github.rest.repos.deleteBranchProtection(params).catch(e => { return [] })
            } else {
              // Branch protection is not empty
              let p = Object.assign(this.repo, { branch: branch.name })
              if (branch.name === 'default') {
                p = Object.assign(this.repo, { branch: currentRepo.data.default_branch })
                // this.log.debug(`Setting default branch protection for branch ${currentRepo.data.default_branch}`)
              }
              // Hack to handle closures and keep params from changing
              const params = Object.assign({}, p)
              return this.github.rest.repos.getBranchProtection(params).then((result) => {
                const mergeDeep = new MergeDeep(this.log, this.github, ignorableFields)
                const changes = mergeDeep.compareDeep({ branch: { protection: this.reformatAndReturnBranchProtection(structuredClone(result.data)) } }, { branch: { protection: Overrides.removeOverrides(overrides, branch.protection, result.data) } })
                const results = { msg: `The following changes will be applied to the branch protection for ${params.branch} branch`, additions: changes.additions, modifications: changes.modifications, deletions: changes.deletions }
                this.log.debug(`Result of compareDeep = ${JSON.stringify(results)}`)

                if (!changes.hasChanges) {
                  this.log.debug(`There are no changes for branch ${JSON.stringify(params)}. Skipping branch protection changes`)
                  if (this.nop) {
                    return Promise.resolve(branchResults)
                  }
                  return Promise.resolve()
                }

                this.log.debug(`There are changes for branch ${JSON.stringify(params)}\n ${JSON.stringify(changes)} \n Branch protection will be applied`)
                if (this.nop) {
                  branchResults.push(new NopCommand(this.constructor.name, this.repo, null, results))
                } else {
                  this.log.info(`Applying branch protection changes to ${params.branch} branch of ${this.repo.owner}/${this.repo.repo} (the diff is logged at debug level)`)
                }

                Object.assign(params, requiredBranchProtectionDefaults, this.reformatAndReturnBranchProtection(structuredClone(result.data)), Overrides.removeOverrides(overrides, branch.protection, result.data), { headers: previewHeaders })

                if (this.nop) {
                  branchResults.push(new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.updateBranchProtection.endpoint(params), 'Update Branch Protection'))
                  return Promise.resolve(branchResults)
                }
                this.log.debug(`Updating branch protection ${JSON.stringify(params)}`)
                return this.github.rest.repos.updateBranchProtection(params).then(res => this.log.debug(`Branch protection applied successfully ${JSON.stringify(res.url)}`)).catch(e => { this.logError(`Error applying branch protection ${JSON.stringify(e)}`); return [] })
              }).catch((e) => {
                if (e.status === 404) {
                  Object.assign(params, requiredBranchProtectionDefaults, Overrides.removeOverrides(overrides, branch.protection, {}), { headers: previewHeaders })
                  if (this.nop) {
                    branchResults.push(new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.updateBranchProtection.endpoint(params), 'Add Branch Protection'))
                    return Promise.resolve(branchResults)
                  }
                  this.log.debug(`Adding branch protection ${JSON.stringify(params)}`)
                  return this.github.rest.repos.updateBranchProtection(params).then(res => this.log.debug(`Branch protection applied successfully ${JSON.stringify(res.url)}`)).catch(e => { this.logError(`Error applying branch protection ${JSON.stringify(e)}`); return [] })
                } else {
                  this.logError(e)
                  if (this.nop) {
                    branchResults.push(new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.updateBranchProtection.endpoint(params), `${e}`, 'ERROR'))
                    return Promise.resolve(branchResults)
                  }
                }
              })
            }
          })
      ).then(res => {
        return res.flat(2)
      }) /* End of Promise.all */
    }).catch(e => {
      // Repo is not found
      if (e.status === 404) {
        return Promise.resolve([])
      }
    })
  }

  isEmpty (maybeEmpty) {
    return (maybeEmpty === null) || Object.keys(maybeEmpty).length === 0
  }

  reformatAndReturnBranchProtection (protection) {
    if (protection) {
      // Re-format the enabled protection attributes
      protection.required_conversation_resolution = protection.required_conversation_resolution && protection.required_conversation_resolution.enabled
      protection.allow_deletions = protection.allow_deletions && protection.allow_deletions && protection.allow_deletions.enabled
      protection.required_linear_history = protection.required_linear_history && protection.required_linear_history.enabled
      protection.enforce_admins = protection.enforce_admins && protection.enforce_admins.enabled
      protection.required_signatures = protection.required_signatures && protection.required_signatures.enabled
      protection.allow_force_pushes = protection.allow_force_pushes && protection.allow_force_pushes.enabled
      protection.block_creations = protection.block_creations && protection.block_creations.enabled
      protection.lock_branch = protection.lock_branch && protection.lock_branch.enabled
      protection.allow_fork_syncing = protection.allow_fork_syncing && protection.allow_fork_syncing.enabled
      if (protection.restrictions) {
        delete protection.restrictions.url
        protection.restrictions.users = Array.isArray(protection.restrictions.users)
          ? protection.restrictions.users.map(user => user.login || user)
          : []
        protection.restrictions.teams = Array.isArray(protection.restrictions.teams)
          ? protection.restrictions.teams.map(team => team.slug || team)
          : []
        protection.restrictions.apps = Array.isArray(protection.restrictions.apps)
          ? protection.restrictions.apps.map(app => app.slug || app)
          : []
      }
      if (protection.required_status_checks) {
        delete protection.required_status_checks.url
        delete protection.required_status_checks.contexts_url
        if (Array.isArray(protection.required_status_checks.contexts) && protection.required_status_checks.contexts.length === 0) {
          delete protection.required_status_checks.contexts
        }
      }
      if (protection.required_pull_request_reviews && !protection.required_pull_request_reviews.bypass_pull_request_allowances) {
        protection.required_pull_request_reviews.bypass_pull_request_allowances = { apps: [], teams: [], users: [] }
      }
    }
    return protection
  }
}
