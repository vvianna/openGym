// remote.js against a stub fetch: the requests it builds (headers, body), the status → code
// mapping, token renewal through GET /api/me, the token file, and the pair subcommand's call.
// Nothing here opens a socket; the real api is exercised by e2e.test.js.
import { describe, test, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRemoteBackend, redeemPairCode, writeTokenFile } from '../src/remote.js'

const dirs = []
afterEach(() => { dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })) })
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-')); dirs.push(d); return d }

// A fetch that answers from a script of [status, body] per call and records every request.
function stubFetch(script) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined })
    const next = script.shift()
    if (!next) throw new Error('unexpected call ' + url)
    if (next instanceof Error) throw next
    const [status, body] = next
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
  }
  return { fetchImpl, calls }
}

const ME = [200, { user: { id: 'u1', name: 'Victor', admin: false } }]
const DOC = [200, { state: { unit: 'kg', routines: [], workouts: [], _rev: 7, _wid: 'w7' }, rev: 7 }]

describe('createRemoteBackend', () => {
  test('refuses a URL without a scheme, one ending in /api, and no token', () => {
    expect(() => createRemoteBackend({ url: 'gym.example.com', token: 't' })).toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(() => createRemoteBackend({ url: 'https://gym.example.com/api', token: 't' })).toThrow(/leave \/api off/)
    expect(() => createRemoteBackend({ url: 'https://gym.example.com' })).toThrow(expect.objectContaining({ code: 'EAUTH' }))
  })

  test('read: GET /api/me once, then GET /api/data with the Bearer header; a trailing slash is tolerated', async () => {
    const { fetchImpl, calls } = stubFetch([ME, DOC, DOC])
    const be = createRemoteBackend({ url: 'https://gym.example.com/', token: 'tok-1', fetchImpl })
    const r = await be.read()
    expect(r).toMatchObject({ rev: 7, wid: 'w7', user: { id: 'u1', name: 'Victor' } })
    expect(r.state.unit).toBe('kg')
    await be.read()
    expect(calls.map(c => c.method + ' ' + c.url)).toEqual(['GET https://gym.example.com/api/me', 'GET https://gym.example.com/api/data', 'GET https://gym.example.com/api/data'])
    expect(calls[1].headers.Authorization).toBe('Bearer tok-1')
    expect(be.host).toBe('gym.example.com')
  })

  test('write: PUT /api/data with stamped: false, baseRev and baseWid; answers rev and wid', async () => {
    const { fetchImpl, calls } = stubFetch([[200, { ok: true, rev: 8, wid: 'w8' }]])
    const be = createRemoteBackend({ url: 'http://localhost:3000', token: 'tok', fetchImpl })
    const r = await be.write({ unit: 'kg', workouts: [] }, { baseRev: 7, baseWid: 'w7' })
    expect(r).toEqual({ rev: 8, wid: 'w8' })
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'http://localhost:3000/api/data', body: { state: { unit: 'kg', workouts: [] }, stamped: false, baseRev: 7, baseWid: 'w7' } })
    expect(calls[0].headers['Content-Type']).toBe('application/json')
  })

  test('status → code: 401 EAUTH, 409 ECONFLICT with the document, 413 E2BIG, 503 EIO, 500 EIO, network ENET', async () => {
    const boom = new Error('fetch failed'); boom.cause = { code: 'ECONNREFUSED' }
    const { fetchImpl } = stubFetch([[401, { error: 'not signed in' }], [409, { error: 'conflict', rev: 9, state: { _rev: 9 } }], [413, { error: 'body too large' }], [503, { error: 'state unreadable' }], [500, { error: 'boom' }], boom])
    const be = createRemoteBackend({ url: 'https://gym.example.com', token: 'secret-token', fetchImpl })
    const w = () => be.write({ unit: 'kg' }, { baseRev: 1 })
    const codes = []
    for (let i = 0; i < 6; i++) { try { await w() } catch (e) { codes.push(e); } }
    expect(codes.map(e => e.code)).toEqual(['EAUTH', 'ECONFLICT', 'E2BIG', 'EIO', 'EIO', 'ENET'])
    expect(codes[0].message).toMatch(/pair again/)
    expect(codes[1]).toMatchObject({ rev: 9, state: { _rev: 9 } })
    expect(codes[4].message).toMatch(/500/)
    expect(codes[5].message).toMatch(/ECONNREFUSED/)
    for (const e of codes) expect(e.message).not.toMatch(/secret-token/)
  })

  test('a renewed token from GET /api/me is adopted and written to the token file; the file wins at start', async () => {
    const dir = tmpDir()
    const file = path.join(dir, 'sub', 'token')
    writeTokenFile(file, 'from-file')
    expect(fs.readFileSync(file, 'utf8')).toBe('from-file\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const { fetchImpl, calls } = stubFetch([[200, { user: { id: 'u1', name: 'V' }, token: 'renewed' }], DOC])
    const logged = []
    const be = createRemoteBackend({ url: 'https://gym.example.com', token: 'from-env', tokenFile: file, fetchImpl, log: m => logged.push(m) })
    expect(be.token).toBe('from-file')
    await be.read()
    expect(calls[0].headers.Authorization).toBe('Bearer from-file')
    expect(calls[1].headers.Authorization).toBe('Bearer renewed')
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('renewed')
    expect(logged).toEqual([])
  })

  test('without a token file a renewal is kept in memory and hinted once on stderr', async () => {
    const { fetchImpl } = stubFetch([[200, { user: { id: 'u1' }, token: 'renewed' }], DOC, [200, { user: { id: 'u1' }, token: 'renewed-2' }]])
    const logged = []
    const be = createRemoteBackend({ url: 'https://gym.example.com', token: 'env', fetchImpl, log: m => logged.push(m) })
    await be.read()
    await be.me()
    expect(be.token).toBe('renewed-2')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/OPENGYM_TOKEN_FILE/)
  })
})

describe('redeemPairCode', () => {
  test('POSTs the upper-cased code and returns the token and user', async () => {
    const { fetchImpl, calls } = stubFetch([[200, { token: 'tok', user: { id: 'u1', name: 'V' } }]])
    const r = await redeemPairCode('https://gym.example.com/', ' abcd2345 ', { fetchImpl })
    expect(r).toEqual({ token: 'tok', user: { id: 'u1', name: 'V' } })
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://gym.example.com/api/pair/redeem', body: { code: 'ABCD2345' } })
    expect(calls[0].headers.Authorization).toBeUndefined()
  })
  test('400 is EINVAL (wrong or expired code), network ENET', async () => {
    const { fetchImpl } = stubFetch([[400, { error: 'invalid or expired code', code: 'pair-invalid' }], new Error('fetch failed')])
    await expect(redeemPairCode('https://gym.example.com', 'X', { fetchImpl })).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(redeemPairCode('https://gym.example.com', 'X', { fetchImpl })).rejects.toMatchObject({ code: 'ENET' })
  })
})
