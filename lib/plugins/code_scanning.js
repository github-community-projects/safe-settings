const ErrorStash = require('./errorStash')
const NopCommand = require('../nopcommand')

// The config section name. NOP results carry it as their plugin, since the dry-run
// drift filter looks up the section by the lowercased plugin name.
const SECTION = 'code_scanning'
const DEFAULT_SETUP_FIELDS = ['state', 'query_suite', 'threat_model', 'languages', 'runner_type', 'runner_label']

module.exports = class CodeScanning extends ErrorStash {
  /**
   * The `default_setup.languages` of the highest-priority layer that declares them.
   * The generic deep merge concatenates arrays, but a lower layer's languages should be
   * replaced, so a repo can narrow or clear the list it inherits.
   *
   * @param {Array<object|undefined>} sections `code_scanning` sections, lowest priority first
   * @returns {string[]|undefined}
   */
  static declaredLanguages (sections) {
    let languages
    for (const section of sections) {
      if (Array.isArray(section?.default_setup?.languages)) {
        languages = section.default_setup.languages
      }
    }
    return languages
  }

  constructor (nop, github, repo, settings, log, errors) {
    super(errors)
    this.github = github
    this.repo = repo
    this.settings = settings
    this.log = log
    this.nop = nop
  }

  /**
   * Reconcile the repository's CodeQL default setup with `code_scanning.default_setup`.
   *
   * @see {@link https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration}
   */
  async sync () {
    this.hasChanges = false
    const desired = this.settings?.default_setup
    if (!desired) {
      return []
    }

    let current
    try {
      const { data } = await this.github.rest.codeScanning.getDefaultSetup({ owner: this.repo.owner, repo: this.repo.repo })
      current = data
    } catch (e) {
      return this.handleError('Error getting code scanning default setup', e)
    }

    const { modifications, deletions } = this.changes(current, desired)
    if (Object.keys(modifications).length === 0 && Object.keys(deletions).length === 0) {
      this.log.debug(`Code scanning default setup for ${this.repo.owner}/${this.repo.repo} already matches the config`)
      return []
    }
    this.hasChanges = true

    const params = { owner: this.repo.owner, repo: this.repo.repo, ...this.declaredFields(desired) }
    if (this.nop) {
      return [new NopCommand(
        SECTION,
        this.repo,
        this.github.rest.codeScanning.updateDefaultSetup.endpoint(params),
        { msg: 'Change found', additions: {}, modifications, deletions }
      )]
    }

    this.log.info(`Updating code scanning default setup for ${this.repo.owner}/${this.repo.repo}`)
    try {
      await this.github.rest.codeScanning.updateDefaultSetup(params)
    } catch (e) {
      return this.handleError('Error updating code scanning default setup', e)
    }
    return []
  }

  /**
   * The declared fields that differ from GitHub. With `state: not-configured` only the state
   * is compared, since GitHub keeps no other settings for a repository without default setup.
   * A field cleared to `[]` or `null` is a deletion holding GitHub's value: as a modification
   * its empty value would make the NOP report treat the change as empty and drop it.
   */
  changes (current, desired) {
    const fields = desired.state === 'not-configured' ? ['state'] : DEFAULT_SETUP_FIELDS
    const modifications = {}
    const deletions = {}
    for (const field of fields) {
      if (desired[field] === undefined) continue
      const same = field === 'languages'
        ? this.sameLanguages(current[field], desired[field])
        : current[field] === desired[field]
      if (same) continue
      const cleared = desired[field] === null || (Array.isArray(desired[field]) && desired[field].length === 0)
      if (cleared) {
        deletions[field] = current[field]
      } else {
        modifications[field] = desired[field]
      }
    }
    return { modifications, deletions }
  }

  sameLanguages (current = [], desired = []) {
    const currentSet = new Set(current)
    const desiredSet = new Set(desired)
    return currentSet.size === desiredSet.size && [...desiredSet].every(lang => currentSet.has(lang))
  }

  declaredFields (desired) {
    const fields = desired.state === 'not-configured' ? ['state'] : DEFAULT_SETUP_FIELDS
    return Object.fromEntries(fields.filter(field => desired[field] !== undefined).map(field => [field, desired[field]]))
  }

  handleError (msg, e) {
    const message = `${msg} for ${this.repo.owner}/${this.repo.repo}: ${e.status ? `${e.status} ` : ''}${e.message}`
    if (this.nop) {
      // As in Diffable: in a dry run the repo may not exist yet.
      if (e.status === 404) return []
      return [new NopCommand(SECTION, this.repo, null, message, 'ERROR')]
    }
    this.logError(message)
    return []
  }
}
