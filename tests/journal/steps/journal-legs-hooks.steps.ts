import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { claudeHooksBlock } from '../../../src/server/installer.js'
import { expect } from 'vitest'
import { type ChildProcess } from 'node:child_process'
import { parseTool, rawAll } from '../world.js'
import type { FlatStore } from '../../../src/flat-store.js'
import { runHook, drainStaging, bashPayload, spawnHooksInBatches, adoptCaptureStore, hookJson } from '../capture-harness.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { FIRST_MOMENT_KIND, SEND_BACK_KIND } from '../../../src/run-kinds.js'
import { inEffectLine, CHECKPOINT_CAP_CHARS, OVER_CAP_KEY, type CheckpointRecord } from '../../../src/runs.js'
import {
  STATE_NOT_HISTORY_LINE, sendBackReason, recoveryLine, composeFirstMessage, hookCutMarker, momentText, overCapWords, HOOK_CONTEXT_CAP,
} from '../../../src/first-moment.js'
import { charactersOf } from '../../../src/runs.js'
import { NOTICED_BY_SESSION_START, type LegRef } from '../../../src/persistence/leg-registry.js'
import { keyLookupReply } from '../../../src/key-lookup.js'
import {
  type RunWorld, openRunWorld, briefFor, seedCheckpoints, sessionClient, insertEchoed, subagentStopHook, blocks,
  rawOne, rawMetaOf, rawContentOf, rawRegistration, rawCheckpoints, cpLabel, startContext, sessionStartHook, agentToolReturns, agentToolLaunchesInBackground, lockStore, killAndReap,
} from '../run-world.js'
import { hooksLeg, hooksSubagent } from '../standins.js'

// ── journal-legs, the hooks door (unit 4) ───────────────────────────────
//
// D279, D280, D281, D284, D285, D305, D314, D320, D325, D326, D327, D328,
// D329, D330, D332, D334: every leg here starts through the real
// SubagentStart hook, which reads the brief in effect for its role from
// the store and infers the leg's run and key (the harness writes the
// brief through the library's own writer), and stops through the real
// SubagentStop hook; the main agent's Agent tool returns through the real
// PostToolUse hook with the platform's Agent payload; the session restarts
// through the real SessionStart hook. Every Then reads what a hook printed
// (what the platform reads: the subagent's context, the stop's decision,
// the context added beside the Agent tool's result), the harness's lookup,
// the agent's own tools, or the store file through a separate handle.

type HooksWorld = RunWorld
type Define = (re: RegExp, fn: (w: HooksWorld, ...caps: string[]) => void | Promise<void>) => void

const RUN = 'r1'

/** "No query made": no treecontext_query call was captured into staging, the
 *  table every hooked tool call lands in. The stand-in world has no agent
 *  turn that calls tools, so the absence alone could not fail; the control
 *  makes the needle earn it. After the absence is read, the real PostToolUse
 *  hook captures one treecontext_query call in this same world and the same
 *  read must now find exactly it. The primary proof stays where the scenario
 *  puts it: the checkpoint text is in the SubagentStart hook's own stdout,
 *  composed before any agent turn. */
function expectNoQueryMade(w: HooksWorld): void {
  const queries = (): unknown[] => rawAll(w, "SELECT 1 FROM staging WHERE tool_name LIKE '%treecontext_query%'")
  expect(queries()).toHaveLength(0)
  if (w.facts!['query-control'] === true) return
  runHook(w, 'post-tool-use', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__treecontext__treecontext_query',
    tool_input: { query: 'what was I working on' },
    tool_response: { content: [{ type: 'text', text: '{"results":[]}' }] },
  })
  w.facts!['query-control'] = true
  expect(queries(), 'the control: a real treecontext_query capture is visible to this read').toHaveLength(1)
}

/** What a leg was handed at its start (the hook's own stdout). */
function contextOf(w: HooksWorld, name: string): string {
  const out = w.facts![`start:${name}`] as string | undefined
  expect(out, `the SubagentStart hook ran for ${name}`).toBeDefined()
  const c = startContext(out!)
  expect(c, `the SubagentStart hook emitted no context for ${name}`).not.toBeNull()
  return c!
}

function legLookup(w: HooksWorld, key: string, run = RUN) {
  const l = w.store!.lookupKey({ run, key })
  w.lookups![run] = l
  return l
}

/** The leg makes its inferred key its own: one row under it, through the
 *  tools on the session's connection, its echo drained (D320, D326). */
async function makeKeyOwn(w: HooksWorld, name: string, role: string, key: string): Promise<void> {
  const leg = w.legs![name]!
  await insertEchoed(w, { agentId: leg.agentId, agentType: role }, `plan: ${key} — read the trail, then wire what is missing`, { run: RUN, key })
  await drainStaging(w)
  expect(rawRegistration(w, leg)['key_src']).toBe('own')
}

/** `n` tool calls the leg makes, through the real PostToolUse hook with
 *  its agent fields, drained. */
async function toolCalls(w: HooksWorld, name: string, role: string, n: number): Promise<void> {
  const leg = w.legs![name]!
  await spawnHooksInBatches(w, 'post-tool-use', Array.from({ length: n }, (_, i) => ({
    ...bashPayload(w, `npx vitest run login -t case-${i}`, `case ${i}: 1 failing (${leg.agentId})`), agent_id: leg.agentId, agent_type: role,
  })))
  await drainStaging(w)
}

function stopLeg(w: HooksWorld, name: string, role: string, report: string, stopActive = false, handback?: { closing?: string }): void {
  const before = Date.now() / 1000
  w.stops![name] = subagentStopHook(w, w.legs![name]!.agentId, role, report, { stopActive, ...(handback ? { handback } : {}) })
  w.moments![`stop:${name}`] = before
  w.moments![`stopped:${name}`] = Date.now() / 1000
}

/** A builder leg from checkpoint 3 under a key, named its checkpointer by
 *  its brief, whose key is its own (the only key that asks, D326). */
async function owingBuilder(w: HooksWorld, key: string): Promise<void> {
  await openRunWorld(w)
  await seedCheckpoints(w, RUN, key, 3)
  await hooksLeg(w, 'builder', 'builder', { run: RUN, key, checkpointer: 'builder' })
  await sessionClient(w)
  await makeKeyOwn(w, 'builder', 'builder', key)
}

/** The store file refuses writes: read-only on disk (the stop hook asks
 *  the filesystem, as the bookmark ask does). */
function refuseWrites(w: HooksWorld): void {
  chmodSync(w.dbPath!, 0o444)
  w.facts!['refusing'] = true
  w.defer(() => { try { chmodSync(w.dbPath!, 0o644) } catch { /* gone */ } })
}

function allowWrites(w: HooksWorld): void {
  if (w.facts!['refusing']) chmodSync(w.dbPath!, 0o644)
  w.facts!['refusing'] = false
}

/** The capture-gap rows the drain wrote for dropped hook events. */
function hookGaps(w: HooksWorld, hook: string): Array<{ content: string; created_at: number; m: Record<string, unknown> }> {
  return rawAll<{ node_id: string; created_at: number; m: string }>(w,
    "SELECT node_id, created_at, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.source') = 'capture-gap' AND json_extract(metadata_json, '$.hook') = ?", hook)
    .map((r) => ({ content: rawContentOf(w, r.node_id), created_at: r.created_at, m: JSON.parse(r.m) as Record<string, unknown> }))
}

/** The first-moment refusal dropped: the store takes the row again. */
function dropFirstMomentRefusal(w: HooksWorld): void {
  if (!w.facts!['refuse-first-moment']) return
  const db = new DatabaseSync(w.dbPath!)
  try { db.exec('DROP TRIGGER IF EXISTS refuse_first_moment') } finally { db.close() }
  w.facts!['refuse-first-moment'] = false
}

/** The store locked whole by another process, this one let go of it. */
async function lockWhole(w: HooksWorld): Promise<void> {
  await w.store!.close()
  delete w.store
  w.facts!['locker'] = await lockStore(w, 'whole')
}

async function unlock(w: HooksWorld): Promise<void> {
  await killAndReap(w.facts!['locker'] as ChildProcess)
  await adoptCaptureStore(w)
}

/** A leg's lane, oldest first, from the file. */
function laneOf(w: HooksWorld, name: string): Array<{ node_id: string; kind: string | null; content: string; m: Record<string, unknown> }> {
  const leg = w.legs![name]!
  return rawAll<{ node_id: string; m: string }>(w,
    "SELECT node_id, metadata_json AS m FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ? ORDER BY created_at, rowid",
    leg.sessionId, leg.agentId).map((r) => {
    const m = JSON.parse(r.m) as Record<string, unknown>
    return { node_id: r.node_id, kind: (m['kind'] as string | undefined) ?? null, content: rawContentOf(w, r.node_id), m }
  })
}

/** The checkpoint content of exactly `n` characters. */
function textOf(n: number): string {
  const unit = 'state: the form renders and submits; next: the error states and the retry. '
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
}

/** The size a checkpoint must have so the builder's first moment through
 *  the hooks door is `chars` characters, composed with the library's own
 *  composer over the store's facts (a stand-in row id and moment of the
 *  same lengths as the real ones). */
function sizeFor(w: HooksWorld, key: string, chars: number): number {
  const facts = w.store!.firstMomentFacts({ run: RUN, key, role: 'builder', checkpointer: null, checkpointedBy: null })
  const probe = (size: number): number => {
    // A checkpoint past the cap is in effect only by its second write, and
    // the first message says so in words beside its size (D321).
    // (written by a declared role the registry never saw: no refusal, D359)
    const overCap = size > CHECKPOINT_CAP_CHARS ? { size, cap: CHECKPOINT_CAP_CHARS, second: false } : null
    const cp = { nodeId: 'f'.repeat(32), number: 1, writer: 'builder', createdAt: Date.now() / 1000, content: textOf(size), size, overCap } as CheckpointRecord
    return composeFirstMessage({ ...facts, checkpoints: [cp], inEffect: inEffectLine(RUN, key, [cp]) }, null, { door: 'hooks' }).length
  }
  let size = chars - 1500
  for (let i = 0; i < 4; i++) size += chars - probe(size)
  expect(probe(size)).toBe(chars)
  return size
}


// ── The checkpoint cap (unit 5): what a leg sees of its write ───────────

/** What a leg sees of one checkpoint write, the same whichever door it
 *  went through: the tool's reply, or the library's result. */
interface Seen {
  via: 'tool'
  refused: boolean
  nodeId: string | null
  number: number | null
  overCap: { size: number; cap: number; second: boolean } | null
  size: number | null
  cap: number | null
  reason: string | null
  shape: string | null
  isError: boolean
  raw: Record<string, unknown>
}

/** A checkpoint of exactly `n` characters, distinct per write (`i`). */
function variant(n: number, i: number): string {
  return `${i === 0 ? 'A' : 'B'}${textOf(n).slice(1)}`
}

/** A checkpoint write through the real insert tool on the session's one
 *  connection, and its PostToolUse echo with the caller's agent fields (the
 *  hooks door's leg, D359: a checkpoint under a run's key meets the cap at
 *  any size, the tool's content bound not applying to it). */
async function writeSeen(w: HooksWorld, name: string, role: string, key: string, text: string): Promise<Seen> {
  const leg = w.legs![name]!
  await sessionClient(w)
  const input = { content: text, metadata: { kind: 'checkpoint', run: RUN, key } }
  const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
  runHookEcho(w, leg, role, input, res)
  const r = parseTool(res)
  const cp = (r['checkpoint'] ?? null) as Record<string, unknown> | null
  return {
    via: 'tool', refused: r['refused'] === true, nodeId: typeof r['node_id'] === 'string' ? r['node_id'] : null,
    number: cp ? Number(cp['number']) : null, overCap: (cp?.['over_cap'] ?? null) as Seen['overCap'],
    size: typeof r['size'] === 'number' ? r['size'] : null, cap: typeof r['cap'] === 'number' ? r['cap'] : null,
    reason: typeof r['reason'] === 'string' ? r['reason'] : null, shape: typeof r['shape'] === 'string' ? r['shape'] : null,
    isError: (res as { isError?: boolean }).isError === true, raw: r,
  }
}

/** The insert's PostToolUse echo, as Claude Code fires it for a
 *  subagent's call. */
function runHookEcho(w: HooksWorld, leg: LegRef, role: string, input: Record<string, unknown>, res: unknown): void {
  runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'mcp__treecontext__treecontext_insert', tool_input: input,
    tool_response: (res as { content: unknown }).content, agent_id: leg.agentId, agent_type: role,
  })
}

/** A checkpoint in effect under a key, written by a declared role through
 *  the library. A role no hook registered is never refused (D359), so a
 *  checkpoint past the cap lands at once, marked; a refusal, were there
 *  one, would be answered by the second write. */
async function inEffectCheckpoint(w: HooksWorld, content: string, opts: Parameters<FlatStore['writeCheckpoint']>[1]): ReturnType<FlatStore['writeCheckpoint']> {
  const first = await w.store!.writeCheckpoint(content, opts)
  if (first.refused === undefined) return first
  const second = await w.store!.writeCheckpoint(content, opts)
  expect(second.refused, 'the second write past the cap is accepted').toBeUndefined()
  return second
}

/** A builder leg under the run and key, named its own checkpointer, with
 *  no checkpoint yet, started through the real SubagentStart hook. */
async function cappedBuilder(w: HooksWorld, key: string): Promise<void> {
  await openRunWorld(w)
  await hooksLeg(w, 'builder', 'builder', { run: RUN, key, checkpointer: 'builder' })
  await sessionClient(w)
}

function seenOf(w: HooksWorld, name: string, i: number): Seen {
  const seen = (w.facts![`writes:${name}`] as Seen[] | undefined)?.[i]
  expect(seen, `write ${i + 1} of the ${name}`).toBeTruthy()
  return seen!
}

function noteWrite(w: HooksWorld, name: string, seen: Seen, key: string): void {
  const list = ((w.facts![`writes:${name}`] ??= []) as Seen[])
  list.push(seen)
  ;(w.facts![`rows-after:${name}:${list.length - 1}`]) = rawCheckpoints(w, RUN, key).length
}

/** The registration's record of the cap, straight from the file. */
function capRefusedOf(w: HooksWorld, ref: LegRef): Array<{ run: string; key: string; size: number; at: number; src?: string; id?: string }> {
  const t = rawRegistration(w, ref)['cap_refused']
  return typeof t === 'string' ? JSON.parse(t) as Array<{ run: string; key: string; size: number; at: number; src?: string; id?: string }> : []
}

/** What the refusal told the writer: the reason with the size and the cap,
 *  and the shape asked for (D299, D332). */
function expectReasonAndShape(seen: Seen, size: number, key: string): void {
  expect(seen.refused).toBe(true)
  expect(seen.isError, 'a refusal is a reply, not a thrown error').toBe(false)
  expect([seen.size, seen.cap]).toEqual([size, CHECKPOINT_CAP_CHARS])
  expect(seen.reason).toContain(`${size} characters`)
  expect(seen.reason).toContain(`${CHECKPOINT_CAP_CHARS}-character cap`)
  expect(seen.reason).toContain('nothing was written')
  expect(seen.shape).toContain('the state of the work as it now stands, not its history')
  expect(seen.shape).toContain('what it supersedes and what it rests on')
  expect(seen.shape).toContain('leave the history out')
  expect(seen.shape).toContain(`under the key "${key}" on the run "${RUN}"`)
  expect(seen.shape).toContain('accepted and marked as over the cap')
  expect(seen.nodeId).toBeNull()
}

export function hooksDoorSteps(define: Define): void {
  // ── D284, D298, D329, D332: the first moment the hook hands the leg ──

  define(/^a run "([^"]+)" whose key "([^"]+)" holds the checkpoint number (\d+), written by the builder role, reading "([^"]+)"$/, async (w, run, key, num, text) => {
    expect(run).toBe(RUN)
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, key!, Number(num) - 1)
    const r = await w.store!.writeCheckpoint(text!, { run: RUN, key: key!, declared: { role: 'builder' }, supersedes: [ids.at(-1)!] })
    expect(r.checkpoint!.number).toBe(Number(num))
    w.cps![cpLabel(RUN, key!, Number(num))] = r.nodeId
  })

  define(/^a brief row for the builder role that names the run "([^"]+)", the key "([^"]+)" and the builder as its checkpointer$/, async (w, run, key) => {
    w.ids!['brief'] = await briefFor(w, 'builder', run!, key!, { checkpointer: 'builder', content: `wire the submit of the ${key}; tests first` })
  })

  define(/^(?:a|the) ([a-z-]+) subagent starts(?: through the hooks door)?$/, (w, role) => {
    hooksSubagent(w, role!, role!)
  })

  define(/^the context the subagent-start hook emits for the builder carries the brief and checkpoint number (\d+)'s text whole, with its writer "([^"]+)" and its moment$/, (w, num, writer) => {
    const c = contextOf(w, 'builder')
    const cp = rawCheckpoints(w, RUN, 'login-form').find((x) => x.n === Number(num))!
    const brief = rawContentOf(w, w.ids!['brief']!)
    expect(c).toContain(brief)
    expect(c).toContain(rawContentOf(w, cp.node_id))
    const at = rawOne<{ t: number }>(w, 'SELECT created_at AS t FROM nodes WHERE node_id = ?', cp.node_id)!.t
    expect(c).toContain(`Checkpoint number ${num} under "login-form" (row ${cp.node_id}), written by "${writer}" at ${momentText(at)}`)
    // No query made on its behalf: the first moment is the hook's own
    // composition, and no treecontext call was captured for the leg.
    expectNoQueryMade(w)
    expect(c.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
  })

  define(/^a brief row for the builder role naming the run "([^"]+)" and the key "([^"]+)", with no checkpoint under that key$/, async (w, run, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = await briefFor(w, 'builder', run!, key!, { checkpointer: 'builder', content: `build the ${key}; debounce the input` })
    expect(rawCheckpoints(w, run!, key!)).toHaveLength(0)
  })

  define(/^the context the subagent-start hook emits for the builder carries the brief and says no checkpoint is in effect under "([^"]+)"$/, (w, key) => {
    const c = contextOf(w, 'builder')
    expect(c).toContain(rawContentOf(w, w.ids!['brief']!))
    expect(c).toContain(`No checkpoint is in effect under "${key}" on the run "${RUN}".`)
  })

  define(/^the harness looking up the key "([^"]+)" on the run "([^"]+)" receives no checkpoint and a line saying so$/, (w, key, run) => {
    const l = legLookup(w, key!, run!)
    expect(l.checkpoints).toHaveLength(0)
    expect(l.line).toBe(`No checkpoint is in effect under "${key}" on the run "${run}".`)
  })

  define(/^the checkpoint the builder writes at its end is number (\d+) under the key "([^"]+)"$/, async (w, num, key) => {
    await sessionClient(w)
    const leg = w.legs!['builder']!
    const reply = await insertEchoed(w, { agentId: leg.agentId, agentType: 'builder' }, 'state: search box debounced; next: results list', { kind: 'checkpoint', run: RUN, key })
    w.stops!['builder'] = subagentStopHook(w, leg.agentId, 'builder', 'search box debounced')
    expect(blocks(w.stops!['builder']!)).toBe(false)
    await drainStaging(w)
    const m = rawMetaOf(w, reply['node_id'] as string)
    expect([m['_checkpoint_number'], m['_writer'], m['_writer_agent_id'], m['key']]).toEqual([Number(num), 'builder', leg.agentId, key])
  })

  // ── D279, D280, D326: the send-back once, through the stop hook ──

  // A forward guard, said so: no setting for the send-back or the
  // checkpointer exists anywhere today (D279: on by default; D281: no
  // setting lists checkpointers), so this Given can only check that none
  // has crept into the places a setting would live. It starts to bite the
  // day one is added to any of them.
  define(/^a project whose configuration names no send-back setting and no checkpointer setting$/, async (w) => {
    await openRunWorld(w)
    const names = /send.?back|checkpointer/i
    // The hooks block install writes into Claude Code's settings.
    const block = JSON.stringify(claudeHooksBlock())
    expect(block).toContain('SubagentStop')
    expect('"send_back": true, "checkpointer": "builder"', 'the setting needle is dead').toMatch(names)
    expect(block).not.toMatch(names)
    // The store's own configuration rows.
    expect(rawAll(w, 'SELECT key FROM store_config').map((r) => String((r as { key: string }).key)).filter((k) => names.test(k))).toEqual([])
    // The project's configuration file, if the sandbox has one, and the
    // hooks' own exported constants: none names a send-back setting.
    for (const f of [join(w.proj!, '.treecontext.toml'), join(w.home!, '.treecontext', 'config.toml')]) {
      if (existsSync(f)) expect(readFileSync(f, 'utf8')).not.toMatch(names)
    }
    const exported = Object.keys({ ...(await import('../../../src/hooks/subagent-stop.js')), ...(await import('../../../src/hooks/shared.js')) })
    expect(exported).toContain('owesSendBack')
    expect(exported.filter((k) => /SETTING|CONFIG/i.test(k) && names.test(k))).toEqual([])
  })

  define(/^a builder leg started from checkpoint number (\d+) under the key "([^"]+)", named as its checkpointer$/, async (w, num, key) => {
    expect(num).toBe('3')
    await owingBuilder(w, key!)
  })

  define(/^the builder stops after (\d+) tool calls with no checkpoint written under its key newer than its start$/, async (w, n) => {
    await toolCalls(w, 'builder', 'builder', Number(n))
    stopLeg(w, 'builder', 'builder', `wired half the submit after ${n} calls`)
  })

  define(/^the subagent-stop hook's output blocks the stop once, with the reason naming the key "([^"]+)" and the missing checkpoint$/, (w, key) => {
    const out = hookJson(w.stops!['builder']!)
    expect(out?.['decision']).toBe('block')
    const reason = String(out!['reason'])
    // A leg whose checkpoint the cap refused is sent back for the same
    // missing checkpoint, the reason naming the cap and the size refused
    // (D299); the key it was refused under is its own though nothing landed.
    const refused = w.facts!['refused-size'] as number | undefined
    expect(reason).toContain(sendBackReason('builder', RUN, key!, refused !== undefined ? { size: refused } : null))
    expect(reason).toContain(`no checkpoint under the key "${key}" on the run "${RUN}" newer than your start`)
    if (refused !== undefined) {
      expect(reason).toContain(`${refused} characters, was refused for being past the ${CHECKPOINT_CAP_CHARS}-character cap`)
      expect(reason).toContain('Write a shorter one')
    }
    // The first moment again, from the store, and the trail pointer.
    expect(reason).toContain(STATE_NOT_HISTORY_LINE)
    expect(reason).toContain(`Write the next checkpoint under "${key}" on the run "${RUN}", then stop.`)
    expect(reason.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
    // Once: counted on the registration, the leg still live, its row in
    // its lane naming the missing checkpoint.
    const leg = w.legs!['builder']!
    const r = rawRegistration(w, leg)
    expect([r['send_backs'], r['ended'], r['stopped_at']]).toEqual([1, null, null])
    const rows = laneOf(w, 'builder').filter((x) => x.kind === SEND_BACK_KIND)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(reason)
    expect([rows[0]!.m['_door'], rows[0]!.m['key'], rows[0]!.m['run']]).toEqual(['hooks', key, RUN])
  })

  define(/^a builder leg already sent back once for the missing checkpoint under the key "([^"]+)"$/, async (w, key) => {
    await owingBuilder(w, key!)
    stopLeg(w, 'builder', 'builder', 'stopping without the checkpoint')
    expect(blocks(w.stops!['builder']!)).toBe(true)
    expect(rawRegistration(w, w.legs!['builder']!)['send_backs']).toBe(1)
  })

  // The platform marks the stop after a block as continuing because of a
  // stop hook; here it is sent unmarked, so it is the registration's count
  // alone that keeps the leg from a second send-back (D279, D295).
  define(/^the builder stops again with no checkpoint written$/, (w) => {
    stopLeg(w, 'builder', 'builder', 'still no checkpoint; stopping', false)
  })

  define(/^the harness looking up the key "([^"]+)" sees the builder leg retired as having ended without a checkpoint$/, (w, key) => {
    const l = legLookup(w, key!)
    const leg = l.legs.find((g) => g.agentId === w.legs!['builder']!.agentId)!
    expect([leg.state, leg.checkpointsWritten]).toEqual(['retired', 0])
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['send_backs'], r['ended']]).toEqual([1, 'retired'])
    expect(l.checkpoints.map((c) => c.number)).toEqual([3])
  })

  define(/^the context the subagent-start hook emits for the next builder says its predecessor ended without a checkpoint$/, (w) => {
    hooksSubagent(w, 'next', 'builder')
    const c = contextOf(w, 'next')
    const prev = w.legs!['builder']!
    expect(c).toContain(`your predecessor, the builder leg in the lane of session ${prev.sessionId}, agent ${prev.agentId}, ended without a checkpoint`)
  })

  define(/^a store that refuses writes$/, (w) => {
    refuseWrites(w)
  })

  define(/^the ([a-z-]+) stops with no checkpoint written(?: under the key "([^"]+)")?(, the store now writable)?$/, async (w, name, key, writable) => {
    if (key) expect(rawRegistration(w, w.legs![name!]!)['run_key']).toBe(key)
    if (writable) expect(w.facts!['refusing']).toBeFalsy()
    stopLeg(w, name!, name!, `${name} stopping; no checkpoint`)
  })

  define(/^the store, once writable, carries a capture-gap marker at the builder's stop$/, async (w) => {
    // While the store refused, the stop changed nothing in it.
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['send_backs'], r['stopped_at'], r['ended']]).toEqual([0, null, null])
    allowWrites(w)
    await drainStaging(w)
    const gaps = hookGaps(w, 'subagent-stop')
    expect(gaps).toHaveLength(1)
    const g = gaps[0]!
    expect(g.m['agent_id']).toBe(w.legs!['builder']!.agentId)
    expect(g.created_at).toBeGreaterThanOrEqual(w.moments!['stop:builder']!)
    expect(g.created_at).toBeLessThanOrEqual(w.moments!['stopped:builder']!)
    expect(g.content).toMatch(/^\[capture gap\] The subagent-stop event of the builder subagent/)
    expect(g.content).toContain('not sent back')
  })

  // ── D279, D328, D334: the cut leg and the recovery leg ──

  define(/^a builder leg under the key "([^"]+)" that started from checkpoint number (\d+), wrote (\d+) tool calls and was killed before writing any checkpoint$/, async (w, key, num, n) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, Number(num))
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key: key!, checkpointer: 'builder' })
    await toolCalls(w, 'builder', 'builder', Number(n))
    // Killed: no SubagentStop ever fires; the session it ran in comes back
    // (resume) and its start is what notices the leg was cut (D328).
    sessionStartHook(w, 'resume')
    expect(rawRegistration(w, w.legs!['builder']!)['ended']).toBe('cut')
  })

  define(/^the next builder leg starts under the key "([^"]+)"$/, (w, key) => {
    hooksSubagent(w, 'next', 'builder')
    expect(rawRegistration(w, w.legs!['next']!)['run_key']).toBe(key)
  })

  define(/^the context the subagent-start hook emits for the new builder says its predecessor was cut, names its predecessor's lane and the count (\d+), and names checkpoint number (\d+) as the one in effect$/, (w, n, num) => {
    const c = contextOf(w, 'next')
    const prev = w.legs!['builder']!
    expect(c).toContain(recoveryLine({ sessionId: prev.sessionId, agentId: prev.agentId, role: 'builder', ended: 'cut', rows: Number(n) }, 'login-form'))
    expect(c).toContain(`Checkpoint number ${num} is in effect under "login-form" on the run "${RUN}".`)
  })

  define(/^a builder leg started as a recovery leg under the key "([^"]+)", with checkpoint number (\d+) in effect$/, async (w, key, num) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, Number(num))
    await hooksLeg(w, 'cut', 'builder', { run: RUN, key: key!, checkpointer: 'builder' })
    await toolCalls(w, 'cut', 'builder', 3)
    sessionStartHook(w, 'resume')
    hooksSubagent(w, 'recovery', 'builder')
    expect(contextOf(w, 'recovery')).toContain('You start as a recovery leg')
    await sessionClient(w)
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds checkpoint number (\d+), and a builder leg cut with no checkpoint$/, async (w, run, key, num) => {
    expect(run).toBe(RUN)
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, Number(num))
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key: key!, checkpointer: 'builder' })
    await toolCalls(w, 'builder', 'builder', 2)
    sessionStartHook(w, 'resume')
  })

  define(/^the drain runs and the harness looks up the key "([^"]+)"$/, async (w, key) => {
    await drainStaging(w)
    legLookup(w, key!)
  })

  define(/^the harness receives checkpoint number (\d+) with the builder leg shown as cut$/, (w, num) => {
    const l = w.lookups![RUN]!
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(num)])
    const leg = l.legs.find((g) => g.agentId === w.legs!['builder']!.agentId)!
    expect([leg.state, leg.noticedBy, leg.stoppedAt]).toEqual(['cut', NOTICED_BY_SESSION_START, null])
  })

  define(/^a reader of the store file finds no checkpoint row under "([^"]+)" newer than number (\d+)$/, (w, key, num) => {
    const rows = rawCheckpoints(w, RUN, key!)
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: Number(num) }, (_, i) => i + 1))
    expect(rows.filter((r) => r.m['_writer'] === 'treecontext' || r.m['_writer_agent_id'] === w.legs!['builder']!.agentId)).toHaveLength(0)
  })

  // ── D281: the brief's two tenses, and another role as checkpointer ──

  define(/^a brief row for the technical-writer role under the key "([^"]+)" whose past checkpointer is the builder and whose future checkpointer is the project-manager$/, async (w, key) => {
    await openRunWorld(w)
    await briefFor(w, 'technical-writer', RUN, key!, { checkpointedBy: 'builder', checkpointer: 'project-manager', content: 'document the login form for the release notes' })
  })

  define(/^the context the subagent-start hook emits for the technical-writer names the builder as the writer of the checkpoint it resumes and the project-manager as the one who will checkpoint$/, (w) => {
    const c = contextOf(w, 'technical-writer')
    expect(c).toContain('Your instructions name "project-manager" as the one who will checkpoint "login-form" at the end, and "builder" as the one who checkpointed the work you resume.')
    const r = rawRegistration(w, w.legs!['technical-writer']!)
    expect([r['checkpointer'], r['checkpointed_by']]).toEqual(['project-manager', 'builder'])
  })

  define(/^a technical-writer leg whose brief names the project-manager as the one who will checkpoint the key "([^"]+)"$/, async (w, key) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, 3)
    await hooksLeg(w, 'technical-writer', 'technical-writer', { run: RUN, key: key!, checkpointer: 'project-manager' })
    await sessionClient(w)
    // Its key is its own, so only the brief's checkpointer keeps it from
    // the send-back (D326 would otherwise spare it).
    await makeKeyOwn(w, 'technical-writer', 'technical-writer', key!)
  })

  define(/^the harness looking up the key "([^"]+)" sees the technical-writer leg retired without a send-back$/, (w, key) => {
    const l = legLookup(w, key!)
    const leg = l.legs.find((g) => g.agentId === w.legs!['technical-writer']!.agentId)!
    expect([leg.state, leg.keySrc]).toEqual(['retired', 'own'])
    expect(rawRegistration(w, w.legs!['technical-writer']!)['send_backs']).toBe(0)
    expect(laneOf(w, 'technical-writer').filter((x) => x.kind === SEND_BACK_KIND)).toHaveLength(0)
  })

  // ── D284, D285, D330: the pointer on the Agent tool's result ──

  async function builderWroteCheckpoint(w: HooksWorld, key: string): Promise<void> {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key, 3)
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key, checkpointer: 'builder' })
    await sessionClient(w)
    const leg = w.legs!['builder']!
    const reply = await insertEchoed(w, { agentId: leg.agentId, agentType: 'builder' }, 'state: submit wired; next: validation', { kind: 'checkpoint', run: RUN, key })
    w.ids!['builder-checkpoint'] = reply['node_id'] as string
    expect((reply['checkpoint'] as Record<string, unknown>)['number']).toBe(4)
  }

  function finish(w: HooksWorld, report: string, o: { handback?: { closing?: string } } = {}): void {
    stopLeg(w, 'builder', 'builder', report, false, o.handback)
    expect(blocks(w.stops!['builder']!)).toBe(false)
    w.facts!['agent-return'] = agentToolReturns(w, w.legs!['builder']!.agentId, 'builder', 'wire the submit of the login form', report)
  }

  function pointerOf(w: HooksWorld): string {
    const out = hookJson(w.facts!['agent-return'] as string)
    expect(out, 'the PostToolUse hook added nothing to the Agent tool result').not.toBeNull()
    const hso = out!['hookSpecificOutput'] as Record<string, unknown>
    expect(hso['hookEventName']).toBe('PostToolUse')
    return String(hso['additionalContext'])
  }

  function expectPointer(w: HooksWorld, line: string, writer: string, run: string, key: string): void {
    expect(line.split('\n')).toHaveLength(1)
    // The row the leg's lane holds as its return, found in the file, not
    // read off the line.
    const leg = w.legs!['builder']!
    const rows = rawAll<{ node_id: string }>(w,
      "SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ? AND json_extract(metadata_json, '$.kind') = ?",
      leg.sessionId, leg.agentId, SUBAGENT_SUMMARY_KIND)
    expect(rows).toHaveLength(1)
    const id = rows[0]!.node_id
    // Its pieces, each literal: the row id, the writer, the run, the key,
    // and the export to fetch it with.
    expect(line).toContain(`summary row ${id}`)
    expect(line).toContain(`writer "${writer}"`)
    expect(line).toContain(`run "${run}"`)
    expect(line).toContain(`key "${key}"`)
    expect(line).toContain('treecontext_export')
    expect(line.startsWith('treecontext: ')).toBe(true)
    const m = rawMetaOf(w, id!)
    expect([m['kind'], m['_writer'], m['_writer_agent_id'], m['run'], m['key'], m['_door']]).toEqual([SUBAGENT_SUMMARY_KIND, writer, w.legs!['builder']!.agentId, run, key, 'hooks'])
    w.ids!['summary'] = id!
  }

  define(/^a builder leg under the run "([^"]+)" and the key "([^"]+)" that wrote checkpoint number (\d+)$/, async (w, run, key, num) => {
    expect([run, num]).toEqual([RUN, '4'])
    await builderWroteCheckpoint(w, key!)
  })

  define(/^the builder finishes with the report "([^"]+)"$/, (w, report) => {
    // Through the client's hand-back tool with no closing text, the
    // reference platform's shape in auto mode (D371); the pointer and the
    // row it names must hold the report all the same.
    finish(w, report!, { handback: {} })
    w.facts!['report'] = report
  })

  define(/^the main agent is handed one line pointing at a summary row whose writer is "([^"]+)" and which carries the run "([^"]+)" and the key "([^"]+)"$/, (w, writer, run, key) => {
    expectPointer(w, pointerOf(w), writer!, run!, key!)
    expect(rawContentOf(w, w.ids!['summary']!)).toBe(w.facts!['report'])
  })

  define(/^a builder leg finished under the run "([^"]+)" and the key "([^"]+)" having written checkpoint number (\d+), and no read of its summary row in the store$/, async (w, run, key, num) => {
    expect([run, num]).toEqual([RUN, '4'])
    await builderWroteCheckpoint(w, key!)
    finish(w, 'submit wired; validation next')
    expectPointer(w, pointerOf(w), 'builder', RUN, key!)
    await drainStaging(w)
    const r = rawOne<{ relied_count: number }>(w, 'SELECT relied_count FROM nodes WHERE node_id = ?', w.ids!['summary']!)!
    expect(r.relied_count).toBe(0)
  })

  define(/^a builder subagent starts under the key "([^"]+)"$/, (w, key) => {
    hooksSubagent(w, 'next', 'builder')
    expect(rawRegistration(w, w.legs!['next']!)['run_key']).toBe(key)
  })

  define(/^the main agent was handed the one-line pointer at the leg's finish all the same$/, (w) => {
    expect(pointerOf(w)).toContain(`the summary row ${w.ids!['summary']}`)
    // Nobody followed it: the row was never relied on.
    expect(rawOne<{ relied_count: number }>(w, 'SELECT relied_count FROM nodes WHERE node_id = ?', w.ids!['summary']!)!.relied_count).toBe(0)
  })

  define(/^the context the subagent-start hook emits for the new builder carries checkpoint number (\d+)$/, (w, num) => {
    const c = contextOf(w, 'next')
    const id = w.ids!['builder-checkpoint']!
    expect(c).toContain(`Checkpoint number ${num} under "login-form" (row ${id})`)
    expect(c).toContain(rawContentOf(w, id))
  })

  define(/^a builder leg under the run "([^"]+)" and the key "([^"]+)" that finishes with the final message "([^"]+)"$/, async (w, run, key, text) => {
    expect(run).toBe(RUN)
    await builderWroteCheckpoint(w, key!)
    stopLeg(w, 'builder', 'builder', text!)
    expect(blocks(w.stops!['builder']!)).toBe(false)
    w.facts!['final'] = text
  })

  define(/^the Agent tool returns to the main agent$/, (w) => {
    w.facts!['agent-return'] = agentToolReturns(w, w.legs!['builder']!.agentId, 'builder', 'wire the submit of the login form', w.facts!['final'] as string)
  })

  define(/^the main agent receives the final message "([^"]+)" whole$/, async (w, text) => {
    // The hook adds context beside the result and changes nothing of it:
    // no decision, no replaced output, only the added line.
    const out = hookJson(w.facts!['agent-return'] as string)!
    expect(Object.keys(out)).toEqual(['hookSpecificOutput'])
    expect(Object.keys(out['hookSpecificOutput'] as object).sort()).toEqual(['additionalContext', 'hookEventName'])
    // The Agent call itself is captured with the subagent's final message
    // as its output, whole.
    await drainStaging(w)
    const row = rawAll<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'Agent'")
    expect(row).toHaveLength(1)
    expect(rawContentOf(w, row[0]!.node_id)).toContain(text)
    // And the summary row is the final message whole, the platform's text.
    expect(rawContentOf(w, rawAll<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = ?", SUBAGENT_SUMMARY_KIND)[0]!.node_id)).toBe(text)
  })

  define(/^the main agent receives one added line naming the summary row, its writer "([^"]+)", the run "([^"]+)" and the key "([^"]+)"$/, (w, writer, run, key) => {
    expectPointer(w, pointerOf(w), writer!, run!, key!)
    // Only a return carries it: had this leg been launched in the
    // background, its launch's result (the platform's async_launched)
    // would carry none, its return being the platform's notification.
    expect(agentToolLaunchesInBackground(w, w.legs!['builder']!.agentId, 'builder', 'wire the submit of the login form').trim()).toBe('')
  })

  // ── D305, D320, D326, D327: what the hooks door infers ──

  define(/^a brief row for the builder role naming the run "([^"]+)" and the key "([^"]+)", and checkpoint number (\d+) under that key$/, async (w, run, key, num) => {
    expect(run).toBe(RUN)
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, Number(num))
    w.ids!['brief'] = await briefFor(w, 'builder', RUN, key!, { checkpointer: 'builder' })
  })

  define(/^the first row of the builder's lane is a first-moment row referencing the brief row and checkpoint number (\d+)'s row by id, not copies, and carrying the checkpoint's size$/, (w, num) => {
    const first = laneOf(w, 'builder')[0]!
    expect(first.kind).toBe(FIRST_MOMENT_KIND)
    const cp = w.cps![cpLabel(RUN, 'login-form', Number(num))]!
    expect(first.m['refs']).toEqual([w.ids!['brief'], cp])
    expect(first.m['checkpoint_size']).toBe(charactersOf(rawContentOf(w, cp)))
    expect(first.content).not.toContain(rawContentOf(w, cp))
    expect(first.content).not.toContain(rawContentOf(w, w.ids!['brief']!))
    expect([first.m['_door'], first.m['_writer'], first.m['run'], first.m['key']]).toEqual(['hooks', 'builder', RUN, 'login-form'])
  })

  define(/^the harness looking up the key "([^"]+)" on the run "([^"]+)" counts the builder among the run's legs$/, (w, key, run) => {
    const l = legLookup(w, key!, run!)
    const leg = l.legs.find((g) => g.agentId === w.legs!['builder']!.agentId)
    expect(leg, 'the builder is a leg of the run').toBeTruthy()
    expect([leg!.state, leg!.kind, leg!.keySrc]).toEqual(['live', 'subagent', 'inferred'])
    expect(l.facts.legsRun).toBe(1)
  })

  define(/^one brief row in effect for the builder role,? naming the run "([^"]+)" and the key "([^"]+)"$/, async (w, run, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = await briefFor(w, 'builder', run!, key!, { checkpointer: 'builder' })
    expect(w.store!.briefsInEffect('builder')).toHaveLength(1)
  })

  define(/^the builder's registration carries the run "([^"]+)" and the key "([^"]+)", marked inferred(?:, with no ambiguity)?$/, (w, run, key) => {
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['run'], r['run_key'], r['key_src'], r['key_candidates'], r['kind'], r['door'], r['identity']]).toEqual([run, key, 'inferred', null, 'subagent', 'hooks', 'hook'])
  })

  define(/^a brief row for the builder role naming the key "([^"]+)" and another naming the key "([^"]+)", both in effect$/, async (w, a, b) => {
    await openRunWorld(w)
    w.ids!['brief-a'] = await briefFor(w, 'builder', RUN, a!)
    w.ids!['brief-b'] = await briefFor(w, 'builder', RUN, b!)
    expect(w.store!.briefsInEffect('builder')).toHaveLength(2)
  })

  define(/^the builder's registration says its key is ambiguous and names "([^"]+)" and "([^"]+)" as the candidates$/, (w, a, b) => {
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['key_src'], r['run_key'], r['run']]).toEqual(['ambiguous', null, RUN])
    const candidates = JSON.parse(String(r['key_candidates'])) as Array<{ run: string; key: string; briefId: string }>
    expect(candidates.map((c) => [c.run, c.key, c.briefId]).sort()).toEqual([[RUN, a, w.ids!['brief-a']], [RUN, b, w.ids!['brief-b']]].sort())
    // Its first moment names both, and starts it from neither key's checkpoint.
    const c = contextOf(w, 'builder')
    expect(c).toContain('whose key is ambiguous')
    expect(c).toContain(`"${a}" on the run "${RUN}"`)
    expect(c).toContain(`"${b}" on the run "${RUN}"`)
    expect(c).toContain(STATE_NOT_HISTORY_LINE)
  })

  define(/^a brief row for the builder role under the key "([^"]+)" on the run "([^"]+)", and a newer brief row for the builder role under the key "\1" that names it as superseded$/, async (w, key, run) => {
    await openRunWorld(w)
    w.ids!['older'] = await briefFor(w, 'builder', run!, key!, { content: 'older brief: wire the submit with a form post', at: Date.now() / 1000 - 60 })
    w.ids!['newer'] = await briefFor(w, 'builder', run!, key!, { content: 'newer brief: wire the submit through the login API', supersedes: [w.ids!['older']!] })
  })

  define(/^the builder's registration carries the key "([^"]+)", marked inferred, with no ambiguity$/, (w, key) => {
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['run_key'], r['key_src'], r['key_candidates'], r['brief_id']]).toEqual([key, 'inferred', null, w.ids!['newer']])
  })

  define(/^the context the subagent-start hook emits for the builder carries the newer brief, and the older one stays readable by its id$/, async (w) => {
    const c = contextOf(w, 'builder')
    expect(c).toContain('newer brief: wire the submit through the login API')
    expect(rawContentOf(w, w.ids!['older']!)).toContain('older brief')
    // step-lint: allow unearned-absence -- the line above proves the needle fires on the older brief's own text
    expect(c).not.toContain('older brief')
    await sessionClient(w)
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: w.ids!['older']! } }))
    expect(((read['nodes'] as Array<Record<string, unknown>>)[0]!)['content']).toBe('older brief: wire the submit with a form post')
  })

  define(/^a brief row for the builder role under the key "([^"]+)" on the run "([^"]+)", and the run "\2" closed$/, async (w, key, run) => {
    await openRunWorld(w)
    await briefFor(w, 'builder', run!, key!)
    await w.store!.closeRun({ run: run!, reason: 'the login form shipped', by: 'harness' })
  })

  define(/^a brief row for the builder role under the key "([^"]+)" on the open run "([^"]+)"$/, async (w, key, run) => {
    await briefFor(w, 'builder', run!, key!)
  })

  // ── D314, D334: a store the hook cannot reach ──

  define(/^a brief row for the builder role naming the key "([^"]+)"$/, async (w, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = await briefFor(w, 'builder', RUN, key!, { checkpointer: 'builder' })
  })

  define(/^a store that is locked for longer than the hook's time budget$/, async (w) => {
    await lockWhole(w)
  })

  define(/^the context the subagent-start hook emits for the builder carries no brief$/, (w) => {
    // The hook ran and emitted nothing at all on its stdout, which is what
    // the platform reads: no context, so no brief, though the Given wrote a
    // brief row for the role.
    expect(w.ids!['brief'], 'a brief row was written for the role').toMatch(/^[0-9a-f]{32}$/)
    expect(w.facts!['start:builder'], 'the SubagentStart hook ran for the builder').toBeTypeOf('string')
    expect((w.facts!['start:builder'] as string).trim()).toBe('')
    expect(startContext(w.facts!['start:builder'] as string)).toBeNull()
  })

  define(/^the store, once writable, holds no first-moment row for the builder and carries a capture-gap marker at the builder's start naming the dropped event$/, async (w) => {
    await unlock(w)
    await drainStaging(w)
    const agentId = w.legs!['builder']!.agentId
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?", FIRST_MOMENT_KIND, agentId)).toHaveLength(0)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE agent_id = ?', agentId)).toHaveLength(0)
    const gaps = hookGaps(w, 'subagent-start')
    expect(gaps).toHaveLength(1)
    expect([gaps[0]!.m['agent_id'], gaps[0]!.m['agent_type'], gaps[0]!.m['session_id']]).toEqual([agentId, 'builder', w.sessionId])
    expect(gaps[0]!.content).toMatch(/^\[capture gap\] The subagent-start event of the builder subagent/)
    expect(gaps[0]!.content).toContain('started cold')
  })

  // D314, D298: a store that takes the registration but refuses the
  // first-moment row. The fault is the store's own, made with raw SQL on
  // the file (no stand-in): a trigger that raises on any insert of a row
  // whose metadata kind is first-moment, so the hooks door, which writes a
  // leg's registration facts and its first moment in one transaction,
  // cannot land the one without the other.
  define(/^a store that refuses the first-moment row at the moment a builder subagent starts$/, (w) => {
    const db = new DatabaseSync(w.dbPath!)
    try {
      db.exec(`CREATE TRIGGER refuse_first_moment BEFORE INSERT ON nodes
        WHEN json_extract(NEW.metadata_json, '$.kind') = 'first-moment'
        BEGIN SELECT RAISE(ABORT, 'this store refuses the first-moment row'); END`)
    } finally { db.close() }
    expect(rawAll(w, "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'refuse_first_moment'")).toHaveLength(1)
    w.facts!['refuse-first-moment'] = true
    w.defer(() => dropFirstMomentRefusal(w))
  })

  define(/^the store, once it takes writes again, holds no leg registration and no first-moment row for the builder, and carries a capture-gap marker at the builder's start naming the dropped event$/, async (w) => {
    dropFirstMomentRefusal(w)
    expect(rawAll(w, "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'refuse_first_moment'")).toHaveLength(0)
    await drainStaging(w)
    const agentId = w.legs!['builder']!.agentId
    const firstMoments = (id: string): unknown[] => rawAll(w,
      "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment' AND json_extract(metadata_json, '$._writer_agent_id') = ?", id)
    /** The registration's leg facts: what makes a subagent a leg. */
    const legFacts = (id: string): Array<Record<string, unknown>> => rawAll<Record<string, unknown>>(w,
      `SELECT door, identity, run, run_key, key_src, key_candidates, brief_id, checkpointer, checkpointed_by, start_checkpoints
         FROM session_registry WHERE session_id = ? AND agent_id = ?`, w.sessionId, id)
    // No first-moment row for the builder.
    expect(firstMoments(agentId)).toHaveLength(0)
    // No leg registration: the builder is registered at most as a plain
    // subagent, every leg fact unset.
    const regs = legFacts(agentId)
    expect(regs.length, JSON.stringify(regs)).toBeLessThanOrEqual(1)
    for (const r of regs) expect(Object.values(r).every((v) => v === null), JSON.stringify(r)).toBe(true)
    // The marker at the builder's start, naming the dropped event and why.
    const gaps = hookGaps(w, 'subagent-start')
    expect(gaps).toHaveLength(1)
    const g = gaps[0]!
    expect([g.m['agent_id'], g.m['agent_type'], g.m['session_id']]).toEqual([agentId, 'builder', w.sessionId])
    expect(g.content).toMatch(/^\[capture gap\] The subagent-start event of the builder subagent/)
    expect(g.content).toContain('this store refuses the first-moment row')
    expect(g.content).toContain('started cold')
    // The control, after the absences are read: with the store taking the
    // row again, a builder started through the same hook is a leg with its
    // first-moment row, and the same two reads find them.
    hooksSubagent(w, 'control', 'builder')
    const control = w.legs!['control']!.agentId
    expect(firstMoments(control)).toHaveLength(1)
    const c = legFacts(control)
    expect(c.map((r) => [r['door'], r['run'], r['run_key'], r['key_src'], r['brief_id']])).toEqual([['hooks', RUN, 'login-form', 'inferred', w.ids!['brief']]])
    expect(startContext(w.facts!['start:control'] as string), 'the control builder was handed its brief').not.toBeNull()
  })

  define(/^a builder leg whose start was dropped at an unreachable store, with a capture-gap marker at its start$/, async (w) => {
    await openRunWorld(w)
    await briefFor(w, 'builder', RUN, 'login-form', { checkpointer: 'builder' })
    await lockWhole(w)
    hooksSubagent(w, 'builder', 'builder')
    await unlock(w)
    await drainStaging(w)
    expect(hookGaps(w, 'subagent-start')).toHaveLength(1)
  })

  define(/^the subagent-stop hook's output does not block the stop$/, (w) => {
    expect(w.stops!['builder']!.trim()).toBe('')
  })

  define(/^the store holds the builder's summary row and no registration for it$/, async (w) => {
    await drainStaging(w)
    const agentId = w.legs!['builder']!.agentId
    const rows = rawAll<{ node_id: string; m: string }>(w,
      "SELECT node_id, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?", SUBAGENT_SUMMARY_KIND, agentId)
    expect(rows).toHaveLength(1)
    expect(rawContentOf(w, rows[0]!.node_id)).toBe('builder stopping; no checkpoint')
    expect(JSON.parse(rows[0]!.m)['_writer']).toBe('builder')
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE agent_id = ?', agentId)).toHaveLength(0)
  })

  // ── D325: the client's cap ──

  define(/^a brief row for the builder role of (\d+) characters naming the key "([^"]+)"$/, async (w, n, key) => {
    await openRunWorld(w)
    const brief = textOf(Number(n)).replace(/^state:/, 'brief:')
    w.ids!['brief'] = await briefFor(w, 'builder', RUN, key!, { content: brief })
    expect(rawContentOf(w, w.ids!['brief']!).length).toBe(Number(n))
  })

  define(/^a checkpoint in effect under the key "([^"]+)" whose size makes the first moment (\d+) characters$/, async (w, key, chars) => {
    const size = sizeFor(w, key!, Number(chars))
    const r = await inEffectCheckpoint(w, textOf(size), { run: RUN, key: key!, declared: { role: 'builder' } })
    w.ids!['cp'] = r.nodeId
    w.facts!['chars'] = Number(chars)
    w.facts!['size'] = size
    // The store's own composition of that first moment is that long.
    const facts = w.store!.firstMomentFacts({ run: RUN, key: key!, role: 'builder', checkpointer: null, checkpointedBy: null })
    expect(composeFirstMessage(facts, null, { door: 'hooks' }).length).toBe(Number(chars))
  })

  define(/^the context the subagent-start hook emits for the builder is (the brief and the checkpoint whole, with no query made|the brief, the checkpoint up to the client's cap, the checkpoint row's id and the count of characters left out)$/, (w, injected) => {
    const c = contextOf(w, 'builder')
    const chars = w.facts!['chars'] as number
    const cp = rawContentOf(w, w.ids!['cp']!)
    expect(c).toContain(rawContentOf(w, w.ids!['brief']!))
    expect(c).toContain(STATE_NOT_HISTORY_LINE)
    if (injected!.endsWith('with no query made')) {
      expect(c.length).toBe(chars)
      expect(c).toContain(cp)
      // "with no query made", read from the staging table as the line-22
      // scenario reads it, not only from the cut marker's absence below.
      expectNoQueryMade(w)
      expect(hookCutMarker(w.ids!['cp']!, 1)).toContain('…[cut at')
      // step-lint: allow unearned-absence -- the line above proves the needle fires on the door's own cut marker
      expect(c).not.toContain('…[cut at')
    } else {
      expect(c.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
      const m = /…\[cut at the client's 10000-character hook cap: checkpoint row ([0-9a-f]{32}), (\d+) characters left out; fetch it whole with treecontext_export\]/.exec(c)
      expect(m, 'the cut marker').toBeTruthy()
      expect(m![1]).toBe(w.ids!['cp'])
      const head = `${w.facts!['size'] as number} characters${(w.facts!['size'] as number) > CHECKPOINT_CAP_CHARS ? `, ${overCapWords({ size: w.facts!['size'] as number, cap: CHECKPOINT_CAP_CHARS, second: false })}` : ''}:\n`
      const kept = c.slice(c.indexOf(head) + head.length, c.indexOf(hookCutMarker(m![1]!, Number(m![2]))))
      expect(cp.startsWith(kept)).toBe(true)
      expect(Number(m![2])).toBe(cp.length - kept.length)
      expect(kept.length).toBeGreaterThan(0)
    }
  })

  define(/^the store holds the builder's first-moment row carrying the checkpoint's size and whether it was cut$/, (w) => {
    const first = laneOf(w, 'builder').find((x) => x.kind === FIRST_MOMENT_KIND)!
    expect(first.m['checkpoint_size']).toBe(w.facts!['size'])
    const fm = first.m['first_moment'] as Record<string, unknown>
    const chars = w.facts!['chars'] as number
    if (chars <= HOOK_CONTEXT_CAP) {
      expect(fm['cut']).toBeNull()
      expect(fm['message_chars']).toBe(chars)
    } else {
      const cut = fm['cut'] as { cap: number; whole_chars: number; checkpoints: Array<{ node_id: string; left_out: number; size: number }> }
      expect([cut.cap, cut.whole_chars]).toEqual([HOOK_CONTEXT_CAP, chars])
      expect(cut.checkpoints.map((c) => [c.node_id, c.size])).toEqual([[w.ids!['cp'], w.facts!['size']]])
      expect(cut.checkpoints[0]!.left_out).toBeGreaterThan(0)
    }
  })

  define(/^a builder leg whose first moment carried checkpoint number (\d+) cut at the client's cap, with its row id$/, async (w, num) => {
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, 'login-form', Number(num) - 1)
    const r = await inEffectCheckpoint(w, textOf(17000), { run: RUN, key: 'login-form', declared: { role: 'builder' }, supersedes: [ids.at(-1)!] })
    expect(r.checkpoint!.number).toBe(Number(num))
    w.ids!['cp'] = r.nodeId
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key: 'login-form', checkpointer: 'builder' })
    const c = contextOf(w, 'builder')
    const m = /checkpoint row ([0-9a-f]{32}), (\d+) characters left out/.exec(c)
    expect(m?.[1]).toBe(r.nodeId)
    w.facts!['cut-id'] = m![1]
  })

  define(/^the builder exports that row by id$/, async (w) => {
    await sessionClient(w)
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: w.facts!['cut-id'] as string } }))
    w.facts!['exported'] = (read['nodes'] as Array<Record<string, unknown>>)[0]
  })

  define(/^the builder receives checkpoint number (\d+) whole, all (\d+) characters$/, (w, num, n) => {
    const node = w.facts!['exported'] as Record<string, unknown>
    expect(String(node['content']).length).toBe(Number(n))
    expect(node['content']).toBe(rawContentOf(w, w.ids!['cp']!))
    expect((node['metadata'] as Record<string, unknown>)['_checkpoint_number']).toBe(Number(num))
  })

  // ── D326: only a key the leg made its own asks ──

  define(/^a builder subagent spawned for a quick lookup, registered with the key "([^"]+)" marked inferred$/, async (w, key) => {
    hooksSubagent(w, 'builder', 'builder')
    await sessionClient(w)
    const r = rawRegistration(w, w.legs!['builder']!)
    // Its brief names it the checkpointer: only the inferred key spares it.
    expect([r['run_key'], r['key_src'], r['checkpointer']]).toEqual([key, 'inferred', 'builder'])
  })

  define(/^the builder wrote one row under the key "([^"]+)", so its registration carries the key marked as the leg's own$/, async (w, key) => {
    await makeKeyOwn(w, 'builder', 'builder', key!)
  })

  // ── D328: the cut known at the session's next start ──

  define(/^a builder leg under the key "([^"]+)" registered live, whose stop hook never fired$/, async (w, key) => {
    await openRunWorld(w)
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key: key!, checkpointer: 'builder' })
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['stopped_at'], r['ended']]).toEqual([null, null])
  })

  define(/^the session starts again and its session-start hook fires$/, (w) => {
    w.moments!['restart'] = Date.now() / 1000
    sessionStartHook(w, 'resume')
    w.moments!['restarted'] = Date.now() / 1000
  })

  define(/^the builder leg's registration reads cut, with the moment it was noticed and the session start as what noticed it, and no guessed exit time$/, (w) => {
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['ended'], r['noticed_by'], r['stopped_at']]).toEqual(['cut', NOTICED_BY_SESSION_START, null])
    expect(r['noticed_at'] as number).toBeGreaterThanOrEqual(w.moments!['restart']!)
    expect(r['noticed_at'] as number).toBeLessThanOrEqual(w.moments!['restarted']!)
  })

  define(/^the context the subagent-start hook emits for the next builder under "([^"]+)" says its predecessor was cut$/, (w, key) => {
    hooksSubagent(w, 'next', 'builder')
    expect(rawRegistration(w, w.legs!['next']!)['run_key']).toBe(key)
    const prev = w.legs!['builder']!
    expect(contextOf(w, 'next')).toContain(`your predecessor, the builder leg in the lane of session ${prev.sessionId}, agent ${prev.agentId}, was cut`)
  })

  // ── D329: two in effect, handed both ──

  define(/^checkpoint number (\d+) and checkpoint number (\d+) both in effect under the key "([^"]+)", and a brief row naming the reviewer as the checkpointer$/, async (w, a, b, key) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key!, Number(a))
    const r = await w.store!.writeCheckpoint('state: reviewed independently; three findings', { run: RUN, key: key!, declared: { role: 'reviewer' } })
    expect(r.checkpoint!.number).toBe(Number(b))
    w.cps![cpLabel(RUN, key!, Number(b))] = r.nodeId
    expect(w.store!.checkpointsInEffect(RUN, key!).map((c) => c.number)).toEqual([Number(a), Number(b)])
    await briefFor(w, 'reviewer', RUN, key!, { checkpointer: 'reviewer' })
  })

  define(/^the context the subagent-start hook emits for the reviewer carries both number (\d+) and number (\d+) and a line saying two are in effect$/, (w, a, b) => {
    const c = contextOf(w, 'reviewer')
    expect(c).toContain(`2 checkpoints are in effect under "login-form" on the run "${RUN}" (number ${a} and number ${b})`)
    for (const n of [a, b]) {
      const id = w.cps![cpLabel(RUN, 'login-form', Number(n))]!
      expect(c).toContain(`Checkpoint number ${n} under "login-form" (row ${id})`)
      expect(c).toContain(rawContentOf(w, id))
    }
    // Flagged: the builder's is not the reviewer's, the checkpointer named.
    expect(c).toContain(`The writer of checkpoint number ${a}, "builder", is not the checkpointer the brief names ("reviewer").`)
    // step-lint: allow unearned-absence -- the line above proves the same sentence fires for number ${a}
    expect(c).not.toContain(`The writer of checkpoint number ${b},`)
  })

  define(/^the store holds the reviewer's first-moment row referencing both checkpoint rows by id$/, (w) => {
    const first = laneOf(w, 'reviewer')[0]!
    expect(first.kind).toBe(FIRST_MOMENT_KIND)
    const refs = first.m['refs'] as string[]
    expect(refs).toContain(w.cps![cpLabel(RUN, 'login-form', 4)])
    expect(refs).toContain(w.cps![cpLabel(RUN, 'login-form', 5)])
    expect(((first.m['first_moment'] as Record<string, unknown>)['flags'] as string[])).toHaveLength(1)
  })

  // ── D332: the state-not-history line ──

  define(/^a brief row for the builder role under the key "([^"]+)" that says nothing about checkpoints$/, async (w, key) => {
    await openRunWorld(w)
    const id = await briefFor(w, 'builder', RUN, key!, { content: 'wire the submit button and its tests' })
    expect(STATE_NOT_HISTORY_LINE, 'the checkpoint needle is dead').toMatch(/checkpoint/i)
    // step-lint: allow unearned-absence -- the line above proves the needle fires on the state-not-history line
    expect(rawContentOf(w, id)).not.toMatch(/checkpoint/i)
  })

  define(/^the context the subagent-start hook emits for the builder says a checkpoint is the state of the work as it now stands, names what it supersedes and rests on, and never pastes the history in$/, (w) => {
    const c = contextOf(w, 'builder')
    expect(c).toContain(STATE_NOT_HISTORY_LINE)
    // The three things the scenario says the line says, each in the
    // emitted context itself, not only as the source's constant reads.
    for (const words of ['state of the work as it now stands', 'what it supersedes and what it rests on', 'never pastes the history in']) expect(c).toContain(words)
  })

  // ── D334: after the one send-back, a recovery leg ──

  define(/^a builder leg under the key "([^"]+)", started from checkpoint number (\d+), sent back once and stopped again with no checkpoint$/, async (w, key, num) => {
    expect(num).toBe('3')
    await owingBuilder(w, key!)
    stopLeg(w, 'builder', 'builder', 'stopping without the checkpoint')
    expect(blocks(w.stops!['builder']!)).toBe(true)
    // As the platform sends the stop after a block.
    stopLeg(w, 'builder', 'builder', 'still nothing to checkpoint; stopping', true)
    expect(blocks(w.stops!['builder']!)).toBe(false)
    expect(rawRegistration(w, w.legs!['builder']!)['ended']).toBe('retired')
  })

  define(/^the context the subagent-start hook emits for the new builder says its predecessor ended without a checkpoint, names its predecessor's lane, and names checkpoint number (\d+) as the one in effect$/, (w, num) => {
    const c = contextOf(w, 'next')
    const prev = w.legs!['builder']!
    const rows = laneOf(w, 'builder').filter((x) => x.kind !== FIRST_MOMENT_KIND && x.kind !== SEND_BACK_KIND).length
    expect(c).toContain(recoveryLine({ sessionId: prev.sessionId, agentId: prev.agentId, role: 'builder', ended: 'retired', rows }, 'login-form'))
    expect(c).toContain(`Checkpoint number ${num} is in effect under "login-form" on the run "${RUN}".`)
  })

  // ── D299, D321, D332: the checkpoint cap ──

  define(/^a builder leg under the key "([^"]+)"$/, async (w, key) => {
    await cappedBuilder(w, key!)
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['run'], r['run_key'], r['key_src'], r['checkpointer']]).toEqual([RUN, key, 'inferred', 'builder'])
    expect(rawCheckpoints(w, RUN, key!)).toHaveLength(0)
  })

  define(/^the builder writes a checkpoint of (\d+) characters twice in a row$/, async (w, chars) => {
    const n = Number(chars)
    for (const i of [0, 1]) {
      const text = variant(n, i)
      expect(charactersOf(text)).toBe(n)
      const seen = await writeSeen(w, 'builder', 'builder', 'login-form', text)
      noteWrite(w, 'builder', seen, 'login-form')
      // The first write's echo is drained before the second goes in, as
      // the drain runs between a leg's calls.
      await drainStaging(w)
    }
    w.facts!['chars'] = n
  })

  define(/^the builder sees the (first|second) write (accepted|accepted and marked over the cap|refused with the reason and the shape asked for)$/, (w, which, verdict) => {
    const i = which === 'first' ? 0 : 1
    const seen = seenOf(w, 'builder', i)
    const n = w.facts!['chars'] as number
    const key = 'login-form'
    const landedBefore = i === 0 ? 0 : (w.facts!['rows-after:builder:0'] as number)
    const rowsAfter = w.facts![`rows-after:builder:${i}`] as number
    if (verdict === 'refused with the reason and the shape asked for') {
      expectReasonAndShape(seen, n, key)
      // Nothing landed: the file holds no checkpoint row for this write.
      expect(rowsAfter).toBe(landedBefore)
      // The registration records the refusal, by run and key, with the size.
      expect(capRefusedOf(w, w.legs!['builder']!)).toEqual([expect.objectContaining({ run: RUN, key, size: n })])
      return
    }
    expect(seen.refused).toBe(false)
    expect(seen.isError).toBe(false)
    expect(rowsAfter).toBe(landedBefore + 1)
    expect(seen.nodeId, 'a checkpoint row').toMatch(/^[0-9a-f]{32}$/)
    // Numbered as any checkpoint: one past what had landed under the key.
    expect(seen.number).toBe(landedBefore + 1)
    const row = rawMetaOf(w, seen.nodeId!)
    expect([row['kind'], row['run'], row['key']]).toEqual(['checkpoint', RUN, key])
    expect(row['_checkpoint_number']).toBe(seen.number)
    const size = charactersOf(rawContentOf(w, seen.nodeId!))
    if (verdict === 'accepted') {
      // Within the cap: never refused, never marked.
      expect(size).toBeLessThanOrEqual(CHECKPOINT_CAP_CHARS)
      expect(seen.overCap).toBeNull()
      expect(row[OVER_CAP_KEY]).toBeUndefined()
      expect(capRefusedOf(w, w.legs!['builder']!)).toEqual([])
    } else {
      // Over the cap on the second write: accepted, numbered as any
      // checkpoint, and marked by the store with its size and the cap.
      expect(size).toBeGreaterThan(CHECKPOINT_CAP_CHARS)
      expect(row[OVER_CAP_KEY]).toEqual({ size, cap: CHECKPOINT_CAP_CHARS, second: true })
      expect(seen.overCap).toEqual({ size, cap: CHECKPOINT_CAP_CHARS, second: true })
      expect(capRefusedOf(w, w.legs!['builder']!)).toEqual([expect.objectContaining({ run: RUN, key, size })])
    }
  })

  define(/^a builder leg whose (\d+)-character checkpoint under the key "([^"]+)" was refused once$/, async (w, chars, key) => {
    await cappedBuilder(w, key!)
    const seen = await writeSeen(w, 'builder', 'builder', key!, variant(Number(chars), 0))
    noteWrite(w, 'builder', seen, key!)
    await drainStaging(w)
    expectReasonAndShape(seen, Number(chars), key!)
    expect(capRefusedOf(w, w.legs!['builder']!)).toEqual([expect.objectContaining({ run: RUN, key, size: Number(chars) })])
    w.facts!['refused-size'] = Number(chars)
  })

  define(/^the reviewer leg writes a (\d+)-character checkpoint under the key "([^"]+)", and the builder writes one under the key "([^"]+)"$/, async (w, chars, key, other) => {
    const n = Number(chars)
    // The reviewer starts beside the builder, both live: the insert cannot
    // say which of them called (an ambiguous stamp), so each refusal is
    // pending until its call's own echo, read at the drain, names the caller.
    await hooksLeg(w, 'reviewer', 'reviewer', { run: RUN, key: key!, checkpointer: 'reviewer' })
    w.facts!['seen:reviewer'] = await writeSeen(w, 'reviewer', 'reviewer', key!, variant(n, 0))
    await drainStaging(w)
    w.facts!['seen:builder-other'] = await writeSeen(w, 'builder', 'builder', other!, variant(n, 1))
    await drainStaging(w)
  })

  define(/^the reviewer sees its write refused with the reason and the shape asked for$/, (w) => {
    const seen = w.facts!['seen:reviewer'] as Seen
    expectReasonAndShape(seen, 20000, 'login-form')
    // After the drain the refusal sits on the reviewer's registration, not on the session's self.
    expect(capRefusedOf(w, w.legs!['reviewer']!)).toEqual([expect.objectContaining({ run: RUN, key: 'login-form', size: 20000, src: 'echo' })])
    expect(capRefusedOf(w, { sessionId: w.sessionId!, agentId: '' })).toEqual([])
  })

  define(/^the builder sees its write under "([^"]+)" refused with the reason and the shape asked for$/, (w, key) => {
    const seen = w.facts!['seen:builder-other'] as Seen
    expectReasonAndShape(seen, 20000, key!)
    // The builder's earlier refusal under "login-form" stands beside the new one.
    expect(capRefusedOf(w, w.legs!['builder']!).map((e) => [e.key, e.size, e.src])).toEqual([['login-form', 20000, 'echo'], [key, 20000, 'echo']])
    expect(capRefusedOf(w, { sessionId: w.sessionId!, agentId: '' })).toEqual([])
    // No checkpoint row anywhere: all three writes were refused.
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")).toHaveLength(0)
  })

  define(/^a builder leg named as checkpointer whose (\d+)-character checkpoint under the key "([^"]+)" was refused once$/, async (w, chars, key) => {
    await cappedBuilder(w, key!)
    const seen = await writeSeen(w, 'builder', 'builder', key!, variant(Number(chars), 0))
    expectReasonAndShape(seen, Number(chars), key!)
    const r = rawRegistration(w, w.legs!['builder']!)
    // Not drained: the refusal is pending on the registration the stamp named,
    // its call's echo staged, and the stop hook reads that echo itself.
    expect([r['key_src'], r['checkpointer'], r['send_backs']]).toEqual(['inferred', 'builder', 0])
    expect(capRefusedOf(w, w.legs!['builder']!)).toEqual([expect.objectContaining({ src: 'pending', size: Number(chars) })])
    expect(rawCheckpoints(w, RUN, key!)).toHaveLength(0)
    w.facts!['refused-size'] = Number(chars)
  })

  define(/^the builder stops without writing again$/, (w) => {
    stopLeg(w, 'builder', 'builder', 'stopping; the checkpoint was refused')
  })

  // D321: the over-the-cap mark is the store's alone. A leg that puts its
  // own `_over_cap` in a checkpoint's metadata is not believed: the row
  // carries no mark, and the lookup reads no mark.
  define(/^the leg writes a (\d+)-character checkpoint carrying its own over-the-cap mark in its metadata$/, async (w, chars) => {
    const n = Number(chars)
    const text = textOf(n)
    expect(charactersOf(text)).toBe(n)
    const leg = w.legs!['builder']!
    await sessionClient(w)
    // The leg's own forged mark, in the shape the store's mark takes.
    const forged = { size: 20000, cap: 16000, second: true }
    const input = { content: text, metadata: { kind: 'checkpoint', run: RUN, key: 'login-form', _over_cap: forged } }
    const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
    runHookEcho(w, leg, 'builder', input, res)
    await drainStaging(w)
    const r = parseTool(res)
    expect(r['refused'], JSON.stringify(r)).not.toBe(true)
    expect(r['node_id'], JSON.stringify(r)).toMatch(/^[0-9a-f]{32}$/)
    w.ids!['self-marked'] = r['node_id'] as string
    w.facts!['self-marked-request'] = input.metadata
    w.facts!['self-marked-size'] = n
  })

  define(/^the store accepts the checkpoint as number (\d+) with no over-the-cap mark on it$/, (w, num) => {
    const id = w.ids!['self-marked']!
    // The row as the file holds it, read through a separate handle.
    const m = rawMetaOf(w, id)
    expect([m['kind'], m['run'], m['key'], m['_checkpoint_number']]).toEqual(['checkpoint', RUN, 'login-form', Number(num)])
    expect(rawCheckpoints(w, RUN, 'login-form').map((c) => [c.node_id, c.n])).toEqual([[id, Number(num)]])
    expect(charactersOf(rawContentOf(w, id))).toBe(w.facts!['self-marked-size'])
    // The control: the request did carry the mark under that very key, so
    // the absence below is the store dropping it, not a mark never sent.
    const sent = w.facts!['self-marked-request'] as Record<string, unknown>
    expect(Object.hasOwn(sent, '_over_cap')).toBe(true)
    expect(sent['_over_cap']).toEqual({ size: 20000, cap: 16000, second: true })
    expect(Object.hasOwn(m, '_over_cap'), JSON.stringify(m)).toBe(false)
    // Nor under any other spelling: no key of the row holds the forged mark.
    expect(Object.entries(m).filter(([, v]) => JSON.stringify(v) === JSON.stringify(sent['_over_cap'])), JSON.stringify(m)).toEqual([])
  })

  define(/^the harness looking up the key "([^"]+)" receives it with size (\d+) and no mark$/, (w, key, size) => {
    const l = legLookup(w, key!)
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([w.ids!['self-marked']])
    const cp = l.checkpoints[0]!
    expect([cp.number, cp.size, cp.overCap]).toEqual([1, Number(size), null])
    // The agent's door and the harness's are one reply (D337).
    const reply = keyLookupReply(l).checkpoints[0]!
    expect([reply.size, reply.over_cap]).toEqual([Number(size), null])
  })

  define(/^a builder leg whose second write of a (\d+)-character checkpoint under the key "([^"]+)" was accepted$/, async (w, chars, key) => {
    await cappedBuilder(w, key!)
    const n = Number(chars)
    const first = await writeSeen(w, 'builder', 'builder', key!, variant(n, 0))
    await drainStaging(w)
    const second = await writeSeen(w, 'builder', 'builder', key!, variant(n, 1))
    await drainStaging(w)
    expect([first.refused, second.refused]).toEqual([true, false])
    expect(second.overCap).toEqual({ size: n, cap: CHECKPOINT_CAP_CHARS, second: true })
    w.ids!['over-cap-checkpoint'] = second.nodeId!
    w.facts!['over-cap-size'] = n
    w.facts!['over-cap-text'] = variant(n, 1)
    // The leg finishes: a checkpoint exists, so it is not sent back.
    stopLeg(w, 'builder', 'builder', 'submit wired; the long state is written')
    expect(blocks(w.stops!['builder']!)).toBe(false)
  })

  define(/^the harness looks up the key "([^"]+)" and the next builder leg starts under it$/, (w, key) => {
    legLookup(w, key!)
    hooksSubagent(w, 'next', 'builder')
  })

  define(/^the harness receives that checkpoint whole, marked as over the cap, with its size (\d+)$/, (w, size) => {
    const l = w.lookups![RUN]!
    expect(l.checkpoints).toHaveLength(1)
    const cp = l.checkpoints[0]!
    expect(cp.nodeId).toBe(w.ids!['over-cap-checkpoint'])
    expect(cp.content).toBe(w.facts!['over-cap-text'])
    expect([cp.size, cp.overCap]).toEqual([Number(size), { size: Number(size), cap: CHECKPOINT_CAP_CHARS, second: true }])
    // The agent's door and the harness's are one reply (D337).
    const reply = keyLookupReply(l).checkpoints[0]!
    expect([reply.size, reply.over_cap, reply.content]).toEqual([Number(size), { size: Number(size), cap: CHECKPOINT_CAP_CHARS, second: true }, w.facts!['over-cap-text']])
    expect(rawMetaOf(w, cp.nodeId)[OVER_CAP_KEY]).toEqual({ size: Number(size), cap: CHECKPOINT_CAP_CHARS, second: true })
  })

  define(/^the store holds the next builder's first-moment row carrying the checkpoint size (\d+)$/, (w, size) => {
    const first = laneOf(w, 'next').find((x) => x.kind === FIRST_MOMENT_KIND)
    expect(first, 'the next builder\'s first-moment row').toBeTruthy()
    expect(first!.m['checkpoint_size']).toBe(Number(size))
    // What it cost: the mark rides on the row and on the checkpoint it names.
    expect(first!.m['checkpoint_over_cap']).toBe(true)
    const fm = first!.m['first_moment'] as { checkpoints: Array<Record<string, unknown>> }
    expect(fm.checkpoints.map((c) => [c['node_id'], c['size'], c['over_cap']])).toEqual([
      [w.ids!['over-cap-checkpoint'], Number(size), { size: Number(size), cap: CHECKPOINT_CAP_CHARS, second: true }],
    ])
    expect(first!.m['refs']).toContain(w.ids!['over-cap-checkpoint'])
    // And the first message the leg was handed says so in words, cut at the
    // client's cap with the row id, as it is for any checkpoint that long.
    const c = contextOf(w, 'next')
    expect(c).toContain(`${Number(size)} characters, ${overCapWords({ size: Number(size), cap: CHECKPOINT_CAP_CHARS, second: true })}:`)
    expect(c).toContain(`checkpoint row ${w.ids!['over-cap-checkpoint']}`)
    expect(c.length).toBeLessThanOrEqual(HOOK_CONTEXT_CAP)
  })
}
