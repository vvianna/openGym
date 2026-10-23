/* Session tools: the live, set-by-set layer over log_workout (docs/dev/MCP_WRITE.md, "Session
   tools"). The app keeps its running workout device-local (`S.active`, stripped from every PUT),
   so the MCP keeps its own draft in a file (session.js) and only finish_workout turns it into a
   record — through the same logWorkout mutation log_workout uses, so both ways of logging
   produce the same thing. The draft is the shape sheets.jsx's `active` has, built by the app's
   own session builder, so the opening rows carry the policy's prescription exactly as
   preview_session reports it.

   The draft works in both modes (a file-mode server can run a session); finishing needs remote
   mode, and a finish that fails keeps the draft so it can be retried.

   Error codes as write-tools.js, plus: a call that needs an open session and finds none fails
   with ENOENT (the spec's vocabulary has no code of its own for it) and a message that says to
   start_workout first. */
import { z } from 'zod'
import { getState, getUser, mutate, writesEnabled } from './state.js'
import { isoDate, hhmm, coded, localIso } from './schema.js'
import { setLabel } from './labels.js'
import { ensureNames, resolveExercise, resolveRoutine, exerciseRow } from './exercise-search.js'
import { logWorkout, rowOf, platesFactorOf, noteWithGym, GYM_MAX, NAME_MAX } from './mutations.js'
import { rowView, workoutResult } from './write-tools.js'
import { loadSession, saveSession, clearSession } from './session.js'
import { buildSessionEntries, buildPlannedEntry } from '../../frontend/src/lib/session-start.js'
import { registerCustom, exOr } from '../../frontend/src/lib/exercises.js'
import { swapActiveExercise } from '../../frontend/src/lib/active-exercise-swap.js'
import { moveActiveWorkoutEntry } from '../../frontend/src/lib/active-workout-order.js'
import { defaultConfig, freestyleConfig, modeOf, NOTE_MAX } from '../../frontend/src/lib/history.js'
import { backfillStart } from '../../frontend/src/lib/backfill.js'
import { sessionEnd } from '../../frontend/src/lib/finish-workout.js'
import { deriveSessionName } from '../../frontend/src/lib/session-merge.js'
import { uid } from '../../frontend/src/lib/format.js'
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js'

const ERRORS = 'Errors: ENOENT (no open session, or no such exercise/set), EINVAL (bad input), EAMBIG (ambiguous name — candidates listed; ask, never guess), EPERM (finishing needs remote mode), EAUTH, ECONFLICT, ENET, EIO (server; the session is kept).'

const list = v => (Array.isArray(v) ? v : [])
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const user = () => getUser()
const noState = () => coded('ENOENT', 'no state for this profile yet — sign in on a device once so the api has a document to read')

// A custom exercise is only known to the session builder while it is registered in the shared
// index; registered for the length of one synchronous build and taken out again, the way
// preview_session does it (tools.js keeps its copy private, so this one is written once more).
function withCustomsIndexed(S, build) {
  registerCustom(Array.isArray(S.customEx) ? S.customEx : [])
  try { return build() } finally { registerCustom([]) }
}

const nameOf = (S, id) => { const c = list(S.customEx).find(x => x && x.id === id); return c ? c.n : exOr(id).n }
const isDone = s => !!s && s.done === true
const undoneIndex = e => list(e.sets).findIndex(s => !isDone(s))
const doneCount = e => list(e.sets).filter(isDone).length
const draftDone = d => list(d.entries).reduce((n, e) => n + doneCount(e), 0)
const draftTotal = d => list(d.entries).reduce((n, e) => n + list(e.sets).length, 0)

/* ---------- the draft on disk ---------- */

function requireSession() {
  const s = loadSession(user().id)
  if (!s) throw coded('ENOENT', 'no live session is open — start_workout first, or use log_workout for a session that is already over')
  return s
}

function save(s, now) {
  s.updated_at = new Date(now).toISOString()
  return saveSession(user().id, s)
}

// Moves the pointer to the first entry, from `from` on, that still has an undone row; stays on
// `from` when none has (the session is complete, or everything left is freestyle additions).
function advance(s, from) {
  const n = list(s.entries).length
  for (let i = from; i < n; i++) if (undoneIndex(s.entries[i]) >= 0) { s.cur = i; return }
  s.cur = Math.min(from, Math.max(0, n - 1))
}

/* ---------- views ---------- */

function entryRows(S, e) {
  return list(e.sets).map((s, i) => ({ index: i + 1, ...rowView(e, s) }))
}

function nextSetOf(S, e) {
  const i = undoneIndex(e)
  if (i < 0) return null
  const s = e.sets[i]
  return { index: i + 1, label: setLabel(e.id, { ...s, done: undefined }, { ...(e.target || {}), id: e.id }), w: num(s.w), r: num(s.r), sec: num(s.sec), min: num(s.min), ...(isWarmupRow(s) ? { warmup: true } : {}) }
}

function entryOverview(S, e, i, cur) {
  return {
    index: i + 1,
    id: e.id,
    name: nameOf(S, e.id),
    mode: modeOf({ ...(e.target || {}), id: e.id }),
    current: i === cur,
    done_sets: doneCount(e),
    planned_sets: list(e.sets).length,
    complete: undoneIndex(e) < 0,
    ...(e.sg ? { superset_group: e.sg } : {}),
    ...(e.note ? { note: e.note } : {}),
    next_set: nextSetOf(S, e),
    sets: entryRows(S, e)
  }
}

/** The whole open session as the LLM reads it. */
function sessionView(S, s, extra = {}) {
  const cur = Math.min(Math.max(0, num(s.cur)), Math.max(0, list(s.entries).length - 1))
  const curEntry = s.entries[cur] || null
  const done = draftDone(s)
  const total = draftTotal(s)
  return {
    open: true,
    unit: S.unit || 'kg',
    started_at: s.started_at || null,
    date: s.d,
    name: s.name || null,
    gym: s.gym || null,
    routine_id: s.routineId || null,
    note: s.note || null,
    done_sets: done,
    remaining_sets: Math.max(0, total - done),
    complete: total > 0 && done >= total,
    current: curEntry ? { index: cur + 1, id: curEntry.id, exercise: nameOf(S, curEntry.id), next_set: nextSetOf(S, curEntry) } : null,
    exercises: list(s.entries).map((e, i) => entryOverview(S, e, i, cur)),
    ...extra
  }
}

const closedView = { open: false, hint: 'no live session — start_workout opens one; log_workout saves a session that is already over' }

/* ---------- shared set handling ---------- */

// The fields a logged row carries, as the tool-level set object spells them.
const ROW_FIELDS = ['w', 'r', 'sec', 'min', 'speed', 'rir', 'rpe', 'failure', 'note']
const setFields = () => ({
  w: z.number().min(0).optional().describe('Load in the profile unit, the TOTAL on the bar or stack. Omit to keep the planned weight (or for body-weight work).'),
  plates: z.number().int().min(1).optional().describe('Stack plates instead of w; stored as a weight only when the exercise note says "1 placa = X kg" (set_exercise_note), otherwise noted without a weight and a warning comes back. Not with w.'),
  r: z.number().int().min(0).optional().describe('Reps completed. Omit to keep the planned reps.'),
  sec: z.number().int().min(0).optional().describe('Seconds held, for a timed set.'),
  min: z.number().min(0).optional().describe('Minutes, for cardio.'),
  speed: z.number().min(0).optional().describe('km/h, for cardio.'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve (0 = failure). Not with rpe.'),
  rpe: z.number().min(1).max(10).optional().describe('RPE 1–10. Not with rir.'),
  failure: z.boolean().optional().describe('true when the set was taken to failure.'),
  warmup: z.boolean().optional().describe('true for a warm-up row (kept, but outside volume, records and progression).'),
  note: z.string().max(NOTE_MAX).optional().describe('A note on this one set ("pegada aberta").')
})

// The tool-level shape of a stored row, so an edit can start from what the row holds.
function argsOfRow(s) {
  const out = {}
  for (const k of ROW_FIELDS) if (s[k] != null && s[k] !== false && s[k] !== '') out[k] = s[k]
  if (isWarmupRow(s)) out.warmup = true
  return out
}

// Turns a tool-level set into the stored row, the way log_workout's rows are made (rowOf), over
// a planned row when there is one: a number not given keeps the planned one, so "fiz 12" ticks
// the row at the planned weight. `plates` with no factor leaves the planned weight out — a
// weight the user did not confirm must not be stored as if they had.
function rowFrom(S, e, given, planned, now, warnings) {
  const unit = S.unit || 'kg'
  const exName = nameOf(S, e.id)
  const base = planned ? argsOfRow(planned) : {}
  // What is given displaces its planned counterpart (a weight the plates, an RIR the RPE); two
  // given together are still the conflict rowOf refuses.
  if (given.plates != null) delete base.w
  if (given.rir != null) delete base.rpe
  if (given.rpe != null) delete base.rir
  const merged = { ...base, ...given }
  const row = rowOf(merged, { factor: platesFactorOf((S.exNotes || {})[e.id]), unit, exName }, warnings)
  if (given.plates != null && row.w == null) delete row.w
  // Live-session bookkeeping the app's own rows carry: `at` is what sessionEnd reads the finish
  // time from, so a session finished the next morning keeps the length it really had.
  if (planned && planned.type) row.type = planned.type
  row.at = now
  return row
}

// The entry a set belongs to: the one named (the first with an undone row, else the last of that
// exercise), or the current one. A named exercise not in the session is added at the end as a
// freestyle entry, so "fiz também panturrilha" needs no separate call.
async function entryFor(S, s, exercise, { addMissing = true } = {}) {
  if (!exercise) {
    if (!list(s.entries).length) throw coded('EINVAL', 'the session has no exercises yet — name the exercise in `exercise`, or edit_active_workout { action: "add" }')
    return Math.min(Math.max(0, num(s.cur)), s.entries.length - 1)
  }
  await ensureNames(S)
  const ex = resolveExercise(S, exercise)
  const own = s.entries.map((e, i) => [e, i]).filter(([e]) => e.id === ex.id)
  if (own.length) {
    const open = own.find(([e]) => undoneIndex(e) >= 0)
    return (open || own[own.length - 1])[1]
  }
  if (!addMissing) throw coded('ENOENT', `${ex.n} is not in the open session — get_active_workout lists its exercises`)
  s.entries.push(freestyleEntry(S, ex.id, {}))
  return s.entries.length - 1
}

// An exercise added mid-session, built as the app builds a freestyle add: the last target the
// user actually trained, else the generic defaults, with the opening rows and no prescription.
function freestyleEntry(S, id, over) {
  return withCustomsIndexed(S, () => {
    const cfg = { ...freestyleConfig(S, { ...defaultConfig(id), id }), ...over, id }
    const built = buildPlannedEntry(S, cfg, null)
    return { id, ...built, sets: built.sets.map(r => ({ ...r, done: false })) }
  })
}

/* ---------- start_workout ---------- */

export const startWorkoutTool = {
  name: 'start_workout',
  description: `Open a LIVE session to log set by set as the user trains ("estou indo malhar", "vou fazer o treino 2"). Use it only for a workout happening now; a session already over goes in one log_workout call. From a routine (id or name; list_routines shows them) the opening sets are what the app would put on screen — the progression policy's prescription over the user's history, the same numbers preview_session reports — so you can tell the user the weight before the first set. Without a routine it is a freestyle session: add exercises with log_set (naming the exercise) or edit_active_workout. Pass gym when the user says where they are. Only one session can be open (EINVAL otherwise — finish_workout or discard_workout it). The session is kept in a file on this server, never on the phone; the phone's own running workout is separate. Returns the same view as get_active_workout. Works in file mode too; finishing needs remote mode. ${ERRORS}`,
  schema: {
    routine: z.string().optional().describe('Routine id or name; omit for a freestyle session.'),
    gym: z.string().max(GYM_MAX).optional().describe('Where the user is training ("Iron"). Stored on the workout at finish; get_capabilities lists gyms on record.'),
    name: z.string().max(NAME_MAX).optional().describe('Session name. Default: the routine\'s name, else "Workout".'),
    date: isoDate().optional().describe('YYYY-MM-DD, default today. A past date files the session as a past workout at finish.'),
    start: hhmm().optional().describe('Local start time HH:MM. Default: now (today) or 18:00 (a past date).')
  },
  handler: async ({ routine, gym, name, date, start }) => {
    const S = getState()
    if (!S) throw noState()
    const open = loadSession(user().id)
    if (open) throw coded('EINVAL', `a live session started ${open.started_at || 'earlier'}${open.name ? ` ("${open.name}")` : ''} is already open — log its sets with log_set, or finish_workout / discard_workout it first`, { session: sessionView(S, open) })
    const now = Date.now()
    const today = localIso(new Date(now))
    const d = date || today
    const past = d !== today
    const r = routine ? resolveRoutine(S, routine) : null
    const entries = r ? withCustomsIndexed(S, () => buildSessionEntries(S, r)).map(e => ({ ...e, sets: list(e.sets).map(row => ({ ...row, done: false })) })) : []
    const startMs = start ? backfillStart(d, start) : past ? backfillStart(d, '18:00') : now
    const g = String(gym || '').trim().slice(0, GYM_MAX)
    const draft = {
      id: uid(), d, start: startMs, started_at: new Date(startMs).toISOString(),
      name: String(name || '').trim().slice(0, NAME_MAX) || (r ? deriveSessionName([r.name]) : null) || 'Workout',
      routineIds: r ? [r.id] : [], routineId: r ? r.id : null,
      bw: list(S.bodyweight).length ? S.bodyweight[S.bodyweight.length - 1].w : null,
      cur: 0, entries
    }
    if (g) draft.gym = g
    if (past) draft.backfill = { durationMin: 60, replaceId: null }
    save(draft, now)
    return sessionView(S, draft, { hint: entries.length ? 'tell the user the next_set of the current exercise; log each set with log_set' : 'freestyle: log_set with `exercise` adds the exercise and logs its first set' })
  }
}

/* ---------- get_active_workout ---------- */

export const getActiveWorkoutTool = {
  name: 'get_active_workout',
  description: `The open live session, if any: the current exercise and its next planned set (weight and reps to tell the user), every exercise with its planned and logged sets (1-based set indexes for edit_set / delete_set), sets done and remaining. Call it before log_set when you are not sure which exercise is current, to answer "qual o próximo?" or "quantas faltam?", and after a correction to confirm. Returns { open: false } when nothing is open — then start_workout, or log_workout for a session already over. Read-only; works in every mode.`,
  schema: {},
  handler: async () => {
    const S = getState()
    if (!S) throw noState()
    const s = loadSession(user().id)
    return s ? sessionView(S, s) : closedView
  }
}

/* ---------- log_set ---------- */

export const logSetTool = {
  name: 'log_set',
  description: `Record ONE set of the open live session ("fiz 12 com 45 kg", "mais 12", "subi para 50"). It ticks the next planned set of the exercise with the numbers given — a number not given keeps the planned one, so "fiz 12" at the planned weight only needs r — or appends a set when the plan's are all done. Without \`exercise\` it logs on the current exercise (get_active_workout shows which); naming an exercise that is not in the session adds it at the end. Weights in the profile unit, totals on the bar or stack; plates need the exercise note's factor (set_exercise_note) or the set is stored without a weight and a warning comes back. Returns the row as stored, the sets left on that exercise, the next planned set and, when the exercise is complete, the next exercise. Needs an open session (start_workout; ENOENT otherwise). To change a set already logged use edit_set; to remove it delete_set. ${ERRORS}`,
  schema: {
    exercise: z.string().optional().describe('Exercise id or name. Default: the current exercise of the session.'),
    ...setFields()
  },
  handler: async ({ exercise, ...given }) => {
    const S = getState()
    if (!S) throw noState()
    const s = requireSession()
    const now = Date.now()
    const i = await entryFor(S, s, exercise)
    const e = s.entries[i]
    const warnings = []
    const u = undoneIndex(e)
    const planned = u >= 0 ? e.sets[u] : (list(e.sets).length ? e.sets[e.sets.length - 1] : null)
    // A row appended beyond the plan starts from the last row's numbers (the app copies the
    // previous set the same way), but not from its effort rating, note or failure mark.
    const base = planned && u < 0 ? (({ rir, rpe, failure, note, ...rest }) => rest)(planned) : planned
    const row = rowFrom(S, e, given, base, now, warnings)
    if (u >= 0) e.sets[u] = row
    else e.sets.push(row)
    const at = u >= 0 ? u : e.sets.length - 1
    s.cur = i
    const complete = undoneIndex(e) < 0
    if (complete) advance(s, i + 1)
    save(s, now)
    const next = s.entries[s.cur]
    return {
      ok: true,
      exercise: { index: i + 1, id: e.id, name: nameOf(S, e.id) },
      set_index: at + 1,
      set: rowView(e, row),
      done_sets: doneCount(e),
      remaining_sets: list(e.sets).filter(x => !isDone(x)).length,
      next_set: nextSetOf(S, e),
      exercise_complete: complete,
      ...(complete && next && next !== e ? { next_exercise: { index: s.cur + 1, id: next.id, name: nameOf(S, next.id), next_set: nextSetOf(S, next) } } : {}),
      session: { done_sets: draftDone(s), remaining_sets: Math.max(0, draftTotal(s) - draftDone(s)) },
      warnings
    }
  }
}

/* ---------- edit_set / delete_set ---------- */

export const editSetTool = {
  name: 'edit_set',
  description: `Change one set of the open live session ("a última foi com outro peso", "não, foram 10"): the fields given replace those of the set; the rest stay. Sets are 1-based per exercise, as get_active_workout lists them; the exercise defaults to the current one. A planned set that was not logged yet can be edited too (it stays unlogged until log_set). For a workout already saved use update_workout instead. ${ERRORS}`,
  schema: {
    exercise: z.string().optional().describe('Exercise id or name. Default: the current exercise.'),
    set_index: z.number().int().min(1).describe('Which set of that exercise, 1-based (get_active_workout).'),
    ...setFields()
  },
  handler: async ({ exercise, set_index, ...given }) => {
    const S = getState()
    if (!S) throw noState()
    const s = requireSession()
    const i = await entryFor(S, s, exercise, { addMissing: false })
    const e = s.entries[i]
    const old = list(e.sets)[set_index - 1]
    if (!old) throw coded('ENOENT', `${nameOf(S, e.id)} has ${list(e.sets).length} set(s) — no set ${set_index}`)
    if (!Object.keys(given).length) throw coded('EINVAL', 'nothing to change: give at least one set field (w, plates, r, sec, min, speed, rir, rpe, failure, warmup, note)')
    const now = Date.now()
    const warnings = []
    const row = rowFrom(S, e, given, old, old.at || now, warnings)
    if (given.warmup === false) delete row.phase
    row.done = isDone(old)
    if (!row.done) delete row.at
    e.sets[set_index - 1] = row
    save(s, now)
    return { ok: true, exercise: { index: i + 1, id: e.id, name: nameOf(S, e.id) }, set_index, set: rowView(e, row), logged: row.done, warnings }
  }
}

export const deleteSetTool = {
  name: 'delete_set',
  description: `Remove one set from the open live session ("não, foram duas séries" → delete the third). Sets are 1-based per exercise (get_active_workout); the exercise defaults to the current one. A planned set not yet logged is removed too, which shortens the plan for this session only. For a workout already saved use update_workout. ${ERRORS}`,
  schema: {
    exercise: z.string().optional().describe('Exercise id or name. Default: the current exercise.'),
    set_index: z.number().int().min(1).describe('Which set of that exercise, 1-based.')
  },
  handler: async ({ exercise, set_index }) => {
    const S = getState()
    if (!S) throw noState()
    const s = requireSession()
    const i = await entryFor(S, s, exercise, { addMissing: false })
    const e = s.entries[i]
    if (!list(e.sets)[set_index - 1]) throw coded('ENOENT', `${nameOf(S, e.id)} has ${list(e.sets).length} set(s) — no set ${set_index}`)
    const [removed] = e.sets.splice(set_index - 1, 1)
    save(s, Date.now())
    return { ok: true, exercise: { index: i + 1, id: e.id, name: nameOf(S, e.id) }, removed: { index: set_index, ...rowView(e, removed) }, sets: entryRows(S, e) }
  }
}

/* ---------- edit_active_workout ---------- */

export const editActiveWorkoutTool = {
  name: 'edit_active_workout',
  description: `Change the exercises of the open live session: \`skip\` removes an exercise that has no logged set ("não quero fazer esse" — delete its sets first if any were logged), \`replace\` swaps an exercise for another (\`with\`; an exercise with logged sets keeps them and the replacement is inserted after it), \`move\` moves it up or down one place ("não estou seguindo a ordem"), \`add\` appends an exercise with optional sets/reps/weight (or sec, or min). Exercises by id or name (search_exercises; EAMBIG when ambiguous). Returns the updated session view. For the saved plan itself use edit_routine. ${ERRORS}`,
  schema: {
    action: z.enum(['skip', 'replace', 'move', 'add']).describe('What to do.'),
    exercise: z.string().min(1).describe('The exercise concerned (id or name): the one to skip, replace or move, or the one to add.'),
    with: z.string().optional().describe('replace: the exercise to put in its place (id or name).'),
    direction: z.enum(['up', 'down']).optional().describe('move: which way.'),
    sets: z.number().int().min(1).max(20).optional().describe('add: planned sets (default: last time\'s, else 3).'),
    reps: z.number().int().min(1).optional().describe('add: planned reps per set.'),
    weight: z.number().min(0).optional().describe('add: planned weight in the profile unit.'),
    sec: z.number().int().min(1).optional().describe('add: seconds per set for a timed exercise.'),
    min: z.number().min(1).optional().describe('add: minutes for cardio.')
  },
  handler: async ({ action, exercise, with: replacement, direction, sets, reps, weight, sec, min }) => {
    const S = getState()
    if (!S) throw noState()
    const s = requireSession()
    await ensureNames(S)
    const ex = resolveExercise(S, exercise)
    const now = Date.now()
    const indexOf = () => {
      const i = s.entries.findIndex(e => e.id === ex.id)
      if (i < 0) throw coded('ENOENT', `${ex.n} is not in the open session — get_active_workout lists its exercises`)
      return i
    }
    let note
    if (action === 'add') {
      const over = {}
      if (sets != null) over.sets = sets
      if (min != null) { over.min = min; over.mode = 'cardio' } else if (sec != null) { over.sec = sec; over.mode = 'time' } else if (reps != null) { over.reps = reps; over.mode = 'reps' }
      if (weight != null) over.weight = weight
      s.entries.push(freestyleEntry(S, ex.id, over))
      if (s.entries.length === 1) s.cur = 0
      note = `${ex.n} added as exercise ${s.entries.length}`
    } else if (action === 'skip') {
      const i = indexOf()
      if (doneCount(s.entries[i]) > 0) throw coded('EINVAL', `${ex.n} has ${doneCount(s.entries[i])} logged set(s) — delete_set them first, or leave it: finish_workout keeps what was logged`)
      s.entries.splice(i, 1)
      if (s.cur > i || s.cur >= s.entries.length) s.cur = Math.max(0, Math.min(s.cur - 1, s.entries.length - 1))
      advance(s, s.cur)
      note = `${ex.n} skipped`
    } else if (action === 'replace') {
      if (!replacement) throw coded('EINVAL', 'replace needs `with`: the exercise to put in its place')
      const i = indexOf()
      const to = resolveExercise(S, replacement)
      const current = s.entries[i]
      const repl = freestyleEntry(S, to.id, { sets: list(current.sets).length || undefined })
      const r = swapActiveExercise(s, i, repl, { loggedConfirmed: true, groupDisposition: 'keep' })
      if (!r) throw coded('EIO', 'the swap was refused')
      note = r.inserted ? `${to.n} inserted after ${ex.n}, whose logged sets are kept` : `${ex.n} replaced by ${to.n}`
    } else if (action === 'move') {
      if (!direction) throw coded('EINVAL', 'move needs `direction`: up or down')
      const i = indexOf()
      const r = moveActiveWorkoutEntry(s, i, direction === 'up' ? -1 : 1)
      if (!r) throw coded('EINVAL', `${ex.n} cannot move ${direction} from position ${i + 1}`)
      s.cur = Math.max(0, Math.min(num(s.cur), s.entries.length - 1))
      note = `${ex.n} moved ${direction}`
    }
    save(s, now)
    return sessionView(S, s, { changed: note })
  }
}

/* ---------- finish_workout / discard_workout ---------- */

export const finishWorkoutTool = {
  name: 'finish_workout',
  description: `Close the open live session and SAVE it as a workout ("terminei, pode gravar"), through the same path log_workout uses: PRs awarded, the routine's progression advanced, every device picks it up on its next sync. Only sets that were logged count; planned sets left unticked are kept as planned-not-done, as the app does. Returns the record read back from the server (workout_id, volume, PRs, every set) — relay the id and the numbers, and the warnings. Refuses with EINVAL when no set was logged (discard_workout instead). Needs remote mode (EPERM) — on any failure the session is KEPT and finish_workout can be retried. ${ERRORS}`,
  schema: {
    note: z.string().max(NOTE_MAX).optional().describe('Session note ("ombro incomodou"); the gym is prefixed automatically.'),
    duration_min: z.number().int().min(1).max(1440).optional().describe('Length in minutes. Default: from the first to the last logged set (today), or 60 (a past date).')
  },
  handler: async ({ note, duration_min }) => {
    const S0 = getState()
    if (!S0) throw noState()
    const s = requireSession()
    if (!draftDone(s)) throw coded('EINVAL', 'no set was logged in this session — log_set the sets, or discard_workout it')
    if (!writesEnabled()) throw coded('EPERM', 'finish_workout: saving needs remote mode — set OPENGYM_URL and OPENGYM_TOKEN; the session is kept and can be finished once they are set')
    const now = Date.now()
    const draft = structuredClone(s)
    const text = String(note ?? s.note ?? '').trim().slice(0, NOTE_MAX)
    const withGym = noteWithGym(s.gym || '', text)
    if (withGym) draft.note = withGym; else delete draft.note
    if (draft.backfill) {
      if (duration_min) draft.backfill.durationMin = duration_min
    } else {
      draft.end = duration_min ? draft.start + duration_min * 60000 : Math.max(draft.start + 60000, sessionEnd(draft, now))
    }
    delete draft.started_at; delete draft.updated_at
    let out
    try {
      out = await mutate((S, ctx) => logWorkout(S, draft, ctx), { label: 'finish_workout', now })
    } catch (e) {
      if (e.code !== 'EINVAL') e.message += ' — the session is still open; finish_workout can be retried'
      throw e
    }
    clearSession(user().id)
    const { state, result, rev } = out
    return workoutResult(state, result.workout, { prs: result.prs, e1rm: result.e1rm_records, warnings: [], rev, extra: { session: 'closed' } })
  }
}

export const discardWorkoutTool = {
  name: 'discard_workout',
  description: `Drop the open live session WITHOUT saving anything. ASK THE USER before calling this and pass confirm: true. Nothing reaches the server; sets already logged in it are lost. To keep what was logged use finish_workout instead. ${ERRORS}`,
  schema: {
    confirm: z.literal(true).describe('Must be true: the user confirmed.')
  },
  handler: async () => {
    const s = requireSession()
    clearSession(user().id)
    return { ok: true, discarded: { started_at: s.started_at || null, name: s.name || null, gym: s.gym || null, done_sets: draftDone(s), exercises: list(s.entries).length } }
  }
}

/* ---------- registration list ---------- */

export const SESSION_TOOLS = [
  startWorkoutTool, getActiveWorkoutTool, logSetTool, editSetTool, deleteSetTool,
  editActiveWorkoutTool, finishWorkoutTool, discardWorkoutTool
]
