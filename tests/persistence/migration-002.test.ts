/**
 * Migration v1 → v2: adds `namespace` column to `trees`.
 * Pre-existing rows must be backfilled to 'project'.
 */
import { describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'

/** Apply only migration #001 to simulate a legacy v1 store. */
function seedV1(db: ReturnType<typeof wrapBetterSqlite>): void {
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE embedding_model (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_name TEXT NOT NULL, dim INTEGER NOT NULL, pooling TEXT NOT NULL,
      normalize INTEGER NOT NULL, query_prefix TEXT, passage_prefix TEXT, model_checksum TEXT
    );
    CREATE TABLE trees (
      tree_id INTEGER PRIMARY KEY,
      ensemble_index INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      import_labels_json TEXT
    );
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      tree_id INTEGER NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(node_id) ON DELETE CASCADE,
      depth INTEGER NOT NULL DEFAULT 0,
      is_leaf INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      embedding_raw BLOB, embedding_compressed BLOB,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      summary_stale INTEGER NOT NULL DEFAULT 0,
      read_only INTEGER NOT NULL DEFAULT 0,
      decay_exempt INTEGER NOT NULL DEFAULT 0,
      utility_score REAL NOT NULL DEFAULT 0.5,
      source_label TEXT, metadata_json TEXT,
      CHECK ((embedding_raw IS NULL) OR (embedding_compressed IS NULL))
    );
    CREATE INDEX idx_nodes_parent ON nodes(parent_id);
    CREATE VIRTUAL TABLE nodes_fts USING fts5(content, content='');
    PRAGMA user_version = 1;

    INSERT INTO trees (tree_id, ensemble_index, created_at) VALUES (1, 0, 100);
    INSERT INTO trees (tree_id, ensemble_index, created_at) VALUES (2, 1, 100);
    INSERT INTO nodes (node_id, tree_id, content, created_at, updated_at)
      VALUES ('n1', 1, 'hello', 100, 100);
  `)
}

describe('migration 002_namespace', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-mig-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('adds namespace column, backfills existing rows to "project"', () => {
    const raw = new BetterSqlite3(join(dir, 's.db'))
    const db = wrapBetterSqlite(raw)
    seedV1(db)

    const report = runMigrations(db, { migrate: true })
    expect(report.from).toBe(1)
    expect(report.to).toBe(maxSupportedVersion)
    expect(report.applied.map((a) => a.version)).toContain(2)

    const rows = db.prepare('SELECT tree_id, namespace, ensemble_index FROM trees ORDER BY tree_id').all() as Array<
      { tree_id: number; namespace: string; ensemble_index: number }
    >
    expect(rows).toEqual([
      { tree_id: 1, namespace: 'project', ensemble_index: 0 },
      { tree_id: 2, namespace: 'project', ensemble_index: 1 },
    ])

    // Existing node → tree_id FK still intact (integer preserved across rebuild).
    const n = db.prepare("SELECT tree_id FROM nodes WHERE node_id = 'n1'").get() as { tree_id: number }
    expect(n.tree_id).toBe(1)

    db.close()
  })

  it('post-migration allows the same ensemble_index across different namespaces', () => {
    const raw = new BetterSqlite3(join(dir, 's.db'))
    const db = wrapBetterSqlite(raw)
    seedV1(db)
    runMigrations(db, { migrate: true })

    db.prepare(
      "INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('agent-a', 0, 200)",
    ).run()
    db.prepare(
      "INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('agent-a', 1, 200)",
    ).run()

    // Same (namespace, ensemble_index) pair must collide.
    expect(() => db.prepare(
      "INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('agent-a', 0, 201)",
    ).run()).toThrow()

    db.close()
  })

  it('fresh v2 store (no migration) honors the UNIQUE(namespace, ensemble_index) constraint', async () => {
    const { SCHEMA_SQL } = await import('../../src/persistence/schema.js')
    const raw = new BetterSqlite3(join(dir, 'fresh.db'))
    const db = wrapBetterSqlite(raw)
    db.exec(SCHEMA_SQL)

    db.prepare("INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('project', 0, 1)").run()
    db.prepare("INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('other', 0, 1)").run()
    expect(() => db.prepare(
      "INSERT INTO trees (namespace, ensemble_index, created_at) VALUES ('project', 0, 2)",
    ).run()).toThrow()

    db.close()
  })
})

import { beforeEach, afterEach } from 'vitest'
