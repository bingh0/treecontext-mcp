/**
 * D258: a server SERVING a client writes its diagnostics to its log file
 * only and keeps stderr for warnings, errors and fatals — because Claude
 * Code records every stderr line a server writes as `[ERROR] … Server
 * stderr` in its own debug log, and a healthy `--debug` start read there
 * as a page of errors.
 *
 * Real CLI children, sandbox HOME, stderr read byte for byte; the log
 * file read from the sandbox HOME. Three pins:
 *   1. a healthy `serve --capture --debug` writes ZERO bytes to stderr
 *      from spawn through a clean stdin-EOF shutdown, and its log file
 *      holds the startup facts, a drain tick and the shutdown line;
 *   2. a genuine warning (a malformed staged snapshot the drain
 *      dead-letters) DOES reach stderr — and its copy reaches the file;
 *   3. the sweep's informational lines ("Purged", "Pruned") go to the
 *      file only under the serving sink (in-process: the sweep timer is
 *      five minutes, out of a child test's reach).
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { spawnNodeTsAsync, spawnCli, CLI_TS } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'
import { readServeLog, waitForServeLog } from '../helpers/serve-log.js'
import { redirectHome } from '../helpers/home.js'
import { INGESTION_TICK_MS } from '../../src/server/ingestion.js'
import { WARN_PREFIX } from '../../src/debug.js'

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})
function freshHome(prefix: string): string {
  const h = mkdtempSync(join(tmpdir(), prefix))
  homes.push(h)
  return h
}

/** Ambient seams a developer's shell may carry that change what the
 *  child writes: debug forcing, log level, index cap, a pinned clock,
 *  query telemetry. The claim is about a stock serve, so none leak in. */
const STRIPPED_ENV: Record<string, undefined> = {
  TREECONTEXT_DEBUG: undefined,
  TREECONTEXT_LOG: undefined,
  TREECONTEXT_INDEX_CAP: undefined,
  TREECONTEXT_TEST_NOW: undefined,
  TREECONTEXT_QUERY_TELEMETRY: undefined,
}

/** Spawn `serve --capture --debug` and record every stderr byte. */
function serve(home: string, store: string): { child: ReturnType<typeof spawnNodeTsAsync>; stderr: () => string } {
  const child = spawnNodeTsAsync(CLI_TS, [
    'serve', '--transport', 'stdio', '--capture', '--debug', '--lexical', '--store', store,
  ], { home, env: STRIPPED_ENV })
  let err = ''
  child.stderr.on('data', (c: Buffer) => { err += c.toString() })
  // stdout is the MCP channel; drain it so a response never back-pressures.
  child.stdout.resume()
  return { child, stderr: () => err }
}

async function exitOf(child: ReturnType<typeof spawnNodeTsAsync>): Promise<number | null | 'lingered'> {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c))),
    new Promise<'lingered'>((r) => setTimeout(() => r('lingered'), 30_000)),
  ])
}

describe('a serving server is silent on stderr when healthy (D258)', () => {
  it('writes zero stderr bytes from spawn to a clean stdin-EOF shutdown, and logs to the file', async () => {
    const home = freshHome('tc-d258-quiet-')
    const { child, stderr } = serve(home, 'quietprobe')
    try {
      const connected = await waitForServeLog(home, 'stdio transport connected')
      expect(connected, 'the transport announcement belongs in the log file').toContain('stdio transport connected')
      // One full drain tick, so the loop's own diagnostic has been written.
      const ticked = await waitForServeLog(home, '[ingest] tick', INGESTION_TICK_MS * 2 + 5_000)
      expect(ticked, 'a drain tick belongs in the log file').toContain('[ingest] tick')
      expect(stderr(), 'nothing reaches stderr before the first request').toBe('')

      child.stdin.end()
      const code = await exitOf(child)
      expect(code, `server never exited cleanly; stderr:\n${stderr()}`).toBe(0)
      expect(Buffer.byteLength(stderr()), `a healthy serve wrote to stderr:\n${stderr()}`).toBe(0)

      const log = readServeLog(home)
      for (const fact of ['[serve] Store: ', '[serve] Namespace: ', '[serve] Mode: conversation-indexer', '[serve] Policy: full',
        '[serve] Capture drain: this server holds the drain lease.', 'shutting down: stdin closed']) {
        expect(log, `the log file is missing ${fact}`).toContain(fact)
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 90_000)

  it('still puts a genuine warning on stderr, with its copy in the log file', async () => {
    const home = freshHome('tc-d258-warn-')
    const { child, stderr } = serve(home, 'warnprobe')
    try {
      await waitForServeLog(home, 'stdio transport connected')
      const dbPath = join(storesDirIn(home), 'warnprobe', 'treecontext.db')
      expect(existsSync(dbPath)).toBe(true)
      // The real shape the drain dead-letters: a recovery snapshot whose
      // content is not JSON, staged straight into the store.
      const raw = new BetterSqlite3(dbPath)
      let id: number
      try {
        raw.pragma('busy_timeout = 5000')
        id = Number(raw.prepare(
          "INSERT INTO staging (session_id, role, content, timestamp) VALUES (?, 'snapshot', ?, ?)",
        ).run('d258-warn-session', '{"queries": [unterminated', Date.now() / 1000).lastInsertRowid)
      } finally {
        raw.close()
      }
      const warning = `[IngestionLoop] Malformed snapshot JSON in staging row ${id} — dead-lettered`
      const deadline = Date.now() + INGESTION_TICK_MS * 3 + 5_000
      while (!stderr().includes(warning) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(stderr(), 'a warning keeps its stderr line').toContain(warning)
      // Nothing else: the warning is the only line, the diagnostics stay in the file.
      expect(stderr().trim().split('\n'), `stderr carried more than the warning:\n${stderr()}`).toEqual([warning])

      const log = readServeLog(home)
      const copy = log.split('\n').find((l) => l.includes(warning))
      expect(copy, 'the warning is copied to the log file').toBeTruthy()
      expect(copy!.startsWith(WARN_PREFIX)).toBe(true)

      child.stdin.end()
      expect(await exitOf(child)).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 90_000)

  it('sends the sweep\'s informational lines to the file only under the serving sink', async () => {
    const home = freshHome('tc-d258-sweep-')
    const restoreHome = redirectHome(home)
    vi.resetModules()
    const writes: string[] = []
    const spyWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    // vitest routes the console through its own reporter, not the
    // stream, so the console is watched as a stderr door of its own.
    const spyConsole = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      writes.push(args.map(String).join(' '))
    })
    try {
      const debug = await import('../../src/debug.js')
      debug.enableDebug({ fileOnly: true })
      expect(debug.debugLogFile(), 'the serving sink always ensures its file').toMatch(/debug-.*\.log$/)
      const { FlatStore } = await import('../../src/flat-store.js')
      const { IngestionLoop } = await import('../../src/server/ingestion.js')
      const { wrapBetterSqlite } = await import('../../src/persistence/better-sqlite.js')
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new BetterSqlite3(join(home, 'sweep.db'))),
        ownsDatabase: true,
      })
      try {
        const p = store.store
        const id = p.insertStaging({ sessionId: 's1', role: 'user', content: 'sweep fixture', timestamp: Date.now() / 1000 - 100_000 })
        p.claimStagingBatch('sweep-fixture', 1_000, 120)
        p.markStagingProcessedOwned([id], 'sweep-fixture')
        p.releaseStagingClaims('sweep-fixture')
        expect(await new IngestionLoop(store).runSweep()).toBe(1)
      } finally {
        await store.close()
      }
      expect(writes.join(''), 'an informational sweep line reached stderr').toBe('')
      expect(readServeLog(home)).toContain('[sweep] Purged 1 old processed staging rows')
    } finally {
      spyWrite.mockRestore()
      spyConsole.mockRestore()
      restoreHome()
      vi.resetModules()
    }
  })

  it('keeps a live server\'s log through a busy turn of hooks, and dump-logs shows it', async () => {
    // Every hook opens a log of its own and rotates the directory (five
    // files kept). Six tool calls used to unlink the serving server's
    // file — under D258 the only home of its startup facts.
    const home = freshHome('tc-d258-rotate-')
    const { child } = serve(home, 'rotateprobe')
    try {
      await waitForServeLog(home, 'stdio transport connected')
      const project = join(home, 'project')
      mkdirSync(project, { recursive: true })
      for (let i = 0; i < 6; i++) {
        const r = spawnCli(['hook', 'post-tool-use'], {
          home,
          cwd: project,
          env: STRIPPED_ENV,
          input: JSON.stringify({
            session_id: 'd258-rotate-session', cwd: project, hook_event_name: 'PostToolUse',
            tool_name: 'Bash', tool_input: { command: `echo ${i}` }, tool_response: { stdout: String(i) },
          }),
        })
        expect(r.status, r.out).toBe(0)
      }
      const logs = readdirSync(join(home, '.treecontext', 'logs'))
      // Seven writers (the server and six hooks), and every hook rotated.
      expect(readServeLog(home), `the live server's log was rotated away; left: ${logs.join(', ')}`).toContain('[serve] Store:')
      const dump = spawnCli(['doctor', '--dump-logs'], { home, env: STRIPPED_ENV })
      expect(dump.stdout, 'dump-logs lost the live server\'s startup facts').toContain('[serve] Store:')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 120_000)
})

/** A fresh debug module whose LOGS_DIR is under `home` — the module
 *  freezes the path from homedir() at import. */
async function debugUnder(home: string): Promise<{ debug: typeof import('../../src/debug.js'); restore: () => void }> {
  const restoreHome = redirectHome(home)
  vi.resetModules()
  const debug = await import('../../src/debug.js')
  return { debug, restore: () => { restoreHome(); vi.resetModules() } }
}

/** Every write that would reach stderr: the stream itself, and the
 *  console, which vitest routes through its own reporter. */
function captureStderr(): { text: () => string; restore: () => void } {
  const writes: string[] = []
  const w = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
  const c = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    writes.push(`${args.map(String).join(' ')}\n`)
  })
  return { text: () => writes.join(''), restore: () => { w.mockRestore(); c.mockRestore() } }
}

describe('the serving sink\'s edges (D258)', () => {
  const unwritableSkip = process.platform === 'win32' || process.getuid?.() === 0

  it.skipIf(unwritableSkip)('falls back to stderr, saying so exactly once, when the logs directory cannot be written', async () => {
    const home = freshHome('tc-d258-ro-')
    const logs = join(home, '.treecontext', 'logs')
    mkdirSync(logs, { recursive: true })
    chmodSync(logs, 0o500)
    const { debug, restore } = await debugUnder(home)
    const err = captureStderr()
    try {
      debug.enableDebug({ fileOnly: true })
      expect(debug.debugLogFile(), 'no file can be made in a 0500 directory').toBeNull()
      for (let i = 0; i < 50; i++) debug.dbg('probe', `line ${i}`)
      const text = err.text()
      expect(text.match(/could not create a debug log/g)?.length, text.slice(0, 500)).toBe(1)
      expect(text.match(/\[probe\] line \d+/g)?.length, 'diagnostics fall back to stderr').toBe(50)
    } finally {
      err.restore()
      restore()
      chmodSync(logs, 0o700)
    }
  })

  it('copies at most WARN_LOG_CAP warnings into the log, then one capped line', async () => {
    const home = freshHome('tc-d258-cap-')
    const { debug, restore } = await debugUnder(home)
    const err = captureStderr()
    try {
      debug.enableDebug({ fileOnly: true })
      for (let i = 0; i < debug.WARN_LOG_CAP + 25; i++) debug.warn(`[probe] warning ${i}`)
    } finally {
      err.restore()
      restore()
    }
    const lines = readServeLog(home).split('\n')
    expect(lines.filter((l) => /\[probe\] warning \d+$/.test(l)).length).toBe(10_000)
    expect(lines.filter((l) => l.includes('warn log capped at 10000 lines')).length).toBe(1)
    // stderr is not capped: the cap bounds the disk, not the signal.
    expect(err.text().match(/\[probe\] warning/g)?.length).toBe(10_025)
  })

  it('leaves a hook\'s diagnostics on stderr — a hook serves no client', () => {
    const home = freshHome('tc-d258-hook-')
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    const r = spawnCli(['hook', 'post-tool-use'], {
      home,
      cwd: project,
      env: { ...STRIPPED_ENV, TREECONTEXT_DEBUG: '1' },
      input: JSON.stringify({
        session_id: 'd258-hook-session', cwd: project, hook_event_name: 'PostToolUse',
        tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' },
      }),
    })
    expect(r.status, r.out).toBe(0)
    expect(r.stderr).toContain('[treecontext:dbg')
    expect(r.stderr).toContain('[hook:post-tool] invoked')
    expect(readServeLog(home), 'and its log file too').toContain('[hook:post-tool] invoked')
  })
})
