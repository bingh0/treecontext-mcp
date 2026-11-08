import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { spawnCli } from '../helpers/cli-spawn.js'
import { sandboxedEnv } from '../helpers/home.js'
import { writeFakeCodex } from '../journal/standins.js'
import {
  APPROVED_TOOLS, claudeApprovalClause, claudeView, codexHeadlessClause, codexView, withClaudeApprovals, withCodexApprovals,
  withoutClaudeApprovals, withoutCodexApprovals,
} from '../../src/server/tool-approvals.js'
import { CODEX_APPROVALS_FLOOR, codexApprovalSupport, sandboxRow } from '../../src/server/codex-client.js'

// Tool approvals (D381, D390) and Codex's checks (D387) in the corners the
// charter scenarios do not reach: the merge rules on their own, a Codex
// below the floor through the real CLI, and the sandbox row's grading of
// each kind of answer.

const FOUR = APPROVED_TOOLS.map(t => `mcp__treecontext__${t}`)
const WORKER_VARS = ['TREECONTEXT_TICKET', 'TREECONTEXT_WORKER_SESSION']

describe("Claude Code's grant, merged beside the developer's rules", () => {
  test('adds the four, and nothing for a tool a rule of the developer\'s decides', () => {
    const data = { permissions: { allow: ['Bash(ls:*)'], ask: ['mcp__treecontext__treecontext_insert'], deny: ['mcp__treecontext__treecontext_delete'] } }
    const m = withClaudeApprovals(data, undefined)
    expect(m.added).toEqual(FOUR.filter(r => !r.endsWith('_insert')))
    expect(m.developer.map(d => `${d.tool}:${d.rule.list}`)).toEqual(['treecontext_insert:ask'])
    expect((m.data!['permissions'] as Record<string, unknown>)['ask']).toEqual(data.permissions.ask)
    expect((m.data!['permissions'] as Record<string, unknown>)['deny']).toEqual(data.permissions.deny)
    expect(m.created).toEqual([])
  })

  test('a server-wide rule of the developer\'s decides every tool, so install adds none', () => {
    for (const rule of ['mcp__treecontext', 'mcp__treecontext__*']) {
      for (const list of ['allow', 'ask', 'deny']) {
        const m = withClaudeApprovals({ permissions: { [list]: [rule] } }, undefined)
        expect(m.added, `${list} ${rule}`).toEqual([])
        expect(m.data).toBeNull()
      }
    }
  })

  test('takes back only what the record names, and the containers it created when empty', () => {
    const m = withClaudeApprovals({ model: 'opus' }, undefined)
    expect(m.created.sort()).toEqual(['allow', 'permissions'])
    const back = withoutClaudeApprovals(m.data!, { items: m.ours, created: m.created, at: '' })
    expect(back.data).toEqual({ model: 'opus' })
    // A rule the developer added since stays, with its containers.
    const mixed = { ...m.data!, permissions: { allow: [...FOUR, 'Bash(git:*)'] } }
    expect(withoutClaudeApprovals(mixed, { items: m.ours, created: m.created, at: '' }).data).toEqual({ model: 'opus', permissions: { allow: ['Bash(git:*)'] } })
  })

  test('a permissions value that is not what Claude Code reads is left alone and said', () => {
    expect(withClaudeApprovals({ permissions: ['x'] }, undefined).unwritable).toMatch(/not an object/)
    expect(withClaudeApprovals({ permissions: { allow: 'x' } }, undefined).unwritable).toMatch(/not a list/)
  })

  test("doctor's clause names the rule that governs a refused tool, and its file", () => {
    const user = { file: '/h/.claude/settings.json', data: { permissions: { allow: FOUR.slice(0, 3) } }, recorded: { items: FOUR.slice(0, 3), at: '' } }
    const project = { file: '/p/.claude/settings.local.json', data: { permissions: { deny: ['mcp__treecontext__treecontext_insert'] } } }
    const c = claudeApprovalClause(claudeView([user, project]), [], user.file, { state: 'on' })
    expect(c.warn).toBe(true)
    expect(c.text).toBe('tool approvals: a `claude -p` worker would be refused treecontext_insert — insert refused by your deny rule mcp__treecontext__treecontext_insert in /p/.claude/settings.local.json')
    expect(c.fix).toBe('your deny rule mcp__treecontext__treecontext_insert in /p/.claude/settings.local.json, yours to change (install leaves it)')
    const missing = claudeApprovalClause(claudeView([{ file: '/h/s.json', data: {} }]), [], '/h/s.json', { state: 'on' })
    expect(missing.warn).toBe(true)
    expect(missing.fix).toBe('treecontext install --agent claude')
  })

  test('off, the clause says what the files still approve: a rule install has no record of is the developer\'s', () => {
    const lost = { file: '/h/s.json', data: { permissions: { allow: FOUR } } }
    const c = claudeApprovalClause(claudeView([lost]), [], lost.file, { state: 'off', at: '', how: 'config' })
    expect(c.warn).toBe(false)
    expect(c.text).not.toMatch(/will be refused/)
    expect(c.text).toContain('status, query, export and insert approved by your allow rules mcp__treecontext__treecontext_status, mcp__treecontext__treecontext_query, mcp__treecontext__treecontext_export and mcp__treecontext__treecontext_insert in /h/s.json')
  })
})

describe("Codex's per-tool approvals", () => {
  test('one by one, never a default, never over the developer\'s', () => {
    const m = withCodexApprovals({ command: 'x', tools: { treecontext_query: { approval_mode: 'prompt' } } }, [])
    expect(m.added).toEqual(['treecontext_status', 'treecontext_export', 'treecontext_insert'])
    expect(m.developer).toEqual([{ tool: 'treecontext_query', value: 'prompt' }])
    expect(m.entry!['default_tools_approval_mode']).toBeUndefined()
    const tools = m.entry!['tools'] as Record<string, Record<string, unknown>>
    for (const t of ['treecontext_clear', 'treecontext_delete', 'treecontext_import', 'treecontext_merge_from_agent']) expect(tools[t]).toBeUndefined()
    expect(tools['treecontext_query']).toEqual({ approval_mode: 'prompt' })
  })

  test('a default of the developer\'s decides every tool: install writes none, and takes its own back', () => {
    const m = withCodexApprovals({ default_tools_approval_mode: 'prompt' }, [])
    expect(m.entry).toBeNull()
    expect(m.defaultMode).toBe('prompt')
    const later = withCodexApprovals({ default_tools_approval_mode: 'prompt', tools: { treecontext_status: { approval_mode: 'approve' }, treecontext_query: { approval_mode: 'prompt' } } }, ['treecontext_status'])
    expect(later.removed).toEqual(['treecontext_status'])
    expect(later.entry).toEqual({ default_tools_approval_mode: 'prompt', tools: { treecontext_query: { approval_mode: 'prompt' } } })
  })

  test('takes back only approvals that still read what install wrote', () => {
    const entry = { tools: { treecontext_status: { approval_mode: 'approve' }, treecontext_query: { approval_mode: 'prompt' }, treecontext_export: { approval_mode: 'approve', other: 1 } } }
    const back = withoutCodexApprovals(entry, ['treecontext_status', 'treecontext_query', 'treecontext_export'])
    expect(back.removed).toEqual(['treecontext_status', 'treecontext_export'])
    expect(back.entry).toEqual({ tools: { treecontext_query: { approval_mode: 'prompt' }, treecontext_export: { other: 1 } } })
  })

  test("doctor's clause below the floor, and with a default that asks", () => {
    const four = { env_vars: WORKER_VARS, tools: Object.fromEntries(APPROVED_TOOLS.map(t => [t, { approval_mode: 'approve' }])) }
    const clause = (entry: Record<string, unknown>, version: string, recorded: string[] = []) => codexHeadlessClause({
      configPath: '/h/c.toml', entry, view: codexView(entry, recorded, '/h/c.toml'), workerVars: WORKER_VARS,
      choice: { state: 'on' }, support: codexApprovalSupport(version), floor: CODEX_APPROVALS_FLOOR,
    })
    const below = clause(four, '0.165.0', [...APPROVED_TOOLS])
    expect(below.warn).toBe(true)
    expect(below.text).toBe(`headless workers: Codex 0.165.0 cannot read per-tool approvals: its headless workers need Codex ${CODEX_APPROVALS_FLOOR} or newer for the tools`)
    const asks = clause({ env_vars: WORKER_VARS, default_tools_approval_mode: 'prompt' }, '0.167.0')
    expect(asks.warn).toBe(true)
    expect(asks.text).toMatch(/refused every treecontext call — status, query, export, insert, clear, delete, import and merge refused by your mcp_servers\.treecontext\.default_tools_approval_mode = "prompt" in \/h\/c\.toml/)
    expect(asks.fix).toBe('your mcp_servers.treecontext.default_tools_approval_mode = "prompt" in /h/c.toml, yours to change (install leaves it)')
    // A default set after install's per-tool approvals: install's own override it, and install takes them back.
    const over = clause({ ...four, default_tools_approval_mode: 'prompt' }, '0.167.0', [...APPROVED_TOOLS])
    expect(over.warn).toBe(true)
    expect(over.text).toMatch(/install's own approvals of status, query, export and insert override your default_tools_approval_mode = "prompt"; install takes them back/)
    expect(over.fix).toBe('treecontext install --agent codex')
  })
})

describe('the sandbox row grades what the check said', () => {
  const run = (status: number | null, stderr: string, more: Partial<{ timedOut: boolean; missing: boolean }> = {}): Parameters<typeof sandboxRow>[0] =>
    ({ status, stdout: '', stderr, timedOut: false, missing: false, ...more })
  test('each refusal of a user namespace reads as one', () => {
    for (const said of ['bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', 'bwrap: setting up uid map: Permission denied', 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.']) {
      const r = sandboxRow(run(1, said))
      expect(r.status).toBe('warn')
      expect(r.detail).toMatch(/refuses bubblewrap a user namespace/)
      expect(r.detail).toContain(said)
    }
  })
  test('a cut check, and no codex at all, warn with what is known', () => {
    expect(sandboxRow(run(null, '', { timedOut: true }), 20_000).detail).toMatch(/did not finish within 20 s/)
    expect(sandboxRow(run(null, '', { missing: true })).detail).toMatch(/no codex command on PATH/)
  })
})

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'linux')("doctor's sandbox row against the real Codex (D387)", () => {
  test("the row reads what `codex sandbox -- true` itself says on this machine", () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-sandbox-real-')))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    // The real check, under this home, before doctor runs it.
    const real = spawnSync('codex', ['sandbox', '--', 'true'], {
      env: { ...sandboxedEnv(home), CODEX_HOME: join(home, '.codex') }, encoding: 'utf8', timeout: 60_000,
    })
    expect(real.error, 'Codex CLI is not on PATH: install it (npm i -g @openai/codex; no model call is made)').toBeUndefined()
    const doctor = spawnCli(['doctor'], { home })
    const row = doctor.stdout.split('\n').find(l => /Codex sandbox:/.test(l))
    expect(row, doctor.stdout).toBeDefined()
    if (real.status === 0) expect(row).toMatch(/^\[ok\]\s+Codex sandbox: `codex sandbox -- true` passed/)
    else expect(row).toMatch(/^\[warn\]\s+Codex sandbox: `codex sandbox -- true` failed/)
  })
})

describe.skipIf(process.platform === 'win32')('an off the developer chose holds across later installs (D390)', () => {
  const home = (): string => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-approvals-off-')))
    dirs.push(h)
    mkdirSync(join(h, '.claude'), { recursive: true })
    mkdirSync(join(h, '.codex'), { recursive: true })
    return h
  }
  const fakeCodex = (h: string): Record<string, string> => {
    const bin = join(h, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    writeFakeCodex(bin, { version: CODEX_APPROVALS_FLOOR, sandbox: { exit: 0, stderr: '' } })
    return { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` }
  }
  const claudeAllow = (h: string): unknown => ((JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')) as Record<string, Record<string, unknown>>)['permissions'] ?? {})['allow']
  const codexTools = (h: string): unknown => (parseToml(readFileSync(join(h, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { treecontext: Record<string, unknown> } }).mcp_servers.treecontext['tools']

  for (const route of ['config tool-approvals off', 'install --no-tool-approvals'] as const) {
    test(`chosen by ${route}: a plain install afterwards writes none, and says the off is the developer's`, () => {
      const h = home()
      const env = fakeCodex(h)
      if (route === 'config tool-approvals off') {
        expect(spawnCli(['install', '--yes'], { home: h, env }).status).toBe(0)
        expect(claudeAllow(h)).toEqual(FOUR)
        const off = spawnCli(['config', 'tool-approvals', 'off'], { home: h, env })
        expect(off.status, off.out).toBe(0)
      } else {
        const first = spawnCli(['install', '--yes', '--no-tool-approvals'], { home: h, env })
        expect(first.status, first.out).toBe(0)
      }
      expect(claudeAllow(h)).toBeUndefined()
      expect(codexTools(h)).toBeUndefined()
      const again = spawnCli(['install', '--yes'], { home: h, env })
      expect(again.status, again.out).toBe(0)
      expect(claudeAllow(h)).toBeUndefined()
      expect(codexTools(h)).toBeUndefined()
      expect(again.stdout).toMatch(/^ {2}tool approvals are off by your choice for Claude Code and Codex CLI; to turn them on: treecontext config tool-approvals on$/m)
      // And on again, by the command the line names.
      const on = spawnCli(['config', 'tool-approvals', 'on'], { home: h, env })
      expect(on.status, on.out).toBe(0)
      expect(claudeAllow(h)).toEqual(FOUR)
      expect(Object.keys(codexTools(h) as Record<string, unknown>).sort()).toEqual([...APPROVED_TOOLS].sort())
    })
  }

  test('install names what it approved and where, what still asks, and the way back, in one message', () => {
    const h = home()
    const env = fakeCodex(h)
    const run = spawnCli(['install', '--yes'], { home: h, env })
    expect(run.status, run.out).toBe(0)
    const msg = run.stdout.slice(run.stdout.indexOf('\nTool approvals:\n'))
    expect(msg).toContain(`  Claude Code: status, query, export and insert approved by install (permissions.allow in ${join(h, '.claude', 'settings.json')}); still asking: clear, delete, import and merge`)
    expect(msg).toContain(`  Codex CLI: status, query, export and insert approved by install (mcp_servers.treecontext.tools in ${join(h, '.codex', 'config.toml')}); still asking: clear, delete, import and merge`)
    expect(msg).toContain('  the way back: treecontext config tool-approvals off, or treecontext install --no-tool-approvals')
  })

  test("the message reads the files: the developer's rules that approve the asking tools are named, never said to ask", () => {
    const h = home()
    const env = fakeCodex(h)
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__treecontext'] } }))
    writeFileSync(join(h, '.codex', 'config.toml'), '[mcp_servers.treecontext]\ncommand = "x"\ndefault_tools_approval_mode = "approve"\n')
    const run = spawnCli(['install', '--yes'], { home: h, env })
    expect(run.status, run.out).toBe(0)
    const msg = run.stdout.slice(run.stdout.indexOf('\nTool approvals:\n'))
    expect(msg).toContain(`  Claude Code: none approved by install; status, query, export, insert, clear, delete, import and merge approved by your allow rule mcp__treecontext in ${join(h, '.claude', 'settings.json')}`)
    expect(msg).toContain(`  Codex CLI: none approved by install; status, query, export, insert, clear, delete, import and merge approved by your mcp_servers.treecontext.default_tools_approval_mode = "approve" in ${join(h, '.codex', 'config.toml')}`)
    expect(msg).not.toMatch(/still asking/)
  })
})

describe.skipIf(process.platform === 'win32')('every echo reads what the files leave in force (D390)', () => {
  const setup = (): { h: string; env: Record<string, string> } => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-approvals-echo-')))
    dirs.push(h)
    mkdirSync(join(h, '.claude'), { recursive: true })
    mkdirSync(join(h, '.codex'), { recursive: true })
    const bin = join(h, 'fake-bin')
    mkdirSync(bin)
    writeFakeCodex(bin, { version: CODEX_APPROVALS_FLOOR, sandbox: { exit: 0, stderr: '' } })
    return { h, env: { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` } }
  }
  const codexRow = (out: string): string => out.split('\n').find(l => /Codex CLI:/.test(l) && /headless workers:/.test(l)) ?? ''

  test("the real machine's shape: the developer's own approval for status stays after off, and every echo says so", () => {
    const { h, env } = setup()
    // The developer's entry, with their own approval for status, before any install.
    writeFileSync(join(h, '.codex', 'config.toml'), '[mcp_servers.treecontext]\ncommand = "x"\n\n[mcp_servers.treecontext.tools.treecontext_status]\napproval_mode = "approve"\n')
    expect(spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, env }).status).toBe(0)
    const off = spawnCli(['config', 'tool-approvals', 'off', '--agent', 'codex'], { home: h, env })
    expect(off.status, off.out).toBe(0)
    expect(off.stdout).toMatch(/took back install's approval of treecontext_query, treecontext_export and treecontext_insert/)
    expect(off.stdout).toMatch(/headless workers will now be refused query, export and insert in Codex CLI; status stays approved by your own rules/)
    expect(off.stdout).toMatch(/status approved by your mcp_servers\.treecontext\.tools\.treecontext_status\.approval_mode = "approve" in /)
    const again = spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, env })
    expect(again.stdout).toMatch(/ {2}Codex CLI: off by your choice — none approved by install; status approved by your mcp_servers\.treecontext\.tools\.treecontext_status/)
    // Doctor: the developer's approval read by Codex itself, the off a choice.
    const doctor = spawnCli(['doctor'], { home: h })
    const row = codexRow(doctor.stdout)
    expect(row).toMatch(/off by your choice \(.*\), so headless workers will be refused query, export and insert/)
    expect(row).toMatch(/status approved by your mcp_servers\.treecontext\.tools\.treecontext_status\.approval_mode = "approve" in /)
  })

  test('a lost record: off takes nothing back and says what still approves, by name and file', () => {
    const { h, env } = setup()
    expect(spawnCli(['install', '--yes'], { home: h, env }).status).toBe(0)
    rmSync(join(h, '.treecontext', 'install-state.json'))
    const off = spawnCli(['config', 'tool-approvals', 'off'], { home: h, env })
    expect(off.status, off.out).toBe(0)
    expect(off.stdout).toMatch(/Claude Code: nothing of install's to take back by its record; now none approved by install; status, query, export and insert approved by your allow rules mcp__treecontext__treecontext_status/)
    expect(off.stdout).toMatch(/headless workers can still use status, query, export and insert in Claude Code: your own rules, named above, approve them/)
    expect(off.stdout).toMatch(/headless workers can still use status, query, export and insert in Codex CLI/)
    const doctor = spawnCli(['doctor'], { home: h, env })
    const claude = doctor.stdout.split('\n').find(l => /^\[\w+\]\s+Claude Code:/.test(l)) ?? ''
    expect(claude).toMatch(/tool approvals: off by your choice \([^)]*\); status, query, export and insert approved by your allow rules mcp__treecontext__treecontext_status/)
    expect(claude).not.toMatch(/will be refused/)
  })

  for (const value of ['prompt', 'approve'] as const) {
    test(`a default of ${value} the developer set after install wins: install takes its own back, and doctor names the default`, () => {
      const { h, env } = setup()
      expect(spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, env }).status).toBe(0)
      const path = join(h, '.codex', 'config.toml')
      writeFileSync(path, readFileSync(path, 'utf8').replace('[mcp_servers.treecontext]\n', `[mcp_servers.treecontext]\ndefault_tools_approval_mode = "${value}"\n`))
      const before = spawnCli(['doctor'], { home: h })
      if (value === 'prompt') {
        expect(codexRow(before.stdout)).toMatch(/^\[warn\].*install's own approvals of status, query, export and insert override your default_tools_approval_mode = "prompt"/)
      } else {
        expect(codexRow(before.stdout)).toMatch(/^\[ok\].*decides every tool, so the next install takes install's own approvals back/)
      }
      const again = spawnCli(['install', '--yes', '--agent', 'codex'], { home: h, env })
      expect(again.status, again.out).toBe(0)
      expect(again.stdout).toMatch(/took back install's treecontext_status, treecontext_query, treecontext_export and treecontext_insert; your default_tools_approval_mode = .* decides every tool/)
      expect(again.stdout).toMatch(new RegExp(`Codex CLI: none approved by install; .*approved|refused by your mcp_servers\\.treecontext\\.default_tools_approval_mode = "${value}"`))
      const entry = (parseToml(readFileSync(path, 'utf8')) as { mcp_servers: { treecontext: Record<string, unknown> } }).mcp_servers.treecontext
      expect(entry['tools']).toBeUndefined()
      expect(entry['default_tools_approval_mode']).toBe(value)
      const doctor = spawnCli(['doctor'], { home: h })
      const row = codexRow(doctor.stdout)
      expect(row).toContain(`by your mcp_servers.treecontext.default_tools_approval_mode = "${value}" in ${path}`)
      expect(row).toMatch(value === 'prompt' ? /^\[warn\]/ : /^\[ok\]/)
    })
  }

  test('a record that does not parse is moved aside, said loudly, and install writes no approval until the developer chooses', () => {
    const { h, env } = setup()
    mkdirSync(join(h, '.treecontext'), { recursive: true })
    writeFileSync(join(h, '.treecontext', 'install-state.json'), '{"toolApprovals": {"off": {"claude"')
    const run = spawnCli(['install', '--yes'], { home: h, env })
    expect(run.status, run.out).toBe(0)
    expect(run.stderr).toMatch(/install record .* could not be read; it was moved to .*install-state\.json\.corrupt-\d{8}T\d{6}Z/)
    expect(readdirSync(join(h, '.treecontext')).some(f => f.startsWith('install-state.json.corrupt-'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['permissions']).toBeUndefined()
    expect(run.stdout).toMatch(/Claude Code: none written — whether you turned tool approvals off is not known/)
    // A second install still writes none; the developer's choice settles it.
    const second = spawnCli(['install', '--yes'], { home: h, env })
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))['permissions']).toBeUndefined()
    expect(second.stdout).toMatch(/none written — whether you turned tool approvals off is not known/)
    expect(spawnCli(['config', 'tool-approvals', 'on'], { home: h, env }).status).toBe(0)
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))['permissions']).toEqual({ allow: FOUR })
  })
})

describe.skipIf(process.platform === 'win32')('doctor reads the configuration in force for its directory (D387)', () => {
  test("a project's own settings and a trusted project's Codex configuration decide, and the row names their file", () => {
    const h = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-approvals-cwd-')))
    dirs.push(h)
    mkdirSync(join(h, '.claude'), { recursive: true })
    mkdirSync(join(h, '.codex'), { recursive: true })
    // The real Codex on PATH: doctor asks it for its reading of the project.
    expect(spawnCli(['install', '--yes'], { home: h }).status).toBe(0)
    const proj = join(h, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    mkdirSync(join(proj, '.codex'), { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: proj })
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['mcp__treecontext__treecontext_insert'] } }))
    writeFileSync(join(proj, '.codex', 'config.toml'), '[mcp_servers.treecontext.tools.treecontext_status]\napproval_mode = "prompt"\n')
    const user = join(h, '.codex', 'config.toml')
    writeFileSync(user, `[projects.${JSON.stringify(proj)}]\ntrust_level = "trusted"\n\n${readFileSync(user, 'utf8')}`)
    const doctor = spawnCli(['doctor'], { home: h, cwd: proj })
    const claude = doctor.stdout.split('\n').find(l => /^\[\w+\]\s+Claude Code:/.test(l)) ?? ''
    expect(claude).toMatch(/^\[warn\]/)
    expect(claude).toContain(`insert refused by your deny rule mcp__treecontext__treecontext_insert in ${join(proj, '.claude', 'settings.local.json')}`)
    const codex = doctor.stdout.split('\n').find(l => /^\[\w+\]\s+Codex CLI:/.test(l)) ?? ''
    expect(codex).toMatch(/^\[warn\]/)
    expect(codex).toContain(`status refused by your mcp_servers.treecontext.tools.treecontext_status.approval_mode = "prompt" in ${join(proj, '.codex', 'config.toml')}`)
    // From the user's own directory, neither rule is in force.
    const home = spawnCli(['doctor'], { home: h })
    expect(home.stdout.split('\n').find(l => /^\[\w+\]\s+Codex CLI:/.test(l))).toMatch(/^\[ok\]/)
  })
})
