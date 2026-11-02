import { basename, dirname } from 'node:path'
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { isBusyError } from '../persistence/node-sqlite.js'
import { parseHookInput, resolveDbPath, normalizeSource, buildRehydrationPayload, openHookDb, isDirectInvocation, HOOK_STARTED_AT } from './shared.js'
import { dbg } from '../debug.js'
import { writeSessionBeacon } from '../session-beacon.js'
import { readSessionBeacon } from '../session-beacon.js'
import { buildClearPacket, localDateOf, markNudged, recordSessionLink, sessionChain, selfLines, CHAPTER_HOWTO } from '../checkpoints.js'
import { hasRegistry, registerSelf, retireAllSubagents, type GitSelf } from '../persistence/session-registry.js'
import { retirePhantoms, NOTICED_BY_SESSION_START } from '../persistence/leg-registry.js'
import { gitSelfOf } from './git-self.js'
import { hookStoreOn, hookTreeOf } from './hook-store.js'
import { recordHookGap } from './gap-ledger.js'
import { ticketTextIn, readTicket, trustedWorkerLane } from '../ticket.js'
import { hasLegColumns, legOf, linkClientSession, workerOfSession, recordWorkerProcess, WORKER_AGENT_ID, LINKED_BY_SESSION_START, type LegRegistration } from '../persistence/leg-registry.js'
import { hostProbe } from '../persistence/process-probe.js'
import { composeFirstMessage, fitHookCap, invalidInstructionsMessage, firstMomentFactsOf } from '../first-moment.js'

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
  return isBusyError(err)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The context a `claude -p` child opens on when the ticket door that
 *  spawned it already handed it its first message as its prompt (D298:
 *  "the worker's first moment is its prompt"): who it is and where that
 *  first moment is kept, never the first moment a second time (D295's
 *  road not taken: the first moment spent twice). */
export function workerIdentityLine(leg: LegRegistration, firstMomentId: string | null): string {
  const keyed = leg.key !== null ? `, under the key "${leg.key}"` : ''
  return `treecontext: this session is the ${leg.role ?? 'unnamed'} worker${leg.run ? ` of the run "${leg.run}"` : ''}${keyed}, `
    + `in the lane of session ${leg.sessionId}, never this checkout's self. Your first message, your prompt, came from the ticket door`
    + `${firstMomentId ? ` and is kept as the first-moment row ${firstMomentId}` : ''}; no re-orientation packet follows.`
}

/**
 * D295: a session started with a ticket in its environment is a worker,
 * never a self: no beacon, no self registration, no /clear packet. The
 * ticket wins. When the ticket door that spawned this `claude -p` child
 * registered it already (its lane in the environment, honoured only when
 * the ticket matches that registration, ticket.ts trustedWorkerLane), the
 * child's own Claude Code session id is linked to that registration, so
 * the drain lands the child's captured rows in the worker's lane, and the
 * child is told who it is. With no wrapper, the hook is the ticket door:
 * it registers the child in its own session's lane under the parent the
 * ticket names, composes its first moment from the store, writes it as the
 * first row of that lane and injects it, under the client's cap (D325).
 * A ticket it cannot read whole registers the child with what was read and
 * tells it its instructions were invalid (D303, D342). Returns the hook's
 * output, or null when the store could not be written (the start is then
 * a capture gap).
 */
async function workerStart(db: DatabaseType, dbPath: string, sessionId: string, cwd: string | undefined, raw: string): Promise<{ additionalContext?: string; systemMessage: string }> {
  const at = Date.now() / 1000
  const lane = trustedWorkerLane(db)
  if (lane !== null) {
    const ref = { sessionId: lane, agentId: WORKER_AGENT_ID }
    linkClientSession(db, ref, sessionId, { linkedBy: LINKED_BY_SESSION_START, at })
    const leg = legOf(db, ref)!
    const first = db.prepare(
      "SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'first-moment' ORDER BY created_at, rowid LIMIT 1",
    ).get(lane) as { node_id: string } | undefined
    return {
      systemMessage: `treecontext: this session is the ${leg.role ?? 'unnamed'} worker of the lane ${lane}, read from its ticket.`,
      additionalContext: workerIdentityLine(leg, first?.node_id ?? null),
    }
  }
  const opened = await hookStoreOn(db, dbPath, sessionId, HOOK_STARTED_AT)
  if (!opened || 'refused' in opened) {
    // D265, D314: the worker's start is not lost silently.
    const why = opened ? opened.refused : 'its store predates workers (schema 31)'
    recordHookGap(dbPath, {
      hook: 'session-start', sessionId, at, error: why,
      lost: 'This session held a worker\'s ticket; no worker registration or first moment was recorded for it.',
    })
    return { systemMessage: `treecontext: this session holds a worker's ticket, but ${why}; it is journaled as no one's self, and the start is recorded as a capture gap.` }
  }
  const store = opened.store
  const allNamespaces = opened.namespace === null
  try {
    const reading = readTicket(raw)
    const ref = { sessionId, agentId: WORKER_AGENT_ID }
    const existing = workerOfSession(db, sessionId)
    let message: string
    if (existing === null) {
      const started = store.startWorker({
        reading, prompt: null, sessionId, door: 'ticket', where: gitSelfOf(cwd ?? process.cwd()), host: hostProbe.host(), at,
        hookDoor: { allNamespaces },
      })
      message = started.firstMessage
      // The client process this child runs as: the hook's parent (the
      // wrapper execs into node, as for the session beacon).
      const pid = process.ppid
      recordWorkerProcess(db, ref, { pid, start: hostProbe.startMoment(pid), token: hostProbe.startToken?.(pid) ?? null, host: hostProbe.host(), at })
    } else if (reading.valid && existing.run !== null) {
      // A resumed worker session: told again, from the store as it
      // stands, under the client's cap like any first moment (D325).
      const facts = firstMomentFactsOf(db, hookTreeOf(db, opened.namespace), {
        run: existing.run, key: existing.key, role: existing.role ?? 'unnamed', checkpointer: existing.checkpointer, checkpointedBy: existing.checkpointedBy, self: ref,
      })
      message = fitHookCap(facts, { compose: (o) => composeFirstMessage(facts, null, o) }).message
    } else {
      message = invalidInstructionsMessage(reading.absent, { role: reading.ticket.role, run: reading.ticket.run, key: reading.ticket.key })
    }
    linkClientSession(db, ref, sessionId, { linkedBy: LINKED_BY_SESSION_START, at })
    const leg = legOf(db, ref)
    return {
      systemMessage: `treecontext: this session is the ${leg?.role ?? 'unnamed'} worker${leg?.run ? ` of the run "${leg.run}"` : ''}, read from its ticket; it is no self of this checkout.`,
      additionalContext: message,
    }
  } finally {
    await store.close()
  }
}

function emit(out: { additionalContext?: string; systemMessage?: string }): void {
  const json: Record<string, unknown> = {}
  if (out.systemMessage) json['systemMessage'] = out.systemMessage
  if (out.additionalContext) {
    json['hookSpecificOutput'] = { hookEventName: 'SessionStart', additionalContext: out.additionalContext }
  }
  if (Object.keys(json).length > 0) process.stdout.write(JSON.stringify(json) + '\n')
}

export async function main(preParsed?: Record<string, unknown>): Promise<void> {
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

    // D295: the ticket wins. A session holding a worker's ticket writes no
    // beacon, registers no self and gets no packet.
    const ticket = ticketTextIn(process.env)
    if (ticket !== null) {
      let db: DatabaseType | null = null
      try {
        db = openHookDb(dbPath)
        if (!hasLegColumns(db)) {
          recordHookGap(dbPath, {
            hook: 'session-start', sessionId, at: Date.now() / 1000, error: 'its store predates workers (schema 31)',
            lost: 'This session held a worker\'s ticket; no worker registration or first moment was recorded for it.',
          })
          emit({ systemMessage: 'treecontext: this session holds a worker\'s ticket, but its store predates workers (schema 31); it is journaled as no one\'s self.' })
        } else {
          emit(await workerStart(db, dbPath, sessionId, cwd, ticket))
        }
      } catch (err) {
        dbg('hook:session-start', 'worker start FAILED — recorded as a capture gap', { error: messageOf(err) })
        recordHookGap(dbPath, {
          hook: 'session-start', sessionId, at: Date.now() / 1000, error: messageOf(err),
          lost: 'This session held a worker\'s ticket; no worker registration or first moment was recorded for it.',
        })
      } finally {
        if (db) db.close()
      }
      process.exit(0)
      return
    }
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

    // D297: the session-start hook reads the registry, so it is one of the
    // readers that retires a gone worker of this host as a phantom, with
    // the moment it noticed and itself as what noticed it. Best-effort: a
    // store without the leg columns has no workers to check.
    try {
      const pass = retirePhantoms(db, { noticedBy: NOTICED_BY_SESSION_START })
      if (pass.retired.length > 0) dbg('hook:session-start', 'retired phantom workers', { retired: pass.retired.length })
    } catch (err) {
      dbg('hook:session-start', 'phantom pass FAILED', { error: messageOf(err) })
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
        // D167, D373: a fresh start in a linked worktree or in the main
        // checkout re-orients on its own lane's thread (or the brief
        // addressed to it), told what other lanes exist. The self lines
        // sit outside the start's budget: a resume's budget would cut the
        // lane's own anchor.
        if (self) {
          try {
            const own = selfLines(db, self, Date.now() / 1000)
            if (own.length > 0) payload = `${own.join('\n')}\n${payload}`
          } catch (err) {
            dbg('hook:session-start', 'self lines read FAILED', { error: messageOf(err) })
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
if (isMain) void main()
