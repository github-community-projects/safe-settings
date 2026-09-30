const fs = require('fs')
const vm = require('vm')
const Teams = require('../../lib/plugins/teams')
const { isDeepStrictEqual } = require('node:util')

const source = fs.readFileSync(require.resolve('../../smoke-test'), 'utf8')
const phaseSource = source.slice(
  source.indexOf('async function phase26TeamSlugComparison ('),
  source.indexOf('\nasync function phase23ConfigLoading (')
)
const missing = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))

describe('team slug smoke fixture ownership', () => {
  let phase, github, logFail

  beforeEach(() => {
    github = {
      rest: {
        repos: {
          get: jest.fn(missing),
          createInOrg: jest.fn().mockResolvedValue({}),
          delete: jest.fn().mockResolvedValue({})
        },
        teams: {
          getByName: jest.fn(missing),
          create: jest.fn().mockResolvedValue({ data: { id: 42, name: 'Smoke Team Slug 26', slug: 'smoke-team-slug-26' } }),
          deleteInOrg: jest.fn().mockResolvedValue({})
        }
      },
      paginate: jest.fn().mockRejectedValue(new Error('Read failed')),
      hook: { remove: jest.fn() }
    }
    logFail = jest.fn()
    phase = vm.runInNewContext(`${phaseSource}\nphase26TeamSlugComparison`, {
      ORG: 'test-org',
      octokit: github,
      logPhase: jest.fn(),
      log: jest.fn(),
      logFail,
      assert: condition => condition,
      require: name => {
        if (name === './lib/plugins/teams') return Teams
        if (name === 'node:util') return { isDeepStrictEqual }
        throw new Error(`Unexpected dependency ${name}`)
      }
    })
  })

  it.each(['repo', 'team'])('refuses an existing %s without creating or deleting resources', async kind => {
    const lookup = kind === 'repo' ? github.rest.repos.get : github.rest.teams.getByName
    lookup.mockResolvedValue({ data: {} })
    await expect(phase()).rejects.toThrow('refuses to overwrite existing fixture')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.teams.create).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
    expect(github.rest.teams.deleteInOrg).not.toHaveBeenCalled()
  })

  it('does not treat authorization failure as proof of absence', async () => {
    github.rest.repos.get.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    await expect(phase()).rejects.toThrow('Forbidden')
    expect(github.rest.repos.createInOrg).not.toHaveBeenCalled()
    expect(github.rest.repos.delete).not.toHaveBeenCalled()
  })

  it('removes only the owned repo when team creation fails', async () => {
    github.rest.teams.create.mockRejectedValue(new Error('Creation failed'))
    await expect(phase()).rejects.toThrow('Creation failed')
    expect(github.rest.repos.delete).toHaveBeenCalledWith({ owner: 'test-org', repo: 'smoke-team-slug' })
    expect(github.rest.teams.deleteInOrg).not.toHaveBeenCalled()
  })

  it('cleans up only the returned team slug if creation encounters a naming race', async () => {
    github.rest.teams.create.mockResolvedValue({ data: { id: 43, name: 'Smoke Team Slug 26', slug: 'smoke-team-slug-26-1' } })
    await expect(phase()).rejects.toThrow('owned team has a real display-name/slug mismatch')
    expect(github.rest.teams.deleteInOrg).toHaveBeenCalledWith({ org: 'test-org', team_slug: 'smoke-team-slug-26-1' })
    expect(github.rest.teams.deleteInOrg).not.toHaveBeenCalledWith({ org: 'test-org', team_slug: 'smoke-team-slug-26' })
  })

  it('attempts both owned cleanups after failure and reports cleanup errors', async () => {
    github.rest.repos.delete.mockRejectedValue(new Error('Repo deletion failed'))
    await expect(phase()).rejects.toThrow('Read failed')
    expect(github.rest.repos.delete).toHaveBeenCalledTimes(1)
    expect(github.rest.teams.deleteInOrg).toHaveBeenCalledWith({ org: 'test-org', team_slug: 'smoke-team-slug-26' })
    expect(logFail).toHaveBeenCalledWith('26: fixture cleanup failed: Repo deletion failed')
  })
})
