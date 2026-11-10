import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'

// A staged row carries the client whose hook staged it, where the hook's
// command named one whose hooks register no self (D421): Antigravity CLI.
//
// An agy session the ticket door did not start registers nothing, so its
// captured rows sit in a session the registry never held; read by the
// pre-stamp rule, a row with no writer stamp in such a session is main's.
// The drain reads this column to stamp those rows as a writer no hook
// registered (`_writer_src` `unregistered`), so they read as writer unknown,
// in no checkout's lane, never as the main checkout's. A worker's rows land
// in its lane as before (its conversation linked at SessionStart).
//
// Taken from the command install wrote (`--client agy`), never from the
// payload. Additive: one nullable column, no rewrite, no backfill. A hook
// meeting a store below this version drops the column (writeStaging's tier
// walk, hooks never migrate, JF-8): the row then drains unstamped, as any
// row of an unregistered session did before. Guarded: a minimal legacy
// fixture may have no staging table.
const migration: Migration = {
  version: 37,
  kind: 'additive',
  description: 'Add staging.client: the client whose hooks register no self, so its rows read as writer unknown (D421)',
  up(db) {
    if (!hasTable(db, 'staging')) return
    addColumns(db, 'staging', [['client', 'TEXT']])
  },
}

export default migration
