import type { Migration } from '../migrations.js'
import type { Database } from '../database.js'
import { hasTable } from './guards.js'
import { demoteCuratedTwins } from './arbiter-backfill.js'
import { contentFingerprintV2 } from '../../fingerprint.js'
import { decodeContent } from '../content-codec.js'
import { dbg, warn } from '../../debug.js'
import { CURATED_INDEX_DDL } from '../curated-index.js'

/**
 * The fingerprint becomes a digest (docs/project-identity.md §9.2 →
 * §11b, pre-registered 2026-08-20).
 *
 * Until this rung `contentFingerprint` returned a STRUCTURAL key above
 * 128 chars — head(64) + NUL + tail(64) + ":" + normalized length —
 * which measurably files genuinely different texts under one key: 97
 * keys over 219 rows (2.2%) on this project's own 10k-row store, because
 * captured tool calls share a prefix and a suffix and differ in a
 * fixed-width middle identifier. `curatedHolder` is store-wide and
 * permanent, so on the import/merge path a collision is silent data
 * loss. This pass rewrites every decodable row's key as
 * `sha256(normalized).hex.slice(0,32)`.
 *
 * DESTRUCTIVE, so the runner copies the store aside first — and the
 * backup is the only protection that exists here. `recordCompletionVerdict`
 * compares `nodes` COUNT(*) between backup and store, which a pure VALUE
 * rewrite cannot change: the verdict reads 'success' whatever this pass
 * writes, and 'success' makes the backup sweep-eligible
 * (`isLiveRollback` is `verdict !== 'success'`). The verdict is
 * therefore STRUCTURALLY BLIND to this migration (§11b, review finding
 * 3). What stands in its place is `selfCheck` below, which runs inside
 * the batch transaction and THROWS — rolling the whole ladder back — on
 * anything it cannot prove. Anyone wanting a durable rollback copies the
 * `.bak` aside before the sweep reclaims it; the CHANGELOG says so.
 *
 * THE ORDER OF THE PASS IS LOAD-BEARING (§11b, review finding 4). Per-row
 * reclassification against a live holder is order-dependent — it would
 * hand the curated slot to whichever twin the rewrite reached first and
 * can violate the unique index mid-flight — so classification happens
 * once, over the FINAL keys, as a set operation.
 *
 * Two other things called "fingerprint" are NOT content fingerprints and
 * are not touched: `bindings.ts`'s project-identity fingerprint and
 * `event-processing.ts`'s pending-key `record.fingerprint`.
 */

/** Rows the rewrite could not decode, so the self-check knows which
 *  non-digest keys are legitimate leftovers rather than its own bug. */
const TMP_UNDECODABLE = 'fp024_undecodable'
/** (node_id, dedup_class) as it stood before this pass, for disclosure. */
const TMP_CLASS_SNAPSHOT = 'fp024_class_before'
/** The anchor set, re-keyed, staged out of the PK's way. */
const TMP_ANCHORS = 'fp024_anchors'

/**
 * Test hook: runs after the rewrite + reclassification and BEFORE the
 * self-check, with the batch transaction still open — the one place a
 * test can stage the state a buggy rewrite would leave and prove the
 * self-check both catches it and rolls the ladder back. Precedent:
 * content-codec's `__setZstdCapabilityForTests`. Never set in
 * production; the module default is null.
 */
let poisonHookForTests: ((db: Database) => void) | null = null
export function __setDigestPoisonHookForTests(fn: ((db: Database) => void) | null): void {
  // The most privileged seam in the codebase — arbitrary SQL inside an
  // open destructive transaction — so the setter itself refuses outside
  // a test runner (Phase-3 review, low-severity hardening).
  if (!process.env['VITEST'] && process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setDigestPoisonHookForTests is a test-only seam')
  }
  poisonHookForTests = fn
}

export function runFingerprintDigest(db: Database): void {
  for (const t of [TMP_UNDECODABLE, TMP_CLASS_SNAPSHOT, TMP_ANCHORS]) {
    db.exec(`DROP TABLE IF EXISTS temp.${t};`)
  }

  // ── 1. Snapshot the classes, then drop the index ────────────────────
  // The snapshot is what makes the reclassified count a MEASUREMENT
  // rather than an estimate — and it needs only the 'curated_dup' rows
  // (Phase-3 review, M5: the whole-store copy sat in temp_store=MEMORY
  // for a number nobody read). Exact, not sampled: refinement forbids a
  // previously-'curated' row from ever gaining a twin under the new key
  // (equal digests imply equal old keys), and 'auto' never reclassifies,
  // so every class transition starts from 'curated_dup'. The index goes
  // away for the same reason 023 drops it: mid-pass a twin group is
  // briefly all-'curated'.
  db.exec(`CREATE TEMP TABLE ${TMP_CLASS_SNAPSHOT} AS
             SELECT node_id, dedup_class FROM nodes WHERE dedup_class = 'curated_dup';
           DROP INDEX IF EXISTS idx_nodes_curated_fp;`)

  // ── 2. Rewrite every decodable row's key ────────────────────────────
  // Keyset-chunked (023's idiom): the working set is one batch of
  // content blobs, never the whole store, and the cursor rather than
  // .iterate() because the loop UPDATEs the table it scans.
  //
  // An undecodable row KEEPS WHAT IT HAS — NULL on a store that entered
  // below v23 (023 leaves undecodables NULL), a stale V1 key on a v23
  // store. Rewriting it would mean inventing content; refusing the
  // ladder over it would mean one torn blob making a store unopenable.
  // The ⟺ invariant is therefore scoped to rows carrying a 32-hex key,
  // which is exactly what doctor's "unmigrated key" line counts.
  db.exec(`CREATE TEMP TABLE ${TMP_UNDECODABLE} (node_id TEXT PRIMARY KEY);`)
  const selectBatch = db.prepare(
    'SELECT rowid AS rid, node_id, content FROM nodes WHERE rowid > ? ORDER BY rowid LIMIT 500',
  )
  const update = db.prepare('UPDATE nodes SET fingerprint = ? WHERE node_id = ?')
  const markUndecodable = db.prepare(`INSERT OR IGNORE INTO ${TMP_UNDECODABLE} (node_id) VALUES (?)`)
  let cursor = 0
  let rewritten = 0
  let undecodable = 0
  for (;;) {
    const batch = selectBatch.all(cursor) as Array<{
      rid: number
      node_id: string
      content: string | Buffer
    }>
    if (batch.length === 0) break
    cursor = batch[batch.length - 1]!.rid
    for (const row of batch) {
      let decoded: string
      try {
        decoded = decodeContent(row.content)
      } catch (err) {
        undecodable++
        markUndecodable.run(row.node_id)
        dbg('migration', '024: content undecodable — key left as it stands', {
          nodeId: row.node_id,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      update.run(contentFingerprintV2(decoded), row.node_id)
      rewritten++
    }
  }

  // ── 3. Reclassify against the FINAL keys ────────────────────────────
  // Blanket-promote first: every 'curated_dup' 023 created was a
  // judgement about the OLD key, and the whole point of this migration
  // is that some of those judgements were false collisions. Then re-run
  // 023's own earliest-wins demotion — the SAME code, over the new
  // column values — so the resolution is correct by construction against
  // the final state and earliest-wins is preserved structurally rather
  // than by the order rows happened to be rewritten in.
  db.exec("UPDATE nodes SET dedup_class = 'curated' WHERE dedup_class = 'curated_dup';")
  demoteCuratedTwins(db)
  const reclassified = (db.prepare(
    `SELECT COUNT(*) AS n FROM nodes n JOIN ${TMP_CLASS_SNAPSHOT} s USING (node_id)
      WHERE n.dedup_class IS NOT s.dedup_class`,
  ).get() as { n: number }).n

  // ── 4. dedup_anchors: mandatory, not housekeeping ───────────────────
  // Anchors are pruned on WALL time at 24h, and on a sub-v23 store 023
  // has just seeded one per distinct (tree, session, V1 key). An anchor
  // left on an old key is invisible to `liveAnchor`, so every in-window
  // duplicate re-inserts (§11b, review findings 5/6).
  //
  // DELETE first, rebuild second. The correlated-UPDATE spelling
  // (`SET fingerprint = (SELECT ...)`) writes NULL into a NOT NULL PK
  // column for an orphaned or undecodable-node anchor and aborts the
  // ladder — the 023-era failure, reproduced. Orphans cannot exist while
  // the FK holds, but a migration that assumes its own invariants is how
  // that failure happened the first time.
  // A minimal legacy fixture may lack the table entirely (guards.ts
  // contract; Phase-3 review low finding) — no anchors, nothing owed.
  const hasAnchors = hasTable(db, 'dedup_anchors')
  const anchorsBefore = hasAnchors
    ? (db.prepare('SELECT COUNT(*) AS n FROM dedup_anchors').get() as { n: number }).n
    : 0
  const dropped = hasAnchors
    ? db.prepare(
      `DELETE FROM dedup_anchors WHERE NOT EXISTS (
         SELECT 1 FROM nodes n WHERE n.node_id = dedup_anchors.node_id AND n.fingerprint IS NOT NULL)`,
    ).run().changes
    : 0
  // The rebuild goes through a temp table because the new key lands in
  // the PRIMARY KEY: an in-place UPDATE would have to pass through
  // transient states where two rows share (tree, session, key).
  // Convergence — two surviving anchors collapsing into one — is
  // impossible by the refinement property (equal new keys ⟹ equal old
  // keys ⟹ one anchor), and the self-check below treats it as a defect
  // rather than absorbing it silently. last_seen (capture time, the
  // sliding window) and updated_at (wall time, what the hygiene sweep
  // prunes on) are carried across untouched.
  let collapsed = 0
  if (hasAnchors) {
    db.exec(`CREATE TEMP TABLE ${TMP_ANCHORS} AS
      SELECT a.tree_id AS tree_id, a.session_key AS session_key, n.fingerprint AS fingerprint,
             a.node_id AS node_id, a.last_seen AS last_seen, a.updated_at AS updated_at
        FROM dedup_anchors a JOIN nodes n ON n.node_id = a.node_id;`)
    db.exec(`DELETE FROM dedup_anchors;
      INSERT INTO dedup_anchors (tree_id, session_key, fingerprint, node_id, last_seen, updated_at)
      SELECT tree_id, session_key, fingerprint, node_id, last_seen, updated_at FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY tree_id, session_key, fingerprint
                                     ORDER BY last_seen DESC, rowid DESC) AS rn
          FROM ${TMP_ANCHORS})
       WHERE rn = 1;`)
    // Convergence — two surviving anchors collapsing onto one key — is
    // impossible through today's write paths, but a hand-edited or
    // anomalous CACHE row must not brick the ladder permanently
    // (Phase-3 review, M4: asserting exact preservation turned an
    // unrepairable anchor anomaly into a store stuck at v23 forever).
    // The rn=1 guard has already REPAIRED it — a collapsed anchor was
    // unreachable by liveAnchor under its stale key, so nothing real is
    // lost — and the count is disclosed rather than thrown on.
    const inserted = (db.prepare('SELECT COUNT(*) AS n FROM dedup_anchors').get() as { n: number }).n
    collapsed = anchorsBefore - dropped - inserted
    if (collapsed > 0) {
      warn(`[migration 024] ${collapsed} anomalous dedup anchor(s) repaired: `
        + 'stale duplicate cache rows collapsed onto their node\'s key (unreachable before, disclosed now)')
    }
  }

  // ── 5. The index, then the self-check ───────────────────────────────
  // The CREATE is itself half of the check: a violation here means the
  // refinement property failed, and it throws before anything commits.
  db.exec(
    CURATED_INDEX_DDL,
  )
  if (poisonHookForTests) poisonHookForTests(db)
  selfCheck(db, hasAnchors)

  // User-visible, not only dbg (Phase-3 review, M5): this is the one
  // record that thousands of irreplaceable values were rewritten, and a
  // TREECONTEXT_DEBUG-only line is not a record. A run that touched
  // nothing (a fresh store climbing the ladder) has nothing to record:
  // it is a diagnostic, and a serving server's stderr stays quiet (D258).
  const summary = `[migration 024] fingerprint digest: ${rewritten} rewritten, `
    + `${undecodable} undecodable kept as-is, ${reclassified} false duplicate(s) restored to `
    + `curated, ${dropped} unanchorable anchor(s) dropped`
  if (rewritten + undecodable + reclassified + dropped > 0) warn(summary)
  else dbg('migration', summary)
  dbg('migration', '024 fingerprint digest complete', {
    rewritten, undecodable, reclassified, anchorsBefore, anchorsDropped: dropped, anchorsCollapsed: collapsed,
  })
  for (const t of [TMP_UNDECODABLE, TMP_CLASS_SNAPSHOT, TMP_ANCHORS]) {
    db.exec(`DROP TABLE IF EXISTS temp.${t};`)
  }
}

/**
 * What the verdict cannot see. Runs inside the batch transaction, so a
 * throw here rolls the whole ladder back and leaves a v23 store that
 * still opens on the previous binary.
 */
function selfCheck(db: Database, hasAnchors: boolean): void {
  // NOT EXISTS, never NOT IN: one NULL node_id in the temp table makes
  // a NOT IN evaluate to NULL for EVERY row and the whole check read
  // zero on a store full of defects (Phase-3 review, M1 — the anchors
  // DELETE above uses the immune idiom for the same reason).
  const bad = (db.prepare(
    `SELECT COUNT(*) AS n FROM nodes
      WHERE fingerprint IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${TMP_UNDECODABLE} u WHERE u.node_id = nodes.node_id)
        AND (length(CAST(fingerprint AS BLOB)) != 32 OR fingerprint GLOB '*[^0-9a-f]*')`,
  ).get() as { n: number }).n
  if (bad > 0) {
    throw new Error(
      `Migration 024 self-check failed: ${bad} decodable row(s) do not carry a 32-hex digest ` +
        'fingerprint after the rewrite. The store is unchanged — the batch rolled back.',
    )
  }

  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_curated_fp'",
  ).get()
  if (idx === undefined) {
    throw new Error(
      'Migration 024 self-check failed: the curated unique index was not recreated. ' +
        'The store is unchanged — the batch rolled back.',
    )
  }

  if (hasAnchors) {
    // The INVARIANT the anchor rewrite exists to restore, asserted
    // directly (M4). The old arithmetic — `after === anchorsBefore -
    // dropped - collapsed` — reduced to `after === inserted`, a tautology:
    // nothing between the INSERT and this line touches dedup_anchors, so
    // the check could never fire in production. What actually matters is
    // that every surviving anchor sits on its NODE'S CURRENT key and no
    // anchor outlives its node — an anchor left on a stale key is
    // invisible to liveAnchor, the very failure §11b's rewrite repairs.
    // NOT EXISTS, never NOT IN (the NULL-immunity M1 fixed elsewhere): a
    // node with a NULL fingerprint, or a vanished node, fails the match
    // and is counted as the defect it is.
    const stale = (db.prepare(
      `SELECT COUNT(*) AS n FROM dedup_anchors a
        WHERE NOT EXISTS (
          SELECT 1 FROM nodes n
           WHERE n.node_id = a.node_id AND n.fingerprint = a.fingerprint)`,
    ).get() as { n: number }).n
    if (stale > 0) {
      throw new Error(
        `Migration 024 self-check failed: ${stale} dedup anchor(s) carry a key their node does not, ` +
          'or point at a node that is gone, after the rewrite — an anchor on a stale key is invisible ' +
          'to liveAnchor and every in-window duplicate would re-insert. The store is unchanged — the ' +
          'batch rolled back.',
      )
    }
  }

  // Value check, not just shape (Phase-3 review, M2): a rewrite that
  // hashed the WRONG text still emits 32 hex chars, commits under a
  // COUNT(*)-blind verdict, and is undetectable forever after — doctor's
  // collision query only matches the old structural form. A bounded
  // random sample re-derived from content catches any SYSTEMATIC rewrite
  // bug with probability 1 (~10ms on a 10k-row store).
  const sample = db.prepare(
    `SELECT node_id, fingerprint, content FROM nodes
      WHERE fingerprint IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${TMP_UNDECODABLE} u WHERE u.node_id = nodes.node_id)
      ORDER BY random() LIMIT 200`,
  ).all() as Array<{ node_id: string; fingerprint: string; content: string | Buffer }>
  for (const row of sample) {
    let decoded: string
    try {
      decoded = decodeContent(row.content)
    } catch {
      // Decodability changed mid-transaction: impossible through this
      // pass, so treat it as the defect it would be.
      throw new Error(
        `Migration 024 self-check failed: node ${row.node_id} decoded during the rewrite but not ` +
          'during verification. The store is unchanged — the batch rolled back.',
      )
    }
    const expected = contentFingerprintV2(decoded)
    if (row.fingerprint !== expected) {
      throw new Error(
        `Migration 024 self-check failed: node ${row.node_id} carries ${row.fingerprint} but its ` +
          `content re-derives to ${expected} — the rewrite hashed the wrong value. ` +
          'The store is unchanged — the batch rolled back.',
      )
    }
  }
}

const migration: Migration = {
  version: 24,
  kind: 'destructive',
  description:
    'The fingerprint becomes a digest: rehash every decodable row, re-resolve curated twins over the new keys, re-key the dedup anchors',
  up(db) {
    if (!hasTable(db, 'nodes')) return
    runFingerprintDigest(db)
  },
}

export default migration
