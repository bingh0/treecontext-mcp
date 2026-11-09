import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { resolveDbPath, writeStaging, stageBatchAccount, parseHookInput, isDirectInvocation, payloadWriter, openHookDb, STOP_GUARD_TIMEOUT_MS, type BatchCall } from './shared.js'
import { legOf, hasLegColumns, legWriterOf } from '../persistence/leg-registry.js'
import { returnPointerLine } from '../first-moment.js'
import { SUBAGENT_SUMMARY_KIND } from '../run-kinds.js'
import {
  STORE_SAFETY_CAP,
  TOOL_INPUT_PREVIEW_CAP,
  TOOL_OUTPUT_PREVIEW_CAP,
  FULL_TAIL_SEPARATOR,
  activeIndexCap,
} from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'
import { ECHO_LABEL_PREFIX, echoToolOf } from '../persistence/echo-index.js'

/** Separator between the indexed preview and the full tail (C4).
 *  Re-exported from capture-constants, which OWNS it: no longer merely
 *  cosmetic since the V2 extractors bound their scans on this exact
 *  string when a row carries no preview_len (`echo-correlation.ts`
 *  outputSection). Two declarations could drift; one cannot. */
export { FULL_TAIL_SEPARATOR }

/** The label of a treecontext_import call, on one line, or null for any
 *  other call (or an import that carried none). */
function importEchoLabel(toolName: unknown, toolInput: unknown): string | null {
  if (echoToolOf(toolName) !== 'treecontext_import') return null
  let input: unknown = toolInput
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { return null }
  }
  if (input === null || typeof input !== 'object') return null
  const label = (input as Record<string, unknown>)['label']
  if (typeof label !== 'string') return null
  const oneLine = label.replace(/[\r\n]+/g, ' ').trim()
  return oneLine === '' ? null : oneLine
}

/** The tool that spawns a subagent, by its names on the reference
 *  platform: `Agent`, and `Task` before it was renamed. */
export const AGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task']

/**
 * The subagent an Agent tool call returned, by the id in its result, or
 * null: for any other tool, a result naming no agent, or a BACKGROUND
 * launch. A background Agent call's PostToolUse fires at its launch, its
 * result `{ isAsync: true, status: "async_launched", agentId }` (Claude
 * Code, observed in this developer's transcripts): the subagent has not
 * finished, its return arrives later as a task notification the platform
 * owns, and no pointer is carried for it (a line here would read as a
 * finished leg that left no summary).
 */
export function agentReturned(toolName: unknown, response: unknown): string | null {
  if (typeof toolName !== 'string' || !AGENT_TOOL_NAMES.includes(toolName)) return null
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null
  const r = response as Record<string, unknown>
  if (r['isAsync'] === true || r['status'] === 'async_launched') return null
  return typeof r['agentId'] === 'string' && r['agentId'] !== '' ? r['agentId'] : null
}

/**
 * D284, D285, D330: the one line the main agent receives beside the Agent
 * tool's result when the subagent it spawned was a leg: its return, the
 * summary row in its lane, with the leg's writer, run and key, or a line
 * saying it left none. The tool's result itself, the subagent's own final
 * message, is the platform's and is not touched; this line rides as the
 * PostToolUse hook's added context, which Claude Code places next to the
 * tool result. The subagent is named by the result's `agentId` (Claude
 * Code's hooks reference: a foreground Agent call's tool_response carries
 * `agentId` and `content`). A subagent with no leg facts gets no line
 * (D305: exactly as today). Read-only, on the guard budget.
 */
export function legPointerFor(dbPath: string, sessionId: string, agentId: string): string | null {
  let db: DatabaseType | null = null
  try {
    db = openHookDb(dbPath, { readonly: true, timeoutMs: STOP_GUARD_TIMEOUT_MS })
    if (!hasLegColumns(db)) return null
    const leg = legOf(db, { sessionId, agentId })
    if (!leg || leg.kind !== 'subagent' || (leg.run === null && leg.keyCandidates.length === 0)) return null
    const row = db.prepare(
      `SELECT node_id, metadata_json FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?
          AND json_extract(metadata_json, '$.kind') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId, agentId, SUBAGENT_SUMMARY_KIND) as { node_id: string; metadata_json: string } | undefined
    if (!row) {
      return `treecontext: the ${leg.role ?? 'unnamed'} leg${leg.run ? ` of the run "${leg.run}"` : ''} (agent ${agentId}) left no summary row in the store yet; `
        + 'its key lookup says how it ended.'
    }
    const m = JSON.parse(row.metadata_json) as Record<string, unknown>
    return returnPointerLine({
      role: leg.role, writer: typeof m['_writer'] === 'string' ? m['_writer'] : legWriterOf(leg),
      run: typeof m['run'] === 'string' ? m['run'] : null, key: typeof m['key'] === 'string' ? m['key'] : null, summaryId: row.node_id,
    })
  } catch {
    return null
  } finally { if (db) db.close() }
}

/** True for the MCP content-block shape: a non-empty list whose every
 *  element is an object naming its `type`. */
function isContentBlockList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every(
    (b) => b !== null && typeof b === 'object' && !Array.isArray(b) && typeof (b as Record<string, unknown>)['type'] === 'string',
  )
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function')
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? path : path.slice(dot + 1)
}

/** One field, under its (dotted) path, as lines. */
function composeField(path: string, value: unknown, lines: string[]): void {
  if (typeof value === 'string') {
    lines.push(`${path}:`)
    if (value !== '') lines.push(normalizeText(value))
    return
  }
  if (isScalar(value)) {
    lines.push(`${path}: ${String(value)}`)
    return
  }
  // Content blocks are recognized only where MCP puts them: a field named
  // `content` (the `{content: [...]}` wrapper); any other array of
  // objects composes element by element below.
  if (lastSegment(path) === 'content' && isContentBlockList(value)) {
    lines.push(`${path}:`)
    lines.push(composeBlocks(value))
    return
  }
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      lines.push(`${path}: [${value.map((v) => String(v)).join(', ')}]`)
      return
    }
    value.forEach((v, i) => composeField(`${path}[${i}]`, v, lines))
    return
  }
  if (value === undefined || typeof value !== 'object') return
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    lines.push(`${path}: {}`)
    return
  }
  for (const [k, v] of entries) composeField(`${path}.${k}`, v, lines)
}

function composeObject(obj: Record<string, unknown>, lines: string[]): void {
  for (const [k, v] of Object.entries(obj)) composeField(k, v, lines)
}

/** A content-block list: a text block's text verbatim (byte for byte, no
 *  line-ending normalisation) followed by its other fields (annotations,
 *  _meta) as name and value; any other block as `type: <type>` and its
 *  other fields; blocks separated by a newline. */
function composeBlocks(blocks: Array<Record<string, unknown>>): string {
  return blocks.map((b) => {
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      const { type: _type, text, ...rest } = b
      const lines: string[] = [text as string]
      composeObject(rest, lines)
      return lines.join('\n')
    }
    const lines: string[] = [`type: ${String(b['type'])}`]
    const { type: _type, ...rest } = b
    composeObject(rest, lines)
    return lines.join('\n')
  }).join('\n')
}

/** A shielded-output pointer the server returned. */
export interface ShieldedPointer { file: string; bytes: unknown }

function pointerOf(value: unknown): ShieldedPointer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  return r['shielded'] === true && typeof r['file'] === 'string' && r['file'] !== '' ? { file: r['file'], bytes: r['bytes'] } : null
}

function pointerInText(text: string): ShieldedPointer | null {
  if (!text.includes('"shielded":true') && !text.includes('"shielded": true')) return null
  try {
    const ref = JSON.parse(text) as Record<string, unknown>
    // As before D270: any truthy shielded flag and file.
    return ref && ref['shielded'] && ref['file'] ? { file: String(ref['file']), bytes: ref['bytes'] } : null
  } catch {
    return null
  }
}

function pointerInBlocks(blocks: unknown): ShieldedPointer | null {
  if (!isContentBlockList(blocks)) return null
  for (const b of blocks) {
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      const ref = pointerInText(b['text'])
      if (ref) return ref
    }
  }
  return null
}

/**
 * D270 — a shielded pointer is recognized whatever shape the client
 * wrapped it in, read from the payload BEFORE composing: the pointer
 * object itself (`{shielded: true, file, bytes}`), a string holding its
 * JSON, a content-block list whose text block holds it, or a
 * `{content: [...]}` wrapper around such a list.
 */
export function shieldedPointerOf(value: unknown): ShieldedPointer | null {
  if (typeof value === 'string') return pointerInText(value)
  if (Array.isArray(value)) return pointerInBlocks(value)
  const direct = pointerOf(value)
  if (direct) return direct
  if (value !== null && typeof value === 'object') return pointerInBlocks((value as Record<string, unknown>)['content'])
  return null
}

/**
 * D270 — a tool event's input or output as the text it is.
 *
 * A string is returned as is (byte-for-byte today's composition). An
 * object writes every field out in its key order: a string field as
 * `name:` followed by its text on the next lines (line breaks and tabs
 * real, `\r\n` read as `\n`), a nested object as its fields under their
 * dotted path (`file.content:`), an array of scalars as `name: [a, b]`,
 * an array of objects element by element (`name[0].field`), any other
 * scalar as `name: value`. A content-block list (the MCP shape: the whole
 * payload, or a `content` field) writes each text block's text verbatim
 * and then its other fields, one block per line run. Nothing the
 * client sent is dropped. The JSON encoding this replaces turned every
 * line break into backslash-n, which the tokenizer glued onto the next
 * word, so only an output's first line was findable.
 */
export function composeToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  if (isScalar(value)) return String(value)
  if (isContentBlockList(value)) return composeBlocks(value)
  const lines: string[] = []
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return `[${value.map((v) => String(v)).join(', ')}]`
    value.forEach((v, i) => composeField(`[${i}]`, v, lines))
  } else {
    // An empty object is still something the client sent.
    if (Object.keys(value as object).length === 0) return '{}'
    composeObject(value as Record<string, unknown>, lines)
  }
  return lines.join('\n')
}

/** A tool call composed as its journal entry: the staged text and its
 *  boundaries, and its priority. */
export interface ToolEntry {
  content: string
  indexLen: number | null
  previewLen: number | null
  priority: number
}

/** The trail-class tools (repo readers): see composeToolEntry. */
export const TRAIL_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'View', 'ListDir']

/**
 * One tool call as its journal entry, whichever event carried it: a
 * successful call's response, a failed call's error text (D400), or what
 * the client told the model about a call it resolved without running
 * (D401) is the Output section, under one layout, one trail and treasure
 * rule and one set of boundaries.
 */
export function composeToolEntry(tool_name: string, tool_input: unknown, tool_output: unknown): ToolEntry {
  // Trail-class tools (repo readers). The charter (journal-capture) says
  // no invocation is ever filtered out — the trail is how a future agent
  // reconstructs what was being worked on — but their OUTPUT is repo
  // content at that moment, re-derivable from the working tree and git
  // history, so it keeps only the bounded preview and never stages a
  // full-fidelity tail. Execution/external outputs (Bash, web, MCP) are
  // historical facts and keep the C4 tail below.
  const isTrail = TRAIL_TOOLS.includes(tool_name)

  // Priority assignment
  let priority = 3
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool_name)) {
    priority = 1
  } else if (tool_name === 'Bash') {
    priority = 2
  }

  // D270: an object or content-block payload is written as its text,
  // never as its JSON encoding. Spoof note: echo-correlation's
  // outputSection once relied on JSON escaping to keep a `\nOutput:`
  // out of the Input section; its lastIndexOf still wins whenever a real
  // Output exists. echoIndexBoundary (delete/merge/clear) cuts at the
  // FIRST `\nOutput:`, so a multi-line argument holding a line `Output:`
  // shortens that echo's boundary: narrower, never wider.
  const safeToolInput = composeToolText(tool_input)
  const safeToolOutput = composeToolText(tool_output)

  // Preview: byte-for-byte the pre-C4 layout (and, for a string payload,
  // the pre-C4 text) — it is the FTS index
  // view, so ranking must not shift.
  let preview = `Tool: ${tool_name}\n`
  // D261: an import echo's argument is the handoff itself, so its index
  // boundary stops at its label; the label gets its own line ahead of
  // the Input so a prefix boundary can reach it. No other layout changes.
  const importLabel = importEchoLabel(tool_name, tool_input)
  if (importLabel !== null) preview += `${ECHO_LABEL_PREFIX}${importLabel}\n`
  let inputOverflow = false
  if (safeToolInput) {
    inputOverflow = safeToolInput.length > TOOL_INPUT_PREVIEW_CAP
    preview += `Input:\n${safeToolInput.substring(0, TOOL_INPUT_PREVIEW_CAP)}${inputOverflow ? '...' : ''}\n`
  }
  let shielded = false
  let outputOverflow = false
  if (safeToolOutput) {
    // A shielded pointer is recognized whatever shape the client wrapped
    // it in (D270), read from the payload before it was composed.
    let handledAsShielded = false
    const ref = shieldedPointerOf(tool_output)
    if (ref) {
      preview += `Output: [shielded to ${ref.file}, ${String(ref.bytes)} bytes]\n`
      shielded = true
      handledAsShielded = true
    }
    if (!handledAsShielded) {
      outputOverflow = safeToolOutput.length > TOOL_OUTPUT_PREVIEW_CAP
      preview += `Output:\n${safeToolOutput.substring(0, TOOL_OUTPUT_PREVIEW_CAP)}${outputOverflow ? '...' : ''}\n`
    }
  }
  const previewTrimmed = preview.trim()

  // C4: when the preview actually truncated something (JF-3 — never stage
  // a tail for events that fit), append the full input/output after the
  // boundary. A shielded OUTPUT never enters a tail — the file pointer is
  // the full-fidelity mechanism for it — but a shielded output does not
  // cover the INPUT, so an overflowed input still tails (input only).
  //
  // Two boundaries, both in UTF-16 code units on the exact staged string
  // (JF-1): preview_len marks where the display preview ends (the read
  // side slices hits there), index_len marks how far the FTS view
  // reaches — up to activeIndexCap('tool') chars of preview PLUS tail,
  // per the 2026-07-28 cap sweep (8000-char view ≈ full-text recall at a
  // third of the latency). Pre-change rows carried only index_len at the
  // preview boundary; both readers still honor that shape.
  // JF-3 holds: an event that fits its caps stages NULL boundaries — its
  // index text is the whole content, involves no mutable constant, and
  // recomputes stably without a marker. A boundary is stamped only when
  // it is load-bearing: a full tail follows the preview, or an env cap
  // narrower than the preview itself bounds the view.
  const indexCap = activeIndexCap('tool')
  let content = previewTrimmed
  let indexLen: number | null = indexCap < previewTrimmed.length ? indexCap : null
  let previewLen: number | null = null
  if (!isTrail && (inputOverflow || (!shielded && outputOverflow))) {
    const tail =
      `\n${FULL_TAIL_SEPARATOR}\n` +
      (safeToolInput ? `Input:\n${safeToolInput}\n` : '') +
      (safeToolOutput && !shielded ? `Output:\n${safeToolOutput}` : '')
    let composed = previewTrimmed + tail
    if (composed.length > STORE_SAFETY_CAP) {
      const notice = '\n[full content truncated to fit store cap]'
      composed = composed.slice(0, STORE_SAFETY_CAP - notice.length) + notice
    }
    if (composed.length > previewTrimmed.length) {
      content = composed
      previewLen = previewTrimmed.length
      indexLen = Math.min(indexCap, composed.length)
    }
  }
  return { content, indexLen, previewLen, priority }
}

/** The client's id for a call, when the payload names one. */
function callIdOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** The Claude Code events this hook serves, by `hook_event_name`: a call
 *  that succeeded, a call that failed (D400), and the batch's account of
 *  every call it resolved (D401). Any other name (an adapter's normalized
 *  payload, a payload with none) is a call that succeeded, as before. */
export const POST_TOOL_USE_FAILURE = 'PostToolUseFailure'
export const POST_TOOL_BATCH = 'PostToolBatch'

/** D400: how a failed call ended, as the client said it. */
export function failureOutcome(input: Record<string, unknown>): 'failed' | 'interrupted' {
  return input['is_interrupt'] === true ? 'interrupted' : 'failed'
}

/**
 * D401: the batch's account, as the calls it would stage: each call of
 * `tool_calls` with a tool name and the client's id, composed with what the
 * client told the model (`tool_response`) as its Output, marked
 * `captured_from` `batch`, at the batch's moment, as the batch payload's
 * writer. Which of them are staged is decided against staging
 * (stageBatchAccount).
 */
export function batchCallsOf(input: Record<string, unknown>, at: number): BatchCall[] {
  const calls = Array.isArray(input['tool_calls']) ? input['tool_calls'] as unknown[] : []
  const writer = payloadWriter(input)
  const out: BatchCall[] = []
  for (const c of calls) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) continue
    const call = c as Record<string, unknown>
    const toolName = call['tool_name']
    const toolUseId = callIdOf(call['tool_use_id'])
    if (typeof toolName !== 'string' || toolName === '' || !toolUseId) continue
    const e = composeToolEntry(toolName, call['tool_input'], call['tool_response'])
    out.push({
      toolUseId,
      entry: {
        sessionId: typeof input['session_id'] === 'string' ? input['session_id'] : null,
        role: 'assistant', content: e.content, toolName, timestamp: at, priority: e.priority,
        indexLen: e.indexLen, previewLen: e.previewLen, ...writer,
        toolUseId, capturedFrom: 'batch',
      },
    })
  }
  return out
}

export function main(preParsed?: Record<string, unknown>) {
  try {
    const input = preParsed ?? parseHookInput()
    const event = input.hook_event_name

    // D401: the batch's account of every call it resolved, after each
    // call's own hooks have finished; it adds only the calls no event of
    // their own captured.
    if (event === POST_TOOL_BATCH) {
      const calls = batchCallsOf(input, Date.now() / 1000)
      dbg('hook:post-tool', 'batch', { calls: calls.length })
      if (calls.length > 0) {
        stageBatchAccount(resolveDbPath(input.cwd), typeof input.session_id === 'string' ? input.session_id : null, calls)
      }
      process.exit(0)
      return
    }

    // Claude Code's PostToolUse payload carries the result as
    // `tool_response`; the codex/cursor normalizers map their shapes to
    // `tool_output`. Accept both — reading only `tool_output` left the
    // flagship platform's journal INPUT-ONLY (verified: hundreds of
    // captured tool events, zero genuine Output sections). D400: a failed
    // call's PostToolUseFailure carries no response; the client's `error`
    // text is its Output.
    const failed = event === POST_TOOL_USE_FAILURE
    const { session_id, cwd, tool_name, tool_input } = input
    const tool_output = failed ? input.error : (input.tool_output ?? input.tool_response)

    dbg('hook:post-tool', 'invoked', { event: event ?? null, tool_name: tool_name ?? null, cwd: cwd ?? null, hasInput: !!tool_input, hasOutput: !!tool_output })

    if (!tool_name) {
      dbg('hook:post-tool', 'no tool_name — skipping')
      process.exit(0)
      return
    }

    const { content, indexLen, previewLen, priority } = composeToolEntry(tool_name, tool_input, tool_output)
    const dbPath = resolveDbPath(cwd)
    const toolUseId = callIdOf(input.tool_use_id)

    writeStaging(dbPath, {
      sessionId: session_id,
      role: 'assistant',
      content,
      toolName: tool_name,
      timestamp: Date.now() / 1000,
      priority,
      indexLen,
      previewLen,
      // D190: a subagent's tool call carries its own agent_id and
      // agent_type (probe of 2026-09-25); the row drains stamped with
      // that writer. The main agent's payload carries neither.
      ...payloadWriter(input),
      // D400: the client's id for the call, on every captured call; a
      // failed call's outcome.
      ...(toolUseId ? { toolUseId } : {}),
      ...(failed ? { outcome: failureOutcome(input) } : {}),
    })

    // D330: the pointer to a leg's return rides on the Agent tool's result.
    const spawned = failed ? null : agentReturned(tool_name, tool_output)
    if (spawned && typeof session_id === 'string') {
      const line = legPointerFor(dbPath, session_id, spawned)
      if (line) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } }) + '\n')
      }
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
