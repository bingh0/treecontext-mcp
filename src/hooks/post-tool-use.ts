import { resolveDbPath, writeStaging, parseHookInput, isDirectInvocation, payloadWriter } from './shared.js'
import {
  STORE_SAFETY_CAP,
  TOOL_INPUT_PREVIEW_CAP,
  TOOL_OUTPUT_PREVIEW_CAP,
  FULL_TAIL_SEPARATOR,
  activeIndexCap,
} from '../persistence/capture-constants.js'
import { dbg } from '../debug.js'

/** Separator between the indexed preview and the full tail (C4).
 *  Re-exported from capture-constants, which OWNS it: no longer merely
 *  cosmetic since the V2 extractors bound their scans on this exact
 *  string when a row carries no preview_len (`echo-correlation.ts`
 *  outputSection). Two declarations could drift; one cannot. */
export { FULL_TAIL_SEPARATOR }

export function main(preParsed?: Record<string, unknown>) {
  try {
    const input = preParsed ?? parseHookInput()
    // Claude Code's PostToolUse payload carries the result as
    // `tool_response`; the codex/cursor normalizers map their shapes to
    // `tool_output`. Accept both — reading only `tool_output` left the
    // flagship platform's journal INPUT-ONLY (verified: hundreds of
    // captured tool events, zero genuine Output sections).
    const { session_id, cwd, tool_name, tool_input } = input
    const tool_output = input.tool_output ?? input.tool_response

    dbg('hook:post-tool', 'invoked', { tool_name: tool_name ?? null, cwd: cwd ?? null, hasInput: !!tool_input, hasOutput: !!tool_output })

    if (!tool_name) {
      dbg('hook:post-tool', 'no tool_name — skipping')
      process.exit(0)
      return
    }

    // Trail-class tools (repo readers). The charter (journal-capture) says
    // no invocation is ever filtered out — the trail is how a future agent
    // reconstructs what was being worked on — but their OUTPUT is repo
    // content at that moment, re-derivable from the working tree and git
    // history, so it keeps only the bounded preview and never stages a
    // full-fidelity tail. Execution/external outputs (Bash, web, MCP) are
    // historical facts and keep the C4 tail below.
    const trailTools = ['Read', 'Glob', 'Grep', 'LS', 'View', 'ListDir']
    const isTrail = trailTools.includes(tool_name)

    // Priority assignment
    let priority = 3
    if (['Edit', 'Write', 'NotebookEdit'].includes(tool_name)) {
      priority = 1
    } else if (tool_name === 'Bash') {
      priority = 2
    }

    const safeToolInput = typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input) || ''
    const safeToolOutput = typeof tool_output === 'string' ? tool_output : JSON.stringify(tool_output) || ''

    // Preview: byte-for-byte the pre-C4 composition — it is the FTS index
    // view, so ranking must not shift.
    let preview = `Tool: ${tool_name}\n`
    let inputOverflow = false
    if (safeToolInput) {
      inputOverflow = safeToolInput.length > TOOL_INPUT_PREVIEW_CAP
      preview += `Input:\n${safeToolInput.substring(0, TOOL_INPUT_PREVIEW_CAP)}${inputOverflow ? '...' : ''}\n`
    }
    let shielded = false
    let outputOverflow = false
    if (safeToolOutput) {
      let handledAsShielded = false
      if (safeToolOutput.includes('"shielded":true') || safeToolOutput.includes('"shielded": true')) {
        try {
          const ref = JSON.parse(safeToolOutput)
          if (ref.shielded && ref.file) {
            preview += `Output: [shielded to ${ref.file}, ${ref.bytes} bytes]\n`
            shielded = true
            handledAsShielded = true
          }
        } catch {
          // fall through to the normal preview below
        }
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

    const dbPath = resolveDbPath(cwd)

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
    })

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
