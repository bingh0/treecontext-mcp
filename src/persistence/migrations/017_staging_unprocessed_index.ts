import type { Migration } from '../migrations.js'

// Review-#1 fix (journal-fidelity repair): the ingestion tick runs a
// COUNT(*) gate — and, when the byte valve arms, SUM/GROUP BY — over
// unprocessed staging rows every few seconds. Without an index those are
// full-table scans over up to 24h of retained processed rows (post-C4,
// potentially 256KB each). Partial index keeps the drain's hot queries on
// exactly the rows they touch. Additive: CREATE INDEX IF NOT EXISTS,
// idempotent under marker-rollback re-application; guarded for minimal
// legacy fixtures without a staging table (real stores >= v5 have one).
const migration: Migration = {
  version: 17,
  kind: 'additive',
  description: 'Partial index on unprocessed staging rows for the ingestion drain hot path',
  up(db) {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    if (!table) return
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_staging_unprocessed
        ON staging(session_id, timestamp) WHERE processed = 0;
    `)
  },
}

export default migration
