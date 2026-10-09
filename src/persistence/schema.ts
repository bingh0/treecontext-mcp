/**
 * Schema v1 for treecontext SQLite stores.
 *
 * Shipped as a TypeScript string so bundlers pick it up without any
 * special SQL-loading plumbing. Applied on new stores; subsequent
 * upgrades go through the migration runner.
 *
 * See planning/04-persistence-and-schemas.md for full design notes.
 *
 * There is deliberately no SCHEMA_VERSION constant here: the current
 * schema version is the migration ladder's maxSupportedVersion
 * (migrations/index.ts) — a hand-bumped copy went stale once (19 vs 20)
 * and was retired by program G.
 */

/** The default namespace used when none is specified. The project-wide
 *  canonical tree lives here. Sub-agents pick their own namespace to
 *  isolate scratch work from the shared project view. */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- schema_meta: non-versioned store metadata
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- store_config: snapshot of TreeConfig at creation time (JSON-encoded values)
CREATE TABLE IF NOT EXISTS store_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- embedding_model: identifies which model wrote this store
CREATE TABLE IF NOT EXISTS embedding_model (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  model_name     TEXT NOT NULL,
  dim            INTEGER NOT NULL,
  pooling        TEXT NOT NULL,
  normalize      INTEGER NOT NULL,
  query_prefix   TEXT,
  passage_prefix TEXT,
  model_checksum TEXT
);

-- trees: one row per tree in the ensemble, per namespace
CREATE TABLE IF NOT EXISTS trees (
  tree_id           INTEGER PRIMARY KEY,
  namespace         TEXT    NOT NULL DEFAULT 'project',
  ensemble_index    INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  import_labels_json TEXT,
  UNIQUE(namespace, ensemble_index)
);
CREATE INDEX IF NOT EXISTS idx_trees_namespace ON trees(namespace);

-- nodes: the main table
CREATE TABLE IF NOT EXISTS nodes (
  node_id              TEXT    PRIMARY KEY,
  tree_id              INTEGER NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  parent_id            TEXT             REFERENCES nodes(node_id)  ON DELETE CASCADE,

  depth                INTEGER NOT NULL DEFAULT 0,
  is_leaf              INTEGER NOT NULL DEFAULT 1,

  content              TEXT    NOT NULL DEFAULT '',
  summary              TEXT    NOT NULL DEFAULT '',

  embedding_raw        BLOB,
  embedding_compressed BLOB,
  embedding_modal_raw        BLOB,
  embedding_modal_compressed BLOB,

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  summary_stale        INTEGER NOT NULL DEFAULT 0,

  read_only            INTEGER NOT NULL DEFAULT 0,
  decay_exempt         INTEGER NOT NULL DEFAULT 0,
  decay_rate           REAL,

  utility_score        REAL    NOT NULL DEFAULT 0.5,
  insert_generation    INTEGER,

  source_label         TEXT,
  metadata_json        TEXT,

  -- index_col: which nodes_fts role column (0=user_text, 1=assistant_text,
  -- 2=tool_text, 3=note_text) this node's index text was written into.
  -- Chosen once at insert (see persistence/fts-columns.ts attributeColumn)
  -- and immutable thereafter — delete/update read it back, never recompute
  -- it from (mutable) metadata.
  index_col            INTEGER,

  CHECK ((embedding_raw IS NULL) OR (embedding_compressed IS NULL)),
  CHECK ((embedding_modal_raw IS NULL) OR (embedding_modal_compressed IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_nodes_tree_leaf ON nodes(tree_id, is_leaf);
CREATE INDEX IF NOT EXISTS idx_nodes_updated   ON nodes(updated_at);

-- Resume-pointer scan (status() orientation panel): partial expression
-- index whose predicate matches the status query verbatim, so the first
-- call of every session is a point lookup instead of a full-tree scan.
CREATE INDEX IF NOT EXISTS idx_nodes_resume_pointers
  ON nodes(tree_id, created_at DESC)
  WHERE json_extract(metadata_json, '$.next_session') = 1
     OR json_extract(metadata_json, '$.status') = 'active';

-- nodes_fts: FTS5 contentless virtual table for role-weighted BM25 search.
-- Four role columns rather than one shared "content" column, so a node's
-- text is queryable at a per-role weight via bm25(nodes_fts, wUser,
-- wAssistant, wTool, wNote). Each node's text lands in exactly one column
-- (nodes.index_col records which).
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  user_text, assistant_text, tool_text, note_text,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS staging (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','tool_result','snapshot')),
  content    TEXT NOT NULL,
  tool_name  TEXT,
  timestamp  REAL NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 3,
  processed  INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  queries     TEXT NOT NULL,
  claimed_by  TEXT,
  claimed_at  REAL,
  created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_unclaimed ON snapshots(claimed_by) WHERE claimed_by IS NULL;


-- user_version is intentionally set to 5 (the version this base schema
-- represents). Migrations 6..N apply incrementally on top of this baseline
-- and bump user_version up to the ladder's maxSupportedVersion.
PRAGMA user_version = 5;
`
