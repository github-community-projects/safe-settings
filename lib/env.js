const ADMIN_REPO = process.env.ADMIN_REPO || 'admin'

// Optional per-account admin repo names, as comma-separated `account=repo`
// pairs (e.g. `my-org=admin,my-other-org=admin-other`). Accounts that are not
// listed use ADMIN_REPO. Account logins are matched case-insensitively.
const ADMIN_REPO_OVERRIDES = Object.fromEntries(
  (process.env.ADMIN_REPO_OVERRIDES || '')
    .split(',')
    .map(pair => pair.split('=').map(s => s.trim()))
    // Exactly one `=` per pair: `org=repo=extra` is ignored, not truncated.
    .filter(parts => parts.length === 2 && parts[0] && parts[1])
    .map(([account, repo]) => [account.toLowerCase(), repo])
)

// Admin repo name for an installation account (org or user login). Reads the
// exported values at call time, so they can still be replaced at runtime.
function adminRepoFor (owner) {
  const overrides = module.exports.ADMIN_REPO_OVERRIDES || {}
  const account = String(owner || '').toLowerCase()
  // Own keys only, so a login such as `constructor` never resolves to an
  // inherited Object property.
  return Object.prototype.hasOwnProperty.call(overrides, account)
    ? overrides[account]
    : module.exports.ADMIN_REPO
}

module.exports = {
  ADMIN_REPO,
  ADMIN_REPO_OVERRIDES,
  adminRepoFor,
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
}
