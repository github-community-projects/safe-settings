class NopCommand {
  constructor (pluginName, repo, endpoint, action, type = 'INFO', subject = null) {
    // Ergonomic overload: allow passing the subject in the `type` position so
    // callers can supply a subject while omitting the (default 'INFO') type,
    // e.g. new NopCommand(plugin, repo, endpoint, action, { name, type }).
    if (type !== null && typeof type === 'object') {
      subject = type
      type = 'INFO'
    }
    this.type = type
    this.plugin = pluginName
    this.repo = repo.repo
    // Optional presentation subject. Some plugins (e.g. app_installations)
    // operate on a non-repo entity — the "subject" of the change is a GitHub
    // App, not a repository. `subject` overrides the repo as the heading in the
    // PR-comment/check-run report, while `repo` is still used for grouping and
    // repo counts. Defaults to the repo so existing plugins are unaffected.
    this.subject = (subject && subject.name) || repo.repo
    this.subjectType = (subject && subject.type) || 'repo'
    this.endpoint = endpoint ? endpoint.url : ''
    this.body = endpoint ? endpoint.body : ''
    // check if action is a string
    if (typeof action === 'string') {
      this.action = { msg: action, additions: null, modifications: null, deletions: null }
    } else {
      this.action = action
    }
  }

  toString () {
    return `${this.plugin} plugin will perform ${this.action} using this API ${this.endpoint} passing ${JSON.stringify(this.body, null, 4)}`
  }
}
module.exports = NopCommand
