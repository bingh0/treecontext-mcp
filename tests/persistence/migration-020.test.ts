import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { runMigrations, currentSchemaVersion } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { MigrationRequiredError } from '../../src/errors/index.js'
import { FlatStore } from '../../src/flat-store.js'

// C1 capture attribution: staging.namespace (additive) — and the opt-out
// contract the program-C review caught it breaking. `migrate: false` is
// an opt-out for the WHOLE ladder: before the fix the gate only checked
// destructive migrations, so 020 (additive, newest on the ladder) ran
// over read-only connections and every read-only open of a v19 store
// died mid-ALTER with SQLITE_READONLY instead of refusing cleanly.
describe('migration 020_staging_namespace', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-mig20-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** A store exactly one version behind: fully migrated, then wound back
   *  to v19 — 020's guard tolerates the column already existing, so the
   *  replay exercises the real gate logic. */
  function makeV19(path: string): void {
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw)
    runMigrations(db, { migrate: true })
    raw.pragma('user_version = 19')
    raw.close()
  }

  it('applies additively on a v19 store and lands the namespace column', () => {
    const path = join(dir, 'v19.db')
    makeV19(path)
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw)
    const report = runMigrations(db, {})
    expect(report.to).toBe(maxSupportedVersion)
    const cols = raw.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'namespace')).toBe(true)
    raw.close()
  })

  it('migrate:false refuses a pending additive ladder — an opt-out is an opt-out', () => {
    const path = join(dir, 'optout.db')
    makeV19(path)
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw)
    expect(() => runMigrations(db, { migrate: false })).toThrow(MigrationRequiredError)
    expect(currentSchemaVersion(db), 'the refused ladder must not have half-applied').toBe(19)
    raw.close()
  })

  it('a read-only open of a v19 store refuses cleanly instead of dying mid-ALTER', async () => {
    const path = join(dir, 'readonly.db')
    makeV19(path)
    // A genuinely read-only connection: any write attempt would be
    // SQLITE_READONLY — the crash the clean refusal replaces.
    const raw = new BetterSqlite3(path, { readonly: true })
    const db = wrapBetterSqlite(raw)
    await expect(
      FlatStore.open({ database: db, ownsDatabase: true, readOnly: true }),
    ).rejects.toThrow(MigrationRequiredError)
    raw.close()
  })
})
