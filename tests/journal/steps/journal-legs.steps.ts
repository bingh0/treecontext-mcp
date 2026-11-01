import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { parseTool, rawAll } from '../world.js'
import { drainStaging } from '../capture-harness.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import {
  type RunWorld, openRunWorld, hooksLeg, seedCheckpoints, sessionClient, insertEchoed, subagentStopHook, blocks,
  rawOne, rawMetaOf, rawRowOf, rawRegistration, rawCheckpoints, cpLabel, stringSteps, subagentStartHook,
} from '../run-world.js'

// ── journal-legs ────────────────────────────────────────────────────────
//
// The leg contract's storage half (D280, D284, D305, D320, D329, D331): a
// checkpoint is numbered by the store when it lands, supersedes what its
// writer names or, naming nothing, what the leg's registration says it
// started from, marked as the store's; two in effect come back as two.
//
// A leg here runs through the hooks door as Claude Code drives it: the
// real SessionStart hook registers the session's self, the real
// SubagentStart hook registers the subagent under the PARENT's session,
// and the registry call the hooks door makes gives it its run, key and
// start (registerLeg; the hook's own inference from the role's brief is
// the hooks-door build's, and its scenarios stay in the wip register).
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
  await hooksLeg(w, name, role, { run: RUN, key, keySrc: 'inferred', checkpointer: role, startCheckpoints: start })
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

export const legsDefiner = (reg: Registry<LegsWorld>): void => {
  const define = stringSteps(reg)

  // ── D284, D331: the checkpoint a leg writes at its end ──

  define(/^a builder leg (?:under the run "([^"]+)" )?that started from checkpoint number (\d+) under the key "([^"]+)"$/, async (w, run, num, key) => {
    if (run) expect(run).toBe(RUN)
    await openRunWorld(w)
    const ids = await seedCheckpoints(w, RUN, key, Number(num))
    w.before!['start'] = rawRowOf(w, ids.at(-1)!)
    await legFrom(w, 'builder', 'builder', key, [ids.at(-1)!])
  })

  define(/^the builder writes the checkpoint "([^"]+)" and stops$/, async (w, text) => {
    await writeAsLeg(w, 'builder', 'builder', text, 'login-form')
    stop(w, 'builder', 'builder', 'submit wired; validation next')
    await drainStaging(w)
  })

  define(/^the builder writes the checkpoint "([^"]+)" naming nothing as superseded$/, async (w, text) => {
    const reply = await writeAsLeg(w, 'builder', 'builder', text, 'login-form')
    // The tool says back what it stored: numbered, superseding the start.
    expect((reply['checkpoint'] as Record<string, unknown>)['supersedes_src']).toBe('store')
    await drainStaging(w)
  })

  // A forward guard: today's SubagentStop hook never blocks a stop. It
  // starts to mean something when the hooks door's send-back lands (unit
  // 4): a leg that wrote a checkpoint newer than its start is not sent
  // back. (Noted on the journal-legs ruling in wip-register.ts.)
  define(/^the builder's stop is not blocked$/, (w) => {
    expect(w.stops!['builder'], 'the SubagentStop hook ran').toBeDefined()
    expect(blocks(w.stops!['builder']!)).toBe(false)
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
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.ids!['review'], Number(num), writer]])
    expect(rawMetaOf(w, w.ids!['review']!)['_writer']).toBe(writer)
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
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")).toHaveLength(0)
  })

  // ── D320, D326: the leg's first write under a key settles it ──

  define(/^a builder subagent registered with the key "([^"]+)", marked inferred$/, async (w, key) => {
    await openRunWorld(w)
    await hooksLeg(w, 'builder', 'builder', { run: RUN, key, keySrc: 'inferred' })
    await sessionClient(w)
    expect(rawRegistration(w, w.legs!['builder']!)['key_src']).toBe('inferred')
  })

  define(/^a builder subagent registered with an ambiguous key between "([^"]+)" and "([^"]+)"$/, async (w, a, b) => {
    await openRunWorld(w)
    await hooksLeg(w, 'builder', 'builder', {
      run: RUN, key: null, keySrc: 'ambiguous',
      keyCandidates: [{ run: RUN, key: a, briefId: null }, { run: RUN, key: b, briefId: null }],
    })
    await sessionClient(w)
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['key_src'], r['run_key']]).toEqual(['ambiguous', null])
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
}
