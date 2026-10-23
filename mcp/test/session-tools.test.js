// The session tools (mcp/src/session-tools.js) over the fake backend: the live, set-by-set flow
// from start_workout to finish_workout with the record read back, corrections in between, the
// draft surviving a restart of the server, the modes (a draft in file mode, a finish that needs
// remote mode and keeps the draft), and the documented failure cases.
import { describe, beforeAll, afterAll, beforeEach, afterEach, test, expect, vi } from 'vitest'
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _setBackendForTests, _seedStateForTests, refresh, getState } from '../src/state.js'
import { SESSION_TOOLS } from '../src/session-tools.js'
import { WRITE_TOOLS } from '../src/write-tools.js'
import { loadSession } from '../src/session.js'
import { fakeBackend } from './fake-backend.mjs'

const FAKE_TODAY_ISO = '2026-07-27'                 // Monday — Push Day is scheduled
const BENCH = '0025'
const SQUAT = '0043'                                // barbell full squat
const PLANK = '0463'                                // front plank
const byName = Object.fromEntries([...SESSION_TOOLS, ...WRITE_TOOLS].map(t => [t.name, t]))
const call = (name, params = {}) => byName[name].handler(params)
const parse = (name, params) => z.object(byName[name].schema).strict().safeParse(params)
const file = () => path.join(tmp, 'active.json')

let be, S, tmp
beforeAll(() => { vi.useFakeTimers({ now: new Date(FAKE_TODAY_ISO + 'T19:00:00'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-st-'))
  vi.stubEnv('OPENGYM_SESSION_FILE', file())
  S = buildDemoState(); S.unit = 'kg'; S.lang = 'pt-BR'
  be = fakeBackend(S, { user: { id: 'u-test', name: 'Victor' } })
  _setBackendForTests(be, { id: 'u-test', name: 'Victor' })
  await refresh(true)
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }) })

const rejects = async (p, code, re) => {
  let err = null
  try { await p } catch (e) { err = e }
  expect(err, 'expected a thrown error').toBeTruthy()
  expect(err.code).toBe(code)
  if (re) expect(err.message).toMatch(re)
  return err
}

describe('every session tool describes itself for the LLM', () => {
  test('descriptions say when to use it, name the error codes; every field has a description', () => {
    for (const t of SESSION_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(150)
      if (t.name !== 'get_active_workout') expect(t.description, t.name).toMatch(/ENOENT|EINVAL/)
      for (const [k, field] of Object.entries(t.schema)) expect(field.description, `${t.name}.${k}`).toBeTruthy()
    }
    expect(byName.start_workout.description).toMatch(/log_workout/)
    expect(byName.log_set.description).toMatch(/get_active_workout/)
    expect(byName.finish_workout.description).toMatch(/KEPT|kept/)
    expect(byName.discard_workout.description).toMatch(/ASK THE USER/)
  })
})

describe('the live flow', () => {
  test('start from a routine opens with the app\'s own prescription, then set by set to a saved record', async () => {
    const o = await call('start_workout', { routine: 'Push Day', gym: 'Iron' })
    expect(o.open).toBe(true)
    expect(o.gym).toBe('Iron')
    expect(o.name).toBe('Push Day')
    expect(o.exercises.length).toBeGreaterThan(2)
    expect(o.current.index).toBe(1)
    expect(o.current.next_set.index).toBe(1)
    expect(o.done_sets).toBe(0)
    // The opening rows are what preview_session reports for the same routine.
    const bench = o.exercises.find(e => e.id === BENCH)
    expect(bench).toBeTruthy()
    const { previewSession } = await import('../src/tools.js')
    const pv = previewSession.handler({ routine_id: S.routines[0].id })
    const pvBench = pv.exercises.find(e => e.id === BENCH)
    expect(bench.sets.map(s => [s.w, s.r])).toEqual(pvBench.opening_sets.map(s => [s.w, s.r]))
    expect(fs.existsSync(file())).toBe(true)

    // "fiz 12" ticks the planned row at the planned weight; a weight given replaces it.
    const first = o.exercises[0]
    const planned = first.next_set
    const l1 = await call('log_set', { r: 12 })
    expect(l1.exercise.index).toBe(1)
    expect(l1.set_index).toBe(planned.index)
    expect(l1.set).toMatchObject({ done: true, r: 12, w: planned.w })
    expect(l1.remaining_sets).toBe(first.planned_sets - 1)
    const l2 = await call('log_set', { r: 12, w: planned.w + 5, rir: 2 })
    expect(l2.set).toMatchObject({ w: planned.w + 5, r: 12, rir: 2 })
    expect(l2.set_index).toBe(planned.index + 1)

    // Correct the first one, drop the third planned row, and the view agrees.
    const e1 = await call('edit_set', { set_index: planned.index, r: 10 })
    expect(e1.set).toMatchObject({ r: 10, w: planned.w })
    expect(e1.logged).toBe(true)
    const d = await call('delete_set', { set_index: first.planned_sets })
    expect(d.removed.index).toBe(first.planned_sets)
    const v = await call('get_active_workout')
    expect(v.exercises[0].planned_sets).toBe(first.planned_sets - 1)
    expect(v.exercises[0].sets[0]).toMatchObject({ r: 10, done: true })
    expect(v.done_sets).toBe(2)

    // Logging the rest of that exercise moves the pointer to the next one.
    let last
    for (let i = 0; i < first.planned_sets - 3; i++) last = await call('log_set', { r: 8 })
    expect(last.exercise_complete).toBe(true)
    expect(last.next_exercise.index).toBe(2)
    const v2 = await call('get_active_workout')
    expect(v2.current.index).toBe(2)

    // A set on a named exercise elsewhere in the session, and one on an exercise not in it.
    const second = v2.exercises[1]
    const l3 = await call('log_set', { exercise: second.id, r: 10 })
    expect(l3.exercise.index).toBe(2)
    const l4 = await call('log_set', { exercise: SQUAT, w: 80, r: 5 })
    expect(l4.exercise.index).toBe(v2.exercises.length + 1)
    expect(l4.set).toMatchObject({ w: 80, r: 5 })

    const before = (getState().workouts || []).length
    const f = await call('finish_workout', { note: 'ombro ok' })
    expect(f.ok).toBe(true)
    expect(f.session).toBe('closed')
    expect(f.gym).toBe('Iron')
    expect(f.note).toBe('Iron · ombro ok')
    expect(f.name).toBe('Push Day')
    expect(f.date).toBe(FAKE_TODAY_ISO)
    expect(f.sets_done).toBe(2 + (first.planned_sets - 3) + 2)
    expect(f.exercises.map(e => e.id)).toContain(SQUAT)      // the squat added mid-session
    expect(f.exercises[0].sets[0]).toMatchObject({ r: 10, w: planned.w, done: true })
    expect(f.rev).toBe(be.doc._rev)
    // Stored: the pushed document holds it with the gym on the record, and the draft is gone.
    const stored = be.doc.workouts.find(w => w.id === f.workout_id)
    expect(stored).toBeTruthy()
    expect(stored.gym).toBe('Iron')
    expect(stored.routineId).toBe(S.routines[0].id)
    expect(be.doc.workouts.length).toBe(before + 1)
    expect(be.writes.at(-1).baseRev).toBe(3)
    expect(fs.existsSync(file())).toBe(false)
    expect(await call('get_active_workout')).toMatchObject({ open: false })
    // And the read tools see it.
    const { getWorkout } = await import('../src/tools.js')
    expect(getWorkout.handler({ workout_id: f.workout_id }).entries[0].sets[0]).toMatchObject({ r: 10, done: true })
  })

  test('freestyle: no routine, exercises named as they come, a past date files as a past workout', async () => {
    const o = await call('start_workout', { date: '2026-07-20', start: '07:30', gym: 'Smart Fit' })
    expect(o.exercises).toEqual([])
    expect(o.current).toBeNull()
    await rejects(call('log_set', { r: 10 }), 'EINVAL', /name the exercise/)
    const l = await call('log_set', { exercise: BENCH, w: 50, r: 10 })
    expect(l.exercise).toMatchObject({ index: 1, id: BENCH })
    await call('log_set', { w: 50, r: 10 })
    const f = await call('finish_workout', { duration_min: 40 })
    expect(f.date).toBe('2026-07-20')
    expect(f.name).toBe('Workout')
    expect(f.duration).toBe('40 min')
    expect(f.gym).toBe('Smart Fit')
    const stored = be.doc.workouts.find(w => w.id === f.workout_id)
    expect(new Date(stored.start).getHours()).toBe(7)
    expect(stored._ts, 'a past workout is stamped like the app stamps one').toBeTruthy()
    // Filed in date order, not appended.
    const dates = be.doc.workouts.map(w => w.d)
    expect(dates).toEqual([...dates].sort())
  })

  test('the draft survives a restart: a fresh module load reads the same session', async () => {
    await call('start_workout', { routine: 'Push Day' })
    await call('log_set', { r: 9 })
    const again = await import('../src/session-tools.js?reload=' + Date.now())
    const tool = again.SESSION_TOOLS.find(t => t.name === 'get_active_workout')
    const v = await tool.handler({})
    expect(v.open).toBe(true)
    expect(v.done_sets).toBe(1)
    expect(loadSession('u-test').entries[0].sets[0].done).toBe(true)
  })
})

describe('editing the exercise list', () => {
  test('skip, replace, move, add', async () => {
    const o = await call('start_workout', { routine: 'Push Day' })
    const ids = o.exercises.map(e => e.id)
    // skip the second, untouched exercise
    const s1 = await call('edit_active_workout', { action: 'skip', exercise: ids[1] })
    expect(s1.exercises.map(e => e.id)).toEqual([ids[0], ...ids.slice(2)])
    expect(s1.changed).toMatch(/skipped/)
    // an exercise with a logged set cannot be skipped
    await call('log_set', { r: 10 })
    await rejects(call('edit_active_workout', { action: 'skip', exercise: ids[0] }), 'EINVAL', /logged set/)
    // replace keeps the logged sets and inserts the replacement after
    const r1 = await call('edit_active_workout', { action: 'replace', exercise: ids[0], with: SQUAT })
    expect(r1.exercises[0].id).toBe(ids[0])
    expect(r1.exercises[1].id).toBe(SQUAT)
    expect(r1.changed).toMatch(/inserted after/)
    // an untouched exercise is replaced in place
    const r2 = await call('edit_active_workout', { action: 'replace', exercise: ids[2], with: BENCH })
    expect(r2.exercises.filter(e => e.id === BENCH).length).toBe(2)
    // move the last one up
    const lastId = r2.exercises.at(-1).id
    const m = await call('edit_active_workout', { action: 'move', exercise: lastId, direction: 'up' })
    expect(m.exercises.at(-2).id).toBe(lastId)
    await rejects(call('edit_active_workout', { action: 'move', exercise: r2.exercises[0].id, direction: 'up' }), 'EINVAL', /cannot move up/)
    // add with a plan of its own
    const a = await call('edit_active_workout', { action: 'add', exercise: PLANK, sets: 2, sec: 45 })
    const added = a.exercises.at(-1)
    expect(added.mode).toBe('time')
    expect(added.planned_sets).toBe(2)
    expect(added.next_set.sec).toBe(45)
    await rejects(call('edit_active_workout', { action: 'replace', exercise: lastId }), 'EINVAL', /needs `with`/)
    await rejects(call('edit_active_workout', { action: 'move', exercise: lastId }), 'EINVAL', /needs `direction`/)
    await rejects(call('edit_active_workout', { action: 'skip', exercise: 'remada curvada com barra' }), 'ENOENT', /not in the open session/)
  })
})

describe('failure cases', () => {
  test('no open session: log_set, edit_set, delete_set, finish and discard say to start one', async () => {
    for (const [name, args] of [['log_set', { r: 5 }], ['edit_set', { set_index: 1, r: 5 }], ['delete_set', { set_index: 1 }], ['finish_workout', {}], ['discard_workout', { confirm: true }]]) {
      await rejects(call(name, args), 'ENOENT', /start_workout/)
    }
    expect(await call('get_active_workout')).toMatchObject({ open: false })
  })

  test('a second start is refused and names the open one; discard closes it', async () => {
    await call('start_workout', { routine: 'Push Day', gym: 'Iron' })
    const e = await rejects(call('start_workout', { routine: 'Pull Day' }), 'EINVAL', /already open/)
    expect(e.session.gym).toBe('Iron')
    await rejects(call('log_workout', { exercises: [{ exercise: BENCH, sets: [{ r: 5 }] }] }), 'EINVAL', /live session/)
    const d = await call('discard_workout', { confirm: true })
    expect(d.discarded).toMatchObject({ gym: 'Iron', done_sets: 0 })
    expect(fs.existsSync(file())).toBe(false)
  })

  test('finish with nothing logged is EINVAL; a set with no work, both w and plates, rir and rpe are EINVAL', async () => {
    await call('start_workout', { routine: 'Push Day' })
    await rejects(call('finish_workout', {}), 'EINVAL', /discard_workout/)
    await rejects(call('log_set', { w: 60, plates: 5, r: 5 }), 'EINVAL', /not both/)
    await rejects(call('log_set', { r: 5, rir: 1, rpe: 9 }), 'EINVAL', /not both/)
    await rejects(call('log_set', { exercise: PLANK, r: 0, sec: 0 }), 'EINVAL', /above zero/)
    await rejects(call('log_set', { exercise: 'prancha', sec: 30 }), 'EAMBIG', /matches/)
    await rejects(call('edit_set', { set_index: 99, r: 5 }), 'ENOENT', /no set 99/)
    await rejects(call('edit_set', { set_index: 1 }), 'EINVAL', /nothing to change/)
    await rejects(call('delete_set', { set_index: 99 }), 'ENOENT', /no set 99/)
    expect(loadSession('u-test').entries[0].sets.every(s => !s.done)).toBe(true)
  })

  test('plates without a factor are kept in the note, with a warning and no weight; with the factor they become kg', async () => {
    await call('start_workout', { routine: 'Push Day' })
    const l = await call('log_set', { plates: 8, r: 12 })
    expect(l.warnings[0]).toMatch(/set_exercise_note/)
    expect(l.set.w).toBe(0)
    expect(l.set.note).toMatch(/8 placas/)
    be.deviceWrites(s => { s.exNotes = { [BENCH]: 'banco 3, 1 placa = 5 kg' } })
    await refresh(true)
    const l2 = await call('log_set', { exercise: BENCH, plates: 8, r: 12 })
    expect(l2.warnings).toEqual([])
    expect(l2.set.w).toBe(40)
  })

  test('finish keeps the draft when the push fails, and succeeds on retry', async () => {
    await call('start_workout', { routine: 'Push Day' })
    await call('log_set', { r: 10 })
    be.failNext = 'ENET'
    await rejects(call('finish_workout', {}), 'ENET', /still open/)
    expect(fs.existsSync(file())).toBe(true)
    be.conflictsLeft = 1
    const f = await call('finish_workout', {})
    expect(f.ok).toBe(true)
    expect(fs.existsSync(file())).toBe(false)
  })

  test('file mode: a session can be run, but finishing is EPERM and the draft stays', async () => {
    _seedStateForTests(S)
    const o = await call('start_workout', { routine: 'Push Day', gym: 'Iron' })
    expect(o.open).toBe(true)
    await call('log_set', { r: 10 })
    await rejects(call('finish_workout', {}), 'EPERM', /OPENGYM_URL/)
    expect(fs.existsSync(file())).toBe(true)
    expect((await call('get_active_workout')).done_sets).toBe(1)
  })

  test('a finish retried after its push landed answers the saved record once, and closes the session', async () => {
    await call('start_workout', { routine: 'Push Day', gym: 'Iron' })
    await call('log_set', { r: 10 })
    const draftText = fs.readFileSync(file(), 'utf8')          // what a crash between PUT and unlink leaves behind
    const f1 = await call('finish_workout', {})
    expect(f1.ok).toBe(true)
    const writes = be.writes.length
    fs.writeFileSync(file(), draftText)
    const f2 = await call('finish_workout', {})
    expect(f2).toMatchObject({ ok: true, workout_id: f1.workout_id, already_saved: true, session: 'closed' })
    expect(f2.warnings.some(w => /already been saved/.test(w))).toBe(true)
    expect(be.writes).toHaveLength(writes)                       // nothing pushed a second time
    expect(be.doc.workouts.filter(w => w.id === f1.workout_id)).toHaveLength(1)
    expect(fs.existsSync(file())).toBe(false)
  })

  test('a planned per-side set is logged on both limbs; an odd rep count is refused', async () => {
    be.deviceWrites(s => { s.routines.find(r => r.name === 'Push Day').ex[0].side = true })
    await refresh(true)
    const o = await call('start_workout', { routine: 'Push Day' })
    const raw0 = loadSession('u-test').entries[0].sets[0]
    expect(raw0.sides && raw0.sides.L && raw0.sides.R, 'the builder made a per-side row').toBeTruthy()
    await rejects(call('log_set', { r: 7 }), 'EINVAL', /even rep count/)
    const l = await call('log_set', { r: 16, w: 20, rir: 2 })
    expect(l.set).toMatchObject({ done: true, r: 16, w: 20, rir: 2 })
    const raw = loadSession('u-test').entries[0].sets[0]
    expect(raw.sides.L).toMatchObject({ w: 20, r: 8, done: true, rir: 2 })
    expect(raw.sides.R).toMatchObject({ w: 20, r: 8, done: true, rir: 2 })
    expect(raw).toMatchObject({ done: true, r: 16, w: 20 })
    expect(o.exercises[0].id).toBe(loadSession('u-test').entries[0].id)
  })

  test('a planned drop-set keeps its drops when ticked as planned, and is a plain set (with a warning) when numbers are given', async () => {
    await call('start_workout', { routine: 'Push Day' })
    const s0 = loadSession('u-test')
    for (const row of s0.entries[0].sets) { row.type = 'dropset'; row.drops = [{ w: 30, r: 5 }] }
    fs.writeFileSync(file(), JSON.stringify(s0))
    const kept = await call('log_set', {})
    expect(kept.warnings).toEqual([])
    const r1 = loadSession('u-test').entries[0].sets[0]
    expect(r1).toMatchObject({ done: true, type: 'dropset', drops: [{ w: 30, r: 5 }] })
    const plain = await call('log_set', { w: 50, r: 8 })
    expect(plain.warnings.some(w => /dropset/.test(w))).toBe(true)
    const r2 = loadSession('u-test').entries[0].sets[1]
    expect(r2).toMatchObject({ done: true, w: 50, r: 8 })
    expect(r2.drops).toBeUndefined()
    expect(r2.type).toBeUndefined()
  })

  test('remote mode with no profile yet resolved: the session tools surface the server\'s error, and file nothing under no id', async () => {
    _setBackendForTests(be, { id: null, name: 'Profile' })
    be.failNext = 'EAUTH'
    await rejects(call('start_workout', {}), 'EAUTH')
    expect(fs.existsSync(file())).toBe(false)
    // Once the server answers, the same call files the draft under the real id.
    const o = await call('start_workout', {})
    expect(o.open).toBe(true)
    expect(fs.existsSync(file())).toBe(true)
  })

  test('a profile with no document yet can run a session; finishing creates the document and says so', async () => {
    be = fakeBackend(null, { user: { id: 'u-new', name: 'Nova' } })
    _setBackendForTests(be, { id: 'u-new', name: 'Nova' })
    await refresh(true)
    await call('start_workout', { gym: 'Iron' })
    await call('log_set', { exercise: BENCH, w: 40, r: 10 })
    const f = await call('finish_workout', {})
    expect(f.ok).toBe(true)
    expect(f.warnings.some(w => /no synced document/.test(w))).toBe(true)
    expect(be.doc.workouts).toHaveLength(1)
    expect(be.doc.workouts[0]).toMatchObject({ gym: 'Iron' })
    expect(fs.existsSync(file())).toBe(false)
  })

  test('schema: the documented examples parse; a bad set index, direction or action is refused', () => {
    expect(parse('start_workout', { routine: 'Push Day', gym: 'Iron', date: '2026-07-20', start: '18:30' }).success).toBe(true)
    expect(parse('start_workout', { date: '2026-02-30' }).success).toBe(false)
    expect(parse('log_set', { exercise: BENCH, w: 60, r: 10, rir: 2, note: 'pegada aberta' }).success).toBe(true)
    expect(parse('log_set', { r: 10, bogus: true }).success).toBe(false)
    expect(parse('edit_set', { set_index: 0, r: 5 }).success).toBe(false)
    expect(parse('edit_active_workout', { action: 'move', exercise: BENCH, direction: 'left' }).success).toBe(false)
    expect(parse('edit_active_workout', { action: 'drop', exercise: BENCH }).success).toBe(false)
    expect(parse('discard_workout', { confirm: false }).success).toBe(false)
    expect(parse('finish_workout', { duration_min: 0 }).success).toBe(false)
  })
})
