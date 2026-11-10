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
 *  |   (tests/helpers/standin-claude-p.ts)  | real hooks the install wires, with payloads and an order    |
 *  |                                        | the stand-in WRITES (hand-written models, not recordings)   |
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
 *  |                                        | subcommand or sandbox command (exit 2, saying so). Its app  |
 *  |                                        | server, where the plan gives `hooksList`, answers the n-th  |
 *  |                                        | `hooks/list` with the plan's n-th line, a hand-written      |
 *  |                                        | model of the answer shapes recorded from Codex CLI 0.167.0  |
 *  |                                        | (codex-hooks.ts CodexFileVerdict), never Codex's own word;  |
 *  |                                        | `'hang'` reads its stdin and never answers. It never reads  |
 *  |                                        | the hooks file it answers about. Where the plan gives       |
 *  |                                        | `lockBefore`, it takes write permission off that one path   |
 *  |                                        | before that answer: the developer, or another program,      |
 *  |                                        | changing the file system between install's two reads        |
 *  |                                        | (codex-install-shapes, a put-back that fails), never an act |
 *  |                                        | of Codex's own                                              |
 *  | `writeCodexVersionLine`                | the `codex` on PATH where the host's Codex has moved past   |
 *  |                                        | the version a Given names (no client is pinned; Codex ships |
 *  |                                        | weekly): it answers `--version` with the Given's line and   |
 *  |                                        | hands every other invocation, arguments untouched, to the   |
 *  |                                        | real Codex, so its account of its hooks, its configuration  |
 *  |                                        | and its sandbox check stay Codex's own. It stands in for    |
 *  |                                        | the version line alone, and must never be given a version   |
 *  |                                        | NEWER than the real Codex (the harness refuses that)        |
 *  | `writeCodexPassThrough`                | nothing: a `codex` on PATH that hands `--version` and       |
 *  |                                        | `app-server` to the real Codex further along PATH, so the   |
 *  |                                        | answers are Codex's own, and refuses everything else (exit  |
 *  |                                        | 2, saying so), so that a doctor run reads Codex's account   |
 *  |                                        | of its hooks and configuration and never runs Codex's       |
 *  |                                        | sandbox or a model; it adds, drops or edits nothing         |
 *  | `writeFakeGemini`                      | the `gemini` on PATH of a machine with Gemini CLI, which    |
 *  |                                        | install and doctor no longer read (D399): they never run    |
 *  |                                        | it; run, it answers nothing and exits 127, saying so        |
 *  | `startEntryAsClient`                   | a client (Claude Code, Codex CLI, Antigravity CLI, Cursor)  |
 *  |                                        | starting the MCP server its treecontext entry names: the    |
 *  |                                        | command and args the client read, spawned as written, so    |
 *  |                                        | the real launcher runs this build compiled (journal-        |
 *  |                                        | install, D386, D383)                                        |
 *  | `preCompact`                           | Claude Code compacting a session's context: it fires the    |
 *  |                                        | real PreCompact hook, then SessionStart with source         |
 *  |                                        | `compact` under the same session, in that order (D375)      |
 *  | `replayRecordedSession`                | Claude Code firing a recorded session's hook events (D402): |
 *  |                                        | each event of a file under tests/fixtures/claude-code-hooks,|
 *  |                                        | in the client's order, handed to exactly the commands the   |
 *  |                                        | block install writes registers for its `hook_event_name`    |
 *  |                                        | (its matcher read as the client reads it), each run as the  |
 *  |                                        | installed script runs it (`treecontext hook <event>` with   |
 *  |                                        | the arguments the command hands the script, D404); an       |
 *  |                                        | event the block does not register reaches no hook. It may   |
 *  |                                        | rewrite only `cwd`, `transcript_path`,                      |
 *  |                                        | `agent_transcript_path` and, when asked, `session_id`; it   |
 *  |                                        | must never change a payload's shape, add, drop or edit a    |
 *  |                                        | field, an input, a response, an error or an id, or run a    |
 *  |                                        | hook the block does not name. The session reminder script   |
 *  |                                        | only prints and writes nothing, so it is not run            |
 *  | `replayRecordedSession` with a Codex   | Codex CLI firing a recorded set's hook events (D409): the    |
 *  |   set (`recordedSession(..., 'codex')`)| same rules, the events of tests/fixtures/codex-hooks, the   |
 *  |                                        | commands of the block install writes for Codex             |
 *  |                                        | (`codexHooksBlock`); `env` may hand every hook the         |
 *  |                                        | variables the client's own environment held (a ticketed    |
 *  |                                        | worker's ticket and lane, as recorded), never more         |
 *  | `replayRecordedSession` with an agy    | Antigravity CLI firing a recorded set's hook events (D417): |
 *  |   set (`recordedSession(..., 'agy')`)  | each event of tests/fixtures/agy-hooks, in agy's order, to  |
 *  |                                        | the commands of the named hook install writes for agy       |
 *  |                                        | (`agyHooksBlock`) for the event the recording names, each   |
 *  |                                        | run as the installed script runs it; before each event the  |
 *  |                                        | conversation's transcript as it stood then (the recording's |
 *  |                                        | prefix) is written where `transcriptPath` points. It may    |
 *  |                                        | rewrite only `transcriptPath` and `workspacePaths`, and with|
 *  |                                        | `transcript: 'unreadable'` point `transcriptPath` at a path |
 *  |                                        | that cannot be read (a transcript agy did not leave         |
 *  |                                        | readable); never a payload's shape, a call, an argument, an |
 *  |                                        | error or an id                                              |
 *  | `writeFakeAgy`                         | the `agy` on PATH whose `--version` install and doctor read |
 *  |                                        | (journal-install, journal-clients, D413, D414): it answers  |
 *  |                                        | `--version` with the plan's version and nothing else; every |
 *  |                                        | other subcommand exits 2 saying it is not stood in for      |
 *  |                                        | (`agyMcpListPassThrough` hands `mcp list` to the real agy)  |
 *  | `developerTrustsCodexHooks`,           | the developer trusting hooks in Codex's `/hooks`: a trust  |
 *  |   `staleCodexTrustRecord`              | record per hook in Codex's config.toml with the hash Codex |
 *  |                                        | itself reports (`hooks/list`); it computes no hash, trusts |
 *  |                                        | no hook Codex does not list and writes nothing else; the   |
 *  |                                        | record's shape (`[hooks.state."<key>"] trusted_hash`) is   |
 *  |                                        | the one the far-side pass of 2026-11-09 read back from     |
 *  |                                        | config.toml after the developer's real /hooks trust; the   |
 *  |                                        | trust status a scenario asserts is always Codex's own      |
 *  |                                        | answer (`hooks/list`), never one written here              |
 *  | `PID_SANDBOX` (a spec's `sandbox`,     | Codex CLI's sandbox on Linux (bwrap, a pid namespace of its |
 *  |   `lookupInSandbox`)                   | own, D403): a REAL pid namespace `unshare` makes, the      |
 *  |                                        | wrapper or the harness's lookup run inside it; it numbers  |
 *  |                                        | the processes in it apart and does nothing else (the same  |
 *  |                                        | user, host name, files and store); ended, it ends every    |
 *  |                                        | process in it. `PID_SANDBOX_MACHINE_PROC` is the same      |
 *  |                                        | sandbox keeping the machine's /proc (bwrap without         |
 *  |                                        | `--proc`)                                                   |
 *  | a spec's `earlierBuild`                | the `treecontext run` wrapper of a build before D403       |
 *  |   (tests/helpers/earlier-build-run.ts) | (D403's correction outline): this build's wrapper with its |
 *  |                                        | probe's numbering reading taken off, so it records no      |
 *  |                                        | numbering and its own pass judges by its own process table;|
 *  |                                        | the rest of the door, its retirement included, is this     |
 *  |                                        | build's                                                     |
 *  | `osAnsweringGone`                      | the operating system's answer about one process, as a      |
 *  |                                        | reader's probe reads it (the far side of process-probe.ts, |
 *  |                                        | D403's correction outline): it answers, for the one        |
 *  |                                        | process named by its id and numbering, that no such        |
 *  |                                        | process exists and its numbering holds none, the wrong     |
 *  |                                        | answer that makes a reader take a running worker for gone; |
 *  |                                        | every other question it hands to the host's own probe. It  |
 *  |                                        | is given to a reader's lookup only, never to a door, and   |
 *  |                                        | never writes the store. Why a stand-in: every route by     |
 *  |                                        | which this build's reader was found to take this build's   |
 *  |                                        | running worker for gone (a /proc not of the door's or the  |
 *  |                                        | reader's numbering, a door or reader with no /proc, a      |
 *  |                                        | start read in another time namespace, a process the reader |
 *  |                                        | may not read or a /proc that hides it) now leaves the      |
 *  |                                        | worker live, and no other is known on Linux; the wrong     |
 *  |                                        | "gone" the outline needs has no real source left to run.   |
 *  |                                        | "None known" is a claim to test, not a fact: three reviews |
 *  |                                        | each found a route after an earlier wording said none was  |
 *  |                                        | left (the last, 2026-11-10: a process the reader may not   |
 *  |                                        | read whose start was read in another time namespace). A    |
 *  |                                        | route found later is closed and its real sandbox becomes a |
 *  |                                        | test; the stand-in never stands in for one that still runs |
 *
 * ── What a stand-in may do ────────────────────────────────────────────
 *
 * Only what its platform could: read its ticket, its environment and its
 * stdin; write as the leg its door made it, by the means that platform
 * has (a hook-less headless worker: the library or its own tools, a
 * `treecontext serve` it starts; a `claude -p` child: its tools only, each
 * call echoed by PostToolUse, as Claude Code runs them); fire the hooks
 * with payloads shaped after Claude Code's, in the order Claude Code is
 * understood to send them (SessionStart, UserPromptSubmit, PostToolUse per
 * tool call, Stop, and Stop again with `stop_hook_active` after a block; at
 * a compaction, PreCompact and then SessionStart with source `compact`);
 * print its last
 * output and exit as told (a code, or hanging until a signal). The payloads
 * are hand-written models, the stand-in's own words, not the client's: the
 * recorded ground truth is tests/fixtures/claude-code-hooks, replayed by
 * `replayRecordedSession` (D402), and a step that claims "as Claude Code
 * sends it" uses that, never these.
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
 * serve` instead of the library, each reply its CLI received recorded
 * whole in its log line as `inserts`, in order), `reads` (after its writes, the reads
 * a worker's CLI makes through those same tools: `query` a
 * treecontext_query call with these arguments, `status` a
 * treecontext_status call; each reply recorded whole in its log line as
 * `reads`; reads imply the real serve), `toolsStore` (D424: the store
 * file that serve opens instead of the door's, as a worker's client
 * starts its server in a directory bound to another store than the one
 * its door was given; the stand-in itself still reads its leg from the
 * door's), `handshakes` (handshake reads,
 * D382: before any write, each a real `treecontext serve` started over
 * stdio with its own environment, `initialize`'s instructions recorded
 * whole in its log line as `handshakes`, in order; an entry's `ticket`
 * replaces TREECONTEXT_TICKET for that one server and its `lane` replaces
 * TREECONTEXT_WORKER_SESSION, null leaving the variable out, as a nested
 * worker's or a client's server that inherited the lane with a ticket of
 * its own, or with no worker variables, would be started; it calls no
 * tool), `at` (the rows' moment),
 * `waitFor` (a file it waits for after writing `<file>.ready`),
 * `waitBeforeWrites` (the same wait, before it writes anything: it runs
 * with nothing of its own in the store until let go), `envTo`
 * (D389: a file it writes its whole environment to, as JSON, once it
 * has claimed its leg and before it writes anything; never printed, so no
 * variable of it can reach a summary row), `stderr` (D384: text written to its error stream, before `print`),
 * `groupChild` (D393: before its log line, it starts a long-running
 * command, `sleep 600`, in its own process group, which the door made
 * the worker's, its stdio let go; the command's pid is in its log line as
 * `groupChild`), `bgStderr` (D397: before its log line, it starts a
 * background process holding its error stream and nothing else, which
 * writes `background line <i>` there every `everyMs`, `lines` times, and
 * outlives the worker; its pid is in its log line as `background`),
 * `print` (its last output), `exit` (a code, or `'hang'`). The run that
 * opens on the door's send-back message follows `rerun`. What it starts
 * is a real process the binding finds, reads and ends; the stand-in never
 * signals it and never leaves its group or session.
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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { WORKER_AGENT_ID, type LegRef, type LegRegistration } from '../../src/persistence/leg-registry.js'
import { mintTicket, TICKET_ENV, type TicketFields } from '../../src/ticket.js'
import { hostProbe, type ProcessProbe } from '../../src/persistence/process-probe.js'
import { spawnWorker, DOOR_LINE_PREFIX, type WorkerRunResult } from '../../src/ticket-door.js'
import type { FlatStore } from '../../src/flat-store.js'
import { sandboxedSpawnEnv, nodeTsArgs, CLI_TS } from '../helpers/cli-spawn.js'
import { placeBuiltPackage } from '../helpers/built-package.js'
import { TS_ROOT } from './proc.js'
import { type RunWorld, briefFor, subagentStartHook, liveProcess } from './run-world.js'
import { type CaptureWorld, runHook, hookJson } from './capture-harness.js'
import { claudeHooksBlock, hookScriptContent } from '../../src/server/installer.js'
import { codexHooksBlock } from '../../src/server/codex-hooks.js'
import { agyHooksBlock } from '../../src/server/agy-hooks.js'
import { readCodexHooksTrust, type CodexListedHook } from '../../src/server/codex-client.js'

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
  /** D424: the store file its tools' serve opens instead of the door's. */
  toolsStore?: string
  /** D403: a file it waits for, after writing `<file>.ready`, before it
   *  writes anything. */
  waitBeforeWrites?: string
  /** D384: text written to its error stream before `print`. */
  stderr?: string
  /** D389: a file its whole environment is written to, as JSON. */
  envTo?: string
  /** D389, D384: the lines `NAME=value` of its environment whose names
   *  start with this prefix, written to its error stream (after `stderr`),
   *  so that a variable the door failed to leave out would reach the
   *  summary row's error tail. */
  envToStderr?: string
  /** Reads through its own tools after its writes (the real serve). */
  reads?: { query?: Record<string, unknown>; status?: Record<string, unknown> }
  /** Handshake reads (D382): a real serve per entry, its `initialize`
   *  instructions recorded; `ticket` / `lane` replace that server's worker
   *  variables, null leaves one out. */
  handshakes?: Array<{ ticket?: string | null; lane?: string | null }>
  /** D393: a long-running command started in the worker's own process
   *  group (`sleep 600`), its pid in the log line. */
  groupChild?: boolean
  /** D397: a background process writing to the worker's error stream,
   *  `lines` times, every `everyMs`, its pid in the log line. */
  bgStderr?: { lines: number; everyMs: number }
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
  /** The hook-less stand-in's inserts through its own tools (a plan's
   *  `viaTools`): each treecontext_insert reply, parsed, as its CLI
   *  received it, in the order it wrote them. */
  inserts?: Array<Record<string, unknown>>
  /** The hook-less stand-in's long-running command in its group (a
   *  plan's `groupChild`), and its background error-stream writer (a
   *  plan's `bgStderr`): their pids. */
  groupChild?: number
  background?: number
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
  /** D424: the store the door is given, where it is not the world's
   *  own (the library spawner only): its handle and its file. */
  doorStore?: { store: FlatStore; dbPath: string }
  /** The door's clock (the library call's), for a run replayed at its
   *  own moments. */
  clock?: () => number
  /** The worker is a `claude -p` child (the stand-in that fires the real
   *  hooks), on this plan, instead of the hook-less stand-in. */
  claudeP?: ClaudePPlan
  /** D389: variables the spawner's own environment holds beside the
   *  sandbox's (a client session's, say): the wrapper's process
   *  environment, or the environment the library call is given. */
  spawnerEnv?: Record<string, string>
  /** D403: the wrapper runs inside a sandbox on this host that numbers
   *  its own processes (PID_SANDBOX); the sandbox's own process is kept as
   *  `sandbox:<name>` in the world's facts, for a binding that ends it.
   *  `keeps-machine-proc`: the sandbox numbers its own processes and still
   *  shows the machine's list of them (PID_SANDBOX_MACHINE_PROC). */
  sandbox?: boolean | 'keeps-machine-proc'
  /** D403: the wrapper as an earlier build ran it, recording no numbering
   *  of processes (tests/helpers/earlier-build-run.ts). */
  earlierBuild?: boolean
  /** D389: the library call given no environment, so the worker inherits
   *  this process's own; the spawner's environment (the sandbox's and
   *  `spawnerEnv`) is put in this process's for the call and restored
   *  after it. */
  libraryOwnEnv?: boolean
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
  /** The library spawner's error stream as handed on so far, read when
   *  called: the door goes on handing it on after the run settled (D397).
   *  Null for the wrapper, whose stream is its own process's. */
  stderrSoFar: (() => string) | null
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
 * library's promise or the wrapper's process), given the stand-in's log
 * path. The outcome is kept as `out:<name>` and the leg as `legs[name]`.
 */
export async function runWorker(w: RunWorld, spec: WorkerSpec, name = 'worker', during?: (logPath: string) => Promise<void>): Promise<Outcome> {
  const logPath = join(w.home!, `standin-${++standinRuns}.jsonl`)
  const standinEnv = {
    STANDIN_DB: spec.doorStore?.dbPath ?? w.dbPath!, STANDIN_LOG: logPath, STANDIN_PLAN: JSON.stringify(spec.plan),
    ...(spec.claudeP ? { STANDIN_CLAUDE_PLAN: JSON.stringify(spec.claudeP) } : {}),
  }
  const script = spec.claudeP ? STANDIN_CLAUDE_P : STANDIN_WORKER
  const sandbox = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'), ...standinEnv })
  const cwd = spec.cwd ?? w.proj!
  const t0 = Date.now()
  let out: Omit<Outcome, 'log' | 'sessionId' | 'logPath' | 'elapsedMs'>
  const spawnerEnv = { ...sandbox, ...spec.spawnerEnv }
  if (spec.spawner === 'library') {
    // The library spawner's side of the error stream: each chunk as the
    // door hands it on (D307, D384).
    const errChunks: Buffer[] = []
    const restore = spec.libraryOwnEnv ? swapProcessEnv(spawnerEnv) : null
    let result: WorkerRunResult
    try {
      const p = spawnWorker({
        store: spec.doorStore?.store ?? w.store!, ticket: spec.ticket, prompt: spec.prompt, command: process.execPath, args: nodeTsArgs(script), cwd,
        ...(spec.libraryOwnEnv ? {} : { env: spawnerEnv }), ...(spec.timeoutSecs ? { timeoutMs: spec.timeoutSecs * 1000 } : {}),
        ...(spec.checkTicket ? { checkTicket: true, spawner: { sessionId: w.sessionId! } } : {}),
        ...(spec.clock ? { clock: spec.clock } : {}),
        onStderr: (c) => { errChunks.push(c) },
      })
      await during?.(logPath)
      result = await p
    } finally { restore?.() }
    out = { spawner: 'library', stdout: result.output, stderr: Buffer.concat(errChunks).toString('utf8'), line: result.line, exitCode: result.exitCode, result,
      stderrSoFar: () => Buffer.concat(errChunks).toString('utf8') }
  } else {
    const raw = typeof spec.ticket === 'string' ? spec.ticket : mintTicket(spec.ticket)
    let args: string[]
    let env: NodeJS.ProcessEnv = spawnerEnv
    if (spec.spawner === 'none') {
      // No door at all: the worker holds its ticket and claims it itself.
      args = nodeTsArgs(script)
      env = { ...spawnerEnv, [TICKET_ENV]: raw }
    } else {
      const promptFile = join(w.home!, `prompt-${standinRuns}.txt`)
      writeFileSync(promptFile, spec.prompt)
      // Fields are minted by the wrapper's flags; a ticket given as text
      // sits in the wrapper's environment, where its spawner put it.
      const ticketArgs = typeof spec.ticket === 'string' ? [] : ticketFlags(spec.ticket)
      if (typeof spec.ticket === 'string') env = { ...spawnerEnv, [TICKET_ENV]: spec.ticket }
      args = nodeTsArgs(spec.earlierBuild ? EARLIER_BUILD_RUN : CLI_TS, [
        ...(spec.earlierBuild ? [] : ['run']), ...ticketArgs, '--prompt-file', promptFile,
        ...(spec.timeoutSecs ? ['--timeout', String(spec.timeoutSecs)] : []),
        ...(spec.checkTicket ? ['--check-ticket'] : []),
        '--', process.execPath, ...nodeTsArgs(script),
      ])
    }
    const box = spec.sandbox === 'keeps-machine-proc' ? PID_SANDBOX_MACHINE_PROC : PID_SANDBOX
    const child = spec.sandbox
      ? spawn(box[0]!, [...box.slice(1), process.execPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    if (spec.sandbox && child.pid !== undefined) w.facts![`sandbox:${name}`] = child.pid
    w.defer(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    // The wrapper's own bytes, decoded once whole, so a character split
    // across two chunks is read as the spawner's terminal would show it.
    const outBytes: Buffer[] = []
    const errBytes: Buffer[] = []
    child.stdout!.on('data', (c: Buffer) => { outBytes.push(c) })
    child.stderr!.on('data', (c: Buffer) => { errBytes.push(c) })
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
    await during?.(logPath)
    const exitCode = await exited
    const stdout = Buffer.concat(outBytes).toString('utf8')
    const stderr = Buffer.concat(errBytes).toString('utf8')
    const line = stderr.split('\n').filter((l) => l.startsWith(DOOR_LINE_PREFIX)).at(-1) ?? ''
    out = { spawner: spec.spawner, stdout, stderr, line, exitCode, result: null, stderrSoFar: null }
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

/** This process's environment replaced by `env` until the returned
 *  function restores it, key by key. */
function swapProcessEnv(env: NodeJS.ProcessEnv): () => void {
  const saved = { ...process.env }
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
  }
}

// ── A sandbox that numbers its own processes (D403) ────────────────────

/** A sandbox on this host that numbers its own processes, as Codex CLI's
 *  does on Linux: a user and pid namespace of its own, /proc mounted for
 *  it, and every process in it ended when its own process is
 *  (`--kill-child`). The command to run follows. */
export const PID_SANDBOX: readonly string[] = ['unshare', '--user', '--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child']

/** A sandbox that numbers its own processes and still shows the machine's
 *  list of them, as bwrap without `--proc` does: PID_SANDBOX without
 *  `--mount-proc`. */
export const PID_SANDBOX_MACHINE_PROC: readonly string[] = ['unshare', '--user', '--map-current-user', '--pid', '--fork', '--kill-child']

/** The `treecontext run` wrapper of a build before D403 (a spec's
 *  `earlierBuild`). */
export const EARLIER_BUILD_RUN = join(TS_ROOT, 'tests', 'helpers', 'earlier-build-run.ts')

let sandboxAnswer: boolean | null = null
/** Whether this host can make PID_SANDBOX (Linux, with unprivileged user
 *  namespaces allowed): asked of the host once, by making one. */
export function canMakePidSandbox(): boolean {
  if (sandboxAnswer !== null) return sandboxAnswer
  if (process.platform !== 'linux') return (sandboxAnswer = false)
  const r = spawnSync(PID_SANDBOX[0]!, [...PID_SANDBOX.slice(1), 'sh', '-c', 'echo $$'], { encoding: 'utf8', timeout: 10_000 })
  return (sandboxAnswer = r.status === 0 && r.stdout.trim() === '1')
}

/** What the harness's lookup returned, made from inside a sandbox. */
export interface SandboxedLookup {
  legs: Array<{ sessionId: string; state: string; noticedAt: number | null; noticedBy: string | null }>
  notes: string[]
  unchecked: Array<{ sessionId: string; reason: string }>
  retired: string[]
}

/** The harness looking up a run's key from inside a sandbox on this host
 *  that numbers its own processes (D403): the library's lookupKey, the
 *  same call the harness makes, in a process of its own in PID_SANDBOX
 *  (tests/helpers/lookup-driver.ts). */
export function lookupInSandbox(w: RunWorld, run: string, key: string): SandboxedLookup {
  const r = spawnSync(PID_SANDBOX[0]!, [...PID_SANDBOX.slice(1), process.execPath, ...nodeTsArgs(join(TS_ROOT, 'tests', 'helpers', 'lookup-driver.ts'), [w.dbPath!, run, key])], {
    env: sandboxedSpawnEnv(w.home!), cwd: TS_ROOT, encoding: 'utf8', timeout: 60_000,
  })
  if (r.status !== 0) throw new Error(`the lookup inside the sandbox exited ${r.status}: ${r.stderr}`)
  return JSON.parse(r.stdout) as SandboxedLookup
}

/** The operating system answering a reader, for the one process named by
 *  its id (and its numbering, where the registration records one), that it
 *  does not exist (`osAnsweringGone`, see the table above). Every other
 *  question goes to the host's own probe. For a reader's lookup only. */
export function osAnsweringGone(pid: number, ns: string | null): ProcessProbe {
  const named = (p: number): boolean => p === pid
  return {
    host: () => hostProbe.host(),
    exists: (p) => (named(p) ? false : hostProbe.exists(p)),
    startMoment: (p) => (named(p) ? null : hostProbe.startMoment(p)),
    startToken: (p) => (named(p) ? null : hostProbe.startToken!(p)),
    pidNamespace: (p) => hostProbe.pidNamespace!(p),
    lookInNamespace: (n, p, registered) => (n === ns && named(p)
      ? { seen: true, hostPid: null, unreadable: false }
      : hostProbe.lookInNamespace!(n, p, registered)),
    seesEveryNumbering: () => hostProbe.seesEveryNumbering!(),
  }
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
 * A `gemini` in `dir`: Gemini CLI's command on PATH, which install read as
 * Gemini CLI installed until its retirement (D399) and reads no more; a
 * world puts it there to show it wires nothing. It answers nothing:
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

/**
 * An `agy` in `dir` whose `--version` prints the plan's version as agy 1.5.3
 * prints its own (the bare x.y.z, recorded 2026-11-09), and null a client
 * whose version cannot be read (it prints nothing with a version and exits
 * 1). With `realForMcpList`, `mcp list` is handed to the real agy at that
 * absolute path, so the listing a scenario reads is agy's own; every other
 * subcommand exits 2 saying it is not stood in for. POSIX only.
 */
export function writeFakeAgy(dir: string, version: string | null, realForMcpList?: string): void {
  // A link to the real agy is replaced, never written through.
  rmSync(join(dir, 'agy'), { force: true })
  const q = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  writeFileSync(join(dir, 'agy'), [
    '#!/bin/sh',
    'case "$1" in',
    version === null ? '  --version) echo "agy: cannot report a version" >&2; exit 1 ;;' : `  --version) echo ${q(version)}; exit 0 ;;`,
    ...(realForMcpList ? [`  mcp) [ "$2" = "list" ] && exec ${q(realForMcpList)} "$@"; echo "stand-in agy: mcp $2 is not stood in for" >&2; exit 2 ;;`] : []),
    '  *) echo "stand-in agy: $1 is not stood in for" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
}

/** What the stand-in `codex` answers: its version, and its sandbox check's result. */
export interface FakeCodexPlan {
  /** `codex --version` prints `codex-cli <version>`; null prints nothing with a version and exits 1. */
  version: string | null
  /** `codex sandbox -- …`: the exit code and what it writes on stderr. */
  sandbox: { exit: number; stderr: string }
  /**
   * `codex app-server`: absent, it is not stood in for (exit 2, saying so,
   * before any answer); `'hang'`, it reads its stdin and never answers; a
   * list, the n-th `hooks/list` (counting every app server this stand-in
   * started) is answered with the n-th line, one JSON-RPC message, and an
   * app server past the list exits 2 unanswered. POSIX only.
   */
  hooksList?: 'hang' | string[]
  /** Before the `answer`-th `hooks/list` (counting from 0), take write
   *  permission off `path` (chmod a-w): a change made between install's two
   *  reads, never Codex's. POSIX only. */
  lockBefore?: { answer: number; path: string }
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
    ...appServerCase(dir, plan.hooksList, plan.lockBefore),
    '  *) echo "stand-in codex: $1 is not stood in for" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
}

/**
 * A `codex` in `dir` whose `--version` prints `codex-cli <version>` and
 * whose every other invocation is the real Codex at `real` (an absolute
 * path), arguments untouched: the version line alone is stood in for, for
 * a host whose Codex has moved past the version a Given names.
 */
export function writeCodexVersionLine(dir: string, version: string, real: string): void {
  if (process.platform === 'win32') {
    // npm's Codex is a .cmd on Windows, so it is called, not started.
    writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\nif "%~1"=="--version" (\r\necho codex-cli ${version}\r\nexit /b 0\r\n)\r\ncall "${real}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    return
  }
  const q = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  writeFileSync(join(dir, 'codex'), [
    '#!/bin/sh',
    `[ "$1" = "--version" ] && { echo ${q(`codex-cli ${version}`)}; exit 0; }`,
    `exec ${q(real)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
}

/**
 * A `codex` in `dir` that is no stand-in: it hands `--version` and
 * `app-server` to the real Codex at `real` (an absolute path, found further
 * along PATH by the caller), so every answer is Codex's own, and refuses
 * every other subcommand (exit 2, saying so). A doctor run under it reads
 * Codex's version, its account of its hooks and its configuration, and
 * never runs Codex's sandbox or a model. POSIX only.
 */
export function writeCodexPassThrough(dir: string, real: string): void {
  const q = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  writeFileSync(join(dir, 'codex'), [
    '#!/bin/sh',
    'case "$1" in',
    `  --version|app-server) exec ${q(real)} "$@" ;;`,
    '  *) echo "pass-through codex: $1 is not handed to the real Codex here" >&2; exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
}

/** The stand-in app server's case arm and its answer files (writeFakeCodex). */
function appServerCase(dir: string, list: FakeCodexPlan['hooksList'], lockBefore?: FakeCodexPlan['lockBefore']): string[] {
  for (const f of readdirSync(dir)) if (f.startsWith('hooks-list.')) rmSync(join(dir, f), { force: true })
  if (list === undefined) return []
  if (list === 'hang') return ['  app-server) while IFS= read -r l; do :; done; sleep 3600 ;;']
  list.forEach((line, n) => writeFileSync(join(dir, `hooks-list.${n}.json`), `${line}\n`))
  const sq = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  const d = sq(dir)
  return [
    `  app-server) n=$(cat ${d}/hooks-list.count 2>/dev/null || echo 0); echo $((n + 1)) > ${d}/hooks-list.count`,
    ...(lockBefore ? [`              [ "$n" -eq ${lockBefore.answer} ] && chmod a-w ${sq(lockBefore.path)}`] : []),
    `              f=${d}/hooks-list.$n.json; [ -f "$f" ] || { echo "stand-in codex: no hooks/list answer $n" >&2; exit 2; }`,
    '              while IFS= read -r l; do case "$l" in *hooks/list*) cat "$f"; exit 0 ;; esac; done; exit 2 ;;',
  ]
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

// ── A client firing recorded hook events (D400, D401, D402, D409) ──────

/** The recorded sessions: every hook event a real `claude -p` fired, in
 *  order, as the client wrote it (tests/fixtures/claude-code-hooks). */
export const RECORDED_HOOK_EVENTS = join(TS_ROOT, 'tests', 'fixtures', 'claude-code-hooks')

/** Codex CLI's recorded sets (D409): every hook event a real Codex fired,
 *  in order, as it wrote it (tests/fixtures/codex-hooks). */
export const RECORDED_CODEX_EVENTS = join(TS_ROOT, 'tests', 'fixtures', 'codex-hooks')

/** Antigravity CLI's recorded sets (D417): every hook event a real agy
 *  fired, in order, wrapped with the event it ran the hook for and its
 *  transcript's length then (tests/fixtures/agy-hooks/README.md). */
export const RECORDED_AGY_EVENTS = join(TS_ROOT, 'tests', 'fixtures', 'agy-hooks')

/** The clients whose events are recorded, each with its fixture directory. */
export type RecordedClient = 'claude-code' | 'codex' | 'agy'
const RECORDED_DIRS: Readonly<Record<RecordedClient, string>> = { 'claude-code': RECORDED_HOOK_EVENTS, codex: RECORDED_CODEX_EVENTS, agy: RECORDED_AGY_EVENTS }

/** What an agy recording says beside each payload: the event the hook ran
 *  for, the transcript's length then, and where its transcripts are. */
interface AgyMeta { event: string; transcriptLines: number | null; dir: string }
const AGY_META = new WeakMap<object, AgyMeta>()
/** The event agy ran the hook for, as recorded beside a payload. */
export function agyEventOf(e: object): string | null { return AGY_META.get(e)?.event ?? null }
/** The conversation's transcript as recorded, every line, or its first `lines`. */
export function agyTranscriptOf(e: object, lines?: number): string[] {
  const m = AGY_META.get(e)
  if (!m) throw new Error('agyTranscriptOf was handed an event that did not come from an agy recording')
  const p = e as Record<string, unknown>
  const all = readFileSync(join(m.dir, 'transcripts', `${String(p['conversationId'])}.jsonl`), 'utf8').split('\n').filter((l) => l !== '')
  return lines === undefined ? all : all.slice(0, lines)
}
/** The transcript's length when the event fired (null: not yet written). */
export function agyTranscriptLinesOf(e: object): number | null { return AGY_META.get(e)?.transcriptLines ?? null }

/** One recorded session, line by line, each payload exactly as the client
 *  wrote it: Claude Code's by default, Codex CLI's with `'codex'`, each read
 *  from that client's own fixture directory and branded with its client. */
export function recordedSession(version: string, file: string, client: RecordedClient = 'claude-code'): Array<Record<string, unknown>> {
  const dir = join(RECORDED_DIRS[client], version)
  return readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => {
      const raw = JSON.parse(l) as Record<string, unknown>
      if (client !== 'agy') { RECORDED.set(raw, client); return raw }
      // agy's payloads name no event: the line wraps the payload (README).
      const e = raw['payload'] as Record<string, unknown>
      AGY_META.set(e, { event: String(raw['event']), transcriptLines: (raw['transcript_lines'] as number | null) ?? null, dir })
      RECORDED.set(e, client)
      return e
    })
}

/** The events `recordedSession` returned, by identity (module-private),
 *  with the client they were recorded from: a payload built or copied by
 *  hand is not in it, and `replayRecordedSession` refuses it, so a binding
 *  cannot pass a hand-written payload off as the client's. */
const RECORDED = new WeakMap<object, RecordedClient>()
export function isRecordedEvent(e: object): boolean { return RECORDED.has(e) }
/** The client a recorded event came from, or null for a hand-written one. */
export function recordedClientOf(e: object): RecordedClient | null { return RECORDED.get(e) ?? null }

/** What a matcher entry is matched against, per event, as the client's
 *  hooks reference has it: the start's source, the compaction's trigger,
 *  a tool event's tool name; an event with no matcher field matches every
 *  entry. */
function matcherSubject(payload: Record<string, unknown>): string | null {
  switch (payload['hook_event_name']) {
    case 'SessionStart': return typeof payload['source'] === 'string' ? payload['source'] : null
    case 'PreCompact': return typeof payload['trigger'] === 'string' ? payload['trigger'] : null
    case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionRequest':
      return typeof payload['tool_name'] === 'string' ? payload['tool_name'] : null
    case 'SubagentStart': case 'SubagentStop':
      return typeof payload['agent_type'] === 'string' ? payload['agent_type'] : null
    default: return null
  }
}

/**
 * The hook commands the client would run for one event, read from the
 * block install writes for that client (`claudeHooksBlock`, the one
 * definition the settings writer and doctor use, or `codexHooksBlock`, the
 * one install writes into Codex's hooks.json, D406): every command of every
 * matcher entry under the event's name whose matcher matches, in order. An
 * event the block does not name has none.
 */
export function installedCommandsFor(payload: Record<string, unknown>, client: RecordedClient = 'claude-code'): string[] {
  if (client === 'agy') {
    // agy's named hook: the event the recording names; PostToolUse's one
    // group matches every tool (`*`).
    const event = agyEventOf(payload) ?? ''
    return ((agyHooksBlock()[event] ?? []) as Array<{ command?: string; hooks?: Array<{ command: string }> }>)
      .flatMap((h) => h.hooks ? h.hooks.map((x) => x.command) : h.command ? [h.command] : [])
  }
  const block = client === 'codex' ? codexHooksBlock() : claudeHooksBlock()
  const event = String(payload['hook_event_name'] ?? '')
  const subject = matcherSubject(payload)
  const out: string[] = []
  for (const m of block[event] ?? []) {
    const matcher = m.matcher
    const matches = matcher === undefined || matcher === '' || matcher === '*' || subject === null
      || new RegExp(`^(?:${matcher})$`).test(subject)
    if (matches) for (const h of m.hooks) out.push(h.command)
  }
  return out
}

/** The `treecontext hook <event>` an installed command runs: the script the
 *  command names is the one install writes (`hookScriptContent`), whose
 *  last act is `exec node <cli> hook <event>`; read from that body, never
 *  from a table here. Null for a script that dispatches no hook (the
 *  session reminder, which only prints). */
export function hookDispatchOf(command: string): string | null {
  const stem = /tc-([a-z-]+?)(?:\.cmd)?(?=["'\s]|$)/.exec(command)?.[1]
  if (!stem || stem === 'session-reminder') return null
  return /(?:"\$TC_CLI"|"%TC_CLI%") hook (\S+)/.exec(hookScriptContent(stem))?.[1] ?? null
}

/** The arguments an installed command hands its script, which the script
 *  hands on to `treecontext hook <event>` where its body forwards them
 *  (`"$@"`, `%*`; D404: the client the command names): the words after the
 *  script's quoted path, read from the command install wrote. */
export function hookArgsOf(command: string): string[] {
  const stem = /tc-([a-z-]+?)(?:\.cmd)?(?=["'\s]|$)/.exec(command)?.[1]
  if (!stem) return []
  const body = hookScriptContent(stem)
  if (!body.includes('"$@"') && !body.includes('%*')) return []
  const rest = command.replace(/^\s*exec\s+/, '').replace(/^\s*(?:&\s*)?(?:"[^"]*"|\S+)/, '').trim()
  return rest === '' ? [] : rest.split(/\s+/)
}

/** One recorded event as the replay delivered it. */
export interface ReplayedEvent {
  /** Its line in the recorded file, from 0. */
  line: number
  event: string
  /** The payload handed to the hooks (the recorded one, with only the
   *  world's paths and session put in). */
  payload: Record<string, unknown>
  /** The `treecontext hook <event>` dispatches it reached, in order. */
  hooks: string[]
  /** The replay's clock around the hooks it ran (unix seconds). */
  startedAt: number
  endedAt: number
  /** What each hook printed, in order. */
  stdout: string[]
}

/**
 * Claude Code firing a recorded session's hook events (D402): each event,
 * in the order the client fired it, is handed to exactly the commands the
 * block install writes registers for its `hook_event_name`
 * (installedCommandsFor), each run as the installed script runs it: the
 * real CLI's `hook <event>` (under tsx, this build's source), the payload on
 * stdin, one at a time, as the client runs a hook to completion before the
 * next event. An event the block does not register reaches no hook. The
 * only rewrites are what must point at the test's world: `cwd`, the
 * transcript paths (`transcript_path`, `agent_transcript_path`) and, with
 * `sessionId`, the session id; the payload's shape, its tool calls, inputs,
 * responses, errors and ids are the client's.
 */
export function replayRecordedSession(
  w: CaptureWorld, events: Array<Record<string, unknown>>, opts: {
    sessionId?: string; lines?: (line: number, payload: Record<string, unknown>) => boolean
    /** Variables the client's environment hands every hook beside the
     *  sandbox's (a ticketed worker's ticket and lane, D410). */
    env?: Record<string, string>
    /** A directory for `cwd` other than the world's project (a worktree). */
    cwd?: string
    /** agy only: `unreadable` points every transcriptPath at a path that
     *  cannot be read; by default the recorded transcript as it stood. */
    transcript?: 'recorded' | 'unreadable'
  } = {},
): ReplayedEvent[] {
  for (const e of events) {
    if (!RECORDED.has(e)) throw new Error('replayRecordedSession was handed an event that did not come from recordedSession: a payload written or copied by hand is never the client\'s (D402)')
  }
  const env = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'), ...opts.env })
  const out: ReplayedEvent[] = []
  events.forEach((recorded, line) => {
    if (opts.lines && !opts.lines(line, recorded)) return
    const client = RECORDED.get(recorded)!
    const payload: Record<string, unknown> = client === 'agy' ? { ...recorded } : { ...recorded, cwd: opts.cwd ?? w.proj }
    if (client === 'agy') {
      // The workspace is the world's project; the transcript, as it stood
      // when agy fired the event, where transcriptPath points.
      payload['workspacePaths'] = [opts.cwd ?? w.proj]
      const dir = join(w.home!, 'agy-transcripts')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${String(recorded['conversationId'])}.jsonl`)
      const n = agyTranscriptLinesOf(recorded)
      if (opts.transcript === 'unreadable') payload['transcriptPath'] = join(dir, 'unreadable', `${String(recorded['conversationId'])}.jsonl`)
      else {
        if (n === null) rmSync(file, { force: true })
        else writeFileSync(file, agyTranscriptOf(recorded, n).map((l) => `${l}\n`).join(''))
        payload['transcriptPath'] = file
      }
    }
    for (const k of ['transcript_path', 'agent_transcript_path']) {
      if (typeof recorded[k] === 'string') payload[k] = join(w.proj!, basename(String(recorded[k])))
    }
    if (opts.sessionId !== undefined) payload['session_id'] = opts.sessionId
    const hooks: string[] = []
    const stdout: string[] = []
    const startedAt = Date.now() / 1000
    for (const command of installedCommandsFor(client === 'agy' ? recorded : payload, client)) {
      const dispatch = hookDispatchOf(command)
      if (dispatch === null) continue
      const r = spawnSync(process.execPath, nodeTsArgs(CLI_TS, ['hook', dispatch, ...hookArgsOf(command)]), {
        input: JSON.stringify(payload), env, cwd: TS_ROOT, encoding: 'utf8', timeout: 60_000,
      })
      if (r.status !== 0) throw new Error(`hook ${dispatch} for line ${line} (${String(payload['hook_event_name'])}) exited ${r.status}${r.error ? `: ${r.error.message}` : ''}\n${r.stderr ?? ''}`)
      hooks.push(dispatch)
      stdout.push(r.stdout ?? '')
    }
    out.push({ line, event: client === 'agy' ? agyEventOf(recorded)! : String(payload['hook_event_name']), payload, hooks, startedAt, endedAt: Date.now() / 1000, stdout })
  })
  return out
}

// ── The developer trusting Codex's hooks with /hooks (D406, D407) ──────

/** Codex's own account of its hooks under a redirected HOME: the real
 *  Codex on PATH, its app server's `hooks/list` (no model call, no
 *  sign-in), for `cwd`. This is Codex's word, not a stand-in. */
export async function codexHooksSeen(home: string, cwd: string): Promise<CodexListedHook[]> {
  const read = await readCodexHooksTrust(cwd, 20_000, sandboxedSpawnEnv(home, { CODEX_HOME: join(home, '.codex') }))
  if (!read.ok) throw new Error(`Codex's own account of its hooks could not be read: ${read.why}`)
  return read.hooks
}

/**
 * The developer trusting hooks in Codex's `/hooks`: what that screen does,
 * which is write a trust record for each chosen hook into Codex's
 * `config.toml`, `[hooks.state."<key>"]` with `trusted_hash` the hash Codex
 * itself reports for the hook now (recorded on the far-side pass of
 * 2026-11-09). The hash is Codex's, read from its own `hooks/list`; the
 * stand-in computes none. It may trust only hooks Codex lists, and writes
 * nothing else: a record is appended as Codex's own table syntax, the rest
 * of the file left byte for byte. `which` picks the hooks (all by default).
 * Returns the hooks it trusted.
 */
export async function developerTrustsCodexHooks(home: string, cwd: string, which: (h: CodexListedHook) => boolean = () => true): Promise<CodexListedHook[]> {
  const chosen = (await codexHooksSeen(home, cwd)).filter(which)
  const toml = join(home, '.codex', 'config.toml')
  const before = existsSync(toml) ? readFileSync(toml, 'utf8') : ''
  const records = chosen.map((h) => `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`).join('')
  writeFileSync(toml, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${records}`)
  return chosen
}

/**
 * A trust record Codex holds at a hook's place for a hook that was there
 * before (D407's fifth state): the developer trusted a hook of their own at
 * `key`, and that hook has since gone. Written as `/hooks` writes a record,
 * with the hash Codex reported for that earlier hook, which the caller read
 * from Codex's `hooks/list` while the hook was there.
 */
export function staleCodexTrustRecord(home: string, key: string, hash: string): void {
  const toml = join(home, '.codex', 'config.toml')
  const before = existsSync(toml) ? readFileSync(toml, 'utf8') : ''
  writeFileSync(toml, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`)
}
