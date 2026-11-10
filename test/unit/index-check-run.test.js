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
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn() },
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
  const requestCheckSuite = () => deliver('check_suite.requested', {
    check_suite: { head_branch: 'config-change', head_sha: headSha, pull_requests: [pullRequest] }
  })

  it('creates a dry-run check run when a pull request is opened', async () => {
    await openPullRequest()

    expect(github.rest.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: headSha, check_name: 'Safe-setting validator' }))
    expect(github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Safe-setting validator', head_sha: headSha }))
  })

  it.each(['queued', 'in_progress'])('does not start a second dry run while one is %s for the same commit', async status => {
    await requestCheckSuite()
    checkRuns = [{ status }]
    await openPullRequest()

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })

  it('starts a new dry run when the earlier one on the same commit has finished', async () => {
    checkRuns = [{ status: 'completed' }]

    await deliver('pull_request.reopened', { pull_request: pullRequest })

    expect(github.rest.checks.create).toHaveBeenCalledTimes(1)
  })
})
