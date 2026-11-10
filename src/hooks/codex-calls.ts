/**
 * Codex CLI's calls and turns at the hooks (D408, D409): the account of a
 * call its PreToolUse gives, held until its turn ends, and the turn's end.
 *
 * Codex states no outcome for a call. A shell command arrives by
 * PostToolUse whatever its exit; a call of any other tool that fails (an MCP
 * tool's error reply, a patch that did not apply) fires PreToolUse and no
 * PostToolUse (recorded live, 2026-11-09, Codex CLI 0.167.0). So the
 * PreToolUse is staged as the call's account (PRE_TOOL_USE_MARK), from
 * which the drain writes nothing, and at the turn's end (Stop, Interrupt,
 * or the subagent's SubagentStop) every account of that writer with no
 * other staged row for its call id is staged once more as the entry of a
 * call Codex reported no result for (NO_RESULT_MARK). A call is journaled
 * once: its PostToolUse, when it arrived, is its entry.
 *
 * Staged rows stay in staging after the drain (processed = 1) until the
 * processed-row prune a day later, so the lookup sees every call of the
 * turn whichever rows the drain already took. On a store below 034 there
 * is no call id to tell the calls apart by: the PreToolUse is not staged,
 * and the turn's end adds nothing.
 */
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { hostname } from 'node:os'
import { openHookDb, stagingHasCallId, payloadWriter } from './shared.js'
import { recordHookGap, ledgeredCallIds, ledgeredCallKey } from './gap-ledger.js'
import { composeToolEntry } from './post-tool-use.js'
import { resolveHookNamespace } from '../session-beacon.js'
import { nsLeaseLiveFor } from '../persistence/leases.js'
import { PRE_TOOL_USE_MARK, NO_RESULT_MARK, NO_RESULT_LINE, ownCallGapRowSql } from '../persistence/capture-marks.js'
import { dbg } from '../debug.js'

function callIdOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

const INSERT = `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at,
   index_len, preview_len, namespace, agent_id, agent_type, kind, tool_use_id, outcome, captured_from)
 VALUES (?, 'assistant', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`

function namespaceFor(db: DatabaseType, dbPath: string, sessionId: string): string | null {
  return resolveHookNamespace(dbPath, process.ppid, sessionId, (a) => nsLeaseLiveFor(db, a.namespace, a.server_pid, hostname()))
}

/** Stage Codex's PreToolUse as the account of its call (D408). */
export function stagePreToolUse(dbPath: string, input: Record<string, unknown>, at: number): 'staged' | 'skipped' {
  const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : null
  const toolName = typeof input['tool_name'] === 'string' && input['tool_name'] !== '' ? input['tool_name'] : null
  const toolUseId = callIdOf(input['tool_use_id'])
  if (!sessionId || !toolName || !toolUseId) return 'skipped'
  const writer = payloadWriter(input)
  const e = composeToolEntry(toolName, input['tool_input'], undefined)
  let db: DatabaseType | null = null
  try {
    db = openHookDb(dbPath)
    if (!stagingHasCallId(db)) {
      dbg('hook:pre-tool', 'staging predates the call id (034): the account is not staged', { dbPath })
      return 'skipped'
    }
    db.prepare(INSERT).run(sessionId, e.content, toolName, at, e.priority, Date.now() / 1000, e.indexLen, e.previewLen,
      namespaceFor(db, dbPath, sessionId), writer.agentId ?? null, writer.agentType ?? null, toolUseId, PRE_TOOL_USE_MARK)
    return 'staged'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[treecontext hook] Failed to stage Codex's PreToolUse: ${msg}`)
    // D314: never silently. Lost only if the call ends with no result.
    recordHookGap(dbPath, {
      hook: 'post-tool-use', sessionId, ...writer, at, error: msg,
      lost: `The PreToolUse account of the ${toolName} call ${toolUseId} was not staged, so if Codex reported no result for it the call leaves no entry.`,
      text: e.content,
    })
    return 'skipped'
  } finally { if (db) db.close() }
}

/**
 * D408: at a turn's end, the calls of this writer (the main thread, or the
 * subagent `agentId`) whose PreToolUse was staged and whose call id no
 * other staged row carries are staged once as calls Codex reported no
 * result for, each at its call's moment (its PreToolUse account's), never
 * the turn end's: the entry reads as the call, not as the session's latest
 * activity, and its ingested_at says when it was written. A plain read first; the write lock
 * is taken only when there is a call to add, and the lookup is made again
 * under it. Returns the ids staged.
 */
export function stageNoResultCalls(dbPath: string, sessionId: string | null, agentId: string | null, at: number, deadlineAt?: number): string[] {
  if (!sessionId) return []
  let db: DatabaseType | null = null
  let pending: Array<Record<string, unknown>> = []
  try {
    db = openHookDb(dbPath, deadlineAt !== undefined ? { deadlineAt } : undefined)
    if (!stagingHasCallId(db)) return []
    const handle = db
    const lookup = (): Array<Record<string, unknown>> => handle.prepare(
      `SELECT p.content, p.tool_name, p.priority, p.index_len, p.preview_len, p.namespace, p.agent_id, p.agent_type, p.tool_use_id, MIN(p.timestamp) AS at
         FROM staging p
        WHERE p.session_id = ? AND p.captured_from = ? AND ${agentId === null ? 'p.agent_id IS NULL' : 'p.agent_id = ?'}
          AND NOT EXISTS (SELECT 1 FROM staging o WHERE o.session_id = p.session_id AND o.tool_use_id = p.tool_use_id
                            AND (o.captured_from IS NULL OR o.captured_from <> ?))
          AND NOT EXISTS (SELECT 1 FROM nodes g WHERE ${ownCallGapRowSql('g', 'p.tool_use_id', 'p.session_id')})
        GROUP BY p.tool_use_id ORDER BY MIN(p.id)`,
    ).all(sessionId, PRE_TOOL_USE_MARK, ...(agentId === null ? [] : [agentId]), PRE_TOOL_USE_MARK) as Array<Record<string, unknown>>
    // A call whose own result event was dropped is in the gap ledger (its
    // capture-gap row names the call once written): the client did report
    // a result, which was lost here, so it is never a no-result entry.
    const ledgered = ledgeredCallIds(dbPath)
    const unledgered = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => rows.filter((r) => !ledgered.has(ledgeredCallKey(sessionId, String(r['tool_use_id']))))
    pending = unledgered(lookup())
    if (pending.length === 0) return []
    handle.exec('BEGIN IMMEDIATE')
    try {
      pending = unledgered(lookup())
      const insert = handle.prepare(INSERT)
      for (const p of pending) {
        const content = `${String(p['content'])}\n${NO_RESULT_LINE}`
        // The account's boundaries still hold: the line follows its input.
        insert.run(sessionId, content, p['tool_name'] as string, p['at'] as number, p['priority'] as number, Date.now() / 1000,
          (p['index_len'] as number | null) ?? null, (p['preview_len'] as number | null) ?? null, (p['namespace'] as string | null) ?? null,
          (p['agent_id'] as string | null) ?? null, (p['agent_type'] as string | null) ?? null, p['tool_use_id'] as string, NO_RESULT_MARK)
      }
      handle.exec('COMMIT')
    } catch (err) {
      try { handle.exec('ROLLBACK') } catch { /* not in a transaction */ }
      throw err
    }
    dbg('hook:codex', 'calls with no result reported staged', { dbPath, staged: pending.length })
    return pending.map((p) => String(p['tool_use_id']))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[treecontext hook] Failed to stage the calls Codex reported no result for: ${msg}`)
    recordHookGap(dbPath, {
      hook: 'stop', sessionId, ...(agentId ? { agentId } : {}), at, error: msg,
      lost: pending.length > 0
        ? `The calls Codex reported no result for were not staged: ${pending.map((p) => `${String(p['tool_name'])} ${String(p['tool_use_id'])}`).join(', ')}.`
        : 'The turn\'s calls were not checked for ones Codex reported no result for, so such a call may have no entry.',
      text: null,
    })
    return []
  } finally { if (db) db.close() }
}
