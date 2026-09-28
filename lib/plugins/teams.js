const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

const teamRepoEndpoint = '/orgs/:owner/teams/:team_slug/repos/:owner/:repo'
const listExternalGroupsEndpoint = 'GET /orgs/{org}/external-groups'
const teamExternalGroupsEndpoint = '/orgs/{org}/teams/{team_slug}/external-groups'
const securityManagerRoleName = 'security_manager'
const safeSecurityManagerStatuses = [403, 404, 422]

module.exports = class Teams extends Diffable {
  // Override Diffable.sync to also reconcile the optional `external_group`
  // link on each team entry after the normal team-repo permission sync.
  // This runs regardless of whether the team-repo association was added,
  // updated, or already in sync -- so updating only `external_group` on a
  // team that already has correct repo permissions still triggers the link.
  async sync () {
    const res = await super.sync()
    if (!this.entries) return res

    const filtered = this.filterEntries()
    const entriesWithExternalGroup = filtered.filter(e => e && e.external_group)
    if (entriesWithExternalGroup.length === 0) return res

    const nopCommands = Array.isArray(res) ? res : []
    for (const attrs of entriesWithExternalGroup) {
      await this.syncExternalGroup(attrs, this.nop ? nopCommands : undefined)
    }
    return this.nop ? nopCommands : res
  }

  async find () {
    this.skipTeamDeletion = false
    this.securityManagerTeamIdentifiers = new Set()
    this.log.debug(`Finding teams for ${this.repo.owner}/${this.repo.repo}`)
    return this.github.paginate(this.github.rest.repos.listTeams, this.repo).then(res => {
      this.log.debug(`Found teams ${JSON.stringify(res)}`)
      return this.checkSecurityManager(res)
    })
  }

  // remove all security manager teams
  async checkSecurityManager (teams) {
    try {
      this.log.debug('Removing all security manager teams since they should not be handled here')
      this.log.debug(`Calling API to get organization roles ${JSON.stringify(this.github.request.endpoint('GET /orgs/{org}/organization-roles',
        {
          org: this.repo.owner
        }))} `)
      const rolesResp = await this.github.paginate('GET /orgs/{org}/organization-roles',
        { org: this.repo.owner })
      const roles = this.toArray(rolesResp, 'roles')
      const securityManagerRole = roles.find(role => this.isSecurityManagerRole(role))

      if (!securityManagerRole || !securityManagerRole.id) {
        this.log.debug(`${this.repo.owner} Org does not have a security manager organization role set up`)
        return teams
      }

      const params = {
        org: this.repo.owner,
        role_id: securityManagerRole.id
      }
      this.log.debug(`Calling API to get security manager teams ${JSON.stringify(this.github.request.endpoint('GET /orgs/{org}/organization-roles/{role_id}/teams', params))} `)
      const resp = await this.github.paginate('GET /orgs/{org}/organization-roles/{role_id}/teams', params)

      this.log.debug(`Response from the call is ${JSON.stringify(resp)}`)
      const securityManagerTeams = this.toArray(resp, 'teams')
      const securityManagerTeamIdentifiers = new Set(securityManagerTeams.flatMap(team => [team.slug, team.name].map(name => this.normalizeTeamIdentifier(name))).filter(Boolean))
      // Persist the identifiers so add()/update()/remove() can no-op for
      // security manager teams even when they appear in the config. Without
      // this, a configured security manager team would look "missing" from the
      // filtered existing list and Diffable.sync() would (re)add it here.
      this.securityManagerTeamIdentifiers = securityManagerTeamIdentifiers

      return teams.filter(team => !this.isSecurityManagerTeam(team, securityManagerTeamIdentifiers))
    } catch (e) {
      this.skipTeamDeletion = true
      const status = e && e.status
      if (safeSecurityManagerStatuses.includes(status)) {
        this.log.debug(`${this.repo.owner} Org security manager teams could not be fetched with status ${status}; keeping repository teams unchanged ${e}`)
      } else {
        this.log.error(
        `Unexpected error when fetching security manager teams for org ${this.repo.owner}; keeping repository teams unchanged ${e}`
        )
      }
      return teams
    }
  }

  toArray (resp, propertyName) {
    if (Array.isArray(resp)) {
      return resp
    }

    if (resp && Array.isArray(resp[propertyName])) {
      return resp[propertyName]
    }

    return []
  }

  isSecurityManagerRole (role) {
    return [role && role.name, role && role.slug]
      .map(name => this.normalizeRoleName(name))
      .includes(securityManagerRoleName)
  }

  normalizeRoleName (name) {
    if (typeof name !== 'string') {
      return ''
    }

    return name.trim().toLowerCase().replace(/[\s-]+/g, '_')
  }

  normalizeTeamIdentifier (name) {
    if (typeof name !== 'string') {
      return ''
    }

    return name.trim().toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  isSecurityManagerTeam (team, securityManagerTeamIdentifiers) {
    return [team.slug, team.name]
      .map(name => this.normalizeTeamIdentifier(name))
      .filter(Boolean)
      .some(name => securityManagerTeamIdentifiers.has(name))
  }

  // True when the given attrs/record refers to a discovered security manager
  // team. Security manager teams are intentionally not managed by this plugin,
  // so add()/update()/remove() must no-op for them even if they are present in
  // the config file.
  isConfiguredSecurityManagerTeam (attrs) {
    if (!this.securityManagerTeamIdentifiers || this.securityManagerTeamIdentifiers.size === 0) {
      return false
    }
    return this.isSecurityManagerTeam(attrs, this.securityManagerTeamIdentifiers)
  }

  skipSecurityManagerTeam (attrs, verb) {
    const teamName = (attrs && (attrs.name || attrs.slug)) || 'unknown'
    this.log.debug(`Skipping ${verb} of security manager team ${teamName} for repo ${this.repo.repo}; security manager teams are not managed here`)
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, null, `Skipping ${verb} of security manager team ${teamName}; security manager teams are not managed by safe-settings`, 'INFO')
      ])
    }
    return Promise.resolve()
  }

  comparator (existing, attrs) {
    return this.normalizeTeamIdentifier(existing.slug || existing.name) === this.normalizeTeamIdentifier(attrs.name)
  }

  changed (existing, attrs) {
    return existing.permission !== attrs.permission
  }

  update (existing, attrs) {
    if (this.isConfiguredSecurityManagerTeam(attrs)) {
      return this.skipSecurityManagerTeam(attrs, 'update')
    }
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint(`PUT ${teamRepoEndpoint}`, this.toParams(existing, attrs)), 'Add Teams to Repo')
      ])
    }
    return this.github.request(`PUT ${teamRepoEndpoint}`, this.toParams(existing, attrs))
  }

  add (attrs) {
    if (this.isConfiguredSecurityManagerTeam(attrs)) {
      return this.skipSecurityManagerTeam(attrs, 'add')
    }
    let existing = { team_id: 1 }
    this.log.debug(`Getting team with the parms ${JSON.stringify(attrs)}`)
    return this.github.rest.teams.getByName({ org: this.repo.owner, team_slug: this.normalizeTeamIdentifier(attrs.name) }).then(res => {
      existing = res.data
      this.log.debug(`adding team ${attrs.name} to repo ${this.repo.repo}`)
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.rest.teams.addOrUpdateRepoPermissionsInOrg.endpoint(this.toParams(existing, attrs)), 'Add Teams to Repo')
        ])
      }
      return this.github.rest.teams.addOrUpdateRepoPermissionsInOrg(this.toParams(existing, attrs)).then(res => {
        this.log.debug(`team added ${res}`)
      }).catch(e => {
        this.logError(`Error adding team to repo ${JSON.stringify(e)} with parms ${JSON.stringify(this.toParams(existing, attrs))}:\n`, e)
      })
    }).catch(e => {
      if (e.status === 404) {
        const createParam = {
          org: this.repo.owner,
          name: attrs.name
        }
        if (attrs.privacy) {
          createParam.privacy = attrs.privacy
        }
        this.log.debug(`Creating teams ${JSON.stringify(createParam)}`)
        if (this.nop) {
          return Promise.resolve([
            new NopCommand(this.constructor.name, this.repo, this.github.rest.teams.create.endpoint(createParam), 'Create Team')
          ])
        }
        return this.github.rest.teams.create(createParam).then(res => {
          this.log.debug(`team ${createParam.name} created`)
          existing = res.data
          this.log.debug(`adding team ${attrs.name} to repo ${this.repo.repo}`)
          return this.github.rest.teams.addOrUpdateRepoPermissionsInOrg(this.toParams(existing, attrs))
        }).catch(e => {
          this.logError('Error adding team: ', e)
        })
      }
    })
  }

  remove (existing) {
    if (this.isConfiguredSecurityManagerTeam(existing)) {
      return this.skipSecurityManagerTeam(existing, 'removal')
    }

    if (this.skipTeamDeletion) {
      const msg = `Skipping deletion of team ${existing.slug} from repo ${this.repo.repo} because security manager team discovery failed`
      this.log.debug(msg)
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, null, msg, 'INFO')
        ])
      }
      return Promise.resolve()
    }

    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint(
          `DELETE ${teamRepoEndpoint}`,
          { team_slug: existing.slug, ...this.repo, org: this.repo.owner }
        ), 'DELETE Team')
      ])
    }
    return this.github.request(
      `DELETE ${teamRepoEndpoint}`,
      { team_slug: existing.slug, ...this.repo, org: this.repo.owner }
    )
  }

  toParams (existing, attrs) {
    return {
      team_id: existing.id,
      org: this.repo.owner,
      team_slug: existing.slug || this.normalizeTeamIdentifier(attrs.name),
      owner: this.repo.owner,
      repo: this.repo.repo,
      permission: attrs.permission
    }
  }

  // Resolve the org's external-group display name -> group_id. Lazily builds
  // a per-org Map (name -> id) the first time it's needed within a sync, and
  // caches it on the shared `github` client so multiple repos / teams in the
  // same sync only paginate `GET /orgs/{org}/external-groups` once per org.
  // Returns null when the named group does not exist for the org (logs an
  // error so the user can correct their yaml).
  async resolveExternalGroupId (groupName) {
    if (!this.github.__externalGroupsCache) {
      this.github.__externalGroupsCache = new Map()
    }
    const cache = this.github.__externalGroupsCache
    const org = this.repo.owner
    if (!cache.has(org)) {
      try {
        // The external-groups endpoint returns { total_count, groups: [...] }
        // and is not in Octokit's known-pagination list, so we must pass a
        // map function that extracts the `groups` array from each page;
        // otherwise paginate() yields the raw response objects and we'd
        // silently fail to find any names.
        const groups = await this.github.paginate(
          listExternalGroupsEndpoint,
          { org, per_page: 100 },
          (response) => (response && response.data && response.data.groups) || []
        )
        const byName = new Map()
        for (const g of groups) {
          // Keys are lower-cased so lookups are case-insensitive, matching
          // the comparison used by the SCIM-sync workflow's
          // wait-for-scim-sync.py (which lower-cases both sides). Without
          // this, a yaml `external_group` value that differs only in case
          // from the IdP-provisioned display name would be reported as
          // "not found" even though the group exists and the CI gate
          // considers it synced.
          if (g && g.group_name) byName.set(g.group_name.toLowerCase(), g.group_id)
        }
        this.log.debug(`Loaded ${byName.size} external group(s) for org ${org}: ${JSON.stringify(Array.from(byName.keys()))}`)
        cache.set(org, byName)
      } catch (e) {
        this.logError(`Error listing external groups for org ${org}: ${e}`)
        // Cache an empty map so we don't retry-storm the API within this sync.
        cache.set(org, new Map())
      }
    }
    const id = cache.get(org).get(groupName.toLowerCase())
    if (id === undefined) {
      return null
    }
    return id
  }

  // Link a team to an external IdP group identified by display name. Only
  // acts when the team entry carries an `external_group` property. Idempotent:
  // checks the current link first and skips the PATCH if already linked to
  // the same group_id. Sets `this.hasChanges = true` only when a PATCH
  // actually fires, so the suborg re-evaluation logic in lib/settings.js sees
  // a real change signal.
  async syncExternalGroup (attrs, nopCommands) {
    const groupName = attrs && attrs.external_group
    if (!groupName) return

    const groupId = await this.resolveExternalGroupId(groupName)
    if (groupId === null) {
      const msg = `External group '${groupName}' not found for org ${this.repo.owner} (team '${attrs.name}'). This is expected if the team/group is newly added and has not finished SCIM-provisioning yet.`
      // Non-fatal: a brand-new team's external group commonly doesn't exist
      // yet until the Azure AD -> GitHub SCIM cycle completes, so this is
      // logged as a warning (not logError) to avoid failing the whole sync.
      this.log.warn(msg)
      // For PR dry-run / nop mode, surface it as a WARNING (not ERROR) in the
      // check_run output, so it's visible but doesn't mark the run as failed.
      if (this.nop && Array.isArray(nopCommands)) {
        nopCommands.push(new NopCommand(this.constructor.name, this.repo, null, msg, 'WARNING'))
      }
      return
    }

    // The external-groups endpoints key on the GitHub team slug, not the
    // display name. Normalize (as done elsewhere in this plugin, e.g. getByName
    // and toParams) so display names like "Platform & Security!" don't 404.
    const teamSlug = this.normalizeTeamIdentifier(attrs.name)

    const linkParams = {
      org: this.repo.owner,
      team_slug: teamSlug,
      group_id: groupId
    }

    if (this.nop) {
      if (Array.isArray(nopCommands)) {
        nopCommands.push(new NopCommand(
          this.constructor.name,
          this.repo,
          this.github.request.endpoint(`PATCH ${teamExternalGroupsEndpoint}`, linkParams),
          `Link team ${attrs.name} to external group '${groupName}'`
        ))
      }
      return
    }

    // Idempotency: skip the PATCH if the team is already linked to this group.
    try {
      const current = await this.github.request(`GET ${teamExternalGroupsEndpoint}`, {
        org: this.repo.owner,
        team_slug: teamSlug
      })
      const currentGroups = (current && current.data && current.data.groups) || []
      if (currentGroups.some(g => g.group_id === groupId)) {
        this.log.debug(`Team ${attrs.name} is already linked to external group '${groupName}' (id=${groupId}); skipping.`)
        return
      }
    } catch (e) {
      // 404 here means no current link; fall through to PATCH. Any other
      // error is non-fatal -- the PATCH itself is idempotent on the server.
      if (e.status !== 404) {
        this.logError(`Error fetching current external group for team ${attrs.name}: ${e}`)
      }
    }

    try {
      await this.github.request(`PATCH ${teamExternalGroupsEndpoint}`, linkParams)
      this.log.debug(`Linked team ${attrs.name} to external group '${groupName}' (id=${groupId}).`)
      // Surface this change so suborg re-evaluation (in lib/settings.js) and
      // other consumers see that the team plugin made a real change.
      this.hasChanges = true
    } catch (e) {
      this.logError(`Error linking team ${attrs.name} to external group '${groupName}' (id=${groupId}): ${e}`)
    }
  }
}
