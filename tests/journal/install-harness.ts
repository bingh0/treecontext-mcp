import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, existsSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { meetsNodeFloor } from '../../src/server/installer.js'
import { spawnSync } from 'node:child_process'
import { expect } from 'vitest'
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { getAgent, getConfigPath } from '../../src/server/agents.js'
import { mcpLauncherPath } from '../../src/server/installer.js'
import { sandboxedSpawnEnv, spawnCli, type CliSpawnResult } from '../helpers/cli-spawn.js'
import type { World } from './world.js'
import { TS_ROOT } from './proc.js'
import { writeFakeClaude } from './standins.js'

// ── Install-wave harness: the real CLI, a redirected HOME, and the ─────
//    other side of every boundary it claims to cross.
//
// Everything here goes through a SUBPROCESS, and that is load-bearing
// rather than stylistic. agents.ts freezes its config paths from
// homedir() at module load, and this harness imports agents.ts and
// installer.js for its path helpers — so calling install() in-process
// would resolve against the developer's real home and write a real
// ~/.claude.json. A spawn with HOME redirected is the only way the
// production path can run without touching the machine running it.
//
// CLAUDE_CONFIG_DIR gets stripped for the same reason one level up: it
// relocates the whole config directory, and this suite is very often run
// from inside a Claude Code session that sets it. Inheriting it would
// send an install straight into the developer's live profile, past the
// HOME redirect entirely.

/** One CLI subprocess run — this wave's currency, and the corpus-wide
 *  spawn result under this wave's name. It was re-declared here field for
 *  field until the extraction review noticed the two could not disagree
 *  without one of them being wrong. */
export type CliRun = CliSpawnResult

/**
 * The install wave's world: the core `World` plus the redirected home, the
 * project under it, and what the last CLI run left behind.
 *
 * `ihome` is the whole harness's premise, so it is the field an extending
 * wave comes for: journal-agent-surface drives `tcCli` for its init
 * scenarios and extends this interface rather than promoting ihome into the
 * shared world (see AgentSurfaceWorld in steps/journal-agent-surface.steps.ts).
 */
export interface InstallWorld extends World {
  ihome?: string
  iproj?: string
  irun?: CliRun
  iBefore?: string[]
  /** Forced-scope scenario: the named agent's entry as install first wrote it. */
  iCanonicalEntry?: string
  /** Forced-scope scenario: the unnamed agent's config bytes after the hand-edit. */
  iCursorBytes?: string
  iLinkedCommand?: string
  iDoctorBefore?: string
  iFixCommand?: string
  iBadNode?: string
  iHooksBefore?: string
  /** Which-build scenarios: the rival global install fabricated on PATH. */
  iOtherBuild?: FakeGlobalInstall
  /** D265 doctor scenario: the runaway staging row and the drain holder. */
  iRunaway?: { stagingId: number; attempts: number; holderPid: number; holderHost: string }
  /** D265 README scenario: the upgrading section's text. */
  iReadmeSection?: string
  /** D290 scenarios: the directory holding the fake `claude`, first on the CLI's PATH. */
  iClaudeBin?: string
  /** D290 scenarios: the settings file the real install writes, as it stood before it ran. */
  iSettingsBefore?: string
  /** D290 scenarios: the install run and the doctor run, kept apart. */
  iInstallRun?: CliRun
  iDoctorRun?: CliRun
  /** D290 README scenario: the README's install section. */
  iInstallSection?: string
  /** D385/D386 scenarios: the client the scenario's row names. */
  iClient?: 'Claude Code' | 'Codex CLI'
  /** D385 scenarios: the arguments the developer added to the entry, in their order. */
  iDeveloperArgs?: string[]
  /** D385 scenarios: the developer's own keys in the entry, as they wrote them. */
  iDeveloperKeys?: Record<string, unknown>
  /** D386 scenarios: the server's own mode line, from the server the entry starts. */
  iServerMode?: string
}

/**
 * The real CLI against the redirected home.
 *
 * The recipe is spawnCli's — the tsx loader, the sandboxed env, the spawn-error
 * diagnostic — because this wave wants exactly it. What stays here is the
 * install-specific part: the home comes from the world rather than the caller,
 * and the default cwd is the repo root (the installer resolves its own project
 * context from it) rather than the sandbox home.
 *
 * sandboxedEnv, not HOME alone: os.homedir() reads USERPROFILE on Windows and
 * agents.ts resolves VS Code/OpenCode through APPDATA, so a HOME-only override
 * would leave paths in this harness pointing at the developer's real profile —
 * a redirected test that quietly installs for real is worse than no test.
 */
export function tcCli(w: InstallWorld, args: string[], opts: { cwd?: string } = {}): CliRun {
  // A scenario that set a Claude Code version has put a fake `claude` in a
  // directory of its own; it goes first on the child's PATH and nowhere else.
  const env = w.iClaudeBin ? { PATH: pathWithFakeClaude(w) } : undefined
  return spawnCli(args, { home: w.ihome!, cwd: opts.cwd ?? TS_ROOT, ...(env ? { env } : {}) })
}

/**
 * A `claude` on the child's PATH whose `--version` answers as the scenario
 * says: a version prints `<version> (Claude Code)` as the real client does,
 * and null is a client whose version cannot be read (it prints nothing with
 * a version in it and exits non-zero). Calling it again replaces the binary
 * in place, which is how a scenario upgrades the client between two runs.
 */
export function setClaudeVersion(w: InstallWorld, version: string | null): void {
  if (!w.iClaudeBin) {
    w.iClaudeBin = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-fake-claude-')))
    w.defer(() => rmSync(w.iClaudeBin!, { recursive: true, force: true }))
  }
  // The binary itself is the stand-in harness's (./standins.ts).
  writeFakeClaude(w.iClaudeBin, version)
}

/**
 * Locate an executable on PATH the way the OS would. Windows only — on POSIX
 * spawnSync already resolves a bare name, and leaving that path untouched
 * keeps the platforms that work working.
 *
 * Needed because npm installs the reference agent as `claude.cmd`, which Node
 * has refused to spawn directly since 20.12 (CVE-2024-27980). Resolving it
 * ourselves also keeps the ENOENT guard below honest: under a blanket
 * `shell: true`, a missing command comes back as cmd.exe exiting 1, which
 * would turn "the agent is not installed" into an unreadable assertion.
 */
function resolveOnPath(name: string): string | null {
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (process.env['PATH'] ?? '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (existsSync(p) && statSync(p).isFile()) return p
    }
  }
  return null
}

/** Run the agent's OWN cli against the redirected HOME — the other side. */
export function agentCli(w: InstallWorld, args: string[]): CliRun {
  const env = sandboxedSpawnEnv(w.ihome!)
  const win = process.platform === 'win32'
  // Node does not quote arguments when `shell` is true, so anything carrying
  // whitespace or a cmd metacharacter would be re-split into a different
  // command. Today's callers pass bare words; refuse loudly rather than
  // silently mangle a future one.
  if (win) {
    for (const a of args) {
      if (/[\s"&|<>^%]/.test(a)) {
        throw new Error(`agentCli: argument ${JSON.stringify(a)} needs cmd.exe quoting this helper does not do`)
      }
    }
  }
  const bin = win ? resolveOnPath('claude') : 'claude'
  const r = bin === null
    // Synthesise the same shape spawnSync gives for a missing binary so the
    // guard below stays the single place that explains the failure.
    ? { error: Object.assign(new Error('claude not found on PATH'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }
    : spawnSync(win ? `"${bin}"` : bin, args, {
      env, cwd: w.iproj ?? TS_ROOT, encoding: 'utf8', timeout: 120_000, shell: win,
    })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Not skipped: this scenario's whole claim is about what the agent can
    // see, and without the agent there is nothing to ask. Failing loudly is
    // the point — a silent skip here is the exact shape of the 0.0.9-beta
    // miss, where nobody ever asked the other side.
    throw new Error(
      'the reference agent CLI (`claude`) is not on PATH — the boundary scenarios '
      + 'in journal-install cannot be verified without it. Install it, or move '
      + 'those scenarios to the wip register with a reason.',
    )
  }
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
}

/**
 * Run Codex CLI's OWN cli against the redirected HOME — the other side for
 * Codex. Codex reads its configuration from CODEX_HOME, so the child gets
 * the sandbox's `.codex` there as well as the sandboxed HOME: an inherited
 * CODEX_HOME would send it to the developer's real configuration. `codex mcp
 * get` reads the file and calls no model.
 */
export function codexCli(w: InstallWorld, args: string[]): CliRun {
  const env = sandboxedSpawnEnv(w.ihome!, { CODEX_HOME: join(w.ihome!, '.codex') })
  const win = process.platform === 'win32'
  const bin = win ? resolveOnPath('codex') : 'codex'
  for (const a of args) {
    if (win && /[\s"&|<>^%]/.test(a)) throw new Error(`codexCli: argument ${JSON.stringify(a)} needs cmd.exe quoting this helper does not do`)
  }
  const r = bin === null
    ? { error: Object.assign(new Error('codex not found on PATH'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }
    : spawnSync(win ? `"${bin}"` : bin, args, { env, cwd: w.iproj ?? w.ihome!, encoding: 'utf8', timeout: 120_000, shell: win })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Not skipped, for the reason agentCli gives: without the client there
    // is nothing to ask.
    throw new Error(
      'Codex CLI (`codex`) is not on PATH — the journal-install scenarios that read '
      + "Codex's own view of its configuration cannot be verified without it. Install it "
      + '(`npm i -g @openai/codex`, no model call is made), or move them to the wip register with a reason.',
    )
  }
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
}

/** The treecontext entry as the client itself reads it: the command and arguments it would start, from its own CLI. */
export interface ClientEntry {
  command: string
  args: string[]
  /** Codex: the names it forwards; Claude Code: the names in its environment block. */
  envNames: string[]
  /** The client's own printout, for the assertions that read a key only it prints. */
  printed: string
  /** Codex: its `--json` reading, parsed. */
  json?: Record<string, unknown>
}

/** Claude Code's or Codex CLI's own reading of the treecontext entry under the redirected HOME. */
export function clientEntry(w: InstallWorld, agent: 'Claude Code' | 'Codex CLI'): ClientEntry {
  if (agent === 'Codex CLI') {
    const json = codexCli(w, ['mcp', 'get', 'treecontext', '--json'])
    expect(json.status, `codex could not read the entry:\n${json.out}`).toBe(0)
    const parsed = JSON.parse(json.stdout) as { transport: { command: string; args: string[]; env_vars?: string[] | null } }
    const plain = codexCli(w, ['mcp', 'get', 'treecontext'])
    expect(plain.status, plain.out).toBe(0)
    return {
      command: parsed.transport.command, args: parsed.transport.args,
      envNames: parsed.transport.env_vars ?? [], printed: `${json.stdout}\n${plain.stdout}`,
      json: parsed as unknown as Record<string, unknown>,
    }
  }
  const got = agentCli(w, ['mcp', 'get', 'treecontext'])
  expect(got.status, `claude could not read the entry:\n${got.out}`).toBe(0)
  const line = (label: string): string | undefined =>
    got.stdout.split('\n').map(l => l.trim()).find(l => l.startsWith(`${label}:`))?.slice(label.length + 1).trim()
  const command = line('Command')
  expect(command, `claude printed no command:\n${got.out}`).toBeDefined()
  const env = /Environment:\n((?:[ ]{4,}\S.*\n?)*)/.exec(got.stdout)?.[1] ?? ''
  return {
    command: command!, args: (line('Args') ?? '').split(' ').filter(Boolean),
    envNames: env.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('=')[0]!),
    printed: got.stdout,
  }
}

export async function openInstallWorld(w: InstallWorld, agentDirs: string[] = ['.claude']): Promise<void> {
  w.ihome = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-install-home-')))
  w.defer(() => {
    // One scenario removes write permission from an agent directory on
    // purpose; if it fails before restoring it, rmSync cannot descend. Put
    // the bits back first so a failing assertion never also leaks a temp dir.
    for (const d of readdirSync(w.ihome!, { withFileTypes: true })) {
      if (d.isDirectory()) { try { chmodSync(join(w.ihome!, d.name), 0o700) } catch { /* best effort */ } }
    }
    rmSync(w.ihome!, { recursive: true, force: true })
  })
  for (const d of agentDirs) mkdirSync(join(w.ihome, d), { recursive: true })
  // Every install world has a `claude` of its own on the CLI's PATH, so a
  // scenario behaves the same on a machine with Claude Code and on one
  // without (D290: install and doctor read the client's version from it).
  // A scenario about a version sets its own with setClaudeVersion; the
  // scenarios that need the real client call it through agentCli, which
  // never sees this one.
  setClaudeVersion(w, DEFAULT_CLAUDE_VERSION)
}

/** The version the fake `claude` of an install world answers, unless the scenario sets another. */
export const DEFAULT_CLAUDE_VERSION = '2.1.302'

/** A PATH with the world's fake `claude` first (when it has one). */
export function pathWithFakeClaude(w: InstallWorld, base: string = process.env['PATH'] ?? ''): string {
  return w.iClaudeBin ? `${w.iClaudeBin}${delimiter}${base}` : base
}

/** Every file under a root, relative and sorted — the dry-run comparison. */
export function treeOf(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
}

/** Absolute paths the installer printed, in order of appearance. */
export function pathsMentioned(out: string, home: string): string[] {
  // Trailing punctuation is prose, not path: installer messages already
  // print paths inside parentheses ('synced to CCS (…/.claude.json)'), and
  // a captured ')' would misclassify an announced path as unannounced in
  // the dry-run parity comparison.
  return [...new Set([...out.matchAll(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s\\]]*`, 'g'))].map(m => m[0].replace(/[.,;:)\]]+$/, '')))]
}

/**
 * Which dialect a wrapper body is written in.
 *
 * Decided by the BODY, never by process.platform, for the same reason
 * launcherInterpreter (installer.ts:2074) decides it that way: the .cmd branch
 * is then readable — and testable — from any platform.
 *
 * ONE spelling of that dispatch for the whole install wave: the walk below and
 * the oracle that grades it (requiresInterpreter, journal-install.steps.ts)
 * both call this. Sharing the dispatch is safe in a way sharing the PATTERNS
 * would not be — see the note at the oracle.
 */
export const isBatchBody = (body: string): boolean => body.startsWith('@echo off')

/**
 * The three commands a wrapper body can name, per dialect: the pinned and
 * fallback interpreters, the script handed to whichever one wins, and a bare
 * interpreter — the regression these patterns exist to catch.
 *
 * Dialect comes from isBatchBody above, so the POSIX patterns never see a
 * batch body or vice versa.
 *
 * Each batch pattern mirrors a literal the installer writes:
 *   INTERPRETER  `set "TC_NODE=<abs>"`         installer.ts:268 (verified pin)
 *                `... || set "TC_NODE=<abs>"`  installer.ts:269 (execPath fallback)
 *   SCRIPT       `set "TC_CLI=<abs>"`         installer.ts:320 (pinned module)
 *                `"%TC_NODE%" "%TC_CLI%"`     installer.ts:650 (hook dispatch)
 *                                              installer.ts:352 (launcher dispatch)
 *   BARE         `node "<script>"`             — written by no current branch
 *
 * The SCRIPT dispatch takes only real absolute paths for the same reason the
 * INTERPRETER pattern does. Both dialects hand the interpreter a VARIABLE now
 * (`%TC_CLI%` / `$TC_CLI`) rather than a literal, because a global install's
 * module path is version-stamped and the next `nvm install` deletes the
 * directory under it — installer.ts:303-330. The concrete path is on the pin
 * line, which is where this walk reads it; matching the dispatch loosely would
 * collect the variable name itself and fail the absolute-and-exists oracle
 * with a finding that is about spelling, not about the install.
 *
 * The interpreter pattern demands a real Windows absolute path (drive letter
 * or UNC) so the snippet's `set "TC_NODE=node"` sentinel — installer.ts:268-269,
 * both the `if not exist` fallback and the unverified opener — is NOT collected.
 * That sentinel means "nothing pinned, resolve at runtime": launcherInterpreter
 * returns null for it (installer.ts:2078), exactly as it returns null for the
 * POSIX `TC_NODE=""` that the POSIX pattern's leading `\/` already excludes.
 * Collecting it would hand the caller a bare `node` the product never pinned.
 *
 * The bare-interpreter pattern is not line-anchored on the batch side, because
 * the win32 regression it guards against was not line-shaped: the pre-2026-08
 * launcher spelled it `where node >nul 2>nul && (node "<cli>" %*) || ...`
 * (installer.ts:246). A lookbehind for a word/path character is what keeps
 * `TC_NODE=`, `nodejs\node.exe` and friends out; no legitimate batch line the
 * installer writes contains the token `node` followed by a quoted argument.
 *
 * CRLF needs no tolerance in these patterns: the batch bodies end lines with
 * `\r\n`, so the `\r` sits at the END of the preceding line and a `(?:^|\n)`
 * anchor still lands directly on the next line's first character.
 */
const WRAPPER_COMMAND_PATTERNS = {
  posix: [
    // The pinned/fallback interpreters (absolute forms only — the
    // `$(command -v node)` line is a lookup, not a command).
    /TC_NODE="(\/[^"]*)"/g,
    // The script it hands to that interpreter, which the wrapper now pins the
    // same way it pins the interpreter — installer.ts:304.
    /TC_CLI="(\/[^"]*)"/g,
    // The invocation. Absolute forms only, for the same reason the two pins
    // above take only absolute forms: the line reads `"$TC_NODE" "$TC_CLI"`
    // (installer.ts:359, :665), and collecting `$TC_CLI` off it would hand the
    // caller a shell variable to assert an absolute existing path about.
    /exec "\$TC_NODE" "(\/[^"]+)"/g,
    // A bare interpreter is the regression this scenario exists for.
    /(?:^|\n)(?:TREECONTEXT_DEBUG=1 )?(?:exec )?(node) "/g,
  ],
  batch: [
    /set "TC_NODE=((?:[A-Za-z]:[\\/]|\\\\)[^"]*)"/g,
    /set "TC_CLI=((?:[A-Za-z]:[\\/]|\\\\)[^"]*)"/g,
    /"%TC_NODE%" "((?:[A-Za-z]:[\\/]|\\\\)[^"]+)"/g,
    /(?<![\w.\\/-])(node) "/g,
  ],
} as const

/**
 * Every command the installed configuration will actually execute, tagged
 * with the file that will run it.
 *
 * Tagged by source on purpose: the first version of this walk matched only
 * a leading token per line and so extracted *nothing* from the hook scripts,
 * while still returning the MCP entry — enough to satisfy a "found some
 * commands" check and pass a scenario whose entire subject is those scripts.
 * Attributing each command lets the binding assert that every hook script
 * was actually reached, which is the property that failed silently.
 *
 * It failed silently a second time, and for the same reason one dialect down:
 * the patterns were POSIX-only, so on win32 the walk again reached none of the
 * hook scripts and the scenario again passed on the MCP entry alone. Both
 * dialects are read here now — see WRAPPER_COMMAND_PATTERNS.
 */
export function installedCommands(home: string): Array<{ source: string; command: string }> {
  const found: Array<{ source: string; command: string }> = []
  const hooksDir = join(home, '.claude', 'hooks')
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) {
      const body = readFileSync(join(hooksDir, f), 'utf8')
      const patterns = WRAPPER_COMMAND_PATTERNS[isBatchBody(body) ? 'batch' : 'posix']
      for (const pattern of patterns) {
        for (const m of body.matchAll(pattern)) found.push({ source: f, command: m[1]! })
      }
    }
  }
  for (const rel of ['.claude.json', join('.gemini', 'settings.json'), join('.cursor', 'mcp.json')]) {
    const p = join(home, rel)
    if (!existsSync(p)) continue
    const data = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, { command?: unknown }>>
    for (const key of ['mcpServers', 'servers']) {
      const entry = data[key]?.['treecontext']
      if (entry && typeof entry.command === 'string') found.push({ source: rel, command: entry.command })
    }
  }
  return found
}

/** Can this interpreter run this package (node:sqlite with FTS5, at the floor)? The question that matters. */
export function interpreterRunsPackage(interpreter: string): boolean {
  // The same proof install asks for (D278): the interpreter's own
  // node:sqlite opens a database and builds an FTS5 table, and it is at or
  // above the manifest's floor.
  const r = spawnSync(interpreter, ['-e',
    'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");'
    + 'd.exec("CREATE VIRTUAL TABLE t USING fts5(a)");d.close();process.stdout.write(process.versions.node)'], {
    encoding: 'utf8', timeout: 60_000,
  })
  return r.status === 0 && meetsNodeFloor(r.stdout.trim())
}

/**
 * The MCP launcher wrapper inside a sandbox home.
 *
 * The basename comes from the product (mcpLauncherPath) rather than being
 * spelled out, because Windows installs `tc-mcp-serve.cmd` and POSIX installs
 * an extensionless `tc-mcp-serve`. Reading the literal POSIX name is an ENOENT
 * on Windows against an install that succeeded. Only the basename is taken —
 * mcpLauncherPath() itself is rooted at the REAL home, frozen at import.
 */
export function mcpLauncherIn(home: string): string {
  return join(home, '.claude', 'hooks', basename(mcpLauncherPath()))
}

/**
 * Where the product writes VS Code's MCP config for a child process running
 * under `home`.
 *
 * Derived from the agent registry rather than spelled out, because
 * `~/.config/Code/User` is the LINUX path only: agents.ts maps darwin to
 * ~/Library/Application Support/Code/User and win32 to %APPDATA%\Code\User.
 * Hardcoding the Linux literal is what made every VS Code scenario in this
 * file fail on macOS while the product was correct.
 *
 * The registry freezes its paths from homedir() at module load, so what we get
 * here is rooted at the REAL home; we take its shape and re-root it onto the
 * sandbox. If a future registry entry ever points outside the home directory,
 * the relative path escapes and this throws instead of silently writing
 * somewhere the child will never read.
 */
export function agentConfigPath(slug: string, home: string): string {
  const agent = getAgent(slug)
  if (!agent) throw new Error(`agent registry no longer defines "${slug}"`)
  const real = getConfigPath(agent)
  if (!real) throw new Error(`agent registry defines no ${slug} config path for ${process.platform}`)
  const rel = relative(homedir(), real)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${slug} config path ${real} is not under the home directory — re-root agentConfigPath`)
  }
  return join(home, rel)
}

/** Platform path -> posix, for comparing two path sets that were built differently. */
export const toPosix = (p: string): string => p.split(sep).join('/')

export interface FakeGlobalInstall {
  /** Directory the shim lives in — what goes first on PATH. */
  bin: string
  /** The rival package's root, as doctor would print it (realpath). */
  root: string
  version: string
  /** The package name npm installed it under, which doctor prints. */
  name: string
}

/**
 * A rival global install of the `treecontext` command, in the layout npm
 * writes so doctor's shim reader meets the real shapes: POSIX gets
 * `<prefix>/bin/treecontext` as a symlink into
 * `<prefix>/lib/node_modules/<pkg>/dist/server/cli.js`; Windows gets
 * `<prefix>\treecontext.cmd` in cmd-shim's own words beside
 * `<prefix>\node_modules\<pkg>\...` — ONE of the three shims npm
 * writes there (the sh and .ps1 siblings are covered by the unit file on
 * their bodies, not by this scenario). The package is a stub — a
 * package.json carrying the version and an entry point that exists — because
 * the row under test reads identity, it never runs the rival.
 *
 * `pkg` is the package directory npm installed it under: `treecontext-mcp`,
 * the published name, by default; `treecontext` for an install from any
 * release candidate before the rename — the command is the same either way.
 */
export function fakeGlobalInstall(
  home: string,
  version: string,
  pkg: 'treecontext-mcp' | 'treecontext' = 'treecontext-mcp',
): FakeGlobalInstall {
  const win = process.platform === 'win32'
  const prefix = join(home, 'npm-global')
  const root = win
    ? join(prefix, 'node_modules', pkg)
    : join(prefix, 'lib', 'node_modules', pkg)
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: pkg, version }))
  // Executable, or `which` walks past the symlink to the next match on PATH.
  writeFileSync(join(root, 'dist', 'server', 'cli.js'), '// stub entry point of a rival build\n', { mode: 0o755 })
  if (win) {
    // cmd-shim's template, verbatim in shape: the interpreter probe spells
    // %dp0%\node.exe BEFORE the entry point, which is what the reader's
    // extension anchor exists for.
    const body = [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkg}\\dist\\server\\cli.js" %*`, '',
    ].join('\r\n')
    writeFileSync(join(prefix, 'treecontext.cmd'), body)
    return { bin: prefix, root: realpathSync.native(root), version, name: pkg }
  }
  const bin = join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })
  symlinkSync(join('..', 'lib', 'node_modules', pkg, 'dist', 'server', 'cli.js'), join(bin, 'treecontext'))
  return { bin, root: realpathSync.native(root), version, name: pkg }
}
