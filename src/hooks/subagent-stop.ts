/**
 * SubagentStop hook (D147, D190): captures the subagent's report and
 * retires its registration.
 *
 * Claude Code fires SubagentStop with the parent's session_id, the
 * subagent's agent_id and agent_type, and its `last_assistant_message`
 * (probe of 2026-09-25) — the report the subagent hands its orchestrator.
 * That report is staged as the subagent's summary: an assistant row with
 * kind `subagent-summary`, stamped with the subagent as its writer, so the
 * orchestrator finds it by search marked as that subagent's summary. When a
 * payload carries no message, the last assistant text of the subagent's
 * own transcript (`agent_transcript_path`) stands in for it, as the Stop
 * hook reads the main transcript. Then the registration is retired, on the
 * same connection, so the next tool-written row is no longer the
 * subagent's. The capture comes first: retiring never displaces it.
 */
import type { Database as DatabaseType } from 'better-sqlite3'
import { parseHookInput, resolveDbPath, writeStaging, openHookDb, isDirectInvocation, payloadWriter } from './shared.js'
import { extractLastAssistantText } from './stop.js'
import { hasRegistry, retireSubagent } from '../persistence/session-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../handoff.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'

function retire(db: DatabaseType, sessionId: string, agentId: string): void {
  if (!hasRegistry(db)) return
  const retired = retireSubagent(db, sessionId, agentId, Date.now() / 1000)
  dbg('hook:subagent-stop', retired ? 'retired' : 'no live registration to retire', { sessionId, agentId })
}

export function main(preParsed?: Record<string, unknown>): void {
  try {
    const input = (preParsed ?? parseHookInput()) as Record<string, unknown>
    const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : undefined
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : undefined
    const { agentId, agentType } = payloadWriter(input)
    dbg('hook:subagent-stop', 'invoked', { sessionId: sessionId ?? null, agentId: agentId ?? null, agentType: agentType ?? null })

    let report = typeof input['last_assistant_message'] === 'string' && input['last_assistant_message'].trim() !== ''
      ? input['last_assistant_message']
      : null
    const transcript = input['agent_transcript_path']
    if (!report && typeof transcript === 'string' && transcript !== '') report = extractLastAssistantText(transcript)

    const dbPath = resolveDbPath(cwd)
    const andRetire = sessionId && agentId ? (db: DatabaseType) => retire(db, sessionId, agentId) : undefined
    let retired = false
    if (report) {
      const content = report.substring(0, STORE_SAFETY_CAP)
      writeStaging(dbPath, {
        sessionId: sessionId ?? null,
        role: 'assistant',
        content,
        timestamp: Date.now() / 1000,
        priority: 1,
        indexLen: Math.min(activeIndexCap('assistant'), content.length),
        ...(agentId ? { agentId } : {}),
        ...(agentType ? { agentType } : {}),
        kind: SUBAGENT_SUMMARY_KIND,
      }, andRetire ? (db) => { andRetire(db); retired = true } : undefined)
    } else {
      dbg('hook:subagent-stop', 'no report in the payload or the transcript — nothing to capture')
    }
    if (andRetire && !retired) {
      let db: DatabaseType | null = null
      try { db = openHookDb(dbPath); andRetire(db) } catch (err) {
        dbg('hook:subagent-stop', 'retire FAILED', { error: err instanceof Error ? err.message : String(err) })
      } finally { if (db) db.close() }
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook] subagent-stop error: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
