/**
 * store-as-arbiter.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated 1:1 from the
 * vitest-cucumber binding; every sentence in this feature is unique and
 * every assertion preserved verbatim.)
 *
 * Program G corpus bindings. The scenarios bind the FINAL mechanism
 * (constraints, claims, leases); the dedup BEHAVIOR scenarios elsewhere
 * pass unchanged as the invariance proof. Refusal WORDING is pinned
 * once, in leases.test.ts — these bindings assert owner-visible
 * outcomes only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'
import { runMigrations, currentSchemaVersion } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { LeaseClient, leaseHolders, NS_LEASE_TTL_SECS, DRAIN_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import { StoreLockedError } from '../../src/errors/index.js'
import { FlatStore } from '../../src/flat-store.js'
import { contentFingerprint } from '../../src/fingerprint.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  // S1
  a?: FlatStore
  b?: FlatStore
  resultA?: { nodeId: string; deduplicated: boolean }
  resultB?: { nodeId: string; deduplicated: boolean }
  dbPath?: string
  // S2
  pA?: Persistence
  pB?: Persistence
  claimA?: Array<{ id: number; timestamp: number }>
  claimB?: Array<{ id: number; timestamp: number }>
  // S3/S5
  db?: Database
  rival?: LeaseClient
  // S4
  writer?: Database
  before?: ReturnType<typeof leaseHolders>
  seen?: ReturnType<typeof leaseHolders>
}

export const storeAsArbiterDefiner = (reg: Registry<World>): void => {
  function freshStorePath(w: World): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-arbiter-corpus-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    return join(dir, 'store.db')
  }

  function openMigrated(w: World, path: string): Database {
    const db = wrapBetterSqlite(new BetterSqlite3(path))
    w.defer(() => db.close())
    runMigrations(db, { migrate: true })
    return db
  }

  reg.define(/^two library handles on the same namespace through separate connections$/, async (w) => {
    w.dbPath = freshStorePath(w)
    const a = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true })
    const b = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true })
    w.defer(() => a.close())
    w.defer(() => b.close())
    w.a = a
    w.b = b
  })

  reg.define(/^both insert the same curated content$/, async (w) => {
    w.resultA = await w.a!.insert('the same decision, recorded twice by racing writers')
    w.resultB = await w.b!.insert('the same decision, recorded twice by racing writers')
  })

  reg.define(/^one row exists and both writers hold the same survivor id$/, (w) => {
    expect(w.resultB!.deduplicated).toBe(true)
    expect(w.resultB!.nodeId).toBe(w.resultA!.nodeId)
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      const n = raw.prepare("SELECT COUNT(*) AS n FROM nodes WHERE dedup_class = 'curated'").get() as { n: number }
      expect(n.n).toBe(1)
    } finally {
      raw.close()
    }
  })

  reg.define(/^a staged backlog and two drain identities$/, (w) => {
    const path = freshStorePath(w)
    w.pA = Persistence.openLexical(openMigrated(w, path))
    // A genuinely separate connection: the second drain sees only what
    // the store says, never the first drain's process state.
    const dbB = wrapBetterSqlite(new BetterSqlite3(path))
    w.defer(() => dbB.close())
    w.pB = Persistence.openLexical(dbB)
    for (let i = 0; i < 8; i++) {
      w.pA.insertStaging({ sessionId: 's', role: 'user', content: `event ${i}`, timestamp: 100 + i })
    }
  })

  reg.define(/^both claim batches at once$/, (w) => {
    w.claimA = w.pA!.claimStagingBatch('drain-a', 4, 120)
    w.claimB = w.pB!.claimStagingBatch('drain-b', 4, 120)
  })

  reg.define(/^the claims are disjoint and cover the backlog in capture order$/, (w) => {
    const ids = new Set([...w.claimA!, ...w.claimB!].map((r) => r.id))
    expect(ids.size).toBe(8)
    expect(w.claimA!.map((r) => r.timestamp)).toEqual([100, 101, 102, 103])
    expect(w.claimB!.map((r) => r.timestamp)).toEqual([104, 105, 106, 107])
  })

  reg.define(/^a server holding a namespace lease$/, (w) => {
    w.db = openMigrated(w, freshStorePath(w))
    new LeaseClient(w.db, { pid: 501, host: hostname() }).tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    w.rival = new LeaseClient(w.db, { pid: 502, host: hostname() })
  })

  reg.define(/^a rival naming the same namespace is refused, with the holder named$/, (w) => {
    // Outcome only: the refusal type and the named holder. The exact
    // message wording is pinned once, in leases.test.ts.
    let thrown: unknown
    try {
      w.rival!.tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(StoreLockedError)
    expect((thrown as StoreLockedError).holder.pid).toBe(501)
    expect(leaseHolders(w.db!).find((l) => l.role === 'ns:project')?.holderPid).toBe(501)
  })

  reg.define(/^the holder's heartbeats stop for longer than the lease TTL$/, (w) => {
    w.db!.prepare('UPDATE leases SET heartbeat_at = ?').run(Date.now() / 1000 - NS_LEASE_TTL_SECS - 1)
  })

  reg.define(/^the rival's next attempt takes the role$/, (w) => {
    w.rival!.tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    const holder = leaseHolders(w.db!).find((l) => l.role === 'ns:project')
    expect(holder?.holderPid).toBe(502)
    expect(holder?.live).toBe(true)
  })

  reg.define(/^a store whose drain and namespace roles are held$/, (w) => {
    w.dbPath = freshStorePath(w)
    w.writer = openMigrated(w, w.dbPath)
    // Two DISTINCT holders: a role-to-holder transposition must fail.
    new LeaseClient(w.writer, { pid: 601, host: hostname(), label: 'serve-a' }).tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
    new LeaseClient(w.writer, { pid: 602, host: hostname(), label: 'serve-b' }).tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    w.before = leaseHolders(w.writer)
  })

  reg.define(/^the lease table is read through a read-only handle$/, (w) => {
    // The doctor's exact shape (installer.ts): a RAW readonly
    // better-sqlite3 handle, cast at the boundary — not the wrapper.
    const ro = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      w.seen = leaseHolders(ro as unknown as Parameters<typeof leaseHolders>[0])
    } finally {
      ro.close()
    }
  })

  reg.define(/^every holder is visible with its liveness, and no role changed hands$/, (w) => {
    const roles = new Map(w.seen!.map((l) => [l.role, l]))
    expect(roles.get('drain')?.holderPid).toBe(601)
    expect(roles.get('drain')?.holderLabel).toBe('serve-a')
    expect(roles.get('drain')?.live).toBe(true)
    expect(roles.get('ns:project')?.holderPid).toBe(602)
    expect(roles.get('ns:project')?.holderLabel).toBe('serve-b')
    expect(roles.get('ns:project')?.live).toBe(true)
    // Read-only means read-only: the table after the read is the
    // table before it.
    expect(leaseHolders(w.writer!)).toEqual(w.before)
  })

  reg.define(/^a pre-arbiter store holding curated twins and an undecodable row$/, (w) => {
    const twinText = 'the same curated content, inserted twice before the arbiter existed'
    w.db = openMigrated(w, freshStorePath(w))
    w.db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
    const ins = w.db.prepare(
      `INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at, metadata_json)
       VALUES (?, 1, ?, '', ?, ?, ?)`,
    )
    ins.run('first', twinText, 100, 100, null)
    ins.run('second', twinText, 200, 200, JSON.stringify({ note: 'the later twin' }))
    ins.run('torn', Buffer.from([0xee, 9, 9]), 300, 300, JSON.stringify({ session_id: 'sess-torn', _relied_count: 4 }))
    // Roll the marker back so the arbiter pass re-runs over these rows.
    w.db.pragma('user_version', 20)
  })

  reg.define(/^the ladder runs to the current version$/, (w) => {
    runMigrations(w.db!, { migrate: true })
    expect(currentSchemaVersion(w.db!)).toBe(maxSupportedVersion)
  })

  reg.define(/^every decodable row is classified and the earliest twin keeps the curated slot$/, (w) => {
    const first = w.db!.prepare('SELECT dedup_class, fingerprint FROM nodes WHERE node_id = ?').get('first') as {
      dedup_class: string
      fingerprint: string
    }
    expect(first.dedup_class).toBe('curated')
    expect(first.fingerprint).toBe(contentFingerprint('the same curated content, inserted twice before the arbiter existed'))
  })

  reg.define(/^the twins survive as rows — nothing merged, nothing deleted, metadata untouched$/, (w) => {
    const second = w.db!.prepare('SELECT dedup_class, metadata_json FROM nodes WHERE node_id = ?').get('second') as {
      dedup_class: string
      metadata_json: string
    }
    expect(second.dedup_class).toBe('curated_dup')
    expect(JSON.parse(second.metadata_json)).toEqual({ note: 'the later twin' })
    expect((w.db!.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(3)
  })

  reg.define(/^the undecodable row is stamped from its metadata and waits for a capable runtime$/, (w) => {
    const torn = w.db!.prepare('SELECT fingerprint, dedup_class, session_key, relied_count FROM nodes WHERE node_id = ?').get('torn') as {
      fingerprint: string | null
      dedup_class: string
      session_key: string
      relied_count: number
    }
    expect(torn.fingerprint).toBeNull()
    expect(torn.dedup_class).toBe('curated')
    expect(torn.session_key).toBe('sess-torn')
    expect(torn.relied_count).toBe(4)
  })
}
