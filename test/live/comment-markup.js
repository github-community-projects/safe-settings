const assert = require('node:assert/strict')
const Settings = require('../../lib/settings')
const NopCommand = require('../../lib/nopcommand')
const env = require('../../lib/env')

const fixtureRepo = 'safe-settings-comment-markup-test'

async function runCommentMarkup ({ octokit, org, installation, log = console.log }) {
  assert(org && installation?.account?.login?.toLowerCase() === org.toLowerCase() &&
    installation.target_type === 'Organization', 'explicit test organization must match the authenticated installation')
  assert.equal(env.CREATE_PR_COMMENT, 'true', 'CREATE_PR_COMMENT must be enabled')
  const target = { owner: org, repo: fixtureRepo }
  try {
    await octokit.rest.repos.get(target)
    throw new Error(`Refusing to overwrite existing fixture ${org}/${fixtureRepo}`)
  } catch (error) {
    if (error.status !== 404) throw error
  }

  let repository
  const posted = []
  const errors = []
  let commentPath
  const observe = async (request, options) => {
    const response = await request(options)
    const endpoint = octokit.request.endpoint(options)
    if (endpoint.method === 'POST' && new URL(endpoint.url).pathname === commentPath) {
      posted.push(response.data)
    }
    return response
  }
  try {
    const created = await octokit.rest.repos.createInOrg({
      org, name: fixtureRepo, private: true, auto_init: true
    })
    repository = created.data
    assert.equal(repository.owner.login.toLowerCase(), org.toLowerCase())
    assert.equal(repository.name, fixtureRepo)
    log(`Created owned fixture ${org}/${fixtureRepo} (id ${repository.id})`)
    const branch = 'comment-markup-test'
    const { data: base } = await octokit.rest.git.getRef({ ...target, ref: `heads/${repository.default_branch}` })
    await octokit.rest.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha: base.object.sha })
    await octokit.rest.repos.createOrUpdateFileContents({
      ...target,
      branch,
      path: 'comment-markup.txt',
      message: 'Comment markup fixture',
      content: Buffer.from('Owned comment-rendering integration fixture.\n').toString('base64')
    })
    const { data: pr } = await octokit.rest.pulls.create({
      ...target,
      title: 'Comment markup integration fixture',
      body: 'Owned live integration fixture; no settings changes or webhook processing required.',
      head: branch,
      base: repository.default_branch
    })
    commentPath = `/repos/${org}/${fixtureRepo}/issues/${pr.number}/comments`
    octokit.hook.wrap('request', observe)

    // Results are synthetic; reporting, API responses and GitHub HTML are real.
    const scenarios = [
      {
        name: 'mixed',
        results: [
          new NopCommand('Repository', target, null, {
            additions: {},
            deletions: { description: 'markup-before' },
            modifications: { description: 'markup-after' }
          }),
          new NopCommand('Repository', target, null, 'markup-error', 'ERROR')
        ],
        conclusion: 'failure',
        sections: 2
      },
      { name: 'empty', results: [], conclusion: 'success', sections: 0 }
    ]
    for (const scenario of scenarios) {
      const { data: check } = await octokit.rest.checks.create({
        ...target, name: `Comment markup ${scenario.name}`, head_sha: pr.head.sha, status: 'in_progress'
      })
      const settings = new Settings(true, {
        payload: {
          installation: { id: installation.id },
          repository,
          check_run: { id: check.id, check_suite: { pull_requests: [{ number: pr.number }] } }
        },
        octokit,
        log: { debug () {}, info: log, error: message => { throw new Error(message) } }
      }, target, {}, branch)
      settings.results = scenario.results
      const before = posted.length
      await settings.handleResults()
      assert.equal(posted.length, before + 1, `${scenario.name}: Settings must post exactly one comment`)
      const comment = posted.at(-1)
      const { data: stored } = await octokit.rest.issues.getComment({
        ...target, comment_id: comment.id, mediaType: { format: 'full' }
      })
      assert.equal(stored.id, comment.id, 'read back the generated comment ID')
      assert.equal(stored.body, comment.body, 'read back the generated comment body')
      const html = stored.body_html
      assert(typeof html === 'string' && html.length > 0, 'GitHub must return rendered body_html')
      assert(!/<\/td>\s*<tr\b|<tr\b[^>]*>\s*<\/tr>/i.test(html), 'rendered HTML must not contain phantom empty rows')
      const sections = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) || []
      assert(sections.length === scenario.sections &&
        (html.match(/<details\b/g) || []).length === scenario.sections &&
        (html.match(/<\/details>/g) || []).length === scenario.sections &&
        sections.every(section => /<summary\b[^>]*>[\s\S]+?<\/summary>/.test(section)),
      'expected populated summaries must have complete details containers')
      if (scenario.name === 'mixed') {
        assert(sections.some(section =>
          /<summary\b[^>]*>Repository[^<]*1 repo, 1 setting changed<\/summary>/.test(section) &&
          /<code\b[^>]*>description<\/code>/.test(section) &&
          /<li\b[^>]*>before: <code\b[^>]*>markup-before<\/code><\/li>/.test(section) &&
          /<li\b[^>]*>after: <code\b[^>]*>markup-after<\/code><\/li>/.test(section)),
        'GitHub must render the actual field diff as code and list items')
        assert(sections.some(section =>
          /<summary\b[^>]*>[\s\S]*?Errors/.test(section) && /<li\b[^>]*>markup-error<\/li>/.test(section)),
        'GitHub must render the error as a separate list section')
      } else {
        assert(/<em\b[^>]*>No changes to apply\.<\/em>/.test(html) && /<code\b[^>]*>None<\/code>/.test(html),
          'GitHub must render the no-op and no-errors content')
      }
      const { data: completed } = await octokit.rest.checks.get({ ...target, check_run_id: check.id })
      assert.equal(completed.status, 'completed')
      assert.equal(completed.conclusion, scenario.conclusion)
      log(JSON.stringify({ scenario: scenario.name, repository: repository.id, pr: pr.number, check: check.id, comment: comment.id, htmlLength: html.length }))
    }
  } catch (error) {
    errors.push(error)
  } finally {
    octokit.hook.remove('request', observe)
    if (repository) {
      try {
        const { data: current } = await octokit.rest.repos.get(target)
        assert.equal(current.id, repository.id, 'fixture identity changed; refusing to delete a different repository')
        // The owned repository contains every PR, branch, check and comment.
        await octokit.rest.repos.delete(target)
        await assert.rejects(octokit.rest.repos.get(target), error => error.status === 404,
          'owned fixture must be absent after deletion')
        log(`Deleted owned fixture ${org}/${fixtureRepo}`)
      } catch (error) {
        errors.push(new Error(`Owned fixture cleanup failed for ${org}/${fixtureRepo}: ${error.message}`, { cause: error }))
      }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Comment reporting and cleanup failed')
  log('Live comment markup integration passed')
}

async function main () {
  const org = process.env.GH_ORG
  const appId = Number(process.env.APP_ID)
  assert(typeof org === 'string' && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(org),
    'Set GH_ORG explicitly to an authorized test organization')
  assert(Number.isSafeInteger(appId) && appId > 0, 'APP_ID must be a positive integer')
  assert(process.env.PRIVATE_KEY, 'PRIVATE_KEY is required')
  assert.equal(process.env.CREATE_PR_COMMENT, 'true', 'Set CREATE_PR_COMMENT=true explicitly')

  let installationId = null
  const transport = globalThis.fetch
  const fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = (options.method || input.method || 'GET').toUpperCase()
    const pathname = decodeURIComponent(url.pathname).toLowerCase()
    const owner = org.toLowerCase()
    const metadata = method === 'GET' && (pathname === '/app' || pathname === `/orgs/${owner}/installation`)
    const token = installationId && method === 'POST' && pathname === `/app/installations/${installationId}/access_tokens`
    const fixture = installationId && (pathname === `/repos/${owner}/${fixtureRepo}` ||
      pathname.startsWith(`/repos/${owner}/${fixtureRepo}/`) || (method === 'POST' && pathname === `/orgs/${owner}/repos`))
    assert(url.origin === 'https://api.github.com' && !url.username && !url.password &&
      !pathname.includes('\\') && !/%[0-9a-f]{2}/i.test(pathname) &&
      !pathname.split('/').some(part => part === '..' || part === '.') &&
      (metadata || token || fixture), `Live integration blocked ${method} ${pathname}`)
    return transport(input, { ...options, redirect: 'error' })
  }
  const { App, Octokit } = await import('octokit')
  const app = new App({
    appId,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
    Octokit: Octokit.defaults({ request: { fetch }, retry: { enabled: false }, throttle: { enabled: false } })
  })
  const { data: identity } = await app.octokit.rest.apps.getAuthenticated()
  assert.equal(identity.id, appId)
  const { data: installation } = await app.octokit.rest.apps.getOrgInstallation({ org })
  assert.equal(installation.app_id, appId)
  assert.equal(installation.target_type, 'Organization')
  assert.equal(installation.account.login.toLowerCase(), org.toLowerCase())
  assert(Number.isSafeInteger(installation.id) && installation.id > 0)
  installationId = installation.id
  const octokit = await app.getInstallationOctokit(installationId)
  await runCommentMarkup({ octokit, org, installation })
}

module.exports = { runCommentMarkup, main }

if (require.main === module) {
  main().catch(error => {
    console.error(error.message)
    if (error instanceof AggregateError) {
      for (const cause of error.errors) console.error(cause.message)
    }
    process.exitCode = 1
  })
}
