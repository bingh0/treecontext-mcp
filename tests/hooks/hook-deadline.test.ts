/**
 * A hook's waits on the store end at its deadline by the clock, on every OS
 * (owner ruling 2026-11-03; CI run 41670918705, where a loaded macOS
 * runner's oversleeping busy waits ran a 7 s budget to 13.6 s).
 *
 * The first block proves the property without trusting the OS's sleeps: a
 * stand-in connection whose every wait sleeps TWICE the busy_timeout it was
 * handed, the way SQLite's own arithmetic overran on that runner. If the
 * deadline were SQLite's arithmetic rather than the clock, these fail on
 * Linux too. The second block holds a real store with
 * tests/helpers/store-locker.cjs.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { withHookDeadline, hookHandle, hookDeadlineOf, narrowHookDeadline, isHookBusy, HOOK_BUSY_SLICE_MS, HOOK_DEADLINE_FLOOR_MS, DEFERRED_BEGIN_REFUSED } from '../../src/hooks/hook-deadline.js'
import { openHookDb, writeStaging, writeSnapshot, buildRehydrationPayload, HOOK_DB_TIMEOUT_MS } from '../../src/hooks/shared.js'
import { registerSelf } from '../../src/persistence/session-registry.js'
import { gitSelfOf } from '../../src/hooks/git-self.js'
import { pragmaValue } from '../../src/persistence/node-sqlite.js'
import { TS_ROOT } from '../journal/proc.js'

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function busyError(): Error {
  const e = new Error('database is locked') as Error & { code: string; errcode: number }
  e.code = 'ERR_SQLITE_ERROR'
  e.errcode = 5
  return e
}

/** A connection whose busy wait oversleeps: every statement run on it
 *  sleeps twice the busy_timeout it was last handed, then reports busy
 *  (or, from attempt `okAt` on, answers). */
function oversleeper(okAt = Infinity): { db: { exec(sql: string): unknown; isTransaction: boolean }; busy: () => number; attempts: () => number; step: () => unknown } {
  let busy = 5000
  let attempts = 0
  const db = {
    isTransaction: false,
    exec(sql: string): unknown {
      const m = /busy_timeout\s*=\s*(\d+)/i.exec(sql)
      if (m) busy = Number(m[1])
      return undefined
    },
  }
  const step = (): unknown => {
    attempts++
    if (attempts >= okAt) return 'answered'
    sleepMs(2 * busy)
    throw busyError()
  }
  return { db, busy: () => busy, attempts: () => attempts, step }
}

describe('withHookDeadline: the deadline is the clock, not SQLite\'s arithmetic', () => {
  const DEADLINE_MS = 600

  it('against a busy wait that oversleeps 2x, it gives up by the deadline plus one slice\'s overrun', () => {
    const f = oversleeper()
    const t0 = Date.now()
    let thrown: unknown = null
    try { withHookDeadline(f.db, t0 + DEADLINE_MS, f.step) } catch (err) { thrown = err }
    const took = Date.now() - t0
    expect(isHookBusy(thrown), String(thrown)).toBe(true)
    // At most one slice past the deadline (the last try's busy_timeout is
    // min(slice, what is left), and it oversleeps by as much again), with
    // 50 ms for the scheduler.
    expect(took, `gave up after ${took} ms against a ${DEADLINE_MS} ms deadline`).toBeLessThanOrEqual(DEADLINE_MS + HOOK_BUSY_SLICE_MS + 50)
    // And it kept trying until the deadline, never giving up at the first
    // busy answer.
    expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - HOOK_BUSY_SLICE_MS)
    expect(f.attempts()).toBeGreaterThan(1)
    // SQLite was never handed more than a slice.
    expect(f.busy()).toBeLessThanOrEqual(HOOK_BUSY_SLICE_MS)
  })

  it('through a hook handle, each statement waits in slices against the connection\'s deadline', () => {
    const f = oversleeper()
    const fakeRaw = {
      isTransaction: false,
      exec: f.db.exec,
      prepare: () => ({ get: f.step, run: f.step, all: f.step }),
    }
    const t0 = Date.now()
    const handle = hookHandle(fakeRaw as unknown as DatabaseSync, t0 + DEADLINE_MS)
    let thrown: unknown = null
    try { handle.prepare('SELECT 1').get() } catch (err) { thrown = err }
    const took = Date.now() - t0
    expect(isHookBusy(thrown), String(thrown)).toBe(true)
    expect(took).toBeLessThanOrEqual(DEADLINE_MS + HOOK_BUSY_SLICE_MS + 50)
    expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - HOOK_BUSY_SLICE_MS)
    // A second statement after the deadline gets one short try, never a
    // fresh budget.
    const t1 = Date.now()
    try { handle.prepare('SELECT 2').get() } catch { /* busy */ }
    expect(Date.now() - t1).toBeLessThanOrEqual(HOOK_BUSY_SLICE_MS)
  })

  it('returns the unit\'s answer once the store answers inside the deadline', () => {
    const f = oversleeper(3)
    const t0 = Date.now()
    expect(withHookDeadline(f.db, t0 + DEADLINE_MS, f.step)).toBe('answered')
    expect(f.attempts()).toBe(3)
    expect(Date.now() - t0).toBeLessThan(DEADLINE_MS)
  })

  it('rolls back the transaction a busy unit left open before running it again', () => {
    const log: string[] = []
    const db = {
      isTransaction: false,
      exec(sql: string): unknown {
        log.push(sql)
        if (sql === 'ROLLBACK') db.isTransaction = false
        return undefined
      },
    }
    let tries = 0
    const out = withHookDeadline(db, Date.now() + DEADLINE_MS, () => {
      tries++
      db.isTransaction = true // the unit's BEGIN
      if (tries < 2) throw busyError()
      db.isTransaction = false // its COMMIT
      return 'committed'
    })
    expect(out).toBe('committed')
    expect(log.filter((s) => s === 'ROLLBACK')).toHaveLength(1)
  })

  it('a busy answer that comes back at once (no busy handler: a stale snapshot, a deadlock) waits out its slice, never spinning', () => {
    const db = { isTransaction: false, exec: (): unknown => undefined }
    let tries = 0
    const t0 = Date.now()
    expect(() => withHookDeadline(db, t0 + DEADLINE_MS, () => { tries++; throw busyError() })).toThrow(/locked/)
    // One try a slice: a spinning loop makes thousands in the same time.
    expect(tries, `${tries} tries in ${Date.now() - t0} ms`).toBeLessThanOrEqual(Math.ceil(DEADLINE_MS / HOOK_BUSY_SLICE_MS) + 2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DEADLINE_MS - 20)
  })

  it('never retries an error that is not busy, nor a unit inside a transaction it does not own', () => {
    const plain = { isTransaction: false, exec: (): unknown => undefined }
    let tries = 0
    expect(() => withHookDeadline(plain, Date.now() + DEADLINE_MS, () => { tries++; throw new Error('no such table: staging') })).toThrow(/no such table/)
    expect(tries).toBe(1)
    const inside = { isTransaction: true, exec: (): unknown => undefined }
    tries = 0
    expect(() => withHookDeadline(inside, Date.now() + DEADLINE_MS, () => { tries++; throw busyError() })).toThrow(/locked/)
    expect(tries).toBe(1)
  })
})

describe('a hook connection\'s rules', () => {
  it('refuses a deferred BEGIN, whose wait would fall inside the transaction, and takes an immediate one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-deadline-'))
    try {
      const db = openHookDb(join(dir, 'treecontext.db'))
      try {
        for (const sql of ['BEGIN', 'begin deferred', 'BEGIN TRANSACTION;', 'BEGIN DEFERRED TRANSACTION']) {
          expect(() => db.exec(sql), sql).toThrow(DEFERRED_BEGIN_REFUSED)
          expect(() => db.prepare(sql), sql).toThrow(DEFERRED_BEGIN_REFUSED)
        }
        expect(db.isTransaction).toBe(false)
        db.exec('BEGIN IMMEDIATE')
        expect(db.isTransaction).toBe(true)
        db.exec('ROLLBACK')
      } finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a write open made while another is open waits what is left of it, never below the floor; once it is closed, a fresh budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-deadline-'))
    const dbPath = join(dir, 'treecontext.db')
    try {
      openHookDb(dbPath).close()
      const first = openHookDb(dbPath, { deadlineAt: Date.now() + 2000 })
      try {
        const second = openHookDb(dbPath)
        try {
          const left = hookDeadlineOf(second)! - Date.now()
          expect(left).toBeLessThanOrEqual(2000)
          expect(left).toBeGreaterThan(1500)
        } finally { second.close() }
        // The first's budget spent: the next phase still gets the floor.
        narrowHookDeadline(first, Date.now() - 1000)
        const late = openHookDb(dbPath)
        try {
          const left = hookDeadlineOf(late)! - Date.now()
          expect(left).toBeGreaterThan(HOOK_DEADLINE_FLOOR_MS - 20)
          expect(left).toBeLessThanOrEqual(HOOK_DEADLINE_FLOOR_MS)
        } finally { late.close() }
      } finally { first.close() }
      const alone = openHookDb(dbPath)
      try {
        expect(hookDeadlineOf(alone)! - Date.now()).toBeGreaterThan(HOOK_DB_TIMEOUT_MS - 500)
      } finally { alone.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a staging write behind a connection that is still open gives up at what is left of it, not a fresh 7 s', () => {
    // The open connection holds the store's write lock itself, so the
    // staging write's connection cannot write until it has given up.
    const dir = mkdtempSync(join(tmpdir(), 'tc-deadline-'))
    const dbPath = join(dir, 'treecontext.db')
    try {
      openHookDb(dbPath).close()
      const holder = openHookDb(dbPath, { deadlineAt: Date.now() + 500 })
      try {
        holder.exec('BEGIN IMMEDIATE')
        const t0 = Date.now()
        writeStaging(dbPath, { sessionId: 's-behind', role: 'user', content: 'behind the door', timestamp: Date.now() / 1000 })
        const took = Date.now() - t0
        expect(took, `the staging write waited ${took} ms behind a connection with 500 ms left`).toBeLessThan(500 + HOOK_BUSY_SLICE_MS + 400)
        holder.exec('ROLLBACK')
      } finally { holder.close() }
      // Dropped, and marked as such.
      expect(readFileSync(join(dir, 'hook-gaps.jsonl'), 'utf8')).toMatch(/s-behind/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('session-start\'s snapshot claim is staged within what is left of the connection that read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-deadline-'))
    const dbPath = join(dir, 'treecontext.db')
    try {
      // Two sessions of one checkout; the first left a recovery snapshot.
      const setup = openHookDb(dbPath)
      try {
        const where = gitSelfOf(dir)
        registerSelf(setup, 's-before', where, Date.now() / 1000 - 60)
        registerSelf(setup, 's-after', where, Date.now() / 1000)
      } finally { setup.close() }
      writeSnapshot(dbPath, 's-before', ['what was I doing'])
      const db = openHookDb(dbPath, { deadlineAt: Date.now() + 500 })
      try {
        db.exec('BEGIN IMMEDIATE')
        const t0 = Date.now()
        const payload = buildRehydrationPayload(db, 's-after', 'startup', dbPath)
        const took = Date.now() - t0
        expect(payload).toMatch(/Prior session snapshot/)
        expect(took, `the claim's staging write waited ${took} ms with 500 ms left`).toBeLessThan(500 + HOOK_BUSY_SLICE_MS + 400)
        db.exec('ROLLBACK')
      } finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── Against a real store another process holds ──────────────────────

const LOCKER = join(TS_ROOT, 'tests', 'helpers', 'store-locker.cjs')

async function lockWhole(dbPath: string): Promise<ChildProcess> {
  const locker = spawn(process.execPath, [LOCKER, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    let seen = ''
    const bail = setTimeout(() => reject(new Error(`the locker never locked: ${seen}`)), 20_000)
    locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
    locker.once('exit', (code) => { clearTimeout(bail); reject(new Error(`the locker exited ${code}: ${seen}`)) })
  })
  return locker
}

/** Kill `pid` after `ms`, from a process of its own: the waits under test
 *  block this one's event loop, so no timer here could fire in time. */
function killLater(pid: number, ms: number): void {
  spawn(process.execPath, ['-e', `setTimeout(() => { try { process.kill(${pid}, 'SIGKILL') } catch {} }, ${ms})`], { stdio: 'ignore' })
}

async function gone(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return
  await new Promise<void>((r) => { p.once('exit', () => r()); try { p.kill('SIGKILL') } catch { r() } })
}

function freshStore(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-deadline-'))
  const dbPath = join(dir, 'treecontext.db')
  openHookDb(dbPath).close() // the hooks' own bootstrap: the full schema
  return { dir, dbPath }
}

describe.skipIf(process.platform === 'win32')('a hook\'s wait on a real store another process holds', () => {
  const DEADLINE_MS = 1500
  /** One slice's overrun, and the scheduler's share on a loaded runner. */
  const SLACK_MS = HOOK_BUSY_SLICE_MS + 400

  it('a connection handed 10 s of busy_timeout beforehand still gives up by the deadline', async () => {
    const { dir, dbPath } = freshStore()
    const locker = await lockWhole(dbPath)
    const raw = new DatabaseSync(dbPath, { timeout: 10_000 })
    try {
      const t0 = Date.now()
      let thrown: unknown = null
      try { withHookDeadline(raw, t0 + DEADLINE_MS, () => raw.prepare('SELECT COUNT(*) AS n FROM staging').get()) } catch (err) { thrown = err }
      const took = Date.now() - t0
      expect(isHookBusy(thrown), String(thrown)).toBe(true)
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50)
      expect(took, `gave up after ${took} ms against ${DEADLINE_MS} ms`).toBeLessThanOrEqual(DEADLINE_MS + SLACK_MS)
    } finally {
      raw.close()
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('and reads once the lock is released inside the deadline', async () => {
    const { dir, dbPath } = freshStore()
    const locker = await lockWhole(dbPath)
    const raw = new DatabaseSync(dbPath, { timeout: 10_000 })
    try {
      killLater(locker.pid!, 600)
      const t0 = Date.now()
      const row = withHookDeadline(raw, t0 + DEADLINE_MS * 3, () => raw.prepare('SELECT COUNT(*) AS n FROM staging').get()) as { n: number }
      expect(row.n).toBe(0)
      expect(Date.now() - t0).toBeLessThan(DEADLINE_MS * 3)
    } finally {
      raw.close()
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('openHookDb\'s own open (its pragmas, the bootstrap gate) ends at its deadline', async () => {
    const { dir, dbPath } = freshStore()
    const locker = await lockWhole(dbPath)
    try {
      const t0 = Date.now()
      let thrown: unknown = null
      try { openHookDb(dbPath, { timeoutMs: DEADLINE_MS }).close() } catch (err) { thrown = err }
      const took = Date.now() - t0
      expect(isHookBusy(thrown), String(thrown)).toBe(true)
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50)
      expect(took).toBeLessThanOrEqual(DEADLINE_MS + SLACK_MS)
    } finally {
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a script of several statements is never run again whole: a write that committed is written once', async () => {
    // Statement one commits into the store; statement two writes a second
    // database another process holds, and comes back busy. Retried whole,
    // the script would write statement one's row again on every try.
    const { dir, dbPath } = freshStore()
    const otherPath = join(dir, 'other.db')
    const seed = new DatabaseSync(otherPath)
    // A rollback-journal file: an idle connection that attached it holds no
    // lock on it, so the locker can take it while the store stays attached.
    seed.exec('CREATE TABLE u (v INTEGER)')
    seed.close()
    const db = openHookDb(dbPath)
    db.exec('CREATE TABLE IF NOT EXISTS t (v INTEGER)')
    db.exec(`ATTACH DATABASE '${otherPath.replace(/'/g, "''")}' AS other`)
    const locker = await lockWhole(otherPath)
    try {
      killLater(locker.pid!, 600)
      let thrown: unknown = null
      try { db.exec('INSERT INTO main.t (v) VALUES (1); INSERT INTO other.u (v) VALUES (1)') } catch (err) { thrown = err }
      expect(isHookBusy(thrown), String(thrown)).toBe(true)
      await gone(locker)
      expect((db.prepare('SELECT COUNT(*) AS n FROM main.t').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a guard\'s read through the handle lands when the lock is released inside its 1 s', async () => {
    // A rollback-journal store: an idle connection holds no lock on it, so
    // the guard's statement can be prepared before the locker takes the
    // store, and the read under test is the statement's own `get`.
    const { dir, dbPath } = freshStore()
    const conv = new DatabaseSync(dbPath)
    conv.exec('PRAGMA journal_mode = DELETE')
    conv.close()
    const guard = openHookDb(dbPath, { readonly: true, timeoutMs: 60_000 })
    const stmt = guard.prepare('SELECT COUNT(*) AS n FROM staging')
    expect((stmt.get() as { n: number }).n).toBe(0)
    const locker = await lockWhole(dbPath)
    try {
      killLater(locker.pid!, 500)
      // The guard's own budget, 1 s from here.
      narrowHookDeadline(guard, Date.now() + 1000)
      const t0 = Date.now()
      expect((stmt.get() as { n: number }).n).toBe(0)
      expect(Date.now() - t0).toBeLessThan(1000 + HOOK_BUSY_SLICE_MS)
    } finally {
      guard.close()
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('writeStaging waits in slices against its own deadline, and stages the row once the lock is released', async () => {
    const { dir, dbPath } = freshStore()
    const locker = await lockWhole(dbPath)
    try {
      killLater(locker.pid!, 1000)
      const t0 = Date.now()
      let seen: { busy: number; left: number } | null = null
      writeStaging(dbPath, { sessionId: 's-deadline', role: 'user', content: 'staged behind a lock', timestamp: Date.now() / 1000 }, (db) => {
        seen = { busy: pragmaValue(db, 'busy_timeout') as number, left: hookDeadlineOf(db)! - t0 }
      })
      const took = Date.now() - t0
      expect(took).toBeGreaterThanOrEqual(900)
      expect(took).toBeLessThan(HOOK_DB_TIMEOUT_MS)
      // The connection's wait is a slice of SQLite's and the rest is the
      // clock's: its deadline is the write budget from the open.
      expect(seen).not.toBeNull()
      expect(seen!.busy).toBeLessThanOrEqual(HOOK_BUSY_SLICE_MS)
      expect(seen!.left).toBeGreaterThan(HOOK_DB_TIMEOUT_MS - 1000)
      expect(seen!.left).toBeLessThanOrEqual(HOOK_DB_TIMEOUT_MS + 50)
      const check = new DatabaseSync(dbPath, { readOnly: true })
      try {
        expect((check.prepare("SELECT COUNT(*) AS n FROM staging WHERE session_id = 's-deadline'").get() as { n: number }).n).toBe(1)
      } finally { check.close() }
      expect(existsSync(join(dir, 'hook-gaps.jsonl')), 'the staging write was recorded as a gap').toBe(false)
    } finally {
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // stop.ts workerStop: when the door's open failed, the turn's staging
  // write is handed what is left of the hook's budget (re-check of 2364fdf,
  // s5: a fresh 7 s behind the failed 7 s made Stop 14.0 s). The call site
  // itself is reached only by a lock that arrives between the guard and the
  // door; this binds the option it relies on.
  it('writeStaging given a deadline gives up by it, never at a fresh write budget', async () => {
    const { dir, dbPath } = freshStore()
    const locker = await lockWhole(dbPath)
    try {
      const t0 = Date.now()
      let threw = false
      try {
        writeStaging(dbPath, { sessionId: 's-left', role: 'user', content: 'behind a failed door', timestamp: Date.now() / 1000 }, undefined, { deadlineAt: t0 + 1500 })
      } catch { threw = true }
      const took = Date.now() - t0
      expect(took, `writeStaging took ${took} ms with 1500 ms left`).toBeLessThan(1500 + 1000)
      expect(threw || existsSync(join(dir, 'hook-gaps.jsonl')), 'the write neither failed nor left a gap').toBe(true)
    } finally {
      await gone(locker)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
