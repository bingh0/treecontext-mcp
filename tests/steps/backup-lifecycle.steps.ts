/**
 * backup-lifecycle.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Migration-backup lifecycle — verdict at completion, rm/prune spare
 * rules.
 *
 * The migration scenarios run in-worker: runMigrations and
 * recordCompletionVerdict operate on explicit paths and handles, and old
 * stores are built by replaying the real migration bodies up to the
 * target version (the journal-storage fixture's recipe) — a snapshot
 * drifts from the migrations it stands in for, and this feature is about
 * what a real ladder run records.
 *
 * The rm/prune scenarios spawn the REAL stores CLI: DEFAULT_STORES_DIR
 * freezes from homedir() at import of src/tools/stores.ts, which in the
 * shared vitest worker has already happened with the real home — the
 * old binding's module-load redirect is impossible here, and the spawn
 * (stores-list/stores-merge precedent) is what makes the command read
 * the sandbox. The child's exit status replaces the old in-process
 * exit-channel normalization outright: both channels were "one truth to
 * the shell", and the spawned process reports exactly that truth.
 * Doctor assertions go through helpers/doctor-backup-child.ts for the
 * same freeze in reverse (LOGS_DIR, src/debug.ts).
 *
 * Assertion-inert renames, disclosed: the two migration scenarios and
 * their doctor needles share the store name "notes" (the old binding
 * used "retry" for the second — isolation now comes from per-scenario
 * homes, not names); the stray autostore uses one hash suffix across
 * its three scenarios for the same reason. "The backup file still
 * exists in the store's directory" merges the outline's readdir probe
 * over its second user (prune-spare), a strengthening.
 */
import { mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import BetterSqlite3 from 'better-sqlite3'

import { spawnCli, spawnNodeTs } from '../helpers/cli-spawn.js'
import { countNodesIn as countNodes, freshHomeDir, storesDirIn } from '../helpers/store-fixtures.js'
import { runMigrations, recordCompletionVerdict } from '../../src/persistence/migrations.js'
import { migrations, maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { writeVerdict, verdictPathFor, readVerdict } from '../../src/persistence/backup-verdict.js'
import { SCHEMA_SQL } from '../../src/persistence/schema.js'

const DOCTOR_CHILD_TS = fileURLToPath(new URL('../helpers/doctor-backup-child.ts', import.meta.url))

const OLD_VERSION = 12

type Row = { check: string; status: string; detail: string; fix?: string }

interface CliRun {
  status: number | null
  lines: string[]
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  fakeHome?: string
  dbPath?: string
  bakPath?: string
  storeDir?: string
  staleBytes?: Buffer
  warnings?: string[]
  run?: CliRun
  orphanBak?: string
  rollbackBak?: string
  strayName?: string
}

export const backupLifecycleDefiner = (reg: Registry<World>): void => {
  function freshHome(w: World): void {
    w.fakeHome = freshHomeDir(w, 'tc-backup-lifecycle-')
  }

  function storesDir(w: World): string {
    return storesDirIn(w.fakeHome!)
  }

  /** A store a v-OLD_VERSION binary would have left: real ladder replay + rows. */
  function seedOldStore(w: World, name: string, entries: number): string {
    const dir = join(storesDir(w), name)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'treecontext.db')
    const raw = new BetterSqlite3(dbPath)
    const db = wrapBetterSqlite(raw)
    for (const m of migrations.filter((x) => x.version <= OLD_VERSION)) m.up(db)
    raw.pragma(`user_version = ${OLD_VERSION}`)
    const treeId = Number(
      raw.prepare('INSERT INTO trees (namespace, ensemble_index, created_at) VALUES (?, ?, ?)')
        .run('project', 0, 0).lastInsertRowid,
    )
    const ins = raw.prepare(
      'INSERT INTO nodes (node_id, tree_id, content, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    )
    for (let i = 0; i < entries; i++) ins.run(`n-${i}`, treeId, `entry ${i} written before the migration`)
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    w.storeDir = dir
    return dbPath
  }

  /** A store already at the current schema (rm/prune scenarios). */
  function seedCurrentStore(w: World, name: string): string {
    const dir = join(storesDir(w), name)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'treecontext.db')
    const raw = new BetterSqlite3(dbPath)
    raw.exec(SCHEMA_SQL)
    raw.pragma(`user_version = ${maxSupportedVersion}`)
    raw.close()
    w.storeDir = dir
    return dbPath
  }

  /** Fabricate a pre-migration backup beside `dbPath`, with optional verdict. */
  function seedBackup(dbPath: string, verdict: 'success' | 'failed' | 'missing', version = OLD_VERSION): string {
    const bakPath = `${dbPath}.pre-migration-v${version}.bak`
    copyFileSync(dbPath, bakPath)
    if (verdict !== 'missing') {
      writeVerdict(bakPath, {
        version: 1, verdict, backupEntries: 36, migratedEntries: verdict === 'success' ? 36 : 35,
        from: version, to: maxSupportedVersion, recordedAt: 0,
      })
    }
    return bakPath
  }

  function runStores(w: World, args: string[]): void {
    const r = spawnCli(['stores', ...args], { home: w.fakeHome! })
    w.run = { status: r.status, lines: r.out.split('\n') }
  }

  function doctorBackupRows(w: World): Row[] {
    const r = spawnNodeTs(DOCTOR_CHILD_TS, [], { home: w.fakeHome! })
    expect(r.status, `doctor child failed: ${r.stderr}`).toBe(0)
    return (JSON.parse(r.stdout) as Row[]).filter((row) => row.check === 'Migration backups')
  }

  // ── migration scenarios ────────────────────────────────────────────

  reg.define(/^a store at schema version 12 holding 36 entries$/, (w) => {
    freshHome(w)
    w.dbPath = seedOldStore(w, 'notes', 36)
  })

  reg.define(/^a pre-migration backup from an earlier unfinished attempt already sits beside it$/, (w) => {
    // The stale copy holds FEWER rows than the store migrating today —
    // exactly the shape that made the pre-fix code record a false
    // 'failed' verdict and advise restoring the stale file.
    w.bakPath = `${w.dbPath!}.pre-migration-v${OLD_VERSION}.bak`
    copyFileSync(w.dbPath!, w.bakPath)
    const stale = new BetterSqlite3(w.bakPath)
    stale.prepare("DELETE FROM nodes WHERE node_id IN ('n-0', 'n-1', 'n-2')").run()
    stale.pragma('wal_checkpoint(TRUNCATE)')
    stale.close()
    expect(countNodes(w.bakPath)).toBe(33)
    w.staleBytes = readFileSync(w.bakPath)
  })

  // Merged over world state: the retry scenario's Given staged the stale
  // backup (staleBytes), and its half asserts the kept path and the
  // withheld verdict; the plain half learns its backup path here.
  reg.define(/^the store is opened and migrates to the current schema version$/, (w) => {
    const raw = new BetterSqlite3(w.dbPath!)
    const report = runMigrations(wrapBetterSqlite(raw), {})
    raw.close()
    expect(report.to).toBe(maxSupportedVersion)
    if (w.staleBytes) {
      expect(report.backupPath).toBe(w.bakPath)
      expect(report.verdict).toBeUndefined()
    } else {
      expect(report.backupPath).toBeDefined()
      w.bakPath = report.backupPath!
    }
  })

  reg.define(/^a pre-migration backup from schema version 12 exists beside the store$/, (w) => {
    expect(basename(w.bakPath!)).toBe(`treecontext.db.pre-migration-v${OLD_VERSION}.bak`)
    expect(existsSync(w.bakPath!)).toBe(true)
  })

  reg.define(/^the migrated store still holds all 36 entries$/, (w) => {
    expect(countNodes(w.dbPath!)).toBe(36)
  })

  reg.define(/^a success verdict is recorded for that backup$/, (w) => {
    const record = readVerdict(w.bakPath!)
    expect(record?.verdict).toBe('success')
    expect(record?.backupEntries).toBe(36)
    expect(record?.migratedEntries).toBe(36)
  })

  reg.define(/^doctor lists that backup with a success verdict$/, (w) => {
    const rows = doctorBackupRows(w)
    const row = rows.find((r) => r.detail.includes('notes') && r.detail.includes(basename(w.bakPath!)))
    expect(row, 'doctor must list the backup').toBeDefined()
    expect(row!.detail).toContain('verdict: success')
  })

  reg.define(/^the earlier backup file is kept byte-for-byte$/, (w) => {
    expect(readFileSync(w.bakPath!).equals(w.staleBytes!)).toBe(true)
  })

  reg.define(/^no verdict is recorded for that backup$/, (w) => {
    expect(readVerdict(w.bakPath!)).toBeNull()
    expect(existsSync(verdictPathFor(w.bakPath!))).toBe(false)
  })

  reg.define(/^doctor lists that backup labeled "no migration verdict"$/, (w) => {
    const rows = doctorBackupRows(w)
    const row = rows.find((r) => r.detail.includes('notes:') && r.detail.includes(basename(w.bakPath!)))
    expect(row, 'doctor must list the kept backup').toBeDefined()
    expect(row!.detail).toContain('no migration verdict')
  })

  reg.define(/^a destructive migration finished with the migrated store holding 35 of the backup's 36 entries$/, (w) => {
    freshHome(w)
    w.dbPath = seedOldStore(w, 'lectures', 36)
    const raw = new BetterSqlite3(w.dbPath)
    runMigrations(wrapBetterSqlite(raw), {})
    raw.close()
    w.bakPath = `${w.dbPath}.pre-migration-v${OLD_VERSION}.bak`
    // Un-run the comparison and lose one entry: the state this scenario
    // is Given is "migration finished, comparison pending, one row gone".
    rmSync(verdictPathFor(w.bakPath), { force: true })
    const doctored = new BetterSqlite3(w.dbPath)
    doctored.prepare("DELETE FROM nodes WHERE node_id = 'n-0'").run()
    doctored.close()
    expect(countNodes(w.dbPath)).toBe(35)
    expect(countNodes(w.bakPath)).toBe(36)
  })

  reg.define(/^the completion comparison runs$/, (w) => {
    w.warnings = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { w.warnings!.push(a.join(' ')) })
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      const verdict = recordCompletionVerdict(wrapBetterSqlite(raw), w.bakPath!, OLD_VERSION)
      expect(verdict).toBe('failed')
    } finally {
      raw.close()
      errSpy.mockRestore()
    }
  })

  reg.define(/^a failed verdict is recorded for that backup$/, (w) => {
    const record = readVerdict(w.bakPath!)
    expect(record?.verdict).toBe('failed')
    expect(record?.backupEntries).toBe(36)
    expect(record?.migratedEntries).toBe(35)
  })

  reg.define(/^a warning at migration time names the backup file as the intact pre-migration copy$/, (w) => {
    const warning = w.warnings!.find((x) => x.includes('MIGRATION VERIFICATION FAILED'))
    expect(warning, 'the failure must be loud at migration time, not only in doctor').toBeDefined()
    expect(warning!).toContain(basename(w.bakPath!))
    expect(warning!).toContain('intact')
    expect(warning!).toContain('restore')
  })

  reg.define(/^the store still opens and serves$/, (w) => {
    expect(countNodes(w.dbPath!)).toBe(35)
    const raw = new BetterSqlite3(w.dbPath!)
    const report = runMigrations(wrapBetterSqlite(raw), {})
    raw.close()
    expect(report.applied).toEqual([])
  })

  reg.define(/^doctor lists that backup with a failed verdict$/, (w) => {
    const rows = doctorBackupRows(w)
    const row = rows.find((r) => r.detail.includes('lectures') && r.detail.includes('verdict: failed'))
    expect(row).toBeDefined()
    expect(row!.status).toBe('warn')
  })

  reg.define(/^the doctor listing for that backup states the one action that restores it by hand$/, (w) => {
    const rows = doctorBackupRows(w)
    const row = rows.find((r) => r.detail.includes('lectures') && r.detail.includes('verdict: failed'))
    // The action lives in the fix channel (E chunk 3); it must still
    // name the exact file so "by hand" is one copy away.
    expect(row!.fix).toMatch(/restore it by hand/i)
    expect(row!.fix).toContain(basename(w.bakPath!))
  })

  // ── stores rm ──────────────────────────────────────────────────────

  reg.define(/^store "notes" has a pre-migration backup with a recorded success verdict$/, (w) => {
    freshHome(w)
    w.dbPath = seedCurrentStore(w, 'notes')
    w.bakPath = seedBackup(w.dbPath, 'success')
  })

  reg.define(/^store "notes" has a pre-migration backup whose verdict is (failed|missing)$/, (w, state) => {
    freshHome(w)
    w.dbPath = seedCurrentStore(w, 'notes')
    w.bakPath = seedBackup(w.dbPath, state as 'failed' | 'missing')
  })

  reg.define(/^store "notes" is a shell directory holding only a spared pre-migration backup with a failed verdict$/, (w) => {
    freshHome(w)
    const dbPath = seedCurrentStore(w, 'notes')
    w.bakPath = seedBackup(dbPath, 'failed')
    rmSync(dbPath)
  })

  reg.define(/^store "notes" is a shell directory holding only a pre-migration backup with a recorded success verdict$/, (w) => {
    freshHome(w)
    const dbPath = seedCurrentStore(w, 'notes')
    w.bakPath = seedBackup(dbPath, 'success')
    rmSync(dbPath)
  })

  reg.define(/^store "notes" is a shell directory holding a pre-migration backup with a recorded success verdict and another whose verdict is failed$/, (w) => {
    freshHome(w)
    const dbPath = seedCurrentStore(w, 'notes')
    w.orphanBak = seedBackup(dbPath, 'success', 12)
    w.rollbackBak = seedBackup(dbPath, 'failed', 17)
    rmSync(dbPath)
  })

  reg.define(/^the user runs stores rm for "notes" without --yes$/, (w) => {
    runStores(w, ['rm', 'notes'])
  })

  reg.define(/^the user runs stores rm for "notes" with --yes$/, (w) => {
    runStores(w, ['rm', 'notes', '--yes'])
  })

  reg.define(/^the output names both the store and its backup as what would be removed$/, (w) => {
    const line = w.run!.lines.find((l) => l.includes('Would remove'))
    expect(line).toBeDefined()
    expect(line!).toContain(join(storesDir(w), 'notes'))
    expect(line!).toContain(basename(w.bakPath!))
  })

  reg.define(/^both files still exist$/, (w) => {
    expect(existsSync(w.dbPath!)).toBe(true)
    expect(existsSync(w.bakPath!)).toBe(true)
  })

  // Merged over world state: rm's target directory and prune's stray
  // both land in storeDir.
  reg.define(/^the store no longer exists$/, (w) => {
    expect(existsSync(w.storeDir!)).toBe(false)
  })

  reg.define(/^the backup file no longer exists$/, (w) => {
    expect(existsSync(w.bakPath!)).toBe(false)
  })

  reg.define(/^the store's database no longer exists$/, (w) => {
    expect(existsSync(w.dbPath!)).toBe(false)
  })

  reg.define(/^the backup file still exists in the store's directory$/, (w) => {
    expect(existsSync(w.bakPath!)).toBe(true)
    expect(readdirSync(dirname(w.bakPath!))).toContain(basename(w.bakPath!))
  })

  // One definition serves the outline's two rows and the prune-spare
  // scenario, whose expanded sentence is the outline's failed row.
  reg.define(/^the output says the backup was left behind because its verdict is (failed|missing)$/, (w, state) => {
    const line = w.run!.lines.find((l) => l.includes('left behind'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.bakPath!))
    expect(line!).toContain(state)
  })

  reg.define(/^the exit status indicates success$/, (w) => {
    // The ruled asymmetry's action half: the database was removed and
    // the fence spared the rest — a completed removal, not a failure.
    expect(w.run!.status).toBe(0)
  })

  reg.define(/^the backup file still exists$/, (w) => {
    expect(existsSync(w.bakPath!)).toBe(true)
  })

  reg.define(/^the output says only a spared backup remains and that it is removed by hand$/, (w) => {
    const line = w.run!.lines.find((l) => l.includes('Only a spared backup remains'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.bakPath!))
    expect(line!).toContain('by hand')
  })

  reg.define(/^the exit status indicates refusal$/, (w) => {
    // The ruled asymmetry's refusal half: rm removed nothing and could
    // remove nothing — the fence held the only thing there was.
    expect(w.run!.status).toBe(1)
  })

  reg.define(/^the output names both the shell directory and its orphaned verified backup as what would be removed$/, (w) => {
    // The --yes act deletes the whole directory (telemetry files and
    // all) — a preview naming only the backup undersells the deletion.
    const line = w.run!.lines.find((l) => l.includes('Would remove'))
    expect(line).toBeDefined()
    expect(line!).toContain(join(storesDir(w), 'notes'))
    expect(line!).toContain('orphaned verified backup')
    expect(line!).toContain(basename(w.bakPath!))
  })

  reg.define(/^the store directory no longer exists$/, (w) => {
    expect(existsSync(join(storesDir(w), 'notes'))).toBe(false)
    expect(existsSync(w.bakPath!)).toBe(false)
  })

  reg.define(/^the output says it removed an orphaned verified backup$/, (w) => {
    const line = w.run!.lines.find((l) => l.includes('Removed orphaned verified backup'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.bakPath!))
  })

  reg.define(/^the verified backup no longer exists$/, (w) => {
    expect(existsSync(w.orphanBak!)).toBe(false)
    expect(w.run!.lines.some((l) => l.includes('Removed orphaned verified backup') && l.includes(basename(w.orphanBak!)))).toBe(true)
  })

  reg.define(/^the failed-verdict backup still exists in the store's directory$/, (w) => {
    expect(existsSync(w.rollbackBak!)).toBe(true)
    expect(readdirSync(join(storesDir(w), 'notes'))).toContain(basename(w.rollbackBak!))
  })

  reg.define(/^the output says the directory survives as a shell$/, (w) => {
    expect(w.run!.lines.some((l) => l.includes('survives as a shell'))).toBe(true)
  })

  // ── stores prune ───────────────────────────────────────────────────

  reg.define(/^a stray autostore whose live store holds zero entries$/, (w) => {
    freshHome(w)
    w.strayName = `${basename(w.fakeHome!)}-aaa000`
    w.dbPath = seedCurrentStore(w, w.strayName)
  })

  reg.define(/^that store has a pre-migration backup whose recorded verdict is failure$/, (w) => {
    w.bakPath = seedBackup(w.dbPath!, 'failed')
  })

  reg.define(/^that store has a pre-migration backup with a recorded success verdict$/, (w) => {
    w.bakPath = seedBackup(w.dbPath!, 'success')
  })

  reg.define(/^the user runs stores prune without --yes$/, (w) => {
    runStores(w, ['prune'])
  })

  reg.define(/^the user runs stores prune with --yes$/, (w) => {
    runStores(w, ['prune', '--yes'])
  })

  reg.define(/^the stray is listed with its size as what would be removed$/, (w) => {
    expect(w.run!.lines.some((l) => l.includes('would be removed'))).toBe(true)
    const line = w.run!.lines.find((l) => l.includes(w.strayName!))
    expect(line).toBeDefined()
    // The size figure proves the preview enumerated THIS store, not just
    // counted it: formatBytes of whatever the directory actually holds.
    expect(line!).toMatch(/\(\d+(\.\d+)?[BKMG]\)/)
  })

  reg.define(/^the preview says the backup would be left behind as a live rollback$/, (w) => {
    const line = w.run!.lines.find((l) => l.includes('would leave') && l.includes(basename(w.bakPath!)))
    expect(line).toBeDefined()
    expect(line!).toContain('a live rollback')
  })

  reg.define(/^the store and its backup still exist$/, (w) => {
    expect(existsSync(w.dbPath!)).toBe(true)
    expect(existsSync(w.bakPath!)).toBe(true)
  })

  reg.define(/^the output says to re-run with --yes to actually delete$/, (w) => {
    expect(w.run!.lines.some((l) => l.includes('Re-run with --yes'))).toBe(true)
  })
}
