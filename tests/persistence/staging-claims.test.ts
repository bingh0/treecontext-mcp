import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { Persistence } from '../../src/persistence/store.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { claimSnapshot, writeSnapshot } from '../../src/hooks/shared.js'

// G3 (store-as-arbiter §2 + amendment 7): the drain claims its batch in
// one atomic UPDATE … RETURNING — two drains get disjoint batches by
// construction; a crashed drain's claims expire by TTL; a live drain
// releases its soft-deadline leftovers at tick end; processed rows
// carry no claim; the valve never steals a live claim.
describe('staging claims (G3)', () => {
  let dir: string
  let p: Persistence

  function stage(sessionId: string, timestamp: number, content = 'event'): number {
    return p.insertStaging({ sessionId, role: 'user', content, timestamp })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-claims-'))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    runMigrations(db, { migrate: true })
    p = Persistence.openLexical(db)
  })
  afterEach(() => {
    p.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('two drains claim disjoint batches by construction', () => {
    for (let i = 0; i < 6; i++) stage('s', 100 + i)
    const a = p.claimStagingBatch('drain-a', 3, 120)
    const b = p.claimStagingBatch('drain-b', 3, 120)
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(3)
    const ids = new Set([...a, ...b].map((r) => r.id))
    expect(ids.size).toBe(6)
    // Oldest-first within each claim, same total order as the old fetch.
    expect(a.map((r) => r.timestamp)).toEqual([100, 101, 102])
    expect(b.map((r) => r.timestamp)).toEqual([103, 104, 105])
    // Nothing left to claim.
    expect(p.claimStagingBatch('drain-c', 3, 120)).toHaveLength(0)
  })

  it('a crashed drain’s claims expire by TTL and become claimable', () => {
    stage('s', 100)
    expect(p.claimStagingBatch('crashed', 5, 120)).toHaveLength(1)
    // Un-expired: another drain sees nothing.
    expect(p.claimStagingBatch('live', 5, 120)).toHaveLength(0)
    // Age the claim past the TTL — the crash story, no release ever ran.
    p.database.prepare('UPDATE staging SET claimed_at = ?').run(Date.now() / 1000 - 300)
    const reclaimed = p.claimStagingBatch('live', 5, 120)
    expect(reclaimed).toHaveLength(1)
  })

  it('tick-end release returns soft-deadline leftovers immediately', () => {
    stage('s', 100)
    stage('s', 101)
    const claimed = p.claimStagingBatch('drain-a', 5, 120)
    expect(claimed).toHaveLength(2)
    // drain-a processed one row, the deadline broke the loop on the
    // other — the row comes from the CLAIM's own return, not a raw
    // SELECT re-encoding the drain's ordering clause (pass-3 review).
    p.markStagingProcessedOwned([claimed[0]!.id], 'drain-a')
    expect(p.releaseStagingClaims('drain-a')).toBe(1)
    // The leftover is claimable NOW — no TTL wait.
    expect(p.claimStagingBatch('drain-b', 5, 120)).toHaveLength(1)
  })

  it('marking processed clears the claim', () => {
    const id = stage('s', 100)
    p.claimStagingBatch('drain-a', 5, 120)
    p.markStagingProcessedOwned([id], 'drain-a')
    const row = p.database.prepare('SELECT processed, claimed_by, claimed_at FROM staging WHERE id = ?').get(id) as {
      processed: number
      claimed_by: string | null
      claimed_at: number | null
    }
    expect(row.processed).toBe(1)
    expect(row.claimed_by).toBeNull()
    expect(row.claimed_at).toBeNull()
    expect(p.releaseStagingClaims('drain-a')).toBe(0)
  })

  it('the fenced mark never retires a row reclaimed by another drain', () => {
    const id = stage('s', 100)
    expect(p.claimStagingBatch('slow', 5, 120)).toHaveLength(1)
    // slow stalls past the TTL; fast reclaims the row and is in flight.
    p.database.prepare('UPDATE staging SET claimed_at = ?').run(Date.now() / 1000 - 300)
    expect(p.claimStagingBatch('fast', 5, 120)).toHaveLength(1)
    // slow finally finishes and tries to retire the row — the fence
    // refuses: it is fast's to retire now.
    expect(p.markStagingProcessedOwned([id], 'slow')).toBe(0)
    const mid = p.database.prepare('SELECT processed, claimed_by FROM staging WHERE id = ?').get(id) as {
      processed: number
      claimed_by: string | null
    }
    expect(mid.processed).toBe(0)
    expect(mid.claimed_by).toBe('fast')
    expect(p.markStagingProcessedOwned([id], 'fast')).toBe(1)
  })

  it('the valve drop is whole-group-or-nothing against live claims', () => {
    stage('victim', 100)
    stage('victim', 101)
    const now = Date.now() / 1000
    const cutoff = now - 120
    // One row of the group is claimed live (a drain raced the valve's
    // awaited tombstone): the drop must delete NOTHING — a partial
    // delete would tear a mid-session hole, a full one would destroy
    // in-flight rows.
    p.database.prepare("UPDATE staging SET claimed_by = 'racer', claimed_at = ? WHERE timestamp = 101").run(now)
    expect(p.dropUnprocessedStagingSession('victim', null, cutoff)).toBe(0)
    expect(p.countUnprocessedStaging()).toBe(2)
    // The claim expires — the whole group drops together.
    p.database.prepare('UPDATE staging SET claimed_at = ? WHERE timestamp = 101').run(now - 300)
    expect(p.dropUnprocessedStagingSession('victim', null, cutoff)).toBe(2)
  })

  it('the valve sees live claims per group and expired ones as free', () => {
    stage('claimed-live', 100)
    stage('claimed-expired', 200)
    stage('unclaimed', 300)
    p.database.prepare("UPDATE staging SET claimed_by = 'other', claimed_at = ? WHERE session_id = 'claimed-live'").run(Date.now() / 1000)
    p.database.prepare("UPDATE staging SET claimed_by = 'dead', claimed_at = ? WHERE session_id = 'claimed-expired'").run(Date.now() / 1000 - 300)

    const cutoff = Date.now() / 1000 - 120
    const bySession = new Map(p.unprocessedStagingSessions(cutoff).map((g) => [g.sessionId, g.liveClaims]))
    expect(bySession.get('claimed-live')).toBe(1)
    expect(bySession.get('claimed-expired')).toBe(0)
    expect(bySession.get('unclaimed')).toBe(0)
  })
})

describe('snapshot claims (G3)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-snap-claims-'))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    runMigrations(db, { migrate: true })
    db.close()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('two sessions racing for one snapshot: exactly one wins, the other gets null', () => {
    const path = join(dir, 'store.db')
    writeSnapshot(path, 'writer', ['what was I doing'])

    const a = new BetterSqlite3(path)
    const b = new BetterSqlite3(path)
    try {
      const first = claimSnapshot(a, 'reader-a')
      const second = claimSnapshot(b, 'reader-b')
      expect(first).not.toBeNull()
      expect(first!.originalSessionId).toBe('writer')
      expect(second).toBeNull()
    } finally {
      a.close()
      b.close()
    }
  })
})
