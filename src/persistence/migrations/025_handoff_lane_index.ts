import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { CURATED_INDEX_DDL } from '../curated-index.js'

// The curated unique index leaves handoff lanes (D164, D221). An entry
// imported from a teammate's file carries its own id, and identity — not
// content — decides whether it is already present; the old index refused
// a teammate's chapter that read like one of the receiver's own and the
// import misreported it as present. Recreating the index under a WEAKER
// predicate can never fail on existing rows (it covers a subset of what
// the old one did), and dropping an index loses no data: additive.
const migration: Migration = {
  version: 25,
  kind: 'additive',
  description: 'The curated unique index excludes handoff lanes, which dedup by identity',
  up(db) {
    if (!hasTable(db, 'nodes')) return
    db.exec(`DROP INDEX IF EXISTS idx_nodes_curated_fp; ${CURATED_INDEX_DDL}`)
  },
}

export default migration
