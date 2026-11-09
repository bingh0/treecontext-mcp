import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { WORKER_INDEX_DDL } from '../curated-index.js'

// A ticket-door worker's curated dedup is its own lane's (D391).
//
// A worker's lane is its whole session, and curated dedup was keyed by the
// tree and the fingerprint alone (025's index), so a worker's note that
// another lane already held landed no row in the worker's lane. From this
// build a worker's curated row takes the `worker_curated` dedup class
// (dedup-identity.ts dedupClassOf), which the curated index's predicate
// (`dedup_class = 'curated'`) never covered, and this adds the index that
// keys that class by the session as well: (tree_id, session_key,
// fingerprint). A worker's own repeat still dedups within its session.
//
// Additive: one new partial unique index over a class no existing row
// holds, so it can never fail on existing rows; no row is reclassified,
// re-keyed or rewritten, and the curated index is left as 025 built it (no
// rebuild). A worker row written before this build keeps the curated class
// it was written with. The store is copied aside before it runs, as before
// every migration (migrations.ts, D59, D256).
const migration: Migration = {
  version: 33,
  kind: 'additive',
  description: 'A ticket-door worker\'s curated dedup is its own lane\'s: the worker_curated class\'s unique index by session (D391)',
  up(db) {
    if (!hasTable(db, 'nodes')) return
    db.exec(WORKER_INDEX_DDL)
  },
}

export default migration
