import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'
import { markClaudeCodeInstalled } from '../helpers/home.js'

// Claude Code is present when `claude` is on PATH or one of its own
// artifacts is there (D51, as D383 read it for Gemini CLI before D399 retired it): never by the
// `~/.claude` directory alone, where install's own MCP launcher lives. The
// CLI runs under a redirected HOME with the machine's own `claude` hidden
// (sandboxedSpawnEnv), so detection here is by what each test lays out.

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const home = (layout: string[] = []): string => {
  const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-claude-detect-')))
  dirs.push(h)
  for (const d of layout) mkdirSync(join(h, d), { recursive: true })
  return h
}
const detected = (h: string, env?: Record<string, string>): string =>
  /^Detected agents: (.*)$/m.exec(spawnCli(['install', '--yes', '--dry-run'], { home: h, ...(env ? { env } : {}) }).stdout)?.[1] ?? ''
const claudeRow = (out: string): string | undefined => out.split('\n').find(l => /^\[\w+\]\s+Claude Code:/.test(l))
const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
const cursorArgs = (h: string): string[] =>
  ((json(join(h, '.cursor', 'mcp.json'))['mcpServers'] as Record<string, { args: string[] }>)['treecontext']!).args

describe('what shows Claude Code is installed (D51)', () => {
  test('~/.claude alone, or holding only what install writes there, is not Claude Code', () => {
    const h = home(['.claude'])
    expect(detected(h)).toBe('(none)')
    mkdirSync(join(h, '.claude', 'hooks'))
    writeFileSync(join(h, '.claude', 'hooks', 'tc-mcp-serve'), '#!/bin/sh\n')
    mkdirSync(join(h, '.claude', 'skills', 'treecontext-reference'), { recursive: true })
    expect(detected(h)).toBe('(none)')
  })

  test.each(['projects', '.credentials.json', 'statsig', 'todos'])('~/.claude/%s is Claude Code', (artifact) => {
    const h = home(['.claude'])
    if (artifact.endsWith('.json')) writeFileSync(join(h, '.claude', artifact), '{}')
    else mkdirSync(join(h, '.claude', artifact))
    expect(detected(h)).toBe('Claude Code')
  })

  test('~/.claude.json is Claude Code only when it holds a key of its own or another server', () => {
    const h = home()
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ mcpServers: { treecontext: { command: 'x', args: ['serve'] } } }))
    expect(detected(h)).toBe('(none)')
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ mcpServers: {} }))
    expect(detected(h)).toBe('(none)')
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { treecontext: {} } }))
    expect(detected(h)).toBe('Claude Code')
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ mcpServers: { github: {} } }))
    expect(detected(h)).toBe('Claude Code')
    writeFileSync(join(h, '.claude.json'), '{ not json')
    expect(detected(h)).toBe('Claude Code')
  })

  test("a settings.json of only what treecontext writes is not Claude Code; a key of the developer's is", () => {
    const h = home(['.claude'])
    const settings = join(h, '.claude', 'settings.json')
    const ours = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${join(h, '.claude', 'hooks', 'tc-session-start')}"` }] }] },
      permissions: { allow: ['mcp__treecontext__treecontext_status', 'mcp__treecontext__treecontext_insert'] },
      idleCompaction: false,
    }
    writeFileSync(settings, JSON.stringify(ours))
    expect(detected(h)).toBe('(none)')
    writeFileSync(settings, JSON.stringify({ hooks: {} }))
    expect(detected(h)).toBe('(none)')
    for (const theirs of [{ ...ours, model: 'opus' }, { ...ours, permissions: { allow: ['Bash(npm test)'] } }, { ...ours, permissions: { deny: ['mcp__treecontext__treecontext_clear'] } }]) {
      writeFileSync(settings, JSON.stringify(theirs))
      expect(detected(h), JSON.stringify(theirs)).toBe('Claude Code')
    }
    writeFileSync(settings, '{ "model": ')
    expect(detected(h)).toBe('Claude Code')
  })

  test.skipIf(process.platform === 'win32')('the claude command on PATH is Claude Code', () => {
    const h = home()
    const bin = join(h, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.302 (Claude Code)"\n')
    chmodSync(join(bin, 'claude'), 0o755)
    expect(detected(h, { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` })).toBe('Claude Code')
  })

  test("Claude Code's artifacts in a config directory CLAUDE_CONFIG_DIR relocates are Claude Code's", () => {
    const h = home(['profile/projects'])
    expect(detected(h)).toBe('(none)')
    expect(detected(h, { CLAUDE_CONFIG_DIR: join(h, 'profile') })).toBe('Claude Code')
  })
})

describe('a machine without Claude Code is never wired for it', () => {
  test('two installs on an Antigravity CLI machine write no Claude Code wiring, and doctor has no Claude Code row', () => {
    const h = home(['.gemini/antigravity-cli'])
    for (let i = 0; i < 2; i++) {
      const run = spawnCli(['install', '--yes'], { home: h })
      expect(run.status, run.out).toBe(0)
      expect(run.stdout).toContain('Detected agents: Antigravity CLI\n')
    }
    expect(existsSync(join(h, '.claude', 'hooks', `tc-mcp-serve${process.platform === 'win32' ? '.cmd' : ''}`)), 'the launcher is install\'s own').toBe(true)
    expect(existsSync(join(h, '.claude.json'))).toBe(false)
    expect(existsSync(join(h, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(h, '.claude', 'skills'))).toBe(false)
    expect(claudeRow(spawnCli(['doctor'], { home: h }).stdout)).toBeUndefined()
  })

  test("a second install on a Cursor-only machine keeps Cursor's entry without capture", () => {
    const h = home(['.cursor'])
    for (let i = 0; i < 2; i++) {
      const run = spawnCli(['install', '--yes'], { home: h })
      expect(run.status, run.out).toBe(0)
      expect(run.stdout).toContain('Detected agents: Cursor\n')
      expect(cursorArgs(h)).toContain('--no-capture')
      expect(cursorArgs(h)).not.toContain('--capture')
    }
  })
})

describe('a phantom Claude Code wiring an earlier install left (D51)', () => {
  test('doctor warns and names the uninstall; install leaves it; the uninstall clears it', () => {
    const h = home(['.gemini/antigravity-cli'])
    // What the earlier build wrote on its second run: Claude Code's wiring, with no Claude Code here.
    expect(spawnCli(['install', '--yes', '--agent', 'claude'], { home: h }).status).toBe(0)
    const out = spawnCli(['doctor'], { home: h }).stdout
    const row = claudeRow(out)
    expect(row, out).toBe(`[warn] Claude Code: an earlier install wired Claude Code, which is not present — ${join(h, '.claude.json')} and ${join(h, '.claude', 'settings.json')} hold its treecontext wiring, and no \`claude\` command or Claude Code file of its own is here (install leaves it alone)`)
    expect(out.split('\n')[out.split('\n').indexOf(row!) + 1]).toBe('       fix: treecontext uninstall --agent claude')
    const again = spawnCli(['install', '--yes'], { home: h })
    expect(again.stdout).toContain('Detected agents: Antigravity CLI\n')
    expect(json(join(h, '.claude.json'))['mcpServers']).toHaveProperty('treecontext')
    expect(claudeRow(spawnCli(['doctor'], { home: h }).stdout)).toMatch(/^\[warn\] Claude Code: an earlier install wired Claude Code/)
    expect(spawnCli(['uninstall', '--yes', '--agent', 'claude'], { home: h }).status).toBe(0)
    expect(claudeRow(spawnCli(['doctor'], { home: h }).stdout)).toBeUndefined()
  })

  test('where Claude Code is present, the wiring is no phantom', () => {
    const h = home()
    markClaudeCodeInstalled(h)
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(claudeRow(spawnCli(['doctor'], { home: h }).stdout)).not.toMatch(/an earlier install wired Claude Code/)
  })
})

describe("uninstalling Claude Code converges Cursor's and VS Code's capture mode (D386)", () => {
  test("Cursor's entry turns to no capture when the hooks block it read is gone, and keeps the rest", () => {
    const h = home(['.cursor'])
    markClaudeCodeInstalled(h)
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(cursorArgs(h)).toContain('--capture')
    const dry = spawnCli(['uninstall', '--yes', '--dry-run', '--agent', 'claude'], { home: h })
    expect(dry.stdout).toMatch(/Cursor: mcp entry set to no capture in .*mcp\.json — it read the Claude Code hooks block, which is gone \[dry-run/)
    expect(cursorArgs(h)).toContain('--capture')
    const run = spawnCli(['uninstall', '--yes', '--agent', 'claude'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toContain(`Cursor: mcp entry set to no capture in ${join(h, '.cursor', 'mcp.json')}`)
    expect(cursorArgs(h)).toContain('--no-capture')
    expect(cursorArgs(h)).not.toContain('--capture')
    const cursor = spawnCli(['doctor'], { home: h }).stdout.split('\n').find(l => /^\[\w+\]\s+Cursor:/.test(l)) ?? ''
    expect(cursor).toMatch(/server mode: standard/)
    expect(cursor).not.toMatch(/but no capture hooks run for this client/)
  })
})
