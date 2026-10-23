/* opengym-mcp state — two backends behind one getState().

   File mode (phase 1, unchanged): reads ./data/state-<uid>.json + db.json, read-only. Cached with
   an fs.watch + mtime fallback so a session the api server just wrote is visible on the next tool
   call without a restart.

   Remote mode (phase 2, docs/dev/MCP_WRITE.md): OPENGYM_URL + a Bearer token; reads GET /api/data,
   writes PUT /api/data through mutate(). The api is the only writer of the state file, so every
   write tool needs this mode — in file mode mutate() refuses with EPERM. */
import fs from 'node:fs'
import path from 'node:path'
import { createRemoteBackend } from './remote.js'
import { coded, localIso } from './schema.js'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')

// null = no state file (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions

// Remote mode. `_backend` is the object remote.js builds (or a fake in tests); `_remote` the last
// document read with the revision the next write is conditional on, and when it was read.
let _mode = 'file'
let _backend = null
let _remote = { state: undefined, rev: 0, wid: null, user: null, at: 0 }
let _chain = Promise.resolve()   // mutate() runs one at a time inside this process
export const REMOTE_TTL_MS = 2000

// null means one thing only: the file is not there (an account that never synced from a device).
// Every other failure — no permission on the mount, a truncated or corrupt file — is a real fault,
// and reporting it as "no synced state yet, sign in from a device" sends the operator to fix the
// wrong thing while the data sits there unreadable.
function readJsonOrNull(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    // Node's own message repeats the path it was given, and that is the server's absolute path:
    // the basename identifies the file just as well.
    const base = path.basename(file)
    const err = new Error(`cannot read ${base}: ${e.code || e.name} — ${String(e.message).replaceAll(file, base)}`)
    err.code = 'EIO'
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`${path.basename(file)} is not valid JSON: ${e.message}`)
    err.code = 'EIO'
    throw err
  }
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// Pick the uid: OPENGYM_UID env, else the only state-* file, else the only user in db.json.
// Throws listing the options if ambiguous. The sanitiser on stateFile() keeps a sneaky
// '..' in OPENGYM_UID harmless.
function resolveUid() {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error(`OPENGYM_UID contains characters that aren't safe in a filename: ${JSON.stringify(envUid)}`)
    return envUid
  }
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    reloadDb()
    if (_db.users.length === 1) return _db.users[0].id
    if (_db.users.length === 0) throw new Error(`no openGym users found in ${path.join(DATA_DIR, 'db.json')} — sign in at least once on a device`)
    // Multiple users in db.json but no state file yet — hit when accounts exist but none has
    // signed in on a device.
    throw ambiguousUid(_db.users.map(u => u.id))
  }
  throw ambiguousUid(files)
}

// "Which profile?" is a config question for the operator, and this message travels as a tool
// result: into the model's context and into whatever transcript it lands in. Every account id on
// the box, plus the server's absolute paths, has no business there. The count and the setting to
// change are what the model can act on; the ids and the path go to the server log on stderr,
// where the operator is already reading the startup line.
function ambiguousUid(ids) {
  console.error(`[opengym-mcp] ${ids.length} openGym profiles in ${DATA_DIR}: ${ids.join(', ')} — set OPENGYM_UID to one of them`)
  const err = new Error(`this openGym data directory holds ${ids.length} profiles — set OPENGYM_UID to the one this server should read (the ids are on the server's stderr, and in db.json under "users"[].id)`)
  err.code = 'EINVAL'
  return err
}

// Idempotent. Picks the uid, loads db.json, attaches the watcher, primes state.
export function init() {
  if (_uid !== null) return
  // Remote mode: the token names the profile, so there is no uid to resolve and no directory to
  // check. The first read (ready()) fills in the user; until then getState() answers null.
  if ((process.env.OPENGYM_URL || '').trim()) {
    _backend = createRemoteBackend({
      url: process.env.OPENGYM_URL,
      token: process.env.OPENGYM_TOKEN,
      tokenFile: (process.env.OPENGYM_TOKEN_FILE || '').trim() || null
    })
    _mode = 'remote'
    _uid = 'remote'
    return
  }
  if (!fs.existsSync(DATA_DIR)) throw new Error(`OPENGYM_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    _state = readJsonOrNull(file)
    if (_state) _state = Object.assign({}, defaultsShape(), _state)
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic-write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it — "exits when the LLM client disconnects" stops being true the
    // moment there is a state file to watch. Most clients kill the child anyway, but one that
    // merely closes the pipe would leak a process per session. Watching is unaffected: the
    // stdio transport is what keeps the loop alive while a client is actually attached.
    _watcher.unref()
  } catch { /* fs.watch unsupported on this platform; tools will re-read on mtime change */ }
}

// Returns the state object, or null for a fresh account that never signed in on a device.
export function getState() {
  init()
  if (_mode === 'remote') {
    // Synchronous by signature (the read tools call it so) and refreshed by the tool wrapper in
    // index.js (`await refresh()`) before any handler runs — see refresh() below.
    return _remote.state === undefined ? null : _remote.state
  }
  const file = stateFile(_uid)
  // Re-read if the file's mtime changed since our last load — covers watcher omissions and
  // platforms with no fs.watch.
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      // Same shape the frontend builds on pullState — defaults merged with stored state so any
      // field the app added since the snapshot was last saved shows up undefined-safe.
      _state = Object.assign({}, defaultsShape(), fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never signed in on a device
    }
  }
  return _state
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export function getUser() {
  init()
  if (_mode === 'remote') {
    const u = _remote.user || { id: null, name: 'Profile' }
    return { id: u.id ?? null, name: u.name || 'Profile', created: u.created || null }
  }
  const u = _db.users.find(x => x.id === _uid) || { id: _uid, name: 'Profile', created: null }
  return { id: u.id, name: u.name, created: u.created || null }
}

export const dataDir = () => DATA_DIR
export const getMode = () => { init(); return _mode }
export const getBackend = () => _backend
export const writesEnabled = () => getMode() === 'remote'

// The document as a tool sees it: the server's copy over the app's defaults, the way the
// frontend builds it on pullState, cloned so a mutation never edits the cache.
const overDefaults = state => Object.assign({}, defaultsShape(), structuredClone(state || {}))

function adoptRead(r) {
  _remote = { state: r.state ? overDefaults(r.state) : null, rev: r.rev || 0, wid: r.wid || null, user: r.user || _remote.user, at: Date.now() }
}

/**
 * Remote mode: re-read the document when the cache is older than REMOTE_TTL_MS (or `force`).
 * File mode: nothing to do (getState() re-reads on mtime by itself). index.js awaits this before
 * every tool handler, so the read tools — untouched since phase 1 — still answer from a fresh
 * document in remote mode.
 */
export async function refresh(force = false) {
  init()
  if (_mode !== 'remote') return
  if (!force && _remote.state !== undefined && Date.now() - _remote.at < REMOTE_TTL_MS) return
  adoptRead(await _backend.read())
}
/** The first read of a remote process; the startup line reports the profile it found. */
export async function ready() { await refresh(true); return getUser() }

/**
 * Applies `fn(S, ctx)` to a fresh copy of the current document and pushes the result, conditional
 * on the revision that copy was read at. `fn` mutates `S` in place (or returns a replacement) and
 * may return a value. One retry on ECONFLICT, re-applying `fn` to the document the 409 carried;
 * a second conflict propagates. Returns { state, result, rev, wid }, `state` being the pushed
 * document — what a tool reads its own write back from. Serialised: two mutations in one process
 * never interleave. In file mode throws EPERM before reading anything.
 */
export function mutate(fn, { label = 'write', now } = {}) {
  init()
  if (_mode !== 'remote') {
    return Promise.reject(coded('EPERM', `${label}: writes need remote mode — set OPENGYM_URL and OPENGYM_TOKEN; the openGym api is the only writer of the state file`))
  }
  const run = async () => {
    let base = await _backend.read()
    for (let attempt = 0; ; attempt++) {
      const S = overDefaults(base.state)
      const at = now ?? Date.now()
      const ctx = { now: at, todayIso: localIso(new Date(at)), unit: S.unit || 'kg' }
      const out = fn(S, ctx)
      const next = out && typeof out === 'object' && !Array.isArray(out) && 'state' in out ? out.state : S
      const result = out && typeof out === 'object' && !Array.isArray(out) && 'state' in out ? out.result : out
      try {
        const w = await _backend.write(next, { baseRev: base.rev, baseWid: base.wid })
        // The pushed document is the new cache; the server's own bookkeeping (_rev, _wid) rides
        // on it so a read within the TTL reports the revision this write produced.
        const pushed = structuredClone(next)
        pushed._rev = w.rev; if (w.wid) pushed._wid = w.wid
        _remote = { state: pushed, rev: w.rev, wid: w.wid || null, user: base.user || _remote.user, at: Date.now() }
        return { state: pushed, result, rev: w.rev, wid: w.wid || null }
      } catch (e) {
        if (e.code !== 'ECONFLICT' || attempt >= 1) {
          if (e.code === 'ECONFLICT') e.message = `${label}: the profile was written by another device twice while this write was in flight — try again in a moment`
          _remote.at = 0   // whatever the cache holds is stale now
          throw e
        }
        // The 409 carries the current document; a read is the fallback for a server that did not.
        base = e.state ? { state: e.state, rev: e.rev ?? 0, wid: e.state?._wid || null, user: base.user } : await _backend.read()
      }
    }
  }
  const p = _chain.then(run, run)
  _chain = p.catch(() => {})
  return p
}

// Test-only: a fake backend ({ read, write, me? }) stands in for the network; mode becomes remote.
export function _setBackendForTests(backend, user = { id: 'test-uid', name: 'Test' }) {
  _uid = user.id
  _db = { users: [user], creds: [], subs: [], invites: [] }
  _backend = backend
  _mode = backend ? 'remote' : 'file'
  _remote = { state: undefined, rev: 0, wid: null, user: backend ? user : null, at: 0 }
  _chain = Promise.resolve()
  if (_watcher) { _watcher.close(); _watcher = null }
  if (!backend) { _state = undefined; _loadedMtime = 0 }
}

// Test-only: work against a passed-in state, not the disk.
export function _seedStateForTests(state) {
  _mode = 'file'; _backend = null
  _remote = { state: undefined, rev: 0, wid: null, user: null, at: 0 }
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  if (_watcher) { _watcher.close(); _watcher = null }
}

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
