/**
 * SubagentStart hook: registers a live subagent under the session it was
 * spawned in (D190, D167, D150), and is the hooks door of a leg (D284,
 * D305, D314, D320, D325, D326, D327, D329, D332).
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
 * The hooks door: the payload names the subagent's role and never its
 * prompt (the Agent tool carries the prompt, D320), so the door reads the
 * briefs in effect for the role (D327: until a newer brief for the role
 * and key supersedes one, or its run closes):
 *  - none: a subagent exactly as today, registered, nothing emitted (D305);
 *  - one: a leg under that brief's run and key, marked inferred (D326),
 *    its checkpointer in both tenses, the checkpoint(s) in effect as its
 *    start (D329), its run opened at this first registration (D302, D354),
 *    and its first moment written as the first row of its lane and handed
 *    to it as this hook's context: the brief, the checkpoint(s) in effect
 *    with number, writer and moment, the flag, the recovery line, and
 *    treecontext's own line that a checkpoint is state, not history (D332),
 *    cut at the client's 10,000-character cap with the checkpoint row's id
 *    and the count left out (D325). No query is made on its behalf;
 *  - more than one: a leg whose key is ambiguous, the candidates named
 *    (D320), settled by its first write under a key.
 *
 * SubagentStart is context-only: it cannot decline a spawn. A store this
 * hook cannot write is a leg started cold (D314): nothing is injected, and
 * the dropped start goes to the gap ledger, which the drain turns into a
 * capture-gap row when the store is next written (gap-ledger.ts).
 *
 * The subagent inherits where its session runs: the session's registered
 * self when there is one, else what git reports for the payload's cwd. A
 * failure is logged and the hook exits 0 as every hook does.
 */
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { parseHookInput, resolveDbPath, openHookDb, isDirectInvocation, payloadWriter } from './shared.js'
import { gitSelfOf } from './git-self.js'
import { hookStoreOn, hookTreeOf, hookNamespaceOf } from './hook-store.js'
import { recordHookGap } from './gap-ledger.js'
import { hasRegistry, registerSubagent, selfOf, type GitSelf } from '../persistence/session-registry.js'
import { hookNowSec } from '../checkpoints.js'
import { hasLegColumns } from '../persistence/leg-registry.js'
import { briefsInEffect } from '../runs.js'
import { dbg } from '../debug.js'

/** The SubagentStart hook's output: its context, injected into the
 *  subagent at its start (Claude Code's hookSpecificOutput). */
export function subagentStartOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } }) + '\n'
}

/** What a dropped start lost, in the gap row's words (D314). */
export const DROPPED_START_LOST =
  'No registration, brief or first-moment row was recorded for it, so it started cold: whatever brief its role had in effect was never handed to it.'

/** What a start lost whose registration landed and whose leg facts and
 *  first moment did not. */
export const DROPPED_LEG_START_LOST =
  'It was registered as a subagent, but no leg facts, brief or first-moment row were recorded for it, so it started cold.'

export async function main(preParsed?: Record<string, unknown>): Promise<void> {
  await run(preParsed)
  process.exit(0)
}

async function run(preParsed?: Record<string, unknown>): Promise<void> {
  let db: DatabaseType | null = null
  try {
    const input = (preParsed ?? parseHookInput()) as Record<string, unknown>
    const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : undefined
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : undefined
    const { agentId, agentType } = payloadWriter(input)
    dbg('hook:subagent-start', 'invoked', { sessionId: sessionId ?? null, agentId: agentId ?? null, agentType: agentType ?? null })
    if (!sessionId || !agentId) {
      dbg('hook:subagent-start', 'no session_id or agent_id — nothing to register')
      return
    }
    const dbPath = resolveDbPath(cwd)
    const at = hookNowSec()
    let registered = false
    try {
      db = openHookDb(dbPath)
      if (!hasRegistry(db)) {
        dbg('hook:subagent-start', 'no session registry in this store — subagent left unregistered', { dbPath })
        return
      }
      const self = selfOf(db, sessionId)
      const where: GitSelf = self
        ? { worktree: self.worktree, branch: self.branch, cwd: cwd ?? self.cwd ?? process.cwd(), toplevel: self.toplevel, commonDir: self.commonDir }
        : gitSelfOf(cwd ?? process.cwd())
      registerSubagent(db, sessionId, agentId, agentType ?? null, where, at)
      registered = true
      dbg('hook:subagent-start', 'registered', { sessionId, agentId, agentType: agentType ?? null })
      if (!agentType || !hasLegColumns(db)) return
      // The hooks door: a role with a brief in effect makes the subagent a
      // leg (D305, D320). A store below 031 has no legs. The cheap read
      // first: a role with no brief in effect costs no journal open. The
      // briefs are the session's namespace's (D320 read with the
      // namespaces fence); every namespace's only when the session's
      // namespace does not resolve.
      const namespace = hookNamespaceOf(db, dbPath, sessionId)
      if (briefsInEffect(db, hookTreeOf(db, namespace), agentType).length === 0) return
      const opened = await hookStoreOn(db, dbPath, sessionId)
      if (!opened) return
      if ('refused' in opened) {
        // D265, D314: the start is not lost silently; the drain marks it.
        dbg('hook:subagent-start', 'leg start refused by the schema — recorded as a capture gap', { why: opened.refused })
        recordHookGap(dbPath, { hook: 'subagent-start', sessionId, agentId, agentType, at, error: opened.refused, lost: DROPPED_LEG_START_LOST })
        return
      }
      const store = opened.store
      try {
        const leg = store.startHooksLeg({ sessionId, agentId, role: agentType, at, where, allNamespaces: opened.namespace === null })
        if (leg) {
          dbg('hook:subagent-start', 'a leg', {
            run: leg.leg.run, key: leg.leg.key, keySrc: leg.leg.keySrc, firstMoment: leg.firstMomentId,
            chars: leg.message.length, cut: leg.cut !== null,
          })
          process.stdout.write(subagentStartOutput(leg.message))
        }
      } finally {
        await store.close()
      }
    } catch (err) {
      // D314: the leg starts as the platform decides; its start is dropped
      // and marked as a capture gap once the store takes writes again.
      const error = err instanceof Error ? err.message : String(err)
      dbg('hook:subagent-start', 'store write FAILED — start dropped to the gap ledger', { error })
      console.error(`[treecontext-hook] subagent-start: the store could not be written (${error}); the start is recorded as a capture gap`)
      recordHookGap(dbPath, { hook: 'subagent-start', sessionId, agentId, agentType: agentType ?? null, at, error, lost: registered ? DROPPED_LEG_START_LOST : DROPPED_START_LOST })
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook] subagent-start error: ${error.message}`)
  } finally {
    if (db) { try { db.close() } catch { /* closed */ } }
  }
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) void main()
