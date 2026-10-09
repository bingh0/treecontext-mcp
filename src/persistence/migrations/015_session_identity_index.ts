import type { Migration } from '../migrations.js'

// Session identity fix (docs/session-identity.md §3):
// getSessionKey/sessionOf (flat-store.ts) stops coalescing the disjoint
// `_session_id` (MCP connection id) into the same namespace as `session_id`
// (the real Claude Code session UUID from hook events) — it now prefers
// `session_id`, then `_cc_session_id` (new-style notes, same namespace as
// hook events), and only falls back to `_session_id` for legacy rows that
// predate this fix. The query-time COALESCE expression changed accordingly
// (2-arg -> 3-arg), so the 014 expression index no longer text-matches it
// and SQLite's query planner can't use it for the new expression. Additive:
// a new CREATE INDEX on the new 3-arg expression, alongside (not replacing)
// the 014 index — no data rewrite, no destructive step, no rows touched.
const migration: Migration = {
  version: 15,
  kind: 'additive',
  description: 'Add session+time expression index matching the 3-arg session-key COALESCE (session_id / _cc_session_id / _session_id)',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_session_time_v2 ON nodes(
        tree_id,
        COALESCE(
          json_extract(metadata_json,'$.session_id'),
          json_extract(metadata_json,'$._cc_session_id'),
          json_extract(metadata_json,'$._session_id')
        ),
        created_at
      );
    `)
  },
}

export default migration
