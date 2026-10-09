import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite, DEFAULT_PRAGMAS } from '../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../src/persistence/migrations.js'

// design/store-as-arbiter.md accepted ceilings: "BEGIN IMMEDIATE for every
// read-modify-write transaction; a busy_timeout on every connection."
// Deferred read-then-write under WAL upgrades its lock mid-transaction and
// can fail with SQLITE_BUSY_SNAPSHOT — an error busy_timeout does NOT
// retry. Immediate takes the write lock at BEGIN, where busy_timeout does
// apply. These tests pin the wrapper's default to immediate and keep the
// deferred opt-out observable.
describe('write-transaction discipline (BEGIN IMMEDIATE by default)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-txn-mode-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies a 10s busy_timeout in DEFAULT_PRAGMAS on every open', () => {
    expect(DEFAULT_PRAGMAS).toContainEqual(['busy_timeout', '10000'])
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'pragmas.db')))
    expect(db.pragma('busy_timeout')).toEqual([{ timeout: 10000 }])
    db.close()
  })

  it('transaction() takes the write lock at BEGIN: contention fails at the door, before fn runs', () => {
    const path = join(dir, 'contended.db')
    const writer = wrapBetterSqlite(new BetterSqlite3(path))
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

    const holder = new BetterSqlite3(path)
    holder.exec('BEGIN IMMEDIATE')
    try {
      writer.pragma('busy_timeout', 100)
      let fnRan = false
      let thrown: unknown
      try {
        writer.transaction(() => {
          fnRan = true
          writer.prepare('INSERT INTO t (v) VALUES (?)').run('x')
        })
      } catch (err) {
        thrown = err
      }
      expect((thrown as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY')
      // The immediate BEGIN was refused outright — the body never started,
      // so there is no half-taken read snapshot to fail out of mid-flight.
      expect(fnRan).toBe(false)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      writer.close()
    }
  })

  it("mode: 'deferred' remains available for read-only transactions under a concurrent writer", () => {
    const path = join(dir, 'readers.db')
    const reader = wrapBetterSqlite(new BetterSqlite3(path))
    reader.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    reader.exec("INSERT INTO t (v) VALUES ('seed')")

    const holder = new BetterSqlite3(path)
    holder.exec('BEGIN IMMEDIATE')
    try {
      reader.pragma('busy_timeout', 100)
      const count = reader.transaction(
        () => (reader.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n,
        { mode: 'deferred' },
      )
      expect(count).toBe(1)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      reader.close()
    }
  })

  it('a busy additive-only migration batch surfaces as StoreBusyError via the IMMEDIATE branch', async () => {
    const path = join(dir, 'migrate-busy.db')
    // Build a fully migrated store, then roll the version marker back one
    // step so the only pending migration (020, additive) rides the
    // non-destructive branch — a fresh v0 store would take BEGIN
    // EXCLUSIVE for its destructive migrations and pass this test
    // without ever reaching the BEGIN IMMEDIATE path.
    const seed = wrapBetterSqlite(new BetterSqlite3(path))
    runMigrations(seed, { migrate: true })
    seed.pragma('user_version', 19)
    seed.close()

    // Since 024 (the digest rewrite, §11b) the SHIPPED ladder has no
    // version at all whose pending set is additive-only — exactly the
    // state the runner's own comment records for the pre-020 era, now
    // true again with a destructive migration newest. The IMMEDIATE
    // branch is still live code that the next additive migration will
    // take, so it is pinned against a ladder truncated below the
    // destructive head rather than deleted for being unreachable today.
    const real = await import('../../src/persistence/migrations/index.js')
    const additiveOnly = real.migrations.filter((m) => m.version <= 20)
    vi.resetModules()
    vi.doMock('../../src/persistence/migrations/index.js', () => ({
      migrations: additiveOnly,
      maxSupportedVersion: 20,
    }))
    const { runMigrations: runTruncatedLadder } = await import('../../src/persistence/migrations.js')
    // The reset registry holds its OWN copy of every module below the
    // runner, error classes included: `instanceof` the top-level import
    // would compare a fresh class against a stale one and fail on a
    // correct throw. Take the class from the same graph that threw it.
    const { StoreBusyError: FreshStoreBusyError } = await import('../../src/errors/index.js')

    const holder = new BetterSqlite3(path)
    holder.exec('BEGIN IMMEDIATE')
    try {
      const db = wrapBetterSqlite(new BetterSqlite3(path))
      db.pragma('busy_timeout', 100)
      try {
        let thrown: unknown
        try {
          runTruncatedLadder(db, { migrate: true })
        } catch (err) {
          thrown = err
        }
        expect(thrown).toBeInstanceOf(FreshStoreBusyError)
        // The non-destructive message — proof this exercised the
        // IMMEDIATE branch, not the pre-existing EXCLUSIVE one.
        expect((thrown as Error).message).toContain('another process is writing')
      } finally {
        db.close()
      }
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      vi.doUnmock('../../src/persistence/migrations/index.js')
      vi.resetModules()
    }
  })
})
