import type { Migration } from '../migrations.js'

const migration: Migration = {
  version: 5,
  kind: 'additive',
  description: 'Add snapshots table for session continuity',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        queries     TEXT NOT NULL,
        claimed_by  TEXT,
        claimed_at  REAL,
        created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_unclaimed ON snapshots(claimed_by) WHERE claimed_by IS NULL;
    `)
  },
}

export default migration
