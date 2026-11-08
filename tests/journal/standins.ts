/**
 * The stand-in harness: every place a charter binding stands where a
 * platform, a model or a door's caller would stand, in one module.
 *
 * A beta.3 binding goes through the real door its scenario names (the
 * hooks, the ticket door, the tools, the CLI, the library). What it cannot
 * reach is what sits on the far side of that door: Claude Code itself, the
 * model inside a headless worker, the spawner that holds a ticket, the
 * client a version check reads. Those are stood in for here, and only
 * here, so a reader of a steps file sees by the name it calls which part of
 * the world is real and which is a stand-in.
 *
 * ── What each stand-in stands in for ──────────────────────────────────
 *
 *  | Stand-in                               | Stands in for                                              |
 *  | -------------------------------------- | ---------------------------------------------------------- |
 *  | `hooksLeg`, `hooksSubagent`            | Claude Code starting a subagent: it fires the real          |
 *  |                                        | SubagentStart hook with the platform's payload (the brief   |
 *  |                                        | in effect is the harness's, through `writeBrief`)           |
 *  | `runWorker` + standin-worker           | a hook-less headless worker (`codex exec`, `agy -p`): the   |
 *  |   (tests/helpers/standin-worker.ts)    | process the real ticket door (`spawnWorker`, `treecontext   |
 *  |                                        | run`) launches, the model inside it out of reach            |
 *  | `runWorker` + standin-claude-p         | Claude Code's headless client (`claude -p`): it fires the   |
 *  |   (tests/helpers/standin-claude-p.ts)  | real hooks the install wires, with the payloads Claude Code |
 *  |                                        | sends, in the order it sends them                           |
 *  | a plan's `viaTools` / `toolNotes` /    | a worker's CLI writing and reading through its own tools: a |
 *  |   `reads` / `handshakes`               | real `treecontext serve` the stand-in starts with its env   |
 *  |                                        | (`handshakes`: the client reading `initialize`'s            |
 *  |                                        | instructions, D382)                                         |
 *  | `workerLeg`, `registerThroughLibrary`  | a spawner registering a worker through the library door     |
 *  |                                        | (`FlatStore.registerWorker`), no worker process running     |
 *  | `retiredWithoutReturn`, `cutByTimeout`,| a leg already ended, for a Given of history: retired with   |
 *  |   `exitedWithSummary`                  | no summary row (a state no door's exit produces), cut as a  |
 *  |                                        | timeout cuts, or exited with its summary row; journal-      |
 *  |                                        | workers binds the real ends through the real door           |
 *  | `harnessRetiresLeg`                    | the harness retiring a leg through the library door, where  |
 *  |                                        | the scenario says the harness does it                       |
 *  | `writeFakeClaude`                      | the `claude` on PATH whose `--version` install and doctor   |
 *  |                                        | read (journal-install, D290, D304, D338)                    |
 *  | `writeFakeCodex`                       | the `codex` on PATH whose `--version` install and doctor    |
 *  |                                        | read and whose `sandbox -- true` doctor runs on Linux       |
 *  |                                        | (journal-clients, journal-install, D381, D387): it answers  |
 *  |                                        | by its plan, a version and the exit code and stderr of      |
 *  |                                        | `sandbox -- true` exactly; it runs nothing in a sandbox,    |
 *  |                                        | reads no configuration, calls no model and answers no other |
 *  |                                        | subcommand or sandbox command (exit 2, saying so)           |
 *  | `writeFakeGemini`                      | the `gemini` on PATH whose presence install reads as Gemini |
 *  |                                        | CLI installed (D383): install and doctor never run it; run, |
 *  |                                        | it answers nothing and exits 127, saying it is a stand-in   |
 *  | `startEntryAsClient`                   | a client (Claude Code, Codex CLI, Antigravity CLI, Cursor)  |
 *  |                                        | starting the MCP server its treecontext entry names: the    |
 *  |                                        | command and args the client read, spawned as written, so    |
 *  |                                        | the real launcher runs this build compiled (journal-        |
 *  |                                        | install, D386, D383)                                        |
 *  | `preCompact`                           | Claude Code compacting a session's context: it fires the    |
 *  |                                        | real PreCompact hook, then SessionStart with source         |
 *  |                                        | `compact` under the same session, in that order (D375)      |
 *
 * ── What a stand-in may do ────────────────────────────────────────────
 *
 * Only what its platform could: read its ticket, its environment and its
 * stdin; write as the leg its door made it, by the means that platform
 * has (a hook-less headless worker: the library or its own tools, a
 * `treecontext serve` it starts; a `claude -p` child: its tools only, each
 * call echoed by PostToolUse, as Claude Code runs them); fire the hooks
 * with the payloads Claude Code sends, in the order it sends them
 * (SessionStart, UserPromptSubmit, PostToolUse per tool call, Stop, and
 * Stop again with `stop_hook_active` after a block; at a compaction,
 * PreCompact and then SessionStart with source `compact`); print its last
 * output and exit as told (a code, or hanging until a signal).
 *
 * ── What a stand-in must never do ─────────────────────────────────────
 *
 * Reach into a door's internals (the registry functions, `startWorker`,
 * the send-back count); register itself (a worker with no wrapper claims
 * its ticket through `claimTicket`, the production surface such a worker
 * calls); write the rows a door writes (a first moment, a send-back row, a
 * summary row, a run's open at a registration). A Given that needs a leg
 * already ended uses the named library-door helpers above, so the stand-in
 * is visible at the call. The helpers carry names and confinement, not
 * rules: each is a thin call of the library door it names, and nothing
 * here checks that a Given's history is one a door could have made. A
 * compaction's stand-in writes no snapshot and claims none: the PreCompact
 * hook writes it, a fresh start's SessionStart claims it.
 *
 * The guard in tests/feature-guards.test.ts ("no binding stands in for a
 * door outside the stand-in harness") fails on any mention, outside
 * comments and strings, of a name in `GUARDED_DOOR_CALLS` (a call, a
 * bracket access by its name, `.call`/`.bind`, an import or its alias)
 * in a steps file, a journal harness module or a file under tests/helpers
 * other than this one and the lines its allowlist names with a reason;
 * and on a plain `insert(` whose arguments name a door's row kind
 * (`DOOR_ROW_KINDS`), outside its allowlist.
 *
 * ── The plan vocabulary ───────────────────────────────────────────────
 *
 * standin-worker (STANDIN_PLAN, `WorkerPlan`): `{ first: Step, rerun?:
 * Step, claim?: { prompt?: string } }`. A Step: `notes` (that many notes),
 * `label` (their prefix), `texts` (rows as given), `checkpoint` /
 * `checkpoints` (under its ticket's key, each superseding the one before
 * by the store's own rule), `invalidRow` (the one row an invalid ticket
 * asks for), `viaTools` (notes and texts through a real `treecontext
 * serve` instead of the library), `reads` (after its writes, the reads
 * a worker's CLI makes through those same tools: `query` a
 * treecontext_query call with these arguments, `status` a
 * treecontext_status call; each reply recorded whole in its log line as
 * `reads`; reads imply the real serve), `handshakes` (handshake reads,
 * D382: before any write, each a real `treecontext serve` started over
 * stdio with its own environment, `initialize`'s instructions recorded
 * whole in its log line as `handshakes`, in order; an entry's `ticket`
 * replaces TREECONTEXT_TICKET for that one server and its `lane` replaces
 * TREECONTEXT_WORKER_SESSION, null leaving the variable out, as a nested
 * worker's or a client's server that inherited the lane with a ticket of
 * its own, or with no worker variables, would be started; it calls no
 * tool), `at` (the rows' moment),
 * `waitFor` (a file it waits for after writing `<file>.ready`), `print`
 * (its last output), `exit` (a code, or `'hang'`). The run that opens on
 * the door's send-back message follows `rerun`.
 *
 * standin-claude-p (STANDIN_CLAUDE_PLAN, `ClaudePPlan`): `tools` (Bash
 * calls, each a PostToolUse), `toolText` (their output, `{i}` the call's
 * number, `{label}` first or after), `toolNotes` (treecontext_insert calls
 * through a real serve, each echoed by PostToolUse), `checkpoint` /
 * `checkpoints`, `afterSendBack` (`tools`, `checkpoint`, `checkpoints`:
 * what it does when its Stop is blocked, before stopping again),
 * `invalidRow`, `waitBeforeStop` / `waitAfterStop`, `final` (its last
 * message), `exit`.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_AGENT_ID, type LegRef, type LegRegistration } from '../../src/persistence/leg-registry.js'
import { mintTicket, TICKET_ENV, type TicketFields } from '../../src/ticket.js'
import { spawnWorker, DOOR_LINE_PREFIX, type WorkerRunResult } from '../../src/ticket-door.js'
import type { FlatStore } from '../../src/flat-store.js'
import { sandboxedSpawnEnv, nodeTsArgs, CLI_TS } from '../helpers/cli-spawn.js'
import { placeBuiltPackage } from '../helpers/built-package.js'
import { TS_ROOT } from './proc.js'
import { type RunWorld, briefFor, subagentStartHook, liveProcess } from './run-world.js'
import { type CaptureWorld, runHook, hookJson } from './capture-harness.js'

/** The registry and door acts a binding may make only through this
 *  module: each is a door's own act (a registration, a retirement, a
 *  send-back, a key settled or unsettled, a cap refusal, a client session
 *  linked, a run opened by a leg, a worker started, claimed or re-run, a
 *  door row composed or written, the echo heal). Taken from the writers
 *  src/persistence/leg-registry.ts exports, FlatStore's door methods,
 *  src/ticket-door.ts, src/first-moment.ts's row metadata and
 *  src/persistence/writer-heal.ts. */
export const GUARDED_DOOR_CALLS = [
  // src/persistence/leg-registry.ts
  'registerSubagentLeg', 'registerWorkerLeg', 'recordWorkerProcess', 'retireLeg', 'recordSendBack', 'settleLegKey',
  'unsettleLegKey', 'setCapRefusals', 'recordCapRefusal', 'recordOpenedRun', 'linkClientSession', 'retirePhantoms',
  // FlatStore's door methods (src/flat-store.ts)
  'registerLeg', 'registerWorker', 'recordWorkerRerun', 'startWorker', 'recordWorkerSendBack', 'startHooksLeg',
  'retireHooksLeg', 'openRunOfLeg', 'retireWorker', 'writeRefusedTicket',
  // src/ticket-door.ts: a worker's own claim of its ticket
  'claimTicket',
  // src/first-moment.ts: the metadata of the rows a door writes
  'firstMomentMetadata', 'sendBackMetadata',
  // src/persistence/writer-heal.ts: the echo heal the drain runs
  'healWriterFromEcho',
] as const

/** The row kinds only a door writes: a plain insert naming one stands in
 *  for the door. */
export const DOOR_ROW_KINDS = ['first-moment', 'send-back', 'subagent-summary'] as const

// ── Claude Code starting a subagent (the hooks door) ───────────────────

/**
 * A hooks-door leg, as the hooks door makes one (D284, D320, D326): the
 * role's brief in effect names the run and the key (written here by the
 * harness unless one is in effect already), and the real SubagentStart
 * hook registers the subagent and infers its leg facts from that brief,
 * its start the checkpoint(s) then in effect. What the hook injected is
 * kept as `start:<name>`.
 */
export async function hooksLeg(w: RunWorld, name: string, role: string, facts: {
  run: string; key: string; checkpointer?: string | null; checkpointedBy?: string | null
}, env: Record<string, string> = {}): Promise<LegRef> {
  const inEffect = w.store!.briefsInEffect(role).filter((b) => b.run === facts.run && b.key === facts.key)
  if (inEffect.length === 0) await briefFor(w, role, facts.run, facts.key, { checkpointer: facts.checkpointer ?? null, checkpointedBy: facts.checkpointedBy ?? null })
  return hooksSubagent(w, name, role, env)
}

/** A subagent of the role started through the real SubagentStart hook and
 *  nothing else: whatever the hooks door makes of it from the store. */
export function hooksSubagent(w: RunWorld, name: string, role: string, env: Record<string, string> = {}): LegRef {
  const agentId = `a${name}${Math.random().toString(16).slice(2, 10)}`
  w.facts ??= {}
  w.legs ??= {}
  w.facts[`start:${name}`] = subagentStartHook(w, agentId, role, env)
  const ref = { sessionId: w.sessionId!, agentId }
  w.legs![name] = ref
  return ref
}

// ── Claude Code compacting a session (the snapshot's lane, D375) ───────

/**
 * Claude Code compacting the context of the world's session, running in
 * `cwd`: the real PreCompact hook with the platform's payload (the hook
 * writes the session's recovery snapshot), then the real SessionStart hook
 * with source `compact` under the same session id, as Claude Code resumes
 * the session on the compacted context. Returns what that SessionStart
 * handed the agent. Nothing here writes a snapshot or claims one: the
 * hooks do, and a later fresh start's own SessionStart claims.
 */
export function preCompact(w: CaptureWorld, cwd: string, trigger: 'auto' | 'manual' = 'auto'): string {
  const transcript = join(cwd, 'transcript.jsonl')
  runHook(w, 'pre-compact', { hook_event_name: 'PreCompact', transcript_path: transcript, cwd, trigger, custom_instructions: '' })
  const run = runHook(w, 'session-start', { hook_event_name: 'SessionStart', transcript_path: transcript, cwd, source: 'compact' })
  const out = hookJson(run.stdout)
  return String((out?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}

// ── A spawner's library door (no worker process) ───────────────────────

/** A worker registered through the library door a spawner calls
 *  (`FlatStore.registerWorker`), with no worker process running the ticket
 *  door: for a Given whose worker is history, or a registry scenario. */
export async function workerLeg(w: RunWorld, name: string, opts: {
  role: string; run: string | null; key: string | null; parent?: string
  checkpointer?: string | null; startCheckpoints?: string[]; at?: number
  process?: { pid: number | null; start: number | null; host: string; token?: string | null }
}): Promise<LegRef> {
  const leg = await w.store!.registerWorker({
    door: 'library',
    ticket: {
      parent: { id: opts.parent ?? w.sessionId ?? 'p1' }, run: opts.run, key: opts.key, role: opts.role,
      checkpointer: opts.checkpointer === undefined ? opts.role : opts.checkpointer, mintedAt: (opts.at ?? Date.now() / 1000) - 1,
    },
    process: opts.process ?? liveProcess(),
    ...(opts.startCheckpoints ? { startCheckpoints: opts.startCheckpoints } : {}),
    ...(opts.at !== undefined ? { at: opts.at } : {}),
  })
  const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  w.legs![name] = ref
  return ref
}

/** The library door with the spawner's own input as written (a ticket of
 *  any shape, the process as the spawner read it), the leg kept by name. */
export async function registerThroughLibrary(w: RunWorld, name: string, input: Parameters<FlatStore['registerWorker']>[0]): Promise<LegRegistration> {
  const leg = await w.store!.registerWorker(input)
  w.legs ??= {}
  w.legs[name] = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  return leg
}

/** A leg retired with no summary row: a state no door's exit produces
 *  (the ticket door's exit writes the worker's summary row, the
 *  SubagentStop hook the subagent's), seeded for a Given of history whose
 *  Then reads neither the return nor the exit, and only for that. */
export function retiredWithoutReturn(w: RunWorld, ref: LegRef, at?: number): boolean {
  return w.store!.retireLeg(ref, 'retired', at)
}

/** A leg's end as the harness's timeout cuts it (D292), for a Given that
 *  needs the cut already made; journal-workers binds the real signal. */
export function cutByTimeout(w: RunWorld, ref: LegRef, at?: number): boolean {
  return w.store!.retireLeg(ref, 'cut', at)
}

/** A worker's exit with its last output written as its summary row, as the
 *  ticket door writes it at exit, for a Given that needs the return there. */
export async function exitedWithSummary(w: RunWorld, ref: LegRef, output: string): Promise<void> {
  await w.store!.retireWorker(ref, { output, how: 'retired', summary: true })
}

/** The harness retiring a leg through the library door, where the
 *  scenario's own words say the harness does it. */
export function harnessRetiresLeg(w: RunWorld, ref: LegRef, at?: number): boolean {
  return w.store!.retireLeg(ref, 'retired', at)
}

// ── Headless workers through the real ticket door ──────────────────────

/** The hook-less headless worker's stand-in process. */
export const STANDIN_WORKER = join(TS_ROOT, 'tests', 'helpers', 'standin-worker.ts')
/** The stand-in `claude -p` child: it fires the real hooks Claude Code
 *  fires, with the platform's payloads and its own environment. */
export const STANDIN_CLAUDE_P = join(TS_ROOT, 'tests', 'helpers', 'standin-claude-p.ts')

/** One run of the hook-less stand-in (the plan vocabulary above). */
export interface WorkerStep {
  notes?: number; label?: string; texts?: string[]; checkpoint?: string; checkpoints?: string[]; invalidRow?: boolean; print?: string
  exit?: number | 'hang'; waitFor?: string; at?: number; viaTools?: boolean
  /** Reads through its own tools after its writes (the real serve). */
  reads?: { query?: Record<string, unknown>; status?: Record<string, unknown> }
  /** Handshake reads (D382): a real serve per entry, its `initialize`
   *  instructions recorded; `ticket` / `lane` replace that server's worker
   *  variables, null leaves one out. */
  handshakes?: Array<{ ticket?: string | null; lane?: string | null }>
}
/** The hook-less stand-in's plan (STANDIN_PLAN). */
export interface WorkerPlan { first: WorkerStep; rerun?: WorkerStep; claim?: { prompt?: string } }

/** The stand-in `claude -p` child's plan (STANDIN_CLAUDE_PLAN). */
export interface ClaudePPlan {
  /** Notes the child writes through its own tools: a real `treecontext
   *  serve` it starts with its own environment, each a treecontext_insert
   *  call whose PostToolUse echo it fires, as Claude Code does. */
  toolNotes?: string[]
  tools?: number
  /** The Bash calls' output: `{i}` their number, `{label}` first or after. */
  toolText?: string
  checkpoint?: string
  /** A child that checkpoints more than once: each is written in turn, numbered and superseding the one before by the store's own rule. */
  checkpoints?: string[]
  afterSendBack?: { checkpoint?: string; checkpoints?: string[]; tools?: number }
  final?: string; exit?: number; waitBeforeStop?: string; waitAfterStop?: string; invalidRow?: boolean
}

/** What a stand-in recorded it received and saw, one line per run. */
export interface StandinRecord {
  pid: number; start: number | null; rerun: boolean; stdin: string; argv: string[]; ticket: string | null; lane: string | null
  claimed: boolean; session: string | null; laneRowsSeen: number; firstRunNotesSeen: number; firstMessage: string | null
  /** The stand-in `claude -p` child's own: its Claude Code session, the
   *  context its session-start hook handed it, what its stop hook said. */
  ccSession?: string; context?: string | null; systemMessage?: string | null; sentBack?: string | null; stops?: string[]
  /** The stand-in `claude -p` child's: its session-start hook's stdout,
   *  whole, as Claude Code reads it. */
  startStdout?: string
  /** The hook-less stand-in's reads through its own tools (a plan's
   *  `reads`): each tool's reply, parsed, as its CLI received it. */
  reads?: { query?: Record<string, unknown>; status?: Record<string, unknown> }
  /** The hook-less stand-in's handshake reads (a plan's `handshakes`):
   *  each server's `initialize` instructions, whole, in the plan's order. */
  handshakes?: string[]
}

/** What spawns the worker: the wrapper, the library call, or nothing (a
 *  process that holds its ticket and claims it itself). */
export type Spawner = 'wrapper' | 'library' | 'none'

export interface WorkerSpec {
  spawner: Spawner
  /** The ticket: fields (minted by the wrapper's flags or by the library
   *  call) or its text as the spawner put it in the environment. */
  ticket: TicketFields | string
  prompt: string
  plan: WorkerPlan
  timeoutSecs?: number
  checkTicket?: boolean
  /** How the leg is expected to read once ended (for the lookup's Then). */
  expectEnd?: 'retired' | 'phantom' | 'cut'
  cwd?: string
  /** The door's clock (the library call's), for a run replayed at its
   *  own moments. */
  clock?: () => number
  /** The worker is a `claude -p` child (the stand-in that fires the real
   *  hooks), on this plan, instead of the hook-less stand-in. */
  claudeP?: ClaudePPlan
}

export interface Outcome {
  spawner: Spawner
  stdout: string
  stderr: string
  line: string
  exitCode: number | null
  elapsedMs: number
  sessionId: string | null
  log: StandinRecord[]
  logPath: string
  result: WorkerRunResult | null
}

/** The wrapper's ticket flags for minted fields. */
export function ticketFlags(t: TicketFields): string[] {
  const out = ['--run', t.run, '--role', t.role, '--parent', t.parent.id]
  if (t.noKey) out.push('--no-key')
  else out.push('--key', t.key!)
  if (t.checkpointer) out.push('--checkpointer', t.checkpointer)
  if (t.checkpointedBy) out.push('--checkpointed-by', t.checkpointedBy)
  if (t.parent.cli) out.push('--parent-cli', t.parent.cli)
  if (t.canWrite === true) out.push('--door')
  if (t.canWrite === false) out.push('--no-door')
  return out
}

let standinRuns = 0

/**
 * Run a worker through its spawner's door to its end: the library's
 * `spawnWorker` in this process, the real `treecontext run` wrapper in a
 * subprocess under the sandboxed home, or no door at all (the stand-in
 * holds its ticket and claims it). `during` runs while it is alive (the
 * library's promise or the wrapper's process). The outcome is kept as
 * `out:<name>` and the leg as `legs[name]`.
 */
export async function runWorker(w: RunWorld, spec: WorkerSpec, name = 'worker', during?: () => Promise<void>): Promise<Outcome> {
  const logPath = join(w.home!, `standin-${++standinRuns}.jsonl`)
  const standinEnv = {
    STANDIN_DB: w.dbPath!, STANDIN_LOG: logPath, STANDIN_PLAN: JSON.stringify(spec.plan),
    ...(spec.claudeP ? { STANDIN_CLAUDE_PLAN: JSON.stringify(spec.claudeP) } : {}),
  }
  const script = spec.claudeP ? STANDIN_CLAUDE_P : STANDIN_WORKER
  const sandbox = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'), ...standinEnv })
  const cwd = spec.cwd ?? w.proj!
  const t0 = Date.now()
  let out: Omit<Outcome, 'log' | 'sessionId' | 'logPath' | 'elapsedMs'>
  if (spec.spawner === 'library') {
    const p = spawnWorker({
      store: w.store!, ticket: spec.ticket, prompt: spec.prompt, command: process.execPath, args: nodeTsArgs(script), cwd,
      env: sandbox, ...(spec.timeoutSecs ? { timeoutMs: spec.timeoutSecs * 1000 } : {}),
      ...(spec.checkTicket ? { checkTicket: true, spawner: { sessionId: w.sessionId! } } : {}),
      ...(spec.clock ? { clock: spec.clock } : {}),
    })
    await during?.()
    const result = await p
    out = { spawner: 'library', stdout: result.output, stderr: '', line: result.line, exitCode: result.exitCode, result }
  } else {
    const raw = typeof spec.ticket === 'string' ? spec.ticket : mintTicket(spec.ticket)
    let args: string[]
    let env: NodeJS.ProcessEnv = sandbox
    if (spec.spawner === 'none') {
      // No door at all: the worker holds its ticket and claims it itself.
      args = nodeTsArgs(script)
      env = { ...sandbox, [TICKET_ENV]: raw }
    } else {
      const promptFile = join(w.home!, `prompt-${standinRuns}.txt`)
      writeFileSync(promptFile, spec.prompt)
      // Fields are minted by the wrapper's flags; a ticket given as text
      // sits in the wrapper's environment, where its spawner put it.
      const ticketArgs = typeof spec.ticket === 'string' ? [] : ticketFlags(spec.ticket)
      if (typeof spec.ticket === 'string') env = { ...sandbox, [TICKET_ENV]: spec.ticket }
      args = nodeTsArgs(CLI_TS, [
        'run', ...ticketArgs, '--prompt-file', promptFile,
        ...(spec.timeoutSecs ? ['--timeout', String(spec.timeoutSecs)] : []),
        ...(spec.checkTicket ? ['--check-ticket'] : []),
        '--', process.execPath, ...nodeTsArgs(script),
      ])
    }
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    w.defer(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString() })
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
    await during?.()
    const exitCode = await exited
    const line = stderr.split('\n').filter((l) => l.startsWith(DOOR_LINE_PREFIX)).at(-1) ?? ''
    out = { spawner: spec.spawner, stdout, stderr, line, exitCode, result: null }
  }
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as StandinRecord) : []
  // A `claude -p` child no wrapper watched has no spawner's line: what it
  // was told at its stop (its stop hook's message) is the line it ends on.
  if (spec.claudeP && spec.spawner === 'none' && out.line === '') {
    for (const stop of log[0]?.stops ?? []) {
      try {
        const m = (JSON.parse(stop.trim() || '{}') as { systemMessage?: string }).systemMessage
        if (typeof m === 'string') out = { ...out, line: m }
      } catch { /* not the hook's JSON */ }
    }
  }
  const sessionId = out.result?.sessionId ?? log[0]?.session ?? /\(session ([^,)]+)/.exec(out.line)?.[1] ?? null
  const full: Outcome = { ...out, log, logPath, sessionId, elapsedMs: Date.now() - t0 }
  w.facts![`out:${name}`] = full
  if (sessionId) w.legs![name] = { sessionId, agentId: WORKER_AGENT_ID }
  return full
}

// ── The client a version check reads ───────────────────────────────────

/**
 * A `claude` in `dir` whose `--version` answers as the scenario says: a
 * version prints `<version> (Claude Code)` as the real client does, and
 * null is a client whose version cannot be read (it prints nothing with a
 * version in it and exits non-zero). Writing it again replaces the binary
 * in place, which is how a scenario upgrades the client between two runs.
 * It answers `--version` and nothing else: install and doctor read no more.
 */
export function writeFakeClaude(dir: string, version: string | null): void {
  const answer = version === null ? 'claude: cannot report a version' : `${version} (Claude Code)`
  const status = version === null ? 1 : 0
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\necho ${answer}\r\nexit /b ${status}\r\n`)
  } else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho '${answer}'\nexit ${status}\n`, { mode: 0o755 })
  }
}

/**
 * A `gemini` in `dir`: Gemini CLI's command on PATH, which install reads
 * as Gemini CLI installed (D383) without running it. It answers nothing:
 * run, it exits 127 saying it is a stand-in, so a caller that reached for
 * more than its presence fails loudly.
 */
export function writeFakeGemini(dir: string): void {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'gemini.cmd'), '@echo off\r\necho stand-in gemini: not stood in for 1>&2\r\nexit /b 127\r\n')
  } else {
    writeFileSync(join(dir, 'gemini'), '#!/bin/sh\necho "stand-in gemini: not stood in for" >&2\nexit 127\n', { mode: 0o755 })
  }
}

/** What the stand-in `codex` answers: its version, and its sandbox check's result. */
export interface FakeCodexPlan {
  /** `codex --version` prints `codex-cli <version>`; null prints nothing with a version and exits 1. */
  version: string | null
  /** `codex sandbox -- …`: the exit code and what it writes on stderr. */
  sandbox: { exit: number; stderr: string }
}

/**
 * A `codex` in `dir` that answers `--version` and `sandbox -- <command>`
 * by its plan, and nothing else: every other subcommand exits 2 saying it
 * is not stood in for, so a caller that reached for more than doctor and
 * install read fails loudly instead of being answered. Writing it again
 * replaces it in place. POSIX only answers the sandbox check (doctor runs
 * it on Linux alone); the Windows shim answers the version.
 */
export function writeFakeCodex(dir: string, plan: FakeCodexPlan): void {
  const version = plan.version === null ? null : `codex-cli ${plan.version}`
  if (process.platform === 'win32') {
    const v = version === null ? 'echo codex: cannot report a version\r\nexit /b 1' : `echo ${version}\r\nexit /b 0`
    writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\nif "%1"=="--version" (\r\n${v}\r\n)\r\necho stand-in codex: %1 is not stood in for 1>&2\r\nexit /b 2\r\n`)
    return
  }
  const q = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  writeFileSync(join(dir, 'codex'), [
    '#!/bin/sh',
    'case "$1" in',
    version === null ? '  --version) echo "codex: cannot report a version"; exit 1 ;;' : `  --version) echo ${q(version)}; exit 0 ;;`,
    // Only the check doctor runs, `sandbox -- true`, exactly; any other
    // command in the sandbox is not stood in for.
    `  sandbox) [ "$#" -eq 3 ] && [ "$2" = "--" ] && [ "$3" = "true" ] || { echo "stand-in codex: sandbox $* is not stood in for" >&2; exit 2; }`,
    `           printf '%s\\n' ${q(plan.sandbox.stderr)} >&2; exit ${plan.sandbox.exit} ;;`,
    '  *) echo "stand-in codex: $1 is not stood in for" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
}

/**
 * A client starting the server its treecontext entry names, as Claude Code,
 * Codex CLI and Antigravity CLI do at a session's start: the command and the
 * arguments the client itself read from its configuration (journal-install's
 * `clientEntry`, or agy's own `agy mcp list`), spawned as they are, with stdin held open as a client
 * holds it. It may do nothing else: it writes no configuration and reads no
 * row.
 *
 * The command is whatever the entry names, normally the launcher install
 * wrote under the home, and it runs as written: whatever that launcher does
 * with its arguments is what the server receives. Under this suite the
 * launcher's pinned module is the source tree's `cli.js`, which exists only
 * as its `.ts` twin, so this build is placed, compiled, where a global
 * install lands under the home (tests/helpers/built-package.ts), and the
 * launcher's own fallback finds and runs it.
 *
 * What it returns is the server's own word: the `Mode:` line `serve`
 * writes to its debug log under the home, the log of the process it
 * started (named by its pid). `holdUntil`, when given, keeps
 * the server running after that line until it answers true (polled, at most
 * 60 seconds), for a caller that watches what the server does. The server
 * is stopped after.
 */
export async function startEntryAsClient(
  home: string, entry: { command: string; args: string[] }, cwd: string,
  holdUntil?: () => boolean,
): Promise<string> {
  const unplace = placeBuiltPackage(home)
  const logs = join(home, '.treecontext', 'logs')
  const before = new Set(existsSync(logs) ? readdirSync(logs) : [])
  const win = process.platform === 'win32'
  const child = spawn(win ? `"${entry.command}"` : entry.command, entry.args, {
    cwd, env: sandboxedSpawnEnv(home), stdio: ['pipe', 'pipe', 'pipe'], shell: win,
  })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  child.stdout.resume()
  // The log of the server this call started, by its process: the launcher
  // execs node, so on POSIX the server keeps the child's pid, which its log
  // file is named by. On Windows the batch launcher runs node as a child of
  // its own, so there the log is the one this start created.
  const ours = (f: string): boolean => win ? !before.has(f) : f.endsWith(`-${child.pid}.log`)
  const modeLine = (): string | undefined => {
    if (!existsSync(logs)) return undefined
    for (const f of readdirSync(logs)) {
      if (!ours(f)) continue
      const m = /\[serve\] Mode: (.+)/.exec(readFileSync(join(logs, f), 'utf8'))?.[1]
      if (m) return m.trim()
    }
    return undefined
  }
  try {
    const deadline = Date.now() + 60_000
    let mode: string | undefined
    while (Date.now() < deadline) {
      mode ??= modeLine()
      if (mode !== undefined && (!holdUntil || holdUntil())) return mode
      if (child.exitCode !== null) throw new Error(`the server exited ${child.exitCode} before ${mode ? 'the caller was done' : 'writing its mode'}:\n${stderr}`)
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(`${mode ? `the server ran in ${mode}, but what the caller waited for` : 'the server wrote no mode line'} did not happen within 60s:\n${stderr}`)
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()) })
    unplace()
  }
}
