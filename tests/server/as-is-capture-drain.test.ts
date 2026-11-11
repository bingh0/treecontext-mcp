/**
 * An as-is client's captures drain through its own server (D386, D29).
 *
 * Cursor reads the Claude Code hooks block by default, so its sessions fire
 * the real hooks and stage what they capture. Its entry must therefore start
 * the server in capture mode, or what Cursor staged waits for some other
 * client's server. The charter outline for D386 names Claude Code, Codex CLI
 * and Antigravity CLI only, so this rule is bound here, not there: a binding
 * gap the gate should know of.
 *
 * End to end, in a sandbox HOME: the real install, the real
 * tc-user-prompt-submit wrapper fired with Cursor's payload, Cursor's entry
 * started through the real launcher (startEntryAsClient, this build
 * compiled), and SQL on the store's staging table: the row is processed.
 * The control is the same entry with its capture flag turned off, whose
 * server leaves the row where it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { spawnCli, sandboxedSpawnEnv } from '../helpers/cli-spawn.js'
import { markClaudeCodeInstalled, storesDirIn } from '../helpers/home.js'
import { placeBuiltPackage } from '../helpers/built-package.js'
import { TS_ROOT } from '../journal/proc.js'
import { startEntryAsClient } from '../journal/standins.js'
import { agentConfigPath } from '../journal/install-harness.js'

let home: string
let proj: string

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-asis-home-')))
  proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-asis-proj-')))
  for (const d of ['.claude', '.cursor']) mkdirSync(join(home, d), { recursive: true })
  markClaudeCodeInstalled(home)
})
afterEach(() => {
  // Retried: on Windows the server just stopped may still be closing.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  rmSync(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

const cursorEntry = (): { command: string; args: string[] } =>
  (JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')) as { mcpServers: { treecontext: { command: string; args: string[] } } }).mcpServers.treecontext

/** Fire the wrapper install wrote, as Cursor fires the Claude Code block. */
function fireUserPrompt(prompt: string): void {
  const unplace = placeBuiltPackage(home)
  try {
    const wrapper = join(home, '.claude', 'hooks', `tc-user-prompt-submit${process.platform === 'win32' ? '.cmd' : ''}`)
    const r = spawnSync(process.platform === 'win32' ? `"${wrapper}"` : wrapper, [], {
      input: JSON.stringify({ session_id: 'cursor-session-1', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt }),
      env: sandboxedSpawnEnv(home), cwd: proj, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32',
    })
    expect(r.status, r.stderr).toBe(0)
  } finally { unplace() }
}

/** The staging rows of the one store under the sandbox, by processed state. */
function staging(): { pending: number; processed: number } {
  const stores = storesDirIn(home)
  const dbs = existsSync(stores) ? readdirSync(stores).map(n => join(stores, n, 'treecontext.db')).filter(existsSync) : []
  expect(dbs.length, 'the hook staged into no store').toBe(1)
  const db = new DatabaseSync(dbs[0]!, { readOnly: true })
  try {
    const row = db.prepare('SELECT SUM(processed = 0) AS pending, SUM(processed = 1) AS processed FROM staging').get() as { pending: number | null; processed: number | null }
    return { pending: row.pending ?? 0, processed: row.processed ?? 0 }
  } finally { db.close() }
}

describe("Cursor's entry drains what the Claude Code block captures in Cursor", () => {
  it('a staged prompt is processed by the server Cursor starts, and not by one without capture', async () => {
    const install = spawnCli(['install', '--yes'], { home, cwd: TS_ROOT })
    expect(install.status, install.out).toBe(0)
    const entry = cursorEntry()
    expect(entry.args, 'Cursor reads the installed block, so its entry captures').toContain('--capture')

    fireUserPrompt('cursor asked for the flange torque table')
    expect(staging()).toEqual({ pending: 1, processed: 0 })

    // Control: the same entry, capture turned off, leaves the row staged.
    const off = { ...entry, args: entry.args.map(a => (a === '--capture' ? '--no-capture' : a)) }
    expect(await startEntryAsClient(home, off, proj)).toBe('standard')
    await new Promise(r => setTimeout(r, 3_000))
    expect(staging(), 'a server without capture drained the row: the control proves nothing').toEqual({ pending: 1, processed: 0 })

    const mode = await startEntryAsClient(home, entry, proj, () => staging().processed === 1)
    expect(mode).toBe('conversation-indexer')
    expect(staging()).toEqual({ pending: 0, processed: 1 })
  }, 180_000)
})

/** Doctor's row for one client, and its fix line, off doctor's own stdout. */
function doctorRow(name: string): { line: string; fix: string | null } {
  const r = spawnCli(['doctor'], { home, cwd: TS_ROOT })
  expect(r.status, r.out).toBe(0)
  const lines = r.stdout.split('\n')
  const i = lines.findIndex(l => new RegExp(`^\\[\\w+\\]\\s+${name}:`).test(l))
  expect(i, r.stdout).toBeGreaterThanOrEqual(0)
  return { line: lines[i]!, fix: /^\s+fix: (.+)$/.exec(lines[i + 1] ?? '')?.[1] ?? null }
}

describe('the as-is clients: capture mode wherever the Claude Code block runs for them (D386)', () => {
  const args = (slug: 'vscode' | 'cursor'): string[] => {
    const data = JSON.parse(readFileSync(agentConfigPath(slug, home), 'utf8')) as Record<string, Record<string, { args: string[] }>>
    return (data['servers'] ?? data['mcpServers'])!['treecontext']!.args
  }

  it('Cursor without the Claude Code block gets tools only; with it, capture; and an old capture entry is not a false warning', () => {
    let r = spawnCli(['install', '--yes', '--agent', 'cursor'], { home, cwd: TS_ROOT })
    expect(r.status, r.out).toBe(0)
    expect(args('cursor')).toContain('--no-capture')
    expect(doctorRow('Cursor').line).toMatch(/^\[ok\]\s+Cursor: MCP configured, server mode: standard \(no auto-capture\) \(this client: tools only\), /)
    r = spawnCli(['install', '--yes', '--agent', 'claude'], { home, cwd: TS_ROOT })
    expect(r.status, r.out).toBe(0)
    // The block is installed now: Cursor reads it, and its tools-only entry disagrees.
    const stale = doctorRow('Cursor')
    expect(stale.line).toMatch(/^\[warn\].*this client's hooks run, and this server does not drain what they stage/)
    expect(stale.fix).toBe('treecontext install --agent cursor')
    r = spawnCli(stale.fix!.split(' ').slice(1), { home, cwd: TS_ROOT })
    expect(r.status, r.out).toBe(0)
    expect(args('cursor')).toContain('--capture')
    expect(doctorRow('Cursor').line).toMatch(/^\[ok\]\s+Cursor: MCP configured, server mode: capture \(this client: reads the Claude Code hooks block\), /)
  }, 120_000)

  it("VS Code gets capture only while chat.useClaudeHooks is on, and doctor names the install when the setting moves", () => {
    mkdirSync(dirname(agentConfigPath('vscode', home)), { recursive: true })
    const settings = join(dirname(agentConfigPath('vscode', home)), 'settings.json')
    let r = spawnCli(['install', '--yes'], { home, cwd: TS_ROOT })
    expect(r.status, r.out).toBe(0)
    expect(args('vscode')).toContain('--no-capture')
    expect(doctorRow('VS Code').line).toMatch(/^\[ok\]/)

    writeFileSync(settings, JSON.stringify({ 'chat.useClaudeHooks': true }))
    const on = doctorRow('VS Code')
    expect(on.line).toMatch(/^\[warn\].*server mode: standard \(no auto-capture\).*this server does not drain what they stage/)
    expect(on.fix).toBe('treecontext install --agent vscode')
    // The indexer row names the same command: one agent is the cause.
    const indexer = doctorRow('Conversation indexer')
    expect(indexer.line).toMatch(/^\[warn\]\s+Conversation indexer: 1 of \d+ agents? in a mode their capture hooks disagree with/)
    expect(indexer.fix).toBe('treecontext install --agent vscode')
    r = spawnCli(on.fix!.split(' ').slice(1), { home, cwd: TS_ROOT })
    expect(r.status, r.out).toBe(0)
    expect(args('vscode')).toContain('--capture')
    expect(doctorRow('VS Code').line).toMatch(/^\[ok\]/)

    writeFileSync(settings, JSON.stringify({ 'chat.useClaudeHooks': false }))
    const off = doctorRow('VS Code')
    expect(off.line).toMatch(/^\[warn\].*server mode: capture.*but no capture hooks run for this client/)
    expect(off.fix).toBe('treecontext install --agent vscode')
  }, 120_000)
})
