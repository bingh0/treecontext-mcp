/**
 * V2 echo heal — implementation pins (docs/session-identity.md §7.3 as
 * amended by §7.7). The owner-language promise lives in
 * tests/journal/journal-session-echo.feature (real hook subprocesses,
 * real MCP server); this file pins the mechanism: extractor edges, the
 * precedence/window/idempotency branches of
 * Persistence.healCuratedSessionIdentity, and the drain gate over a
 * synthetic staged echo.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterAll } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { extractInsertEcho, isInsertEchoTool } from '../../src/server/echo-correlation.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function freshStore(): Promise<FlatStore> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-echo-heal-'))
  dirs.push(dir)
  const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'echo.db')))
  return FlatStore.open({ database: db, ownsDatabase: true })
}

/** Compose a staged echo exactly the way post-tool-use.ts does: the
 *  response object serialized once into the Output section. */
function echoContent(response: unknown, input: unknown = { content: 'a note' }): string {
  return `Tool: mcp__treecontext__treecontext_insert\nInput:\n${JSON.stringify(input)}\nOutput:\n${JSON.stringify(response)}`
}

/** The reference platform's tool_response shape for an MCP call: content
 *  blocks whose text is the server's pretty-printed JSON (observed on the
 *  live store, 23/23 echoes). */
function mcpResponse(nodeId: string, deduplicated: boolean): unknown {
  return [{ type: 'text', text: JSON.stringify({ node_id: nodeId, path: [nodeId], depth: 0, deduplicated, drift_detected: false }, null, 2) }]
}

function rawNode(store: FlatStore, nodeId: string): { session_key: string; meta: Record<string, unknown> } {
  const row = store.store.database
    .prepare('SELECT session_key, metadata_json FROM nodes WHERE node_id = ?')
    .get(nodeId) as { session_key: string; metadata_json: string | null }
  return { session_key: row.session_key, meta: JSON.parse(row.metadata_json ?? '{}') as Record<string, unknown> }
}

const HEX = 'abcdef0123456789abcdef0123456789'

describe('extractInsertEcho: the Output section names the node', () => {
  it('extracts node_id and deduplicated from the platform response shape', () => {
    const echo = extractInsertEcho(echoContent(mcpResponse(HEX, false)))
    expect(echo).toEqual({ nodeId: HEX, deduplicated: false })
  })

  it('reads a dedup hit as deduplicated', () => {
    const echo = extractInsertEcho(echoContent(mcpResponse(HEX, true)))
    expect(echo).toEqual({ nodeId: HEX, deduplicated: true })
  })

  it('a failed insert (error payload, no node_id) extracts to null', () => {
    expect(extractInsertEcho(echoContent({ error: 'refused: read-only policy' }))).toBeNull()
  })

  it('a missing Output section extracts to null — no tool_response, no heal', () => {
    expect(extractInsertEcho('Tool: mcp__treecontext__treecontext_insert\nInput:\n{"content":"x"}')).toBeNull()
  })

  it('node ids inside the Input section are never read — extraction starts at the Output boundary', () => {
    const input = { content: `refers to node ${'f'.repeat(32)} in prose`, metadata: { node_id: 'e'.repeat(32) } }
    const echo = extractInsertEcho(echoContent(mcpResponse(HEX, false), input))
    expect(echo!.nodeId).toBe(HEX)
  })

  it('the FULL tail is never scanned — a preview error output with a node-id-bearing tail stays null', () => {
    const content =
      `Tool: mcp__treecontext__treecontext_insert\nInput:\n{"content":"x"}\nOutput:\n{"error":"boom"}` +
      `\n--- FULL ---\nInput:\n{"content":"names node_id\\": \\"${'d'.repeat(32)}"}\nOutput:\n{"error":"boom"}`
    expect(extractInsertEcho(content)).toBeNull()
  })

  it('tolerates a doubly-escaped response serialization', () => {
    const doubly = `[{"type":"text","text":"{\\"node_id\\": \\"${HEX}\\", \\"deduplicated\\": false}"}]`
    const echo = extractInsertEcho(`Tool: t\nInput:\n{}\nOutput:\n${JSON.stringify(doubly)}`)
    expect(echo!.nodeId).toBe(HEX)
  })

  it('a visible node_id with no visible deduplicated flag reads as a dedup hit — the cautious branch', () => {
    const echo = extractInsertEcho(`Tool: t\nInput:\n{}\nOutput:\n[{"type":"text","text":"{\\"node_id\\": \\"${HEX}\\""}]`)
    expect(echo).toEqual({ nodeId: HEX, deduplicated: true })
  })

  it('isInsertEchoTool matches by suffix — the client config key owns the prefix', () => {
    expect(isInsertEchoTool('mcp__treecontext__treecontext_insert')).toBe(true)
    expect(isInsertEchoTool('mcp__my-alias__treecontext_insert')).toBe(true)
    expect(isInsertEchoTool('mcp__treecontext__treecontext_query')).toBe(false)
    expect(isInsertEchoTool('Bash')).toBe(false)
    expect(isInsertEchoTool(null)).toBe(false)
  })
})

describe('healCuratedSessionIdentity: precedence, window, idempotency', () => {
  const T = 1_700_000_000

  async function curatedRow(store: FlatStore, meta: Record<string, unknown>, content = 'the note under heal', createdAt = T): Promise<string> {
    const r = await store.insert(content, { createdAt, metadata: meta })
    return r.nodeId
  }

  it('heals an absent row: id + src stamped, session_key column agrees', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {})
    const outcome = store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 0.1, deduplicated: false })
    expect(outcome).toBe('healed')
    const { session_key, meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-real')
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_prev']).toBeUndefined()
    expect(session_key).toBe('cc-real')
    await store.close()
  })

  it('displaces a disagreeing beacon guess, keeping it countable in _cc_session_prev', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, { _cc_session_id: 'cc-guess', _cc_session_src: 'beacon-unanimous' })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('healed')
    const { session_key, meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-real')
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_prev']).toBe('cc-guess')
    expect(session_key).toBe('cc-real')
    await store.close()
  })

  it('an agreeing beacon guess upgrades to echo certainty with no prev trace', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, { _cc_session_id: 'cc-real', _cc_session_src: 'beacon-unanimous' })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('healed')
    const { meta } = rawNode(store, id)
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_prev']).toBeUndefined()
    await store.close()
  })

  it('retires a beacon-ambiguous guess: flag and candidate list leave with the displaced guess', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {
      _cc_session_id: 'cc-guess',
      _cc_session_src: 'beacon-ambiguous',
      _cc_session_ambiguous: true,
      _cc_session_candidates: ['cc-guess', 'cc-other'],
    })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('healed')
    const { meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-real')
    expect(meta['_cc_session_prev']).toBe('cc-guess')
    expect(meta['_cc_session_ambiguous']).toBeUndefined()
    expect(meta['_cc_session_candidates']).toBeUndefined()
    await store.close()
  })

  it('never overwrites explicit or pid attribution', async () => {
    const store = await freshStore()
    for (const src of ['explicit', 'pid'] as const) {
      const id = await curatedRow(store, { _cc_session_id: 'cc-exact', _cc_session_src: src }, `note under ${src}`)
      expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('kept-exact')
      const { meta } = rawNode(store, id)
      expect(meta['_cc_session_id']).toBe('cc-exact')
      expect(meta['_cc_session_src']).toBe(src)
    }
    await store.close()
  })

  it('replaying the creator echo is a no-op: already-final, metadata unchanged', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {})
    store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })
    const before = rawNode(store, id)
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('already-final')
    expect(rawNode(store, id)).toEqual(before)
    await store.close()
  })

  it('a dedup-hit echo in-window discloses ambiguity without moving the primary attribution', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {})
    store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-creator', echoTs: T + 1, deduplicated: false })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-second', echoTs: T + 2, deduplicated: true })).toBe('ambiguous')
    const { session_key, meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-creator')
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_ambiguous']).toBe(true)
    expect(meta['_cc_session_candidates']).toEqual(['cc-creator', 'cc-second'])
    expect(session_key).toBe('cc-creator')
    await store.close()
  })

  it('replaying a dedup-hit echo never duplicates its candidate', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {})
    store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-creator', echoTs: T + 1, deduplicated: false })
    // A second session asserting a row the creator already owns IS the
    // multi-identity case: 'ambiguous', not 'asserted'. Pinned so the
    // two halves of the split vocabulary are both held down.
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-second', echoTs: T + 2, deduplicated: true })).toBe('ambiguous')
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-second', echoTs: T + 2, deduplicated: true })).toBe('already-final')
    const { meta } = rawNode(store, id)
    expect(meta['_cc_session_candidates']).toEqual(['cc-creator', 'cc-second'])
    await store.close()
  })

  it('echoes arriving out of order converge on the same state: creator primary, both disclosed', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {})
    // Dedup echo drains first (claim order is timestamp order, but two
    // sessions' echoes can stage out of order), creator echo second.
    // First assert on an unattributed row discloses ONE identity, so it
    // is 'asserted' — 'ambiguous' is reserved for a disclosure that
    // actually names more than one (V2 outcome split).
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-second', echoTs: T + 2, deduplicated: true })).toBe('asserted')
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-creator', echoTs: T + 1, deduplicated: false })).toBe('healed')
    const { meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-creator')
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_ambiguous']).toBe(true)
    expect([...(meta['_cc_session_candidates'] as string[])].sort()).toEqual(['cc-creator', 'cc-second'])
    await store.close()
  })

  // Upgrade path: rows healed by the PREVIOUS code carry
  // _cc_session_candidates but no _cc_session_echo_asserts. Recomputing
  // from scratch would drop an already-disclosed candidate.
  it('a legacy echo-healed row carries its disclosed candidates across the upgrade', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {
      _cc_session_id: 'cc-A', _cc_session_src: 'echo',
      _cc_session_ambiguous: true, _cc_session_candidates: ['cc-A', 'cc-B'],
    })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-C', echoTs: T + 1, deduplicated: true })).toBe('ambiguous')
    const { meta } = rawNode(store, id)
    expect([...(meta['_cc_session_candidates'] as string[])].sort()).toEqual(['cc-A', 'cc-B', 'cc-C'])
    await store.close()
  })

  // The old code accrued candidates from causal dedup echoes WITHOUT
  // changing src — so a beacon-unanimous row with candidates carries
  // echo evidence, and the seed must not be gated on src==='echo'
  // (Fable review 2026-08-20, F4: that gate re-opened the drop).
  it('a legacy beacon-unanimous row with echo-accrued candidates keeps them across the upgrade', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {
      _cc_session_id: 'cc-A', _cc_session_src: 'beacon-unanimous',
      _cc_session_ambiguous: true, _cc_session_candidates: ['cc-A', 'cc-B'],
    })
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-C', echoTs: T + 1, deduplicated: true })).toBe('ambiguous')
    const { meta } = rawNode(store, id)
    expect([...(meta['_cc_session_candidates'] as string[])].sort()).toEqual(['cc-A', 'cc-B', 'cc-C'])
    await store.close()
  })

  // ...but an insert-time GUESS is not evidence: causal echoes retire a
  // beacon-ambiguous candidate list rather than promoting it.
  it('a legacy beacon-ambiguous guess is retired, not promoted to an assert', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {
      _cc_session_id: 'cc-A', _cc_session_src: 'beacon-ambiguous',
      _cc_session_ambiguous: true, _cc_session_candidates: ['cc-A', 'cc-B'],
    })
    store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-C', echoTs: T + 1, deduplicated: false })
    const { meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-C')
    expect(meta['_cc_session_candidates']).toBeUndefined()
    await store.close()
  })

  it('a dedup-hit echo outside the window leaves the survivor untouched — the week-old-row guard', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, { _cc_session_id: 'cc-old', _cc_session_src: 'beacon-unanimous' }, 'old note', T - 7 * 86400)
    expect(store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-late', echoTs: T, deduplicated: true })).toBe('outside-window')
    const { session_key, meta } = rawNode(store, id)
    expect(meta['_cc_session_id']).toBe('cc-old')
    expect(meta['_cc_session_src']).toBe('beacon-unanimous')
    expect(session_key).toBe('cc-old')
    await store.close()
  })

  it('never touches an auto-capture row — its dedup anchor embeds session_key', async () => {
    const store = await freshStore()
    const r = await store.insert('an auto event', { createdAt: T, metadata: { source: 'auto-capture', role: 'user', session_id: 'sess-hook' } })
    expect(store.store.healCuratedSessionIdentity({ nodeId: r.nodeId, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })).toBe('not-curated')
    const { session_key } = rawNode(store, r.nodeId)
    expect(session_key).toBe('sess-hook')
    await store.close()
  })

  it('a vanished node is a disclosed miss, not a throw', async () => {
    const store = await freshStore()
    expect(store.store.healCuratedSessionIdentity({ nodeId: 'f'.repeat(32), echoSessionId: 'cc-x', echoTs: T, deduplicated: false })).toBe('not-found')
    await store.close()
  })

  it('a healed row stays findable: the heal never touches the FTS index', async () => {
    const store = await freshStore()
    const id = await curatedRow(store, {}, 'the flangewhistle calibration decision')
    store.store.healCuratedSessionIdentity({ nodeId: id, echoSessionId: 'cc-real', echoTs: T + 1, deduplicated: false })
    const hits = await store.query('flangewhistle calibration', { topK: 1 })
    expect(hits[0]?.nodeId).toBe(id)
    await store.close()
  })
})

describe('drain gate: a staged insert echo heals through ingestBatch', () => {
  it('an echo staged by the hook pipeline heals its row during the drain tick', async () => {
    const store = await freshStore()
    const now = Date.now() / 1000
    const r = await store.insert('drain-gated note', { createdAt: now, metadata: {} })
    store.store.insertStaging({
      sessionId: 'cc-drain',
      role: 'assistant',
      content: echoContent(mcpResponse(r.nodeId, false), { content: 'drain-gated note' }),
      toolName: 'mcp__treecontext__treecontext_insert',
      timestamp: now + 0.1,
      priority: 3,
    })
    const loop = new IngestionLoop(store, { batchSize: 10 })
    await loop.ingestBatch()
    const { session_key, meta } = rawNode(store, r.nodeId)
    expect(meta['_cc_session_id']).toBe('cc-drain')
    expect(meta['_cc_session_src']).toBe('echo')
    expect(session_key).toBe('cc-drain')
    // The echo itself still lands as a normal capture node.
    const rows = store.store.database.prepare("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'mcp__treecontext__treecontext_insert'").get() as { n: number }
    expect(rows.n).toBe(1)
    await store.close()
  })

  it('an echo with no session id heals nothing — never an invented attribution', async () => {
    const store = await freshStore()
    const now = Date.now() / 1000
    const r = await store.insert('unattributable note', { createdAt: now, metadata: {} })
    store.store.insertStaging({
      sessionId: null,
      role: 'assistant',
      content: echoContent(mcpResponse(r.nodeId, false)),
      toolName: 'mcp__treecontext__treecontext_insert',
      timestamp: now + 0.1,
      priority: 3,
    })
    const loop = new IngestionLoop(store, { batchSize: 10 })
    await loop.ingestBatch()
    const { meta } = rawNode(store, r.nodeId)
    expect(meta['_cc_session_id']).toBeUndefined()
    await store.close()
  })
})

describe('§7.8: status echoes and the session-namespace publisher', () => {
  it('extractStatusNamespace reads the serving namespace from the Output section', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    const status = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_name: 'treecontext', store_path: '/x/y.db', namespace: 'alpha', total_nodes: 3 }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(status)}`
    expect(extractStatusNamespace(content, '/x/y.db')).toBe('alpha')
  })

  it('a status output without the field, or a missing Output section, extracts to null', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    expect(extractStatusNamespace('Tool: t\nInput:\n{}\nOutput:\n{"error":"locked"}', '/x/y.db')).toBeNull()
    expect(extractStatusNamespace('Tool: t\nInput:\n{"namespace":"evil"}', '/x/y.db')).toBeNull()
  })

  // C#1: the status tool's suffix matches under ANY client server key, so
  // a session registering a SECOND treecontext server over a DIFFERENT
  // store would otherwise publish that store's namespace into this one's
  // annotations and misroute the whole session's capture. store_path is
  // the discriminator; a mismatch or an absence must fail closed.
  it('a status echo describing a DIFFERENT store publishes nothing', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    const foreign = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: '/other/store.db', namespace: 'theirs' }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(foreign)}`
    expect(extractStatusNamespace(content, '/x/y.db')).toBeNull()
    // ...in BOTH directions. The dangerous one is a foreign path that
    // EXTENDS ours — a bare startsWith only rejects shorter ones, so
    // `/x/y.db.old/treecontext.db` sitting beside our `/x/y.db` passed
    // the guard and published a foreign namespace (review of C#1).
    const extending = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: '/x/y.db.old/treecontext.db', namespace: 'theirs' }, null, 2) }]
    const extendingContent = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(extending)}`
    expect(extractStatusNamespace(extendingContent, '/x/y.db')).toBeNull()
    // ...and the shorter direction, which the bare prefix test did cover.
    expect(extractStatusNamespace(content, '/other/store.db.bak')).toBeNull()
    // The exact path still resolves — the terminator check must not
    // reject the case the guard exists to admit.
    const ours = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: '/x/y.db', namespace: 'ours' }, null, 2) }]
    expect(extractStatusNamespace(`Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(ours)}`, '/x/y.db')).toBe('ours')
  })

  // F5 (Fable review 2026-08-20): the terminator must be the value's
  // closing QUOTE through its escape levels — a lone backslash after
  // our prefix is a foreign path continuing (POSIX filenames may
  // contain literal backslashes), not a terminator.
  it('a foreign path continuing with a literal backslash after our prefix publishes nothing', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    const foreign = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: '/x/y.db\\evil/treecontext.db', namespace: 'theirs' }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(foreign)}`
    expect(extractStatusNamespace(content, '/x/y.db')).toBeNull()
  })

  // F6 (Fable review 2026-08-20): STATUS_NS_RE's first-match discipline
  // is safe only while the genuine `namespace` field serializes BEFORE
  // resume_pointers, whose previews are journal content. This pin makes
  // a status-shape field reorder fail loudly instead of silently
  // handing the extractor spoof-shaped preview text.
  it('spoof-shaped namespace text in a resume-pointer preview never outranks the genuine field', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    const status = [{
      type: 'text',
      text: JSON.stringify({
        backend: 'lexical', store_path: '/x/y.db', namespace: 'ours',
        resume_pointers: [{ preview: 'journal text quoting "namespace":"evil" and "store_path":"/x/y.db" verbatim' }],
      }, null, 2),
    }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(status)}`
    expect(extractStatusNamespace(content, '/x/y.db')).toBe('ours')
  })

  it('a status echo with no store_path at all publishes nothing', async () => {
    const { extractStatusNamespace } = await import('../../src/server/echo-correlation.js')
    const noPath = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', namespace: 'project' }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(noPath)}`
    expect(extractStatusNamespace(content, '/x/y.db')).toBeNull()
  })

  it('the drain publishes a session annotation from a status echo, and only with a storePath', async () => {
    const { readSessionNamespaceAnnotation } = await import('../../src/session-beacon.js')
    const store = await freshStore()
    const dbPath = (store.store.database.prepare('PRAGMA database_list').get() as { file: string }).file
    // store_path must name THIS store: it is the C#1 discriminator the
    // extractor checks before publishing anything.
    const status = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: dbPath, namespace: 'project' }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(status)}`
    const now = Date.now() / 1000
    // First without storePath: publisher is a no-op.
    store.store.insertStaging({ sessionId: 'cc-nopath', role: 'assistant', content, toolName: 'mcp__treecontext__treecontext_status', timestamp: now, priority: 3 })
    await new IngestionLoop(store, { batchSize: 10 }).ingestBatch()
    expect(readSessionNamespaceAnnotation(dbPath, 'cc-nopath')).toBeNull()
    // Then with it: the annotation lands, sourced status-echo.
    store.store.insertStaging({ sessionId: 'cc-status', role: 'assistant', content, toolName: 'mcp__treecontext__treecontext_status', timestamp: now + 1, priority: 3 })
    await new IngestionLoop(store, { batchSize: 10, storePath: dbPath }).ingestBatch()
    const annotation = readSessionNamespaceAnnotation(dbPath, 'cc-status')
    expect(annotation).toEqual(expect.objectContaining({ namespace: 'project', derived_from: 'status-echo' }))
    await store.close()
  })

  it('a correlated insert echo publishes the healed row\x27s namespace as insert-heal evidence', async () => {
    const { readSessionNamespaceAnnotation } = await import('../../src/session-beacon.js')
    const store = await freshStore()
    const dbPath = (store.store.database.prepare('PRAGMA database_list').get() as { file: string }).file
    const now = Date.now() / 1000
    const r = await store.insert('namespace evidence note', { createdAt: now, metadata: {} })
    store.store.insertStaging({
      sessionId: 'cc-heal-ns',
      role: 'assistant',
      content: echoContent(mcpResponse(r.nodeId, false), { content: 'namespace evidence note' }),
      toolName: 'mcp__treecontext__treecontext_insert',
      timestamp: now + 0.1,
      priority: 3,
    })
    await new IngestionLoop(store, { batchSize: 10, storePath: dbPath }).ingestBatch()
    const annotation = readSessionNamespaceAnnotation(dbPath, 'cc-heal-ns')
    expect(annotation).toEqual(expect.objectContaining({ namespace: 'project', derived_from: 'insert-heal' }))
    await store.close()
  })

  it('a hostile namespace value extracted from an echo is refused by the publisher', async () => {
    const { readSessionNamespaceAnnotation } = await import('../../src/session-beacon.js')
    const store = await freshStore()
    const dbPath = (store.store.database.prepare('PRAGMA database_list').get() as { file: string }).file
    const status = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', namespace: '..' }, null, 2) }]
    const content = `Tool: mcp__treecontext__treecontext_status\nInput:\n{}\nOutput:\n${JSON.stringify(status)}`
    store.store.insertStaging({ sessionId: 'cc-hostile-ns', role: 'assistant', content, toolName: 'mcp__treecontext__treecontext_status', timestamp: Date.now() / 1000, priority: 3 })
    await new IngestionLoop(store, { batchSize: 10, storePath: dbPath }).ingestBatch()
    expect(readSessionNamespaceAnnotation(dbPath, 'cc-hostile-ns')).toBeNull()
    await store.close()
  })

  it('a filesystem-hostile session id publishes nothing and reads as absent', async () => {
    const { writeSessionNamespaceAnnotation, readSessionNamespaceAnnotation } = await import('../../src/session-beacon.js')
    const store = await freshStore()
    const dbPath = (store.store.database.prepare('PRAGMA database_list').get() as { file: string }).file
    writeSessionNamespaceAnnotation(dbPath, '../escape', 'project', 'status-echo')
    expect(readSessionNamespaceAnnotation(dbPath, '../escape')).toBeNull()
    await store.close()
  })
})
