const fs = require('fs')

jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn()
}))

const env = require('../../../lib/env')
const { getInstallations } = require('../../../lib/installationCache')
const { getDefaultBranch, syncHubOrgUpdate, syncHubGlobalsUpdate } = require('../../../lib/hubSyncHandler')

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
    payload: { pull_request: { number: 7, head: { sha: 'hub-head-sha' } } },
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
})
