/**
 * Codex's turns at the hooks, beyond what the D408 scenarios reach (unit
 * 10 fix round): the Interrupt hook's deadline under a locked store, a
 * turn that never ends, a result that arrives after its turn's end was
 * staged, a dropped result already in the gap ledger, a subagent's calls
 * kept from the main's Stop, and a subagent summary read from the payload
 * alone; and only the capture pipeline's own rows of a call's own session
 * answer for it (a note naming the call's id, another session's call with
 * the same id, an imported copy). Every event is Codex's own recording (tests/fixtures/codex-hooks);
 * leaving one out of a replay is the choice a busy store or a killed client
 * makes, never a hand-written payload.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { recordedSession, replayRecordedSession } from '../journal/standins.js'
import { openCaptureWorld, drainStaging, rawJournal, type CaptureWorld } from '../journal/capture-harness.js'
import { sandboxedSpawnEnv } from '../helpers/cli-spawn.js'
import { TS_ROOT } from '../journal/proc.js'
import { gapLedgerPaths } from '../../src/hooks/gap-ledger.js'
import { FlatStore } from '../../src/flat-store.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { newestMainEvent } from '../../src/persistence/session-registry.js'
import { countSessionEntries } from '../../src/checkpoints.js'
import { classify, storeViewOf } from '../../scripts/capture-census.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../src/server/server.js'
import { buildHandoff } from '../../src/handoff.js'
import { STORE_ONLY_SOURCES } from '../../src/persistence/capture-marks.js'
import { RECOVERY_SNAPSHOT_SOURCE } from '../../src/persistence/recovery-snapshot.js'
import { mintTicket, readTicket, TICKET_ENV, WORKER_SESSION_ENV } from '../../src/ticket.js'

const V = '0.167.0'
const world = async (): Promise<CaptureWorld> => {
  const w = { defer: (fn: () => void) => { cleanups.push(fn) } } as unknown as CaptureWorld
  await openCaptureWorld(w)
  return w
}
const cleanups: Array<() => void> = []
const done = (): void => { while (cleanups.length) { try { cleanups.pop()!() } catch { /* gone */ } } }
const entries = (w: CaptureWorld, id: string) => rawJournal(w).filter((r) => r.metadata['tool_use_id'] === id)
/** The moment staging holds for a call's PreToolUse account: the call's own. */
const accountAt = (w: CaptureWorld, id: string): number => {
  const db = new DatabaseSync(w.dbPath!, { readOnly: true })
  try { return (db.prepare("SELECT timestamp AS t FROM staging WHERE tool_use_id = ? AND captured_from = 'pre-tool-use'").get(id) as { t: number }).t } finally { db.close() }
}
/** A day passes: every staged row is two days older. */
const aDayPasses = (w: CaptureWorld): void => {
  const db = new DatabaseSync(w.dbPath!)
  try { db.prepare('UPDATE staging SET timestamp = timestamp - 2 * 86400').run() } finally { db.close() }
}
/** The server's sweep (ingestion.ts runSweep): its purge of processed staging. */
const sweep = async (w: CaptureWorld): Promise<void> => { await new IngestionLoop(w.store!, { batchSize: 50, storePath: w.dbPath! }).runSweep() }
/** What a hook that could not stage a call's PostToolUse writes (shared.ts writeStaging). */
const ledgerTheResult = (w: CaptureWorld, session: string, id: string): void => {
  writeFileSync(gapLedgerPaths(w.dbPath!)[0]!, JSON.stringify({ hook: 'post-tool-use', sessionId: session, at: Date.now() / 1000, error: 'database is locked', lost: 'The call it captured was not staged.', toolUseId: id }) + '\n')
}
/** Classified exits on the trail pane (flat-store vitals). */
const classified = (w: CaptureWorld): number => Object.values(w.store!.vitals(Date.now() / 1000).trail.exits).reduce((a, b) => a + b, 0)

describe('a Codex turn with no end, and results that cross it', () => {
  it('a call whose turn never ended is journaled at the purge as no result and no turn end reached the journal, at the call\'s moment', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit.ndjson', 'codex')
      const patch = 'exec-de7bcb71-2211-458e-b99a-0f5a406787b5'
      const session = String(events[0]!['session_id'])
      // The client died before its turn's end: the Stop never fired.
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] !== 'Stop' })
      await drainStaging(w)
      expect(entries(w, patch)).toEqual([])
      // A day later the purge takes processed staging; the account first.
      aDayPasses(w)
      const at = accountAt(w, patch)
      const swept = Date.now() / 1000
      await sweep(w)
      // Nothing the purge wrote reads as the session's latest activity.
      expect(newestMainEvent(w.store!.store.database, session)!).toBeLessThan(swept)
      await drainStaging(w)
      const e = entries(w, patch)
      expect(e).toHaveLength(1)
      expect(e[0]!.metadata['captured_from']).toBe('no-turn-end')
      expect(e[0]!.content).toContain('neither its result nor the end of its turn reached the journal')
      expect(e[0]!.content).not.toContain('no PostToolUse')
      // The entry's moment is the call's; ingested_at says when it was written.
      expect(e[0]!.metadata['created_at']).toBe(at)
      expect(Number(e[0]!.metadata['ingested_at'])).toBeGreaterThan(at + 86400)
    } finally { done() }
  }, 120_000)

  it('a call that ran past a day is one call: its result after the no-turn-end entry resolves that entry, which stays', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const id = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] !== 'Stop' && e['hook_event_name'] !== 'PostToolUse' })
      await drainStaging(w)
      aDayPasses(w)
      await sweep(w)
      await drainStaging(w)
      const before = classified(w)
      const [early] = entries(w, id)
      expect(early!.metadata['captured_from']).toBe('no-turn-end')
      // The result arrives at last.
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'PostToolUse' })
      await drainStaging(w)
      const e = entries(w, id)
      expect(e).toHaveLength(2)
      const result = e.find((r) => r.metadata['captured_from'] === undefined)!
      const resolved = e.find((r) => r.metadata['captured_from'] === 'no-turn-end')!
      expect(resolved.nodeId).toBe(early!.nodeId)
      expect(resolved.metadata['resolved_by']).toBe(result.nodeId)
      expect(resolved.metadata['resolved_how']).toBe('result')
      expect(resolved.content).toBe(early!.content)
      // One call to every reader: the census by id, the trail pane's exits.
      expect(classify([{ id, name: 'apply_patch', input: {}, outcome: 'succeeded', session: '', at: null, messageId: null, file: '' }], storeViewOf(new DatabaseSync(w.dbPath!, { readOnly: true }))).map((r) => r.status)).toEqual(['stored'])
      expect(classified(w)).toBe(before + 1)
    } finally { done() }
  }, 120_000)

  it('a result staged after the purge staged its no-turn-end row, before the drain, leaves one entry, from the result', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const id = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] !== 'Stop' && e['hook_event_name'] !== 'PostToolUse' })
      await drainStaging(w)
      aDayPasses(w)
      await sweep(w)
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'PostToolUse' })
      await drainStaging(w)
      const e = entries(w, id)
      expect(e).toHaveLength(1)
      expect(e[0]!.metadata['captured_from']).toBeUndefined()
    } finally { done() }
  }, 120_000)

  it('a result staged after its turn\'s end leaves one entry, from the result', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const id = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
      const order = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'PostToolUse']
      for (const name of order) replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === name })
      await drainStaging(w)
      const e = entries(w, id)
      expect(e).toHaveLength(1)
      expect(e[0]!.metadata['captured_from']).toBeUndefined()
    } finally { done() }
  }, 120_000)

  it('a result drained after its no-result entry resolves that entry, which stays, at the call\'s moment', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const id = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
      const order = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']
      for (const name of order) replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === name })
      const at = accountAt(w, id)
      const session = [String(events[0]!['session_id'])]
      // One call, one entry, before the drain as after it.
      expect(countSessionEntries(w.store!.store.database, session, at - 1e-6, at + 1e-6)).toBe(1)
      await drainStaging(w)
      expect(countSessionEntries(w.store!.store.database, session, at - 1e-6, at + 1e-6)).toBe(1)
      const [early] = entries(w, id)
      expect(early!.metadata['captured_from']).toBe('no-result')
      expect(early!.metadata['created_at']).toBe(at)
      const before = classified(w)
      const all = countSessionEntries(w.store!.store.database, session, -1e15)
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'PostToolUse' })
      await drainStaging(w)
      const e = entries(w, id)
      expect(e).toHaveLength(2)
      const result = e.find((r) => r.metadata['captured_from'] === undefined)!
      expect(e.find((r) => r.nodeId === early!.nodeId)!.metadata['resolved_by']).toBe(result.nodeId)
      // Still one call: one classified exit more, and no entry more.
      expect(classified(w)).toBe(before + 1)
      expect(countSessionEntries(w.store!.store.database, session, -1e15)).toBe(all)
    } finally { done() }
  }, 120_000)

  it('a result whose own staging was dropped to the gap ledger is never journaled as one Codex reported no result for', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const id = 'exec-108faeb3-f0b8-4aed-8e5b-b185b88798a7'
      replayRecordedSession(w, events, { lines: (_l, e) => !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === id) && e['hook_event_name'] !== 'Stop' })
      // What a hook that could not stage the PostToolUse writes (shared.ts writeStaging).
      writeFileSync(gapLedgerPaths(w.dbPath!)[0]!, JSON.stringify({ hook: 'post-tool-use', sessionId: String(events[0]!['session_id']), at: Date.now() / 1000, error: 'database is locked', lost: 'The Bash call it captured was not staged.', toolUseId: id }) + '\n')
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'Stop' })
      await drainStaging(w)
      expect(rawJournal(w).filter((r) => r.metadata['tool_use_id'] === id && r.metadata['captured_from'] === 'no-result')).toEqual([])
      expect(rawJournal(w).filter((r) => r.metadata['gap_tool_use_id'] === id)).toHaveLength(1)
    } finally { done() }
  }, 120_000)

  it('a result in the gap ledger whose line the drain has not written yet keeps the purge from journaling the call as no turn end', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const id = 'exec-108faeb3-f0b8-4aed-8e5b-b185b88798a7'
      replayRecordedSession(w, events, { lines: (_l, e) => !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === id) && e['hook_event_name'] !== 'Stop' })
      await drainStaging(w)
      ledgerTheResult(w, String(events[0]!['session_id']), id)
      aDayPasses(w)
      await sweep(w)
      await drainStaging(w)
      expect(entries(w, id)).toEqual([])
      expect(rawJournal(w).filter((r) => r.metadata['gap_tool_use_id'] === id)).toHaveLength(1)
    } finally { done() }
  }, 120_000)

  it('a result whose capture-gap row landed before the purge keeps the purge from journaling the call as no turn end', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const id = 'exec-108faeb3-f0b8-4aed-8e5b-b185b88798a7'
      replayRecordedSession(w, events, { lines: (_l, e) => !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === id) && e['hook_event_name'] !== 'Stop' })
      ledgerTheResult(w, String(events[0]!['session_id']), id)
      await drainStaging(w)
      expect(gapLedgerPaths(w.dbPath!).some((p) => existsSync(p))).toBe(false)
      aDayPasses(w)
      await sweep(w)
      await drainStaging(w)
      expect(entries(w, id)).toEqual([])
    } finally { done() }
  }, 120_000)

  it('a dropped result whose ledger line is written after the no-result entry landed resolves that entry by the gap row', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const id = 'exec-108faeb3-f0b8-4aed-8e5b-b185b88798a7'
      replayRecordedSession(w, events, { lines: (_l, e) => !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === id) })
      await drainStaging(w)
      const [early] = entries(w, id)
      expect(early!.metadata['captured_from']).toBe('no-result')
      ledgerTheResult(w, String(events[0]!['session_id']), id)
      await drainStaging(w)
      const gap = rawJournal(w).find((r) => r.metadata['gap_tool_use_id'] === id)!
      const after = entries(w, id)
      expect(after).toHaveLength(1)
      expect(after[0]!.metadata['resolved_by']).toBe(gap.nodeId)
      expect(after[0]!.metadata['resolved_how']).toBe('capture-gap')
    } finally { done() }
  }, 120_000)
})

describe("a Codex subagent's calls and summary", () => {
  const SUB_CALL = 'exec-a41873d2-4779-4d0f-829c-9da9973ac2c1'
  it("a subagent's call with no result is journaled at its SubagentStop as its own, never by the main's Stop", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'subagent.ndjson', 'codex')
      // The subagent's PostToolUse dropped, and its stop held back: the
      // main's Stop must not resolve the subagent's call.
      replayRecordedSession(w, events, { lines: (_l, e) => !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === SUB_CALL) && e['hook_event_name'] !== 'SubagentStop' })
      await drainStaging(w)
      expect(entries(w, SUB_CALL)).toEqual([])
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'SubagentStop' })
      await drainStaging(w)
      const e = entries(w, SUB_CALL)
      expect(e).toHaveLength(1)
      expect(e[0]!.metadata['captured_from']).toBe('no-result')
      expect(e[0]!.metadata['_writer_agent_id']).toBe(events.find((x) => x['hook_event_name'] === 'SubagentStart')!['agent_id'])
    } finally { done() }
  }, 120_000)

  it("the summary is the payload's reply, never a transcript's", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'subagent.ndjson', 'codex')
      const stop = events.find((e) => e['hook_event_name'] === 'SubagentStop')!
      // A decoy at the path the replay points agent_transcript_path to: a
      // Claude Code transcript whose hand-back would be read first on
      // Claude Code (D371).
      const decoy = join(w.proj!, String(stop['agent_transcript_path']).split('/').pop()!)
      writeFileSync(decoy, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'DECOY transcript report' } }] } }) + '\n')
      replayRecordedSession(w, events)
      await drainStaging(w)
      const summaries = rawJournal(w).filter((r) => r.metadata['kind'] === 'subagent-summary')
      expect(summaries.map((r) => r.content)).toEqual([String(stop['last_assistant_message'])])
      expect(existsSync(decoy)).toBe(true)
    } finally { done() }
  }, 120_000)
})

describe('an interrupted turn', () => {
  it("a call of the turn whose PostToolUse was lost is journaled at the Interrupt as one Codex reported no result for", async () => {
    const w = await world()
    try {
      const all = recordedSession(V, 'interactive.ndjson', 'codex')
      const end = all.findIndex((e) => e['hook_event_name'] === 'Interrupt')
      const turn = all[end]!['turn_id']
      const posts = all.filter((e) => e['turn_id'] === turn && e['hook_event_name'] === 'PostToolUse')
      const lost = String(posts[posts.length - 1]!['tool_use_id'])
      // A busy store drops that PostToolUse: the replay leaves it out.
      replayRecordedSession(w, all, { lines: (l, e) => (l === 0 || (e['turn_id'] === turn)) && !(e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === lost) })
      await drainStaging(w)
      const e = entries(w, lost)
      expect(e).toHaveLength(1)
      expect(e[0]!.metadata['captured_from']).toBe('no-result')
      // The call's moment, never the Interrupt's.
      expect(e[0]!.metadata['created_at']).toBe(accountAt(w, lost))
    } finally { done() }
  }, 120_000)

  it("under a locked store the Interrupt hook ledgers the turn inside Codex's 3 s and the drain writes the gap", async () => {
    const w = await world()
    try {
      const all = recordedSession(V, 'interactive.ndjson', 'codex')
      replayRecordedSession(w, all, { lines: (l) => l === 0 })
      const interrupt = { ...all.find((e) => e['hook_event_name'] === 'Interrupt')!, cwd: w.proj }
      // This process lets go of the store first (an idle reader keeps the
      // locker from proving its lock), then another process holds it.
      await w.store!.close()
      const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', 'store-locker.cjs'), w.dbPath!], { stdio: ['ignore', 'pipe', 'pipe'] })
      try {
        await new Promise<void>((resolve, reject) => {
          let seen = ''
          const bail = setTimeout(() => reject(new Error(`locker never locked: ${seen}`)), 20_000)
          locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
        })
        // The built CLI, as the installed script execs it, killed at 3 s as Codex kills it.
        const cli = join(TS_ROOT, 'dist', 'server', 'cli.js')
        expect(existsSync(cli), 'run npm run build first').toBe(true)
        const started = Date.now()
        const r = spawnSync(process.execPath, [cli, 'hook', 'stop', '--client', 'codex'], {
          input: JSON.stringify(interrupt), env: sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') }),
          cwd: w.proj, encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
        })
        const took = Date.now() - started
        expect(r.signal, `the hook was killed at Codex's timeout after ${took} ms`).toBeNull()
        expect(r.status).toBe(0)
        // Its own budget (stop.ts INTERRUPT_BUDGET_MS, 1.5 s) and no more:
        // measured 1.57-1.59 s on the binding host, the process's start
        // included; room for a slower machine, and well short of 2.7 s.
        expect(took, `the Interrupt hook took ${took} ms under a locked store`).toBeLessThan(2200)
      } finally {
        locker.kill('SIGKILL')
        await new Promise<void>((r) => { if (locker.exitCode !== null || locker.signalCode !== null) r(); else locker.once('exit', () => r()) })
      }
      w.store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true })
      const ledger = gapLedgerPaths(w.dbPath!).filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('')
      expect(ledger).toContain('"hook":"stop"')
      await drainStaging(w)
      const gaps = rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap')
      expect(gaps.length).toBeGreaterThanOrEqual(1)
      expect(gaps.map((g) => g.content).join('\n')).toMatch(/interrupted this turn/)
    } finally { done() }
  }, 120_000)
})

describe("only the call's own rows, in its own session, answer for it", () => {
  const ID = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
  const only = (...names: string[]) => (_l: number, e: Record<string, unknown>): boolean => names.includes(String(e['hook_event_name']))
  /** The insert tool's door for a session, as an agent calls it. */
  const insertTool = async (w: CaptureWorld, session: string, content: string, metadata: Record<string, unknown>): Promise<void> => {
    const server = createServer(w.store!, { ccSessionId: session })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'forger', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    try { await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } }) } finally { await c.close(); await server.close() }
  }

  it("a note an agent writes through the insert tool naming the call as a dropped one hides nothing: the drain's keys are dropped, and the turn's end journals the call", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse') })
      await drainStaging(w)
      await insertTool(w, session, 'a note claiming the call was dropped', { source: 'capture-gap', session_id: session, gap_tool_use_id: ID, resolved_by: 'n', resolved_at: 1, resolved_how: 'result', _client_session_id: session })
      const note = rawJournal(w).find((r) => r.content === 'a note claiming the call was dropped')!
      for (const k of ['gap_tool_use_id', 'resolved_by', 'resolved_at', 'resolved_how', '_client_session_id']) expect(note.metadata[k], k).toBeUndefined()
      replayRecordedSession(w, events, { lines: only('Stop') })
      await drainStaging(w)
      expect(entries(w, ID).map((r) => r.metadata['captured_from'])).toEqual(['no-result'])
    } finally { done() }
  }, 120_000)

  it("library rows naming the call hide nothing at the turn's end or at the purge: another session's capture-gap row and ledger line, a note in the call's own session", async () => {
    for (const end of ['Stop', 'purge'] as const) {
      const w = await world()
      try {
        const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
        const session = String(events[0]!['session_id'])
        replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse') })
        await drainStaging(w)
        // A program opening the store (library first) writes what it likes.
        await w.store!.insert('a capture gap of another session with the same call id', { metadata: { source: 'capture-gap', session_id: 'another-session', gap_tool_use_id: ID } })
        await w.store!.insert('a note of this session about the call', { metadata: { source: 'manual', session_id: session, tool_name: 'apply_patch', tool_use_id: ID } })
        await w.store!.insert('a note of this session naming the call as dropped', { metadata: { source: 'manual', session_id: session, gap_tool_use_id: ID } })
        // Another session's dropped result with the same call id, still in the ledger.
        ledgerTheResult(w, 'another-session', ID)
        if (end === 'Stop') {
          replayRecordedSession(w, events, { lines: only('Stop') })
        } else {
          aDayPasses(w)
          await sweep(w)
        }
        await drainStaging(w)
        expect(entries(w, ID).filter((r) => r.metadata['captured_from'] !== undefined).map((r) => r.metadata['captured_from']), end).toEqual([end === 'Stop' ? 'no-result' : 'no-turn-end'])
      } finally { done() }
    }
  }, 240_000)

  it("a result resolves only its own session's entry: another session's call with the same id, and an imported copy, stay as written", async () => {
    const w = await world()
    const w2 = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      // Session A's call ends with no result reported.
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop') })
      // Another session, with the same call id, ends with no result reported too.
      replayRecordedSession(w, events, { sessionId: 'another-session', lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop') })
      // A teammate's store with the same session, exported whole and imported here.
      replayRecordedSession(w2, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop') })
      await drainStaging(w)
      await drainStaging(w2)
      const file = buildHandoff(w2.store!, { form: 'whole', project: 'p', path: 'handoff.json' }).text
      await w.store!.importJson(file, { handoff: { file: 'handoff.json', importer: null } })
      // The copy lands in a handoff lane, its capture marks the file's claims.
      const claimsOf = (r: { metadata: Record<string, unknown> }): Record<string, unknown> => (r.metadata['_handoff_claims'] ?? {}) as Record<string, unknown>
      const copy = rawJournal(w).find((r) => String(r.metadata['session_id']).startsWith('handoff:') && claimsOf(r)['tool_use_id'] === ID)
      expect(copy && claimsOf(copy)['captured_from'], 'the imported copy').toBe('no-result')
      // Session A's result arrives.
      replayRecordedSession(w, events, { lines: only('PostToolUse') })
      await drainStaging(w)
      const all = entries(w, ID)
      const result = all.find((r) => r.metadata['session_id'] === session && r.metadata['captured_from'] === undefined)!
      expect(all.find((r) => r.metadata['session_id'] === session && r.metadata['captured_from'] === 'no-result')!.metadata['resolved_by']).toBe(result.nodeId)
      expect(all.find((r) => r.metadata['session_id'] === 'another-session')!.metadata['resolved_by'], 'another session').toBeUndefined()
      const after = rawJournal(w).find((r) => r.nodeId === copy!.nodeId)!
      expect([after.metadata['resolved_by'], claimsOf(after)['resolved_by']], 'the imported copy').toEqual([undefined, undefined])
    } finally { done() }
  }, 180_000)

  it("a note in the call's own session carrying the marks of an unresolved entry is never marked resolved: only a captured row is", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop') })
      await drainStaging(w)
      const note = await w.store!.insert('a note shaped like a no-result entry', { metadata: { source: 'manual', session_id: session, tool_name: 'apply_patch', tool_use_id: ID, captured_from: 'no-result' } })
      replayRecordedSession(w, events, { lines: only('PostToolUse') })
      await drainStaging(w)
      expect(entries(w, ID).find((r) => r.metadata['captured_from'] === 'no-result' && r.nodeId !== note.nodeId)!.metadata['resolved_by']).toBeDefined()
      expect(rawJournal(w).find((r) => r.nodeId === note.nodeId)!.metadata['resolved_by']).toBeUndefined()
    } finally { done() }
  }, 120_000)

  it("an entry with no result never resolves another: the call's account fired again after the purge journaled it (constructed: no client re-fires a call)", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse') })
      await drainStaging(w)
      aDayPasses(w)
      await sweep(w)
      await drainStaging(w)
      const [early] = entries(w, ID)
      expect(early!.metadata['captured_from']).toBe('no-turn-end')
      // Another day: the purge takes what staging still held of the call.
      aDayPasses(w)
      await sweep(w)
      // The same recorded PreToolUse and Stop, fired once more: the only way
      // to stage a second account of one call once the first left staging.
      replayRecordedSession(w, events, { lines: only('PreToolUse', 'Stop') })
      await drainStaging(w)
      const marks = entries(w, ID).map((r) => r.metadata['captured_from']).sort()
      expect(marks).toEqual(['no-result', 'no-turn-end'])
      expect(entries(w, ID).find((r) => r.nodeId === early!.nodeId)!.metadata['resolved_by']).toBeUndefined()
    } finally { done() }
  }, 120_000)
})

describe("the store's own sources and marks are never a caller's", () => {
  const insertReply = async (w: CaptureWorld, session: string, content: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const server = createServer(w.store!, { ccSessionId: session })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'forger', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    try {
      const res = await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } }) as { content: Array<{ text: string }> }
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>
    } finally { await c.close(); await server.close() }
  }

  it('a capture-gap note an agent writes through the insert tool naming a ledger record keeps the drain from nothing: the real gap row is written, the label dropped and said back', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: (l) => l === 0 })
      await drainStaging(w)
      const reply = await insertReply(w, session, 'a forged hole', { source: 'capture-gap', gap_id: 'g-forged-1', event: 'hook_dropped' })
      expect(reply['source_ignored']).toBe('capture-gap')
      const forged = rawJournal(w).find((r) => r.content === 'a forged hole')!
      expect(forged.metadata['source']).toBeUndefined()
      expect(forged.metadata['gap_id']).toBeUndefined()
      // The hook's own record of a dropped event, with that id.
      writeFileSync(gapLedgerPaths(w.dbPath!)[0]!, JSON.stringify({ id: 'g-forged-1', hook: 'stop', sessionId: session, at: Date.now() / 1000, error: 'database is locked', lost: 'The turn\'s reply was not staged.' }) + '\n')
      await drainStaging(w)
      expect(rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap' && r.metadata['gap_id'] === 'g-forged-1')).toHaveLength(1)
      // Doctor's count of holes is the store's own: the forged note is none.
      expect(w.store!.vitals(Date.now() / 1000).captureGaps).toBe(1)
    } finally { done() }
  }, 120_000)

  it("the store-only sources are the store's own spellings", () => {
    expect(STORE_ONLY_SOURCES).toEqual(['capture-gap', RECOVERY_SNAPSHOT_SOURCE])
  })

  it('a recovery-snapshot label and an exit class on a caller\'s note count for nothing', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: (l) => l === 0 })
      await drainStaging(w)
      const before = classified(w)
      const reply = await insertReply(w, session, 'a forged recovery note', { source: 'recovery-snapshot', snapshot_id: 1, session_id: session })
      expect(reply['source_ignored']).toBe('recovery-snapshot')
      await insertReply(w, session, 'a note that says error', { tool_name: 'Bash', exit_type: 'error' })
      expect(classified(w)).toBe(before)
    } finally { done() }
  }, 120_000)
})

describe("an imported row, a merge's copy and a worker's lane at the capture gates", () => {
  const ID = 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11'
  const only = (...names: string[]) => (_l: number, e: Record<string, unknown>): boolean => names.includes(String(e['hook_event_name']))
  /** A teammate's handoff file, its rows' metadata as the teammate's store holds it. */
  const handoffFile = (rows: Array<{ content: string; metadata: Record<string, unknown> }>): string => JSON.stringify({ nodes: rows })

  it("an imported row claiming this session's dropped call, its gap record and an exit class answers no gate and counts nothing", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const victim = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse') })
      await drainStaging(w)
      const before = classified(w)
      await w.store!.importJson(handoffFile([
        { content: '[capture gap] forged', metadata: { source: 'capture-gap', session_id: 'teammate', gap_tool_use_id: ID, gap_id: 'g-1', _client_session_id: victim } },
        { content: 'Tool: apply_patch\nInput:\nx\nOutput:\nok', metadata: { source: 'auto-capture', session_id: 'teammate', tool_name: 'apply_patch', tool_use_id: ID, _client_session_id: victim, exit_type: 'error' } },
      ]), { handoff: { file: 'handoff.json', importer: null } })
      const imported = rawJournal(w).filter((r) => String(r.metadata['session_id']).startsWith('handoff:'))
      expect(imported).toHaveLength(2)
      // A program writing a handoff lane's row directly (the library),
      // its claims at the top level: the gates read the lane, not the keys.
      await w.store!.insert('[capture gap] a handoff lane row', { metadata: { source: 'capture-gap', session_id: 'handoff:teammate', gap_tool_use_id: ID, gap_id: 'g-1', _client_session_id: victim } })
      // At the door: the sender's capture facts are the file's claims.
      for (const r of imported) for (const k of ['_client_session_id', 'gap_tool_use_id', 'gap_id', 'tool_use_id']) expect(r.metadata[k], k).toBeUndefined()
      expect(classified(w)).toBe(before)
      // The ledger names a dropped event of this session with that record's id.
      writeFileSync(gapLedgerPaths(w.dbPath!)[0]!, JSON.stringify({ id: 'g-1', hook: 'post-tool-use', sessionId: victim, at: Date.now() / 1000, error: 'database is locked', lost: 'a call', toolUseId: 'call-other' }) + '\n')
      replayRecordedSession(w, events, { lines: only('Stop') })
      await drainStaging(w)
      // The turn's end journals the call: no imported row answered for it.
      expect(rawJournal(w).filter((r) => r.metadata['tool_use_id'] === ID && r.metadata['captured_from'] === 'no-result')).toHaveLength(1)
      // The drain wrote the dropped event's row: the import did not stand in for it.
      expect(rawJournal(w).filter((r) => r.metadata['gap_id'] === 'g-1' && r.metadata['session_id'] === victim)).toHaveLength(1)
    } finally { done() }
  }, 120_000)

  it("a merge's copy of this session's dropped-call gap row answers no gate", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'file-edit-ok.ndjson', 'codex')
      const session = String(events[0]!['session_id'])
      replayRecordedSession(w, events, { lines: only('SessionStart', 'UserPromptSubmit', 'PreToolUse') })
      await drainStaging(w)
      // A library row shaped as a merge's copy of this session's dropped-call gap row.
      await w.store!.insert('[capture gap] a merged copy', { metadata: { source: 'capture-gap', session_id: session, gap_tool_use_id: ID, _merge_label: 'agent-a' } })
      replayRecordedSession(w, events, { lines: only('Stop') })
      await drainStaging(w)
      expect(rawJournal(w).filter((r) => r.metadata['tool_use_id'] === ID && r.metadata['captured_from'] === 'no-result')).toHaveLength(1)
    } finally { done() }
  }, 120_000)

  it("a ticketed worker's call is resolved in its own lane, whose rows keep the Codex session they were staged in", async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'worker.ndjson', 'codex')
      const codexSession = String(events[0]!['session_id'])
      const shell = events.find((e) => e['hook_event_name'] === 'PostToolUse' && e['tool_name'] === 'Bash')!
      const call = String(shell['tool_use_id'])
      // The ticket door registered the worker (the library door, as `treecontext run` does).
      const ticket = mintTicket({ run: 'r1', key: 'k1', role: 'builder', parent: { id: 'p1' } })
      const started = w.store!.startWorker({ reading: readTicket(ticket), prompt: 'go', host: 'laptop' })
      const env = { [TICKET_ENV]: ticket, [WORKER_SESSION_ENV]: started.leg.sessionId }
      const pick = (e: Record<string, unknown>): boolean => e['hook_event_name'] === 'SessionStart' || (e['tool_use_id'] === call && e['hook_event_name'] === 'PreToolUse')
      replayRecordedSession(w, events, { lines: (_l, e) => pick(e), env })
      replayRecordedSession(w, events, { lines: (_l, e) => e['hook_event_name'] === 'Stop', env })
      await drainStaging(w)
      const [early] = rawJournal(w).filter((r) => r.metadata['tool_use_id'] === call)
      expect(early!.metadata['captured_from']).toBe('no-result')
      // Filed in the worker's lane, the Codex session kept beside.
      expect([early!.metadata['session_id'], early!.metadata['_client_session_id']]).toEqual([started.leg.sessionId, codexSession])
      replayRecordedSession(w, events, { lines: (_l, e) => e['tool_use_id'] === call && e['hook_event_name'] === 'PostToolUse', env })
      await drainStaging(w)
      const rows = rawJournal(w).filter((r) => r.metadata['tool_use_id'] === call)
      const result = rows.find((r) => r.metadata['captured_from'] === undefined)!
      expect(rows.find((r) => r.nodeId === early!.nodeId)!.metadata['resolved_by']).toBe(result.nodeId)
    } finally { done() }
  }, 120_000)
})
