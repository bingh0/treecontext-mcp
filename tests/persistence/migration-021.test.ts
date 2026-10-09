import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { runMigrations, type MigrationReport } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { SCHEMA_VERSION } from '../../src/persistence/store.js'
import { contentFingerprint } from '../../src/fingerprint.js'
import { NO_SESSION } from '../../src/dedup-identity.js'
import { encodeContent, __setZstdCapabilityForTests } from '../../src/persistence/content-codec.js'

// design/store-as-arbiter.md §5 + amendment 7: migration 021 is the
// final-shape reshape — additive columns, dedup_anchors + leases, the
// curated partial unique index, and the first backfill that reads every
// row's content. The backfill must classify with the same functions the
// insert path uses, resolve pre-existing curated twins losslessly
// (earliest keeps 'curated', later twins take 'curated_dup', nothing
// deleted), leave metadata_json untouched, and tolerate marker-rollback
// replay without redoing work.
describe('migration 021_store_as_arbiter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-mig21-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function openMigrated(name: string): Database {
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    runMigrations(db, { migrate: true })
    db.prepare(
      'INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, 0)',
    ).run('project')
    return db
  }

  interface RawRow {
    id: string
    content: string | Buffer
    sourceLabel?: string | null
    metadata?: Record<string, unknown> | null
    createdAt: number
  }

  /** Insert a node the way a pre-021 binary left it: content encoded,
   *  metadata as JSON, none of the new columns populated. */
  function insertRaw(db: Database, row: RawRow): void {
    db.prepare(
      `INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at,
                          source_label, metadata_json, fingerprint, dedup_class)
       VALUES (?, 1, ?, '', ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      row.id,
      row.content,
      row.createdAt,
      row.createdAt,
      row.sourceLabel ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    )
  }

  function nodeRow(db: Database, id: string): Record<string, unknown> {
    return db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(id)!
  }

  /**
   * Climb the ladder from v20 — 021, 022 (tombstone), 023's backfill and,
   * since §11b, 024's digest rewrite, all in ONE batch.
   *
   * Two consequences of 024 being destructive that every caller here now
   * lives with:
   *
   *  - the runner mints `<db>.pre-migration-v20.bak` before the batch and
   *    VACUUMs after it, so these fixtures leave a backup beside the
   *    store (the temp dir goes at afterEach);
   *  - a SECOND rerunFrom20 on the same store finds that backup already
   *    there and KEEPS it — the earlier attempt's pre-migration copy is
   *    the good one — which is also why the second run records no
   *    verdict: a kept backup is not the new run's twin.
   *
   * The fingerprint assertions below are unaffected in wording and
   * meaning: 023 writes `contentFingerprintV1`, 024 rewrites it as the
   * digest, and `contentFingerprint` IS the digest, so
   * `expect(row.fingerprint).toBe(contentFingerprint(text))` remains the
   * question "did the ladder file this row under the key the insert path
   * would compute" — asked of the ladder's end state.
   */
  function rerunFrom20(db: Database): MigrationReport {
    db.pragma('user_version', 20)
    return runMigrations(db, { migrate: true })
  }

  it('a fresh store reaches the final shape, and SCHEMA_VERSION is the ladder max', () => {
    const db = openMigrated('fresh.db')
    expect(maxSupportedVersion).toBe(27)
    expect(SCHEMA_VERSION).toBe(maxSupportedVersion)

    for (const table of ['dedup_anchors', 'leases']) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeDefined()
    }
    const curatedIdx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_curated_fp'")
      .get() as { sql: string } | undefined
    expect(curatedIdx).toBeDefined()
    expect(curatedIdx!.sql).toContain("WHERE dedup_class = 'curated'")
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_staging_drain_order'").get(),
    ).toBeDefined()
    // The session index replaces both 014/015 expression indexes (G5) —
    // a missing index only changes query plans, so this is the one
    // assertion standing between windows and full-table scans.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_session_key'").get(),
    ).toBeDefined()
    for (const dead of ['idx_nodes_session_time', 'idx_nodes_session_time_v2']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(dead)).toBeUndefined()
    }

    const nodeCols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of ['fingerprint', 'dedup_class', 'session_key', 'relied_count', 'index_len', 'preview_len']) {
      expect(nodeCols).toContain(col)
    }
    const stagingCols = (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of ['claimed_by', 'claimed_at']) {
      expect(stagingCols).toContain(col)
    }
    db.close()
  })

  it('the v20 climb is one destructive batch: it mints a backup, and a second climb keeps that one', () => {
    // §11b's consequence for this fixture. 021/022/023 were additive, so
    // rerunFrom20 used to copy nothing; 024 is destructive, so the whole
    // 021→024 batch now rides BEGIN EXCLUSIVE behind a VACUUM INTO copy.
    const db = openMigrated('backup-fixture.db')
    insertRaw(db, { id: 'note', content: 'a curated decision', createdAt: 100 })

    const first = rerunFrom20(db)
    expect(first.applied.map((a) => a.version)).toEqual([21, 22, 23, 24, 25, 26, 27])
    expect(first.applied.find((a) => a.version === 24)!.kind).toBe('destructive')
    expect(first.backupPath).toBe(`${join(dir, 'backup-fixture.db')}.pre-migration-v20.bak`)
    expect(existsSync(first.backupPath!)).toBe(true)
    // The backup is this run's twin, so the completion verdict is
    // recorded — and it is COUNT(*)-only, which is why 024 carries its
    // own self-check (§11b, review finding 3).
    expect(first.verdict).toBe('success')

    const second = rerunFrom20(db)
    expect(second.backupPath).toBe(first.backupPath)
    // Kept, not overwritten: the earlier file is the pre-migration state,
    // and judging today's store against it would compare strangers — so
    // no verdict this time.
    expect(second.verdict).toBeUndefined()
    expect(nodeRow(db, 'note').fingerprint).toBe(contentFingerprint('a curated decision'))
    db.close()
  })

  it('the backfill classifies every pre-021 row with the insert path’s own functions', () => {
    const db = openMigrated('backfill.db')
    const longText = 'tool output '.repeat(400) // > codec threshold, > 128 chars
    insertRaw(db, {
      id: 'note',
      content: 'a curated decision',
      metadata: { _cc_session_id: 'sess-A', _relied_count: 3 },
      createdAt: 100,
    })
    insertRaw(db, {
      id: 'auto',
      content: 'Tool: Bash…',
      sourceLabel: 'auto-capture',
      metadata: { source: 'auto-capture', session_id: 'sess-B', _index_len: 8, _preview_len: 4 },
      createdAt: 101,
    })
    insertRaw(db, {
      id: 'legacy',
      content: 'legacy row',
      metadata: { _session_id: 12345, _relied_count: 'many' },
      createdAt: 102,
    })
    insertRaw(db, { id: 'bare', content: 'no metadata at all', metadata: null, createdAt: 103 })
    insertRaw(db, { id: 'zstd', content: encodeContent(longText), createdAt: 104 })
    // Reachable metadata the lift must score exactly as the retention
    // reader does: Number() coercion, not a typeof check.
    insertRaw(db, {
      id: 'coerce',
      content: 'foreign row with a string count',
      metadata: { _cc_session_id: 'sess-C', _relied_count: '7' },
      createdAt: 105,
    })
    // Present-but-invalid boundaries (negative / past content length)
    // normalize to NULL at lift — a column COALESCE must never slice on
    // them. The metadata copies keep the originals.
    insertRaw(db, {
      id: 'bad-bounds',
      content: 'short',
      metadata: { _index_len: -5, _preview_len: 9999 },
      createdAt: 106,
    })
    // An undecodable blob (unknown flag byte) is skipped, not fatal: the
    // ladder must keep moving — an additive batch has no backup to
    // restore, so one torn row must never leave the store unopenable.
    insertRaw(db, { id: 'undecodable', content: Buffer.from([0xee, 1, 2, 3]), createdAt: 107 })

    rerunFrom20(db)

    const note = nodeRow(db, 'note')
    expect(note.fingerprint).toBe(contentFingerprint('a curated decision'))
    expect(note.dedup_class).toBe('curated')
    expect(note.session_key).toBe('sess-A')
    expect(note.relied_count).toBe(3)

    const auto = nodeRow(db, 'auto')
    expect(auto.dedup_class).toBe('auto')
    expect(auto.session_key).toBe('sess-B')
    expect(auto.index_len).toBe(8)
    expect(auto.preview_len).toBe(4)

    const legacy = nodeRow(db, 'legacy')
    // Legacy connection ids go through the same String() coercion as
    // sessionOf; junk _relied_count is guarded to 0, not NaN.
    expect(legacy.session_key).toBe('12345')
    expect(legacy.relied_count).toBe(0)

    const bare = nodeRow(db, 'bare')
    expect(bare.session_key).toBe(NO_SESSION)
    expect(bare.dedup_class).toBe('curated')

    // zstd rows are decoded before fingerprinting — the fingerprint is of
    // the text, never of the compressed bytes.
    const zstd = nodeRow(db, 'zstd')
    expect(zstd.fingerprint).toBe(contentFingerprint(longText))

    const coerce = nodeRow(db, 'coerce')
    expect(coerce.relied_count).toBe(7)

    const bad = nodeRow(db, 'bad-bounds')
    expect(bad.index_len).toBeNull()
    expect(bad.preview_len).toBeNull()
    expect(bad.fingerprint).toBe(contentFingerprint('short'))

    const undecodable = nodeRow(db, 'undecodable')
    // Metadata-only stamp (G5 review): the class, session, and reliance
    // land even when the content cannot be decoded — only fingerprint
    // and the content-length-validated boundaries stay NULL.
    expect(undecodable.fingerprint).toBeNull()
    expect(undecodable.dedup_class).toBe('curated')
    expect(undecodable.session_key).toBe(NO_SESSION)

    // Losslessness: the backfill copies values out; metadata_json itself
    // is byte-identical to what the pre-021 binary wrote.
    expect(JSON.parse(note.metadata_json as string)).toEqual({ _cc_session_id: 'sess-A', _relied_count: 3 })
    db.close()
  })

  it('curated twins resolve losslessly and the unique index then holds', () => {
    const db = openMigrated('twins.db')
    const text = 'the same curated content, inserted twice by racing writers'
    insertRaw(db, { id: 'first', content: text, createdAt: 100 })
    insertRaw(db, { id: 'second', content: text, createdAt: 200 })
    // Same content as auto-capture: classes never cross (JF-11), so it is
    // neither a twin nor demoted.
    insertRaw(db, {
      id: 'auto-same',
      content: text,
      sourceLabel: 'auto-capture',
      metadata: { session_id: 's' },
      createdAt: 150,
    })

    rerunFrom20(db)

    expect(nodeRow(db, 'first').dedup_class).toBe('curated')
    expect(nodeRow(db, 'second').dedup_class).toBe('curated_dup')
    expect(nodeRow(db, 'auto-same').dedup_class).toBe('auto')
    // Nothing deleted: all three rows survive, twins stay queryable.
    expect((db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(3)

    // The constraint is live: a new curated duplicate is refused at the
    // engine, which is what G2's ON CONFLICT DO NOTHING relies on.
    const dup = db
      .prepare(
        `INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at,
                            fingerprint, dedup_class)
         VALUES ('third', 1, ?, '', 300, 300, ?, 'curated')
         ON CONFLICT DO NOTHING`,
      )
      .run(text, contentFingerprint(text))
    expect(dup.changes).toBe(0)
    db.close()
  })

  it('a zstd row on a zstd-less runtime is skipped, then healed when a capable runtime re-runs the pass', () => {
    const db = openMigrated('zstd-less.db')
    const longText = 'compressed history '.repeat(400)
    const encoded = encodeContent(longText)
    expect(Buffer.isBuffer(encoded)).toBe(true)
    expect((encoded as Buffer)[0]).toBe(0x01)
    insertRaw(db, { id: 'frozen', content: encoded, createdAt: 100 })

    // Node 22.0–22.14 shape: the zstd branch refuses, the backfill skips
    // the row, and the ladder still completes — the store stays open.
    __setZstdCapabilityForTests(false)
    try {
      rerunFrom20(db)
    } finally {
      __setZstdCapabilityForTests(null)
    }
    expect(nodeRow(db, 'frozen').fingerprint).toBeNull()
    expect(nodeRow(db, 'frozen').dedup_class).toBe('curated')
    expect(nodeRow(db, 'frozen').session_key).toBe(NO_SESSION)

    // A capable runtime re-running the same pass heals it — the loop 022
    // reuses (amendment 8) targets exactly these NULL rows.
    rerunFrom20(db)
    expect(nodeRow(db, 'frozen').fingerprint).toBe(contentFingerprint(longText))
    expect(nodeRow(db, 'frozen').dedup_class).toBe('curated')
    db.close()
  })

  it('an undecodable AUTO row cannot fail the anchor seed (release-diff review 2026-08-15)', () => {
    // The zstd-less skip above proved the BACKFILL tolerates a frozen
    // row — but its row was curated, so the anchor seed never met one.
    // An AUTO frozen row reaches the seed with fingerprint NULL, and
    // dedup_anchors.fingerprint is NOT NULL: without the subquery's
    // IS NOT NULL guard the whole additive batch rolled back and the
    // store became permanently unopenable (reproduced pre-fix).
    const db = openMigrated('zstd-less-auto.db')
    const longText = 'auto capture history '.repeat(400)
    const encoded = encodeContent(longText)
    expect(Buffer.isBuffer(encoded)).toBe(true)
    const meta = { source: 'auto-capture', session_id: 'sess-Z' }
    insertRaw(db, { id: 'frozen-auto', content: encoded, sourceLabel: 'auto-capture', metadata: meta, createdAt: 100 })
    insertRaw(db, { id: 'healthy-auto', content: 'plain auto row', sourceLabel: 'auto-capture', metadata: meta, createdAt: 200 })

    __setZstdCapabilityForTests(false)
    try {
      rerunFrom20(db)
    } finally {
      __setZstdCapabilityForTests(null)
    }

    // The frozen row is skipped — class stamped, fingerprint NULL — and
    // the healthy sibling still got its anchor.
    expect(nodeRow(db, 'frozen-auto').fingerprint).toBeNull()
    const anchors = db
      .prepare("SELECT node_id FROM dedup_anchors WHERE session_key = 'sess-Z'")
      .all() as Array<{ node_id: string }>
    expect(anchors.map((a) => a.node_id)).toEqual(['healthy-auto'])

    // And the store opens again — the failure mode was every LATER open
    // dying in the same rolled-back batch.
    runMigrations(db, { migrate: true })
    db.close()
  })

  it('seeds the auto-dedup window anchors newest-wins (warm-scan parity)', () => {
    const db = openMigrated('anchors.db')
    const text = 'Tool: Bash double-fire'
    const meta = { source: 'auto-capture', session_id: 'sess-X' }
    insertRaw(db, { id: 'older', content: text, sourceLabel: 'auto-capture', metadata: meta, createdAt: 100 })
    insertRaw(db, { id: 'newer', content: text, sourceLabel: 'auto-capture', metadata: meta, createdAt: 900 })

    rerunFrom20(db)

    // One anchor per (tree, session, fingerprint), pointing at the NEWEST
    // occurrence — the retired warm scan's exact rule. Without seeding, a
    // duplicate arriving inside the window of a pre-migration row would
    // not dedup, and a repeated namespace merge would re-copy every row.
    const anchors = db
      .prepare("SELECT node_id, last_seen FROM dedup_anchors WHERE session_key = 'sess-X'")
      .all() as Array<{ node_id: string; last_seen: number }>
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.node_id).toBe('newer')
    expect(anchors[0]!.last_seen).toBe(900)
    db.close()
  })

  it('marker-rollback replay redoes no work and re-demotes no twins', () => {
    const db = openMigrated('replay.db')
    const text = 'twinned content for the replay check'
    insertRaw(db, { id: 'first', content: text, createdAt: 100 })
    insertRaw(db, { id: 'second', content: text, createdAt: 200 })
    rerunFrom20(db)

    expect(nodeRow(db, 'first').dedup_class).toBe('curated')
    expect(nodeRow(db, 'second').dedup_class).toBe('curated_dup')

    // Replay: fingerprints are non-NULL so the backfill skips every row;
    // the twin group has exactly one 'curated' member so the resolver
    // finds no group; DDL is all IF NOT EXISTS / guarded ALTERs.
    rerunFrom20(db)
    expect(nodeRow(db, 'first').dedup_class).toBe('curated')
    expect(nodeRow(db, 'second').dedup_class).toBe('curated_dup')
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE dedup_class = 'curated'").get() as { n: number }).n,
    ).toBe(1)
    db.close()
  })
})
