/**
 * C2 — dual caps: the FTS index text is a bounded *view* derived from the
 * decoded stored content plus a node's metadata, never the stored content
 * itself. `indexTextFor` is pure and deterministic so it can be recomputed
 * identically at insert, update, AND delete time: FTS5 contentless tables
 * require the exact original indexed text on delete/update, and metadata_json
 * is persisted alongside content, so (decoded content, parsed metadata) is
 * always enough to reconstruct what was indexed — no separate bookkeeping
 * table needed.
 */
import { INDEX_CAP_ASSISTANT, INDEX_CAP_USER } from './capture-constants.js'

export { INDEX_CAP_ASSISTANT, INDEX_CAP_USER }

/**
 * Metadata key a caller can set to force an exact index-text length,
 * bypassing the role-based caps below entirely. This is the mechanism C4
 * uses for tool-event full-fidelity staging: the hook/ingestion pipeline
 * concatenates preview+full into one content string and records where the
 * preview ends here, so the FTS index only ever sees the preview — the
 * recompute at delete/update time reads this same marker back out of
 * metadata_json and reproduces the identical slice.
 */
export const EXPLICIT_INDEX_LEN_KEY = '_index_len'

/**
 * Metadata key for the DISPLAY boundary — where a hit's presented preview
 * ends. Split from `_index_len` when the indexed view widened past the
 * preview (schema 18): `indexTextFor` never reads this; it exists for the
 * read side (flat-store `presentContent`), which prefers it over
 * `_index_len` so an 8000-char FTS view doesn't flood hit payloads. Rows
 * without it display up to `_index_len`, the pre-018 behavior.
 */
export const EXPLICIT_PREVIEW_LEN_KEY = '_preview_len'

/**
 * Compute the text that should enter (or be recomputed against) `nodes_fts`
 * for a given piece of decoded content + its metadata.
 *
 * Precedence:
 *  1. An explicit `_index_len` marker in metadata always wins (C4 tool
 *     full-fidelity marker).
 *  2. Non-auto-capture content (agent-authored / curated layer, i.e.
 *     `metadata.source !== 'auto-capture'`) is indexed in full — never
 *     regress the curated layer.
 *  3. Auto-captured `role: 'user'` is capped at INDEX_CAP_USER.
 *  4. Auto-captured `role: 'assistant'` WITHOUT a `tool_name` (real
 *     assistant prose, e.g. the Stop-hook response capture) is capped at
 *     INDEX_CAP_ASSISTANT. WITH a `tool_name` (a post-tool-use preview) the
 *     content is indexed as-is — hooks already compose the preview string
 *     as the index form, so no further truncation applies.
 *  5. Everything else (tool_result, snapshot, ...) is indexed as-is.
 */
/**
 * Compute the text a row's stored content may be shrunk to by the C3
 * byte-budget demotion sweep. Distinct from `indexTextFor` since schema 18:
 * the index view widened (full prose, 8000-char tool views), so "shrink to
 * the index text" would leave post-018 rows unshrinkable and disable the
 * budget valve entirely. Demotion instead targets the narrowest defensible
 * boundary — the display cut (`_preview_len`), the staged index boundary,
 * and for prose the frozen legacy caps — reproducing what the sweep did for
 * every pre-018 row shape while giving post-018 rows a real floor.
 * Marker-less tool rows (JF-3 fitting events) stay unshrinkable: their
 * composed preview IS the content.
 */
export function demotionTextFor(content: string, meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return content
  if (meta['source'] !== 'auto-capture') return content

  const bounds: number[] = []
  const preview = meta[EXPLICIT_PREVIEW_LEN_KEY]
  if (typeof preview === 'number' && Number.isFinite(preview) && preview >= 0) bounds.push(preview)
  const explicit = meta[EXPLICIT_INDEX_LEN_KEY]
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) bounds.push(explicit)

  const role = meta['role']
  if (role === 'user') bounds.push(INDEX_CAP_USER)
  else if (role === 'assistant' && meta['tool_name'] == null) bounds.push(INDEX_CAP_ASSISTANT)

  if (bounds.length === 0) return content
  return content.slice(0, Math.min(...bounds))
}

export function indexTextFor(content: string, meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return content

  const explicitLen = meta[EXPLICIT_INDEX_LEN_KEY]
  if (typeof explicitLen === 'number' && Number.isFinite(explicitLen) && explicitLen >= 0) {
    return content.slice(0, explicitLen)
  }

  if (meta['source'] !== 'auto-capture') return content

  const role = meta['role']
  if (role === 'user') return content.slice(0, INDEX_CAP_USER)
  if (role === 'assistant') {
    if (meta['tool_name'] != null) return content
    return content.slice(0, INDEX_CAP_ASSISTANT)
  }
  return content
}

/** Serve lifted boundary columns under their metadata names (G5, the
 *  final-shape read flip): where a column value exists it is
 *  authoritative — every read that computes on a boundary goes through
 *  this before indexTextFor/demotionTextFor/display cuts, so a row
 *  whose column and metadata copy ever diverge (a backfill-skipped
 *  row healed later, a foreign import) reads the engine's truth. A NULL
 *  column leaves the metadata copy alone: read-side validation
 *  (boundaryOf) already ignores invalid values. Mutates and returns
 *  `meta` (or a fresh object when meta is null and a column exists). */
export function applyLiftedBoundaries(
  meta: Record<string, unknown> | null,
  indexLen: number | null | undefined,
  previewLen: number | null | undefined,
): Record<string, unknown> | null {
  if (indexLen == null && previewLen == null) return meta
  // Copy-on-write: callers today pass freshly parsed objects, but a
  // future caller passing a shared one must not get column values
  // spliced into it (G5 review).
  const out: Record<string, unknown> = { ...meta }
  if (indexLen != null) out[EXPLICIT_INDEX_LEN_KEY] = indexLen
  if (previewLen != null) out[EXPLICIT_PREVIEW_LEN_KEY] = previewLen
  return out
}
