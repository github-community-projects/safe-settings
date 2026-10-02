const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')
const MergeDeep = require('../mergeDeep')

// Fields returned by the API that we should ignore when diffing
const ignorableFields = ['id', 'organization', 'created_at', 'updated_at']

const version = {
  'X-GitHub-Api-Version': '2026-03-10'
}

module.exports = class CustomRepositoryRoles extends Diffable {
  constructor (nop, github, repo, entries, log, errors) {
    super(nop, github, repo, entries, log, errors)
    this.github = github
    this.repo = repo
    this.entries = entries
    this.log = log
    this.nop = nop
  }

  // Find all Custom Repository Roles for the org
  find () {
    this.log.debug(`Getting all custom repository roles for the org ${this.repo.owner}`)

    return this.github.request('GET /orgs/{org}/custom-repository-roles', {
      org: this.repo.owner,
      headers: version
    }).then(res => {
      const roles = (res && res.data && res.data.custom_roles) || []
      // Strip noise so deep-diff focuses on the configurable fields
      return roles.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        base_role: r.base_role,
        permissions: r.permissions
      }))
    }).catch(e => {
      return this.handleError(e, [])
    })
  }

  comparator (existing, attrs) {
    return existing.name === attrs.name
  }

  changed (existing, attrs) {
    const mergeDeep = new MergeDeep(this.log, this.github, ignorableFields)
    const merged = mergeDeep.compareDeep(existing, attrs)
    return merged.hasChanges
  }

  update (existing, attrs) {
    const parms = this.wrapAttrs(Object.assign({ role_id: existing.id }, attrs))
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('PATCH /orgs/{org}/custom-repository-roles/{role_id}', parms), 'Update Custom Repository Role')
      ])
    }
    this.log.debug(`Updating Custom Repository Role with the following values ${JSON.stringify(parms, null, 2)}`)
    return this.github.request('PATCH /orgs/{org}/custom-repository-roles/{role_id}', parms).then(res => {
      this.log.debug(`Custom Repository Role updated successfully ${JSON.stringify(res.url)}`)
      return res
    }).catch(e => {
      return this.handleError(e)
    })
  }

  add (attrs) {
    const parms = this.wrapAttrs(attrs)
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('POST /orgs/{org}/custom-repository-roles', parms), 'Create Custom Repository Role')
      ])
    }
    this.log.debug(`Creating Custom Repository Role with the following values ${JSON.stringify(parms, null, 2)}`)
    return this.github.request('POST /orgs/{org}/custom-repository-roles', parms).then(res => {
      this.log.debug(`Custom Repository Role created successfully ${JSON.stringify(res.url)}`)
      return res
    }).catch(e => {
      return this.handleError(e)
    })
  }

  remove (existing) {
    const parms = this.wrapAttrs({ role_id: existing.id })
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.request.endpoint('DELETE /orgs/{org}/custom-repository-roles/{role_id}', parms), 'Delete Custom Repository Role')
      ])
    }
    this.log.debug(`Deleting Custom Repository Role with the following values ${JSON.stringify(parms, null, 2)}`)
    return this.github.request('DELETE /orgs/{org}/custom-repository-roles/{role_id}', parms).then(res => {
      this.log.debug(`Custom Repository Role deleted successfully ${JSON.stringify(res.url)}`)
      return res
    }).catch(e => {
      if (e.status === 404) {
        return
      }
      return this.handleError(e)
    })
  }

  wrapAttrs (attrs) {
    return Object.assign({}, attrs, {
      org: this.repo.owner,
      headers: version
    })
  }

  handleError (e, returnValue) {
    this.logError(e)
    if (this.nop) {
      return Promise.resolve([(new NopCommand(this.constructor.name, this.repo, null, `error: ${e}`, 'ERROR'))])
    }
    return Promise.resolve(returnValue)
  }
}
