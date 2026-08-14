
// Import the functions to test from the implementation file
const { hubSyncHandler, retrieveSettingsFromOrgs, loadAndMergeSettings, mergeConfigs } = require('../../../lib/hubSyncHandler')

// --- Mock dependencies ---
// Mock the env module to provide controlled environment variables for tests
jest.mock('../../../lib/env', () => ({
  SAFE_SETTINGS_HUB_ORG: 'test-org', // Simulate the hub org name
  SAFE_SETTINGS_HUB_REPO: 'test-repo', // Simulate the hub repo name
  ADMIN_REPO: 'admin-repo', // Simulate the admin repo name
  CONFIG_PATH: '.github', // Simulate the config path
  SAFE_SETTINGS_HUB_PATH: 'safe-settings', // Simulate the hub path
  SAFE_SETTINGS_HUB_DIRECT_PUSH: 'true' // Simulate direct push mode
}))
// Mock the installationCache module to control installation lookups
jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn()
}))

// --- Create mock objects for robot and context ---
// Mock robot object with logging and auth methods
const createMockRobot = () => ({
  log: {
    info: jest.fn(), // Track info logs
    warn: jest.fn(), // Track warning logs
    error: jest.fn(), // Track error logs
    debug: jest.fn(), // Track debug logs
    __fileLoggerAttached: true // Prevent attachFileLogger from modifying our mocks
  },
  auth: jest.fn() // Mock authentication method
})

// Mock context object to simulate GitHub event payloads and API
const mockContext = {
  payload: {
    repository: {
      name: 'test-repo', // Simulate repo name
      owner: { login: 'test-org' }, // Simulate repo owner
      full_name: 'test-org/test-repo' // Simulate full repo name
    },
    pull_request: { number: 1, head: { sha: 'abc123' } } // Simulate pull request info
  },
  repo: () => ({ owner: 'test-org', repo: 'test-repo' }), // Simulate repo lookup
  octokit: {
    paginate: jest.fn(), // Mock pagination for API calls
    rest: {
      pulls: {
        listFiles: jest.fn() // Mock listFiles API
      }
    }
  }
}

// --- Unit tests for hubSyncHandler ---
describe('hubSyncHandler', () => {
  let mockRobot
  
  beforeEach(() => {
    mockRobot = createMockRobot()
  })

  // Test that hubSyncHandler ignores events from non-master repo/org
  it('should ignore non-master repo/org', async () => {
    const context = { ...mockContext, payload: { repository: { name: 'other', owner: { login: 'other' } } } }
    await hubSyncHandler(mockRobot, context)
    expect(mockRobot.log.info).toHaveBeenCalledWith(expect.stringContaining('ignoring'))
  })

  // Test routing for organizations folder changes
  it('should call syncHubOrgUpdate for organizations folder changes', async () => {
    const orgFile = '.github/safe-settings/organizations/acme/settings.yml'
    const files = [{ filename: orgFile }]
    const context = {
      ...mockContext,
      octokit: { ...mockContext.octokit, paginate: jest.fn().mockResolvedValue(files) },
      payload: { ...mockContext.payload, repository: { name: 'test-repo', owner: { login: 'test-org' }, full_name: 'test-org/test-repo' }, pull_request: { number: 1, head: { sha: 'abc123' } } }
    }
    const mod = require('../../../lib/hubSyncHandler')
    // Spy on syncHubOrgUpdate
    const spy = jest.spyOn(mod, 'syncHubOrgUpdate').mockImplementation(jest.fn())
    await mod.hubSyncHandler(mockRobot, context)
    expect(spy).toHaveBeenCalledWith(mockRobot, context, 'acme', expect.anything(), expect.anything())
    spy.mockRestore()
  })

  // Test routing for globals folder changes
  it('should call syncHubGlobalsUpdate for globals folder changes', async () => {
    const globalsFile = '.github/safe-settings/globals/foo.yml'
    const files = [{ filename: globalsFile }]
    const context = {
      ...mockContext,
      octokit: { ...mockContext.octokit, paginate: jest.fn().mockResolvedValue(files) },
      payload: { ...mockContext.payload, repository: { name: 'test-repo', owner: { login: 'test-org' }, full_name: 'test-org/test-repo' }, pull_request: { number: 1, head: { sha: 'abc123' } } }
    }
    const mod = require('../../../lib/hubSyncHandler')
    // Spy on syncHubGlobalsUpdate
    const spy = jest.spyOn(mod, 'syncHubGlobalsUpdate').mockImplementation(jest.fn())
    await mod.hubSyncHandler(mockRobot, context)
    expect(spy).toHaveBeenCalledWith(mockRobot, context, files)
    spy.mockRestore()
  })
})

// --- Unit tests for retrieveSettingsFromOrgs ---
describe('retrieveSettingsFromOrgs', () => {
  let mockRobot

  beforeEach(() => {
    jest.clearAllMocks()
    mockRobot = createMockRobot()
  })

  // Test that retrieveSettingsFromOrgs returns an empty array if no orgs are provided
  it('should return empty array if orgNames is empty', async () => {
    // Call the function with an empty orgNames array
    const result = await retrieveSettingsFromOrgs(mockRobot, [])
    // Assert that the result is an empty array
    expect(result).toEqual([])
  })

  it('should skip creating a branch and PR when imported files match the base tree', async () => {
    const { getInstallations } = require('../../../lib/installationCache')
    const baseTreeSha = 'base-tree-sha'
    const mockGithubHub = {
      rest: {
        git: {
          getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'base-commit-sha' } } }),
          getCommit: jest.fn().mockResolvedValue({ data: { tree: { sha: baseTreeSha } } }),
          createTree: jest.fn().mockResolvedValue({ data: { sha: baseTreeSha } }),
          createRef: jest.fn(),
          createCommit: jest.fn(),
          updateRef: jest.fn()
        },
        repos: {
          getContent: jest.fn().mockRejectedValue({ status: 404 })
        },
        pulls: {
          create: jest.fn()
        }
      }
    }
    const mockGithubSource = {
      rest: {
        git: {
          getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'source-sha' } } })
        }
      },
      repos: {
        getContent: jest.fn()
          .mockResolvedValueOnce({ data: [{ type: 'file', path: '.github/settings.yml' }] })
          .mockResolvedValueOnce({
            data: {
              path: '.github/settings.yml',
              content: Buffer.from('repository:\n  name: unchanged').toString('base64'),
              encoding: 'base64'
            }
          })
      }
    }

    getInstallations.mockResolvedValue([
      { id: 1, account: { login: 'test-org' } },
      { id: 2, account: { login: 'source-org' } }
    ])
    mockRobot.auth
      .mockResolvedValueOnce(mockGithubHub)
      .mockResolvedValueOnce(mockGithubSource)

    const result = await retrieveSettingsFromOrgs(mockRobot, ['source-org'])

    expect(result).toEqual([{ org: 'source-org', status: 'skipped', reason: 'no_changes' }])
    expect(mockGithubHub.rest.git.createRef).not.toHaveBeenCalled()
    expect(mockGithubHub.rest.git.createCommit).not.toHaveBeenCalled()
    expect(mockGithubHub.rest.git.updateRef).not.toHaveBeenCalled()
    expect(mockGithubHub.rest.pulls.create).not.toHaveBeenCalled()
  })
})

// --- Unit tests for loadAndMergeSettings ---
describe('loadAndMergeSettings', () => {
  let mockGithubHub
  let mockRobot

  beforeEach(() => {
    jest.clearAllMocks()
    mockRobot = createMockRobot()
    mockGithubHub = {
      rest: {
        repos: {
          getContent: jest.fn()
        }
      }
    }
  })

  it('should return null when both globals and org settings are missing', async () => {
    mockGithubHub.rest.repos.getContent.mockRejectedValue({ status: 404 })
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    expect(result).toBeNull()
    expect(mockRobot.log.info).toHaveBeenCalledWith(expect.stringContaining('No settings.yml found'))
  })

  it('should return pure org settings when globals are missing', async () => {
    const orgContent = 'repository:\n  name: test'
    mockGithubHub.rest.repos.getContent
      .mockRejectedValueOnce({ status: 404 }) // globals missing
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(orgContent).toString('base64'),
          encoding: 'base64'
        }
      }) // org exists
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    expect(result).toBe(orgContent)
    expect(mockRobot.log.info).toHaveBeenCalledWith(expect.stringContaining('Using pure org settings'))
  })

  it('should return pure globals when org settings are missing', async () => {
    const globalsContent = 'repository:\n  name: global'
    mockGithubHub.rest.repos.getContent
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(globalsContent).toString('base64'),
          encoding: 'base64'
        }
      }) // globals exist
      .mockRejectedValueOnce({ status: 404 }) // org missing
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    // Should include auto-generated header even for pure globals
    expect(result).toContain('# Auto-generated by Safe-Settings Hub-Sync')
    expect(result).toContain('# Source: globals/settings.yml only')
    expect(result).toContain(globalsContent)
    expect(mockRobot.log.info).toHaveBeenCalledWith(expect.stringContaining('Using pure globals'))
  })

  it('should merge globals and org settings with org taking precedence', async () => {
    const globalsContent = 'repository:\n  name: global\n  description: global desc'
    const orgContent = 'repository:\n  name: org-override'
    
    mockGithubHub.rest.repos.getContent
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(globalsContent).toString('base64'),
          encoding: 'base64'
        }
      }) // globals
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(orgContent).toString('base64'),
          encoding: 'base64'
        }
      }) // org
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    expect(result).toContain('Auto-generated by Safe-Settings Hub-Sync')
    expect(result).toContain('name: org-override')
    expect(result).toContain('description: global desc')
    expect(mockRobot.log.info).toHaveBeenCalledWith(expect.stringContaining('Merging globals'))
  })

  it('should include header comment in merged output', async () => {
    const globalsContent = 'teams:\n  - developers'
    const orgContent = 'teams:\n  - admins'
    
    mockGithubHub.rest.repos.getContent
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(globalsContent).toString('base64'),
          encoding: 'base64'
        }
      })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(orgContent).toString('base64'),
          encoding: 'base64'
        }
      })
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    expect(result).toContain('# Auto-generated by Safe-Settings Hub-Sync')
    expect(result).toContain('# Merged from globals/settings.yml + organizations/test-org/settings.yml')
    expect(result).toContain('# Organization settings take precedence over globals')
    expect(result).toContain('# DO NOT EDIT THIS FILE DIRECTLY')
  })

  it('should fallback to org settings if merge fails', async () => {
    const globalsContent = 'invalid: yaml: content: ['
    const orgContent = 'repository:\n  name: org'
    
    mockGithubHub.rest.repos.getContent
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(globalsContent).toString('base64'),
          encoding: 'base64'
        }
      })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from(orgContent).toString('base64'),
          encoding: 'base64'
        }
      })
    
    const result = await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    expect(result).toBe(orgContent)
    expect(mockRobot.log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to merge'))
    expect(mockRobot.log.warn).toHaveBeenCalledWith(expect.stringContaining('Falling back'))
  })
})

// --- Unit tests for mergeConfigs ---
describe('mergeConfigs', () => {
  it('should merge simple objects with org taking precedence', () => {
    const globals = 'repository:\n  name: global\n  description: global desc'
    const org = 'repository:\n  name: org-override'
    
    const result = mergeConfigs(globals, org, false)
    
    expect(result.repository.name).toBe('org-override')
    expect(result.repository.description).toBe('global desc')
  })

  it('should merge arrays intelligently in smart merge mode', () => {
    const globals = 'teams:\n  - team-a\n  - team-b'
    const org = 'teams:\n  - team-b\n  - team-c'
    
    const result = mergeConfigs(globals, org, false)
    
    expect(result.teams).toContain('team-a')
    expect(result.teams).toContain('team-b')
    expect(result.teams).toContain('team-c')
    expect(result.teams.length).toBe(3)
  })

  it('should replace arrays in replace mode', () => {
    const globals = 'teams:\n  - team-a\n  - team-b'
    const org = 'teams:\n  - team-c'
    
    const result = mergeConfigs(globals, org, true)
    
    expect(result.teams).toEqual(['team-c'])
    expect(result.teams).not.toContain('team-a')
    expect(result.teams).not.toContain('team-b')
  })

  it('should merge nested objects deeply', () => {
    const globals = 'repository:\n  settings:\n    has_issues: true\n    has_wiki: false'
    const org = 'repository:\n  settings:\n    has_issues: false\n    has_downloads: true'
    
    const result = mergeConfigs(globals, org, false)
    
    expect(result.repository.settings.has_issues).toBe(false)
    expect(result.repository.settings.has_wiki).toBe(false)
    expect(result.repository.settings.has_downloads).toBe(true)
  })

  it('should handle empty configs gracefully', () => {
    const globals = ''
    const org = 'repository:\n  name: test'
    
    const result = mergeConfigs(globals, org, false)
    
    expect(result.repository.name).toBe('test')
  })

  it('should merge object arrays by identifying properties', () => {
    const globals = 'collaborators:\n  - username: alice\n    permission: pull'
    const org = 'collaborators:\n  - username: alice\n    permission: admin\n  - username: bob\n    permission: push'
    
    const result = mergeConfigs(globals, org, false)
    
    expect(result.collaborators).toHaveLength(2)
    const alice = result.collaborators.find(c => c.username === 'alice')
    expect(alice.permission).toBe('admin')
    const bob = result.collaborators.find(c => c.username === 'bob')
    expect(bob).toBeDefined()
  })
})

// --- Integration tests for source file non-mutation ---
describe('Source file non-mutation (integration)', () => {  let mockRobot

  beforeEach(() => {
    mockRobot = createMockRobot()
  })
  it('should never modify source files during merge operations', async () => {
    // This test verifies the principle that source files remain unchanged
    // In practice, this is ensured by the implementation loading content into
    // memory and never calling update APIs on the source repo
    
    const mockGithubHub = {
      rest: {
        repos: {
          getContent: jest.fn()
            .mockResolvedValueOnce({
              data: {
                content: Buffer.from('repository:\n  name: global').toString('base64'),
                encoding: 'base64'
              }
            })
            .mockResolvedValueOnce({
              data: {
                content: Buffer.from('repository:\n  name: org').toString('base64'),
                encoding: 'base64'
              }
            }),
          createOrUpdateFileContents: jest.fn()
        }
      }
    }
    
    await loadAndMergeSettings(mockRobot, mockGithubHub, 'test-org', 'abc123')
    
    // Verify that createOrUpdateFileContents was NEVER called on the hub repo
    expect(mockGithubHub.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled()
    // Only getContent should be called (read-only operations)
    expect(mockGithubHub.rest.repos.getContent).toHaveBeenCalledTimes(2)
  })
})
