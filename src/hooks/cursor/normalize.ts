/**
 * Cursor hooks field normalization.
 *
 * Cursor uses its own hook system (~/.cursor/hooks.json) with these
 * key differences from the Claude Code convention:
 *
 *   Cursor                      → Internal
 *   ─────────────────────────────────────────────
 *   conversation_id             → session_id
 *   tool_output (string)        → tool_output (same, but named differently from Codex's tool_response)
 *   prompt (beforeSubmitPrompt) → prompt (same)
 *   trigger (preCompact)        → source mapped to trigger
 *   additional_context (output) → hookSpecificOutput.additionalContext
 *
 * Cursor also provides: generation_id, model, cursor_version,
 * workspace_roots, user_email, transcript_path — passed through.
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

  const sessionId = (raw.conversation_id ?? raw.session_id ?? null) as string | null
  const cwd = (raw.cwd ?? deriveWorkspaceRoot(raw) ?? null) as string | null
  const toolOutput = (raw.tool_output ?? raw.tool_response ?? null) as string | null

  return {
    ...raw,
    session_id: sessionId,
    cwd,
    source: (raw.source ?? null) as string | null,
    prompt: (raw.prompt ?? null) as string | null,
    tool_name: (raw.tool_name ?? null) as string | null,
    tool_input: raw.tool_input ?? null,
    tool_output: toolOutput,
    transcript_path: (raw.transcript_path ?? null) as string | null,
    trigger: (raw.trigger ?? null) as string | null,
  }
}

function deriveWorkspaceRoot(raw: Record<string, unknown>): string | null {
  const roots = raw.workspace_roots as string[] | undefined
  if (Array.isArray(roots) && roots.length > 0) return roots[0]!
  return null
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
