import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { migrations, maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { readVerdict } from '../../src/persistence/backup-verdict.js'

// D59, restated by the owner 2026-10-08 (D256): "the goal is to always
// have a backup before any migration or schema update." The copy used to
// be taken only ahead of a destructive step, so the additive 025-027 ran
// bare on every store that crossed them.
describe('every pending migration runs behind a backup (D59, D256)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-migbak-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** A store with journal rows whose pending set is ADDITIVE ONLY: the
   *  head schema rewound to the newest destructive step. Every migration
   *  above it is idempotent DDL, so replaying them is the real ladder. */
  function storeWithAdditiveOnlyPending(): { path: string; from: number } {
    const lastDestructive = Math.max(...migrations.filter((m) => m.kind === 'destructive').map((m) => m.version))
    expect(lastDestructive, 'no additive migration sits above the newest destructive one').toBeLessThan(maxSupportedVersion)
    const path = join(dir, 'treecontext.db')
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw)
    runMigrations(db, { migrate: true })
    for (const f of [`${path}.pre-migration-v0.bak`]) rmSync(f, { force: true })
    raw.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
    const ins = raw.prepare("INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES (?, 1, ?, '', 0, 0)")
    for (let i = 0; i < 7; i++) ins.run(`n-${i}`, `entry ${i}`)
    raw.pragma(`user_version = ${lastDestructive}`)
    raw.close()
    return { path, from: lastDestructive }
  }

  it('an additive-only pending set is copied aside first, with a success verdict', () => {
    const { path, from } = storeWithAdditiveOnlyPending()
    const raw = new BetterSqlite3(path)
    const report = runMigrations(wrapBetterSqlite(raw), { migrate: true })
    raw.close()
    expect(report.applied.length).toBeGreaterThan(0)
    expect(report.applied.every((a) => a.kind === 'additive')).toBe(true)
    expect(report.backupPath, 'additive runs bare again').toBe(`${path}.pre-migration-v${from}.bak`)
    expect(existsSync(report.backupPath!)).toBe(true)
    // The copy is the PRE-migration state, rows and all.
    const bak = new BetterSqlite3(report.backupPath!, { readonly: true })
    try {
      expect(bak.pragma('user_version', { simple: true })).toBe(from)
      expect((bak.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c).toBe(7)
    } finally {
      bak.close()
    }
    // A verdict, so the sweep can reclaim it like any other backup.
    expect(report.verdict).toBe('success')
    expect(readVerdict(report.backupPath!)?.verdict).toBe('success')
  })

  it('a writer active between the backup and the verdict costs no row and fails no verdict', () => {
    const { path, from } = storeWithAdditiveOnlyPending()
    const raw = new BetterSqlite3(path)
    const db = wrapBetterSqlite(raw)
    // A second connection writes the moment the backup is taken — the
    // window an additive (non-exclusive) run leaves open.
    let wrote = 0
    const writer = (): void => {
      const w2 = new BetterSqlite3(path)
      try {
        const ins = w2.prepare("INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES (?, 1, ?, '', 0, 0)")
        for (let i = 0; i < 5; i++) { ins.run(`late-${i}`, `written during the migration ${i}`); wrote++ }
      } finally {
        w2.close()
      }
    }
    const watched = new Proxy(db, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string): void => {
            target.exec(sql)
            if (sql.startsWith('VACUUM INTO')) writer()
          }
        }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
    const report = runMigrations(watched, { migrate: true })
    expect(wrote).toBe(5)
    expect(report.backupPath).toBe(`${path}.pre-migration-v${from}.bak`)
    expect(report.verdict, 'a session writing through the window was read as a loss').toBe('success')
    expect((raw.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c).toBe(12)
    raw.close()
    const record = readVerdict(report.backupPath!)
    expect(record).toMatchObject({ verdict: 'success', backupEntries: 7, migratedEntries: 12 })
  })

  it('a backup row missing from the migrated store fails the verdict, counts notwithstanding', async () => {
    const { path, from } = storeWithAdditiveOnlyPending()
    const raw = new BetterSqlite3(path)
    runMigrations(wrapBetterSqlite(raw), { migrate: true })
    // One row gone, two others added: equal-or-greater count, not contained.
    raw.prepare("DELETE FROM nodes WHERE node_id = 'n-0'").run()
    raw.prepare("INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES ('x-1', 1, 'a', '', 0, 0), ('x-2', 1, 'b', '', 0, 0)").run()
    const { recordCompletionVerdict } = await import('../../src/persistence/migrations.js')
    const errors: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
    try {
      expect(recordCompletionVerdict(wrapBetterSqlite(raw), `${path}.pre-migration-v${from}.bak`, from)).toBe('failed')
    } finally {
      console.error = orig
      raw.close()
    }
    expect(readVerdict(`${path}.pre-migration-v${from}.bak`)).toMatchObject({ verdict: 'failed', missingEntries: 1 })
    // The advice never sends the operator to overwrite rows written since.
    expect(errors.join('\n')).toMatch(/only if nothing has been written since the migration began/)
  })

  it('a store at the head takes no backup', () => {
    const path = join(dir, 'treecontext.db')
    const raw = new BetterSqlite3(path)
    runMigrations(wrapBetterSqlite(raw), { migrate: true })
    const report = runMigrations(wrapBetterSqlite(raw), { migrate: true })
    raw.close()
    expect(report.applied).toEqual([])
    expect(report.backupPath).toBeUndefined()
  })

  it('an in-memory database has nothing to copy beside and still migrates', () => {
    const raw = new BetterSqlite3(':memory:')
    const report = runMigrations(wrapBetterSqlite(raw), { migrate: true })
    raw.close()
    expect(report.to).toBe(maxSupportedVersion)
    expect(report.backupPath).toBeUndefined()
  })
})
