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
 *
 * The hooks door at a leg's end (D279, D280, D281, D284, D295, D326,
 * D334): a subagent registered as a leg (subagent-start.ts) whose key is
 * its own (it wrote under it) or declared, whose registration names its
 * own role as the checkpointer, with no checkpoint under its key newer
 * than its start, by anyone, and never sent back before by either door, is
 * sent back once: this hook blocks the stop and hands the subagent the
 * reason naming the missing checkpoint, its first moment composed again
 * from the store, and the pointer to its trail, as its next instruction,
 * and the send-back's row lands in its lane. Never a second time, never
 * when the store cannot be written, never for a key the door only
 * inferred (D326), never when the brief names another role (D281).
 * Otherwise the leg's report is its summary row, written by this door in
 * its lane stamped with its run and key (as the ticket door writes a
 * worker's), and the leg is retired. A subagent with no leg facts, or
 * whose start was dropped, stops as today, asked nothing (D305, D334). A
 * stop this hook cannot write goes to the gap ledger (gap-ledger.ts).
 */
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { parseHookInput, resolveDbPath, writeStaging, openHookDb, isDirectInvocation, payloadWriter, storeRefusesWrites, blockOutput, STOP_GUARD_TIMEOUT_MS } from './shared.js'
import { extractLastAssistantText } from './stop.js'
import { hookStoreOn, hookTreeOf } from './hook-store.js'
import { recordHookGap } from './gap-ledger.js'
import { legOf, hasLegColumns, isLiveLeg, legOwnsKey, capRefusalOf, retireLeg, settleLegKey, type LegRegistration, type LegRef } from '../persistence/leg-registry.js'
import { extractInsertEcho, isInsertEchoTool } from '../server/echo-correlation.js'
import { resolveStagedCapRefusals } from '../persistence/cap-refusals.js'
import { checkpointsUnder } from '../runs.js'
import {
  owesCheckpoint, composeSendBackMessage, composeFirstMessage, fitHookCap, laneRowsOf, firstMomentFactsOf, type FirstMomentFacts,
} from '../first-moment.js'
import { FIRST_MOMENT_KIND } from '../run-kinds.js'
import type { FlatStore } from '../flat-store.js'
import { hasRegistry, retireSubagent, subagentOf, INTERNAL_SUMMARY_KIND } from '../persistence/session-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../handoff.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'

/**
 * What this stop is, read once on the connection the hook writes with
 * (one busy wait under a lock, never a guard read stacked on the write's):
 *  - a live leg (leg facts on its registration), with whether a checkpoint
 *    under its key is newer than its start, by anyone;
 *  - else whether it is the client's own internal agent (D263): no agent
 *    type in the payload, and a registry that was read and holds no row
 *    for (session, agent id), live or retired. Anything less is no
 *    evidence and the report stays a subagent summary: mis-marking a real
 *    subagent's report would drop it from the handoff and the lanes
 *    silently, the worse error (D3, D238).
 */
export function atStopOn(db: DatabaseType, ref: LegRef | null, agentType: string | undefined): {
  leg: LegRegistration | null; checkpointSinceStart: boolean; internal: boolean
} {
  let leg: LegRegistration | null = null
  let checkpointSinceStart = false
  let internal = false
  try {
    if (ref && hasLegColumns(db)) {
      const l = legOf(db, ref)
      if (l && l.kind === 'subagent' && isLiveLeg(l)) {
        leg = l
        const since = l.startedAt
        checkpointSinceStart = l.run !== null && l.key !== null
          && checkpointsUnder(db, null, l.run, l.key).some((c) => !c.imported && c.createdAt >= since)
      }
    }
    if (!leg && ref && !agentType && hasRegistry(db)) internal = subagentOf(db, ref.sessionId, ref.agentId) === null
  } catch (err) {
    dbg('hook:subagent-stop', 'registration read FAILED — stops as a subagent, its report kept a subagent summary', { error: err instanceof Error ? err.message : String(err) })
  }
  return { leg, checkpointSinceStart, internal }
}

function retire(db: DatabaseType, sessionId: string, agentId: string, at: number): void {
  if (!hasRegistry(db)) return
  // A leg falls here only when the door could not write its stop: it is
  // retired as finished all the same.
  if (hasLegColumns(db) && legOf(db, { sessionId, agentId })?.kind === 'subagent') {
    retireLeg(db, { sessionId, agentId }, 'retired', at)
    return
  }
  const retired = retireSubagent(db, sessionId, agentId, at)
  dbg('hook:subagent-stop', retired ? 'retired' : 'no live registration to retire', { sessionId, agentId })
}

/**
 * D320, D326: the leg's own writes under a key settle its key at their
 * echo, which the drain reads; a leg can stop before the drain has run.
 * The echoes are already staged, each with the caller's own agent fields
 * from its PostToolUse payload, exact evidence of who wrote: this hook
 * settles the key from them as the drain's heal would (writer-heal.ts),
 * so the stop asks, and the summary row and the pointer carry the key, by
 * the same rule whichever runs first. Never from a row's text alone.
 */
export function settleFromStagedEchoes(db: DatabaseType, ref: LegRef): number {
  const rows = db.prepare(
    `SELECT content, tool_name, preview_len FROM staging WHERE session_id = ? AND agent_id = ? AND tool_name LIKE '%treecontext_insert' ORDER BY id`,
  ).all(ref.sessionId, ref.agentId) as Array<{ content: string; tool_name: string; preview_len: number | null }>
  let settled = 0
  for (const r of rows) {
    if (!isInsertEchoTool(r.tool_name)) continue
    const echo = extractInsertEcho(r.content, r.preview_len)
    if (!echo) continue
    const node = db.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(echo.nodeId) as { metadata_json: string | null } | undefined
    if (!node?.metadata_json) continue
    const m = JSON.parse(node.metadata_json) as Record<string, unknown>
    if (typeof m['run'] === 'string' && typeof m['key'] === 'string' && m['key'].trim() !== '' && settleLegKey(db, ref, m['run'], m['key'], echo.nodeId)) settled++
  }
  return settled
}

/** The send-back decision at a hooks-door leg's stop (D279, D280, D281,
 *  D295, D326): only a key the leg made its own (or one declared), a
 *  registration naming its own role as the checkpointer, no checkpoint
 *  under the key newer than its start by anyone, and no send-back before
 *  by either door. The store's writability is asked separately. */
export function owesSendBack(leg: LegRegistration, checkpointSinceStart: boolean): boolean {
  return leg.run !== null && leg.key !== null && legOwnsKey(leg)
    && owesCheckpoint(leg) && leg.sendBacks < 1 && !checkpointSinceStart
}

/** The send-back message a hooks-door leg is handed (D279, D332, D335):
 *  the reason, its first moment composed again from the store as it now
 *  stands, the pointer to its trail; under the client's cap, the
 *  checkpoint cut with its row id as at the start (D325). */
export function hooksSendBackMessage(o: { facts: FirstMomentFacts; ref: LegRef; firstMomentId: string | null; rows: number; capRefused?: { size: number } | null }): string {
  const compose = (opts: Parameters<typeof composeFirstMessage>[2]): string => composeSendBackMessage({
    facts: o.facts, prompt: null, sessionId: o.ref.sessionId, agentId: o.ref.agentId, firstMomentId: o.firstMomentId, rows: o.rows, capRefused: o.capRefused ?? null,
    firstMessage: composeFirstMessage(o.facts, null, { door: 'hooks', keyOwn: true, ...opts }),
  })
  return fitHookCap(o.facts, { compose }).message
}

/** Send the leg back once, through the hook's connection: count it and
 *  write its row in the leg's lane in one transaction (refused when either
 *  door spent the leg's one send-back first), with the message composed
 *  from the store as it stands. Null when nothing was sent. */
async function sendBack(store: FlatStore, db: DatabaseType, ref: LegRef, leg: LegRegistration, at: number, scope: number | null): Promise<string | null> {
  const facts = firstMomentFactsOf(db, scope, {
    run: leg.run!, key: leg.key, role: leg.role ?? 'unnamed', checkpointer: leg.checkpointer, checkpointedBy: leg.checkpointedBy, self: ref,
  })
  const first = db.prepare(
    `SELECT node_id FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?
        AND json_extract(metadata_json, '$.kind') = ? ORDER BY created_at, rowid LIMIT 1`,
  ).get(ref.sessionId, ref.agentId, FIRST_MOMENT_KIND) as { node_id: string } | undefined
  const message = hooksSendBackMessage({ facts, ref, firstMomentId: first?.node_id ?? null, rows: laneRowsOf(db, leg), capRefused: capRefusalOf(leg) })
  const sent = store.recordWorkerSendBack(ref, {
    message, refs: [...(first ? [first.node_id] : []), ...facts.checkpoints.map((c) => c.nodeId)], at, door: 'hooks',
  })
  return sent ? message : null
}

export async function main(preParsed?: Record<string, unknown>): Promise<void> {
  await run(preParsed)
  process.exit(0)
}

/** What a leg's stop could not record, in the gap row's words: only what
 *  failed (the send-back, or the summary row and the retirement). */
const STOP_LOST = {
  sendBack: 'It was owed its one send-back for the missing checkpoint and was not sent back.',
  retire: 'Its summary row and its retirement were not recorded, so it reads as live until its session next starts. Its report is kept below as far as the prefix reaches.',
  open: 'Nothing of its stop was recorded: the store could not be opened for writing.',
} as const

async function run(preParsed?: Record<string, unknown>): Promise<void> {
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
    const content = report ? report.substring(0, STORE_SAFETY_CAP) : null

    const dbPath = resolveDbPath(cwd)
    const at = Date.now() / 1000
    const ref = sessionId && agentId ? { sessionId, agentId } : null

    // The guard read, once, on its own budget (STOP_GUARD_TIMEOUT_MS): the
    // leg and the internal-agent evidence together, so a locked store
    // costs one guard wait and then the write's, never more (D163's sum).
    // A lookup that cannot read the store in that budget is no evidence:
    // the stop is a subagent's and the report a subagent summary (D263).
    let stop: ReturnType<typeof atStopOn> = { leg: null, checkpointSinceStart: false, internal: false }
    if (ref) {
      let guard: DatabaseType | null = null
      try {
        guard = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
        guard.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
        stop = atStopOn(guard, ref, agentType)
      } catch (err) {
        dbg('hook:subagent-stop', 'registration lookup FAILED — kept as a subagent summary', { error: err instanceof Error ? err.message : String(err) })
      } finally { if (guard) guard.close() }
    }
    const internal = stop.internal
    let legStopped = false
    if (ref && stop.leg) {
      let db: DatabaseType | null = null
      try { db = openHookDb(dbPath) } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        dbg('hook:subagent-stop', 'store open FAILED — recorded as a capture gap', { error })
        recordHookGap(dbPath, { hook: 'subagent-stop', sessionId: ref.sessionId, agentId: ref.agentId, agentType: agentType ?? null, at, error, lost: STOP_LOST.open, text: content })
        return
      }
      try {
        legStopped = await legStop(db, dbPath, ref, stop.leg, stop.checkpointSinceStart, { input, content, at, agentType })
      } finally {
        db.close()
      }
    }
    if (legStopped) return

    // A subagent exactly as today (D305), one whose start was dropped
    // (D334), a leg the hook may not write as the journal, or the client's
    // own internal agent (D263): its report staged, its registration
    // retired (a leg's as finished).
    const andRetire = ref ? (w: DatabaseType) => retire(w, ref.sessionId, ref.agentId, at) : undefined
    let retired = false
    if (content) {
      dbg('hook:subagent-stop', internal ? 'unregistered and untyped — the client\'s own internal agent' : 'a subagent\'s report', { agentId: agentId ?? null })
      writeStaging(dbPath, {
        sessionId: sessionId ?? null,
        role: 'assistant',
        content,
        timestamp: at,
        priority: 1,
        indexLen: Math.min(activeIndexCap('assistant'), content.length),
        ...(agentId ? { agentId } : {}),
        ...(agentType ? { agentType } : {}),
        kind: internal ? INTERNAL_SUMMARY_KIND : SUBAGENT_SUMMARY_KIND,
      }, andRetire ? (w) => { andRetire(w); retired = true } : undefined)
    } else {
      dbg('hook:subagent-stop', 'no report in the payload or the transcript — nothing to capture')
    }
    // With no report there was no staging write to retire on; a staging
    // write that failed recorded its gap, and its retirement waits for the
    // session's next start (one budget per stop, never a second).
    if (andRetire && !retired && !content) {
      let w: DatabaseType | null = null
      try { w = openHookDb(dbPath); andRetire(w) } catch (err) {
        dbg('hook:subagent-stop', 'retire FAILED', { error: err instanceof Error ? err.message : String(err) })
      } finally { if (w) w.close() }
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook] subagent-stop error: ${error.message}`)
  }
}

/**
 * A leg's stop at the hooks door, on the hook's one connection. Returns
 * true when the stop was handled here (sent back, retired with its return,
 * or recorded as a gap), false when it falls to the plain path: a leg with
 * no run of its own (an ambiguous key across runs), or a store the hook
 * may not write as the journal (its schema skew recorded as a gap when a
 * send-back was owed).
 */
async function legStop(
  db: DatabaseType, dbPath: string, ref: LegRef, legAtStart: LegRegistration, checkpointSinceStart: boolean,
  o: { input: Record<string, unknown>; content: string | null; at: number; agentType: string | undefined },
): Promise<boolean> {
  let leg = legAtStart
  // What failed, each named once in the one gap row this stop leaves.
  const lost: Array<keyof typeof STOP_LOST> = []
  const errors: string[] = []
  const gap = (): void => {
    recordHookGap(dbPath, {
      hook: 'subagent-stop', sessionId: ref.sessionId, agentId: ref.agentId, agentType: o.agentType ?? null, at: o.at,
      error: errors.join('; '), lost: lost.map((k) => STOP_LOST[k]).join(' '), text: o.content,
    })
  }
  let store: FlatStore | null = null
  let stage: keyof typeof STOP_LOST = 'retire'
  // A store that refuses writes is asked of the filesystem first (D163):
  // the send-back it would have owed is named before anything is tried.
  const refusedAtStop = storeRefusesWrites(dbPath)
  if (refusedAtStop !== null && owesSendBack(leg, checkpointSinceStart) && o.input['stop_hook_active'] !== true) {
    lost.push('sendBack')
    errors.push(refusedAtStop)
  }
  try {
    const opened = await hookStoreOn(db, dbPath, ref.sessionId)
    if (!opened || 'refused' in opened) {
      if (opened && owesSendBack(leg, checkpointSinceStart) && !lost.includes('sendBack')) { lost.push('sendBack'); errors.push(opened.refused) }
      if (lost.length > 0) gap()
      return false
    }
    store = opened.store
    const scope = hookTreeOf(db, opened.namespace)
    // D359: a refusal made while the writer stamp was not exact sits pending
    // until a call's echo names the writer; the leg's own staged echoes
    // (and the session's) are read here as the drain would, so a leg refused
    // at the cap is known to be, and its key is its own, before the ask.
    const capMoved = resolveStagedCapRefusals(db, ref.sessionId)
    if (settleFromStagedEchoes(db, ref) > 0 || capMoved > 0) {
      leg = legOf(db, ref) ?? leg
      // D302: a settle that named the run opens it, as a registration does.
      store.openRunOfLeg(ref)
    }
    const owed = owesSendBack(leg, checkpointSinceStart) && o.input['stop_hook_active'] !== true
    const refusal = owed ? storeRefusesWrites(dbPath) : null
    if (owed && refusal !== null) {
      if (!lost.includes('sendBack')) { lost.push('sendBack'); errors.push(refusal) }
    } else if (owed) {
      stage = 'sendBack'
      const message = await sendBack(store, db, ref, leg, o.at, scope)
      if (message !== null) {
        // What the subagent said at this stop is captured as its turn,
        // not as its return: it is not done.
        if (o.content) {
          writeStaging(dbPath, {
            sessionId: ref.sessionId, role: 'assistant', content: o.content, timestamp: o.at, priority: 1,
            indexLen: Math.min(activeIndexCap('assistant'), o.content.length), agentId: ref.agentId, ...(o.agentType ? { agentType: o.agentType } : {}),
          })
        }
        dbg('hook:subagent-stop', 'sent back once for the missing checkpoint', { run: leg.run, key: leg.key })
        process.stdout.write(blockOutput(message))
        return true
      }
    }
    if (leg.run === null) {
      if (lost.length > 0) gap()
      return false
    }
    stage = 'retire'
    const r = store.retireHooksLeg(ref, { report: o.content, at: o.at })
    dbg('hook:subagent-stop', 'leg retired with its return', { summary: r.summaryId })
    if (lost.length > 0) gap()
    return true
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    dbg('hook:subagent-stop', 'leg stop write FAILED — recorded as a capture gap', { error, stage })
    if (!lost.includes(stage)) lost.push(stage)
    if (!errors.includes(error)) errors.push(error)
    gap()
    return true
  } finally {
    if (store) await store.close()
  }
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) void main()
