const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')
const MergeDeep = require('../mergeDeep')
const Overrides = require('./overrides')
const ignorableFields = []
const overrides = {
  required_status_checks: {
    action: 'delete',
    parents: 3,
    type: 'dict'
  }
}

const version = {
  'X-GitHub-Api-Version': '2026-03-10'
}

// GitHub's built-in (base) repository role IDs. These are not returned by the
// custom-repository-roles API, so they are mapped statically here to allow
// users to reference them by name in a ruleset's bypass_actors. Custom roles
// are resolved dynamically via GET /orgs/{org}/custom-repository-roles.
const BASE_REPOSITORY_ROLE_IDS = {
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5
}

module.exports = class Rulesets extends Diffable {
  constructor (nop, github, repo, entries, log, errors, scope) {
    super(nop, github, repo, entries, log, errors)
    this.github = github
    this.repo = repo
    this.rulesets = entries
    this.log = log
    this.nop = nop
    this.scope = scope || 'repo'
    // Cache for name -> id lookups, scoped to a single sync() invocation.
    this.idCache = new Map()
  }

  // Resolve human-friendly names to the numeric ids GitHub expects before the
  // normal Diffable sync runs. This lets users define rulesets using a team
  // slug, username, GitHub App slug, or repository role name instead of having
  // to look up the corresponding id. Names are resolved in place and the helper
  // attribute is removed so the payload matches what GitHub returns (which only
  // contains ids), keeping compareDeep stable and backward compatible with
  // policies that already use ids.
  async sync () {
    try {
      await this.resolveNamesToIds()
    } catch (e) {
      return this.handleError(e)
    }
    return super.sync()
  }

  async resolveNamesToIds () {
    if (!this.entries) return
    this.idCache = new Map()
    for (const ruleset of this.entries) {
      if (Array.isArray(ruleset.bypass_actors)) {
        for (const actor of ruleset.bypass_actors) {
          await this.resolveBypassActor(actor)
        }
      }
      const rules = Array.isArray(ruleset.rules) ? ruleset.rules : []
      for (const rule of rules) {
        const reviewers = rule && rule.parameters && rule.parameters.required_reviewers
        if (Array.isArray(reviewers)) {
          for (const entry of reviewers) {
            await this.resolveReviewer(entry)
          }
        }
      }
    }
  }

  async resolveBypassActor (actor) {
    if (!actor || actor.name === undefined || actor.name === null) return
    if (actor.actor_id !== undefined && actor.actor_id !== null) {
      throw new Error(`Ruleset bypass_actor cannot specify both 'name' ('${actor.name}') and 'actor_id' (${actor.actor_id}). Use one or the other.`)
    }
    actor.actor_id = await this.resolveActorId(actor.actor_type, actor.name)
    delete actor.name
  }

  async resolveReviewer (entry) {
    const reviewer = entry && entry.reviewer
    if (!reviewer || reviewer.slug === undefined || reviewer.slug === null) return
    if (reviewer.id !== undefined && reviewer.id !== null) {
      throw new Error(`Ruleset required_reviewer cannot specify both 'slug' ('${reviewer.slug}') and 'id' (${reviewer.id}). Use one or the other.`)
    }
    reviewer.id = await this.resolveTeamId(reviewer.slug)
    delete reviewer.slug
  }

  async resolveActorId (actorType, name) {
    switch (actorType) {
      case 'Team':
        return this.resolveTeamId(name)
      case 'User':
        return this.resolveUserId(name)
      case 'Integration':
        return this.resolveIntegrationId(name)
      case 'RepositoryRole':
        return this.resolveRepositoryRoleId(name)
      default:
        throw new Error(`Cannot resolve 'name' '${name}' for actor_type '${actorType}'. Name resolution is only supported for Team, User, Integration, and RepositoryRole. Use 'actor_id' instead.`)
    }
  }

  async cachedLookup (key, fn) {
    if (this.idCache.has(key)) return this.idCache.get(key)
    const value = await fn()
    this.idCache.set(key, value)
    return value
  }

  async resolveTeamId (slug) {
    return this.cachedLookup(`Team:${slug}`, async () => {
      try {
        const res = await this.github.rest.teams.getByName({ org: this.repo.owner, team_slug: slug })
        return res.data.id
      } catch (e) {
        throw new Error(`Unable to resolve Team slug '${slug}' to an id in org '${this.repo.owner}': ${e.status || e.message}`)
      }
    })
  }

  async resolveUserId (username) {
    return this.cachedLookup(`User:${username}`, async () => {
      try {
        const res = await this.github.request('GET /users/{username}', { username })
        return res.data.id
      } catch (e) {
        throw new Error(`Unable to resolve User '${username}' to an id: ${e.status || e.message}`)
      }
    })
  }

  async resolveIntegrationId (slug) {
    return this.cachedLookup(`Integration:${slug}`, async () => {
      try {
        const res = await this.github.request('GET /apps/{app_slug}', { app_slug: slug })
        return res.data.id
      } catch (e) {
        throw new Error(`Unable to resolve Integration (GitHub App) slug '${slug}' to an id: ${e.status || e.message}`)
      }
    })
  }

  async resolveRepositoryRoleId (name) {
    return this.cachedLookup(`RepositoryRole:${name}`, async () => {
      const baseId = BASE_REPOSITORY_ROLE_IDS[String(name).toLowerCase()]
      if (baseId !== undefined) return baseId
      try {
        const res = await this.github.request('GET /orgs/{org}/custom-repository-roles', { org: this.repo.owner })
        const roles = (res.data && res.data.custom_roles) || []
        const match = roles.find(role => role.name === name)
        if (!match) {
          throw new Error(`no custom repository role named '${name}' found in org '${this.repo.owner}'`)
        }
        return match.id
      } catch (e) {
        throw new Error(`Unable to resolve RepositoryRole '${name}' to an id: ${e.status || e.message}`)
      }
    })
  }

  // Find all Rulesets for this org
  find () {
    if (this.scope === 'org') {
      this.log.debug(`Getting all rulesets for the org ${this.org}`)

      const listOptions = this.github.request.endpoint.merge('GET /orgs/{org}/rulesets', {
        org: this.repo.owner,
        headers: version
      })
      this.log.debug(listOptions)
      return this.github.paginate(listOptions)
        .then(res => {
          const rulesets = res.map(ruleset => {
            if (ruleset.source_type === 'Organization') {
              const getOptions = this.github.request.endpoint.merge('GET /orgs/{org}/rulesets/{id}', {
                org: this.repo.owner,
                id: ruleset.id,
                headers: version
              })
              return this.github.paginate(getOptions)
            } else {
              return Promise.resolve([])
            }
          })
          return Promise.all(rulesets).then(res => {
            return res ? res.flat(1) : []
          })
        }).catch(e => {
          return this.handleError(e, [])
        })
    } else {
      this.log.debug(`Getting all rulesets for the repo ${this.repo}`)

      const listOptions = this.github.request.endpoint.merge('GET /repos/{owner}/{repo}/rulesets', {
        owner: this.repo.owner,
        repo: this.repo.repo,
        headers: version
      })
      this.log.debug(listOptions)
      return this.github.paginate(listOptions)
        .then(res => {
          const rulesets = res
            .filter(ruleset => ruleset.source_type === 'Repository')
            .map(ruleset => {
              const getOptions = this.github.request.endpoint.merge('GET /repos/{owner}/{repo}/rulesets/{id}', {
                owner: this.repo.owner,
                repo: this.repo.repo,
                id: ruleset.id,
                headers: version
              })
              return this.github.paginate(getOptions)
            })
          return Promise.all(rulesets).then(res => {
            return res ? res.flat(1) : []
          })
        }).catch(e => {
          if (this.nop && e.status === 404) return []
          return this.handleError(e, [])
        })
    }
  }

  isEmpty (maybeEmpty) {
    return (maybeEmpty === null) || Object.keys(maybeEmpty).length === 0
  }

  comparator (existing, attrs) {
    return existing.name === attrs.name
  }

  // Resolve {{EXTERNALLY_DEFINED}} placeholders against the matching live ruleset
  // before diffing, mirroring how branches.js resolves overrides inside its
  // comparison. Without this the comparison sees the literal placeholder string,
  // so every plan reports an update for rulesets that use overrides.
  resolveOverrides (existingRecords, entries) {
    return entries.map(attrs => {
      const existing = existingRecords.find(record => this.comparator(record, attrs))
      return Overrides.removeOverrides(overrides, structuredClone(attrs), existing || {})
    })
  }

  changed (existing, attrs) {
    const mergeDeep = new MergeDeep(this.log, this.github, ignorableFields)
    const merged = mergeDeep.compareDeep(existing, attrs)
    return merged.hasChanges
  }

  update (existing, attrs) {
    const parms = this.wrapAttrs(Object.assign({ id: existing.id }, attrs))
    if (this.scope === 'org') {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('PUT /orgs/{org}/rulesets/{id}', parms), 'Update Ruleset')
        ])
      }
      Overrides.removeOverrides(overrides, parms, existing)
      this.log.debug(`Updating Ruleset with the following values ${JSON.stringify(parms, null, 2)}`)
      return this.github.request('PUT /orgs/{org}/rulesets/{id}', parms).then(res => {
        this.log.debug(`Ruleset updated successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        return this.handleError(e)
      })
    } else {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('PUT /repos/{owner}/{repo}/rulesets/{id}', parms), 'Update Ruleset')
        ])
      }
      Overrides.removeOverrides(overrides, parms, existing)
      this.log.debug(`Updating Ruleset with the following values ${JSON.stringify(parms, null, 2)}`)
      return this.github.request('PUT /repos/{owner}/{repo}/rulesets/{id}', parms).then(res => {
        this.log.debug(`Ruleset updated successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        return this.handleError(e)
      })
    }
  }

  add (attrs) {
    if (this.scope === 'org') {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('POST /orgs/{org}/rulesets', this.wrapAttrs(attrs)), 'Create Ruleset')
        ])
      }
      Overrides.removeOverrides(overrides, attrs, {})
      this.log.debug(`Creating Rulesets with the following values ${JSON.stringify(attrs, null, 2)}`)
      return this.github.request('POST /orgs/{org}/rulesets', this.wrapAttrs(attrs)).then(res => {
        this.log.debug(`Ruleset created successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        return this.handleDuplicateOrError(e, attrs)
      })
    } else {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('POST /repos/{owner}/{repo}/rulesets', this.wrapAttrs(attrs)), 'Create Ruleset')
        ])
      }
      Overrides.removeOverrides(overrides, attrs, {})
      this.log.debug(`Creating Rulesets with the following values ${JSON.stringify(attrs, null, 2)}`)
      return this.github.request('POST /repos/{owner}/{repo}/rulesets', this.wrapAttrs(attrs)).then(res => {
        this.log.debug(`Ruleset created successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        return this.handleDuplicateOrError(e, attrs)
      })
    }
  }

  // A ruleset create (POST) is not idempotent. Octokit's retry / auth-app
  // layers can re-send a POST that already succeeded, and a repo can also be
  // processed by two overlapping syncs (e.g. a full sync racing with the
  // repository.created webhook). In both cases the second create hits
  // "Name must be unique" (422) even though the ruleset now exists. Instead of
  // failing the whole run, reconcile by looking the ruleset up by name and
  // updating it in place so the create effectively becomes idempotent.
  isDuplicateNameError (e) {
    if (!e || e.status !== 422) return false
    const errors = e.response && e.response.data && e.response.data.errors
    const list = Array.isArray(errors) ? errors : []
    return list.some(err => {
      const msg = typeof err === 'string' ? err : (err && err.message)
      return typeof msg === 'string' && /name must be unique/i.test(msg)
    })
  }

  handleDuplicateOrError (e, attrs) {
    if (!this.isDuplicateNameError(e)) {
      return this.handleError(e)
    }
    this.log.debug(`Ruleset '${attrs && attrs.name}' already exists (concurrent or retried create); reconciling by update`)
    return this.find().then(existing => {
      const match = Array.isArray(existing)
        ? existing.find(record => this.comparator(record, attrs))
        : undefined
      if (!match) {
        return this.handleError(e)
      }
      const { id: _ignoredId, ...attrsWithoutId } = attrs || {}
      return this.update(match, attrsWithoutId)
    }).catch(err => this.handleError(err))
  }

  remove (existing) {
    const parms = this.wrapAttrs(Object.assign({ id: existing.id }))
    if (this.scope === 'org') {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('DELETE /orgs/{org}/rulesets/{id}', parms), 'Delete Ruleset')
        ])
      }
      this.log.debug(`Deleting Ruleset with the following values ${JSON.stringify(parms, null, 2)}`)
      return this.github.request('DELETE /orgs/{org}/rulesets/{id}', parms).then(res => {
        this.log.debug(`Ruleset deleted successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        return this.handleError(e)
      })
    } else {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('DELETE /repos/{owner}/{repo}/rulesets/{id}', parms), 'Delete Ruleset')
        ])
      }
      this.log.debug(`Deleting Ruleset with the following values ${JSON.stringify(parms, null, 2)}`)
      return this.github.request('DELETE /repos/{owner}/{repo}/rulesets/{id}', parms).then(res => {
        this.log.debug(`Ruleset deleted successfully ${JSON.stringify(res.url)}`)
        return res
      }).catch(e => {
        if (e.status === 404) {
          return
        }
        return this.handleError(e)
      })
    }
  }

  wrapAttrs (attrs) {
    if (this.scope === 'org') {
      return Object.assign({}, attrs, {
        org: this.repo.owner,
        headers: version
      })
    } else {
      return Object.assign({}, attrs, {
        owner: this.repo.owner,
        repo: this.repo.repo,
        headers: version
      })
    }
  }

  handleError (e, returnValue) {
    this.logError(e)
    if (this.nop) {
      return Promise.resolve([(new NopCommand(this.constructor.name, this.repo, null, `error: ${e}`, 'ERROR'))])
    }
    return Promise.resolve(returnValue)
  }
}
