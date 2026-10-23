/* What the server says about itself: the `instructions` every MCP client hands its model at the
   handshake, the get_capabilities tool an agent calls first in a conversation, and the
   opengym://guide resource (the same guidance as markdown, with the tool catalogue appended from
   the registered descriptions so it cannot drift from them). docs/dev/MCP_WRITE.md, "Server
   instructions and the guide resource". */
import { getState, getUser, getMode, writesEnabled } from './state.js'
import { loadSession } from './session.js'
import { effortOf } from '../../frontend/src/lib/history.js'

export const SERVER_NAME = 'opengym'
export const SERVER_VERSION = '0.2.0'

export const INSTRUCTIONS = `openGym MCP server — a self-hosted gym log. One profile. Everything you read or write here is
that person's own training data.

Start every conversation by calling get_capabilities: it says whether writes are enabled, the
unit (kg or lb), the language, the gyms already on record, and whether a live session is open.

Rules:
- Resolve exercises before writing: call search_exercises with the user's words (any language);
  a tool that gets an ambiguous name fails with EAMBIG and a candidate list — ask, do not guess.
- Weights are in the profile unit, totals on the bar or stack. Dates are YYYY-MM-DD, times
  HH:MM. A set is one row: w, r (reps), sec (timed), min + speed (cardio), rir or rpe, failure.
- A finished session goes in one log_workout call. Use the session tools (start_workout,
  log_set, finish_workout) only when the user is reporting set by set as they train.
- To fix a saved workout use update_workout with the full corrected exercise list; to fix a
  set of the open session use edit_set. Ask before delete_workout and discard_workout.
- "Where" matters to this user: pass gym on log_workout / start_workout when they say it, and
  use last_performance with gym to answer "last time at X".
- preview_session, not get_routine, says what weight the app would prescribe today.
- add_bodyweight logs a weigh-in; set_exercise_note keeps the standing facts of an exercise
  (seat, pin, "1 placa = 5 kg"); edit_routine changes the plan — read get_routine first and send
  the full exercise list.
- Every write returns the record read back from the server with its id and rev; relay the id
  and the numbers, and say when a warning came back (e.g. plates without a kg factor).`

// One line per tool for the capability listing — what to reach for, not the full description.
const USE = {
  list_routines: 'the routines on the profile (names, counts, policy)',
  get_routine: 'one routine\'s stored exercises and targets',
  preview_session: 'what the app would put on screen for a routine today — the weight to name',
  get_week_plan: 'what is planned on which day, the coach week, the weekday table',
  list_workouts: 'recent finished workouts, newest first, with ids',
  get_workout: 'one workout set by set, by id or date',
  get_bodyweight: 'weigh-ins, goal and deltas',
  estimate_1rm: 'best estimated 1RM for an exercise, or the PR table',
  muscle_balance: 'which muscles were trained this week/month and which were not',
  search_exercises: 'name → exercise id, any language; call before any write that names an exercise',
  log_workout: 'save a finished session in one call (today or a past date), with gym',
  update_workout: 'correct a saved workout: sets, note, name, gym, date, duration',
  delete_workout: 'remove a saved workout (ask first, confirm: true)',
  last_performance: 'last sessions, best weight and 1RM of one exercise, filterable by gym',
  add_bodyweight: 'log a weigh-in',
  set_exercise_note: 'the standing note of an exercise (seat, pin, "1 placa = 5 kg")',
  edit_routine: 'create, change or delete a routine',
  start_workout: 'open a live session from a routine or freestyle, with gym',
  get_active_workout: 'the open session: current exercise, sets done, what is left',
  log_set: 'tick or add one set of the open session',
  edit_set: 'change one set of the open session',
  delete_set: 'remove one set of the open session',
  edit_active_workout: 'skip, replace, move or add an exercise in the open session',
  finish_workout: 'save the open session as a workout',
  discard_workout: 'drop the open session without saving (ask first)',
  get_capabilities: 'this overview'
}

export const WORKFLOWS = {
  log_finished_workout: ['search_exercises for anything not already an id', 'log_workout with every exercise and set (and gym)', 'relay workout_id, volume and prs from the result'],
  live_session: ['start_workout', 'get_active_workout when unsure what is next', 'log_set per set', 'edit_set / delete_set to correct', 'finish_workout'],
  correct_logged_set: ['list_workouts or get_workout to find workout_id', 'update_workout with the full corrected exercises list'],
  last_weight_at_gym: ['last_performance with exercise and gym'],
  plates_machine: ['set_exercise_note with "1 placa = X kg" once', 'then log sets as { plates: n }']
}

export const LIMITATIONS = [
  'gym is stored on the workout and in its note; the app\'s screens do not show it as a field',
  'a set given in plates is stored with a weight only when the exercise note carries "1 placa = X kg"',
  'writes are refused in file mode (set OPENGYM_URL and OPENGYM_TOKEN)',
  'an in-progress session lives on this server only; the phone\'s own running workout is separate — finishing both for the same training makes two records (delete_workout fixes it)'
]

const groupOf = (name, groups) => groups.read.includes(name) ? 'read' : groups.session.includes(name) ? 'session' : 'write'

/** The capability overview. `groups` = { read: [names], write: [names], session: [names] }. */
export function capabilitiesOf(groups) {
  const S = getState() || {}
  const mode = getMode()
  const u = getUser()
  const gyms = [...new Set((S.workouts || []).map(w => String(w?.gym || '').trim()).filter(Boolean))]
  let session = { open: false }
  try {
    const s = loadSession(u.id)
    if (s) session = { open: true, started_at: s.started_at || null, name: s.name || null, gym: s.gym || null, done_sets: (s.entries || []).reduce((n, e) => n + (e.sets || []).filter(x => x.done).length, 0) }
  } catch { /* a file problem is reported by the session tools themselves */ }
  const row = name => ({ name, use: USE[name] || '' })
  return {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    mode,
    writes: writesEnabled()
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'file mode (OPENGYM_DATA): the api is the only writer of state-<uid>.json; set OPENGYM_URL and OPENGYM_TOKEN' },
    profile: { id: u.id, name: u.name, unit: S.unit || 'kg', lang: S.lang || 'en', effort_scale: effortOf(S) || 'none' },
    counts: {
      routines: (S.routines || []).length, workouts: (S.workouts || []).length,
      custom_exercises: (S.customEx || []).length, bodyweight_entries: (S.bodyweight || []).length
    },
    gyms_seen: gyms,
    active_session: session,
    tools: { read: groups.read.map(row), write: groups.write.map(row), session: groups.session.map(row) },
    workflows: WORKFLOWS,
    limitations: LIMITATIONS,
    units: { weight: S.unit || 'kg', speed: 'km/h', date: 'YYYY-MM-DD', time: 'HH:MM' }
  }
}

/** The tool. `groups` is bound at registration (index.js) so the listing is what is registered. */
export function capabilityTool(groups) {
  return {
    name: 'get_capabilities',
    description: 'Call this FIRST in a conversation. Describes this openGym profile and what this server can do: whether writes are enabled (and why not), the profile\'s unit and language, counts, the gyms already on record, whether a live session is open, every tool grouped read / write / session with a one-line use, the recommended workflows (log a finished workout, live session set by set, correct a logged set, last weight at a gym, plates machines) and the known limitations. No arguments. Read-only.',
    schema: {},
    handler: () => capabilitiesOf(groups)
  }
}

/** The opengym://guide resource text: the instructions plus the catalogue of registered tools. */
export function guideMarkdown(tools, groups) {
  const section = (title, names) => [`## ${title}`, '', ...names.flatMap(n => {
    const t = tools.find(x => x.name === n)
    return t ? [`### \`${t.name}\``, '', t.description, ''] : []
  })]
  return [
    '# openGym MCP server — guide', '', INSTRUCTIONS, '',
    '## Workflows', '', ...Object.entries(WORKFLOWS).map(([k, steps]) => `- **${k}**: ${steps.join(' → ')}`), '',
    '## Limitations', '', ...LIMITATIONS.map(l => `- ${l}`), '',
    ...section('Read tools', groups.read), ...section('Write tools', groups.write), ...section('Session tools', groups.session),
    ...section('Capabilities', ['get_capabilities'])
  ].join('\n')
}

export const CAPABILITY_TOOLS = groups => [capabilityTool(groups)]
