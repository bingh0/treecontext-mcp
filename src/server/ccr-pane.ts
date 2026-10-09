/**
 * The ccr join — the wiring a person should not have to type.
 *
 * treecontext writes pane blobs beside its store; ccr renders any file a
 * user lists in its own config. The seam is deliberate and stays that way:
 * ccr never learns treecontext exists, and nothing here reads or runs ccr
 * code. What changed is who does the typing. Every closed-beta report of
 * "the pane never showed up" traced to the hand-editing step, not to the
 * bytes on either side — a backslash path (invalid JSON), a PowerShell BOM
 * (invalid JSON), a bare-string entry (silently skipped), the wrong
 * directory, or a correctly wired pane nobody cycled to. ccr renders every
 * one of those as "no panes configured", by its own survive-a-typo ruling,
 * which makes each of them invisible.
 *
 * So treecontext offers to write that entry itself — the same thing it
 * already does for `~/.claude.json` and `~/.claude/settings.json`, and for
 * the same reason: a config a program merges is a config that parses.
 *
 * Two rules hold this to the seam rather than through it:
 *
 *  1. The config file is the USER'S. We merge into it — every other key,
 *     every other pane, preserved — and we never write one ccr did not
 *     already look for.
 *  2. ccr's resolution rules are mirrored here, not imported. If ccr's
 *     contract revs, this file is where the divergence shows up, and
 *     `tests/server/ccr-pane.test.ts` pins the shape ccr documents.
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { SIDECAR_FILES, type PaneName } from './sidecar-blob.js'

export type { PaneName }

/** Config is small; a sanity bound, matching ccr's own. */
const MAX_CONFIG_BYTES = 64 * 1024

/** The first ccr release carrying the pane subsystem. */
export const CCR_MIN_VERSION = '0.3.0'

/**
 * Where ccr looks for its config, without touching the filesystem.
 *
 * Mirrors ccr's `src/pane-config.js`: `CCR_CONFIG` wins, else
 * `$XDG_CONFIG_HOME/ccr/config.json`, else `~/.config/ccr/config.json` —
 * on EVERY platform. That last clause is the one people get wrong: on
 * Windows it means `%USERPROFILE%\.config`, never `%APPDATA%`, and on
 * macOS `~/.config`, never `~/Library/Application Support`.
 */
export function ccrConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.CCR_CONFIG
  if (explicit !== undefined && explicit !== '') return explicit
  const xdg = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : join(home, '.config')
  return join(xdg, 'ccr', 'config.json')
}

/** One pane entry as it sits in the user's file. */
export interface CcrPaneEntry {
  /** The string the user wrote — what ccr's error states quote. */
  raw: string
  /** Absolute, after ~ expansion and config-dir resolution. */
  resolved: string
  /** `bare-string` entries are the ones ccr skips without a word. */
  shape: 'object' | 'bare-string' | 'unusable'
}

export type CcrConfigState =
  | { kind: 'missing' }
  | { kind: 'empty' }
  /** Something is there, but it is not a file we can read or replace. */
  | { kind: 'not-a-file'; what: string }
  /** Bigger than the window ccr itself reads; we refuse to judge it. */
  | { kind: 'too-large'; bytes: number }
  /** Encodings a hand-written file arrives in that ccr's JSON.parse rejects. */
  | { kind: 'bom'; recovered: string }
  | { kind: 'utf16'; recovered: string }
  | { kind: 'unparseable'; error: string }
  | { kind: 'not-object' }
  | { kind: 'no-panes'; data: Record<string, unknown> }
  | { kind: 'ok'; data: Record<string, unknown>; entries: CcrPaneEntry[] }

/**
 * Expand a leading `~`, then resolve against the config file's own
 * directory — ccr's rule, and the reason a relative entry does NOT mean
 * "relative to my project". Note ccr expands `~/` and not `~\`, so a
 * Windows-style tilde path is left alone here too: reporting what ccr
 * will actually do beats reporting what the user meant.
 */
export function resolvePaneEntry(raw: string, configDir: string, home: string): string {
  let out = raw
  if (out === '~') out = home
  else if (out.startsWith('~/')) out = join(home, out.slice(2))
  return resolve(configDir, out)
}

/**
 * Read ccr's config the way ccr does, but keep every reason it might have
 * come back empty. ccr collapses all of these to "no panes configured"
 * because its panel must survive a typo; a doctor has the opposite duty.
 *
 * Total function: never throws, whatever is on disk.
 */
export function readCcrConfig(path: string, home: string = homedir()): CcrConfigState {
  let buf: Buffer
  try {
    if (!existsSync(path)) return { kind: 'missing' }
    // A directory (or a fifo, or a socket) where a file should be reads as
    // "missing" if you only catch the error — and then the write throws
    // EISDIR out of the command. Name it instead.
    const st = statSync(path)
    if (!st.isFile()) {
      return { kind: 'not-a-file', what: st.isDirectory() ? 'a directory' : 'not a regular file' }
    }
    // Truncating and then parsing would call a perfectly good large config
    // "invalid JSON" — and --force would move it aside on that verdict.
    // Past the cap we decline to judge rather than guess destructively.
    if (st.size > MAX_CONFIG_BYTES) return { kind: 'too-large', bytes: st.size }
    buf = readFileSync(path)
  } catch {
    return { kind: 'missing' }
  }

  // Encoding first — these two never reach JSON.parse intact, and both are
  // what a Windows shell produces by default (`>` writes UTF-16, and
  // `Set-Content -Encoding utf8` writes a BOM on PowerShell 5.1).
  const isUtf16 = buf.length >= 2
    && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  if (isUtf16) {
    const recovered = buf[0] === 0xff
      ? buf.subarray(2).toString('utf16le')
      : swap16(buf.subarray(2)).toString('utf16le')
    return { kind: 'utf16', recovered }
  }
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
  if (text.trim() === '') return { kind: 'empty' }
  if (hasBom) return { kind: 'bom', recovered: text }

  return classify(text, path, home)
}

/** Big-endian UTF-16 → little-endian, so one decoder handles both. */
function swap16(b: Buffer): Buffer {
  const out = Buffer.from(b)
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i] as number
    out[i] = out[i + 1] as number
    out[i + 1] = t
  }
  return out
}

function classify(text: string, path: string, home: string): CcrConfigState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { kind: 'unparseable', error: e instanceof Error ? e.message : String(e) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'not-object' }
  }
  const data = parsed as Record<string, unknown>
  if (!Array.isArray(data.panes)) return { kind: 'no-panes', data }

  const configDir = dirname(path)
  const entries: CcrPaneEntry[] = []
  for (const item of data.panes as unknown[]) {
    if (typeof item === 'string') {
      // ccr's whitelist-construct skips these. They look right to a human
      // and are invisible to the panel, so they are worth naming.
      entries.push({ raw: item, resolved: resolvePaneEntry(item, configDir, home), shape: 'bare-string' })
      continue
    }
    if (item !== null && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
      const raw = (item as { path: string }).path
      if (raw.trim() === '') {
        entries.push({ raw, resolved: '', shape: 'unusable' })
        continue
      }
      entries.push({ raw, resolved: resolvePaneEntry(raw, configDir, home), shape: 'object' })
      continue
    }
    entries.push({ raw: JSON.stringify(item) ?? String(item), resolved: '', shape: 'unusable' })
  }
  return { kind: 'ok', data, entries }
}

// ── Wiring ─────────────────────────────────────────────────────────

export interface WireOutcome {
  configPath: string
  /** Pane files newly listed by this run. */
  added: string[]
  /** Pane files that were already listed — the idempotent path. */
  alreadyPresent: string[]
  /** Bare-string entries rewritten into the shape ccr reads. */
  repairedEntries: number
  /** Set when the file's encoding was recovered rather than its content lost. */
  repairedEncoding: 'bom' | 'utf16' | null
  /** Set when an unparseable file was moved aside under --force. */
  backedUpTo: string | null
  /** The bytes that would be (or were) written; null when nothing changes. */
  content: string | null
  /** Panes ccr will read after this run, in cycle order. */
  panesAfter: string[]
  refusal: string | null
}

/**
 * Compute the merge. Pure with respect to the filesystem apart from the
 * read: the caller decides whether to write, so `--dry-run` and the real
 * run cannot disagree about what would happen.
 */
export function planWire(opts: {
  panePaths: string[]
  configPath: string
  home?: string
  force?: boolean
}): WireOutcome {
  const home = opts.home ?? homedir()
  const state = readCcrConfig(opts.configPath, home)
  const out: WireOutcome = {
    configPath: opts.configPath,
    added: [], alreadyPresent: [], repairedEntries: 0,
    repairedEncoding: null, backedUpTo: null, content: null,
    panesAfter: [], refusal: null,
  }

  let data: Record<string, unknown>
  let entries: CcrPaneEntry[] = []

  switch (state.kind) {
    case 'missing':
    case 'empty':
      data = {}
      break
    case 'bom':
    case 'utf16': {
      // The content is fine; only the encoding was fatal. Recover it and
      // rewrite as BOM-free UTF-8 rather than making the user retype it.
      const re = classify(state.recovered, opts.configPath, home)
      if (re.kind === 'ok') { data = re.data; entries = re.entries }
      else if (re.kind === 'no-panes') { data = re.data }
      else {
        const encoding = state.kind === 'bom' ? 'UTF-8 with a byte-order mark' : 'UTF-16'
        const why = re.kind === 'unparseable' ? `and is not valid JSON (${re.error})` : 'and does not hold a JSON object'
        out.refusal = `${opts.configPath} is ${encoding} ${why}. Fix or remove the file — treecontext will not guess what it meant.`
        return out
      }
      out.repairedEncoding = state.kind
      break
    }
    case 'not-a-file':
      // No --force for this one: whatever is there, replacing it is not a
      // config edit and we have no idea what we would be destroying.
      out.refusal = `${opts.configPath} is ${state.what} — ccr expects a JSON file there. Move it aside yourself, or point CCR_CONFIG somewhere else.`
      return out
    case 'too-large':
      out.refusal = `${opts.configPath} is ${Math.round(state.bytes / 1024)}KB, past the ${MAX_CONFIG_BYTES / 1024}KB window ccr itself reads — treecontext will not judge or rewrite a file that large. Trim it, or point CCR_CONFIG at a smaller one.`
      return out
    case 'unparseable':
      if (opts.force !== true) {
        out.refusal = `${opts.configPath} is not valid JSON (${state.error}) — ccr reads that as "no panes configured". Re-run with --force to move it aside and write a fresh one.`
        return out
      }
      data = {}
      out.backedUpTo = freeBackupPath(opts.configPath)
      break
    case 'not-object':
      if (opts.force !== true) {
        out.refusal = `${opts.configPath} holds JSON that is not an object, so ccr finds no panes in it. Re-run with --force to move it aside and write a fresh one.`
        return out
      }
      data = {}
      out.backedUpTo = freeBackupPath(opts.configPath)
      break
    case 'no-panes':
      data = state.data
      break
    case 'ok':
      data = state.data
      entries = state.entries
      break
  }

  // Rebuild the array, preserving order and every entry we did not author.
  // A bare string is kept — as the object shape ccr actually reads, which
  // is the difference between a pane and a skipped line.
  const panes: Record<string, unknown>[] = []
  const seen = new Set<string>()
  const originals = Array.isArray(data.panes) ? (data.panes as unknown[]) : []
  entries.forEach((entry, i) => {
    if (entry.shape === 'unusable') {
      // Not ours to delete. ccr skips these, but the operator wrote them,
      // and a merge that quietly drops what it does not understand is the
      // same silence this command exists to end.
      const original = originals[i]
      panes.push(
        original !== null && typeof original === 'object' && !Array.isArray(original)
          ? { ...(original as Record<string, unknown>) }
          : ({ path: '' } as Record<string, unknown>),
      )
      if (original === null || typeof original !== 'object' || Array.isArray(original)) {
        // A scalar or array entry cannot survive as an object; keep the
        // literal value so the file still round-trips what was there.
        panes[panes.length - 1] = original as unknown as Record<string, unknown>
      }
      return
    }
    if (entry.shape === 'bare-string') {
      out.repairedEntries += 1
      panes.push({ path: entry.raw })
    } else {
      const original = originals[i]
      panes.push(
        original !== null && typeof original === 'object'
          ? { ...(original as Record<string, unknown>) }
          : { path: entry.raw },
      )
    }
    seen.add(entry.resolved)
  })

  for (const pane of opts.panePaths) {
    // resolve(), never a bare isAbsolute() check: on Windows a rooted but
    // DRIVELESS path ("/x/sidecar.json") is "absolute" and stays driveless,
    // while every entry read from the config came through resolve() and is
    // drive-qualified. The two then never compare equal, and each run
    // appends the pane again — idempotence lost, on the one platform where
    // the difference exists. resolve() is a no-op for a fully-qualified path.
    const abs = resolve(pane)
    if (seen.has(abs)) { out.alreadyPresent.push(abs); continue }
    panes.push({ path: toJsonPath(abs) })
    seen.add(abs)
    out.added.push(abs)
  }

  out.panesAfter = panes
    .map((p) => (typeof p.path === 'string' ? p.path : ''))
    .filter((p) => p !== '')

  const nothingChanges = out.added.length === 0
    && out.repairedEntries === 0
    && out.repairedEncoding === null
    && out.backedUpTo === null
    && state.kind !== 'missing'
    && state.kind !== 'empty'
    && state.kind !== 'no-panes'
  if (nothingChanges) return out

  out.content = `${JSON.stringify({ ...data, panes }, null, 2)}\n`
  return out
}

/**
 * A backup name nothing occupies. `.bak` is the name people look for, so
 * it is tried first — but taking it when it already holds an EARLIER
 * backup would destroy the very thing a backup is for.
 */
function freeBackupPath(configPath: string): string {
  const first = `${configPath}.bak`
  if (!existsSync(first)) return first
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${configPath}.bak.${n}`
    if (!existsSync(candidate)) return candidate
  }
  return `${configPath}.bak.${process.pid}`
}

/**
 * Forward slashes on every platform. A Windows path written with
 * backslashes is invalid JSON (`\U` is an illegal escape) — the single
 * most mechanical way this wiring used to fail — and Node opens
 * forward-slash paths on Windows without complaint.
 */
export function toJsonPath(p: string): string {
  return p.split(sep).join('/')
}

/** The pane files for a store, in the order they should cycle. */
export function panePathsFor(storeDir: string, which: PaneName[] = ['journal']): string[] {
  return which.map((name) => join(storeDir, SIDECAR_FILES[name]))
}

// ── Seeing it ──────────────────────────────────────────────────────

export interface CycleHint {
  host: string
  move: string
}

/**
 * How this terminal cycles views — the step that no amount of correct
 * config can substitute for, and the one that has no key at all on
 * Windows Terminal (ccr's `launch-win.js` binds none, deliberately: a
 * binding there would mean editing the user's own settings.json).
 */
export function cycleHint(env: NodeJS.ProcessEnv = process.env): CycleHint {
  // This reports the terminal the COMMAND is running in, which is usually
  // but not always where the sidecar lives — so every arm ends with the
  // move that works from anywhere.
  const anywhere = '; from any shell in this project, `ccr cycle-view` also advances it'
  if (env.TMUX !== undefined && env.TMUX !== '') {
    return { host: 'this terminal is tmux', move: `press F3 in the sidecar pane${anywhere}` }
  }
  if (env.TERM_PROGRAM === 'vscode') {
    return {
      host: 'this terminal is VS Code',
      move: `click the sidecar pane, then press Space (or F3)${anywhere}`,
    }
  }
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== '') {
    return {
      host: 'this terminal is Windows Terminal',
      move: 'no key is bound there — run `ccr cycle-view` from another tab in this project',
    }
  }
  return {
    host: 'terminal not recognized',
    move: 'press F3 under tmux, Space in a VS Code split, or run `ccr cycle-view` from another shell',
  }
}

/**
 * Instance directories ccr keeps under `~/.ccr/instances/<n>`. Presence is
 * a soft signal and is reported as one: the directory outliving a crashed
 * sidecar is exactly the case where claiming "a sidecar is running" would
 * be a lie.
 */
export function ccrInstanceDirs(home: string = homedir()): string[] {
  const root = join(home, '.ccr', 'instances')
  try {
    return readdirSync(root)
      .filter((n) => /^\d+$/.test(n))
      .map((n) => join(root, n))
      .filter((d) => { try { return statSync(d).isDirectory() } catch { return false } })
  } catch {
    return []
  }
}

// ── Applying ───────────────────────────────────────────────────────

/**
 * Write the merge. Separate from `planWire` so `--dry-run` and the real
 * run cannot disagree about what happens, and so every filesystem effect
 * sits in one place: a same-directory temp file renamed over the target,
 * with the old file moved aside first when the plan says so.
 *
 * The bytes are BOM-free UTF-8 by construction — `writeFileSync` with a
 * string never adds one — which is the whole point on Windows.
 */
export function applyWire(outcome: WireOutcome): void {
  if (outcome.content === null) return

  // Write THROUGH a symlink, never over it. Config files under a dotfiles
  // repo are symlinks as a matter of course, and replacing the link with a
  // regular file breaks the link and wires a pane the operator's real
  // config never sees.
  let target = outcome.configPath
  try {
    if (lstatSync(target).isSymbolicLink()) target = realpathSync(target)
  } catch { /* not there yet — the plain path is the target */ }

  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  if (outcome.backedUpTo !== null) {
    // renameSync overwrites on POSIX and fails on Windows when the
    // destination exists: one silently destroys an earlier backup, the
    // other leaves the unreadable file in place and lets the write below
    // overwrite the very thing we promised to preserve. Both are answered
    // by moving to a name nothing occupies (planWire picked it).
    try { renameSync(target, outcome.backedUpTo) } catch { /* nothing to move */ }
  }

  const tmp = `${target}.tmp.${process.pid}`
  writeFileSync(tmp, outcome.content, { encoding: 'utf8', mode: 0o644 })
  try {
    // POSIX: atomic replace. The target is never absent for a window.
    renameSync(tmp, target)
  } catch {
    // Windows: rename onto an existing file fails, so remove and retry —
    // and if THAT fails, put the temp file back rather than leaving the
    // operator with neither file.
    try { unlinkSync(target) } catch { /* may not exist */ }
    try {
      renameSync(tmp, target)
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* best effort */ }
      throw e
    }
  }
}
