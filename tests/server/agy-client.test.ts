import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnCli } from '../helpers/cli-spawn.js'
import {
  AGY_DIALECT, APPROVED_TOOLS, agyHeadlessClause, agyRuleCovers, agyView, withAllowRules, withoutAllowRules,
} from '../../src/server/tool-approvals.js'
import { MARKER_START } from '../../src/server/installer.js'

// Antigravity CLI as a tools-only client (D383, D387, D390) in the corners
// the charter scenarios do not reach: how an agy rule names a tool, the
// merge beside the developer's rules, the row's other states, detection of
// the directory Gemini CLI and agy share, the shared instruction block, the
// project file doctor reads, and the permissions of the files install
// rewrites. The CLI runs under a redirected HOME; the machine's own `agy`
// and `gemini` are hidden from it (sandboxedSpawnEnv), so detection here is
// by the directories each test lays out.

const FOUR = APPROVED_TOOLS.map(t => `mcp(treecontext/${t})`)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const home = (layout: string[] = ['.gemini/antigravity-cli', '.gemini/config']): string => {
  const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-agy-')))
  dirs.push(h)
  for (const d of layout) mkdirSync(join(h, d), { recursive: true })
  return h
}
const settingsPath = (h: string): string => join(h, '.gemini', 'antigravity-cli', 'settings.json')
const settings = (h: string): Record<string, unknown> => JSON.parse(readFileSync(settingsPath(h), 'utf8')) as Record<string, unknown>
const mcpPath = (h: string): string => join(h, '.gemini', 'config', 'mcp_config.json')
const agyRow = (out: string): string => out.split('\n').find(l => /^\[\w+\]\s+Antigravity CLI:/.test(l)) ?? ''

describe('an agy rule names a tool as agy reads it', () => {
  test('the tool, the whole server and every server cover it; another server or tool does not', () => {
    for (const r of ['mcp(treecontext/treecontext_insert)', 'mcp(treecontext/*)', 'mcp(*)', 'mcp(tree*/treecontext_ins*)', ' mcp( treecontext/* ) ']) {
      expect(agyRuleCovers(r, 'treecontext_insert'), r).toBe(true)
    }
    for (const r of ['mcp(treecontext/treecontext_delete)', 'mcp(github/*)', 'command(treecontext)', 'mcp(treecontextx/*)', 'mcp__treecontext__treecontext_insert']) {
      expect(agyRuleCovers(r, 'treecontext_insert'), r).toBe(false)
    }
  })

  test("install adds the four where nothing of the developer's decides, never beside an ask, a deny or a wildcard, and keeps every other key", () => {
    const merged = withAllowRules({ trustedWorkspaces: ['/w'], permissions: { allow: ['mcp(github/*)'], deny: ['mcp(treecontext/treecontext_export)'] } }, undefined, AGY_DIALECT)
    expect(merged.added).toEqual(FOUR.filter(r => !r.endsWith('_export)')))
    expect(merged.data).toEqual({ trustedWorkspaces: ['/w'], permissions: { allow: ['mcp(github/*)', ...merged.added], deny: ['mcp(treecontext/treecontext_export)'] } })
    for (const wide of ['mcp(treecontext/*)', 'mcp(*)']) {
      for (const list of ['allow', 'ask', 'deny']) {
        const m = withAllowRules({ permissions: { [list]: [wide] } }, undefined, AGY_DIALECT)
        expect(m.added, `${list} ${wide}`).toEqual([])
        expect(m.data).toBeNull()
      }
    }
    // Taken back by the record alone: a rule the developer moved to ask is theirs now.
    const taken = withoutAllowRules({ permissions: { allow: [FOUR[0], 'mcp(github/*)'], ask: [FOUR[1]] } }, { items: FOUR.slice(0, 2), at: '' })
    expect(taken.data).toEqual({ permissions: { allow: ['mcp(github/*)'], ask: [FOUR[1]] } })
  })
})

describe("doctor's agy clause in the states the outline does not list", () => {
  const view = agyView([{ file: '/s.json', data: { permissions: { allow: FOUR } }, recorded: { items: FOUR, at: '' } }])
  const base = { mcpPath: '/m.json', view, settingsFile: '/s.json', choice: { state: 'on' } as const, unreadable: [], unplaced: [] }
  test("a server the developer turned off is theirs: warned, with agy's own command to turn it on", () => {
    const c = agyHeadlessClause({ ...base, entry: { state: 'present', disabled: true } })
    expect(c.warn).toBe(true)
    expect(c.text).toBe('headless workers: agy has no treecontext tools — the treecontext server is turned off ("disabled": true) in /m.json')
    expect(c.fix).toBe('your "disabled": true on the treecontext server in /m.json, yours to change (install leaves it): agy mcp enable treecontext')
  })
  test('a configuration agy cannot parse', () => {
    const c = agyHeadlessClause({ ...base, entry: { state: 'unreadable' } })
    expect(c.warn).toBe(true)
    expect(c.text).toMatch(/does not parse, and agy refuses it$/)
  })
  test("a project file whose rules doctor cannot place is said, never silently skipped", () => {
    const c = agyHeadlessClause({ ...base, entry: { state: 'present', disabled: false }, unplaced: ['/p.json'] })
    expect(c.warn).toBe(true)
    expect(c.text).toMatch(/\/p\.json holds permission rules for a project doctor cannot place, which agy may apply here$/)
  })
})

describe('the directory Gemini CLI and agy share (D383)', () => {
  const detected = (h: string): string => /^Detected agents: (.*)$/m.exec(spawnCli(['install', '--yes', '--dry-run'], { home: h }).stdout)?.[1] ?? ''
  test("~/.gemini alone is Gemini CLI's, as before", () => {
    expect(detected(home(['.gemini']))).toBe('Gemini CLI')
  })
  test("with agy's own directories there, the directory alone is not Gemini CLI", () => {
    expect(detected(home())).toBe('Antigravity CLI')
    expect(detected(home(['.gemini/config']))).toBe('(none)')
  })
  test("a settings.json holding only what an earlier install wrote is not Gemini CLI (the dogfood machine's shape)", () => {
    const h = home()
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { treecontext: { command: 'x', args: ['serve'] } } }))
    expect(detected(h)).toBe('Antigravity CLI')
  })
  test("a setting of Gemini CLI's own, or its credentials, is Gemini CLI", () => {
    const a = home()
    writeFileSync(join(a, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }))
    expect(detected(a)).toBe('Gemini CLI Antigravity CLI')
    const b = home()
    writeFileSync(join(b, '.gemini', 'oauth_creds.json'), '{}')
    expect(detected(b)).toBe('Gemini CLI Antigravity CLI')
  })
})

describe.skipIf(process.platform === 'win32')('install and uninstall for agy beside Gemini CLI (D383)', () => {
  const both = (): string => {
    const h = home()
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Default' }))
    return h
  }
  const blocks = (h: string): number => ['GEMINI.md', 'AGENTS.md', join('config', 'GEMINI.md'), join('config', 'AGENTS.md')]
    .map(f => join(h, '.gemini', f))
    .reduce((n, f) => n + (existsSync(f) ? readFileSync(f, 'utf8').split(MARKER_START).length - 1 : 0), 0)

  test('the shared block is written once, and the second agent says where', () => {
    const h = both()
    const run = spawnCli(['install', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(blocks(h)).toBe(1)
    expect(run.stdout).toContain(`instructions: ${join(h, '.gemini', 'GEMINI.md')} [shared with Gemini CLI — written once, above]`)
    // Twice over, still once.
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(blocks(h)).toBe(1)
  })

  test("uninstalling agy alone keeps the block Gemini CLI still reads; uninstalling both removes it", () => {
    const h = both()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const one = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: h })
    expect(one.status, one.out).toBe(0)
    expect(one.stdout).toContain(`Antigravity CLI: instructions kept in ${join(h, '.gemini', 'GEMINI.md')} — Gemini CLI reads the same block and is still wired`)
    expect(blocks(h)).toBe(1)
    expect(JSON.stringify(settings(h))).not.toMatch(/treecontext/)
    const all = spawnCli(['uninstall', '--yes'], { home: h })
    expect(all.status, all.out).toBe(0)
    expect(blocks(h)).toBe(0)
  })

  test("a reinstall keeps the developer's disabled flag, and doctor says so", () => {
    const h = home()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const cfg = JSON.parse(readFileSync(mcpPath(h), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
    cfg.mcpServers['treecontext']!['disabled'] = true
    writeFileSync(mcpPath(h), JSON.stringify(cfg, null, 2))
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const after = JSON.parse(readFileSync(mcpPath(h), 'utf8')) as typeof cfg
    expect(after.mcpServers['treecontext']!['disabled']).toBe(true)
    const row = agyRow(spawnCli(['doctor'], { home: h }).stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain('the treecontext server is turned off ("disabled": true)')
  })

  test('the files install rewrites keep their owner-only permissions', () => {
    const h = home()
    writeFileSync(settingsPath(h), JSON.stringify({ trustedWorkspaces: [] }), { mode: 0o600 })
    writeFileSync(mcpPath(h), JSON.stringify({ mcpServers: {} }), { mode: 0o600 })
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(statSync(settingsPath(h)).mode & 0o777).toBe(0o600)
    expect(statSync(mcpPath(h)).mode & 0o777).toBe(0o600)
    expect((settings(h)['permissions'] as { allow: string[] }).allow).toEqual(FOUR)
  })

  test('a dry run names every agy file a real install writes, and writes none', () => {
    const h = home()
    const before = readdirSync(join(h, '.gemini'), { recursive: true, encoding: 'utf8' }).sort()
    const dry = spawnCli(['install', '--yes', '--dry-run'], { home: h })
    expect(dry.status, dry.out).toBe(0)
    expect(readdirSync(join(h, '.gemini'), { recursive: true, encoding: 'utf8' }).sort()).toEqual(before)
    for (const p of [mcpPath(h), settingsPath(h), join(h, '.gemini', 'GEMINI.md')]) expect(dry.stdout).toContain(p)
    expect(dry.stdout).toContain('would approve mcp(treecontext/treecontext_status)')
  })

  test("doctor reads a project's own rules for its directory and names their file", () => {
    const h = home()
    const proj = join(h, 'work', 'repo')
    mkdirSync(proj, { recursive: true })
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const projects = join(h, '.gemini', 'config', 'projects')
    mkdirSync(projects, { recursive: true })
    const file = join(projects, 'p1.json')
    writeFileSync(file, JSON.stringify({ id: 'p1', name: 'repo', projectResources: { folders: [{ uri: `file://${join(h, 'work')}` }] }, permissions: { deny: ['mcp(treecontext/treecontext_query)'] } }))
    const inside = agyRow(spawnCli(['doctor'], { home: h, cwd: proj }).stdout)
    expect(inside).toMatch(/^\[warn\]/)
    expect(inside).toContain(`an \`agy -p\` worker would be refused treecontext_query — query refused by your deny rule mcp(treecontext/treecontext_query) in ${file}`)
    // Outside the project its rules do not apply.
    expect(agyRow(spawnCli(['doctor'], { home: h, cwd: h }).stdout)).toMatch(/^\[ok\]/)
  })
})
