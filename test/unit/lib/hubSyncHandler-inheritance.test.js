const yaml = require('js-yaml')

jest.mock('../../../lib/installationCache', () => ({
  getInstallations: jest.fn()
}))

const env = require('../../../lib/env')
const {
  loadAndMergeSettings,
  checkInheritedSections,
  validateAndReportHubSync
} = require('../../../lib/hubSyncHandler')

const ROOT = '.github/safe-settings'
const GLOBALS = `${ROOT}/globals/settings.yml`
const ORG = `${ROOT}/organizations/my-org/settings.yml`

const globalsYaml = `
repository:
  has_issues: true
labels:
  - name: bug
    color: d73a4a
branches:
  - name: default
    protection:
      enforce_admins: true
`

// files: { 'path@ref': yamlString }
function makeOctokit (files) {
  return {
    rest: {
      repos: {
        getContent: jest.fn(async ({ path, ref }) => {
          const content = files[`${path}@${ref}`]
          if (content === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 })
          }
          return { data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } }
        })
      },
      issues: { createComment: jest.fn().mockResolvedValue({}) },
      checks: { update: jest.fn().mockResolvedValue({}) }
    }
  }
}

const robot = { log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }

beforeEach(() => {
  jest.replaceProperty(env, 'CONFIG_PATH', '.github')
  jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_PATH', 'safe-settings')
  jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_ORG', 'hub-org')
  jest.replaceProperty(env, 'SAFE_SETTINGS_HUB_REPO', 'hub-repo')
})

afterEach(() => {
  jest.restoreAllMocks()
})

function parseGenerated (content) {
  return yaml.load(content)
}

describe('loadAndMergeSettings: opting out of inherited sections', () => {
  it('keeps a globals section when the org file simply omits it', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@head`]: 'repository:\n  has_wiki: false\n'
    })
    const merged = parseGenerated(await loadAndMergeSettings(robot, octokit, 'my-org', 'head'))
    expect(merged.branches).toEqual([{ name: 'default', protection: { enforce_admins: true } }])
  })

  it('drops a globals section that the org file sets to null', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@head`]: 'repository:\n  has_wiki: false\nbranches: null\n'
    })
    const content = await loadAndMergeSettings(robot, octokit, 'my-org', 'head')
    const merged = parseGenerated(content)

    expect(merged).not.toHaveProperty('branches')
    expect(merged.labels).toEqual([{ name: 'bug', color: 'd73a4a' }])
    expect(merged.repository).toEqual({ has_issues: true, has_wiki: false })
    expect(content).toContain('# Not inherited from globals (set to null in org file): branches')
  })

  it('keeps nested nulls such as protection: null, which core uses to delete protection', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@head`]: 'branches:\n  - name: default\n    protection: null\n'
    })
    const merged = parseGenerated(await loadAndMergeSettings(robot, octokit, 'my-org', 'head'))
    expect(merged.branches).toEqual([{ name: 'default', protection: null }])
  })

  it('drops null sections when there is no globals file', async () => {
    const octokit = makeOctokit({
      [`${ORG}@head`]: 'labels:\n  - name: bug\nbranches: null\n'
    })
    const merged = parseGenerated(await loadAndMergeSettings(robot, octokit, 'my-org', 'head'))
    expect(merged).toEqual({ labels: [{ name: 'bug' }] })
  })

  it('returns org-only content unchanged (comments preserved) when there are no null sections', async () => {
    const orgContent = '# keep me\nlabels:\n  - name: bug\n'
    const octokit = makeOctokit({ [`${ORG}@head`]: orgContent })
    const content = await loadAndMergeSettings(robot, octokit, 'my-org', 'head')
    expect(content.endsWith(orgContent)).toBe(true)
  })
})

describe('checkInheritedSections', () => {
  it('reports sections deleted from the org file that globals still defines', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@main`]: 'labels: []\nbranches:\n  - name: default\nteams: []\n',
      [`${ORG}@head`]: 'labels: []\n'
    })
    const result = await checkInheritedSections(octokit, 'hub-org', 'hub-repo', 'my-org', 'main', 'head')
    // teams was removed too, but globals does not define it
    expect(result).toEqual({ stillInherited: ['branches'], optedOut: [] })
  })

  it('reports null sections as opted out instead of still inherited', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@main`]: 'branches:\n  - name: default\n',
      [`${ORG}@head`]: 'branches: null\n'
    })
    const result = await checkInheritedSections(octokit, 'hub-org', 'hub-repo', 'my-org', 'main', 'head')
    expect(result).toEqual({ stillInherited: [], optedOut: ['branches'] })
  })

  it('reports nothing for a new org file (no base version)', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@head`]: 'labels: []\n'
    })
    const result = await checkInheritedSections(octokit, 'hub-org', 'hub-repo', 'my-org', 'main', 'head')
    expect(result).toEqual({ stillInherited: [], optedOut: [] })
  })
})

describe('validateAndReportHubSync inheritance reporting', () => {
  function makeContext (octokit) {
    return {
      octokit,
      repo: () => ({ owner: 'hub-org', repo: 'hub-repo' })
    }
  }
  const payload = { repository: { owner: { login: 'hub-org' }, name: 'hub-repo' }, check_run: { id: 7 } }
  const pullRequest = { number: 95, head: { sha: 'head' } }

  it('warns (without failing) when a deleted section is still inherited from globals', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@main`]: 'labels: []\nbranches:\n  - name: default\n',
      [`${ORG}@head`]: 'labels: []\n'
    })
    await validateAndReportHubSync(robot, makeContext(octokit), payload, pullRequest, [ORG], 'main')

    const body = octokit.rest.issues.createComment.mock.calls[0][0].body
    expect(body).toContain('⚠️ Warnings')
    expect(body).toContain('`branches` was removed from `organizations/my-org/settings.yml`')
    expect(body).toContain('set `branches: null`')
    expect(octokit.rest.checks.update.mock.calls[0][0].conclusion).toBe('success')
  })

  it('lists null sections under Inheritance Overrides', async () => {
    const octokit = makeOctokit({
      [`${GLOBALS}@head`]: globalsYaml,
      [`${ORG}@main`]: 'branches:\n  - name: default\n',
      [`${ORG}@head`]: 'branches: null\n'
    })
    await validateAndReportHubSync(robot, makeContext(octokit), payload, pullRequest, [ORG], 'main')

    const body = octokit.rest.issues.createComment.mock.calls[0][0].body
    expect(body).toContain('Inheritance Overrides (1)')
    expect(body).toContain('Organization `my-org` will not inherit from globals: `branches`')
    expect(body).not.toContain('was removed from')
  })
})
