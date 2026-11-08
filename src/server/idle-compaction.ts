import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { installStatePath, readInstallState, updateInstallState, writeAtomic, type InstallState } from './install-state.js'

export { installStatePath }

// ── Claude Code's idle compaction (D290, D304, D338) ───────────────────
//
// Idle compaction summarises a long conversation while the session sits
// idle, which replaces the checkpoint-then-/clear boundary and throws away
// the prompt cache the journal exists to keep. Install turns it off where
// the client is known to read the key, and never touches a key the user set.
//
// The facts are the client's, from Anthropic's settings reference
// (https://code.claude.com/docs/en/settings-reference.md#idlecompaction,
// read 2026-11-01) and the 2.1.316 client's own settings schema: the key is
// `idleCompaction`, a boolean defaulting to true; the settings key is read
// from Claude Code 2.1.290; the Idle compaction row in /config exists from
// 2.1.302.

/** The settings key, as the client spells it. */
export const IDLE_COMPACTION_KEY = 'idleCompaction'

/** The first Claude Code release that reads the key (D304). */
export const IDLE_COMPACTION_FLOOR = '2.1.290'

/** The first Claude Code release with an Idle compaction row in /config (D338). */
export const IDLE_COMPACTION_CONFIG_ROW_FROM = '2.1.302'

/**
 * What the Claude Code found does about the key:
 * - `unreadable`: its version could not be read; nothing is known
 * - `below-floor`: older than 2.1.290, it ignores the key
 * - `settings-line`: 2.1.290 to 2.1.301, it honors the key and has no /config row
 * - `config-row`: 2.1.302 and later, it honors the key and has the row
 */
export type IdleCompactionSupport = 'unreadable' | 'below-floor' | 'settings-line' | 'config-row'

/** The first dotted x.y.z in a client's `--version` answer, or null. */
export function parseClaudeVersion(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const m = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)(?![\d.]*\d)/.exec(text)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Compare two x.y.z strings numerically: negative when a is older. */
function compareTriples(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function idleCompactionSupport(version: string | null): IdleCompactionSupport {
  const v = parseClaudeVersion(version)
  if (v === null) return 'unreadable'
  if (compareTriples(v, IDLE_COMPACTION_FLOOR) < 0) return 'below-floor'
  if (compareTriples(v, IDLE_COMPACTION_CONFIG_ROW_FROM) < 0) return 'settings-line'
  return 'config-row'
}

/** POSIX gives the probe its own process group, so the bound reaches a wrapper's children; Windows has none. */
const GROUPS = process.platform !== 'win32'

/** How long the version probe may take before it is cut, group and all. */
export const CLAUDE_VERSION_TIMEOUT_MS = 5000

/** Run a command for its stdout alone; null on any failure, and nothing it started outlives the call. */
function probe(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: GROUPS })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    let ok = false
    const killGroup = (): void => {
      try {
        if (GROUPS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* gone */ }
    }
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Whatever the answer, leave nothing running: a wrapper script's own
      // children share the group and die with it.
      killGroup()
      resolve(value)
    }
    const timer = setTimeout(() => settle(null), timeoutMs)
    child.stdout?.on('data', (c: Buffer) => { chunks.push(c) })
    child.on('error', () => settle(null))
    child.on('exit', (code) => {
      ok = code === 0
      // the pipe may hold a last chunk: give it a moment, never the grandchildren's lifetime
      setTimeout(() => settle(ok ? Buffer.concat(chunks).toString('utf8') : null), 100)
    })
    child.stdout?.on('close', () => { if (child.exitCode !== null) settle(ok ? Buffer.concat(chunks).toString('utf8') : null) })
  })
}

/**
 * The Claude Code on PATH: what `claude --version` prints, parsed. Null is
 * "cannot be read": no binary, a binary that fails or hangs, or one that
 * prints nothing with a version in it. Bounded (default 5 s), run as the
 * leader of its own process group and killed with it, and never throws, so a
 * shell-wrapper `claude` leaves no child behind and a doctor row is not worth
 * hanging a terminal over.
 */
export async function readClaudeVersion(opts: { command?: string; timeoutMs?: number } = {}): Promise<string | null> {
  const command = opts.command ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? CLAUDE_VERSION_TIMEOUT_MS
  // On Windows `claude` may be a .cmd shim, which spawn cannot run without a
  // shell. The command is a literal, so the hop carries no input.
  const out = (await probe(command, ['--version'], timeoutMs))
    ?? (process.platform === 'win32'
      ? await probe(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `${command} --version`], timeoutMs)
      : null)
  return parseClaudeVersion(out)
}

/** What a user's settings file says about the key. */
export type IdleCompactionSetting =
  | { state: 'absent' }
  | { state: 'on' }
  | { state: 'off' }
  | { state: 'other'; value: string }
  | { state: 'unreadable' }

/**
 * Read the key out of a parsed settings object. Only `false` is off and
 * only `true` is on (the client's key is a boolean); any other value is
 * the user's, kept as it is and shown as it is.
 */
export function idleCompactionOf(data: Record<string, unknown>): IdleCompactionSetting {
  if (!Object.hasOwn(data, IDLE_COMPACTION_KEY)) return { state: 'absent' }
  const v = data[IDLE_COMPACTION_KEY]
  if (v === false) return { state: 'off' }
  if (v === true) return { state: 'on' }
  return { state: 'other', value: JSON.stringify(v) ?? 'undefined' }
}

/**
 * A settings file the way Claude Code reads it: comments and trailing commas
 * are accepted (2.1.316 does), so a file with either is the user's valid
 * settings and not a corrupt one. String contents are left as they are.
 */
export function parseTolerantJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch { /* fall through to the tolerant pass */ }
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === '}' || text[j] === ']') i += 1
      else { out += c; i += 1 }
    } else {
      out += c
      i += 1
    }
  }
  return JSON.parse(out)
}

/** A settings file read as an object: absent, an object, or something that is not one. */
export type SettingsRead =
  | { state: 'absent' }
  | { state: 'ok'; data: Record<string, unknown> }
  | { state: 'unreadable' }

export function readSettingsObject(settingsPath: string): SettingsRead {
  if (!existsSync(settingsPath)) return { state: 'absent' }
  try {
    const parsed = parseTolerantJson(readFileSync(settingsPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable' }
    return { state: 'ok', data: parsed as Record<string, unknown> }
  } catch {
    return { state: 'unreadable' }
  }
}

/** The key as the user's settings file carries it; a file that is not a settings object is `unreadable`. */
export function readIdleCompaction(settingsPath: string): IdleCompactionSetting {
  const read = readSettingsObject(settingsPath)
  if (read.state === 'absent') return { state: 'absent' }
  if (read.state === 'unreadable') return { state: 'unreadable' }
  return idleCompactionOf(read.data)
}

/** The line that turns it off: the settings line, as the user would type it. */
export function settingsLine(settingsPath: string): string {
  return `"${IDLE_COMPACTION_KEY}": false in ${settingsPath}`
}

/** What install does about the key, for one client at one version. */
export type IdleCompactionDecision =
  /** the client does not read the key: write nothing, say so */
  | { action: 'not-applicable'; version: string | null }
  /** absent and honored: write it off */
  | { action: 'write-off' }
  /** the user's, whatever it is: nothing to write, nothing to say (D361) */
  | { action: 'leave-quiet' }
  /** the file could not be read as a settings object: nothing is written over it */
  | { action: 'unreadable-file' }

export function decideIdleCompaction(version: string | null, setting: IdleCompactionSetting): IdleCompactionDecision {
  const support = idleCompactionSupport(version)
  if (support === 'unreadable' || support === 'below-floor') {
    return { action: 'not-applicable', version: parseClaudeVersion(version) }
  }
  switch (setting.state) {
    case 'unreadable': return { action: 'unreadable-file' }
    case 'absent': return { action: 'write-off' }
    default: return { action: 'leave-quiet' }
  }
}

/** Install's one line for a decision, or null when install says nothing. */
export function installLine(decision: IdleCompactionDecision, version: string | null, settingsPath: string, dryRun: boolean): string | null {
  const support = idleCompactionSupport(version)
  switch (decision.action) {
    case 'not-applicable': {
      const named = decision.version === null ? 'version unknown' : `version ${decision.version}`
      // Say only what is known: a version that could not be read is not
      // asserted to be one that does not read the key.
      return decision.version === null
        ? `  idle compaction: not applicable to this client (Claude Code ${named}; the setting is read from ${IDLE_COMPACTION_FLOOR})`
        : `  idle compaction: not applicable to this client (Claude Code ${named} does not read the ${IDLE_COMPACTION_KEY} setting; it is read from ${IDLE_COMPACTION_FLOOR})`
    }
    case 'write-off': {
      // The /config row where the client has one, the settings line alone
      // where it does not: never a row the client lacks (D338).
      const back = support === 'config-row'
        ? "the client's /config row (Idle compaction) turns it back on"
        : `set "${IDLE_COMPACTION_KEY}": true there to turn it back on`
      return `  idle compaction: ${dryRun ? 'would turn' : 'turned'} off in ${settingsPath} — it destroys the prompt-cache economics the journal exists to keep; ${back}`
    }
    case 'unreadable-file':
      return `  idle compaction: left alone — ${settingsPath} could not be read as a settings object, so the key was not looked for`
    case 'leave-quiet':
      return null
  }
}

/** The merge: set the key off in the settings object and nothing else. Returns the object to write, or null when nothing is to be written. */
export function withIdleCompactionOff(data: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.hasOwn(data, IDLE_COMPACTION_KEY)) return null
  return { ...data, [IDLE_COMPACTION_KEY]: false }
}

export interface IdleCompactionRow {
  status: 'ok' | 'warn'
  detail: string
  fix?: string
}

/** Doctor's own row for the setting. */
export function idleCompactionRow(version: string | null, setting: IdleCompactionSetting, settingsPath: string): IdleCompactionRow {
  const support = idleCompactionSupport(version)
  if (support === 'unreadable' || support === 'below-floor') {
    const named = support === 'unreadable' ? 'version unknown' : `version ${parseClaudeVersion(version)}`
    return { status: 'ok', detail: `the setting is not read by this client, ${named}` }
  }
  // Only the user settings file is read: a project, local or managed file can
  // set the key too, and the row says which file it speaks for.
  if (setting.state === 'off') {
    return { status: 'ok', detail: `off in ${settingsPath} (only that file was read; a project, local or managed settings file can set it too)` }
  }
  const what = setting.state === 'on'
    ? 'on'
    : setting.state === 'absent'
      ? `on (not set; ${IDLE_COMPACTION_KEY} defaults to true)`
      : setting.state === 'other'
        ? `set to ${setting.value}, which is neither true nor false`
        : `${settingsPath} is not a JSON object, so the setting could not be read`
  const settings = settingsLine(settingsPath)
  if (setting.state === 'absent') {
    // Not set: the client's default is on, and the one command that turns
    // it off for this client is install, which writes the key when it is
    // absent. Doctor's fix lines are commands that clear their finding.
    return {
      status: 'warn',
      detail: `${what}; treecontext recommends off — it destroys the prompt-cache economics the journal exists to keep`,
      fix: 'treecontext install',
    }
  }
  return {
    status: 'warn',
    detail: `${what}; treecontext recommends off — it destroys the prompt-cache economics the journal exists to keep`,
    fix: support === 'config-row'
      ? `turn it off in the client's /config row (Idle compaction), or set ${settings}`
      : `set ${settings}`,
  }
}

// ── Install's record of the key it wrote, and uninstall's reading of it (D361) ──
//
// Only install's own record can tell its key from the user's: uninstall
// removes the key when the record names the file and the file still carries
// the value install wrote, and otherwise leaves it, so a client is never left
// with a setting install chose after treecontext is gone, and a value the
// user set, or set since, is never touched.

/** Install wrote the key off into this file. */
export function recordIdleCompactionWrite(settingsFile: string): void {
  updateInstallState((state) => {
    state.idleCompaction = { ...state.idleCompaction, [settingsFile]: { value: false, at: new Date().toISOString() } }
  })
}

export interface IdleCompactionRemoval {
  file: string
  removed: boolean
  /** why it was left, when it was */
  left?: string
}

/**
 * Uninstall's half: take the key out of each file install recorded writing it
 * into, only while the file still holds `false`; the record is spent either
 * way (except for a file that cannot be read now, kept for a later run).
 */
export function removeIdleCompactionWritten(dryRun: boolean): IdleCompactionRemoval[] {
  const state = readInstallState()
  const recorded = state.idleCompaction ?? {}
  const out: IdleCompactionRemoval[] = []
  const remaining: NonNullable<InstallState['idleCompaction']> = {}
  for (const [file, rec] of Object.entries(recorded)) {
    const read = readSettingsObject(file)
    if (read.state === 'unreadable') {
      remaining[file] = rec
      out.push({ file, removed: false, left: 'the file cannot be read now' })
    } else if (read.state === 'ok' && read.data[IDLE_COMPACTION_KEY] === false) {
      const { [IDLE_COMPACTION_KEY]: _gone, ...rest } = read.data
      if (!dryRun) writeAtomic(file, JSON.stringify(rest, null, 2) + '\n', 0o644)
      out.push({ file, removed: true })
    } else {
      out.push({ file, removed: false, left: read.state === 'ok' && Object.hasOwn(read.data, IDLE_COMPACTION_KEY) ? 'the key no longer holds the value install wrote' : 'the key is not there' })
    }
  }
  if (!dryRun && Object.keys(recorded).length > 0) {
    updateInstallState((current) => {
      const next: InstallState = { ...current }
      if (Object.keys(remaining).length > 0) next.idleCompaction = remaining
      else delete next.idleCompaction
      return next
    })
  }
  return out
}
