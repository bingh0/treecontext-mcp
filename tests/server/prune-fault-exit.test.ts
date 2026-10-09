/**
 * Review finding R1 (2026-08-11 pass): `stores prune --yes` with a failed
 * removal must exit 2 — the same partial-completion convention the sweep
 * uses. Before the fix it logged `Failed to remove <name>` and exited 0,
 * so `prune --yes && ...` sailed past an EACCES.
 *
 * Own file: DEFAULT_STORES_DIR resolves from homedir() at module load, so
 * HOME must be redirected before the module graph is imported.
 *
 * POSIX-only: the failure is provoked with a write-protected store
 * directory, which chmod cannot arrange on Windows ACLs; root bypasses
 * permission checks entirely, hence the uid guard.
 */
import { mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterAll, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

import { redirectHome, storesDirIn } from '../helpers/home.js'
import type { CliArgs } from '../../src/server/cli.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-prune-fault-'))
const restoreHome = redirectHome(fakeHome)
const storesDir = storesDirIn(fakeHome)

const { runStores } = await import('../../src/server/cli.js')
const { maxSupportedVersion } = await import('../../src/persistence/migrations/index.js')
const { SCHEMA_SQL } = await import('../../src/persistence/schema.js')

const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0

/** A stray autostore: home-hash name, current schema, zero leaves. */
function seedStray(suffix: string): string {
  const name = `${basename(fakeHome)}-${suffix}`
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const db = new BetterSqlite3(join(dir, 'treecontext.db'))
  db.exec(SCHEMA_SQL)
  db.pragma(`user_version = ${maxSupportedVersion}`)
  db.close()
  return dir
}

afterAll(() => {
  try { chmodSync(join(storesDir, `${basename(fakeHome)}-aaa111`), 0o755) } catch { /* absent */ }
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe.skipIf(!posixNonRoot)('prune partial-completion exit (R1)', () => {
  it('a failed removal is reported and the run exits 2', async () => {
    rmSync(storesDir, { recursive: true, force: true })
    mkdirSync(storesDir, { recursive: true })
    // Sorted order puts the unremovable stray first: a correct exit code
    // must survive the loop continuing past the failure.
    const stuckDir = seedStray('aaa111')
    const freeDir = seedStray('fff999')
    chmodSync(stuckDir, 0o555)

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
    const prev = process.exitCode
    process.exitCode = undefined
    let exitCode: number | undefined
    try {
      await runStores({ storesAction: 'prune', yes: true } as CliArgs)
      exitCode = process.exitCode
    } finally {
      process.exitCode = prev
      logSpy.mockRestore()
      errSpy.mockRestore()
    }

    expect(logs.some((l) => l.includes('Failed to remove') && l.includes('aaa111'))).toBe(true)
    expect(logs.some((l) => l.includes('Removed') && l.includes('fff999'))).toBe(true)
    expect(existsSync(freeDir)).toBe(false)
    expect(exitCode).toBe(2)
  })
})
