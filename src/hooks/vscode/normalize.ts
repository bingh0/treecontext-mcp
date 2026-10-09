/**
 * GitHub Copilot hook payload normalization (VS Code and Copilot CLI).
 *
 * Copilot emits hook input as JSON on stdin in one of two shapes, and
 * which one you get depends on the surface:
 *
 *   camelCase (Copilot CLI, cloud agent):
 *     sessionId, timestamp (epoch ms), cwd, prompt,
 *     toolName, toolArgs, toolResult: { resultType, textResultForLlm }
 *
 *   VS Code compatibility shape:
 *     hook_event_name, session_id, timestamp (ISO 8601), cwd, prompt,
 *     tool_name, tool_input, tool_response
 *
 * This module folds both into the internal shape the reference (Claude
 * Code) hooks already consume, so the adapters can DELEGATE to them
 * rather than keep a parallel implementation. That delegation is the
 * point: the previous copies had drifted off the capture charter — they
 * dropped repo-reading invocations the reference platform stopped
 * dropping, and they had no assistant-turn capture at all.
 *
 * Reading only one field name is exactly how this adapter was broken
 * before: it looked for `tool_name` while Copilot sent `toolName`, so
 * every tool event exited early and captured nothing. Every field below
 * therefore accepts both spellings.
 */

import * as fs from 'fs'

export interface NormalizedInput extends Record<string, unknown> {
  session_id: string | null
  cwd: string | null
  source: string | null
  user_message: string | null
  prompt: string | null
  tool_name: string | null
  tool_input: unknown
  tool_output: string | null
  transcript_path: string | null
  /** Assistant text when the payload carries it inline (agentStop). */
  assistant_message: string | null
}

/** Copilot's postToolUse result object. */
interface ToolResult {
  resultType?: string
  textResultForLlm?: string
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return null
  return JSON.stringify(v)
}

/**
 * Copilot reports tool output as `toolResult.textResultForLlm`; VS Code's
 * compatibility shape uses the flat `tool_response`. Accept either, and
 * fall back to stringifying the whole object rather than losing it.
 */
function extractToolOutput(raw: Record<string, unknown>): string | null {
  const result = raw.toolResult as ToolResult | string | undefined
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    if (typeof result.textResultForLlm === 'string') return result.textResultForLlm
    return JSON.stringify(result)
  }
  return asString(raw.tool_response ?? raw.tool_output ?? null)
}

/**
 * Copilot timestamps are epoch milliseconds (CLI) or ISO 8601 (VS Code);
 * the journal wants epoch SECONDS, which is what makes temporal recall
 * honest. Returns null when absent so ingestion falls back to its own
 * clock rather than inventing a moment.
 */
export function normalizeTimestamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Epoch ms overtook 1e11 in 1973; epoch seconds won't until 5138.
    return v > 1e11 ? v / 1000 : v
  }
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed / 1000
  }
  return null
}

export function normalizeCopilotPayload(raw: Record<string, unknown>): NormalizedInput {
  const sessionId = asString(raw.sessionId ?? raw.session_id ?? null)
  const cwd = asString(raw.cwd ?? null)
  const prompt = asString(raw.prompt ?? raw.user_message ?? null)
  const toolName = asString(raw.toolName ?? raw.tool_name ?? null)
  const toolInput = raw.toolArgs ?? raw.tool_input ?? null

  // Copilot reports a fresh session as "new"; the journal's vocabulary,
  // shared with the reference platform, calls that "startup".
  let source = asString(raw.source ?? null)
  if (source === 'new') source = 'startup'

  const created = normalizeTimestamp(raw.timestamp)

  return {
    ...raw,
    session_id: sessionId,
    cwd,
    source,
    user_message: prompt,
    prompt,
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: extractToolOutput(raw),
    transcript_path: asString(raw.transcript_path ?? raw.transcriptPath ?? null),
    assistant_message: asString(
      raw.assistant_message ?? raw.lastAssistantMessage ?? raw.response ?? null,
    ),
    ...(created !== null ? { created_at: created } : {}),
  }
}

/** Read stdin and normalize. Never throws: a hook that dies noisily on a
 *  malformed payload is worse than one that captures nothing. */
export function parseAndNormalize(): NormalizedInput {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(0, 'utf-8')) as Record<string, unknown>
  } catch {
    raw = {}
  }
  return normalizeCopilotPayload(raw)
}
