import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'

// A staged tool call carries the client whose own event stated that the
// call succeeded (D404).
//
// On Claude Code a call that arrives by PostToolUse succeeded: a call that
// failed, a shell command's non-zero exit and a timeout among them, arrives
// by PostToolUseFailure (D400), which already stages `outcome`. A success
// had no mark of its own, so the drain read its class from its text, and a
// successful status call whose reply said "error" was filed as an error.
// The hook now stages the client's name here when the client its command
// names (never the payload) states how a call ended and the event says it
// succeeded; the drain classes such a call a success and says the client
// decided it.
//
// Not an `outcome` value, deliberately: the drain's own-echo gate
// (ingestion.ts), the stop hook's settle (hooks/subagent-stop.ts) and the
// staged cap-refusal read (persistence/cap-refusals.ts) take
// `outcome IS NULL` to mean a call's own successful event, and D400 keeps
// `outcome` off a successful entry.
//
// Additive: one nullable column, no rewrite, no backfill; rows staged before
// keep NULL and drain classed by their text, as before. A hook meeting a
// store below this version drops the column (writeStaging's tier walk,
// hooks never migrate, JF-8): the call stages exactly as before and is
// classed by its text. Guarded: a minimal legacy fixture may have no
// staging table.
const migration: Migration = {
  version: 36,
  kind: 'additive',
  description: 'Add staging.stated_by: the client whose own event stated a tool call succeeded (D404)',
  up(db) {
    if (!hasTable(db, 'staging')) return
    addColumns(db, 'staging', [['stated_by', 'TEXT']])
  },
}

export default migration
