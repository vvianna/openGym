// Name resolution (mcp/src/exercise-search.js): the four steps of the rule, in both languages,
// against the demo profile.
import { describe, beforeAll, beforeEach, test, expect } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { ensureNames, resolveExercise, resolveRoutine, searchExercises, localizedName, nameLangOf } from '../src/exercise-search.js'

const BENCH = '0025'
const INCLINE = '0047'
let S
beforeAll(async () => { S = buildDemoState(); S.lang = 'pt-BR'; await ensureNames(S) })
beforeEach(() => { S = buildDemoState(); S.lang = 'pt-BR' })

const code = (fn) => { try { fn(); return null } catch (e) { return e } }

describe('resolveExercise', () => {
  test('an id wins outright, even one that looks like a word', () => {
    expect(resolveExercise(S, BENCH).id).toBe(BENCH)
  })
  test('an exact English or Portuguese name, accents and case ignored', () => {
    expect(resolveExercise(S, 'Barbell Bench Press').id).toBe(BENCH)
    expect(resolveExercise(S, 'SUPINO COM BARRA').id).toBe(BENCH)
    expect(resolveExercise(S, 'elevacao lateral com halteres').id).toBe('0334')
  })
  test('a fuzzy query resolves when one exercise clearly leads; two trained ones that tie are asked about', () => {
    expect(resolveExercise(S, 'supino inclinado').id).toBe(INCLINE)
    expect(resolveExercise(S, 'leg press').id).toBe('0739')
    expect(resolveExercise(S, 'elevacao lateral').id).toBe('0334')
    // "supino" alone: the flat and the incline bench press are both in the plan — ask, do not guess.
    const e = code(() => resolveExercise(S, 'supino'))
    expect(e.code).toBe('EAMBIG')
    expect(e.candidates.slice(0, 2).map(c => c.id).sort()).toEqual([BENCH, INCLINE])
  })
  test('an ambiguous query is EAMBIG with up to eight candidates carrying ids and both names', () => {
    const e = code(() => resolveExercise(S, 'plank'))
    expect(e.code).toBe('EAMBIG')
    expect(e.candidates.length).toBeLessThanOrEqual(8)
    expect(e.candidates.length).toBeGreaterThan(1)
    expect(e.candidates[0]).toMatchObject({ id: expect.any(String), name_en: expect.stringMatching(/plank/), name_localized: expect.stringMatching(/prancha|polichinelo|salto/), body_part: expect.any(String) })
    expect(e.message).toMatch(/matches \d+ exercises — call again with one of these ids/)
  })
  test('nothing at all is ENOENT; an empty string EINVAL', () => {
    expect(code(() => resolveExercise(S, 'zzqqxx')).code).toBe('ENOENT')
    expect(code(() => resolveExercise(S, '  ')).code).toBe('EINVAL')
  })
  test('a custom exercise resolves by id and by its own name, and wins a tie with the catalogue', () => {
    S.customEx = [{ id: 'cx-1', n: 'Voador da Iron', bp: 'chest', eq: 'leverage machine' }, { id: 'cx-2', n: 'barbell bench press', bp: 'chest' }]
    expect(resolveExercise(S, 'cx-1').id).toBe('cx-1')
    expect(resolveExercise(S, 'voador da iron').id).toBe('cx-1')
    expect(resolveExercise(S, 'barbell bench press').id).toBe('cx-2')
  })
  test('an English-only profile resolves English names and has no localized names', () => {
    S.lang = 'en'
    expect(nameLangOf(S)).toBeNull()
    expect(localizedName(S, BENCH)).toBeNull()
    expect(resolveExercise(S, 'barbell bench press').id).toBe(BENCH)
  })
})

describe('searchExercises', () => {
  test('ranks the profile\'s own bench press first for "supino" and returns both names', () => {
    const r = searchExercises(S, 'supino', { limit: 5 })
    expect(r).toHaveLength(5)
    expect(r[0]).toMatchObject({ id: BENCH, name_en: 'barbell bench press', name_localized: 'supino com barra', score: expect.any(Number) })
    expect(r[0].score).toBeGreaterThan(r[1].score - 0.01)
  })
  test('filters by body part and equipment, caps the limit, and an exact id short-circuits', () => {
    expect(searchExercises(S, 'press', { bodyPart: 'chest', equipment: 'dumbbell', limit: 50 }).every(e => e.body_part === 'chest' && e.equipment === 'dumbbell')).toBe(true)
    expect(searchExercises(S, 'press', { limit: 50 })).toHaveLength(25)
    expect(searchExercises(S, BENCH)).toEqual([expect.objectContaining({ id: BENCH, score: 1000 })])
    expect(searchExercises(S, 'zzqqxx')).toEqual([])
  })
})

describe('resolveRoutine', () => {
  test('id, exact name, unique prefix, unique substring; ambiguous and unknown', () => {
    const push = S.routines.find(r => r.name === 'Push Day')
    expect(resolveRoutine(S, push.id)).toBe(push)
    expect(resolveRoutine(S, 'push day')).toBe(push)
    expect(resolveRoutine(S, 'Pus')).toBe(push)
    expect(resolveRoutine(S, 'leg')).toBe(S.routines.find(r => r.name === 'Leg Day'))
    const e = code(() => resolveRoutine(S, 'Day'))
    expect(e.code).toBe('EAMBIG')
    expect(e.candidates).toHaveLength(3)
    expect(code(() => resolveRoutine(S, 'Arms')).code).toBe('ENOENT')
  })
})
