const fs = require('fs')
const plugin = require('../../index')
const Settings = require('../../lib/settings')
const env = require('../../lib/env')

describe('configuration read error reporting', () => {
  let app
  let handlers
  let github
  let context
  let listedFiles

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.replaceProperty(env, 'CONFIG_PATH', '.github')
    jest.replaceProperty(env, 'SETTINGS_FILE_PATH', 'settings.yml')
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    jest.replaceProperty(env, 'GH_ORG', 'test-org')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    handlers = new Map()
    const installation = { id: 123, account: { login: 'test-org' } }
    listedFiles = [{ filename: Settings.FILE_PATH }]
    github = {
      paginate: jest.fn(async route => route === github.rest.pulls.listFiles ? listedFiles : [installation]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } },
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'safe-settings' } })
        },
        repos: { getContent: jest.fn() },
        pulls: { listFiles: jest.fn() },
        checks: { update: jest.fn().mockResolvedValue({}) },
        issues: { createComment: jest.fn().mockResolvedValue({}) }
      }
    }
    const log = { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn() }
    const robot = {
      auth: jest.fn().mockResolvedValue(github),
      log,
      on: (events, handler) => {
        for (const event of [].concat(events)) handlers.set(event, handler)
      }
    }
    context = {
      repo: () => ({ owner: 'test-org', repo: 'admin' }),
      octokit: github,
      log,
      payload: {
        installation,
        repository: { name: 'admin', default_branch: 'main', owner: { login: 'test-org' } },
        check_run: {
          id: 42,
          name: 'Safe-setting validator',
          status: 'queued',
          check_suite: {
            pull_requests: [{ number: 1, head: { ref: 'config-change' }, base: { ref: 'main' } }]
          }
        }
      }
    }
    app = plugin(robot, {}, Settings)
  })

  const errors = [
    Object.assign(new Error('Forbidden'), { status: 403 }),
    Object.assign(new Error('Internal Server Error'), { status: 500 }),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
  ]

  it.each(errors)('preserves %s in the full-sync error aggregate', async error => {
    github.rest.repos.getContent.mockRejectedValue(error)

    const result = await app.syncInstallation(false)

    expect(result.results).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBe(error)
    expect(github.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'admin',
      path: '.github/settings.yml',
      ref: undefined
    })
    expect(github.rest.checks.update).not.toHaveBeenCalled()
    expect(github.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it.each(errors)('reports %s in the failed NOP check and PR comment', async error => {
    github.rest.repos.getContent.mockRejectedValue(error)
    const handleError = jest.spyOn(Settings, 'handleError')

    await handlers.get('check_run.created')(context)
    expect(handleError).toHaveBeenCalledTimes(1)
    const command = handleError.mock.calls[0][5]
    expect(command.type).toBe('ERROR')
    expect(command.plugin).toBe('settings.yml')
    expect(command.action).toBe(error)
    await handleError.mock.results[0].value

    expect(github.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'test-org',
      repo: 'admin',
      path: '.github/settings.yml',
      ref: 'config-change'
    })
    expect(github.rest.checks.update).toHaveBeenCalledTimes(2)
    const check = github.rest.checks.update.mock.calls[1][0]
    expect(check).toMatchObject({ check_run_id: 42, status: 'completed', conclusion: 'failure' })
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const comment = github.rest.issues.createComment.mock.calls[0][0]
    expect(comment).toMatchObject({ owner: 'test-org', repo: 'admin', issue_number: 1 })
    for (const output of [check.output.summary, comment.body]) {
      expect(output).toContain(error.message)
      expect(output).not.toContain('TypeError')
    }
  })
  describe('pull request file pagination', () => {
    const unrelated = count => Array.from({ length: count }, (_, i) => ({ filename: `docs/file-${i}.md` }))
    const completedCheck = () => github.rest.checks.update.mock.calls.map(c => c[0]).find(p => p.status === 'completed')

    it('requests every page of changed files', async () => {
      listedFiles = unrelated(3)

      await handlers.get('check_run.created')(context)

      expect(github.paginate).toHaveBeenCalledWith(github.rest.pulls.listFiles, {
        owner: 'test-org',
        repo: 'admin',
        pull_number: 1,
        per_page: 100
      })
      expect(github.rest.pulls.listFiles).not.toHaveBeenCalled()
    })

    it('validates a settings change that appears after the first page', async () => {
      listedFiles = [...unrelated(150), { filename: Settings.FILE_PATH }]
      github.rest.repos.getContent.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
      const handleError = jest.spyOn(Settings, 'handleError')

      await handlers.get('check_run.created')(context)
      await handleError.mock.results[0]?.value

      expect(github.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: '.github/settings.yml', ref: 'config-change' }))
      expect(completedCheck()).not.toMatchObject({ conclusion: 'success' })
    })

    it('still reports success when no Safe-settings files changed', async () => {
      listedFiles = unrelated(150)

      await handlers.get('check_run.created')(context)

      expect(github.rest.repos.getContent).not.toHaveBeenCalled()
      expect(completedCheck()).toMatchObject({
        conclusion: 'success',
        output: { title: 'No Safe-settings changes detected' }
      })
    })

    it('does not report success when listing changed files fails', async () => {
      const error = new Error('List files failed')
      github.paginate.mockImplementation(async route => {
        if (route === github.rest.pulls.listFiles) throw error
        return []
      })

      await expect(handlers.get('check_run.created')(context)).rejects.toBe(error)

      expect(completedCheck()).toBeUndefined()
    })
  })
})
