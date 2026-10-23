# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, [Hermes Agent](https://github.com/NousResearch/hermes-agent)
over Telegram, etc.) read your openGym profile — routines, workouts, body-weight log, estimated
1RMs, and muscle balance — and, in **remote mode**, write to it: log a finished workout, run a
live session set by set, correct or delete a saved one, log a weigh-in, keep the standing note of
an exercise, create or edit a routine.

It runs locally as a stdio process spawned by the LLM client, adds no new container, and never
sees passkeys, VAPID keys or session secrets. Two ways to reach the data:

- **File mode** (`OPENGYM_DATA`): reads the same `state-<uid>.json` files the openGym api
  writes, straight from `./data`. Read-only — the api is the only writer of that file.
- **Remote mode** (`OPENGYM_URL` + a paired token): reads and writes through the api's own
  `GET`/`PUT /api/data`, the route the phone app syncs with, so every write is versioned,
  stamped and merged exactly as a device's would be, and every other device picks it up on its
  next sync. The MCP can run anywhere that reaches the instance — it needs no `./data`.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly, and a workout it writes is built
by the same code the Finish button runs. Design note: [`docs/dev/MCP_WRITE.md`](../docs/dev/MCP_WRITE.md).

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

**File mode** reads the `./data` directory `docker compose up` creates. Pick the profile to
answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

**Remote mode** talks to the running instance instead, and is what enables the write tools.
In the app, open Settings → Account → **Pair the mobile app**: it shows a one-time code (valid
five minutes). Redeem it once:

```bash
cd mcp
OPENGYM_TOKEN_FILE=~/.opengym-mcp/token node src/index.js pair https://gym.example.com ABCD2345
# → OPENGYM_TOKEN=<token>   (also written to the token file)
```

Then run with the instance URL and the token:

```bash
OPENGYM_URL=https://gym.example.com OPENGYM_TOKEN_FILE=~/.opengym-mcp/token node src/index.js
# or OPENGYM_TOKEN=<token> instead of the file
```

The token is the same kind a paired phone holds: it lasts `SESSION_DAYS`, the server renews it
past half its life (kept when `OPENGYM_TOKEN_FILE` is set), and "Sign out everywhere" in the app
revokes it. `OPENGYM_URL` is the instance origin, without `/api`. A live session started with
`start_workout` is kept in `~/.opengym-mcp/active-<uid>.json` (`OPENGYM_SESSION_FILE` to move it).

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>",  // optional — auto-detected if you have one profile
        "TZ": "America/Sao_Paulo"     // the user's zone: dates and "today" are read in it
      }
    }
  }
}
```

For remote mode replace the `env` block with `"OPENGYM_URL"` and `"OPENGYM_TOKEN_FILE"` (or
`"OPENGYM_TOKEN"`).

For **Hermes Agent** (a Telegram-facing agent is the typical pairing: "fiz supino 3×10 com 60 kg"
→ `log_workout`), add the same stdio server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  opengym:
    command: node
    args: ["/absolute/path/to/openGym/mcp/src/index.js"]
    env:
      OPENGYM_URL: "https://gym.example.com"
      OPENGYM_TOKEN_FILE: "/home/you/.opengym-mcp/token"
      TZ: "America/Sao_Paulo"
```

**Set `TZ` to the user's time zone.** Every date and time the server reads or writes (`today`,
a `start` of `22:00`, which day a late session files under) is the zone the MCP process runs in,
and a Docker host or a VPS is usually UTC — at 22:00 in São Paulo that is already tomorrow.
`get_capabilities` reports the zone in use (`clock.timezone`, `clock.today`).

A profile that has never synced from a device has no document on the server yet; the first
write creates it with the app's defaults (unit kg) and says so in the result's `warnings`.

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; the server's stderr says "serving profile \<name\> — remote mode, writes
enabled" (or "file mode, read-only").

## What an LLM can do

The server describes itself: `instructions` are delivered at the MCP handshake, every tool's
description says when to use it, when not to, what to call first, the units and formats and the
error codes it returns, and the `opengym://guide` resource holds the same text as markdown. An
agent should start with **`get_capabilities`**: it reports the mode, whether writes are enabled
(and why not), the profile's unit and language, the gyms already on record, whether a live
session is open, every tool grouped read / write / session, the recommended workflows and the
known limitations.

The workflows it recommends:

- **Log a finished workout** — `search_exercises` for anything that is not already an id,
  then one `log_workout` call with every exercise and set (and the gym); relay the
  `workout_id`, volume and PRs from the result.
- **Live session, set by set** — `start_workout` (from a routine: the opening sets are the
  app's own prescription), `get_active_workout` when unsure what is next, `log_set` per set
  ("fiz 12 com 45" — a number not given keeps the planned one), `edit_set` / `delete_set` to
  correct, `finish_workout`. The draft lives on the MCP's host and nothing reaches the server
  until the finish.
- **Correct a saved workout** — `list_workouts` or `get_workout` for the id, `update_workout`
  with the full corrected exercise list.
- **"Last time at gym X"** — `last_performance` with the exercise and the gym.
- **Machines counted in plates** — `set_exercise_note` once with "1 placa = 5 kg"; from then
  on a set may be given as `{ plates: 8 }` and is stored as 40 kg.

Conventions every write follows: weights are in the profile unit, totals on the bar or stack;
dates `YYYY-MM-DD`, times `HH:MM`; an ambiguous exercise name fails with `EAMBIG` and a
candidate list rather than a guess; every write returns the record read back from the server
with its id and revision. Known limitations: the gym is stored on the workout (`gym`) and at the
start of its note, but the app's screens do not show it as a field of its own; a set given in
plates is stored with a weight only when the exercise note carries the factor; writes are
refused in file mode; the MCP's live session and the phone's own running workout are separate
things — finishing both for the same training makes two records.

## Tools

Read tools (every mode):

| Tool | What it answers |
|---|---|
| `get_capabilities` | What can this server do for this profile? Mode, writes on/off, unit, language, gyms on record, open session, every tool, workflows, limitations. Call it first. |
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |
| `search_exercises` | Which exercise is "supino"? Name in any language the profile uses → id, English and localized name, body part, equipment; what the profile already trains ranks first. |
| `last_performance` | What did I do last time on the leg press — at Iron? Recent sessions with every set, the gym, best weight, best 1RM, the standing note and the last pinned note. |

Write tools (remote mode; `EPERM` in file mode):

| Tool | What it does |
|---|---|
| `log_workout` | Save a finished workout in one call: date, routine, gym, start, duration, note, exercises and sets (`w`/`plates`, `r`, `sec`, `min`, `speed`, `rir`/`rpe`, `failure`, `warmup`, notes). Today's session is filed like a live one (PRs, kept weights, progression); a past date the way the app logs a past workout. |
| `update_workout` | Correct a saved workout: the full exercise list, note, name, gym, date, start, duration. |
| `delete_workout` | Remove a saved workout (asks for `confirm: true`). |
| `add_bodyweight` | Log a weigh-in. |
| `set_exercise_note` | The standing note of an exercise: seat, pin, grip, "1 placa = 5 kg". |
| `edit_routine` | Create, change (name, emoji, exercises, order, targets, supersets, rest) or delete a routine. |

Session tools (the draft works in every mode; finishing needs remote mode):

| Tool | What it does |
|---|---|
| `start_workout` | Open a live session from a routine (opening sets = the app's prescription) or freestyle, with the gym. |
| `get_active_workout` | The open session: current exercise and its next set, every set planned and logged, what is left. |
| `log_set` | Tick the next planned set with the numbers given, or append one; names an exercise or takes the current one. |
| `edit_set` / `delete_set` | Correct or remove one set of the open session. |
| `edit_active_workout` | Skip, replace, move or add an exercise. |
| `finish_workout` | Save the session through `log_workout`'s path and return the record read back; a failed push keeps the draft. |
| `discard_workout` | Drop the open session (asks for `confirm: true`). |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none (zod for the schemas, as before). No
  database driver, no HTTP framework — remote mode is the platform `fetch`.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth, nothing new in the api.** File mode's boundary is the filesystem; remote mode
  uses the token a paired phone already gets (`POST /api/pair/redeem`) and the sync route the
  phone already writes through (`PUT /api/data` with `baseRev`, one retry on a 409). The api
  stamps and merges the write like any device's; `api/server.js` is untouched.
- **No telemetry.** File mode reads `./data/*.json`; remote mode talks to your instance only.
  Both exit when the LLM client disconnects.
- **Nothing reimplemented.** A workout is built by `buildCompletedWorkout`, filed by the same
  code as the Finish button or the past-workout sheet, corrected by the history editor's own
  functions; a live session opens with `buildSessionEntries`, the app's session builder.

## Tests

```bash
cd mcp && npm test
npm run check:node-loadable   # does the whole import graph still load under plain node?
```

The read tools are pinned against `frontend/src/lib/demoSeed.js` (the same deterministic
fixture the public demo runs on): JSON shape and the user-facing edge cases — rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas. The
write and session tools run over an in-memory stand-in for the api (`test/fake-backend.mjs`)
with no socket opened: the pure mutations, the read-back from the pushed document, the 409
retry, a refused token, an unreachable server, ambiguous names, plates without a factor, the
open-session guard, the draft surviving a restart, a finish that fails and keeps the draft.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 9 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Done (Phase 2):** remote mode over the api with a paired token; `search_exercises`,
  `last_performance`, `log_workout`, `update_workout`, `delete_workout`, `add_bodyweight`,
  `set_exercise_note`, `edit_routine`, the live-session tools, `get_capabilities`, server
  instructions and the `opengym://guide` resource ([design note](../docs/dev/MCP_WRITE.md)).
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
