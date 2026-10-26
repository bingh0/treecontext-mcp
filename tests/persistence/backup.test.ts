import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { backupStore } from '../../src/persistence/backup.js'
import { isBusyError } from '../../src/persistence/node-sqlite.js'
import { itPosix } from '../helpers/platform.js'
import { killAndWait } from '../journal/proc.js'

const LOCKER = fileURLToPath(new URL('../helpers/store-locker.cjs', import.meta.url))

describe('backup', () => {
  let tmpDir: string
  let srcPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-backup-'))
    srcPath = join(tmpDir, 'source.db')
    // Create a real SQLite DB with some data.
    const db = new DatabaseSync(srcPath)
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
    db.exec("INSERT INTO test VALUES (1, 'hello')")
    db.exec("INSERT INTO test VALUES (2, 'world')")
    db.close()
  })

  it('creates a valid backup', async () => {
    const dstPath = join(tmpDir, 'backup.db')
    await backupStore(srcPath, dstPath)

    expect(existsSync(dstPath)).toBe(true)
    const db = new DatabaseSync(dstPath, { readOnly: true })
    const rows = db.prepare('SELECT * FROM test').all()
    expect(rows).toHaveLength(2)
    db.close()
  })

  itPosix('backup file has mode 0o600', async () => {
    const dstPath = join(tmpDir, 'backup.db')
    await backupStore(srcPath, dstPath)
    const st = statSync(dstPath)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('refuses to overwrite existing without --force', async () => {
    const dstPath = join(tmpDir, 'backup.db')
    await backupStore(srcPath, dstPath)
    await expect(backupStore(srcPath, dstPath)).rejects.toThrow('already exists')
  })

  it('overwrites with --force', async () => {
    const dstPath = join(tmpDir, 'backup.db')
    await backupStore(srcPath, dstPath)
    await backupStore(srcPath, dstPath, { force: true })
    expect(existsSync(dstPath)).toBe(true)
  })

  it('rejects when dst directory does not exist', async () => {
    const dstPath = join(tmpDir, 'nonexistent', 'backup.db')
    await expect(backupStore(srcPath, dstPath)).rejects.toThrow('does not exist')
  })

  it('a store another process holds locked is reported as locked, not as "not an error"', async () => {
    // node:sqlite's backup() of an exclusively held source rejects with
    // errcode 0, "not an error" (review of the ported sites, 2026-10-26);
    // the touch before the copy turns that into the real SQLITE_BUSY.
    const locker = spawn(process.execPath, [LOCKER, srcPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      let seen = ''
      await new Promise<void>((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error(`locker never locked: ${seen}`)), 20_000)
        locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
        locker.on('exit', (code) => { clearTimeout(bail); reject(new Error(`locker exited ${code}: ${seen}`)) })
      })
      const dstPath = join(tmpDir, 'backup.db')
      let caught: unknown
      try { await backupStore(srcPath, dstPath, { timeoutMs: 300 }) } catch (err) { caught = err }
      expect(caught, 'backup of a locked store succeeded').toBeInstanceOf(Error)
      expect(isBusyError(caught), (caught as Error).message).toBe(true)
      expect((caught as Error).message).not.toMatch(/not an error/)
      expect(existsSync(dstPath)).toBe(false)
    } finally {
      await killAndWait(locker)()
    }
  })
})
