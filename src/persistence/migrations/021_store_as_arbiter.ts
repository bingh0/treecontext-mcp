import type { Migration } from '../migrations.js'
import { hasTable, addColumns } from './guards.js'

// The store becomes the arbiter (tests/server/design/store-as-arbiter.md,
// program G, charter third amendment): dedup, drain claims, and role
// coordination move from process memory and lockfiles into the database,
// so every consumer that opens the file inherits the invariants.
//
// This is the final-shape SHAPE migration — additive columns, two new
// tables, the curated-dedup unique index. The every-row backfill lives
// entirely in 022 (arbiter-backfill.ts): 021 and 022 ship in the same
// release and batch into one transaction, and running the whole-store
// decode-and-classify pass here AND as 022's heal would double the
// slowest migration ever shipped for every upgrading store (G2 review).
// Between 021 and 022 the new columns are simply NULL — outside the
// partial index, invisible to every reader.
const migration: Migration = {
  version: 21,
  kind: 'additive',
  description:
    'The store becomes the arbiter: fingerprint/dedup/session/claim columns, dedup_anchors + leases, curated unique index, full backfill',
  up(db) {
    const hasNodes = hasTable(db, 'nodes')
    if (hasNodes) {
      addColumns(db, 'nodes', [
        ['fingerprint', 'TEXT'],
        ['dedup_class', 'TEXT'],
        ['session_key', 'TEXT'],
        ['relied_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['index_len', 'INTEGER'],
        ['preview_len', 'INTEGER'],
      ])
    }
    if (hasTable(db, 'staging')) {
      addColumns(db, 'staging', [
        ['claimed_by', 'TEXT'],
        ['claimed_at', 'REAL'],
      ])
      // Claim-shaped index (amendment 7): the 017 index leads with
      // session_id and cannot serve the claim's ORDER BY timestamp, id.
      // 017 stays for the valve's per-session grouping.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_staging_drain_order ON staging(timestamp, id) WHERE processed = 0;',
      )
    }

    // Windowed auto-capture dedup cannot be a unique constraint (the same
    // content legitimately becomes a new row outside the 300s window), so
    // it anchors here. last_seen is CAPTURE time (the window slides on
    // honest chronology, JF-4); updated_at is WALL time, written on every
    // touch, and is what the hygiene sweep prunes on — a drained backlog's
    // anchors carry old capture times but must survive the sweep while
    // live (G2 review). The FK makes anchor lifecycle structural: a
    // node's anchors leave with the row, for every consumer, not by a
    // calling convention.
    db.exec(`CREATE TABLE IF NOT EXISTS dedup_anchors (
      tree_id     INTEGER NOT NULL,
      session_key TEXT    NOT NULL,
      fingerprint TEXT    NOT NULL,
      node_id     TEXT    NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
      last_seen   REAL    NOT NULL,
      updated_at  REAL    NOT NULL,
      PRIMARY KEY (tree_id, session_key, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_dedup_anchors_node ON dedup_anchors(node_id);`)

    // Role coordination (G4): heartbeat leases replace lockfiles.
    // Roles: 'drain' | 'ns:<namespace>' | 'sweep:<namespace>'.
    db.exec(`CREATE TABLE IF NOT EXISTS leases (
      role         TEXT PRIMARY KEY,
      holder_pid   INTEGER NOT NULL,
      holder_host  TEXT    NOT NULL,
      holder_token TEXT    NOT NULL DEFAULT '',
      holder_label TEXT,
      acquired_at  REAL    NOT NULL,
      heartbeat_at REAL    NOT NULL,
      ttl_secs     REAL    NOT NULL
    );`)
    // Replay guard: a store whose leases table predates holder_token
    // (an interim build of this same migration) gains the column on
    // re-application.
    addColumns(db, 'leases', [['holder_token', "TEXT NOT NULL DEFAULT ''"]])

  },
}

export default migration
