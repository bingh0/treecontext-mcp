/**
 * `treecontext stores merge <src> <dst>` — Part 3 of the identity
 * program (docs/project-identity.md §5, §5.1–§5.3, §11c).
 *
 * Two journals for one project is the defect this repairs. The merge
 * itself is NOT written here: §5's whole point is that
 * `FlatStore.mergeFromNamespace` already IS the operation minus a
 * cross-store reader, so this module is preconditions, disclosure, and
 * the ATTACH — the copy body stays the reviewed one.
 *
 * Every precondition fails CLOSED with its own message (§5.2). The one
 * that is a lock and not a check is the drain lease (A4): the merge
 * TAKES it on the destination and holds it for the duration, because a
 * check-then-merge would invite a hook to acquire in between.
 */
import { existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, resolve as resolvePath, dirname, sep } from 'node:path'
import { hostname } from 'node:os'
import { createRequire } from 'node:module'

import { isCliAddressableStoreName } from './store-name.js'
import { MERGE_SRC_ALIAS, mergeTotals, type NamespaceCounts } from '../persistence/merge-source.js'
import { StoreLockedError } from '../errors/index.js'

const requireNode = createRequire(import.meta.url)

/** The store database file inside a store directory. */
export const STORE_DB_FILE = 'treecontext.db'

/** Backups this command takes. Deliberately NOT the
 *  `pre-migration-vN.bak` shape: the sweep reclaims those by verdict,
 *  and a merge backup has no migration verdict to earn one. */
export const MERGE_BACKUP_PREFIX = `${STORE_DB_FILE}.pre-merge-`
const MERGE_BACKUP_SUFFIX = '.bak'

/** Any backup file this project writes beside a store — the freshness
 *  check accepts a migration backup from today just as happily as one of
 *  ours; both are a copy the user can go back to. */
const ANY_BACKUP_RE = new RegExp(`^${STORE_DB_FILE.replace('.', '\\.')}\\..+\\.bak$`)

export interface MergeStoresOptions {
  src: string
  dst: string
  storesDir: string
  /** Take fresh backups of BOTH stores before merging (R6). */
  backup: boolean
  /** The destructive-op gate every other `stores` subcommand uses. */
  yes: boolean
  /** Repoint bindings naming `src` at `dst` after a successful merge. */
  repoint: boolean
  /** Where disclosure goes. The CLI passes its `[treecontext] ` logger. */
  log: (msg: string) => void
  /** Injected for the corpus; defaults to the real bindings writer.
   *  `health` distinguishes a clean read (ok/absent) from a read that
   *  FAILED (corrupt/unreadable/symlink) so the CLI can warn instead of
   *  claiming there was nothing to repoint (B4). */
  repointBindings?: (from: string, to: string) => { changed: number; persisted: boolean; health?: string }
  /** Injected for the corpus; defaults to the shipped Online Backup path. */
  backupStore?: (srcDbPath: string, dstPath: string) => Promise<void>
  /** Counts bindings naming `src`, for the without-`--repoint` next step. */
  countBindings?: (store: string) => number
}

export type MergeStoresOutcome =
  /** A precondition said no. `message` is the whole reason. */
  | { status: 'refused'; message: string }
  /** Preconditions passed, `--yes` was absent: nothing was written. */
  | { status: 'preview' }
  | { status: 'merged'; perNamespace: NamespaceCounts[]; repointed: number | null }

/** Local calendar day of a timestamp, as YYYY-MM-DD. */
function dayOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * B2: a file only counts as a backup if it OPENS as a database, passes
 * `PRAGMA quick_check` (first row 'ok'), and carries a `nodes` table.
 * Filename + mtime alone accepted a 0-byte file, arbitrary garbage, or a
 * directory named `*.bak` — none of which is a store the user could go
 * back to. Returns the node count on success (used by the take-path
 * verification), or null when the file is not a usable backup.
 */
export function backupNodeCount(path: string): number | null {
  const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
  let db: import('better-sqlite3').Database
  try {
    db = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    const verdict = check ? String(Object.values(check)[0]) : ''
    if (verdict !== 'ok') return null
    const hasNodes = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'")
      .get()
    if (hasNodes === undefined) return null
    return (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** True when the store directory holds a backup taken today (§11c) that is
 *  a real, openable store — not merely a file with the right name and
 *  mtime (B2). */
export function hasBackupFromToday(storeDir: string, now = Date.now()): boolean {
  let names: string[]
  try { names = readdirSync(storeDir) } catch { return false }
  const today = dayOf(now)
  for (const name of names) {
    if (!ANY_BACKUP_RE.test(name)) continue
    const full = join(storeDir, name)
    try {
      if (dayOf(statSync(full).mtimeMs) !== today) continue
    } catch { continue /* vanished under us: not a backup we can promise */ }
    if (backupNodeCount(full) !== null) return true
  }
  return false
}

/** The backup filename for this run — second resolution plus the pid, so
 *  two merges in one second cannot collide on a destination the shipped
 *  backup path refuses to overwrite. */
export function mergeBackupName(now = Date.now(), pid = process.pid): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${pid}`
  return `${MERGE_BACKUP_PREFIX}${stamp}${MERGE_BACKUP_SUFFIX}`
}

/**
 * S9: the name must be one the CLI can address AND must land directly
 * inside the stores root. The addressability predicate already refuses
 * separators, `.`, `..` and leading dashes; the containment check is the
 * belt to its braces, and it is what makes "inside the stores root" a
 * fact about the resolved path rather than about the spelling.
 *
 * M3: spelling is not enough. A store DIRECTORY that is itself a symlink
 * pointing outside the root passes every lexical check — so when the
 * directory exists it is realpath'd (as `removeStore` does) and the
 * containment is re-asserted against the resolved real path. `realDir`
 * rides back so the self-merge check can compare real paths too: an
 * `alias -> real` symlink self-merge would otherwise pass the `src !== dst`
 * string test, report a no-op as merged, and advise `stores rm alias`,
 * which deletes the real target.
 */
export function resolveStoreDir(
  storesDir: string, name: string, role: 'source' | 'destination',
): { dir: string; realDir: string } | { refusal: string } {
  const root = resolvePath(storesDir)
  if (!isCliAddressableStoreName(name)) {
    return {
      refusal: `stores merge refuses the ${role} store '${name}': a store name must be CLI-addressable `
        + '([A-Za-z0-9._-]+, and not ".", ".." or a leading "-") and must resolve directly inside the '
        + `stores root ${root}`,
    }
  }
  const dir = resolvePath(root, name)
  if (dirname(dir) !== root) {
    return {
      refusal: `stores merge refuses the ${role} store '${name}': it does not resolve directly inside the `
        + `stores root ${root}`,
    }
  }
  // Realpath containment (mirrors removeStore). When the directory does
  // not yet resolve — an absent store — the lexical check above stands and
  // the later existence check produces the right "no store" message; a
  // realpath crash here must not mask it.
  let realDir = dir
  try {
    realDir = realpathSync(dir)
  } catch {
    return { dir, realDir: dir }
  }
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch { /* root missing: dir realpath already stands */ }
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    return {
      refusal: `stores merge refuses the ${role} store '${name}': it resolves through a symlink to `
        + `${realDir}, outside the stores root ${realRoot}`,
    }
  }
  return { dir, realDir }
}

/**
 * A no-migrate version probe (§5.2/§11c): a READ-ONLY handle and one
 * `PRAGMA user_version`. Deliberately not `Persistence.openLexical` and
 * not the wrapped `Database` — both would apply pragmas or run the
 * ladder, and refusing to migrate a store the user did not name is the
 * entire point of the check.
 */
export function probeSchemaVersion(dbPath: string): number {
  const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    return Number(db.pragma('user_version', { simple: true }))
  } finally {
    db.close()
  }
}

/** A10: `total_nodes == leaf_nodes` is an observation about today's
 *  stores, not a schema guarantee, and the copy loop hardcodes
 *  `parentId: null, depth: 0`. H6: `depth` is part of that hardcoding too,
 *  so a row at depth != 0 is as much a silent flattening as a parented
 *  one, and the refusal that claims to guard flatness must see it. Read on
 *  a read-only handle. */
export function probeFlatness(dbPath: string): { total: number; leaves: number; parented: number; depthed: number } {
  const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS total, '
      + 'SUM(CASE WHEN is_leaf = 1 THEN 1 ELSE 0 END) AS leaves, '
      + 'SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) AS parented, '
      + 'SUM(CASE WHEN depth IS NOT NULL AND depth <> 0 THEN 1 ELSE 0 END) AS depthed FROM nodes',
    ).get() as { total: number; leaves: number | null; parented: number | null; depthed: number | null }
    return {
      total: row.total, leaves: row.leaves ?? 0, parented: row.parented ?? 0, depthed: row.depthed ?? 0,
    }
  } finally {
    db.close()
  }
}

/**
 * B1: unprocessed rows still sitting in the SOURCE's staging table. The
 * copy body reads only `nodes`, so an undrained backlog is data the merge
 * would leave behind while the CLI tells the operator the source is safe
 * to remove. Read on a read-only handle; a source with no `staging` table
 * (a shape that never staged) owes nothing.
 */
export function probeUndrainedStaging(dbPath: string): number {
  const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    if (has === undefined) return 0
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM staging WHERE processed = 0')
      .get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

/** One namespace's disclosure line (§5.3). Every skip class is named, so
 *  the six categories plus `srcTotal` reconcile exactly (H1/H2/H5). */
export function countsLine(c: NamespaceCounts): string {
  return `namespace ${c.namespace}: ${c.imported} imported, ${c.skippedDuplicate} skipped as duplicate, `
    + `${c.skippedExistingId} skipped as already present, ${c.skippedIdConflict} skipped as id conflict, `
    + `${c.skippedUndecodable} skipped as undecodable, ${c.skippedEmpty} skipped as empty, `
    + `${c.srcTotal} in source`
}

export async function mergeStores(opts: MergeStoresOptions): Promise<MergeStoresOutcome> {
  const { src, dst, storesDir, log } = opts

  // ── S9 + self-merge ───────────────────────────────────────────────
  const srcResolved = resolveStoreDir(storesDir, src, 'source')
  if ('refusal' in srcResolved) return { status: 'refused', message: srcResolved.refusal }
  const dstResolved = resolveStoreDir(storesDir, dst, 'destination')
  if ('refusal' in dstResolved) return { status: 'refused', message: dstResolved.refusal }
  if (src === dst) {
    return {
      status: 'refused',
      message: `stores merge refuses to merge a store into itself: '${src}' is both source and destination`,
    }
  }
  // M3: the string check catches `merge proj proj`; the real-path check
  // catches `merge alias real` where `alias` is a symlink to `real`'s
  // directory — a no-op that would otherwise report as merged and advise
  // deleting the alias, which unlinks the real target.
  if (srcResolved.realDir === dstResolved.realDir) {
    return {
      status: 'refused',
      message: `stores merge refuses to merge a store into itself: '${src}' and '${dst}' resolve to the `
        + `same directory ${srcResolved.realDir}`,
    }
  }
  const srcDir = srcResolved.dir
  const dstDir = dstResolved.dir
  const srcDbPath = join(srcDir, STORE_DB_FILE)
  const dstDbPath = join(dstDir, STORE_DB_FILE)
  if (!existsSync(srcDbPath)) {
    return { status: 'refused', message: `stores merge found no source store at ${srcDbPath}` }
  }
  if (!existsSync(dstDbPath)) {
    return { status: 'refused', message: `stores merge found no destination store at ${dstDbPath}` }
  }

  // ── Schema versions, probed without migrating ─────────────────────
  const { maxSupportedVersion } = await import('../persistence/migrations/index.js')
  for (const [name, path] of [[src, srcDbPath], [dst, dstDbPath]] as const) {
    let version: number
    try {
      version = probeSchemaVersion(path)
    } catch (err) {
      return {
        status: 'refused',
        message: `stores merge could not read the schema version of ${name} at ${path}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (version !== maxSupportedVersion) {
      return {
        status: 'refused',
        message: `stores merge refuses a schema-version mismatch: ${name} is at schema version ${version}, `
          + `this build's maximum is ${maxSupportedVersion}. Open ${name} once with a normal command so it `
          + 'migrates under its own backup, then re-run the merge.',
      }
    }
  }

  // ── A10 / H6: flatness is a precondition, not an assumption ────────
  let flat: { total: number; leaves: number; parented: number; depthed: number }
  try {
    flat = probeFlatness(srcDbPath)
  } catch (err) {
    return {
      status: 'refused',
      message: `stores merge could not read the source store ${src}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (flat.total !== flat.leaves || flat.parented > 0 || flat.depthed > 0) {
    return {
      status: 'refused',
      message: `stores merge refuses a non-flat source: ${src} holds ${flat.total} node(s) of which `
        + `${flat.leaves} are leaves, ${flat.parented} carry a parent, and ${flat.depthed} sit below depth 0. `
        + 'The copy writes every row at depth 0 with no parent, so a tree-era source would be silently flattened.',
    }
  }

  // ── B1: the source's own drain must have finished ─────────────────
  // The copy reads `nodes` only. A source with rows still staged and
  // undrained would have that backlog silently left behind, then the CLI
  // would print "src is untouched — remove it yourself". Refuse, name the
  // count, and send the operator to let the drain finish.
  let undrained: number
  try {
    undrained = probeUndrainedStaging(srcDbPath)
  } catch (err) {
    return {
      status: 'refused',
      message: `stores merge could not read the source store ${src}'s staging backlog: `
        + `${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (undrained > 0) {
    return {
      status: 'refused',
      message: `stores merge refuses ${src}: ${undrained} event(s) are still staged and undrained in the `
        + 'source. The copy reads only committed entries, so those events would be left behind while the '
        + `source looked safe to remove. Open ${src} with a normal command (or wait for its drain) so the `
        + 'backlog lands, then re-run the merge.',
    }
  }

  // ── R6: a backup of both, or take them ────────────────────────────
  if (!opts.backup) {
    const missing = ([[src, srcDir], [dst, dstDir]] as const)
      .filter(([, dir]) => !hasBackupFromToday(dir))
      .map(([name]) => name)
    if (missing.length > 0) {
      return {
        status: 'refused',
        message: `stores merge requires a backup of both stores from today; ${missing.join(' and ')} `
          + `${missing.length > 1 ? 'have' : 'has'} none. Re-run with --backup to take fresh backups of both.`,
      }
    }
  }

  // ── The destructive-op gate ───────────────────────────────────────
  if (!opts.yes) {
    log(`Would merge every namespace of ${src} into ${dst} (${flat.total} source node(s)).`)
    if (opts.backup) log(`Would first back up both stores beside them as ${MERGE_BACKUP_PREFIX}*${MERGE_BACKUP_SUFFIX}.`)
    log(`${src} would be left intact on disk either way.`)
    log('Re-run with --yes to confirm.')
    return { status: 'preview' }
  }

  // ── Backups (R6), before anything is written ──────────────────────
  if (opts.backup) {
    const take = opts.backupStore
      ?? (async (from: string, to: string): Promise<void> => {
        const { backupStore } = await import('../persistence/backup.js')
        await backupStore(from, to)
      })
    const name = mergeBackupName()
    for (const [store, dbPath, dir] of [[src, srcDbPath, srcDir], [dst, dstDbPath, dstDir]] as const) {
      const target = join(dir, name)
      await take(dbPath, target)
      // B2: a backup this command relied on later must be a real store —
      // verify the file it just wrote opens, passes quick_check, and holds
      // the same node count as the store it copied. A backup that cannot be
      // read is not a backup, and the merge must refuse rather than proceed
      // under a false safety net.
      const backupCount = backupNodeCount(target)
      let sourceCount: number | null = null
      try { sourceCount = probeFlatness(dbPath).total } catch { sourceCount = null }
      if (backupCount === null || backupCount !== sourceCount) {
        return {
          status: 'refused',
          message: `stores merge took a backup of ${store} to ${target} but could not verify it: `
            + `${backupCount === null
              ? 'it does not open as a store with a nodes table (quick_check failed)'
              : `it holds ${backupCount} node(s) but ${store} holds ${sourceCount}`}. `
            + 'Nothing was merged. Check the disk and re-run.',
        }
      }
      log(`Backed up ${store} to ${target} (verified, ${backupCount} node(s))`)
    }
  }

  // ── A4: TAKE the drain lease on dst, and hold it ──────────────────
  // Taken, not checked: a check-then-merge invites a hook to acquire in
  // the gap. Held for the whole copy and released after.
  //
  // Residual, stated: the copy is one synchronous transaction, so nothing
  // heartbeats the lease while it runs and a merge longer than the TTL
  // would let another process claim the drain role. It cannot cost
  // correctness — that claimant's writes block on the write lock this
  // transaction already holds — so the cost is a wasted drain attempt,
  // not a race.
  const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
  const { wrapBetterSqlite } = await import('../persistence/better-sqlite.js')
  const { LeaseClient, DRAIN_LEASE_TTL_SECS } = await import('../persistence/leases.js')
  const { FlatStore } = await import('../flat-store.js')

  const rawDst = new BetterSqlite3(dstDbPath, { fileMustExist: true })
  const dstDb = wrapBetterSqlite(rawDst)
  const leases = new LeaseClient(dstDb, { pid: process.pid, host: hostname(), label: 'stores merge' })
  try {
    leases.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
  } catch (err) {
    dstDb.close()
    if (err instanceof StoreLockedError) {
      return {
        status: 'refused',
        message: `stores merge could not take the drain lease on ${dst}: ${err.message} `
          + 'Stop that process (or wait for its lease to expire) and re-run.',
      }
    }
    throw err
  }

  let perNamespace: NamespaceCounts[]
  try {
    // ATTACH cannot run inside a transaction, so it happens here and the
    // whole copy runs in ONE immediate transaction below. See
    // FlatStore.mergeFromAttachedStore for the A5 read-only finding and
    // for why cross-database atomicity is not required.
    dstDb.prepare(`ATTACH DATABASE ? AS ${MERGE_SRC_ALIAS}`).run(srcDbPath)
    try {
      // No retention options, deliberately (D141 review): this handle can
      // never sweep. The valve runs only from insert()'s amortized counter,
      // open() runs none, and mergeFromAttachedStore copies through
      // copyRowsInto, never insert() — so the config file's budget and cap
      // would have nothing to steer here. The destination's own server
      // sweeps the merged rows by its figures on its next insert. Pinned at
      // the command in tests/server/retention-config.test.ts and at the
      // library in tests/server/stores-merge-internals.test.ts.
      const store = await FlatStore.open({ database: dstDb, ownsDatabase: false })
      const result = store.mergeFromAttachedStore({ label: `store-merge:${src}`, sourceStore: src })
      perNamespace = result.perNamespace
    } finally {
      dstDb.prepare(`DETACH DATABASE ${MERGE_SRC_ALIAS}`).run()
    }
  } finally {
    leases.release('drain')
    dstDb.close()
  }

  // ── Disclosure (§5.3) ─────────────────────────────────────────────
  for (const c of perNamespace) log(countsLine(c))
  const totals = mergeTotals(perNamespace)
  log(
    `Total: ${totals.imported} imported, ${totals.skippedDuplicate} skipped as duplicate, `
    + `${totals.skippedExistingId} skipped as already present, ${totals.skippedIdConflict} skipped as id conflict, `
    + `${totals.skippedUndecodable} skipped as undecodable, ${totals.skippedEmpty} skipped as empty, `
    + `${totals.srcTotal} in source across ${totals.namespaces} namespace(s).`,
  )
  // H1: an id conflict is the one skip that means possible divergence, not
  // idempotence — a different row already wears that node_id in the
  // destination. It must not hide inside a reassuring total.
  if (totals.skippedIdConflict > 0) {
    log(
      `WARNING: ${totals.skippedIdConflict} source row(s) were skipped as an id conflict — the destination `
      + `already holds a DIFFERENT row under that node_id. Nothing was overwritten, but those source entries `
      + `are NOT in ${dst}; inspect them in ${src} before removing it.`,
    )
  }
  // H2: an undecodable source row was skipped rather than crashing the
  // merge. Name it so the operator knows the copy was not total.
  if (totals.skippedUndecodable > 0) {
    log(
      `WARNING: ${totals.skippedUndecodable} source row(s) could not be decoded and were skipped; `
      + `they remain in ${src}.`,
    )
  }
  log(
    `Consistency is guaranteed: ${src} was attached and read inside one immediate transaction. `
    + `Completeness assumes a quiet source — anything written to ${src} while the merge ran is not included.`,
  )

  // ── D5: the source is never deleted ───────────────────────────────
  log(`${src} is untouched on disk. Remove it yourself when you are satisfied: treecontext stores rm ${src} --yes`)

  // ── --repoint ─────────────────────────────────────────────────────
  let repointed: number | null = null
  if (opts.repoint) {
    const repoint = opts.repointBindings
      ?? (await import('../server/bindings.js')).repointBindings
    const { changed, persisted, health } = repoint(src, dst)
    repointed = persisted ? changed : 0
    // B4: a corrupt / unreadable / symlinked bindings file reads as an
    // EMPTY map, which used to be indistinguishable from "read fine, found
    // nothing" — so the CLI reassured the operator the split was collapsed
    // while it could not even see the bindings. The read-failure branch
    // must come first and warn, never claim success.
    if (health !== undefined && health !== 'ok' && health !== 'absent') {
      log(
        `WARNING: bindings.json could not be read (${health}); the repoint could not be verified and no `
        + `binding was moved. Any binding still naming ${src} keeps the split open. Fix the file (doctor `
        + 'diagnoses it) and re-run with --repoint. The merge itself is done.',
      )
    } else if (changed === 0) {
      log(`No binding names ${src}; nothing to repoint.`)
    } else if (persisted) {
      log(`Repointed ${changed} binding(s) from ${src} to ${dst}.`)
    } else {
      log(
        `Could not write bindings.json, so ${changed} binding(s) still name ${src} — `
        + 'fix the file (doctor diagnoses it) and re-run with --repoint. The merge itself is done.',
      )
    }
  } else {
    // The next step is printed whether or not a binding is currently
    // found: a merge without --repoint leaves the split HALF repaired,
    // and the command that finishes it must not be something the user has
    // to go looking for (§11c). The count only chooses the wording.
    const count = opts.countBindings?.(src) ?? await countBindingsNaming(src)
    const command = `treecontext stores merge ${src} ${dst} --repoint --yes`
    log(
      count > 0
        ? `${count} binding(s) still name ${src} — the split is not collapsed until they move. `
          + `Next step: ${command} (the merge itself is idempotent, so the re-run imports nothing).`
        : `No binding currently names ${src}. If one appears, point it at ${dst} with: ${command}`,
    )
  }

  return { status: 'merged', perNamespace, repointed }
}

/** How many bindings name a store — read-only, and tolerant of every way
 *  the file can be unreadable (0 then, which only costs a next-step hint
 *  at the end of an already-successful merge). */
async function countBindingsNaming(store: string): Promise<number> {
  try {
    const { readBindingsSnapshot } = await import('../server/bindings.js')
    return Object.values(readBindingsSnapshot().projects).filter((e) => e.store === store).length
  } catch {
    return 0
  }
}
