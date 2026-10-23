// An in-memory stand-in for remote.js's backend: holds one document with a revision and a write
// id, bumps them on every accepted write, and can be told to answer the next write(s) with a 409
// (carrying the current document, as the api does), a 401, or a network failure. The write tools
// and the mutation layer are tested against this with no socket ever opened.
export function fakeBackend(initialState, { user = { id: 'u-test', name: 'Test' }, rev = 3 } = {}) {
  let doc = initialState ? { ...structuredClone(initialState), _rev: rev, _wid: 'wid' + rev } : null
  const be = {
    mode: 'remote',
    host: 'fake',
    user,
    reads: 0,
    writes: [],              // every accepted body: { state, baseRev, baseWid }
    conflictsLeft: 0,        // answer this many writes with ECONFLICT first
    failNext: null,          // 'EAUTH' | 'ENET' | 'EIO' — thrown by the next read or write
    // What a device would do in between: replace the document behind this backend's back.
    deviceWrites(mutator) {
      const next = structuredClone(doc || {})
      mutator(next)
      doc = { ...next, _rev: (doc?._rev || 0) + 1, _wid: 'dev' + ((doc?._rev || 0) + 1) }
    },
    get doc() { return doc },
    async me() { return { user, token: null } },
    async read() {
      be.reads++
      if (be.failNext) { const code = be.failNext; be.failNext = null; throw err(code) }
      return { state: doc ? structuredClone(doc) : null, rev: doc?._rev || 0, wid: doc?._wid || null, user }
    },
    async write(state, { baseRev = null, baseWid = null } = {}) {
      if (be.failNext) { const code = be.failNext; be.failNext = null; throw err(code) }
      if (be.conflictsLeft > 0) {
        be.conflictsLeft--
        const e = err('ECONFLICT'); e.rev = doc?._rev || 0; e.state = doc ? structuredClone(doc) : null
        throw e
      }
      if (baseRev != null && baseRev !== (doc?._rev || 0)) {
        const e = err('ECONFLICT'); e.rev = doc?._rev || 0; e.state = doc ? structuredClone(doc) : null
        throw e
      }
      const nextRev = (doc?._rev || 0) + 1
      doc = { ...structuredClone(state), _rev: nextRev, _wid: 'wid' + nextRev }
      be.writes.push({ state: structuredClone(state), baseRev, baseWid })
      return { rev: nextRev, wid: doc._wid }
    }
  }
  return be
}

function err(code) {
  const messages = {
    EAUTH: 'token refused by fake: it expired, was revoked by "Sign out everywhere", or the account is disabled — pair again',
    ENET: 'cannot reach fake: ECONNREFUSED',
    EIO: 'fake answered 500 on PUT /api/data',
    ECONFLICT: 'another device wrote this profile in between'
  }
  const e = new Error(messages[code] || code)
  e.code = code
  return e
}
