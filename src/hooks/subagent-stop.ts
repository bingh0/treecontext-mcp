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
 *
 * A SubagentStop whose agent id nobody registered and whose payload names
 * no agent type is the client's own internal agent (D263): its report is
 * captured just the same, whole, but staged with kind `internal-summary`,
 * and the drain stamps it with the writer `claude-code`.
 */
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { parseHookInput, resolveDbPath, writeStaging, openHookDb, isDirectInvocation, payloadWriter, STOP_GUARD_TIMEOUT_MS } from './shared.js'
import { extractLastAssistantText } from './stop.js'
import { hasRegistry, retireSubagent, subagentOf, INTERNAL_SUMMARY_KIND } from '../persistence/session-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../handoff.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'

/**
 * D263: whether this SubagentStop is the client's own internal agent — the
 * compaction summarizer, a prompt-suggestion side call — rather than a
 * subagent anyone spawned. Claude Code fires SubagentStop for those too,
 * with an agent id but no agent type, and no SubagentStart before it.
 *
 * Internal only on positive evidence: no agent type in the payload, and a
 * registry that was read and holds no row for (session, agent id), live or
 * retired — a registration, even a retired one, means a SubagentStart
 * happened. Anything less — no session or agent id to look up, a store the
 * registry has not reached, a lookup that throws or times out — is no
 * evidence, and the report stays a subagent summary: mis-marking a real
 * subagent's report would drop it from the handoff and the lanes silently,
 * the worse error (D3, D238). Read-only, on the Stop hook's guard budget,
 * so it never stacks past the platform's kill with the write behind it.
 */
function isInternalAgent(dbPath: string, sessionId: string | undefined, agentId: string | undefined, agentType: string | undefined): boolean {
  if (agentType || !sessionId || !agentId) return false
  let db: DatabaseType | null = null
  try {
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    if (!hasRegistry(db)) {
      dbg('hook:subagent-stop', 'no registry readable — kept as a subagent summary')
      return false
    }
    return subagentOf(db, sessionId, agentId) === null
  } catch (err) {
    dbg('hook:subagent-stop', 'registration lookup FAILED — kept as a subagent summary', { error: err instanceof Error ? err.message : String(err) })
    return false
  } finally { if (db) db.close() }
}

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
      const internal = isInternalAgent(dbPath, sessionId, agentId, agentType)
      dbg('hook:subagent-stop', internal ? 'unregistered and untyped — the client\'s own internal agent' : 'a subagent\'s report', { agentId: agentId ?? null })
      writeStaging(dbPath, {
        sessionId: sessionId ?? null,
        role: 'assistant',
        content,
        timestamp: Date.now() / 1000,
        priority: 1,
        indexLen: Math.min(activeIndexCap('assistant'), content.length),
        ...(agentId ? { agentId } : {}),
        ...(agentType ? { agentType } : {}),
        kind: internal ? INTERNAL_SUMMARY_KIND : SUBAGENT_SUMMARY_KIND,
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
