/**
 * Snapshot lifecycle tests. The production snapshot logic lives in the
 * hooks layer (src/hooks/shared.ts): writeSnapshot appends over a fresh
 * connection by path; claimSnapshot claims transactionally over a raw
 * node:sqlite handle. Persistence.openLexical only creates the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync, type DatabaseSync as DatabaseType } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { Persistence } from '../../src/persistence/store.js'
import { writeSnapshot, claimSnapshot } from '../../src/hooks/shared.js'
import { hasRegistry, registerSelf } from '../../src/persistence/session-registry.js'

/** A session's self as the session-start hook registers it: in the main
 *  checkout (`worktree` null) or a linked worktree of that name. */
function place(db: DatabaseType, sessionId: string, worktree: string | null = null): void {
  registerSelf(db, sessionId, { worktree, branch: worktree ? `${worktree}-branch` : 'main', cwd: '/repo', toplevel: null, commonDir: null }, Date.now() / 1000)
}

describe('Snapshots', () => {
  let tmpDir: string
  let dbPath: string
  let db: DatabaseType

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tc-test-'))
    dbPath = join(tmpDir, 'test.db')
    // Create the schema the way the server does, then hand the raw
    // connection to the hooks-layer functions under test.
    const setup = openNodeSqlite(new DatabaseSync(dbPath))
    Persistence.openLexical(setup).close()
    db = new DatabaseSync(dbPath)
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

  it('the schema the server creates holds the session registry the claim reads', () => {
    expect(hasRegistry(db)).toBe(true)
  })

  it('claimSnapshot returns most recent unclaimed, excludes own session, sets claimed_by', () => {
    for (const s of ['session-1', 'session-2', 'session-3']) place(db, s)
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
    place(db, 'session-1')
    writeSnapshot(dbPath, 'session-1', ['1'])
    expect(claimSnapshot(db, 'session-1')).toBeNull()
    expect(unclaimedCount()).toBe(1)
  })

  it('race safety: a snapshot is claimed once only', () => {
    for (const s of ['session-1', 'session-2', 'session-3']) place(db, s)
    writeSnapshot(dbPath, 'session-1', ['1'])
    const snap1 = claimSnapshot(db, 'session-2')
    const snap2 = claimSnapshot(db, 'session-3')
    expect(snap1).not.toBeNull()
    expect(snap2).toBeNull()
  })

  // D375: a fresh start adopts a snapshot only from its own lane.
  it('claims only a snapshot its own checkout left, the newest of its lane, never a newer one of another lane', () => {
    place(db, 'main-1'); place(db, 'wt-1', 'subproject'); place(db, 'other-1', 'other')
    place(db, 'main-2'); place(db, 'wt-2', 'subproject')
    const mainId = writeSnapshot(dbPath, 'main-1', ['main'])
    const wtId = writeSnapshot(dbPath, 'wt-1', ['subproject'])
    writeSnapshot(dbPath, 'other-1', ['other'])
    const fromMain = claimSnapshot(db, 'main-2')
    expect(fromMain).toMatchObject({ id: mainId, originalSessionId: 'main-1' })
    // Nothing else of main's lane is left: the worktrees' stay unclaimed.
    expect(claimSnapshot(db, 'main-2')).toBeNull()
    expect(unclaimedCount()).toBe(2)
    expect(claimSnapshot(db, 'wt-2')).toMatchObject({ id: wtId, originalSessionId: 'wt-1' })
    expect(unclaimedCount()).toBe(1)
  })

  it('a session the registry does not place claims nothing', () => {
    place(db, 'main-1')
    writeSnapshot(dbPath, 'main-1', ['main'])
    expect(claimSnapshot(db, 'unplaced')).toBeNull()
    expect(unclaimedCount()).toBe(1)
  })

  it('a snapshot whose session the registry never placed is claimed by no lane', () => {
    place(db, 'main-2'); place(db, 'wt-2', 'subproject')
    writeSnapshot(dbPath, 'before-the-registry', ['old'])
    expect(claimSnapshot(db, 'main-2')).toBeNull()
    expect(claimSnapshot(db, 'wt-2')).toBeNull()
    expect(unclaimedCount()).toBe(1)
  })
})
