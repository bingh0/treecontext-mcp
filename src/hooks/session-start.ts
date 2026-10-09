import { basename, dirname } from 'node:path'
import type { Database as DatabaseType } from 'better-sqlite3'
import { parseHookInput, resolveDbPath, normalizeSource, buildRehydrationPayload, openHookDb, isDirectInvocation } from './shared.js'
import { dbg } from '../debug.js'
import { writeSessionBeacon } from '../session-beacon.js'
import { readSessionBeacon } from '../session-beacon.js'
import { buildClearPacket, localDateOf, markNudged, recordSessionLink, sessionChain, worktreeSelfLines, CHAPTER_HOWTO } from '../checkpoints.js'
import { hasRegistry, registerSelf, retireAllSubagents, type GitSelf } from '../persistence/session-registry.js'
import { gitSelfOf } from './git-self.js'

/** The packet when the session before this clear cannot be identified. */
export const UNKNOWN_PREDECESSOR =
  'treecontext could not tell which session this clear continues: no session beacon named the session before it, '
  + 'so this packet cannot show your chapter summary, bookmark or recent turns. Search the journal for them '
  + '(treecontext_query "chapter summary" or status for the live pointers) rather than assuming none exist.\n'
  + CHAPTER_HOWTO

/** The busy budget for the /clear packet's reads. The developer's next
 *  prompt waits on this hook, so a store held by another process costs at
 *  most this long before the packet says what it could not read (D175) —
 *  well inside every platform's hook budget. */
export const CLEAR_READ_TIMEOUT_MS = 1500

function isLocked(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || (err instanceof Error && /database is locked|database table is locked/i.test(err.message))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emit(out: { additionalContext?: string; systemMessage?: string }): void {
  const json: Record<string, unknown> = {}
  if (out.systemMessage) json['systemMessage'] = out.systemMessage
  if (out.additionalContext) {
    json['hookSpecificOutput'] = { hookEventName: 'SessionStart', additionalContext: out.additionalContext }
  }
  if (Object.keys(json).length > 0) process.stdout.write(JSON.stringify(json) + '\n')
}

export function main(preParsed?: Record<string, unknown>) {
  try {
    const input = preParsed ?? parseHookInput()
    const sessionId = input.session_id
    const cwd = input.cwd

    dbg('hook:session-start', 'invoked', { sessionId: sessionId ?? null, cwd: cwd ?? null, source: input.source ?? null })

    if (!sessionId) {
      dbg('hook:session-start', 'no session_id — skipping')
      process.exit(0)
      return
    }

    const source = normalizeSource(input.source)
    const dbPath = resolveDbPath(cwd)
    // The store's name is its directory under the stores root.
    const storeName = basename(dirname(dbPath))
    dbg('hook:session-start', 'opening db', { source, dbPath })

    // Session-identity fix (docs/session-identity.md §3,
    // ladder rung 1 "pid"): the hook wrapper `exec`s into this node process
    // (see installer.ts hookScriptContent), so process.ppid IS the claude
    // process's own PID. Always rewrite on SessionStart — a resume fires
    // this hook again with a new session id for the same pid, and the
    // beacon must track the CURRENT session.
    // D216: a /clear mints a NEW session id, so before the beacon is
    // rewritten it still names the session this clear continues — the
    // only place that link exists. Read it first.
    let predecessor: string | null = null
    if (source === 'clear') {
      try {
        const prior = readSessionBeacon(dbPath, process.ppid)
        if (prior && prior.cc_session_id !== sessionId) predecessor = prior.cc_session_id
      } catch (err) {
        dbg('hook:session-start', 'beacon read FAILED', { error: messageOf(err) })
      }
    }

    try {
      writeSessionBeacon(dbPath, process.ppid, sessionId, cwd ?? process.cwd(), { rewrite: true })
      dbg('hook:session-start', 'beacon written', { pid: process.ppid, sessionId })
    } catch (err) {
      dbg('hook:session-start', 'beacon write FAILED', { error: messageOf(err) })
    }

    let db: DatabaseType
    try {
      db = openHookDb(dbPath, source === 'clear' ? { timeoutMs: CLEAR_READ_TIMEOUT_MS } : undefined)
    } catch (err) {
      // D171 and D175: the sign says so when the session is not being
      // journaled, and a /clear's packet says what it could not read.
      const locked = isLocked(err)
      const why = locked ? `the store is locked by another process (${messageOf(err)})` : messageOf(err)
      dbg('hook:session-start', 'store open FAILED', { error: messageOf(err), locked })
      emit({
        systemMessage: locked
          ? `treecontext: store "${storeName}" is locked by another process, so this session's journal could not be read just now — run \`treecontext doctor\`.`
          : `treecontext: this session is NOT being journaled — the store at ${dbPath} cannot be opened: ${why}. Run \`treecontext doctor\`.`,
        ...(source === 'clear'
          ? { additionalContext: `treecontext could not read this session's journal after the clear: ${why}. No chapter summary, bookmark or recent developer turn was read; re-orient from the conversation, and run \`treecontext doctor\` to see what holds the store.` }
          : {}),
      })
      process.exit(0)
      return
    }

    // D190: register the session's self, as git reports it for the
    // payload's directory, under the session id the hook already carries —
    // on every start, so a resume or a clear's new id is registered too.
    // The server stamps every tool-written row from this. Best-effort: a
    // store the ladder has not reached (no registry) or a busy one leaves
    // the session unregistered, which the server stamps as such.
    let self: GitSelf | null = null
    try {
      self = gitSelfOf(cwd ?? process.cwd())
      if (hasRegistry(db)) {
        const at = Date.now() / 1000
        self = { ...self, worktree: registerSelf(db, sessionId, self, at) }
        // F3: no subagent survives its session's (re)start. A startup,
        // resume or clear retires every subagent still registered live
        // under this id (and, on a clear, under the id it continues), so
        // a SubagentStop lost to a crash cannot hold the stamp. A compact
        // runs mid-session beside a working subagent and retires none.
        if (source !== 'compact') {
          for (const id of predecessor ? [sessionId, predecessor] : [sessionId]) {
            const n = retireAllSubagents(db, id, at)
            if (n > 0) dbg('hook:session-start', 'retired subagents left live', { session: id, retired: n })
          }
        }
      }
      else dbg('hook:session-start', 'no session registry in this store — session left unregistered', { dbPath })
    } catch (err) {
      dbg('hook:session-start', 'self registration FAILED', { error: messageOf(err) })
    }

    try {
      const sign = `treecontext: this session journals into store "${storeName}" (${dbPath}).`
      let payload: string
      if (source === 'clear') {
        try {
          const now = new Date()
          const localDate = localDateOf(now)
          if (predecessor) {
            try { recordSessionLink(db, sessionId, predecessor) } catch (err) {
              dbg('hook:session-start', 'session link write FAILED — chain read from the beacon alone', { error: messageOf(err) })
            }
          }
          let chain = sessionChain(db, sessionId)
          if (predecessor && !chain.includes(predecessor)) chain = [sessionId, ...sessionChain(db, predecessor)]
          if (chain.length === 1) {
            // No predecessor: the beacon was absent or already named this
            // id. Say so; never claim the session has no checkpoint (D216).
            payload = UNKNOWN_PREDECESSOR
          } else {
            const packet = buildClearPacket(db, chain, now.getTime() / 1000, localDate)
            if (packet.nudged) {
              try { markNudged(db, chain, localDate) } catch (err) {
                dbg('hook:session-start', 'nudge mark FAILED — the nudge repeats', { error: messageOf(err) })
              }
            }
            payload = packet.text
          }
        } catch (err) {
          const why = isLocked(err) ? `the store is locked by another process (${messageOf(err)})` : messageOf(err)
          payload = `treecontext could not read this session's journal after the clear: ${why}. No chapter summary, bookmark or recent developer turn was read; re-orient from the conversation, and run \`treecontext doctor\`.`
        }
      } else {
        payload = buildRehydrationPayload(db, sessionId, source, dbPath)
        // D167: a fresh start in a linked worktree re-orients on that
        // worktree's own thread, or on the brief addressed to it.
        if (self?.worktree) {
          try {
            const own = worktreeSelfLines(db, self, Date.now() / 1000)
            if (own.length > 0) payload = `${own.join('\n')}\n${payload}`
          } catch (err) {
            dbg('hook:session-start', 'worktree self read FAILED', { error: messageOf(err) })
          }
        }
      }
      emit({ systemMessage: sign, additionalContext: payload })

      dbg('hook:session-start', 'complete', { source, payloadChars: payload.length })
      console.error(`[treecontext-hook] session-start: source=${source}, payload=${payload.length} chars`)
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof Error) {
      dbg('hook:session-start', 'ERROR', { error: error.message })
      console.error(`[treecontext-hook] session-start error: ${error.message}`)
    }
  }
  process.exit(0)
}


const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
