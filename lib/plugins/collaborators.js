/* eslint-disable camelcase */
const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')

const DIRECT_ROLES_QUERY = `query ($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    collaborators(affiliation: DIRECT, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { login } permissionSources { roleName source { __typename } } }
    }
  }
}`

// GraphQL role names of the built-in roles that the config names differently
const ROLE_ALIASES = { write: 'push', read: 'pull' }

module.exports = class Collaborators extends Diffable {
  constructor (...args) {
    super(...args)

    if (this.entries) {
      // Force all usernames to lowercase to avoid comparison issues.
      this.entries.forEach(collaborator => {
        collaborator.username = collaborator.username.toLowerCase()
      })
    }
  }

  find () {
    // https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2026-03-10
    // 'outside' means all outside collaborators of an organization-owned repository.
    // 'direct' means all collaborators with permissions to an organization-owned repository, regardless of organization membership status. (includes outside collaborators)
    // 'all' means all collaborators the authenticated user can see.
    // We are using 'direct' to avoid double listing users outside collaborators and team members.
    const directRoles = this.findDirectRoles().catch(e => {
      this.log.debug(`Could not read direct collaborator roles of ${this.repo.owner}/${this.repo.repo}, comparing effective permissions: ${e}`)
      return null
    })
    return Promise.all([this.github.rest.repos.listCollaborators({ repo: this.repo.repo, owner: this.repo.owner, affiliation: 'direct' }),
      this.github.rest.repos.listInvitations({ repo: this.repo.repo, owner: this.repo.owner }), directRoles])
      .then(res => {
        const mapCollaborator = user => {
          const username = user.login.toLowerCase()
          return {
            // Force all usernames to lowercase to avoid comparison issues.
            username,
            pendinginvite: false,
            // The direct role if known. An undefined role always compares as changed, so the update is sent.
            permission: res[2]
              ? res[2].get(username)
              // Order matters: higher roles also set the flags of the lower ones.
              : (user.permissions.admin && 'admin') ||
                (user.permissions.maintain && 'maintain') ||
                (user.permissions.push && 'push') ||
                (user.permissions.triage && 'triage') ||
                (user.permissions.pull && 'pull')
          }
        }

        const results1 = (res[0].data || []).map(mapCollaborator)
        const results2 = (res[1].data || []).map(invite => {
          return {
          // Force all usernames to lowercase to avoid comparison issues.
            username: invite.invitee.login.toLowerCase(),
            pendinginvite: true,
            invitation_id: invite.id,
            permission: (invite.permissions === 'admin' && 'admin') ||
            (invite.permissions === 'maintain' && 'maintain') ||
            (invite.permissions === 'write' && 'push') ||
            (invite.permissions === 'triage' && 'triage') ||
            (invite.permissions === 'read' && 'pull')
          }
        })
        return results1.concat(results2)
      })
      .catch(e => {
        this.logError(e)
        return []
      })
  }

  // The REST permissions and role_name are the effective role from all sources (repo, teams, org),
  // so a custom role reads as its base role and a team grant can hide the direct one.
  // GraphQL permissionSources lists each grant separately; the Repository source is the direct grant.
  // Returns a Map of lowercased login to direct role, undefined when there is no single direct role.
  async findDirectRoles () {
    const roles = new Map()
    let cursor = null
    do {
      const { repository } = await this.github.graphql(DIRECT_ROLES_QUERY, { owner: this.repo.owner, repo: this.repo.repo, cursor })
      const { edges, pageInfo } = repository.collaborators
      for (const { node, permissionSources } of edges) {
        const names = new Set(permissionSources
          .filter(({ source, roleName }) => source.__typename === 'Repository' && roleName)
          .map(({ roleName }) => ROLE_ALIASES[roleName] || roleName))
        roles.set(node.login.toLowerCase(), names.size === 1 ? [...names][0] : undefined)
      }
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
    } while (cursor)
    return roles
  }

  comparator (existing, attrs) {
    return existing.username === attrs.username
  }

  changed (existing, attrs) {
    return existing.permission !== attrs.permission
  }

  update (existing, attrs) {
    if (existing.pendinginvite) {
      return this.updateInvite(existing.invitation_id, attrs.permission)
    } else {
      return this.add(attrs)
    }
  }

  add (attrs) {
    const data = Object.assign({}, attrs, this.repo)
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.addCollaborator.endpoint(data), 'Add Collaborators')
      ])
    }
    return this.github.rest.repos.addCollaborator(data)
  }

  updateInvite (invitation_id, permissions) {
    const data = Object.assign({
      invitation_id,
      permissions: (permissions === 'admin' && 'admin') ||
      (permissions === 'maintain' && 'maintain') ||
      (permissions === 'push' && 'write') ||
      (permissions === 'triage' && 'triage') ||
      (permissions === 'pull' && 'read')
    }, this.repo)
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.updateInvitation.endpoint(data), 'Update Invitation')
      ])
    }
    return this.github.rest.repos.updateInvitation(data)
  }

  remove (existing) {
    if (existing.pendinginvite) {
      const data = Object.assign({ invitation_id: existing.invitation_id }, this.repo)
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.deleteInvitation.endpoint(data),
            'Delete Invitation')
        ])
      }
      return this.github.rest.repos.deleteInvitation(data)
    } else {
      const data = Object.assign({ username: existing.username }, this.repo)
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, this.repo, this.github.rest.repos.removeCollaborator.endpoint(data),
            'Remove Collaborator')
        ])
      }
      return this.github.rest.repos.removeCollaborator(data)
    }
  }
}
