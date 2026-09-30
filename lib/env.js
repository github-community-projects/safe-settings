module.exports = {
  ADMIN_REPO: process.env.ADMIN_REPO || 'admin',
  APP_ID: process.env.APP_ID || null,
  PRIVATE_KEY_PATH: process.env.PRIVATE_KEY_PATH || 'private-key.pem',
  CONFIG_PATH: process.env.CONFIG_PATH || '.github',
  SETTINGS_FILE_PATH: process.env.SETTINGS_FILE_PATH || 'settings.yml',
  DEPLOYMENT_CONFIG_FILE_PATH: process.env.DEPLOYMENT_CONFIG_FILE || 'deployment-settings.yml',
  CREATE_PR_COMMENT: process.env.CREATE_PR_COMMENT || 'true',
  PR_COMMENT_SUMMARY_ENABLED: process.env.PR_COMMENT_SUMMARY_ENABLED || 'false',
  CREATE_ERROR_ISSUE: process.env.CREATE_ERROR_ISSUE || 'true',
  BLOCK_REPO_RENAME_BY_HUMAN: process.env.BLOCK_REPO_RENAME_BY_HUMAN || 'false',
  CREATE_DEFAULT_BRANCH: process.env.CREATE_DEFAULT_BRANCH === 'true',
  FULL_SYNC_NOP: process.env.FULL_SYNC_NOP === 'true',
  GH_ORG: process.env.GH_ORG,
  GHE_HOST: process.env.GHE_HOST,
  GHE_PROTOCOL: process.env.GHE_PROTOCOL,
  SAFE_SETTINGS_HUB_REPO: process.env.SAFE_SETTINGS_HUB_REPO || 'admin-master',
  SAFE_SETTINGS_HUB_ORG: process.env.SAFE_SETTINGS_HUB_ORG || 'admin-master-org',
  SAFE_SETTINGS_HUB_DIRECT_PUSH: process.env.SAFE_SETTINGS_HUB_DIRECT_PUSH || 'false',
  SAFE_SETTINGS_HUB_PATH: process.env.SAFE_SETTINGS_HUB_PATH || 'safe-settings',
  SAFE_SETTINGS_HUB_URL_PREFIX: (() => {
    const prefix = process.env.SAFE_SETTINGS_HUB_URL_PREFIX || '/safe-settings'
    // Normalize: add leading '/' if missing, treat '/' as empty string for root path
    if (!prefix || prefix === '/') return ''
    return prefix.startsWith('/') ? prefix : `/${prefix}`
  })(),
  SAFE_SETTINGS_HUB_REIMPORT: process.env.SAFE_SETTINGS_HUB_REIMPORT || 'false'
}
