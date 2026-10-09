/**
 * Review finding R9 (2026-08-11 pass): the sweep's backup and sidecar
 * deletions get separate trys. When one try covered both, a sidecar-only
 * throw reported "failed to delete" a backup that was already gone, and
 * the stranded .verdict.json was invisible to every surface forever.
 * Now the report is precise (deleted + strandedSidecars, never failed)
 * and the next sweep reclaims the residue as an orphan sidecar.
 *
 * The sidecar-only throw cannot be staged on the real filesystem — any
 * permission state that blocks the sidecar blocks the backup beside it,
 * and a directory-shaped sidecar fails verdict reading and never reaches
 * the delete loop — so rmSync is mocked to fail for sidecar paths only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    rmSync: ((path: Parameters<typeof real.rmSync>[0], opts?: Parameters<typeof real.rmSync>[1]) => {
      if (failSidecarRm && String(path).endsWith('.verdict.json')) {
        throw Object.assign(new Error('EPERM: sidecar pinned (mock)'), { code: 'EPERM' })
      }
      return real.rmSync(path, opts)
    }) as typeof real.rmSync,
  }
})

let failSidecarRm = false

const { sweepMigrationBackups } = await import('../../src/tools/stores.js')
const { writeVerdict } = await import('../../src/persistence/backup-verdict.js')
const { maxSupportedVersion } = await import('../../src/persistence/migrations/index.js')
const { SCHEMA_SQL } = await import('../../src/persistence/schema.js')

let storesDir: string

function seedEligible(name: string): { bakPath: string; sidecarPath: string } {
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const db = new BetterSqlite3(join(dir, 'treecontext.db'))
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
  return { bakPath, sidecarPath: `${bakPath}.verdict.json` }
}

beforeEach(() => {
  storesDir = mkdtempSync(join(tmpdir(), 'tc-sidecar-split-'))
  failSidecarRm = false
})

afterEach(() => {
  failSidecarRm = false
  rmSync(storesDir, { recursive: true, force: true })
})

describe('sweep sidecar split failure (R9)', () => {
  it('labels precisely, and the next sweep self-heals the residue', () => {
    const { bakPath, sidecarPath } = seedEligible('notes')

    failSidecarRm = true
    const first = sweepMigrationBackups(storesDir, { dryRun: false })

    // The backup IS deleted and counted; the item never lands in
    // `failed` (which would claim a file still on disk).
    expect(first.deleted).toHaveLength(1)
    expect(first.failed).toHaveLength(0)
    expect(existsSync(bakPath)).toBe(false)
    expect(first.freedBytes).toBeGreaterThan(0)
    expect(first.strandedSidecars).toHaveLength(1)
    expect(first.strandedSidecars[0]!.error).toMatch(/EPERM/)
    expect(existsSync(sidecarPath)).toBe(true)

    // While the obstruction persists, the orphan-sidecar pass must SAY
    // it failed — a --yes entry with removed:false and no error was the
    // silent-drop defect (third-pass review finding 2).
    const blocked = sweepMigrationBackups(storesDir, { dryRun: false })
    expect(blocked.orphanSidecars).toHaveLength(1)
    expect(blocked.orphanSidecars[0]!.removed).toBe(false)
    expect(blocked.orphanSidecars[0]!.error).toMatch(/EPERM/)

    // Self-heal: the stranded sidecar is now an orphan the next sweep
    // reclaims once the obstruction clears.
    failSidecarRm = false
    const second = sweepMigrationBackups(storesDir, { dryRun: false })
    expect(second.orphanSidecars).toEqual([
      { store: 'notes', fileName: 'treecontext.db.pre-migration-v12.bak.verdict.json', removed: true },
    ])
    expect(existsSync(sidecarPath)).toBe(false)
  })
})
