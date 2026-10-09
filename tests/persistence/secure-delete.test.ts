/**
 * Tests for S6: secure-delete opt-in (PRAGMA secure_delete + secureWipe).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'

describe('secure-delete', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does NOT enable secure_delete by default', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-sd-'))
    const raw = new BetterSqlite3(join(tmpDir, 'test.db'))
    const db = wrapBetterSqlite(raw)
    const [row] = db.pragma('secure_delete') as Array<{ secure_delete: number }>
    expect(row, 'PRAGMA secure_delete must report a row').toBeDefined()
    expect(row!.secure_delete).toBe(0)
    db.close()
  })

  it('enables secure_delete when opted in', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-sd-'))
    const raw = new BetterSqlite3(join(tmpDir, 'test.db'))
    const db = wrapBetterSqlite(raw, { secureDelete: true })
    const [row] = db.pragma('secure_delete') as Array<{ secure_delete: number }>
    expect(row, 'PRAGMA secure_delete must report a row').toBeDefined()
    expect(row!.secure_delete).toBe(1)
    expect(db.secureDelete).toBe(true)
    db.close()
  })

  it('secureWipe() is a no-op when secureDelete is off', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-sd-'))
    const raw = new BetterSqlite3(join(tmpDir, 'test.db'))
    const db = wrapBetterSqlite(raw)
    // Should not throw
    db.secureWipe?.()
    db.close()
  })

  it('secureWipe() runs VACUUM when secureDelete is on', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-sd-'))
    const path = join(tmpDir, 'test.db')
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw, { secureDelete: true })

    // Create a table, insert data, delete it, then wipe
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)')
    db.exec("INSERT INTO t VALUES (1, 'sensitive')")
    db.exec('DELETE FROM t')

    // Should not throw — runs VACUUM + WAL checkpoint
    db.secureWipe!()
    db.close()
  })
})
