import type { Database } from '../database.js'
import { contentFingerprintV1 } from '../../fingerprint.js'
import { sessionOf, dedupClassOf, parseMeta, reliedCountOf, liftBoundary } from '../../dedup-identity.js'
import { decodeContent } from '../content-codec.js'
import { EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from '../index-text.js'
import { dbg } from '../../debug.js'
import { CURATED_INDEX_DDL } from '../curated-index.js'

/**
 * The arbiter backfill — migration 022's whole body (021 lays the shape;
 * this is the one full pass every upgrading store pays exactly once, G2
 * review). Computes fingerprint, dedup class, session key, reliance
 * count, and boundary columns for EVERY nodes row with the SAME
 * functions the live insert path uses — identity by construction — then
 * resolves curated fingerprint twins losslessly, seeds the auto-dedup
 * window anchors (warm-scan parity: without this, a duplicate arriving
 * inside the window of a pre-migration row would not dedup, and a
 * repeated namespace merge would re-copy every auto row), and
 * (re)creates the partial unique index.
 *
 * Recompute-all makes replay idempotent by VALUE: recomputed classes
 * re-enter the twin resolver, which re-picks the same earliest-wins
 * survivor — deterministic on (created_at, rowid) — and the anchor seed
 * only ever moves last_seen forward.
 *
 * THE KEY IS `contentFingerprintV1`, EXPLICITLY. This pass is shipped
 * ladder history: stores climbed 023 with the pre-digest key, so 023
 * must keep writing that key however the live function changes — the
 * 022 tombstone rule ("a ladder position, once released to any store, is
 * never renumbered") applied to a step's BEHAVIOR. Migration 024 is the
 * one step that rewrites those keys as digests
 * (docs/project-identity.md §11b).
 *
 * Losslessness: twins are never merged or deleted (V1 fingerprint
 * equality over 128 chars is head/tail/length — a structural key that
 * measurably files different texts together, §9.2 — never proof of byte
 * equality); metadata_json is never touched. A row whose content cannot
 * be decoded is SKIPPED with a debug line (columns stay NULL/stale)
 * rather than failing the ladder — an additive batch has no backup to
 * restore.
 */
/**
 * Earliest-wins curated twin resolution, over WHATEVER the fingerprint
 * column currently holds.
 *
 * Earliest (created_at, rowid) keeps 'curated'; every later twin in the
 * (tree_id, fingerprint) group demotes to 'curated_dup'. One pass, no
 * positional params to transpose; a replay finds rn=1 rows only and
 * no-ops.
 *
 * KEY-AGNOSTIC ON PURPOSE. 023 runs it over V1 keys and 024 re-runs it
 * verbatim over the digest keys (§11b step 3): the rule is about the
 * COLUMN, never about how the column was computed, so extracting it
 * cannot drift the two callers apart — and 024 gets the same
 * earliest-wins guarantee 023 shipped rather than a paraphrase of it.
 *
 * `fingerprint IS NOT NULL`: undecodable rows carry a class but no
 * fingerprint — NULLs must not partition together and demote each other
 * arbitrarily. (The partial unique index treats NULLs as distinct, so
 * they never conflict either.)
 *
 * The caller must have dropped `idx_nodes_curated_fp` first: mid-pass the
 * group is briefly all-'curated', which the index would refuse.
 */
export function demoteCuratedTwins(db: Database): void {
  db.exec(`UPDATE nodes SET dedup_class = 'curated_dup'
    WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (
                 PARTITION BY tree_id, fingerprint
                 ORDER BY created_at ASC, rowid ASC) AS rn
          FROM nodes WHERE dedup_class = 'curated' AND fingerprint IS NOT NULL)
      WHERE rn > 1);`)
}

export function runArbiterBackfill(db: Database): void {
  // The index goes away while the backfill runs and is rebuilt after
  // twin resolution. Without this, a replay (marker rollback, or a store
  // that gained fingerprint-less rows after the index existed) dies on
  // the constraint mid-backfill: classification briefly makes both twins
  // 'curated' before the resolver picks the survivor.
  db.exec(`DROP INDEX IF EXISTS idx_nodes_curated_fp;
    DROP INDEX IF EXISTS idx_nodes_session_time;
    DROP INDEX IF EXISTS idx_nodes_session_time_v2;
    DROP INDEX IF EXISTS idx_nodes_session_key;`)

  // Keyset-chunked so the working set is one batch of content blobs,
  // never the whole store: this pass may be the first reader of a store
  // of any size, and nothing else bounds nodes content. Keyset (rowid
  // cursor) rather than .iterate(): the loop UPDATEs the same table it
  // scans.
  const selectBatch = db.prepare(
    `SELECT rowid AS rid, node_id, content, source_label, metadata_json
       FROM nodes WHERE rowid > ?
       ORDER BY rowid LIMIT 500`,
  )
  const update = db.prepare(
    `UPDATE nodes SET fingerprint = ?, dedup_class = ?, session_key = ?,
                      relied_count = ?, index_len = ?, preview_len = ?
      WHERE node_id = ?`,
  )
  const metaOnlyUpdate = db.prepare(
    'UPDATE nodes SET dedup_class = ?, session_key = ?, relied_count = ? WHERE node_id = ?',
  )
  let cursor = 0
  let skipped = 0
  for (;;) {
    const batch = selectBatch.all(cursor) as Array<{
      rid: number
      node_id: string
      content: string | Buffer
      source_label: string | null
      metadata_json: string | null
    }>
    if (batch.length === 0) break
    cursor = batch[batch.length - 1]!.rid
    for (const row of batch) {
      const meta = parseMeta(row.metadata_json)
      const cls = dedupClassOf(row.source_label, meta)
      const sessionKey = sessionOf(meta)
      const relied = reliedCountOf(meta)
      let decoded: string
      try {
        decoded = decodeContent(row.content)
      } catch (err) {
        skipped++
        dbg('migration', 'arbiter backfill: content undecodable — metadata-only stamp', {
          nodeId: row.node_id,
          error: err instanceof Error ? err.message : String(err),
        })
        // Everything that needs only the METADATA still lands (G5
        // review): the row keeps its session for windows and retention
        // grouping, its reliance protection, and its class. Only the
        // fingerprint and the content-length-validated boundaries wait
        // for a runtime that can decode the content.
        metaOnlyUpdate.run(cls, sessionKey, relied, row.node_id)
        continue
      }
      const fp = contentFingerprintV1(decoded)
      update.run(
        fp,
        cls,
        sessionKey,
        relied,
        liftBoundary(meta?.[EXPLICIT_INDEX_LEN_KEY], decoded.length),
        liftBoundary(meta?.[EXPLICIT_PREVIEW_LEN_KEY], decoded.length),
        row.node_id,
      )
    }
  }
  if (skipped > 0) {
    dbg('migration', 'arbiter backfill finished with undecodable rows left NULL', { skipped })
  }

  // ── Curated twins: lossless resolution before the index exists ──────
  demoteCuratedTwins(db)

  // The constraint that makes curated dedup true for every writer in
  // every process (the insert path relies on its ON CONFLICT refusal).
  db.exec(
    CURATED_INDEX_DDL,
  )

  // ── Seed the auto-dedup window (warm-scan parity) ───────────────────
  // Newest occurrence per (tree, session, fingerprint) — the exact rule
  // the retired open-time scan used. Conflict handling only ever slides
  // last_seen FORWARD (JF-4): a replay, or a live anchor that has slid
  // past its row's created_at, is never dragged back. updated_at is wall
  // time so the hygiene sweep gives fresh seeds their full grace.
  // fingerprint IS NOT NULL, same guard as the twin resolver above: an
  // undecodable auto row carries a class but no fingerprint, and
  // dedup_anchors.fingerprint is NOT NULL — without the filter one such
  // row violated the constraint, the additive batch rolled back, and
  // the store became permanently unopenable (release-diff review
  // 2026-08-15, reproduced). The filter must live in the SUBQUERY:
  // ROW_NUMBER partitions NULL fingerprints together, so tolerating
  // them at insert time would still pick arbitrary winners.
  const nowWall = Date.now() / 1000
  db.prepare(
    `INSERT INTO dedup_anchors (tree_id, session_key, fingerprint, node_id, last_seen, updated_at)
     SELECT tree_id, session_key, fingerprint, node_id, created_at, ?
       FROM (SELECT tree_id, session_key, fingerprint, node_id, created_at,
                    ROW_NUMBER() OVER (PARTITION BY tree_id, session_key, fingerprint
                                       ORDER BY created_at DESC, rowid DESC) AS rn
               FROM nodes WHERE dedup_class = 'auto' AND fingerprint IS NOT NULL)
      WHERE rn = 1
     ON CONFLICT(tree_id, session_key, fingerprint) DO UPDATE SET
       node_id = CASE WHEN excluded.last_seen > last_seen THEN excluded.node_id ELSE node_id END,
       last_seen = MAX(last_seen, excluded.last_seen),
       updated_at = excluded.updated_at`,
  ).run(nowWall)

  // Built AFTER the whole-store UPDATE pass (one bulk build, not per-row
  // B-tree maintenance) — and here rather than in 021's DDL, so interim
  // stores that migrated before the swap existed are healed by the same
  // ladder step that runs this pass (G5 review, finding 2).
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_session_key ON nodes(tree_id, session_key, created_at);')
}
