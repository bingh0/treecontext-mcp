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
// merge beside the developer's rules, the row's other states, detection in
// the `~/.gemini` that retired Gemini CLI (D399) also used, agy's
// instruction block, the project file doctor reads, and the permissions of
// the files install rewrites. The CLI runs under a redirected HOME; the
// machine's own `agy` is hidden from it (sandboxedSpawnEnv), so detection
// here is by the directories each test lays out.

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
  test("a regex rule may decide a treecontext tool only when it is an mcp rule or names mcp or treecontext", () => {
    for (const r of ['mcp(regex:treecontext/.*)', 'MCP( regex:.* )', 'regex:mcp\\(treecontext/.*\\)', 'regex:.*treecontext.*']) {
      expect(agyRuleMayCover(r, 'treecontext_insert'), r).toBe(true)
    }
    for (const r of ['command(regex:git (status|log).*)', 'read_file(regex:/var/log/.*)', 'command(regex:npm run (build|lint|test))']) {
      expect(agyRuleMayCover(r, 'treecontext_insert'), r).toBe(false)
    }
  })
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
    // A regex in another action's rule decides no MCP tool (unit 3 re-check, 2026-11-08).
    expect(may('command(regex:.*)')).toBe(false)
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

  test("install writes no grant beside a rule that may decide, `mcp(treecontext)` with no slash included (D390)", () => {
    for (const list of ['allow', 'ask', 'deny']) {
      for (const r of ['mcp(treecontext)', 'mcp(tree*/*)', 'MCP(treecontext/*)', 'mcp(regex:.*)', 'mcp(treecontext/treecontext_*)']) {
        const m = withAllowRules({ permissions: { [list]: [r] } }, undefined, AGY_DIALECT)
        expect(m.added, `${list} ${r}`).toEqual([])
        expect(m.data, `${list} ${r}`).toBeNull()
        expect(m.leftAlone.map(l => l.tool), `${list} ${r}`).toEqual([...APPROVED_TOOLS])
        expect(m.leftAlone.every(l => l.rules.length === 1 && l.rules[0] === r)).toBe(true)
      }
    }
  })
  test('a rule that may decide one tool leaves that tool alone and the other three are granted', () => {
    const m = withAllowRules({ permissions: { ask: ['mcp(treecontext/treecontext_q*)'] } }, undefined, AGY_DIALECT)
    expect(m.added).toEqual([F_STATUS, FOUR[2], F_INSERT])
    expect(m.leftAlone).toEqual([{ tool: 'treecontext_query', rules: ['mcp(treecontext/treecontext_q*)'] }])
  })
  test("a grant an earlier install put beside a rule that may decide is taken back, and the containers it created go when empty", () => {
    const m = withAllowRules({ permissions: { allow: FOUR, deny: ['mcp(treecontext/treecontext_*)'] } }, { items: FOUR, created: ['permissions', 'allow'], at: '' }, AGY_DIALECT)
    expect(m.removed).toEqual(FOUR)
    expect(m.added).toEqual([])
    expect(m.ours).toEqual([])
    expect(m.data).toEqual({ permissions: { deny: ['mcp(treecontext/treecontext_*)'] } })
    const kept = withAllowRules({ trust: 1, permissions: { allow: ['mcp(github/*)', ...FOUR], ask: ['mcp(treecontext)'] } }, { items: FOUR, at: '' }, AGY_DIALECT)
    expect(kept.data).toEqual({ trust: 1, permissions: { allow: ['mcp(github/*)'], ask: ['mcp(treecontext)'] } })
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

describe('Gemini CLI is never detected, whatever of its own is there (D399)', () => {
  const detected = (h: string, env?: Record<string, string>): string =>
    /^Detected agents: (.*)$/m.exec(spawnCli(['install', '--yes', '--dry-run'], { home: h, ...(env ? { env } : {}) }).stdout)?.[1] ?? ''
  test('~/.gemini alone, or with only what agy makes in it, is not a client; agy\'s own directories are agy', () => {
    expect(detected(home(['.gemini']))).toBe('(none)')
    expect(detected(home())).toBe('Antigravity CLI')
    expect(detected(home(['.gemini/config']))).toBe('(none)')
  })
  test("Gemini CLI's own files, its settings, its hooks and its command detect nothing, with agy there or not", () => {
    for (const layout of [['.gemini'], ['.gemini/antigravity-cli', '.gemini/config']]) {
      const expected = layout.length > 1 ? 'Antigravity CLI' : '(none)'
      for (const f of ['installation_id', 'oauth_creds.json', 'google_accounts.json', 'trusted_hooks.json']) {
        const h = home(layout)
        writeFileSync(join(h, '.gemini', f), '{}')
        expect(detected(h), f).toBe(expected)
      }
      expect(detected(home([...layout, '.gemini/tmp'])), 'tmp/').toBe(expected)
      for (const data of [
        { security: { auth: { selectedType: 'oauth-personal' } } }, { mcpServers: { github: { command: 'gh' } } },
        { hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: '/usr/local/bin/audit' }] }] } },
        { mcpServers: { treecontext: { command: 'x', args: ['serve'] } } },
      ]) {
        const h = home(layout)
        writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify(data))
        expect(detected(h), JSON.stringify(data)).toBe(expected)
      }
      const h = home(layout)
      const bin = join(h, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      expect(detected(h, { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` }), 'gemini on PATH').toBe(expected)
    }
  })
  test('install refuses to wire Gemini CLI by name, with the experimental flag or without, and writes nothing', () => {
    for (const flags of [[], ['--experimental-capture']]) {
      const h = home(['.gemini'])
      writeFileSync(join(h, '.gemini', 'installation_id'), 'x')
      const run = spawnCli(['install', '--yes', '--agent', 'gemini', ...flags], { home: h })
      expect(run.status, run.out).toBe(1)
      expect(run.stderr).toContain('Gemini CLI is retired (Google deprecated it for Antigravity CLI)')
      expect(run.stderr).toContain('`treecontext uninstall --agent gemini`')
      expect(run.out).not.toMatch(/Fatal|No matching agents/)
      expect(readdirSync(join(h, '.gemini'))).toEqual(['installation_id'])
      expect(existsSync(join(h, '.treecontext', 'config.toml')), 'install wrote its config before refusing').toBe(false)
    }
  })
})

describe.skipIf(process.platform === 'win32')('a Gemini CLI entry an earlier install left (D399)', () => {
  /** agy installed, and the treecontext entry an earlier install wrote into Gemini CLI's settings, beside a key of the developer's. */
  const leftover = (opts: { geminiPresent?: boolean } = {}): string => {
    const h = home()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    if (opts.geminiPresent) writeFileSync(join(h, '.gemini', 'installation_id'), 'x')
    const entry = JSON.parse(readFileSync(mcpPath(h), 'utf8')) as { mcpServers: Record<string, unknown> }
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Default', mcpServers: { treecontext: entry.mcpServers['treecontext'] } }))
    return h
  }
  const geminiRow = (out: string): string[] => {
    const lines = out.split('\n')
    const i = lines.findIndex(l => /^\[\w+\]\s+Gemini CLI:/.test(l))
    return i < 0 ? [] : [lines[i]!, lines[i + 1] ?? '']
  }

  test('doctor warns that Gemini CLI is retired, names what is left and the uninstall, whether Gemini CLI is installed or not', () => {
    for (const geminiPresent of [false, true]) {
      const h = leftover({ geminiPresent })
      const out = spawnCli(['doctor'], { home: h }).stdout
      const [row, fix] = geminiRow(out)
      expect(row).toBe(`[warn] Gemini CLI: Gemini CLI is retired; an earlier install left its treecontext entry in ${join(h, '.gemini', 'settings.json')}, which nothing of treecontext's uses any more (install leaves it alone; ~/.gemini/GEMINI.md is Antigravity CLI's and stays)`)
      expect(fix).toBe('       fix: treecontext uninstall --agent gemini')
      // One row naming Gemini CLI, and no client row for it.
      expect(out.split('\n').filter(l => /Gemini CLI/.test(l))).toEqual([row])
    }
  })

  test("install leaves it alone; uninstall --agent gemini removes it and nothing else, and doctor no longer names it", () => {
    const h = leftover()
    const before = readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')).toBe(before)
    const agyFiles = [mcpPath(h), settingsPath(h), join(h, '.gemini', 'GEMINI.md')].map(f => readFileSync(f, 'utf8'))
    const un = spawnCli(['uninstall', '--yes', '--agent', 'gemini'], { home: h })
    expect(un.status, un.out).toBe(0)
    expect(un.stdout).toContain('gemini: Gemini CLI is retired (D399) — its old configuration is swept below')
    expect(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Default' })
    expect(geminiRow(spawnCli(['doctor'], { home: h }).stdout)).toEqual([])
    // agy's wiring and its block are as install left them.
    expect([mcpPath(h), settingsPath(h), join(h, '.gemini', 'GEMINI.md')].map(f => readFileSync(f, 'utf8'))).toEqual(agyFiles)
  })

  test('the block is agy\'s alone: uninstalling agy takes it, Gemini CLI\'s files there or not', () => {
    for (const geminiPresent of [false, true]) {
      const h = leftover({ geminiPresent })
      const un = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: h })
      expect(un.status, un.out).toBe(0)
      expect(un.stdout).not.toMatch(/instructions kept/)
      expect(un.stdout).toContain(`Antigravity CLI: instructions removed from ${join(h, '.gemini', 'GEMINI.md')}`)
      expect(existsSync(join(h, '.gemini', 'GEMINI.md')) ? readFileSync(join(h, '.gemini', 'GEMINI.md'), 'utf8') : '').not.toContain(MARKER_START)
    }
  })
})

describe.skipIf(process.platform === 'win32')("agy's instruction block beside Gemini CLI's files (D399)", () => {
  const beside = (): string => {
    const h = home()
    writeFileSync(join(h, '.gemini', 'installation_id'), 'x')
    writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Default' }))
    return h
  }
  const blocks = (h: string): number => ['GEMINI.md', 'AGENTS.md', join('config', 'GEMINI.md'), join('config', 'AGENTS.md')]
    .map(f => join(h, '.gemini', f))
    .reduce((n, f) => n + (existsSync(f) ? readFileSync(f, 'utf8').split(MARKER_START).length - 1 : 0), 0)

  test('the block is written once, for agy, and Gemini CLI\'s settings are left as they were', () => {
    const h = beside()
    const run = spawnCli(['install', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(blocks(h)).toBe(1)
    expect(run.stdout).toContain(`instructions: ${join(h, '.gemini', 'GEMINI.md')} [created]`)
    expect(run.stdout).not.toMatch(/shared with|Gemini CLI/)
    expect(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Default' })
    // Twice over, still once.
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    expect(blocks(h)).toBe(1)
  })

  test('uninstalling agy takes the block and the file install created for it', () => {
    const h = beside()
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const one = spawnCli(['uninstall', '--yes', '--agent', 'agy'], { home: h })
    expect(one.status, one.out).toBe(0)
    expect(blocks(h)).toBe(0)
    // The settings file install created for agy, left empty, went with it.
    expect(existsSync(settingsPath(h))).toBe(false)
    expect(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'))).toEqual({ theme: 'Default' })
  })

  test("a full uninstall takes a block an earlier install wrote for Gemini CLI where agy is not wired", () => {
    const h = home(['.gemini'])
    writeFileSync(join(h, '.gemini', 'GEMINI.md'), `# notes\n\n${MARKER_START}\nold block\n<!-- treecontext:end -->\n`)
    const run = spawnCli(['uninstall', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(readFileSync(join(h, '.gemini', 'GEMINI.md'), 'utf8')).toBe('# notes\n')
    // A run that names another agent leaves the file to agy's own uninstall.
    writeFileSync(join(h, '.gemini', 'GEMINI.md'), `# notes\n\n${MARKER_START}\nold block\n<!-- treecontext:end -->\n`)
    expect(spawnCli(['uninstall', '--yes', '--agent', 'codex'], { home: h }).status).toBe(0)
    expect(readFileSync(join(h, '.gemini', 'GEMINI.md'), 'utf8')).toContain(MARKER_START)
  })
})

describe.skipIf(process.platform === 'win32')('install and uninstall for agy (D383)', () => {
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

  test("a rule that may decide: install writes no grant beside it (D390), every echo names it, and doctor warns, says install left the tools alone, and is never ok", () => {
    const h = home()
    writeFileSync(settingsPath(h), JSON.stringify({ permissions: { ask: ['mcp(treecontext)'] } }))
    const run = spawnCli(['install', '--yes'], { home: h })
    expect(run.status, run.out).toBe(0)
    expect(settings(h)['permissions']).toEqual({ ask: ['mcp(treecontext)'] })
    const words = `your ask rule mcp(treecontext) in ${settingsPath(h)} may decide status, query, export, insert, clear, delete, import and merge (agy's handling of that shape is unverified)`
    expect(run.stdout).toContain(words)
    expect(run.stdout).toContain(`status, query, export and insert left alone beside your rule mcp(treecontext), which may decide them (agy's handling of that shape is unverified)`)
    const out = spawnCli(['doctor'], { home: h }).stdout
    const row = agyRow(out)
    expect(row).toMatch(/^\[warn\]/)
    expect(row).toContain(words)
    expect(row).toContain('install left status, query, export and insert alone, adding no rule beside a rule of yours that may decide them')
    const fix = out.split('\n')[out.split('\n').indexOf(row) + 1] ?? ''
    expect(fix).toContain(`fix: your ask rule mcp(treecontext) in ${settingsPath(h)}, yours to check`)
    const off = spawnCli(['config', 'tool-approvals', 'off', '--agent', 'agy'], { home: h })
    expect(off.stdout).toContain(words)
    expect(off.stdout).toContain(`your ask rule mcp(treecontext) in ${settingsPath(h)}, named above, may decide otherwise (agy's handling of that shape is unverified)`)
    expect(agyRow(spawnCli(['doctor'], { home: h }).stdout)).toMatch(/^\[warn\]/)
    const on = spawnCli(['config', 'tool-approvals', 'on', '--agent', 'agy'], { home: h })
    expect(on.stdout).toContain(words)
  })

  test("the row's approvals remedy and its fix line name the same command, whichever install the row needs", () => {
    const remedyAndFix = (h: string): { remedy: string; fix: string } => {
      const out = spawnCli(['doctor'], { home: h }).stdout
      const row = agyRow(out)
      const remedy = /headless workers: [^;]*holds no treecontext server; remedy: ([^.]*)\. Hooks:/.exec(row)?.[1] ?? `no remedy in: ${row}`
      const fix = (out.split('\n')[out.split('\n').indexOf(row) + 1] ?? '').replace(/^ +fix: /, '')
      return { remedy, fix }
    }
    // Nothing wired anywhere: the plain install, the headline's command.
    const bare = home()
    expect(spawnCli(['install', '--yes'], { home: bare }).status).toBe(0)
    writeFileSync(mcpPath(bare), '{"mcpServers": {}}\n')
    rmSync(join(bare, '.gemini', 'GEMINI.md'))
    expect(remedyAndFix(bare)).toEqual({ remedy: 'treecontext install', fix: 'treecontext install' })
    // Another client wired: the forced install for agy, on both lines.
    const beside = home(['.gemini/antigravity-cli', '.gemini/config', '.cursor'])
    expect(spawnCli(['install', '--yes'], { home: beside }).status).toBe(0)
    writeFileSync(mcpPath(beside), '{"mcpServers": {}}\n')
    rmSync(join(beside, '.gemini', 'GEMINI.md'))
    expect(remedyAndFix(beside)).toEqual({ remedy: 'treecontext install --force --agent agy', fix: 'treecontext install --force --agent agy' })
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

describe("the machine's own agy, hidden from a sandboxed child's PATH", () => {
  test('on Linux and macOS a directory holding one is mirrored without it; on Windows the PATH is left whole', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-path-')))
    dirs.push(dir)
    for (const n of ['agy', 'node-ish']) writeFileSync(join(dir, n), '', { mode: 0o755 })
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
