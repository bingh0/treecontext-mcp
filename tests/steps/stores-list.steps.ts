/**
 * stores-list.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Doctor remains the authoritative disk-debt surface; the listing's two
 * honesty fixes — backup bytes split from live bytes, shell directories
 * labeled as what they are.
 *
 * The listing cannot run in this worker: DEFAULT_STORES_DIR freezes
 * from homedir() at import (src/tools/stores.ts) and runStores passes
 * no directory, so each scenario drives the served surface through a
 * fresh redirected-home process (helpers/stores-list-child.ts) and the
 * parent parses its captured stdout exactly as the old in-process
 * capture did. Seeding stays parent-side: the store fixtures are
 * path-based under the scenario's own sandboxed home, which the child
 * sees as HOME.
 *
 * The zero-byte-backup edge lived beside this module as a plain vitest
 * file (stores-list-edge.test.ts) until 2026-08-27 — an assertion about
 * the rendering, sitting outside the feature corpus where no manifest
 * row and no audit ratchet could see it. It is a scenario now.
 */
import { rmSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import { spawnNodeTs } from '../helpers/cli-spawn.js'
import { freshHomeDir, seedStoreDir, seedBackupFile, storesDirIn } from '../helpers/store-fixtures.js'
import { formatBytes } from '../../src/tools/stores.js'
import { fileURLToPath } from 'node:url'

const CHILD_TS = fileURLToPath(new URL('../helpers/stores-list-child.ts', import.meta.url))

interface World {
  defer: (fn: () => void | Promise<void>) => void
  fakeHome?: string
  dbBytes?: number
  strayName?: string
  lines?: string[]
  table?: Map<string, Record<string, string>>
}

export const storesListDefiner = (reg: Registry<World>): void => {
  function freshHome(w: World): void {
    w.fakeHome = freshHomeDir(w, 'tc-stores-list-')
  }

  function storesDir(w: World): string {
    return storesDirIn(w.fakeHome!)
  }

  // Merged: every scenario lists through the same isolated process; the
  // parent keeps both views of the capture (raw lines and the parsed
  // NAME-keyed table) so each Then reads its own slice as before.
  reg.define(/^the user lists the stores$/, async (w) => {
    const r = spawnNodeTs(CHILD_TS, [], { home: w.fakeHome! })
    expect(r.status, `stores-list child failed: ${r.stderr}`).toBe(0)
    w.lines = r.stdout.split('\n')
    const [header, ...rows] = w.lines
    const cols = header!.split('\t')
    const table = new Map<string, Record<string, string>>()
    for (const row of rows) {
      const cells = row.split('\t')
      const rec: Record<string, string> = {}
      cols.forEach((c, i) => { rec[c] = cells[i] ?? '' })
      table.set(rec['NAME']!, rec)
    }
    w.table = table
  })

  reg.define(/^store "notes" has a live database and a 128 KB pre-migration backup$/, (w) => {
    freshHome(w)
    const dbPath = seedStoreDir(storesDir(w), 'notes')
    seedBackupFile(storesDir(w), 'notes', 12, 128, 'success')
    w.dbBytes = statSync(dbPath).size
  })

  reg.define(/^store "scratch" has a live database and no backups$/, (w) => {
    seedStoreDir(storesDir(w), 'scratch')
  })

  reg.define(/^store "lectures" is a shell directory holding only a spared pre-migration backup$/, (w) => {
    freshHome(w)
    const dbPath = seedStoreDir(storesDir(w), 'lectures')
    seedBackupFile(storesDir(w), 'lectures', 12, 64, 'failed')
    rmSync(dbPath)
    expect(existsSync(dbPath)).toBe(false)
  })

  reg.define(/^store "interrupted" is a shell directory holding only a zero-byte backup$/, (w) => {
    freshHome(w)
    const dbPath = seedStoreDir(storesDir(w), 'interrupted')
    // The artifact of a copy that died mid-write: the file exists and
    // holds nothing.
    writeFileSync(join(storesDir(w), 'interrupted', 'treecontext.db.pre-migration-v12.bak'), '')
    rmSync(dbPath)
    expect(existsSync(dbPath)).toBe(false)
  })

  reg.define(/^a stores directory with nothing in it$/, (w) => {
    freshHome(w)
    mkdirSync(storesDir(w), { recursive: true })
  })

  reg.define(/^store "mangled" whose database file holds garbage bytes$/, (w) => {
    freshHome(w)
    mkdirSync(join(storesDir(w), 'mangled'), { recursive: true })
    writeFileSync(join(storesDir(w), 'mangled', 'treecontext.db'), 'not a database')
    seedStoreDir(storesDir(w), 'healthy')
  })

  reg.define(/^an empty store named like this machine's home-hash derivation$/, (w) => {
    freshHome(w)
    // The stray predicate is home-basename + 6-hex-digit hash with no
    // leaves — the shape the old home-hash auto-derivation minted.
    w.strayName = `${w.fakeHome!.split(/[\\/]/).pop()!}-abc123`
    seedStoreDir(storesDir(w), w.strayName)
  })

  reg.define(/^store "keeper" has a live database and a user-made backup file beside it$/, (w) => {
    freshHome(w)
    seedStoreDir(storesDir(w), 'keeper')
    writeFileSync(join(storesDir(w), 'keeper', 'my-backup.db'), 'user bytes')
    writeFileSync(join(storesDir(w), 'keeper', 'treecontext.db.bak'), 'more user bytes')
  })

  reg.define(/^store "hot" has a live database beside a write-ahead log file$/, (w) => {
    freshHome(w)
    const dbPath = seedStoreDir(storesDir(w), 'hot')
    w.dbBytes = statSync(dbPath).size
    writeFileSync(join(storesDir(w), 'hot', 'treecontext.db-wal'), Buffer.alloc(32 * 1024))
  })

  reg.define(/^the "notes" row carries the backup bytes in their own column$/, (w) => {
    expect(w.table!.get('notes')!['BACKUPS']).toBe('128.0K')
  })

  reg.define(/^the "scratch" row's backups column is empty$/, (w) => {
    expect(w.table!.get('scratch')!['BACKUPS']).toBe('')
  })

  reg.define(/^the size column reports the database's bytes alone$/, (w) => {
    // Not db+backup: the split is the whole point.
    expect(w.table!.get('notes')!['SIZE']).toBe(formatBytes(w.dbBytes!))
  })

  reg.define(/^the "lectures" row is labeled a shell$/, (w) => {
    expect(w.table!.get('lectures')!['NOTE']).toBe('shell')
  })

  reg.define(/^the "interrupted" row is the only row, and it is labeled a shell$/, (w) => {
    // The whole listing, not just a lookup: the only store seeded is the
    // shell, so a row appearing beside it would mean the fixture — or the
    // listing — grew something this scenario never staged.
    expect([...w.table!.keys()]).toEqual(['interrupted'])
    expect(w.table!.get('interrupted')!['NOTE']).toBe('shell')
  })

  // Literals, not formatBytes(): the renderer formats through that same
  // function, so an expectation built from it moves with the defect — a
  // formatBytes that returned '' for zero kept "reads 0B" green over an
  // empty cell (proven by mutation at this gate). The scenario text
  // promises the glyphs; the steps pin the glyphs.
  reg.define(/^its backups column reads 0B rather than empty$/, (w) => {
    expect(w.table!.get('interrupted')!['BACKUPS']).toBe('0B')
  })

  reg.define(/^its backups column carries the backup's size$/, (w) => {
    expect(w.table!.get('lectures')!['BACKUPS']).toBe('64.0K')
  })

  reg.define(/^the listing says there are no stores and names the directory$/, (w) => {
    expect(w.lines).toHaveLength(1)
    expect(w.lines![0]).toBe(`No stores in ${storesDir(w)}`)
  })

  reg.define(/^no table header is printed$/, (w) => {
    // step-lint: allow unearned-absence -- guarded: the exact full-output equality ('No stores in …') is asserted directly above — a header cannot also print
    expect(w.lines!.join('\n')).not.toMatch(/NAME\tLEAVES/)
  })

  reg.define(/^the "mangled" row shows dashes for its node counts$/, (w) => {
    expect(w.table!.get('mangled')!['LEAVES']).toBe('-')
    expect(w.table!.get('mangled')!['TOTAL']).toBe('-')
  })

  reg.define(/^the healthy rows still render$/, (w) => {
    expect(w.table!.get('healthy')!['LEAVES']).toBe('0')
  })

  reg.define(/^that row is labeled stray$/, (w) => {
    expect(w.table!.get(w.strayName!)!['NOTE']).toBe('stray')
  })

  reg.define(/^the "keeper" row's backups column is empty$/, (w) => {
    expect(w.table!.get('keeper')!['BACKUPS']).toBe('')
  })

  reg.define(/^the "hot" row's size column reports the database file's bytes alone$/, (w) => {
    expect(w.table!.get('hot')!['SIZE']).toBe(formatBytes(w.dbBytes!))
  })
}
