/**
 * Session beacon: PID-keyed Claude Code session identity.
 *
 * docs/session-identity.md §3 (Fix 1). Written by the
 * SessionStart/UserPromptSubmit hooks (ts/src/hooks/session-start.ts,
 * ts/src/hooks/user-prompt-submit.ts) and read lazily by the MCP server
 * (ts/src/server/server.ts) to resolve `_cc_session_id` on insert — the real
 * Claude Code session UUID, as opposed to `_session_id`/`_conn_id` (the MCP
 * connection id, which is a different, disjoint namespace).
 *
 * Why a PID file works as an exact, race-free key: both the hook wrapper
 * scripts and the MCP launcher wrapper (see src/server/installer.ts,
 * `hookScriptContent` / `mcpLauncherScriptContent`) `exec` into node —
 * replacing the shell process image rather than forking a child — so the
 * node process's own `process.ppid` equals the *claude* process's PID in
 * both cases. A hook process and the MCP server process spawned by the same
 * claude instance therefore agree on one PID with no IPC or handshake.
 * For hooks that also needs the settings command itself to exec (D251):
 * Claude Code runs it through `/bin/sh -c`, and dash forks a bare quoted
 * path, which put a short-lived sh between claude and every hook until
 * install began writing `exec "<wrapper>"`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isCliAddressableStoreName } from './tools/store-name.js'
import { dirname, join } from 'node:path'
import { dbg } from './debug.js'

export interface SessionBeacon {
  cc_session_id: string
  cwd: string
  started_at: number
  last_seen: number
}

/** Attribution sources for `_cc_session_src`. The resolver below returns
 *  the first four; `'echo'` is stamped only by the drain's V2 echo heal
 *  (docs/session-identity.md §7.3 — causal, post-insert), never resolved
 *  at insert time. */
export type CcSessionSrc = 'pid' | 'explicit' | 'beacon-unanimous' | 'beacon-ambiguous' | 'echo'

export interface CcSessionResolution {
  ccSessionId: string | null
  src: CcSessionSrc | null
  /** Set (true) only for the beacon-ambiguous rung — a disclosed best guess. */
  ambiguous?: boolean
  /** Distinct cc_session_ids of the live beacons considered, when ambiguous. */
  candidates?: string[]
}

// Rungs 3a/3b (beacon-unanimous / beacon-ambiguous): only consider a beacon
// "live" if seen within this window — explicitly specified in the design
// note ("most-recently-seen live beacon within a 15 min staleness bound").
const AMBIGUOUS_LIVE_MS = 15 * 60 * 1000

// Rung 1 (pid): guard against trusting a beacon file long after its claude
// process exited and the OS recycled the PID for something unrelated. The
// design note requires *a* staleness bound here ("Guards: staleness bound
// (PID reuse)") but does not pin a number — the only concrete figure in the
// doc (15 min, above) is scoped explicitly to rung 3's "most-recently-seen"
// tie-break among several live candidates, a different problem than rung
// 1's single exact-pid-match case. This 24h figure is an ASSUMPTION made to
// ship a working guard rather than leave rung 1 unguarded; it is a
// last-resort safety net against a multi-day-stale accidental pid
// collision, not a routine check. Flagged in the build report for the
// owner to confirm or replace.
const PID_MATCH_STALE_MS = 24 * 60 * 60 * 1000

export function sessionsDir(dbPath: string): string {
  return join(dirname(dbPath), 'sessions')
}

function beaconPath(dbPath: string, claudePid: number): string {
  return join(sessionsDir(dbPath), `pid-${claudePid}.json`)
}

function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (err) {
    dbg('session-beacon', 'atomic write failed', { path, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

function readBeaconFile(path: string): SessionBeacon | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as SessionBeacon).cc_session_id === 'string'
      && typeof (parsed as SessionBeacon).last_seen === 'number'
    ) {
      return parsed as SessionBeacon
    }
    return null
  } catch {
    return null
  }
}

/**
 * Write or refresh the PID beacon for the calling claude process.
 *
 * `rewrite: true` (SessionStart — including resume, which fires SessionStart
 * again with a new session id for the same pid) always overwrites
 * cc_session_id/started_at. `rewrite: false` (UserPromptSubmit) only bumps
 * `last_seen`, preserving the existing cc_session_id/started_at/cwd; if no
 * beacon exists yet for this pid, it creates one (defensive — covers a
 * SessionStart hook that failed to fire or hasn't landed yet).
 */
export function writeSessionBeacon(
  dbPath: string,
  claudePid: number,
  ccSessionId: string,
  cwd: string,
  opts: { rewrite: boolean },
): void {
  const path = beaconPath(dbPath, claudePid)
  const now = Date.now() / 1000
  if (!opts.rewrite) {
    const existing = readBeaconFile(path)
    if (existing) {
      atomicWriteJson(path, { ...existing, last_seen: now })
      return
    }
  }
  const beacon: SessionBeacon = { cc_session_id: ccSessionId, cwd, started_at: now, last_seen: now }
  atomicWriteJson(path, beacon)
}

export function readSessionBeacon(dbPath: string, claudePid: number): SessionBeacon | null {
  return readBeaconFile(beaconPath(dbPath, claudePid))
}

// ── Namespace annotation (C1 capture attribution) ────────────────────
//
// tests/server/design/multi-user.md. The serving process knows
// `--namespace`; hooks do not. The bridge is the same exec-into-node PID
// identity the session beacon exploits: the stdio server and every hook
// spawned by one claude instance agree on `process.ppid`.
//
// WIN32 NOTE (release-diff review 2026-08-15; closed by v2 chunk C):
// the .cmd wrappers cannot exec, so the server and every hook see a
// DIFFERENT intermediate cmd.exe as their parent and this ppid rung
// never fires on Windows. The session-keyed annotation below
// (docs/session-identity.md §7.8) is the primary channel there — the
// drain publishes it from echo evidence and hooks resolve by payload
// session id, no ancestry. The ppid rung stays as the instant-from-
// startup fallback where exec chains work.
//
// A SEPARATE file, not a field in the session beacon: the beacon has one
// writer class (hooks; SessionStart rewrites it wholesale), so a
// server-owned field there would be clobbered by the next rewrite. One
// file, one writer — hooks own `pid-N.json`, the server owns
// `pid-N.ns.json`.

export interface NamespaceAnnotation {
  namespace: string
  /** The serving process's own pid. NOT a liveness key on its own —
   *  the hook honors this annotation only when the pid is corroborated
   *  as the CURRENT live holder of `ns:<namespace>` (see
   *  resolveHookNamespace). A dead server's namespace is unresolved,
   *  never a guess. */
  server_pid: number
  written_at: number
}

function nsAnnotationPath(dbPath: string, claudePid: number): string {
  return join(sessionsDir(dbPath), `pid-${claudePid}.ns.json`)
}

// RETIRED (owner ruling 2026-08-16). The pid-reuse threat this bounded
// is now answered exactly rather than approximately: the hook
// corroborates the annotation against the LIVE ns-lease holder, so a
// SIGKILLed server's claim dies with its heartbeat (one 90s TTL) and a
// recycled pid cannot revive it. The 24h bound was measured from
// `written_at`, stamped once at startup and never refreshed, so it also
// rejected servers legitimately alive for more than a day — an
// approximation wrong in both directions. See resolveHookNamespace.

/** Written by the stdio server at startup (rewritten on restart, so a
 *  relaunch under a different --namespace wins). Never throws — the
 *  annotation is advisory; a server must not die for it.
 *
 *  There is deliberately NO shutdown unlink (program-C review, finding
 *  9): a read-compare-unlink at exit races a restarted server's
 *  atomic-rename write, and losing that race deletes the NEW server's
 *  annotation for the rest of its session. Like the session beacons in
 *  this file, annotations are never removed — a leftover is defused by
 *  the liveness and staleness guards in resolveHookNamespace, and the
 *  next server for the same claude pid overwrites it. */
export function writeNamespaceAnnotation(dbPath: string, claudePid: number, namespace: string): void {
  const annotation: NamespaceAnnotation = {
    namespace,
    server_pid: process.pid,
    written_at: Date.now() / 1000,
  }
  try {
    atomicWriteJson(nsAnnotationPath(dbPath, claudePid), annotation)
  } catch (err) {
    dbg('session-beacon', 'namespace annotation write failed (advisory — continuing)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function readNamespaceAnnotation(dbPath: string, claudePid: number): NamespaceAnnotation | null {
  const path = nsAnnotationPath(dbPath, claudePid)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as NamespaceAnnotation).namespace === 'string'
      && typeof (parsed as NamespaceAnnotation).server_pid === 'number'
    ) {
      return parsed as NamespaceAnnotation
    }
    return null
  } catch {
    return null
  }
}

// ── Session-keyed namespace annotation (V2 chunk C, ────────────────────
//    docs/session-identity.md §7.8)
//
// The pid bridge above cannot exec on Windows, so the server and every
// hook see different intermediate shells and rung 1 below never fires
// there. The session-keyed file removes the pid from the path entirely:
// the DRAIN publishes (session → namespace) from exact echo evidence —
// a status echo's own output names the serving namespace; a healed
// insert names the healed row's tree — and hooks resolve by the session
// id their payload already carries. Never published from a beacon
// guess: a wrong session-keyed annotation would misroute capture rows
// silently, strictly worse than the disclosed serving-namespace
// fallback. No liveness or staleness guard: session ids are never
// recycled (a resume mints a new id), so the file can only ever
// describe the session it names. One file, one writer — only the drain
// owner writes `session-*.ns.json`, mirroring the C1 discipline.

export interface SessionNamespaceAnnotation {
  namespace: string
  derived_from: 'status-echo' | 'insert-heal'
  written_at: number
}

/** Session ids come from hook payloads — filesystem-hostile values must
 *  never become path segments. Real CC ids are uuids; anything outside
 *  this shape is refused (no write, no read), never sanitized into a
 *  colliding name. */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function sessionNsAnnotationPath(dbPath: string, sessionId: string): string {
  return join(sessionsDir(dbPath), `session-${sessionId}.ns.json`)
}

/** Written by the drain owner when an echo proves which namespace a
 *  session's server serves. Advisory like the pid annotation: never
 *  throws, and newer evidence overwrites. Both value guards live here
 *  AND on read — an annotation is honored only when it could have been
 *  legitimately written (review 2026-08-15, C#3/C#4: a corrupt or
 *  hand-edited file must degrade to unresolved, never poison every
 *  hook fire into the dead-letter path). Last-writer-wins is by DRAIN
 *  order: a session genuinely working two lanes of one store can flap
 *  between them — disclosed in §7.8, and moot wherever rung 1 resolves
 *  first. */
export function writeSessionNamespaceAnnotation(
  dbPath: string,
  sessionId: string,
  namespace: string,
  derivedFrom: SessionNamespaceAnnotation['derived_from'],
): void {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return
  if (!isCliAddressableStoreName(namespace)) return
  const annotation: SessionNamespaceAnnotation = {
    namespace,
    derived_from: derivedFrom,
    written_at: Date.now() / 1000,
  }
  try {
    atomicWriteJson(sessionNsAnnotationPath(dbPath, sessionId), annotation)
  } catch (err) {
    dbg('session-beacon', 'session namespace annotation write failed (advisory — continuing)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function readSessionNamespaceAnnotation(dbPath: string, sessionId: string): SessionNamespaceAnnotation | null {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return null
  const path = sessionNsAnnotationPath(dbPath, sessionId)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as SessionNamespaceAnnotation).namespace === 'string'
      && isCliAddressableStoreName((parsed as SessionNamespaceAnnotation).namespace)
    ) {
      return parsed as SessionNamespaceAnnotation
    }
    return null
  } catch {
    return null
  }
}

/** GC for `session-*.ns.json` (review 2026-08-15, C#5): session ids
 *  never recycle, so unlike pid files nothing ever overwrites these —
 *  without a sweep the directory grows one file per session forever,
 *  taxing the readdir that rung-3 identity resolution performs on
 *  every insert. Files older than the TTL by their own `written_at`
 *  (mtime when unreadable) can only describe finished sessions.
 *  Called from the drain owner's sweep tick — same single-writer
 *  discipline as publishing. Returns the number removed. */
export function sweepSessionNamespaceAnnotations(dbPath: string, ttlSecs: number): number {
  const dir = sessionsDir(dbPath)
  if (!existsSync(dir)) return 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const now = Date.now() / 1000
  let removed = 0
  for (const name of names) {
    if (!/^session-.+\.ns\.json$/.test(name)) continue
    const path = join(dir, name)
    let writtenAt: number | null = null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const w = (parsed as SessionNamespaceAnnotation | null)?.written_at
      if (typeof w === 'number') writtenAt = w
    } catch { /* unreadable — fall through to mtime */ }
    try {
      const age = now - (writtenAt ?? statSync(path).mtimeMs / 1000)
      if (age > ttlSecs) {
        unlinkSync(path)
        removed++
      }
    } catch { /* raced or unreadable — leave it for the next sweep */ }
  }
  return removed
}

/**
 * Hook-side resolution ladder (mirrors the identity ladder's honesty
 * rungs; design note §C1 + §7.8, RATIFIED order restored by owner
 * ruling 2026-08-20). First hit wins:
 *   1. session-keyed annotation for the hook's OWN payload session id
 *      (§7.8) → that namespace. Causal — published only from echo
 *      evidence — pid-free (the channel that works where exec chains
 *      break: win32 .cmd wrappers, where rung 2 never fires), and
 *      session ids are never recycled, so it can only ever describe
 *      the session it names. It outranks the pid rung because the pid
 *      file is structurally shared: every server spawned by one claude
 *      pid writes the SAME pid-<claudePid>.ns.json, so in the
 *      multi-lane shape §7.8 exists for, rung 2 answers with whichever
 *      server started last — corroborated or not, that is ancestry
 *      inference, and it must not preempt the session's own proof.
 *      Disclosed residual (review 2026-08-15 C#2, ruled 2026-08-20):
 *      this file refreshes only when an echo drains, so after a
 *      mid-session relaunch under a different --namespace it may name
 *      the previous run until the session's next status/insert echo —
 *      bounded, self-healing staleness, accepted over the unbounded
 *      misroute the inversion would have introduced.
 *   2. own-ppid annotation whose server is CORROBORATED as still
 *      serving → that namespace. Instant from server startup where
 *      exec chains work — it is what resolves before the first echo
 *      primes rung 1.
 *
 *      `corroborate` is REQUIRED and carries the whole weight of this
 *      rung, so it is a parameter rather than a pid probe here (owner
 *      ruling 2026-08-16). The annotation is written once at startup
 *      and never unlinked at exit, so `process.kill(pid, 0)` — what
 *      this rung used to ask — answers only "some process holds this
 *      number"; once the OS recycles a SIGKILLed server's pid it
 *      answers YES for an unrelated process. Production passes the
 *      ns-lease check (`nsLeaseLiveFor`), whose heartbeat expiry
 *      bounds that lie to one 90s TTL. A caller that cannot
 *      corroborate returns false and this rung stays silent.
 *
 *      There is deliberately no separate staleness bound. The old 24h
 *      one was measured from `written_at`, which is stamped once at
 *      startup and never refreshed — so it also rejected any server
 *      legitimately alive for more than a day. The lease's heartbeat
 *      IS the expiration mechanism, and it is the accurate one
 *      (deletion ratified 2026-08-20).
 *   3. anything else → null. Never read other sessions' or pids'
 *      annotations, never most-recently-seen, never infer — the drain
 *      routes unresolved rows into its own serving namespace visibly at
 *      drain time, not silently at capture time.
 */
export function resolveHookNamespace(
  dbPath: string,
  claudePid: number,
  sessionId: string | null | undefined,
  corroborate: (annotation: NamespaceAnnotation) => boolean,
): string | null {
  if (sessionId) {
    const bySession = readSessionNamespaceAnnotation(dbPath, sessionId)
    if (bySession) return bySession.namespace
  }
  const annotation = readNamespaceAnnotation(dbPath, claudePid)
  if (annotation && corroborate(annotation)) {
    return annotation.namespace
  }
  return null
}

/** All beacons currently on disk for this store, keyed by claude pid. */
export function listSessionBeacons(dbPath: string): Array<{ pid: number; beacon: SessionBeacon }> {
  const dir = sessionsDir(dbPath)
  if (!existsSync(dir)) return []
  const out: Array<{ pid: number; beacon: SessionBeacon }> = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    const m = /^pid-(\d+)\.json$/.exec(name)
    if (!m) continue
    const beacon = readBeaconFile(join(dir, name))
    if (beacon) out.push({ pid: Number(m[1]), beacon })
  }
  return out
}

/**
 * Resolution ladder (docs/session-identity.md §3),
 * first hit wins:
 *   1. pid          — exact match: a beacon whose file is keyed by the
 *                      caller's own claude pid. Race-free, no ambiguity
 *                      flag. Stdio-only (see `stdio` param) — a shared HTTP
 *                      daemon process has no 1:1 relationship with any
 *                      single session's claude process, so process.ppid is
 *                      meaningless there; the design note scopes rung 1 to
 *                      "stdio path (current production)" and calls out
 *                      explicit-header as the daemon/HTTP mechanism.
 *   2. explicit      — caller supplied a Claude Code session id directly
 *                      (daemon/HTTP `X-Treecontext-CC-Session` header).
 *   3a. beacon-unanimous — no pid match, but every live beacon (within
 *                      AMBIGUOUS_LIVE_MS) names the SAME session id. A
 *                      distinct-set of one is certainty, not ambiguity:
 *                      several hook processes wrote beacons under different
 *                      pids, all for one session. No ambiguity flag.
 *                      (v1.2 amendment, 2026-07-24 — before it, this case
 *                      was mislabeled ambiguous with an undeduped
 *                      candidate list of N identical ids.)
 *                      When the caller supplies its `cwd`, rung 3 first
 *                      drops live beacons whose recorded cwd names a
 *                      DIFFERENT directory (v2 adjunct, ruled 2026-08-14:
 *                      a beacon from another project cannot be this
 *                      server's session). Beacons with no cwd recorded
 *                      (legacy files) are kept — dropping them could only
 *                      lose attribution, never correct it. Exact string
 *                      comparison, no normalization: a false mismatch
 *                      degrades to absent (honest), never misattributes.
 *   3b. beacon-ambiguous — live beacons disagree: most-recently-seen wins,
 *                      with `ambiguous: true` and the distinct candidate
 *                      ids disclosed (most-recent-first).
 *   4. absent        — no id. Never guess silently.
 */
export function resolveCcSessionId(
  dbPath: string,
  opts: {
    claudePid: number
    stdio: boolean
    explicitCcSessionId?: string | null
    /** The caller's working directory; when set, rung 3 ignores live
     *  beacons recorded under a different cwd (cross-project kill). */
    cwd?: string | null
  },
): CcSessionResolution {
  if (opts.explicitCcSessionId) {
    return { ccSessionId: opts.explicitCcSessionId, src: 'explicit' }
  }

  const now = Date.now() / 1000

  if (opts.stdio) {
    const own = readSessionBeacon(dbPath, opts.claudePid)
    if (own && (now - own.last_seen) * 1000 <= PID_MATCH_STALE_MS) {
      return { ccSessionId: own.cc_session_id, src: 'pid' }
    }
  }

  const live = listSessionBeacons(dbPath).filter(
    ({ beacon }) =>
      (now - beacon.last_seen) * 1000 <= AMBIGUOUS_LIVE_MS
      // Cross-project narrowing (v2 adjunct): a beacon that names a
      // different directory cannot belong to this server's session.
      // Beacons without a recorded cwd are kept — legacy files, and
      // readBeaconFile does not validate the field.
      && (!opts.cwd || typeof beacon.cwd !== 'string' || beacon.cwd === opts.cwd),
  )
  live.sort((a, b) => b.beacon.last_seen - a.beacon.last_seen)
  // Distinct session ids, most-recent-first. Beacons are keyed by pid, so
  // one session routinely leaves several live beacons — a distinct-set of
  // one is unanimity (rung 3a), not ambiguity.
  const distinct = [...new Set(live.map(({ beacon }) => beacon.cc_session_id))]
  if (distinct.length === 1) {
    return { ccSessionId: distinct[0]!, src: 'beacon-unanimous' }
  }
  if (distinct.length > 1) {
    return {
      ccSessionId: distinct[0]!,
      src: 'beacon-ambiguous',
      ambiguous: true,
      candidates: distinct,
    }
  }

  return { ccSessionId: null, src: null }
}
