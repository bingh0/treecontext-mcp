/**
 * The checkpoint cap below the charter (D299, D321, D332, D359; unit 5 of
 * the beta.3 build): the verdict table for a writer the store names exactly,
 * the code-point count, the refusal per leg and key, a writer with no
 * registration never refused, a refusal made under a stamp that is not
 * exact (pending, with its candidates, moved to its writer by the call's
 * echo, never accepted on a guess), the insert tool's reply and its content
 * bound, the send-back's words, the imported mark as a claim, and the
 * first-moment line. Every claim is read back from the SQLite file through
 * a separate handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import { registerSelf, registerSubagent, retireAllSubagents, WRITER_STAMP_KEYS, type GitSelf } from '../src/persistence/session-registry.js'
import { registerSubagentLeg, legOf, legOwnsKey, capRefusalOf, type LegRef, type CapRefusal } from '../src/persistence/leg-registry.js'
import { resolveStagedCapRefusals } from '../src/persistence/cap-refusals.js'
import { CHECKPOINT_CAP_CHARS, OVER_CAP_KEY, charactersOf, checkpointCapRefusal } from '../src/runs.js'
import { composeFirstMessage, composeSendBackMessage, firstMomentMetadata, sendBackReason, overCapWords, STATE_NOT_HISTORY_LINE } from '../src/first-moment.js'
import { keyLookupReply } from '../src/key-lookup.js'
import { sendBackDecision } from '../src/ticket-door.js'
import { owesSendBack } from '../src/hooks/subagent-stop.js'
import { parseToolResult } from './helpers/mcp-result.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-cap-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'cap.db')
const open = (interval = 1_000_000): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: interval })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
const meta = (id: string): Record<string, unknown> =>
  JSON.parse(raw<{ m: string }>('SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
const checkpointRows = (): number =>
  raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'").length
const registration = (session: string, agent: string): Record<string, unknown> =>
  raw<Record<string, unknown>>('SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?', session, agent)[0]!
const refusedOf = (session: string, agent: string): CapRefusal[] => {
  const t = registration(session, agent)['cap_refused']
  return typeof t === 'string' ? JSON.parse(t) as CapRefusal[] : []
}
const text = (n: number, tag = 'A'): string => `${tag}${'x'.repeat(Math.max(0, n - 1))}`.slice(0, n)
const regLeg = (ref: LegRef): ReturnType<typeof legOf> => {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return legOf(db as never, ref) } finally { db.close() }
}

async function withLegs(roles: string[] = ['builder'], opts: { session?: string } = {}): Promise<{ s: FlatStore; legs: Record<string, LegRef> }> {
  const s = await open()
  const legs: Record<string, LegRef> = {}
  for (const role of roles) legs[role] = addLeg(opts.session ?? 's1', role, 200 + Object.keys(legs).length)
  return { s, legs }
}

/** A session's self and a subagent leg of the run under the key, registered
 *  as the hooks register them. */
function addLeg(session: string, role: string, at: number, key = 'login-form'): LegRef {
  const db = new DatabaseSync(path())
  try {
    registerSelf(db, session, MAIN, 100)
    const agentId = `a-${role}`
    registerSubagent(db, session, agentId, role, MAIN, at)
    registerSubagentLeg(db, { sessionId: session, agentId, role }, { run: 'r1', key, keySrc: 'inferred', checkpointer: role }, { at })
    return { sessionId: session, agentId }
  } finally { db.close() }
}

/** The MCP connection of a session, the insert tool's door. */
async function connect(s: FlatStore, session = 's1'): Promise<{ c: Client; close: () => Promise<void> }> {
  const server = createServer(s, { ccSessionId: session })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'cap', version: '0' })
  await server.connect(st)
  await c.connect(ct)
  return { c, close: async () => { await c.close(); await server.close() } }
}

type Reply = Record<string, unknown>
async function put(c: Client, content: string, metadata: Record<string, unknown> = { kind: 'checkpoint', run: 'r1', key: 'login-form' }): Promise<{ r: Reply; raw: unknown }> {
  const res = await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } })
  return { r: parseToolResult(res), raw: res }
}

/** The call's PostToolUse echo, staged as the hook stages it: the caller's
 *  agent fields (none for the session's own agent), the call's input and
 *  the platform's serialization of its reply. */
function stageEcho(s: FlatStore, session: string, agent: { agentId: string; agentType: string } | null, replyText: string): void {
  s.store.insertStaging({
    sessionId: session, role: 'assistant', toolName: 'mcp__treecontext__treecontext_insert', timestamp: Date.now() / 1000,
    content: `Tool: mcp__treecontext__treecontext_insert\nInput:\n{}\nOutput:\n${replyText}`,
    ...(agent ? { agentId: agent.agentId, agentType: agent.agentType } : {}),
  })
}
const replyText = (r: Reply): string => JSON.stringify(r)

/** What the drain does with a staged refusal echo (ingestion.ts). */
function drainEcho(s: FlatStore, session: string, agentId: string | null, r: Reply) {
  return s.store.healCapRefusalFromEcho({ echoSessionId: session, refusalId: String(r['refusal_id']), agentId })
}

/** The session's own agent has been seen by a hook after the oldest live
 *  subagent started: the stamp reads `concurrent`. */
function mainIsActive(s: FlatStore, session = 's1'): void {
  s.store.insertStaging({ sessionId: session, role: 'user', content: 'keep going', timestamp: 5_000_000_000 })
}

describe('the cap\'s verdict table for a writer the store names exactly (D299, D321)', () => {
  const cases: Array<{ chars: number; first: 'accepted' | 'refused'; second: 'accepted' | 'marked' }> = [
    { chars: 1, first: 'accepted', second: 'accepted' },
    { chars: CHECKPOINT_CAP_CHARS - 1, first: 'accepted', second: 'accepted' },
    { chars: CHECKPOINT_CAP_CHARS, first: 'accepted', second: 'accepted' },
    { chars: CHECKPOINT_CAP_CHARS + 1, first: 'refused', second: 'marked' },
    { chars: 300_000, first: 'refused', second: 'marked' },
  ]
  for (const c of cases) {
    it(`${c.chars} characters twice by one leg: ${c.first}, then ${c.second}`, async () => {
      const { s, legs } = await withLegs()
      const a = await s.writeCheckpoint(text(c.chars, 'A'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
      const afterFirst = checkpointRows()
      const b = await s.writeCheckpoint(text(c.chars, 'B'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
      await s.close()
      if (c.first === 'refused') {
        expect(a.refused).toMatchObject({ run: 'r1', key: 'login-form', size: c.chars, cap: CHECKPOINT_CAP_CHARS })
        expect(a.refused!.pending).toBeUndefined()
        expect(a.nodeId).toBe('')
        expect(afterFirst).toBe(0)
        expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ run: 'r1', key: 'login-form', size: c.chars, src: 'exact', id: a.refused!.id })])
      } else {
        expect(a.refused).toBeUndefined()
        expect(afterFirst).toBe(1)
        expect(meta(a.nodeId)[OVER_CAP_KEY]).toBeUndefined()
        expect(refusedOf('s1', 'a-builder')).toEqual([])
      }
      expect(b.refused).toBeUndefined()
      expect(checkpointRows()).toBe(c.first === 'refused' ? 1 : 2)
      expect(meta(b.nodeId)['_checkpoint_number']).toBe(c.first === 'refused' ? 1 : 2)
      if (c.second === 'marked') {
        expect(meta(b.nodeId)[OVER_CAP_KEY]).toEqual({ size: c.chars, cap: CHECKPOINT_CAP_CHARS, second: true })
        expect(b.checkpoint?.overCap).toEqual({ size: c.chars, cap: CHECKPOINT_CAP_CHARS, second: true })
      } else {
        expect(meta(b.nodeId)[OVER_CAP_KEY]).toBeUndefined()
      }
    })
  }

  it('a third over-cap write by the leg under the key is accepted and marked too: the nudge was given once', async () => {
    const { s, legs } = await withLegs()
    const n = CHECKPOINT_CAP_CHARS + 5
    const writes = [] as Awaited<ReturnType<FlatStore['writeCheckpoint']>>[]
    for (const tag of ['A', 'B', 'C']) writes.push(await s.writeCheckpoint(text(n, tag), { run: 'r1', key: 'login-form', leg: legs['builder']! }))
    await s.close()
    expect(writes.map((w) => w.refused !== undefined)).toEqual([true, false, false])
    expect(raw<{ m: string }>("SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")
      .map((r) => (JSON.parse(r.m) as Record<string, unknown>)[OVER_CAP_KEY])).toEqual([{ size: n, cap: CHECKPOINT_CAP_CHARS, second: true }, { size: n, cap: CHECKPOINT_CAP_CHARS, second: true }])
  })
})

describe('size is counted in code points (D299, D344)', () => {
  it('16000 emoji are 16000 characters: at the cap, accepted; 16001 are over it', async () => {
    const { s, legs } = await withLegs()
    const atCap = '😀'.repeat(CHECKPOINT_CAP_CHARS)
    expect(atCap.length).toBe(CHECKPOINT_CAP_CHARS * 2)
    expect(charactersOf(atCap)).toBe(CHECKPOINT_CAP_CHARS)
    const a = await s.writeCheckpoint(atCap, { run: 'r1', key: 'k-emoji', leg: legs['builder']! })
    const over = await s.writeCheckpoint('😀'.repeat(CHECKPOINT_CAP_CHARS + 1), { run: 'r1', key: 'k-emoji', leg: legs['builder']! })
    await s.close()
    expect(a.refused).toBeUndefined()
    expect(meta(a.nodeId)[OVER_CAP_KEY]).toBeUndefined()
    expect(over.refused).toMatchObject({ size: CHECKPOINT_CAP_CHARS + 1, cap: CHECKPOINT_CAP_CHARS })
  })
})

describe('the refusal is per leg and per key (D299)', () => {
  it('another leg\'s first over-cap write under the key is refused; the same leg under another key or run is refused; the same leg and key is accepted', async () => {
    const { s, legs } = await withLegs(['builder', 'reviewer'])
    const n = 20_000
    const b1 = await s.writeCheckpoint(text(n, 'A'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    const r1 = await s.writeCheckpoint(text(n, 'B'), { run: 'r1', key: 'login-form', leg: legs['reviewer']! })
    const b2 = await s.writeCheckpoint(text(n, 'C'), { run: 'r1', key: 'search-box', leg: legs['builder']! })
    const rr = await s.writeCheckpoint(text(n, 'D'), { run: 'r2', key: 'login-form', leg: legs['builder']! })
    expect([b1.refused, r1.refused, b2.refused, rr.refused].map((x) => x !== undefined)).toEqual([true, true, true, true])
    expect(checkpointRows()).toBe(0)
    expect(refusedOf('s1', 'a-builder').map((e) => `${e.run}/${e.key}`)).toEqual(['r1/login-form', 'r1/search-box', 'r2/login-form'])
    expect(refusedOf('s1', 'a-reviewer').map((e) => `${e.run}/${e.key}`)).toEqual(['r1/login-form'])
    const again = await s.writeCheckpoint(text(n, 'E'), { run: 'r1', key: 'search-box', leg: legs['builder']! })
    await s.close()
    expect(again.refused).toBeUndefined()
    expect(meta(again.nodeId)[OVER_CAP_KEY]).toEqual({ size: n, cap: CHECKPOINT_CAP_CHARS, second: true })
  })

  it('a note that only says kind checkpoint, with no run and key, is no checkpoint and is never capped', async () => {
    const s = await open()
    const r = await s.insert(text(CHECKPOINT_CAP_CHARS + 10), { metadata: { kind: 'checkpoint' } })
    await s.close()
    expect(r.refused).toBeUndefined()
    expect(r.nodeId).not.toBe('')
  })
})

describe('a writer with no registration is never refused (D359)', () => {
  it('two unhooked sessions each write 20000 once through the tool: both accepted and marked, no refusal anywhere', async () => {
    const s = await open()
    const one = await connect(s, 'unhooked-1')
    const two = await connect(s, 'unhooked-2')
    const a = await put(one.c, text(20_000, 'A'))
    const b = await put(two.c, text(20_000, 'B'), { kind: 'checkpoint', run: 'r1', key: 'login-form' })
    await one.close(); await two.close(); await s.close()
    for (const x of [a, b]) {
      expect((x.raw as { isError?: boolean }).isError).toBeFalsy()
      expect(x.r['refused']).toBeUndefined()
      expect(x.r['checkpoint']).toMatchObject({ over_cap: { size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: false } })
      expect(String((x.r['checkpoint'] as Reply)['over_cap_note'])).toContain('without a refusal')
      expect(meta(x.r['node_id'] as string)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: false })
    }
    expect(checkpointRows()).toBe(2)
    expect(raw('SELECT 1 FROM session_registry')).toHaveLength(0)
    expect(raw("SELECT 1 FROM store_config WHERE key LIKE 'cap_refused%'")).toHaveLength(0)
  })

  it('a library writer naming only its role is never refused either, and the store keeps no ledger', async () => {
    const s = await open()
    const a = await s.writeCheckpoint(text(17_000, 'A'), { run: 'r1', key: 'k', declared: { role: 'harness' } })
    await s.close()
    expect(a.refused).toBeUndefined()
    expect(meta(a.nodeId)[OVER_CAP_KEY]).toEqual({ size: 17_000, cap: CHECKPOINT_CAP_CHARS, second: false })
    expect(raw("SELECT 1 FROM store_config WHERE key LIKE 'cap_refused%'")).toHaveLength(0)
  })

  it('the marked first-message line says it was written without a refusal, never "on its second write"', () => {
    expect(overCapWords({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: false })).toBe('written over the 16000-character cap by a writer the store keeps no refusal for')
    expect(overCapWords({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true })).toBe('accepted over the 16000-character cap on its second write')
  })
})

describe('the mark is the store\'s alone (D321)', () => {
  it('a caller\'s over_cap copy is dropped by the library, and by the tool', async () => {
    const s = await open()
    const forged = await s.insert('state: small', { metadata: { kind: 'checkpoint', run: 'r1', key: 'k', [OVER_CAP_KEY]: { size: 99999, cap: 1 } } })
    expect(meta(forged.nodeId)[OVER_CAP_KEY]).toBeUndefined()
    const { c, close } = await connect(s)
    const { r } = await put(c, 'state: small, through the tool', { kind: 'checkpoint', run: 'r1', key: 'k', [OVER_CAP_KEY]: { size: 99999, cap: 1 } })
    await close(); await s.close()
    expect(meta(r['node_id'] as string)[OVER_CAP_KEY]).toBeUndefined()
    expect((r['checkpoint'] as Reply)['over_cap']).toBeUndefined()
    expect(WRITER_STAMP_KEYS).toContain(OVER_CAP_KEY)
  })
})

describe('the insert tool\'s content bound (D359)', () => {
  it('60000 characters as a checkpoint under a run\'s key reach the cap\'s reply; as a note, the validation error', async () => {
    const { s } = await withLegs()
    const { c, close } = await connect(s)
    const cp = await put(c, text(60_000), { kind: 'checkpoint', run: 'r1', key: 'login-form' })
    const note = await c.callTool({ name: 'treecontext_insert', arguments: { content: text(60_000), metadata: { kind: 'note' } } }).catch((e: unknown) => e)
    const bare = await c.callTool({ name: 'treecontext_insert', arguments: { content: text(60_000), metadata: { kind: 'checkpoint' } } }).catch((e: unknown) => e)
    await close(); await s.close()
    expect((cp.raw as { isError?: boolean }).isError).toBeFalsy()
    expect(cp.r).toMatchObject({ refused: true, kind: 'checkpoint-over-cap', size: 60_000, cap: CHECKPOINT_CAP_CHARS })
    for (const bad of [note, bare]) {
      expect(bad instanceof Error || (bad as { isError?: boolean }).isError === true).toBe(true)
      expect(JSON.stringify(bad)).toContain('50000')
    }
    expect(raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') IN ('note')")).toHaveLength(0)
  })

  it('300000 characters as a checkpoint through the tool: refused once, accepted and marked on the second', async () => {
    const { s } = await withLegs()
    const { c, close } = await connect(s)
    const one = await put(c, text(300_000, 'A'))
    stageEcho(s, 's1', { agentId: 'a-builder', agentType: 'builder' }, replyText(one.r))
    const two = await put(c, text(300_000, 'B'))
    await close(); await s.close()
    expect(one.r['refused']).toBe(true)
    expect(two.r['refused']).toBeUndefined()
    expect(meta(two.r['node_id'] as string)[OVER_CAP_KEY]).toEqual({ size: 300_000, cap: CHECKPOINT_CAP_CHARS, second: true })
    expect(raw<{ n: number }>("SELECT length(content) n FROM nodes WHERE node_id = ?", two.r['node_id'] as string)[0]!.n).toBeGreaterThan(0)
  })
})

describe('one leg live: a stamp that is provisional (D359)', () => {
  it('the first refusal is pending on the leg with its candidate; without the echo a second write is refused again, never accepted blind', async () => {
    const { s } = await withLegs()
    const { c, close } = await connect(s)
    const one = await put(c, text(20_000, 'A'))
    const two = await put(c, text(20_000, 'B'))
    await close(); await s.close()
    expect(one.raw as { isError?: boolean }).not.toMatchObject({ isError: true })
    expect(one.r).toMatchObject({
      refused: true, kind: 'checkpoint-over-cap', run: 'r1', key: 'login-form', size: 20_000, cap: CHECKPOINT_CAP_CHARS,
      writer_pending: true, candidates: [{ agent_id: 'a-builder', agent_type: 'builder' }],
    })
    expect(String(one.r['refusal_id'])).toMatch(/^[0-9a-f]{32}$/)
    expect(one.r['writer']).toBeUndefined()
    expect(String(one.r['shape'])).toContain('could not tell which writer you are (it might be builder)')
    expect(String(one.r['writer_note'])).toContain('pending')
    expect(two.r['refused']).toBe(true)
    expect(two.r['refusal_id']).toBe(one.r['refusal_id'])
    expect(checkpointRows()).toBe(0)
    // Pending on the registration the stamp named, one entry, no key settled.
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'pending', run: 'r1', key: 'login-form', size: 20_000, id: one.r['refusal_id'], candidates: [{ agent_id: 'a-builder', agent_type: 'builder' }] })])
    expect(registration('s1', 'a-builder')['key_src']).toBe('inferred')
    expect(owesSendBack(regLeg({ sessionId: 's1', agentId: 'a-builder' })!, false)).toBe(false)
  })

  it('with the refused call\'s echo staged, the second write reads it: the refusal is the builder\'s, its key is its own, the write is accepted and marked', async () => {
    const { s } = await withLegs()
    const { c, close } = await connect(s)
    const one = await put(c, text(20_000, 'A'))
    stageEcho(s, 's1', { agentId: 'a-builder', agentType: 'builder' }, replyText(one.r))
    const two = await put(c, text(20_000, 'B'))
    await close(); await s.close()
    expect(two.r['refused']).toBeUndefined()
    expect(two.r['checkpoint']).toMatchObject({ number: 1, over_cap: { size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true } })
    expect(String((two.r['checkpoint'] as Reply)['over_cap_note'])).toContain('could not tell your writer exactly')
    expect(meta(two.r['node_id'] as string)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true })
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'echo', id: one.r['refusal_id'] })])
    expect(refusedOf('s1', 'a-builder')[0]!.candidates).toBeUndefined()
    // The echo settled the key as the leg's own, by the mark the unsettle can undo.
    const reg = registration('s1', 'a-builder')
    expect([reg['key_src'], JSON.parse(String(reg['key_settled_from']))]).toEqual(['own', expect.objectContaining({ node_id: `cap-refusal:${one.r['refusal_id']}`, key: 'login-form', key_src: 'inferred' })])
  })

  it('the drain\'s echo heal does the same move, once: a replayed echo changes nothing', async () => {
    const { s } = await withLegs()
    const { c, close } = await connect(s)
    const one = await put(c, text(20_000, 'A'))
    const moved = drainEcho(s, 's1', 'a-builder', one.r)
    const again = drainEcho(s, 's1', 'a-builder', one.r)
    await close(); await s.close()
    expect(moved).toEqual({ moved: true, settled: true })
    expect(again).toEqual({ moved: false, settled: false })
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'echo' })])
    const leg = regLeg({ sessionId: 's1', agentId: 'a-builder' })!
    expect([leg.keySrc, legOwnsKey(leg), owesSendBack(leg, false), owesSendBack(leg, true)]).toEqual(['own', true, true, false])
    expect(capRefusalOf(leg)).toMatchObject({ size: 20_000, src: 'echo' })
  })
})

describe('two legs live (P1): the wrong writer is never refused, another leg\'s first write is never accepted (D359)', () => {
  it('builder refused, reviewer\'s first write refused too and moved to the reviewer by its echo, builder owed its send-back, reviewer\'s second write accepted and marked', async () => {
    const { s, legs } = await withLegs(['builder'])
    const solo = await connect(s)
    // The builder alone: provisional, pending, its echo names it.
    const b1 = await put(solo.c, text(20_000, 'A'))
    drainEcho(s, 's1', 'a-builder', b1.r)
    await solo.close()
    // The reviewer starts: both are live, no main activity: ambiguous.
    legs['reviewer'] = addLeg('s1', 'reviewer', 300)
    const { c, close } = await connect(s)
    const r1 = await put(c, text(20_000, 'B'))
    expect(r1.r).toMatchObject({
      refused: true, writer_pending: true,
      candidates: [{ agent_id: 'a-builder', agent_type: 'builder' }, { agent_id: 'a-reviewer', agent_type: 'reviewer' }],
    })
    // Pending on the registration the stamp names: the session's self.
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ src: 'pending', id: r1.r['refusal_id'] })])
    expect(refusedOf('s1', 'a-reviewer')).toEqual([])
    // The reviewer's own echo moves it off the self and onto the reviewer.
    expect(drainEcho(s, 's1', 'a-reviewer', r1.r)).toEqual({ moved: true, settled: true })
    expect(refusedOf('s1', '')).toEqual([])
    expect(refusedOf('s1', 'a-reviewer')).toEqual([expect.objectContaining({ src: 'echo', run: 'r1', key: 'login-form' })])
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'echo' })])
    // The builder, which wrote, is owed its send-back; so is the reviewer, which has.
    for (const role of ['builder', 'reviewer']) {
      const leg = regLeg({ sessionId: 's1', agentId: `a-${role}` })!
      expect([leg.keySrc, owesSendBack(leg, false)]).toEqual(['own', true])
    }
    // Both writers it could be were refused once: the second write is accepted and marked.
    const r2 = await put(c, text(20_000, 'C'))
    await close(); await s.close()
    expect(r2.r['refused']).toBeUndefined()
    expect(meta(r2.r['node_id'] as string)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true })
  })

  it('the reverse order: the reviewer is refused first, then the builder under another key is refused, each recorded on its own registration after the echoes', async () => {
    const { s } = await withLegs(['reviewer', 'builder'])
    const { c, close } = await connect(s)
    const r1 = await put(c, text(20_000, 'A'), { kind: 'checkpoint', run: 'r1', key: 'login-form' })
    stageEcho(s, 's1', { agentId: 'a-reviewer', agentType: 'reviewer' }, replyText(r1.r))
    const b1 = await put(c, text(20_000, 'B'), { kind: 'checkpoint', run: 'r1', key: 'search-box' })
    stageEcho(s, 's1', { agentId: 'a-builder', agentType: 'builder' }, replyText(b1.r))
    // The first call's echo was staged before the second write: it moved at the insert.
    expect(r1.r['writer_pending']).toBe(true)
    expect(b1.r['refused']).toBe(true)
    drainEcho(s, 's1', 'a-reviewer', r1.r)
    drainEcho(s, 's1', 'a-builder', b1.r)
    await close(); await s.close()
    expect(refusedOf('s1', '')).toEqual([])
    expect(refusedOf('s1', 'a-reviewer').map((e) => `${e.key}:${e.src}`)).toEqual(['login-form:echo'])
    expect(refusedOf('s1', 'a-builder').map((e) => `${e.key}:${e.src}`)).toEqual(['search-box:echo'])
    expect(checkpointRows()).toBe(0)
  })

  it('a second write is refused again while a writer it might be has not been refused, never accepted blind', async () => {
    const { s } = await withLegs(['builder', 'reviewer'])
    const { c, close } = await connect(s)
    const a = await put(c, text(20_000, 'A'))
    stageEcho(s, 's1', { agentId: 'a-builder', agentType: 'builder' }, replyText(a.r))
    const b = await put(c, text(20_000, 'B'))
    await close(); await s.close()
    // The builder's refusal resolved at the second write; the reviewer was not refused.
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'echo' })])
    expect(b.r).toMatchObject({ refused: true, writer_pending: true })
    expect(checkpointRows()).toBe(0)
  })
})

describe('the main agent beside a live leg (P2, P3): the refusal lands on the writer the echo names (D359)', () => {
  it('main over the cap beside a live leg: pending on the self with both candidates, moved to main by its echo; the leg is not sent back; main is refused again until the leg stops', async () => {
    const { s } = await withLegs(['builder'])
    mainIsActive(s)
    const { c, close } = await connect(s)
    const m1 = await put(c, text(20_000, 'A'))
    expect(m1.r).toMatchObject({
      refused: true, writer_pending: true,
      candidates: [{ agent_id: 'a-builder', agent_type: 'builder' }, { agent_id: '', agent_type: null }],
    })
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ src: 'pending' })])
    expect(drainEcho(s, 's1', null, m1.r)).toEqual({ moved: true, settled: false })
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ src: 'echo' })])
    const leg = regLeg({ sessionId: 's1', agentId: 'a-builder' })!
    expect([refusedOf('s1', 'a-builder'), leg.keySrc, owesSendBack(leg, false)]).toEqual([[], 'inferred', false])
    // The builder wrote nothing and was never refused: main's second write is not accepted on a guess.
    const m2 = await put(c, text(20_000, 'B'))
    expect(m2.r).toMatchObject({ refused: true, writer_pending: true })
    // The leg stops: no subagent is live, the stamp is exact, main's second write is its second.
    const db = new DatabaseSync(path())
    try { retireAllSubagents(db, 's1', 400) } finally { db.close() }
    const m3 = await put(c, text(20_000, 'C'))
    await close(); await s.close()
    expect(m3.r['refused']).toBeUndefined()
    expect(meta(m3.r['node_id'] as string)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true })
  })

  it('a leg\'s write read as concurrent (the stamp guessed main): the refusal sits on the self until the leg\'s echo moves it onto the leg and settles its key', async () => {
    const { s } = await withLegs(['builder'])
    mainIsActive(s)
    const { c, close } = await connect(s)
    const b1 = await put(c, text(20_000, 'A'))
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ src: 'pending' })])
    expect(drainEcho(s, 's1', 'a-builder', b1.r)).toEqual({ moved: true, settled: true })
    await close(); await s.close()
    expect(refusedOf('s1', '')).toEqual([])
    expect(refusedOf('s1', 'a-builder')).toEqual([expect.objectContaining({ src: 'echo' })])
    const leg = regLeg({ sessionId: 's1', agentId: 'a-builder' })!
    expect([leg.keySrc, owesSendBack(leg, false)]).toEqual(['own', true])
  })

  it('P6, a row accepted while every candidate had been refused whose echo names the main agent (the stamp already read main): the mark follows the echo', async () => {
    const { s } = await withLegs(['builder', 'reviewer'])
    const { c, close } = await connect(s)
    const a = await put(c, text(20_000, 'A'))
    drainEcho(s, 's1', 'a-builder', a.r)
    const b = await put(c, text(20_000, 'B'))
    drainEcho(s, 's1', 'a-reviewer', b.r)
    const accepted = await put(c, text(20_000, 'C'))
    const id = accepted.r['node_id'] as string
    expect(meta(id)[OVER_CAP_KEY]).toMatchObject({ second: true })
    // The echo says the main agent made that call: main has no refusal on record.
    const healed = s.store.healWriterFromEcho({ nodeId: id, echoSessionId: 's1', echoTs: Date.now() / 1000, deduplicated: false, agentId: null, agentType: null })
    await close(); await s.close()
    expect(healed.outcome).toBe('confirmed')
    expect(meta(id)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: false })
  })

  it('no echo anywhere: the refusal stays pending on the registration the stamp named, the reply and the entry say so, nothing is accepted on a guess, and no leg is sent back for it', async () => {
    const { s } = await withLegs(['builder', 'reviewer'])
    const { c, close } = await connect(s)
    const a = await put(c, text(20_000, 'A'))
    const b = await put(c, text(20_000, 'B'))
    // The handle is closed here: an open one keeps Windows from removing tmpDir.
    const probe = new DatabaseSync(path())
    let resolved: number
    try { resolved = resolveStagedCapRefusals(probe as never, 's1') } finally { probe.close() }
    await close(); await s.close()
    expect([a.r['refused'], b.r['refused'], a.r['writer_pending'], resolved]).toEqual([true, true, true, 0])
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ src: 'pending', candidates: expect.any(Array) })])
    expect(refusedOf('s1', '')).toHaveLength(1)
    for (const role of ['builder', 'reviewer']) {
      const leg = regLeg({ sessionId: 's1', agentId: `a-${role}` })!
      expect([leg.keySrc, owesSendBack(leg, false)]).toEqual(['inferred', false])
    }
    expect(checkpointRows()).toBe(0)
  })
})

describe('the insert tool: an exact writer\'s refusal is a reply, with the shape asked for (D299, D332)', () => {
  it('the main agent with no subagent live is refused on the session\'s self registration, told who it is', async () => {
    const s = await open()
    const db = new DatabaseSync(path())
    try { registerSelf(db, 's1', MAIN, 100) } finally { db.close() }
    const { c, close } = await connect(s)
    const a = await put(c, text(18_000, 'A'), { kind: 'checkpoint', run: 'r9', key: 'k' })
    const b = await put(c, text(18_000, 'B'), { kind: 'checkpoint', run: 'r9', key: 'k' })
    await close(); await s.close()
    expect(a.raw as { isError?: boolean }).not.toMatchObject({ isError: true })
    expect(a.r).toEqual({
      refused: true, kind: 'checkpoint-over-cap', run: 'r9', key: 'k', size: 18_000, cap: CHECKPOINT_CAP_CHARS,
      ...checkpointCapRefusal({ run: 'r9', key: 'k', size: 18_000 }), refusal_id: a.r['refusal_id'], writer: 'main', writer_src: 'self',
    })
    expect(b.r['refused']).toBeUndefined()
    expect((b.r['checkpoint'] as Reply)['over_cap']).toEqual({ size: 18_000, cap: CHECKPOINT_CAP_CHARS, second: true })
    expect(String((b.r['checkpoint'] as Reply)['over_cap_note'])).toContain('on this writer\'s second write')
    expect(refusedOf('s1', '')).toEqual([expect.objectContaining({ run: 'r9', key: 'k', size: 18_000, src: 'exact' })])
  })
})

describe('the cap feeds the send-back (D279, D295, D299, D326)', () => {
  it('a leg refused through the library owns the key it attempted: owed its send-back, the reason naming the cap and the size', async () => {
    const { s, legs } = await withLegs()
    await s.writeCheckpoint(text(20_000), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    // A library refusal is exact; the key is settled by the leg's next write, or by the echo of a tool refusal.
    await s.close()
    const leg = regLeg(legs['builder']!)!
    expect(leg.keySrc).toBe('inferred')
    expect(legOwnsKey(leg)).toBe(false)
    const refusal = capRefusalOf(leg)
    expect(refusal).toMatchObject({ run: 'r1', key: 'login-form', size: 20_000, src: 'exact' })
    const reason = sendBackReason('builder', 'r1', 'login-form', refusal)
    expect(reason).toContain('newer than your start')
    expect(reason).toContain(`20000 characters, was refused for being past the ${CHECKPOINT_CAP_CHARS}-character cap`)
    expect(reason).toContain('nothing of it was written')
    expect(reason.endsWith('This is your one send-back; there is no other.')).toBe(true)
    expect(sendBackReason('builder', 'r1', 'login-form')).not.toContain('cap')
    // A checkpoint newer than its start, anyone's, ends the ask.
    expect(owesSendBack({ ...leg, keySrc: 'own' }, false)).toBe(true)
    expect(owesSendBack({ ...leg, keySrc: 'own' }, true)).toBe(false)
  })

  it('the ticket door\'s decision gives the same verdict and names the refusal in its words', () => {
    const base = {
      exit: { code: 0, signal: null }, ticketValid: true, noKey: false, role: 'builder', checkpointer: 'builder', canWrite: null,
      sendBacks: 0, checkpointSinceStart: false, storeWritable: true,
    }
    const refused = sendBackDecision({ ...base, capRefused: { size: 20_000 } })
    expect(refused.sendBack).toBe(true)
    expect(refused.why).toContain(`its one of 20000 characters having been refused at the ${CHECKPOINT_CAP_CHARS}-character cap`)
    expect(sendBackDecision(base).why).not.toContain('cap')
    expect(sendBackDecision({ ...base, capRefused: { size: 20_000 }, checkpointSinceStart: true }).sendBack).toBe(false)
  })

  it('composeSendBackMessage carries the clause in the reason, once, after the first moment composed again', async () => {
    const { s, legs } = await withLegs()
    await s.writeCheckpoint(text(20_000), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    const facts = s.firstMomentFacts({ run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', checkpointedBy: null, self: legs['builder']! })
    await s.close()
    const message = composeSendBackMessage({ facts, prompt: null, sessionId: 's1', firstMomentId: null, rows: 0, capRefused: { size: 20_000 } })
    const reason = sendBackReason('builder', 'r1', 'login-form', { size: 20_000 })
    expect(message).toContain(reason)
    expect(message.indexOf(reason)).toBeGreaterThan(message.indexOf(STATE_NOT_HISTORY_LINE))
    expect(message.split('was refused for being past the').length).toBe(2)
  })
})

describe('what it cost: the next leg sees the mark (D321)', () => {
  it('the checkpoint accepted over the cap is in effect whole, in the lookup, the first message and the first-moment row', async () => {
    const { s, legs } = await withLegs()
    const n = 20_000
    await s.writeCheckpoint(text(n, 'A'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    const accepted = await s.writeCheckpoint(text(n, 'B'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    const lookup = s.lookupKey({ run: 'r1', key: 'login-form' })
    const cp = lookup.checkpoints[0]!
    expect(cp.nodeId).toBe(accepted.nodeId)
    const mark = { size: n, cap: CHECKPOINT_CAP_CHARS, second: true }
    expect([cp.size, cp.overCap, cp.content]).toEqual([n, mark, text(n, 'B')])
    expect(keyLookupReply(lookup).checkpoints[0]).toMatchObject({ size: n, over_cap: mark, claimed_over_cap: null, content: text(n, 'B') })
    expect(lookup.facts.lastSizes).toEqual([n])
    const facts = s.firstMomentFacts({ run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', checkpointedBy: null })
    const message = composeFirstMessage(facts, 'carry on')
    expect(message).toContain(`${n} characters, ${overCapWords(mark)}:\n${text(n, 'B')}`)
    const m = firstMomentMetadata({ sessionId: 's1', run: 'r1', key: 'login-form', prompt: 'carry on', firstMessage: message, facts })
    await s.close()
    expect(m['checkpoint_size']).toBe(n)
    expect(m['checkpoint_over_cap']).toBe(true)
    expect((m['first_moment'] as { checkpoints: Array<Record<string, unknown>> }).checkpoints[0]).toMatchObject({ node_id: accepted.nodeId, size: n, over_cap: mark })
  })

  it('a checkpoint within the cap adds nothing to the first message or the row', async () => {
    const { s, legs } = await withLegs()
    await s.writeCheckpoint('state: small', { run: 'r1', key: 'login-form', leg: legs['builder']! })
    const facts = s.firstMomentFacts({ run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', checkpointedBy: null })
    const message = composeFirstMessage(facts, null)
    const m = firstMomentMetadata({ sessionId: 's1', run: 'r1', key: 'login-form', prompt: '', firstMessage: message, facts })
    await s.close()
    expect(message).toContain('12 characters:\nstate: small')
    expect(message).not.toContain('cap on its second write')
    expect(m['checkpoint_over_cap']).toBeUndefined()
    expect((m['first_moment'] as { checkpoints: Array<Record<string, unknown>> }).checkpoints[0]!['over_cap']).toBeUndefined()
  })
})

describe('an imported mark is the file\'s claim (D321, D343, D359)', () => {
  it('the mark lands under _handoff_claims, the lookup shows a claim and no mark, and the imported row is not capped', async () => {
    const s = await open()
    const file = JSON.stringify({
      version: 1, exported_by: 'a@host-a',
      nodes: [{
        nodeId: 'b'.repeat(32), content: text(20_000, 'I'), createdAt: Date.now() / 1000 - 60,
        metadata: { kind: 'checkpoint', run: 'r1', key: 'login-form', _checkpoint_number: 1, _writer: 'builder', [OVER_CAP_KEY]: { size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true } },
      }],
    })
    const res = await s.importJson(file, { handoff: { file: 'a.json', importer: null } })
    expect(res.importedCount).toBe(1)
    const m = meta('b'.repeat(32))
    expect(m[OVER_CAP_KEY]).toBeUndefined()
    expect((m['_handoff_claims'] as Reply)[OVER_CAP_KEY]).toEqual({ size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true })
    const lookup = s.lookupKey({ run: 'r1', key: 'login-form' })
    const reply = keyLookupReply(lookup).checkpoints[0]!
    await s.close()
    expect([reply.imported, reply.over_cap, reply.claimed_over_cap, reply.size]).toEqual([true, null, { size: 20_000, cap: CHECKPOINT_CAP_CHARS, second: true }, 20_000])
  })
})

describe('a refusal is not an insert (M11)', () => {
  it('a refused checkpoint does not advance the retention sweep counter; an accepted one does', async () => {
    const { s, legs } = await withLegs()
    const sweeps = (): number => (s as unknown as { insertsSinceSweep: number }).insertsSinceSweep
    const before = sweeps()
    await s.writeCheckpoint(text(20_000, 'A'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    expect(sweeps()).toBe(before)
    await s.writeCheckpoint(text(20_000, 'B'), { run: 'r1', key: 'login-form', leg: legs['builder']! })
    expect(sweeps()).toBe(before + 1)
    await s.close()
  })
})
