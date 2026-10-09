/**
 * The self-audit queries — make silence loud (§11a, pre-registered
 * 2026-08-20).
 *
 * Phase 1b's split detector answers one question about the bindings map.
 * These answer the rest of the class the program is named for: work
 * attributed to, or merged into, the wrong place, SILENTLY. A colliding
 * dedup key drops a row and leaves nothing behind; a store bound long ago
 * and still empty reads as "I never wrote that down"; a drain that has
 * stopped draining is indistinguishable from an idle session. None of
 * them raises an error, so none of them will ever be reported by a beta
 * tester — only by a surface that goes looking.
 *
 * The SQL lives here, as named constants, for two reasons. The queries
 * carry a measurement gotcha that a doctor-shaped inline string would
 * lose on the first edit (see OLD_FORM_FINGERPRINT_SQL), and a pinnable
 * constant is what lets the unit corpus run the REAL query against a
 * seeded store rather than a paraphrase of it.
 *
 * Everything here reads. Nothing here migrates, writes, or repairs.
 */
import type { BoundProjects } from './split-candidates.js'

/**
 * The narrow slice of a better-sqlite3 handle these helpers use. Narrow
 * on purpose: a module that cannot see `exec` or `run` cannot be talked
 * into writing to a store doctor opened read-only.
 */
export interface ReadonlyStoreDb {
  prepare(sql: string): { get(...params: unknown[]): unknown }
  pragma(source: string, options: { simple: true }): unknown
}

// ── Fingerprint collisions (§9.2, §11a check 2) ────────────────────────

/**
 * The old-form (head/tail/length) fingerprint, expressed in SQL.
 *
 * `contentFingerprintV1` returned the normalized content ITSELF when it is
 * short enough, and a structural key otherwise:
 * `head(64) + "\x00" + tail(64) + ":" + normalizedLength`. Only the
 * structural form can file two genuinely different texts under one key.
 * Rows sharing a short-form key share their content up to whitespace,
 * which is the normalization working exactly as designed and must not be
 * counted as a collision.
 *
 * THE CAST IS LOAD-BEARING. `length()` on TEXT stops at the embedded
 * NUL, so every structural key measures 64 characters and the plain
 * `length(fingerprint) >= 131` form matches NOTHING. Measured against
 * this project's own store (10,568 structural keys): the byte form finds
 * all of them, the character form finds zero. That is §9.2's measurement
 * gotcha, and it is a silent zero — the worst possible failure for a
 * check whose whole job is to stop reading zero as health.
 *
 * 131 is the shortest the structural form can be: 64 + NUL + 64 + ':' +
 * one length digit. The instr() clause is the NUL itself, settling the
 * two cases the byte length cannot — short content that is multi-byte,
 * and short content carrying a NUL of its own.
 */
export const OLD_FORM_FINGERPRINT_SQL =
  "fingerprint IS NOT NULL\n"
  + "     AND length(CAST(fingerprint AS BLOB)) >= 131\n"
  + "     AND instr(CAST(fingerprint AS BLOB), x'00') > 0"

/**
 * Groups sharing a fingerprint with MORE THAN ONE distinct content, and
 * the rows sitting in them.
 *
 * Two stages, and both are the point. Stage one finds keys held by more
 * than one row — that alone is the DESIGNED dedup shape, and reporting it
 * would call every deduplicated pair a defect. Stage two is the finding:
 * within those keys, more than one distinct content, which is a key that
 * cannot tell two texts apart.
 *
 * Scoped `(tree_id, fingerprint)` because that is the scope of the
 * predicates at risk — `curatedHolder` is `WHERE tree_id = ? AND
 * fingerprint = ?` with no window at all, and the auto anchor is narrower
 * still. Two namespaces in one store cannot dedup against each other, so
 * grouping them together would report a hazard that does not exist.
 *
 * Stage one reads only the fingerprint column; stage two reads content
 * for the duplicate keys alone. On the 10k-node store that is the
 * difference between decoding every row and decoding 231 of them.
 *
 * Content is compared AS STORED: a demoted stump compares as its stripped
 * text, and a row stored raw beside a compressed twin compares unequal.
 * Both push the count up rather than down, which is the direction a
 * detector should err in.
 */
export const FINGERPRINT_COLLISION_SQL = `
WITH shared AS (
  SELECT tree_id, fingerprint FROM nodes
   WHERE ${OLD_FORM_FINGERPRINT_SQL}
   GROUP BY tree_id, fingerprint
  HAVING COUNT(*) > 1
)
SELECT COUNT(*) AS groups_, COALESCE(SUM(n), 0) AS rows_ FROM (
  SELECT COUNT(*) AS n FROM nodes JOIN shared USING (tree_id, fingerprint)
   WHERE ${OLD_FORM_FINGERPRINT_SQL}
   GROUP BY tree_id, fingerprint
  HAVING COUNT(DISTINCT content) > 1
)`

/**
 * Rows whose key is not the Phase 3 digest: NULL, or not 32 lowercase
 * hex. Undecodable content keeps its pre-024 value by design, so these
 * exist forever after the migration and must be counted SEPARATELY —
 * folding them into the collision count is what would stop "reads zero
 * after migration" from being true (§11b review, finding 10).
 *
 * The byte length again: a surviving structural key measures 32 in
 * characters exactly often enough to matter, and always more than 32 in
 * bytes.
 */
export const UNMIGRATED_FINGERPRINT_SQL = `
SELECT COUNT(*) AS n FROM nodes
 WHERE fingerprint IS NULL
    OR length(CAST(fingerprint AS BLOB)) != 32
    OR fingerprint GLOB '*[^0-9a-f]*'`

/**
 * The schema version at which `contentFingerprint` becomes a digest
 * (§11b). BELOW it, every key is old-form and the collision count is the
 * whole story — an "unmigrated key" line against a v23 store would be
 * reporting the norm as a defect. The guard ships now so the check is
 * already right on the day 024 lands, rather than needing an edit nobody
 * remembers to make.
 */
export const FINGERPRINT_DIGEST_VERSION = 24

export interface CollisionCounts {
  /** Keys covering more than one content. */
  groups: number
  /** Rows sitting in one of those groups. */
  rows: number
  /**
   * Rows still carrying a pre-digest key, or null on a store below
   * FINGERPRINT_DIGEST_VERSION — where the question is not yet askable.
   */
  unmigrated: number | null
}

/**
 * Run both fingerprint questions against one open store. Read-only: two
 * SELECTs and a pragma read.
 */
export function fingerprintCollisions(db: ReadonlyStoreDb): CollisionCounts {
  const row = db.prepare(FINGERPRINT_COLLISION_SQL).get() as
    { groups_: number; rows_: number } | undefined
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0)
  let unmigrated: number | null = null
  if (version >= FINGERPRINT_DIGEST_VERSION) {
    const u = db.prepare(UNMIGRATED_FINGERPRINT_SQL).get() as { n: number } | undefined
    unmigrated = Number(u?.n ?? 0)
  }
  return { groups: Number(row?.groups_ ?? 0), rows: Number(row?.rows_ ?? 0), unmigrated }
}

// ── Capture debt (§11a check 4) ────────────────────────────────────────

/**
 * Capture gaps: the holes the journal admitted in itself. Found by the
 * metadata marker, never by matching the text — a tombstone carries 500
 * chars of error plus 500 of payload prefix and is reliably over the
 * compression threshold, so a `content LIKE` scan returns zero on
 * exactly the holes worth finding.
 *
 * ALL of `$.source = 'capture-gap'`, no `$.event` filter — the pane's
 * own predicate (flat-store.ts), and the drain writes THREE kinds:
 * `ingest_failure` (poison-row dead letter), `malformed_snapshot`
 * (retired "EXACTLY like the dead-letter path", the drain's own words),
 * and `capture_gap` (byte-valve drop). Filtering to one kind reported
 * a store that dropped whole sessions as "no dead letters" — the
 * literal silence §11a exists to break (Phase-2 review, S2).
 *
 * Store-wide rather than tree-scoped: doctor describes a STORE, and a
 * hole in one namespace is still that store failing to drain.
 *
 * Only MERGE-copies are excluded (via `_merge_label`): a merged copy of
 * another store's gap is genuinely not this drain's hole, and the merge
 * path is the common orchestration case that would otherwise double-count.
 * IMPORT is NOT excluded (M6): the documented restore path is
 * export → clear → import, and a row that returns through it IS this
 * store's own dead letter — hiding it behind an `_imported_from` stamp
 * blinded doctor to a store's real holes forever after a restore.
 */
export const DEAD_LETTER_SQL = `
SELECT COUNT(*) AS n FROM nodes
 WHERE json_extract(metadata_json, '$.source') = 'capture-gap'
   AND json_extract(metadata_json, '$._merge_label') IS NULL`

/**
 * What is still owed: unprocessed staging rows and the oldest one's
 * capture time. The pane's shape (`drain` row, flat-store.ts vitals) —
 * one scalar query, no content read.
 */
export const STAGING_DEBT_SQL = `
SELECT COALESCE(SUM(processed = 0), 0) AS unprocessed,
       MIN(CASE WHEN processed = 0 THEN created_at END) AS oldest
  FROM staging`

export interface CaptureDebt {
  /** Events retired into a capture-gap tombstone after repeated failure. */
  deadLetters: number
  /** Staged events not yet drained. */
  unprocessed: number
  /** Capture time of the oldest undrained event, unix seconds, or null. */
  oldestPendingAt: number | null
}

/** Both capture-debt scalars for one open store. Read-only. */
export function captureDebt(db: ReadonlyStoreDb): CaptureDebt {
  const dead = db.prepare(DEAD_LETTER_SQL).get() as { n: number } | undefined
  const staging = db.prepare(STAGING_DEBT_SQL).get() as
    { unprocessed: number; oldest: number | null } | undefined
  return {
    deadLetters: Number(dead?.n ?? 0),
    unprocessed: Number(staging?.unprocessed ?? 0),
    oldestPendingAt: staging?.oldest == null ? null : Number(staging.oldest),
  }
}

// ── Bound stores (§11a check 3) ────────────────────────────────────────

export interface BoundStore {
  store: string
  /** Newest binding naming this store, ms since epoch; 0 if unrecorded. */
  updatedAt: number
  /** How many recorded identities name it. */
  bindings: number
}

/**
 * Every store the bindings file names, once each, newest binding first
 * for tie-breaking and then by name so the report is stable across runs.
 *
 * NEWEST, not oldest: the age this feeds is the argument that a store
 * bound long ago and still empty is an orphaned successor. An identity
 * that re-bound the store yesterday makes it a young binding whatever its
 * siblings say, and the conservative reading is the one that does not
 * accuse.
 */
export function boundStores(projects: BoundProjects): BoundStore[] {
  const byStore = new Map<string, BoundStore>()
  for (const entry of Object.values(projects)) {
    const at = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
    const prev = byStore.get(entry.store)
    if (prev) {
      prev.bindings++
      if (at > prev.updatedAt) prev.updatedAt = at
    } else {
      byStore.set(entry.store, { store: entry.store, updatedAt: at, bindings: 1 })
    }
  }
  return [...byStore.values()].sort((a, b) => a.store.localeCompare(b.store))
}

// ── Saying it out loud ─────────────────────────────────────────────────

/**
 * A duration in milliseconds, in doctor's voice rather than a pane's.
 * "42 days" belongs in a sentence; "42d" belongs in a fixed-width cell,
 * and doctor has no cells.
 *
 * Clamped at zero: a binding stamped in the future is a clock story, not
 * a negative age.
 */
export function humanAge(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 3600) return 'under an hour'
  if (secs < 86400) {
    const h = Math.floor(secs / 3600)
    return `${h} hour${h !== 1 ? 's' : ''}`
  }
  const d = Math.floor(secs / 86400)
  return `${d} day${d !== 1 ? 's' : ''}`
}

/**
 * The day a binding was written, or an honest admission. Bindings written
 * before `updatedAt` existed carry no stamp, and inventing today's date
 * for them would make the oldest bindings on a machine look like the
 * newest — precisely backwards for a check about age.
 */
export function bindingStamp(updatedAt: number, now: number): string {
  if (!(updatedAt > 0)) return 'bound at an unrecorded date'
  return `bound ${new Date(updatedAt).toISOString().slice(0, 10)}, ${humanAge(now - updatedAt)} ago`
}
