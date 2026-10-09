/**
 * backup-sweep.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Migration-backup sweep. Every sweep runs in a fresh redirected-home
 * process (helpers/sweep-child.ts): DEFAULT_STORES_DIR freezes from
 * homedir() at import of src/tools/stores.ts, which in the shared
 * vitest worker has already happened with the real home. The child also
 * carries the deletion-failure worlds — the old binding's
 * vi.mock('node:fs') would leak into every feature sharing the gnt
 * runner, so the one path a scenario names travels as TC_FAIL_RM and
 * fs.rmSync is patched inside the child before the CLI graph loads.
 * The scoped-to-missing-store refusal keeps the real CLI entry spawn:
 * that refusal lives in error() → process.exit, which no runStores call
 * can ride out.
 *
 * Backups are real SQLite files built to exact page-aligned sizes — the
 * sweep's verification opens them (quick_check), so junk bytes would
 * bind every scenario through the "backup unreadable" path instead of
 * the one it names. Junk is used only where unreadable IS the point.
 *
 * The locked-store world genuinely holds the lock from ANOTHER process
 * now: the parent's EXCLUSIVE transaction stays open across the child's
 * whole run. "No store has a pre-migration backup" merges its two roles
 * over world state: scenario-opening (fresh home + bare store) when no
 * sandbox exists yet, a no-op reaffirmation mid-scenario otherwise.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import BetterSqlite3 from 'better-sqlite3'

import { spawnCli, spawnNodeTs } from '../helpers/cli-spawn.js'
import {
  freshHomeDir, seedStoreDir, seedBackupFile, seedOrphanSidecar, storesDirIn,
} from '../helpers/store-fixtures.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { writeVerdict } from '../../src/persistence/backup-verdict.js'
import { formatBytes } from '../../src/tools/stores.js'

const SWEEP_CHILD_TS = fileURLToPath(new URL('../helpers/sweep-child.ts', import.meta.url))
const DOCTOR_CHILD_TS = fileURLToPath(new URL('../helpers/doctor-backup-child.ts', import.meta.url))

type Row = { check: string; status: string; detail: string; fix?: string }

interface World {
  defer: (fn: () => void | Promise<void>) => void
  fakeHome?: string
  notesBak?: string
  lecturesBak?: string
  scratchBak?: string
  bakPath?: string
  sidecarPath?: string
  v12Bak?: string
  v17Bak?: string
  handMade?: string
  barePattern?: string
  failRmPath?: string
  /** Explicitly `| undefined`: the defers clear this field by assignment
   *  once the handle is closed, so a present-but-undefined key is legal. */
  locker?: InstanceType<typeof BetterSqlite3> | undefined
  logs?: string[]
  exitCode?: number
  spawnResult?: { status: number | null; out: string }
}

export const backupSweepDefiner = (reg: Registry<World>): void => {
  function freshHome(w: World): void {
    w.fakeHome = freshHomeDir(w, 'tc-backup-sweep-')
    w.defer(() => { w.locker?.close(); w.locker = undefined })
  }

  function storesDir(w: World): string {
    return storesDirIn(w.fakeHome!)
  }

  /** Thin aliases over the shared fixtures (tests/helpers/store-fixtures). */
  function seedStore(w: World, name: string): string {
    return seedStoreDir(storesDir(w), name)
  }

  function seedBackup(
    w: World, store: string, version: number, kb: number, verdict: 'success' | 'failed' | 'none',
  ): string {
    return seedBackupFile(storesDir(w), store, version, kb, verdict)
  }

  /** An eligible backup: healthy live store + readable backup + success verdict. */
  function seedEligible(w: World, store: string, kb = 64, version = 12): string {
    seedStore(w, store)
    return seedBackup(w, store, version, kb, 'success')
  }

  /**
   * Corrupt the live store so it opens AND its integrity check returns
   * error ROWS rather than throwing: a bogus freelist count in the header
   * (probed — garbage pages after page 1 make the pragma THROW, which is
   * the distinct "cannot be checked" refusal, not this one).
   */
  function corruptLiveStore(w: World, store: string): void {
    const dbPath = join(storesDir(w), store, 'treecontext.db')
    const buf = readFileSync(dbPath)
    buf.writeUInt32BE(9999, 36)
    writeFileSync(dbPath, buf)
  }

  function runSweep(w: World, yes: boolean, store?: string): void {
    const args = [...(yes ? ['--yes'] : []), ...(store ? ['--store', store] : [])]
    const r = spawnNodeTs(SWEEP_CHILD_TS, args, {
      home: w.fakeHome!,
      env: w.failRmPath ? { TC_FAIL_RM: w.failRmPath } : {},
    })
    expect(r.status, `sweep child failed: ${r.stderr}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { logs: string[]; exitCode: number }
    w.logs = parsed.logs
    w.exitCode = parsed.exitCode
  }

  // ── givens ─────────────────────────────────────────────────────────

  reg.define(/^store "notes" has an eligible pre-migration backup of 308 KB$/, (w) => {
    freshHome(w)
    w.notesBak = seedEligible(w, 'notes', 308)
  })

  reg.define(/^store "lectures" has an eligible pre-migration backup of 1200 KB$/, (w) => {
    w.lecturesBak = seedEligible(w, 'lectures', 1200)
  })

  reg.define(/^store "notes" has an eligible pre-migration backup$/, (w) => {
    freshHome(w)
    w.notesBak = seedEligible(w, 'notes')
  })

  reg.define(/^store "lectures" has a pre-migration backup whose live store fails its integrity check$/, (w) => {
    seedStore(w, 'lectures')
    w.lecturesBak = seedBackup(w, 'lectures', 12, 64, 'success')
    corruptLiveStore(w, 'lectures')
  })

  reg.define(/^store "scratch" has a pre-migration backup with no recorded migration verdict$/, (w) => {
    seedStore(w, 'scratch')
    w.scratchBak = seedBackup(w, 'scratch', 12, 64, 'none')
  })

  reg.define(/^store "notes" has a pre-migration backup and (.+)$/, (w, world) => {
    freshHome(w)
    switch (world) {
      case 'the live store file is missing':
        // No verdict: a MISSING live store beside a VERIFIED backup is
        // the distinct orphan refusal (its own scenario below), not
        // this generic row.
        mkdirSync(join(storesDir(w), 'notes'), { recursive: true })
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'none')
        break
      case 'the live store fails its integrity check':
        seedStore(w, 'notes')
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'success')
        corruptLiveStore(w, 'notes')
        break
      case 'the live store is below the current schema version': {
        const dbPath = seedStore(w, 'notes')
        const db = new BetterSqlite3(dbPath)
        db.pragma(`user_version = ${maxSupportedVersion - 1}`)
        db.close()
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'success')
        break
      }
      case 'the backup has no recorded migration verdict':
        seedStore(w, 'notes')
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'none')
        break
      case 'the recorded migration verdict is failure':
        seedStore(w, 'notes')
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'failed')
        break
      case 'the backup file itself cannot be opened': {
        seedStore(w, 'notes')
        w.bakPath = join(storesDir(w), 'notes', 'treecontext.db.pre-migration-v12.bak')
        writeFileSync(w.bakPath, Buffer.alloc(64 * 1024, 0xff))
        writeVerdict(w.bakPath, {
          version: 1, verdict: 'success', backupEntries: 36, migratedEntries: 36,
          from: 12, to: maxSupportedVersion, recordedAt: 0,
        })
        break
      }
      case 'the backup is corrupt in a way that still opens': {
        seedStore(w, 'notes')
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'success')
        // quick_check reports this as error ROWS, not a throw (probed:
        // a bogus freelist count in the header). The pre-fix code
        // discarded the rows and would have DELETED this backup.
        const buf = readFileSync(w.bakPath)
        buf.writeUInt32BE(9999, 36)
        writeFileSync(w.bakPath, buf)
        break
      }
      case 'the live store is locked by another process': {
        const dbPath = seedStore(w, 'notes')
        w.bakPath = seedBackup(w, 'notes', 12, 64, 'success')
        w.locker = new BetterSqlite3(dbPath)
        w.locker.pragma('locking_mode = EXCLUSIVE')
        w.locker.exec('BEGIN EXCLUSIVE')
        break
      }
      default:
        throw new Error(`unmapped world: ${world}`)
    }
  })

  reg.define(/^store "notes" has a pre-migration backup with a recorded success verdict and the live store file is missing$/, (w) => {
    freshHome(w)
    mkdirSync(join(storesDir(w), 'notes'), { recursive: true })
    w.bakPath = seedBackup(w, 'notes', 12, 64, 'success')
  })

  reg.define(/^store "notes" has an eligible pre-migration backup the filesystem will not let the sweep delete$/, (w) => {
    freshHome(w)
    w.notesBak = seedEligible(w, 'notes', 308)
    w.failRmPath = w.notesBak
  })

  reg.define(/^store "scratch" has an eligible pre-migration backup$/, (w) => {
    // Sorted order puts the stuck store FIRST: the green deletion below
    // proves the loop continued past the failure, not that it never hit it.
    w.scratchBak = seedEligible(w, 'scratch')
  })

  reg.define(/^store "notes" has a verdict sidecar file whose backup no longer exists$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    w.sidecarPath = seedOrphanSidecar(storesDir(w), 'notes')
    expect(existsSync(w.sidecarPath)).toBe(true)
  })

  reg.define(/^the filesystem will not let the sweep remove that sidecar$/, (w) => {
    w.failRmPath = w.sidecarPath!
  })

  reg.define(/^store "notes" has an eligible pre-migration backup whose verdict sidecar the filesystem will not let the sweep remove$/, (w) => {
    freshHome(w)
    w.bakPath = seedEligible(w, 'notes')
    w.sidecarPath = `${w.bakPath}.verdict.json`
    w.failRmPath = w.sidecarPath
  })

  reg.define(/^store "notes" has an eligible pre-migration backup from schema version 12$/, (w) => {
    freshHome(w)
    w.v12Bak = seedEligible(w, 'notes', 64, 12)
  })

  reg.define(/^store "notes" has a pre-migration backup from schema version 17 whose recorded verdict is failure$/, (w) => {
    w.v17Bak = seedBackup(w, 'notes', 17, 64, 'failed')
  })

  // Merged over world state: scenario-opening in "nothing to do" (fresh
  // home, one bare store), a no-op reaffirmation after the hand-made
  // seeds (only the hand-made files exist).
  reg.define(/^no store has a pre-migration backup$/, (w) => {
    if (!w.fakeHome) {
      freshHome(w)
      seedStore(w, 'notes')
    }
  })

  reg.define(/^store "notes" has a hand-made file "treecontext\.db\.bak" beside its database$/, (w) => {
    freshHome(w)
    seedStore(w, 'notes')
    w.handMade = join(storesDir(w), 'notes', 'treecontext.db.bak')
    writeFileSync(w.handMade, Buffer.alloc(1024, 1))
  })

  reg.define(/^store "notes" has a hand-made file "pre-migration-v12\.bak" beside its database$/, (w) => {
    w.barePattern = join(storesDir(w), 'notes', 'pre-migration-v12.bak')
    writeFileSync(w.barePattern, Buffer.alloc(1024, 1))
  })

  // ── whens ──────────────────────────────────────────────────────────

  reg.define(/^the user runs the backup sweep command with no flags$/, (w) => {
    runSweep(w, false)
  })

  reg.define(/^the user runs the backup sweep command with --yes$/, (w) => {
    runSweep(w, true)
  })

  reg.define(/^the user runs the backup sweep command scoped to store "lectures" with --yes$/, (w) => {
    runSweep(w, true, 'lectures')
  })

  reg.define(/^the user runs the backup sweep command scoped to store "missing" with --yes$/, (w) => {
    // The refusal lives in the CLI's error() → process.exit path,
    // which no in-process call can ride out: the real CLI is spawned.
    w.spawnResult = spawnCli(['stores', 'sweep', '--store', 'missing', '--yes'], { home: w.fakeHome! })
  })

  // ── thens ──────────────────────────────────────────────────────────

  reg.define(/^each backup is listed on its own line with its store name and size$/, (w) => {
    const notesLine = w.logs!.find((l) => l.includes('notes:') && l.includes(basename(w.notesBak!)))
    const lecturesLine = w.logs!.find((l) => l.includes('lectures:') && l.includes(basename(w.lecturesBak!)))
    expect(notesLine).toBeDefined()
    expect(notesLine!).toContain(formatBytes(308 * 1024))
    expect(lecturesLine).toBeDefined()
    expect(lecturesLine!).toContain(formatBytes(1200 * 1024))
    expect(notesLine).not.toBe(lecturesLine)
  })

  reg.define(/^each backup is marked eligible$/, (w) => {
    for (const store of ['notes:', 'lectures:']) {
      const line = w.logs!.find((l) => l.includes(store))
      expect(line!).toContain('eligible')
      // step-lint: allow unearned-absence -- guarded: the paired positive directly above asserts 'eligible' on the same line object
      expect(line!).not.toContain('refused')
    }
  })

  reg.define(/^the output says to re-run with --yes to delete$/, (w) => {
    expect(w.logs!.some((l) => l.includes('Re-run with --yes to delete'))).toBe(true)
  })

  reg.define(/^both backup files still exist$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(true)
    expect(existsSync(w.lecturesBak!)).toBe(true)
  })

  reg.define(/^the "notes" backup is marked eligible$/, (w) => {
    const line = w.logs!.find((l) => l.includes('notes:'))
    expect(line!).toContain('eligible')
  })

  reg.define(/^the "lectures" backup is marked refused with reason "live store fails integrity check"$/, (w) => {
    const line = w.logs!.find((l) => l.includes('lectures:'))
    expect(line!).toContain('refused')
    expect(line!).toContain('live store fails integrity check')
  })

  reg.define(/^the exit status indicates success$/, (w) => {
    // A bare run decides nothing: even a listed refusal leaves exit 0.
    expect(w.exitCode).toBe(0)
  })

  reg.define(/^both backup files no longer exist$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(false)
    expect(existsSync(w.lecturesBak!)).toBe(false)
  })

  reg.define(/^each deletion is reported on its own line$/, (w) => {
    const notesLine = w.logs!.find((l) => l.startsWith('[treecontext] Deleted notes:'))
    const lecturesLine = w.logs!.find((l) => l.startsWith('[treecontext] Deleted lectures:'))
    expect(notesLine).toBeDefined()
    expect(lecturesLine).toBeDefined()
    expect(notesLine).not.toBe(lecturesLine)
  })

  reg.define(/^the output states 1508 KB freed$/, (w) => {
    const line = w.logs!.find((l) => l.includes('freed'))
    expect(line).toBeDefined()
    expect(line!).toContain(formatBytes(1508 * 1024))
  })

  reg.define(/^a doctor run afterwards contains no backup section$/, (w) => {
    const r = spawnNodeTs(DOCTOR_CHILD_TS, [], { home: w.fakeHome! })
    expect(r.status, `doctor child failed: ${r.stderr}`).toBe(0)
    const rows = (JSON.parse(r.stdout) as Row[]).filter((row) => row.check === 'Migration backups')
    expect(rows).toEqual([])
  })

  reg.define(/^the "lectures" backup no longer exists and its deletion is reported$/, (w) => {
    expect(existsSync(w.lecturesBak!)).toBe(false)
    expect(w.logs!.some((l) => l.includes('Deleted lectures:') && l.includes(basename(w.lecturesBak!)))).toBe(true)
  })

  reg.define(/^the "notes" backup still exists and is not listed$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(true)
    // Out of scope means out of the REPORT too: not judged, not
    // listed, not counted — the strongest form of "untouched".
    expect(w.logs!.some((l) => l.includes('notes:'))).toBe(false)
  })

  reg.define(/^the output states 1200 KB freed$/, (w) => {
    expect(w.logs!.some((l) => l.includes(`${formatBytes(1200 * 1024)} freed`))).toBe(true)
  })

  reg.define(/^the sweep refuses naming "missing"$/, (w) => {
    expect(w.spawnResult!.status).not.toBe(0)
    expect(w.spawnResult!.out).toMatch(/no store named 'missing'/)
  })

  reg.define(/^the "notes" backup still exists$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(true)
  })

  reg.define(/^the backup file still exists$/, (w) => {
    w.locker?.close()
    w.locker = undefined
    expect(existsSync(w.bakPath!)).toBe(true)
  })

  // One definition serves the outline's eight rows and the orphan
  // scenario, whose expanded sentence carries its own reason; only the
  // orphan reason adds the no-fall-through exclusion.
  reg.define(/^the refusal is reported with reason "([^"]+)"$/, (w, reason) => {
    const line = w.logs!.find((l) => l.includes('Refused notes:'))
    expect(line, 'a refusal line must name the backup').toBeDefined()
    expect(line!).toContain(reason)
    if (reason === 'orphaned verified backup') {
      // step-lint: allow unearned-absence -- guarded: the line above asserts 'orphaned verified backup' present; this excludes only falling through to the generic reason
      expect(line!, 'the orphan refusal must not fall through to the generic reason')
        .not.toContain('live store missing')
    }
  })

  reg.define(/^the refusal names stores rm as the reclaim path$/, (w) => {
    const line = w.logs!.find((l) => l.includes('Refused notes:'))
    expect(line!).toContain('stores rm')
  })

  reg.define(/^the "notes" backup no longer exists and its deletion is reported$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(false)
    expect(w.logs!.some((l) => l.includes('Deleted notes:') && l.includes(basename(w.notesBak!)))).toBe(true)
  })

  reg.define(/^the "lectures" backup still exists and its refusal names reason "live store fails integrity check"$/, (w) => {
    expect(existsSync(w.lecturesBak!)).toBe(true)
    const line = w.logs!.find((l) => l.includes('Refused lectures:'))
    expect(line!).toContain('live store fails integrity check')
  })

  reg.define(/^the "scratch" backup still exists and its refusal names reason "no migration verdict"$/, (w) => {
    expect(existsSync(w.scratchBak!)).toBe(true)
    const line = w.logs!.find((l) => l.includes('Refused scratch:'))
    expect(line!).toContain('no migration verdict')
  })

  reg.define(/^the exit status indicates partial completion$/, (w) => {
    expect(w.exitCode).toBe(2)
  })

  reg.define(/^the "scratch" backup no longer exists and its deletion is reported$/, (w) => {
    expect(existsSync(w.scratchBak!)).toBe(false)
    expect(w.logs!.some((l) => l.includes('Deleted scratch:') && l.includes(basename(w.scratchBak!)))).toBe(true)
  })

  reg.define(/^the "notes" backup still exists and its failed deletion is reported$/, (w) => {
    expect(existsSync(w.notesBak!)).toBe(true)
    const line = w.logs!.find((l) => l.includes('Failed to delete notes:'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.notesBak!))
  })

  reg.define(/^the freed total counts only the "scratch" backup's bytes$/, (w) => {
    const line = w.logs!.find((l) => l.includes('freed'))
    expect(line!).toContain(formatBytes(64 * 1024))
  })

  reg.define(/^the sidecar file still exists$/, (w) => {
    expect(existsSync(w.sidecarPath!)).toBe(true)
  })

  reg.define(/^its failed removal is reported$/, (w) => {
    const line = w.logs!.find((l) => l.includes('Failed to remove orphaned verdict sidecar notes:'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.sidecarPath!))
  })

  reg.define(/^the backup file no longer exists and its deletion is reported$/, (w) => {
    expect(existsSync(w.bakPath!)).toBe(false)
    expect(w.logs!.some((l) => l.includes('Deleted notes:') && l.includes(basename(w.bakPath!)))).toBe(true)
  })

  reg.define(/^a note says the stranded sidecar is reclaimed by a later sweep$/, (w) => {
    const line = w.logs!.find((l) => l.includes('Note:') && l.includes(basename(w.bakPath!)))
    expect(line).toBeDefined()
    expect(line!).toContain('a later sweep will reclaim it')
  })

  reg.define(/^the version 12 backup no longer exists and its deletion is reported$/, (w) => {
    expect(existsSync(w.v12Bak!)).toBe(false)
    expect(w.logs!.some((l) => l.includes('Deleted notes:') && l.includes(basename(w.v12Bak!)))).toBe(true)
  })

  reg.define(/^the version 17 backup still exists and its refusal names reason "migration verdict failed"$/, (w) => {
    expect(existsSync(w.v17Bak!)).toBe(true)
    const line = w.logs!.find((l) => l.includes('Refused notes:') && l.includes(basename(w.v17Bak!)))
    expect(line!).toContain('migration verdict failed')
  })

  reg.define(/^the output states that no pre-migration backups were found$/, (w) => {
    expect(w.logs!.some((l) => l.includes('No pre-migration backups found'))).toBe(true)
  })

  reg.define(/^it is reported as an orphaned verdict sidecar$/, (w) => {
    const line = w.logs!.find((l) => l.includes('orphaned verdict sidecar'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.sidecarPath!))
    expect(line!).toContain('would remove')
  })

  reg.define(/^the sidecar file no longer exists$/, (w) => {
    expect(existsSync(w.sidecarPath!)).toBe(false)
  })

  reg.define(/^its removal is reported$/, (w) => {
    const line = w.logs!.find((l) => l.includes('Removed orphaned verdict sidecar'))
    expect(line).toBeDefined()
    expect(line!).toContain(basename(w.sidecarPath!))
  })

  reg.define(/^both hand-made files still exist$/, (w) => {
    expect(existsSync(w.handMade!)).toBe(true)
    expect(existsSync(w.barePattern!)).toBe(true)
  })
}
