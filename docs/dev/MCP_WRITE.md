# MCP write tools: logging and editing a profile from an LLM client

Design note for the second phase of the MCP server (`mcp/`): the tools that let an LLM client
**write** to a profile — log a workout, correct one, add a weigh-in, keep per-exercise notes, edit
a routine, and run a session set by set — and the remote mode that makes those writes safe. Not a
map of what shipped; the implementer codes from this document, and the reviewer checks against it.
See [`CLAUDE.md`](../../CLAUDE.md) for the architecture and [`mcp/README.md`](../../mcp/README.md)
for the user-facing side of phase 1 (read-only, direct `./data` access).

The driving use case: the user talks to an agent (Hermes Agent, over Telegram) during and after
training — "fiz supino 3×10 com 60 kg", "na verdade foram 65", "qual foi o último peso no voador na
Iron?", "terminei, pode gravar". The agent holds the conversation; the MCP server has to make
each of those a single, unambiguous tool call, and has to tell the agent, in its own tool
descriptions, what it can and cannot do.

## Goals and non-goals

Goals:

- **Batch logging is the primary path.** `log_workout` takes a whole finished session in one call
  and returns the saved record read back from the server, with its id. The agent records at the
  end of a session; a partial, set-by-set session is an optional layer on top (the session tools),
  never a prerequisite.
- **Writes go through the API, never the file.** `api/server.js` is the only writer of
  `state-<uid>.json` (it says so itself, at `stateCache.delete` in `PUT /api/data`), and it owns
  the revision counter, the write ids, the sync stamps and the merge rules every device relies on.
  The MCP server becomes an ordinary API client with a Bearer token — the same client the paired
  phone already is.
- **Every number the app would compute is computed by the app's own code.** Records are built with
  `buildCompletedWorkout` (`frontend/src/lib/finish-workout.js`), filed with `insertChronological`
  / `completeBackfill` (`backfill.js`), badged with `rebuildPrHistory` (`workout-date.js`), edited
  through `editCompletedSession` / `saveWorkoutEdit` (`session-edit.js`). Nothing about what
  counts as a PR, a volume or a kept weight is reimplemented in `mcp/`.
- **Self-describing.** The agent learns what it can do from the server itself: tool descriptions,
  a `get_capabilities` tool, the server `instructions` and a resource — not from this repository.
- **No new runtime dependency.** `@modelcontextprotocol/sdk` and `zod`, as in phase 1. HTTP is
  Node's global `fetch` (Node 22, same as the Dockerfiles).

Non-goals:

- A new transport (Streamable HTTP, a fourth container) — phase 3, unchanged.
- A gym concept in the app's UI. The app has no "where did I train" field; this note records a
  `gym` on the workout and in its note (see *Gyms*), and the app keeps the field through every
  merge without showing it. Adding it to the UI is a separate feature.
- Logging a set as "8 plates" without knowing what a plate weighs. The app stores loads as numbers
  in the profile unit, and every statistic reads them as such. See *Plates*.
- Changing `api/server.js`, the frontend, or the existing read tools. See *Footprint* — the whole
  phase is additive.

## Footprint: existing files touched

The user's constraint: existing code changes only where writing cannot work without it. The list
below is exhaustive; anything not on it is a new file.

| File | Why it must change | Nature of change |
|---|---|---|
| `mcp/src/state.js` | The tools read state through `getState()`, which only knows the file. Remote mode needs a second source behind the same function, and the write path needs `mutate()`. | Additive: a backend abstraction (`file` / `remote`) chosen at `init()`; `getState()`, `getUser()`, `init()`, `dataDir()`, `_seedStateForTests()` keep their names, signatures and file-mode behaviour byte for byte. New exports: `mutate`, `getMode`, `_setBackendForTests`. |
| `mcp/src/index.js` | New tools, the `instructions` string, the `opengym://guide` resource and the `pair` subcommand have to be registered somewhere, and the startup line should say which mode is serving. | Additive: imports `WRITE_TOOLS`, `SESSION_TOOLS`, `CAPABILITY_TOOLS` and registers them in the same loop; passes `instructions`; handles `process.argv[2] === 'pair'` before connecting. The existing `TOOLS` loop and error wrapping are untouched. |
| `mcp/scripts/check-node-loadable.mjs` | Its `MODULES` list exists to name the culprit when a lib module stops loading under plain Node; the new modules import more of `frontend/src/lib`. | Additive: new entries in `MODULES` and the new `mcp/src/*.js` entry points. |
| `mcp/package.json` | A `pair` script is convenient but not required; the `description` says "read-only". | `description` text; optional `"pair": "node src/index.js pair"` script. No dependency change. |
| `mcp/README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/README.md` | Documentation. | Text only. |

Not touched, and verified not to need it: `api/server.js` (Bearer auth, the CSRF exemption for
Bearer requests at `csrfOk`, `GET /api/data`, `PUT /api/data` with `baseRev` / `baseWid` /
`stamped`, `GET /api/me` token renewal and `POST /api/pair/redeem` all exist and do exactly what
this needs); `api/sync-stamps.js`; every `frontend/src/lib/*.js` this imports; `mcp/src/tools.js`
(the nine read tools and their `TOOLS` export are left as they are; the new tools live in new
files and are concatenated at registration); `mcp/src/labels.js`.

Every `frontend/src/lib` module the new code imports was checked to load under plain Node 22
with no change: `finish-workout.js`, `session-edit.js`, `backfill.js`, `workout-date.js`,
`sync-merge.js`, `exercise-history.js`, `active-exercise-swap.js`, `active-workout-order.js`,
`session-merge.js`, `session-start.js`, `format.js`, `equipment.js`, `i18n-core.js`, and the
exercise-name packs `frontend/src/exercise-names/<lang>.js` (plain `export default {id: name}`
objects, 5,632 entries for `pt-BR`). The `check:node-loadable` script is the regression guard.

## Access modes

`state.js` gains a backend chosen once at `init()`:

| Mode | Chosen when | Reads | Writes |
|---|---|---|---|
| `file` (phase 1, unchanged) | `OPENGYM_URL` is unset | `OPENGYM_DATA/state-<uid>.json`, watcher + mtime, as today | **refused**: every write tool throws `EPERM` — "writes need remote mode: set OPENGYM_URL and OPENGYM_TOKEN; the api is the only writer of the state file" |
| `remote` (new) | `OPENGYM_URL` is set | `GET <url>/api/data` | `PUT <url>/api/data` |

Remote mode environment:

- `OPENGYM_URL` — the instance's origin, e.g. `https://gym.example.com` (trailing slash
  tolerated, `/api` must not be included). Plain `http://` is accepted (a LAN instance); the token
  travels in a header, so the user should know it is in the clear there — the README says so.
- `OPENGYM_TOKEN` — a Bearer session token, the same string `POST /api/pair/redeem` hands the
  phone. Minted once with the `pair` subcommand below.
- `OPENGYM_TOKEN_FILE` — optional path. When set, the token is read from this file at start
  (it wins over `OPENGYM_TOKEN` when both are set and the file exists), and a renewed token is
  written back to it (mode `0600`, write-temp-then-rename). Without it a renewed token is logged to
  stderr once as a hint and used in memory for the life of the process. The README recommends
  the file: a token lives `SESSION_DAYS` (30 by default) and `GET /api/me` renews it only past
  half-life, so a long-running Hermes with the file never has to pair again.
- `OPENGYM_UID` is ignored in remote mode (the token names the profile). `OPENGYM_DATA` is ignored.

`mcp/src/remote.js` (new) — the whole HTTP surface, so the tests can replace it:

```js
export function createRemoteBackend({ url, token, tokenFile, fetchImpl = globalThis.fetch })
// returns { mode: 'remote',
//           read():   Promise<{ state, rev, wid, user }>,
//           write(state, { baseRev, baseWid }): Promise<{ rev, wid }>,   // throws RemoteError
//           me():     Promise<{ user, token? }> }
```

- `read()` calls `GET /api/data` with `Authorization: Bearer <token>`; `state` is the document
  as the server hands it (already stripped of `_unstamped` / `_prior`), `rev` the body's `rev`,
  `wid` is `state._wid`. The first read of a process also calls `GET /api/me` to learn the profile
  (`user.name`, `user.id`) and to pick up a renewed `token` if one comes back.
- `write(state, { baseRev, baseWid })` sends `{ state, baseRev, baseWid, stamped: false }`.
  `stamped: false` is the point: it tells `stampPut` (`api/sync-stamps.js`) that this writer does
  not stamp its own changes, and the server then records, at its own clock, every entry this write
  removed (`deleted`), every setting or per-key map entry it changed (`edited`), and stamps every
  routine, custom exercise or workout whose content changed (`stampEntry` with per-field `_f`).
  That is exactly the bookkeeping a device's `mergeStates` needs, and it means **the MCP never
  imports `stampDeletions` / `stampEdits` / `stampRoutines` / `stampCustomEx`** — only
  `stampWorkout` where the app's own helpers already call it (an edited or backfilled workout).
  `active` is dropped by the server (`delete body.state.active`), so a mutation never has to
  strip it either.
- Errors map to codes the tools re-throw: HTTP 401 → `EAUTH` ("token refused: it expired, was
  revoked by *Sign out everywhere*, or the account is disabled — pair again"), 409 → `ECONFLICT`
  (carries `rev`, `state` from the body), 413 → `E2BIG`, 503 → `EIO` ("state unreadable on the
  server"), network failure → `ENET` (with the URL's host only, never the token), anything else →
  `EIO` with the status.

`state.js` in remote mode caches the last `read()` for `REMOTE_TTL_MS = 2000` ms so a tool that
calls `getState()` three times does one request, and invalidates it on every write. `getState()`
in remote mode is therefore **async-backed but synchronous in signature**: the existing read tools
call it synchronously. Resolution: `init()` in remote mode performs the first read before the
transport connects (top-level `await` in `index.js`, already used there), and the tool wrapper in
`index.js` refreshes the cache (`await refresh()`) before invoking any handler when the TTL has
lapsed. Read tools stay untouched and still get a fresh document.

### Pairing: `node src/index.js pair <url> <code>`

The one-time step that turns the 8-character code from *Settings → Pair the mobile app* into a
token: `POST <url>/api/pair/redeem` with `{ code }`, prints `OPENGYM_TOKEN=<token>` and the profile
name to stdout, and when `OPENGYM_TOKEN_FILE` is set also writes the token there. A `400`
(`pair-invalid`) says the code is wrong or older than five minutes. Nothing else of the server is
touched: no interactive prompt, no config file written beyond the optional token file.

## The mutation API

One door for every write, in `state.js`:

```js
/** Applies `fn` to a fresh copy of the current document and pushes the result.
 *  `fn(S, ctx)` mutates `S` in place (or returns a replacement) and may return a value through
 *  `ctx.result`. Returns { state, result, rev, wid }. Retries once on ECONFLICT. */
export async function mutate(fn, { label } = {})
```

1. `read()` → `{ state, rev, wid }`; `S = Object.assign({}, defaultsShape(), structuredClone(state))`.
   A profile with no document yet (`state === null`) starts from `defaultsShape()` with `rev 0`.
2. `fn(S, ctx)`; the mutation is a **pure function of `S`** from `mcp/src/mutations.js` — no
   `Date.now()` inside it; `ctx.now` is passed in so tests pin time.
3. `write(S, { baseRev: rev, baseWid: wid })`.
4. On `ECONFLICT` (another device wrote in between): take the `state` the 409 carried, redo
   steps 1–3 once with it. A second 409 propagates as `ECONFLICT` to the tool, whose message says
   the profile is being written by another device right now and to retry.
5. Invalidate the read cache; return the pushed state so the tool can read its own write back.

In file mode `mutate` throws `EPERM` before reading anything.

Every mutation in `mutations.js` has the signature `(S, args, ctx) => result` with
`ctx = { now, todayIso, unit }`, and a unit test beside it in `mcp/test/mutations.test.js`
seeded from `buildDemoState()` — the CONTRIBUTING rule: anything that reads a logged session
back or decides what you lift next is a pure helper with a test, not something verified by
clicking.

## Resolving names: exercises, routines, gyms

Hermes gets free text; the tools take ids **or names** for exercises and routines and resolve them
the same way everywhere (`mcp/src/exercise-search.js`, `resolveExercise(S, text)`,
`resolveRoutine(S, text)`):

1. An exact id (catalogue `EXIDX`, or `S.customEx[].id`) wins outright.
2. A case- and accent-insensitive exact match on the English name, the localized name for the
   profile's `S.lang` (base language per `baseLang()` of `i18n-core.js`, pack loaded by plain
   `import('../../frontend/src/exercise-names/<lang>.js')` when `EXERCISE_NAME_LANGS` lists it),
   or a custom exercise's `n`, wins.
3. Otherwise `searchScore()` from `exercises.js` over `allExercises(S)` with the query, scoring
   both the English and the localized name (the localized name is scored by substituting it as
   `n` on a shallow copy). One hit, or one hit whose score is ≥ 1.5× the runner-up's, resolves.
4. Anything else throws `EAMBIG` with `candidates: [{ id, name_en, name_localized, body_part,
   equipment }]` (at most 8), so the agent can ask the user or pick. The message says so in one
   line: *"'supino' matches 6 exercises — call again with one of these ids"*.

Routines resolve by id, then exact name (case-insensitive), then unique prefix; else `EAMBIG`.

Gyms are free text. A workout stores `gym` as typed, trimmed, ≤ 40 chars; `last_performance`
compares gyms case-insensitively. There is no gym registry, deliberately: the agent keeps the
names consistent, and `get_capabilities` lists the distinct gyms already on record so it can.

### Gyms — what the app does and does not do

The app has no per-workout gym. What it has: equipment profiles (`S.equipProfiles[]`,
`{ id, name, equipment[], accV }`, which filter the library by what is available), check-in cards
(`S.gymCards[]`, a turnstile barcode), and standing per-exercise notes (`S.exNotes[exId]`, a
string — "seat 4, pin 7"). A workout, though, keeps unknown fields: `stampPut` →
`keepUnknown` puts back any field an unstamping writer left out, and `mergeStates` keeps the
version of a workout edited last as a whole, fields it does not know included. So:

- `log_workout` writes `w.gym = "Iron"` (top-level) **and** prefixes the session note:
  `note = "Iron" + (note ? " · " + note : "")`, because the note is what the History screen shows.
  `update_workout` with `gym` rewrites both (the prefix is recognised as `^<old gym> · ?`).
- `last_performance`, `list_workouts`-style answers in the new tools, and `get_capabilities`
  read `w.gym`. The existing read tools are not changed, so `get_workout` does not show it; the
  note carries it there.

### Plates

A machine stack counted in plates has no weight the app can store. Convention: the standing note
of the exercise (`S.exNotes[exId]`, editable with `set_exercise_note`, shown by the app on the
exercise card) may carry a factor, matched by

```
/(?:^|[\s,;(])(?:1\s*)?(?:placa|plate)\s*=\s*(\d+(?:[.,]\d+)?)\s*(kg|lb)?/i
```

e.g. `"voador na Iron: 1 placa = 5 kg"`. A set given as `{ plates: 8 }`:

- with a factor in that exercise's note (unit matching the profile's, or none): stored as
  `w = 8 × factor`, and the set's `note` gets `"8 placas"` appended so the number's origin is kept;
- without one: stored with **no `w`** (0), `r` as given, `note: "8 placas (fator desconhecido)"`,
  and the tool result carries `warnings: ["<exercise>: plates logged without a kg factor — set it
  with set_exercise_note('<name>', '1 placa = X kg') and update_workout"]`. Never a guessed number.
- `plates` and `w` together on one set → `EINVAL`.

## The record a write produces

`log_workout` builds an **active-shaped draft** and hands it to the app's own finish path, so a
record logged by Hermes is byte-for-byte the shape a record logged on the phone is:

```js
const draft = {
  id: uid(),                                   // format.js
  d: date,                                     // 'YYYY-MM-DD'
  start,                                       // epoch ms: backfillStart(date, startHHMM) (backfill.js), or ctx.now - duration when start is omitted and date is today
  routineIds, name, bw: null, cur: 0,
  entries: [{ id, rid?, target?, planned?, sets: [row…], note?, notePin? }],
  note, gym,                                   // gym is carried through buildCompletedWorkout? NO — see below
  backfill: past ? { durationMin, replaceId: null } : undefined
}
```

`buildCompletedWorkout` whitelists its output, so `gym` is set on the returned record afterwards
(`w.gym = gym`). Set rows are built from the tool's set objects as
`{ w, r, sec, min, speed, rir, rpe, done: true, phase?, failure?, note? }` — `phase: 'warmup'`
when `warmup: true`, `failure: true` when `failure: true`, only the keys given (a reps set has no
`sec`), matching what `finishedRow` keeps. `target` is taken from the routine's cfg for the
exercise when a routine is named (`{ ...cfg }` without `id`, the way `buildPlannedEntry` stores
it), else derived from the sets (`{ sets: n, reps }`, `{ sets, sec }` or `{ sets, min, speed }`)
so `modeOf` labels the rows right.

Filing (`mutations.logWorkout`), mirroring `doFinishWorkout` in `sheets.jsx`:

- **Today, no explicit past date** (`date === ctx.todayIso` and no `start` earlier than today):
  the live path. PR badges: per entry, the best non-warm-up load vs `bestWeightFor(S, id,
  entryDbLoad(e))` through `beatsWeight`; `is1RMRecord` for the e1RM note in the result (not
  stored, as in the app). `w.vol = workoutVolume(w)`; `exWeights[id] = { w: mx, d }` when the
  entry's `bestWeightForEntry` beats the kept one; `S.workouts.push(w)`; `refillAfter(S, w)`
  (`rotation.js`) so a rotation pass advances exactly as it would from the phone.
- **A past date**: the backfill path. `stampWorkout(w, ctx.now)`; `S.workouts =
  rebuildPrHistory(completeBackfill(S.workouts, draft, w), touchedIds, w)`; confirmed weights left
  alone, as the app leaves them. The PRs reported are those `rebuildPrHistory` kept on `w`.
- Both: the result reads the record back **from the pushed state** (`mutate` returns it), through
  the same `entryView` shape `get_workout` uses, so "did it save?" is answered by the server's copy.

`update_workout` (`mutations.updateWorkout`): `editCompletedSession(S, id)` opens the app's
editor on a copy (throws "Workout deleted" → `ENOENT`); the tool applies only the fields it was
given to `S.active` (replace `entries` wholesale when `exercises` is given — the editor model is
"the sets are the editor's"; patch `note`, `name`, `gym`); `saveWorkoutEdit(S, ctx.now)` then
stamps, rebuilds badges and lowers a kept weight the edit took away. Verdict: **viable and
preferred** — it is one function pair, it is what the app runs, and its tests already cover the
PR and kept-weight asymmetries. Date / start / duration changes go through `moveWorkout` and
`setWorkoutDuration` (`workout-date.js`), the way `WorkoutDetail` does, after the save.

`delete_workout` (`mutations.deleteWorkout`): `S.workouts = S.workouts.filter(w => !sameWorkout(w, ref))`
— the History sheet's own line — then `lowerKeptWeights` is not exported from `session-edit.js`;
instead the mutation calls `editCompletedSession(S, id)` + `deleteEditedWorkout(S)`, which is the
editor's delete and does exactly that (filter + lower kept weights). The removal record for sync is
the server's job (`stampUnstamped` → `deleted.workouts[id] = now`), because the write is unstamped
and over the read revision; the e2e test asserts it lands.

`add_bodyweight`: `{ d, w, t: ctx.now }` appended, or the entry of the same day replaced (`w`, `t`),
as `bwSheet` does; kept sorted by `d`. `set_exercise_note`: `S.exNotes[id] = text` or `delete`;
stamped by the server (`exNotes` is in `PER_KEY`). `edit_routine`: the routine object as the
editor stores it — `{ id, name, emoji, ex: [cfg…], prog? }` with `cfg = { id, sets, reps,
repsMin?, repsMax?, mode?, sec?, min?, speed?, weight?, restSec?, sg?, prog? }` — stamped by the
server (`ENTRY_LISTS` includes `routines`, new routines get `_ts = now` there).

## Session tools: the MCP's own in-progress workout

The app keeps the running session device-local (`S.active`; the server deletes it on every PUT).
The MCP keeps its own, in a file, and only `finish_workout` turns it into a record — through
`log_workout`'s path, so the two ways of logging produce the same thing.

`mcp/src/session.js` (new): `loadSession()`, `saveSession(s)`, `clearSession()`. Path
`OPENGYM_SESSION_FILE`, default `path.join(os.homedir(), '.opengym-mcp', 'active-<profile id>.json')`
— the home directory rather than `os.tmpdir()` because a reboot or a tmp cleaner must not lose a
session that is half logged, and `~/.opengym-mcp/` is also where a renewed token may be kept
(`OPENGYM_TOKEN_FILE` default hint in the README). Written with write-temp-then-rename, mode
`0600`. Never sent to the server. Shape: the draft above plus `gym`, `started_at`, `updated_at`
and `entries[].sets[].logged_at`.

Starting from a routine uses `buildSessionEntries(S, r)` with the profile's customs registered for
the length of the build (`registerCustom(S.customEx)` … `registerCustom([])`, the same bracket
`preview_session`'s local `withCustomsIndexed` uses — it is not exported from `tools.js`, so
`write-tools.js` carries its own five-line copy rather than touching `tools.js`), so the opening rows carry the policy's prescription; each row starts
`done: false`. `log_set` either ticks the next undone row of the entry (filling in the numbers
given) or appends a row when none is left. Skip / replace / reorder / add use
`swapActiveExercise`, `moveActiveWorkoutEntry` and a plain `entries.push(buildPlannedEntry(…))`
— all on the MCP's own draft object. `finish_workout` drops entries with no completed set
(`buildCompletedWorkout` does), then calls the `logWorkout` mutation with the draft; on success
the file is cleared; on failure (network, 409 twice) the file stays, and the error says the
session is still held and `finish_workout` can be retried.

## Tool catalogue

Conventions shared by every tool below: dates are `YYYY-MM-DD` (validated with the `isoDate()`
refine of `tools.js`, re-exported from a small `mcp/src/schema.js` so `tools.js` stays untouched);
times `HH:MM` local to the server; weights in the profile unit (`S.unit`, reported in every
result); errors carry a code — `ENOENT` not found, `EINVAL` bad input, `EAMBIG` ambiguous name
(with `candidates`), `EPERM` writes unavailable in file mode, `EAUTH` token refused, `ECONFLICT`
concurrent write, `ENET` unreachable, `EIO` server or file fault — and the message is one
sentence an agent can relay. All zod fields carry `.describe()`. Write tools live in
`mcp/src/write-tools.js` (`WRITE_TOOLS`), session tools in `mcp/src/session-tools.js`
(`SESSION_TOOLS`), the capability tool in `mcp/src/capabilities.js` (`CAPABILITY_TOOLS`).

### `search_exercises`

*When:* before any write that names an exercise, and whenever the user names one in their own
words or language. *Not:* to list a routine (use `get_routine`).

Schema: `query` string min 1 ("name or part of it, English or the profile's language, or an id");
`body_part` optional enum of `BODYPARTS`; `equipment` optional string; `limit` int 1–25 default 8.

Result: `{ query, lang, count, exercises: [{ id, name_en, name_localized|null, body_part,
equipment, target, is_custom, score }] }`, best first. An exact id returns that one exercise.

### `log_workout`

*When:* the user reports a finished session (today or a past day). *Not:* while a session started
with `start_workout` is open — finish or discard that first (the tool refuses with `EINVAL` naming
the open session). Prerequisite: resolve exercises; the tool resolves names itself but fails with
`EAMBIG` on an ambiguous one rather than guessing.

Schema:

```
date          isoDate optional   default today
routine       string optional    routine id or name; links the session for progression and names it
name          string ≤ 60 opt.   session name; default routine name(s) via deriveSessionName, else "Workout"
gym           string ≤ 40 opt.   where it was done, free text; stored on the workout and prefixed to its note
start         HH:MM optional     local start time; default: now minus duration (today) or 18:00 (past date, as the app's backfill)
duration_min  int 1–1440 opt.    default 60
note          string ≤ 500 opt.  session note
exercises     array min 1 of {
  exercise    string             id or name
  note        string ≤ 500 opt.  exercise note for this session
  note_pin    boolean opt.       show this note again next time (notePin)
  sets        array min 1 of {
    w         number ≥ 0 opt.    load in the profile unit (total on the bar / stack)
    plates    int ≥ 1 opt.       stack plates instead of w (see Plates); not with w
    r         int ≥ 0 opt.       reps
    sec       int ≥ 0 opt.       seconds (timed sets)
    min       number ≥ 0 opt.    minutes (cardio)
    speed     number ≥ 0 opt.    km/h (cardio; stored km/h whatever the display unit)
    rir       number 0–10 opt.   reps in reserve
    rpe       number 1–10 opt.   RPE; not with rir
    failure   boolean opt.       taken to failure
    warmup    boolean opt.       warm-up row: excluded from volume, PRs and progression
    note      string ≤ 500 opt.
  }
}
```

A set must carry at least one of `r`, `sec`, `min`. Result:

```json
{ "ok": true, "workout_id": "m2x9…", "date": "2026-10-23", "name": "Push", "gym": "Iron",
  "unit": "kg", "volume": 4320, "sets_done": 12, "duration": "55m",
  "prs": ["bench press"], "e1rm_records": [{ "exercise": "bench press", "est": 78.1, "prev": 75 }],
  "exercises": [ …entryView rows as get_workout returns them… ],
  "warnings": [], "rev": 42 }
```

### `update_workout`

*When:* correcting a workout already saved — a set's weight, a missing set, the note, the gym,
the date or duration. *Not:* for a session still open (use `edit_set`). Fields: `workout_id`
required; any of `exercises` (replaces every exercise and set — send the full corrected list;
the tool echoes what it replaced), `note`, `name`, `gym`, `date`, `start`, `duration_min`. At
least one. Result as `log_workout`, plus `changed: ["exercises", "note"]`; `ENOENT` if the id is
unknown; `EINVAL` if the edit leaves no completed set (the editor refuses that too — use
`delete_workout`).

### `delete_workout`

`workout_id` required; `confirm: true` required (the description says to ask the user first).
Result `{ ok, deleted: { id, date, name }, rev }`.

### `last_performance`

*When:* "what did I lift last time", "last weight on the pec deck at Iron". Schema: `exercise`
(id or name), `gym` optional (case-insensitive match on `w.gym`; `null` or omitted = any),
`limit` 1–20 default 5, `routine` optional. Result: `{ exercise: { id, name_en, name_localized },
unit, exercise_note, pinned_note, best_weight: { w, date }, best_e1rm: { est, w, r, date },
sessions: [{ workout_id, date, gym, routine_name, sets: [labels + w/r/sec/min], note, volume }],
gyms_seen: ["Iron", "Smart Fit"] }` — `sessions` newest first, filtered by `gym` when given;
`exerciseHistory(S, id, { limit })` supplies the sessions and `best1RM` the estimate.

### `add_bodyweight`

`weight` number > 0 (profile unit), `date` optional default today. Result `{ ok, entry: { date,
weight }, previous: { date, weight }|null, delta, goal, delta_vs_goal, rev }`.

### `set_exercise_note`

`exercise` (id or name), `note` string ≤ 500 (`""` clears). The description explains the
plates-factor convention and that the app shows this note on the exercise card every session.
Result `{ ok, exercise, note, plates_factor: { per_plate, unit }|null, rev }`.

### `edit_routine`

*When:* the user wants a routine created or changed (exercises, order, sets/reps targets,
rest). *Not:* for one-off changes to a session. Schema: `routine` optional (id or name — omit to
create), `name` (required when creating), `emoji` optional, `exercises` optional array of
`{ exercise, sets 1–20, reps, reps_min, reps_max, sec, min, speed, weight, rest_sec, superset_group }`
— when given it **replaces** the exercise list in that order (the description says to read
`get_routine` first and send the full list); `remove: true` deletes the routine (with `confirm`).
`mode` is derived with `modeOf({ id })` unless `sec`/`min` are given. Result: the `get_routine`
view of the saved routine plus `created|updated|deleted` and `rev`.

### Session tools

| Tool | Schema | Behaviour / result |
|---|---|---|
| `start_workout` | `routine` opt. (id or name; omit = freestyle), `gym` opt., `date` opt., `name` opt. | `EINVAL` if one is already open (returns its summary). Builds entries via `buildSessionEntries`; saves the file. Result: `get_active_workout` view. |
| `get_active_workout` | none | `{ open: false }` or `{ open: true, started_at, gym, routine_name, current: { index, exercise, next_set }, exercises: [{ index, id, name, sets: [{ index, done, w, r, …, label }] }], remaining_sets, done_sets }`. Descriptions tell the agent to call this before `log_set` when it does not know the current exercise. |
| `log_set` | `exercise` opt. (id or name; default the current entry), `w`/`plates`, `r`, `sec`, `min`, `speed`, `rir`, `rpe`, `failure`, `warmup`, `note` | Ticks the first undone row of that entry with the numbers given (missing numbers keep the planned ones) or appends one. Moves `cur` to that entry. Result: the row as saved (label), `remaining_sets` of the entry, next planned row. |
| `edit_set` | `exercise` opt., `set_index` 1-based, same numeric fields | Replaces the given fields of that row. `ENOENT` if no such row. |
| `delete_set` | `exercise` opt., `set_index` | Removes the row (a planned, undone row is removed too). |
| `edit_active_workout` | `action` enum `skip`/`replace`/`move`/`add`, `exercise`, `with` (replace), `direction` `up`/`down` (move), `sets`/`reps`/`weight` (add) | `skip` removes an entry with no logged set (`EINVAL` otherwise — delete its sets first); `replace` = `swapActiveExercise`; `move` = `moveActiveWorkoutEntry`; `add` = `buildPlannedEntry` with a freestyle cfg. |
| `finish_workout` | `note` opt., `duration_min` opt. | → `logWorkout` mutation; clears the file on success. Result as `log_workout`. `EINVAL` when no set is done (says to `discard_workout` instead). |
| `discard_workout` | `confirm: true` | Deletes the file. `{ ok, discarded: { started_at, done_sets } }`. |

### `get_capabilities`

No arguments. The first thing an agent should call in a conversation; also the tool whose
description the other descriptions point to. Result shape (exact keys):

```json
{
  "server": { "name": "opengym", "version": "0.2.0" },
  "mode": "remote",
  "writes": { "enabled": true, "reason": null },
  "profile": { "id": "…", "name": "Victor", "unit": "kg", "lang": "pt-BR", "effort_scale": "rir" },
  "counts": { "routines": 3, "workouts": 212, "custom_exercises": 4, "bodyweight_entries": 80 },
  "gyms_seen": ["Iron", "Smart Fit"],
  "active_session": { "open": false },
  "tools": {
    "read":    [{ "name": "list_routines", "use": "…one line…" }, …],
    "write":   [{ "name": "log_workout", "use": "…" }, …],
    "session": [{ "name": "start_workout", "use": "…" }, …]
  },
  "workflows": {
    "log_finished_workout":   ["search_exercises for anything not already an id", "log_workout with every exercise and set", "relay workout_id, volume and prs from the result"],
    "live_session":           ["start_workout", "get_active_workout when unsure what is next", "log_set per set", "edit_set / delete_set to correct", "finish_workout"],
    "correct_logged_set":     ["list_workouts or get_workout to find workout_id", "update_workout with the full corrected exercises list"],
    "last_weight_at_gym":     ["last_performance with exercise and gym"]
  },
  "limitations": [
    "gym is stored on the workout and in its note; the app's screens do not show it as a field",
    "a set given in plates is stored with a weight only when the exercise note carries '1 placa = X kg'",
    "writes are refused in file mode (set OPENGYM_URL and OPENGYM_TOKEN)",
    "an in-progress session lives on this server only; the phone's own running workout is separate"
  ],
  "units": { "weight": "kg", "speed": "km/h", "date": "YYYY-MM-DD", "time": "HH:MM" }
}
```

In file mode: `"writes": { "enabled": false, "reason": "file mode (OPENGYM_DATA): the api is the only writer of state-<uid>.json; set OPENGYM_URL and OPENGYM_TOKEN" }`,
and the `write` / `session` lists are still present (so the agent can say what it *would* take).

### Server instructions and the guide resource

`new McpServer({ name: 'opengym', version: '0.2.0' }, { instructions })` — SDK 1.32 supports
both `instructions` (`ServerOptions`) and `registerResource`. The resource `opengym://guide`
(`mimeType: text/markdown`) returns the same text with the tool catalogue appended from the
registered tools' descriptions, so it cannot drift from them. The instructions text, verbatim:

```
openGym MCP server — a self-hosted gym log. One profile. Everything you read or write here is
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
- Every write returns the record read back from the server with its id and rev; relay the id
  and the numbers, and say when a warning came back (e.g. plates without a kg factor).
```

## Concurrency and sync safety

- A write is conditional on the revision it read (`baseRev` + `baseWid`); a device that wrote in
  between makes the server answer 409 with its document, and `mutate` re-applies the pure
  mutation on that document and pushes once more. Two mutations cannot interleave inside one MCP
  process (`mutate` serialises through a promise chain).
- Each device polls `GET /api/data/rev` every 30 s and on every return to the foreground
  (`useStore.js` `checkRev`); a moved revision triggers `pullState`, which merges the server's
  document into the device's own copy (`mergeStates`) — union by id for workouts, per-field stamps
  for edited entries, the server's `deleted` record for removals. A workout logged by the MCP
  appears on the phone within a poll; a workout deleted by the MCP does not come back from a
  phone that still holds it, because the server recorded the removal.
- The phone's running session is `S.active`, device-local and stripped by the server; the MCP's
  running session is a local file. They never meet. The README warns that finishing both for the
  same training creates two records, and that `delete_workout` is the fix.
- A token revoked by *Sign out everywhere* fails every call with `EAUTH`; the message says to pair
  again. A disabled account reads the same.

## Test plan

New test files in `mcp/test/`, all vitest, run by the existing `npm test`:

- `mutations.test.js` — pure, seeded from `buildDemoState()` with fake timers as `tools.test.js`
  does. Per mutation: happy path; `logWorkout` today (PR badge awarded, `exWeights` raised,
  `vol` set, routine linked, `gym` on record and in the note) vs past date (filed chronologically,
  stamped, badges rebuilt, kept weights untouched); plates with and without a factor; warm-up rows
  excluded from volume and PRs; `updateWorkout` lowering a kept weight the edit removed;
  `deleteWorkout`; `addBodyweight` same-day replace; `setExerciseNote` clear; `editRoutine`
  create / reorder / remove / superset group; name resolution exact, localized (pt-BR), fuzzy
  and ambiguous.
- `write-tools.test.js` — the tool layer with `_setBackendForTests(fakeBackend)`: an in-memory
  backend with `read`/`write` that bumps `rev`, can be told to answer 409 once or twice, 401, or
  throw `ENET`. Asserts result shapes, error codes and messages, the read-back coming from the
  pushed state, the open-session guard on `log_workout`, and that every tool's zod schema parses
  its documented example and rejects the documented bad inputs (invalid date, empty sets, set
  with neither reps nor time, `plates` with `w`, `rir` with `rpe`).
- `session-tools.test.js` — `OPENGYM_SESSION_FILE` pointed at a temp dir; start from routine
  (rows match `preview_session`'s opening sets), freestyle, `log_set` ticking then appending,
  `edit_set`, `delete_set`, each `edit_active_workout` action, `finish_workout` producing the same
  record `log_workout` would from the same sets, discard, and a failed finish keeping the file.
- `remote.test.js` — `createRemoteBackend` against a stub `fetchImpl`: headers, body (`stamped:
  false`, `baseRev`, `baseWid`), status→code mapping, token renewal written to a temp
  `OPENGYM_TOKEN_FILE`, the `pair` subcommand's request and output.
- `capabilities.test.js` — shape of `get_capabilities` in file mode and remote mode; the
  instructions text contains every write tool's name; the guide resource lists every registered
  tool.
- `e2e.test.js` — boots `api/server.js` as a child the way `api/test/server-data-rev.test.js`
  does (`PORT=0`, temp `DATA_DIR` with a `secret` file and a `db.json` user, read the port from
  the boot line), mints a Bearer token with the same HMAC, seeds a demo state through
  `PUT /api/data`, then runs the real remote backend end to end: `log_workout` → the file on disk
  holds the workout and `_rev` moved; a concurrent `PUT` from a "phone" between read and write →
  the 409 retry lands both; `delete_workout` → `deleted.workouts[id]` is on disk; `EAUTH` with a
  garbage token; `ENET` with a closed port. Skipped with a clear reason if `api/node_modules` is
  missing (CI installs it: `test.yml` runs the api suite in the same job).
- Existing: `tools.test.js`, `state.test.js`, `labels.test.js` unchanged and green; `npm run
  check:node-loadable` green with the new modules listed; `cd api && npm test` and
  `cd frontend && npm test` unchanged (no file of theirs is touched — the diff proves it).

Failure cases the suite must cover, by code: `EPERM` (file mode write), `EAUTH`, `ENET`,
`ECONFLICT` after two 409s, `EAMBIG`, `ENOENT` (workout, routine), `EINVAL` (date, empty sets,
`plates` + `w`, open session guard, edit leaving no set), plates without factor (warning, not
error), `E2BIG` mapping.

## Documentation to update

- `mcp/README.md`: "Read-only" wording; a *Remote mode* section (env vars, the `pair` step,
  token file); a *What an LLM can do* section (the capability groups, the workflows, the
  limitations, the gym and plates conventions); the tools table extended; a *Hermes Agent*
  config example (`~/.hermes/config.yaml`, `mcp_servers:` with `command: node`, `args:
  [/abs/path/mcp/src/index.js]`, `env: { OPENGYM_URL, OPENGYM_TOKEN_FILE }` — the same stdio
  shape as the Claude Desktop block, which stays); the two-sessions caveat; Roadmap: phase 2
  done.
- `CLAUDE.md`: the `mcp/` line ("read-only" → "read, and write through the api with a paired
  token"; the new modules).
- `CONTRIBUTING.md` line 14: same wording.
- `docs/README.md`: this note in the dev-notes table.

## Versions

`mcp/package.json` `version` → `0.2.0`, echoed by `get_capabilities.server.version` and the
`McpServer` constructor.

## After review

The implementation went through an independent review and an end-to-end run against the real
`api/server.js` before it landed (`mcp/test/e2e.test.js`). Both found behaviour this note had
either under-specified or got wrong, and the fix phase changed it. The sections above are left as
written; where one of them says otherwise, this section wins.

- **A profile with no document yet is written, not refused.** *Access modes* and the tool
  sections said every write throws `ENOENT` until a device has synced once. The server creates
  the document on the first `PUT`, so a freshly paired account can be logged from the agent
  straight away: `log_workout`, `add_bodyweight`, `set_exercise_note`, `edit_routine` and the
  session tools run on the defaults (`unit kg`) and add a `warnings` entry saying the document
  was created. `update_workout`, `delete_workout` and `last_performance` still need history and
  keep `ENOENT`.
- **An explicit `start` files in time order and never in the future.** `log_workout` with
  `start` on today's date is inserted with `insertChronological` instead of appended (a 07:00
  session logged after a phone's 12:00 one sorts first). `start` with no `duration_min` runs
  until now — not 60 minutes, which could end after the clock. A `start` later than now, or an
  end past now plus a minute of grace, is `EINVAL`. `finish_workout` clamps its default end to
  now the same way.
- **`finish_workout` is idempotent.** A draft whose id is already in `S.workouts` (the push
  landed but the process died before the session file was removed) is recognised: no second
  push, the stored record comes back with `already_saved: true`, the file is cleared. A failure
  to clear the file after a successful push is a `warnings` entry, never a tool error.
- **The token is renewed throughout a long run.** `GET /api/me` was asked only on the first
  read; a process started with a fresh token and left running for `SESSION_DAYS` expired anyway.
  It is now asked again whenever the last answer is older than 12 hours, and a renewed `token`
  is adopted (and written to `OPENGYM_TOKEN_FILE`) as before.
- **The clock zone is reported and `TZ` is documented.** Every date the server reads or writes
  is the zone of the MCP process, which on a Docker host is usually UTC, not the user's. No date
  math changed; `get_capabilities` reports `clock: { timezone, today, now }`, the `instructions`
  tell the model so, and `mcp/README.md` puts `TZ` in both client config examples.
- **`log_set` keeps per-side and intensifier rows.** A planned row with `sides` (unilateral)
  gets the caller's weight and reps on both limbs — reps split evenly, an odd count is
  `EINVAL` — through `syncSideAggregate`; a planned drop set or rest-pause row ticked without
  numbers keeps its `drops` / `clusters`, and loses them with a warning when `w` or `r` is
  given. The description says so.
- **Warnings do not double on a 409 retry.** The mutation closures reset their `warnings`
  array before each attempt.
- **The cache is re-read after a write.** The pushed document serves the call's own read-back,
  then the next tool call fetches again, so a server-side correction (`stampPut` putting a
  field back, stored at `_rev + 2`) is never served from the cache.
- **Session tools need a resolved profile in remote mode.** With the first `GET /api/me`
  failed, the session file is no longer keyed by a null uid; the tool reports the remote error
  (`EAUTH`, `ENET`) instead.
- **`edit_routine` update semantics.** Sending `reps` for a slot that held a rep range clears
  `reps_min` / `reps_max`; switching a slot's mode drops the other modes' fields; a stored
  `weight` is kept when `weight` is omitted (it was zeroed). `confirm` is `z.literal(true)` on
  the delete path, as on `delete_workout` and `discard_workout`.
- **`update_workout.changed` names the input fields** (`date`, `start`, `duration_min`, …), not
  internal ones.
- **Search falls back to every language pack.** `search_exercises` and name resolution try the
  profile language first (as *Resolving names* says) and, when nothing matches, every
  `EXERCISE_NAME_LANGS` pack: "supino com barra" resolves on an English profile. A hit through
  another language is flagged (`matched_other_language`), and on an ambiguous query only an
  exact other-language name that is not also an English word may decide.
- **What the user typed is never a property lookup.** `constructor`, `__proto__`, `toString`
  and the like resolved to the catalogue index's own properties and produced an entry with no
  id. Every lookup by user input goes through `Object.hasOwn` and a string-id check.
- **The e2e suite is part of `npm test`.** It boots `api/server.js` as a child (so `api/`
  dependencies must be installed, as CI's `test.yml` already does for the api job) and drives
  the write and session tools in remote mode, including a 409 raced by a phone write.
