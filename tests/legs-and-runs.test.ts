/**
 * Legs, workers and runs below the charter (D279–D352, unit 1 of the
 * beta.3 build): the store's numbering of checkpoints under a race of two
 * real writer processes, the supersession named, stamped from the leg's
 * start or waiting for the echo, two in effect, brief supersession and a
 * run's close, the phantom pass against a probe that stages what a host
 * cannot (a reused number, an unreadable start), the migration of a store
 * the ladder had not reached, and the store-only keys the insert tool
 * drops. Every claim is read back from the SQLite file through a separate
 * handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openNodeSqlite, setPragma } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import { runMigrations } from '../src/persistence/migrations.js'
import {
  registerSelf, registerSubagent, retireAllSubagents, liveSubagents, resolveWriter, type GitSelf,
} from '../src/persistence/session-registry.js'
import {
  retirePhantoms, hasLegColumns, legOf, WORKER_AGENT_ID, registerWorkerLeg, recordWorkerProcess, settleLegKey, registerSubagentLeg,
} from '../src/persistence/leg-registry.js'
import type { ProcessProbe } from '../src/persistence/process-probe.js'
import { RUN_ROWS_SQL, briefsInEffect, inEffectLine } from '../src/runs.js'
import { parseToolResult } from './helpers/mcp-result.js'
import { TS_ROOT, tsxArgv } from './journal/proc.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-legs-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'legs.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: 1_000_000 })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
function meta(id: string): Record<string, unknown> {
  return JSON.parse(raw<{ m: string }>('SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
}
function registration(session: string, agent: string): Record<string, unknown> {
  return raw<Record<string, unknown>>('SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?', session, agent)[0]!
}

const worker = (session: string, opts: { run?: string; key?: string; role?: string; parent?: string; pid?: number | null; start?: number | null; host?: string; startCheckpoints?: string[] } = {}) => ({
  sessionId: session,
  door: 'library' as const,
  ticket: { parent: { id: opts.parent ?? 'p1' }, run: opts.run ?? 'r1', key: opts.key ?? 'k', role: opts.role ?? 'builder', checkpointer: opts.role ?? 'builder' },
  process: { pid: opts.pid === undefined ? 4242 : opts.pid, start: opts.start === undefined ? 1000 : opts.start, host: opts.host ?? 'laptop' },
  ...(opts.startCheckpoints ? { startCheckpoints: opts.startCheckpoints } : {}),
})

/** A host that is `laptop`, where the probe says what the case needs. */
function probe(over: Partial<ProcessProbe> & { procs?: Record<number, number | null> }): ProcessProbe {
  const procs = over.procs ?? {}
  return {
    host: over.host ?? (() => 'laptop'),
    exists: over.exists ?? ((pid) => pid in procs),
    startMoment: over.startMoment ?? ((pid) => procs[pid] ?? null),
  }
}

describe('checkpoint numbering (D329)', () => {
  it('two writer processes racing on one key take distinct, consecutive numbers', async () => {
    const s = await open()
    await s.close()
    const barrier = mkdtempSync(join(tmpDir, 'barrier-'))
    const run = (who: string): Promise<number[]> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'checkpoint-writer.ts'), path(), barrier, who, '25'), { cwd: TS_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as number[]) : reject(new Error(`${who} exited ${code}: ${err}`))))
    })
    const a = run('builder')
    const b = run('reviewer')
    await new Promise((r) => setTimeout(r, 1500))
    writeFileSync(join(barrier, 'go'), '')
    const [na, nb] = await Promise.all([a, b])
    const all = [...na, ...nb].sort((x, y) => x - y)
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    // The file agrees, row by row: fifty rows, fifty numbers, none twice.
    const rows = raw<{ n: number; w: string }>(
      "SELECT json_extract(metadata_json, '$._checkpoint_number') AS n, json_extract(metadata_json, '$._writer') AS w FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")
    expect(rows.map((r) => r.n).sort((x, y) => x - y)).toEqual(all)
    expect(new Set(rows.map((r) => r.w))).toEqual(new Set(['builder', 'reviewer']))
  }, 60_000)

  it('the unique index refuses a second row with a number the key already holds', async () => {
    const s = await open()
    const r = await s.writeCheckpoint('state: one', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    await s.close()
    const db = new DatabaseSync(path())
    try {
      const row = db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(r.nodeId) as Record<string, unknown>
      expect(() => db.prepare(
        `INSERT INTO nodes (node_id, tree_id, parent_id, depth, is_leaf, content, summary, created_at, updated_at, summary_stale, read_only, decay_exempt, utility_score, source_label, metadata_json, session_key)
         VALUES ('dup', ?, NULL, 0, 1, 'x', '', 1, 1, 0, 0, 0, 0.5, NULL, ?, ?)`,
      ).run(row['tree_id'] as number, row['metadata_json'] as string, row['session_key'] as string)).toThrow(/UNIQUE/)
    } finally { db.close() }
  })

  it('two checkpoints that read alike are two checkpoints, never a dedup hit', async () => {
    const s = await open()
    const a = await s.writeCheckpoint('state: done', { run: 'r1', key: 'login-form', declared: { role: 'builder' } })
    const b = await s.writeCheckpoint('state: done', { run: 'r1', key: 'search-box', declared: { role: 'builder' } })
    const c = await s.writeCheckpoint('state: done', { run: 'r1', key: 'login-form', declared: { role: 'builder' } })
    await s.close()
    expect([a.deduplicated, b.deduplicated, c.deduplicated]).toEqual([false, false, false])
    expect(new Set([a.nodeId, b.nodeId, c.nodeId]).size).toBe(3)
    expect([a.checkpoint!.number, b.checkpoint!.number, c.checkpoint!.number]).toEqual([1, 1, 2])
    expect(raw<{ c: string }>('SELECT DISTINCT dedup_class AS c FROM nodes').map((r) => r.c)).toEqual(['run'])
  })

  it('a note that says kind "checkpoint" with no run and key is a note, as it always was', async () => {
    const s = await open()
    const r = await s.insert('my checkpoint for today', { metadata: { kind: 'checkpoint' } })
    await s.close()
    expect(r.checkpoint).toBeUndefined()
    expect(meta(r.nodeId)['_checkpoint_number']).toBeUndefined()
    expect(raw<{ c: string }>('SELECT dedup_class AS c FROM nodes WHERE node_id = ?', r.nodeId)[0]!.c).toBe('curated')
  })
})

describe('what a checkpoint supersedes (D280, D331)', () => {
  it('named by the writer: taken at its word, the superseded row untouched', async () => {
    const s = await open()
    const one = await s.writeCheckpoint('state: one', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const before = raw<Record<string, unknown>>('SELECT * FROM nodes WHERE node_id = ?', one.nodeId)[0]
    const two = await s.writeCheckpoint('state: two', { run: 'r1', key: 'k', declared: { role: 'reviewer' }, supersedes: [one.nodeId], restsOn: [one.nodeId] })
    expect(s.checkpointsInEffect('r1', 'k').map((c) => c.nodeId)).toEqual([two.nodeId])
    await s.close()
    expect([meta(two.nodeId)['supersedes'], meta(two.nodeId)['_supersedes_src'], meta(two.nodeId)['refs']]).toEqual([[one.nodeId], 'writer', [one.nodeId]])
    expect(raw<Record<string, unknown>>('SELECT * FROM nodes WHERE node_id = ?', one.nodeId)[0]).toEqual(before)
  })

  it('named by nobody: stamped from the leg\'s registration, marked as the store\'s', async () => {
    const s = await open()
    const one = await s.writeCheckpoint('state: one', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const leg = await s.registerWorker(worker('w1', { startCheckpoints: [one.nodeId] }))
    const two = await s.writeCheckpoint('state: two', { run: 'r1', key: 'k', leg: { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID } })
    expect(two.checkpoint).toEqual({ run: 'r1', key: 'k', number: 2, supersedes: [one.nodeId], supersedesSrc: 'store' })
    await s.close()
    expect([meta(two.nodeId)['supersedes'], meta(two.nodeId)['_supersedes_src']]).toEqual([[one.nodeId], 'store'])
  })

  it('named by nobody, with no leg behind the writer: nothing stamped, so two stay in effect', async () => {
    const s = await open()
    await s.writeCheckpoint('state: one', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const two = await s.writeCheckpoint('state: two', { run: 'r1', key: 'k', declared: { role: 'main' } })
    const inEffect = s.checkpointsInEffect('r1', 'k')
    expect(inEffect.map((c) => c.number)).toEqual([1, 2])
    expect(inEffectLine('r1', 'k', inEffect)).toMatch(/^2 checkpoints are in effect under "k" on the run "r1" \(number 1 and number 2\)/)
    await s.close()
    expect(meta(two.nodeId)['_supersedes_src']).toBeUndefined()
  })

  it('a caller\'s copy of the store-only keys never survives the library or the tool', async () => {
    const s = await open()
    const r = await s.insert('state: forged', { metadata: { kind: 'checkpoint', run: 'r1', key: 'k', _checkpoint_number: 99, _supersedes_src: 'store' } })
    expect(meta(r.nodeId)['_checkpoint_number']).toBe(1)
    expect(meta(r.nodeId)['_supersedes_src']).toBeUndefined()
    const server = createServer(s, { ccSessionId: 's1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'legs', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    const reply = parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: {
      content: 'state: forged through the tool',
      metadata: { kind: 'checkpoint', run: 'r1', key: 'k', _checkpoint_number: 77, _door: 'ticket', _identity: 'hook', _parent: 'boss', _cwd: '/etc' },
    } }))
    await c.close()
    await server.close()
    await s.close()
    const m = meta(reply['node_id'] as string)
    expect([m['_checkpoint_number'], m['_door'], m['_identity'], m['_parent'], m['_cwd']]).toEqual([2, 'tools', undefined, undefined, undefined])
    expect((reply['checkpoint'] as Record<string, unknown>)['number']).toBe(2)
  })
})

describe('briefs in effect (D327)', () => {
  it('a newer brief for the same role and key supersedes the older; another key stays in effect; a closed run ends its briefs', async () => {
    const s = await open()
    const old = await s.writeBrief('build the login form', { run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', by: 'main' })
    const other = await s.writeBrief('build the search box', { run: 'r1', key: 'search-box', role: 'builder', by: 'main' })
    // Naming a brief of another key supersedes nothing.
    const newer = await s.writeBrief('build the login form, with validation', { run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'reviewer', checkpointedBy: 'builder', by: 'main', supersedes: [old.nodeId] })
    const stray = await s.writeBrief('review', { run: 'r1', key: 'login-form', role: 'reviewer', by: 'main', supersedes: [other.nodeId] })
    expect(s.briefsInEffect('builder').map((b) => b.nodeId).sort()).toEqual([newer.nodeId, other.nodeId].sort())
    expect(s.briefsInEffect('reviewer').map((b) => b.nodeId)).toEqual([stray.nodeId])
    const r2 = await s.writeBrief('build the footer', { run: 'r2', key: 'footer', role: 'builder', by: 'main' })
    await s.closeRun({ run: 'r1', by: 'main', reason: 'all keys delivered' })
    expect(s.briefsInEffect('builder').map((b) => b.nodeId)).toEqual([r2.nodeId])
    await s.close()
    expect([meta(newer.nodeId)['supersedes'], meta(newer.nodeId)['checkpointer'], meta(newer.nodeId)['checkpointed_by']]).toEqual([[old.nodeId], 'reviewer', 'builder'])
    // The superseded brief stays readable and untouched.
    expect(meta(old.nodeId)['superseded_by']).toBeUndefined()
    const db = new DatabaseSync(path(), { readOnly: true })
    try { expect(briefsInEffect(db, null, 'builder').map((b) => b.nodeId)).toEqual([r2.nodeId]) } finally { db.close() }
  })
})

describe('the phantom pass (D297, D317)', () => {
  async function seeded(): Promise<FlatStore> {
    const s = await open()
    await s.registerWorker(worker('gone', { pid: 101, start: 1000 }))
    await s.registerWorker(worker('reused', { pid: 102, start: 1000 }))
    await s.registerWorker(worker('alive', { pid: 103, start: 1000 }))
    await s.registerWorker(worker('elsewhere', { pid: 104, start: 1000, host: 'build-02' }))
    await s.registerWorker(worker('nostart', { pid: 105, start: null }))
    await s.registerWorker(worker('unreadable', { pid: 106, start: 1000 }))
    await s.registerWorker(worker('unknown', { pid: 107, start: 1000 }))
    return s
  }

  it('retires the gone and the reused, leaves the rest live, and says why each unchecked one is', async () => {
    const s = await seeded()
    const p = probe({
      procs: { 102: 5000, 103: 1001.5, 105: 7, 106: null },
      exists: (pid) => (pid === 107 ? null : [102, 103, 105, 106].includes(pid)),
    })
    const pass = s.retirePhantoms({ noticedBy: 'lookup', probe: p, at: 4242 })
    expect(pass.retired.map((r) => r.ref.sessionId).sort()).toEqual(['gone', 'reused'])
    expect(pass.unchecked.map((u) => [u.ref.sessionId, u.reason])).toEqual([
      ['elsewhere', 'other-host'], ['nostart', 'no-start-moment'], ['unreadable', 'start-unreadable'], ['unknown', 'unknown'],
    ])
    expect(pass.notes[0]).toContain('"build-02" and cannot be checked from here ("laptop")')
    expect(pass.notes[1]).toContain('cannot be told from a successor that took its number')
    await s.close()
    for (const sid of ['gone', 'reused']) {
      expect(registration(sid, WORKER_AGENT_ID)).toMatchObject({ ended: 'phantom', noticed_at: 4242, noticed_by: 'lookup', stopped_at: null })
    }
    for (const sid of ['alive', 'elsewhere', 'nostart', 'unreadable', 'unknown']) {
      expect(registration(sid, WORKER_AGENT_ID)).toMatchObject({ ended: null, noticed_at: null, stopped_at: null })
    }
  })

  it('scoped to a run, checks that run alone; and a retired worker is never checked again', async () => {
    const s = await open()
    await s.registerWorker(worker('a', { pid: 201, run: 'r1' }))
    await s.registerWorker(worker('b', { pid: 202, run: 'r2' }))
    expect(s.retirePhantoms({ noticedBy: 'lookup', probe: probe({}), run: 'r1', at: 1 }).retired.map((r) => r.ref.sessionId)).toEqual(['a'])
    expect(s.retirePhantoms({ noticedBy: 'status call', probe: probe({}), at: 2 }).retired.map((r) => r.ref.sessionId)).toEqual(['b'])
    await s.close()
    expect([registration('a', WORKER_AGENT_ID)['noticed_by'], registration('b', WORKER_AGENT_ID)['noticed_by']]).toEqual(['lookup', 'status call'])
  })

  it('a re-run records the second process beside the first, and liveness reads the newest (D335)', async () => {
    const s = await open()
    await s.registerWorker(worker('w', { pid: 4242, start: 1000 }))
    const ref = { sessionId: 'w', agentId: WORKER_AGENT_ID }
    s.recordWorkerRerun(ref, { pid: 4310, start: 2000, host: 'laptop', at: 3 })
    // The first process is gone; the second runs: the leg is live.
    expect(s.retirePhantoms({ noticedBy: 'lookup', probe: probe({ procs: { 4310: 2000 } }) }).retired).toEqual([])
    await s.close()
    const r = registration('w', WORKER_AGENT_ID)
    expect([r['pid'], r['proc_start'], r['ended']]).toEqual([4242, 1000, null])
    expect(JSON.parse(String(r['processes'])).map((p: { pid: number; start: number }) => [p.pid, p.start])).toEqual([[4242, 1000], [4310, 2000]])
  })
})

describe('the registry around legs and workers', () => {
  it('a worker is never a self, never one of its session\'s subagents, and its tools rows are its role\'s, declared', async () => {
    const s = await open()
    await s.registerWorker(worker('w', { role: 'reviewer' }))
    await s.close()
    const db = new DatabaseSync(path())
    try {
      expect(liveSubagents(db, 'w')).toEqual([])
      expect(retireAllSubagents(db, 'w', 5)).toBe(0)
      expect(resolveWriter(db, 'w')).toEqual({ src: 'declared', writer: 'reviewer', agentId: WORKER_AGENT_ID })
    } finally { db.close() }
    expect(registration('w', WORKER_AGENT_ID)['stopped_at']).toBeNull()
  })

  it('a keyless subagent registers exactly as before and stays so; a leg\'s inferred key is settled once by its first write (D305, D320)', async () => {
    const s = await open()
    await s.close()
    const db = new DatabaseSync(path())
    try {
      registerSelf(db, 's1', MAIN, 1)
      registerSubagent(db, 's1', 'a1', 'explorer', MAIN, 2)
      expect(registration('s1', 'a1')).toMatchObject({ run: null, run_key: null, kind: null, key_src: null, send_backs: 0 })
      expect(settleLegKey(db, { sessionId: 's1', agentId: 'a1' }, 'r1', 'k', 'n1')).toBe(false)
      registerSubagent(db, 's1', 'a2', 'builder', MAIN, 3)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'a2', role: 'builder' }, { run: 'r1', key: 'k', keySrc: 'inferred' }, { at: 3 })
      expect(settleLegKey(db, { sessionId: 's1', agentId: 'a2' }, 'r2', 'other', 'n1')).toBe(false)
      expect(settleLegKey(db, { sessionId: 's1', agentId: 'a2' }, 'r1', 'other', 'n2')).toBe(true)
      expect(settleLegKey(db, { sessionId: 's1', agentId: 'a2' }, 'r1', 'third', 'n3')).toBe(false)
    } finally { db.close() }
    expect(registration('s1', 'a1')).toMatchObject({ run: null, run_key: null, key_src: null })
    expect(registration('s1', 'a2')).toMatchObject({ run: 'r1', run_key: 'other', key_src: 'own', kind: 'subagent', door: 'hooks', identity: 'hook', started_at: 3 })
    expect(JSON.parse(String(registration('s1', 'a2')['key_settled_from']))).toEqual({ node_id: 'n2', key: 'k', key_src: 'inferred' })
  })

  it('a declared key is never moved by a write; a worker cannot be registered twice', async () => {
    const s = await open()
    await s.close()
    const db = new DatabaseSync(path())
    try {
      registerWorkerLeg(db, { ...worker('w'), at: 1 })
      expect(settleLegKey(db, { sessionId: 'w', agentId: WORKER_AGENT_ID }, 'r1', 'elsewhere', 'n1')).toBe(false)
      expect(() => registerWorkerLeg(db, { ...worker('w'), at: 2 })).toThrow(/recordWorkerProcess/)
      recordWorkerProcess(db, { sessionId: 'w', agentId: WORKER_AGENT_ID }, { pid: 9, start: null, host: 'laptop', at: 3 })
      expect(legOf(db, { sessionId: 'w', agentId: WORKER_AGENT_ID })!.processes).toHaveLength(2)
    } finally { db.close() }
    expect(registration('w', WORKER_AGENT_ID)['run_key']).toBe('k')
  })

  it('a store the ladder had not reached opens and climbs to 31, its registrations intact', async () => {
    const s = await open()
    await s.close()
    const db = new DatabaseSync(path())
    try {
      registerSelf(db, 's1', MAIN, 1)
      registerSubagent(db, 's1', 'a1', 'tester', MAIN, 2)
      // Back to the shape 030 left: no leg columns, no run indexes.
      db.exec('DROP INDEX idx_session_registry_run; DROP INDEX idx_nodes_checkpoint_number; DROP INDEX idx_nodes_run')
      for (const c of ['kind', 'door', 'identity', 'run', 'run_key', 'key_src', 'key_candidates', 'brief_id', 'checkpointer', 'checkpointed_by',
        'start_checkpoints', 'parent_session', 'parent_src', 'parent_declared', 'ticket_minted_at', 'ticket_raw', 'ticket_absent', 'can_write',
        'host', 'pid', 'proc_start', 'proc_start_token', 'processes', 'send_backs', 'ended', 'noticed_at', 'noticed_by', 'opened_runs', 'cap_refused', 'key_settled_from']) {
        db.exec(`ALTER TABLE session_registry DROP COLUMN ${c}`)
      }
      setPragma(db, 'user_version = 30')
      expect(hasLegColumns(db)).toBe(false)
      // A hook meeting the older store: the registry it knows still works.
      expect(liveSubagents(db, 's1').map((r) => r.agentId)).toEqual(['a1'])
      expect(retirePhantoms(db, { noticedBy: 'session-start hook', probe: probe({}) }).retired).toEqual([])
      expect(retireAllSubagents(db, 's1', 3)).toBe(1)
      const report = runMigrations(openNodeSqlite(db), { migrate: true })
      expect(report.applied.map((a) => [a.version, a.kind])).toEqual([[31, 'additive']])
      expect(hasLegColumns(db)).toBe(true)
    } finally { db.close() }
    expect(registration('s1', 'a1')).toMatchObject({ agent_type: 'tester', stopped_at: 3, run: null, send_backs: 0 })
    expect(raw<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_session_registry_run', 'idx_nodes_checkpoint_number', 'idx_nodes_run') ORDER BY name").map((r) => r.name))
      .toEqual(['idx_nodes_checkpoint_number', 'idx_nodes_run', 'idx_session_registry_run'])
  })
})

describe('a run read back by plain SQL (D289)', () => {
  it('rows in their own moments\' order, a worker\'s lane reaching the run, nothing of another run', async () => {
    const s = await open()
    const w1 = await s.registerWorker({ ...worker('w1', { run: 'r1' }), at: 10 })
    await s.registerWorker({ ...worker('w2', { run: 'r2' }), at: 11 })
    const lane = await s.insert('captured in the lane, no run on it', { leg: { sessionId: w1.sessionId, agentId: WORKER_AGENT_ID }, createdAt: 30 })
    const cp = await s.writeCheckpoint('state: r1 done', { run: 'r1', key: 'k', leg: { sessionId: 'w1', agentId: WORKER_AGENT_ID }, at: 20 })
    await s.insert('r2 note', { leg: { sessionId: 'w2', agentId: WORKER_AGENT_ID }, createdAt: 15 })
    await s.close()
    const rows = raw<{ node_id: string; created_at: number; writer: string; kind: string | null; key: string | null; leg_session: string | null }>(RUN_ROWS_SQL, 'r1', 'r1')
    expect(rows.map((r) => [r.created_at, r.kind, r.writer, r.key])).toEqual([
      [10, 'run-open', 'treecontext', null], [20, 'checkpoint', 'builder', 'k'], [30, null, 'builder', 'k'],
    ])
    expect(rows.map((r) => r.node_id).slice(1)).toEqual([cp.nodeId, lane.nodeId])
    expect(rows[2]!.leg_session).toBe('w1')
  })
})

describe('the registry in a run (D311)', () => {
  it('a leg that opens a run names it on its registration, once, and the inner open names the way back', async () => {
    const s = await open()
    const outer = await s.registerWorker(worker('w1', { run: 'r1', role: 'reviewer' }))
    const ref = { sessionId: outer.sessionId, agentId: WORKER_AGENT_ID }
    const first = await s.openRun({ run: 'r1.review', leg: ref, parentRun: 'r1', parentLeg: ref })
    const again = await s.openRun({ run: 'r1.review', leg: ref, parentRun: 'r1', parentLeg: ref })
    expect([first.opened, again.opened, again.nodeId]).toEqual([true, false, first.nodeId])
    expect(s.legOf(ref)!.openedRuns).toEqual(['r1.review'])
    await s.close()
    expect(meta(first.nodeId)).toMatchObject({ kind: 'run-open', run: 'r1.review', parent_run: 'r1', parent_leg: { session_id: 'w1', agent_id: WORKER_AGENT_ID, role: 'reviewer' }, _writer: 'reviewer', _identity: 'declared' })
    expect(raw('SELECT 1 FROM nodes WHERE json_extract(metadata_json, \'$.kind\') = \'run-open\' AND json_extract(metadata_json, \'$.run\') = \'r1.review\'')).toHaveLength(1)
  })
})


describe('the D331 stamp, read with its sib clause', () => {
  it('a leg that writes 4 then 5 naming nothing leaves 5 alone in effect: 5 supersedes 4, 4 supersedes 3', async () => {
    const s = await open()
    const one = await s.writeCheckpoint('state: one', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const two = await s.writeCheckpoint('state: two', { run: 'r1', key: 'k', declared: { role: 'builder' }, supersedes: [one.nodeId] })
    const three = await s.writeCheckpoint('state: three', { run: 'r1', key: 'k', declared: { role: 'builder' }, supersedes: [two.nodeId] })
    await s.registerWorker(worker('w', { startCheckpoints: [three.nodeId] }))
    const ref = { sessionId: 'w', agentId: WORKER_AGENT_ID }
    const four = await s.writeCheckpoint('state: four', { run: 'r1', key: 'k', leg: ref })
    const five = await s.writeCheckpoint('state: five', { run: 'r1', key: 'k', leg: ref })
    expect([four.checkpoint!.number, five.checkpoint!.number]).toEqual([4, 5])
    expect(s.checkpointsInEffect('r1', 'k').map((c) => c.nodeId)).toEqual([five.nodeId])
    // Under another key the leg is not registered for, nothing it started
    // from is stamped: only its own newest there, and it has none yet.
    const other = await s.writeCheckpoint('state: elsewhere', { run: 'r1', key: 'other', leg: ref })
    await s.close()
    expect([meta(four.nodeId)['supersedes'], meta(four.nodeId)['_supersedes_src']]).toEqual([[three.nodeId], 'store'])
    expect([meta(five.nodeId)['supersedes'], meta(five.nodeId)['_supersedes_src']]).toEqual([[four.nodeId], 'store'])
    expect([meta(other.nodeId)['supersedes'], meta(other.nodeId)['_supersedes_src']]).toEqual([[], 'store'])
  })
})

describe('the start token (D317)', () => {
  it('a wall-clock step of 5 s with matching ticks leaves the worker live; different ticks at the same moment retire it', async () => {
    const s = await open()
    await s.registerWorker({ ...worker('stepped', { pid: 301, start: 1000 }), process: { pid: 301, start: 1000, token: 'boot-a:5000', host: 'laptop' } })
    await s.registerWorker({ ...worker('reused', { pid: 302, start: 1000 }), process: { pid: 302, start: 1000, token: 'boot-a:5000', host: 'laptop' } })
    await s.registerWorker({ ...worker('rebooted', { pid: 303, start: 1000 }), process: { pid: 303, start: 1000, token: 'boot-a:5000', host: 'laptop' } })
    const p: ProcessProbe = {
      host: () => 'laptop',
      exists: () => true,
      // The clock stepped: every wall-clock reading is 5 s off.
      startMoment: () => 1005,
      startToken: (pid) => ({ 301: 'boot-a:5000', 302: 'boot-a:9000', 303: 'boot-b:5000' } as Record<number, string>)[pid] ?? null,
    }
    const pass = s.retirePhantoms({ noticedBy: 'lookup', probe: p, at: 7 })
    expect(pass.retired.map((r) => r.ref.sessionId).sort()).toEqual(['rebooted', 'reused'])
    await s.close()
    expect(registration('stepped', WORKER_AGENT_ID)).toMatchObject({ ended: null, proc_start: 1000, proc_start_token: 'boot-a:5000' })
    expect(registration('reused', WORKER_AGENT_ID)).toMatchObject({ ended: 'phantom', noticed_at: 7 })
  })
})

describe('the run opens once, however many first legs register at once (D302)', () => {
  it('two writer processes registering workers into twenty fresh runs write one open row per run', async () => {
    const s = await open()
    await s.close()
    const barrier = mkdtempSync(join(tmpDir, 'barrier-'))
    const run = (who: string): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'run-opener.ts'), path(), barrier, who, '20'), { cwd: TS_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${who} exited ${code}: ${err}`))))
    })
    const a = run('a')
    const b = run('b')
    await new Promise((r) => setTimeout(r, 1500))
    writeFileSync(join(barrier, 'go'), '')
    await Promise.all([a, b])
    const opens = raw<{ run: string; n: number }>(
      "SELECT json_extract(metadata_json, '$.run') AS run, COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' GROUP BY run ORDER BY run")
    expect(opens).toHaveLength(20)
    for (const o of opens) expect(o.n).toBe(1)
    expect(raw<{ n: number }>("SELECT COUNT(*) AS n FROM session_registry WHERE kind = 'worker'")[0]!.n).toBe(40)
  }, 60_000)
})

describe('settling a leg\'s key: only an exact writer, only under its run (D320, D326)', () => {
  const NOW = (): number => Date.now() / 1000
  async function session(): Promise<{ s: FlatStore; c: Client; close: () => Promise<void> }> {
    const s = await open()
    const db = new DatabaseSync(path())
    try {
      registerSelf(db, 's1', MAIN, 100)
      registerSubagent(db, 's1', 'a1', 'builder', MAIN, 200)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'a1', role: 'builder' }, { run: 'r1', key: 'login-form', keySrc: 'inferred' }, { at: 200 })
    } finally { db.close() }
    const server = createServer(s, { ccSessionId: 's1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'settle', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    return { s, c, close: async () => { await c.close(); await server.close(); await s.close() } }
  }
  const put = async (c: Client, metadata: Record<string, unknown>): Promise<string> =>
    parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: { content: `note ${Math.random()}`, metadata } }))['node_id'] as string
  const heal = (s: FlatStore, nodeId: string, agentId: string | null, agentType: string | null) =>
    s.store.healWriterFromEcho({ nodeId, echoSessionId: 's1', echoTs: NOW(), deduplicated: false, agentId, agentType })

  it('a provisional stamp does not settle at insert; the echo naming the leg settles it', async () => {
    const { s, c, close } = await session()
    const id = await put(c, { run: 'r1', key: 'search-box' })
    expect(meta(id)['_writer_src']).toBe('provisional')
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'login-form', key_src: 'inferred' })
    expect(heal(s, id, 'a1', 'builder').outcome).toBe('confirmed')
    await close()
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'search-box', key_src: 'own' })
    expect(JSON.parse(String(registration('s1', 'a1')['key_settled_from']))).toEqual({ node_id: id, key: 'login-form', key_src: 'inferred' })
  })

  it('a concurrent stamp settles nothing at insert; the echo naming the leg settles it', async () => {
    const { s, c, close } = await session()
    s.store.insertStaging({ sessionId: 's1', role: 'user', content: 'keep going', timestamp: 300 })
    const id = await put(c, { run: 'r1', key: 'search-box' })
    expect(meta(id)['_writer_src']).toBe('concurrent')
    expect(registration('s1', 'a1')['key_src']).toBe('inferred')
    expect(heal(s, id, 'a1', 'builder').outcome).toBe('corrected')
    await close()
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'search-box', key_src: 'own' })
  })

  it('an ambiguous stamp settles nothing at insert; the echo naming one leg settles that leg alone', async () => {
    const { s, c, close } = await session()
    const db = new DatabaseSync(path())
    try {
      registerSubagent(db, 's1', 'a2', 'builder', MAIN, 210)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'a2', role: 'builder' }, { run: 'r1', key: null, keySrc: 'ambiguous' }, { at: 210 })
    } finally { db.close() }
    const id = await put(c, { kind: 'checkpoint', run: 'r1', key: 'search-box' })
    expect([meta(id)['_writer_src'], meta(id)['_supersedes_src']]).toEqual(['ambiguous', 'pending'])
    expect(heal(s, id, 'a2', 'builder').outcome).toBe('corrected')
    await close()
    expect(registration('s1', 'a2')).toMatchObject({ run_key: 'search-box', key_src: 'own' })
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'login-form', key_src: 'inferred' })
    expect([meta(id)['_supersedes_src'], meta(id)['supersedes']]).toEqual(['store', []])
  })

  it('probe: the main agent writing under a live leg\'s key through the tools never re-keys the leg', async () => {
    const { s, c, close } = await session()
    const id = await put(c, { kind: 'checkpoint', run: 'r1', key: 'search-box' })
    expect(meta(id)['_writer_src']).toBe('provisional')
    // Its echo carries no agent fields: the session's own agent wrote it.
    expect(heal(s, id, null, null).outcome).toBe('corrected')
    await close()
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'login-form', key_src: 'inferred', key_settled_from: null })
    expect([meta(id)['_writer'], meta(id)['supersedes'], meta(id)['_supersedes_src']]).toEqual(['main', undefined, undefined])
  })

  it('probe: a note carrying a bare `key` never re-keys the leg, insert or echo', async () => {
    const { s, c, close } = await session()
    const id = await put(c, { key: 'OPENAI_API_KEY' })
    expect(heal(s, id, 'a1', 'builder').outcome).toBe('confirmed')
    await close()
    expect(registration('s1', 'a1')).toMatchObject({ run_key: 'login-form', key_src: 'inferred', key_settled_from: null })
  })

  it('a settle the insert made under a stamp its echo contradicts is put back', async () => {
    // A worker's session: its own stamp is exact, so its write settles at
    // insert, and a subagent of the worker's session that wrote it after
    // all is named by the echo.
    const s = await open()
    await s.registerWorker({ sessionId: 'W', door: 'library', ticket: { parent: { id: 'p1' }, run: 'r1', key: null, role: 'builder' }, process: { pid: null, start: null, host: 'laptop' } })
    // Its ticket lost its key (D303): the registration has none yet.
    expect(registration('W', WORKER_AGENT_ID)).toMatchObject({ run_key: null, key_src: null })
    const server = createServer(s, { ccSessionId: 'W' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'undo', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    const id = await put(c, { run: 'r1', key: 'search-box' })
    expect(meta(id)['_writer_src']).toBe('declared')
    expect(registration('W', WORKER_AGENT_ID)).toMatchObject({ run_key: 'search-box', key_src: 'own' })
    const r = s.store.healWriterFromEcho({ nodeId: id, echoSessionId: 'W', echoTs: NOW(), deduplicated: false, agentId: 'sub1', agentType: 'helper' })
    expect(r.outcome).toBe('corrected')
    await c.close(); await server.close(); await s.close()
    expect(registration('W', WORKER_AGENT_ID)).toMatchObject({ run_key: null, key_src: null, key_settled_from: null })
  })
})
