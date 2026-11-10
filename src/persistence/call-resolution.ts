/**
 * A call is one call to every reader (D408, capture-marks.ts RESOLVED_BY_KEY):
 * when the call's own result, or a capture-gap row naming it, lands after
 * the entry the journal wrote for it with no result (a turn's end with no
 * PostToolUse, or the purge of an account whose turn never ended), the
 * earlier entry is marked resolved, naming the entry that resolved it. It
 * is never deleted: it was true when it was written, and retention never
 * destroys. A metadata-only update; the keys it sets never enter the index.
 */
import { NO_RESULT_MARK, NO_TURN_END_MARK, RESOLVED_BY_KEY, callSessionSql, ownLaneRowSql } from './capture-marks.js'

/** The handle this needs: a node:sqlite database, or the store's wrapper of one. */
export interface ResolutionHandle {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown }
}

/** How a call's earlier entry was resolved. */
export type ResolvedHow = 'result' | 'capture-gap'

/**
 * Mark every unresolved no-result or no-turn-end entry of the call
 * `toolUseId`, staged in the client session `callSession`, resolved by
 * `resolverId`. Only the call's own entries: a captured tool row
 * (`auto-capture`) of the same client session (callSessionSql: a worker's
 * rows in its lane keep the client's session beside), never another
 * session's entry with the same id, never an imported copy (a `handoff:`
 * lane is another session), a namespace merge's copy (`_merge_label`) or a
 * read-only row. A result resolves only in its own namespace's tree, where
 * the drain filed the entry beside it (both were staged with the
 * namespace); a capture-gap row, written with no namespace, resolves the
 * session's entry wherever the drain filed it. Returns the node ids marked.
 */
export function resolveEarlierCallEntries(db: ResolutionHandle, toolUseId: string, callSession: string, resolverId: string, how: ResolvedHow, now: number = Date.now() / 1000): string[] {
  const rows = db.prepare(
    `SELECT n.node_id, n.metadata_json FROM nodes n
      WHERE json_extract(n.metadata_json, '$.tool_use_id') = ? AND COALESCE(n.source_label, '') = 'auto-capture'
        AND json_extract(n.metadata_json, '$.captured_from') IN (?, ?)
        AND json_extract(n.metadata_json, '$.${RESOLVED_BY_KEY}') IS NULL AND n.node_id <> ?
        AND ${callSessionSql('n')} = ?
        AND (? = 'capture-gap' OR n.tree_id = (SELECT r.tree_id FROM nodes r WHERE r.node_id = ?))
        AND COALESCE(n.read_only, 0) = 0 AND ${ownLaneRowSql('n')}`,
  ).all(toolUseId, NO_RESULT_MARK, NO_TURN_END_MARK, resolverId, callSession, how, resolverId) as Array<{ node_id: string; metadata_json: string | null }>
  const upd = db.prepare('UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE node_id = ?')
  const done: string[] = []
  for (const r of rows) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown> } catch { continue }
    meta[RESOLVED_BY_KEY] = resolverId
    meta['resolved_at'] = now
    meta['resolved_how'] = how
    upd.run(JSON.stringify(meta), now, r.node_id)
    done.push(r.node_id)
  }
  return done
}
