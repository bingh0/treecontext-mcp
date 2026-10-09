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
import { readFileSync, writeFileSync, accessSync, constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { resolveDbPath, writeStaging, parseHookInput, isDirectInvocation, openHookDb, STOP_GUARD_TIMEOUT_MS } from './shared.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'
import { checkpointDue, bookmarkRequest, markBookmarkAsked, hookNowSec, type CheckpointDue } from '../checkpoints.js'

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
  let db: InstanceType<typeof Database> | null = null
  try {
    // Through the one opener, at the GUARD budget: this hook opens the
    // store twice (this guard, then writeStaging's 8s write), and the
    // two busy budgets sum against the platform's 10s kill — the full
    // 8s here made the worst case 16s, converting a duplicate-capture
    // risk into total capture loss (pass-2 review 2026-08-15).
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    return staleOn(db, sessionId, text)
  } catch {
    return false
  } finally {
    if (db) db.close()
  }
}

function staleOn(db: InstanceType<typeof Database>, sessionId: string, text: string): boolean {
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
): { stale: boolean; due: CheckpointDue | null } {
  let db: InstanceType<typeof Database> | null = null
  try {
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    const stale = text !== null && staleOn(db, sessionId, text)
    let due: CheckpointDue | null = null
    if (checkpoint) {
      try { due = checkpointDue(db, sessionId, hookNowSec()) } catch (err) {
        // A store too old for the checkpoint reads (no nodes, no
        // session_key): no bookmark is asked for, capture goes on.
        dbg('hook:stop', 'checkpoint check skipped', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { stale, due }
  } catch {
    return { stale: false, due: null }
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

/** Can the agent's bookmark land? The write goes through the MCP server,
 *  not this hook, so the question is whether the store file takes writes
 *  at all — asked of the filesystem, which costs no lock wait. */
function storeRefusesWrites(dbPath: string): string | null {
  try {
    accessSync(dbPath, fsConstants.W_OK)
    accessSync(dirname(dbPath), fsConstants.W_OK)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? 'the store is read-only for this session'
      : `the store is unavailable (${err instanceof Error ? err.message : String(err)})`
  }
}

interface TranscriptContentBlock {
  type?: string
  text?: string
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
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }

  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const rawLine = lines[i]
    if (rawLine === undefined) continue
    const line = rawLine.trim()
    if (!line) continue

    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }

    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue

    const content = entry.message?.content
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

export function main(preParsed?: Record<string, unknown>): void {
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
      : { stale: false, due: null }

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
      let db: InstanceType<typeof Database> | null = null
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
  main()
}
