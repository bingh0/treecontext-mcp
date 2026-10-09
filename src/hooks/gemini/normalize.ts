/**
 * Gemini CLI hooks field normalization.
 *
 * Gemini uses the same base fields as Claude Code (session_id, cwd,
 * tool_name, tool_response, transcript_path) but with different event
 * names and a nested tool_response structure:
 *
 *   Gemini event     → Internal event
 *   ──────────────────────────────────
 *   BeforeAgent      → UserPromptSubmit
 *   AfterTool        → PostToolUse
 *   SessionStart     → SessionStart
 *   PreCompress      → PreCompact
 *
 *   Gemini field                      → Internal
 *   ──────────────────────────────────────────────
 *   session_id                        → session_id (same)
 *   cwd                               → cwd (same)
 *   prompt (BeforeAgent)              → prompt
 *   tool_name                         → tool_name (same)
 *   tool_input                        → tool_input (same)
 *   tool_response.llmContent          → tool_output (stringified)
 *   source (SessionStart)             → source (same)
 *   trigger (PreCompress)             → trigger (same)
 *
 * Output format uses hookSpecificOutput.additionalContext — same as
 * Claude Code.
 */

import * as fs from 'fs'

export interface NormalizedInput {
  session_id: string | null
  cwd: string | null
  source: string | null
  prompt: string | null
  tool_name: string | null
  tool_input: unknown
  tool_output: string | null
  transcript_path: string | null
  trigger: string | null
  [key: string]: unknown
}

export function parseAndNormalize(): NormalizedInput {
  let raw: Record<string, unknown>
  try {
    const stdin = fs.readFileSync(0, 'utf-8')
    raw = JSON.parse(stdin) as Record<string, unknown>
  } catch {
    return emptyInput()
  }

  // Gemini's AfterTool has tool_response as { llmContent, returnDisplay, error }
  let toolOutput: string | null = null
  const rawResponse = raw.tool_response
  if (typeof rawResponse === 'string') {
    toolOutput = rawResponse
  } else if (rawResponse && typeof rawResponse === 'object') {
    const resp = rawResponse as Record<string, unknown>
    if (resp.llmContent != null) {
      toolOutput = typeof resp.llmContent === 'string'
        ? resp.llmContent
        : JSON.stringify(resp.llmContent)
    } else if (resp.returnDisplay != null) {
      toolOutput = typeof resp.returnDisplay === 'string'
        ? resp.returnDisplay
        : JSON.stringify(resp.returnDisplay)
    } else if (resp.error != null) {
      toolOutput = `Error: ${typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error)}`
    }
  }

  return {
    ...raw,
    session_id: (raw.session_id ?? null) as string | null,
    cwd: (raw.cwd ?? null) as string | null,
    source: (raw.source ?? null) as string | null,
    prompt: (raw.prompt ?? null) as string | null,
    tool_name: (raw.tool_name ?? null) as string | null,
    tool_input: raw.tool_input ?? null,
    tool_output: toolOutput,
    transcript_path: (raw.transcript_path ?? null) as string | null,
    trigger: (raw.trigger ?? null) as string | null,
  }
}

function emptyInput(): NormalizedInput {
  return {
    session_id: null,
    cwd: null,
    source: null,
    prompt: null,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    transcript_path: null,
    trigger: null,
  }
}
