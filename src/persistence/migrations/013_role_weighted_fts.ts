import type { Migration } from '../migrations.js'
import { decodeContent } from '../content-codec.js'
import { indexTextFor } from '../index-text.js'
import { attributeColumn, columnIndex, ftsColumnValues, FTS_COLUMNS } from '../fts-columns.js'

function parseMetaLoose(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'string' || !json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const migration: Migration = {
  version: 13,
  kind: 'additive',
  description:
    'Rebuild nodes_fts as 4 role columns (user/assistant/tool/note); backfill nodes.index_col attribution',
  up(db) {
    // index_col: additive nullable column. Fresh stores already declare it
    // in schema.ts's base CREATE TABLE (matches the 008_insert_generation
    // pattern) — swallow the resulting "duplicate column" error rather than
    // gating on schema version.
    try {
      db.exec('ALTER TABLE nodes ADD COLUMN index_col INTEGER')
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column')) throw err
    }

    // FG-5/FG-10: this runs inside the migration runner's own transaction
    // (see migrations.ts) — additive migrations are batched in a single
    // BEGIN/COMMIT, so a failure anywhere below (e.g. a corrupt content
    // blob decoded partway through the backfill) rolls back the DROP +
    // CREATE + backfill as one unit, leaving the legacy single-column index
    // fully intact and queryable. Nothing here opens its own transaction.
    db.exec('DROP TABLE IF EXISTS nodes_fts')
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        ${FTS_COLUMNS.join(', ')},
        content='',
        tokenize='unicode61 remove_diacritics 2'
      )
    `)

    const rows = db.prepare('SELECT rowid, node_id, content, metadata_json FROM nodes').all() as Array<{
      rowid: number
      node_id: string
      content: unknown
      metadata_json: unknown
    }>

    const insertFts = db.prepare(`INSERT INTO nodes_fts(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`)
    const setIndexCol = db.prepare('UPDATE nodes SET index_col = ? WHERE node_id = ?')

    for (const row of rows) {
      const meta = parseMetaLoose(row.metadata_json)
      const col = attributeColumn(meta)
      // Backfill index_col for EVERY row (attribution depends only on
      // metadata, not on whether there is indexable content) — this makes
      // the column immutable and authoritative for delete/update from this
      // point on, regardless of whether the row happens to have empty
      // content today.
      setIndexCol.run(columnIndex(col), row.node_id)

      const decoded = decodeContent(row.content as string | Buffer | null)
      if (!decoded) continue
      const indexText = indexTextFor(decoded, meta)
      insertFts.run(row.rowid, ...ftsColumnValues(col, indexText))
    }
  },
}

export default migration
