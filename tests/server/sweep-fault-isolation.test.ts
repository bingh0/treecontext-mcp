/**
 * Review finding #3: the sweep's delete loop is per-item fault-isolated.
 * One unremovable backup (EACCES and kin) must not abort the run — before
 * the fix, the first throw escaped the loop, losing the report and
 * stranding every eligible backup after it with no exit status to say so.
 * Failures land in SweepResult.failed; the CLI reports each and exits 2.
 *
 * Not a feature scenario: the contract says what a sweep refuses and
 * deletes, not how it survives a hostile filesystem — this is
 * implementation robustness, pinned at the seam.
 *
 * POSIX-only: the failure is provoked with a read-only parent directory
 * (unlink needs write permission on the directory), which chmod cannot
 * arrange on Windows ACLs — and root bypasses it, hence the uid guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, chmodSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { sweepMigrationBackups } from '../../src/tools/stores.js'
import { writeVerdict } from '../../src/persistence/backup-verdict.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { SCHEMA_SQL } from '../../src/persistence/schema.js'

const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0

let storesDir: string

/** A healthy live store plus an eligible (success-verdict) backup. */
function seedEligible(name: string): string {
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'treecontext.db')
  const db = new BetterSqlite3(dbPath)
  db.exec(SCHEMA_SQL)
  db.pragma(`user_version = ${maxSupportedVersion}`)
  db.close()
  const bakPath = join(dir, 'treecontext.db.pre-migration-v12.bak')
  const bak = new BetterSqlite3(bakPath)
  bak.exec('CREATE TABLE pad (x BLOB)')
  bak.close()
  writeVerdict(bakPath, {
    version: 1, verdict: 'success', backupEntries: 1, migratedEntries: 1,
    from: 12, to: maxSupportedVersion, recordedAt: 0,
  })
  return bakPath
}

beforeEach(() => {
  storesDir = mkdtempSync(join(tmpdir(), 'tc-sweep-fault-'))
})

afterEach(() => {
  // Restore write permission before cleanup or rmSync fails the same way.
  for (const name of ['aa-unremovable', 'zz-removable']) {
    try { chmodSync(join(storesDir, name), 0o755) } catch { /* absent */ }
  }
  rmSync(storesDir, { recursive: true, force: true })
})

describe.skipIf(!posixNonRoot)('sweep delete-loop fault isolation', () => {
  it('records a failed deletion and continues to the items after it', () => {
    // Sorted order puts the unremovable store FIRST, so a green result
    // proves the loop continued past the failure, not that it never hit it.
    const stuckBak = seedEligible('aa-unremovable')
    const freeBak = seedEligible('zz-removable')
    const freeSize = statSync(freeBak).size
    chmodSync(join(storesDir, 'aa-unremovable'), 0o555)

    const result = sweepMigrationBackups(storesDir, { dryRun: false })

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.item.backup.path).toBe(stuckBak)
    expect(result.failed[0]!.error).toMatch(/EACCES|permission/i)
    expect(existsSync(stuckBak)).toBe(true)

    expect(result.deleted).toHaveLength(1)
    expect(result.deleted[0]!.backup.path).toBe(freeBak)
    expect(existsSync(freeBak)).toBe(false)

    // The failed item's bytes are not counted as freed.
    expect(result.freedBytes).toBe(freeSize)
  })
})
