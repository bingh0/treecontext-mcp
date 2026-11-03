/**
 * A hook's waits on the store end at its deadline by the clock (owner
 * ruling 2026-11-03).
 *
 * SQLite's own busy handler counts a busy_timeout by adding up the sleeps
 * it asked for (1, 2, 5, 10 … ms), never by reading the clock. Where a
 * short sleep oversleeps, as on a loaded macOS runner, the wait runs past
 * its budget: CI run 41670918705 measured a locked store adding 13.6 s to
 * session-start against its 7 s, and a 1 s guard read waiting 2.2 s. VS
 * Code kills a hook at 15 s. So a hook never hands SQLite a whole budget:
 * every hook connection's busy_timeout is a short slice
 * (HOOK_BUSY_SLICE_MS), and the budget is an absolute moment this module
 * checks against Date.now() between slices. The overrun is then at most
 * one slice's oversleep, on every OS.
 *
 * Two ways in, one loop (retryUntil):
 *  - withHookDeadline(db, deadlineAt, fn): the primitive. Runs a unit
 *    that is safe to repeat (a whole open, a whole transaction, a whole
 *    read), and on a busy error rolls back the transaction the unit left
 *    open and runs it again, until the deadline.
 *  - hookHandle(raw, deadlineAt): the connection openHookDb returns. Each
 *    statement run on it outside a transaction is its own unit through
 *    the same loop, against the connection's deadline: a prepare, a run,
 *    a get, an all, a single-statement exec (BEGIN IMMEDIATE among them,
 *    which is where an immediate transaction meets a lock). That is the
 *    part that is safe to retry: an autocommit statement that came back
 *    busy wrote nothing (SQLite: "if the statement is a COMMIT or occurs
 *    outside of an explicit transaction, then you can retry the
 *    statement"), so no committed write is ever run twice, however many
 *    autocommit statements a hooks-door call runs in a row. Inside a
 *    transaction a statement is never retried alone: it waits one slice
 *    and its busy error goes to the transaction's owner, which rolls back
 *    (FlatStore's door calls are each one immediate transaction, which
 *    takes its lock at BEGIN, so in WAL mode the wait happens there; a
 *    deferred BEGIN, whose wait would fall inside, is refused). A script
 *    of several statements is never retried whole either: the first may
 *    have committed. Every hook site (the open and its pragmas,
 *    the bootstrap, writeStaging, the guard reads, session-start's reads,
 *    the hooks door through FlatStore) runs on such a connection, so no
 *    site can be missed by a budget change again.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { primaryCode, SQLITE_BUSY } from '../persistence/node-sqlite.js'

/** The busy_timeout of every hook connection: the longest single wait
 *  SQLite's own arithmetic is trusted with. Short, so its oversleep is
 *  small; long enough that a busy store costs a hook tens of pragma
 *  statements, not thousands. */
export const HOOK_BUSY_SLICE_MS = 100

/** What the primitive needs of a connection. A raw DatabaseSync and a
 *  hook handle both have it. */
export interface DeadlineHandle {
  exec(sql: string): unknown
  readonly isTransaction: boolean
}

/** A busy error, as node:sqlite throws it: SQLITE_BUSY by its primary code
 *  (the extended SQLITE_BUSY_RECOVERY, _SNAPSHOT, _TIMEOUT included), or
 *  "database is locked" by its text when the code was lost on the way. */
export function isHookBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (primaryCode(err) === SQLITE_BUSY) return true
  return /SQLITE_BUSY|database is locked/i.test(err.message)
}

/** A hook handle's state: the raw connection under it, the moment its
 *  waits end, and the busy_timeout last set on it (null when a statement
 *  run through it may have set another). */
interface HandleState {
  raw: DatabaseSync
  deadlineAt: number
  busySet: number | null
  /** A write connection (not a read-only guard): an open made while it is
   *  open waits what is left of it (openWriteDeadline). */
  write: boolean
}

const STATES = new WeakMap<object, HandleState>()

/** The write handles open in this process right now. */
const OPEN_WRITES = new Set<HandleState>()

/** The least a later phase is ever given: hookBudgetLeftMs's floor, so a
 *  phase behind an exhausted one still gets a few slices, not one 1 ms try. */
export const HOOK_DEADLINE_FLOOR_MS = 100

/**
 * The deadline an open made while this process already holds a hook write
 * connection waits on: what is left of the soonest such connection's
 * deadline, never below HOOK_DEADLINE_FLOOR_MS from now; null when none is
 * open. This is the "a second open waits what is left of the budget, never
 * a fresh one" rule as one rule rather than a choice at each site: a
 * staging write behind the hooks door's writes (subagent-stop.ts), behind
 * session-start's reads (shared.ts buildRehydrationPayload), or inside a
 * worker's stop (stop.ts) opens while that connection is open, and so
 * inherits its deadline. A long-lived host (the opencode plugin) that opens
 * one connection per event holds none between them, so each event's first
 * open has its own budget.
 */
export function openWriteDeadline(): number | null {
  let soonest: number | null = null
  for (const s of OPEN_WRITES) {
    // A connection closed under the handle (not through it) holds nothing.
    if (!s.raw.isOpen) { OPEN_WRITES.delete(s); continue }
    soonest = soonest === null ? s.deadlineAt : Math.min(soonest, s.deadlineAt)
  }
  return soonest === null ? null : Math.max(soonest, Date.now() + HOOK_DEADLINE_FLOOR_MS)
}

/** The busy_timeout for the next wait: a slice, never past the deadline,
 *  never 0 (which would turn SQLite's wait off rather than shorten it). */
export function busySliceUntil(deadlineAt: number): number {
  return Math.max(1, Math.min(HOOK_BUSY_SLICE_MS, deadlineAt - Date.now()))
}

function setBusy(raw: DeadlineHandle, state: HandleState | null, ms: number): void {
  if (state !== null && state.busySet === ms) return
  raw.exec(`PRAGMA busy_timeout = ${ms}`)
  if (state !== null) state.busySet = ms
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The one loop. A unit entered inside a transaction is that transaction's
 *  to retry: it runs once and its busy error goes up. */
function retryUntil<T>(raw: DeadlineHandle, deadlineAt: number, state: HandleState | null, fn: () => T): T {
  const owned = !raw.isTransaction
  for (;;) {
    const began = Date.now()
    const slice = busySliceUntil(deadlineAt)
    setBusy(raw, state, slice)
    try {
      return fn()
    } catch (err) {
      if (!owned || !isHookBusy(err)) throw err
      // The unit's own transaction, if it left one open, goes before the
      // unit runs again: nothing of a failed attempt is kept.
      if (raw.isTransaction) {
        try { raw.exec('ROLLBACK') } catch { /* already gone */ }
      }
      const now = Date.now()
      if (now >= deadlineAt) throw err
      // A busy error that came back before its slice was up (SQLite skips
      // the busy handler on a deadlock or a stale snapshot) waits out the
      // rest of the slice, so the loop never spins.
      const rest = Math.min(slice - (now - began), deadlineAt - now)
      if (rest > 0) sleepMs(rest)
    }
  }
}

/**
 * Run `fn`, a unit that is safe to run again (a whole open, a whole
 * transaction, a whole read), until it returns or `deadlineAt` (an
 * absolute moment, Date.now()'s clock) has passed: busy_timeout is set to
 * min(HOOK_BUSY_SLICE_MS, what is left, at least 1 ms) before each try,
 * and a busy error rolls back the transaction the unit left open and tries
 * again while the clock is short of the deadline; past it, the busy error
 * is thrown as the caller's failure path expects. On a hook handle the
 * handle's own deadline is narrowed to this one while `fn` runs (never
 * widened), so the statements inside wait no longer than the unit.
 */
export function withHookDeadline<T>(db: DeadlineHandle, deadlineAt: number, fn: () => T): T {
  const state = STATES.get(db) ?? null
  if (state === null) return retryUntil(db, deadlineAt, null, fn)
  const outer = state.deadlineAt
  state.deadlineAt = Math.min(outer, deadlineAt)
  try {
    return retryUntil(state.raw, state.deadlineAt, state, fn)
  } finally {
    state.deadlineAt = outer
  }
}

/** The moment a hook handle's waits end, or null for a connection that is
 *  no hook handle. */
export function hookDeadlineOf(db: object): number | null {
  return STATES.get(db)?.deadlineAt ?? null
}

/** A BEGIN that starts a DEFERRED transaction (BEGIN, BEGIN DEFERRED, with
 *  or without TRANSACTION). */
const DEFERRED_BEGIN = /^\s*BEGIN(\s+DEFERRED)?(\s+TRANSACTION)?\s*;?\s*$/i

/** Why a hook handle refuses a deferred BEGIN. A deferred transaction takes
 *  its locks at its first read or write, inside the transaction, where a
 *  statement is never retried alone (one slice, then the busy error goes
 *  to the transaction's owner); its read-then-write upgrade can also come
 *  back busy at once (SQLITE_BUSY_SNAPSHOT). A hook's transactions are
 *  IMMEDIATE (or EXCLUSIVE), whose wait is their BEGIN, run through the
 *  deadline loop. */
export const DEFERRED_BEGIN_REFUSED =
  'a hook connection refuses a deferred BEGIN: its wait would fall inside the transaction, outside the deadline loop; use BEGIN IMMEDIATE'

function refuseDeferredBegin(sql: string): void {
  if (DEFERRED_BEGIN.test(sql)) throw new Error(DEFERRED_BEGIN_REFUSED)
}

/** Bring a hook handle's deadline forward to `deadlineAt` if that is
 *  sooner (a second phase that waits what is left of the hook's budget,
 *  never a fresh one); a no-op on any other connection. */
export function narrowHookDeadline(db: object, deadlineAt: number): void {
  const state = STATES.get(db)
  if (state) state.deadlineAt = Math.min(state.deadlineAt, deadlineAt)
}

/** One statement, by its text: a script with an inner `;` is not one,
 *  and is never retried whole (its first statement may have committed). A
 *  `;` inside a string literal reads as a script, the safe direction. */
function isSingleStatement(sql: string): boolean {
  return !sql.trim().replace(/;+\s*$/, '').includes(';')
}

const BUSY_PRAGMA = /busy_timeout/i

/**
 * The connection a hook holds: `raw` with every statement run through the
 * deadline loop (see the module comment for which are retried and why).
 * It is the DatabaseSync itself to every caller (FlatStore's wrapper, the
 * registry's helpers, the tests), whose methods run on the raw handle; a
 * statement that writes busy_timeout through it is run, and the handle
 * sets its slice again before the next one.
 */
export function hookHandle(raw: DatabaseSync, deadlineAt: number, opts?: { write?: boolean }): DatabaseSync {
  const state: HandleState = { raw, deadlineAt, busySet: null, write: opts?.write ?? false }
  if (state.write) OPEN_WRITES.add(state)
  const guarded = <T>(fn: () => T): T => {
    if (raw.isTransaction) {
      setBusy(raw, state, busySliceUntil(state.deadlineAt))
      return fn()
    }
    return retryUntil(raw, state.deadlineAt, state, fn)
  }
  const once = <T>(fn: () => T): T => {
    setBusy(raw, state, busySliceUntil(state.deadlineAt))
    return fn()
  }
  const afterBusyPragma = (sql: string): void => { if (BUSY_PRAGMA.test(sql)) state.busySet = null }
  const statement = (stmt: StatementSync, sql: string): StatementSync => new Proxy(stmt, {
    get(target, key) {
      if (key === 'run' || key === 'get' || key === 'all') {
        const method = target[key].bind(target) as (...a: unknown[]) => unknown
        return (...args: unknown[]) => {
          try { return guarded(() => method(...args)) } finally { afterBusyPragma(sql) }
        }
      }
      if (key === 'iterate') {
        // Lazy: a busy error can come at any step, and a half-read
        // iteration cannot be run again. One slice, never retried.
        const method = target.iterate.bind(target) as (...a: unknown[]) => unknown
        return (...args: unknown[]) => once(() => method(...args))
      }
      const v = Reflect.get(target, key, target) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  const handle = new Proxy(raw, {
    get(target, key) {
      if (key === 'prepare') {
        // Preparing reads the schema, which a lock can hold up.
        return (sql: string) => { refuseDeferredBegin(sql); return statement(guarded(() => target.prepare(sql)), sql) }
      }
      if (key === 'exec') {
        return (sql: string) => {
          refuseDeferredBegin(sql)
          try {
            return isSingleStatement(sql) ? guarded(() => target.exec(sql)) : once(() => target.exec(sql))
          } finally { afterBusyPragma(sql) }
        }
      }
      if (key === 'close') {
        return () => { OPEN_WRITES.delete(state); target.close() }
      }
      const v = Reflect.get(target, key, target) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  STATES.set(handle, state)
  return handle
}
