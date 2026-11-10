/**
 * Antigravity CLI's named hook (D413, D414): what install writes into
 * `~/.gemini/config/hooks.json` from agy 1.5.3, how it is written beside the
 * developer's own named hooks without touching them, how it is taken back,
 * and doctor's row for it.
 *
 * agy's hooks file is keyed by hook name, each name holding its events
 * (`{enabled?, <Event>: [...]}`; PostToolUse grouped under a `matcher`, the
 * other events flat lists of handlers), and agy merges every named hook it
 * finds (the far-side pass of 2026-11-09). treecontext's is the one named
 * `treecontext`: install writes it, converges it and takes it back, and
 * never writes, moves or removes another name. A file in another shape is
 * refused whole by agy, silencing every hook in it, with a line only in
 * agy's own log; there is no command that lists the hooks agy loaded (agy
 * 1.5.3's subcommands: `mcp`, `plugin`, `agent`, `models`, ...), so install
 * writes only the shape recorded working and doctor reads the file.
 *
 * The file is changed by text edits (json-text-edit.ts): the developer's
 * bytes are kept, numbers past 2^53, escapes, spacing and key order
 * included; a change edits cannot make is a refusal, byte for byte.
 *
 * One invariant, read in one place (agyHooksPresent): treecontext's named
 * hook is in agy's hooks file if and only if agy's MCP entry starts the
 * server in capture mode (D386), since a hook that is written can run, and
 * only a capture-mode server drains what it stages.
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { AGY_CLIENT, HOOK_CLIENT_FLAG } from '../hooks/hook-client.js'
import { TC_HOOK_PREFIX, HOOK_SCRIPTS_DIR_NAME, isOwnHookCommand } from './hook-command-owner.js'
import { claudeHookCommand, hookShellFor, type ActionResult, type ClientHookReport } from './installer.js'
import { agyHooksPath } from './agents.js'
import { editJsonText, canonicalJson } from './json-text-edit.js'
import { writeTarget, unwritableFile, compareVersions, type CodexHooksTarget } from './codex-hooks.js'
import { readInstallState, updateInstallState, writeAtomic, recordCreatedFile, installCreated, forgetCreatedFile } from './install-state.js'

/** The oldest Antigravity CLI a live run verified capture at (D413), and the
 *  version whose transcript layout capture reads (D418). */
export const AGY_CAPTURE_FLOOR = '1.5.3'

/** The name of treecontext's hook in agy's hooks file (D413). */
export const AGY_HOOK_NAME = 'treecontext'

/** The events install wires for agy, in the order it writes them, each with
 *  what it is for: the events agy's list marks wired
 *  (tests/fixtures/agy-hooks/events.json), and no other. PreToolUse is never
 *  wired: its hook must answer with a permission decision. */
export const AGY_HOOK_EVENTS: ReadonlyArray<{ event: string; purpose: string }> = [
  { event: 'SessionStart', purpose: 'a ticketed worker linked to its lane' },
  { event: 'PreInvocation', purpose: 'each turn\'s prompt, at its first model call' },
  { event: 'PostToolUse', purpose: 'each tool call, held until its result is read' },
  { event: 'PostInvocation', purpose: 'each call\'s output, read from agy\'s transcript' },
  { event: 'Stop', purpose: 'each turn\'s reply, and any call whose output was not captured' },
]

/** Seconds: the timeout of the shape recorded working (agy's default is 30). */
const AGY_HOOK_TIMEOUT = 10

/** The command an agy hook runs: the hook script, the event, naming agy. */
export function agyHookCommand(event: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const script = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME, `${TC_HOOK_PREFIX}agy${ext}`)
  const cmd = `${claudeHookCommand(script, hookShellFor())} ${event} ${HOOK_CLIENT_FLAG} ${AGY_CLIENT}`
  return process.platform === 'win32' ? cmd : `exec ${cmd}`
}

/** treecontext's named hook exactly as install writes it. */
export function agyHooksBlock(): Record<string, unknown[]> {
  const block: Record<string, unknown[]> = {}
  for (const { event } of AGY_HOOK_EVENTS) {
    const handler = { type: 'command', command: agyHookCommand(event), timeout: AGY_HOOK_TIMEOUT }
    block[event] = event === 'PostToolUse' ? [{ matcher: '*', hooks: [handler] }] : [handler]
  }
  return block
}

/** Every command of the block install writes. */
export function agyBlockCommands(): string[] {
  return commandsIn(agyHooksBlock())
}

/** Every `command` string in a value, in order. */
export function commandsIn(v: unknown): string[] {
  const out: string[] = []
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
        if (k === 'command' && typeof y === 'string') out.push(y)
        else walk(y)
      }
    }
  }
  walk(v)
  return out
}

// ── The version ────────────────────────────────────────────────────────

/** `agy --version`'s x.y.z, or null where it cannot be read. */
export function parseAgyVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null
}

/** The agy on PATH's version (`agy --version`, no model call), or null. */
export function readAgyVersion(timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('agy', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' })
    } catch { finish(null); return }
    const t = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', () => { clearTimeout(t); finish(null) })
    child.on('close', (code) => { clearTimeout(t); finish(code === 0 ? parseAgyVersion(out) : null) })
  })
}

export type AgyCapture = { state: 'capture'; version: string } | { state: 'below'; version: string } | { state: 'unreadable' }

export function agyCaptureOf(version: string | null): AgyCapture {
  if (version === null) return { state: 'unreadable' }
  return compareVersions(version, AGY_CAPTURE_FLOOR) < 0 ? { state: 'below', version } : { state: 'capture', version }
}

/** Install's one line for an agy that stays tools-only by its version. */
export function agyToolsOnlyLine(c: Exclude<AgyCapture, { state: 'capture' }>): string {
  return c.state === 'below'
    ? `Antigravity CLI stays tools-only: its version reads ${c.version}, and ${AGY_CAPTURE_FLOOR} is the first version whose hooks install writes`
    : `Antigravity CLI stays tools-only: its version could not be read (agy --version), and ${AGY_CAPTURE_FLOOR} is the first version whose hooks install writes`
}

// ── The file ───────────────────────────────────────────────────────────

export type AgyHooksFile =
  | { state: 'absent' }
  /** Not JSON, or not readable: the parser's own words. */
  | { state: 'unparsed'; error: string }
  /** JSON that is not an object of named hooks. */
  | { state: 'unplaceable'; error: string }
  | { state: 'ok'; data: Record<string, unknown>; text: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function readAgyHooksFile(path: string = agyHooksPath()): AgyHooksFile {
  if (!existsSync(path)) return { state: 'absent' }
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (e) { return { state: 'unparsed', error: e instanceof Error ? e.message : String(e) } }
  if (text.trim() === '') return { state: 'ok', data: {}, text }
  let data: unknown
  try { data = JSON.parse(text) as unknown } catch (e) { return { state: 'unparsed', error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim() } }
  if (!isObject(data)) return { state: 'unplaceable', error: `the file is ${Array.isArray(data) ? 'an array' : data === null ? 'null' : typeof data}, not an object of named hooks` }
  return { state: 'ok', data, text }
}

/** The commands install's record says it wrote into agy's hooks file. */
export function recordedAgyCommands(): Set<string> {
  return new Set(readInstallState().agyHooks?.commands ?? [])
}

function recordAgyHooks(file: string, commands: string[]): void {
  updateInstallState((state) => {
    if (commands.length === 0) {
      if (!state.agyHooks) return false
      delete state.agyHooks
      return state
    }
    if (state.agyHooks?.file === file && JSON.stringify(state.agyHooks.commands) === JSON.stringify(commands)) return false
    state.agyHooks = { file, commands, at: new Date().toISOString() }
    return state
  })
}

/** Whether a command is treecontext's: one install's record names, or, where
 *  no record names any, one that runs a treecontext hook script. */
function ownCommand(cmd: unknown, recorded: ReadonlySet<string>): boolean {
  if (typeof cmd !== 'string') return false
  return recorded.has(cmd) || isOwnHookCommand(cmd)
}

/** What the name `treecontext` holds in agy's hooks file. */
export type AgyBlockState =
  | { state: 'none' }
  | { state: 'current'; enabled: boolean }
  /** treecontext's, but not this build's: the events it differs on. */
  | { state: 'earlier'; enabled: boolean; events: string[] }
  /** The name is taken by a hook install did not write. */
  | { state: 'taken' }

export function agyBlockState(data: Record<string, unknown>, recorded: ReadonlySet<string> = recordedAgyCommands()): AgyBlockState {
  if (!Object.hasOwn(data, AGY_HOOK_NAME)) return { state: 'none' }
  const v = data[AGY_HOOK_NAME]
  if (!isObject(v)) return { state: 'taken' }
  const cmds = commandsIn(v)
  if (cmds.length === 0 || !cmds.every((c) => ownCommand(c, recorded))) return { state: 'taken' }
  const enabled = v['enabled'] !== false
  const { enabled: _e, ...rest } = v
  const block = agyHooksBlock()
  if (canonicalJson(rest) === canonicalJson(block)) return { state: 'current', enabled }
  const events = [...new Set([...Object.keys(block), ...Object.keys(rest)])]
    .filter((e) => canonicalJson(rest[e]) !== canonicalJson(block[e]))
  return { state: 'earlier', enabled, events }
}

/**
 * Whether treecontext's named hook is in agy's hooks file (D386, D413): the
 * one reading agy's entry's capture mode follows, at install, uninstall and
 * doctor. A hook switched off with `enabled: false` is present (it runs once
 * the developer turns it on); a file that does not parse holds none that
 * run, agy loading none of it.
 */
export function agyHooksPresent(file: string = agyHooksPath()): boolean {
  const read = readAgyHooksFile(file)
  if (read.state !== 'ok') return false
  const s = agyBlockState(read.data).state
  return s === 'current' || s === 'earlier'
}

/** Whether the text of a file install cannot read names treecontext's hook. */
function namedInText(file: string): boolean {
  try { return readFileSync(file, 'utf8').includes(`${TC_HOOK_PREFIX}agy`) } catch { return false }
}

/** The new text, by edits alone: treecontext's named hook taken out, then
 *  `next` (when given) appended as a new top-level name. Null where edits
 *  cannot make it, the caller then changing nothing. */
export function agyHooksTextFor(read: AgyHooksFile, data: Record<string, unknown>, next: Record<string, unknown> | null): string | null {
  const { [AGY_HOOK_NAME]: _old, ...without } = data
  const target = next ? { ...without, [AGY_HOOK_NAME]: next } : without
  if (read.state !== 'ok' || read.text.trim() === '') return JSON.stringify(target, null, 1) + '\n'
  const recorded = recordedAgyCommands()
  const ownValue = (v: unknown): boolean => isObject(v) && commandsIn(v).length > 0 && commandsIn(v).every((c) => ownCommand(c, recorded) || agyBlockCommands().includes(c))
  const rules = {
    appendAt: (path: Array<string | number>): boolean => path.length === 0,
    owns: (v: unknown): boolean => next !== null && canonicalJson(v) === canonicalJson(next),
    ownString: (s: string): boolean => ownCommand(s, recorded) || agyBlockCommands().includes(s),
    ownPart: ownValue,
  }
  const stripped = Object.hasOwn(data, AGY_HOOK_NAME) ? editJsonText(read.text, without, rules) : read.text
  if (stripped === null) return null
  if (!next) return stripped
  return editJsonText(stripped, target, rules)
}

/** What one agy hooks step did: its file action, its lines, and whether
 *  treecontext's named hook is in the file once done (`present`). */
export interface AgyHooksOutcome { action: ActionResult | null; lines: string[]; wrote: boolean; present: boolean; refused?: string }

function writeHooksText(place: Extract<CodexHooksTarget, { ok: true }>, text: string): void {
  mkdirSync(dirname(place.target), { recursive: true })
  const mode = existsSync(place.target) ? statSync(place.target).mode & 0o777 : 0o600
  writeAtomic(place.target, text, mode)
  if (process.platform !== 'win32') chmodSync(place.target, mode)
}

/** The line for a hooks file that does not parse, quoting the error (D413). */
export function agyUnparsedLine(file: string, error: string): string {
  return `Antigravity CLI stays tools-only: its hooks file ${file} does not parse (${error}), so install leaves it byte for byte; agy runs none of the hooks in that file, yours included, until it is fixed`
}

/**
 * Install's agy named hook at the floor or later (D413). `beforeWrite` runs
 * once the file is found fit to write, before any write: the hook scripts
 * the hook runs, so it never names one install did not write.
 */
export function installAgyHooks(dryRun: boolean, beforeWrite?: () => void): AgyHooksOutcome {
  const file = agyHooksPath()
  const none = (line: string, refused?: string): AgyHooksOutcome => ({ action: null, wrote: false, present: agyHooksPresent(file), lines: [`  hooks: none written — ${line}`], ...(refused ? { refused } : {}) })
  const place = writeTarget(file)
  if (!place.ok) return none(`Antigravity CLI stays tools-only: ${place.why}; install changes nothing there`, place.why)
  const read = readAgyHooksFile(file)
  if (read.state === 'unparsed') return none(agyUnparsedLine(file, read.error))
  if (read.state === 'unplaceable') return none(`Antigravity CLI stays tools-only: in its hooks file ${file}, ${read.error}; install leaves it byte for byte`)
  const data = read.state === 'ok' ? read.data : {}
  const state = agyBlockState(data)
  if (state.state === 'taken') {
    return none(`Antigravity CLI stays tools-only: the name "${AGY_HOOK_NAME}" in ${file} is taken by a hook install did not write, so install writes none and leaves it as it is; rename that hook to have treecontext's written`)
  }
  const block = agyHooksBlock()
  const enabled = state.state === 'none' || state.enabled
  const next: Record<string, unknown> = enabled ? block : { enabled: false, ...block }
  const changed = state.state !== 'current'
  const refused = changed ? unwritableFile(file) : null
  if (refused) return none(`Antigravity CLI stays tools-only: ${refused}; install changes nothing in it`, refused)
  const text = changed ? agyHooksTextFor(read, data, next) : null
  if (changed && text === null) return none(`Antigravity CLI stays tools-only: install cannot write its named hook into ${file} without rewriting text of yours, so it leaves the file byte for byte`)
  beforeWrite?.()
  const created = read.state === 'absent'
  let action: ActionResult
  if (!changed) {
    action = { type: 'hook-settings', path: file, status: 'skipped', detail: 'already configured' }
  } else {
    if (!dryRun) {
      writeHooksText(place, text!)
      if (created && !place.link) recordCreatedFile(file)
    }
    action = { type: 'hook-settings', path: file, status: dryRun ? 'dry-run' : created ? 'created' : 'updated' }
  }
  if (!dryRun) recordAgyHooks(file, agyBlockCommands())
  const lines = [`  hooks: ${file}${place.link ? ` (a symlink to ${place.target}, written there, the link kept)` : ''} [${action.status}${action.detail ? ` — ${action.detail}` : ''}] — the named hook "${AGY_HOOK_NAME}", beside any of yours`]
  for (const e of AGY_HOOK_EVENTS) lines.push(`  hooks: ${e.event} (${e.purpose})`)
  lines.push('  hooks: PreToolUse not wired: its hook must decide the call\'s permission, which treecontext never does')
  if (!enabled) lines.push(`  hooks: your "enabled": false on the named hook "${AGY_HOOK_NAME}" is kept: agy runs it only once you turn it on, and nothing of agy's sessions is captured until then`)
  return { action, wrote: changed, present: dryRun ? true : agyHooksPresent(file), lines }
}

/**
 * Take back what install wrote for agy (D413): the named hook its record
 * names or, where none does, the named hook `treecontext` whose commands are
 * treecontext's; never a hook of the developer's. A file that does not
 * parse is left as it is. The file is deleted only where install's record
 * says install created it and nothing else is left; a symlink is written
 * through, never deleted. A file that cannot be written is a refusal: the
 * hook remains and still runs.
 */
export function takeBackAgyHooks(dryRun: boolean): AgyHooksOutcome {
  const file = agyHooksPath()
  const read = readAgyHooksFile(file)
  if (read.state === 'absent') { if (!dryRun) recordAgyHooks(file, []); return { action: null, wrote: false, present: false, lines: [] } }
  if (read.state !== 'ok') {
    const left = namedInText(file) ? '; treecontext\'s named hook in it stays, and runs again once the file parses: after fixing it, run treecontext install --agent agy (or uninstall again)' : ''
    return { action: null, wrote: false, present: false, lines: [`  hooks: ${file} ${read.state === 'unparsed' ? `does not parse (${read.error})` : `holds no named hooks (${read.error})`}: left as it is${left}; fix it by hand`] }
  }
  const state = agyBlockState(read.data)
  if (state.state === 'none' || state.state === 'taken') { if (!dryRun) recordAgyHooks(file, []); return { action: null, wrote: false, present: false, lines: [] } }
  const recorded = recordedAgyCommands()
  const place = writeTarget(file)
  const refused = unwritableFile(file) ?? (place.ok ? null : place.why)
  if (refused || !place.ok) {
    return { action: null, wrote: false, present: true, refused: `treecontext's named hook remains in ${file} and agy still runs it: ${refused}`, lines: [`  hooks: treecontext's named hook remains in ${file}, and agy still runs it — ${refused}; nothing in it was changed`] }
  }
  const text = agyHooksTextFor(read, read.data, null)
  if (text === null) return { action: null, wrote: false, present: true, refused: `install cannot take its named hook out of ${file} without rewriting text of yours`, lines: [`  hooks: ${file}: install cannot take treecontext's named hook out without rewriting text of yours, so it is left as it is; take it out by hand`] }
  const { [AGY_HOOK_NAME]: _gone, ...rest } = read.data
  let detail = `removed the named hook "${AGY_HOOK_NAME}"`
  if (!dryRun) {
    if (Object.keys(rest).length === 0 && !place.link && installCreated(file) && lstatSync(file).isFile()) {
      rmSync(file, { force: true })
      forgetCreatedFile(file)
      detail += '; the file install created is gone, nothing else being in it'
    } else {
      writeHooksText(place, text)
      if (place.link) detail += `; written in ${place.target}, the symlink kept`
    }
    recordAgyHooks(file, [])
  }
  const lines = [`  hooks: ${file} [${dryRun ? 'dry-run' : 'updated'} — ${detail}]`]
  if (recorded.size === 0) lines.push(`  hooks: the named hook "${AGY_HOOK_NAME}" was known by its commands as treecontext's, no install record naming it`)
  return { action: { type: 'hook-settings', path: file, status: dryRun ? 'dry-run' : 'updated', detail }, wrote: true, present: dryRun ? false : agyHooksPresent(file), lines }
}

// ── Doctor's row for Antigravity CLI (D414) ───────────────────────────

export const AGY_HOOK_MODE = `keeps its own hook configuration, where install writes a named hook of its own beside the developer's from ${AGY_CAPTURE_FLOOR} (~/.gemini/config/hooks.json, the named hook "${AGY_HOOK_NAME}")`
const INSTALL_AGY = 'treecontext install --agent agy'

/** Doctor's clause for agy's hooks (D414), read from agy's own files and its version. */
export function agyHookReport(version: string | null): ClientHookReport {
  const mode = AGY_HOOK_MODE
  const file = agyHooksPath()
  const capture = agyCaptureOf(version)
  const read = readAgyHooksFile(file)
  const versionNote = capture.state === 'capture' && capture.version !== AGY_CAPTURE_FLOOR
    ? `; agy's version reads ${capture.version}, and capture reads agy's transcript in the layout recorded at ${AGY_CAPTURE_FLOOR}`
    : ''
  if (read.state === 'unparsed' || read.state === 'unplaceable') {
    return {
      mode, state: `agy's hooks file ${file} ${read.state === 'unparsed' ? `does not parse (${read.error})` : `holds no named hooks (${read.error})`}, so agy runs none of the hooks in that file, the developer's own included`,
      remedy: `fixing ${file} by hand, never an install`, warn: true, fix: `fix ${file} by hand so it parses`, hooksPresent: false,
    }
  }
  const state = read.state === 'ok' ? agyBlockState(read.data) : { state: 'none' as const }
  if (capture.state !== 'capture') {
    const why = capture.state === 'below' ? `its version reads ${capture.version}, and ${AGY_CAPTURE_FLOOR} is the first version whose hooks install writes` : 'its version could not be read (agy --version)'
    const present = state.state === 'current' || state.state === 'earlier'
    return {
      mode, state: present
        ? `treecontext's named hook is written in ${file} for an agy that gets the tools only: ${why}`
        : `agy is tools-only: ${why}`,
      remedy: `upgrading agy to ${AGY_CAPTURE_FLOOR} or later, then ${INSTALL_AGY}`, warn: present, ...(present ? { fix: INSTALL_AGY } : {}), hooksPresent: present,
    }
  }
  if (state.state === 'taken') {
    return {
      mode, state: `the name "${AGY_HOOK_NAME}" in ${file} is taken by a hook install did not write, so nothing of agy's sessions is captured${versionNote}`,
      remedy: 'renaming that hook, the developer\'s to do', warn: true, fix: `rename the hook "${AGY_HOOK_NAME}" in ${file}, then ${INSTALL_AGY}`, hooksPresent: false,
    }
  }
  if (state.state === 'none') {
    return {
      mode, state: `no treecontext hook is written in ${file}, so nothing of agy's sessions is captured${versionNote}`,
      remedy: INSTALL_AGY, warn: true, fix: INSTALL_AGY, hooksPresent: false,
    }
  }
  if (!state.enabled) {
    return {
      mode, state: `treecontext's named hook in ${file} is switched off with "enabled": false, the developer's choice, so nothing of agy's sessions is captured${versionNote}`,
      remedy: 'turning it on, the developer\'s to do', warn: false, hooksPresent: true,
    }
  }
  if (state.state === 'earlier') {
    return {
      mode, state: `treecontext's named hook in ${file} is an earlier build's, differing on ${state.events.join(', ')}${versionNote}`,
      remedy: `${INSTALL_AGY}, which rewrites it`, warn: true, fix: INSTALL_AGY, hooksPresent: true,
    }
  }
  return {
    mode, state: `treecontext's hooks are present in ${file} and current (the named hook "${AGY_HOOK_NAME}")${versionNote}`,
    remedy: 'nothing to do', warn: false, hooksPresent: true,
  }
}
