import type { Migration } from '../migrations.js'

const migration: Migration = {
  version: 4,
  kind: 'additive',
  description: 'Add per-node decay rate column and staging table',
  up(db) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN decay_rate REAL;

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
    `)
  },
}

export default migration