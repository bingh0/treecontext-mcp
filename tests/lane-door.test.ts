/**
 * Below the charter, through the real hooks and the production drain: the
 * pre-stamp door's undo by the echo heal (D378, D240), an unplaced
 * writer's own-lane supersession with the door open (D376, D378), and a
 * fresh start whose registration did not land (D372, D373).
 *
 * The world is a capture sandbox with a real store; the inserts go through
 * the real insert tool over a server connection under the Claude Code
 * session id the beacon names; the echo is the real PostToolUse hook with
 * the call's input and result; the drain is the production one; every
 * claim is read back from SQLite.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { runHook, hookJson, drainStaging } from './journal/capture-harness.js'
import { openWorld, now, type ReorientationWorld } from './journal/steps/journal-reorientation.steps.js'
import { mcpOver, parseTool, rawAll } from './journal/world.js'

type W = ReorientationWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }

const meta = (w: W, id: string): Record<string, unknown> =>
  JSON.parse(rawAll<{ m: string }>(w, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
const sessionStart = (w: W): string => {
  const r = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' })
  return String(((hookJson(r.stdout)?.['hookSpecificOutput']) as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}
/** A chapter as a release before the store recorded writers wrote it: no
 *  stamp, in a session the registry never held. */
async function preStampChapter(w: W, text: string): Promise<string> {
  const session = `cc-${randomBytes(6).toString('hex')}`
  const r = await w.store!.insert(text, { metadata: { next_session: true, _cc_session_id: session, _cc_session_src: 'env' }, createdAt: now() - 86_400 })
  expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', session)).toEqual([])
  return r.nodeId
}
const noMainRegistration = (w: W): void => {
  expect(rawAll(w, "SELECT 1 FROM session_registry WHERE agent_id = '' AND worktree IS NULL AND COALESCE(kind, '') != 'worker'")).toEqual([])
}

describe('the pre-stamp door (D378)', () => {
  it('is undone with its record when the call\'s echo moves the retiring row into a lane that does not own the target (D240)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      noMainRegistration(w)
      const first = await preStampChapter(w, 'plan: the first release')
      // The session no hook registered: its call through the tools.
      expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', w.sessionId)).toEqual([])
      await mcpOver(w, { ccSessionId: w.sessionId! })
      const input = { content: 'plan: the second release', metadata: { next_session: true }, supersedes: [first] }
      const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
      const reply = parseTool(res)
      expect(reply).toMatchObject({ writer: null, writer_src: 'unregistered', superseded: [], retired_across: [first] })
      const second = reply['node_id'] as string
      expect(meta(w, first)['_retired_across']).toMatchObject({ by: second, how: 'pre-stamp' })
      expect(meta(w, second)['_supersedes_across']).toEqual([first])

      // The echo names a subagent of that session as the caller.
      runHook(w, 'post-tool-use', {
        transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
        tool_name: 'mcp__treecontext__treecontext_insert', tool_input: input,
        tool_response: (res as { content: unknown }).content,
        agent_id: 'agent-x1', agent_type: 'tester',
      })
      await drainStaging(w)

      const target = meta(w, first)
      expect(target['next_session']).toBe(true)
      expect(target['superseded_by']).toBeUndefined()
      expect(target['_retired_across']).toBeUndefined()
      const retiring = meta(w, second)
      expect(retiring).toMatchObject({ _writer: 'tester', _writer_src: 'echo', _writer_heal_reverted: [first], refs: [first] })
      expect(retiring['_supersedes_across']).toBeUndefined()
      expect(String(retiring['_writer_heal_note'])).toContain(`its retirement across the pre-stamp boundary of ${first} was undone with its record`)
      expect(rawAll(w, `SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$._retired_across') IS NOT NULL
        OR json_extract(metadata_json, '$._supersedes_across') IS NOT NULL`)).toEqual([])
    } finally { await done(w) }
  })

  it('never opens to a bookmark from before the store recorded writers, the door open', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      noMainRegistration(w)
      const session = `cc-${randomBytes(6).toString('hex')}`
      const bm = (await w.store!.insert('at: the README half rewritten', {
        metadata: { next_session: true, kind: 'bookmark', _cc_session_id: session, _cc_session_src: 'env' }, createdAt: now() - 86_400,
      })).nodeId
      const before = rawAll(w, 'SELECT metadata_json, updated_at FROM nodes WHERE node_id = ?', bm)
      await mcpOver(w, { ccSessionId: w.sessionId! })
      const r = parseTool(await w.client!.callTool({
        name: 'treecontext_insert', arguments: { content: 'plan: the next release', metadata: { next_session: true }, supersedes: [bm] },
      }))
      expect(r).toMatchObject({ superseded: [], referenced: [bm] })
      expect(r['retired_across']).toBeUndefined()
      expect(rawAll(w, 'SELECT metadata_json, updated_at FROM nodes WHERE node_id = ?', bm)).toEqual(before)
      expect(meta(w, bm)['next_session']).toBe(true)
    } finally { await done(w) }
  })

  it('leaves no across record on an unplaced writer\'s own-lane supersession while the door is open (D376)', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      noMainRegistration(w)
      await mcpOver(w, { ccSessionId: w.sessionId! })
      const call = async (content: string, supersedes?: string[]): Promise<Record<string, unknown>> => parseTool(await w.client!.callTool({
        name: 'treecontext_insert', arguments: { content, metadata: { next_session: true }, ...(supersedes ? { supersedes } : {}) },
      }))
      const a = (await call('plan: the first draft'))['node_id'] as string
      expect(meta(w, a)).toMatchObject({ _writer_src: 'unregistered' })
      expect(meta(w, a)['_writer']).toBeUndefined()
      const r = await call('plan: the second draft', [a])
      expect(r).toMatchObject({ superseded: [a] })
      expect(r['retired_across']).toBeUndefined()
      for (const id of [a, r['node_id'] as string]) {
        expect(meta(w, id)['_retired_across']).toBeUndefined()
        expect(meta(w, id)['_supersedes_across']).toBeUndefined()
      }
    } finally { await done(w) }
  })
})

describe('a fresh start whose registration did not land (D372, D373)', () => {
  it('claims no checkout in the packet while status says the session could not be placed', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      const chapter = (await w.store!.insert('plan: the main lane\'s release', { metadata: { next_session: true }, createdAt: now() - 600 })).nodeId
      // The registry refuses the write, as a busy or damaged one would.
      const raw = new DatabaseSync(w.dbPath!)
      try { raw.exec("CREATE TRIGGER refuse_self BEFORE INSERT ON session_registry BEGIN SELECT RAISE(ABORT, 'registry refused'); END") } finally { raw.close() }
      const packet = sessionStart(w)
      expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', w.sessionId)).toEqual([])
      expect(packet).not.toMatch(/re-orients on the main lane's own thread/)
      expect(packet).not.toContain(`(id ${chapter})`)
      expect(packet).not.toMatch(/other lanes? holds? /)
      await mcpOver(w, { ccSessionId: w.sessionId! })
      const st = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
      expect((st['scope'] as Record<string, unknown>)['unplaced']).toMatch(/could not be placed/)

      // The same start once the registration lands: the self lines are back.
      const raw2 = new DatabaseSync(w.dbPath!)
      try { raw2.exec('DROP TRIGGER refuse_self') } finally { raw2.close() }
      w.sessionId = `cc-${randomBytes(6).toString('hex')}`
      const placed = sessionStart(w)
      expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', w.sessionId)).toHaveLength(1)
      expect(placed).toMatch(/re-orients on the main lane's own thread/)
      expect(placed).toContain(`(id ${chapter})`)
    } finally { await done(w) }
  })
})
