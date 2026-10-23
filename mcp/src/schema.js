/* Zod pieces every tool shares. tools.js keeps its own copy of isoDate() (left untouched — see
   docs/dev/MCP_WRITE.md, "Footprint"); the write tools import from here so the one calendar
   check is written once more rather than nine more times. */
import { z } from 'zod'

// A 'YYYY-MM-DD' the calendar actually has. The regex alone lets 2026-02-30 through, and
// new Date('2026-02-30T12:00:00') rolls over to March 2 — so a write would file a workout on a
// day the user never named. Round-trip through the same local-noon construction the handlers use
// and insist it comes back unchanged; as a zod refine that is a -32602 at the SDK boundary.
export const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
export const todayIso = () => localIso(new Date())
export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(
  v => { const d = new Date(v + 'T12:00:00'); return !Number.isNaN(d.getTime()) && localIso(d) === v },
  { message: 'not a date the calendar has (YYYY-MM-DD)' }
)

// 'HH:MM', 24-hour, local to the server the MCP runs on.
export const hhmm = () => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)')

// An error with the code the tool layer reports (ENOENT / EINVAL / EAMBIG / EPERM / …) and any
// extra fields an agent can act on (candidates, rev).
export function coded(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}
