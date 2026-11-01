/**
 * The hooks door below the charter (D279, D281, D295, D314, D320, D325,
 * D326, D327, D328, D330; unit 4 of the beta.3 build): the inference from
 * the role's briefs in effect, the cut at the client's cap, the send-back
 * decision at a leg's stop, the cut known at the session's next start, the
 * `claude -p` child's link to its worker lane, the gap ledger, and the
 * pointer line. Every storage claim is read back from the SQLite file
 * through a separate handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { nodeTsArgs } from './helpers/cli-spawn.js'
import { agentReturned } from '../src/hooks/post-tool-use.js'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { registerSelf, registerSubagent, retireAllSubagents, liveSubagents, type GitSelf } from '../src/persistence/session-registry.js'
import {
  WORKER_AGENT_ID, legOf, linkClientSession, workerLaneOf, settleLegKey, type LegRegistration,
} from '../src/persistence/leg-registry.js'
import {
  fitHookCap, composeFirstMessage, hookCutMarker, HOOK_CONTEXT_CAP, returnPointerLine, STATE_NOT_HISTORY_LINE, predecessorOf,
  type FirstMomentFacts,
} from '../src/first-moment.js'
import { inEffectLine, charactersOf, type CheckpointRecord } from '../src/runs.js'
import { owesSendBack } from '../src/hooks/subagent-stop.js'
import { storeRefusesWrites, blockOutput } from '../src/hooks/shared.js'
import { recordHookGap, claimHookGaps, gapLedgerPaths, hookGapText } from '../src/hooks/gap-ledger.js'
import { readTicket, mintTicket } from '../src/ticket.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-hooks-door-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'door.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: 1_000_000 })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
function withRaw<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path())
  try { return fn(db) } finally { db.close() }
}

/** A subagent registered as the SubagentStart hook registers it, then the
 *  hooks door's inference. */
function start(s: FlatStore, agentId: string, role = 'builder', at = Date.now() / 1000) {
  withRaw((db) => registerSubagent(db, 's1', agentId, role, MAIN, at))
  return s.startHooksLeg({ sessionId: 's1', agentId, role, at, where: MAIN })
}

describe('the brief → key inference at the hooks door (D305, D320, D326, D327)', () => {
  it('no brief in effect: a subagent exactly as today, nothing written', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 1))
    expect(start(s, 'a1')).toBeNull()
    const [r] = raw<Record<string, unknown>>("SELECT * FROM session_registry WHERE agent_id = 'a1'")
    expect([r!['kind'], r!['run'], r!['run_key'], r!['key_src']]).toEqual([null, null, null, null])
    expect(raw('SELECT 1 FROM nodes')).toHaveLength(0)
    await s.close()
  })

  it('one brief: a leg under its run and key, inferred, its start the checkpoint in effect, the run opened, the first moment the first row of its lane', async () => {
    const s = await open()
    const b = await s.writeBrief('wire the submit', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', checkpointedBy: 'reviewer', by: 'harness' })
    const cp = await s.writeCheckpoint('state: form renders', { run: 'r1', key: 'k', declared: { role: 'reviewer' } })
    const leg = start(s, 'a1')!
    expect([leg.leg.run, leg.leg.key, leg.leg.keySrc, leg.leg.briefId, leg.leg.checkpointer, leg.leg.checkpointedBy, leg.leg.door, leg.leg.identity])
      .toEqual(['r1', 'k', 'inferred', b.nodeId, 'builder', 'reviewer', 'hooks', 'hook'])
    expect(leg.leg.startCheckpoints).toEqual([cp.nodeId])
    expect(leg.cut).toBeNull()
    expect(leg.message).toContain('wire the submit')
    expect(leg.message).toContain('state: form renders')
    expect(leg.message).toContain(STATE_NOT_HISTORY_LINE)
    expect(leg.message).not.toContain("The spawner's prompt:")
    const opened = raw<{ m: string }>("SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open'")
    expect(opened).toHaveLength(1)
    expect(JSON.parse(opened[0]!.m)['first_leg']).toEqual({ session_id: 's1', agent_id: 'a1', role: 'builder' })
    const fm = raw<{ node_id: string; m: string; session_key: string }>(
      "SELECT node_id, session_key, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment'")
    expect(fm.map((r) => r.node_id)).toEqual([leg.firstMomentId])
    const m = JSON.parse(fm[0]!.m) as Record<string, unknown>
    expect([fm[0]!.session_key, m['_writer'], m['_writer_agent_id'], m['_writer_src'], m['_door'], m['refs']])
      .toEqual(['s1', 'builder', 'a1', 'hook', 'hooks', [b.nodeId, cp.nodeId]])
    expect((m['first_moment'] as Record<string, unknown>)['cut']).toBeNull()
    await s.close()
  })

  it('two briefs: the key ambiguous, the candidates kept, the run theirs when they share it; a write under one settles both', async () => {
    const s = await open()
    const a = await s.writeBrief('a', { run: 'r1', key: 'login-form', role: 'builder', by: 'harness' })
    const b = await s.writeBrief('b', { run: 'r1', key: 'search-box', role: 'builder', by: 'harness' })
    const leg = start(s, 'a1')!
    expect([leg.leg.run, leg.leg.key, leg.leg.keySrc]).toEqual(['r1', null, 'ambiguous'])
    expect(leg.leg.keyCandidates.map((c) => [c.run, c.key, c.briefId]).sort()).toEqual([['r1', 'login-form', a.nodeId], ['r1', 'search-box', b.nodeId]].sort())
    expect(leg.message).toContain('whose key is ambiguous')
    await s.close()
  })

  it('two briefs on two runs: no run of its own until a write under a candidate settles run and key; an undo puts both back', async () => {
    const s = await open()
    await s.writeBrief('a', { run: 'r1', key: 'k1', role: 'builder', by: 'harness' })
    await s.writeBrief('b', { run: 'r2', key: 'k2', role: 'builder', by: 'harness' })
    const leg = start(s, 'a1')!
    expect([leg.leg.run, leg.leg.key, leg.leg.keySrc]).toEqual([null, null, 'ambiguous'])
    expect(withRaw((db) => settleLegKey(db, { sessionId: 's1', agentId: 'a1' }, 'r3', 'k1', 'n0'))).toBe(false)
    expect(withRaw((db) => settleLegKey(db, { sessionId: 's1', agentId: 'a1' }, 'r2', 'k2', 'n1'))).toBe(true)
    const r = raw<Record<string, unknown>>("SELECT run, run_key, key_src FROM session_registry WHERE agent_id = 'a1'")[0]!
    expect([r['run'], r['run_key'], r['key_src']]).toEqual(['r2', 'k2', 'own'])
    const { unsettleLegKey } = await import('../src/persistence/leg-registry.js')
    expect(withRaw((db) => unsettleLegKey(db, { sessionId: 's1', agentId: 'a1' }, 'n1'))).toBe(true)
    const back = raw<Record<string, unknown>>("SELECT run, run_key, key_src FROM session_registry WHERE agent_id = 'a1'")[0]!
    expect([back['run'], back['run_key'], back['key_src']]).toEqual([null, null, 'ambiguous'])
    await s.close()
  })

  it('a newer brief for the role and key supersedes the older: one in effect, no ambiguity', async () => {
    const s = await open()
    const old = await s.writeBrief('older', { run: 'r1', key: 'k', role: 'builder', by: 'harness', at: 1 })
    const newer = await s.writeBrief('newer', { run: 'r1', key: 'k', role: 'builder', by: 'harness', supersedes: [old.nodeId] })
    const leg = start(s, 'a1')!
    expect([leg.leg.keySrc, leg.leg.briefId, leg.leg.keyCandidates]).toEqual(['inferred', newer.nodeId, []])
    await s.close()
  })

  it("a run's close ends its briefs: the brief of the open run alone is in effect", async () => {
    const s = await open()
    await s.writeBrief('closed run', { run: 'r1', key: 'k1', role: 'builder', by: 'harness' })
    await s.closeRun({ run: 'r1', reason: 'done', by: 'harness' })
    await s.writeBrief('open run', { run: 'r2', key: 'k2', role: 'builder', by: 'harness' })
    const leg = start(s, 'a1')!
    expect([leg.leg.run, leg.leg.key, leg.leg.keySrc]).toEqual(['r2', 'k2', 'inferred'])
    await s.close()
  })
})

/** Facts with one checkpoint of `size` characters, for the cap's arithmetic. */
function factsWith(size: number, brief = 'b'.repeat(1000)): FirstMomentFacts {
  const cp = { nodeId: 'c'.repeat(32), number: 4, writer: 'builder', createdAt: 1_790_000_000, content: 'x'.repeat(size), size } as CheckpointRecord
  return {
    run: 'r1', key: 'k', role: 'builder', noKey: false,
    briefs: [{ nodeId: 'b'.repeat(32), run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', checkpointedBy: null, writer: 'harness', createdAt: 1_790_000_000, content: brief, supersedes: [] }],
    checkpoints: [cp], inEffect: inEffectLine('r1', 'k', [cp]), named: { names: ['builder'], by: 'brief' }, flags: [],
    checkpointer: 'builder', checkpointedBy: null, predecessor: null,
  }
}

describe("the cut at the client's cap (D325, D332)", () => {
  const overhead = composeFirstMessage(factsWith(0), null, { door: 'hooks' }).length
  // The size digits move with the size: probe the exact size that fills it.
  const sizeFor = (chars: number): number => {
    let size = chars - overhead
    for (let i = 0; i < 3; i++) size += chars - composeFirstMessage(factsWith(size), null, { door: 'hooks' }).length
    return size
  }

  it('under the cap: whole, no cut', () => {
    const f = factsWith(sizeFor(9000))
    const r = fitHookCap(f)
    expect([r.message.length, r.cut]).toEqual([9000, null])
  })

  it('exactly at the cap: whole, no cut', () => {
    const f = factsWith(sizeFor(HOOK_CONTEXT_CAP))
    const r = fitHookCap(f)
    expect([r.message.length, r.cut]).toEqual([HOOK_CONTEXT_CAP, null])
    expect(r.message).toContain(f.checkpoints[0]!.content)
  })

  it('one past the cap: the brief whole, the checkpoint cut with its row id and the count left out, never past the cap', () => {
    const f = factsWith(sizeFor(HOOK_CONTEXT_CAP + 1))
    const r = fitHookCap(f)
    expect(r.message.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    expect(r.message).toContain(f.briefs[0]!.content)
    expect(r.message).toContain(STATE_NOT_HISTORY_LINE)
    const left = r.cut!.checkpoints[0]!.left_out
    expect(r.message).toContain(hookCutMarker('c'.repeat(32), left))
    const kept = f.checkpoints[0]!.size - left
    expect(r.message).toContain(`characters:\n${'x'.repeat(kept)}${hookCutMarker('c'.repeat(32), left)}`)
    expect(r.cut).toMatchObject({ cap: HOOK_CONTEXT_CAP, whole_chars: HOOK_CONTEXT_CAP + 1 })
  })

  it('far past the cap: the same rule, the count left out in characters', () => {
    const f = factsWith(40000)
    const r = fitHookCap(f)
    expect(r.message.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    expect(r.cut!.checkpoints[0]!.left_out).toBe(40000 - (r.message.match(/x{50,}/)![0].length))
  })

  it('never splits a surrogate pair, and counts what it left out in code points', () => {
    const f = factsWith(0)
    const content = '😀'.repeat(9000)
    const cp = { ...f.checkpoints[0]!, content, size: charactersOf(content) }
    const r = fitHookCap({ ...f, checkpoints: [cp] })
    expect(r.message.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    expect(r.message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    const keptChars = charactersOf(r.message.match(/(😀)+/)![0])
    expect(r.cut!.checkpoints[0]!.left_out).toBe(9000 - keptChars)
  })

  it('a brief past the cap (12,000 characters): the whole message cut with the rows to fetch, the state line still closing it', () => {
    const f = factsWith(100, 'b'.repeat(12000))
    const r = fitHookCap(f)
    expect(r.message.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    expect(r.cut!.left_out).toBeGreaterThan(0)
    expect(r.message).toContain('c'.repeat(32))
    expect(r.message.endsWith(`\n\n${STATE_NOT_HISTORY_LINE}`)).toBe(true)
    expect(r.message.split(STATE_NOT_HISTORY_LINE)).toHaveLength(2)
  })

  it('a block reason is held to the cap too', () => {
    const out = JSON.parse(blockOutput('r'.repeat(HOOK_CONTEXT_CAP + 50))) as { reason: string }
    expect(out.reason.length).toBe(HOOK_CONTEXT_CAP)
  })
})

const legWith = (o: Partial<LegRegistration>): LegRegistration => ({
  sessionId: 's1', agentId: 'a1', role: 'builder', kind: 'subagent', door: 'hooks', identity: 'hook', run: 'r1', key: 'k', keySrc: 'own',
  keyCandidates: [], briefId: null, checkpointer: 'builder', checkpointedBy: null, startCheckpoints: [], parentSession: 's1', parentSrc: 'hook',
  parentDeclared: null, ticketMintedAt: null, ticketRaw: null, ticketAbsent: [], canWrite: null, host: null, pid: null, procStart: null,
  procStartToken: null, processes: [], sendBacks: 0, ended: null, noticedAt: null, noticedBy: null, openedRuns: [], keySettledFrom: null,
  capRefused: [], clientSessions: [], worktree: null, branch: null, cwd: null, startedAt: 1, stoppedAt: null, ...o,
})

describe('the send-back decision at a leg stop (D279, D281, D295, D326)', () => {
  it('own key, its own role named, no checkpoint since its start, never sent back: owed', () => {
    expect(owesSendBack(legWith({}), false)).toBe(true)
    expect(owesSendBack(legWith({ keySrc: 'declared' }), false)).toBe(true)
  })
  it('an inferred or ambiguous key never asks (D326)', () => {
    expect(owesSendBack(legWith({ keySrc: 'inferred' }), false)).toBe(false)
    expect(owesSendBack(legWith({ keySrc: 'ambiguous', key: null }), false)).toBe(false)
  })
  it('another role named, or nobody, never asks (D281)', () => {
    expect(owesSendBack(legWith({ checkpointer: 'project-manager' }), false)).toBe(false)
    expect(owesSendBack(legWith({ checkpointer: null }), false)).toBe(false)
  })
  it('a checkpoint since the start, or the one send-back spent by either door, never asks again', () => {
    expect(owesSendBack(legWith({}), true)).toBe(false)
    expect(owesSendBack(legWith({ sendBacks: 1 }), false)).toBe(false)
  })
  it('a store that refuses writes is said so before anything is asked', () => {
    const p = join(tmpDir, 'ro.db')
    writeFileSync(p, '')
    expect(storeRefusesWrites(p)).toBeNull()
    chmodSync(p, 0o444)
    try {
      expect(storeRefusesWrites(p)).toBe('the store is read-only for this session')
    } finally { chmodSync(p, 0o644) }
    expect(storeRefusesWrites(join(tmpDir, 'nope', 'x.db'))).toMatch(/^the store is unavailable/)
  })
})

describe("the cut known at the session's next start (D328)", () => {
  it('a leg left live is cut, noticed, with no exit time; a plain subagent is retired as before; a worker is untouched', async () => {
    const s = await open()
    await s.writeBrief('b', { run: 'r1', key: 'k', role: 'builder', by: 'harness' })
    withRaw((db) => registerSelf(db, 's1', MAIN, 1))
    start(s, 'leg', 'builder', 2)
    withRaw((db) => registerSubagent(db, 's1', 'plain', 'explorer', MAIN, 3))
    await s.registerWorker({ sessionId: 'w1', door: 'library', ticket: { parent: { id: 's1' }, run: 'r1', key: 'k', role: 'reviewer' }, process: { pid: process.pid, start: null, host: hostname() } })
    expect(withRaw((db) => liveSubagents(db, 's1').map((a) => a.agentId))).toEqual(['leg', 'plain'])
    expect(withRaw((db) => retireAllSubagents(db, 's1', 100))).toBe(2)
    const rows = raw<Record<string, unknown>>("SELECT agent_id, stopped_at, ended, noticed_at, noticed_by FROM session_registry WHERE agent_id IN ('leg', 'plain') ORDER BY agent_id")
    expect(rows).toEqual([
      { agent_id: 'leg', stopped_at: null, ended: 'cut', noticed_at: 100, noticed_by: 'session-start hook' },
      { agent_id: 'plain', stopped_at: 100, ended: null, noticed_at: null, noticed_by: null },
    ])
    // A cut leg is no live subagent for the writer stamp.
    expect(withRaw((db) => liveSubagents(db, 's1'))).toHaveLength(0)
    expect(raw<{ ended: string | null }>("SELECT ended FROM session_registry WHERE session_id = 'w1'")[0]!.ended).toBeNull()
    // The next leg of its role recovers from it, its key inferred, since
    // nothing stopped it to settle anything (D328).
    const p = withRaw((db) => predecessorOf(db, null, { run: 'r1', key: 'k', role: 'builder' }))
    expect(p).toEqual({ sessionId: 's1', agentId: 'leg', role: 'builder', ended: 'cut', rows: 0 })
    await s.close()
  })

  it('a leg that stopped on its own with its key still inferred is keyless, never recovered from', async () => {
    const s = await open()
    await s.writeBrief('b', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    start(s, 'leg')
    s.retireHooksLeg({ sessionId: 's1', agentId: 'leg' }, { report: 'nothing to do' })
    expect(withRaw((db) => predecessorOf(db, null, { run: 'r1', key: 'k', role: 'builder' }))).toBeNull()
    await s.close()
  })
})

describe("a `claude -p` child's link to its worker lane (D295)", () => {
  it('a client session linked to the lane the ticket door registered reads as that worker; the lane itself does too; any other session does not', async () => {
    const s = await open()
    const reading = readTicket(mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }))
    const started = s.startWorker({ reading, prompt: 'go', sessionId: 'worker-abc', host: hostname() })
    const ref = { sessionId: started.leg.sessionId, agentId: WORKER_AGENT_ID }
    expect(withRaw((db) => linkClientSession(db, ref, 'cc-1'))).toBe(true)
    expect(withRaw((db) => linkClientSession(db, ref, 'cc-1'))).toBe(true)
    expect(withRaw((db) => linkClientSession(db, ref, 'cc-2'))).toBe(true)
    const links = JSON.parse(raw<{ c: string }>("SELECT client_sessions AS c FROM session_registry WHERE session_id = 'worker-abc'")[0]!.c) as Array<Record<string, unknown>>
    expect(links.map((l) => [l['id'], l['linked_by']])).toEqual([['cc-1', 'session-start hook'], ['cc-2', 'session-start hook']])
    expect(links.every((l) => typeof l['at'] === 'number')).toBe(true)
    expect(withRaw((db) => workerLaneOf(db, 'cc-2')?.sessionId)).toBe('worker-abc')
    expect(withRaw((db) => workerLaneOf(db, 'worker-abc')?.sessionId)).toBe('worker-abc')
    expect(withRaw((db) => workerLaneOf(db, 'cc-3'))).toBeNull()
    expect(withRaw((db) => legOf(db, ref)?.clientSessions.map((c) => c.id))).toEqual(['cc-1', 'cc-2'])
    await s.close()
  })

  it('a ticket door handed no prompt writes an empty first-moment row and a first message with no prompt part', async () => {
    const s = await open()
    const reading = readTicket(mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }))
    const started = s.startWorker({ reading, prompt: null, sessionId: 'cc-9', host: hostname() })
    expect(started.firstMessage).not.toContain("The spawner's prompt:")
    expect(raw<{ c: string }>('SELECT content AS c FROM nodes WHERE node_id = ?', started.firstMomentId)[0]!.c).toBe('')
    await s.close()
  })

  it("at the child's own session-start hook: the door's line as the row's text, the first message fitted to the cap and the cut on the row", async () => {
    const s = await open()
    await s.writeBrief('b'.repeat(500), { run: 'r1', key: 'k', role: 'builder', by: 'harness' })
    await s.writeCheckpoint('x'.repeat(30000), { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const reading = readTicket(mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }))
    const started = s.startWorker({ reading, prompt: null, sessionId: 'cc-10', host: hostname(), hookDoor: { allNamespaces: false } })
    expect(started.firstMessage.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    expect(started.firstMessage).toContain(STATE_NOT_HISTORY_LINE)
    const row = raw<{ c: string; m: string }>('SELECT content AS c, metadata_json AS m FROM nodes WHERE node_id = ?', started.firstMomentId)[0]!
    expect(row.c).toMatch(/^treecontext: the first moment of the builder worker \(session cc-10\) under the key "k" on the run "r1", through the session-start hook of a `claude -p` child/)
    const cut = (JSON.parse(row.m) as { first_moment: { cut: { cap: number; checkpoints: Array<{ left_out: number }> } } }).first_moment.cut
    expect(cut.cap).toBe(HOOK_CONTEXT_CAP)
    expect(cut.checkpoints[0]!.left_out).toBe(started.cut!.checkpoints[0]!.left_out)
    await s.close()
  })
})

describe('the gap ledger (D314)', () => {
  it('records a dropped event beside the store, or in the temp directory; the claim reads it after the grace, and lets go only when told', () => {
    const db = join(tmpDir, 'store', 'treecontext.db')
    rmSync(join(tmpDir, 'store'), { recursive: true, force: true })
    // No store directory: the temp directory takes it.
    expect(recordHookGap(db, { hook: 'subagent-start', sessionId: 's1', agentId: 'a1', agentType: 'builder', at: 5, error: 'locked', lost: 'its start' })).toBe(true)
    expect(existsSync(gapLedgerPaths(db)[1]!)).toBe(true)
    // Renamed aside, not read yet: inside the grace.
    const first = claimHookGaps(db, { graceMs: 1000, now: 1_000_000 })
    expect(first.gaps).toEqual([])
    expect(existsSync(gapLedgerPaths(db)[1]!)).toBe(false)
    // Past the grace: read; not let go, so read again; then let go.
    const second = claimHookGaps(db, { graceMs: 1000, now: 1_002_000 })
    expect(second.gaps.map((g) => [g.hook, g.agentId, g.at])).toEqual([['subagent-start', 'a1', 5]])
    expect(typeof second.gaps[0]!.id).toBe('string')
    const again = claimHookGaps(db, { graceMs: 1000, now: 1_003_000 })
    expect(again.gaps.map((g) => g.id)).toEqual([second.gaps[0]!.id])
    again.done()
    expect(claimHookGaps(db, { graceMs: 0 }).gaps).toEqual([])
    expect(hookGapText(second.gaps[0]!)).toBe('[capture gap] The subagent-start event of the builder subagent (agent a1) of session s1 at 1970-01-01T00:00:05.000Z was dropped: the store could not be written (locked). its start')
  })

  it('two hooks writing while the drain claims lose no line and duplicate none', async () => {
    const db = join(tmpDir, 'race', 'treecontext.db')
    mkdirSync(join(tmpDir, 'race'), { recursive: true })
    const writer = join(process.cwd(), 'tests', 'helpers', 'gap-writer.ts')
    const run = (label: string): Promise<void> => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, nodeTsArgs(writer, [db, label, '400']), { stdio: 'ignore' })
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${label} exited ${code}`))))
    })
    const seen: string[] = []
    let writing = true
    const both = Promise.all([run('a'), run('b')]).finally(() => { writing = false })
    const grace = 20
    while (writing) {
      const c = claimHookGaps(db, { graceMs: grace })
      seen.push(...c.gaps.map((g) => g.id!))
      c.done()
      await new Promise((r) => setTimeout(r, 5))
    }
    await both
    await new Promise((r) => setTimeout(r, grace * 3))
    for (let i = 0; i < 3; i++) {
      const c = claimHookGaps(db, { graceMs: grace })
      seen.push(...c.gaps.map((g) => g.id!))
      c.done()
      await new Promise((r) => setTimeout(r, grace * 2))
    }
    expect(seen.length).toBe(800)
    expect(new Set(seen).size).toBe(800)
  }, 60_000)
})

describe('the Agent tool result a pointer rides on (D330)', () => {
  it('a foreground return names its subagent; a background launch, another tool, or no id names none', () => {
    expect(agentReturned('Agent', { agentId: 'a1', content: [{ type: 'text', text: 'done' }] })).toBe('a1')
    expect(agentReturned('Task', { agentId: 'a1', content: [] })).toBe('a1')
    expect(agentReturned('Agent', { isAsync: true, status: 'async_launched', agentId: 'a1' })).toBeNull()
    expect(agentReturned('Agent', { status: 'async_launched', agentId: 'a1' })).toBeNull()
    expect(agentReturned('Bash', { agentId: 'a1' })).toBeNull()
    expect(agentReturned('Agent', { content: [] })).toBeNull()
  })
})

describe('the namespace a brief is read from (D320, the namespaces fence)', () => {
  it("a brief in another namespace is never this subagent's; read from every namespace only when the hook's did not resolve", async () => {
    const teamB = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), namespace: 'team-b', retentionInterval: 1_000_000 })
    await teamB.writeBrief('team-b reviews', { run: 'rb', key: 'kb', role: 'reviewer', by: 'harness' })
    await teamB.close()
    const s = await open()
    withRaw((db) => registerSubagent(db, 's1', 'a1', 'reviewer', MAIN, 1))
    expect(s.startHooksLeg({ sessionId: 's1', agentId: 'a1', role: 'reviewer', at: 1, where: MAIN })).toBeNull()
    expect(raw<{ kind: string | null }>("SELECT kind FROM session_registry WHERE agent_id = 'a1'")[0]!.kind).toBeNull()
    withRaw((db) => registerSubagent(db, 's1', 'a2', 'reviewer', MAIN, 2))
    const leg = s.startHooksLeg({ sessionId: 's1', agentId: 'a2', role: 'reviewer', at: 2, where: MAIN, allNamespaces: true })!
    expect([leg.leg.run, leg.leg.key]).toEqual(['rb', 'kb'])
    await s.close()
  })
})

describe("a run named by a settle opens as at a registration (D302, D320)", () => {
  it('an ambiguous leg across runs, settled under one, opens that run by the store, its first leg the leg', async () => {
    const s = await open()
    await s.writeBrief('a', { run: 'r1', key: 'k1', role: 'builder', by: 'harness' })
    await s.writeBrief('b', { run: 'r2', key: 'k2', role: 'builder', by: 'harness' })
    start(s, 'a1')
    expect(raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open'")).toHaveLength(0)
    await s.insert('plan: the second key', { leg: { sessionId: 's1', agentId: 'a1' }, metadata: { run: 'r2', key: 'k2' } })
    const opens = raw<{ m: string }>("SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open'").map((r) => JSON.parse(r.m) as Record<string, unknown>)
    expect(opens.map((o) => [o['run'], o['opened_via'], o['_writer'], (o['first_leg'] as Record<string, unknown>)['agent_id']])).toEqual([['r2', 'registration', 'treecontext', 'a1']])
    await s.close()
  })
})

describe('the pointer line (D284, D330)', () => {
  it('names the summary row, its writer, run and key; the key only when given', () => {
    expect(returnPointerLine({ role: 'builder', writer: 'builder', run: 'r1', key: 'k', summaryId: 'abc' }))
      .toBe('treecontext: the builder leg\'s return is the summary row abc (writer "builder", run "r1", key "k"); fetch it with treecontext_export.')
    expect(returnPointerLine({ role: 'builder', writer: 'builder', run: 'r1', key: null, summaryId: 'abc' })).not.toContain('key')
  })
})
