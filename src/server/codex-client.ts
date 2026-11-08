import { spawn } from 'node:child_process'
import type { CodexApprovalSupport } from './tool-approvals.js'

// ── What doctor and install ask the Codex CLI on PATH (D381, D387) ─────
//
// Two questions, each answered by Codex itself and neither calling a model:
// its version (`codex --version`), which says whether it reads per-tool
// approvals, and, on Linux, whether its sandbox works (`codex sandbox --
// true`), since a sandboxed Codex worker whose bubblewrap the system refuses
// a user namespace can read no file.

/**
 * The first Codex release verified to read per-tool approvals
 * (`mcp_servers.<name>.tools.<tool>.approval_mode`): 0.167.0, the dogfood's
 * Codex of 2026-11-07, until an older one is shown to read them (D381).
 */
export const CODEX_APPROVALS_FLOOR = '0.167.0'

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
