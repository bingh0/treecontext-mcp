/**
 * A copying client's copy, through the real CLI in a redirected HOME
 * (D161, D208, D225): every remedy doctor names is run as printed and
 * doctor read again from its own stdout.
 *
 * - config.toml's [hooks] is graded, rewritten and uninstalled like
 *   hooks.json (a drifted entry there once read inconsistent forever after
 *   the named command, and outlived uninstall);
 * - a copy in two places reads inconsistent, since it would fire twice;
 * - a foreign hook named tc-* outside treecontext's hooks directory is
 *   neither graded nor touched;
 * - uninstalling Claude Code refuses to delete the scripts a copy runs;
 * - a copy whose scripts are missing reads inconsistent, and the fix line
 *   carries the flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { spawnCli, type CliSpawnResult } from '../helpers/cli-spawn.js'
import { TS_ROOT } from '../journal/proc.js'

let home: string

const cli = (args: string[]): CliSpawnResult => spawnCli(args, { home, cwd: TS_ROOT })
const ok = (args: string[]): CliSpawnResult => {
  const r = cli(args)
  expect(r.status, r.out).toBe(0)
  return r
}

interface Row { line: string; status: string; state: string; remedy: string; fix: string | null }

/** Doctor's row for one client, off doctor's own stdout. */
function row(name: string): Row {
  const r = ok(['doctor'])
  const lines = r.stdout.split('\n')
  const i = lines.findIndex(l => new RegExp(`^\\[\\w+\\]\\s+${name}:`).test(l))
  expect(i, `doctor printed no ${name} row:\n${r.stdout}`).toBeGreaterThanOrEqual(0)
  const line = lines[i]!
  const m = /^\[(\w+)\].*?; state: (.+?); remedy: (.+)$/.exec(line)
  expect(m, line).not.toBeNull()
  const fix = /^\s+fix: (.+)$/.exec(lines[i + 1] ?? '')?.[1] ?? null
  return { line, status: m![1]!, state: m![2]!, remedy: m![3]!, fix }
}

/** Run the command a row names, exactly as printed. */
function runNamed(command: string): void {
  const argv = command.trim().split(/\s+/)
  expect(argv[0]).toBe('treecontext')
  ok(argv.slice(1))
}

const scripts = ['session-reminder', 'session-start', 'pre-compact', 'post-tool-use', 'user-prompt-submit', 'stop']
  .map(n => (): string => join(home, '.claude', 'hooks', `tc-${n}${process.platform === 'win32' ? '.cmd' : ''}`))
const codexHooks = (): string => join(home, '.codex', 'hooks.json')
const codexToml = (): string => join(home, '.codex', 'config.toml')
const claudeBlock = (): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, unknown> }).hooks

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-copies-home-')))
  for (const d of ['.claude', '.codex', '.gemini']) mkdirSync(join(home, d), { recursive: true })
  // Gemini CLI installed: the installation_id it writes on its first run (D383);
  // the directory alone, or a settings.json of only treecontext's, is not.
  writeFileSync(join(home, '.gemini', 'installation_id'), 'copies-world\n')
  ok(['install', '--yes', '--agent', 'claude'])
  ok(['install', '--yes', '--agent', 'codex'])
  ok(['install', '--yes', '--agent', 'gemini'])
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('doctor and install on a copying client, end to end', () => {
  it("config.toml's [hooks] is graded, rewritten by the named command, and uninstalled, foreign entries kept", () => {
    const toml = parseToml(readFileSync(codexToml(), 'utf8')) as Record<string, unknown>
    toml['hooks'] = {
      // A drifted copy: one entry of ours, the rest of the block missing.
      PreCompact: [{ hooks: [{ type: 'command', command: `"${join(home, '.claude', 'hooks', 'tc-pre-compact')}"` }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
    }
    writeFileSync(codexToml(), stringifyToml(toml) + '\n')

    const before = row('Codex CLI')
    expect(before.state).toContain(`[hooks] in ${codexToml()}: present and inconsistent`)
    expect(before.status).toBe('warn')
    expect(before.fix).toBe('treecontext install --agent codex --experimental-capture')

    runNamed(before.fix!)
    const after = row('Codex CLI')
    expect(after.state).toBe(`hooks copied into ${codexHooks()}: present and consistent with the Claude Code block (experimental capture — unverified)`)
    const tomlAfter = parseToml(readFileSync(codexToml(), 'utf8')) as { hooks?: Record<string, unknown> }
    expect(tomlAfter.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] })

    ok(['uninstall', '--agent', 'codex', '--hooks-only'])
    expect(row('Codex CLI').state).toMatch(/^hooks not copied into /)
    expect((parseToml(readFileSync(codexToml(), 'utf8')) as { hooks?: unknown }).hooks)
      .toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] })
  }, 120_000)

  it("uninstall alone takes our entries out of config.toml's [hooks] and keeps the user's", () => {
    const toml = parseToml(readFileSync(codexToml(), 'utf8')) as Record<string, unknown>
    toml['hooks'] = {
      PreCompact: [{ hooks: [{ type: 'command', command: `"${join(home, '.claude', 'hooks', 'tc-pre-compact')}"` }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
    }
    writeFileSync(codexToml(), stringifyToml(toml) + '\n')
    expect(row('Codex CLI').state).toMatch(/present and inconsistent/)
    ok(['uninstall', '--agent', 'codex', '--hooks-only'])
    expect((parseToml(readFileSync(codexToml(), 'utf8')) as { hooks?: unknown }).hooks)
      .toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] })
    expect(row('Codex CLI').state).toMatch(/^hooks not copied into /)
  }, 120_000)

  it("a client's row says the capture mode is the server's, and Claude Code's row is unchanged", () => {
    const r = ok(['doctor']).stdout
    expect(r).toMatch(/^\[ok\]\s+Codex CLI: MCP configured, server mode: standard \(no auto-capture\) \(this client: tools only\),/m)
    expect(r).toMatch(/^\[ok\]\s+Claude Code: MCP configured, mode: capture,/m)
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    expect(ok(['doctor']).stdout).toMatch(/Codex CLI: MCP configured, server mode: capture \(this client: experimental hooks, unverified\),/)
  }, 120_000)

  it('a hooks-only uninstall of the copy leaves the entry without capture, its other keys kept, and doctor [ok] at once (D386)', () => {
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    const toml = parseToml(readFileSync(codexToml(), 'utf8')) as { mcp_servers: Record<string, Record<string, unknown>> }
    expect(toml.mcp_servers['treecontext']!['args']).toContain('--capture')
    toml.mcp_servers['treecontext']!['args'] = [...(toml.mcp_servers['treecontext']!['args'] as string[]), '--store', 'pinned']
    toml.mcp_servers['treecontext']!['startup_timeout_sec'] = 30
    writeFileSync(codexToml(), stringifyToml(toml) + '\n')
    const un = ok(['uninstall', '--agent', 'codex', '--hooks-only'])
    // The line names the exact backup the rewrite kept.
    const named = new RegExp(`set to no capture in .*config\\.toml \\[updated — .*comments are not preserved; the file as it was is at (\\S+\\.treecontext-bak-\\d{8}T\\d{6}Z(?:-\\d+)?)\\]`).exec(un.stdout)
    expect(named, un.stdout).not.toBeNull()
    expect(existsSync(named![1]!)).toBe(true)
    const after = (parseToml(readFileSync(codexToml(), 'utf8')) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers['treecontext']!
    expect(after['args']).toEqual(['serve', '--transport', 'stdio', '--lexical', '--no-capture', '--store', 'pinned'])
    expect(after['startup_timeout_sec']).toBe(30)
    const r = row('Codex CLI')
    expect(r.status, r.line).toBe('ok')
    expect(r.line).toMatch(/server mode: standard \(no auto-capture\) \(this client: tools only\), /)
  }, 120_000)

  for (const client of [
    { name: 'Codex CLI', slug: 'codex' },
    { name: 'Gemini CLI', slug: 'gemini' },
  ] as const) {
    it(`a ${client.name} copy beside a server without capture warns, names the install, and the install clears it (D386)`, () => {
      ok(['install', '--agent', client.slug, '--experimental-capture'])
      // The entry turned to no capture by hand while the copy stays.
      const setArgs = (edit: (a: string[]) => string[]): void => {
        if (client.slug === 'codex') {
          const t = parseToml(readFileSync(codexToml(), 'utf8')) as { mcp_servers: Record<string, Record<string, unknown>> }
          t.mcp_servers['treecontext']!['args'] = edit(t.mcp_servers['treecontext']!['args'] as string[])
          writeFileSync(codexToml(), stringifyToml(t) + '\n')
        } else {
          const path = join(home, '.gemini', 'settings.json')
          const j = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }
          j.mcpServers['treecontext']!.args = edit(j.mcpServers['treecontext']!.args)
          writeFileSync(path, JSON.stringify(j, null, 2))
        }
      }
      const before = row(client.name)
      expect(before.status, before.line).toBe('ok')
      setArgs(a => a.filter(t => t !== '--capture' && t !== '--debug').concat('--no-capture'))
      const warned = row(client.name)
      expect(warned.status, warned.line).toBe('warn')
      expect(warned.line).toContain("server mode: standard (no auto-capture) (this client: experimental hooks, unverified) — but this client's hooks run, and this server does not drain what they stage, ")
      expect(warned.state).toMatch(/present and consistent/)
      expect(warned.fix).toBe(`treecontext install --agent ${client.slug}`)
      runNamed(warned.fix!)
      const after = row(client.name)
      expect(after.status, after.line).toBe('ok')
      expect(after.line).toContain('server mode: capture (this client: experimental hooks, unverified), ')
    }, 120_000)
  }

  it('a copy in two places reads inconsistent — it would fire twice — and the named command leaves one', () => {
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    expect(row('Codex CLI').state).toMatch(/present and consistent/)
    const toml = parseToml(readFileSync(codexToml(), 'utf8')) as Record<string, unknown>
    toml['hooks'] = claudeBlock()
    writeFileSync(codexToml(), stringifyToml(toml) + '\n')

    const twice = row('Codex CLI')
    expect(twice.state).toContain(`hooks copied into ${codexHooks()} and [hooks] in ${codexToml()}: present and inconsistent`)
    expect(twice.state).toContain('would fire twice')
    expect(twice.remedy).toBe('to rewrite the copy: treecontext install --agent codex --experimental-capture')
    runNamed(twice.fix!)
    expect(row('Codex CLI').state).toMatch(/^hooks copied into [^ ]*hooks\.json: present and consistent/)
  }, 120_000)

  it('a foreign tc-* hook outside treecontext\'s hooks directory is neither graded nor touched', () => {
    const foreign = join(home, 'project', '.git', 'hooks', 'tc-notify.sh')
    const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } }
    writeFileSync(codexHooks(), JSON.stringify(user))
    // Control: the path really has the shape the old marker claimed.
    expect(foreign.replace(/\\/g, '/')).toContain('/hooks/tc-')

    expect(row('Codex CLI').state).toMatch(/^hooks not copied into /)
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    const written = JSON.parse(readFileSync(codexHooks(), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(written.hooks['Stop']!.flatMap(m => m.hooks.map(h => h.command))).toContain(foreign)
    expect(row('Codex CLI').state).toMatch(/present and consistent/)
    ok(['uninstall', '--agent', 'codex', '--hooks-only'])
    expect(JSON.parse(readFileSync(codexHooks(), 'utf8'))).toEqual(user)
  }, 120_000)

  it('uninstalling Claude Code refuses to delete the scripts a copy runs, and names the command that removes the copy first', () => {
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    const refused = cli(['uninstall', '--agent', 'claude'])
    expect(refused.status, refused.out).toBe(1)
    expect(refused.stdout).toContain('Codex CLI still runs them')
    expect(refused.stdout).toContain('treecontext uninstall --agent codex')
    for (const p of scripts) expect(existsSync(p()), p()).toBe(true)
    expect(row('Codex CLI').state).toMatch(/present and consistent/)

    ok(['uninstall', '--agent', 'codex'])
    ok(['uninstall', '--agent', 'claude'])
    for (const p of scripts) expect(existsSync(p()), p()).toBe(false)
  }, 120_000)

  it('a copy whose scripts are missing reads inconsistent, and the flagged fix restores them', () => {
    ok(['install', '--agent', 'codex', '--experimental-capture'])
    unlinkSync(scripts[5]!())
    const broken = row('Codex CLI')
    // Doctor names the file on disk, which is stop.cmd on Windows.
    const stop = `stop${process.platform === 'win32' ? '.cmd' : ''}`
    expect(broken.state).toContain(`present and inconsistent with the Claude Code block (the hook scripts it runs are missing: ${stop})`)
    expect(broken.fix).toBe('treecontext install --agent codex --experimental-capture')
    runNamed(broken.fix!)
    expect(existsSync(scripts[5]!())).toBe(true)
    expect(row('Codex CLI').state).toMatch(/present and consistent/)
  }, 120_000)

  it('when the MCP half needs the install too, the one fix line still carries the flag', () => {
    ok(['install', '--agent', 'gemini', '--experimental-capture'])
    const settingsPath = join(home, '.gemini', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, Record<string, unknown>>
    delete settings['hooks']!['AfterTool']
    delete settings['mcpServers']!['treecontext']
    writeFileSync(settingsPath, JSON.stringify(settings))

    const both = row('Gemini CLI')
    expect(both.state).toContain('present and inconsistent')
    expect(both.fix).toBe('treecontext install --force --agent gemini --experimental-capture')
    runNamed(both.fix!)
    const fixed = row('Gemini CLI')
    expect(fixed.status).toBe('ok')
    expect(fixed.state).toMatch(/present and consistent/)
  }, 120_000)
})
