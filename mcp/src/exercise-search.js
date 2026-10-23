/* Names → ids. Hermes gets free text ("supino", "voador", "leg press"); every write tool takes an
   exercise or routine as an id OR a name and resolves it here, the same way, so the agent never
   has to know which it holds. The rule (docs/dev/MCP_WRITE.md, "Resolving names"):

     1. an exact id (catalogue or a custom exercise) wins outright;
     2. an exact name — English, the profile language's, or a custom's — case- and
        accent-insensitive, wins;
     3. otherwise searchScore() over the catalogue + customs, scoring the English and the
        localized name; one hit, or a clear leader (≥ 1.5× the runner-up), resolves;
     4. anything else is EAMBIG with a candidate list, and the agent asks rather than guesses.

   Localized names are the app's own packs (frontend/src/exercise-names/<lang>.js, plain
   `export default { id: name }` objects), loaded once per language with a dynamic import. */
import { allExercises, searchScore, normalizeStr, EXIDX, BODYPARTS } from '../../frontend/src/lib/exercises.js'
import { baseLang, EXERCISE_NAME_LANGS } from '../../frontend/src/lib/i18n-core.js'
import { coded } from './schema.js'

const packs = new Map()        // lang → { id: name } (or {} when the language has no pack)

/** The exercise-name pack language a profile reads: its `lang`'s base, when a pack exists. */
export function nameLangOf(S) {
  const l = baseLang(String(S?.lang || 'en'))
  return l !== 'en' && EXERCISE_NAME_LANGS.includes(l) ? l : null
}

/** Loads (once) the localized names for the profile's language. Returns the pack or {}. */
export async function ensureNames(S) {
  const lang = nameLangOf(S)
  if (!lang) return {}
  if (!packs.has(lang)) {
    try {
      const mod = await import(`../../frontend/src/exercise-names/${lang}.js`)
      packs.set(lang, mod.default || {})
    } catch { packs.set(lang, {}) }
  }
  return packs.get(lang)
}

/** The localized name of a catalogue exercise, or null (no pack loaded, custom, unknown). */
export function localizedName(S, id) {
  const lang = nameLangOf(S)
  return lang && packs.get(lang)?.[id] ? packs.get(lang)[id] : null
}

const customOf = (S, id) => (Array.isArray(S?.customEx) ? S.customEx : []).find(x => x && x.id === id) || null
const isCustom = (S, ex) => !!customOf(S, ex?.id)

/** One exercise as every search / resolve answer describes it. */
export function exerciseRow(S, ex, score) {
  return {
    id: ex.id,
    name_en: ex.n || '',
    name_localized: localizedName(S, ex.id),
    body_part: ex.bp || null,
    equipment: ex.eq || null,
    target: ex.tg || null,
    is_custom: isCustom(S, ex),
    ...(score != null ? { score: Math.round(score * 10) / 10 } : {})
  }
}

// Score an exercise under both its names: the English row as it is, the localized name
// substituted as `n` on a shallow copy so searchScore's name weighting applies to it too.
// Two tie-breakers on top of the catalogue's own score, because the agent gets ONE answer:
// an exercise this profile has trained or planned outranks one it never has ("supino" is the
// bench press they do, not a band press), and a shorter name outranks a longer one with the same
// hit (the plain movement before its variations).
const trainedIds = new WeakMap()
function trainedSet(S) {
  if (!S || typeof S !== 'object') return new Set()
  let set = trainedIds.get(S)
  if (!set) {
    set = new Set()
    for (const w of Array.isArray(S.workouts) ? S.workouts : []) for (const e of (w && Array.isArray(w.entries) ? w.entries : [])) if (e && e.id) set.add(e.id)
    for (const r of Array.isArray(S.routines) ? S.routines : []) for (const c of (r && Array.isArray(r.ex) ? r.ex : [])) if (c && c.id) set.add(c.id)
    trainedIds.set(S, set)
  }
  return set
}
// Accents are stripped on both sides (normalizeStr) before scoring: searchScore only lowercases,
// and a user who types "elevacao" means "elevação".
function scoreOf(S, ex, query) {
  const q = normalizeStr(query)
  const en = searchScore({ ...ex, n: normalizeStr(ex.n) }, q)
  const loc = localizedName(S, ex.id)
  const lo = loc ? searchScore({ ...ex, n: normalizeStr(loc) }, q) : 0
  const base = Math.max(en, lo)
  if (!base) return 0
  const shortest = Math.min(String(ex.n || '').length, loc ? loc.length : Infinity)
  return base + (trainedSet(S).has(ex.id) ? 120 : 0) + Math.max(0, 40 - shortest)
}

/**
 * Ranked search over the catalogue and the profile's custom exercises. `body_part` and
 * `equipment` narrow the pool; an exact id returns that one exercise with the top score.
 */
export function searchExercises(S, query, { bodyPart = null, equipment = null, limit = 8 } = {}) {
  const q = String(query || '').trim()
  const pool = allExercises(S || {}).filter(ex => ex && ex.id)
  const exact = EXIDX[q] || customOf(S, q)
  if (exact) return [exerciseRow(S, exact, 1000)]
  const scored = []
  for (const ex of pool) {
    if (bodyPart && normalizeStr(ex.bp) !== normalizeStr(bodyPart)) continue
    if (equipment && normalizeStr(ex.eq) !== normalizeStr(equipment)) continue
    const s = scoreOf(S, ex, q)
    if (s > 0) scored.push([s, ex])
  }
  scored.sort((a, b) => b[0] - a[0] || String(a[1].n).localeCompare(String(b[1].n)))
  return scored.slice(0, Math.max(1, Math.min(25, limit))).map(([s, ex]) => exerciseRow(S, ex, s))
}

/**
 * The one exercise `text` names, or an EAMBIG / ENOENT error. Call ensureNames(S) first so the
 * profile language's names take part (the tools do).
 */
export function resolveExercise(S, text) {
  const q = String(text || '').trim()
  if (!q) throw coded('EINVAL', 'an exercise id or name is required')
  const exact = EXIDX[q] || customOf(S, q)
  if (exact) return exact
  const want = normalizeStr(q)
  const pool = allExercises(S || {}).filter(ex => ex && ex.id)
  const byName = pool.filter(ex => normalizeStr(ex.n) === want || (localizedName(S, ex.id) && normalizeStr(localizedName(S, ex.id)) === want))
  if (byName.length === 1) return byName[0]
  // A custom exercise named exactly like a catalogue one is the user's own: they made it on purpose.
  if (byName.length > 1) { const own = byName.filter(ex => isCustom(S, ex)); if (own.length === 1) return own[0] }
  // Two catalogue entries can share a localized name; the one this profile trains is the one meant.
  if (byName.length > 1) { const mine = byName.filter(ex => trainedSet(S).has(ex.id)); if (mine.length === 1) return mine[0] }
  const ranked = byName.length > 1 ? byName.map(ex => [scoreOf(S, ex, q) || 1, ex]) : pool.map(ex => [scoreOf(S, ex, q), ex]).filter(([s]) => s > 0)
  ranked.sort((a, b) => b[0] - a[0])
  if (!ranked.length) throw coded('ENOENT', `no exercise matches ${JSON.stringify(q)} — try search_exercises with another word, in English or the profile's language`)
  // A clear leader: half again the runner-up's score, or ahead by more than the "this profile
  // trains it" bonus — a multi-word query scores every hit high, and the ratio alone would make
  // "supino inclinado" ambiguous among 70 incline presses while the plan holds exactly one.
  if (ranked.length === 1 || ranked[0][0] >= 1.5 * ranked[1][0] || ranked[0][0] - ranked[1][0] >= 100) return ranked[0][1]
  const candidates = ranked.slice(0, 8).map(([s, ex]) => exerciseRow(S, ex, s))
  throw coded('EAMBIG', `${JSON.stringify(q)} matches ${ranked.length} exercises — call again with one of these ids`, { candidates })
}

/** The one routine `text` names: id, then exact name (case-insensitive), then a unique prefix. */
export function resolveRoutine(S, text) {
  const q = String(text || '').trim()
  if (!q) throw coded('EINVAL', 'a routine id or name is required')
  const routines = (Array.isArray(S?.routines) ? S.routines : []).filter(r => r && r.id)
  const byId = routines.find(r => r.id === q)
  if (byId) return byId
  const want = normalizeStr(q)
  const exact = routines.filter(r => normalizeStr(r.name) === want)
  if (exact.length === 1) return exact[0]
  const prefix = routines.filter(r => normalizeStr(r.name).startsWith(want))
  if (prefix.length === 1) return prefix[0]
  const contains = routines.filter(r => normalizeStr(r.name).includes(want))
  if (contains.length === 1) return contains[0]
  const pool = exact.length ? exact : prefix.length ? prefix : contains
  if (!pool.length) throw coded('ENOENT', `no routine named ${JSON.stringify(q)} — list_routines shows the ones on this profile`)
  throw coded('EAMBIG', `${JSON.stringify(q)} matches ${pool.length} routines — call again with one of these ids`, {
    candidates: pool.slice(0, 8).map(r => ({ id: r.id, name: r.name, exercise_count: (r.ex || []).length }))
  })
}

export { BODYPARTS }
