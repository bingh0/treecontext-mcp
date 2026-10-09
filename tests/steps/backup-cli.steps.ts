/**
 * backup-cli.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * CLI-level backup contract (F2, 2026-08-15). backup.test.ts proves
 * backupStore() at the unit level; every scenario here spawns the real
 * CLI, because the refusals under test — missing destination,
 * exists-without-force — live in main()'s dispatch and in backupStore's
 * throw surfacing through the fatal handler as exit 1. Stores are named
 * with --store to keep binding resolution out of frame (the
 * unbound-directory refusal is store-bindings.feature's pin).
 *
 * The two scenarios sharing "a store with rows and a destination file
 * that already exists" seeded different original bytes ('precious bytes
 * already here' vs 'stale copy'); only the refusal scenario asserts
 * them, so the merged definition seeds that asserted sentinel via the
 * world field and both scenarios share it.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'

import { spawnCli } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'

interface CliRun {
  status: number | null
  out: string
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  home?: string
  dst?: string
  dstBytes?: string
  run?: CliRun
}

export const backupCliDefiner = (reg: Registry<World>): void => {
  /** The per-scenario sandbox: home + the copies/ directory holding dst. */
  function freshHome(w: World): void {
    const home = mkdtempSync(join(tmpdir(), 'tc-backup-cli-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    const dst = join(home, 'copies', 'journal-copy.db')
    mkdirSync(join(home, 'copies'))
    w.home = home
    w.dst = dst
  }

  /** A real store with three rows, reachable as --store <name>. */
  function seedStore(w: World, name: string): void {
    const dir = join(storesDirIn(w.home!), name)
    mkdirSync(dir, { recursive: true })
    const db = new BetterSqlite3(join(dir, 'treecontext.db'))
    db.exec('CREATE TABLE rows (v TEXT)')
    db.prepare('INSERT INTO rows (v) VALUES (?), (?), (?)').run('a', 'b', 'c')
    db.close()
  }

  function countRows(path: string): number {
    const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
    try {
      return (db.prepare('SELECT COUNT(*) AS c FROM rows').get() as { c: number }).c
    } finally {
      db.close()
    }
  }

  reg.define(/^a machine with a bound store$/, (w) => {
    freshHome(w)
    seedStore(w, 'journal')
  })

  // Merged: both overwrite scenarios shared this Given; the refusal
  // scenario's And asserts the seeded bytes verbatim, so the sentinel
  // lives on the world.
  reg.define(/^a store with rows and a destination file that already exists$/, (w) => {
    freshHome(w)
    seedStore(w, 'journal')
    w.dstBytes = 'precious bytes already here'
    writeFileSync(w.dst!, w.dstBytes)
  })

  reg.define(/^a store with rows$/, (w) => {
    freshHome(w)
    seedStore(w, 'journal')
    expect(existsSync(w.dst!)).toBe(false)
  })

  reg.define(/^backup runs with no destination$/, (w) => {
    w.run = spawnCli(['backup', '--store', 'journal'], { home: w.home! })
  })

  reg.define(/^backup runs at that destination$/, (w) => {
    w.run = spawnCli(['backup', w.dst!, '--store', 'journal'], { home: w.home! })
  })

  reg.define(/^backup runs at that destination with force$/, (w) => {
    w.run = spawnCli(['backup', w.dst!, '--store', 'journal', '--force'], { home: w.home! })
  })

  reg.define(/^backup runs to a fresh destination$/, (w) => {
    w.run = spawnCli(['backup', w.dst!, '--store', 'journal'], { home: w.home! })
  })

  reg.define(/^it exits with an error naming the missing destination$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/backup requires a destination path/)
  })

  reg.define(/^it refuses and names the force flag$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(1)
    expect(w.run!.out).toMatch(/already exists/)
    expect(w.run!.out).toMatch(/--force/)
  })

  reg.define(/^the destination's original bytes survive$/, (w) => {
    expect(readFileSync(w.dst!, 'utf8')).toBe(w.dstBytes)
  })

  // Merged: the force and fresh-copy scenarios share this observable.
  reg.define(/^the destination is a valid copy holding the store's rows$/, (w) => {
    expect(w.run!.status, w.run!.out).toBe(0)
    expect(countRows(w.dst!)).toBe(3)
  })

  reg.define(/^it reports the copy it made$/, (w) => {
    expect(w.run!.out).toMatch(/Backing up/)
    expect(w.run!.out).toMatch(/Backup complete/)
  })
}
