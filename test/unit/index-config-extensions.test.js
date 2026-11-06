const fs = require('fs')
const plugin = require('../../index')
const Settings = require('../../lib/settings')
const env = require('../../lib/env')

describe('configuration file extension detection', () => {
  let handlers
  let context
  let syncSelectedRepos

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    syncSelectedRepos = jest.spyOn(Settings, 'syncSelectedRepos').mockResolvedValue()
    handlers = new Map()
    const github = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } }
        },
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from('{}').toString('base64') }
          })
        },
        pulls: { listFiles: jest.fn() },
        checks: { update: jest.fn().mockResolvedValue({}) }
      }
    }
    const log = { debug: jest.fn(), info: jest.fn(), error: jest.fn() }
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
        repository: { name: 'admin', default_branch: 'main', owner: { login: 'test-org' } },
        ref: 'refs/heads/main',
        before: 'base-sha',
        after: 'head-sha',
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
    plugin(robot, {}, Settings)
  })

  describe.each(['yml', 'yaml'])('.%s files', extension => {
    it.each(['added', 'modified', 'removed'])('detects %s repository configs on push', async action => {
      const commit = { added: [], modified: [], removed: [] }
      commit[action] = [`.github/repos/demo.api.${extension}`]
      context.payload.commits = [commit]

      await handlers.get('push')(context)

      expect(syncSelectedRepos).toHaveBeenCalledTimes(1)
      expect(syncSelectedRepos).toHaveBeenCalledWith(
        false, context, [{ repo: 'demo.api', owner: 'test-org' }], [],
        expect.any(Object), 'head-sha', null, 'base-sha'
      )
    })

    it.each(['added', 'modified', 'removed'])('detects %s suborg configs on push', async action => {
      const path = `.github/suborgs/backend.team.${extension}`
      const commit = { added: [], modified: [], removed: [] }
      commit[action] = [path]
      context.payload.commits = [commit]

      await handlers.get('push')(context)

      expect(syncSelectedRepos).toHaveBeenCalledTimes(1)
      expect(syncSelectedRepos).toHaveBeenCalledWith(
        false, context, [], [{ repo: 'backend.team', path }],
        expect.any(Object), 'head-sha', null, 'base-sha'
      )
    })

    it('detects repository configs during PR validation', async () => {
      context.octokit.rest.pulls.listFiles.mockResolvedValue({
        data: [{ filename: `.github/repos/demo.api.${extension}` }]
      })

      await handlers.get('check_run.created')(context)

      expect(syncSelectedRepos).toHaveBeenCalledTimes(1)
      expect(syncSelectedRepos).toHaveBeenCalledWith(
        true, context, [{ repo: 'demo.api', owner: 'test-org' }], [],
        expect.any(Object), 'config-change', expect.any(Object), 'main'
      )
    })

    it('detects suborg configs during PR validation', async () => {
      const path = `.github/suborgs/backend.team.${extension}`
      context.octokit.rest.pulls.listFiles.mockResolvedValue({ data: [{ filename: path }] })

      await handlers.get('check_run.created')(context)

      expect(syncSelectedRepos).toHaveBeenCalledTimes(1)
      expect(syncSelectedRepos).toHaveBeenCalledWith(
        true, context, [], [{ name: 'backend.team', path }],
        expect.any(Object), 'config-change', expect.any(Object), 'main'
      )
    })
  })

  const unrelatedFiles = [
    '.github/repos/demo.yaml.bak',
    '.github/suborgs/backend.yml.bak',
    '.github/repos/nested/demo.yaml',
    '.github/suborgs/nested/backend.yml',
    'docs/demo.yaml'
  ]

  it('ignores unrelated files on push', async () => {
    context.payload.commits = [{ added: [], modified: unrelatedFiles, removed: [] }]

    await handlers.get('push')(context)

    expect(syncSelectedRepos).not.toHaveBeenCalled()
  })

  it('ignores unrelated files during PR validation', async () => {
    context.octokit.rest.pulls.listFiles.mockResolvedValue({
      data: unrelatedFiles.map(filename => ({ filename }))
    })

    await handlers.get('check_run.created')(context)

    expect(syncSelectedRepos).not.toHaveBeenCalled()
    expect(context.octokit.rest.checks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      conclusion: 'success',
      output: { title: 'No Safe-settings changes detected', summary: 'No changes detected' }
    }))
  })
})
