import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { HANDOFF_LANE_PREFIX, SUBAGENT_SUMMARY_KIND } from '../../handoff.js'
import { AGENT_WRITER_PREFIX, CLIENT_WRITER, INTERNAL_SUMMARY_KIND } from '../session-registry.js'

const m = (key: string): string => `json_extract(metadata_json, '$.${key}')`

/**
 * The predicate of a report the earlier SubagentStop rule stored as a
 * subagent's summary although no SubagentStart registered it and its
 * payload named no agent type (D263). Every clause narrows:
 *  - the hook's own capture (`source_label` `auto-capture`): a curated row
 *    a caller marked `subagent-summary` is the caller's word, not a hook's;
 *  - never a handoff lane: an imported row's writer lives under its
 *    `_handoff_claims` (the file's claim), and nothing may stamp it;
 *  - no agent type: the drain never kept the hook's agent_type under a key
 *    of its own; it stamped `_writer` from it, the type when one was sent,
 *    else the agent id (`_writer_agent_id`, under `agent:` when escaped),
 *    so a typed report names its role there and is left alone;
 *  - no registration: a registry row for (session, agent id), live or
 *    retired, is evidence a SubagentStart happened (retiring only sets
 *    stopped_at; registrations are never deleted), so it was a subagent.
 * Guarded by `json_valid` inside a CASE, so a row whose metadata does not
 * parse is never read as JSON.
 */
export function untypedSubagentSummaryWhere(withRegistry: boolean): string {
  return `CASE WHEN json_valid(metadata_json) THEN (
    ${m('kind')} = '${SUBAGENT_SUMMARY_KIND}'
    AND source_label = 'auto-capture'
    AND COALESCE(session_key, '') NOT LIKE '${HANDOFF_LANE_PREFIX}%'
    AND ${m('agent_type')} IS NULL
    AND (${m('_writer')} IS NULL
      OR ${m('_writer')} = ${m('_writer_agent_id')}
      OR ${m('_writer')} = '${AGENT_WRITER_PREFIX}' || ${m('_writer_agent_id')})
    ${withRegistry ? `AND NOT EXISTS (SELECT 1 FROM session_registry r
      WHERE r.session_id = COALESCE(nodes.session_key, ${m('session_id')})
        AND r.agent_id = ${m('_writer_agent_id')})` : ''}
  ) ELSE 0 END`
}

// D263: Claude Code fires SubagentStop for agents nobody spawned — the
// compaction summarizer, prompt-suggestion side calls — with an agent id
// and no agent type. Until this release each such report was stored as a
// subagent's summary under its agent id, and led the default handoff file.
// This re-marks every one a store already holds as the client's own:
// kind `internal-summary`, writer `claude-code`, exactly what the hook and
// drain now stamp. `_writer_src` is left as the drain stamped it (`hook`:
// the report did come from the hook payload, and a fresh capture of the
// same report carries the same source); `_writer_agent_id` stays, so the
// row is still never the orchestrator's checkpoint. Content, the index
// and every other key are untouched: neither kind nor writer is indexed.
// Rows imported from a beta.1 handoff file keep their marking in their
// handoff lane. Runs in the runner's one additive transaction; the version
// makes it run once.
const migration: Migration = {
  version: 29,
  kind: 'additive',
  description: "Re-mark untyped, unregistered SubagentStop reports as the client's internal summaries (D263)",
  up(db) {
    if (!hasTable(db, 'nodes')) return
    db.prepare(
      `UPDATE nodes SET metadata_json = json_set(metadata_json, '$.kind', ?, '$._writer', ?)
        WHERE ${untypedSubagentSummaryWhere(hasTable(db, 'session_registry'))}`,
    ).run(INTERNAL_SUMMARY_KIND, CLIENT_WRITER)
  },
}

export default migration
