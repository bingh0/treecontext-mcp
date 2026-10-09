/**
 * Serve-path lifecycle pins (release-diff review 2026-08-15). Real CLI
 * spawns with stdin closed immediately: the server starts, runs its
 * open sequence, sees EOF, and shuts down cleanly — which is exactly
 * the window both defects lived in.
 *
 * 1. A fresh store gets the base schema BEFORE the ladder. The raw
 *    ladder on a schema-less file minted a pre-migration-v0.bak no
 *    verdict could be recorded against, and doctor warned about every
 *    store first created via serve, forever.
 * 2. The drain lease follows EFFECTIVE capture, not the flag: a
 *    --capture --read-only server runs no ingestion loop and must not
 *    squat the drain against a real capture server.
 *
 * The dead-peer shutdown's own two pins joined them at rc.6 (review of
 * ab58c27): a shutdown watchdog that kills a wedge without murdering a
 * slow-but-progressing close, and a peer-death watch wired ahead of the
 * startup work rather than after it.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { spawnCli, spawnNodeTsAsync, CLI_TS } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'
import { readServeLog, waitForServeLog } from '../helpers/serve-log.js'
import { armShutdownWatchdog, SHUTDOWN_STEP_BUDGET_MS } from '../../src/server/server.js'

const home = mkdtempSync(join(tmpdir(), 'tc-serve-lifecycle-'))

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const serveOnce = (args: string[]): { status: number | null; out: string } => spawnCli(['serve', ...args], { home })

describe('serve lifecycle (release-diff review pins)', () => {
  it('a fresh store gets the base schema, a verdicted backup, and no doctor warning', () => {
    const run = serveOnce(['--store', 'freshie'])
    expect(run.status, run.out).toBe(0)

    const storeDir = join(storesDirIn(home), 'freshie')
    const files = readdirSync(storeDir)
    // No schema-less v0 backup — the base schema (v5) went in first, so
    // the ladder's backup is a real store a verdict CAN be recorded on.
    expect(files.some((f) => f.includes('pre-migration-v0'))).toBe(false)
    const verdict = files.find((f) => f.endsWith('.verdict.json'))
    expect(verdict, `no completion verdict among: ${files.join(', ')}`).toBeDefined()

    const db = new BetterSqlite3(join(storeDir, 'treecontext.db'), { readonly: true })
    try {
      const v = db.pragma('user_version', { simple: true }) as number
      expect(v).toBeGreaterThanOrEqual(23)
    } finally {
      db.close()
    }
  })

  it('a read-only capture server does not take the drain lease', () => {
    // The drain-lease line is a diagnostic: under D258 a serving server
    // writes it to its log file only, so each run gets its own HOME's
    // log to read (the store is shared through --store under one home,
    // so the two runs' logs are told apart by clearing between them).
    const holds = /Capture drain: this server holds the drain lease/
    const logs = join(home, '.treecontext', 'logs')
    rmSync(logs, { recursive: true, force: true })
    const active = serveOnce(['--store', 'drain-gate', '--capture'])
    expect(active.status, active.out).toBe(0)
    expect(readServeLog(home)).toMatch(holds)
    expect(active.out, 'a healthy serve is silent on stderr').not.toMatch(holds)

    rmSync(logs, { recursive: true, force: true })
    const squatter = serveOnce(['--store', 'drain-gate', '--capture', '--read-only'])
    expect(squatter.status, squatter.out).toBe(0)
    const squatterLog = readServeLog(home)
    expect(squatterLog, 'the read-only run logged nothing at all').toContain('[serve] Policy: read_only')
    expect(squatterLog).not.toMatch(holds)
    expect(existsSync(join(storesDirIn(home), 'drain-gate', 'treecontext.db'))).toBe(true)
  })
})

// ── the dead-peer shutdown, amended (rc.6 review of ab58c27) ────────

describe('shutdown watchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('hard-exits a step that stalls for the whole budget', () => {
    const codes: number[] = []
    armShutdownWatchdog(SHUTDOWN_STEP_BUDGET_MS, (c) => { codes.push(c) })
    vi.advanceTimersByTime(SHUTDOWN_STEP_BUDGET_MS + 1)
    // A wedged close still dies rather than hanging forever.
    expect(codes).toEqual([1])
  })

  it('never murders a close that is still making progress', () => {
    // The rc.6 regression: ab58c27's flat 5s deadline was armed before
    // any close work and covered the whole sequence, so a slow but
    // healthy close — a WAL checkpoint on a multi-GB store, attribution
    // handles on a network filesystem — was converted into exit(1)
    // mid-flush, truncating the buffered capture it was flushing.
    const codes: number[] = []
    const watchdog = armShutdownWatchdog(SHUTDOWN_STEP_BUDGET_MS, (c) => { codes.push(c) })
    for (let step = 0; step < 5; step++) {
      vi.advanceTimersByTime(SHUTDOWN_STEP_BUDGET_MS - 1)
      watchdog.progress()
    }
    expect(codes).toEqual([])
    watchdog.clear()
    // Cleared means cleared: the clean path's own exit(0) stands.
    vi.advanceTimersByTime(SHUTDOWN_STEP_BUDGET_MS * 10)
    expect(codes).toEqual([])
  })

  it('re-arms after progress, so a stall AFTER a slow step still dies', () => {
    const codes: number[] = []
    const watchdog = armShutdownWatchdog(SHUTDOWN_STEP_BUDGET_MS, (c) => { codes.push(c) })
    vi.advanceTimersByTime(SHUTDOWN_STEP_BUDGET_MS - 1)
    watchdog.progress()
    vi.advanceTimersByTime(SHUTDOWN_STEP_BUDGET_MS + 1)
    expect(codes).toEqual([1])
  })
})

describe('a peer that dies during startup', () => {
  it('is noticed, and the server exits instead of orphaning itself', async () => {
    // Carried-over finding: the stdio lifecycle listeners attached only
    // after connect + initCapture, and stdin emits 'end' exactly once —
    // a client that died inside that window left an immortal orphan
    // holding the store open with nothing left to notice. Closing stdin
    // the moment the transport reports itself connected aims the EOF at
    // that window; the watch is now wired ahead of it.
    // A clean log directory: the earlier runs in this home announced
    // their transports too, and the wait below must hear this one.
    rmSync(join(home, '.treecontext', 'logs'), { recursive: true, force: true })
    const child = spawnNodeTsAsync(CLI_TS, [
      'serve', '--transport', 'stdio', '--capture', '--debug', '--lexical', '--store', 'startup-death',
    ], { home })
    try {
      // The announcement is a diagnostic: under D258 it lands in the
      // sandbox HOME's log file, not on stderr.
      const seen = await waitForServeLog(home, 'stdio transport connected')
      child.stdin.end()
      const code = await Promise.race([
        new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c))),
        new Promise<'lingered'>((r) => setTimeout(() => r('lingered'), 30_000)),
      ])
      expect(code, `server never exited; log so far:\n${seen}`).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 70_000)
})
