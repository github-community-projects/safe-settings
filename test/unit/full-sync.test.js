/* eslint-disable no-undef */
const { spawnSync } = require('child_process')
const { generateKeyPairSync } = require('crypto')
const path = require('path')

describe('full-sync CLI with the installed Probot runtime', () => {
  let privateKey

  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
    }).privateKey
  })

  it.each([
    [false, 'success'],
    [true, 'success'],
    [false, 'missing-target'],
    [true, 'missing-target'],
    [false, 'sync-errors'],
    [true, 'sync-errors']
  ])('initializes before logging and preserves NOP=%s %s reporting', (nop, scenario) => {
    const cli = spawnSync(process.execPath, ['-e', `
      const forbidNetwork = () => { throw new Error('Network access forbidden in CLI regression') }
      global.fetch = forbidNetwork
      require('http').request = forbidNetwork
      require('https').request = forbidNetwork
      require('net').Socket.prototype.connect = forbidNetwork

      const { Probot } = require('probot')
      Probot.prototype.auth = async function (id) {
        await this.ready()
        if (id !== undefined && ![1, 2].includes(id)) throw new Error('Unexpected installation')
        return {
          paginate: async () => [
            { id: 1, account: { login: 'other-org' } },
            { id: 2, account: { login: 'test-org' } }
          ],
          rest: {
            apps: {
              listInstallations: { endpoint: { merge: options => options } },
              getAuthenticated: async () => ({ data: { slug: 'test-app' } })
            },
            repos: { getContent: async () => ({ data: { content: '' } }) }
          }
        }
      }
      const Module = require('module')
      const load = Module._load
      Module._load = function (name, parent, main) {
        if (name === './lib/settings' && parent.filename === require.resolve('./index')) {
          return {
            syncAll: async (nop, context, repo) => {
              console.log('SYNC_RESULT ' + JSON.stringify({ nop, owner: repo.owner, installation: context.payload.installation.id }))
              return { errors: process.env.TEST_SCENARIO === 'sync-errors' ? [{ msg: 'test sync failure' }] : [] }
            }
          }
        }
        return load.call(this, name, parent, main)
      }
      require('./full-sync')
    `], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        APP_ID: '1',
        PRIVATE_KEY: privateKey,
        GH_ORG: scenario === 'missing-target' ? 'missing-org' : 'TeSt-OrG',
        FULL_SYNC_NOP: String(nop),
        TEST_SCENARIO: scenario,
        LOG_FORMAT: 'json',
        LOG_LEVEL: 'info',
        DEPLOYMENT_CONFIG_FILE: path.join(__dirname, 'no-such-deployment-settings.yml')
      }
    })
    const output = cli.stdout + cli.stderr

    expect(cli.error).toBeUndefined()
    expect(output).not.toContain('Network access forbidden')
    expect(output).not.toContain('"owner":"other-org"')
    expect(output).toContain(`Starting full sync with NOP=${nop}`)
    expect(cli.status).toBe(scenario === 'success' ? 0 : 1)
    if (scenario === 'missing-target') {
      expect(output).toContain("No app installation found for GH_ORG 'missing-org'")
      expect(output).not.toContain('SYNC_RESULT')
    } else {
      expect(output).toContain('SYNC_RESULT ' + JSON.stringify({ nop, owner: 'test-org', installation: 2 }))
      expect(output).toContain('Syncing installation 2 on account test-org')
    }
    if (scenario === 'success') {
      expect(output).toContain('Full sync completed successfully.')
    } else {
      expect(output).not.toContain('Full sync completed successfully.')
    }
    if (scenario === 'sync-errors') {
      expect(output).toContain('Errors occurred during full sync.')
    }
  })
})

// Run both real entrypoints in a child process, replacing only external clients
// and Settings work. No App credentials or caller environment reach the child.
const script = `
  const Module = require('module')
  const fs = require('fs')
  const spec = JSON.parse(fs.readFileSync(0, 'utf8'))
  const load = Module._load
  const installations = spec.stages.map((stage, i) => ({
    id: i + 1, target_type: 'Organization', account: { login: 'org-' + (i + 1) }
  }))
  let enumerations = 0
  const appGithub = {
    paginate: async () => {
      if (++enumerations > 1 && spec.enumerationFailure) throw new Error('enumeration failed')
      return installations
    },
    rest: { apps: { listInstallations: { endpoint: { merge: x => x } } } }
  }
  const robot = {
    ready: async () => robot,
    on: () => {},
    log: { trace: () => {}, debug: () => {}, info: console.log, error: console.error },
    auth: async id => {
      if (id === undefined) return appGithub
      if (enumerations > 1 && spec.stages[id - 1] === 'auth') throw new Error('auth failed')
      return { id, rest: { apps: { getAuthenticated: async () => ({ data: { slug: 'test' } }) } } }
    }
  }
  class ConfigManager {
    constructor (context) { this.context = context }
    async loadGlobalSettingsYaml () {
      if (spec.stages[this.context.payload.installation.id - 1] === 'config') throw new Error('config failed')
      return {}
    }
  }
  const Settings = {
    handleError: async () => { console.error('config error reported') },
    syncAll: async (nop, context, repo) => {
      console.log('SYNC ' + repo.owner + ' auth=' + context.octokit.id + ' nop=' + nop)
      const stage = spec.stages[context.payload.installation.id - 1]
      if (stage === 'throw') throw new Error('sync failed')
      if (stage === 'missing') return undefined
      return { errors: stage === 'errors' ? [{ msg: 'repository failed', owner: repo.owner }] : [] }
    }
  }
  Module._load = function (name, parent, isMain) {
    if (name === 'probot') return { createProbot: () => robot }
    if (name === './lib/settings') return Settings
    if (name === './lib/configManager') return ConfigManager
    return load.call(this, name, parent, isMain)
  }
  require(process.argv[1])
`

const run = (stages, nop = false, enumerationFailure = false) => spawnSync(process.execPath, [
  '-e', script, require.resolve('../../full-sync')
], {
  env: {
    FULL_SYNC_NOP: String(nop),
    DEPLOYMENT_CONFIG_FILE: 'test/fixtures/no-deployment-settings.yml'
  },
  input: JSON.stringify({ stages, enumerationFailure }),
  encoding: 'utf8',
  timeout: 10000
})

describe('full-sync entrypoint', () => {
  it.each([false, true])('completes all successful installations in NOP=%s and exits zero', nop => {
    const cli = run(['success', 'success'], nop)
    expect(cli.error).toBeUndefined()
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain(`SYNC org-1 auth=1 nop=${nop}`)
    expect(cli.stdout).toContain(`SYNC org-2 auth=2 nop=${nop}`)
    expect(cli.stdout).toContain('Synced 2 of 2 installation(s); 0 failed')
    expect(cli.stdout).toContain('Full sync completed successfully.')
    expect(cli.stderr).toBe('')
  })

  it.each(['auth', 'config', 'throw', 'missing', 'errors'])(
    'exits nonzero after %s failure but still syncs later installations',
    stage => {
      const cli = run([stage, 'success'])
      expect(cli.error).toBeUndefined()
      expect(cli.status).toBe(1)
      expect(cli.stdout).toContain('SYNC org-2 auth=2 nop=false')
      expect(cli.stdout).toContain('Synced 1 of 2 installation(s); 1 failed')
      expect(cli.stderr).toContain('Errors occurred during full sync.')
      expect(cli.stdout).not.toContain('Full sync completed successfully.')
    }
  )

  it('exits nonzero for a real NOP configuration fall-through and still syncs the next installation', () => {
    const cli = run(['config', 'success'], true)
    expect(cli.status).toBe(1)
    expect(cli.stdout).toContain('SYNC org-2 auth=2 nop=true')
    expect(cli.stderr).toContain('config error reported')
    expect(cli.stderr).toContain('returned no result')
    expect(cli.stderr).toContain('Errors occurred during full sync.')
    expect(cli.stdout).not.toContain('Full sync completed successfully.')
  })

  it('keeps zero installations nonzero with an explicit diagnostic instead of a TypeError', () => {
    const cli = run([])
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('No eligible installations found for full sync.')
    expect(cli.stdout).not.toContain('TypeError')
    expect(cli.stdout).not.toContain('Full sync completed successfully.')
  })

  it('exits nonzero when enumeration fails before any sync', () => {
    const cli = run(['success'], false, true)
    expect(cli.status).toBe(1)
    expect(cli.stdout).toContain('Unexpected error during full sync: Error: enumeration failed')
    expect(cli.stdout).not.toContain('SYNC ')
    expect(cli.stdout).not.toContain('Full sync completed successfully.')
  })
})
