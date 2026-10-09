/**
 * Session identity fix (docs/session-identity.md).
 *
 * Covers:
 *  - Fix 1 §3: PID beacon write/refresh/resume semantics (fixture PIDs, no
 *    real claude process needed).
 *  - Fix 1 §3: the server's resolution ladder (pid match, explicit,
 *    beacon-ambiguous, absent).
 *  - Fix 1 §3: getSessionKey (flat-store.ts `sessionOf`) grouping —
 *    hook events (`session_id`) and new-style notes (`_cc_session_id`) as
 *    one namespace; legacy notes (`_session_id` only) fall back to the old
 *    (disjoint) behavior.
 *  - The end-to-end behavior change this fix exists for: a curated note
 *    inserted through the fixed MCP server now carries `_cc_session_id`
 *    matching its conversation's hook-captured events, so
 *    conversation_window/anchor actually windows them together.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import type { Database } from '../src/persistence/database.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import {
  writeSessionBeacon,
  readSessionBeacon,
  listSessionBeacons,
  resolveCcSessionId,
  sessionsDir,
  writeNamespaceAnnotation,
  readNamespaceAnnotation,
  resolveHookNamespace,
  writeSessionNamespaceAnnotation,
} from '../src/session-beacon.js'
import { nsLeaseLiveFor } from '../src/persistence/leases.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolResult(res: any): any {
  return JSON.parse(res.content[0].text)
}

describe('session-beacon: PID beacon write/refresh/resume semantics', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-beacon-'))
    dbPath = join(dir, 'treecontext.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('SessionStart (rewrite:true) writes a fresh beacon under sessions/pid-<pid>.json', () => {
    writeSessionBeacon(dbPath, 4242, 'cc-session-a', '/proj', { rewrite: true })
    expect(sessionsDir(dbPath)).toBe(join(dir, 'sessions'))
    const beacon = readSessionBeacon(dbPath, 4242)!
    expect(beacon.cc_session_id).toBe('cc-session-a')
    expect(beacon.cwd).toBe('/proj')
    expect(beacon.started_at).toBeGreaterThan(0)
    expect(beacon.last_seen).toBe(beacon.started_at)
  })

  it('UserPromptSubmit (rewrite:false) only refreshes last_seen, preserving cc_session_id/started_at', async () => {
    writeSessionBeacon(dbPath, 4242, 'cc-session-a', '/proj', { rewrite: true })
    const before = readSessionBeacon(dbPath, 4242)!
    await new Promise((r) => setTimeout(r, 20))
    writeSessionBeacon(dbPath, 4242, 'cc-session-a', '/proj', { rewrite: false })
    const after = readSessionBeacon(dbPath, 4242)!
    expect(after.cc_session_id).toBe(before.cc_session_id)
    expect(after.started_at).toBe(before.started_at)
    expect(after.last_seen).toBeGreaterThan(before.last_seen)
  })

  it('resume: SessionStart rewrites cc_session_id for the SAME pid (new session id, same claude process)', () => {
    writeSessionBeacon(dbPath, 4242, 'cc-session-a', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 4242, 'cc-session-b-resumed', '/proj', { rewrite: true })
    const beacon = readSessionBeacon(dbPath, 4242)!
    expect(beacon.cc_session_id).toBe('cc-session-b-resumed')
  })

  it('UserPromptSubmit creates a beacon defensively if SessionStart never ran for this pid', () => {
    expect(readSessionBeacon(dbPath, 999)).toBeNull()
    writeSessionBeacon(dbPath, 999, 'cc-session-x', '/proj', { rewrite: false })
    const beacon = readSessionBeacon(dbPath, 999)!
    expect(beacon.cc_session_id).toBe('cc-session-x')
  })

  it('listSessionBeacons enumerates every pid file for the store, ignoring non-matching names', () => {
    writeSessionBeacon(dbPath, 1, 'cc-1', '/a', { rewrite: true })
    writeSessionBeacon(dbPath, 2, 'cc-2', '/b', { rewrite: true })
    const all = listSessionBeacons(dbPath)
    expect(all.map((x) => x.pid).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('a corrupt beacon file is treated as absent, not thrown', () => {
    writeSessionBeacon(dbPath, 5, 'cc-5', '/a', { rewrite: true })
    // Overwrite with garbage directly.
    const path = join(sessionsDir(dbPath), 'pid-5.json')
    writeFileSync(path, '{not json')
    expect(readSessionBeacon(dbPath, 5)).toBeNull()
  })
})

describe('resolveCcSessionId: resolution ladder', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-ladder-'))
    dbPath = join(dir, 'treecontext.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('rung 1 (pid): exact match wins, no ambiguity flag', () => {
    writeSessionBeacon(dbPath, 111, 'cc-own', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 222, 'cc-other', '/proj', { rewrite: true }) // decoy, different pid
    const r = resolveCcSessionId(dbPath, { claudePid: 111, stdio: true })
    expect(r).toEqual({ ccSessionId: 'cc-own', src: 'pid' })
  })

  it('rung 2 (explicit) always wins, even with a matching pid beacon present', () => {
    writeSessionBeacon(dbPath, 111, 'cc-own', '/proj', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 111, stdio: true, explicitCcSessionId: 'cc-explicit' })
    expect(r).toEqual({ ccSessionId: 'cc-explicit', src: 'explicit' })
  })

  it('the pid rung does not apply on the daemon/http path (stdio:false) — falls through', () => {
    writeSessionBeacon(dbPath, 111, 'cc-own', '/proj', { rewrite: true })
    // Same pid as the "caller" but stdio:false means it must not be trusted
    // as an exact match (a shared daemon has no 1:1 pid<->session relation).
    const r = resolveCcSessionId(dbPath, { claudePid: 111, stdio: false })
    expect(r.src).not.toBe('pid')
  })

  it('rung 3a (beacon-unanimous): every live beacon names the same session — confident, no ambiguity flag', () => {
    // One session, several hook processes: pid-keyed beacons proliferate
    // but all carry the same cc_session_id. Distinct-set of one is
    // certainty — the pre-v1.2 code mislabeled exactly this as ambiguous.
    writeSessionBeacon(dbPath, 111, 'cc-same', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 222, 'cc-same', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 333, 'cc-same', '/proj', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true })
    expect(r).toEqual({ ccSessionId: 'cc-same', src: 'beacon-unanimous' })
  })

  it('rung 3b (beacon-ambiguous): live beacons disagree — most-recently-seen wins, disclosed', async () => {
    writeSessionBeacon(dbPath, 111, 'cc-older', '/proj', { rewrite: true })
    await new Promise((r) => setTimeout(r, 20))
    writeSessionBeacon(dbPath, 222, 'cc-newer', '/proj', { rewrite: true })
    // claudePid 999 has no beacon of its own.
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true })
    expect(r.src).toBe('beacon-ambiguous')
    expect(r.ambiguous).toBe(true)
    expect(r.ccSessionId).toBe('cc-newer')
    expect(r.candidates).toEqual(expect.arrayContaining(['cc-older', 'cc-newer']))
  })

  it('rung 3b discloses DISTINCT candidates, not one per beacon file', async () => {
    // Three live beacons, two sessions: the candidate list is the two
    // distinct ids, most-recent-first — never N copies of the same uuid.
    writeSessionBeacon(dbPath, 111, 'cc-a', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 222, 'cc-a', '/proj', { rewrite: true })
    await new Promise((r) => setTimeout(r, 20))
    writeSessionBeacon(dbPath, 333, 'cc-b', '/proj', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true })
    expect(r.src).toBe('beacon-ambiguous')
    expect(r.candidates).toEqual(['cc-b', 'cc-a'])
  })

  it('rung 3 does not consider beacons older than the 15-minute liveness window', () => {
    const stalePath = join(sessionsDir(dbPath), 'pid-333.json')
    const nowSec = Date.now() / 1000
    const staleBeacon = { cc_session_id: 'cc-stale', cwd: '/proj', started_at: nowSec - 3600, last_seen: nowSec - 3600 }
    mkdirSync(sessionsDir(dbPath), { recursive: true })
    writeFileSync(stalePath, JSON.stringify(staleBeacon))

    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true })
    expect(r).toEqual({ ccSessionId: null, src: null })
  })

  it('rung 4 (absent): no beacons at all, no explicit id — resolves to null, never guesses', () => {
    const r = resolveCcSessionId(dbPath, { claudePid: 111, stdio: true })
    expect(r).toEqual({ ccSessionId: null, src: null })
  })
})

describe('resolveCcSessionId: rung-3 cross-project cwd narrowing (v2 adjunct, ruled 2026-08-14)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-cwd-'))
    dbPath = join(dir, 'treecontext.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a live beacon from another project is not this session: degrades to absent, never misattributes', () => {
    writeSessionBeacon(dbPath, 111, 'cc-foreign', '/other-project', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true, cwd: '/proj' })
    expect(r).toEqual({ ccSessionId: null, src: null })
  })

  it('cross-project narrowing turns a would-be-ambiguous read into unanimity', () => {
    writeSessionBeacon(dbPath, 111, 'cc-ours', '/proj', { rewrite: true })
    writeSessionBeacon(dbPath, 222, 'cc-foreign', '/other-project', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true, cwd: '/proj' })
    expect(r).toEqual({ ccSessionId: 'cc-ours', src: 'beacon-unanimous' })
  })

  it('same-project concurrent sessions stay disclosed as ambiguous — the narrowing never resolves them', async () => {
    writeSessionBeacon(dbPath, 111, 'cc-a', '/proj', { rewrite: true })
    await new Promise((r) => setTimeout(r, 20))
    writeSessionBeacon(dbPath, 222, 'cc-b', '/proj', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true, cwd: '/proj' })
    expect(r.src).toBe('beacon-ambiguous')
    expect(r.candidates).toEqual(['cc-b', 'cc-a'])
  })

  it('a legacy beacon with no cwd recorded is kept, not dropped — dropping could only lose attribution', () => {
    const nowSec = Date.now() / 1000
    mkdirSync(sessionsDir(dbPath), { recursive: true })
    writeFileSync(
      join(sessionsDir(dbPath), 'pid-111.json'),
      JSON.stringify({ cc_session_id: 'cc-legacy', started_at: nowSec, last_seen: nowSec }),
    )
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true, cwd: '/proj' })
    expect(r).toEqual({ ccSessionId: 'cc-legacy', src: 'beacon-unanimous' })
  })

  it('no cwd supplied → rung 3 behaves exactly as before the adjunct', () => {
    writeSessionBeacon(dbPath, 111, 'cc-foreign', '/other-project', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 999, stdio: true })
    expect(r).toEqual({ ccSessionId: 'cc-foreign', src: 'beacon-unanimous' })
  })

  it('the pid rung is exact and ignores cwd entirely', () => {
    // A beacon keyed by our own claude pid IS our session, whatever cwd it
    // recorded — rung 1 is pid-exact; the narrowing is a rung-3 concern.
    writeSessionBeacon(dbPath, 111, 'cc-own', '/recorded-elsewhere', { rewrite: true })
    const r = resolveCcSessionId(dbPath, { claudePid: 111, stdio: true, cwd: '/proj' })
    expect(r).toEqual({ ccSessionId: 'cc-own', src: 'pid' })
  })
})

describe('getSessionKey (flat-store.ts sessionOf) grouping — hook events, new notes, legacy notes', () => {
  let dir: string
  let dbPath: string
  let db: Database
  let store: FlatStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-sessionkey-'))
    dbPath = join(dir, 'treecontext.db')
    db = wrapBetterSqlite(new BetterSqlite3(dbPath))
    store = await FlatStore.open({ database: db, ownsDatabase: true })
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function insertAt(
    content: string,
    createdAt: number,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const res = await store.insert(content, { metadata })
    db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(createdAt, res.nodeId)
    return res.nodeId
  }

  it('a new-style note (_cc_session_id) windows WITH hook events sharing the same session_id — the behavior this fix exists for', async () => {
    const realCcSession = 'cc-real-session-42'
    const toolBefore = await insertAt('tool event before', 1, { session_id: realCcSession, role: 'assistant' })
    const toolAfter = await insertAt('tool event after', 3, { session_id: realCcSession, role: 'assistant' })
    // Simulates what the fixed server now writes on treecontext_insert: a
    // curated note carries _cc_session_id (the real CC session) alongside
    // the legacy _session_id/_conn_id (MCP connection id — deliberately a
    // DIFFERENT value, proving _cc_session_id is what wins the grouping).
    const noteId = await insertAt('needleNote curated decision', 2, {
      _cc_session_id: realCcSession,
      _session_id: 'mcp-connection-id-unrelated',
      _conn_id: 'mcp-connection-id-unrelated',
    })

    const results = await store.query('needleNote', { topK: 5, conversationWindow: 2 })
    expect(results).toHaveLength(1)
    expect(results[0]!.nodeId).toBe(noteId)
    const window = results[0]!.window!
    expect(window.before.map((e) => e.nodeId)).toContain(toolBefore)
    expect(window.after.map((e) => e.nodeId)).toContain(toolAfter)
  })

  it('a legacy note (_session_id only, pre-fix data) does NOT retroactively join a hook session it never shared — old behavior preserved for historical rows', async () => {
    const realCcSession = 'cc-real-session-77'
    await insertAt('other tool event', 1, { session_id: realCcSession, role: 'assistant' })
    await insertAt('other tool event two', 3, { session_id: realCcSession, role: 'assistant' })
    // Legacy note: only ever had _session_id (the old, pre-fix field), and
    // its value is a connection id that never matches any hook's session_id.
    const legacyNoteId = await insertAt('needleLegacy old note', 2, {
      _session_id: 'old-connection-id-no-relation',
    })

    const results = await store.query('needleLegacy', { topK: 5, conversationWindow: 2 })
    expect(results).toHaveLength(1)
    expect(results[0]!.nodeId).toBe(legacyNoteId)
    const window = results[0]!.window!
    expect(window.before).toHaveLength(0)
    expect(window.after).toHaveLength(0)
  })

  it('hook events (session_id) and new notes (_cc_session_id) group as ONE namespace even without a real MCP round-trip', async () => {
    const session = 'cc-shared-session'
    const hookA = await insertAt('hook a', 1, { session_id: session })
    const noteId = await insertAt('needleShared note', 2, { _cc_session_id: session })
    const hookB = await insertAt('hook b', 3, { session_id: session })

    const results = await store.query('needleShared', { topK: 5, conversationWindow: 2 })
    const window = results[0]!.window!
    expect(window.before.map((e) => e.nodeId)).toEqual([hookA])
    expect(window.after.map((e) => e.nodeId)).toEqual([hookB])
    expect(results[0]!.nodeId).toBe(noteId)
  })
})

describe('end-to-end: treecontext_insert resolves _cc_session_id via the pid beacon and windows with its conversation', () => {
  let dir: string
  let dbPath: string
  let db: Database
  let store: FlatStore
  const FAKE_CLAUDE_PID = 65535

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-e2e-'))
    dbPath = join(dir, 'treecontext.db')
    db = wrapBetterSqlite(new BetterSqlite3(dbPath))
    store = await FlatStore.open({ database: db, ownsDatabase: true })
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes _conn_id (mirroring _session_id) and _cc_session_id/_cc_session_src, and the resulting note windows with its hook events', async () => {
    const realCcSession = 'cc-e2e-session-1'
    // The SessionStart/UserPromptSubmit hooks (running in the same claude
    // process as this MCP server) would have written this beacon before
    // any insert happens.
    writeSessionBeacon(dbPath, FAKE_CLAUDE_PID, realCcSession, dir, { rewrite: true })

    // Simulate the hook-captured conversation around the note we're about
    // to insert (real deployments populate this via the ingestion loop).
    const toolBefore = await store.insert('captured tool event before', { metadata: { session_id: realCcSession, role: 'assistant' } })
    db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(1, toolBefore.nodeId)
    const toolAfter = await store.insert('captured tool event after', { metadata: { session_id: realCcSession, role: 'assistant' } })
    db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(3, toolAfter.nodeId)

    const server = createServer(store, {
      info: { storePath: dbPath },
      sessionId: 'mcp-connection-abc',
      claudePid: FAKE_CLAUDE_PID,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const insertRes = parseToolResult(
      await client.callTool({
        name: 'treecontext_insert',
        arguments: { content: 'needleE2e curated decision about the fix' },
      }),
    )
    const noteId: string = insertRes.node_id
    db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(2, noteId)

    const row = db.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(noteId) as { metadata_json: string }
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>
    expect(meta._session_id).toBe('mcp-connection-abc')
    expect(meta._conn_id).toBe('mcp-connection-abc')
    expect(meta._cc_session_id).toBe(realCcSession)
    expect(meta._cc_session_src).toBe('pid')
    expect(meta._cc_session_ambiguous).toBeUndefined()

    const queryRes = parseToolResult(
      await client.callTool({
        name: 'treecontext_query',
        arguments: { query: 'needleE2e', top_k: 5, conversation_window: 2 },
      }),
    )
    expect(queryRes.results).toHaveLength(1)
    const window = queryRes.results[0].window
    expect(window.before.map((e: { nodeId: string }) => e.nodeId)).toContain(toolBefore.nodeId)
    expect(window.after.map((e: { nodeId: string }) => e.nodeId)).toContain(toolAfter.nodeId)

    await client.close()
    await server.close()
  })

  it('with no beacon present at all (rung 4, absent), the note gets no _cc_session_id — never guesses', async () => {
    const server = createServer(store, {
      info: { storePath: dbPath },
      sessionId: 'mcp-connection-xyz',
      claudePid: FAKE_CLAUDE_PID,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const insertRes = parseToolResult(
      await client.callTool({ name: 'treecontext_insert', arguments: { content: 'no beacon around' } }),
    )
    const row = db.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(insertRes.node_id) as { metadata_json: string }
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>
    expect(meta._session_id).toBe('mcp-connection-xyz')
    expect(meta._conn_id).toBe('mcp-connection-xyz')
    expect(meta._cc_session_id).toBeUndefined()
    expect(meta._cc_session_src).toBeUndefined()

    await client.close()
    await server.close()
  })
})

describe('namespace annotation (C1): the server writes, hooks resolve — never guess', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-ns-annotation-'))
    dbPath = join(dir, 'treecontext.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A pid that is certainly dead: a child that already ran to completion. */
  function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', ''])
    expect(r.status).toBe(0)
    return r.pid!
  }

  it('write → read round-trips under sessions/pid-<claudePid>.ns.json, keyed to the writing server', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    const a = readNamespaceAnnotation(dbPath, 4242)!
    expect(a.namespace).toBe('agent-a')
    expect(a.server_pid).toBe(process.pid)
    expect(a.written_at).toBeGreaterThan(0)
  })

  /** Corroborators, named so each test states its own premise: the
   *  annotation's weight now comes entirely from this answer (owner
   *  ruling 2026-08-16), so a test that hides it is not saying what it
   *  tests. Production passes nsLeaseLiveFor — pinned separately below. */
  const stillServing = () => true
  const notServing = () => false

  it('the pid rung: a corroborated server\'s annotation resolves to its namespace', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    expect(resolveHookNamespace(dbPath, 4242, null, stillServing)).toBe('agent-a')
  })

  it('an uncorroborated server\'s annotation is unresolved, not a guess', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    const stale = { ...readNamespaceAnnotation(dbPath, 4242)!, server_pid: deadPid() }
    writeFileSync(join(sessionsDir(dbPath), 'pid-4242.ns.json'), JSON.stringify(stale))
    expect(resolveHookNamespace(dbPath, 4242, null, notServing)).toBeNull()
  })

  it('no annotation for the caller\'s own pid resolves to null — other pids\' annotations are never read', () => {
    writeNamespaceAnnotation(dbPath, 5555, 'agent-b')
    expect(resolveHookNamespace(dbPath, 4242, null, stillServing)).toBeNull()
  })

  it('a restart\'s rewrite wins — the fresh namespace replaces the old', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    writeNamespaceAnnotation(dbPath, 4242, 'agent-b')
    expect(resolveHookNamespace(dbPath, 4242, null, stillServing)).toBe('agent-b')
  })

  // The 24h staleness bound this pair replaces was wrong in BOTH
  // directions: it rejected servers legitimately alive for more than a
  // day (written_at is stamped once at startup, never refreshed), and
  // inside the window it still honored a SIGKILLed server whose pid the
  // OS had recycled onto an unrelated live process.
  it('an annotation older than a day still resolves while its server is corroborated', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    const ancient = {
      ...readNamespaceAnnotation(dbPath, 4242)!,
      written_at: Date.now() / 1000 - 25 * 60 * 60,
    }
    writeFileSync(join(sessionsDir(dbPath), 'pid-4242.ns.json'), JSON.stringify(ancient))
    expect(resolveHookNamespace(dbPath, 4242, null, stillServing)).toBe('agent-a')
  })

  it('a recycled pid does not revive a dead server\'s annotation — the session rung answers instead', () => {
    writeNamespaceAnnotation(dbPath, 4242, 'agent-a')
    writeSessionNamespaceAnnotation(dbPath, 'cc-live', 'agent-real', 'status-echo')
    // The pid reads alive (it is this very process) but nothing is
    // serving 'agent-a' any more, so the causal rung must be consulted.
    expect(resolveHookNamespace(dbPath, 4242, 'cc-live', notServing)).toBe('agent-real')
  })

  it('a malformed annotation file is unresolved, never a crash', () => {
    mkdirSync(sessionsDir(dbPath), { recursive: true })
    writeFileSync(join(sessionsDir(dbPath), 'pid-4242.ns.json'), 'not json{')
    expect(resolveHookNamespace(dbPath, 4242, null, stillServing)).toBeNull()
  })
})

describe('nsLeaseLiveFor: what corroborates a namespace annotation', () => {
  let dir: string
  let db: Database
  let raw: BetterSqlite3.Database

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-ns-lease-'))
    raw = new BetterSqlite3(join(dir, 'treecontext.db'))
    db = wrapBetterSqlite(raw)
    // Open a store so the migration ladder builds the leases table.
    const store = await FlatStore.open({ database: db, ownsDatabase: false })
    await store.close()
  })
  afterEach(() => { raw.close(); rmSync(dir, { recursive: true, force: true }) })

  const seed = (role: string, pid: number, host: string, heartbeatAgeSecs: number, ttl: number) => {
    raw.prepare(
      'INSERT OR REPLACE INTO leases (role, holder_pid, holder_host, holder_token, holder_label, acquired_at, heartbeat_at, ttl_secs) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(role, pid, host, 'tok', null, Date.now() / 1000, Date.now() / 1000 - heartbeatAgeSecs, ttl)
  }

  it('a live holder of this namespace, on this host, with this pid corroborates', () => {
    seed('ns:agent-a', 4242, 'box-1', 5, 90)
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(true)
  })

  it('an expired heartbeat does not — this is the expiration mechanism', () => {
    seed('ns:agent-a', 4242, 'box-1', 91, 90)
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(false)
  })

  it('a live lease held by a DIFFERENT pid does not — the recycled-pid case', () => {
    seed('ns:agent-a', 9999, 'box-1', 5, 90)
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(false)
  })

  it('a live lease from another host does not — pids are per-host', () => {
    seed('ns:agent-a', 4242, 'box-2', 5, 90)
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(false)
  })

  it('a lease on a different namespace does not corroborate this one', () => {
    seed('ns:agent-b', 4242, 'box-1', 5, 90)
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(false)
  })

  it('no lease row at all does not corroborate — absence is not permission', () => {
    expect(nsLeaseLiveFor(db, 'agent-a', 4242, 'box-1')).toBe(false)
  })
})
