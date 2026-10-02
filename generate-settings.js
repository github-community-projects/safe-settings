/* eslint-disable camelcase */
/**
 * Standalone CLI to generate safe-settings YAML from the *current* state of a
 * repo / org / collection-of-repos and write it to the local filesystem.
 *
 * Usage (env or flags):
 *   SOURCE_TYPE=repo  SOURCE_VALUE=my-repo            node generate-settings.js
 *   SOURCE_TYPE=org   SOURCE_VALUE=my-org             node generate-settings.js
 *   SOURCE_TYPE=custom-property SOURCE_VALUE=Team=backend node generate-settings.js
 *
 *   node generate-settings.js --source-type repo --source-value my-repo \
 *        --owner my-org --output-dir ./out --overwrite
 *
 * When overwrite is false (default) and the target file already exists, a
 * `<name>.sample.yml` file is written instead of replacing the existing file.
 */
const fs = require('fs')
const path = require('path')

// Load .env into process.env before any module reads it (lib/env.js reads at
// require time). Mirrors the lightweight parser used by smoke-test.js so we
// avoid adding a dotenv dependency.
function loadEnv () {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  let currentKey = null
  let currentValue = ''
  let inMultiline = false

  for (const line of lines) {
    if (inMultiline) {
      currentValue += '\n' + line
      if (line.includes('"') || line.includes("'")) {
        const val = currentValue.replace(/^["']|["']$/g, '')
        // Like dotenv: .env values don't override existing env vars
        if (!(currentKey in process.env)) process.env[currentKey] = val
        inMultiline = false
      }
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    currentKey = trimmed.slice(0, eqIdx).trim()
    currentValue = trimmed.slice(eqIdx + 1).trim()
    if ((currentValue.startsWith('"') && !currentValue.endsWith('"')) ||
        (currentValue.startsWith("'") && !currentValue.endsWith("'"))) {
      inMultiline = true
      continue
    }
    const val = currentValue.replace(/^["']|["']$/g, '')
    if (!(currentKey in process.env)) process.env[currentKey] = val
  }
}

loadEnv()
const { createProbot } = require('probot')
const SettingsGenerator = require('./lib/settingsGenerator')

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (key === 'overwrite') {
        args.overwrite = true
      } else {
        args[key] = argv[++i]
      }
    }
  }
  return args
}

function resolveOptions () {
  const args = parseArgs(process.argv.slice(2))
  const sourceType = args['source-type'] || process.env.SOURCE_TYPE
  const sourceValue = args['source-value'] || process.env.SOURCE_VALUE
  const propertyName = args['property-name'] || process.env.SOURCE_PROPERTY_NAME
  const owner = args.owner || process.env.OWNER || process.env.GITHUB_ORG || process.env.GH_ORG
  const outputDir = args['output-dir'] || process.env.OUTPUT_DIR || '.'
  const overwrite = args.overwrite || process.env.OVERWRITE === 'true'

  if (!sourceType || !sourceValue) {
    throw new Error('SOURCE_TYPE and SOURCE_VALUE (or --source-type/--source-value) are required')
  }
  return { sourceType, sourceValue, propertyName, owner, outputDir, overwrite }
}

/**
 * Get an authenticated installation octokit + the org login.
 * If OWNER is provided we match its installation, otherwise use the first.
 */
async function getInstallationClient (probot, owner) {
  const app = await probot.auth()
  const installations = await app.paginate(
    app.apps.listInstallations.endpoint.merge({ per_page: 100 })
  )
  if (installations.length === 0) {
    throw new Error('No installations found for this GitHub App')
  }
  const installation = owner
    ? installations.find(i => i.account.login.toLowerCase() === owner.toLowerCase())
    : installations[0]
  if (!installation) {
    throw new Error(`No installation found for owner "${owner}"`)
  }
  const github = await probot.auth(installation.id)
  return { github, owner: installation.account.login }
}

/**
 * Write content to disk honoring the overwrite/.sample rule.
 * @returns {string} the path actually written
 */
function writeOutput (outputDir, filePath, content, overwrite) {
  let target = path.join(outputDir, filePath)
  if (!overwrite && fs.existsSync(target)) {
    const parsed = path.parse(target)
    target = path.join(parsed.dir, `${parsed.name}.sample${parsed.ext}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

async function main () {
  const opts = resolveOptions()
  const probot = createProbot()
  probot.log.info(`Generating settings: source-type=${opts.sourceType} source-value=${opts.sourceValue}`)

  const { github, owner } = await getInstallationClient(probot, opts.owner)
  const generator = new SettingsGenerator(github, owner, { log: probot.log })

  const { filePath, yaml } = await generator.generate({
    sourceType: opts.sourceType,
    sourceValue: opts.sourceValue,
    propertyName: opts.propertyName
  })

  const written = writeOutput(opts.outputDir, filePath, yaml, opts.overwrite)
  probot.log.info(`Wrote ${written}`)
  process.stdout.write(`${written}\n`)
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Error generating settings: ${error.stack || error}\n`)
    process.exit(1)
  })
}

module.exports = { parseArgs, resolveOptions, writeOutput, getInstallationClient }
