import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'
import { LEG_REGISTRY_COLUMNS, LEG_REGISTRY_INDEX_DDL } from '../leg-registry.js'

// Reconcile the leg columns (the beta.3 build, unit 4's review).
//
// Migration 031 was extended while unreleased (proc_start_token by the
// ticket door, client_sessions by the hooks door), and a store a
// pre-release build already took to 31 never runs 031 again, so it lacks
// whatever was added after it ran: on such a store a `claude -p` child's
// session is never linked to its worker's lane, silently. This adds every
// leg column the store lacks, the whole list each time (addColumns skips
// a column that exists), so any store at 31 climbs to the same shape a
// fresh one has. Additive: columns and an index only, auto-run by the
// server's open, never by a hook (JF-8).
const migration: Migration = {
  version: 32,
  kind: 'additive',
  description: 'Reconcile the leg columns a pre-release 031 store lacks (client_sessions, proc_start_token, ...)',
  up(db) {
    if (hasTable(db, 'session_registry')) {
      addColumns(db, 'session_registry', LEG_REGISTRY_COLUMNS)
      db.exec(LEG_REGISTRY_INDEX_DDL)
    }
  },
}

export default migration
