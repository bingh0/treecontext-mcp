import type { Database } from '../database.js'

/**
 * Replay-safety guards shared by additive migrations. 016–020 open-coded
 * these (and must stay as shipped history); 021 onward import them so the
 * five copies stop drifting. A guarded migration must tolerate
 * marker-rollback re-application and minimal legacy fixtures where the
 * table itself is absent.
 *
 * Lives here rather than in migrations.ts: migrations.ts has a runtime
 * import of migrations/index.ts, so a migration importing it back would
 * turn the existing type-only back-edge into a value cycle.
 */

export function hasTable(db: Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** Add each missing column from one PRAGMA table_info scan. */
export function addColumns(db: Database, table: string, cols: Array<[name: string, decl: string]>): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [name, decl] of cols) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl};`)
    }
  }
}
