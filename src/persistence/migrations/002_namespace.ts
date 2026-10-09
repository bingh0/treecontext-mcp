import type { Migration } from '../migrations.js'

/**
 * Adds a `namespace` column to `trees` so one SQLite store can host
 * multiple isolated trees for multi-agent workflows.
 *
 * v1's trees table declared `ensemble_index INTEGER NOT NULL UNIQUE`.
 * That UNIQUE-backed auto-index (`sqlite_autoindex_trees_1`) cannot be
 * dropped directly — SQLite rejects DROP INDEX on constraint-backed
 * indexes. So we do the 12-step ALTER recipe: rebuild the table with
 * the new shape.
 *
 * Because `nodes.tree_id` has a FK to `trees(tree_id)`, we must disable
 * `foreign_keys` for the rebuild. `defer_foreign_keys` defers *checks*
 * but the ON DELETE CASCADE *action* would still fire when the old
 * trees table is dropped. `manualTransaction: true` lets us flip
 * `PRAGMA foreign_keys` outside any enclosing transaction.
 */
const migration: Migration = {
  version: 2,
  kind: 'destructive',
  description: 'Add namespace column to trees (default project)',
  manualTransaction: true,
  up(db) {
    // Caller (runner) has already set PRAGMA foreign_keys = OFF.
    db.exec('BEGIN IMMEDIATE TRANSACTION')
    try {
      db.exec(`
        CREATE TABLE trees_new (
          tree_id            INTEGER PRIMARY KEY,
          namespace          TEXT    NOT NULL DEFAULT 'project',
          ensemble_index     INTEGER NOT NULL,
          created_at         INTEGER NOT NULL,
          import_labels_json TEXT,
          UNIQUE(namespace, ensemble_index)
        );
        INSERT INTO trees_new (tree_id, namespace, ensemble_index, created_at, import_labels_json)
          SELECT tree_id, 'project', ensemble_index, created_at, import_labels_json FROM trees;
        DROP TABLE trees;
        ALTER TABLE trees_new RENAME TO trees;
        CREATE INDEX IF NOT EXISTS idx_trees_namespace ON trees(namespace);
      `)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  },
}

export default migration
