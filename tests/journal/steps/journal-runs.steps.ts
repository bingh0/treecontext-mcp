import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { type Client } from '@modelcontextprotocol/client'
import { parseTool, rawAll, mcpOver, type World } from '../world.js'
import { runHook, bashPayload, drainStaging, spawnHooksInBatches } from '../capture-harness.js'
import { spawnCli } from '../../helpers/cli-spawn.js'
import { RUN_SECRETS_WARNING } from '../../../src/handoff.js'
import { WRITER_STAMP_KEYS } from '../../../src/persistence/session-registry.js'
import { RUN_ROWS_SQL, charactersOf } from '../../../src/runs.js'
import { KEY_LOOKUP_PARAM, keyLookupReply, type KeyLookup, type KeyLookupReply } from '../../../src/key-lookup.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { STORE_WRITER } from '../../../src/persistence/session-registry.js'
import {
  type RunWorld, openRunWorld, seedCheckpoints, sessionClient, localMoment, readerOf,
  rawOne, rawMetaOf, rawContentOf, rawRowOf, rawRegistration, rawCheckpoints, cpLabel, stringSteps, insertEchoed, subagentStopHook, sessionStartHook,
} from '../run-world.js'
import { runWorker, hooksLeg, hooksSubagent, workerLeg, retiredWithoutReturn, cutByTimeout, exitedWithSummary, harnessRetiresLeg } from '../standins.js'

// ── journal-runs ────────────────────────────────────────────────────────
//
// A run as a unit (D289, D302, D309, D311): its open and close are journal
// rows, its legs name it on their registrations, a captured row reaches it
// through its leg's lane, and anyone with the file reads it back by plain
// SQL in the order of each row's own moment.
//
// The harness here is a program with the library and no model: it spawns
// workers through registerWorker (the library door a spawner registers
// through), writes and reads checkpoints through the library, and opens
// and closes runs through openRun and closeRun. A hooks-door leg is
// registered by the real SubagentStart hook and given its run and key by
// the registry call the hooks door makes. Every Then reads the store file
// through a separate read-only handle, the harness's lookup, or the agent's
// own query tool. The lookup's whole reply (D296, D301, D312, D336, D337,
// D344) is read twice: as the harness receives it through the library
// (lookupKey, and keyLookupReply for the plain reply), and as an agent
// receives it through the query tool's key_lookup mode; a leg's return is
// the summary row the real SubagentStop hook staged and the drain wrote.

export type RunsWorld = RunWorld

// ── A run's export, and the way a leg comes back (unit 6) ───────────────
//
// D300, D318: a run's export is chosen by the caller, the skeleton by
// default; the whole form is behind the secrets acknowledgement. D310,
// D343: a leg that ran on another machine comes back into the run by the
// handoff. Every export here is the real export door the scenario names
// (the tool for an agent, the CLI for a harness) writing a real file in a
// real project directory, every import the real import tool reading that
// file, every Then a separate handle on the store file or the file itself.
// "build-02" is a second world: its own home, project, store and hooks.

interface FileNode { nodeId: string; content: string; createdAt: number; metadata: Record<string, unknown> | null }
interface RunFile { head: Record<string, unknown>; nodes: FileNode[]; abs: string }

function readRunFile(abs: string): RunFile {
  expect(existsSync(abs), `no file at ${abs}`).toBe(true)
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown> & { nodes: FileNode[] }
  const { nodes, ...head } = parsed
  return { head, nodes, abs }
}

/** An agent's MCP client for a world's store, started for its project
 *  directory: the one a handoff file is written inside. */
async function toolClient(w: RunsWorld): Promise<Client> {
  const kept = w.facts!['tool-client'] as Client | undefined
  if (kept) return kept
  const c = await mcpOver({ defer: w.defer } as unknown as World, { ccSessionId: w.sessionId!, projectDir: w.proj! }, w.store!)
  w.facts!['tool-client'] = c
  return c
}

type ToolReply = { isError: boolean; text: string; json: Record<string, unknown> }
async function callTool(c: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const res = await c.callTool({ name, arguments: args }) as { isError?: boolean; content?: Array<{ text?: string }> }
  const text = res.content?.[0]?.text ?? ''
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
  return { isError: res.isError === true, text, json }
}

/** The world of another machine: its own home, project directory, store
 *  and session, its cleanups running with the scenario's. */
async function otherMachine(w: RunsWorld): Promise<RunsWorld> {
  const other = { defer: w.defer } as unknown as RunsWorld
  await openRunWorld(other, { sessionStart: false })
  return other
}

/** A handoff file one machine's project holds, carried to another's: the
 *  repository is the carrier (a commit and a pull). */
function carry(from: RunsWorld, to: RunsWorld, rel: string): string {
  const dest = join(to.proj!, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(from.proj!, rel), dest)
  return rel
}

/** Prose a spawner's prompt could hold, of exactly `size` characters, its
 *  last line a marker: the pasted tail that may be the point. */
function bigPrompt(size: number, marker: string): string {
  const tail = `\n${marker}`
  let body = ''
  for (let i = 0; body.length < size; i++) body += `line ${i}: the login form pastes this file and wants its tail read, ${i * 7919 % 10007}\n`
  return body.slice(0, size - tail.length) + tail
}

/** How many of a run's captured tool calls its worker leg makes. */
const WORKER_CALLS = 20

/**
 * A run of two legs through the two doors a leg comes in by. The builder
 * is a hooks-door leg, as Claude Code runs one: it writes two checkpoints
 * under the key "login-form" and two under "search-box" through the real
 * insert tool with its echo, its tool calls captured by the real
 * PostToolUse hook with its agent fields, and it ends through the real
 * SubagentStop hook with its report. The reviewer is a `claude -p` child
 * the real `treecontext run` wrapper starts with its ticket (the stand-in
 * harness's `runWorker`): its tool calls captured by the real hooks it
 * fires into its own lane, its first stop blocked once by its Stop hook
 * for the checkpoint it owes (a send-back row in its lane), after which it
 * writes two checkpoints under "login-form" and exits, its last output its
 * summary row. The run's captured calls are split between them.
 */
async function runOfTwoDoors(w: RunsWorld, run: string, calls: number, withSearchBox: boolean): Promise<void> {
  await openRunWorld(w)
  const builderCalls = calls - WORKER_CALLS
  const ref = await hooksLeg(w, 'builder', 'builder', { run, key: 'login-form', checkpointer: 'builder' })
  const agent = { agentId: ref.agentId, agentType: 'builder' }
  const payloads: Array<Record<string, unknown>> = []
  for (let i = 0; i < builderCalls; i++) {
    payloads.push({ ...bashPayload(w, `npx vitest run builder case-${i}`, `builder case-${i}: 1 passed (zebrafinch-builder-${i})`), agent_id: ref.agentId, agent_type: 'builder' })
  }
  await spawnHooksInBatches(w, 'post-tool-use', payloads)
  const writes: Array<[string, number]> = withSearchBox ? [['login-form', 2], ['search-box', 2]] : [['login-form', 2]]
  for (const [key, n] of writes) {
    for (let i = 1; i <= n; i++) {
      const wrote = await insertEchoed(w, agent, `state of ${key} after the builder: step ${i} done; next: step ${i + 1}`, { kind: 'checkpoint', run, key })
      w.cps![cpLabel(run, key, (wrote['checkpoint'] as Record<string, unknown>)['number'] as number)] = wrote['node_id'] as string
    }
  }
  w.stops!['builder'] = subagentStopHook(w, ref.agentId, 'builder', `builder done: ${writes.map(([k]) => k).join(' and ')} delivered`)
  await drainStaging(w)
  const out = await runWorker(w, {
    spawner: 'wrapper', prompt: `review the login form the builder wired on ${run}`,
    ticket: { run, key: 'login-form', role: 'reviewer', checkpointer: 'reviewer', parent: { id: w.sessionId!, cli: 'claude-code' } },
    plan: { first: {} },
    claudeP: {
      tools: WORKER_CALLS, toolText: 'reviewer case-{i}: 1 passed (zebrafinch-reviewer-{i})',
      afterSendBack: { checkpoints: [1, 2].map((i) => `state of login-form after the reviewer: review ${i} done; next: review ${i + 1}`) },
      final: 'reviewer done: login-form delivered',
    },
  }, 'reviewer')
  await drainStaging(w)
  // The worker was sent back once by its Stop hook, and its lane holds the row.
  expect(out.log[0]?.sentBack, out.stderr).toBeTruthy()
  expect(out.exitCode, out.stderr).toBe(0)
  expect(rawAll(w, "SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'send-back'", out.sessionId)).toHaveLength(1)
  for (const c of rawCheckpoints(w, run, 'login-form')) w.cps![cpLabel(run, 'login-form', c.n)] = c.node_id
}

/** Rows of the file carrying a marker, however it was captured. */
const holding = (file: RunFile, needle: string): FileNode[] => file.nodes.filter((n) => n.content.includes(needle))
const kindsIn = (file: RunFile, kind: string): FileNode[] => file.nodes.filter((n) => n.metadata?.['kind'] === kind)

type Hit = { nodeId: string; content: string; metadata: Record<string, unknown> | null }

const HOUR = 3600

/** Words a reply that judged a leg's liveness would use (D312: the store
 *  shows the moments and judges nothing). */
const VERDICT_NEEDLE = /stuck|hung|stall|idle|slow|unresponsive|timed? ?out/i

/** The harness's one lookup of the scenario, by the run it asked on. */
function harnessLookup(w: RunsWorld, run = 'r1'): KeyLookup {
  const l = w.lookups![run]
  expect(l, `the harness never looked up a key on the run "${run}"`).toBeTruthy()
  return l!
}

/** A checkpoint's text of exactly `size` characters. */
function sized(label: string, size: number): string {
  const head = `state: ${label}; `
  return head.length >= size ? head.slice(0, size) : head + 'x'.repeat(size - head.length)
}

/** The sizes of a key's checkpoints straight from the file, by number. */
function rawSizes(w: RunsWorld, run: string, key: string): number[] {
  return rawCheckpoints(w, run, key).sort((a, b) => a.n - b.n).map((c) => charactersOf(rawContentOf(w, c.node_id)))
}

async function query(w: RunsWorld, q: string, extra: Record<string, unknown> = {}): Promise<Hit[]> {
  await sessionClient(w)
  const read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 10, ...extra } }))
  return read['results'] as Hit[]
}

/** The ids of every row a run is made of, by the reader's recipe. */
function runRowIds(w: RunsWorld, run: string): Set<string> {
  return new Set(rawAll<{ node_id: string }>(w, RUN_ROWS_SQL, run, run).map((r) => r.node_id))
}

function openRowOf(w: RunsWorld, run: string): { node_id: string; created_at: number; m: Record<string, unknown> } {
  const r = rawOne<{ node_id: string; created_at: number; m: string }>(w,
    "SELECT node_id, created_at, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)
  expect(r, `no open row for the run "${run}" in the store file`).toBeTruthy()
  return { node_id: r!.node_id, created_at: r!.created_at, m: JSON.parse(r!.m) as Record<string, unknown> }
}

/** A reader's walk of a run with plain SQL: its legs, the runs those legs
 *  say they opened, and theirs, to any depth (D311). */
function walk(w: RunsWorld, run: string): Record<string, Array<Record<string, unknown>>> {
  const raw = readerOf(w)
  const out: Record<string, Array<Record<string, unknown>>> = {}
  const todo = [run]
  while (todo.length > 0) {
    const r = todo.shift()!
    if (out[r]) continue
    const legs = raw.prepare('SELECT * FROM session_registry WHERE run = ? ORDER BY started_at').all(r) as Array<Record<string, unknown>>
    out[r] = legs
    for (const leg of legs) for (const inner of JSON.parse(String(leg['opened_runs'] ?? '[]')) as string[]) todo.push(inner)
  }
  return out
}

/** A worker of a run that writes its checkpoint under the key and is
 *  retired at exit, its start the checkpoint in effect before it. */
async function finishedWorker(w: RunsWorld, name: string, role: string, run: string, key: string, text: string): Promise<string> {
  const start = w.store!.checkpointsInEffect(run, key).map((c) => c.nodeId)
  const ref = await workerLeg(w, name, { role, run, key, startCheckpoints: start })
  const r = await w.store!.writeCheckpoint(text, { run, key, leg: ref })
  w.cps![cpLabel(run, key, r.checkpoint!.number)] = r.nodeId
  expect(retiredWithoutReturn(w, ref)).toBe(true)
  return r.nodeId
}

export const runsDefiner = (reg: Registry<RunsWorld>): void => {
  const define = stringSteps(reg)

  // ── D309: a run found by time through the rows the ticket door wrote ──
  //
  // Each worker is a real process (the stand-in) started through the real
  // ticket door, the library call; the door's clock is set to the run's
  // own day, so the first-moment rows, the registrations and the summary
  // rows carry that day's moments, and the stand-in writes its checkpoint
  // at a moment of the same day. Nothing else is staged.

  /** The local start of the most recent Tuesday before today. */
  const lastTuesday = (): number => {
    const d = new Date()
    const back = ((d.getDay() - 2 + 7) % 7) || 7
    d.setDate(d.getDate() - back)
    d.setHours(0, 0, 0, 0)
    return d.getTime() / 1000
  }

  define(/^a store holding a run from last Tuesday with (\d+) first-moment rows, and runs from other days$/, async (w, n) => {
    await openRunWorld(w)
    const tuesday = lastTuesday()
    w.moments!['tuesday'] = tuesday
    const day = [
      { run: 'the-tuesday-run', base: tuesday + 10 * HOUR, workers: Number(n) },
      { run: 'the-monday-run', base: tuesday - 14 * HOUR, workers: 1 },
      { run: 'the-latest-run', base: null, workers: 1 },
    ]
    const keys = ['login-form', 'login-api', 'login-tests']
    for (const d of day) {
      for (let i = 0; i < d.workers; i++) {
        let t = (d.base ?? Date.now() / 1000) + i * 600
        const clock = d.base === null ? undefined : (): number => (t += 1)
        const key = keys[i % keys.length]!
        await runWorker(w, {
          spawner: 'library', prompt: `build the login piece ${key} for ${d.run}`,
          ticket: { run: d.run, key, role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
          plan: { first: { checkpoint: `state: login piece ${key} done`, print: `login piece ${key} done`, ...(d.base !== null ? { at: t + 30 } : {}) } },
          ...(clock ? { clock } : {}),
        }, `${d.run}:${i}`)
      }
    }
  })

  define(/^an agent queries for what ran last Tuesday$/, async (w) => {
    const after = w.moments!['tuesday']!
    // The session's own search is scoped to its lane (D374): a worker's
    // first moment is the worker's own capture, in the worker's lane, so
    // the agent asks for the whole store, as the scoped reply says to.
    await sessionClient(w)
    const own = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'login piece', top_k: 20, time_range: { after, before: after + 24 * HOUR } } }))
    expect(own['scope']).toMatchObject({ widen: 'pass scope "all" to search the whole store' })
    w.facts!['hits'] = await query(w, 'login piece', { top_k: 20, time_range: { after, before: after + 24 * HOUR }, scope: 'all' })
  })

  define(/^the agent's hits include that run's (\d+) first-moment rows, each carrying the run and its key$/, (w, n) => {
    const hits = w.facts!['hits'] as Hit[]
    const firsts = hits.filter((h) => h.metadata?.['kind'] === 'first-moment')
    expect(firsts).toHaveLength(Number(n))
    expect(new Set(firsts.map((h) => h.metadata!['run']))).toEqual(new Set(['the-tuesday-run']))
    expect(firsts.map((h) => h.metadata!['key']).sort()).toEqual(['login-api', 'login-form', 'login-tests'])
    // The rows are the ones the door wrote, at the run's own moments,
    // and nothing from another day's run is among the hits.
    const tuesday = w.moments!['tuesday']!
    for (const h of firsts) {
      const r = rawOne<{ t: number; s: string }>(w, 'SELECT created_at AS t, source_label AS s FROM nodes WHERE node_id = ?', h.nodeId)!
      expect(r.t).toBeGreaterThanOrEqual(tuesday)
      expect(r.t).toBeLessThan(tuesday + 24 * HOUR)
      expect(r.s).toBe('auto-capture')
    }
    expect(hits.every((h) => h.metadata?.['run'] === undefined || h.metadata['run'] === 'the-tuesday-run')).toBe(true)
    w.facts!['found-run'] = firsts[0]!.metadata!['run']
  })

  define(/^a query filtered by the run those rows carry returns the run's checkpoints and summary rows$/, async (w) => {
    const run = w.facts!['found-run'] as string
    // Walked over the whole store, as the agent already asked (D374: a
    // worker's checkpoints sit in the worker's lane, its return by the
    // parent link in the spawner's).
    const hits = await query(w, 'login piece', { top_k: 20, metadata_filter: { run }, scope: 'all' })
    const want = rawAll<{ node_id: string }>(w,
      `SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.run') = ? AND json_extract(metadata_json, '$.kind') IN ('checkpoint', ?)`, run, SUBAGENT_SUMMARY_KIND)
      .map((r) => r.node_id)
    expect(want).toHaveLength(6)
    const got = new Set(hits.map((h) => h.nodeId))
    for (const id of want) expect(got.has(id), `the run's row ${id} among the filtered hits`).toBe(true)
    expect(hits.every((h) => h.metadata?.['run'] === run)).toBe(true)
  })
  // ── D289: the harness's lookup, by run and key, with no model ──

  define(/^a run "([^"]+)" with (\d+) legs, all exited, whose key "([^"]+)" holds checkpoints number 1 to (\d+), number \4 written by the reviewer role$/, async (w, run, legs, key, last) => {
    await openRunWorld(w, { sessionStart: false })
    const n = Number(last)
    expect(Number(legs)).toBe(n)
    for (let i = 1; i <= n; i++) {
      await finishedWorker(w, `${run}-leg${i}`, i === n ? 'reviewer' : 'builder', run!, key!, `state after leg ${i} of ${run}: part ${i} done`)
    }
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds its own checkpoint number (\d+) and a live builder leg$/, async (w, run, key, num) => {
    await openRunWorld(w, { sessionStart: false })
    for (let i = 1; i <= Number(num); i++) await finishedWorker(w, `${run}-done${i}`, 'builder', run!, key!, `state of ${run}: own part ${i}`)
    await workerLeg(w, `${run}-live`, { role: 'builder', run: run!, key: key!, startCheckpoints: w.store!.checkpointsInEffect(run!, key!).map((c) => c.nodeId) })
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds no checkpoint and one live builder leg$/, async (w, run, key) => {
    await openRunWorld(w, { sessionStart: false })
    await workerLeg(w, `${run}-live`, { role: 'builder', run: run!, key: key!, startCheckpoints: [] })
    // Checkpoints under other keys and other runs, which an honest nothing
    // must not borrow from.
    await seedCheckpoints(w, run!, 'login-form', 2)
    await seedCheckpoints(w, 'r9', key!, 2)
  })

  define(/^a harness with no model asks for the checkpoint in effect under the key "([^"]+)" on the run "([^"]+)"$/, (w, key, run) => {
    w.lookups![run!] = w.store!.lookupKey({ run: run!, key: key! })
  })

  define(/^the harness receives checkpoint number (\d+) of "([^"]+)" with the writer "([^"]+)", never the checkpoint of "([^"]+)"$/, (w, num, run, writer, other) => {
    const l = w.lookups![run!]!
    expect(l.checkpoints).toHaveLength(1)
    const cp = l.checkpoints[0]!
    expect(cp.nodeId).toBe(w.cps![cpLabel(run!, l.key, Number(num))])
    expect(cp.number).toBe(Number(num))
    expect(cp.writer).toBe(writer)
    // The file agrees: that row is the reviewer's, numbered so by the store.
    const m = rawMetaOf(w, cp.nodeId)
    expect([m['_writer'], m['_checkpoint_number'], m['run']]).toEqual([writer, Number(num), run])
    const others = Object.entries(w.cps!).filter(([label]) => label.startsWith(`${other}:`)).map(([, id]) => id)
    expect(others.length).toBeGreaterThan(0)
    for (const id of others) expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(id)
  })

  define(/^the harness sees each of the (\d+) legs of "([^"]+)" as retired$/, (w, n, run) => {
    const l = w.lookups![run!]!
    expect(l.legs).toHaveLength(Number(n))
    for (const leg of l.legs) expect(leg.state).toBe('retired')
    for (const r of rawAll<{ stopped_at: number | null; ended: string | null }>(w, 'SELECT stopped_at, ended FROM session_registry WHERE run = ?', run)) {
      expect(r.ended).toBe('retired')
      expect(r.stopped_at).not.toBeNull()
    }
  })

  define(/^the same harness asking on the run "([^"]+)" sees its builder leg as live$/, (w, run) => {
    const l = w.store!.lookupKey({ run: run!, key: 'login-form' })
    const live = l.legs.filter((leg) => leg.state === 'live')
    expect(live.map((leg) => leg.role)).toEqual(['builder'])
    const r = rawRegistration(w, w.legs![`${run}-live`]!)
    expect([r['ended'], r['stopped_at']]).toEqual([null, null])
  })

  define(/^the harness receives no checkpoint and a line saying none is in effect under "([^"]+)"$/, (w, key) => {
    const l = Object.values(w.lookups!)[0]!
    expect(l.checkpoints).toEqual([])
    expect(l.line).toContain('No checkpoint is in effect')
    expect(l.line).toContain(`"${key}"`)
  })

  define(/^the harness sees the builder leg as live$/, (w) => {
    const l = Object.values(w.lookups!)[0]!
    expect(l.legs.map((leg) => [leg.role, leg.state])).toEqual([['builder', 'live']])
  })

  define(/^the harness receives no checkpoint of any other key or run$/, (w) => {
    const l = Object.values(w.lookups!)[0]!
    // There were checkpoints to borrow: two under another key, two under another run.
    expect(Object.keys(w.cps!).length).toBe(4)
    expect(l.checkpoints).toHaveLength(0)
  })

  // ── D289: the run read back by plain SQL ──

  define(/^a run "([^"]+)" whose builder leg wrote a row at (\d\d:\d\d:\d\d) that the drain ingested after the reviewer's row of (\d\d:\d\d:\d\d)$/, async (w, run, builderAt, reviewerAt) => {
    await openRunWorld(w)
    // The builder: a hooks-door leg of the session, captured by the real
    // PostToolUse hook with its agent fields, dated where the scenario
    // needs it (the hook stamps its own clock), and drained LAST.
    const builder = await hooksLeg(w, 'builder', 'builder', { run: run!, key: 'login-form' })
    runHook(w, 'post-tool-use', { ...bashPayload(w, 'npx vitest run login', 'login form: 12 passed (zebrafinch)'), agent_id: builder.agentId, agent_type: 'builder' })
    const tBuilder = localMoment(builderAt!)
    const tReviewer = localMoment(reviewerAt!)
    const rw = new DatabaseSync(w.dbPath!)
    try {
      const staged = rw.prepare("UPDATE staging SET timestamp = ? WHERE processed = 0 AND agent_id = ? AND content LIKE '%zebrafinch%'").run(tBuilder, builder.agentId)
      expect(staged.changes).toBe(1)
    } finally { rw.close() }
    // The reviewer: a worker of the same run under the same parent session,
    // whose checkpoint lands in the journal before the drain runs.
    const reviewer = await workerLeg(w, 'reviewer', { role: 'reviewer', run: run!, key: 'login-form', parent: w.sessionId! })
    const r = await w.store!.writeCheckpoint('state: reviewed the login form; next: ship', { run: run!, key: 'login-form', leg: reviewer, at: tReviewer })
    w.ids!['reviewer'] = r.nodeId
    w.moments!['builder'] = tBuilder
    w.moments!['reviewer'] = tReviewer
    await drainStaging(w)
    const b = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE content LIKE '%zebrafinch%'")
    expect(b, 'the builder row was drained').toBeTruthy()
    w.ids!['builder'] = b!.node_id
  })

  define(/^a run "([^"]+)" with (\d+) rows of its own$/, async (w, run, n) => {
    const ref = await workerLeg(w, `${run}-worker`, { role: 'builder', run: run!, key: 'search-box' })
    const ids: string[] = []
    for (let i = 0; i < Number(n); i++) {
      ids.push((await w.store!.insert(`${run} note ${i}: the search box debounces at ${i * 10} ms`, { leg: ref })).nodeId)
    }
    w.facts![`${run}-rows`] = ids
  })

  define(/^a reader runs plain SQL against the store file for the run "([^"]+)"$/, (w, run) => {
    w.sqlRows = readerOf(w).prepare(RUN_ROWS_SQL).all(run!, run!) as Array<Record<string, unknown>>
    expect(w.sqlRows.length).toBeGreaterThan(0)
  })

  define(/^the reader sees the builder's row before the reviewer's, each row naming its writer and its moment$/, (w) => {
    const order = w.sqlRows!.map((r) => r['node_id'])
    const b = order.indexOf(w.ids!['builder']!)
    const r = order.indexOf(w.ids!['reviewer']!)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(r).toBeGreaterThan(b)
    // The drain wrote the builder's row after the reviewer's: its rowid is
    // later, its moment earlier. The order is the rows' own moments.
    const rowid = (id: string) => rawOne<{ rowid: number }>(w, 'SELECT rowid FROM nodes WHERE node_id = ?', id)!.rowid
    expect(rowid(w.ids!['builder']!)).toBeGreaterThan(rowid(w.ids!['reviewer']!))
    const bm = rawMetaOf(w, w.ids!['builder']!)
    expect(bm['ingested_at']).toBeGreaterThan(w.moments!['reviewer']!)
    for (const row of w.sqlRows!) {
      expect(typeof row['writer'], `row ${String(row['node_id'])} names no writer`).toBe('string')
      expect(typeof row['created_at']).toBe('number')
    }
    const byId = Object.fromEntries(w.sqlRows!.map((row) => [row['node_id'], row]))
    expect(byId[w.ids!['builder']!]!['created_at']).toBe(w.moments!['builder'])
    expect(byId[w.ids!['reviewer']!]!['created_at']).toBe(w.moments!['reviewer'])
    expect([byId[w.ids!['builder']!]!['writer'], byId[w.ids!['reviewer']!]!['writer']]).toEqual(['builder', 'reviewer'])
  })

  define(/^every leg of "([^"]+)" names the run "\1", its key and its parent session, and the builder's captured rows reach "\1" through the builder's lane$/, (w, run) => {
    const legs = rawAll<{ session_id: string; agent_id: string; run: string; run_key: string | null; parent_session: string | null }>(w,
      'SELECT session_id, agent_id, run, run_key, parent_session FROM session_registry WHERE run = ?', run)
    expect(legs).toHaveLength(2)
    for (const leg of legs) {
      expect(leg.run).toBe(run)
      expect(leg.run_key).toBe('login-form')
      expect(leg.parent_session).toBe(w.sessionId)
    }
    // The captured row carries neither run nor key; it reaches the run
    // through the registration of its session and its writer agent.
    const bm = rawMetaOf(w, w.ids!['builder']!)
    expect(bm['run']).toBeUndefined()
    expect(bm['key']).toBeUndefined()
    const row = w.sqlRows!.find((r) => r['node_id'] === w.ids!['builder'])!
    expect([row['leg_session'], row['leg_agent'], row['key']]).toEqual([w.sessionId, w.legs!['builder']!.agentId, 'login-form'])
  })

  define(/^none of the (\d+) rows of "([^"]+)" read back among them$/, (w, n, other) => {
    const theirs = w.facts![`${other}-rows`] as string[]
    expect(theirs).toHaveLength(Number(n))
    // They are the other run's by the same recipe...
    const otherRows = runRowIds(w, other!)
    for (const id of theirs) expect(otherRows.has(id)).toBe(true)
    // ...and none of the other run's rows is among this one's.
    const mine = new Set(w.sqlRows!.map((r) => r['node_id'] as string))
    for (const id of otherRows) expect(mine.has(id)).toBe(false)
  })

  // ── D302: a run's open and close ──

  define(/^a store holding no run "([^"]+)"$/, async (w, run) => {
    await openRunWorld(w)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(0)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(0)
  })

  // Through registerWorker, the library door a spawner registers a worker
  // through (D291): the first registration under the run opens it.
  define(/^a builder leg registers under the run "([^"]+)"$/, async (w, run) => {
    await workerLeg(w, 'builder', { role: 'builder', run, key: 'login-form' })
  })

  define(/^a reader with the store file sees the run "([^"]+)" opened at that registration's moment$/, (w, run) => {
    const leg = rawRegistration(w, w.legs!['builder']!)
    const open = openRowOf(w, run!)
    expect(open.created_at).toBe(leg['started_at'])
    expect(open.m['opened_via']).toBe('registration')
    expect(open.m['_writer']).toBe(STORE_WRITER)
    expect(open.m['first_leg']).toEqual({ session_id: leg['session_id'], agent_id: leg['agent_id'], role: 'builder' })
    expect(rawContentOf(w, open.node_id)).toContain(`run ${run} opened`)
    // One open row, written by the same immediate transaction as the
    // registration.
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(1)
  })

  define(/^a harness opens the run "([^"]+)" through the door with no leg yet$/, async (w, run) => {
    const at = Date.now() / 1000
    const r = await w.store!.openRun({ run: run!, by: 'harness', at })
    expect(r.opened).toBe(true)
    w.moments!['open'] = at
  })

  define(/^a reader with the store file sees the run "([^"]+)" opened by the harness at that moment, with no legs$/, (w, run) => {
    const open = openRowOf(w, run!)
    expect(open.created_at).toBe(w.moments!['open'])
    expect([open.m['opened_by'], open.m['opened_via'], open.m['_writer'], open.m['_identity']]).toEqual(['harness', 'explicit', 'harness', 'declared'])
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(0)
  })

  define(/^a run "([^"]+)" whose builder leg wrote the checkpoint "([^"]+)" that the harness's grammar cannot parse$/, async (w, run, text) => {
    await openRunWorld(w, { sessionStart: false })
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: 'login-form' })
    const r = await w.store!.writeCheckpoint(text!, { run: run!, key: 'login-form', leg: ref })
    w.ids!['checkpoint'] = r.nodeId
    w.before!['checkpoint'] = rawRowOf(w, r.nodeId)
  })

  define(/^the harness retires the leg and closes the run "([^"]+)" through the door with the reason "([^"]+)"$/, async (w, run, reason) => {
    const at = Date.now() / 1000
    expect(harnessRetiresLeg(w, w.legs!['builder']!, at)).toBe(true)
    await w.store!.closeRun({ run: run!, by: 'harness', reason: reason!, at })
    w.moments!['close'] = at
  })

  define(/^a reader running plain SQL against the store file sees the run "([^"]+)" ended at that moment, by the harness, with the reason "([^"]+)"$/, (w, run, reason) => {
    const rows = rawAll<{ created_at: number; by: string; why: string; writer: string }>(w,
      `SELECT created_at, json_extract(metadata_json, '$.closed_by') AS by, json_extract(metadata_json, '$.reason') AS why,
              json_extract(metadata_json, '$._writer') AS writer
         FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?`, run)
    expect(rows).toEqual([{ created_at: w.moments!['close'], by: 'harness', why: reason, writer: 'harness' }])
  })

  define(/^the checkpoint "([^"]+)" is stored unchanged, never parsed or refused by the store$/, (w, text) => {
    expect(rawContentOf(w, w.ids!['checkpoint']!)).toBe(text)
    expect(rawRowOf(w, w.ids!['checkpoint']!)).toEqual(w.before!['checkpoint'])
  })

  // ── D309: an agent finds a run through the query it already has ──

  define(/^a run "([^"]+)" with (\d+) legs, and a run "([^"]+)" with (\d+) legs$/, async (w, a, na, b, nb) => {
    await openRunWorld(w)
    for (const [run, n] of [[a!, Number(na)], [b!, Number(nb)]] as const) {
      for (let i = 0; i < n; i++) {
        const ref = await workerLeg(w, `${run}-${i}`, { role: i === 0 ? 'builder' : 'reviewer', run, key: 'login-form' })
        await w.store!.writeCheckpoint(`state: ${i === 0 ? 'built' : 'reviewed'} the login form`, { run, key: 'login-form', leg: ref })
      }
    }
  })

  define(/^an agent queries "([^"]+)"$/, async (w, q) => {
    w.facts!['hits'] = await query(w, q!)
  })

  define(/^the agent's hits are rows of "([^"]+)" and none of "([^"]+)"$/, (w, mine, theirs) => {
    const hits = w.facts!['hits'] as Hit[]
    expect(hits.length).toBeGreaterThan(0)
    const ours = runRowIds(w, mine!)
    const other = runRowIds(w, theirs!)
    expect(other.size).toBeGreaterThan(0)
    for (const h of hits) {
      expect(ours.has(h.nodeId), `hit ${h.nodeId} (${h.content.slice(0, 60)}) is not a row of "${mine}"`).toBe(true)
      expect(other.has(h.nodeId)).toBe(false)
    }
  })

  define(/^a run "([^"]+)" opened on Tuesday and closed on Wednesday with the reason "([^"]+)"$/, async (w, run, reason) => {
    await openRunWorld(w)
    const d = new Date()
    d.setDate(d.getDate() - (((d.getDay() - 2) + 7) % 7 || 7))
    d.setHours(10, 0, 0, 0)
    const tuesday = d.getTime() / 1000
    const wednesday = tuesday + 86400
    const open = await w.store!.openRun({ run: run!, by: 'harness', at: tuesday })
    const close = await w.store!.closeRun({ run: run!, by: 'harness', reason: reason!, at: wednesday })
    w.ids!['open'] = open.nodeId
    w.ids!['close'] = close.nodeId
    // Other work in the journal the query must rank past.
    await w.store!.insert('the deploy pipeline delivered the keys to staging on Monday', { metadata: { type: 'note' } })
  })

  define(/^the agent's hit is the run's close row, carrying the run "([^"]+)" and the reason$/, (w, run) => {
    const hits = w.facts!['hits'] as Hit[]
    expect(hits[0]!.nodeId).toBe(w.ids!['close'])
    expect(hits[0]!.metadata!['run']).toBe(run)
    expect(hits[0]!.metadata!['reason']).toBe('all keys delivered')
    expect(rawMetaOf(w, w.ids!['close']!)['kind']).toBe('run-close')
  })

  define(/^the open row of "([^"]+)" is reachable from it by the run$/, async (w, run) => {
    const hits = w.facts!['hits'] as Hit[]
    const carried = hits[0]!.metadata!['run']
    expect(carried).toBe(run)
    const opens = await query(w, `run ${String(carried)} opened`, { metadata_filter: { run: carried, kind: 'run-open' } })
    expect(opens.map((h) => h.nodeId)).toEqual([w.ids!['open']])
    // The close names its open by id as well, one hop.
    expect(rawMetaOf(w, w.ids!['close']!)['refs']).toEqual([w.ids!['open']])
  })

  // ── D311: a run opened inside a run ──

  define(/^a run "([^"]+)" whose reviewer leg, under the key "([^"]+)", spawns (\d+) workers under a run "([^"]+)" it opens, with their own key "\2"$/, async (w, outer, key, n, inner) => {
    await openRunWorld(w, { sessionStart: false })
    const reviewer = await workerLeg(w, 'reviewer', { role: 'reviewer', run: outer!, key: key! })
    const own = await w.store!.writeCheckpoint('state: original plus review; two fixes asked for', { run: outer!, key: key!, leg: reviewer })
    w.ids!['reviewer-checkpoint'] = own.nodeId
    await w.store!.openRun({ run: inner!, leg: reviewer, parentRun: outer!, parentLeg: reviewer })
    const innerIds: string[] = []
    for (let i = 0; i < Number(n); i++) {
      const fixer = await workerLeg(w, `fixer${i}`, { role: 'fixer', run: inner!, key: key!, parent: reviewer.sessionId })
      innerIds.push((await w.store!.writeCheckpoint(`state: fix ${i} applied`, { run: inner!, key: key!, leg: fixer })).nodeId)
    }
    w.facts!['inner-checkpoints'] = innerIds
  })

  define(/^a reader walks the run "([^"]+)"$/, (w, run) => {
    w.facts!['walk'] = walk(w, run!)
  })

  define(/^the reviewer leg's facts say it opened the run "([^"]+)"$/, (w, inner) => {
    const r = rawRegistration(w, w.legs!['reviewer']!)
    expect(JSON.parse(String(r['opened_runs']))).toEqual([inner])
    const walked = w.facts!['walk'] as Record<string, unknown[]>
    expect(Object.keys(walked)).toContain(inner)
  })

  define(/^the open row of "([^"]+)" names the run "([^"]+)" and the reviewer leg as declared$/, (w, inner, outer) => {
    const open = openRowOf(w, inner!)
    const reviewer = w.legs!['reviewer']!
    expect(open.m['parent_run']).toBe(outer)
    expect(open.m['parent_leg']).toEqual({ session_id: reviewer.sessionId, agent_id: reviewer.agentId, role: 'reviewer' })
    expect(open.m['_identity']).toBe('declared')
  })

  define(/^the run "([^"]+)" counts the reviewer leg as one leg, not three$/, (w, run) => {
    const walked = w.facts!['walk'] as Record<string, Array<Record<string, unknown>>>
    expect(walked[run!]).toHaveLength(1)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(1)
  })

  define(/^the harness looking up the key "([^"]+)" on the run "([^"]+)" receives the reviewer leg's checkpoint, never a checkpoint of "([^"]+)"$/, (w, key, run, inner) => {
    const l = w.store!.lookupKey({ run: run!, key: key! })
    // The inner run's checkpoints are there, under the same key, in the inner run.
    for (const id of w.facts!['inner-checkpoints'] as string[]) expect(rawMetaOf(w, id)['run']).toBe(inner)
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([w.ids!['reviewer-checkpoint']])
    for (const id of w.facts!['inner-checkpoints'] as string[]) expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(id)
  })

  define(/^a run "([^"]+)" whose leg opened "([^"]+)", whose leg opened "([^"]+)"$/, async (w, outer, mid, innermost) => {
    await openRunWorld(w, { sessionStart: false })
    const top = await workerLeg(w, 'top', { role: 'reviewer', run: outer!, key: 'login-form' })
    await w.store!.openRun({ run: mid!, leg: top, parentRun: outer!, parentLeg: top })
    const middle = await workerLeg(w, 'middle', { role: 'reviewer', run: mid!, key: 'login-form', parent: top.sessionId })
    await w.store!.openRun({ run: innermost!, leg: middle, parentRun: mid!, parentLeg: middle })
    await workerLeg(w, 'fixer', { role: 'fixer', run: innermost!, key: 'login-form', parent: middle.sessionId })
  })

  define(/^the reader reaches the legs of "([^"]+)" through "([^"]+)"$/, (w, innermost, mid) => {
    const walked = w.facts!['walk'] as Record<string, Array<Record<string, unknown>>>
    const mids = walked[mid!]!
    expect(mids).toHaveLength(1)
    expect(JSON.parse(String(mids[0]!['opened_runs']))).toEqual([innermost])
    expect(walked[innermost!]!.map((l) => l['agent_type'])).toEqual(['fixer'])
  })

  define(/^the open row of "([^"]+)" names "([^"]+)" and the leg that opened it$/, (w, innermost, mid) => {
    const open = openRowOf(w, innermost!)
    const middle = w.legs!['middle']!
    expect(open.m['parent_run']).toBe(mid)
    expect(open.m['parent_leg']).toEqual({ session_id: middle.sessionId, agent_id: middle.agentId, role: 'reviewer' })
  })

  // ── D296: a stranger's checkpoint, flagged against the named checkpointer ──

  define(/^a brief stored on the run "([^"]+)" naming the builder as the checkpointer of the key "([^"]+)"$/, async (w, run, key) => {
    await openRunWorld(w, { sessionStart: false })
    const b = await w.store!.writeBrief(`build the ${key}; the builder checkpoints it at the end`, { run: run!, key: key!, role: 'builder', checkpointer: 'builder', by: 'harness' })
    w.ids!['brief'] = b.nodeId
    expect(rawMetaOf(w, b.nodeId)['checkpointer']).toBe('builder')
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)" written by the builder role, and checkpoint number (\d+), the newest in effect, written by the writer "([^"]+)"$/, async (w, num, key, newer, stranger) => {
    await seedCheckpoints(w, 'r1', key!, Number(num))
    const r = await w.store!.writeCheckpoint('state: rewritten by another hand; the form is done', {
      run: 'r1', key: key!, declared: { role: stranger! }, supersedes: [w.cps![cpLabel('r1', key!, Number(num))]!],
    })
    expect(r.checkpoint!.number).toBe(Number(newer))
    w.cps![cpLabel('r1', key!, Number(newer))] = r.nodeId
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)", the newest in effect, written by the builder role$/, async (w, num, key) => {
    await seedCheckpoints(w, 'r1', key!, Number(num))
  })

  define(/^the harness looks up the key "([^"]+)" on the run "([^"]+)"$/, (w, key, run) => {
    w.lookups![run!] = w.store!.lookupKey({ run: run!, key: key! })
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)", not number (\d+)$/, (w, num, writer, older) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel('r1', l.key, Number(num))], Number(num), writer]])
    const m = rawMetaOf(w, l.checkpoints[0]!.nodeId)
    expect([m['_writer'], m['_checkpoint_number']]).toEqual([writer, Number(num)])
    // Number 5 is there, the builder's, and not what the lookup returned.
    const old = w.cps![cpLabel('r1', l.key, Number(older))]!
    expect(rawMetaOf(w, old)['_writer']).toBe('builder')
    expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(old)
  })

  define(/^the same reply says its writer is not the checkpointer the brief names$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    expect(reply.checkpoints).toHaveLength(1)
    const cp = reply.checkpoints[0]!
    expect(cp.flag).toBe(`The writer of checkpoint number ${cp.number}, "${cp.writer}", is not the checkpointer the brief names ("builder").`)
    expect(reply.named_checkpointer).toEqual({ names: ['builder'], by: 'brief' })
    // Nothing withheld: the stranger's row is the reply's, whole.
    expect(cp.content).toBe(rawContentOf(w, cp.node_id))
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)"$/, (w, num, writer) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel('r1', l.key, Number(num))], Number(num), writer]])
    expect(rawMetaOf(w, l.checkpoints[0]!.nodeId)['_writer']).toBe(writer)
  })

  define(/^the reply carries no flag about its writer$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    // A flag was possible (the brief names a checkpointer), and none is said.
    expect(reply.named_checkpointer).toEqual({ names: ['builder'], by: 'brief' })
    expect(reply.checkpoints.map((c) => c.flag)).toEqual([null])
    // Nor anywhere else in the reply: the phantom pass had nothing to say.
    expect(reply.notes).toEqual([])
  })

  // ── D301, D344: the run's facts beside the checkpoint ──

  define(/^a run "([^"]+)" started (\d+) hours ago on which (\d+) legs have run and whose key "([^"]+)" holds (\d+) checkpoints, the last three of (\d+), (\d+) and (\d+) characters$/, async (w, run, hours, legs, key, count, s1, s2, s3) => {
    await openRunWorld(w, { sessionStart: false })
    const start = Date.now() / 1000 - Number(hours) * HOUR
    await w.store!.openRun({ run: run!, by: 'harness', at: start })
    w.moments!['start'] = start
    const nLegs = Number(legs)
    const nCps = Number(count)
    const sizes = [...Array.from({ length: nCps - 3 }, (_, i) => 400 + i), Number(s1), Number(s2), Number(s3)]
    for (let i = 0; i < nLegs; i++) {
      const at = start + (i + 1) * 600
      const ref = await workerLeg(w, `leg${i}`, { role: 'builder', run: run!, key: key!, at, startCheckpoints: w.store!.checkpointsInEffect(run!, key!).map((c) => c.nodeId) })
      // The last legs each write one checkpoint; the first ones only worked.
      const k = i - (nLegs - nCps)
      if (k >= 0) {
        const r = await w.store!.writeCheckpoint(sized(`leg ${i} of ${run}`, sizes[k]!), { run: run!, key: key!, leg: ref, at: at + 300 })
        w.cps![cpLabel(run!, key!, r.checkpoint!.number)] = r.nodeId
      }
      expect(retiredWithoutReturn(w, ref, at + 400)).toBe(true)
    }
  })

  define(/^the harness receives, beside the checkpoint, the leg count (\d+), the checkpoint count (\d+), the run age of (\d+) hours and the sizes (\d+), (\d+) and (\d+)$/, (w, legs, count, hours, s1, s2, s3) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(count)])
    const f = keyLookupReply(l).facts
    expect([f.legs_run, f.checkpoints_under_key, f.last_sizes]).toEqual([Number(legs), Number(count), [Number(s1), Number(s2), Number(s3)]])
    expect(f.run_started_at).toBe(w.moments!['start'])
    expect(Math.abs(f.run_age_seconds! - Number(hours) * HOUR)).toBeLessThan(120)
    // The file agrees on every number.
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', l.run)).toHaveLength(Number(legs))
    expect(rawSizes(w, l.run, l.key).slice(-3)).toEqual([Number(s1), Number(s2), Number(s3)])
    expect(rawCheckpoints(w, l.run, l.key)).toHaveLength(Number(count))
    expect(rawOne<{ t: number }>(w, "SELECT created_at AS t FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", l.run)!.t).toBe(w.moments!['start'])
  })

  // ── D312: a live leg's start and last write ──

  define(/^a run "([^"]+)" with a live builder leg that started (\d+) hours ago and last wrote a row (\d+) minutes ago$/, async (w, run, hours, minutes) => {
    await openRunWorld(w, { sessionStart: false })
    const start = Date.now() / 1000 - Number(hours) * HOUR
    const last = Date.now() / 1000 - Number(minutes) * 60
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: 'login-form', at: start })
    await w.store!.insert('npx vitest run login: 3 failing, the submit handler is missing', { leg: ref, createdAt: start + 120 })
    await w.store!.insert('waiting on the login API to answer the submit', { leg: ref, createdAt: last })
    w.moments!['start'] = start
    w.moments!['last'] = last
  })

  define(/^the harness receives, for the builder leg, its start moment (\d+) hours ago and its last write (\d+) minutes ago$/, (w, hours, minutes) => {
    const reply = keyLookupReply(harnessLookup(w))
    const legs = reply.legs.filter((g) => g.role === 'builder')
    expect(legs).toHaveLength(1)
    const leg = legs[0]!
    expect([leg.state, leg.started_at, leg.last_write_at]).toEqual(['live', w.moments!['start'], w.moments!['last']])
    expect(Math.abs(reply.facts.as_of - leg.started_at - Number(hours) * HOUR)).toBeLessThan(60)
    expect(Math.abs(reply.facts.as_of - leg.last_write_at! - Number(minutes) * 60)).toBeLessThan(60)
    // The file: the registration's start, and the newest row of the lane by
    // its own moment.
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['started_at'], r['stopped_at'], r['ended']]).toEqual([w.moments!['start'], null, null])
    expect(rawOne<{ t: number }>(w, 'SELECT MAX(created_at) AS t FROM nodes WHERE session_key = ?', w.legs!['builder']!.sessionId)!.t).toBe(w.moments!['last'])
  })

  define(/^the reply judges nothing about whether the leg is stuck$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    const leg = reply.legs.find((g) => g.role === 'builder')!
    // Moments and states, no verdict: the leg's fields are the registry's
    // facts and its last write, and no word of the reply judges it.
    expect(Object.keys(leg).sort()).toEqual([
      'agent_id', 'checkpoints_written', 'key', 'key_src', 'keyless', 'kind', 'last_write_at', 'noticed_at', 'noticed_by',
      'opened_runs', 'role', 'session_id', 'started_at', 'state', 'stopped_at',
    ])
    expect(leg.state).toBe('live')
    // Needle liveness first: the verdict words fire on a reply that judges.
    expect('the builder leg looks stuck; it has been idle for 90 minutes', 'the verdict needle is dead').toMatch(VERDICT_NEEDLE)
    expect(JSON.stringify(reply)).not.toMatch(VERDICT_NEEDLE)
  })

  // ── D336: the pointer to the return of the leg that wrote the checkpoint ──

  define(/^a run "([^"]+)" whose key "([^"]+)" holds checkpoint number (\d+), written by a reviewer leg that finished with the report "([^"]+)"$/, async (w, run, key, num, report) => {
    await openRunWorld(w)
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    // Through the hooks door: the harness's brief names the reviewer as the
    // key's checkpointer, and the real SubagentStart hook infers the leg's
    // run, key and start from it.
    const leg = await hooksLeg(w, 'reviewer', 'reviewer', { run: run!, key: key!, checkpointer: 'reviewer' })
    expect(JSON.parse(String(rawRegistration(w, leg)['start_checkpoints']))).toEqual([ids.at(-1)!])
    const wrote = await insertEchoed(w, { agentId: leg.agentId, agentType: 'reviewer' }, 'state: original plus review; two fixes asked for', { kind: 'checkpoint', run: run!, key: key! })
    expect((wrote['checkpoint'] as Record<string, unknown>)['number']).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = wrote['node_id'] as string
    w.stops!['reviewer'] = subagentStopHook(w, leg.agentId, 'reviewer', report!)
    await drainStaging(w)
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)" and a pointer to the reviewer leg's summary row reading "([^"]+)"$/, (w, num, writer, report) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel(l.run, l.key, Number(num))], Number(num), writer]])
    const ret = l.checkpoints[0]!.legReturn
    expect(ret.leg).toEqual({ sessionId: w.sessionId, agentId: w.legs!['reviewer']!.agentId, role: 'reviewer', state: 'retired' })
    expect(ret.summary, ret.line).not.toBeNull()
    const id = ret.summary!.nodeId
    expect(ret.line).toBe(`Return of the reviewer leg that wrote checkpoint number ${num}: the summary row ${id} (writer "reviewer", run "${l.run}", key "${l.key}").`)
    // The row it points at is the reviewer's summary the SubagentStop hook
    // staged and the drain wrote, carrying the run and the key.
    expect(rawContentOf(w, id)).toBe(report)
    const m = rawMetaOf(w, id)
    expect([m['kind'], m['_writer'], m['_writer_agent_id'], m['run'], m['key']]).toEqual([SUBAGENT_SUMMARY_KIND, 'reviewer', w.legs!['reviewer']!.agentId, l.run, l.key])
    expect(rawRowOf(w, id)['session_key']).toBe(w.sessionId)
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds checkpoint number (\d+), written by a builder leg that was cut after writing it and left no summary row$/, async (w, run, key, num) => {
    await openRunWorld(w, { sessionStart: false })
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: key!, startCheckpoints: [ids.at(-1)!] })
    const r = await w.store!.writeCheckpoint('state: half the submit wired; next: the other half', { run: run!, key: key!, leg: ref })
    expect(r.checkpoint!.number).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = r.nodeId
    // The harness's timeout cut it (D292): retired as cut, no summary row.
    expect(cutByTimeout(w, ref)).toBe(true)
  })

  define(/^the harness receives checkpoint number (\d+) and a line saying the builder leg left no return$/, (w, num) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number])).toEqual([[w.cps![cpLabel(l.run, l.key, Number(num))], Number(num)]])
    const ret = l.checkpoints[0]!.legReturn
    expect(ret.summary).toBeNull()
    expect(ret.line).toBe(`The builder leg that wrote checkpoint number ${num} left no return: it ended cut, with no summary row.`)
    // Never guessed: the file holds no summary row in the builder's lane,
    // and the registration says it was cut.
    const lane = w.legs!['builder']!.sessionId
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = ?", lane, SUBAGENT_SUMMARY_KIND)).toHaveLength(0)
    expect(rawRegistration(w, w.legs!['builder']!)['ended']).toBe('cut')
  })

  // ── D337: the agent's door to the same reply, and to a run's close ──

  define(/^a run "([^"]+)" started (\d+) hours ago whose key "([^"]+)" holds checkpoint number (\d+), written by the writer "([^"]+)" against a brief naming the builder$/, async (w, run, hours, key, num, stranger) => {
    await openRunWorld(w)
    const start = Date.now() / 1000 - Number(hours) * HOUR
    await w.store!.openRun({ run: run!, by: 'harness', at: start })
    await w.store!.writeBrief(`build the ${key}`, { run: run!, key: key!, role: 'builder', checkpointer: 'builder', by: 'harness', at: start + 60 })
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    // The stranger is a leg of the run with no brief of its own: no brief
    // names it, so through the hooks door it would be a plain subagent
    // (D305), which no run counts and whose return no key names. It is a
    // worker its spawner registered under the run (the library door,
    // declared, its ticket naming no checkpointer), writing its checkpoint
    // as itself and returning its report at its exit, the summary row its
    // pointer names.
    const leg = await workerLeg(w, 'stranger', { role: stranger!, run: run!, key: key!, checkpointer: null, startCheckpoints: [ids.at(-1)!] })
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.brief_for') = ?", stranger)).toHaveLength(0)
    const wrote = await w.store!.writeCheckpoint('state: rewritten by another hand; ship it', { run: run!, key: key!, leg })
    expect(wrote.checkpoint!.number).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = wrote.nodeId
    await exitedWithSummary(w, leg, `${stranger} done: shipped the form`)
    w.moments!['start'] = start
  })

  define(/^an agent asks through treecontext's tools for the checkpoint in effect under the key "([^"]+)" on the run "([^"]+)"$/, async (w, key, run) => {
    await sessionClient(w)
    const reply = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run, key } } }))
    w.facts!['agent-reply'] = reply
    w.facts!['agent-asked'] = { run, key }
  })

  define(/^the agent receives checkpoint number (\d+) with the writer "([^"]+)", the flag that its writer is not the named checkpointer, the run's facts and the pointer to the leg's return, the same as the harness's reply$/, (w, num, writer) => {
    const agent = w.facts!['agent-reply'] as unknown as KeyLookupReply
    const asked = w.facts!['agent-asked'] as { run: string; key: string }
    expect(agent.checkpoints.map((c) => [c.node_id, c.number, c.writer])).toEqual([[w.cps![cpLabel(asked.run, asked.key, Number(num))], Number(num), writer]])
    const cp = agent.checkpoints[0]!
    expect(cp.flag).toBe(`The writer of checkpoint number ${num}, "${writer}", is not the checkpointer the brief names ("builder").`)
    expect(agent.facts.checkpoints_under_key).toBe(Number(num))
    expect(agent.facts.legs_run).toBe(1)
    expect(agent.facts.run_started_at).toBe(w.moments!['start'])
    expect(agent.facts.last_sizes).toEqual(rawSizes(w, asked.run, asked.key).slice(-3))
    // The pointer names the stranger's summary row, as the file holds it.
    const id = cp.return.summary_node_id
    expect(id, cp.return.line).not.toBeNull()
    const m = rawMetaOf(w, id!)
    expect([m['kind'], m['_writer'], m['run'], m['key']]).toEqual([SUBAGENT_SUMMARY_KIND, writer, asked.run, asked.key])
    expect(rawContentOf(w, id!)).toBe(`${writer} done: shipped the form`)
    // The harness's reply, asked the same thing through the library: the
    // same object, but for the moment each was read.
    const harness = keyLookupReply(w.store!.lookupKey(asked))
    const unclocked = (r: KeyLookupReply): unknown => ({ ...r, facts: { ...r.facts, as_of: 0, run_age_seconds: 0 } })
    expect(unclocked(agent)).toEqual(unclocked(harness))
    expect(Math.abs(agent.facts.as_of - harness.facts.as_of)).toBeLessThan(60)
    expect(Math.abs(agent.facts.run_age_seconds! - 3 * HOUR)).toBeLessThan(120)
  })

  define(/^a run "([^"]+)" open with (\d+) legs retired$/, async (w, run, n) => {
    await openRunWorld(w)
    for (let i = 0; i < Number(n); i++) {
      const ref = await workerLeg(w, `leg${i}`, { role: i === 0 ? 'builder' : 'reviewer', run: run!, key: 'login-form' })
      expect(retiredWithoutReturn(w, ref)).toBe(true)
    }
    w.ids!['open'] = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)!.node_id
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(0)
  })

  define(/^the main agent declares the run "([^"]+)" closed through treecontext's tools with the reason "([^"]+)"$/, async (w, run, reason) => {
    const before = Date.now() / 1000
    const reply = await insertEchoed(w, null, reason!, { kind: 'run-close', run, reason })
    w.moments!['before'] = before
    w.moments!['after'] = Date.now() / 1000
    w.ids!['close'] = reply['node_id'] as string
    expect(reply['run']).toEqual({ kind: 'run-close', run, closed_by: 'main', reason })
    // The call's own echo is drained, as Claude Code's capture would.
    await drainStaging(w)
  })

  define(/^a reader with the store file sees the run "([^"]+)" ended at that moment, by the main agent, with the reason "([^"]+)"$/, (w, run, reason) => {
    const rows = rawAll<{ node_id: string; created_at: number; by: string; why: string; writer: string; src: string; refs: string; door: string }>(w,
      `SELECT node_id, created_at, json_extract(metadata_json, '$.closed_by') AS by, json_extract(metadata_json, '$.reason') AS why,
              json_extract(metadata_json, '$._writer') AS writer, json_extract(metadata_json, '$._writer_src') AS src,
              json_extract(metadata_json, '$.refs') AS refs, json_extract(metadata_json, '$._door') AS door
         FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?`, run)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect([r.node_id, r.by, r.why, r.writer, r.door]).toEqual([w.ids!['close'], 'main', reason, 'main', 'tools'])
    expect(r.created_at).toBeGreaterThanOrEqual(w.moments!['before']!)
    expect(r.created_at).toBeLessThanOrEqual(w.moments!['after']!)
    // The harness's record: the line closeRun writes, pointing at the open.
    expect(JSON.parse(r.refs)).toEqual([w.ids!['open']])
    expect(rawContentOf(w, r.node_id)).toBe(`run ${run} closed by main: ${reason}`)
    // The echo confirmed the writer the store stamped.
    expect(['self', 'echo']).toContain(r.src)
  })

  // ── D344: the sizes of the last {3} ──

  define(/^a run "([^"]+)" whose key "([^"]+)" holds (\d+) checkpoints$/, async (w, run, key, count) => {
    await openRunWorld(w, { sessionStart: false })
    let prev: string | null = null
    for (let i = 1; i <= Number(count); i++) {
      const r = await w.store!.writeCheckpoint(sized(`after leg ${i}`, 100 + i * 7), {
        run: run!, key: key!, declared: { role: 'builder' }, ...(prev ? { supersedes: [prev] } : {}),
      })
      expect(r.checkpoint!.number).toBe(i)
      prev = r.nodeId
    }
  })

  define(/^the harness receives the sizes of the last (\d+) checkpoints under the key, newest last$/, (w, shown) => {
    const l = harnessLookup(w)
    const all = rawSizes(w, l.run, l.key)
    const n = Number(shown)
    expect(l.facts.lastSizes).toEqual(all.slice(all.length - n))
    expect(l.facts.lastSizes).toHaveLength(n)
    // Newest last: the sizes grow with the number, so the order shows.
    expect([...l.facts.lastSizes].sort((a, b) => a - b)).toEqual(l.facts.lastSizes)
    expect(keyLookupReply(l).facts.last_sizes).toEqual(l.facts.lastSizes)
  })

  // ── D300: a run's export, the skeleton by default ──

  define(/^a run "([^"]+)" with a builder leg and a reviewer leg, (\d+) checkpoints under the key "([^"]+)" and (\d+) under the key "([^"]+)", (\d+) summary rows, (\d+) first-moment rows and (\d+) captured tool calls$/, async (w, run, a, keyA, b, keyB, summaries, firsts, calls) => {
    expect([Number(a), Number(b), Number(summaries), Number(firsts), Number(calls)]).toEqual([4, 2, 2, 2, 120])
    expect([keyA, keyB]).toEqual(['login-form', 'search-box'])
    await runOfTwoDoors(w, run!, Number(calls), true)
    // What the Given made, read from the file before any export acts.
    expect(rawCheckpoints(w, run!, keyA!)).toHaveLength(4)
    expect(rawCheckpoints(w, run!, keyB!)).toHaveLength(2)
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'subagent-summary' AND json_extract(metadata_json, '$.run') = ?", run)[0]!.n).toBe(2)
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment' AND json_extract(metadata_json, '$.run') = ?", run)[0]!.n).toBe(2)
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%zebrafinch-%'")[0]!.n).toBe(120)
  })

  define(/^a run "([^"]+)" with (\d+) captured tool calls across its legs$/, async (w, run, calls) => {
    await runOfTwoDoors(w, run!, Number(calls), false)
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%zebrafinch-%'")[0]!.n).toBe(Number(calls))
  })

  define(/^an agent exports the run "([^"]+)" without naming a form$/, async (w, run) => {
    const agent = await toolClient(w)
    // No form, no acknowledgement: the call is the run and a path.
    const reply = await callTool(agent, 'treecontext_export', { run, path: 'handoffs/r1.json' })
    w.facts!['export-reply'] = reply
    expect(reply.isError, reply.text).toBe(false)
    w.facts!['export-file'] = readRunFile(join(w.proj!, 'handoffs', 'r1.json'))
  })

  define(/^the file holds the (\d+) checkpoints under both keys in order, the (\d+) summary rows with their writers "([^"]+)" and "([^"]+)", the (\d+) first-moment rows and the (\d+) registrations$/, (w, cps, sums, w1, w2, firsts, regs) => {
    const file = w.facts!['export-file'] as RunFile
    const stored = rawAll<{ node_id: string; created_at: number }>(w,
      `SELECT node_id, created_at FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint' AND json_extract(metadata_json, '$.run') = 'r1' ORDER BY created_at, rowid`)
    const checkpoints = kindsIn(file, 'checkpoint')
    expect(checkpoints).toHaveLength(Number(cps))
    expect(checkpoints.map((n) => n.nodeId)).toEqual(stored.map((r) => r.node_id))
    for (const key of ['login-form', 'search-box']) {
      expect(checkpoints.filter((n) => n.metadata!['key'] === key).map((n) => n.metadata!['_checkpoint_number'])).toEqual(key === 'login-form' ? [1, 2, 3, 4] : [1, 2])
    }
    // Content as the store holds it, not a stand-in.
    for (const n of checkpoints) expect(n.content).toBe(rawContentOf(w, n.nodeId))
    const summaries = kindsIn(file, 'subagent-summary')
    expect(summaries).toHaveLength(Number(sums))
    expect(summaries.map((n) => n.metadata!['_writer'])).toEqual([w1, w2])
    expect(summaries.map((n) => n.metadata!['run'])).toEqual(['r1', 'r1'])
    for (const n of summaries) expect(n.content).toBe(rawContentOf(w, n.nodeId))
    const firstMoments = kindsIn(file, 'first-moment')
    expect(firstMoments).toHaveLength(Number(firsts))
    for (const n of firstMoments) expect(n.content).toBe(rawContentOf(w, n.nodeId))
    // One first moment per leg: the hooks-door builder's and the
    // ticket-door reviewer's, whose row is the spawner's prompt.
    expect(firstMoments.map((n) => n.metadata!['_writer'])).toEqual(['builder', 'reviewer'])
    expect(firstMoments[1]!.content).toBe('review the login form the builder wired on r1')
    // The registrations: one per leg, the facts as data, none a row the
    // exporting store holds (its registry is a table).
    const regsInFile = kindsIn(file, 'leg-registration')
    expect(regsInFile).toHaveLength(Number(regs))
    const facts = regsInFile.map((n) => n.metadata!['_leg_registration'] as Record<string, unknown>)
    expect(facts.map((f) => [f['role'], f['run'], f['key'], f['door'], f['kind'], f['session_id'], f['ended']])).toEqual([
      ['builder', 'r1', 'login-form', 'hooks', 'subagent', w.sessionId, 'retired'],
      ['reviewer', 'r1', 'login-form', 'ticket', 'worker', w.legs!['reviewer']!.sessionId, 'retired'],
    ])
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'leg-registration'")[0]!.n).toBe(0)
    // Each registration names its leg as the store's table does.
    for (const f of facts) {
      const reg = rawOne<Record<string, unknown>>(w, 'SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?', f['session_id'], f['agent_id'])!
      expect([reg['agent_type'], reg['run'], reg['run_key'], reg['door'], reg['kind'], reg['ended']]).toEqual([f['role'], f['run'], f['key'], f['door'], f['kind'], f['ended']])
    }
    // And the file holds these and nothing else of the run: the skeleton's
    // rows are the ones D360 lists (its open and close, every brief, every
    // checkpoint, every first-moment and summary row, each registration as
    // data). The store holds the reviewer's send-back row with the run on
    // it, and the skeleton leaves it out. (The scenario is tagged @D300
    // only; D360 is the ruling that lists these rows, a tag for the owner.)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'send-back' AND json_extract(metadata_json, '$.run') = 'r1'")).toHaveLength(1)
    expect([...new Set(file.nodes.map((n) => n.metadata?.['kind']))].sort()).toEqual(['brief', 'checkpoint', 'first-moment', 'leg-registration', 'run-open', 'subagent-summary'].sort())
    // (The run was opened at its first leg's registration and nobody closed it.)
    expect(kindsIn(file, 'run-open')).toHaveLength(1)
  })

  define(/^the file holds none of the (\d+) tool calls$/, (w, calls) => {
    const file = w.facts!['export-file'] as RunFile
    // The calls exist in the store, so their absence is not an empty store.
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%zebrafinch-%'")[0]!.n).toBe(Number(calls))
    expect(holding(file, 'zebrafinch-')).toHaveLength(0)
  })

  define(/^the file's head names the form as the run's skeleton$/, (w) => {
    const file = w.facts!['export-file'] as RunFile
    expect([file.head['form'], file.head['run']]).toEqual(['skeleton', 'r1'])
    expect(String(file.head['holds'])).toContain('skeleton of the run "r1"')
    expect(String(file.head['holds'])).toContain('no captured tool output')
    expect(file.head['node_count']).toBe(file.nodes.length)
    expect(typeof file.head['exported_by']).toBe('string')
    expect(String(file.head['to_import'])).toContain('handoffs/r1.json')
    expect(Object.keys(file.head)).toEqual(expect.arrayContaining(['exported_at', 'project', 'treecontext_version', 'holds', 'to_import']))
  })

  // ── D300: the whole form, behind the acknowledgement ──

  define(/^a harness exports the run "([^"]+)" naming the whole form$/, (w, run) => {
    // The harness is a program: its door is the shell's. The first call
    // names the form and nothing else; the second acknowledges.
    const args = ['export', 'handoffs/r1-whole.json', '--run', run!, '--whole', '--store', w.dbPath!, '--project-dir', w.proj!, '--no-debug']
    const asked = spawnCli(args, { home: w.home!, cwd: w.proj! })
    w.facts!['whole-asked'] = { status: asked.status, stderr: asked.stderr, stdout: asked.stdout, fileAfter: existsSync(join(w.proj!, 'handoffs', 'r1-whole.json')) }
    const given = spawnCli([...args, '--yes'], { home: w.home!, cwd: w.proj! })
    w.facts!['whole-given'] = { status: given.status, stderr: given.stderr, stdout: given.stdout }
  })

  define(/^the reply carries the warning that captured tool output can hold secrets, tokens and keys, and the file is written only after it$/, (w) => {
    const asked = w.facts!['whole-asked'] as { status: number | null; stderr: string; stdout: string; fileAfter: boolean }
    expect(asked.stderr).toContain(RUN_SECRETS_WARNING)
    expect(asked.stderr).toMatch(/can hold secrets, tokens and keys/)
    expect(asked.status).toBe(1)
    expect(asked.fileAfter, 'the file was written before the acknowledgement').toBe(false)
    const given = w.facts!['whole-given'] as { status: number | null; stderr: string; stdout: string }
    expect(given.status, given.stderr).toBe(0)
    expect(given.stderr).toContain(RUN_SECRETS_WARNING)
    expect(existsSync(join(w.proj!, 'handoffs', 'r1-whole.json'))).toBe(true)
    expect(given.stdout).toMatch(/Wrote \d+ entries of the run "r1" \(whole\) to handoffs\/r1-whole\.json\./)
  })

  define(/^the file holds the (\d+) tool calls under each leg's lane$/, (w, calls) => { wholeFileHoldsCalls(w, calls!) })

  /** The whole form's file, read off the disk: the run's captured calls
   *  under each leg's lane, as the store holds them. */
  function wholeFileHoldsCalls(w: RunsWorld, calls: string): void {
    const file = readRunFile(join(w.proj!, 'handoffs', 'r1-whole.json'))
    expect(file.head['form']).toBe('whole')
    expect(file.head['run']).toBe('r1')
    const captured = holding(file, 'zebrafinch-')
    expect(captured).toHaveLength(Number(calls))
    // Under each leg's lane, as the store holds it: the hooks-door
    // builder's calls in the session's lane under its agent id, the
    // worker's in the worker's own lane; each call the leg's own, its
    // content as the store holds it.
    const laneOf = (id: string): string => String(rawRowOf(w, id)['session_key'])
    const builder = w.legs!['builder']!
    const reviewer = w.legs!['reviewer']!
    const lanes = {
      builder: captured.filter((n) => laneOf(n.nodeId) === builder.sessionId && n.metadata!['_writer_agent_id'] === builder.agentId),
      reviewer: captured.filter((n) => laneOf(n.nodeId) === reviewer.sessionId),
    }
    expect(lanes.builder, "the builder's calls").toHaveLength(Number(calls) - WORKER_CALLS)
    expect(lanes.reviewer, "the reviewer's calls").toHaveLength(WORKER_CALLS)
    for (const [role, mine] of Object.entries(lanes)) {
      for (const n of mine) {
        expect(n.metadata!['_writer']).toBe(role)
        expect(n.content).toContain(`${role} case-`)
      }
    }
    const some = captured[0]!
    expect(some.content).toBe(rawContentOf(w, some.nodeId))
    // The skeleton's rows are all there too, the whole form being a superset.
    expect(kindsIn(file, 'checkpoint')).toHaveLength(4)
    expect(kindsIn(file, 'leg-registration')).toHaveLength(2)
    // Every row of every leg: the reviewer's send-back row, which the
    // skeleton leaves out, is a row of its lane.
    expect(kindsIn(file, 'send-back').map((n) => laneOf(n.nodeId))).toEqual([reviewer.sessionId])
  }

  // ── D318: first moments whole, and the reply says what they are ──

  define(/^a run "([^"]+)" whose builder's first-moment row holds a (\d+)-character prompt$/, async (w, run, size) => {
    await openRunWorld(w, { sessionStart: false })
    const prompt = bigPrompt(Number(size), 'END-OF-THE-PASTED-FILE-quokka')
    expect(prompt).toHaveLength(Number(size))
    w.facts!['big-prompt'] = prompt
    // The builder is a real worker through the real wrapper: its first
    // moment is the row the ticket door writes, the prompt as written.
    await runWorker(w, {
      spawner: 'wrapper', prompt,
      ticket: { run: run!, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: 'state: the login form is built from the pasted file', print: 'builder done' } },
    }, 'builder')
    const row = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment' AND json_extract(metadata_json, '$.run') = ?", run)
    expect(row, 'the door wrote the builder\'s first-moment row').toBeTruthy()
    w.ids!['first-moment'] = row!.node_id
    expect(charactersOf(rawContentOf(w, row!.node_id))).toBe(Number(size))
  })

  define(/^the file holds all (\d+) characters of that first-moment row$/, (w, size) => {
    const file = w.facts!['export-file'] as RunFile
    const row = file.nodes.find((n) => n.nodeId === w.ids!['first-moment'])
    expect(row, 'the first-moment row is in the skeleton').toBeTruthy()
    expect(charactersOf(row!.content)).toBe(Number(size))
    expect(row!.content).toBe(w.facts!['big-prompt'])
    expect(row!.content.endsWith('END-OF-THE-PASTED-FILE-quokka')).toBe(true)
    expect(row!.content).toBe(rawContentOf(w, row!.nodeId))
  })

  define(/^the reply says in one line that first moments carry the spawners' prompts as written and may hold what was pasted into them$/, (w) => {
    const reply = w.facts!['export-reply'] as ToolReply
    const line = String(reply.json['first_moments'])
    expect(line).toBe("First moments carry the spawners' prompts as written and may hold what was pasted into them.")
    expect(line.split('\n')).toHaveLength(1)
    // A ticket-door first moment is the prompt itself, so there is no
    // door's-line note to make.
    expect(reply.json['door_lines']).toBeUndefined()
  })

  define(/^no acknowledgement is asked for$/, (w) => {
    const reply = w.facts!['export-reply'] as ToolReply
    expect(reply.isError).toBe(false)
    expect(reply.json['warning']).toBeUndefined()
    // The whole reply: the file, the run, the form, the counts, the message and the one line; no warning to acknowledge.
    expect(Object.keys(reply.json).sort()).toEqual(['entries', 'file', 'first_moments', 'form', 'message', 'run'])
    expect(reply.json['file']).toBe('handoffs/r1.json')
    expect(existsSync(join(w.proj!, 'handoffs', 'r1.json'))).toBe(true)
  })

  // ── D310, D343: a leg that ran elsewhere comes back by the handoff ──

  define(/^a run "([^"]+)" in the store on "([^"]+)" with (\d+) legs whose key "([^"]+)" holds checkpoint number (\d+), and a third leg of "([^"]+)" that ran on "([^"]+)" and wrote checkpoint number (\d+) under "([^"]+)" there, naming number (\d+) as superseded$/, async (w, run, local, legs, key, lastNum, run2, remoteName, thirdNum, key2, namedNum) => {
    expect([run2, key2]).toEqual([run, key])
    expect([Number(legs), Number(lastNum), Number(thirdNum), Number(namedNum)]).toEqual([2, 2, 3, 2])
    await openRunWorld(w, { sessionStart: false })
    w.facts!['machines'] = { local, remote: remoteName }
    // The laptop's two legs: real workers through the real ticket door.
    for (let i = 1; i <= 2; i++) {
      await runWorker(w, {
        spawner: 'library', prompt: `build the login form, part ${i}`,
        ticket: { run: run!, key: key!, role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
        plan: { first: { checkpoint: `state of ${key} on ${local} after leg ${i}: part ${i} done`, print: `part ${i} done` } },
      }, `${local}-leg${i}`)
    }
    const two = w.store!.checkpointsInEffect(run!, key!)
    expect(two.map((c) => c.number)).toEqual([2])
    w.cps![cpLabel(run!, key!, 2)] = two[0]!.nodeId
    // The run is handed to build-02, as a run is handed to a machine that
    // will run a leg of it: the laptop's agent exports its skeleton, the
    // repository carries it, build-02's agent imports it.
    const remote = await otherMachine(w)
    w.facts!['remote'] = remote
    const out = await callTool(await toolClient(w), 'treecontext_export', { run, path: 'handoffs/to-build-02.json' })
    expect(out.isError, out.text).toBe(false)
    carry(w, remote, 'handoffs/to-build-02.json')
    const into = await callTool(await toolClient(remote), 'treecontext_import', { path: 'handoffs/to-build-02.json' })
    expect(into.isError, into.text).toBe(false)
    // The third leg, there: a real worker through build-02's ticket door,
    // started from what is in effect there (the laptop's number 2, which
    // arrived by import and took no number in build-02's sequence). It
    // checkpoints three times as it works, so build-02's own sequence gives
    // the last one the number 3, and each supersedes the one before.
    await runWorker(remote, {
      spawner: 'library', prompt: 'finish the login form on build-02',
      ticket: { run: run!, key: key!, role: 'builder', checkpointer: 'builder', parent: { id: remote.sessionId! } },
      plan: { first: { checkpoints: [1, 2, 3].map((n) => `state of ${key} on ${remoteName}, step ${n}: ${n === 3 ? 'the login form is finished' : 'the login form is half wired'}`), print: 'build-02 done' } },
    }, `${remoteName}-leg`)
    const there = rawCheckpoints(remote, run!, key!).filter((c) => !String(rawRowOf(remote, c.node_id)['session_key']).startsWith('handoff:'))
    expect(there.map((c) => c.n)).toEqual([1, 2, 3])
    // Number 3 names number 2 as superseded, on build-02's own file; the
    // first of them started from the laptop's number 2 and named it.
    expect(there[2]!.m['supersedes']).toEqual([there[1]!.node_id])
    expect(there[0]!.m['supersedes']).toEqual([w.cps![cpLabel(run!, key!, 2)]])
    w.ids!['third-cp'] = there[2]!.node_id
    w.ids!['third-cp-2'] = there[1]!.node_id
    w.ids!['third-cp-1'] = there[0]!.node_id
    w.ids!['third-session'] = (remote.legs![`${remoteName}-leg`] as { sessionId: string }).sessionId
  })

  define(/^the run "([^"]+)" is exported on "([^"]+)" and imported on "([^"]+)"$/, async (w, run, remoteName, localName) => {
    const m = w.facts!['machines'] as { local: string; remote: string }
    expect([remoteName, localName]).toEqual([m.remote, m.local])
    const remote = w.facts!['remote'] as RunsWorld
    // The laptop's own number 2, where the run has one, kept as SQLite held it.
    const cp2 = w.cps![cpLabel(run!, 'login-form', 2)]
    if (cp2 !== undefined) w.before!['cp2'] = rawRowOf(w, cp2)
    const out = await callTool(await toolClient(remote), 'treecontext_export', { run, path: 'handoffs/r1-from-build-02.json' })
    expect(out.isError, out.text).toBe(false)
    w.facts!['back-file'] = readRunFile(join(remote.proj!, 'handoffs', 'r1-from-build-02.json'))
    carry(remote, w, 'handoffs/r1-from-build-02.json')
    const into = await callTool(await toolClient(w), 'treecontext_import', { path: 'handoffs/r1-from-build-02.json' })
    expect(into.isError, into.text).toBe(false)
    w.facts!['import-reply'] = into.json
  })

  define(/^the harness on "([^"]+)" looking up the key "([^"]+)" on the run "([^"]+)" counts (\d+) legs$/, async (w, machine, key, run, legs) => {
    expect(machine).toBe((w.facts!['machines'] as { local: string }).local)
    const l = w.store!.lookupKey({ run: run!, key: key! })
    w.lookups![run!] = l
    expect(l.facts.legsRun).toBe(Number(legs))
    expect(l.legs).toHaveLength(Number(legs))
    // Marked as arrived by import: the third leg, from the file build-02
    // wrote, and not a registration of this store.
    const arrived = l.legs.filter((g) => g.imported !== null)
    expect(arrived.map((g) => [g.sessionId, g.role, g.state, g.imported!.file])).toEqual([[w.ids!['third-session'], 'builder', 'retired', 'handoffs/r1-from-build-02.json']])
    expect(l.facts.importedLegs).toBe(1)
    expect(rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM session_registry WHERE session_id = ?', w.ids!['third-session'])[0]!.n).toBe(0)
    // The agent's door says the same through the tools.
    const agent = parseTool(await (await toolClient(w)).callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run, key } } })) as unknown as KeyLookupReply
    expect(agent.facts.legs_run).toBe(Number(legs))
    expect(agent.facts.imported_legs).toBe(1)
    expect(agent.legs.filter((g) => g.imported !== undefined).map((g) => g.session_id)).toEqual([w.ids!['third-session']])
  })

  define(/^the harness receives the imported number (\d+) as the one in effect, flagged as arrived by import, and not number (\d+)$/, (w, num, notNum) => {
    const l = harnessLookup(w)
    // The imported checkpoint takes no number in this store's sequence: its
    // number is the one its own store gave it, the file's claim (D360).
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.claimedNumber, c.imported])).toEqual([[w.ids!['third-cp'], null, Number(num), true]])
    expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(w.cps![cpLabel('r1', 'login-form', Number(notNum))])
    const cp = l.checkpoints[0]!
    expect(cp.flag).toBe(`Checkpoint number ${num} as numbered there arrived by import from "handoffs/r1-from-build-02.json", written there by "builder"; `
      + `the file claims it supersedes checkpoint number ${notNum} as numbered there, and this lookup believes the claim.`)
    expect(l.line).toBe(`Checkpoint number ${num} as numbered there is in effect under "login-form" on the run "r1".`)
    // The laptop's own number 2 is superseded by the chain the file claims
    // (the first of build-02's checkpoints named it), and still its own.
    expect(l.checkpoints.map((c) => c.number)).not.toContain(Number(notNum))
    // The pointer into the handoff lane: the imported leg's return, named as arrived by import.
    const ret = cp.legReturn
    expect(ret.summary, ret.line).not.toBeNull()
    expect(ret.line).toContain(`checkpoint number ${num} as numbered there, which arrived by import`)
    expect(ret.line).toContain(`handoff:${w.ids!['third-session']}`)
    expect(rawRowOf(w, ret.summary!.nodeId)['session_key']).toBe(`handoff:${w.ids!['third-session']}`)
    expect(rawMetaOf(w, ret.summary!.nodeId)['kind']).toBe(SUBAGENT_SUMMARY_KIND)
    expect(rawContentOf(w, ret.summary!.nodeId)).toBe('build-02 done')
  })

  define(/^checkpoint number (\d+) is unchanged byte for byte and still readable by its id$/, async (w, num) => {
    const id = w.cps![cpLabel('r1', 'login-form', Number(num))]!
    expect(rawRowOf(w, id)).toEqual(w.before!['cp2'])
    const read = await callTool(await toolClient(w), 'treecontext_export', { node_id: id })
    expect(read.isError, read.text).toBe(false)
    const nodes = read.json['nodes'] as Array<{ nodeId: string; content: string }>
    expect(nodes.map((n) => n.nodeId)).toEqual([id])
    expect(nodes[0]!.content).toBe(rawContentOf(w, id))
    // Still the lane's own: the local number 2 is not flagged as superseded in its metadata.
    const m = rawMetaOf(w, id)
    expect(m['superseded_by']).toBeUndefined()
    expect(m['_handoff_file']).toBeUndefined()
  })

  define(/^the imported row keeps its claim under the file's claims, not as its own identity$/, (w) => {
    const id = w.ids!['third-cp']!
    const row = rawRowOf(w, id)
    expect(row['session_key']).toBe(`handoff:${w.ids!['third-session']}`)
    const m = rawMetaOf(w, id)
    // Marked by the importer; the file's claim of authorship, supersession and lane not its own.
    expect(m['_handoff_file']).toBe('handoffs/r1-from-build-02.json')
    for (const k of ['supersedes', 'superseded_by', '_writer', '_over_cap']) expect(m[k], k).toBeUndefined()
    // The lane is the importer's: the sender's session behind the handoff prefix, never the sender's own.
    expect(m['session_id']).toBe(`handoff:${w.ids!['third-session']}`)
    const claims = m['_handoff_claims'] as Record<string, unknown>
    expect(claims['supersedes']).toEqual([w.ids!['third-cp-2']])
    expect([claims['run'], claims['key'], claims['_checkpoint_number'], claims['_writer'], claims['_cc_session_id']]).toEqual(['r1', 'login-form', 3, 'builder', w.ids!['third-session']])
    expect(m['_cc_session_id']).toBeUndefined()
    // Every stamp and trace key the sender's store wrote, and the number it
    // gave, is under the claims and not at the row's top level (D293, D360):
    // the receiving store stamps only that the row arrived by import.
    const senderStamps = ['_writer', '_writer_src', '_writer_agent_id', '_door', '_identity', '_parent', '_parent_src', '_cwd', '_supersedes_src', '_checkpoint_number']
    for (const k of senderStamps) expect(claims[k], `${k} under the claims`).not.toBeUndefined()
    expect(claims['_door']).toBe('ticket')
    for (const k of new Set([...WRITER_STAMP_KEYS, '_cap_refused', '_by_src', '_supersedes_src', '_checkpoint_number'])) {
      if (k === '_door' || k === '_identity') continue
      expect(m[k], `${k} at the top level`).toBeUndefined()
    }
    expect([m['_door'], m['_identity']]).toEqual(['import', 'imported'])
    expect(JSON.stringify(m)).toContain(String(claims['_cwd']))
    expect(JSON.stringify({ ...m, _handoff_claims: undefined })).not.toContain(String(claims['_cwd']))
    // The remote leg's registration facts arrived as claims too, never as the row's own top level.
    const reg = rawAll<{ m: string }>(w, "SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'leg-registration' AND session_key = ?", `handoff:${w.ids!['third-session']}`)
    expect(reg).toHaveLength(1)
    const rm = JSON.parse(reg[0]!.m) as Record<string, unknown>
    expect(rm['_leg_registration']).toBeUndefined()
    const facts = (rm['_handoff_claims'] as Record<string, unknown>)['_leg_registration'] as Record<string, unknown>
    expect([facts['role'], facts['run'], facts['key'], facts['kind'], facts['door'], facts['ended']]).toEqual(['builder', 'r1', 'login-form', 'worker', 'ticket', 'retired'])
    // Plain SQL reads the run back whole from this one store: the imported rows in their own moments' order, each naming its writer as imported.
    const rows = rawAll<{ node_id: string; created_at: number; writer: string | null; kind: string }>(w, RUN_ROWS_SQL, 'r1', 'r1')
    expect(rows.map((r) => r.created_at)).toEqual(rows.map((r) => r.created_at).sort((a, b) => a - b))
    const imported = rows.filter((r) => r.writer?.startsWith('imported from '))
    expect(imported.length).toBeGreaterThanOrEqual(4)
    for (const r of imported) expect(r.writer).toBe('imported from handoffs/r1-from-build-02.json')
    expect(imported.find((r) => r.node_id === id)).toBeTruthy()
    expect(rows.filter((r) => r.writer === 'builder' || r.writer === null || !r.writer.startsWith('imported')).length).toBeGreaterThan(0)
  })

  // ── D343, D310: a hooks-door leg that ran elsewhere, its return in its handoff lane ──
  //
  // build-02 runs the reviewer as Claude Code runs a subagent: the real
  // SubagentStart hook registers it under the parent session there, it
  // writes its checkpoints through the real insert tool with their echoes,
  // and the real SubagentStop hook stages its report, which the drain
  // writes as its summary row in the parent session's lane under its agent
  // id. The laptop's builder is a real worker through the ticket door.

  define(/^a run "([^"]+)" in the store on "([^"]+)" with a builder leg, and a reviewer leg of "([^"]+)" that ran as a Claude Code subagent on "([^"]+)" and wrote checkpoint number (\d+) under "([^"]+)" there, naming number (\d+) as superseded$/, async (w, run, local, run2, remoteName, num, key, namedNum) => {
    expect(run2).toBe(run)
    expect([Number(num), Number(namedNum)]).toEqual([2, 1])
    await openRunWorld(w, { sessionStart: false })
    w.facts!['machines'] = { local, remote: remoteName }
    await runWorker(w, {
      spawner: 'library', prompt: 'build the login form',
      ticket: { run: run!, key: key!, role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: `state of ${key} on ${local}: the builder wired it`, print: 'builder done on the laptop' } },
    }, 'builder')
    const one = w.store!.checkpointsInEffect(run!, key!)
    expect(one.map((c) => c.number)).toEqual([1])
    w.cps![cpLabel(run!, key!, 1)] = one[0]!.nodeId
    // The run is handed to build-02 by its skeleton, through the tools.
    const remote = await otherMachine(w)
    w.facts!['remote'] = remote
    sessionStartHook(remote)
    const out = await callTool(await toolClient(w), 'treecontext_export', { run, path: 'handoffs/to-build-02.json' })
    expect(out.isError, out.text).toBe(false)
    carry(w, remote, 'handoffs/to-build-02.json')
    const into = await callTool(await toolClient(remote), 'treecontext_import', { path: 'handoffs/to-build-02.json' })
    expect(into.isError, into.text).toBe(false)
    // The reviewer, a Claude Code subagent on build-02. Its two checkpoints
    // are numbered by build-02's own sequence (the laptop's imported number
    // 1 takes none there): its number 2 names its number 1 as superseded.
    const ref = await hooksLeg(remote, 'reviewer', 'reviewer', { run: run!, key: key!, checkpointer: 'reviewer' })
    const agent = { agentId: ref.agentId, agentType: 'reviewer' }
    for (const i of [1, 2]) {
      await insertEchoed(remote, agent, `state of ${key} on ${remoteName} after the reviewer: review ${i} done`, { kind: 'checkpoint', run, key })
    }
    const report = 'review done on build-02: the login form holds'
    w.facts!['reviewer-report'] = report
    subagentStopHook(remote, ref.agentId, 'reviewer', report)
    await drainStaging(remote)
    const there = rawCheckpoints(remote, run!, key!).filter((c) => !String(rawRowOf(remote, c.node_id)['session_key']).startsWith('handoff:'))
    expect(there.map((c) => c.n)).toEqual([1, 2])
    expect(there[1]!.m['supersedes']).toEqual([there[0]!.node_id])
    expect(there.map((c) => c.m['_writer_agent_id'])).toEqual([ref.agentId, ref.agentId])
    // The summary row the hook staged and the drain wrote, in the session's lane under the agent.
    const sum = rawAll<{ node_id: string }>(remote,
      "SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary' AND json_extract(metadata_json, '$._writer_agent_id') = ?", remote.sessionId, ref.agentId)
    expect(sum).toHaveLength(1)
    expect(rawContentOf(remote, sum[0]!.node_id)).toBe(report)
    // Under the same parent on build-02, after the reviewer, an explorer
    // subagent of no run: the real SubagentStart and SubagentStop hooks, its
    // report the newest summary row of the session's lane.
    const explorer = hooksSubagent(remote, 'explorer', 'explorer')
    subagentStopHook(remote, explorer.agentId, 'explorer', 'explored the repository layout for build-02')
    await drainStaging(remote)
    const lane = rawAll<{ node_id: string; agent: string; created_at: number }>(remote,
      "SELECT node_id, json_extract(metadata_json, '$._writer_agent_id') AS agent, created_at FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary' ORDER BY created_at, rowid", remote.sessionId)
    expect(lane.map((r) => r.agent)).toEqual([ref.agentId, explorer.agentId])
    expect(lane[1]!.created_at).toBeGreaterThan(lane[0]!.created_at)
    // build-02's developer also hands the laptop the journal's default
    // handoff (its chapter and subagent summaries), as the handoff is used
    // between machines; so the laptop's handoff lane of build-02's session
    // holds both subagents' summaries, the explorer's the newest.
    const sums = await callTool(await toolClient(remote), 'treecontext_export', { path: 'handoffs/build-02-summaries.json' })
    expect(sums.isError, sums.text).toBe(false)
    carry(remote, w, 'handoffs/build-02-summaries.json')
    const took = await callTool(await toolClient(w), 'treecontext_import', { path: 'handoffs/build-02-summaries.json' })
    expect(took.isError, took.text).toBe(false)
    const landed = rawAll<{ node_id: string }>(w,
      "SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary' ORDER BY created_at, rowid", `handoff:${remote.sessionId}`)
    expect(landed.map((r) => r.node_id)).toEqual([sum[0]!.node_id, lane[1]!.node_id])
    w.ids!['explorer-summary'] = lane[1]!.node_id
    w.ids!['third-cp'] = there[1]!.node_id
    w.ids!['reviewer-summary'] = sum[0]!.node_id
    w.ids!['third-session'] = remote.sessionId!
    w.ids!['reviewer-agent'] = ref.agentId
  })

  define(/^the harness on "([^"]+)" looking up the key "([^"]+)" on the run "([^"]+)" counts (\d+) legs, one of them imported$/, async (w, machine, key, run, legs) => {
    expect(machine).toBe((w.facts!['machines'] as { local: string }).local)
    const l = w.store!.lookupKey({ run: run!, key: key! })
    w.lookups![run!] = l
    expect(l.facts.legsRun).toBe(Number(legs))
    expect(l.legs).toHaveLength(Number(legs))
    const arrived = l.legs.filter((g) => g.imported !== null)
    expect(arrived.map((g) => [g.sessionId, g.agentId, g.role, g.state, g.imported!.file]))
      .toEqual([[w.ids!['third-session'], w.ids!['reviewer-agent'], 'reviewer', 'retired', 'handoffs/r1-from-build-02.json']])
    expect(l.facts.importedLegs).toBe(1)
    // The other leg is the laptop's own builder, registered here.
    expect(l.legs.filter((g) => g.imported === null).map((g) => [g.sessionId, g.role])).toEqual([[w.legs!['builder']!.sessionId, 'builder']])
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ? AND agent_id = ?', w.ids!['third-session'], w.ids!['reviewer-agent'])).toHaveLength(0)
    const agent = parseTool(await (await toolClient(w)).callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run, key } } })) as unknown as KeyLookupReply
    expect([agent.facts.legs_run, agent.facts.imported_legs]).toEqual([Number(legs), 1])
  })

  define(/^the imported number (\d+) is the one in effect, flagged as arrived by import$/, (w, num) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.claimedNumber, c.imported])).toEqual([[w.ids!['third-cp'], null, Number(num), true]])
    expect(l.checkpoints[0]!.flag).toMatch(new RegExp(`^Checkpoint number ${num} as numbered there arrived by import from "handoffs/r1-from-build-02\\.json", written there by "reviewer"; `
      + 'the file claims it supersedes checkpoint number 1 as numbered there'))
    expect(rawRowOf(w, l.checkpoints[0]!.nodeId)['session_key']).toBe(`handoff:${w.ids!['third-session']}`)
  })

  define(/^its return pointer names the reviewer's summary row in the handoff lane and says it arrived by import$/, (w) => {
    const ret = harnessLookup(w).checkpoints[0]!.legReturn
    expect(ret.summary, ret.line).not.toBeNull()
    // The reviewer's summary row, as it landed here: the same row, in its handoff lane.
    const id = ret.summary!.nodeId
    // Picked by its agent, not as the lane's newest: the explorer's row is newer in the same lane.
    const lane = rawAll<{ node_id: string }>(w,
      "SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary' ORDER BY created_at DESC, rowid DESC", `handoff:${w.ids!['third-session']}`)
    expect(lane.map((r) => r.node_id)).toEqual([w.ids!['explorer-summary'], w.ids!['reviewer-summary']])
    expect(id).toBe(w.ids!['reviewer-summary'])
    expect(rawRowOf(w, id)['session_key']).toBe(`handoff:${w.ids!['third-session']}`)
    expect(rawMetaOf(w, id)['kind']).toBe('subagent-summary')
    expect(rawContentOf(w, id)).toBe(w.facts!['reviewer-report'])
    expect([ret.leg?.role, ret.leg?.agentId]).toEqual(['reviewer', w.ids!['reviewer-agent']])
    expect(ret.line).toContain(`the summary row ${id} in the handoff lane handoff:${w.ids!['third-session']}`)
    expect(ret.line).toContain('which arrived by import')
  })

  // ── D360, D310: a run carried back into the store it came from ──

  define(/^a run "([^"]+)" in the store on "([^"]+)" with a builder leg and a reviewer leg, (\d+) checkpoints under the key "([^"]+)" and (\d+) summary rows$/, async (w, run, local, cps, key, sums) => {
    expect([Number(cps), Number(sums)]).toEqual([3, 2])
    await openRunWorld(w)
    w.facts!['machines'] = { local }
    // The builder, a hooks-door leg: two checkpoints through the tools, its report at its stop.
    const ref = await hooksLeg(w, 'builder', 'builder', { run: run!, key: key!, checkpointer: 'builder' })
    for (const i of [1, 2]) {
      await insertEchoed(w, { agentId: ref.agentId, agentType: 'builder' }, `state of ${key} after the builder: step ${i} done`, { kind: 'checkpoint', run, key })
    }
    subagentStopHook(w, ref.agentId, 'builder', 'builder done: login-form wired')
    await drainStaging(w)
    // The reviewer, a worker through the ticket door: one checkpoint, its last output its summary row.
    await runWorker(w, {
      spawner: 'library', prompt: `review the login form on ${run}`,
      ticket: { run: run!, key: key!, role: 'reviewer', checkpointer: 'reviewer', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: `state of ${key} after the reviewer: review done`, print: 'reviewer done: login-form holds' } },
    }, 'reviewer')
    expect(rawCheckpoints(w, run!, key!).map((c) => c.n)).toEqual([1, 2, 3])
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'subagent-summary' AND json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(Number(sums))
  })

  define(/^the run "([^"]+)" is exported on "([^"]+)" and that same file is imported on "([^"]+)"$/, async (w, run, from, to) => {
    const m = w.facts!['machines'] as { local: string }
    expect([from, to]).toEqual([m.local, m.local])
    // Every row of the run, and every registration, as SQLite held them before.
    w.facts!['run-rows-before'] = rawAll<Record<string, unknown>>(w,
      `SELECT * FROM nodes WHERE node_id IN (SELECT node_id FROM (${RUN_ROWS_SQL})) ORDER BY rowid`, run, run)
    w.facts!['nodes-before'] = rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM nodes')[0]!.n
    w.facts!['registry-before'] = rawAll<Record<string, unknown>>(w, 'SELECT * FROM session_registry WHERE run = ? ORDER BY session_id, agent_id', run)
    const agent = await toolClient(w)
    const out = await callTool(agent, 'treecontext_export', { run, path: 'handoffs/r1-roundtrip.json' })
    expect(out.isError, out.text).toBe(false)
    w.facts!['export-file'] = readRunFile(join(w.proj!, 'handoffs', 'r1-roundtrip.json'))
    const into = await callTool(agent, 'treecontext_import', { path: 'handoffs/r1-roundtrip.json' })
    expect(into.isError, into.text).toBe(false)
    w.facts!['import-reply'] = into.json
  })

  define(/^the harness on "([^"]+)" looking up the key "([^"]+)" on the run "([^"]+)" still counts (\d+) legs and none imported$/, (w, machine, key, run, legs) => {
    expect(machine).toBe((w.facts!['machines'] as { local: string }).local)
    const l = w.store!.lookupKey({ run: run!, key: key! })
    w.lookups![run!] = l
    expect(l.facts.legsRun).toBe(Number(legs))
    expect(l.facts.importedLegs).toBe(0)
    // Exactly the two legs this store registered, each counted once and neither marked as arrived by import.
    const want = (['builder', 'reviewer'] as const).map((role) => [w.legs![role]!.sessionId, w.legs![role]!.agentId, role, null])
    expect(l.legs.map((g) => [g.sessionId, g.agentId, g.role, g.imported]).sort()).toEqual(want.sort())
  })

  define(/^the store holds each of the run's rows once, unchanged byte for byte, and one registration per leg$/, (w) => {
    const file = w.facts!['export-file'] as RunFile
    const before = w.facts!['run-rows-before'] as Array<Record<string, unknown>>
    // The file carried the run's rows and the two registrations as data.
    expect(kindsIn(file, 'leg-registration')).toHaveLength(2)
    expect(kindsIn(file, 'checkpoint')).toHaveLength(3)
    // Every row the file carried was already here: none landed.
    const reply = w.facts!['import-reply'] as Record<string, unknown>
    expect([reply['landed'], reply['already_present']]).toEqual([0, file.nodes.length])
    // Each row of the run, once and byte for byte as before.
    const after = rawAll<Record<string, unknown>>(w,
      `SELECT * FROM nodes WHERE node_id IN (SELECT node_id FROM (${RUN_ROWS_SQL})) ORDER BY rowid`, 'r1', 'r1')
    expect(before.length).toBeGreaterThan(file.nodes.length - 2)
    expect(after).toEqual(before)
    expect(rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM nodes')[0]!.n).toBe(w.facts!['nodes-before'])
    for (const n of file.nodes.filter((x) => x.metadata?.['kind'] !== 'leg-registration')) {
      expect(rawAll(w, 'SELECT 1 FROM nodes WHERE node_id = ?', n.nodeId), n.nodeId).toHaveLength(1)
    }
    // No handoff lane and no registration row: one registration per leg, the registry's own.
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE session_key LIKE 'handoff:%' OR json_extract(metadata_json, '$.kind') = 'leg-registration'")[0]!.n).toBe(0)
    const regs = rawAll<Record<string, unknown>>(w, 'SELECT * FROM session_registry WHERE run = ? ORDER BY session_id, agent_id', 'r1')
    expect(regs).toEqual(w.facts!['registry-before'])
    expect(regs.map((r) => [r['agent_type'], r['session_id'], r['agent_id']]).sort()).toEqual(
      (['builder', 'reviewer'] as const).map((role) => [role, w.legs![role]!.sessionId, w.legs![role]!.agentId]).sort())
  })

  // ── D310, D289: a leg's whole export, read back by plain SQL ──

  define(/^a run "([^"]+)" whose reviewer leg ran on "([^"]+)" and made (\d+) captured tool calls there$/, async (w, run, remoteName, calls) => {
    await openRunWorld(w, { sessionStart: false })
    w.facts!['machines'] = { local: 'laptop', remote: remoteName }
    await runWorker(w, {
      spawner: 'library', prompt: 'build the login form',
      ticket: { run: run!, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: 'state of login-form on the laptop: the builder wired it', print: 'builder done on the laptop' } },
    }, 'builder')
    const remote = await otherMachine(w)
    w.facts!['remote'] = remote
    sessionStartHook(remote)
    const out = await callTool(await toolClient(w), 'treecontext_export', { run, path: 'handoffs/to-build-02.json' })
    expect(out.isError, out.text).toBe(false)
    carry(w, remote, 'handoffs/to-build-02.json')
    const into = await callTool(await toolClient(remote), 'treecontext_import', { path: 'handoffs/to-build-02.json' })
    expect(into.isError, into.text).toBe(false)
    // The reviewer there: a `claude -p` child through build-02's wrapper,
    // its tool calls captured by the real hooks into its own lane.
    const done = await runWorker(remote, {
      spawner: 'wrapper', prompt: `review the login form the builder wired on ${run}`,
      ticket: { run: run!, key: 'login-form', role: 'reviewer', checkpointer: 'reviewer', parent: { id: remote.sessionId!, cli: 'claude-code' } },
      plan: { first: {} },
      claudeP: { tools: Number(calls), toolText: 'reviewer case-{i}: 1 passed (okapi-reviewer-{i})', checkpoint: 'state of login-form after the reviewer: review done', final: 'reviewer done on build-02' },
    }, 'reviewer')
    expect(done.exitCode, done.stderr).toBe(0)
    await drainStaging(remote)
    const lane = done.sessionId!
    w.ids!['reviewer-session'] = lane
    expect(rawAll<{ n: number }>(remote, "SELECT COUNT(*) AS n FROM nodes WHERE session_key = ? AND content LIKE '%okapi-reviewer-%'", lane)[0]!.n).toBe(Number(calls))
  })

  define(/^the run "([^"]+)" is exported whole on "([^"]+)", the warning acknowledged, and imported on "([^"]+)"$/, async (w, run, remoteName, localName) => {
    const m = w.facts!['machines'] as { local: string; remote: string }
    expect([remoteName, localName]).toEqual([m.remote, m.local])
    const remote = w.facts!['remote'] as RunsWorld
    // build-02's harness, through the shell: the warning first, nothing written; then acknowledged.
    const rel = 'handoffs/r1-whole-from-build-02.json'
    const args = ['export', rel, '--run', run!, '--whole', '--store', remote.dbPath!, '--project-dir', remote.proj!, '--no-debug']
    const asked = spawnCli(args, { home: remote.home!, cwd: remote.proj! })
    expect(asked.status, asked.stderr).toBe(1)
    expect(asked.stderr).toMatch(/can hold secrets, tokens and keys/)
    expect(existsSync(join(remote.proj!, rel))).toBe(false)
    const given = spawnCli([...args, '--yes'], { home: remote.home!, cwd: remote.proj! })
    expect(given.status, given.stderr).toBe(0)
    w.facts!['back-file'] = readRunFile(join(remote.proj!, rel))
    carry(remote, w, rel)
    // The laptop's own rows, every column as SQLite held them before the import.
    w.facts!['laptop-before'] = rawAll<Record<string, unknown>>(w, 'SELECT * FROM nodes ORDER BY rowid')
    w.moments!['import'] = Date.now() / 1000
    const into = await callTool(await toolClient(w), 'treecontext_import', { path: rel })
    expect(into.isError, into.text).toBe(false)
  })

  define(/^a reader on "([^"]+)" with the store file and plain SQL reads the run's rows with the reviewer's (\d+) captured rows among them, in the order of their own moments, each naming its writer as imported from the file$/, (w, machine, calls) => {
    expect(machine).toBe((w.facts!['machines'] as { local: string }).local)
    const raw = readerOf(w)
    const rows = raw.prepare(RUN_ROWS_SQL).all('r1', 'r1') as Array<{ node_id: string; created_at: number; writer: string | null; leg_session: string | null; leg_role: string | null }>
    w.sqlRows = rows as unknown as Array<Record<string, unknown>>
    // In the order of their own moments, the whole read.
    expect(rows.map((r) => r.created_at)).toEqual(rows.map((r) => r.created_at).sort((a, b) => a - b))
    const contentOf = (id: string): string => rawContentOf(w, id)
    const captured = rows.filter((r) => contentOf(r.node_id).includes('okapi-reviewer-'))
    expect(captured).toHaveLength(Number(calls))
    // Each call's own moment, as the file carried it from build-02: not the import's.
    const file = w.facts!['back-file'] as RunFile
    const sent = new Map(file.nodes.map((n) => [n.nodeId, n.createdAt]))
    for (const r of captured) {
      expect(r.created_at).toBe(sent.get(r.node_id))
      expect(r.created_at).toBeLessThan(w.moments!['import']!)
    }
    // The calls in the order they were made: call 1 first, call 30 last.
    const order = captured.map((r) => Number(/okapi-reviewer-(\d+)/.exec(contentOf(r.node_id))![1]))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(Number(calls))
    for (const r of captured) expect(r.writer).toBe('imported from handoffs/r1-whole-from-build-02.json')
  })

  define(/^the captured rows reach the run through the reviewer's imported registration, no row of "([^"]+)" renamed$/, (w, machine) => {
    expect(machine).toBe((w.facts!['machines'] as { local: string }).local)
    const lane = `handoff:${w.ids!['reviewer-session']}`
    const raw = readerOf(w)
    // The captured rows name no run of their own: their lane does, through the registration row the file carried.
    const captured = raw.prepare("SELECT node_id, metadata_json AS m FROM nodes WHERE content IS NOT NULL AND session_key = ? AND json_extract(metadata_json, '$.run') IS NULL").all(lane) as Array<{ node_id: string; m: string }>
    const calls = captured.filter((r) => rawContentOf(w, r.node_id).includes('okapi-reviewer-'))
    expect(calls).toHaveLength(30)
    const reg = raw.prepare(`SELECT g.node_id, json_extract(g.metadata_json, '$._handoff_claims._leg_registration.run') AS run,
        json_extract(g.metadata_json, '$._handoff_claims._leg_registration.role') AS role,
        json_extract(g.metadata_json, '$._handoff_claims._leg_registration.session_id') AS session
      FROM nodes g WHERE g.session_key = ? AND json_extract(g.metadata_json, '$.kind') = 'leg-registration'`).all(lane) as Array<Record<string, unknown>>
    expect(reg.map((r) => [r['run'], r['role'], r['session']])).toEqual([['r1', 'reviewer', w.ids!['reviewer-session']]])
    // An imported registration, not one of this store's.
    expect(raw.prepare('SELECT 1 FROM session_registry WHERE session_id = ?').all(w.ids!['reviewer-session']!)).toHaveLength(0)
    // The reader's run read reaches each call through that registration: the leg it names is the reviewer's.
    const byId = new Map((w.sqlRows as Array<{ node_id: string; leg_session: string | null; leg_role: string | null }>).map((r) => [r.node_id, r]))
    for (const c of calls) expect([byId.get(c.node_id)?.leg_session, byId.get(c.node_id)?.leg_role]).toEqual([w.ids!['reviewer-session'], 'reviewer'])
    // No row of the laptop renamed: every row it held is as it was, column for column.
    const before = w.facts!['laptop-before'] as Array<Record<string, unknown>>
    expect(before.length).toBeGreaterThan(0)
    const after = new Map((raw.prepare('SELECT * FROM nodes').all() as Array<Record<string, unknown>>).map((r) => [r['node_id'], r]))
    for (const r of before) expect(after.get(r['node_id']), String(r['node_id'])).toEqual(r)
    // The laptop's builder's rows among the run's, still in its own lane, read by the same plain SQL.
    const builder = w.legs!['builder']!.sessionId
    expect((w.sqlRows as Array<{ node_id: string }>).filter((r) => rawRowOf(w, r.node_id)['session_key'] === builder).length).toBeGreaterThanOrEqual(3)
  })

  // ── D300: the whole form through the tools, behind the acknowledgement ──

  define(/^an agent asks the export tool for the run "([^"]+)" in the whole form without acknowledging the secrets warning$/, async (w, run) => {
    const reply = await callTool(await toolClient(w), 'treecontext_export', { run, form: 'whole', path: 'handoffs/r1-whole.json' })
    w.facts!['whole-reply'] = reply
    w.facts!['whole-file-after-ask'] = existsSync(join(w.proj!, 'handoffs', 'r1-whole.json'))
  })

  define(/^the reply is the warning that captured tool output can hold secrets, tokens and keys, and no file is written$/, (w) => {
    const reply = w.facts!['whole-reply'] as ToolReply
    expect(reply.isError, reply.text).toBe(false)
    expect(Object.keys(reply.json)[0]).toBe('warning')
    expect(String(reply.json['warning'])).toMatch(/^Captured tool output can hold secrets, tokens and keys/)
    expect(reply.json['written']).toBe(false)
    expect(reply.json['file']).toBeUndefined()
    expect(w.facts!['whole-file-after-ask'], 'the file was written before the acknowledgement').toBe(false)
    expect(existsSync(join(w.proj!, 'handoffs', 'r1-whole.json'))).toBe(false)
  })

  define(/^when the agent asks again acknowledging it, the file is written and holds the (\d+) tool calls under each leg's lane$/, async (w, calls) => {
    const reply = await callTool(await toolClient(w), 'treecontext_export', { run: 'r1', form: 'whole', path: 'handoffs/r1-whole.json', secrets_acknowledged: true })
    expect(reply.isError, reply.text).toBe(false)
    expect([reply.json['file'], reply.json['form']]).toEqual(['handoffs/r1-whole.json', 'whole'])
    wholeFileHoldsCalls(w, calls!)
  })

  // ── D318, D368: the reply names the legs whose first moment is the door's line ──

  define(/^a run "([^"]+)" with a builder leg through the ticket door, whose first-moment row holds the spawner's prompt, and a reviewer leg through the hooks door, whose first-moment row is the door's own line$/, async (w, run) => {
    await openRunWorld(w)
    const prompt = `build the login form for ${run}, from the pasted spec`
    w.facts!['builder-prompt'] = prompt
    await runWorker(w, {
      spawner: 'library', prompt,
      ticket: { run: run!, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: 'state of login-form: built', print: 'builder done' } },
    }, 'builder')
    const ref = await hooksLeg(w, 'reviewer', 'reviewer', { run: run!, key: 'login-form', checkpointer: 'reviewer' })
    const firsts = rawAll<{ node_id: string; session_key: string; m: string }>(w,
      "SELECT node_id, session_key, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment' AND json_extract(metadata_json, '$.run') = ? ORDER BY rowid", run)
    expect(firsts).toHaveLength(2)
    const builderRow = firsts.find((r) => r.session_key === w.legs!['builder']!.sessionId)!
    const reviewerRow = firsts.find((r) => (JSON.parse(r.m) as Record<string, unknown>)['_writer_agent_id'] === ref.agentId)!
    expect(rawContentOf(w, builderRow.node_id)).toBe(prompt)
    // The hooks door never saw the reviewer's prompt: its row is its own line, saying so.
    const line = rawContentOf(w, reviewerRow.node_id)
    expect(line).toMatch(/not seen by this door\.$/)
    // The spawner's words are in the builder's row and in no other first moment.
    expect(firsts.filter((r) => rawContentOf(w, r.node_id).includes('pasted spec')).map((r) => r.node_id)).toEqual([builderRow.node_id])
    w.ids!['reviewer-first'] = reviewerRow.node_id
  })

  define(/^after the line about first moments the reply carries one line naming the reviewer leg as the one whose prompt rode on the Agent tool and was not seen by the door$/, (w) => {
    const reply = w.facts!['export-reply'] as ToolReply
    const keys = Object.keys(reply.json)
    expect(reply.json['first_moments']).toBe("First moments carry the spawners' prompts as written and may hold what was pasted into them.")
    // The next line of the reply, right after the first-moments line.
    expect(keys.indexOf('door_lines')).toBe(keys.indexOf('first_moments') + 1)
    const line = reply.json['door_lines']
    expect(typeof line).toBe('string')
    expect(String(line).split('\n')).toHaveLength(1)
    expect(String(line)).toContain(`reviewer (agent ${w.legs!['reviewer']!.agentId})`)
    // It quotes what the reviewer's own row says of the prompt.
    const said = rawContentOf(w, w.ids!['reviewer-first']!)
    const sentence = said.slice(said.lastIndexOf('. ') + 2)
    expect(sentence).toBe('Its prompt rode on the Agent tool and is not seen by this door.')
    expect(String(line)).toContain(`"${sentence}"`)
  })

  define(/^that line names the reviewer leg alone$/, (w) => {
    const line = String((w.facts!['export-reply'] as ToolReply).json['door_lines'])
    // The legs the line names, among the run's two: the reviewer's agent, and nothing of the builder's.
    const legs: Array<[string, string[]]> = [
      ['builder', ['builder', w.legs!['builder']!.sessionId]],
      ['reviewer', ['reviewer', w.legs!['reviewer']!.agentId]],
    ]
    expect(legs.filter(([, marks]) => marks.some((m) => line.includes(m))).map(([name]) => name)).toEqual(['reviewer'])
    // And the list the line gives is exactly that one leg, one of two first moments.
    expect(/^1 of the 2 first moments is the door's own line, not a prompt \((.*)\): /.exec(line)?.[1]).toBe(`reviewer (agent ${w.legs!['reviewer']!.agentId})`)
  })

  // ── D318: the file's own head says what its first moments are ──

  define(/^a run "([^"]+)" whose builder's first-moment row holds the spawner's prompt$/, async (w, run) => {
    await openRunWorld(w, { sessionStart: false })
    const prompt = `build the login form for ${run}; the spec pasted below is the point`
    await runWorker(w, {
      spawner: 'wrapper', prompt,
      ticket: { run: run!, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
      plan: { first: { checkpoint: 'state of login-form: built from the spec', print: 'builder done' } },
    }, 'builder')
    const row = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment' AND json_extract(metadata_json, '$.run') = ?", run)
    expect(row).toBeTruthy()
    expect(rawContentOf(w, row!.node_id)).toBe(prompt)
    w.ids!['first-moment'] = row!.node_id
  })

  define(/^the file's head says in one line that first moments carry the spawners' prompts as written and may hold what was pasted into them$/, (w) => {
    const file = w.facts!['export-file'] as RunFile
    const said = file.head['first_moments']
    expect(said).toBe("First moments carry the spawners' prompts as written and may hold what was pasted into them.")
    expect(String(said).split('\n')).toHaveLength(1)
    // Said of this file's own first moments: the builder's prompt is among its rows.
    expect(file.nodes.filter((n) => n.metadata?.['kind'] === 'first-moment').map((n) => n.nodeId)).toEqual([w.ids!['first-moment']])
  })

  define(/^a reader of the file alone, with no reply in hand, reads it there$/, (w) => {
    // A reader with the file and nothing else: its text off the disk, the line in its head, before any entry.
    const text = readFileSync(join(w.proj!, 'handoffs', 'r1.json'), 'utf8')
    const line = "First moments carry the spawners' prompts as written and may hold what was pasted into them."
    const at = text.indexOf(JSON.stringify(line))
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(text.indexOf('"nodes"'))
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed).indexOf('first_moments')).toBeLessThan(Object.keys(parsed).indexOf('nodes'))
  })
}
