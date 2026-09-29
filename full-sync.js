const appFn = require('./')
const { FULL_SYNC_NOP } = require('./lib/env')
const { createProbot } = require('probot')

async function performFullSync (appFn, nop) {
  const probot = createProbot()
  probot.log.info(`Starting full sync with NOP=${nop}`)

  try {
    const app = appFn(probot, {})
    const settings = await app.syncInstallation(nop)

    if (settings === null) {
      probot.log.error('No eligible installations found for full sync.')
      process.exit(1)
    }

    if (settings.errors && settings.errors.length > 0) {
      probot.log.error('Errors occurred during full sync.')
      process.exit(1)
    }

    probot.log.info('Full sync completed successfully.')
  } catch (error) {
    process.stdout.write(`Unexpected error during full sync: ${error}\n`)
    process.exit(1)
  }
}

performFullSync(appFn, FULL_SYNC_NOP).catch((error) => {
  console.error('Fatal error during full sync:', error)
  process.exit(1)
})
