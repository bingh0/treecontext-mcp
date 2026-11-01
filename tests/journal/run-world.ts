/**
 * What the three beta.3 waves share — journal-legs, journal-workers and
 * journal-runs (D279–D352): a real store in a capture sandbox, the real
 * Claude Code hooks a hooks-door leg runs under, one MCP client per
 * session, and the library door a harness spawns workers through.
 *
 * Every Given here writes through the production writer of what it
 * establishes: checkpoints and briefs through the library's own writers
 * (writeCheckpoint, writeBrief), a hooks-door leg through the real
 * SubagentStart hook and then the registry call the hooks door makes
 * (registerLeg), a worker through registerWorker, the library door a
 * spawner registers through. Every Then reads the SQLite file through a
 * separate read-only handle, or the production surface (a hook's stdout,
 * a tool's reply, the harness's lookup).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { DatabaseSync } from 'node:sqlite'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { hostProbe } from '../../src/persistence/process-probe.js'
import { WORKER_AGENT_ID, type LegRef } from '../../src/persistence/leg-registry.js'
import type { KeyLookup } from '../../src/runs.js'
import { mcpOver, parseTool, rawAll } from './world.js'
import { runHook } from './capture-harness.js'
import { type ReorientationWorld, openWorld } from './steps/journal-reorientation.steps.js'

/** The world the three beta.3 waves share. */
export interface RunWorld extends ReorientationWorld {
  /** Legs by the scenario's name for them. */
  legs?: Record<string, LegRef>
  /** Checkpoint row ids by label: `<run>:<key>:<number>`. */
  cps?: Record<string, string>
  /** Any other row ids a scenario carries, by label. */
  ids?: Record<string, string>
  /** Moments a scenario carries from a Given or When to a Then. */
  moments?: Record<string, number>
  /** The harness's lookups, by run. */
  lookups?: Record<string, KeyLookup>
  /** What each leg's SubagentStop hook printed. */
  stops?: Record<string, string>
  /** Rows exactly as SQLite held them before an act, by label. */
  before?: Record<string, Record<string, unknown>>
  /** The rows a reader's plain SQL returned. */
  sqlRows?: Array<Record<string, unknown>>
  /** Processes a scenario started, killed at its end. */
  children?: ChildProcess[]
  /** Free-form facts a scenario carries between steps. */
  facts?: Record<string, unknown>
}

/** A step definer typed for these waves' steps, whose captures are all
 *  strings (none reads a data table; an optional group that did not match
 *  arrives undefined). The callback is registered as written, so the
 *  runner's args-consumption guard reads its own parameter list. */
export function stringSteps<W extends RunWorld>(reg: Registry<W>): (re: RegExp, fn: (w: W, ...caps: string[]) => void | Promise<void>) => void {
  return (re, fn) => { reg.define(re, fn as unknown as Parameters<Registry<W>['define']>[1]) }
}

export const cpLabel = (run: string, key: string, n: number): string => `${run}:${key}:${n}`

/** A real store in a capture sandbox, the session started by the real
 *  SessionStart hook (which registers its self, D190). */
export async function openRunWorld(w: RunWorld, opts: { sessionStart?: boolean } = {}): Promise<void> {
  if (w.store) return
  await openWorld(w)
  w.legs = {}
  w.cps = {}
  w.ids = {}
  w.moments = {}
  w.lookups = {}
  w.stops = {}
  w.before = {}
  w.facts = {}
  w.children = []
  if (opts.sessionStart !== false) sessionStartHook(w)
}

export function sessionStartHook(w: RunWorld, source = 'startup'): string {
  return runHook(w, 'session-start', { hook_event_name: 'SessionStart', source }).stdout
}

/** The orchestrator spawns a subagent: the real SubagentStart hook under
 *  the PARENT's session id with the subagent's agent id and type. */
export function subagentStartHook(w: RunWorld, agentId: string, agentType: string): string {
  return runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: agentType }).stdout
}

/** The subagent finishes: the real SubagentStop hook with its report. */
export function subagentStopHook(w: RunWorld, agentId: string, agentType: string, report: string): string {
  return runHook(w, 'subagent-stop', {
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, stop_hook_active: false,
    agent_transcript_path: join(w.proj!, `agent-${agentId}.jsonl`), last_assistant_message: report,
  }).stdout
}

/** Whether a hook's stdout carries Claude Code's block decision. */
export function blocks(stdout: string): boolean {
  const t = stdout.trim()
  if (t === '') return false
  const out = JSON.parse(t) as Record<string, unknown>
  return out['decision'] === 'block'
}

/** One MCP client for the session: orchestrator and subagents alike. */
export async function sessionClient(w: RunWorld): Promise<void> {
  if (w.client && w.clientSession === w.sessionId) return
  await mcpOver(w, { ccSessionId: w.sessionId! })
  w.clientSession = w.sessionId!
}

/** A treecontext_insert through the tools AND its PostToolUse echo, as
 *  Claude Code fires it: the caller's agent fields on a subagent's. */
export async function insertEchoed(
  w: RunWorld, who: { agentId: string; agentType: string } | null,
  text: string, metadata: Record<string, unknown>, supersedes?: string[],
): Promise<Record<string, unknown>> {
  await sessionClient(w)
  const input = { content: text, metadata, ...(supersedes ? { supersedes } : {}) }
  const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
  runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'mcp__treecontext__treecontext_insert', tool_input: input,
    tool_response: (res as { content: unknown }).content,
    ...(who ? { agent_id: who.agentId, agent_type: who.agentType } : {}),
  })
  return parseTool(res)
}

/** Checkpoints 1..n under a run's key, each superseding the one before,
 *  written by `role` through the library (a declared writer). */
export async function seedCheckpoints(w: RunWorld, run: string, key: string, n: number, role = 'builder', lastRole = role): Promise<string[]> {
  const ids: string[] = []
  const base = Date.now() / 1000 - 3600
  for (let i = 1; i <= n; i++) {
    const r = await w.store!.writeCheckpoint(`state of ${key} after leg ${i}: step ${i} done; next: step ${i + 1}`, {
      run, key, declared: { role: i === n ? lastRole : role }, at: base + i * 60,
      ...(ids.length > 0 ? { supersedes: [ids.at(-1)!] } : {}),
    })
    expect(r.checkpoint?.number, 'the store numbers checkpoints in order').toBe(i)
    ids.push(r.nodeId)
    w.cps![cpLabel(run, key, i)] = r.nodeId
  }
  return ids
}

/** A hooks-door leg: the real SubagentStart hook registers the subagent,
 *  then the registry call the hooks door makes gives it its leg facts. */
export async function hooksLeg(w: RunWorld, name: string, role: string, facts: {
  run?: string | null; key?: string | null; keySrc?: 'declared' | 'inferred' | 'ambiguous' | 'own' | null
  keyCandidates?: Array<{ run: string | null; key: string; briefId: string | null }>
  checkpointer?: string | null; startCheckpoints?: string[]
}): Promise<LegRef> {
  const agentId = `a${name}${Math.random().toString(16).slice(2, 10)}`
  subagentStartHook(w, agentId, role)
  await w.store!.registerLeg({ sessionId: w.sessionId!, agentId, role, ...facts })
  const ref = { sessionId: w.sessionId!, agentId }
  w.legs![name] = ref
  return ref
}

/** This test process as a live worker's process: a real pid with the
 *  start moment this host's OS reports for it. */
export function liveProcess(): { pid: number; start: number | null; host: string; token: string | null } {
  return { pid: process.pid, start: hostProbe.startMoment(process.pid), host: hostname(), token: hostProbe.startToken?.(process.pid) ?? null }
}

/** A worker registered through the library door the spawner calls. */
export async function workerLeg(w: RunWorld, name: string, opts: {
  role: string; run: string | null; key: string | null; parent?: string
  checkpointer?: string | null; startCheckpoints?: string[]; at?: number
  process?: { pid: number | null; start: number | null; host: string; token?: string | null }
}): Promise<LegRef> {
  const leg = await w.store!.registerWorker({
    door: 'library',
    ticket: {
      parent: { id: opts.parent ?? w.sessionId ?? 'p1' }, run: opts.run, key: opts.key, role: opts.role,
      checkpointer: opts.checkpointer ?? opts.role, mintedAt: (opts.at ?? Date.now() / 1000) - 1,
    },
    process: opts.process ?? liveProcess(),
    ...(opts.startCheckpoints ? { startCheckpoints: opts.startCheckpoints } : {}),
    ...(opts.at !== undefined ? { at: opts.at } : {}),
  })
  const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  w.legs![name] = ref
  return ref
}

/** A process that waits to be killed, for the phantom pass to find. */
export function sleeper(w: RunWorld): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  w.children!.push(child)
  w.defer(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
  return child
}

export async function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await gone
}

/** A local wall-clock moment, `daysAgo` days back. */
export function localMoment(hhmmss: string, daysAgo = 1): number {
  const [h, m, s] = hhmmss.split(':').map(Number)
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h!, m!, s ?? 0, 0)
  return d.getTime() / 1000
}

// ── Reading the file (the verification rule) ───────────────────────────

export function rawOne<T = Record<string, unknown>>(w: RunWorld, sql: string, ...params: unknown[]): T | undefined {
  return rawAll<T>(w, sql, ...params)[0]
}

export function rawMetaOf(w: RunWorld, id: string): Record<string, unknown> {
  const r = rawOne<{ m: string | null }>(w, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)
  expect(r, `no row ${id} in the store file`).toBeTruthy()
  return JSON.parse(r!.m ?? '{}') as Record<string, unknown>
}

export function rawContentOf(w: RunWorld, id: string): string {
  const r = rawOne<{ c: Buffer | string | null }>(w, 'SELECT content AS c FROM nodes WHERE node_id = ?', id)
  expect(r, `no row ${id} in the store file`).toBeTruthy()
  return decodeContent(r!.c)
}

/** Every column of a row, as SQLite holds it. */
export function rawRowOf(w: RunWorld, id: string): Record<string, unknown> {
  const r = rawOne<Record<string, unknown>>(w, 'SELECT * FROM nodes WHERE node_id = ?', id)
  expect(r, `no row ${id} in the store file`).toBeTruthy()
  return r!
}

export function rawRegistration(w: RunWorld, ref: LegRef): Record<string, unknown> {
  const r = rawOne<Record<string, unknown>>(w, 'SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?', ref.sessionId, ref.agentId)
  expect(r, `no registration ${ref.sessionId}/${ref.agentId} in the store file`).toBeTruthy()
  return r!
}

/** The checkpoint rows under a run's key, by the number the store gave
 *  each, straight from the file. */
export function rawCheckpoints(w: RunWorld, run: string, key: string): Array<{ node_id: string; n: number; m: Record<string, unknown> }> {
  return rawAll<{ node_id: string; m: string }>(w,
    `SELECT node_id, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'
        AND json_extract(metadata_json, '$.run') = ? AND json_extract(metadata_json, '$.key') = ? ORDER BY rowid`, run, key)
    .map((r) => {
      const m = JSON.parse(r.m) as Record<string, unknown>
      return { node_id: r.node_id, n: Number(m['_checkpoint_number']), m }
    })
}

/** A read-only handle for a reader's own SQL. */
export function readerOf(w: RunWorld): DatabaseSync {
  const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
  w.defer(() => { try { raw.close() } catch { /* closed */ } })
  return raw
}
