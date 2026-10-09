/**
 * Echo correlation (docs/session-identity.md §7.3 as amended by the
 * §7.7 design review, R1; §7.8 status channel).
 *
 * The PostToolUse hook stages an echo of every treecontext tool call:
 * `Tool: <name>\nInput:\n{json}\nOutput:\n{json}`. For a successful
 * `treecontext_insert` the Output section is the platform's
 * serialization of the tool's own response — `node_id` first key,
 * `deduplicated` flag alongside, both inside the 1000-char output
 * preview cap in every observed case (live-store sweep 2026-08-15:
 * 23/23 echoes, id at offset ≈30 of the section). Correlating by that
 * id is exact and causal: the echo names the row its call touched,
 * with no clocks, no content comparison, and no tree scoping.
 *
 * A failed insert's Output is the sanitized error payload — no
 * node_id, so failed calls extract to null and heal nothing. A missing
 * Output section (the platform sent no tool_response) extracts to null
 * the same way: no extraction, no heal, never an invented id.
 */
import { FULL_TAIL_SEPARATOR, OUTPUT_SECTION_LABEL } from '../persistence/capture-constants.js'

const FULL_MARKER = `\n${FULL_TAIL_SEPARATOR}\n`
const OUTPUT_MARKER = `\n${OUTPUT_SECTION_LABEL}\n`

/** Matches the response node id through 0–2 levels of JSON escaping —
 *  the staged echo carries the platform's serialization of the MCP
 *  response, and platforms differ in how many times the inner JSON is
 *  stringified. Escaping compounds: level 1 puts one backslash before
 *  the quote, level 2 puts three (`\` → `\\` plus `"` → `\"`), so the
 *  quantifier admits up to 3. Node ids are 32 lowercase hex chars
 *  (uuid4, no dashes). */
const NODE_ID_RE = /node_id\\{0,3}"\s*:\s*\\{0,3}"([0-9a-f]{32})/
const DEDUP_RE = /deduplicated\\{0,3}"\s*:\s*(true|false)/

/**
 * The preview's Output section — the only slice the extractors read.
 *
 * Bounds, in trust order: `previewLen` (the producer-stamped boundary
 * column, present whenever a FULL tail follows — authoritative and not
 * content-derived), else the first FULL marker (for tail-less rows any
 * such marker is inside user content, and cutting there fails closed).
 * Within the preview the LAST Output marker wins: the Input section
 * precedes the real Output in the composition, so a marker embedded in
 * raw-string tool input can only appear earlier — a spoof can suppress
 * extraction, never redirect it (review 2026-08-15, #7). Residual:
 * only when the platform delivers RAW-STRING input for a suffix-matched
 * tool AND the call produced no output at all can crafted input become
 * the section; the reference platform sends object inputs, which
 * JSON.stringify escapes.
 */
function outputSection(content: string, previewLen?: number | null): string | null {
  let preview: string
  if (previewLen != null && previewLen > 0 && previewLen <= content.length) {
    preview = content.slice(0, previewLen)
  } else {
    const fullIdx = content.indexOf(FULL_MARKER)
    preview = fullIdx === -1 ? content : content.slice(0, fullIdx)
  }
  const outIdx = preview.lastIndexOf(OUTPUT_MARKER)
  if (outIdx === -1) return null
  return preview.slice(outIdx)
}

export interface InsertEcho {
  /** The curated row this insert call touched. */
  nodeId: string
  /** True when the call deduplicated onto an existing curated row: the
   *  echo's session asserted the content but did not create the row. */
  deduplicated: boolean
}

/** True for the staged echo of a treecontext_insert call, whatever
 *  server key the client config registered the MCP server under — the
 *  `mcp__<key>__` prefix is the client's, only the suffix is ours.
 *  Foreign-STORE insert echoes are harmless: their node ids resolve
 *  nowhere here ('not-found'), so they neither heal nor publish. */
export function isInsertEchoTool(toolName: string | null | undefined): boolean {
  return typeof toolName === 'string' && toolName.endsWith('__treecontext_insert')
}

export function extractInsertEcho(content: string, previewLen?: number | null): InsertEcho | null {
  const section = outputSection(content, previewLen)
  if (!section) return null
  const idMatch = NODE_ID_RE.exec(section)
  if (!idMatch) return null
  const dedupMatch = DEDUP_RE.exec(section)
  // Flag not visible → read it as a dedup hit, the cautious branch: a
  // false "creator" claim could stamp the wrong session as exact, while
  // a false "dedup" reading can only add a disclosed candidate.
  return { nodeId: idMatch[1]!, deduplicated: dedupMatch ? dedupMatch[1] === 'true' : true }
}

/** True for the staged echo of a treecontext_status call — the §7.8
 *  namespace channel: the status response names its serving namespace
 *  inside the output cap (live sweep 2026-08-15: 6/6 echoes, offset
 *  ≈187), and the orientation protocol fires one at every session
 *  start. */
export function isStatusEchoTool(toolName: string | null | undefined): boolean {
  return typeof toolName === 'string' && toolName.endsWith('__treecontext_status')
}

/** Key match requires the quote directly after the key name, so
 *  `exclude_namespaces` / `namespace_weights` (query-input keys) can
 *  never match. The value run is unbounded with a lookahead requiring
 *  its closing quote (or escape) — a value truncated by the output cap
 *  extracts nothing rather than a wrong-but-valid prefix (review
 *  2026-08-15, C#2).
 *
 *  ORDER-DEPENDENT, deliberately pinned: the FIRST match in the
 *  section wins, which is safe only because the status response
 *  serializes its genuine `namespace` field before `resume_pointers`,
 *  whose previews are journal content and can carry spoof-shaped text.
 *  Reordering the status response's fields would hand this regex
 *  attacker-influenced input — the pin in echo-heal.test.ts exists to
 *  make that reorder fail loudly (Fable review 2026-08-20, F6). */
const STATUS_NS_RE = /namespace\\{0,3}"\s*:\s*\\{0,3}"([A-Za-z0-9._-]+)(?=\\|")/
const STATUS_PATH_RE = /store_path\\{0,3}"\s*:\s*\\{0,3}"/

/**
 * The serving namespace a status echo discloses — but ONLY when the
 * echo demonstrably describes `expectedStorePath`'s own store. The
 * status tool's suffix matches under any client server key, and a
 * session may register a second treecontext server over a DIFFERENT
 * store; without this guard its echo would publish a foreign store's
 * namespace into this store's annotations and misroute the whole
 * session's capture (review 2026-08-15, C#1). The response's
 * `store_path` field is the discriminator: present in the same capped
 * output slice, and equal to this drain's storePath exactly when the
 * echo is ours. Match fails → null: fail closed, publish nothing.
 */
export function extractStatusNamespace(
  content: string,
  expectedStorePath: string,
  previewLen?: number | null,
): string | null {
  const section = outputSection(content, previewLen)
  if (!section) return null
  const pathKey = STATUS_PATH_RE.exec(section)
  if (!pathKey) return null
  const afterKey = section.slice(pathKey.index + pathKey[0].length)
  // The path value as the platform serialized it: one or two levels of
  // JSON escaping over the raw path. Paths without quotes/backslashes
  // (every POSIX store path) escape to themselves.
  const once = JSON.stringify(expectedStorePath).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  const matched = afterKey.startsWith(once) ? once : afterKey.startsWith(twice) ? twice : null
  if (matched === null) return null
  // The value must END where our path ends. A bare prefix test only
  // rejects foreign paths SHORTER than ours; one that EXTENDS ours —
  // `/x/y.db.old/treecontext.db` against `/x/y.db`, a backup directory
  // beside the store — would sail through and misroute the session,
  // which is the exact cross-store confusion C#1 exists to stop.
  // Terminator is the value's closing quote through 0-3 escape levels
  // (same tolerance as STATUS_NS_RE). The quote itself is REQUIRED: a
  // lone backslash is not a terminator, or a foreign path continuing
  // with a literal `\` after our prefix would pass (Fable review
  // 2026-08-20, F5).
  if (!/^\\{0,3}"/.test(afterKey.slice(matched.length))) return null
  const m = STATUS_NS_RE.exec(section)
  return m ? m[1]! : null
}
