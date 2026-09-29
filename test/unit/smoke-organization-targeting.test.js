/* eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

const smokePath = path.resolve(__dirname, '../../smoke-test.js')
const source = fs.readFileSync(smokePath, 'utf8')
const phaseSource = source.slice(
  source.indexOf('async function phase24OrganizationSyncTargeting ()'),
  source.indexOf('async function main ()')
)

describe('organization-targeted smoke phase', () => {
  let child, spawn, check, logFail, run, env
  const success = 'Starting full sync with NOP=true\nSyncing installation 2 on account My-Org\nFull sync completed successfully.'

  beforeEach(() => {
    child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    spawn = jest.fn(() => child)
    check = jest.fn(condition => Boolean(condition))
    logFail = jest.fn()
    env = { GH_ORG: 'my-org', FULL_SYNC_NOP: 'false', CRON: '* * * * *' }
    // Execute only this phase, never the live harness setup or its .env loader.
    run = vm.runInNewContext(`(${phaseSource})`, {
      spawn,
      assert: check,
      logPhase: jest.fn(),
      logFail,
      process: { execPath: process.execPath, env },
      path,
      __dirname: path.dirname(smokePath),
      ORG: 'my-org',
      orgInstallation: { id: 2, account: { login: 'My-Org' } }
    })
  })

  it('runs only the scoped CLI dry run with no background cron', async () => {
    const pending = run()
    child.stdout.emit('data', success)
    child.emit('close', 0, null)
    await pending

    expect(spawn).toHaveBeenCalledWith(process.execPath, [path.resolve(__dirname, '../../full-sync.js')], expect.objectContaining({
      timeout: 120000,
      env: expect.objectContaining({ GH_ORG: 'my-org', FULL_SYNC_NOP: 'true', CRON: '', LOG_LEVEL: 'info' })
    }))
    expect(check).toHaveBeenCalledTimes(6)
    expect(check.mock.results.every(result => result.value)).toBe(true)
    expect(env.FULL_SYNC_NOP).toBe('false')
    expect(env.CRON).toBe('* * * * *')
  })

  it.each([
    ['wrong account', success.replace('My-Org', 'other-org'), 0],
    ['wrong installation', success.replace('installation 2', 'installation 1'), 0],
    ['extra installation', success + '\nSyncing installation 1 on account other-org', 0],
    ['apply instead of NOP', success.replace('NOP=true', 'NOP=false'), 0],
    ['incomplete execution', success.replace('Full sync completed successfully.', ''), 0],
    ['CLI failure', success, 1],
    ['timeout', success, null],
    ['fatal output', success + '\nUnexpected error during full sync: failure', 0]
  ])('fails its assertions for %s', async (_name, output, code) => {
    const pending = run()
    child.stdout.emit('data', output)
    child.emit('close', code, code === null ? 'SIGTERM' : null)
    await pending

    expect(check.mock.results.some(result => !result.value)).toBe(true)
  })

  it('refuses to run with an implicit test organization', async () => {
    delete env.GH_ORG

    await expect(run()).rejects.toThrow('explicitly configured and verified test organization')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports process startup errors as failures', async () => {
    const pending = run()
    child.emit('error', new Error('spawn failed'))

    await expect(pending).rejects.toThrow('spawn failed')
    expect(logFail).toHaveBeenCalledWith('24: could not start full-sync CLI: spawn failed')
  })
})
