import type { Migration } from '../migrations.js'

const SCHEMA_SQL_V1 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS quantizer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  bits       INTEGER NOT NULL CHECK (bits IN (3, 4)),
  seed       INTEGER NOT NULL,
  dim        INTEGER NOT NULL,
  rotation   BLOB NOT NULL,
  centroids  BLOB NOT NULL,
  boundaries BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS trees (
  tree_id           INTEGER PRIMARY KEY,
  ensemble_index    INTEGER NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  import_labels_json TEXT
);

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

  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  summary_stale        INTEGER NOT NULL DEFAULT 0,

  read_only            INTEGER NOT NULL DEFAULT 0,
  decay_exempt         INTEGER NOT NULL DEFAULT 0,

  utility_score        REAL    NOT NULL DEFAULT 0.5,

  source_label         TEXT,
  metadata_json        TEXT,

  CHECK ((embedding_raw IS NULL) OR (embedding_compressed IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  content,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

PRAGMA user_version = 1;
`

const migration: Migration = {
  version: 1,
  kind: 'additive',
  description: 'Initial schema: schema_meta, store_config, embedding_model, quantizer, trees, nodes, nodes_fts',
  up(db) {
    db.exec(SCHEMA_SQL_V1)
  },
}

export default migration
