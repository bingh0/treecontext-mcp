/**
 * backup-visibility.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Migration-backup visibility in doctor. Doctor is the single
 * INTERPRETING surface for pre-migration backups; silence when there is
 * nothing to say is part of the contract.
 *
 * Every scenario drives doctor() through a fresh redirected-home
 * process (helpers/doctor-backup-child.ts): doctor reads the stores
 * directory per call, but its debug-log section imports LOGS_DIR which
 * freezes at worker import with the REAL home — the child is what makes
 * the whole report describe the sandbox. Seeding stays parent-side: the
 * local seedStore/seedBackup write real SQLite shapes and verdict
 * sidecars at explicit paths, and seedOrphanSidecar is the path-based
 * store fixture.
 *
 * "The report lists that backup and states its live store is gone"
 * serves three scenarios whose bodies diverge: only the verified-orphan
 * pair adds the 'orphaned verified backup' needle, so the Given sets a
 * flag and the needle it rows on (the store names differ: notes vs
 * "notes copy", and 'notes:' does not match 'notes copy:').
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import { spawnNodeTs } from '../helpers/cli-spawn.js'
import { freshHomeDir, seedOrphanSidecar, storesDirIn } from '../helpers/store-fixtures.js'
import { fileURLToPath } from 'node:url'

import BetterSqlite3 from 'better-sqlite3'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { writeVerdict } from '../../src/persistence/backup-verdict.js'
import { SCHEMA_SQL } from '../../src/persistence/schema.js'
import { formatBytes } from '../../src/tools/stores.js'

const CHILD_TS = fileURLToPath(new URL('../helpers/doctor-backup-child.ts', import.meta.url))

type Row = { check: string; status: string; detail: string; fix?: string }

interface World {
  defer: (fn: () => void | Promise<void>) => void
  fakeHome?: string
  rowNeedle?: string
  orphanVerified?: boolean
  sidecarName?: string
  rows?: Row[]
}

export const backupVisibilityDefiner = (reg: Registry<World>): void => {
  function freshHome(w: World): void {
    w.fakeHome = freshHomeDir(w, 'tc-backup-vis-')
  }

  function storesDir(w: World): string {
    return storesDirIn(w.fakeHome!)
  }

  /** A real store at the current schema version, empty of rows. */
  function seedStore(w: World, name: string): string {
    const dir = join(storesDir(w), name)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'treecontext.db')
    const db = new BetterSqlite3(dbPath)
    db.exec(SCHEMA_SQL)
    db.pragma(`user_version = ${maxSupportedVersion}`)
    db.close()
    return dbPath
  }

  /** A pre-migration backup of exactly `kb` KB with an optional verdict. */
  function seedBackup(w: World, store: string, version: number, kb: number, verdict: 'success' | 'failed' | 'none'): void {
    const bakPath = join(storesDir(w), store, `treecontext.db.pre-migration-v${version}.bak`)
    writeFileSync(bakPath, Buffer.alloc(kb * 1024, 1))
    if (verdict !== 'none') {
      writeVerdict(bakPath, {
        version: 1, verdict, backupEntries: 36, migratedEntries: verdict === 'success' ? 36 : 35,
        from: version, to: maxSupportedVersion, recordedAt: 0,
      })
    }
  }

  function backupRows(rows: Row[]): Row[] {
    return rows.filter((r) => r.check === 'Migration backups')
  }

  reg.define(/^a stores directory holding stores "notes", "lectures", and "scratch"$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    seedStore(w, 'lectures')
    seedStore(w, 'scratch')
  })

  reg.define(/^store "notes" has a pre-migration backup from schema version 12 of 308 KB with a recorded success verdict$/, (w) => {
    seedBackup(w, 'notes', 12, 308, 'success')
  })

  reg.define(/^store "lectures" has a pre-migration backup from schema version 17 of 1200 KB with a recorded success verdict$/, (w) => {
    seedBackup(w, 'lectures', 17, 1200, 'success')
  })

  reg.define(/^store "scratch" has no backup files$/, () => {
    // seeded bare above; nothing to do
  })

  reg.define(/^a stores directory where no store has a pre-migration backup$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
  })

  reg.define(/^store "ml-lecture" has a pre-migration backup from schema version 12 created before verdict recording existed$/, (w) => {
    freshHome(w)
    seedStore(w, 'ml-lecture')
    seedBackup(w, 'ml-lecture', 12, 64, 'none')
  })

  // Merged-world openers: each shell-directory scenario's first step
  // brings its own sandbox; the needle names the store whose row the
  // Thens read ('notes:' never matches 'notes copy:').
  reg.define(/^store "notes" is a shell directory holding only a spared pre-migration backup with a failed verdict$/, (w) => {
    freshHome(w)
    const dbPath = seedStore(w, 'notes')
    seedBackup(w, 'notes', 12, 64, 'failed')
    rmSync(dbPath)
    w.rowNeedle = 'notes:'
    w.orphanVerified = false
  })

  reg.define(/^store "notes" is a shell directory holding only a pre-migration backup with a recorded success verdict$/, (w) => {
    freshHome(w)
    const dbPath = seedStore(w, 'notes')
    seedBackup(w, 'notes', 12, 64, 'success')
    rmSync(dbPath)
    w.rowNeedle = 'notes:'
    w.orphanVerified = true
  })

  reg.define(/^a shell directory named "notes copy" holding only a pre-migration backup with a recorded success verdict$/, (w) => {
    freshHome(w)
    const dbPath = seedStore(w, 'notes copy')
    seedBackup(w, 'notes copy', 12, 64, 'success')
    rmSync(dbPath)
    w.rowNeedle = 'notes copy:'
    w.orphanVerified = true
  })

  reg.define(/^store "notes" has a verdict sidecar file whose backup no longer exists$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    w.sidecarName = basename(seedOrphanSidecar(storesDir(w), 'notes'))
  })

  reg.define(/^store "notes" has a pre-migration backup from schema version 12 created before verdict recording existed$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    seedBackup(w, 'notes', 12, 64, 'none')
  })

  reg.define(/^store "lectures" is a shell directory holding only a spared pre-migration backup with a failed verdict$/, (w) => {
    const dbPath = seedStore(w, 'lectures')
    seedBackup(w, 'lectures', 12, 64, 'failed')
    rmSync(dbPath)
  })

  reg.define(/^store "scratch" has a verdict sidecar file whose backup no longer exists$/, (w) => {
    seedStore(w, 'scratch')
    seedOrphanSidecar(storesDir(w), 'scratch')
  })

  reg.define(/^store "notes" has a hand-made file "treecontext.db.bak" beside its database$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    writeFileSync(join(storesDir(w), 'notes', 'treecontext.db.bak'), Buffer.alloc(1024, 1))
  })

  reg.define(/^store "notes" has a hand-made file "backup-old.bak" beside its database$/, (w) => {
    writeFileSync(join(storesDir(w), 'notes', 'backup-old.bak'), Buffer.alloc(1024, 1))
  })

  reg.define(/^store "notes" has a hand-made file "pre-migration-v12.bak" beside its database$/, (w) => {
    // The bare pattern, database prefix missing — a foreign file (fence).
    writeFileSync(join(storesDir(w), 'notes', 'pre-migration-v12.bak'), Buffer.alloc(1024, 1))
  })

  reg.define(/^no store has a pre-migration backup$/, () => {
    // only the hand-made files exist
  })

  reg.define(/^the user runs doctor$/, (w) => {
    const r = spawnNodeTs(CHILD_TS, [], { home: w.fakeHome! })
    expect(r.status, `doctor child failed: ${r.stderr}`).toBe(0)
    w.rows = JSON.parse(r.stdout) as Row[]
  })

  reg.define(/^the report lists the "notes" backup with its store name, source schema version 12, size 308 KB, and a success verdict$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes('notes:'))
    expect(row).toBeDefined()
    expect(row!.detail).toContain('v12')
    expect(row!.detail).toContain(formatBytes(308 * 1024))
    expect(row!.detail).toContain('verdict: success')
  })

  reg.define(/^the report lists the "lectures" backup with its store name, source schema version 17, size 1200 KB, and a success verdict$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes('lectures:'))
    expect(row).toBeDefined()
    expect(row!.detail).toContain('v17')
    expect(row!.detail).toContain(formatBytes(1200 * 1024))
    expect(row!.detail).toContain('verdict: success')
  })

  reg.define(/^the report states a total of 2 backups occupying 1508 KB$/, (w) => {
    const total = backupRows(w.rows!).find((r) => r.detail.includes('2 backups occupying'))
    expect(total).toBeDefined()
    expect(total!.detail).toContain(formatBytes(1508 * 1024))
  })

  reg.define(/^the backup section ends with a single line naming the exact sweep command to run$/, (w) => {
    const section = backupRows(w.rows!)
    const last = section[section.length - 1]!
    expect(last.detail).toContain('treecontext stores sweep')
    // A single line: no other row in the section carries the pointer.
    expect(section.filter((r) => r.detail.includes('treecontext stores sweep'))).toHaveLength(1)
  })

  // Merged: S2 and S9 share the observable verbatim.
  reg.define(/^the report contains no backup section$/, (w) => {
    expect(backupRows(w.rows!)).toEqual([])
  })

  reg.define(/^the report lists that backup labeled "no migration verdict"$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes('ml-lecture:'))
    expect(row).toBeDefined()
    expect(row!.detail).toContain('no migration verdict')
  })

  reg.define(/^the listing says removing it is a by-hand decision$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes('ml-lecture:'))
    expect(row!.fix).toContain('by-hand decision')
  })

  // Merged over world state: the verified-orphan pair adds the needle;
  // the spared/failed orphan asserts only the gone-store fact.
  reg.define(/^the report lists that backup and states its live store is gone$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.rowNeedle!))
    expect(row).toBeDefined()
    expect(row!.detail).toContain('live store is gone')
    if (w.orphanVerified) {
      expect(row!.detail).toContain('orphaned verified backup')
    }
  })

  reg.define(/^the listing says restoring or deleting it is a by-hand decision$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.rowNeedle!))
    expect(row!.fix).toMatch(/restoring or deleting it is a by-hand decision/i)
  })

  reg.define(/^the listing names the exact stores rm command that reclaims it$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.rowNeedle!))
    expect(row!.fix).toContain('treecontext stores rm notes --yes')
  })

  reg.define(/^the listing says the directory is removed by hand because the CLI cannot address its name$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.rowNeedle!))
    expect(row!.fix).toContain('cannot address')
    expect(row!.fix).toContain('by hand')
    // Never a command line in EITHER channel: it would shell-split into
    // the sibling store's name ('stores rm notes copy' deletes 'notes').
    // step-lint: allow unearned-absence -- guarded: the paired positives above assert 'cannot address' and 'by hand' in fix; a command line would shell-split into the sibling store's name (fence, 2026-08-11)
    expect(`${row!.detail} ${row!.fix}`).not.toContain('stores rm')
  })

  reg.define(/^the report lists the sidecar as an orphaned verdict sidecar$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.sidecarName!))
    expect(row, 'the sidecar must not be invisible residue').toBeDefined()
    expect(row!.detail).toContain('orphaned verdict sidecar')
    expect(row!.status).toBe('warn')
  })

  reg.define(/^the listing names the exact sweep command to run$/, (w) => {
    const row = backupRows(w.rows!).find((r) => r.detail.includes(w.sidecarName!))
    // --yes included: the bare sweep is a dry-run, and the fix channel
    // promises the command that CLEARS the finding (review of E chunk 3).
    expect(row!.fix).toContain('treecontext stores sweep --yes')
  })

  reg.define(/^every backup row that warns carries a fix entry$/, (w) => {
    const warns = backupRows(w.rows!).filter((r) => r.status === 'warn')
    // Three distinct warn shapes staged, three rows required — a fixture
    // regression that dropped a world must not pass by quantifying over
    // fewer rows.
    expect(warns).toHaveLength(3)
    for (const row of warns) {
      expect(row.fix, `backup warn row advises only in detail: ${row.detail}`).toBeTruthy()
    }
  })

  reg.define(/^none of the hand-made files is mentioned anywhere in the report$/, (w) => {
    const handMade = ['treecontext.db.bak', 'backup-old.bak', 'pre-migration-v12.bak']
    for (const row of w.rows!) {
      for (const name of handMade) {
        expect(row.detail, `${row.check} must not mention ${name}`).not.toContain(name)
        expect(row.fix ?? '', `${row.check} fix must not mention ${name}`).not.toContain(name)
      }
    }
  })
}
