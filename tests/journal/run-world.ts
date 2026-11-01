/**
 * What the three beta.3 waves share — journal-legs, journal-workers and
 * journal-runs (D279–D352): a real store in a capture sandbox, the real
 * Claude Code hooks a hooks-door leg runs under, one MCP client per
 * session, and the library door a harness spawns workers through.
 *
 * Every Given here writes through the production writer of what it
 * establishes: checkpoints and briefs through the library's own writers
 * (writeCheckpoint, writeBrief). Where a binding stands in for a platform,
 * a model or a door's caller (a hooks-door leg through the real
 * SubagentStart hook, a worker through the library door or a stand-in
 * process through the real ticket door), it does so through the stand-in
 * harness, ./standins.ts, and nowhere else. Every Then reads the SQLite file through a
 * separate read-only handle, or the production surface (a hook's stdout,
 * a tool's reply, the harness's lookup).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { DatabaseSync } from 'node:sqlite'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { hostProbe } from '../../src/persistence/process-probe.js'
import { type LegRef } from '../../src/persistence/leg-registry.js'
import type { KeyLookup } from '../../src/key-lookup.js'
import { mcpOver, parseTool, rawAll } from './world.js'
import { TS_ROOT } from './proc.js'
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
 *  the PARENT's session id with the subagent's agent id and type. `env`
 *  adds to the sandbox (TREECONTEXT_TEST_NOW: the hook's own clock, for a
 *  leg registered at a moment in the past). */
export function subagentStartHook(w: RunWorld, agentId: string, agentType: string, env: Record<string, string> = {}): string {
  return runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: agentType }, env).stdout
}

/** The context a SubagentStart hook's stdout injects into the subagent,
 *  or null when it emitted none. */
export function startContext(stdout: string): string | null {
  const t = stdout.trim()
  if (t === '') return null
  const out = JSON.parse(t) as Record<string, unknown>
  const hso = out['hookSpecificOutput'] as Record<string, unknown> | undefined
  expect(hso?.['hookEventName'], `not a SubagentStart output: ${t.slice(0, 200)}`).toBe('SubagentStart')
  return typeof hso?.['additionalContext'] === 'string' ? hso['additionalContext'] : null
}

/** The subagent finishes: the real SubagentStop hook with its report. A
 *  stop after a block carries `stop_hook_active` as the platform sends it. */
export function subagentStopHook(w: RunWorld, agentId: string, agentType: string, report: string, opts: { stopActive?: boolean } = {}): string {
  return runHook(w, 'subagent-stop', {
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, stop_hook_active: opts.stopActive ?? false,
    agent_transcript_path: join(w.proj!, `agent-${agentId}.jsonl`), last_assistant_message: report,
  }).stdout
}

/** The Agent tool returns to the main agent: the real PostToolUse hook
 *  with the reference platform's Agent payload, the subagent's own final
 *  text in `tool_response.content` and its id in `tool_response.agentId`
 *  (Claude Code's hooks reference). Returns the hook's stdout. */
export function agentToolReturns(w: RunWorld, agentId: string, role: string, prompt: string, finalMessage: string): string {
  return runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'Agent', tool_input: { description: `${role} leg`, prompt, subagent_type: role },
    tool_response: { agentId, content: [{ type: 'text', text: finalMessage }] },
  }).stdout
}

/** A BACKGROUND Agent call's PostToolUse: it fires at the launch, its
 *  result `{ isAsync: true, status: "async_launched", agentId }` (Claude
 *  Code, as this developer's transcripts hold it), the subagent not yet
 *  finished. Returns the hook's stdout. */
export function agentToolLaunchesInBackground(w: RunWorld, agentId: string, role: string, prompt: string): string {
  return runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'Agent', tool_input: { description: `${role} leg`, prompt, subagent_type: role, run_in_background: true },
    tool_response: { isAsync: true, status: 'async_launched', agentId },
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

/** A brief for a role under a run's key, by the harness, through the
 *  library's brief writer (D281, D327). */
export async function briefFor(w: RunWorld, role: string, run: string, key: string, opts: {
  checkpointer?: string | null; checkpointedBy?: string | null; content?: string; supersedes?: string[]; at?: number
} = {}): Promise<string> {
  const r = await w.store!.writeBrief(opts.content ?? `${role}: carry the ${key} of ${run} forward from the checkpoint in effect`, {
    run, key, role, by: 'harness',
    ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
    ...(opts.checkpointedBy ? { checkpointedBy: opts.checkpointedBy } : {}),
    ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    ...(opts.at !== undefined ? { at: opts.at } : {}),
  })
  return r.nodeId
}

/** This test process as a live worker's process: a real pid with the
 *  start moment this host's OS reports for it. */
export function liveProcess(): { pid: number; start: number | null; host: string; token: string | null } {
  return { pid: process.pid, start: hostProbe.startMoment(process.pid), host: hostname(), token: hostProbe.startToken?.(process.pid) ?? null }
}

/** A real lock another process holds on the store: the whole store
 *  (store-locker.cjs, which needs every other connection let go first),
 *  or its writes alone (store-write-locker.cjs, readers left reading). */
export async function lockStore(w: RunWorld, what: 'whole' | 'writes' = 'whole'): Promise<ChildProcess> {
  const helper = what === 'whole' ? 'store-locker.cjs' : 'store-write-locker.cjs'
  const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', helper), w.dbPath!], { stdio: ['ignore', 'pipe', 'inherit'] })
  w.defer(() => { try { locker.kill('SIGKILL') } catch { /* gone */ } })
  let seen = ''
  await new Promise<void>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error(`the locker never locked: ${seen}`)), 20_000)
    locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
    locker.once('exit', (code) => { clearTimeout(bail); reject(new Error(`the locker exited ${code}: ${seen}`)) })
  })
  return locker
}

export async function waitForFile(path: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    await new Promise((r) => setTimeout(r, 25))
  }
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
