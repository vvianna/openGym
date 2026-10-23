/* The pure writes. Every function here takes the document `S` (already a copy, over the app's
   defaults), the tool's arguments as plain data, and `ctx = { now, todayIso, unit }` for the
   clock — never Date.now() — mutates `S` in place and returns what the tool reports. No network,
   no file, no zod: state.js's mutate() wraps them, mcp/test/mutations.test.js pins them.

   The rule from CONTRIBUTING.md applies in full: nothing about what counts as a PR, a volume, a
   kept weight or a filed session is decided here. Records are built by the app's own code —
   buildCompletedWorkout (finish-workout.js), insertChronological / completeBackfill
   (backfill.js), rebuildPrHistory / moveWorkout / setWorkoutDuration (workout-date.js),
   editCompletedSession / saveWorkoutEdit / deleteEditedWorkout (session-edit.js), deleteRoutine
   (routines.js), refillAfter (rotation.js) — exactly the calls sheets.jsx makes. */
import { uid } from '../../frontend/src/lib/format.js'
import { buildCompletedWorkout } from '../../frontend/src/lib/finish-workout.js'
import { backfillStart, backfillEnd, completeBackfill, insertChronological } from '../../frontend/src/lib/backfill.js'
import { rebuildPrHistory, moveWorkout, setWorkoutDuration, sameWorkout } from '../../frontend/src/lib/workout-date.js'
import { editCompletedSession, saveWorkoutEdit, deleteEditedWorkout } from '../../frontend/src/lib/session-edit.js'
import { stampWorkout } from '../../frontend/src/lib/sync-merge.js'
import { refillAfter } from '../../frontend/src/lib/rotation.js'
import { deriveSessionName } from '../../frontend/src/lib/session-merge.js'
import { deleteRoutine } from '../../frontend/src/lib/routines.js'
import { beatsWeight, betterWeight, isCustomEx } from '../../frontend/src/lib/exercises.js'
import { bestWeightFor, bestWeightForEntry, workoutVolume, modeOf, NOTE_MAX } from '../../frontend/src/lib/history.js'
import { entryDbLoad } from '../../frontend/src/lib/dumbbells.js'
import { is1RMRecord } from '../../frontend/src/lib/onerm.js'
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js'
import { exerciseMuscleSnapshot } from '../../frontend/src/lib/muscles.js'
import { normalizeRepRange } from '../../frontend/src/lib/rep-range.js'
import { coded } from './schema.js'

const list = v => (Array.isArray(v) ? v : [])
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
export const GYM_MAX = 40
export const NAME_MAX = 60

/* ---------- plates ---------- */

/** The "1 placa = 5 kg" convention in a standing exercise note (docs/dev/MCP_WRITE.md, Plates). */
export const PLATE_FACTOR_RE = /(?:^|[\s,;(])(?:1\s*)?(?:placa|plate)\s*=\s*(\d+(?:[.,]\d+)?)\s*(kg|lb)?/i

/** { per_plate, unit } from a note, or null. `unit` is what the note said, or null when it didn't. */
export function platesFactorOf(note) {
  const m = PLATE_FACTOR_RE.exec(String(note || ''))
  if (!m) return null
  const per = Number(m[1].replace(',', '.'))
  return per > 0 ? { per_plate: per, unit: m[2] ? m[2].toLowerCase() : null } : null
}

/* ---------- gym on the note ---------- */

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `"<gym> · <note>"`, or just the gym, or just the note — what History shows. */
export function noteWithGym(gym, note) {
  const g = String(gym || '').trim(), n = String(note || '').trim()
  if (!g) return n
  return n ? `${g} · ${n}` : g
}
/** The note without a `"<gym> · "` prefix, for a rewrite when the gym changes. */
export function noteWithoutGym(gym, note) {
  const g = String(gym || '').trim(), n = String(note || '').trim()
  if (!g || !n) return n
  return n.replace(new RegExp('^' + esc(g) + '(?:\\s*·\\s*|$)', 'i'), '').trim()
}

/* ---------- set rows and entries ---------- */

// One tool-level set object → the row a finished workout stores. Only the keys given are written,
// so a reps set has no `sec`, the way the app's rows are. `plates` is turned into a weight here
// when the exercise note carries the factor; otherwise the row stores no weight and the caller
// gets a warning.
export function rowOf(set, { factor, unit, exName }, warnings) {
  if (set.plates != null && set.w != null) throw coded('EINVAL', `${exName}: give w or plates for a set, not both`)
  if (set.rir != null && set.rpe != null) throw coded('EINVAL', `${exName}: give rir or rpe for a set, not both`)
  if (!(num(set.r) > 0 || num(set.sec) > 0 || num(set.min) > 0)) throw coded('EINVAL', `${exName}: a set needs reps (r), seconds (sec) or minutes (min) above zero`)
  const row = { done: true }
  const notes = []
  if (set.plates != null) {
    if (factor && (!factor.unit || factor.unit === unit)) {
      row.w = Math.round(set.plates * factor.per_plate * 100) / 100
      notes.push(`${set.plates} placas`)
    } else {
      notes.push(`${set.plates} placas (fator desconhecido)`)
      warnings.push(`${exName}: plates logged without a ${unit} factor — set it with set_exercise_note('${exName}', '1 placa = X ${unit}') and update_workout`)
    }
  } else if (set.w != null) row.w = num(set.w)
  if (set.r != null) row.r = Math.round(num(set.r))
  if (set.sec != null) row.sec = Math.round(num(set.sec))
  if (set.min != null) row.min = num(set.min)
  if (set.speed != null) row.speed = num(set.speed)
  if (set.rir != null) row.rir = num(set.rir)
  if (set.rpe != null) row.rpe = num(set.rpe)
  if (set.failure === true) row.failure = true
  if (set.warmup === true) row.phase = 'warmup'
  const note = [String(set.note || '').trim(), ...notes].filter(Boolean).join(' · ')
  if (note) row.note = note.slice(0, NOTE_MAX)
  return row
}

// The target an entry is judged and labelled by: the routine's own cfg for the exercise when the
// session is linked to one (as buildPlannedEntry stores it, id left out), else derived from the
// rows so modeOf() labels them right.
function targetOf(cfg, rows) {
  if (cfg) { const { id, ...rest } = cfg; return rest }
  const work = rows.filter(s => !isWarmupRow(s))
  const n = Math.max(1, work.length || rows.length)
  const first = work[0] || rows[0] || {}
  if (first.min != null) return { sets: n, min: num(first.min), speed: num(first.speed), mode: 'cardio' }
  if (first.sec != null && first.r == null) return { sets: n, sec: num(first.sec), mode: 'time' }
  return { sets: n, reps: Math.round(num(first.r)), mode: 'reps' }
}

/**
 * Entries for a draft from the tool's `exercises` list (already resolved: each has `ex`, the
 * catalogue or custom object). `routine` links a cfg per exercise when it holds one.
 */
export function entriesOf(S, exercises, routine, ctx, warnings = []) {
  const unit = ctx.unit || S.unit || 'kg'
  return exercises.map(x => {
    const ex = x.ex
    const factor = platesFactorOf((S.exNotes || {})[ex.id])
    const rows = list(x.sets).map(s => rowOf(s, { factor, unit, exName: ex.n }, warnings))
    const cfg = routine ? list(routine.ex).find(c => c && c.id === ex.id) : null
    const entry = { id: ex.id, sets: rows, target: targetOf(cfg, rows) }
    if (routine && cfg) entry.rid = routine.id
    const note = String(x.note || '').trim()
    if (note) { entry.note = note.slice(0, NOTE_MAX); if (x.note_pin === true) entry.notePin = true }
    return entry
  })
}

/* ---------- the draft a finish path consumes ---------- */

/**
 * An active-shaped draft from a log_workout-style argument object whose exercises are resolved
 * (`{ ex, sets, note, note_pin }`) and whose routine, if any, is the routine object.
 */
export function draftOf(S, args, ctx, warnings = []) {
  const date = args.date || ctx.todayIso
  const past = date !== ctx.todayIso
  const start = args.start ? backfillStart(date, args.start)
    : past ? backfillStart(date, '18:00')
      : ctx.now - Math.min(1440, Math.max(1, Math.round(num(args.duration_min) || 60))) * 60000
  // Today with a start and no length: the session ran from that start until now ("comecei às
  // 18:50" said at 19:00 is a ten-minute session, not an hour that ends in the future). A start
  // still ahead of the clock is a mistake to report, not a session to file.
  if (!past && args.start && start > ctx.now) throw coded('EINVAL', `start ${args.start} is later than now — the session cannot have started yet`)
  const durationMin = args.duration_min != null ? Math.min(1440, Math.max(1, Math.round(num(args.duration_min))))
    : !past && args.start ? Math.max(1, Math.round((ctx.now - start) / 60000))
      : 60
  const routine = args.routine || null
  const entries = entriesOf(S, args.exercises, routine, ctx, warnings)
  const name = String(args.name || '').trim().slice(0, NAME_MAX) || (routine ? deriveSessionName([routine.name]) : null) || 'Workout'
  const gym = String(args.gym || '').trim().slice(0, GYM_MAX)
  const bw = list(S.bodyweight).length ? S.bodyweight[S.bodyweight.length - 1].w : null
  const draft = {
    id: uid(), d: date, start, routineIds: routine ? [routine.id] : [], routineId: routine ? routine.id : null,
    name, bw, cur: 0, entries
  }
  const note = noteWithGym(gym, String(args.note || '').trim().slice(0, NOTE_MAX))
  if (note) draft.note = note
  if (gym) draft.gym = gym
  if (past) draft.backfill = { durationMin, replaceId: null }
  else draft.end = start + durationMin * 60000
  // A start the caller named places the record by time; without one it is the session that just
  // ended, appended like the app's own. The flag is the draft's only — buildCompletedWorkout
  // writes none of it onto the record.
  if (args.start) draft.placed = true
  return draft
}

// Custom exercises carry their muscle model onto the record, as the finish sheet does, so a
// custom deleted later still counts for the muscle map.
const snapshotFor = S => e => {
  const custom = list(S.customEx).find(c => c && c.id === e.id)
  return custom && isCustomEx(custom) ? exerciseMuscleSnapshot(custom) : null
}

/**
 * Files a draft as a finished workout, exactly the way doFinishWorkout (sheets.jsx) does: the
 * live path for today (badges against the whole history, kept weights raised, rotation refilled),
 * the backfill path for a past date (filed in order, stamped, badges rebuilt, kept weights left
 * alone). Returns { workout, prs, e1rm_records } — `workout` is the stored record.
 */
export function logWorkout(S, draft, ctx) {
  const now = ctx.now
  const past = !!draft.backfill
  // Already filed: a finish whose push landed but whose session file survived (the process
  // died in between) is retried with the same draft id. The record is answered, not doubled —
  // two workouts under one id would be merged into one on a device and deleted together.
  const already = list(S.workouts).find(x => x && x.id === draft.id)
  if (already) return { workout: already, prs: [...(already.prs || [])], e1rm_records: [], already_saved: true }
  // The app's own guard on a logged session (workout-date.js endsInFuture): a start and a length
  // that put the end ahead of the clock describe a session still going on. One minute of grace,
  // since a live finish is filed as at least a minute long.
  const end = past ? backfillEnd(draft) : draft.end
  if (end > now + 60000) throw coded('EINVAL', `the session would end in the future (${new Date(end).toISOString()} with the start and duration given) — check start and duration_min`)
  const prs = []
  const e1prs = []
  if (!past) {
    for (const e of draft.entries) {
      const loads = e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w).filter(w => w > 0)
      const mx = loads.length ? loads.reduce((a, b) => betterWeight(e.id, a, b)) : 0
      if (mx > 0 && beatsWeight(e.id, mx, bestWeightFor(S, e.id, entryDbLoad(e)))) prs.push(e.id)
      const rec = is1RMRecord(S, e.id, e)
      if (rec && !prs.includes(e.id)) e1prs.push({ id: e.id, est: rec.est, prev: rec.prev, w: rec.w, r: rec.r })
    }
  }
  const w = buildCompletedWorkout(draft, { end: past ? backfillEnd(draft) : draft.end, prs, snapshotFor: snapshotFor(S) })
  if (!w.entries.length) throw coded('EINVAL', 'nothing to log: no set carries completed work')
  if (draft.gym) w.gym = draft.gym
  w.vol = workoutVolume(w)
  if (past) {
    stampWorkout(w, now)
    const touched = [...new Set(w.entries.map(e => e.id))]
    S.workouts = rebuildPrHistory(completeBackfill(list(S.workouts), draft, w, now), touched, w)
    const saved = S.workouts.find(x => x.id === w.id) || w
    return { workout: saved, prs: [...(saved.prs || [])], e1rm_records: [] }
  }
  S.exWeights = S.exWeights || {}
  for (const e of w.entries) {
    const mx = bestWeightForEntry(e)
    if (mx > 0 && beatsWeight(e.id, mx, (S.exWeights[e.id] || {}).w || 0)) S.exWeights[e.id] = { w: mx, d: w.d }
  }
  S.workouts = draft.placed ? insertChronological(list(S.workouts), w) : [...list(S.workouts), w]
  refillAfter(S, w, ctx.todayIso, now)
  return { workout: w, prs, e1rm_records: e1prs }
}

/** The stored workout `id` names, or ENOENT. */
export function findWorkout(S, id) {
  const w = list(S.workouts).find(x => x && (x.id === id || sameWorkout(x, { id })))
  if (!w) throw coded('ENOENT', `no workout with id ${JSON.stringify(id)} — list_workouts shows the ids`)
  return w
}

/**
 * Edits a saved workout through the app's own editor: a copy opens as S.active, the given fields
 * replace the draft's, saveWorkoutEdit stamps it, rebuilds the badges and lowers a kept weight the
 * edit took away. `args.exercises`, when given, is already resolved (as for draftOf) and replaces
 * every exercise and set. Date / start / duration go through moveWorkout / setWorkoutDuration
 * after the save, as WorkoutDetail does. Returns { workout, changed }.
 */
export function updateWorkout(S, args, ctx) {
  const now = ctx.now
  const current = findWorkout(S, args.workout_id)
  const changed = []
  const warnings = args.warnings || []
  warnings.length = 0   // a 409 retry runs this again; the warnings are this attempt's only
  if (S.active) throw coded('EINVAL', 'a session is open on this document; finish it first')
  let active
  try { active = editCompletedSession(S, current) } catch (e) { throw coded('ENOENT', e.message) }
  // From here on the editor is open on S.active; a refusal below must close it, or the document
  // the next mutation reads would carry a draft the server strips anyway.
  try {
    if (args.exercises) {
      const routine = list(S.routines).find(r => r && current.routineId && r.id === current.routineId) || null
      active.entries = entriesOf(S, args.exercises, routine, ctx, warnings)
      changed.push('exercises')
    }
  } catch (e) { S.active = null; throw e }
  const oldGym = String(current.gym || '').trim()
  const gym = args.gym !== undefined ? String(args.gym || '').trim().slice(0, GYM_MAX) : oldGym
  if (args.gym !== undefined && gym !== oldGym) changed.push('gym')
  if (args.note !== undefined || (args.gym !== undefined && gym !== oldGym)) {
    const bare = args.note !== undefined ? String(args.note || '').trim().slice(0, NOTE_MAX) : noteWithoutGym(oldGym, current.note)
    const note = noteWithGym(gym, bare)
    if (note) active.note = note; else delete active.note
    if (args.note !== undefined) changed.push('note')
  }
  if (args.name !== undefined) { const n = String(args.name || '').trim().slice(0, NAME_MAX); if (n) { active.name = n; changed.push('name') } }
  let saved
  try { saved = saveWorkoutEdit(S, now) } catch (e) {
    S.active = null
    throw coded(/deleted/i.test(e.message) ? 'ENOENT' : 'EINVAL', /Nothing logged/i.test(e.message) ? 'the edit leaves no completed set — use delete_workout instead' : e.message)
  }
  // saveWorkoutEdit spreads the stored record under the draft, so `gym` carries; a change is
  // written on the saved record (already stamped by the save).
  const idx = S.workouts.findIndex(x => sameWorkout(x, saved))
  if (gym !== oldGym) {
    const rec = { ...S.workouts[idx] }
    if (gym) rec.gym = gym; else delete rec.gym
    stampWorkout(rec, now)
    S.workouts[idx] = rec
  }
  let ref = S.workouts[idx]
  if (args.date !== undefined || args.start !== undefined) {
    const iso = args.date || ref.d
    const time = args.start || hhmmOf(ref.start)
    const moved = moveWorkout(S.workouts, ref, iso, time, now)
    if (moved) {
      S.workouts = moved; ref = S.workouts.find(x => sameWorkout(x, saved))
      // `changed` names the input fields, as the description promises.
      if (args.date !== undefined) changed.push('date')
      if (args.start !== undefined) changed.push('start')
    }
  }
  if (args.duration_min !== undefined) {
    const next = setWorkoutDuration(S.workouts, ref, args.duration_min, now)
    if (next) { S.workouts = next; ref = S.workouts.find(x => sameWorkout(x, saved)); changed.push('duration_min') }
  }
  return { workout: ref, changed, warnings }
}

const hhmmOf = ms => { const d = new Date(ms || 0); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

/** Deletes a saved workout the way the editor's delete does (kept weights lowered). */
export function deleteWorkout(S, id) {
  const current = findWorkout(S, id)
  if (S.active) throw coded('EINVAL', 'a session is open on this document; finish it first')
  editCompletedSession(S, current)
  deleteEditedWorkout(S)
  return { id: current.id, date: current.d, name: current.name || null, gym: current.gym || null }
}

/** A weigh-in for `date` (today by default): replaces the day's entry or appends one, kept by day. */
export function addBodyweight(S, { weight, date }, ctx) {
  const w = num(weight)
  if (!(w > 0)) throw coded('EINVAL', 'weight must be a positive number in the profile unit')
  const d = date || ctx.todayIso
  S.bodyweight = list(S.bodyweight).filter(b => b && typeof b === 'object')
  const before = S.bodyweight.filter(b => b.d < d).sort((a, b) => (a.d || '').localeCompare(b.d || ''))
  const previous = before.length ? before[before.length - 1] : null
  const same = S.bodyweight.find(b => b.d === d)
  const val = Math.round(w * 10) / 10
  if (same) { same.w = val; same.t = ctx.now } else S.bodyweight.push({ d, w: val, t: ctx.now })
  S.bodyweight.sort((a, b) => (a.d || '').localeCompare(b.d || ''))
  return {
    entry: { date: d, weight: val },
    previous: previous ? { date: previous.d, weight: previous.w } : null,
    delta: previous ? Math.round((val - previous.w) * 10) / 10 : null,
    replaced: !!same
  }
}

/** The standing note of an exercise (`S.exNotes[id]`); an empty note clears it. */
export function setExerciseNote(S, { id, note }) {
  const text = String(note || '').trim().slice(0, NOTE_MAX)
  S.exNotes = S.exNotes && typeof S.exNotes === 'object' ? S.exNotes : {}
  if (text) S.exNotes[id] = text; else delete S.exNotes[id]
  return { note: text || null, plates_factor: platesFactorOf(text) }
}

/* ---------- routines ---------- */

// One tool-level exercise → the cfg a routine stores. `mode` is the exercise's own unless the
// numbers say otherwise (seconds → time, minutes → cardio); a rep range is stored as its top
// (`reps`) and bottom (`repsMin`), the way the editor does (rep-range.js).
function cfgOf(x, { creating = true } = {}) {
  const ex = x.ex
  const cfg = { id: ex.id, sets: Math.max(1, Math.min(20, Math.round(num(x.sets) || 3))) }
  const mode = x.sec != null ? 'time' : x.min != null ? 'cardio' : modeOf({ id: ex.id })
  if (mode === 'time') { cfg.mode = 'time'; cfg.sec = Math.max(1, Math.round(num(x.sec) || 45)) }
  else if (mode === 'cardio') { cfg.mode = 'cardio'; cfg.min = Math.max(1, num(x.min) || 20); if (x.speed != null) cfg.speed = num(x.speed) }
  else {
    const top = x.reps_max != null ? x.reps_max : x.reps
    if (x.reps_min != null && top != null) Object.assign(cfg, normalizeRepRange(top, x.reps_min))
    else cfg.reps = Math.max(1, Math.round(num(top) || 10))
    if (x.reps_max != null && x.reps_min == null && x.reps != null && x.reps < x.reps_max) Object.assign(cfg, normalizeRepRange(x.reps_max, x.reps))
  }
  if (x.weight != null) cfg.weight = num(x.weight)
  else if (mode === 'reps' && creating) cfg.weight = 0   // an update keeps the stored weight
  if (x.rest_sec != null) cfg.restSec = Math.max(0, Math.round(num(x.rest_sec)))
  if (x.superset_group != null && String(x.superset_group).trim()) cfg.sg = 'sg-' + String(x.superset_group).trim()
  if (x.progression) cfg.prog = x.progression
  return cfg
}

/**
 * Creates, updates or removes a routine. `args.routine` is the resolved routine object (null to
 * create); `args.exercises`, when given, is resolved (`{ ex, … }`) and replaces the list in that
 * order. Returns { routine, action }.
 */
export function editRoutine(S, args, ctx) {
  S.routines = list(S.routines).filter(r => r && typeof r === 'object')
  if (args.remove) {
    if (!args.routine) throw coded('ENOENT', 'name the routine to remove')
    const r = args.routine
    deleteRoutine(S, r.id)
    return { routine: r, action: 'deleted' }
  }
  if (!args.routine) {
    const name = String(args.name || '').trim().slice(0, NAME_MAX)
    if (!name) throw coded('EINVAL', 'a name is required to create a routine')
    if (!list(args.exercises).length) throw coded('EINVAL', 'at least one exercise is required to create a routine')
    const r = { id: uid(), name, ex: args.exercises.map(cfgOf) }
    if (args.emoji) r.emoji = String(args.emoji).slice(0, 8)
    if (args.progression) r.prog = args.progression
    S.routines.push(r)
    return { routine: r, action: 'created' }
  }
  const idx = S.routines.findIndex(r => r.id === args.routine.id)
  if (idx < 0) throw coded('ENOENT', 'that routine is no longer on the profile')
  const r = { ...S.routines[idx] }
  if (args.name !== undefined) { const n = String(args.name || '').trim().slice(0, NAME_MAX); if (n) r.name = n }
  if (args.emoji !== undefined) { if (args.emoji) r.emoji = String(args.emoji).slice(0, 8); else delete r.emoji }
  if (args.progression !== undefined) { if (args.progression) r.prog = args.progression; else delete r.prog }
  if (args.exercises) {
    if (!args.exercises.length) throw coded('EINVAL', 'a routine needs at least one exercise — use remove: true to delete it')
    // A slot kept for the same exercise keeps what the editor stored beyond what the tool knows
    // (pyramid, deload factor, increment, weight…); the fields given move. What the given numbers
    // say about the slot's shape wins over what it had: `reps` alone clears a stored rep range,
    // and a slot moved to another mode (sec → timed, min → cardio, reps → reps) drops the other
    // modes' numbers rather than carrying them beside the new ones.
    const old = list(r.ex)
    r.ex = args.exercises.map(x => {
      const cfg = cfgOf(x, { creating: false })
      const prev = old.find(c => c && c.id === cfg.id)
      if (!prev) return cfg
      const kept = { ...prev }
      for (const k of ['mode', 'reps', 'repsMin', 'repsMax', 'sec', 'min', 'speed']) delete kept[k]
      return { ...kept, ...cfg }
    })
  }
  S.routines[idx] = r
  return { routine: r, action: 'updated' }
}
