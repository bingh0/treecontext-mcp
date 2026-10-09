/**
 * SubagentStart hook (D190, D167, D150): registers a live subagent under
 * the session it was spawned in.
 *
 * The orchestrator and its subagents share one session id and one MCP
 * server, so the server cannot tell from a call who is speaking. Claude
 * Code fires SubagentStart with the PARENT's session_id plus the new
 * subagent's agent_id and agent_type (probe of 2026-09-25); this hook
 * records that registration, and SubagentStop retires it. While exactly one
 * subagent of a session is live, a row written through the tools is that
 * subagent's; with more than one live, the server stamps the session's
 * self and discloses the ambiguity (persistence/session-registry.ts).
 *
 * The subagent inherits where its session runs: the session's registered
 * self when there is one, else what git reports for the payload's cwd.
 * Emits nothing; a failure is logged and the hook exits 0 as every hook
 * does.
 */
import type { Database as DatabaseType } from 'better-sqlite3'
import { parseHookInput, resolveDbPath, openHookDb, isDirectInvocation, payloadWriter } from './shared.js'
import { gitSelfOf } from './git-self.js'
import { hasRegistry, registerSubagent, selfOf, type GitSelf } from '../persistence/session-registry.js'
import { dbg } from '../debug.js'

export function main(preParsed?: Record<string, unknown>): void {
  let db: DatabaseType | null = null
  try {
    const input = (preParsed ?? parseHookInput()) as Record<string, unknown>
    const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : undefined
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : undefined
    const { agentId, agentType } = payloadWriter(input)
    dbg('hook:subagent-start', 'invoked', { sessionId: sessionId ?? null, agentId: agentId ?? null, agentType: agentType ?? null })
    if (!sessionId || !agentId) {
      dbg('hook:subagent-start', 'no session_id or agent_id — nothing to register')
      process.exit(0)
      return
    }
    const dbPath = resolveDbPath(cwd)
    db = openHookDb(dbPath)
    if (!hasRegistry(db)) {
      dbg('hook:subagent-start', 'no session registry in this store — subagent left unregistered', { dbPath })
    } else {
      const self = selfOf(db, sessionId)
      const where: GitSelf = self
        ? { worktree: self.worktree, branch: self.branch, cwd: cwd ?? self.cwd ?? process.cwd(), toplevel: self.toplevel, commonDir: self.commonDir }
        : gitSelfOf(cwd ?? process.cwd())
      registerSubagent(db, sessionId, agentId, agentType ?? null, where, Date.now() / 1000)
      dbg('hook:subagent-start', 'registered', { sessionId, agentId, agentType: agentType ?? null })
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook] subagent-start error: ${error.message}`)
  } finally {
    if (db) db.close()
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
