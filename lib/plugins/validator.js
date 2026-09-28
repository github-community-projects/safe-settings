const NopCommand = require('../nopcommand')
module.exports = class Validator {
  constructor (nop, github, repo, settings, log) {
    this.github = github
    this.pattern = settings.pattern
    // this.regex = /[a-zA-Z0-9_-]+_\w[a-zA-Z0-9_-]+.*/gm
    this.regex = new RegExp(this.pattern, 'gm')
    this.repo = repo
    this.log = log
    this.nop = nop
  }

  sync () {
    try {
      return this.github.rest.repos.getAllTopics({
        owner: this.repo.owner,
        repo: this.repo.repo,
        mediaType: {
          previews: ['mercy']
        }
      }).then(res => {
        if (this.repo.repo.search(this.regex) >= 0) {
          this.log.debug(`Repo ${this.repo.repo} Passed Validation for pattern ${this.pattern}`)
          if (this.nop) {
            return Promise.resolve([
              new NopCommand(this.constructor.name, this.repo, null, `Passed Validation for pattern ${this.pattern}`)
            ])
          }
          if (res.data.names.find(x => x === 'validation-error')) {
            res.data.names = res.data.names.filter(x => x !== 'validation-error')
            return this.github.rest.repos.replaceAllTopics({
              owner: this.repo.owner,
              repo: this.repo.repo,
              names: res.data.names,
              mediaType: {
                previews: ['mercy']
              }
            })
          }
        } else {
          this.log.debug(`Repo ${this.repo.repo} Failed Validation for pattern ${this.pattern}`)
          if (this.nop) {
            return Promise.resolve([
              new NopCommand(this.constructor.name, this.repo, null, `Failed Validation for pattern ${this.pattern}`, 'ERROR')
            ])
          }
          if (!res.data.names.find(x => x === 'validation-error')) {
            res.data.names.push('validation-error')
            return this.github.rest.repos.replaceAllTopics({
              owner: this.repo.owner,
              repo: this.repo.repo,
              names: res.data.names,
              mediaType: {
                previews: ['mercy']
              }
            })
          }
        }
      })
        .catch(() => {})
    } catch (error) {
      this.log.debug(`Error in Validation checking ${error}`)
    }
  }
}
