import type { Migration } from '../migrations.js'

// Capture attribution (tests/server/design/multi-user.md, C1): a staged
// event carries the namespace of the session that produced it, so the
// drain can attribute each row to its own journal instead of whatever
// namespace the drain owner happened to be launched with (audit D3).
//
// NULL means *unresolved at capture* — a hook that could not learn its
// session's namespace (no annotation, dead server, pre-020 producer)
// stamps nothing, and the drain routes NULL into its own SERVING
// namespace: exactly where every capture drained before attribution
// existed, and visible in the journal the user's server actually
// queries (program-C review, finding 4 — an unserved literal-'project'
// tree would swallow them silently). Keeping NULL distinct from an
// explicit stamp preserves the row's own record of whether attribution
// happened.
//
// Plain ALTER TABLE ADD COLUMN: no rewrite, no backfill; old rows get
// NULL. Hooks built against this schema fall back to the pre-020 column
// list when the column is absent (JF-8); hooks never run migrations.
const migration: Migration = {
  version: 20,
  kind: 'additive',
  description: 'Add staging.namespace (capture attribution: hooks stamp it, the drain attributes)',
  up(db) {
    // Guarded like 016/018: additive migrations must tolerate
    // marker-rollback re-application and minimal legacy fixtures without
    // a staging table.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    if (!table) return
    const cols = db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'namespace')) {
      db.exec('ALTER TABLE staging ADD COLUMN namespace TEXT;')
    }
  },
}

export default migration
