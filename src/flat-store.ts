/**
 * FlatStore — lexical, no-embedder memory backend (MVP default).
 *
 * A flat collection of leaf nodes in the `nodes` table (parent_id NULL,
 * embeddings NULL), searched by SQLite FTS5 bm25(). No embedder, no KNN
 * index, no tree. All nodes hang off one degenerate container tree per
 * namespace (the nodes.tree_id FK).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database } from './persistence/database.js'
import type { MemoryStore, ImportResult } from './memory-store.js'
import { handoffMetadata, claimedSender, exporterName, HANDOFF_LANE_PREFIX, SUBAGENT_SUMMARY_KIND, type HandoffSource } from './handoff.js'
import type {
  ConversationWindow,
  InsertOptions,
  InsertResult,
  JournalVitals,
  MediaFilter,
  MediaRef,
  OpenThread,
  QueryOptions,
  QueryResult,
  ResumePointer,
  SupersedeMiss,
  TreeStatus,
  WindowEntry,
} from './core/types.js'
import { Persistence } from './persistence/store.js'
import type { PersistedNode } from './persistence/store.js'
import { contentFingerprint } from './fingerprint.js'
import { dbg } from './debug.js'
import { sessionOf, resolveSessionKey, isAutoCaptureSource, effectiveSource, dedupClassOf, parseMeta, NO_SESSION } from './dedup-identity.js'
import { LeaseClient, SWEEP_LEASE_TTL_SECS } from './persistence/leases.js'
import { MERGE_SRC_ALIAS, attachedNamespaces } from './persistence/merge-source.js'
import type { MergeCounts, NamespaceCounts } from './persistence/merge-source.js'
import { hostname } from 'node:os'
import { NodeNotFoundError } from './errors/index.js'
import { computeAdaptiveCount } from './adaptive-count.js'
import { decodeContent, encodeContent } from './persistence/content-codec.js'
import { demotionTextFor, applyLiftedBoundaries, EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './persistence/index-text.js'
import { roleWeightVector } from './persistence/fts.js'
import { BOOKMARK_KIND, BOOKMARK_RANK_FACTOR, checkpointKindOf, sessionChainWith } from './checkpoints.js'
import { AMBIGUOUS_LANE, laneWriterOf, referencedBy, refIdsOf } from './references.js'
import { resolveWriter, selfOf, selfWriterOf, MAIN_WRITER, type WriterStamp } from './persistence/session-registry.js'
import { retireMeta } from './persistence/writer-heal.js'
import {
  DEDUP_WINDOW_SECS,
  autoEntriesFor,
  MAX_STORE_BYTES_DEFAULT,
  MAX_SESSIONS_DEFAULT,
} from './persistence/capture-constants.js'

export interface FlatStoreOptions {
  database: Database
  namespace?: string
  ownsDatabase?: boolean
  migrate?: boolean
  /** Retain auto-capture from the most recent N sessions (D6). Default 100;
   *  the serve path passes the config file's `[retention] max_sessions`
   *  when set (D141). */
  maxSessions?: number
  /** Hard cap on auto-capture entries (D6 safety net). Default: 200 per
   *  configured session (D255), so 20_000 at the default cap of 100. */
  maxAutoEntries?: number
  /** Run the retention sweep every N inserts. Default 50. */
  retentionInterval?: number
  /**
   * C3: store-byte budget (sum of stored content byte lengths) before the
   * demotion sweep starts stripping oldest-first non-protected auto-capture
   * rows back to their index text. Default 128 MiB (D141); the serve path
   * passes the config file's `[retention] max_store_bytes` when set.
   */
  maxStoreBytes?: number
  /**
   * Directory for session archives written by the eviction valve (whole
   * sessions in export format, one file each, before their rows are
   * tombstoned and deleted). Default: an `archive/` directory next to the
   * database file. When neither this option nor a database path is
   * available (in-memory store), the valve DEMOTES but never evicts —
   * the store never destroys what it cannot archive.
   */
  archiveDir?: string
  /**
   * Called right before the store's long SYNCHRONOUS phases (the
   * retention sweep and its VACUUM), which block the event loop and
   * starve any setInterval-based lease heartbeat the owning process
   * runs (release-diff review 2026-08-15: a >90s VACUUM let a second
   * server seize the namespace mid-write). The serve path passes its
   * LeaseClient's renewAll here, buying the full TTL for the blocking
   * phase. Best-effort: throws are the caller's to swallow. A phase
   * that alone exceeds the TTL still starves — documented residual.
   */
  maintenanceHeartbeat?: () => void
  /**
   * Open for reading only — pass a read-only SQLite connection alongside.
   * Skips open-time bookkeeping writes and forces migrations off (a store
   * with pending migrations fails loudly instead of mid-write); any write
   * operation fails loudly on the read-only connection.
   */
  readOnly?: boolean
}

const IMPORT_MAX_JSON_BYTES = 5 * 1024 * 1024
const IMPORT_MAX_NODES = 10_000

/** The columns every export reads, in one spelling. */
const EXPORT_COLUMNS =
  'SELECT node_id, parent_id, depth, is_leaf, content, summary, created_at, updated_at, ' +
  'summary_stale, read_only, decay_exempt, utility_score, source_label, metadata_json'

/** One exported entry, the shape every export file carries. */
export interface ExportedNode {
  nodeId: unknown
  parentId: unknown
  depth: unknown
  isLeaf: boolean
  content: string
  summary: unknown
  createdAt: unknown
  updatedAt: unknown
  summaryStale: boolean
  readOnly: boolean
  decayExempt: boolean
  utilityScore: unknown
  sourceLabel: unknown
  metadata: Record<string, unknown> | null
}

function exportNode(r: Record<string, unknown>): ExportedNode {
  return {
    nodeId: r['node_id'],
    parentId: r['parent_id'],
    depth: r['depth'],
    isLeaf: Number(r['is_leaf']) !== 0,
    content: decodeContent(r['content'] as string | Buffer | null),
    summary: r['summary'],
    createdAt: r['created_at'],
    updatedAt: r['updated_at'],
    summaryStale: Number(r['summary_stale']) !== 0,
    readOnly: Number(r['read_only']) !== 0,
    decayExempt: Number(r['decay_exempt']) !== 0,
    utilityScore: r['utility_score'],
    sourceLabel: r['source_label'],
    metadata: parseMeta(r['metadata_json'] as string | null),
  }
}

// conversation_window (W5): neighbor entries are head-truncated at 700
// chars (calibration: truncates 0% of the captured assistant/tool stream);
// the anchor gets the capture layer's own user-message cap (2,000) so
// anchors arrive whole.
export const WINDOW_NEIGHBOR_MAX_CHARS = 700
export const ANCHOR_MAX_CHARS = 2000

interface NodeRow {
  node_id: string
  content: string
  summary: string
  created_at: number
  metadata_json: string | null
  source_label: string | null
}

/** A row from the session/time neighbor or anchor lookups (conversation_window). */
interface WindowRow {
  node_id: string
  content: unknown
  created_at: number
  rowid: number
  metadata_json: string | null
  index_len: number | null
  preview_len: number | null
}

/** W5: head-truncate at `cap`, chars-removed count in the marker. */
function truncateWindowContent(content: string, cap: number): { content: string; truncated: boolean } {
  if (content.length <= cap) return { content, truncated: false }
  const removed = content.length - cap
  return { content: content.slice(0, cap) + `…[truncated ${removed} chars]`, truncated: true }
}

function toWindowEntry(row: WindowRow, cap: number): WindowEntry {
  const meta = applyLiftedBoundaries(parseMeta(row.metadata_json), row.index_len, row.preview_len)
  // C4: window entries are contextual glue — the full tail never leaks
  // through a window; the base text is the index view, with the window's
  // own cap applied on top.
  const decoded = indexViewOf(decodeContent(row.content as string | Buffer | null), meta)
  const { content, truncated } = truncateWindowContent(decoded, cap)
  const entry: WindowEntry = { nodeId: row.node_id, content, createdAt: row.created_at, truncated }
  const role = meta?.['role']
  if (typeof role === 'string') entry.role = role
  const toolName = meta?.['tool_name']
  if (typeof toolName === 'string') entry.toolName = toolName
  return entry
}

// parseMeta moved to dedup-identity.ts with the other classifying inputs.

// sessionOf / isAutoCaptureSource / dedupClassOf and the rest of the
// classifying inputs live in dedup-identity.ts (program G): the arbiter
// backfill must share them byte-identically with every write path.

function isProtected(
  meta: Record<string, unknown> | null,
  source: string | null,
  decayExempt: boolean,
  readOnly: boolean,
): boolean {
  if (source !== 'auto-capture') return true // agent-authored
  if (decayExempt || readOnly) return true
  if (!meta) return false
  return meta['next_session'] === true || meta['status'] === 'active'
}

/** The valid boundary stored under `key`, or null when the row has none (or
 *  it covers the whole content — e.g. after C3 demotion, when there is
 *  nothing beyond the index view to advertise). */
function boundaryOf(meta: Record<string, unknown> | null, key: string, contentLength: number): number | null {
  const len = meta?.[key]
  if (typeof len === 'number' && Number.isFinite(len) && len >= 0 && len < contentLength) return len
  return null
}

/** The DISPLAY boundary of a row: `_preview_len` when present (schema 18+,
 *  where the FTS view can extend past the preview), else `_index_len` (the
 *  pre-018 shape, where one number was both boundaries). */
function displayLenOf(meta: Record<string, unknown> | null, contentLength: number): number | null {
  return (
    boundaryOf(meta, EXPLICIT_PREVIEW_LEN_KEY, contentLength) ??
    boundaryOf(meta, EXPLICIT_INDEX_LEN_KEY, contentLength)
  )
}

/** C4 read side (D1): a hit on a row with a full tail returns the display
 *  preview plus an availability marker. Presentation-only — never stored,
 *  never indexed (JF-9); exports return the raw content.
 *
 *  Demoted rows advertise their loss the same way: the sweep records the
 *  pre-demotion length and archive path in metadata, so the hit says where
 *  the truncated tail lives instead of presenting the stump as whole.
 *  (Rows demoted before the 2026-07-31 archive-before-shrink ruling carry
 *  neither key — for those the loss is unrecorded and the stump is all
 *  there is to return.) */
function presentContent(decoded: string, meta: Record<string, unknown> | null): string {
  if (meta?.['_demoted'] === true) {
    const fullLen = meta['_full_len']
    const archive = meta['_archive_path']
    if (typeof fullLen === 'number' && fullLen > decoded.length && typeof archive === 'string') {
      // The path itself stays in metadata (_archive_path) — hits carry
      // metadata, and an absolute path in content would outlive file
      // moves and leak host layout into every reader (round-2 R11).
      return decoded + `…[demoted; full content ${fullLen} chars archived — path in _archive_path]`
    }
    return decoded
  }
  const len = displayLenOf(meta, decoded.length)
  if (len === null) return decoded
  return decoded.slice(0, len) + `…[preview; full content ${decoded.length} chars via treecontext_export]`
}

/** Window base text: the display view without the marker (the window's own
 *  caps and truncation notices apply on top). */
function indexViewOf(decoded: string, meta: Record<string, unknown> | null): string {
  const len = displayLenOf(meta, decoded.length)
  return len === null ? decoded : decoded.slice(0, len)
}

/** Tokenize free text the way the MATCH builder sees it. */
function ftsTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu) ?? []
}

/** Build an FTS5 MATCH from tokens: each one quoted (operators
 *  neutralized) and OR-joined for bm25 ranking. */
function buildFtsMatch(tokens: string[]): string {
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/** High-DF pruning kicks in only past this corpus size — small stores are
 *  fast regardless and their frequency stats are noise. */
const DF_PRUNE_MIN_DOCS = 256
/** A token matching more than this fraction of the corpus carries ~zero
 *  IDF signal but forces every containing row into the bm25 candidate set
 *  — the canonical session-start query is mostly such tokens. */
const DF_PRUNE_FRACTION = 0.5

/**
 * Fold the cross-writer supersedes targets (D169) into an insert's
 * supersession outcome: when the row landed they are its references
 * (`referenced`); when the insert was a dedup hit the incoming refs went
 * nowhere, so each is a miss that says why the target was not retired.
 */
/** D150's lane scope as SQL over `nodes` (alias prefix `p`, '' or 'n.'):
 *  rows whose store-stamped `_writer` is one of the scope's writers, or
 *  whose id it names. Null when there is no scope. */
function laneScopeSql(scope: QueryOptions['laneScope'], p: string): { sql: string; params: unknown[] } | null {
  if (!scope) return null
  const parts: string[] = []
  const params: unknown[] = []
  if (scope.writers.length > 0) {
    parts.push(`json_extract(${p}metadata_json, '$._writer') IN (${scope.writers.map(() => '?').join(',')})`)
    params.push(...scope.writers)
  }
  if (scope.ids.length > 0) {
    parts.push(`${p}node_id IN (${scope.ids.map(() => '?').join(',')})`)
    params.push(...scope.ids)
  }
  return { sql: parts.length > 0 ? `(${parts.join(' OR ')})` : '0', params }
}

function withForeign(
  sup: { superseded?: string[]; supersedeMisses?: SupersedeMiss[] },
  foreign: string[],
  landed: boolean,
): { superseded?: string[]; supersedeMisses?: SupersedeMiss[]; referenced?: string[] } {
  if (foreign.length === 0) return sup
  if (landed) return { superseded: sup.superseded ?? [], ...sup, referenced: foreign }
  return {
    superseded: sup.superseded ?? [],
    ...sup,
    supersedeMisses: [...(sup.supersedeMisses ?? []), ...foreign.map((nodeId) => ({ nodeId, reason: 'other_writer' as const }))],
  }
}

export class FlatStore implements MemoryStore {
  private readonly db: Database
  private readonly persistence: Persistence
  readonly namespace: string
  private readonly ownsDatabase: boolean
  private readonly treeId: number
  private readonly maxSessions: number
  private readonly maxAutoEntries: number
  private readonly retentionInterval: number
  private readonly maxStoreBytes: number
  private readonly archiveDir: string | null
  /** Renews the OWNING PROCESS's leases before long synchronous phases —
   *  see FlatStoreOptions.maintenanceHeartbeat. */
  private readonly maintenanceHeartbeat: (() => void) | null
  // Dedup enforcement lives in the STORE (G2, store-as-arbiter): curated
  // dedup is the partial unique index idx_nodes_curated_fp; the auto
  // window is the dedup_anchors table, keyed (tree_id, session_key,
  // fingerprint) — the double-fire being suppressed is a same-session
  // phenomenon, and a fingerprint-only key would let a foreign session
  // interleaving identical content steal the slot (round-2 review, R5).
  // The in-memory fingerprint maps and their open-time warm scan retired
  // with G2: every consumer that opens the file inherits the invariants,
  // and anchor state (last_seen slides) survives reopen and is shared
  // across processes.
  /** Rows the demotion sweep proved unshrinkable (index text == stored
   *  content, e.g. untailed tool previews). Skipped before decode on later
   *  sweeps — a permanently-over-budget store must not re-decode the whole
   *  table every 50 inserts. Row CONTENT is immutable post-insert except
   *  through demotion itself, so entries never go stale — the V2 echo heal
   *  (the one other post-insert writer) touches session-identity metadata
   *  and session_key only, never content, so it cannot invalidate this
   *  cache. */
  private readonly unshrinkable = new Set<string>()
  private leaseClient: LeaseClient | null = null
  private insertsSinceSweep = 0
  private closed = false

  private constructor(db: Database, persistence: Persistence, treeId: number, opts: FlatStoreOptions) {
    this.db = db
    this.persistence = persistence
    this.treeId = treeId
    this.namespace = opts.namespace ?? 'project'
    this.ownsDatabase = opts.ownsDatabase ?? true
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS_DEFAULT
    // The net scales with the cap (D255): 200 entries per configured
    // session, so the default 100 keeps 20 000; an explicit option wins.
    this.maxAutoEntries = opts.maxAutoEntries ?? autoEntriesFor(this.maxSessions)
    this.retentionInterval = opts.retentionInterval ?? 50
    this.maxStoreBytes = opts.maxStoreBytes ?? MAX_STORE_BYTES_DEFAULT
    this.archiveDir = opts.archiveDir ?? (db.path ? join(dirname(db.path), 'archive') : null)
    this.maintenanceHeartbeat = opts.maintenanceHeartbeat ?? null
    // No warm scan (G2): dedup state lives in the store, so open reads
    // nothing — the every-row decode-and-fingerprint pass this loop used
    // to pay is gone with the maps it fed.
  }

  /** Class-scoped duplicate predicate for importJson/mergeFromNamespace —
   *  same semantics as insert() BY CONSTRUCTION: both consult the same
   *  Persistence.liveAnchor (window + node-exists re-verify, round-3
   *  S1/S3 semantics kept) and the same curated-holder predicate the
   *  unique index enforces. */
  private isDuplicateInStore(
    fp: string,
    sourceLabel: string | null | undefined,
    meta: Record<string, unknown> | null,
    createdAt: number,
  ): boolean {
    return this.isDuplicateInTree(this.treeId, fp, sourceLabel, meta, createdAt)
  }

  /** The same predicate against an arbitrary destination tree — the store
   *  merge writes into one dst tree per SOURCE namespace (F3), not into
   *  this FlatStore's own namespace, and the dedup scope must follow the
   *  tree the row actually lands in. `isDuplicateInStore` is this with
   *  `this.treeId`; there is one predicate, not two. */
  private isDuplicateInTree(
    treeId: number,
    fp: string,
    sourceLabel: string | null | undefined,
    meta: Record<string, unknown> | null,
    createdAt: number,
  ): boolean {
    if (dedupClassOf(sourceLabel, meta) === 'auto') {
      return this.persistence.liveAnchor(treeId, sessionOf(meta), fp, createdAt, DEDUP_WINDOW_SECS) !== undefined
    }
    return this.persistence.curatedHolder(treeId, fp) !== undefined
  }

  static async open(opts: FlatStoreOptions): Promise<FlatStore> {
    const db = opts.database
    const openOpts: { migrate?: boolean; readOnly?: boolean } = {}
    if (opts.migrate !== undefined) openOpts.migrate = opts.migrate
    if (opts.readOnly) openOpts.readOnly = true
    const persistence = Persistence.openLexical(db, openOpts)
    const treeId = persistence.ensureTree(0, opts.namespace ?? 'project')
    return new FlatStore(db, persistence, treeId, opts)
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('FlatStore is closed')
  }

  /**
   * The persistence layer. Exposes staging access so a FlatStore can back the
   * capture drain (IngestionLoop) with no embedder, journal, or BIRCH — the
   * agent store and the auto-capture journal are one unified store, separated
   * only by `source_label` + D6 retention. Mirrors `TreeContext.store`.
   */
  get store(): Persistence {
    return this.persistence
  }

  /** The session's registered self (D190), or null. */
  selfOfSession(sessionId: string): ReturnType<typeof selfOf> {
    this.ensureOpen()
    return selfOf(this.db, sessionId)
  }

  /** D190: how a row written through the tools by `sessionId` is stamped,
   *  read from the session registry (persistence/session-registry.ts). */
  writerStampFor(sessionId: string | null): WriterStamp {
    this.ensureOpen()
    return resolveWriter(this.db, sessionId)
  }

  /**
   * D150: a subagent's default search scope — its role's trail (rows the
   * store stamped with that role as `_writer`), the plan it was spawned
   * under (the live resume pointers of the lane that spawned it: the
   * session's self, the main checkout or its worktree), the entries
   * briefing its role (`brief_for` = the role), and the entries those
   * pointers and briefs reference, one hop.
   */
  subagentScopeFor(sessionId: string, role: string): { writers: string[]; ids: string[] } {
    this.ensureOpen()
    const spawner = laneWriterOf({ _writer: selfWriterOf(selfOf(this.db, sessionId)) })
    const rows = this.db.prepare(
      `SELECT node_id, metadata_json FROM nodes WHERE tree_id = ? AND COALESCE(source_label, '') != 'auto-capture' AND (
         json_extract(metadata_json, '$.next_session') = 1 OR json_extract(metadata_json, '$.status') = 'active'
         OR json_extract(metadata_json, '$.brief_for') = ?)`,
    ).all(this.treeId, role) as Array<{ node_id: string; metadata_json: string | null }>
    const ids = new Set<string>()
    for (const r of rows) {
      const meta = parseMeta(r.metadata_json)
      const brief = meta?.['brief_for'] === role
      if (!brief && laneWriterOf(meta) !== spawner) continue
      ids.add(r.node_id)
      for (const ref of refIdsOf(meta)) ids.add(ref)
    }
    return { writers: [role], ids: [...ids] }
  }

  /** Rows with `content` decoded to plaintext (C1: the column may hold a
   *  zstd-flagged Buffer for larger rows). */
  private allRows(): NodeRow[] {
    const rows = this.db
      .prepare(
        'SELECT node_id, content, summary, created_at, metadata_json, source_label ' +
          'FROM nodes WHERE tree_id = ?',
      )
      .all(this.treeId) as unknown as Array<NodeRow & { content: unknown }>
    return rows.map((r) => ({ ...r, content: decodeContent(r.content as string | Buffer | null) }))
  }

  // ── Insert ────────────────────────────────────────────────────────
  async insert(content: string, opts?: InsertOptions): Promise<InsertResult> {
    this.ensureOpen()
    if (opts?.mediaRef && content.trim().length === 0) {
      // The description IS the recall surface in a lexical store; a bare
      // URI would be unfindable by every search mode the journal has.
      throw new Error('A media reference requires descriptive text — the description is the searchable surface')
    }
    const now = Date.now() / 1000
    // Media refs ride in metadata under _media, the same shape the tree
    // backend stores (MemTree insert) and the media filter reads.
    let meta = opts?.mediaRef
      ? { ...opts?.metadata, _media: opts.mediaRef }
      : (opts?.metadata ?? null)
    // A bookmark (D158) is a resume pointer by definition: it is live until
    // the session's next bookmark supersedes it (D166), so the flag is
    // implied rather than left for every writer to remember.
    const isBookmark = checkpointKindOf(meta) === 'bookmark'
    if (isBookmark && meta && meta['next_session'] !== true) meta = { ...meta, next_session: true }
    const source = effectiveSource(opts?.sourceLabel, meta)
    const isAuto = isAutoCaptureSource(source)
    // Capture time: honest chronology for drained backlogs. updatedAt stays
    // insert time.
    const createdAt = opts?.createdAt ?? now
    const fp = contentFingerprint(content)

    // D2 dedup matrix, enforced by the STORE (G2): curated dedups globally
    // via the partial unique index — INSERT … ON CONFLICT DO NOTHING, and
    // changes = 0 IS the dedup hit, true for every writer in every
    // process. Auto-capture dedups only within DEDUP_WINDOW_SECS of the
    // LAST SEEN occurrence (the window slides — three double-fires each
    // inside the window of the previous still collapse to one node) and
    // only within the SAME session — identical content in another session
    // is a distinct event whose timeline must not get a hole. Classes
    // never cross (JF-11). The whole decision-and-write runs in ONE
    // immediate transaction: the check-then-insert on the anchor table is
    // race-free, and the row + FTS + supersession commit or vanish
    // together.
    // D166: a new bookmark supersedes the session's previous live bookmark,
    // within its own lane (this tree) — through the same supersedes path a
    // writer's explicit list takes, so the old one keeps its trace and
    // stays searchable. "The session" is its whole /clear chain (D216):
    // each clear mints a new id, and the bookmark before the clear is the
    // previous one. An unattributed bookmark supersedes the lane's other
    // unattributed ones, so a failed attribution never grows the panel.
    const writer = laneWriterOf(meta)
    let ownSupersedes: string[] | undefined = opts?.supersedes
    const withPriorBookmarks = (self: string): string[] | undefined => {
      if (!isBookmark || isAuto) return ownSupersedes
      const session = sessionOf(meta)
      let chain = [session]
      if (session !== NO_SESSION) {
        try {
          const cfg = this.db.prepare('SELECT value FROM store_config WHERE key = ?')
          chain = sessionChainWith((k) => (cfg.get(k) as { value: string } | undefined)?.value, session)
        } catch { /* no store_config: the session alone */ }
      }
      // Session- AND lane-scoped (D166 read with D169, D241): at most one
      // live bookmark per session per lane. A subagent shares its
      // orchestrator's session, and only a lane's own writer retires that
      // lane's pointers — a subagent's bookmark never retires the
      // orchestrator's. A writer the store could not tell apart owns no
      // lane and retires none.
      if (writer === AMBIGUOUS_LANE) return ownSupersedes
      const prior = (this.db.prepare(
        `SELECT node_id, metadata_json FROM nodes WHERE tree_id = ? AND session_key IN (${chain.map(() => '?').join(',')}) AND node_id != ?
           AND json_extract(metadata_json, '$.kind') = '${BOOKMARK_KIND}'
           AND json_extract(metadata_json, '$.next_session') = 1`,
      ).all(this.treeId, ...chain, self) as Array<{ node_id: string; metadata_json: string | null }>)
        .filter((r) => laneWriterOf(parseMeta(r.metadata_json)) === writer).map((r) => r.node_id)
      if (prior.length === 0) return ownSupersedes
      return [...(ownSupersedes ?? []), ...prior]
    }
    const result = this.db.transaction((): InsertResult => {
      // D169: only a lane's own writer retires that lane's pointers. A
      // supersedes target another writer owns is left untouched; the new
      // entry carries the pointer instead, as a reference in its refs,
      // which the owning lane sees as "referenced by" at its next read.
      const split = this.splitSupersedes(opts?.supersedes, writer)
      ownSupersedes = split.own
      if (split.foreign.length > 0) {
        // `_supersedes_referenced` remembers which refs were supersessions
        // the writer's lane could not perform, so an echo heal that moves
        // the row into the targets' lane can perform them (D240).
        meta = { ...meta, refs: [...new Set([...refIdsOf(meta), ...split.foreign])], _supersedes_referenced: split.foreign }
      }
      if (isAuto) {
        const sessionKey = sessionOf(meta)
        const anchor = this.persistence.liveAnchor(this.treeId, sessionKey, fp, createdAt, DEDUP_WINDOW_SECS)
        if (anchor) {
          this.persistence.slideAnchor(this.treeId, sessionKey, fp, createdAt)
          const sup = this.applySupersedes(ownSupersedes, anchor.nodeId)
          return { nodeId: anchor.nodeId, path: [anchor.nodeId], depth: 0, deduplicated: true, driftDetected: false, staleNodes: [], ...withForeign(sup, split.foreign, false), ...this.unrecordedRefs(meta, anchor.nodeId) }
        }
      }

      const nodeId = randomUUID().replace(/-/g, '')
      const node: PersistedNode = {
        nodeId,
        treeId: this.treeId,
        parentId: null,
        depth: 0,
        isLeaf: true,
        content,
        summary: '',
        createdAt,
        updatedAt: now,
        summaryStale: false,
        readOnly: opts?.readOnly ?? false,
        decayExempt: opts?.decayExempt ?? false,
        decayRate: opts?.decayRate,
        utilityScore: 0.5,
        sourceLabel: source,
        metadata: meta,
      }
      const inserted = this.persistence.insertNode(this.treeId, node)
      if (!inserted) {
        // Curated twin: the index refused the row, so the survivor is the
        // one row holding this (tree_id, fingerprint) slot. A dedup hit
        // must not silently discard incoming resume-pointer tags —
        // re-recording a fact with next_session/active is how an agent
        // re-arms an old note as a pointer. (The auto hit deliberately
        // does NOT merge pointer flags — bound asymmetry, amendment 7.)
        const survivor = this.persistence.curatedHolder(this.treeId, fp)
        if (survivor === undefined) {
          // Structurally unreachable inside this transaction: the refusal
          // proves the survivor exists. Refuse loudly over dropping data.
          // The WHOLE key, plus the node it was computed for: since §11b
          // the fingerprint is a 32-char digest, so the old
          // `fp.slice(0, 32)…` printed the entire hash and appended an
          // ellipsis promising more (review finding 9). A truncated key
          // is also unqueryable, which is the one thing anyone reading
          // this message wants to do with it.
          throw new Error(
            `Curated dedup refused insert but no survivor row found (fingerprint ${fp}, node ${nodeId})`,
          )
        }
        this.mergePointerFlags(survivor, meta)
        const sup = this.applySupersedes(withPriorBookmarks(survivor), survivor)
        return { nodeId: survivor, path: [survivor], depth: 0, deduplicated: true, driftDetected: false, staleNodes: [], ...withForeign(sup, split.foreign, false), ...this.unrecordedRefs(meta, survivor) }
      }
      if (isAuto) this.persistence.upsertAnchor(this.treeId, sessionOf(meta), fp, nodeId, createdAt)

      const sup = this.applySupersedes(withPriorBookmarks(nodeId), nodeId)
      return { nodeId, path: [nodeId], depth: 0, deduplicated: false, driftDetected: false, staleNodes: [], ...withForeign(sup, split.foreign, true) }
    })

    // The amortized sweep stays OUTSIDE the insert transaction: it runs
    // its own transactions, writes archive files, and may VACUUM — none
    // of which can nest. Dedup hits don't advance the counter (unchanged).
    if (!result.deduplicated) {
      this.insertsSinceSweep++
      if (this.insertsSinceSweep >= this.retentionInterval) this.retentionSweep()
    }
    return result
  }

  /** On a curated dedup hit whose incoming metadata carries resume-pointer
   *  tags, arm those tags on the existing node. Metadata-only update; the
   *  touched keys (next_session/status) never enter indexTextFor, so the
   *  contentless FTS recompute stays byte-identical (FG-2 safe). */
  private mergePointerFlags(nodeId: string, incoming: Record<string, unknown> | null): void {
    if (!incoming) return
    const wantsPointer = incoming['next_session'] === true
    const wantsActive = incoming['status'] === 'active'
    if (!wantsPointer && !wantsActive) return
    const row = this.db
      .prepare('SELECT metadata_json FROM nodes WHERE node_id = ? AND tree_id = ?')
      .get(nodeId, this.treeId) as { metadata_json: string | null } | undefined
    if (!row) return
    const meta = parseMeta(row.metadata_json) ?? {}
    if (wantsPointer) meta['next_session'] = true
    if (wantsActive) meta['status'] = 'active'
    this.db
      .prepare('UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE node_id = ? AND tree_id = ?')
      .run(JSON.stringify(meta), Date.now() / 1000, nodeId, this.treeId)
  }

  /** On a dedup hit no row lands, so the incoming entry's references go
   *  nowhere. They are never merged into the survivor — that row may be
   *  another lane's, and nothing outside the writer's lane is modified
   *  (D169) — so the ones the survivor does not already carry are
   *  disclosed instead. */
  private unrecordedRefs(incoming: Record<string, unknown> | null, survivor: string): { refsNotRecorded?: string[] } {
    const wanted = refIdsOf(incoming)
    if (wanted.length === 0) return {}
    const row = this.db.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(survivor) as { metadata_json: string | null } | undefined
    const held = new Set(refIdsOf(parseMeta(row?.metadata_json ?? null)))
    const missing = [...new Set(wanted)].filter((id) => !held.has(id))
    return missing.length > 0 ? { refsNotRecorded: missing } : {}
  }

  /** Partition supersedes targets by lane (D169): `own` are this writer's
   *  (or unknown here — applySupersedes reports those as misses), `foreign`
   *  are rows of this tree another writer owns. */
  private splitSupersedes(ids: string[] | undefined, writer: string): { own: string[] | undefined; foreign: string[] } {
    if (!ids || ids.length === 0) return { own: ids, foreign: [] }
    const sel = this.db.prepare('SELECT metadata_json FROM nodes WHERE node_id = ? AND tree_id = ?')
    const own: string[] = []
    const foreign: string[] = []
    for (const id of new Set(ids)) {
      const row = sel.get(id, this.treeId) as { metadata_json: string | null } | undefined
      // A writer the store could not tell apart (AMBIGUOUS_LANE) owns no
      // lane, its own earlier rows included: every target it names is
      // another's, recorded as a reference.
      if (row && (writer === AMBIGUOUS_LANE || laneWriterOf(parseMeta(row.metadata_json)) !== writer)) foreign.push(id)
      else own.push(id)
    }
    return { own, foreign }
  }

  /** Clear resume-pointer flags on superseded nodes (metadata-only update). */
  private applySupersedes(
    ids: string[] | undefined,
    supersededBy: string,
  ): { superseded?: string[]; supersedeMisses?: SupersedeMiss[] } {
    if (!ids || ids.length === 0) return {}
    const superseded: string[] = []
    const misses: SupersedeMiss[] = []
    const now = Date.now() / 1000
    const sel = this.db.prepare('SELECT metadata_json, read_only FROM nodes WHERE node_id = ? AND tree_id = ?')
    const upd = this.db.prepare('UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE node_id = ? AND tree_id = ?')
    for (const id of new Set(ids)) {
      if (id === supersededBy) { misses.push({ nodeId: id, reason: 'self' }); continue }
      const row = sel.get(id, this.treeId) as { metadata_json: string | null; read_only: number } | undefined
      if (!row) { misses.push({ nodeId: id, reason: 'not_found' }); continue }
      if (row.read_only) { misses.push({ nodeId: id, reason: 'read_only' }); continue }
      // retireMeta keeps what the pointer was — its flags and any earlier
      // retirement — so a writer's echo heal can put it back exactly if
      // this retirement was made under a wrong stamp (D240).
      const meta = retireMeta(parseMeta(row.metadata_json) ?? {}, supersededBy, now)
      upd.run(JSON.stringify(meta), now, id, this.treeId)
      superseded.push(id)
    }
    const out: { superseded?: string[]; supersedeMisses?: typeof misses } = { superseded }
    if (misses.length > 0) out.supersedeMisses = misses
    return out
  }

  /** Lazily-created fts5vocab('row') mirror of nodes_fts, for per-term
   *  document-frequency lookups. null = creation failed (e.g. read-only
   *  connection) — pruning is skipped for the store's lifetime. */
  private vocabReady: boolean | null = null

  private lookupDf(termLower: string): number {
    if (this.vocabReady === null) {
      try {
        this.db.exec(
          "CREATE VIRTUAL TABLE IF NOT EXISTS temp.nodes_fts_vocab USING fts5vocab(main, 'nodes_fts', 'row')",
        )
        this.vocabReady = true
      } catch {
        this.vocabReady = false
      }
    }
    if (!this.vocabReady) return 0
    const row = this.db
      .prepare('SELECT doc FROM temp.nodes_fts_vocab WHERE term = ?')
      .get(termLower) as { doc: number } | undefined
    return row ? Number(row.doc) : 0
  }

  /** Drop near-zero-IDF tokens (df > DF_PRUNE_FRACTION of the corpus) when
   *  at least one discriminative token remains. Ranking is untouched in
   *  practice — a dropped term's IDF contribution was ~0 — but the FTS
   *  scan no longer visits every row containing "the". Falls back to the
   *  full token list when everything is high-DF (a query of only common
   *  words must still match, just slowly). */
  private pruneHighDfTokens(tokens: string[]): string[] {
    if (tokens.length < 2) return tokens
    const unique = [...new Set(tokens)]
    if (unique.length < 2) return unique
    const totalRow = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }
    const total = Number(totalRow.c)
    if (total < DF_PRUNE_MIN_DOCS) return unique
    const cutoff = total * DF_PRUNE_FRACTION
    // Terms are stored post-tokenization (unicode61 case-folded); lowercase
    // approximates that (a diacritic-form miss reads as df 0).
    const dfs = new Map(unique.map((t) => [t, this.lookupDf(t.toLowerCase())]))
    const kept = unique.filter((t) => dfs.get(t)! <= cutoff)
    // Fall back to the full token list when pruning would change WHAT
    // matches, not just how fast: everything high-DF (kept is empty, so
    // every() is vacuously true), or every survivor absent from the
    // corpus (df 0 matches nothing — returning empty where the stopwords
    // used to match would be a recall regression).
    if (kept.every((t) => dfs.get(t) === 0)) return unique
    return kept
  }

  // ── Query (FTS5 bm25, scoped to this namespace) ─────────────────────
  async query(text: string, opts?: QueryOptions): Promise<QueryResult[]> {
    this.ensureOpen()
    const topK = opts?.topK ?? 5
    const sortBy = opts?.sortBy ?? 'relevance'
    const phrase = buildFtsMatch(this.pruneHighDfTokens(ftsTokens(text)))
    const metaFilter = opts?.metadataFilter
    const excludeNs = opts?.excludeNamespaces && opts.excludeNamespaces.length > 0
      ? new Set(opts.excludeNamespaces)
      : undefined
    const mediaFilter = opts?.mediaFilter
    // Recency fusion and adaptive counting both operate on a candidate
    // pool wider than topK; they only apply to lexical relevance ordering
    // (an explicit chronological sort already IS a recency decision).
    const recencyWeight = phrase && sortBy === 'relevance' ? (opts?.recencyWeight ?? 0) : 0
    const adaptive = !!(phrase && sortBy === 'relevance' && opts?.adaptive)
    const adaptiveMax = Math.max(1, opts?.adaptiveMax ?? topK * 3)
    let poolLimit = metaFilter || excludeNs || mediaFilter ? Math.max(topK * 5, 200) : topK
    if (recencyWeight > 0 || adaptive) {
      poolLimit = Math.max(poolLimit, topK * 4, adaptiveMax * 2, 50)
    }
    // FG-8: validated (0-10 per weight) before the vector ever reaches
    // bm25() — roleWeightVector throws synchronously on an out-of-range
    // weight, well before any SQL runs.
    const weights = roleWeightVector(opts?.roleWeights)

    const where: string[] = ['n.tree_id = ?']
    const params: unknown[] = [this.treeId]
    let fromClause = 'FROM nodes n'
    let scoreExpr = '0.0 AS score'
    // Params that bind to placeholders in the SELECT list (scoreExpr) — these
    // must precede `params` (WHERE/LIMIT) in the final bind list because they
    // appear earlier in the compiled SQL text.
    const selectParams: unknown[] = []
    if (phrase) {
      fromClause = 'FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid'
      where.unshift('nodes_fts MATCH ?')
      params.unshift(phrase)
      // FG-3: always all four weights, via the one shared helper — never a
      // bare `bm25(nodes_fts)` that would silently 1.0-default every column.
      // D183: a bookmark ranks below a chapter summary by a multiplier on
      // its score (bm25 is negative-better, so the factor shrinks it).
      scoreExpr = `bm25(nodes_fts, ?, ?, ?, ?) * (CASE WHEN json_extract(n.metadata_json, '$.kind') = '${BOOKMARK_KIND}' THEN ${BOOKMARK_RANK_FACTOR} ELSE 1.0 END) AS score`
      selectParams.push(...weights)
    }
    const scope = laneScopeSql(opts?.laneScope, 'n.')
    if (scope) { where.push(scope.sql); params.push(...scope.params) }
    if (opts?.timeRange?.after !== undefined) { where.push('n.created_at >= ?'); params.push(opts.timeRange.after) }
    if (opts?.timeRange?.before !== undefined) { where.push('n.created_at <= ?'); params.push(opts.timeRange.before) }

    let orderBy: string
    if (sortBy === 'chronological') orderBy = 'n.created_at ASC'
    else if (sortBy === 'reverse_chronological') orderBy = 'n.created_at DESC'
    else orderBy = phrase ? 'score ASC' : 'n.created_at DESC' // bm25: more-negative = better

    // Rank-then-fetch: the ranked pool query is SLIM — no content column —
    // so SQLite's sorter records stay small and no blob is materialized
    // (or zstd-decoded) for a row that never makes the final cut. Content
    // and summary are fetched below, for exactly the returned hits.
    const sql =
      `SELECT n.rowid AS rowid, n.node_id, n.created_at, n.metadata_json, n.session_key, n.index_len, n.preview_len, ${scoreExpr} ` +
      `${fromClause} WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`
    params.push(poolLimit)

    const rows = this.db.prepare(sql).all(...selectParams, ...params) as unknown as Array<{
      rowid: number
      node_id: string
      created_at: number
      metadata_json: string | null
      session_key: string | null
      index_len: number | null
      preview_len: number | null
      score: number
    }>

    interface SlimHit {
      rowid: number
      nodeId: string
      createdAt: number
      metadata: Record<string, unknown> | null
      sessionKey: string | null
      similarity: number
    }
    const out: SlimHit[] = []
    for (const r of rows) {
      // Columns are authoritative where present (G5): boundaries serve
      // under their metadata names sourced from the lift, so display
      // cuts and metadata_filter read the engine's truth.
      const meta = applyLiftedBoundaries(parseMeta(r.metadata_json), r.index_len, r.preview_len)
      if (metaFilter && !this.matchesMeta(meta, metaFilter)) continue
      if (excludeNs) {
        const ns = meta?.['_namespace']
        if (typeof ns === 'string' && excludeNs.has(ns)) continue
      }
      if (mediaFilter && !this.matchesMediaFilter(meta, mediaFilter)) continue
      out.push({
        rowid: r.rowid,
        nodeId: r.node_id,
        createdAt: r.created_at,
        metadata: meta,
        sessionKey: r.session_key,
        similarity: phrase ? -r.score : 0,
      })
      if (recencyWeight === 0 && !adaptive && out.length >= topK) break
    }

    let hits = out
    if (recencyWeight > 0) {
      // Reciprocal rank fusion of the lexical order with the same
      // candidates ranked by capture time. Rank-space on purpose: BM25
      // scores are unbounded and corpus-dependent, so a multiplicative
      // decay's tradeoff slope varies per query (measured: it banished
      // the strongest lexical hit to #44 where fusion kept it at #4) —
      // rank fusion pays one uniform price everywhere.
      const K = 60
      // Competition ranking: entries with EQUAL scores share a rank, so
      // recency decides exactly the case the spec names — equal lexical
      // strength. Insertion-order ranks would freeze ties forever.
      const lexRank = new Map<string, number>()
      for (let i = 0, rank = 0; i < hits.length; i++) {
        if (i > 0 && hits[i]!.similarity < hits[i - 1]!.similarity - 1e-9) rank = i
        lexRank.set(hits[i]!.nodeId, rank)
      }
      const recOrder = [...hits].sort((a, b) => b.createdAt - a.createdAt)
      const recRank = new Map<string, number>()
      for (let i = 0, rank = 0; i < recOrder.length; i++) {
        if (i > 0 && recOrder[i]!.createdAt < recOrder[i - 1]!.createdAt - 1e-9) rank = i
        recRank.set(recOrder[i]!.nodeId, rank)
      }
      hits = [...hits].sort((a, b) => {
        const fa = 1 / (K + lexRank.get(a.nodeId)!) + recencyWeight / (K + recRank.get(a.nodeId)!)
        const fb = 1 / (K + lexRank.get(b.nodeId)!) + recencyWeight / (K + recRank.get(b.nodeId)!)
        return fb - fa || lexRank.get(a.nodeId)! - lexRank.get(b.nodeId)!
      })
    }

    if (adaptive) {
      // Break detection reads the lexical score distribution. A fused
      // ordering is rank-shaped by construction (1/(K+i) terms) and has
      // no score breaks to find — so when fusion also ran, adaptive
      // falls back to the budget and says so (flat), rather than faking
      // a cut. Whether and how to cut a fused list is still an open bench
      // question.
      const applied = recencyWeight > 0
        ? { k: Math.min(topK, hits.length), confidence: 0, flat: true }
        : computeAdaptiveCount(hits.map((r) => r.similarity), topK, adaptiveMax)
      const finalK = Math.max(1, Math.min(applied.k, adaptiveMax, hits.length))
      opts?.onAdaptive?.({ returnedK: finalK, confidence: applied.confidence, flat: applied.flat })
      hits = hits.slice(0, finalK)
    } else {
      hits = hits.slice(0, topK)
    }

    // Fetch + decode content for the RETURNED hits only.
    const results: QueryResult[] = []
    // rowid of each hit, needed by the conversation_window neighbor/anchor
    // lookups (tie-break on created_at) — not part of the public QueryResult.
    const hitInfo = new Map<string, { rowid: number; sessionKey: string | null }>()
    if (hits.length > 0) {
      const placeholders = hits.map(() => '?').join(',')
      const contentRows = this.db
        .prepare(`SELECT rowid, content, summary FROM nodes WHERE rowid IN (${placeholders})`)
        .all(...hits.map((h) => h.rowid)) as unknown as Array<{ rowid: number; content: unknown; summary: string }>
      const byRowid = new Map(contentRows.map((r) => [r.rowid, r]))
      for (const h of hits) {
        const row = byRowid.get(h.rowid)
        if (!row) continue // deleted between the two statements — same connection, can't happen in practice
        results.push({
          nodeId: h.nodeId,
          // AC2d (amended by D1): hits return the full decoded content —
          // except rows carrying _index_len (C4 full-fidelity tool events),
          // which return the index view plus an availability marker so a
          // single hit can't flood the caller's context. Full text via
          // treecontext_export.
          content: presentContent(decodeContent(row.content as string | Buffer | null), h.metadata),
          summary: row.summary,
          similarity: h.similarity,
          depth: 0,
          isLeaf: true,
          createdAt: h.createdAt,
          metadata: h.metadata,
          ancestorChain: [],
        })
        hitInfo.set(h.nodeId, { rowid: h.rowid, sessionKey: h.sessionKey })
      }
    }

    // D186: every hit shows what refers to it, one hop deep, from the
    // reverse index — the newest referrer's id, writer, age and first
    // line, and the count. Never the referrer in full, never a second hop.
    const readAt = Date.now() / 1000
    for (const r of results) {
      const by = referencedBy(this.db, r.nodeId, readAt)
      if (by) r.referencedBy = by
    }

    const n = opts?.conversationWindow
    if (n !== undefined && n > 0) this.attachWindows(results, n, hitInfo, laneScopeSql(opts?.laneScope, ''))
    return results
  }

  // ── conversation_window (W1-W9) ──────────────────────────────────────
  /**
   * Attach a `window` (± n same-session neighbors + W9 anchor) to each hit,
   * in place. W7: hits are pre-claimed so they never double as a neighbor;
   * neighbors/anchor are assigned in hit-rank order (`hits` is already
   * ranked) so an overlap is claimed by the higher-ranked hit only.
   */
  private attachWindows(
    hits: QueryResult[],
    n: number,
    hitInfo: Map<string, { rowid: number; sessionKey: string | null }>,
    scope: { sql: string; params: unknown[] } | null = null,
  ): void {
    if (hits.length === 0) return
    // D150: a scoped search's windows stay inside the scope — a subagent
    // shares its orchestrator's session, so an unscoped neighbor would be
    // the orchestrator's own entry riding in beside the subagent's hit.
    const inScope = scope ? ` AND ${scope.sql}` : ''
    const sp = scope ? scope.params : []
    const claimed = new Set(hitInfo.keys())
    // Generous pool: bounds the number of already-claimed rows that can fall
    // within the fetched range across every hit processed so far. Cheap even
    // at the max (n=10, many hits) — each lookup is an indexed point query.
    const poolLimit = n * (hits.length + 2)

    const beforeStmt = this.db.prepare(
      `SELECT node_id, content, created_at, rowid, metadata_json, index_len, preview_len FROM nodes
       WHERE tree_id = ?
         AND session_key = ?
         AND (created_at < ? OR (created_at = ? AND rowid < ?))${inScope}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    const afterStmt = this.db.prepare(
      `SELECT node_id, content, created_at, rowid, metadata_json, index_len, preview_len FROM nodes
       WHERE tree_id = ?
         AND session_key = ?
         AND (created_at > ? OR (created_at = ? AND rowid > ?))${inScope}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    const anchorStmt = this.db.prepare(
      `SELECT node_id, content, created_at, rowid, metadata_json, index_len, preview_len FROM nodes
       WHERE tree_id = ?
         AND session_key = ?
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
         AND json_extract(metadata_json,'$.role') = 'user'${inScope}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )

    for (const hit of hits) {
      const session = resolveSessionKey(hitInfo.get(hit.nodeId)?.sessionKey, () => hit.metadata)
      if (session === NO_SESSION) {
        hit.window = { before: [], after: [], omitted: 'no-session-key' }
        continue
      }
      const hitRowid = hitInfo.get(hit.nodeId)!.rowid

      const beforeRows = beforeStmt.all(
        this.treeId, session, hit.createdAt, hit.createdAt, hitRowid, ...sp, poolLimit,
      ) as unknown as WindowRow[]
      const before: WindowEntry[] = []
      // beforeRows is nearest-first (DESC); collect unclaimed, then reverse
      // to chronological order (W3).
      for (const row of beforeRows) {
        if (before.length >= n) break
        if (claimed.has(row.node_id)) continue
        claimed.add(row.node_id)
        before.push(toWindowEntry(row, WINDOW_NEIGHBOR_MAX_CHARS))
      }
      before.reverse()

      const afterRows = afterStmt.all(
        this.treeId, session, hit.createdAt, hit.createdAt, hitRowid, ...sp, poolLimit,
      ) as unknown as WindowRow[]
      const after: WindowEntry[] = []
      for (const row of afterRows) {
        if (after.length >= n) break
        if (claimed.has(row.node_id)) continue
        claimed.add(row.node_id)
        after.push(toWindowEntry(row, WINDOW_NEIGHBOR_MAX_CHARS))
      }

      const window: ConversationWindow = { before, after }

      // W9: anchor rides the same switch, always computed (not a separate
      // knob). A hit that is itself a user message has no directive to
      // recover.
      if (hit.metadata?.['role'] === 'user') {
        window.anchor = null
      } else {
        const anchorRow = anchorStmt.get(this.treeId, session, hit.createdAt, hit.createdAt, hitRowid, ...sp) as
          | WindowRow
          | undefined
        if (!anchorRow) {
          window.anchor = null
        } else if (claimed.has(anchorRow.node_id)) {
          window.anchor = { ref: anchorRow.node_id }
        } else {
          claimed.add(anchorRow.node_id)
          window.anchor = toWindowEntry(anchorRow, ANCHOR_MAX_CHARS)
        }
      }

      hit.window = window
    }
  }

  private matchesMeta(
    meta: Record<string, unknown> | null,
    filter: Record<string, unknown>,
  ): boolean {
    if (!meta) return false
    for (const [k, v] of Object.entries(filter)) {
      if (meta[k] !== v) return false
    }
    return true
  }

  /** Same semantics as TreeContext.applyMediaFilter: entries without a
   *  media reference never match; filename is a substring match, extension
   *  exact, mimePrefix a prefix. */
  private matchesMediaFilter(
    meta: Record<string, unknown> | null,
    filter: MediaFilter,
  ): boolean {
    const media = meta?.['_media'] as MediaRef | undefined
    if (!media) return false
    if (filter.filename && !media.filename?.includes(filter.filename)) return false
    if (filter.extension && media.extension !== filter.extension) return false
    if (filter.mimePrefix && !media.mimeType?.startsWith(filter.mimePrefix)) return false
    return true
  }

  // ── Delete ──────────────────────────────────────────────────────────
  delete(nodeId: string): void {
    this.ensureOpen()
    // No content decode, no anchor bookkeeping (G2): the curated index
    // entry vanishes with the row, and the FK cascade takes the window
    // anchors — structural, not a calling convention.
    this.persistence.deleteNode(nodeId)
  }

  // ── Status / resume pointers ────────────────────────────────────────
  /** Newest resume pointers returned by status() — the orientation panel is
   *  a summary, not a dump; beyond this, the count says "clean up your
   *  pointers" (supersession hygiene). */
  static readonly MAX_RESUME_POINTERS = 20

  /** D167 (F5, D242): `lane` confines the resume pointers to one lane —
   *  a linked worktree's session orients on its own pointers first. */
  status(opts?: { lane?: string }): TreeStatus {
    this.ensureOpen()
    // Aggregates SQL-side — status() must not decode (zstd) every row of a
    // possibly-128MiB store at every session start. totalContentChars is the
    // STORED length (compressed bytes for blob rows): a size gauge, not an
    // exact decoded char count.
    const agg = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes ' +
          'FROM nodes WHERE tree_id = ?',
      )
      .get(this.treeId) as { n: number; bytes: number }
    // Only pointer-flagged rows are fetched and decoded (json_extract
    // renders JSON true as 1).
    const pointerRows = this.db
      .prepare(
        `SELECT node_id, content, created_at, metadata_json FROM nodes
         WHERE tree_id = ?
           AND (json_extract(metadata_json, '$.next_session') = 1
                OR json_extract(metadata_json, '$.status') = 'active')
         ORDER BY created_at DESC`,
      )
      .all(this.treeId) as unknown as Array<NodeRow & { content: unknown }>
    const allPointers = pointerRows.length
    if (opts?.lane !== undefined) {
      const lane = opts.lane
      const kept = pointerRows.filter((r) => laneWriterOf(parseMeta(r.metadata_json)) === lane)
      pointerRows.length = 0
      pointerRows.push(...kept)
    }
    // Cap to the newest N — an uncapped pointer list once produced a 62KB
    // status response off 40+ stale "active" pointers. resumePointerTotal
    // carries the real count so the consumer can say "showing 20 of N".
    const shown = pointerRows.slice(0, FlatStore.MAX_RESUME_POINTERS)
    // What each shown pointer superseded (D185): a retraction is the live
    // pointer, and status says which entry it took back. One pass over the
    // superseded rows, never one per pointer.
    const supersededBy = new Map<string, string[]>()
    if (shown.length > 0) {
      const ids = shown.map((r) => r.node_id)
      const rows = this.db
        .prepare(
          `SELECT node_id, json_extract(metadata_json, '$.superseded_by') AS by FROM nodes
            WHERE tree_id = ? AND json_extract(metadata_json, '$.superseded_by') IN (${ids.map(() => '?').join(',')})
            ORDER BY created_at DESC`,
        )
        .all(this.treeId, ...ids) as Array<{ node_id: string; by: string }>
      for (const r of rows) supersededBy.set(r.by, [...(supersededBy.get(r.by) ?? []), r.node_id])
    }
    const resumePointers: ResumePointer[] = shown.map((r) => ({
      nodeId: r.node_id,
      preview: decodeContent(r.content as string | Buffer | null).slice(0, 200),
      metadata: parseMeta(r.metadata_json) ?? {},
      createdAt: r.created_at,
      kind: checkpointKindOf(parseMeta(r.metadata_json)),
      ...(supersededBy.has(r.node_id) ? { supersedes: supersededBy.get(r.node_id)! } : {}),
    }))
    return {
      backend: 'lexical',
      totalNodes: agg.n,
      leafNodes: agg.n,
      internalNodes: 0,
      staleSummaryCount: 0,
      maxDepth: 0,
      totalContentChars: agg.bytes,
      totalSummaryChars: 0,
      staleNodeIds: [],
      resumePointers,
      resumePointerTotal: pointerRows.length,
      ...(opts?.lane !== undefined ? { resumePointerOtherLanes: allPointers - pointerRows.length } : {}),
      // Same stored-bytes gauge demoteOverBudget() steers by, so status
      // and the valve can never disagree about "over budget".
      retention: {
        storeBytes: agg.bytes,
        budgetBytes: this.maxStoreBytes,
        overBudget: agg.bytes > this.maxStoreBytes,
        sessionCap: this.maxSessions,
      },
    }
  }

  // ── Vitals ──────────────────────────────────────────────────────────
  /** Open threads decoded for a vitals reading. A display shows a handful;
   *  `openTotal` carries the real count so "8 of 30" stays sayable. */
  static readonly MAX_OPEN_THREADS = 8

  /** Minutes of staged-event history in `capturePerMinute`. */
  private static readonly CAPTURE_WINDOW_MIN = 10

  /**
   * The journal's observable health at `atSec` — see `JournalVitals`.
   *
   * Every window is measured from `atSec` rather than the wall clock, so
   * two readings of an unchanged store for the same moment are identical.
   * Callers pass their own moment (a drain's, a request's); this method
   * never reads the clock.
   *
   * COST, measured rather than assumed (711 nodes / 27 MB store, 2026-08-04):
   * the whole set runs in well under a millisecond, and the metadata scans
   * are the same 0.3 ms as the *indexed* resume-pointer lookup — content
   * lives in overflow pages, so walking the node b-tree never touches it.
   * That is why there are no indexes here beyond the resume-pointer one the
   * schema already carries: at this shape they would buy nothing, and the
   * retention valve caps the store long before a scan becomes interesting.
   * Re-measure before adding one.
   */
  vitals(atSec: number): JournalVitals {
    this.ensureOpen()
    const agg = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes ' +
          'FROM nodes WHERE tree_id = ?',
      )
      .get(this.treeId) as { n: number; bytes: number }

    // Curated = anything the agent wrote deliberately, i.e. everything the
    // drain did not label as its own. Stated as the complement so a future
    // source label counts as curated by default: a new kind of deliberate
    // note must not read as zero because nobody updated a list here.
    const curated = this.db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM nodes " +
          "WHERE tree_id = ? AND (source_label IS NULL OR source_label <> 'auto-capture')",
      )
      .get(this.treeId) as { n: number; newest: number | null }

    const entriesSince =
      curated.newest == null
        ? agg.n
        : (
            this.db
              .prepare('SELECT COUNT(*) AS n FROM nodes WHERE tree_id = ? AND created_at > ?')
              .get(this.treeId, curated.newest) as { n: number }
          ).n

    // Gaps are found by their metadata marker, never by matching the text
    // of the entry: content over ZSTD_MIN_BYTES is a compressed blob, and a
    // dead-letter tombstone (500 chars of error plus 500 of payload prefix)
    // is reliably over it. A `content LIKE '%[capture gap]%'` scan returns
    // zero on exactly the holes worth finding — a silent all-clear.
    const gaps = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE tree_id = ? " +
          "AND json_extract(metadata_json, '$.source') = 'capture-gap' " +
          // A MERGE-copy of a gap is another store's hole, not this drain's:
          // the merge path stamps _merge_label, so that is the discriminator
          // (M6). Import is NOT excluded — export→clear→import is a store's
          // own restore path, and a row that came back through it IS this
          // store's dead letter and must stay visible to doctor.
          "AND json_extract(metadata_json, '$._merge_label') IS NULL",
      )
      .get(this.treeId) as { n: number }

    const superseded = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE tree_id = ? " +
          "AND json_extract(metadata_json, '$.status') = 'superseded'",
      )
      .get(this.treeId) as { n: number }

    // Predicate written verbatim to match idx_nodes_resume_pointers — the
    // same rule status() follows, and the reason that index exists.
    const threadRows = this.db
      .prepare(
        `SELECT content, created_at, metadata_json FROM nodes
         WHERE tree_id = ?
           AND (json_extract(metadata_json, '$.next_session') = 1
                OR json_extract(metadata_json, '$.status') = 'active')
         ORDER BY created_at DESC`,
      )
      .all(this.treeId) as unknown as Array<{
      content: unknown
      created_at: number
      metadata_json: string | null
    }>

    const open: OpenThread[] = threadRows.slice(0, FlatStore.MAX_OPEN_THREADS).map((r) => {
      const meta = parseMeta(r.metadata_json) ?? {}
      const topicMeta = typeof meta['topic'] === 'string' ? (meta['topic'] as string).trim() : ''
      // Decode only the rows that will be shown — the cap is what keeps a
      // store full of stale "active" pointers from costing a zstd pass each.
      const lines = decodeContent(r.content as string | Buffer | null)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
      return {
        topic: topicMeta || lines[0] || 'untitled',
        line: (topicMeta ? lines[0] : lines[1]) ?? '',
        createdAt: r.created_at,
      }
    })

    // Staging is store-wide, not tree-scoped: a staged event has not been
    // attributed to a namespace yet — attributing it is what the drain does.
    // Post-020 rows carry their INTENDED namespace (the hook's stamp, C1),
    // but intent only becomes attribution when the drain lands the row.
    const staging = this.db
      .prepare(
        'SELECT COUNT(*) AS total, ' +
          'COALESCE(SUM(processed = 0), 0) AS unprocessed, ' +
          'COALESCE(SUM(processed = 0 AND attempts > 0), 0) AS retried, ' +
          'MIN(CASE WHEN processed = 0 THEN created_at END) AS oldest FROM staging',
      )
      .get() as { total: number; unprocessed: number; retried: number; oldest: number | null }

    const windowMin = FlatStore.CAPTURE_WINDOW_MIN
    const buckets = Array.from<number>({ length: windowMin }).fill(0)
    const rows = this.db
      .prepare(
        'SELECT CAST((? - created_at) / 60 AS INT) AS bucket, COUNT(*) AS n FROM staging ' +
          'WHERE created_at > ? AND created_at <= ? GROUP BY bucket',
      )
      .all(atSec, atSec - windowMin * 60, atSec) as Array<{ bucket: number; n: number }>
    for (const r of rows) {
      if (r.bucket >= 0 && r.bucket < windowMin) buckets[windowMin - 1 - r.bucket] = r.n
    }

    // Grouped rather than a list of conditional sums: an exit type or
    // intent added later must appear on its own, not vanish into a total
    // nobody updated. Costs ~0.4 ms per group at 800 nodes, measured.
    // The JSON path is BOUND, not interpolated. Both call sites pass a
    // literal today, so nothing is exploitable — but a helper that builds
    // SQL by concatenation is a shape that outlives the callers that made
    // it safe, and the next caller is the one that passes a variable.
    // HAVING rather than WHERE: the alias is only in scope after grouping.
    const tally = (path: string): Record<string, number> => {
      const out: Record<string, number> = {}
      const rows = this.db
        .prepare(
          'SELECT json_extract(metadata_json, ?) AS k, COUNT(*) AS n ' +
            'FROM nodes WHERE tree_id = ? GROUP BY k HAVING k IS NOT NULL',
        )
        .all(path, this.treeId) as Array<{ k: string; n: number }>
      for (const r of rows) out[String(r.k)] = r.n
      return out
    }

    const shape = this.db
      .prepare(
        // G5: the columns are the engine's truth. The session count now
        // runs the full identity ladder (the bare $.session_id extract
        // undercounted note-only sessions — the lift fixes it, ruled in
        // amendment 7).
        // NULLIF: the '__nosession__' sentinel is deliberately never
        // NULL in the column, but sessionless rows are not sessions —
        // the count must exclude the bucket exactly as the old NULL
        // extract did (G5 review). previewed counts rows with a REAL
        // preview boundary (a full tail behind the cut): the stricter
        // column semantics are the ruled meaning — a boundary equal to
        // the content length is no preview at all.
        "SELECT COALESCE(SUM(index_len IS NOT NULL), 0) AS previewed, " +
          'COUNT(DISTINCT NULLIF(session_key, ?)) AS sessions ' +
          'FROM nodes WHERE tree_id = ?',
      )
      .get(NO_SESSION, this.treeId) as { previewed: number; sessions: number }

    return {
      at: atSec,
      totalNodes: agg.n,
      storeBytes: agg.bytes,
      curated: { count: curated.n, newestAt: curated.newest, entriesSince },
      captureGaps: gaps.n,
      threads: { open, openTotal: threadRows.length, superseded: superseded.n },
      staging: {
        total: staging.total,
        unprocessed: staging.unprocessed,
        retried: staging.retried,
        oldestPendingAt: staging.oldest,
      },
      capturePerMinute: buckets,
      trail: {
        exits: tally('$.exit_type'),
        intents: tally('$.intent'),
        previewed: shape.previewed,
        sessions: shape.sessions,
      },
      retention: {
        storeBytes: agg.bytes,
        budgetBytes: this.maxStoreBytes,
        overBudget: agg.bytes > this.maxStoreBytes,
      },
    }
  }

  // ── Export / import / merge / clear ─────────────────────────────────
  exportJson(opts?: { maxExportNodes?: number; nodeId?: string; recordReliance?: boolean }): string {
    this.ensureOpen()
    const max = opts?.maxExportNodes ?? 5000
    const columns = `${EXPORT_COLUMNS} FROM nodes WHERE tree_id = ?`
    // node_id lookup must NOT go through the LIMIT-ed full scan: with more
    // than maxExportNodes rows in the store, the newest nodes (exactly the
    // resume pointers a cold start fetches by id) would silently fall past
    // the LIMIT and export as an empty node set. Flat store = no subtrees,
    // so an id export is a single-row lookup.
    const rows = opts?.nodeId
      ? this.db.prepare(`${columns} AND node_id = ?`).all(this.treeId, opts.nodeId)
      : this.db.prepare(`${columns} ORDER BY created_at ASC LIMIT ?`).all(this.treeId, max)
    if (opts?.nodeId && rows.length === 0) {
      // Match MemTree.exportJson semantics: a missing id is an explicit
      // error, not an empty export — a silent `nodes: []` is exactly what
      // masked the LIMIT bug this branch replaced.
      throw new NodeNotFoundError(`Node ${opts.nodeId} not found`)
    }
    if (opts?.nodeId && opts.recordReliance !== false) {
      // Reliance record (ruling 2026-07-23, option c): a single-entry
      // export IS the agent relying on this entry — query hits never
      // count (an agent may ignore them, and ranking must never feed on
      // itself), and the whole-journal branch above is backup/handoff,
      // not reliance. The counter's one consumer is retentionSweep,
      // where a session scores by its most-relied-on entry and relied-on
      // history evicts LAST — reordering only, never protection. It is
      // advisory bookkeeping: it must never break an export (read-only
      // opens land in the catch).
      //
      // recordReliance: false is the caller's policy hook — a read_only
      // server exports on every cold start and its contract is "never
      // mutates" (third-pass review).
      try {
        // Two row classes are excluded in the WHERE:
        // - read_only rows: "cannot be modified — only queried" is the
        //   import contract's letter, and a read-only row is already
        //   eviction-protected.
        // - CURRENT resume pointers (next_session/status=active): the
        //   session-start protocol ORDERS every agent to export these at
        //   every cold start, so counting them would make the meter
        //   measure ritual frequency, not reliance — the same
        //   self-feeding hazard the ruling's "query hits never count"
        //   clause excludes (third-pass review; flagged for the charter
        //   cold-read). A superseded pointer loses the flags and its
        //   later exports count like any other row's.
        // tree_id in the WHERE is belt-and-braces (C2): the tree-scoped
        // SELECT above already gates the bump and node ids are global
        // UUIDs, but with concurrent per-namespace writers this handle
        // must be structurally unable to touch another tree's rows.
        // Dual write (G2/amendment 8), healed from BOTH sides: the new
        // value is MAX(column, metadata) + 1, all read from the OLD row.
        // Metadata-ahead divergence (a backfill-skipped row, a foreign
        // import) still heals upward on its next bump, and a metadata
        // copy that LAGS the column — the updateNode MAX guard leaves
        // exactly that state after a stump restore — can no longer drag
        // the column back down (release-diff review 2026-08-15).
        this.db.prepare(
          "UPDATE nodes SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$._relied_count', " +
            "MAX(relied_count, COALESCE(json_extract(metadata_json, '$._relied_count'), 0)) + 1), " +
            "relied_count = MAX(relied_count, COALESCE(json_extract(metadata_json, '$._relied_count'), 0)) + 1 " +
            'WHERE node_id = ? AND tree_id = ? AND read_only = 0 ' +
            "AND COALESCE(json_extract(metadata_json, '$.next_session'), 0) != 1 " +
            "AND COALESCE(json_extract(metadata_json, '$.status'), '') != 'active'",
        ).run(opts.nodeId, this.treeId)
      } catch {
        /* reliance is bookkeeping; the export itself must succeed */
      }
    }
    // A single-entry fetch shows what refers to it, one hop deep (D186) —
    // the deliberate step that walks a reference chain one link further.
    // The whole-journal export is a portable backup and stays as stored.
    const by = opts?.nodeId ? referencedBy(this.db, opts.nodeId) : null
    const nodes = rows.map((r) => ({ ...exportNode(r), ...(by ? { referencedBy: by } : {}) }))
    // `exported_by`: the exporting machine's self-description, the first
    // piece of the file's own head (D172, D223) — a claim when imported.
    return JSON.stringify({
      version: 1, namespace: this.namespace, exported_by: exporterName(),
      nodes,
    })
  }

  /**
   * The rows of a handoff (features/journal-handoff.feature; D170, D177),
   * oldest first. `summaries` — the default handoff — is the chapter
   * summaries and the subagent summaries of this lane and nothing else: a
   * chapter summary is a live `next_session` pointer that is not a
   * bookmark, a subagent summary is a row whose metadata `kind` is
   * `subagent-summary` (the orchestration chunk stamps it from the
   * SubagentStop capture). `whole` is every row of the lane. `limit` is
   * the inline cap: when given, the NEWEST `limit` rows are returned
   * (still oldest first) and `total` says how many the form holds, so the
   * caller can state what was omitted. A file-bound export passes no limit
   * — content bound to a file carries no cap (D170).
   */
  /**
   * D148: one writer's trail on its own — every row whose lane is that
   * writer's (a role, one subagent instance's agent id, `worktree:<name>`,
   * or `main`, which as the lane key says includes the older rows naming
   * no writer at all; a role includes the older rows whose `agent_type`
   * claims it and that carry no stamp, as the lane key reads them), the newest `limit`, returned oldest first, with
   * the total so a capped trail says what it left out. Attribution
   * metadata, not a namespace (D196): the session the writer shared with
   * its orchestrator is not consulted.
   */
  writerTrail(writer: string, limit: number): { nodes: ExportedNode[]; total: number } {
    this.ensureOpen()
    const w = "json_extract(metadata_json, '$._writer')"
    const where = writer === MAIN_WRITER
      ? `tree_id = ? AND COALESCE(${w}, '${MAIN_WRITER}') = '${MAIN_WRITER}'
          AND json_extract(metadata_json, '$.agent_type') IS NULL
          AND COALESCE(json_extract(metadata_json, '$._writer_src'), '') != 'ambiguous'
          AND COALESCE(session_key, '') NOT LIKE '${HANDOFF_LANE_PREFIX}%'`
      : `tree_id = ? AND (${w} = ? OR json_extract(metadata_json, '$._writer_agent_id') = ?
          OR (${w} IS NULL AND json_extract(metadata_json, '$.agent_type') = ?))`
    const params = writer === MAIN_WRITER ? [this.treeId] : [this.treeId, writer, writer, writer]
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(...params) as { n: number }).n)
    const rows = this.db.prepare(
      `${EXPORT_COLUMNS} FROM nodes WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>
    return { nodes: rows.reverse().map((r) => exportNode(r)), total }
  }

  handoffRows(form: 'summaries' | 'whole', limit?: number): { nodes: ExportedNode[]; total: number } {
    this.ensureOpen()
    const where = form === 'whole'
      ? 'tree_id = ?'
      : 'tree_id = ? AND ('
        + "(json_extract(metadata_json, '$.next_session') = 1 "
        + `AND COALESCE(json_extract(metadata_json, '$.kind'), '') != '${BOOKMARK_KIND}') `
        + `OR json_extract(metadata_json, '$.kind') = '${SUBAGENT_SUMMARY_KIND}')`
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where}`).get(this.treeId) as { n: number }).n)
    const rows = limit === undefined
      ? this.db.prepare(`${EXPORT_COLUMNS} FROM nodes WHERE ${where} ORDER BY created_at ASC, node_id ASC`).all(this.treeId)
      : (this.db.prepare(`${EXPORT_COLUMNS} FROM nodes WHERE ${where} ORDER BY created_at DESC, node_id DESC LIMIT ?`)
          .all(this.treeId, Math.max(0, limit)) as Array<Record<string, unknown>>).reverse()
    return { nodes: (rows as Array<Record<string, unknown>>).map((r) => exportNode(r)), total }
  }

  /**
   * Import an export file. Everything new lands; anything truly already
   * present ANYWHERE in the store is left alone and counted, never a
   * failure (D164). "Already present", in order:
   *   1. identity — the entry's node id is a row in any lane of this
   *      store, or the `_merged_from_node_id` back-pointer of one (D144's
   *      pointer, consulted store-wide). The per-lane id check this
   *      replaced is the 2026-10-05 same-store import crash: an id held by
   *      another lane passed it and hit the primary key.
   *   2. content — only for an entry the file carries no id for, by the
   *      same class-scoped predicate insert() uses.
   * An id present with DIFFERENT content is left alone too, and counted
   * apart as an id conflict, so divergence is disclosed, never overwritten.
   *
   * `handoff` (the MCP tool's door, D165): every entry lands marked as
   * imported from that file by the importer, the file's claims kept as
   * data, in a lane of the sender's own (see ./handoff.ts). Without it the
   * import is the faithful round-trip the archive restore relies on (M6,
   * D48): metadata as written, and a demoted stump restored in place.
   */
  async importJson(
    json: string,
    opts?: { label?: string; readOnly?: boolean; handoff?: { file: string; importer: string | null }; fromFile?: boolean },
  ): Promise<ImportResult> {
    this.ensureOpen()
    // The caps protect the conversation, not the store (D170): content
    // pasted through the tool is held to them; a file read by the server
    // itself (`fromFile`, the path door of D199) carries none.
    const capped = opts?.fromFile !== true
    if (capped && json.length > IMPORT_MAX_JSON_BYTES) throw new Error('Import JSON exceeds size limit')
    const parsed = JSON.parse(json) as { nodes?: unknown[] } & Record<string, unknown>
    if (!Array.isArray(parsed.nodes)) throw new Error('Import JSON must have a "nodes" array')
    const importNodes = parsed.nodes
    if (capped && importNodes.length > IMPORT_MAX_NODES) throw new Error('Import exceeds node limit')
    const label = opts?.label ?? `import-${Date.now()}`
    const handoff: HandoffSource | null = opts?.handoff
      ? { file: opts.handoff.file, importer: opts.handoff.importer, sender: claimedSender(parsed) }
      : null
    let importedCount = 0
    let alreadyPresent = 0
    let idConflicts = 0
    let skippedEmpty = 0
    let skippedMalformed = 0
    let claimsArchived = 0
    // One transaction for the whole import: a mid-loop failure (bad row,
    // id collision from a foreign store) must not leave a partial import
    // behind the throw (round-2 review, R2). Dedup state now lives in the
    // store, so it rolls back WITH the transaction — the fp-map snapshot
    // machinery this wrapper used to need (round-3, S3) retired with the
    // maps.
    this.db.transaction(() => {
      // Identity is store-wide (D164): every lane's ids, and every lane's
      // back-pointers, read inside the transaction so the view is one.
      const byId = this.db.prepare('SELECT tree_id, content, metadata_json FROM nodes WHERE node_id = ?')
      const carried = new Set(
        (this.db
          .prepare(
            "SELECT json_extract(metadata_json, '$._merged_from_node_id') AS src FROM nodes " +
              "WHERE json_extract(metadata_json, '$._merged_from_node_id') IS NOT NULL",
          )
          .all() as Array<{ src: string }>).map((r) => String(r.src)),
      )
      const importedAt = Date.now() / 1000
      // Content, where the file carries no id, is matched in EVERY lane
      // of the store, handoff lanes included: the curated index leaves
      // those out (D221), but an id-less file imported twice must still
      // land once.
      const curatedAnywhere = this.db.prepare(
        "SELECT 1 FROM nodes WHERE fingerprint = ? AND dedup_class = 'curated' LIMIT 1",
      )
      // Sessions this store archived (tombstones). An entry claiming one
      // is likely this store's own archive pasted back through the import
      // door, which lands as a handoff (D222) — counted, so the reply
      // can say so.
      const archived = handoff
        ? new Set((this.db.prepare(
            "SELECT json_extract(metadata_json, '$._archived_session') AS s FROM nodes " +
              "WHERE json_extract(metadata_json, '$._archived_session') IS NOT NULL",
          ).all() as Array<{ s: unknown }>).map((r) => String(r.s)))
        : new Set<string>()
      for (const raw of importNodes) {
        // Nothing is refused (D165): an entry that is not an object at all
        // cannot land, and is counted rather than failing the import.
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { skippedMalformed++; continue }
        const n = raw as Record<string, unknown>
        const content = String(n['content'] ?? '')
        if (!content) { skippedEmpty++; continue }
        const fp = contentFingerprint(content)
        const now = Date.now() / 1000
        const claimed = (n['metadata'] as Record<string, unknown> | null) ?? null
        const meta = handoff ? handoffMetadata(claimed, handoff, importedAt) : claimed
        // On the handoff door the importer, not the file, sets the row's
        // own columns (D165): the source is derived from the entry's
        // descriptive metadata exactly as insert() derives it.
        const sourceLabel = handoff ? effectiveSource(null, meta) : (n['sourceLabel'] as string | null) ?? null
        if (handoff && archived.size > 0 && claimed && archived.has(sessionOf(claimed))) claimsArchived++
        // The sender's own moment, kept as written (D151, D184): a skewed
        // clock is disclosed where it is read, never corrected here.
        const createdAt = Number(n['createdAt'] ?? now)
        const fileId = typeof n['nodeId'] === 'string' && n['nodeId'] !== '' ? n['nodeId'] : null
        // M6: a plain import (no handoff) stamps NO provenance. An earlier
        // fix marked capture-gap rows with `_imported_from` to hide them
        // from doctor, but the documented restore path is export → clear →
        // import: after it, a store's OWN dead letters carry
        // `_imported_from` forever and are invisible to doctor for good.
        // The handoff door's `_handoff_*` marks are a different animal: a
        // teammate's gap IS not this drain's hole, and doctor still sees it.
        if (fileId !== null) {
          const existing = byId.get(fileId) as
            | { tree_id: number; content: string | Buffer | null; metadata_json: string | null }
            | undefined
          if (existing !== undefined) {
            let existingContent: string | null
            try { existingContent = decodeContent(existing.content) } catch { existingContent = null }
            // Ruled 2026-07-31 (replace-when-stump): importing an archive
            // whose node still lives in this lane as a demoted stump
            // RESTORES the full row — the demotion archive's whole
            // recovery path. A handoff never restores: its rows are
            // marked, and a teammate's file is not this store's archive.
            const isStump = !handoff && existing.tree_id === this.treeId && existingContent !== null &&
              parseMeta(existing.metadata_json)?.['_demoted'] === true && content.length > existingContent.length
            if (isStump) {
              // updateNode re-stamps the arbiter columns from the restored
              // content and drops the stump's now-stale window anchors,
              // all in this transaction (amendment 8).
              this.persistence.updateNode(this.persistedNode(fileId, content, n, meta, sourceLabel, createdAt, now, opts))
              if (dedupClassOf(sourceLabel, meta) === 'auto') {
                this.persistence.upsertAnchor(this.treeId, sessionOf(meta), fp, fileId, createdAt)
              }
              importedCount++
              continue
            }
            if (existingContent === content) alreadyPresent++
            else idConflicts++
            continue
          }
          if (carried.has(fileId)) { alreadyPresent++; continue }
        } else if (
          this.isDuplicateInStore(fp, sourceLabel, meta, createdAt)
          || (dedupClassOf(sourceLabel, meta) === 'curated' && curatedAnywhere.get(fp) !== undefined)
        ) {
          // Content is the check only where the file carries no identity
          // (D164): content alone cannot tell a repeat from a second
          // observation, which is the merge defect of 2026-10-05.
          alreadyPresent++
          continue
        }
        const nodeId = fileId ?? randomUUID().replace(/-/g, '')
        if (!this.persistence.insertNode(this.treeId, this.persistedNode(nodeId, content, n, meta, sourceLabel, createdAt, now, opts))) {
          // The curated index refused a twin: a plain import into a lane
          // that already holds the same curated content. Never a handoff,
          // whose lane the index leaves out (D221): there identity alone
          // decides. Present by content, structurally — never a failure.
          alreadyPresent++
          continue
        }
        if (dedupClassOf(sourceLabel, meta) === 'auto') {
          this.persistence.upsertAnchor(this.treeId, sessionOf(meta), fp, nodeId, createdAt)
        }
        importedCount++
      }
    })
    return {
      importedCount, label, alreadyPresent, idConflicts, skippedEmpty, skippedMalformed,
      ...(handoff ? { sender: handoff.sender, claimsArchivedSessions: claimsArchived } : {}),
    }
  }

  private persistedNode(
    nodeId: string, content: string, n: Record<string, unknown>, meta: Record<string, unknown> | null,
    sourceLabel: string | null, createdAt: number, now: number,
    opts?: { readOnly?: boolean; handoff?: unknown },
  ): PersistedNode {
    // The handoff door's row columns are the importer's (D165): read-only
    // as the importer chose (default true, the tool's default), never
    // decay-exempt, the default utility — whatever the file claims.
    const handoff = opts?.handoff !== undefined
    return {
      nodeId,
      treeId: this.treeId,
      parentId: null,
      depth: 0,
      isLeaf: true,
      content,
      summary: String(n['summary'] ?? ''),
      createdAt,
      updatedAt: Number(n['updatedAt'] ?? now),
      summaryStale: false,
      readOnly: handoff ? (opts?.readOnly ?? true) : opts?.readOnly ?? Boolean(n['readOnly']),
      decayExempt: handoff ? false : Boolean(n['decayExempt']),
      utilityScore: handoff ? 0.5 : Number(n['utilityScore'] ?? 0.5),
      sourceLabel,
      metadata: meta,
    }
  }

  /**
   * THE copy body, shared by the namespace merge and the store merge
   * (docs/project-identity.md §5: "generalize the row-reader to accept a
   * source outside the current namespace, and keep the copy body
   * byte-identical"). Every divergence between the two callers is a
   * parameter here, so the reviewed path stays one path.
   *
   * `preserveIds` (O1/A8) turns the cross-store semantics on: the source
   * `node_id` is kept, and its presence in the destination tree is
   * checked FIRST — ahead of the content predicate, whose
   * fingerprint-based answer D2 already calls unreliable. That ordering
   * is what makes a re-run import exactly zero rather than approximately
   * zero. Within one store the ids are freshly minted and cannot
   * collide, so the namespace merge leaves the check off and its
   * behaviour is unchanged.
   *
   * Runs inside the caller's transaction.
   */
  private copyRowsInto(
    treeId: number,
    rows: Array<NodeRow & {
      node_id: string
      read_only: number; decay_exempt: number; decay_rate: number | null; utility_score: number
    }>,
    opts: {
      label: string
      sourceNamespace: string
      /** D3: for a cross-STORE merge the meaningful provenance is the
       *  source store, not its namespace. Absent for a namespace merge. */
      sourceStore?: string
      readOnly?: boolean
      preserveIds: boolean
    },
  ): MergeCounts {
    const now = Date.now() / 1000
    let imported = 0
    let skippedDuplicate = 0
    let skippedExistingId = 0
    let skippedIdConflict = 0
    let skippedUndecodable = 0
    let skippedEmpty = 0
    // D144: idempotence by IDENTITY for the namespace merge. Ids are
    // freshly minted here, so the id check above cannot serve; instead
    // every copy carries `_merged_from_node_id`, and the set of source
    // ids already carried into this tree is consulted BEFORE the content
    // predicate. The predicate alone cannot tell "already carried across"
    // from "a second observation": the auto-capture anchor is one row per
    // (session, fingerprint), so two legitimate same-session occurrences
    // further apart than the dedup window flipped it on every run and
    // both re-imported each time (verified 2026-10-05, two frozen copies
    // per run). The cross-store merge keeps its ids and needs none of
    // this, so the set stays empty there and the path is unchanged.
    const carried = new Set<string>()
    if (!opts.preserveIds) {
      const pointers = this.db
        .prepare(
          "SELECT json_extract(metadata_json, '$._merged_from_node_id') AS src FROM nodes " +
            "WHERE tree_id = ? AND json_extract(metadata_json, '$._merged_from_node_id') IS NOT NULL",
        )
        .all(treeId) as Array<{ src: string }>
      for (const p of pointers) carried.add(p.src)
    }
    for (const r of rows) {
      if (!opts.preserveIds && carried.has(r.node_id)) {
        // Present by back-pointer: the same idempotent class the
        // cross-store merge counts as present-by-id, so it shares the
        // bucket and the H5 reconciliation holds unchanged.
        skippedExistingId++
        continue
      }
      // H2: a v24 store can hold a row `decodeContent` cannot read (024's
      // own log expects them), and the throw used to abort the whole merge
      // with a raw stack AFTER backups were written. Skip the row, count
      // it, and let the rest of the merge land.
      let content: string
      try {
        content = decodeContent(r.content as unknown as string | Buffer | null)
      } catch {
        skippedUndecodable++
        continue
      }
      // H5: an empty-content row used to vanish uncounted, so the disclosed
      // numbers did not sum to srcTotal. It is a skip like any other.
      if (!content) { skippedEmpty++; continue }
      const fp = contentFingerprint(content)
      const meta = parseMeta(r.metadata_json)
      const nodeId = opts.preserveIds ? r.node_id : randomUUID().replace(/-/g, '')
      // A8: the preserved id is the idempotence key and it is consulted
      // BEFORE the content predicate. A row already carried across is
      // present by id, and saying so as its own count keeps a re-run's
      // zero distinguishable from a dedup collapse.
      if (opts.preserveIds) {
        const existing = this.db
          .prepare('SELECT content FROM nodes WHERE node_id = ?')
          .get(nodeId) as { content: string | Buffer | null } | undefined
        if (existing !== undefined) {
          // H1: the id is present, but is it the SAME row? An id already
          // carried across holds identical content — the idempotent case,
          // counted as already-present. A DIFFERENT content under that id
          // means a distinct row wears it (id reuse across foreign stores):
          // report it as an id conflict, the one skip class that means
          // possible divergence, and never overwrite the destination.
          let sameContent: boolean
          try {
            sameContent = decodeContent(existing.content) === content
          } catch {
            // The destination row cannot be read to compare — treat as a
            // conflict, since idempotence cannot be proven.
            sameContent = false
          }
          if (sameContent) skippedExistingId++
          else skippedIdConflict++
          continue
        }
      }
      if (this.isDuplicateInTree(treeId, fp, r.source_label, meta, r.created_at)) {
        skippedDuplicate++
        continue
      }
      // Protection travels with the row: a decay-exempt or read-only source
      // entry stays exempt in the trunk — merging must never turn a
      // protected finding into demotable bulk. `opts.readOnly` can only
      // ADD protection (merge-as-frozen), never remove it. Provenance:
      // rows written through a server already carry `_namespace`; stamp
      // library-written rows with their source namespace so merged
      // provenance is filterable either way.
      // The tool schema says the label is recorded ON the merged entries,
      // not just echoed in the response (round-2 review, R3).
      const metadata: Record<string, unknown> = { ...meta, _merge_label: opts.label }
      if (metadata['_namespace'] === undefined) metadata['_namespace'] = opts.sourceNamespace
      if (opts.sourceStore !== undefined) metadata['_merge_source_store'] = opts.sourceStore
      // D144: the pointer back to the source entry — what makes the next
      // run exactly zero, and what a supersession could one day chase.
      if (!opts.preserveIds) metadata['_merged_from_node_id'] = r.node_id
      const node: PersistedNode = {
        nodeId, treeId, parentId: null, depth: 0, isLeaf: true,
        content, summary: r.summary,
        createdAt: r.created_at, updatedAt: now, summaryStale: false,
        readOnly: (opts.readOnly ?? false) || r.read_only !== 0,
        decayExempt: r.decay_exempt !== 0,
        decayRate: r.decay_rate ?? undefined,
        utilityScore: r.utility_score,
        sourceLabel: r.source_label, metadata,
      }
      // The curated unique index refused a twin the predicate above did
      // not see (a same-run duplicate resolved mid-loop). Same outcome as
      // the predicate's skip, so it counts the same way.
      if (!this.persistence.insertNode(treeId, node)) { skippedDuplicate++; continue }
      if (dedupClassOf(r.source_label, meta) === 'auto') {
        this.persistence.upsertAnchor(treeId, sessionOf(meta), fp, nodeId, r.created_at)
      }
      if (!opts.preserveIds) carried.add(r.node_id)
      imported++
    }
    return {
      imported, skippedDuplicate, skippedExistingId, skippedIdConflict,
      skippedUndecodable, skippedEmpty, srcTotal: rows.length,
    }
  }

  mergeFromNamespace(
    sourceNamespace: string,
    opts: { label: string; nodeId?: string; readOnly?: boolean },
  ): {
    importedCount: number; label: string; sourceNamespace: string; replaced: boolean
    /** A7/§5.3: a run that dropped half its input to the dedup predicate
     *  used to look identical to a clean one. Additive. */
    skippedDuplicate: number
    /** D144: entries already carried into this namespace by an earlier
     *  merge, found by their back-pointer. A re-run's zero reads as "all
     *  present", not as "nothing to merge". Additive. */
    skippedAlreadyMerged: number
  } {
    this.ensureOpen()
    if (sourceNamespace === this.namespace) {
      throw new Error(`Source namespace '${sourceNamespace}' is the current namespace`)
    }
    let counts: MergeCounts = {
      imported: 0, skippedDuplicate: 0, skippedExistingId: 0, skippedIdConflict: 0,
      skippedUndecodable: 0, skippedEmpty: 0, srcTotal: 0,
    }
    // One transaction, same discipline as importJson: a mid-loop failure
    // must not commit a partial branch (round-3 review, S7 — dedup state
    // now rolls back with the transaction itself). The source READ sits
    // inside the same transaction (C2, design note): another process —
    // the drain owner, or the source namespace's own tool server — may be
    // writing the source tree, and the read, the dedup re-checks, and the
    // copy must all see one consistent view; immediate mode takes the
    // write lock up front, so that view cannot be invalidated mid-merge.
    this.db.transaction(() => {
    // opts.nodeId scopes the merge to one source entry — the tool schema
    // has promised this since the surface landed; the filter was silently
    // missing (round-2 review, R3).
    const rows = this.db
      .prepare(
        'SELECT n.node_id, n.content, n.summary, n.created_at, n.source_label, n.metadata_json, ' +
          'n.read_only, n.decay_exempt, n.decay_rate, n.utility_score ' +
          'FROM nodes n JOIN trees t ON t.tree_id = n.tree_id ' +
          'WHERE t.namespace = ? AND t.ensemble_index = 0' +
          (opts.nodeId !== undefined ? ' AND n.node_id = ?' : ''),
      )
      .all(...(opts.nodeId !== undefined ? [sourceNamespace, opts.nodeId] : [sourceNamespace])) as unknown as Array<
        NodeRow & {
          node_id: string
          read_only: number; decay_exempt: number; decay_rate: number | null; utility_score: number
        }
      >
    if (opts.nodeId !== undefined && rows.length === 0) {
      throw new Error(`Node '${opts.nodeId}' not found in namespace '${sourceNamespace}'`)
    }
    counts = this.copyRowsInto(this.treeId, rows, {
      label: opts.label,
      sourceNamespace,
      ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
      preserveIds: false,
    })
    })
    return {
      importedCount: counts.imported, label: opts.label, sourceNamespace, replaced: false,
      skippedDuplicate: counts.skippedDuplicate,
      skippedAlreadyMerged: counts.skippedExistingId,
    }
  }

  /**
   * Copy EVERY namespace of an ATTACHed source store into this store
   * (docs/project-identity.md §5, §5.1, §11c F3).
   *
   * The caller has already ATTACHed the source database under `alias` on
   * this same connection and holds the `drain` lease on this store (A4).
   * One connection means the transaction discipline of the namespace
   * merge carries over unchanged; the whole cross-namespace copy runs in
   * ONE immediate transaction, so the reads, the dedup re-checks and the
   * writes all see one view.
   *
   * Atomicity across attached databases: SQLite does NOT provide it in
   * WAL mode, and this does not need it — the source is only READ and
   * only this database is written, so the single-database atomicity the
   * namespace merge already relies on is exactly the guarantee required.
   * Do not "fix" this into a two-database commit; there isn't one.
   *
   * A5 (verified against better-sqlite3 13.0.2 / SQLite 3.53.4 at build
   * time): the driver is NOT built with SQLITE_OPEN_URI, so
   * `ATTACH 'file:…?mode=ro'` fails outright with "unable to open
   * database" and a plain ATTACH is read-WRITE. `PRAGMA query_only`
   * cannot stand in — it is connection-wide and would block the writes to
   * THIS database too. So read-only is a property of this code, not of
   * the handle: nothing below ever names `<alias>.` on the left of a
   * write, and the guarantee the user is given comes from the drain lease
   * and the mandatory backups instead (§11c A5). A statement writing
   * through the alias would compile and run — that is the hazard this
   * paragraph exists to fence.
   */
  mergeFromAttachedStore(
    opts: { alias?: string; label: string; sourceStore: string; readOnly?: boolean },
  ): { perNamespace: NamespaceCounts[]; label: string; sourceStore: string } {
    this.ensureOpen()
    const alias = opts.alias ?? MERGE_SRC_ALIAS
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`Unsafe attach alias '${alias}'`)
    const perNamespace: NamespaceCounts[] = []
    this.db.transaction(() => {
      const read = this.db.prepare(
        'SELECT n.node_id, n.content, n.summary, n.created_at, n.source_label, n.metadata_json, ' +
          'n.read_only, n.decay_exempt, n.decay_rate, n.utility_score ' +
          `FROM ${alias}.nodes n JOIN ${alias}.trees t ON t.tree_id = n.tree_id ` +
          'WHERE t.namespace = ? AND t.ensemble_index = 0',
      )
      // F3: once per SOURCE namespace, into the same-named namespace of
      // this store, created when missing. Copying only 'project' would
      // silently drop a predecessor's agent lanes.
      for (const namespace of attachedNamespaces(this.db, alias)) {
        const treeId = this.persistence.ensureTree(0, namespace)
        const rows = read.all(namespace) as unknown as Array<
          NodeRow & {
            node_id: string
            read_only: number; decay_exempt: number; decay_rate: number | null; utility_score: number
          }
        >
        const counts = this.copyRowsInto(treeId, rows, {
          label: opts.label,
          sourceNamespace: namespace,
          sourceStore: opts.sourceStore,
          ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
          preserveIds: true,
        })
        perNamespace.push({ namespace, ...counts })
      }
    })
    return { perNamespace, label: opts.label, sourceStore: opts.sourceStore }
  }

  clear(): { cleared: boolean; previousNodeCount: number } {
    this.ensureOpen()
    const rows = this.allRows()
    // One transaction (G2): a crash mid-clear must not leave a
    // half-emptied namespace — all rows, their FTS entries, and (via the
    // FK cascade) their window anchors go together or not at all.
    this.db.transaction(() => {
      for (const r of rows) this.persistence.deleteNode(r.node_id)
    })
    this.unshrinkable.clear()
    if (rows.length > 0) this.maybeVacuum()
    return { cleared: true, previousNodeCount: rows.length }
  }

  // ── Retention (D6: session-count primary, entry-count safety net) ────
  /**
   * Hard-delete auto-capture beyond the session/entry bounds, then (C3)
   * demote oldest-first non-protected rows back to their index text when
   * the store-byte budget is still exceeded. Protected (authored /
   * decay-exempt / read-only / resume-pointer) nodes are never touched by
   * either step.
   */
  retentionSweep(): { evicted: number; demoted: number } {
    this.ensureOpen()
    this.insertsSinceSweep = 0
    // Sweeps lease at fire time (amendment 7): the trigger is the 50th
    // insert in WHICHEVER process inserts, and library writers hold no
    // standing role — so the sweep itself must take sweep:<namespace>
    // or skip. Refusal is not an error: another process is already
    // sweeping this namespace, and the next trigger retries. The
    // archive-then-delete interleaving below was designed for one
    // sweeper per namespace; leasing is cheaper than a two-sweeper
    // interleaving audit (store-as-arbiter §3).
    const lease = (this.leaseClient ??= new LeaseClient(this.db, { pid: process.pid, host: hostname(), label: `sweep:${this.namespace}` }))
    return this.retentionSweepUnderLease(lease)
  }

  /** Heartbeat the sweep lease and report whether it is still ours.
   *  ONE primitive for the renew-then-check protocol (pass-2 review
   *  2026-08-15: three verbatim copies invited a fourth long phase to
   *  copy the renew line without the check, resurrecting the
   *  two-sweeper interleaving) — FAIL-CLOSED via renewStrict (pass-3:
   *  a thrown renew is evidence of a competing writer, not a
   *  go-ahead). The lease is threaded, not re-read from the field, so
   *  the compiler proves every sweep phase runs under one. */
  private sweepLeaseHeld(lease: LeaseClient, context: string, extra: Record<string, unknown> = {}): boolean {
    if (lease.renewStrict(`sweep:${this.namespace}`)) return true
    dbg('retention', `sweep lease not provably held ${context} — aborting the remainder`, extra)
    return false
  }

  private retentionSweepUnderLease(lease: LeaseClient): { evicted: number; demoted: number } {
    try {
      lease.tryAcquire(`sweep:${this.namespace}`, SWEEP_LEASE_TTL_SECS)
    } catch {
      // ANY acquisition failure skips the sweep — a held lease, a busy
      // store, anything. The sweep is amortized housekeeping riding a
      // user's insert(): that insert has already committed, and it must
      // never surface a failure for work it did not ask for (G4 review,
      // finding 3). The next trigger retries.
      return { evicted: 0, demoted: 0 }
    }
    try {
      // The sweep blocks the event loop; give the owning process's
      // interval-renewed leases their full TTL of headroom first.
      try { this.maintenanceHeartbeat?.() } catch { /* best-effort */ }
      return this.runRetentionSweep(lease)
    } finally {
      try {
        lease.release(`sweep:${this.namespace}`)
      } catch {
        /* TTL expiry reclaims it */
      }
    }
  }

  private runRetentionSweep(lease: LeaseClient): { evicted: number; demoted: number } {
    const rows = this.db
      .prepare(
        'SELECT node_id, content, created_at, metadata_json, source_label ' +
          ', decay_exempt, read_only, session_key, relied_count FROM nodes WHERE tree_id = ? ORDER BY created_at ASC',
      )
      .all(this.treeId) as unknown as Array<NodeRow & { decay_exempt: number; read_only: number; session_key: string | null; relied_count: number }>

    const evictable = rows.filter(
      (r) => !isProtected(parseMeta(r.metadata_json), r.source_label, r.decay_exempt !== 0, r.read_only !== 0),
    )

    // Group evictable rows by session; sessions ordered by their LATEST
    // entry (newest activity last). Eviction is whole-session only —
    // fragments would hole the conversation-window fabric.
    const bySession = new Map<string, Array<(typeof evictable)[number]>>()
    const sessionLatest = new Map<string, number>()
    for (const r of evictable) {
      const s = resolveSessionKey(r.session_key, () => parseMeta(r.metadata_json))
      const list = bySession.get(s) ?? []
      list.push(r)
      bySession.set(s, list)
      // A handoff lane's created_at is the SENDER's clock (D184), which
      // may run ahead of this machine's: it is ordered by when this store
      // imported it, the one moment this store's own clock wrote.
      const at = s.startsWith(HANDOFF_LANE_PREFIX)
        ? Number(parseMeta(r.metadata_json)?.['_handoff_imported_at'] ?? r.created_at)
        : r.created_at
      sessionLatest.set(s, Math.max(sessionLatest.get(s) ?? 0, at))
    }
    const sessionsNewestFirst = [...sessionLatest.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])

    // Reliance score (ruling 2026-07-23, option c): a session scores by
    // its most-relied-on entry, where reliance is single-entry EXPORTS —
    // the counter exportJson keeps — never query hits. Scored over ALL of
    // the session's rows: a protected row's reliance still speaks for its
    // session. Advisory data under sweep-lease singularity (G4) —
    // a metadata read-modify-write elsewhere may clobber a concurrent
    // bump in exotic multi-process states, and the ordering tolerates
    // that; it never claims counter-grade precision.
    const sessionReliance = new Map<string, number>()
    for (const r of rows) {
      const s = resolveSessionKey(r.session_key, () => parseMeta(r.metadata_json))
      if (!bySession.has(s)) continue
      // The relied_count COLUMN is the truth (G5): backfilled through
      // reliedCountOf's finite guard (foreign junk scored 0, never NaN —
      // a NaN here makes the sort comparator non-transitive, third-pass
      // review) and dual-written by every bump since. No metadata parse
      // on this path anymore.
      const count = r.relied_count
      sessionReliance.set(s, Math.max(sessionReliance.get(s) ?? 0, count))
    }

    // Eviction order: least-relied-on first, oldest first among equals —
    // frequently relied-on history evicts LAST. Frequency only REORDERS
    // (a relied-on session still goes when the caps demand it); the
    // newest session never appears here at all — its protection is
    // absolute, not a score. With no reliance data every score is 0 and
    // this is exactly the old oldest-first order.
    // A handoff lane is never the present session (D221): the newest is
    // the newest of this store's own lanes, and a handoff lane, however
    // recent its import, stays in the eviction order.
    const newest = sessionsNewestFirst.find((s) => !s.startsWith(HANDOFF_LANE_PREFIX)) ?? sessionsNewestFirst[0]
    const evictionOrder = sessionsNewestFirst
      .filter((s) => s !== newest)
      .sort((a, b) =>
        (sessionReliance.get(a) ?? 0) - (sessionReliance.get(b) ?? 0)
        || sessionLatest.get(a)! - sessionLatest.get(b)!)

    // 1. Session-count: evict down to the most-defensible N sessions.
    //    The newest session is never evicted — the charter clause is
    //    unconditional, so even maxSessions: 0 keeps the present.
    const evictCount = Math.max(0, sessionsNewestFirst.length - Math.max(1, this.maxSessions))
    const evictSessions = new Set(evictionOrder.slice(0, evictCount))

    // 2. Entry-count safety net — whole sessions here too (the old
    //    oldest-first ENTRY cap fragmented sessions, violating the charter's
    //    never-fragments clause): keep peeling down the eviction order until
    //    the remaining entry count fits. The newest session is never
    //    evicted, even when it alone exceeds the cap — the over-budget
    //    condition is reported, never resolved by destroying the present.
    let remaining = sessionsNewestFirst
      .filter((s) => !evictSessions.has(s))
      .reduce((n, s) => n + bySession.get(s)!.length, 0)
    for (const s of evictionOrder) {
      if (remaining <= this.maxAutoEntries) break
      if (evictSessions.has(s)) continue
      evictSessions.add(s)
      remaining -= bySession.get(s)!.length
    }

    // 3. Archive → tombstone → delete, per session, oldest first. The
    //    ordering is load-bearing (the charter's over-honest crash rule):
    //    the archive file is written and fsynced BEFORE the tombstone and
    //    deletion commit — atomically, so a crash anywhere leaves either
    //    the session intact (possibly with a redundant archive) or fully
    //    archived+tombstoned. Without an archive destination the valve
    //    refuses to evict: the store never destroys what it cannot archive.
    let evicted = 0
    if (evictSessions.size > 0 && this.archiveDir !== null) {
      for (const s of [...sessionsNewestFirst].reverse()) {
        if (!evictSessions.has(s)) continue
        const sessionRows = bySession.get(s)!
        // Archive the EXACT rows the delete below removes — by node id,
        // never by re-matching the session key: JS grouping stringifies
        // metadata session ids, SQL comparison does not, and a numeric
        // session_id once produced an empty archive under a tombstone
        // that claimed otherwise (round-3 review, S2).
        const archivePath = this.writeNodesArchive(s, sessionRows.map((r) => r.node_id))
        // Long sweeps must outlive their lease honestly: heartbeat per
        // victim session so a >TTL sweep cannot be joined by a second
        // sweeper mid-interleaving (G4 review, finding 4). renewAll
        // swallows per-role errors — a failed heartbeat never fails the
        // sweep — but a LOST role must abort it (release-diff review
        // 2026-08-15): renewAll drops a role another holder now owns,
        // and continuing to archive and delete beside that successor is
        // exactly the two-sweeper interleaving the lease exists to
        // exclude. The committed victims stand; the rest wait for the
        // next trigger.
        if (!this.sweepLeaseHeld(lease, 'mid-eviction', { evicted })) return { evicted, demoted: 0 }
        this.db.transaction(() => {
          this.insertTombstone(s, sessionRows, archivePath)
          // Dedup state follows the rows out in this same transaction
          // (G2): the curated index entries and — via the FK cascade —
          // the window anchors, so no post-commit window exists where a
          // stale entry could make the archive re-import skip its
          // bulkiest rows (round-3, S1), and no per-row content decode.
          for (const r of sessionRows) this.persistence.deleteNode(r.node_id)
        })
        evicted += sessionRows.length
      }
    }

    if (!this.sweepLeaseHeld(lease, 'before demotion', { evicted })) return { evicted, demoted: 0 }
    const demoted = this.demoteOverBudget(lease)
    // Demotion can free far more than eviction (C4 tails are the bulk of
    // the store) — the reclaim check must see both.
    if (evicted > 0 || demoted > 0) this.maybeVacuum()
    return { evicted, demoted }
  }

  /** Full export columns, so an archive imports back verbatim through
   *  importJson. */
  private static readonly ARCHIVE_COLUMNS =
    'node_id, parent_id, depth, is_leaf, content, summary, created_at, updated_at, ' +
    'summary_stale, read_only, decay_exempt, utility_score, source_label, metadata_json'

  /** First non-colliding `<archiveDir>/<base>[-n].json`, creating the dir. */
  private nextArchivePath(base: string): string {
    // Archives hold full-fidelity journal rows — dir and contents land
    // private, not umask-default (docs/security.md §3).
    mkdirSync(this.archiveDir!, { recursive: true, mode: 0o700 })
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_')
    let path = join(this.archiveDir!, `${safe}.json`)
    for (let n = 2; existsSync(path); n++) path = join(this.archiveDir!, `${safe}-${n}.json`)
    return path
  }

  // (writeSessionArchive removed at the round-3 S2 fix: re-deriving a
  // session's rows by key comparison could disagree with the JS grouping
  // that drives the delete; eviction now archives its exact victim set
  // through writeNodesArchive, same as demotion.)

  /** Write an explicit set of rows to `<archiveDir>/<base>[-n].json` in
   *  export format (importJson-compatible), fsynced before return so the
   *  file durably exists before the caller's delete/shrink transaction.
   *  Used by eviction (session victim set) and demotion (pre-shrink). */
  private writeNodesArchive(base: string, nodeIds: string[]): string {
    const path = this.nextArchivePath(base)
    // Chunked IN clause: SQLite caps bound parameters at 32,766 and a
    // plan can exceed that on stores with a raised maxAutoEntries.
    const full: Array<Record<string, unknown>> = []
    for (let i = 0; i < nodeIds.length; i += 900) {
      const chunk = nodeIds.slice(i, i + 900)
      const placeholders = chunk.map(() => '?').join(',')
      full.push(
        ...(this.db
          .prepare(`SELECT ${FlatStore.ARCHIVE_COLUMNS} FROM nodes WHERE tree_id = ? AND node_id IN (${placeholders})`)
          .all(this.treeId, ...chunk) as Array<Record<string, unknown>>),
      )
    }
    full.sort((a, b) => Number(a['created_at']) - Number(b['created_at']))
    this.writeArchiveFile(path, full)
    return path
  }

  private writeArchiveFile(path: string, full: Array<Record<string, unknown>>): void {
    const nodes = full.map((r) => ({
      nodeId: r['node_id'],
      parentId: r['parent_id'],
      depth: r['depth'],
      isLeaf: Number(r['is_leaf']) !== 0,
      content: decodeContent(r['content'] as string | Buffer | null),
      summary: r['summary'],
      createdAt: r['created_at'],
      updatedAt: r['updated_at'],
      summaryStale: Number(r['summary_stale']) !== 0,
      readOnly: Number(r['read_only']) !== 0,
      decayExempt: Number(r['decay_exempt']) !== 0,
      utilityScore: r['utility_score'],
      sourceLabel: r['source_label'],
      metadata: parseMeta(r['metadata_json'] as string | null),
    }))
    // 'wx' + explicit mode: the archive is the last copy of evicted rows
    // and lands 0600 on create, never umask-default (docs/security.md §3).
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify({ version: 1, namespace: this.namespace, nodes }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /** The tombstone is an ordinary journal entry — findable by search,
   *  visible in the timeline — and structurally protected from the valve
   *  (no auto-capture source ⇒ agent-authored class). It carries no
   *  session_id so it never masquerades as a member of the session it
   *  memorializes. */
  private insertTombstone(
    session: string,
    sessionRows: Array<{ created_at: number }>,
    archivePath: string,
  ): void {
    const now = Date.now() / 1000
    const first = new Date(sessionRows[0]!.created_at * 1000).toISOString()
    const last = new Date(sessionRows[sessionRows.length - 1]!.created_at * 1000).toISOString()
    const inserted = this.persistence.insertNode(this.treeId, {
      nodeId: randomUUID().replace(/-/g, ''),
      treeId: this.treeId,
      parentId: null,
      depth: 0,
      isLeaf: true,
      content:
        `[session archived] ${session}: ${sessionRows.length} entries (${first} — ${last}) ` +
        `evicted by session-count retention → ${archivePath}`,
      summary: '',
      createdAt: now,
      updatedAt: now,
      summaryStale: false,
      readOnly: false,
      decayExempt: false,
      utilityScore: 0.5,
      sourceLabel: null,
      metadata: {
        _tombstone: true,
        _archived_session: session,
        _archive_path: archivePath,
        _archive_entries: sessionRows.length,
      },
    })
    if (!inserted) {
      // The tombstone classes as curated (sourceLabel null) and is
      // subject to the unique index. The archive path is fresh per call,
      // so a genuine byte-twin should be impossible — and since §11b the
      // fingerprint is a digest of the whole normalized content, so a
      // refusal now means the content really is a twin rather than a
      // head/tail/length coincidence (the pre-024 key filed different
      // texts together at a measured 2.2%). Either way, deleting a
      // session's rows with NO journal record pointing at its archive is
      // the silent hole the eviction crash rule forbids. Refuse loudly;
      // the throw rolls back this eviction transaction and the rows stay.
      throw new Error(`Eviction tombstone for session '${session}' was refused as a curated duplicate — aborting eviction`)
    }
  }

  /**
   * VACUUM only when reclaimable space is worth a full-file rewrite. The old
   * unconditional VACUUM ran on every evicting sweep (potentially every 50
   * inserts in steady state) — a repeated whole-DB rewrite that also held
   * the write lock long enough to time out hook writeStaging subprocesses
   * (8s busy timeout), silently dropping capture events.
   */
  private maybeVacuum(): void {
    const freelist = this.readPragmaInt('freelist_count')
    const pages = this.readPragmaInt('page_count')
    if (pages <= 0 || freelist <= 0) return
    // Rewrite when >=25% of the file is dead space. No absolute floor: the
    // rewrite cost scales with file size, so small files are cheap to
    // compact, and it is exactly the large steady-state store that must not
    // be rewritten on every sweep.
    if (freelist / pages < 0.25) return
    // VACUUM is the longest single synchronous block in the store —
    // renew the owner's leases first (see maintenanceHeartbeat).
    try { this.maintenanceHeartbeat?.() } catch { /* best-effort */ }
    this.db.exec('VACUUM')
    // In WAL mode, VACUUM alone does not reliably truncate the on-disk
    // file — the rebuilt content can land past the last checkpoint, so
    // the file stays at its pre-VACUUM size until a checkpoint runs
    // (surfaced by AC2.11 once the store carried one more index: larger
    // content pushed VACUUM's implicit checkpoint past whatever made it
    // "just work" before). Force it explicitly, mirroring
    // BetterSqliteDatabase.secureWipe()'s same VACUUM + checkpoint pair.
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  /** better-sqlite3 returns pragma reads as [{ <name>: value }]; other
   *  Database impls may return a bare number. Parse both. */
  private readPragmaInt(name: string): number {
    const raw = this.db.pragma(name)
    if (typeof raw === 'number') return raw
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw[0] as Record<string, unknown> | number
      if (typeof first === 'number') return first
      if (first && typeof first === 'object') {
        const v = first[name]
        if (typeof v === 'number') return v
      }
    }
    return 0
  }

  /**
   * C3: when the store's total content bytes exceed `maxStoreBytes`,
   * demote non-protected auto-capture rows by shrinking their stored
   * content to `demotionTextFor` — the narrowest defensible boundary
   * (display cut, staged index boundary, legacy prose caps).
   *
   * Ruling 2026-07-31 (the demotion half of "only an explicit command
   * destroys content"): demotion archives before it shrinks. The full
   * victim rows are written to `<archiveDir>/demoted[-n].json` (export
   * format, fsynced) BEFORE any row is touched, and each demoted row
   * records the loss in metadata: `_demoted: true`, `_full_len` (the
   * pre-demotion length, so hits carry an availability marker), and
   * `_archive_path`. Without an archive destination the valve refuses to
   * demote — same rule eviction already follows.
   *
   * Victim order: tool bulk before conversational prose (journal-recall
   * calls user/assistant text "sacred"), oldest-first within each class.
   *
   * Reuses `Persistence.updateNode` (not a bespoke SQL path) so the
   * FTS recompute goes through the exact same C2 machinery: the old index
   * text is unindexed from the old (content, meta) pair and the shrunk text
   * indexed from the new. For pre-018 rows the shrunk text IS the old index
   * text, so findability is unchanged (AC3a); for post-018 rows, whose
   * index view is wider than the demotion floor, findability narrows to
   * that floor — the budget valve wins over the widened view, and the
   * truncated tail survives in the archive. Returns the number of rows
   * demoted.
   */
  private demoteOverBudget(lease: LeaseClient): number {
    // CAST AS BLOB: LENGTH() on a TEXT column counts CHARACTERS, and the
    // codec stores sub-512-byte content as plain TEXT — a character gauge
    // under-counts every non-ASCII store and disagrees with status()'s
    // byte gauge, latching over_budget with a valve that never fires
    // (round-2 review, R1).
    const totalRow = this.db
      .prepare('SELECT SUM(LENGTH(CAST(content AS BLOB))) AS total FROM nodes WHERE tree_id = ?')
      .get(this.treeId) as { total: number | null }
    let total = totalRow.total ?? 0
    if (total <= this.maxStoreBytes) return 0
    if (this.archiveDir === null) return 0 // never destroy what cannot be archived

    const rows = this.db
      .prepare(
        'SELECT node_id, content, summary, created_at, read_only, decay_exempt, decay_rate, ' +
          'utility_score, source_label, metadata_json, index_len, preview_len, LENGTH(CAST(content AS BLOB)) AS byte_len ' +
          'FROM nodes WHERE tree_id = ? ORDER BY created_at ASC',
      )
      .all(this.treeId) as unknown as Array<{
        node_id: string
        content: unknown
        summary: string
        created_at: number
        read_only: number
        decay_exempt: number
        decay_rate: number | null
        utility_score: number
        source_label: string | null
        metadata_json: string | null
        index_len: number | null
        preview_len: number | null
        byte_len: number
      }>

    // Plan the whole victim set before touching anything: the archive
    // must exist on disk before the first shrink commits.
    type Victim = {
      row: (typeof rows)[number]
      meta: Record<string, unknown> | null
      decoded: string
      idxText: string
      saving: number
    }
    const toolBulk: Victim[] = []
    const prose: Victim[] = []
    for (const r of rows) {
      if (this.unshrinkable.has(r.node_id)) continue // proved on a prior sweep
      // Boundary columns are authoritative for the shrink target (G5) —
      // demotionTextFor must cut at the engine's boundary, not a stale
      // metadata copy.
      const meta = applyLiftedBoundaries(parseMeta(r.metadata_json), r.index_len, r.preview_len)
      if (isProtected(meta, r.source_label, r.decay_exempt !== 0, r.read_only !== 0)) continue
      if (meta?.['_demoted'] === true) continue // already minimal

      const decoded = decodeContent(r.content as string | Buffer | null)
      const idxText = demotionTextFor(decoded, meta)
      if (idxText.length >= decoded.length || idxText.length === 0) {
        // Nothing left to shrink — or a zero-length stump (_preview_len: 0),
        // which would leave the row unfindable forever and silently dropped
        // by any archive restore (round-2 R11).
        this.unshrinkable.add(r.node_id)
        continue
      }
      // Estimate the saving against the ENCODED stump — byte_len is the
      // stored (possibly compressed) size, so comparing it to raw utf8
      // reads compressible rows as zero-saving and let the old
      // clamp-at-zero decrement demote entire corpora off a tiny overage
      // (round-2 review, R4). A row whose shrink reclaims nothing is
      // unshrinkable in the only sense the valve cares about.
      const encoded = encodeContent(idxText)
      const stumpBytes = typeof encoded === 'string' ? Buffer.byteLength(encoded, 'utf8') : encoded.length
      const saving = r.byte_len - stumpBytes
      if (saving <= 0) {
        this.unshrinkable.add(r.node_id)
        continue
      }
      const role = meta?.['role']
      const isProse = role === 'user' || (role === 'assistant' && meta?.['tool_name'] == null)
      ;(isProse ? prose : toolBulk).push({ row: r, meta, decoded, idxText, saving })
    }

    const planned: Victim[] = []
    for (const v of [...toolBulk, ...prose]) {
      if (total <= this.maxStoreBytes) break
      planned.push(v)
      total -= v.saving
    }
    if (planned.length === 0) return 0

    // Archive written and fsynced before the shrink transaction — the
    // eviction crash rule applies here too: a crash leaves either intact
    // rows (with a redundant archive) or shrunk rows whose tails are on
    // disk. Never a silent hole.
    const archivePath = this.writeNodesArchive('demoted', planned.map((v) => v.row.node_id))

    // The planning pass and the archive write above are the long phases
    // of a demotion, and this phase previously carried no heartbeat at
    // all (release-diff review 2026-08-15): renew before committing the
    // shrink, and abort if the role is gone — the archive file is
    // redundant-but-harmless, exactly the crash-rule state.
    if (!this.sweepLeaseHeld(lease, 'before the shrink commit', { planned: planned.length })) return 0

    this.db.transaction(() => {
      for (const v of planned) {
        const r = v.row
        const session = sessionOf(v.meta)
        // Restamp the boundaries: the shrunk content is now both the index
        // view and the display cut, so the old (wider) markers must not
        // survive — a stale `_index_len` would describe text that no longer
        // exists, and `_preview_len` now equals the content itself. The
        // loss itself stays advertised via `_full_len` + `_archive_path`.
        const newMeta: Record<string, unknown> = {
          ...v.meta,
          _demoted: true,
          _full_len: v.decoded.length,
          _archive_path: archivePath,
        }
        newMeta[EXPLICIT_INDEX_LEN_KEY] = v.idxText.length
        delete newMeta[EXPLICIT_PREVIEW_LEN_KEY]
        this.persistence.updateNode({
          nodeId: r.node_id,
          treeId: this.treeId,
          parentId: null,
          depth: 0,
          isLeaf: true,
          content: v.idxText,
          summary: r.summary,
          createdAt: r.created_at,
          updatedAt: Date.now() / 1000,
          summaryStale: false,
          readOnly: r.read_only !== 0,
          decayExempt: r.decay_exempt !== 0,
          decayRate: r.decay_rate ?? undefined,
          utilityScore: r.utility_score,
          sourceLabel: r.source_label,
          metadata: newMeta,
        })
        // In the same transaction (amendment 8): updateNode above
        // re-stamped the fingerprint column from the stump and dropped
        // the old full-content anchors; the stump re-anchors here.
        // Demotion only ever touches auto-capture rows (isProtected
        // excludes the rest), so this stays in the auto window, at the
        // row's own capture time.
        this.persistence.upsertAnchor(this.treeId, session, contentFingerprint(v.idxText), r.node_id, r.created_at)
      }
    })
    return planned.length
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.ownsDatabase) this.db.close()
  }
}
