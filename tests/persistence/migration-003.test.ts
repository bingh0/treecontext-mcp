import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'

function seedV2(db: ReturnType<typeof wrapBetterSqlite>): void {
  db.exec(`
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_stale INTEGER NOT NULL DEFAULT 0,
      read_only INTEGER NOT NULL DEFAULT 0,
      decay_exempt INTEGER NOT NULL DEFAULT 0,
      utility_score REAL NOT NULL DEFAULT 0.5,
      source_label TEXT,
      metadata_json TEXT,
      CHECK ((embedding_raw IS NULL) OR (embedding_compressed IS NULL))
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
    PRAGMA user_version = 2;

    INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 100);
  `)
}

describe('migration 003_modal_embeddings (emptied placeholder)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // 003's body was emptied 2026-07-29 (modal embeddings left with the tree
  // era; migration 019 drops the artifacts from stores that have them). The
  // contract this file now pins: an ancient v2 store still climbs the full
  // ladder, 003 holds its rung as a no-op, and no modal machinery is created
  // along the way.
  it('upgrades a v2 store to the max version without creating modal machinery', () => {
    const raw = new BetterSqlite3(join(dir, 's.db'))
    const db = wrapBetterSqlite(raw)
    seedV2(db)

    const report = runMigrations(db, { migrate: true })
    expect(report.from).toBe(2)
    expect(report.to).toBe(maxSupportedVersion)
    expect(report.applied.map((entry) => entry.version)).toContain(3)

    const columnNames = (db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>)
      .map((row) => row.name)
    expect(columnNames).not.toContain('embedding_modal_raw')
    expect(columnNames).not.toContain('embedding_modal_compressed')

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
    expect(tables).not.toContain('modal_embedding_model')
    // 019 sweep: none of the dead tree-era tables exist after the climb.
    for (const dead of ['nodes_trigram', 'knn_index', 'flat_journal', 'journal_trigram', 'session_stats', 'logistic_state', 'quantizer']) {
      expect(tables, dead + ' should be gone').not.toContain(dead)
    }

    // Seeded data survives the climb.
    const tree = db.prepare('SELECT tree_id FROM trees WHERE tree_id = 1').get()
    expect(tree).toBeTruthy()

    db.close()
  })
})
