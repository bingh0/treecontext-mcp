import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { LeaseClient, leaseHolders, DRAIN_LEASE_TTL_SECS, NS_LEASE_TTL_SECS, SWEEP_LEASE_TTL_SECS, LEASE_RENEW_INTERVAL_MS } from '../../src/persistence/leases.js'
import { StoreLockedError } from '../../src/errors/index.js'
import { FlatStore } from '../../src/flat-store.js'

// G4 (store-as-arbiter §3): role coordination through the lease table.
// Liveness is heartbeat expiry — no pid probing, no lockfile ASSUMPTION
// ledger. Distinct fake pids simulate distinct processes: identity is
// purely what the row records.
describe('role leases (G4)', () => {
  let dir: string
  let db: Database

  const clientA = () => new LeaseClient(db, { pid: 11111, host: 'host-a' })
  const clientB = () => new LeaseClient(db, { pid: 22222, host: 'host-a' })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-leases-'))
    db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    runMigrations(db, { migrate: true })
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a live foreign holder refuses, naming the namespace and the holder', () => {
    clientA().tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    let thrown: unknown
    try {
      clientB().tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(StoreLockedError)
    expect((thrown as Error).message).toMatch(/Namespace 'project'.*Only one writer per namespace/)
    expect((thrown as StoreLockedError).holder.pid).toBe(11111)
  })

  it('a fresh self re-acquire is a no-op; renewAll is the heartbeat: acquired_at survives, heartbeat_at advances', () => {
    // Pass-2 cleanup ruling (2026-08-15): tryAcquire runs on every tool
    // call via lockHook, so a held-and-fresh role skips the write
    // entirely — no legal steal exists inside our own TTL. The renew
    // timer (and any call past the freshness window) is the heartbeat.
    const a = clientA()
    a.tryAcquire('drain', 60)
    const before = leaseHolders(db).find((l) => l.role === 'drain')!
    db.prepare('UPDATE leases SET heartbeat_at = heartbeat_at - 30').run()
    a.tryAcquire('drain', 60)
    const mid = leaseHolders(db).find((l) => l.role === 'drain')!
    expect(mid.heartbeatAt).toBeCloseTo(before.heartbeatAt - 30, 0)
    a.renewAll()
    const after = leaseHolders(db).find((l) => l.role === 'drain')!
    expect(after.acquiredAt).toBe(before.acquiredAt)
    expect(after.heartbeatAt).toBeGreaterThan(before.heartbeatAt - 30)
  })

  it('an out-of-band row loss is seen on the very NEXT call, not the next tick (pass-3)', () => {
    // The write-skip economy must never vouch from memory alone: every
    // tryAcquire reads the row, so a cleared table + foreign takeover
    // refuses immediately — no 20s two-writer window.
    const a = clientA()
    a.tryAcquire('ns:project', 90)
    db.prepare('DELETE FROM leases').run()
    clientB().tryAcquire('ns:project', 90)
    expect(() => a.tryAcquire('ns:project', 90)).toThrow(StoreLockedError)
  })

  it('every exported TTL exceeds the renew interval', () => {
    // The write-skip trusts probeLive per call, so this is defense in
    // depth rather than load-bearing — but a role whose TTL fits inside
    // the renew interval would flap on timer jitter regardless.
    for (const ttl of [DRAIN_LEASE_TTL_SECS, NS_LEASE_TTL_SECS, SWEEP_LEASE_TTL_SECS]) {
      expect(ttl * 1000).toBeGreaterThan(LEASE_RENEW_INTERVAL_MS)
    }
  })

  it('renewAll never resurrects a role whose row is gone (release or expiry-takeover)', () => {
    // Pass-2 finding: the old tryAcquire-based renew silently re-took
    // an expired-and-released role, letting a stale sweeper resume a
    // stale plan after its successor finished and released.
    const a = clientA()
    a.tryAcquire('sweep:project', 60)
    db.prepare('DELETE FROM leases').run() // successor came, swept, released
    a.renewAll()
    expect(a.holds('sweep:project')).toBe(false)
    expect(leaseHolders(db).find((l) => l.role === 'sweep:project')).toBeUndefined()
  })

  it('an expired lease is reclaimed; an active one is not', () => {
    clientA().tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    // Age the heartbeat past the TTL — the holder is dead by definition.
    db.prepare('UPDATE leases SET heartbeat_at = ?').run(Date.now() / 1000 - NS_LEASE_TTL_SECS - 1)
    clientB().tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    const holder = leaseHolders(db).find((l) => l.role === 'ns:project')!
    expect(holder.holderPid).toBe(22222)
    expect(holder.live).toBe(true)
  })

  it('release is delete-if-mine: a foreign release cannot free my role', () => {
    const a = clientA()
    a.tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    // B never held it — its release must be a no-op on A's row.
    clientB().release('ns:project')
    expect(leaseHolders(db).find((l) => l.role === 'ns:project')?.holderPid).toBe(11111)
    a.release('ns:project')
    expect(leaseHolders(db).find((l) => l.role === 'ns:project')).toBeUndefined()
  })

  it('renewAll drops a role someone reclaimed after our expiry instead of stealing it back', () => {
    const a = clientA()
    a.tryAcquire('drain', 60)
    db.prepare('UPDATE leases SET heartbeat_at = ?').run(Date.now() / 1000 - 120)
    clientB().tryAcquire('drain', 60)
    a.renewAll()
    expect(leaseHolders(db).find((l) => l.role === 'drain')?.holderPid).toBe(22222)
  })

  it('holds() reports the loss renewAll just discovered (release-diff review 2026-08-15)', () => {
    // The sweep gates its next victim on this: a role renewAll dropped
    // means another holder owns it, and continuing would be the
    // two-sweeper interleaving the lease exists to exclude.
    const a = clientA()
    a.tryAcquire('sweep:project', 60)
    expect(a.holds('sweep:project')).toBe(true)
    db.prepare('UPDATE leases SET heartbeat_at = ?').run(Date.now() / 1000 - 120)
    clientB().tryAcquire('sweep:project', 60)
    a.renewAll()
    expect(a.holds('sweep:project')).toBe(false)
  })

  it('the maintenance heartbeat fires before the sweep blocks the event loop', async () => {
    let beats = 0
    const store = await FlatStore.open({
      database: db, ownsDatabase: false,
      maintenanceHeartbeat: () => { beats++ },
    })
    store.retentionSweep()
    expect(beats).toBeGreaterThan(0)
    await store.close()
  })

  it('the retention sweep skips, not fails, when another process holds sweep:<ns>', async () => {
    const store = await FlatStore.open({ database: db, ownsDatabase: false })
    // One client INSTANCE throughout: release is fenced by the client's
    // own token, so a fresh instance could not free this row.
    const sweeper = clientA()
    sweeper.tryAcquire('sweep:project', SWEEP_LEASE_TTL_SECS)
    expect(store.retentionSweep()).toEqual({ evicted: 0, demoted: 0 })
    // Held transiently: after the foreign sweep releases, ours runs.
    sweeper.release('sweep:project')
    const result = store.retentionSweep()
    expect(result.evicted).toBeGreaterThanOrEqual(0)
    // The transient lease released itself at sweep end.
    expect(leaseHolders(db).find((l) => l.role === 'sweep:project')).toBeUndefined()
    await store.close()
  })
})
