/**
 * Platform-neutral database interface.
 *
 * Adapters:
 * - BetterSqliteDatabase (Node, sync via better-sqlite3)
 * - ExpoSqliteDatabase (React Native, sync via expo-sqlite, phase 10)
 *
 * The MemTree sync core never touches this. Only the Persistence class
 * operates on Database directly.
 */

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Statement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>
}

export interface Database {
  /** Prepare a statement for repeated execution. */
  prepare(sql: string): Statement
  /** Execute SQL that does not return rows (DDL, bulk DML). */
  exec(sql: string): void
  /** Run fn inside a transaction; commits on return, rolls back on throw.
   *  Defaults to `immediate`: every current caller is a write transaction,
   *  and a deferred read-then-write upgrade can fail with
   *  SQLITE_BUSY_SNAPSHOT under WAL — an error busy_timeout does NOT
   *  retry. Taking the write lock at BEGIN makes contention wait at the
   *  door (where busy_timeout applies) instead of failing mid-flight.
   *  Pass `deferred` only for a transaction that provably never writes.
   *  (No `exclusive`: under the WAL mode every store runs in, BEGIN
   *  EXCLUSIVE behaves identically to BEGIN IMMEDIATE — offering it
   *  would promise reader-exclusion it cannot deliver.) */
  transaction<T>(fn: () => T, opts?: { mode?: 'deferred' | 'immediate' }): T
  /** Read or write a pragma. Pass value to write, omit to read. */
  pragma(key: string, value?: unknown): unknown
  /** Close the underlying connection. Safe to call twice. */
  close(): void
  /** Whether a transaction is currently active on this connection. */
  readonly inTransaction: boolean
  /** Filesystem path of the database file, when it has one (absent for
   *  in-memory databases). Lets consumers place sibling artifacts —
   *  e.g. the eviction archive directory — next to the store. */
  readonly path?: string | undefined
  /** Whether secure_delete is enabled on this connection. */
  readonly secureDelete?: boolean
  /** Run VACUUM + WAL checkpoint after destructive operations (S6). */
  secureWipe?(): void
}
