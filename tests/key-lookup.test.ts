/**
 * The key lookup's whole reply below the charter (D289, D296, D301, D312,
 * D320, D336, D337, D343, D344; unit 2 of the beta.3 build): the sizes of
 * the last {3}, an imported checkpoint's claim believed and flagged, the
 * flag's exact words and where the named checkpointer is read from, the
 * honest nothing, the "left no return" lines, the keyless count, the
 * summary stamp, and the agent's door through the query and insert tools.
 * Every storage claim is read back from the SQLite file through a separate
 * handle; every reply is the one the real door returned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import { registerSelf, registerSubagent, type GitSelf } from '../src/persistence/session-registry.js'
import { WORKER_AGENT_ID, legReturnStamp, registerSubagentLeg, retireLeg } from '../src/persistence/leg-registry.js'
import { KEY_LOOKUP_PARAM, LAST_SIZES_SHOWN, isKeylessLeg, keyLookupReply, type KeyLookupReply } from '../src/key-lookup.js'
import { charactersOf } from '../src/runs.js'
import { REPLY_CEILING_BYTES } from '../src/server/reply-ceiling.js'
import { parseToolResult } from './helpers/mcp-result.js'
import { type RunWorld, openRunWorld, hooksLeg, insertEchoed, subagentStartHook } from './journal/run-world.js'
import { drainStaging } from './journal/capture-harness.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-lookup-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'lookup.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: 1_000_000 })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
function meta(id: string): Record<string, unknown> {
  return JSON.parse(raw<{ m: string }>('SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
}
function row(id: string): Record<string, unknown> {
  return raw<Record<string, unknown>>('SELECT * FROM nodes WHERE node_id = ?', id)[0]!
}
function withRaw<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path())
  try { return fn(db) } finally { db.close() }
}

const ticket = (opts: { run?: string | null; key?: string | null; role?: string; checkpointer?: string | null; noKey?: boolean }) => ({
  parent: { id: 'p1' }, run: opts.run === undefined ? 'r1' : opts.run, key: opts.key === undefined ? 'k' : opts.key,
  role: opts.role ?? 'builder', checkpointer: opts.checkpointer === undefined ? (opts.role ?? 'builder') : opts.checkpointer,
  ...(opts.noKey ? { noKey: true } : {}),
})
const here = (pid = process.pid) => ({ pid, start: null, host: hostname() })

/** Checkpoints 1..n under r1/k by a declared role, each `100 + 10i` long
 *  and superseding the one before. */
async function seed(s: FlatStore, n: number, role = 'builder', key = 'k'): Promise<string[]> {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const head = `state ${i}: `
    const r = await s.writeCheckpoint(head + 'x'.repeat(100 + 10 * i - head.length), {
      run: 'r1', key, declared: { role }, at: 1_000 + i, ...(ids.length > 0 ? { supersedes: [ids.at(-1)!] } : {}),
    })
    ids.push(r.nodeId)
  }
  return ids
}

async function serve(s: FlatStore, opts: Parameters<typeof createServer>[1] = {}): Promise<{ c: Client; done: () => Promise<void> }> {
  const server = createServer(s, opts)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'lookup', version: '0' })
  await server.connect(st)
  await c.connect(ct)
  return { c, done: async () => { await c.close(); await server.close() } }
}

/** The charter's capture world (a real store, the real hooks, one MCP
 *  client for the session) for a plain test: its cleanups run at the end. */
async function inCaptureWorld(fn: (w: RunWorld) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = []
  const w = { defer: (f: () => unknown) => { cleanups.push(f) } } as unknown as RunWorld
  try {
    await openRunWorld(w)
    await fn(w)
  } finally {
    for (const f of cleanups.reverse()) await f()
  }
}

function rawIn(w: RunWorld, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(w.dbPath!, { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>> } finally { db.close() }
}
const rowIn = (w: RunWorld, id: string): { content: string; m: Record<string, unknown> } => {
  const r = rawIn(w, 'SELECT content, metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!
  return { content: String(r['content']), m: JSON.parse(String(r['m'])) as Record<string, unknown> }
}
const regIn = (w: RunWorld, session: string, agent: string): Record<string, unknown> =>
  rawIn(w, 'SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?', session, agent)[0]!

describe('characters are code points (D299, D344)', () => {
  it('counts a non-BMP character once, and the lookup\'s sizes use the same counter', async () => {
    expect(charactersOf('😀'.repeat(10))).toBe(10)
    expect('😀'.repeat(10).length).toBe(20)
    expect(charactersOf('a😀b')).toBe(3)
    expect(charactersOf('\ud800x')).toBe(2) // a lone surrogate is one
    expect(charactersOf('')).toBe(0)
    const s = await open()
    await s.writeCheckpoint('😀'.repeat(10), { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect([l.checkpoints[0]!.size, l.facts.lastSizes]).toEqual([10, [10]])
    // SQLite's length() of the stored text counts characters too.
    expect(raw<{ n: number }>("SELECT length(content) AS n FROM nodes WHERE json_extract(metadata_json, '$.key') = 'k'")[0]!.n).toBe(10)
  })
})

describe('the sizes of the last {3} (D344)', () => {
  it('a key with n checkpoints returns the sizes of the last min(n, 3), by number, newest last', async () => {
    expect(LAST_SIZES_SHOWN).toBe(3)
    for (const n of [0, 1, 2, 3, 4, 7]) {
      const s = await open()
      await seed(s, n, 'builder', `k${n}`)
      const l = s.lookupKey({ run: 'r1', key: `k${n}` })
      await s.close()
      const sizes = Array.from({ length: n }, (_, i) => 100 + 10 * (i + 1))
      expect(l.facts.lastSizes, `n=${n}`).toEqual(sizes.slice(Math.max(0, n - 3)))
      expect(l.facts.checkpointsUnderKey).toBe(n)
      // The file's own lengths, by the number the store gave each.
      const fromFile = raw<{ n: number; len: number }>(
        `SELECT json_extract(metadata_json, '$._checkpoint_number') AS n, length(content) AS len FROM nodes
          WHERE json_extract(metadata_json, '$.key') = ? ORDER BY n`, `k${n}`).map((r) => r.len)
      expect(fromFile).toEqual(sizes)
    }
  })

  it('sizes count every checkpoint under the key, superseded or not, and never another key\'s', async () => {
    const s = await open()
    await seed(s, 2)
    // Two in effect: a third naming nothing, by a declared writer.
    await s.writeCheckpoint('state 3: an independent review', { run: 'r1', key: 'k', declared: { role: 'reviewer' } })
    await seed(s, 5, 'builder', 'other')
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.checkpoints.map((c) => c.number)).toEqual([2, 3])
    expect(l.facts.lastSizes).toEqual([110, 120, 'state 3: an independent review'.length])
  })
})

describe('an imported checkpoint\'s claim (D343)', () => {
  it('is believed and flagged as arrived by import; the local checkpoint is untouched; the claim stays the file\'s', async () => {
    const s = await open()
    const [, two] = await seed(s, 2)
    const before = row(two!)
    const file = {
      nodes: [{
        nodeId: 'remote-cp-3', content: 'state 3: finished on build-02', createdAt: 2_000,
        metadata: { kind: 'checkpoint', run: 'r1', key: 'k', _checkpoint_number: 3, supersedes: [two], _writer: 'builder', session_id: 'remote-session' },
      }],
    }
    await s.importJson(JSON.stringify(file), { handoff: { file: 'handoffs/r1.json', importer: 'laptop' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.claimedNumber, c.imported])).toEqual([['remote-cp-3', null, 3, true]])
    expect(l.checkpoints[0]!.flag).toBe('Checkpoint number 3 as numbered there arrived by import from "handoffs/r1.json", written there by "builder"; '
      + 'the file claims it supersedes checkpoint number 2, and this lookup believes the claim.')
    expect(l.checkpoints[0]!.legReturn).toEqual({
      leg: null, summary: null,
      line: 'Checkpoint number 3 as numbered there arrived by import, so no leg registered in this store wrote it and there is no leg return to point to here.',
    })
    expect(l.facts.checkpointsUnderKey).toBe(3)
    // The file: number 2 byte for byte as it was; the import keeps the
    // claim under the file's claims, never as its own supersession.
    expect(row(two!)).toEqual(before)
    const m = meta('remote-cp-3')
    expect(m['supersedes']).toBeUndefined()
    // Its number is the file's claim, in no sequence of this store's (D360).
    expect(m['_checkpoint_number']).toBeUndefined()
    expect((m['_handoff_claims'] as Record<string, unknown>)['_checkpoint_number']).toBe(3)
    expect((m['_handoff_claims'] as Record<string, unknown>)['supersedes']).toEqual([two])
    expect(row('remote-cp-3')['session_key']).toBe('handoff:remote-session')
  })

  it('a claim naming no checkpoint of this key supersedes nothing here, and an import with no claim is flagged plainly', async () => {
    const s = await open()
    const [one] = await seed(s, 1)
    const [elsewhere] = await seed(s, 1, 'builder', 'other')
    await s.importJson(JSON.stringify({ nodes: [
      { nodeId: 'imp-a', content: 'state: a remote take', metadata: { kind: 'checkpoint', run: 'r1', key: 'k', _checkpoint_number: 2, supersedes: [elsewhere], session_id: 'rs' } },
      { nodeId: 'imp-b', content: 'state: another remote take', metadata: { kind: 'checkpoint', run: 'r1', key: 'k', _checkpoint_number: 3, session_id: 'rs' } },
    ] }), { handoff: { file: 'f.json', importer: null } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([one, 'imp-a', 'imp-b'])
    expect(l.checkpoints.map((c) => c.flag)).toEqual([
      null,
      `Checkpoint number 2 as numbered there arrived by import from "f.json"; the file claims it supersedes ${elsewhere}, and this lookup believes the claim.`,
      'Checkpoint number 3 as numbered there arrived by import from "f.json".',
    ])
  })
})

describe('the flag in words (D296)', () => {
  it('names the writer and the checkpointer the brief names, for every checkpoint in effect, and withholds nothing', async () => {
    const s = await open()
    await s.writeBrief('build k', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    await s.writeBrief('review k', { run: 'r1', key: 'k', role: 'reviewer', checkpointer: 'reviewer', by: 'harness' })
    await seed(s, 1)
    await s.writeCheckpoint('state: a stranger was here', { run: 'r1', key: 'k', declared: { role: 'intruder' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.namedCheckpointer).toEqual({ names: ['reviewer', 'builder'], by: 'brief' })
    expect(l.checkpoints.map((c) => [c.number, c.flag])).toEqual([
      [1, null],
      [2, 'The writer of checkpoint number 2, "intruder", is not the checkpointer the brief names ("reviewer" or "builder").'],
    ])
  })

  it('reads a superseded brief\'s checkpointer no more, and a closed run\'s brief still names who it named', async () => {
    const s = await open()
    const old = await s.writeBrief('build k', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    await s.writeBrief('build k; the reviewer checkpoints now', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'reviewer', by: 'harness', supersedes: [old.nodeId] })
    await seed(s, 1)
    await s.closeRun({ run: 'r1', by: 'harness', reason: 'done' })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.namedCheckpointer).toEqual({ names: ['reviewer'], by: 'brief' })
    expect(l.checkpoints[0]!.flag).toBe('The writer of checkpoint number 1, "builder", is not the checkpointer the brief names ("reviewer").')
  })

  it('falls back to the workers\' tickets when no brief names one, and flags nothing when nobody named one', async () => {
    const s = await open()
    await s.registerWorker({ sessionId: 'w1', door: 'library', ticket: ticket({ checkpointer: 'project-manager' }), process: here(), at: 10 })
    await seed(s, 1)
    const named = s.lookupKey({ run: 'r1', key: 'k' })
    await seed(s, 1, 'builder', 'unnamed-key')
    const nobody = s.lookupKey({ run: 'r1', key: 'unnamed-key' })
    await s.close()
    expect(named.namedCheckpointer).toEqual({ names: ['project-manager'], by: 'ticket' })
    expect(named.checkpoints[0]!.flag).toBe('The writer of checkpoint number 1, "builder", is not the checkpointer the ticket names ("project-manager").')
    expect(nobody.namedCheckpointer).toEqual({ names: [], by: null })
    expect(nobody.checkpoints[0]!.flag).toBeNull()
  })
})

describe('the brief\'s two tenses (D281, D296)', () => {
  it('a checkpoint by who the brief says checkpointed the work it resumes is not flagged; a stranger beside it still is', async () => {
    const s = await open()
    await s.writeBrief('build k from the technical writer\'s state', {
      run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', checkpointedBy: 'technical-writer', by: 'harness',
    })
    await s.writeCheckpoint('state: the docs outline the form', { run: 'r1', key: 'k', declared: { role: 'technical-writer' } })
    await s.writeCheckpoint('state: someone else\'s take', { run: 'r1', key: 'k', declared: { role: 'intruder' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.namedCheckpointer).toEqual({ names: ['builder', 'technical-writer'], by: 'brief' })
    expect(l.checkpoints.map((c) => [c.number, c.writer, c.flag])).toEqual([
      [1, 'technical-writer', null],
      [2, 'intruder', 'The writer of checkpoint number 2, "intruder", is not the checkpointer the brief names ("builder" or "technical-writer").'],
    ])
  })

  it('a ticket\'s checkpointed-by counts the same way when no brief names one', async () => {
    const s = await open()
    await s.registerWorker({ sessionId: 'w1', door: 'library', ticket: { ...ticket({ checkpointer: 'builder' }), checkpointedBy: 'technical-writer' }, process: here(), at: 10 })
    await s.writeCheckpoint('state: the docs outline the form', { run: 'r1', key: 'k', declared: { role: 'technical-writer' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.namedCheckpointer).toEqual({ names: ['builder', 'technical-writer'], by: 'ticket' })
    expect(l.checkpoints.map((c) => c.flag)).toEqual([null])
  })
})

describe('the honest nothing and the leg\'s return (D289, D336)', () => {
  it('a run the store holds nothing of: no checkpoint, the line saying so, no start and no age', async () => {
    const s = await open()
    const r = keyLookupReply(s.lookupKey({ run: 'nowhere', key: 'k' }))
    await s.close()
    expect(r).toMatchObject({
      run: 'nowhere', key: 'k', checkpoints: [], legs: [], line: 'No checkpoint is in effect under "k" on the run "nowhere".',
      facts: { legs_run: 0, keyless_legs: 0, checkpoints_under_key: 0, run_started_at: null, run_age_seconds: null, last_sizes: [] },
      named_checkpointer: { names: [], by: null },
    })
  })

  it('says a live leg left no return yet, an ended one that it left none, and a writer that is no leg that it has no leg return', async () => {
    const s = await open()
    const live = await s.registerWorker({ sessionId: 'w-live', door: 'library', ticket: ticket({ key: 'a' }), process: here(), at: 10 })
    await s.writeCheckpoint('state a', { run: 'r1', key: 'a', leg: { sessionId: live.sessionId, agentId: WORKER_AGENT_ID } })
    const gone = await s.registerWorker({ sessionId: 'w-gone', door: 'library', ticket: ticket({ key: 'b', role: 'reviewer' }), process: here(), at: 11 })
    await s.writeCheckpoint('state b', { run: 'r1', key: 'b', leg: { sessionId: gone.sessionId, agentId: WORKER_AGENT_ID } })
    expect(s.retireLeg({ sessionId: gone.sessionId, agentId: WORKER_AGENT_ID }, 'invalid')).toBe(true)
    await s.writeCheckpoint('state c', { run: 'r1', key: 'c', declared: { role: 'harness' } })
    const a = s.lookupKey({ run: 'r1', key: 'a' }).checkpoints[0]!.legReturn
    const b = s.lookupKey({ run: 'r1', key: 'b' }).checkpoints[0]!.legReturn
    const c = s.lookupKey({ run: 'r1', key: 'c' }).checkpoints[0]!.legReturn
    await s.close()
    expect([a.line, a.leg?.state]).toEqual(['The builder leg that wrote checkpoint number 1 left no return yet: it is live.', 'live'])
    expect([b.line, b.leg?.state]).toEqual(['The reviewer leg that wrote checkpoint number 1 left no return: it ended with no valid instructions, with no summary row.', 'invalid'])
    expect([c.line, c.leg]).toEqual(['Checkpoint number 1 was written by "harness", not by a registered leg, so there is no leg return to point to.', null])
  })
})

describe('keyless legs (D320, D326, D341)', () => {
  it('counts a worker declared keyless, and a leg whose key never became its own once it ended; never a live inferred one', async () => {
    expect(isKeylessLeg({ key: null, keySrc: 'declared', ended: null, stoppedAt: null })).toBe(true)
    expect(isKeylessLeg({ key: 'k', keySrc: 'declared', ended: 'retired', stoppedAt: 5 })).toBe(false)
    expect(isKeylessLeg({ key: 'k', keySrc: 'own', ended: 'retired', stoppedAt: 5 })).toBe(false)
    expect(isKeylessLeg({ key: 'k', keySrc: 'inferred', ended: null, stoppedAt: null })).toBe(false)
    expect(isKeylessLeg({ key: 'k', keySrc: 'inferred', ended: null, stoppedAt: 5 })).toBe(true)
    expect(isKeylessLeg({ key: null, keySrc: 'ambiguous', ended: 'cut', stoppedAt: 5 })).toBe(true)
    const s = await open()
    await s.registerWorker({ sessionId: 'one-off', door: 'library', ticket: ticket({ key: null, noKey: true }), process: here(), at: 1 })
    await s.close()
    withRaw((db) => {
      registerSelf(db, 's1', MAIN, 1)
      registerSubagent(db, 's1', 'a1', 'builder', MAIN, 2)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'a1', role: 'builder' }, { run: 'r1', key: 'k', keySrc: 'inferred' }, { at: 2 })
      registerSubagent(db, 's1', 'a2', 'builder', MAIN, 3)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'a2', role: 'builder' }, { run: 'r1', key: 'k', keySrc: 'inferred' }, { at: 3 })
      retireLeg(db, { sessionId: 's1', agentId: 'a2' }, 'retired', 4)
    })
    const s2 = await open()
    const l = s2.lookupKey({ run: 'r1', key: 'k' })
    await s2.close()
    expect(l.legs.map((g) => [g.sessionId, g.agentId, g.keyless])).toEqual([
      ['one-off', WORKER_AGENT_ID, true], ['s1', 'a1', false], ['s1', 'a2', true],
    ])
    expect(l.facts).toMatchObject({ legsRun: 3, keylessLegs: 2 })
  })

  it('the summary stamp carries the run, and the key only when it is the leg\'s own or declared', async () => {
    const s = await open()
    await s.close()
    withRaw((db) => {
      registerSelf(db, 's1', MAIN, 1)
      registerSubagent(db, 's1', 'plain', 'explorer', MAIN, 2)
      registerSubagent(db, 's1', 'inf', 'builder', MAIN, 2)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'inf', role: 'builder' }, { run: 'r1', key: 'k', keySrc: 'inferred' }, { at: 2 })
      registerSubagent(db, 's1', 'dec', 'builder', MAIN, 2)
      registerSubagentLeg(db, { sessionId: 's1', agentId: 'dec', role: 'builder' }, { run: 'r1', key: 'k' }, { at: 2 })
      expect(legReturnStamp(db, { sessionId: 's1', agentId: 'plain' })).toEqual({})
      expect(legReturnStamp(db, { sessionId: 's1', agentId: 'nobody' })).toEqual({})
      expect(legReturnStamp(db, { sessionId: 's1', agentId: 'inf' })).toEqual({ run: 'r1' })
      expect(legReturnStamp(db, { sessionId: 's1', agentId: 'dec' })).toEqual({ run: 'r1', key: 'k' })
    })
  })
})

describe('the agent\'s door (D337)', () => {
  it('the query tool\'s key_lookup returns the harness\'s reply; without it, a query is required', async () => {
    const s = await open()
    await s.writeBrief('build k', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    await seed(s, 2)
    const { c, done } = await serve(s)
    const agent = parseToolResult<KeyLookupReply>(await c.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run: 'r1', key: 'k' } } }))
    const bare = await c.callTool({ name: 'treecontext_query', arguments: {} })
    const both = await c.callTool({ name: 'treecontext_query', arguments: { query: 'login form', [KEY_LOOKUP_PARAM]: { run: 'r1', key: 'k' } } })
    const empty = await c.callTool({ name: 'treecontext_query', arguments: { query: '' } })
    await done()
    expect((both as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(both)).toContain(`query and ${KEY_LOOKUP_PARAM} were both given`)
    expect((empty as { isError?: boolean }).isError).toBe(true)
    const harness = keyLookupReply(s.lookupKey({ run: 'r1', key: 'k' }))
    await s.close()
    const unclocked = (r: KeyLookupReply): unknown => ({ ...r, facts: { ...r.facts, as_of: 0, run_age_seconds: 0 } })
    expect(unclocked(agent)).toEqual(unclocked(harness))
    expect(agent.checkpoints.map((x) => x.number)).toEqual([2])
    expect((bare as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(bare)).toContain(`query is required unless ${KEY_LOOKUP_PARAM} names a run and a key`)
  })

  it('a read-only server\'s lookup writes no registry: a gone worker stays live and the notes say why; the full server retires it', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = await new Promise<number>((resolve) => child.once('exit', () => resolve(child.pid!)))
    const s = await open()
    await s.registerWorker({ sessionId: 'gone', door: 'library', ticket: ticket({}), process: here(pid), at: 1 })
    const ro = await serve(s, { policy: 'read_only' })
    const read = parseToolResult<KeyLookupReply>(await ro.c.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run: 'r1', key: 'k' } } }))
    await ro.done()
    expect(raw<{ ended: string | null }>("SELECT ended FROM session_registry WHERE session_id = 'gone'")[0]!.ended).toBeNull()
    const full = await serve(s)
    const wrote = parseToolResult<KeyLookupReply>(await full.c.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run: 'r1', key: 'k' } } }))
    await full.done()
    await s.close()
    expect(read.legs.map((g) => g.state)).toEqual(['live'])
    expect(read.notes).toEqual(['This reader does not write the registry, so no gone worker was retired; a worker shown live may be gone.'])
    expect(wrote.legs.map((g) => g.state)).toEqual(['phantom'])
    expect(raw<{ ended: string; by: string }>("SELECT ended, noticed_by AS by FROM session_registry WHERE session_id = 'gone'")[0]).toEqual({ ended: 'phantom', by: 'lookup' })
  })

  it('kind run-open and run-close through the insert tool leave the harness\'s record, by the stamped writer, and the close ends the run\'s briefs', async () => {
    const s0 = await open()
    await s0.close()
    withRaw((db) => registerSelf(db, 's1', MAIN, 1))
    const s = await open()
    const brief = await s.writeBrief('build k', { run: 'r7', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    const { c, done } = await serve(s, { ccSessionId: 's1' })
    const insert = async (content: string, metadata: Record<string, unknown>) =>
      parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } }))
    const opened = await insert('opening r7 for the login work', { kind: 'run-open', run: 'r7', opened_by: 'someone-else', opened_via: 'registration' })
    const again = await insert('r7 again', { kind: 'run-open', run: 'r7' })
    expect(s.briefsInEffect('builder').map((b) => b.nodeId)).toEqual([brief.nodeId])
    const closed = await insert('all keys delivered', { kind: 'run-close', run: 'r7', closed_by: 'forger', _writer: 'forger' })
    const closedWithWhy = await insert('the reviewer found nothing left; closing', { kind: 'run-close', run: 'r8', reason: 'nothing left' })
    await done()
    expect(s.briefsInEffect('builder')).toEqual([])
    await s.close()
    expect(opened['run']).toEqual({ kind: 'run-open', run: 'r7', opened_by: 'main', opened: true })
    expect([again['node_id'], again['deduplicated'], (again['run'] as Record<string, unknown>)['opened']]).toEqual([opened['node_id'], true, false])
    expect(raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = 'r7'")).toHaveLength(1)
    // The file: the harness's record, by the stamped writer, the caller's
    // claims of who and how dropped, the caller's words kept after the line.
    const om = meta(opened['node_id'] as string)
    expect([om['kind'], om['run'], om['opened_by'], om['opened_via'], om['_writer'], om['_door'], om['_writer_src'], om['_by_src']])
      .toEqual(['run-open', 'r7', 'main', 'explicit', 'main', 'tools', 'self', undefined])
    expect(raw<{ c: string }>('SELECT content AS c FROM nodes WHERE node_id = ?', opened['node_id'])[0]!.c).toBe('run r7 opened by main\n\nopening r7 for the login work')
    const cm = meta(closed['node_id'] as string)
    expect([cm['kind'], cm['run'], cm['closed_by'], cm['reason'], cm['refs'], cm['_writer']]).toEqual(['run-close', 'r7', 'main', 'all keys delivered', [opened['node_id']], 'main'])
    expect(raw<{ c: string }>('SELECT content AS c FROM nodes WHERE node_id = ?', closed['node_id'])[0]!.c).toBe('run r7 closed by main: all keys delivered')
    const wm = meta(closedWithWhy['node_id'] as string)
    expect([wm['reason'], wm['closed_by'], wm['refs']]).toEqual(['nothing left', 'main', undefined])
    expect(raw<{ c: string }>('SELECT content AS c FROM nodes WHERE node_id = ?', closedWithWhy['node_id'])[0]!.c)
      .toBe('run r8 closed by main: nothing left\n\nthe reviewer found nothing left; closing')
  })

  it('with no writer stamp to read, a close records the caller\'s own word for who, marked by the tools door alone', async () => {
    const s = await open()
    const { c, done } = await serve(s)
    const r = parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: { content: 'done', metadata: { kind: 'run-close', run: 'r1', closed_by: 'codex-main', _by_src: 'store' } } }))
    await done()
    await s.close()
    expect(r['run']).toEqual({ kind: 'run-close', run: 'r1', closed_by: 'codex-main', reason: 'done', _by_src: 'caller' })
    const m = meta(r['node_id'] as string)
    expect([m['closed_by'], m['_by_src'], m['_writer'], m['_door'], m['_identity']]).toEqual(['codex-main', 'caller', undefined, 'tools', undefined])
    expect(raw<{ c: string }>('SELECT content AS c FROM nodes WHERE node_id = ?', r['node_id'])[0]!.c).toBe('run r1 closed by codex-main: done')
  })
})

describe('a run open or close through the tools under a writer the store could not tell (D283, D293, D302, D311)', () => {
  it('P1: one subagent live, the main agent closes the run: pending at insert, by "main" after the echo', async () => {
    await inCaptureWorld(async (w) => {
      await w.store!.openRun({ run: 'r1', by: 'harness' })
      subagentStartHook(w, 'areviewer1', 'reviewer')
      const reply = await insertEchoed(w, null, 'all keys delivered', { kind: 'run-close', run: 'r1' })
      const id = reply['node_id'] as string
      expect(reply['run']).toMatchObject({ kind: 'run-close', run: 'r1', closed_by: null, reason: 'all keys delivered', _by_src: 'pending' })
      // At insert: the row names nobody, whatever the stamp guessed.
      const before = rowIn(w, id)
      expect([before.m['_writer_src'], before.m['closed_by'], before.m['_by_src']]).toEqual(['provisional', undefined, 'pending'])
      expect(before.content).toBe('run r1 closed: all keys delivered')
      await drainStaging(w)
      const after = rowIn(w, id)
      expect([after.m['_writer'], after.m['_writer_src'], after.m['closed_by'], after.m['_by_src'], after.m['reason']])
        .toEqual(['main', 'echo', 'main', 'echo', 'all keys delivered'])
      expect(after.content).toBe('run r1 closed by main: all keys delivered')
      // The line is searchable as healed: the FTS entry moved with it.
      const hits = await w.store!.query('closed by main', { topK: 5 })
      expect(hits.map((h) => h.nodeId)).toContain(id)
    })
  })

  it('P2: the main agent opens an inner run while a leg is live: no parent leg, nothing on the leg, by "main" after the echo', async () => {
    await inCaptureWorld(async (w) => {
      const reviewer = await hooksLeg(w, 'reviewer', 'reviewer', { run: 'r1', key: 'login-form' })
      const reply = await insertEchoed(w, null, 'opening the inner run', { kind: 'run-open', run: 'r1.inner', parent_run: 'r1' })
      const id = reply['node_id'] as string
      const before = rowIn(w, id)
      expect([before.m['opened_by'], before.m['parent_leg'], before.m['parent_run'], before.m['_by_src']]).toEqual([undefined, undefined, 'r1', 'pending'])
      expect(before.content).toBe('run r1.inner opened, inside the run r1\n\nopening the inner run')
      expect(regIn(w, reviewer.sessionId, reviewer.agentId)['opened_runs']).toBeNull()
      await drainStaging(w)
      const after = rowIn(w, id)
      expect([after.m['_writer'], after.m['opened_by'], after.m['parent_leg'], after.m['_by_src']]).toEqual(['main', 'main', undefined, 'echo'])
      expect(after.content).toBe('run r1.inner opened by main, inside the run r1\n\nopening the inner run')
      expect(regIn(w, reviewer.sessionId, reviewer.agentId)['opened_runs']).toBeNull()
    })
  })

  it('the leg itself opens an inner run while two subagents are live: its echo names it, the parent leg and its registration', async () => {
    await inCaptureWorld(async (w) => {
      const reviewer = await hooksLeg(w, 'reviewer', 'reviewer', { run: 'r1', key: 'login-form' })
      subagentStartHook(w, 'abuilder2', 'builder')
      const reply = await insertEchoed(w, { agentId: reviewer.agentId, agentType: 'reviewer' }, 'two fixes, two workers', { kind: 'run-open', run: 'r1.review', parent_run: 'r1' })
      const id = reply['node_id'] as string
      expect(rowIn(w, id).m['_writer_src']).toBe('ambiguous')
      expect(rowIn(w, id).m['_by_src']).toBe('pending')
      await drainStaging(w)
      const after = rowIn(w, id)
      expect([after.m['_writer'], after.m['opened_by'], after.m['_by_src']]).toEqual(['reviewer', 'reviewer', 'echo'])
      expect(after.m['parent_leg']).toEqual({ session_id: reviewer.sessionId, agent_id: reviewer.agentId, role: 'reviewer' })
      expect(after.content).toBe('run r1.review opened by reviewer, inside the run r1 by its reviewer leg\n\ntwo fixes, two workers')
      expect(JSON.parse(String(regIn(w, reviewer.sessionId, reviewer.agentId)['opened_runs']))).toEqual(['r1.review'])
      expect(regIn(w, reviewer.sessionId, 'abuilder2')['opened_runs']).toBeNull()
    })
  })

  it('an exact stamp writes who at insert, as before: the main agent with no subagent live', async () => {
    await inCaptureWorld(async (w) => {
      await w.store!.openRun({ run: 'r1', by: 'harness' })
      const reply = await insertEchoed(w, null, 'done', { kind: 'run-close', run: 'r1', reason: 'all keys delivered' })
      const id = reply['node_id'] as string
      const before = rowIn(w, id)
      expect([before.m['_writer_src'], before.m['closed_by'], before.m['_by_src']]).toEqual(['self', 'main', undefined])
      expect(before.content).toBe('run r1 closed by main: all keys delivered\n\ndone')
      await drainStaging(w)
      const after = rowIn(w, id)
      expect([after.m['_writer'], after.m['closed_by'], after.m['_by_src']]).toEqual(['main', 'main', undefined])
      expect(after.content).toBe(before.content)
    })
  })
})

describe('the key lookup under the reply ceiling (D287)', () => {
  it('two 3 MB checkpoints in effect come back cut to fit, the note naming what was cut', async () => {
    const s = await open()
    const big = (c: string): string => `state: ${c}; ` + c.repeat(3 * 1024 * 1024)
    // Past the checkpoint cap (D299) a writer no hook registered is never
    // refused (D359): both checkpoints land at once, marked.
    const one = await s.writeCheckpoint(big('a'), { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const two = await s.writeCheckpoint(big('b'), { run: 'r1', key: 'k', declared: { role: 'reviewer' } })
    const { c, done } = await serve(s)
    const res = await c.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run: 'r1', key: 'k' } } })
    await done()
    await s.close()
    const text = (res as { content: Array<{ text: string }> }).content[0]!.text
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(REPLY_CEILING_BYTES)
    const reply = JSON.parse(text) as KeyLookupReply & { _reply_ceiling: Record<string, unknown> }
    expect(reply._reply_ceiling).toEqual({ ceiling_bytes: REPLY_CEILING_BYTES, cut_at: 65_536, cut_entries: 2, cut_ids: [one.nodeId, two.nodeId] })
    for (const cp of reply.checkpoints) {
      expect(cp.content).toMatch(new RegExp(`…\\[cut to fit the reply ceiling; full content ${cp.size} chars via treecontext_export\\]$`))
      expect(cp.size).toBe(3 * 1024 * 1024 + 'state: a; '.length)
    }
    // The rows are whole in the file.
    expect(raw<{ id: string }>("SELECT node_id AS id FROM nodes WHERE json_extract(metadata_json, '$.key') = 'k' ORDER BY rowid").map((r) => r.id)).toEqual([one.nodeId, two.nodeId])
  }, 60_000)
})
