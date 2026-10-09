/**
 * Installer for treecontext MCP server.
 *
 * Detects installed coding agents, writes MCP configs, installs hooks,
 * and injects instruction files.
 */

import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  unlinkSync, readdirSync, lstatSync, statSync, rmSync,  realpathSync, readlinkSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { SIDECAR_JOURNAL_FILE } from './sidecar-blob.js'
import {
  CCR_MIN_VERSION, ccrConfigPath, ccrInstanceDirs, cycleHint, readCcrConfig,
  type CcrConfigState,
} from './ccr-pane.js'
import { redactHome } from '../debug.js'
import { leaseHolders } from '../persistence/leases.js'
import {
  type AgentDefinition, type Platform,
  AGENTS, detectAgents, getAgent, getConfigPath,
  getHookSettingsPath, getInstructionsPath, claudeLegacyMcpPath, legacyMcpConfigs,
} from './agents.js'
import {
  SKILL_REFERENCE_NAME, SKILL_REFERENCE_DESCRIPTION, SKILL_REFERENCE_BODY,
} from './instructions.js'

// ── Types ──────────────────────────────────────────────────────────

export interface InstallOptions {
  yes: boolean
  dryRun: boolean
  force: boolean
  agents: string[] | null
  useNpx: boolean
  debug?: boolean
  /** Register the lexical FlatStore backend (serve --lexical, no embedder). */
  lexical?: boolean
  /**
   * Install capture hooks for platforms whose adapter has not yet earned a
   * live-payload verification pass. Opt-in and loud: trying it on a real
   * session is exactly how an adapter earns that pass, so the flag exists —
   * but nobody gets it by accident.
   */
  experimentalCapture?: boolean
}

export interface ActionResult {
  type: 'mcp-config' | 'hook-script' | 'hook-settings' | 'instructions' | 'global-config' | 'skill'
  path: string
  status: 'created' | 'updated' | 'skipped' | 'dry-run' | 'error'
  detail?: string
}

export interface AgentInstallResult {
  agent: string
  slug: string
  actions: ActionResult[]
  /** Set when part of the asked-for removal was refused, with the reason. */
  refused?: string
}

export interface DiagnosticResult {
  check: string
  status: 'ok' | 'warn' | 'error'
  detail: string
  fix?: string
}

// ── MCP entry builders ─────────────────────────────────────────────

const SAFE_CMD_RE = /^[A-Za-z0-9._/-]+$/

function isCommandAvailable(cmd: string): boolean {
  if (!SAFE_CMD_RE.test(cmd)) return false
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [cmd], { stdio: 'ignore' })
    } else {
      execFileSync('/bin/sh', ['-c', 'command -v "$1"', '--', cmd], { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the absolute path to the CLI script (cli.js) relative to this module.
 * Works whether running from a repo build (dist/) or an installed package.
 */
function resolveCliPath(): string {
  const thisFile = fileURLToPath(import.meta.url)
  return resolve(dirname(thisFile), 'cli.js')
}

/**
 * The managed layouts a global install can land in, in ONE table.
 *
 * The same handful of roots has to be spelled four ways — a POSIX shell glob
 * (posixModuleGlobs), a cmd-batch probe (windowsCliResolveSnippet), and two
 * TypeScript scans (nodeCandidates, moduleFallbackExists) — and they had
 * drifted into four hand-synced copies, each of which a new layout has to be
 * remembered in separately. Every spelling below is RENDERED from this table,
 * so a layout is added once.
 *
 * A version manager keeps one directory per installed version, so what
 * separates fnm from nvm is the per-version prefix (`inner`) its installs sit
 * under. The fixed prefixes are the system-wide npm roots: never
 * version-stamped, so nothing about them needs scanning.
 */
const MANAGED_VERSION_MANAGERS = [
  { dir: ['.nvm', 'versions', 'node'], shellDir: '"$HOME"/.nvm/versions/node', inner: [] },
  { dir: ['.fnm', 'node-versions'], shellDir: '"$HOME"/.fnm/node-versions', inner: ['installation'] },
] as const

/**
 * The per-version prefixes, cross-producted with EVERY manager root by the
 * TypeScript probes below. The shell globs pair each root with its own prefix;
 * the probes stay deliberately wider, because a probe that guesses wrong costs
 * a false "reinstall" (or an unfound interpreter) while a probe that looks in
 * one extra empty directory costs a stat.
 */
const MANAGED_INNERS: ReadonlyArray<readonly string[]> = MANAGED_VERSION_MANAGERS.map(m => m.inner)

/**
 * The directory names a global install of this package can sit under, the
 * current name first. The package was published as `treecontext-mcp` at
 * 0.1.0-beta.1; every release candidate before it installed as
 * `treecontext`, and the wrappers those installs wrote bake that name into
 * their own search. Both are searched so a new wrapper still recovers onto a
 * surviving old copy, and the current name is preferred wherever both are
 * found: the old one is an older release, and running it against a store a
 * newer build has migrated is the worse failure.
 */
const PACKAGE_DIRS = ['treecontext-mcp', 'treecontext'] as const
type PackageDir = typeof PACKAGE_DIRS[number]

/**
 * Lowest preference first: the order a last-match-wins search wants. Shared
 * by the POSIX globs and the probe that mirrors them, so they cannot drift.
 */
const PACKAGE_DIRS_LAST_WINS: readonly PackageDir[] = [...PACKAGE_DIRS].reverse()

/** Fixed (never version-stamped) POSIX `node_modules` roots a global install lands in. */
const MANAGED_POSIX_ROOTS = [
  '/opt/homebrew/lib/node_modules',
  '/usr/local/lib/node_modules',
] as const

/**
 * The package directory names a wrapper body's own fallback search names,
 * in PACKAGE_DIRS order. A body written before the rename names only the old
 * one, and its shell search finds only that one — a probe that looked wider
 * would call such a wrapper healthy while it dies.
 */
function searchedPackageDirs(body: string): PackageDir[] {
  const flat = body.replace(/\\/g, '/')
  return PACKAGE_DIRS.filter(name => flat.includes(`node_modules/${name}/`))
}

/** The package-relative module path a body's fallback search looks for. */
function searchedModuleRel(body: string): string | undefined {
  return /node_modules\/(?:treecontext-mcp|treecontext)\/([^\s"';]+)/.exec(body.replace(/\\/g, '/'))?.[1]
}

/**
 * Their Windows counterparts, named by the environment variable that locates
 * them: nvm-windows keeps the active version behind a fixed symlink and npm's
 * global prefix is %APPDATA%\npm, so neither is version-stamped.
 */
const MANAGED_WINDOWS_PREFIXES = [
  { env: 'APPDATA', sub: ['npm'] },
  { env: 'ProgramFiles', sub: ['nodejs'] },
] as const

/**
 * Version directories under one managed root, memoized.
 *
 * doctor grades up to ~25 wrapper bodies in a run and moduleFallbackExists
 * re-walked the nvm/fnm roots from scratch for every one of them. The memo is
 * keyed by the root path — which embeds the home directory, so a redirected
 * HOME never reads another home's scan — and is cleared at the top of each
 * doctor run, so one report is one consistent snapshot and the next run sees
 * the disk again.
 */
let managedVersionsCache = new Map<string, string[]>()

function managedVersions(root: string): string[] {
  const hit = managedVersionsCache.get(root)
  if (hit) return hit
  let versions: string[] = []
  // An unreadable root gives the same answer as an absent one: nothing found.
  try { if (existsSync(root)) versions = readdirSync(root) } catch { versions = [] }
  managedVersionsCache.set(root, versions)
  return versions
}

/** Seam for doctor (and tests): forget the memoized layout scan. */
export function resetManagedLayoutScan(): void {
  managedVersionsCache = new Map()
}

/**
 * Interpreters to try, most-likely-correct first. `process.execPath` leads
 * because it is the node the user chose to run `install` with.
 *
 * Capped: each probe spawns a process, and a long-lived nvm directory can hold
 * dozens of versions. The cap is generous enough that the realistic answers
 * (the running interpreter, PATH's node, the newest managed versions) are all
 * inside it.
 */
const MAX_NODE_CANDIDATES = 8

function nodeCandidates(): string[] {
  const out = [process.execPath]
  const fromPath = whichNode()
  if (fromPath) out.push(fromPath)
  for (const manager of MANAGED_VERSION_MANAGERS) {
    const root = join(homedir(), ...manager.dir)
    // Newest version directory first (lexically, which is what the wrappers'
    // shell globs also settle for), then each per-version prefix.
    for (const v of [...managedVersions(root)].sort().reverse()) {
      for (const inner of MANAGED_INNERS) {
        const p = join(root, v, ...inner, 'bin', 'node')
        if (existsSync(p)) out.push(p)
      }
    }
  }
  return [...new Set(out)].slice(0, MAX_NODE_CANDIDATES)
}

/** First `node` on PATH, or null. */
function whichNode(): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).split('\n')[0]?.trim()
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

/**
 * True when `candidate` can actually load the native better-sqlite3 binding.
 *
 * Being executable is not enough, and this is the failure the check exists
 * for: on a Mac with Homebrew node 26 first on PATH, nvm node 24 with a stale
 * binding, and a working node 22 further down, the wrappers picked Homebrew
 * and every capture hook died on `require`. Hooks end in `2>/dev/null; exit 0`,
 * so the whole thing failed silently — hooks "running", nothing ever stored.
 */
function nodeLoadsBinding(candidate: string): boolean {
  try {
    const bindingEntry = createRequire(import.meta.url).resolve('better-sqlite3')
    // 8s, not 20s: loading a native module takes well under a second, and a
    // candidate that has not managed it by then is not going to. The timeout
    // is a hang guard, and with up to MAX_NODE_CANDIDATES of them the worst
    // case is what a user experiences as a frozen terminal — 64s of silence
    // rather than 160s, and the progress lines below mean it is not silent.
    execFileSync(candidate, ['-e', `require(${JSON.stringify(bindingEntry)})`], {
      stdio: 'ignore', timeout: 8_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * The interpreter to bake into the generated wrappers as first choice, or null
 * when none of the candidates can load the binding (in which case the wrappers
 * keep their runtime discovery and doctor reports the binding failure).
 *
 * Memoized: a single `install` writes seven wrappers plus the MCP launcher,
 * and each probe spawns a node process.
 */
let verifiedNodeCache: string | null | undefined
let rejectedInterpreterCache: string[] = []
export function verifiedNode(): string | null {
  if (verifiedNodeCache === undefined) {
    verifiedNodeCache = null
    rejectedInterpreterCache = []
    for (const candidate of nodeCandidates()) {
      if (nodeLoadsBinding(candidate)) {
        verifiedNodeCache = candidate
        break
      }
      rejectedInterpreterCache.push(candidate)
    }
  }
  return verifiedNodeCache
}

/**
 * Interpreters the probe tried and rejected, for reporting.
 *
 * Worth surfacing rather than deciding silently: the beta-1 macOS failure was
 * precisely "the obvious node on PATH is not the one that works", and a user
 * who sees their Homebrew node listed as skipped learns more from one line
 * than from any amount of documentation.
 */
export function rejectedInterpreters(): string[] {
  return rejectedInterpreterCache
}

/** Test seam: forget the memoized probe result. */
export function resetVerifiedNodeCache(): void {
  verifiedNodeCache = undefined
  rejectedInterpreterCache = []
}

/**
 * POSIX-shell snippet that resolves an executable `node` into $TC_NODE.
 *
 * Order: an install-time *verified* interpreter (one proven to load the native
 * binding) → PATH → nvm/fnm version-manager glob → the install-time execPath.
 *
 * The verified path leads because "first node on PATH" is not the same
 * question as "a node this package works under". The discovery chain stays
 * behind it so a version-manager upgrade (e.g. nvm v24.17→v24.18, which
 * deletes the old version dir) never strands a hardcoded interpreter path.
 */
function posixNodeResolveSnippet(verified: string | null): string {
  const preferred = verified
    ? `TC_NODE="${verified}"\nif [ ! -x "$TC_NODE" ]; then\n`
    : 'TC_NODE=""\nif true; then\n'
  return `${preferred}PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TC_NODE="$(command -v node || true)"
if [ ! -x "$TC_NODE" ]; then for _n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node; do [ -x "$_n" ] && TC_NODE="$_n"; done; fi
[ -x "$TC_NODE" ] || TC_NODE="${process.execPath}"
fi`
}

/**
 * cmd-batch snippet that resolves an executable `node` into %TC_NODE%.
 *
 * The Windows counterpart of posixNodeResolveSnippet, and deliberately in the
 * SAME order: an install-time *verified* interpreter (one proven to load the
 * native binding) first, whatever `node` PATH offers behind it.
 *
 * It used to be the inverse —
 *   `where node >nul 2>nul && (node "<cli>" %*) || ("<execPath>" "<cli>" %*)`
 * — which preferred whichever node was on PATH over the one install had
 * actually checked, and pinned `process.execPath` (never probed) as the
 * fallback. A node that cannot load better-sqlite3 therefore won on Windows,
 * capture died on require, and `2>nul` swallowed the error. That is precisely
 * the macOS beta-1 failure, reproduced on the platform that had no coverage to
 * notice it.
 *
 * When nothing verifies, the pin is SKIPPED rather than filled with
 * process.execPath: execPath is the first candidate nodeCandidates() probes,
 * so a null result means execPath itself was tried and REJECTED. Pinning it
 * would bake an interpreter already proven broken. PATH leads in that case,
 * with execPath as the last resort — the same shape the POSIX snippet takes.
 *
 * `set "VAR=value"` quoting keeps paths holding spaces or `&` intact, and
 * `if not exist` is the batch spelling of the POSIX `[ -x ]` guard. The bare
 * `node` written by the fallback is a sentinel meaning "resolve at runtime",
 * and launcherInterpreter() reads it as "nothing pinned" — the same state the
 * POSIX dialect spells as an empty TC_NODE.
 */
function windowsNodeResolveSnippet(verified: string | null): string {
  return verified
    ? `set "TC_NODE=${verified}"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n`
    : `set "TC_NODE=node"\r\nwhere node >nul 2>nul || set "TC_NODE=${process.execPath}"\r\n`
}

/**
 * Layouts a global install can land in, searched when the baked path is
 * gone. Last match wins, so the VERSION-MANAGER globs sit last on purpose:
 * a baked path only dies version-stamped, which makes the nvm/fnm user the
 * near-certain owner of any wrapper that reaches this search — the system
 * prefixes are a lifeline for the remainder, not a preference. (The
 * interpreter chain leans the other way, PATH-prepending the system
 * prefixes; that asymmetry is deliberate: an interpreter is resolved on
 * every run, this search runs only after a version-stamped death.)
 *
 * Within one glob the shell expands lexicographically, so among several
 * surviving copies the winner is the alphabetically-last version directory,
 * not the numerically newest (v24.9.0 outsorts v24.18.0). Any live copy
 * beats the dead pin; picking the numerically newest would take a real sort
 * the wrapper deliberately does not spend a process on.
 *
 * Parameterised on the package-relative module path because cli.js is not the
 * only version-stamped module the installer bakes into a script: the agent
 * hook wrappers (agentHookWrapperContent) dispatch to dist/hooks/<agent>/
 * entry points that live in the same deletable directory.
 */
function posixModuleGlobs(rel: string): string[] {
  // The package name is the outer key: every old-name layout before every
  // current-name one, so a surviving current copy wins over any old copy
  // (PACKAGE_DIRS says why). Within one name the layout order is as before.
  return PACKAGE_DIRS_LAST_WINS.flatMap(name => [
    ...MANAGED_POSIX_ROOTS.map(r => `${r}/${name}/${rel}`),
    // Version-manager globs last, for the last-match-wins reason above. Their
    // order among themselves is a tie-break with no argument either way; it is
    // reverse table order, and pinned only so the generated text does not churn.
    ...[...MANAGED_VERSION_MANAGERS].reverse().map(m =>
      `${m.shellDir}/*/${[...m.inner, 'lib', 'node_modules', name, rel].join('/')}`),
  ])
}

/**
 * POSIX-shell snippet that resolves the CLI module into $TC_CLI.
 *
 * The interpreter learned to survive a version-manager upgrade; the MODULE it
 * runs had not. `install` bakes an absolute cli.js path, and for a global npm
 * install that path is itself version-stamped —
 * ~/.nvm/versions/node/<version>/lib/node_modules/treecontext-mcp/dist/server/cli.js.
 * The next `nvm install` deletes that directory, so TC_NODE resolves to a
 * perfectly good new node and hands it a file that is gone. What the user sees
 * is MODULE_NOT_FOUND surfacing as a bare "Connection closed" from the MCP
 * client, and from the hooks nothing whatsoever — they redirect stderr and
 * exit 0. Observed in the wild on an nvm v24.18→v24.20 bump, where the one
 * session still holding the deleted files open kept working and every new one
 * did not, which made it look like a per-project fault.
 *
 * Same shape as posixNodeResolveSnippet and for the same reason: the
 * install-time path leads (it is the build `install` actually ran from, and a
 * repo checkout is never version-stamped, so it stays correct indefinitely),
 * with the glob behind it for when it vanishes.
 */
function posixCliResolveSnippet(cliPath: string, rel = 'dist/server/cli.js'): string {
  return `TC_CLI="${cliPath}"
if [ ! -f "$TC_CLI" ]; then for _c in ${posixModuleGlobs(rel).join(' ')}; do [ -f "$_c" ] && TC_CLI="$_c"; done; fi`
}

/**
 * cmd-batch counterpart of posixCliResolveSnippet.
 *
 * Deliberately probes rather than globs: nvm-windows keeps the active version
 * behind a fixed symlink and npm's global prefix is %APPDATA%\npm, so the
 * Windows layouts a global install lands in are not version-stamped in the
 * first place. Two `if not exist` probes cover them, and batch has no clean
 * way to expand a directory wildcard anyway.
 */
function windowsCliResolveSnippet(cliPath: string, rel = 'dist\\server\\cli.js'): string {
  // First existing probe wins here, so the current package name goes first.
  return [
    `set "TC_CLI=${cliPath}"`,
    ...PACKAGE_DIRS.flatMap(name => MANAGED_WINDOWS_PREFIXES.map(p =>
      `if not exist "%TC_CLI%" set "TC_CLI=%${p.env}%\\${p.sub.join('\\')}\\node_modules\\${name}\\${rel}"`)),
    '',
  ].join('\r\n')
}

/**
 * Absolute path to the generated MCP launcher wrapper. The wrapper resolves
 * node at runtime, so pointing an agent's MCP `command` at this stable path
 * (instead of a version-stamped interpreter) survives node upgrades.
 * Lives in the treecontext-owned scripts dir so uninstall cleans it up.
 */
export function mcpLauncherPath(): string {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  return join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME, `${TC_HOOK_PREFIX}mcp-serve${ext}`)
}

/**
 * Body of the MCP launcher wrapper. Resolves node the same way the hooks do,
 * then `exec`s the stdio server (args are forwarded so per-agent flags like
 * --lexical still flow through). Unlike the hooks it does NOT suppress
 * stderr: the MCP client surfaces it, and swallowing it is exactly what hid
 * the original "exec fails 127" breakage.
 */
export function mcpLauncherScriptContent(): string {
  const cliPath = resolveCliPath()
  if (process.platform === 'win32') {
    // Same resolution order as the POSIX branch below (verified pin → PATH),
    // via the shared snippet. Args forwarded with %*; `setlocal` keeps TC_NODE
    // out of a caller's environment. stderr is NOT suppressed here for the
    // reason in this function's doc comment.
    return `@echo off\r\nREM treecontext: MCP stdio launcher\r\nREM Installed by: treecontext install\r\nsetlocal\r\n${windowsNodeResolveSnippet(verifiedNode())}${windowsCliResolveSnippet(cliPath)}"%TC_NODE%" "%TC_CLI%" %*\r\n`
  }
  return `#!/bin/bash
# treecontext: MCP stdio launcher
# Installed by: treecontext install
${posixNodeResolveSnippet(verifiedNode())}
${posixCliResolveSnippet(cliPath)}
exec "$TC_NODE" "$TC_CLI" "$@"
`
}

export function mcpCommand(useNpx: boolean, lexical = false): { command: string; args: string[] } {
  const serveArgs = ['serve', '--transport', 'stdio', '--capture', '--debug']
  // Lexical FlatStore backend (FTS5 bm25, no embedder/ONNX). When set, the
  // served store bypasses the embedder + tree path (cli.ts serve --lexical).
  if (lexical) serveArgs.push('--lexical')
  if (useNpx) {
    // The package's npm name, not the command's: `treecontext` is held by
    // nobody on npm and anyone could register it, so `npx -y treecontext`
    // would run whatever they published. (`--npx` itself stays refused during
    // the beta — npx resolves `latest`, which is the name reservation.)
    return { command: 'npx', args: ['-y', 'treecontext-mcp', ...serveArgs] }
  }
  // Local install: launch through the generated wrapper (installMcpLauncher),
  // which resolves node at runtime. Emitting a bare interpreter path here —
  // process.execPath, or a version-managed `treecontext` bin — bakes a
  // version-stamped path into every agent config; an nvm/fnm upgrade deletes
  // the old version dir and strands it, killing the MCP server until a manual
  // reinstall. The wrapper path is stable across upgrades.
  return { command: mcpLauncherPath(), args: serveArgs }
}

export function buildMcpEntry(agent: AgentDefinition, useNpx: boolean, lexical = false): Record<string, unknown> {
  const { command, args } = mcpCommand(useNpx, lexical)
  switch (agent.configFormat) {
    case 'json-servers':
      return { type: 'stdio', command, args }
    case 'json-opencode':
      return { type: 'local', command: [command, ...args] }
    default:
      return { command, args }
  }
}

export function configRootKey(agent: AgentDefinition): string {
  switch (agent.configFormat) {
    case 'json-mcpServers': return 'mcpServers'
    case 'json-servers': return 'servers'
    case 'json-opencode': return 'mcp'
    case 'toml-codex': return 'mcp_servers'
  }
}

// ── Atomic file I/O ────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function atomicWrite(filePath: string, content: string, mode: number = 0o644): void {
  ensureDir(filePath)
  const tmp = `${filePath}.tmp.${process.pid}`
  writeFileSync(tmp, content, { mode })
  // On Windows, renameSync fails if the destination exists. Remove it
  // first for cross-platform atomic-ish write semantics.
  try { unlinkSync(filePath) } catch { /* may not exist yet */ }
  renameSync(tmp, filePath)
}

// ── JSON config merge ──────────────────────────────────────────────

function backupCorrupt(filePath: string): string {
  const bakPath = `${filePath}.bak`
  try {
    renameSync(filePath, bakPath)
  } catch {
    // If rename fails (permissions etc.), continue — we'll overwrite
    return bakPath
  }
  return bakPath
}

function readJsonSafe(path: string, backup = false): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    if (backup) {
      const bakPath = backupCorrupt(path)
      console.error(`[warn] corrupt JSON at ${path} — backed up to ${bakPath}`)
    }
    return {}
  }
}

export function upsertJsonMcp(
  path: string, rootKey: string, entry: Record<string, unknown>,
  force: boolean, dryRun: boolean,
): ActionResult {
  const data = readJsonSafe(path, true)
  const servers = (data[rootKey] ?? {}) as Record<string, unknown>

  if (servers.treecontext && !force) {
    const existing = servers.treecontext as Record<string, unknown>
    // opencode uses a command array; everything else a command string
    const existingCmd = typeof existing.command === 'string'
      ? existing.command
      : Array.isArray(existing.command) ? String((existing.command as unknown[])[0] ?? '') : undefined
    const existingArgs = Array.isArray(existing.command)
      ? (existing.command as string[])
      : (existing.args ?? []) as string[]

    // Bare interpreter names are PATH-dependent and break GUI-launched
    // agents (launchd PATH on macOS) — upgrade them to absolute paths.
    const bareLegacyCmd = existingCmd === 'node' || existingCmd === 'treecontext'
    const unresolvableCmd = existingCmd
      && existingCmd !== 'node' && existingCmd !== 'npx'
      && !isAbsolute(existingCmd)
      && !isCommandAvailable(existingCmd)
    const staleInterpreter = existingCmd && isAbsolute(existingCmd) && !existsSync(existingCmd)
    const missingCapture = !existingArgs.includes('--capture')
    // Converge the backend flag: if the desired entry and the existing one
    // disagree on --lexical, update (even without --force). Otherwise a plain
    // `install` can neither add the default lexical flag to an old config nor
    // honor an explicit --no-lexical — the flag isn't part of the skip check.
    const desiredArgs = Array.isArray(entry.command)
      ? (entry.command as string[])
      : (entry.args ?? []) as string[]
    const lexicalMismatch = desiredArgs.includes('--lexical') !== existingArgs.includes('--lexical')

    if (!bareLegacyCmd && !unresolvableCmd && !staleInterpreter && !missingCapture && !lexicalMismatch) {
      return { type: 'mcp-config', path, status: 'skipped', detail: 'already configured' }
    }
  }

  const status = servers.treecontext ? 'updated' : 'created'
  servers.treecontext = entry
  data[rootKey] = servers

  if (dryRun) {
    return { type: 'mcp-config', path, status: 'dry-run' }
  }
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'mcp-config', path, status }
}

export function removeJsonMcp(path: string, rootKey: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  const data = readJsonSafe(path)
  const servers = (data[rootKey] ?? {}) as Record<string, unknown>
  if (!servers.treecontext) return null
  delete servers.treecontext
  data[rootKey] = servers
  if (!dryRun) atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'mcp-config', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

// ── TOML config merge (Codex) ──────────────────────────────────────

export function upsertTomlMcp(
  path: string, entry: Record<string, unknown>,
  force: boolean, dryRun: boolean,
): ActionResult {
  let data: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      data = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      const bakPath = backupCorrupt(path)
      console.error(`[warn] corrupt TOML at ${path} — backed up to ${bakPath}`)
    }
  }

  const servers = (data.mcp_servers ?? {}) as Record<string, unknown>
  if (servers.treecontext && !force) {
    const existing = servers.treecontext as Record<string, unknown>
    const existingCmd = existing.command as string | undefined
    const existingArgs = (existing.args ?? []) as string[]
    // Bare interpreter names break GUI-launched agents — upgrade them.
    const bareLegacyCmd = existingCmd === 'node' || existingCmd === 'treecontext'
    const staleInterpreter = existingCmd && isAbsolute(existingCmd) && !existsSync(existingCmd)
    const hasCapture = existingArgs.includes('--capture')
    // Converge the backend flag (see upsertJsonMcp): a --lexical disagreement
    // between desired and existing must trigger an update even without --force.
    const desiredArgs = (entry.args ?? []) as string[]
    const lexicalMismatch = desiredArgs.includes('--lexical') !== existingArgs.includes('--lexical')
    if (!bareLegacyCmd && !staleInterpreter && hasCapture && !lexicalMismatch) {
      return { type: 'mcp-config', path, status: 'skipped', detail: 'already configured' }
    }
  }
  const status = servers.treecontext ? 'updated' : 'created'
  servers.treecontext = entry
  data.mcp_servers = servers

  if (dryRun) return { type: 'mcp-config', path, status: 'dry-run' }
  atomicWrite(path, stringifyToml(data) + '\n')
  return { type: 'mcp-config', path, status }
}

export function removeTomlMcp(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  try {
    const data = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
    const servers = (data.mcp_servers ?? {}) as Record<string, unknown>
    if (!servers.treecontext) return null
    delete servers.treecontext
    data.mcp_servers = servers
    if (!dryRun) atomicWrite(path, stringifyToml(data) + '\n')
    return { type: 'mcp-config', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
  } catch {
    return null
  }
}

// ── Hook installation ──────────────────────────────────────────────

const TC_HOOK_PREFIX = 'tc-'

/** The Claude Code hook scripts `install` writes, in install order. */
const CLAUDE_HOOK_SCRIPTS = [
  'session-reminder', 'session-start', 'pre-compact',
  'post-tool-use', 'user-prompt-submit', 'stop',
  'subagent-start', 'subagent-stop',
] as const

/** Windows needs a .cmd extension for a hook script to be executable. */
function hookScriptExt(platform: Platform = process.platform as Platform): string {
  return platform === 'win32' ? '.cmd' : ''
}

/**
 * Absolute paths of the Claude Code hook scripts, named as they actually land
 * on this platform.
 *
 * `install` and `doctor` MUST agree on these names, and they did not: install
 * appended `.cmd` on Windows while doctor's presence check listed the six
 * scripts extensionless. Every Windows install therefore wrote six working
 * hooks and was then told "hooks missing", with an offered fix
 * (`install --force --agent claude`) that rewrote the same six files and left
 * the warning exactly where it was — a loop the user cannot break. The same
 * extensionless paths made the legacy bare-`node` check dead on Windows.
 *
 * One definition, so the two sides cannot drift apart again. `platform` is
 * injectable for the same reason getConfigPath's is: the defect is invisible
 * on the platform the suite usually runs on.
 */
export function claudeHookScriptPaths(platform: Platform = process.platform as Platform): string[] {
  const hooksDir = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)
  const ext = hookScriptExt(platform)
  return CLAUDE_HOOK_SCRIPTS.map(n => join(hooksDir, `${TC_HOOK_PREFIX}${n}${ext}`))
}
const LEGACY_HOOK_PREFIXES = ['cbm-']
const HOOK_SCRIPTS_DIR_NAME = 'hooks'

/**
 * Agent slugs whose capture adapter has earned a live-payload
 * verification pass, and for which `install` will therefore write hook
 * configuration.
 *
 * Every other agent still gets its MCP registration — the tools work
 * anywhere the agent speaks MCP — but no hooks, because a hook config
 * that a user can see in their settings reads as a promise that capture
 * is running. An adapter joins this set when someone has run it against
 * the real platform and inspected the resulting rows, never because its
 * source looks right (`src/hooks/README.md`).
 */
export const CAPTURE_PLATFORMS = new Set(['claude'])

/**
 * Clients that keep their own hook configuration rather than reading the
 * Claude settings file, so capture can reach them only through a copy of
 * the hooks: Codex CLI verbatim, Gemini CLI translated to its renamed
 * events (survey of official documentation, 2026-10-05; D154). Outside
 * CAPTURE_PLATFORMS the copy is written only behind --experimental-capture,
 * and doctor names that command as the way to copy (D208).
 */
export const COPYING_CLIENTS = new Set(['codex', 'gemini'])

/**
 * Clients that read the Claude settings file as-is (D154): the installer
 * writes nothing for them, with or without --experimental-capture (D208,
 * D226). Their old adapters (src/hooks/vscode, src/hooks/cursor) stay in
 * source, unwired; uninstall still removes what earlier builds wrote, and
 * doctor flags such a copy as a second route.
 */
export const AS_IS_CLIENTS = new Set(['vscode', 'cursor'])

/** The one line the flagged install prints for an as-is client. */
const AS_IS_CLIENT_LINE: Readonly<Record<string, string>> = {
  vscode: 'VS Code reads the Claude settings file; turn chat.useClaudeHooks on',
  cursor: 'Cursor reads the Claude settings file by default',
}

// States the TRIGGER_CORE orientation protocol (instructions.ts) with
// hook-channel framing; protocol conformance is enforced by
// tests/server/instructions-drift.test.ts.
export const SESSION_REMINDER_TEXT = `CRITICAL - Treecontext Session Orientation (do this BEFORE responding or calling any other tool):
1. treecontext_status — check for resume_pointers (nodes tagged next_session=true or status=active)
2. If resume_pointers exist, treecontext_export(node_id) on each one — these are plans and active threads from the prior session
3. treecontext_query("what was I working on, what was the next step") — even after fetching pointers, you need sibling/parent context
Only THEN respond to the user. Skipping this re-litigates prior decisions and loses session continuity.
When you later write a plan/close-out that replaces one of these pointers, pass supersedes: [old_node_ids] to treecontext_insert.`

function sessionReminderContent(): string {
  if (process.platform === 'win32') {
    return `@echo off\r\nREM treecontext: session-start orientation reminder\r\nREM Installed by: treecontext install\r\necho ${SESSION_REMINDER_TEXT.replace(/\n/g, '\r\necho ')}\r\n`
  }
  return `#!/bin/bash
# treecontext: session-start orientation reminder
# Installed by: treecontext install
cat << 'REMINDER'
${SESSION_REMINDER_TEXT}
REMINDER
`
}

export function hookScriptContent(event: string, debug = false): string {
  const cliPath = resolveCliPath()
  if (process.platform === 'win32') {
    const dbgLine = debug ? 'set TREECONTEXT_DEBUG=1\r\n' : ''
    // Was `"<execPath>" "<cli>" hook <event> 2>nul` — pinned only, with NO
    // fallback and no verification. A routine node upgrade that moves execPath
    // stranded every capture hook, and `2>nul` meant the user never saw it.
    // The POSIX branch survives that through its discovery chain; this now
    // does too, through the shared snippet.
    //
    // `exit /b 0` is this dialect's spelling of the exit-status guarantee the
    // POSIX branch below documents. Batch has no exec, so the dispatch is
    // already an ordinary child and the script's own status is the last word:
    // one line covers a missing module, a missing interpreter and anything
    // else, where the POSIX branch needs a pre-exec guard.
    return `@echo off\r\nREM treecontext: ${event} hook\r\nREM Installed by: treecontext install\r\nsetlocal\r\n${dbgLine}${windowsNodeResolveSnippet(verifiedNode())}${windowsCliResolveSnippet(cliPath)}"%TC_NODE%" "%TC_CLI%" hook ${event} 2>nul\r\nexit /b 0\r\n`
  }
  const prefix = debug ? 'TREECONTEXT_DEBUG=1 ' : ''
  // Resolve node at runtime via the shared snippet (PATH → nvm/fnm glob →
  // embedded execPath). None alone is enough: `command -v node` misses the
  // minimal PATH that GUI/router launches (ccs/ccr, launchd) hand hooks; the
  // version-manager glob survives upgrades where a hardcoded path is stranded
  // (v24.17→24.18 deletes the old dir → exec fails 127); execPath is the
  // last-resort fallback for exotic layouts. The MCP launcher reuses the
  // identical snippet — see mcpLauncherScriptContent.
  //
  // The GUARD line is the exit-status guarantee (ruling 2026-08-15: a hook
  // exit is NEVER non-zero — Claude Code acts on these codes, and a capture
  // channel that is merely broken must not also perturb the session). The CLI
  // honours that ruling from the inside for every failure after it loads (see
  // the hook fast path in cli.ts); the two it cannot answer for are failing to
  // load at all — a TC_CLI pin that died with its directory and a fallback
  // search that came up empty, which exits MODULE_NOT_FOUND — and an
  // interpreter that will not execute, which exits 126/127 from the shell.
  // `exec` puts both beyond reach of the trailing `exit 0`, because exec has
  // already replaced this shell. So the resolution is checked BEFORE the exec
  // rather than the exec being dropped:
  //
  // dropping exec would break session identity. Both this script and the MCP
  // launcher exec into node so the node process's own `process.ppid` IS the
  // claude process's pid, which is the exact, race-free key the session beacon
  // is built on (docs/session-identity.md §3, rung 1 'pid'; see
  // src/session-beacon.ts and src/hooks/session-start.ts). Leave a shell in
  // between and the beacon is keyed on a shell pid that dies immediately and
  // is recycled — the agent wrappers can drop exec because they carry no such
  // key, these cannot.
  return `#!/bin/bash
# treecontext: ${event} hook
# Installed by: treecontext install
${posixNodeResolveSnippet(verifiedNode())}
${posixCliResolveSnippet(cliPath)}
[ -x "$TC_NODE" ] && [ -f "$TC_CLI" ] || exit 0
${prefix}exec "$TC_NODE" "$TC_CLI" hook ${event} 2>/dev/null
exit 0
`
}

/**
 * Write the MCP launcher wrapper (mcpLauncherPath). Idempotent; overwrites so
 * a repo move or resolution-logic change propagates on `install`. Referenced
 * by every non-npx agent's MCP `command`, so it is installed once up front,
 * independent of which agents use claude-format hooks.
 */
function installMcpLauncher(dryRun: boolean): ActionResult {
  const scriptPath = mcpLauncherPath()
  if (dryRun) return { type: 'hook-script', path: scriptPath, status: 'dry-run' }
  const existed = existsSync(scriptPath)
  ensureDir(scriptPath)
  writeFileSync(scriptPath, mcpLauncherScriptContent(), { mode: 0o755 })
  return { type: 'hook-script', path: scriptPath, status: existed ? 'updated' : 'created' }
}

// Exported so the loop-closing test can drive the real writer against a
// sandboxed HOME: whatever install writes has to satisfy the check that
// grades it, and asserting that against a hand-rolled imitation of what
// install writes would only ever prove the imitation right.
export function installClaudeHookScripts(dryRun: boolean, debug = false): ActionResult[] {
  const results: ActionResult[] = []
  const hooksDir = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)

  // Remove legacy hook scripts (e.g. cbm-*) that are now superseded
  if (existsSync(hooksDir)) {
    for (const name of readdirSync(hooksDir)) {
      if (LEGACY_HOOK_PREFIXES.some(p => name.startsWith(p))) {
        const scriptPath = join(hooksDir, name)
        if (!dryRun) unlinkSync(scriptPath)
        results.push({ type: 'hook-script', path: scriptPath, status: dryRun ? 'dry-run' : 'updated', detail: 'removed legacy' })
      }
    }
  }

  // Names come from claudeHookScriptPaths so doctor's presence check and this
  // write can never disagree about the .cmd extension again.
  const bodies: Record<string, string> = {
    'session-reminder': sessionReminderContent(),
    'session-start': hookScriptContent('session-start', debug),
    'pre-compact': hookScriptContent('pre-compact', debug),
    'post-tool-use': hookScriptContent('post-tool-use', debug),
    'user-prompt-submit': hookScriptContent('user-prompt-submit', debug),
    'stop': hookScriptContent('stop', debug),
    'subagent-start': hookScriptContent('subagent-start', debug),
    'subagent-stop': hookScriptContent('subagent-stop', debug),
  }
  const scripts: Array<[string, string]> = claudeHookScriptPaths().map((p) => {
    const stem = basename(p).slice(TC_HOOK_PREFIX.length).replace(/\.cmd$/, '')
    const body = bodies[stem]
    if (body === undefined) throw new Error(`no body for hook script ${stem}`)
    return [basename(p), body]
  })

  for (const [name, content] of scripts) {
    const scriptPath = join(hooksDir, name)
    if (dryRun) {
      results.push({ type: 'hook-script', path: scriptPath, status: 'dry-run' })
      continue
    }
    // Sample existence BEFORE the write — checking after it always reports
    // "updated", which hides whether an install was fresh or a repair.
    const existed = existsSync(scriptPath)
    ensureDir(scriptPath)
    writeFileSync(scriptPath, content, { mode: 0o755 })
    results.push({
      type: 'hook-script', path: scriptPath,
      status: existed ? 'updated' : 'created',
    })
  }

  // Also remove old extensionless scripts on Windows (from prior installs)
  if (process.platform === 'win32') {
    for (const [name] of scripts) {
      const oldPath = join(hooksDir, name.replace(/\.cmd$/, ''))
      if (existsSync(oldPath)) {
        if (!dryRun) try { unlinkSync(oldPath) } catch { /* best-effort */ }
        results.push({ type: 'hook-script', path: oldPath, status: dryRun ? 'dry-run' : 'updated', detail: 'removed extensionless' })
      }
    }
  }

  return results
}

// Exported for the same loop-closing reason as installClaudeHookScripts:
// the sweep's sparing rules (MCP launcher under --hooks-only, other agents'
// wrappers always) are claims about what uninstall actually leaves behind.
export function removeClaudeHookScripts(dryRun: boolean, hooksOnly = false, spareClaudeScripts = false): ActionResult[] {
  const results: ActionResult[] = []
  const hooksDir = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)
  if (!existsSync(hooksDir)) return results
  // Scripts a Codex or Gemini copy still runs (uninstall's refusal, D225).
  const sparedScripts = new Set(spareClaudeScripts ? claudeHookScriptPaths().map(p => basename(p)) : [])

  // The MCP launcher shares this directory and prefix but is not a hook:
  // --hooks-only keeps the MCP registration, and the registration points
  // at this script — deleting it left a working config aimed at nothing
  // (F1 defect, 2026-08-15). A full uninstall still takes it.
  const spared = hooksOnly ? basename(mcpLauncherPath()) : null
  const ownedPrefixes = [TC_HOOK_PREFIX, ...LEGACY_HOOK_PREFIXES]
  // The other agents' wrappers share this directory and prefix but belong to
  // THEIR uninstall branches (removeAgentHookWrappers): sweeping them here
  // while a still-installed gemini/vscode/codex/cursor config references
  // them leaves a working config aimed at nothing — the same F1 shape the
  // `spared` comment above documents for the MCP launcher.
  const agentWrapperPrefixes = (Object.keys(AGENT_HOOK_WRAPPER_STEMS) as AgentHookAgent[])
    .map(a => `${TC_HOOK_PREFIX}${a}-`)
  for (const name of readdirSync(hooksDir)) {
    if (name === spared) continue
    if (sparedScripts.has(name)) continue
    if (agentWrapperPrefixes.some(p => name.startsWith(p))) continue
    if (ownedPrefixes.some(p => name.startsWith(p))) {
      const scriptPath = join(hooksDir, name)
      if (!dryRun) unlinkSync(scriptPath)
      results.push({ type: 'hook-script', path: scriptPath, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' })
    }
  }
  return results
}

// ── Agent hook wrapper scripts (gemini / vscode / codex / cursor) ──
//
// These agents' hook configs used to carry `"<execPath>" "<entry.js>"`
// verbatim — both halves version-stamped for a global install, so the same
// nvm upgrade that once stranded the Claude hooks stranded these four AND
// their interpreter in one stroke, with no resolution chain to survive on.
// They now point at generated wrapper scripts, exactly the arrangement the
// Claude hooks and the MCP launcher already survive upgrades with.
//
// The wrappers live in the treecontext-owned ~/.claude/hooks directory
// beside tc-mcp-serve — which every agent's MCP config already references,
// so the location is agent-neutral by precedent, and the tc- prefix sweep
// in removeClaudeHookScripts cleans them up on uninstall.

/** Hook entry-point stems per agent, mirroring dist/hooks/<agent>/<stem>.js. */
export const AGENT_HOOK_WRAPPER_STEMS = {
  gemini: ['session-start', 'before-agent', 'after-tool', 'pre-compress'],
  vscode: ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop', 'pre-compact'],
  codex: ['session-start', 'user-prompt-submit', 'post-tool-use', 'pre-compact'],
  cursor: ['session-start', 'user-prompt-submit', 'post-tool-use', 'pre-compact'],
} as const

export type AgentHookAgent = keyof typeof AGENT_HOOK_WRAPPER_STEMS

export function agentHookWrapperPath(agent: AgentHookAgent, stem: string): string {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  return join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME, `${TC_HOOK_PREFIX}${agent}-${stem}${ext}`)
}

/**
 * Body of an agent hook wrapper: the same TC_NODE + TC_CLI resolution the
 * Claude hook scripts carry, dispatching to the agent's entry point instead
 * of `cli.js hook <event>`. The module search is re-rooted at
 * dist/hooks/<agent>/<stem>.js — the entry lives in the same version-stamped
 * package directory as cli.js and vanishes with it.
 *
 * stderr is NOT suppressed (unlike the Claude hook scripts): these runners
 * are opt-in experimental capture, and what their hosts do with hook stderr
 * is theirs to decide — swallowing it here is exactly what hid the original
 * breakage. Args and stdin flow through so a runner that hands the payload
 * either way keeps working.
 *
 * The exit status IS masked (plain invocation + exit 0, no exec): capture is
 * passive and must never block the host, but Cursor's beforeSubmitPrompt and
 * Gemini's BeforeAgent act on hook exit codes — a stranded install execing a
 * gone interpreter would hand them the shell's 126/127 and perturb the
 * user's prompt flow instead of merely losing capture. The Claude wrappers
 * get the same guarantee from the CLI itself (hook exits are NEVER non-zero,
 * ruling 2026-08-15); these entry points are reached without the CLI, so the
 * wrapper is where the guarantee has to live.
 */
export function agentHookWrapperContent(agent: AgentHookAgent, stem: string): string {
  const entryPath = resolve(dirname(resolveCliPath()), '..', 'hooks', agent, `${stem}.js`)
  if (process.platform === 'win32') {
    const rel = `dist\\hooks\\${agent}\\${stem}.js`
    return `@echo off\r\nREM treecontext: ${agent} ${stem} hook\r\nREM Installed by: treecontext install\r\nsetlocal\r\n${windowsNodeResolveSnippet(verifiedNode())}${windowsCliResolveSnippet(entryPath, rel)}"%TC_NODE%" "%TC_CLI%" %*\r\nexit /b 0\r\n`
  }
  return `#!/bin/bash
# treecontext: ${agent} ${stem} hook
# Installed by: treecontext install
${posixNodeResolveSnippet(verifiedNode())}
${posixCliResolveSnippet(entryPath, `dist/hooks/${agent}/${stem}.js`)}
"$TC_NODE" "$TC_CLI" "$@"
exit 0
`
}

/**
 * Write one agent's hook wrappers. Idempotent; overwrites so a repo move or
 * resolution-logic change propagates on `install` — the same policy as
 * installMcpLauncher. Called by the install flow before the config upsert,
 * so a config can never reference a wrapper install did not write.
 */
export function installAgentHookWrappers(agent: AgentHookAgent, dryRun: boolean): ActionResult[] {
  const results: ActionResult[] = []
  for (const stem of AGENT_HOOK_WRAPPER_STEMS[agent]) {
    const scriptPath = agentHookWrapperPath(agent, stem)
    if (dryRun) {
      results.push({ type: 'hook-script', path: scriptPath, status: 'dry-run' })
      continue
    }
    const existed = existsSync(scriptPath)
    ensureDir(scriptPath)
    writeFileSync(scriptPath, agentHookWrapperContent(agent, stem), { mode: 0o755 })
    results.push({ type: 'hook-script', path: scriptPath, status: existed ? 'updated' : 'created' })
  }
  return results
}

/**
 * Remove one agent's hook wrappers. Owned by that agent's uninstall branch —
 * NOT by the claude tc- sweep, which spares them: `uninstall claude` on a
 * machine that still runs gemini capture must not delete the scripts
 * gemini's config points at. Both dialect spellings are taken, so a
 * cross-platform home sync never strands the other platform's copy.
 */
export function removeAgentHookWrappers(agent: AgentHookAgent, dryRun: boolean): ActionResult[] {
  const results: ActionResult[] = []
  const hooksDir = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)
  for (const stem of AGENT_HOOK_WRAPPER_STEMS[agent]) {
    for (const ext of ['', '.cmd']) {
      const scriptPath = join(hooksDir, `${TC_HOOK_PREFIX}${agent}-${stem}${ext}`)
      if (!existsSync(scriptPath)) continue
      if (!dryRun) unlinkSync(scriptPath)
      results.push({ type: 'hook-script', path: scriptPath, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' })
    }
  }
  return results
}

/**
 * First problem among an agent's hook wrappers, or null — doctor's read of the
 * same classes hookScriptIssue grades for the Claude scripts. The bodies are
 * where a stale TC_CLI pin with an empty fallback search hides.
 *
 * A wrapper that is simply ABSENT used to be waved through here, on the claim
 * that the config-command grading catches it. It did not: that grading walks
 * `command` keys, and Copilot's schema carries the invocation under
 * `bash`/`powershell` — so a deleted tc-vscode-* wrapper was invisible to
 * doctor from both sides at once. collectCommandStrings now reads those keys
 * too, and this reads the config's own commands (`referenced`) so a wrapper
 * the agent will actually try to run is reported when it is not there. A
 * wrapper nothing references is still not judged: an agent installed without
 * `--experimental-capture` has no wrappers by design.
 */
export function agentHookWrapperIssue(
  agent: AgentHookAgent, referenced: readonly string[] = [],
): string | null {
  for (const stem of AGENT_HOOK_WRAPPER_STEMS[agent]) {
    const p = agentHookWrapperPath(agent, stem)
    if (!existsSync(p)) {
      // Matched on the file NAME: a command spells the path with forward
      // slashes even on Windows (claudeHookCommand) while the wrapper path
      // keeps native separators, and the name is the half both dialects agree
      // on. It is tc-<agent>-<stem>, so it collides with nothing else.
      const name = basename(p)
      if (referenced.some(c => c.includes(name))) {
        return `hook wrapper ${name}: referenced by the hook config but missing from disk — capture records nothing; reinstall`
      }
      continue
    }
    const issue = hookScriptIssue(readFileSync(p, 'utf8'))
    if (issue) return `hook wrapper ${basename(p)}: ${issue}`
  }
  return null
}

export interface ClaudeHookEntry {
  type: string
  command: string
  /** Which shell Claude Code should run `command` in. Windows only — see
   *  hookShellFor. Absent on POSIX, where `sh -c` is the only option. */
  shell?: HookShell
}

/** The shells Claude Code will hand a hook command to. */
export type HookShell = 'bash' | 'powershell'

export interface ClaudeHookMatcher {
  matcher?: string
  hooks: ClaudeHookEntry[]
}

/**
 * A hook path as Claude Code's settings.json should carry it.
 *
 * Claude Code runs a hook command THROUGH A SHELL, and on Windows the shell
 * seen in the field is bash (Git Bash on PATH), not cmd — beta reports carry
 * `/usr/bin/bash: line 1:` on every hook error. Two consequences, both
 * verified against bash rather than assumed:
 *
 *   BACKSLASHES ARE ESCAPES. A bare `C:\Users\user\.claude\hooks\tc-stop.cmd`
 *   reaches bash as `C:Usersuser.claudehookstc-stop.cmd` — every separator
 *   eaten — so every hook fails with "command not found" and capture silently
 *   records nothing. Forward slashes are the only form that survives, and
 *   Windows accepts them.
 *
 *   A STRING WITH NO SLASH IS A COMMAND NAME. Quoting alone does not fix it:
 *   bash only treats an argument as a path if it contains `/`, so a quoted
 *   backslash path is looked up in PATH instead of opened. Both halves are
 *   needed, which is why this does not simply add quotes.
 *
 * The quotes are for paths containing spaces (`C:\Users\John Smith` is
 * ordinary, and `/Users/John Smith` equally so), which is why POSIX gets them
 * too — an unquoted path with a space split into two arguments on every
 * platform. Residual, stated rather than hidden: a `$` in the path still
 * expands inside double quotes. Single quotes would stop that and break cmd,
 * and `$` in a Windows profile name is rare enough to be the better trade.
 */
/**
 * Which shell will run our hooks on this machine.
 *
 * Claude Code's own rule (docs: hooks): `sh -c` on macOS and Linux, Git Bash
 * on Windows, PowerShell on Windows when Git Bash is not installed. We mirror
 * that detection so the command form we write matches the shell that will
 * read it, and we ALSO write the `shell` field so the pairing does not rest
 * on two independent detections agreeing forever.
 *
 * `bash.exe` in System32 is deliberately not accepted: that is the WSL
 * launcher, not Git Bash. Treating it as Git Bash would write bash-form
 * commands for a machine whose Claude Code falls back to PowerShell — the
 * exact mismatch this function exists to prevent.
 */
export function hookShellFor(platform: NodeJS.Platform = process.platform): HookShell {
  if (platform !== 'win32') return 'bash'
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  if (candidates.some(p => p && existsSync(p))) return 'bash'
  try {
    const found = execFileSync('where', ['bash.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const real = found.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(p => !/\\System32\\/i.test(p) && !/\\SysWOW64\\/i.test(p))
    if (real.length > 0) return 'bash'
  } catch { /* `where` found nothing, or is unavailable */ }
  return 'powershell'
}

/**
 * A hook path as Claude Code's settings.json should carry it, in the form the
 * shell that will run it actually understands.
 *
 * There is no single string that works everywhere, which is why this takes
 * the shell rather than guessing:
 *
 *   BASH (macOS, Linux, and Windows with Git Bash). Backslashes are escapes,
 *   so a bare `C:\Users\user\...` arrives as `C:Usersuser...` and the hook
 *   silently never runs — the defect 0.0.13-beta was cut for. Quoting alone
 *   does not fix it either: quoted, the backslashes survive but leave a
 *   string containing no `/`, which bash resolves as a command NAME against
 *   PATH instead of opening as a file. Forward slashes AND quotes are both
 *   required. Windows accepts forward slashes, and this form is valid in cmd
 *   too, which costs nothing and covers any host that ever uses it.
 *
 *   POWERSHELL (Windows without Git Bash). A quoted string is an EXPRESSION,
 *   not an invocation: PowerShell evaluates `"C:\...\tc-stop.cmd"`, prints
 *   it, and runs nothing. It needs the call operator. Backslashes are safe
 *   here — PowerShell escapes with a backtick, not a backslash — so this
 *   keeps native separators rather than inventing a second dialect.
 *
 * Both forms quote, because `C:\Users\John Smith` and `/Users/John Smith`
 * are ordinary and an unquoted path with a space splits into two arguments
 * on every shell here.
 */
export function claudeHookCommand(scriptPath: string, shell: HookShell = hookShellFor()): string {
  if (shell === 'powershell') return `& "${scriptPath}"`
  return `"${scriptPath.replace(/\\/g, '/')}"`
}

/**
 * A Claude Code hook command as install writes it (D251): on POSIX the
 * quoted wrapper path behind `exec`, so the `/bin/sh -c` Claude Code runs
 * every hook through REPLACES itself with the wrapper, which in turn
 * execs node. Without it dash (Debian's and Ubuntu's /bin/sh) forks, the
 * hook's `process.ppid` is a short-lived sh rather than claude, and every
 * pid-keyed join — the session beacon of rung 1, the /clear predecessor
 * of D216, the hook's namespace annotation — misses (live probe,
 * 2026-10-08). Windows keeps the plain forms: its `.cmd` wrappers cannot
 * exec, and the session-keyed channels carry identity there.
 */
export function claudeHookDispatch(
  scriptPath: string, shell: HookShell = hookShellFor(), platform: NodeJS.Platform = process.platform,
): string {
  const cmd = claudeHookCommand(scriptPath, shell)
  return platform === 'win32' ? cmd : `exec ${cmd}`
}

/** A bash-form hook command with the leading `exec ` of D251 removed — the
 *  one place every reader of a written command strips it. */
export function withoutExec(command: string): string {
  return command.replace(/^\s*exec\s+/, '')
}

/** The treecontext hook commands of a Claude-format settings object that
 *  run without `exec` on a POSIX host — each one leaves an sh between
 *  claude and the hook, so session identity by pid is lost (D251). */
export function claudeHookCommandsWithoutExec(
  settings: Record<string, unknown>, platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return []
  const hooks = (settings['hooks'] ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: unknown; shell?: unknown }> }> | undefined>
  const out: string[] = []
  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue
    for (const m of matchers) {
      for (const h of m?.hooks ?? []) {
        const c = h?.command
        // Ownership as uninstall reads it: the command runs one of our own
        // scripts by its exact name, never a substring a foreign hook shares.
        if (typeof c !== 'string' || !runsOwnHookScript(c, CLAUDE_SCRIPT_NAMES)) continue
        if (!/^\s*exec\s/.test(c)) out.push(c)
      }
    }
  }
  return out
}

/**
 * Grade a hook wrapper script BODY for the failure classes that have
 * actually shipped, in whichever dialect the body is written — dialect
 * is read from the body, never from process.platform, so the grader
 * can judge a .cmd found on disk regardless of where doctor runs.
 *
 * Only INTERPRETER WRAPPERS are graded: a managed script that invokes
 * nothing (the session reminder echoes text and exits) has no
 * interpreter to be wrong about, and calling it a "legacy wrapper" put
 * every healthy Windows install in an unclearable warn loop
 * (fifth-pass review, finding 1).
 *
 * Classes, both dialects: the legacy shapes that shipped silent-capture
 * breakage (the pre-0.0.15 pinned-only .cmd of 0.0.13/0.0.14; the
 * bare-`node` POSIX wrapper), and a pinned verified interpreter that no
 * longer exists — capture survives on the resolution chain, but what
 * runs is no longer what install proved could load the native binding.
 * The pins are parsed by launcherInterpreter and launcherCliPath, the
 * battle-tested readers for both dialects, and their existence is probed
 * only when the pin's path style matches the host (judging C:\ paths from
 * POSIX would report every cross-host body as vanished).
 *
 * Returns the human-readable problem, or null for a healthy body.
 */
export function hookScriptIssue(body: string): string | null {
  const isCmd = body.startsWith('@echo off')
  const invokesCli = isCmd
    ? body.includes('"%TC_NODE%"') || /"[^"]+" hook /.test(body)
    : /(?:^|\n)(?:TREECONTEXT_DEBUG=1 )?(?:exec )?(?:"\$TC_NODE"|node) "/.test(body)
  if (!invokesCli) return null

  if (isCmd && !body.includes('TC_NODE')) {
    return 'legacy Windows wrapper — pinned interpreter, no fallback chain; a node upgrade strands every capture hook silently'
  }
  if (!isCmd && /(?:^|\r?\n)(?:TREECONTEXT_DEBUG=1 )?(?:exec )?node "/.test(body)) {
    return "legacy wrapper invokes bare 'node' (PATH-dependent — fails for GUI-launched agents)"
  }

  const pinned = launcherInterpreter(body)
  if (pinned && hostStylePinMissing(pinned)) {
    return `pinned interpreter no longer exists (${pinned}) — hooks fall back to unverified PATH node`
  }

  // The MODULE, against the same hazard: a global install's cli.js path is
  // version-stamped, and the next version-manager upgrade deletes the
  // directory under it.
  //
  // A dead pin in a body with NO TC_CLI fallback is dead outright: the MCP
  // server exits MODULE_NOT_FOUND and the hooks report nothing whatsoever,
  // having redirected stderr and exited 0. That silence is why this class
  // needs a grader at all. A body WITH the fallback is cleared only when the
  // search would actually land somewhere — machinery is not recovery, and a
  // layout outside the managed globs (volta, asdf, a moved repo checkout)
  // leaves the chain empty-handed and the wrapper dying exactly as before
  // the fallback existed. When the search does land, that is the healthy
  // case by design: unlike an unpinned interpreter there is no
  // native-binding question to report about which copy of the same package
  // it finds, so warning there would be noise.
  const pinnedCli = launcherCliPath(body)
  if (pinnedCli && hostStylePinMissing(pinnedCli)) {
    if (!body.includes('TC_CLI=')) {
      return `pinned cli.js no longer exists (${pinnedCli}) and this wrapper has no fallback — the MCP server dies with MODULE_NOT_FOUND and the hooks fail silently; reinstall`
    }
    if (!moduleFallbackExists(body)) {
      return `pinned cli.js no longer exists (${pinnedCli}) and no fallback copy was found in a managed layout — the wrapper's search comes up empty and hooks fail silently; reinstall`
    }
  }
  return null
}

/**
 * True when `p` is a pin this host can meaningfully probe AND the probe says
 * it is gone. Path style is read from the pin itself — drive-letter and UNC
 * spellings are both Windows paths (the install harness's batch patterns
 * accept both, so both are legitimate installer output) — and only
 * host-style pins are probed: judging C:\ or \\server paths from POSIX
 * would report every cross-host body as vanished. A missing `.js` pin whose
 * `.ts` twin exists counts as present, the same twin rule the BDD oracle
 * applies to TS-source runs of the installer.
 */
function hostStylePinMissing(p: string): boolean {
  const winStyle = /^[A-Za-z]:[\\/]|^\\\\/.test(p)
  if (winStyle !== (process.platform === 'win32')) return false
  return !entryPointPresent(p)
}

/** The twin rule on its own: a `.js` entry point whose `.ts` twin exists is present. */
function entryPointPresent(p: string): boolean {
  return existsSync(p) || (p.endsWith('.js') && existsSync(`${p.slice(0, -3)}.ts`))
}

/**
 * Would a wrapper body's TC_CLI fallback search actually land on a file?
 *
 * The package-relative module path is read from the body's own search list
 * (`node_modules/<package>/<rel>` appears in every generated fallback, both
 * dialects, under `treecontext-mcp` and, for old installs, `treecontext`),
 * then probed across the same managed layouts the snippets search, under
 * exactly the package names the body's own search names — no wider, or a
 * pre-rename wrapper would read as healthy beside a copy it cannot find. A
 * body whose rel cannot be read is cleared rather than flagged — a
 * hand-rolled or future-shape wrapper should degrade to "not judged", never
 * to a false "reinstall". A body that IS read and finds no copy under either
 * name is false: the wrapper dies.
 */
function moduleFallbackExists(body: string): boolean {
  const rel = searchedModuleRel(body)
  if (!rel) return true
  const relParts = rel.split('/')
  const candidates: string[] = []
  for (const name of searchedPackageDirs(body)) {
    for (const manager of MANAGED_VERSION_MANAGERS) {
      const root = join(homedir(), ...manager.dir)
      for (const v of managedVersions(root)) {
        for (const inner of MANAGED_INNERS) {
          candidates.push(join(root, v, ...inner, 'lib', 'node_modules', name, ...relParts))
        }
      }
    }
    for (const r of MANAGED_POSIX_ROOTS) candidates.push(join(r, name, ...relParts))
    for (const prefix of MANAGED_WINDOWS_PREFIXES) {
      const base = process.env[prefix.env]
      if (base) candidates.push(join(base, ...prefix.sub, 'node_modules', name, ...relParts))
    }
  }
  return candidates.some(c => existsSync(c))
}

/**
 * Owned hook commands in a settings file that the shell running them will not
 * resolve, each with the reason.
 *
 * Doctor used to grade hooks by whether the SCRIPT FILE existed. That is a
 * different question from whether the COMMAND runs, and the gap shipped: on
 * Windows every script was present and every hook was dead, because the
 * command carried backslashes and bash ate them — while doctor reported
 * "hooks installed" throughout.
 *
 * The tempting check — does the command's path exist? — does NOT catch it.
 * `C:\Users\user\.claude\hooks\tc-stop.cmd` is a perfectly good Windows path
 * and `existsSync` says so; it only becomes `C:Usersuser...` once a shell
 * interprets it. The property that actually distinguishes a runnable command
 * is textual, so that is what this grades.
 */
export function unrunnableHookCommands(
  settingsPath: string,
): Array<{ command: string; reason: string }> {
  if (!existsSync(settingsPath)) return []
  const data = readJsonSafe(settingsPath)
  const hooks = (data.hooks ?? {}) as Record<
    string, Array<{ hooks?: Array<{ command?: unknown; shell?: unknown }> }>
  >
  const out: Array<{ command: string; reason: string }> = []
  // What will actually read these commands if the entry does not say.
  const ambientShell = hookShellFor()

  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue
    for (const matcher of matchers) {
      for (const entry of matcher?.hooks ?? []) {
        const command = entry?.command
        if (typeof command !== 'string' || !command.includes(TC_HOOK_PREFIX)) continue
        const shell: HookShell = entry?.shell === 'powershell' ? 'powershell'
          : entry?.shell === 'bash' ? 'bash'
          : ambientShell

        // The pinned interpreter has to still exist. Installing with Git
        // Bash present and removing it later leaves every command written
        // for a shell that is gone — nothing about the command itself looks
        // wrong, which is why it needs saying out loud.
        if (entry?.shell === 'bash' && ambientShell !== 'bash') {
          out.push({ command, reason: 'pinned to Git Bash, which is no longer installed' })
          continue
        }

        // Grading is per-shell, because the shells disagree about what a
        // runnable command even looks like. "No backslashes" was never a
        // universal rule — it is bash's rule, and applying it to a
        // PowerShell command would condemn the only form that works there.
        if (shell === 'powershell') {
          if (!command.startsWith('& ')) {
            out.push({ command, reason: 'PowerShell needs the call operator — a quoted path alone is just a string' })
            continue
          }
        } else if (command.includes('\\')) {
          // Bare: bash eats each backslash as an escape. Quoted: they
          // survive, but leave a string with no `/`, which bash resolves as
          // a command NAME against PATH rather than opening as a path.
          out.push({ command, reason: 'backslash path — the shell running hooks eats it' })
          continue
        }

        const body = shell === 'powershell' ? command.slice(2) : withoutExec(command)
        const quoted = /^"(.*)"$/.exec(body)
        const target = quoted?.[1] ?? body
        if (!quoted && /\s/.test(body)) {
          out.push({ command, reason: 'unquoted path containing a space — the shell splits it' })
          continue
        }
        if (!existsSync(target)) {
          out.push({ command, reason: 'names a script that is not there' })
        }
      }
    }
  }
  return out
}

/** The SessionStart matchers among clear and resume whose hooks do not
 *  run treecontext's session-start (the pre-beta.1 wiring). */
export function claudeSessionStartUnwired(settings: Record<string, unknown>): string[] {
  const hooks = (settings['hooks'] ?? {}) as Record<string, ClaudeHookMatcher[] | undefined>
  const matchers = Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []
  return ['clear', 'resume'].filter((m) => !matchers.some((e) => e.matcher === m
    && Array.isArray(e.hooks) && e.hooks.some((h) => typeof h.command === 'string' && h.command.includes(`${TC_HOOK_PREFIX}session-start`))))
}

/**
 * Merge treecontext's hook entries into a Claude-format hooks map, in place,
 * and return it: foreign entries kept, owned ones rewritten to this build's
 * form. ONE definition of "the Claude Code block", shared by the Claude
 * settings writer, the copies written into Codex CLI and Gemini CLI, and
 * doctor's consistency check against them (D154, D161) — so the block a
 * copy is graded against is the one install would write today, never a
 * stored snapshot of it.
 */
function applyClaudeHookBlock(hooks: Record<string, ClaudeHookMatcher[]>): Record<string, ClaudeHookMatcher[]> {
  const hooksDir = join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)
  const ext = process.platform === 'win32' ? '.cmd' : ''
  // One detection per install, shared by every hook entry and by the `shell`
  // field written beside it, so the whole file cannot end up half-bash.
  const hookShell = hookShellFor()
  const hookCmd = (name: string): string =>
    claudeHookDispatch(join(hooksDir, `${TC_HOOK_PREFIX}${name}${ext}`), hookShell)
  const reminderCmd = hookCmd('session-reminder')
  const sessionStartCmd = hookCmd('session-start')
  const preCompactCmd = hookCmd('pre-compact')
  const postToolUseCmd = hookCmd('post-tool-use')
  const userPromptSubmitCmd = hookCmd('user-prompt-submit')
  const stopCmd = hookCmd('stop')
  const subagentStartCmd = hookCmd('subagent-start')
  const subagentStopCmd = hookCmd('subagent-stop')

  const ownedPrefixes = [TC_HOOK_PREFIX, ...LEGACY_HOOK_PREFIXES]
  const isOwned = (cmd: string) => ownedPrefixes.some(p => cmd.includes(p))

  function ensureHookEntries(
    matchers: ClaudeHookMatcher[], matcherStr: string | undefined, commands: string[],
  ): ClaudeHookMatcher[] {
    let entry = matchers.find(m => m.matcher === matcherStr)
    if (!entry) {
      entry = matcherStr !== undefined
        ? { matcher: matcherStr, hooks: [] }
        : { hooks: [] } as ClaudeHookMatcher
      matchers.push(entry)
    }
    entry.hooks = entry.hooks.filter(h => !isOwned(h.command))
    for (const cmd of commands) {
      // The `shell` field is written on Windows only, and it is what keeps
      // the command form and its interpreter pinned together. Without it the
      // pairing rests on our Git-Bash detection agreeing with Claude Code's
      // forever — and a PowerShell-form command read by bash (or the
      // reverse) is a hook that silently never runs. On POSIX there is one
      // shell and nothing to disambiguate, so the key stays absent.
      entry.hooks.push(
        process.platform === 'win32'
          ? { type: 'command', command: cmd, shell: hookShell }
          : { type: 'command', command: cmd },
      )
    }
    return matchers
  }

  // Strip legacy hooks from all event types (e.g. cbm-* in PreToolUse)
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of matchers) {
      matcher.hooks = matcher.hooks.filter(h => !LEGACY_HOOK_PREFIXES.some(p => h.command.includes(p)))
    }
    hooks[event] = matchers.filter(m => m.hooks.length > 0)
    if (hooks[event]!.length === 0) delete hooks[event]
  }

  // SessionStart hooks: orientation reminder + session snapshot recovery
  const sessionStart = hooks.SessionStart ?? []
  ensureHookEntries(sessionStart, 'startup', [reminderCmd, sessionStartCmd])
  // Every start carries the capture sign (D171), and a /clear carries the
  // re-orientation packet (D187) — so session-start runs on all four.
  ensureHookEntries(sessionStart, 'resume', [reminderCmd, sessionStartCmd])
  ensureHookEntries(sessionStart, 'clear', [reminderCmd, sessionStartCmd])
  ensureHookEntries(sessionStart, 'compact', [reminderCmd, sessionStartCmd])
  hooks.SessionStart = sessionStart

  // PreCompact hook: checkpoint working memory before compaction
  const preCompact = hooks.PreCompact ?? []
  ensureHookEntries(preCompact, undefined, [preCompactCmd])
  hooks.PreCompact = preCompact

  // PostToolUse hook: captures tool inputs/outputs into staging table
  const postToolUse = hooks.PostToolUse ?? []
  ensureHookEntries(postToolUse, undefined, [postToolUseCmd])
  hooks.PostToolUse = postToolUse

  // UserPromptSubmit hook: captures user messages into staging table
  const userPromptSubmit = hooks.UserPromptSubmit ?? []
  ensureHookEntries(userPromptSubmit, undefined, [userPromptSubmitCmd])
  hooks.UserPromptSubmit = userPromptSubmit

  // Stop hook (C4): captures the assistant's final response of a turn
  const stop = hooks.Stop ?? []
  ensureHookEntries(stop, undefined, [stopCmd])
  hooks.Stop = stop

  // SubagentStart / SubagentStop (D190, D147): register a live subagent
  // under the session it shares with its orchestrator, then retire it and
  // capture its report as the subagent's summary. The server stamps every
  // tool-written row from that registration.
  const subagentStart = hooks.SubagentStart ?? []
  ensureHookEntries(subagentStart, undefined, [subagentStartCmd])
  hooks.SubagentStart = subagentStart
  const subagentStop = hooks.SubagentStop ?? []
  ensureHookEntries(subagentStop, undefined, [subagentStopCmd])
  hooks.SubagentStop = subagentStop

  return hooks
}

/** What each Claude Code hook event install registers is for — the
 *  install summary's gloss. An event without one is still listed. */
const CLAUDE_HOOK_PURPOSE: Readonly<Record<string, string>> = {
  SessionStart: 'orientation + snapshot',
  PreCompact: 'checkpoint before compaction',
  PostToolUse: 'conversation capture',
  UserPromptSubmit: 'conversation capture',
  Stop: 'assistant response capture',
  SubagentStart: 'subagent registration',
  SubagentStop: 'subagent report capture',
}

/** The install summary's hook lines, one per event of the block install
 *  writes, read from that block itself (D250). */
export function claudeHookSummaryLines(): string[] {
  return Object.keys(claudeHooksBlock()).map((event) => {
    const purpose = CLAUDE_HOOK_PURPOSE[event]
    return `  hooks: ${event}${purpose ? ` (${purpose})` : ''}`
  })
}

/**
 * The Claude Code hooks block exactly as install writes it into an empty
 * settings file today: treecontext's own entries and nothing else.
 */
export function claudeHooksBlock(): Record<string, ClaudeHookMatcher[]> {
  return applyClaudeHookBlock({})
}

export function upsertClaudeSettingsHooks(path: string, dryRun: boolean): ActionResult {
  const data = readJsonSafe(path)
  data.hooks = applyClaudeHookBlock((data.hooks ?? {}) as Record<string, ClaudeHookMatcher[]>)

  if (dryRun) return { type: 'hook-settings', path, status: 'dry-run' }
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status: 'updated' }
}

export function removeClaudeSettingsHooks(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  const data = readJsonSafe(path)
  const hooks = (data.hooks ?? {}) as Record<string, ClaudeHookMatcher[]>
  let changed = false

  const ownedPrefixes = [TC_HOOK_PREFIX, ...LEGACY_HOOK_PREFIXES]
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of matchers) {
      const before = matcher.hooks.length
      matcher.hooks = matcher.hooks.filter(h => !ownedPrefixes.some(p => h.command.includes(p)))
      if (matcher.hooks.length < before) changed = true
    }
    hooks[event] = matchers.filter(m => m.hooks.length > 0)
    if (hooks[event]!.length === 0) delete hooks[event]
  }
  if (!changed) return null
  data.hooks = hooks
  if (!dryRun) atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed tc hooks' }
}

/**
 * Command string invoking an agent hook wrapper. The wrapper resolves its
 * own interpreter and module at runtime, so the command carries ONE token —
 * the stable wrapper path — where it used to carry `"<execPath>" "<entry>"`,
 * two version-stamped halves a node upgrade strands together. The bash-form
 * spelling (quoted, forward slashes on Windows) comes from claudeHookCommand
 * so the shell-hazard rule keeps one definition; these runners are opt-in
 * (`--experimental-capture`), and forward slashes are the one spelling every
 * shell here opens as a file.
 */
function wrapperCommandString(agent: AgentHookAgent, stem: string): string {
  return claudeHookCommand(agentHookWrapperPath(agent, stem), 'bash')
}

// ── Copies of the Claude Code block: Codex CLI verbatim, Gemini CLI translated ──
//
// The two copying clients keep their own hook configuration rather than
// reading the Claude settings file, so capture reaches them only through a
// copy of the Claude Code block (D154, D161), written behind
// --experimental-capture (D208). The copy is the block itself — the same
// entries running the same ~/.claude/hooks/tc-* scripts — verbatim for Codex
// CLI, whose documented contract is Claude Code's, and translated for Gemini
// CLI, whose events are renamed (survey of official documentation,
// 2026-10-05; D153). Doctor grades a copy against what these functions would
// write today, so the remedy it names is the command that produces exactly
// what it grades as consistent.

/**
 * Gemini CLI's name for each Claude Code hook event: same stdin/stdout
 * shapes, renamed events, no subagent events. An event with no Gemini
 * counterpart (null, or absent from this table) is left out of the
 * translated copy.
 */
export const GEMINI_EVENT_FOR: Readonly<Record<string, string | null>> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  UserPromptSubmit: 'BeforeAgent',
  PreToolUse: 'BeforeTool',
  PostToolUse: 'AfterTool',
  PreCompact: 'PreCompress',
  // Gemini's AfterAgent is not Claude's Stop: its payload carries
  // prompt_response and stop_hook_active, its transcript is another JSON,
  // and a `deny` decision forces a retry — the stop hook's bookmark ask
  // (`decision: "block"`) would be a forced-retry hazard there. Left out
  // until a live probe shows otherwise (D225).
  Stop: null,
  SubagentStart: null,
  SubagentStop: null,
}

/**
 * A Claude-format hooks block in Gemini CLI's event names. Claude's Windows
 * `shell` field is dropped: Gemini's hook entry has no such key (its
 * documented fields are type, command, name, timeout, description).
 */
export function translateHookBlockForGemini(
  block: Record<string, ClaudeHookMatcher[]>,
): Record<string, ClaudeHookMatcher[]> {
  const out: Record<string, ClaudeHookMatcher[]> = {}
  for (const [event, matchers] of Object.entries(block)) {
    const renamed = GEMINI_EVENT_FOR[event]
    if (!renamed) continue
    const copied = structuredClone(matchers).map(m => ({
      ...m,
      hooks: m.hooks.map(({ shell: _shell, ...rest }) => rest),
    }))
    out[renamed] = [...(out[renamed] ?? []), ...copied]
  }
  return out
}

/**
 * What marks a hook command in a copying client's configuration as
 * treecontext's, and nothing else: a Claude Code hook script or an earlier
 * build's per-agent wrapper IN treecontext's own hooks directory
 * (`<home>/.claude/hooks/tc-<known stem>`), an earlier build's adapter entry
 * point (`hooks/codex|gemini/<known stem>.js`), or the `treecontext hook
 * <event>` subcommand. ONE predicate, shared by the copy writer, the remover
 * and doctor's consistency check. Never a bare `/hooks/tc-`: that claimed a
 * user's `<project>/.git/hooks/tc-notify.sh`, and the rewrite deleted it.
 * Never the bare substring 'hook ' either: it once claimed `my-tool hook
 * sync`.
 */
function normalizeHookPath(p: string): string {
  const slashed = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

const LEGACY_COPY_ENTRY_RE = new RegExp(
  `(?:^|[/"'\\s])hooks/(?:codex|gemini)/(?:${[...new Set([...AGENT_HOOK_WRAPPER_STEMS.codex, ...AGENT_HOOK_WRAPPER_STEMS.gemini])].join('|')})\\.js\\b`,
)
const TC_SUBCOMMAND_RE = new RegExp(
  `(?:\\btreecontext|cli\\.js"?)\\s+hook\\s+(?:${CLAUDE_HOOK_SCRIPTS.join('|')})\\b`,
)

/** Does `cmd` run one of the named scripts in treecontext's own hooks directory? */
function runsOwnHookScript(cmd: string, names: readonly string[]): boolean {
  const c = normalizeHookPath(cmd)
  const dir = normalizeHookPath(join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)) + '/'
  return names.some(n => new RegExp(`${escapeRegex(dir + n)}(?:\\.cmd)?(?![\\w.-])`).test(c))
}

const CLAUDE_SCRIPT_NAMES = CLAUDE_HOOK_SCRIPTS.map(n => `${TC_HOOK_PREFIX}${n}`)
const LEGACY_WRAPPER_NAMES = (['codex', 'gemini'] as const)
  .flatMap(a => AGENT_HOOK_WRAPPER_STEMS[a].map(st => `${TC_HOOK_PREFIX}${a}-${st}`))

function copyOwnedCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  if (runsOwnHookScript(cmd, [...CLAUDE_SCRIPT_NAMES, ...LEGACY_WRAPPER_NAMES])) return true
  return LEGACY_COPY_ENTRY_RE.test(normalizeHookPath(cmd)) || TC_SUBCOMMAND_RE.test(cmd)
}

type LooseMatcher = { matcher?: unknown; hooks?: Array<{ command?: unknown } & Record<string, unknown>> }

/**
 * Take treecontext's entries out of a hooks map, in place. Only the matcher
 * entries THIS pass emptied are dropped — a foreign `{"matcher":"git",
 * "hooks":[]}`, or one carrying no hooks key at all, is the user's and
 * survives — and only the events this pass emptied are deleted.
 */
function stripOwnedHooks(hooks: Record<string, unknown>): boolean {
  let changed = false
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue
    const emptied = new Set<unknown>()
    for (const m of arr as LooseMatcher[]) {
      if (!m || typeof m !== 'object' || !Array.isArray(m.hooks)) continue
      const before = m.hooks.length
      m.hooks = m.hooks.filter(h => !copyOwnedCommand(h?.command))
      if (m.hooks.length < before) {
        changed = true
        if (m.hooks.length === 0) emptied.add(m)
      }
    }
    if (emptied.size === 0) continue
    const kept = arr.filter(m => !emptied.has(m))
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return changed
}

/** Replace treecontext's entries in a hooks map with `block`, keeping the rest. */
function writeHookCopy(hooks: Record<string, unknown>, block: Record<string, ClaudeHookMatcher[]>): void {
  stripOwnedHooks(hooks)
  for (const [event, matchers] of Object.entries(block)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []
    hooks[event] = [...existing, ...structuredClone(matchers)]
  }
}

/** JSON with object keys sorted, so two equal entries always print alike. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * treecontext's part of a hooks map, per event, in a form two maps can be
 * compared by: each matcher entry reduced to its matcher (absent and empty
 * read alike, since both match everything) and its owned hook entries in
 * order. Foreign hooks — whether in their own entries or sharing one with
 * ours — are not part of the copy and do not count against it. Matcher
 * entries are sorted, so the order a hand-copy lists them in is not drift.
 */
export function ownedHookView(hooks: unknown): Record<string, string[]> {
  const view: Record<string, string[]> = {}
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return view
  for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue
    const keys: string[] = []
    for (const m of arr as LooseMatcher[]) {
      if (!m || typeof m !== 'object' || !Array.isArray(m.hooks)) continue
      const owned = m.hooks.filter(h => h && copyOwnedCommand(h.command))
      if (owned.length === 0) continue
      const matcher = typeof m.matcher === 'string' && m.matcher !== '' ? m.matcher : null
      keys.push(canonicalJson([matcher, owned]))
    }
    if (keys.length > 0) view[event] = keys.sort()
  }
  return view
}

/** The events on which two owned views differ, in the expected block's order first. */
export function hookViewDifferences(actual: Record<string, string[]>, expected: Record<string, string[]>): string[] {
  const events = [...Object.keys(expected), ...Object.keys(actual).filter(e => !(e in expected))]
  return events.filter(e => JSON.stringify(actual[e] ?? []) !== JSON.stringify(expected[e] ?? []))
}

/** The block a copying client's configuration should hold today. */
export function expectedHookCopy(slug: string): Record<string, ClaudeHookMatcher[]> {
  const block = claudeHooksBlock()
  return slug === 'gemini' ? translateHookBlockForGemini(block) : block
}

/**
 * Write Gemini CLI's translated copy of the Claude Code block into its
 * settings.json `hooks`, beside its MCP registration and the user's own
 * hooks. Every treecontext entry already there, in any spelling an earlier
 * build wrote, is replaced, so the copy converges on today's block and the
 * same command that copies the hooks also rewrites a drifted copy.
 */
export function upsertGeminiHooks(path: string, dryRun: boolean): ActionResult {
  const data = readJsonSafe(path)
  const before = canonicalJson(data)
  const hooks = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>
  writeHookCopy(hooks, expectedHookCopy('gemini'))
  data.hooks = hooks
  if (existsSync(path) && canonicalJson(data) === before) {
    return { type: 'hook-settings', path, status: 'skipped', detail: 'already configured' }
  }
  if (dryRun) return { type: 'hook-settings', path, status: 'dry-run' }
  const status = existsSync(path) ? 'updated' : 'created'
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status }
}

export function removeGeminiHooks(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  const data = readJsonSafe(path)
  const hooks = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>
  if (!stripOwnedHooks(hooks)) return null
  data.hooks = hooks
  if (!dryRun) atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

// ── VS Code Copilot hooks (.github/hooks/ or ~/.copilot/hooks/) ────

/**
 * Copilot's event vocabulary, paired with the wrapper stem each event
 * dispatches to. ONE table: doctor graded this config against the
 * PascalCase Claude Code spellings (SessionStart/UserPromptSubmit/…) while
 * the builder wrote camelCase, so a perfectly healthy vscode install always
 * read as 'hooks incomplete' and the offered reinstall changed nothing.
 */
const VSCODE_HOOK_EVENTS = {
  sessionStart: 'session-start',
  userPromptSubmitted: 'user-prompt-submit',
  postToolUse: 'post-tool-use',
  agentStop: 'stop',
  preCompact: 'pre-compact',
} as const

/**
 * Does a Copilot hooks file carry every event the builder writes? Doctor's
 * completeness grade, exported so the test that closes the drift can put a
 * freshly-built config in front of the grader that reads it.
 */
export function vscodeHooksComplete(data: Record<string, unknown>): boolean {
  const hooks = (data.hooks ?? {}) as Record<string, unknown>
  return Object.keys(VSCODE_HOOK_EVENTS)
    .every(e => Array.isArray(hooks[e]) && (hooks[e] as unknown[]).length > 0)
}

/**
 * Build the GitHub Copilot hooks config, written to
 * `~/.copilot/hooks/treecontext.json` (user-level, applies to every
 * workspace).
 *
 * Three things about this file are load-bearing, and the previous version
 * got all three wrong:
 *
 *  1. `version: 1` is required. Without it the file is not a valid hook
 *     config and is ignored — silently.
 *  2. The timeout key is `timeoutSec`, not `timeout`.
 *  3. The command is given as SEPARATE `bash` and `powershell` fields,
 *     not one `command` string. Emitting only `command` left Windows with
 *     nothing runnable at all.
 *
 * Event names use Copilot's camelCase vocabulary. `agentStop` is what
 * gives Copilot assistant-turn capture, which the previous config never
 * registered.
 */
export function buildVscodeHooksConfig(): Record<string, unknown> {
  // Both shells invoke the same wrapper. Quoting differs: POSIX shells take
  // the forward-slash "..." form and PowerShell needs the call operator for
  // a quoted path — claudeHookCommand is the one definition of both rules.
  const entry = (stem: string): { type: string; bash: string; powershell: string; timeoutSec: number } => {
    const wrapper = agentHookWrapperPath('vscode', stem)
    return {
      type: 'command',
      bash: claudeHookCommand(wrapper, 'bash'),
      powershell: claudeHookCommand(wrapper, 'powershell'),
      timeoutSec: 10,
    }
  }

  return {
    version: 1,
    hooks: Object.fromEntries(
      Object.entries(VSCODE_HOOK_EVENTS).map(([event, stem]) => [event, [entry(stem)]]),
    ),
  }
}

export function upsertVscodeHooks(path: string, force: boolean, dryRun: boolean): ActionResult {
  const config = buildVscodeHooksConfig()
  // Skip only when content already matches — a presence-only check would
  // strand legacy bare-`node` configs (PATH-dependent, broken for
  // GUI-launched agents) until the user thinks to pass --force.
  if (existsSync(path) && !force) {
    const existing = readJsonSafe(path)
    if (JSON.stringify(existing) === JSON.stringify(config)) {
      return { type: 'hook-settings', path, status: 'skipped', detail: 'already configured' }
    }
  }

  const status = existsSync(path) ? 'updated' : 'created'

  if (dryRun) return { type: 'hook-settings', path, status: 'dry-run' }
  atomicWrite(path, JSON.stringify(config, null, 2) + '\n')
  return { type: 'hook-settings', path, status }
}

/**
 * Strip one agent's OWN entries from a hooks-map config, deleting the file
 * only when nothing foreign is left in it.
 *
 * Shared by the cursor and Copilot removers because they share a shape
 * (`{ version, hooks: { <event>: [entry, …] } }`) and shared a mistake: both
 * unlinked the whole file. For cursor that destroyed data the install side
 * deliberately preserves — upsertCursorHooks MERGES so foreign hooks survive,
 * with a test asserting exactly that, and then uninstall deleted them anyway.
 * The Copilot file is treecontext's alone in practice, so it gets the same
 * shape not because it is failing today but so a hand-added entry there is
 * never collateral tomorrow.
 *
 * Ownership is the marker pair the other removers use — the generated wrapper
 * name and the entry-point directory — read through collectCommandStrings, so
 * a Copilot entry's `bash`/`powershell` spelling is judged along with
 * `command`.
 */
function removeOwnedHooksMap(
  path: string, agent: AgentHookAgent, dryRun: boolean,
): ActionResult | null {
  if (!existsSync(path)) return null
  const data = readJsonSafe(path)
  const hooks = (data.hooks ?? {}) as Record<string, unknown>
  // Slashes normalized before matching: claudeHookCommand spells paths with
  // forward slashes even on Windows, but a config written by an OLD build (or
  // by hand) carries native backslashes — `dist\hooks\vscode\...` — and the
  // windows-latest lane proved the forward-slash marker looks straight past
  // it, leaving the file for doctor to flag forever after its own fix ran.
  const owned = (entry: unknown): boolean => collectCommandStrings(entry)
    .map(c => c.replace(/\\/g, '/'))
    .some(c => c.includes(`${TC_HOOK_PREFIX}${agent}-`) || c.includes(`hooks/${agent}/`))

  let changed = false
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    const kept = entries.filter(e => !owned(e))
    if (kept.length === entries.length) continue
    changed = true
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  if (!changed) return null

  // Nothing left but our own scaffolding (an emptied hooks map, the schema's
  // `version`): the file is ours alone, so take it rather than leave a husk
  // the agent will keep reading.
  const foreignKeys = Object.keys(data).filter(k => k !== 'hooks' && k !== 'version')
  const emptied = Object.keys(hooks).length === 0 && foreignKeys.length === 0
  if (!dryRun) {
    if (emptied) {
      unlinkSync(path)
    } else {
      data.hooks = hooks
      atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
    }
  }
  return { type: 'hook-settings', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

export function removeVscodeHooks(path: string, dryRun: boolean): ActionResult | null {
  return removeOwnedHooksMap(path, 'vscode', dryRun)
}

// ── Codex CLI hooks (~/.codex/hooks.json) ─────────────────────────

/** Keys of a Codex hooks.json that are not hook events. */
const CODEX_NON_EVENT_KEYS = new Set(['hooks', 'mcpServers', 'servers', 'mcp_servers'])

/**
 * Write Codex CLI's verbatim copy of the Claude Code block into hooks.json
 * under `hooks`, the shape of Claude Code's own settings file. Builds before
 * the copy wrote per-agent wrapper entries at the TOP level of this file;
 * those are taken out here, so one run converges any earlier install on
 * today's copy. Foreign keys and foreign hooks are kept. `force` is
 * accepted for the install flow's uniform call and changes nothing: the
 * copy is always rewritten when it differs.
 */
export function upsertCodexHooks(path: string, _force: boolean, dryRun: boolean): ActionResult {
  const data = readJsonSafe(path)
  const before = canonicalJson(data)
  const legacy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!CODEX_NON_EVENT_KEYS.has(k)) legacy[k] = v
  stripOwnedHooks(legacy)
  for (const k of Object.keys(data)) if (!CODEX_NON_EVENT_KEYS.has(k) && !(k in legacy)) delete data[k]
  Object.assign(data, legacy)
  const hooks = (data.hooks && typeof data.hooks === 'object' ? data.hooks : {}) as Record<string, unknown>
  writeHookCopy(hooks, expectedHookCopy('codex'))
  data.hooks = hooks
  if (existsSync(path) && canonicalJson(data) === before) {
    return { type: 'hook-settings', path, status: 'skipped', detail: 'already configured' }
  }
  const status = existsSync(path) ? 'updated' : 'created'
  if (dryRun) return { type: 'hook-settings', path, status: 'dry-run' }
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status }
}

/**
 * Take treecontext's entries out of the `[hooks]` table of Codex's
 * config.toml, keeping the user's own. Install writes the copy into
 * hooks.json only, but Codex also reads `[hooks]` here and doctor grades
 * it; a copy there that install never cleared would read inconsistent
 * forever after the very command doctor names, and outlive uninstall.
 */
export function stripCodexTomlHooks(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  let data: Record<string, unknown>
  try {
    data = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const hooks = data['hooks']
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null
  if (!stripOwnedHooks(hooks as Record<string, unknown>)) return null
  if (Object.keys(hooks).length === 0) delete data['hooks']
  if (!dryRun) atomicWrite(path, stringifyToml(data) + '\n')
  return { type: 'hook-settings', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed treecontext entries from [hooks]' }
}

export function removeCodexHooks(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  const data = readJsonSafe(path)
  const legacy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!CODEX_NON_EVENT_KEYS.has(k)) legacy[k] = v
  let changed = stripOwnedHooks(legacy)
  for (const k of Object.keys(data)) if (!CODEX_NON_EVENT_KEYS.has(k) && !(k in legacy)) delete data[k]
  Object.assign(data, legacy)
  if (data.hooks && typeof data.hooks === 'object') {
    const hooks = data.hooks as Record<string, unknown>
    if (stripOwnedHooks(hooks)) changed = true
    if (Object.keys(hooks).length === 0) delete data.hooks
  }
  if (!changed) return null
  if (!dryRun) atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
  return { type: 'hook-settings', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

// ── Cursor hooks (~/.cursor/hooks.json) ────────────────────────────

function buildCursorHooksConfig(): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: wrapperCommandString('cursor', 'session-start') }],
      beforeSubmitPrompt: [{ command: wrapperCommandString('cursor', 'user-prompt-submit') }],
      postToolUse: [{ command: wrapperCommandString('cursor', 'post-tool-use') }],
      preCompact: [{ command: wrapperCommandString('cursor', 'pre-compact') }],
    },
  }
}

export function upsertCursorHooks(path: string, force: boolean, dryRun: boolean): ActionResult {
  const desired = buildCursorHooksConfig()
  const desiredHooks = desired.hooks as Record<string, unknown>
  const existing = existsSync(path) ? readJsonSafe(path) : {}
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown>
  // Skip only when our owned hook keys already match — a presence-only
  // check would strand legacy bare-`node` configs until --force.
  if (existsSync(path) && !force) {
    const ownedCurrent = Object.keys(desiredHooks).every(
      key => JSON.stringify(existingHooks[key]) === JSON.stringify(desiredHooks[key]),
    )
    if (ownedCurrent) {
      return { type: 'hook-settings', path, status: 'skipped', detail: 'already configured' }
    }
  }

  // Merge rather than overwrite so non-treecontext hooks survive.
  const config = { ...existing, version: 1, hooks: { ...existingHooks, ...desiredHooks } }
  const status = existsSync(path) ? 'updated' : 'created'

  if (dryRun) return { type: 'hook-settings', path, status: 'dry-run' }
  atomicWrite(path, JSON.stringify(config, null, 2) + '\n')
  return { type: 'hook-settings', path, status }
}

export function removeCursorHooks(path: string, dryRun: boolean): ActionResult | null {
  return removeOwnedHooksMap(path, 'cursor', dryRun)
}

// ── Instruction file injection ─────────────────────────────────────

export const MARKER_START = '<!-- treecontext:start -->'
export const MARKER_END = '<!-- treecontext:end -->'

// States the TRIGGER_CORE orientation protocol (instructions.ts) with
// AGENTS.md reference framing; protocol conformance is enforced by
// tests/server/instructions-drift.test.ts.
export const INSTRUCTIONS_CONTENT = `${MARKER_START}
# Treecontext — Working Memory

This project uses treecontext: a searchable chat-session journal
(flat SQLite store, BM25 search). On Claude Code, conversation hooks
auto-capture tool-use and user messages — you don't need to manually
record what happened, only the *why* (decisions, plans, rejected paths).
On other agents nothing is captured for you: only what you insert is kept.

## Session Start
1. \`treecontext_status\` — check resume_pointers.
   If resume_pointers non-empty, \`treecontext_export(node_id)\` on each.
2. \`treecontext_query("what was I working on, what was the next step")\`
Only then proceed with the user's request.

## What to Write Manually
Hooks capture the *what*. You record the *why*:
- Decisions and reasoning ("chose X over Y because Z")
- Plans and next steps
- Rejected alternatives and dead ends
- Constraints the user stated
- Synthesized findings from research

Use \`treecontext_insert\` at natural breaks: decision reached, subtask
complete, direction changed. Tag plans with \`metadata.next_session = true\`
so future sessions find them. When a new plan or close-out replaces an
earlier one, pass \`supersedes: [old_node_ids]\` to clear its stale flags.

## Checkpoints
Two kinds:
- **Bookmark** — when the stop hook asks, insert a short "at: …; next: …"
  note with \`metadata.kind = "bookmark"\`.
- **Chapter summary** — when the developer says "checkpoint", insert a
  curated summary with \`metadata.next_session = true\` and
  \`supersedes: [<previous chapter id>]\`, then suggest that this is a
  good moment to /clear.

After a /clear, open your first reply with the re-orientation packet you
received at session start, shown to the developer as is, in order.
Handoff: export the chapter summaries to a file in the repository and
commit it; the teammate pulls and imports it with \`treecontext_import\`,
with the file's name as the label.
When capture or recall looks wrong, run \`treecontext doctor\` before
anything else. The long form is the treecontext-reference skill.

## Key Tools
- \`treecontext_insert\` — record decisions, reasoning, plans
- \`treecontext_query\` — recall context by topic (supports time_range, sort_by)
- \`treecontext_export\` — fetch an entry by ID (omit the ID for the whole journal)
- \`treecontext_status\` — orientation panel with resume pointers

Don't put project-scoped facts in global auto-memory — each entry is permanent
context-window tax for every other project. Use treecontext_insert instead.
${MARKER_END}`

export function upsertInstructions(path: string, force: boolean, dryRun: boolean): ActionResult {
  let existing = ''
  if (existsSync(path)) {
    existing = readFileSync(path, 'utf8')
  }

  if (existing.includes(MARKER_START)) {
    const re = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`)
    const match = existing.match(re)
    if (match && match[0] === INSTRUCTIONS_CONTENT && !force) {
      return { type: 'instructions', path, status: 'skipped', detail: 'already present' }
    }
    existing = existing.replace(re, '').trim()
  }

  const content = existing
    ? `${existing}\n\n${INSTRUCTIONS_CONTENT}\n`
    : `${INSTRUCTIONS_CONTENT}\n`

  if (dryRun) return { type: 'instructions', path, status: 'dry-run' }
  atomicWrite(path, content)
  return { type: 'instructions', path, status: existing ? 'updated' : 'created' }
}

export function removeInstructions(path: string, dryRun: boolean): ActionResult | null {
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  if (!content.includes(MARKER_START)) return null

  const re = new RegExp(`\\n*${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`)
  const cleaned = content.replace(re, '\n').trim()

  if (!dryRun) {
    if (cleaned) {
      atomicWrite(path, cleaned + '\n')
    } else {
      unlinkSync(path)
    }
  }
  return { type: 'instructions', path, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

// ── Claude Code skill installation ─────────────────────────────────

export function skillFilePath(): string {
  return join(homedir(), '.claude', 'skills', SKILL_REFERENCE_NAME, 'SKILL.md')
}

export function skillFileContent(): string {
  return [
    '---',
    `name: ${SKILL_REFERENCE_NAME}`,
    `description: ${SKILL_REFERENCE_DESCRIPTION}`,
    '---',
    '',
    SKILL_REFERENCE_BODY,
    '',
  ].join('\n')
}

export function installClaudeSkill(dryRun: boolean): ActionResult {
  const path = skillFilePath()
  const content = skillFileContent()
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return { type: 'skill', path, status: 'skipped', detail: 'already present' }
  }
  const status = existsSync(path) ? 'updated' : 'created'
  if (dryRun) return { type: 'skill', path, status: 'dry-run' }
  atomicWrite(path, content)
  return { type: 'skill', path, status }
}

export function removeClaudeSkill(dryRun: boolean): ActionResult | null {
  const skillDir = dirname(skillFilePath())
  if (!existsSync(skillDir)) return null
  if (!dryRun) rmSync(skillDir, { recursive: true, force: true })
  return { type: 'skill', path: skillDir, status: dryRun ? 'dry-run' : 'updated', detail: 'removed' }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Global config (capture mode) ───────────────────────────────────

export function installGlobalConfig(dryRun: boolean): ActionResult {
  const configPath = join(homedir(), '.treecontext', 'config.toml')
  if (existsSync(configPath)) {
    // The catch below covers ONLY read+parse: 'corrupt' is a verdict on
    // the bytes, and a failed UPDATE write (ENOSPC, EACCES) on a valid
    // file must propagate as the error it is — the old shape routed it
    // into the corrupt-file handler, which side-filed the healthy config
    // and replaced it with the template (F review 2026-08-15).
    let data: Record<string, unknown> | null = null
    try {
      data = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      data = null
    }
    if (data) {
      const server = (data.server ?? {}) as Record<string, unknown>
      // An explicit value — true OR false — is the user's, and install
      // must not flip it (ruling 2026-08-15, standing defect
      // dispositions). The old skip condition demanded a codeIndex/
      // codeAnnotation marker no loader ever read, so a plain
      // `capture = false` was force-rewritten to true on every install.
      // Skipping also preserves the file byte-for-byte: the update path
      // below re-serializes and loses comments.
      if (server.capture !== undefined) {
        return { type: 'global-config', path: configPath, status: 'skipped', detail: 'capture already set' }
      }
      server.capture = true
      // Retired marker keys from the skip-condition hack; drop them when
      // already rewriting rather than leaving dead config behind.
      delete server.codeIndex
      delete server.codeAnnotation
      data.server = server
      // config.toml lives under ~/.treecontext — private by mode, like
      // everything else the tool writes there (docs/security.md §3).
      if (!dryRun) atomicWrite(configPath, stringifyToml(data) + '\n', 0o600)
      return { type: 'global-config', path: configPath, status: 'updated' }
    }
    // Corrupt file: the fresh template below replaces it, but the bytes
    // are the user's — side-file them first, same contract as
    // bindings.json.corrupt. If the side-file rename fails (Windows
    // lock, permissions), REFUSE the replacement rather than clobber
    // the only copy (same policy as persistBindings).
    if (!dryRun) {
      // unlink-first: Windows rename refuses an existing destination.
      try { unlinkSync(`${configPath}.corrupt`) } catch { /* not present */ }
      try {
        renameSync(configPath, `${configPath}.corrupt`)
      } catch {
        return {
          type: 'global-config', path: configPath, status: 'skipped',
          detail: 'unparseable config could not be side-filed; left untouched',
        }
      }
    }
  }

  const content = `# treecontext global configuration
# Generated by: treecontext install
# Docs: https://github.com/bingh0/treecontext-mcp

[server]
# Enable conversation capture (conversation indexer).
# Hooks feed tool-use events into a staging table; the server's
# ingestion loop processes them into the journal.
capture = true

[retention]
# The store's byte budget and session cap (D141). A project's own
# treecontext.toml replaces this file whole for that project.
# max_store_bytes = 134217728   # 128 MiB, the default
# max_sessions = 100            # the default; the entry safety net is 200 per session
`

  if (dryRun) return { type: 'global-config', path: configPath, status: 'dry-run' }
  atomicWrite(configPath, content, 0o600)
  return { type: 'global-config', path: configPath, status: 'created' }
}

// ── CCS (Claude Code Switch) compatibility ────────────────────────

/**
 * Discover all CCS instance settings.json files that need hook updates.
 * Returns paths that are NOT symlinks to the shared file (i.e. bare/isolated instances)
 * plus the shared file itself if it exists.
 */
function getCcsHookTargets(): string[] {
  const ccsDir = join(homedir(), '.ccs')
  if (!existsSync(ccsDir)) return []

  const targets: string[] = []
  const sharedSettings = join(ccsDir, 'shared', 'settings.json')

  // Always include the shared settings if it exists (covers symlinked instances)
  if (existsSync(sharedSettings)) {
    targets.push(sharedSettings)
  }

  // Also find bare/isolated instances with standalone settings.json
  const instancesDir = join(ccsDir, 'instances')
  if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir)) {
      const instanceSettings = join(instancesDir, name, 'settings.json')
      if (!existsSync(instanceSettings)) continue
      try {
        const stats = lstatSync(instanceSettings)
        if (!stats.isSymbolicLink()) {
          // Standalone file — bare instance, needs direct write
          targets.push(instanceSettings)
        }
      } catch { /* skip */ }
    }
  }

  return targets
}

function getCcsMcpTargets(): string[] {
  const ccsDir = join(homedir(), '.ccs')
  if (!existsSync(ccsDir)) return []

  const targets: string[] = []
  const instancesDir = join(ccsDir, 'instances')
  if (!existsSync(instancesDir)) return targets

  for (const name of readdirSync(instancesDir)) {
    const instanceConfig = join(instancesDir, name, '.claude.json')
    if (!existsSync(instanceConfig)) continue
    try {
      const data = readJsonSafe(instanceConfig)
      const servers = (data.mcpServers ?? {}) as Record<string, unknown>
      if (servers.treecontext) {
        targets.push(instanceConfig)
      }
    } catch { /* skip */ }
  }

  return targets
}

// ── Install ────────────────────────────────────────────────────────

export async function install(opts: InstallOptions): Promise<AgentInstallResult[]> {
  const platform = process.platform as Platform
  const results: AgentInstallResult[] = []

  let agents: AgentDefinition[]
  if (opts.agents && opts.agents.length > 0) {
    agents = opts.agents
      .map(slug => getAgent(slug))
      .filter((a): a is AgentDefinition => a !== undefined)
    if (agents.length === 0) {
      console.error(`No matching agents found for: ${opts.agents.join(', ')}`)
      console.error(`Available: ${AGENTS.map(a => a.slug).join(', ')}`)
      return []
    }
  } else {
    agents = detectAgents(platform)
  }

  console.log(`treecontext install v${getVersion()}\n`)
  console.log(`Detected agents: ${agents.map(a => a.name).join(' ') || '(none)'}\n`)

  if (agents.length === 0) {
    console.log('No coding agents detected. Install one first, then re-run.')
    return []
  }

  // Global config
  const configResult = installGlobalConfig(opts.dryRun)
  if (configResult.status !== 'skipped') {
    console.log(`Global config:`)
    console.log(`  ${configResult.path} [${configResult.status}]`)
    console.log(`  capture = true (conversation indexer enabled)\n`)
  }

  // MCP launcher wrapper — resolves node at runtime so the MCP `command` in
  // every agent config survives a node version-manager upgrade. Not needed for
  // npx installs (npx re-resolves node itself).
  if (!opts.useNpx) {
    // Probe first and say what it found. This step spawns a process per
    // candidate, so on an unusual machine it is the one place install can
    // pause; announcing it turns a mysterious wait into visible progress,
    // and naming the rejects explains a choice users would otherwise find
    // surprising (the node on their PATH is not the one that got picked).
    const chosen = verifiedNode()
    console.log(`Interpreter:`)
    if (chosen) {
      console.log(`  ${chosen} [verified — loads the native database binding]`)
    } else {
      console.log(`  none verified — wrappers will resolve node at runtime`)
      console.log(`  capture may not work; run treecontext doctor after installing`)
    }
    for (const skipped of rejectedInterpreters()) {
      console.log(`  skipped: ${skipped} (cannot load better-sqlite3)`)
    }
    console.log()

    const launcherResult = installMcpLauncher(opts.dryRun)
    console.log(`MCP launcher:`)
    console.log(`  ${launcherResult.path} [${launcherResult.status}]\n`)
  }

  let ccsMcpSynced = false
  // One agent's broken configuration must not decide whether the agents
  // beside it get wired. Before this was isolated, a single unwritable
  // directory aborted the whole run at whatever point it was reached, so
  // which agents survived depended on their order in AGENTS — the earlier
  // ones kept their config, the later ones silently got nothing.
  const failed: Array<{ agent: string; message: string }> = []
  for (const agent of agents) {
    const agentResult: AgentInstallResult = { agent: agent.name, slug: agent.slug, actions: [] }
    console.log(`${agent.name}:`)
    try {

    // MCP config
    const configPath = getConfigPath(agent, platform)
    if (configPath) {
      const entry = buildMcpEntry(agent, opts.useNpx, opts.lexical)

      // ~/.claude.json is Claude Code's live state file, not a config file we
      // own: it also holds project history and onboarding state, and Claude
      // Code rewrites it as sessions change. Our read-modify-write is atomic,
      // but a running Claude Code could still lose a concurrent update to
      // last-writer-wins. Copy what was there *before* we touch it, so that is
      // recoverable rather than merely unlikely. (Taken pre-write on purpose:
      // a copy made afterwards preserves our own output, which is no backup
      // at all.)
      if (agent.slug === 'claude' && !opts.dryRun && existsSync(configPath)) {
        try {
          writeFileSync(`${configPath}.treecontext-backup`, readFileSync(configPath), { mode: 0o600 })
        } catch { /* best effort — never block the install on the backup */ }
      }

      let result: ActionResult
      if (agent.configFormat === 'toml-codex') {
        result = upsertTomlMcp(configPath, entry, opts.force, opts.dryRun)
      } else {
        result = upsertJsonMcp(configPath, configRootKey(agent), entry, opts.force, opts.dryRun)
      }
      agentResult.actions.push(result)
      console.log(`  mcp: ${configPath} [${result.status}${result.detail ? ` — ${result.detail}` : ''}]`)

      // 0.0.9-beta wrote Claude Code's entry to ~/.claude/.mcp.json, which
      // Claude Code never reads. Leaving it behind means an upgraded user has
      // a dead config that still *looks* like a registration. Take back only
      // our own entry; anything else in that file belongs to someone else.
      if (agent.slug === 'claude') {
        const legacy = claudeLegacyMcpPath()
        if (legacy !== configPath) {
          const migrated = removeJsonMcp(legacy, 'mcpServers', opts.dryRun)
          if (migrated) {
            agentResult.actions.push(migrated)
            console.log(`  mcp: removed dead 0.0.9-beta entry from ${legacy} (Claude Code never read it)`)
          }
        }
      }

      // Sync MCP config to CCS per-instance .claude.json files (once, for first claude-settings agent)
      if (!ccsMcpSynced && (agent.slug === 'claude' || agent.slug === 'vscode' || agent.slug === 'cursor')) {
        ccsMcpSynced = true
        for (const ccsConfig of getCcsMcpTargets()) {
          const ccsResult = upsertJsonMcp(ccsConfig, 'mcpServers', entry, true, opts.dryRun)
          agentResult.actions.push(ccsResult)
          if (ccsResult.status !== 'skipped') {
            console.log(`  mcp: synced to CCS (${ccsConfig}) [${ccsResult.status}]`)
          }
        }
      }
    }

    // Hooks
    const unverifiedCapture = agent.hooks && !CAPTURE_PLATFORMS.has(agent.slug)
    const asIsNoop = unverifiedCapture && opts.experimentalCapture && AS_IS_CLIENTS.has(agent.slug)
    if (unverifiedCapture && opts.experimentalCapture && !asIsNoop) {
      console.log(`  hooks: EXPERIMENTAL — capture on ${agent.name} is unverified.`)
      console.log(`         Installing anyway because --experimental-capture was passed.`)
      console.log(`         Please report whether entries actually appear:`)
      console.log(`         https://github.com/bingh0/treecontext-mcp/issues`)
    }
    if (asIsNoop) {
      // An as-is client reads the Claude settings file itself: the installer
      // writes nothing for it, flag or not (D208, D226). A second route of
      // our own beside the Claude one would run every hook twice.
      console.log(`  hooks: nothing to write — ${AS_IS_CLIENT_LINE[agent.slug]}`)
    } else if (unverifiedCapture && !opts.experimentalCapture) {
      // The adapter exists but has never been exercised against this
      // platform's live payloads. Writing its hook config anyway is the
      // loudest possible advertisement that capture works here — louder
      // than any README disclaimer — and the charter's verification rule
      // says reading a platform's docs is not verification. Register MCP
      // (which is a standard the agent either speaks or doesn't) and stop
      // there, saying so plainly.
      console.log(`  hooks: skipped — automatic capture is unverified on ${agent.name}`)
      console.log(`         MCP tools work; nothing is captured for you.`)
      if (COPYING_CLIENTS.has(agent.slug)) {
        console.log(`         To copy the hooks anyway: treecontext install --agent ${agent.slug} --experimental-capture`)
      }
    } else if (agent.hooks) {
      const settingsPath = getHookSettingsPath(agent, platform)
      if (agent.hooks.format === 'claude-settings' && settingsPath) {
        // Claude-format hooks (shared by Claude Code, VS Code, Cursor)
        const scriptResults = installClaudeHookScripts(opts.dryRun, opts.debug)
        agentResult.actions.push(...scriptResults)
        const settingsResult = upsertClaudeSettingsHooks(settingsPath, opts.dryRun)
        agentResult.actions.push(settingsResult)
        // Name the files, not just the events. A dry run that lists the
        // events it will register but not the scripts and settings file it
        // will write is not the whole plan — and the seven paths it stayed
        // quiet about are the ones a reviewer would most want to see.
        for (const s of scriptResults) {
          console.log(`  hooks: ${s.path} [${s.status}${s.detail ? ` — ${s.detail}` : ''}]`)
        }
        console.log(`  hooks: ${settingsPath} [${settingsResult.status}${settingsResult.detail ? ` — ${settingsResult.detail}` : ''}]`)
        // Also sync to all CCS instance settings (shared + bare instances)
        for (const ccsPath of getCcsHookTargets()) {
          if (ccsPath === settingsPath) continue
          const ccsResult = upsertClaudeSettingsHooks(ccsPath, opts.dryRun)
          agentResult.actions.push(ccsResult)
          console.log(`  hooks: synced to CCS (${ccsPath}) [${ccsResult.status}]`)
        }
        // The events listed are the block's own keys, so the summary can
        // never name fewer events than install wrote (D250).
        for (const line of claudeHookSummaryLines()) console.log(line)
      } else if (agent.hooks.format === 'vscode-hooks' && settingsPath) {
        agentResult.actions.push(...installAgentHookWrappers('vscode', opts.dryRun))
        const hookResult = upsertVscodeHooks(settingsPath, opts.force, opts.dryRun)
        agentResult.actions.push(hookResult)
        console.log(`  hooks: ${settingsPath} [${hookResult.status}${hookResult.detail ? ` — ${hookResult.detail}` : ''}]`)
        console.log(`  hooks: SessionStart (orientation + snapshot)`)
        console.log(`  hooks: UserPromptSubmit (conversation capture)`)
        console.log(`  hooks: PostToolUse (conversation capture)`)
        console.log(`  hooks: PreCompact (checkpoint before compaction)`)
      } else if ((agent.hooks.format === 'codex-hooks' || agent.hooks.format === 'gemini-settings') && settingsPath) {
        // A copying client (D154, D161, D208): its own configuration gets a
        // copy of the Claude Code block — verbatim for Codex CLI, translated
        // to Gemini CLI's event names — running the same Claude Code hook
        // scripts, which are written first so the copy never names a script
        // install did not write.
        const scriptResults = installClaudeHookScripts(opts.dryRun, opts.debug)
        agentResult.actions.push(...scriptResults)
        for (const s of scriptResults) {
          console.log(`  hooks: ${s.path} [${s.status}${s.detail ? ` — ${s.detail}` : ''}]`)
        }
        const hookResult = agent.hooks.format === 'codex-hooks'
          ? upsertCodexHooks(settingsPath, opts.force, opts.dryRun)
          : upsertGeminiHooks(settingsPath, opts.dryRun)
        agentResult.actions.push(hookResult)
        console.log(`  hooks: ${settingsPath} [${hookResult.status}${hookResult.detail ? ` — ${hookResult.detail}` : ''}]`)
        // One copy, in one place: an entry of ours in config.toml's [hooks]
        // would fire beside hooks.json's.
        const tomlPath = agent.slug === 'codex' ? getConfigPath(agent, platform) : null
        const tomlResult = tomlPath ? stripCodexTomlHooks(tomlPath, opts.dryRun) : null
        if (tomlResult) {
          agentResult.actions.push(tomlResult)
          console.log(`  hooks: ${tomlPath} [${tomlResult.status} — ${tomlResult.detail}]`)
        }
        const copied = Object.keys(expectedHookCopy(agent.slug))
        console.log(`  hooks: copied the Claude Code block${agent.slug === 'gemini' ? ', translated' : ''} (${copied.join(', ')})`)
      } else if (agent.hooks.format === 'cursor-hooks' && settingsPath) {
        agentResult.actions.push(...installAgentHookWrappers('cursor', opts.dryRun))
        const hookResult = upsertCursorHooks(settingsPath, opts.force, opts.dryRun)
        agentResult.actions.push(hookResult)
        console.log(`  hooks: ${settingsPath} [${hookResult.status}${hookResult.detail ? ` — ${hookResult.detail}` : ''}]`)
        console.log(`  hooks: sessionStart (orientation + snapshot)`)
        console.log(`  hooks: beforeSubmitPrompt (conversation capture)`)
        console.log(`  hooks: postToolUse (conversation capture)`)
        console.log(`  hooks: preCompact (checkpoint before compaction)`)
      }
    } else if (agent.slug === 'opencode') {
      // The unverified plugin adapter is not advertised (D30); this is what
      // doctor's OpenCode row says too.
      console.log(`  hooks: none — OpenCode offers no shell hooks; the MCP tools are its whole surface`)
    } else {
      console.log(`  hooks: not supported by ${agent.name}`)
      console.log(`         conversation indexer unavailable — agent uses standard mode (manual treecontext_insert/query)`)
    }

    // Instructions
    if (agent.instructions) {
      const instrPath = getInstructionsPath(agent, platform)
      if (instrPath) {
        const instrResult = upsertInstructions(instrPath, opts.force, opts.dryRun)
        agentResult.actions.push(instrResult)
        console.log(`  instructions: ${instrPath} [${instrResult.status}]`)
      }
    }

    // Reference skill (Claude Code only — skills are CC-specific)
    if (agent.slug === 'claude') {
      const skillResult = installClaudeSkill(opts.dryRun)
      agentResult.actions.push(skillResult)
      console.log(`  skill: ${skillResult.path} [${skillResult.status}${skillResult.detail ? ` — ${skillResult.detail}` : ''}]`)
    }
    } catch (e) {
      // Name the agent and the underlying path/permission, then carry on to
      // the next one. The run still ends non-zero (below) — isolation is not
      // the same as forgiveness.
      // Sanitized like the fatal handler (D5): these lines are what users
      // paste into issues, and the home path is not ours to publish.
      const message = redactHome(e instanceof Error ? e.message : String(e))
      failed.push({ agent: agent.name, message })
      console.error(`  [error] ${message}`)
      console.error(`  ${agent.name} was left unwired; continuing with the remaining agents.`)
    }

    results.push(agentResult)
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} agent${failed.length === 1 ? '' : 's'} could not be wired:`)
    for (const f of failed) console.error(`  ${f.agent}: ${f.message}`)
  }

  console.log(`\nInstall complete.${opts.dryRun ? ' (dry-run — no files were modified)' : ' Restart your coding agent to start using treecontext.'}`)

  if (!opts.dryRun && !isCommandAvailable('treecontext')) {
    const cliPath = resolveCliPath()
    const shell = process.env.SHELL ?? ''
    const rcFile = shell.endsWith('/zsh') ? '~/.zshrc'
      : shell.endsWith('/fish') ? '~/.config/fish/config.fish'
      : '~/.bashrc'
    console.log(`\nTip: add a shell alias so you can run "treecontext" from anywhere:`)
    console.log(`  echo 'alias treecontext="node ${cliPath}"' >> ${rcFile} && source ${rcFile}`)
  }

  // Surfaced after the per-agent summary so the exit code still reports the
  // failure: isolating a fault must not turn a broken install into a silent
  // success.
  if (failed.length > 0) {
    const err = new Error(`could not wire ${failed.map(f => f.agent).join(', ')} — see the errors above`)
    ;(err as Error & { code?: string }).code = 'INSTALL_PARTIAL'
    throw err
  }

  return results
}

// ── Uninstall ──────────────────────────────────────────────────────

export async function uninstall(opts: {
  yes: boolean
  dryRun: boolean
  agents: string[] | null
  /**
   * Remove hook config only, leaving MCP registration, instructions and the
   * reference skill alone. This is what doctor offers for hooks left behind
   * on a platform install does not manage: the stale hooks must go, but the
   * MCP tools there are working and should survive the cleanup.
   */
  hooksOnly?: boolean
}): Promise<AgentInstallResult[]> {
  const platform = process.platform as Platform
  const results: AgentInstallResult[] = []

  let agents: AgentDefinition[]
  if (opts.agents && opts.agents.length > 0) {
    agents = opts.agents
      .map(slug => {
        const a = getAgent(slug)
        // Parity with install: a silently dropped unknown slug reads as
        // "uninstalled" to the user who typed it (fifth-pass review). The
        // archived-build five are the expected case here.
        if (!a) {
          console.log(
            `unknown agent: ${slug}` +
            (legacyMcpConfigs(platform).some(l => l.slug === slug)
              ? ' (archived-build platform — its config is cleaned automatically below)'
              : ''),
          )
        }
        return a
      })
      .filter((a): a is AgentDefinition => a !== undefined)
  } else {
    agents = AGENTS.filter(a => {
      const path = getConfigPath(a, platform)
      return path && existsSync(path)
    })
  }
  // A run that names no agent is a FULL uninstall, and a full uninstall owns
  // every file it ever wrote — including the wrappers of an agent whose config
  // has since been deleted. See the sweep after the loop.
  const fullScope = !(opts.agents && opts.agents.length > 0)

  console.log(`treecontext uninstall v${getVersion()}\n`)

  for (const agent of agents) {
    const agentResult: AgentInstallResult = { agent: agent.name, slug: agent.slug, actions: [] }
    const configPath = getConfigPath(agent, platform)

    if (configPath && !opts.hooksOnly) {
      let result: ActionResult | null
      if (agent.configFormat === 'toml-codex') {
        result = removeTomlMcp(configPath, opts.dryRun)
      } else {
        result = removeJsonMcp(configPath, configRootKey(agent), opts.dryRun)
      }
      if (result) {
        agentResult.actions.push(result)
        console.log(`${agent.name}: mcp removed from ${configPath}`)
      }
      // Clean the dead 0.0.9-beta location too, so uninstall leaves nothing.
      if (agent.slug === 'claude' && claudeLegacyMcpPath() !== configPath) {
        const legacy = removeJsonMcp(claudeLegacyMcpPath(), 'mcpServers', opts.dryRun)
        if (legacy) {
          agentResult.actions.push(legacy)
          console.log(`${agent.name}: mcp removed from ${claudeLegacyMcpPath()} (legacy)`)
        }
      }
    }

    // Remove hooks
    if (agent.hooks?.format === 'claude-settings') {
      // A Codex or Gemini copy runs these same scripts. Removing them under
      // it would leave every entry of the copy aimed at nothing, so the
      // scripts stay and the command that removes the copy first is named.
      const copies = copiesRunningClaudeScripts(platform, new Set(agents.map(a => a.slug)))
      const scriptResults = removeClaudeHookScripts(opts.dryRun, opts.hooksOnly, copies.length > 0)
      agentResult.actions.push(...scriptResults)
      if (copies.length > 0) {
        const cmds = copies.map(a => `treecontext uninstall --agent ${a.slug}`).join(' and ')
        agentResult.refused = `kept the Claude Code hook scripts in ${join(homedir(), '.claude', HOOK_SCRIPTS_DIR_NAME)}: `
          + `${copies.map(a => a.name).join(' and ')} still run${copies.length === 1 ? 's' : ''} them through ${copies.length === 1 ? 'its' : 'their'} copy of the hooks; `
          + `remove ${copies.length === 1 ? 'that copy' : 'those copies'} first: ${cmds}, then uninstall Claude Code again`
        console.log(`${agent.name}: refused — ${agentResult.refused}`)
      }
      const settingsPath = getHookSettingsPath(agent, platform)
      if (settingsPath) {
        const hookResult = removeClaudeSettingsHooks(settingsPath, opts.dryRun)
        if (hookResult) agentResult.actions.push(hookResult)
      }
      // Also remove from all CCS instance settings (shared + bare instances)
      for (const ccsPath of getCcsHookTargets()) {
        if (ccsPath === settingsPath) continue
        const ccsResult = removeClaudeSettingsHooks(ccsPath, opts.dryRun)
        if (ccsResult) agentResult.actions.push(ccsResult)
      }
      if (scriptResults.length > 0) console.log(`${agent.name}: hooks removed`)
    } else if (agent.hooks?.format === 'vscode-hooks') {
      // Wrapper removal sits outside the settingsPath gate: the wrappers
      // exist whether or not the config file still does, and an explicit
      // `uninstall vscode` must orphan neither half.
      agentResult.actions.push(...removeAgentHookWrappers('vscode', opts.dryRun))
      const settingsPath = getHookSettingsPath(agent, platform)
      if (settingsPath) {
        const hookResult = removeVscodeHooks(settingsPath, opts.dryRun)
        if (hookResult) {
          agentResult.actions.push(hookResult)
          console.log(`${agent.name}: hooks removed from ${settingsPath}`)
        }
      }
    } else if (agent.hooks?.format === 'codex-hooks') {
      agentResult.actions.push(...removeAgentHookWrappers('codex', opts.dryRun))
      const settingsPath = getHookSettingsPath(agent, platform)
      if (settingsPath) {
        const hookResult = removeCodexHooks(settingsPath, opts.dryRun)
        if (hookResult) {
          agentResult.actions.push(hookResult)
          console.log(`${agent.name}: hooks removed from ${settingsPath}`)
        }
      }
      const tomlPath = getConfigPath(agent, platform)
      const tomlResult = tomlPath ? stripCodexTomlHooks(tomlPath, opts.dryRun) : null
      if (tomlResult) {
        agentResult.actions.push(tomlResult)
        console.log(`${agent.name}: hooks removed from [hooks] in ${tomlPath}`)
      }
    } else if (agent.hooks?.format === 'cursor-hooks') {
      agentResult.actions.push(...removeAgentHookWrappers('cursor', opts.dryRun))
      const settingsPath = getHookSettingsPath(agent, platform)
      if (settingsPath) {
        const hookResult = removeCursorHooks(settingsPath, opts.dryRun)
        if (hookResult) {
          agentResult.actions.push(hookResult)
          console.log(`${agent.name}: hooks removed from ${settingsPath}`)
        }
      }
    } else if (agent.hooks?.format === 'gemini-settings') {
      agentResult.actions.push(...removeAgentHookWrappers('gemini', opts.dryRun))
      const settingsPath = getHookSettingsPath(agent, platform)
      if (settingsPath) {
        const hookResult = removeGeminiHooks(settingsPath, opts.dryRun)
        if (hookResult) {
          agentResult.actions.push(hookResult)
          console.log(`${agent.name}: hooks removed`)
        }
      }
    }

    // Remove instructions
    if (agent.instructions && !opts.hooksOnly) {
      const instrPath = getInstructionsPath(agent, platform)
      if (instrPath) {
        const instrResult = removeInstructions(instrPath, opts.dryRun)
        if (instrResult) {
          agentResult.actions.push(instrResult)
          console.log(`${agent.name}: instructions removed from ${instrPath}`)
        }
      }
    }

    // Remove reference skill
    if (agent.slug === 'claude' && !opts.hooksOnly) {
      const skillResult = removeClaudeSkill(opts.dryRun)
      if (skillResult) {
        agentResult.actions.push(skillResult)
        console.log(`${agent.name}: skill removed from ${skillResult.path}`)
      }
    }

    if (agentResult.actions.length > 0 || agentResult.refused) results.push(agentResult)
  }

  // Wrappers of agents the loop above never reached.
  //
  // The selection at the top of a full uninstall keeps only agents whose
  // config path still EXISTS, so a user who deleted ~/.gemini never ran the
  // gemini branch — and removeClaudeHookScripts spares every tc-<agent>-*
  // name on purpose, for the branch that was supposed to take them. The four
  // gemini wrappers therefore survived `treecontext uninstall` permanently,
  // with nothing left on the machine that could ever name them again.
  // Config-file cleanup stays gated on the config existing; wrapper removal
  // must not be. Idempotent, so an agent the loop DID handle contributes
  // nothing here.
  if (fullScope) {
    for (const agent of Object.keys(AGENT_HOOK_WRAPPER_STEMS) as AgentHookAgent[]) {
      const swept = removeAgentHookWrappers(agent, opts.dryRun)
      if (swept.length === 0) continue
      results.push({ agent: `${agent} (hook wrappers)`, slug: agent, actions: swept })
      console.log(`${agent}: orphaned hook wrappers removed`)
    }
  }

  // The archived-build five left the registry at the 0.1 cold-read, but a
  // 0.0.x install may have written entries into their configs pointing at
  // the launcher THIS uninstall deletes — leaving them behind would
  // strand each agent erroring on a nonexistent path forever
  // (fifth-pass review). Same posture as claudeLegacyMcpPath above: the
  // platform is gone, its debris is still ours to clean.
  if (!opts.hooksOnly) {
    for (const legacy of legacyMcpConfigs(platform)) {
      if (!existsSync(legacy.path)) continue
      const removed = removeJsonMcp(legacy.path, legacy.rootKey, opts.dryRun)
      if (removed) {
        results.push({ agent: `${legacy.slug} (archived)`, slug: legacy.slug, actions: [removed] })
        console.log(`${legacy.slug} (archived): mcp removed from ${legacy.path}`)
      }
    }
  }

  if (results.length === 0) {
    console.log('Nothing to uninstall.')
  } else {
    console.log(results.some(r => r.refused)
      ? `\nUninstall incomplete: part of it was refused, see above.${opts.dryRun ? ' (dry-run)' : ''}`
      : `\nUninstall complete.${opts.dryRun ? ' (dry-run)' : ''}`)
  }
  return results
}

// ── Doctor ─────────────────────────────────────────────────────────

/**
 * Diagnose the interpreter token of an installed command. Returns a
 * human-readable problem description or null if the command is healthy.
 * Two failure classes: bare names (PATH-dependent, fail for GUI-launched
 * agents) and stale absolute paths (node upgraded/removed since install).
 */
/**
 * The interpreter install pinned into the MCP launcher, or null if it pinned
 * none — read from whichever wrapper dialect is on disk.
 *
 * Both dialects now open the same way — POSIX with `TC_NODE="<verified>"`, the
 * .cmd with `set "TC_NODE=<verified>"` — because both resolve in the same
 * order. Doctor once understood only the POSIX spelling and the whole check
 * was gated off with `process.platform !== 'win32'`, which left Windows in the
 * state the caller's comment describes: a wrapper whose interpreter cannot
 * load better-sqlite3 leaves every capture hook running, storing nothing, and
 * suppressing the error that would say so, while doctor reports the install
 * healthy.
 *
 * The caveat this comment used to carry — that on Windows the pinned
 * interpreter was the FALLBACK, so a bad `node` on PATH would win and escape
 * this check — is gone with the precedence that caused it (see
 * windowsNodeResolveSnippet). What this reads is now what actually runs, on
 * both platforms.
 */
export function launcherInterpreter(body: string): string | null {
  if (body.startsWith('@echo off')) {
    const pinned = /^set "TC_NODE=([^"]+)"/m.exec(body)?.[1] ?? null
    // The snippet's "resolve at runtime" sentinel is a bare `node`, which is
    // not a pin. POSIX spells that state as an empty TC_NODE — handled below.
    return pinned === 'node' ? null : pinned
  }
  // `[^"]*`, not `[^"]+`. With `+` the empty pin an unverified install writes
  // (`TC_NODE=""`) failed to match, and `m` then found the NEXT line-initial
  // assignment — the discovery chain's own `TC_NODE="$(command -v node ||
  // true)"` — handing doctor a shell fragment as though it were a path. Doctor
  // probed it, could not load a binding with it, and reported
  //   [err] $(command -v node || true) cannot load better-sqlite3
  // on exactly the machine that verified no interpreter at all, instead of the
  // accurate "no verified interpreter pinned" warning and its --force fix.
  // Matching the empty pin is what makes the first assignment always the
  // answer; an empty capture means the same thing here as the bare-`node`
  // sentinel does above.
  return /^TC_NODE="([^"]*)"/m.exec(body)?.[1] || null
}

/**
 * The cli.js path a wrapper body pins, or null when it names none.
 *
 * Counterpart of launcherInterpreter, parsed the same way so each dialect has
 * exactly one reader. Bodies written before the TC_CLI fallback existed inline
 * the module path in the invocation line instead of pinning it; those are read
 * from that line, because a wrapper this build did not write is exactly the
 * one doctor most needs to grade.
 *
 * A capture that is still a shell/batch variable means the body pinned nothing
 * concrete, which is the same "nothing to check" answer as no match at all.
 */
export function launcherCliPath(body: string): string | null {
  const found = body.startsWith('@echo off')
    ? /^set "TC_CLI=([^"]+)"/m.exec(body)?.[1] ?? /"%TC_NODE%" "([^"]+)"/.exec(body)?.[1]
    : /^TC_CLI="([^"]+)"/m.exec(body)?.[1] ?? /"\$TC_NODE" "([^"]+)"/.exec(body)?.[1]
  if (!found || found.startsWith('$') || found.startsWith('%')) return null
  return found
}

// ── Which build is which ────────────────────────────────────────────

/**
 * Every `treecontext` the shell would find, first match first. POSIX asks
 * the shell itself (`command -v`), so a box without `which` answers the way
 * its shell does; `where` lists every match on Windows (the .cmd shim, the
 * sh shim beside it for Git Bash, the .ps1). Empty when nothing is found —
 * or when the lookup itself fails, which is the same answer.
 */
function commandsOnPath(name: string): string[] {
  const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5000 }
  try {
    const out = process.platform === 'win32'
      ? execFileSync('where', [name], opts)
      : execFileSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', name], opts)
    return out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && isAbsolute(l) && existsSync(l))
  } catch {
    return []
  }
}

/**
 * One spelling for a location on this host: the real path, case-folded where
 * the file system is. Two roots are the same build when their canonical
 * spellings agree — `where` hands back PATH's spelling of a directory and
 * `import.meta.url` the loader's, and on Windows those can differ in case.
 */
function canonicalPath(p: string): string {
  let real = p
  try { real = realpathSync.native(p) } catch {
    try { real = realpathSync(p) } catch { real = resolve(p) }
  }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function sameLocation(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

/**
 * The script a command shim runs, or null when the body pins nothing this
 * reader knows. Two shapes cover every npm global install: a symlink (POSIX,
 * and `npm link`) whose real path is the entry point, and npm's cmd-shim
 * family (the .cmd, the sh shim beside it, the .ps1), which spell the entry
 * point relative to the shim's own directory as `%dp0%\...` or
 * `$basedir/...`. The capture is anchored on a script extension because the
 * .cmd body also spells `%dp0%\node.exe` — its interpreter probe — before
 * the entry point. A target is returned whether or not it still exists; the
 * caller grades a vanished one.
 */
export function shimTarget(shimPath: string, body?: string): string | null {
  try {
    if (lstatSync(shimPath).isSymbolicLink()) {
      try { return realpathSync.native(shimPath) } catch { return resolve(dirname(shimPath), readlinkSync(shimPath)) }
    }
  } catch {
    return null
  }
  let text: string
  try { text = body ?? readFileSync(shimPath, 'utf8') } catch { return null }
  const m = /(?:%dp0%\\|\$basedir\/)([^"\r\n]*?\.(?:[cm]?js|ts))"/.exec(text)
  if (!m) return null
  return resolve(dirname(shimPath), m[1]!.split(/[\\/]/).join(sep))
}

/**
 * What a command shim answers to `--version`, or why it could not. The last
 * resort for a shim this reader cannot follow — Volta's binary, an asdf or
 * pnpm script, a hand-rolled wrapper: running it is what the user would do,
 * and its answer is the one fact about it doctor can still report. Bounded;
 * never through a shell on POSIX. A Windows .cmd can be spawned no other
 * way, so that one goes through cmd.exe.
 */
function shimVersion(shim: string): { version: string } | { error: string } {
  try {
    const r = process.platform === 'win32'
      ? spawnSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${shim}" --version`],
        { encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true })
      : spawnSync(shim, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (r.error) return { error: r.error.message }
    const m = /treecontext\s+(\S+)/.exec(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
    if (m) return { version: m[1]! }
    return { error: r.status === 0 ? 'it printed no version' : `exit ${r.status ?? r.signal ?? '?'}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** What one entry point belongs to: its package root, name and version. */
export interface BuildIdentity { cli: string; root: string; name: string; version: string }

/**
 * The package an entry point belongs to. Both layouts a cli lives in —
 * dist/server/cli.js in an installed package, src/server/cli.ts in a
 * checkout — sit two directories under the package root, the same
 * relation getVersion() relies on for this build. Null when the root has
 * no readable package.json.
 */
export function buildIdentity(cliPath: string): BuildIdentity | null {
  // The entry point itself need not exist: a checkout run through tsx has
  // src/server/cli.ts where this module computes cli.js, and the identity
  // lives in package.json either way. Its DIRECTORY is real in both cases,
  // so the root is canonical (a symlinked checkout compares equal to
  // itself). Callers that care whether the entry point is there ask first.
  let cli = resolve(cliPath)
  try { cli = realpathSync.native(cli) } catch {
    try { cli = join(realpathSync.native(dirname(cli)), basename(cli)) } catch { /* as given */ }
  }
  const root = resolve(dirname(cli), '..', '..')
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    return {
      cli, root,
      name: typeof pkg.name === 'string' ? pkg.name : '?',
      version: typeof pkg.version === 'string' ? pkg.version : '?',
    }
  } catch {
    return null
  }
}

/**
 * True for the layout npm's GLOBAL install produces — `<prefix>/lib/
 * node_modules/<name>` on POSIX, `<prefix>\node_modules\<name>` under
 * npm's or Node's own prefix on Windows — and false for a checkout or a
 * project-local node_modules, whose "bin directory" would be nonsense.
 */
function isGlobalNpmLayout(root: string): boolean {
  if (basename(dirname(root)) !== 'node_modules') return false
  const above = basename(resolve(root, '..', '..'))
  return process.platform === 'win32' ? ['npm', 'nodejs'].includes(above.toLowerCase()) : above === 'lib'
}

/**
 * Where npm put the command shim for a global layout: `<prefix>/bin` on
 * POSIX, the prefix itself on Windows.
 */
function globalShimDir(root: string): string {
  return process.platform === 'win32'
    ? resolve(root, '..', '..')
    : resolve(root, '..', '..', '..', 'bin')
}

/**
 * How to run THIS build by hand, as a command that exists: its entry point
 * under node, or — a checkout under tsx, where this module computes a
 * cli.js beside its own cli.ts — the .ts twin through tsx. Never a file
 * that is not there.
 */
export function selfCommandFor(thisCli: string): string {
  if (existsSync(thisCli)) return `node "${thisCli}"`
  const twin = thisCli.endsWith('.js') ? `${thisCli.slice(0, -3)}.ts` : thisCli
  return existsSync(twin) ? `npx tsx "${twin}"` : `node "${thisCli}"`
}

/** The row plus the one fact doctor's later fix lines depend on. */
export interface CommandOnPathRow extends DiagnosticResult {
  /** True only when typing `treecontext` runs exactly this build. */
  reachesThisBuild: boolean
}

/**
 * The `Command on PATH` row: which build the shell runs when someone types
 * `treecontext`, against the build printing this report.
 *
 * Every doctor before this one was honest about itself and silent about
 * the other. A tester with a 0.1.0-rc.2 global install built a 2.0.0
 * checkout of the retired tree-era repository, ran `node
 * dist/server/cli.js install` from it, and reported that 2.0.0 "did not
 * install an executable on path": the number read as an ordering, and
 * nothing on screen said the two were different builds. A checkout is
 * never on PATH by construction — a fact worth one line rather than a
 * surprise.
 *
 * `shims` is the shell's answer, first match first (commandsOnPath): the
 * first is the one the shell runs, so it is the one graded, by reading
 * where it leads or, failing that, by asking it. The row never ranks two
 * versions: across lineages the larger number is not the newer build,
 * which is the whole lesson. And a warn is a defect with a way out, never
 * a nag: two copies of one version are reported, not warned about.
 *
 * `npm install -g "<root>"` is the one way out in every warn state: it
 * links a checkout (npm 7+ links a folder rather than copying it) or
 * installs a package, and either way the shim then leads here — measured
 * to replace a dangling shim as well. `npm uninstall -g` does NOT remove
 * an orphaned shim (it reports "up to date"), so it is never offered.
 */
export function commandOnPathRow(shims: string[], thisCli: string): CommandOnPathRow {
  const check = 'Command on PATH'
  const self = buildIdentity(thisCli)
  const selfRoot = self?.root ?? resolve(dirname(thisCli), '..', '..')
  const here = `v${self?.version ?? '?'} at ${selfRoot}`
  const makeThis = `npm install -g "${selfRoot}"`
  const rm = process.platform === 'win32' ? 'del' : 'rm'
  const warn = (detail: string, fix: string): CommandOnPathRow => ({ check, status: 'warn', detail, fix, reachesThisBuild: false })

  if (shims.length === 0) {
    return warn(
      `no \`treecontext\` command on PATH — this report comes from ${here}`,
      isGlobalNpmLayout(selfRoot)
        ? `add ${globalShimDir(selfRoot)} to PATH (npm's global bin directory for this install)`
        : `${makeThis}   (links this checkout as the global command — build it first so dist/server/cli.js exists; until then, run it as ${selfCommandFor(thisCli)} <command>)`,
    )
  }

  const shim = shims[0]!
  const target = shimTarget(shim)
  if (target && !entryPointPresent(target)) {
    return warn(
      `${shim} points at ${target}, which no longer exists — typing \`treecontext\` runs nothing; this report comes from ${here}`,
      `${makeThis}   (replaces the dead command; or delete the shim: ${rm} "${shim}")`,
    )
  }
  const other = target ? buildIdentity(target) : null
  if (!other) {
    // A shim this reader cannot follow — Volta's binary, an asdf or pnpm
    // script, a hand-rolled wrapper. Ask it what it is.
    const probe = shimVersion(shim)
    if ('error' in probe) {
      return warn(
        `${shim} is on PATH but running it failed (${probe.error}) — typing \`treecontext\` fails; this report comes from ${here}`,
        `${makeThis}   (replaces the command; or delete the shim: ${rm} "${shim}")`,
      )
    }
    if (probe.version === self?.version) {
      return {
        check, status: 'ok', reachesThisBuild: false,
        detail: `${shim} reports v${probe.version}, the same version as this build — a shim this reader cannot follow, so whether it is the same copy is not knowable here`,
      }
    }
    return warn(
      `${shim} reports v${probe.version} — this report comes from ${here}. Typing \`treecontext\` gets the v${probe.version} build; anything \`install\` wrote from here points at this one`,
      `${makeThis}   (makes this build the command; make sure npm's global bin directory precedes ${dirname(shim)} on PATH)`,
    )
  }
  if (sameLocation(other.root, selfRoot)) {
    return { check, status: 'ok', reachesThisBuild: true, detail: `${shim} → this build (v${other.version})` }
  }
  if (other.name === self?.name && other.version === self.version) {
    // A checkout beside a global install of the same release — the
    // maintainer's own dogfood layout. Two builds, no defect: reported, not
    // warned about, and the fix lines below still reach THIS one by path.
    return {
      check, status: 'ok', reachesThisBuild: false,
      detail: `${shim} runs a different copy of v${other.version}, at ${other.root} — this report comes from ${selfRoot}; anything \`install\` wrote from here points at this copy`,
    }
  }
  return warn(
    `${shim} runs ${other.name} v${other.version} at ${other.root} — this report comes from ${here}. Typing \`treecontext\` gets the v${other.version} build; anything \`install\` wrote from here points at this one`,
    `${makeThis}   (makes this build the command; make sure npm's global bin directory precedes ${dirname(shim)} on PATH — to audit the other build first: node "${other.cli}" doctor)`,
  )
}

/**
 * Where the launcher's own fallback search lands when its pin is gone, or
 * null when it lands nowhere. Mirrors the generated body exactly rather than
 * probing wide (moduleFallbackExists is the wide probe, for the existence
 * grader): the POSIX loop walks posixModuleGlobs in order, each glob
 * expanding lexicographically, and the LAST match wins; the batch body
 * probes the fixed Windows prefixes in table order and the FIRST that
 * exists wins. This is the build the agent is actually running once a
 * version-manager upgrade has deleted the pinned one.
 */
export function moduleFallbackTarget(body: string): string | null {
  const rel = searchedModuleRel(body)
  if (!rel) return null
  const relParts = rel.split('/')
  const names = searchedPackageDirs(body)
  if (body.startsWith('@echo off')) {
    for (const name of names) {
      for (const prefix of MANAGED_WINDOWS_PREFIXES) {
        const base = process.env[prefix.env]
        if (!base) continue
        const c = join(base, ...prefix.sub, 'node_modules', name, ...relParts)
        if (existsSync(c)) return c
      }
    }
    return null
  }
  const candidates: string[] = []
  for (const name of PACKAGE_DIRS_LAST_WINS.filter(n => names.includes(n))) {
    for (const r of MANAGED_POSIX_ROOTS) candidates.push(join(r, name, ...relParts))
    for (const manager of [...MANAGED_VERSION_MANAGERS].reverse()) {
      const root = join(homedir(), ...manager.dir)
      for (const v of [...managedVersions(root)].sort()) {
        candidates.push(join(root, v, ...manager.inner, 'lib', 'node_modules', name, ...relParts))
      }
    }
  }
  let last: string | null = null
  for (const c of candidates) if (existsSync(c)) last = c
  return last
}

/**
 * The `Wired build` row: which build the agent actually talks to. `install`
 * bakes its own cli.js into the MCP launcher, so a launcher pinned under a
 * different package root than this one means a different build ran
 * `install` last — the agent's server and every hook are that build's,
 * whatever this report says about itself.
 *
 * A pin that is gone is not the end of the question: the wrapper carries a
 * fallback search, and when that search lands somewhere the agent is
 * running THAT — a deleted checkout beside a surviving global install is
 * exactly the case this row exists for, and the first cut went silent on
 * it (adversarial review, finding 1). Only a pin that is gone with nowhere
 * to land is left to hookScriptIssue, which reports the death: null here.
 */
export function wiredBuildRow(launcherBody: string, thisCli: string, selfCommand: string): DiagnosticResult | null {
  const pinned = launcherCliPath(launcherBody)
  if (!pinned) return null
  let entry = pinned
  let via = ''
  if (!entryPointPresent(pinned)) {
    const landed = moduleFallbackTarget(launcherBody)
    if (!landed) return null
    entry = landed
    via = ` — the pinned ${pinned} is gone, and the launcher's own search lands on ${landed}`
  }
  const self = buildIdentity(thisCli)
  const other = buildIdentity(entry)
  if (!self || !other) return null
  if (sameLocation(other.root, self.root)) {
    return { check: 'Wired build', status: 'ok', detail: `the MCP launcher and hooks run this build (v${self.version})${via}` }
  }
  if (other.name === self.name && other.version === self.version) {
    // The same rule as the PATH row: a checkout beside the global install
    // that owns the wiring (the dogfood layout) is two builds, no defect.
    return {
      check: 'Wired build', status: 'ok',
      detail: `the MCP launcher and hooks run a different copy of v${self.version}, at ${other.root} — this report comes from ${self.root}${via}`,
    }
  }
  return {
    check: 'Wired build', status: 'warn',
    detail: `the MCP launcher runs ${other.name} v${other.version} at ${other.root}, not this build (v${self.version} at ${self.root})${via} — that build ran install last, and your agent talks to it`,
    fix: `${selfCommand} install --force   (rewires the launcher and hooks to this build)`,
  }
}

export function interpreterIssue(command: string): string | null {
  const m = withoutExec(command).match(/^\s*(?:"([^"]+)"|(\S+))/)
  const tok = m ? (m[1] ?? m[2] ?? '') : ''
  if (tok === 'node' || tok === 'treecontext') {
    return `bare '${tok}' command (PATH-dependent — fails for GUI-launched agents)`
  }
  if (tok === 'npx') return null
  if (isAbsolute(tok) && !existsSync(tok)) {
    return `interpreter missing: ${tok} (node upgraded or removed since install)`
  }
  return null
}

/**
 * Recursively collect every string value that IS an invocation.
 *
 * `bash` and `powershell` are here because Copilot's hook schema spells the
 * invocation with one key per shell instead of a single `command`
 * (buildVscodeHooksConfig). Reading only `command` meant a Copilot config was
 * walked and nothing was found in it: doctor's interpreter grading, its
 * unmanaged-hooks row and the wrapper-ownership filters all looked straight
 * past the only strings that name anything executable.
 */
const COMMAND_KEYS = new Set(['command', 'bash', 'powershell'])

function collectCommandStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectCommandStrings(v, out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COMMAND_KEYS.has(k) && typeof v === 'string') out.push(v)
      else collectCommandStrings(v, out)
    }
  }
  return out
}

/**
 * The hook part of a hook settings file, and nothing else. Gemini keeps its
 * hooks in the same settings.json as its MCP registration, so walking the
 * whole file collected the MCP launcher (`…/tc-mcp-serve`) as if it were a
 * hook command, and a tools-only install read as "hooks present". Files
 * that nest hooks under a `hooks` key (Claude, Gemini, Copilot, Cursor) are
 * read there; Codex's hooks.json holds its events at the top level, so it is
 * read whole, minus any MCP registration key.
 */
function hookSubtree(data: Record<string, unknown>): unknown {
  const nested = data['hooks']
  if (nested && typeof nested === 'object') return nested
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'mcpServers' && k !== 'servers' && k !== 'mcp_servers') rest[k] = v
  }
  return rest
}

/** Command strings of a hook settings file's hooks — never its MCP entries. */
function hookCommandStrings(data: Record<string, unknown>): string[] {
  return collectCommandStrings(hookSubtree(data))
}

/** Matches commands that belong to treecontext (vs other tools' hooks). */
const TC_COMMAND_HINT_RE = /(hooks[\\/](gemini|vscode|codex|cursor)[\\/]|tc-|cli\.js|treecontext)/

/** First interpreter problem among treecontext-owned hook commands, or null. */
function hookSettingsInterpreterIssue(settings: Record<string, unknown>): string | null {
  for (const cmd of hookCommandStrings(settings)) {
    if (!TC_COMMAND_HINT_RE.test(cmd)) continue
    const issue = interpreterIssue(cmd)
    if (issue) return issue
  }
  return null
}

/** Absolute `.js` script targets referenced by a hook command string. */
function hookScriptTargets(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]+\.js)"|(\S+\.js)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    const p = m[1] ?? m[2]
    if (p && isAbsolute(p)) out.push(p)
  }
  return out
}

/** True when `target` lives inside the currently-running install's dist tree. */
function isCurrentInstallTarget(target: string): boolean {
  const root = resolve(dirname(resolveCliPath()), '..')
  return target === root || target.startsWith(root + sep)
}

/**
 * Advisory row for treecontext hooks found in an agent whose hooks `install`
 * does not manage.
 *
 * On every platform outside CAPTURE_PLATFORMS, `install` deliberately writes
 * no hook config — so it also never *rewrites* one left behind by an earlier
 * version or an `--experimental-capture` run. Grading those hooks on the
 * agent's own row produced a warning whose offered fix
 * (`install --force --agent <slug>`) is a no-op by construction: beta-1
 * testers ran it and watched the warning survive. The condition is real —
 * stale entries keep executing whatever build they name — so it gets its own
 * row, with a command that actually clears it.
 */
export function unmanagedHookState(
  agent: AgentDefinition, platform: Platform,
): { present: boolean; row: DiagnosticResult | null } {
  const absent = { present: false, row: null }
  const settingsPath = getHookSettingsPath(agent, platform)
  if (!settingsPath || !existsSync(settingsPath)) return absent

  const data = readJsonSafe(settingsPath)
  const ours = hookCommandStrings(data).filter(c => TC_COMMAND_HINT_RE.test(c))
  if (ours.length === 0) return absent

  const foreign: string[] = []
  let missingTarget = false
  for (const cmd of ours) {
    for (const target of hookScriptTargets(cmd)) {
      if (!existsSync(target)) missingTarget = true
      else if (!isCurrentInstallTarget(target)) foreign.push(target)
    }
  }
  const issue = hookSettingsInterpreterIssue(data)

  // Hooks that point at this install and run a resolvable interpreter are
  // working hooks — the state someone gets by opting in with
  // --experimental-capture. Warning about those would nag a user for doing
  // exactly what the flag invites, every time they run doctor. Only a real
  // defect earns the row: a foreign build, a vanished target, or a bad
  // interpreter. Those are the ones `install` will never come back to repair.
  if (foreign.length === 0 && !missingTarget && !issue) {
    return { present: true, row: null }
  }

  const notes = [`${settingsPath} — treecontext hooks present, but install does not manage hooks for ${agent.name} (capture unverified there), so they are never refreshed`]
  if (foreign.length > 0) notes.push(`they run a different treecontext build: ${foreign[0]}`)
  if (missingTarget) notes.push('some hook targets no longer exist')
  if (issue) notes.push(`hook ${issue}`)
  notes.push(`to reinstall them against this build: treecontext install --force --agent ${agent.slug} --experimental-capture`)

  return {
    present: true,
    row: {
      check: `${agent.name} hooks (unmanaged)`,
      status: 'warn',
      detail: notes.join('; '),
      fix: `treecontext uninstall --agent ${agent.slug} --hooks-only`,
    },
  }
}

// ── Doctor's row per client: mode, state, remedy (D161, D208) ─────

/**
 * How each documented client other than Claude Code meets the hooks: the
 * README compatibility matrix's Mode cell, verbatim (the binding compares
 * the two exactly), from D153/D154: it copies them
 * into its own configuration, reads the Claude settings file as-is, or has
 * no shell hooks at all. Doctor names this on the client's row, with the
 * state it found and the remedy, so no row is the half-answer D161 removes.
 */
export const CLIENT_HOOK_MODES: Readonly<Record<string, string>> = {
  codex: 'copies the hooks into its own configuration (~/.codex/hooks.json or [hooks] in ~/.codex/config.toml, repo .codex/hooks.json; same JSON contract as Claude Code)',
  gemini: 'copies the hooks into its own translated configuration (settings.json under .gemini/ or ~/.gemini/; same stdin/stdout shapes, renamed events, no subagent events)',
  vscode: 'reads the Claude settings file when its Claude-hooks setting is on (chat.useClaudeHooks, off by default; read as-is, matcher values ignored; also reads .github/hooks/*.json)',
  cursor: 'reads the Claude settings file by default (as-is, through its Include Third-Party configs setting)',
  opencode: 'offers no shell hooks, so the tools are its whole surface (the MCP tools; JS/TS plugins are not hooks)',
}

/** A client row's hook clause: the three halves D161 asks for, and its grade. */
export interface ClientHookReport {
  mode: string
  state: string
  remedy: string
  /** The state is wrong and the remedy is the fix. */
  warn: boolean
  fix?: string
  /** treecontext hooks are present in the client's own configuration. */
  hooksPresent: boolean
}

/**
 * Parse a JSON-with-comments file the way VS Code writes its settings:
 * line and block comments and trailing commas are allowed. Strings are
 * respected, so a URL's `//` inside a value is not a comment.
 */
export function parseJsonc(text: string): unknown {
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
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      // A comment between the comma and the bracket still makes it trailing.
      const next = firstSignificantChar(text.slice(j))
      if (next !== '}' && next !== ']') out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out)
}
/** The first character of `rest` that is neither whitespace nor inside a comment. */
function firstSignificantChar(rest: string): string {
  return rest.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '')[0] ?? ''
}

/** VS Code's user settings.json — beside the mcp.json install writes, in the directory detection looks for. */
export function vscodeUserSettingsPath(platform: Platform): string | null {
  const vscode = getAgent('vscode')
  const dir = (vscode?.detectDirs[platform] ?? vscode?.detectDirs.linux ?? [])[0]
  return dir ? join(dir, 'settings.json') : null
}

/** chat.useClaudeHooks as VS Code's user settings hold it. Off by default. */
export function vscodeClaudeHooksSetting(path: string): 'on' | 'off' | 'unset' | 'unreadable' {
  if (!existsSync(path)) return 'unset'
  let data: unknown
  try {
    data = parseJsonc(readFileSync(path, 'utf8'))
  } catch {
    return 'unreadable'
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unreadable'
  const v = (data as Record<string, unknown>)['chat.useClaudeHooks']
  if (v === undefined) return 'unset'
  return v === true ? 'on' : 'off'
}

/**
 * Whether the Claude Code hooks block is installed in the Claude settings
 * file, graded against the block install writes today: the same owned view
 * a copy is graded by, so "installed" means this build's block, not any
 * treecontext entry at all.
 */
export function claudeHooksBlockState(platform: Platform): 'installed' | 'stale' | 'absent' {
  const claude = getAgent('claude')
  const path = claude ? getHookSettingsPath(claude, platform) : null
  if (!path || !existsSync(path)) return 'absent'
  const view = ownedHookView(readJsonSafe(path)['hooks'])
  if (Object.keys(view).length === 0) return 'absent'
  return hookViewDifferences(view, ownedHookView(claudeHooksBlock())).length === 0 ? 'installed' : 'stale'
}

/** Where a copying client's hooks can live, each with the hooks map found there. */
function copiedHookSources(agent: AgentDefinition, platform: Platform): Array<{ where: string; hooks: unknown; unreadable?: boolean }> {
  const out: Array<{ where: string; hooks: unknown; unreadable?: boolean }> = []
  const hooksPath = getHookSettingsPath(agent, platform)
  if (hooksPath && existsSync(hooksPath)) {
    let data: Record<string, unknown> | null = null
    try {
      data = JSON.parse(readFileSync(hooksPath, 'utf8')) as Record<string, unknown>
    } catch {
      out.push({ where: hooksPath, hooks: {}, unreadable: true })
    }
    if (data && typeof data === 'object') {
      out.push({ where: hooksPath, hooks: data['hooks'] })
      if (agent.slug === 'codex') {
        // Earlier builds wrote Codex's entries at the top level of hooks.json.
        const top: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(data)) if (!CODEX_NON_EVENT_KEYS.has(k)) top[k] = v
        out.push({ where: `${hooksPath} (top level)`, hooks: top })
      }
    }
  }
  if (agent.slug === 'codex') {
    // Codex also reads a [hooks] table in config.toml.
    const configPath = getConfigPath(agent, platform)
    if (configPath && existsSync(configPath)) {
      try {
        const toml = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>
        if (toml['hooks'] !== undefined) out.push({ where: `[hooks] in ${configPath}`, hooks: toml['hooks'] })
      } catch { /* the MCP half of the row reports an unparseable config */ }
    }
  }
  return out
}

/**
 * The copying clients whose configuration still runs the Claude Code hook
 * scripts, leaving out `except` (the clients this very run removes).
 * Uninstalling Claude Code alone must not delete scripts these copies run.
 */
export function copiesRunningClaudeScripts(platform: Platform, except: ReadonlySet<string>): AgentDefinition[] {
  return AGENTS.filter(a => COPYING_CLIENTS.has(a.slug) && !except.has(a.slug)
    && copiedHookSources(a, platform).some(src => !src.unreadable
      && collectCommandStrings(src.hooks).some(c => runsOwnHookScript(c, CLAUDE_SCRIPT_NAMES))))
}

/**
 * A copying client's copy, graded against the block install would write
 * into it today (expectedHookCopy): present and consistent, present and
 * inconsistent (naming where and on which events), or not copied.
 */
export function copiedHookState(agent: AgentDefinition, platform: Platform): {
  state: 'absent' | 'consistent' | 'inconsistent'
  where: string[]
  problems: string[]
} {
  const expected = ownedHookView(expectedHookCopy(agent.slug))
  const where: string[] = []
  const problems: string[] = []
  for (const src of copiedHookSources(agent, platform)) {
    if (src.unreadable) {
      where.push(src.where)
      problems.push(`${src.where} does not parse`)
      continue
    }
    const view = ownedHookView(src.hooks)
    if (Object.keys(view).length === 0) continue
    where.push(src.where)
    const diff = hookViewDifferences(view, expected)
    if (diff.length > 0) problems.push(`differs on ${diff.join(' / ')}`)
  }
  if (where.length === 0) return { state: 'absent', where, problems }
  if (where.length > 1) {
    problems.push(`copied in more than one place, so the hooks would fire twice`)
  }
  if (problems.length === 0) {
    // A copy that matches but runs scripts that are gone captures nothing.
    const missing = claudeHookScriptPaths(platform).filter(p => !existsSync(p))
    if (missing.length > 0) {
      problems.push(`the hook scripts it runs are missing: ${missing.map(p => basename(p).replace(TC_HOOK_PREFIX, '')).join(' / ')}`)
    }
  }
  return { state: problems.length > 0 ? 'inconsistent' : 'consistent', where, problems }
}

/**
 * The hook clause of a documented client's doctor row — every client but
 * Claude Code, whose own row grades the block itself. Null for an agent the
 * mode table does not know.
 */
export function clientHookReport(agent: AgentDefinition, platform: Platform): ClientHookReport | null {
  const report = clientHookReportBase(agent, platform)
  if (!report || !AS_IS_CLIENTS.has(agent.slug)) return report
  // An as-is client with a copy of our hooks in its OWN configuration, from
  // an earlier build's --experimental-capture: a second route beside the
  // Claude settings file, so hooks would run twice — never "nothing to do"
  // (D226). Uninstalling the client's hooks removes it and leaves the tools.
  if (!unmanagedHookState(agent, platform).present) return report
  const own = getHookSettingsPath(agent, platform)
  const fix = `treecontext uninstall --agent ${agent.slug} --hooks-only`
  return {
    ...report,
    state: `${report.state} — and a copy of the hooks an earlier build wrote in ${own} runs beside it (two hook routes)`,
    remedy: `to remove the second route: ${fix}`,
    warn: true, fix, hooksPresent: true,
  }
}

function clientHookReportBase(agent: AgentDefinition, platform: Platform): ClientHookReport | null {
  const mode = CLIENT_HOOK_MODES[agent.slug]
  if (!mode) return null
  const copyCmd = `treecontext install --agent ${agent.slug} --experimental-capture`

  if (COPYING_CLIENTS.has(agent.slug)) {
    const copy = copiedHookState(agent, platform)
    const block = agent.slug === 'gemini' ? 'the translated Claude Code block' : 'the Claude Code block'
    if (copy.state === 'absent') {
      const path = getHookSettingsPath(agent, platform)
      return {
        mode,
        state: `hooks not copied into ${path} (capture unverified — MCP tools only)`,
        remedy: `to copy them: ${copyCmd}`,
        warn: false, hooksPresent: false,
      }
    }
    if (copy.state === 'consistent') {
      return {
        mode,
        state: `hooks copied into ${copy.where.join(' and ')}: present and consistent with ${block} (experimental capture — unverified)`,
        remedy: 'nothing to do',
        warn: false, hooksPresent: true,
      }
    }
    return {
      mode,
      state: `hooks copied into ${copy.where.join(' and ')}: present and inconsistent with ${block} (${copy.problems.join('; ')})`,
      remedy: `to rewrite the copy: ${copyCmd}`,
      warn: true, fix: copyCmd, hooksPresent: true,
    }
  }

  if (agent.slug === 'opencode') {
    return { mode, state: 'no hooks to install — MCP tools only (nothing is captured)', remedy: 'nothing to do', warn: false, hooksPresent: false }
  }

  const block = claudeHooksBlockState(platform)
  const blockText = block === 'installed'
    ? 'the Claude Code hooks block is installed'
    : block === 'stale'
      ? 'the Claude Code hooks block differs from what this build installs'
      : 'the Claude Code hooks block is not installed'
  const installClaude = 'treecontext install --agent claude'

  if (agent.slug === 'cursor') {
    if (block === 'installed') {
      return { mode, state: `${blockText} — Cursor reads it (capture unverified)`, remedy: 'nothing to do', warn: false, hooksPresent: false }
    }
    return {
      mode,
      state: block === 'stale' ? `${blockText} — Cursor reads the stale block` : `${blockText} — Cursor has nothing to read (MCP tools only)`,
      remedy: `to ${block === 'stale' ? 'rewrite' : 'install'} it: ${installClaude}`,
      warn: block === 'stale', ...(block === 'stale' ? { fix: installClaude } : {}), hooksPresent: false,
    }
  }

  // VS Code: the block, behind chat.useClaudeHooks.
  const settingsPath = vscodeUserSettingsPath(platform)
  const setting = settingsPath ? vscodeClaudeHooksSetting(settingsPath) : 'unset'
  const settingText = setting === 'on'
    ? `chat.useClaudeHooks is on in ${settingsPath}`
    : setting === 'off'
      ? `chat.useClaudeHooks is off in ${settingsPath}`
      : setting === 'unset'
        ? `chat.useClaudeHooks is off (not set in ${settingsPath} — VS Code's default)`
        : `chat.useClaudeHooks could not be read (${settingsPath} does not parse)`
  const turnOn = "turn chat.useClaudeHooks on in VS Code's settings"
  if (block === 'installed') {
    if (setting === 'on') {
      return { mode, state: `${settingText} and ${blockText} — VS Code runs it (capture unverified)`, remedy: 'nothing to do', warn: false, hooksPresent: false }
    }
    return {
      mode,
      state: `${settingText} and ${blockText}`,
      remedy: setting === 'unreadable'
        ? `fix ${settingsPath} so it parses and then ${turnOn}`
        : `to have VS Code run the Claude Code hooks: ${turnOn} (capture there stays unverified)`,
      warn: false, hooksPresent: false,
    }
  }
  return {
    mode,
    state: `${settingText} and ${blockText}`,
    remedy: `to ${block === 'stale' ? 'rewrite' : 'install'} the block: ${installClaude}${setting === 'on' ? '' : ` and then ${turnOn}`}`,
    warn: block === 'stale' && setting === 'on',
    ...(block === 'stale' && setting === 'on' ? { fix: installClaude } : {}),
    hooksPresent: false,
  }
}

// ── The ccr join, reported link by link ────────────────────────────

/** How long ago a file was last written, in the pane's own vocabulary. */
function ageOf(path: string): string {
  try {
    const ms = Date.now() - statSync(path).mtimeMs
    if (ms < 90_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`
    if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m ago`
    if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
  } catch {
    return 'unknown'
  }
}

/**
 * ccr's version, or null when it is not installed. Best-effort by
 * construction: a doctor row is not worth hanging a terminal over, so the
 * probe is bounded and every failure reads as "not found" rather than
 * throwing into the report.
 */
function probeCcrVersion(): string | null {
  if (!isCommandAvailable('ccr')) return null
  const read = (file: string, args: string[]): string | null => {
    try {
      return execFileSync(file, args, {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  }
  // On Windows `ccr` is a .cmd shim, and execFile cannot run one without a
  // shell — so the direct call always failed there and every Windows
  // report said "version unknown", on the platform the testers are on.
  // The command is a literal, so the cmd.exe hop carries no user input.
  const out = read('ccr', ['--version'])
    ?? (process.platform === 'win32'
      ? read(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'ccr --version'])
      : null)
  if (out === null) return 'version unknown'
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? m[0] : 'version unknown'
}

/** Numeric semver compare, enough for a floor check. Unknown sorts high. */
function compareVersions(a: string, b: string): number {
  if (!/^\d/.test(a)) return 1
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * One row for the config file itself. Each arm is a state ccr renders
 * identically — as nothing at all — which is exactly why they are worth
 * separating here.
 */
function describeCcrConfig(state: CcrConfigState, path: string): DiagnosticResult {
  const wire = 'treecontext ccr wire'
  switch (state.kind) {
    case 'missing':
      return { check: 'ccr config', status: 'warn', detail: `${path} does not exist — ccr has no panes to draw`, fix: wire }
    case 'empty':
      return { check: 'ccr config', status: 'warn', detail: `${path} is empty`, fix: wire }
    case 'not-a-file':
      return {
        check: 'ccr config', status: 'warn',
        detail: `${path} is ${state.what} — ccr expects a JSON file there`,
        fix: 'move it aside yourself, or point CCR_CONFIG at a file',
      }
    case 'too-large':
      return {
        check: 'ccr config', status: 'warn',
        detail: `${path} is ${Math.round(state.bytes / 1024)}KB — past the window ccr reads, so it draws no panes from it`,
        fix: 'trim the file, or point CCR_CONFIG at a smaller one',
      }
    case 'bom':
      return {
        check: 'ccr config', status: 'warn',
        detail: `${path} starts with a UTF-8 byte-order mark — ccr's JSON.parse rejects it and renders "no panes configured"`,
        fix: `${wire} (rewrites it as BOM-free UTF-8, keeping your other panes)`,
      }
    case 'utf16':
      return {
        check: 'ccr config', status: 'warn',
        detail: `${path} is UTF-16 (what PowerShell's \`>\` writes) — ccr reads it as UTF-8 and finds no panes`,
        fix: `${wire} (rewrites it as UTF-8, keeping your other panes)`,
      }
    case 'unparseable':
      return {
        check: 'ccr config', status: 'warn',
        detail: `${path} is not valid JSON (${state.error}) — ccr renders that as "no panes configured", silently`,
        fix: `${wire} --force (moves it aside to .bak and writes a fresh one)`,
      }
    case 'not-object':
      return { check: 'ccr config', status: 'warn', detail: `${path} holds JSON that is not an object`, fix: `${wire} --force` }
    case 'no-panes':
      return { check: 'ccr config', status: 'warn', detail: `${path} parses but has no "panes" array`, fix: wire }
    case 'ok': {
      const bare = state.entries.filter((e) => e.shape === 'bare-string').length
      const unusable = state.entries.filter((e) => e.shape === 'unusable').length
      const notes: string[] = []
      if (bare > 0) notes.push(`${bare} bare-string entr${bare === 1 ? 'y' : 'ies'} ccr skips`)
      if (unusable > 0) notes.push(`${unusable} entr${unusable === 1 ? 'y' : 'ies'} of an unusable shape`)
      return {
        check: 'ccr config', status: notes.length > 0 ? 'warn' : 'ok',
        detail: `${path}: ${state.entries.length} pane entr${state.entries.length === 1 ? 'y' : 'ies'}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
        ...(notes.length > 0 ? { fix: wire } : {}),
      }
    }
  }
}

/** The processes around a locked store (D175). Only the holder of a WRITE
 *  lock on the database file is the cause; a running `treecontext serve`
 *  or any other reader keeps the file open too. Whether the two can be
 *  told apart depends on the platform, and the row doctor renders must
 *  never claim more than the platform said. Every list excludes this
 *  process. */
export interface StoreLockProcesses {
  /** pids known to hold the write lock (Linux, through /proc/locks, is the platform that can say). */
  holders: number[]
  /** Every other pid with the file open, with a short command label where the platform gives one. */
  openers: Array<{ pid: number; command?: string }>
  /** True when holder can be told from bystander: Linux with /proc/locks readable, or a lock lsof actually reported. */
  canTellHolder: boolean
}

let storeLockProbeOverride: ((dbPath: string) => StoreLockProcesses) | null = null

/** Seam for tests: replace the platform probe (null restores it). */
export function setStoreLockProbeForTests(fn: ((dbPath: string) => StoreLockProcesses) | null): void {
  storeLockProbeOverride = fn
}

/** Restart Manager (rstrtmgr.dll) asks Windows which processes hold a
 *  file open — the one API that answers without native code of our own.
 *  It cannot say which of them owns a byte-range lock. The path arrives
 *  in an environment variable so no quoting reaches the script. */
const WINDOWS_OPENERS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TreecontextRm {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static string[] List(string path) {
    uint handle;
    var lines = new List<string>();
    if (RmStartSession(out handle, 0, new StringBuilder(64)) != 0) return lines.ToArray();
    try {
      if (RmRegisterResources(handle, 1, new string[] { path }, 0, IntPtr.Zero, 0, null) != 0) return lines.ToArray();
      uint needed = 0, count = 0, reasons = 0;
      int rc = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (rc != 234 || needed == 0) return lines.ToArray();
      var info = new RM_PROCESS_INFO[needed];
      count = needed;
      if (RmGetList(handle, out needed, ref count, info, ref reasons) != 0) return lines.ToArray();
      for (int i = 0; i < count; i++) lines.Add(info[i].Process.dwProcessId + "\\t" + info[i].strAppName);
      return lines.ToArray();
    } finally { RmEndSession(handle); }
  }
}
'@
[TreecontextRm]::List($env:TREECONTEXT_LOCKED_STORE) | ForEach-Object { [Console]::Out.WriteLine($_) }
`

/** Probe who has a locked store open, as honestly as this platform can.
 *  Linux reads /proc/locks by the file's inode for the holder; lsof
 *  (`-F pcl`) lists openers with their command, and on Darwin its lock
 *  field — which does not report fcntl locks, so in practice never names
 *  a holder there. Windows asks the Restart Manager from PowerShell.
 *  Nothing named is better than a wrong name: any failure leaves a list
 *  empty. */
export function probeStoreLock(dbPath: string): StoreLockProcesses {
  if (storeLockProbeOverride) return storeLockProbeOverride(dbPath)
  const holders = new Set<number>()
  const openers = new Map<number, string | undefined>()
  let canTellHolder = false
  if (process.platform === 'win32') {
    try {
      // -EncodedCommand (base64 UTF-16LE): the C# carries double quotes,
      // and Windows argv quoting of a multi-line -Command is fragile.
      const encoded = Buffer.from(WINDOWS_OPENERS_SCRIPT, 'utf16le').toString('base64')
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TREECONTEXT_LOCKED_STORE: dbPath },
      })
      if (r.status === 0) {
        for (const line of (r.stdout ?? '').split(/\r?\n/)) {
          const m = /^(\d+)\t(.*)$/.exec(line)
          if (m && Number(m[1]) > 0) openers.set(Number(m[1]), m[2]!.trim() || undefined)
        }
      }
    } catch { /* nothing named is better than a wrong name */ }
  } else {
    try {
      if (process.platform === 'linux' && existsSync('/proc/locks')) {
        const ino = statSync(dbPath).ino
        const locks = readFileSync('/proc/locks', 'utf8')
        canTellHolder = true
        for (const line of locks.split('\n')) {
          // "1: POSIX  ADVISORY  WRITE 12345 08:02:1234567 0 EOF"
          const m = /^\d+:\s+(?:->\s+)?\S+\s+\S+\s+(READ|WRITE)\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/i.exec(line)
          if (m && m[1]!.toUpperCase() === 'WRITE' && Number(m[3]) === ino) holders.add(Number(m[2]))
        }
      }
    } catch { canTellHolder = false; holders.clear() }
    try {
      const r = spawnSync('lsof', ['-F', 'pcl', '--', dbPath], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      let pid = 0
      for (const field of (r.stdout ?? '').split('\n')) {
        if (field.startsWith('p')) { pid = Number(field.slice(1)); if (pid) openers.set(pid, undefined) }
        else if (field.startsWith('c') && pid) openers.set(pid, field.slice(1) || undefined)
        else if (field.startsWith('l') && pid && /[wW]/.test(field.slice(1)) && process.platform !== 'linux') {
          holders.add(pid)
          canTellHolder = true
        }
      }
    } catch { /* nothing named is better than a wrong name */ }
  }
  holders.delete(process.pid)
  openers.delete(process.pid)
  return {
    holders: [...holders],
    openers: [...openers].filter(([pid]) => !holders.has(pid)).map(([pid, command]) => (command ? { pid, command } : { pid })),
    canTellHolder: canTellHolder || holders.size > 0,
  }
}

function platformName(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'linux': return 'Linux'
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    default: return platform
  }
}

/** The doctor row for a locked store (D175): the piece that is down and
 *  the one command that clears it. Where the platform names the holder,
 *  the fix kills that one and the other openers are left be. Where it
 *  cannot (Darwin's lsof does not see fcntl locks; Windows has no
 *  lock-holder API), nobody is called "not the cause": the one command
 *  stops every process with the store open, which is what clears it. */
export function storeLockRow(label: string, dbPath: string, found: StoreLockProcesses, platform: NodeJS.Platform = process.platform): DiagnosticResult {
  const down = `${label} is locked by another process`
  const wait = ' — reads and captures wait on it until it lets go'
  const windows = platform === 'win32'
  const pids = found.openers.map((o) => o.pid)
  if (found.holders.length > 0 || (found.canTellHolder && !windows)) {
    return {
      check: 'Store lock', status: 'error',
      detail: `${down}${found.holders.length > 0 ? ` (pid ${found.holders.join(', ')})` : ''}${wait}`
        + (pids.length > 0 ? `; also open, and not the cause: pid ${pids.join(', ')} (a running server or reader — leave it be)` : ''),
      fix: found.holders.length > 0
        ? (windows ? `taskkill /F ${found.holders.map((p) => `/PID ${p}`).join(' ')}` : `kill ${found.holders.join(' ')}`)
        : `lsof "${dbPath}"   # the process holding a write lock (W) is the cause; stop that one`,
    }
  }
  if (pids.length > 0) {
    const named = found.openers.map((o) => `pid ${o.pid}${o.command ? ` (${o.command})` : ''}`).join(', ')
    // The fix is the bare command: a trailing `# note` is fine in sh, but
    // on Windows neither cmd's `& rem` nor PowerShell's `#` survives the
    // other shell, so the note lives here in the detail instead.
    return {
      check: 'Store lock', status: 'error',
      detail: `${down}${wait}; ${platformName(platform)} cannot say which of the processes holding it open owns the lock: ${named}`
        + ' — the fix stops every one of them, and a running server reopens the store on the next session',
      fix: windows ? `taskkill /F ${pids.map((p) => `/PID ${p}`).join(' ')}` : `kill ${pids.join(' ')}`,
    }
  }
  return {
    check: 'Store lock', status: 'error',
    detail: `${down}${wait}; no process was found holding it open at the moment doctor looked`,
    fix: windows
      ? 'Run treecontext doctor again; if the lock persists, close the other Claude Code and editor windows that use this project'
      : `Run treecontext doctor again; if the lock persists, lsof "${dbPath}" lists every process with the store open`,
  }
}

export async function doctor(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = []
  const platform = process.platform as Platform

  // One layout scan per run: the wrapper-body grading below asks the same
  // nvm/fnm question of every script it reads, and the answer cannot change
  // meaningfully inside one report. Clearing it here (rather than never) keeps
  // a second doctor run in the same process honest about the disk.
  resetManagedLayoutScan()

  console.log(`treecontext doctor v${getVersion()}\n`)
  console.log(`Platform: ${process.platform}/${process.arch}`)

  // Node version — validate against better-sqlite3's supported range
  const nodeVer = process.version
  const major = parseInt(nodeVer.slice(1), 10)
  const supportedMajors = [20, 22, 23, 24, 25]
  if (supportedMajors.includes(major)) {
    results.push({ check: 'Node.js', status: 'ok', detail: nodeVer })
  } else if (major > 25) {
    results.push({
      check: 'Node.js', status: 'error',
      detail: `${nodeVer} — better-sqlite3 has no prebuild for Node ${major} yet`,
      fix: `Switch to Node ${supportedMajors[supportedMajors.length - 1]}.x (latest stable with native dep support)`,
    })
  } else {
    results.push({ check: 'Node.js', status: 'error', detail: `${nodeVer} (requires 20+)`, fix: 'Install Node.js 20+' })
  }

  // Which build is which: the command the shell runs versus the one printing
  // this. Before the launcher rows, because their fix command depends on it —
  // `treecontext install --force` only reaches this build when PATH does.
  const thisCli = resolveCliPath()
  const pathRow = commandOnPathRow(commandsOnPath('treecontext'), thisCli)
  results.push(pathRow)
  // `treecontext install --force` reaches this build only when typing
  // `treecontext` runs exactly this build — a same-version copy elsewhere
  // does not qualify, or the fix would rewire the agent to that copy.
  const selfCommand = pathRow.reachesThisBuild ? 'treecontext' : selfCommandFor(thisCli)

  // better-sqlite3 — actually open a temp database to catch stale ABI
  try {
    const Database = (await import('better-sqlite3')).default
    const testDb = new Database(':memory:')
    testDb.exec('SELECT 1')
    testDb.close()
    results.push({ check: 'better-sqlite3', status: 'ok', detail: 'native binding loaded and working' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isAbiMismatch = msg.includes('bindings') || msg.includes('NODE_MODULE_VERSION') || msg.includes('was compiled against')
    results.push({
      check: 'better-sqlite3', status: 'error',
      detail: isAbiMismatch
        ? `stale native binding (compiled for different Node version)`
        : `failed to load: ${msg.slice(0, 100)}`,
      fix: isAbiMismatch
        ? 'npm rebuild better-sqlite3'
        : 'npm install better-sqlite3',
    })
  }

  // Hook interpreter — the binding check above used the node running doctor,
  // which is not necessarily the node the wrappers pick. When they differ and
  // the wrappers' choice cannot load the binding, every capture hook dies on
  // require and swallows the error (`2>/dev/null; exit 0`): hooks look like
  // they are running and nothing is ever stored. Probe what they actually run.
  const launcher = mcpLauncherPath()
  if (existsSync(launcher)) {
    const launcherBody = readFileSync(launcher, 'utf8')
    const wired = wiredBuildRow(launcherBody, thisCli, selfCommand)
    if (wired) results.push(wired)
    const wrapperNode = launcherInterpreter(launcherBody)
    if (!wrapperNode) {
      results.push({
        check: 'Hook interpreter', status: 'warn',
        detail: 'wrappers resolve node at runtime with no verified interpreter pinned',
        fix: 'treecontext install --force',
      })
    } else if (wrapperNode === process.execPath) {
      results.push({ check: 'Hook interpreter', status: 'ok', detail: `${wrapperNode} (same as this process)` })
    } else if (nodeLoadsBinding(wrapperNode)) {
      results.push({ check: 'Hook interpreter', status: 'ok', detail: `${wrapperNode} — binding loads` })
    } else {
      results.push({
        check: 'Hook interpreter', status: 'error',
        detail: `${wrapperNode} cannot load better-sqlite3 — hooks run but capture nothing (their errors are suppressed)`,
        fix: 'treecontext install --force',
      })
    }
  }

  // Store directory
  const storesDir = join(homedir(), '.treecontext', 'stores')
  if (existsSync(storesDir)) {
    // Existence alone is not health: an unreadable stores dir made every
    // downstream section degrade to its empty case, so doctor printed a
    // green 'no stores yet' for a machine full of stores it could not
    // enumerate (third-pass review). The dedicated row names the real
    // problem; the sections below then stay silent rather than claim.
    try {
      readdirSync(storesDir)
      results.push({ check: 'Store directory', status: 'ok', detail: storesDir })
    } catch (e) {
      results.push({
        check: 'Store directory', status: 'error',
        detail: `${storesDir} exists but cannot be read: ${e instanceof Error ? e.message : String(e)}`,
        fix: `check ownership and permissions on ${storesDir}`,
      })
    }
  } else {
    // Not a failure and not fixable — the directory is created on first use.
    // Reporting it as a warning made it the one row carrying no fix command,
    // which is the charter's "every failing check is accompanied by the
    // command that fixes it" broken on a technicality: it was never a
    // failing check.
    results.push({ check: 'Store directory', status: 'ok', detail: 'not created yet (created on first use)' })
  }

  // Store schema — the check whose absence made a dead server look healthy.
  //
  // Every row above validates an *installation artifact* (a config file, a
  // registration, an interpreter). None of them opens a store, so a v0.0.10
  // doctor reported all-clear on a machine whose MCP server was refusing to
  // start on every launch: the bound store sat below the schema head and the
  // failure lived in data the installer never looked at. Health of the
  // install is not health of the thing the install runs on.
  //
  // Read-only and version-only on purpose: doctor diagnoses, it does not
  // migrate, and opening read-only cannot create -wal/-shm files or take a
  // lock away from a running server.
  await (async () => {
    if (!existsSync(storesDir)) return
    // Unreadable: the Store-directory row above already carries the
    // error — a green 'no stores yet' here would contradict it.
    try {
      readdirSync(storesDir)
    } catch {
      return
    }
    // The walk is listStoreDirs — same enumeration as stores list, the
    // sweep, and the backup section below; this section then narrows to
    // directories that actually hold a database.
    const { listStoreDirs } = await import('../tools/stores.js')
    const storeDirs = listStoreDirs(storesDir)
      .filter(({ path }) => existsSync(join(path, 'treecontext.db')))
      .map(({ name }) => name)
    if (storeDirs.length === 0) {
      results.push({ check: 'Store schema', status: 'ok', detail: 'no stores yet (created on first use)' })
      return
    }

    const { maxSupportedVersion, migrations } = await import('../persistence/migrations/index.js')
    const Database = (await import('better-sqlite3')).default

    // Name the store this cwd is bound to — the global-vs-project split is
    // invisible otherwise, and a store that is only reached from one
    // directory is exactly the one a user reports as "works in my project".
    //
    // lookupStoreName, never resolveStoreName: the latter writes a binding
    // on a miss, which would make running `doctor` anywhere register that
    // directory. A diagnostic that edits the configuration it reports on is
    // no longer describing the system the user has.
    let boundStore: string | null = null
    try {
      const { lookupStoreName } = await import('./bindings.js')
      boundStore = lookupStoreName(process.cwd())
    } catch { /* binding is advisory here */ }
    // Only claim a binding we can point at on disk — naming a store that is
    // absent from the list above reads as if it were one of them.
    if (boundStore !== null && !storeDirs.includes(boundStore)) boundStore = null

    const behind: string[] = []
    const ahead: string[] = []
    const unreadable: string[] = []
    const locked: Array<{ label: string; path: string }> = []
    const roleHolders: string[] = []
    for (const name of storeDirs) {
      const label = name === boundStore ? `${name} (this directory)` : name
      try {
        // A short busy wait: a store another process holds locked must be
        // named as locked (D175), not leave doctor hanging on it.
        const db = new Database(join(storesDir, name, 'treecontext.db'), { readonly: true, timeout: 1000 })
        const raw = db.pragma('user_version') as Array<{ user_version: number }> | number
        // Role holders via the same leaseHolders() the lease client's
        // tests pin (G4 — closes C-review finding 10): read-only, so
        // doctor can never take a role away from a running server. Only
        // a missing table means "pre-arbiter store" — any OTHER failure
        // is itself a diagnostic, not silence: this line exists exactly
        // for the user debugging a refusal.
        try {
          for (const l of leaseHolders(db as unknown as Parameters<typeof leaseHolders>[0])) {
            roleHolders.push(
              `${name}: ${l.role} held by pid ${l.holderPid}@${l.holderHost}${l.live ? '' : ' (expired)'}`,
            )
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/no such table/i.test(msg)) {
            roleHolders.push(`${name}: leases unreadable (${msg})`)
          }
        }
        db.close()
        const v = typeof raw === 'number' ? raw : (raw[0]?.user_version ?? 0)
        if (v > maxSupportedVersion) ahead.push(`${label} at v${v}`)
        else if (v < maxSupportedVersion) {
          const pending = migrations.filter((m) => m.version > v)
          const destructive = pending.filter((m) => m.kind === 'destructive').length
          behind.push(`${label} at v${v}→v${maxSupportedVersion}${destructive > 0 ? `, ${destructive} destructive` : ''}`)
        }
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code
        if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || (e instanceof Error && /database is locked/i.test(e.message))) {
          locked.push({ label, path: join(storesDir, name, 'treecontext.db') })
        } else {
          unreadable.push(`${label} (${e instanceof Error ? e.message : String(e)})`)
        }
      }
    }

    for (const l of locked) {
      // D175: name the piece that is down and the one command that clears
      // it, claiming no more about the holder than the platform can say.
      results.push(storeLockRow(l.label, l.path, probeStoreLock(l.path)))
    }

    if (ahead.length > 0) {
      results.push({
        check: 'Store schema', status: 'error',
        detail: `${ahead.join('; ')} — newer than this build (max v${maxSupportedVersion})`,
        fix: 'Upgrade treecontext: npm install -g treecontext@latest',
      })
    }
    if (unreadable.length > 0) {
      results.push({
        check: 'Store schema', status: 'error',
        detail: `cannot read ${unreadable.join('; ')}`,
        fix: 'Move the store aside to start clean: mv ~/.treecontext/stores/<name> ~/.treecontext/stores/<name>.bak',
      })
    }
    if (behind.length > 0) {
      results.push({
        check: 'Store schema', status: 'warn',
        detail: `${behind.join('; ')} — migrates on next server start`,
        fix: 'Normally automatic. If the server fails to connect instead, run: treecontext doctor --dump-logs',
      })
    }
    if (roleHolders.length > 0) {
      results.push({
        check: 'Store roles', status: 'ok',
        detail: roleHolders.join('; '),
      })
    }
    if (ahead.length === 0 && unreadable.length === 0 && behind.length === 0 && locked.length === 0) {
      results.push({
        check: 'Store schema', status: 'ok',
        detail: `${storeDirs.length} store${storeDirs.length !== 1 ? 's' : ''} at v${maxSupportedVersion}${boundStore ? ` (this directory: ${boundStore})` : ''}`,
      })
    }

    // Sidecar pane path. Store directories are named by hashed project
    // identity, so a user wiring the pane into a renderer would otherwise
    // have to work out which of forty directories is theirs. Reported, not
    // checked: an absent pane means no server has drained here yet, which
    // is the honest state and not a fault.
    //
    // The fix line is a PASTE-READY config entry, forward slashes on every
    // platform: a Windows path printed with backslashes and pasted into
    // ccr's config.json is invalid JSON (`\U`, `\.` are illegal escapes),
    // and ccr's defensive parse renders a malformed config as "no panes
    // configured" — silently. Both 0.0.16-beta field reports ("the pane
    // never registered", mac + windows) were this wiring seam; Node accepts
    // forward-slash paths on Windows, so the snippet sidesteps the whole
    // class (2026-08-15).
    //
    // The config FILE is named the same way — resolved, never spelled `~`.
    // ccr (src/pane-config.js) reads CCR_CONFIG, else
    // $XDG_CONFIG_HOME/ccr/config.json, else ~/.config/ccr/config.json — on
    // EVERY platform, so on Windows that is %USERPROFILE%\.config, never
    // %APPDATA%. A `~` printed at a PowerShell user names no path they can
    // act on, and a wired pane nobody cycles to looks identical to a broken
    // one, so the line also names the key (2026-08-21).
    if (boundStore !== null) {
      const paneDir = join(storesDir, boundStore)
      const pane = join(paneDir, SIDECAR_JOURNAL_FILE)
      const ccrConfig = ccrConfigPath()
      // ── The join, link by link ──────────────────────────────────
      //
      // Closed-beta reports were unanimous and unhelpful in the same way:
      // "the pane never showed up." Every link between our file and ccr's
      // panel can break silently — ccr renders ANY config problem as "no
      // panes configured" by its own survive-a-typo ruling — so a doctor
      // that only prints our side of the seam confirms the half nobody
      // doubted. These rows walk the rest of it (2026-08-22).
      const ccrState = readCcrConfig(ccrConfig)
      const ccrVersion = probeCcrVersion()
      // Quiet for people who do not use ccr: with no ccr on PATH and no
      // config of its own, there is no join to report on, and a standing
      // warn about an uninstalled optional renderer is just noise.
      const usesCcr = ccrVersion !== null || ccrState.kind !== 'missing'
      // Symlinks on either side (a symlinked home, a store dir reached
      // through a link) would otherwise make a correctly wired pane read
      // as "not wired" — a false alarm in the one row people trust.
      const canonical = (p: string): string => {
        try { return realpathSync.native(p) } catch { return p }
      }
      const wanted = new Set(
        [SIDECAR_JOURNAL_FILE, 'sidecar-threads.json', 'sidecar-trail.json']
          .flatMap((f) => { const abs = join(paneDir, f); return [abs, canonical(abs)] }),
      )
      const isOurs = (resolved: string): boolean => wanted.has(resolved) || wanted.has(canonical(resolved))
      const wiredHere = ccrState.kind === 'ok'
        && ccrState.entries.some((e) => e.shape === 'object' && isOurs(e.resolved))

      results.push({
        check: 'Sidecar pane',
        status: 'ok',
        detail: existsSync(pane)
          ? `${pane} (written ${ageOf(pane)})`
          : `${pane} (written on the first drain)`,
        ...(wiredHere ? {} : { fix: 'show it in ccr: treecontext ccr wire' }),
      })

      // 1. The renderer. Panes need ccr 0.3.0 or newer; below that there
      // is no pane cycle for a correct config to appear in.
      if (!usesCcr) {
        // Nothing further to say, and saying it would be noise.
      } else if (ccrVersion === null) {
        results.push({
          check: 'ccr renderer', status: 'warn',
          detail: `ccr is configured (${ccrConfig}) but not on PATH — nothing is drawing the panes`,
          fix: 'npm i -g claude-code-runrate',
        })
      } else if (compareVersions(ccrVersion, CCR_MIN_VERSION) < 0) {
        results.push({
          check: 'ccr renderer', status: 'warn',
          detail: `ccr ${ccrVersion} — older than ${CCR_MIN_VERSION}, which is where the pane cycle shipped`,
          fix: 'npm i -g claude-code-runrate',
        })
      } else {
        results.push({ check: 'ccr renderer', status: 'ok', detail: `ccr ${ccrVersion} (panes shipped in ${CCR_MIN_VERSION})` })
      }

      // 2. The config file, named as ccr resolves it — and each way it can
      // be present but unreadable, which is the invisible class.
      if (usesCcr) results.push(describeCcrConfig(ccrState, ccrConfig))

      // 3. Whether THIS project's pane is among the entries ccr will read.
      if (!usesCcr) {
        // No renderer, no config: the pane file is written and that is all
        // treecontext can honestly claim.
      } else if (ccrState.kind === 'ok') {
        const listed = ccrState.entries.filter((e) => isOurs(e.resolved))
        const drawable = listed.filter((e) => e.shape === 'object')
        const skipped = listed.filter((e) => e.shape === 'bare-string')
        if (drawable.length > 0) {
          results.push({
            check: 'ccr pane wiring', status: 'ok',
            detail: `this project's pane${drawable.length > 1 ? 's are' : ' is'} listed (${drawable.length} of ${ccrState.entries.length} configured pane(s))`,
          })
        } else if (skipped.length > 0) {
          results.push({
            check: 'ccr pane wiring', status: 'warn',
            detail: `this project's pane is listed as a bare string, which ccr skips without a word`,
            fix: 'treecontext ccr wire',
          })
        } else {
          results.push({
            check: 'ccr pane wiring', status: 'warn',
            detail: `${ccrConfig} lists ${ccrState.entries.length} pane(s), none of them this project's`,
            fix: 'treecontext ccr wire',
          })
        }
      } else {
        results.push({
          check: 'ccr pane wiring', status: 'warn',
          detail: 'this project\'s pane is not wired into ccr',
          fix: 'treecontext ccr wire',
        })
      }

      // 4. The step no config can substitute for. A wired pane is invisible
      // until the view is cycled, and Windows Terminal binds no key at all.
      const hint = cycleHint()
      const instances = ccrInstanceDirs()
      if (usesCcr) results.push({
        check: 'ccr pane viewing', status: 'ok',
        detail: `${hint.host}: ${hint.move}`
          + (instances.length === 0 ? ' — no ccr instance dir under ~/.ccr/instances yet' : ''),
        ...(instances.length === 0 ? { fix: 'start the sidecar first: run `ccr` in your project' } : {}),
      })
    }
  })()

  // Split candidates — one project, two journals (§4, amended 2026-08-20).
  //
  // The identity defect this reports: a directory bound by path before it
  // had a remote, gained one, and bound again — two stores holding one
  // project's journal, with nothing inside either one able to show the
  // other. Phase 1a's succession stops new splits; the ones already on
  // disk are only visible from outside, and doctor is outside.
  //
  // READ-ONLY twice over, and deliberately so. It reads the bindings FILE
  // (readBindingsSnapshot — not resolveStoreName, which left a binding
  // behind for every directory doctor ran from, and not even
  // lookupStoreName, which derives an identity for one directory: a check
  // describing the whole machine has no directory to derive from). It
  // opens each store through describeStore — readonly, fileMustExist, no
  // migration — the same idiom the schema section above uses, so a store
  // that is missing or unopenable costs a "?" and never a crash.
  await (async () => {
    let projects: import('./split-candidates.js').BoundProjects
    try {
      const { readBindingsSnapshot } = await import('./bindings.js')
      projects = readBindingsSnapshot().projects
    } catch {
      // An unreadable bindings file is the resolver's diagnosis to make,
      // not this check's — and a claim about splits built on nothing read
      // would be worse than silence.
      return
    }
    const bindingCount = Object.keys(projects).length
    // Nothing bound: no claim to make, exhaustive or otherwise.
    if (bindingCount === 0) return

    const { findSplitCandidates, carriedForwardBindings } = await import('./split-candidates.js')
    const { describeStore } = await import('../tools/stores.js')
    const { isCliAddressableStoreName } = await import('../tools/store-name.js')

    // Total nodes, or an honest "?" — an absent store, an unreadable one,
    // and a pre-`nodes` store all degrade the same way. describeStore
    // never migrates and never writes.
    const nodes = (store: string): string => {
      try {
        const desc = describeStore(join(storesDir, store), store)
        return desc.totalNodes === null ? '?' : String(desc.totalNodes)
      } catch {
        return '?'
      }
    }

    const candidates = findSplitCandidates(projects)
    for (const c of candidates) {
      // A pair is only a two-journal split when both sides hold a store
      // ON DISK. A side with no database is a DANGLING BINDING — residue
      // pointing at nothing — and the merge advice below would refuse
      // ("found no source store"), so advising it tells the operator to
      // run a command that cannot run (finding B, 2026-08-22). The
      // filesystem fact is tested directly, the same discrimination the
      // sweep's orphan classification uses — NOT the "?" node count,
      // which also covers unreadable and pre-`nodes` stores that merge
      // can still answer for with its own refusal messages.
      const missing = [c.pathStore, c.gitStore]
        .filter((store) => !existsSync(join(storesDir, store, 'treecontext.db')))
      if (missing.length > 0) {
        results.push({
          check: 'Split candidates', status: 'warn',
          detail: `${c.pathStore} (bound by path) and ${c.gitStore} (bound by git) pair by name, `
            + `but ${missing.join(' and ')} ${missing.length === 1 ? 'holds' : 'hold'} no store on disk — `
            + 'a dangling binding, not two journals; there is nothing to merge',
        })
        continue
      }
      // The fix is `stores merge` (Phase 4, same release). Advise it only
      // for names the parser will accept — the same predicate the backup
      // section's rm advice uses, so the two cannot disagree about which
      // stores are stranded.
      const addressable = isCliAddressableStoreName(c.pathStore)
        && isCliAddressableStoreName(c.gitStore)
      results.push({
        check: 'Split candidates', status: 'warn',
        detail: `${c.pathStore} (${nodes(c.pathStore)} nodes, bound by path) and `
          + `${c.gitStore} (${nodes(c.gitStore)} nodes, bound by git) — one project, two journals; `
          + 'a candidate, not a verdict: this name shape also belongs to projects genuinely named that way',
        fix: addressable
          ? `treecontext stores merge ${c.pathStore} ${c.gitStore}`
          : 'The CLI cannot address these store names — the two journals are at '
            + `${join(storesDir, c.pathStore)} and ${join(storesDir, c.gitStore)}`,
      })
    }

    // The disclosure rides with every claim, in the check's OWN output
    // and not only in the design note (D4, A6, A11, §3.2). Under-reporting
    // is this heuristic's accepted failure mode; a silent list would read
    // as an all-clear it never earned.
    results.push({
      check: 'Split candidates', status: 'ok',
      detail: `${candidates.length} candidate${candidates.length !== 1 ? 's' : ''} `
        + `among ${bindingCount} binding${bindingCount !== 1 ? 's' : ''} — NOT an exhaustive list: `
        + 'a split whose two stores do not share the derived-name shape (an explicit or '
        + 'migrated-sticky binding), a repo rename or org move, a directory renamed before '
        + 'it had a remote, a worktree that was path-bound before worktree identity landed '
        + '(path-sourced on both sides, so the pairing above cannot see it), and worktrees '
        + 'of a bare repo with no remote are all invisible to this check',
    })

    // Adoption audit trail (O3): information, never a warning. Succession
    // working as designed still deserves to be sayable out loud — it is
    // the one binding on the machine the user did not initiate.
    const carried = carriedForwardBindings(projects)
    if (carried.length > 0) {
      results.push({
        check: 'Carried-forward bindings', status: 'ok',
        detail: carried
          .map(c => `${c.store} (adopted ${c.updatedAt > 0 ? new Date(c.updatedAt).toISOString().slice(0, 10) : 'date unrecorded'}`
            + `${c.bindings > 1 ? `, ${c.bindings} identities` : ''})`)
          .join('; ')
          + ' — a predecessor journal this machine carried forward when the project\'s identity'
          + ' changed under it; no byte was copied or moved (§3)',
      })
    }
  })()

  // Fingerprint collisions and bound-but-empty stores (§11a checks 2-3).
  //
  // The same class as the split above, one layer down: work merged into
  // the wrong place, and a journal that is not where it looks like it is.
  // Both are silent by construction — a colliding row is dropped on an
  // import with nothing left behind, and an empty store answers every
  // query with "I never wrote that down."
  //
  // Machine-wide over the bindings FILE, exactly as the split check is,
  // and read-only by the same two mechanisms: readBindingsSnapshot for
  // what is written down, and raw better-sqlite3 handles opened
  // { readonly, fileMustExist } for the stores themselves — no
  // migration, no lock taken from a running server, and no page
  // written. (SQLite DOES mint -shm/-wal side files for any reader of
  // a WAL store, read-only included — Phase-2 review S5; the database
  // itself is never touched, which is what the corpus pins.)
  // Anything unopenable degrades to "?" and never to a claim.
  await (async () => {
    let projects: import('./split-candidates.js').BoundProjects
    try {
      const { readBindingsSnapshot } = await import('./bindings.js')
      projects = readBindingsSnapshot().projects
    } catch {
      // Same silence as the split check: a claim about stores built on a
      // bindings file we could not read would be worse than none.
      return
    }
    const { boundStores, fingerprintCollisions, bindingStamp } = await import('./store-audit.js')
    const stores = boundStores(projects)
    if (stores.length === 0) return

    const Database = (await import('better-sqlite3')).default
    const now = Date.now()

    const colliding: string[] = []
    const unmigrated: string[] = []
    const unreadable: string[] = []
    const empty: string[] = []
    let scanned = 0
    let absent = 0
    for (const bound of stores) {
      const dbPath = join(storesDir, bound.store, 'treecontext.db')
      // A binding naming a store that is not on disk yet is not a
      // finding here. It is the ordinary state of a project bound in a
      // session that never captured anything, and the emptiness check
      // below would report every one of them as an orphan.
      if (!existsSync(dbPath)) {
        absent++
        continue
      }
      let db: import('better-sqlite3').Database | null = null
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true })
        // `nodes` must be a real TABLE before any query runs: a crafted
        // store where it is an infinite recursive VIEW wedges the
        // synchronous query forever — no JS timer can rescue a blocked
        // event loop (Phase-2 review S4, measured). A view is "?".
        const kind = db.prepare("SELECT type FROM sqlite_schema WHERE name = 'nodes'").get() as
          { type: string } | undefined
        if (kind?.type !== 'table') throw new Error('nodes is not a table')
        const counts = fingerprintCollisions(db)
        if (counts.groups > 0) {
          colliding.push(`${bound.store} (${counts.groups} group${counts.groups !== 1 ? 's' : ''}, `
            + `${counts.rows} row${counts.rows !== 1 ? 's' : ''})`)
        }
        // Only ever asked of a store at the digest schema — below it
        // every key is old-form, and calling the norm "unmigrated" would
        // put a permanent finding on every store on the machine.
        if (counts.unmigrated !== null && counts.unmigrated > 0) {
          unmigrated.push(`${bound.store} (${counts.unmigrated} row${counts.unmigrated !== 1 ? 's' : ''})`)
        }
        const nodes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number } | undefined
        if (Number(nodes?.n ?? 0) === 0) {
          empty.push(`${bound.store} (${bindingStamp(bound.updatedAt, now)})`)
        }
        // Counted only after every query on it succeeded — a store that
        // opens and then fails mid-scan is unreadable, not scanned, or
        // the coverage line double-counts it (Phase-2 review S6).
        scanned++
      } catch {
        // Unopenable, pre-`nodes`, pre-`fingerprint` — one degradation
        // for all of them, and it is a "?" rather than silence so the
        // count above is never read as covering a store it could not open.
        unreadable.push(bound.store)
      } finally {
        try { db?.close() } catch { /* nothing was written to lose */ }
      }
    }

    const coverage = `${scanned} bound store${scanned !== 1 ? 's' : ''}`
      + (absent > 0 ? `, ${absent} not on disk yet` : '')
      + (unreadable.length > 0 ? `, ${unreadable.length} unreadable (${unreadable.join(', ')}: ?)` : '')

    // INFO, not a warning, and the reason rides in the row: a colliding
    // group is inert where it sits. The key is only consulted by the
    // dedup predicates, and the one that has no window at all
    // (curatedHolder) is reached on the IMPORT and MERGE paths — which is
    // where a colliding row is skipped as a duplicate and lost. Phase 3's
    // digest migration is what retires the class; until it lands this row
    // is a measurement, not a task.
    results.push({
      check: 'Fingerprint collisions', status: 'ok',
      detail: (colliding.length > 0
        ? `${colliding.join('; ')} among ${coverage}`
        : `none among ${coverage}`)
        + ' — one dedup key covering more than one content (§9.2). Nothing is at risk in place:'
        + ' these rows are only dropped on the import and merge paths, where a colliding row is'
        + ' skipped as a duplicate. The Phase 3 digest migration retires the class.',
    })
    if (unmigrated.length > 0) {
      // Never folded into the count above: an undecodable row keeps its
      // pre-digest key by design, and a collision count that included
      // them could not read zero after the migration (§11b finding 10).
      results.push({
        check: 'Fingerprint keys', status: 'ok',
        detail: `${unmigrated.join('; ')} — rows still carrying a pre-digest key, counted apart from`
          + ' the collision groups above: their content could not be decoded to rehash, so the old'
          + ' key is the only one they can have',
      })
    }

    // Bound-but-empty stores. The orphaned-successor shape the name
    // heuristic cannot pair: a project whose identity changed under it
    // binds somewhere new, and the new store stays empty while the
    // journal sits elsewhere under a name nothing relates to this one.
    results.push({
      check: 'Bound-but-empty stores', status: 'ok',
      detail: (empty.length > 0
        ? `${empty.join('; ')} among ${coverage}`
        : `none among ${coverage}`)
        + ' — emptiness alone proves NOTHING: a project that has simply not been captured yet'
        + ' looks exactly like a journal left behind by an identity change. It is the age that'
        + ' is worth reading — a store bound long ago and still empty is the shape worth chasing.',
    })
  })()

  // Capture debt for the store THIS directory is bound to (§11a check 4).
  //
  // The sidecar pane already computes these, and that is the problem: the
  // pane is opt-in wiring in another program's config, so a store quietly
  // failing to drain is invisible on every machine that never wired it.
  // doctor is the surface everyone is told to run.
  //
  // Current store, not machine-wide: dead letters and a staging backlog
  // are about the drain that is running HERE, and the whole point of
  // naming this directory's store is that the reader can act on it. Same
  // binding lookup the schema section's sidecar row uses — lookupStoreName
  // and never resolveStoreName, which would register every directory
  // doctor was ever run from.
  await (async () => {
    let boundStore: string | null = null
    try {
      const { lookupStoreName } = await import('./bindings.js')
      boundStore = lookupStoreName(process.cwd())
    } catch { /* unbound is the ordinary state of most directories */ }
    if (boundStore === null) {
      // Say so rather than dropping the row (Phase-2 review, §11a
      // conformance): doctor run from $HOME is the ordinary case, and a
      // silently absent check reads as a passing one.
      results.push({
        check: 'Capture debt', status: 'ok',
        detail: 'this directory is not bound to a store — run doctor from a project directory to grade its drain',
      })
      return
    }
    const dbPath = join(storesDir, boundStore, 'treecontext.db')
    // No store yet is not debt. It is a directory that has not captured
    // anything, and the schema section already says so.
    if (!existsSync(dbPath)) return

    const { captureDebt, humanAge } = await import('./store-audit.js')
    const Database = (await import('better-sqlite3')).default
    let debt: import('./store-audit.js').CaptureDebt
    let db: import('better-sqlite3').Database | null = null
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true })
      debt = captureDebt(db)
    } catch {
      // The schema section above already reports an unreadable store, in
      // its own voice and with its own fix. Saying it twice reads as two
      // faults.
      return
    } finally {
      try { db?.close() } catch { /* nothing was written to lose */ }
    }

    const staged = debt.unprocessed === 0
      ? 'staging clear'
      : `${debt.unprocessed} event${debt.unprocessed !== 1 ? 's' : ''} still staged`
        + (debt.oldestPendingAt !== null
          ? `, oldest waiting ${humanAge(Date.now() - debt.oldestPendingAt * 1000)}`
          : '')

    const { DRAIN_BACKLOG_WARN } = await import('./sidecar-blob.js')
    const { STAGING_CLAIM_TTL_SECS } = await import('../persistence/capture-constants.js')
    // Depth alone cannot grade a drain (Phase-3 review B1: the warn
    // line equals ONE drain batch, so a healthy mid-tick drain holds
    // 20 staged by construction). Depth past the pane's line AND an
    // oldest row older than the claim TTL is what a live drain cannot
    // produce.
    const stalled = debt.unprocessed > DRAIN_BACKLOG_WARN
      && debt.oldestPendingAt !== null
      && Date.now() / 1000 - debt.oldestPendingAt > STAGING_CLAIM_TTL_SECS
    // A dead drain is the more urgent finding, so the stalled note
    // rides the gap warning rather than being shadowed by it (B3).
    const stalledNote = ' — and a backlog this old with nothing drained usually means'
      + ' nothing is draining this store (an idle machine between sessions can look the'
      + ' same; the age is the tell)'
    if (debt.deadLetters > 0) {
      results.push({
        check: 'Capture debt', status: 'warn',
        detail: `${boundStore}: ${debt.deadLetters} capture gap${debt.deadLetters !== 1 ? 's' : ''}`
          + ` — holes this store admitted in itself (dead letters, malformed snapshots, valve drops); ${staged}`
          + (stalled ? stalledNote : ''),
        // No command clears this: the source event is gone, and nothing
        // re-ingests a dead letter. So the fix line says where to READ
        // them, which is the only action there is — each one is a
        // "[capture gap]" entry naming what was lost and why.
        fix: `Read them from the journal — they are the "[capture gap]" entries in ${dbPath};`
          + ' nothing re-ingests a dead letter, so the count only ever grows',
      })
    } else if (stalled) {
      results.push({
        check: 'Capture debt', status: 'warn',
        detail: `${boundStore}: no capture gaps recorded, but ${staged}${stalledNote}`,
        fix: 'Start (or restart) a capture-enabled server for this project — the drain'
          + ' re-attempts staged events on its next tick; the backlog is not lost, it is waiting',
      })
    } else {
      results.push({
        check: 'Capture debt', status: 'ok',
        detail: `${boundStore}: no capture gaps, ${staged}`,
      })
    }
  })()

  // Migration backups — the copies every migration run leaves beside each
  // store are invisible disk debt until someone looks, and doctor is the
  // single surface that reports them (backup-visibility.feature). Silence
  // when there are none is part of the contract; when there are some, the
  // section ends with the one line naming the command that reclaims them.
  await (async () => {
    if (!existsSync(storesDir)) return
    const { listMigrationBackups, listOrphanVerdictSidecars } = await import('../persistence/backup-verdict.js')
    // listStoreDirs is THE stores-directory walk — doctor enumerating a
    // different set of directories than the sweep it advises would send
    // users to a command that sees different backups than this report.
    const {
      formatBytes, listStoreDirs, isLiveRollback, verdictLabel,
      SWEEP_COMMAND, isCliAddressableStoreName, rmCommandFor,
    } = await import('../tools/stores.js')
    const found: Array<{ store: string; backup: import('../persistence/backup-verdict.js').MigrationBackup; liveGone: boolean }> = []
    const orphanSidecars: Array<{ store: string; fileName: string }> = []
    for (const { name, path: dir } of listStoreDirs(storesDir)) {
      // Orphaned sidecars are migration residue like the backups
      // themselves — doctor is the visibility surface, and a leftover
      // the sweep would reclaim must not wait for the user to happen to
      // re-run sweep unprompted.
      for (const fileName of listOrphanVerdictSidecars(dir)) {
        orphanSidecars.push({ store: name, fileName })
      }
      const backups = listMigrationBackups(dir)
      if (backups.length === 0) continue
      const liveGone = !existsSync(join(dir, 'treecontext.db'))
      for (const backup of backups) found.push({ store: name, backup, liveGone })
    }
    if (found.length === 0 && orphanSidecars.length === 0) return

    // detail says what a row IS; every warn row's way out goes in fix —
    // the channel journal-install's universal clause enumerates. Full
    // rationale: backup-visibility.feature preamble.
    let totalBytes = 0
    for (const { store, backup, liveGone } of found) {
      totalBytes += backup.sizeBytes
      const head = `${store}: ${backup.fileName} (from v${backup.sourceVersion}, ${formatBytes(backup.sizeBytes)}`
      if (liveGone && !isLiveRollback(backup)) {
        // The reclaimable orphan (ruling 2026-08-10): verified, live
        // store gone — explicit rm is the sanctioned way out, and doctor
        // is where the user learns the command. But only advise a
        // command the parser will accept: a name rm's guard refuses
        // (spaces, unicode — creatable via unvalidated --store) gets
        // honest by-hand advice, never a string that shell-splits into
        // a sibling store's name.
        results.push({
          check: 'Migration backups', status: 'warn',
          detail: `${head}, verdict: ${verdictLabel(backup)}) — its live store is gone; an orphaned verified backup`,
          fix: isCliAddressableStoreName(store)
            ? rmCommandFor(store)
            : `The CLI cannot address this store name — remove the directory by hand: ${dirname(backup.path)}`,
        })
      } else if (liveGone) {
        // The shell state: a spared live rollback whose store was removed.
        results.push({
          check: 'Migration backups', status: 'warn',
          detail: `${head}, verdict: ${verdictLabel(backup)}) — its live store is gone; a spared live rollback`,
          fix: `Restoring or deleting it is a by-hand decision: ${backup.path}`,
        })
      } else if (!isLiveRollback(backup)) {
        results.push({ check: 'Migration backups', status: 'ok', detail: `${head}, verdict: ${verdictLabel(backup)})` })
      } else if (backup.verdict === 'failed') {
        results.push({
          check: 'Migration backups', status: 'warn',
          detail: `${head}, verdict: failed) — the backup is the intact pre-migration copy`,
          fix: `Restore it by hand: copy ${backup.fileName} over treecontext.db while nothing has the store open — anything written since the migration began is lost that way, so export the live store first and import it back after`,
        })
      } else {
        results.push({
          check: 'Migration backups', status: 'warn',
          detail: `${head}) — no migration verdict`,
          fix: `Removing it is a by-hand decision: ${backup.path}`,
        })
      }
    }
    for (const { store, fileName } of orphanSidecars) {
      results.push({
        check: 'Migration backups', status: 'warn',
        detail: `${store}: ${fileName} — orphaned verdict sidecar (its backup is gone)`,
        // --yes, because the bare sweep is a dry-run: the fix channel
        // promises the command that CLEARS the finding, and rmCommandFor
        // already carries its --yes for the same reason (review of E
        // chunk 3). The ok-status summary row keeps the bare form — it
        // advises, it does not remediate.
        fix: `${SWEEP_COMMAND} --yes`,
      })
    }
    if (found.length > 0) {
      results.push({
        check: 'Migration backups', status: 'ok',
        detail: `${found.length} backup${found.length !== 1 ? 's' : ''} occupying ${formatBytes(totalBytes)} — reclaim verified ones: ${SWEEP_COMMAND}`,
      })
    }
  })()

  // Global config
  const globalConfig = join(homedir(), '.treecontext', 'config.toml')
  if (existsSync(globalConfig)) {
    try {
      const data = parseToml(readFileSync(globalConfig, 'utf8')) as Record<string, unknown>
      const server = (data.server ?? {}) as Record<string, unknown>
      const capture = server.capture === true ? 'enabled' : 'disabled'
      results.push({ check: 'Global config', status: 'ok', detail: `capture: ${capture}` })
    } catch {
      results.push({ check: 'Global config', status: 'warn', detail: 'parse error', fix: 'Delete and re-run: treecontext install' })
    }
  } else {
    results.push({ check: 'Global config', status: 'warn', detail: 'not found', fix: 'treecontext install' })
  }

  // CCS (Claude Code Switch) detection
  {
    const ccsDir = join(homedir(), '.ccs')
    if (existsSync(ccsDir)) {
      const targets = getCcsHookTargets()
      const sharedSettings = join(ccsDir, 'shared', 'settings.json')
      const hasShared = existsSync(sharedSettings)
      const instancesDir = join(ccsDir, 'instances')
      const instances = existsSync(instancesDir)
        ? readdirSync(instancesDir).filter(n => {
            try { return lstatSync(join(instancesDir, n)).isDirectory() && n !== '.locks' } catch { return false }
          })
        : []
      const bareCount = targets.filter(t => t !== sharedSettings).length

      // Check if hooks are installed in CCS targets
      const hooksInstalled = targets.every(t => {
        if (!existsSync(t)) return false
        const content = readFileSync(t, 'utf8')
        return content.includes(TC_HOOK_PREFIX)
      })
      // "Synced" only ever meant "the name appears in the file", which is
      // true of a command the shell cannot run. Grade runnability here too:
      // a CCS user has one of these per instance, so a format that breaks
      // breaks all of them at once and this row is where they would look.
      const deadCcs = targets.flatMap(t => unrunnableHookCommands(t))

      const detail = [
        `${instances.length} instance${instances.length !== 1 ? 's' : ''}`,
        hasShared ? 'shared mode' : 'no shared settings',
        bareCount > 0 ? `${bareCount} bare` : null,
        hooksInstalled ? 'hooks synced' : 'hooks not synced',
        deadCcs.length > 0
          ? `${deadCcs.length} command${deadCcs.length === 1 ? '' : 's'} will not run (${deadCcs[0]!.reason})`
          : null,
      ].filter(Boolean).join(', ')

      const ccsHealthy = hooksInstalled && deadCcs.length === 0
      results.push({
        check: 'CCS',
        status: ccsHealthy ? 'ok' : deadCcs.length > 0 ? 'error' : 'warn',
        detail,
        ...(!ccsHealthy ? { fix: 'treecontext install' } : {}),
      })

      // Per-instance MCP mode check
      for (const name of instances) {
        const instanceConfig = join(instancesDir, name, '.claude.json')
        if (!existsSync(instanceConfig)) continue
        try {
          const data = readJsonSafe(instanceConfig)
          const servers = (data.mcpServers ?? {}) as Record<string, unknown>
          if (!servers.treecontext) continue
          const entry = servers.treecontext as Record<string, unknown>
          // A stranded interpreter (node upgraded/removed since install) is
          // the failure that silently kills the MCP server — surface it as an
          // error before the mode check. Mirrors the per-agent loop below.
          const cmd = typeof entry.command === 'string' ? entry.command : null
          const interp = cmd ? interpreterIssue(cmd) : null
          if (interp) {
            results.push({
              check: `CCS instance ${name}`,
              status: 'error',
              detail: `mcp ${interp}`,
              fix: 'treecontext install',
            })
            continue
          }
          const args = (entry.args ?? []) as string[]
          const hasCapture = args.includes('--capture')
          const mode = hasCapture ? 'capture' : 'standard (no auto-capture)'
          const ok = hasCapture
          results.push({
            check: `CCS instance ${name}`,
            status: ok ? 'ok' : 'warn',
            detail: `mode: ${mode}`,
            ...(!ok ? { fix: 'treecontext install --force' } : {}),
          })
        } catch { /* skip unparseable */ }
      }
    }
  }

  // Per-agent checks
  const detected = detectAgents(platform)
  let agentsCaptureOk = 0
  let agentsCaptureWarn = 0
  let agentsTotal = 0

  for (const agent of detected) {
    const configPath = getConfigPath(agent, platform)
    if (!configPath) continue
    agentsTotal++

    const parts: string[] = []
    let mcpArgs: string[] | null = null
    let mcpCmd: string | null = null
    let interpreterProblem = false

    if (existsSync(configPath)) {
      try {
        let hasEntry = false
        if (agent.configFormat === 'toml-codex') {
          const data = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>
          const servers = (data.mcp_servers ?? {}) as Record<string, unknown>
          hasEntry = !!servers.treecontext
          if (hasEntry) {
            const entry = servers.treecontext as Record<string, unknown>
            mcpArgs = (entry.args ?? []) as string[]
            mcpCmd = typeof entry.command === 'string' ? entry.command : null
          }
        } else {
          const data = readJsonSafe(configPath)
          const key = configRootKey(agent)
          const servers = (data[key] ?? {}) as Record<string, unknown>
          hasEntry = !!servers.treecontext
          if (hasEntry) {
            const entry = servers.treecontext as Record<string, unknown>
            if (agent.configFormat === 'json-opencode') {
              mcpArgs = (entry.command ?? []) as string[]
              mcpCmd = typeof mcpArgs[0] === 'string' ? mcpArgs[0] : null
            } else {
              mcpArgs = (entry.args ?? []) as string[]
              mcpCmd = typeof entry.command === 'string' ? entry.command : null
            }
          }
        }
        parts.push(hasEntry ? 'MCP configured' : 'MCP not configured')
      } catch {
        parts.push('config parse error')
      }
    } else {
      parts.push('MCP not configured')
    }

    if (mcpCmd) {
      const issue = interpreterIssue(mcpCmd)
      if (issue) {
        parts.push(`mcp ${issue}`)
        interpreterProblem = true
      }
    }

    // Every documented client but Claude Code gets the three halves on its
    // row: the mode, the state found, the remedy (D161, D208).
    const client = CAPTURE_PLATFORMS.has(agent.slug) ? null : clientHookReport(agent, platform)

    // Mode detection from MCP args. On a client other than Claude Code this
    // is the SERVER's mode: the client itself captures nothing unless its
    // own hooks run, and the row must not read as if it did.
    if (mcpArgs) {
      const hasCapture = mcpArgs.includes('--capture')
      const hasDebug = mcpArgs.includes('--debug')
      const hasNoDebug = mcpArgs.includes('--no-debug')
      const label = client ? 'server mode' : 'mode'
      const thisClient = client
        ? ` (this client: ${client.hooksPresent ? 'experimental hooks, unverified' : 'tools only'})`
        : ''
      if (hasCapture) {
        parts.push(`${label}: capture${thisClient}`)
        agentsCaptureOk++
      } else {
        parts.push(`${label}: standard (no auto-capture)${thisClient}`)
        agentsCaptureWarn++
      }
      if (hasNoDebug) {
        parts.push('debug: off')
      } else if (hasDebug) {
        parts.push('debug: on')
      } else {
        parts.push('debug: on (default)')
      }
    }

    // Hook health belongs on the agent's own row only where `install` actually
    // manages hooks. Everywhere else the row's fix would be `install --force`,
    // which by design writes nothing there — so those get their own advisory
    // row (unmanagedHookRow) carrying a command that works.
    let unmanagedRow: DiagnosticResult | null = null
    let unmanagedHooksPresent = false
    const hooksUnmanaged = agent.hooks != null && !CAPTURE_PLATFORMS.has(agent.slug)
    // The client clause (computed above) is appended last, after the MCP
    // and instruction parts, so it reads as one unit.
    if (agent.hooks && hooksUnmanaged && COPYING_CLIENTS.has(agent.slug)) {
      // A copying client's own configuration is graded by the copy state
      // (clientHookReport): install writes the copy behind the experimental
      // flag and rewrites a drifted one with the same command, so a separate
      // "install does not manage them" row would contradict the remedy.
      unmanagedHooksPresent = client?.hooksPresent ?? false
    } else if (agent.hooks && hooksUnmanaged) {
      const state = unmanagedHookState(agent, platform)
      unmanagedRow = state.row
      unmanagedHooksPresent = state.present
      // An as-is client's own copy is graded on the client clause (D226).
      if (state.present && !AS_IS_CLIENTS.has(agent.slug)) {
        parts.push('hooks present (experimental capture — install does not manage them)')
      }
    } else if (agent.hooks) {
      if (agent.hooks.format === 'claude-settings') {
        // Same names install writes, .cmd and all — see claudeHookScriptPaths.
        const requiredScripts = claudeHookScriptPaths(platform)
        const missing = requiredScripts.filter(p => !existsSync(p))
        if (missing.length === 0) {
          parts.push('hooks installed')
        } else if (missing.length === requiredScripts.length) {
          parts.push('hooks missing')
        } else {
          parts.push(`hooks incomplete (missing: ${missing.map(p => basename(p).replace(TC_HOOK_PREFIX, '')).join(', ')})`)
        }
        // Grade each script BODY per its dialect (hookScriptIssue): the
        // POSIX bare-`node` legacy AND the Windows classes — the
        // pre-0.0.15 pinned-only .cmd was invisible here while capture
        // died silently behind 2>nul (0.1 charter pull-in, 2026-08-12).
        for (const p of requiredScripts) {
          if (!existsSync(p)) continue
          const issue = hookScriptIssue(readFileSync(p, 'utf8'))
          if (issue) {
            parts.push(`hook scripts: ${issue}`)
            interpreterProblem = true
            break // one loud reason beats five copies of it
          }
        }
        // The scripts being present says nothing about whether the commands
        // that invoke them run. Grade those too, or a settings file whose
        // every hook is dead still reports "hooks installed".
        const settingsPath = getHookSettingsPath(agent, platform)
        if (settingsPath && existsSync(settingsPath)) {
          // D171/D187: session-start must run on clear and resume too, or a
          // /clear gets no packet and a resumed session no capture sign.
          // Installs from before 0.1.0-beta.1 wired it on startup and
          // compact only; re-running install rewrites the matchers.
          const unwired = claudeSessionStartUnwired(readJsonSafe(settingsPath))
          if (unwired.length > 0) {
            results.push({
              check: `${agent.name}: re-orientation hooks`, status: 'warn',
              detail: `session-start is not wired on ${unwired.join(' and ')} — a /clear gets no re-orientation packet and the session no capture sign`,
              fix: 'treecontext install',
            })
          }
        }
        if (settingsPath && existsSync(settingsPath)) {
          // D251: a hook command without `exec` leaves /bin/sh between
          // claude and the hook, so the pid-keyed session joins miss —
          // capture still runs, identity falls back to the echo.
          const noExec = claudeHookCommandsWithoutExec(readJsonSafe(settingsPath))
          if (noExec.length > 0) {
            results.push({
              check: `${agent.name}: session identity`, status: 'warn',
              detail: `degraded session identity — ${noExec.length} hook command${noExec.length === 1 ? '' : 's'} run${noExec.length === 1 ? 's' : ''} without \`exec\`, so the shell that runs ${noExec.length === 1 ? 'it' : 'them'} may stand between ${agent.name} and the hook: where /bin/sh is dash, the session beacon, the /clear predecessor link and the hook's namespace annotation are keyed on that shell and may not match; capture is unaffected. A plain \`treecontext install\` rewrites the commands too`,
              fix: `treecontext install --force --agent ${agent.slug}`,
            })
          }
        }
        if (settingsPath) {
          const dead = unrunnableHookCommands(settingsPath)
          if (dead.length > 0) {
            parts.push(
              `${dead.length} hook command${dead.length === 1 ? '' : 's'} will not run ` +
              `(${dead[0]!.reason}) — capture records nothing`,
            )
            interpreterProblem = true
          }
        }
      } else if (agent.hooks.format === 'vscode-hooks') {
        const settingsPath = getHookSettingsPath(agent, platform)
        if (settingsPath && existsSync(settingsPath)) {
          const data = readJsonSafe(settingsPath)
          // Graded against the builder's own event table (vscodeHooksComplete),
          // never a hand-copied list — the two spellings had drifted.
          parts.push(vscodeHooksComplete(data) ? 'hooks installed' : 'hooks incomplete')
          const issue = hookSettingsInterpreterIssue(data)
          if (issue) {
            parts.push(`hook ${issue}`)
            interpreterProblem = true
          }
          const wrapperIssue = agentHookWrapperIssue('vscode', hookCommandStrings(data))
          if (wrapperIssue) {
            parts.push(wrapperIssue)
            interpreterProblem = true
          }
        } else {
          parts.push('hooks missing')
        }
      } else if (agent.hooks.format === 'codex-hooks') {
        const settingsPath = getHookSettingsPath(agent, platform)
        if (settingsPath && existsSync(settingsPath)) {
          const data = readJsonSafe(settingsPath)
          const hasAll = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact']
            .every(e => Array.isArray(data[e]) && (data[e] as unknown[]).length > 0)
          parts.push(hasAll ? 'hooks installed' : 'hooks incomplete')
          const issue = hookSettingsInterpreterIssue(data)
          if (issue) {
            parts.push(`hook ${issue}`)
            interpreterProblem = true
          }
          const wrapperIssue = agentHookWrapperIssue('codex', hookCommandStrings(data))
          if (wrapperIssue) {
            parts.push(wrapperIssue)
            interpreterProblem = true
          }
        } else {
          parts.push('hooks missing')
        }
      } else if (agent.hooks.format === 'cursor-hooks') {
        const settingsPath = getHookSettingsPath(agent, platform)
        if (settingsPath && existsSync(settingsPath)) {
          const data = readJsonSafe(settingsPath)
          const hooks = (data.hooks ?? {}) as Record<string, unknown[]>
          const hasAll = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'preCompact']
            .every(e => Array.isArray(hooks[e]) && hooks[e].length > 0)
          parts.push(hasAll ? 'hooks installed' : 'hooks incomplete')
          const issue = hookSettingsInterpreterIssue(data)
          if (issue) {
            parts.push(`hook ${issue}`)
            interpreterProblem = true
          }
          const wrapperIssue = agentHookWrapperIssue('cursor', hookCommandStrings(data))
          if (wrapperIssue) {
            parts.push(wrapperIssue)
            interpreterProblem = true
          }
        } else {
          parts.push('hooks missing')
        }
      } else if (agent.hooks.format === 'gemini-settings') {
        const settingsPath = getHookSettingsPath(agent, platform)
        if (settingsPath && existsSync(settingsPath)) {
          const data = readJsonSafe(settingsPath)
          const hasHooks = Object.keys(ownedHookView(data.hooks)).length > 0
          parts.push(hasHooks ? 'hooks installed' : 'hooks missing')
          const issue = hookSettingsInterpreterIssue(data)
          if (issue) {
            parts.push(`hook ${issue}`)
            interpreterProblem = true
          }
          const wrapperIssue = agentHookWrapperIssue('gemini', hookCommandStrings(data))
          if (wrapperIssue) {
            parts.push(wrapperIssue)
            interpreterProblem = true
          }
        } else {
          parts.push('hooks missing')
        }
      }
    } else if (!client) {
      parts.push('no hook support (standard mode only — no auto-capture)')
    }

    // Channel-dedup safety net (AC5.4): --instructions none means the MCP
    // instructions channel is off — something else must carry the
    // orientation trigger, and the only other always-on channel is hooks.
    // Hooks in an unmanaged settings file still execute, so they still carry
    // the trigger: what disqualifies a channel is absence, not who wrote it.
    let channelProblem = false
    if (mcpArgs) {
      const idx = mcpArgs.indexOf('--instructions')
      if (idx >= 0 && mcpArgs[idx + 1] === 'none') {
        const hooksDelivering = parts.some(p => p === 'hooks installed')
          || (hooksUnmanaged && unmanagedHooksPresent)
        if (!hooksDelivering) {
          parts.push("instructions 'none' but hook channel not delivering — no channel carries the orientation trigger")
          channelProblem = true
        }
      }
    }

    // Managed instruction block (AC3.1): present + current / outdated / missing
    if (agent.instructions) {
      const instrPath = getInstructionsPath(agent, platform)
      if (instrPath) {
        if (existsSync(instrPath)) {
          const content = readFileSync(instrPath, 'utf8')
          const re = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`)
          const block = content.match(re)?.[0]
          if (!block) {
            parts.push('instructions missing')
          } else if (block === INSTRUCTIONS_CONTENT) {
            parts.push('instructions current')
          } else {
            parts.push('instructions outdated')
          }
        } else {
          parts.push('instructions missing')
        }
      }
    }

    // Reference skill (Claude Code only)
    if (agent.slug === 'claude') {
      const skillPath = skillFilePath()
      if (!existsSync(skillPath)) {
        parts.push('skill missing')
      } else if (readFileSync(skillPath, 'utf8') === skillFileContent()) {
        parts.push('skill installed')
      } else {
        parts.push('skill outdated')
      }
    }

    const hasModeProblem = mcpArgs != null && !mcpArgs.includes('--capture')
    const allGood = !hasModeProblem && !interpreterProblem && !channelProblem && parts.every(p =>
      !p.includes('not configured') && !p.includes('missing') && !p.includes('error')
      && !p.includes('outdated'),
    )
    // The client clause is graded on its own terms: its state words (a copy
    // whose scripts are "missing") must not trip the MCP grader above, and
    // its fix is the remedy it names, unless the MCP half needs the install.
    if (client) parts.push(`the client ${client.mode}; state: ${client.state}; remedy: ${client.remedy}`)
    // One command per row. A copy that needs rewriting is rewritten only by
    // the flagged install, so when the copy warns the fix carries the flag,
    // and --force when the MCP half needs it too.
    const copyWarn = client?.warn === true && COPYING_CLIENTS.has(agent.slug)
    const fix = !allGood
      ? `treecontext install --force --agent ${agent.slug}${copyWarn ? ' --experimental-capture' : ''}`
      : client?.warn ? client.fix : undefined
    results.push({
      check: agent.name,
      status: allGood && !client?.warn ? 'ok' : 'warn',
      detail: parts.join(', '),
      ...(fix ? { fix } : {}),
    })
    if (unmanagedRow) results.push(unmanagedRow)
  }

  // Conversation indexer summary
  if (agentsTotal > 0) {
    if (agentsCaptureOk === agentsTotal) {
      results.push({ check: 'Conversation indexer', status: 'ok', detail: `all ${agentsTotal} agent${agentsTotal !== 1 ? 's' : ''} in capture mode` })
    } else if (agentsCaptureWarn > 0) {
      results.push({
        check: 'Conversation indexer', status: 'warn',
        detail: `${agentsCaptureWarn} of ${agentsTotal} agent${agentsTotal !== 1 ? 's' : ''} in standard mode (no auto-capture)`,
        fix: 'treecontext install --force',
      })
    }
  }

  // Debug logging
  {
    const { LOGS_DIR, FATAL_PREFIX } = await import('../debug.js')
    const logsExist = existsSync(LOGS_DIR)
    const logFiles = logsExist
      ? readdirSync(LOGS_DIR).filter(f => f.startsWith('debug-') && f.endsWith('.log')).sort().reverse()
      : []

    // Recorded crashes, surfaced without asking the user to read logs.
    // logFatal writes these regardless of --debug, so a server that died
    // before its transport came up still leaves something doctor can find:
    // the host only ever showed "Connection closed".
    const fatals: string[] = []
    for (const f of logFiles) {
      try {
        for (const line of readFileSync(join(LOGS_DIR, f), 'utf8').split('\n')) {
          if (line.startsWith(FATAL_PREFIX)) fatals.push(line)
        }
      } catch { /* unreadable log is not itself a diagnosis */ }
    }
    if (fatals.length > 0) {
      // Newest file sorts first. Drop the machine prefix but keep the
      // context tag — "[serve]" vs "[hook]" is the first thing to know.
      // Redact home→~ before truncating: this excerpt lands in default
      // doctor output, the other surface users paste into issues
      // (ruling 2026-08-15 — same rule as dumpDebugLogs).
      const latest = redactHome(fatals[0]!
        .replace(/^\[treecontext:fatal \+\d+ms\] /, ''))
        .slice(0, 160)
      results.push({
        check: 'Recent crashes', status: 'error',
        detail: `${fatals.length} fatal error${fatals.length !== 1 ? 's' : ''} recorded — latest: ${latest}`,
        fix: 'Full context: treecontext doctor --dump-logs',
      })
    } else if (logFiles.length > 0) {
      results.push({ check: 'Recent crashes', status: 'ok', detail: 'none recorded' })
    }

    if (logFiles.length > 0) {
      const newest = logFiles[0]!
      const newestPath = join(LOGS_DIR, newest)
      const size = statSync(newestPath).size
      results.push({
        check: 'Debug logs',
        status: 'ok',
        detail: `${logFiles.length} log file${logFiles.length !== 1 ? 's' : ''} in ${LOGS_DIR} (latest: ${newest}, ${Math.round(size / 1024)}KB)`,
      })
    } else {
      results.push({
        check: 'Debug logs',
        status: 'warn',
        detail: `no log files in ${LOGS_DIR}`,
        fix: 'Ensure --debug is in your MCP args (default since v0.x). Run treecontext install --force to update configs.',
      })
    }
  }

  // Print results
  for (const r of results) {
    const icon = r.status === 'ok' ? '[ok]  ' : r.status === 'warn' ? '[warn]' : '[err] '
    console.log(`${icon} ${r.check}: ${r.detail}`)
    if (r.fix) console.log(`       fix: ${r.fix}`)
  }

  // Debug log access guidance
  console.log(`
─── Debug log access ───────────────────────────────────────
  Log directory:  ${join(homedir(), '.treecontext', 'logs')}
  View latest:    cat ~/.treecontext/logs/$(ls -t ~/.treecontext/logs/ | head -1)
  Dump all:       treecontext doctor --dump-logs
  Send to dev:    treecontext doctor --dump-logs | pbcopy   (macOS)
                  treecontext doctor --dump-logs | xclip    (Linux)
  Disable:        Add --no-debug to your MCP args
────────────────────────────────────────────────────────────`)

  return results
}

// ── Debug log dump ─────────────────────────────────────────────────

/**
 * Dump recent debug logs to stdout. Useful for copying/pasting to a
 * developer when stderr is not visible (e.g. Claude Code MCP servers).
 *
 * Redaction happens HERE, at the sharing surface (ruling 2026-08-15):
 * this output is written to be pasted into public issues, so the home
 * directory — the username on most machines — becomes `~` as it prints.
 * The on-disk logs keep full fidelity inside the 0700 logs dir; an
 * operator reading their own files sees real paths.
 */
export async function dumpDebugLogs(): Promise<void> {
  const { LOGS_DIR, redactHome: redact, isLogWriterAlive } = await import('../debug.js')

  if (!existsSync(LOGS_DIR)) {
    console.log('No debug logs found. Ensure --debug is enabled (it is by default).')
    console.log(`Expected directory: ${redact(LOGS_DIR)}`)
    return
  }

  const files = readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
    .sort()
    .reverse() // newest first

  if (files.length === 0) {
    console.log('No debug log files found.')
    console.log(`Directory exists but is empty: ${redact(LOGS_DIR)}`)
    return
  }

  console.log(`=== treecontext debug logs (${files.length} file${files.length !== 1 ? 's' : ''}) ===`)
  console.log(`Platform: ${process.platform}/${process.arch}, Node ${process.version}`)
  console.log(`Logs dir: ${redact(LOGS_DIR)}`)
  console.log()

  // Show up to 3 most recent log files (full content), and every file
  // whose writer is still running: a serving server's log is the only
  // home of its diagnostics (D258), and the hooks of one busy turn
  // outnumber it among the newest names.
  const toShow = [...files.slice(0, 3), ...files.slice(3).filter(isLogWriterAlive)]
  for (const name of toShow) {
    const path = join(LOGS_DIR, name)
    const size = statSync(path).size
    console.log(`── ${name} (${Math.round(size / 1024)}KB) ──`)
    const content = readFileSync(path, 'utf8')
    // Truncate if huge (>100KB) to avoid flooding terminal
    if (content.length > 100_000) {
      console.log(redact(content.slice(0, 50_000)))
      console.log(`\n... truncated (${Math.round(content.length / 1024)}KB total) ...`)
      console.log(redact(content.slice(-50_000)))
    } else {
      console.log(redact(content))
    }
    console.log()
  }

  if (files.length > toShow.length) {
    const hidden = files.length - toShow.length
    console.log(`(${hidden} older log file${hidden !== 1 ? 's' : ''} not shown)`)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname ?? '.', '../../package.json'), 'utf8'),
    ) as { version: string }
    return pkg.version
  } catch {
    return 'unknown'
  }
}
