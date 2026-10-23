/* The HTTP side of remote mode: one openGym instance, one Bearer token, the same four routes the
   paired phone uses. Everything that talks to the network is here, so the tools and the state
   layer can be tested against a stub `fetchImpl` (or a fake backend) and never open a socket.

   Writes carry `stamped: false`: this writer does not stamp its own changes, so PUT /api/data
   (api/sync-stamps.js stampPut → stampUnstamped) records at the server's clock every entry the
   write removed, every setting it changed and every routine or workout whose content moved. That
   is the bookkeeping a device's merge needs, and it is why nothing in mcp/ imports the frontend's
   stampDeletions / stampEdits / stampRoutines. See docs/dev/MCP_WRITE.md, "Access modes". */
import fs from 'node:fs'
import path from 'node:path'
import { coded } from './schema.js'

// What a failed call reads as to the tool layer. The token never appears in a message: the URL's
// host does, so a wrong OPENGYM_URL is recognisable, and nothing else of the request.
const hostOf = url => { try { return new URL(url).host } catch { return String(url) } }

function baseOf(url) {
  const s = String(url || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(s)) throw coded('EINVAL', `OPENGYM_URL must start with http:// or https:// (got ${JSON.stringify(s)})`)
  if (/\/api$/i.test(s)) throw coded('EINVAL', 'OPENGYM_URL is the instance origin (e.g. https://gym.example.com) — leave /api off')
  return s
}

// The token file is the one place a renewed token survives a restart: written the way the api
// writes its own files, temp-then-rename, owner-only.
function readTokenFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
export function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

async function parseBody(res) {
  const text = await res.text()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
}

/**
 * The backend state.js drives in remote mode.
 *   read():   { state, rev, wid, user }   — GET /api/data (+ GET /api/me on the first call)
 *   write(state, { baseRev, baseWid }): { rev, wid }  — PUT /api/data, stamped: false
 *   me():     { user, token? }            — GET /api/me; a renewed token is adopted and persisted
 * Throws errors coded EAUTH / ECONFLICT / E2BIG / ENET / EIO (see docs/dev/MCP_WRITE.md).
 */
export function createRemoteBackend({ url, token, tokenFile = null, fetchImpl = globalThis.fetch, log = m => console.error(m) } = {}) {
  const base = baseOf(url)
  const fromFile = tokenFile ? readTokenFile(tokenFile) : null
  let bearer = (fromFile || token || '').trim()
  if (!bearer) throw coded('EAUTH', `no token for ${hostOf(base)}: set OPENGYM_TOKEN or OPENGYM_TOKEN_FILE (mint one with: node src/index.js pair <url> <code>)`)
  let user = null
  let hinted = false

  async function call(method, route, body) {
    let res
    try {
      res = await fetchImpl(base + route, {
        method,
        headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      throw coded('ENET', `cannot reach ${hostOf(base)}: ${e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || e?.code || e?.message || 'network error'}`)
    }
    const data = await parseBody(res)
    if (res.ok) return data
    if (res.status === 401) throw coded('EAUTH', `token refused by ${hostOf(base)}: it expired, was revoked by "Sign out everywhere", or the account is disabled — pair again`)
    if (res.status === 409) throw coded('ECONFLICT', 'another device wrote this profile in between', { rev: data.rev ?? null, state: data.state ?? null })
    if (res.status === 413) throw coded('E2BIG', 'the profile document is larger than the server accepts in one write')
    if (res.status === 503) throw coded('EIO', 'the server cannot read this profile\'s state file right now')
    throw coded('EIO', `${hostOf(base)} answered ${res.status}${data.error ? ': ' + data.error : ''} on ${method} ${route}`)
  }

  function adopt(renewed) {
    if (typeof renewed !== 'string' || !renewed || renewed === bearer) return
    bearer = renewed
    if (tokenFile) {
      try { writeTokenFile(tokenFile, bearer); return } catch (e) { log(`[opengym-mcp] could not write renewed token to ${tokenFile}: ${e.message}`) }
    }
    if (!hinted) { hinted = true; log('[opengym-mcp] the server renewed the token; set OPENGYM_TOKEN_FILE so it is kept across restarts') }
  }

  async function me() {
    const data = await call('GET', '/api/me')
    user = data.user || user
    adopt(data.token)
    return { user: data.user || null, token: data.token || null }
  }

  return {
    mode: 'remote',
    host: hostOf(base),
    get token() { return bearer },
    me,
    async read() {
      if (!user) await me()
      const data = await call('GET', '/api/data')
      const state = data.state && typeof data.state === 'object' ? data.state : null
      return { state, rev: Number(data.rev) || 0, wid: state?._wid || null, user }
    },
    async write(state, { baseRev = null, baseWid = null } = {}) {
      const body = { state, stamped: false }
      if (baseRev != null) body.baseRev = baseRev
      if (baseWid) body.baseWid = baseWid
      const data = await call('PUT', '/api/data', body)
      return { rev: Number(data.rev) || 0, wid: data.wid || null }
    }
  }
}

/** `node src/index.js pair <url> <code>`: redeems a pairing code once and returns the token. */
export async function redeemPairCode(url, code, { fetchImpl = globalThis.fetch } = {}) {
  const base = baseOf(url)
  let res
  try {
    res = await fetchImpl(base + '/api/pair/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim().toUpperCase() })
    })
  } catch (e) {
    throw coded('ENET', `cannot reach ${hostOf(base)}: ${e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || e?.code || e?.message || 'network error'}`)
  }
  const data = await parseBody(res)
  if (res.status === 400) throw coded('EINVAL', 'that pairing code did not work: codes last 5 minutes and work once — open Settings → Pair the mobile app and try a fresh one')
  if (!res.ok) throw coded('EIO', `${hostOf(base)} answered ${res.status}${data.error ? ': ' + data.error : ''}`)
  if (!data.token) throw coded('EIO', 'the server answered without a token')
  return { token: data.token, user: data.user || null }
}
