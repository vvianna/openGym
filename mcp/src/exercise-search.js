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
   `export default { id: name }` objects), loaded once per language with a dynamic import. The
   profile's language is tried first; when it finds nothing (a profile left in English whose owner
   types "supino com barra"), every pack is loaded and the search runs over all of them — the
   async findExercise / findExercises do both passes, and are what the tools call.

   Lookups by what the user typed never index a plain object directly: EXIDX is `{}`, and
   "constructor" or "__proto__" would come back as a function and be written as an exercise with
   no id. Object.hasOwn, and an id that is a string, are the guard. */
import { allExercises, searchScore, normalizeStr, EXIDX, BODYPARTS } from '../../frontend/src/lib/exercises.js'
import { baseLang, EXERCISE_NAME_LANGS } from '../../frontend/src/lib/i18n-core.js'
import { coded } from './schema.js'

const packs = new Map()        // lang → { id: name } (or {} when the language has no pack)

/** The exercise-name pack language a profile reads: its `lang`'s base, when a pack exists. */
export function nameLangOf(S) {
  const l = baseLang(String(S?.lang || 'en'))
  return l !== 'en' && EXERCISE_NAME_LANGS.includes(l) ? l : null
}

async function loadPack(lang) {
  if (!packs.has(lang)) {
    try {
      const mod = await import(`../../frontend/src/exercise-names/${lang}.js`)
      packs.set(lang, mod.default || {})
    } catch { packs.set(lang, {}) }
  }
  return packs.get(lang)
}

/** Loads (once) the localized names for the profile's language. Returns the pack or {}. */
export async function ensureNames(S) {
  const lang = nameLangOf(S)
  return lang ? loadPack(lang) : {}
}

let allLoaded = false
/** Loads every exercise-name pack the catalogue has (once), for the any-language fallback. */
export async function ensureAllNames() {
  if (!allLoaded) { for (const l of EXERCISE_NAME_LANGS) await loadPack(l); allLoaded = true }
}

// A pack entry for an id — ids are catalogue strings, but the packs are plain objects too.
const nameIn = (pack, id) => (pack && typeof id === 'string' && Object.hasOwn(pack, id) && typeof pack[id] === 'string' ? pack[id] : null)

/** The localized name of a catalogue exercise, or null (no pack loaded, custom, unknown). */
export function localizedName(S, id) {
  const lang = nameLangOf(S)
  return lang ? nameIn(packs.get(lang), id) : null
}

// Every loaded pack's name for an id, the profile language's left out: the fallback pass.
function otherNames(S, id) {
  const own = nameLangOf(S)
  const out = []
  for (const [lang, pack] of packs) { if (lang === own) continue; const n = nameIn(pack, id); if (n) out.push(n) }
  return out
}

const isId = v => typeof v === 'string' && v.length > 0
const customOf = (S, id) => (isId(id) && Array.isArray(S?.customEx) ? S.customEx : []).find(x => x && x.id === id) || null
const isCustom = (S, ex) => !!customOf(S, ex?.id)
// The catalogue entry for an id typed by the user — never a property of Object.
const catalogueOf = id => (isId(id) && Object.hasOwn(EXIDX, id) && isId(EXIDX[id]?.id) ? EXIDX[id] : null)
const exactOf = (S, q) => catalogueOf(q) || customOf(S, q)

/** One exercise as every search / resolve answer describes it. */
export function exerciseRow(S, ex, score, matched = null) {
  return {
    id: ex.id,
    name_en: ex.n || '',
    name_localized: localizedName(S, ex.id),
    // Set when the hit came through another language's name (the any-language fallback).
    ...(matched ? { name_matched: matched } : {}),
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
// With `allLangs`, every loaded pack's name takes part too; `matchedOf` says which other-language
// name carried the hit (null when the English or profile-language name did).
function scoreOf(S, ex, query, allLangs = false) {
  const q = normalizeStr(query)
  const en = searchScore({ ...ex, n: normalizeStr(ex.n) }, q)
  const loc = localizedName(S, ex.id)
  const lo = loc ? searchScore({ ...ex, n: normalizeStr(loc) }, q) : 0
  let base = Math.max(en, lo)
  let shortest = Math.min(String(ex.n || '').length, loc ? loc.length : Infinity)
  if (allLangs) {
    for (const n of otherNames(S, ex.id)) {
      const sc = searchScore({ ...ex, n: normalizeStr(n) }, q)
      if (sc > base) { base = sc; shortest = Math.min(shortest, n.length) }
    }
  }
  if (!base) return 0
  return base + (trainedSet(S).has(ex.id) ? 120 : 0) + Math.max(0, 40 - shortest)
}
function matchedOf(S, ex, query) {
  const q = normalizeStr(query)
  const own = Math.max(searchScore({ ...ex, n: normalizeStr(ex.n) }, q), localizedName(S, ex.id) ? searchScore({ ...ex, n: normalizeStr(localizedName(S, ex.id)) }, q) : 0)
  let best = null, bestScore = own
  for (const n of otherNames(S, ex.id)) {
    const sc = searchScore({ ...ex, n: normalizeStr(n) }, q)
    if (sc > bestScore) { bestScore = sc; best = n }
  }
  return best
}

/**
 * Ranked search over the catalogue and the profile's custom exercises. `body_part` and
 * `equipment` narrow the pool; an exact id returns that one exercise with the top score.
 */
export function searchExercises(S, query, { bodyPart = null, equipment = null, limit = 8, allLangs = false } = {}) {
  const q = String(query || '').trim()
  const pool = allExercises(S || {}).filter(ex => ex && isId(ex.id))
  const exact = exactOf(S, q)
  if (exact) return [exerciseRow(S, exact, 1000)]
  const scored = []
  for (const ex of pool) {
    if (bodyPart && normalizeStr(ex.bp) !== normalizeStr(bodyPart)) continue
    if (equipment && normalizeStr(ex.eq) !== normalizeStr(equipment)) continue
    const s = scoreOf(S, ex, q, allLangs)
    if (s > 0) scored.push([s, ex])
  }
  scored.sort((a, b) => b[0] - a[0] || String(a[1].n).localeCompare(String(b[1].n)))
  return scored.slice(0, Math.max(1, Math.min(25, limit))).map(([s, ex]) => exerciseRow(S, ex, s, allLangs ? matchedOf(S, ex, q) : null))
}

/**
 * searchExercises over every language's names: a query is in whatever language the user typed,
 * and a profile left in English whose owner types "supino com barra" must not get the fuzzy
 * English near-misses instead of the bench press. The profile's own and the English names still
 * score the same; another language's name only ever raises a hit, and a row it carried says so
 * (`name_matched`). `fallback` is true when the top hit came through such a name.
 */
export async function findExercises(S, query, opts = {}) {
  await ensureNames(S)
  await ensureAllNames()
  const exercises = searchExercises(S, query, { ...opts, allLangs: true })
  return { exercises, fallback: !!exercises[0]?.name_matched }
}

/**
 * The one exercise `text` names, or an EAMBIG / ENOENT error. Call ensureNames(S) first so the
 * profile language's names take part (the tools call findExercise, which does, and falls back
 * to every language when the profile's finds nothing).
 */
export function resolveExercise(S, text, { allLangs = false, exactOnly = false } = {}) {
  const q = String(text || '').trim()
  if (!q) throw coded('EINVAL', 'an exercise id or name is required')
  const exact = exactOf(S, q)
  if (exact) return exact
  const want = normalizeStr(q)
  const pool = allExercises(S || {}).filter(ex => ex && isId(ex.id))
  const ownNames = ex => [ex.n, localizedName(S, ex.id)].filter(Boolean)
  let byName = pool.filter(ex => ownNames(ex).some(n => normalizeStr(n) === want))
  // The any-language pass: an exact name in some other pack decides only when the words are not
  // English ones too — "plank" is exactly one exercise's German name and part of a dozen English
  // ones, and the user who typed it in English is still to be asked; "supino com barra" is in no
  // English name, so its one Portuguese match is the answer.
  if (!byName.length && allLangs && !pool.some(ex => normalizeStr(ex.n).includes(want))) {
    byName = pool.filter(ex => otherNames(S, ex.id).some(n => normalizeStr(n) === want))
  }
  if (byName.length === 1) return byName[0]
  // `exactOnly`: the caller already has a verdict from a stricter pass and only wants to know
  // whether an exact name decides it; the fuzzy ranking below is not allowed to.
  if (!byName.length && exactOnly) throw coded('ENOENT', `no exact name matches ${JSON.stringify(q)}`)
  // A custom exercise named exactly like a catalogue one is the user's own: they made it on purpose.
  if (byName.length > 1) { const own = byName.filter(ex => isCustom(S, ex)); if (own.length === 1) return own[0] }
  // Two catalogue entries can share a localized name; the one this profile trains is the one meant.
  if (byName.length > 1) { const mine = byName.filter(ex => trainedSet(S).has(ex.id)); if (mine.length === 1) return mine[0] }
  const ranked = byName.length > 1 ? byName.map(ex => [scoreOf(S, ex, q, allLangs) || 1, ex]) : pool.map(ex => [scoreOf(S, ex, q, allLangs), ex]).filter(([s]) => s > 0)
  ranked.sort((a, b) => b[0] - a[0])
  if (!ranked.length) throw coded('ENOENT', `no exercise matches ${JSON.stringify(q)} — try search_exercises with another word, in English or the profile's language`)
  // A clear leader: half again the runner-up's score, or ahead by more than the "this profile
  // trains it" bonus — a multi-word query scores every hit high, and the ratio alone would make
  // "supino inclinado" ambiguous among 70 incline presses while the plan holds exactly one.
  if (ranked.length === 1 || ranked[0][0] >= 1.5 * ranked[1][0] || ranked[0][0] - ranked[1][0] >= 100) return ranked[0][1]
  const candidates = ranked.slice(0, 8).map(([s, ex]) => exerciseRow(S, ex, s, allLangs ? matchedOf(S, ex, q) : null))
  throw coded('EAMBIG', `${JSON.stringify(q)} matches ${ranked.length} exercises — call again with one of these ids`, { candidates })
}

/**
 * resolveExercise after ensureNames, in two passes: the profile's language (and English) first,
 * so a tie there is decided by the names the user sees in the app; then, when that pass finds
 * nothing or cannot decide, every language's names — an exact "supino com barra" on an English
 * profile resolves there instead of being ambiguous among fuzzy English near-misses. After an
 * ambiguous first pass only an exact other-language name may decide; otherwise the first pass's
 * candidates are what the agent gets.
 */
export async function findExercise(S, text) {
  await ensureNames(S)
  try { return resolveExercise(S, text) } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'EAMBIG') throw e
    await ensureAllNames()
    // Nothing matched: every language's names, fuzzy included. Ambiguous: only an exact name in
    // another language may decide it — a fuzzy lead gained from a third language is no answer to
    // a question the user's own languages could not settle.
    if (e.code === 'ENOENT') return resolveExercise(S, text, { allLangs: true })
    try { return resolveExercise(S, text, { allLangs: true, exactOnly: true }) } catch (e2) {
      if (e2.code === 'ENOENT') throw e
      throw e2
    }
  }
}

/** The one routine `text` names: id, then exact name (case-insensitive), then a unique prefix. */
export function resolveRoutine(S, text) {
  const q = String(text || '').trim()
  if (!q) throw coded('EINVAL', 'a routine id or name is required')
  const routines = (Array.isArray(S?.routines) ? S.routines : []).filter(r => r && isId(r.id))
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
