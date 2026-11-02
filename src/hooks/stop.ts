/**
 * Stop hook (C4): captures the assistant's final response of a turn.
 *
 * Before this hook existed, assistant prose was never captured at all (only
 * user messages and tool-event previews were staged), so the journal indexed
 * fragments of a conversation rather than its conclusions. Claude Code fires
 * `Stop` once per turn. The turn's text is the payload's own
 * `last_assistant_message` when it carries one (D249): at Stop time the
 * session transcript does not yet hold the turn that just ended, so
 * reading `transcript_path` captured the PREVIOUS turn's text and the
 * session's final answer never at all (live probe, Claude Code 2.1.293
 * headless, 2026-10-08 — every Stop row of five runs held the prior
 * turn). Only a payload without the field (an older platform) falls back
 * to the transcript, extracting its last assistant TEXT content block
 * (never a tool_use block). Either way the text is staged with role
 * 'assistant' and no `tool_name` — the same (role, tool_name) shape
 * `indexTextFor` (C2) already uses to distinguish real assistant prose from
 * a post-tool-use preview, and the shape `ingestion.ts` uses to attach the
 * `event: "response"` metadata marker.
 *
 * Repeated Stop fires for the same turn (or a Stop with no new text) stage
 * identical content; FlatStore's existing content-fingerprint dedup (see
 * flat-store.ts `insert`) is what prevents double-capture, not this hook.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { resolveDbPath, writeStaging, parseHookInput, isDirectInvocation, openHookDb, STOP_GUARD_TIMEOUT_MS, storeRefusesWrites, blockOutput, HOOK_STARTED_AT } from './shared.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'
import { checkpointDue, bookmarkRequest, markBookmarkAsked, hookNowSec, type CheckpointDue } from '../checkpoints.js'
import { workerLaneOf, capRefusalOf, type LegRegistration, type LegRef } from '../persistence/leg-registry.js'
import { checkpointsUnder } from '../runs.js'
import { sendBackDecision } from '../ticket-door.js'
import { composeSendBackMessage, composeFirstMessage, fitHookCap, laneRowsOf, firstMomentFactsOf } from '../first-moment.js'
import { WORKER_SESSION_ENV } from '../ticket.js'
import { FIRST_MOMENT_KIND } from '../run-kinds.js'
import { decodeContent } from '../persistence/content-codec.js'
import { hookStoreOn, hookTreeOf } from './hook-store.js'
import { recordHookGap } from './gap-ledger.js'

/**
 * Stale-recapture guard: `extractLastAssistantText` deliberately scans past
 * text-free turns (pure tool runs, interrupts) to an EARLIER turn's text,
 * and a re-fired payload's `last_assistant_message` repeats the text it
 * carried before; the guard compares whichever source supplied the text
 * (D249). Since D2 shrank the store-side dedup from global to a 300s capture-time
 * window, a re-fire more than 300s later would insert a duplicate node
 * asserting the assistant said the same thing at a new timestamp. Compare
 * against the newest staged assistant response for this session (processed
 * or not — processed rows are retained ~24h) and skip identical content.
 * Best-effort: any error means "not a duplicate".
 */
export function isStaleRecapture(dbPath: string, sessionId: string | undefined, text: string): boolean {
  if (!sessionId) return false
  let db: DatabaseSync | null = null
  try {
    // Through the one opener, at the GUARD budget: this hook opens the
    // store twice (this guard, then writeStaging's write), and the
    // two busy budgets sum against the platform's 10s kill — the full
    // write budget here made the worst case 16s, converting a duplicate-capture
    // risk into total capture loss (pass-2 review 2026-08-15).
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    return staleOn(db, sessionId, text)
  } catch {
    return false
  } finally {
    if (db) db.close()
  }
}

function staleOn(db: DatabaseSync, sessionId: string, text: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT content FROM staging
         WHERE session_id = ? AND role = 'assistant' AND tool_name IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { content: string } | undefined
    return row !== undefined && row.content === text
  } catch {
    return false
  }
}

/** The guard read, once: the stale-recapture check and the checkpoint
 *  check share ONE read-only open at the guard budget, so the second duty
 *  adds no term to the guard+write sum the platform kill budget pins. */
function guardRead(
  dbPath: string, sessionId: string, text: string | null, checkpoint: boolean,
): { stale: boolean; due: CheckpointDue | null; worker: WorkerAtStop | null } {
  let db: DatabaseSync | null = null
  try {
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    // One busy wait for the whole guard: a store another process holds
    // answers this probe after the guard's budget, and then no further
    // read is tried (each would wait the budget again: the guard's reads
    // must never stack past the platform's kill with the write behind).
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
    const stale = text !== null && staleOn(db, sessionId, text)
    // A worker's stop (D295) is read on the same guard connection, so a
    // locked store costs the worker read no wait of its own.
    const worker = workerAtStopOn(db, sessionId)
    let due: CheckpointDue | null = null
    if (checkpoint && worker === null) {
      try { due = checkpointDue(db, sessionId, hookNowSec()) } catch (err) {
        // A store too old for the checkpoint reads (no nodes, no
        // session_key): no bookmark is asked for, capture goes on.
        dbg('hook:stop', 'checkpoint check skipped', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { stale, due, worker }
  } catch {
    return { stale: false, due: null, worker: null }
  } finally {
    if (db) db.close()
  }
}

/** True the first time this session reports an unwritable bookmark: an
 *  exclusive-create of a mark file in the temp directory, keyed by the
 *  payload's session id. */
function firstReport(sessionId: string): boolean {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  try {
    writeFileSync(join(tmpdir(), `treecontext-bookmark-unwritable-${safe}`), String(Date.now()), { flag: 'wx', mode: 0o600 })
    return true
  } catch (err) {
    // Already reported, or a temp directory that takes no files — in the
    // second case silence is the lesser failure than a report every stop.
    void err
    return false
  }
}

interface TranscriptContentBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface TranscriptEntry {
  type?: string
  message?: {
    role?: string
    content?: TranscriptContentBlock[] | string
  }
}

/**
 * Scan a Claude Code JSONL transcript backward for the last assistant TEXT
 * content block. Tool_use blocks (and any other block type) are skipped;
 * scanning continues past assistant entries whose content is text-free
 * (e.g. a pure tool-call turn) until a text block or the start of the file
 * is reached. Returns null if the file is unreadable, empty, or contains no
 * assistant text at all.
 */
export function extractLastAssistantText(transcriptPath: string): string | null {
  for (const content of assistantContentsNewestFirst(transcriptPath)) {
    if (typeof content === 'string') {
      if (content.trim()) return content
      continue
    }
    if (!Array.isArray(content)) continue

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text
      }
    }
  }
  return null
}

/** The client's hand-back tool: on Claude Code 2.1.271 and later, in auto
 *  mode, a subagent delivers its report through a `SubagentHandback` tool
 *  call "rather than returning it as text" (hooks reference, read
 *  2026-11-02); SubagentStop's `last_assistant_message` then holds its
 *  closing text, if any, which is not the report. */
export const HANDBACK_TOOL = 'SubagentHandback'

/**
 * The report a subagent handed back through the client's tool in the
 * finish just ended: the `message` of the newest `SubagentHandback` call
 * after the newest prompting user turn (a user entry that is not a tool
 * result: the prompt, or the message that resumed the subagent), or null
 * when that finish made none, its message is blank, or the file is
 * unreadable. The scan stops at that turn: a subagent resumed and
 * finished again with text alone must not be summarised by the hand-back
 * of its earlier finish (review of 2026-11-02). The newest call within
 * the finish, because a hand-back a hook denied is made again.
 */
export function extractHandbackReport(transcriptPath: string): string | null {
  for (const entry of entriesNewestFirst(transcriptPath)) {
    const content = entry.message?.content
    if (entry.type === 'user' || entry.message?.role === 'user') {
      if (isPromptingTurn(content)) return null
      continue
    }
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (block?.type !== 'tool_use' || block.name !== HANDBACK_TOOL) continue
      const message = block.input?.['message']
      return typeof message === 'string' && message.trim() ? message : null
    }
  }
  return null
}

/** A user entry that prompts the subagent (its task, or the message
 *  that resumed it) rather than carrying a tool's result back. */
function isPromptingTurn(content: TranscriptContentBlock[] | string | undefined): boolean {
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some((b) => b?.type !== 'tool_result')
}

/** Each assistant entry's content in the transcript, newest first; an
 *  unreadable file or a line that is not JSON yields nothing for it. */
function* assistantContentsNewestFirst(transcriptPath: string): Generator<TranscriptContentBlock[] | string | undefined> {
  for (const entry of entriesNewestFirst(transcriptPath)) {
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue
    yield entry.message?.content
  }
}

/** The transcript's JSONL entries, newest first; an unreadable file
 *  yields nothing and a line that is not JSON is skipped. */
function* entriesNewestFirst(transcriptPath: string): Generator<TranscriptEntry> {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    yield entry
  }
}

/**
 * The turn's text and where it came from (D249). The payload's
 * `last_assistant_message`, when it is a non-blank string, is the turn
 * that just ended; the transcript is read only when the payload carries
 * no such field (or a blank one), because at Stop time the transcript
 * still ends at the previous turn.
 */
export function turnText(input: Record<string, unknown>): { text: string; source: 'payload' | 'transcript' } | null {
  const fromPayload = input['last_assistant_message']
  if (typeof fromPayload === 'string' && fromPayload.trim() !== '') return { text: fromPayload, source: 'payload' }
  const transcript = input['transcript_path']
  if (typeof transcript !== 'string' || transcript === '') return null
  const fromTranscript = extractLastAssistantText(transcript)
  return fromTranscript ? { text: fromTranscript, source: 'transcript' } : null
}

type WorkerAtStop = { leg: LegRegistration; checkpointSinceStart: boolean; prompt: string | null; firstMomentId: string | null }

/** The worker a `claude -p` child's session is (D295): its own lane, or
 *  the lane its session-start hook linked it to, with whether a checkpoint
 *  under its key is newer than its start; null for any session that is no
 *  worker. Read on the guard's connection. */
function workerAtStopOn(db: DatabaseSync, sessionId: string): WorkerAtStop | null {
  try {
    const leg = workerLaneOf(db, sessionId)
    if (!leg) return null
    const since = leg.startedAt
    const checkpointSinceStart = leg.run !== null && leg.key !== null
      && checkpointsUnder(db, null, leg.run, leg.key).some((c) => !c.imported && c.createdAt >= since)
    const first = db.prepare(
      `SELECT node_id, content FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = ? ORDER BY created_at, rowid LIMIT 1`,
    ).get(leg.sessionId, FIRST_MOMENT_KIND) as { node_id: string; content: string | Buffer } | undefined
    return { leg, checkpointSinceStart, prompt: first ? decodeContent(first.content) : null, firstMomentId: first?.node_id ?? null }
  } catch {
    return null
  }
}

/** D303, D342: the line a worker with no valid instructions is told at its
 *  stop, when its own session-start hook was its door and no wrapper waits
 *  to tell its spawner: the ticket door's words for that ending. */
export function invalidStopLine(leg: LegRegistration): string {
  return `treecontext: the ${leg.role ?? 'unnamed'} worker${leg.run ? ` of the run "${leg.run}"` : ''} (session ${leg.sessionId}) `
    + `stopped and ended with invalid instructions: its ticket could not be read whole (unreadable: ${leg.ticketAbsent.join(', ')}).`
}

/**
 * D295, D279, D291: a `claude -p` worker's stop is its leg's stop at the
 * hooks door. A worker that stops with no checkpoint under its key newer
 * than its start, whose ticket was read whole, names a key and names the
 * worker itself as the one who will checkpoint it, declares a way to
 * write, and was never sent back by either door, is sent back once here:
 * the stop is blocked with the same message the ticket door's re-run
 * opens on (the reason, the first moment composed again, the trail), its
 * row lands in the worker's lane and the send-back is counted on the
 * registration, so the wrapper that spawned it sees the leg's one spent
 * and starts no run after it. A store this hook cannot write asks
 * nothing, and the wrapper's send-back is then the leg's one. A worker is
 * never a self: no bookmark is asked of it.
 */
async function workerStop(input: Record<string, unknown>, dbPath: string, sessionId: string, w: WorkerAtStop, capped: string | null): Promise<void> {
  const ref: LegRef = { sessionId: w.leg.sessionId, agentId: w.leg.agentId }
  if (capped) {
    writeStaging(dbPath, {
      sessionId, role: 'assistant', content: capped, timestamp: Date.now() / 1000, priority: 2,
      indexLen: Math.min(activeIndexCap('assistant'), capped.length),
    })
  }
  // No wrapper watches a worker its own hook claimed (no lane in the
  // environment): its stop says how it ended when that is invalid
  // instructions, the spawner's line it would otherwise never get.
  if ((w.leg.ticketAbsent.length > 0 || w.leg.ticketRaw !== null) && !process.env[WORKER_SESSION_ENV]) {
    process.stdout.write(JSON.stringify({ systemMessage: invalidStopLine(w.leg) }) + '\n')
    return
  }
  if (input['stop_hook_active'] === true) return
  const refusal = storeRefusesWrites(dbPath)
  const verdict = sendBackDecision({
    exit: { code: 0, signal: null }, ticketValid: w.leg.ticketAbsent.length === 0 && w.leg.ticketRaw === null,
    noKey: w.leg.key === null, role: w.leg.role, checkpointer: w.leg.checkpointer, canWrite: w.leg.canWrite,
    sendBacks: w.leg.sendBacks, checkpointSinceStart: w.checkpointSinceStart, storeWritable: refusal === null,
    capRefused: capRefusalOf(w.leg),
  })
  dbg('hook:stop', 'a worker\'s stop', { lane: ref.sessionId, sendBack: verdict.sendBack, why: verdict.why })
  if (!verdict.sendBack) return
  let db: DatabaseSync | null = null
  try {
    db = openHookDb(dbPath)
    const opened = await hookStoreOn(db, dbPath, sessionId, HOOK_STARTED_AT)
    if (!opened || 'refused' in opened) {
      if (opened) recordHookGap(dbPath, { hook: 'stop', sessionId, at: Date.now() / 1000, error: opened.refused, lost: 'The worker was owed its one send-back and was not sent back here; its wrapper may send it back at its exit.' })
      return
    }
    const store = opened.store
    try {
      const leg = w.leg
      const facts = firstMomentFactsOf(db, hookTreeOf(db, opened.namespace), {
        run: leg.run!, key: leg.key, role: leg.role ?? 'unnamed', checkpointer: leg.checkpointer, checkpointedBy: leg.checkpointedBy, self: ref,
      })
      const rows = laneRowsOf(db, leg)
      const compose = (o: Parameters<typeof composeFirstMessage>[2]): string => composeSendBackMessage({
        facts, prompt: w.prompt ?? '', sessionId: ref.sessionId, firstMomentId: w.firstMomentId, rows, capRefused: capRefusalOf(w.leg),
        firstMessage: composeFirstMessage(facts, w.prompt ?? '', o),
      })
      const message = fitHookCap(facts, { compose }).message
      const sent = store.recordWorkerSendBack(ref, {
        message, refs: [...(w.firstMomentId ? [w.firstMomentId] : []), ...facts.checkpoints.map((c) => c.nodeId)], door: 'hooks',
      })
      if (sent) process.stdout.write(blockOutput(message))
    } finally { await store.close() }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    dbg('hook:stop', 'worker send-back write FAILED — not sent back', { error })
    recordHookGap(dbPath, { hook: 'stop', sessionId, at: Date.now() / 1000, error, lost: 'The worker was owed its one send-back and was not sent back here; its wrapper may send it back at its exit.' })
  } finally { if (db) db.close() }
}

export async function main(preParsed?: Record<string, unknown>): Promise<void> {
  try {
    const input = preParsed ?? parseHookInput()
    const { session_id, cwd } = input

    const text = turnText(input)
    dbg('hook:stop', 'invoked', { sessionId: session_id ?? null, cwd: cwd ?? null, source: text?.source ?? null })
    if (!text) dbg('hook:stop', 'no assistant text in the payload or the transcript — nothing to capture')

    const dbPath = resolveDbPath(cwd)
    const capped = text ? text.text.substring(0, STORE_SAFETY_CAP) : null
    // Never block twice (D163): a stop the platform marks as already
    // continuing because of this hook is never asked again.
    const askable = input.stop_hook_active !== true
    const guard = session_id
      ? guardRead(dbPath, session_id, capped, askable)
      : { stale: false, due: null, worker: null }
    if (guard.worker && typeof session_id === 'string') {
      await workerStop(input, dbPath, session_id, guard.worker, guard.stale ? null : capped)
      process.exit(0)
      return
    }

    // Second duty (D156, D207), decided before the write so the ask can
    // be recorded on the capture's own connection.
    const due = guard.due?.due ? guard.due : null
    const refusal = due ? storeRefusesWrites(dbPath) : null
    const nowSec = hookNowSec()
    const recordAsk = due && refusal === null && session_id
      ? (db: Parameters<typeof markBookmarkAsked>[0]) => markBookmarkAsked(db, session_id, nowSec)
      : undefined

    // First duty: capture the response. The second duty never displaces it.
    let asked = false
    if (capped && guard.stale) {
      dbg('hook:stop', 'stale recapture of prior turn text — skipping')
    } else if (capped) {
      writeStaging(dbPath, {
        sessionId: session_id,
        role: 'assistant',
        content: capped,
        timestamp: Date.now() / 1000,
        priority: 2,
        indexLen: Math.min(activeIndexCap('assistant'), capped.length),
      }, recordAsk ? (db) => { recordAsk(db); asked = true } : undefined)
    }
    if (recordAsk && !asked) {
      // Nothing was captured this stop, so no write connection is open:
      // the ask still gets its mark, or the next stop would ask again.
      let db: DatabaseSync | null = null
      try { db = openHookDb(dbPath); recordAsk(db) } catch (err) {
        dbg('hook:stop', 'bookmark ask mark FAILED', { error: err instanceof Error ? err.message : String(err) })
      } finally { if (db) db.close() }
    }

    if (due && refusal === null) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: bookmarkRequest(due) }) + '\n')
    } else if (due && session_id && firstReport(session_id)) {
      // Reported once per session (D163), and the agent stops: no block.
      // The once-mark lives outside the store, which is the thing that
      // cannot be written.
      process.stdout.write(JSON.stringify({
        systemMessage: `treecontext: a bookmark was due but could not be written — ${refusal}. The agent stops as usual; this is reported once per session. Run \`treecontext doctor\`.`,
      }) + '\n')
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message)
    }
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) {
  void main()
}
