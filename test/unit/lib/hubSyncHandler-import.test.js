const fs = require('fs')

jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn()
}))

const env = require('../../../lib/env')
const { getInstallations } = require('../../../lib/installationCache')
const { loadManifest, retrieveSettingsFromOrgs } = require('../../../lib/hubSyncHandler')

describe('retrieveSettingsFromOrgs', () => {
  beforeEach(() => {
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.replaceProperty(env, 'CONFIG_PATH', '.github')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_ORG', 'hub-org')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_REPO', 'hub-repo')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_PATH', 'safe-settings')
    jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_REIMPORT', 'false')
    jest.spyOn(fs, 'appendFile').mockImplementation((path, content, callback) => callback(null))
    getInstallations.mockResolvedValue([
      { id: 1, account: { login: 'hub-org', type: 'Organization' } },
      { id: 2, account: { login: 'source-org', type: 'Organization' } }
    ])
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('reads source files through the Octokit REST namespace and creates an import PR', async () => {
    const hubClient = {
      rest: {
        repos: {
          getContent: jest.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
        },
        git: {
          getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          getCommit: jest.fn().mockResolvedValue({ data: { tree: { sha: 'base-tree' } } }),
          createTree: jest.fn().mockResolvedValue({ data: { sha: 'new-tree' } }),
          createRef: jest.fn().mockResolvedValue({}),
          createCommit: jest.fn().mockResolvedValue({ data: { sha: 'new-commit' } }),
          updateRef: jest.fn().mockResolvedValue({})
        },
        pulls: {
          create: jest.fn().mockResolvedValue({ data: { html_url: 'https://example.test/pr/1' } })
        }
      }
    }
    const sourceClient = {
      rest: {
        git: {
          getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'source-sha' } } })
        },
        repos: {
          getContent: jest.fn()
            .mockResolvedValueOnce({
              data: [{ type: 'file', path: '.github/settings.yml' }]
            })
            .mockResolvedValueOnce({
              data: {
                path: '.github/settings.yml',
                content: Buffer.from('repository:\n  default_branch: main\n').toString('base64'),
                encoding: 'base64'
              }
            })
        }
      }
    }
    const log = {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn()
    }
    const robot = {
      log,
      auth: jest.fn()
        .mockResolvedValueOnce(hubClient)
        .mockResolvedValueOnce(sourceClient)
    }

    const results = await retrieveSettingsFromOrgs(robot, ['source-org'])

    expect(sourceClient.rest.repos.getContent).toHaveBeenCalledTimes(2)
    expect(hubClient.rest.git.createTree).toHaveBeenCalledWith(expect.objectContaining({
      tree: [expect.objectContaining({
        path: '.github/safe-settings/organizations/source-org/settings.yml',
        content: 'repository:\n  default_branch: main\n'
      })]
    }))
    expect(hubClient.rest.pulls.create).toHaveBeenCalled()
    expect(results).toEqual([{
      org: 'source-org',
      status: 'imported',
      pr: 'https://example.test/pr/1'
    }])
  })
})

describe('loadManifest', () => {
  it('loads manifest content through the Octokit REST namespace', async () => {
    const octokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: {
              content: Buffer.from('rules: []\n').toString('base64'),
              encoding: 'base64'
            }
          })
        }
      }
    }
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }

    const manifest = await loadManifest(octokit, 'test-ref', logger)

    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: env.SAFE_SETTINGS_HUB_REPO,
      path: `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/globals/manifest.yml`,
      ref: 'test-ref'
    })
    expect(manifest).toEqual({ rules: [] })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
