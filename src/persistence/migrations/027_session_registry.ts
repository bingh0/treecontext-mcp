import type { Migration } from '../migrations.js'
import { addColumns, hasTable } from './guards.js'
import { SESSION_REGISTRY_DDL } from '../session-registry.js'

// Self registration (D190, D167): the session-start hook registers the
// session's self (worktree, branch, directory) under the session id it
// already carries, and the SubagentStart/SubagentStop hooks register and
// retire each subagent the session spawns. The server reads this table to
// stamp the writer of every row written through the tools; the
// session-start hook reads it to find a worktree's own thread.
//
// Staging gains the payload's agent fields (agent_id, agent_type) and a
// row kind (the subagent's summary is `subagent-summary`), so a
// row a subagent's PostToolUse captured drains stamped with its writer.
// A new table and three nullable columns: additive. Hooks meeting an older
// store fall back to the pre-027 column list (JF-8).
const migration: Migration = {
  version: 27,
  kind: 'additive',
  description: 'Session self registry (session_registry) and staging.agent_id/agent_type/kind (writer stamps)',
  up(db) {
    db.exec(SESSION_REGISTRY_DDL)
    if (hasTable(db, 'staging')) addColumns(db, 'staging', [['agent_id', 'TEXT'], ['agent_type', 'TEXT'], ['kind', 'TEXT']])
  },
}

export default migration
