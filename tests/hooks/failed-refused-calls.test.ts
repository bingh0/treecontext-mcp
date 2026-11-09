/**
 * Failed and refused tool calls (D400, D401): implementation pins beside
 * the charter scenarios in features/journal-capture.feature, which replay
 * the recorded Claude Code events through the hooks install wires.
 *
 * What these pin: the entry's composition for a failure and for the
 * batch's account (one layout, one trail-and-treasure rule), the batch
 * reconcile against staging (drained rows included), a store below schema
 * 034 (the failure stages as before, the batch adds nothing, nothing is
 * migrated), where a batch's failures go (the gap ledger, never one record
 * per call that was captured), and the drain's interplay: the echo heals,
 * session-scoped dedup (D80), the retention valve's classes, a subagent's
 * writer stamp and a `claude -p` worker's lane.
 *
 * Payloads marked "recorded" are lines of tests/fixtures/claude-code-hooks
 * as the client wrote them; a payload marked "constructed" is written here
 * to reach a branch no recorded session holds, and is never called the
 * client's.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { composeToolEntry, batchCallsOf, failureOutcome } from '../../src/hooks/post-tool-use.js'
import { stageBatchAccount } from '../../src/hooks/shared.js'
import { gapLedgerPaths } from '../../src/hooks/gap-ledger.js'
import { TOOL_OUTPUT_PREVIEW_CAP, FULL_TAIL_SEPARATOR } from '../../src/persistence/capture-constants.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { readTicket, mintTicket } from '../../src/ticket.js'
import { workerLaneOf } from '../../src/persistence/leg-registry.js'
import { isDoorCapture } from '../../src/run-kinds.js'
import { openCaptureWorld, drainStaging, rawJournal, type CaptureWorld } from '../journal/capture-harness.js'
import { recordedSession, replayRecordedSession } from '../journal/standins.js'

const SERIAL = recordedSession('2.1.319', 'serial-failures-and-denials.ndjson')
const PARALLEL = recordedSession('2.1.319', 'parallel-batch-hook-block-mcp-errors-subagent.ndjson')
const lineOf = (events: Array<Record<string, unknown>>, event: string, id: string): Record<string, unknown> => {
  const hit = events.find((e) => e['hook_event_name'] === event && (e['tool_use_id'] === id
    || (Array.isArray(e['tool_calls']) && (e['tool_calls'] as Array<Record<string, unknown>>).some((c) => c['tool_use_id'] === id))))
  if (!hit) throw new Error(`no recorded ${event} for ${id}`)
  return hit
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})
function world(): CaptureWorld {
  return { defer: (f: () => unknown) => { cleanups.push(f) } } as unknown as CaptureWorld
}
function tmpStore(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-failed-calls-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'treecontext.db') }
}
async function open(path: string): Promise<FlatStore> {
  const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
  cleanups.push(() => s.close())
  return s
}
function stagingRows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT * FROM staging ORDER BY id').all() as Array<Record<string, unknown>> } finally { db.close() }
}
function nodes(store: FlatStore): Array<{ node_id: string; source_label: string; meta: Record<string, unknown> }> {
  return (store.store.database.prepare('SELECT node_id, source_label, metadata_json FROM nodes ORDER BY rowid').all() as Array<{ node_id: string; source_label: string; metadata_json: string }>)
    .map((r) => ({ node_id: r.node_id, source_label: r.source_label, meta: JSON.parse(r.metadata_json) as Record<string, unknown> }))
}

describe('composition: a failure and the batch\'s account are composed as a success is', () => {
  it('a failure\'s error text is its Output section, in the success layout (recorded payload)', () => {
    const p = lineOf(SERIAL, 'PostToolUseFailure', 'toolu_01Uce7kGn9KwGNm8bkJRj8rr')
    const e = composeToolEntry(String(p['tool_name']), p['tool_input'], p['error'])
    expect(e.content).toBe('Tool: Bash\nInput:\ncommand:\nsh -c "echo to-stdout; echo to-stderr >&2; exit 7"\n'
      + 'description:\nRun shell that writes stdout and stderr and exits 7\nOutput:\nExit code 7\nto-stdout\nto-stderr')
    expect(e.priority).toBe(2)
    expect(failureOutcome(p)).toBe('failed')
  })

  it('is_interrupt true reads as interrupted (constructed: no recorded session holds an interrupt)', () => {
    const p = { ...lineOf(SERIAL, 'PostToolUseFailure', 'toolu_01Uce7kGn9KwGNm8bkJRj8rr'), is_interrupt: true }
    expect(failureOutcome(p)).toBe('interrupted')
  })

  it('the trail and treasure rule holds for a long error text (constructed error texts)', () => {
    const long = `Exit code 1\n${'x'.repeat(TOOL_OUTPUT_PREVIEW_CAP * 2)}\nTAILWORD`
    const bash = composeToolEntry('Bash', { command: 'npm test' }, long)
    expect(bash.content).toContain(FULL_TAIL_SEPARATOR)
    expect(bash.content).toContain('TAILWORD')
    expect(bash.previewLen).not.toBeNull()
    const read = composeToolEntry('Read', { file_path: '/x' }, long)
    expect(read.content).not.toContain(FULL_TAIL_SEPARATOR)
    expect(read.previewLen).toBeNull()
  })

  it('the batch\'s account composes each call with what the model was told, as the batch\'s writer, marked batch (recorded payload)', () => {
    const batch = PARALLEL[30]!
    expect(batch['hook_event_name']).toBe('PostToolBatch')
    const calls = batchCallsOf(batch, 1000)
    expect(calls.map((c) => c.toolUseId)).toEqual(['toolu_01M7pR8G3pzPXhq8xQkcfzSY'])
    const e = calls[0]!.entry
    expect(e).toMatchObject({ toolName: 'Write', timestamp: 1000, agentId: 'a9f2af13f809ba211', capturedFrom: 'batch', toolUseId: 'toolu_01M7pR8G3pzPXhq8xQkcfzSY' })
    expect(e.outcome).toBeUndefined()
    expect(e.content.endsWith("Output:\nClaude requested permissions to write to /etc/sub-denied.txt, but you haven't granted it yet.")).toBe(true)
  })
})

describe('the batch reconcile, through the real hook', () => {
  it('a call already staged is not added again, drained or not; one with no event of its own is (recorded payloads)', async () => {
    const w = world()
    await openCaptureWorld(w)
    // The parallel session's first batch: three calls with events of their own.
    replayRecordedSession(w, PARALLEL, { lines: (l) => l <= 7 })
    await drainStaging(w)
    // Drained: their rows are processed = 1, still in staging.
    expect(stagingRows(w.dbPath!).filter((r) => r['tool_use_id'] !== null).every((r) => r['processed'] === 1)).toBe(true)
    replayRecordedSession(w, PARALLEL, { lines: (l) => l === 8 })
    const added = stagingRows(w.dbPath!).filter((r) => r['captured_from'] === 'batch')
    expect(added.map((r) => r['tool_use_id'])).toEqual(['toolu_01GNi6XzvVa1DEG9jzB5ePuH'])
    // The same batch delivered again adds nothing.
    replayRecordedSession(w, PARALLEL, { lines: (l) => l === 8 })
    expect(stagingRows(w.dbPath!).filter((r) => r['captured_from'] === 'batch')).toHaveLength(1)
  })

  it('a subagent\'s failed and refused calls drain stamped with the subagent as writer, like its successful ones (recorded payloads)', async () => {
    const w = world()
    await openCaptureWorld(w)
    replayRecordedSession(w, PARALLEL)
    await drainStaging(w)
    const rows = rawJournal(w)
    const of = (id: string) => rows.find((r) => r.metadata['tool_use_id'] === id)!
    for (const id of ['toolu_01Cr1UTEpAkRXzhLfE7EFfQW', 'toolu_01LNeMbyiywm5AQujEKL5YYX', 'toolu_01M7pR8G3pzPXhq8xQkcfzSY', 'toolu_01VCEYEndqs8NLCYxquxWvuZ']) {
      expect(of(id).metadata['_writer_agent_id'], id).toBe('a9f2af13f809ba211')
      expect(of(id).metadata['_writer'], id).toBe(of('toolu_01LNeMbyiywm5AQujEKL5YYX').metadata['_writer'])
      expect(of(id).metadata['_writer_src'], id).toBe('hook')
    }
    expect(of('toolu_01Cr1UTEpAkRXzhLfE7EFfQW').metadata['outcome']).toBe('failed')
    expect(of('toolu_01M7pR8G3pzPXhq8xQkcfzSY').metadata['captured_from']).toBe('batch')
    // The main agent's calls name no writer.
    expect(of('toolu_01CJ3mnjPCSEkJMQDpg4Hs9a').metadata['_writer_agent_id']).toBeUndefined()
  })
})

describe('a store below schema 034: hooks never migrate', () => {
  it('the failure stages as before, unmarked, and the batch adds nothing (recorded payloads)', async () => {
    const w = world()
    await openCaptureWorld(w)
    // A store at 033: one journal row (so no hook takes it for a fresh
    // store to bootstrap), the three columns and the index taken out.
    await w.store!.insert('a row from before', { metadata: {} })
    await w.store!.close()
    const db = new DatabaseSync(w.dbPath!)
    db.exec('DROP INDEX idx_staging_tool_use; ALTER TABLE staging DROP COLUMN tool_use_id; ALTER TABLE staging DROP COLUMN outcome; ALTER TABLE staging DROP COLUMN captured_from; PRAGMA user_version = 33')
    db.close()
    replayRecordedSession(w, SERIAL, { lines: (l) => l >= 5 && l <= 7 })
    replayRecordedSession(w, SERIAL, { lines: (l) => l === 17 })
    const rows = stagingRows(w.dbPath!)
    expect(rows).toHaveLength(1)
    expect(rows[0]!['tool_name']).toBe('Bash')
    expect(String(rows[0]!['content'])).toContain('Output:\nExit code 2\n')
    expect('tool_use_id' in rows[0]!).toBe(false)
    // By design, not by a failure: no gap record says a batch was lost.
    expect(gapLedgerPaths(w.dbPath!).filter(existsSync).flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean))).toEqual([])
    const check = new DatabaseSync(w.dbPath!, { readOnly: true })
    try { expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(33) } finally { check.close() }
    expect(maxSupportedVersion).toBe(34)
  })
})

describe('where the batch\'s failures go (D314)', () => {
  it('a write refused after the lookup is one gap record per call the batch was adding, none for the captured (recorded payload, in process)', async () => {
    const { path } = tmpStore()
    const s = await open(path)
    const batch = PARALLEL[8]!
    const sid = String(batch['session_id'])
    // The two calls with events of their own that succeeded and failed are staged.
    s.store.insertStaging({ sessionId: sid, role: 'assistant', content: 'Tool: Bash', toolName: 'Bash', timestamp: 1, toolUseId: 'toolu_01ExmFevbQgvcsxnJm65RtcV' })
    s.store.insertStaging({ sessionId: sid, role: 'assistant', content: 'Tool: Bash', toolName: 'Bash', timestamp: 2, toolUseId: 'toolu_01CJ3mnjPCSEkJMQDpg4Hs9a', outcome: 'failed' })
    s.store.database.exec("CREATE TRIGGER refuse_batch BEFORE INSERT ON staging WHEN NEW.captured_from = 'batch' BEGIN SELECT RAISE(ABORT, 'refused for the test'); END")
    const r = stageBatchAccount(path, sid, batchCallsOf(batch, 3))
    expect(r).toEqual({ staged: [], captured: [] })
    const gaps = gapLedgerPaths(path).filter(existsSync).flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>))
    expect(gaps.map((g) => g['lost'])).toEqual([
      "The Edit call toolu_01GNi6XzvVa1DEG9jzB5ePuH the batch's account carried was not staged.",
      "The ToolSearch call toolu_01JgTCyS5FH3JHaaVBfwvfFH the batch's account carried was not staged.",
    ])
    expect(stagingRows(path).filter((x) => x['captured_from'] === 'batch')).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a store the hook cannot open for writing is one gap record for the whole batch (recorded payload)', async () => {
    const { dir, path } = tmpStore()
    const s = await open(path)
    await s.close()
    chmodSync(path, 0o444)
    chmodSync(dir, 0o555)
    cleanups.push(() => { chmodSync(dir, 0o755); chmodSync(path, 0o644) })
    const batch = PARALLEL[8]!
    stageBatchAccount(path, String(batch['session_id']), batchCallsOf(batch, 3))
    const gaps = gapLedgerPaths(path).filter(existsSync).flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>))
      .filter((g) => g['sessionId'] === batch['session_id'])
    expect(gaps).toHaveLength(1)
    expect(String(gaps[0]!['lost'])).toMatch(/^The batch's account of 4 calls was not checked against what was captured/)
    for (const id of ['toolu_01ExmFevbQgvcsxnJm65RtcV', 'toolu_01CJ3mnjPCSEkJMQDpg4Hs9a', 'toolu_01GNi6XzvVa1DEG9jzB5ePuH', 'toolu_01JgTCyS5FH3JHaaVBfwvfFH']) {
      expect(String(gaps[0]!['lost'])).toContain(id)
    }
  })
})

/** A treecontext_insert reply naming a real row: what would heal it, were
 *  it a call's own successful echo (constructed, the server's shape). */
function insertReply(nodeId: string): unknown {
  return [{ type: 'text', text: JSON.stringify({ node_id: nodeId, path: [nodeId], depth: 0, deduplicated: false }, null, 2) }]
}

describe('the drain: a failed call and the batch\'s account heal nothing and are ordinary captured tool rows', () => {
  it('a treecontext_insert arriving as a failure or in the batch heals nothing; the same text as its own success heals (constructed payloads)', async () => {
    const { path } = tmpStore()
    const s = await open(path)
    const now = Date.now() / 1000
    const tool = 'mcp__treecontext__treecontext_insert'
    const rows: Array<{ sid: string; extra: Record<string, unknown> }> = [
      { sid: 'cc-failed', extra: { outcome: 'failed', toolUseId: 'toolu_c1' } },
      { sid: 'cc-batch', extra: { capturedFrom: 'batch', toolUseId: 'toolu_c2' } },
      { sid: 'cc-own', extra: { toolUseId: 'toolu_c3' } },
    ]
    const ids: string[] = []
    for (const [i, r] of rows.entries()) {
      const target = await s.insert(`the note ${r.sid}`, { createdAt: now, metadata: {} })
      ids.push(target.nodeId)
      const e = composeToolEntry(tool, { content: `the note ${r.sid}` }, insertReply(target.nodeId))
      s.store.insertStaging({ sessionId: r.sid, role: 'assistant', content: e.content, toolName: tool, timestamp: now + 0.1 + i, priority: e.priority, ...r.extra })
    }
    await new IngestionLoop(s, { batchSize: 10, storePath: path }).ingestBatch()
    const metaOf = (id: string) => nodes(s).find((n) => n.node_id === id)!.meta
    expect(metaOf(ids[0]!)['_cc_session_id']).toBeUndefined()
    expect(metaOf(ids[1]!)['_cc_session_id']).toBeUndefined()
    expect(metaOf(ids[2]!)['_cc_session_id']).toBe('cc-own')
    // The echoes themselves landed, marked.
    const echoes = nodes(s).filter((n) => n.meta['tool_name'] === tool)
    expect(echoes.map((n) => [n.meta['tool_use_id'], n.meta['outcome'], n.meta['captured_from']])).toEqual([
      ['toolu_c1', 'failed', undefined], ['toolu_c2', undefined, 'batch'], ['toolu_c3', undefined, undefined],
    ])
  })

  it('a status echo arriving as a failure publishes no namespace (constructed payload)', async () => {
    const { readSessionNamespaceAnnotation } = await import('../../src/session-beacon.js')
    const { path } = tmpStore()
    const s = await open(path)
    const status = [{ type: 'text', text: JSON.stringify({ backend: 'lexical', store_path: path, namespace: 'project' }) }]
    const e = composeToolEntry('mcp__treecontext__treecontext_status', {}, status)
    s.store.insertStaging({ sessionId: 'cc-st-failed', role: 'assistant', content: e.content, toolName: 'mcp__treecontext__treecontext_status', timestamp: Date.now() / 1000, outcome: 'failed', toolUseId: 'toolu_s1' })
    await new IngestionLoop(s, { batchSize: 10, storePath: path }).ingestBatch()
    expect(readSessionNamespaceAnnotation(path, 'cc-st-failed')).toBeNull()
  })

  it('two identical failed commands dedup as two identical successful ones do (D80; recorded error text)', async () => {
    const { path } = tmpStore()
    const s = await open(path)
    const p = lineOf(SERIAL, 'PostToolUseFailure', 'toolu_01FvqNcZYBnuCsHBiwp6o3Mj')
    const failed = composeToolEntry('Bash', p['tool_input'], p['error'])
    const ok = composeToolEntry('Bash', { command: 'echo same' }, { stdout: 'same', stderr: '' })
    const t = Date.now() / 1000
    s.store.insertStaging({ sessionId: 'cc-d', role: 'assistant', content: failed.content, toolName: 'Bash', timestamp: t, outcome: 'failed', toolUseId: 'toolu_f1' })
    s.store.insertStaging({ sessionId: 'cc-d', role: 'assistant', content: failed.content, toolName: 'Bash', timestamp: t + 1, outcome: 'failed', toolUseId: 'toolu_f2' })
    s.store.insertStaging({ sessionId: 'cc-d', role: 'assistant', content: ok.content, toolName: 'Bash', timestamp: t + 2, toolUseId: 'toolu_o1' })
    s.store.insertStaging({ sessionId: 'cc-d', role: 'assistant', content: ok.content, toolName: 'Bash', timestamp: t + 3, toolUseId: 'toolu_o2' })
    await new IngestionLoop(s, { batchSize: 10 }).ingestBatch()
    const n = (text: string) => nodes(s).filter((x) => x.meta['tool_name'] === 'Bash' && s.store.getContent(x.node_id) === text).length
    expect(n(failed.content)).toBe(n(ok.content))
    expect(n(ok.content)).toBeGreaterThan(0)
  })

  it('the retention valve reads them as captured tool rows: auto-capture, unprotected, not door capture', async () => {
    const { path } = tmpStore()
    const s = await open(path)
    const t = Date.now() / 1000
    s.store.insertStaging({ sessionId: 'cc-v', role: 'assistant', content: 'Tool: Bash\nInput:\nls\nOutput:\nExit code 2', toolName: 'Bash', timestamp: t, outcome: 'failed', toolUseId: 'toolu_v1' })
    s.store.insertStaging({ sessionId: 'cc-v', role: 'assistant', content: 'Tool: Edit\nInput:\nx\nOutput:\n<tool_use_error>no</tool_use_error>', toolName: 'Edit', timestamp: t + 1, capturedFrom: 'batch', toolUseId: 'toolu_v2' })
    await new IngestionLoop(s, { batchSize: 10 }).ingestBatch()
    const rows = nodes(s).filter((n) => n.meta['tool_use_id'] === 'toolu_v1' || n.meta['tool_use_id'] === 'toolu_v2')
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.source_label).toBe('auto-capture')
      // No key the valve's protection reads (isProtected: a run's rows, a
      // pointer, an active status, decay-exempt) and no door row's kind.
      expect(r.meta['kind']).toBeUndefined()
      expect(r.meta['next_session']).toBeUndefined()
      expect(r.meta['status']).toBeUndefined()
      expect(r.meta['run']).toBeUndefined()
      expect(isDoorCapture(r.meta)).toBe(false)
    }
    const exempt = s.store.database.prepare("SELECT COUNT(*) AS n FROM nodes WHERE (decay_exempt != 0 OR read_only != 0) AND json_extract(metadata_json, '$.tool_use_id') IN ('toolu_v1', 'toolu_v2')").get() as { n: number }
    expect(exempt.n).toBe(0)
  })

  it('a `claude -p` worker\'s failed and refused calls land in its lane, as its successful ones do', async () => {
    const { path } = tmpStore()
    const s = await open(path)
    const reading = readTicket(mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }))
    s.startWorker({ reading, prompt: null, sessionId: 'cc-child', host: hostname() })
    const lane = workerLaneOf(s.store.database, 'cc-child')!.sessionId
    const t = Date.now() / 1000
    s.store.insertStaging({ sessionId: 'cc-child', role: 'assistant', content: 'Tool: Bash\nInput:\nok\nOutput:\nok', toolName: 'Bash', timestamp: t, toolUseId: 'toolu_w0' })
    s.store.insertStaging({ sessionId: 'cc-child', role: 'assistant', content: 'Tool: Bash\nInput:\nls\nOutput:\nExit code 2', toolName: 'Bash', timestamp: t + 1, outcome: 'failed', toolUseId: 'toolu_w1' })
    s.store.insertStaging({ sessionId: 'cc-child', role: 'assistant', content: 'Tool: Write\nInput:\nx\nOutput:\ndenied', toolName: 'Write', timestamp: t + 2, capturedFrom: 'batch', toolUseId: 'toolu_w2' })
    await new IngestionLoop(s, { batchSize: 10 }).ingestBatch()
    const rows = s.store.database.prepare("SELECT session_key, metadata_json FROM nodes WHERE json_extract(metadata_json, '$.tool_use_id') LIKE 'toolu_w%' ORDER BY created_at").all() as Array<{ session_key: string; metadata_json: string }>
    expect(rows).toHaveLength(3)
    const ok = JSON.parse(rows[0]!.metadata_json) as Record<string, unknown>
    for (const r of rows) {
      const m = JSON.parse(r.metadata_json) as Record<string, unknown>
      expect(r.session_key).toBe(rows[0]!.session_key)
      expect(m['session_id']).toBe(lane)
      expect(m['_writer']).toBe(ok['_writer'])
      expect(m['_writer_src']).toBe('declared')
    }
  })
})
