const fs = require('fs')

jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn()
}))

const env = require('../../../lib/env')
const { getInstallations } = require('../../../lib/installationCache')
const { getDefaultBranch, syncHubOrgUpdate, syncHubGlobalsUpdate } = require('../../../lib/hubSyncHandler')
const hubSync = require('../../../lib/hubSyncHandler')

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })

function makeRobot (destClient) {
  const error = jest.fn()
  return {
    errorSpy: error, // robot.log methods get wrapped by attachFileLogger
    log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error },
    auth: jest.fn().mockResolvedValue(destClient)
  }
}

function makeSpokeClient (defaultBranch) {
  return {
    rest: {
      repos: {
        get: jest.fn().mockResolvedValue({ data: { default_branch: defaultBranch } }),
        getContent: jest.fn().mockRejectedValue(notFound()),
        createOrUpdateFileContents: jest.fn().mockResolvedValue({})
      },
      git: {
        getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'spoke-base-sha' } } }),
        createRef: jest.fn().mockResolvedValue({})
      },
      pulls: {
        create: jest.fn().mockResolvedValue({ data: { html_url: 'https://example.test/pr/1' } })
      }
    }
  }
}

// Hub client: no manifest (sync everything) and a single changed file.
function makeContext (changedFile) {
  return {
    payload: { pull_request: { number: 7, merged: true, merge_commit_sha: 'hub-merge-sha', head: { sha: 'hub-head-sha' } } },
    repo: () => ({ owner: 'hub-org', repo: 'hub-repo' }),
    octokit: {
      paginate: jest.fn().mockResolvedValue([{ filename: changedFile }]),
      rest: {
        pulls: { listFiles: jest.fn() },
        repos: {
          getContent: jest.fn(async ({ path }) => {
            if (path.endsWith('/manifest.yml')) throw notFound()
            return { data: { content: Buffer.from('foo: bar\n').toString('base64'), encoding: 'base64' } }
          })
        }
      }
    }
  }
}

describe('Hub-Sync uses the spoke repo default branch', () => {
  beforeEach(() => {
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.replaceProperty(env, 'CONFIG_PATH', '.github')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_ORG', 'hub-org')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_REPO', 'hub-repo')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_PATH', 'safe-settings')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_DIRECT_PUSH', 'false')
    jest.spyOn(fs, 'appendFile').mockImplementation((path, content, callback) => callback(null))
    getInstallations.mockResolvedValue([
      { id: 2, account: { login: 'spoke-org', type: 'Organization' } }
    ])
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('getDefaultBranch', () => {
    it('returns the repository default branch', async () => {
      const client = makeSpokeClient('master')
      await expect(getDefaultBranch(client, 'spoke-org', 'admin')).resolves.toBe('master')
      expect(client.rest.repos.get).toHaveBeenCalledWith({ owner: 'spoke-org', repo: 'admin' })
    })

    it('propagates errors such as 404', async () => {
      const client = makeSpokeClient('master')
      client.rest.repos.get.mockRejectedValue(notFound())
      await expect(getDefaultBranch(client, 'spoke-org', 'admin')).rejects.toMatchObject({ status: 404 })
    })

    it('throws instead of guessing when default_branch is missing', async () => {
      const client = makeSpokeClient(undefined)
      await expect(getDefaultBranch(client, 'spoke-org', 'admin')).rejects.toThrow('Could not determine the default branch for spoke-org/admin')
    })
  })

  describe('loadManifest', () => {
    it('omits ref when none is given, so GitHub reads the default branch', async () => {
      jest.resetModules()
      const fresh = require('../../../lib/hubSyncHandler')
      const freshEnv = require('../../../lib/env')
      jest.replaceProperty(freshEnv, 'SAFE_SETTINGS_HUB_ORG', 'hub-org')
      jest.replaceProperty(freshEnv, 'SAFE_SETTINGS_HUB_REPO', 'hub-repo')
      const octokit = { rest: { repos: { getContent: jest.fn().mockResolvedValue({ data: { content: Buffer.from('rules: []\n').toString('base64'), encoding: 'base64' } }) } } }

      await fresh.loadManifest(octokit, undefined, { debug: jest.fn(), warn: jest.fn(), error: jest.fn() })

      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1)
      expect(octokit.rest.repos.getContent.mock.calls[0][0]).not.toHaveProperty('ref')
    })
  })

  it('globals sync aborts without a pull_request payload', async () => {
    const spoke = makeSpokeClient('master')
    const robot = makeRobot(spoke)
    const context = makeContext('.github/safe-settings/globals/suborgs.yml')
    delete context.payload.pull_request

    await syncHubGlobalsUpdate(robot, context, [{ filename: '.github/safe-settings/globals/suborgs.yml' }])

    expect(context.octokit.rest.repos.getContent).not.toHaveBeenCalled()
    expect(spoke.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled()
  })

  it('globals sync skips only the org whose default branch is unknown', async () => {
    getInstallations.mockResolvedValue([
      { id: 2, account: { login: 'spoke-org', type: 'Organization' } },
      { id: 3, account: { login: 'other-org', type: 'Organization' } }
    ])
    const broken = makeSpokeClient(undefined)
    const healthy = makeSpokeClient('master')
    const robot = makeRobot(broken)
    robot.auth = jest.fn(async id => (id === 2 ? broken : healthy))
    const file = '.github/safe-settings/globals/suborgs.yml'

    await syncHubGlobalsUpdate(robot, makeContext(file), [{ filename: file }])

    expect(robot.errorSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping org spoke-org: Could not determine the default branch'))
    expect(broken.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled()
    expect(healthy.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'master' }))
  })

  it('organization sync branches from and opens the PR against the default branch', async () => {
    const spoke = makeSpokeClient('master')
    const robot = makeRobot(spoke)
    const context = makeContext('.github/safe-settings/organizations/spoke-org/repos/my-repo.yml')

    await syncHubOrgUpdate(robot, context, 'spoke-org', 'admin', '.github')

    expect(spoke.rest.git.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/master' }))
    expect(spoke.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: '.github/repos/my-repo.yml', ref: 'master' }))
    expect(spoke.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'master' }))
    expect(robot.errorSpy).not.toHaveBeenCalled()
  })

  it('organization sync with direct push commits to the default branch', async () => {
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_DIRECT_PUSH', 'true')
    const spoke = makeSpokeClient('develop')
    const robot = makeRobot(spoke)
    const context = makeContext('.github/safe-settings/organizations/spoke-org/repos/my-repo.yml')

    await syncHubOrgUpdate(robot, context, 'spoke-org', 'admin', '.github')

    expect(spoke.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(expect.objectContaining({ branch: 'develop' }))
    expect(spoke.rest.git.createRef).not.toHaveBeenCalled()
    expect(spoke.rest.pulls.create).not.toHaveBeenCalled()
  })

  it('globals file sync branches from and opens the PR against the default branch', async () => {
    const spoke = makeSpokeClient('master')
    const robot = makeRobot(spoke)
    const file = '.github/safe-settings/globals/suborgs.yml'
    const context = makeContext(file)

    await syncHubGlobalsUpdate(robot, context, [{ filename: file }])

    expect(spoke.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'master' }))
    expect(spoke.rest.git.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/master' }))
    expect(spoke.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'master' }))
    expect(robot.errorSpy).not.toHaveBeenCalled()
  })

  describe('post-merge source snapshot', () => {
    it.each(['organization', 'globals'])('reads all %s source files at the merge SHA', async kind => {
      const spoke = makeSpokeClient('master')
      const robot = makeRobot(spoke)
      const file = kind === 'organization'
        ? '.github/safe-settings/organizations/spoke-org/repos/my-repo.yml'
        : '.github/safe-settings/globals/suborgs.yml'
      const context = makeContext(file)

      if (kind === 'organization') {
        await syncHubOrgUpdate(robot, context, 'spoke-org', 'admin', '.github')
      } else {
        await syncHubGlobalsUpdate(robot, context, [{ filename: file }])
      }

      expect(context.octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: file, ref: 'hub-merge-sha' }))
      for (const [params] of context.octokit.rest.repos.getContent.mock.calls) {
        expect(params.ref).toBe('hub-merge-sha')
      }
      expect(spoke.rest.repos.createOrUpdateFileContents).toHaveBeenCalled()
      expect(robot.errorSpy).not.toHaveBeenCalled()
    })

    it.each(['organization', 'globals'])('generates %s settings from merged globals and organization content', async kind => {
      const spoke = makeSpokeClient('master')
      const robot = makeRobot(spoke)
      const root = '.github/safe-settings'
      const file = kind === 'organization'
        ? `${root}/organizations/spoke-org/settings.yml`
        : `${root}/globals/settings.yml`
      const context = makeContext(file)
      context.octokit.rest.repos.getContent.mockImplementation(async ({ path, ref }) => {
        expect(ref).toBe('hub-merge-sha')
        if (path.endsWith('/manifest.yml')) throw notFound()
        if (path === `${root}/organizations`) {
          return { data: [{ type: 'dir', name: 'spoke-org' }] }
        }
        const content = path === `${root}/globals/settings.yml`
          ? 'repository:\n  has_issues: false\n'
          : 'repository:\n  description: org policy\n'
        return { data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } }
      })

      if (kind === 'organization') {
        await syncHubOrgUpdate(robot, context, 'spoke-org', 'admin', '.github')
      } else {
        await syncHubGlobalsUpdate(robot, context, [{ filename: file }])
      }

      expect(spoke.rest.repos.createOrUpdateFileContents).toHaveBeenCalled()
      const written = spoke.rest.repos.createOrUpdateFileContents.mock.calls[0][0]
      const output = Buffer.from(written.content, 'base64').toString('utf8')
      expect(output).toContain('has_issues: false')
      expect(output).toContain('description: org policy')
      for (const [params] of context.octokit.rest.repos.getContent.mock.calls) {
        expect(params.ref).toBe('hub-merge-sha')
      }
      expect(robot.errorSpy).not.toHaveBeenCalled()
    })

    function routedContext () {
      const context = makeContext('.github/safe-settings/organizations/spoke-org/settings.yml')
      context.payload.repository = { name: 'hub-repo', owner: { login: 'hub-org' } }
      context.octokit.paginate.mockResolvedValue([
        { filename: '.github/safe-settings/globals/settings.yml' },
        { filename: '.github/safe-settings/organizations/spoke-org/settings.yml' }
      ])
      return context
    }

    it('resolves a missing merge SHA once and passes it to both sync paths', async () => {
      const robot = makeRobot(makeSpokeClient('master'))
      const context = routedContext()
      delete context.payload.pull_request.merge_commit_sha
      context.octokit.rest.pulls.get = jest.fn().mockResolvedValue({
        data: { merged: true, merge_commit_sha: 'fetched-merge-sha' }
      })
      const globals = jest.spyOn(hubSync, 'syncHubGlobalsUpdate').mockResolvedValue()
      const org = jest.spyOn(hubSync, 'syncHubOrgUpdate').mockResolvedValue()

      await hubSync.hubSyncHandler(robot, context)

      expect(context.octokit.rest.pulls.get).toHaveBeenCalledTimes(1)
      expect(context.octokit.rest.pulls.get).toHaveBeenCalledWith({ owner: 'hub-org', repo: 'hub-repo', pull_number: 7 })
      expect(globals).toHaveBeenCalledWith(robot, context, expect.any(Array), 'fetched-merge-sha')
      expect(org).toHaveBeenCalledWith(robot, context, 'spoke-org', 'admin', '.github', 'fetched-merge-sha')
      expect(context.octokit.paginate).toHaveBeenCalledWith(context.octokit.rest.pulls.listFiles, {
        owner: 'hub-org', repo: 'hub-repo', pull_number: 7, per_page: 100
      })
    })

    it.each(['missing', 'API failure'])('aborts explicitly when merge SHA resolution fails: %s', async mode => {
      const robot = makeRobot(makeSpokeClient('master'))
      const context = routedContext()
      delete context.payload.pull_request.merge_commit_sha
      context.octokit.rest.pulls.get = mode === 'missing'
        ? jest.fn().mockResolvedValue({ data: { merged: true, merge_commit_sha: null } })
        : jest.fn().mockRejectedValue(new Error('GitHub unavailable'))
      const globals = jest.spyOn(hubSync, 'syncHubGlobalsUpdate').mockResolvedValue()
      const org = jest.spyOn(hubSync, 'syncHubOrgUpdate').mockResolvedValue()

      await hubSync.hubSyncHandler(robot, context)

      expect(globals).not.toHaveBeenCalled()
      expect(org).not.toHaveBeenCalled()
      expect(context.octokit.paginate).not.toHaveBeenCalled()
      expect(robot.errorSpy).toHaveBeenCalledWith(expect.stringContaining(
        mode === 'missing' ? 'Could not determine the merge commit SHA' : 'GitHub unavailable'
      ))
    })
  })
})
