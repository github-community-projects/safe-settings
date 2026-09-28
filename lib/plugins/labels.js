const Diffable = require('./diffable')
const NopCommand = require('../nopcommand')
const previewHeaders = { accept: 'application/vnd.github.symmetra-preview+json' }

module.exports = class Labels extends Diffable {
  constructor (nop, github, repo, entries, log, errors) {
    const { include, exclude = [] } = entries
    if (Array.isArray(include)) {
      // Config is object with include array
      // labels:
      //   include:
      //     - name: label
      super(nop, github, repo, include, log, errors)
    } else {
      // Config is array
      // labels:
      //   - name: label
      super(nop, github, repo, entries, log, errors)
    }
    this.exclude = exclude.filter(item => item?.name).map(item => new RegExp(item.name))

    if (this.entries) {
      this.entries.forEach(label => {
        // Force color to string since some hex colors can be numerical (e.g. 999999)
        if (label.color) {
          label.color = String(label.color).replace(/^#/, '')
          if (label.color.length < 6) {
            label.color.padStart(6, '0')
          }
        }
      })
    }
  }

  find () {
    this.log.debug(`Finding labels for ${JSON.stringify(this.wrapAttrs({ per_page: 100 }))}`)
    const options = this.github.rest.issues.listLabelsForRepo.endpoint.merge(this.wrapAttrs({ per_page: 100 }))
    return this.github.rest.repos.get(this.repo).then(() => {
      return this.github.paginate(options)
    })
      .catch(e => {
        this.logError(` Error ${JSON.stringify(e)}`)
        if (e.status === 404) {
          return Promise.resolve([])
        }
      })
  }

  comparator (existing, attrs) {
    return existing.name === attrs.name || existing.name === attrs.oldname || existing.name === attrs.current_name
  }

  changed (existing, attrs) {
    return attrs.oldname === existing.name || existing.color !== attrs.color || existing.description !== attrs.description
  }

  update (existing, attrs) {
    // Our settings file uses oldname for renaming labels,
    // however octokit/rest 16.30.1 uses the current_name attribute.
    // Future versions of octokit/rest will need name and new_name attrs.
    this.log.debug(`Updating labels for ${JSON.stringify(attrs, null, 4)}   ${JSON.stringify(this.repo, null, 4)}`)
    attrs.current_name = attrs.oldname || attrs.name
    delete attrs.oldname
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.rest.issues.updateLabel.endpoint(this.wrapAttrs(attrs)), 'Update label')
      ])
    }
    return this.github.rest.issues.updateLabel(this.wrapAttrs(attrs))
  }

  add (attrs) {
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.rest.issues.createLabel.endpoint(this.wrapAttrs(attrs)), 'Create label')
      ])
    }
    this.log.debug(`Creating labels for ${JSON.stringify(attrs, null, 4)}`)
    return this.github.rest.issues.createLabel(this.wrapAttrs(attrs)).catch(e => this.logError(` ${JSON.stringify(e)}`))
  }

  remove (existing) {
    if (this.isExcluded(existing)) {
      return Promise.resolve([])
    }
    if (this.nop) {
      return Promise.resolve([
        new NopCommand(this.constructor.name, this.repo, this.github.rest.issues.deleteLabel.endpoint(this.wrapAttrs({ name: existing.name })), 'Delete label')
      ])
    }
    return this.github.rest.issues.deleteLabel(this.wrapAttrs({ name: existing.name }))
  }

  wrapAttrs (attrs) {
    return Object.assign({}, attrs, this.repo, { headers: previewHeaders })
  }

  isExcluded (label) {
    return this.exclude.some(rx => rx.test(label.name))
  }
}
