import type { Migration } from '../migrations.js'

// Journal-fidelity repair: two additive staging columns.
//
// - `index_len`: the C4 producer records where the tool-event preview ends
//   (UTF-16 code units, JF-1) so ingestion can stage preview+full content
//   while the FTS index view stays exactly the preview. NULL (old hooks,
//   non-tool events) means "no boundary — index by role caps as before".
// - `attempts`: ingestion failure counter for the poison-row dead-letter
//   path. Rows that fail insertion `MAX_INGEST_ATTEMPTS` times are marked
//   processed and recorded as a capture-gap node instead of being retried
//   forever (pre-fix, >= batchSize deterministic failures wedged the drain
//   permanently).
//
// Both are plain ALTER TABLE ADD COLUMN: no rewrite, no backfill, old rows
// get NULL / 0 defaults. Hooks built against this schema fall back to the
// legacy column list when the column is absent (JF-8) — hooks never run
// migrations themselves.
const migration: Migration = {
  version: 16,
  kind: 'additive',
  description: 'Add staging.index_len (C4 preview boundary) and staging.attempts (poison-row dead-letter counter)',
  up(db) {
    // Guarded: ALTER TABLE ADD COLUMN is not idempotent, and additive
    // migrations must tolerate marker-rollback re-application (see
    // migration-015.test.ts) plus minimal legacy fixtures without a staging
    // table. Real stores >= v5 always have one (base schema / migration 004).
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    if (!table) return
    const cols = db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('index_len')) {
      db.exec('ALTER TABLE staging ADD COLUMN index_len INTEGER;')
    }
    if (!names.has('attempts')) {
      db.exec('ALTER TABLE staging ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;')
    }
  },
}

export default migration
