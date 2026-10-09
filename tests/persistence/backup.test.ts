import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { backupStore } from '../../src/persistence/backup.js'
import { itPosix } from '../helpers/platform.js'

describe('backup', () => {
  let tmpDir: string
  let srcPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-backup-'))
    srcPath = join(tmpDir, 'source.db')
    // Create a real SQLite DB with some data.
    const db = new BetterSqlite3(srcPath)
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
    db.exec("INSERT INTO test VALUES (1, 'hello')")
    db.exec("INSERT INTO test VALUES (2, 'world')")
    db.close()
  })

  it('creates a valid backup', async () => {
    const dstPath = join(tmpDir, 'backup.db')
    await backupStore(srcPath, dstPath)

    expect(existsSync(dstPath)).toBe(true)
    const db = new BetterSqlite3(dstPath, { readonly: true })
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
})
