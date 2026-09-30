const { runCommentMarkup } = require('../live/comment-markup')
const env = require('../../lib/env')

const missing = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))
const mixedHtml = '<details><summary>Repository — 1 repo, 1 setting changed</summary><ul><li>~ <code>description</code><ul><li>before: <code>markup-before</code></li><li>after: <code>markup-after</code></li></ul></li></ul></details><details><summary>:warning: Errors — 1 repo affected</summary><ul><li>markup-error</li></ul></details>'
const emptyHtml = '<p><em>No changes to apply.</em></p><h3>Errors</h3><p><code>None</code></p>'

describe('live comment markup integration fixture', () => {
  let github, run, log, render, observer

  beforeEach(() => {
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'true')
    render = jest.fn(body => body.includes('markup-error') ? mixedHtml : emptyHtml)
    log = jest.fn()
    let comment
    let check
    let exists = false
    const repository = { id: 123, owner: { login: 'test-org' }, name: 'safe-settings-comment-markup-test', default_branch: 'main' }
    github = {
      request: { endpoint: options => options },
      hook: {
        wrap: jest.fn((_name, callback) => { observer = callback }),
        remove: jest.fn(() => { observer = undefined })
      },
      rest: {
        repos: {
          get: jest.fn(async () => exists ? { data: repository } : missing()),
          createInOrg: jest.fn(async () => {
            exists = true
            return { data: repository }
          }),
          createOrUpdateFileContents: jest.fn().mockResolvedValue({}),
          delete: jest.fn(async () => { exists = false })
        },
        pulls: { create: jest.fn().mockResolvedValue({ data: { number: 7, head: { sha: 'head-sha' } } }) },
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
              method: 'POST', url: 'https://api.github.com/repos/test-org/safe-settings-comment-markup-test/issues/7/comments'
            })
          }),
          getComment: jest.fn(async () => ({ data: { ...comment, body_html: render(comment.body) } }))
        }
      }
    }
    run = () => runCommentMarkup({
      org: 'test-org',
      installation: { id: 99, target_type: 'Organization', account: { login: 'test-org' } },
      octokit: github,
      log
    })
  })

  it('refuses an existing repo without creating or deleting anything', async () => {
    github.rest.repos.get.mockResolvedValue({ data: {} })
    await expect(run()).rejects.toThrow('Refusing to overwrite existing fixture')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('does not confuse failed authorization with a missing fixture', async () => {
    github.rest.repos.get.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    await expect(run()).rejects.toThrow('Forbidden')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('requires comments to be enabled before any requests', async () => {
    jest.replaceProperty(env, 'CREATE_PR_COMMENT', 'false')
    await expect(run()).rejects.toThrow('CREATE_PR_COMMENT must be enabled')
    expect(github.rest.repos.get).not.toHaveBeenCalled()
  })

  it('does not delete a repo when creation failed', async () => {
    github.rest.repos.createInOrg.mockRejectedValue(new Error('Creation failed'))
    await expect(run()).rejects.toThrow('Creation failed')
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['missing HTML', () => undefined, 'GitHub must return rendered body_html'],
    ['empty HTML', () => '', 'GitHub must return rendered body_html'],
    ['empty sections', () => '<details></details><details></details>', 'expected populated summaries'],
    ['unclosed section', () => mixedHtml.replace('</details>', ''), 'expected populated summaries'],
    ['extra closing tag', () => `${mixedHtml}</details>`, 'expected populated summaries'],
    ['phantom row', () => `${mixedHtml}<table><tr></tr></table>`, 'phantom empty rows'],
    ['missing diff', () => mixedHtml.replace('markup-after', 'not-the-diff'), 'actual field diff'],
    ['missing error', () => mixedHtml.replace('markup-error', 'not-the-error'), 'error as a separate list']
  ])('rejects %s readback and deletes only the owned repository', async (_name, html, error) => {
    render.mockImplementation(html)
    await expect(run()).rejects.toThrow(error)
    expect(github.rest.repos.delete).toHaveBeenCalledTimes(1)
    expect(github.rest.repos.delete).toHaveBeenCalledWith({ owner: 'test-org', repo: 'safe-settings-comment-markup-test' })
    expect(github.hook.remove).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalledWith('Live comment markup integration passed')
  })

  it('reports cleanup failure instead of logging completion', async () => {
    github.rest.repos.delete.mockRejectedValue(new Error('Deletion failed'))
    await expect(run()).rejects.toThrow('Owned fixture cleanup failed for test-org/safe-settings-comment-markup-test: Deletion failed')
    expect(log).not.toHaveBeenCalledWith('Live comment markup integration passed')
  })

  it('accepts rendered emoji, HTML attributes and nonempty tables without claiming all tables are invalid', async () => {
    render.mockImplementation(body => body.includes('markup-error')
      ? mixedHtml.replace(':warning:', '<g-emoji alias="warning">warning</g-emoji>')
        .replaceAll('<li>', '<li dir="auto">')
        .replaceAll('<code>', '<code class="notranslate">') +
          '<table><tbody><tr><td>Nonempty table</td></tr></tbody></table>'
      : emptyHtml)
    await run()
    expect(log).toHaveBeenCalledWith('Live comment markup integration passed')
  })

  it('uses real Settings reporting and requires readback for both result shapes', async () => {
    await run()
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(2)
    expect(github.rest.issues.getComment).toHaveBeenCalledTimes(2)
    expect(github.rest.issues.getComment).toHaveBeenCalledWith({
      owner: 'test-org', repo: 'safe-settings-comment-markup-test', comment_id: 100, mediaType: { format: 'full' }
    })
    expect(github.rest.issues.createComment.mock.calls[0][0].body).toContain('`markup-after`')
    expect(github.rest.issues.createComment.mock.calls[1][0].body).toContain('_No changes to apply._')
    expect(github.rest.checks.update.mock.calls.map(([params]) => params.conclusion)).toEqual(['failure', 'success'])
    expect(github.rest.checks.get).toHaveBeenCalledTimes(2)
    expect(github.rest.repos.delete).toHaveBeenCalledTimes(1)
    expect(github.rest.repos.get).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith('Live comment markup integration passed')
  })

  it('does not delete a replacement repository with a different identity', async () => {
    github.rest.repos.get.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: { id: 456 } })
    await expect(run()).rejects.toThrow('fixture identity changed')
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('preserves reporting and cleanup failures together', async () => {
    const failure = new Error('Readback failed')
    github.rest.issues.getComment.mockRejectedValue(failure)
    github.rest.repos.delete.mockRejectedValue(new Error('Deletion failed'))
    await expect(run()).rejects.toMatchObject({
      errors: [failure, expect.objectContaining({ message: expect.stringContaining('Deletion failed') })]
    })
  })

  it('fails when a deleted fixture is still accessible', async () => {
    github.rest.repos.delete.mockResolvedValue({})
    await expect(run()).rejects.toThrow('owned fixture must be absent after deletion')
  })

  it.each(['foreign', undefined])('rejects an unverified organization %s before fixture requests', async org => {
    await expect(runCommentMarkup({
      org,
      octokit: github,
      installation: { id: 99, target_type: 'Organization', account: { login: 'test-org' } },
      log
    })).rejects.toThrow('explicit test organization')
    expect(github.rest.repos.get).not.toHaveBeenCalled()
  })
})
