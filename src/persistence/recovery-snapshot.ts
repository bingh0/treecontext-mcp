/**
 * The recovery snapshot row — what the drain writes when a session starts
 * after a compaction (D286, the 0.1.0-beta.2.1 hotfix).
 *
 * PreCompact records the recovery queries; the next session-start claims
 * them and stages a `snapshot` row; the drain runs the queries and writes
 * ONE row quoting what they found. From beta.1 to beta.2 that row quoted
 * every hit whole, carried no boundary, and sat in the note column: a
 * curated-looking row that held the literal recovery-query text, so it was
 * the best match for its own queries at the next compaction and quoted
 * itself again. Rows compounded geometrically per compaction (94 K, 370 K,
 * 1.4 M, 5.5 M, 21 M chars on one store, 2026-10-27 to 10-29) until a
 * single treecontext_query reply crossed Claude Code's 16 MB stdio message
 * guard and the client dropped the server.
 *
 * The rules, spelled once for the drain, the migration that heals existing
 * rows, and the tests:
 *  - a recovery row never quotes another recovery row;
 *  - each hit is quoted at its display view and no further than
 *    RECOVERY_QUOTE_CAP, named by its entry id so the quote is followable;
 *  - the query text lives in metadata, never in the indexed content;
 *  - the row carries its own display and index boundaries, so a hit on
 *    it is bounded exactly like a tool event's.
 */
import { INDEX_CAP_TOOL_DEFAULT } from './capture-constants.js'
import { EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './index-text.js'

/** `metadata.source` of a recovery row. */
export const RECOVERY_SNAPSHOT_SOURCE = 'recovery-snapshot'
/** `metadata.recovery_queries`: the queries the row answers (D286). */
export const RECOVERY_QUERIES_KEY = 'recovery_queries'
/** How much of one hit a recovery row quotes, at most. */
export const RECOVERY_QUOTE_CAP = 2000
/** The display boundary of a recovery row: a hit on it shows this much. */
export const RECOVERY_PREVIEW_LEN = 2000
/** The index boundary of a recovery row: the tool default (D4). */
export const RECOVERY_INDEX_LEN = INDEX_CAP_TOOL_DEFAULT
/** Hits asked for per recovery query. */
export const RECOVERY_HITS_PER_QUERY = 3

export function isRecoverySnapshot(meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.['source'] === RECOVERY_SNAPSHOT_SOURCE
}

export interface RecoveryHit {
  nodeId: string
  /** The hit's content as the store presents it (already at its display view). */
  content: string
  metadata: Record<string, unknown> | null
}

/** One quoted hit: its id, then its content cut at RECOVERY_QUOTE_CAP with
 *  an availability marker naming the export door. */
export function quoteRecoveryHit(hit: RecoveryHit): string {
  const text = hit.content
  const body = text.length > RECOVERY_QUOTE_CAP
    ? `${text.slice(0, RECOVERY_QUOTE_CAP)}…[quoted to ${RECOVERY_QUOTE_CAP} chars; full content ${text.length} chars via treecontext_export(${hit.nodeId})]`
    : text
  return `## entry ${hit.nodeId}\n${body}\n\n`
}

/** The row's content: for each query, the hits that are not recovery rows
 *  themselves, quoted. A query with nothing to quote still leaves a line, so
 *  the row says what it looked for and found nothing. */
export function buildRecoveryContent(queries: string[], hitsByQuery: RecoveryHit[][]): string {
  let out = ''
  queries.forEach((_q, i) => {
    const hits = (hitsByQuery[i] ?? []).filter((h) => !isRecoverySnapshot(h.metadata)).slice(0, RECOVERY_HITS_PER_QUERY)
    out += `# Recovery ${i + 1} of ${queries.length}\n\n`
    if (hits.length === 0) out += '(nothing to quote)\n\n'
    for (const h of hits) out += quoteRecoveryHit(h)
  })
  return out
}

/** The boundaries every recovery row carries (D286): display at
 *  RECOVERY_PREVIEW_LEN, index at RECOVERY_INDEX_LEN, each no longer than
 *  the content. Pure, so the drain and the migration stamp identically. */
export function recoverySnapshotBoundaries(contentLength: number): Record<string, number> {
  return {
    [EXPLICIT_INDEX_LEN_KEY]: Math.min(RECOVERY_INDEX_LEN, contentLength),
    [EXPLICIT_PREVIEW_LEN_KEY]: Math.min(RECOVERY_PREVIEW_LEN, contentLength),
  }
}
