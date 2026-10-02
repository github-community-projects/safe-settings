// Base class to make it easy to check for changes to a list of items
//
//     class Thing extends Diffable {
//       find() {
//       }
//
//       comparator(existing, attrs) {
//       }
//
//       changed(existing, attrs) {
//       }
//
//       update(existing, attrs) {
//       }
//
//       add(attrs) {
//       }
//
//       remove(existing) {
//       }
//     }
const ErrorStash = require('./errorStash')
const MergeDeep = require('../mergeDeep')
const NopCommand = require('../nopcommand')
const Glob = require('../glob')
const ignorableFields = ['id', 'node_id', 'default', 'url']
module.exports = class Diffable extends ErrorStash {
  constructor (nop, github, repo, entries, log, errors) {
    super(errors)
    this.github = github
    this.repo = repo
    this.entries = entries
    this.log = log
    this.nop = nop
    // When true, remove() calls are suppressed (additive_plugins feature).
    // Callers (updateRepos) set this after construction; defaults to false.
    this.additive = false
  }

  filterEntries () {
    let filteredEntries = Array.from(this.entries)

    filteredEntries = filteredEntries.filter(attrs => {
      if (!Array.isArray(attrs.exclude)) return true

      const excludeGlobs = attrs.exclude.map(exc => new Glob(exc))
      const isExcluded = excludeGlobs.some(glob => glob.test(this.repo.repo))
      return !isExcluded
    })

    filteredEntries = filteredEntries.filter(attrs => {
      if (!Array.isArray(attrs.include)) return true

      const includeGlobs = attrs.include.map(exc => new Glob(exc))
      const isIncluded = includeGlobs.some(glob => glob.test(this.repo.repo))
      return isIncluded
    })

    filteredEntries = filteredEntries.map(e => {
      const { exclude, include, ...o } = e
      return o
    })
    return filteredEntries
  }

  sync () {
    const resArray = []
    // Will be set to true when this plugin makes (or would make, in nop mode)
    // any add/update/remove. Consumers (e.g. Settings suborg re-evaluation)
    // can read `plugin.hasChanges` after `sync()` resolves to know whether
    // anything actually changed for this repo.
    this.hasChanges = false
    if (this.entries) {
      let filteredEntries = this.filterEntries()
      // this.log.debug(`filtered entries are ${JSON.stringify(filteredEntries)}`)
      return this.find().then(existingRecords => {
        // Let plugins resolve config placeholders (e.g. {{EXTERNALLY_DEFINED}}) against
        // the live records before any comparison, so placeholders never report changes.
        if (typeof this.resolveOverrides === 'function') {
          filteredEntries = this.resolveOverrides(existingRecords, filteredEntries)
        }
        this.log.debug(` ${JSON.stringify(existingRecords, null, 2)} \n\n ${JSON.stringify(filteredEntries, null, 2)} `)

        const mergeDeep = new MergeDeep(this.log, this.github, ignorableFields)
        const compare = mergeDeep.compareDeep(existingRecords, filteredEntries)
        const results = { msg: 'Changes found', additions: compare.additions, modifications: compare.modifications, deletions: compare.deletions }
        this.log.debug(`Results of comparing ${this.constructor.name} diffable target ${JSON.stringify(existingRecords)} with source ${JSON.stringify(filteredEntries)} is ${JSON.stringify(results)}`)
        this.hasChanges = !!compare.hasChanges
        if (!compare.hasChanges) {
          this.log.debug(`There are no changes for ${this.constructor.name} for repo ${this.repo.repo}. Skipping changes`)
          return Promise.resolve()
        } else {
          if (this.nop) {
            resArray.push(new NopCommand(this.constructor.name, this.repo, null, results, 'INFO'))
          } else {
            this.log.info(`Applying ${this.constructor.name} changes to ${this.repo.owner}/${this.repo.repo} (the diff is logged at debug level)`)
          }
        }

        // Remove any null or undefined values from the diffables (usually comes from repo override)
        for (const entry of filteredEntries) {
          for (const key of Object.keys(entry)) {
            if (entry[key] === null || entry[key] === undefined) {
              delete entry[key]
            }
          }
        }
        // Delete any diffable that now only has name and no other attributes
        filteredEntries = filteredEntries.filter(entry => Object.keys(entry).filter(key => !MergeDeep.NAME_FIELDS.includes(key)).length !== 0)

        const changes = []

        if (this.additive) {
          // Additive mode: skip all remove() calls. In NOP mode, emit an INFO
          // message so PR reviewers can see what deletions are being suppressed.
          if (this.nop && compare.deletions && compare.deletions.length > 0) {
            resArray.push(new NopCommand(
              this.constructor.name,
              this.repo,
              null,
              `Additive mode active: ${compare.deletions.length} deletion(s) suppressed by additive_plugins`,
              'INFO'
            ))
          }
        } else {
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
        }

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

        // if (changes.length === 0) {
        //   if (this.nop) {
        //     return Promise.resolve([
        //       // {plugin: this.constructor.name, repo: this.repo, action: `No changes`},
        //     ])
        //   }
        // }
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
