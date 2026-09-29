const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

const teamRepoEndpoint = '/orgs/:owner/teams/:team_slug/repos/:owner/:repo'
module.exports = class Teams extends Diffable {
  async find () {
    this.log.debug(`Finding teams for ${this.repo.owner}/${this.repo.repo}`)
    return this.github.paginate(this.github.rest.repos.listTeams, this.repo).then(res => {
      this.log.debug(`Found teams ${JSON.stringify(res)}`)
      return this.checkSecurityManager(res).then(teams => {
        // GitHub's team `name` is the display name, which can differ from `slug` (what config
        // entries and comparator()/changed() actually match on). Normalizing `name` to `slug` here
        // keeps the nop-mode diff (MergeDeep.compareDeep, which pairs array items by `name`) in sync
        // with the real add/update/remove decisions, which are always slug-based. This must happen
        // after checkSecurityManager(), which matches on the real display `name`.
        return teams.map(team => ({ ...team, name: team.slug }))
      })
    })
  }

  // remove all security manager teams
  async checkSecurityManager (teams) {
    try {
      // Uncomment the following lines to handle the deprecation of the teams api https://gh.io/security-managers-rest-api-sunset
      // but this would require a new permission on the app
      //
      // const roles = await this.github.paginate('GET /orgs/{org}/roles', { org: this.repo.owner })
      // const securityManagerRole = roles.find(role => role.name === 'security_manager')
      //
      // this.log.debug(`Calling API to get security managers ${JSON.stringify(this.github.request.endpoint('GET /orgs/{org}/roles/{role_id}/teams',
      //   {
      //     org: this.repo.owner,
      //     role_id: securityManagerRole.id
      //   }))} `)
      // const resp = await this.github.paginate('GET /orgs/{org}/roles/{role_id}/teams',
      //   {
      //     org: this.repo.owner,
      //     role_id: securityManagerRole.id
      //   })

      this.log.debug('Removing all security manager teams since they should not be handled here')
      this.log.debug(`Calling API to get security managers ${JSON.stringify(this.github.request.endpoint('GET /orgs/{org}/security-managers',
         {
            org: this.repo.owner
          }))} `)
      const resp = await this.github.paginate('GET /orgs/{org}/security-managers',
        { org: this.repo.owner })

      this.log.debug(`Response from the call is ${JSON.stringify(resp)}`)
      return teams.filter(team => !resp.some(sec => sec.name === team.name))
    } catch (e) {
      if (e.status === 404) {
        this.log.debug(`${this.repo.owner} Org does not have Security manager teams set up ${e}`)
      } else {
        this.log.error(
        `Unexpected error when fetching for security manager teams org ${this.repo.owner} = ${e}`
        )
      }
      return teams
    }
  }

  comparator (existing, attrs) {
    return existing.slug === attrs.name.toLowerCase()
  }

  changed (existing, attrs) {
    return existing.permission !== attrs.permission
  }

  update (existing, attrs) {
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint(`PUT ${teamRepoEndpoint}`, this.toParams(existing, attrs)), 'Add Teams to Repo')
      ])
    }
    return this.github.request(`PUT ${teamRepoEndpoint}`, this.toParams(existing, attrs))
  }

  add (attrs) {
    let existing = { team_id: 1 }
    this.log.debug(`Getting team with the parms ${JSON.stringify(attrs)}`)
    return this.github.rest.teams.getByName({ org: this.repo.owner, team_slug: attrs.name }).then(res => {
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
      team_slug: attrs.name,
      owner: this.repo.owner,
      repo: this.repo.repo,
      permission: attrs.permission
    }
  }
}
