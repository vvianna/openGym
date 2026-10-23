// get_capabilities, the server instructions and the guide resource (mcp/src/capabilities.js):
// the shape an agent reads first, in file mode and in remote mode.
import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _setBackendForTests, _seedStateForTests, refresh } from '../src/state.js'
import { TOOLS } from '../src/tools.js'
import { WRITE_TOOLS } from '../src/write-tools.js'
import { SESSION_TOOLS } from '../src/session-tools.js'
import { CAPABILITY_TOOLS, INSTRUCTIONS, guideMarkdown, capabilitiesOf, SERVER_VERSION } from '../src/capabilities.js'
import { fakeBackend } from './fake-backend.mjs'

const GROUPS = { read: TOOLS.map(t => t.name), write: WRITE_TOOLS.map(t => t.name), session: SESSION_TOOLS.map(t => t.name) }
const ALL = [...TOOLS, ...WRITE_TOOLS, ...SESSION_TOOLS, ...CAPABILITY_TOOLS(GROUPS)]
let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cap-')); vi.stubEnv('OPENGYM_SESSION_FILE', path.join(tmp, 'active.json')) })
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe('get_capabilities', () => {
  test('file mode: writes disabled with the reason, the write tools still listed', () => {
    const S = buildDemoState(); S.lang = 'pt-BR'
    _seedStateForTests(S)
    const c = CAPABILITY_TOOLS(GROUPS)[0].handler()
    expect(c.server).toEqual({ name: 'opengym', version: SERVER_VERSION })
    expect(c.mode).toBe('file')
    expect(c.writes.enabled).toBe(false)
    expect(c.writes.reason).toMatch(/OPENGYM_URL and OPENGYM_TOKEN/)
    expect(c.profile).toMatchObject({ id: 'test-uid', name: 'Test', unit: 'kg', lang: 'pt-BR' })
    expect(['none', 'rir', 'rpe']).toContain(c.profile.effort_scale)
    expect(c.counts).toMatchObject({ routines: 3, custom_exercises: 0 })
    expect(c.counts.workouts).toBeGreaterThan(20)
    expect(c.gyms_seen).toEqual([])
    expect(c.active_session).toEqual({ open: false })
    expect(c.tools.read.map(t => t.name)).toEqual(GROUPS.read)
    expect(c.tools.write.map(t => t.name)).toEqual(GROUPS.write)
    expect(c.tools.write.every(t => t.use.length > 10)).toBe(true)
    expect(Object.keys(c.workflows)).toEqual(expect.arrayContaining(['log_finished_workout', 'live_session', 'correct_logged_set', 'last_weight_at_gym']))
    expect(c.limitations.some(l => /plates|placa/.test(l))).toBe(true)
    expect(c.units).toEqual({ weight: 'kg', speed: 'km/h', date: 'YYYY-MM-DD', time: 'HH:MM' })
  })

  test('remote mode: writes enabled, gyms on record, an open session reported', async () => {
    const S = buildDemoState(); S.unit = 'lb'
    S.workouts[0].gym = 'Iron'; S.workouts[1].gym = 'Smart Fit'; S.workouts[2].gym = 'iron'
    _setBackendForTests(fakeBackend(S, { user: { id: 'u1', name: 'Victor' } }), { id: 'u1', name: 'Victor' })
    await refresh(true)
    fs.writeFileSync(path.join(tmp, 'active.json'), JSON.stringify({ started_at: '2026-07-27T18:00', name: 'Push', gym: 'Iron', entries: [{ id: '0025', sets: [{ done: true }, { done: false }] }] }))
    const c = capabilitiesOf(GROUPS)
    expect(c.mode).toBe('remote')
    expect(c.writes).toEqual({ enabled: true, reason: null })
    expect(c.profile).toMatchObject({ id: 'u1', name: 'Victor', unit: 'lb' })
    expect(c.gyms_seen).toEqual(['Iron', 'Smart Fit', 'iron'])
    expect(c.active_session).toEqual({ open: true, started_at: '2026-07-27T18:00', name: 'Push', gym: 'Iron', done_sets: 1 })
    expect(c.units.weight).toBe('lb')
  })
})

describe('instructions and guide', () => {
  test('the instructions name get_capabilities, search_exercises and every write tool', () => {
    expect(INSTRUCTIONS).toMatch(/get_capabilities/)
    for (const t of WRITE_TOOLS) expect(INSTRUCTIONS).toContain(t.name)
    expect(INSTRUCTIONS).toMatch(/YYYY-MM-DD/)
    expect(INSTRUCTIONS).toMatch(/EAMBIG/)
  })
  test('the guide lists every registered tool with its description', () => {
    const md = guideMarkdown(ALL, GROUPS)
    expect(md.startsWith('# openGym MCP server — guide')).toBe(true)
    for (const t of ALL) {
      expect(md).toContain('### `' + t.name + '`')
      expect(md).toContain(t.description)
    }
    expect(md).toMatch(/## Workflows/)
    expect(md).toMatch(/## Limitations/)
  })
})
