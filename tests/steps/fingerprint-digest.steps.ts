/**
 * fingerprint-digest.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated 1:1 from the
 * vitest-cucumber binding; every sentence in this feature is unique and
 * every assertion preserved verbatim.)
 *
 * The scenarios are owner-visible outcomes: two entries where there used
 * to be one, a store that heals when it climbs, and a doctor check that
 * reads zero afterwards without hiding what it left behind. The
 * mechanism — pass order, self-check, anchor rewrite — is pinned in
 * migration-024.test.ts.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { runMigrations, currentSchemaVersion, type MigrationReport } from '../../src/persistence/migrations.js'
import { migrations } from '../../src/persistence/migrations/index.js'
import { FlatStore } from '../../src/flat-store.js'
import { contentFingerprint, contentFingerprintV1 } from '../../src/fingerprint.js'
import { fingerprintCollisions, type ReadonlyStoreDb } from '../../src/server/store-audit.js'
import { enableDebug } from '../../src/debug.js'
import { COLLIDING_A, COLLIDING_B } from '../helpers/store-fixtures.js'

type InsertResult = Awaited<ReturnType<FlatStore['insert']>>

interface World {
  defer: (fn: () => void | Promise<void>) => void
  store?: FlatStore
  first?: InsertResult
  second?: InsertResult
  db?: Database
  report?: MigrationReport
  stderr?: string
  dbPath?: string
  counts?: { groups: number; rows: number; unmigrated: number | null }
}

export const fingerprintDigestDefiner = (reg: Registry<World>): void => {
  function freshDir(w: World): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-digest-corpus-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  /** Climb the real rungs to `target` — a v23 store, not a stamp. */
  function climbTo(db: Database, target: number): void {
    for (const m of migrations) {
      if (m.version <= currentSchemaVersion(db) || m.version > target) continue
      m.up(db)
      db.pragma('user_version', m.version)
    }
  }

  async function openStore(w: World, name: string): Promise<FlatStore> {
    const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), name)))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => store.close())
    return store
  }

  reg.define(/^two captured tool calls sharing a prefix and a suffix, differing only in a task id of equal width$/, async (w) => {
    // Built by construction in the fixture, and re-proved here: the
    // pre-v24 key cannot tell these apart.
    expect(COLLIDING_A.slice(0, 64)).toBe(COLLIDING_B.slice(0, 64))
    expect(COLLIDING_A.slice(-64)).toBe(COLLIDING_B.slice(-64))
    expect(COLLIDING_A.length).toBe(COLLIDING_B.length)
    expect(contentFingerprintV1(COLLIDING_A)).toBe(contentFingerprintV1(COLLIDING_B))
    w.store = await openStore(w, 'store.db')
  })

  reg.define(/^both are recorded as curated notes$/, async (w) => {
    w.first = await w.store!.insert(COLLIDING_A)
    w.second = await w.store!.insert(COLLIDING_B)
  })

  reg.define(/^two entries exist, each recallable by its own task id$/, async (w) => {
    expect(w.second!.deduplicated).toBe(false)
    expect(w.second!.nodeId).not.toBe(w.first!.nodeId)
    const a = await w.store!.query('bid7uolnu', { topK: 5 })
    const b = await w.store!.query('bl9plkhqf', { topK: 5 })
    expect(a.map((r) => r.nodeId)).toEqual([w.first!.nodeId])
    expect(b.map((r) => r.nodeId)).toEqual([w.second!.nodeId])
  })

  reg.define(/^a v23 store where two different tool calls were filed under one dedup key$/, (w) => {
    const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), 'v23.db')))
    w.defer(() => db.close())
    climbTo(db, 20)
    db.prepare('INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, 0)')
      .run('project')
    for (const [id, content, at] of [['a', COLLIDING_A, 100], ['b', COLLIDING_B, 200]] as const) {
      db.prepare(
        "INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES (?, 1, ?, '', ?, ?)",
      ).run(id, content, at, at)
    }
    climbTo(db, 23)
    const rows = db.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id')
      .all() as Array<{ node_id: string; fingerprint: string; dedup_class: string }>
    // The data loss, seeded: one key, and the second row demoted out of
    // the curated slot it should have held.
    expect(rows[0]!.fingerprint).toBe(rows[1]!.fingerprint)
    expect(rows.map((r) => r.dedup_class)).toEqual(['curated', 'curated_dup'])
    w.db = db
  })

  reg.define(/^the store is opened by a build that migrates it$/, (w) => {
    const chunks: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    // stderrOnly: the disclosure is what is under test, not a log file
    // in the developer's home directory.
    enableDebug({ stderrOnly: true })
    try {
      w.report = runMigrations(w.db!, { migrate: true })
    } finally {
      // Debug stays on for the rest of this file (the module has no
      // off switch, by design — it is a startup decision). Harmless:
      // stderrOnly writes no log file, and the remaining scenario
      // asserts on return values, not on output.
      process.stderr.write = write
      w.stderr = chunks.join('')
    }
  })

  reg.define(/^both entries hold a curated slot again, under keys of their own$/, (w) => {
    const rows = w.db!.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id')
      .all() as Array<{ node_id: string; fingerprint: string; dedup_class: string }>
    expect(rows.map((r) => r.dedup_class)).toEqual(['curated', 'curated'])
    expect(rows[0]!.fingerprint).toBe(contentFingerprint(COLLIDING_A))
    expect(rows[1]!.fingerprint).toBe(contentFingerprint(COLLIDING_B))
    expect(rows[0]!.fingerprint).not.toBe(rows[1]!.fingerprint)
  })

  reg.define(/^the pre-migration copy is on disk and the rewrite counts are disclosed in the debug log$/, (w) => {
    expect(existsSync(w.report!.backupPath!)).toBe(true)
    expect(w.stderr).toContain('024 fingerprint digest complete')
    expect(w.stderr).toMatch(/"rewritten":2/)
    expect(w.stderr).toMatch(/"undecodable":0/)
    // One row changed class (the promoted twin) — the count is a
    // measurement against the pre-pass snapshot, not an estimate.
    expect(w.stderr).toMatch(/"reclassified":1/)
  })

  reg.define(/^a migrated store holding a row whose content could not be decoded$/, (w) => {
    w.dbPath = join(freshDir(w), 'migrated.db')
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath))
    w.defer(() => db.close())
    climbTo(db, 20)
    db.prepare('INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, 0)')
      .run('project')
    const insert = db.prepare(
      "INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES (?, 1, ?, '', ?, ?)",
    )
    insert.run('a', COLLIDING_A, 100, 100)
    insert.run('b', COLLIDING_B, 200, 200)
    // The row 024 leaves alone: an unknown codec flag byte, so its
    // content cannot be read and its key cannot be recomputed. Filed
    // under the old form by hand — 023 leaves a sub-v23 store's
    // undecodable rows NULL, and it is the STALE OLD KEY case that
    // must not read as a collision.
    insert.run('torn', Buffer.from([0xee, 1, 2, 3]), 300, 300)
    climbTo(db, 23)
    // A stale old-form key of its OWN — what the last runtime that
    // could read this row wrote. (Not one of the pair's: the curated
    // unique index is live at v23 and would refuse it, which is itself
    // the invariant working.)
    db.prepare('UPDATE nodes SET fingerprint = ? WHERE node_id = ?')
      .run(contentFingerprintV1(`${COLLIDING_A} and a tail nobody else carries`), 'torn')
    runMigrations(db, { migrate: true })
    expect(currentSchemaVersion(db)).toBe(migrations.at(-1)!.version)
    db.close()
  })

  reg.define(/^the self-audit counts collisions and pre-digest keys on it$/, (w) => {
    const ro = new BetterSqlite3(w.dbPath!, { readonly: true, fileMustExist: true })
    try {
      w.counts = fingerprintCollisions(ro as unknown as ReadonlyStoreDb)
    } finally {
      ro.close()
    }
  })

  reg.define(/^no collision group is reported, and the undecodable row is counted as an unmigrated key$/, (w) => {
    // Zero collisions even though an old-form key is still sitting in
    // the store — because it is alone on that key now, and because the
    // rows that used to share it were split apart by the rewrite.
    expect(w.counts!.groups).toBe(0)
    expect(w.counts!.rows).toBe(0)
    // ...and the leftover is disclosed rather than hidden inside a
    // clean bill of health. The guard reads it because the store
    // genuinely stands at the digest schema.
    expect(w.counts!.unmigrated).toBe(1)
  })
}
