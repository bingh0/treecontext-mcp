/**
 * createMemoryStore — resolve and open the right memory backend.
 *
 * Mode resolution (D1 default-off, D7 preserve existing):
 *   explicit opts.backend
 *   ?? persisted store_config.backend_mode        (existing store keeps mode)
 *   ?? (legacy embedding_model present ? 'tree' : 'lexical')
 *   ?? 'lexical'                                   (new store, default-off)
 *
 * The resolved mode is persisted post-open, so fresh stores record their
 * mode and legacy tree stores are back-filled to 'tree' on first open.
 */
import type { Database } from './persistence/database.js'
import type { BackendMode } from './core/types.js'
import type { MemoryStore } from './memory-store.js'
import {
  getBackendMode,
  setBackendMode,
  storeHasEmbeddingModel,
} from './persistence/store.js'
import { FlatStore } from './flat-store.js'

export interface CreateMemoryStoreOptions {
  database: Database
  /** Explicit backend override; bypasses resolution when set. */
  backend?: BackendMode
  /** Accepted for API compatibility; the tree backend that consumed it no
   *  longer ships, so passing one changes nothing. */
  embedding?: unknown
  namespace?: string
  ownsDatabase?: boolean
  migrate?: boolean
  /** Forwarded to FlatStoreOptions.maintenanceHeartbeat. */
  maintenanceHeartbeat?: () => void
  /** Forwarded to FlatStoreOptions.maxStoreBytes — the config file's
   *  `[retention] max_store_bytes` (D141). */
  maxStoreBytes?: number
  /** Forwarded to FlatStoreOptions.maxSessions — the config file's
   *  `[retention] max_sessions` (D141). */
  maxSessions?: number
}

export function resolveBackendMode(
  db: Database,
  explicit?: BackendMode,
): BackendMode {
  const recorded = getBackendMode(db)
  if (explicit) return explicit
  if (recorded) return recorded
  return storeHasEmbeddingModel(db) ? 'tree' : 'lexical'
}

export async function createMemoryStore(
  opts: CreateMemoryStoreOptions,
): Promise<MemoryStore> {
  const db = opts.database
  const mode = resolveBackendMode(db, opts.backend)

  let store: MemoryStore
  if (mode === 'tree') {
    // Migrate-or-refuse, loudly (deletion phase, 2026-07-25): the tree
    // backend no longer exists in this build. The store is NOT touched —
    // its data, embeddings, and mode record stay intact on disk.
    throw new Error(
      'This store was built by the tree backend, which this build no longer '
      + 'ships (removed 2026-07-25; see features/OUT-OF-SCOPE.md). '
      + 'The store is untouched. Options: open it with a pre-deletion build '
      + '(git tag pre-deletion-phase) and export, or pass an explicit '
      + "backend override to open it lexically (BM25 over the same rows).",
    )
  } else {
    store = await FlatStore.open({
      database: db,
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
      ...(opts.ownsDatabase !== undefined ? { ownsDatabase: opts.ownsDatabase } : {}),
      // Must forward: `serve` opts into destructive migrations (cli.ts) and
      // dropping the flag here left every pre-19 store failing the 019 gate
      // at startup — the server exited before stdio came up, which Claude
      // Code surfaces only as "-32000: Connection closed".
      ...(opts.migrate !== undefined ? { migrate: opts.migrate } : {}),
      ...(opts.maintenanceHeartbeat ? { maintenanceHeartbeat: opts.maintenanceHeartbeat } : {}),
      ...(opts.maxStoreBytes !== undefined ? { maxStoreBytes: opts.maxStoreBytes } : {}),
      ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
    })
  }

  // Persist the store's INTRINSIC mode, once (schema exists post-open).
  // Never overwrite a recorded mode, and never record a session's explicit
  // override as the store's identity: `serve --lexical` over a tree store
  // must not silently convert the store's on-disk mode record — the
  // override is per-process, the record is the store's truth.
  if (!getBackendMode(db)) {
    setBackendMode(db, storeHasEmbeddingModel(db) ? 'tree' : 'lexical')
  }
  return store
}
