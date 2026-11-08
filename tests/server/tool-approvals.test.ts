import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { spawnCli } from '../helpers/cli-spawn.js'
import { sandboxedEnv } from '../helpers/home.js'
import { writeFakeCodex } from '../journal/standins.js'
import {
  APPROVED_TOOLS, claudeApprovalClause, codexHeadlessClause, withClaudeApprovals, withCodexApprovals,
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

  test("doctor's clause names the rule that governs a refused tool, and where", () => {
    const c = claudeApprovalClause('/h/.claude/settings.json', { state: 'ok', data: { permissions: { allow: FOUR.slice(0, 3), deny: ['mcp__treecontext__treecontext_insert'] } } }, false, { items: FOUR.slice(0, 3), at: '' })
    expect(c.warn).toBe(true)
    expect(c.text).toBe('tool approvals: a `claude -p` worker would be refused treecontext_insert — your deny rule mcp__treecontext__treecontext_insert in /h/.claude/settings.json governs treecontext_insert')
    expect(c.fix).toBe('your deny rule mcp__treecontext__treecontext_insert in /h/.claude/settings.json, yours to change (install leaves it)')
    const missing = claudeApprovalClause('/h/s.json', { state: 'ok', data: {} }, false, undefined)
    expect(missing.warn).toBe(true)
    expect(missing.fix).toBe('treecontext install --agent claude')
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

  test('a default of the developer\'s decides every tool: install writes none', () => {
    const m = withCodexApprovals({ default_tools_approval_mode: 'prompt' }, [])
    expect(m.entry).toBeNull()
    expect(m.defaultMode).toBe('prompt')
  })

  test('takes back only approvals that still read what install wrote', () => {
    const entry = { tools: { treecontext_status: { approval_mode: 'approve' }, treecontext_query: { approval_mode: 'prompt' }, treecontext_export: { approval_mode: 'approve', other: 1 } } }
    const back = withoutCodexApprovals(entry, ['treecontext_status', 'treecontext_query', 'treecontext_export'])
    expect(back.removed).toEqual(['treecontext_status', 'treecontext_export'])
    expect(back.entry).toEqual({ tools: { treecontext_query: { approval_mode: 'prompt' }, treecontext_export: { other: 1 } } })
  })

  test("doctor's clause below the floor, and with a default that asks", () => {
    const four = { env_vars: WORKER_VARS, tools: Object.fromEntries(APPROVED_TOOLS.map(t => [t, { approval_mode: 'approve' }])) }
    const below = codexHeadlessClause('/h/c.toml', four, WORKER_VARS, false, codexApprovalSupport('0.166.0'), CODEX_APPROVALS_FLOOR)
    expect(below.warn).toBe(true)
    expect(below.text).toBe(`headless workers: Codex 0.166.0 cannot read per-tool approvals: its headless workers need Codex ${CODEX_APPROVALS_FLOOR} or newer for the tools`)
    const asks = codexHeadlessClause('/h/c.toml', { env_vars: WORKER_VARS, default_tools_approval_mode: 'prompt' }, WORKER_VARS, false, codexApprovalSupport('0.167.0'), CODEX_APPROVALS_FLOOR)
    expect(asks.warn).toBe(true)
    expect(asks.text).toMatch(/refused treecontext_status, treecontext_query, treecontext_export and treecontext_insert — your default_tools_approval_mode = "prompt" in \/h\/c\.toml decides every treecontext call/)
    expect(asks.fix).toBe('your mcp_servers.treecontext.default_tools_approval_mode = "prompt" in /h/c.toml, yours to change (install leaves it)')
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

describe.skipIf(process.platform === 'win32')('a Codex older than the floor, through the real CLI (D381)', () => {
  test('install writes no per-tool approval and says why in one line, and doctor says the same', () => {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-approvals-')))
    dirs.push(home)
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    const bin = join(home, 'fake-bin')
    mkdirSync(bin)
    writeFakeCodex(bin, { version: '0.166.0', sandbox: { exit: 0, stderr: '' } })
    const env = { PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` }
    const install = spawnCli(['install', '--yes', '--agent', 'codex'], { home, env })
    expect(install.status, install.out).toBe(0)
    const said = install.stdout.split('\n').filter(l => /Codex 0\.166\.0/.test(l))
    expect(said).toContain(`  tool approvals: none written — Codex 0.166.0 cannot read per-tool approvals: its headless workers need Codex ${CODEX_APPROVALS_FLOOR} or newer for the tools`)
    const entry = (parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as { mcp_servers: { treecontext: Record<string, unknown> } }).mcp_servers.treecontext
    expect(entry['tools']).toBeUndefined()
    expect(entry['default_tools_approval_mode']).toBeUndefined()
    const doctor = spawnCli(['doctor'], { home, env })
    expect(doctor.stdout).toMatch(new RegExp(`^\\[warn\\]\\s+Codex CLI: .*headless workers: Codex 0\\.166\\.0 cannot read per-tool approvals: its headless workers need Codex ${CODEX_APPROVALS_FLOOR.replace(/\./g, '\\.')} or newer for the tools`, 'm'))
  })
})

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
    expect(msg).toContain(`  Claude Code: status, query, export and insert approved (permissions.allow in ${join(h, '.claude', 'settings.json')})`)
    expect(msg).toContain(`  Codex CLI: status, query, export and insert approved (mcp_servers.treecontext.tools in ${join(h, '.codex', 'config.toml')})`)
    expect(msg).toContain('  still asking in each: clear, delete, import and merge, so a headless worker is refused them')
    expect(msg).toContain('  the way back: treecontext config tool-approvals off, or treecontext install --no-tool-approvals')
  })
})
