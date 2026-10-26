import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openNodeSqlite, openRaw, pragmaRows, pragmaValue, setPragma, isBusyError, isCantOpenError,
  hasFts5, sqliteVersion, primaryCode, DEFAULT_PRAGMAS, SQLITE_BUSY, SQLITE_CANTOPEN,
} from '../../src/persistence/node-sqlite.js'

// D278: the node:sqlite adapter. What better-sqlite3 gave for free —
// transaction nesting, the pragma row shape, the busy error vocabulary,
// fileMustExist — this adapter owns, and these pin each.
describe('node:sqlite adapter (D278)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-nsq-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('this Node carries an FTS5-capable SQLite', () => {
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/)
    expect(hasFts5()).toBe(true)
  })

  it('applies DEFAULT_PRAGMAS on wrap: WAL, synchronous NORMAL, busy_timeout 10s', () => {
    expect(DEFAULT_PRAGMAS).toContainEqual(['busy_timeout', '10000'])
    expect(DEFAULT_PRAGMAS).toContainEqual(['synchronous', 'NORMAL'])
    const db = openNodeSqlite(join(dir, 'p.db'))
    expect(db.pragma('busy_timeout')).toEqual([{ timeout: 10000 }])
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }])
    expect(db.pragma('synchronous')).toEqual([{ synchronous: 1 }])
    db.close()
  })

  it('pragma() reads return the [{ name: value }] row shape, writes return their rows', () => {
    const db = openNodeSqlite(join(dir, 'q.db'))
    expect(db.pragma('user_version')).toEqual([{ user_version: 0 }])
    expect(db.pragma('user_version', 7)).toEqual([])
    expect(db.pragma('user_version')).toEqual([{ user_version: 7 }])
    expect(db.pragma('foreign_keys = OFF')).toEqual([])
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 0 }])
    db.close()
  })

  it('raw pragma helpers: rows, the simple value, and a write', () => {
    const raw = openRaw(join(dir, 'r.db'))
    expect(pragmaValue(raw, 'user_version')).toBe(0)
    setPragma(raw, 'user_version = 3')
    expect(pragmaRows(raw, 'user_version')).toEqual([{ user_version: 3 }])
    expect(pragmaValue(raw, 'no_such_pragma_xyz')).toBeUndefined()
    raw.close()
  })

  it('wraps an existing DatabaseSync and reports its path, none for :memory:', () => {
    const file = join(dir, 'w.db')
    const db = openNodeSqlite(new DatabaseSync(file))
    expect(db.path).toBe(file)
    db.close()
    const mem = openNodeSqlite(new DatabaseSync(':memory:'))
    expect(mem.path).toBeUndefined()
    mem.close()
  })

  it('close() is idempotent and tolerates a raw handle closed underneath it', () => {
    const raw = new DatabaseSync(':memory:')
    const db = openNodeSqlite(raw)
    db.close(); db.close()
    const raw2 = new DatabaseSync(':memory:')
    const db2 = openNodeSqlite(raw2)
    raw2.close()
    expect(() => db2.close()).not.toThrow()
  })

  it('transaction() commits on return and rolls back on throw', () => {
    const db = openNodeSqlite(join(dir, 't.db'))
    db.exec('CREATE TABLE t (v TEXT)')
    db.transaction(() => { db.prepare('INSERT INTO t VALUES (?)').run('a') })
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run('b')
      throw new Error('boom')
    })).toThrow('boom')
    expect(db.inTransaction).toBe(false)
    expect(db.prepare('SELECT v FROM t ORDER BY v').all()).toEqual([{ v: 'a' }])
    db.close()
  })

  it('a nested transaction is a savepoint: its rollback leaves the outer intact', () => {
    const db = openNodeSqlite(join(dir, 'n.db'))
    db.exec('CREATE TABLE t (v TEXT)')
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run('outer')
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (?)').run('inner')
          throw new Error('inner fails')
        })
      } catch { /* swallowed: outer continues */ }
      expect(db.inTransaction).toBe(true)
      db.transaction(() => { db.prepare('INSERT INTO t VALUES (?)').run('inner2') })
    })
    expect(db.prepare('SELECT v FROM t ORDER BY v').all()).toEqual([{ v: 'inner2' }, { v: 'outer' }])
    db.close()
  })

  it('transaction() takes the write lock at BEGIN: contention fails at the door with errcode SQLITE_BUSY', () => {
    const path = join(dir, 'c.db')
    const writer = openNodeSqlite(path)
    writer.exec('CREATE TABLE t (v TEXT)')
    const holder = new DatabaseSync(path)
    holder.exec('BEGIN IMMEDIATE')
    try {
      writer.pragma('busy_timeout', 50)
      let fnRan = false
      let thrown: unknown
      try {
        writer.transaction(() => { fnRan = true; writer.prepare('INSERT INTO t VALUES (?)').run('x') })
      } catch (err) { thrown = err }
      expect((thrown as { errcode?: number }).errcode).toBe(SQLITE_BUSY)
      expect(isBusyError(thrown)).toBe(true)
      expect(fnRan).toBe(false)
      expect(writer.inTransaction).toBe(false)
    } finally {
      holder.exec('ROLLBACK'); holder.close(); writer.close()
    }
  })

  it('errcode is the EXTENDED result code: the primary code is its low byte', () => {
    // SQLITE_BUSY_SNAPSHOT (517): a deferred transaction that read, then lost
    // the write race to another connection, fails at its first write.
    const path = join(dir, 'snap.db')
    const a = openNodeSqlite(path)
    a.exec('CREATE TABLE t (v INTEGER)')
    a.prepare('INSERT INTO t VALUES (1)').run()
    const b = new DatabaseSync(path, { timeout: 50 })
    let thrown: unknown
    try {
      a.transaction(() => {
        a.prepare('SELECT * FROM t').all() // take the read snapshot
        b.exec('UPDATE t SET v = 2') // another writer commits meanwhile
        a.prepare('UPDATE t SET v = 3').run() // the upgrade fails: BUSY_SNAPSHOT
      }, { mode: 'deferred' })
    } catch (err) { thrown = err }
    expect((thrown as { errcode?: number }).errcode).toBe(517)
    expect(primaryCode(thrown)).toBe(SQLITE_BUSY)
    expect(isBusyError(thrown)).toBe(true)
    expect(a.inTransaction).toBe(false)
    b.close(); a.close()
    expect(isBusyError(Object.assign(new Error('x'), { errcode: 517 }))).toBe(true)
    expect(isCantOpenError(Object.assign(new Error('x'), { errcode: 526 }))).toBe(true) // CANTOPEN_NOTEMPDIR
    expect(primaryCode(new Error('x'))).toBeUndefined()
  })

  it('isBusyError reads the errcode and falls back to the message', () => {
    expect(isBusyError(Object.assign(new Error('x'), { errcode: 6 }))).toBe(true)
    expect(isBusyError(new Error('database is locked'))).toBe(true)
    expect(isBusyError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(true)
    expect(isBusyError(new Error('no such table'))).toBe(false)
    expect(isBusyError('database is locked')).toBe(false)
  })

  it('openRaw mustExist / readOnly refuse a missing file with SQLITE_CANTOPEN and create nothing', () => {
    const missing = join(dir, 'missing.db')
    for (const opts of [{ mustExist: true }, { readOnly: true }]) {
      let thrown: unknown
      try { openRaw(missing, opts) } catch (err) { thrown = err }
      expect((thrown as { errcode?: number }).errcode).toBe(SQLITE_CANTOPEN)
      expect(isCantOpenError(thrown)).toBe(true)
      expect(existsSync(missing)).toBe(false)
    }
    // and without either, the file is created
    openRaw(missing).close()
    expect(existsSync(missing)).toBe(true)
  })

  it('openNodeSqlite honours timeoutMs on the wrapped door', () => {
    const db = openNodeSqlite(join(dir, 'to.db'), { timeoutMs: 50 })
    expect(db.pragma('busy_timeout')).toEqual([{ timeout: 50 }])
    db.close()
  })

  it('a read-only wrapped open of a rollback-journal file does not try to write its journal mode', () => {
    const path = join(dir, 'rj.db')
    const seed = new DatabaseSync(path)
    seed.exec('PRAGMA journal_mode = DELETE'); seed.exec('CREATE TABLE t (v)'); seed.close()
    const ro = openNodeSqlite(path, { readOnly: true })
    expect(ro.pragma('journal_mode')).toEqual([{ journal_mode: 'delete' }])
    expect(ro.prepare('SELECT count(*) AS c FROM t').get()).toEqual({ c: 0 })
    expect(() => ro.exec('INSERT INTO t VALUES (1)')).toThrow(/readonly/i)
    ro.close()
  })

  it('openRaw leaves URI filenames and the empty path to SQLite', () => {
    const path = join(dir, 'uri.db')
    openNodeSqlite(path).close()
    const viaUri = openRaw(`file:${path}?mode=ro`, { readOnly: true, mustExist: true })
    expect(() => viaUri.exec('CREATE TABLE t (v)')).toThrow(/readonly/i)
    viaUri.close()
    const temp = openRaw('', { mustExist: true })
    expect(temp.location()).toBeNull()
    temp.close()
  })

  it('a read-only open cannot write', () => {
    const path = join(dir, 'ro.db')
    openNodeSqlite(path).close()
    const ro = openRaw(path, { readOnly: true })
    expect(() => ro.exec('CREATE TABLE t (v)')).toThrow(/readonly/i)
    ro.close()
  })

  it('rows read with a null prototype still JSON-encode and spread like objects', () => {
    const db = openNodeSqlite(new DatabaseSync(':memory:'))
    const row = db.prepare("SELECT 1 AS a, 'b' AS b").get()!
    expect(JSON.parse(JSON.stringify(row))).toEqual({ a: 1, b: 'b' })
    expect({ ...row }).toEqual({ a: 1, b: 'b' })
    expect(Object.keys(row)).toEqual(['a', 'b'])
    db.close()
  })

  it('a BLOB reads back as a Uint8Array', () => {
    const db = openNodeSqlite(new DatabaseSync(':memory:'))
    db.exec('CREATE TABLE b (v BLOB)')
    db.prepare('INSERT INTO b VALUES (?)').run(Buffer.from([1, 2, 3]))
    const v = db.prepare('SELECT v FROM b').get()!.v
    expect(v).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(v as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    db.close()
  })
})
