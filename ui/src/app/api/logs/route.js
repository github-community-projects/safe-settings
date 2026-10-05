import fs from 'fs/promises'
import path from 'path'

export const dynamic = 'force-static'

async function findLogFile () {
  const candidates = []
  if (process.env.SAFE_SETTINGS_LOG_FILE) candidates.push(process.env.SAFE_SETTINGS_LOG_FILE)
  candidates.push(path.join(process.cwd(), 'safe-settings.log'))
  candidates.push(path.join(process.cwd(), '..', 'safe-settings.log'))
  candidates.push(path.join(process.cwd(), '..', '..', 'safe-settings.log'))

  for (const p of candidates) {
    if (!p) continue
    try {
      const st = await fs.stat(p)
      if (st && st.isFile()) return p
    } catch (e) {
      // ignore
    }
  }
  return null
}

export async function GET () {
  const msg = 'Disabled in static export: use the backend endpoint /api/safe-settings/logs or set SAFE_SETTINGS_LOG_FILE to point at the log file.'
  return new Response(msg, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
