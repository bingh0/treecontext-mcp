/**
 * The as-is clients, VS Code and Cursor, through the real CLI in a
 * redirected HOME (D208, D226): they read the Claude settings file
 * themselves, so the installer writes nothing for them even behind
 * --experimental-capture; a copy an earlier build wrote into their own hook
 * file is a second route doctor warns about, with the uninstall that removes
 * it, and that uninstall leaves the tools in place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnCli, type CliSpawnResult } from '../helpers/cli-spawn.js'
import { TS_ROOT } from '../journal/proc.js'
import { agentConfigPath } from '../journal/install-harness.js'

let home: string

const cli = (args: string[]): CliSpawnResult => spawnCli(args, { home, cwd: TS_ROOT })
const ok = (args: string[]): CliSpawnResult => {
  const r = cli(args)
  expect(r.status, r.out).toBe(0)
  return r
}

interface Row { status: string; state: string; remedy: string; fix: string | null }

function row(name: string): Row {
  const out = ok(['doctor']).stdout
  const lines = out.split('\n')
  const i = lines.findIndex(l => new RegExp(`^\\[\\w+\\]\\s+${name}:`).test(l))
  expect(i, out).toBeGreaterThanOrEqual(0)
  const m = /^\[(\w+)\].*?; state: (.+?); remedy: (.+)$/.exec(lines[i]!)
  expect(m, lines[i]).not.toBeNull()
  return { status: m![1]!, state: m![2]!, remedy: m![3]!, fix: /^\s+fix: (.+)$/.exec(lines[i + 1] ?? '')?.[1] ?? null }
}

const ownHookFile: Record<string, () => string> = {
  vscode: () => join(home, '.copilot', 'hooks', 'treecontext.json'),
  cursor: () => join(home, '.cursor', 'hooks.json'),
}
const name: Record<string, string> = { vscode: 'VS Code', cursor: 'Cursor' }
const wrappers = (slug: string): string[] => {
  const dir = join(home, '.claude', 'hooks')
  return existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(`tc-${slug}-`)) : []
}

/** What an earlier build's --experimental-capture left: a wrapper and the client's own hook file naming it. */
function writeLegacyCopy(slug: string): void {
  const wrapper = join(home, '.claude', 'hooks', `tc-${slug}-session-start`)
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(wrapper, '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  mkdirSync(dirname(ownHookFile[slug]!()), { recursive: true })
  const entry = slug === 'vscode'
    ? { version: 1, hooks: { sessionStart: [{ type: 'command', bash: `"${wrapper}"`, timeoutSec: 10 }] } }
    : { version: 1, hooks: { sessionStart: [{ command: `"${wrapper}"` }], somethingForeign: [{ command: 'other-tool run' }] } }
  writeFileSync(ownHookFile[slug]!(), JSON.stringify(entry))
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-asis-home-')))
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(dirname(agentConfigPath('vscode', home)), { recursive: true })
  mkdirSync(join(home, '.cursor'), { recursive: true })
  ok(['install', '--yes', '--agent', 'claude'])
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe.each(['vscode', 'cursor'])('%s, an as-is client', (slug) => {
  it('the experimental flag writes nothing for it and says why in one line', () => {
    const r = ok(['install', '--yes', '--agent', slug, '--experimental-capture'])
    expect(r.stdout).toContain(slug === 'vscode'
      ? 'hooks: nothing to write — VS Code reads the Claude settings file; turn chat.useClaudeHooks on'
      : 'hooks: nothing to write — Cursor reads the Claude settings file by default')
    expect(existsSync(ownHookFile[slug]!())).toBe(false)
    expect(wrappers(slug)).toEqual([])
    // The tools are still wired.
    expect(readFileSync(agentConfigPath(slug, home), 'utf8')).toContain('treecontext')
    expect(row(name[slug]!).status).toBe('ok')
  }, 120_000)

  it("an earlier build's copy reads as a second route with the uninstall as its remedy, and the uninstall clears it", () => {
    ok(['install', '--yes', '--agent', slug])
    writeLegacyCopy(slug)
    const before = row(name[slug]!)
    expect(before.status).toBe('warn')
    expect(before.state).toContain(`a copy of the hooks an earlier build wrote in ${ownHookFile[slug]!()} runs beside it (two hook routes)`)
    expect(before.remedy).toBe(`to remove the second route: treecontext uninstall --agent ${slug} --hooks-only`)
    expect(before.fix).toBe(`treecontext uninstall --agent ${slug} --hooks-only`)

    ok(before.fix!.split(/\s+/).slice(1))
    expect(wrappers(slug)).toEqual([])
    if (slug === 'cursor') {
      // Only our entry goes; the user's own hook in the same file stays.
      expect(JSON.parse(readFileSync(ownHookFile.cursor!(), 'utf8'))).toMatchObject({ hooks: { somethingForeign: [{ command: 'other-tool run' }] } })
    }
    const after = row(name[slug]!)
    expect(after.status).toBe('ok')
    expect(after.state).not.toContain('two hook routes')
    // The tools survived the hooks-only uninstall.
    expect(readFileSync(agentConfigPath(slug, home), 'utf8')).toContain('treecontext')
  }, 120_000)
})
