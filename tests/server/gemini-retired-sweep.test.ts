import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'
import { MARKER_START } from '../../src/server/installer.js'

// Review fixes to unit 7c (D399): what an earlier Gemini CLI install left,
// named and swept through the real CLI under a redirected HOME, and the
// agent names install and uninstall take.

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const home = (layout: string[] = []): string => {
  const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-gsweep-')))
  dirs.push(h)
  for (const d of layout) mkdirSync(join(h, d), { recursive: true })
  return h
}
const md = (h: string): string => join(h, '.gemini', 'GEMINI.md')
const settings = (h: string): string => join(h, '.gemini', 'settings.json')
const BLOCK = `${MARKER_START}\nold block\n<!-- treecontext:end -->\n`
const geminiRow = (out: string): string[] => {
  const lines = out.split('\n')
  const i = lines.findIndex(l => /^\[\w+\]\s+Gemini CLI:/.test(l))
  return i < 0 ? [] : [lines[i]!, lines[i + 1] ?? '']
}
const wrapperDir = (h: string): string => join(h, '.claude', 'hooks')
const layWrappers = (h: string): void => {
  mkdirSync(wrapperDir(h), { recursive: true })
  for (const s of ['session-start', 'before-agent', 'after-tool', 'pre-compress']) {
    writeFileSync(join(wrapperDir(h), `tc-gemini-${s}`), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
}
const left = (h: string): string[] => existsSync(wrapperDir(h)) ? readdirSync(wrapperDir(h)).filter(f => f.startsWith('tc-gemini-')) : []

describe.skipIf(process.platform === 'win32')('the Gemini-era block in GEMINI.md and the wrapper clause (D399)', () => {
  test('where agy is not wired, doctor names the block and the wrappers, and uninstall --agent gemini removes both, only the marked block', () => {
    const h = home(['.gemini'])
    layWrappers(h)
    writeFileSync(md(h), `# my notes\n\n${BLOCK}`)
    const [row, fix] = geminiRow(spawnCli(['doctor'], { home: h }).stdout)
    expect(row).toContain(`4 Gemini CLI hook wrappers in ${wrapperDir(h)}`)
    expect(row).toContain(`the treecontext block in ${md(h)}`)
    expect(row).not.toContain('stays')
    expect(fix).toBe('       fix: treecontext uninstall --agent gemini')
    const un = spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(readFileSync(md(h), 'utf8')).toBe('# my notes\n')
    expect(left(h)).toEqual([])
    expect(geminiRow(spawnCli(['doctor'], { home: h }).stdout)).toEqual([])
  })

  test('where agy is wired, the block stays under the sweep, and the row says it is agy\'s and stays', () => {
    const h = home(['.gemini/antigravity-cli', '.gemini/config'])
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    layWrappers(h)
    const before = readFileSync(md(h), 'utf8')
    const [row] = geminiRow(spawnCli(['doctor'], { home: h }).stdout)
    expect(row).toContain('4 Gemini CLI hook wrappers')
    expect(row).not.toContain('the treecontext block in')
    expect(row).toContain("is Antigravity CLI's and stays")
    expect(spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h }).status).toBe(0)
    expect(readFileSync(md(h), 'utf8')).toBe(before)
  })
})

describe.skipIf(process.platform === 'win32')('empty instruction files go only when install made them (D399)', () => {
  test('a developer\'s own blank GEMINI.md survives the removal of the block; one install created is deleted', () => {
    const mine = home(['.gemini/antigravity-cli', '.gemini/config'])
    writeFileSync(md(mine), '')
    expect(spawnCli(['install', '--yes'], { home: mine }).status).toBe(0)
    expect(readFileSync(md(mine), 'utf8')).toContain(MARKER_START)
    expect(spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: mine }).status).toBe(0)
    expect(existsSync(md(mine)), 'the developer\'s blank file was deleted').toBe(true)
    expect(readFileSync(md(mine), 'utf8')).toBe('')

    const made = home(['.gemini/antigravity-cli', '.gemini/config'])
    expect(spawnCli(['install', '--yes'], { home: made }).status).toBe(0)
    expect(spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: made }).status).toBe(0)
    expect(existsSync(md(made)), 'a file install created was left').toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('the sweep and the emptied mcpServers key (D399)', () => {
  const treecontext = { command: '/x/tc-mcp-serve', args: ['serve'] }
  test('a settings file the sweep leaves with an empty mcpServers loses the key, and keeps the developer\'s keys', () => {
    const h = home(['.gemini'])
    writeFileSync(settings(h), JSON.stringify({ theme: 'Default', mcpServers: { treecontext } }))
    expect(spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h }).status).toBe(0)
    expect(JSON.parse(readFileSync(settings(h), 'utf8'))).toEqual({ theme: 'Default' })
  })
  test('a file install\'s record says it created is deleted once it is {}; without the record it stays', () => {
    const recorded = home(['.gemini', '.treecontext'])
    writeFileSync(settings(recorded), JSON.stringify({ mcpServers: { treecontext } }))
    writeFileSync(join(recorded, '.treecontext', 'install-state.json'), JSON.stringify({ createdFiles: { [settings(recorded)]: { at: '2026-11-01T00:00:00.000Z' } } }))
    expect(spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: recorded }).status).toBe(0)
    expect(existsSync(settings(recorded))).toBe(false)
    const plain = home(['.gemini'])
    writeFileSync(settings(plain), JSON.stringify({ mcpServers: { treecontext } }))
    expect(spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: plain }).status).toBe(0)
    expect(JSON.parse(readFileSync(settings(plain), 'utf8'))).toEqual({})
  })
})

describe.skipIf(process.platform === 'win32')('a full uninstall after an install for another agent alone (D399)', () => {
  test('takes the Claude Code hook scripts and the launcher that install wrote, no agent entry left to need them', () => {
    const h = home(['.codex'])
    expect(spawnCli(['install', '--yes', '--agent', 'codex'], { home: h }).status).toBe(0)
    const scripts = (): string[] => existsSync(wrapperDir(h)) ? readdirSync(wrapperDir(h)).filter(f => f.startsWith('tc-')) : []
    expect(scripts(), 'the codex install wrote no scripts to remove').toContain('tc-mcp-serve')
    const un = spawnCli(['uninstall', '--yes'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(scripts()).toEqual([])
  })
  test('a run naming one agent keeps the launcher while another agent still starts treecontext through it', () => {
    const h = home(['.codex', '.gemini/antigravity-cli', '.gemini/config'])
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(spawnCli(['uninstall', '--yes', '--agent', 'codex'], { home: h }).status).toBe(0)
    expect(existsSync(join(wrapperDir(h), 'tc-mcp-serve'))).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('agent names match in any case; an unknown one named alone fails (D399)', () => {
  test('install --agent AGY wires Antigravity CLI', () => {
    const h = home(['.gemini'])
    const run = spawnCli(['install', '--yes', '--agent', 'AGY'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(run.stdout).toMatch(/^Detected agents: Antigravity CLI$/m)
    expect(existsSync(join(h, '.gemini', 'config', 'mcp_config.json'))).toBe(true)
  })
  test('install --agent Gemini is refused as retired, whatever the case', () => {
    const run = spawnCli(['install', '--yes', '--agent', 'Gemini'], { home: home() })
    expect(run.status, run.out).toBe(1)
    expect(run.stderr).toContain('Gemini CLI is retired')
    expect(run.stderr).toContain('treecontext uninstall --agent gemini')
  })
  test('install --agent nosuch exits non-zero and names the agent', () => {
    const run = spawnCli(['install', '--yes', '--agent', 'nosuch'], { home: home() })
    expect(run.status, run.out).toBe(1)
    expect(run.stderr).toContain('nosuch')
  })
  test('uninstall --agent AGY uninstalls it; uninstall --agent nosuch exits non-zero; --agent GEMINI is the sweep and exits 0', () => {
    const h = home(['.gemini/antigravity-cli', '.gemini/config'])
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const un = spawnCli(['uninstall', '--yes', '--agent', 'AGY'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(un.stdout).toContain('Antigravity CLI: mcp removed from')
    const bad = spawnCli(['uninstall', '--yes', '--agent', 'nosuch'], { home: h })
    expect(bad.status, bad.out).toBe(1)
    expect(bad.out).toContain('unknown agent: nosuch')
    expect(spawnCli(['uninstall', '--yes', '--agent', 'GEMINI'], { home: h }).status).toBe(0)
  })
})
