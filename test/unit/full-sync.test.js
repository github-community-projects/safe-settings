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
