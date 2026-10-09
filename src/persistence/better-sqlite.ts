/**
 * better-sqlite3 adapter implementing the Database interface.
 *
 * better-sqlite3 is a synchronous binding — exactly what the sync
 * MemTree core wants. Loaded via dynamic import so it stays out of
 * non-Node bundles (React Native, browser).
 */

import type { Database, Statement, RunResult } from './database.js'
import { chmodSync, statSync } from 'node:fs'
import { dbg, warn } from '../debug.js'

// Type-only import — the value import happens at runtime via createBetterSqliteDatabase.
type BetterSqliteConstructor = typeof import('better-sqlite3')
type RawDatabase = import('better-sqlite3').Database
type RawStatement = import('better-sqlite3').Statement

/** Pragmas applied on every open. Aligned with planning/04. */
export const DEFAULT_PRAGMAS: Array<[string, string]> = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['foreign_keys', 'ON'],
  ['mmap_size', '268435456'], // 256 MB
  ['temp_store', 'MEMORY'],
  ['busy_timeout', '10000'], // ms
]

class BetterSqliteStatement implements Statement {
  constructor(private readonly stmt: RawStatement) {}

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint }
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const row = this.stmt.get(...params)
    return row as Record<string, unknown> | undefined
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    return this.stmt.all(...params) as Array<Record<string, unknown>>
  }

  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> {
    return this.stmt.iterate(...params) as IterableIterator<Record<string, unknown>>
  }
}

export class BetterSqliteDatabase implements Database {
  private closed = false
  readonly secureDelete: boolean

  constructor(private readonly db: RawDatabase, opts?: { secureDelete?: boolean }) {
    this.secureDelete = opts?.secureDelete ?? false
    for (const [key, value] of DEFAULT_PRAGMAS) {
      this.db.pragma(`${key} = ${value}`)
    }
    // Security S6: opt-in secure delete
    if (this.secureDelete) {
      this.db.pragma('secure_delete = ON')
    }
  }

  prepare(sql: string): Statement {
    return new BetterSqliteStatement(this.db.prepare(sql))
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T, opts?: { mode?: 'deferred' | 'immediate' }): T {
    // better-sqlite3's transaction() wraps a function; call immediately.
    // Immediate by default — see the Database interface note on
    // SQLITE_BUSY_SNAPSHOT. (Nested calls become savepoints regardless
    // of mode, so the default is safe inside an outer transaction.)
    const wrapped = this.db.transaction(fn as () => unknown)
    const mode = opts?.mode ?? 'immediate'
    return (wrapped[mode] as unknown as () => T)()
  }

  pragma(key: string, value?: unknown): unknown {
    if (value === undefined) {
      return this.db.pragma(key)
    }
    return this.db.pragma(`${key} = ${String(value)}`)
  }

  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }

  /**
   * Security S6: run VACUUM + WAL checkpoint (TRUNCATE) to scrub
   * deleted data from the database file. Only meaningful when
   * secure_delete is ON; called after clear() and bulk deletes.
   *
   * Note: VACUUM cannot run inside a SQLite transaction. This means
   * there is a small theoretical window between the DELETE and the
   * VACUUM where new writes could land. This is accepted per SQLite
   * design — VACUUM must operate on the entire database and cannot
   * be wrapped by BEGIN/COMMIT. The alternative (no VACUUM) would
   * leave deleted data in the file indefinitely.
   */
  secureWipe(): void {
    if (!this.secureDelete) return
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
  }

  get inTransaction(): boolean {
    return this.db.inTransaction
  }

  get path(): string | undefined {
    // better-sqlite3 reports ':memory:' (or '') for pathless databases.
    const name = this.db.name
    return name && name !== ':memory:' ? name : undefined
  }
}

/**
 * Open a better-sqlite3-backed Database.
 *
 * Uses dynamic import so downstream bundlers can tree-shake the dep
 * out of RN and browser builds.
 */
export async function openBetterSqlite(path: string): Promise<Database> {
  dbg('sqlite', 'opening', { path })
  const mod = (await import('better-sqlite3')) as unknown as
    | BetterSqliteConstructor
    | { default: BetterSqliteConstructor }
  const BetterSqlite3 = 'default' in mod ? mod.default : mod
  const raw = new BetterSqlite3(path) as unknown as RawDatabase
  const db = new BetterSqliteDatabase(raw)
  ensureDbFileMode(path)
  dbg('sqlite', 'opened', { path, wal: true })
  return db
}

/**
 * Synchronous factory for tests and adapters that already hold an
 * instance of the raw driver.
 */
export function wrapBetterSqlite(raw: RawDatabase, opts?: { secureDelete?: boolean }): Database {
  return new BetterSqliteDatabase(raw, opts)
}

/**
 * Security S11: ensure the database file has restrictive permissions.
 * On create, chmod to 0o600 (owner read/write only). On open, warn to
 * stderr if permissions are broader (but do not auto-fix — the user
 * may have intentionally set group-share).
 */
export function ensureDbFileMode(dbPath: string): void {
  try {
    const st = statSync(dbPath)
    const mode = st.mode & 0o777
    if (mode === 0o600) return
    // File was just created or permissions are as expected — set to 0o600
    // only when modes are broader; don't tighten if already tight.
    if (mode > 0o600) {
      // On first creation the file often inherits umask. Try to tighten.
      try {
        chmodSync(dbPath, 0o600)
      } catch {
        warn(
          `[treecontext] Warning: could not set ${dbPath} to mode 0600. ` +
          `Current mode: ${mode.toString(8)}. Consider tightening permissions manually.`,
        )
      }
    }
  } catch {
    // File may not exist yet (e.g. in-memory DB path) — ignore.
  }
}
