import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { CodexApprovalSupport } from './tool-approvals.js'

// ── What doctor and install ask the Codex CLI on PATH (D381, D387) ─────
//
// Two questions, each answered by Codex itself and neither calling a model:
// its version (`codex --version`), which says whether it reads per-tool
// approvals, and, on Linux, whether its sandbox works (`codex sandbox --
// true`), since a sandboxed Codex worker whose bubblewrap the system refuses
// a user namespace can read no file.

/**
 * The oldest Codex release verified to read per-tool approvals
 * (`mcp_servers.<name>.tools.<tool>.approval_mode`): 0.166.0, whose binary
 * on the dogfood machine accepts "approve" and refuses a bogus value with
 * "unknown variant" (2026-11-08); the floor rule is D381's, and it moves
 * down when an older Codex is shown to read them.
 */
export const CODEX_APPROVALS_FLOOR = '0.166.0'

/** How long a Codex probe may take before it is cut, group and all. */
export const CODEX_PROBE_TIMEOUT_MS = 20_000

const GROUPS = process.platform !== 'win32'

export interface BoundedRun {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The spawn itself failed (no such command). */
  missing: boolean
}

/** Run a command to its end or the bound, keeping both streams; nothing it started outlives the call. */
export function runBounded(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<BoundedRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: GROUPS, ...(env ? { env } : {}) })
    } catch {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false, missing: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const killGroup = (): void => {
      try {
        if (GROUPS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* gone */ }
    }
    const settle = (r: BoundedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup()
      resolve(r)
    }
    const timer = setTimeout(() => { timedOut = true; settle({ status: null, stdout, stderr, timedOut, missing: false }) }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', (e: NodeJS.ErrnoException) => settle({ status: null, stdout, stderr, timedOut: false, missing: e.code === 'ENOENT' }))
    child.on('close', (code) => settle({ status: code, stdout, stderr, timedOut, missing: false }))
  })
}

/** A Codex probe, through a shell hop on Windows, where `codex` is a .cmd shim. */
async function runCodex(args: string[], timeoutMs: number): Promise<BoundedRun> {
  const direct = await runBounded('codex', args, timeoutMs)
  if (!direct.missing || process.platform !== 'win32') return direct
  // The arguments are literals of this module, so the hop carries no input.
  return runBounded(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `codex ${args.join(' ')}`], timeoutMs)
}

/** The x.y.z in `codex --version`'s answer (`codex-cli 0.167.0`), or null. */
export function parseCodexVersion(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

function compareTriples(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The Codex on PATH: its version, or null when it cannot be read. */
export async function readCodexVersion(timeoutMs = 5000): Promise<string | null> {
  const r = await runCodex(['--version'], timeoutMs)
  return r.status === 0 ? parseCodexVersion(r.stdout) : null
}

export function codexApprovalSupport(version: string | null): CodexApprovalSupport {
  if (version === null) return { state: 'unreadable' }
  return compareTriples(version, CODEX_APPROVALS_FLOOR) < 0 ? { state: 'below-floor', version } : { state: 'reads', version }
}

// ── Codex's own sandbox check, on Linux (D387) ─────────────────────────

/** The command doctor runs: Codex's sandbox around `true`, no model call. */
export const CODEX_SANDBOX_CHECK = 'codex sandbox -- true'

/** What a refused user namespace says, in bubblewrap's words and Codex's. */
const USERNS_REFUSALS = [/RTM_NEWADDR: Operation not permitted/, /setting up uid map/, /No permissions to create new namespace/]

/** The AppArmor profile that lets /usr/bin/bwrap create user namespaces (the flatpak pattern). */
export const BWRAP_APPARMOR_PROFILE = 'abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }'

export interface SandboxRow {
  status: 'ok' | 'warn'
  detail: string
  fix?: string
}

/** The check's own words: its last lines on stderr (stdout when stderr is empty), bounded. */
function ownWords(run: BoundedRun): string {
  const text = run.stderr.trim() !== '' ? run.stderr : run.stdout
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '')
  const words = lines.slice(-3).join(' / ')
  return words.length > 400 ? `…${words.slice(-400)}` : words
}

/** Doctor's row for a finished sandbox check. */
export function sandboxRow(run: BoundedRun, timeoutMs: number = CODEX_SANDBOX_TIMEOUT_MS): SandboxRow {
  if (run.missing) {
    return { status: 'warn', detail: `\`${CODEX_SANDBOX_CHECK}\` could not run: no codex command on PATH, so whether a sandboxed Codex worker can read files is not known`, fix: `put Codex CLI on PATH (npm i -g @openai/codex), then run ${CODEX_SANDBOX_CHECK}` }
  }
  if (run.timedOut) {
    return { status: 'warn', detail: `\`${CODEX_SANDBOX_CHECK}\` did not finish within ${Math.round(timeoutMs / 1000)} s${ownWords(run) ? `: ${ownWords(run)}` : ''}`, fix: `run ${CODEX_SANDBOX_CHECK} yourself and read what it says` }
  }
  if (run.status === 0) {
    return { status: 'ok', detail: `\`${CODEX_SANDBOX_CHECK}\` passed: a sandboxed Codex worker can run and read files` }
  }
  const words = ownWords(run)
  if (USERNS_REFUSALS.some(re => re.test(`${run.stderr}\n${run.stdout}`))) {
    const steps = 'install the bubblewrap package (on Ubuntu: sudo apt install bubblewrap); '
      + `write an AppArmor profile that lets /usr/bin/bwrap create user namespaces at /etc/apparmor.d/bwrap: ${BWRAP_APPARMOR_PROFILE}; `
      + 'load it with sudo apparmor_parser -r /etc/apparmor.d/bwrap'
    return {
      status: 'warn',
      detail: `\`${CODEX_SANDBOX_CHECK}\` failed: the system refuses bubblewrap a user namespace (${words}), so a sandboxed Codex worker can read no file. `
        + `Steps for you to run, as root: ${steps}; then run ${CODEX_SANDBOX_CHECK} again. treecontext changes no system file`,
      fix: `${steps} (treecontext changes no system file)`,
    }
  }
  return {
    status: 'warn',
    detail: `\`${CODEX_SANDBOX_CHECK}\` failed (exit ${run.status ?? 'unknown'}): ${words || 'it printed nothing'}`,
    fix: `run ${CODEX_SANDBOX_CHECK} yourself and act on what it says`,
  }
}

/** How long the sandbox check may take before doctor cuts it. */
export const CODEX_SANDBOX_TIMEOUT_MS = CODEX_PROBE_TIMEOUT_MS

/** Run Codex's own sandbox check. */
export function runCodexSandboxCheck(timeoutMs: number = CODEX_SANDBOX_TIMEOUT_MS): Promise<BoundedRun> {
  return runCodex(['sandbox', '--', 'true'], timeoutMs)
}

// ── Codex's own reading of its configuration, for a directory (D387) ───

/** Where a key of Codex's effective configuration came from, as its app server says. */
export interface CodexOrigin { name?: { type?: string; file?: string; dotCodexFolder?: string } }

export type CodexConfigRead =
  | { ok: true; config: Record<string, unknown>; origins: Record<string, CodexOrigin> }
  | { ok: false; why: string; refused?: string }

/**
 * Codex's effective configuration as seen from `cwd`, with each key's
 * origin: its app server's `config/read` request over stdio, the one every
 * Codex front end makes for its settings (no model call, no sign-in). A
 * trusted project's `.codex/config.toml` can override the user's file, and
 * only this reading shows it. Bounded, and nothing it starts outlives it.
 */
export function readCodexConfig(cwd: string, timeoutMs: number = CODEX_PROBE_TIMEOUT_MS): Promise<CodexConfigRead> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    const win = process.platform === 'win32'
    try {
      // On Windows `codex` is a .cmd shim; the arguments are literals.
      child = spawn(win ? (process.env['ComSpec'] ?? 'cmd.exe') : 'codex', win ? ['/d', '/s', '/c', 'codex app-server'] : ['app-server'], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: GROUPS,
      })
    } catch (e) {
      resolve({ ok: false, why: e instanceof Error ? e.message : String(e) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const settle = (r: CodexConfigRead): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin?.end() } catch { /* closed */ }
      try {
        if (GROUPS && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* gone */ }
      resolve(r)
    }
    const timer = setTimeout(() => settle({ ok: false, why: `codex app-server did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
    child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    // A codex that exits before reading its stdin (an old one, or no app
    // server) must not take doctor down with an EPIPE: its exit says why.
    child.stdin?.on('error', () => { /* the close handler reports it */ })
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      const lines = out.split('\n')
      out = lines.pop() ?? ''
      for (const line of lines) {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (msg['id'] !== 1) continue
        const result = msg['result'] as { config?: Record<string, unknown>; origins?: Record<string, CodexOrigin> } | undefined
        if (result?.config) settle({ ok: true, config: result.config, origins: result.origins ?? {} })
        else {
          const said = (msg['error'] as { message?: unknown } | undefined)?.message
          // Codex itself refusing its configuration: its own words, whole.
          const refused = typeof said === 'string' && /invalid configuration|(?:cannot|could not|failed to) (?:be )?(?:load|read|parse)/i.test(said) ? said.trim() : undefined
          settle({ ok: false, why: `codex app-server answered config/read with ${JSON.stringify(msg['error'] ?? msg).slice(0, 300)}`, ...(refused ? { refused } : {}) })
        }
      }
    })
    child.on('error', (e) => settle({ ok: false, why: e.message }))
    child.on('close', (code) => {
      const said = err.split('\n').map(l => l.trim()).filter(l => l !== '').slice(-2).join(' / ')
      settle({ ok: false, why: `codex app-server exited ${code ?? 'on a signal'} before answering${said ? `: ${said}` : ''}` })
    })
    const send = (m: unknown): void => { child.stdin?.write(`${JSON.stringify(m)}\n`) }
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'treecontext-doctor', version: '1' } } })
    send({ method: 'initialized' })
    send({ method: 'config/read', id: 1, params: { cwd, includeLayers: false } })
  })
}

/** The file a key of Codex's effective configuration came from, in words. */
export function codexOriginFile(origins: Record<string, CodexOrigin>, key: string, fallback: string): string {
  const name = origins[key]?.name
  if (!name) return fallback
  if (name.file) return name.file
  if (name.dotCodexFolder) return join(name.dotCodexFolder, 'config.toml')
  return name.type ? `Codex's ${name.type} configuration` : fallback
}
