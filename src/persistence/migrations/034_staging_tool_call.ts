import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'

/** The index the PostToolBatch hook's lookup reads: which of a batch's
 *  calls this session already staged, by the client's id for each call
 *  (D401). Partial, so the rows with no id (every row staged before this
 *  build, a prompt, a response) cost it nothing. */
export const STAGING_TOOL_USE_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_staging_tool_use ON staging(session_id, tool_use_id) WHERE tool_use_id IS NOT NULL'

// A staged tool call carries the client's own id for it and how it was
// captured (D400, D401).
//
// Claude Code fires PostToolUse only for a call that succeeded; a call
// that failed fires PostToolUseFailure, and a call the client resolved
// without running (input rejected, permission denied, blocked by a hook)
// fires no event of its own, only the batch's account, PostToolBatch.
// Three columns carry what the drain stamps on the node:
//   tool_use_id   — the client's id for the call, on every tool call
//                   captured from this build on, whichever event carried it;
//   outcome       — `failed` or `interrupted` on a PostToolUseFailure's
//                   row, NULL on a successful call's;
//   captured_from — `batch` on a row the batch's account added, NULL on a
//                   row its own event produced.
// The index makes the batch hook's lookup one probe per call.
//
// Additive: plain ALTER TABLE ADD COLUMN, no rewrite, no backfill; old rows
// keep NULL. A hook meeting a store below this version stages exactly what
// it staged before (hooks never migrate, JF-8: writeStaging's tier walk
// drops the three), and the batch hook adds nothing there, since what was
// captured cannot be told without the id (D401). Guarded like 016/018/020:
// a minimal legacy fixture may have no staging table.
const migration: Migration = {
  version: 34,
  kind: 'additive',
  description: 'Add staging.tool_use_id, outcome and captured_from (failed and refused tool calls, D400, D401)',
  up(db) {
    if (!hasTable(db, 'staging')) return
    addColumns(db, 'staging', [['tool_use_id', 'TEXT'], ['outcome', 'TEXT'], ['captured_from', 'TEXT']])
    db.exec(STAGING_TOOL_USE_INDEX_DDL)
  },
}

export default migration
