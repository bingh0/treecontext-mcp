/**
 * Antigravity CLI's named hook under a locked store and with no turn end
 * (D415, D314, D421; unit 11's fix round). Every event is agy's own,
 * recorded on 2026-11-09 (tests/fixtures/agy-hooks), replayed through the
 * commands install writes for agy, and read back from the store file.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { recordedSession, replayRecordedSession, agyEventOf } from '../journal/standins.js'
import { openCaptureWorld, adoptCaptureStore, drainStaging, rawJournal, type CaptureWorld } from '../journal/capture-harness.js'
import { TS_ROOT } from '../journal/proc.js'
import { gapLedgerPaths, recordHookGap } from '../../src/hooks/gap-ledger.js'
import { mintTicket, readTicket } from '../../src/ticket.js'
import { WORKER_AGENT_ID, linkClientSession } from '../../src/persistence/leg-registry.js'
import { hostname } from 'node:os'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { AGY_HOOK_BUDGET_MS } from '../../src/hooks/agy.js'
import { AGY_NO_END_LINE, AGY_CALL_MARK } from '../../src/persistence/capture-marks.js'

const V = '1.5.3'
const cleanups: Array<() => void> = []
const done = (): void => { while (cleanups.length) { try { cleanups.pop()!() } catch { /* gone */ } } }
const world = async (): Promise<CaptureWorld> => {
  const w = { defer: (fn: () => void) => { cleanups.push(fn) } } as unknown as CaptureWorld
  await openCaptureWorld(w)
  return w
}
/** Another process holding the store under SQLite's exclusive lock. */
const lock = async (w: CaptureWorld): Promise<ChildProcess> => {
  const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', 'store-locker.cjs'), w.dbPath!], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanups.push(() => { try { locker.kill('SIGKILL') } catch { /* gone */ } })
  let seen = ''
  await new Promise<void>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error(`the locker never locked: ${seen}`)), 20_000)
    locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
  })
  return locker
}
const unlock = async (locker: ChildProcess): Promise<void> => {
  locker.kill('SIGKILL')
  await new Promise<void>((r) => { if (locker.exitCode !== null || locker.signalCode !== null) r(); else locker.once('exit', () => r()) })
}
const ledger = (w: CaptureWorld): Array<Record<string, unknown>> => gapLedgerPaths(w.dbPath!).filter(existsSync)
  .flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>))

describe('agy\'s hook under a store another process holds locked', () => {
  it('keeps every hook inside one budget, ledgers what it could not write, and files the gap rows as writer unknown', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'agy')
      const conv = String(events[0]!['conversationId'])
      // The turn's start, its first two calls, a model call's end and the
      // turn's end, each fired while the store is locked.
      let posts = 0
      const picked = new Set(events.filter((e) => {
        const ev = agyEventOf(e)
        if (ev === 'PostToolUse') return ++posts <= 2
        return ev === 'SessionStart' || ev === 'Stop' || (ev === 'PreInvocation' && e['invocationNum'] === 0) || (ev === 'PostInvocation' && e['invocationNum'] === 0)
      }))
      // The world's own connection let go, so another process can hold the lock.
      await w.store!.close()
      const locker = await lock(w)
      const replayed = replayRecordedSession(w, events, { lines: (_l, e) => picked.has(e) })
      await unlock(locker)
      await adoptCaptureStore(w)
      expect(replayed.map((r) => r.event)).toEqual(['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'PostToolUse', 'Stop'])
      console.info('agy hook wall times under the lock (ms):', replayed.map((r) => `${r.event} ${Math.round((r.endedAt - r.startedAt) * 1000)}`).join(', '))
      for (const r of replayed) {
        // The hook's own wall time: its one budget and a process start,
        // well inside the 10 s install writes on each handler.
        expect((r.endedAt - r.startedAt) * 1000, `${r.event}`).toBeLessThan(AGY_HOOK_BUDGET_MS + 2500)
        expect(r.stdout.join('').trim()).toBe('{}')
      }
      // What could not be written is in the ledger, naming agy: the prompt,
      // each call (with its text) and the reply.
      const gaps = ledger(w)
      expect(gaps.map((g) => g['hook'])).toEqual(['user-prompt-submit', 'post-tool-use', 'post-tool-use', 'stop'])
      for (const g of gaps) { expect(g['client']).toBe('agy'); expect(g['sessionId']).toBe(conv) }
      expect(String(gaps[1]!['text'])).toContain('head -c 13 package.json')
      expect(String(gaps[3]!['lost'])).toMatch(/The reply of this agy turn was not captured/)
      // The drain files them as that conversation's, writer unknown.
      await drainStaging(w)
      const rows = rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap')
      expect(rows).toHaveLength(4)
      for (const r of rows) expect([r.metadata['session_id'], r.metadata['_writer_src']]).toEqual([conv, 'unregistered'])
      // A main-lane search finds none of them; the whole store finds them.
      const all = await w.store!.query('head -c 13 package.json', { topK: 20 })
      expect(all.map((h) => h.nodeId)).toEqual(expect.arrayContaining(rows.filter((r) => r.content.includes('head -c 13 package.json')).map((r) => r.nodeId)))
      const main = await w.store!.query('head -c 13 package.json', { topK: 20, lane: 'main' })
      expect(main.filter((h) => rows.some((r) => r.nodeId === h.nodeId))).toEqual([])
    } finally { done() }
  }, 120_000)
})

describe('agy calls no event of their turn settled', () => {
  it('are journaled by the purge, one entry per call, at the call\'s moment, saying its output and its turn\'s end never reached the journal', async () => {
    const w = await world()
    try {
      const events = recordedSession(V, 'headless-session.ndjson', 'agy')
      const conv = String(events[0]!['conversationId'])
      // The worker was killed mid-turn: no PostInvocation and no Stop fired.
      const replayed = replayRecordedSession(w, events, { lines: (_l, e) => agyEventOf(e) !== 'PostInvocation' && agyEventOf(e) !== 'Stop' })
      const calls = replayed.filter((r) => r.event === 'PostToolUse')
      expect(calls).toHaveLength(6)
      await drainStaging(w)
      // Held as accounts, never entries, until the purge.
      expect(rawJournal(w).filter((r) => typeof r.metadata['tool_name'] === 'string')).toEqual([])
      const db = new DatabaseSync(w.dbPath!)
      try {
        expect((db.prepare('SELECT COUNT(*) AS n FROM staging WHERE captured_from = ?').get(AGY_CALL_MARK) as { n: number }).n).toBe(6)
        db.prepare('UPDATE staging SET timestamp = timestamp - 2 * 86400').run()
      } finally { db.close() }
      await new IngestionLoop(w.store!, { batchSize: 50, storePath: w.dbPath! }).runSweep()
      await drainStaging(w)
      const entries = rawJournal(w).filter((r) => typeof r.metadata['tool_name'] === 'string')
      expect(entries).toHaveLength(6)
      calls.forEach((c, i) => {
        const name = (c.payload['toolCall'] as { name: string }).name
        const e = entries.filter((x) => x.metadata['tool_name'] === name)[calls.slice(0, i).filter((p) => (p.payload['toolCall'] as { name: string }).name === name).length]!
        expect(e.content.endsWith(`\n${AGY_NO_END_LINE}`)).toBe(true)
        // At the call's moment (staging aged two days, so two days before it).
        const at = e.metadata['created_at'] as number
        expect(at).toBeGreaterThanOrEqual(c.startedAt - 2 * 86400)
        expect(at).toBeLessThanOrEqual(c.endedAt - 2 * 86400)
        expect(e.metadata['tool_use_id']).toBeUndefined()
        expect([e.metadata['session_id'], e.metadata['_writer_src']]).toEqual([conv, 'unregistered'])
      })
    } finally { done() }
  }, 120_000)
})

describe("a worker's dropped event, whatever its client", () => {
  it('is filed in the worker\'s lane with its role as writer, never left in the client\'s own session to be read as main\'s', async () => {
    const w = await world()
    try {
      // A worker the ticket door registered, its client's own session
      // (a `claude -p` child's, a `codex exec`'s) linked to its lane, and
      // one event of that session a hook could not write: the gap record
      // names no client, as Claude Code's and Codex's hooks write it.
      const started = w.store!.startWorker({ reading: readTicket(mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } })), prompt: 'go', sessionId: 'worker-gap', host: hostname() })
      const raw = new DatabaseSync(w.dbPath!)
      try { expect(linkClientSession(raw as never, { sessionId: started.leg.sessionId, agentId: WORKER_AGENT_ID }, 'client-session-1')).toBe(true) } finally { raw.close() }
      expect(recordHookGap(w.dbPath!, { id: 'gap-worker-1', hook: 'post-tool-use', sessionId: 'client-session-1', at: Date.now() / 1000 - 5, error: 'database is locked', lost: 'a tool call of the worker', text: 'zebra-gap-needle' })).toBe(true)
      await new Promise((r) => setTimeout(r, 1200))
      await drainStaging(w)
      const rows = rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap')
      expect(rows).toHaveLength(1)
      expect([rows[0]!.metadata['session_id'], rows[0]!.metadata['_writer'], rows[0]!.metadata['_writer_src'], rows[0]!.metadata['_client_session_id']])
        .toEqual(['worker-gap', 'builder', 'declared', 'client-session-1'])
      const main = await w.store!.query('zebra-gap-needle', { topK: 20, lane: 'main' })
      expect(main.filter((h) => h.nodeId === rows[0]!.nodeId)).toEqual([])
    } finally { done() }
  }, 60_000)
})

