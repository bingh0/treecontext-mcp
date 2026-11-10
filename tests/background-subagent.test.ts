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
import { DatabaseSync } from 'node:sqlite'
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
/** Every live pointer of the store, whichever lane holds it: status asked
 *  for every lane (D372 scopes the main checkout's own status to its lane). */
async function livePointers(w: W): Promise<string[]> {
  const st = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
  return ((st['resume_pointers'] as Array<{ node_id: string }> | undefined) ?? []).map((p) => p.node_id)
}

/** Status as the session asks for it, no scope given. */
async function defaultStatus(w: W): Promise<{ scope: Record<string, unknown> | undefined; ids: string[] }> {
  const st = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
  return {
    scope: st['scope'] as Record<string, unknown> | undefined,
    ids: ((st['resume_pointers'] as Array<{ node_id: string }> | undefined) ?? []).map((p) => p.node_id),
  }
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
      // D372: a session whose caller cannot be told apart from the live
      // subagent is scoped to its self as before: the main lane's own.
      const during = await defaultStatus(w)
      expect(during.scope).toMatchObject({ lane: 'main' })
      expect(during.ids).toEqual(expect.arrayContaining([c1, b1]))
      expect(during.ids).not.toContain(c0)
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
      // The default status, scoped to the session's self: its chapter and
      // bookmark, never the explorer's chapter the heal moved to its lane.
      const after = await defaultStatus(w)
      expect(after.scope).toMatchObject({ lane: 'main' })
      expect(after.ids).toEqual(expect.arrayContaining([c1, b1]))
      expect(after.ids).not.toContain(e)
      expect(live).toContain(e)
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
      // D420: held as pending on the new entry, never reported as another
      // writer's, until the echo names the writer.
      expect(r).toMatchObject({ writer: 'tester', writer_src: 'provisional', superseded: [] })
      expect(r['referenced']).toBeUndefined()
      expect((r['supersession_pending'] as Array<{ node_id: string }>).map((p) => p.node_id)).toEqual([c0])
      expect(meta(w, r['node_id'] as string)['_supersedes_pending']).toEqual([c0])
      expect(meta(w, c0)['next_session']).toBe(true)
      subagentStop(w, 'agent-q', 'tester', 'done')
      await drainStaging(w)
      const m = meta(w, r['node_id'] as string)
      expect(m).toMatchObject({ _writer: 'main', _writer_src: 'echo', _writer_stamped: { writer: 'tester', src: 'provisional' }, _writer_heal_retired: [c0] })
      expect(m['_supersedes_pending']).toBeUndefined()
      expect(m['_writer_agent_id']).toBeUndefined()
      expect(String(m['_supersedes_pending_note'])).toMatch(/its echo names main: retired /)
      expect(meta(w, c0)).toMatchObject({ superseded_by: r['node_id'], _superseded_prior: { next_session: true } })
      expect(meta(w, c0)['next_session']).toBeUndefined()
      expect(await livePointers(w)).toEqual([r['node_id']])
    } finally { await done(w) }
  }, 120_000)

  // ── D241 with D420: one live bookmark per session per lane, whichever
  // echo drains first (review F1 of c3c81aa, F2 of c88424d). Each insert
  // goes through the real tool; its PostToolUse echo is staged by the real
  // hook in the order the case names, then the production drain runs.
  // A bookmark settles D241 in its lane when its own echo makes its stamp
  // exact, never in favour of one whose stamp is not exact yet.
  type Call = { who: { id: string; type: string } | null; input: Record<string, unknown>; res: unknown; id: string; reply: Record<string, unknown> }
  async function call(w: W, who: Call['who'], content: string, supersedes?: string[]): Promise<Call> {
    const input = { content, metadata: { kind: 'bookmark' }, ...(supersedes ? { supersedes } : {}) }
    const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
    const reply = parseTool(res)
    return { who, input, res: (res as { content: unknown }).content, id: reply['node_id'] as string, reply }
  }
  function stageEcho(w: W, c: Call): void {
    runHook(w, 'post-tool-use', {
      transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
      tool_name: 'mcp__treecontext__treecontext_insert', tool_input: c.input, tool_response: c.res,
      ...(c.who ? { agent_id: c.who.id, agent_type: c.who.type } : {}),
    })
  }
  /** The live bookmarks of the session, by the lane every reader reads
   *  (status with every lane listed). */
  async function liveBookmarksByLane(w: W): Promise<Record<string, string[]>> {
    const st = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
    const out: Record<string, string[]> = {}
    for (const p of (st['resume_pointers'] as Array<{ node_id: string; kind: string; lane: string }> | undefined) ?? []) {
      if (p.kind !== 'bookmark') continue
      ;(out[p.lane] ??= []).push(p.node_id)
    }
    return out
  }

  it.each([
    ['B\'s echo drains first', 'B-first'],
    ['C\'s echo drains first', 'C-first'],
  ])('a held bookmark B and the orchestrator\'s later bookmark C leave C the one live bookmark of main\'s lane when %s (D241, D420)', async (_how, order) => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const a = await call(w, null, 'bookmark: A, the form half wired')
      stageEcho(w, a)
      await drainStaging(w)
      subagentStart(w, 'agent-abc', 'tester')
      // B: the orchestrator, silent since the tester started: provisional,
      // its supersession of A held.
      const b = await call(w, null, 'bookmark: B, the form wired', [a.id])
      expect(b.reply).toMatchObject({ writer: 'tester', writer_src: 'provisional' })
      // The orchestrator's own Agent call returns: it is active beside the
      // tester, so C is stamped the orchestrator's (concurrent) and retires A.
      backgroundSpawnReturns(w, 'tester')
      const c = await call(w, null, 'bookmark: C, the form tested')
      expect(c.reply).toMatchObject({ writer: 'main', writer_src: 'concurrent' })
      expect(meta(w, a.id)['superseded_by']).toBe(c.id)
      for (const x of order === 'B-first' ? [b, c] : [c, b]) stageEcho(w, x)
      await drainStaging(w)
      expect(await liveBookmarksByLane(w)).toEqual({ main: [c.id] })
      expect(meta(w, b.id)).toMatchObject({ _writer: 'main', _writer_src: 'echo', superseded_by: c.id, _superseded_prior: { next_session: true } })
      expect(meta(w, c.id)).toMatchObject({ _writer: 'main', _writer_src: 'echo', next_session: true })
      expect(meta(w, c.id)['superseded_by']).toBeUndefined()
      // A keeps the retirement C made; nothing re-retired it.
      expect(meta(w, a.id)['superseded_by']).toBe(c.id)
    } finally { await done(w) }
  }, 120_000)

  it('a subagent\'s bookmark stamped the orchestrator\'s own (no subagent registered) gives back main\'s bookmark it retired when its echo moves it out (D240, D241)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const a = await call(w, null, 'bookmark: A, the form half wired')
      stageEcho(w, a)
      await drainStaging(w)
      // An install predating the subagent hooks: no SubagentStart, so the
      // tester's call is stamped the session's own (self, exact at insert)
      // and retires A in main's lane.
      const tester = { id: 'agent-u', type: 'tester' }
      const t = await call(w, tester, 'bookmark: T, the tester at case 3')
      expect(t.reply).toMatchObject({ writer: 'main', writer_src: 'self' })
      expect(meta(w, a.id)['superseded_by']).toBe(t.id)
      stageEcho(w, t)
      await drainStaging(w)
      // T's echo moves it to the tester; A, main's only bookmark, is live
      // again: T itself is never the newer bookmark A stays retired for.
      expect(await liveBookmarksByLane(w)).toEqual({ main: [a.id], tester: [t.id] })
      expect(meta(w, a.id)['superseded_by']).toBeUndefined()
      expect(meta(w, t.id)).toMatchObject({ _writer: 'tester', _writer_src: 'echo', _writer_heal_reverted: [a.id] })
    } finally { await done(w) }
  }, 120_000)

  it.each([
    ['B\'s echo drains first', 'B-first'],
    ['T\'s echo drains first', 'T-first'],
  ])('the orchestrator\'s held bookmark B is never retired in favour of the tester\'s bookmark T stamped as the orchestrator\'s, when %s (D241, D420, D169)', async (_how, order) => {
    const w = mkWorld()
    try {
      await openWorld(w); sessionStart(w); await client(w)
      const a = await call(w, null, 'bookmark: A, the form half wired')
      stageEcho(w, a)
      await drainStaging(w)
      const tester = { id: 'agent-t', type: 'tester' }
      subagentStart(w, tester.id, tester.type)
      const b = await call(w, null, 'bookmark: B, the form wired')
      expect(b.reply).toMatchObject({ writer: 'tester', writer_src: 'provisional' })
      backgroundSpawnReturns(w, 'tester')
      // T: the tester's own bookmark, read at insert as the orchestrator's
      // (concurrent); under that wrong stamp it retires A.
      const t = await call(w, tester, 'bookmark: T, the tester at case 3')
      expect(t.reply).toMatchObject({ writer: 'main', writer_src: 'concurrent' })
      expect(meta(w, a.id)['superseded_by']).toBe(t.id)
      for (const x of order === 'B-first' ? [b, t] : [t, b]) stageEcho(w, x)
      await drainStaging(w)
      // Main's lane keeps exactly one live bookmark, B; the tester's, T.
      expect(await liveBookmarksByLane(w)).toEqual({ main: [b.id], tester: [t.id] })
      expect(meta(w, b.id)).toMatchObject({ _writer: 'main', _writer_src: 'echo', next_session: true })
      expect(meta(w, b.id)['superseded_by']).toBeUndefined()
      expect(meta(w, t.id)).toMatchObject({ _writer: 'tester', _writer_src: 'echo', next_session: true })
      // What T's wrong stamp did in main's lane is undone: A no longer
      // points at T; with B live and newer, A stays retired, pointing at B.
      expect(meta(w, a.id)['superseded_by']).toBe(b.id)
      expect(meta(w, a.id)['next_session']).toBeUndefined()
      expect((await defaultStatus(w)).ids.filter((id) => [a.id, b.id, t.id].includes(id))).toEqual([b.id])
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
      const raw = new DatabaseSync(w.dbPath!)
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
