/**
 * Ambient types for better-sqlite3 as an optional peer dependency.
 *
 * We cannot rely on @types/better-sqlite3 being present at TypeScript
 * build time in downstream consumers, but we ship a minimal surface
 * that covers what ts/src/persistence/better-sqlite.ts uses.
 */

declare module 'better-sqlite3' {
  namespace Database {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement {
      run(...params: unknown[]): RunResult
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
      iterate(...params: unknown[]): IterableIterator<unknown>
      finalize?(): void
    }

    interface Database {
      prepare(sql: string): Statement
      exec(sql: string): this
      pragma(pragma: string, options?: { simple?: boolean }): unknown
      transaction<T extends (...args: never[]) => unknown>(fn: T): T & { deferred: T; immediate: T; exclusive: T }
      close(): this
      readonly open: boolean
      readonly inTransaction: boolean
      /** Filesystem path of the database file; ':memory:' when pathless. */
      readonly name: string
    }
  }

  interface DatabaseConstructor {
    new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number; verbose?: (msg: unknown) => void }): Database.Database
    (path: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number; verbose?: (msg: unknown) => void }): Database.Database
  }

  const Database: DatabaseConstructor
  export = Database
}
