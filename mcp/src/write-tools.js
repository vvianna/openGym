/* The write tools (docs/dev/MCP_WRITE.md, "Tool catalogue"). Each handler resolves names,
   validates what zod cannot, runs one pure mutation through state.mutate() and reads its own
   write back from the pushed document — so "did it save?" is answered by the server's copy, with
   its id and revision. Descriptions are written for the LLM that will call them: when to use the
   tool, when not to, what to call first, units, formats and the error codes it can return.

   Error codes: ENOENT not found · EINVAL bad input · EAMBIG ambiguous name (with candidates) ·
   EPERM writes unavailable in file mode · EAUTH token refused · ECONFLICT concurrent write ·
   ENET unreachable · EIO server or file fault. */
import { z } from 'zod'
import { getState, mutate, writesEnabled, getMode } from './state.js'
import { isoDate, hhmm, coded } from './schema.js'
import { setLabel, friendlyDuration } from './labels.js'
import { getRoutine } from './tools.js'
import { findExercise, findExercises, resolveRoutine, exerciseRow, nameLangOf, BODYPARTS } from './exercise-search.js'
import {
  draftOf, entriesOf, logWorkout, updateWorkout, deleteWorkout, addBodyweight, setExerciseNote, editRoutine,
  platesFactorOf, findWorkout, GYM_MAX, NAME_MAX
} from './mutations.js'
import { loadSession, resolvedUid } from './session.js'
import { exerciseHistory } from '../../frontend/src/lib/exercise-history.js'
import { best1RM, formulaOf } from '../../frontend/src/lib/onerm.js'
import { bestWeightFor, exNoteFor, pinnedNoteFor, modeOf, workoutVolume, setsDone, NOTE_MAX } from '../../frontend/src/lib/history.js'
import { isFailureSet, isWarmupRow } from '../../frontend/src/lib/workout-model.js'
import { exOr } from '../../frontend/src/lib/exercises.js'

/* ---------- shared pieces ---------- */

const ERRORS = 'Errors: ENOENT (not found), EINVAL (bad input), EAMBIG (ambiguous name — the error lists candidates; ask the user or pick, never guess), EPERM (writes need remote mode: OPENGYM_URL + OPENGYM_TOKEN), EAUTH (token refused — pair again), ECONFLICT (another device wrote at the same moment — retry once), ENET (server unreachable), EIO (server fault).'

const noState = () => coded('ENOENT', 'no state for this profile yet — sign in on a device once, or log something: the first write creates the document')
const needsWrites = label => { if (!writesEnabled()) throw coded('EPERM', `${label}: writes need remote mode — set OPENGYM_URL and OPENGYM_TOKEN (file mode can only read; the openGym api is the only writer of the state file)`) }
// A profile that never synced from a device has no document; a write creates it from the app's
// defaults (PUT /api/data accepts that), and says so, since the unit it chose is the default.
const CREATED = 'this profile had no synced document yet; the write created it with the app\'s defaults (unit kg) — the phone adopts it on its next sync'
const createdWarning = (out, warnings) => { if (out.created) warnings.push(CREATED); return warnings }
// The document the resolvers read before a write: the cache, or nothing yet (a profile with no
// document resolves against the catalogue alone).
const current = () => getState() || {}

// The set schema every exercise list shares: one row = one set, only the fields that apply.
const setSchema = () => z.object({
  w: z.number().min(0).optional().describe('Load in the profile unit (kg or lb; see get_capabilities), the TOTAL on the bar or stack. Omit for body-weight work.'),
  plates: z.number().int().min(1).optional().describe('Stack plates instead of w, for a machine counted in plates. Needs the exercise note to say "1 placa = X kg" (set_exercise_note); otherwise the set is stored without a weight and a warning comes back. Not together with w.'),
  r: z.number().int().min(0).optional().describe('Reps completed.'),
  sec: z.number().int().min(0).optional().describe('Seconds held, for a timed set (plank, hang).'),
  min: z.number().min(0).optional().describe('Minutes, for cardio.'),
  speed: z.number().min(0).optional().describe('km/h, for cardio (stored in km/h whatever the display unit).'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve (0 = failure). Not together with rpe.'),
  rpe: z.number().min(1).max(10).optional().describe('RPE 1–10. Not together with rir.'),
  failure: z.boolean().optional().describe('true when the set was taken to failure.'),
  warmup: z.boolean().optional().describe('true for a warm-up row: it is kept but excluded from volume, records and progression.'),
  note: z.string().max(NOTE_MAX).optional().describe('A note on this one set.')
}).strict()

const exerciseSchema = () => z.object({
  exercise: z.string().min(1).describe('Exercise id (preferred — from search_exercises) or a name in English or the profile language. An ambiguous name fails with EAMBIG.'),
  note: z.string().max(NOTE_MAX).optional().describe('Note on this exercise for this session (grip, machine, variation — "pegada aberta, máquina 3").'),
  note_pin: z.boolean().optional().describe('true to show this note again the next time the exercise comes up.'),
  sets: z.array(setSchema()).min(1).describe('The sets in order. Each needs r, sec or min.')
}).strict()

const routineExerciseSchema = () => z.object({
  exercise: z.string().min(1).describe('Exercise id (from search_exercises) or a name; EAMBIG when ambiguous.'),
  sets: z.number().int().min(1).max(20).optional().describe('Planned sets (default 3).'),
  reps: z.number().int().min(1).optional().describe('Planned reps per set (default 10). With reps_min this is the top of the range.'),
  reps_min: z.number().int().min(1).optional().describe('Bottom of a rep range for double progression (e.g. 8 with reps 12 = "8–12").'),
  reps_max: z.number().int().min(1).optional().describe('Top of a rep range; same as reps when both given.'),
  sec: z.number().int().min(1).optional().describe('Seconds per set for a timed exercise (makes it a timed slot).'),
  min: z.number().min(1).optional().describe('Minutes for a cardio slot.'),
  speed: z.number().min(0).optional().describe('km/h for a cardio slot.'),
  weight: z.number().min(0).optional().describe('Starting weight in the profile unit; the progression policy moves it from there.'),
  rest_sec: z.number().int().min(0).optional().describe('Rest after each set in seconds; omit to use the profile\'s rest timer.'),
  superset_group: z.string().max(20).optional().describe('Adjacent exercises with the same group label are a superset (e.g. "A" on two neighbours).')
}).strict()

// Resolve every exercise of a list up front, so a bad name fails before anything is written.
async function resolveAll(S, exercises) {
  const out = []
  for (const x of exercises) out.push({ ...x, ex: await findExercise(S, x.exercise) })
  return out
}

// A set row as the LLM reads it back — the same shape get_workout's entries use.
export function rowView(e, s) {
  const cfg = { ...(e.target || {}), id: e.id }
  return {
    done: !!s.done,
    label: setLabel(e.id, { ...s, done: undefined }, cfg),
    ...(isWarmupRow(s) ? { warmup: true } : {}),
    ...(isFailureSet(s) ? { failure: true } : {}),
    w: Number(s.w) || 0, r: Number(s.r) || 0, sec: Number(s.sec) || 0, min: Number(s.min) || 0, speed: Number(s.speed) || 0,
    ...(s.rir != null ? { rir: s.rir } : {}), ...(s.rpe != null ? { rpe: s.rpe } : {}),
    ...(s.note ? { note: s.note } : {})
  }
}

const nameOf = (S, id) => { const c = (S.customEx || []).find(x => x && x.id === id); return c ? c.n : exOr(id).n }

// One stored entry as the LLM reads it back: get_workout's shape plus the notes and effort
// ratings a write carries, so what was sent can be checked against what was stored.
export function entryView(S, e) {
  const custom = (S.customEx || []).find(x => x && x.id === e.id)
  const ex = custom || exOr(e.id)
  return {
    id: e.id,
    name: ex.n,
    body_part: ex.bp || null,
    mode: modeOf({ ...(e.target || {}), id: e.id }),
    target: e.target || null,
    ...(e.note ? { note: e.note, note_pin: e.notePin === true } : {}),
    sets: (e.sets || []).map(s => rowView(e, s))
  }
}

// What every workout write answers with: the record read back from the pushed document (the
// stored record, re-found by id in the state the server accepted).
export function workoutResult(S, w, { prs = [], e1rm = [], warnings = [], rev, extra = {} } = {}) {
  const stored = findWorkout(S, w.id)
  return {
    ok: true,
    workout_id: w.id,
    date: w.d,
    name: w.name || null,
    gym: w.gym || null,
    unit: S.unit || 'kg',
    volume: workoutVolume(w),
    sets_done: setsDone(w),
    duration: w.end && w.start ? friendlyDuration(w.end - w.start) : null,
    note: w.note || null,
    prs: prs.map(id => nameOf(S, id)),
    e1rm_records: e1rm.map(r => ({ exercise: nameOf(S, r.id), est: Math.round(r.est * 10) / 10, prev: Math.round(r.prev * 10) / 10, w: r.w, r: r.r })),
    exercises: (stored.entries || []).map(e => entryView(S, e)),
    warnings,
    rev,
    ...extra
  }
}

const openSessionGuard = async () => {
  const s = loadSession(await resolvedUid())
  if (s) throw coded('EINVAL', `a live session started ${s.started_at || 'earlier'}${s.name ? ` ("${s.name}")` : ''} is open — finish_workout or discard_workout it first, or log its sets with log_set`)
}

/* ---------- search_exercises ---------- */

export const searchExercisesTool = {
  name: 'search_exercises',
  description: `Find exercises by name — in English, in the profile's language (e.g. Portuguese: "supino", "voador") or by id — across the 1,300+ built-in exercises and the profile's custom ones. CALL THIS FIRST whenever the user names an exercise in their own words, before log_workout, update_workout, last_performance, set_exercise_note or edit_routine: those tools accept names but fail with EAMBIG when several exercises match, and they never guess. Returns the best matches first with id, English name, localized name, body part, equipment and target muscle; pass the id on. Not for listing what a routine contains (get_routine) or what was trained (list_workouts). Read-only, works in every mode.`,
  schema: {
    query: z.string().min(1).describe('Name or part of it, any language the profile uses, or an exact exercise id.'),
    body_part: z.enum(BODYPARTS).optional().describe('Narrow to a body part (catalogue values, e.g. "chest", "upper legs", "back").'),
    equipment: z.string().optional().describe('Narrow to an equipment value (e.g. "barbell", "dumbbell", "cable", "leverage machine", "body weight").'),
    limit: z.number().int().min(1).max(25).optional().describe('Max results, default 8.')
  },
  handler: async ({ query, body_part, equipment, limit }) => {
    const S = current()
    const { exercises, fallback } = await findExercises(S, query, { bodyPart: body_part || null, equipment: equipment || null, limit: limit || 8 })
    return {
      query, lang: nameLangOf(S) || 'en', count: exercises.length,
      // Every language's names are searched; a hit that came through another language's name
      // carries `name_matched`, and the flag says the top one did.
      ...(fallback ? { matched_other_language: true } : {}),
      exercises
    }
  }
}

/* ---------- log_workout ---------- */

export const logWorkoutTool = {
  name: 'log_workout',
  description: `Save a FINISHED workout in one call — the primary way to record training: today's session or a past day, with every exercise and set. Use it when the user reports a session they have done ("fiz supino 3×10 com 60 kg e remada 4×8 com 50"). Do NOT use it while a live session started with start_workout is open (finish_workout or discard_workout first; the tool refuses with EINVAL). Resolve exercise names with search_exercises first; a name that matches several exercises fails with EAMBIG. Weights are the profile unit (see get_capabilities), totals on the bar or stack; dates YYYY-MM-DD; times HH:MM. Pass gym when the user says where they trained — it is stored on the workout and shown at the start of its note, and last_performance can filter by it. A past date is filed into history the way the app logs a past workout (badges rebuilt, kept weights untouched); today's is filed like a live session (PRs awarded, kept weights raised, the routine's progression advanced). Returns the record read back from the server: workout_id, volume, PRs, each exercise's sets, and warnings (e.g. a set given in plates with no kg factor on the exercise note). Relay workout_id and the numbers to the user. Requires remote mode (EPERM otherwise). ${ERRORS}`,
  schema: {
    date: isoDate().optional().describe('YYYY-MM-DD. Default today.'),
    routine: z.string().optional().describe('Routine id or name to link the session to (names it and feeds its progression). Omit for a freestyle session.'),
    name: z.string().max(NAME_MAX).optional().describe('Session name. Default: the routine\'s name, else "Workout".'),
    gym: z.string().max(GYM_MAX).optional().describe('Where it was done, free text ("Iron", "Smart Fit Penha"). Keep the spelling consistent; get_capabilities lists gyms already on record.'),
    start: hhmm().optional().describe('Local start time HH:MM. Default: now minus the duration (today), or 18:00 (a past date).'),
    duration_min: z.number().int().min(1).max(1440).optional().describe('Length in minutes. Default 60.'),
    note: z.string().max(NOTE_MAX).optional().describe('Session note ("ombro incomodou").'),
    exercises: z.array(exerciseSchema()).min(1).describe('The exercises in the order they were done, each with its sets.')
  },
  handler: async (args) => {
    needsWrites('log_workout')
    await openSessionGuard()
    const S0 = current()
    const exercises = await resolveAll(S0, args.exercises)
    const routine = args.routine ? resolveRoutine(S0, args.routine) : null
    const warnings = []
    const out = await mutate((S, ctx) => {
      warnings.length = 0   // a 409 retry runs this again; the warnings are this attempt's only
      const draft = draftOf(S, { ...args, exercises, routine }, ctx, warnings)
      return logWorkout(S, draft, ctx)
    }, { label: 'log_workout' })
    const { state, result, rev } = out
    return workoutResult(state, result.workout, { prs: result.prs, e1rm: result.e1rm_records, warnings: createdWarning(out, warnings), rev })
  }
}

/* ---------- update_workout ---------- */

export const updateWorkoutTool = {
  name: 'update_workout',
  description: `Correct a workout that is already saved: a set's weight or reps, a missing or extra set, the note, the name, the gym, the date, the start time or the duration ("na verdade foram 65 kg", "foram duas séries"). Find the id with list_workouts or get_workout first. \`exercises\`, when given, REPLACES every exercise and set of the workout — send the full corrected list, not just the changed set (read get_workout, apply the correction, send it all back). Not for a live session that is still open (use edit_set / delete_set). An edit that leaves no completed set is refused (EINVAL) — use delete_workout. Returns the corrected record read back from the server, plus \`changed\`. Requires remote mode. ${ERRORS}`,
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts / get_workout / log_workout.'),
    exercises: z.array(exerciseSchema()).min(1).optional().describe('The complete corrected exercise list; replaces all exercises and sets.'),
    note: z.string().max(NOTE_MAX).optional().describe('New session note ("" clears it). The gym prefix is kept automatically.'),
    name: z.string().max(NAME_MAX).optional().describe('New session name.'),
    gym: z.string().max(GYM_MAX).optional().describe('New gym ("" clears it); the note prefix follows.'),
    date: isoDate().optional().describe('Move the workout to this date (YYYY-MM-DD).'),
    start: hhmm().optional().describe('New local start time HH:MM.'),
    duration_min: z.number().int().min(1).max(1440).optional().describe('New length in minutes.')
  },
  handler: async (args) => {
    needsWrites('update_workout')
    const S0 = getState()
    if (!S0) throw noState()   // nothing to correct on a profile with no document
    const fields = ['exercises', 'note', 'name', 'gym', 'date', 'start', 'duration_min'].filter(k => args[k] !== undefined)
    if (!fields.length) throw coded('EINVAL', 'nothing to change: give at least one of exercises, note, name, gym, date, start, duration_min')
    findWorkout(S0, args.workout_id)
    const exercises = args.exercises ? await resolveAll(S0, args.exercises) : undefined
    const warnings = []
    const { state, result, rev } = await mutate((S, ctx) => updateWorkout(S, { ...args, exercises, warnings }, ctx), { label: 'update_workout' })
    return workoutResult(state, result.workout, { prs: result.workout.prs || [], warnings, rev, extra: { changed: result.changed } })
  }
}

/* ---------- delete_workout ---------- */

export const deleteWorkoutTool = {
  name: 'delete_workout',
  description: `Delete a saved workout for good (a duplicate, a session logged by mistake). ASK THE USER before calling this and pass confirm: true. Find the id with list_workouts. A kept working weight that came only from this workout is lowered, as the app does. Every device picks the removal up on its next sync. Requires remote mode. ${ERRORS}`,
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts.'),
    confirm: z.literal(true).describe('Must be true: the user confirmed the deletion.')
  },
  handler: async ({ workout_id }) => {
    needsWrites('delete_workout')
    const S0 = getState()
    if (!S0) throw noState()
    findWorkout(S0, workout_id)
    const { result, rev } = await mutate(S => deleteWorkout(S, workout_id), { label: 'delete_workout' })
    return { ok: true, deleted: result, rev }
  }
}

/* ---------- last_performance ---------- */

export const lastPerformanceTool = {
  name: 'last_performance',
  description: `What the user did last time on one exercise — "qual foi o último peso no voador?", "last time at Iron" — with the most recent sessions (date, gym, every set), the best weight ever, the best estimated 1RM, the standing exercise note (seat, pin, plate factor) and the last pinned session note. Pass gym to see only sessions logged at that gym (case-insensitive; the gyms on record are listed in gyms_seen). Resolve the exercise with search_exercises if the name is ambiguous (EAMBIG). For what the app would PRESCRIBE next, use preview_session instead. Read-only, works in every mode.`,
  schema: {
    exercise: z.string().min(1).describe('Exercise id (from search_exercises) or a name.'),
    gym: z.string().max(GYM_MAX).optional().describe('Only sessions done at this gym (as logged with log_workout / start_workout).'),
    limit: z.number().int().min(1).max(20).optional().describe('How many sessions, newest first. Default 5.')
  },
  handler: async ({ exercise, gym, limit }) => {
    const S = getState()
    if (!S) throw noState()
    const ex = await findExercise(S, exercise)
    const want = String(gym || '').trim().toLowerCase()
    const byId = new Map((S.workouts || []).map(w => [w.id, w]))
    const all = exerciseHistory(S, ex.id, { limit: 1000 }).sessions
    const filtered = all.filter(s => !want || String(byId.get(s.id)?.gym || '').trim().toLowerCase() === want)
    const sessions = filtered.slice(0, limit || 5).map(s => {
      const w = byId.get(s.id) || {}
      const en = (w.entries || []).find(e => e.id === ex.id) || { id: ex.id, target: s.target }
      return {
        workout_id: s.id, date: s.d, gym: w.gym || null, routine_name: w.name || null,
        sets: s.sets.map(row => rowView({ ...en, target: s.target || en.target }, row)),
        note: en.note || null, volume: s.volume, e1rm: s.e1rm != null ? Math.round(s.e1rm * 10) / 10 : null, pr: !!s.pr
      }
    })
    const bestW = bestWeightFor(S, ex.id)
    const best = best1RM(S, ex.id, formulaOf(S))
    const bestWDate = (() => { for (let i = (S.workouts || []).length - 1; i >= 0; i--) { const w = S.workouts[i]; if ((w.entries || []).some(e => e.id === ex.id && (e.sets || []).some(s => s.done && !isWarmupRow(s) && Number(s.w) === bestW))) return w.d } return null })()
    const pinned = pinnedNoteFor(S, ex.id)
    const gymsSeen = [...new Set((S.workouts || []).filter(w => (w.entries || []).some(e => e.id === ex.id)).map(w => String(w.gym || '').trim()).filter(Boolean))]
    return {
      exercise: exerciseRow(S, ex),
      unit: S.unit || 'kg',
      mode: modeOf({ id: ex.id }),
      exercise_note: exNoteFor(S, ex.id),
      plates_factor: platesFactorOf(exNoteFor(S, ex.id)),
      pinned_note: pinned ? { note: pinned.note, date: pinned.d } : null,
      best_weight: bestW > 0 ? { w: bestW, date: bestWDate } : null,
      best_e1rm: best ? { est: Math.round(best.est * 10) / 10, w: best.w, r: best.r, date: best.d } : null,
      sessions_total: all.length,
      sessions_matching: filtered.length,
      sessions,
      gyms_seen: gymsSeen
    }
  }
}

/* ---------- add_bodyweight ---------- */

export const addBodyweightTool = {
  name: 'add_bodyweight',
  description: `Log a weigh-in: the user's body weight in the profile unit, today or on a given date. A second weigh-in on the same date replaces the first. Returns the entry, the previous weigh-in and the delta, and the distance to the goal weight when one is set. Not for lifting weights (log_workout). Requires remote mode. ${ERRORS}`,
  schema: {
    weight: z.number().positive().describe('Body weight in the profile unit (kg or lb — see get_capabilities).'),
    date: isoDate().optional().describe('YYYY-MM-DD. Default today.')
  },
  handler: async ({ weight, date }) => {
    needsWrites('add_bodyweight')
    const out = await mutate((S, ctx) => addBodyweight(S, { weight, date }, ctx), { label: 'add_bodyweight' })
    const { state, result, rev } = out
    const goal = state.targetW || null
    return { ok: true, unit: state.unit || 'kg', ...result, goal, delta_vs_goal: goal != null ? Math.round((result.entry.weight - goal) * 10) / 10 : null, warnings: createdWarning(out, []), rev }
  }
}

/* ---------- set_exercise_note ---------- */

export const setExerciseNoteTool = {
  name: 'set_exercise_note',
  description: `Set the STANDING note of an exercise — the facts that are true every session: seat and pin settings, the machine, a grip, and the plate factor for a stack counted in plates. The app shows it on the exercise card every time. Plate convention: include "1 placa = 5 kg" (or "1 plate = 10 lb") and from then on sets given as \`plates\` on that exercise are stored with a weight. An empty note clears it. For a note about ONE session's exercise use log_workout's per-exercise note instead. Requires remote mode. ${ERRORS}`,
  schema: {
    exercise: z.string().min(1).describe('Exercise id (from search_exercises) or a name.'),
    note: z.string().max(NOTE_MAX).describe('The note; "" clears it. Up to 500 characters.')
  },
  handler: async ({ exercise, note }) => {
    needsWrites('set_exercise_note')
    const S0 = current()
    const ex = await findExercise(S0, exercise)
    const out = await mutate(S => setExerciseNote(S, { id: ex.id, note }), { label: 'set_exercise_note' })
    const { result, rev } = out
    return { ok: true, exercise: exerciseRow(S0, ex), ...result, warnings: createdWarning(out, []), rev }
  }
}

/* ---------- edit_routine ---------- */

export const editRoutineTool = {
  name: 'edit_routine',
  description: `Create a routine, change one (name, emoji, exercises, order, sets/reps/weight/rest targets, supersets) or delete one. To CHANGE a routine read get_routine first: \`exercises\`, when given, REPLACES the whole list in the order sent. A slot kept for the same exercise keeps the settings this tool does not know (weight when none is sent, increment, pyramid…), but takes the shape the numbers given say: \`reps\` alone clears a stored rep range, and sec / min / reps move the slot to that mode and drop the other modes' numbers. To CREATE, omit \`routine\` and give name + exercises. To DELETE, pass remove: true and confirm: true after asking the user. Not for a one-off change to a session (log_workout / edit_active_workout) and not for what the app will prescribe (preview_session). Resolve exercise names with search_exercises (EAMBIG otherwise). Returns the routine as get_routine shows it. Requires remote mode. ${ERRORS}`,
  schema: {
    routine: z.string().optional().describe('Routine id or name to change or remove. Omit to create a new one.'),
    name: z.string().max(NAME_MAX).optional().describe('Routine name (required when creating).'),
    emoji: z.string().max(8).optional().describe('An emoji for the routine ("" clears it).'),
    exercises: z.array(routineExerciseSchema()).optional().describe('The full exercise list in order (replaces the current one).'),
    remove: z.boolean().optional().describe('true to delete the routine (with confirm: true).'),
    confirm: z.literal(true).optional().describe('Must be true with remove: the user confirmed.')
  },
  handler: async (args) => {
    needsWrites('edit_routine')
    const S0 = current()
    if (args.remove && args.confirm !== true) throw coded('EINVAL', 'deleting a routine needs confirm: true — ask the user first')
    const routine = args.routine ? resolveRoutine(S0, args.routine) : null
    if (!routine && !args.remove && !args.name) throw coded('EINVAL', 'to create a routine give a name (and exercises); to change one give its id or name as `routine`')
    const exercises = args.exercises ? await resolveAll(S0, args.exercises) : undefined
    const out = await mutate(S => editRoutine(S, { ...args, routine, exercises }, {}), { label: 'edit_routine' })
    const { result, rev } = out
    if (result.action === 'deleted') return { ok: true, action: 'deleted', routine: { id: result.routine.id, name: result.routine.name }, rev }
    // The read-back comes from the pushed document, which the cache now holds (state.js mutate).
    return { ok: true, action: result.action, routine: getRoutine.handler({ routine_id: result.routine.id }), warnings: createdWarning(out, []), rev }
  }
}

/* ---------- registration list ---------- */

export const WRITE_TOOLS = [
  searchExercisesTool, logWorkoutTool, updateWorkoutTool, deleteWorkoutTool,
  lastPerformanceTool, addBodyweightTool, setExerciseNoteTool, editRoutineTool
]

export { getMode }
