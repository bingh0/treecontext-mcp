/**
 * Opt-in debug logging for treecontext MCP server.
 *
 * Enabled by `--debug` CLI flag or `TREECONTEXT_DEBUG=1` env var.
 * Where the lines go depends on who is listening (D258):
 *   - a server SERVING a client (`serve`): the rotated log file at
 *     ~/.treecontext/logs/ only. Claude Code records every stderr line a
 *     server writes as an error in its own log, so a healthy `--debug`
 *     start used to read there as a page of errors. stderr is kept for
 *     `warn` (warnings, errors) and `logFatal`.
 *   - a hook (no client) and every other command: stderr AND the file.
 *   - `--dry-run`: stderr only, no file.
 * The log file is what `treecontext doctor --dump-logs` reads.
 *
 * Usage:
 *   import { dbg, enableDebug } from './debug.js'
 *   enableDebug()        // call once at startup if --debug is set
 *   dbg('lock', 'acquired store lock', { pid: process.pid })
 */

import { mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { formatWithOptions } from 'node:util'

let _enabled = false
let _logFile: string | null = null
/** True when logging was asked to leave no trace on disk (--dry-run). */
let _stderrOnly = false
/** True when diagnostics go to the log file only — a serving server (D258). */
let _fileOnly = false

const t0 = Date.now()

/** Line prefix for fatal records — the marker `doctor` scans for. */
export const FATAL_PREFIX = '[treecontext:fatal'

/** The most warning lines one process copies into its log file. Should
 *  the stderr guard ever lapse, every dead-stream error re-enters `warn`,
 *  and an uncapped copy grew a log by 260 MB in fifteen seconds. */
export const WARN_LOG_CAP = 10_000
let _warnLogLines = 0

/** Line prefix for a warning's copy in the log file (D258): stderr gets
 *  the warning as written, the file gets it marked so a dump reads as one
 *  story with the diagnostics around it. */
export const WARN_PREFIX = '[treecontext:warn'

/** home → `~`, for SHARING surfaces only (dump-logs, doctor's crash
 *  excerpt, the fatal stderr line): the home directory is the username
 *  on most machines, and these outputs are written to be pasted into
 *  public issues. On-disk records keep full fidelity. One definition —
 *  the rule lived in three hand-rolled copies (pass-2 cleanup ruling,
 *  2026-08-15). */
export function redactHome(s: string): string {
  return s.replaceAll(homedir(), '~')
}

/** Directory where debug logs are stored. */
export const LOGS_DIR = join(homedir(), '.treecontext', 'logs')

/** Maximum number of log files to keep (rotated by PID/startup). */
const MAX_LOG_FILES = 5

/** Maximum log file size in bytes before rotation (2 MB). */
const MAX_LOG_SIZE = 2 * 1024 * 1024

/**
 * Turn on debug output.
 *
 * `stderrOnly` keeps the diagnosis but writes no file. It exists for
 * `--dry-run`, which promises that nothing on disk changes: creating a log
 * directory and file in the user's home during a preview is a small side
 * effect, but it is still a side effect, and it was one the dry run did not
 * announce either.
 */
export function enableDebug(opts: { stderrOnly?: boolean; fileOnly?: boolean } = {}): void {
  _enabled = true
  if (opts.stderrOnly) {
    _stderrOnly = true
    _fileOnly = false
    _logFile = null
    return
  }
  const file = ensureLogFile()
  if (opts.fileOnly) {
    // `fileOnly` is the serving mode (D258): the file is the only channel
    // for diagnostics, so it is always ensured. A file that cannot be made
    // must not silence diagnosis altogether — fall back to stderr, and say
    // so once.
    if (file) {
      _fileOnly = true
    } else {
      _fileOnly = false
      if (!process.stderr.destroyed) {
        process.stderr.write(`[treecontext] could not create a debug log under ${LOGS_DIR} — diagnostics go to stderr\n`)
      }
    }
  }
}

/** The file this process logs to, or null when it has none (debug off,
 *  `--dry-run`, or the file could not be made). */
export function debugLogFile(): string | null {
  return _logFile
}

/**
 * Resolve (creating on first need) the file this process logs to.
 *
 * Split out of enableDebug so `logFatal` can record a crash in a run that
 * never turned debug on — the log file is created lazily at the moment
 * something goes wrong rather than at startup.
 */
function ensureLogFile(): string | null {
  if (_logFile) return _logFile
  if (_stderrOnly) return null
  try {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(LOGS_DIR, `debug-${ts}-${process.pid}.log`)
    // Probe before committing: a logs directory that exists but cannot be
    // written (mode 0500) would otherwise swallow every append silently —
    // for a serving server, whose diagnostics have no other home, that
    // was zero stderr and zero log.
    appendFileSync(file, '', { mode: 0o600 })
    _logFile = file
    rotateOldLogs()
  } catch {
    // Best-effort — if we can't write logs, still emit to stderr
    _logFile = null
  }
  return _logFile
}

/**
 * Emit a tagged debug line to stderr and the log file — or to the file
 * alone while serving a client (D258).
 * No-op when debug is disabled. Includes elapsed ms since process start.
 *
 * @param tag   Short category (e.g. 'onnx', 'lock', 'ingest', 'dedup', 'code-index')
 * @param msg   Human-readable message
 * @param data  Optional structured data appended as JSON
 */
export function dbg(tag: string, msg: string, data?: Record<string, unknown>): void {
  if (!_enabled) return
  const elapsed = Date.now() - t0
  const suffix = data ? ` ${JSON.stringify(data)}` : ''
  const line = `[treecontext:dbg +${elapsed}ms] [${tag}] ${msg}${suffix}\n`
  // A destroyed stderr stays destroyed for the life of the process (the
  // abandoned-peer case: the storm guard swallows the error and the stream
  // self-destructs). Every write after that is a per-call allocation and an
  // ERR_STREAM_DESTROYED emit that can never land anywhere — skip it; the
  // log file below remains the surviving channel.
  if (!_fileOnly && !process.stderr.destroyed) process.stderr.write(line)
  appendToLog(line)
}

/** Append to this process's log file, if it has one. Never throws. */
function appendToLog(line: string): void {
  if (!_logFile) return
  try {
    // Mode applies on create: log lines are journal-adjacent content
    // and land private, not umask-default (docs/security.md §3).
    appendFileSync(_logFile, line, { mode: 0o600 })
  } catch {
    // Best-effort — don't crash if log write fails
  }
}

/**
 * A warning or error: ALWAYS to stderr (debug on or off, serving or not),
 * and also to the log file when there is one, so `doctor --dump-logs`
 * keeps the whole story (D258). Arguments format as `console.error`
 * formats them. Under serve a line on stderr is the client's cue that
 * something is wrong, so only a warning, an error or a fatal earns one —
 * a diagnostic goes through `dbg`.
 *
 * The destroyed-stderr guard holds here too: once an abandoned peer's
 * stream has destroyed itself, a further write can land nowhere.
 */
export function warn(...args: unknown[]): void {
  try {
    // Through console.error, not a raw write: the line formats exactly as
    // it did before D258, and a test that spies on the console still sees it.
    if (!process.stderr.destroyed) console.error(...args)
  } catch {
    // A write that throws synchronously must not replace the warning's cause.
  }
  if (_warnLogLines > WARN_LOG_CAP) return
  _warnLogLines++
  if (_warnLogLines > WARN_LOG_CAP) {
    appendToLog(`${WARN_PREFIX} +${Date.now() - t0}ms] warn log capped at ${WARN_LOG_CAP} lines for this process — later warnings reach stderr only\n`)
    return
  }
  appendToLog(`${WARN_PREFIX} +${Date.now() - t0}ms] ${formatWithOptions({ colors: false }, ...args)}\n`)
}

/**
 * Record a fatal error to the debug log — ALWAYS, even when debug output
 * is switched off.
 *
 * `dbg` is a no-op unless --debug is set, which is the right default for
 * progress chatter and exactly the wrong one for a crash: the run a user
 * later asks about is the run that died, and if the process exits before
 * its transport comes up the host shows nothing but a closed connection.
 * A pre-0.0.11 MCP server that failed the destructive-migration gate left
 * the log ending mid-startup with no reason recorded anywhere on disk.
 *
 * Writes full detail (name, code, stack) to the file; stderr gets it only
 * when debug is on, since callers print their own one-line message. Never
 * throws — a logging failure must not replace the error being logged.
 */
export function logFatal(context: string, err: unknown): void {
  try {
    const elapsed = Date.now() - t0
    const e = err instanceof Error ? err : new Error(String(err))
    const code = (e as Error & { code?: string }).code
    const lines = [`${FATAL_PREFIX} +${elapsed}ms] [${context}] ${e.name}: ${e.message}`]
    if (code) lines.push(`  code: ${code}`)
    if (e.stack) {
      for (const l of e.stack.split('\n').slice(1)) lines.push(`  ${l.trim()}`)
    }
    const line = lines.join('\n') + '\n'
    if (_enabled && !process.stderr.destroyed) process.stderr.write(line)
    const file = ensureLogFile()
    if (file) appendFileSync(file, line, { mode: 0o600 })
  } catch {
    // Best-effort by construction — see above.
  }
}

/** How recently a log file must have been written for rotation to leave
 *  it alone even when its writer cannot be seen to be alive. */
const ROTATION_GRACE_MS = 5 * 60 * 1000

/** The pid a log file's name records (`debug-<ts>-<pid>.log`), or null. */
function logWriterPid(name: string): number | null {
  const m = /-(\d+)\.log$/.exec(name)
  return m ? Number(m[1]) : null
}

/**
 * True when the process that writes this log file is still running.
 *
 * Under D258 a serving server's log file is the only home of its
 * diagnostics, and every hook (one per tool call) opens a log of its own
 * and rotates the directory on the way in: five tool calls used to unlink
 * the live server's file, startup facts and all. `kill(pid, 0)` sends
 * nothing; EPERM means the process exists under another user. A recycled
 * pid keeps a dead writer's file one rotation longer, which is harmless.
 */
export function isLogWriterAlive(name: string): boolean {
  const pid = logWriterPid(name)
  if (pid === null || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove oldest log files beyond MAX_LOG_FILES, and oversized ones —
 *  never a file whose writer is alive or which was written in the last
 *  few minutes; the count and size budget governs the rest. */
function rotateOldLogs(): void {
  try {
    const now = Date.now()
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
      .map(f => ({ name: f, mtime: statSync(join(LOGS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime) // newest first
    const isProtected = (f: { name: string; mtime: number }): boolean =>
      now - f.mtime < ROTATION_GRACE_MS || isLogWriterAlive(f.name)

    // Remove files beyond the limit
    for (const f of files.slice(MAX_LOG_FILES - 1)) {
      if (isProtected(f)) continue
      try { unlinkSync(join(LOGS_DIR, f.name)) } catch { /* best-effort */ }
    }

    // Also remove any oversized file (shouldn't happen normally but
    // protects disk space in runaway scenarios) — a live one excepted.
    for (const f of files.slice(0, MAX_LOG_FILES - 1)) {
      if (isProtected(f)) continue
      try {
        const size = statSync(join(LOGS_DIR, f.name)).size
        if (size > MAX_LOG_SIZE) unlinkSync(join(LOGS_DIR, f.name))
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}
