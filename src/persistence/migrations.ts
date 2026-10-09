/**
 * Forward-only, per-migration classified migration runner.
 *
 * - Additive migrations auto-apply in a normal transaction.
 * - Destructive migrations back the store up, then apply under an
 *   exclusive lock, then VACUUM. Only an explicit opts.migrate=false
 *   (read-only opens) refuses.
 *
 * See planning/04-persistence-and-schemas.md for the behavior table.
 */

import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import type { Database } from './database.js'
import { writeVerdict, type Verdict } from './backup-verdict.js'
import {
  SchemaVersionError,
  MigrationRequiredError,
  StoreBusyError,
} from '../errors/index.js'
import { migrations, maxSupportedVersion } from './migrations/index.js'
import { SCHEMA_SQL } from './schema.js'
import { dbg, warn } from '../debug.js'

export type MigrationKind = 'additive' | 'destructive'

export interface Migration {
  version: number
  kind: MigrationKind
  description: string
  /**
   * When true, the runner will NOT wrap `up()` in a transaction and will
   * leave FK enforcement off for the duration. Migrations that need to
   * rebuild a referenced table (SQLite's 12-step ALTER recipe) must use
   * this — `PRAGMA foreign_keys` cannot toggle inside a transaction, and
   * `ON DELETE CASCADE` actions still fire even with `defer_foreign_keys`.
   * The migration is responsible for its own atomicity when set.
   */
  manualTransaction?: boolean
  up(db: Database): void
}

export interface MigrationOptions {
  /** Opt-in flag for destructive migrations. */
  migrate?: boolean
}

export interface MigrationReport {
  from: number
  to: number
  applied: Array<{ version: number; description: string; kind: MigrationKind }>
  /**
   * Where the pre-migration store was copied before a destructive migration
   * ran. Absent when nothing destructive was pending, or when the store has
   * no file to copy (in-memory).
   */
  backupPath?: string
  /**
   * Completion-comparison verdict recorded for that backup while backup
   * and migrated store were still twins. Absent when no backup was taken,
   * when the run kept an earlier attempt's backup (not this run's twin —
   * no comparison is honest), or when either side could not be counted —
   * the sidecar is then not written and the backup carries "no migration
   * verdict".
   */
  verdict?: Verdict
}

/**
 * Compare the backup against the just-migrated store and record the
 * verdict in the backup's sidecar. Runs at migration completion, under the
 * open that ran the ladder (design: tests/server/design/verdict-record.md).
 *
 * CONTAINMENT, not equality (D256, review 2026-10-08): the verdict is
 * success when every `node_id` the backup holds is present in the
 * migrated store and the migrated count is at least the backup's. An
 * additive batch takes no exclusive lock, so a writer active between the
 * `VACUUM INTO` and this comparison adds rows — equality read that as a
 * failure, and the advice to restore the backup would have lost every row
 * written in the window. No ladder migration deletes `nodes` rows
 * (verified 2026-08-06); a future one that legitimately prunes must carry
 * its own expected-loss adjustment rather than loosen this check.
 *
 * Never throws: a store that migrated correctly must not fail to open
 * because its verdict could not be recorded. Degradation is "no verdict"
 * (sweep refuses, doctor labels), never a guess.
 */
export function recordCompletionVerdict(db: Database, backupPath: string, from: number): Verdict | undefined {
  let backupIds: string[]
  try {
    const requireNode = createRequire(import.meta.url)
    const BetterSqlite3 = requireNode('better-sqlite3') as typeof import('better-sqlite3')
    const bak = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true })
    try {
      backupIds = (bak.prepare('SELECT node_id FROM nodes').all() as Array<{ node_id: unknown }>).map((r) => String(r.node_id))
    } finally {
      bak.close()
    }
  } catch (err) {
    dbg('migration', 'verdict NOT recorded — backup could not be read', {
      backupPath, error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  const backupEntries = backupIds.length
  let migratedEntries: number
  let missing = 0
  try {
    migratedEntries = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c
    const present = db.prepare('SELECT 1 AS p FROM nodes WHERE node_id = ?')
    for (const id of backupIds) if (present.get(id) === undefined) missing++
  } catch (err) {
    dbg('migration', 'verdict NOT recorded — migrated store could not be read', {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }

  const verdict: Verdict = missing === 0 && migratedEntries >= backupEntries ? 'success' : 'failed'
  try {
    writeVerdict(backupPath, {
      version: 1, verdict, backupEntries, migratedEntries,
      ...(missing > 0 ? { missingEntries: missing } : {}),
      from, to: maxSupportedVersion, recordedAt: Math.floor(Date.now() / 1000),
    })
  } catch (err) {
    dbg('migration', 'verdict NOT recorded — sidecar write failed', {
      backupPath, error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }

  if (verdict === 'failed') {
    // Loud, at migration time, naming the intact copy. The advice is to
    // recover the MISSING entries from it, never to copy it over the live
    // store wholesale: rows written since the migration began are in the
    // live store only, and a wholesale restore would lose them.
    warn(
      `[treecontext] MIGRATION VERIFICATION FAILED: ${missing} of the backup's ${backupEntries} ` +
        `entries are missing from the migrated store (which holds ${migratedEntries}). The intact ` +
        `pre-migration copy is ${backupPath} — restore the missing entries from it by ` +
        `exporting them from a copy of it and importing that file; copy it over treecontext.db ` +
        `only if nothing has been written since the migration began, or those writes are lost.`,
    )
  }
  dbg('migration', 'completion verdict recorded', { backupPath, verdict, backupEntries, migratedEntries, missing })
  return verdict
}

/** True if `err` looks like a SQLITE_BUSY / SQLITE_LOCKED error. */
function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code ?? ''
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(code + ' ' + err.message)
}

export function currentSchemaVersion(db: Database): number {
  const raw = db.pragma('user_version')
  if (typeof raw === 'number') return raw
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as { user_version?: number } | number
    if (typeof first === 'number') return first
    if (first && typeof first === 'object' && typeof first.user_version === 'number') {
      return first.user_version
    }
  }
  return 0
}

/**
 * Run all pending migrations.
 *
 * - Throws SchemaVersionError if the store is newer than this build.
 * - Throws MigrationRequiredError if ANY migration is pending and the
 *   caller explicitly opted OUT (`opts.migrate === false`, which is what
 *   a read-only open passes). Otherwise the store is copied aside, the
 *   full ladder runs, and the freed pages are VACUUMed back.
 * - Throws StoreBusyError whenever another process's lock blocks the
 *   run — destructive batches behind `BEGIN EXCLUSIVE`, additive
 *   batches behind `BEGIN IMMEDIATE`, and manual-transaction
 *   migrations alike. Every caller that migrates on open must be
 *   prepared to surface it (retry guidance, not an internal error).
 * - Wraps additive-only runs in `BEGIN IMMEDIATE TRANSACTION` (the
 *   batch reads user_version and writes schema — the write lock is
 *   taken at BEGIN so contention waits under busy_timeout), and
 *   destructive runs in `BEGIN EXCLUSIVE TRANSACTION`.
 */
/**
 * Apply the base schema to a BRAND-NEW database — version 0 AND an
 * empty sqlite_master, decided and applied under one immediate
 * transaction. Returns true when this call created the schema.
 *
 * The ONE definition of "fresh" (pass-2 review 2026-08-15): the serve
 * path and Persistence.openLexical previously carried divergent
 * guards — openLexical's version-0-only check would have stamped
 * `user_version = 5` onto a genuine v0-era store WITH data, silently
 * skipping migrations 1–5's data transforms; and the serve path's
 * unguarded exec let a second concurrent starter's trailing
 * `PRAGMA user_version = 5` land AFTER the first starter's ladder
 * reached the max, downgrading the recorded version. The transaction
 * closes the race (the loser re-checks under the write lock and
 * no-ops); the sqlite_master check protects the v0-era store.
 */
export function ensureBaseSchema(db: Database): boolean {
  if (currentSchemaVersion(db) !== 0) return false
  let applied = false
  db.transaction(() => {
    if (currentSchemaVersion(db) !== 0) return
    const tables = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'")
      .get() as { c: number }
    if (tables.c !== 0) return // genuine v0-era store with data: the ladder's job
    db.exec(SCHEMA_SQL)
    applied = true
  })
  return applied
}

export function runMigrations(
  db: Database,
  opts: MigrationOptions = {},
): MigrationReport {
  const current = currentSchemaVersion(db)
  dbg('migration', 'schema check', { current, max: maxSupportedVersion })

  if (current > maxSupportedVersion) {
    throw new SchemaVersionError(
      `Store schema version ${current} is newer than this build's max ${maxSupportedVersion}. ` +
        'Upgrade treecontext to open this store.',
    )
  }
  if (current === maxSupportedVersion) {
    dbg('migration', 'schema up to date')
    return { from: current, to: current, applied: [] }
  }

  const pending = migrations.filter((m) => m.version > current)
  const destructive = pending.filter((m) => m.kind === 'destructive')
  dbg('migration', 'pending migrations', { count: pending.length, destructive: destructive.length })

  // Owner ruling 2026-08-05: with the store copied aside first, go all the
  // way to the current schema and reclaim the space — "it's tidy, up to date,
  // restores disk space, and you can always go back to the backup."
  //
  // So a pending destructive migration no longer blocks by default. It used
  // to require opts.migrate===true, which had two costs. It gated every
  // pending ADDITIVE migration alongside it, and because #19 is the newest
  // migration there is no version below current whose pending set is
  // additive-only — so no real store could reach the current schema without
  // an opt-in the library API never advertised. `serve` passed the flag, so
  // this was invisible on the normal path and total for everyone else.
  //
  // What still refuses is an EXPLICIT opt-out (migrate === false), which is
  // what a read-only open passes: it cannot write, so the honest failure is
  // "migrations pending" rather than a half-applied ladder.
  //
  // The opt-out covers ADDITIVE migrations too (program-C review, finding
  // 1): the destructive-only gate let a pending additive ladder run over a
  // readonly connection — migration 020 was the first additive migration
  // to sit newest on the ladder since the gate was written, and every
  // read-only open of a v19 store died mid-ALTER with SQLITE_READONLY
  // instead of the promised clean refusal. An opt-out is an opt-out.
  if (pending.length > 0 && opts.migrate === false) {
    if (destructive.length === 0) {
      dbg('migration', 'BLOCKED: migrations pending and the caller opted out', {
        current,
        target: maxSupportedVersion,
        blockedBy: pending.map((m) => m.version),
      })
      throw new MigrationRequiredError(
        `Store at version ${current} has pending migration(s) to reach ${maxSupportedVersion}: ` +
          pending.map((m) => `#${m.version} ${m.description}`).join('; ') +
          '. This open passed { migrate: false } (a read-only open cannot ' +
          'migrate); re-open writable to apply.',
      )
    }
    // Log the refusal, not just the intent. This gate is reached during
    // server startup, where the throw becomes a bare "Connection closed"
    // at the host; without this line the log simply stopped after
    // "pending migrations" and gave a reader nothing to go on.
    dbg('migration', 'BLOCKED: destructive migration pending and the caller opted out', {
      current,
      target: maxSupportedVersion,
      blockedBy: destructive.map((m) => m.version),
    })
    throw new MigrationRequiredError(
      `Store at version ${current} requires destructive migration(s) to reach ${maxSupportedVersion}: ` +
        destructive.map((m) => `#${m.version} ${m.description}`).join('; ') +
        '. This open passed { migrate: false } (a read-only open cannot ' +
        'migrate); re-open writable to apply — the store is copied to ' +
        `<store>.pre-migration-v${current}.bak first.`,
    )
  }

  const applied: MigrationReport['applied'] = []
  const useExclusive = destructive.length > 0

  // The store is copied aside before any pending migration starts. A
  // destructive one cannot be undone by re-running anything; an additive
  // one rewrites schema the older build reads, and the owner's rule makes
  // no distinction (D59, D256).
  // Owner ruling 2026-08-05: back the legacy store up, then migrate — chosen
  // over export-and-reimport, which would round-trip every row through the
  // journal format and stand up a second store to achieve the same thing.
  //
  // The copy is taken BEFORE `BEGIN EXCLUSIVE`: `wal_checkpoint` cannot run
  // inside a transaction, and without the checkpoint the copy would miss
  // everything still sitting in the -wal file — a backup that silently omits
  // the most recent writes is worse than none, because it looks complete.
  //
  // An existing backup is never overwritten. If one is here, a previous
  // attempt at this same migration did not finish, and the file it left is
  // the pre-migration store; replacing it with today's possibly
  // half-migrated state would destroy the only good copy.
  // The backup is `VACUUM INTO` (pass-3 review 2026-08-15, replacing
  // two generations of copy mechanics): a transactionally consistent
  // page-level snapshot taken under SQLite's own read transaction —
  // immune to a concurrent migrator's checkpoints writing the main
  // file mid-copy (which tore the checkpoint+copyFileSync approach:
  // "concurrent writes land in the -wal file" is false for
  // checkpoints), reads through the WAL so nothing committed is
  // missed, and refuses an existing destination, which is the
  // COPYFILE_EXCL serialization for free: a concurrent starter's
  // already-exists failure collapses into the already-ruled
  // kept-earlier-backup semantics (no verdict, doctor labels it, the
  // retry rule). The snapshot is compacted as a side effect; the
  // verdict compares row counts, not bytes.
  let backupPath: string | undefined
  let backupTakenThisRun = false
  // EVERY pending migration runs behind the copy, additive included (D59,
  // restated by the owner 2026-10-08, D256: "the goal is to always have a
  // backup before any migration or schema update"). The copy used to be
  // taken only ahead of a destructive step, so the additive 025-027 ran
  // bare on every store that crossed them — the gap the ruling names an
  // oversight, not a policy. An in-memory database has no path to copy
  // beside and is the one exemption.
  if (pending.length > 0 && db.path) {
    backupPath = `${db.path}.pre-migration-v${current}.bak`
    if (existsSync(backupPath)) {
      dbg('migration', 'backup already exists — keeping the earlier one', { backupPath })
    } else {
      try {
        db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
        // SQLite creates the destination with its own default file
        // permissions; the backup is the pre-migration journal and lands
        // private like every other regular file under ~/.treecontext
        // (docs/security.md §3). Mode applies on create — an earlier
        // run's backup keeps the mode it was minted with.
        try { chmodSync(backupPath, 0o600) } catch { /* best-effort */ }
        backupTakenThisRun = true
        dbg('migration', 'backed up before migrating', {
          backupPath, from: current, to: maxSupportedVersion,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/output file already exists|already exists/i.test(msg) || existsSync(backupPath)) {
          // A concurrent starter snapshotted first — its file is the
          // pre-migration state; keep it, exactly as if it had existed
          // at the existsSync above.
          dbg('migration', 'concurrent starter took the backup — keeping theirs', { backupPath })
        } else if (isBusyError(err)) {
          throw new StoreBusyError(
            'Cannot back up before migrating: another process is using the store. ' +
              'Close all other treecontext instances and retry.',
            { cause: err },
          )
        } else {
          throw err
        }
      }
    }
  }

  // Process pending migrations in order, batching consecutive
  // auto-transaction migrations into a single BEGIN/COMMIT and running
  // manualTransaction migrations on their own (with FK off, outside any
  // enclosing txn).
  let i = 0
  while (i < pending.length) {
    const m = pending[i]!
    if (m.manualTransaction) {
      // Same concurrent-ladder skip as the batched path below — checked
      // lock-free here (the migration owns its own atomicity), which
      // narrows the race without claiming to close it.
      if (currentSchemaVersion(db) >= m.version) {
        dbg('migration', 'skipping — already applied by a concurrent process', { version: m.version })
        i++
        continue
      }
      // Migration owns its own atomicity. PRAGMA foreign_keys cannot
      // toggle inside a transaction, so we flip it here.
      const fkPrev = db.pragma('foreign_keys')
      const fkOn =
        typeof fkPrev === 'number'
          ? fkPrev === 1
          : Array.isArray(fkPrev) && fkPrev.length > 0
            ? ((fkPrev[0] as { foreign_keys?: number })?.foreign_keys ?? 0) === 1
            : true
      if (fkOn) db.pragma('foreign_keys = OFF')
      try {
        m.up(db)
        db.pragma('user_version', m.version)
      } catch (err) {
        // Manual migrations run outside the batch transaction below, so
        // they need their own busy → StoreBusyError conversion.
        if (isBusyError(err)) {
          throw new StoreBusyError(
            'Cannot run migration: another process is using the store. ' +
              'Close all other treecontext instances and retry.',
            { cause: err },
          )
        }
        throw err
      } finally {
        if (fkOn) db.pragma('foreign_keys = ON')
      }
      applied.push({ version: m.version, description: m.description, kind: m.kind })
      i++
      continue
    }

    // Collect a batch of auto-transaction migrations.
    const batch: Migration[] = []
    while (i < pending.length && !pending[i]!.manualTransaction) {
      batch.push(pending[i]!)
      i++
    }

    const batchDestructive = batch.some((x) => x.kind === 'destructive')
    const exclusive = useExclusive || batchDestructive
    try {
      if (exclusive) {
        db.exec('BEGIN EXCLUSIVE TRANSACTION')
      } else {
        // Immediate, not deferred: the batch reads user_version and writes
        // schema — a read-then-write that must take the write lock at BEGIN
        // so contention waits under busy_timeout instead of failing with
        // SQLITE_BUSY_SNAPSHOT mid-batch.
        db.exec('BEGIN IMMEDIATE TRANSACTION')
      }
    } catch (err) {
      dbg('migration', 'FAILED to open migration transaction', {
        exclusive,
        batch: batch.map((x) => x.version),
        error: err instanceof Error ? err.message : String(err),
      })
      if (isBusyError(err)) {
        throw new StoreBusyError(
          exclusive
            ? 'Cannot run destructive migration: another process has the store open. ' +
              'Close all other treecontext instances and retry.'
            : 'Cannot run migration: another process is writing to the store. ' +
              'Retry when it is idle.',
          { cause: err },
        )
      }
      throw err
    }

    try {
      // `pending` was computed before this BEGIN, and two same-store
      // servers starting together are a supported shape: re-read the
      // version UNDER the write lock and skip whatever a concurrent
      // ladder already applied — the alternative was silently replaying
      // a whole-store backfill pass (release-diff review 2026-08-15).
      const versionInTxn = currentSchemaVersion(db)
      for (const bm of batch) {
        if (bm.version <= versionInTxn) {
          dbg('migration', 'skipping — already applied by a concurrent process', { version: bm.version })
          continue
        }
        dbg('migration', 'applying', { version: bm.version, kind: bm.kind, description: bm.description })
        bm.up(db)
        db.pragma('user_version', bm.version)
        applied.push({ version: bm.version, description: bm.description, kind: bm.kind })
      }
      db.exec('COMMIT')
    } catch (err) {
      dbg('migration', 'FAILED mid-batch — rolling back', {
        applied: applied.map((x) => x.version),
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        db.exec('ROLLBACK')
      } catch {
        /* swallow — if the transaction is already gone, nothing to roll back */
      }
      throw err
    }
  }

  // Verdict at completion, while backup and store are twins — under the
  // same open that ran the ladder, before any other writer can touch
  // either side, and before the VACUUM below: VACUUM never changes the
  // row count but can run for minutes on a large store, and a crash in
  // that window must not cost the verdict.
  //
  // Only a backup copied THIS run is the migrated store's twin. A kept
  // earlier backup is a previous attempt's pre-migration state; judging it
  // against today's store compares strangers, and a false 'failed' verdict
  // advises restoring a stale copy — following that advice IS data loss.
  // The kept backup stays at "no migration verdict" (sweep refuses, doctor
  // labels), the design note's honest degradation.
  let verdict: Verdict | undefined
  // Any applied migration, additive included: the backup was taken for
  // the whole pending set, and no ladder migration deletes nodes rows, so
  // the count comparison is as honest after an additive run as after a
  // destructive one — and the sweep reclaims only what carries a verdict.
  if (backupPath && applied.length > 0) {
    if (backupTakenThisRun) {
      verdict = recordCompletionVerdict(db, backupPath, current)
    } else {
      dbg('migration', "verdict NOT recorded — kept backup from an earlier attempt is not this run's twin", {
        backupPath,
      })
    }
  }

  // Reclaim what the destructive migrations freed. Dropping a table returns
  // its pages to SQLite's freelist; it does NOT shrink the file, so without
  // this the migration classified as reclaiming space reclaims none of it —
  // 65% of the pre-19 stores measured on the owner's machine was dead-table
  // pages that a drop alone would have left exactly where they were.
  //
  // VACUUM cannot run inside a transaction, which is why it is here and not
  // in migration 019's own body (019 is batched with the auto-transaction
  // migrations). Failure is logged and swallowed: the schema is already
  // correct at this point and the rows are safe, so refusing to open a
  // perfectly good store because it could not be compacted would trade a
  // working journal for a tidy one.
  if (applied.some((a) => a.kind === 'destructive')) {
    try {
      db.exec('VACUUM')
      db.pragma('wal_checkpoint(TRUNCATE)')
      dbg('migration', 'vacuumed after destructive migration', { from: current })
    } catch (err) {
      dbg('migration', 'VACUUM failed — schema is current, space not reclaimed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Terminal line: every run now ends in either 'complete' or a FAILED/
  // BLOCKED record above, so a log that stops after 'pending migrations'
  // is unambiguous evidence the process died inside this function.
  dbg('migration', 'complete', { from: current, to: maxSupportedVersion, applied: applied.length })
  return {
    from: current, to: maxSupportedVersion, applied,
    ...(backupPath ? { backupPath } : {}),
    ...(verdict ? { verdict } : {}),
  }
}
