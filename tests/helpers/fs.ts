import { rmSync } from 'node:fs'

/**
 * Remove a directory tree with retries — Windows refuses to unlink
 * files that still have open handles (e.g. a just-closed SQLite WAL
 * whose handle hasn't fully released). `maxRetries` + `retryDelay`
 * are honored by Node's built-in rmSync; on POSIX this is a no-op
 * performance-wise because the first attempt succeeds.
 *
 * Reach for `createTeardown()` below before reaching for this. Retrying an
 * unlink that fails because something is still OPEN does not close it; it just
 * makes the failure intermittent, and an intermittent teardown failure is a
 * flake generator that hides the leak instead of reporting it.
 */
export function rmTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

interface Closeable { close(): unknown }

/**
 * Close-then-remove teardown.
 *
 * Windows will not unlink a file that still has an open handle, so a test file
 * that opens a store and lets process exit reap it passes on POSIX and fails on
 * Windows — in afterAll, with every assertion already green. Four files failed
 * in exactly that shape on the first Windows run to execute this suite: 138
 * passing assertions, four red files, all of it teardown.
 *
 * `ownsDatabase: false` is the sharp edge. FlatStore.close() deliberately
 * leaves a database it does not own alone, so closing the store is NOT enough —
 * whoever opened the raw handle has to hand it over here too. retention-demotion
 * had four such opens and one matching close.
 *
 * Closing is idempotent on both sides (FlatStore.close() early-returns when
 * already closed; the better-sqlite3 wrapper guards on its own `closed` flag,
 * verified against the driver), so handing over something already closed is
 * safe and nothing here swallows an error — a close that genuinely fails
 * should still fail the run.
 */
export function createTeardown(): {
  own: <T extends Closeable>(c: T) => T
  dir: (d: string) => string
  run: () => Promise<void>
} {
  const closeables: Closeable[] = []
  const dirs: string[] = []
  return {
    /** Track anything with close() — a FlatStore, or a raw database it does not own. */
    own<T extends Closeable>(c: T): T {
      closeables.push(c)
      return c
    },
    /** Track a directory to remove once everything above is closed. */
    dir(d: string): string {
      dirs.push(d)
      return d
    },
    async run(): Promise<void> {
      // Reverse order: a store has to release its database before the raw
      // handle underneath it is closed.
      for (const c of closeables.reverse()) await c.close()
      closeables.length = 0
      // Plain rmSync, not rmTree: everything is closed by construction now, so
      // an EPERM here means a NEW leak and must be loud. Retries would turn
      // that report into a silence.
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
      dirs.length = 0
    },
  }
}
