/**
 * SQLite Online Backup for treecontext stores.
 *
 * Uses node:sqlite's module-level `backup()` which wraps the SQLite
 * Online Backup API. This produces a consistent snapshot even while
 * the source database is being written to.
 */

import { backup as sqliteBackup } from 'node:sqlite'
import { existsSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { openRaw, pragmaValue, type SqliteError } from './node-sqlite.js'
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
  opts?: {
    force?: boolean
    /** How long to wait for a store another process holds locked before
     *  reporting it as locked (the raw opener's default when absent). */
    timeoutMs?: number
  },
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
  const db = openRaw(srcDbPath, { readOnly: true, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })

  const tmpPath = dstPath + '.' + randomBytes(4).toString('hex') + '.tmp'
  try {
    // Touch the source before the copy: node:sqlite's backup() of a store
    // another process holds exclusively (locking_mode EXCLUSIVE plus an
    // open write transaction, the D175 shape) rejects with errcode 0 and
    // the message "not an error" (measured 2026-10-26). A read here waits
    // out the busy timeout and throws the real SQLITE_BUSY, the error
    // isBusyError names and the CLI reports as a locked store.
    pragmaValue(db, 'user_version')
    try {
      await sqliteBackup(db, tmpPath)
    } catch (err) {
      // A lock taken between the touch and the copy still surfaces as the
      // driver's empty code; say what it means.
      if ((err as SqliteError | null)?.errcode === 0) {
        throw new Error(`database is locked: another process holds ${srcDbPath} exclusively (SQLite's backup reported no error code)`, { cause: err })
      }
      throw err
    }
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
    db.close()
  }
}
