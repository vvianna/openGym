// The write tools (mcp/src/write-tools.js) over the fake backend: result shapes, error codes and
// messages, the read-back coming from the pushed document, the 409 retry, the open-session guard,
// and the zod schemas accepting the documented examples and refusing the documented bad inputs.
import { describe, beforeAll, afterAll, beforeEach, afterEach, test, expect, vi } from 'vitest'
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _setBackendForTests, _seedStateForTests, refresh, getState, mutate } from '../src/state.js'
import { WRITE_TOOLS } from '../src/write-tools.js'
import { fakeBackend } from './fake-backend.mjs'

const FAKE_TODAY_ISO = '2026-07-27'
const BENCH = '0025'
const LEG_PRESS = '0739'
const byName = Object.fromEntries(WRITE_TOOLS.map(t => [t.name, t]))
const call = (name, params = {}) => byName[name].handler(params)
const parse = (name, params) => z.object(byName[name].schema).strict().safeParse(params)

let be, S, tmp
beforeAll(() => { vi.useFakeTimers({ now: new Date(FAKE_TODAY_ISO + 'T19:00:00'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wt-'))
  vi.stubEnv('OPENGYM_SESSION_FILE', path.join(tmp, 'active.json'))
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
  if (code !== undefined) expect(err.code).toBe(code)
  if (re) expect(err.message).toMatch(re)
  return err
}

describe('every write tool describes itself for the LLM', () => {
  test('descriptions name the error codes, prerequisites and the unit; every field has a description', () => {
    for (const t of WRITE_TOOLS) {
      expect(t.description.length).toBeGreaterThan(200)
      if (t.name !== 'search_exercises' && t.name !== 'last_performance') expect(t.description).toMatch(/EAMBIG/)
      for (const [k, field] of Object.entries(t.schema)) expect(field.description, `${t.name}.${k}`).toBeTruthy()
    }
    expect(byName.log_workout.description).toMatch(/search_exercises/)
    expect(byName.log_workout.description).toMatch(/profile unit/)
    expect(byName.delete_workout.description).toMatch(/ASK THE USER/)
    expect(byName.update_workout.description).toMatch(/REPLACES/)
  })
})

describe('search_exercises', () => {
  test('finds by Portuguese name, prefers what the profile trains, and returns ids to pass on', async () => {
    const r = await call('search_exercises', { query: 'supino' })
    expect(r.lang).toBe('pt-BR')
    expect(r.exercises[0]).toMatchObject({ id: BENCH, name_en: 'barbell bench press', name_localized: 'supino com barra', body_part: 'chest', is_custom: false })
    expect(r.exercises.length).toBeLessThanOrEqual(8)
  })
  test('an exact id, a body-part filter, a custom exercise, and no match', async () => {
    expect((await call('search_exercises', { query: LEG_PRESS })).exercises).toHaveLength(1)
    const legs = await call('search_exercises', { query: 'press', body_part: 'upper legs', limit: 3 })
    expect(legs.exercises.every(e => e.body_part === 'upper legs')).toBe(true)
    expect(legs.count).toBe(3)
    be.deviceWrites(s => { s.customEx = [{ id: 'cx-voador', n: 'Voador da Iron', bp: 'chest', eq: 'leverage machine' }] })
    await refresh(true)
    const c = await call('search_exercises', { query: 'voador da iron' })
    expect(c.exercises[0]).toMatchObject({ id: 'cx-voador', is_custom: true })
    expect((await call('search_exercises', { query: 'zzqqxx' })).count).toBe(0)
  })
})

describe('log_workout', () => {
  const session = () => ({ gym: 'Iron', routine: 'Push Day', note: 'ombro', exercises: [{ exercise: 'supino com barra', note: 'pegada aberta', note_pin: true, sets: [{ w: 60, r: 10 }, { w: 60, r: 8, rir: 1 }, { w: 60, r: 6, failure: true }] }] })

  test('saves, reads back from the pushed document, and the backend got a conditional unstamped write', async () => {
    const r = await call('log_workout', session())
    expect(r.ok).toBe(true)
    expect(r.workout_id).toBeTruthy()
    expect(r).toMatchObject({ date: FAKE_TODAY_ISO, name: 'Push Day', gym: 'Iron', note: 'Iron · ombro', unit: 'kg', volume: 60 * 24, sets_done: 3, duration: expect.any(String), rev: 4, warnings: [] })
    expect(r.exercises[0]).toMatchObject({ id: BENCH, name: 'barbell bench press', mode: 'reps', note: 'pegada aberta', note_pin: true })
    expect(r.exercises[0].sets.map(s => s.label)).toEqual(['60×10', '60×8 (RIR 1)', '60×6 F'])
    expect(r.exercises[0].sets[1].rir).toBe(1)
    // The backend holds it: same id, gym on the record, and the write was conditional on rev 3.
    const stored = be.doc.workouts.find(w => w.id === r.workout_id)
    expect(stored).toMatchObject({ gym: 'Iron', note: 'Iron · ombro', routineId: S.routines.find(x => x.name === 'Push Day').id })
    expect(be.writes).toHaveLength(1)
    expect(be.writes[0]).toMatchObject({ baseRev: 3, baseWid: 'wid3' })
    expect('active' in be.writes[0].state).toBe(false)
    // …and the cache now answers with the pushed document, so a read tool sees it at once.
    expect(getState().workouts.some(w => w.id === r.workout_id)).toBe(true)
    expect(getState()._rev).toBe(4)
  })

  test('a past date files into history; a PR is reported by name', async () => {
    const best = Math.max(...S.workouts.flatMap(w => w.entries.filter(e => e.id === BENCH).flatMap(e => e.sets.map(s => s.w || 0))))
    const r = await call('log_workout', { exercises: [{ exercise: BENCH, sets: [{ w: best + 5, r: 3 }] }] })
    expect(r.prs).toEqual(['barbell bench press'])
    const p = await call('log_workout', { date: '2026-06-01', exercises: [{ exercise: BENCH, sets: [{ w: 40, r: 10 }] }] })
    expect(p.date).toBe('2026-06-01')
    const ws = be.doc.workouts
    expect(ws.findIndex(w => w.id === p.workout_id)).toBeLessThan(ws.length - 1)
  })

  test('one 409 is retried on the document the conflict carried; two are ECONFLICT', async () => {
    be.conflictsLeft = 1
    be.deviceWrites(s => { s.bodyweight.push({ d: '2026-07-26', w: 70, t: 1 }) })   // the phone wrote
    const r = await call('log_workout', session())
    expect(r.ok).toBe(true)
    expect(be.writes).toHaveLength(1)
    expect(be.writes[0].baseRev).toBe(4)   // re-applied over the phone's revision
    expect(be.doc.bodyweight.some(b => b.w === 70)).toBe(true)   // the phone's write survived
    expect(be.doc.workouts.filter(w => w.gym === 'Iron')).toHaveLength(1)
    be.conflictsLeft = 2
    await rejects(call('log_workout', session()), 'ECONFLICT', /another device twice/)
  })

  test('EAUTH, ENET and EIO from the server come through with their code and no token', async () => {
    be.failNext = 'EAUTH'
    const e = await rejects(call('log_workout', session()), 'EAUTH', /pair again/)
    expect(e.message).not.toMatch(/Bearer/)
    be.failNext = 'ENET'
    await rejects(call('log_workout', session()), 'ENET', /cannot reach/)
    be.failNext = 'EIO'
    await rejects(call('log_workout', session()), 'EIO')
  })

  test('an ambiguous name is EAMBIG with candidates, an unknown one ENOENT, and nothing is written', async () => {
    const e = await rejects(call('log_workout', { exercises: [{ exercise: 'plank', sets: [{ sec: 30 }] }] }), 'EAMBIG', /matches \d+ exercises/)
    expect(e.candidates.length).toBeGreaterThan(1)
    expect(e.candidates[0]).toHaveProperty('id')
    await rejects(call('log_workout', { exercises: [{ exercise: 'zzqqxx', sets: [{ r: 5 }] }] }), 'ENOENT')
    await rejects(call('log_workout', { routine: 'nope', exercises: [{ exercise: BENCH, sets: [{ r: 5 }] }] }), 'ENOENT', /list_routines/)
    expect(be.writes).toHaveLength(0)
  })

  test('plates without a factor warn; with a factor (set_exercise_note) they become a weight', async () => {
    const r1 = await call('log_workout', { exercises: [{ exercise: LEG_PRESS, sets: [{ plates: 10, r: 12 }] }] })
    expect(r1.warnings).toHaveLength(1)
    expect(r1.warnings[0]).toMatch(/set_exercise_note/)
    expect(r1.exercises[0].sets[0].w).toBe(0)
    const n = await call('set_exercise_note', { exercise: 'leg press 45 graus no sled', note: 'Iron: 1 placa = 5 kg' })
    expect(n.plates_factor).toEqual({ per_plate: 5, unit: 'kg' })
    const r2 = await call('log_workout', { exercises: [{ exercise: LEG_PRESS, sets: [{ plates: 10, r: 12 }] }] })
    expect(r2.warnings).toEqual([])
    expect(r2.exercises[0].sets[0]).toMatchObject({ w: 50, r: 12, note: '10 placas' })
  })

  test('refuses while a live session file is open, naming it', async () => {
    fs.writeFileSync(path.join(tmp, 'active.json'), JSON.stringify({ started_at: '2026-07-27T18:00', name: 'Push', entries: [] }))
    await rejects(call('log_workout', session()), 'EINVAL', /live session .*finish_workout or discard_workout/)
  })

  test('schema: the documented example parses; bad dates, empty sets and a set with nothing are refused', () => {
    expect(parse('log_workout', session()).success).toBe(true)
    expect(parse('log_workout', { date: '2026-02-30', exercises: [{ exercise: BENCH, sets: [{ r: 5 }] }] }).success).toBe(false)
    expect(parse('log_workout', { exercises: [] }).success).toBe(false)
    expect(parse('log_workout', { exercises: [{ exercise: BENCH, sets: [] }] }).success).toBe(false)
    expect(parse('log_workout', { start: '25:00', exercises: [{ exercise: BENCH, sets: [{ r: 5 }] }] }).success).toBe(false)
    expect(parse('log_workout', { exercises: [{ exercise: BENCH, sets: [{ r: 5, bogus: 1 }] }] }).success).toBe(false)
    expect(parse('log_workout', { exercises: [{ exercise: BENCH, sets: [{ r: 5, rpe: 11 }] }] }).success).toBe(false)
  })
})

describe('update_workout / delete_workout', () => {
  test('corrects a set, keeps the gym, moves the date; nothing to change is EINVAL', async () => {
    const r = await call('log_workout', { gym: 'Iron', exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] })
    const u = await call('update_workout', { workout_id: r.workout_id, exercises: [{ exercise: BENCH, sets: [{ w: 65, r: 10 }] }], date: '2026-07-20' })
    expect(u.changed).toEqual(['exercises', 'date'])
    expect(u.gym).toBe('Iron')
    expect(u.date).toBe('2026-07-20')
    expect(u.exercises[0].sets[0].w).toBe(65)
    expect(be.doc.workouts.find(w => w.id === r.workout_id)).toMatchObject({ d: '2026-07-20', gym: 'Iron' })
    await rejects(call('update_workout', { workout_id: r.workout_id }), 'EINVAL', /nothing to change/)
    await rejects(call('update_workout', { workout_id: 'nope', note: 'x' }), 'ENOENT')
    expect(parse('update_workout', { workout_id: 'x', duration_min: 0 }).success).toBe(false)
  })
  test('delete needs confirm: true, removes the record from the backend', async () => {
    const r = await call('log_workout', { exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] })
    expect(parse('delete_workout', { workout_id: r.workout_id }).success).toBe(false)
    expect(parse('delete_workout', { workout_id: r.workout_id, confirm: false }).success).toBe(false)
    const d = await call('delete_workout', { workout_id: r.workout_id, confirm: true })
    expect(d.deleted).toMatchObject({ id: r.workout_id, date: FAKE_TODAY_ISO })
    expect(be.doc.workouts.some(w => w.id === r.workout_id)).toBe(false)
    await rejects(call('delete_workout', { workout_id: r.workout_id, confirm: true }), 'ENOENT')
  })
})

describe('last_performance', () => {
  test('answers for a Portuguese name, filters by gym case-insensitively, lists gyms seen', async () => {
    await call('log_workout', { gym: 'Iron', start: '18:50', exercises: [{ exercise: BENCH, sets: [{ w: 62.5, r: 8 }] }] })
    await call('log_workout', { gym: 'Smart Fit', date: '2026-07-26', exercises: [{ exercise: BENCH, sets: [{ w: 55, r: 8 }] }] })
    const all = await call('last_performance', { exercise: 'supino com barra', limit: 3 })
    expect(all.exercise.id).toBe(BENCH)
    expect(all.unit).toBe('kg')
    expect(all.sessions).toHaveLength(3)
    expect(all.sessions[0]).toMatchObject({ date: FAKE_TODAY_ISO, gym: 'Iron' })
    expect(all.sessions[0].sets[0]).toMatchObject({ w: 62.5, r: 8, label: '62.5×8' })
    expect(all.best_weight.w).toBeGreaterThanOrEqual(62.5)
    expect(all.best_e1rm).toMatchObject({ est: expect.any(Number), w: expect.any(Number), r: expect.any(Number) })
    expect(all.gyms_seen.sort()).toEqual(['Iron', 'Smart Fit'])
    const iron = await call('last_performance', { exercise: BENCH, gym: 'iron' })
    expect(iron.sessions_matching).toBe(1)
    expect(iron.sessions[0].gym).toBe('Iron')
    expect(iron.sessions_total).toBe(all.sessions_total)
    const none = await call('last_performance', { exercise: BENCH, gym: 'Body Coach' })
    expect(none.sessions).toEqual([])
  })
  test('shows the standing note, its plates factor and the pinned session note', async () => {
    await call('set_exercise_note', { exercise: BENCH, note: 'banco 3 · 1 placa = 2.5 kg' })
    await call('log_workout', { exercises: [{ exercise: BENCH, note: 'pegada fechada', note_pin: true, sets: [{ w: 50, r: 8 }] }] })
    const r = await call('last_performance', { exercise: BENCH })
    expect(r.exercise_note).toBe('banco 3 · 1 placa = 2.5 kg')
    expect(r.plates_factor).toEqual({ per_plate: 2.5, unit: 'kg' })
    expect(r.pinned_note).toEqual({ note: 'pegada fechada', date: FAKE_TODAY_ISO })
  })
})

describe('add_bodyweight / set_exercise_note / edit_routine', () => {
  test('add_bodyweight reports the delta and the goal distance', async () => {
    const r = await call('add_bodyweight', { weight: 79.2 })
    expect(r).toMatchObject({ ok: true, unit: 'kg', entry: { date: FAKE_TODAY_ISO, weight: 79.2 }, goal: 77, delta_vs_goal: 2.2 })
    expect(r.previous).toBeTruthy()
    expect(be.doc.bodyweight.find(b => b.d === FAKE_TODAY_ISO).w).toBe(79.2)
    expect(parse('add_bodyweight', { weight: -1 }).success).toBe(false)
  })
  test('set_exercise_note clears with ""', async () => {
    await call('set_exercise_note', { exercise: BENCH, note: 'pino 7' })
    expect(be.doc.exNotes[BENCH]).toBe('pino 7')
    const c = await call('set_exercise_note', { exercise: BENCH, note: '' })
    expect(c.note).toBeNull()
    expect(be.doc.exNotes[BENCH]).toBeUndefined()
  })
  test('edit_routine creates, updates by name, and deletes with confirm', async () => {
    const c = await call('edit_routine', { name: 'Glúteos', exercises: [{ exercise: LEG_PRESS, sets: 4, reps: 12, reps_min: 8 }, { exercise: BENCH, sets: 3, reps: 10, rest_sec: 90 }] })
    expect(c.action).toBe('created')
    expect(c.routine.name).toBe('Glúteos')
    expect(c.routine.exercises.map(e => e.summary)).toEqual(['4 × 8–12', '3 × 10'])
    expect(c.routine.exercises[1].rest_sec).toBe(90)
    const u = await call('edit_routine', { routine: 'glúteos', exercises: [{ exercise: BENCH, sets: 5, reps: 5 }] })
    expect(u.action).toBe('updated')
    expect(u.routine.exercises).toHaveLength(1)
    expect(u.routine.exercises[0]).toMatchObject({ id: BENCH, sets: 5, reps: 5 })
    await rejects(call('edit_routine', { routine: 'Glúteos', remove: true }), 'EINVAL', /confirm/)
    const d = await call('edit_routine', { routine: 'Glúteos', remove: true, confirm: true })
    expect(d.action).toBe('deleted')
    expect(be.doc.routines.some(r => r.name === 'Glúteos')).toBe(false)
    await rejects(call('edit_routine', { routine: 'Day', name: 'x' }), 'EAMBIG', /routines/)
    await rejects(call('edit_routine', { exercises: [{ exercise: BENCH }] }), 'EINVAL', /name/)
  })
})

describe('after the review: retries, fresh profiles, the cache, the fallback search', () => {
  test('a 409 retry does not double the warnings', async () => {
    be.conflictsLeft = 1
    const r = await call('log_workout', { exercises: [{ exercise: LEG_PRESS, sets: [{ plates: 10, r: 12 }] }] })
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(1)
  })

  test('a profile with no document yet: the first write creates it with the defaults and says so', async () => {
    be = fakeBackend(null, { user: { id: 'u-new', name: 'Nova' } })
    _setBackendForTests(be, { id: 'u-new', name: 'Nova' })
    await refresh(true)
    expect(getState()).toBeNull()
    const r = await call('log_workout', { gym: 'Iron', exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] })
    expect(r.ok).toBe(true)
    expect(r.warnings.some(w => /no synced document/.test(w))).toBe(true)
    expect(be.doc).toMatchObject({ unit: 'kg', _rev: 1 })
    expect(be.doc.workouts).toHaveLength(1)
    expect(be.doc.workouts[0]).toMatchObject({ gym: 'Iron' })
    // The next write finds a document and says nothing of the kind.
    const b = await call('add_bodyweight', { weight: 80 })
    expect(b.warnings).toEqual([])
    expect(be.doc.bodyweight).toHaveLength(1)
    // What needs history to correct still says there is none to correct.
    be = fakeBackend(null, { user: { id: 'u-new2', name: 'Nova' } })
    _setBackendForTests(be, { id: 'u-new2', name: 'Nova' })
    await refresh(true)
    await rejects(call('update_workout', { workout_id: 'x', note: 'y' }), 'ENOENT', /no state/)
    const n = await call('set_exercise_note', { exercise: BENCH, note: '1 placa = 5 kg' })
    expect(n.warnings.some(w => /no synced document/.test(w))).toBe(true)
    expect(be.doc.exNotes[BENCH]).toBe('1 placa = 5 kg')
  })

  test('the cache is re-read on the next call after a write, not trusted past the write that made it', async () => {
    const r = await call('log_workout', { exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] })
    expect(getState().workouts.some(w => w.id === r.workout_id)).toBe(true)   // this call's read-back
    const reads = be.reads
    await refresh()                                                              // what index.js does next
    expect(be.reads).toBe(reads + 1)
  })

  test('search_exercises on an English profile still finds a Portuguese name, through every language', async () => {
    be.deviceWrites(s => { s.lang = 'en' })
    await refresh(true)
    const r = await call('search_exercises', { query: 'supino com barra' })
    expect(r.lang).toBe('en')
    expect(r.matched_other_language).toBe(true)
    expect(r.exercises[0]).toMatchObject({ id: BENCH, name_localized: null, name_matched: 'supino com barra' })
    const w = await call('log_workout', { exercises: [{ exercise: 'supino com barra', sets: [{ w: 60, r: 10 }] }] })
    expect(w.exercises[0].id).toBe(BENCH)
  })

  test('"constructor" is not an exercise anywhere a name is taken', async () => {
    expect((await call('search_exercises', { query: 'constructor' })).exercises.every(e => typeof e.id === 'string' && e.name_en)).toBe(true)
    // Whatever a fuzzy pass makes of these, what is written has a catalogue id — never Object's own.
    for (const q of ['constructor', '__proto__', 'hasOwnProperty']) {
      let r = null, e = null
      try { r = await call('log_workout', { exercises: [{ exercise: q, sets: [{ w: 1, r: 1 }] }] }) } catch (x) { e = x }
      if (e) expect(['ENOENT', 'EAMBIG']).toContain(e.code)
      else { expect(typeof r.exercises[0].id).toBe('string'); expect(r.exercises[0].name).toBeTruthy() }
    }
    for (const w of be.doc.workouts) for (const en of w.entries) expect(typeof en.id).toBe('string')
    expect(Object.keys(be.doc.exNotes || {}).every(k => typeof k === 'string' && k !== 'undefined')).toBe(true)
  })

  test('edit_routine: confirm must be literally true; a start with no duration runs until now', async () => {
    expect(parse('edit_routine', { routine: 'Push Day', remove: true, confirm: false }).success).toBe(false)
    expect(parse('edit_routine', { routine: 'Push Day', remove: true, confirm: true }).success).toBe(true)
    const r = await call('log_workout', { start: '18:40', exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] })
    expect(r.duration).toBe('20 min')
    await rejects(call('log_workout', { start: '19:30', exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] }), 'EINVAL', /later than now/)
    await rejects(call('log_workout', { start: '18:40', duration_min: 60, exercises: [{ exercise: BENCH, sets: [{ w: 60, r: 10 }] }] }), 'EINVAL', /end in the future/)
  })
})

describe('file mode', () => {
  test('every write tool is EPERM and names the fix; the read-only ones still answer', async () => {
    _seedStateForTests(S)
    for (const name of ['log_workout', 'update_workout', 'delete_workout', 'add_bodyweight', 'set_exercise_note', 'edit_routine']) {
      await rejects(call(name, { workout_id: 'x', confirm: true, weight: 1, exercise: BENCH, note: 'n', name: 'r', exercises: [{ exercise: BENCH, sets: [{ r: 5 }] }] }), 'EPERM', /OPENGYM_URL and OPENGYM_TOKEN/)
    }
    await rejects(mutate(() => {}), 'EPERM')
    expect((await call('search_exercises', { query: BENCH })).count).toBe(1)
    expect((await call('last_performance', { exercise: BENCH })).sessions.length).toBeGreaterThan(0)
  })
})

describe('mutate', () => {
  test('serialises concurrent writes so both land, each on the other\'s revision', async () => {
    const a = call('add_bodyweight', { weight: 70, date: '2026-07-01' })
    const b = call('add_bodyweight', { weight: 71, date: '2026-07-02' })
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.rev, rb.rev]).toEqual([4, 5])
    expect(be.doc.bodyweight.filter(x => x.d === '2026-07-01' || x.d === '2026-07-02')).toHaveLength(2)
  })
  test('a profile with no document yet starts from the defaults at rev 0', async () => {
    be = fakeBackend(null, { rev: 0 })
    _setBackendForTests(be)
    await refresh(true)
    expect(getState()).toBeNull()
    const r = await call('add_bodyweight', { weight: 80 })
    expect(r.rev).toBe(1)
    expect(be.writes[0].baseRev).toBe(0)
    expect(be.doc.unit).toBe('kg')
    expect(be.doc.routines).toEqual([])
  })
})
