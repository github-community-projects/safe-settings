const fs = require('fs')
const vm = require('vm')

// Evaluate only the phase, never the smoke harness's live main()/setup/teardown.
const source = fs.readFileSync(require.resolve('../../smoke-test'), 'utf8')
const phaseSource = source.slice(
  source.indexOf('async function phase22InstallationFullSync ('),
  source.indexOf('\nasync function main ()')
)

describe('full-sync smoke safety boundary', () => {
  let phase, app, octokit, plugin, assert, logFail, environment

  beforeEach(() => {
    environment = { GH_ORG: 'test-org' }
    app = {
      octokit: {
        rest: {
          apps: {
            getInstallation: jest.fn(async () => ({
              data: { id: 7, target_type: 'Organization', account: { login: 'test-org' } }
            })),
            getAuthenticated: jest.fn(async () => ({ data: { slug: 'test-app' } }))
          }
        }
      }
    }
    octokit = {
      rest: { repos: { get: jest.fn(async () => ({ data: { owner: { login: 'test-org' } } })) } },
      request: { endpoint: options => options },
      hook: { before: jest.fn(), remove: jest.fn() }
    }
    plugin = jest.fn(robot => ({
      syncInstallation: async nop => {
        const client = await robot.auth(7)
        robot.log.info('Synced 1 of 1 installation(s); 0 failed')
        return {
          errors: [],
          results: [{
            errors: [],
            nop,
            installation_id: 7,
            repo: { owner: 'test-org' },
            github: client,
            processedRepoNames: new Set(['admin'])
          }]
        }
      }
    }))
    assert = jest.fn(condition => condition)
    logFail = jest.fn()
    phase = vm.runInNewContext(`${phaseSource}\nphase22InstallationFullSync`, {
      process: { env: environment },
      ORG: 'test-org',
      ADMIN_REPO: 'admin',
      octokit,
      logPhase: jest.fn(),
      log: jest.fn(),
      logFail,
      assert,
      URL,
      require: name => {
        if (name !== './index') throw new Error(`Unexpected smoke dependency: ${name}`)
        return plugin
      }
    })
  })

  it('restricts enumeration and authentication to the verified installation', async () => {
    await phase(app, 7)
    const robot = plugin.mock.calls[0][0]
    const appClient = await robot.auth()
    const route = appClient.rest.apps.listInstallations.endpoint.merge({ per_page: 100 })
    expect(await appClient.paginate(route)).toEqual([
      { id: 7, target_type: 'Organization', account: { login: 'test-org' } }
    ])
    await expect(appClient.paginate({})).rejects.toThrow('unexpected App request')
    await expect(robot.auth(8)).rejects.toThrow('outside the test organization')
    expect(assert).toHaveBeenCalledTimes(9)
    expect(assert.mock.calls.every(([condition]) => condition === true)).toBe(true)
    expect(octokit.hook.remove).toHaveBeenCalledWith('request', octokit.hook.before.mock.calls[0][1])
  })

  it('rejects CRON before main can import clients or start setup/server', async () => {
    const mainSource = source.slice(source.indexOf('async function main ()'), source.lastIndexOf('\nmain().catch'))
    const main = vm.runInNewContext(`${mainSource}\nmain`, {
      process: { env: { CRON: '* * * * *' } }
    })
    await expect(main()).rejects.toThrow('CRON unset to avoid syncing other installations')
  })

  it.each([
    { id: 8, target_type: 'Organization', account: { login: 'test-org' } },
    { id: 7, target_type: 'User', account: { login: 'test-org' } },
    { id: 7, target_type: 'Enterprise', account: { slug: 'test-org' } },
    { id: 7, target_type: 'Organization', account: { login: 'another-org' } }
  ])('rejects mismatched installation metadata %j before loading the plugin', async installation => {
    app.octokit.rest.apps.getInstallation.mockResolvedValue({ data: installation })
    await expect(phase(app, 7)).rejects.toThrow('does not match')
    expect(plugin).not.toHaveBeenCalled()
  })

  it.each([{ GH_ORG: '' }, { GH_ORG: 'another-org' }, { GH_ORG: 'test-org', CRON: '* * * * *' }])(
    'rejects unsafe environment %j before authenticating',
    async env => {
      Object.assign(environment, env)
      await expect(phase(app, 7)).rejects.toThrow('explicit GH_ORG and CRON unset')
      expect(app.octokit.rest.apps.getInstallation).not.toHaveBeenCalled()
    }
  )

  it('rejects an admin repository outside the verified organization', async () => {
    octokit.rest.repos.get.mockResolvedValue({ data: { owner: { login: 'another-org' } } })
    await expect(phase(app, 7)).rejects.toThrow('admin repository owner')
    expect(plugin).not.toHaveBeenCalled()
  })

  it('allows scoped reads but blocks writes and reads outside the test organization', async () => {
    await phase(app, 7)
    const guard = octokit.hook.before.mock.calls[0][1]
    for (const path of ['/installation/repositories', '/orgs/test-org', '/orgs/test-org/rulesets', '/repos/test-org/admin/contents/.github']) {
      expect(() => guard({ method: 'GET', url: `https://api.github.com${path}` })).not.toThrow()
      expect(() => guard({ method: 'GET', url: `https://ghe.example/api/v3${path}` })).not.toThrow()
    }
    for (const path of ['/orgs/another-org/rulesets', '/orgs/test-org-other/rulesets', '/repos/another-org/admin', '/app/installations']) {
      expect(() => guard({ method: 'GET', url: `https://api.github.com${path}` })).toThrow('out-of-org request')
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => guard({ method, url: 'https://api.github.com/repos/test-org/admin' })).toThrow('non-read-only')
    }
  })

  it('removes its hook even when sync fails', async () => {
    plugin.mockReturnValue({ syncInstallation: async () => { throw new Error('failed') } })
    await expect(phase(app, 7)).rejects.toThrow('failed')
    expect(octokit.hook.remove).toHaveBeenCalledWith('request', octokit.hook.before.mock.calls[0][1])
  })
})
