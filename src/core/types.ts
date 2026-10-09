import type { ReferencedBy } from '../references.js'
// ── Backend ─────────────────────────────────────────────────────────

/** Which memory backend a store uses. 'lexical' = FlatStore (FTS5 bm25, no
 *  embedder); 'tree' = TreeContext (embedder + MemTree). */
export type BackendMode = 'lexical' | 'tree'

// ── Results ─────────────────────────────────────────────────────────

export interface SupersedeMiss {
  nodeId: string
  /** `other_writer`: the target is another writer's (D169) and this
   *  insert was a dedup hit, so no reference could be recorded either. */
  reason: 'not_found' | 'read_only' | 'self' | 'other_writer'
}

export interface InsertResult {
  nodeId: string
  path: string[]
  depth: number
  deduplicated: boolean
  driftDetected: boolean
  staleNodes: Array<{ nodeId: string; childrenCount: number }>
  message?: string
  /** Present only when InsertOptions.supersedes was provided. */
  superseded?: string[]
  supersedeMisses?: SupersedeMiss[]
  /** Supersedes targets another writer's lane owns (D169): left untouched
   *  and recorded instead as references in this entry's `metadata.refs`.
   *  Present only when there were any. */
  referenced?: string[]
  /** On a dedup hit: ids in the incoming `metadata.refs` (cross-writer
   *  supersedes included) that the surviving row does not carry. They
   *  were not recorded anywhere — the survivor is never modified to hold
   *  them. Present only when there were any. */
  refsNotRecorded?: string[]
}

export interface AncestorEntry {
  nodeId: string
  summary: string
  isMatch: boolean
}

/**
 * conversation_window (W1-W9): a single neighbor or anchor entry riding
 * along with a hit. Never scored, never
 * counted toward topK, never a standalone result (W1).
 */
export interface WindowEntry {
  nodeId: string
  /** Head-truncated to the entry's cap (WINDOW_NEIGHBOR_MAX_CHARS for
   *  neighbors, ANCHOR_MAX_CHARS for the anchor) — see `truncated`. */
  content: string
  createdAt: number
  truncated: boolean
  /** From metadata.role, when present ('user' | 'assistant' | ...). */
  role?: string
  /** From metadata.tool_name, when present. */
  toolName?: string
}

/**
 * W9: the nearest preceding user message in the hit's session — the
 * "directive" a window of any affordable size cannot reach (calibration:
 * median 177 entries back). `{ ref }` is W7 dedup: the anchor node already
 * appears elsewhere in this reply (as a hit or as another entry's
 * neighbor/anchor), so it is referenced by nodeId instead of duplicated.
 */
export type WindowAnchor = WindowEntry | { ref: string } | null

export interface ConversationWindow {
  /** Chronological, oldest first. */
  before: WindowEntry[]
  /** Chronological. */
  after: WindowEntry[]
  anchor?: WindowAnchor
  /** Set instead of populating before/after when the hit has no resolvable
   *  session key (W2) — a window is never fabricated across the
   *  unsessioned bucket. */
  omitted?: 'no-session-key'
}

export interface QueryResult {
  nodeId: string
  content: string
  summary: string
  similarity: number
  depth: number
  isLeaf: boolean
  createdAt: number
  metadata: Record<string, unknown> | null
  ancestorChain: AncestorEntry[]
  /** Present only when `QueryOptions.conversationWindow > 0` and the
   *  backend implements windowing (FlatStore lexical path only, W8). */
  window?: ConversationWindow
  /** "referenced by", one hop deep (D186): the newest entry whose
   *  `metadata.refs` names this hit, and how many do. Absent when none. */
  referencedBy?: ReferencedBy
}

/**
 * A node tagged for cold-start orientation. Surfaced by treecontext_status so
 * agents see active plans and resume pointers without needing to remember to
 * run a broad query first.
 *
 * Recognized markers (set on metadata at insert time):
 *   - `next_session: true` — explicit "pick up here next session"
 *   - `status: "active"` — work currently in progress
 */
export interface ResumePointer {
  nodeId: string
  preview: string
  metadata: Record<string, unknown> | null
  createdAt: number
  /** The checkpoint kind (D158): a bookmark carries metadata.kind
   *  "bookmark"; every other pointer is a chapter summary. */
  kind?: 'chapter' | 'bookmark'
  /** Entries this pointer superseded, newest first — a retraction names
   *  the chapter it took back (D185). Absent when it superseded none. */
  supersedes?: string[]
}

/**
 * One open thread — an entry the agent tagged to be picked up again. Same
 * markers `ResumePointer` recognizes, carried in the shape a display wants:
 * a title, a line of context, and when it was opened.
 */
export interface OpenThread {
  /** `metadata.topic` when the author set one, else the entry's first line. */
  topic: string
  /** A line of context beneath the topic. May be empty. */
  line: string
  createdAt: number
}

/**
 * The journal's observable health at a single moment — the numbers a
 * display can show without decoding the store, and without deciding what
 * any of them mean. Every window (`capturePerMinute`, `curated.newestAt`)
 * is measured from `at`, never from the reader's clock: that is what makes
 * a vitals reading a function of the journal and one moment, so the same
 * store read twice for the same `at` reads identically.
 *
 * `staging` is store-wide rather than namespace-scoped — staged events have
 * not been attributed to a tree yet, which is precisely what the drain does.
 */
export interface JournalVitals {
  /** The moment these numbers were taken (epoch seconds). */
  at: number
  totalNodes: number
  /** Stored (compressed) content bytes — a size gauge, not a char count. */
  storeBytes: number
  curated: {
    count: number
    /** Newest curated entry's moment, or null when there are none. */
    newestAt: number | null
    /** Entries of any kind recorded since that newest curated one. */
    entriesSince: number
  }
  /** Entries the journal wrote to admit a hole in itself. */
  captureGaps: number
  threads: {
    open: OpenThread[]
    /** Total open threads, when `open` is capped. */
    openTotal: number
    superseded: number
  }
  staging: {
    total: number
    unprocessed: number
    /** Unprocessed rows that have already failed at least one drain. */
    retried: number
    oldestPendingAt: number | null
  }
  /** Ten one-minute buckets of staged events, oldest first, ending at `at`. */
  capturePerMinute: number[]
  /**
   * What the captured trail is made of. Composition, not health: `exits`
   * comes from `classifyExit`, a substring heuristic over tool OUTPUT
   * ("failed", "exception", "enoent" anywhere in the text), so a grep whose
   * results mention an error is itself recorded as one. The counts are
   * honest about the corpus and must never be presented as a defect rate.
   *
   * Both maps are keyed by whatever the journal recorded rather than by a
   * fixed list, so a classification added later still shows up instead of
   * silently falling out of a total.
   */
  trail: {
    /** Tool events by `metadata.exit_type`. */
    exits: Record<string, number>
    /** User turns by `metadata.intent`. */
    intents: Record<string, number>
    /** Entries stored as a bounded index preview with full text behind it. */
    previewed: number
    /** Distinct sessions represented in the journal. */
    sessions: number
  }
  /** The byte-budget gauge the retention valve steers by. */
  retention: { storeBytes: number; budgetBytes: number; overBudget: boolean }
}

export interface TreeStatus {
  /** Which backend produced this status. The lexical FlatStore reports
   *  'lexical'; absent on legacy payloads. */
  backend?: 'lexical'
  totalNodes: number
  leafNodes: number
  internalNodes: number
  staleSummaryCount: number
  maxDepth: number
  totalContentChars: number
  totalSummaryChars: number
  staleNodeIds: string[]
  resumePointers: ResumePointer[]
  /** Total matching resume pointers when `resumePointers` is capped (flat
   *  store caps at the newest 20). Absent/equal means nothing was elided. */
  resumePointerTotal?: number
  /** Live pointers of other lanes left out when status was confined to
   *  one lane (D242). */
  resumePointerOtherLanes?: number
  /** Byte-budget gauge. `storeBytes` is the stored (compressed) content
   *  size; `overBudget` means the store exceeds `budgetBytes` — the
   *  retention valve could not (or has not yet) brought it under, e.g.
   *  when everything remaining is protected. The store never destroys
   *  protected rows to meet the budget; it reports instead. */
  retention?: {
    storeBytes: number
    budgetBytes: number
    overBudget: boolean
    /** The session cap the eviction valve steers by (D141): the config
     *  file's `[retention] max_sessions`, else the default. */
    sessionCap?: number
  }
}

export interface MediaRef {
  uri: string
  mimeType: string
  filename?: string
  extension?: string
  sizeBytes?: number
  extracted?: Record<string, unknown>
}

export interface MediaFilter {
  filename?: string
  extension?: string
  mimePrefix?: string
}

// ── Query options ───────────────────────────────────────────────────

/**
 * Per-role bm25 column weights for the FlatStore lexical query path
 * (`bm25(nodes_fts, wUser, wAssistant, wTool, wNote)`). Each weight must be
 * 0-10 — validated at this layer (persistence/fts.ts) and again at the MCP
 * layer so an out-of-range value never reaches the engine.
 *
 * Weight 0 down-ranks a column, it does NOT hide it: FTS5 MATCH is
 * column-agnostic, so a row that only matches through a zero-weighted
 * column stays findable (FG-7).
 * Ignored by the tree/hybrid backends, which rank via an in-memory BM25
 * index unrelated to `nodes_fts` (FG-6: scope is FlatStore only).
 */
export interface RoleWeights {
  user?: number
  assistant?: number
  tool?: number
  note?: number
}

export interface QueryOptions {
  topK?: number
  metadataFilter?: Record<string, unknown>
  mediaFilter?: MediaFilter
  /** Filter results to a created-at window (unix seconds). FlatStore honors
   *  this in SQL; tree backends apply it via the server layer. */
  timeRange?: { before?: number; after?: number }
  /** Result ordering. 'relevance' (default) = score; 'chronological' =
   *  oldest-first by createdAt; 'reverse_chronological' = newest-first. */
  sortBy?: 'relevance' | 'chronological' | 'reverse_chronological'
  /** Per-role bm25 weight overrides for the FlatStore lexical path. Missing
   *  fields fall back to DEFAULT_ROLE_WEIGHTS. Ignored by tree/hybrid modes. */
  roleWeights?: RoleWeights
  /** Drop hits whose metadata._namespace is in this list, BEFORE topK and
   *  window attachment — so windows/claiming never see excluded hits.
   *  FlatStore only; tree backends apply exclusion at the server layer. */
  excludeNamespaces?: string[]
  /**
   * D150: confine the search to a lane — rows whose store-stamped
   * `_writer` is one of `writers`, plus the entries named in `ids` — in
   * SQL, BEFORE topK, and confine each hit's conversation window to the
   * same set, so nothing outside it rides in as a neighbor. FlatStore
   * only. The MCP server sets it for a caller it resolves to a live
   * subagent (its role's trail plus the plan it was spawned under).
   */
  laneScope?: { writers: string[]; ids: string[] }
  /**
   * W4: symmetric read-time neighbor expansion — 0 (off) to 10 entries
   * each side of a hit, from the same session, plus the W9 anchor.
   * Library semantics: omitted = off (explicit-args API). The MCP server
   * applies DEFAULT_CONVERSATION_WINDOW when the caller omits the param
   * on a windowing backend. FlatStore (lexical) backend only; ignored
   * (no-op) by tree/dual-tree backends.
   */
  conversationWindow?: number
  /**
   * Recency fusion weight (0 disables — the default). When > 0 and the
   * query is lexical with relevance ordering, results are re-ranked by
   * reciprocal rank fusion of the BM25 list with the same candidates
   * ranked by capture time. Measured on the live corpus: 0.5 rescued the
   * cold-start query (median hit age 22d → 1.6d) while the strongest
   * lexical hit stayed on the first page; near-no-op when results are
   * already fresh. FlatStore only.
   */
  recencyWeight?: number
  /**
   * Adaptive result count: let the score distribution decide how many
   * results return. topK becomes a BUDGET (results may be fewer when a
   * clear break comes early — a deliberate departure from the deleted
   * CAR, measured 2026-07-26), adaptiveMax caps expansion. Flat
   * distributions return the budget with low confidence, never a
   * fabricated break. FlatStore only.
   */
  adaptive?: boolean
  /** Cap for adaptive expansion. Default: topK * 3. */
  adaptiveMax?: number
  /** Receives the adaptive decision (returned count, confidence, flat
   *  flag) when `adaptive` ran — the MCP layer surfaces it as
   *  `_adaptive`. */
  onAdaptive?: (meta: { returnedK: number; confidence: number; flat: boolean }) => void
}

/**
 * Shipped MCP-layer default for `conversation_window` (spec amendment
 * 2026-07-05, supersedes the EW2-derived default-0). Evidence at fixed
 * top_k through the production path: +4.89pp coverage on bm25 (+23/−0
 * discordants), +7.9pp under production caps (EW4), ~+1.2k tokens and
 * ~+1ms per query. EW2's tight-budget verdict still governs the opt-out:
 * callers on a hard reading budget should set 0 and raise top_k instead.
 * Applied by the server only for windowing (FlatStore) backends; the
 * library API stays explicit (omitted = off).
 */
export const DEFAULT_CONVERSATION_WINDOW = 2

export interface InsertOptions {
  decayExempt?: boolean
  decayRate?: number | undefined
  metadata?: Record<string, unknown>
  sourceLabel?: string
  readOnly?: boolean
  mediaRef?: MediaRef
  /**
   * Capture timestamp (Unix seconds) for the node's `createdAt`. Ingestion
   * passes the hook's capture time so drained backlogs keep honest
   * chronology (time_range, sort, conversation windows). `updatedAt` stays
   * insert time. FlatStore honors this; tree backends may ignore it (their
   * placement is embedding-driven, not time-driven).
   */
  createdAt?: number
  /**
   * Node IDs whose resume-pointer flags this insert supersedes. Applied
   * atomically with the insert (including dedup outcomes): deletes
   * `next_session`, demotes `status: "active"` → `"superseded"`, writes
   * `superseded_by` / `superseded_at` trace fields on each target. Targets'
   * content, embeddings, and other metadata are untouched (recall guarantee).
   * See docs/resume-pointer-lifecycle.md.
   *
   * Only a lane's own writer retires that lane's pointers (D169): a target
   * whose writer differs from this entry's (see references.ts
   * laneWriterOf) is left untouched and recorded as a reference in this
   * entry's `metadata.refs` instead, reported in `InsertResult.referenced`.
   */
  supersedes?: string[]
}

