/**
 * The self-audit queries, pinned against real stores
 * (docs/project-identity.md §11a checks 2-4).
 *
 * The doctor scenarios in store-bindings.feature prove these run over a
 * real bindings file and write nothing. These pin what the queries MEAN,
 * where a spawned CLI would prove less and cost a process per case — and
 * they are the only place the §9.2 measurement gotcha can be pinned at
 * all: the character-length form of the collision query returns a clean
 * zero on a store full of collisions, and a zero is exactly what every
 * other surface would read as health.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import {
  seedAuditStore, COLLIDING_A, COLLIDING_B,
} from '../helpers/store-fixtures.js'
import { contentFingerprint, contentFingerprintV1 } from '../../src/fingerprint.js'
import {
  fingerprintCollisions, captureDebt, boundStores, humanAge, bindingStamp,
  FINGERPRINT_COLLISION_SQL, OLD_FORM_FINGERPRINT_SQL, FINGERPRINT_DIGEST_VERSION,
  type ReadonlyStoreDb,
} from '../../src/server/store-audit.js'
import type { BoundProjects } from '../../src/server/split-candidates.js'

const root = mkdtempSync(join(tmpdir(), 'tc-store-audit-'))
let storesDir: string
let seq = 0

beforeEach(() => {
  storesDir = join(root, `run${seq++}`)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Read-only, fileMustExist — the handle doctor itself opens. */
function open(dbPath: string): BetterSqlite3.Database {
  return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
}

function withStore<T>(dbPath: string, fn: (db: BetterSqlite3.Database) => T): T {
  const db = open(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

describe('fingerprint collisions (§9.2)', () => {
  it('finds a group whose one key covers two genuinely different texts', () => {
    const dbPath = seedAuditStore(storesDir, 'colliding', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_B }],
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toEqual({ groups: 1, rows: 2, unmigrated: null })
  })

  it('THE MEASUREMENT GOTCHA: the character-length form finds nothing at all', () => {
    // §9.2's trap, pinned as the failure it would be. length() on TEXT
    // stops at the embedded NUL, so every structural key measures 64 and
    // the predicate matches zero rows — a store full of collisions
    // reporting a clean bill of health. This is why the CAST is in the
    // constant and not in a reviewer's memory.
    const dbPath = seedAuditStore(storesDir, 'gotcha', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_B }],
    })
    const charForm = FINGERPRINT_COLLISION_SQL
      .replaceAll('length(CAST(fingerprint AS BLOB))', 'length(fingerprint)')
    withStore(dbPath, (db) => {
      expect(db.prepare(charForm).get()).toEqual({ groups_: 0, rows_: 0 })
      // ...while the shipped query sees them.
      expect(db.prepare(FINGERPRINT_COLLISION_SQL).get()).toEqual({ groups_: 1, rows_: 2 })
      // And the reason, stated in the store itself: the key is 133 bytes
      // long and 64 characters long.
      const row = db.prepare(
        'SELECT length(fingerprint) AS chars, length(CAST(fingerprint AS BLOB)) AS bytes FROM nodes LIMIT 1',
      ).get() as { chars: number; bytes: number }
      expect(row.chars).toBe(64)
      expect(row.bytes).toBeGreaterThanOrEqual(131)
    })
  })

  it('does not report the designed dedup shape: one key, one content, many rows', () => {
    // Two rows of IDENTICAL content sharing a fingerprint is what dedup
    // looks like when it is working — outside its window, or across
    // sessions. A check that counted these would call the feature a bug.
    const dbPath = seedAuditStore(storesDir, 'deduped', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_A }, { content: COLLIDING_A }],
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toEqual({ groups: 0, rows: 0, unmigrated: null })
  })

  it('leaves short-form keys alone — there the key IS the content', () => {
    // Under 128 normalized chars the fingerprint is the normalized text
    // itself, so two rows sharing one can only differ in whitespace. That
    // is the normalization working, not a key that cannot tell two texts
    // apart, and the structural-form predicate is what keeps it out.
    const dbPath = seedAuditStore(storesDir, 'short', {
      preDigest: true,
      nodes: [{ content: 'a short note' }, { content: 'a   short\n  note' }],
    })
    expect(contentFingerprintV1('a short note')).toBe(contentFingerprintV1('a   short\n  note'))
    // The designed equivalence outlives the key change: whitespace-only
    // variants share the digest too.
    expect(contentFingerprint('a short note')).toBe(contentFingerprint('a   short\n  note'))
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toEqual({ groups: 0, rows: 0, unmigrated: null })
  })

  it('groups per namespace, because that is the scope of the predicate at risk', () => {
    // curatedHolder is WHERE tree_id = ? AND fingerprint = ?. Two
    // namespaces cannot dedup against each other, so one colliding row in
    // each is not a collision anywhere.
    const split = seedAuditStore(storesDir, 'two-trees', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A, treeId: 1 }, { content: COLLIDING_B, treeId: 2 }],
    })
    expect(withStore(split, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toMatchObject({ groups: 0, rows: 0 })
    // ...and a store carrying the pair in both namespaces has two.
    const both = seedAuditStore(storesDir, 'both-trees', {
      preDigest: true,
      nodes: [
        { content: COLLIDING_A, treeId: 1 }, { content: COLLIDING_B, treeId: 1 },
        { content: COLLIDING_A, treeId: 2 }, { content: COLLIDING_B, treeId: 2 },
      ],
    })
    expect(withStore(both, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toMatchObject({ groups: 2, rows: 4 })
  })

  it('says nothing about a store with no fingerprints at all', () => {
    const dbPath = seedAuditStore(storesDir, 'keyless', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A, fingerprint: null }, { content: COLLIDING_B, fingerprint: null }],
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toEqual({ groups: 0, rows: 0, unmigrated: null })
  })

  it('the structural-form predicate matches exactly the old-form keys', () => {
    const dbPath = seedAuditStore(storesDir, 'forms', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: 'a short note' }, { content: COLLIDING_B }],
    })
    withStore(dbPath, (db) => {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${OLD_FORM_FINGERPRINT_SQL}`)
        .get() as { n: number }
      expect(n.n).toBe(2)
    })
  })
})

describe('pre-digest keys, and the version guard that holds them back', () => {
  it('asks nothing about unmigrated keys below the digest schema', () => {
    // A store that has not climbed 024 carries old-form keys throughout.
    // An "unmigrated key" line there would put a permanent finding on a
    // store for being in its normal state.
    const dbPath = seedAuditStore(storesDir, 'v23', {
      preDigest: true,
      nodes: [{ content: COLLIDING_A }, { content: COLLIDING_B }, { content: 'short' }],
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)).unmigrated)
      .toBeNull()
  })

  it('counts them once the store is at the digest schema, apart from the collisions', () => {
    // The look-ahead, exercised now so 024 lands on a check that is
    // already right: a digest store carrying one rehashed key, one
    // undecodable leftover, and one row with no key at all.
    const dbPath = seedAuditStore(storesDir, 'v24', {
      nodes: [
        { content: 'rehashed', fingerprint: 'a'.repeat(32) },
        // The leftover 024 leaves behind by design: an undecodable row
        // keeps its pre-digest key.
        { content: COLLIDING_A, fingerprint: contentFingerprintV1(COLLIDING_A) },
        { content: 'no key', fingerprint: null },
      ],
      userVersion: FINGERPRINT_DIGEST_VERSION,
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)))
      .toEqual({ groups: 0, rows: 0, unmigrated: 2 })
  })

  it('a 32-character key that is not 32 hex bytes is still unmigrated', () => {
    const dbPath = seedAuditStore(storesDir, 'v24-nothex', {
      nodes: [
        { content: 'uppercase is not the digest form', fingerprint: 'A'.repeat(32) },
        { content: 'good', fingerprint: '0123456789abcdef0123456789abcdef' },
      ],
      userVersion: FINGERPRINT_DIGEST_VERSION,
    })
    expect(withStore(dbPath, (db) => fingerprintCollisions(db as ReadonlyStoreDb)).unmigrated)
      .toBe(1)
  })
})

describe('capture debt', () => {
  it('counts dead letters and the staging that is still owed', () => {
    const dbPath = seedAuditStore(storesDir, 'indebted', {
      deadLetters: 2,
      stagedAgoSecs: [30, 4 * 86400, 3600],
    })
    const debt = withStore(dbPath, (db) => captureDebt(db as ReadonlyStoreDb))
    expect(debt.deadLetters).toBe(2)
    expect(debt.unprocessed).toBe(3)
    // The OLDEST is the one worth saying out loud.
    expect(Date.now() / 1000 - debt.oldestPendingAt!).toBeGreaterThan(3.9 * 86400)
  })

  it('reads a healthy store as no debt rather than as no measurement', () => {
    const dbPath = seedAuditStore(storesDir, 'clear', { nodes: [{ content: 'a note' }] })
    expect(withStore(dbPath, (db) => captureDebt(db as ReadonlyStoreDb)))
      .toEqual({ deadLetters: 0, unprocessed: 0, oldestPendingAt: null })
  })

  it('does not count an ordinary journal entry as a hole', () => {
    // The marker is metadata, never the text: a note ABOUT capture gaps
    // is not a capture gap, and content over the compression threshold is
    // a blob a LIKE scan could not read anyway.
    const dbPath = seedAuditStore(storesDir, 'talkative', {
      nodes: [{ content: '[capture gap] — notes on how dead letters are recorded' }],
    })
    expect(withStore(dbPath, (db) => captureDebt(db as ReadonlyStoreDb)).deadLetters).toBe(0)
  })

  it('M6: a store\'s OWN dead letter stays visible after export→clear→import', () => {
    // The documented restore path round-trips a store's rows through
    // importJson. importJson no longer stamps `_imported_from`, and the
    // audit no longer excludes it — so a dead letter that came back through
    // a restore is STILL this store's hole and doctor must still see it.
    // The old `_imported_from IS NULL` clause hid it forever after a
    // restore, blinding doctor to real gaps.
    const dbPath = seedAuditStore(storesDir, 'restored', {
      nodes: [{
        content: '[capture gap] Staging row failed ingestion 3 times and was dead-lettered.',
        metadata: { source: 'capture-gap', event: 'ingest_failure', _imported_from: 'import-restore' },
      }],
    })
    expect(withStore(dbPath, (db) => captureDebt(db as ReadonlyStoreDb)).deadLetters).toBe(1)
  })

  it('M6: a MERGE-copy of another store\'s gap is still excluded', () => {
    // The one exclusion that IS correct: a merged copy carries
    // `_merge_label`, and that gap belongs to the source store, not this
    // drain. Kept, so the M6 fix does not over-count.
    const dbPath = seedAuditStore(storesDir, 'merged-in', {
      nodes: [{
        content: '[capture gap] a hole copied in from another store during a merge.',
        metadata: { source: 'capture-gap', event: 'ingest_failure', _merge_label: 'store-merge:other' },
      }],
    })
    expect(withStore(dbPath, (db) => captureDebt(db as ReadonlyStoreDb)).deadLetters).toBe(0)
  })
})

describe('bound stores', () => {
  const bound = (...entries: Array<[store: string, updatedAt: number]>): BoundProjects => {
    const projects: BoundProjects = {}
    entries.forEach(([store, updatedAt], i) => {
      projects[`fp${i}`] = { store, updatedAt, source: 'path' as never }
    })
    return projects
  }

  it('names each store once, keeping the NEWEST binding that reaches it', () => {
    // The age feeds an accusation ("bound long ago and still empty"), so
    // the reading that does not accuse wins the tie.
    expect(boundStores(bound(['journal', 1000], ['journal', 5000], ['other', 2000])))
      .toEqual([
        { store: 'journal', updatedAt: 5000, bindings: 2 },
        { store: 'other', updatedAt: 2000, bindings: 1 },
      ])
  })

  it('reads an empty map without inventing a store', () => {
    expect(boundStores({})).toEqual([])
  })

  it('survives a binding with no recorded date', () => {
    const projects = bound(['undated', 0])
    expect(boundStores(projects)).toEqual([{ store: 'undated', updatedAt: 0, bindings: 1 }])
  })
})

describe("saying it in doctor's voice", () => {
  it('speaks in words, not in pane cells', () => {
    expect(humanAge(30_000)).toBe('under an hour')
    expect(humanAge(3600_000)).toBe('1 hour')
    expect(humanAge(5 * 3600_000)).toBe('5 hours')
    expect(humanAge(86400_000)).toBe('1 day')
    expect(humanAge(42 * 86400_000)).toBe('42 days')
  })

  it('clamps a binding stamped in the future rather than reporting a negative age', () => {
    expect(humanAge(-9_000_000)).toBe('under an hour')
  })

  it('admits an unrecorded date instead of dressing it as today', () => {
    // A binding written before updatedAt existed is the OLDEST kind on a
    // machine; defaulting it to now would make it look like the newest,
    // which is exactly backwards for a check about age.
    expect(bindingStamp(0, Date.parse('2026-08-20T00:00:00Z'))).toBe('bound at an unrecorded date')
    expect(bindingStamp(Date.parse('2026-07-09T12:00:00Z'), Date.parse('2026-08-20T12:00:00Z')))
      .toBe('bound 2026-07-09, 42 days ago')
  })
})
