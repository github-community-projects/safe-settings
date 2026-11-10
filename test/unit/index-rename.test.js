const fs = require('fs')
const plugin = require('../../index')
const RealSettings = require('../../lib/settings')
const env = require('../../lib/env')

describe('repo config file changes detected from pushes and PRs', () => {
  const owner = 'test-org'
  let handlers
  let github
  let Settings
  let log

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, CRON: '', GH_ENTERPRISE: '' })
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    handlers = new Map()
    github = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        apps: {
          listInstallations: { endpoint: { merge: jest.fn().mockReturnValue({}) } },
          getAuthenticated: jest.fn().mockResolvedValue({ data: { slug: 'safe-settings' } })
        },
        repos: {
          getContent: jest.fn().mockResolvedValue({ data: { content: '' } }),
          compareCommitsWithBasehead: jest.fn().mockResolvedValue({ data: { files: [] } })
        },
        pulls: { listFiles: jest.fn().mockResolvedValue({ data: [] }) },
        checks: { update: jest.fn().mockResolvedValue({}) }
      }
    }
    log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() }
    Settings = {
      FILE_PATH: RealSettings.FILE_PATH,
      REPO_PATTERN: RealSettings.REPO_PATTERN,
      SUB_ORG_PATTERN: RealSettings.SUB_ORG_PATTERN,
      syncSelectedRepos: jest.fn().mockResolvedValue(),
      syncAll: jest.fn().mockResolvedValue()
    }
    const robot = {
      auth: jest.fn().mockResolvedValue(github),
      log,
      on: (events, handler) => {
        for (const event of [].concat(events)) handlers.set(event, handler)
      }
    }
    plugin(robot, {}, Settings)
  })

  const repoFile = name => `.github/repos/${name}.yml`

  const push = (commits, before = 'base-sha') => handlers.get('push')({
    repo: () => ({ owner, repo: 'admin' }),
    octokit: github,
    log,
    payload: {
      ref: 'refs/heads/main',
      before,
      after: 'head-sha',
      commits,
      installation: { id: 1 },
      repository: { name: 'admin', default_branch: 'main', owner: { login: owner } }
    }
  })

  const syncedRepos = () => Settings.syncSelectedRepos.mock.calls.map(call => call[2])

  it('turns a renamed repo config file into a rename of its repo', async () => {
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: [{ filename: repoFile('repo11-renamed'), previous_filename: repoFile('repo11'), status: 'renamed' }] }
    })

    await push([{ added: [repoFile('repo11-renamed')], modified: [], removed: [repoFile('repo11')] }])

    expect(github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({ owner, repo: 'admin', basehead: 'base-sha...head-sha' })
    expect(syncedRepos()).toEqual([[{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }]])
  })

  it('ignores repo config files that a merge commit replays from the default branch', async () => {
    await push([
      { added: [], modified: ['README.md'], removed: [] },
      { added: [repoFile('repo11-renamed')], modified: [], removed: [repoFile('repo11')] }
    ])

    expect(Settings.syncSelectedRepos).not.toHaveBeenCalled()
    expect(Settings.syncAll).not.toHaveBeenCalled()
  })

  it('keeps removed repo config files so their repo is synced', async () => {
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: [{ filename: repoFile('gone'), status: 'removed' }] }
    })

    await push([])

    expect(syncedRepos()).toEqual([[{ owner, repo: 'gone' }]])
  })

  it.each([
    ['into a subfolder', '.github/repos/archive/repo11.yml'],
    ['to a name without .yml', '.github/repos/repo11.yml.bak']
  ])('treats a repo config file moved %s as a removal', async (_, movedTo) => {
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: [{ filename: movedTo, previous_filename: repoFile('repo11'), status: 'renamed' }] }
    })

    await push([])

    expect(syncedRepos()).toEqual([[{ owner, repo: 'repo11' }]])
  })

  it.each([
    ['the compare fails', () => github.rest.repos.compareCommitsWithBasehead.mockRejectedValue(new Error('Server Error'))],
    ['the compare lists 300 files', () => github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: Array.from({ length: 300 }, (_, fileNumber) => ({ filename: repoFile(`repo${fileNumber}`), status: 'modified' })) }
    })]
  ])('syncs nothing and logs an error when %s', async (_, arrangeCompare) => {
    arrangeCompare()

    await push([{ added: [repoFile('repo11-renamed')], modified: [RealSettings.FILE_PATH], removed: [repoFile('repo11')] }])

    expect(Settings.syncSelectedRepos).not.toHaveBeenCalled()
    expect(Settings.syncAll).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Skipping push base-sha...head-sha'))
  })

  it('syncs nothing and logs an error for a push without a previous commit', async () => {
    await push([{ added: [repoFile('fresh')], modified: [], removed: [] }], '0000000000000000000000000000000000000000')

    expect(github.rest.repos.compareCommitsWithBasehead).not.toHaveBeenCalled()
    expect(Settings.syncSelectedRepos).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no previous commit'))
  })

  it('does a full sync when the net diff changes the settings file', async () => {
    github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: [{ filename: RealSettings.FILE_PATH, status: 'modified' }] }
    })

    await push([])

    expect(Settings.syncAll).toHaveBeenCalledTimes(1)
  })

  const createCheckRun = () => handlers.get('check_run.created')({
    repo: () => ({ owner, repo: 'admin' }),
    octokit: github,
    log,
    payload: {
      installation: { id: 1 },
      repository: { name: 'admin', default_branch: 'main', owner: { login: owner } },
      check_run: {
        id: 42,
        name: 'Safe-setting validator',
        status: 'queued',
        check_suite: { pull_requests: [{ number: 1, head: { ref: 'rename' }, base: { ref: 'main' } }] }
      }
    }
  })

  it('passes a renamed repo config file in a PR to the dry run as a rename', async () => {
    github.rest.pulls.listFiles.mockResolvedValue({
      data: [{ filename: repoFile('repo11-renamed'), previous_filename: repoFile('repo11'), status: 'renamed' }]
    })

    await createCheckRun()

    expect(Settings.syncSelectedRepos).toHaveBeenCalledTimes(1)
    const [nop, , repos] = Settings.syncSelectedRepos.mock.calls[0]
    expect(nop).toBe(true)
    expect(repos).toEqual([{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }])
  })

  it('passes both names of a renamed suborg config file in a PR to the dry run', async () => {
    github.rest.pulls.listFiles.mockResolvedValue({
      data: [{ filename: '.github/suborgs/team-new.yml', previous_filename: '.github/suborgs/team-old.yml', status: 'renamed' }]
    })

    await createCheckRun()

    const [, , , subOrgs] = Settings.syncSelectedRepos.mock.calls[0]
    expect(subOrgs.map(subOrg => subOrg.path)).toEqual(['.github/suborgs/team-new.yml', '.github/suborgs/team-old.yml'])
  })

  it('reads every page of PR files so a rename past the first page reaches the dry run', async () => {
    const otherFiles = Array.from({ length: 100 }, (_, index) => ({ filename: `docs/file-${index}.md`, status: 'added' }))
    github.rest.pulls.listFiles
      .mockResolvedValueOnce({ data: otherFiles })
      .mockResolvedValueOnce({ data: [{ filename: repoFile('repo11-renamed'), previous_filename: repoFile('repo11'), status: 'renamed' }] })

    await createCheckRun()

    expect(github.rest.pulls.listFiles).toHaveBeenCalledWith(expect.objectContaining({ per_page: 100, page: 2 }))
    const [, , repos] = Settings.syncSelectedRepos.mock.calls[0]
    expect(repos).toEqual([{ owner, repo: 'repo11-renamed', renamedFrom: 'repo11' }])
  })

  it('does not preview a full sync for a PR that removes the settings file, like the push after merge', async () => {
    github.rest.pulls.listFiles.mockResolvedValue({ data: [{ filename: Settings.FILE_PATH, status: 'removed' }] })

    await createCheckRun()

    expect(Settings.syncAll).not.toHaveBeenCalled()
  })
})
