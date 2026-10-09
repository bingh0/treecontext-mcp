/**
 * Dev-dogfood instrumentation for the recency-default ruling (owner,
 * 2026-07-26): each MCP query appends one JSONL line next to the store
 * file — what was asked, what returned (ages, roles), and for un-fused
 * relevance queries a SHADOW recency fusion at the reference weight, so
 * the paired "would fusion have changed what I saw" comparison
 * accumulates from real usage without changing any response.
 *
 * Observation only. Never wired into ranking (the feedback-tool fence:
 * signals earn ranking seats through a bench gate, not through use), and
 * a telemetry failure never surfaces to the caller.
 *
 * OPT-IN. Off unless TREECONTEXT_QUERY_TELEMETRY is set to 1/true/on.
 * Query text is the user's own words; recording it by default on someone
 * else's machine is not ours to assume. Beta testers are asked to opt in
 * explicitly (README), which is what makes the recency ruling's evidence
 * consented rather than collected.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The MCP query surface's default recency fusion weight (owner ruling
 *  2026-08-01). Promoted from the shadow arm's working hypothesis once
 *  the ruling landed; the library default stays 0. Explicit
 *  recency_weight: 0 opts a call out. */
export const DEFAULT_RECENCY_WEIGHT = 0.5

/** The shadow arm's fusion weight when a caller explicitly opts out —
 *  measures what the default would have served. (For fused responses the
 *  shadow arm runs at weight 0 instead: the pure lexical ordering.) */
export const SHADOW_RECENCY_WEIGHT = 0.5

export function telemetryEnabled(): boolean {
  const v = process.env['TREECONTEXT_QUERY_TELEMETRY']
  return v === '1' || v === 'true' || v === 'on'
}

/** The sink lives next to the store file, outside the journal — an
 *  instrument's output, not a captured event. */
export function telemetryPath(storePath: string): string {
  return join(dirname(storePath), 'query-telemetry.jsonl')
}

export function recordQueryTelemetry(storePath: string, line: Record<string, unknown>): void {
  try {
    // Mode applies on create — private, not umask-default (docs/security.md §3).
    appendFileSync(telemetryPath(storePath), JSON.stringify(line) + '\n', { mode: 0o600 })
  } catch {
    // The instrument never breaks the query.
  }
}
