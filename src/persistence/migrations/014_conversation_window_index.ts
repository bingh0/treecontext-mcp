import type { Migration } from '../migrations.js'

// conversation_window: the neighbor and anchor lookups both filter on
// (tree_id, session-key, created_at) — the exact COALESCE expression used
// at query time, so SQLite's expression-index matcher can use this index
// for both the point range scans (before/after) and the role='user' anchor
// scan. Additive: a plain CREATE INDEX, no data rewrite, no destructive
// step.
const migration: Migration = {
  version: 14,
  kind: 'additive',
  description: 'Add session+time expression index for conversation_window neighbor/anchor lookups',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_session_time ON nodes(
        tree_id,
        COALESCE(json_extract(metadata_json,'$.session_id'), json_extract(metadata_json,'$._session_id')),
        created_at
      );
    `)
  },
}

export default migration
