/**
 * SQLite Online Backup for treecontext stores.
 *
 * Uses better-sqlite3's `db.backup()` API which wraps the SQLite
 * Online Backup API. This produces a consistent snapshot even while
 * the source database is being written to.
 */

import { existsSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dbg } from '../debug.js'

/**
 * Create a backup of a SQLite store file to `dstPath`.
 *
 * Writes to a temporary file first, then renames atomically to avoid
 * leaving a partial file on failure. Refuses to overwrite unless
 * `force` is set.
 */
export async function backupStore(
  srcDbPath: string,
  dstPath: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (existsSync(dstPath) && !opts?.force) {
    throw new Error(
      `Destination already exists: ${dstPath}. Use --force to overwrite.`,
    )
  }

  const dstDir = dirname(dstPath)
  if (!existsSync(dstDir)) {
    throw new Error(`Destination directory does not exist: ${dstDir}`)
  }

  dbg('backup', 'starting', { src: srcDbPath, dst: dstPath, force: opts?.force })
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const db = new BetterSqlite3(srcDbPath, { readonly: true })
  // better-sqlite3 Database instances have backup() at runtime;
  // the @types declaration uses a namespace collision that makes
  // direct typing fragile. Cast to access the method safely.
  const backupDb = db as unknown as { backup(dst: string): Promise<unknown>; close(): void }

  const tmpPath = dstPath + '.' + randomBytes(4).toString('hex') + '.tmp'
  try {
    await backupDb.backup(tmpPath)
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, dstPath)
    dbg('backup', 'complete', { dst: dstPath })
  } catch (err) {
    // Clean up partial temp file on failure.
    try {
      unlinkSync(tmpPath)
    } catch { /* ignore */ }
    throw err
  } finally {
    backupDb.close()
  }
}
