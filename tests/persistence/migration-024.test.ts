/**
 * Migration 024 — the fingerprint becomes a digest
 * (docs/project-identity.md §11b, pre-registered 2026-08-20).
 *
 * The pins here are the ones the runner's completion verdict cannot
 * give: it compares `nodes` COUNT(*), which a VALUE rewrite never
 * changes, so it reads 'success' whatever this pass writes. What stands
 * in its place is the in-transaction self-check, the ORDER of the pass
 * (reclassification over final keys, never per-row against live state),
 * and the anchor rewrite — each pinned below as the failure it would be.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { runMigrations, currentSchemaVersion } from '../../src/persistence/migrations.js'
import { migrations, maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { __setDigestPoisonHookForTests } from '../../src/persistence/migrations/024_fingerprint_digest.js'
import { verdictPathFor } from '../../src/persistence/backup-verdict.js'
import { contentFingerprint, contentFingerprintV1 } from '../../src/fingerprint.js'
import { encodeContent } from '../../src/persistence/content-codec.js'
import { COLLIDING_A, COLLIDING_B } from '../helpers/store-fixtures.js'
import { itPosix } from '../helpers/platform.js'

describe('migration 024_fingerprint_digest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-mig24-'))
  })
  afterEach(() => {
    __setDigestPoisonHookForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  /** Climb the REAL rungs up to `target` — what a binary of that vintage
   *  did, so a "v23 store" here is the genuine article rather than a
   *  hand-stamped imitation. */
  function climbTo(db: Database, target: number): void {
    for (const m of migrations) {
      if (m.version <= currentSchemaVersion(db) || m.version > target) continue
      m.up(db)
      db.pragma('user_version', m.version)
    }
  }

  interface RawRow {
    id: string
    content: string | Buffer
    sourceLabel?: string | null
    metadata?: Record<string, unknown> | null
    createdAt: number
  }

  /** A pre-021 row: at v20 the arbiter columns do not exist yet, so this
   *  writes what a binary of that vintage could write and nothing more. */
  function insertRaw(db: Database, row: RawRow): void {
    db.prepare(
      `INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at,
                          source_label, metadata_json)
       VALUES (?, 1, ?, '', ?, ?, ?, ?)`,
    ).run(
      row.id, row.content, row.createdAt, row.createdAt,
      row.sourceLabel ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    )
  }

  /** A store exactly as a v23 binary left it: schema at 20, rows written
   *  pre-arbiter, then 021/022/023 run for real (V1 keys, twins resolved
   *  by 023's rule, anchors seeded on V1 keys). */
  function seedV23(name: string, rows: RawRow[]): Database {
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    climbTo(db, 20)
    db.prepare('INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, 0)')
      .run('project')
    for (const r of rows) insertRaw(db, r)
    climbTo(db, 23)
    expect(currentSchemaVersion(db)).toBe(23)
    return db
  }

  const nodeRow = (db: Database, id: string): Record<string, unknown> =>
    db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(id)!

  const anchors = (db: Database): Array<Record<string, unknown>> =>
    db.prepare('SELECT * FROM dedup_anchors ORDER BY node_id').all()

  it('a genuine false collision heals: two texts, one pre-024 key, two curated rows after', () => {
    // §9.2's measured shape, seeded as the data loss it causes: at v23
    // these two DIFFERENT texts share one key, so 023 files the second as
    // a duplicate of the first.
    const db = seedV23('heal.db', [
      { id: 'a', content: COLLIDING_A, createdAt: 100 },
      { id: 'b', content: COLLIDING_B, createdAt: 200 },
    ])
    expect(nodeRow(db, 'a').fingerprint).toBe(contentFingerprintV1(COLLIDING_A))
    expect(nodeRow(db, 'b').fingerprint).toBe(nodeRow(db, 'a').fingerprint)
    expect(nodeRow(db, 'b').dedup_class).toBe('curated_dup')

    const report = runMigrations(db, { migrate: true })

    expect(report.applied.map((a) => a.version)).toEqual([24, 25, 26, 27])
    expect(nodeRow(db, 'a').fingerprint).toBe(contentFingerprint(COLLIDING_A))
    expect(nodeRow(db, 'b').fingerprint).toBe(contentFingerprint(COLLIDING_B))
    expect(nodeRow(db, 'a').fingerprint).not.toBe(nodeRow(db, 'b').fingerprint)
    // Both hold a curated slot: the demotion was a judgement about a key
    // that could not tell them apart, and it is retracted.
    expect(nodeRow(db, 'a').dedup_class).toBe('curated')
    expect(nodeRow(db, 'b').dedup_class).toBe('curated')
    // Destructive: the store was copied aside first, and the verdict was
    // recorded against this run's twin.
    expect(existsSync(report.backupPath!)).toBe(true)
    expect(report.verdict).toBe('success')
    db.close()
  })

  itPosix('the destructive backup and its verdict land 0600 on create (docs/security.md §3)', () => {
    const db = seedV23('modes.db', [
      { id: 'a', content: COLLIDING_A, createdAt: 100 },
      { id: 'b', content: COLLIDING_B, createdAt: 200 },
    ])
    const report = runMigrations(db, { migrate: true })
    expect(report.verdict).toBe('success')
    // VACUUM INTO mints the .bak with SQLite's own default file
    // permissions; the runner tightens it — both copies are the
    // pre-migration journal and stay private.
    expect(statSync(report.backupPath!).mode & 0o777).toBe(0o600)
    expect(statSync(verdictPathFor(report.backupPath!)).mode & 0o777).toBe(0o600)
    db.close()
  })

  it('earliest-wins survives the promote/demote, even when rowid order inverts created_at order', () => {
    // Two GENUINELY identical curated rows — no false collision, so one
    // of them must stay demoted. The rows are seeded so that rowid order
    // is the OPPOSITE of created_at order, which is what an import from a
    // foreign store produces. A pass that reclassified per row against
    // live state (in rowid order) would hand the slot to 'late'; the
    // shipped pass promotes both and re-runs 023's ROW_NUMBER over the
    // FINAL keys, which is ordered by (created_at, rowid).
    const twin = 'the same decision, imported in the wrong order'
    const db = seedV23('earliest.db', [
      { id: 'late', content: twin, createdAt: 900 },
      { id: 'early', content: twin, createdAt: 100 },
    ])
    const rowids = db.prepare('SELECT node_id, rowid AS rid FROM nodes ORDER BY rowid')
      .all() as Array<{ node_id: string; rid: number }>
    expect(rowids.map((r) => r.node_id), 'the fixture must invert the orders').toEqual(['late', 'early'])
    expect(nodeRow(db, 'early').dedup_class).toBe('curated')

    runMigrations(db, { migrate: true })

    expect(nodeRow(db, 'early').dedup_class).toBe('curated')
    expect(nodeRow(db, 'late').dedup_class).toBe('curated_dup')
    // Nothing merged, nothing deleted — both rows still carry the same
    // (now digest) key.
    expect(nodeRow(db, 'early').fingerprint).toBe(contentFingerprint(twin))
    expect(nodeRow(db, 'late').fingerprint).toBe(contentFingerprint(twin))
    expect((db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(2)
    db.close()
  })

  it('the anchors are re-keyed, and the ones that cannot be are deleted', () => {
    // An anchor left on the OLD key is invisible to liveAnchor, so every
    // in-window duplicate re-inserts — the anchor rewrite is the half of
    // this migration that keeps dedup working at all (§11b findings 5/6).
    const auto = 'Tool: Bash — a captured tool call whose output is long enough to matter'
    const meta = { source: 'auto-capture', session_id: 'sess-A' }
    const db = seedV23('anchors.db', [
      { id: 'live-auto', content: auto, sourceLabel: 'auto-capture', metadata: meta, createdAt: 500 },
      // Undecodable AUTO row: 023 leaves its fingerprint NULL and seeds
      // no anchor for it, so the anchor below is hand-placed — the state
      // a store reaches when a row was written by a capable runtime and
      // is later read by one that cannot decode it.
      { id: 'frozen-auto', content: Buffer.from([0xee, 1, 2, 3]), sourceLabel: 'auto-capture', metadata: meta, createdAt: 600 },
    ])
    const seeded = anchors(db)
    expect(seeded).toHaveLength(1)
    expect(seeded[0]!.fingerprint).toBe(contentFingerprintV1(auto))
    expect(seeded[0]!.last_seen).toBe(500)

    db.pragma('foreign_keys = OFF')
    db.prepare(
      'INSERT INTO dedup_anchors (tree_id, session_key, fingerprint, node_id, last_seen, updated_at)'
      + " VALUES (1, 'sess-A', 'a-key-for-a-node-that-is-gone', 'vanished', 700, 700)",
    ).run()
    db.prepare(
      'INSERT INTO dedup_anchors (tree_id, session_key, fingerprint, node_id, last_seen, updated_at)'
      + " VALUES (1, 'sess-A', ?, 'frozen-auto', 800, 800)",
    ).run('a-stale-key-for-an-undecodable-row')
    db.pragma('foreign_keys = ON')
    expect(anchors(db)).toHaveLength(3)

    runMigrations(db, { migrate: true })

    const after = anchors(db)
    expect(after).toHaveLength(1)
    // An anchor's fingerprint equals its node's — the invariant the
    // rewrite exists to restore.
    expect(after[0]!.node_id).toBe('live-auto')
    expect(after[0]!.fingerprint).toBe(contentFingerprint(auto))
    expect(nodeRow(db, 'live-auto').fingerprint).toBe(after[0]!.fingerprint)
    // last_seen is capture time (the sliding window) and survives.
    expect(after[0]!.last_seen).toBe(500)
    // The orphan and the keyless-node anchor are gone, not carried
    // forward with a key nothing can match: dedup_anchors.fingerprint is
    // NOT NULL, so the correlated-UPDATE spelling would have aborted the
    // whole ladder here.
    expect(after.map((a) => a.node_id)).not.toContain('vanished')
    expect(after.map((a) => a.node_id)).not.toContain('frozen-auto')
    expect(nodeRow(db, 'frozen-auto').fingerprint).toBeNull()
    db.close()
  })

  it('the self-check throws on a bad rewrite, and the batch takes the whole ladder back with it', () => {
    const db = seedV23('poisoned.db', [
      { id: 'a', content: COLLIDING_A, createdAt: 100 },
      { id: 'b', content: COLLIDING_B, createdAt: 200 },
    ])
    const before = db.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id').all()

    // Exactly what a buggy rewrite leaves behind: a decodable row whose
    // key is not the digest. The hook fires inside the transaction, after
    // the pass and before the check.
    __setDigestPoisonHookForTests((poisoned) => {
      poisoned.prepare("UPDATE nodes SET fingerprint = 'not-a-digest' WHERE node_id = 'a'").run()
    })
    expect(() => runMigrations(db, { migrate: true }))
      .toThrow(/self-check failed.*do not carry a 32-hex digest/s)

    // Rolled back: still a v23 store, still openable by the binary that
    // wrote it, values untouched.
    expect(currentSchemaVersion(db)).toBe(23)
    expect(db.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id').all())
      .toEqual(before)
    // And the backup is on disk, because the copy is taken BEFORE the
    // batch — a failed migration is exactly when it is wanted.
    expect(existsSync(join(dir, 'poisoned.db.pre-migration-v23.bak'))).toBe(true)
    db.close()
  })

  it('the self-check throws on a SHAPED-BUT-WRONG key — a rewrite that hashed the wrong text (M2)', () => {
    const db = seedV23('miswritten.db', [
      { id: 'a', content: COLLIDING_A, createdAt: 100 },
      { id: 'b', content: COLLIDING_B, createdAt: 200 },
    ])
    const before = db.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id').all()
    // A perfectly-shaped 32-hex key that is NOT this row's content digest:
    // the shape check passes, so only the value re-derivation catches it.
    // This is what a rewrite hashing the raw blob, or the wrong column,
    // would leave — undetectable by shape alone, and undetectable forever
    // after (doctor's collision query cannot see digest-era keys).
    __setDigestPoisonHookForTests((poisoned) => {
      poisoned.prepare("UPDATE nodes SET fingerprint = '0123456789abcdef0123456789abcdef' WHERE node_id = 'a'").run()
    })
    expect(() => runMigrations(db, { migrate: true }))
      .toThrow(/self-check failed.*re-derives to.*hashed the wrong value/s)
    expect(currentSchemaVersion(db)).toBe(23)
    expect(db.prepare('SELECT node_id, fingerprint, dedup_class FROM nodes ORDER BY node_id').all())
      .toEqual(before)
    db.close()
  })

  it('the self-check throws when an anchor is left on a key its node does not carry (M4)', () => {
    // The invariant the anchor rewrite exists to restore, pinned directly.
    // The old arithmetic check (after === before - dropped - collapsed)
    // reduced to a tautology and could never fire; this poisons a
    // SURVIVING anchor's key so it no longer matches its node, exactly the
    // stale-key state that makes liveAnchor blind and every in-window
    // duplicate re-insert.
    const auto = 'Tool: Bash — a captured tool call whose output is long enough to matter'
    const meta = { source: 'auto-capture', session_id: 'sess-A' }
    const db = seedV23('poisoned-anchor.db', [
      { id: 'live-auto', content: auto, sourceLabel: 'auto-capture', metadata: meta, createdAt: 500 },
    ])
    const before = db.prepare('SELECT node_id, fingerprint FROM nodes ORDER BY node_id').all()

    // Fires after the anchor rebuild, before the self-check: move the
    // surviving anchor onto a key its node does not have.
    __setDigestPoisonHookForTests((poisoned) => {
      poisoned.prepare(
        "UPDATE dedup_anchors SET fingerprint = 'deadbeefdeadbeefdeadbeefdeadbeef' WHERE node_id = 'live-auto'",
      ).run()
    })
    expect(() => runMigrations(db, { migrate: true }))
      .toThrow(/self-check failed.*dedup anchor\(s\) carry a key their node does not/s)

    // Rolled back: still v23, values untouched, and the anchor is back on
    // its node's key.
    expect(currentSchemaVersion(db)).toBe(23)
    expect(db.prepare('SELECT node_id, fingerprint FROM nodes ORDER BY node_id').all()).toEqual(before)
    const after = anchors(db)
    expect(after).toHaveLength(1)
    expect(after[0]!.fingerprint).toBe(contentFingerprintV1(auto))
    db.close()
  })

  it('a v20 store climbs 021 through 024 in one batch and ends correct', () => {
    // The sub-v23 path: 023's whole-store pass AND 024's, under one
    // exclusive lock (§11b's accepted cost). The end state is what
    // matters — no V1 key survives anywhere.
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'ladder.db')))
    climbTo(db, 20)
    db.prepare('INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, 0)')
      .run('project')
    const long = 'compressed history '.repeat(40)
    const meta = { source: 'auto-capture', session_id: 'sess-L' }
    insertRaw(db, { id: 'a', content: COLLIDING_A, createdAt: 100 })
    insertRaw(db, { id: 'b', content: COLLIDING_B, createdAt: 200 })
    insertRaw(db, { id: 'zstd', content: encodeContent(long), createdAt: 300 })
    insertRaw(db, { id: 'auto', content: 'Tool: Bash…', sourceLabel: 'auto-capture', metadata: meta, createdAt: 400 })
    insertRaw(db, { id: 'torn', content: Buffer.from([0xee, 9, 9]), createdAt: 500 })

    const report = runMigrations(db, { migrate: true })

    expect(report.applied.map((a) => a.version)).toEqual([21, 22, 23, 24, 25, 26, 27])
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)
    expect(nodeRow(db, 'a').fingerprint).toBe(contentFingerprint(COLLIDING_A))
    expect(nodeRow(db, 'b').fingerprint).toBe(contentFingerprint(COLLIDING_B))
    expect(nodeRow(db, 'zstd').fingerprint).toBe(contentFingerprint(long))
    expect(nodeRow(db, 'a').dedup_class).toBe('curated')
    expect(nodeRow(db, 'b').dedup_class).toBe('curated')
    // The undecodable row keeps what it has (NULL below v23) — the ⟺
    // invariant is scoped to rows carrying a 32-hex key.
    expect(nodeRow(db, 'torn').fingerprint).toBeNull()
    // Every non-NULL key is the digest form; no V1 key survives.
    const keys = db.prepare('SELECT fingerprint AS fp FROM nodes WHERE fingerprint IS NOT NULL')
      .all() as Array<{ fp: string }>
    expect(keys).toHaveLength(4)
    for (const k of keys) expect(k.fp).toMatch(/^[0-9a-f]{32}$/)
    // The anchor 023 seeded on a V1 key came out the far side re-keyed.
    const after = anchors(db)
    expect(after).toHaveLength(1)
    expect(after[0]!.fingerprint).toBe(nodeRow(db, 'auto').fingerprint)
    db.close()
  })
})
