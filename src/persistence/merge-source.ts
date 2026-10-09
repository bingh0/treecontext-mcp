/**
 * Cross-store merge source (docs/project-identity.md §5, §11c).
 *
 * A dependency-free leaf: the ATTACH alias, the namespace enumerator,
 * and the count arithmetic that `stores merge` reports. It sits here
 * rather than beside the orchestrator because `flat-store.ts` (the copy
 * body) and `tools/store-merge.ts` (the command) both need it, and a
 * shared leaf is the only way to give them one definition without a
 * cycle.
 */
import type { Database } from './database.js'

/**
 * The schema name the source store is ATTACHed under. A SQL identifier,
 * never a bound parameter — it is interpolated into every cross-store
 * statement, so it is a module constant of a fixed character class and
 * never user input.
 */
export const MERGE_SRC_ALIAS = 'merge_src'

/** What one namespace's copy did. `srcTotal` is the row count the source
 *  namespace offered, and every row lands in EXACTLY one bucket, so
 *  `imported + skippedDuplicate + skippedExistingId + skippedIdConflict +
 *  skippedUndecodable + skippedEmpty` reconciles with `srcTotal` (H5). */
export interface MergeCounts {
  imported: number
  skippedDuplicate: number
  /** Present by id under IDENTICAL content — the idempotent re-run case.
   *  The namespace merge, whose ids are freshly minted, counts a row
   *  present by its `_merged_from_node_id` back-pointer here (D144): the
   *  same class, so the reconciliation below holds for both callers. */
  skippedExistingId: number
  /** Present by id under DIFFERENT content (H1): a different row wears
   *  that node_id, so this is the one skip class that means possible
   *  divergence rather than idempotence. Never overwrites the destination. */
  skippedIdConflict: number
  /** decodeContent threw on the source row (H2): a v24 store can hold a
   *  row it cannot read, and a merge must skip it rather than crash. */
  skippedUndecodable: number
  /** The source row decoded to empty content (H5): counted so the
   *  disclosed numbers sum to srcTotal. */
  skippedEmpty: number
  srcTotal: number
}

export interface NamespaceCounts extends MergeCounts {
  namespace: string
}

/**
 * The source store's namespaces (F3): every `ensemble_index = 0` tree.
 *
 * A store merge that copied one namespace would silently drop a
 * predecessor's agent lanes — the exact loss class this program exists
 * to kill — so the enumeration, not `'project'`, is what the copy loop
 * iterates. Sorted so the disclosure reads the same on every run.
 */
export function attachedNamespaces(db: Database, alias: string = MERGE_SRC_ALIAS): string[] {
  const rows = db
    .prepare(`SELECT namespace FROM ${alias}.trees WHERE ensemble_index = 0 ORDER BY namespace`)
    .all() as Array<{ namespace: unknown }>
  return rows.map((r) => String(r.namespace))
}

/** Sum the per-namespace counts for the totals line. Pure. */
export function mergeTotals(per: readonly NamespaceCounts[]): MergeCounts & { namespaces: number } {
  return per.reduce<MergeCounts & { namespaces: number }>(
    (acc, n) => ({
      imported: acc.imported + n.imported,
      skippedDuplicate: acc.skippedDuplicate + n.skippedDuplicate,
      skippedExistingId: acc.skippedExistingId + n.skippedExistingId,
      skippedIdConflict: acc.skippedIdConflict + n.skippedIdConflict,
      skippedUndecodable: acc.skippedUndecodable + n.skippedUndecodable,
      skippedEmpty: acc.skippedEmpty + n.skippedEmpty,
      srcTotal: acc.srcTotal + n.srcTotal,
      namespaces: acc.namespaces + 1,
    }),
    {
      imported: 0, skippedDuplicate: 0, skippedExistingId: 0, skippedIdConflict: 0,
      skippedUndecodable: 0, skippedEmpty: 0, srcTotal: 0, namespaces: 0,
    },
  )
}
