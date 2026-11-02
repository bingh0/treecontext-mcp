/**
 * The session registry and the writer stamp (D190, D169, D150) below the
 * charter. The charter scenarios in features/journal-orchestration.feature
 * drive the single-live case through the real hooks; these pin the rest of
 * the stamping rule — the ambiguous case above all — and the lane key's
 * reading of stamped and unstamped rows.
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
import { laneWriterOf, laneLabelOf, writerOf, summarizeLanes, MAIN_LANE, AMBIGUOUS_LANE, UNKNOWN_LANE } from '../src/references.js'
import {
  registerSelf, registerSubagent, retireSubagent, resolveWriter, liveSubagents, type GitSelf,
} from '../src/persistence/session-registry.js'
import { parseToolResult } from './helpers/mcp-result.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-registry-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'registry.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: 1_000_000 })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }
const WT: GitSelf = { worktree: 'feature-login', branch: 'login-form', cwd: '/feature-login', toplevel: '/feature-login', commonDir: '/repo/.git' }

function withRaw<T>(fn: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(path())
  try { return fn(raw) } finally { raw.close() }
}
function meta(id: string): Record<string, unknown> {
  return withRaw((db) => JSON.parse((db.prepare('SELECT metadata_json AS m FROM nodes WHERE node_id = ?').get(id) as { m: string }).m) as Record<string, unknown>)
}

async function client(store: FlatStore, session: string): Promise<{ c: Client; close: () => Promise<void> }> {
  const server = createServer(store, { ccSessionId: session })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'registry', version: '0' })
  await server.connect(st)
  await c.connect(ct)
  return { c, close: async () => { await c.close(); await server.close() } }
}
async function insert(c: Client, content: string, metadata: Record<string, unknown> = {}, supersedes?: string[]): Promise<Record<string, unknown>> {
  return parseToolResult(await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata, ...(supersedes ? { supersedes } : {}) } }))
}

describe('resolveWriter (D190)', () => {
  it('reads each branch of the rule from the registry', async () => {
    const s = await open()
    await s.close()
    withRaw((db) => {
      expect(resolveWriter(db, null)).toEqual({ src: 'unregistered' })
      expect(resolveWriter(db, 's1')).toEqual({ src: 'unregistered' })
      registerSelf(db, 's1', MAIN, 100)
      expect(resolveWriter(db, 's1')).toEqual({ src: 'self', writer: 'main', branch: 'main' })
      registerSubagent(db, 's1', 'a1', 'tester', MAIN, 101)
      expect(resolveWriter(db, 's1')).toEqual({ src: 'provisional', writer: 'tester', agentId: 'a1', branch: 'main' })
      registerSubagent(db, 's1', 'a2', 'reviewer', MAIN, 102)
      expect(resolveWriter(db, 's1')).toEqual({
        src: 'ambiguous', writer: 'main', branch: 'main',
        candidates: [{ agent_id: 'a1', agent_type: 'tester' }, { agent_id: 'a2', agent_type: 'reviewer' }],
      })
      expect(retireSubagent(db, 's1', 'a1', 103)).toBe(true)
      expect(retireSubagent(db, 's1', 'a1', 104)).toBe(false)
      expect(liveSubagents(db, 's1').map((a) => a.agentId)).toEqual(['a2'])
      expect(resolveWriter(db, 's1')).toMatchObject({ src: 'provisional', writer: 'reviewer' })
      // A worktree session's self is its worktree, its own lane.
      registerSelf(db, 's2', WT, 200)
      expect(resolveWriter(db, 's2')).toEqual({ src: 'self', writer: 'worktree:feature-login', worktree: 'feature-login', branch: 'login-form' })
    })
  })
})

describe('the stamp on a tool-written row (D190)', () => {
  it('stamps the self, drops a caller-claimed stamp, and says an unregistered session\'s writer is undetermined (D235)', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const r = await insert(c, 'orchestrator note', { _writer: 'tester', _writer_src: 'registry', _worktree: 'elsewhere' })
    expect(r).toMatchObject({ writer: 'main', writer_src: 'self' })
    expect(meta(r['node_id'] as string)).toMatchObject({ _writer: 'main', _writer_src: 'self', _branch: 'main' })
    expect(meta(r['node_id'] as string)['_worktree']).toBeUndefined()
    await close()
    const other = await client(s, 's-unknown')
    const u = await insert(other.c, 'a note from a session no hook registered', { _writer: 'tester', agent_type: 'tester' })
    // D235: the reply says the writer stamped: none named, `unregistered`,
    // and why, never the role the caller claims.
    expect(u).toMatchObject({ writer: null, writer_src: 'unregistered' })
    expect(String(u['writer_note'])).toMatch(/writer unknown/)
    expect(String(u['writer_note'])).toMatch(/claim, not as its writer/)
    expect(meta(u['node_id'] as string)['_writer']).toBeUndefined()
    expect(meta(u['node_id'] as string)).toMatchObject({ _writer_src: 'unregistered', agent_type: 'tester' })
    // D376: shown as writer unknown wherever a writer is shown, the claim
    // left in its metadata (U1 review F5).
    expect(writerOf(meta(u['node_id'] as string))).toBe('writer unknown')
    await other.close()
    await s.close()
  })

  it('discloses the ambiguous case and never retires a pointer from it', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const chapter = (await insert(c, 'plan: wire the login form', { next_session: true }))['node_id'] as string
    withRaw((db) => { registerSubagent(db, 's1', 'a1', 'tester', MAIN, 101); registerSubagent(db, 's1', 'a2', 'reviewer', MAIN, 102) })
    const r = await insert(c, 'plan: something else', { next_session: true }, [chapter])
    expect(r).toMatchObject({ writer: 'main', writer_src: 'ambiguous', superseded: [], referenced: [chapter] })
    expect(String(r['writer_note'])).toMatch(/2 subagents of this session were live \(tester, reviewer\)/)
    expect(r['writer_candidates']).toEqual([{ agent_id: 'a1', agent_type: 'tester' }, { agent_id: 'a2', agent_type: 'reviewer' }])
    expect(meta(r['node_id'] as string)).toMatchObject({ _writer: 'main', _writer_src: 'ambiguous', refs: [chapter] })
    // The chapter stays a live pointer, untouched.
    expect(meta(chapter)['next_session']).toBe(true)
    await close()
    await s.close()
  })

  it('scopes a live subagent\'s search to its role and the plan, widened by scope "all"', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const plan = (await insert(c, 'plan: the login form', { next_session: true }))['node_id'] as string
    const brief = (await insert(c, 'brief: testers check the login cookie', { brief_for: 'tester' }))['node_id'] as string
    const mine = (await insert(c, 'orchestrator: login notes of my own'))['node_id'] as string
    withRaw((db) => registerSubagent(db, 's1', 'a1', 'tester', MAIN, 101))
    const own = (await insert(c, 'tester: login cookie checked'))['node_id'] as string
    const q = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'login', top_k: 10 } }))
    const ids = (q['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    expect(ids.sort()).toEqual([plan, brief, own].sort())
    expect(JSON.stringify(q)).not.toContain(mine)
    const all = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'login', top_k: 10, scope: 'all' } }))
    expect((all['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)).toContain(mine)
    await close()
    await s.close()
  })
})

describe('the lane key across the stamp (D228, D190)', () => {
  it('reads an older unstamped row and a main-stamped row as one lane, and an ambiguous row as no lane', () => {
    expect(laneWriterOf({ _cc_session_id: 'old' })).toBe(MAIN_LANE)
    expect(laneWriterOf({ _writer: 'main', _writer_src: 'self' })).toBe(MAIN_LANE)
    expect(laneWriterOf({ _writer: 'worktree:feature-login' })).toBe('worktree:feature-login')
    expect(laneWriterOf({ _writer: 'tester', _writer_src: 'registry' })).toBe('tester')
    expect(laneWriterOf({ _writer: 'main', _writer_src: 'ambiguous' })).toBe(AMBIGUOUS_LANE)
  })

  it('lets a new main session retire an older unstamped chapter', async () => {
    const s = await open()
    const old = (await s.insert('plan: before the registry', { metadata: { next_session: true, _cc_session_id: 'old' } })).nodeId
    withRaw((db) => registerSelf(db, 's2', MAIN, 100))
    const { c, close } = await client(s, 's2')
    const r = await insert(c, 'plan: after the registry', { next_session: true }, [old])
    expect(r).toMatchObject({ writer: 'main', superseded: [old] })
    expect(meta(old)['next_session']).toBeUndefined()
    await close()
    await s.close()
  })
})

describe('the hook-staged writer at the drain (D190, D147)', () => {
  it('carries agent_id, agent_type and kind from staging into the row', async () => {
    const s = await open()
    s.store.insertStaging({ sessionId: 's1', role: 'assistant', content: 'subagent report', timestamp: 100, agentId: 'a1', agentType: 'tester', kind: 'subagent-summary' })
    s.store.insertStaging({ sessionId: 's1', role: 'assistant', content: 'Tool: Bash\nmain agent call', toolName: 'Bash', timestamp: 101 })
    const { IngestionLoop } = await import('../src/server/ingestion.js')
    await new IngestionLoop(s).ingestBatch()
    const rows = withRaw((db) => db.prepare('SELECT content, metadata_json AS m FROM nodes ORDER BY created_at').all() as Array<{ content: string; m: string }>)
    expect(JSON.parse(rows[0]!.m)).toMatchObject({ _writer: 'tester', _writer_agent_id: 'a1', _writer_src: 'hook', kind: 'subagent-summary' })
    expect(JSON.parse(rows[1]!.m)['_writer']).toBeUndefined()
    await s.close()
  })
})

// ── F4–F7 of the chunk-5b review: the surfaces, pinned ─────────────────

import { execFileSync } from 'node:child_process'
import { selfLines } from '../src/checkpoints.js'
import { agentWriterOf, worktreeLaneName } from '../src/persistence/session-registry.js'
import { gitSelfOf } from '../src/hooks/git-self.js'

describe('the reply fields of a stamp (F4)', () => {
  it('pins provisional, concurrent and ambiguous replies and their scope blocks', async () => {
    const s = await open()
    withRaw((db) => { registerSelf(db, 's1', MAIN, 100); registerSubagent(db, 's1', 'a1', 'tester', MAIN, 200) })
    const { c, close } = await client(s, 's1')
    const p = await insert(c, 'note one')
    expect(Object.keys(p).filter((k) => k.startsWith('writer')).sort()).toEqual(['writer', 'writer_note', 'writer_src'])
    expect(p).toMatchObject({ writer: 'tester', writer_src: 'provisional' })
    expect(p['writer_note']).toBe('The tester subagent is this session\'s one live subagent and the session\'s own agent has been '
      + 'silent since it started, so this entry is stamped "tester" provisionally; the call\'s own echo confirms or corrects the writer when it is captured.')
    const q1 = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'note' } }))
    expect(q1['scope']).toEqual({ writer: 'tester', searched: "the tester role's trail and the plan it was spawned under", widen: 'pass scope "all" to search the whole store' })
    // The session's own agent seen by a hook after the subagent started.
    s.store.insertStaging({ sessionId: 's1', role: 'user', content: 'keep going', timestamp: 300 })
    const k = await insert(c, 'note two')
    expect(k).toMatchObject({ writer: 'main', writer_src: 'concurrent', writer_candidates: [{ agent_id: 'a1', agent_type: 'tester' }] })
    expect(k['writer_note']).toBe('A subagent of this session is live (tester) but the session\'s own agent has been active since it started, '
      + 'so this entry is stamped "main", the session\'s own; the call\'s own echo corrects the writer when it is captured.')
    expect(meta(k['node_id'] as string)).toMatchObject({ _writer: 'main', _writer_src: 'concurrent', _writer_candidates: [{ agent_id: 'a1', agent_type: 'tester' }] })
    const q2 = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'note' } }))
    expect(q2['scope']).toEqual({ searched: 'the whole store', why: "a subagent of this session is live but the session's own agent has been active beside it, so the caller cannot be told apart and no subagent scope applies" })
    // The reply's "whole store" is the search's (D240, D374, U3-F3): the
    // tester's provisional row lies outside main's lane, a helper's trail,
    // and a concurrent caller still finds it.
    const contentsOf = (r: Record<string, unknown>): string[] => (r['results'] as Array<{ content: string }>).map((h) => h.content)
    expect(contentsOf(q2)).toContain('note one')
    expect(contentsOf(q2)).toContain('note two')
    // An ambiguous caller alike: a main session with two live subagents
    // finds the first session's tester row, outside its lane.
    withRaw((db) => { registerSelf(db, 's3', MAIN, 400); registerSubagent(db, 's3', 'b1', 'tester', MAIN, 401); registerSubagent(db, 's3', 'b2', 'reviewer', MAIN, 402) })
    const amb = await client(s, 's3')
    const q3 = parseToolResult(await amb.c.callTool({ name: 'treecontext_query', arguments: { query: 'note' } }))
    expect(q3['scope']).toEqual({ searched: 'the whole store', why: 'several subagents of this session are live, so the caller cannot be told apart and no subagent scope applies' })
    expect(contentsOf(q3)).toContain('note one')
    await amb.close()
    const all = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'note', scope: 'all' } }))
    expect(all['scope']).toBeUndefined()
    await close()
    await s.close()
  })

  it('pins the writer trail: writer, node_count, omitted, and "main" with older unstamped rows', async () => {
    const s = await open()
    await s.insert('main: an old note with no writer', { metadata: { _cc_session_id: 'old' }, createdAt: 10 })
    await s.insert('a claim', { metadata: { agent_type: 'tester' }, createdAt: 11 })
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    await insert(c, 'main: a stamped note')
    withRaw((db) => registerSubagent(db, 's1', 'a1', 'tester', MAIN, 200))
    for (let i = 0; i < 3; i++) await insert(c, `tester note ${i}`)
    const main = parseToolResult(await c.callTool({ name: 'treecontext_export', arguments: { writer: 'main' } }))
    expect(main['writer']).toBe('main')
    expect((main['nodes'] as Array<{ content: string }>).map((n) => n.content)).toEqual(['main: an old note with no writer', 'main: a stamped note'])
    expect(main['node_count']).toBe(2)
    expect(main['omitted']).toBeUndefined()
    const t = parseToolResult(await c.callTool({ name: 'treecontext_export', arguments: { writer: 'tester', max_export_nodes: 2 } }))
    expect(t).toMatchObject({ writer: 'tester', node_count: 2, omitted: 2 })
    expect((t['nodes'] as Array<{ content: string }>).map((n) => n.content)).toEqual(['tester note 1', 'tester note 2'])
    expect(t['omitted']).toBe(2)
    expect(String(t['omitted_note'])).toMatch(/^The trail holds 4 entries; the newest 2 are shown, oldest first\./)
    await close()
    await s.close()
  })
})

describe('the self lines of a fresh start (F4, F7, D373)', () => {
  it('pins the worktree lines, and an ambiguous row is never the worktree\'s own chapter', async () => {
    const s = await open()
    const own = (await s.insert('plan: wire the login form', { metadata: { next_session: true, _writer: 'worktree:feature-login', _writer_src: 'self' } })).nodeId
    const guess = (await s.insert('plan: a guess', { metadata: { next_session: true, _writer: 'worktree:feature-x', _writer_src: 'ambiguous' } })).nodeId
    await s.insert('build the search box', { metadata: { brief_for: 'feature-search', _writer: 'main', _writer_src: 'self' } })
    await s.close()
    const db = new DatabaseSync(path())
    try {
      const at = Date.now() / 1000
      const login = selfLines(db, { worktree: 'feature-login', branch: 'login-form' }, at)
      expect(login[0]).toBe('This session runs in the worktree "feature-login" on the branch "login-form"; it re-orients on that worktree\'s own thread.')
      expect(login[1]).toMatch(new RegExp(`^The worktree's own chapter summary, 0 minutes old \\(id ${own}\\): plan: wire the login form$`))
      expect(login[2]).toBe('  referenced by: none')
      // The ambiguous pointer is another lane's, counted and named, never its text or id.
      expect(login[3]).toBe('1 other lane holds a live pointer, not shown here; the most recent: ambiguous writer (chapter summary, 0 minutes old, 1 live pointer). '
        + 'To look: treecontext_status with scope "all", or treecontext_export with writer naming the lane.')
      expect(login).toHaveLength(4)
      expect(login.join('\n')).not.toContain(guess)
      const search = selfLines(db, { worktree: 'feature-search', branch: null }, at)
      expect(search[0]).toBe('This session runs in the worktree "feature-search"; it re-orients on that worktree\'s own thread.')
      expect(search[1]).toMatch(/^Brief for this worktree from main, 0 minutes old \(id [0-9a-f]+\): build the search box$/)
      expect(search[2]).toBe('The worktree "feature-search" has no chapter summary of its own yet; it starts from the brief.')
      expect(selfLines(db, { worktree: 'feature-x', branch: null }, at)[1])
        .toBe('No chapter summary or brief exists for the worktree "feature-x" yet; it starts fresh.')
      const main = selfLines(db, { worktree: null, branch: 'main' }, at)
      expect(main[0]).toBe('This session runs in the main checkout on the branch "main"; it re-orients on the main lane\'s own thread.')
      expect(main[1]).toBe('No chapter summary, bookmark or brief exists for the main lane yet; it starts fresh.')
      expect(main[2]).toMatch(/^2 other lanes hold live pointers, not shown here; the most recent: (ambiguous writer|worktree:feature-login) \(chapter summary/)
    } finally { db.close() }
  })

  it('pins the main lane\'s lines: its chapter (an unstamped one is main\'s), its bookmark alone, its brief, and the other lanes capped at three', async () => {
    const s = await open()
    const t = Math.floor(Date.now() / 1000)
    const older = (await s.insert('plan: the first release', { metadata: { next_session: true }, createdAt: t - 7200 })).nodeId
    const unknown = (await s.insert('plan: a stranger', { metadata: { next_session: true, _writer_src: 'unregistered' }, createdAt: t - 60 })).nodeId
    for (const [i, n] of ['a', 'b', 'c', 'd'].entries()) {
      await s.insert(`plan: worktree ${n}`, { metadata: { next_session: true, _writer: `worktree:${n}`, _writer_src: 'self' }, createdAt: t - 600 + i * 60 })
    }
    await s.close()
    let db = new DatabaseSync(path())
    try {
      const main = selfLines(db, { worktree: null, branch: 'main', toplevel: '/repo' }, t)
      expect(main[1]).toBe(`The main lane's own chapter summary, 2 hours old (id ${older}): plan: the first release`)
      expect(main[2]).toBe('  referenced by: none')
      // Newest first, three named, the rest counted; "writer unknown" a lane apart.
      expect(main[3]).toBe('5 other lanes hold live pointers, not shown here; the most recent: writer unknown (chapter summary, 1 minute old, 1 live pointer); '
        + 'worktree:d (chapter summary, 7 minutes old, 1 live pointer); worktree:c (chapter summary, 8 minutes old, 1 live pointer); and 2 more. '
        + 'To look: treecontext_status with scope "all", or treecontext_export with writer naming the lane.')
      expect(main).toHaveLength(4)
      expect(main.join('\n')).not.toContain(unknown)
      expect(main.join('\n')).not.toContain('stranger')
      expect(selfLines(db, { worktree: null, branch: null, toplevel: null }, t)[0])
        .toBe('This session runs outside any git checkout, in the main lane; it re-orients on the main lane\'s own thread.')
    } finally { db.close() }
    // Bookmark only, and a brief to main.
    const s2 = await open()
    await s2.delete(older)
    const bm = (await s2.insert('at: README install section half rewritten', { metadata: { next_session: true, kind: 'bookmark', _writer: 'main', _writer_src: 'self' }, createdAt: t - 120 })).nodeId
    const brief = (await s2.insert('document the doctor table', { metadata: { brief_for: 'main', _writer: 'tester', _writer_src: 'self' }, createdAt: t - 30 })).nodeId
    await s2.close()
    db = new DatabaseSync(path())
    try {
      const main = selfLines(db, { worktree: null, branch: 'main', toplevel: '/repo' }, t)
      expect(main[1]).toBe(`The main lane has no chapter summary of its own; its live bookmark, 2 minutes old (id ${bm}): at: README install section half rewritten`)
      expect(main[2]).toBe(`Brief for this checkout from tester, 0 minutes old (id ${brief}): document the doctor table`)
      expect(main[3]).toMatch(/^5 other lanes hold live pointers/)
    } finally { db.close() }
  })
})

describe('status lists the session\'s own lane (F5, D242, D372)', () => {
  it('confines the pointers with a scope block in a worktree and in the main checkout; scope "all" lists every lane flat, each naming its lane', async () => {
    const s = await open()
    withRaw((db) => { registerSelf(db, 'wt', WT, 100); registerSelf(db, 'm', MAIN, 100) })
    const wt = await client(s, 'wt')
    const own = (await insert(wt.c, 'plan: the login form', { next_session: true }))['node_id'] as string
    const m = await client(s, 'm')
    const mainPtr = (await insert(m.c, 'plan: the release', { next_session: true }))['node_id'] as string
    const older = (await s.insert('plan: an older unstamped pointer', { metadata: { next_session: true } })).nodeId
    const st = parseToolResult(await wt.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((st['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toEqual([own])
    expect((st['resume_pointers'] as Array<{ lane: string }>)[0]!.lane).toBe('worktree:feature-login')
    expect(st['scope']).toEqual({
      lane: 'worktree:feature-login', listed: "the resume pointers of this worktree's own lane (worktree:feature-login)",
      // D242's other_lanes as shipped is the pointers left out (two of
      // main's); D372's count of the lanes holding them (one) is apart.
      other_lanes: 2, other_lane_count: 1, lanes: [{ lane: 'main', kind: 'chapter summary', age: '0 minutes old', pointers: 2 }],
      widen: 'pass scope "all" to list every lane\'s pointers; treecontext_export with writer reads one lane\'s trail',
    })
    const every = parseToolResult(await wt.c.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
    expect((every['resume_pointers'] as Array<{ lane: string }>).map((p) => p.lane).sort()).toEqual(['main', 'main', 'worktree:feature-login'])
    expect(every['scope']).toBeUndefined()
    const ms = parseToolResult(await m.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((ms['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id).sort()).toEqual([older, mainPtr].sort())
    expect(ms['scope']).toEqual({
      lane: 'main', listed: "the resume pointers of the main checkout's own lane (main)",
      other_lanes: 1, other_lane_count: 1, lanes: [{ lane: 'worktree:feature-login', kind: 'chapter summary', age: '0 minutes old', pointers: 1 }],
      widen: 'pass scope "all" to list every lane\'s pointers; treecontext_export with writer reads one lane\'s trail',
    })
    expect(JSON.stringify(ms)).not.toContain(own)
    expect(JSON.stringify(ms)).not.toContain('login form')
    await wt.close(); await m.close()
    await s.close()
  })

  it('names each other lane by the kind and age of its newest pointer, in status and in the packet (D372, D373)', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 'm', MAIN, 100))
    const t = Math.floor(Date.now() / 1000)
    // The worktree's lane: an older chapter, then a newer bookmark.
    await s.insert('plan: the login form', { metadata: { next_session: true, _writer: 'worktree:feature-login', _writer_src: 'self' }, createdAt: t - 7200 })
    await s.insert('at: the form posts, the CSRF test is next', { metadata: { next_session: true, kind: 'bookmark', _writer: 'worktree:feature-login', _writer_src: 'self' }, createdAt: t - 300 })
    const m = await client(s, 'm')
    const st = parseToolResult(await m.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect(st['scope']).toMatchObject({
      lane: 'main', other_lanes: 2, other_lane_count: 1,
      lanes: [{ lane: 'worktree:feature-login', kind: 'bookmark', age: '5 minutes old', pointers: 2 }],
    })
    await m.close()
    await s.close()
    withRaw((db) => {
      const main = selfLines(db, { worktree: null, branch: 'main', toplevel: '/repo' }, t)
      expect(main.at(-1)).toBe('1 other lane holds a live pointer, not shown here; the most recent: worktree:feature-login (bookmark, 5 minutes old, 2 live pointers). '
        + 'To look: treecontext_status with scope "all", or treecontext_export with writer naming the lane.')
    })
    // Whatever order the pointers come in, the newest names the kind and age.
    const lanes = summarizeLanes([
      { laneKey: 'worktree:x', kind: 'chapter', createdAt: t - 7200 },
      { laneKey: 'worktree:x', kind: 'bookmark', createdAt: t - 300 },
    ])
    expect(lanes).toEqual([{ laneKey: 'worktree:x', lane: 'worktree:x', pointers: 2, newestKind: 'bookmark', newestAt: t - 300 }])
  })

  it('never hands a lane another lane\'s bookmark as its own anchor (D373)', async () => {
    const s = await open()
    const t = Math.floor(Date.now() / 1000)
    // A worktree that left only a bookmark, newer than anything of main's,
    // and a main checkout that holds neither a chapter nor a bookmark.
    const wtBm = (await s.insert('at: the worktree form half wired', { metadata: { next_session: true, kind: 'bookmark', _writer: 'worktree:feature-login', _writer_src: 'self' }, createdAt: t - 60 })).nodeId
    await s.close()
    withRaw((db) => {
      const main = selfLines(db, { worktree: null, branch: 'main', toplevel: '/repo' }, t)
      expect(main[1]).toBe('No chapter summary, bookmark or brief exists for the main lane yet; it starts fresh.')
      expect(main.join('\n')).not.toContain(wtBm)
      expect(main.join('\n')).not.toContain('half wired')
    })
    // The mirror: main's bookmark is never a worktree's anchor.
    const s2 = await open()
    await s2.delete(wtBm)
    const mainBm = (await s2.insert('at: the README half rewritten', { metadata: { next_session: true, kind: 'bookmark', _writer: 'main', _writer_src: 'self' }, createdAt: t - 60 })).nodeId
    await s2.close()
    withRaw((db) => {
      const wt = selfLines(db, { worktree: 'feature-login', branch: 'login-form' }, t)
      expect(wt[1]).toBe('No chapter summary or brief exists for the worktree "feature-login" yet; it starts fresh.')
      expect(wt.join('\n')).not.toContain(mainBm)
      expect(wt.join('\n')).not.toContain('half rewritten')
    })
  })

  it('lists every lane flat for a worker of the ticket door, naming it a worker, never unplaced', async () => {
    const s = await open()
    withRaw((db) => { registerSelf(db, 'm', MAIN, 100); registerSelf(db, 'wt', WT, 100) })
    const m = await client(s, 'm')
    const mainPtr = (await insert(m.c, 'plan: the release', { next_session: true }))['node_id'] as string
    const wt = await client(s, 'wt')
    const wtPtr = (await insert(wt.c, 'plan: the login form', { next_session: true }))['node_id'] as string
    await s.registerWorker({
      sessionId: 'w1', door: 'library',
      ticket: { parent: { id: 'm' }, run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder' },
      process: { pid: 4242, start: 1000, host: 'a-host-that-is-not-this-one' },
    })
    const w = await client(s, 'w1')
    const st = parseToolResult(await w.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((st['resume_pointers'] as Array<{ node_id: string; lane: string }>).map((p) => [p.node_id, p.lane]).sort())
      .toEqual([[mainPtr, 'main'], [wtPtr, 'worktree:feature-login']].sort())
    expect(st['scope']).toEqual({
      listed: "every lane's resume pointers, flat, each naming its lane",
      worker: 'this session is a worker of the ticket door (builder), in no checkout\'s lane: its harness feeds it by its brief and the key lookup, so status lists every lane',
    })
    expect(JSON.stringify(st['scope'])).not.toContain('could not be placed')
    await m.close(); await wt.close(); await w.close()
    await s.close()
  })

  it('lists every lane flat for a session it cannot place, and says so', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 'm', MAIN, 100))
    const m = await client(s, 'm')
    await insert(m.c, 'plan: the release', { next_session: true })
    const u = await client(s, 'nobody')
    const st = parseToolResult(await u.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((st['resume_pointers'] as unknown[]).length).toBe(1)
    expect(st['scope']).toEqual({
      listed: "every lane's resume pointers, flat, each naming its lane",
      unplaced: 'this session could not be placed: no session-start hook registered it in a checkout, so status lists every lane',
    })
    await m.close(); await u.close()
    await s.close()
  })
})

describe('self names (F6, F7)', () => {
  it('disambiguates two worktrees of one name and keeps each name stable', async () => {
    const s = await open()
    await s.close()
    withRaw((db) => {
      expect(registerSelf(db, 'a', { ...WT, toplevel: '/one/feature-login' }, 1)).toBe('feature-login')
      const other = registerSelf(db, 'b', { ...WT, toplevel: '/two/feature-login' }, 2)
      expect(other).toMatch(/^feature-login@[0-9a-f]{6}$/)
      expect(registerSelf(db, 'c', { ...WT, toplevel: '/two/feature-login' }, 3)).toBe(other)
      expect(registerSelf(db, 'd', { ...WT, toplevel: '/one/feature-login' }, 4)).toBe('feature-login')
      expect(worktreeLaneName(db, { ...MAIN })).toBeNull()
    })
  })

  it('reads a detached HEAD as no branch', () => {
    const repo = join(tmpDir, 'repo')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'one'], { cwd: repo, env })
    expect(gitSelfOf(repo).branch).toBe('main')
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo, env })
    expect(gitSelfOf(repo)).toMatchObject({ branch: null, worktree: null })
  })

  it('keeps a subagent type from joining the main or a worktree lane', () => {
    expect(agentWriterOf('main', 'a1')).toBe('agent:main')
    expect(agentWriterOf('worktree:x', 'a1')).toBe('agent:worktree:x')
    expect(agentWriterOf('agent:y', 'a1')).toBe('agent:agent:y')
    // D263: the client's own writer is never a subagent type's.
    expect(agentWriterOf('claude-code', 'a1')).toBe('agent:claude-code')
    expect(agentWriterOf('tester', 'a1')).toBe('tester')
    expect(agentWriterOf(null, 'a1')).toBe('a1')
    expect(laneWriterOf({ _writer: 'agent:main', _writer_agent_id: 'a1' })).toBe('agent:main')
  })
})

describe('the echo heal\'s guards (F-B, F-C, F-F)', () => {
  it('heals only within the window and only from the row\'s own session', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const id = (await insert(c, 'orchestrator: a note'))['node_id'] as string
    const created = withRaw((db) => (db.prepare('SELECT created_at AS t FROM nodes WHERE node_id = ?').get(id) as { t: number }).t)
    const echo = { nodeId: id, echoSessionId: 's1', deduplicated: false, agentId: 'a1', agentType: 'tester' }
    expect(s.store.healWriterFromEcho({ ...echo, echoTs: created + 61 }).outcome).toBe('outside-window')
    expect(s.store.healWriterFromEcho({ ...echo, echoTs: created - 61 }).outcome).toBe('outside-window')
    expect(s.store.healWriterFromEcho({ ...echo, echoSessionId: 's-other', echoTs: created + 1 }).outcome).toBe('other-session')
    expect(meta(id)).toMatchObject({ _writer: 'main', _writer_src: 'self' })
    expect(s.store.healWriterFromEcho({ ...echo, echoTs: created + 59 }).outcome).toBe('corrected')
    expect(meta(id)).toMatchObject({ _writer: 'tester', _writer_src: 'echo', _writer_agent_id: 'a1' })
    expect(s.store.healWriterFromEcho({ ...echo, echoTs: created + 59 }).outcome).toBe('confirmed')
    await close()
    await s.close()
  })

  it('drops a caller\'s supersession trace and heal record', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const id = (await insert(c, 'note', {
      _superseded_prior: { next_session: true }, _supersedes_referenced: ['x'], _writer_heal_retired: ['x'], _writer_heal_unretired: 'x',
    }))['node_id'] as string
    const m = meta(id)
    for (const k of ['_superseded_prior', '_supersedes_referenced', '_writer_heal_retired', '_writer_heal_unretired']) expect(m[k]).toBeUndefined()
    await close()
    await s.close()
  })
})

// ── The lane read (D376, D374): a lane from the registry ────────────────

describe('the undetermined writers\' lane (D376)', () => {
  it('keys `unregistered` apart from main and from the ambiguous lane; an unstamped row stays main\'s', () => {
    expect(laneWriterOf({ _writer_src: 'unregistered' })).toBe(UNKNOWN_LANE)
    expect(laneWriterOf({ _writer_src: 'unregistered', agent_type: 'tester' })).toBe(UNKNOWN_LANE)
    expect(UNKNOWN_LANE).not.toBe(AMBIGUOUS_LANE)
    expect(UNKNOWN_LANE).not.toBe(MAIN_LANE)
    expect(laneWriterOf({})).toBe(MAIN_LANE)
    expect(laneWriterOf({ _cc_session_id: 'old' })).toBe(MAIN_LANE)
    expect(laneLabelOf(UNKNOWN_LANE)).toBe('writer unknown')
    expect(laneLabelOf(MAIN_LANE)).toBe('main')
  })

  it('stamps a caller it cannot place, and its chapters supersede one another and no placed lane\'s', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 'm', MAIN, 100))
    const m = await client(s, 'm')
    const mainChapter = (await insert(m.c, 'plan: the release', { next_session: true }))['node_id'] as string
    const u = await client(s, 'u-unplaced')
    const first = (await insert(u.c, 'plan: the first draft', { next_session: true }))['node_id'] as string
    expect(meta(first)).toMatchObject({ _writer_src: 'unregistered' })
    expect(meta(first)['_writer']).toBeUndefined()
    // Its own lane: the second retires the first.
    const second = await insert(u.c, 'plan: the second draft', { next_session: true }, [first])
    expect(second['superseded']).toEqual([first])
    expect(meta(first)['next_session']).toBeUndefined()
    // Never a placed lane's: main's chapter is referenced, not retired …
    const third = await insert(u.c, 'plan: a third draft', { next_session: true }, [mainChapter])
    expect(third).toMatchObject({ superseded: [], referenced: [mainChapter] })
    expect(meta(mainChapter)['next_session']).toBe(true)
    // … and a placed writer never retires one of them.
    const fromMain = await insert(m.c, 'plan: main takes over', { next_session: true }, [second['node_id'] as string])
    expect(fromMain).toMatchObject({ superseded: [], referenced: [second['node_id']] })
    expect(meta(second['node_id'] as string)['next_session']).toBe(true)
    await m.close(); await u.close()
    await s.close()
  })

  it('an echo of an unplaced session\'s own agent leaves the row undetermined', async () => {
    const s = await open()
    const u = await client(s, 'u-unplaced')
    const id = (await insert(u.c, 'plan: unplaced', { next_session: true }))['node_id'] as string
    const created = withRaw((db) => (db.prepare('SELECT created_at AS t FROM nodes WHERE node_id = ?').get(id) as { t: number }).t)
    expect(s.store.healWriterFromEcho({ nodeId: id, echoSessionId: 'u-unplaced', deduplicated: false, agentId: null, agentType: null, echoTs: created + 1 }).outcome).toBe('confirmed')
    expect(meta(id)).toMatchObject({ _writer_src: 'unregistered' })
    expect(meta(id)['_writer']).toBeUndefined()
    await u.close()
    await s.close()
  })
})

describe('a lane read from the registry (D376, D374)', () => {
  /** A store with every kind of row a lane's read must place:
   *  main session `m` (its own turn, chapter, a subagent's trail and
   *  report, the client's internal summary, an unplaced write), worktree
   *  session `wt` (its own turn from an earlier release, unstamped; its
   *  subagent's report), a worker of `m` (trail and return), an orphan
   *  worker (return), imports by `m`, `wt` and the shell, a session the
   *  registry never held, and an unplaced client's chapter. */
  async function world(): Promise<{ s: FlatStore; ids: Record<string, string> }> {
    const s = await open()
    withRaw((db) => {
      registerSelf(db, 'm', MAIN, 100)
      registerSelf(db, 'wt', WT, 100)
      registerSubagent(db, 'm', 'a1', 'tester', MAIN, 101)
      registerSubagent(db, 'wt', 'a2', 'tester', WT, 101)
      const worker = db.prepare(
        `INSERT INTO session_registry (session_id, agent_id, agent_type, started_at, kind, parent_session) VALUES (?, 'worker', 'doctor-writer', 102, 'worker', ?)`,
      )
      worker.run('w1', 'm')
      worker.run('w-orphan', null)
    })
    const ids: Record<string, string> = {}
    const put = async (name: string, text: string, metadata: Record<string, unknown>): Promise<void> => {
      ids[name] = (await s.insert(text, { metadata, ...(metadata['source'] ? { sourceLabel: String(metadata['source']) } : {}) })).nodeId
    }
    const capture = { source: 'auto-capture', role: 'tool' }
    await put('mainTurn', 'zeta main turn', { ...capture, session_id: 'm' })
    await put('mainChapter', 'zeta main chapter', { session_id: 'm', next_session: true, _writer: 'main', _writer_src: 'self' })
    await put('subTrail', 'zeta tester tool call', { ...capture, session_id: 'm', _writer: 'tester', _writer_agent_id: 'a1', _writer_src: 'hook' })
    await put('subReport', 'zeta tester report', { session_id: 'm', kind: 'subagent-summary', _writer: 'tester', _writer_agent_id: 'a1', _writer_src: 'hook', source: 'auto-capture' })
    await put('internal', 'zeta internal summary', { session_id: 'm', kind: 'internal-summary', _writer: 'claude-code', _writer_agent_id: 'a9', _writer_src: 'hook', source: 'auto-capture' })
    await put('unknownInMain', 'zeta unplaced write in main session', { _cc_session_id: 'm', _writer_src: 'unregistered' })
    await put('wtTurn', 'zeta worktree turn from an earlier release', { ...capture, session_id: 'wt' })
    await put('wtReport', 'zeta worktree tester report', { session_id: 'wt', kind: 'subagent-summary', _writer: 'tester', _writer_agent_id: 'a2', _writer_src: 'hook', source: 'auto-capture' })
    await put('workerTrail', 'zeta worker tool call', { ...capture, session_id: 'w1', _writer: 'doctor-writer', _writer_agent_id: 'worker' })
    await put('workerReturn', 'zeta worker return', { session_id: 'w1', kind: 'subagent-summary', _writer: 'doctor-writer', _writer_agent_id: 'worker', _writer_src: 'declared' })
    await put('orphanReturn', 'zeta orphan return', { session_id: 'w-orphan', kind: 'subagent-summary', _writer: 'doctor-writer', _writer_agent_id: 'worker', _writer_src: 'declared' })
    await put('importByMain', 'zeta imported by main', { session_id: 'handoff:a', _handoff_importer: 'm', _handoff_file: 'a.json' })
    await put('importByShell', 'zeta imported by the shell', { session_id: 'handoff:b', _handoff_importer: 'shell:bing', _handoff_file: 'b.json' })
    await put('importByWt', 'zeta imported by the worktree', { session_id: 'handoff:c', _handoff_importer: 'wt', _handoff_file: 'c.json' })
    await put('neverHeld', 'zeta first release chapter', { _cc_session_id: 'old', next_session: true })
    await put('unknownChapter', 'zeta unplaced chapter', { _cc_session_id: 'u', _writer_src: 'unregistered', next_session: true })
    return { s, ids }
  }
  const pick = (ids: Record<string, string>, names: string[]): string[] => names.map((n) => ids[n]!).sort()
  async function scoped(s: FlatStore, lane?: string): Promise<string[]> {
    const hits = await s.query('zeta', { topK: 100, ...(lane ? { lane } : {}) })
    return hits.map((h) => h.nodeId).sort()
  }

  it('scopes main\'s search to its sessions, its helpers\' reports and imports, never a trail or an undetermined writer', async () => {
    const { s, ids } = await world()
    expect(await scoped(s, 'main')).toEqual(pick(ids, [
      'mainTurn', 'mainChapter', 'subReport', 'internal', 'workerReturn', 'importByMain', 'importByShell', 'neverHeld',
    ]))
    expect(await scoped(s, 'worktree:feature-login')).toEqual(pick(ids, ['wtTurn', 'wtReport', 'importByWt']))
    // The whole store still holds every one of them.
    expect(await scoped(s)).toEqual(Object.values(ids).sort())
    await s.close()
  })

  it('confines the conversation window to the lane', async () => {
    const { s, ids } = await world()
    const hits = await s.query('zeta main chapter', { topK: 1, lane: 'main', conversationWindow: 5 })
    expect(hits[0]!.nodeId).toBe(ids['mainChapter'])
    const around = JSON.stringify(hits[0]!.window ?? [])
    expect(around).toContain(ids['mainTurn']!)
    for (const n of ['subTrail', 'unknownInMain']) expect(around).not.toContain(ids[n]!)
    await s.close()
  })

  it('reads a checkout\'s trail from the registry, the own agent\'s rows only', async () => {
    const { s, ids } = await world()
    const trail = (w: string): string[] => s.writerTrail(w, 100).nodes.map((n) => String(n.nodeId)).sort()
    expect(trail('worktree:feature-login')).toEqual(pick(ids, ['wtTurn']))
    expect(trail('main')).toEqual(pick(ids, ['mainTurn', 'mainChapter', 'neverHeld']))
    // A role's trail is still its stamp.
    expect(trail('tester')).toEqual(pick(ids, ['subTrail', 'subReport', 'wtReport']))
    await s.close()
  })

  it('reaches one hop from the lane\'s own pointers and briefs only, the pointers placed by session (U1-F2, F7)', async () => {
    const { s, ids } = await world()
    // Rows no lane's default search holds of its own: an orphan worker's
    // trail, so only a one-hop reach can bring them in.
    const out = async (name: string, metadata: Record<string, unknown> = {}): Promise<void> => {
      ids[name] = (await s.insert(`kappa ${name}`, { metadata: { session_id: 'w-orphan', _writer: 'doctor-writer', _writer_agent_id: 'worker', ...metadata } })).nodeId
    }
    for (const n of ['mainRefTarget', 'wtRefTarget', 'briefMainTarget']) await out(n)
    await out('briefMain', { brief_for: 'main', refs: [ids['briefMainTarget']] })
    await out('briefWt', { brief_for: 'feature-login' })
    // Main's live plan names its target; the worktree's chapter from an
    // earlier release carries no stamp at all and sits in the worktree's
    // session: it is the worktree's by the registry, never main's by its
    // missing stamp.
    ids['mainPlan'] = (await s.insert('kappa main plan', { metadata: { session_id: 'm', next_session: true, _writer: 'main', _writer_src: 'self', refs: [ids['mainRefTarget']] } })).nodeId
    ids['wtPlan'] = (await s.insert('kappa worktree plan', { metadata: { session_id: 'wt', next_session: true, refs: [ids['wtRefTarget']] } })).nodeId
    const mainReach = s.laneReferencedIds('main')
    const wtReach = s.laneReferencedIds('worktree:feature-login')
    for (const n of ['mainRefTarget', 'briefMain', 'briefMainTarget']) {
      expect(mainReach, n).toContain(ids[n])
      expect(wtReach, n).not.toContain(ids[n])
    }
    for (const n of ['wtRefTarget', 'briefWt']) {
      expect(wtReach, n).toContain(ids[n])
      expect(mainReach, n).not.toContain(ids[n])
    }
    const kappa = async (lane: string): Promise<string[]> => (await s.query('kappa', { topK: 100, lane })).map((h) => h.nodeId).sort()
    expect(await kappa('main')).toEqual(pick(ids, ['mainRefTarget', 'briefMain', 'briefMainTarget', 'mainPlan']))
    expect(await kappa('worktree:feature-login')).toEqual(pick(ids, ['wtRefTarget', 'briefWt', 'wtPlan']))
    await s.close()
  })

  it('keeps a seat for the lane\'s own live chapter that the search matched, never first by rule (D374)', async () => {
    const { s, ids } = await world()
    const t0 = Date.now() / 1000
    ids['oldPlan'] = (await s.insert('omega plan: rewrite the install section', { metadata: { session_id: 'm', next_session: true, _writer: 'main', _writer_src: 'self' }, createdAt: t0 - 3600 })).nodeId
    // Newer rows of the lane's own session that match more of the words.
    for (let i = 0; i < 6; i++) {
      ids[`turn${i}`] = (await s.insert(`omega next step ${i}: the doctor table rows`, { metadata: { source: 'auto-capture', role: 'user', session_id: 'm' }, sourceLabel: 'auto-capture', createdAt: t0 - 60 + i })).nodeId
    }
    const q = 'omega next step the doctor table'
    const whole = await s.query(q, { topK: 3, recencyWeight: 0.25 })
    expect(whole.map((h) => h.nodeId)).not.toContain(ids['oldPlan'])
    const own = await s.query(q, { topK: 3, recencyWeight: 0.25, lane: 'main' })
    expect(own).toHaveLength(3)
    expect(own.map((h) => h.nodeId)).toEqual([...whole.slice(0, 2).map((h) => h.nodeId), ids['oldPlan']])
    // A temporal listing is not a relevance page: no seat. Asked with the
    // placement left on, so the listing itself is what keeps it out.
    // A namespace exclusion widens the candidate pool past the page, so the
    // chapter is among the candidates the listing reads.
    const listed = await s.query(q, { topK: 3, lane: 'main', sortBy: 'reverse_chronological', excludeNamespaces: ['elsewhere'] })
    expect(listed).toHaveLength(3)
    expect(listed.map((h) => h.nodeId)).not.toContain(ids['oldPlan'])
    await s.close()
  })

  it('seats the own chapter on a page of two or more places only, last, within the filters, changing no score or count (D374, U3-F1, F2)', async () => {
    const { s, ids } = await world()
    const t0 = Date.now() / 1000
    ids['oldPlan'] = (await s.insert('omega plan: rewrite the install section', { metadata: { session_id: 'm', next_session: true, _writer: 'main', _writer_src: 'self' }, createdAt: t0 - 3600 })).nodeId
    for (let i = 0; i < 6; i++) {
      ids[`turn${i}`] = (await s.insert(`omega next step ${i}: the doctor table rows`, { metadata: { source: 'auto-capture', role: 'user', session_id: 'm' }, sourceLabel: 'auto-capture', createdAt: t0 - 60 + i })).nodeId
    }
    const q = 'omega next step the doctor table'
    const fused = { recencyWeight: 0.25 }
    const wide = await s.query(q, { topK: 100, ...fused, lane: 'main' })
    const scoreOf = new Map(wide.map((h) => [h.nodeId, h.similarity]))
    expect(wide.map((h) => h.nodeId)).toContain(ids['oldPlan'])
    // A page of one place: the best hit keeps it, never the chapter.
    const one = await s.query(q, { topK: 1, ...fused, lane: 'main' })
    expect(one.map((h) => h.nodeId)).toEqual([wide[0]!.nodeId])
    expect(one[0]!.nodeId).not.toBe(ids['oldPlan'])
    // A page of two: the chapter takes the second place, never the first.
    const two = await s.query(q, { topK: 2, ...fused, lane: 'main' })
    expect(two.map((h) => h.nodeId)).toEqual([wide[0]!.nodeId, ids['oldPlan']])
    // No score changes: every hit, the seated chapter too, keeps the score
    // it has on a page wide enough to hold it without a seat.
    for (const h of two) expect(h.similarity, h.nodeId).toBe(scoreOf.get(h.nodeId))
    // No count changes, under the adaptive count as well.
    let returnedK = -1
    const adaptive = await s.query(q, { topK: 3, ...fused, lane: 'main', adaptive: true, onAdaptive: (a) => { returnedK = a.returnedK } })
    expect(adaptive).toHaveLength(returnedK)
    expect(adaptive.map((h) => h.nodeId)).toContain(ids['oldPlan'])
    expect(adaptive[0]!.nodeId).not.toBe(ids['oldPlan'])
    // Never past the filters: a metadata filter or a time range that
    // leaves the chapter out leaves it out of the page too.
    const filtered = await s.query(q, { topK: 3, ...fused, lane: 'main', metadataFilter: { role: 'user' } })
    expect(filtered).toHaveLength(3)
    expect(filtered.map((h) => h.nodeId)).not.toContain(ids['oldPlan'])
    const recent = await s.query(q, { topK: 3, ...fused, lane: 'main', timeRange: { after: t0 - 120 } })
    expect(recent).toHaveLength(3)
    expect(recent.map((h) => h.nodeId)).not.toContain(ids['oldPlan'])
    await s.close()
  })

  it('searches the whole store for a session no hook placed, the reply saying so (D374, U3-F4)', async () => {
    const { s, ids } = await world()
    // A hookless client with a session id: the registry never held it.
    const { c, close } = await client(s, 'ghost')
    const q = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'zeta worktree turn', top_k: 20 } }))
    expect(q['scope']).toEqual({
      searched: 'the whole store',
      unplaced: 'this session could not be placed: no session-start hook registered it in a checkout, so the search covers the whole store',
    })
    const hit = (q['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    // A worktree's row and a helper's trail, outside main's lane: the
    // unplaced caller is never folded into main.
    expect(hit).toContain(ids['wtTurn'])
    expect(hit).toContain(ids['subTrail'])
    await close()
    await s.close()
  })

  it('keeps a writer-unknown chapter out of main\'s default search and its windows, found by asking for the whole store (D374, D376, U3-F6)', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 'm', MAIN, 100))
    // A hookless client the server cannot place writes its chapter
    // through the tools: the store stamps it `unregistered`.
    const u = await client(s, 'hookless')
    const written = await insert(u.c, 'plan: psi migrate the doctor table', { next_session: true })
    await u.close()
    const id = written['node_id'] as string
    expect(meta(id)).toMatchObject({ _writer_src: 'unregistered' })
    // Main's own turn in its session, the same words, for the window.
    s.store.insertStaging({ sessionId: 'm', role: 'user', content: 'psi the doctor table next', timestamp: Date.now() / 1000 })
    const { IngestionLoop } = await import('../src/server/ingestion.js')
    await new IngestionLoop(s).ingestBatch()
    const { c, close } = await client(s, 'm')
    const own = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'psi doctor table', top_k: 10, conversation_window: 3 } }))
    expect(own['scope']).toMatchObject({ lane: 'main' })
    const ownIds = (own['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    expect(ownIds.length).toBeGreaterThan(0)
    expect(ownIds).not.toContain(id)
    expect(JSON.stringify(own['results'])).not.toContain(id)
    const all = parseToolResult(await c.callTool({ name: 'treecontext_query', arguments: { query: 'psi doctor table', top_k: 10, scope: 'all' } }))
    expect((all['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)).toContain(id)
    await close()
    await s.close()
  })

  it('places a session from its self registration', async () => {
    const { s } = await world()
    expect(s.placedLaneOf('m')).toBe('main')
    expect(s.placedLaneOf('wt')).toBe('worktree:feature-login')
    expect(s.placedLaneOf('w1')).toBeNull()
    expect(s.placedLaneOf('u')).toBeNull()
    expect(s.placedLaneOf(null)).toBeNull()
    await s.close()
  })
})
