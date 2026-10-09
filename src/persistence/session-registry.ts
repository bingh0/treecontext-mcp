/**
 * The session registry: who a session is, and which subagents it has live
 * (features/journal-orchestration.feature, rulings D190, D167, D169, D147,
 * D148, D150).
 *
 * The orchestrator and every subagent it spawns share ONE Claude Code
 * session id and ONE MCP server connection, so the server cannot tell from
 * the transport who is speaking on a given call. What it can know is what
 * the hooks registered under the session id it already resolves:
 *
 *  - the session-start hook registers the session's SELF (agent_id ''):
 *    its worktree (a linked worktree's directory name, NULL for the main
 *    checkout or outside git), branch, directory, git top level and
 *    common dir, exactly as git reports them for the payload's cwd;
 *  - the SubagentStart hook registers a live subagent (agent_id, agent_type)
 *    under the same session, and SubagentStop retires it.
 *
 * A row written through the tools is stamped at insert from that
 * registry (resolveWriter, whose comment gives the rule), every guess
 * marked as one, and made exact at the drain by the call's own echo
 * (writer-heal.ts). Rows the hooks capture carry the payload's own agent
 * fields and need no lookup.
 *
 * Reads and writes take any handle with `prepare` — a hook's raw
 * better-sqlite3 handle and a FlatStore's wrapped one alike. A store the
 * registry has not reached yet (no table) reads as unregistered.
 */
import { createHash } from 'node:crypto'

/** The table, created by migration 027. Hooks never create it (JF-8): on
 *  a store the ladder has not reached, registration is skipped and the
 *  session reads as unregistered. */
export const SESSION_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS session_registry (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  agent_type TEXT,
  worktree TEXT,
  branch TEXT,
  cwd TEXT,
  toplevel TEXT,
  common_dir TEXT,
  started_at REAL NOT NULL,
  stopped_at REAL,
  PRIMARY KEY (session_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_session_registry_worktree ON session_registry (worktree, started_at);
`

/** agent_id of a session's own self row. */
export const SELF_AGENT_ID = ''

/** `_writer` of a row the session's main agent wrote in the main checkout.
 *  It reads as the main lane, the same lane as an older row naming no
 *  writer at all (references.ts laneWriterOf). */
export const MAIN_WRITER = 'main'

/** `_writer` of a row the main agent of a linked worktree wrote: the
 *  worktree is its own lane (D167, D169), kept apart from role names. */
export const WORKTREE_WRITER_PREFIX = 'worktree:'

/** The metadata keys only the store writes — the stamp, the heal's
 *  record, and the supersession trace the heal restores from. A caller's
 *  copy through the insert tool is a forgery and is dropped. */
export const WRITER_STAMP_KEYS = ['_writer', '_writer_src', '_writer_agent_id', '_writer_candidates', '_worktree', '_branch', '_writer_stamped', '_writer_heal_reverted', '_writer_heal_note',
  '_writer_heal_retired', '_writer_heal_unretired', '_superseded_prior', '_supersedes_referenced'] as const

interface Prepared { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown }
/** The one capability the registry needs from a database handle. */
export interface RegistryHandle { prepare(sql: string): Prepared }

/** Where a session runs, as git reports it for the session's directory. */
export interface GitSelf {
  /** A linked worktree's directory name; null for the main checkout or
   *  outside git. */
  worktree: string | null
  branch: string | null
  cwd: string
  toplevel: string | null
  commonDir: string | null
}

export interface RegistryRow {
  sessionId: string
  agentId: string
  agentType: string | null
  worktree: string | null
  branch: string | null
  cwd: string | null
  toplevel: string | null
  commonDir: string | null
  startedAt: number
  stoppedAt: number | null
}

interface RawRow {
  session_id: string; agent_id: string; agent_type: string | null; worktree: string | null; branch: string | null
  cwd: string | null; toplevel: string | null; common_dir: string | null; started_at: number; stopped_at: number | null
}

function toRow(r: RawRow): RegistryRow {
  return {
    sessionId: r.session_id, agentId: r.agent_id, agentType: r.agent_type, worktree: r.worktree, branch: r.branch,
    cwd: r.cwd, toplevel: r.toplevel, commonDir: r.common_dir, startedAt: r.started_at, stoppedAt: r.stopped_at,
  }
}

export function hasRegistry(db: RegistryHandle): boolean {
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_registry'").get() !== undefined
  } catch {
    return false
  }
}

/**
 * The lane name a linked worktree registers under (F6 of the chunk-5b
 * review). A worktree is named by its directory, so two worktrees of
 * different checkouts with one directory name would share a lane. The
 * name a top level registered under before is kept; a name another top
 * level already holds is disambiguated as `<name>@<6 hex of the top
 * level's path>`, deterministic for that path.
 */
export function worktreeLaneName(db: RegistryHandle, self: GitSelf): string | null {
  if (!self.worktree || !self.toplevel) return self.worktree
  const mine = db.prepare(
    "SELECT worktree FROM session_registry WHERE agent_id = '' AND toplevel = ? AND worktree IS NOT NULL ORDER BY started_at LIMIT 1",
  ).get(self.toplevel) as { worktree: string } | undefined
  if (mine) return mine.worktree
  const taken = db.prepare(
    "SELECT 1 FROM session_registry WHERE agent_id = '' AND worktree = ? AND toplevel != ? LIMIT 1",
  ).get(self.worktree, self.toplevel)
  if (!taken) return self.worktree
  return `${self.worktree}@${createHash('sha1').update(self.toplevel).digest('hex').slice(0, 6)}`
}

/** Register (or re-register, on resume and clear) a session's self.
 *  Returns the worktree lane name it registered (worktreeLaneName). */
export function registerSelf(db: RegistryHandle, sessionId: string, self: GitSelf, at: number): string | null {
  const worktree = worktreeLaneName(db, self)
  db.prepare(
    `INSERT INTO session_registry (session_id, agent_id, agent_type, worktree, branch, cwd, toplevel, common_dir, started_at, stopped_at)
     VALUES (?, '', NULL, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (session_id, agent_id) DO UPDATE SET worktree = excluded.worktree, branch = excluded.branch,
       cwd = excluded.cwd, toplevel = excluded.toplevel, common_dir = excluded.common_dir, stopped_at = NULL`,
  ).run(sessionId, worktree, self.branch, self.cwd, self.toplevel, self.commonDir, at)
  return worktree
}

/** Register a live subagent of the session (SubagentStart). */
export function registerSubagent(
  db: RegistryHandle, sessionId: string, agentId: string, agentType: string | null, self: GitSelf, at: number,
): void {
  db.prepare(
    `INSERT INTO session_registry (session_id, agent_id, agent_type, worktree, branch, cwd, toplevel, common_dir, started_at, stopped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (session_id, agent_id) DO UPDATE SET agent_type = excluded.agent_type, stopped_at = NULL`,
  ).run(sessionId, agentId, agentType, self.worktree, self.branch, self.cwd, self.toplevel, self.commonDir, at)
}

/** Retire a subagent (SubagentStop). Returns whether a live one was retired. */
export function retireSubagent(db: RegistryHandle, sessionId: string, agentId: string, at: number): boolean {
  const r = db.prepare(
    'UPDATE session_registry SET stopped_at = ? WHERE session_id = ? AND agent_id = ? AND stopped_at IS NULL',
  ).run(at, sessionId, agentId) as { changes?: number }
  return (r.changes ?? 0) > 0
}

/** Retire every live subagent of a session (F3 of the chunk-5b review):
 *  none survives the session's (re)start, so a SubagentStop lost to a
 *  crash cannot hold the session's stamp past it. Returns how many. */
export function retireAllSubagents(db: RegistryHandle, sessionId: string, at: number): number {
  if (!hasRegistry(db)) return 0
  const r = db.prepare(
    "UPDATE session_registry SET stopped_at = ? WHERE session_id = ? AND agent_id != '' AND stopped_at IS NULL",
  ).run(at, sessionId) as { changes?: number }
  return r.changes ?? 0
}

export function selfOf(db: RegistryHandle, sessionId: string): RegistryRow | null {
  if (!hasRegistry(db)) return null
  const r = db.prepare("SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ''").get(sessionId) as RawRow | undefined
  return r ? toRow(r) : null
}

export function subagentOf(db: RegistryHandle, sessionId: string, agentId: string): RegistryRow | null {
  if (!hasRegistry(db) || agentId === SELF_AGENT_ID) return null
  const r = db.prepare('SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId) as RawRow | undefined
  return r ? toRow(r) : null
}

export function liveSubagents(db: RegistryHandle, sessionId: string): RegistryRow[] {
  if (!hasRegistry(db)) return []
  return (db.prepare(
    "SELECT * FROM session_registry WHERE session_id = ? AND agent_id != '' AND stopped_at IS NULL ORDER BY started_at, agent_id",
  ).all(sessionId) as RawRow[]).map(toRow)
}

/** The writer a self row names: the main checkout, or its worktree. */
export function selfWriterOf(self: Pick<RegistryRow, 'worktree'> | null): string {
  return self?.worktree ? `${WORKTREE_WRITER_PREFIX}${self.worktree}` : MAIN_WRITER
}

/** The prefix a subagent type takes when its name would join a lane it
 *  is not: `main`, or one starting `worktree:` (F7 of the chunk-5b
 *  review). */
export const AGENT_WRITER_PREFIX = 'agent:'

/** The writer a subagent's type or id names: its role (D167: a
 *  subagent's self is its role), the instance id when no type was sent,
 *  under `agent:` when the bare name would read as the main checkout's or
 *  a worktree's lane. One spelling for the drain, the registry and the
 *  echo heal. */
export function agentWriterOf(agentType: string | null | undefined, agentId: string | null | undefined): string {
  const name = agentType && agentType.trim() !== '' ? agentType : (agentId ?? '')
  return name === MAIN_WRITER || name.startsWith(WORKTREE_WRITER_PREFIX) || name.startsWith(AGENT_WRITER_PREFIX)
    ? `${AGENT_WRITER_PREFIX}${name}` : name
}

export function subagentWriterOf(row: Pick<RegistryRow, 'agentType' | 'agentId'>): string {
  return agentWriterOf(row.agentType, row.agentId)
}

/**
 * The newest moment the session's OWN agent was seen by a hook — a staged
 * event with no agent fields (a prompt, a tool call, a response), or a
 * drained capture of one — or null. A subagent's events carry agent_id
 * and never count. Read from what the store already holds: staging keeps
 * processed rows for a day, and drained rows keep their session.
 */
export function newestMainEvent(db: RegistryHandle, sessionId: string): number | null {
  let best: number | null = null
  try {
    const r = db.prepare(
      `SELECT MAX(timestamp) AS t FROM staging WHERE session_id = ? AND agent_id IS NULL AND agent_type IS NULL AND role != 'snapshot'`,
    ).get(sessionId) as { t: number | null } | undefined
    if (r?.t != null) best = r.t
  } catch { /* a staging table without the writer columns: no evidence */ }
  try {
    const r = db.prepare(
      `SELECT MAX(created_at) AS t FROM nodes WHERE tree_id IN (SELECT tree_id FROM trees) AND session_key = ?
          AND source_label = 'auto-capture' AND json_extract(metadata_json, '$._writer_agent_id') IS NULL
          AND json_extract(metadata_json, '$._writer') IS NULL`,
    ).get(sessionId) as { t: number | null } | undefined
    if (r?.t != null && (best === null || r.t > best)) best = r.t
  } catch { /* no journal yet */ }
  return best
}

/**
 * How a row written through the tools is stamped AT INSERT. The insert's
 * own PostToolUse echo later corrects it exactly (writer-heal.ts,
 * `_writer_src` `echo`); until then the stamp is the registry's reading:
 *  - `self`: no subagent of the session is live — the session's self, the
 *    main checkout or its worktree;
 *  - `concurrent`: a subagent is live, but the session's own agent was
 *    seen by a hook AFTER the oldest live subagent started — proof the
 *    orchestrator is working beside it (a background subagent) — so the
 *    row is the self's, never guessed to be the subagent's;
 *  - `provisional`: exactly one subagent is live and the session's own
 *    agent has been silent since it started (a foreground subagent, the
 *    orchestrator waiting) — the row is read as that subagent's, and said
 *    to be provisional;
 *  - `ambiguous`: more than one is live, with no such evidence — the self
 *    with the live candidates, owning no lane;
 *  - `unregistered`: the session is unknown here — no writer stamped.
 * `registry` is the source of rows written before the echo heal existed;
 * `echo` and `hook` are exact.
 */
export type WriterSource = 'registry' | 'provisional' | 'concurrent' | 'self' | 'ambiguous' | 'unregistered' | 'echo' | 'hook'

export interface WriterStamp {
  src: WriterSource
  writer?: string
  agentId?: string
  worktree?: string
  branch?: string
  candidates?: Array<{ agent_id: string; agent_type: string | null }>
}

export function resolveWriter(db: RegistryHandle, sessionId: string | null): WriterStamp {
  if (!sessionId || !hasRegistry(db)) return { src: 'unregistered' }
  const self = selfOf(db, sessionId)
  const live = liveSubagents(db, sessionId)
  const where = (r: RegistryRow | null): Pick<WriterStamp, 'worktree' | 'branch'> => ({
    ...(r?.worktree ? { worktree: r.worktree } : {}),
    ...(r?.branch ? { branch: r.branch } : {}),
  })
  const candidates = live.map((a) => ({ agent_id: a.agentId, agent_type: a.agentType }))
  if (live.length > 0) {
    const oldestStart = Math.min(...live.map((a) => a.startedAt))
    const seen = newestMainEvent(db, sessionId)
    if (seen !== null && seen > oldestStart) {
      return { src: 'concurrent', writer: selfWriterOf(self), ...where(self), candidates }
    }
  }
  if (live.length === 1) {
    const a = live[0]!
    return { src: 'provisional', writer: subagentWriterOf(a), agentId: a.agentId, ...where(self ?? a) }
  }
  if (live.length > 1) {
    return { src: 'ambiguous', ...(self ? { writer: selfWriterOf(self) } : {}), ...where(self), candidates }
  }
  if (!self) return { src: 'unregistered' }
  return { src: 'self', writer: selfWriterOf(self), ...where(self) }
}

/** The stamp as metadata keys, ready to merge onto a row's metadata. */
export function stampMetadata(stamp: WriterStamp): Record<string, unknown> {
  const m: Record<string, unknown> = { _writer_src: stamp.src }
  if (stamp.writer !== undefined) m['_writer'] = stamp.writer
  if (stamp.agentId !== undefined) m['_writer_agent_id'] = stamp.agentId
  if (stamp.worktree !== undefined) m['_worktree'] = stamp.worktree
  if (stamp.branch !== undefined) m['_branch'] = stamp.branch
  if (stamp.candidates !== undefined) m['_writer_candidates'] = stamp.candidates
  return m
}
