// The pure writes (mcp/src/mutations.js), seeded from the demo profile with "today" pinned the way
// tools.test.js pins it. No network, no file: a mutation is `(S, args, ctx) => result` and the
// assertions are about what the document holds afterwards — the CONTRIBUTING rule for anything
// that files a session or decides a PR.
import { describe, beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { EXIDX } from '../../frontend/src/lib/exercises.js'
import { workoutVolume } from '../../frontend/src/lib/history.js'
import {
  draftOf, logWorkout, updateWorkout, deleteWorkout, addBodyweight, setExerciseNote, editRoutine,
  platesFactorOf, noteWithGym, noteWithoutGym, findWorkout
} from '../src/mutations.js'

const FAKE_TODAY_ISO = '2026-07-27'
const NOW = new Date(FAKE_TODAY_ISO + 'T19:00:00').getTime()
const BENCH = '0025'          // barbell bench press — in the demo's Push Day
const LEG_PRESS = '0739'      // sled 45° leg press — Leg Day
const PLANK = '3930'          // plank jack — never trained in the demo
const ex = id => EXIDX[id]
const ctx = () => ({ now: NOW, todayIso: FAKE_TODAY_ISO, unit: 'kg' })

let S
beforeAll(() => { vi.useFakeTimers({ now: new Date(FAKE_TODAY_ISO + 'T19:00:00'), toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })
beforeEach(() => { S = buildDemoState(); S.unit = 'kg' })

const bestBench = () => Math.max(...S.workouts.flatMap(w => w.entries.filter(e => e.id === BENCH).flatMap(e => e.sets.map(s => s.w || 0))))
const pushDay = () => S.routines.find(r => r.name === 'Push Day')
const log = (args) => {
  const draft = draftOf(S, { ...args, exercises: args.exercises.map(x => ({ ...x, ex: ex(x.id) })) }, ctx(), args.warnings || [])
  return logWorkout(S, draft, ctx())
}

describe('platesFactorOf / gym note helpers', () => {
  test('reads "1 placa = 5 kg", "plate = 10lb", a decimal with a comma, and nothing else', () => {
    expect(platesFactorOf('voador na Iron: 1 placa = 5 kg')).toEqual({ per_plate: 5, unit: 'kg' })
    expect(platesFactorOf('plate=10lb')).toEqual({ per_plate: 10, unit: 'lb' })
    expect(platesFactorOf('placa = 7,5')).toEqual({ per_plate: 7.5, unit: null })
    expect(platesFactorOf('seat 4, pin 7')).toBeNull()
    expect(platesFactorOf('')).toBeNull()
  })
  test('the gym rides at the front of the note and can be taken off again', () => {
    expect(noteWithGym('Iron', 'ombro')).toBe('Iron · ombro')
    expect(noteWithGym('Iron', '')).toBe('Iron')
    expect(noteWithGym('', 'ombro')).toBe('ombro')
    expect(noteWithoutGym('Iron', 'Iron · ombro')).toBe('ombro')
    expect(noteWithoutGym('Iron', 'Iron')).toBe('')
    expect(noteWithoutGym('Iron', 'ombro')).toBe('ombro')
  })
})

describe('logWorkout — today (the live path)', () => {
  test('files the record, awards a load PR, raises the kept weight, sets the volume and the gym', () => {
    const before = S.workouts.length
    const best = bestBench()
    const r = log({ gym: 'Iron', note: 'ombro', routine: pushDay(), exercises: [{ id: BENCH, sets: [{ w: best + 5, r: 5 }, { w: best + 5, r: 5, failure: true }] }] })
    const w = r.workout
    expect(S.workouts.length).toBe(before + 1)
    expect(S.workouts.at(-1)).toBe(w)
    expect(w.d).toBe(FAKE_TODAY_ISO)
    expect(w.gym).toBe('Iron')
    expect(w.note).toBe('Iron · ombro')
    expect(w.name).toBe('Push Day')
    expect(w.routineId).toBe(pushDay().id)
    expect(w.entries[0].rid).toBe(pushDay().id)
    expect(w.vol).toBe(workoutVolume(w))
    expect(w.vol).toBe((best + 5) * 10)
    expect(w.prs).toEqual([BENCH])
    expect(r.prs).toEqual([BENCH])
    expect(S.exWeights[BENCH]).toEqual({ w: best + 5, d: FAKE_TODAY_ISO })
    expect(w.entries[0].sets[1].failure).toBe(true)
    expect(w.entries[0].sets[0].done).toBe(true)
    expect(w.start).toBe(NOW - 60 * 60000)
    expect(w.end).toBe(NOW)
    expect(w.backfill).toBeUndefined()
    expect(w._ts).toBeUndefined()   // a live session is not an edit; the server stamps it
  })

  test('a lighter session is no PR, keeps the confirmed weight, and reports an e1RM record when the estimate improves', () => {
    const best = bestBench()
    const kept = { ...S.exWeights[BENCH] }
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: best - 10, r: 20 }] }] })
    expect(r.prs).toEqual([])
    expect(S.exWeights[BENCH]).toEqual(kept)
    expect(r.workout.name).toBe('Workout')
    expect(r.workout.routineIds).toEqual([])
    // 20 reps is over the formula's cap, so no estimate: a record cannot be claimed either way.
    expect(r.e1rm_records).toEqual([])
  })

  test('warm-up rows are stored but count for neither volume nor the PR', () => {
    const best = bestBench()
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: best + 20, r: 3, warmup: true }, { w: 40, r: 10 }] }] })
    expect(r.workout.entries[0].sets[0].phase).toBe('warmup')
    expect(r.workout.vol).toBe(400)
    expect(r.prs).toEqual([])
  })

  test('an explicit start on today keeps the live path with that start, filed in time order', () => {
    const later = log({ exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })   // the session that just ended
    const r = log({ start: '07:15', duration_min: 45, exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })
    const d = new Date(r.workout.start)
    expect([d.getHours(), d.getMinutes()]).toEqual([7, 15])
    expect(r.workout.end - r.workout.start).toBe(45 * 60000)
    // A start the caller named places the record by time: the morning session goes before the
    // one logged a moment ago, not after it — History reads the array's order.
    const at = S.workouts.indexOf(r.workout)
    expect(at).toBeLessThan(S.workouts.indexOf(later.workout))
    expect(S.workouts.slice(at + 1).every(w => w.d > r.workout.d || (w.d === r.workout.d && w.start >= r.workout.start))).toBe(true)
    expect(S.workouts.at(-1)).toBe(later.workout)
    expect(S.exWeights[BENCH].d).toBe(FAKE_TODAY_ISO)
  })

  test('a start with no length runs until now; a future start or end is EINVAL', () => {
    const r = log({ start: '18:30', exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })
    expect(r.workout.end).toBe(ctx().now)
    expect(r.workout.end - r.workout.start).toBe(30 * 60000)
    expect(() => log({ start: '23:30', exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })).toThrow(expect.objectContaining({ code: 'EINVAL', message: expect.stringMatching(/later than now/) }))
    expect(() => log({ start: '18:30', duration_min: 90, exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })).toThrow(expect.objectContaining({ code: 'EINVAL', message: expect.stringMatching(/end in the future/) }))
  })

  test('a draft whose id is already filed is answered, not filed twice', () => {
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })
    const n = S.workouts.length
    const draft = { ...draftOf(S, { exercises: [{ ex: ex(BENCH), sets: [{ w: 99, r: 1 }] }] }, ctx()), id: r.workout.id }
    const again = logWorkout(S, draft, ctx())
    expect(again.already_saved).toBe(true)
    expect(again.workout).toBe(r.workout)
    expect(S.workouts).toHaveLength(n)
  })

  test('a set with every number at zero is EINVAL, not a logged set of nothing', () => {
    expect(() => log({ exercises: [{ id: BENCH, sets: [{ r: 0 }] }] })).toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(() => log({ exercises: [{ id: BENCH, sets: [{ w: 60, r: 0, sec: 0 }] }] })).toThrow(/above zero/)
  })

  test('plates: a factor on the exercise note gives a weight; none gives no weight and a warning', () => {
    S.exNotes = { [LEG_PRESS]: 'Iron: 1 placa = 5 kg' }
    const warnings = []
    const r = log({ warnings, exercises: [{ id: LEG_PRESS, sets: [{ plates: 10, r: 12 }] }, { id: BENCH, sets: [{ plates: 3, r: 5 }] }] })
    const [lp, bench] = r.workout.entries
    expect(lp.sets[0].w).toBe(50)
    expect(lp.sets[0].note).toBe('10 placas')
    expect(bench.sets[0].w).toBeUndefined()
    expect(bench.sets[0].note).toMatch(/3 placas \(fator desconhecido\)/)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/barbell bench press: plates logged without a kg factor/)
  })

  test('plates with w, rir with rpe, and a set with no reps/time are refused', () => {
    expect(() => log({ exercises: [{ id: BENCH, sets: [{ plates: 2, w: 10, r: 5 }] }] })).toThrow(/not both/)
    expect(() => log({ exercises: [{ id: BENCH, sets: [{ w: 10, r: 5, rir: 2, rpe: 8 }] }] })).toThrow(/rir or rpe/)
    expect(() => log({ exercises: [{ id: BENCH, sets: [{ w: 10 }] }] })).toThrow(/needs reps/)
  })

  test('a timed set and a cardio set derive their own target so labels read right', () => {
    const r = log({ exercises: [{ id: PLANK, sets: [{ sec: 60 }, { sec: 45 }] }] })
    expect(r.workout.entries[0].target).toMatchObject({ sets: 2, sec: 60, mode: 'time' })
    expect(r.workout.entries[0].sets[0].r).toBeUndefined()
  })
})

describe('logWorkout — a past date (the backfill path)', () => {
  test('files in date order, stamps the record, rebuilds badges, leaves the kept weight alone', () => {
    const kept = { ...S.exWeights[BENCH] }
    const best = bestBench()
    const r = log({ date: '2026-06-01', exercises: [{ id: BENCH, sets: [{ w: best + 5, r: 5 }] }] })
    const w = r.workout
    expect(w.d).toBe('2026-06-01')
    expect(w._ts).toBe(NOW)
    const idx = S.workouts.indexOf(w)
    expect(idx).toBeGreaterThan(0)
    expect(idx).toBeLessThan(S.workouts.length - 1)
    expect(S.workouts.slice(0, idx).every(x => x.d <= '2026-06-01')).toBe(true)
    expect(S.workouts.slice(idx + 1).every(x => x.d >= '2026-06-01')).toBe(true)
    // It leads everything before it, so it gains the badge; a later session that had the badge
    // for a lighter load loses it (rebuildPrHistory's asymmetric rule).
    expect(w.prs).toEqual([BENCH])
    expect(S.workouts.slice(idx + 1).some(x => (x.prs || []).includes(BENCH))).toBe(false)
    expect(S.exWeights[BENCH]).toEqual(kept)
    const d = new Date(w.start)
    expect([d.getHours(), d.getMinutes()]).toEqual([18, 0])
    expect(w.end - w.start).toBe(60 * 60000)
  })
})

describe('updateWorkout', () => {
  test('replacing the sets rewrites the record in place, stamps it and keeps its id and date', () => {
    const r = log({ gym: 'Iron', exercises: [{ id: BENCH, sets: [{ w: 60, r: 10 }] }] })
    const id = r.workout.id
    const u = updateWorkout(S, { workout_id: id, exercises: [{ ex: ex(BENCH), sets: [{ w: 65, r: 10 }, { w: 65, r: 8 }] }] }, ctx())
    expect(u.changed).toEqual(['exercises'])
    expect(u.workout.id).toBe(id)
    expect(u.workout.d).toBe(FAKE_TODAY_ISO)
    expect(u.workout.gym).toBe('Iron')
    expect(u.workout.entries[0].sets.map(s => s.w)).toEqual([65, 65])
    expect(u.workout.vol).toBe(65 * 18)
    expect(u.workout._ts).toBe(NOW)
    expect(S.workouts.filter(w => w.id === id)).toHaveLength(1)
    expect(S.active).toBeNull()
  })

  test('an edit that takes away the kept weight lowers it; changing the gym rewrites the note prefix', () => {
    const best = bestBench()
    const r = log({ gym: 'Iron', note: 'ombro', exercises: [{ id: BENCH, sets: [{ w: best + 10, r: 3 }] }] })
    expect(S.exWeights[BENCH].w).toBe(best + 10)
    const u = updateWorkout(S, { workout_id: r.workout.id, gym: 'Smart Fit', exercises: [{ ex: ex(BENCH), sets: [{ w: 40, r: 10 }] }] }, ctx())
    expect(S.exWeights[BENCH].w).toBe(best)
    expect(u.workout.gym).toBe('Smart Fit')
    expect(u.workout.note).toBe('Smart Fit · ombro')
    expect(u.changed).toEqual(['exercises', 'gym'])
  })

  test('note only, date move, and duration change', () => {
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })
    const u1 = updateWorkout(S, { workout_id: r.workout.id, note: 'leve' }, ctx())
    expect(u1.workout.note).toBe('leve')
    expect(u1.changed).toEqual(['note'])
    const u2 = updateWorkout(S, { workout_id: r.workout.id, date: '2026-07-20', start: '08:30', duration_min: 30 }, ctx())
    expect(u2.workout.d).toBe('2026-07-20')
    const d = new Date(u2.workout.start)
    expect([d.getHours(), d.getMinutes()]).toEqual([8, 30])
    expect(u2.workout.end - u2.workout.start).toBe(30 * 60000)
    expect(u2.changed).toEqual(['date', 'start', 'duration_min'])
    expect(S.workouts.filter(w => w.id === r.workout.id)).toHaveLength(1)
    expect(S.workouts.findIndex(w => w.id === r.workout.id)).toBeLessThan(S.workouts.length - 1)
  })

  test('an unknown id is ENOENT; an edit that leaves no set is EINVAL and closes the editor', () => {
    expect(() => updateWorkout(S, { workout_id: 'nope', note: 'x' }, ctx())).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: 40, r: 10 }] }] })
    expect(() => updateWorkout(S, { workout_id: r.workout.id, exercises: [{ ex: ex(BENCH), sets: [{ r: 0 }] }] }, ctx()))
      .toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(S.active).toBeNull()
  })
})

describe('deleteWorkout', () => {
  test('removes the record and lowers a kept weight that came only from it', () => {
    const best = bestBench()
    const r = log({ exercises: [{ id: BENCH, sets: [{ w: best + 10, r: 3 }] }] })
    const n = S.workouts.length
    const d = deleteWorkout(S, r.workout.id)
    expect(d).toMatchObject({ id: r.workout.id, date: FAKE_TODAY_ISO })
    expect(S.workouts.length).toBe(n - 1)
    expect(S.workouts.some(w => w.id === r.workout.id)).toBe(false)
    expect(S.exWeights[BENCH].w).toBe(best)
    expect(S.active).toBeNull()
  })
  test('an unknown id is ENOENT', () => {
    expect(() => deleteWorkout(S, 'nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(() => findWorkout(S, 'nope')).toThrow(/list_workouts/)
  })
})

describe('addBodyweight', () => {
  test('appends today, reports the previous weigh-in and the delta, keeps the list by day', () => {
    const last = [...S.bodyweight].sort((a, b) => a.d.localeCompare(b.d)).at(-1)
    const { d: lastD, w: lastW } = last   // the entry object itself is edited when it is today's
    const r = addBodyweight(S, { weight: lastW + 0.5 }, ctx())
    expect(r.entry).toEqual({ date: FAKE_TODAY_ISO, weight: Math.round((lastW + 0.5) * 10) / 10 })
    expect(r.replaced).toBe(lastD === FAKE_TODAY_ISO)
    expect(S.bodyweight.at(-1)).toMatchObject({ d: FAKE_TODAY_ISO, t: NOW })
    expect(S.bodyweight.every((b, i) => i === 0 || b.d >= S.bodyweight[i - 1].d)).toBe(true)
  })
  test('a second weigh-in on the same date replaces the first', () => {
    addBodyweight(S, { weight: 80, date: '2026-07-01' }, ctx())
    const r = addBodyweight(S, { weight: 81, date: '2026-07-01' }, ctx())
    expect(r.replaced).toBe(true)
    expect(S.bodyweight.filter(b => b.d === '2026-07-01')).toHaveLength(1)
    expect(S.bodyweight.find(b => b.d === '2026-07-01').w).toBe(81)
  })
  test('zero or negative is EINVAL', () => {
    expect(() => addBodyweight(S, { weight: 0 }, ctx())).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })
})

describe('setExerciseNote', () => {
  test('sets, reports the plates factor, and clears on an empty note', () => {
    const r = setExerciseNote(S, { id: LEG_PRESS, note: 'banco 4 · 1 placa = 5 kg' })
    expect(S.exNotes[LEG_PRESS]).toBe('banco 4 · 1 placa = 5 kg')
    expect(r.plates_factor).toEqual({ per_plate: 5, unit: 'kg' })
    const c = setExerciseNote(S, { id: LEG_PRESS, note: '   ' })
    expect(c.note).toBeNull()
    expect(LEG_PRESS in S.exNotes).toBe(false)
  })
})

describe('editRoutine', () => {
  test('creates a routine with a rep range, a timed slot and a superset pair', () => {
    const n = S.routines.length
    const r = editRoutine(S, {
      name: 'Glúteos', emoji: '🍑',
      exercises: [
        { ex: ex(LEG_PRESS), sets: 4, reps: 12, reps_min: 8, weight: 100, rest_sec: 120, superset_group: 'A' },
        { ex: ex(BENCH), sets: 3, reps: 10, superset_group: 'A' },
        { ex: ex(PLANK), sec: 60, sets: 2 }
      ]
    }, ctx())
    expect(r.action).toBe('created')
    expect(S.routines.length).toBe(n + 1)
    const saved = S.routines.at(-1)
    expect(saved.name).toBe('Glúteos')
    expect(saved.emoji).toBe('🍑')
    expect(saved.ex[0]).toMatchObject({ id: LEG_PRESS, sets: 4, reps: 12, repsMin: 8, weight: 100, restSec: 120, sg: 'sg-A' })
    expect(saved.ex[1]).toMatchObject({ id: BENCH, sets: 3, reps: 10, weight: 0, sg: 'sg-A' })
    expect(saved.ex[2]).toMatchObject({ id: PLANK, sets: 2, sec: 60, mode: 'time' })
    expect(saved.ex[2].weight).toBeUndefined()
  })

  test('updating replaces the list in order and keeps a kept slot\'s stored extras', () => {
    const r0 = pushDay()
    r0.ex[0].inc = 2.5
    const r = editRoutine(S, { routine: r0, name: 'Push A', exercises: [{ ex: ex(BENCH), sets: 5, reps: 5 }, { ex: ex(PLANK), sec: 30 }] }, ctx())
    expect(r.action).toBe('updated')
    const saved = S.routines.find(x => x.id === r0.id)
    expect(saved.name).toBe('Push A')
    expect(saved.ex.map(c => c.id)).toEqual([BENCH, PLANK])
    expect(saved.ex[0]).toMatchObject({ sets: 5, reps: 5, inc: 2.5 })
  })

  test('updating keeps a stored weight, clears a rep range when plain reps are sent, and drops the old mode\'s numbers', () => {
    const r0 = pushDay()
    const slot = r0.ex.find(c => c.id === BENCH)
    slot.weight = 62.5; slot.reps = 12; slot.repsMin = 8
    editRoutine(S, { routine: r0, exercises: [{ ex: ex(BENCH), sets: 4, reps: 6 }] }, ctx())
    let saved = S.routines.find(x => x.id === r0.id).ex[0]
    expect(saved).toMatchObject({ sets: 4, reps: 6, weight: 62.5 })
    expect(saved.repsMin).toBeUndefined()
    editRoutine(S, { routine: r0, exercises: [{ ex: ex(BENCH), sec: 40 }] }, ctx())
    saved = S.routines.find(x => x.id === r0.id).ex[0]
    expect(saved).toMatchObject({ mode: 'time', sec: 40, weight: 62.5 })
    expect(saved.reps).toBeUndefined()
  })

  test('removing takes the routine off the weekday plan too; creating without a name or exercises is EINVAL', () => {
    const r0 = pushDay()
    const day = Object.keys(S.week).find(d => [].concat(S.week[d]).includes(r0.id))
    expect(day).toBeDefined()
    const r = editRoutine(S, { routine: r0, remove: true }, ctx())
    expect(r.action).toBe('deleted')
    expect(S.routines.some(x => x.id === r0.id)).toBe(false)
    expect([].concat(S.week[day] || [])).not.toContain(r0.id)
    expect(() => editRoutine(S, { exercises: [{ ex: ex(BENCH) }] }, ctx())).toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(() => editRoutine(S, { name: 'X' }, ctx())).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })
})
