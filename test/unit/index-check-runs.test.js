const fs = require('fs')
const plugin = require('../../index')
const Settings = require('../../lib/settings')
const env = require('../../lib/env')

describe('validator check run handlers', () => {
  let handlers
  let github
  let log

  const repository = { name: 'admin', default_branch: 'main', owner: { login: 'test-org' } }

  beforeEach(async () => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    handlers = new Map()
    const installation = { id: 123, account: { login: 'test-org' } }
    github = {
      paginate: jest.fn(async (method, params) => {
        if (method === github.rest.pulls.listFiles) return method(params)
        return [installation]
      }),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } },
          getAuthenticated: jest.fn().mockResolvedValue({ data: { id: 1, slug: 'safe-settings' } })
        },
        repos: { getContent: jest.fn().mockResolvedValue({ data: { content: '' } }) },
        pulls: { listFiles: jest.fn().mockResolvedValue([]) },
        checks: {
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({})
        }
      }
    }
    log = { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn() }
    const robot = {
      auth: jest.fn().mockResolvedValue(github),
      log,
      on: (events, handler) => {
        for (const event of [].concat(events)) {
          if (!handlers.has(event)) handlers.set(event, [])
          handlers.get(event).push(handler)
        }
      }
    }
    plugin(robot, {}, Settings)
    // Let the startup info() call resolve the app's own identity.
    await new Promise(resolve => setImmediate(resolve))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function receive (event, payload) {
    const context = {
      payload,
      octokit: github,
      log,
      repo: () => ({ owner: 'test-org', repo: payload.repository.name })
    }
    for (const handler of handlers.get(event) || []) {
      await handler(context)
    }
  }

  describe('check_suite.rerequested', () => {
    function suite (overrides = {}) {
      return {
        repository,
        check_suite: {
          head_branch: 'config-change',
          head_sha: 'abc123',
          pull_requests: [{ number: 1 }],
          ...overrides
        }
      }
    }

    it('creates one check run for the suite head_sha', async () => {
      await receive('check_suite.rerequested', suite())

      expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
      expect(github.rest.checks.create).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'admin',
        name: 'Safe-setting validator',
        head_sha: 'abc123'
      })
    })

    it('ignores suites outside the admin repo', async () => {
      await receive('check_suite.rerequested', { ...suite(), repository: { ...repository, name: 'other' } })

      expect(github.rest.checks.create).not.toHaveBeenCalled()
    })

    it('ignores suites without a PR', async () => {
      await receive('check_suite.rerequested', suite({ pull_requests: [] }))

      expect(github.rest.checks.create).not.toHaveBeenCalled()
    })
  })

  describe.each(['pull_request.opened', 'pull_request.reopened'])('%s', event => {
    function pr (ref) {
      return { repository, pull_request: { number: 1, head: { ref, sha: 'abc123' } } }
    }

    it('creates a check run for a feature branch', async () => {
      await receive(event, pr('config-change'))

      expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: 'abc123' }))
    })

    // Behavior change: this guard used to read the non-existent pull_request.head_branch
    // and never fired, so PRs from the default branch got a check run too.
    it('skips PRs whose head is the default branch', async () => {
      await receive(event, pr('main'))

      expect(github.rest.checks.create).not.toHaveBeenCalled()
    })
  })

  describe('check_run.created', () => {
    function run (app) {
      return {
        repository,
        check_run: {
          id: 42,
          name: 'Safe-setting validator',
          status: 'queued',
          app,
          check_suite: {
            pull_requests: [{ number: 1, head: { ref: 'config-change' }, base: { ref: 'main' } }]
          }
        }
      }
    }

    it('ignores check runs created by another app', async () => {
      await receive('check_run.created', run({ id: 2, slug: 'safe-settings-nonprod' }))

      expect(github.rest.checks.update).not.toHaveBeenCalled()
    })

    it('processes check runs created by this app', async () => {
      await receive('check_run.created', run({ id: 1, slug: 'safe-settings' }))

      expect(github.rest.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 42, status: 'in_progress' }))
      expect(github.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({ check_run_id: 42, status: 'completed' }))
    })

    it('syncs a settings file that is only on the second page of changed files', async () => {
      const syncSelectedRepos = jest.spyOn(Settings, 'syncSelectedRepos').mockResolvedValue()
      const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/file-${i}.md` }))
      const page2 = [{ filename: `${env.CONFIG_PATH}/repos/my-repo.yml` }]
      github.rest.pulls.listFiles.mockResolvedValue({ data: page1.slice(0, 30) })
      github.paginate.mockImplementation(async (method, params) => {
        if (method === github.rest.pulls.listFiles) return [...page1, ...page2]
        return []
      })

      await receive('check_run.created', run({ id: 1, slug: 'safe-settings' }))

      expect(github.paginate).toHaveBeenCalledWith(github.rest.pulls.listFiles, expect.objectContaining({ pull_number: 1, per_page: 100 }))
      expect(syncSelectedRepos).toHaveBeenCalledTimes(1)
      expect(syncSelectedRepos.mock.calls[0][2]).toEqual([{ repo: 'my-repo', owner: 'test-org' }])
    })
  })
})
