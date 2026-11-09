/**
 * Legs and workers in the session registry (features/journal-legs.feature,
 * journal-workers.feature, journal-runs.feature; rulings D279, D281, D288,
 * D291, D293, D294, D297, D305, D311, D317, D320, D326, D329, D335).
 *
 * A LEG is a unit of work under a run and a key. Two doors register one:
 *  - the hooks door: a Claude Code subagent (session-registry.ts already
 *    registers it at SubagentStart under its parent's session id and its
 *    own agent id); the leg's facts are columns on that same row, kind
 *    `subagent`. A subagent with no run or key stays exactly as today
 *    (D305): its leg columns stay null.
 *  - the ticket door: a headless WORKER (`claude -p`, `codex exec`,
 *    `agy -p`) with a ticket its spawner declared (D288). It is registered
 *    in its own lane: the row's session id is the worker's own session,
 *    its agent id is WORKER_AGENT_ID, kind `worker`. A worker is never a
 *    self (D295): selfOf never reads it and the session-start retirement
 *    of live subagents never touches it.
 *
 * Every column here is additive (migration 031) and nullable; a store the
 * ladder has not reached reads as having no legs (hasLegColumns), and a
 * hook meeting it skips what it cannot write (the JF-8 pattern of 027).
 *
 * Nothing here judges (D293): a registration says which door registered
 * it, whether its identity was registered by a hook or declared, and what
 * the ticket declared about its parent; readers decide. Nothing here
 * guesses a moment (D297): a worker found gone is retired as a phantom
 * with the moment it was NOTICED and by whom, never an exit time.
 */
import { randomUUID } from 'node:crypto'
import type { RegistryHandle, GitSelf } from './session-registry.js'
import { hasRegistry, selfOf, agentWriterOf } from './session-registry.js'
import { hostProbe, sameProcessStart, type ProcessProbe } from './process-probe.js'
import { RUN_META_KEY, KEY_META_KEY } from '../run-kinds.js'

// ── Names ──────────────────────────────────────────────────────────

/** The agent id of a worker's own registration row: a worker is its
 *  session's lane, never a self (agent id '') and never one of a
 *  session's subagents (D288, D295). */
export const WORKER_AGENT_ID = 'worker'

/** `kind` of a registration: a hooks-door subagent leg, or a worker. A
 *  self or a keyless subagent registered before or without a leg keeps
 *  `kind` null (D305: exactly as today). */
export type LegKind = 'subagent' | 'worker'

/** Which door registered the leg (D293): the hooks, the ticket door, or a
 *  library call the spawner made itself. */
export type LegDoor = 'hooks' | 'ticket' | 'library'

/** Whether the leg's identity was registered by a hook or declared by the
 *  writer (D293). */
export type LegIdentity = 'hook' | 'declared'

/** Where a leg's run and key came from (D320, D326): declared (a ticket
 *  or a library call named them), inferred (the hooks door read the
 *  role's newest brief), ambiguous (more than one brief was in effect;
 *  the candidates are kept), or own (the leg's first write under a key
 *  settled it). */
export type KeySource = 'declared' | 'inferred' | 'ambiguous' | 'own'

/** How a leg ended (D279, D292, D297, D303): retired at exit, cut (killed
 *  or interrupted, never sent back), retired as a phantom (gone, noticed
 *  by a reader), or ended with no valid instructions. */
export type LegEnding = 'retired' | 'cut' | 'phantom' | 'invalid'

/** Who noticed a phantom (D297): the readers of the registry. */
export const NOTICED_BY_LOOKUP = 'lookup'
export const NOTICED_BY_STATUS = 'status call'
export const NOTICED_BY_SESSION_START = 'session-start hook'
/** The ticket door is a reader of the registry too (D297): before it
 *  composes a worker's first moment it retires the run's gone workers on
 *  its host, so a predecessor nobody retired is known gone, and the new
 *  worker starts as its recovery leg (D279, D291). */
export const NOTICED_BY_TICKET_DOOR = 'ticket door'

/** The registry columns migration 031 adds, in one spelling for the
 *  migration and for hasLegColumns. */
export const LEG_REGISTRY_COLUMNS: Array<[name: string, decl: string]> = [
  ['kind', 'TEXT'],
  ['door', 'TEXT'],
  ['identity', 'TEXT'],
  ['run', 'TEXT'],
  ['run_key', 'TEXT'],
  ['key_src', 'TEXT'],
  ['key_candidates', 'TEXT'],
  ['brief_id', 'TEXT'],
  ['checkpointer', 'TEXT'],
  ['checkpointed_by', 'TEXT'],
  ['start_checkpoints', 'TEXT'],
  ['parent_session', 'TEXT'],
  ['parent_src', 'TEXT'],
  ['parent_declared', 'TEXT'],
  ['ticket_minted_at', 'REAL'],
  ['ticket_raw', 'TEXT'],
  ['ticket_absent', 'TEXT'],
  ['can_write', 'INTEGER'],
  ['host', 'TEXT'],
  ['pid', 'INTEGER'],
  ['proc_start', 'REAL'],
  // D317: the exact start token where the host has one (Linux: boot id and
  // start ticks), compared before the wall-clock moment, which a clock
  // step can move.
  ['proc_start_token', 'TEXT'],
  ['processes', 'TEXT'],
  ['send_backs', 'INTEGER NOT NULL DEFAULT 0'],
  ['ended', 'TEXT'],
  ['noticed_at', 'REAL'],
  ['noticed_by', 'TEXT'],
  ['opened_runs', 'TEXT'],
  // D299, D321: the run and key under which this writer's over-cap
  // checkpoint was refused once, with the size refused and the moment (a
  // JSON list of CapRefusal), so its second over-cap write under the same
  // key is accepted and marked, and a send-back names the cap. Written by
  // the checkpoint cap (FlatStore.insert) on the registration of the
  // session and agent that wrote, the self's included.
  ['cap_refused', 'TEXT'],
  // D320, D326: what a write that settled the leg's key changed, so an
  // echo that names another writer can put it back (JSON {node_id, key,
  // key_src}).
  ['key_settled_from', 'TEXT'],
  // D295: the client session ids a `claude -p` child's session-start hook
  // linked to this worker registration (a JSON list): the child's own
  // Claude Code session differs from the lane the ticket door registered,
  // and the drain lands the child's captured rows in the lane by this
  // link. Present only on a worker the hook read; its presence is the mark
  // that the ticket door was read by the hook.
  ['client_sessions', 'TEXT'],
]

export const LEG_REGISTRY_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_session_registry_run ON session_registry (run, run_key);'

// ── Types ──────────────────────────────────────────────────────────

/** A leg is named by its registration: (session id, agent id). */
export interface LegRef { sessionId: string; agentId: string }

/** What a ticket declared about the worker's parent (D294). Stored per
 *  worker, marked declared, never reconciled across workers. */
export interface DeclaredParent {
  id: string
  cli?: string | null
  cwd?: string | null
  worktree?: string | null
  branch?: string | null
}

/** One process a worker ran as (D297, D317, D335). */
export interface WorkerProcess {
  pid: number
  /** The OS-reported start moment, unix seconds; null where the host
   *  could not read it. */
  start: number | null
  /** The OS's exact start token, where the host has one (process-probe). */
  token?: string | null
  host: string
  /** When the door recorded it. */
  at: number
}

/** One client session linked to a worker (D295). */
export interface ClientSessionLink {
  id: string
  /** What linked it: the session-start hook that read the ticket. */
  linkedBy: string
  /** When, unix seconds. */
  at: number
}

/** Who links a `claude -p` child's session to its worker (D295). */
export const LINKED_BY_SESSION_START = 'session-start hook'

export interface KeyCandidate { run: string | null; key: string; briefId: string | null }

/** A registration with its leg facts, as every reader sees it. */
export interface LegRegistration {
  sessionId: string
  agentId: string
  /** The role: the subagent's type or the worker's declared role. */
  role: string | null
  kind: LegKind | null
  door: LegDoor | null
  identity: LegIdentity | null
  run: string | null
  key: string | null
  keySrc: KeySource | null
  keyCandidates: KeyCandidate[]
  briefId: string | null
  checkpointer: string | null
  checkpointedBy: string | null
  startCheckpoints: string[]
  parentSession: string | null
  parentSrc: 'hook' | 'declared' | null
  parentDeclared: DeclaredParent | null
  ticketMintedAt: number | null
  ticketRaw: string | null
  ticketAbsent: string[]
  canWrite: boolean | null
  host: string | null
  pid: number | null
  procStart: number | null
  procStartToken: string | null
  processes: WorkerProcess[]
  sendBacks: number
  ended: LegEnding | null
  noticedAt: number | null
  noticedBy: string | null
  openedRuns: string[]
  /** What the write that settled the key changed (D320). */
  keySettledFrom: { node_id: string; key: string | null; key_src: KeySource | null; run?: string | null } | null
  /** The keys under which an over-cap checkpoint of this leg was refused
   *  once (D299, D321), each with the run, the size refused and the moment. */
  capRefused: CapRefusal[]
  /** D295: the client sessions linked to this worker (a `claude -p`
   *  child's own Claude Code session ids), each with what linked it and
   *  when: the mark that the ticket door was read by the hook. */
  clientSessions: ClientSessionLink[]
  worktree: string | null
  branch: string | null
  cwd: string | null
  startedAt: number
  stoppedAt: number | null
}

interface RawLeg {
  session_id: string; agent_id: string; agent_type: string | null; worktree: string | null; branch: string | null
  cwd: string | null; started_at: number; stopped_at: number | null
  kind: string | null; door: string | null; identity: string | null; run: string | null; run_key: string | null
  key_src: string | null; key_candidates: string | null; brief_id: string | null; checkpointer: string | null
  checkpointed_by: string | null; start_checkpoints: string | null; parent_session: string | null
  parent_src: string | null; parent_declared: string | null; ticket_minted_at: number | null; ticket_raw: string | null
  ticket_absent: string | null; can_write: number | null; host: string | null; pid: number | null
  proc_start: number | null; proc_start_token: string | null; processes: string | null; send_backs: number | null; ended: string | null
  noticed_at: number | null; noticed_by: string | null; opened_runs: string | null; cap_refused: string | null
  key_settled_from: string | null; client_sessions?: string | null
}

function json<T>(text: string | null, fallback: T): T {
  if (text === null || text === '') return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}

/** One refusal of the checkpoint cap on record (D299, D321): the run and
 *  key it was refused under, the size refused in characters, and when. */
export interface CapRefusal {
  run: string; key: string; size: number; at: number
  /** D359: the refusal's id, said in the reply and found again in the
   *  call's own staged echo, which names the writer exactly. */
  id?: string
  /** `exact` (the store told the writer), `echo` (the call's echo named it
   *  after), `pending` (the stamp was not exact: the registration it sits
   *  on is a guess, `candidates` the writers it might be). Absent: exact. */
  src?: 'exact' | 'echo' | 'pending'
  candidates?: CapCandidate[]
}

/** A writer a non-exact stamp might name (the stamp's own candidate list;
 *  agent id '' is the session's own agent). */
export interface CapCandidate { agent_id: string; agent_type: string | null }

/** Whether a refusal on record is the writer's own and certain. */
export const isConfirmedRefusal = (e: CapRefusal): boolean => e.src !== 'pending'

function capRefusalsIn(text: string | null): CapRefusal[] {
  return json<unknown[]>(text, []).filter((e): e is CapRefusal => {
    if (e === null || typeof e !== 'object') return false
    const o = e as Record<string, unknown>
    return typeof o['run'] === 'string' && typeof o['key'] === 'string' && typeof o['size'] === 'number' && typeof o['at'] === 'number'
  })
}

function toLeg(r: RawLeg): LegRegistration {
  return {
    sessionId: r.session_id, agentId: r.agent_id, role: r.agent_type,
    kind: r.kind as LegKind | null, door: r.door as LegDoor | null, identity: r.identity as LegIdentity | null,
    run: r.run, key: r.run_key, keySrc: r.key_src as KeySource | null,
    keyCandidates: json<KeyCandidate[]>(r.key_candidates, []), briefId: r.brief_id,
    checkpointer: r.checkpointer, checkpointedBy: r.checkpointed_by,
    startCheckpoints: json<string[]>(r.start_checkpoints, []),
    parentSession: r.parent_session, parentSrc: r.parent_src as 'hook' | 'declared' | null,
    parentDeclared: json<DeclaredParent | null>(r.parent_declared, null),
    ticketMintedAt: r.ticket_minted_at, ticketRaw: r.ticket_raw, ticketAbsent: json<string[]>(r.ticket_absent, []),
    canWrite: r.can_write === null ? null : r.can_write !== 0,
    host: r.host, pid: r.pid, procStart: r.proc_start, procStartToken: r.proc_start_token, processes: json<WorkerProcess[]>(r.processes, []),
    sendBacks: r.send_backs ?? 0, ended: r.ended as LegEnding | null, noticedAt: r.noticed_at, noticedBy: r.noticed_by,
    openedRuns: json<string[]>(r.opened_runs, []),
    capRefused: capRefusalsIn(r.cap_refused),
    keySettledFrom: json<LegRegistration['keySettledFrom']>(r.key_settled_from, null),
    clientSessions: json<Array<{ id: string; linked_by: string; at: number }>>(r.client_sessions ?? null, [])
      .map((c) => ({ id: c.id, linkedBy: c.linked_by, at: c.at })),
    worktree: r.worktree, branch: r.branch, cwd: r.cwd, startedAt: r.started_at, stoppedAt: r.stopped_at,
  }
}

/** Whether the store carries the leg columns (migration 031). A store the
 *  ladder has not reached has no legs: readers return none, and a hook
 *  writes only what the older shape holds. */
export function hasLegColumns(db: RegistryHandle): boolean {
  if (!hasRegistry(db)) return false
  try {
    const cols = db.prepare('PRAGMA table_info(session_registry)').all() as Array<{ name: string }>
    return cols.some((c) => c.name === 'run_key')
  } catch {
    return false
  }
}

/** A leg is live until it ended or its exit was recorded. */
export function isLiveLeg(leg: Pick<LegRegistration, 'ended' | 'stoppedAt'>): boolean {
  return leg.ended === null && leg.stoppedAt === null
}

/** The writer a leg's rows carry: its role, escaped as every writer is
 *  (agentWriterOf), or its agent id when no role was registered. */
export function legWriterOf(leg: Pick<LegRegistration, 'role' | 'agentId'>): string {
  return agentWriterOf(leg.role, leg.agentId === WORKER_AGENT_ID ? null : leg.agentId) || WORKER_AGENT_ID
}

export function legOf(db: RegistryHandle, ref: LegRef): LegRegistration | null {
  if (!hasLegColumns(db)) return null
  const r = db.prepare('SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?').get(ref.sessionId, ref.agentId) as RawLeg | undefined
  return r ? toLeg(r) : null
}

/** The worker registered for a session, if the session is a worker's lane. */
export function workerOfSession(db: RegistryHandle, sessionId: string): LegRegistration | null {
  return legOf(db, { sessionId, agentId: WORKER_AGENT_ID })
}

/** Whether the registry carries a column (the registry gains columns
 *  additively; a store below one reads without it). */
function hasColumn(db: RegistryHandle, column: string): boolean {
  try {
    return (db.prepare('PRAGMA table_info(session_registry)').all() as Array<{ name: string }>).some((c) => c.name === column)
  } catch {
    return false
  }
}

/**
 * The worker whose lane a session's captured rows land in (D288, D295): the
 * worker registered at that session itself (a worker the hook claimed in
 * its own Claude Code session, or any worker lane), else the worker a
 * session-start hook linked that client session to (a `claude -p` child
 * the ticket door registered in a lane of its own). Null for any other
 * session: its rows are the session's as always.
 */
export function workerLaneOf(db: RegistryHandle, sessionId: string): LegRegistration | null {
  if (!hasLegColumns(db)) return null
  const own = db.prepare("SELECT * FROM session_registry WHERE session_id = ? AND agent_id = 'worker' AND kind = 'worker'").get(sessionId) as RawLeg | undefined
  if (own) return toLeg(own)
  if (!hasColumn(db, 'client_sessions')) return null
  const linked = db.prepare(
    `SELECT * FROM session_registry WHERE kind = 'worker' AND agent_id = 'worker' AND client_sessions IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(client_sessions) WHERE json_extract(value, '$.id') = ?) ORDER BY started_at DESC LIMIT 1`,
  ).get(sessionId) as RawLeg | undefined
  return linked ? toLeg(linked) : null
}

/** D295: link a client session (a `claude -p` child's own Claude Code
 *  session id) to the worker registration its ticket names, so the
 *  child's captured rows land in the worker's lane; recorded with what
 *  linked it and when. Idempotent per session id; false on a store without
 *  the column (below the reconcile, 032) or with no such registration. */
export function linkClientSession(db: RegistryHandle, ref: LegRef, clientSession: string, opts: { linkedBy?: string; at?: number } = {}): boolean {
  if (!hasColumn(db, 'client_sessions')) return false
  const leg = legOf(db, ref)
  if (!leg) return false
  if (leg.clientSessions.some((c) => c.id === clientSession)) return true
  const links = [...leg.clientSessions, { id: clientSession, linkedBy: opts.linkedBy ?? LINKED_BY_SESSION_START, at: opts.at ?? Date.now() / 1000 }]
  db.prepare('UPDATE session_registry SET client_sessions = ? WHERE session_id = ? AND agent_id = ?')
    .run(JSON.stringify(links.map((c) => ({ id: c.id, linked_by: c.linkedBy, at: c.at }))), ref.sessionId, ref.agentId)
  return true
}

/** Every leg registered under a run, in the order they started. */
export function legsOfRun(db: RegistryHandle, run: string): LegRegistration[] {
  if (!hasLegColumns(db)) return []
  return (db.prepare('SELECT * FROM session_registry WHERE run = ? ORDER BY started_at, session_id, agent_id').all(run) as RawLeg[]).map(toLeg)
}

/** Every worker whose ticket declared (or a hook linked) this parent. A
 *  view computed when read, never a stored row (D294). */
export function workersOfParent(db: RegistryHandle, parentId: string): LegRegistration[] {
  if (!hasLegColumns(db)) return []
  return (db.prepare(
    "SELECT * FROM session_registry WHERE kind = 'worker' AND parent_session = ? ORDER BY started_at, session_id",
  ).all(parentId) as RawLeg[]).map(toLeg)
}

// ── Registration ───────────────────────────────────────────────────

/** A leg's facts as a door hands them to the registry. */
export interface LegFacts {
  run?: string | null
  key?: string | null
  keySrc?: KeySource | null
  keyCandidates?: KeyCandidate[]
  briefId?: string | null
  /** Who will checkpoint the key at the end (D281). */
  checkpointer?: string | null
  /** Who checkpointed the work this leg resumes (D281). */
  checkpointedBy?: string | null
  /** The checkpoint(s) in effect when the leg started (D329): what its
   *  own checkpoint supersedes when it names nothing (D331). */
  startCheckpoints?: string[]
}

const asJson = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))

/**
 * Register a hooks-door subagent as a leg (D284, D305, D320): its leg
 * facts on its session registration row. The SubagentStart hook normally
 * created that row already; when it did not (a library caller registering
 * the leg itself), the row is created here, inheriting where the session
 * runs from its self. Re-registering updates the facts and never touches
 * the start moment or the send-back count.
 */
export function registerSubagentLeg(
  db: RegistryHandle, ref: LegRef & { role: string | null }, facts: LegFacts,
  opts: { at: number; door?: LegDoor; identity?: LegIdentity; where?: GitSelf },
): LegRegistration {
  if (!hasLegColumns(db)) throw new Error('This store predates leg registration (schema 31); open it once with this build to migrate it')
  if (ref.agentId === '' || ref.agentId === WORKER_AGENT_ID) throw new Error(`A subagent leg needs its own agent id, not "${ref.agentId}"`)
  const self = selfOf(db, ref.sessionId)
  const where = opts.where ?? (self ? { worktree: self.worktree, branch: self.branch, cwd: self.cwd ?? '', toplevel: self.toplevel, commonDir: self.commonDir } : null)
  db.prepare(
    `INSERT INTO session_registry (session_id, agent_id, agent_type, worktree, branch, cwd, toplevel, common_dir, started_at, stopped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (session_id, agent_id) DO NOTHING`,
  ).run(ref.sessionId, ref.agentId, ref.role, where?.worktree ?? null, where?.branch ?? null, where?.cwd ?? null,
    where?.toplevel ?? null, where?.commonDir ?? null, opts.at)
  db.prepare(
    `UPDATE session_registry SET agent_type = COALESCE(?, agent_type), kind = 'subagent', door = ?, identity = ?,
       run = ?, run_key = ?, key_src = ?, key_candidates = ?, brief_id = ?, checkpointer = ?, checkpointed_by = ?,
       start_checkpoints = ?, parent_session = session_id, parent_src = 'hook'
     WHERE session_id = ? AND agent_id = ?`,
  ).run(ref.role, opts.door ?? 'hooks', opts.identity ?? 'hook', facts.run ?? null, facts.key ?? null,
    facts.keySrc ?? (facts.key ? 'declared' : null), asJson(facts.keyCandidates && facts.keyCandidates.length > 0 ? facts.keyCandidates : null),
    facts.briefId ?? null, facts.checkpointer ?? null, facts.checkpointedBy ?? null,
    asJson(facts.startCheckpoints ?? []), ref.sessionId, ref.agentId)
  return legOf(db, ref)!
}

/** What a ticket declares (D288, D294, D303, D340, D341): its spawner's
 *  word, never discovered and never checked. */
export interface WorkerTicket {
  parent: DeclaredParent
  run: string | null
  /** The key; null with `noKey` for a one-off worker declared keyless
   *  (D341), null without it when the ticket lost it (D303). */
  key: string | null
  noKey?: boolean
  role: string | null
  checkpointer?: string | null
  checkpointedBy?: string | null
  /** The moment the ticket was minted, unix seconds. */
  mintedAt?: number | null
  /** Whether the ticket declares the worker has a way to write; null when
   *  it says nothing (D340 reads that as having one). */
  canWrite?: boolean | null
  /** The ticket's raw text, kept when the door could not read it whole
   *  (D303, D342). */
  raw?: string | null
  /** The fields the door could not read (D303). */
  absent?: string[]
}

export interface WorkerStart {
  /** The worker's own session: its lane's session key. */
  sessionId: string
  ticket: WorkerTicket
  /** The door that registered it: the ticket door (unit 3), or the
   *  spawner's own library call. */
  door?: Exclude<LegDoor, 'hooks'>
  /** Where the worker runs, as the door read it. */
  where?: Partial<GitSelf>
  /** The process the worker runs as (D297, D317): its id, the start
   *  moment and, where the host has one, the exact start token. */
  process: { pid: number | null; start: number | null; host: string; token?: string | null }
  briefId?: string | null
  startCheckpoints?: string[]
  at: number
}

/**
 * Register a worker (D288, D294, D297, D317): its own lane, its declared
 * role as its writer, its parent linked by id when a hook registered that
 * parent and carried as declared otherwise, never minted as a row of its
 * own; its process id, host and the OS-reported start moment.
 */
export function registerWorkerLeg(db: RegistryHandle, start: WorkerStart): LegRegistration {
  if (!hasLegColumns(db)) throw new Error('This store predates leg registration (schema 31); open it once with this build to migrate it')
  const ref = { sessionId: start.sessionId, agentId: WORKER_AGENT_ID }
  if (legOf(db, ref)) throw new Error(`Session ${start.sessionId} already has a worker registered; a re-run is recordWorkerProcess (D335)`)
  const t = start.ticket
  // D294: a parent a hook registered is linked by its id, and its own
  // registration is what a reader reads it from; what this ticket declared
  // about it is kept as the ticket wrote it either way, a description, never
  // reconciled with the registration or another ticket's.
  const parentRegistered = t.parent.id !== '' && selfOf(db, t.parent.id) !== null
  const declared: DeclaredParent = {
    id: t.parent.id, cli: t.parent.cli ?? null, cwd: t.parent.cwd ?? null,
    worktree: t.parent.worktree ?? null, branch: t.parent.branch ?? null,
  }
  const proc: WorkerProcess | null = start.process.pid === null ? null
    : { pid: start.process.pid, start: start.process.start, token: start.process.token ?? null, host: start.process.host, at: start.at }
  const keySrc: KeySource | null = t.key ? 'declared' : (t.noKey ? 'declared' : null)
  db.prepare(
    `INSERT INTO session_registry (session_id, agent_id, agent_type, worktree, branch, cwd, toplevel, common_dir, started_at, stopped_at,
       kind, door, identity, run, run_key, key_src, brief_id, checkpointer, checkpointed_by, start_checkpoints,
       parent_session, parent_src, parent_declared, ticket_minted_at, ticket_raw, ticket_absent, can_write,
       host, pid, proc_start, proc_start_token, processes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'worker', ?, 'declared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ref.sessionId, ref.agentId, t.role, start.where?.worktree ?? null, start.where?.branch ?? null, start.where?.cwd ?? null,
    start.where?.toplevel ?? null, start.where?.commonDir ?? null, start.at,
    start.door ?? 'ticket', t.run, t.key, keySrc, start.briefId ?? null, t.checkpointer ?? null, t.checkpointedBy ?? null,
    asJson(start.startCheckpoints ?? []),
    t.parent.id === '' ? null : t.parent.id, t.parent.id === '' ? null : (parentRegistered ? 'hook' : 'declared'),
    t.parent.id === '' ? null : asJson(declared),
    t.mintedAt ?? null, t.raw ?? null, asJson(t.absent && t.absent.length > 0 ? t.absent : null),
    t.canWrite === undefined || t.canWrite === null ? null : (t.canWrite ? 1 : 0),
    start.process.host, start.process.pid, start.process.start, start.process.token ?? null, asJson(proc ? [proc] : []),
  )
  return legOf(db, ref)!
}

/** A process a worker runs as, recorded BESIDE any before it, never
 *  over it (D297, D317, D335): the pid and start columns keep the first
 *  process, `processes` holds every one in order, and a liveness check
 *  reads the newest. Recording the first process after its spawn changes
 *  nothing about how the leg ended: a damaged ticket's worker whose one
 *  row landed first stays `invalid`. A re-run (`rerun`) for the leg's
 *  missing checkpoint makes the leg live again only when it was retired
 *  as finished (the other door may have retired it before this door saw
 *  the exit); a leg cut, found gone, or ended with no valid instructions
 *  is never undone. */
export function recordWorkerProcess(db: RegistryHandle, ref: LegRef, proc: WorkerProcess, opts: { rerun?: boolean } = {}): LegRegistration {
  const leg = legOf(db, ref)
  if (!leg) throw new Error(`No leg registered for ${ref.sessionId}/${ref.agentId}`)
  const processes = [...leg.processes, proc]
  db.prepare(
    `UPDATE session_registry SET processes = ?, host = COALESCE(host, ?), pid = COALESCE(pid, ?), proc_start = COALESCE(proc_start, ?),
       proc_start_token = COALESCE(proc_start_token, ?)
     WHERE session_id = ? AND agent_id = ?`,
  ).run(JSON.stringify(processes), proc.host, proc.pid, proc.start, proc.token ?? null, ref.sessionId, ref.agentId)
  if (opts.rerun) {
    db.prepare(
      `UPDATE session_registry SET stopped_at = NULL, ended = NULL, noticed_at = NULL, noticed_by = NULL
        WHERE session_id = ? AND agent_id = ? AND ended = 'retired'`,
    ).run(ref.sessionId, ref.agentId)
  }
  return legOf(db, ref)!
}

/** Record how a leg ended, at the moment its door saw it end (D279, D291,
 *  D292, D303). Only a live leg is retired; returns whether it was. */
export function retireLeg(db: RegistryHandle, ref: LegRef, how: Exclude<LegEnding, 'phantom'>, at: number): boolean {
  if (!hasLegColumns(db)) return false
  const r = db.prepare(
    // D396: never a self (agent id ''), whose stop the store does not record.
    "UPDATE session_registry SET stopped_at = ?, ended = ? WHERE session_id = ? AND agent_id = ? AND agent_id != '' AND stopped_at IS NULL AND ended IS NULL",
  ).run(at, how, ref.sessionId, ref.agentId) as { changes?: number }
  return (r.changes ?? 0) > 0
}

/** Count the leg's send-back (D279: once, never twice, across both doors,
 *  D295). Returns the count after this one. */
export function recordSendBack(db: RegistryHandle, ref: LegRef): number {
  db.prepare('UPDATE session_registry SET send_backs = send_backs + 1 WHERE session_id = ? AND agent_id = ?').run(ref.sessionId, ref.agentId)
  return legOf(db, ref)?.sendBacks ?? 0
}

/**
 * D320, D326: the leg's first write under a key settles its registration
 * as the leg's own. Only a write that names the run the leg is registered
 * under settles it (a bare `key` on a note is not a key of the run); a key
 * already the leg's own, or declared by a ticket, is never moved by a
 * later write; a subagent never registered as a leg stays exactly as today
 * (D305). What the settle changed is kept with the row that made it
 * (`key_settled_from`), so an echo that names another writer can undo it
 * (unsettleLegKey). The caller decides the writer is known exactly.
 * Returns whether it settled.
 */
export function settleLegKey(db: RegistryHandle, ref: LegRef, run: string, key: string, byNodeId: string): boolean {
  if (!hasLegColumns(db)) return false
  const leg = legOf(db, ref)
  if (!leg || leg.kind === null) return false
  // An ambiguous registration whose candidates span runs names no run of
  // its own (the hooks door, D320): a write under one candidate's run and
  // key settles both, the run being that candidate's.
  const candidateRun = leg.run === null && leg.keySrc === 'ambiguous' && leg.keyCandidates.some((c) => c.run === run && c.key === key)
  if (!candidateRun && (leg.run === null || leg.run !== run)) return false
  if (leg.keySrc !== null && leg.keySrc !== 'inferred' && leg.keySrc !== 'ambiguous') return false
  const r = db.prepare(
    `UPDATE session_registry SET run = ?, run_key = ?, key_src = 'own', key_settled_from = ?
      WHERE session_id = ? AND agent_id = ? AND kind IS NOT NULL AND (run = ? OR (run IS NULL AND ? = 1))
        AND (key_src IS NULL OR key_src IN ('inferred', 'ambiguous'))`,
  ).run(run, key, JSON.stringify({ node_id: byNodeId, key: leg.key, key_src: leg.keySrc, ...(candidateRun ? { run: null } : {}) }),
    ref.sessionId, ref.agentId, run, candidateRun ? 1 : 0) as { changes?: number }
  return (r.changes ?? 0) > 0
}

/** Undo the settle a row made, when that row turns out not to be the
 *  leg's (its echo names another writer): the key and its source go back
 *  to what they were before it. Returns whether anything was undone. */
export function unsettleLegKey(db: RegistryHandle, ref: LegRef, byNodeId: string): boolean {
  const leg = legOf(db, ref)
  if (!leg || leg.keySettledFrom === null || leg.keySettledFrom.node_id !== byNodeId) return false
  const from = leg.keySettledFrom as { key: string | null; key_src: KeySource | null; run?: string | null }
  db.prepare(`UPDATE session_registry SET run_key = ?, key_src = ?, key_settled_from = NULL${from.run === null ? ', run = NULL' : ''} WHERE session_id = ? AND agent_id = ?`)
    .run(from.key, from.key_src, ref.sessionId, ref.agentId)
  return true
}

/** The refusals of the checkpoint cap on record for a registration, the
 *  session's self (agent id '') or a subagent or worker: null when nothing
 *  is registered there (or the store has no leg columns), so the caller
 *  keeps the record elsewhere. */
export function capRefusalsOf(db: RegistryHandle, ref: LegRef): CapRefusal[] | null {
  if (!hasLegColumns(db)) return null
  const r = db.prepare('SELECT cap_refused FROM session_registry WHERE session_id = ? AND agent_id = ?').get(ref.sessionId, ref.agentId) as { cap_refused: string | null } | undefined
  return r ? capRefusalsIn(r.cap_refused) : null
}

/** The refusal a registration holds for a run's key that is the writer's
 *  own and certain (D299, D359), if any. A pending one is a guess. */
export function confirmedCapRefusal(entries: readonly CapRefusal[], run: string, key: string): CapRefusal | null {
  return entries.find((e) => e.run === run && e.key === key && isConfirmedRefusal(e)) ?? null
}

/** Replace a registration's refusals. False when nothing is registered. */
export function setCapRefusals(db: RegistryHandle, ref: LegRef, entries: readonly CapRefusal[]): boolean {
  if (capRefusalsOf(db, ref) === null) return false
  db.prepare('UPDATE session_registry SET cap_refused = ? WHERE session_id = ? AND agent_id = ?')
    .run(entries.length === 0 ? null : JSON.stringify(entries), ref.sessionId, ref.agentId)
  return true
}

/** Record a refusal on a registration (D299, D359). A confirmed refusal of
 *  the same run and key is kept once; a pending one is kept once per id.
 *  False when nothing is registered there. */
export function recordCapRefusal(db: RegistryHandle, ref: LegRef, refusal: CapRefusal): boolean {
  const have = capRefusalsOf(db, ref)
  if (have === null) return false
  const same = (e: CapRefusal): boolean => (isConfirmedRefusal(refusal)
    ? e.run === refusal.run && e.key === refusal.key && isConfirmedRefusal(e)
    : refusal.id !== undefined && e.id === refusal.id)
  if (have.some(same)) return true
  return setCapRefusals(db, ref, [...have, refusal])
}

/** D326, D359: whether a leg's key is its own: it wrote under it, or the
 *  call that the cap refused was named its own by the call's echo (which
 *  settles the key through settleLegKey, as a written row does). The
 *  registration's key source alone. */
export function legOwnsKey(leg: Pick<LegRegistration, 'run' | 'key' | 'keySrc'>): boolean {
  return leg.run !== null && leg.key !== null && (leg.keySrc === 'own' || leg.keySrc === 'declared')
}

/** The certain refusal of the cap on record under a leg's own run and key,
 *  if any (a pending one names no one yet). */
export function capRefusalOf(leg: Pick<LegRegistration, 'run' | 'key' | 'capRefused'>): CapRefusal | null {
  return leg.run === null || leg.key === null ? null : confirmedCapRefusal(leg.capRefused, leg.run, leg.key)
}

/** D311: the leg opened a run of its own; its facts name it. */
export function recordOpenedRun(db: RegistryHandle, ref: LegRef, run: string): boolean {
  const leg = legOf(db, ref)
  if (!leg) return false
  if (leg.openedRuns.includes(run)) return true
  db.prepare('UPDATE session_registry SET opened_runs = ? WHERE session_id = ? AND agent_id = ?')
    .run(JSON.stringify([...leg.openedRuns, run]), ref.sessionId, ref.agentId)
  return true
}

/**
 * What a leg's summary row carries of its run (D284, D309, D329): the run
 * and the key, read from the leg's registration, never from the row's text
 * (D289: the facts come from the registration the store holds). The drain
 * stamps a SubagentStop summary with it (server/ingestion.ts); the ticket
 * door's summary row at a worker's exit takes the same stamp. The run
 * whenever the leg is registered under one; the key only when it is the
 * leg's own or declared, since a key inferred from a brief and never
 * written under is no key of the leg's (D320, D326): a keyless leg's
 * summary carries its run alone. A registration with no run, a subagent
 * exactly as today (D305), stamps nothing.
 */
export function legReturnStamp(db: RegistryHandle, ref: LegRef): Record<string, string> {
  const leg = legOf(db, ref)
  if (!leg || leg.kind === null || leg.run === null) return {}
  const keyed = legOwnsKey(leg)
  return { [RUN_META_KEY]: leg.run, ...(keyed ? { [KEY_META_KEY]: leg.key! } : {}) }
}

/** A fresh session id for a worker whose door has none of its own to
 *  give (a `codex exec` or `agy -p` worker has no Claude Code session). */
export function mintWorkerSessionId(): string {
  return `worker-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

// ── Phantoms (D297, D317) ──────────────────────────────────────────

export interface PhantomCheck {
  ref: LegRef
  role: string | null
  run: string | null
  key: string | null
  host: string | null
  pid: number | null
}

export interface PhantomPass {
  /** Workers retired as phantoms by this pass. */
  retired: PhantomCheck[]
  /** Workers left live that this host could not check, and why. */
  unchecked: Array<PhantomCheck & { reason: 'other-host' | 'no-start-moment' | 'start-unreadable' | 'unknown' }>
  /** One sentence per unchecked worker, for the reply that read them. */
  notes: string[]
}

/**
 * Whoever next reads the registry on a host retires every gone worker of
 * that host as a phantom (D297): the moment it was noticed and by whom,
 * never a guessed exit, no checkpoint and no summary row. A process with
 * the registered id and a different start moment is a different process,
 * so the worker is gone (D317). A worker of another host is left live and
 * said to be uncheckable from here; a worker whose start moment was never
 * read, or whose host cannot read one now, is left live with its number
 * alone and said to be indistinguishable from a successor (D317's
 * stressing case). Optionally scoped to one run.
 */
export function retirePhantoms(db: RegistryHandle, opts: {
  noticedBy: string
  at?: number
  probe?: ProcessProbe
  run?: string
}): PhantomPass {
  const pass: PhantomPass = { retired: [], unchecked: [], notes: [] }
  if (!hasLegColumns(db)) return pass
  const probe = opts.probe ?? hostProbe
  const at = opts.at ?? Date.now() / 1000
  const here = probe.host()
  const rows = (db.prepare(
    `SELECT * FROM session_registry WHERE kind = 'worker' AND ended IS NULL AND stopped_at IS NULL
       ${opts.run !== undefined ? 'AND run = ?' : ''} ORDER BY started_at`,
  ).all(...(opts.run !== undefined ? [opts.run] : [])) as RawLeg[]).map(toLeg)
  const retire = db.prepare(
    `UPDATE session_registry SET ended = 'phantom', noticed_at = ?, noticed_by = ?
      WHERE session_id = ? AND agent_id = ? AND ended IS NULL AND stopped_at IS NULL`,
  )
  for (const leg of rows) {
    const newest: WorkerProcess | null = leg.processes.at(-1)
      ?? (leg.pid !== null ? { pid: leg.pid, start: leg.procStart, token: leg.procStartToken, host: leg.host ?? '', at: leg.startedAt } : null)
    const check: PhantomCheck = {
      ref: { sessionId: leg.sessionId, agentId: leg.agentId }, role: leg.role, run: leg.run, key: leg.key,
      host: newest?.host ?? leg.host, pid: newest?.pid ?? null,
    }
    const name = `the ${leg.role ?? 'unnamed'} worker${leg.run ? ` of the run "${leg.run}"` : ''} (session ${leg.sessionId})`
    if (!newest) continue // no process was ever recorded: nothing to check
    if (newest.host !== here) {
      pass.unchecked.push({ ...check, reason: 'other-host' })
      pass.notes.push(`${name} runs on "${newest.host}" and cannot be checked from here ("${here}"); it is left live.`)
      continue
    }
    const exists = probe.exists(newest.pid)
    if (exists === false) {
      retire.run(at, opts.noticedBy, leg.sessionId, leg.agentId)
      pass.retired.push(check)
      continue
    }
    if (exists === null) {
      pass.unchecked.push({ ...check, reason: 'unknown' })
      pass.notes.push(`${name}: this host cannot say whether process ${newest.pid} exists; it is left live.`)
      continue
    }
    if (newest.start === null && !newest.token) {
      pass.unchecked.push({ ...check, reason: 'no-start-moment' })
      pass.notes.push(`${name} was registered with process ${newest.pid} and no start moment, so it cannot be told from a successor that took its number; it is left live.`)
      continue
    }
    const same = sameProcessStart(
      { start: newest.start, token: newest.token ?? null },
      { start: probe.startMoment(newest.pid), token: probe.startToken?.(newest.pid) ?? null },
    )
    if (same === null) {
      pass.unchecked.push({ ...check, reason: 'start-unreadable' })
      pass.notes.push(`${name}: this host cannot read the start moment of process ${newest.pid}, so it cannot be told from a successor that took its number; it is left live.`)
      continue
    }
    if (!same) {
      // D317: the number was handed to another process; the worker is gone.
      retire.run(at, opts.noticedBy, leg.sessionId, leg.agentId)
      pass.retired.push(check)
    }
  }
  return pass
}
