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
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import { laneWriterOf, MAIN_LANE, AMBIGUOUS_LANE } from '../src/references.js'
import {
  registerSelf, registerSubagent, retireSubagent, resolveWriter, liveSubagents, type GitSelf,
} from '../src/persistence/session-registry.js'
import { parseToolResult } from './helpers/mcp-result.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-registry-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'registry.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path())), retentionInterval: 1_000_000 })
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }
const WT: GitSelf = { worktree: 'feature-login', branch: 'login-form', cwd: '/feature-login', toplevel: '/feature-login', commonDir: '/repo/.git' }

function withRaw<T>(fn: (db: BetterSqlite3.Database) => T): T {
  const raw = new BetterSqlite3(path())
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
  it('stamps the self, drops a caller-claimed stamp, and stays silent for an unregistered session', async () => {
    const s = await open()
    withRaw((db) => registerSelf(db, 's1', MAIN, 100))
    const { c, close } = await client(s, 's1')
    const r = await insert(c, 'orchestrator note', { _writer: 'tester', _writer_src: 'registry', _worktree: 'elsewhere' })
    expect(r).toMatchObject({ writer: 'main', writer_src: 'self' })
    expect(meta(r['node_id'] as string)).toMatchObject({ _writer: 'main', _writer_src: 'self', _branch: 'main' })
    expect(meta(r['node_id'] as string)['_worktree']).toBeUndefined()
    await close()
    const other = await client(s, 's-unknown')
    const u = await insert(other.c, 'a note from a session no hook registered', { _writer: 'tester' })
    expect(u['writer']).toBeUndefined()
    expect(meta(u['node_id'] as string)['_writer']).toBeUndefined()
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
import { worktreeSelfLines } from '../src/checkpoints.js'
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

describe('the worktree packet lines (F4, F7)', () => {
  it('pins the lines, and an ambiguous row is never the worktree\'s own chapter', async () => {
    const s = await open()
    const own = (await s.insert('plan: wire the login form', { metadata: { next_session: true, _writer: 'worktree:feature-login', _writer_src: 'self' } })).nodeId
    await s.insert('plan: a guess', { metadata: { next_session: true, _writer: 'worktree:feature-x', _writer_src: 'ambiguous' } })
    await s.insert('build the search box', { metadata: { brief_for: 'feature-search', _writer: 'main', _writer_src: 'self' } })
    await s.close()
    const db = new BetterSqlite3(path())
    try {
      const at = Date.now() / 1000
      const login = worktreeSelfLines(db, { worktree: 'feature-login', branch: 'login-form' }, at)
      expect(login[0]).toBe('This session runs in the worktree "feature-login" on the branch "login-form"; it re-orients on that worktree\'s own thread.')
      expect(login[1]).toMatch(new RegExp(`^The worktree's own chapter summary, 0 minutes old \\(id ${own}\\): plan: wire the login form$`))
      expect(login[2]).toBe('  referenced by: none')
      expect(login).toHaveLength(3)
      const search = worktreeSelfLines(db, { worktree: 'feature-search', branch: null }, at)
      expect(search[0]).toBe('This session runs in the worktree "feature-search"; it re-orients on that worktree\'s own thread.')
      expect(search[1]).toMatch(/^Brief for this worktree from main, 0 minutes old \(id [0-9a-f]+\): build the search box$/)
      expect(search[2]).toBe('The worktree "feature-search" has no chapter summary of its own yet; it starts from the brief.')
      expect(worktreeSelfLines(db, { worktree: 'feature-x', branch: null }, at)[1])
        .toBe('No chapter summary or brief exists for the worktree "feature-x" yet; it starts fresh.')
      expect(worktreeSelfLines(db, { worktree: null, branch: 'main' }, at)).toEqual([])
    } finally { db.close() }
  })
})

describe('status in a worktree lists its own lane (F5, D242)', () => {
  it('confines the pointers with a scope disclosure; scope "all" and the main checkout list every lane', async () => {
    const s = await open()
    withRaw((db) => { registerSelf(db, 'wt', WT, 100); registerSelf(db, 'm', MAIN, 100) })
    const wt = await client(s, 'wt')
    const own = (await insert(wt.c, 'plan: the login form', { next_session: true }))['node_id'] as string
    const m = await client(s, 'm')
    const mainPtr = (await insert(m.c, 'plan: the release', { next_session: true }))['node_id'] as string
    await s.insert('plan: an older unstamped pointer', { metadata: { next_session: true } })
    const st = parseToolResult(await wt.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((st['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toEqual([own])
    expect(st['scope']).toEqual({
      lane: 'worktree:feature-login', listed: "the resume pointers of this worktree's own lane (worktree:feature-login)",
      other_lanes: 2, widen: 'pass scope "all" to list every lane\'s pointers',
    })
    const every = parseToolResult(await wt.c.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
    expect((every['resume_pointers'] as unknown[]).length).toBe(3)
    expect(every['scope']).toBeUndefined()
    const ms = parseToolResult(await m.c.callTool({ name: 'treecontext_status', arguments: {} }))
    expect((ms['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toContain(mainPtr)
    expect((ms['resume_pointers'] as unknown[]).length).toBe(3)
    expect(ms['scope']).toBeUndefined()
    await wt.close(); await m.close()
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
