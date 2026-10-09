/**
 * Codex CLI hooks field normalization.
 *
 * Codex uses the same field names as Claude Code (session_id, cwd,
 * tool_name, tool_response, prompt, source, trigger). The only additions
 * are turn_id, model, permission_mode, and hook_event_name — which we
 * pass through but don't consume.
 *
 * This normalizer exists for consistency with other platform shims and
 * to future-proof against Codex field changes, but currently does
 * almost nothing beyond parsing stdin.
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

  return {
    ...raw,
    session_id: (raw.session_id ?? null) as string | null,
    cwd: (raw.cwd ?? null) as string | null,
    source: (raw.source ?? null) as string | null,
    prompt: (raw.prompt ?? null) as string | null,
    tool_name: (raw.tool_name ?? null) as string | null,
    tool_input: raw.tool_input ?? null,
    tool_output: (raw.tool_response ?? null) as string | null,
    transcript_path: (raw.transcript_path ?? null) as string | null,
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
  }
}
