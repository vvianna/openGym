// End to end: the real api/server.js in a child process, the MCP in remote mode against it, and
// the state file on disk read after every write. The unit suites drive the tools over a fake
// backend; this is the one place the whole chain — Bearer auth, GET/PUT /api/data, baseRev, the
// server's stamping of an unstamped writer, the 409 retry — runs against the server as shipped.
//
// The tools are called in-process (state.js in remote mode, handlers invoked directly after
// `await refresh()`, as index.js does) rather than over a spawned stdio server: the same code
// path minus the JSON-RPC framing, which capabilities.test.js and the SDK smoke runs cover, and
// it lets the test read the pushed document and the session file between calls without racing a
// second process.
import { describe, beforeAll, afterAll, test, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const API = path.join(ROOT, 'api')
const UID = 'u_e2e_1'
const SECRET = crypto.randomBytes(32).toString('hex')

// The same session token the api mints: `uid:expiry:version` HMAC'd with the secret file.
function mint(uid, { expiry = Date.now() + 86400000, secret = SECRET, sv = 0 } = {}) {
  const payload = `${uid}:${expiry}:${sv}`
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

// Boots server.js with PORT=0 and reads the port off its boot line, which is also the readiness
// signal (api/test/helpers.mjs boundPort explains why the test never picks a port itself).
function startServer(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  const port = new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error(`server never announced a port:\n${log}`)), 20000)
    const look = () => { const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); child.stdout.off('data', look); resolve(+m[1]) } }
    child.stdout.on('data', look)
    child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
  })
  return { child, port, log: () => log }
}

let dataDir, srv, base, token, tmp
// Everything the test calls, bound to the server above; filled in beforeAll.
let state, call, stateFile
const realFetch = globalThis.fetch
// A hook the 409 case arms: run once, after the MCP's next GET /api/data has been answered and
// before that answer reaches it — the window in which "another device" writes.
let afterNextRead = null

const onDisk = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const apiGet = async (tok = token) => {
  const r = await realFetch(`${base}/api/data`, { headers: { Authorization: 'Bearer ' + tok } })
  return { status: r.status, body: await r.json() }
}
// What a phone does: read, change, push conditionally (stamped: false keeps the server's own
// bookkeeping in play, as for any client that does not stamp).
const phoneWrites = async mutator => {
  const { body } = await apiGet()
  const S = body.state || {}
  mutator(S)
  const r = await realFetch(`${base}/api/data`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: S, baseRev: body.rev, baseWid: S._wid, stamped: false })
  })
  expect(r.status).toBe(200)
  return r.json()
}

const rejects = async (p, code, re) => {
  let err = null
  try { await p } catch (e) { err = e }
  expect(err, 'expected a thrown error').toBeTruthy()
  expect(err.code).toBe(code)
  if (re) expect(err.message).toMatch(re)
  return err
}

// A fresh state.js + tools bound to the env given (state.js reads OPENGYM_URL at init()).
async function loadMcp(env) {
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const st = await import('../src/state.js')
  const { TOOLS } = await import('../src/tools.js')
  const { WRITE_TOOLS } = await import('../src/write-tools.js')
  const { SESSION_TOOLS } = await import('../src/session-tools.js')
  const { CAPABILITY_TOOLS } = await import('../src/capabilities.js')
  const groups = { read: TOOLS.map(t => t.name), write: WRITE_TOOLS.map(t => t.name), session: SESSION_TOOLS.map(t => t.name) }
  const all = [...TOOLS, ...WRITE_TOOLS, ...SESSION_TOOLS, ...CAPABILITY_TOOLS(groups)]
  const byName = Object.fromEntries(all.map(t => [t.name, t]))
  // index.js's wrapper: a refresh before every handler, so the read tools see the server's copy.
  const invoke = async (name, params = {}) => { await st.refresh(); return byName[name].handler(params) }
  return { state: st, call: invoke, count: all.length }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-home-'))
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: UID, name: 'Victor', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }))
  stateFile = path.join(dataDir, `state-${UID}.json`)
  srv = startServer(dataDir)
  base = `http://127.0.0.1:${await srv.port}`
  token = mint(UID)
  // remote.js takes globalThis.fetch at construction, so the hook goes in before the import.
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init)
    if (afterNextRead && (init?.method || 'GET') === 'GET' && String(url).endsWith('/api/data')) {
      const run = afterNextRead; afterNextRead = null
      await run()
    }
    return res
  }
  const m = await loadMcp({
    OPENGYM_URL: base, OPENGYM_TOKEN: token,
    OPENGYM_TOKEN_FILE: path.join(tmp, 'token'), OPENGYM_SESSION_FILE: path.join(tmp, 'active.json')
  })
  state = m.state; call = m.call
  expect(m.count).toBe(26)
}, 40000)

afterAll(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
  try { srv.child.kill('SIGKILL') } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

/* ---------- 1. a fresh profile ---------- */

let benchId, rowId, firstId, pastId
// The revision the last check saw on disk; every write below is asserted relative to it.
let rev = 0

describe('a fresh profile over the real api', () => {
  test('get_capabilities reports remote mode with writes enabled, before any document exists', async () => {
    expect(fs.existsSync(stateFile)).toBe(false)
    const u = await state.ready()
    expect(u).toMatchObject({ id: UID, name: 'Victor' })
    const c = await call('get_capabilities')
    expect(c.mode).toBe('remote')
    expect(c.writes).toMatchObject({ enabled: true, reason: null })
    expect(c.profile).toMatchObject({ id: UID, name: 'Victor', unit: 'kg' })
    expect(c.tools.write.map(t => t.name)).toContain('log_workout')
    expect(c.tools.session.map(t => t.name)).toContain('finish_workout')
  })

  // KNOWN DEFECT, kept visible: a profile that never synced from a device has no document, and
  // every write tool refuses with ENOENT ("sign in on a device once") although PUT /api/data
  // would create the document from the defaults mutate() already builds over a null read. The
  // test is marked `fails` so the suite stays green until the guard is lifted — once it is, this
  // test fails and should become a plain `test`, asserting `_rev` 1 on disk.
  test.fails('log_workout on a profile with no document yet creates it (currently refused with ENOENT)', async () => {
    const r = await call('log_workout', { exercises: [{ exercise: '0025', sets: [{ w: 60, r: 10 }] }] })
    expect(r.ok).toBe(true)
    expect(onDisk()._rev).toBe(1)
  })

  test('the phone signs in and pushes the first document (unit kg, Portuguese names on)', async () => {
    const r = await phoneWrites(S => { Object.assign(S, { unit: 'kg', lang: 'pt-BR', routines: [], workouts: [], bodyweight: [], exWeights: {}, customEx: [] }) })
    expect(r.rev).toBe(1)
    rev = 1
    expect(onDisk()._rev).toBe(1)
    await state.refresh(true)
    expect((await call('get_capabilities')).profile.lang).toBe('pt-BR')
  })

  test('search_exercises resolves Portuguese names', async () => {
    const r = await call('search_exercises', { query: 'supino com barra', body_part: 'chest' })
    expect(r.lang).toBe('pt-BR')
    expect(r.count).toBeGreaterThan(0)
    expect(r.exercises[0]).toMatchObject({ id: '0025', name_en: 'barbell bench press', name_localized: 'supino com barra' })
    benchId = r.exercises[0].id
    // "remada curvada" names several rows (lever, cable, barbell): the English name is exact.
    const row = await call('search_exercises', { query: 'barbell bent over row', body_part: 'back' })
    expect(row.exercises[0]).toMatchObject({ id: '0027', name_en: 'barbell bent over row' })
    expect(row.exercises[0].name_localized).toMatch(/remada/)
    rowId = row.exercises[0].id
  })

  test('log_workout stores the workout with the gym, the note prefix, done sets and the volume', async () => {
    const r = await call('log_workout', {
      gym: 'Iron', note: 'ombro incomodou', duration_min: 50,
      exercises: [
        { exercise: 'supino com barra', note: 'pegada aberta', note_pin: true, sets: [{ w: 60, r: 10 }, { w: 60, r: 8, rir: 1 }] },
        { exercise: rowId, sets: [{ w: 50, r: 8 }, { w: 50, r: 8 }] }
      ]
    })
    expect(r.ok).toBe(true)
    expect(r.workout_id).toBeTruthy()
    firstId = r.workout_id
    expect(r).toMatchObject({ gym: 'Iron', note: 'Iron · ombro incomodou', unit: 'kg', volume: 60 * 18 + 50 * 16, sets_done: 4, rev: rev + 1, warnings: [] })
    expect(r.exercises.map(e => e.id)).toEqual([benchId, rowId])
    expect(r.exercises[0]).toMatchObject({ note: 'pegada aberta', note_pin: true })
    expect(r.exercises[0].sets.every(s => s.done)).toBe(true)

    // On disk, as the server wrote it.
    const doc = onDisk()
    expect(doc._rev).toBe(rev + 1)
    rev = doc._rev
    expect(typeof doc._wid).toBe('string')
    expect(doc.workouts).toHaveLength(1)
    const w = doc.workouts[0]
    expect(w).toMatchObject({ id: firstId, gym: 'Iron', note: 'Iron · ombro incomodou', name: 'Workout' })
    expect(w.entries[0].sets.map(s => s.done)).toEqual([true, true])
    expect(w.vol).toBe(60 * 18 + 50 * 16)
    expect(w.end - w.start).toBe(50 * 60000)
    expect('active' in doc).toBe(false)
    // A live (today) session raises the kept working weight, as the finish sheet does.
    expect(doc.exWeights[benchId]).toMatchObject({ w: 60 })
    // …and the api answers with the same document.
    const { status, body } = await apiGet()
    expect(status).toBe(200)
    expect(body.rev).toBe(rev)
    expect(body.state.workouts[0].id).toBe(firstId)
    // The read tools, untouched since phase 1, see it through the same cache.
    const list = await call('list_workouts')
    expect(list.workouts.map(w => w.id)).toEqual([firstId])
  })

  test('a past date is filed in chronological order and the revision advances', async () => {
    const r = await call('log_workout', { date: '2026-01-10', gym: 'Smart Fit', exercises: [{ exercise: benchId, sets: [{ w: 40, r: 12 }] }] })
    expect(r).toMatchObject({ date: '2026-01-10', rev: rev + 1 })
    pastId = r.workout_id
    const doc = onDisk()
    expect(doc._rev).toBe(rev + 1)
    rev = doc._rev
    expect(doc.workouts.map(w => w.id)).toEqual([pastId, firstId])   // older first
    const past = doc.workouts[0]
    expect(past.d).toBe('2026-01-10')
    expect(typeof past._ts).toBe('number')                           // stamped as a logged-in-the-past record
    expect(past.end - past.start).toBe(60 * 60000)                   // the backfill default length
    // A past session leaves the kept working weight alone.
    expect(doc.exWeights[benchId].w).toBe(60)
    expect((await call('get_workout', { workout_id: pastId })).date).toBe('2026-01-10')
  })
})

/* ---------- 3. a phone writes in between ---------- */

describe('a concurrent write from another device', () => {
  test('a 409 between read and write is retried and both changes survive', async () => {
    const before = onDisk()._rev
    // The wrapper's refresh() is a no-op inside the cache TTL, so the next GET /api/data is the
    // mutation's own read — the one the phone's write has to land right after.
    await state.refresh(true)
    afterNextRead = () => phoneWrites(S => { S.bodyweight = [...(S.bodyweight || []), { d: '2026-07-01', w: 81.5, t: Date.now() }] })
    const r = await call('log_workout', { gym: 'Iron', exercises: [{ exercise: rowId, sets: [{ w: 55, r: 8 }] }] })
    expect(afterNextRead).toBeNull()                                 // the phone did write
    const doc = onDisk()
    expect(doc._rev).toBe(before + 2)                                // the phone's write, then ours
    expect(r.rev).toBe(doc._rev)
    expect(doc.bodyweight.some(b => b.w === 81.5)).toBe(true)        // theirs
    expect(doc.workouts.some(w => w.id === r.workout_id)).toBe(true)  // ours
    expect(doc.workouts).toHaveLength(3)
  })
})

/* ---------- 4. correcting and deleting ---------- */

describe('update_workout and delete_workout', () => {
  let corrected
  test('update_workout changes a set weight and the server stores the corrected record', async () => {
    const r = await call('update_workout', {
      workout_id: firstId,
      exercises: [
        { exercise: benchId, note: 'pegada aberta', note_pin: true, sets: [{ w: 65, r: 10 }, { w: 65, r: 8, rir: 1 }] },
        { exercise: rowId, sets: [{ w: 50, r: 8 }, { w: 50, r: 8 }] }
      ]
    })
    expect(r.ok).toBe(true)
    expect(r.changed).toContain('exercises')
    expect(r.exercises[0].sets.map(s => s.w)).toEqual([65, 65])
    expect(r.volume).toBe(65 * 18 + 50 * 16)
    const w = onDisk().workouts.find(x => x.id === firstId)
    expect(w.entries[0].sets.map(s => s.w)).toEqual([65, 65])
    expect(w.vol).toBe(65 * 18 + 50 * 16)
    // The app's editor only LOWERS a kept weight an edit took away (session-edit.js
    // lowerKeptWeights); a correction upwards leaves it, and the next live session raises it.
    expect(onDisk().exWeights[benchId].w).toBe(60)
    corrected = w
  })

  test('update_workout can move the date, retime and rename without touching the sets', async () => {
    const r = await call('update_workout', { workout_id: pastId, date: '2026-01-12', start: '07:30', duration_min: 45, name: 'Treino A' })
    expect(r.changed).toEqual(expect.arrayContaining(['date', 'duration', 'name']))
    const w = onDisk().workouts.find(x => x.id === pastId)
    expect(w).toMatchObject({ d: '2026-01-12', name: 'Treino A' })
    expect(w.end - w.start).toBe(45 * 60000)
    expect(new Date(w.start).getHours()).toBe(7)
    expect(w.entries[0].sets[0]).toMatchObject({ w: 40, r: 12 })
  })

  test('delete_workout removes the record and the server records the deletion for the other devices', async () => {
    const r = await call('delete_workout', { workout_id: pastId, confirm: true })
    expect(r.ok).toBe(true)
    expect(r.deleted).toMatchObject({ id: pastId })
    const doc = onDisk()
    expect(doc.workouts.some(w => w.id === pastId)).toBe(false)
    // api/sync-stamps.js stampUnstamped: an entry the stored copy had and this write lacks goes
    // on record under `deleted`, keyed by the workout's id, at the server's clock.
    expect(doc.deleted?.workouts?.[pastId]).toBeGreaterThan(0)
    expect(corrected?.id).toBe(firstId)
    expect(doc.workouts.find(w => w.id === firstId).entries[0].sets[0].w).toBe(65)   // the correction is untouched
    await rejects(call('get_workout', { workout_id: pastId }), 'ENOENT')
  })
})

/* ---------- 5. the rest of the profile ---------- */

describe('bodyweight, exercise notes and routines', () => {
  test('add_bodyweight files a weigh-in the api keeps', async () => {
    const r = await call('add_bodyweight', { weight: 80.4, date: '2026-07-02' })
    expect(r.ok).toBe(true)
    expect(r.entry).toMatchObject({ date: '2026-07-02', weight: 80.4 })
    const bw = onDisk().bodyweight
    expect(bw.find(b => b.d === '2026-07-02')).toMatchObject({ w: 80.4 })
    expect(bw.find(b => b.d === '2026-07-01')).toMatchObject({ w: 81.5 })   // the phone's entry is still there
  })

  test('set_exercise_note stores the standing note and last_performance reads the plate factor off it', async () => {
    const r = await call('set_exercise_note', { exercise: rowId, note: 'máquina 3, 1 placa = 5 kg' })
    expect(r.ok).toBe(true)
    expect(onDisk().exNotes[rowId]).toBe('máquina 3, 1 placa = 5 kg')
    const lp = await call('last_performance', { exercise: rowId, gym: 'iron' })
    expect(lp.exercise_note).toBe('máquina 3, 1 placa = 5 kg')
    expect(lp.plates_factor).toMatchObject({ per_plate: 5, unit: 'kg' })
    expect(lp.sessions_matching).toBe(2)
    expect(lp.sessions[0].gym).toBe('Iron')
    expect(lp.gyms_seen).toEqual(['Iron'])
    // …and a set given in plates is now stored with a weight.
    const w = await call('log_workout', { date: '2026-02-01', exercises: [{ exercise: rowId, sets: [{ plates: 8, r: 10 }] }] })
    expect(w.warnings).toEqual([])
    expect(w.exercises[0].sets[0].w).toBe(40)
  })

  test('edit_routine creates then changes a routine, and preview_session builds from it', async () => {
    const c = await call('edit_routine', {
      name: 'Treino Push', emoji: '💪',
      exercises: [{ exercise: benchId, sets: 4, reps: 8, weight: 60, rest_sec: 120 }, { exercise: rowId, sets: 3, reps_min: 8, reps_max: 12 }]
    })
    expect(c.action).toBe('created')
    expect(c.routine.exercises.map(e => e.id)).toEqual([benchId, rowId])
    const rid = c.routine.id
    const doc = onDisk()
    const stored = doc.routines.find(r => r.id === rid)
    expect(stored).toMatchObject({ name: 'Treino Push', emoji: '💪' })
    expect(stored.ex[0]).toMatchObject({ id: benchId, sets: 4, reps: 8, weight: 60, restSec: 120 })

    const u = await call('edit_routine', { routine: 'Treino Push', exercises: [{ exercise: rowId, sets: 3, reps: 10 }, { exercise: benchId, sets: 5, reps: 5, weight: 70 }] })
    expect(u.action).toBe('updated')
    expect(u.routine.exercises.map(e => e.id)).toEqual([rowId, benchId])
    expect(onDisk().routines.find(r => r.id === rid).ex.map(e => e.id)).toEqual([rowId, benchId])

    const p = await call('preview_session', { routine_id: rid })
    expect(p.routine_name).toBe('Treino Push')
    expect(p.exercises.map(e => e.id)).toEqual([rowId, benchId])
    expect(p.exercises[1].opening_sets.filter(s => s.phase === 'work')).toHaveLength(5)
    // The routine's own weight is a fallback: the bench has history at 65, so the policy or the
    // last session decides the opening weight — whichever, it is a number the user can be told.
    expect(p.exercises[1].opening_sets[0].w).toBeGreaterThan(0)
  })
})

/* ---------- 6. the live session ---------- */

describe('a live session finished through the api', () => {
  test('start_workout → log_set ×3 → finish_workout files the record and clears the session file', async () => {
    const sessionFile = path.join(tmp, 'active.json')
    const s = await call('start_workout', { routine: 'Treino Push', gym: 'Body Coach Penha' })
    expect(s.open).toBe(true)
    expect(fs.existsSync(sessionFile)).toBe(true)
    expect(s.exercises.map(e => e.id)).toEqual([rowId, benchId])

    const a = await call('log_set', { r: 10, w: 45 })                   // current exercise: the row
    expect(a.exercise.id).toBe(rowId)
    expect(a.set).toMatchObject({ done: true, w: 45, r: 10 })
    const b = await call('log_set', { plates: 10, r: 10 })              // plates → 50 kg via the note's factor
    expect(b.set.w).toBe(50)
    expect(b.warnings).toEqual([])
    const c = await call('log_set', { exercise: benchId, w: 70, r: 5, failure: true })
    expect(c.exercise.id).toBe(benchId)
    expect(c.set.failure).toBe(true)

    const active = await call('get_active_workout')
    expect(active.open).toBe(true)
    expect(active.done_sets).toBe(3)
    expect(fs.existsSync(stateFile)).toBe(true)
    expect(onDisk().workouts.some(w => w.gym === 'Body Coach Penha')).toBe(false)   // nothing pushed yet

    const before = onDisk()._rev
    const f = await call('finish_workout', { note: 'bom treino' })
    expect(f.ok).toBe(true)
    expect(f).toMatchObject({ gym: 'Body Coach Penha', note: 'Body Coach Penha · bom treino', sets_done: 3, session: 'closed', rev: before + 1 })
    expect(fs.existsSync(sessionFile)).toBe(false)
    const w = onDisk().workouts.find(x => x.id === f.workout_id)
    expect(w).toMatchObject({ gym: 'Body Coach Penha', routineId: onDisk().routines.find(r => r.name === 'Treino Push').id, name: 'Treino Push' })
    expect(w.entries.map(e => e.id)).toEqual([rowId, benchId])
    expect(w.entries[0].sets.filter(s => s.done).map(s => s.w)).toEqual([45, 50])
    // The planned third row set was never ticked: kept as planned-not-done, as the app does.
    expect(w.entries[0].sets).toHaveLength(3)
    expect(w.entries[0].sets[2].done).toBeFalsy()
    expect(w.entries[1].sets.filter(s => s.done)).toHaveLength(1)
    expect((await call('get_active_workout')).open).toBe(false)
    expect((await call('last_performance', { exercise: benchId, gym: 'Body Coach Penha' })).sessions[0].sets[0]).toMatchObject({ w: 70, r: 5, failure: true })
  })
})

/* ---------- 7. failures ---------- */

describe('failures leave the document alone', () => {
  test('an invalid date and an ambiguous exercise are refused before anything is read or written', async () => {
    const rev = onDisk()._rev
    // The zod schema refuses the date at the SDK boundary; the handler never sees it.
    const { z } = await import('zod')
    const { WRITE_TOOLS } = await import('../src/write-tools.js')
    const schema = z.object(WRITE_TOOLS.find(t => t.name === 'log_workout').schema).strict()
    expect(schema.safeParse({ date: '2026-02-30', exercises: [{ exercise: benchId, sets: [{ w: 1, r: 1 }] }] }).success).toBe(false)
    // "press" alone names dozens of exercises.
    const err = await rejects(call('log_workout', { exercises: [{ exercise: 'press', sets: [{ w: 20, r: 10 }] }] }), 'EAMBIG')
    expect(Array.isArray(err.candidates) && err.candidates.length > 1).toBe(true)
    await rejects(call('log_workout', { exercises: [{ exercise: benchId, sets: [{}] }] }), 'EINVAL')
    await rejects(call('update_workout', { workout_id: 'nope', note: 'x' }), 'ENOENT')
    expect(onDisk()._rev).toBe(rev)
  })

  test('a bad token is EAUTH on the first read; a token signed with another secret too', async () => {
    const bad = await loadMcp({ OPENGYM_URL: base, OPENGYM_TOKEN: 'not-a-token', OPENGYM_SESSION_FILE: path.join(tmp, 'active-bad.json') })
    await rejects(bad.state.ready(), 'EAUTH', /token refused/)
    const forged = await loadMcp({ OPENGYM_URL: base, OPENGYM_TOKEN: mint(UID, { secret: 'x'.repeat(64) }), OPENGYM_SESSION_FILE: path.join(tmp, 'active-bad.json') })
    await rejects(forged.call('add_bodyweight', { weight: 70 }), 'EAUTH')
    // An expired token is refused the same way — the message says what to do.
    const expired = await loadMcp({ OPENGYM_URL: base, OPENGYM_TOKEN: mint(UID, { expiry: Date.now() - 1000 }), OPENGYM_SESSION_FILE: path.join(tmp, 'active-bad.json') })
    await rejects(expired.call('log_workout', { exercises: [{ exercise: benchId, sets: [{ w: 1, r: 1 }] }] }), 'EAUTH', /pair again/)
  })

  test('a server that is gone is ENET, named by host, and the session draft survives it', async () => {
    const gone = await loadMcp({ OPENGYM_URL: base, OPENGYM_TOKEN: token, OPENGYM_SESSION_FILE: path.join(tmp, 'active-gone.json') })
    await gone.state.ready()
    const s = await gone.call('start_workout', { gym: 'Iron' })
    expect(s.open).toBe(true)
    await gone.call('log_set', { exercise: benchId, w: 50, r: 10 })
    srv.child.kill('SIGKILL')
    await new Promise(r => srv.child.once('exit', r))
    const err = await rejects(gone.call('finish_workout', {}), 'ENET', /cannot reach 127\.0\.0\.1/)
    expect(err.message).toMatch(/session is still open/)
    expect(fs.existsSync(path.join(tmp, 'active-gone.json'))).toBe(true)
    // The document on disk is exactly what the last successful write left.
    expect(onDisk().workouts.some(w => w.gym === 'Iron' && w.entries.some(e => e.id === benchId && e.sets[0].w === 50))).toBe(false)
  })

  // Token renewal is not exercised here: GET /api/me renews only once the token is past half of
  // SESSION_DAYS, which needs a token minted with an expiry inside that window — remote.test.js
  // covers the adoption and the token-file write against a stub server.
})
