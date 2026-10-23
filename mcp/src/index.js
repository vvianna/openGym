#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.
   No extra container, no new outbound network — your data stays in a folder you control. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { init, getUser, getMode, ready, refresh } from './state.js'
import { WRITE_TOOLS } from './write-tools.js'
import { SESSION_TOOLS } from './session-tools.js'
import { CAPABILITY_TOOLS, INSTRUCTIONS, guideMarkdown, SERVER_NAME, SERVER_VERSION } from './capabilities.js'
import { redeemPairCode, writeTokenFile } from './remote.js'

// `node src/index.js pair <url> <code>`: the one-time step that turns the code from Settings →
// Pair the mobile app into the Bearer token remote mode runs on. Prints it and exits; writes it
// to OPENGYM_TOKEN_FILE too when that is set. No server started, nothing else touched.
if (process.argv[2] === 'pair') {
  const [url, code] = process.argv.slice(3)
  if (!url || !code) { console.error('usage: node src/index.js pair <https://your-instance> <CODE>'); process.exit(2) }
  try {
    const { token, user } = await redeemPairCode(url, code)
    const file = (process.env.OPENGYM_TOKEN_FILE || '').trim()
    if (file) { writeTokenFile(file, token); console.error(`[opengym-mcp] token written to ${file}`) }
    console.error(`[opengym-mcp] paired with profile ${user?.name || '?'} (${user?.id || '?'})`)
    console.log(`OPENGYM_TOKEN=${token}`)
    process.exit(0)
  } catch (e) {
    console.error(`[opengym-mcp] ${e.code || 'ERROR'}: ${e.message}`)
    process.exit(1)
  }
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
}, { instructions: INSTRUCTIONS })

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
try {
  init()
  // Remote mode: the first read happens before the transport connects, so the read tools (which
  // call getState() synchronously) answer from a real document from the first call on.
  const u = getMode() === 'remote' ? await ready() : getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id}) — ${getMode()} mode${getMode() === 'remote' ? ', writes enabled' : ', read-only (set OPENGYM_URL for writes)'}`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

// Read tools (phase 1, tools.js) + write and session tools (phase 2) + the capability tool,
// which lists exactly what is registered here.
const GROUPS = { read: TOOLS.map(t => t.name), write: WRITE_TOOLS.map(t => t.name), session: SESSION_TOOLS.map(t => t.name) }
const ALL_TOOLS = [...TOOLS, ...WRITE_TOOLS, ...SESSION_TOOLS, ...CAPABILITY_TOOLS(GROUPS)]

for (const t of ALL_TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        // Remote mode re-reads the document when the cache is older than REMOTE_TTL_MS, so the
        // read tools stay untouched and still see what the phone just pushed.
        await refresh()
        const result = await t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        // An ambiguous name carries its candidates, so the agent can pick without a second search.
        const extra = code === 'EAMBIG' && Array.isArray(err.candidates) ? '\n' + JSON.stringify({ candidates: err.candidates }, null, 2) : ''
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}${extra}` }]
        }
      }
    }
  )
}

// The same guidance as the instructions, as a document a client can show or re-read, with the
// catalogue appended from the registered descriptions so it cannot drift from them.
server.registerResource(
  'guide', 'opengym://guide',
  { title: 'openGym MCP guide', description: 'How to use this server: rules, workflows, limitations and every tool.', mimeType: 'text/markdown' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guideMarkdown(ALL_TOOLS, GROUPS) }] })
)

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
