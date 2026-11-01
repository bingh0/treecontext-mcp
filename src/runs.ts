/**
 * Runs, briefs and checkpoints, read from the store (features/journal-runs.feature,
 * journal-legs.feature; rulings D280, D284, D289, D296, D302, D309, D311,
 * D327, D329, D331, D336, D343).
 *
 * A run is made of journal rows (run-kinds.ts): its open and close, each
 * brief, each numbered checkpoint, each leg's first moment and summary
 * row, every one carrying the run and, where it has one, the key. A leg's
 * captured rows carry neither: they reach the run through the leg's lane,
 * the registration (leg-registry.ts) naming the run and key (D289).
 *
 * The store judges nothing (D293, D302): it parses no checkpoint, refuses
 * none, and picks between none. "In effect" is the one computation it
 * makes: a checkpoint of a key that no other checkpoint of the key names as
 * superseded; two in effect come back as two (D280, D329). A brief is in
 * effect until a newer brief for the same role and key names it as
 * superseded, or the run it names is closed (D327).
 *
 * Reads take any handle with `prepare` (a FlatStore's wrapped database, a
 * hook's raw node:sqlite handle) and a tree id, or null for every
 * namespace, as a hook that does not know its namespace reads.
 */
import { decodeContent } from './persistence/content-codec.js'
import { writerOf } from './references.js'
import { parseMeta } from './dedup-identity.js'
import { HANDOFF_LANE_PREFIX } from './handoff.js'
import {
  CHECKPOINT_KIND, BRIEF_KIND, RUN_OPEN_KIND, RUN_CLOSE_KIND, RUN_META_KEY, KEY_META_KEY,
} from './run-kinds.js'
import {
  legsOfRun, retirePhantoms, isLiveLeg, NOTICED_BY_LOOKUP, type LegRegistration, type PhantomPass,
} from './persistence/leg-registry.js'
import type { RegistryHandle } from './persistence/session-registry.js'
import type { ProcessProbe } from './persistence/process-probe.js'

export {
  CHECKPOINT_KIND, BRIEF_KIND, RUN_OPEN_KIND, RUN_CLOSE_KIND, FIRST_MOMENT_KIND, RUN_META_KEY, KEY_META_KEY,
  RUN_ROW_KINDS, RUN_DEDUP_CLASS, runRowKindOf,
} from './run-kinds.js'

// ── Metadata keys ──────────────────────────────────────────────────

/** The number the store gave a checkpoint when it landed (D329): store-
 *  only, dropped from any caller's metadata. */
export const CHECKPOINT_NUMBER_KEY = '_checkpoint_number'

/** What a checkpoint or a brief supersedes (D280, D327): the ids of rows
 *  of the same key it replaces. Named by its writer, or stamped by the
 *  store from the leg's registration (D331). The superseded rows are
 *  never touched: supersession is read from the newer row. */
export const SUPERSEDES_KEY = 'supersedes'

/** Who named what a checkpoint supersedes (D331): store-only. */
export const SUPERSEDES_SRC_KEY = '_supersedes_src'
/** The writer named it: taken at its word. */
export const SUPERSEDES_BY_WRITER = 'writer'
/** The store stamped it from the leg's registration: the checkpoint(s)
 *  the leg started from. */
export const SUPERSEDES_BY_STORE = 'store'
/** The writer named nothing and the store could not yet tell which leg
 *  wrote it (more than one subagent of the session was live); the echo
 *  heal stamps it when the call's own echo names the leg. */
export const SUPERSEDES_PENDING = 'pending'

/** What a checkpoint rests on (D280): the entries it was written from, by
 *  id, the existing references (D186), shown one hop deep as
 *  "referenced by". */
export const RESTS_ON_KEY = 'refs'

/** A brief names who will checkpoint its key at the end, and who
 *  checkpointed the work it resumes (D281). */
export const CHECKPOINTER_KEY = 'checkpointer'
export const CHECKPOINTED_BY_KEY = 'checkpointed_by'

/** The role a brief is for (the existing brief address, D150). */
export const BRIEF_FOR_KEY = 'brief_for'

/** A run's open names who opened it and how (D302): `explicit`, or at the
 *  registration of its first leg. An inner run's open names the outer run
 *  and the leg that opened it, as declared facts (D311). */
export const OPENED_BY_KEY = 'opened_by'
export const OPENED_VIA_KEY = 'opened_via'
export const PARENT_RUN_KEY = 'parent_run'
export const PARENT_LEG_KEY = 'parent_leg'

/** A run's close names who closed it and why (D302). */
export const CLOSED_BY_KEY = 'closed_by'
export const REASON_KEY = 'reason'

/** The trace every row a door writes carries (D293), store-only: the
 *  door, whether the identity was registered by a hook or declared, the
 *  directory, and the parent as declared or linked. (The worktree and
 *  branch are the writer stamp's `_worktree` and `_branch`.) */
export const DOOR_KEY = '_door'
export const IDENTITY_KEY = '_identity'
export const CWD_KEY = '_cwd'
export const PARENT_KEY = '_parent'
export const PARENT_SRC_KEY = '_parent_src'

// ── Indexes (migration 031) ────────────────────────────────────────

/** The predicate a numbered checkpoint row satisfies, spelled once for
 *  the unique index and every read that should use it. Handoff lanes are
 *  outside it: an imported checkpoint keeps the number its own store gave
 *  it, a claim (D343), never a local slot. */
export const NUMBERED_CHECKPOINT_WHERE =
  `json_valid(metadata_json) AND json_extract(metadata_json, '$.kind') = '${CHECKPOINT_KIND}'`
  + ` AND json_extract(metadata_json, '$.${CHECKPOINT_NUMBER_KEY}') IS NOT NULL`
  + ` AND (session_key IS NULL OR substr(session_key, 1, 8) != '${HANDOFF_LANE_PREFIX}')`

/** D329: never the same number twice under one key of one run. */
export const CHECKPOINT_NUMBER_INDEX_DDL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_checkpoint_number ON nodes (tree_id, json_extract(metadata_json, '$.${RUN_META_KEY}'),`
  + ` json_extract(metadata_json, '$.${KEY_META_KEY}'), json_extract(metadata_json, '$.${CHECKPOINT_NUMBER_KEY}')) WHERE ${NUMBERED_CHECKPOINT_WHERE};`

/** The rows a run is made of, by run name (D289, D309). */
export const RUN_ROW_WHERE = `json_valid(metadata_json) AND json_extract(metadata_json, '$.${RUN_META_KEY}') IS NOT NULL`
export const RUN_ROW_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_nodes_run ON nodes (json_extract(metadata_json, '$.${RUN_META_KEY}'), created_at) WHERE ${RUN_ROW_WHERE};`

// ── Plain-SQL reconstruction (D289, N31) ───────────────────────────

/**
 * A run read back by plain SQL, the reader's recipe (D289): every row of
 * the run in the order of each row's own moment (`created_at`, the event's
 * moment, never the drain's `ingested_at`), each naming its writer and its
 * moment, and the leg it reaches the run through. A row carrying a run
 * (open, close, brief, checkpoint, first moment, summary) belongs to the
 * run it names, whoever's lane it sits in (an inner run's open, written in
 * an outer leg's lane, is the inner run's); a row carrying none, a
 * captured row, belongs to a run through its leg's lane:
 * the registration whose session is the row's session and whose agent id
 * is the row's writer agent (a subagent leg), or whose session is the
 * row's session outright (a worker's lane is its whole session). Bind the
 * run's name twice. Nothing here needs treecontext: any program with the
 * file runs it.
 */
export const RUN_ROWS_SQL = `
SELECT n.node_id, n.created_at,
       json_extract(n.metadata_json, '$._writer') AS writer,
       json_extract(n.metadata_json, '$.kind') AS kind,
       COALESCE(json_extract(n.metadata_json, '$.key'), r.run_key) AS key,
       r.session_id AS leg_session, r.agent_id AS leg_agent, r.agent_type AS leg_role,
       r.parent_session AS leg_parent
  FROM nodes n
  LEFT JOIN session_registry r
    ON r.session_id = n.session_key
   AND (r.agent_id = json_extract(n.metadata_json, '$._writer_agent_id')
        OR (r.kind = 'worker' AND json_extract(n.metadata_json, '$._writer_agent_id') IS NULL))
 WHERE json_extract(n.metadata_json, '$.run') = ?
    OR (json_extract(n.metadata_json, '$.run') IS NULL AND r.run = ?)
 ORDER BY n.created_at, n.rowid`

// ── Reads ──────────────────────────────────────────────────────────

interface Prepared { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
export interface RunReadHandle { prepare(sql: string): Prepared }

const treeClause = (treeId: number | null): string => (treeId === null ? 'tree_id IN (SELECT tree_id FROM trees)' : 'tree_id = ?')
const treeParams = (treeId: number | null): unknown[] => (treeId === null ? [] : [treeId])

const idsOf = (v: unknown): string[] => {
  if (typeof v === 'string' && v !== '') return [v]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/** A checkpoint as every reader sees it. */
export interface CheckpointRecord {
  nodeId: string
  number: number | null
  run: string
  key: string
  /** The writer it is shown with (references.ts writerOf: an imported
   *  entry by its importer's mark). */
  writer: string
  writerSrc: string | null
  /** The session and agent of the lane it was written in. */
  sessionKey: string | null
  writerAgentId: string | null
  createdAt: number
  content: string
  size: number
  supersedes: string[]
  supersedesSrc: string | null
  restsOn: string[]
  /** Arrived by import, under a handoff lane (D343). */
  imported: boolean
  metadata: Record<string, unknown>
}

interface RawRow { node_id: string; created_at: number; content: unknown; metadata_json: string | null; session_key: string | null }

function toCheckpoint(r: RawRow): CheckpointRecord {
  const meta = parseMeta(r.metadata_json) ?? {}
  const content = decodeContent(r.content as string | Buffer | null)
  const n = Number(meta[CHECKPOINT_NUMBER_KEY])
  return {
    nodeId: r.node_id,
    number: Number.isFinite(n) && meta[CHECKPOINT_NUMBER_KEY] !== undefined && meta[CHECKPOINT_NUMBER_KEY] !== null ? n : null,
    run: String(meta[RUN_META_KEY]),
    key: String(meta[KEY_META_KEY]),
    writer: writerOf(meta),
    writerSrc: typeof meta['_writer_src'] === 'string' ? meta['_writer_src'] : null,
    sessionKey: r.session_key,
    writerAgentId: typeof meta['_writer_agent_id'] === 'string' ? meta['_writer_agent_id'] : null,
    createdAt: r.created_at,
    content,
    size: content.length,
    supersedes: idsOf(meta[SUPERSEDES_KEY]),
    supersedesSrc: typeof meta[SUPERSEDES_SRC_KEY] === 'string' ? meta[SUPERSEDES_SRC_KEY] : null,
    restsOn: idsOf(meta[RESTS_ON_KEY]),
    imported: (r.session_key ?? '').startsWith(HANDOFF_LANE_PREFIX),
    metadata: meta,
  }
}

/** Every checkpoint under a run's key, in number order (an imported one
 *  by its claimed number, ties by moment). */
export function checkpointsUnder(db: RunReadHandle, treeId: number | null, run: string, key: string): CheckpointRecord[] {
  const rows = db.prepare(
    `SELECT node_id, created_at, content, metadata_json, session_key FROM nodes
      WHERE ${treeClause(treeId)} AND ${RUN_ROW_WHERE}
        AND json_extract(metadata_json, '$.${RUN_META_KEY}') = ? AND json_extract(metadata_json, '$.kind') = '${CHECKPOINT_KIND}'
        AND json_extract(metadata_json, '$.${KEY_META_KEY}') = ?
      ORDER BY created_at, rowid`,
  ).all(...treeParams(treeId), run, key) as RawRow[]
  return rows.map(toCheckpoint).sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.createdAt - b.createdAt)
}

/** The checkpoints in effect under a run's key (D280, D329): those no
 *  other checkpoint of the key names as superseded, in number order. Two
 *  in effect come back as two, never a silent pick. */
export function checkpointsInEffect(db: RunReadHandle, treeId: number | null, run: string, key: string): CheckpointRecord[] {
  const all = checkpointsUnder(db, treeId, run, key)
  const superseded = new Set<string>()
  for (const c of all) for (const id of c.supersedes) if (id !== c.nodeId) superseded.add(id)
  return all.filter((c) => !superseded.has(c.nodeId))
}

/** The number the next checkpoint under a run's key takes when it lands
 *  (D329): one past the highest the key holds, imported ones counted. */
export function nextCheckpointNumber(db: RunReadHandle, treeId: number | null, run: string, key: string): number {
  const r = db.prepare(
    `SELECT MAX(CAST(json_extract(metadata_json, '$.${CHECKPOINT_NUMBER_KEY}') AS INTEGER)) AS n FROM nodes
      WHERE ${treeClause(treeId)} AND ${RUN_ROW_WHERE}
        AND json_extract(metadata_json, '$.${RUN_META_KEY}') = ? AND json_extract(metadata_json, '$.kind') = '${CHECKPOINT_KIND}'
        AND json_extract(metadata_json, '$.${KEY_META_KEY}') = ?`,
  ).get(...treeParams(treeId), run, key) as { n: number | null } | undefined
  return Number(r?.n ?? 0) + 1
}

/** The newest checkpoint a leg itself wrote under a run's key: a row of
 *  the leg's lane (its session and its writer agent), by number. */
export function legNewestCheckpoint(
  db: RunReadHandle, treeId: number | null, leg: { sessionId: string; agentId: string }, run: string, key: string, exceptNodeId?: string,
): string | null {
  const own = checkpointsUnder(db, treeId, run, key)
    .filter((c) => c.sessionKey === leg.sessionId && c.writerAgentId === leg.agentId && c.nodeId !== exceptNodeId)
  return own.at(-1)?.nodeId ?? null
}

/**
 * What a checkpoint that names nothing as superseded is stamped as
 * superseding (D331, read with its sib clause: "a forgetful leg leaving a
 * pile of checkpoints in effect under one key" is what it prevents): the
 * leg's own newest checkpoint under that run and key when it has one, else
 * the checkpoint(s) the leg's registration says it started from, when the
 * checkpoint is under the run and key the leg is registered for. Both are
 * facts the journal already holds; nothing is synthesized. A build-time
 * reading of D331, recorded for the owner to ratify.
 */
export function storeSupersedesFor(
  db: RunReadHandle, treeId: number | null,
  leg: { sessionId: string; agentId: string; run: string | null; key: string | null; startCheckpoints: string[] },
  run: string, key: string, exceptNodeId?: string,
): string[] {
  const own = legNewestCheckpoint(db, treeId, leg, run, key, exceptNodeId)
  if (own) return [own]
  return leg.run === run && leg.key === key ? leg.startCheckpoints : []
}

/** One line saying what is in effect under a key (D280, D289, D329):
 *  none, one, or how many, never a pick between them. */
export function inEffectLine(run: string, key: string, inEffect: readonly Pick<CheckpointRecord, 'number'>[]): string {
  if (inEffect.length === 0) return `No checkpoint is in effect under "${key}" on the run "${run}".`
  const nums = inEffect.map((c) => (c.number === null ? 'unnumbered' : `number ${c.number}`))
  if (inEffect.length === 1) return `Checkpoint ${nums[0]} is in effect under "${key}" on the run "${run}".`
  return `${inEffect.length} checkpoints are in effect under "${key}" on the run "${run}" (${nums.join(' and ')}); `
    + 'none supersedes the other, and the store picks none of them.'
}

/** A run's rows of one kind, oldest first. */
function runRowsOfKind(db: RunReadHandle, treeId: number | null, run: string, kind: string): Array<{ nodeId: string; createdAt: number; content: string; metadata: Record<string, unknown> }> {
  return (db.prepare(
    `SELECT node_id, created_at, content, metadata_json FROM nodes
      WHERE ${treeClause(treeId)} AND ${RUN_ROW_WHERE}
        AND json_extract(metadata_json, '$.${RUN_META_KEY}') = ? AND json_extract(metadata_json, '$.kind') = ?
      ORDER BY created_at, rowid`,
  ).all(...treeParams(treeId), run, kind) as RawRow[]).map((r) => ({
    nodeId: r.node_id, createdAt: r.created_at, content: decodeContent(r.content as string | Buffer | null), metadata: parseMeta(r.metadata_json) ?? {},
  }))
}

/** A run's open row: the first, if it was ever opened. */
export function runOpenOf(db: RunReadHandle, treeId: number | null, run: string): { nodeId: string; createdAt: number; metadata: Record<string, unknown> } | null {
  return runRowsOfKind(db, treeId, run, RUN_OPEN_KIND)[0] ?? null
}

/** A run's close rows, oldest first; a run nobody closed has none and
 *  stays open (D308). */
export function runClosesOf(db: RunReadHandle, treeId: number | null, run: string): Array<{ nodeId: string; createdAt: number; metadata: Record<string, unknown> }> {
  return runRowsOfKind(db, treeId, run, RUN_CLOSE_KIND)
}

export interface BriefRecord {
  nodeId: string
  run: string
  key: string
  role: string
  checkpointer: string | null
  checkpointedBy: string | null
  writer: string
  createdAt: number
  content: string
  supersedes: string[]
}

/**
 * The briefs in effect for a role (D327): a brief is in effect until a
 * newer brief for the same role under the same key names it as
 * superseded, or the run it names is closed. Two briefs for one role
 * under different keys on open runs are both in effect: the ambiguous
 * case the hooks door names (D320). Newest first.
 */
export function briefsInEffect(db: RunReadHandle, treeId: number | null, role: string): BriefRecord[] {
  const rows = db.prepare(
    `SELECT node_id, created_at, content, metadata_json, session_key FROM nodes
      WHERE ${treeClause(treeId)} AND ${RUN_ROW_WHERE} AND json_extract(metadata_json, '$.kind') = '${BRIEF_KIND}'
        AND json_extract(metadata_json, '$.${BRIEF_FOR_KEY}') = ?
      ORDER BY created_at DESC, rowid DESC`,
  ).all(...treeParams(treeId), role) as RawRow[]
  const briefs: BriefRecord[] = rows.map((r) => {
    const meta = parseMeta(r.metadata_json) ?? {}
    return {
      nodeId: r.node_id, run: String(meta[RUN_META_KEY]), key: String(meta[KEY_META_KEY]), role,
      checkpointer: typeof meta[CHECKPOINTER_KEY] === 'string' ? meta[CHECKPOINTER_KEY] : null,
      checkpointedBy: typeof meta[CHECKPOINTED_BY_KEY] === 'string' ? meta[CHECKPOINTED_BY_KEY] : null,
      writer: writerOf(meta), createdAt: r.created_at, content: decodeContent(r.content as string | Buffer | null),
      supersedes: idsOf(meta[SUPERSEDES_KEY]),
    }
  })
  const superseded = new Set<string>()
  for (const b of briefs) {
    for (const id of b.supersedes) {
      const target = briefs.find((t) => t.nodeId === id)
      if (target && target.key === b.key && target.nodeId !== b.nodeId) superseded.add(id)
    }
  }
  const closed = new Map<string, boolean>()
  const isClosed = (run: string): boolean => {
    if (!closed.has(run)) closed.set(run, runClosesOf(db, treeId, run).length > 0)
    return closed.get(run)!
  }
  return briefs.filter((b) => !superseded.has(b.nodeId) && !isClosed(b.run))
}

// ── The key lookup (D289, D329), the floor the reply is built on ───

/** A leg of the run as the lookup shows it: live or how it ended. */
export interface LegState {
  sessionId: string
  agentId: string
  role: string | null
  kind: LegRegistration['kind']
  key: string | null
  keySrc: LegRegistration['keySrc']
  state: 'live' | 'retired' | 'cut' | 'phantom' | 'invalid'
  startedAt: number
  stoppedAt: number | null
  noticedAt: number | null
  noticedBy: string | null
  openedRuns: string[]
  registration: LegRegistration
}

export function legStateOf(leg: LegRegistration): LegState {
  const state: LegState['state'] = isLiveLeg(leg) ? 'live' : (leg.ended ?? 'retired')
  return {
    sessionId: leg.sessionId, agentId: leg.agentId, role: leg.role, kind: leg.kind, key: leg.key, keySrc: leg.keySrc,
    state, startedAt: leg.startedAt, stoppedAt: leg.stoppedAt, noticedAt: leg.noticedAt, noticedBy: leg.noticedBy,
    openedRuns: leg.openedRuns, registration: leg,
  }
}

export interface KeyLookup {
  run: string
  key: string
  /** The checkpoints in effect, in number order: none, one, or more. */
  checkpoints: CheckpointRecord[]
  /** The line saying what is in effect. */
  line: string
  /** Every leg registered under the run, live or how it ended. */
  legs: LegState[]
  /** The phantom pass this lookup ran (D297): who it retired, and one
   *  sentence per worker it could not check. */
  phantoms: PhantomPass
  notes: string[]
}

/**
 * The harness's lookup by run and key together (D289), with no model in
 * the loop: the phantom pass on this host first (the lookup is a reader of
 * the registry, D297), then the checkpoints in effect with their writers,
 * the line saying how many, and each leg of the run as live or how it
 * ended. The floor the full reply stands on: the run's facts (D301, D312,
 * D344), the flag against the brief's checkpointer (D296), the pointer to
 * the return (D336) and the agent's door to it (D337) are built over this.
 */
export function lookupKey(db: RunReadHandle & RegistryHandle, treeId: number | null, opts: {
  run: string
  key: string
  probe?: ProcessProbe
  noticedBy?: string
  at?: number
}): KeyLookup {
  let phantoms: PhantomPass
  try {
    phantoms = retirePhantoms(db, {
      noticedBy: opts.noticedBy ?? NOTICED_BY_LOOKUP,
      run: opts.run,
      ...(opts.probe ? { probe: opts.probe } : {}),
      ...(opts.at !== undefined ? { at: opts.at } : {}),
    })
  } catch (err) {
    // A reader that cannot write (a read-only handle) still reads; it
    // says it retired nothing, never that nothing was gone.
    phantoms = { retired: [], unchecked: [], notes: [`The registry could not be written from this handle, so no gone worker was retired: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const checkpoints = checkpointsInEffect(db, treeId, opts.run, opts.key)
  return {
    run: opts.run,
    key: opts.key,
    checkpoints,
    line: inEffectLine(opts.run, opts.key, checkpoints),
    legs: legsOfRun(db, opts.run).map(legStateOf),
    phantoms,
    notes: [...phantoms.notes],
  }
}
