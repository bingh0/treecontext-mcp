/**
 * node:sqlite adapter implementing the Database interface (D278).
 *
 * Node's built-in SQLite is a synchronous binding with no native
 * dependency of ours: the SQLite is the one the running Node carries,
 * so the version and the FTS5 flag are read from the process, never
 * assumed (`sqliteVersion`, `hasFts5`). The floor is Node 24.16 — the
 * first build whose text reads round-trip an embedded NUL and whose
 * `node:sqlite` loads without an experimental warning.
 *
 * What this adapter owns that better-sqlite3 gave for free:
 * - `transaction()`: BEGIN IMMEDIATE / DEFERRED at the top, SAVEPOINT
 *   nesting below it, keyed on `isTransaction`.
 * - `pragma()`: a read returns `[{ <name>: value }]` rows, the array
 *   shape every consumer already reads; a write is `PRAGMA k = v`.
 * - the defaults: node:sqlite opens with `synchronous = FULL`, which is
 *   twenty-five times slower per single-row transaction than NORMAL on
 *   this schema (research of 2026-10-11); DEFAULT_PRAGMAS sets NORMAL,
 *   and every raw opener that bypasses the wrapper must set its own.
 * - the error vocabulary: errors are `ERR_SQLITE_ERROR` with `errcode`
 *   and `errstr`, never `SQLITE_BUSY` strings. `errcode` is the EXTENDED
 *   result code (SQLITE_BUSY_SNAPSHOT is 517, SQLITE_READONLY_DIRECTORY
 *   1544); the primary code is its low byte, which is what `isBusyError`
 *   and `isCantOpenError` compare, falling back to the message.
 *
 * Known deltas a consumer can observe: rows have a null prototype, a
 * BLOB reads as a Uint8Array (the content codec accepts either), an
 * integer past 2^53 throws instead of rounding, there is no
 * `fileMustExist` (`openRaw` emulates it with an existence check).
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmodSync, existsSync, statSync } from 'node:fs'
import type { Database, Statement, RunResult } from './database.js'
import { dbg, warn } from '../debug.js'

/** The raw handle this adapter wraps; what the hooks hold directly. */
export type RawDatabase = DatabaseSync

/** The slice of a handle that read-mostly helpers (checkpoints, the
 *  registry, references) need: a raw DatabaseSync and a wrapped Database
 *  both satisfy it, so a helper typed on it serves hooks and the store
 *  alike without either driver's full surface. */
export interface SqlHandle {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

/** Pragmas applied on every wrapped open. Aligned with planning/04. */
export const DEFAULT_PRAGMAS: Array<[string, string]> = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['foreign_keys', 'ON'],
  ['mmap_size', '268435456'], // 256 MB
  ['temp_store', 'MEMORY'],
  ['busy_timeout', '10000'], // ms
]

// ── SQLite result codes this adapter names ──────────────────────────────
export const SQLITE_BUSY = 5
export const SQLITE_LOCKED = 6
export const SQLITE_CANTOPEN = 14

/** The shape node:sqlite throws: an Error with the Node code and the
 *  SQLite EXTENDED result code beside it (`primaryCode` takes the low byte). */
export interface SqliteError extends Error {
  code?: string
  errcode?: number
  errstr?: string
}

/** The primary SQLite result code of an error's `errcode` (its low byte:
 *  517 SQLITE_BUSY_SNAPSHOT → 5), or undefined when there is none. */
export function primaryCode(err: unknown): number | undefined {
  const c = (err as SqliteError | null)?.errcode
  return typeof c === 'number' ? c & 0xff : undefined
}

/** True if `err` is a SQLITE_BUSY / SQLITE_LOCKED error (any extended form:
 *  BUSY_SNAPSHOT, BUSY_RECOVERY, LOCKED_SHAREDCACHE…), by primary code first
 *  and by message as the fallback (a wrapped or re-thrown error may have
 *  lost its errcode but keeps its text). */
export function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const e = err as SqliteError
  const p = primaryCode(e)
  if (p === SQLITE_BUSY || p === SQLITE_LOCKED) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(
    (e.code ?? '') + ' ' + e.message,
  )
}

/** True if `err` is SQLite's "unable to open database file" (any extended form). */
export function isCantOpenError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return primaryCode(err) === SQLITE_CANTOPEN || /unable to open database file/i.test((err as Error).message)
}

function cantOpen(path: string): SqliteError {
  const e = new Error(`unable to open database file: ${path}`) as SqliteError
  e.code = 'ERR_SQLITE_ERROR'
  e.errcode = SQLITE_CANTOPEN
  e.errstr = 'unable to open database file'
  return e
}

export interface OpenRawOptions {
  /** Open read-only (SQLITE_OPEN_READONLY). A missing file is an error. */
  readOnly?: boolean
  /** Refuse to create the file: a missing path throws SQLITE_CANTOPEN
   *  (errcode 14), as better-sqlite3's `fileMustExist` did. */
  mustExist?: boolean
  /** busy_timeout in milliseconds, set at open. Default
   *  DEFAULT_RAW_TIMEOUT_MS: node:sqlite's own default is 0, so a raw
   *  reader opened beside a transient exclusive window (WAL recovery after
   *  a crash, a checkpoint at shutdown) would fail at once where the old
   *  driver waited 5 s; the wrapped door sets busy_timeout again from
   *  DEFAULT_PRAGMAS. */
  timeoutMs?: number
}

/** The raw opener's default busy wait, what better-sqlite3's constructor
 *  defaulted `timeout` to. */
export const DEFAULT_RAW_TIMEOUT_MS = 5000

/** A path SQLite reads as something other than a plain file: `:memory:`,
 *  the empty string (a private temporary database) and `file:` URIs, whose
 *  query string may itself say `mode=ro` or `mode=memory`. The existence
 *  check below has nothing to say about these. */
function isPlainFilePath(path: string): boolean {
  return path !== '' && path !== ':memory:' && !path.startsWith('file:')
}

/** The one raw opener. Every site that holds a DatabaseSync directly
 *  (hooks, doctor probes, the stores tools) opens through here so the
 *  open options are spelled once.
 *
 *  `mustExist` is emulated: node:sqlite has no flag that omits
 *  SQLITE_OPEN_CREATE, so a missing plain file is refused by an existence
 *  check before the open. That check is not atomic with the open (a file
 *  unlinked in between is created empty), which better-sqlite3's
 *  `fileMustExist` was; every caller passing it also passes `readOnly`
 *  except the merge destination, which holds a lease. */
export function openRaw(path: string, opts: OpenRawOptions = {}): DatabaseSync {
  if ((opts.mustExist || opts.readOnly) && isPlainFilePath(path) && !existsSync(path)) {
    throw cantOpen(path)
  }
  const ctor: { readOnly?: boolean; timeout?: number } = {}
  if (opts.readOnly) ctor.readOnly = true
  ctor.timeout = opts.timeoutMs ?? DEFAULT_RAW_TIMEOUT_MS
  return new DatabaseSync(path, ctor)
}

// ── pragma helpers for raw handles ──────────────────────────────────────

/** `PRAGMA <source>` as rows: `[{ <name>: value }]`, or `[]` for a pragma
 *  that returns nothing (most writes). The shape better-sqlite3's
 *  `pragma()` returned. */
export function pragmaRows(db: SqlHandle, source: string): Array<Record<string, unknown>> {
  return db.prepare(`PRAGMA ${source}`).all() as Array<Record<string, unknown>>
}

/** The first column of the first row of `PRAGMA <source>`, or undefined:
 *  what better-sqlite3's `pragma(x, { simple: true })` returned. */
export function pragmaValue(db: SqlHandle, source: string): unknown {
  const row = pragmaRows(db, source)[0]
  if (row === undefined) return undefined
  for (const k in row) return row[k]
  return undefined
}

/** Write a pragma: `PRAGMA <source>`, result discarded. */
export function setPragma(db: SqlHandle, source: string): void {
  db.prepare(`PRAGMA ${source}`).all()
}

/** The SQLite version the running Node carries. */
export function sqliteVersion(): string {
  return process.versions.sqlite ?? 'unknown'
}

/** Whether this Node's SQLite was compiled with FTS5, read from an open
 *  database's compile options — a distro Node built against a system
 *  SQLite may lack it at any version. */
export function hasFts5(db?: SqlHandle): boolean {
  const own = db === undefined ? new DatabaseSync(':memory:') : null
  try {
    const rows = pragmaRows(db ?? own!, 'compile_options')
    return rows.some(r => Object.values(r).some(v => v === 'ENABLE_FTS5'))
  } finally {
    own?.close()
  }
}

// ── the Database adapter ────────────────────────────────────────────────

class NodeSqliteStatement implements Statement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): RunResult {
    const r = this.stmt.run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(...(params as never[])) as Record<string, unknown> | undefined
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    return this.stmt.all(...(params as never[])) as Array<Record<string, unknown>>
  }

  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> {
    return this.stmt.iterate(...(params as never[])) as IterableIterator<Record<string, unknown>>
  }
}

export class NodeSqliteDatabase implements Database {
  private closed = false
  private savepointDepth = 0
  readonly secureDelete: boolean

  constructor(
    private readonly db: DatabaseSync,
    opts?: { secureDelete?: boolean | undefined; readOnly?: boolean | undefined; timeoutMs?: number | undefined },
  ) {
    this.secureDelete = opts?.secureDelete ?? false
    for (const [key, value] of DEFAULT_PRAGMAS) {
      // journal_mode is a write when it changes the mode: a read-only handle
      // on a rollback-journal file would throw here (WAL is already the
      // store's recorded mode). The other defaults are no-ops on a read-only
      // handle. A caller's busy timeout outranks the default.
      if (opts?.readOnly && key === 'journal_mode') continue
      if (key === 'busy_timeout' && opts?.timeoutMs !== undefined) {
        setPragma(this.db, `busy_timeout = ${opts.timeoutMs}`)
        continue
      }
      setPragma(this.db, `${key} = ${value}`)
    }
    // Security S6: opt-in secure delete
    if (this.secureDelete) setPragma(this.db, 'secure_delete = ON')
  }

  /** The wrapped handle, for callers that need the driver's own surface
   *  (the backup call, the hooks' raw reads). */
  get raw(): DatabaseSync {
    return this.db
  }

  prepare(sql: string): Statement {
    return new NodeSqliteStatement(this.db.prepare(sql))
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T, opts?: { mode?: 'deferred' | 'immediate' }): T {
    // Immediate by default — see the Database interface note on
    // SQLITE_BUSY_SNAPSHOT. Nested calls become savepoints regardless of
    // mode, so the default is safe inside an outer transaction.
    if (this.db.isTransaction) {
      const name = `tc_sp_${this.savepointDepth + 1}`
      this.db.exec(`SAVEPOINT ${name}`)
      this.savepointDepth++
      try {
        const out = fn()
        this.db.exec(`RELEASE SAVEPOINT ${name}`)
        return out
      } catch (err) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`); this.db.exec(`RELEASE SAVEPOINT ${name}`) } catch { /* the outer transaction decides */ }
        throw err
      } finally {
        this.savepointDepth--
      }
    }
    const mode = opts?.mode ?? 'immediate'
    this.db.exec(mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      // fn may have ended the transaction itself (a ROLLBACK in SQL);
      // only roll back what is still open.
      if (this.db.isTransaction) {
        try { this.db.exec('ROLLBACK') } catch { /* already gone */ }
      }
      throw err
    }
  }

  pragma(key: string, value?: unknown): unknown {
    if (value === undefined) return pragmaRows(this.db, key)
    return pragmaRows(this.db, `${key} = ${String(value)}`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.db.isOpen) this.db.close()
  }

  /**
   * Security S6: run VACUUM + WAL checkpoint (TRUNCATE) to scrub deleted
   * data from the database file. Only meaningful when secure_delete is
   * ON; called after clear() and bulk deletes. VACUUM cannot run inside
   * a transaction, so there is a small window between the DELETE and the
   * VACUUM where new writes could land — accepted per SQLite design.
   */
  secureWipe(): void {
    if (!this.secureDelete) return
    setPragma(this.db, 'wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
  }

  get inTransaction(): boolean {
    return this.db.isTransaction
  }

  get path(): string | undefined {
    // location() is null for an in-memory or temporary database.
    const loc = this.db.location()
    return loc ? loc : undefined
  }
}

export interface OpenNodeSqliteOptions extends OpenRawOptions {
  secureDelete?: boolean
}

/**
 * The library door (D278, D7): open a Database on a file path, or wrap a
 * DatabaseSync the caller already holds. Replaces `openBetterSqlite` and
 * `wrapBetterSqlite`. Synchronous: node:sqlite needs no dynamic import.
 */
export function openNodeSqlite(pathOrDb: string | DatabaseSync, opts: OpenNodeSqliteOptions = {}): Database {
  const wrapOpts = { secureDelete: opts.secureDelete, readOnly: opts.readOnly, timeoutMs: opts.timeoutMs }
  if (typeof pathOrDb === 'string') {
    dbg('sqlite', 'opening', { path: pathOrDb })
    const raw = openRaw(pathOrDb, opts)
    let db: NodeSqliteDatabase
    try {
      db = new NodeSqliteDatabase(raw, wrapOpts)
    } catch (err) {
      // The handle this call opened is this call's to close on the way out.
      try { raw.close() } catch { /* already gone */ }
      throw err
    }
    ensureDbFileMode(pathOrDb)
    dbg('sqlite', 'opened', { path: pathOrDb, wal: !opts.readOnly })
    return db
  }
  return new NodeSqliteDatabase(pathOrDb, wrapOpts)
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
    if (mode > 0o600) {
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
