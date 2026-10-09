/**
 * The shared-session hazard beyond the single-live case (F1, F2, F3 of
 * the chunk-5b review; D240, D241): charter-adjacent, through the real
 * hooks and the production drain, over the real MCP tools of ONE session
 * client — the orchestrator's calls and its subagents' alike.
 *
 * The reviewer's reproduction: with one background subagent live, the
 * orchestrator's chapter was stamped as the subagent's, did not retire
 * its old chapter, its bookmark hid behind the subagent filter, and its
 * search came back confined to the subagent's lane. Here the session runs
 * as Claude Code runs a background spawn: SubagentStart, then at once the
 * main agent's own PostToolUse for the Agent tool (the spawn returns while
 * the subagent works) — the evidence that the orchestrator is active
 * beside it. Every insert fires its own PostToolUse echo, carrying the
 * caller's agent fields when a subagent made the call.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { runHook, hookJson, drainStaging, bashPayload } from './journal/capture-harness.js'
import { openWorld, toolEntry, now, clear, type ReorientationWorld } from './journal/steps/journal-reorientation.steps.js'
import { mcpOver, parseTool, rawAll } from './journal/world.js'

type W = ReorientationWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }

const sessionStart = (w: W, source = 'startup'): string => {
  const r = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source })
  return String(((hookJson(r.stdout)?.['hookSpecificOutput']) as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}
const subagentStart = (w: W, id: string, type: string): void => {
  runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: id, agent_type: type })
}
const subagentStop = (w: W, id: string, type: string, msg: string): void => {
  runHook(w, 'subagent-stop', { hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, stop_hook_active: false, last_assistant_message: msg })
}
/** The main agent's own PostToolUse for the Agent tool of a background
 *  spawn: it returns at once, while the subagent works. */
const backgroundSpawnReturns = (w: W, type: string): void => {
  runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'Agent', tool_input: { subagent_type: type, description: 'explore', prompt: 'explore the widget code', run_in_background: true },
    tool_response: { status: 'async_launched', message: 'Agent launched in the background.' },
  })
}
async function client(w: W): Promise<void> {
  await mcpOver(w, { ccSessionId: w.sessionId! })
  w.clientSession = w.sessionId!
}
/** An insert through the tools and its PostToolUse echo, with the caller's
 *  agent fields when a subagent made the call. */
async function insert(
  w: W, who: { id: string; type: string } | null, content: string, metadata: Record<string, unknown>, supersedes?: string[],
): Promise<Record<string, unknown>> {
  const input = { content, metadata, ...(supersedes ? { supersedes } : {}) }
  const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
  runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'mcp__treecontext__treecontext_insert', tool_input: input, tool_response: (res as { content: unknown }).content,
    ...(who ? { agent_id: who.id, agent_type: who.type } : {}),
  })
  return parseTool(res)
}
const meta = (w: W, id: string): Record<string, unknown> =>
  JSON.parse(rawAll<{ m: string }>(w, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
async function livePointers(w: W): Promise<string[]> {
  const st = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
  return ((st['resume_pointers'] as Array<{ node_id: string }> | undefined) ?? []).map((p) => p.node_id)
}

describe('a background subagent beside its orchestrator (F1, D240)', () => {
  it('keeps the orchestrator\'s chapter, bookmark and search its own, and the echo puts the subagent\'s note in its lane', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const c0 = (await insert(w, null, 'plan: ship widget v1; next: write widget docs', { next_session: true }))['node_id'] as string
      const b0 = (await insert(w, null, 'bookmark: widget docs half written', { kind: 'bookmark' }))['node_id'] as string
      for (let i = 0; i < 30; i++) await toolEntry(w, `orchestrator widget step ${i}: reviewed widget module`, now() - 3600 + i)
      await drainStaging(w)

      const explore = { id: 'agent-bg1', type: 'Explore' }
      subagentStart(w, explore.id, explore.type)
      backgroundSpawnReturns(w, explore.type)
      for (let i = 0; i < 3; i++) {
        runHook(w, 'post-tool-use', { ...bashPayload(w, `grep -rn widget src # ${i}`, `src/widget-${i}.ts: widget found by the explorer`), agent_id: explore.id, agent_type: explore.type })
      }

      // The orchestrator, working beside it: its chapter retires its old one.
      const c1r = await insert(w, null, 'plan: ship widget v2; next: benchmark widget', { next_session: true }, [c0])
      expect(c1r).toMatchObject({ writer: 'main', writer_src: 'concurrent', superseded: [c0] })
      expect(String(c1r['writer_note'])).toMatch(/active since it started/)
      expect(c1r['writer_candidates']).toEqual([{ agent_id: explore.id, agent_type: explore.type }])
      const c1 = c1r['node_id'] as string
      // …its bookmark retires its own previous one, in its own lane.
      const b1r = await insert(w, null, 'bookmark: widget v2 benchmark running', { kind: 'bookmark' })
      expect(b1r).toMatchObject({ writer: 'main', writer_src: 'concurrent' })
      const b1 = b1r['node_id'] as string
      expect(meta(w, b0)['next_session']).toBeUndefined()
      // …and its search is the whole store, saying why.
      const q = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'widget', top_k: 10 } }))
      expect(q['scope']).toMatchObject({ searched: 'the whole store' })
      expect(String((q['scope'] as Record<string, unknown>)['why'])).toMatch(/active beside it/)
      const contents = (q['results'] as Array<{ content: string }>).map((r) => r.content)
      expect(contents.filter((c) => c.startsWith('orchestrator widget step')).length).toBeGreaterThan(3)

      // The explorer, meanwhile, supersedes the new chapter. At insert the
      // store reads the call as the orchestrator's (concurrent) and retires
      // C1; the call's own echo names the explorer, and the drain's heal
      // puts C1 back and records it as a reference.
      const er = await insert(w, explore, 'plan: widget v2 is blocked on the cache layer; next: map the cache', { next_session: true }, [c1])
      expect(er).toMatchObject({ writer: 'main', writer_src: 'concurrent', superseded: [c1] })
      const e = er['node_id'] as string
      expect(await livePointers(w)).not.toContain(c1)

      subagentStop(w, explore.id, explore.type, 'mapped the widget code')
      await drainStaging(w)

      expect(meta(w, c1)).toMatchObject({ _writer: 'main', _writer_src: 'echo', next_session: true })
      expect(meta(w, c1)['superseded_by']).toBeUndefined()
      expect(meta(w, b1)).toMatchObject({ _writer: 'main', _writer_src: 'echo', next_session: true })
      const em = meta(w, e)
      expect(em).toMatchObject({
        _writer: 'Explore', _writer_src: 'echo', _writer_agent_id: explore.id,
        _writer_stamped: { writer: 'main', src: 'concurrent' }, _writer_heal_reverted: [c1], refs: [c1],
      })
      expect(String(em['_writer_heal_note'])).toMatch(/restored and recorded as references/)
      const live = await livePointers(w)
      expect(live).toContain(c1)
      expect(live).not.toContain(c0)
      expect(live).toContain(b1)
      expect(live).not.toContain(b0)
      // The reverse index follows the restored reference.
      expect(rawAll(w, 'SELECT node_id FROM node_refs WHERE ref_id = ?', c1)).toEqual([{ node_id: e }])

      // After a /clear the orchestrator's own chapter and bookmark come back,
      // the explorer's entry under the chapter's referenced-by.
      const packet = clear(w)
      const lines = packet.split('\n')
      const at = lines.findIndex((l) => l.startsWith('Chapter summary,') && l.includes(`(id ${c1})`))
      expect(at, packet).toBeGreaterThanOrEqual(0)
      expect(lines[at + 1]).toMatch(new RegExp(`^ {2}referenced by: ${e}, Explore, `))
      expect(packet).toMatch(new RegExp(`Bookmark, \\d+ minutes? old \\(id ${b1}\\)`))
    } finally { await done(w) }
  }, 120_000)

  it('a provisional stamp the echo moves INTO the self lane performs the supersession it asked for (F-D)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const c0 = (await insert(w, null, 'plan: the gadget; next: test it', { next_session: true }))['node_id'] as string
      await drainStaging(w)
      // A subagent is live and the orchestrator has been silent since — the
      // registry reads the next call as the subagent's (the spawn's own
      // PostToolUse arriving late, say).
      subagentStart(w, 'agent-q', 'tester')
      const r = await insert(w, null, 'plan: the gadget v2; next: ship it', { next_session: true }, [c0])
      expect(r).toMatchObject({ writer: 'tester', writer_src: 'provisional', superseded: [], referenced: [c0] })
      expect(meta(w, c0)['next_session']).toBe(true)
      subagentStop(w, 'agent-q', 'tester', 'done')
      await drainStaging(w)
      const m = meta(w, r['node_id'] as string)
      expect(m).toMatchObject({ _writer: 'main', _writer_src: 'echo', refs: [c0], _writer_stamped: { writer: 'tester', src: 'provisional' }, _writer_heal_retired: [c0], _supersedes_referenced: [] })
      expect(m['_writer_agent_id']).toBeUndefined()
      expect(String(m['_writer_heal_note'])).toMatch(/asked to supersede in its own lane is retired now/)
      expect(meta(w, c0)).toMatchObject({ superseded_by: r['node_id'], _superseded_prior: { next_session: true } })
      expect(meta(w, c0)['next_session']).toBeUndefined()
      expect(await livePointers(w)).toEqual([r['node_id']])
    } finally { await done(w) }
  }, 120_000)

  it('P1: a subagent bookmark that was retired under a wrong stamp comes back in its own lane, and main keeps one live bookmark (F-A)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const b0 = (await insert(w, null, 'bookmark: orchestrator at the parser', { kind: 'bookmark' }))['node_id'] as string
      await drainStaging(w)
      const ex = { id: 'agent-p1', type: 'Explore' }
      subagentStart(w, ex.id, ex.type)
      backgroundSpawnReturns(w, ex.type)
      // The explorer's bookmark, read as the orchestrator's: it retires B0.
      const e = (await insert(w, ex, 'bookmark: explorer mapping the cache', { kind: 'bookmark' }))['node_id'] as string
      expect(meta(w, b0)['superseded_by']).toBe(e)
      // Before the drain the orchestrator's next bookmark retires E, then in its lane.
      const b2 = (await insert(w, null, 'bookmark: orchestrator at the lexer', { kind: 'bookmark' }))['node_id'] as string
      expect(meta(w, e)['superseded_by']).toBe(b2)
      subagentStop(w, ex.id, ex.type, 'mapped')
      await drainStaging(w)
      // E is the explorer's, live in its own lane; its retirement by B2 is a reference on B2.
      expect(meta(w, e)).toMatchObject({ _writer: 'Explore', _writer_src: 'echo', next_session: true, _writer_heal_unretired: b2, _writer_heal_reverted: [b0] })
      expect(meta(w, e)['superseded_by']).toBeUndefined()
      expect(meta(w, b2)).toMatchObject({ _writer: 'main', next_session: true, refs: [e] })
      // B0 comes back retired by the newer main bookmark, not live: one live per session per lane.
      expect(meta(w, b0)).toMatchObject({ superseded_by: b2 })
      expect(meta(w, b0)['next_session']).toBeUndefined()
      const liveBookmarks = rawAll<{ node_id: string; m: string }>(w,
        "SELECT node_id, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'bookmark' AND json_extract(metadata_json, '$.next_session') = 1")
      expect(liveBookmarks.map((r) => r.node_id).sort()).toEqual([b2, e].sort())
      // Idempotent: the same echoes drained again change nothing.
      const before = rawAll(w, "SELECT node_id, metadata_json, updated_at FROM nodes WHERE dedup_class != 'auto' ORDER BY node_id")
      const raw = new BetterSqlite3(w.dbPath!)
      try { raw.prepare("UPDATE staging SET processed = 0, claimed_by = NULL WHERE tool_name = 'mcp__treecontext__treecontext_insert'").run() } finally { raw.close() }
      await drainStaging(w)
      expect(rawAll(w, "SELECT node_id, metadata_json, updated_at FROM nodes WHERE dedup_class != 'auto' ORDER BY node_id")).toEqual(before)
    } finally { await done(w) }
  }, 120_000)

  it('P12: a subagent chapter the orchestrator superseded under a wrong stamp stays the subagent\'s live pointer (F-A)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const c0 = (await insert(w, null, 'plan: the parser; next: the lexer', { next_session: true }))['node_id'] as string
      await drainStaging(w)
      const t = { id: 'agent-p12', type: 'tester' }
      subagentStart(w, t.id, t.type)
      backgroundSpawnReturns(w, t.type)
      const e = (await insert(w, t, 'plan: test the parser; next: fuzz it', { next_session: true }))['node_id'] as string
      const c1r = await insert(w, null, 'plan: the lexer; next: the printer', { next_session: true }, [c0, e])
      expect(c1r['superseded']).toEqual([c0, e])
      const c1 = c1r['node_id'] as string
      subagentStop(w, t.id, t.type, 'tested')
      await drainStaging(w)
      expect(meta(w, e)).toMatchObject({ _writer: 'tester', _writer_src: 'echo', next_session: true, _writer_heal_unretired: c1 })
      expect(meta(w, e)['superseded_by']).toBeUndefined()
      expect(String(meta(w, e)['_writer_heal_note'])).toMatch(/its retirement by [0-9a-f]+, another lane's, was undone/)
      expect(meta(w, c1)).toMatchObject({ next_session: true, refs: [e] })
      expect(meta(w, c0)).toMatchObject({ superseded_by: c1 })
      expect((await livePointers(w)).sort()).toEqual([c1, e].sort())
    } finally { await done(w) }
  }, 120_000)

  it('a target retired twice keeps its first retirement when the second is undone, and a status pointer comes back active (F-A(c), F-B)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const c0 = (await insert(w, null, 'plan: v1', { next_session: true }))['node_id'] as string
      const c1 = (await insert(w, null, 'plan: v2', { next_session: true }, [c0]))['node_id'] as string
      const act = (await insert(w, null, 'thread: the migration is in flight', { status: 'active' }))['node_id'] as string
      await drainStaging(w)
      const t = { id: 'agent-cc', type: 'tester' }
      subagentStart(w, t.id, t.type)
      backgroundSpawnReturns(w, t.type)
      const r = (await insert(w, t, 'tester: v1 and the migration thread are obsolete', {}, [c0, act]))['node_id'] as string
      expect(meta(w, c0)).toMatchObject({ superseded_by: r, _superseded_prior: { superseded_by: c1, prior: { next_session: true } } })
      expect(meta(w, act)['status']).toBe('superseded')
      subagentStop(w, t.id, t.type, 'done')
      await drainStaging(w)
      expect(meta(w, c0)).toMatchObject({ superseded_by: c1, _superseded_prior: { next_session: true } })
      expect(meta(w, c0)['next_session']).toBeUndefined()
      expect(meta(w, act)).toMatchObject({ status: 'active' })
      expect(meta(w, act)['superseded_by']).toBeUndefined()
      expect(meta(w, r)).toMatchObject({ _writer: 'tester', _writer_heal_reverted: [c0, act] })
    } finally { await done(w) }
  }, 120_000)

  it('a subagent\'s deduplicated echo of the orchestrator\'s row never moves it (F-B)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const x = (await insert(w, null, 'decision: the cache is per request', { next_session: true }))['node_id'] as string
      await drainStaging(w)
      const t = { id: 'agent-dd', type: 'tester' }
      subagentStart(w, t.id, t.type)
      const again = await insert(w, t, 'decision: the cache is per request', { next_session: true })
      expect(again).toMatchObject({ node_id: x, deduplicated: true })
      subagentStop(w, t.id, t.type, 'done')
      await drainStaging(w)
      expect(meta(w, x)).toMatchObject({ _writer: 'main', _writer_src: 'echo' })
      expect(meta(w, x)['_writer_agent_id']).toBeUndefined()
    } finally { await done(w) }
  }, 120_000)
})

describe('bookmarks per session per lane (F2, D241)', () => {
  it('a subagent\'s bookmark never retires the orchestrator\'s, and the packet still shows the orchestrator\'s', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const b0 = (await insert(w, null, 'bookmark: orchestrator mid-refactor of the parser', { kind: 'bookmark' }))['node_id'] as string
      await drainStaging(w)
      subagentStart(w, 'agent-t1', 'tester')
      const tb = await insert(w, { id: 'agent-t1', type: 'tester' }, 'bookmark: tester halfway through the suite', { kind: 'bookmark' })
      expect(tb).toMatchObject({ writer: 'tester', writer_src: 'provisional' })
      expect(meta(w, b0)['next_session']).toBe(true)
      // The tester's second bookmark retires its own first one, not the orchestrator's.
      const tb2 = await insert(w, { id: 'agent-t1', type: 'tester' }, 'bookmark: tester through the suite', { kind: 'bookmark' })
      subagentStop(w, 'agent-t1', 'tester', 'suite done')
      await drainStaging(w)
      expect(meta(w, tb['node_id'] as string)['superseded_by']).toBe(tb2['node_id'])
      expect(meta(w, b0)['next_session']).toBe(true)
      const packet = clear(w)
      expect(packet).toMatch(new RegExp(`Bookmark, \\d+ minutes? old \\(id ${b0}\\)`))
      expect(packet).not.toContain(tb2['node_id'] as string)
    } finally { await done(w) }
  }, 120_000)
})

describe('no subagent survives its session\'s restart (F3)', () => {
  it('a compact retires none, and a /clear retires the predecessor\'s (F-B)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const first = w.sessionId!
      subagentStart(w, 'agent-c', 'tester')
      sessionStart(w, 'compact')
      expect(rawAll(w, 'SELECT stopped_at FROM session_registry WHERE agent_id = ?', 'agent-c')).toEqual([{ stopped_at: null }])
      clear(w)
      expect(w.sessionId).not.toBe(first)
      const [row] = rawAll<{ session_id: string; stopped_at: number | null }>(w, 'SELECT session_id, stopped_at FROM session_registry WHERE agent_id = ?', 'agent-c')
      expect(row!.session_id).toBe(first)
      expect(row!.stopped_at).not.toBeNull()
    } finally { await done(w) }
  }, 120_000)

  it('a resume retires a subagent whose stop never came, and the next note is the self\'s', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      subagentStart(w, 'agent-lost', 'tester')
      expect(rawAll(w, 'SELECT stopped_at FROM session_registry WHERE agent_id = ?', 'agent-lost')).toEqual([{ stopped_at: null }])
      sessionStart(w, 'resume')
      const [row] = rawAll<{ stopped_at: number | null }>(w, 'SELECT stopped_at FROM session_registry WHERE agent_id = ?', 'agent-lost')
      expect(row!.stopped_at).not.toBeNull()
      const r = await insert(w, null, 'orchestrator note after the resume', {})
      expect(r).toMatchObject({ writer: 'main', writer_src: 'self' })
    } finally { await done(w) }
  }, 120_000)
})
