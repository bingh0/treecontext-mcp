import type { Migration } from '../migrations.js'

// Pre-beta dead-weight drop (2026-07-29). Every object removed here was
// write-only or entirely unreferenced by the lexical FlatStore:
//
// - `nodes_trigram`: written on every node insert/update/delete, queried by
//   NOTHING since the tree-era hybrid modes left — a full second FTS5 index
//   roughly doubling index bytes and per-insert cost for zero read benefit.
// - `knn_index` (mig 007): HNSW persistence for the deleted dense backend.
//   Zero readers or writers anywhere.
// - `flat_journal` + `journal_trigram` (migs 010-012): the BIRCH-PCA journal
//   backend deleted with the tree era. All accessor methods removed.
// - `session_stats` + `logistic_state` (mig 009): analytics persistence the
//   server never wrote (SessionStats is in-memory by design).
// - `modal_embedding_model` + `quantizer` (mig 003 / base schema): embedder
//   metadata for the deleted dense path.
// - modal-embedding exclusivity triggers (mig 003): fired on every nodes
//   INSERT/UPDATE guarding columns nothing writes.
// - `idx_nodes_parent` / `idx_nodes_stale`: index all-NULL parent_id and
//   always-0 summary_stale — pure write amplification on the flat store.
//
// Deliberately KEPT:
// - `embedding_model` — storeHasEmbeddingModel() reads it for D7 legacy
//   tree-store detection.
// - The NULL embedding_* / embedding_modal_* columns on `nodes` and their
//   CHECK constraints: dropping columns under a CHECK requires a full table
//   rebuild, and `nodes.rowid` keys the contentless `nodes_fts` index — a
//   rebuild that renumbers rowids would silently corrupt search. Not worth
//   the risk for four all-NULL columns.
//
// The base-schema copies of these objects were removed from SCHEMA_SQL and
// the creating migrations' bodies emptied in the same change, so fresh
// stores never create them; this migration cleans up existing stores.
const migration: Migration = {
  version: 19,
  kind: 'destructive',
  description: 'Drop dead tree-era tables (nodes_trigram, knn_index, flat_journal, journal_trigram, session_stats, logistic_state, modal_embedding_model, quantizer) and dead triggers/indexes',
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS nodes_trigram;
      DROP TABLE IF EXISTS knn_index;
      DROP TABLE IF EXISTS journal_trigram;
      DROP TABLE IF EXISTS flat_journal;
      DROP TABLE IF EXISTS session_stats;
      DROP TABLE IF EXISTS logistic_state;
      DROP TABLE IF EXISTS modal_embedding_model;
      DROP TABLE IF EXISTS quantizer;
      DROP TRIGGER IF EXISTS trg_nodes_modal_embedding_exclusive_insert;
      DROP TRIGGER IF EXISTS trg_nodes_modal_embedding_exclusive_update;
      DROP INDEX IF EXISTS idx_nodes_parent;
      DROP INDEX IF EXISTS idx_nodes_stale;

      -- Resume-pointer scan: status() is the first call of every session
      -- and previously evaluated two json_extract()s per row over the
      -- whole tree. This partial expression index turns it into a point
      -- lookup over just the pointer-flagged rows (predicate matches the
      -- status query verbatim).
      CREATE INDEX IF NOT EXISTS idx_nodes_resume_pointers
        ON nodes(tree_id, created_at DESC)
        WHERE json_extract(metadata_json, '$.next_session') = 1
           OR json_extract(metadata_json, '$.status') = 'active';
    `)
  },
}

export default migration
