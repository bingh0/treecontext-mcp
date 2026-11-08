/**
 * THE CLI spawn harness — six test files each grew a near-identical
 * tsx-loader + sandboxed-spawn helper (pass-2 cleanup ruling,
 * 2026-08-15); divergence between them is exactly how an env leak
 * regresses in one file while the others stay green.
 *
 * Defaults: sandboxed home (homeEnv semantics — see helpers/home.ts on
 * why HOME alone does not sandbox Windows), stdin closed, and every
 * LEAK_KEYS entry removed. LEAK_KEYS is the single register of ambient
 * variables product code resolves real-machine state from (NODE_OPTIONS
 * injects vitest worker flags; CLAUDE_CONFIG_DIR relocates the agent
 * profile; the TREECONTEXT_* seams re-point config, bindings, and
 * project identity; XDG_CONFIG_HOME/CCR_CONFIG re-point ccr wiring) —
 * the next leak key gets added HERE, once, not at each spawn site.
 * Pass `env`/overrides to deliberately set any of them back.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { sandboxedEnv } from './home.js'

/** The tsx loader spelling every child here boots under — module-private,
 *  because nodeTsArgs below is the only recipe anything needs, and a second
 *  site holding the loader is a second site that can drift. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
export const CLI_TS = fileURLToPath(new URL('../../src/server/cli.ts', import.meta.url))

/**
 * argv for running a TypeScript entry point under tsx in a child node —
 * THE recipe, for every tier (tests/journal/proc.ts's `tsxArgv` is this
 * function under the journal wave's variadic spelling).
 *
 * Deliberately NOT via node_modules/.bin. npm writes three shims there on
 * Windows — tsx.cmd, tsx.ps1, and an extensionless Git-Bash script — and
 * CreateProcess can execute none of them: the extensionless one has no image
 * format, and since Node 20.12 (CVE-2024-27980) a .cmd cannot be spawned
 * without shell:true, which would push every path below through a quoting
 * layer. Spawning the bin path was therefore a silent no-op on Windows:
 * spawnSync returned status null with no stderr, and every capture, install
 * and sidecar scenario failed on an assertion about the exit code rather than
 * about the behaviour it names.
 *
 * Loading tsx into process.execPath keeps ONE argv array on every platform and
 * needs no shell. `tsx/cli` would also work, but it re-execs a second node —
 * so the entry point would not be our direct child, and the SIGKILL in the
 * sidecar teardowns would reap a wrapper while the real server kept the store
 * file open (EPERM on the next rmSync). --import keeps it a direct child.
 *
 * The loader is passed as a file URL because an absolute Windows path
 * (`C:\...`) is not a valid --import specifier.
 */
export function nodeTsArgs(script: string, args: string[] = []): string[] {
  const preload = process.env['NODE_V8_COVERAGE'] ? ['--import', COVERAGE_CAPTURE] : []
  return ['--import', TSX_LOADER, ...preload, script, ...args]
}

/**
 * Under `npm run test:coverage` every child also loads the capture preload
 * (after tsx, so it sees tsx's output): the child's V8 coverage indexes
 * esbuild's text, which exists only inside the child, and the merged
 * provider needs that text to remap it. Keyed on NODE_V8_COVERAGE — the
 * same variable the child inherits — so an ordinary run adds nothing.
 */
const COVERAGE_CAPTURE = new URL('../../scripts/coverage/capture-loader.mjs', import.meta.url).href

export const LEAK_KEYS = [
  'NODE_OPTIONS',
  'CLAUDE_CONFIG_DIR',
  'TREECONTEXT_CONFIG',
  'TREECONTEXT_BINDINGS_FILE',
  'TREECONTEXT_PROJECT_DIR',
  'XDG_CONFIG_HOME',
  'CCR_CONFIG',
  // Codex CLI reads its configuration from CODEX_HOME: doctor runs Codex's
  // own sandbox check and version read (D381, D387), so an inherited one
  // would point those at the developer's real configuration.
  'CODEX_HOME',
]

/**
 * Commands whose presence on PATH install reads as a client being installed
 * (D383: Antigravity CLI by `agy`, Gemini CLI by `gemini`). The machine
 * running the suite may have them; a sandboxed child must not see them, or
 * every install world on that machine wires a client its scenario never
 * named — the PATH twin of CLAUDE_CONFIG_DIR. A scenario that means one of
 * them to be installed puts it on the child's PATH from a directory of its
 * own, which this leaves alone.
 */
export const DETECTED_CLIENT_COMMANDS = ['agy', 'gemini'] as const

const mirrors = new Map<string, string | null>()
let mirrorRoot: string | null = null

/** A directory of the machine's PATH holding a detected client, mirrored without it (null on Windows: left out). */
function mirrorWithoutClients(dir: string): string | null {
  const cached = mirrors.get(dir)
  if (cached !== undefined) return cached
  let mirror: string | null = null
  if (process.platform !== 'win32') {
    if (!mirrorRoot) {
      mirrorRoot = mkdtempSync(join(tmpdir(), 'tc-path-mirror-'))
      const root = mirrorRoot
      process.once('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } })
    }
    mirror = mkdtempSync(join(mirrorRoot, 'd-'))
    for (const name of readdirSync(dir)) {
      if ((DETECTED_CLIENT_COMMANDS as readonly string[]).includes(name)) continue
      try { symlinkSync(join(dir, name), join(mirror, name)) } catch { /* a name that cannot be linked is not a command we need */ }
    }
  }
  mirrors.set(dir, mirror)
  return mirror
}

function holdsClient(dir: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']
  return DETECTED_CLIENT_COMMANDS.some(c => exts.some(e => existsSync(join(dir, `${c}${e}`))))
}

/** A PATH whose directories from this machine's own PATH show no detected client command. */
export function pathHidingMachineClients(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const ambient = new Set((process.env['PATH'] ?? '').split(delimiter).filter(Boolean))
  return path.split(delimiter).flatMap((d) => {
    if (!d || !ambient.has(d) || !holdsClient(d)) return [d]
    const m = mirrorWithoutClients(d)
    return m ? [m] : []
  }).join(delimiter)
}

/** Child-process env: home sandboxed, every leak key scrubbed, overrides
 *  applied last (an override is a deliberate re-add, so it wins), and the
 *  machine's own detected client commands hidden from PATH. */
export function sandboxedSpawnEnv(
  home: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = sandboxedEnv(home)
  for (const k of LEAK_KEYS) delete env[k]
  Object.assign(env, overrides)
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = pathHidingMachineClients(env[pathKey])
  return env
}

export interface CliSpawnResult {
  status: number | null
  stdout: string
  stderr: string
  /** stdout + stderr, for single-pattern assertions. */
  out: string
}

export function spawnCli(
  args: string[],
  opts: { home: string; cwd?: string; input?: string; env?: Record<string, string | undefined> },
): CliSpawnResult {
  return spawnNodeTs(CLI_TS, args, opts)
}

/**
 * Spawn one Node child running a TS entry script under the same tsx
 * loader and home sandbox spawnCli uses. For scenarios whose module
 * state freezes from homedir() at import (LOGS_DIR in src/debug.ts): a
 * fresh process starts its module graph with the redirected HOME
 * already in env, so the redirect lands — something impossible inside
 * the shared vitest worker, where earlier imports have already frozen
 * the real path.
 */
export function spawnNodeTs(
  script: string,
  args: string[],
  opts: { home: string; cwd?: string; input?: string; env?: Record<string, string | undefined> },
): CliSpawnResult {
  const env = sandboxedSpawnEnv(opts.home, opts.env)
  const r = spawnSync(process.execPath, nodeTsArgs(script, args), {
    cwd: opts.cwd ?? opts.home,
    env,
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: 120_000,
  })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? (r.error ? `spawn failed: ${r.error.message}` : '')
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` }
}

/**
 * The asynchronous sibling of spawnNodeTs: the same loader and the same
 * sandboxed env, but the live child handed back so a caller can watch its
 * streams and choose when to end stdin. For scenarios that must observe a
 * process while it runs — a stdio server whose shutdown work is the thing
 * under test — where spawnSync's "wait for exit, then read" is no help.
 * Every stream is piped, so nothing the child prints reaches the runner's
 * own stdout.
 */
export function spawnNodeTsAsync(
  script: string,
  args: string[],
  opts: { home: string; cwd?: string; env?: Record<string, string | undefined> },
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, nodeTsArgs(script, args), {
    cwd: opts.cwd ?? opts.home,
    env: sandboxedSpawnEnv(opts.home, opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
