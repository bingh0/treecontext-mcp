/**
 * The ticket door, its process half (features/journal-workers.feature;
 * rulings D279, D288, D291, D292, D293, D295, D297, D298, D303, D307,
 * D315, D316, D317, D329, D332, D335, D340, D341, D342, D393, D397).
 *
 * Whatever spawns a headless worker through the ticket door is the
 * library call here, spawnWorker, or the `treecontext run` wrapper, which
 * is this same call from a shell (server/cli.ts). The door:
 *  - reads the store first, waiting the raw opener's busy wait, and when
 *    it still cannot read it starts no worker and tells the spawner in
 *    words that nothing was written (D307);
 *  - reads the ticket (ticket.ts); a spawner that asks the door to check
 *    the ticket before spawning gets, for a ticket that cannot be read
 *    whole, one row in its own lane and no worker (D303, D342);
 *  - registers the worker in its own lane under the parent the ticket
 *    names and writes its first moment as the first row of that lane, in
 *    one transaction (FlatStore.startWorker, first-moment.ts);
 *  - launches the command with the ticket in its environment and the
 *    first message on its stdin, and records the process it runs as: its
 *    id, host and the OS start moment and token (D297, D317);
 *  - at exit: an exit by signal, the spawner's timeout among them, is a
 *    cut, retired with no summary row and never sent back (D292), and on
 *    POSIX what is left of the worker's process group is ended with it,
 *    whoever sent the signal (D393); an exit
 *    on its own, whatever its code, retires the worker with its last
 *    output as the summary row the pointer names (D288), unless the one
 *    send-back is owed (sendBackDecision), when the same leg is run once
 *    more in the same lane under the same registration, its second
 *    process beside the first (D291, D335), never a third time; a store
 *    that cannot be written at exit records nothing and sends nothing
 *    back, the output still handed to the spawner whole, and the leg is
 *    left for the next reader on this host to retire as a phantom (D307);
 *  - hands the spawner one line saying how the worker ended and where its
 *    return is (D285: the pointer comes back every time).
 *
 * A worker that claimed a ticket with no wrapper (claimTicket) is
 * registered the same way and gets no send-back: nobody watches its exit,
 * so the next reader retires it as a phantom, visibly without a checkpoint
 * (D291).
 *
 * The store judges nothing (D293): a ticket is read, never checked, and a
 * self-minted one is read like any other.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { FlatStore } from './flat-store.js'
import { openNodeSqlite, DEFAULT_RAW_TIMEOUT_MS } from './persistence/node-sqlite.js'
import { hostProbe, type ProcessProbe } from './persistence/process-probe.js'
import { WORKER_AGENT_ID, legWriterOf, legOwnsKey, capRefusalOf, type LegRef, type LegRegistration, type WorkerProcess } from './persistence/leg-registry.js'
import { gitSelfOf } from './hooks/git-self.js'
import { composeSendBackMessage, owesCheckpoint, failedRunLine, ERROR_STREAM_TAIL_CHARS } from './first-moment.js'
import { CHECKPOINT_CAP_CHARS, charactersOf } from './runs.js'
import { workerEnvironment } from './client-session-env.js'
import {
  TICKET_ENV, WORKER_SESSION_ENV, mintTicket, readTicket, declaresDoor, ticketTextIn,
  type TicketFields, type TicketReading,
} from './ticket.js'

// ── Names ──────────────────────────────────────────────────────────

/** D307: the busy wait the door gives a store before it starts no worker:
 *  the one the raw opener already has. */
export const DOOR_BUSY_WAIT_MS = DEFAULT_RAW_TIMEOUT_MS

/** D307: the wrapper's exit code when it started no worker because the
 *  store could not be read (EX_TEMPFAIL: the spawner retries or gives up). */
export const NOT_STARTED_EXIT = 75

/** D303: the wrapper's exit code when it refused a ticket it checked
 *  before spawning (EX_DATAERR). */
export const TICKET_REFUSED_EXIT = 65

/** The wrapper's exit code when the command could not be started at all. */
export const SPAWN_FAILED_EXIT = 127

/** D292: how long a worker the spawner's timeout signalled gets to exit
 *  before it is killed outright. */
export const TIMEOUT_GRACE_MS = 5000

/** Every line the door hands its spawner starts so. */
export const DOOR_LINE_PREFIX = 'treecontext:'

// ── The send-back decision (D279, D291, D292, D295, D316, D340, D341) ──

export interface SendBackInput {
  /** How the run ended: its exit code on its own, or the signal. */
  exit: { code: number | null; signal: string | null }
  /** The ticket was read whole (D303). */
  ticketValid: boolean
  /** The ticket declared a one-off worker with no key (D341). */
  noKey: boolean
  /** The worker's role, and who its ticket names to checkpoint the key. */
  role: string | null
  checkpointer: string | null
  /** What the ticket declared about a way to write (D340: null is one). */
  canWrite: boolean | null
  /** Send-backs the leg already had, by either door (D295). */
  sendBacks: number
  /** A checkpoint under the key newer than the leg's start, by anyone. */
  checkpointSinceStart: boolean
  /** The store could be read and written at the exit (D279, D307). */
  storeWritable: boolean
  /** D299: the leg's checkpoint under its key was refused at the cap once;
   *  a refusal is no checkpoint, so it changes nothing of the decision but
   *  the words that give it. */
  capRefused?: { size: number } | null
  /** The door itself signalled the worker (its timeout, the spawner's
   *  abort): a cut whatever the exit code, a worker that traps the signal
   *  and exits with a code of its own included (D292). */
  doorSignalled?: boolean
}

export interface SendBackVerdict {
  sendBack: boolean
  /** How the leg is recorded as having ended when it is not sent back. */
  ending: 'retired' | 'cut' | 'invalid'
  /** Why, in words, for the line the spawner is handed. */
  why: string
}

/**
 * Whether a run that just ended earns the leg its one send-back. Only an
 * exit on its own, whatever its code, of a run the door never signalled
 * (D292: a worker that traps the door's signal and exits with a code is
 * still cut), of a worker whose ticket was
 * read whole, names a key and names the worker itself as the one who will
 * checkpoint it (D281, D291), and declares a way to write or says nothing
 * about it (D316, D340), with no checkpoint under the key newer than its
 * start, never sent back before by either door (D279, D295), and only
 * while the store can be written (D279, D307).
 */
export function sendBackDecision(i: SendBackInput): SendBackVerdict {
  if (i.exit.signal === null && i.doorSignalled === true) {
    return { sendBack: false, ending: 'cut', why: `the door signalled it and it exited with code ${i.exit.code ?? 0}, a cut, which is never sent back` }
  }
  if (i.exit.signal !== null) return { sendBack: false, ending: 'cut', why: `it was ended by ${i.exit.signal}, a cut, which is never sent back` }
  if (!i.ticketValid) return { sendBack: false, ending: 'invalid', why: 'its ticket could not be read whole, so it had no valid instructions' }
  if (i.noKey) return { sendBack: false, ending: 'retired', why: 'its ticket says it has no key, so it owed no checkpoint' }
  if (i.checkpointSinceStart) return { sendBack: false, ending: 'retired', why: 'a checkpoint under its key is newer than its start' }
  if (i.checkpointer === null || i.checkpointer !== i.role) {
    return { sendBack: false, ending: 'retired', why: i.checkpointer === null ? 'its ticket names nobody to checkpoint its key' : `its ticket names "${i.checkpointer}" to checkpoint its key` }
  }
  if (!declaresDoor({ canWrite: i.canWrite })) return { sendBack: false, ending: 'retired', why: 'its ticket declares it has no way to write to the store' }
  if (i.sendBacks >= 1) return { sendBack: false, ending: 'retired', why: 'it was already sent back once, and never is twice' }
  if (!i.storeWritable) return { sendBack: false, ending: 'retired', why: 'the store could not be written' }
  return {
    sendBack: true, ending: 'retired',
    why: 'it exited with no checkpoint under its key newer than its start'
      + (i.capRefused ? `, its one of ${i.capRefused.size} characters having been refused at the ${CHECKPOINT_CAP_CHARS}-character cap` : ''),
  }
}

// ── Spawning ───────────────────────────────────────────────────────

export interface SpawnWorkerOptions {
  /** The store: an open FlatStore, or the store file's path, opened with
   *  the door's busy wait (D307) and closed when the worker is done. */
  store: FlatStore | string
  /** The ticket its spawner declared: its text as it would sit in the
   *  environment, or the fields to mint it from (mintTicket). */
  ticket: string | TicketFields
  /** The spawner's prompt as written; empty is a prompt (D298). */
  prompt?: string
  /** The worker's command and its arguments (`claude -p`, `codex exec`,
   *  `agy -p`, or anything else). */
  command: string
  args?: string[]
  cwd?: string
  /** The environment the worker inherits (default this process's); the
   *  door leaves out the spawner's client-session variables (D389,
   *  client-session-env.ts) and adds the ticket and the worker's lane. */
  env?: NodeJS.ProcessEnv
  /** How the first message reaches the worker: on its stdin (the default,
   *  which `claude -p` and `codex exec` read their prompt from when none
   *  is in their arguments), or as its last argument. */
  deliver?: 'stdin' | 'argv'
  /** The spawner's timeout: past it the worker is signalled, and an exit
   *  by signal is a cut (D292). */
  timeoutMs?: number
  /** D303: check the ticket before spawning; one that cannot be read
   *  whole is refused with a row in the spawner's lane, nothing spawned. */
  checkTicket?: boolean
  /** The spawner, for the row a refused ticket leaves in its lane. */
  spawner?: { sessionId?: string | null; role?: string | null }
  /** Each chunk of the worker's stdout as it arrives (the wrapper passes
   *  it through); all of it is in the result either way. */
  onStdout?: (chunk: Buffer) => void
  /** Each chunk of the worker's stderr as it arrives, as the worker wrote
   *  it (the wrapper passes it through); without it, the chunks go to this
   *  process's stderr. The door keeps the stream's end either way (D384).
   *  Chunks go on arriving after the run settled, for as long as something
   *  the worker started still writes there and this process lives (D397). */
  onStderr?: (chunk: Buffer) => void
  /** The worker's stderr handed to the spawner (default), or not handed
   *  on at all. The door reads it in both cases. */
  stderr?: 'inherit' | 'ignore'
  /** Aborted, the worker is signalled (SIGTERM): the wrapper passes a
   *  signal it receives on to its worker, whose exit by signal is a cut
   *  (D292), and no re-run follows. */
  signal?: AbortSignal
  /** This host's process reader (D297, D317). */
  probe?: ProcessProbe
  /** The door's clock, unix seconds: the moments it records. */
  clock?: () => number
}

/** One process the worker ran as, and what it was given and printed. */
export interface WorkerRunRecord {
  pid: number | null
  start: number | null
  token: string | null
  exit: { code: number | null; signal: string | null }
  /** The door signalled this run (its timeout, the spawner's abort): its
   *  end is a cut whatever its exit code (D292). */
  doorSignalled: boolean
  /** The whole of the worker's input from the door: its stdin and argv. */
  input: { stdin: string | null; argv: string[] }
  /** What it printed on stdout, whole. */
  output: string
  /** D384: the end of what it wrote to stderr (at most
   *  ERROR_STREAM_TAIL_CHARS characters), and how many characters it
   *  wrote in all. The rest of the stream was handed on, never kept. */
  errorTail: string
  errorChars: number
  spawnError?: string
}

export type WorkerEnding = 'retired' | 'cut' | 'invalid' | 'unrecorded' | 'not-started' | 'refused'

export interface WorkerRunResult {
  /** A worker process was started. */
  started: boolean
  /** How the store recorded the worker's end: `unrecorded` when the store
   *  could not be written at its exit (D307); `not-started` and `refused`
   *  when no worker was started. */
  ended: WorkerEnding
  /** The worker's lane: its session. */
  sessionId: string | null
  leg: LegRef | null
  ticket: TicketReading | null
  /** The first message the worker was given. */
  firstMessage: string | null
  firstMomentId: string | null
  /** Each process the worker ran as, the first run first. */
  runs: WorkerRunRecord[]
  /** Whether the leg was sent back once. */
  sentBack: boolean
  sendBackId: string | null
  summaryId: string | null
  /** The refused ticket's row in the spawner's lane (D303). */
  refusedId: string | null
  /** The last run's stdout, whole (D307: never lost from the spawner). */
  output: string
  /** The one line the spawner is handed. */
  line: string
  /** The wrapper's exit code: the last run's own, 128 plus the signal's
   *  number for a signal, or the door's own codes when nothing ran. */
  exitCode: number
}

function signalNumber(sig: string | null): number {
  if (sig === null) return 0
  const n = (osConstants.signals as Record<string, number | undefined>)[sig]
  return typeof n === 'number' ? n : 1
}

/** Open a store file as the door does: the raw opener's busy wait, and
 *  no retention sweep from here (the project's server sweeps by its own
 *  [retention] figures; a door process has none). */
export async function openDoorStore(path: string, opts: { timeoutMs?: number; namespace?: string } = {}): Promise<FlatStore> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return FlatStore.open({
    database: openNodeSqlite(path, { timeoutMs: opts.timeoutMs ?? DOOR_BUSY_WAIT_MS }),
    ownsDatabase: true,
    migrate: true,
    retentionInterval: Number.MAX_SAFE_INTEGER,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
  })
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface Launched { record: WorkerRunRecord; done: Promise<void> }

/** D292: how long the door keeps reading a worker's stdout after its
 *  process exited, for output still in the pipe; a grandchild that holds
 *  the pipe open past this never keeps the spawner waiting. */
export const STDOUT_DRAIN_MS = 2000

/** The worker runs as the leader of its own process group (POSIX), so a
 *  signal the door sends reaches every process the worker started, never
 *  only the direct child (D292: the spawner's timeout is a cut, of all of
 *  it). Windows has no process groups: the direct child alone (D393). */
const GROUPS = process.platform !== 'win32'

/** D393: how long what is left of a worker's group, once the worker
 *  ended by a signal, gets between the door's SIGTERM to the group and its
 *  SIGKILL. The run settles only after it, so a spawner that exits when its
 *  run settles (the wrapper) never leaves the group's end undone. */
export const GROUP_GRACE_MS = 1000

function signalWorker(child: ReturnType<typeof spawn>, sig: NodeJS.Signals): void {
  try {
    if (GROUPS && child.pid !== undefined) process.kill(-child.pid, sig)
    else child.kill(sig)
  } catch { /* gone */ }
}

/** Whether any process is still in the group (a zombie awaiting its
 *  reaper counts: macOS answers EPERM for one, not ESRCH). */
function groupHasMembers(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/**
 * D393: the end of what is left of a worker's process group once the
 * worker itself ended by a signal, whoever sent it (the door at its
 * timeout or the spawner's abort, the harness, the system). The leader is
 * reaped, so the group is signalled by its number, and only while that
 * number can be no one else's (reapedGroupIsOurs), checked before each
 * signal: SIGTERM, then SIGKILL once the grace is out if a member is still
 * there. Not reached: a process that left the group (`setsid`, a detached
 * spawn), and on Windows anything but the direct child (D394).
 */
async function endGroup(pgid: number, probe: ProcessProbe, graceMs = GROUP_GRACE_MS): Promise<void> {
  if (!reapedGroupIsOurs(pgid, probe)) return
  try { process.kill(-pgid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
    if (!groupHasMembers(pgid)) return
  }
  if (reapedGroupIsOurs(pgid, probe)) { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } }
}

/**
 * Whether the group a reaped leader led may still be signalled by its
 * number. Once the leader is reaped its number is free, except that the
 * operating system (Linux, macOS, the BSDs) gives out no number that is
 * still the id of a live group or session. So while a member of the
 * worker's group lives, the number is pinned to that group and no other
 * process can hold it. A process found holding the number now is one that
 * reused it after every member of the group was gone: nothing of the
 * worker is left to signal, and a signal by that number would reach a
 * stranger. The door signals only when no process holds the number; a
 * host that cannot say (null) is not signalled either.
 */
export function reapedGroupIsOurs(pid: number | undefined, probe: ProcessProbe): boolean {
  if (!GROUPS || pid === undefined) return false
  return probe.exists(pid) === false
}

/**
 * D384: the end of a stream as it passes, at most `chars` characters
 * (code points), and how many characters went by in all. It holds a few
 * times `chars` at most, so the whole stream is never kept.
 */
export class StreamTail {
  private readonly decoder = new StringDecoder('utf8')
  private kept = ''
  /** Characters seen in all. */
  total = 0
  constructor(private readonly chars: number) {}
  push(chunk: Buffer): void { this.add(this.decoder.write(chunk)) }
  end(): void { this.add(this.decoder.end()) }
  /** The last `chars` characters seen. */
  text(): string { return lastCharacters(this.kept, this.chars) }
  private add(text: string): void {
    if (text === '') return
    this.total += charactersOf(text)
    this.kept += text
    if (this.kept.length > this.chars * 8) this.kept = lastCharacters(this.kept, this.chars)
  }
}

/** The last `n` characters (code points) of a text, a surrogate pair never
 *  split. */
function lastCharacters(text: string, n: number): string {
  let i = text.length
  for (let count = 0; i > 0 && count < n; count++) {
    i--
    const c = text.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const h = text.charCodeAt(i - 1)
      if (h >= 0xd800 && h <= 0xdbff) i--
    }
  }
  return text.slice(i)
}

function launch(o: SpawnWorkerOptions, message: string, env: NodeJS.ProcessEnv, probe: ProcessProbe): Launched {
  const deliver = o.deliver ?? 'stdin'
  const argv = deliver === 'argv' ? [...(o.args ?? []), message] : [...(o.args ?? [])]
  const record: WorkerRunRecord = {
    pid: null, start: null, token: null, exit: { code: null, signal: null }, doorSignalled: false,
    input: { stdin: deliver === 'stdin' ? message : null, argv }, output: '', errorTail: '', errorChars: 0,
  }
  const done = new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(o.command, argv, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: GROUPS })
    } catch (err) {
      record.spawnError = errText(err)
      resolve()
      return
    }
    const chunks: Buffer[] = []
    // D384: the error stream is handed on as the worker writes it (D307),
    // and only its end is kept, for the summary row.
    const tail = new StreamTail(ERROR_STREAM_TAIL_CHARS)
    const handOn = o.stderr === 'ignore' ? null : (o.onStderr ?? ((c: Buffer): void => { process.stderr.write(c) }))
    let timer: NodeJS.Timeout | null = null
    let killer: NodeJS.Timeout | null = null
    let signalled = false
    let settled = false
    let drain: NodeJS.Timeout | null = null
    // D393: the end of the worker's group, when it ended by a signal; the
    // run settles only once that is done.
    let groupEnd: Promise<void> = Promise.resolve()
    const settle = (): void => {
      if (drain) clearTimeout(drain)
      if (settled) return
      settled = true
      record.output = Buffer.concat(chunks).toString('utf8')
      tail.end()
      record.errorTail = tail.text()
      record.errorChars = tail.total
      try { child.stdout!.destroy() } catch { /* closed */ }
      // D397: the error stream is not closed at the settle. Whatever still
      // holds it (a background process the worker started) goes on being
      // handed on as it writes, so it is not sent SIGPIPE while this
      // process lives; unref'd, the stream keeps no process alive, so a
      // spawner that exits when its run settles (the wrapper) is the limit.
      try { (child.stderr as unknown as { unref?: () => void }).unref?.() } catch { /* closed */ }
      void groupEnd.then(() => resolve())
    }
    child.on('error', (err) => {
      if (record.pid === null) { record.spawnError = errText(err); settled = true; resolve() }
    })
    if (child.pid !== undefined) record.pid = child.pid
    child.stdout!.on('data', (c: Buffer) => { chunks.push(c); o.onStdout?.(c) })
    child.stderr!.on('data', (c: Buffer) => { if (!settled) tail.push(c); handOn?.(c) })
    child.stderr!.on('error', () => { /* the stream ended on the worker's side */ })
    child.stdin!.on('error', () => { /* a worker that never reads its stdin closes it early */ })
    child.stdin!.end(deliver === 'stdin' ? message : '')
    const cut = (): void => {
      signalled = true
      signalWorker(child, 'SIGTERM')
      killer = setTimeout(() => signalWorker(child, 'SIGKILL'), TIMEOUT_GRACE_MS)
    }
    if (o.timeoutMs !== undefined && o.timeoutMs > 0) timer = setTimeout(cut, o.timeoutMs)
    const onAbort = (): void => { if (!signalled) cut() }
    if (o.signal) {
      if (o.signal.aborted) onAbort()
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.once('close', settle)
    child.once('exit', (code, signal) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      if (killer) clearTimeout(killer)
      record.exit = { code, signal }
      record.doorSignalled = signalled
      // D393: a worker the door signalled, or one ended by any signal,
      // whoever sent it, takes what is left of its process group with it.
      // The leader is reaped by now, so the group is signalled by its
      // number only while that number can be no one else's (endGroup).
      if ((signalled || signal !== null) && child.pid !== undefined) groupEnd = endGroup(child.pid, probe)
      // The output already in the pipe is read; a grandchild still holding
      // the pipe keeps nobody waiting past the drain.
      if (!settled) drain = setTimeout(settle, STDOUT_DRAIN_MS)
    })
  })
  return { record, done }
}

/** The leg's name in the lines the spawner is handed. */
function legName(leg: Pick<LegRegistration, 'role' | 'run' | 'key' | 'sessionId'>): string {
  const keyed = leg.key !== null ? `, key "${leg.key}"` : ''
  return `the ${leg.role ?? 'unnamed'} worker${leg.run ? ` of the run "${leg.run}"` : ''} (session ${leg.sessionId}${keyed})`
}

function exitWords(exit: WorkerRunRecord['exit'], doorSignalled = false): string {
  if (exit.signal !== null) return `was ended by ${exit.signal}`
  return `exited with code ${exit.code ?? 0}${doorSignalled ? ' after the door signalled it' : ''}`
}

/** The line the spawner reads when the store could not be read (D307). */
export function notStartedLine(where: string, err: unknown): string {
  return `${DOOR_LINE_PREFIX} the store ${where} could not be read after waiting ${DOOR_BUSY_WAIT_MS / 1000} s (${errText(err)}); `
    + 'no worker was started and nothing was written.'
}

/** The line the spawner reads when the store was read but refused the
 *  door's own write (the registration, the run's open, the first-moment
 *  row, or a refused ticket's row): the cause is the refusal, never a
 *  wait that did not happen (unit 11's review, 2026-11-01). The
 *  transaction rolled back, so nothing was written (D298, D302, D307). */
export function refusedStartLine(where: string, err: unknown): string {
  return `${DOOR_LINE_PREFIX} the store ${where} refused the worker's start (${errText(err)}); `
    + 'no worker was started and nothing was written.'
}

function empty(o: Partial<WorkerRunResult>): WorkerRunResult {
  return {
    started: false, ended: 'not-started', sessionId: null, leg: null, ticket: null, firstMessage: null, firstMomentId: null,
    runs: [], sentBack: false, sendBackId: null, summaryId: null, refusedId: null, output: '', line: '', exitCode: NOT_STARTED_EXIT, ...o,
  }
}

/**
 * Spawn a headless worker through the ticket door (see the module comment).
 * Resolves when the worker is done, its last process gone, with how the
 * store recorded its end and the one line its spawner is handed.
 */
export async function spawnWorker(o: SpawnWorkerOptions): Promise<WorkerRunResult> {
  const probe = o.probe ?? hostProbe
  const clock = o.clock ?? ((): number => Date.now() / 1000)
  const raw = typeof o.ticket === 'string' ? o.ticket : mintTicket(o.ticket)
  const reading = readTicket(raw)
  const prompt = o.prompt ?? ''
  const where = typeof o.store === 'string' ? `at ${o.store}` : 'this door holds'
  let store: FlatStore
  const owns = typeof o.store === 'string'
  // D307: the store is read before anything is written or started.
  try {
    store = typeof o.store === 'string' ? await openDoorStore(o.store) : o.store
  } catch (err) {
    return empty({ ticket: reading, line: notStartedLine(where, err) })
  }
  try {
    try {
      store.legOf({ sessionId: '', agentId: '' })
    } catch (err) {
      return empty({ ticket: reading, line: notStartedLine(where, err) })
    }
    // D303: the spawner that sees the fault first writes the row itself.
    if (!reading.valid && o.checkTicket) {
      try {
        const r = await store.writeRefusedTicket({ reading, ...(o.spawner ? { spawner: o.spawner } : {}), ...(o.cwd ? { cwd: o.cwd } : {}), at: clock() })
        return empty({
          ended: 'refused', ticket: reading, refusedId: r.nodeId, exitCode: TICKET_REFUSED_EXIT,
          line: `${DOOR_LINE_PREFIX} the ticket could not be read whole (unreadable: ${reading.absent.join(', ')}); `
            + `no worker was started, and the row ${r.nodeId}, by its spawner, says so, with the raw ticket text.`,
        })
      } catch (err) {
        return empty({ ticket: reading, line: refusedStartLine(where, err) })
      }
    }
    const cwd = o.cwd ?? process.cwd()
    let started: ReturnType<FlatStore['startWorker']>
    try {
      started = store.startWorker({ reading, prompt, where: gitSelfOf(cwd), host: probe.host(), at: clock(), probe })
    } catch (err) {
      return empty({ ticket: reading, line: refusedStartLine(where, err) })
    }
    const ref: LegRef = { sessionId: started.leg.sessionId, agentId: WORKER_AGENT_ID }
    // D389: none of the spawner's client-session variables, whether the
    // spawner passed its environment or the worker inherits this process's.
    const env = workerEnvironment(o.env ?? process.env, { [TICKET_ENV]: raw, [WORKER_SESSION_ENV]: ref.sessionId })
    const result: WorkerRunResult = empty({
      started: true, ended: 'retired', sessionId: ref.sessionId, leg: ref, ticket: reading,
      firstMessage: started.firstMessage, firstMomentId: started.firstMomentId, exitCode: 0,
    })
    const notes: string[] = []
    const recordProcess = (pid: number): void => {
      const proc: WorkerProcess = { pid, start: probe.startMoment(pid), token: probe.startToken?.(pid) ?? null, host: probe.host(), at: clock() }
      const rec = result.runs.at(-1)
      if (rec) { rec.start = proc.start; rec.token = proc.token ?? null }
      try { store.recordWorkerRerun(ref, proc, { rerun: result.runs.length > 1 }) } catch (err) { notes.push(`its process ${pid} could not be recorded (${errText(err)})`) }
    }
    let message = started.firstMessage
    const t = reading.ticket
    for (;;) {
      const run = launch(o, message, env, probe)
      result.runs.push(run.record)
      // D297, D317, D335: the process it runs as, read while it exists.
      if (run.record.pid !== null) recordProcess(run.record.pid)
      await run.done
      const rec = run.record
      result.output = rec.output
      if (rec.spawnError !== undefined) {
        // Nothing ran: the leg ends as cut, never sent back, and the next
        // leg of its role recovers from the store as from any cut.
        try { await store.retireWorker(ref, { output: '', how: 'cut', summary: false, at: clock() }); result.ended = 'cut' } catch { result.ended = 'unrecorded' }
        result.exitCode = SPAWN_FAILED_EXIT
        result.line = `${DOOR_LINE_PREFIX} ${legName(started.leg)} could not be started (${rec.spawnError}); it is recorded as cut.`
        return result
      }
      result.exitCode = rec.exit.signal !== null ? 128 + signalNumber(rec.exit.signal) : (rec.exit.code ?? 0)
      // What the store says now, at the exit: the leg, and any checkpoint
      // under its key newer than its start (D291), read before deciding.
      let leg: LegRegistration | null = null
      let checkpointSinceStart = false
      let readable = true
      try {
        leg = store.legOf(ref)
        if (leg && leg.run !== null && leg.key !== null) {
          const since = leg.startedAt
          checkpointSinceStart = store.checkpointsUnder(leg.run, leg.key).some((c) => !c.imported && c.createdAt >= since)
        }
      } catch { readable = false }
      const verdict = sendBackDecision({
        // D281: who is named to checkpoint is the registration's word (the
        // ticket's, else the brief's), never the ticket's alone.
        exit: rec.exit, doorSignalled: rec.doorSignalled, ticketValid: reading.valid, noKey: t.noKey === true, role: leg?.role ?? t.role, checkpointer: leg?.checkpointer ?? null,
        canWrite: t.canWrite ?? null, sendBacks: leg?.sendBacks ?? 0, checkpointSinceStart, storeWritable: readable,
        ...(leg ? { capRefused: capRefusalOf(leg) } : {}),
      })
      if (verdict.sendBack && leg !== null) {
        let sent: ReturnType<FlatStore['recordWorkerSendBack']> = null
        let next = ''
        try {
          // D298, D332: the re-run's message carries the first moment again,
          // composed from the store as it now stands, so it needs no query.
          const facts = store.firstMomentFacts({
            run: leg.run!, key: leg.key, role: leg.role ?? t.role!, checkpointer: leg.checkpointer, checkpointedBy: leg.checkpointedBy, self: ref,
          })
          next = composeSendBackMessage({
            facts, prompt, sessionId: ref.sessionId, firstMomentId: started.firstMomentId, rows: store.laneRowsOf(leg), capRefused: capRefusalOf(leg),
          })
          const inEffect = facts.checkpoints
          sent = store.recordWorkerSendBack(ref, {
            message: next,
            refs: [...(started.firstMomentId ? [started.firstMomentId] : []), ...inEffect.map((c) => c.nodeId)], at: clock(),
          })
        } catch { readable = false }
        if (sent && o.signal?.aborted) {
          // The spawner was ended between the runs: the re-run it owed
          // never starts, and the leg is cut like any interrupted one.
          try { await store.retireWorker(ref, { output: '', how: 'cut', summary: false, at: clock() }); result.ended = 'cut' } catch { result.ended = 'unrecorded' }
          result.sentBack = true
          result.sendBackId = sent.sendBackId
          result.line = `${DOOR_LINE_PREFIX} ${legName(started.leg)} was owed its one send-back, but its spawner was ended first; it is recorded as cut.`
          return result
        }
        if (sent) {
          result.sentBack = true
          result.sendBackId = sent.sendBackId
          message = next
          continue
        }
        // Not sent: the store could not take it (below), or the other door
        // spent the leg's one send-back first (D295), when the leg is
        // retired as any finished leg is.
      }
      if (!readable) {
        // D307: the exit could not be recorded; the spawner still has the
        // output whole, and the leg stays registered for the phantom pass.
        result.ended = 'unrecorded'
        result.line = `${DOOR_LINE_PREFIX} the store could not be written when ${legName(started.leg)} ${exitWords(rec.exit, rec.doorSignalled)}, `
          + 'so nothing of its exit was recorded and it was not sent back; its output is handed to you whole, '
          + 'and its registration stays live until the next reader of the registry on this host retires it as a phantom.'
        return result
      }
      const how = verdict.ending
      try {
        if (how === 'cut') {
          await store.retireWorker(ref, { output: '', how: 'cut', summary: false, at: clock() })
        } else {
          const r = await store.retireWorker(ref, { output: summaryOf(rec), how, summary: true, at: clock() })
          result.summaryId = r.summaryId
        }
        result.ended = how
      } catch (err) {
        result.ended = 'unrecorded'
        result.line = `${DOOR_LINE_PREFIX} the store could not be written when ${legName(started.leg)} ${exitWords(rec.exit, rec.doorSignalled)} (${errText(err)}), `
          + 'so nothing of its exit was recorded; its output is handed to you whole, '
          + 'and its registration stays live until the next reader of the registry on this host retires it as a phantom.'
        return result
      }
      result.line = exitLine(store, started.leg, rec.exit, how, verdict, result, reading)
      if (notes.length > 0) result.line += ` (${notes.join('; ')})`
      return result
    }
  } finally {
    if (owns) await store!.close()
  }
}

/**
 * D288, D384: a worker's summary row, from its last run. A run that exited
 * with code 0 after printing something leaves its output alone. A run that
 * exited with another code, or printed nothing, leaves its output, if any,
 * then treecontext's line naming the exit code and the end of its error
 * stream.
 */
export function summaryOf(rec: Pick<WorkerRunRecord, 'output' | 'exit' | 'errorTail' | 'errorChars'>): string {
  const output = rec.output.replace(/\s+$/, '')
  const code = rec.exit.code ?? 0
  if (code === 0 && output !== '') return output
  const line = failedRunLine({ code, printedNothing: output === '', tail: rec.errorTail, total: rec.errorChars })
  return output === '' ? line : `${output}\n\n${line}`
}

/** D285, D288, D292, D303, D316: the one line the spawner is handed at
 *  the worker's exit: how it ended, and the pointer to its return. */
function exitLine(
  store: FlatStore, leg: LegRegistration, exit: WorkerRunRecord['exit'], how: 'retired' | 'cut' | 'invalid',
  verdict: SendBackVerdict, result: WorkerRunResult, reading: TicketReading,
): string {
  const name = legName(leg)
  const after = result.sentBack ? ' after its one send-back' : ''
  if (how === 'cut') {
    return `${DOOR_LINE_PREFIX} ${name} ${exitWords(exit, result.runs.at(-1)?.doorSignalled)}: a cut, so it is not sent back and left no summary row; `
      + `the next ${leg.role ?? 'unnamed'} leg${leg.key ? ` under "${leg.key}"` : ''} starts as a recovery leg.`
  }
  const writer = legWriterOf(leg)
  const now = store.legOf({ sessionId: leg.sessionId, agentId: WORKER_AGENT_ID })
  const pointer = result.summaryId
    ? `its return is the summary row ${result.summaryId} (writer "${writer}"${now?.run ? `, run "${now.run}"` : ''}`
      + `${now?.key && legOwnsKey(now) ? `, key "${now.key}"` : ''})`
    : 'it left no summary row'
  if (how === 'invalid') {
    return `${DOOR_LINE_PREFIX} ${name} ${exitWords(exit)} and ended with invalid instructions: its ticket could not be read whole `
      + `(unreadable: ${reading.absent.join(', ')}); ${pointer}.`
  }
  let without = ''
  if (now && now.run !== null && now.key !== null && !reading.ticket.noKey) {
    const since = now.startedAt
    const any = store.checkpointsUnder(now.run, now.key).some((c) => !c.imported && c.createdAt >= since)
    if (!any) {
      without = ` It ended without a checkpoint under "${now.key}" (${verdict.why})`
        + (owesCheckpoint(now) ? `, so the next ${leg.role ?? 'unnamed'} leg under "${now.key}" starts as a recovery leg.` : '.')
    }
  }
  return `${DOOR_LINE_PREFIX} ${name} ${exitWords(exit)}${after} and is retired; ${pointer}.${without}`
}

// ── A ticket claimed with no wrapper (D291, D293) ──────────────────

export interface ClaimedTicket {
  /** A worker was registered by this call; false when the door that
   *  started this process had registered it already. */
  claimed: boolean
  reading: TicketReading | null
  /** The leg to write as: the worker's own lane, through the ticket door. */
  leg: (LegRef & { door: 'ticket' }) | null
  registration: LegRegistration | null
  /** The first message this call composed, when it registered the worker. */
  firstMessage: string | null
  firstMomentId: string | null
}

/**
 * The ticket door for a process that holds a ticket in its own
 * environment and no wrapper (D291, D293): a worker that claims it, or a
 * process that minted one for itself, read like any other. When the door
 * that started this process registered it already (its lane is named in
 * the environment), that registration is returned and nothing is written;
 * otherwise the process is registered in its own lane as the ticket door
 * registers any worker, with its first moment, and its own process
 * recorded. Nobody watches its exit: it is never sent back, and the next
 * reader of the registry on its host retires it as a phantom (D297).
 */
export async function claimTicket(o: {
  store: FlatStore
  env?: NodeJS.ProcessEnv
  prompt?: string
  /** The process to register; this one by default. */
  pid?: number
  cwd?: string
  probe?: ProcessProbe
  at?: number
}): Promise<ClaimedTicket> {
  const env = o.env ?? process.env
  const probe = o.probe ?? hostProbe
  // The lane the environment names is honoured only for the worker its
  // ticket describes (trustedWorkerLane); anything else reads its ticket
  // as its own (D293).
  const lane = o.store.trustedWorkerLane(env)
  if (lane !== null) {
    const leg = o.store.legOf({ sessionId: lane, agentId: WORKER_AGENT_ID })!
    return { claimed: false, reading: null, leg: { sessionId: lane, agentId: WORKER_AGENT_ID, door: 'ticket' }, registration: leg, firstMessage: null, firstMomentId: null }
  }
  const raw = ticketTextIn(env)
  if (raw === null) return { claimed: false, reading: null, leg: null, registration: null, firstMessage: null, firstMomentId: null }
  const reading = readTicket(raw)
  const at = o.at ?? Date.now() / 1000
  const started = o.store.startWorker({
    reading, prompt: o.prompt ?? '', where: gitSelfOf(o.cwd ?? process.cwd()), host: probe.host(), at, probe,
  })
  const ref = { sessionId: started.leg.sessionId, agentId: WORKER_AGENT_ID }
  const pid = o.pid ?? process.pid
  const registration = o.store.recordWorkerRerun(ref, { pid, start: probe.startMoment(pid), token: probe.startToken?.(pid) ?? null, host: probe.host(), at })
  return { claimed: true, reading, leg: { ...ref, door: 'ticket' }, registration, firstMessage: started.firstMessage, firstMomentId: started.firstMomentId }
}
