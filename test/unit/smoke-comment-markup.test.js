const fs = require('fs')
const vm = require('vm')
const Settings = require('../../lib/settings')
const NopCommand = require('../../lib/nopcommand')
const env = require('../../lib/env')

const source = fs.readFileSync(require.resolve('../../smoke-test'), 'utf8')
const phaseSource = source.slice(
  source.indexOf('async function phase28CommentMarkup ('),
  source.indexOf('\nasync function phase23ConfigLoading (')
)
const missing = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))
const mixedHtml = '<details><summary>Repository — 1 repo, 1 setting changed</summary><ul><li>~ <code>description</code><ul><li>before: <code>markup-before-28</code></li><li>after: <code>markup-after-28</code></li></ul></li></ul></details><details><summary>:warning: Errors — 1 repo affected</summary><ul><li>markup-error-28</li></ul></details>'
const emptyHtml = '<p><em>No changes to apply.</em></p><h3>Errors</h3><p><code>None</code></p>'

describe('posted comment markup smoke', () => {
  let github, phase, logFail, render, observer

  beforeEach(() => {
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    render = jest.fn(body => body.includes('markup-error-28') ? mixedHtml : emptyHtml)
    logFail = jest.fn()
    let comment
    let check
    github = {
      request: { endpoint: options => options },
      hook: {
        wrap: jest.fn((_name, callback) => { observer = callback }),
        remove: jest.fn(() => { observer = undefined })
      },
      rest: {
        repos: {
          get: jest.fn(missing),
          createInOrg: jest.fn().mockResolvedValue({
            data: { id: 123, owner: { login: 'test-org' }, name: 'smoke-comment-markup-28', default_branch: 'main' }
          }),
          createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({})
        },
        git: {
          getRef: jest.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
          createRef: jest.fn().mockResolvedValue({})
        },
        checks: {
          create: jest.fn().mockResolvedValue({ data: { id: 42 } }),
          update: jest.fn(async params => {
            check = params
            return { data: params }
          }),
          get: jest.fn(async () => ({ data: check }))
        },
        issues: {
          createComment: jest.fn(async params => {
            comment = { id: 100, body: params.body }
            return observer(async () => ({ data: comment }), {
              method: 'POST', url: 'https://api.github.com/repos/test-org/smoke-comment-markup-28/issues/7/comments'
            })
          }),
          getComment: jest.fn(async () => ({ data: { ...comment, body_html: render(comment.body) } }))
        }
      }
    }
    phase = vm.runInNewContext(`${phaseSource}\nphase28CommentMarkup`, {
      ORG: 'test-org',
      orgInstallation: { id: 99, account: { login: 'test-org' } },
      process: { env: { GH_ORG: 'test-org' } },
      octokit: github,
      URL,
      Buffer,
      logPhase: jest.fn(),
      log: jest.fn(),
      logFail,
      assert: condition => condition,
      createPR: jest.fn().mockResolvedValue({ number: 7, head: { sha: 'head-sha' } }),
      require: name => {
        if (name === './lib/settings') return Settings
        if (name === './lib/nopcommand') return NopCommand
        if (name === './lib/env') return env
        throw new Error(`Unexpected dependency ${name}`)
      }
    })
  })

  it('refuses an existing repo without creating or deleting anything', async () => {
    github.rest.repos.get.mockResolvedValue({ data: {} })
    await expect(phase()).rejects.toThrow('refuses to overwrite existing fixture')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('does not confuse failed authorization with a missing fixture', async () => {
    github.rest.repos.get.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    await expect(phase()).rejects.toThrow('Forbidden')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('requires comments to be enabled before any requests', async () => {
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'false')
    await expect(phase()).rejects.toThrow('CREATE_PR_COMMENT is explicitly enabled')
    expect(github.rest.repos.get).not.toHaveBeenCalled()
  })

  it('does not delete a repo when creation failed', async () => {
    github.rest.repos.createInOrg.mockRejectedValue(new Error('Creation failed'))
    await expect(phase()).rejects.toThrow('Creation failed')
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['missing HTML', () => undefined, 'GitHub returned rendered body_html'],
    ['empty HTML', () => '', 'GitHub returned rendered body_html'],
    ['empty sections', () => '<details></details><details></details>', 'expected populated summaries'],
    ['unclosed section', () => mixedHtml.replace('</details>', ''), 'expected populated summaries'],
    ['extra closing tag', () => `${mixedHtml}</details>`, 'expected populated summaries'],
    ['phantom row', () => `${mixedHtml}<table><tr></tr></table>`, 'phantom empty row'],
    ['missing diff', () => mixedHtml.replace('markup-after-28', 'not-the-diff'), 'actual field diff'],
    ['missing error', () => mixedHtml.replace('markup-error-28', 'not-the-error'), 'error as a separate list']
  ])('rejects %s readback and deletes only the owned repository', async (_name, html, error) => {
    render.mockImplementation(html)
    await expect(phase()).rejects.toThrow(error)
    expect(github.rest.repos.delete).toHaveBeenCalledTimes(1)
    expect(github.rest.repos.delete).toHaveBeenCalledWith({ owner: 'test-org', repo: 'smoke-comment-markup-28' })
    expect(github.hook.remove).toHaveBeenCalledTimes(1)
    expect(logFail).toHaveBeenCalled()
  })

  it('reports cleanup failure instead of logging phase completion', async () => {
    github.rest.repos.delete.mockRejectedValue(new Error('Deletion failed'))
    await expect(phase()).rejects.toThrow('Deletion failed')
    expect(logFail).toHaveBeenCalledWith('28: owned repository cleanup failed: Deletion failed')
  })

  it('accepts rendered emoji, HTML attributes and nonempty tables without claiming all tables are invalid', async () => {
    render.mockImplementation(body => body.includes('markup-error-28')
      ? mixedHtml.replace(':warning:', '<g-emoji alias="warning">warning</g-emoji>')
        .replaceAll('<li>', '<li dir="auto">')
        .replaceAll('<code>', '<code class="notranslate">') +
          '<table><tbody><tr><td>Nonempty table</td></tr></tbody></table>'
      : emptyHtml)
    await phase()
    expect(logFail).not.toHaveBeenCalled()
  })

  it('uses real Settings reporting and requires readback for both result shapes', async () => {
    await phase()
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(2)
    expect(github.rest.issues.getComment).toHaveBeenCalledTimes(2)
    expect(github.rest.issues.getComment).toHaveBeenCalledWith({
      owner: 'test-org', repo: 'smoke-comment-markup-28', comment_id: 100, mediaType: { format: 'full' }
    })
    expect(github.rest.issues.createComment.mock.calls[0][0].body).toContain('`markup-after-28`')
    expect(github.rest.issues.createComment.mock.calls[1][0].body).toContain('_No changes to apply._')
    expect(github.rest.checks.update.mock.calls.map(([params]) => params.conclusion)).toEqual(['failure', 'success'])
    expect(github.rest.checks.get).toHaveBeenCalledTimes(2)
    expect(github.rest.repos.delete).toHaveBeenCalledTimes(1)
    expect(logFail).not.toHaveBeenCalled()
  })
})
