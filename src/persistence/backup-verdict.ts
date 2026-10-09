/**
 * Pre-migration backup discovery and the migration verdict sidecar.
 *
 * Shared by the migration runner (writes verdicts), stores rm/prune
 * (spare failed/missing-verdict backups), doctor (reports backups), and
 * the sweep (deletes verified ones). Contract: tests/server/
 * backup-{visibility,sweep,lifecycle}.feature; storage decision:
 * tests/server/design/verdict-record.md.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The exact filename doctor and the sweep recognize, database prefix
 * included — a bare `pre-migration-v12.bak` is a foreign file (fence,
 * ratified). The migration runner derives the name from the db path, so
 * only stores whose database is `treecontext.db` produce recognized
 * backups; that is every store the stores directory can hold.
 */
export const MIGRATION_BACKUP_RE = /^treecontext\.db\.pre-migration-v(\d+)\.bak$/

export type Verdict = 'success' | 'failed'

export interface VerdictRecord {
  version: 1
  verdict: Verdict
  backupEntries: number
  migratedEntries: number
  /** Backup entries absent from the migrated store (D256 containment);
   *  present only on a failed verdict. */
  missingEntries?: number
  from: number
  to: number
  recordedAt: number
}

export interface MigrationBackup {
  /** e.g. `treecontext.db.pre-migration-v17.bak` */
  fileName: string
  /** Absolute path to the backup file. */
  path: string
  /** Schema version the store held before the migration (from the name). */
  sourceVersion: number
  sizeBytes: number
  /** null = no sidecar = "no migration verdict". */
  verdict: Verdict | null
}

export function verdictPathFor(backupPath: string): string {
  return `${backupPath}.verdict.json`
}

/** Read a backup's verdict sidecar; null when absent or unparseable. */
export function readVerdict(backupPath: string): VerdictRecord | null {
  try {
    const raw = JSON.parse(readFileSync(verdictPathFor(backupPath), 'utf8')) as VerdictRecord
    if (raw && (raw.verdict === 'success' || raw.verdict === 'failed')) return raw
    return null
  } catch {
    return null
  }
}

export function writeVerdict(backupPath: string, record: VerdictRecord): void {
  // Mode applies on create — the verdict sits beside the backup it judges
  // and is private like it (docs/security.md §3).
  writeFileSync(verdictPathFor(backupPath), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Enumerate the pre-migration backups inside one store directory.
 * Unreadable directories yield an empty list — a backup that cannot be
 * enumerated cannot be reported or swept, and the store checks elsewhere
 * in doctor will say why the directory is sick.
 */
export function listMigrationBackups(storeDir: string): MigrationBackup[] {
  let names: string[]
  try {
    names = readdirSync(storeDir)
  } catch {
    return []
  }
  const out: MigrationBackup[] = []
  for (const name of names.sort()) {
    const m = MIGRATION_BACKUP_RE.exec(name)
    if (!m) continue
    const path = join(storeDir, name)
    let sizeBytes = 0
    try {
      sizeBytes = statSync(path).size
    } catch {
      continue // vanished between readdir and stat
    }
    out.push({
      fileName: name,
      path,
      sourceVersion: Number(m[1]),
      sizeBytes,
      verdict: readVerdict(path)?.verdict ?? null,
    })
  }
  return out
}

/**
 * Verdict sidecars whose backup no longer exists in `storeDir`. The
 * design invariant is "the sidecar dies with its backup"; hand-deletion
 * of the `.bak` alone, or a sweep whose backup delete succeeded but
 * whose sidecar delete threw, strands one. A sidecar is derived
 * metadata — meaningless without the file it judges — so the sweep
 * reclaims these (fence amendment 2026-08-11). Only names matching the
 * exact `<recognized backup>.verdict.json` shape are ours to take.
 */
export function listOrphanVerdictSidecars(storeDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(storeDir)
  } catch {
    return []
  }
  const present = new Set(names)
  const out: string[] = []
  const SUFFIX = '.verdict.json'
  for (const name of names.sort()) {
    if (!name.endsWith(SUFFIX)) continue
    const backupName = name.slice(0, -SUFFIX.length)
    if (!MIGRATION_BACKUP_RE.test(backupName)) continue
    if (!present.has(backupName)) out.push(name)
  }
  return out
}
