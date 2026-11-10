/**
 * Where a staged tool row came from when it is not the call's own result
 * (staging's `captured_from`, migration 034), and the staged kinds a
 * client's turn end writes. A leaf: the hooks and the drain both read it.
 *
 * `captured_from` on a staged row is a capture mark the hooks set, never a
 * caller's word (AGENTS.md): every gate that reads a call's own successful
 * event (the drain's echo heals, the status publisher, the stop hook's
 * settle, the staged cap-refusal read) skips a row that carries one.
 */

/** D401: the client's account of a batch (Claude Code's PostToolBatch). */
export const BATCH_MARK = 'batch'

/**
 * D408: Codex's PreToolUse, held in staging as the account of a call that
 * may yet end with no result. The drain writes no entry from it: a call
 * whose PostToolUse arrives is journaled from that event, and one whose
 * turn ends first is journaled from this account as NO_RESULT_MARK.
 */
export const PRE_TOOL_USE_MARK = 'pre-tool-use'

/**
 * D408: a call Codex reported no result for: its PreToolUse arrived and no
 * PostToolUse by its turn's end (Stop, Interrupt, or the subagent's
 * SubagentStop). The entry holds the call's tool name, its input and
 * Codex's id for it, carries no exit class, and says nothing of why.
 */
export const NO_RESULT_MARK = 'no-result'

/** The line a no-result entry carries after the call's input. Not an
 *  Output section: Codex returned nothing for the call. */
export const NO_RESULT_LINE = 'Result: none reported. Codex sent this call\'s PreToolUse and no PostToolUse by the end of its turn.'

/**
 * D408: the staged kind of a turn the developer interrupted (Codex's
 * Interrupt, which fires no Stop): the drain writes it as a capture-gap
 * entry naming the turn's reply as not captured, Codex putting the partial
 * reply in no payload.
 */
export const TURN_INTERRUPTED_KIND = 'turn-interrupted'

/** The capture-gap entry's text for an interrupted turn. */
export function interruptedTurnText(turnId: string | null): string {
  return `[capture gap] The developer interrupted this turn${turnId ? ` (Codex turn ${turnId})` : ''}: `
    + 'its reply was not captured, since Codex puts a partial reply in no hook payload. '
    + 'Any call of the turn Codex reported no result for is journaled beside this entry.'
}

/**
 * D408, D3: an account that left staging unresolved. A turn that never
 * ended in a way the journal heard (no Stop, no Interrupt, no SubagentStop:
 * a crash, a kill, a worker the ticket door cut at its timeout) leaves its
 * calls' PreToolUse accounts with nothing to resolve them. Before the purge
 * of processed staging takes such an account, it is journaled with what is
 * known: Codex started the call, and neither its result nor the end of its
 * turn reached the journal. No claim about what Codex sent.
 */
export const NO_TURN_END_MARK = 'no-turn-end'

/** The line such an entry carries after the call's input. */
export const NO_TURN_END_LINE = 'Result: none reached the journal. Codex started this call; neither its result nor the end of its turn reached the journal.'

/** The marks of an entry written for a call whose result had not reached
 *  the journal when it was written: NO_RESULT_MARK and NO_TURN_END_MARK. */
export const UNRESOLVED_CALL_MARKS: readonly string[] = [NO_RESULT_MARK, NO_TURN_END_MARK]

/**
 * A call is one call to every reader (D408): when the call's own result, or
 * a capture-gap row naming it (`gap_tool_use_id`), lands after its
 * no-result or no-turn-end entry, that entry is never deleted (it was true
 * when written; retention never destroys) but marked resolved, naming the
 * entry that resolved it under this key, with `resolved_at` and
 * `resolved_how` (`result` or `capture-gap`) beside it. The drain sets it;
 * readers read it only on a captured tool row carrying one of
 * UNRESOLVED_CALL_MARKS (resolvedCallEntrySql), never off a caller's note.
 */
export const RESOLVED_BY_KEY = 'resolved_by'

/** The drain's keys on a capture-gap row (the ledger record it was written
 *  from, `gap_id`; the dropped call it names) and on a resolved entry: the
 *  store's, never a caller's (the insert tool drops a
 *  caller's copy on every row, server.ts). */
export const GAP_TOOL_USE_ID_KEY = 'gap_tool_use_id'
export const DRAIN_CALL_KEYS: readonly string[] = [GAP_TOOL_USE_ID_KEY, RESOLVED_BY_KEY, 'resolved_at', 'resolved_how', 'gap_id']

/** The source a capture-gap row carries (`source_label` too). */
export const CAPTURE_GAP_SOURCE = 'capture-gap'

/** Sources only the store writes: the insert tool drops a caller's (and says
 *  so), so a reader of one reads the store's own row. The recovery note's
 *  is spelled here to keep this module a leaf (recovery-snapshot.ts
 *  RECOVERY_SNAPSHOT_SOURCE, held equal by a test). */
export const STORE_ONLY_SOURCES: readonly string[] = [CAPTURE_GAP_SOURCE, 'recovery-snapshot']

/**
 * The session a row's call was staged in: the client's own session, which
 * the drain keeps as `_client_session_id` where it files a worker's rows in
 * the worker's lane (workerLaneOf), and `session_id` otherwise.
 */
export function callSessionSql(alias: string): string {
  return `COALESCE(json_extract(${alias}.metadata_json, '$._client_session_id'), json_extract(${alias}.metadata_json, '$.session_id'))`
}

/**
 * SQL true for a row of the store that journals the call `id` of the
 * client session `session` (both SQL expressions: a column, or `?`):
 * written by the capture pipeline, and so told by what no tool caller can
 * set, never by a key alone (AGENTS.md: capture marks are never trusted
 * from node metadata):
 *  - a captured tool row: `auto-capture` with a `tool_name` and the call's
 *    `tool_use_id` (the insert tool drops a caller's `tool_use_id` on a row
 *    it labels `auto-capture`);
 *  - the drain's capture-gap row naming the call (`gap_tool_use_id`, which
 *    the insert tool drops from every caller's row).
 * Only in the call's own session (callSessionSql) and the store's own lanes
 * (ownLaneRowSql), so another session's rows never answer for it, an
 * imported copy (a `handoff:` lane, whatever `_client_session_id` it claims)
 * never does, and neither does a namespace merge's copy (`_merge_label`).
 */
/** SQL true for a row of the store's own lanes: never an imported row
 *  (a `handoff:` lane) and never a namespace merge's copy (`_merge_label`),
 *  whatever capture marks or session claims either carries. */
export function ownLaneRowSql(alias: string): string {
  const m = `${alias}.metadata_json`
  return `(COALESCE(json_extract(${m}, '$.session_id'), '') NOT LIKE 'handoff:%' AND json_extract(${m}, '$._merge_label') IS NULL)`
}

export function ownCallRowSql(alias: string, id: string, session: string): string {
  const m = `${alias}.metadata_json`
  return `(${callSessionSql(alias)} = ${session} AND ${ownLaneRowSql(alias)}`
    + ` AND ((COALESCE(${alias}.source_label, '') = 'auto-capture' AND json_extract(${m}, '$.tool_name') IS NOT NULL AND json_extract(${m}, '$.tool_use_id') = ${id})`
    + ` OR (COALESCE(${alias}.source_label, '') = 'capture-gap' AND json_extract(${m}, '$.${GAP_TOOL_USE_ID_KEY}') = ${id})))`
}

/** As ownCallRowSql, the drain's capture-gap row alone. */
export function ownCallGapRowSql(alias: string, id: string, session: string): string {
  const m = `${alias}.metadata_json`
  return `(${callSessionSql(alias)} = ${session} AND ${ownLaneRowSql(alias)}`
    + ` AND COALESCE(${alias}.source_label, '') = 'capture-gap' AND json_extract(${m}, '$.${GAP_TOOL_USE_ID_KEY}') = ${id})`
}

/** SQL true for a no-result or no-turn-end entry a later entry resolved
 *  (`alias` is the nodes table's alias, with its dot, or ''). */
export function resolvedCallEntrySql(alias = ''): string {
  return `(COALESCE(${alias}source_label, '') = 'auto-capture'`
    + ` AND json_extract(${alias}metadata_json, '$.captured_from') IN ('${NO_RESULT_MARK}', '${NO_TURN_END_MARK}')`
    + ` AND json_extract(${alias}metadata_json, '$.${RESOLVED_BY_KEY}') IS NOT NULL)`
}
