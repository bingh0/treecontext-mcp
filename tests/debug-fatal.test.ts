/**
 * logFatal — crash recording that survives a run with debug switched off.
 *
 * `dbg` is a no-op unless --debug is set. That is right for progress
 * chatter and wrong for a crash: an MCP server that dies during startup
 * surfaces to the host as nothing but "-32000: Connection closed", so if
 * the fatal is not on disk it is nowhere. The 0.0.10-beta field report was
 * diagnosed only because debug happened to be on; with --no-debug the same
 * failure left no trace at all.
 *
 * Own file: debug.ts holds module-level state (enabled flag, log path)
 * that must be established before import, per HOME redirection.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { redirectHome } from './helpers/home.js'
import { itPosix } from './helpers/platform.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-fatal-home-'))
// Every home variable, before the dynamic import: LOGS_DIR is computed from
// os.homedir() at module load, and os.homedir() ignores HOME on Windows.
const restoreHome = redirectHome(fakeHome)

const { logFatal, enableDebug, dbg, FATAL_PREFIX, LOGS_DIR } = await import('../src/debug.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

function logContents(): string {
  if (!existsSync(LOGS_DIR)) return ''
  return readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(LOGS_DIR, f), 'utf8'))
    .join('')
}

describe('logFatal', () => {
  it('writes to the log file without enableDebug ever being called', () => {
    // enableDebug() is deliberately NOT called — this is the --no-debug run.
    const err = Object.assign(new Error('store is newer than this build'), {
      name: 'SchemaVersionError',
      code: 'SCHEMA_VERSION',
    })
    logFatal('serve', err)

    const body = logContents()
    expect(body).toContain(FATAL_PREFIX)
    expect(body).toContain('[serve] SchemaVersionError: store is newer than this build')
    expect(body).toContain('code: SCHEMA_VERSION')
    // Stack retained — the whole point is not having to guess the call path.
    expect(body).toMatch(/\n\s+at /)
  })

  it('records non-Error throws rather than dropping them', () => {
    logFatal('hook', 'a bare string rejection')
    expect(logContents()).toContain('a bare string rejection')
  })

  it('never throws, whatever it is handed', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => logFatal('cli', circular)).not.toThrow()
    expect(() => logFatal('cli', null)).not.toThrow()
    expect(() => logFatal('cli', undefined)).not.toThrow()
  })
})

describe('log file privacy', () => {
  // Runs LAST in this file on purpose: enableDebug() flips module state the
  // earlier tests rely on being unset.
  itPosix('log files land 0600 on create, never umask-default (docs/security.md §3)', () => {
    enableDebug()
    dbg('mode-pin', 'privacy pin')
    for (const f of readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'))) {
      expect(statSync(join(LOGS_DIR, f)).mode & 0o777, f).toBe(0o600)
    }
  })
})
