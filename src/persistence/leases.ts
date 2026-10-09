import type { Database } from './database.js'
import { StoreLockedError } from '../errors/index.js'

/**
 * Role leases (G4, store-as-arbiter §3): singleton coordination through
 * the store's `leases` table — heartbeats and transactions, no
 * lockfiles. Liveness is heartbeat expiry: a holder whose
 * heartbeat_at + ttl_secs has passed is dead by definition, with no pid
 * probing, no pid-reuse bounds, no same-host reclaim rules, no
 * case-collision hashing — the entire lockfile ASSUMPTION ledger
 * retires with the files.
 *
 * Roles: 'drain' (one drain per store — efficiency, not correctness:
 * G3's claims make two drains safe, just wasteful), 'ns:<namespace>'
 * (the product's same-namespace second-server refusal, plus sweep
 * singularity), 'sweep:<namespace>' (transient, taken at sweep fire —
 * library writers hold no standing role, amendment 7).
 *
 * Every mutation runs in an immediate transaction; acquire is
 * upsert-if-absent-or-expired-or-mine (a re-acquire past the freshness
 * window heartbeats; within it, it is a deliberate no-op — see
 * tryAcquire); renewAll is renew-ONLY (never acquires); release is
 * delete-if-mine inside the write transaction, so the restart race the
 * lockfile unlink carried (multi-user.md amendment 9) cannot occur.
 */

/** One host's clock for all claimants (WAL local-FS ceiling), so these
 *  compare cleanly. Renewal must run several times per TTL. */
export const DRAIN_LEASE_TTL_SECS = 60
/** Short enough that a SIGKILLed server frees its namespace within
 *  ~1.5 minutes; the renewal timer (not tool traffic) is the heartbeat,
 *  so an idle server never expires while alive. */
export const NS_LEASE_TTL_SECS = 90
/** Covers one long sweep; released explicitly at sweep end. */
export const SWEEP_LEASE_TTL_SECS = 300
export const LEASE_RENEW_INTERVAL_MS = 20_000

export interface LeaseRow {
  role: string
  holderPid: number
  holderHost: string
  holderLabel: string | null
  acquiredAt: number
  heartbeatAt: number
  ttlSecs: number
}

/** Doctor's view (C-review finding 10): who holds which role, one
 *  SELECT — works on a read-only handle. `live` is computed against
 *  this process's clock, the same one holders heartbeat with. */
export function leaseHolders(db: Database): Array<LeaseRow & { live: boolean }> {
  const now = Date.now() / 1000
  const rows = db
    .prepare('SELECT role, holder_pid, holder_host, holder_label, acquired_at, heartbeat_at, ttl_secs FROM leases ORDER BY role')
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    role: String(r.role),
    holderPid: Number(r.holder_pid),
    holderHost: String(r.holder_host),
    holderLabel: r.holder_label == null ? null : String(r.holder_label),
    acquiredAt: Number(r.acquired_at),
    heartbeatAt: Number(r.heartbeat_at),
    ttlSecs: Number(r.ttl_secs),
    live: Number(r.heartbeat_at) + Number(r.ttl_secs) > now,
  }))
}

/**
 * Is `namespace` right now served by a LIVE holder that is this pid on
 * this host? The corroborator behind the hook-side namespace ladder's
 * first rung.
 *
 * A `pid-*.ns.json` annotation is a claim written once at server
 * startup and deliberately never unlinked at exit, so on its own it
 * proves nothing: `process.kill(pid, 0)` answers "some process holds
 * this number", and after the OS recycles a SIGKILLed server's pid
 * that answer is a lie the ladder cannot see through. This is the
 * ledger's own principle applied to the annotation — liveness is
 * heartbeat expiry, not pid existence — and it bounds a dead server's
 * lie to one TTL (90s) instead of the annotation's staleness window.
 *
 * `holder_host` is compared because the lease table is shared state and
 * pids are only meaningful per host; the WAL local-FS ceiling makes a
 * foreign host unlikely, not impossible.
 *
 * A false answer is not always a dead server. Since amendment 8
 * (2026-08-20, tests/server/design/store-as-arbiter.md §8) a server may
 * SERVE a namespace without holding its lease — the claim is primary,
 * not exclusive — and such a server's pid annotation deliberately fails
 * this corroboration, because the lease names the other pid. Its hooks
 * then ride the causal session rung or stamp NULL, and both route
 * correctly: NULL drains into the same serving namespace. Widening this
 * to accept non-holders would re-admit precisely the unverifiable pid
 * claim the paragraph above rejects — it is the design, not a gap.
 *
 * Read-only: one primary-key lookup, safe on a read-only handle and on
 * the hook path, which already holds the database open.
 */
export function nsLeaseLiveFor(
  // Structural, not the persistence `Database`: the hook path holds a
  // raw better-sqlite3 handle, and this needs exactly one read.
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  namespace: string,
  pid: number,
  host: string,
): boolean {
  let row: Record<string, unknown> | undefined
  try {
    row = db
      .prepare('SELECT holder_pid, holder_host, heartbeat_at, ttl_secs FROM leases WHERE role = ?')
      .get(`ns:${namespace}`) as Record<string, unknown> | undefined
  } catch {
    // A store older than migration 021 has no `leases` table, and this
    // runs on the hook path where a throw would cost the whole capture.
    // No table is no corroboration: fall through to the causal rung.
    return false
  }
  if (!row) return false
  if (Number(row.holder_pid) !== pid || String(row.holder_host) !== host) return false
  return Number(row.heartbeat_at) + Number(row.ttl_secs) > Date.now() / 1000
}

/**
 * Best-effort primary-claim attempt (amendment 8, 2026-08-20,
 * tests/server/design/store-as-arbiter.md §8). A live foreign holder is
 * not an error the caller must see — serving no longer depends on
 * winning the claim — while a real database failure (busy, corrupt,
 * read-only filesystem) still surfaces as itself rather than
 * masquerading as contention (program-C review, finding 8). Returns
 * whether the claim is held after the attempt. This is the ONE place
 * the swallow is spelled: serve's per-call lockHook and the corpus
 * bindings both call it, so the contract cannot fork.
 */
export function tryClaim(leases: LeaseClient, role: string, ttlSecs: number): boolean {
  try {
    leases.tryAcquire(role, ttlSecs)
    return true
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err
    return false
  }
}

/** The refusal messages the corpus binds: the namespace one names its
 *  namespace, the drain one names the role. */
function refusalMessage(role: string, holder: { pid: number; host: string; startedAt: string }): string {
  const where = ` on ${holder.host}`
  if (role.startsWith('ns:')) {
    return (
      `Namespace '${role.slice(3)}' of this store is in use by pid ${holder.pid} ` +
      `(started ${holder.startedAt}${where}). Only one writer per namespace.`
    )
  }
  if (role === 'drain') {
    return (
      `Store's capture drain is owned by pid ${holder.pid} ` +
      `(started ${holder.startedAt}${where}). Only one drain owner per store.`
    )
  }
  return `Role '${role}' is held by pid ${holder.pid} (started ${holder.startedAt}${where}).`
}

export class LeaseClient {
  private readonly held = new Map<string, number>() // role -> ttlSecs
  /** Wall-clock ms of the last SUCCESSFUL db heartbeat per role — the
   *  freshness gate for the read-first fast paths below. */
  private readonly lastBeat = new Map<string, number>()
  /** Random per-client token: pid+host alone lets two fixed-hostname
   *  container replicas (both pid 1) sharing the store volume mistake
   *  each other's lease for their own and silently co-hold a role — the
   *  configuration the retired pid-probe happened to refuse. The token
   *  makes "mine" mean THIS client, not "someone shaped like me". */
  private readonly token = Math.random().toString(36).slice(2, 14)

  constructor(
    private readonly db: Database,
    private readonly identity: { pid: number; host: string; label?: string },
  ) {}

  /** Acquire (or heartbeat, when already mine) a role. Throws
   *  StoreLockedError naming the live foreign holder on refusal.
   *
   *  The read-before-write economy (pass-2 cleanup ruling 2026-08-15,
   *  reshaped at pass 3 — this runs on EVERY tool call via lockHook,
   *  which was ~21k write transactions a day on an idle session): every
   *  call READS the row (a probe without in-memory shortcuts, so an
   *  out-of-band row loss or foreign takeover is seen on the very next
   *  call, exactly as before the economy), and the WRITE transaction
   *  runs only when the read cannot settle it — a stale own-heartbeat,
   *  a missing/expired row, or a race the write re-checks under its own
   *  lock.
   *
   *  Honest note on the refusal path: a live foreign holder is thrown
   *  from the plain read, so there the read IS the decision. A call
   *  racing a concurrent release() can therefore see the pre-delete row
   *  and refuse spuriously once; the next call acquires. Accepted
   *  (pass-3 disposition): refusals self-heal per call by design, and
   *  taking the write lock just to throw was the measured harm. */
  tryAcquire(role: string, ttlSecs: number): void {
    const now = Date.now() / 1000
    const probe = this.readRow(role)
    const probeMine = probe !== undefined && String(probe.holder_token) === this.token
    const probeLive = probe !== undefined && Number(probe.heartbeat_at) + Number(probe.ttl_secs) > now
    if (probeMine && probeLive) {
      const beat = this.lastBeat.get(role)
      if (beat !== undefined && Date.now() - beat < LEASE_RENEW_INTERVAL_MS) {
        this.held.set(role, ttlSecs)
        return
      }
      // fall through: mine but heartbeat-stale — write to renew.
    } else if (probe !== undefined && !probeMine && probeLive) {
      throw this.refusal(role, probe)
    }
    this.db.transaction(() => {
      const now = Date.now() / 1000
      const row = this.readRow(role)
      const mine = row !== undefined && String(row.holder_token) === this.token
      if (row !== undefined && !mine && Number(row.heartbeat_at) + Number(row.ttl_secs) > now) {
        throw this.refusal(role, row)
      }
      // acquired_at survives a self-renewal — it is the "started" the
      // refusal message shows others.
      const acquiredAt = mine ? Number(row!.acquired_at) : now
      this.db
        .prepare(
          `INSERT INTO leases (role, holder_pid, holder_host, holder_token, holder_label, acquired_at, heartbeat_at, ttl_secs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(role) DO UPDATE SET
             holder_pid = excluded.holder_pid, holder_host = excluded.holder_host,
             holder_token = excluded.holder_token, holder_label = excluded.holder_label,
             acquired_at = excluded.acquired_at,
             heartbeat_at = excluded.heartbeat_at, ttl_secs = excluded.ttl_secs`,
        )
        .run(role, this.identity.pid, this.identity.host, this.token, this.identity.label ?? null, acquiredAt, now, ttlSecs)
    })
    this.held.set(role, ttlSecs)
    this.lastBeat.set(role, Date.now())
  }

  private readRow(role: string): {
    holder_pid: number; holder_host: string; holder_token: string
    acquired_at: number; heartbeat_at: number; ttl_secs: number
  } | undefined {
    return this.db
      .prepare('SELECT holder_pid, holder_host, holder_token, acquired_at, heartbeat_at, ttl_secs FROM leases WHERE role = ?')
      .get(role) as ReturnType<LeaseClient['readRow']>
  }

  private refusal(role: string, row: { holder_pid: number; holder_host: string; acquired_at: number }): StoreLockedError {
    const holder = {
      pid: Number(row.holder_pid),
      host: String(row.holder_host),
      startedAt: new Date(Number(row.acquired_at) * 1000).toISOString(),
    }
    return new StoreLockedError(refusalMessage(role, holder), holder)
  }

  /** Heartbeat every role this client holds — RENEW-ONLY, never
   *  acquire: a plain UPDATE fenced by our own token. Zero rows changed
   *  means the role expired and was released or taken; it drops from
   *  the held set and is never resurrected here (pass-2 review
   *  2026-08-15: the old tryAcquire-based renew silently re-took an
   *  expired role, letting a stale sweeper resume a stale plan beside
   *  its successor). Re-taking is reserved for the explicit paths —
   *  lockHook and the drain's per-tick attempt.
   *
   *  A renew that THROWS (busy store, closing handle) is swallowed per
   *  role with the role kept: one contended role must never abort the
   *  remaining heartbeats, and the TTL bounds the damage. Residual,
   *  stated: during that busy window holds() can read true for a role
   *  whose row has expired. */
  renewAll(): void {
    for (const [role] of this.held) {
      try {
        const changed = this.db.transaction(() =>
          this.db
            .prepare('UPDATE leases SET heartbeat_at = ? WHERE role = ? AND holder_token = ?')
            .run(Date.now() / 1000, role, this.token).changes,
        )
        if (changed === 0) {
          this.held.delete(role)
          this.lastBeat.delete(role)
        } else {
          this.lastBeat.set(role, Date.now())
        }
      } catch {
        // busy etc: keep the role; the next tick retries.
      }
    }
  }

  /** Whether this client believes it still holds `role` — current as of
   *  the last tryAcquire/renewAll/release. The sweep checks this after
   *  each heartbeat: a role renewAll dropped means another holder has
   *  it, and work gated on the role must ABORT, not continue
   *  (release-diff review 2026-08-15 — a sweeper that lost sweep:<ns>
   *  kept archiving and deleting alongside its successor). */
  holds(role: string): boolean {
    return this.held.has(role)
  }

  /** FAIL-CLOSED heartbeat for one role: true only when the renew
   *  UPDATE demonstrably succeeded. A thrown renew (busy store) returns
   *  false — for work gated on singularity, a busy signal is itself
   *  evidence of a competing writer and must read as "not proven mine",
   *  never as a go-ahead (pass-3 review 2026-08-15: renewAll's swallow
   *  let a stalled sweeper resume beside its successor precisely when
   *  the successor held the write lock). The role stays in `held` on a
   *  throw — the caller aborts its plan; release/TTL settle the row. */
  renewStrict(role: string): boolean {
    try {
      const changed = this.db.transaction(() =>
        this.db
          .prepare('UPDATE leases SET heartbeat_at = ? WHERE role = ? AND holder_token = ?')
          .run(Date.now() / 1000, role, this.token).changes,
      )
      if (changed === 0) {
        this.held.delete(role)
        this.lastBeat.delete(role)
        return false
      }
      this.lastBeat.set(role, Date.now())
      return true
    } catch {
      return false
    }
  }

  /** Delete-if-mine, inside the write transaction (no restart race). */
  release(role: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM leases WHERE role = ? AND holder_token = ?')
        .run(role, this.token)
    })
    this.held.delete(role)
    this.lastBeat.delete(role)
  }

  releaseAll(): void {
    for (const role of Array.from(this.held.keys())) this.release(role)
  }
}
