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
    for (const key of [...Object.keys(defaults), 'DEPLOYMENT_CONFIG_FILE']) {
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
})
