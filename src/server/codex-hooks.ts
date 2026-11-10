/**
 * Codex CLI's own hooks block (D406, D409): what install writes into
 * `~/.codex/hooks.json` from Codex CLI 0.167.0, how it is written beside the
 * developer's own hooks without moving them, how it is taken back, and how
 * a hook's place is named the way Codex keys its trust.
 *
 * Codex runs a hook only once the developer has trusted it (`/hooks` in
 * Codex), and records that trust against the hook's place in the file
 * (`<file>:<event>:<group>:<index>`) and its current hash (recorded live,
 * 2026-11-09, Codex CLI 0.167.0). So install writes its hooks in groups of
 * their own after the developer's, never into a group of the developer's,
 * leaves the file byte for byte as it was when nothing changed, and names
 * every hook a change of its own leaves at a new place or with a new text,
 * since Codex will ask to trust that hook again. Install never writes
 * Codex's record of trusted hooks.
 *
 * The commands run the hook scripts Claude Code's block runs
 * (`~/.claude/hooks/tc-*`), each naming Codex (`--client codex`), and the
 * hook takes its client from there, never from the payload (D404).
 */
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { CODEX_CLIENT } from '../hooks/hook-client.js'
import { isOwnHookCommand, TC_HOOK_PREFIX, HOOK_SCRIPTS_DIR_NAME, CODEX_HOOK_MODE } from './hook-command-owner.js'
import { claudeHookDispatch, hookShellFor, type ClaudeHookMatcher, type ClaudeHookEntry, type ActionResult, type ClientHookReport } from './installer.js'
import { codexDir, codexHome, codexHomeNote } from './codex-home.js'
import { editJsonText } from './json-text-edit.js'
import { codexOriginFile, type CodexConfigRead, type CodexHooksTrust, type CodexListedHook } from './codex-client.js'
import { readInstallState, updateInstallState, writeAtomic, recordCreatedFile, installCreated, forgetCreatedFile } from './install-state.js'

/** The oldest Codex CLI a live run verified capture at (D406). */
export const CODEX_CAPTURE_FLOOR = '0.167.0'

/** One event of Codex's block: the hook script it runs and what it is for. */
export interface CodexHookEvent {
  event: string
  script: string
  purpose: string
  /** Seconds; only where Codex's default would cut the hook short. */
  timeout?: number
}

/**
 * The events install wires for Codex, in the order it writes them: the
 * events Codex's list marks wired (tests/fixtures/codex-hooks/events.json),
 * and no other. Interrupt's default timeout is 1 s and at most 3 s in
 * Codex's documentation (read 2026-11-10); the hook gets the 3 s.
 */
export const CODEX_HOOK_EVENTS: readonly CodexHookEvent[] = [
  { event: 'SessionStart', script: 'session-start', purpose: 'self registration, a main\'s re-orientation packet, the recovery note after a compaction' },
  { event: 'UserPromptSubmit', script: 'user-prompt-submit', purpose: 'the developer\'s prompts' },
  { event: 'PreToolUse', script: 'post-tool-use', purpose: 'the account of a call Codex reports no result for' },
  { event: 'PostToolUse', script: 'post-tool-use', purpose: 'tool calls and their results' },
  { event: 'Stop', script: 'stop', purpose: 'each turn\'s last reply' },
  { event: 'Interrupt', script: 'stop', purpose: 'a turn the developer interrupted', timeout: 3 },
  { event: 'PreCompact', script: 'pre-compact', purpose: 'the recovery snapshot before a compaction' },
  { event: 'SubagentStart', script: 'subagent-start', purpose: 'subagent registration' },
  { event: 'SubagentStop', script: 'subagent-stop', purpose: 'subagent report capture' },
]

/** Codex's hooks file, in the directory Codex reads (codex-home.ts). */
export function codexHooksPath(): string {
  return join(codexDir(), 'hooks.json')
}

/** The command a Codex hook runs: the hook script, naming Codex. */
export function codexHookCommand(script: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  return claudeHookDispatch(join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME, `${TC_HOOK_PREFIX}${script}${ext}`), hookShellFor(), process.platform, CODEX_CLIENT)
}

/** Codex's block exactly as install writes it: one group of its own per
 *  event, no matcher (every source, tool and agent type), one hook each. */
export function codexHooksBlock(): Record<string, ClaudeHookMatcher[]> {
  const block: Record<string, ClaudeHookMatcher[]> = {}
  for (const e of CODEX_HOOK_EVENTS) {
    const entry: ClaudeHookEntry & { timeout?: number } = { type: 'command', command: codexHookCommand(e.script) }
    if (e.timeout !== undefined) entry.timeout = e.timeout
    block[e.event] = [{ hooks: [entry] }]
  }
  return block
}

/** The x.y.z order of two versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** What the Codex on PATH gets from install: capture at the floor or later. */
export type CodexCapture = { state: 'capture'; version: string } | { state: 'below'; version: string } | { state: 'unreadable' }

export function codexCaptureOf(version: string | null): CodexCapture {
  if (version === null) return { state: 'unreadable' }
  return compareVersions(version, CODEX_CAPTURE_FLOOR) < 0 ? { state: 'below', version } : { state: 'capture', version }
}

/** Install's one line for a Codex that stays tools-only. */
export function codexToolsOnlyLine(c: Exclude<CodexCapture, { state: 'capture' }>): string {
  return c.state === 'below'
    ? `Codex CLI stays tools-only: its version reads ${c.version}, and capture needs Codex CLI ${CODEX_CAPTURE_FLOOR} or later`
    : `Codex CLI stays tools-only: its version could not be read (codex --version), and capture needs Codex CLI ${CODEX_CAPTURE_FLOOR} or later`
}

/** The one line install says whenever it writes or changes a Codex hook (D406). */
export const CODEX_TRUST_LINE = 'Codex runs none of treecontext\'s hooks until you trust them: open /hooks in Codex and trust each one '
  + '(Codex treats a hook that is new, changed or moved as untrusted). Install never marks a hook trusted.'

// ── The file ──────────────────────────────────────────────────────────

export type CodexHooksFile =
  | { state: 'absent' }
  /** Not JSON, or not readable: install's own parse error, quoted. */
  | { state: 'unparsed'; error: string }
  /** JSON install cannot add its groups to without changing a part that is
   *  not its own (codexPlacementError). Codex may load it all the same:
   *  whether Codex loads a file is Codex's verdict (codexVerdictOf). */
  | { state: 'unplaceable'; error: string }
  | { state: 'ok'; data: Record<string, unknown>; text: string }

/** Codex's hooks file as install reads it: absent, not JSON (its parse
 *  error), JSON install cannot place its groups in, or its object. An
 *  empty file reads as an empty object (Codex's own verdict on it, an
 *  "EOF while parsing", is asked of Codex where Codex can answer). */
export function readCodexHooksFile(path: string = codexHooksPath()): CodexHooksFile {
  if (!existsSync(path)) return { state: 'absent' }
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (e) { return { state: 'unparsed', error: e instanceof Error ? e.message : String(e) } }
  if (text.trim() === '') return { state: 'ok', data: {}, text }
  let data: unknown
  try { data = JSON.parse(text) as unknown } catch (e) { return { state: 'unparsed', error: e instanceof Error ? e.message : String(e) } }
  const wrong = codexPlacementError(data)
  if (wrong) return { state: 'unplaceable', error: wrong }
  return { state: 'ok', data: data as Record<string, unknown>, text }
}

/** What a JSON value is, in words; total over every value, `undefined` included. */
function kindOf(v: unknown): string {
  if (v === undefined) return 'absent'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'object') return 'an object'
  if (typeof v === 'string') return `a string ${JSON.stringify(v).slice(0, 40)}`
  return `${typeof v} ${String(v).slice(0, 40)}`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Install's own structural needs, narrower than Codex's grammar (whether
 * Codex loads the file is Codex's own verdict, codexVerdictOf): only what
 * install reads or steps around to append its groups after the developer's
 * and to recognise its own. The top level an object; `hooks`, when present,
 * an object of events; each event install writes (CODEX_HOOK_EVENTS), when
 * present, an array of groups. Every other part (groups and hooks of any
 * shape, events install does not write, keys Codex itself rejects) is the
 * developer's: never judged here and kept as it is. Returns the first part
 * that is not so, in words, or null. Total over every JSON value.
 */
export function codexPlacementError(data: unknown): string | null {
  if (!isObject(data)) return `the file is ${kindOf(data)}, not a JSON object, so install has no place to add its hooks`
  const hooks = Object.hasOwn(data, 'hooks') ? data['hooks'] : undefined
  if (hooks === undefined) return null
  if (!isObject(hooks)) return `"hooks" is ${kindOf(hooks)}, not an object of events, so install cannot add its groups beside yours`
  for (const e of CODEX_HOOK_EVENTS) {
    const v = Object.hasOwn(hooks, e.event) ? hooks[e.event] : undefined
    if (v !== undefined && !Array.isArray(v)) return `"hooks.${e.event}" is ${kindOf(v)}, not an array of groups, so install cannot add its group after yours`
  }
  return null
}

// ── Codex's own verdict on the file (D406, D419's principle) ───────────

/**
 * What Codex says of its hooks file, read from its app server's
 * `hooks/list` for a directory (codex-client.ts readCodexHooksTrust). The
 * answer's shapes, recorded from Codex CLI 0.167.0 under a throwaway HOME
 * on 2026-11-10 (one file per probe, 50 shapes):
 *  - `result.data[0]` is `{ cwd, hooks: [...], warnings: string[], errors: [] }`,
 *    each hook `{ key: '<path>:pre_tool_use:<group>:<index>', eventName:
 *    'preToolUse', command, sourcePath, trustStatus, ... }`;
 *  - a file Codex does not load: none of its hooks listed, and a warning
 *    `failed to parse hooks config <path>: <serde's words> at line L column C`
 *    (JSON that does not parse, an empty file, a top-level key other than
 *    `description` and `hooks`, `mcpServers` among them, a duplicate key, a
 *    `description`, `command` or `matcher` that is not a string, a hook
 *    without `type` or `command`, a `timeout` that is not a u64, an event
 *    Codex knows whose value is not a sequence) or `failed to read hooks
 *    config <path>: <the OS's words>`;
 *  - a file it loads: its hooks listed, each with `sourcePath` the path as
 *    Codex names it (a symlink by its own path, never its target's). Loaded
 *    silently: a group with no `hooks` beside a valid one, an event Codex
 *    does not know whatever its value, serde's sequence forms of a struct
 *    (`[]` at the top level, a group as `["matcher", [hooks]]`). A hook it
 *    skips in a file it loads says so in another form (`skipping prompt
 *    hook in <path>: ...`);
 *  - no file, a directory or a dangling symlink at the path, or hooks
 *    turned off (`[features] hooks = false`): nothing listed, nothing said;
 *  - a failure inside Codex (a `timeout` past i64 panics its hashing): a
 *    JSON-RPC error, `hook discovery task failed: ...`, which is no answer.
 * `errors` was empty in every probe; it is read as `warnings` is.
 */
export type CodexFileVerdict =
  /** Codex loads the file: `ours` of treecontext's hooks listed from it, and its other words naming the file. */
  | { state: 'loads'; ours: number; said: string[] }
  /** Codex does not load the file: its own words. */
  | { state: 'rejects'; said: string }
  /** Codex could not be asked, or did not answer. */
  | { state: 'unknown'; why: string }

/** An event's name in any of Codex's spellings (`PreToolUse`, `preToolUse`, `pre_tool_use`), folded to one. */
function eventFold(event: string): string {
  return event.replace(/_/g, '').toLowerCase()
}

/** A block's hooks as Codex lists them, by event and command, one key each
 *  (`hooks/list` names an event `preToolUse`, its trust key `pre_tool_use`). */
export function blockHookKeys(block: Record<string, ClaudeHookMatcher[]>): Set<string> {
  return new Set(Object.entries(block).flatMap(([event, g]) => g.flatMap(m => m.hooks.map(h => `${eventFold(event)}\n${h.command}`))))
}

/** Codex's verdict on `file` from its `hooks/list` answer (see CodexFileVerdict). */
export function codexVerdictOf(trust: CodexHooksTrust, file: string, hooks: ReadonlySet<string>): CodexFileVerdict {
  if (!trust.ok) return { state: 'unknown', why: trust.why }
  const words = [...trust.warnings, ...trust.errors].map(x => typeof x === 'string' ? x : JSON.stringify(x))
  const naming = words.filter(w => w.includes(` ${file}:`))
  const failed = naming.find(w => /^failed to (?:parse|read) hooks config /.test(w))
  if (failed) return { state: 'rejects', said: failed }
  return { state: 'loads', ours: trust.hooks.filter(h => h.sourcePath === file && hooks.has(`${eventFold(h.eventName)}\n${h.command}`)).length, said: naming }
}

/** Keys of a Codex hooks.json that are not hook events. */
const NON_EVENT_KEYS = new Set(['hooks', 'description', 'mcpServers', 'servers', 'mcp_servers'])

type LooseHook = { command?: unknown } & Record<string, unknown>
type LooseGroup = { matcher?: unknown; hooks?: LooseHook[] } & Record<string, unknown>

/** A hook at its place in the file, as Codex keys its trust. */
export interface HookPlace { event: string; group: number; index: number; command: string }

/** Codex's spelling of an event in a trust key (`PostToolUse` → `post_tool_use`). */
export function eventSnake(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** The trust key Codex gives a hook at this place (`<file>:<event>:<group>:<index>`). */
export function codexHookKey(file: string, p: Pick<HookPlace, 'event' | 'group' | 'index'>): string {
  return `${file}:${eventSnake(p.event)}:${p.group}:${p.index}`
}

/** A hook named for the developer: its event, its place and its command. */
export function describePlace(p: HookPlace): string {
  return `${p.event} group ${p.group} hook ${p.index} (${p.command})`
}

/** Every hook in a hooks map, at its place. */
export function hookPlaces(hooks: unknown): HookPlace[] {
  const out: HookPlace[] = []
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return out
  for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue
    arr.forEach((g: LooseGroup, gi) => {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) return
      g.hooks.forEach((h, hi) => {
        if (h && typeof h.command === 'string') out.push({ event, group: gi, index: hi, command: h.command })
      })
    })
  }
  return out
}

/** Whether a command is treecontext's: one install recorded writing, or
 *  one known by its commands as an earlier build's (hook-command-owner.ts). */
export function isTreecontextCodexHook(command: unknown, recorded: ReadonlySet<string>): boolean {
  return typeof command === 'string' && (recorded.has(command) || isOwnHookCommand(command))
}

/**
 * What a take-back takes out (uninstall, a tools-only install): where
 * install's record names the commands it wrote, exactly those; only where
 * no record names any (an earlier build's file) a command known by its
 * shape (hook-command-owner.ts), when a hook of the developer's with the
 * very same text cannot be told apart and is taken too (said in the output
 * and the README). Install's own convergence and doctor still know an
 * earlier build's commands beside a record (D406's reinstall).
 */
export function takenBackByRecord(command: unknown, recorded: ReadonlySet<string>): boolean {
  if (typeof command !== 'string') return false
  return recorded.size > 0 ? recorded.has(command) : isOwnHookCommand(command)
}

/** JSON with object keys sorted, so two equal groups print alike. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** What a change to the file did to the hooks in it. */
export interface CodexHooksChange {
  data: Record<string, unknown>
  changed: boolean
  /** The developer's hooks now at another place, which Codex will ask to trust again. */
  moved: Array<{ from: HookPlace; to: HookPlace }>
  /** treecontext's hooks written new or at a new place. */
  written: HookPlace[]
  /** treecontext's hooks taken out. */
  removed: HookPlace[]
}

/** The developer's hooks whose place a change moved, matched by object identity. */
function movedHooks(before: Map<object, HookPlace>, hooks: unknown): Array<{ from: HookPlace; to: HookPlace }> {
  const out: Array<{ from: HookPlace; to: HookPlace }> = []
  if (!hooks || typeof hooks !== 'object') return out
  for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue
    arr.forEach((g: LooseGroup, gi) => {
      if (!g || !Array.isArray(g.hooks)) return
      g.hooks.forEach((h, hi) => {
        const from = h && typeof h === 'object' ? before.get(h) : undefined
        if (from && (from.group !== gi || from.index !== hi || from.event !== event)) {
          out.push({ from, to: { event, group: gi, index: hi, command: from.command } })
        }
      })
    })
  }
  return out
}

function placesByIdentity(hooks: unknown, keep: (cmd: unknown) => boolean): Map<object, HookPlace> {
  const m = new Map<object, HookPlace>()
  if (!hooks || typeof hooks !== 'object') return m
  for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue
    arr.forEach((g: LooseGroup, gi) => {
      if (!g || !Array.isArray(g.hooks)) return
      g.hooks.forEach((h, hi) => { if (h && typeof h === 'object' && keep(h.command)) m.set(h, { event, group: gi, index: hi, command: String(h.command) }) })
    })
  }
  return m
}

/** Take treecontext's hooks out of one event's groups: whole groups of
 *  treecontext's go, a developer's group keeps its own hooks. */
function stripEvent(arr: unknown[], ours: (cmd: unknown) => boolean): { kept: unknown[]; removed: number } {
  let removed = 0
  const kept: unknown[] = []
  for (const g of arr as LooseGroup[]) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { kept.push(g); continue }
    const own = g.hooks.filter(h => ours(h?.command)).length
    if (own === 0) { kept.push(g); continue }
    removed += own
    if (own === g.hooks.length) continue
    g.hooks = g.hooks.filter(h => !ours(h?.command))
    kept.push(g)
  }
  return { kept, removed }
}

/** An earlier build's per-agent entries at the file's top level (before the copy). */
function stripTopLevel(data: Record<string, unknown>, ours: (cmd: unknown) => boolean): boolean {
  let changed = false
  for (const [k, v] of Object.entries(data)) {
    if (NON_EVENT_KEYS.has(k) || !Array.isArray(v)) continue
    const { kept, removed } = stripEvent(v, ours)
    if (removed === 0) continue
    changed = true
    if (kept.length === 0) delete data[k]
    else data[k] = kept
  }
  return changed
}

/**
 * Converge a hooks file's object on `block` (D406): for each event, a group
 * of treecontext's that already reads exactly as the block's is left where
 * it is, and so is everything around it; otherwise treecontext's hooks of
 * that event are taken out (whole groups of its own, its hooks from any
 * group of the developer's an earlier build shared) and the block's group is
 * appended after the developer's. Events treecontext no longer wires lose
 * its hooks. The developer's hooks are never rewritten; the ones a removal
 * moved are reported, as are treecontext's hooks written at a new place.
 */
export function convergeCodexHooks(input: Record<string, unknown>, block: Record<string, ClaudeHookMatcher[]>, recorded: ReadonlySet<string> = new Set()): CodexHooksChange {
  const data = structuredClone(input)
  const ours = (cmd: unknown): boolean => isTreecontextCodexHook(cmd, recorded)
  let changed = stripTopLevel(data, ours)
  const hooksIn = data['hooks']
  const hooks: Record<string, unknown> = hooksIn && typeof hooksIn === 'object' && !Array.isArray(hooksIn) ? hooksIn as Record<string, unknown> : {}
  if (hooksIn !== undefined && hooks !== hooksIn) changed = true
  const removedBefore = placesByIdentity(hooks, ours)
  const developers = placesByIdentity(hooks, (c) => !ours(c))
  const written: HookPlace[] = []
  const events = [...Object.keys(hooks), ...Object.keys(block).filter(e => !(e in hooks))]
  for (const event of events) {
    const arr = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []
    const want = block[event]?.[0]
    const ownGroups = (arr as LooseGroup[]).filter(g => g && Array.isArray(g.hooks) && g.hooks.some(h => ours(h?.command)))
    const exact = want !== undefined && ownGroups.length === 1 && canonical(ownGroups[0]) === canonical(want)
    if (exact || (want === undefined && ownGroups.length === 0)) continue
    const { kept } = stripEvent(arr, ours)
    if (want !== undefined) {
      kept.push(structuredClone(want))
      want.hooks.forEach((h, hi) => written.push({ event, group: kept.length - 1, index: hi, command: h.command }))
    }
    changed = true
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (changed) data['hooks'] = hooks
  const after = placesByIdentity(hooks, () => true)
  const removed = [...removedBefore.entries()].filter(([o]) => !after.has(o)).map(([, p]) => p)
  return { data, changed, moved: movedHooks(developers, hooks), written, removed }
}

/** Take treecontext's hooks out of a hooks file's object, keeping the developer's (D406). */
export function takeBackCodexHooks(input: Record<string, unknown>, recorded: ReadonlySet<string> = new Set()): CodexHooksChange {
  const data = structuredClone(input)
  const ours = (cmd: unknown): boolean => takenBackByRecord(cmd, recorded)
  let changed = stripTopLevel(data, ours)
  const hooks = data['hooks'] && typeof data['hooks'] === 'object' && !Array.isArray(data['hooks']) ? data['hooks'] as Record<string, unknown> : null
  const removedBefore = placesByIdentity(hooks, ours)
  const developers = placesByIdentity(hooks, (c) => !ours(c))
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const arr = hooks[event]
      if (!Array.isArray(arr)) continue
      const { kept, removed } = stripEvent(arr, ours)
      if (removed === 0) continue
      changed = true
      if (kept.length === 0) delete hooks[event]
      else hooks[event] = kept
    }
    if (Object.keys(hooks).length === 0) delete data['hooks']
  }
  return { data, changed, moved: movedHooks(developers, hooks), written: [], removed: [...removedBefore.values()] }
}

/** How the treecontext hooks in a file compare with this build's block. */
export type CodexBlockState =
  | { state: 'none' }
  | { state: 'current' }
  | { state: 'claude-copy'; events: string[] }
  | { state: 'drifted'; events: string[] }

/**
 * Whether the file's treecontext hooks are this build's block: exactly its
 * groups; an earlier build's verbatim copy of the Claude Code block (its
 * commands naming no client, or its Claude-only events PostToolUseFailure
 * and PostToolBatch); or another block that drifted (the events that differ).
 */
export function codexBlockState(data: Record<string, unknown>, block: Record<string, ClaudeHookMatcher[]>, recorded: ReadonlySet<string> = new Set()): CodexBlockState {
  const ours = (cmd: unknown): boolean => isTreecontextCodexHook(cmd, recorded)
  const hooks = data['hooks'] && typeof data['hooks'] === 'object' ? data['hooks'] as Record<string, unknown> : {}
  const places = hookPlaces(hooks).filter(p => ours(p.command))
  const topLevel = Object.entries(data).some(([k, v]) => !NON_EVENT_KEYS.has(k) && Array.isArray(v) && hookPlaces({ [k]: v }).some(p => ours(p.command)))
  if (places.length === 0 && !topLevel) return { state: 'none' }
  const differ: string[] = []
  for (const event of [...Object.keys(block), ...Object.keys(hooks).filter(e => !(e in block))]) {
    const arr = Array.isArray(hooks[event]) ? hooks[event] as LooseGroup[] : []
    const own = arr.filter(g => g && Array.isArray(g.hooks) && g.hooks.some(h => ours(h?.command)))
    const want = block[event]
    const same = want ? own.length === 1 && canonical(own[0]) === canonical(want[0]) : own.length === 0
    if (!same) differ.push(event)
  }
  if (differ.length === 0 && !topLevel) return { state: 'current' }
  const copy = places.some(p => !/\s--client\s+\S+\s*$/.test(p.command)) || places.some(p => p.event === 'PostToolUseFailure' || p.event === 'PostToolBatch')
  return copy ? { state: 'claude-copy', events: differ } : { state: 'drifted', events: differ }
}

// ── Install, a tools-only install and uninstall (D406, D361) ──────────

/** The other Codex hooks files install's record says it wired and has not
 *  taken back (another CODEX_HOME's), never touched from here. */
export function otherWiredCodexFiles(file: string = codexHooksPath()): string[] {
  return (readInstallState().codexWired ?? []).filter((f) => f !== file)
}

/** The line naming them, or null. */
export function otherWiredCodexLine(file: string = codexHooksPath()): string | null {
  const others = otherWiredCodexFiles(file)
  if (others.length === 0) return null
  return `also wired under ${others.map((f) => dirname(f)).join(' and ')}; run uninstall with CODEX_HOME set to ${others.length === 1 ? 'it' : 'each'} to take ${others.length === 1 ? 'that one' : 'those'} back (nothing there is touched from here)`
}

/** The commands install's record says it wrote into Codex's hooks file:
 *  each exactly as written. A command install wrote is install's whatever
 *  file now holds it, so a hooks file that moved with the developer's home
 *  (its record naming the old path) is still read by the record. */
export function recordedCodexCommands(_file: string = codexHooksPath()): Set<string> {
  const r = readInstallState().codexHooks
  return new Set(r ? r.commands : [])
}

function recordCodexHooks(file: string, commands: string[]): void {
  updateInstallState((state) => {
    const wired = new Set(state.codexWired ?? [])
    const wiredBefore = wired.size
    if (commands.length === 0) wired.delete(file); else wired.add(file)
    const wiredChanged = wired.size !== wiredBefore || (commands.length > 0 && !(state.codexWired ?? []).includes(file))
    if (wiredChanged) { if (wired.size > 0) state.codexWired = [...wired].sort(); else delete state.codexWired }
    if (commands.length === 0) {
      if (!state.codexHooks || state.codexHooks.file !== file) return wiredChanged ? state : false
      delete state.codexHooks
      return state
    }
    const same = state.codexHooks?.file === file && JSON.stringify(state.codexHooks.commands) === JSON.stringify(commands)
    if (same) return wiredChanged ? state : false
    state.codexHooks = { file, commands, at: new Date().toISOString() }
    return state
  })
}

/**
 * What one Codex hooks step did: its file action and the lines install
 * says. `present` is whether treecontext's hooks are in Codex's hooks file
 * once the step is done (planned, in a dry run): the one fact the Codex
 * entry's capture mode is read from (codexHooksPresent), since hooks that
 * are written can run, and what they stage is drained only by a server in
 * capture mode.
 */
export interface CodexHooksOutcome {
  action: ActionResult | null; lines: string[]; wrote: boolean; refused?: string; present: boolean
  /** A take-back over a file that does not parse, or that install cannot
   *  read its hooks in, whose text still names treecontext's commands:
   *  hooks that run again once the developer repairs the file. */
  leftInText?: boolean
}

/**
 * Whether treecontext's hooks are in Codex's hooks file (D386, D406): the
 * one reading the Codex entry's capture mode follows, at install, at
 * uninstall and at doctor. Any hook of treecontext's in a file install can
 * read, this build's block or an earlier build's. A file that does not
 * parse, or JSON install cannot place its groups in, holds none that run:
 * Codex runs none of a file it cannot load (a file it does load in a shape
 * install cannot place in holds no hook of treecontext's it lists), so the
 * entry stays tools-only there, as D406 has it, and install is the step
 * after the developer's fix (codexHooksNamedInText says what is left).
 */
export function codexHooksPresent(file: string = codexHooksPath()): boolean {
  const read = readCodexHooksFile(file)
  if (read.state !== 'ok') return false
  return codexBlockState(read.data, codexHooksBlock(), recordedCodexCommands(file)).state !== 'none'
}

/** Whether the text of a hooks file install cannot read its hooks in names
 *  a command of treecontext's: what is left there, said, never acted on. */
export function codexHooksNamedInText(file: string = codexHooksPath()): boolean {
  const recorded = recordedCodexCommands(file)
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return recorded.size > 0 }
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    let s: unknown
    try { s = JSON.parse(m[0]) } catch { continue }
    if (isTreecontextCodexHook(s, recorded)) return true
  }
  return false
}

function placeWords(p: Pick<HookPlace, 'event' | 'group' | 'index'>): string {
  return `${p.event} group ${p.group} hook ${p.index}`
}

/** The lines naming the developer's hooks a change moved (D406). */
function movedLines(moved: CodexHooksChange['moved'], by: string): string[] {
  return moved.map(m => `  hooks: ${by} moved your hook ${describePlace(m.from)} to ${placeWords(m.to)}: Codex will ask you to trust it again with /hooks`)
}

/** Where install writes Codex's hooks file: the path itself, or, for a
 *  symlink, the file the link resolves to (created there when absent and
 *  its directory exists), the link kept a link; or why it may not. */
export type CodexHooksTarget =
  | { ok: true; target: string; link: boolean; exists: boolean }
  | { ok: false; why: string }

/**
 * Resolve Codex's hooks path as install writes it (lstat and readlink, hop
 * by hop, so a dangling link is never taken for an absent file): a regular
 * file, or nothing, at the path; or a symlink chain that ends at a regular
 * file, or at nothing in a directory that exists. Anything else (a link
 * whose directory does not exist, a directory, a chain with no end) is a
 * refusal: install writes nothing there and changes nothing.
 */
export function codexHooksTarget(file: string = codexHooksPath()): CodexHooksTarget {
  return writeTarget(file)
}

/** codexHooksTarget for any file install writes for Codex (its config.toml too). */
export function writeTarget(file: string): CodexHooksTarget {
  let path = file
  let link = false
  for (let hop = 0; hop <= 40; hop++) {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown'
      if (code !== 'ENOENT') return { ok: false, why: `${path} cannot be read (${code})` }
      if (!link) return { ok: true, target: path, link: false, exists: false }
      let dir: string
      try { dir = realpathSync(dirname(path)) } catch {
        return { ok: false, why: `${file} is a symlink to ${path}, whose directory does not exist, so install has no place to write through it` }
      }
      if (!statSync(dir).isDirectory()) return { ok: false, why: `${file} is a symlink to ${path}, whose directory is not a directory` }
      return { ok: true, target: join(dir, basename(path)), link: true, exists: false }
    }
    if (st.isSymbolicLink()) {
      link = true
      const dest = readlinkSync(path)
      path = isAbsolute(dest) ? dest : join(dirname(path), dest)
      continue
    }
    if (!st.isFile()) return { ok: false, why: `${path} is ${st.isDirectory() ? 'a directory' : 'not a regular file'}, so install has no file to write there` }
    return { ok: true, target: link ? realpathSync(path) : path, link, exists: true }
  }
  return { ok: false, why: `${file} is a chain of symlinks with no end` }
}

/**
 * Why install may not write Codex's hooks file, or null (D53: an
 * unwritable agent config fails loudly and changes nothing): a path it
 * cannot resolve to a writable place (codexHooksTarget), a file the
 * developer made read-only, or a directory that refuses the write. A
 * symlink is judged by the file it resolves to and that file's directory,
 * where the write lands.
 */
export function codexHooksUnwritable(file: string = codexHooksPath()): string | null {
  return unwritableFile(file)
}

/** codexHooksUnwritable for any file install writes for Codex (its config.toml too). */
export function unwritableFile(file: string): string | null {
  const place = writeTarget(file)
  if (!place.ok) return place.why
  const target = place.target
  try {
    if (place.exists) {
      const mode = statSync(target).mode
      if ((mode & 0o200) === 0) return `${target} is read-only (mode ${(mode & 0o777).toString(8)})`
      accessSync(target, constants.W_OK)
    }
    let dir = dirname(target)
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
    accessSync(dir, constants.W_OK)
    return null
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'EACCES'
    return `${target} cannot be written (${code})`
  }
}

/** Write the hooks file's text where codexHooksTarget resolved it: the
 *  atomic rename beside the target, so a link stays a link; its mode kept.
 *  The caller has refused an unwritable file first. */
function writeHooksText(place: Extract<CodexHooksTarget, { ok: true }>, text: string): void {
  const target = place.target
  mkdirSync(dirname(target), { recursive: true })
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
  writeAtomic(target, text, mode)
  // The umask narrows a new file's mode: the file keeps the one it had.
  if (process.platform !== 'win32') chmodSync(target, mode)
}

/** Where install may insert into Codex's hooks file: new top-level keys,
 *  new events in `hooks`, and new groups in an event's array. */
const CODEX_APPEND_AT = (path: Array<string | number>): boolean => path.length === 0 || (path[0] === 'hooks' && path.length <= 2)

/**
 * The hooks file's new text for `data`, made by text edits (json-text-edit.ts)
 * so that every byte of the developer's parts stays as written: a number,
 * an escape, spacing and key order, and so the text each of the developer's
 * hooks has, which Codex's trust hash is taken over. A file with no text of
 * the developer's (absent, or blank) is written whole. Null where the
 * change cannot be made by edits alone; the caller then changes nothing.
 */
export function codexHooksTextFor(read: CodexHooksFile, data: Record<string, unknown>, recorded: ReadonlySet<string> = recordedCodexCommands()): string | null {
  if (read.state !== 'ok' || read.text.trim() === '') return JSON.stringify(data, null, 2) + '\n'
  return editJsonText(read.text, data, {
    appendAt: CODEX_APPEND_AT,
    owns: ownsBlockValue,
    ownString: (s) => isTreecontextCodexHook(s, recorded),
    ownPart: (v) => codexOwnPart(v, recorded),
  })
}

/** A hook of treecontext's (its command treecontext's), or a group whose
 *  every hook is: what a change may take out entire, an earlier build's
 *  matcher with it. */
export function codexOwnPart(v: unknown, recorded: ReadonlySet<string>): boolean {
  if (!isObject(v)) return false
  if (isTreecontextCodexHook(v['command'], recorded)) return true
  const hooks = v['hooks']
  return Array.isArray(hooks) && hooks.length > 0 && hooks.every((h) => isObject(h) && isTreecontextCodexHook(h['command'], recorded))
}

/**
 * Whether a value is one this build's block supplies whole, and so one the
 * editor may write as new text: a group of the block, an event's array of
 * the block's groups, or an object of such events (a `hooks` install adds).
 * Anything else, a developer's value above all, is never rendered.
 */
export function ownsBlockValue(v: unknown): boolean {
  const groups = new Set(Object.values(codexHooksBlock()).flatMap((g) => g.map((x) => canonical(x))))
  const isGroup = (x: unknown): boolean => groups.has(canonical(x))
  const isEventArray = (x: unknown): boolean => Array.isArray(x) && x.length > 0 && x.every(isGroup)
  if (isGroup(v)) return true
  if (isEventArray(v)) return true
  return isObject(v) && Object.keys(v).length > 0 && Object.values(v).every(isEventArray)
}

/** The line for a change install cannot make without rewriting the developer's text. */
export function codexNoEditLine(file: string): string {
  return `Codex CLI stays tools-only: install cannot make its change to ${file} without rewriting text of yours, so install leaves it byte for byte; run treecontext doctor, and report the file's shape if Codex loads it`
}

/** The line for a hooks file that does not parse, quoting the error (D406). */
export function codexHooksUnparsedLine(file: string, error: string): string {
  return `Codex CLI stays tools-only: its hooks file ${file} does not parse (${error}), so install leaves it byte for byte; fix it by hand, then run treecontext install --agent codex`
}

/** The line for a hooks file Codex itself does not load, in Codex's own words. */
export function codexRejectsLine(file: string, said: string): string {
  return `Codex CLI stays tools-only: Codex does not load its hooks file ${file} (Codex says: ${said}), so install leaves it byte for byte; fix it by hand, then run treecontext install --agent codex`
}

/** The line for JSON install cannot add its groups to without changing a part that is not its own. */
export function codexHooksUnplaceableLine(file: string, error: string, verdict: CodexFileVerdict): string {
  const codex = verdict.state === 'loads' ? 'Codex loads it as it is, but ' : ''
  return `Codex CLI stays tools-only: in its hooks file ${file}, ${codex}${error}; install leaves it byte for byte. Make it an object with "hooks" an object of events, then run treecontext install --agent codex`
}

/** How long install waits for each of its two `hooks/list` reads: so an
 *  install never waits more than twice this on a Codex that does not answer. */
export const CODEX_INSTALL_PROBE_TIMEOUT_MS = 10_000

/** How long a read of Codex may take before install says what it waits for. */
export const CODEX_WAIT_NOTICE_MS = 1_000

/** What install asks the Codex on PATH, injectable for its tests. */
export interface CodexInstallProbe {
  /** Codex's `hooks/list` for a directory (readCodexHooksTrust). */
  ask: (cwd: string) => Promise<CodexHooksTrust>
  /** Codex's effective configuration for a directory (readCodexConfig),
   *  read only when Codex lists fewer than all of treecontext's hooks, to
   *  name the setting that keeps them off. */
  config?: (cwd: string) => Promise<CodexConfigRead>
  /** Said once, when a read of Codex takes longer than CODEX_WAIT_NOTICE_MS. */
  onWait?: (line: string) => void
  /** Run once the file is found fit to write, before any write: the hook
   *  scripts the block runs, so it never names one install did not write. */
  beforeWrite?: () => void
}

/**
 * An empty directory Codex holds no project settings or trust for, so that
 * what Codex says of the user's hooks file is said for every project alike
 * (a trusted project's `.codex/config.toml` can turn hooks off there, and a
 * project's own `.codex/hooks.json` adds hooks there), and so Codex's app
 * server is never started in the developer's project. Removed after.
 */
function neutralDirectory(): { dir: string; remove: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'treecontext-codex-')))
  return { dir, remove: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* left in the temp directory */ } } }
}

/** What turns treecontext's hooks on where Codex lists fewer than all of them. */
async function whatTurnsThemOn(probe: CodexInstallProbe, cwd: string, said: string[]): Promise<string> {
  const codex = said.length > 0 ? `Codex says: ${said.join('; ')}. ` : ''
  const read = probe.config ? await probe.config(cwd) : null
  const features = read?.ok ? read.config['features'] : undefined
  if (read?.ok && features && typeof features === 'object' && (features as Record<string, unknown>)['hooks'] === false) {
    const where = codexOriginFile(read.origins, 'features.hooks', join(codexDir(), 'config.toml'))
    return `${codex}Codex's own configuration turns its hooks off: [features] hooks = false, in ${where}; set it to true, or take the line out, to turn them on`
  }
  return `${codex}${said.length > 0 ? '' : 'Codex says nothing of why. '}A managed policy, or a setting Codex did not name, can keep it from loading them; treecontext doctor reads what Codex reports for each hook`
}

/**
 * Install's Codex hooks at the floor or later (D406). Whether Codex loads
 * the file is Codex's own verdict wherever Codex can be asked (its app
 * server's `hooks/list`, codexVerdictOf), asked from an empty directory
 * (neutralDirectory) so that no project's settings decide it for every
 * project, before install writes and again after:
 *  - a file Codex does not load is left byte for byte, Codex's words
 *    quoted;
 *  - install's own needs are narrower (codexPlacementError): JSON it cannot
 *    add its groups to without changing a part that is not its own is left
 *    byte for byte, whatever Codex says of it;
 *  - after the write, a file Codex no longer loads is put back byte for
 *    byte (or the file install created removed): a file Codex rejects runs
 *    none of the developer's hooks either, so the developer's working file
 *    is worth more than a block Codex will not read. A put-back that fails
 *    is said plainly, with where the original text was saved, and is a
 *    refusal;
 *  - a file Codex loads without listing all of treecontext's hooks (hooks
 *    turned off, a managed policy) keeps the block, said with Codex's words
 *    and what turns them on: hooks that are written can run once that
 *    changes, so the entry drains what they stage, and install never says
 *    capture is running;
 *  - where Codex cannot answer (no app server, an error, the bound), the
 *    file is written under install's own check and said "written, Codex's
 *    reading unknown"; doctor is the check. Each read is bounded
 *    (CODEX_INSTALL_PROBE_TIMEOUT_MS), and one that takes longer than
 *    CODEX_WAIT_NOTICE_MS says what install waits for. A dry run starts no
 *    app server.
 * `present` (codexHooksPresent, read back from the file) is whether the
 * entry starts the server in capture mode.
 */
export async function installCodexHooks(dryRun: boolean, probe: CodexInstallProbe): Promise<CodexHooksOutcome> {
  const file = codexHooksPath()
  const none = (lines: string[], refused?: string): CodexHooksOutcome => ({ action: null, wrote: false, present: codexHooksPresent(file), lines, ...(refused ? { refused } : {}) })
  const place = codexHooksTarget(file)
  if (!place.ok) return none([`  hooks: none written — Codex CLI stays tools-only: ${place.why}; install changes nothing there`], place.why)
  const block = codexHooksBlock()
  const ours = blockHookKeys(block)
  const read = readCodexHooksFile(file)
  const neutral = dryRun ? null : neutralDirectory()
  try {
    let waitSaid = false
    const bounded = async <T>(what: () => Promise<T>): Promise<T> => {
      const t = setTimeout(() => {
        if (waitSaid) return
        waitSaid = true
        probe.onWait?.(`  hooks: waiting for Codex's own reading of its hooks file (codex app-server, hooks/list), at most ${Math.round(CODEX_INSTALL_PROBE_TIMEOUT_MS / 1000)} s for each read…`)
      }, CODEX_WAIT_NOTICE_MS)
      try { return await what() } finally { clearTimeout(t) }
    }
    const verdict = async (): Promise<CodexFileVerdict> => neutral === null
      ? { state: 'unknown', why: 'a dry run does not start Codex\'s app server' }
      : codexVerdictOf(await bounded(() => probe.ask(neutral.dir)), file, ours)
    const before = await verdict()
    if (before.state === 'rejects') return none([`  hooks: none written — ${codexRejectsLine(file, before.said)}`])
    if (read.state === 'unparsed') return none([`  hooks: none written — ${codexHooksUnparsedLine(file, read.error)}`])
    if (read.state === 'unplaceable') return none([`  hooks: none written — ${codexHooksUnplaceableLine(file, read.error, before)}`])
    const refused = codexHooksUnwritable(file)
    if (refused) return none([`  hooks: none written — Codex CLI stays tools-only: ${refused}; install changes nothing in it`], refused)
    const recorded = recordedCodexCommands(file)
    const change = convergeCodexHooks(read.state === 'ok' ? read.data : {}, block, recorded)
    const nextText = change.changed ? codexHooksTextFor(read, change.data) : null
    if (change.changed && nextText === null) return none([`  hooks: none written — ${codexNoEditLine(file)}`])
    probe.beforeWrite?.()
    const lines: string[] = []
    let action: ActionResult
    const created = read.state === 'absent'
    if (!change.changed && read.state === 'ok') {
      action = { type: 'hook-settings', path: file, status: 'skipped', detail: 'already configured' }
    } else {
      if (!dryRun) {
        writeHooksText(place, nextText!)
        if (created && !place.link) recordCreatedFile(file)
      }
      action = { type: 'hook-settings', path: file, status: dryRun ? 'dry-run' : created ? 'created' : 'updated' }
    }
    const wrote = change.changed && !dryRun
    const after = wrote ? await verdict() : before
    if (after.state === 'rejects') return putBack(file, place, read, created, after.said)
    // Codex answered before the write and cannot answer for what install
    // wrote (an error from its hook discovery): that is Codex refusing the
    // file, never a reading it could not have.
    if (wrote && after.state === 'unknown' && before.state !== 'unknown') return putBack(file, place, read, created, after.why)
    if (!dryRun) recordCodexHooks(file, Object.values(block).flatMap(g => g.flatMap(m => m.hooks.map(h => h.command))))
    lines.push(`  hooks: ${file}${place.link ? ` (a symlink to ${place.target}, written there, the link kept)` : ''} [${action.status}${action.detail ? ` — ${action.detail}` : ''}]`)
    for (const e of CODEX_HOOK_EVENTS) lines.push(`  hooks: ${e.event} (${e.purpose})`)
    if (dryRun) {
      lines.push('  hooks: would be written; a dry run does not start Codex\'s app server, so Codex is not asked whether it loads them')
    } else if (after.state === 'unknown') {
      lines.push(`  hooks: written, Codex's reading unknown: Codex's own account of its hooks could not be read (${after.why}); treecontext doctor is the check`)
    } else if (after.ours === ours.size) {
      lines.push(`  hooks: Codex lists all ${ours.size} of treecontext's hooks from ${file}`)
    } else {
      const why = await bounded(() => whatTurnsThemOn(probe, neutral!.dir, after.said))
      lines.push(`  hooks: written, but Codex runs ${after.ours === 0 ? 'none' : `only ${after.ours}`} of treecontext's ${ours.size} hooks now: it lists ${after.ours === 0 ? 'none of them' : `only ${after.ours} of them`} from ${file}. ${why}. `
        + 'The hooks stay in the file, and Codex CLI\'s entry starts the server in capture mode so that it drains what they stage once Codex runs them; nothing of a Codex session is captured until then')
    }
    if (change.changed) {
      lines.push(...movedLines(change.moved, 'writing treecontext\'s hooks'))
      if (change.written.length > 0 && change.removed.length > 0) {
        lines.push(`  hooks: Codex will ask you to trust these hooks of treecontext's again, their text or place changed: ${change.written.map(placeWords).join(', ')}`)
      }
      lines.push(`  hooks: ${CODEX_TRUST_LINE}`)
    }
    return { action, wrote: change.changed, present: dryRun ? true : codexHooksPresent(file), lines }
  } finally {
    neutral?.remove()
  }
}

/** Where install saves the original text of a hooks file it could not put back. */
export function codexHooksOriginalPaths(target: string): string[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return [`${target}.treecontext-original-${stamp}`, join(homedir(), '.treecontext', `codex-hooks.json.original-${stamp}`)]
}

/**
 * Codex no longer loads the file as install wrote it: put it back byte for
 * byte (or remove the file install created). Where that fails, the file
 * stays as install wrote it, which Codex rejects, so the developer's own
 * hooks in it no longer load: said plainly, with the original text saved
 * beside the file (or under ~/.treecontext) and the command that restores
 * it, and a refusal, so the run fails. `present` is read back from the file
 * either way.
 */
function putBack(file: string, place: Extract<CodexHooksTarget, { ok: true }>, read: CodexHooksFile, created: boolean, said: string): CodexHooksOutcome {
  const why = `Codex does not load ${file} as install wrote it (Codex says: ${said})`
  let failure: string | null = null
  if (created) {
    try {
      if (lstatSync(place.target).isFile()) rmSync(place.target, { force: true })
      forgetCreatedFile(file)
    } catch (e) { failure = e instanceof Error ? e.message : String(e) }
  } else if (read.state === 'ok') {
    try { writeHooksText(place, read.text) } catch (e) { failure = e instanceof Error ? e.message : String(e) }
  }
  if (failure === null) {
    return { action: null, wrote: false, present: codexHooksPresent(file), refused: why, lines: [`  hooks: none kept — ${why}, so install put the file back byte for byte; Codex CLI stays tools-only`] }
  }
  const lines = [`  hooks: ${why}, and install could not put the file back (${failure})`]
  if (created) {
    lines.push(`  hooks: the file did not exist before install created it; remove it by hand (rm ${place.target}) so that Codex loads no hooks file again`)
  } else if (read.state === 'ok') {
    let saved: string | null = null
    const tried: string[] = []
    for (const p of codexHooksOriginalPaths(place.target)) {
      try {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, read.text, { mode: 0o600, flag: 'wx' })
        saved = p
        break
      } catch (e) { tried.push(`${p}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    lines.push(saved
      ? `  hooks: the file's original text is saved at ${saved}; restore it by hand: cp ${saved} ${place.target}`
      : `  hooks: the file's original text could not be saved either (${tried.join('; ')}); restore it from your own copy`)
  }
  lines.push(`  hooks: as it stands, Codex rejects ${place.target}, so none of its hooks load, yours included, until it is restored`)
  return {
    action: { type: 'hook-settings', path: file, status: 'error', detail: `${why}; not put back: ${failure}` },
    wrote: true, present: codexHooksPresent(file), lines,
    refused: `${why}, and install could not put the file back (${failure}); see the lines above to restore it by hand`,
  }
}

/**
 * Take back what install wrote for Codex (D406): the hooks its record
 * names or, where none does, the hooks an earlier build wrote, known by
 * their commands (the verbatim copy of the Claude Code block under the
 * experimental flag among them); never a hook of the developer's. A
 * symlink is written through, never deleted or replaced: the file is
 * deleted only where it is a regular file install's record says install
 * created and nothing else is left in it. A file that does not parse, or
 * that install cannot read its hooks in, is left as it is. A file that
 * cannot be written is a refusal: treecontext's hooks remain and still run.
 */
export async function takeBackCodexHooksFile(dryRun: boolean, probe?: Pick<CodexInstallProbe, 'ask' | 'onWait'>): Promise<CodexHooksOutcome> {
  const file = codexHooksPath()
  const place = codexHooksTarget(file)
  const read = readCodexHooksFile(file)
  if (read.state === 'absent') {
    if (!dryRun) recordCodexHooks(file, [])
    return { action: null, wrote: false, present: false, lines: [] }
  }
  // A file install cannot read its hooks in keeps whatever of treecontext's
  // is in it: Codex runs none of them while it cannot load the file, so the
  // entry follows D406 (tools-only); what is left is said, never acted on.
  const kept = (): string => codexHooksNamedInText(file) ? '; treecontext\'s hooks in it stay, and run again once the file loads: after fixing it, run treecontext install --agent codex (or uninstall again)' : ''
  if (read.state === 'unparsed') {
    return { action: null, wrote: false, present: codexHooksPresent(file), leftInText: codexHooksNamedInText(file), lines: [`  hooks: ${file} does not parse (${read.error}): left as it is, treecontext's hooks in it not taken back${kept()}; fix it by hand`] }
  }
  if (read.state === 'unplaceable') {
    return { action: null, wrote: false, present: codexHooksPresent(file), leftInText: codexHooksNamedInText(file), lines: [`  hooks: ${file}: ${read.error.replace(/, so install .*$/, '')}, so install cannot read treecontext's hooks in it: left as it is${kept()}; fix it by hand`] }
  }
  const recorded = recordedCodexCommands(file)
  const change = takeBackCodexHooks(read.data, recorded)
  if (!change.changed) {
    if (!dryRun) recordCodexHooks(file, [])
    return { action: null, wrote: false, present: false, lines: [] }
  }
  const refused = codexHooksUnwritable(file)
  if (refused || !place.ok) {
    const why = refused ?? (place.ok ? '' : place.why)
    return {
      action: null, wrote: false, present: true, refused: `treecontext's hooks remain in ${file} and still run once trusted: ${why}`,
      lines: [`  hooks: treecontext's hooks remain in ${file}, and Codex still runs them once trusted — ${why}; nothing in it was changed`],
    }
  }
  const empty = Object.keys(change.data).length === 0
  const nextText = codexHooksTextFor(read, change.data)
  if (nextText === null) {
    return { action: null, wrote: false, present: codexHooksPresent(file), lines: [`  hooks: ${file}: install cannot take treecontext's hooks out without rewriting text of yours, so it is left as it is; take them out by hand`] }
  }
  // Codex's own reading of the file before and after the take-back, where
  // Codex can answer: a take-back that leaves Codex unable to load a file it
  // loaded is put back byte for byte and said (as install's own write is).
  const neutral = probe && !dryRun ? neutralDirectory() : null
  try {
    const ours = blockHookKeys(codexHooksBlock())
    const verdict = async (): Promise<CodexFileVerdict> => neutral === null || !probe
      ? { state: 'unknown', why: 'not asked' }
      : codexVerdictOf(await probe.ask(neutral.dir), file, ours)
    const before = await verdict()
    let detail = `removed ${change.removed.length} hook${change.removed.length === 1 ? '' : 's'} of treecontext's`
    if (!dryRun) {
      if (empty && !place.link && installCreated(file) && lstatSync(file).isFile()) {
        rmSync(file, { force: true })
        detail += '; the file install created is gone, nothing else being in it'
      } else {
        writeHooksText(place, nextText)
        if (place.link) detail += `; written in ${place.target}, the symlink kept`
      }
    }
    const after = dryRun ? before : await verdict()
    if (before.state === 'loads' && after.state !== 'loads') {
      const said = after.state === 'rejects' ? after.said : after.why
      writeHooksText(place, read.text)
      const why = `Codex does not load ${file} as the take-back left it (Codex says: ${said}), so it was put back byte for byte; treecontext's hooks remain in it and still run once trusted`
      return { action: null, wrote: false, present: codexHooksPresent(file), refused: why, lines: [`  hooks: ${why}`] }
    }
    if (!dryRun) {
      recordCodexHooks(file, [])
      if (!existsSync(file)) forgetCreatedFile(file)
    }
    const lines = [`  hooks: ${file} [${dryRun ? 'dry-run' : 'updated'} — ${detail}]`, ...movedLines(change.moved, 'taking treecontext\'s hooks out')]
    // No record named them: they were known by their commands alone, and a
    // hook of the developer's with the very same command is taken too.
    if (recorded.size === 0 && change.removed.length > 0) {
      lines.push(`  hooks: the ${change.removed.length} hook(s) taken out were known by their commands as treecontext's, no install record naming them (an earlier build's): a hook of yours with the very same command would be taken too`)
    }
    return { action: { type: 'hook-settings', path: file, status: dryRun ? 'dry-run' : 'updated', detail }, wrote: true, present: dryRun ? false : codexHooksPresent(file), lines }
  } finally {
    neutral?.remove()
  }
}

// ── Doctor's row for Codex CLI (D407) ─────────────────────────────────

export { CODEX_HOOK_MODE }

const INSTALL_CODEX = 'treecontext install --agent codex'
const TRUST_REMEDY = 'trusting them with /hooks in Codex'

/** What doctor's row learns of the Codex on PATH, injectable for its own tests. */
export interface CodexDoctorProbe {
  version: () => Promise<string | null>
  trust: (cwd: string) => Promise<CodexHooksTrust>
  /** Codex's effective configuration for the project (readCodexConfig),
   *  read only when Codex lists fewer than all of treecontext's hooks. */
  config?: (cwd: string) => Promise<CodexConfigRead>
}

/** A hook of treecontext's as Codex reports it, named for the developer. */
function trustName(h: CodexListedHook): string {
  return `${h.eventName} (${h.key})`
}

/**
 * Doctor's clause for Codex CLI (D407): from Codex's own account of each
 * hook's trust whether Codex runs treecontext's hooks; whether the hooks
 * are this build's block; tools-only below the floor; a hooks file that
 * does not parse quoted. Doctor reports on the project it runs from, so it
 * asks Codex from that directory (`cwd`): a trusted project's own
 * `.codex/config.toml` can turn hooks off there, and its own
 * `.codex/hooks.json` is Codex's too; only what Codex says of the user's
 * file (codexVerdictOf) is read as treecontext's. Doctor writes nothing into
 * Codex's configuration, never marks a hook trusted and never computes
 * Codex's hash.
 */
export async function codexHookReport(cwd: string, probe: CodexDoctorProbe): Promise<ClientHookReport> {
  const mode = CODEX_HOOK_MODE
  const home = codexHome()
  if (!home.ok) {
    return {
      mode, state: home.why, remedy: 'pointing CODEX_HOME at a directory that exists, or unsetting it', warn: true,
      fix: 'point CODEX_HOME at a directory that exists, or unset it, then run treecontext install --agent codex', hooksPresent: false,
    }
  }
  const named = codexHomeNote()
  const others = otherWiredCodexLine()
  const report = await codexHookReportIn(cwd, probe)
  const state = `${named ? `${named}; ` : ''}${report.state}${others ? `; treecontext's hooks are ${others}` : ''}`
  return { ...report, state }
}

async function codexHookReportIn(cwd: string, probe: CodexDoctorProbe): Promise<ClientHookReport> {
  const mode = CODEX_HOOK_MODE
  const file = codexHooksPath()
  const capture = codexCaptureOf(await probe.version())
  const read = readCodexHooksFile(file)
  if (read.state === 'unparsed') {
    return {
      mode, state: `Codex's hooks file ${file} does not parse (${read.error}), so nothing in it is read, treecontext's hooks or the developer's${codexHooksNamedInText(file) ? '; treecontext\'s hooks are still written in it and run again once it parses' : ''}`,
      remedy: `fixing ${file} by hand, never an install`, warn: true, fix: `fix ${file} by hand so it parses`, hooksPresent: false,
    }
  }
  if (read.state === 'unplaceable') {
    return {
      mode, state: `in Codex's hooks file ${file}, ${read.error.replace(/, so install .*$/, '')}, so install cannot read or write treecontext's hooks in it`,
      remedy: `fixing ${file} by hand, never an install`, warn: true, fix: `make ${file} an object with "hooks" an object of events`, hooksPresent: false,
    }
  }
  const recorded = recordedCodexCommands(file)
  const block = codexHooksBlock()
  const state = read.state === 'ok' ? codexBlockState(read.data, block, recorded) : { state: 'none' as const }
  if (capture.state !== 'capture') {
    const why = capture.state === 'below' ? `its version reads ${capture.version}` : 'its version could not be read (codex --version)'
    if (state.state !== 'none') {
      return {
        mode, state: `treecontext's hooks are written in ${file} for a Codex that gets the tools only: ${why}, and capture needs Codex CLI ${CODEX_CAPTURE_FLOOR}`,
        remedy: `${INSTALL_CODEX}, which takes them back`, warn: true, fix: INSTALL_CODEX, hooksPresent: true,
      }
    }
    return {
      mode, state: `Codex gets the tools only: ${why}, and capture needs Codex CLI ${CODEX_CAPTURE_FLOOR}`,
      remedy: capture.state === 'below'
        ? `upgrading Codex CLI to ${CODEX_CAPTURE_FLOOR} or later, then ${INSTALL_CODEX}`
        : `making codex --version answer, then ${INSTALL_CODEX}`,
      warn: false, hooksPresent: false,
    }
  }
  if (state.state === 'none') {
    return {
      mode, state: `no treecontext hook is written in ${file}, so nothing of a Codex session is captured`,
      remedy: INSTALL_CODEX, warn: true, fix: INSTALL_CODEX, hooksPresent: false,
    }
  }
  if (state.state === 'claude-copy') {
    return {
      mode, state: `the hooks in ${file} are an earlier build's copy of Claude Code's block, not Codex's own: present and inconsistent with Codex's block (differs on ${state.events.join(', ')})`,
      remedy: `${INSTALL_CODEX}, which rewrites them`, warn: true, fix: INSTALL_CODEX, hooksPresent: true,
    }
  }
  if (state.state === 'drifted') {
    return {
      mode, state: `treecontext's hooks in ${file}: present and inconsistent with Codex's block (differs on ${state.events.join(', ')})`,
      remedy: `${INSTALL_CODEX}, which rewrites them`, warn: true, fix: INSTALL_CODEX, hooksPresent: true,
    }
  }
  const present = `treecontext's hooks in ${file}: present and consistent with Codex's block`
  const trust = await probe.trust(cwd)
  if (!trust.ok) {
    return {
      mode, state: `${present}; doctor cannot tell whether Codex trusts them, since Codex's own account of its hooks could not be read (${trust.why})`,
      remedy: 'looking in /hooks in Codex', warn: true, fix: 'open /hooks in Codex and check that treecontext\'s hooks are trusted', hooksPresent: true,
    }
  }
  const keys = blockHookKeys(block)
  const verdict = codexVerdictOf(trust, file, keys)
  if (verdict.state !== 'loads') {
    return {
      mode, state: `${present}, but Codex does not load ${file} (Codex says: ${verdict.state === 'rejects' ? verdict.said : verdict.why}), so it runs none of its hooks, treecontext's or yours`,
      remedy: `fixing ${file} by hand, never /hooks`, warn: true, fix: `fix ${file} by hand so Codex loads it`, hooksPresent: true,
    }
  }
  // Only the hooks Codex lists from the user's file are treecontext's: a
  // project's own hooks file may hold the same commands (codexVerdictOf).
  const ours = trust.hooks.filter(h => h.sourcePath === file && keys.has(`${eventFold(h.eventName)}\n${h.command}`))
  const notRun = ours.filter(h => h.trustStatus !== 'trusted')
  const missing = keys.size - verdict.ours
  if (missing > 0) {
    // Codex does not load them at all: no trust can make them run, so the
    // remedy is the setting or the file, never /hooks. Codex's own words,
    // where it said any, and its own reading of [features] hooks for this
    // project, naming the file that sets it.
    const said = verdict.said.join('; ')
    const cfg = probe.config ? await probe.config(cwd) : null
    const features = cfg?.ok ? cfg.config['features'] : undefined
    const off = cfg?.ok && features && typeof features === 'object' && (features as Record<string, unknown>)['hooks'] === false
    const where = off ? codexOriginFile(cfg.origins, 'features.hooks', join(codexDir(), 'config.toml')) : null
    const project = off && cfg.origins['features.hooks']?.name?.type === 'project'
    const setting = where
      ? `; Codex's own configuration turns its hooks off ${project ? 'in this project' : 'for every project'}: [features] hooks = false, in ${where}`
      : ''
    return {
      mode, state: `${present}, but Codex lists ${verdict.ours === 0 ? 'none' : `only ${verdict.ours}`} of treecontext's ${keys.size} hooks${project ? ' for this project' : ''}, so it runs none it does not list${said ? `; Codex says: ${said}` : setting ? '' : '; Codex says nothing of why'}${setting}`,
      remedy: where
        ? `setting [features] hooks = true in ${where}, or taking that line out, never /hooks`
        : `finding why Codex does not load ${file} (its config.toml's [features] hooks, a managed policy, or the file itself), never /hooks`,
      warn: true, fix: where ? `set [features] hooks = true in ${where}` : `find why Codex does not load ${file}`, hooksPresent: true,
    }
  }
  if (notRun.length === 0) {
    return { mode, state: `${present}, and Codex runs treecontext's hooks: it reports every one of them trusted`, remedy: 'nothing to do', warn: false, hooksPresent: true }
  }
  const modified = notRun.filter(h => h.trustStatus === 'modified')
  const other = notRun.filter(h => h.trustStatus !== 'modified')
  const said: string[] = []
  if (modified.length > 0) said.push(`Codex reports ${modified.map(trustName).join(', ')} modified since ${modified.length === 1 ? 'it was' : 'they were'} trusted and does not run ${modified.length === 1 ? 'it' : 'them'}`)
  if (other.length > 0) said.push(`Codex reports ${other.map(h => `${trustName(h)} ${h.trustStatus}`).join(', ')}`)
  if (missing > 0) said.push(`${missing} of treecontext's hooks ${missing === 1 ? 'is' : 'are'} not in Codex's account at all`)
  const none = notRun.length === ours.length
  return {
    mode, state: `${present}, but Codex runs ${none ? 'none' : 'only some'} of treecontext's hooks: ${said.join('; ')}`,
    remedy: TRUST_REMEDY, warn: true, fix: 'open /hooks in Codex and trust treecontext\'s hooks', hooksPresent: true,
  }
}
