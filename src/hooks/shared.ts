import * as fs from 'fs'
import { fileURLToPath } from 'node:url'
import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { resolveStoreName } from '../server/bindings.js'
import { armStormProofStdio, resolveStorePath } from '../server/cli.js'
import { StagingEntry } from '../persistence/store.js'
import { resolveHookNamespace } from '../session-beacon.js'
import { nsLeaseLiveFor } from '../persistence/leases.js'
import { dirname } from 'node:path'
import { wrapBetterSqlite, ensureDbFileMode } from '../persistence/better-sqlite.js'
import { ensureBaseSchema, runMigrations } from '../persistence/migrations.js'
import { maxSupportedVersion } from '../persistence/migrations/index.js'
import { hostname } from 'node:os'
import { dbg, enableDebug } from '../debug.js'

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

/** Busy timeout for every hook-owned store connection. Must stay strictly
 *  below the smallest platform hook kill budget — VS Code registers every
 *  hook with timeoutSec: 10 (installer.ts) — because better-sqlite3's busy
 *  wait blocks the event loop: a hook killed mid-wait loses its failure
 *  diagnostic and its close(). 8s leaves headroom to fail gracefully. */
export const HOOK_DB_TIMEOUT_MS = 8000

/** The busy budget for the Stop hook's PRE-WRITE guard read. The Stop
 *  hook is the one hook that opens the store twice (guard, then write),
 *  and its budgets SUM against the platform's 10s kill: giving the
 *  guard the full 8s put the worst case at 16s and turned a
 *  duplicate-capture risk into total capture loss (pass-2 review
 *  2026-08-15). 1s is plenty for a WAL read (readers rarely block at
 *  all) and keeps guard+write at 9s — under the kill budget with the
 *  fail-gracefully second intact. The sum is pinned in
 *  tests/hooks/shared.test.ts. */
export const STOP_GUARD_TIMEOUT_MS = 1000

/** The one place hook code opens the store: shared timeout + WAL. Every
 *  hook and adapter must open through here so a timeout tuning cannot
 *  miss a site again — including read-only opens: stop.ts kept a raw
 *  2s open and its stale-recapture guard silently disarmed on exactly
 *  the busy stores the 8s budget was shipped for (release-diff review
 *  2026-08-15). journal_mode is skipped for readonly opens (the pragma
 *  is a write when it changes the mode; WAL is already the store's
 *  recorded mode). `timeoutMs` exists for callers whose budgets STACK
 *  (the Stop hook's guard+write pair) — a single-open hook never
 *  passes it. */
export function openHookDb(dbPath: string, opts?: { readonly?: boolean; timeoutMs?: number }): DatabaseType {
  const timeoutMs = opts?.timeoutMs ?? HOOK_DB_TIMEOUT_MS
  const readonly = opts?.readonly ?? false
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
  const db = new Database(dbPath, { timeout: timeoutMs, readonly })
  if (!readonly) {
    db.pragma('journal_mode = WAL')
    bootstrapFreshStore(db, dbPath, timeoutMs)
  }
  return db
}

/** The bootstrap's share of a hook's budget. The base schema and the
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
export function bootstrapFreshStore(db: DatabaseType, dbPath: string, timeoutMs: number): boolean {
  // The cheap gate, on the raw handle: a store at (or beyond) the head is
  // not ours to touch, and the common case pays one pragma read.
  const version = db.pragma('user_version', { simple: true }) as number
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
  const started = Date.now()
  try {
    const wrapped = wrapBetterSqlite(db)
    // The wrapper's constructor applied the library's default pragmas,
    // busy_timeout 10000 among them. The bootstrap waits at most its own
    // share (HOOK_BOOTSTRAP_TIMEOUT_MS) for a lock; the finally below
    // hands whatever is left of the hook's budget to the write.
    db.pragma(`busy_timeout = ${Math.min(HOOK_BOOTSTRAP_TIMEOUT_MS, timeoutMs)}`)
    if (version === 0 && !ensureBaseSchema(wrapped)) {
      // Not fresh after all. Two shapes share this branch: a v0-era store
      // with tables (the server's, behind its backup), and a concurrent
      // starter that committed the base schema while this one waited for
      // the lock — in which case the ladder is still ours to finish, or
      // the write lands on version 5 through the legacy tier.
      if ((db.pragma('user_version', { simple: true }) as number) === 0) {
        dbg('hook', 'v0-era store with data — left for the server to migrate', { dbPath })
        return false
      }
    }
    const report = runMigrations(wrapped, { migrate: true })
    dbg('hook', 'fresh store bootstrapped', { dbPath, from: report.from, to: report.to, applied: report.applied.length })
    return true
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
    // must not depend on whether it happened to bootstrap. And the write
    // gets what the bootstrap left of the hook's budget, never a fresh
    // one (finding 2).
    db.pragma('synchronous = FULL')
    db.pragma('mmap_size = 0')
    db.pragma('temp_store = DEFAULT')
    db.pragma('foreign_keys = ON')
    db.pragma(`busy_timeout = ${Math.max(timeoutMs - (Date.now() - started), 100)}`)
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
 *  than opening the store a third time; its failure never undoes the row. */
export function writeStaging(dbPath: string, entry: StagingEntry, andThen?: (db: DatabaseType) => void): void {
  let db: DatabaseType | null = null
  try {
    db = openHookDb(dbPath)
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
    //  - v27+ (current): the payload's writer (agent_id, agent_type) and
    //    the row kind (D190, D147). An older store drops them: the row
    //    drains as the main agent's, which is the unstamped shape every
    //    row had before.
    const writerCols = entry.agentId != null || entry.agentType != null || entry.kind != null
    const tiers: Array<{ cols: string; vals: string; run: Record<string, unknown>; note: string | null }> = [
      ...(writerCols ? [{
        cols: ', index_len, preview_len, namespace, agent_id, agent_type, kind',
        vals: ', @indexLen, @previewLen, @namespace, @agentId, @agentType, @kind',
        run: {
          ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null, namespace,
          agentId: entry.agentId ?? null, agentType: entry.agentType ?? null, kind: entry.kind ?? null,
        },
        note: null,
      }] : []),
      {
        cols: ', index_len, preview_len, namespace', vals: ', @indexLen, @previewLen, @namespace',
        run: { ...params, indexLen: entry.indexLen ?? null, previewLen: entry.previewLen ?? null, namespace },
        note: writerCols ? 'pre-027 column fallback, writer stamp dropped' : null,
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
        ).run(tier.run)
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
  } finally {
    if (db) db.close()
  }
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

export function claimSnapshot(
  db: DatabaseType,
  sessionId: string,
): { id: number; originalSessionId: string; queries: string[] } | null {
  // Lock-free probe first: the common case is nothing to claim, and even
  // a zero-row UPDATE takes the write lock — a SessionStart with nothing
  // to rehydrate must not queue behind a busy writer just to learn that.
  // A lost race here only means returning null a moment early.
  const candidate = db.prepare(
    'SELECT 1 FROM snapshots WHERE claimed_by IS NULL AND session_id != ? LIMIT 1'
  ).get(sessionId)
  if (!candidate) return null

  // One atomic UPDATE … RETURNING (G3): SessionStart hooks race each
  // other cross-process with no lock covering them, and a single
  // statement cannot lose the read-then-write race the old transaction
  // shape carried. Whoever's UPDATE runs first claims the row; the
  // loser's WHERE finds the next unclaimed snapshot or nothing.
  const row = db.prepare(
    `UPDATE snapshots SET claimed_by = ?, claimed_at = ?
      WHERE id = (SELECT id FROM snapshots
                   WHERE claimed_by IS NULL AND session_id != ?
                   ORDER BY created_at DESC, id DESC LIMIT 1)
      RETURNING id, session_id, queries`
  ).get(sessionId, Date.now() / 1000, sessionId) as
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
): string {
  const budget = SOURCE_BUDGETS[source]
  const parts: string[] = []

  if (source === 'startup') {
    const snapshot = claimSnapshot(db, sessionId)
    if (snapshot) {
      parts.push(`[Prior session snapshot #${snapshot.id} from session ${snapshot.originalSessionId}]`)
      parts.push(`Recovery queries: ${snapshot.queries.join(', ')}`)

      writeStaging(dbPath, {
        sessionId,
        role: 'snapshot',
        content: JSON.stringify({ queries: snapshot.queries, original_session_id: snapshot.originalSessionId }),
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

  if (parts.length === 0) {
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
