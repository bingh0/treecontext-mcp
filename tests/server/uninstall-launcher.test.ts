import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'
import { markClaudeCodeInstalled } from '../helpers/home.js'

// The MCP launcher lives in Claude Code's hooks directory but every agent's
// MCP entry starts the server through it: uninstalling Claude Code alone must
// not strand the others (found by the beta.4 final-review fix round).
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const home = (): string => {
  const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-launcher-')))
  dirs.push(h)
  mkdirSync(join(h, '.codex'), { recursive: true })
  markClaudeCodeInstalled(h)
  return h
}
const launcher = (h: string): string => join(h, '.claude', 'hooks', process.platform === 'win32' ? 'tc-mcp-serve.cmd' : 'tc-mcp-serve')
const ok = (h: string, args: string[]): string => {
  const r = spawnCli(args, { home: h })
  expect(r.status, r.stdout + r.stderr).toBe(0)
  return r.stdout
}

describe('the MCP launcher outlives an uninstall of Claude Code while another agent uses it', () => {
  test('uninstall --agent claude keeps it for Codex, says so, and the full uninstall takes it', () => {
    const h = home()
    ok(h, ['install', '--yes', '--agent', 'claude'])
    ok(h, ['install', '--yes', '--agent', 'codex'])
    expect(existsSync(launcher(h))).toBe(true)
    // Where the Codex on PATH is at its capture floor, install wrote Codex's
    // own hooks, which run Claude Code's hook scripts: uninstalling Claude
    // Code alone then keeps those scripts too, says the uninstall is
    // incomplete and exits non-zero. With no such Codex it exits 0. Either
    // way the launcher is kept and said.
    const partial = spawnCli(['uninstall', '--yes', '--agent', 'claude'], { home: h })
    const out = partial.stdout
    if (partial.status !== 0) {
      expect(partial.status, out + partial.stderr).toBe(1)
      expect(out).toMatch(/kept the Claude Code hook scripts .*Codex CLI still runs them through its own hooks/)
      expect(out).toContain('Uninstall incomplete')
    }
    expect(existsSync(launcher(h)), 'Codex still starts treecontext through the launcher').toBe(true)
    expect(out).toMatch(/kept the MCP launcher .*Codex CLI still starts treecontext through it/)
    ok(h, ['uninstall', '--yes'])
    expect(existsSync(launcher(h)), 'the full uninstall takes the launcher').toBe(false)
  }, 120_000)
  test('with no other agent wired, uninstall --agent claude takes it', () => {
    const h = home()
    ok(h, ['install', '--yes', '--agent', 'claude'])
    ok(h, ['uninstall', '--yes', '--agent', 'claude'])
    expect(existsSync(launcher(h))).toBe(false)
  }, 120_000)
})
