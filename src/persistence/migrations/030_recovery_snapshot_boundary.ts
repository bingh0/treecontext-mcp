import type { Migration } from '../migrations.js'
import type { Database } from '../database.js'
import { hasTable } from './guards.js'
import { decodeContent } from '../content-codec.js'
import { indexTextFor, applyLiftedBoundaries, EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from '../index-text.js'
import { columnForIndex, ftsColumnValues, FTS_COLUMNS } from '../fts-columns.js'
import { liftBoundary, parseMeta } from '../../dedup-identity.js'
import { RECOVERY_SNAPSHOT_SOURCE, recoverySnapshotBoundaries } from '../recovery-snapshot.js'

/**
 * D286 (the 0.1.0-beta.2.1 hotfix): every recovery-snapshot row a store
 * already holds gets the boundaries the drain now stamps, so a hit on it
 * is a bounded preview and its reach into the index is the tool default,
 * not its whole text. From beta.1 to beta.2 these rows quoted whole hits,
 * themselves included, and compounded per compaction; on one store the
 * newest was 21 M chars and one treecontext_query reply crossed the
 * client's 16 MB stdio message guard.
 *
 * Stored content is never touched (the retention stance: never destroy);
 * the row keeps its words, and treecontext_export still returns all of
 * them. What changes is the display cut and the indexed view: the OLD
 * index text is recomputed from the row's old stamp through its boundary
 * columns (the contentless-FTS delete form), the new one inserted from the
 * new stamp. A row already at its boundaries is left alone, so the pass is
 * idempotent. Runs inside the runner's one additive transaction; the
 * version makes it run once.
 */
export interface RecoveryBoundaryPass {
  scanned: number
  healed: number
}

export function healRecoverySnapshotBoundaries(db: Database): RecoveryBoundaryPass {
  const rows = db.prepare(
    'SELECT rowid, content, metadata_json, index_col, index_len, preview_len FROM nodes ' +
      "WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.source') = ? ORDER BY rowid",
  ).all(RECOVERY_SNAPSHOT_SOURCE) as Array<{
    rowid: number; content: unknown; metadata_json: string; index_col: number | null
    index_len: number | null; preview_len: number | null
  }>
  const write = db.prepare('UPDATE nodes SET metadata_json = ?, index_len = ?, preview_len = ? WHERE rowid = ?')
  const ftsDelete = db.prepare(
    `INSERT INTO nodes_fts(nodes_fts, rowid, ${FTS_COLUMNS.join(', ')}) VALUES ('delete', ?, ?, ?, ?, ?)`,
  )
  const ftsInsert = db.prepare(`INSERT INTO nodes_fts(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`)
  let healed = 0
  for (const r of rows) {
    const stored = parseMeta(r.metadata_json)
    if (!stored) continue
    let content: string
    try { content = decodeContent(r.content as string | Buffer | null) } catch { continue }
    const oldMeta = applyLiftedBoundaries(stored, r.index_len, r.preview_len)
    const merged = { ...stored, ...recoverySnapshotBoundaries(content.length) }
    const indexLen = liftBoundary(merged[EXPLICIT_INDEX_LEN_KEY], content.length)
    const previewLen = liftBoundary(merged[EXPLICIT_PREVIEW_LEN_KEY], content.length)
    if (
      stored[EXPLICIT_INDEX_LEN_KEY] === merged[EXPLICIT_INDEX_LEN_KEY]
      && stored[EXPLICIT_PREVIEW_LEN_KEY] === merged[EXPLICIT_PREVIEW_LEN_KEY]
      && r.index_len === indexLen && r.preview_len === previewLen
    ) continue
    write.run(JSON.stringify(merged), indexLen, previewLen, r.rowid)
    if (content) {
      const col = columnForIndex(r.index_col)
      ftsDelete.run(r.rowid, ...ftsColumnValues(col, indexTextFor(content, oldMeta)))
      ftsInsert.run(r.rowid, ...ftsColumnValues(col, indexTextFor(content, merged)))
    }
    healed++
  }
  return { scanned: rows.length, healed }
}

const migration: Migration = {
  version: 30,
  kind: 'additive',
  description: 'Bound every recovery-snapshot row: display preview and index boundary (D286)',
  up(db) {
    if (!hasTable(db, 'nodes') || !hasTable(db, 'nodes_fts')) return
    healRecoverySnapshotBoundaries(db)
  },
}

export default migration
