const fs = require('fs')
const plugin = require('../../index')
const Settings = require('../../lib/settings')
const env = require('../../lib/env')

describe('configuration read error reporting', () => {
  let app
  let handlers
  let github
  let context

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.replaceProperty(env, 'CONFIG_PATH', '.github')
    jest.replaceProperty(env, 'SETTINGS_FILE_PATH', 'settings.yml')
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    handlers = new Map()
    const installation = { id: 123, account: { login: 'test-org' } }
    github = {
      paginate: jest.fn().mockResolvedValue([installation]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } },
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'safe-settings' } })
        },
        repos: { getContent: jest.fn() },
        pulls: { listFiles: jest.fn().mockResolvedValue({ data: [{ filename: Settings.FILE_PATH }] }) },
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

  it.each(errors)('preserves %s through the full-sync entry point', async error => {
    github.rest.repos.getContent.mockRejectedValue(error)

    await expect(app.syncInstallation(false)).rejects.toBe(error)
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
})
