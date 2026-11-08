import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pathHidingMachineClients, spawnCli } from '../helpers/cli-spawn.js'
import {
  AGY_DIALECT, ALL_TOOLS, APPROVED_TOOLS, agyHeadlessClause, agyRuleCovers, agyRuleMayCover, agyView, withAllowRules, withoutAllowRules,
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

const FOUR: string[] = APPROVED_TOOLS.map(t => `mcp(treecontext/${t})`)
const [F_STATUS, F_QUERY, , F_INSERT] = FOUR as [string, string, string, string]
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
  test('only the shapes agy documents decide a tool for certain, matched exactly', () => {
    for (const r of ['mcp(treecontext/treecontext_insert)', 'mcp(treecontext/*)', 'mcp(*)']) {
      expect(agyRuleCovers(r, 'treecontext_insert'), r).toBe(true)
    }
    for (const r of [
      'mcp(treecontext/treecontext_delete)', 'mcp(github/*)', 'command(treecontext)', 'mcp(treecontextx/*)', 'mcp__treecontext__treecontext_insert',
      // Undocumented shapes: never certain.
      'mcp(tree*/treecontext_ins*)', ' mcp( treecontext/* ) ', 'MCP(treecontext/*)', 'mcp(TreeContext/treecontext_insert)',
      'mcp(treecontext)', 'mcp(treecontext/treecontext_q*)', 'mcp(regex:.*)',
    ]) {
      expect(agyRuleCovers(r, 'treecontext_insert'), r).toBe(false)
    }
  })

  test('every other shape that could touch a treecontext tool may decide it', () => {
    const may = (r: string, t = 'treecontext_insert'): boolean => agyRuleMayCover(r, t)
    // A regex anywhere, for every tool.
    for (const t of ALL_TOOLS) expect(may('mcp(regex:^tree)', t)).toBe(true)
    expect(may('command(regex:.*)')).toBe(true)
    // Case and whitespace variants of mcp, the server and the tool.
    for (const r of ['MCP(treecontext/treecontext_insert)', 'mcp(TreeContext/*)', 'mcp(treecontext/Treecontext_Insert)', ' mcp( treecontext/* ) ', 'Mcp(*)']) {
      expect(may(r), r).toBe(true)
    }
    // A glob inside a part, and the server with no slash.
    expect(may('mcp(tree*/treecontext_ins*)')).toBe(true)
    expect(may('mcp(*/treecontext_insert)')).toBe(true)
    expect(may('mcp(treecontext/treecontext_q*)', 'treecontext_query')).toBe(true)
    expect(may('mcp(treecontext/treecontext_q*)', 'treecontext_insert')).toBe(false)
    expect(may('mcp(treecontext)')).toBe(true)
    // Neither: a certain rule, another server, another action.
    for (const r of ['mcp(treecontext/*)', 'mcp(*)', 'mcp(treecontext/treecontext_insert)', 'mcp(github/*)', 'mcp(treecontextx/*)', 'command(treecontext)']) {
      expect(may(r), r).toBe(false)
    }
  })

  test("install adds the four where nothing of the developer's decides, never beside an ask, a deny or a documented wildcard, and keeps every other key", () => {
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
    const taken = withoutAllowRules({ permissions: { allow: [F_STATUS, 'mcp(github/*)'], ask: [F_QUERY] } }, { items: FOUR.slice(0, 2), at: '' })
    expect(taken.data).toEqual({ permissions: { allow: ['mcp(github/*)'], ask: [F_QUERY] } })
  })

  test("install writes its allow beside a rule that only may decide, `mcp(treecontext)` with no slash included", () => {
    for (const list of ['allow', 'ask', 'deny']) {
      for (const r of ['mcp(treecontext)', 'mcp(tree*/*)', 'MCP(treecontext/*)', 'mcp(regex:.*)']) {
        const m = withAllowRules({ permissions: { [list]: [r] } }, undefined, AGY_DIALECT)
        expect(m.added, `${list} ${r}`).toEqual(FOUR)
      }
    }
  })
})

describe("agy's precedence: the project file over the global one, deny over ask over allow within one", () => {
  const G = '/g/settings.json'
  const P = '/p/project.json'
  const insert = 'treecontext_insert'
  test("a project's allow decides over a global deny, and a project's deny over install's global allow", () => {
    const v1 = agyView([{ file: P, data: { permissions: { allow: [F_INSERT] } } }, { file: G, data: { permissions: { deny: [F_INSERT] } } }])
    expect(v1[insert]).toMatchObject({ by: 'developer', approves: true, file: P })
    const v2 = agyView([{ file: P, data: { permissions: { deny: ['mcp(treecontext/*)'] } } }, { file: G, data: { permissions: { allow: FOUR } }, recorded: { items: FOUR, at: '' } }])
    expect(v2[insert]).toMatchObject({ by: 'developer', approves: false, file: P, kind: 'deny rule' })
  })
  test('a project file that decides nothing leaves the global file to decide', () => {
    const v = agyView([{ file: P, data: { permissions: { allow: ['mcp(github/*)'] } } }, { file: G, data: { permissions: { allow: FOUR } }, recorded: { items: FOUR, at: '' } }])
    expect(v[insert]).toEqual({ by: 'install', file: G })
  })
  test('within one file deny beats ask beats allow', () => {
    const one = (perms: Record<string, string[]>): unknown => agyView([{ file: G, data: { permissions: perms } }])[insert]
    expect(one({ allow: [F_INSERT], ask: [F_INSERT], deny: [F_INSERT] })).toMatchObject({ kind: 'deny rule' })
    expect(one({ allow: [F_INSERT], ask: [F_INSERT] })).toMatchObject({ kind: 'ask rule' })
    expect(one({ allow: [F_INSERT] })).toMatchObject({ kind: 'allow rule', approves: true })
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
    expect(c.text).toMatch(/\/p\.json holds permission rules for a project doctor cannot place, which agy may apply here \(agy's project-file format is undocumented\)$/)
  })
  test('the ready row names the four once, and where install allowed them', () => {
    const c = agyHeadlessClause({ ...base, entry: { state: 'present', disabled: false } })
    expect(c.warn).toBe(false)
    expect(c.text).toBe('headless workers: an `agy -p` worker can use status, query, export and insert, allowed in /s.json')
  })
  test("a rule that may decide is never read ok: the row warns, names the rule and its file, and says agy's handling is unverified", () => {
    for (const list of ['allow', 'ask', 'deny'] as const) {
      const v = agyView([{ file: '/s.json', data: { permissions: { allow: FOUR, [list]: [...(list === 'allow' ? FOUR : []), 'mcp(TreeContext/*)'] } }, recorded: { items: FOUR, at: '' } }])
      const c = agyHeadlessClause({ ...base, view: v, entry: { state: 'present', disabled: false } })
      expect(c.warn, list).toBe(true)
      expect(c.text).toContain(`your ${list} rule mcp(TreeContext/*) in /s.json may decide status, query, export, insert, clear, delete, import and merge (agy's handling of that shape is unverified)`)
      expect(c.fix).toBe(`your ${list} rule mcp(TreeContext/*) in /s.json, yours to check: agy documents mcp(treecontext/<tool>), mcp(treecontext/*) and mcp(*)`)
    }
  })
  test("settings agy's own file holds that do not parse: fixed by hand, never by an install that skips the file", () => {
    const c = agyHeadlessClause({ ...base, view: agyView([]), entry: { state: 'present', disabled: false }, unreadable: ['/s.json'], settingsError: 'Unexpected token } in JSON at position 9' })
    expect(c.warn).toBe(true)
    expect(c.text).toMatch(/^headless workers: \/s\.json does not parse \(Unexpected token \} in JSON at position 9\), and install adds no rule to it, so an `agy -p` worker would be refused /)
    expect(c.fix).toBe('fix the JSON in /s.json by hand (Unexpected token } in JSON at position 9); install skips a file it cannot read')
    expect(c.fix).not.toMatch(/install --agent agy/)
  })
})

describe('the directory Gemini CLI and agy share (D383)', () => {
  const detected = (h: string, env?: Record<string, string>): string =>
    /^Detected agents: (.*)$/m.exec(spawnCli(['install', '--yes', '--dry-run'], { home: h, ...(env ? { env } : {}) }).stdout)?.[1] ?? ''
  test('~/.gemini alone, or with only what agy makes in it, is not Gemini CLI', () => {
    expect(detected(home(['.gemini']))).toBe('(none)')
    expect(detected(home())).toBe('Antigravity CLI')
    expect(detected(home(['.gemini/config']))).toBe('(none)')
  })
  test("a settings.json holding only what an earlier install wrote is not Gemini CLI (the dogfood machine's shape)", () => {
    for (const data of [{ mcpServers: { treecontext: { command: 'x', args: ['serve'] } } }, { mcpServers: {} }, {}]) {
      const h = home()
      writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify(data))
      expect(detected(h), JSON.stringify(data)).toBe('Antigravity CLI')
    }
  })
  test("each of Gemini CLI's own artifacts is Gemini CLI, with agy there or not", () => {
    for (const layout of [['.gemini'], ['.gemini/antigravity-cli', '.gemini/config']]) {
      const both = layout.length > 1 ? 'Gemini CLI Antigravity CLI' : 'Gemini CLI'
      for (const f of ['installation_id', 'oauth_creds.json', 'google_accounts.json', 'trusted_hooks.json']) {
        const h = home(layout)
        writeFileSync(join(h, '.gemini', f), '{}')
        expect(detected(h), f).toBe(both)
      }
      const t = home([...layout, '.gemini/tmp'])
      expect(detected(t), 'tmp/').toBe(both)
      for (const data of [{ security: { auth: { selectedType: 'oauth-personal' } } }, { mcpServers: { github: { command: 'gh' } } }, { hooks: {} }]) {
        const h = home(layout)
        writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify(data))
        expect(detected(h), JSON.stringify(data)).toBe(both)
      }
    }
  })
  test('the gemini command on PATH is Gemini CLI', () => {
    const h = home()
    const bin = join(h, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(detected(h, { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` })).toBe('Gemini CLI Antigravity CLI')
  })
})

describe.skipIf(process.platform === 'win32')('an orphan Gemini CLI entry (D383)', () => {
  /** agy installed, and an earlier install's Gemini CLI entry and shared block left with no Gemini CLI. */
  const orphaned = (): string => {
    const h = home()
    writeFileSync(join(h, '.gemini', 'installation_id'), 'x')
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    rmSync(join(h, '.gemini', 'installation_id'))
    expect(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'))).toHaveProperty(['mcpServers', 'treecontext'])
    return h
  }
  const geminiRow = (out: string): string[] => {
    const lines = out.split('\n')
    const i = lines.findIndex(l => /^\[\w+\]\s+Gemini CLI:/.test(l))
    return i < 0 ? [] : [lines[i]!, lines[i + 1] ?? '']
  }

  test('doctor warns that an earlier install wired Gemini CLI, which is not present, and names the uninstall', () => {
    const h = orphaned()
    const [row, fix] = geminiRow(spawnCli(['doctor'], { home: h }).stdout)
    expect(row).toMatch(/^\[warn\] Gemini CLI: an earlier install wired Gemini CLI, which is not present — /)
    expect(row).toContain(join(h, '.gemini', 'settings.json'))
    expect(fix).toBe('       fix: treecontext uninstall --agent gemini')
  })

  test('install leaves it alone; uninstall --agent gemini removes it, and doctor no longer names it', () => {
    const h = orphaned()
    const before = readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')).toBe(before)
    const un = spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(JSON.stringify(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')))).not.toMatch(/treecontext/)
    expect(geminiRow(spawnCli(['doctor'], { home: h }).stdout)).toEqual([])
    // agy is still wired, so the shared block stays.
    expect(readFileSync(join(h, '.gemini', 'GEMINI.md'), 'utf8')).toContain(MARKER_START)
  })

  test("an orphan is not \"still wired\": uninstalling agy takes the shared block", () => {
    const h = orphaned()
    const un = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(un.stdout).not.toMatch(/instructions kept/)
    expect(existsSync(join(h, '.gemini', 'GEMINI.md')) ? readFileSync(join(h, '.gemini', 'GEMINI.md'), 'utf8') : '').not.toContain(MARKER_START)
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
    // The settings file install created for agy, left empty, went with it.
    expect(existsSync(settingsPath(h))).toBe(false)
    const all = spawnCli(['uninstall', '--yes'], { home: h })
    expect(all.status, all.out).toBe(0)
    expect(blocks(h)).toBe(0)
  })

  test('uninstalling Gemini CLI alone keeps the block agy still reads', () => {
    const h = both()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const one = spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h })
    expect(one.status, one.out).toBe(0)
    expect(one.stdout).toContain(`Gemini CLI: instructions kept in ${join(h, '.gemini', 'GEMINI.md')} — Antigravity CLI reads the same block and is still wired`)
    expect(blocks(h)).toBe(1)
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

  test("the files install creates for agy are owner-only, as agy makes them, whatever the umask", () => {
    // A permissive umask for the duration, or a fresh file's 0644 would pass as 0600 on a machine whose umask is 077.
    const prev = process.umask(0o022)
    try {
      const h = home()
      expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
      expect(statSync(settingsPath(h)).mode & 0o777).toBe(0o600)
      expect(statSync(mcpPath(h)).mode & 0o777).toBe(0o600)
      // A rewrite keeps the mode it found, exactly.
      chmodSync(settingsPath(h), 0o640)
      expect(spawnCli(['config', 'tool-approvals', 'off'], { home: h }).status).toBe(0)
      expect(statSync(settingsPath(h)).mode & 0o777).toBe(0o640)
    } finally {
      process.umask(prev)
    }
  })

  test('uninstall deletes the files install created and left empty, and says so; a file the developer had stays, empty or not', () => {
    const h = home()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const un = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: h })
    expect(un.status, un.out).toBe(0)
    for (const f of [mcpPath(h), settingsPath(h)]) {
      expect(existsSync(f), f).toBe(false)
      expect(un.stdout).toContain(`Antigravity CLI: deleted ${f} — install created it, and it is left empty`)
    }
    const d = home()
    writeFileSync(settingsPath(d), '{}\n')
    writeFileSync(mcpPath(d), JSON.stringify({ mcpServers: {} }))
    expect(spawnCli(['install', '--yes'], { home: d }).status).toBe(0)
    const kept = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: d })
    expect(kept.status, kept.out).toBe(0)
    expect(kept.stdout).not.toMatch(/deleted/)
    expect(JSON.parse(readFileSync(settingsPath(d), 'utf8'))).toEqual({})
    expect(JSON.parse(readFileSync(mcpPath(d), 'utf8'))).toEqual({ mcpServers: {} })
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
    expect(inside).toContain(`the rules of ${file} apply here, read from agy's undocumented project-file format`)
    // Outside the project its rules do not apply.
    expect(agyRow(spawnCli(['doctor'], { home: h, cwd: h }).stdout)).toMatch(/^\[ok\]/)
  })

  const project = (h: string, name: string, folder: string, permissions: Record<string, string[]>): string => {
    const dir = join(h, '.gemini', 'config', 'projects')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, JSON.stringify({ id: name, projectResources: { folders: [{ uri: `file://${folder}` }] }, permissions }))
    return file
  }

  test('a project file names its directory through a symlink, and the cwd is matched by realpath', () => {
    const h = home()
    const real = join(h, 'work', 'repo')
    mkdirSync(real, { recursive: true })
    symlinkSync(join(h, 'work'), join(h, 'link'))
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const file = project(h, 'p1.json', join(h, 'link', 'repo'), { deny: ['mcp(treecontext/treecontext_query)'] })
    expect(agyRow(spawnCli(['doctor'], { home: h, cwd: real }).stdout)).toContain(`query refused by your deny rule mcp(treecontext/treecontext_query) in ${file}`)
  })

  test('the nearest project wins over one further up, and a bare "/" only where nothing longer matches, said to be weak', () => {
    const h = home()
    const repo = join(h, 'work', 'repo')
    mkdirSync(repo, { recursive: true })
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const root = project(h, 'a-root.json', '/', { deny: ['mcp(treecontext/treecontext_status)'] })
    const outer = project(h, 'b-outer.json', join(h, 'work'), { deny: ['mcp(treecontext/treecontext_export)'] })
    const inner = project(h, 'c-inner.json', repo, { deny: ['mcp(treecontext/treecontext_query)'] })
    const inRepo = agyRow(spawnCli(['doctor'], { home: h, cwd: repo }).stdout)
    expect(inRepo).toContain(`query refused by your deny rule mcp(treecontext/treecontext_query) in ${inner}`)
    expect(inRepo).not.toContain(outer)
    expect(inRepo).not.toContain(root)
    const inWork = agyRow(spawnCli(['doctor'], { home: h, cwd: join(h, 'work') }).stdout)
    expect(inWork).toContain(`in ${outer}`)
    expect(inWork).not.toContain(inner)
    const elsewhere = agyRow(spawnCli(['doctor'], { home: h, cwd: h }).stdout)
    expect(elsewhere).toContain(`status refused by your deny rule mcp(treecontext/treecontext_status) in ${root}`)
    expect(elsewhere).toContain(`the rules of ${root} apply here, read from agy's undocumented project-file format (a weak match: it names only "/")`)
    expect(inRepo).not.toMatch(/weak match/)
  })

  test("a project's allow decides over a global deny, as agy ranks a project's rules over the global ones", () => {
    const h = home()
    const repo = join(h, 'repo')
    mkdirSync(repo)
    writeFileSync(settingsPath(h), JSON.stringify({ permissions: { deny: ['mcp(treecontext/treecontext_insert)'] } }))
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(agyRow(spawnCli(['doctor'], { home: h, cwd: h }).stdout)).toMatch(/^\[warn\].*would be refused treecontext_insert/)
    const file = project(h, 'p.json', repo, { allow: ['mcp(treecontext/treecontext_insert)'] })
    const row = agyRow(spawnCli(['doctor'], { home: h, cwd: repo }).stdout)
    expect(row).toMatch(/^\[ok\]/)
    expect(row).toContain(`insert approved by your allow rule mcp(treecontext/treecontext_insert) in ${file}`)
  })

  test("a rule that may decide: install writes beside it, every echo names it, and doctor warns and is never ok", () => {
    const h = home()
    writeFileSync(settingsPath(h), JSON.stringify({ permissions: { ask: ['mcp(treecontext)'] } }))
    const run = spawnCli(['install', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect((settings(h)['permissions'] as { allow: string[] }).allow).toEqual(FOUR)
    const words = `your ask rule mcp(treecontext) in ${settingsPath(h)} may decide status, query, export, insert, clear, delete, import and merge (agy's handling of that shape is unverified)`
    expect(run.stdout).toContain(words)
    const row = agyRow(spawnCli(['doctor'], { home: h }).stdout)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(words)
    const off = spawnCli(['config', 'tool-approvals', 'off', '--agent', 'agy'], { home: h })
    expect(off.stdout).toContain(words)
    expect(off.stdout).toContain(`your ask rule mcp(treecontext) in ${settingsPath(h)}, named above, may decide otherwise (agy's handling of that shape is unverified)`)
    expect(agyRow(spawnCli(['doctor'], { home: h }).stdout)).toMatch(/^\[warn\]/)
    const on = spawnCli(['config', 'tool-approvals', 'on', '--agent', 'agy'], { home: h })
    expect(on.stdout).toContain(words)
  })

  test("agy's settings that do not parse: doctor names the file and the parse error, and never sends the developer to an install that skips it", () => {
    const h = home()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    writeFileSync(settingsPath(h), '{"permissions": {"allow": [}\n')
    const out = spawnCli(['doctor'], { home: h }).stdout
    const row = agyRow(out)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(`${settingsPath(h)} does not parse (`)
    const fix = out.split('\n')[out.split('\n').indexOf(row) + 1] ?? ''
    expect(fix).toMatch(new RegExp(`^ +fix: fix the JSON in ${settingsPath(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} by hand \\(.+\\); install skips a file it cannot read$`))
    expect(fix).not.toMatch(/install --agent agy|install --force/)
  })

  test("an MCP configuration install replaced because it did not parse: doctor says the developer's servers survive only in the backup", () => {
    const h = home()
    writeFileSync(mcpPath(h), '{"mcpServers": {"github": ')
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(readFileSync(`${mcpPath(h)}.bak`, 'utf8')).toBe('{"mcpServers": {"github": ')
    expect(agyRow(spawnCli(['doctor'], { home: h }).stdout)).toContain(`an earlier install replaced ${mcpPath(h)} because it did not parse, so any servers of yours that were in it survive only in ${mcpPath(h)}.bak`)
  })
})

describe("the machine's own agy and gemini, hidden from a sandboxed child's PATH", () => {
  test('on Linux and macOS a directory holding one is mirrored without it; on Windows the PATH is left whole', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-path-')))
    dirs.push(dir)
    for (const n of ['gemini', 'node-ish']) writeFileSync(join(dir, n), '', { mode: 0o755 })
    const was = process.env['PATH']
    process.env['PATH'] = `${dir}${delimiter}${was ?? ''}`
    try {
      const path = `${dir}${delimiter}/usr/bin`
      expect(pathHidingMachineClients(path, 'win32')).toBe(path)
      if (process.platform !== 'win32') {
        const hidden = pathHidingMachineClients(path, process.platform)!.split(delimiter)
        expect(hidden).toHaveLength(2)
        expect(hidden[0]).not.toBe(dir)
        expect(readdirSync(hidden[0]!)).toEqual(['node-ish'])
      }
    } finally {
      process.env['PATH'] = was
    }
  })
})
