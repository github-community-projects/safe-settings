const Settings = require('../../../lib/settings')
const Branches = require('../../../lib/plugins/branches')
const Rulesets = require('../../../lib/plugins/rulesets')
const NopCommand = require('../../../lib/nopcommand')
const env = require('../../../lib/env')

describe('Settings result deduplication', () => {
  let context
  let settings
  const repo = { owner: 'test', repo: 'test-repo' }

  beforeEach(() => {
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    context = {
      payload: {
        installation: { id: 123 },
        repository: { owner: { login: 'test' }, name: 'admin' },
        check_run: { id: 42, check_suite: { pull_requests: [{ number: 1 }] } }
      },
      octokit: {
        rest: {
          checks: { update: jest.fn().mockResolvedValue({}) },
          issues: { createComment: jest.fn().mockResolvedValue({}) }
        }
      },
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
    }
    settings = new Settings(true, context, repo, {}, 'main')
  })

  function command () {
    return new NopCommand('Branches', repo, {
      url: '/repos/test/test-repo/branches/main/protection',
      body: { enforce_admins: true }
    }, {
      msg: 'Branch protection changes',
      additions: {},
      modifications: { enforce_admins: true },
      deletions: {}
    })
  }

  it.each([
    ['endpoint', row => { row.endpoint = '/repos/test/test-repo/branches/develop/protection' }],
    ['body', row => { row.body.enforce_admins = false }],
    ['action message', row => { row.action.msg = 'Changes for develop' }],
    ['additions', row => { row.action.additions = { required_linear_history: true } }],
    ['modifications', row => { row.action.modifications = { enforce_admins: false } }],
    ['deletions', row => { row.action.deletions = { required_status_checks: null } }],
    ['subject', row => { row.subject = 'another-subject' }],
    ['subject type', row => { row.subjectType = 'app' }],
    ['suborg origin', row => { row.fromSubOrg = true }],
    ['type', row => { row.type = 'WARNING' }],
    ['repo', row => { row.repo = 'another-repo' }],
    ['plugin', row => { row.plugin = 'Repository' }]
  ])('removes exact duplicates but preserves a distinct %s', async (_name, change) => {
    const original = command()
    const distinct = structuredClone(original)
    change(distinct)
    settings.appendToResults([original, structuredClone(original), distinct, structuredClone(distinct)])

    await settings.handleResults()

    expect(settings.results).toEqual([original, distinct])
    expect(context.octokit.rest.checks.update).toHaveBeenCalledTimes(1)
    expect(context.octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  it.each(['webhook', 'full-sync'])('reports distinct same-message diffs once in %s mode', async mode => {
    if (mode === 'full-sync') {
      delete context.payload.check_run
      delete context.payload.repository
    }
    const first = command()
    const second = command()
    second.action.modifications = { required_linear_history: true }
    settings.appendToResults([first, structuredClone(first), second])

    await settings.handleResults()

    expect(settings.results).toEqual([first, second])
    if (mode === 'full-sync') {
      expect(context.log.info).toHaveBeenCalledWith(expect.stringContaining('2 planned change(s)'))
      expect(context.log.debug).toHaveBeenCalledWith({ results: [first, second] }, 'Dry-run results')
      expect(context.octokit.rest.checks.update).not.toHaveBeenCalled()
      expect(context.octokit.rest.issues.createComment).not.toHaveBeenCalled()
    } else {
      const check = context.octokit.rest.checks.update.mock.calls[0][0]
      expect(check).toMatchObject({ check_run_id: 42, conclusion: 'success' })
      const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
      expect(comment).toMatchObject({ owner: 'test', repo: 'admin', issue_number: 1 })
      for (const output of [check.output.summary, comment.body]) {
        expect(output.match(/`enforce_admins`/g)).toHaveLength(1)
        expect(output.match(/`required_linear_history`/g)).toHaveLength(1)
      }
    }
  })

  it('keeps each branch diff and operation through check-run and PR reporting', async () => {
    context.octokit.rest.repos = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      getBranchProtection: jest.fn().mockResolvedValue({
        data: { enforce_admins: { enabled: false }, required_linear_history: { enabled: false } }
      }),
      updateBranchProtection: Object.assign(jest.fn(), {
        endpoint: ({ branch, ...body }) => ({
          url: `/repos/test/test-repo/branches/${branch}/protection`, body
        })
      }),
      deleteBranchProtection: jest.fn()
    }
    const plugin = new Branches(true, context.octokit, repo, [
      { name: 'default', protection: { enforce_admins: true } },
      { name: 'develop', protection: { required_linear_history: true } }
    ], context.log, [])
    const results = await plugin.sync()
    expect(results).toHaveLength(4)
    settings.appendToResults([results, structuredClone(results)])

    await settings.handleResults()

    expect(settings.results).toEqual(results)
    const check = context.octokit.rest.checks.update.mock.calls[0][0]
    const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
    for (const output of [check.output.summary, comment.body]) {
      expect(output.match(/`branch.protection.enforce_admins`/g)).toHaveLength(1)
      expect(output.match(/`branch.protection.required_linear_history`/g)).toHaveLength(1)
    }
    expect(context.octokit.rest.repos.updateBranchProtection).not.toHaveBeenCalled()
    expect(context.octokit.rest.repos.deleteBranchProtection).not.toHaveBeenCalled()
  })

  it('preserves disable_plugins messages while removing their exact duplicates', async () => {
    const labels = new NopCommand('disable_plugins', repo, null, "Plugin 'labels' skipped")
    const teams = new NopCommand('disable_plugins', repo, null, "Plugin 'teams' skipped")
    settings.appendToResults([labels, teams, structuredClone(labels)])

    await settings.handleResults()

    expect(settings.results).toEqual([labels, teams])
    const check = context.octokit.rest.checks.update.mock.calls[0][0]
    const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
    for (const output of [check.output.summary, comment.body]) {
      expect(output.match(/Plugin 'labels' skipped/g)).toHaveLength(1)
      expect(output.match(/Plugin 'teams' skipped/g)).toHaveLength(1)
    }
  })

  it.each(['first', 'subsequent'])('preserves %s ruleset array additions through NOP, check-run and PR reporting', async stage => {
    const added = { name: 'new-policy', target: 'branch', enforcement: 'active', rules: [{ type: 'deletion' }] }
    const existing = stage === 'first'
      ? []
      : [{ id: 42, name: 'existing-policy', target: 'branch', enforcement: 'active', source_type: 'Repository', rules: [] }]
    context.octokit.paginate = jest.fn().mockResolvedValue(existing)
    context.octokit.request = jest.fn()
    context.octokit.request.endpoint = Object.assign(
      jest.fn((url, body) => ({ url, body })),
      { merge: jest.fn((url, params) => ({ url, ...params })) }
    )
    const entries = [...existing, added]
    const snapshot = structuredClone(entries)
    const plugin = new Rulesets(true, context.octokit, repo, entries, context.log, [])
    const results = (await plugin.sync()).flat()
    const summary = results.find(row => row.action.msg === 'Changes found')

    expect(summary.action).toEqual({
      msg: 'Changes found', additions: [added], modifications: [], deletions: []
    })
    expect(plugin.hasChanges).toBe(true)
    expect(results.map(row => row.action.msg)).toEqual(['Changes found', 'Create Ruleset'])
    expect(results[1].body).toMatchObject(added)
    expect(entries).toEqual(snapshot)
    expect(context.octokit.request).not.toHaveBeenCalled()
    settings.appendToResults(results)

    await settings.handleResults()

    expect(settings.results).toEqual(results)
    const check = context.octokit.rest.checks.update.mock.calls[0][0]
    const comment = context.octokit.rest.issues.createComment.mock.calls[0][0]
    for (const output of [check.output.summary, comment.body]) {
      expect(output).toContain('1 repo, 1 policy changed')
      expect(output).toContain('`new-policy`')
      expect(output).not.toContain('`0.')
      expect(output).not.toContain('existing-policy')
    }
  })

  it('preserves suborg provenance before filtering unchanged org rulesets', async () => {
    const rulesets = [{ name: 'managed', enforcement: 'active' }]
    settings.config = { rulesets }
    settings.baseConfig = { rulesets: structuredClone(rulesets) }
    settings.changedRepoNames = new Set(['changed-repo'])
    const drift = new NopCommand('Rulesets', { repo: 'test (org)' }, null, {
      msg: 'Ruleset changes',
      additions: [],
      modifications: [{ name: 'managed', enforcement: 'active' }],
      deletions: []
    })
    const suborg = { ...structuredClone(drift), fromSubOrg: true }
    settings.appendToResults([drift, suborg, structuredClone(suborg)])

    await settings.handleResults()

    expect(settings.results).toEqual([suborg])
    expect(context.octokit.rest.checks.update.mock.calls[0][0].output.summary).toContain('managed')
  })

  it('leaves apply-mode reporting on its existing path', async () => {
    settings.nop = false
    const createCheckRun = jest.spyOn(settings, 'createCheckRun').mockResolvedValue()
    const row = command()
    settings.results = [row, row]

    await settings.handleResults()

    expect(createCheckRun).toHaveBeenCalledTimes(1)
    expect(settings.results).toEqual([row, row])
    expect(context.octokit.rest.checks.update).not.toHaveBeenCalled()
    expect(context.octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  describe('opt-in PR comment summary', () => {
    const limit = 55536
    const footer = '\n\n- [ ] I have reviewed the changes and verified that they are intended.'
    const checkUrl = 'https://github.com/test/admin/runs/42'
    const originalFlag = env.PR_COMMENT_SUMMARY_ENABLED
    const bodies = () => context.octokit.rest.issues.createComment.mock.calls.map(([params]) => params.body)
    const header = (considered, affected, page = '') =>
      `#### :robot: Safe-Settings config changes detected${page}:\n\n**Repos considered:** ${considered}\n**Repos affected:** ${affected}\n\n`
    const summary = (errors, plugins) =>
      `**Errors:** ${errors} · **Plugins affected:** ${plugins}\n\nView the full per-repo breakdown: ${checkUrl}\n\n`
    const change = (plugin, name, value = true) => ({
      type: 'INFO',
      plugin,
      repo: name,
      action: { additions: {}, deletions: {}, modifications: { description: value } }
    })
    const message = (type, msg) => ({
      type,
      plugin: 'Repository',
      repo: 'test-repo',
      action: { msg, additions: null, deletions: null, modifications: null }
    })

    beforeEach(() => {
      env.PR_COMMENT_SUMMARY_ENABLED = 'true'
      context.payload.check_run.html_url = checkUrl
    })

    afterEach(() => {
      if (originalFlag === undefined) delete env.PR_COMMENT_SUMMARY_ENABLED
      else env.PR_COMMENT_SUMMARY_ENABLED = originalFlag
    })

    it.each([undefined, 'false', 'TRUE'])('preserves the exact default no-op comment for flag=%s', async flag => {
      env.PR_COMMENT_SUMMARY_ENABLED = flag
      await settings.handleResults()
      expect(bodies()).toEqual([`${header(0, 0)}_No changes to apply._\n\n### Errors\n\`None\``])
    })

    it('adds only opt-in metadata and an unchecked footer to no-op output', async () => {
      await settings.handleResults()
      expect(bodies()).toEqual([
        `${header(0, 0)}${summary(0, 'None')}_No changes to apply._\n\n### Errors\n\`None\`${footer}`
      ])
      expect(context.octokit.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'success'
      }))
    })

    it('counts distinct errors, rendered plugins and repositories across the operation without losing messages', async () => {
      const error = message('ERROR', 'first failure')
      settings.results = [
        change('Repository', 'test-repo'),
        change('Branches', 'test-repo'),
        change('Repository', 'second-repo'),
        change('Labels', 'unchanged-repo', {}),
        error, structuredClone(error), message('ERROR', 'second failure'),
        message('WARNING', 'needs attention'), message('INFO', 'intentionally skipped')
      ]
      env.PR_COMMENT_SUMMARY_ENABLED = 'false'
      await settings.handleResults()
      const defaultBody = bodies()[0]
      expect(defaultBody.startsWith(header(3, 2))).toBe(true)
      const defaultCheck = context.octokit.rest.checks.update.mock.calls[0][0]
      context.octokit.rest.issues.createComment.mockClear()
      env.PR_COMMENT_SUMMARY_ENABLED = 'true'
      await settings.handleResults()
      expect(bodies()).toEqual([
        defaultBody.replace(header(3, 2), header(3, 2) + summary(2, 'Repository, Branches')) + footer
      ])
      for (const text of ['first failure', 'second failure', 'needs attention', 'intentionally skipped']) {
        expect(bodies()[0].split(text)).toHaveLength(2)
      }
      const check = context.octokit.rest.checks.update.mock.calls[1][0]
      expect(check.conclusion).toBe('failure')
      expect(check.output.summary.replace(/Run on: `[^`]+`/, '')).toBe(defaultCheck.output.summary.replace(/Run on: `[^`]+`/, ''))
      expect(check.output.summary).not.toContain(footer)
    })

    it('does not count GitHub App subjects as affected repositories', async () => {
      settings.results = ['first-app', 'second-app'].map(subject => ({
        type: 'INFO',
        plugin: 'app_installations',
        repo: 'test (org)',
        subject,
        subjectType: 'app',
        action: { additions: ['test-repo'], deletions: [], modifications: [] }
      }))
      await settings.handleResults()
      expect(bodies()[0].startsWith(header(1, 0) + summary(0, 'app_installations'))).toBe(true)
      expect(bodies()[0]).toContain('app_installations — 2 apps, 2 settings changed')
      expect(bodies()[0]).toContain('**first-app**')
      expect(bodies()[0]).toContain('**second-app**')
      expect(context.octokit.rest.checks.update.mock.calls[0][0].output.summary).toContain('Number of repos affected: `0`')
    })

    it.each([undefined, '', 'undefined', 'not a URL', 'javascript:alert(1)'])('omits the link for an absent or invalid check URL %s', async htmlUrl => {
      context.payload.check_run.html_url = htmlUrl
      await settings.handleResults()
      expect(bodies()).toEqual([
        `${header(0, 0)}**Errors:** 0 · **Plugins affected:** None\n\n_No changes to apply._\n\n### Errors\n\`None\`${footer}`
      ])
    })

    it.each(['false', 'true'])('CREATE_PR_COMMENT=false suppresses comments for summary=%s but completes the check', async flag => {
      env.PR_COMMENT_SUMMARY_ENABLED = flag
      jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'false')
      settings.results = [command()]
      await settings.handleResults()
      expect(bodies()).toEqual([])
      expect(context.octokit.rest.checks.update).toHaveBeenCalledTimes(1)
    })

    it('does not require webhook fields for a summary-enabled full-sync NOP', async () => {
      delete context.payload.check_run
      delete context.payload.repository
      settings.results = [command()]
      await settings.handleResults()
      expect(bodies()).toEqual([])
      expect(context.octokit.rest.checks.update).not.toHaveBeenCalled()
      expect(context.log.info).toHaveBeenCalledWith(expect.stringContaining('1 planned change(s)'))
    })

    it('preserves every bounded section across pages with operation-wide counts and a footer on each', async () => {
      const plugins = ['Repository', 'Branches', 'Labels']
      settings.results = plugins.flatMap(plugin => Array.from({ length: 130 }, (_, i) =>
        change(plugin, `repo-${i}`, 'x'.repeat(200))))
      settings.results.push(message('ERROR', 'last-section error'), message('WARNING', 'last-section warning'), message('INFO', 'last-section info'))
      await settings.handleResults()
      const comments = bodies()
      expect(comments.length).toBeGreaterThan(1)
      for (const [index, body] of comments.entries()) {
        expect(body.startsWith(header(131, 130, ` (${index + 1}/${comments.length})`) + summary(1, plugins.join(', ')))).toBe(true)
        expect(body.endsWith(footer)).toBe(true)
        expect(body.length).toBeLessThanOrEqual(limit)
        expect(body).not.toContain('too many changes')
        expect(body.match(/<details>/g)?.length || 0).toBe(body.match(/<\/details>/g)?.length || 0)
      }
      const combined = comments.join('\n')
      for (const plugin of plugins) expect(combined.split(`<summary>${plugin} —`)).toHaveLength(2)
      for (let i = 0; i < 130; i++) expect(combined.split(`**repo-${i}**`)).toHaveLength(4)
      for (const kind of ['error', 'warning', 'info']) expect(combined.split(`last-section ${kind}`)).toHaveLength(2)
    })

    it('reserves the footer within the exact limit even when one section is truncated', async () => {
      settings.results = Array.from({ length: 600 }, (_, i) => change('Repository', `repo-${i}`, 'x'.repeat(200)))
      settings.results.push(message('ERROR', 'preserved trailing error'))
      await settings.handleResults()
      const comments = bodies()
      expect(comments).toHaveLength(2)
      expect(comments[0]).toHaveLength(limit)
      expect(comments[0].endsWith(`... (too many changes to report)${footer}`)).toBe(true)
      expect(comments[1].endsWith(`* preserved trailing error\n\n</details>${footer}`)).toBe(true)
      for (const [index, body] of comments.entries()) {
        expect(body.startsWith(header(601, 600, ` (${index + 1}/2)`) + summary(1, 'Repository'))).toBe(true)
        expect(body.length).toBeLessThanOrEqual(limit)
      }
      expect(context.octokit.rest.checks.update.mock.calls[0][0].output.summary.length).toBeLessThanOrEqual(limit)
    })

    it.each([-1, 0, 1])('handles a single error section at the final-body limit %+d without losing the footer', async offset => {
      settings.results = [message('ERROR', 'x')]
      await settings.handleResults()
      const fixedLength = bodies()[0].length - 1 - '_No changes to apply._\n\n'.length + ' (2/2)'.length
      context.octokit.rest.issues.createComment.mockClear()
      settings.results = [message('ERROR', 'x'.repeat(limit - fixedLength + offset))]
      await settings.handleResults()
      const [, body] = bodies()
      expect(bodies()).toHaveLength(2)
      expect(body).toHaveLength(Math.min(limit, limit + offset))
      expect(body.endsWith(footer)).toBe(true)
      expect(body.includes('... (too many changes to report)')).toBe(offset > 0)
      if (offset <= 0) expect(body.endsWith(`\n\n</details>${footer}`)).toBe(true)
    })
  })
})
