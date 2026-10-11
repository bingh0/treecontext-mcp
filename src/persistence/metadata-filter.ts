/**
 * The metadata filter's query half (D268): a filter's flat scalar keys
 * narrow the candidates in the SQL itself, before the ranked pool is cut,
 * so a filter on `kind`, `status`, `thread`, `type`, `next_session` and
 * their like answers from the whole journal. What the query cannot carry
 * is returned as the residue, which the caller keeps sifting the pool with
 * the strict-equality post-filter exactly as before.
 *
 * Which keys go into SQL:
 *  - the name matches `^[A-Za-z_][A-Za-z0-9_]*$` (it becomes a JSON path,
 *    `$.<key>`; any other name, a dotted or quoted one among them, stays
 *    on the post-filter, where it is compared as a literal top-level key);
 *  - the value is a string, a finite number, a boolean or null (a nested
 *    object or an array is compared structurally by the post-filter, which
 *    by strict equality never matches one, and stays there unchanged);
 *  - the key is not one of the lifted boundary keys `_index_len` /
 *    `_preview_len`, which are served from columns (applyLiftedBoundaries)
 *    and so are not what metadata_json holds.
 *
 * How a value compares, exactly as the post-filter's strict equality:
 * `json_type` pins the JSON type and `json_extract` the value, so a string
 * matches a JSON string, a number a JSON integer or real, `true`/`false`
 * a JSON true/false only (never a stored number 1 or 0, which
 * json_extract alone would conflate), `null` a stored JSON null only, and
 * a key the row does not carry matches nothing (json_type is NULL).
 *
 * An empty filter carries no key and is returned whole as the residue, so
 * its old meaning (a row with no metadata at all never matches) is kept.
 *
 * Every predicate is guarded by `json_valid` inside a CASE, so a row whose
 * metadata is not valid JSON matches nothing instead of making SQLite's
 * json functions throw (the post-filter it replaces parsed tolerantly).
 * CASE guarantees the order of evaluation; a bare AND would not.
 */
import { EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './index-text.js'

export const FLAT_FILTER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

const LIFTED_KEYS: ReadonlySet<string> = new Set([EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY])

export interface MetadataFilterSql {
  /** Predicates to AND into the WHERE clause, in order. */
  where: string[]
  /** Their bind parameters, in placeholder order. */
  params: unknown[]
  /** The keys the query cannot carry, for the post-filter; undefined when
   *  every key went into SQL. */
  residue: Record<string, unknown> | undefined
}

/** True when `key: value` can be carried by the query itself. */
export function isFlatFilterEntry(key: string, value: unknown): boolean {
  if (!FLAT_FILTER_KEY.test(key) || LIFTED_KEYS.has(key)) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  return typeof value === 'number' && Number.isFinite(value)
}

/** Split `filter` into SQL predicates over `<column>` (a metadata JSON
 *  column expression, e.g. `n.metadata_json`) and the residue. */
export function metadataFilterSql(filter: Record<string, unknown>, column: string): MetadataFilterSql {
  const where: string[] = []
  const params: unknown[] = []
  const residue: Record<string, unknown> = {}
  const entries = Object.entries(filter)
  if (entries.length === 0) return { where, params, residue: { ...filter } }
  const guarded = (pred: string): string => `(CASE WHEN json_valid(${column}) THEN ${pred} ELSE 0 END)`
  for (const [key, value] of entries) {
    if (!isFlatFilterEntry(key, value)) { residue[key] = value; continue }
    const path = `$.${key}`
    if (value === null) {
      where.push(guarded(`json_type(${column}, ?) = 'null'`))
      params.push(path)
    } else if (typeof value === 'boolean') {
      where.push(guarded(`json_type(${column}, ?) = '${value ? 'true' : 'false'}'`))
      params.push(path)
    } else if (typeof value === 'number') {
      where.push(guarded(`(json_type(${column}, ?) IN ('integer', 'real') AND json_extract(${column}, ?) = ?)`))
      params.push(path, path, value)
    } else {
      where.push(guarded(`(json_type(${column}, ?) = 'text' AND json_extract(${column}, ?) = ?)`))
      params.push(path, path, value)
    }
  }
  return { where, params, residue: Object.keys(residue).length > 0 ? residue : undefined }
}
