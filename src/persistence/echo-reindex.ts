import type { Database } from './database.js'
import { decodeContent } from './content-codec.js'
import { indexTextFor, applyLiftedBoundaries, EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './index-text.js'
import { columnForIndex, ftsColumnValues, FTS_COLUMNS } from './fts-columns.js'
import { stampEchoBoundaries } from './echo-index.js'
import { liftBoundary, parseMeta } from '../dedup-identity.js'

/**
 * D261's row-level re-stamp and re-index of a stored treecontext echo,
 * spelled once for its two callers: migration 028, which ran it over every
 * echo a store held at the upgrade, and the beta.2 drain's echo heal
 * (D265), which runs it over echoes a still-running older server drained
 * after that upgrade — rows that missed the boundary stamp and were
 * indexed with their results.
 *
 * The boundary is the shared helper's (stampEchoBoundaries), so the drain,
 * the migration and the heal cannot drift. The OLD index text is
 * recomputed from the row's old stamp through its boundary columns (the
 * contentless-FTS delete form, in the row's immutable index_col) and the
 * new one inserted from the new stamp. Stored content is never touched. A
 * row already at its boundary is left alone, so a pass is idempotent.
 */

/** Rows read per page by the migration; the heal's per-sweep bound. */
export const ECHO_REINDEX_PAGE = 500

export interface EchoReindexPass {
  /** Echo rows read this pass. */
  scanned: number
  /** Rows re-stamped and re-indexed. */
  healed: number
  /** The highest rowid read, the next pass's cursor (unchanged when none). */
  last: number
}

export interface EchoReindexer {
  /** Read up to `limit` candidate rows past rowid `after` and heal each. */
  pass(after: number, limit: number): EchoReindexPass
}

/**
 * `skipHandoffLanes`: the heal leaves handoff lanes alone (the import door
 * stamps what a file carries; identity, not this, decides there); the
 * migration covered every lane, as it always did.
 */
export function echoReindexer(db: Database, opts: { skipHandoffLanes: boolean }): EchoReindexer {
  const page = db.prepare(
    'SELECT rowid, content, metadata_json, index_col, index_len, preview_len FROM nodes ' +
      "WHERE rowid > ? AND json_valid(metadata_json) " +
      "AND json_extract(metadata_json, '$.source') = 'auto-capture' " +
      "AND json_extract(metadata_json, '$.tool_name') LIKE ? ESCAPE '\\' " +
      (opts.skipHandoffLanes ? "AND (session_key IS NULL OR substr(session_key, 1, 8) != 'handoff:') " : '') +
      'ORDER BY rowid LIMIT ?',
  )
  const write = db.prepare('UPDATE nodes SET metadata_json = ?, index_len = ?, preview_len = ? WHERE rowid = ?')
  const ftsDelete = db.prepare(
    `INSERT INTO nodes_fts(nodes_fts, rowid, ${FTS_COLUMNS.join(', ')}) VALUES ('delete', ?, ?, ?, ?, ?)`,
  )
  const ftsInsert = db.prepare(`INSERT INTO nodes_fts(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?)`)
  // A coarse SQL filter on the suffix mark (LIKE's `_` escaped); the
  // shared predicate inside stampEchoBoundaries decides.
  const pattern = '%\\_\\_treecontext\\_%'

  return {
    pass(after: number, limit: number): EchoReindexPass {
      const rows = page.all(after, pattern, limit) as Array<{
        rowid: number; content: unknown; metadata_json: string; index_col: number | null
        index_len: number | null; preview_len: number | null
      }>
      let healed = 0
      let last = after
      for (const r of rows) {
        last = r.rowid
        const stored = parseMeta(r.metadata_json)
        if (!stored) continue
        let content: string
        try { content = decodeContent(r.content as string | Buffer | null) } catch { continue }
        // The boundary columns are the engine's truth for what was indexed
        // (G5): the old index text is recomputed through them.
        const oldMeta = applyLiftedBoundaries(stored, r.index_len, r.preview_len)
        const newMeta = stampEchoBoundaries(content, oldMeta)
        if (!newMeta || newMeta === oldMeta) continue
        const merged = {
          ...stored,
          [EXPLICIT_INDEX_LEN_KEY]: newMeta[EXPLICIT_INDEX_LEN_KEY],
          [EXPLICIT_PREVIEW_LEN_KEY]: newMeta[EXPLICIT_PREVIEW_LEN_KEY],
        }
        const indexLen = liftBoundary(merged[EXPLICIT_INDEX_LEN_KEY], content.length)
        const previewLen = liftBoundary(merged[EXPLICIT_PREVIEW_LEN_KEY], content.length)
        // Already at its boundary: nothing to write (the idempotence the
        // heal's every-sweep pass relies on).
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
      return { scanned: rows.length, healed, last }
    },
  }
}

/**
 * The echo heal (D265 follow-up): after an upgrade, a still-running older
 * server keeps draining, and the echoes it drains miss the D261 boundary
 * — indexed with their results, with nothing else to heal them. Heals up
 * to `limit` echo rows past rowid `after`, outside handoff lanes, inside
 * one transaction. Idempotent.
 */
export function healEchoIndex(db: Database, after: number, limit = ECHO_REINDEX_PAGE): EchoReindexPass {
  return db.transaction(() => echoReindexer(db, { skipHandoffLanes: true }).pass(after, limit))
}
