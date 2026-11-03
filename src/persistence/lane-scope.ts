/**
 * The lane read (D376, D374): which rows are a placed lane's own, read from
 * the session registry at the moment of the read and never written onto a
 * row.
 *
 * A placed lane is a checkout: `main` (the main checkout) or
 * `worktree:<name>` (a linked worktree, under the name it registered,
 * session-registry.ts worktreeLaneName). Its rows are:
 *
 *  - the rows of every session whose self the registry places in that
 *    checkout, minus each helper's trail: a row carrying
 *    `_writer_agent_id` (a subagent's tool calls and turns, the client's
 *    own internal agent's) is the lane's only when it is a report, a
 *    `subagent-summary` or an `internal-summary`;
 *  - each ticket-door worker's report, by the parent link of the worker's
 *    registration (`parent_session` placed in the checkout), never the
 *    rest of the worker's session; a worker whose parent the registry
 *    places nowhere reports into no lane's default search;
 *  - the entries imported (`handoff:` lanes) by a session of the lane, and
 *    for `main` also those imported by no session the registry places;
 *  - for `main` also the rows of sessions the registry never held at all,
 *    the store's rows from before it recorded writers;
 *  - never a row stamped `unregistered` (the undetermined writers,
 *    references.ts UNKNOWN_LANE), whichever session it sits in.
 *
 * A writer's TRAIL by `main` or `worktree:<name>` is narrower: the session's
 * own agent's rows of every session placed in that checkout (no helper's
 * row, report or not; nothing stamped `ambiguous` or `unregistered`; no
 * import), and for `main` the older rows naming no writer whose session
 * the registry never held.
 *
 * Both are SQL predicates over `nodes`, so a scope is applied in the store
 * before a result count and to every conversation window alike.
 *
 * A POINTER's lane is read with the same cuts (D379, references.ts
 * laneOfRow): the session's own agent's row in a session the registry
 * places is that checkout's, whatever its stamp; an unstamped row is
 * main's only where the registry never held its session, and writer
 * unknown where it holds the session but places it nowhere. placementsOf
 * reads the placement once per call for every reader that lists, counts
 * or retires pointers, and for the search's own-chapter seat.
 */
import { HANDOFF_LANE_PREFIX } from '../handoff.js'
import { SUBAGENT_SUMMARY_KIND } from '../run-kinds.js'
import {
  hasRegistry, registryHasColumn, selfOf, INTERNAL_SUMMARY_KIND, MAIN_WRITER, WORKTREE_WRITER_PREFIX, type RegistryHandle,
} from './session-registry.js'

/** A placed lane, as a writer names it: `main` or `worktree:<name>`. */
export type PlacedLane = string

/** The kinds of a helper's row that are its report, the lane's to find. */
export const REPORT_KINDS: readonly string[] = [SUBAGENT_SUMMARY_KIND, INTERNAL_SUMMARY_KIND]

/** The checkout a placed lane names: null for the main checkout, the
 *  worktree's registered name otherwise. Throws on a name that is no
 *  placed lane (a role, the undetermined writers, a handoff lane). */
export function checkoutOfLane(lane: PlacedLane): string | null {
  if (lane === MAIN_WRITER) return null
  if (lane.startsWith(WORKTREE_WRITER_PREFIX) && lane.length > WORKTREE_WRITER_PREFIX.length) return lane.slice(WORKTREE_WRITER_PREFIX.length)
  throw new Error(`not a placed lane: ${JSON.stringify(lane)} (main or worktree:<name>)`)
}

/** Whether a writer name is a placed lane (`main` or `worktree:<name>`). */
export function isPlacedLane(writer: string): boolean {
  return writer === MAIN_WRITER || (writer.startsWith(WORKTREE_WRITER_PREFIX) && writer.length > WORKTREE_WRITER_PREFIX.length)
}

/** The placed lane a session runs in, read from its self registration:
 *  `main` or `worktree:<name>`. Null when the registry holds no self for
 *  it (an unplaced session, a ticket-door worker, a store without the
 *  registry). */
export function placedLaneOf(db: RegistryHandle, sessionId: string | null): PlacedLane | null {
  if (!sessionId) return null
  const self = selfOf(db, sessionId)
  if (!self) return null
  return self.worktree ? `${WORKTREE_WRITER_PREFIX}${self.worktree}` : MAIN_WRITER
}

/** The least a placement read needs from a database handle: a FlatStore's
 *  wrapped database, a hook's raw handle and references.ts's ReadHandle
 *  alike. */
interface PlacementHandle { prepare(sql: string): { all(...p: unknown[]): unknown[] } }

/** How many session ids one placement read binds at a time. */
const PLACEMENT_CHUNK = 500

/**
 * The placement of `sessionIds`, read from the registry in one pass per
 * call (D379): each session whose SELF registration the registry holds,
 * mapped to `main` or `worktree:<name>`, the same spelling placedLaneOf
 * gives and the same sessions laneRowsSql reads as a checkout's; each
 * session the registry holds by another registration only (a ticket-door
 * worker, a subagent whose session's self never registered), mapped to
 * null: held, placed in no checkout. A session absent from the map is one
 * the registry never held, as laneRowsSql's never-held cut reads it (R7a):
 * the store's rows from before it recorded writers. A store whose registry
 * cannot be read holds none. references.ts laneOfRow reads all three.
 */
export function placementsOf(db: PlacementHandle, sessionIds: Iterable<string | null | undefined>): Map<string, PlacedLane | null> {
  const wanted = [...new Set([...sessionIds].filter((s): s is string => typeof s === 'string' && s !== ''))]
  const out = new Map<string, PlacedLane | null>()
  if (wanted.length === 0) return out
  try {
    for (let i = 0; i < wanted.length; i += PLACEMENT_CHUNK) {
      const chunk = wanted.slice(i, i + PLACEMENT_CHUNK)
      const rows = db.prepare(
        `SELECT session_id, agent_id, worktree FROM session_registry WHERE session_id IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk) as Array<{ session_id: string; agent_id: string; worktree: string | null }>
      for (const r of rows) {
        // Only the session's self places it; any other registration holds it.
        if (r.agent_id === '') out.set(r.session_id, r.worktree ? `${WORKTREE_WRITER_PREFIX}${r.worktree}` : MAIN_WRITER)
        else if (!out.has(r.session_id)) out.set(r.session_id, null)
      }
    }
  } catch {
    // No registry (a store older than it, or unreadable): nothing held.
    return new Map()
  }
  return out
}

export interface LaneSql { sql: string; params: unknown[] }

/** How the lane is read: a default search's scope, or a writer's trail. */
export type LaneReading = 'search' | 'trail'

/**
 * The lane's rows as one SQL predicate over `nodes` under the alias
 * prefix `p` ('' or 'n.'). `ids`, for a search, are entries the lane's
 * live pointers and briefs reference (one hop), found though they sit
 * elsewhere; an undetermined writer's row is excluded even then.
 */
export function laneRowsSql(db: RegistryHandle, lane: PlacedLane, p: string, reading: LaneReading, ids: string[] = []): LaneSql {
  const checkout = checkoutOfLane(lane)
  const isMain = checkout === null
  const j = (k: string): string => `json_extract(${p}metadata_json, '$.${k}')`
  const registry = hasRegistry(db)
  const params: unknown[] = []
  // The sessions placed in the checkout, as a subquery (its params pushed
  // where it is spelled).
  const placed = (): string => {
    if (!registry) return 'SELECT NULL WHERE 0'
    if (isMain) return "SELECT sr.session_id FROM session_registry sr WHERE sr.agent_id = '' AND sr.worktree IS NULL"
    params.push(checkout)
    return "SELECT sr.session_id FROM session_registry sr WHERE sr.agent_id = '' AND sr.worktree = ?"
  }
  const neverHeld = registry
    ? `(${p}session_key IS NULL OR ${p}session_key NOT IN (SELECT sh.session_id FROM session_registry sh))`
    : '1'
  const notImported = `substr(COALESCE(${p}session_key, ''), 1, ${HANDOFF_LANE_PREFIX.length}) != '${HANDOFF_LANE_PREFIX}'`
  const imported = `substr(COALESCE(${p}session_key, ''), 1, ${HANDOFF_LANE_PREFIX.length}) = '${HANDOFF_LANE_PREFIX}'`
  const reportKinds = `${j('kind')} IN (${REPORT_KINDS.map((k) => `'${k}'`).join(', ')})`
  const notUnknown = `COALESCE(${j('_writer_src')}, '') != 'unregistered'`

  if (reading === 'trail') {
    const ownAgent = `${j('_writer_agent_id')} IS NULL AND COALESCE(${j('_writer_src')}, '') NOT IN ('unregistered', 'ambiguous')`
    const selfStamp = `(${j('_writer')} = '${MAIN_WRITER}' OR ${j('_writer')} LIKE '${WORKTREE_WRITER_PREFIX}%' OR (${j('_writer')} IS NULL AND ${j('agent_type')} IS NULL))`
    const inLane = `(${p}session_key IN (${placed()}) AND ${selfStamp})`
    const older = isMain
      ? ` OR (${neverHeld} AND COALESCE(${j('_writer')}, '${MAIN_WRITER}') = '${MAIN_WRITER}' AND ${j('agent_type')} IS NULL)`
      : ''
    return { sql: `(${notImported} AND ${ownAgent} AND (${inLane}${older}))`, params }
  }

  const parts: string[] = []
  // The lane's sessions (and, for main, the sessions never held), minus
  // the helpers' trails.
  parts.push(`(${notImported} AND (${p}session_key IN (${placed()})${isMain ? ` OR ${neverHeld}` : ''})`
    + ` AND (${j('_writer_agent_id')} IS NULL OR ${reportKinds}))`)
  // Each worker's report, by the parent link of its registration.
  if (registry && registryHasColumn(db, 'kind') && registryHasColumn(db, 'parent_session')) {
    parts.push(`(${p}session_key IN (SELECT sw.session_id FROM session_registry sw WHERE sw.kind = 'worker'`
      + ` AND sw.parent_session IN (${placed()})) AND ${reportKinds})`)
  }
  // The entries imported by a session of the lane; for main also by no
  // session the registry places.
  const importer = j('_handoff_importer')
  const unplacedImporter = registry
    ? ` OR ${importer} IS NULL OR ${importer} NOT IN (SELECT si.session_id FROM session_registry si WHERE si.agent_id = '')`
    : ` OR 1`
  parts.push(`(${imported} AND (${importer} IN (${placed()})${isMain ? unplacedImporter : ''}))`)
  if (ids.length > 0) {
    parts.push(`${p}node_id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }
  return { sql: `(${notUnknown} AND (${parts.join(' OR ')}))`, params }
}
