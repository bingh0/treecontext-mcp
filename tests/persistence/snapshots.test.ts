/**
 * Snapshot lifecycle tests. The production snapshot logic lives in the
 * hooks layer (src/hooks/shared.ts): writeSnapshot appends over a fresh
 * connection by path; claimSnapshot claims transactionally over a raw
 * better-sqlite3 handle. Persistence.openLexical only creates the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3, { type Database as DatabaseType } from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { Persistence } from '../../src/persistence/store.js'
import { writeSnapshot, claimSnapshot } from '../../src/hooks/shared.js'

describe('Snapshots', () => {
  let tmpDir: string
  let dbPath: string
  let db: DatabaseType

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-test-'))
    dbPath = join(tmpDir, 'test.db')
    // Create the schema the way the server does, then hand the raw
    // connection to the hooks-layer functions under test.
    const setup = wrapBetterSqlite(new BetterSqlite3(dbPath))
    Persistence.openLexical(setup).close()
    db = new BetterSqlite3(dbPath)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function unclaimedCount(): number {
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM snapshots WHERE claimed_by IS NULL')
      .get() as { cnt: number }
    return row.cnt
  }

  it('writeSnapshot stores and retrieves correctly', () => {
    const id = writeSnapshot(dbPath, 'session-1', ['query 1'])
    expect(id).toBeGreaterThan(0)
    expect(unclaimedCount()).toBe(1)
    const row = db
      .prepare('SELECT session_id, queries FROM snapshots WHERE id = ?')
      .get(id) as { session_id: string; queries: string }
    expect(row.session_id).toBe('session-1')
    expect(JSON.parse(row.queries)).toEqual(['query 1'])
  })

  it('claimSnapshot returns most recent unclaimed, excludes own session, sets claimed_by', () => {
    writeSnapshot(dbPath, 'session-1', ['1'])
    writeSnapshot(dbPath, 'session-2', ['2'])

    const snap = claimSnapshot(db, 'session-3')
    expect(snap).not.toBeNull()
    expect(snap!.originalSessionId).toBe('session-2')
    expect(snap!.queries).toEqual(['2'])

    const row = db
      .prepare('SELECT claimed_by, claimed_at FROM snapshots WHERE id = ?')
      .get(snap!.id) as { claimed_by: string; claimed_at: number }
    expect(row.claimed_by).toBe('session-3')
    expect(row.claimed_at).toBeGreaterThan(0)
    expect(unclaimedCount()).toBe(1)
  })

  it('claimSnapshot returns null when none available', () => {
    expect(claimSnapshot(db, 'session-1')).toBeNull()
  })

  it('self-injection guard prevents a session from claiming its own snapshot', () => {
    writeSnapshot(dbPath, 'session-1', ['1'])
    expect(claimSnapshot(db, 'session-1')).toBeNull()
    expect(unclaimedCount()).toBe(1)
  })

  it('race safety: a snapshot is claimed once only', () => {
    writeSnapshot(dbPath, 'session-1', ['1'])
    const snap1 = claimSnapshot(db, 'session-2')
    const snap2 = claimSnapshot(db, 'session-3')
    expect(snap1).not.toBeNull()
    expect(snap2).toBeNull()
  })
})
