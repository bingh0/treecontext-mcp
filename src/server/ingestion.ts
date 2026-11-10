import { PRE_TOOL_USE_MARK, NO_RESULT_MARK, NO_TURN_END_MARK, TURN_INTERRUPTED_KIND, GAP_TOOL_USE_ID_KEY, ownLaneRowSql } from '../persistence/capture-marks.js'
import { stampEchoBoundaries } from '../persistence/echo-index.js'
import type { MemoryStore } from '../memory-store.js'
import type { Persistence } from '../persistence/store.js'
import {
  classifyIntent,
  exitClassOf,
  EXIT_BY_KEY,
  ErrorTracker,
  LoopDetector,
  attributeProject,
  type ExitType,
} from './event-processing.js'
import {
  MAX_INGEST_ATTEMPTS, STAGING_MAX_BYTES, STORE_SAFETY_CAP, STAGING_CLAIM_TTL_SECS,
  SESSION_NS_ANNOTATION_TTL_SECS,
} from '../persistence/capture-constants.js'
import { CORRELATED_ECHO_OUTCOMES } from '../persistence/store.js'
import { StoreLockedError } from '../errors/index.js'
import { extractInsertEcho, extractRefusalId, isInsertEchoTool, extractStatusNamespace, isStatusEchoTool } from './echo-correlation.js'
import {
  writeSessionNamespaceAnnotation,
  sweepSessionNamespaceAnnotations,
  type SessionNamespaceAnnotation,
} from '../session-beacon.js'
import type { LeaseClient } from '../persistence/leases.js'
import { hostname } from 'node:os'
import { SAFE_STORE_RE, isCliAddressableStoreName } from '../tools/store-name.js'
import { dbg, warn } from '../debug.js'
import { maxSupportedVersion } from '../persistence/migrations/index.js'
import { newerSchemaLine } from '../persistence/migrations.js'
import { healEchoIndex } from '../persistence/echo-reindex.js'
import {
  buildRecoveryContent, recoverySnapshotBoundaries, RECOVERY_SNAPSHOT_SOURCE, RECOVERY_QUERIES_KEY,
  RECOVERY_HITS_PER_QUERY, RECOVERY_SNAPSHOT_ID_KEY, RECOVERY_STAGING_ID_KEY, type RecoveryHit,
} from '../persistence/recovery-snapshot.js'
import { agentWriterOf, INTERNAL_SUMMARY_KIND, CLIENT_WRITER } from '../persistence/session-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../handoff.js'
import { workerLaneOf, legWriterOf } from '../persistence/leg-registry.js'
import { placedLaneOf } from '../persistence/lane-scope.js'
import { legTraceOf } from '../persistence/session-registry.js'
import { DOOR_KEY, IDENTITY_KEY } from '../runs.js'
import { claimHookGaps, hookGapText } from '../hooks/gap-ledger.js'
import { resolveEarlierCallEntries } from '../persistence/call-resolution.js'

/**
 * What the IngestionLoop needs from a backend: the MemoryStore surface
 * (insert/query) plus staging access (`store`). FlatStore satisfies this;
 * captured events land directly as `source_label='auto-capture'` nodes
 * (Step 6A). The tree-journal drain path left with the tree era
 * (deletion phase, 2026-07-25).
 */
export type IngestibleStore = MemoryStore & { store: Persistence }

/** True when a MemoryStore exposes staging access (TreeContext / FlatStore).
 *  Probes the claim API — the method the drain actually calls (G3). */
export function isIngestible(s: MemoryStore): s is IngestibleStore {
  const store = (s as Partial<IngestibleStore>).store
  return !!store && typeof store.claimStagingBatch === 'function'
}

/** How often the ingestion loop drains staging (default for `intervalMs`).
 *  Under --debug each tick logs a line, so anything pacing itself against
 *  that chatter (the abandoned-stderr scenario waits out one tick) should
 *  read this rather than respell the number. */
export const INGESTION_TICK_MS = 5_000

export interface IngestionOptions {
  intervalMs?: number
  batchSize?: number
  decayRate?: number
  sessionId?: string
  storeName?: string
  sweepIntervalMs?: number | undefined
  /** D3 byte valve override (default STAGING_MAX_BYTES). Tests inject a
   *  small value; production never needs to. */
  stagingMaxBytes?: number
  /** TEST-ONLY schema ceiling override (D265; precedent stagingMaxBytes):
   *  the highest store version this drain treats as its own, default
   *  `maxSupportedVersion`. The charter's "newer server" is this binary
   *  given one version more. Production never sets it. */
  schemaCeiling?: number
  /** Drain-role arbitration (G4): when set, every tick try-acquires the
   *  'drain' lease and skips when a live foreign holder exists — so a
   *  crash-restarted server self-heals within one TTL instead of losing
   *  capture for its lifetime, and a standby --capture server takes
   *  over when the owner dies. Absent (tests, direct construction), the
   *  loop drains unconditionally. */
  drainLease?: { client: LeaseClient; ttlSecs: number }
  /**
   * Called after every drain tick, whether it ingested anything, nothing,
   * or threw — the drain is a *moment* even when it moves no rows, and a
   * consumer that only heard about non-empty batches could not tell an idle
   * session from a stopped loop.
   *
   * Never throws into the loop: the callback is wrapped, because anything
   * observing the drain must not be able to stop it.
   */
  onBatch?: (info: { ingested: number; failure?: string }) => void
  /**
   * C1 capture attribution (tests/server/design/multi-user.md): resolve a
   * store handle for a target namespace, create-if-absent. The drain
   * serves every namespace of the store; each staged row drains into the
   * tree its stamp names. Absent (tests, legacy construction), every row
   * drains into `ctx` — the serving process always passes a factory.
   */
  storeFor?: (namespace: string) => Promise<IngestibleStore>
  /**
   * §7.8 session-keyed namespace annotations: the on-disk store path,
   * whose sibling `sessions/` directory holds the annotation files the
   * drain publishes from echo evidence. Absent (tests, in-memory
   * stores), publishing is a no-op — the heal itself is unaffected.
   */
  storePath?: string
  /** TEST-ONLY: how old a claimed hook gap ledger must be before the drain
   *  reads it (default GAP_CLAIM_GRACE_MS; hooks/gap-ledger.ts). The suite
   *  passes 0 so one tick both claims and reads; production never sets it. */
  hookGapGraceMs?: number
}

/** D265: the stale-drain warning is written once per process lifetime —
 *  the loop that writes it stops, and nothing in this process drains the
 *  store again, so a second line would only repeat the first. */
let staleDrainWarned = false

export class IngestionLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  private isRunning = false
  private isStopped = false

  private errorTracker = new ErrorTracker()
  private loopDetector = new LoopDetector()
  private readonly sweepIntervalMs: number
  private readonly stagingMaxBytes: number
  private readonly schemaCeiling: number
  /** D265: set when this drain found the store migrated past this build
   *  and stepped aside. Terminal: ingestBatch returns 0 without touching
   *  the lease from then on. */
  private steppedAside = false
  /** The echo heal's rowid cursor: each sweep reads one bounded page past
   *  it, so after the start-up pass only rows drained since are read. */
  private echoHealAfter = 0
  /** Monotonic per-process suffix: two loop instances in one process
   *  (tests, a restarted capture path) must never share a claimant, or
   *  one's tick-end release frees the other's in-flight claims. */
  private static claimantSeq = 0
  /** Claim identity (G3): who this drain is in staging.claimed_by. Pid +
   *  host + instance is diagnostic, not authoritative — expiry is by
   *  claimed_at TTL, never by probing the pid (the lockfile lesson). */
  private readonly claimant = `${process.pid}@${hostname()}#${IngestionLoop.claimantSeq++}`

  private readonly onBatch: ((info: { ingested: number; failure?: string }) => void) | null
  private readonly storeFor: ((namespace: string) => Promise<IngestibleStore>) | null
  private readonly drainLease: { client: LeaseClient; ttlSecs: number } | null
  private readonly storePath: string | null
  private drainRefusedThisTick = false

  /** §7.8: publish (session → namespace) from exact echo evidence.
   *  Advisory and namespace-validated — an unparseable or unsafe value
   *  publishes nothing, never a guess. The tighter CLI predicate, not
   *  SAFE_STORE_RE: '.' and '..' are in-class there but are traversal
   *  names, and nothing hostile becomes a persisted annotation. */
  private publishSessionNamespace(
    sessionId: string,
    namespace: string | null,
    derivedFrom: SessionNamespaceAnnotation['derived_from'],
  ): void {
    if (!this.storePath || !namespace) return
    if (!isCliAddressableStoreName(namespace)) {
      // The CLI admits `--namespace` values this predicate refuses
      // ('.', '..', leading dash — in-class for SAFE_STORE_RE but
      // traversal or option-shaped). Such a server runs and stamps rows
      // normally while §7.8 publishes nothing for it, FOREVER. Refusing
      // is right — nothing hostile becomes a persisted annotation — but
      // refusing silently is how it stays undiagnosable (review of
      // chunk C). Say so once per attempt.
      dbg('ingest', 'session namespace NOT published: namespace is not CLI-addressable', {
        session: sessionId, namespace, derivedFrom,
      })
      return
    }
    writeSessionNamespaceAnnotation(this.storePath, sessionId, namespace, derivedFrom)
    dbg('ingest', 'session namespace published', { session: sessionId, namespace, derivedFrom })
  }

  readonly options: Required<Omit<IngestionOptions, 'storeName' | 'sweepIntervalMs' | 'stagingMaxBytes' | 'schemaCeiling' | 'onBatch' | 'storeFor' | 'drainLease' | 'storePath' | 'hookGapGraceMs'>> & { storeName?: string }
  private readonly hookGapGraceMs: number | undefined

  get errors(): ErrorTracker { return this.errorTracker }
  get loops(): LoopDetector { return this.loopDetector }

  constructor(private ctx: IngestibleStore, opts: IngestionOptions = {}) {
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 300_000
    this.stagingMaxBytes = opts.stagingMaxBytes ?? STAGING_MAX_BYTES
    this.schemaCeiling = opts.schemaCeiling ?? maxSupportedVersion
    this.onBatch = opts.onBatch ?? null
    this.storeFor = opts.storeFor ?? null
    this.drainLease = opts.drainLease ?? null
    this.storePath = opts.storePath ?? null
    this.hookGapGraceMs = opts.hookGapGraceMs
    const defaultOpts = {
      intervalMs: opts.intervalMs ?? INGESTION_TICK_MS,
      batchSize: opts.batchSize ?? 20,
      decayRate: opts.decayRate ?? 4.0,
      sessionId: opts.sessionId ?? ''
    }
    if (opts.storeName !== undefined) {
      this.options = { ...defaultOpts, storeName: opts.storeName }
    } else {
      this.options = defaultOpts
    }
  }

  start(): void {
    if (this.timer !== null || this.isRunning || this.isStopped) return
    // Once at start: heal every echo an older server drained without the
    // D261 boundary (a store this build cannot read is left to the newer
    // server — the first tick steps aside).
    try {
      if (this.ctx.store.liveSchemaVersion() <= this.schemaCeiling) this.healEchoes()
    } catch (err) {
      warn('[IngestionLoop] echo heal at start failed (the sweep retries):', err)
    }

    const loop = async () => {
      this.isRunning = true
      let ingested = 0
      let failure: string | undefined
      try {
        ingested = await this.ingestBatch()
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        warn('[IngestionLoop] Unhandled error in batch:', err)
      } finally {
        this.isRunning = false
        // A CANCELLED drain is not a FAILED drain, and the difference is
        // visible to users. `stop()` clears the timer without awaiting a
        // batch already in flight, and shutdown closes the store right
        // behind it — so the batch lands its `finally` against a closed
        // database and reports "the database connection is not open".
        // Publishing that left a pane on disk claiming treecontext had
        // broken, outliving the session that shut down cleanly. An observer
        // hears about drains that happened, not about a drain that was
        // interrupted on the way out.
        // A standby's refused tick is not a drain moment either (G4): a
        // server that does not hold the drain must publish nothing — the
        // pane is the drain owner's voice.
        if (this.onBatch && !this.isStopped && !this.drainRefusedThisTick) {
          try {
            this.onBatch({ ingested, ...(failure !== undefined ? { failure } : {}) })
          } catch (err) {
            // An observer that throws must not stop the drain — capture is
            // the product; anything watching it is not.
            warn('[IngestionLoop] onBatch observer threw (ignored):', err)
          }
        }
        if (!this.isStopped) {
          this.timer = setTimeout(loop, this.options.intervalMs)
        }
      }
    }

    this.timer = setTimeout(loop, this.options.intervalMs)

    const sweepLoop = async () => {
      try {
        await this.runSweep()
      } catch (err) {
        warn('[IngestionLoop] Sweep error:', err)
      } finally {
        if (!this.isStopped) {
          this.sweepTimer = setTimeout(sweepLoop, this.sweepIntervalMs)
        }
      }
    }
    this.sweepTimer = setTimeout(sweepLoop, this.sweepIntervalMs)
  }

  stop(): void {
    this.isStopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.sweepTimer !== null) {
      clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
    // Release whatever this drain still claims so a successor (a server
    // restart gets a NEW claimant identity) claims the rows immediately
    // instead of waiting out the crash TTL. Best-effort: on shutdown the
    // store may already be closing behind us, and an in-flight batch's
    // own finally covers its rows.
    try {
      this.ctx.store.releaseStagingClaims(this.claimant)
    } catch {
      /* store closing — the TTL covers what this could not */
    }
  }

  /**
   * D265 — the stale server steps aside. Release the drain lease (so the
   * newer server's next tick takes it, the row being gone rather than
   * waiting out its TTL) and this claimant's staging claims, say so once,
   * and stop the drain and the sweeps for good. Nothing is dropped: the
   * staged rows stay for the newer server. On the beta.1 night the
   * still-running rc.7 server instead retried 5 staging rows every 5 s
   * for 2 h 20 min, about 1620 attempts each.
   */
  private stepAside(storeVersion: number): void {
    this.steppedAside = true
    this.drainRefusedThisTick = true
    if (this.drainLease) {
      try {
        this.drainLease.client.release('drain')
      } catch (err) {
        // The TTL frees it within one lease period; say why it took that.
        dbg('ingest', 'stale drain: lease release failed — the TTL frees it', { error: String(err) })
      }
    }
    try {
      this.ctx.store.releaseStagingClaims(this.claimant)
    } catch {
      /* claims expire by TTL */
    }
    if (!staleDrainWarned) {
      staleDrainWarned = true
      warn(
        `[IngestionLoop] ${newerSchemaLine(storeVersion, this.schemaCeiling)} ` +
          'This server has stopped draining capture; the staged events wait for the newer server.',
      )
    }
    this.stop()
  }

  /**
   * Store handle for a staged row's target namespace (create-if-absent
   * via the injected factory; without a factory everything drains into
   * the serving handle — test/legacy construction only).
   *
   * An unresolved (NULL) stamp drains into the SERVING handle — the
   * drain owner's own namespace, exactly where every capture drained
   * before attribution existed. Not the literal 'project': a server
   * launched `--namespace work` must keep unresolved captures visible in
   * its own journal, not silently reroute them into an unserved trunk
   * tree (program-C review, finding 4). A stamp that fails the namespace
   * charset throws: the poison-row machinery records it rather than
   * silently misattributing the row.
   */
  private async handleFor(ns: string | null): Promise<IngestibleStore> {
    if (ns == null) return this.ctx
    if (!SAFE_STORE_RE.test(ns)) throw new Error(`Staged namespace '${ns}' is not a valid namespace name`)
    if (!this.storeFor) return this.ctx
    return await this.storeFor(ns)
  }

  /** Tombstone destination for a row/group. Only a GARBAGE stamp falls
   *  back to the serving handle (the hole must be recorded even when its
   *  stamp is unusable); a transient factory failure for a VALID stamp
   *  propagates instead — both callers already leave the row/group queued
   *  and retry next tick, which is self-healing where a wrong-journal
   *  tombstone is permanent (program-C review, finding 7). */
  private async tombstoneHandleFor(ns: string | null): Promise<IngestibleStore> {
    if (ns == null || !SAFE_STORE_RE.test(ns)) return this.ctx
    if (!this.storeFor) return this.ctx
    return await this.storeFor(ns)
  }

  /** Periodic staging hygiene (5-min timer): drop processed rows older
   *  than the retention window, and dedup-window anchors long past their
   *  300s usefulness (G2: anchors are swept with staging retention, per
   *  the design note). Returns the number of staging rows purged. */
  async runSweep(): Promise<number> {
    // D265: a server that never wins the drain still sweeps; one older
    // than the store steps aside here too, and stops sweeping it.
    if (this.steppedAside) return 0
    const live = this.ctx.store.liveSchemaVersion()
    if (live > this.schemaCeiling) {
      this.stepAside(live)
      return 0
    }
    const purged = this.ctx.store.purgeProcessedStaging()
    if (purged > 0) {
      dbg('sweep', `Purged ${purged} old processed staging rows`)
    }
    const anchors = this.ctx.store.pruneDedupAnchors()
    if (anchors > 0) {
      dbg('sweep', `Pruned ${anchors} expired dedup anchors`)
    }
    // §7.8 annotations (review 2026-08-15, C#5): session ids never
    // recycle, so nothing ever overwrites `session-*.ns.json` and the
    // directory grows one file per session forever — taxing the readdir
    // that rung-3 identity resolution performs on every insert.
    // NOT single-writer: runSweep has its own timer (see start()) and
    // takes no drain lease, so every capture-enabled server over this
    // store sweeps concurrently. That is safe rather than coordinated —
    // the unlink is idempotent and a lost race lands in the swallowing
    // catch — but only the logged count is affected by it, so do not
    // build anything here that assumes exclusivity.
    if (this.storePath) {
      const annotations = sweepSessionNamespaceAnnotations(this.storePath, SESSION_NS_ANNOTATION_TTL_SECS)
      if (annotations > 0) {
        dbg('sweep', `Swept ${annotations} stale session namespace annotations`)
      }
    }
    // The echo heal, one bounded page per sweep (ECHO_REINDEX_PAGE).
    const healed = healEchoIndex(this.ctx.store.database, this.echoHealAfter)
    this.echoHealAfter = healed.last
    if (healed.healed > 0) dbg('sweep', `Healed ${healed.healed} treecontext echoes drained without their index boundary`)
    return purged
  }

  /**
   * Heal, to the end of the journal, every treecontext echo drained
   * without its D261 boundary — what a still-running older server leaves
   * after the upgrade, indexed with its results and with nothing else to
   * heal it. Re-stamped and re-indexed exactly as migration 028 does
   * (persistence/echo-reindex.ts); content never touched; idempotent.
   * Runs once at start; the sweep then heals one page past the cursor.
   * Returns the number of rows healed.
   */
  healEchoes(): number {
    let total = 0
    for (;;) {
      const r = healEchoIndex(this.ctx.store.database, this.echoHealAfter)
      total += r.healed
      if (r.scanned === 0) break
      this.echoHealAfter = r.last
    }
    if (total > 0) dbg('sweep', `Healed ${total} treecontext echoes drained without their index boundary`)
    return total
  }

  /** Mark a call's earlier no-result or no-turn-end entry resolved by the
   *  entry just written (persistence/call-resolution.ts). Non-fatal: a
   *  failed mark leaves both entries as written, each true of its moment. */
  private resolveCall(toolUseId: string, callSession: string | null | undefined, resolverId: string, how: 'result' | 'capture-gap'): void {
    // A call is resolved only within its own client session: with none
    // named, nothing is.
    if (!callSession) return
    try {
      const marked = resolveEarlierCallEntries(this.ctx.store.database, toolUseId, callSession, resolverId, how)
      if (marked.length > 0) dbg('ingest', 'a call\'s earlier entry resolved', { toolUseId, resolverId, marked, how })
    } catch (err) {
      dbg('ingest', 'call resolution failed (both entries stand as written)', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Turn each dropped hook event in the gap ledger into a capture-gap
   *  row (hooks/gap-ledger.ts), once: a record whose row already landed
   *  (by its gap id) is not written again, and the claimed ledger is let
   *  go only once every row of it landed, so a failure here is retried
   *  next tick, never lost. */
  private async recordHookGaps(storePath: string): Promise<void> {
    let claim: ReturnType<typeof claimHookGaps>
    try { claim = claimHookGaps(storePath, this.hookGapGraceMs !== undefined ? { graceMs: this.hookGapGraceMs } : {}) } catch { return }
    if (claim.gaps.length === 0) { claim.done(); return }
    let all = true
    for (const g of claim.gaps) {
      try {
        const db = this.ctx.store.database
        // Only the drain's own capture-gap row answers: its label, which the
        // insert tool never lets a caller set, and the ledger record's id,
        // which it drops from every caller's row (server.ts).
        const seen = db.prepare(`SELECT 1 FROM nodes n WHERE COALESCE(n.source_label, '') = 'capture-gap' AND json_extract(n.metadata_json, '$.source') = 'capture-gap' AND json_extract(n.metadata_json, '$.gap_id') = ? AND ${ownLaneRowSql('n')} LIMIT 1`).get(g.id ?? '')
        if (seen) continue
        const gap = await this.ctx.insert(hookGapText(g), {
          createdAt: g.at,
          metadata: {
            source: 'capture-gap', event: 'hook_dropped', hook: g.hook, gap_id: g.id,
            session_id: g.sessionId || undefined,
            ...(g.agentId ? { agent_id: g.agentId } : {}), ...(g.agentType ? { agent_type: g.agentType } : {}),
            ...(g.toolUseId ? { [GAP_TOOL_USE_ID_KEY]: g.toolUseId } : {}),
            error: g.error.slice(0, 500), created_at: g.at, ingested_at: Date.now() / 1000,
          },
        })
        // D408: a call whose result was dropped here and whose no-result or
        // no-turn-end entry landed first is one call: that entry is marked
        // resolved by this gap row, never deleted.
        if (g.toolUseId) this.resolveCall(g.toolUseId, g.sessionId, gap.nodeId, 'capture-gap')
      } catch (err) {
        all = false
        warn('[IngestionLoop] A dropped hook event could not be recorded as a capture gap (retried next tick):', err)
      }
    }
    if (all) claim.done()
  }

  async ingestBatch(): Promise<number> {
    // Drain-role gate (G4): acquiring per tick IS the heartbeat, and a
    // refusal — live foreign holder, busy store, anything — skips the
    // tick rather than failing it; the next tick retries. The valve
    // below runs only in the process that holds the drain this tick.
    this.drainRefusedThisTick = false
    if (this.steppedAside) {
      this.drainRefusedThisTick = true
      return 0
    }
    if (this.drainLease) {
      try {
        this.drainLease.client.tryAcquire('drain', this.drainLease.ttlSecs)
      } catch (err) {
        dbg('ingest', 'tick — drain lease not held', {
          reason: err instanceof StoreLockedError ? 'foreign holder' : String(err),
        })
        this.drainRefusedThisTick = true
        return 0
      }
    }
    // D265: a store a newer treecontext has migrated past this build is
    // not this drain's to work. Read here — after the lease is taken, so
    // a standby never pays for it, and BEFORE the byte valve, so no valve
    // tombstone is written against a schema this build does not know.
    // One PRAGMA, no lock. A store OLDER than the build never gets here
    // running: the open migrated it.
    const live = this.ctx.store.liveSchemaVersion()
    if (live > this.schemaCeiling) {
      this.stepAside(live)
      return 0
    }
    // D3 byte valve: rows are never dropped for count reasons — any
    // backlog drains in full. Only when unprocessed staging BYTES exceed
    // the valve are oldest WHOLE sessions dropped, one capture-gap
    // tombstone each, so the journal records its own holes (JF-6).
    await this.applyStagingByteValve()

    // D314, D279: events the hooks could not write while the store
    // refused them sit in the gap ledger beside the store; the drain is the
    // store's next writer, so each becomes a capture-gap row now, at the
    // moment it was dropped. A ledger record lost here is retried never:
    // the claim renamed it, so a failed insert is logged, not repeated.
    if (this.storePath) await this.recordHookGaps(this.storePath)

    // Claim, don't fetch (G3): one UPDATE … RETURNING marks the batch as
    // ours — two drains get disjoint batches by construction, and the
    // double-ingestion hazard the drain lock existed to prevent is gone
    // at the SQL layer. A crashed drain's claims expire by TTL.
    const rows = this.ctx.store.claimStagingBatch(this.claimant, this.options.batchSize, STAGING_CLAIM_TTL_SECS)
    if (rows.length === 0) {
      dbg('ingest', 'tick — no claimable staging rows')
      return 0
    }

    dbg('ingest', 'batch starting', { rows: rows.length })
    const processedIds: number[] = []
    const deadline = Date.now() + 500  // max 500ms per tick

    try {
    for (const row of rows) {
      if (Date.now() > deadline) break  // yield to event loop
      try {
        // C1: every insert this row produces lands in the tree its stamp
        // names (NULL → 'project'). An invalid stamp throws into the
        // poison-row path below, which records it.
        const target = await this.handleFor(row.namespace)
        if (row.role === 'snapshot') {
          let snap: Record<string, unknown>
          try {
            snap = JSON.parse(row.content) as Record<string, unknown>
          } catch {
            // A drop is a drop: the charter's "every drop or dead-letter
            // leaves a protected tombstone" admits no malformed-JSON
            // exception (corpus audit D2 — this path retired the row
            // with only a stderr line, a hole the journal never
            // recorded). Retire it EXACTLY like the dead-letter path:
            // tombstone first, processed only if the tombstone landed.
            try {
              await target.insert(
                `[capture gap] Staging row ${row.id} (session ${row.sessionId ?? 'unknown'}, role snapshot) ` +
                  `carried malformed recovery-snapshot JSON and was dropped.\n` +
                  `Content prefix: ${row.content.slice(0, 500)}`,
                {
                  createdAt: row.timestamp,
                  metadata: {
                    source: 'capture-gap',
                    event: 'malformed_snapshot',
                    staging_id: row.id,
                    session_id: row.sessionId || undefined,
                    created_at: row.timestamp,
                    ingested_at: Date.now() / 1000,
                  },
                },
              )
              processedIds.push(row.id)
              warn(`[IngestionLoop] Malformed snapshot JSON in staging row ${row.id} — dead-lettered`)
            } catch (gapErr) {
              warn(
                `[IngestionLoop] Capture-gap insert for malformed snapshot row ${row.id} also failed (row stays queued):`,
                gapErr,
              )
            }
            continue
          }
          const queries = (snap.queries as string[]) || []
          const origSession = (snap.original_session_id as string) || 'unknown'
          const snapshotId = typeof snap.snapshot_id === 'number' && Number.isInteger(snap.snapshot_id) ? snap.snapshot_id : undefined

          // D286: the recovery row quotes what its queries found — each hit
          // at its display view, cut at the quote cap, named by its id —
          // and never another recovery row, so a snapshot cannot quote a
          // snapshot (the geometric growth that crossed the client's 16 MB
          // message guard, 2026-10-29). The query text goes to metadata,
          // not the indexed content, so the row is not the best match for
          // its own queries next time. Asked for twice the hits so that
          // dropping recovery rows still leaves the quota.
          //
          // D375: the staged row's session is the session that claimed the
          // snapshot, whose own lane the claim was made from. Its queries
          // run under that lane as the registry reads it now (the lane read,
          // persistence/lane-scope.ts), so a main checkout's recovery quotes
          // the main lane only and a worktree's its own; a session the
          // registry does not place searches the whole store, D240's rule
          // for a caller that cannot be told apart (no Claude Code start
          // claims for one, so this is a row staged by another client or
          // before this build).
          const lane = placedLaneOf(target.store.database, row.sessionId || null)
          const hitsByQuery: RecoveryHit[][] = []
          for (const q of queries) {
            // Recovery queries run against the row's own namespace — a
            // subagent's snapshot must not be rehydrated from the trunk.
            const results = await target.query(q, { topK: RECOVERY_HITS_PER_QUERY * 2, ...(lane ? { lane } : {}) })
            hitsByQuery.push(results.map((r) => ({ nodeId: r.nodeId, content: r.content, metadata: r.metadata })))
          }
          const recoveredText = buildRecoveryContent(queries, hitsByQuery)

          // D375: the row is the claiming session's own, in its session,
          // so every lane read places it where the claim was made; a row
          // with no session read as the main lane's whoever claimed it.
          // It is identified by the claim, the snapshot (or, staged before
          // the claim carried it, the staged row) and the claiming session,
          // never by its text: a recovery that reads like another lane's or
          // an earlier claim's is still written, here.
          await target.insert(recoveredText, {
            decayRate: this.options.decayRate,
            createdAt: row.timestamp,
            metadata: {
              source: RECOVERY_SNAPSHOT_SOURCE,
              session_id: row.sessionId || undefined,
              original_session_id: origSession,
              ...(snapshotId !== undefined ? { [RECOVERY_SNAPSHOT_ID_KEY]: snapshotId } : {}),
              [RECOVERY_STAGING_ID_KEY]: row.id,
              recovered_at: Date.now() / 1000,
              [RECOVERY_QUERIES_KEY]: queries,
              // The row's own boundaries: a hit on it is a bounded preview
              // with the availability marker, like a tool event's (D4).
              ...recoverySnapshotBoundaries(recoveredText.length),
            }
          })
        } else if ((row.capturedFrom === NO_RESULT_MARK || row.capturedFrom === NO_TURN_END_MARK) && row.toolUseId != null && this.ctx.store.database.prepare(
          `SELECT 1 FROM staging WHERE session_id IS ? AND tool_use_id = ? AND (captured_from IS NULL OR captured_from NOT IN (?, ?, ?)) LIMIT 1`,
        ).get(row.sessionId, row.toolUseId, PRE_TOOL_USE_MARK, NO_RESULT_MARK, NO_TURN_END_MARK)) {
          // D408: the call's own result arrived after its turn's end was
          // staged; the call is journaled once, from its result.
        } else if (row.capturedFrom === PRE_TOOL_USE_MARK) {
          // D408: Codex's PreToolUse is the account of a call held until the
          // call's own PostToolUse or its turn's end; it is no entry itself.
          // The call is journaled once, from whichever of the two comes.
        } else if (row.kind === TURN_INTERRUPTED_KIND) {
          // D408: a turn the developer interrupted (Codex's Interrupt, no
          // Stop): a capture-gap entry naming its reply as not captured,
          // and no assistant text, which no payload carried.
          await target.insert(row.content, {
            createdAt: row.timestamp,
            metadata: {
              source: 'capture-gap',
              event: 'turn_interrupted',
              role: row.role,
              session_id: row.sessionId || undefined,
              created_at: row.timestamp,
              ingested_at: Date.now() / 1000,
            },
          })
        } else {
          // Build enriched metadata. created_at is the hook's CAPTURE time —
          // never drain-time wall clock, so backlog drains keep honest
          // chronology; ingested_at records the drain for lag observability.
          const meta: Record<string, unknown> = {
            source: 'auto-capture',
            role: row.role,
            session_id: row.sessionId || undefined,
            tool_name: row.toolName || undefined,
            priority: row.priority,
            created_at: row.timestamp,
            ingested_at: Date.now() / 1000,
          }

          // C4: carry the producer's boundaries into node metadata.
          // _index_len drives indexTextFor's FTS slice (post-018 hooks
          // always stamp it — self-describing recompute); _preview_len is
          // where the read side cuts a hit's display when the indexed view
          // extends past the preview.
          if (row.indexLen != null) {
            meta._index_len = row.indexLen
          }
          if (row.previewLen != null) {
            meta._preview_len = row.previewLen
          }
          // D261: the drain is authoritative for an echo's boundaries. A
          // treecontext tool call's echo enters the index by its arguments
          // alone and is displayed whole, whatever hook copy staged it.
          const echoMeta = stampEchoBoundaries(row.content, meta)
          if (echoMeta !== meta && echoMeta) Object.assign(meta, echoMeta)

          // D190: the writer the hook payload named — a subagent's
          // agent_type (its role, the lane) and agent_id — is stamped by
          // the store, from the platform's payload, never claimed by the
          // writer. A row naming none is the main agent's (the main lane).
          // D263: a report the SubagentStop hook staged as the client's own
          // internal agent's (kind `internal-summary`) is the client's,
          // `claude-code`, never the unregistered agent id's.
          if (row.kind === INTERNAL_SUMMARY_KIND) {
            meta._writer = CLIENT_WRITER
            if (row.agentId != null) meta._writer_agent_id = row.agentId
            meta._writer_src = 'hook'
          } else if (row.agentType != null || row.agentId != null) {
            meta._writer = agentWriterOf(row.agentType, row.agentId)
            if (row.agentId != null) meta._writer_agent_id = row.agentId
            meta._writer_src = 'hook'
          }
          // D295, D288: a `claude -p` child's own captures land in its
          // worker's lane, stamped with the worker's identity as declared
          // by its ticket and read by the hook (its role as writer, its
          // parent and directory), the child's own session kept beside: its
          // own session is the lane when the hook claimed the ticket, or is
          // linked to the lane the ticket door registered.
          let workerLane: string | null = null
          if (row.agentId == null && row.agentType == null && row.kind !== INTERNAL_SUMMARY_KIND && row.sessionId) {
            try {
              const worker = workerLaneOf(this.ctx.store.database, row.sessionId)
              if (worker) {
                workerLane = worker.sessionId
                meta.session_id = worker.sessionId
                if (worker.sessionId !== row.sessionId) meta._client_session_id = row.sessionId
                meta._writer = legWriterOf(worker)
                meta._writer_agent_id = worker.agentId
                meta._writer_src = 'declared'
                meta[DOOR_KEY] = 'hooks'
                meta[IDENTITY_KEY] = 'declared'
                Object.assign(meta, legTraceOf(worker))
              }
            } catch (err) {
              dbg('ingest', 'worker lane read failed (the row lands in its own session)', { error: err instanceof Error ? err.message : String(err) })
            }
          }
          // D147: the row's kind, as the hook staged it (the subagent's
          // summary).
          if (row.kind != null) meta.kind = row.kind
          // D400, D401: the client's id for a tool call, how a call that did
          // not succeed ended, and a row the batch's account added. A
          // successful call's own row carries no outcome.
          if (row.toolUseId != null) meta.tool_use_id = row.toolUseId
          if (row.outcome != null) meta.outcome = row.outcome
          if (row.capturedFrom != null) meta.captured_from = row.capturedFrom
          // A treecontext tool's echo is evidence only when it is the call's
          // own successful event: a failed call wrote nothing (D400), and
          // the batch's account of a call is what the client told the model,
          // never the call's own reply (D401). Neither heals or publishes.
          const ownEcho = row.outcome == null && row.capturedFrom == null
          // D284, D309, D329: a leg's summary row is a row of its run,
          // carrying the run and the key read from the leg's registration
          // (leg-registry.ts legReturnStamp), never from the report's text;
          // the key lookup's pointer to the leg's return finds it in the
          // leg's lane (D336). A subagent with no run stays as today (D305).
          // Non-fatal: a failed read leaves the summary as it always was.
          if (row.kind === SUBAGENT_SUMMARY_KIND && row.agentId != null && row.sessionId) {
            try {
              Object.assign(meta, this.ctx.store.legReturnStamp({ sessionId: row.sessionId, agentId: row.agentId }))
            } catch (err) {
              dbg('ingest', 'leg return stamp failed (summary lands without its run)', { error: err instanceof Error ? err.message : String(err) })
            }
          }

          // Intent classification (user messages only)
          if (row.role === 'user') {
            meta.intent = classifyIntent(row.content)
          }

          // C4: distinguish the Stop-hook's full assistant-response capture
          // (role 'assistant', no tool_name) from a post-tool-use preview
          // (role 'assistant' WITH tool_name) — indexTextFor (C2) already
          // keys its 4000-char cap off this same (role, tool_name) shape;
          // this marker is for downstream consumers that want to identify
          // "this node is a turn's final response" directly.
          if (row.role === 'assistant' && !row.toolName) {
            meta.event = 'response'
          }

          // Exit classification + error tracking (tool results / assistant messages with tool output)
          // D400: a call's own failure event decides its class before any
          // text heuristic: it is an error. D401: the batch's account of a
          // call does not classify why the call did not run, so its row has
          // no class at all, and neither opens nor resolves an error below.
          // D404: where the client's own event stated how the call ended,
          // the class is the client's word and the text decides nothing: a
          // stated success (staging's `stated_by`, migration 036) is a
          // success, never a soft fail. Otherwise the text decides, as
          // before. The entry says which decided (`exit_by`).
          if ((row.role === 'assistant' || row.role === 'tool_result') && row.toolName && row.capturedFrom == null) {
            const decided = exitClassOf(row)
            meta.exit_type = decided.exitType
            meta[EXIT_BY_KEY] = decided.by

            // Loop detection
            const loopWarning = this.loopDetector.record(row.toolName, row.content)
            if (loopWarning) {
              meta.loop_detected = true
              meta.loop_count = loopWarning.count
              meta.loop_tool = loopWarning.toolName
              dbg('ingest', loopWarning.message)
            }
          }

          // Project attribution
          const attribution = attributeProject(
            this.options.storeName,
            row.sessionId,
            null,  // cwd not available in ingestion loop
          )
          if (attribution.confidence > 0) {
            meta.project = attribution.project
            meta.project_confidence = attribution.confidence
          }

          const result = await target.insert(row.content, {
            decayRate: this.options.decayRate,
            createdAt: row.timestamp,
            metadata: meta,
          })

          // D408: the call's own result after its no-result or no-turn-end
          // entry landed: the call is one call, the earlier entry marked
          // resolved by this one (never deleted: it was true when written).
          if (row.toolUseId != null && row.capturedFrom == null) this.resolveCall(row.toolUseId, row.sessionId, result.nodeId, 'result')

          // V2 echo heal (docs/session-identity.md §7.3 + §7.7): the echo
          // of a treecontext_insert names the curated row its call
          // touched; stamp that row's session identity from the echo's
          // hook-provided session id. Non-fatal by design — a failed heal
          // is a logged degradation to the insert-time ladder, never a
          // poisoned capture row; the echo node above landed regardless.
          // A worker's rows were stamped by its own lane, exactly; the heals
          // read a session's registry, which a worker's lane is not.
          if (ownEcho && row.role === 'assistant' && isInsertEchoTool(row.toolName) && row.sessionId && workerLane === null) {
            try {
              // D359: a refused checkpoint's echo names its caller exactly and
              // carries the refusal's id: the pending refusal moves to that
              // writer, and its key is settled as its own.
              const refusalId = extractRefusalId(row.content, row.previewLen)
              if (refusalId) {
                try {
                  const moved = this.ctx.store.healCapRefusalFromEcho({ echoSessionId: row.sessionId, refusalId, agentId: row.agentId ?? null })
                  dbg('ingest', 'cap refusal heal', { refusalId, ...moved })
                  const opener = (this.ctx as { openRunOfLeg?: (ref: { sessionId: string; agentId: string }) => void }).openRunOfLeg
                  if (moved.settled && row.agentId != null && typeof opener === 'function') opener.call(this.ctx, { sessionId: row.sessionId, agentId: row.agentId })
                } catch (capErr) {
                  dbg('ingest', 'cap refusal heal failed (the refusal stays pending)', { error: capErr instanceof Error ? capErr.message : String(capErr) })
                }
              }
              const echo = extractInsertEcho(row.content, row.previewLen)
              if (echo) {
                // D190 (F1): the echo carries the CALLER's agent fields, so
                // it names the row's writer exactly; the insert-time stamp
                // was the registry's reading. Its own try: a failed writer
                // heal leaves the provisional stamp, disclosed as such.
                try {
                  const healed = this.ctx.store.healWriterFromEcho({
                    nodeId: echo.nodeId, echoSessionId: row.sessionId, echoTs: row.timestamp,
                    deduplicated: echo.deduplicated, agentId: row.agentId, agentType: row.agentType,
                  })
                  dbg('ingest', 'writer heal', { node: echo.nodeId, ...healed })
                  // D302: a leg whose key the echo settled under a run it
                  // had no run of (an ambiguous key across runs) opens that
                  // run as at a registration; a no-op otherwise.
                  const opener = (this.ctx as { openRunOfLeg?: (ref: { sessionId: string; agentId: string }) => void }).openRunOfLeg
                  if (row.agentId != null && typeof opener === 'function') opener.call(this.ctx, { sessionId: row.sessionId, agentId: row.agentId })
                } catch (writerErr) {
                  dbg('ingest', 'writer heal failed (row keeps its insert-time stamp)', {
                    error: writerErr instanceof Error ? writerErr.message : String(writerErr),
                  })
                }
                const outcome = this.ctx.store.healCuratedSessionIdentity({
                  nodeId: echo.nodeId,
                  echoSessionId: row.sessionId,
                  echoTs: row.timestamp,
                  deduplicated: echo.deduplicated,
                  // D391: a hit's echo heals only from the survivor's lane.
                  agentId: row.agentId ?? null,
                  agentType: row.agentType ?? null,
                })
                dbg('ingest', 'echo heal', { node: echo.nodeId, outcome, deduplicated: echo.deduplicated })
                // §7.8: the correlation itself — this session's call
                // touched this row, so this session's server serves this
                // row's tree — is namespace evidence whatever the
                // ATTRIBUTION branch decided; kept-exact still correlates.
                // The gate is an ALLOW-list, not a negative list: a new
                // outcome must be admitted deliberately, or it rides in
                // silently (review 2026-08-15, C-finder). That excludes
                // 'outside-window' and 'unreadable' too — the heal
                // refused its own sanity checks, so the publisher does
                // not trade on them. Publish so hooks resolve pid-free.
                if (CORRELATED_ECHO_OUTCOMES.has(outcome)) {
                  this.publishSessionNamespace(row.sessionId, this.ctx.store.nodeNamespace(echo.nodeId), 'insert-heal')
                }
              }
            } catch (healErr) {
              dbg('ingest', 'echo heal failed (row keeps its ladder attribution)', {
                error: healErr instanceof Error ? healErr.message : String(healErr),
              })
            }
          }

          // §7.8: a status echo's own output names the serving namespace —
          // the channel that fires at session start (orientation calls
          // status first thing), long before any insert exists.
          // storePath gates the whole branch, not just the publish: it IS
          // the discriminator the extractor checks `store_path` against
          // (review 2026-08-15, C#1). Without one there is nothing to
          // prove the echo describes THIS store, so there is nothing to
          // publish — and publishSessionNamespace would drop it anyway.
          if (ownEcho && row.role === 'assistant' && isStatusEchoTool(row.toolName) && row.sessionId && this.storePath) {
            this.publishSessionNamespace(
              row.sessionId,
              extractStatusNamespace(row.content, this.storePath, row.previewLen),
              'status-echo',
            )
          }

          // Error tracking: record errors, attempt resolution
          if ((row.role === 'assistant' || row.role === 'tool_result') && row.toolName && meta.exit_type !== undefined) {
            const exitType = meta.exit_type as ExitType
            if (exitType === 'error') {
              this.errorTracker.recordError({
                stagingId: row.id,
                nodeId: result.nodeId,
                fingerprint: row.toolName,
                timestamp: row.timestamp,
              })
            } else if (exitType === 'success') {
              const resolved = this.errorTracker.tryResolve(row.toolName)
              if (resolved) {
                dbg('ingest',
                  `Error resolved: ${row.toolName} (error node ${resolved.nodeId}, ` +
                  `latency ${Math.round((row.timestamp - resolved.timestamp) * 1000)}ms)`,
                )
              }
            }
          }
        }
        processedIds.push(row.id)
      } catch (err) {
        // Poison-row dead-letter: bump the persistent failure counter; after
        // MAX_INGEST_ATTEMPTS the row is retired with a capture-gap node
        // recording the failure — pre-fix, >= batchSize deterministic
        // failures wedged the drain forever (oldest-first fetch always
        // returned the same rows).
        const errMsg = err instanceof Error ? err.message : String(err)
        const attempts = this.ctx.store.incrementStagingAttempts(row.id)
        if (attempts >= MAX_INGEST_ATTEMPTS) {
          // The row is retired ONLY once its dead-letter record exists. If
          // the dead-letter insert shares the failing dependency (embedder
          // outage, store contention), marking the row processed anyway
          // would mass-destroy a backlog with no recorded gap — the exact
          // D3 violation this path exists to prevent. Leave it unprocessed
          // and retry the whole pair next tick.
          try {
            // JF-7: never embed the poison payload — a short prefix only.
            // The tombstone lands in the row's own namespace; an unusable
            // stamp (the very failure being recorded, possibly) falls back
            // to the trunk so the hole is recorded regardless.
            const tombstoneTarget = await this.tombstoneHandleFor(row.namespace)
            await tombstoneTarget.insert(
              `[capture gap] Staging row ${row.id} (session ${row.sessionId ?? 'unknown'}, role ${row.role}` +
                `${row.toolName ? `, tool ${row.toolName}` : ''}) failed ingestion ${attempts} times and was ` +
                `dead-lettered.\nError: ${errMsg.slice(0, 500)}\nContent prefix: ${row.content.slice(0, 500)}`,
              {
                createdAt: row.timestamp,
                metadata: {
                  source: 'capture-gap',
                  event: 'ingest_failure',
                  staging_id: row.id,
                  session_id: row.sessionId || undefined,
                  error: errMsg.slice(0, 500),
                  created_at: row.timestamp,
                  ingested_at: Date.now() / 1000,
                },
              },
            )
            processedIds.push(row.id)
            warn(`[IngestionLoop] Staging row ${row.id} dead-lettered after ${attempts} attempts: ${errMsg}`)
          } catch (dlErr) {
            warn(
              `[IngestionLoop] Dead-letter insert for staging row ${row.id} also failed (row stays queued):`,
              dlErr,
            )
          }
        } else {
          warn(`[IngestionLoop] Failed to insert staging row ${row.id} (attempt ${attempts}):`, err)
        }
      }
      // Cooperative scheduling: yield to event loop between rows so
      // interactive tool calls can interleave with batch ingestion.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    } finally {
      // Retire and release in the same breath, even when a row throws
      // out of the loop: claims must never outlive the tick that took
      // them (the TTL is for crashes, never for routine leftovers —
      // amendment 7). The mark is FENCED by claimant: a row reclaimed
      // after our claim expired mid-tick belongs to its new claimant.
      if (processedIds.length > 0) {
        const marked = this.ctx.store.markStagingProcessedOwned(processedIds, this.claimant)
        dbg('ingest', 'batch complete', { processed: marked, attempted: processedIds.length, remaining: rows.length - processedIds.length })
      }
      if (processedIds.length < rows.length) {
        const released = this.ctx.store.releaseStagingClaims(this.claimant)
        if (released > 0) dbg('ingest', 'released leftover claims', { released })
      }
    }

    return processedIds.length
  }

  /**
   * D3 byte valve. When unprocessed staging bytes exceed STAGING_MAX_BYTES,
   * drop oldest WHOLE (session, namespace) groups (never mid-session holes)
   * until under budget, inserting one protected capture-gap tombstone per
   * dropped group — into that group's own namespace (C1) — so each journal
   * records its own hole (JF-6). The newest group is never dropped — it is
   * the live capture stream.
   */
  private async applyStagingByteValve(): Promise<void> {
    // Cheap gate: bytes can only exceed the valve when the row count could
    // mathematically reach it — every row is <= STORE_SAFETY_CAP chars,
    // i.e. <= 4x that in utf8 bytes. Skips the SUM(LENGTH(...)) full scan
    // on every normal tick.
    const pending = this.ctx.store.countUnprocessedStaging()
    if (pending * STORE_SAFETY_CAP * 4 < this.stagingMaxBytes) return

    const total = this.ctx.store.sumUnprocessedStagingBytes()
    if (total <= this.stagingMaxBytes) return

    const groups = this.ctx.store.unprocessedStagingSessions(Date.now() / 1000 - STAGING_CLAIM_TTL_SECS) // oldest first
    let excess = total - this.stagingMaxBytes
    // The live capture stream is a SESSION, not a (session, namespace)
    // group: a session whose rows straddle two stamps — a NULL-stamped
    // prefix from hooks that fired before the server's annotation landed,
    // a stamped suffix after — splits into two groups, and dropping the
    // older half would tear a mid-session hole the pre-attribution
    // grouping made impossible by construction (program-C review,
    // finding 3). Protect EVERY group of the newest session.
    const liveSession = groups.length > 0 ? groups[groups.length - 1]!.sessionId : null
    // A group with LIVE claims is also protected (G3): another drain
    // holds those rows in flight and will ingest them — dropping the
    // group would tombstone a "hole" that was actually captured. The
    // valve steals only from the unclaimed and the expired; this tick's
    // own claims can't appear (the valve runs before claiming).
    const droppable = groups.filter((g) => g.sessionId !== liveSession && g.liveClaims === 0)
    if (droppable.length === 0) {
      // Everything belongs to the live stream — never dropped. The valve
      // cannot reduce; say so instead of silently rescanning forever.
      warn(
        `[IngestionLoop] Staging byte valve exceeded (${total} bytes) but all rows belong to one session — nothing droppable`,
      )
      return
    }
    for (let i = 0; i < droppable.length && excess > 0; i++) {
      const s = droppable[i]!
      // Tombstone FIRST, drop SECOND — same ordering rule as the
      // dead-letter path. If the tombstone insert fails, the group is
      // NOT dropped: a permanent unrecorded hole is worse than staying
      // over the valve for another tick.
      let tombstoneNodeId = ''
      try {
        const spanStart = new Date(s.spanStart * 1000).toISOString()
        const spanEnd = new Date(s.spanEnd * 1000).toISOString()
        const tombstoneTarget = await this.tombstoneHandleFor(s.namespace)
        tombstoneNodeId = (await tombstoneTarget.insert(
          `[capture gap] ${s.rows} staged events from session ${s.sessionId ?? 'unknown'} ` +
            `(${spanStart} – ${spanEnd}) were dropped by the staging byte valve before ingestion. ` +
            `The journal has a hole here.`,
          {
            createdAt: s.spanEnd,
            metadata: {
              source: 'capture-gap',
              event: 'capture_gap',
              session_id: s.sessionId || undefined,
              dropped_count: s.rows,
              span_start: s.spanStart,
              span_end: s.spanEnd,
              created_at: s.spanEnd,
              ingested_at: Date.now() / 1000,
            },
          },
        )).nodeId
      } catch (err) {
        warn('[IngestionLoop] Capture-gap tombstone failed — session NOT dropped:', err)
        continue
      }
      // The tombstone insert awaited above, so a drain may have claimed
      // into this group since the group scan: the drop is atomic
      // whole-group-or-nothing against live claims as of NOW.
      const dropped = this.ctx.store.dropUnprocessedStagingSession(
        s.sessionId,
        s.namespace,
        Date.now() / 1000 - STAGING_CLAIM_TTL_SECS,
      )
      if (dropped === 0) {
        // A live claim raced in — the group is in flight, not a hole.
        // The already-inserted tombstone would overstate; take it back.
        dbg('valve',
          `Staging byte valve: session ${s.sessionId ?? '(none)'} was claimed mid-drop — left intact`,
        )
        try {
          ;(await this.tombstoneHandleFor(s.namespace)).delete(tombstoneNodeId)
        } catch {
          /* the overstating tombstone stays — conservative, and logged above */
        }
        continue
      }
      excess -= s.bytes
      warn(
        `[IngestionLoop] Staging byte valve: dropped session ${s.sessionId ?? '(none)'} ` +
          `(${dropped} rows, ${s.bytes} bytes) — tombstoned`,
      )
    }
  }
}
