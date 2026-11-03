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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { withHookDeadline, hookHandle, hookDeadlineOf, isHookBusy, HOOK_BUSY_SLICE_MS } from '../../src/hooks/hook-deadline.js'
import { openHookDb, writeStaging, HOOK_DB_TIMEOUT_MS } from '../../src/hooks/shared.js'
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
})
