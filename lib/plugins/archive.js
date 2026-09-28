const NopCommand = require('../nopcommand')

module.exports = class Archive {
  constructor (nop, github, repo, settings, log) {
    this.github = github
    this.repo = repo
    this.settings = settings
    this.log = log
    this.nop = nop
  }

  async getRepo () {
    try {
      const { data } = await this.github.rest.repos.get({
        owner: this.repo.owner,
        repo: this.repo.repo
      })
      return data
    } catch (error) {
      if (error.status === 404) {
        return null
      }
      throw error
    }
  }

  async updateRepoArchiveStatus (archived) {
    const action = archived ? 'archive' : 'unarchive'

    if (this.nop) {
      const change = { msg: 'Change found', additions: {}, modifications: { archived: action }, deletions: {} }
      return new NopCommand(
        this.constructor.name,
        this.repo,
        this.github.rest.repos.update.endpoint(this.settings),
        change,
        'INFO'
      )
    }

    const { data } = await this.github.rest.repos.update({
      owner: this.repo.owner,
      repo: this.repo.repo,
      archived
    })

    this.log.debug({ result: data }, `Repo ${this.repo.owner}/${this.repo.repo} ${action}d`)
  }

  getDesiredArchiveState () {
    if (typeof this.settings?.archived === 'undefined') {
      return null
    }
    return typeof this.settings.archived === 'boolean'
      ? this.settings.archived
      : this.settings.archived === 'true'
  }

  shouldArchive (repository = this.repository) {
    const desiredState = this.getDesiredArchiveState()
    if (desiredState === null) return false
    return !repository?.archived && desiredState
  }

  shouldUnarchive (repository = this.repository) {
    const desiredState = this.getDesiredArchiveState()
    if (desiredState === null) return false
    return repository?.archived && !desiredState
  }

  isArchived () {
    return this.repository?.archived
  }

  async getState () {
    this.repository = await this.getRepo()

    return {
      isArchived: this.isArchived(),
      shouldArchive: this.shouldArchive(),
      shouldUnarchive: this.shouldUnarchive()
    }
  }

  async sync () {
    this.repository = await this.getRepo()

    const results = []

    if (!this.repository) {
      this.log.warn(`Repo ${this.repo.owner}/${this.repo.repo} not found, skipping archive sync`)
      return results
    }

    const shouldArchive = this.shouldArchive()
    const shouldUnarchive = this.shouldUnarchive()

    if (!shouldArchive && !shouldUnarchive) {
      this.log.debug(`No archive changes needed for ${this.repo.owner}/${this.repo.repo}`)
      return results
    }

    const archived = shouldArchive
    results.push(await this.updateRepoArchiveStatus(archived))

    return results
  }
}
