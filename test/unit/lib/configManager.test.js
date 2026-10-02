/* eslint-disable no-undef */
const ConfigManager = require('../../../lib/configManager')
const env = require('../../../lib/env')
const { YAMLException } = require('js-yaml')

describe('configManager', () => {
  let context

  beforeEach(() => {
    jest.replaceProperty(env, 'ADMIN_REPO', 'admin')
    jest.replaceProperty(env, 'CONFIG_PATH', '.github')
    jest.replaceProperty(env, 'SETTINGS_FILE_PATH', 'settings.yml')
    context = {
      repo: () => { return { owner: 'test-org', repo: 'event-repo' } },
      octokit: {
        rest: {
          repos: {
            getContent: jest.fn()
          }
        }
      },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
      }
    }
  })

  describe('loadYaml', () => {
    it('returns the parsed YAML content when the file is fetched successfully', async () => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({
        data: { content: Buffer.from('key: value').toString('base64') }
      })

      const result = await configManager.loadYaml('.github/settings.yml')

      expect(result).toEqual({ key: 'value' })
      expect(context.octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'admin',
        path: '.github/settings.yml',
        ref: 'main'
      })
    })

    it('returns null when the path is a folder', async () => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({ data: [] })

      await expect(configManager.loadYaml('.github')).resolves.toBeNull()
    })

    it.each([
      { type: 'symlink', target: 'settings.yml' },
      { type: 'submodule', submodule_git_url: 'https://github.com/test-org/config.git' },
      { content: null }
    ])('returns undefined for a response without string content: %j', async data => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({ data })

      await expect(configManager.loadYaml('.github/settings.yml')).resolves.toBeUndefined()
    })

    it.each(['', '# empty\n', 'null\n'])('preserves empty YAML semantics for %j', async content => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({
        data: { content: Buffer.from(content).toString('base64') }
      })

      await expect(configManager.loadYaml('.github/settings.yml')).resolves.toEqual({})
    })

    it('propagates YAML parsing errors without replacing them with a TypeError', async () => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({
        data: { content: Buffer.from('repository: [').toString('base64') }
      })

      await expect(configManager.loadYaml('.github/settings.yml')).rejects.toBeInstanceOf(YAMLException)
    })

    it('returns null when the file does not exist', async () => {
      const configManager = new ConfigManager(context, 'main')
      const notFound = new Error('Not Found')
      notFound.status = 404
      context.octokit.rest.repos.getContent.mockRejectedValue(notFound)

      await expect(configManager.loadYaml('.github/settings.yml')).resolves.toBeNull()
    })

    it('propagates a non-404 error instead of masking it', async () => {
      const configManager = new ConfigManager(context, 'main')
      const serverError = new Error('Internal Server Error')
      serverError.status = 500
      context.octokit.rest.repos.getContent.mockRejectedValue(serverError)

      await expect(configManager.loadYaml('.github/settings.yml')).rejects.toThrow('Internal Server Error')
      await expect(configManager.loadYaml('.github/settings.yml')).rejects.toBe(serverError)
    })

    it('propagates the original error object so its status is preserved', async () => {
      const configManager = new ConfigManager(context, 'main')
      const forbidden = new Error('Forbidden')
      forbidden.status = 403
      context.octokit.rest.repos.getContent.mockRejectedValue(forbidden)

      await expect(configManager.loadYaml('.github/settings.yml')).rejects.toBe(forbidden)
    })

    it('preserves a network error without an HTTP status', async () => {
      const configManager = new ConfigManager(context)
      const networkError = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
      context.octokit.rest.repos.getContent.mockRejectedValue(networkError)

      await expect(configManager.loadYaml('.github/settings.yml')).rejects.toBe(networkError)
    })
  })

  describe('loadGlobalSettingsYaml', () => {
    it('loads the settings file from the configured config path', async () => {
      const configManager = new ConfigManager(context, 'main')
      context.octokit.rest.repos.getContent.mockResolvedValue({
        data: { content: Buffer.from('repository:\n  has_wiki: false').toString('base64') }
      })

      const result = await configManager.loadGlobalSettingsYaml()

      expect(result).toEqual({ repository: { has_wiki: false } })
      expect(context.octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'admin',
        path: '.github/settings.yml',
        ref: 'main'
      })
    })

    it.each(['feature/config', undefined])('uses the configured admin repo and POSIX path at ref %s', async ref => {
      jest.replaceProperty(env, 'ADMIN_REPO', 'policy-repo')
      jest.replaceProperty(env, 'CONFIG_PATH', 'policies/nested/')
      jest.replaceProperty(env, 'SETTINGS_FILE_PATH', 'org/settings.yaml')
      const configManager = new ConfigManager(context, ref)
      context.octokit.rest.repos.getContent.mockResolvedValue({
        data: { content: Buffer.from('repository:\n  has_wiki: false').toString('base64') }
      })

      await expect(configManager.loadGlobalSettingsYaml()).resolves.toEqual({ repository: { has_wiki: false } })
      expect(context.octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'policy-repo',
        path: 'policies/nested/org/settings.yaml',
        ref
      })
    })

    it('returns null for a missing global settings file', async () => {
      const configManager = new ConfigManager(context, 'main')
      const error = Object.assign(new Error('Not Found'), { status: 404 })
      context.octokit.rest.repos.getContent.mockRejectedValue(error)

      await expect(configManager.loadGlobalSettingsYaml()).resolves.toBeNull()
    })

    it.each([403, 500, undefined])('preserves global settings read failures with status %s', async status => {
      const configManager = new ConfigManager(context, 'main')
      const error = new Error('Config read failed')
      if (status !== undefined) error.status = status
      context.octokit.rest.repos.getContent.mockRejectedValue(error)

      await expect(configManager.loadGlobalSettingsYaml()).rejects.toBe(error)
    })
  })
})
