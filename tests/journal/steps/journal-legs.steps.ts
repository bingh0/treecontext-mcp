import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { parseTool, rawAll } from '../world.js'
import { drainStaging, runHook, bashPayload } from '../capture-harness.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { keyLookupReply } from '../../../src/key-lookup.js'
import {
  type RunWorld, openRunWorld, seedCheckpoints, sessionClient, insertEchoed, subagentStopHook, blocks,
  rawOne, rawMetaOf, rawRowOf, rawRegistration, rawCheckpoints, cpLabel, stringSteps, subagentStartHook, briefFor, agentToolReturns,
} from '../run-world.js'
import { hooksLeg, workerLeg, retiredWithoutReturn } from '../standins.js'
import { hooksDoorSteps } from './journal-legs-hooks.steps.js'

// ── journal-legs ────────────────────────────────────────────────────────
//
// The leg contract's storage half (D280, D284, D305, D320, D329, D331): a
// checkpoint is numbered by the store when it lands, supersedes what its
// writer names or, naming nothing, what the leg's registration says it
// started from, marked as the store's; two in effect come back as two.
//
// A leg here runs through the hooks door as Claude Code drives it: the
// real SessionStart hook registers the session's self, and the real
// SubagentStart hook registers the subagent under the PARENT's session
// and, reading the brief in effect for its role, makes it a leg of that
// brief's run and key, marked inferred, starting from the checkpoint(s)
// then in effect (the hooks door, unit 4; journal-legs-hooks.steps.ts
// binds the door's own scenarios).
// The leg writes through the real MCP insert tool on the session's one
// connection, and the call's own PostToolUse echo makes its writer exact
// at the drain; it stops through the real SubagentStop hook. Earlier
// checkpoints of a key are written through the library's own checkpoint
// writer by a declared role. Every Then reads the store file, the
// harness's lookup, a hook's stdout, or the agent's own tools.

export type LegsWorld = RunWorld

const RUN = 'r1'

function lookup(w: LegsWorld, key: string, run = RUN) {
  const l = w.store!.lookupKey({ run, key })
  w.lookups![run] = l
  return l
}

/** The checkpoint a leg wrote, by its number under the key. */
function cpNumbered(w: LegsWorld, key: string, n: number, run = RUN): string {
  const row = rawCheckpoints(w, run, key).find((c) => c.n === n)
  expect(row, `no checkpoint number ${n} under "${key}" in the store file`).toBeTruthy()
  return row!.node_id
}

/** A leg through the hooks door that started from the checkpoint in
 *  effect, with the MCP connection its session's subagents share. */
async function legFrom(w: LegsWorld, name: string, role: string, key: string, start: string[]): Promise<void> {
  const ref = await hooksLeg(w, name, role, { run: RUN, key, checkpointer: role })
  // The hook inferred the leg from the brief: its start is what was then
  // in effect, which is the checkpoint the Given names.
  const r = rawRegistration(w, ref)
  expect([r['run'], r['run_key'], r['key_src'], r['door']]).toEqual([RUN, key, 'inferred', 'hooks'])
  expect(JSON.parse(String(r['start_checkpoints']))).toEqual(start)
  await sessionClient(w)
}

async function writeAsLeg(w: LegsWorld, name: string, role: string, text: string, key: string, supersedes?: string[]): Promise<Record<string, unknown>> {
  const leg = w.legs![name]!
  const reply = await insertEchoed(w, { agentId: leg.agentId, agentType: role }, text, { kind: 'checkpoint', run: RUN, key }, supersedes)
  w.ids![`${name}-checkpoint`] = reply['node_id'] as string
  return reply
}

function stop(w: LegsWorld, name: string, role: string, report: string): void {
  w.stops![name] = subagentStopHook(w, w.legs![name]!.agentId, role, report)
}

/** A builder subagent started through the real SubagentStart hook, the
 *  hooks door making of it what the store's briefs say. */
function subagentStartBuilder(w: LegsWorld): void {
  const agentId = `abuilder${Math.random().toString(16).slice(2, 10)}`
  w.facts!['start:builder'] = subagentStartHook(w, agentId, 'builder')
  w.legs!['builder'] = { sessionId: w.sessionId!, agentId }
}

export const legsDefiner = (reg: Registry<LegsWorld>): void => {
  const define = stringSteps(reg)
  hooksDoorSteps(define)

  // ── D284, D331: the checkpoint a leg writes at its end ──

  define(/^a builder leg (?:under the run "([^"]+)" )?that started from checkpoint number (\d+) under the key "([^"]+)"$/, async (w, run, num, key) => {
    if (run) expect(run).toBe(RUN)
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, key, Number(num))
    w.before!['start'] = rawRowOf(w, ids.at(-1)!)
    await legFrom(w, 'builder', 'builder', key, [ids.at(-1)!])
  })

  define(/^the (builder|recovery builder) writes the checkpoint "([^"]+)" and stops$/, async (w, who, text) => {
    const name = who === 'builder' ? 'builder' : 'recovery'
    await writeAsLeg(w, name, 'builder', text, 'login-form')
    stop(w, name, 'builder', 'submit wired; validation next')
    await drainStaging(w)
  })

  define(/^the builder writes the checkpoint "([^"]+)" naming nothing as superseded$/, async (w, text) => {
    const reply = await writeAsLeg(w, 'builder', 'builder', text, 'login-form')
    // The tool says back what it stored: numbered, superseding the start.
    expect((reply['checkpoint'] as Record<string, unknown>)['supersedes_src']).toBe('store')
    await drainStaging(w)
  })

  // The hooks door's stop (D279, D281, D326): read from the hook's own
  // stdout, which the platform reads.
  define(/^the ([a-z-]+)'s stop is not blocked$/, (w, name) => {
    expect(w.stops![name!], `the ${name} SubagentStop hook ran`).toBeDefined()
    expect(blocks(w.stops![name!]!)).toBe(false)
  })

  define(/^the harness looking up the key "([^"]+)" receives checkpoint number (\d+), superseding number (\d+)$/, (w, key, num, prev) => {
    const l = lookup(w, key)
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(num)])
    const cp = l.checkpoints[0]!
    expect(cp.nodeId).toBe(w.ids!['builder-checkpoint'])
    expect(cp.supersedes).toEqual([w.cps![cpLabel(RUN, key, Number(prev))]])
    const m = rawMetaOf(w, cp.nodeId)
    expect([m['_checkpoint_number'], m['supersedes']]).toEqual([Number(num), [w.cps![cpLabel(RUN, key, Number(prev))]]])
  })

  define(/^checkpoint number (\d+) carries the writer "([^"]+)" stamped by the store, its moment, the run "([^"]+)" and the builder's lane$/, (w, num, writer, run) => {
    const id = cpNumbered(w, 'login-form', Number(num), run)
    const row = rawOne<{ created_at: number; session_key: string; m: string }>(w, 'SELECT created_at, session_key, metadata_json AS m FROM nodes WHERE node_id = ?', id)!
    const m = JSON.parse(row.m) as Record<string, unknown>
    expect(m['_writer']).toBe(writer)
    // Stamped by the store: provisional at insert, exact from the call's echo.
    expect(m['_writer_src']).toBe('echo')
    expect(typeof row.created_at).toBe('number')
    expect(row.created_at).toBeGreaterThan(Date.now() / 1000 - 600)
    expect(m['run']).toBe(run)
    // The builder's lane: its session and its own agent id.
    expect([row.session_key, m['_writer_agent_id']]).toEqual([w.sessionId, w.legs!['builder']!.agentId])
  })

  define(/^checkpoint number (\d+) is unchanged byte for byte$/, (w, num) => {
    const id = w.cps![cpLabel(RUN, 'login-form', Number(num))]!
    expect(rawRowOf(w, id)).toEqual(w.before!['start'])
  })

  define(/^the harness looking up the key "([^"]+)" receives that checkpoint as number (\d+), superseding number (\d+), with the supersession marked as stamped by the store$/, (w, key, num, prev) => {
    const l = lookup(w, key)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number])).toEqual([[w.ids!['builder-checkpoint'], Number(num)]])
    const m = rawMetaOf(w, w.ids!['builder-checkpoint']!)
    expect(m['supersedes']).toEqual([w.cps![cpLabel(RUN, key, Number(prev))]])
    expect(m['_supersedes_src']).toBe('store')
  })

  define(/^number (\d+) is no longer in effect$/, (w, num) => {
    const l = w.lookups![RUN]!
    const id = w.cps![cpLabel(RUN, 'login-form', Number(num))]!
    expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(id)
    expect(w.store!.checkpointsInEffect(RUN, 'login-form').map((c) => c.nodeId)).not.toContain(id)
  })

  // ── D331: a checkpoint that names another is taken at its word ──

  define(/^checkpoint number (\d+) under the key "([^"]+)", and a reviewer leg that started from it$/, async (w, num, key) => {
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, key, Number(num))
    await legFrom(w, 'reviewer', 'reviewer', key, [ids.at(-1)!])
  })

  define(/^the reviewer writes checkpoint number (\d+) naming number (\d+) as superseded$/, async (w, _num, prev) => {
    await writeAsLeg(w, 'reviewer', 'reviewer', 'state: original plus review; two fixes asked for', 'login-form', [w.cps![cpLabel(RUN, 'login-form', Number(prev))]!])
    await drainStaging(w)
  })

  define(/^the harness looking up the key "([^"]+)" receives number (\d+), superseding number (\d+), with the supersession marked as written by the leg$/, (w, key, num, prev) => {
    const l = lookup(w, key)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number])).toEqual([[w.ids!['reviewer-checkpoint'], Number(num)]])
    const m = rawMetaOf(w, w.ids!['reviewer-checkpoint']!)
    expect(m['supersedes']).toEqual([w.cps![cpLabel(RUN, key, Number(prev))]])
    expect(m['_supersedes_src']).toBe('writer')
  })

  // ── D280: which checkpoint is in effect ──

  define(/^checkpoint number (\d+) under the key "([^"]+)", written by the builder role$/, async (w, num, key) => {
    await openRunWorld(w, { sessionStart: false })
    await seedCheckpoints(w, RUN, key, Number(num))
    expect(rawMetaOf(w, w.cps![cpLabel(RUN, key, Number(num))]!)['_writer']).toBe('builder')
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)", written by the reviewer role, that names nothing as superseded$/, async (w, num, key) => {
    const r = await w.store!.writeCheckpoint('state: reviewed independently; three findings', { run: RUN, key, declared: { role: 'reviewer' } })
    expect(r.checkpoint!.number).toBe(Number(num))
    w.cps![cpLabel(RUN, key, Number(num))] = r.nodeId
    const m = rawMetaOf(w, r.nodeId)
    expect(m['supersedes']).toBeUndefined()
  })

  define(/^the harness looks up the key "([^"]+)"$/, (w, key) => {
    lookup(w, key)
  })

  define(/^the harness (?:looking up the key "([^"]+)" )?receives both number (\d+) and number (\d+) and a line saying two are in effect$/, (w, key, a, b) => {
    const k = key ? key : 'login-form'
    const l = key ? lookup(w, k) : w.lookups![RUN]!
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(a), Number(b)])
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([cpNumbered(w, k, Number(a)), cpNumbered(w, k, Number(b))])
    expect(l.line).toMatch(/^2 checkpoints are in effect/)
  })

  define(/^the reviewer role writes checkpoint number (\d+) under the key "([^"]+)" naming number (\d+) as superseded$/, async (w, _num, key, prev) => {
    const r = await w.store!.writeCheckpoint('state: original plus review; two fixes asked for', {
      run: RUN, key, declared: { role: 'reviewer' }, supersedes: [w.cps![cpLabel(RUN, key, Number(prev))]!],
    })
    w.ids!['review'] = r.nodeId
  })

  define(/^the harness looking up the key "([^"]+)" receives checkpoint number (\d+) with the writer "([^"]+)"$/, (w, key, num, writer) => {
    const l = lookup(w, key)
    const id = w.ids!['review'] ?? w.ids!['recovery-checkpoint'] ?? w.ids!['builder-checkpoint']
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[id, Number(num), writer]])
    expect(rawMetaOf(w, id!)['_writer']).toBe(writer)
  })

  define(/^checkpoint number (\d+) is still readable by its id$/, async (w, num) => {
    await sessionClient(w)
    const id = w.cps![cpLabel(RUN, 'login-form', Number(num))]!
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: id } }))
    const nodes = read['nodes'] as Array<Record<string, unknown>>
    expect(nodes.map((n) => n['nodeId'] ?? n['node_id'])).toEqual([id])
    expect((nodes[0]!['metadata'] as Record<string, unknown>)['_checkpoint_number']).toBe(Number(num))
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)" that supersedes number (\d+) and rests on (\d+) trail entries$/, async (w, num, key, prev, n) => {
    await openRunWorld(w, { sessionStart: false })
    await seedCheckpoints(w, RUN, key, Number(prev))
    const trail: string[] = []
    for (let i = 0; i < Number(n); i++) {
      trail.push((await w.store!.insert(`npx vitest run login-${i}: case ${i} green`, {
        metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: w.sessionId },
      })).nodeId)
    }
    const r = await w.store!.writeCheckpoint('state: original plus review; the trail below explains the two fixes', {
      run: RUN, key, declared: { role: 'reviewer' }, supersedes: [w.cps![cpLabel(RUN, key, Number(prev))]!], restsOn: trail,
    })
    expect(r.checkpoint!.number).toBe(Number(num))
    w.cps![cpLabel(RUN, key, Number(num))] = r.nodeId
    w.facts!['trail'] = trail
  })

  define(/^a reader walks from checkpoint number (\d+)$/, async (w, num) => {
    await sessionClient(w)
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: w.cps![cpLabel(RUN, 'login-form', Number(num))]! } }))
    w.facts!['walked'] = (read['nodes'] as Array<Record<string, unknown>>)[0]
  })

  define(/^the reader reaches checkpoint number (\d+) by its supersedes reference and the (\d+) entries checkpoint number (\d+) rests on, each fetched by its id$/, async (w, prev, n, num) => {
    const meta = (w.facts!['walked'] as Record<string, unknown>)['metadata'] as Record<string, unknown>
    expect(meta['_checkpoint_number']).toBe(Number(num))
    const fetch = async (id: string): Promise<Record<string, unknown>> => {
      const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: id } }))
      return (read['nodes'] as Array<Record<string, unknown>>)[0]!
    }
    const sup = meta['supersedes'] as string[]
    expect(sup).toHaveLength(1)
    const back = await fetch(sup[0]!)
    expect((back['metadata'] as Record<string, unknown>)['_checkpoint_number']).toBe(Number(prev))
    const restsOn = meta['refs'] as string[]
    expect(restsOn).toEqual(w.facts!['trail'])
    expect(restsOn).toHaveLength(Number(n))
    for (const id of restsOn) expect(String((await fetch(id))['content'])).toMatch(/^npx vitest run login-\d: case \d green$/)
  })

  // ── D329: two legs from one checkpoint ──

  define(/^two builder legs under the key "([^"]+)" that both started from checkpoint number (\d+)$/, async (w, key, num) => {
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, key, Number(num))
    await legFrom(w, 'first', 'builder', key, [ids.at(-1)!])
    await legFrom(w, 'second', 'builder', key, [ids.at(-1)!])
  })

  define(/^each writes its checkpoint and stops$/, async (w) => {
    // Both are live when the first writes: the store cannot tell them
    // apart at insert, and the call's own echo names the leg at the drain.
    const first = await writeAsLeg(w, 'first', 'builder', 'state: submit wired by the first builder', 'login-form')
    expect((first['checkpoint'] as Record<string, unknown>)['supersedes_src']).toBe('pending')
    stop(w, 'first', 'builder', 'first builder done')
    await writeAsLeg(w, 'second', 'builder', 'state: validation wired by the second builder', 'login-form')
    stop(w, 'second', 'builder', 'second builder done')
    await drainStaging(w)
  })

  define(/^the first to land is number (\d+) and the second is number (\d+), each naming number (\d+) as what it supersedes$/, (w, a, b, prev) => {
    const start = w.cps![cpLabel(RUN, 'login-form', Number(prev))]
    const first = rawMetaOf(w, w.ids!['first-checkpoint']!)
    const second = rawMetaOf(w, w.ids!['second-checkpoint']!)
    expect([first['_checkpoint_number'], first['supersedes'], first['_supersedes_src'], first['_writer_agent_id']])
      .toEqual([Number(a), [start], 'store', w.legs!['first']!.agentId])
    expect([second['_checkpoint_number'], second['supersedes'], second['_supersedes_src'], second['_writer_agent_id']])
      .toEqual([Number(b), [start], 'store', w.legs!['second']!.agentId])
    // Never the same number twice under the key.
    const numbers = rawCheckpoints(w, RUN, 'login-form').map((c) => c.n)
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  // ── D305: a subagent with no brief or no key, exactly as today ──

  // The prompt is the Agent tool's input, which no hook is handed (D320):
  // the sentence names it, the store never sees it.
  define(/^an orchestrating session with no brief row for the explorer role, that spawns an explorer subagent with the prompt "(?:[^"]+)"$/, async (w) => {
    await openRunWorld(w)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.brief_for') = 'explorer'")).toHaveLength(0)
    const agentId = `aexplorer${Date.now().toString(16)}`
    subagentStartHook(w, agentId, 'explorer')
    w.legs!['explorer'] = { sessionId: w.sessionId!, agentId }
    await sessionClient(w)
  })

  define(/^the explorer finishes with the report "([^"]+)"$/, async (w, report) => {
    stop(w, 'explorer', 'explorer', report)
    // The Agent tool returns the explorer to the orchestrator: a plain
    // subagent's return carries no pointer line (D305).
    w.facts!['explorer-return'] = agentToolReturns(w, w.legs!['explorer']!.agentId, 'explorer', 'find where the login form is rendered', report!)
    await drainStaging(w)
  })

  define(/^the explorer's registration carries no run and no key$/, (w) => {
    const r = rawRegistration(w, w.legs!['explorer']!)
    expect([r['run'], r['run_key'], r['key_src'], r['kind'], r['start_checkpoints']]).toEqual([null, null, null, null, null])
    expect(r['agent_type']).toBe('explorer')
    expect(r['stopped_at']).not.toBeNull()
  })

  define(/^the orchestrator searching "([^"]+)" finds that report marked as the explorer subagent's summary$/, async (w, q) => {
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 5 } }))
    const hits = read['results'] as Array<{ nodeId: string; content: string; metadata: Record<string, unknown> }>
    const report = hits.find((h) => h.metadata['kind'] === SUBAGENT_SUMMARY_KIND)
    expect(report, 'the report is among the hits').toBeTruthy()
    expect(report!.content).toContain('src/login/Form.tsx')
    expect(report!.metadata['_writer']).toBe('explorer')
  })

  define(/^the explorer's stop is not blocked and no checkpoint is asked for$/, (w) => {
    const out = w.stops!['explorer']!
    expect(blocks(out)).toBe(false)
    // The hook said nothing at all: no block, and no ask of any kind.
    expect(out.trim()).toBe('')
    // And nothing rode on the Agent tool's result: no pointer line.
    expect(String(w.facts!['explorer-return']).trim()).toBe('')
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")).toHaveLength(0)
  })

  // ── D320, D326: the leg's first write under a key settles it ──

  define(/^a builder subagent registered with the key "([^"]+)",? marked inferred(, named as its checkpointer)?$/, async (w, key, named) => {
    await openRunWorld(w)
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key, checkpointer: named ? 'builder' : null })
    await sessionClient(w)
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['run_key'], r['key_src'], r['checkpointer']]).toEqual([key, 'inferred', named ? 'builder' : null])
  })

  define(/^a builder subagent registered (?:on the run "([^"]+)" )?with an ambiguous key between "([^"]+)" and "([^"]+)"$/, async (w, run, a, b) => {
    if (run) expect(run).toBe(RUN)
    await openRunWorld(w)
    // Two briefs in effect for the role on the run: the hooks door
    // registers the subagent with its key ambiguous (D320).
    await briefFor(w, 'builder', RUN, a!, { checkpointer: 'builder' })
    await briefFor(w, 'builder', RUN, b!, { checkpointer: 'builder' })
    subagentStartBuilder(w)
    await sessionClient(w)
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['key_src'], r['run_key'], r['run']]).toEqual(['ambiguous', null, RUN])
    expect((JSON.parse(String(r['key_candidates'])) as Array<{ key: string }>).map((c) => c.key).sort()).toEqual([a, b].sort())
    if (run) {
      // A keyed control in the same run, ended as the builder will be: a
      // reviewer worker whose ticket declared the key, which wrote under it
      // and was retired. The run's facts must not count it as keyless.
      const control = await workerLeg(w, 'control', { role: 'reviewer', run: RUN, key: a! })
      await w.store!.writeCheckpoint('state: the form reviewed; two fixes asked for', { run: RUN, key: a!, leg: control })
      expect(retiredWithoutReturn(w, control)).toBe(true)
    }
  })

  define(/^the builder writes its first row under the key "([^"]+)"$/, async (w, key) => {
    const leg = w.legs!['builder']!
    await insertEchoed(w, { agentId: leg.agentId, agentType: 'builder' }, `finding: the ${key} needs a debounce before it can be wired`, { run: RUN, key })
    await drainStaging(w)
  })

  define(/^the builder's registration carries the key "([^"]+)", marked as the leg's own$/, (w, key) => {
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['run_key'], r['key_src'], r['run']]).toEqual([key, 'own', RUN])
  })

  // ── D296: the main agent's checkpoint under a leg's key, flagged ──

  define(/^a brief naming the builder as the checkpointer of the key "([^"]+)", and checkpoint number (\d+) under it$/, async (w, key, num) => {
    await openRunWorld(w)
    const b = await w.store!.writeBrief(`build the ${key}; the builder checkpoints it`, { run: RUN, key, role: 'builder', checkpointer: 'builder', by: 'harness' })
    w.ids!['brief'] = b.nodeId
    await seedCheckpoints(w, RUN, key, Number(num))
  })

  define(/^the main agent inserts a checkpoint under the key "([^"]+)"$/, async (w, key) => {
    // Through the tools on the session's connection, with no agent fields
    // on its echo: the session's own agent.
    const reply = await insertEchoed(w, null, 'state: the main agent wired the submit itself', { kind: 'checkpoint', run: RUN, key })
    w.ids!['main-checkpoint'] = reply['node_id'] as string
    await drainStaging(w)
  })

  define(/^the harness looking up the key "([^"]+)" receives that checkpoint as number (\d+) with the writer "([^"]+)"$/, (w, key, num, writer) => {
    const l = lookup(w, key)
    const mine = l.checkpoints.find((c) => c.nodeId === w.ids!['main-checkpoint'])
    expect(mine, 'the main agent\'s checkpoint is not withheld').toBeTruthy()
    expect([mine!.number, mine!.writer]).toEqual([Number(num), writer])
    // The main agent is no leg: nothing it supersedes was named or stamped,
    // so it comes back beside the one before it, two in effect.
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(num) - 1, Number(num)])
    expect(l.line).toMatch(/^2 checkpoints are in effect/)
    const m = rawMetaOf(w, mine!.nodeId)
    expect([m['_writer'], m['_checkpoint_number'], m['_writer_agent_id'], m['supersedes']]).toEqual([writer, Number(num), undefined, undefined])
  })

  define(/^the same reply says its writer is not the checkpointer the brief names$/, (w) => {
    const reply = keyLookupReply(w.lookups![RUN]!)
    expect(reply.named_checkpointer).toEqual({ names: ['builder'], by: 'brief' })
    const flags = reply.checkpoints.map((c) => [c.node_id, c.flag])
    const main = reply.checkpoints.find((c) => c.node_id === w.ids!['main-checkpoint'])!
    // The main agent's is flagged in words; the builder's beside it is not.
    expect(flags).toEqual(reply.checkpoints.map((c) => [c.node_id, c === main
      ? `The writer of checkpoint number ${main.number}, "main", is not the checkpointer the brief names ("builder").`
      : null]))
    expect(rawMetaOf(w, w.ids!['brief']!)['checkpointer']).toBe('builder')
  })

  // ── D320, D326: a keyless leg counted as such ──

  define(/^the builder stops having written under no key$/, async (w) => {
    stop(w, 'builder', 'builder', 'looked at the form; nothing to write')
    await drainStaging(w)
  })

  define(/^the harness looking up the key "([^"]+)" on the run "([^"]+)" counts one keyless leg among the run's facts$/, (w, key, run) => {
    const l = lookup(w, key, run)
    expect(l.facts.keylessLegs).toBe(1)
    expect(l.facts.legsRun).toBe(w.legs!['control'] ? 2 : 1)
    const builder = l.legs.find((g) => g.agentId === w.legs!['builder']!.agentId)!
    expect([builder.state, builder.keyless]).toEqual(['retired', true])
    // The keyed control, ended too, is not counted.
    if (w.legs!['control']) {
      const control = l.legs.find((g) => g.sessionId === w.legs!['control']!.sessionId)!
      expect([control.state, control.keySrc, control.keyless]).toEqual(['retired', 'declared', false])
    }
    expect(keyLookupReply(l).facts.keyless_legs).toBe(1)
    // The file: the registration never settled a key, the leg wrote no row
    // carrying one, and its summary carries the run alone.
    const r = rawRegistration(w, w.legs!['builder']!)
    // Never settled: an ambiguous key stays unnamed, an inferred one stays
    // the brief's, marked inferred, never the leg's own.
    if (r['key_src'] === 'ambiguous') expect(r['run_key']).toBeNull()
    else expect([r['run_key'], r['key_src']]).toEqual([key, 'inferred'])
    expect(r['stopped_at']).not.toBeNull()
    // (The hooks door's own first-moment row in the lane names the key it
    // inferred; it is the door's row, not a write of the leg's.)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$._writer_agent_id') = ? AND json_extract(metadata_json, '$.key') IS NOT NULL AND json_extract(metadata_json, '$.kind') IS NOT 'first-moment'", w.legs!['builder']!.agentId)).toHaveLength(0)
    const summary = rawOne<{ m: string }>(w, "SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?", SUBAGENT_SUMMARY_KIND, w.legs!['builder']!.agentId)
    expect(summary, 'the builder\'s summary landed').toBeTruthy()
    const sm = JSON.parse(summary!.m) as Record<string, unknown>
    expect([sm['run'], sm['key']]).toEqual([run, undefined])
  })

  // ── D312, D328: a silent leg reads live, with its ages ──

  define(/^a builder leg under the key "([^"]+)" registered live (\d+) hours ago, whose last row is (\d+) minutes old, in a session still running$/, async (w, key, hours, minutes) => {
    await openRunWorld(w)
    const start = Date.now() / 1000 - Number(hours) * 3600
    const last = Date.now() / 1000 - Number(minutes) * 60
    // Registered through the hooks door, the real SubagentStart hook
    // inferring the leg from the role's brief, at its own moment: the
    // hook's clock is set to the start (the test-only TREECONTEXT_TEST_NOW
    // its clock reads under the suite). Its rows are written through the
    // library as the leg, each at the moment it was written.
    await briefFor(w, 'builder', RUN, key!, { checkpointer: 'builder', at: start - 60 })
    const ref = await hooksLeg(w, 'builder', 'builder', { run: RUN, key: key! }, { TREECONTEXT_TEST_NOW: String(start) })
    expect([rawRegistration(w, ref)['door'], rawRegistration(w, ref)['key_src']]).toEqual(['hooks', 'inferred'])
    await w.store!.insert('npx vitest run login: 2 failing, the submit handler is missing', { leg: ref, createdAt: start + 300 })
    await w.store!.insert('waiting on the login API; no answer yet', { leg: ref, createdAt: last })
    // The session still running: its own agent is busy, and the real
    // PostToolUse hook captures a newer row of the session, the main
    // agent's, which is no write of the builder's lane.
    runHook(w, 'post-tool-use', bashPayload(w, 'git status --short', ' M src/login/Form.tsx (heronfeather)'))
    await drainStaging(w)
    const mainRow = rawOne<{ t: number; a: string | null }>(w,
      "SELECT created_at AS t, json_extract(metadata_json, '$._writer_agent_id') AS a FROM nodes WHERE content LIKE '%heronfeather%'")
    expect(mainRow, 'the main agent\'s capture was drained').toBeTruthy()
    expect([mainRow!.a, mainRow!.t > last]).toEqual([null, true])
    w.moments!['start'] = start
    w.moments!['last'] = last
    w.moments!['main'] = mainRow!.t
  })

  define(/^the harness sees the builder leg as live, with its start (\d+) hours ago and its last write (\d+) minutes ago$/, (w, hours, minutes) => {
    const l = w.lookups![RUN]!
    const leg = l.legs.find((g) => g.agentId === w.legs!['builder']!.agentId)!
    expect([leg.state, leg.startedAt, leg.lastWriteAt]).toEqual(['live', w.moments!['start'], w.moments!['last']])
    expect(Math.abs(l.facts.asOf - leg.startedAt - Number(hours) * 3600)).toBeLessThan(60)
    expect(Math.abs(l.facts.asOf - leg.lastWriteAt! - Number(minutes) * 60)).toBeLessThan(60)
    // The file: still live (no session restart retired it), and the lane's
    // newest row is the 90-minute-old one, by its own moment.
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['started_at'], r['stopped_at'], r['ended']]).toEqual([w.moments!['start'], null, null])
    expect(rawOne<{ t: number }>(w, "SELECT MAX(created_at) AS t FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?",
      w.sessionId, w.legs!['builder']!.agentId)!.t).toBe(w.moments!['last'])
    // The session's own newest row is the main agent's, newer than the
    // builder's last write: the lane, not the session, is what was read.
    expect(rawOne<{ t: number }>(w, 'SELECT MAX(created_at) AS t FROM nodes WHERE session_key = ?', w.sessionId)!.t).toBe(w.moments!['main'])
  })
}
