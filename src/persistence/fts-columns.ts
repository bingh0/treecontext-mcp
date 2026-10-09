/**
 * Role-weighted FTS — column attribution.
 *
 * `nodes_fts` is a 4-column contentless FTS5 table (user_text, assistant_text,
 * tool_text, note_text). Each node's index text lands in EXACTLY ONE column,
 * chosen once by `attributeColumn` at insert time and persisted on the node
 * row (`index_col`). Delete/update must read that persisted value back and
 * never recompute it from (mutable) metadata — supersede/demotion rewrite
 * `status`/`_demoted` after insert, so re-deriving later would silently
 * target the wrong column and leave ghost index entries (FG-2).
 */

export const FTS_COLUMNS = ['user_text', 'assistant_text', 'tool_text', 'note_text'] as const

export type FtsColumn = (typeof FTS_COLUMNS)[number]

/**
 * First-match attribution rule (spec table):
 *   1. source !== 'auto-capture' (agent-authored)      -> note_text
 *   2. role === 'user'                                 -> user_text
 *   3. role === 'assistant' AND tool_name present       -> tool_text
 *   4. role === 'assistant'                             -> assistant_text
 *   5. anything else (legacy/unknown)                   -> user_text (conservative)
 */
export function attributeColumn(meta: Record<string, unknown> | null | undefined): FtsColumn {
  if (!meta) return 'user_text'
  if (meta['source'] !== 'auto-capture') return 'note_text'
  const role = meta['role']
  if (role === 'user') return 'user_text'
  if (role === 'assistant') return meta['tool_name'] != null ? 'tool_text' : 'assistant_text'
  return 'user_text'
}

export function columnIndex(col: FtsColumn): number {
  return FTS_COLUMNS.indexOf(col)
}

/** Inverse of columnIndex. Out-of-range/null input falls back to the fixed
 *  constant `user_text` (index 0) — a fallback, never a metadata recompute. */
export function columnForIndex(i: number | null | undefined): FtsColumn {
  if (i == null || i < 0 || i >= FTS_COLUMNS.length) return 'user_text'
  return FTS_COLUMNS[i]!
}

/** Build the full 4-value row for a contentless nodes_fts insert/delete:
 *  `text` in `col`'s slot, empty string everywhere else. Column order
 *  matches FTS_COLUMNS / the CREATE VIRTUAL TABLE declaration. */
export function ftsColumnValues(col: FtsColumn, text: string): [string, string, string, string] {
  return FTS_COLUMNS.map((c) => (c === col ? text : '')) as [string, string, string, string]
}
