const fs = require('fs')
const plugin = require('../../index')
const Settings = require('../../lib/settings')
const env = require('../../lib/env')

describe('dry-run check runs for a pull request', () => {
  const headSha = 'head-sha'
  let handlers
  let github
  let checkRuns

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    handlers = new Map()
    checkRuns = []
    github = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } },
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'safe-settings' } })
        },
        checks: {
          listForRef: jest.fn(async () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } })),
          create: jest.fn().mockResolvedValue({})
        }
      }
    }
    const robot = {
      auth: jest.fn().mockResolvedValue(github),
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() },
      on: (events, handler) => {
        for (const event of [].concat(events)) handlers.set(event, handler)
      }
    }
    plugin(robot, {}, Settings)
  })

  afterEach(() => jest.restoreAllMocks())

  const repository = { name: 'admin', default_branch: 'main', owner: { login: 'test-org' } }
  const pullRequest = { number: 1, head: { sha: headSha, ref: 'config-change' }, base: { ref: 'main' } }
  const deliver = (event, payload) => handlers.get(event)({
    payload: { repository, ...payload },
    repo: () => ({ owner: 'test-org', repo: 'admin' }),
    octokit: github
  })
  const openPullRequest = () => deliver('pull_request.opened', { pull_request: pullRequest })
  const ownRun = status => ({ status, app: { slug: 'safe-settings' } })
  const requestCheckSuite = () => deliver('check_suite.requested', {
    check_suite: { head_branch: 'config-change', head_sha: headSha, pull_requests: [pullRequest] }
  })

  it('creates a dry-run check run when a pull request is opened', async () => {
    await openPullRequest()

    expect(github.rest.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: headSha, check_name: 'Safe-setting validator' }))
    expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Safe-setting validator', head_sha: headSha }))
  })

  it.each(['in_progress', 'completed'])('does not start a second dry run when the PR opens after the push already started one (%s)', async status => {
    await requestCheckSuite()
    checkRuns = [ownRun(status)]
    await openPullRequest()

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })

  it('does not start a second dry run when the push event arrives after the PR opened', async () => {
    await openPullRequest()
    checkRuns = [ownRun('queued')]
    await requestCheckSuite()

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })

  it('ignores a check run with the same name from another app', async () => {
    checkRuns = [{ status: 'in_progress', app: { slug: 'safe-settings-canary' } }]

    await openPullRequest()

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })

  it('still starts the dry run when the check runs cannot be listed', async () => {
    github.rest.checks.listForRef.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }))

    await openPullRequest()

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })

  it('starts a new dry run on reopen even when an earlier run on the commit never finished', async () => {
    checkRuns = [ownRun('queued')]

    await deliver('pull_request.reopened', { pull_request: pullRequest })

    expect(github.rest.checks.listForRef).not.toHaveBeenCalled()
    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })
})
