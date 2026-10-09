/**
 * Dedup identity: the three pure functions that decide which rows are
 * "the same" for dedup purposes. Extracted from flat-store.ts for
 * program G (store-as-arbiter): migration 021's backfill must compute
 * fingerprint class and session key byte-identically to the insert
 * path, and a migration cannot import flat-store without a cycle —
 * so both import this leaf module instead.
 */

/** Sentinel session key for rows with no resolvable session identity.
 *  Deliberately not NULL: dedup windows, retention grouping, and the
 *  session_key column all group "unresolved" rows together under it. */
export const NO_SESSION = '__nosession__'

// Session-key grouping (docs/session-identity.md §3, Fix
// 1). `session_id` and `_cc_session_id` are the SAME namespace (both hold
// the real Claude Code session UUID) — `session_id` on hook-captured
// events, `_cc_session_id` on notes inserted through the fixed MCP server.
// `_session_id` (the MCP connection id, historically miscoalesced into this
// same key) is kept ONLY as the last-resort fallback for legacy rows that
// predate this fix and never got a `_cc_session_id` — new rows always carry
// `_cc_session_id` (or neither, if genuinely unresolved; see the ladder in
// server.ts), so a row only reaches this branch if it's pre-fix data.
// Append-only store discipline: historical rows are never rewritten — with
// ONE sanctioned exception, the V2 echo heal (docs/session-identity.md
// §7.3, Persistence.healCuratedSessionIdentity), which upgrades a curated
// row's session-identity metadata and its session_key column from causal
// echo evidence and touches nothing else. The legacy `_session_id`
// fallback stays indefinitely regardless: the heal writes
// `_cc_session_id`, so healed rows leave this branch, never re-enter it.
export function sessionOf(meta: Record<string, unknown> | null): string {
  if (!meta) return NO_SESSION
  const hookOrNoteId = meta['session_id'] ?? meta['_cc_session_id']
  if (hookOrNoteId !== undefined && hookOrNoteId !== null) return String(hookOrNoteId)
  const legacyConnId = meta['_session_id']
  if (legacyConnId !== undefined && legacyConnId !== null) return String(legacyConnId)
  return NO_SESSION
}

/** Dedup class (D2/JF-11): auto-capture and curated content never dedup
 *  against each other. */
export function isAutoCaptureSource(source: string | null | undefined): boolean {
  return source === 'auto-capture'
}

/** The one classification every writer and backfill shares: a row's
 *  dedup class, from its label and metadata. Anchor-writing decisions
 *  must use THIS, never a re-derivation - a ladder rung added to
 *  effectiveSource reaches every consumer together or dedup silently
 *  diverges between paths. */
export function dedupClassOf(
  sourceLabel: string | null | undefined,
  meta: Record<string, unknown> | null,
): 'auto' | 'curated' {
  return isAutoCaptureSource(effectiveSource(sourceLabel, meta)) ? 'auto' : 'curated'
}

/** The source ladder every classifying site uses: explicit label first,
 *  then the metadata annotation. One copy — a new rung added here reaches
 *  the insert path, import, merge, and the 021/022 backfills together. */
export function effectiveSource(
  sourceLabel: string | null | undefined,
  meta: Record<string, unknown> | null,
): string | null {
  return sourceLabel ?? (meta?.['source'] as string | undefined) ?? null
}

/** Tolerant metadata parse: absent or malformed JSON is null, never a
 *  throw — a row's classification must not die on its annotation. */
export function parseMeta(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Boundary lift through the read-side validity rule (boundaryOf: a
 *  boundary is real only when 0 <= len < content length). A
 *  present-but-invalid value falls through safely in the metadata
 *  ladder, but a column COALESCE would use it raw — so invalid-present
 *  normalizes to NULL wherever a boundary becomes a column value.
 *  Lossless: the metadata copy keeps the original. */
export function liftBoundary(raw: unknown, contentLength: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const len = Math.trunc(raw)
  return len >= 0 && len < contentLength ? len : null
}

/** The reliance count exactly as the retention reader scores it:
 *  Number() coercion (a foreign "7" counts as 7), finite-guarded
 *  (junk like "many" is 0, never NaN), NOT truncated — the eviction
 *  comparator sorts on this value, so the lifted column must agree
 *  with it to the decimal. */
export function reliedCountOf(meta: Record<string, unknown> | null): number {
  const raw = Number(meta?.['_relied_count'] ?? 0)
  return Number.isFinite(raw) ? raw : 0
}

/** The read-side session policy, in one place (G5 review): the
 *  session_key COLUMN is the truth; a NULL column (a backfill-skipped
 *  undecodable row) falls back to the metadata ladder. Window keying
 *  and retention grouping must agree on a row's session or
 *  whole-session eviction holes the conversation fabric — so they both
 *  call THIS. The thunk keeps the metadata parse lazy: the common row
 *  never parses at all. */
export function resolveSessionKey(
  column: string | null | undefined,
  meta: () => Record<string, unknown> | null,
): string {
  return column ?? sessionOf(meta())
}
