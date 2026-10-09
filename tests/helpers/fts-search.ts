/**
 * Test-only FTS5 inspection helper: run a bm25 query against `nodes_fts`
 * exactly the way the pin suites need to verify what the index holds.
 * Production ranking lives in FlatStore.query — this helper exists so tests
 * can probe index contents without going through the full query surface.
 */

import type { Database } from '../../src/persistence/database.js'
import type { RoleWeights } from '../../src/core/types.js'
import { roleWeightVector } from '../../src/persistence/fts.js'

export interface FtsHit {
  nodeId: string
  score: number
}

/** Wrap a query in double quotes so FTS5 treats it as a literal phrase. */
export function escapeFtsQuery(query: string): string {
  const escaped = query.replace(/"/g, '""').trim()
  if (!escaped) return ''
  return `"${escaped}"`
}

/**
 * Run an FTS5 BM25 query and return node IDs with positive-oriented
 * scores (higher = better match), best-first. `roleWeights` defaults to
 * the production DEFAULT_ROLE_WEIGHTS via roleWeightVector.
 */
export function ftsSearch(
  db: Database,
  query: string,
  limit: number,
  roleWeights?: RoleWeights,
): FtsHit[] {
  const phrase = escapeFtsQuery(query)
  if (!phrase || limit <= 0) return []

  const weights = roleWeightVector(roleWeights)
  const stmt = db.prepare(
    'SELECT n.node_id AS node_id, bm25(nodes_fts, ?, ?, ?, ?) AS raw_score ' +
      'FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid ' +
      'WHERE nodes_fts MATCH ? ' +
      'ORDER BY raw_score ASC ' +
      'LIMIT ?',
  )
  const rows = stmt.all(...weights, phrase, limit)
  return rows.map((row) => ({
    nodeId: String((row as { node_id: unknown }).node_id),
    score: -Number((row as { raw_score: unknown }).raw_score ?? 0),
  }))
}
