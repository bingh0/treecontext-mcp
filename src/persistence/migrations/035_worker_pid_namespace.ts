import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'
import { PROC_NS_COLUMN } from '../leg-registry.js'

// A worker registration records which numbering of processes its process
// id belongs to (D403).
//
// A ticket door run inside a sandbox that numbers its own processes (Codex
// CLI's on Linux, a pid namespace of its own) registered its worker with the
// id the sandbox gave it, and a reader outside looked that id up in the
// machine's numbering, found an unrelated process and retired the running
// worker as a phantom. From this build the door records, beside the id, the
// numbering it belongs to (`pid:[<inode>]`, the link /proc/<pid>/ns/pid):
// on each process of the registration's `processes` list (JSON, no column
// needed) and, for the first process, in this column, as `pid`, `proc_start`
// and `proc_start_token` keep the first process's own readings.
//
// Additive: one nullable column, no rewrite and no backfill. A registration
// written before this build keeps NULL, which every reader reads as "an
// earlier build recorded no numbering" (leg-registry.ts retirePhantoms):
// judged as before only by a reader in the machine's own numbering. Guarded
// like 031/032: a minimal legacy fixture may have no registry.
const migration: Migration = {
  version: 35,
  kind: 'additive',
  description: 'Add session_registry.proc_ns: the numbering of processes a worker\'s process id belongs to (D403)',
  up(db) {
    if (!hasTable(db, 'session_registry')) return
    addColumns(db, 'session_registry', [PROC_NS_COLUMN])
  },
}

export default migration
