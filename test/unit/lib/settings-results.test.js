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
    const truncation = '... (too many changes to report)'
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

    function expectFooterOutsideSections (body) {
      expect(body.endsWith(footer)).toBe(true)
      const sections = []
      for (const [tag, name] of body.slice(0, -footer.length).matchAll(/<\/?(details|summary)>/g)) {
        if (tag.startsWith('</')) expect(sections.pop()).toBe(name)
        else sections.push(name)
      }
      expect(sections).toEqual([])
    }

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
        expectFooterOutsideSections(body)
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
      expect(comments[0].endsWith(`${truncation}\n\n</details>${footer}`)).toBe(true)
      expect(comments[1].endsWith(`* preserved trailing error\n\n</details>${footer}`)).toBe(true)
      for (const [index, body] of comments.entries()) {
        expect(body.startsWith(header(601, 600, ` (${index + 1}/2)`) + summary(1, 'Repository'))).toBe(true)
        expect(body.length).toBeLessThanOrEqual(limit)
        expectFooterOutsideSections(body)
      }
      expect(context.octokit.rest.checks.update.mock.calls[0][0].output.summary.length).toBeLessThanOrEqual(limit)
    })

    it.each(['ERROR', 'WARNING', 'INFO'].flatMap(type => [-1, 0, 1].map(offset => [type, offset])))(
      'keeps the footer outside a %s section at the final-body limit %+d', async (type, offset) => {
        const heading = { ERROR: '### Errors', WARNING: '### Warnings', INFO: '### Informational messages' }[type]
        settings.results = [message(type, 'x')]
        await settings.handleResults()
        const section = bodies()[0].slice(bodies()[0].indexOf(heading), -footer.length)
        const fixedLength = header(1, 0, ' (2/2)').length + summary(type === 'ERROR' ? 1 : 0, 'None').length +
          section.length - 1 + footer.length
        context.octokit.rest.issues.createComment.mockClear()
        settings.results = [message(type, 'x'.repeat(limit - fixedLength + offset))]
        await settings.handleResults()
        const [, body] = bodies()
        expect(bodies()).toHaveLength(2)
        expect(body).toHaveLength(Math.min(limit, limit + offset))
        expectFooterOutsideSections(body)
        expect(body.includes(truncation)).toBe(offset > 0)
        expect(body.endsWith(`${offset > 0 ? truncation : ''}\n\n</details>${footer}`)).toBe(true)
      }
    )

    it.each([
      ['', '<details>', '<summary>nested</summary>value</details>'],
      ['<details>', '<summary>', 'nested</summary>value</details>'],
      ['<details><summary>nested', '</summary>', 'value</details>'],
      ['<details><summary>nested</summary>value', '</details>', '']
    ])('does not split %s%s when truncation falls inside a container tag', async (before, tag, after) => {
      settings.results = [message('ERROR', 'x'.repeat(limit))]
      await settings.handleResults()
      const contentStart = bodies()[1].indexOf('* ') + 2
      // Exercise both the initial cut and the cut after reserving closing tags.
      for (const reservation of [0, '\n\n</details>'.length, '\n\n</summary>\n</details>\n</details>'.length]) {
        for (let offset = 0; offset <= tag.length; offset++) {
          context.octokit.rest.issues.createComment.mockClear()
          const padding = limit - footer.length - truncation.length - contentStart - before.length - reservation - offset
          settings.results = [message('ERROR', 'x'.repeat(padding) + before + tag + after + 'y'.repeat(limit))]
          await settings.handleResults()
          const body = bodies()[1]
          expectFooterOutsideSections(body)
          expect(body.length).toBeLessThanOrEqual(limit)
          expect(body).toContain(truncation)
          expect(body.replace(/<\/?(?:details|summary)>/g, '')).not.toMatch(/[<>]/)
        }
      }
    })

    it('does not append an unmatched closing tag when truncation precedes all sections', async () => {
      context.payload.check_run.html_url = `https://github.com/test/admin/runs/42?${'x'.repeat(limit)}`
      await settings.handleResults()
      for (const body of bodies()) {
        expect(body).toHaveLength(limit)
        expectFooterOutsideSections(body)
        expect(body).not.toContain('<details>')
        expect(body).not.toContain('</details>')
      }
    })
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
