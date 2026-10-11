/**
 * D261 — a treecontext echo enters the search index by its tool name, or
 * by the arguments of a call that changes the store.
 *
 * An echo is the PostToolUse capture of a treecontext tool call: the row
 * whose `tool_name` ends in `__treecontext_<tool>` (see echoToolOf), composed by the hook as
 * `Tool: <name>\n[Label: <label>\n]Input:\n<input>\nOutput:\n<output>`, the
 * input and output written as their text since D270 (JSON before it)
 * (plus a full tail after the C4 separator when the preview truncated). It
 * is stored in full and displayed in full; only its reach into the FTS index
 * narrows, because its Output repeats what other rows already index (a
 * query's hits, an insert's note, a status call's resume pointers): a
 * query, insert, export or status echo indexes its tool name only, an
 * import echo its tool name and label, a delete, merge or clear echo what
 * it was given.
 *
 * The rule lives in the stamp, never in the recompute: `indexTextFor` keeps
 * slicing at `_index_len`, so every binary, a beta.1 server included,
 * recomputes the same index text on update and delete. This module computes
 * the boundary and the stamp; the drain, the import door and migration 028
 * all call it, so the three cannot drift.
 */
import { EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './index-text.js'
import { FULL_TAIL_SEPARATOR, OUTPUT_SECTION_LABEL } from './capture-constants.js'

/** The separator ahead of a treecontext tool's own name in an echo's tool
 *  name: `mcp__<server key>__treecontext_<tool>`. The server key is the
 *  client's choice (the installer writes `treecontext`); only the suffix is
 *  ours, so an echo is recognized by it under any key. */
const ECHO_SUFFIX_MARK = '__treecontext_'
const ECHO_TOOL_RE = /^treecontext_[a-z]+(?:_[a-z]+)*$/

/** The line the hook writes ahead of an import echo's Input (D261). */
export const ECHO_LABEL_PREFIX = 'Label: '

/** Tools whose echo indexes its first line only (the tool name). A query
 *  echo is among them (ruled 2026-10-10 on the mature-journal
 *  counterfactual): indexing its own query text made it the best match
 *  for every repeat of that query, ahead of the notes it exists to find. */
const FIRST_LINE_TOOLS = new Set(['treecontext_query', 'treecontext_insert', 'treecontext_export', 'treecontext_status'])

/** The treecontext tool an echo's tool name names (`treecontext_query`
 *  for `mcp__<key>__treecontext_query`), or null when it names none. The
 *  one echo predicate: the drain, the import door, migration 028, the hook
 *  and the echo heals (echo-correlation.ts) all recognize an echo by it. */
export function echoToolOf(toolName: unknown): string | null {
  if (typeof toolName !== 'string') return null
  const at = toolName.lastIndexOf(ECHO_SUFFIX_MARK)
  if (at === -1) return null
  const tool = toolName.slice(at + 2)
  return ECHO_TOOL_RE.test(tool) ? tool : null
}

/** True when `toolName` names a treecontext tool call's echo. */
export function isTreecontextEcho(toolName: unknown): toolName is string {
  return echoToolOf(toolName) !== null
}

function firstLineEnd(content: string): number {
  const nl = content.indexOf('\n')
  return nl === -1 ? content.length : nl
}

/**
 * Where an echo's index text ends, in UTF-16 code units on the exact
 * stored string, or null when `toolName` is not a treecontext echo.
 *
 * - delete, merge_from_agent, clear (and any other treecontext tool):
 *   the end of the Input section, everything before the first `\nOutput:`
 *   (else before the full-tail separator, else the whole content).
 * - query, insert, export, status: the end of the first line, the tool name.
 * - import: the end of the `Label:` line when the second line is one, else
 *   the end of the first line. An import echo stored before the rule has no
 *   Label line and so matches its tool name only.
 */
export function echoIndexBoundary(toolName: unknown, content: string): number | null {
  const tool = echoToolOf(toolName)
  if (tool === null) return null
  const first = firstLineEnd(content)
  if (FIRST_LINE_TOOLS.has(tool)) return first
  if (tool === 'treecontext_import') {
    if (first < content.length && content.startsWith(ECHO_LABEL_PREFIX, first + 1)) {
      const nl = content.indexOf('\n', first + 1)
      return nl === -1 ? content.length : nl
    }
    return first
  }
  const out = content.indexOf(`\n${OUTPUT_SECTION_LABEL}`)
  if (out !== -1) return out
  const full = content.indexOf(`\n${FULL_TAIL_SEPARATOR}\n`)
  return full === -1 ? content.length : full
}

/**
 * The metadata an echo row carries under D261: `_index_len` at its
 * arguments boundary (never wider than a boundary it already carries), and
 * `_preview_len` at its display boundary: the one it carries, else the old
 * `_index_len` (the pre-018 shape, where one number was both), else the
 * whole content. The display boundary is stamped even when the echo fits,
 * so the read side never mistakes the narrow index boundary for a display
 * cut. Returns `meta` itself, untouched, for anything that is not an
 * auto-captured treecontext echo; otherwise a fresh object. Idempotent.
 */
export function stampEchoBoundaries(
  content: string,
  meta: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!meta || meta['source'] !== 'auto-capture') return meta
  const boundary = echoIndexBoundary(meta['tool_name'], content)
  if (boundary === null) return meta
  const validLen = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null
  const oldIndex = validLen(meta[EXPLICIT_INDEX_LEN_KEY])
  const oldPreview = validLen(meta[EXPLICIT_PREVIEW_LEN_KEY])
  return {
    ...meta,
    [EXPLICIT_INDEX_LEN_KEY]: oldIndex === null ? boundary : Math.min(oldIndex, boundary),
    [EXPLICIT_PREVIEW_LEN_KEY]: Math.min(oldPreview ?? oldIndex ?? content.length, content.length),
  }
}
