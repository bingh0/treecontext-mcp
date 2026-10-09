/**
 * Shared store/backup fixtures for the backup-corpus test files —
 * extracted at the fifth-pass review, which found the fourth copy-paste
 * of these helpers drifting independently.
 *
 * Deliberately NOT adopted by backup-visibility.test.ts's junk-byte
 * seedBackup (its backups are unreadable buffers by design) — sharing
 * would blur that fixture's point. Real-SQLite seeders only.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

import { SCHEMA_SQL } from '../../src/persistence/schema.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { writeVerdict } from '../../src/persistence/backup-verdict.js'
import { contentFingerprint, contentFingerprintV1 } from '../../src/fingerprint.js'
import { FINGERPRINT_DIGEST_VERSION } from '../../src/server/store-audit.js'

/** What these fixtures need of a gnt world: somewhere to hang cleanup. */
export interface DeferringWorld {
  defer: (fn: () => void | Promise<void>) => void
}

/**
 * A throwaway home directory, removed when the scenario unwinds.
 *
 * Five definer modules had each grown the same three lines (mkdtemp,
 * defer an rm, stash the path), and a sixth spelled the stores path
 * under it by hand — the shape that drifts one file at a time until a
 * scenario is seeding one directory and reading another.
 */
export function freshHomeDir(w: DeferringWorld, prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  w.defer(() => rmSync(home, { recursive: true, force: true }))
  return home
}

// storesDirIn lives in home.ts (src-free) and is re-exported here so the
// fixtures' callers keep one import site; see the note on it there.
export { storesDirIn } from './home.js'

/** A healthy live store at the current schema; returns the db path. */
export function seedStoreDir(storesDir: string, name: string): string {
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'treecontext.db')
  const db = new BetterSqlite3(dbPath)
  db.exec(SCHEMA_SQL)
  db.pragma(`user_version = ${maxSupportedVersion}`)
  db.close()
  return dbPath
}

/**
 * A valid SQLite file of exactly `kb` KB (targets are page multiples of
 * the 4096-byte default page size). Coarse zeroblob fill, then one-row
 * top-ups to the exact byte.
 */
export function makeSqliteFileOf(path: string, kb: number): void {
  const target = kb * 1024
  const db = new BetterSqlite3(path)
  db.exec('CREATE TABLE pad (x BLOB)')
  const coarse = target - statSync(path).size - 8192
  if (coarse > 0) db.prepare('INSERT INTO pad VALUES (zeroblob(?))').run(coarse)
  while (statSync(path).size < target) db.prepare('INSERT INTO pad VALUES (zeroblob(256))').run()
  db.close()
  expect(statSync(path).size, `fixture must be exactly ${kb} KB`).toBe(target)
}

/** A pre-migration backup that passes quick_check, with optional verdict. */
export function seedBackupFile(
  storesDir: string, store: string, version: number, kb: number,
  verdict: 'success' | 'failed' | 'none',
): string {
  mkdirSync(join(storesDir, store), { recursive: true })
  const bakPath = join(storesDir, store, `treecontext.db.pre-migration-v${version}.bak`)
  makeSqliteFileOf(bakPath, kb)
  if (verdict !== 'none') {
    writeVerdict(bakPath, {
      version: 1, verdict, backupEntries: 36, migratedEntries: verdict === 'success' ? 36 : 35,
      from: version, to: maxSupportedVersion, recordedAt: 0,
    })
  }
  return bakPath
}

/**
 * An orphaned verdict sidecar: the sidecar file alone, its backup never
 * created — writeVerdict targets `<bak>.verdict.json` without touching
 * the backup path, which is exactly the orphan state. Returns the
 * sidecar path. Extracted at the E-corpus review (fifth copy drifting
 * across backup-sweep, backup-visibility, and the journal suite).
 */
export function seedOrphanSidecar(storesDir: string, store: string, version = 12): string {
  mkdirSync(join(storesDir, store), { recursive: true })
  const bakPath = join(storesDir, store, `treecontext.db.pre-migration-v${version}.bak`)
  writeVerdict(bakPath, {
    version: 1, verdict: 'success', backupEntries: 36, migratedEntries: 36,
    from: version, to: maxSupportedVersion, recordedAt: 0,
  })
  return `${bakPath}.verdict.json`
}

// ── Self-audit fixtures (docs/project-identity.md §11a) ───────────────

/**
 * Two texts that genuinely collide under the pre-digest fingerprint —
 * §9.2's measured shape, not a hand-written key.
 *
 * Same head(64), same tail(64), same whitespace-normalized length, a
 * different middle of equal width: the single most common shape in a
 * capture journal, because captured tool calls share a command prefix and
 * a result suffix and differ in a fixed-width identifier. No whitespace
 * anywhere, so normalization is the identity function and the fixture
 * proves what it looks like it proves.
 *
 * Since Phase 3 (§11b) the live `contentFingerprint` is a digest and
 * this pair no longer collides under it — that IS the repair. The pair
 * still collides under `contentFingerprintV1`, the frozen pre-024 key,
 * which is what a store that has not yet climbed 024 carries and what
 * doctor's collision check exists to find. `seedAuditStore({preDigest})`
 * asserts the collision with the REAL V1 function, so the pair cannot
 * rot into a near-miss.
 */
const COLLIDE_HEAD = 'tool:Read /home/dev/project/src/server/installer.ts'.padEnd(64, '.')
const COLLIDE_TAIL = 'exit:0;lines:128;diagnostics:none;truncated:false'.padStart(64, '.')
export const COLLIDING_A = `${COLLIDE_HEAD}bid7uolnu${COLLIDE_TAIL}`
export const COLLIDING_B = `${COLLIDE_HEAD}bl9plkhqf${COLLIDE_TAIL}`

export interface AuditSeedNode {
  content: string
  /** The key the row was filed under; defaults to the real fingerprint. */
  fingerprint?: string | null
  /** Namespace tree, for the (tree_id, fingerprint) grouping scope. */
  treeId?: number
  metadata?: Record<string, unknown>
}

export interface AuditSeed {
  nodes?: AuditSeedNode[]
  /** Dead letters: capture-gap tombstones the ingestion path left. */
  deadLetters?: number
  /** Undrained staging rows, each captured this many seconds ago. */
  stagedAgoSecs?: number[]
  /** Stamp a schema version over the ladder's — the v24 look-ahead. */
  userVersion?: number
  /**
   * Seed a store as it stood BEFORE migration 024: every default key is
   * the frozen `contentFingerprintV1`, and the store is stamped one
   * below `FINGERPRINT_DIGEST_VERSION` (an old-form key on a store
   * claiming v24 would be a contradiction the fixture should not be able
   * to express). This is the shape doctor's collision check is FOR —
   * after 024 the digest cannot file two contents together, so a fixture
   * built with the live function would test the check against a store
   * that structurally cannot collide, and pass by reporting nothing.
   */
  preDigest?: boolean
}

/**
 * A store at the REAL schema head with seeded audit shapes.
 *
 * The ladder is run rather than the baseline stamped: every column these
 * checks read (`fingerprint`, `staging.attempts`) arrived in a migration,
 * so a v5 schema wearing a v23 stamp would make the queries throw and the
 * checks degrade to "?" — passing for the wrong reason.
 */
export function seedAuditStore(storesDir: string, name: string, seed: AuditSeed = {}): string {
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'treecontext.db')
  const raw = new BetterSqlite3(dbPath)
  const report = runMigrations(wrapBetterSqlite(raw), { migrate: true })
  // The ladder from v0 crosses a destructive step and leaves its
  // pre-migration copy beside the store. A fixture must seed only what it
  // claims to seed: left in place, that copy would drive doctor's
  // migration-backup section and name every store in a report the audit
  // scenarios assert is silent about them.
  if (report.backupPath !== undefined) {
    rmSync(report.backupPath, { force: true })
    rmSync(`${report.backupPath}.verdict.json`, { force: true })
  }
  try {
    const trees = new Set<number>()
    const nodes = seed.nodes ?? []
    for (const n of nodes) trees.add(n.treeId ?? 1)
    if (seed.deadLetters) trees.add(1)
    for (const treeId of trees) {
      raw.prepare(
        'INSERT OR IGNORE INTO trees (tree_id, namespace, ensemble_index, created_at)'
        + " VALUES (?, ?, 0, 0)",
      ).run(treeId, treeId === 1 ? 'project' : `ns${treeId}`)
    }
    const insert = raw.prepare(
      'INSERT INTO nodes (node_id, tree_id, depth, is_leaf, content, created_at, updated_at,'
      + ' fingerprint, metadata_json) VALUES (?, ?, 0, 1, ?, 0, 0, ?, ?)',
    )
    const keyOf = seed.preDigest ? contentFingerprintV1 : contentFingerprint
    nodes.forEach((n, i) => {
      const fp = n.fingerprint === undefined ? keyOf(n.content) : n.fingerprint
      insert.run(`${name}-n${i}`, n.treeId ?? 1, n.content, fp,
        n.metadata ? JSON.stringify(n.metadata) : null)
    })
    for (let i = 0; i < (seed.deadLetters ?? 0); i++) {
      insert.run(`${name}-dl${i}`, 1,
        `[capture gap] Staging row ${i} failed ingestion 3 times and was dead-lettered.`,
        null,
        JSON.stringify({ source: 'capture-gap', event: 'ingest_failure', staging_id: i }))
    }
    const stage = raw.prepare(
      'INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)'
      + " VALUES ('s1', 'user', ?, ?, 3, 0, ?)",
    )
    const now = Date.now() / 1000
    for (const ago of seed.stagedAgoSecs ?? []) {
      stage.run('an event that never drained', now - ago, now - ago)
    }
    const version = seed.userVersion ?? (seed.preDigest ? FINGERPRINT_DIGEST_VERSION - 1 : undefined)
    if (version !== undefined) raw.pragma(`user_version = ${version}`)
    // The fixture proves itself: a pair that stopped colliding would make
    // every collision pin pass by reporting nothing.
    // Unconditional on the PAIR (Phase-3 review C2): a caller seeding
    // both texts without preDigest would get digest keys, no collision,
    // and a silently vacuous pin — the exact rot this proof exists for.
    if (nodes.some((n) => n.content === COLLIDING_A) && nodes.some((n) => n.content === COLLIDING_B)) {
      expect(seed.preDigest, 'the colliding pair only means something on a preDigest store').toBe(true)
      expect(contentFingerprintV1(COLLIDING_A), 'the colliding pair must share one pre-024 key')
        .toBe(contentFingerprintV1(COLLIDING_B))
      expect(contentFingerprintV1(COLLIDING_A), 'and it must be the embedded-NUL structural form')
        .toContain('\x00')
      // ...and the repair, pinned at the fixture: under the digest they
      // are two keys, which is why a post-024 store reads zero.
      expect(contentFingerprint(COLLIDING_A), 'the digest must tell the pair apart')
        .not.toBe(contentFingerprint(COLLIDING_B))
    }
  } finally {
    raw.close()
  }
  return dbPath
}

/** Row count of a store's nodes table through a fresh readonly connection. */
export function countNodesIn(dbPath: string): number {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c
  } finally {
    db.close()
  }
}
