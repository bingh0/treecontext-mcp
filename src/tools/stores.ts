/**
 * Store inventory helpers — list, inspect, and prune `~/.treecontext/stores/*`.
 *
 * Motivation: when an MCP client launches the server with `cwd = $HOME`
 * (VSCode user-scoped config), autostore used to create a one-off
 * `<home-basename>-<6hex>/` store before the roots switch could correct
 * itself. The CtxManager now reopens the right store on first tool call,
 * but the stray empty store is left on disk. This module provides the
 * inventory + cleanup the CLI's `stores` subcommand exposes.
 */
import { readdirSync, realpathSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

import {
  listMigrationBackups, listOrphanVerdictSidecars, verdictPathFor, type MigrationBackup,
} from '../persistence/backup-verdict.js'
import { maxSupportedVersion } from '../persistence/migrations/index.js'

const requireNode = createRequire(import.meta.url)

export const DEFAULT_STORES_DIR = join(homedir(), '.treecontext', 'stores')

/**
 * The exact CLI invocation that reclaims verified backups. Doctor's
 * advice line prints this constant, and cli-stores.test.ts feeds it back
 * through the real arg parser — so a renamed subcommand cannot leave the
 * advice pointing at a command that no longer parses.
 */
export const SWEEP_COMMAND = 'treecontext stores sweep'

/**
 * The rm subcommand tokens, shared by every surface that NAMES the
 * command (doctor's advice via rmCommandFor, the sweep's orphan refusal
 * reason) so they rename together or the parse-through test goes red.
 */
export const STORES_RM = 'stores rm'

/**
 * The exact CLI invocation that reclaims a verified orphan shell —
 * parse-through-tested like SWEEP_COMMAND. Only meaningful for names
 * that pass SAFE_STORE_RE; callers advising on other names must say
 * "by hand" instead (the parser refuses them).
 */
export function rmCommandFor(store: string): string {
  return `treecontext ${STORES_RM} ${store} --yes`
}

// Re-exported for the dynamic-import consumers of this module (doctor);
// the canonical definitions live in the dependency-free store-name leaf.
export { SAFE_STORE_RE, isCliAddressableStoreName } from './store-name.js'

/** Matches the `<home-basename>-<6hex>` autostore fallback naming. */
export const HOME_HASH_STORE_RE = /^[A-Za-z0-9._-]+-[0-9a-f]{6}$/

/**
 * THE store-directory enumeration — every surface that walks the stores
 * directory (stores list, the sweep, doctor's backup section) walks it
 * through here, so they can never disagree about what a store is:
 * directories only, sorted, unreadable entries skipped, a missing stores
 * directory an empty list.
 */
export function listStoreDirs(storesDir: string = DEFAULT_STORES_DIR): Array<{ name: string; path: string }> {
  let names: string[]
  try {
    names = readdirSync(storesDir).sort()
  } catch {
    return []
  }
  const out: Array<{ name: string; path: string }> = []
  for (const name of names) {
    const path = join(storesDir, name)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    out.push({ name, path })
  }
  return out
}

export interface StoreDescription {
  name: string
  path: string
  dbPath: string
  dbExists: boolean
  sizeBytes: number
  mtimeMs: number
  leafNodes: number | null
  totalNodes: number | null
  /** True when the name matches the home-basename fallback pattern. */
  matchesHomeHashPattern: boolean
  /**
   * True when this store is safe to prune: matches the home-hash pattern
   * *and* has no leaf nodes (only the empty ensemble roots). The caller
   * still decides whether to actually delete.
   */
  stray: boolean
  /**
   * The store's pre-migration backups, enumerated ONCE here — callers
   * (rm's shell/preview paths, the listing) derive from this instead of
   * re-walking the directory (fifth-pass review).
   */
  backups: MigrationBackup[]
  /**
   * Pre-migration backup bytes, split from `sizeBytes` (which is the
   * database alone) — the at-a-glance half of the disk-debt story;
   * doctor remains the authoritative surface (fence, 2026-08-12).
   */
  backupBytes: number
  /**
   * A directory whose database is gone but which still holds spared
   * backups — rm/prune's spare rule leaves these; the listing labels
   * them instead of rendering an ordinary empty store. Derived from the
   * same `backups` the display renders, so a zero-byte backup cannot
   * yield a 'shell' row with an empty backups cell.
   */
  shell: boolean
}

/**
 * Enumerate store directories. Returns unsorted; the CLI sorts as needed.
 */
export function listStores(
  storesDir: string = DEFAULT_STORES_DIR,
  opts: { homeBasename?: string } = {},
): StoreDescription[] {
  const homeBasename = opts.homeBasename ?? basename(homedir())
  const out: StoreDescription[] = []
  for (const { name, path } of listStoreDirs(storesDir)) {
    try {
      out.push(describeStore(path, name, homeBasename))
    } catch {
      // unreadable — skip
    }
  }
  return out
}

export function describeStore(
  path: string,
  nameOverride?: string,
  homeBasename: string = basename(homedir()),
): StoreDescription {
  const name = nameOverride ?? basename(path)
  const dbPath = join(path, 'treecontext.db')
  const dbExists = existsSync(dbPath)
  let sizeBytes = 0
  let mtimeMs = 0
  if (dbExists) {
    const st = statSync(dbPath)
    sizeBytes = st.size
    mtimeMs = st.mtimeMs
  }
  const counts = dbExists ? countNodes(dbPath) : { leaves: null, total: null }
  const matchesHomeHashPattern =
    HOME_HASH_STORE_RE.test(name) && name.startsWith(`${homeBasename}-`)
  const stray = matchesHomeHashPattern && counts.leaves === 0
  const backups = listMigrationBackups(path)
  return {
    name,
    path,
    dbPath,
    dbExists,
    sizeBytes,
    mtimeMs,
    leafNodes: counts.leaves,
    totalNodes: counts.total,
    matchesHomeHashPattern,
    stray,
    backups,
    backupBytes: backups.reduce((n, b) => n + b.sizeBytes, 0),
    shell: !dbExists && backups.length > 0,
  }
}

function countNodes(dbPath: string): { leaves: number | null; total: number | null } {
  try {
    const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
    const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
    try {
      const hasNodes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
        .get()
      if (!hasNodes) return { leaves: 0, total: 0 }
      const leafRow = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE is_leaf = 1').get() as
        | { c: number }
        | undefined
      const totalRow = db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as
        | { c: number }
        | undefined
      return {
        leaves: leafRow?.c ?? 0,
        total: totalRow?.c ?? 0,
      }
    } finally {
      db.close()
    }
  } catch {
    return { leaves: null, total: null }
  }
}

export interface PruneResult {
  candidates: StoreDescription[]
  /** Stores whose directory is fully gone. */
  deleted: string[]
  /**
   * Stores whose database was removed but whose directory survives as a
   * shell around spared live-rollback backups (spare rule). Disjoint
   * from `deleted`.
   */
  spared: Array<{ name: string; backups: MigrationBackup[] }>
  errors: Array<{ name: string; error: string }>
}

/**
 * Identify stray stores and optionally remove them. Dry-run by default.
 * Only deletes stores where `stray` is true (home-hash pattern +
 * zero leaves); callers wanting to remove a specific store should use
 * `removeStore` directly.
 */
export function pruneStrayStores(
  storesDir: string = DEFAULT_STORES_DIR,
  opts: { dryRun?: boolean; homeBasename?: string } = {},
): PruneResult {
  const dryRun = opts.dryRun ?? true
  const listOpts = opts.homeBasename !== undefined
    ? { homeBasename: opts.homeBasename }
    : {}
  const all = listStores(storesDir, listOpts)
  const candidates = all.filter((s) => s.stray)
  const deleted: string[] = []
  const spared: PruneResult['spared'] = []
  const errors: Array<{ name: string; error: string }> = []
  if (!dryRun) {
    for (const c of candidates) {
      try {
        const result = removeStore(c.path, storesDir)
        // A store lands in exactly one bucket: fully removed, its
        // directory survives as a shell around spared backups, or its
        // removal failed. Putting a shell-surviving store in BOTH lists
        // made the CLI claim "Removed X" for a directory still on disk;
        // removeStore's own fault isolation now reports content-level
        // failures via `failed` instead of a throw.
        if (result.failed.length > 0) {
          errors.push({ name: c.name, error: result.failed.map((f) => `${f.name}: ${f.error}`).join('; ') })
        } else if (result.spared.length > 0) {
          spared.push({ name: c.name, backups: result.spared })
        } else {
          deleted.push(c.name)
        }
      } catch (err) {
        errors.push({ name: c.name, error: String(err) })
      }
    }
  }
  return { candidates, deleted, spared, errors }
}

export interface RemoveStoreResult {
  /**
   * Backups deleted with the store (recorded success verdict). Only
   * entries whose deletion actually succeeded — a claimed "took" for a
   * file still on disk is the lie this surface keeps getting reviewed
   * for.
   */
  took: MigrationBackup[]
  /**
   * Backups left behind as live rollbacks (failed or missing verdict).
   * When non-empty the store directory survives as a shell holding only
   * these files — a spared backup leaves only by hand
   * (backup-lifecycle.feature, ratified at the cold-read).
   */
  spared: MigrationBackup[]
  /**
   * Entries whose deletion threw (EACCES and kin). Removal continues
   * past a failure — same fault isolation the sweep got — and the
   * caller reports each and signals partial completion instead of
   * losing the whole report to a generic fatal.
   */
  failed: Array<{ name: string; error: string }>
}

/**
 * The spare rule's one predicate: a backup whose verdict is failed or
 * missing is a live rollback — rm, prune, and the CLI's previews all
 * decide through here (backup-lifecycle.feature).
 */
export function isLiveRollback(b: MigrationBackup): boolean {
  return b.verdict !== 'success'
}

/**
 * The one spelling of a backup's verdict for user-facing lines — rm,
 * prune, and doctor previously each wrote `b.verdict ?? 'missing'`
 * by hand at eight sites.
 */
export function verdictLabel(b: MigrationBackup): string {
  return b.verdict ?? 'missing'
}

export function removeStore(storePath: string, storesDir: string = DEFAULT_STORES_DIR): RemoveStoreResult {
  // Security S9: resolve to real path and verify the target stays within
  // the stores directory. Prevents `../../etc` traversal attacks.
  let realTarget: string
  try {
    realTarget = realpathSync(storePath)
  } catch {
    throw new Error(`Store path does not exist or is unresolvable: ${storePath}`)
  }
  let realStoresRoot: string
  try {
    realStoresRoot = realpathSync(storesDir)
  } catch {
    throw new Error(`Stores directory does not exist: ${storesDir}`)
  }
  if (!realTarget.startsWith(realStoresRoot + sep)) {
    throw new Error(
      `Refusing to delete path outside stores directory: ${storePath} ` +
      `(resolved to ${realTarget}, expected prefix ${realStoresRoot}${sep})`,
    )
  }

  const backups = listMigrationBackups(realTarget)
  const spared = backups.filter(isLiveRollback)
  const takenCandidates = backups.filter((b) => !isLiveRollback(b))
  const failed: RemoveStoreResult['failed'] = []
  if (spared.length === 0) {
    try {
      rmSync(storePath, { recursive: true, force: true })
    } catch (err) {
      // Possibly partially removed; claim nothing as taken — the caller
      // reports the failure and the next run picks up what remains.
      failed.push({ name: basename(realTarget), error: err instanceof Error ? err.message : String(err) })
      return { took: [], spared, failed }
    }
    return { took: takenCandidates, spared, failed }
  }

  // Spare rule: delete everything except the live rollbacks and their
  // verdict sidecars; the directory survives as a shell around them.
  // Per-item fault isolation, same as the sweep's delete loop: one
  // EACCES must not abort mid-directory and escape as a generic fatal
  // that eats the whole took/spared report.
  const keep = new Set<string>()
  for (const b of spared) {
    keep.add(b.fileName)
    keep.add(basename(verdictPathFor(b.path)))
  }
  for (const name of readdirSync(realTarget)) {
    if (keep.has(name)) continue
    try {
      rmSync(join(realTarget, name), { recursive: true, force: true })
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const failedNames = new Set(failed.map((f) => f.name))
  const took = takenCandidates.filter((b) => !failedNames.has(b.fileName))
  return { took, spared, failed }
}

// ---------------------------------------------------------------------------
// Migration-backup sweep (contract: features/design/backup-sweep.feature).
// Safety lives in per-item verification, not ceremony: verification runs on
// every pass, so a --yes run with no prior dry-run is verified identically.

export interface SweepItem {
  store: string
  backup: MigrationBackup
  eligible: boolean
  /** Refusal reason when not eligible — exact strings from the contract. */
  reason?: string
}

export interface SweepResult {
  items: SweepItem[]
  /** Items actually deleted (empty on a dry-run). */
  deleted: SweepItem[]
  /**
   * Eligible items whose BACKUP deletion threw (EACCES and kin) — the
   * backup is still on disk. The sweep continues past a failure — one
   * unremovable file must not abort the run and silently strand every
   * backup after it.
   */
  failed: Array<{ item: SweepItem; error: string }>
  /**
   * Deleted items whose sidecar removal then threw: the backup IS gone
   * (the item is also in `deleted`), the sidecar remains as an orphan a
   * later sweep reclaims. Kept separate from `failed` so the report
   * never claims "failed to delete" a file that no longer exists.
   */
  strandedSidecars: Array<{ item: SweepItem; error: string }>
  /**
   * Orphaned verdict sidecars found (backup already gone — the design
   * invariant is "the sidecar dies with its backup"). Removed when not
   * a dry-run; `removed` says whether this run took it, and a --yes
   * entry that could not be removed carries `error` — a promised
   * removal that silently didn't happen is the defect class this whole
   * surface exists to prevent.
   */
  orphanSidecars: Array<{ store: string; fileName: string; removed: boolean; error?: string }>
  /** Bytes of deleted backups (sidecars excluded — accounting noise). */
  freedBytes: number
}

/**
 * A backup is eligible only when its live store opens, passes its
 * integrity check, and sits at the current schema version. Returns the
 * refusal reason, or undefined when the live store is healthy.
 */
function verifyLiveStore(storeDir: string): string | undefined {
  const dbPath = join(storeDir, 'treecontext.db')
  if (!existsSync(dbPath)) return 'live store missing'
  try {
    const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
    // Fail fast on a locked store: verification is advisory and the sweep
    // is retryable, so hanging the default 5s per locked store is worse
    // than refusing quickly.
    const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true, timeout: 500 })
    try {
      const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (rows.length !== 1 || rows[0]!.integrity_check !== 'ok') {
        return 'live store fails integrity check'
      }
      const v = db.pragma('user_version', { simple: true }) as number
      if (v !== maxSupportedVersion) return 'live store not at current schema'
      return undefined
    } finally {
      db.close()
    }
  } catch {
    // A throw is NOT a corruption diagnosis: SQLITE_BUSY (another process
    // holds the store) and EACCES land here too, and labeling a locked
    // store "fails integrity check" sends the user chasing corruption
    // that does not exist. Only non-ok integrity ROWS earn that verdict.
    return 'live store cannot be checked'
  }
}

/** Refusal reason for the backup file itself, or undefined when readable. */
function verifyBackupReadable(backupPath: string): string | undefined {
  try {
    const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
    const db = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true, timeout: 500 })
    try {
      // quick_check reports many corruptions as ROWS, not a throw —
      // repro'd with freelist corruption. Discarding the rows made the
      // sweep delete backups it could not actually verify.
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>
      if (rows.length !== 1 || rows[0]!.quick_check !== 'ok') return 'backup unreadable'
      return undefined
    } finally {
      db.close()
    }
  } catch {
    return 'backup unreadable'
  }
}

/**
 * Verify every pre-migration backup in the stores directory and, unless
 * dry-run (the default), delete the eligible ones with their verdict
 * sidecars. Refused backups are reported, never touched — a partial
 * sweep deletes the eligible and reports each refusal.
 */
export function sweepMigrationBackups(
  storesDir: string = DEFAULT_STORES_DIR,
  opts: { dryRun?: boolean; store?: string } = {},
): SweepResult {
  const dryRun = opts.dryRun ?? true
  const items: SweepItem[] = []
  const orphanSidecars: SweepResult['orphanSidecars'] = []
  for (const { name, path: storeDir } of listStoreDirs(storesDir)) {
    // `--store` scopes the whole pass — verification, deletion, and the
    // orphan-sidecar tidy alike. A backup outside the scope is not
    // listed, not judged, and not touched: during a beta, "delete
    // everything verified" and "keep the rollback I just took" are both
    // live wishes, and the selector is how they stop conflicting.
    if (opts.store !== undefined && name !== opts.store) continue
    for (const fileName of listOrphanVerdictSidecars(storeDir)) {
      if (dryRun) {
        orphanSidecars.push({ store: name, fileName, removed: false })
        continue
      }
      try {
        rmSync(join(storeDir, fileName), { force: true })
        orphanSidecars.push({ store: name, fileName, removed: true })
      } catch (err) {
        // Still orphaned; a later sweep gets another chance — but this
        // run must SAY so, not just quietly record removed:false.
        orphanSidecars.push({
          store: name, fileName, removed: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const backups = listMigrationBackups(storeDir)
    if (backups.length === 0) continue
    // The orphan classification tests the filesystem fact directly —
    // discriminating on verifyLiveStore's prose string made a message
    // rewording a silent behavior change (this branch reworded a sibling
    // reason string the same week).
    const liveMissing = !existsSync(join(storeDir, 'treecontext.db'))
    const liveReason = liveMissing ? 'live store missing' : verifyLiveStore(storeDir)
    for (const backup of backups) {
      // Each generation is judged independently; check order mirrors the
      // contract's refusal outline. Unreadable means unverifiable — the
      // sweep never deletes what it cannot check.
      //
      // A VERIFIED backup whose live store is gone gets its own refusal
      // (ruling 2026-08-10, fence amendment): the sweep still never
      // deletes what might be the last copy, but this state is
      // reclaimable — by explicit stores rm, not by falling through to
      // the generic 'live store missing' with no way out.
      const reason =
        liveMissing && !isLiveRollback(backup)
          ? `orphaned verified backup — reclaim with ${STORES_RM}`
          : liveReason ??
            (backup.verdict === null
              ? 'no migration verdict'
              : backup.verdict === 'failed'
                ? 'migration verdict failed'
                : verifyBackupReadable(backup.path))
      items.push(
        reason === undefined
          ? { store: name, backup, eligible: true }
          : { store: name, backup, eligible: false, reason },
      )
    }
  }

  const deleted: SweepItem[] = []
  const failed: SweepResult['failed'] = []
  const strandedSidecars: SweepResult['strandedSidecars'] = []
  let freedBytes = 0
  if (!dryRun) {
    for (const item of items) {
      if (!item.eligible) continue
      try {
        rmSync(item.backup.path, { force: true })
      } catch (err) {
        failed.push({ item, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      deleted.push(item)
      freedBytes += item.backup.sizeBytes
      // The sidecar gets its own try: sharing one with the backup made a
      // sidecar-only throw report "failed to delete" a backup that was
      // already gone, while the sidecar quietly became an invisible
      // stranded file. Now the report is precise and the orphan-sidecar
      // pass above reclaims the residue on the next run.
      try {
        rmSync(verdictPathFor(item.backup.path), { force: true })
      } catch (err) {
        strandedSidecars.push({ item, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { items, deleted, failed, strandedSidecars, orphanSidecars, freedBytes }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`
}
