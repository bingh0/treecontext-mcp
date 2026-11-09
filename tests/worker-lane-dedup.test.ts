/**
 * D391 below the charter: a curated dedup hit modifies no other lane's
 * row (the pointer tags armed only in the survivor's own lane, the hit's
 * survivor and lanes said back), a ticket-door worker's curated dedup is
 * its own session's, and migration 033 adds the worker index keeping every
 * existing row's identity. The charter binds the doors (journal-workers,
 * journal-orchestration, journal-session-echo); this pins the library's
 * own answers and the migration. Every store claim is read back through a
 * separate handle on the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite, setPragma } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import { registerSelf, registerSubagent, type GitSelf } from '../src/persistence/session-registry.js'
import { WORKER_INDEX_DDL } from '../src/persistence/curated-index.js'
import { runMigrations } from '../src/persistence/migrations.js'
import { dedupClassOf } from '../src/dedup-identity.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../src/server/server.js'
import { parseToolResult } from './helpers/mcp-result.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-wlane-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const dbPath = (): string => join(tmpDir, 'store.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath())), retentionInterval: 1_000_000 })
function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(dbPath(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
const metaOf = (id: string): Record<string, unknown> => JSON.parse(raw<{ m: string }>('SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
const here = { pid: process.pid, start: null, host: hostname() }
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }
const WT: GitSelf = { worktree: 'subproject', branch: 'sub', cwd: '/sub', toplevel: '/sub', commonDir: '/repo/.git' }

/** An agent's MCP client on the store, its session given as serve gives a
 *  trusted worker's lane (ccSessionId) or a hook-registered session's. */
async function tools(s: FlatStore, session: string): Promise<{ insert: (content: string, metadata?: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => Promise<void> }> {
  const server = createServer(s, { ccSessionId: session })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'wlane', version: '0' })
  await server.connect(st)
  await c.connect(ct)
  return {
    insert: async (content, metadata = {}) => parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } })),
    close: async () => { await c.close(); await server.close() },
  }
}

async function worker(s: FlatStore, role = 'builder'): Promise<{ sessionId: string; agentId: string }> {
  const leg = await s.registerWorker({ door: 'library', ticket: { parent: { id: 'p1' }, run: null, key: null, role }, process: here })
  return { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
}

describe('a curated dedup hit and the lanes (D391)', () => {
  it('a hit from another lane arms no pointer tag on the survivor and says which it left off; the own lane re-arms', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    registerSelf(s.store.database, 'cc-wt', WT, 1)
    const wt = await s.insert('plan: wire the login form', { metadata: { _cc_session_id: 'cc-wt', _writer: 'worktree:subproject', _writer_src: 'self' } })
    await s.insert('plan: the newer one', { metadata: { _cc_session_id: 'cc-wt', _writer: 'worktree:subproject', _writer_src: 'self', next_session: true }, supersedes: [wt.nodeId] })
    const before = raw<Record<string, unknown>>('SELECT * FROM nodes WHERE node_id = ?', wt.nodeId)[0]
    const hit = await s.insert('plan: wire the login form', { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self', next_session: true, status: 'active' } })
    expect([hit.deduplicated, hit.nodeId]).toEqual([true, wt.nodeId])
    expect(hit.survivor).toEqual({ writer: 'worktree:subproject', lane: 'worktree:subproject', callerLane: 'main', sameLane: false })
    expect(hit.flagsNotArmed).toEqual(['next_session', 'status'])
    expect(raw<Record<string, unknown>>('SELECT * FROM nodes WHERE node_id = ?', wt.nodeId)[0]).toEqual(before)
    // The worktree's own later session re-arms it: one lane.
    registerSelf(s.store.database, 'cc-wt-2', WT, 2)
    const own = await s.insert('plan: wire the login form', { metadata: { _cc_session_id: 'cc-wt-2', _writer: 'worktree:subproject', _writer_src: 'self', next_session: true } })
    expect(own.survivor).toMatchObject({ lane: 'worktree:subproject', callerLane: 'worktree:subproject', sameLane: true })
    expect(own.flagsNotArmed).toBeUndefined()
    expect(metaOf(wt.nodeId)['next_session']).toBe(true)
    await s.close()
  })

  it('a subagent sharing the session is another lane than its orchestrator\'s row; an ambiguous writer shares none', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    registerSubagent(s.store.database, 'cc-main', 'a-t', 'tester', MAIN, 2)
    const mine = await s.insert('note: CSRF blocks the submit', { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self' } })
    const tester = await s.insert('note: CSRF blocks the submit', { metadata: { _cc_session_id: 'cc-main', _writer: 'tester', _writer_src: 'echo', _writer_agent_id: 'a-t', next_session: true } })
    expect(tester.survivor).toMatchObject({ lane: 'main', callerLane: 'tester', sameLane: false })
    expect(metaOf(mine.nodeId)['next_session']).toBeUndefined()
    const unsure = await s.insert('note: CSRF blocks the submit', { metadata: { _cc_session_id: 'cc-main', _writer_src: 'ambiguous', status: 'active' } })
    expect(unsure.survivor?.sameLane).toBe(false)
    expect(unsure.flagsNotArmed).toEqual(['status'])
    expect(metaOf(mine.nodeId)['status']).toBeUndefined()
    await s.close()
  })
})

describe('a ticket-door worker dedups in its own lane (D391, D288)', () => {
  it('two workers, and a worker and main, writing one text leave a row each; a worker\'s own repeat still dedups', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    const text = 'login form: submit posts to /api/session'
    const main = await s.insert(text, { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self' } })
    const a = await worker(s)
    const b = await worker(s)
    const ra = await s.insert(text, { leg: a })
    const rb = await s.insert(text, { leg: b })
    for (const r of [ra, rb]) expect(r.deduplicated).toBe(false)
    const again = await s.insert(text, { leg: a })
    expect([again.deduplicated, again.nodeId]).toEqual([true, ra.nodeId])
    expect(again.survivor).toMatchObject({ writer: 'builder', sameLane: true })
    // And main's repeat finds main's row, never a worker's.
    const mainAgain = await s.insert(text, { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self' } })
    expect(mainAgain.nodeId).toBe(main.nodeId)
    const rows = raw<{ node_id: string; session_key: string; dedup_class: string }>('SELECT node_id, session_key, dedup_class FROM nodes WHERE fingerprint = (SELECT fingerprint FROM nodes WHERE node_id = ?) ORDER BY rowid', main.nodeId)
    expect(rows.map((r) => [r.session_key, r.dedup_class])).toEqual([['cc-main', 'curated'], [a.sessionId, 'worker_curated'], [b.sessionId, 'worker_curated']])
    // The other order: a worker first, then main, writing a text no one held.
    const fresh = 'login form: the CSRF token rides in a header'
    const wFirst = await s.insert(fresh, { leg: b })
    const mAfter = await s.insert(fresh, { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self' } })
    expect(mAfter.deduplicated).toBe(false)
    expect(mAfter.nodeId).not.toBe(wFirst.nodeId)
    expect(raw<{ k: string }>('SELECT session_key AS k FROM nodes WHERE node_id = ?', mAfter.nodeId)[0]!.k).toBe('cc-main')
    await s.close()
  })

  it('the worker class is the store\'s stamp of a worker\'s own lane, never a handoff lane\'s or a subagent\'s', () => {
    const stamp = { _writer: 'builder', _writer_src: 'declared', _writer_agent_id: WORKER_AGENT_ID }
    expect(dedupClassOf(null, { ...stamp, _cc_session_id: 'w-1' })).toBe('worker_curated')
    expect(dedupClassOf(null, { ...stamp, session_id: 'handoff:w-1' })).toBe('curated')
    expect(dedupClassOf(null, { ...stamp })).toBe('curated')
    expect(dedupClassOf(null, { ...stamp, _writer_src: 'echo', _cc_session_id: 'w-1' })).toBe('curated')
    expect(dedupClassOf(null, { ...stamp, _writer_agent_id: 'a-real-agent', _cc_session_id: 's-1' })).toBe('curated')
    expect(dedupClassOf('auto-capture', { ...stamp, _cc_session_id: 'w-1' })).toBe('auto')
  })

  it('a hooks-door leg keeps the curated class (D392), and an imported worker row stays curated in its handoff lane', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    const r = await s.insert('a subagent note', { metadata: { _cc_session_id: 'cc-main', _writer: 'tester', _writer_src: 'declared', _writer_agent_id: 'a-real-agent' } })
    expect(raw<{ c: string }>('SELECT dedup_class AS c FROM nodes WHERE node_id = ?', r.nodeId)[0]!.c).toBe('curated')
    // An imported worker row sits in a handoff lane: its stamps are claims, its class the curated one, outside both indexes.
    const imp = await s.importJson(JSON.stringify({ nodes: [{ nodeId: 'imp-1', content: 'a worker note from elsewhere', createdAt: 5, metadata: { _cc_session_id: 'w-remote', _writer: 'builder', _writer_src: 'declared', _writer_agent_id: WORKER_AGENT_ID } }] }), { handoff: { file: 'h.json', importer: 'me' } })
    expect(imp.importedCount).toBe(1)
    expect(raw<{ c: string; k: string }>('SELECT dedup_class AS c, session_key AS k FROM nodes WHERE node_id = ?', 'imp-1')[0]).toEqual({ c: 'curated', k: 'handoff:w-remote' })
    await s.close()
  })
})

describe('the tools door: a worker\'s session is its lane, and the notes say who could be told (D391, D288, D240)', () => {
  it('a trusted worker\'s row is keyed to its own session whatever session_id its metadata names, and the reply says so', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    const text = 'login form: submit posts to /api/session'
    const mainTools = await tools(s, 'cc-main')
    const mainRow = await mainTools.insert(text)
    const w = await worker(s)
    const wTools = await tools(s, w.sessionId)
    const r = await wTools.insert(text, { session_id: 'cc-main' })
    expect([r['deduplicated'], r['node_id'] === mainRow['node_id']]).toEqual([false, false])
    const row = raw<{ k: string; c: string }>('SELECT session_key AS k, dedup_class AS c FROM nodes WHERE node_id = ?', r['node_id'])[0]
    expect(row).toEqual({ k: w.sessionId, c: 'worker_curated' })
    const m = metaOf(r['node_id'] as string)
    expect(m['session_id']).toBeUndefined()
    expect(m['_cc_session_id']).toBe(w.sessionId)
    expect(r['session_id_ignored']).toBe('cc-main')
    expect(String(r['session_id_note'])).toContain(`its own session ("${w.sessionId}")`)
    // Its own repeat naming main's session again finds its own row.
    const again = await wTools.insert(text, { session_id: 'cc-main' })
    expect([again['deduplicated'], again['node_id'], again['lane'], again['session_id_ignored']]).toEqual([true, r['node_id'], 'builder', 'cc-main'])
    // Another caller's session_id is its own business, as before.
    const other = await mainTools.insert('a main note naming a session', { session_id: 'cc-elsewhere' })
    expect(other['session_id_ignored']).toBeUndefined()
    expect(metaOf(other['node_id'] as string)['session_id']).toBe('cc-elsewhere')
    expect(raw<{ k: string }>('SELECT session_key AS k FROM nodes WHERE node_id = ?', other['node_id'])[0]!.k).toBe('cc-elsewhere')
    await wTools.close(); await mainTools.close(); await s.close()
  })

  it('the flags note of a caller the store could not tell apart says so, never that the entry is another lane\'s', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    registerSelf(s.store.database, 'cc-wt', WT, 1)
    const text = 'plan: wire the login form'
    const mainTools = await tools(s, 'cc-main')
    const held = await mainTools.insert(text)
    // A main session with two live subagents: the caller cannot be told apart.
    registerSelf(s.store.database, 'cc-main-2', MAIN, 2)
    registerSubagent(s.store.database, 'cc-main-2', 'a-1', 'tester', MAIN, 3)
    registerSubagent(s.store.database, 'cc-main-2', 'a-2', 'reviewer', MAIN, 4)
    const amb = await tools(s, 'cc-main-2')
    const r = await amb.insert(text, { next_session: true })
    expect([r['deduplicated'], r['node_id'], r['flags_not_armed']]).toEqual([true, held['node_id'], ['next_session']])
    expect(String(r['flags_note'])).toMatch(/^The store could not tell which writer made this call \(it is stamped ambiguous\), so it cannot tell whether that entry \("main"\) is in your lane, and the resume-pointer tags this insert carried \(next_session\) were not armed on it/)
    expect(String(r['flags_note'])).not.toContain("another lane's")
    expect(metaOf(held['node_id'] as string)['next_session']).toBeUndefined()
    // A caller told exactly, in another lane, is told the entry is that lane's.
    const wt = await tools(s, 'cc-wt')
    const x = await wt.insert(text, { next_session: true })
    expect(String(x['flags_note'])).toMatch(/^That entry is another lane's \("main"\), so the resume-pointer tags this insert carried \(next_session\) were not armed on it/)
    await amb.close(); await wt.close(); await mainTools.close(); await s.close()
  })
})

describe('migration 033: the worker index, every existing row\'s identity kept', () => {
  it('a store at 32 climbs to 33 behind its backup, no row reclassified or re-keyed, the curated index untouched', async () => {
    const s = await open()
    registerSelf(s.store.database, 'cc-main', MAIN, 1)
    await s.insert('a curated note', { metadata: { _cc_session_id: 'cc-main', _writer: 'main', _writer_src: 'self' } })
    await s.insert('an auto row', { metadata: { source: 'auto-capture', role: 'user', session_id: 'cc-main' } })
    await s.openRun({ run: 'r1', by: 'harness', at: 10 })
    await s.importJson(JSON.stringify({ nodes: [{ nodeId: 'imp-1', content: 'an imported chapter', createdAt: 5, metadata: { next_session: true } }] }), { handoff: { file: 'h.json', importer: 'me' } })
    // An imported worker's note: the sender's worker stamp kept as claims
    // under _handoff_claims, in its handoff lane, the curated class.
    await s.importJson(JSON.stringify({ nodes: [{ nodeId: 'imp-w', content: 'a worker note from elsewhere', createdAt: 6, metadata: { _cc_session_id: 'w-remote', _writer: 'builder', _writer_src: 'declared', _writer_agent_id: WORKER_AGENT_ID } }] }), { handoff: { file: 'hw.json', importer: 'me' } })
    // A worker's note and its summary row, as a build before 033 wrote
    // them: the curated class, in the worker's own session.
    const w1 = await worker(s)
    const old = await s.insert('a worker note from before the upgrade', { leg: w1 })
    const summary = (await s.retireWorker(w1, { output: 'login form wired', how: 'retired', summary: true })).summaryId!
    await s.close()
    // Back to the shape 032 left: no worker index, and no row of the new class.
    const db = new DatabaseSync(dbPath())
    db.exec('DROP INDEX idx_nodes_worker_curated_fp')
    for (const id of [old.nodeId, summary]) db.prepare("UPDATE nodes SET dedup_class = 'curated' WHERE node_id = ?").run(id)
    const claims = db.prepare("SELECT json_extract(metadata_json, '$._handoff_claims._writer_agent_id') AS a, session_key AS k FROM nodes WHERE node_id = 'imp-w'").get() as { a: string; k: string }
    expect(claims).toEqual({ a: WORKER_AGENT_ID, k: 'handoff:w-remote' })
    const kinds = db.prepare("SELECT json_extract(metadata_json, '$.kind') AS kind, session_key AS k, json_extract(metadata_json, '$._writer_agent_id') AS a FROM nodes WHERE node_id = ?").get(summary) as { kind: string; k: string; a: string }
    expect(kinds).toEqual({ kind: 'subagent-summary', k: w1.sessionId, a: WORKER_AGENT_ID })
    setPragma(db, 'user_version = 32')
    const ident = (): unknown[] => db.prepare('SELECT node_id, tree_id, fingerprint, dedup_class, session_key, created_at FROM nodes ORDER BY node_id').all()
    const before = ident()
    const curatedSql = (): unknown => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_nodes_curated_fp'").get() as { sql: string }).sql
    const curatedBefore = curatedSql()
    expect(new Set((before as Array<{ dedup_class: string }>).map((r) => r.dedup_class))).toEqual(new Set(['curated', 'auto', 'run']))
    try {
      const report = runMigrations(openNodeSqlite(db), { migrate: true })
      expect(report.applied.map((a) => [a.version, a.kind])).toEqual([[33, 'additive']])
      expect(ident()).toEqual(before)
      expect(curatedSql()).toBe(curatedBefore)
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_nodes_worker_curated_fp'").get() as { sql: string }).sql
      expect(`${sql};`).toBe(WORKER_INDEX_DDL.replace('IF NOT EXISTS ', ''))
    } finally { db.close() }
    // The copy taken before it ran holds every row.
    const bak = `${dbPath()}.pre-migration-v32.bak`
    expect(existsSync(bak)).toBe(true)
    const b = new DatabaseSync(bak, { readOnly: true })
    try { expect(b.prepare('SELECT node_id, tree_id, fingerprint, dedup_class, session_key, created_at FROM nodes ORDER BY node_id').all()).toEqual(before) } finally { b.close() }
  })
})
