import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { runMigrations, currentSchemaVersion } from '../../src/persistence/migrations.js'

function seedV3(db: ReturnType<typeof wrapBetterSqlite>): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE embedding_model (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      pooling TEXT NOT NULL,
      normalize INTEGER NOT NULL,
      query_prefix TEXT,
      passage_prefix TEXT,
      model_checksum TEXT
    );
    CREATE TABLE modal_embedding_model (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      modalities TEXT NOT NULL
    );
    CREATE TABLE quantizer (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bits INTEGER NOT NULL CHECK (bits IN (3, 4)),
      seed INTEGER NOT NULL,
      dim INTEGER NOT NULL,
      rotation BLOB NOT NULL,
      centroids BLOB NOT NULL,
      boundaries BLOB NOT NULL
    );
    CREATE TABLE trees (
      tree_id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'project',
      ensemble_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      import_labels_json TEXT,
      UNIQUE(namespace, ensemble_index)
    );
    CREATE INDEX idx_trees_namespace ON trees(namespace);
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      tree_id INTEGER NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(node_id) ON DELETE CASCADE,
      depth INTEGER NOT NULL DEFAULT 0,
      is_leaf INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      embedding_raw BLOB,
      embedding_compressed BLOB,
      embedding_modal_raw BLOB,
      embedding_modal_compressed BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_stale INTEGER NOT NULL DEFAULT 0,
      read_only INTEGER NOT NULL DEFAULT 0,
      decay_exempt INTEGER NOT NULL DEFAULT 0,
      utility_score REAL NOT NULL DEFAULT 0.5,
      source_label TEXT,
      metadata_json TEXT,
      CHECK ((embedding_raw IS NULL) OR (embedding_compressed IS NULL)),
      CHECK ((embedding_modal_raw IS NULL) OR (embedding_modal_compressed IS NULL))
    );
    CREATE INDEX idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX idx_nodes_tree_leaf ON nodes(tree_id, is_leaf);
    CREATE INDEX idx_nodes_updated ON nodes(updated_at);
    CREATE INDEX idx_nodes_stale ON nodes(summary_stale) WHERE summary_stale = 1;
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      content,
      content='',
      tokenize='unicode61 remove_diacritics 2'
    );

    INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 100);
    INSERT INTO nodes (
      node_id, tree_id, parent_id, depth, is_leaf, content, summary,
      embedding_raw, embedding_compressed, embedding_modal_raw, embedding_modal_compressed,
      created_at, updated_at, summary_stale, read_only, decay_exempt, utility_score,
      source_label, metadata_json
    ) VALUES (
      'n1', 1, NULL, 0, 1, 'legacy node', '',
      NULL, NULL, NULL, NULL,
      100, 100, 0, 0, 0, 0.5,
      NULL, NULL
    );

    PRAGMA user_version = 3;
  `)
}

import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'

describe('migration 004_decay_rate_and_staging', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-mig4-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies on a fresh database', () => {
    const raw = new BetterSqlite3(join(dir, 'fresh.db'))
    const db = wrapBetterSqlite(raw)

    const report = runMigrations(db, { migrate: true })
    expect(report.to).toBe(maxSupportedVersion)
    expect(report.applied.map((entry) => entry.version)).toContain(4)

    const nodeColumns = db
      .prepare("SELECT name FROM pragma_table_info('nodes') WHERE name = 'decay_rate'")
      .all()
    expect(nodeColumns).toHaveLength(1)

    const staging = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    expect(staging).toBeDefined()

    db.close()
  })

  it('adds decay_rate and staging without disturbing existing nodes', () => {
    const raw = new BetterSqlite3(join(dir, 'existing.db'))
    const db = wrapBetterSqlite(raw)
    seedV3(db)

    const report = runMigrations(db, { migrate: true })
    expect(report.from).toBe(3)
    expect(report.to).toBe(maxSupportedVersion)
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)

    const node = db
      .prepare("SELECT node_id, content, decay_rate FROM nodes WHERE node_id = 'n1'")
      .get() as { node_id: string; content: string; decay_rate: number | null }
    expect(node.node_id).toBe('n1')
    expect(node.content).toBe('legacy node')
    expect(node.decay_rate).toBeNull()

    const staging = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    expect(staging).toBeDefined()

    db.close()
  })
})