/**
 * SQLite-backed persistence for treecontext.
 *
 * Row-level API under the lexical FlatStore:
 *  - Open/create the store, apply schema, run migrations
 *  - Insert/update/delete node rows + keep FTS5 index in sync
 *  - Staging + snapshot row access for the capture pipeline
 *  - Close cleanly
 */

import type { Database, Statement } from './database.js'
import { encodeContent, decodeContent } from './content-codec.js'
import { indexTextFor, applyLiftedBoundaries, EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './index-text.js'
import { contentFingerprint } from '../fingerprint.js'
import { sessionOf, dedupClassOf, reliedCountOf, liftBoundary } from '../dedup-identity.js'
import { attributeColumn, columnForIndex, columnIndex, ftsColumnValues, FTS_COLUMNS } from './fts-columns.js'
import { runMigrations, currentSchemaVersion, ensureBaseSchema, type MigrationOptions } from './migrations.js'
import { ECHO_HEAL_WINDOW_SECS } from './capture-constants.js'
import { healWriterFromEcho as healWriter, type WriterHealResult } from './writer-heal.js'
import { dbg } from '../debug.js'
import { CURATED_INDEX_WHERE } from './curated-index.js'

// ── Row types ───────────────────────────────────────────────────────

/** A node row as persisted in `nodes`. */
export interface PersistedNode {
  nodeId: string
  treeId: number
  parentId: string | null
  depth: number
  isLeaf: boolean
  content: string
  summary: string
  createdAt: number
  updatedAt: number
  summaryStale: boolean
  readOnly: boolean
  decayExempt: boolean
  decayRate?: number | undefined
  utilityScore: number
  sourceLabel: string | null
  metadata: Record<string, unknown> | null
}

export type StagingRole = 'user' | 'assistant' | 'tool_result' | 'snapshot'

export interface StagingEntry {
  sessionId?: string | null
  role: StagingRole
  content: string
  toolName?: string | null
  timestamp: number
  priority?: number
  /** How far the FTS view reaches within `content`, in UTF-16 code units
   *  (JF-1). Post-018 hooks ALWAYS stamp it (self-describing recompute);
   *  null/absent means a pre-018 producer — index by the frozen legacy role
   *  caps, exactly as before. */
  indexLen?: number | null
  /** Where the DISPLAY preview ends within `content` (UTF-16, JF-1). Set
   *  only when a full tail follows the preview; null/absent means hits show
   *  content up to indexLen (the pre-018 behavior). */
  previewLen?: number | null
  /** Namespace of the session that produced this event (C1 capture
   *  attribution). null/absent means unresolved at capture — the drain
   *  routes such rows into its own serving namespace. */
  namespace?: string | null
  /** The writer the hook payload names (D190): a subagent's agent_id and
   *  agent_type. null/absent means the session's main agent. */
  agentId?: string | null
  agentType?: string | null
  /** Row kind the drain carries into metadata.kind (the subagent's
   *  summary, `subagent-summary`, D147). */
  kind?: string | null
}

export interface StagingRow {
  id: number
  sessionId: string | null
  role: StagingRole
  content: string
  toolName: string | null
  timestamp: number
  priority: number
  processed: boolean
  createdAt: number
  /** FTS-view boundary (see StagingEntry.indexLen). */
  indexLen: number | null
  /** Display-preview boundary (see StagingEntry.previewLen). */
  previewLen: number | null
  /** Ingestion failure count (poison-row dead-letter, JF-7). */
  attempts: number
  /** Stamped namespace (see StagingEntry.namespace). */
  namespace: string | null
  /** The payload's writer (see StagingEntry.agentId/agentType). */
  agentId: string | null
  agentType: string | null
  /** Row kind (see StagingEntry.kind). */
  kind: string | null
}

/** What the V2 echo heal did with one (echo, row) pair — every branch is
 *  a disclosed outcome, never a silent skip (docs/session-identity.md
 *  §7.3 guards). */
export type EchoHealOutcome =
  | 'healed'          // creator echo: exact attribution stamped
  | 'ambiguous'       // in-window assert made the disclosure multi-identity
  | 'asserted'        // in-window assert recorded; no ambiguity to disclose
  | 'already-final'   // replay: the row already carries this echo's result
  | 'kept-exact'      // explicit/pid attribution — never overwritten
  | 'outside-window'  // survivor older than W: the week-old-row guard
  | 'not-curated'     // auto row: anchors embed session_key, never healed
  | 'not-found'       // no such node (row evicted since the echo staged)
  | 'unreadable'      // metadata_json failed to parse: skipped, not clobbered

/** Outcomes that vouch for the echo↔row correlation strongly enough to
 *  publish (session → namespace) evidence from it (§7.8). An
 *  allow-list so any future outcome fails CLOSED at the publish gate
 *  (review 2026-08-15, C-finder: a negative list silently admits new
 *  members). 'outside-window' and 'unreadable' are excluded on the
 *  same fail-closed grounds — the heal refused its own sanity checks,
 *  so the publisher does not trade on them. */
export const CORRELATED_ECHO_OUTCOMES: ReadonlySet<EchoHealOutcome> = new Set<EchoHealOutcome>([
  'healed', 'ambiguous', 'asserted', 'already-final', 'kept-exact',
])

// ── Helpers ─────────────────────────────────────────────────────────

function boolToInt(b: boolean): number {
  return b ? 1 : 0
}

function intToBool(n: unknown): boolean {
  return Number(n) !== 0
}


// ── Persistence class ───────────────────────────────────────────────

export class Persistence {
  private readonly db: Database

  // Prepared statements (lazy)
  private sInsertNode: Statement | null = null
  private sUpdateNode: Statement | null = null
  private sDeleteNode: Statement | null = null
  private sGetRowid: Statement | null = null
  private sGetContent: Statement | null = null
  private sGetContentAndMeta: Statement | null = null
  private sInsertFts: Statement | null = null
  private sDeleteFts: Statement | null = null
  private sNodeExists: Statement | null = null
  private sCuratedHolder: Statement | null = null
  private sGetAnchor: Statement | null = null
  private sSlideAnchor: Statement | null = null
  private sUpsertAnchor: Statement | null = null
  private sDeleteAnchorsNode: Statement | null = null
  private sInsertStaging: Statement | null = null
  private sClaimStagingBatch: Statement | null = null
  private sClaimProbe: Statement | null = null
  private sMarkStagingProcessedOwned: Statement | null = null
  private sReleaseStagingClaims: Statement | null = null
  private sIncrementStagingAttempts: Statement | null = null
  private sEchoHealSelect: Statement | null = null
  private sEchoHealUpdate: Statement | null = null
  private sNodeNamespace: Statement | null = null

  /** Node ID → FTS5 rowid cache. Populated on insert. */
  private readonly rowidCache: Map<string, number> = new Map()

  /** Cached schema version — set once after migrations run. */
  private _schemaVersion = 0

  get schemaVersion(): number {
    return this._schemaVersion
  }

  constructor(db: Database) {
    this.db = db
  }

  get database(): Database {
    return this.db
  }

  // ── Open / initial setup ──────────────────────────────────────────

  /**
   * Open a Persistence for the lexical FlatStore backend. Applies schema +
   * migrations. No embedding_model row is ever written — a lexical store
   * carries no vectors, and writing one would break D7 legacy-store
   * detection.
   */
  static openLexical(db: Database, opts?: { migrate?: boolean; readOnly?: boolean }): Persistence {
    // ensureBaseSchema is the ONE definition of "fresh" (version 0 AND
    // empty sqlite_master, decided under a transaction) — the old
    // version-0-only check here would have stamped user_version = 5
    // onto a genuine v0-era store with data, skipping migrations 1–5
    // (pass-2 review 2026-08-15).
    const fresh = ensureBaseSchema(db)
    const migrationOpts: MigrationOptions = {}
    if (fresh) {
      // A store this call just created from the base schema has no data a
      // destructive migration could destroy — replaying the full ladder
      // (including destructive drops like 019) is always safe here, and
      // gating it would make every fresh open demand { migrate: true }.
      migrationOpts.migrate = true
    } else if (opts?.readOnly) {
      // A read-only open cannot migrate; forcing it off keeps the failure
      // mode "migrations pending" instead of a mid-migration write error.
      migrationOpts.migrate = false
    } else if (opts?.migrate !== undefined) {
      migrationOpts.migrate = opts.migrate
    }
    runMigrations(db, migrationOpts)
    if (!opts?.readOnly) writeSchemaMeta(db, 'last_opened_at', String(Math.floor(Date.now() / 1000)))
    const p = new Persistence(db)
    p._schemaVersion = currentSchemaVersion(db)
    return p
  }

  // ── Tree management ───────────────────────────────────────────────

  /** Ensure `ensembleIndex` has a row in `trees` for the given namespace. */
  ensureTree(ensembleIndex: number, namespace = 'project'): number {
    const existing = this.db
      .prepare('SELECT tree_id FROM trees WHERE namespace = ? AND ensemble_index = ?')
      .get(namespace, ensembleIndex)
    if (existing) return Number((existing as { tree_id: unknown }).tree_id)

    const result = this.db
      .prepare(
        'INSERT INTO trees (namespace, ensemble_index, created_at, import_labels_json) VALUES (?, ?, ?, NULL)',
      )
      .run(namespace, ensembleIndex, Math.floor(Date.now() / 1000))
    return Number(result.lastInsertRowid)
  }

  // ── Node CRUD ─────────────────────────────────────────────────────

  /** The arbiter columns (store-as-arbiter, G2), computed here — the one
   *  place nodes are written — from the node's own fields, so every write
   *  path maintains them by construction. Uses the same shared functions
   *  as the 021/022 backfills: identity by construction, not
   *  transcription. */
  private arbiterFor(node: PersistedNode): {
    fingerprint: string
    dedupClass: 'auto' | 'curated'
    sessionKey: string
    reliedCount: number
    indexLen: number | null
    previewLen: number | null
  } {
    return {
      fingerprint: contentFingerprint(node.content),
      dedupClass: dedupClassOf(node.sourceLabel, node.metadata),
      sessionKey: sessionOf(node.metadata),
      reliedCount: reliedCountOf(node.metadata),
      indexLen: liftBoundary(node.metadata?.[EXPLICIT_INDEX_LEN_KEY], node.content.length),
      previewLen: liftBoundary(node.metadata?.[EXPLICIT_PREVIEW_LEN_KEY], node.content.length),
    }
  }

  /** Insert a node. Returns false when the curated-dedup unique index
   *  refused the row (a curated fingerprint twin already lives in this
   *  tree) — the caller decides hit semantics; nothing was written.
   *  The row INSERT and its FTS INSERT commit together (savepoint when
   *  already inside a transaction): a crash between them must not leave
   *  an unsearchable row occupying a fingerprint slot. */
  insertNode(treeId: number, node: PersistedNode): boolean {
    return this.db.transaction(() => {
      const stmt = this.getInsertStmt()
      // Column attribution happens ONCE, here, from the current metadata, and
      // is persisted as index_col. It is never recomputed later — supersede/
      // demotion rewrite metadata (status, _demoted) after insert, and doing
      // that recompute at delete/update time would silently target the wrong
      // nodes_fts column and leave ghost index entries (FG-2).
      const col = attributeColumn(node.metadata)
      const arb = this.arbiterFor(node)
      const result = stmt.run(
        node.nodeId,
        treeId,
        node.parentId,
        node.depth,
        boolToInt(node.isLeaf),
        encodeContent(node.content),
        node.summary,
        node.createdAt,
        node.updatedAt,
        boolToInt(node.summaryStale),
        boolToInt(node.readOnly),
        boolToInt(node.decayExempt),
        node.decayRate ?? null,
        node.utilityScore,
        node.sourceLabel,
        node.metadata ? JSON.stringify(node.metadata) : null,
        columnIndex(col),
        arb.fingerprint,
        arb.dedupClass,
        arb.sessionKey,
        arb.reliedCount,
        arb.indexLen,
        arb.previewLen,
      )
      if (result.changes === 0) return false
      const rowid = Number(result.lastInsertRowid)
      this.rowidCache.set(node.nodeId, rowid)

      if (node.content) {
        // C2: nodes_fts indexes the (role/cap-bounded) index text, never the
        // raw stored content.
        this.getInsertFtsStmt().run(rowid, ...ftsColumnValues(col, indexTextFor(node.content, node.metadata)))
      }
      return true
    })
  }

  updateNode(node: PersistedNode): void {
    this.db.transaction(() => this.updateNodeInTxn(node))
  }

  private updateNodeInTxn(node: PersistedNode): void {
    const stmt = this.getUpdateStmt()

    // Read old content + metadata BEFORE the UPDATE so we can recompute the
    // exact OLD index text (C2): FTS5 contentless tables require the exact
    // original indexed text to unindex tokens, and that text depends on the
    // OLD metadata (role/source), not the incoming one. index_col is read
    // back here too — it is immutable (set once at insert, FG-2) — and
    // reused for BOTH the old-text delete and the new-text insert below, so
    // a node's attributed column never changes across an update even when
    // its content or metadata does.
    const rowid = this.resolveRowid(node.nodeId)
    let oldContent: string | null = null
    let oldMeta: Record<string, unknown> | null = null
    let oldIndexCol: number | null = null
    if (rowid != null) {
      const row = this.getContentAndMetaStmt().get(node.nodeId) as
        | { content: unknown; metadata_json: string | null; index_col: number | null; index_len: number | null; preview_len: number | null }
        | undefined
      if (row) {
        oldContent = decodeContent(row.content as string | Buffer | null)
        // The OLD index text is recomputed for the contentless-FTS
        // unindex; the boundary COLUMNS are its truth (G5) — a diverged
        // metadata copy must not unindex the wrong slice.
        oldMeta = applyLiftedBoundaries(parseMetadata(row.metadata_json), row.index_len, row.preview_len)
        oldIndexCol = row.index_col
      }
    }
    const col = columnForIndex(oldIndexCol)

    stmt.run(
      node.parentId,
      node.depth,
      boolToInt(node.isLeaf),
      encodeContent(node.content),
      node.summary,
      node.updatedAt,
      boolToInt(node.summaryStale),
      boolToInt(node.readOnly),
      boolToInt(node.decayExempt),
      node.decayRate ?? null,
      node.utilityScore,
      node.sourceLabel,
      node.metadata ? JSON.stringify(node.metadata) : null,
      ...this.arbiterUpdateValues(node),
      node.nodeId,
    )
    // A rewritten row's window anchors would keep deduping new captures
    // onto text that no longer exists — they leave with the old content,
    // in this same transaction. Callers that shrink-in-place (demotion)
    // re-anchor the new text themselves.
    this.deleteAnchorsForNode(node.nodeId)

    // Re-sync FTS content. FTS5 contentless tables require a "delete"
    // keyword form with the OLD indexed text (in the OLD column) to
    // properly unindex tokens.
    if (rowid != null) {
      if (oldContent) {
        this.getDeleteFtsStmt().run(rowid, ...ftsColumnValues(col, indexTextFor(oldContent, oldMeta)))
      }
      if (node.content) {
        this.getInsertFtsStmt().run(rowid, ...ftsColumnValues(col, indexTextFor(node.content, node.metadata)))
      }
    }
  }

  /** Arbiter columns for an UPDATE: recomputed from the incoming node so
   *  content rewrites (demotion, stump restore) move the columns in the
   *  same transaction (amendment 8). The curated-twin escape: if another
   *  row already holds this (tree_id, fingerprint) slot in the partial
   *  unique index, this row takes 'curated_dup' — losslessly outside the
   *  index — instead of failing the UPDATE. Unreachable today (both
   *  update callers rewrite auto-class rows) but the invariant must not
   *  depend on that staying true. */
  private arbiterUpdateValues(node: PersistedNode): [string, string, string, number, number | null, number | null] {
    const arb = this.arbiterFor(node)
    let cls: string = arb.dedupClass
    if (cls === 'curated' && this.curatedHolder(node.treeId, arb.fingerprint, node.nodeId) !== undefined) {
      cls = 'curated_dup'
    }
    return [arb.fingerprint, cls, arb.sessionKey, arb.reliedCount, arb.indexLen, arb.previewLen]
  }

  /** Delete node and cascade the subtree via FK. Cleans FTS for removed
   *  rows. Row delete and FTS unindex commit together (savepoint when
   *  nested) — a crash between them must not desync the index. */
  deleteNode(nodeId: string): void {
    this.db.transaction(() => {
      // Collect subtree rowids + decoded contents + metadata BEFORE the
      // cascade removes them, so the FTS unindex uses the exact text that was
      // originally indexed (C2 recompute constraint).
      const subtree = this.collectSubtree(nodeId)
      this.getDeleteStmt().run(nodeId)

      for (const entry of subtree) {
        const col = columnForIndex(entry.indexCol)
        this.getDeleteFtsStmt().run(entry.rowid, ...ftsColumnValues(col, indexTextFor(entry.content, entry.metadata)))
        this.rowidCache.delete(entry.nodeId)
      }
    })
  }

  // ── V2 echo heal (docs/session-identity.md §7.3 + §7.7) ─────────────

  /**
   * Upgrade a curated row's session attribution from its own insert
   * echo — the one sanctioned exception to "historical rows are never
   * rewritten", scoped to session-identity metadata plus the
   * `session_key` column and nothing else. Deliberately NOT
   * `updateNode`: that path rewrites content/fingerprint/FTS and
   * deletes dedup anchors, none of which a session re-stamp may touch.
   *
   * The read and the write share one immediate transaction, so no
   * other writer can interleave between them; the whole heal is
   * idempotent by value — replaying an echo (staging claims can expire
   * mid-tick and re-run) recomputes the same state and writes nothing.
   *
   * Precedence (ruled 2026-08-14): echo never overwrites `explicit` or
   * `pid` (both exact); it DOES displace `beacon-*`/absent, keeping a
   * disagreeing displaced id in `_cc_session_prev`. A row already
   * echo-attributed keeps its primary id forever; further in-window
   * echoes from other sessions only accrue disclosed candidates.
   */
  /** The echo heal of a writer (writer-heal.ts): the insert's own
   *  PostToolUse echo names the caller, and the row's writer follows it. */
  healWriterFromEcho(opts: {
    nodeId: string; echoSessionId: string; echoTs: number; deduplicated: boolean
    agentId: string | null; agentType: string | null; windowSecs?: number
  }): WriterHealResult {
    return healWriter(this.db, { ...opts, windowSecs: opts.windowSecs ?? ECHO_HEAL_WINDOW_SECS })
  }

  healCuratedSessionIdentity(opts: {
    nodeId: string
    echoSessionId: string
    /** Capture time of the echo (staging.timestamp), seconds. */
    echoTs: number
    /** The response's dedup flag: true = this call did not create the row. */
    deduplicated: boolean
    windowSecs?: number
  }): EchoHealOutcome {
    const windowSecs = opts.windowSecs ?? ECHO_HEAL_WINDOW_SECS
    // Read and decide UNTRANSACTED first: WAL readers never block, and
    // most echoes are no-ops (replays, out-of-window, kept-exact) that
    // must not pay a cross-process write-lock acquire — a contended
    // BEGIN IMMEDIATE can stall the synchronous event loop up to the
    // full busy_timeout for zero rows written (review 2026-08-15, #9).
    const first = this.computeEchoHeal(opts, windowSecs)
    if (!first.write) return first.outcome
    return this.db.transaction(() => {
      // Re-decide under the write lock: a writer that slipped between
      // the reads changes the answer, never the safety — the heal is
      // idempotent by value, so recomputing is always sound.
      const again = this.computeEchoHeal(opts, windowSecs)
      if (!again.write) return again.outcome
      this.sEchoHealUpdate ??= this.db.prepare(
        'UPDATE nodes SET metadata_json = ?, session_key = ?, updated_at = ? WHERE node_id = ?',
      )
      this.sEchoHealUpdate.run(again.write.metaJson, again.write.sessionKey, Date.now() / 1000, opts.nodeId)
      return again.outcome
    })
  }

  /**
   * One echo's effect on one row, computed by value. The evidence
   * ledger `_cc_session_echo_asserts` records EVERY in-window echo
   * session (creator and dedup-hit alike); the disclosed surface
   * (`_cc_session_ambiguous` + `_cc_session_candidates`) is recomputed
   * from primary ∪ ledger on every touch, which retires insert-time
   * guess candidates, converges to the same state whatever order the
   * echoes drain in, and never flags a row whose only asserter is its
   * own attributed session (review 2026-08-15, #1/#2/#10 — the prior
   * branch ladder could not tell guess candidates from causal ones).
   */
  private computeEchoHeal(
    opts: { nodeId: string; echoSessionId: string; echoTs: number; deduplicated: boolean },
    windowSecs: number,
  ): { outcome: EchoHealOutcome; write?: { metaJson: string; sessionKey: string } } {
    this.sEchoHealSelect ??= this.db.prepare(
      'SELECT created_at, dedup_class, metadata_json FROM nodes WHERE node_id = ?',
    )
    const row = this.sEchoHealSelect.get(opts.nodeId) as
      | { created_at: number; dedup_class: string; metadata_json: string | null }
      | undefined
    if (!row) return { outcome: 'not-found' }
    // Never an auto row: its dedup_anchors PK embeds session_key, and a
    // re-stamp would silently desynchronize the capture-dedup window.
    if (row.dedup_class === 'auto') return { outcome: 'not-curated' }
    let meta: Record<string, unknown>
    if (row.metadata_json == null) {
      meta = {}
    } else {
      // parseMetadata, not a bare cast: valid-JSON non-object metadata
      // (an imported array, say) must route to 'unreadable' — skipped,
      // not spread-mangled and written back (review 2026-08-15, #6).
      const parsed = parseMetadata(row.metadata_json)
      if (!parsed) return { outcome: 'unreadable' }
      meta = parsed
    }
    const src = meta['_cc_session_src']
    const curId = typeof meta['_cc_session_id'] === 'string' ? (meta['_cc_session_id'] as string) : null
    // Exact insert-time attributions are never touched — not even with
    // candidates: "attribution and source are unchanged" is the ruled
    // scenario, and an exact row has nothing an echo can improve.
    if (src === 'explicit' || src === 'pid') return { outcome: 'kept-exact' }
    // W guards the dedup case (a week-old survivor never collects
    // today's ambiguity) and sanity-bounds the creator case (same host
    // clock; observed skew ≤ 0.1 s).
    if (Math.abs(opts.echoTs - row.created_at) > windowSecs) return { outcome: 'outside-window' }

    // `_cc_session_echo_asserts` is a V2 key: no row healed by the
    // PREVIOUS code carries it. Reading only that key would recompute a
    // legacy row's disclosure from scratch on its next in-window echo,
    // silently DROPPING an already-disclosed candidate — a row honestly
    // saying "cc-A or cc-B" would become "cc-A or cc-C". Seed from the
    // legacy candidate list to carry that disclosure forward — for
    // EVERY src except `beacon-ambiguous`, whose list describes an
    // insert-time GUESS that causal evidence retires rather than
    // promotes (review of chunk C). The old code only ever wrote
    // candidates onto other srcs from causal dedup echoes, without
    // changing src — so a `beacon-unanimous` (or unattributed) row with
    // candidates carries echo evidence too, and gating on src==='echo'
    // alone re-opened the exact drop this seed exists to prevent
    // (Fable review 2026-08-20, F4).
    const legacyCandidates = src !== 'beacon-ambiguous' && Array.isArray(meta['_cc_session_candidates'])
      ? (meta['_cc_session_candidates'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : []
    const priorAsserts = Array.isArray(meta['_cc_session_echo_asserts'])
      ? (meta['_cc_session_echo_asserts'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : legacyCandidates

    const next = { ...meta }
    let healed = false
    if (!opts.deduplicated && src !== 'echo') {
      // Creator echo displacing a guess (or absence): exact heal, with
      // a disagreeing displaced id kept countable.
      if (curId && curId !== opts.echoSessionId) next['_cc_session_prev'] = curId
      next['_cc_session_id'] = opts.echoSessionId
      next['_cc_session_src'] = 'echo'
      healed = true
    }
    const asserts = [...new Set([...priorAsserts, opts.echoSessionId])]
    next['_cc_session_echo_asserts'] = asserts
    const primary = healed ? opts.echoSessionId : curId
    // Disclosure recompute: candidates exist only when more than one
    // distinct identity is in play (primary first, then echo arrival
    // order). A single self-assert discloses nothing — the v1.2 lesson:
    // a distinct-set of one is certainty, not ambiguity.
    const identities = [...new Set([...(primary ? [primary] : []), ...asserts])]
    if (identities.length > 1) {
      next['_cc_session_ambiguous'] = true
      next['_cc_session_candidates'] = identities
    } else {
      delete next['_cc_session_ambiguous']
      delete next['_cc_session_candidates']
    }
    if (JSON.stringify(next) === JSON.stringify(meta)) return { outcome: 'already-final' }
    const outcome: EchoHealOutcome = healed ? 'healed' : identities.length > 1 ? 'ambiguous' : 'asserted'
    // Dual write: the session_key column is the read-side truth (G5).
    // It follows the store's UNIFORM derivation (sessionOf), where a
    // user-supplied plain `session_id` metadata key outranks
    // `_cc_session_id` — for such rows the healed identity lives in
    // metadata while the column keeps the user's grouping key; the
    // column never diverges from its derivation (pinned in
    // echo-heal.test.ts; review 2026-08-15, #5 — disclosed, not silent).
    return { outcome, write: { metaJson: JSON.stringify(next), sessionKey: sessionOf(next) } }
  }

  /** The namespace of the tree holding a node — the §7.8 publisher's
   *  (session → namespace) evidence: a healed row's tree IS the serving
   *  namespace of the server that inserted it. */
  nodeNamespace(nodeId: string): string | null {
    this.sNodeNamespace ??= this.db.prepare(
      'SELECT t.namespace AS ns FROM nodes n JOIN trees t ON t.tree_id = n.tree_id WHERE n.node_id = ?',
    )
    const row = this.sNodeNamespace.get(nodeId) as { ns: string } | undefined
    return row?.ns ?? null
  }

  // ── Dedup arbitration (G2): the store's own truth, cached statements ──

  nodeExists(treeId: number, nodeId: string): boolean {
    this.sNodeExists ??= this.db.prepare('SELECT 1 FROM nodes WHERE node_id = ? AND tree_id = ?')
    return this.sNodeExists.get(nodeId, treeId) !== undefined
  }

  /** The one copy of the "who holds this curated fingerprint slot"
   *  predicate — in lockstep with the partial index DDL and insertNode's
   *  ON CONFLICT target by being the only place it is spelled. */
  curatedHolder(treeId: number, fingerprint: string, exceptNodeId?: string): string | undefined {
    this.sCuratedHolder ??= this.db.prepare(
      `SELECT node_id FROM nodes WHERE tree_id = ? AND fingerprint = ? AND ${CURATED_INDEX_WHERE} ` +
        "AND node_id != COALESCE(?, '')",
    )
    const row = this.sCuratedHolder.get(treeId, fingerprint, exceptNodeId ?? null) as
      | { node_id: string }
      | undefined
    return row?.node_id
  }

  /** The auto-window liveness rule, in one place: the anchor for this
   *  (tree, session, fingerprint), IF its capture-time window covers
   *  createdAt AND its node still exists (an anchor can outlive its row's
   *  deletion by another writer — dedup onto a vanished node would
   *  silently discard the capture). insert() and the import/merge
   *  predicate must agree by construction, not by parallel copies. */
  liveAnchor(
    treeId: number,
    sessionKey: string,
    fingerprint: string,
    createdAt: number,
    windowSecs: number,
  ): { nodeId: string; lastSeen: number } | undefined {
    this.sGetAnchor ??= this.db.prepare(
      'SELECT node_id, last_seen FROM dedup_anchors WHERE tree_id = ? AND session_key = ? AND fingerprint = ?',
    )
    const anchor = this.sGetAnchor.get(treeId, sessionKey, fingerprint) as
      | { node_id: string; last_seen: number }
      | undefined
    if (anchor === undefined || Math.abs(createdAt - anchor.last_seen) > windowSecs) return undefined
    if (!this.nodeExists(treeId, anchor.node_id)) return undefined
    return { nodeId: anchor.node_id, lastSeen: anchor.last_seen }
  }

  /** Slide-forward only (JF-4): a backlog row deduping against a live
   *  node must not drag the window into the past. updated_at is wall
   *  time — the hygiene sweep's clock, never the capture clock. */
  slideAnchor(treeId: number, sessionKey: string, fingerprint: string, createdAt: number): void {
    this.sSlideAnchor ??= this.db.prepare(
      'UPDATE dedup_anchors SET last_seen = MAX(last_seen, ?), updated_at = ? ' +
        'WHERE tree_id = ? AND session_key = ? AND fingerprint = ?',
    )
    this.sSlideAnchor.run(createdAt, Date.now() / 1000, treeId, sessionKey, fingerprint)
  }

  upsertAnchor(treeId: number, sessionKey: string, fingerprint: string, nodeId: string, lastSeen: number): void {
    this.sUpsertAnchor ??= this.db.prepare(
      'INSERT INTO dedup_anchors (tree_id, session_key, fingerprint, node_id, last_seen, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(tree_id, session_key, fingerprint) DO UPDATE SET ' +
        'node_id = excluded.node_id, last_seen = excluded.last_seen, updated_at = excluded.updated_at',
    )
    this.sUpsertAnchor.run(treeId, sessionKey, fingerprint, nodeId, lastSeen, Date.now() / 1000)
  }

  /** Anchors for a rewritten node: content changed, so its windows must
   *  not keep deduping against text that no longer exists. Deletion is
   *  structural (FK cascade); this handles the rewrite case. */
  deleteAnchorsForNode(nodeId: string): void {
    this.sDeleteAnchorsNode ??= this.db.prepare('DELETE FROM dedup_anchors WHERE node_id = ?')
    this.sDeleteAnchorsNode.run(nodeId)
  }

  /** Hygiene sweep for auto-dedup window anchors (G2): prunes on WALL
   *  time (updated_at — when the anchor was last touched by a running
   *  process), never on last_seen, which holds honest CAPTURE time: a
   *  drained backlog's anchors carry old capture stamps but must live
   *  long enough to suppress the backlog's own double-fires. Swept with
   *  staging retention cadence. */
  pruneDedupAnchors(maxAge = 86400): number {
    const cutoff = Date.now() / 1000 - maxAge
    return this.db.prepare('DELETE FROM dedup_anchors WHERE updated_at < ?').run(cutoff).changes
  }

  insertStaging(entry: StagingEntry): number {
    const result = this.getInsertStagingStmt().run(
      entry.sessionId ?? null,
      entry.role,
      entry.content,
      entry.toolName ?? null,
      entry.timestamp,
      entry.priority ?? 3,
      entry.indexLen ?? null,
      entry.previewLen ?? null,
      entry.namespace ?? null,
      entry.agentId ?? null,
      entry.agentType ?? null,
      entry.kind ?? null,
    )
    const id = Number(result.lastInsertRowid)
    dbg('store', 'staging insert', { id, role: entry.role, toolName: entry.toolName, bytes: entry.content.length })
    return id
  }


  /** Claim a drain batch atomically (G3, store-as-arbiter §2): one
   *  UPDATE … RETURNING marks the oldest claimable rows as ours and hands
   *  them back — two drains get DISJOINT batches by construction, no
   *  transaction needed around a single statement under SQLite's
   *  serialized writes. Claimable = unclaimed, or claimed by a drain
   *  whose claim has outlived ttlSecs (a crash; a live drain releases at
   *  tick end). RETURNING order is unspecified — rows are re-sorted to
   *  the drain's (timestamp, id) order here. */
  claimStagingBatch(claimant: string, limit: number, ttlSecs: number): StagingRow[] {
    const now = Date.now() / 1000
    // Lock-free probe first (same reason as the snapshot claim): the
    // common tick has nothing to drain, and even a zero-row UPDATE takes
    // the write lock — an idle 5s heartbeat must not contend with real
    // writers.
    this.sClaimProbe ??= this.db.prepare(
      'SELECT 1 FROM staging WHERE processed = 0 AND (claimed_by IS NULL OR claimed_at < ?) LIMIT 1',
    )
    if (this.sClaimProbe.get(now - ttlSecs) === undefined) return []
    this.sClaimStagingBatch ??= this.db.prepare(
      `UPDATE staging SET claimed_by = ?, claimed_at = ?
        WHERE id IN (SELECT id FROM staging
                      WHERE processed = 0 AND (claimed_by IS NULL OR claimed_at < ?)
                      ORDER BY timestamp, id LIMIT ?)
        RETURNING id, session_id, role, content, tool_name, timestamp, priority, processed,
                  created_at, index_len, preview_len, attempts, namespace, agent_id, agent_type, kind`,
    )
    const rows = this.sClaimStagingBatch.all(claimant, now, now - ttlSecs, limit)
    dbg('store', 'staging claim', { claimant, requested: limit, claimed: rows.length })
    return this.mapStagingRows(rows).sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
  }

  /** Mark rows processed, FENCED by claimant: a row whose claim expired
   *  mid-tick and was reclaimed by another drain is that drain's to
   *  retire — marking it out from under the new claimant could strand
   *  its in-flight work as a phantom. (The old claimant's duplicate
   *  insert, if any, is suppressed by G2's in-store dedup.) Returns how
   *  many rows this claimant actually retired. */
  markStagingProcessedOwned(ids: number[], claimant: string): number {
    if (ids.length === 0) return 0
    this.sMarkStagingProcessedOwned ??= this.db.prepare(
      'UPDATE staging SET processed = 1, claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?',
    )
    const stmt = this.sMarkStagingProcessedOwned
    return this.db.transaction(() => {
      let marked = 0
      for (const id of ids) marked += stmt.run(id, claimant).changes
      return marked
    })
  }

  /** Release every unprocessed claim this claimant still holds — the
   *  tick-end path for soft-deadline leftovers (amendment 7: the TTL is
   *  for crashes, not for routine leftovers). */
  releaseStagingClaims(claimant: string): number {
    this.sReleaseStagingClaims ??= this.db.prepare(
      'UPDATE staging SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ? AND processed = 0',
    )
    return this.sReleaseStagingClaims.run(claimant).changes
  }

  private mapStagingRows(rows: Array<Record<string, unknown>>): StagingRow[] {
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return {
        id: Number(r.id),
        sessionId: r.session_id == null ? null : String(r.session_id),
        role: String(r.role) as StagingRole,
        content: String(r.content),
        toolName: r.tool_name == null ? null : String(r.tool_name),
        timestamp: Number(r.timestamp),
        priority: Number(r.priority),
        processed: intToBool(r.processed),
        createdAt: Number(r.created_at),
        indexLen: r.index_len == null ? null : Number(r.index_len),
        previewLen: r.preview_len == null ? null : Number(r.preview_len),
        attempts: r.attempts == null ? 0 : Number(r.attempts),
        namespace: r.namespace == null ? null : String(r.namespace),
        agentId: r.agent_id == null ? null : String(r.agent_id),
        agentType: r.agent_type == null ? null : String(r.agent_type),
        kind: r.kind == null ? null : String(r.kind),
      }
    })
  }

  /** Poison-row dead-letter (JF-7): bump the failure counter on a staging
   *  row that could not be ingested. Returns the new attempt count. One
   *  UPDATE … RETURNING — the old two-statement read-back raced a second
   *  drainer (G0 review noted it as the natural home for this idiom). */
  incrementStagingAttempts(id: number): number {
    this.sIncrementStagingAttempts ??= this.db.prepare(
      'UPDATE staging SET attempts = attempts + 1 WHERE id = ? RETURNING attempts',
    )
    const row = this.sIncrementStagingAttempts.get(id) as { attempts: number } | undefined
    return row ? Number(row.attempts) : 0
  }

  /** Total content bytes across unprocessed staging rows — the byte-based
   *  safety valve input (D3). Row counts are byte-blind post-C4. */
  sumUnprocessedStagingBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS total FROM staging WHERE processed = 0')
      .get() as { total: number }
    return Number(row.total)
  }

  /** Per-(session, namespace) unprocessed staging summary, oldest group
   *  first (by that group's newest row). NULL session_ids group as one ''
   *  bucket. Grouping includes the stamped namespace (C1) so a valve drop
   *  can tombstone each group's hole into that group's own journal — a
   *  session's rows share one namespace in practice, but a mid-session
   *  server restart under a new namespace is legal and must not let one
   *  group's tombstone claim the other's rows. */
  unprocessedStagingSessions(liveClaimCutoff: number): Array<{
    sessionId: string | null
    namespace: string | null
    rows: number
    bytes: number
    spanStart: number
    spanEnd: number
    liveClaims: number
  }> {
    // liveClaims counts rows another drain currently has in flight (G3):
    // claimed, unexpired as of the cutoff. The valve must not drop a
    // group mid-claim — the claimant holds those rows' content and will
    // ingest them, so deleting under it would tombstone a "hole" that
    // was actually captured.
    const cutoff = liveClaimCutoff
    const rows = this.db
      .prepare(
        `SELECT session_id, namespace, COUNT(*) AS rows_, SUM(LENGTH(CAST(content AS BLOB))) AS bytes_,
                MIN(timestamp) AS span_start, MAX(timestamp) AS span_end,
                SUM(CASE WHEN claimed_by IS NOT NULL AND claimed_at >= ? THEN 1 ELSE 0 END) AS live_claims
         FROM staging WHERE processed = 0
         GROUP BY session_id, namespace ORDER BY span_end ASC`,
      )
      .all(cutoff) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      sessionId: r.session_id == null ? null : String(r.session_id),
      namespace: r.namespace == null ? null : String(r.namespace),
      rows: Number(r.rows_),
      bytes: Number(r.bytes_),
      spanStart: Number(r.span_start),
      spanEnd: Number(r.span_end),
      liveClaims: Number(r.live_claims),
    }))
  }

  /** Byte-valve drop (D3): delete ALL unprocessed rows of one
   *  (session, namespace) group — or NONE, atomically, if any row of the
   *  group carries a live (unexpired as of liveClaimCutoff) claim by the
   *  time the DELETE runs. The valve's group selection already excludes
   *  live-claimed groups, but the tombstone insert awaits between the
   *  check and this delete, and a whole-group drop that raced a claim
   *  would either tear a mid-session hole (partial delete) or destroy
   *  in-flight rows (unguarded delete). Callers must write a capture-gap
   *  tombstone for every group dropped this way (JF-6). Returns rows
   *  deleted — 0 means the group was left intact. */
  dropUnprocessedStagingSession(sessionId: string | null, namespace: string | null, liveClaimCutoff: number): number {
    const sessionCond = sessionId == null ? 'session_id IS NULL' : 'session_id = ?'
    const nsCond = namespace == null ? 'namespace IS NULL' : 'namespace = ?'
    const params: Array<string | number> = [liveClaimCutoff]
    if (sessionId != null) params.push(sessionId)
    if (namespace != null) params.push(namespace)
    if (sessionId != null) params.push(sessionId)
    if (namespace != null) params.push(namespace)
    const result = this.db
      .prepare(
        `DELETE FROM staging WHERE processed = 0 AND NOT EXISTS (
           SELECT 1 FROM staging WHERE processed = 0
             AND claimed_by IS NOT NULL AND claimed_at >= ?
             AND ${sessionCond} AND ${nsCond})
           AND ${sessionCond} AND ${nsCond}`,
      )
      .run(...params)
    return result.changes
  }

  /** Marking processed also clears the claim (G3): a processed row must
   *  never count against its claimant's live-claim footprint. */
  purgeProcessedStaging(maxAge = 86400): number {
    const cutoff = Date.now() / 1000 - maxAge
    const result = this.db
      .prepare('DELETE FROM staging WHERE processed = 1 AND timestamp < ?')
      .run(cutoff)
    return result.changes
  }

  countUnprocessedStaging(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM staging WHERE processed = 0').get() as { c: number }
    return Number(row.c)
  }

  /**
   * Walk the subtree rooted at nodeId, collecting nodeId/rowid/content so
   * FTS can be cleaned up after the cascade delete. Non-recursive BFS.
   */
  private collectSubtree(
    rootId: string,
  ): Array<{ nodeId: string; rowid: number; content: string; metadata: Record<string, unknown> | null; indexCol: number | null }> {
    const result: Array<{ nodeId: string; rowid: number; content: string; metadata: Record<string, unknown> | null; indexCol: number | null }> = []
    const queue: string[] = [rootId]
    const childrenStmt = this.db.prepare('SELECT node_id FROM nodes WHERE parent_id = ?')
    const selfStmt = this.db.prepare('SELECT rowid, content, metadata_json, index_col, index_len, preview_len FROM nodes WHERE node_id = ?')

    while (queue.length > 0) {
      const id = queue.shift()!
      const row = selfStmt.get(id) as
        | { rowid?: unknown; content?: unknown; metadata_json?: unknown; index_col?: unknown; index_len?: number | null; preview_len?: number | null }
        | undefined
      if (!row) continue
      result.push({
        nodeId: id,
        rowid: Number(row.rowid),
        content: decodeContent(row.content as string | Buffer | null),
        // Boundary columns rule the FTS unindex text (G5).
        metadata: applyLiftedBoundaries(parseMetadata(row.metadata_json), row.index_len ?? null, row.preview_len ?? null),
        indexCol: row.index_col == null ? null : Number(row.index_col),
      })
      const children = childrenStmt.all(id)
      for (const c of children) {
        queue.push(String((c as { node_id: unknown }).node_id))
      }
    }
    return result
  }

  /** Look up FTS rowid for a node_id, using the in-memory cache when possible. */
  private resolveRowid(nodeId: string): number | null {
    const cached = this.rowidCache.get(nodeId)
    if (cached != null) return cached
    const row = this.getRowidStmt().get(nodeId) as { rowid?: unknown } | undefined
    if (!row) return null
    const rowid = Number(row.rowid)
    this.rowidCache.set(nodeId, rowid)
    return rowid
  }


  // ── Close ─────────────────────────────────────────────────────────

  close(): void {
    this.db.close()
  }

  // ── Internals: prepared statements ────────────────────────────────

  private getInsertStmt(): Statement {
    if (!this.sInsertNode) {
      // The conflict target is the curated partial unique index (021):
      // named explicitly so a node_id PK collision still throws — only a
      // curated fingerprint twin is silently refused (changes = 0), and
      // only insertNode's caller decides what a refusal means.
      this.sInsertNode = this.db.prepare(
        'INSERT INTO nodes (node_id, tree_id, parent_id, depth, is_leaf, content, summary, ' +
          'created_at, updated_at, summary_stale, ' +
          'read_only, decay_exempt, decay_rate, utility_score, source_label, metadata_json, index_col, ' +
          'fingerprint, dedup_class, session_key, relied_count, index_len, preview_len) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          `ON CONFLICT(tree_id, fingerprint) WHERE ${CURATED_INDEX_WHERE} DO NOTHING`,
      )
    }
    return this.sInsertNode
  }

  private getUpdateStmt(): Statement {
    if (!this.sUpdateNode) {
      // MAX(relied_count, ?) — reliance only ever increments, so an
      // update whose in-memory metadata predates a concurrent (or
      // merely later) export bump must not roll the column back: the
      // demotion shrink plans outside its write transaction, and the
      // archive stump restore carries demotion-time metadata by design
      // (release-diff review 2026-08-15). The column is the read truth
      // (G5); metadata may lag it and the bump SQL heals with the same
      // MAX.
      this.sUpdateNode = this.db.prepare(
        'UPDATE nodes SET parent_id = ?, depth = ?, is_leaf = ?, content = ?, summary = ?, ' +
          'updated_at = ?, summary_stale = ?, ' +
          'read_only = ?, decay_exempt = ?, decay_rate = ?, utility_score = ?, source_label = ?, metadata_json = ?, ' +
          'fingerprint = ?, dedup_class = ?, session_key = ?, relied_count = MAX(relied_count, ?), index_len = ?, preview_len = ? ' +
          'WHERE node_id = ?',
      )
    }
    return this.sUpdateNode
  }

  private getDeleteStmt(): Statement {
    if (!this.sDeleteNode) {
      this.sDeleteNode = this.db.prepare('DELETE FROM nodes WHERE node_id = ?')
    }
    return this.sDeleteNode
  }

  private getRowidStmt(): Statement {
    if (!this.sGetRowid) {
      this.sGetRowid = this.db.prepare('SELECT rowid FROM nodes WHERE node_id = ?')
    }
    return this.sGetRowid
  }

  private getContentStmt(): Statement {
    if (!this.sGetContent) {
      this.sGetContent = this.db.prepare('SELECT content FROM nodes WHERE node_id = ?')
    }
    return this.sGetContent
  }

  private getContentAndMetaStmt(): Statement {
    if (!this.sGetContentAndMeta) {
      this.sGetContentAndMeta = this.db.prepare('SELECT content, metadata_json, index_col, index_len, preview_len FROM nodes WHERE node_id = ?')
    }
    return this.sGetContentAndMeta
  }

  private getInsertFtsStmt(): Statement {
    if (!this.sInsertFts) {
      this.sInsertFts = this.db.prepare(
        `INSERT INTO nodes_fts(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`,
      )
    }
    return this.sInsertFts
  }

  private getDeleteFtsStmt(): Statement {
    if (!this.sDeleteFts) {
      // FTS5 contentless delete form: pass the stored text (in its original
      // column) so FTS can unindex tokens. We pass '' in every column when
      // we've already lost the content.
      this.sDeleteFts = this.db.prepare(
        `INSERT INTO nodes_fts(nodes_fts, rowid, ${FTS_COLUMNS.join(', ')}) VALUES ('delete', ?, ?, ?, ?, ?)`,
      )
    }
    return this.sDeleteFts
  }

  private getInsertStagingStmt(): Statement {
    if (!this.sInsertStaging) {
      this.sInsertStaging = this.db.prepare(
        'INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, index_len, preview_len, namespace, agent_id, agent_type, kind) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
    }
    return this.sInsertStaging
  }

  /** Decode one node's stored content (used by the export-by-id read path). */
  getContent(nodeId: string): string | null {
    const row = this.getContentStmt().get(nodeId)
    if (!row) return null
    return decodeContent((row as { content: unknown }).content as string | Buffer | null)
  }


}

// ── Free helpers for store_config ───────────────────────────────────

function writeStoreConfig(db: Database, config: Record<string, unknown>): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(config)) {
    stmt.run(k, JSON.stringify(v))
  }
}

function readStoreConfig(db: Database): Record<string, unknown> | null {
  const rows = db.prepare('SELECT key, value FROM store_config').all()
  if (rows.length === 0) return null
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    const r = row as { key: unknown; value: unknown }
    try {
      result[String(r.key)] = JSON.parse(String(r.value))
    } catch {
      result[String(r.key)] = String(r.value)
    }
  }
  return result
}

// ── Backend mode (store_config) + legacy detection ──────────────────

/** Read the persisted backend mode, or null if unset / store uninitialized.
 *  Tolerant of a fresh DB where store_config does not yet exist. */
export function getBackendMode(db: Database): 'lexical' | 'tree' | null {
  try {
    const cfg = readStoreConfig(db)
    const m = cfg?.['backend_mode']
    return m === 'lexical' || m === 'tree' ? m : null
  } catch {
    return null
  }
}

/** Persist the backend mode in store_config. Schema must already be applied. */
export function setBackendMode(db: Database, mode: 'lexical' | 'tree'): void {
  writeStoreConfig(db, { backend_mode: mode })
}

/** True if the store carries an embedding_model row (a legacy tree-built
 *  store). Used to preserve mode for stores predating backend_mode (D7). */
export function storeHasEmbeddingModel(db: Database): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM embedding_model WHERE id = 1').get()
    return Number((row as { cnt: unknown }).cnt) > 0
  } catch {
    return false
  }
}

function writeSchemaMeta(db: Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(key, value)
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(String(raw))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

// Re-export the current schema version for TreeContext/CLI to compare
// against — derived from the migration ladder, never hand-bumped.
export { maxSupportedVersion as SCHEMA_VERSION } from './migrations/index.js'
