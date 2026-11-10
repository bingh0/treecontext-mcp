/**
 * Antigravity CLI's named hook (D413, D415, D421): what one agy event
 * stages, read from the event and from agy's own transcript of the
 * conversation.
 *
 * agy has no prompt event and puts no tool output and no reply in any
 * payload (recorded live, 2026-11-09, agy 1.5.3, tests/fixtures/agy-hooks):
 *  - the prompt rides on every event as `lastUserInput`; it is journaled at
 *    a turn's opening PreInvocation, the one numbered 0, and nowhere else;
 *  - PostToolUse names the call (`toolCall` {name, args}, `stepIdx`) with no
 *    output, and the call's result step is not yet in the transcript then;
 *    it is there by the PostInvocation that follows. So PostToolUse stages
 *    the call's account in staging (AGY_CALL_MARK: its entry with no output,
 *    its moment, its step under a staging-only key, its arguments), from
 *    which the drain writes nothing; each PostInvocation journals, in one
 *    transaction, every account of the conversation whose result the
 *    transcript now holds, at the moment its PostToolUse arrived, and takes
 *    the account out;
 *  - at Stop, an account whose result is still not in the transcript, or
 *    whose transcript cannot be read, is journaled with its name and
 *    arguments and a line saying its output was not captured, and the turn's
 *    reply (the transcript's last response after its last prompt) with it;
 *  - an account no PostInvocation or Stop ever settles (a worker killed mid
 *    turn, a Stop the store refused) is journaled by the purge of processed
 *    staging (store.ts resolveAbandonedAccounts) at the call's own moment,
 *    saying its output never reached the journal. No call leaves no trace.
 *
 * One deadline for the hook's every write (AGY_HOOK_BUDGET_MS from the
 * hook's start), well inside the timeout install writes on each handler
 * (10 s); what cannot be written in time goes to the gap ledger (D314), or
 * stays an account the next event or the purge settles.
 *
 * agy states no outcome for a call and gives no call id: a call's class is
 * read from its text at the drain (D404), and no `tool_use_id` reaches an
 * entry. The event's name comes from the command install wrote (`tc-agy
 * <Event> --client agy`), never from the payload: a PreInvocation and a
 * PostInvocation payload carry the same keys. Every answer to agy is a JSON
 * object (`{}`), deciding no permission.
 *
 * A session the ticket door did not start registers nothing (D421): its
 * rows are staged with the client's name (staging's `client`), which the
 * drain reads to stamp them as a writer no hook registered. A worker the
 * ticket door started, its ticket and lane in its environment, has its
 * conversation linked to its worker's lane at SessionStart, so the drain
 * lands its rows there (D416's worker clause, as for Codex, D410).
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { parseHookInput, resolveDbPath, writeStaging, openHookDb, HOOK_STARTED_AT } from './shared.js'
import { composeToolEntry } from './post-tool-use.js'
import { recordHookGap } from './gap-ledger.js'
import { AGY_CLIENT } from './hook-client.js'
import { ticketTextIn, trustedWorkerLane } from '../ticket.js'
import { hasLegColumns, linkClientSession, WORKER_AGENT_ID, LINKED_BY_SESSION_START } from '../persistence/leg-registry.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { TURN_PROMPT_KIND, AGY_CALL_MARK, AGY_STEP_KEY_PREFIX } from '../persistence/capture-marks.js'
import { dbg } from '../debug.js'

/** The events install wires for agy, as the command names them (D413). */
export const AGY_EVENTS = ['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'Stop'] as const
export type AgyEvent = typeof AGY_EVENTS[number]

/**
 * The one budget for all of a hook's writes, from the hook's start: install
 * writes `timeout: 10` (seconds) on each of agy's five handlers (agy's own
 * default is 30, D413's comment), and agy's loop waits while a hook runs, so
 * a locked store costs a turn this much at most, never a fresh wait per
 * write.
 */
export const AGY_HOOK_BUDGET_MS = 6000

/** The line a call whose output was not captured carries after its input
 *  (D415). Not an Output section: nothing of agy's result was read. */
export function notCapturedLine(why: string): string {
  return `[output not captured] ${why}`
}

/** One step of agy's transcript, as recorded at 1.5.3. */
interface Step { step_index?: unknown; type?: unknown; status?: unknown; content?: unknown; error?: unknown; tool_calls?: unknown }

/** agy's transcript of a conversation by step index, or why it cannot be read. */
export function readTranscript(path: unknown): { ok: true; steps: Map<number, Step> } | { ok: false; why: string } {
  if (typeof path !== 'string' || path === '') return { ok: false, why: 'the event named no transcript' }
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (e) {
    return { ok: false, why: `agy's transcript ${path} could not be read (${(e as NodeJS.ErrnoException).code ?? String(e)})` }
  }
  const steps = new Map<number, Step>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const s = JSON.parse(line) as Step
      if (typeof s.step_index === 'number') steps.set(s.step_index, s)
    } catch { /* a line in another layout: not a step this build reads */ }
  }
  return { ok: true, steps }
}

/** A call's result as the transcript holds it at `step`, in the layout
 *  recorded at 1.5.3 (a step that is no model response, with its text), or
 *  null where it holds none. */
export function resultAt(steps: Map<number, Step>, step: number): string | null {
  const s = steps.get(step)
  if (!s || s.type === 'PLANNER_RESPONSE' || s.type === 'USER_INPUT') return null
  if (typeof s.content === 'string') return s.content
  if (typeof s.error === 'string') return s.error
  return null
}

/** The turn's reply: the last model response with text and no call after
 *  the transcript's last prompt, with its step, or null. */
export function replyOf(steps: Map<number, Step>): { step: number; text: string } | null {
  const order = [...steps.keys()].sort((a, b) => a - b)
  let lastInput = -1
  for (const i of order) if (steps.get(i)!.type === 'USER_INPUT') lastInput = i
  for (const i of order.reverse()) {
    if (i <= lastInput) break
    const s = steps.get(i)!
    if (s.type === 'PLANNER_RESPONSE' && typeof s.content === 'string' && s.content.trim() !== '') return { step: i, text: s.content }
  }
  return null
}

/** A conversation's accounts, as staged at their PostToolUse. */
interface Account { id: number; name: string; step: number; args: unknown; at: number; namespace: string | null }

const ENTRY = `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at,
   index_len, preview_len, namespace, client)
 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`

/**
 * Journal the accounts whose result the transcript holds; with `final`
 * (Stop), every other account too, saying its output was not captured, and
 * the turn's reply. One transaction under the hook's deadline: the entries
 * land and their accounts go together. On a store refusing the write past
 * the deadline, the accounts stay (the next event or the purge settles
 * them) and a final turn's reply goes to the gap ledger.
 */
function settle(dbPath: string, conversationId: string, transcriptPath: unknown, final: boolean, deadlineAt: number, at: number): void {
  const t = readTranscript(transcriptPath)
  let db: DatabaseType | null = null
  const reply = final && t.ok ? replyOf(t.steps) : null
  try {
    db = openHookDb(dbPath, { deadlineAt })
    const cols = (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).map((c) => c.name)
    if (!cols.includes('client') || !cols.includes('captured_from')) {
      dbg('hook:agy', 'staging predates the client (037): nothing held to settle', { dbPath })
    }
    const read = (): Account[] => !cols.includes('captured_from') ? [] : (db!.prepare(
      'SELECT id, tool_name, tool_use_id, kind, timestamp, namespace FROM staging WHERE session_id = ? AND captured_from = ? ORDER BY id',
    ).all(conversationId, AGY_CALL_MARK) as Array<Record<string, unknown>>).map((r) => {
      let args: unknown
      try { args = JSON.parse(String(r['kind'] ?? 'null')) } catch { args = undefined }
      return {
        id: Number(r['id']), name: String(r['tool_name']), step: Number(String(r['tool_use_id']).slice(AGY_STEP_KEY_PREFIX.length)),
        args, at: Number(r['timestamp']), namespace: (r['namespace'] as string | null) ?? null,
      }
    })
    const insert = db.prepare(cols.includes('client') ? ENTRY : ENTRY.replace(', client)', ')').replace(', ?, ?)', ', ?)'))
    const run = (...v: Array<string | number | null>): void => { insert.run(...(cols.includes('client') ? v : v.slice(0, -1))) }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const a of read()) {
        const out = t.ok ? resultAt(t.steps, a.step) : null
        if (out === null && !final) continue
        const e = composeToolEntry(a.name, a.args, out ?? undefined)
        const content = out !== null ? e.content : `${e.content}\n${notCapturedLine(t.ok
          ? `agy's transcript held no result for this call (step ${a.step}) by the end of the turn`
          : t.why)}`
        run(conversationId, 'assistant', content, a.name, a.at, e.priority, Date.now() / 1000, e.indexLen, e.previewLen, a.namespace, AGY_CLIENT)
        db.prepare('DELETE FROM staging WHERE id = ?').run(a.id)
      }
      if (reply) {
        const content = reply.text.substring(0, STORE_SAFETY_CAP)
        run(conversationId, 'assistant', content, null, at, 2, Date.now() / 1000, Math.min(activeIndexCap('assistant'), content.length), null, null, AGY_CLIENT)
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* not in a transaction */ }
      throw err
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    dbg('hook:agy', 'settle failed: the accounts stay for the next event or the purge', { error: msg })
    if (final) {
      recordHookGap(dbPath, {
        hook: 'stop', sessionId: conversationId, at, error: msg, client: AGY_CLIENT,
        lost: `The reply of this agy turn was not captured: ${msg}. Its calls stay held and are journaled by the next turn's end or the purge of staging.`,
        text: reply?.text ?? null,
      })
    }
    return
  } finally { if (db) db.close() }
  if (final && !reply) {
    recordHookGap(dbPath, {
      hook: 'stop', sessionId: conversationId, at, error: t.ok ? 'agy\'s transcript holds no reply after the turn\'s prompt' : t.why, client: AGY_CLIENT,
      lost: `The reply of this agy turn was not captured: ${t.ok ? 'its transcript holds no response with text after the turn\'s prompt' : t.why}.`,
    })
  }
}

/** A worker the ticket door started: its conversation linked to its lane. */
function workerStart(dbPath: string, conversationId: string, deadlineAt: number): void {
  let db: DatabaseType | null = null
  const at = Date.now() / 1000
  try {
    db = openHookDb(dbPath, { deadlineAt })
    const lane = hasLegColumns(db) ? trustedWorkerLane(db) : null
    if (lane !== null) {
      linkClientSession(db, { sessionId: lane, agentId: WORKER_AGENT_ID }, conversationId, { linkedBy: LINKED_BY_SESSION_START, at })
      dbg('hook:agy', 'a worker linked to its lane', { lane, conversationId })
      return
    }
    recordHookGap(dbPath, {
      hook: 'session-start', sessionId: conversationId, at, client: AGY_CLIENT, error: 'an Antigravity CLI conversation holding a worker\'s ticket with no lane the ticket door named',
      lost: 'This agy conversation held a worker\'s ticket, but no ticket door registered a lane for it (it was not started through treecontext run, or its lane did not match its ticket). It is journaled as no one\'s self and as no worker: its captured rows stay in its own session, writer unknown.',
    })
  } catch (err) {
    recordHookGap(dbPath, {
      hook: 'session-start', sessionId: conversationId, at, client: AGY_CLIENT, error: err instanceof Error ? err.message : String(err),
      lost: 'This agy conversation held a worker\'s ticket; it was linked to no worker lane.',
    })
  } finally { if (db) db.close() }
}

/** One agy event, as the command install wrote names it. */
export function handleAgyEvent(event: string, input: Record<string, unknown>, deadlineAt: number = HOOK_STARTED_AT + AGY_HOOK_BUDGET_MS): void {
  const conversationId = typeof input['conversationId'] === 'string' && input['conversationId'] !== '' ? input['conversationId'] : null
  if (!conversationId || !(AGY_EVENTS as readonly string[]).includes(event)) {
    dbg('hook:agy', 'no conversation, or an event install does not wire: nothing staged', { event })
    return
  }
  const ws = Array.isArray(input['workspacePaths']) && typeof input['workspacePaths'][0] === 'string' ? input['workspacePaths'][0] as string : undefined
  const dbPath = resolveDbPath(ws)
  const at = Date.now() / 1000
  if (event === 'SessionStart') {
    if (ticketTextIn(process.env) !== null) workerStart(dbPath, conversationId, deadlineAt)
    return
  }
  if (event === 'PreInvocation') {
    const prompt = typeof input['lastUserInput'] === 'string' ? input['lastUserInput'] : ''
    // D415: the turn's opening model call, numbered 0, carries its prompt;
    // every later event of the turn repeats it and adds nothing.
    if (input['invocationNum'] === 0 && prompt.trim() !== '') {
      const content = prompt.substring(0, STORE_SAFETY_CAP)
      writeStaging(dbPath, {
        sessionId: conversationId, role: 'user', content, timestamp: at, priority: 1,
        indexLen: Math.min(activeIndexCap('user'), content.length), client: AGY_CLIENT, kind: TURN_PROMPT_KIND,
      }, undefined, { deadlineAt })
    }
    return
  }
  if (event === 'PostToolUse') {
    const call = input['toolCall'] as { name?: unknown; args?: unknown } | undefined
    const step = input['stepIdx']
    const name = typeof call?.name === 'string' && call.name !== '' ? call.name : null
    if (name === null || typeof step !== 'number') {
      recordHookGap(dbPath, { hook: 'post-tool-use', sessionId: conversationId, at, client: AGY_CLIENT, error: 'agy\'s PostToolUse named no tool call or step', lost: 'A tool call agy reported was not journaled: its event named no call this build reads.' })
      return
    }
    // The call's account: its entry with no output, its moment, its step
    // (a staging-only key, never on an entry) and its arguments, from which
    // the entry is composed again once its result is read. A store refusing
    // it past the deadline: writeStaging records the call in the gap ledger.
    const e = composeToolEntry(name, call?.args, undefined)
    writeStaging(dbPath, {
      sessionId: conversationId, role: 'assistant', content: e.content, toolName: name, timestamp: at, priority: e.priority,
      indexLen: e.indexLen, previewLen: e.previewLen, client: AGY_CLIENT,
      capturedFrom: AGY_CALL_MARK, toolUseId: `${AGY_STEP_KEY_PREFIX}${step}`, kind: JSON.stringify(call?.args ?? null),
    }, undefined, { deadlineAt })
    return
  }
  settle(dbPath, conversationId, input['transcriptPath'], event === 'Stop', deadlineAt, at)
}

/** `treecontext hook agy <Event> --client agy`: the event, then `{}` (D413). */
export function main(event: string, preParsed?: Record<string, unknown>): void {
  try {
    const input = (preParsed ?? parseHookInput()) as Record<string, unknown>
    handleAgyEvent(event, input && typeof input === 'object' ? input : {})
  } catch (err) {
    dbg('hook:agy', 'failed', { event, error: err instanceof Error ? err.message : String(err) })
  }
  // The answer agy reads, also printed by the hook script whatever node does.
  process.stdout.write('{}\n')
  process.exit(0)
}
