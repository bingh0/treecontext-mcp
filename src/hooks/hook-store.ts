/**
 * The journal through a hook's own connection (the hooks door, D284,
 * D295, D298, D330): a FlatStore over the raw handle the hook opened with
 * openHookDb, so the rows a hook writes in a leg's lane (a first moment, a
 * send-back's message, a leg's summary, a worker's registration) are
 * written by the same code the ticket door writes them with, column for
 * column, and land in the immediate transaction of the registration they
 * belong to.
 *
 * Never a migration (JF-8): the open runs with `migrate: false`, and only
 * on a store that already carries the leg columns (migration 031); any
 * other store is no leg's, and the hook does what it did before. The
 * library's long-lived connection settings (synchronous NORMAL, the mmap)
 * are put back to a hook's after the open, as the fresh-store bootstrap
 * does, so a hook's durability never depends on whether it wrote a leg's
 * row. The namespace is the one the hook's staged rows would carry; an
 * unresolved one is the default the drain routes such rows to.
 */
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { hostname } from 'node:os'
import { FlatStore } from '../flat-store.js'
import { openNodeSqlite, setPragma, pragmaValue } from '../persistence/node-sqlite.js'
import { maxSupportedVersion } from '../persistence/migrations/index.js'
import { hasLegColumns } from '../persistence/leg-registry.js'
import { resolveHookNamespace } from '../session-beacon.js'
import { nsLeaseLiveFor } from '../persistence/leases.js'
import { hookBudgetLeftMs } from './shared.js'

/** The hooks door's journal, or why the hook may not write one. */
export type HookStore =
  | {
    store: FlatStore
    /** The namespace the hook's session resolved to, or null when it did
     *  not resolve: the door then reads every namespace's briefs (see
     *  FlatStore.startHooksLeg) and writes into the default tree, where
     *  the drain routes an unresolved session's rows. */
    namespace: string | null
  }
  | { refused: string }

/** (`since`: when the hook's budget began; the hooks pass HOOK_STARTED_AT,
 *  so the opens here wait what is left of it, never a fresh budget.)
 *
 *  A FlatStore over a hook's connection, or the reason the store is not
 *  the door's to write: a store below the leg columns has no legs (null,
 *  as before), and a store at another schema than this build's is that
 *  build's to write (D265), which the caller records as a gap (D314). The
 *  caller closes the raw handle; closing the FlatStore leaves it open. */
export async function hookStoreOn(
  db: DatabaseType, dbPath: string, sessionId: string | null, since: number = Date.now(),
): Promise<HookStore | null> {
  if (!hasLegColumns(db)) return null
  const version = pragmaValue(db, 'user_version') as number
  if (version !== maxSupportedVersion) {
    return { refused: `the store is at schema ${version} and this build writes legs at schema ${maxSupportedVersion}; `
      + (version < maxSupportedVersion ? 'its server migrates it at its next open' : 'a newer treecontext writes it') }
  }
  let namespace: string | null = null
  try {
    namespace = resolveHookNamespace(dbPath, process.ppid, sessionId ?? undefined,
      (a) => nsLeaseLiveFor(db, a.namespace, a.server_pid, hostname()))
  } catch { /* unresolved: the default */ }
  try {
    const store = await FlatStore.open({
      // The wrapper's pragmas and the journal's open wait what is left of
      // the hook's budget, not the wrapper's 10 s default.
      database: openNodeSqlite(db, { timeoutMs: hookBudgetLeftMs(since) }),
      ownsDatabase: false,
      migrate: false,
      retentionInterval: Number.MAX_SAFE_INTEGER,
      ...(namespace ? { namespace } : {}),
    })
    return { store, namespace }
  } finally {
    // A hook's connection settings, whatever the wrapper set (D278).
    setPragma(db, 'synchronous = FULL')
    setPragma(db, 'mmap_size = 0')
    setPragma(db, 'temp_store = DEFAULT')
    setPragma(db, `busy_timeout = ${hookBudgetLeftMs(since)}`)
  }
}

/** The tree a hook reads a role's briefs from: its resolved namespace's,
 *  or every tree (null) when the session's namespace did not resolve. A
 *  resolved namespace with no tree yet has no briefs (-1 matches none). */
export function hookTreeOf(db: DatabaseType, namespace: string | null): number | null {
  if (namespace === null) return null
  const r = db.prepare('SELECT tree_id FROM trees WHERE namespace = ? AND ensemble_index = 0').get(namespace) as { tree_id: number } | undefined
  return r ? Number(r.tree_id) : -1
}

/** The namespace a hook's session resolves to, without opening the
 *  journal, or null when it does not resolve. */
export function hookNamespaceOf(db: DatabaseType, dbPath: string, sessionId: string | null): string | null {
  try {
    return resolveHookNamespace(dbPath, process.ppid, sessionId ?? undefined, (a) => nsLeaseLiveFor(db, a.namespace, a.server_pid, hostname()))
  } catch { return null }
}
