/* eslint-disable no-undef */
describe('env', () => {
  const originalEnv = process.env
  const defaults = {
    ADMIN_REPO: 'admin',
    CONFIG_PATH: '.github',
    SETTINGS_FILE_PATH: 'settings.yml',
    DEPLOYMENT_CONFIG_FILE_PATH: 'deployment-settings.yml',
    CREATE_PR_COMMENT: 'true',
    PR_COMMENT_SUMMARY_ENABLED: 'false',
    FULL_SYNC_NOP: false,
    GH_ORG: undefined
  }

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv }
    for (const key of [...Object.keys(defaults), 'DEPLOYMENT_CONFIG_FILE', 'ADMIN_REPO_OVERRIDES']) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('load default values without override', () => {
    it.each(Object.entries(defaults))('loads default %s if not passed', (key, value) => {
      expect(require('../../../lib/env')[key]).toEqual(value)
    })
  })

  describe('load override values', () => {
    beforeEach(() => {
      process.env.ADMIN_REPO = '.github'
      process.env.CONFIG_PATH = '.config'
      process.env.SETTINGS_FILE_PATH = 'safe-settings.yml'
      process.env.DEPLOYMENT_CONFIG_FILE = 'safe-settings-deployment.yml'
      process.env.CREATE_PR_COMMENT = 'false'
      process.env.PR_COMMENT_SUMMARY_ENABLED = 'true'
      process.env.FULL_SYNC_NOP = 'true'
      process.env.GH_ORG = 'My-Org'
    })

    it('loads override values if passed', () => {
      const envTest = require('../../../lib/env')
      const ADMIN_REPO = envTest.ADMIN_REPO
      expect(ADMIN_REPO).toEqual('.github')
      const CONFIG_PATH = envTest.CONFIG_PATH
      expect(CONFIG_PATH).toEqual('.config')
      const SETTINGS_FILE_PATH = envTest.SETTINGS_FILE_PATH
      expect(SETTINGS_FILE_PATH).toEqual('safe-settings.yml')
      const DEPLOYMENT_CONFIG_FILE_PATH = envTest.DEPLOYMENT_CONFIG_FILE_PATH
      expect(DEPLOYMENT_CONFIG_FILE_PATH).toEqual('safe-settings-deployment.yml')
      const CREATE_PR_COMMENT = envTest.CREATE_PR_COMMENT
      expect(CREATE_PR_COMMENT).toEqual('false')
      expect(envTest.PR_COMMENT_SUMMARY_ENABLED).toEqual('true')
      const FULL_SYNC_NOP = envTest.FULL_SYNC_NOP
      expect(FULL_SYNC_NOP).toEqual(true)
      expect(envTest.GH_ORG).toEqual('My-Org')
    })

    it('preserves an explicit false summary flag', () => {
      process.env.PR_COMMENT_SUMMARY_ENABLED = 'false'
      expect(require('../../../lib/env').PR_COMMENT_SUMMARY_ENABLED).toEqual('false')
    })
  })

  describe('adminRepoFor', () => {
    it('returns ADMIN_REPO for every account when no override is set', () => {
      process.env.ADMIN_REPO = 'safe-settings-config'
      const env = require('../../../lib/env')
      expect(env.ADMIN_REPO_OVERRIDES).toEqual({})
      expect(env.adminRepoFor('org-a')).toEqual('safe-settings-config')
      expect(env.adminRepoFor(undefined)).toEqual('safe-settings-config')
    })

    it('returns the per-account override and falls back to ADMIN_REPO', () => {
      process.env.ADMIN_REPO = 'safe-settings-config'
      process.env.ADMIN_REPO_OVERRIDES = 'Org-B=safe-settings-config-b, org-c = config-c'
      const env = require('../../../lib/env')
      expect(env.adminRepoFor('org-b')).toEqual('safe-settings-config-b')
      expect(env.adminRepoFor('ORG-B')).toEqual('safe-settings-config-b')
      expect(env.adminRepoFor('org-c')).toEqual('config-c')
      expect(env.adminRepoFor('org-a')).toEqual('safe-settings-config')
    })

    it('ignores malformed pairs', () => {
      process.env.ADMIN_REPO_OVERRIDES = 'org-b=,=config,org-c,org-d=config-d'
      const env = require('../../../lib/env')
      expect(env.ADMIN_REPO_OVERRIDES).toEqual({ 'org-d': 'config-d' })
      expect(env.adminRepoFor('org-b')).toEqual('admin')
      expect(env.adminRepoFor('org-c')).toEqual('admin')
    })

    it('follows ADMIN_REPO when it is replaced at runtime', () => {
      const env = require('../../../lib/env')
      jest.replaceProperty(env, 'ADMIN_REPO', 'policy-repo')
      expect(env.adminRepoFor('org-a')).toEqual('policy-repo')
    })
  })
})
