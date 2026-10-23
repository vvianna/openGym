/* The MCP's own in-progress workout. The app keeps the running session device-local (`S.active`,
   which the server strips from every PUT), so a set-by-set session logged through Hermes lives
   here, in a file, and only finish_workout turns it into a record — through the same logWorkout
   mutation log_workout uses. Never sent to the server. docs/dev/MCP_WRITE.md, "Session tools". */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getUser, getMode, refresh } from './state.js'
import { coded } from './schema.js'

const safe = s => String(s || 'profile').replace(/[^a-zA-Z0-9_-]/g, '')

/**
 * The profile id the draft is filed under. In remote mode the id comes from the server (GET
 * /api/me), so a process whose first read failed has none yet: it is asked for again here, and
 * the failure that answers (EAUTH, ENET…) is the tool's error — never a draft filed under no id
 * that a later, successful read would then not find.
 */
export async function resolvedUid() {
  let u = getUser()
  if (u.id == null && getMode() === 'remote') { await refresh(true); u = getUser() }
  if (u.id == null) throw coded('EIO', 'the profile is not known yet — the server has not answered GET /api/me')
  return u.id
}

/** Where the draft is kept: OPENGYM_SESSION_FILE, else ~/.opengym-mcp/active-<uid>.json — the
 *  home directory rather than tmp, so a reboot or a tmp cleaner cannot lose a half-logged session. */
export function sessionFile(uid) {
  if (uid == null) throw coded('EIO', 'no profile id for the session file — resolvedUid() first')
  const env = (process.env.OPENGYM_SESSION_FILE || '').trim()
  return env || path.join(os.homedir(), '.opengym-mcp', `active-${safe(uid)}.json`)
}

/** The open draft, or null. A corrupt file reads as null and is reported on stderr once. */
export function loadSession(uid) {
  const file = sessionFile(uid)
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  try {
    const s = JSON.parse(raw)
    return s && typeof s === 'object' && Array.isArray(s.entries) ? s : null
  } catch {
    console.error(`[opengym-mcp] ${file} is not valid JSON — ignoring it`)
    return null
  }
}

/** Writes the draft, temp-then-rename, owner-only. */
export function saveSession(uid, draft) {
  const file = sessionFile(uid)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(draft), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return draft
}

export function clearSession(uid) {
  try { fs.unlinkSync(sessionFile(uid)) } catch (e) { if (e.code !== 'ENOENT') throw e }
}
