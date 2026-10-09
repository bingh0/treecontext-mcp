/**
 * Journal fixtures for the `stores merge` corpus
 * (docs/project-identity.md §5, §11c).
 *
 * Rows go in through the REAL `FlatStore.insert` rather than a hand-built
 * INSERT: the merge's dedup predicate reads the arbiter columns
 * (`fingerprint`, `dedup_class`, `session_key`) and its anchor re-write
 * reads `dedup_anchors`, so a fixture that stamped only the columns a
 * test happens to assert on would prove the copy against a store shape
 * that never occurs. Everything here therefore opens the store the way
 * the product opens it.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

import { FlatStore } from '../../src/flat-store.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { MIGRATION_BACKUP_RE } from '../../src/persistence/backup-verdict.js'
import type { InsertOptions } from '../../src/core/types.js'

export interface SeedEntry {
  content: string
  opts?: InsertOptions
}

/**
 * Seed one namespace of a store with real entries, creating the store at
 * the current schema head when it does not exist yet. Returns the store's
 * database path.
 */
export async function seedJournal(
  storesDir: string,
  store: string,
  namespace: string,
  entries: SeedEntry[],
): Promise<string> {
  const dir = join(storesDir, store)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'treecontext.db')
  const raw = new BetterSqlite3(dbPath)
  const db = wrapBetterSqlite(raw)
  const flat = await FlatStore.open({ database: db, namespace, ownsDatabase: true })
  try {
    for (const e of entries) await flat.insert(e.content, e.opts)
  } finally {
    await flat.close()
  }
  // The ladder from v0 crosses a destructive step and leaves its
  // pre-migration copy beside the store — dated TODAY, which is exactly
  // what `stores merge`'s backup precondition looks for. A fixture must
  // seed only what it claims to seed, or the missing-backup refusal
  // would never fire (found by that scenario passing when it should not).
  for (const name of readdirSync(dir)) {
    if (MIGRATION_BACKUP_RE.test(name) || MIGRATION_BACKUP_RE.test(name.replace(/\.verdict\.json$/, ''))) {
      rmSync(join(dir, name), { force: true })
    }
  }
  return dbPath
}

/** `n` distinct curated entries, distinguishable per store by `tag`. */
export function entriesOf(tag: string, n: number, opts?: InsertOptions): SeedEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    content: `${tag} entry ${i}: a note long enough to be its own content, index ${i}.`,
    ...(opts ? { opts } : {}),
  }))
}

/** Every node in a store, across every namespace. */
export function allNodes(dbPath: string): Array<{
  node_id: string
  content: string
  namespace: string
  read_only: number
  decay_exempt: number
  created_at: number
  metadata_json: string | null
}> {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(
      'SELECT n.node_id, n.content, t.namespace, n.read_only, n.decay_exempt, n.created_at, n.metadata_json '
      + 'FROM nodes n JOIN trees t ON t.tree_id = n.tree_id ORDER BY t.namespace, n.node_id',
    ).all() as ReturnType<typeof allNodes>
  } finally {
    db.close()
  }
}

/** Node count per namespace, as a plain object the assertions can read. */
export function countsByNamespace(dbPath: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of allNodes(dbPath)) out[row.namespace] = (out[row.namespace] ?? 0) + 1
  return out
}
