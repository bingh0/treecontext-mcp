import * as fs from 'fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync as DatabaseType } from 'node:sqlite'
import { resolveStoreName } from '../server/bindings.js'
import { armStormProofStdio, resolveStorePath } from '../server/cli.js'
import { StagingEntry } from '../persistence/store.js'
import { resolveHookNamespace } from '../session-beacon.js'
import { nsLeaseLiveFor } from '../persistence/leases.js'
import { dirname } from 'node:path'
import { HOOK_CONTEXT_CAP } from '../first-moment.js'
import { recordHookGap } from './gap-ledger.js'
import { hasRegistry, selfOf } from '../persistence/session-registry.js'
import { openNodeSqlite, openRaw, ensureDbFileMode, pragmaValue, setPragma } from '../persistence/node-sqlite.js'
import { ensureBaseSchema, runMigrations } from '../persistence/migrations.js'
import { maxSupportedVersion } from '../persistence/migrations/index.js'
import { hostname } from 'node:os'
import { dbg, enableDebug } from '../debug.js'
import { hookHandle, withHookDeadline, hookDeadlineOf, busySliceUntil, openWriteDeadline, HOOK_BUSY_SLICE_MS, HOOK_DEADLINE_FLOOR_MS } from './hook-deadline.js'

export { withHookDeadline, hookHandle, hookDeadlineOf, narrowHookDeadline, busySliceUntil, isHookBusy, openWriteDeadline, HOOK_BUSY_SLICE_MS, HOOK_DEADLINE_FLOOR_MS } from './hook-deadline.js'

// Auto-enable debug in hook subprocesses when the env var is set.
if (process.env.TREECONTEXT_DEBUG === '1') enableDebug()

// THE hook bootstrap, and therefore where the storm-proofing lives for
// every hook that never enters the CLI's main(). Since the agent
// wrappers landed (7e3f899) they exec dist/hooks/<agent>/<stem>.js
// DIRECTLY — no `<cli> hook <event>`, no main(), no guard — in exactly
// the Electron-family hosts observed abandoning a spawned child's
// stderr. The first diagnostic write (the console.error in writeStaging
// below) then raised EPIPE with no listener, killing the hook
// mid-capture behind a wrapper that reports exit 0: capture lost, and
// silently. Module scope, because every entry point — the reference
// hooks and every hooks/<agent>/ adapter — reaches its main() through
// this module, so the next one inherits the guard by importing at all.
armStormProofStdio()

// ── Layer 2 primitives (journaling hooks) ──────────────────────────

/** A hook's write budget on the store: how long, by the clock, one write
 *  connection's waits may last from its open (a single-open hook's whole
 *  wait). Must stay strictly below the smallest platform hook kill budget
 *  — VS Code registers every hook with timeoutSec: 15 (installer.ts;
 *  Claude Code's own default is 60 s) — because a busy wait blocks the
 *  event loop: a hook killed mid-wait loses its failure diagnostic and its
 *  close(). Wall time, on every OS (2026-11-03): SQLite is only ever handed
 *  a slice of it (HOOK_BUSY_SLICE_MS, hook-deadline.ts), because its busy
 *  handler counts the sleeps it asked for, not the time that passed, and a
 *  loaded macOS runner's oversleeps ran this 7 s to 13.6 s (CI run
 *  41670918705). The bar is the kill minus a second to fail gracefully
 *  (14 s), the same on every OS, and the real hooks against a store
 *  another process holds whole are held to it by
 *  tests/hooks/hook-budget-locked.test.ts. */
export const HOOK_DB_TIMEOUT_MS = 7000

/** When this hook process started, to the millisecond that matters: shared.ts
 *  loads first in every hook. What a later open may still wait is what is
 *  left of HOOK_DB_TIMEOUT_MS from here (hookBudgetLeftMs). */
export const HOOK_STARTED_AT = Date.now()

/** What is left of a hook's write budget, `since` the moment it counts
 *  from (the hook's start by default), never below HOOK_DEADLINE_FLOOR_MS. A second open
 *  inside the hook (the wrapper's pragmas, the journal's open, a staging
 *  write after the door's) gets this, not a fresh budget on top of the
 *  first. */
export function hookBudgetLeftMs(since: number = HOOK_STARTED_AT): number {
  return Math.max(HOOK_DB_TIMEOUT_MS - (Date.now() - since), HOOK_DEADLINE_FLOOR_MS)
}

/** The absolute moment a later phase's waits end: what is left of the
 *  hook's budget (hookBudgetLeftMs), from now. For a phase that follows an
 *  earlier connection already closed (Stop's bookmark ask behind a failed
 *  staging write); a phase opened while one is still open inherits it on
 *  its own (openWriteDeadline). */
export function hookDeadlineLeft(since: number = HOOK_STARTED_AT): number {
  return Date.now() + hookBudgetLeftMs(since)
}

/** The wall-clock budget of the Stop-shaped hooks' PRE-WRITE guard read,
 *  counted from when the guard begins. The Stop hook is the one hook that
 *  opens the store twice (guard, then write),
 *  and its budgets SUM against the platform's kill: giving the
 *  guard the full write budget put the worst case at 16s and turned a
 *  duplicate-capture risk into total capture loss (pass-2 review
 *  2026-08-15). 1s is plenty for a WAL read (readers rarely block at
 *  all), and a lookup that cannot read within it is no evidence (D263), so
 *  it is not cut further: guard+write is 8s, 8.2s with process start. The
 *  sum is pinned in tests/hooks/shared.test.ts and the wall time in
 *  tests/hooks/hook-budget-locked.test.ts. */
export const STOP_GUARD_TIMEOUT_MS = 1000

/** The one place hook code opens the store: a hook handle (hook-deadline.ts)
 *  whose every wait ends at its deadline by the clock, waiting in slices of
 *  HOOK_BUSY_SLICE_MS, plus WAL. Every hook and adapter must open through
 *  here so a budget change cannot miss a site again — including read-only
 *  opens: stop.ts kept a raw
 *  2s open and its stale-recapture guard silently disarmed on exactly
 *  the busy stores the 8s budget was shipped for (release-diff review
 *  2026-08-15). journal_mode is skipped for readonly opens (the pragma
 *  is a write when it changes the mode; WAL is already the store's
 *  recorded mode).
 *
 *  The deadline is one for the whole connection, its open and every
 *  statement after it, never a budget per statement: `HOOK_DB_TIMEOUT_MS`
 *  from the open by default; `timeoutMs` for callers with a budget of their
 *  own counted from the open (the Stop-shaped guard's 1 s, the /clear
 *  read's 1.5 s); `deadlineAt` for a later write phase whose earlier
 *  connection is already closed (hookDeadlineLeft). A write open made while
 *  this process holds another hook write connection never waits past what
 *  is left of that one (openWriteDeadline), whatever it asked for: a
 *  second phase never gets a fresh budget. */
export function openHookDb(dbPath: string, opts?: { readonly?: boolean; timeoutMs?: number; deadlineAt?: number }): DatabaseType {
  const readonly = opts?.readonly ?? false
  const asked = opts?.deadlineAt ?? Date.now() + (opts?.timeoutMs ?? HOOK_DB_TIMEOUT_MS)
  const inherited = readonly ? null : openWriteDeadline()
  const deadlineAt = inherited === null ? asked : Math.min(asked, inherited)
  if (!readonly) {
    // The directory too (release review 2026-09-02, finding 1): the first
    // cut of the issue-#2 fix minted the schema and nothing else, and its
    // scenarios went green only because the two hooks that write a
    // session beacon create the store directory as a side effect.
    // PostToolUse, Stop, PreCompact and every non-Claude adapter open
    // through this same door with no beacon in front of them, and lost
    // their first event exactly as before. Best-effort: a directory that
    // cannot be made is reported by the open below, in the open's words.
    try {
      fs.mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    } catch { /* the open reports it */ }
  }
  // SQLite is handed a slice, never the budget; the handle's loop counts
  // the budget by the clock. The pragmas below (journal_mode = WAL can be
  // busy) run through the same loop.
  const raw = openRaw(dbPath, { timeoutMs: HOOK_BUSY_SLICE_MS, readOnly: readonly })
  const db = hookHandle(raw, deadlineAt, { write: !readonly })
  try {
    if (!readonly) {
      setPragma(db, 'journal_mode = WAL')
      // FULL on purpose (D278): a hook is a short-lived writer of one event
      // and its row must be on disk when the process exits. node:sqlite's
      // default happens to be FULL; pinned here so the hooks never inherit
      // a driver default they did not choose.
      setPragma(db, 'synchronous = FULL')
      bootstrapFreshStore(db, dbPath, deadlineAt)
    }
  } catch (err) {
    // The handle this open made is its to close on the way out.
    try { db.close() } catch { /* already gone */ }
    throw err
  }
  return db
}

/** The bootstrap's share of a hook's budget, by the clock from the moment
 *  it begins. The base schema and the
 *  ladder on a fresh store take tens of milliseconds; this cap only bites
 *  when another starter holds the store mid-ladder, and then the staging
 *  write behind it still needs its turn INSIDE the same HOOK_DB_TIMEOUT_MS
 *  — the two phases share the budget, they never stack (release review
 *  2026-09-02, finding 2: stacked, the worst case measured 16s against
 *  the platform's 10s kill, the exact regression the Stop guard's 1s was
 *  hired to prevent). */
export const HOOK_BOOTSTRAP_TIMEOUT_MS = 1000

/** A hook that can mint a binding can mint the store the binding names
 *  (issue #2, filed 2026-08-05 against 0.0.14-beta; fixed 2026-09-02).
 *  Until now only the serving process gave a store its schema, so every
 *  hook that fired before the server's first boot — the window between
 *  `install` and the agent's restart, or the SessionStart hook racing the
 *  server it starts beside — opened an empty file, died on
 *  "no such table: staging", exited 0 by ruling, and lost its event with
 *  no store to hold a gap marker. rc.6's leftover was a 4KB shell that
 *  doctor graded "v0→v24, 3 destructive" forever.
 *
 *  What this does: on a store whose user_version reads 0, apply the ONE
 *  definition of fresh (ensureBaseSchema: version 0 AND an empty
 *  sqlite_master, decided under an immediate transaction) and then the
 *  full ladder, exactly as Persistence.openLexical and the serve path do
 *  — so a hook-minted store is indistinguishable from a server-minted one
 *  (pre-migration-v5.bak and its verdict included). What this never does:
 *  migrate a store that holds journal rows. A v0-era store with tables
 *  returns false from ensureBaseSchema and is left for the server, whose
 *  open takes the backup first; a versioned store with anything in
 *  `nodes` never reaches the wrapper at all — the write below falls
 *  through writeStaging's schema tiers as it always has.
 *
 *  Concurrency: the server booting beside a SessionStart hook runs the
 *  same ladder, and so may a second hook. The base schema is decided
 *  under BEGIN IMMEDIATE (the loser re-checks and no-ops); the ladder's
 *  batches take the write lock at BEGIN and skip versions the winner
 *  already applied. The one window between them — the winner's base
 *  schema committed at version 5, its backup copy still in flight before
 *  the first BEGIN EXCLUSIVE — is why the gate is not "version 0" but
 *  "below the ladder's head with an empty journal": a loser that reads
 *  version 5 in that window must finish the ladder too (it waits for the
 *  winner's lock and skips what it applied), or its write lands on the
 *  base schema through the legacy column tier — stamps and tail dropped
 *  — which the four-hook race of 2026-09-02 showed three times in four.
 *  Anything that still throws here is logged and swallowed: by then the
 *  other starter holds the tables the staging write needs, and a hook's
 *  exit code is never the place to report it. */
export function bootstrapFreshStore(db: DatabaseType, dbPath: string, deadlineAt: number): boolean {
  // The cheap gate, on the raw handle: a store at (or beyond) the head is
  // not ours to touch, and the common case pays one pragma read.
  const version = pragmaValue(db, 'user_version') as number
  if (version >= maxSupportedVersion) return false
  // Below the head and versioned: only an EMPTY store is bootstrap
  // territory, and empty means empty — nothing in `nodes` AND nothing in
  // `staging`. Staged rows are captured data too (review finding 5); a
  // store holding any is the server's to migrate, behind the backup the
  // server takes. The same gate bounds what the ladder's VACUUM INTO
  // copies under a hook's 10s kill (finding 3): a store with neither is a
  // few hundred kilobytes by construction, never the multi-hundred-MB
  // journal a partial backup could be torn out of.
  if (version !== 0) {
    try {
      if (db.prepare('SELECT 1 FROM nodes LIMIT 1').get() !== undefined) return false
      if (db.prepare('SELECT 1 FROM staging LIMIT 1').get() !== undefined) return false
    } catch {
      return false // no journal tables at a nonzero version: not a shape this knows
    }
  }
  // The bootstrap's share, by the clock from here, and never past the
  // connection's own deadline: the write behind it keeps the rest.
  const shareEnds = Math.min(Date.now() + HOOK_BOOTSTRAP_TIMEOUT_MS, deadlineAt)
  try {
    // One unit, run again whole when a lock cuts a try short: safe to
    // repeat, because the base schema is decided under BEGIN IMMEDIATE (a
    // loser re-checks and no-ops) and the ladder skips the versions
    // already applied (see Concurrency above). The wrapper's constructor
    // runs its pragmas at a slice, not its 10 s default.
    return withHookDeadline(db, shareEnds, () => {
      const wrapped = openNodeSqlite(db, { timeoutMs: busySliceUntil(shareEnds) })
      if (version === 0 && !ensureBaseSchema(wrapped)) {
        // Not fresh after all. Two shapes share this branch: a v0-era store
        // with tables (the server's, behind its backup), and a concurrent
        // starter that committed the base schema while this one waited for
        // the lock — in which case the ladder is still ours to finish, or
        // the write lands on version 5 through the legacy tier.
        if ((pragmaValue(db, 'user_version') as number) === 0) {
          dbg('hook', 'v0-era store with data — left for the server to migrate', { dbPath })
          return false
        }
      }
      const report = runMigrations(wrapped, { migrate: true })
      dbg('hook', 'fresh store bootstrapped', { dbPath, from: report.from, to: report.to, applied: report.applied.length })
      return true
    })
  } catch (err) {
    dbg('hook', 'fresh-store bootstrap did not complete', { dbPath, error: err instanceof Error ? err.message : String(err) })
    return false
  } finally {
    // Every file this opener created — and rc.6's shell, minted by a
    // hook under the umask — passes through here, bootstrapped or not:
    // the journal holds every prompt and tool output, and S11 says 0600
    // on create (finding 4), the same tightening the library's open
    // performs. A store at the head never enters this function and keeps
    // whatever mode the server gave it.
    ensureDbFileMode(dbPath)
    // The connection leaves here in the state a non-bootstrapping open
    // has (finding 7): the wrapper's pragmas — synchronous NORMAL, the
    // 256MB mmap, temp_store MEMORY — are the library's choices for a
    // long-lived server handle, not a hook's, and a hook's durability
    // must not depend on whether it happened to bootstrap. The write
    // gets what the bootstrap left of the connection's deadline, never a
    // fresh one (finding 2): the deadline is the connection's, and the
    // wrapper's busy_timeout is set back to a slice before the next
    // statement (hook-deadline.ts).
    setPragma(db, 'synchronous = FULL')
    setPragma(db, 'mmap_size = 0')
    setPragma(db, 'temp_store = DEFAULT')
    setPragma(db, 'foreign_keys = ON')
  }
}

export function resolveDbPath(cwd?: string): string {
  const effectiveCwd = cwd || process.cwd()
  const { storeName, source } = resolveStoreName(effectiveCwd)
  const path = resolveStorePath(storeName)
  dbg('hook', 'resolveDbPath', { cwd: effectiveCwd, storeName, source, path })
  return path
}

/** Stage one event. `andThen` runs on the same write connection after the
 *  staged row lands — the Stop hook records its bookmark ask there rather
 *  than opening the store a third time; its failure never undoes the row.
 *  The connection is a hook handle (openHookDb), so the open, the
 *  namespace read and the INSERT each wait by the clock against one
 *  deadline: HOOK_DB_TIMEOUT_MS from the open, or, when the write is a
 *  second phase of a hook whose write connection is still open (a staging
 *  write behind the hooks door's, or behind session-start's reads), what
 *  is left of that one, never a fresh budget (openWriteDeadline). The
 *  INSERT is one autocommit statement, so the handle's retry of it never
 *  stages a row twice. */
export function writeStaging(dbPath: string, entry: StagingEntry, andThen?: (db: DatabaseType) => void, opts?: { deadlineAt?: number }): void {
  let db: DatabaseType | null = null
  try {
    // `deadlineAt`: a write phase behind an earlier one that is no longer
    // open to inherit from (stop.ts: the door's open failed) waits what is
    // left of the hook's budget, never a fresh one.
    db = openHookDb(dbPath, opts?.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : undefined)
    // C1 capture attribution: stamp the namespace of the session this hook
    // belongs to — first by the session-keyed annotation the drain
    // publishes from echo evidence (§7.8; causal, pid-free, works where
    // exec chains break), then through the server's pid annotation when
    // its server is corroborated as still serving (the hook's ppid IS
    // the claude pid on exec-capable platforms). The RATIFIED order:
    // C#2's inversion was reverted by owner ruling 2026-08-20 — the pid
    // file is shared by every server one claude spawns, so it must not
    // preempt the session's own proof (see resolveHookNamespace).
    // Unresolved stays NULL: the drain routes NULL into its own serving
    // namespace visibly at drain time; the hook never guesses.
    const namespace = entry.namespace !== undefined
      ? entry.namespace
      // Corroboration is one primary-key lookup on a database this hook
      // already has open, so the first rung costs a SELECT rather than
      // a pid probe — and answers the right question.
      : resolveHookNamespace(dbPath, process.ppid, entry.sessionId,
        (a) => nsLeaseLiveFor(db!, a.namespace, a.server_pid, hostname()))
    const params = {
      sessionId: entry.sessionId ?? null,
      role: entry.role,
      content: entry.content,
      toolName: entry.toolName ?? null,
      timestamp: entry.timestamp,
      priority: entry.priority ?? 3,
      createdAt: Date.now() / 1000,
    }
    const isMissingColumn = (err: unknown): boolean =>
      err instanceof Error && /no such column|has no column named/i.test(err.message)
    // Pre-018 boundary: on a store whose readers treat index_len as BOTH
    // the FTS view and the display cut, staging the widened index_len would
    // flood hits with tail content. Degrade to the old semantics instead:
    // tailed tool rows keep the preview boundary (narrowed further by a
    // binding env cap — the one explicit user lever); a full-length prose
    // index_len is not a boundary at all, so stage NULL and let the old
    // server apply its legacy role caps exactly as it did pre-expansion.
    let pre018IndexLen: number | null
    if (entry.previewLen != null) {
      pre018IndexLen = Math.min(entry.previewLen, entry.indexLen ?? entry.previewLen)
    } else if (entry.indexLen != null && entry.indexLen < entry.content.length) {
      pre018IndexLen = entry.indexLen
    } else {
      pre018IndexLen = null
    }
    // Hooks never run migrations (JF-8): a hook meeting an older store
    // degrades tier by tier instead — a flat walk, newest schema first;
    // a missing-column error moves to the next tier, anything else is a
    // real failure (the old 4-deep try/catch pyramid said the same
    // thing sideways; pass-2 cleanup ruling 2026-08-15). Tier
    // semantics, each load-bearing:
    //  - v20+: boundary columns + the namespace stamp.
    //  - v18–19: boundary columns, no namespace — drop the stamp;
    //    identical semantics to an unresolved stamp (NULL rows drain to
    //    'project').
    //  - v16–17: index_len only — stage the pre-018 boundary computed
    //    above, or the old readers would flood hits with tail content.
    //  - <v16: no boundary column at all. The full tail must NOT be
    //    staged (256KB FTS documents, shifted rankings, full-content
    //    read side) — stage exactly the pre-C4 preview. STORAGE
    //    truncation cuts only at the display boundary, never an index
    //    boundary: an env cap is an index lever and does not apply on a
    //    store this old.
    //  - v27+: the payload's writer (agent_id, agent_type) and
    //    the row kind (D190, D147). An older store drops them: the row
    //    drains as the main agent's, which is the unstamped shape every
    //    row had before.
    //  - v34+ (current): a tool call's id, its outcome and where it was
    //    captured from (D400, D401). An older store drops them: the call
    //    stages exactly as it did before this build (a failed call's row
    //    still lands, unmarked), and the batch hook adds nothing there.
    const writerCols = entry.agentId != null || entry.agentType != null || entry.kind != null
    const callCols = entry.toolUseId != null || entry.outcome != null || entry.capturedFrom != null
    const tiers: Array<{ cols: string; vals: string; run: Record<string, unknown>; note: string | null }> = [
      ...(callCols ? [{
        cols: ', index_len, preview_len, namespace, agent_id, agent_type, kind, tool_use_id, outcome, captured_from',
        vals: ', @indexLen, @previewLen, @namespace, @agentId, @agentType, @kind, @toolUseId, @outcome, @capturedFrom',
        run: {
          ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null, namespace,
          agentId: entry.agentId ?? null, agentType: entry.agentType ?? null, kind: entry.kind ?? null,
          toolUseId: entry.toolUseId ?? null, outcome: entry.outcome ?? null, capturedFrom: entry.capturedFrom ?? null,
        },
        note: null,
      }] : []),
      ...(writerCols ? [{
        cols: ', index_len, preview_len, namespace, agent_id, agent_type, kind',
        vals: ', @indexLen, @previewLen, @namespace, @agentId, @agentType, @kind',
        run: {
          ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null, namespace,
          agentId: entry.agentId ?? null, agentType: entry.agentType ?? null, kind: entry.kind ?? null,
        },
        note: callCols ? 'pre-034 column fallback, call id and outcome dropped' : null,
      }] : []),
      {
        cols: ', index_len, preview_len, namespace', vals: ', @indexLen, @previewLen, @namespace',
        run: { ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null, namespace },
        note: writerCols ? 'pre-027 column fallback, writer stamp dropped' : callCols ? 'pre-034 column fallback, call id and outcome dropped' : null,
      },
      {
        cols: ', index_len, preview_len', vals: ', @indexLen, @previewLen',
        run: { ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null },
        note: 'pre-020 column fallback, namespace stamp dropped',
      },
      {
        cols: ', index_len', vals: ', @indexLen',
        run: { ...params, indexLen: pre018IndexLen },
        note: 'pre-018 column fallback, index_len at preview boundary',
      },
      {
        cols: '', vals: '',
        run: { ...params, content: entry.previewLen != null ? entry.content.slice(0, entry.previewLen) : entry.content },
        note: 'legacy column fallback (pre-v16 schema), tail dropped',
      },
    ]
    for (let t = 0; t < tiers.length; t++) {
      const tier = tiers[t]!
      try {
        db.prepare(
          `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at${tier.cols})
           VALUES (@sessionId, @role, @content, @toolName, @timestamp, @priority, 0, @createdAt${tier.vals})`,
        ).run(tier.run as never)
        if (tier.note) dbg('hook', `staging write: ${tier.note}`, { dbPath })
        break
      } catch (err) {
        if (!isMissingColumn(err) || t === tiers.length - 1) throw err
      }
    }
    dbg('hook', 'staging write ok', { role: entry.role, toolName: entry.toolName ?? null, dbPath, bytes: entry.content.length })
    if (andThen) {
      try { andThen(db) } catch (err) {
        dbg('hook', 'post-staging write FAILED', { error: err instanceof Error ? err.message : String(err), dbPath })
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // The one error class that means capture is losing data — a store
    // with no schema, or none at all — is named as such: the debug log is
    // the channel that survives the wrapper's stderr discard, and a reader
    // chasing "the node count is still 0" deserves the diagnosis, not the
    // symptom.
    const losing = /no such table|does not exist|unable to open database/i.test(msg)
    dbg('hook', losing ? 'staging write FAILED — CAPTURE IS LOSING DATA: the store has no usable schema' : 'staging write FAILED', { error: msg, dbPath, role: entry.role })
    console.error(`[treecontext hook] Failed to write staging entry: ${msg}${losing ? ' — capture is losing data; run `treecontext doctor`' : ''}`)
    // D314: a dropped event is marked, whichever hook dropped it: the gap
    // ledger beside the store, which the drain writes as a capture-gap row
    // when the store is next written.
    recordHookGap(dbPath, {
      hook: stagingHookOf(entry), sessionId: entry.sessionId ?? null,
      ...(entry.agentId ? { agentId: entry.agentId } : {}), ...(entry.agentType ? { agentType: entry.agentType } : {}),
      at: entry.timestamp, error: msg,
      lost: `The ${entry.toolName ? `${entry.toolName} call` : entry.role === 'user' ? 'developer turn' : entry.role === 'snapshot' ? 'recovery snapshot claim' : 'assistant turn'} it captured was not staged.`,
      text: entry.content,
    })
  } finally {
    if (db) db.close()
  }
}

/** The calls of one batch the client accounted for (PostToolBatch, D401),
 *  each already composed as its staged row would be, with its id. */
export interface BatchCall { toolUseId: string; entry: StagingEntry }

/** What stageBatchAccount did: the calls it staged, the ones already
 *  captured by an event of their own, or why it added nothing. */
export type BatchOutcome =
  | { staged: string[]; captured: string[] }
  | { skipped: 'pre-034' | 'no-calls' }

/** True when the store's staging table has the call id (migration 034).
 *  Asked of the table, never of user_version: a hook runs at whatever
 *  schema the store is at. */
export function stagingHasCallId(db: DatabaseType): boolean {
  return (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).some((c) => c.name === 'tool_use_id')
}

/**
 * D401: the batch's account adds the calls no event of their own captured,
 * told by the client's id for each call against what this session already
 * staged. PostToolBatch fires after every call's own hooks have finished
 * (live, Claude Code 2.1.319), and staged rows stay in staging after the
 * drain (processed = 1) until the processed-row prune, a day later
 * (store.ts purgeProcessedStaging), so a call its own event captured is
 * always found here. A call whose own staging write failed left its gap
 * record (D314), and its batch's account is then its entry.
 *
 * One connection, one immediate transaction: the lookup and the inserts
 * see the same staging. On a store below 034 nothing is added, since what
 * was captured cannot be told there. A failure before the lookup answered
 * is one gap record for the batch (which of its calls were captured is not
 * known, so none is claimed lost by name); a failure after it is one gap
 * record per call the batch was adding, the calls that are in fact lost.
 */
export function stageBatchAccount(dbPath: string, sessionId: string | null, calls: BatchCall[]): BatchOutcome {
  if (calls.length === 0 || !sessionId) return { skipped: 'no-calls' }
  let db: DatabaseType | null = null
  let missing: BatchCall[] | null = null
  const at = calls[0]!.entry.timestamp
  try {
    db = openHookDb(dbPath)
    if (!stagingHasCallId(db)) {
      dbg('hook', 'batch account: staging predates the call id (034), nothing added', { dbPath })
      return { skipped: 'pre-034' }
    }
    const handle = db
    const namespace = resolveHookNamespace(dbPath, process.ppid, sessionId,
      (a) => nsLeaseLiveFor(handle, a.namespace, a.server_pid, hostname()))
    const ids = calls.map((c) => c.toolUseId)
    const result = withHookDeadline(handle, hookDeadlineOf(handle) ?? Date.now() + HOOK_DB_TIMEOUT_MS, () => {
      handle.exec('BEGIN IMMEDIATE')
      const captured = new Set((handle.prepare(
        `SELECT tool_use_id FROM staging WHERE session_id = ? AND tool_use_id IN (${ids.map(() => '?').join(', ')})`,
      ).all(sessionId, ...ids) as Array<{ tool_use_id: string }>).map((r) => r.tool_use_id))
      missing = calls.filter((c) => !captured.has(c.toolUseId))
      const insert = handle.prepare(
        `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at,
           index_len, preview_len, namespace, agent_id, agent_type, kind, tool_use_id, outcome, captured_from)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const c of missing) {
        const e = c.entry
        insert.run(sessionId, e.role, e.content, e.toolName ?? null, e.timestamp, e.priority ?? 3, Date.now() / 1000,
          e.indexLen ?? null, e.previewLen ?? null, e.namespace !== undefined ? e.namespace : namespace,
          e.agentId ?? null, e.agentType ?? null, e.kind ?? null, c.toolUseId, e.outcome ?? null, e.capturedFrom ?? null)
      }
      handle.exec('COMMIT')
      return { staged: missing.map((c) => c.toolUseId), captured: [...captured] }
    })
    dbg('hook', 'batch account staged', { dbPath, staged: result.staged.length, captured: result.captured.length })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[treecontext hook] Failed to stage the batch's account: ${msg}`)
    const writer = calls[0]!.entry
    const who = {
      ...(writer.agentId ? { agentId: writer.agentId } : {}), ...(writer.agentType ? { agentType: writer.agentType } : {}),
    }
    // D314: never silently. Before the lookup answered, which calls were
    // captured is unknown: one record for the batch, naming its calls.
    // After it, each call the batch was adding is lost: one record each.
    const lostCalls = missing as BatchCall[] | null
    if (lostCalls === null) {
      recordHookGap(dbPath, {
        hook: 'post-tool-use', sessionId, ...who, at, error: msg,
        lost: `The batch's account of ${calls.length} call${calls.length === 1 ? '' : 's'} was not checked against what was captured, so a call the client resolved without running may be missing: ${calls.map((c) => `${c.entry.toolName ?? 'tool'} ${c.toolUseId}`).join(', ')}.`,
        text: null,
      })
    } else {
      for (const c of lostCalls) {
        recordHookGap(dbPath, {
          hook: 'post-tool-use', sessionId, ...who, at, error: msg,
          lost: `The ${c.entry.toolName ?? 'tool'} call ${c.toolUseId} the batch's account carried was not staged.`,
          text: c.entry.content,
        })
      }
    }
    return { staged: [], captured: [] }
  } finally {
    if (db) db.close()
  }
}

/** Can the store take a hook's writes? Asked of the filesystem, which
 *  costs no lock wait (D163): the Stop hook's bookmark ask and the hooks
 *  door's send-back are skipped when it cannot (D279: never when the store
 *  cannot be written). */
export function storeRefusesWrites(dbPath: string): string | null {
  try {
    fs.accessSync(dbPath, fs.constants.W_OK)
    fs.accessSync(dirname(dbPath), fs.constants.W_OK)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? 'the store is read-only for this session'
      : `the store is unavailable (${err instanceof Error ? err.message : String(err)})`
  }
}

/** The hook's block decision: the subagent continues with the reason as
 *  its next instruction (Claude Code's SubagentStop decision control). */
export function blockOutput(reason: string): string {
  return JSON.stringify({ decision: 'block', reason: reason.length > HOOK_CONTEXT_CAP ? reason.slice(0, HOOK_CONTEXT_CAP) : reason }) + '\n'
}

/** The hook a staged event came from, by its shape: what the gap row
 *  names when the staging write was refused. */
export function stagingHookOf(entry: Pick<StagingEntry, 'toolName' | 'role' | 'kind'>): string {
  if (entry.toolName) return 'post-tool-use'
  if (entry.role === 'user') return 'user-prompt-submit'
  if (entry.role === 'snapshot') return 'session-start'
  if (entry.kind) return 'subagent-stop'
  return 'stop'
}

/** The writer a Claude Code hook payload names (D190): a subagent's
 *  agent_id and agent_type, which its PostToolUse, SubagentStart and
 *  SubagentStop payloads carry beside the parent's session_id (probe of
 *  2026-09-25); absent on the main agent's events. */
export function payloadWriter(input: Record<string, unknown>): { agentId?: string; agentType?: string } {
  const named = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  const agentId = named(input['agent_id'])
  const agentType = named(input['agent_type'])
  return { ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) }
}

export function parseHookInput(): any {
  try {
    const input = fs.readFileSync(0, 'utf-8')
    return JSON.parse(input)
  } catch (e) {
    return {}
  }
}

// ── Layer 3 primitives (compaction lifecycle) ──────────────────────

export type SessionSource = 'startup' | 'clear' | 'compact' | 'resume' | 'unknown'

const SOURCE_BUDGETS: Record<SessionSource, number> = {
  startup: 5000,
  clear: 3000,
  compact: 2000,
  resume: 500,
  unknown: 3000,
}

const HARD_CAP = 10_000
const TRUNCATION_SENTINEL = '\n\n... (more available via treecontext_query)'

export function writeSnapshot(dbPath: string, sessionId: string, queries: string[]): number {
  const db = openHookDb(dbPath)
  try {
    const stmt = db.prepare('INSERT INTO snapshots (session_id, queries) VALUES (?, ?)')
    const result = stmt.run(sessionId, JSON.stringify(queries))
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

/**
 * A fresh start's claim of a recovery snapshot (D286, D375): the newest
 * unclaimed snapshot another session of the claimant's own lane left. The
 * lane is the checkout the session registry places a session's self in,
 * the main checkout or a linked worktree under its registered name, read
 * for the claimant and for each snapshot's session alike, so a main
 * checkout never adopts a worktree's recovery note, nor a worktree the main
 * checkout's or another worktree's.
 *
 * Nothing is claimed by a session the registry does not place (an
 * unregistered session, a store without the registry, a ticket-door worker,
 * which has no self): it has no lane to claim from. A snapshot whose
 * session the registry never placed (left before the store recorded
 * sessions, or by a worker) stays in its table unclaimed, disclosed there
 * rather than claimed for anyone.
 */
export function claimSnapshot(
  db: DatabaseType,
  sessionId: string,
): { id: number; originalSessionId: string; queries: string[] } | null {
  if (!hasRegistry(db)) return null
  const self = selfOf(db, sessionId)
  if (!self) return null
  // The snapshots of the claimant's lane: their session's self registered
  // in the same checkout (`worktree IS ?` matches NULL, the main checkout,
  // to NULL), never the claimant's own.
  const ofLane = `FROM snapshots s JOIN session_registry r ON r.session_id = s.session_id AND r.agent_id = ''
     WHERE s.claimed_by IS NULL AND s.session_id != ? AND r.worktree IS ?`
  // Lock-free probe first: the common case is nothing to claim, and even
  // a zero-row UPDATE takes the write lock — a SessionStart with nothing
  // to rehydrate must not queue behind a busy writer just to learn that.
  // A lost race here only means returning null a moment early.
  const candidate = db.prepare(`SELECT 1 ${ofLane} LIMIT 1`).get(sessionId, self.worktree)
  if (!candidate) return null

  // One atomic UPDATE … RETURNING (G3): SessionStart hooks race each
  // other cross-process with no lock covering them, and a single
  // statement cannot lose the read-then-write race the old transaction
  // shape carried. Whoever's UPDATE runs first claims the row; the
  // loser's WHERE finds the next unclaimed snapshot of its lane or nothing.
  const row = db.prepare(
    `UPDATE snapshots SET claimed_by = ?, claimed_at = ?
      WHERE id = (SELECT s.id ${ofLane}
                   ORDER BY s.created_at DESC, s.id DESC LIMIT 1)
      RETURNING id, session_id, queries`
  ).get(sessionId, Date.now() / 1000, sessionId, self.worktree) as
    | { id: number; session_id: string; queries: string }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    originalSessionId: row.session_id,
    queries: JSON.parse(row.queries) as string[],
  }
}

export function getRecentStaging(
  db: DatabaseType,
  sessionId: string,
  limit = 20,
): Array<{ role: string; content: string; toolName: string | null; timestamp: number }> {
  return db.prepare(
    `SELECT role, content, tool_name as toolName, timestamp
     FROM staging
     WHERE session_id = ? OR session_id IS NULL
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`
  ).all(sessionId, limit) as Array<{ role: string; content: string; toolName: string | null; timestamp: number }>
}

export function buildRehydrationPayload(
  db: DatabaseType,
  sessionId: string,
  source: SessionSource,
  dbPath: string,
  /** Whether the caller shows the lane's own lines (session-start.ts
   *  selfLines) above this payload: the "no prior context" fallback would
   *  contradict them, so it is left out. */
  opts: { selfLinesShown?: boolean } = {},
): string {
  const budget = SOURCE_BUDGETS[source]
  const parts: string[] = []

  if (source === 'startup') {
    const snapshot = claimSnapshot(db, sessionId)
    if (snapshot) {
      parts.push(`[Prior session snapshot #${snapshot.id} from session ${snapshot.originalSessionId}]`)
      parts.push(`Recovery queries: ${snapshot.queries.join(', ')}`)

      // A second phase of this hook's wait, opened while `db` is open: it
      // waits what is left of db's deadline, never a fresh budget.
      writeStaging(dbPath, {
        sessionId,
        role: 'snapshot',
        // D375: the snapshot's id travels with the claim, so the drain's
        // row is identified by the claim, never by its text.
        content: JSON.stringify({ queries: snapshot.queries, original_session_id: snapshot.originalSessionId, snapshot_id: snapshot.id }),
        timestamp: Date.now() / 1000,
        priority: 0,
      })
    }
  }

  if (source === 'resume') {
    const snapshot = db.prepare(
      `SELECT id FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId) as { id: number } | undefined

    if (snapshot) {
      parts.push(`Snapshot #${snapshot.id} available. Call treecontext_query for prior context.`)
    } else {
      parts.push('No prior snapshot. Call treecontext_query for context if needed.')
    }
    return enforceCharCap(parts.join('\n'), budget)
  }

  const staging = getRecentStaging(db, sessionId, source === 'startup' ? 20 : 10)
  if (staging.length > 0) {
    if (source === 'clear' || source === 'compact' || source === 'unknown') {
      parts.push('[Continuation from prior context]')
    }

    const userMsgs = staging.filter(s => s.role === 'user')
    const toolMsgs = staging.filter(s => s.role === 'assistant' && s.toolName)

    if (userMsgs.length > 0) {
      parts.push('Recent user messages:')
      for (const msg of userMsgs.slice(0, source === 'startup' ? 5 : 3)) {
        parts.push(`- ${msg.content.substring(0, 200)}`)
      }
    }

    if (toolMsgs.length > 0) {
      parts.push('Recent tool activity:')
      for (const msg of toolMsgs.slice(0, source === 'startup' ? 5 : 3)) {
        parts.push(`- ${msg.toolName}: ${msg.content.substring(0, 150)}`)
      }
    }
  }

  if (source === 'compact') {
    parts.push('\nNote: The prior summary may have collapsed branching threads. This snapshot preserves the active thread.')
  }

  if (parts.length === 0 && !opts.selfLinesShown) {
    parts.push('No prior context available. Use treecontext_query to search project memory.')
  }

  return enforceCharCap(parts.join('\n'), budget)
}

export function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching ESC is the point
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

export function enforceCharCap(text: string, cap?: number): string {
  const effectiveCap = Math.min(cap ?? HARD_CAP, HARD_CAP)
  const cleaned = stripAnsi(text)

  if (cleaned.length <= effectiveCap) return cleaned

  const truncateAt = effectiveCap - TRUNCATION_SENTINEL.length
  if (truncateAt <= 0) return TRUNCATION_SENTINEL.slice(0, effectiveCap)

  const truncated = cleaned.slice(0, truncateAt)
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('\n\n'),
  )

  const breakpoint = lastSentence > truncateAt * 0.5 ? lastSentence + 1 : truncateAt
  return truncated.slice(0, breakpoint).trimEnd() + TRUNCATION_SENTINEL
}

export function normalizeSource(raw: unknown): SessionSource {
  if (typeof raw !== 'string') return 'unknown'
  const s = raw.toLowerCase()
  if (s === 'startup' || s === 'clear' || s === 'compact' || s === 'resume') return s
  return 'unknown'
}

/**
 * True when this module is the process entry point, rather than a module
 * imported by one.
 *
 * A bare `argv[1].endsWith('stop.js')` test is not enough: a platform
 * adapter at `hooks/vscode/stop.js` also ends with `stop.js`, so importing
 * the reference hook it delegates to would make that reference hook run
 * itself — consuming stdin before the adapter ever normalized it. Matching
 * the last TWO path segments keeps the tolerance for symlinks and wrapper
 * launches while keeping each adapter distinct from its reference.
 */
export function isDirectInvocation(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(moduleUrl)
  if (entry === self) return true
  const tail = self.split(/[\\/]/).slice(-2).join('/')
  return entry.replace(/\\/g, '/').endsWith(`/${tail}`)
}
