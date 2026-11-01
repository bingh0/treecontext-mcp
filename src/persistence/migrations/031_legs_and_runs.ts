import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'
import { LEG_REGISTRY_COLUMNS, LEG_REGISTRY_INDEX_DDL } from '../leg-registry.js'
import { CHECKPOINT_NUMBER_INDEX_DDL, RUN_ROW_INDEX_DDL } from '../../runs.js'

// Legs, workers and runs (the beta.3 subagent cut, D279–D352).
//
// The session registry gains the facts a leg is registered with: its run
// and key and where they came from (D289, D320, D326), the door that
// registered it and whether its identity was registered by a hook or
// declared (D293), the checkpointer its brief named (D281) and the
// checkpoint(s) it started from (D329, D331), its parent linked by id or
// carried as declared (D294), the ticket's mint moment, raw text and the
// fields the door could not read (D303, D342), whether it declared a way
// to write (D340), its host, process id and OS-reported start moment and
// every process a re-run added (D297, D317, D335), its one send-back
// (D279), how it ended and, for a phantom, when and by whom that was
// noticed (D297), and the runs it opened (D311). Every column nullable:
// a self and a keyless subagent read exactly as before (D305).
//
// The journal gains two partial indexes over row metadata: the store's
// numbering of checkpoints, unique per (namespace, run, key) outside
// handoff lanes, so no two checkpoints of one key ever share a number
// (D329); and the rows a run is made of, by run name (D289, D309).
// Columns and indexes only: additive. Hooks meeting an older store write
// what its shape holds (hasLegColumns).
const migration: Migration = {
  version: 31,
  kind: 'additive',
  description: 'Legs, workers and runs: leg facts on session_registry; checkpoint numbering and run-row indexes (D279–D352)',
  up(db) {
    if (hasTable(db, 'session_registry')) {
      addColumns(db, 'session_registry', LEG_REGISTRY_COLUMNS)
      db.exec(LEG_REGISTRY_INDEX_DDL)
    }
    if (hasTable(db, 'nodes')) {
      db.exec(CHECKPOINT_NUMBER_INDEX_DDL)
      db.exec(RUN_ROW_INDEX_DDL)
    }
  },
}

export default migration
