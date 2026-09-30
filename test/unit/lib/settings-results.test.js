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

  describe('PR #1078 report markup regression', () => {
    const limit = 55536

    function expectSections (body, count) {
      // Only inspect the renderer's HTML containers, not Markdown/code values.
      expect(body.match(/<\/?(?:details|summary)>/g) || []).toEqual(
        Array.from({ length: count }, () => ['<details>', '<summary>', '</summary>', '</details>']).flat()
      )
      expect(body).not.toMatch(/<\/td>\s*<tr>/)
      expect(body).not.toMatch(/<tr>\s*<\/tr>/)
      expect(body.length).toBeLessThanOrEqual(limit)
    }

    function outputs () {
      expect(context.octokit.rest.checks.update).toHaveBeenCalledTimes(1)
      const check = context.octokit.rest.checks.update.mock.calls[0][0]
      const comments = context.octokit.rest.issues.createComment.mock.calls.map(([comment]) => {
        expect(comment).toMatchObject({ owner: 'test', repo: 'admin', issue_number: 1 })
        return comment.body
      })
      return { check, comments }
    }

    it.each(['change', 'error', 'mixed'])('renders populated, closed sections for %s results', async kind => {
      const change = new NopCommand('Repository', repo, null, {
        additions: {}, deletions: { description: 'before' }, modifications: { description: 'after' }
      })
      const error = new NopCommand('Repository', { ...repo, repo: 'failed-repo' }, null, 'fixture failure', 'ERROR')
      settings.results = kind === 'mixed' ? [change, error] : [kind === 'change' ? change : error]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments).toHaveLength(1)
      expect(check.conclusion).toBe(kind === 'change' ? 'success' : 'failure')
      for (const body of [check.output.summary, ...comments]) {
        expectSections(body, kind === 'mixed' ? 2 : 1)
        if (kind !== 'error') {
          expect(body).toContain('<summary>Repository — 1 repo, 1 setting changed</summary>')
          expect(body).toContain('**test-repo**\n- `Repository`\n  - ~ `description`\n    - before: `before`\n    - after: `after`\n\n</details>')
        }
        if (kind !== 'change') {
          expect(body).toContain('**failed-repo**:\n* fixture failure')
        }
      }
    })

    it('keeps warning and informational containers separate from change sections', async () => {
      settings.results = [
        command(),
        new NopCommand('Teams', repo, null, 'fixture warning', 'WARNING'),
        new NopCommand('disable_plugins', repo, null, 'fixture information')
      ]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(check.conclusion).toBe('success')
      expect(comments).toHaveLength(1)
      expectSections(comments[0], 3)
      expect(comments[0]).toContain('### Warnings\n<details>')
      expect(comments[0]).toContain('* fixture warning')
      for (const body of [check.output.summary, ...comments]) {
        expect(body).toContain('`enforce_admins`')
        expect(body).toContain('[disable_plugins] fixture information')
      }
      // Check summaries currently render errors and info, but not warnings.
      expectSections(check.output.summary, 2)
    })

    it('reports empty results without an empty change container', async () => {
      settings.results = [new NopCommand('Repository', repo, null, {
        additions: {}, deletions: {}, modifications: {}
      })]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(check.conclusion).toBe('success')
      expect(comments).toHaveLength(1)
      expect(comments[0]).toContain('_No changes to apply._')
      expect(comments[0]).toContain('### Errors\n`None`')
      expect(check.output.summary).toContain('No changes to apply.')
      for (const body of [check.output.summary, ...comments]) expectSections(body, 0)
    })

    it('renders non-repository subjects as populated app sections', async () => {
      settings.results = [{
        ...new NopCommand('app_installations', { repo: 'test (org)' }, null, {
          additions: ['added-repo'], deletions: ['removed-repo'], modifications: []
        }),
        subject: 'fixture-app',
        subjectType: 'app'
      }]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments).toHaveLength(1)
      expect(comments[0]).toContain('**Repos affected:** 0')
      for (const body of [check.output.summary, ...comments]) {
        expectSections(body, 1)
        expect(body).toContain('<summary>app_installations — 1 app, 2 settings changed</summary>')
        expect(body).toContain('**fixture-app**\n- + `added-repo`\n- - `removed-repo`\n\n</details>')
      }
    })

    it('escapes diff values instead of interpreting row markup as containers', async () => {
      settings.results = [new NopCommand('Repository', repo, null, {
        additions: { description: '<tr><td>fixture & value</td></tr>' }, deletions: {}, modifications: {}
      })]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments).toHaveLength(1)
      for (const body of [check.output.summary, ...comments]) {
        expectSections(body, 1)
        expect(body).toContain('`&lt;tr&gt;&lt;td&gt;fixture &amp; value&lt;/td&gt;&lt;/tr&gt;`')
      }
    })

    it('paginates long independent sections without splitting their containers or losing content', async () => {
      const fields = Object.fromEntries(Array.from({ length: 220 }, (_, i) => [`field-${i}`, 'x'.repeat(160)]))
      settings.results = ['First', 'Second', 'Third'].map(plugin =>
        new NopCommand(plugin, repo, null, { additions: fields, deletions: {}, modifications: {} })
      )

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments).toHaveLength(3)
      comments.forEach((body, i) => {
        expect(body).toContain(`config changes detected (${i + 1}/3)`)
        expectSections(body, 1)
        expect(body).toContain(`<summary>${['First', 'Second', 'Third'][i]} — 1 repo, 1 setting changed</summary>`)
        expect(body.match(/`field-\d+`/g)).toHaveLength(220)
        expect(body).toContain('`field-219`')
        expect(body).not.toContain('too many changes')
      })
      expect(check.output.summary).toContain('Detailed changed-field output is available in the pull request comment.')
      expectSections(check.output.summary, 0)
      expect(comments[2]).toContain('### Errors\n`None`')
    })

    it('retains the existing hard limit for a single oversized section', async () => {
      settings.results = [new NopCommand('Repository', repo, null, {
        additions: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field-${i}`, 'x'.repeat(160)])),
        deletions: {},
        modifications: {}
      })]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments.length).toBeGreaterThan(0)
      expect(comments[0]).toContain('<summary>Repository — 1 repo, 1 setting changed</summary>')
      expect(comments[0]).toContain('`field-0`')
      expect(comments[0]).toHaveLength(limit)
      expect(comments[0].endsWith('... (too many changes to report)')).toBe(true)
      for (const body of [check.output.summary, ...comments]) {
        expect(body.length).toBeLessThanOrEqual(limit)
        expect(body).not.toMatch(/<\/td>\s*<tr>/)
      }
    })

    it.each(['false', undefined])('keeps check reporting when CREATE_PR_COMMENT is %s', async enabled => {
      jest.replaceProperty(env, 'CREATE_PR_COMMENT', enabled)
      settings.results = [command()]

      await settings.handleResults()

      const { check, comments } = outputs()
      expect(comments).toEqual([])
      expectSections(check.output.summary, 1)
      expect(check.output.summary).toContain('`enforce_admins`')
    })
  })
})
