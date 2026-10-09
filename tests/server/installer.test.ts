import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync,
  mkdirSync, symlinkSync, readdirSync,
} from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parse as parseToml } from 'smol-toml'
import type { AgentDefinition } from '../../src/server/agents.js'
import {
  upsertJsonMcp, removeJsonMcp,
  upsertTomlMcp, removeTomlMcp,
  upsertInstructions, removeInstructions,
  upsertClaudeSettingsHooks, removeClaudeSettingsHooks, unrunnableHookCommands,
  installClaudeHookScripts,
  claudeHookCommand, claudeHookDispatch, claudeHookCommandsWithoutExec, withoutExec, hookShellFor,
  upsertGeminiHooks, removeGeminiHooks,
  claudeHooksBlock, claudeHookSummaryLines, translateHookBlockForGemini, removeCodexHooks, parseJsonc,
  upsertVscodeHooks, upsertCodexHooks, upsertCursorHooks,
  removeVscodeHooks, removeCursorHooks,
  buildVscodeHooksConfig, vscodeHooksComplete,
  agentHookWrapperIssue, resetManagedLayoutScan,
  buildMcpEntry, configRootKey, mcpCommand,
  mcpLauncherPath, mcpLauncherScriptContent,
  hookScriptContent, interpreterIssue, launcherInterpreter, launcherCliPath,
  hookScriptIssue,
  installClaudeSkill, removeClaudeSkill, skillFileContent,
  claudeHookScriptPaths,
  AGENT_HOOK_WRAPPER_STEMS, agentHookWrapperPath, agentHookWrapperContent,
  installAgentHookWrappers, removeAgentHookWrappers, removeClaudeHookScripts,
} from '../../src/server/installer.js'
import { SKILL_REFERENCE_NAME } from '../../src/server/instructions.js'
import { AGENTS, getAgent, detectAgents, getConfigPath } from '../../src/server/agents.js'
import { redirectHome } from '../helpers/home.js'
import { itPosix } from '../helpers/platform.js'

// ── Helpers ───────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function makeAgent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'TestAgent',
    slug: 'test',
    configFormat: 'json-mcpServers',
    detectDirs: {},
    configPath: {},
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('mcpCommand', () => {
  it('returns the absolute launcher-wrapper path (upgrade-survivable, not a raw interpreter)', () => {
    const cmd = mcpCommand(false)
    // Must be the stable wrapper, NOT process.execPath: baking a version-
    // stamped node path here is what breaks the MCP server on an nvm upgrade.
    expect(cmd.command).toBe(mcpLauncherPath())
    expect(isAbsolute(cmd.command)).toBe(true)
    expect(cmd.command).not.toBe(process.execPath)
    // Serve args (not the interpreter) carry the flags; cli.js is baked into
    // the wrapper, so args start with `serve`, not a cli.js path.
    expect(cmd.args[0]).toBe('serve')
    expect(cmd.args).toContain('serve')
    expect(cmd.args).toContain('--transport')
    expect(cmd.args).toContain('stdio')
    expect(cmd.args).toContain('--capture')
  })

  it('returns npx wrapper when useNpx is true', () => {
    const cmd = mcpCommand(true)
    expect(cmd.command).toBe('npx')
    expect(cmd.args).toEqual(['-y', 'treecontext-mcp', 'serve', '--transport', 'stdio', '--capture', '--debug'])
  })
})

describe('buildMcpEntry', () => {
  it('builds json-mcpServers entry (Claude/Gemini/Cursor/etc)', () => {
    const agent = makeAgent({ configFormat: 'json-mcpServers' })
    const entry = buildMcpEntry(agent, false)
    expect(entry.command).toBeDefined()
    expect(entry.args).toBeDefined()
    expect((entry.args as string[])).toContain('--capture')
  })

  it('builds json-servers entry (VS Code/JetBrains)', () => {
    const agent = makeAgent({ configFormat: 'json-servers' })
    const entry = buildMcpEntry(agent, false)
    expect(entry.type).toBe('stdio')
    expect(entry.command).toBeDefined()
    expect((entry.args as string[])).toContain('--capture')
  })

  it('builds json-opencode entry', () => {
    const agent = makeAgent({ configFormat: 'json-opencode' })
    const entry = buildMcpEntry(agent, false)
    expect(entry.type).toBe('local')
    expect((entry.command as string[])).toContain('serve')
  })

  it('builds toml-codex entry (same shape as json-mcpServers)', () => {
    const agent = makeAgent({ configFormat: 'toml-codex' })
    const entry = buildMcpEntry(agent, false)
    expect(entry.command).toBeDefined()
    expect(entry.args).toBeDefined()
    expect((entry.args as string[])).toContain('--capture')
  })

  it('uses npx when requested', () => {
    const agent = makeAgent({ configFormat: 'json-servers' })
    const entry = buildMcpEntry(agent, true)
    expect(entry.command).toBe('npx')
    expect(entry.args).toEqual(['-y', 'treecontext-mcp', 'serve', '--transport', 'stdio', '--capture', '--debug'])
  })
})

describe('configRootKey', () => {
  it('returns mcpServers for json-mcpServers', () => {
    expect(configRootKey(makeAgent({ configFormat: 'json-mcpServers' }))).toBe('mcpServers')
  })
  it('returns servers for json-servers', () => {
    expect(configRootKey(makeAgent({ configFormat: 'json-servers' }))).toBe('servers')
  })
  it('returns mcp for json-opencode', () => {
    expect(configRootKey(makeAgent({ configFormat: 'json-opencode' }))).toBe('mcp')
  })
  it('returns mcp_servers for toml-codex', () => {
    expect(configRootKey(makeAgent({ configFormat: 'toml-codex' }))).toBe('mcp_servers')
  })
})

describe('upsertJsonMcp', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates a new config file when none exists', () => {
    const p = join(dir, 'mcp.json')
    const entry = { command: 'treecontext', args: ['serve'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('created')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(entry)
  })

  it('merges into existing config without clobbering other servers', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { other: { command: 'other-tool', args: [] } },
    }))
    const entry = { command: 'treecontext', args: ['serve'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('created')
    const data = readJson(p)
    const servers = data.mcpServers as Record<string, unknown>
    expect(servers.other).toEqual({ command: 'other-tool', args: [] })
    expect(servers.treecontext).toEqual(entry)
  })

  it('skips when already configured with an absolute command and force=false', () => {
    const p = join(dir, 'mcp.json')
    const existing = { command: process.execPath, args: ['some-path.js', '--capture', '--code-index'] }
    writeFileSync(p, JSON.stringify({ mcpServers: { treecontext: existing } }))
    const r = upsertJsonMcp(p, 'mcpServers', { command: 'new' }, false, false)
    expect(r.status).toBe('skipped')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(existing)
  })

  it('auto-upgrades legacy bare-node command even when flags are current (AC1.5)', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: 'node', args: ['some-path.js', '--capture', '--code-index'] } },
    }))
    const entry = { command: process.execPath, args: ['cli.js', 'serve', '--capture', '--code-index'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(entry)
    // second run converges to skip
    const r2 = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r2.status).toBe('skipped')
  })

  it('auto-upgrades when existing absolute interpreter no longer exists (AC1.5)', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: '/nonexistent/cellar/node', args: ['cli.js', '--capture', '--code-index'] } },
    }))
    const entry = { command: process.execPath, args: ['cli.js', '--capture', '--code-index'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
  })

  it('converges the backend flag: adds --lexical to an old config without --force', () => {
    const p = join(dir, 'mcp.json')
    // Healthy interpreter + capture/code-index, but missing the default
    // lexical flag. Without convergence this would wrongly skip.
    const existing = { command: process.execPath, args: ['cli.js', 'serve', '--capture', '--code-index'] }
    writeFileSync(p, JSON.stringify({ mcpServers: { treecontext: existing } }))
    const entry = { command: process.execPath, args: ['cli.js', 'serve', '--capture', '--code-index', '--lexical'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(entry)
    // idempotent once converged
    expect(upsertJsonMcp(p, 'mcpServers', entry, false, false).status).toBe('skipped')
  })

  it('converges the backend flag: honors explicit --no-lexical by stripping it without --force', () => {
    const p = join(dir, 'mcp.json')
    const existing = { command: process.execPath, args: ['cli.js', 'serve', '--capture', '--code-index', '--lexical'] }
    writeFileSync(p, JSON.stringify({ mcpServers: { treecontext: existing } }))
    // Desired = embedder/tree backend (no --lexical).
    const entry = { command: process.execPath, args: ['cli.js', 'serve', '--capture', '--code-index'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    const args = ((data.mcpServers as Record<string, unknown>).treecontext as { args: string[] }).args
    expect(args).not.toContain('--lexical')
  })

  it('auto-upgrades when existing command is not resolvable in PATH', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: 'treecontext-nonexistent-binary', args: [] } },
    }))
    const entry = { command: 'node', args: ['cli.js', 'serve'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(entry)
  })

  it('treats shell metacharacters in existing command as unresolvable', () => {
    const marker = join(dir, 'pwned')
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: `; touch ${marker}`, args: ['--capture'] } },
    }))
    const entry = { command: 'node', args: ['cli.js', 'serve'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, false, false)
    expect(r.status).toBe('updated')
    expect(existsSync(marker)).toBe(false)
  })

  it('overwrites when force=true', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: 'old', args: [] } },
    }))
    const entry = { command: 'treecontext', args: ['serve'] }
    const r = upsertJsonMcp(p, 'mcpServers', entry, true, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual(entry)
  })

  it('returns dry-run status and does not write', () => {
    const p = join(dir, 'mcp.json')
    const r = upsertJsonMcp(p, 'mcpServers', { command: 'x' }, false, true)
    expect(r.status).toBe('dry-run')
    expect(existsSync(p)).toBe(false)
  })

  it('works with VS Code "servers" root key', () => {
    const p = join(dir, 'mcp.json')
    const entry = { type: 'stdio', command: 'treecontext', args: ['serve'] }
    upsertJsonMcp(p, 'servers', entry, false, false)
    const data = readJson(p)
    expect((data.servers as Record<string, unknown>).treecontext).toEqual(entry)
  })

  it('works with OpenCode "mcp" root key', () => {
    const p = join(dir, 'opencode.json')
    const entry = { type: 'local', command: ['treecontext', 'serve'] }
    upsertJsonMcp(p, 'mcp', entry, false, false)
    const data = readJson(p)
    expect((data.mcp as Record<string, unknown>).treecontext).toEqual(entry)
  })

  it('handles corrupt JSON by backing up and starting fresh', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, 'not json at all {{{')
    const r = upsertJsonMcp(p, 'mcpServers', { command: 'treecontext' }, false, false)
    expect(r.status).toBe('created')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toEqual({ command: 'treecontext' })
    expect(existsSync(`${p}.bak`)).toBe(true)
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe('not json at all {{{')
  })

  it('skips when --code-annotation present (legacy code-index flag)', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: { treecontext: { command: process.execPath, args: ['cli.js', '--capture', '--code-annotation'] } },
    }))
    const r = upsertJsonMcp(p, 'mcpServers', { command: 'new' }, false, false)
    expect(r.status).toBe('skipped')
  })
})

describe('removeJsonMcp', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes treecontext entry and keeps others', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({
      mcpServers: {
        other: { command: 'other' },
        treecontext: { command: 'treecontext' },
      },
    }))
    const r = removeJsonMcp(p, 'mcpServers', false)
    expect(r).not.toBeNull()
    expect(r!.status).toBe('updated')
    const data = readJson(p)
    const servers = data.mcpServers as Record<string, unknown>
    expect(servers.treecontext).toBeUndefined()
    expect(servers.other).toEqual({ command: 'other' })
  })

  it('returns null when file does not exist', () => {
    expect(removeJsonMcp(join(dir, 'nope.json'), 'mcpServers', false)).toBeNull()
  })

  it('returns null when treecontext entry not present', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ mcpServers: { other: {} } }))
    expect(removeJsonMcp(p, 'mcpServers', false)).toBeNull()
  })

  it('respects dry-run', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ mcpServers: { treecontext: {} } }))
    const r = removeJsonMcp(p, 'mcpServers', true)
    expect(r!.status).toBe('dry-run')
    const data = readJson(p)
    expect((data.mcpServers as Record<string, unknown>).treecontext).toBeDefined()
  })
})

describe('upsertTomlMcp', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates a new TOML config', () => {
    const p = join(dir, 'config.toml')
    const entry = { command: 'treecontext', args: ['serve', '--transport', 'stdio'] }
    const r = upsertTomlMcp(p, entry, false, false)
    expect(r.status).toBe('created')
    const data = parseToml(readFileSync(p, 'utf8')) as Record<string, unknown>
    const servers = data.mcp_servers as Record<string, unknown>
    expect(servers.treecontext).toEqual(entry)
  })

  it('merges into existing TOML without clobbering', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, [
      '[mcp_servers.other]',
      'command = "other-tool"',
      '',
    ].join('\n'))
    const entry = { command: 'treecontext', args: ['serve'] }
    const r = upsertTomlMcp(p, entry, false, false)
    expect(r.status).toBe('created')
    const data = parseToml(readFileSync(p, 'utf8')) as Record<string, unknown>
    const servers = data.mcp_servers as Record<string, unknown>
    expect(servers.other).toBeDefined()
    expect(servers.treecontext).toEqual(entry)
  })

  it('skips when already configured and force=false', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, [
      '[mcp_servers.treecontext]',
      'command = "old"',
      'args = ["serve", "--capture", "--code-index"]',
    ].join('\n'))
    const r = upsertTomlMcp(p, { command: 'new' }, false, false)
    expect(r.status).toBe('skipped')
  })

  it('overwrites when force=true', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, [
      '[mcp_servers.treecontext]',
      'command = "old"',
    ].join('\n'))
    const r = upsertTomlMcp(p, { command: 'treecontext' }, true, false)
    expect(r.status).toBe('updated')
    const data = parseToml(readFileSync(p, 'utf8')) as Record<string, unknown>
    expect((data.mcp_servers as Record<string, unknown>).treecontext).toEqual({ command: 'treecontext' })
  })

  it('returns dry-run and does not write', () => {
    const p = join(dir, 'config.toml')
    const r = upsertTomlMcp(p, { command: 'treecontext' }, false, true)
    expect(r.status).toBe('dry-run')
    expect(existsSync(p)).toBe(false)
  })

  it('backs up corrupt TOML before starting fresh', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, '{{not valid toml}}')
    const entry = { command: 'treecontext', args: ['serve'] }
    const r = upsertTomlMcp(p, entry, false, false)
    expect(r.status).toBe('created')
    expect(existsSync(`${p}.bak`)).toBe(true)
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe('{{not valid toml}}')
  })
})

describe('removeTomlMcp', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes treecontext entry from TOML', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, [
      '[mcp_servers.treecontext]',
      'command = "treecontext"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
    ].join('\n'))
    const r = removeTomlMcp(p, false)
    expect(r).not.toBeNull()
    expect(r!.status).toBe('updated')
    const data = parseToml(readFileSync(p, 'utf8')) as Record<string, unknown>
    const servers = data.mcp_servers as Record<string, unknown>
    expect(servers.treecontext).toBeUndefined()
    expect(servers.other).toBeDefined()
  })

  it('returns null when file does not exist', () => {
    expect(removeTomlMcp(join(dir, 'nope.toml'), false)).toBeNull()
  })

  it('returns null when no treecontext entry', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, '[mcp_servers.other]\ncommand = "x"\n')
    expect(removeTomlMcp(p, false)).toBeNull()
  })
})

describe('upsertInstructions', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates a new instruction file', () => {
    const p = join(dir, 'AGENTS.md')
    const r = upsertInstructions(p, false, false)
    expect(r.status).toBe('created')
    const content = readFileSync(p, 'utf8')
    expect(content).toContain('<!-- treecontext:start -->')
    expect(content).toContain('<!-- treecontext:end -->')
    expect(content).toContain('treecontext_status')
  })

  it('appends to existing instruction file', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, '# Existing content\n\nSome existing instructions.\n')
    const r = upsertInstructions(p, false, false)
    expect(r.status).toBe('updated')
    const content = readFileSync(p, 'utf8')
    expect(content).toContain('# Existing content')
    expect(content).toContain('<!-- treecontext:start -->')
  })

  it('auto-upgrades stale instructions block without force', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, 'prefix\n\n<!-- treecontext:start -->\nold\n<!-- treecontext:end -->\n\nsuffix\n')
    const r = upsertInstructions(p, false, false)
    expect(r.status).toBe('updated')
    const content = readFileSync(p, 'utf8')
    expect(content).not.toContain('\nold\n')
    expect(content).toContain('treecontext_status')
    expect(content).toContain('prefix')
    expect(content).toContain('suffix')
  })

  it('skips when instructions block is already current', () => {
    const p = join(dir, 'AGENTS.md')
    upsertInstructions(p, false, false)
    const r2 = upsertInstructions(p, false, false)
    expect(r2.status).toBe('skipped')
  })

  it('replaces existing block when force=true', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, 'prefix\n\n<!-- treecontext:start -->\nold content\n<!-- treecontext:end -->\n\nsuffix\n')
    const r = upsertInstructions(p, true, false)
    expect(r.status).toBe('updated')
    const content = readFileSync(p, 'utf8')
    expect(content).not.toContain('old content')
    expect(content).toContain('treecontext_status')
    expect(content).toContain('prefix')
    expect(content).toContain('suffix')
  })

  it('returns dry-run and does not write', () => {
    const p = join(dir, 'AGENTS.md')
    const r = upsertInstructions(p, false, true)
    expect(r.status).toBe('dry-run')
    expect(existsSync(p)).toBe(false)
  })
})

describe('removeInstructions', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes treecontext block and keeps other content', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, '# Header\n\n<!-- treecontext:start -->\nstuff\n<!-- treecontext:end -->\n\n# Footer\n')
    const r = removeInstructions(p, false)
    expect(r).not.toBeNull()
    expect(r!.status).toBe('updated')
    const content = readFileSync(p, 'utf8')
    expect(content).not.toContain('treecontext:start')
    expect(content).toContain('# Header')
    expect(content).toContain('# Footer')
  })

  it('deletes file if treecontext block was the only content', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, '<!-- treecontext:start -->\nstuff\n<!-- treecontext:end -->\n')
    const r = removeInstructions(p, false)
    expect(r).not.toBeNull()
    expect(existsSync(p)).toBe(false)
  })

  it('returns null when file does not exist', () => {
    expect(removeInstructions(join(dir, 'nope.md'), false)).toBeNull()
  })

  it('returns null when no markers present', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, '# Just normal content\n')
    expect(removeInstructions(p, false)).toBeNull()
  })
})

describe('upsertClaudeSettingsHooks', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates hook entries in empty settings', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    const r = upsertClaudeSettingsHooks(p, false)
    expect(r.status).toBe('updated')
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.SessionStart).toBeDefined()
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    expect(startup).toBeDefined()
    expect(startup!.hooks.some(h => h.command.includes('tc-session-reminder'))).toBe(true)
    expect(startup!.hooks.some(h => h.command.includes('tc-session-start'))).toBe(true)
  })

  /**
   * The Windows beta's hooks all failed with
   *   /usr/bin/bash: line 1: C:Usersuser.claudehookstc-stop.cmd: command not found
   * — every backslash eaten as a shell escape, so capture recorded nothing
   * while the install reported success. The command written into settings is
   * shell INPUT, so the only honest test runs it through a shell and looks at
   * the argv that comes out the far side.
   */
  it('writes a hook command a shell resolves back to the exact script path', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const written = hooks.Stop![0]!.hooks[0]!.command
    // D251: on POSIX the shell is told to exec the wrapper; the path that
    // follows is what this test is about.
    if (process.platform !== 'win32') expect(written.startsWith('exec "'), written).toBe(true)
    const command = withoutExec(written)

    // `set --` performs exactly the word-splitting and quote-removal the
    // shell would do before exec: one word out means one argument in.
    const probe = spawnSync('bash', ['-c', `set -- ${command}; printf '%s\\n' "$#" "$1"`], {
      encoding: 'utf8',
    })
    const [argc, resolved] = probe.stdout.trim().split('\n')
    expect(argc, `the command split into ${argc} arguments: ${command}`).toBe('1')
    expect(resolved).toContain('tc-stop')
    // The separators must survive. On Windows they are forward slashes (a
    // backslash is an escape to bash); on POSIX they already are.
    expect(resolved, 'the shell ate the path separators').toMatch(/[/\\]\.claude[/\\]/)
    expect(resolved!.endsWith(process.platform === 'win32' ? 'tc-stop.cmd' : 'tc-stop')).toBe(true)
  })

  it('never writes a backslash into a Claude hook command', () => {
    // Backslash-free is the property, not "we called .replace()": on POSIX
    // it holds because paths have none, on Windows because they are
    // converted. Either way a backslash reaching settings.json is the bug.
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const commands = Object.values(hooks).flatMap(ms => ms.flatMap(m => m.hooks.map(h => h.command)))
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) {
      expect(c, `a backslash in "${c}" is eaten by the shell that runs it`).not.toContain('\\')
    }
  })

  /**
   * Doctor graded hooks by whether the SCRIPT existed and reported "hooks
   * installed" for a Windows settings file whose every command was dead.
   * Note what does NOT catch it: the broken command is a real, existing
   * Windows path — it only breaks once a shell reads it. So these cases are
   * about the command TEXT, and the false-positive rows matter as much as
   * the true ones: a check that flags working installs gets ignored.
   */
  describe('unrunnableHookCommands', () => {
    /**
     * A filesystem path written the way the installer writes it for the bash
     * form — derived from claudeHookCommand rather than restated, so the rule
     * has exactly one definition.
     *
     * This matters because `join(dir, 'tc-stop')` is a BACKSLASH path on
     * Windows, and a quoted backslash path is precisely what the checker is
     * built to condemn (the 0.0.14 fix: it survives as text but contains no
     * '/', so the shell resolves it as a command NAME against PATH). Fixtures
     * spelled that way asserted that a command the installer would never emit
     * ought to be accepted — the product was right and four cases here were
     * asserting Linux's spelling of a path.
     */
    const written = (p: string): string => unquoteBashForm(claudeHookCommand(p, 'bash'))

    const settingsWith = (d: string, command: string): string => {
      const p = join(d, `s-${Buffer.from(command).toString('hex').slice(0, 16)}.json`)
      writeFileSync(p, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
      return p
    }

    it('flags the exact command shape that shipped to the Windows beta', () => {
      const dead = unrunnableHookCommands(
        settingsWith(dir, 'C:\\Users\\user\\.claude\\hooks\\tc-stop.cmd'),
      )
      expect(dead).toHaveLength(1)
      expect(dead[0]!.reason).toMatch(/backslash/)
    })

    it('still flags a backslash path that was merely quoted', () => {
      // The obvious half-fix. Quoting preserves the backslashes, but leaves a
      // string with no "/" — which the shell resolves as a command NAME
      // against PATH instead of opening as a file. Dead either way.
      const dead = unrunnableHookCommands(
        settingsWith(dir, '"C:\\Users\\user\\.claude\\hooks\\tc-stop.cmd"'),
      )
      expect(dead, 'quoting alone was accepted as a fix').toHaveLength(1)
    })

    it('flags an unquoted path containing a space', () => {
      const hooksDir = join(dir, 'hooks with space')
      mkdirSync(hooksDir, { recursive: true })
      const script = join(hooksDir, 'tc-stop')
      writeFileSync(script, '#!/bin/sh\n')
      expect(unrunnableHookCommands(settingsWith(dir, written(script)))).toHaveLength(1)
      expect(unrunnableHookCommands(settingsWith(dir, `"${written(script)}"`))).toEqual([])
    })

    it('flags a command naming a script that is no longer there', () => {
      const dead = unrunnableHookCommands(settingsWith(dir, `"${written(join(dir, 'gone', 'tc-stop'))}"`))
      expect(dead).toHaveLength(1)
      expect(dead[0]!.reason).toMatch(/not there/)
    })

    it('leaves a working install and other tools alone', () => {
      const script = join(dir, 'tc-stop')
      writeFileSync(script, '#!/bin/sh\n')
      // The pre-quoting POSIX form is genuinely runnable — flagging it would
      // send every existing Linux and macOS user to re-run install for nothing.
      expect(unrunnableHookCommands(settingsWith(dir, written(script))), 'old unquoted form').toEqual([])
      expect(unrunnableHookCommands(settingsWith(dir, `"${written(script)}"`)), 'new quoted form').toEqual([])
      expect(unrunnableHookCommands(settingsWith(dir, 'other-tool --run')), 'foreign hook').toEqual([])
    })

    /**
     * `install` writes hook scripts under $HOME and settings whose commands
     * name them; the check grades whether those commands can run. Both halves
     * therefore have to live in the same place. Pointed at the real home
     * directory, the two tests below assert a property of the developer's
     * machine — they hold only where treecontext is already installed, which
     * is precisely why they were green here and red on every CI runner, where
     * ~/.claude/hooks is empty. Sandboxing HOME lets the loop close on its own
     * terms: install the scripts, then grade the commands that name them.
     */
    function withSandboxedHome<T>(run: () => T): T {
      const home = join(dir, 'sandbox-home')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const restore = redirectHome(home)
      try {
        installClaudeHookScripts(false)
        return run()
      } finally {
        restore()
      }
    }

    it('a re-install repairs the old command format rather than doubling it', () => {
      // The upgrade path for everyone already installed. Their settings
      // carry the pre-fix bare form; re-running install has to recognise it
      // as ours and REPLACE it. Recognition is by substring, so a format
      // change is exactly where it could stop matching and silently leave
      // the dead command in place beside a new one.
      const p = join(dir, 'settings.json')
      const stale = 'C:\\Users\\user\\.claude\\hooks\\tc-stop.cmd'
      writeFileSync(p, JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: stale }] }],
          PostToolUse: [{ hooks: [{ type: 'command', command: 'other-tool --run' }] }],
        },
      }))
      withSandboxedHome(() => {
        upsertClaudeSettingsHooks(p, false)
        const data = readJson(p)
        const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
        const stopCommands = hooks.Stop!.flatMap(m => m.hooks.map(h => h.command))
        expect(stopCommands, 'the dead command survived the repair').not.toContain(stale)
        expect(stopCommands).toHaveLength(1)
        expect(unrunnableHookCommands(p), 'the repair left something unrunnable').toEqual([])
        // Someone else's hook is not ours to rewrite or remove.
        const others = hooks.PostToolUse!.flatMap(m => m.hooks.map(h => h.command))
        expect(others).toContain('other-tool --run')
      })
    })

    /**
     * 0.0.13-beta fixed Git Bash and broke the other Windows shell. Claude
     * Code uses Git Bash when it is installed and PowerShell when it is not,
     * and the two disagree about what a runnable command looks like — so a
     * form is only correct paired with a shell, and these assert the pairing
     * in both directions.
     */
    it('writes a PowerShell-invocable command when PowerShell is the shell', () => {
      const script = 'C:\\Users\\user\\.claude\\hooks\\tc-stop.cmd'
      const cmd = claudeHookCommand(script, 'powershell')
      // A quoted path alone is an EXPRESSION in PowerShell: it evaluates to
      // a string, prints it, and runs nothing. The call operator is what
      // makes it an invocation.
      expect(cmd.startsWith('& '), `${cmd} is a string literal, not a command`).toBe(true)
      expect(cmd).toContain(script)
      // Backslashes are safe here — PowerShell escapes with a backtick — so
      // the native separators stay rather than inventing a second dialect.
      expect(cmd).toContain('\\')
    })

    it('writes a bash-resolvable command when Git Bash is the shell', () => {
      const cmd = claudeHookCommand('C:\\Users\\user\\.claude\\hooks\\tc-stop.cmd', 'bash')
      expect(cmd).not.toContain('\\')
      expect(cmd).toBe('"C:/Users/user/.claude/hooks/tc-stop.cmd"')
      // Same string is valid to cmd, which costs nothing and covers any host
      // that ever hands hooks to it.
      expect(cmd.startsWith('"') && cmd.endsWith('"')).toBe(true)
    })

    it('grades each command against the shell that will run it', () => {
      const script = join(dir, 'tc-stop')
      writeFileSync(script, '#!/bin/sh\n')
      const entry = (command: string, shell?: string): string => {
        const p = join(dir, `s-${Buffer.from(command + (shell ?? '')).toString('hex').slice(0, 16)}.json`)
        writeFileSync(p, JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: 'command', command, ...(shell ? { shell } : {}) }] }] },
        }))
        return p
      }
      // Right form, right shell — both clean.
      expect(unrunnableHookCommands(entry(claudeHookCommand(script, 'bash'), 'bash')), 'bash form under bash').toEqual([])
      expect(unrunnableHookCommands(entry(claudeHookCommand(script, 'powershell'), 'powershell')), 'ps form under ps').toEqual([])
      // Crossed over — each is dead in the other's shell, and saying so is
      // the whole point of grading per-shell rather than by one global rule.
      const bashUnderPs = unrunnableHookCommands(entry(claudeHookCommand(script, 'bash'), 'powershell'))
      expect(bashUnderPs, 'a bare quoted path was accepted for PowerShell').toHaveLength(1)
      expect(bashUnderPs[0]!.reason).toMatch(/call operator/)
      // A PowerShell command whose script is gone is still caught.
      const missing = unrunnableHookCommands(entry(claudeHookCommand(join(dir, 'gone', 'tc-stop'), 'powershell'), 'powershell'))
      expect(missing).toHaveLength(1)
      expect(missing[0]!.reason).toMatch(/not there/)
    })

    it('pins the command to its shell in the settings file', () => {
      // Without the shell field the pairing rests on our Git-Bash detection
      // matching Claude Code's forever; with it, the file says which
      // interpreter its commands were written for.
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      upsertClaudeSettingsHooks(p, false)
      const data = readJson(p)
      const hooks = data.hooks as Record<string, Array<{ hooks: Array<{ command: string; shell?: string }> }>>
      const entries = Object.values(hooks).flatMap(ms => ms.flatMap(m => m.hooks))
      expect(entries.length).toBeGreaterThan(0)
      for (const e of entries) {
        if (process.platform === 'win32') {
          expect(e.shell, `no shell pinned on: ${e.command}`).toBe(hookShellFor())
        } else {
          // One shell on POSIX, nothing to disambiguate.
          expect(e.shell).toBeUndefined()
        }
      }
    })

    it('passes what the installer itself writes', () => {
      // The loop that closes: whatever install writes must satisfy the check
      // that grades it, or the two drift and doctor starts lying again.
      const p = join(dir, 'settings.json')
      writeFileSync(p, '{}')
      withSandboxedHome(() => {
        upsertClaudeSettingsHooks(p, false)
        expect(unrunnableHookCommands(p)).toEqual([])
      })
    })
  })

  it('preserves existing non-tc hooks', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'other-tool start' }] },
        ],
      },
    }))
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    expect(startup!.hooks.some(h => h.command === 'other-tool start')).toBe(true)
    expect(startup!.hooks.some(h => h.command.includes('tc-'))).toBe(true)
  })

  it('strips legacy cbm-* hooks from all event types', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Grep|Search', hooks: [{ type: 'command', command: '~/.claude/hooks/cbm-code-discovery-gate' }] },
        ],
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: '~/.claude/hooks/cbm-session-reminder' },
              { type: 'command', command: 'other-tool start' },
            ],
          },
        ],
      },
    }))
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    // PreToolUse should be removed entirely (only had cbm hook)
    expect(hooks.PreToolUse).toBeUndefined()
    // SessionStart startup should have other-tool + tc hooks, no cbm
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    expect(startup!.hooks.some(h => h.command === 'other-tool start')).toBe(true)
    expect(startup!.hooks.some(h => h.command.includes('cbm-'))).toBe(false)
    expect(startup!.hooks.some(h => h.command.includes('tc-'))).toBe(true)
  })

  it('handles mixed cbm + tc legacy hooks on re-install', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: '~/.claude/hooks/cbm-session-reminder' },
              { type: 'command', command: '/old/path/tc-session-reminder' },
            ],
          },
        ],
      },
    }))
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    // Both legacy cbm and old tc paths should be replaced with fresh tc hooks
    expect(startup!.hooks.every(h => !h.command.includes('cbm-'))).toBe(true)
    expect(startup!.hooks.filter(h => h.command.includes('tc-')).length).toBe(2)
  })

  it('is idempotent — does not duplicate tc entries', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    const tcHooks = startup!.hooks.filter(h => h.command.includes('tc-'))
    expect(tcHooks.length).toBe(2) // reminder + session-start
  })

  it('adds compact matcher with session-start recovery (same as startup)', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const compact = hooks.SessionStart!.find(m => m.matcher === 'compact')
    expect(compact).toBeDefined()
    expect(compact!.hooks.some(h => h.command.includes('tc-session-start'))).toBe(true)
    expect(compact!.hooks.some(h => h.command.includes('tc-session-reminder'))).toBe(true)
  })

  it('registers PreCompact as separate top-level event', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.PreCompact).toBeDefined()
    expect(hooks.PreCompact!.length).toBe(1)
    expect(hooks.PreCompact![0]!.hooks.some(h => h.command.includes('tc-pre-compact'))).toBe(true)
  })

  // C4/AC4c: installer settings template includes the Stop registration.
  it('registers Stop as separate top-level event (C4: assistant response capture)', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.Stop).toBeDefined()
    expect(hooks.Stop!.length).toBe(1)
    expect(hooks.Stop![0]!.hooks.some(h => h.command.includes('tc-stop'))).toBe(true)
  })

  // D250: the printed summary named five events while the block carried
  // seven; it is now read from the block itself.
  it('the install summary lists every event of the hooks block, SubagentStart and SubagentStop included', () => {
    const events = Object.keys(claudeHooksBlock())
    expect(events).toEqual(expect.arrayContaining(['SubagentStart', 'SubagentStop', 'Stop']))
    const lines = claudeHookSummaryLines()
    expect(lines.map((l) => /^ {2}hooks: (\w+)/.exec(l)?.[1])).toEqual(events)
    expect(lines).toContain('  hooks: SubagentStart (subagent registration)')
    expect(lines).toContain('  hooks: SubagentStop (subagent report capture)')
  })

  // D251: on POSIX the hook command execs its wrapper; Windows is unchanged.
  it('dispatches a hook through exec on POSIX and in the plain forms on Windows', () => {
    expect(claudeHookDispatch('/h/.claude/hooks/tc-stop', 'bash', 'linux')).toBe('exec "/h/.claude/hooks/tc-stop"')
    expect(claudeHookDispatch('/h/.claude/hooks/tc-stop', 'bash', 'darwin')).toBe('exec "/h/.claude/hooks/tc-stop"')
    expect(claudeHookDispatch('C:\\h\\tc-stop.cmd', 'bash', 'win32')).toBe(claudeHookCommand('C:\\h\\tc-stop.cmd', 'bash'))
    expect(claudeHookDispatch('C:\\h\\tc-stop.cmd', 'powershell', 'win32')).toBe(claudeHookCommand('C:\\h\\tc-stop.cmd', 'powershell'))
    expect(withoutExec('exec "/h/tc-stop"')).toBe('"/h/tc-stop"')
  })
  it('names the treecontext hook commands that run without exec, on POSIX only, owned by exact script name', () => {
    const hooksDir = join(homedir(), '.claude', 'hooks').replace(/\\/g, '/')
    const settings = { hooks: { Stop: [{ hooks: [
      { type: 'command', command: `"${hooksDir}/tc-stop"` },
      { type: 'command', command: `exec "${hooksDir}/tc-post-tool-use"` },
      { type: 'command', command: 'other-tool --run' },
      // A foreign script in the same directory whose name merely contains
      // `tc-` is not ours, and doctor must not claim it.
      { type: 'command', command: `"${hooksDir}/etc-lint"` },
    ] }] } }
    expect(claudeHookCommandsWithoutExec(settings, 'linux')).toEqual([`"${hooksDir}/tc-stop"`])
    expect(claudeHookCommandsWithoutExec(settings, 'win32')).toEqual([])
  })

  it('is idempotent for the Stop hook — does not duplicate on re-install', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertClaudeSettingsHooks(p, false)
    upsertClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.Stop![0]!.hooks.filter(h => h.command.includes('tc-stop')).length).toBe(1)
  })
})

describe('hookScriptContent for the Stop event (C4/AC4c)', () => {
  it('emits a script that dispatches `hook stop`', () => {
    const content = hookScriptContent('stop', false)
    expect(content).toContain('hook stop')
  })
})

describe('removeClaudeSettingsHooks', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes tc hooks and keeps others', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'other-tool' },
              { type: 'command', command: '/home/user/.claude/hooks/tc-session-reminder' },
            ],
          },
        ],
      },
    }))
    const r = removeClaudeSettingsHooks(p, false)
    expect(r).not.toBeNull()
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    expect(startup!.hooks.length).toBe(1)
    expect(startup!.hooks[0]!.command).toBe('other-tool')
  })

  it('removes empty matchers after tc hooks removed', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: '/path/tc-session-start' }] },
        ],
      },
    }))
    removeClaudeSettingsHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>
    expect(hooks.SessionStart).toBeUndefined()
  })

  it('removes legacy cbm-* hooks and cleans empty events', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Grep|Search', hooks: [{ type: 'command', command: '~/.claude/hooks/cbm-code-discovery-gate' }] },
        ],
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'other-tool' },
              { type: 'command', command: '~/.claude/hooks/cbm-session-reminder' },
              { type: 'command', command: '/home/user/.claude/hooks/tc-session-reminder' },
            ],
          },
        ],
      },
    }))
    const r = removeClaudeSettingsHooks(p, false)
    expect(r).not.toBeNull()
    const data = readJson(p)
    const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.PreToolUse).toBeUndefined()
    const startup = hooks.SessionStart!.find(m => m.matcher === 'startup')
    expect(startup!.hooks.length).toBe(1)
    expect(startup!.hooks[0]!.command).toBe('other-tool')
  })

  it('returns null when no tc hooks present', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'other' }] }] },
    }))
    expect(removeClaudeSettingsHooks(p, false)).toBeNull()
  })
})

describe('upsertGeminiHooks', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes the Claude Code block translated to Gemini event names (D154)', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    const r = upsertGeminiHooks(p, false)
    expect(r.status).toBe('updated')
    const hooks = readJson(p).hooks as Record<string, unknown[]>
    // Renamed events, the same entries: the copy runs the Claude Code hook
    // scripts, so PreCompress carries tc-pre-compact.
    expect(hooks).toEqual(translateHookBlockForGemini(claudeHooksBlock()))
    // No AfterAgent: Claude's Stop has no Gemini counterpart until a live
    // probe (D225).
    expect(Object.keys(hooks).sort()).toEqual(['AfterTool', 'BeforeAgent', 'PreCompress', 'SessionStart'])
    expect(JSON.stringify(hooks.PreCompress)).toContain('tc-pre-compact')
    expect(JSON.stringify(hooks.SessionStart)).toContain('tc-session-start')
  })

  it('does not duplicate when already present', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, '{}')
    upsertGeminiHooks(p, false)
    const once = readFileSync(p, 'utf8')
    expect(upsertGeminiHooks(p, false).status).toBe('skipped')
    expect(readFileSync(p, 'utf8')).toBe(once)
  })

  it('preserves existing hooks', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: { PreCompress: [{ hooks: [{ command: 'other-tool' }] }] },
    }))
    upsertGeminiHooks(p, false)
    const data = readJson(p)
    const hooks = data.hooks as Record<string, unknown[]>
    expect(hooks.PreCompress!.length).toBe(2)
  })

  it("a user command containing 'hook ' is neither claimed nor replaced", () => {
    // The ownership predicate once matched the bare substring 'hook ',
    // which claimed ANY user automation containing it: the foreign command
    // was silently overwritten with treecontext's entry, and its presence
    // also suppressed adding treecontext's own hook. Both halves of that
    // failure are asserted here.
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ command: 'my-tool hook sync' }] }] },
    }))
    upsertGeminiHooks(p, false)
    const hooks = readJson(p).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const commands = hooks.SessionStart!.flatMap(m => m.hooks.map(h => h.command))
    expect(commands).toContain('my-tool hook sync')
    expect(commands.some(c => c.includes('tc-session-start'))).toBe(true)
  })

  it('two legacy owned spellings under one event collapse to ONE current entry', () => {
    // A config that upgraded through several builds could hold both a
    // bare-node entry-point spelling and a `hook <event>` subcommand
    // spelling; rewriting each to the current entry without collapsing
    // fired the hook twice per event forever.
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ command: 'node "/old/dist/hooks/gemini/session-start.js"' }] },
          { hooks: [{ command: 'treecontext hook session-start' }] },
        ],
      },
    }))
    upsertGeminiHooks(p, false)
    const hooks = readJson(p).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const commands = hooks.SessionStart!.flatMap(m => m.hooks.map(h => h.command))
    // Both legacy spellings gone, and exactly the block's own entries left:
    // one session-start per matcher, never two.
    const block = translateHookBlockForGemini(claudeHooksBlock())
    expect(commands).toEqual(block['SessionStart']!.flatMap(m => m.hooks.map(h => h.command)))
    expect(commands.filter(c => c.includes('tc-session-start'))).toHaveLength(block['SessionStart']!.length)
  })

  it("a foreign entry with an empty hooks array survives every install", () => {
    // The compaction that follows an owned-command upgrade kept only entries
    // with a non-empty hooks array — so a user's `{"matcher":"git","hooks":[]}`
    // (and an entry carrying no hooks key at all) was deleted from their
    // settings on every single install, permanently and silently. Only what
    // THIS pass emptied is ours to drop.
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'git', hooks: [] },
          { matcher: 'lint' },
          { hooks: [{ command: 'treecontext hook session-start' }] },
        ],
      },
    }))
    upsertGeminiHooks(p, false)
    upsertGeminiHooks(p, false)

    const hooks = readJson(p).hooks as Record<string, Array<{ matcher?: string; hooks?: Array<{ command: string }> }>>
    const matchers = hooks.SessionStart!.map(m => m.matcher)
    expect(matchers, 'a foreign matcher was collateral of the owned-entry compaction')
      .toEqual(expect.arrayContaining(['git', 'lint']))
    // The owned entries are exactly the block's, the legacy one replaced.
    const owned = hooks.SessionStart!.flatMap(m => m.hooks ?? [])
      .filter(h => h.command.includes('tc-session-start'))
    expect(owned).toHaveLength(translateHookBlockForGemini(claudeHooksBlock())['SessionStart']!.length)
    expect(JSON.stringify(hooks)).not.toContain('treecontext hook session-start')
  })
})

describe('Codex CLI copy of the Claude Code block (D154, D208)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes the block verbatim under hooks, moves an earlier top-level copy out, keeps foreign keys and hooks', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      SomethingElse: { keep: true },
      // What builds before the copy wrote: wrapper entries at the top level.
      SessionStart: [{ hooks: [{ type: 'command', command: `"${join(homedir(), '.claude', 'hooks', 'tc-codex-session-start')}"` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] },
    }))
    expect(upsertCodexHooks(p, false, false).status).toBe('updated')
    const after = readJson(p) as Record<string, unknown> & { hooks: Record<string, unknown[]> }
    expect(after.SomethingElse).toEqual({ keep: true })
    expect(after.SessionStart, 'the earlier top-level copy survived').toBeUndefined()
    expect(after.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }])
    const block = claudeHooksBlock()
    for (const [event, matchers] of Object.entries(block)) {
      expect(after.hooks[event], event).toEqual(expect.arrayContaining(matchers))
    }
    expect(after.hooks.Stop![0]).toEqual({ hooks: [{ type: 'command', command: 'notify-me' }] })
    expect(upsertCodexHooks(p, false, false).status).toBe('skipped')
  })

  it('uninstall takes the copy and any earlier top-level copy, and nothing else', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/hooks/codex/session-start.js"' }] }],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] },
    }))
    upsertCodexHooks(p, false, false)
    expect(removeCodexHooks(p, false)).not.toBeNull()
    expect(readJson(p)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] } })
    expect(removeCodexHooks(p, false)).toBeNull()
  })
})

describe('translateHookBlockForGemini', () => {
  it("drops Claude's Windows shell key, which Gemini's hook entry does not have", () => {
    const out = translateHookBlockForGemini({
      PostToolUse: [{ hooks: [{ type: 'command', command: 'x', shell: 'powershell' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'y' }] }],
    })
    expect(out).toEqual({ AfterTool: [{ hooks: [{ type: 'command', command: 'x' }] }] })
  })
})

describe('parseJsonc (VS Code settings.json)', () => {
  it('reads comments and trailing commas, and leaves // inside strings alone', () => {
    const text = '// user settings\n{\n  /* font */ "editor.fontSize": 14,\n  "http.proxy": "http://example.com", // trailing\n  "chat.useClaudeHooks": true,\n  "list": [1, 2, /* x */ ],\n}\n'
    expect(parseJsonc(text)).toEqual({
      'editor.fontSize': 14, 'http.proxy': 'http://example.com', 'chat.useClaudeHooks': true, list: [1, 2],
    })
  })
  it('still refuses what is not JSON with comments', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow()
  })
})

describe('removeGeminiHooks', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('removes treecontext hook entries', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        PreCompress: [
          { hooks: [{ command: 'treecontext hook pre-compact' }] },
          { hooks: [{ command: 'other' }] },
        ],
      },
    }))
    const r = removeGeminiHooks(p, false)
    expect(r).not.toBeNull()
    const data = readJson(p)
    const hooks = data.hooks as Record<string, unknown[]>
    expect(hooks.PreCompress!.length).toBe(1)
  })

  it('returns null when no treecontext hooks', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: { PreCompress: [{ hooks: [{ command: 'other' }] }] },
    }))
    expect(removeGeminiHooks(p, false)).toBeNull()
  })
})

/**
 * Uninstall takes treecontext's entries out of a hooks-map config — and only
 * those. Both removers used to unlink the whole file, which for cursor
 * destroyed exactly what the install side goes out of its way to preserve:
 * upsertCursorHooks MERGES so foreign hooks survive, with a test asserting
 * 'somethingForeign' lives through an install, and then uninstall deleted it.
 */
describe('removeCursorHooks / removeVscodeHooks: owned entries only', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a foreign cursor hook survives install + uninstall', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      version: 1,
      hooks: { somethingForeign: [{ command: 'other-tool run' }] },
    }))
    upsertCursorHooks(p, false, false)
    const r = removeCursorHooks(p, false)

    expect(r).not.toBeNull()
    expect(existsSync(p), 'the file holding a foreign hook was deleted outright').toBe(true)
    const hooks = readJson(p).hooks as Record<string, Array<{ command: string }>>
    expect(hooks.somethingForeign![0]!.command).toBe('other-tool run')
    expect(JSON.stringify(hooks), 'an owned entry survived the removal').not.toContain('tc-cursor-')
    expect(hooks.sessionStart).toBeUndefined()
  })

  it('the cursor file goes entirely when only treecontext content was in it', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, '{}')
    upsertCursorHooks(p, false, false)
    expect(removeCursorHooks(p, false)).not.toBeNull()
    expect(existsSync(p), 'an empty husk was left for cursor to keep reading').toBe(false)
  })

  it('the copilot file goes entirely too — it is treecontext-owned in practice', () => {
    // Its entries carry the invocation under `bash`/`powershell` rather than
    // `command`, so ownership has to be read from those keys as well.
    const p = join(dir, 'treecontext.json')
    writeFileSync(p, '{}')
    upsertVscodeHooks(p, false, false)
    expect(removeVscodeHooks(p, false)).not.toBeNull()
    expect(existsSync(p)).toBe(false)
  })

  it('a hand-added copilot entry is not collateral', () => {
    const p = join(dir, 'treecontext.json')
    writeFileSync(p, '{}')
    upsertVscodeHooks(p, false, false)
    const seeded = readJson(p)
    const hooks = seeded.hooks as Record<string, unknown[]>
    hooks.sessionStart!.push({ type: 'command', bash: 'other-tool run', timeoutSec: 5 })
    writeFileSync(p, JSON.stringify(seeded))

    expect(removeVscodeHooks(p, false)).not.toBeNull()
    expect(existsSync(p)).toBe(true)
    const after = (readJson(p).hooks as Record<string, Array<{ bash?: string }>>)
    expect(after.sessionStart!.map(e => e.bash)).toEqual(['other-tool run'])
    expect(JSON.stringify(after)).not.toContain('tc-vscode-')
  })

  it("an old build's backslash-spelled entry is still ours to take", () => {
    // The windows-latest lane caught this live: a config written by an old
    // build (or by hand) spells the entry-point path with native backslashes
    // — `dist\hooks\vscode\session-start.js` — and the forward-slash
    // `hooks/vscode/` marker looked straight past it, so doctor's own
    // offered fix (`uninstall --agent vscode --hooks-only`) left the file
    // in place and the finding never cleared.
    const p = join(dir, 'treecontext.json')
    writeFileSync(p, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{
          type: 'command',
          bash: '"node" "C:\\old-build\\dist\\hooks\\vscode\\session-start.js"',
          powershell: '& "node" "C:\\old-build\\dist\\hooks\\vscode\\session-start.js"',
        }],
      },
    }))
    expect(removeVscodeHooks(p, false)).not.toBeNull()
    expect(existsSync(p), 'the backslash spelling was not recognized as owned').toBe(false)
  })

  it('returns null when nothing owned is present', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({ version: 1, hooks: { somethingForeign: [{ command: 'other-tool run' }] } }))
    expect(removeCursorHooks(p, false)).toBeNull()
    expect(existsSync(p)).toBe(true)
  })

  it('respects dry-run', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, '{}')
    upsertCursorHooks(p, false, false)
    const before = readFileSync(p, 'utf8')
    expect(removeCursorHooks(p, true)!.status).toBe('dry-run')
    expect(readFileSync(p, 'utf8')).toBe(before)
  })
})

/**
 * One event vocabulary for the builder and the grader. Doctor checked the
 * PascalCase Claude Code spellings against a config written in Copilot's
 * camelCase, so a healthy vscode install always graded 'hooks incomplete' and
 * the reinstall it offered changed nothing.
 */
describe('vscode hook events: builder and doctor read one table', () => {
  it('grades a freshly-built config as complete', () => {
    expect(vscodeHooksComplete(buildVscodeHooksConfig())).toBe(true)
  })

  it('still calls an incomplete config incomplete', () => {
    const config = buildVscodeHooksConfig()
    const hooks = config.hooks as Record<string, unknown>
    delete hooks.agentStop
    expect(vscodeHooksComplete(config)).toBe(false)
    expect(vscodeHooksComplete({})).toBe(false)
  })
})

describe('idempotent install + uninstall cycle', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('JSON: install → install → uninstall leaves clean config', () => {
    const p = join(dir, 'mcp.json')
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'keep' } } }))
    const entry = { command: 'treecontext', args: ['serve'] }

    upsertJsonMcp(p, 'mcpServers', entry, false, false)
    upsertJsonMcp(p, 'mcpServers', entry, false, false) // idempotent skip
    removeJsonMcp(p, 'mcpServers', false)

    const data = readJson(p)
    const servers = data.mcpServers as Record<string, unknown>
    expect(servers.treecontext).toBeUndefined()
    expect(servers.other).toEqual({ command: 'keep' })
  })

  it('TOML: install → install → uninstall leaves clean config', () => {
    const p = join(dir, 'config.toml')
    writeFileSync(p, '[mcp_servers.other]\ncommand = "keep"\n')
    const entry = { command: 'treecontext', args: ['serve'] }

    upsertTomlMcp(p, entry, false, false)
    upsertTomlMcp(p, entry, false, false) // idempotent skip
    removeTomlMcp(p, false)

    const data = parseToml(readFileSync(p, 'utf8')) as Record<string, unknown>
    const servers = data.mcp_servers as Record<string, unknown>
    expect(servers.treecontext).toBeUndefined()
    expect(servers.other).toBeDefined()
  })

  it('instructions: install → install → uninstall leaves clean file', () => {
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, '# My Agent\n\nCustom instructions.\n')

    upsertInstructions(p, false, false)
    upsertInstructions(p, false, false) // idempotent skip
    removeInstructions(p, false)

    const content = readFileSync(p, 'utf8')
    expect(content).not.toContain('treecontext')
    expect(content).toContain('# My Agent')
    expect(content).toContain('Custom instructions.')
  })
})

describe('agent registry', () => {
  it('has exactly the six live agents (archived five deleted 2026-08-12)', () => {
    expect(AGENTS.map(a => a.slug).sort()).toEqual(
      ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'vscode'])
  })

  it('all slugs are unique', () => {
    const slugs = AGENTS.map(a => a.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('every agent has at least one detect dir on linux', () => {
    for (const a of AGENTS) {
      expect(a.detectDirs.linux?.length).toBeGreaterThan(0)
    }
  })

  it('every agent has a config path on linux', () => {
    for (const a of AGENTS) {
      expect(getConfigPath(a, 'linux')).toBeTruthy()
    }
  })

  it('getAgent returns correct agent by slug', () => {
    expect(getAgent('claude')?.name).toBe('Claude Code')
    expect(getAgent('vscode')?.name).toBe('VS Code')
    expect(getAgent('codex')?.name).toBe('Codex CLI')
    expect(getAgent('opencode')?.name).toBe('OpenCode')
    expect(getAgent('nonexistent')).toBeUndefined()
  })

  it('Claude Code has hooks defined', () => {
    const claude = getAgent('claude')!
    expect(claude.hooks).toBeDefined()
    expect(claude.hooks!.events).toContain('SessionStart')
    expect(claude.hooks!.events).toContain('PreCompact')
  })

  it('Gemini CLI has hooks and instructions', () => {
    const gemini = getAgent('gemini')!
    expect(gemini.hooks).toBeDefined()
    expect(gemini.instructions).toBeDefined()
  })

  it('VS Code and Cursor have hooks (platform-specific formats)', () => {
    const vscode = getAgent('vscode')!
    expect(vscode.hooks).toBeDefined()
    expect(vscode.hooks!.format).toBe('vscode-hooks')
    const cursor = getAgent('cursor')!
    expect(cursor.hooks).toBeDefined()
    expect(cursor.hooks!.format).toBe('cursor-hooks')
  })

  it('the archived-build five stay deleted (0.1 charter cold-read)', () => {
    // Removed 2026-08-12: adapter builds retired with the tree era, no
    // tester ever ran one. An MCP stub with no capture story reads as a
    // promise this beta does not make.
    for (const slug of ['windsurf', 'antigravity', 'jetbrains', 'qwen', 'openclaw']) {
      expect(getAgent(slug), `${slug} returned from the archive`).toBeUndefined()
    }
  })

  it('configFormat matches expected per agent', () => {
    expect(getAgent('claude')!.configFormat).toBe('json-mcpServers')
    expect(getAgent('vscode')!.configFormat).toBe('json-servers')
    expect(getAgent('codex')!.configFormat).toBe('toml-codex')
    expect(getAgent('opencode')!.configFormat).toBe('json-opencode')
  })
})

describe('detectAgents', () => {
  it('returns empty array when no agent dirs exist', () => {
    const detected = detectAgents('linux')
    // We can't guarantee none are installed, but the function should not throw
    expect(Array.isArray(detected)).toBe(true)
  })
})

// ── Interpreter resolution ──

/**
 * Strip the quotes claudeHookCommand's bash form wraps a path in, refusing if
 * the shape is not what we assumed. Without the check a future change to that
 * form would have slice() silently eat real characters, and every fixture
 * built from it would test a path that does not exist — passing or failing for
 * a reason unrelated to the claim.
 */
function unquoteBashForm(command: string): string {
  if (!command.startsWith('"') || !command.endsWith('"') || command.length < 3) {
    throw new Error(`claudeHookCommand's bash form is no longer a single quoted path: ${command}`)
  }
  return command.slice(1, -1)
}

/**
 * An agent hook wrapper path as it appears once WRITTEN into a config.
 *
 * The bash form rewrites `\` to `/` on Windows on purpose: a quoted
 * backslash path survives as text but contains no '/', so the shell resolves
 * it as a command NAME against PATH instead of opening it — that rewrite is
 * the 0.0.14 fix, not an accident. Comparing a written command against a raw
 * agentHookWrapperPath therefore fails on Windows against a correct config.
 * Derived from claudeHookCommand so the rule keeps one definition.
 */
const writtenWrapper = (agent: keyof typeof AGENT_HOOK_WRAPPER_STEMS, stem: string): string =>
  unquoteBashForm(claudeHookCommand(agentHookWrapperPath(agent, stem), 'bash'))

/** Extract the interpreter token (first quoted or bare word) of a command string. */
function interpreterToken(command: string): string {
  // PowerShell needs its call operator before a quoted path (`& "C:\...\node.exe"`),
  // so skip it before reading the interpreter itself.
  const m = command.match(/^\s*(?:&\s*|exec\s+)?(?:"([^"]+)"|(\S+))/)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

/**
 * install and doctor must name the hook scripts identically.
 *
 * They did not. install appended `.cmd` on Windows; doctor's presence check
 * listed the six scripts extensionless. So every Windows install wrote six
 * working hooks and was then told "hooks missing", with an offered fix
 * (`install --force --agent claude`) that rewrote the same six files and left
 * the warning untouched — a loop with no exit. Same family as the 0.0.13
 * defect, inverted: there the hooks were dead and doctor said they were fine.
 *
 * These cases are PLATFORM-PARAMETERISED on purpose. The bug is invisible where
 * this suite usually runs — on POSIX the extension is '' and both spellings
 * agree — so a test that only exercises the host platform would have passed
 * throughout the entire time the defect was shipping.
 */
describe('hook script names: install and doctor agree (win32 .cmd)', () => {
  const stems = ['session-reminder', 'session-start', 'pre-compact', 'post-tool-use', 'user-prompt-submit', 'stop', 'subagent-start', 'subagent-stop']

  it('win32 names carry .cmd, posix names carry no extension', () => {
    const win = claudeHookScriptPaths('win32').map(p => basename(p))
    expect(win).toHaveLength(stems.length)
    expect(win.every(n => n.endsWith('.cmd')), `win32 hook names lost .cmd: ${win.join(', ')}`).toBe(true)
    expect(win.map(n => n.replace(/^tc-/, '').replace(/\.cmd$/, ''))).toEqual(stems)

    for (const p of ['linux', 'darwin'] as const) {
      const names = claudeHookScriptPaths(p).map(n => basename(n))
      expect(names.every(n => !n.includes('.')), `${p} hook names grew an extension: ${names.join(', ')}`).toBe(true)
      expect(names.map(n => n.replace(/^tc-/, ''))).toEqual(stems)
    }
  })

  it('what install writes is exactly what doctor looks for', () => {
    // The runtime half: on whatever platform this runs, the files that land on
    // disk are precisely the ones the presence check will go looking for.
    const home = mkdtempSync(join(tmpdir(), 'tc-hookname-home-'))
    const restore = redirectHome(home)
    try {
      installClaudeHookScripts(false)
      const written = readdirSync(join(home, '.claude', 'hooks'))
        .filter(f => f.startsWith('tc-') && !f.startsWith('tc-mcp-serve'))
        .sort()
      const expected = claudeHookScriptPaths().map(p => basename(p)).sort()
      expect(written, 'install wrote hook scripts doctor will not find').toEqual(expected)
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('interpreter resolution (AC1.1/AC1.2)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('mcpCommand and buildMcpEntry emit the absolute launcher path (never a bare/raw interpreter)', () => {
    const cmd = mcpCommand(false)
    expect(isAbsolute(cmd.command)).toBe(true)
    // The launcher is the ONLY interpreter reference in emitted MCP configs —
    // no bare `node`/`treecontext`, no version-stamped execPath that a node
    // upgrade would strand. (The launcher file itself is written by install;
    // its resolution logic is covered by the launcher-resolution tests below.)
    expect(cmd.command).toBe(mcpLauncherPath())

    for (const fmt of ['json-mcpServers', 'json-servers', 'json-opencode', 'toml-codex'] as const) {
      const entry = buildMcpEntry(makeAgent({ configFormat: fmt }), false)
      const tok = fmt === 'json-opencode'
        ? (entry.command as string[])[0]!
        : entry.command as string
      expect(isAbsolute(tok)).toBe(true)
      expect(tok).toBe(mcpLauncherPath())
    }
  })

  it('hook-settings builders emit only absolute wrapper paths that install actually writes', () => {
    // The builders now reference generated wrappers rather than inlining
    // `"<execPath>" "<entry.js>"` — two version-stamped halves one nvm
    // upgrade deletes together. HOME is sandboxed and the wrappers really
    // installed, so the existence assertion closes the loop between what
    // the configs reference and what install writes: a stem mismatch
    // between the builders and installAgentHookWrappers fails here.
    const home = mkdtempSync(join(tmpdir(), 'tc-wrap-home-'))
    const restore = redirectHome(home)
    try {
      for (const agent of Object.keys(AGENT_HOOK_WRAPPER_STEMS) as Array<keyof typeof AGENT_HOOK_WRAPPER_STEMS>) {
        installAgentHookWrappers(agent, false)
      }
      // The Codex and Gemini copies run the Claude Code hook scripts.
      installClaudeHookScripts(false)
      const configs: Record<string, unknown>[] = []

      const gp = join(dir, 'gemini.json')
      writeFileSync(gp, '{}')
      upsertGeminiHooks(gp, false)
      configs.push(readJson(gp))

      const vp = join(dir, 'vscode.json')
      upsertVscodeHooks(vp, false, false)
      configs.push(readJson(vp))

      const cp = join(dir, 'codex.json')
      upsertCodexHooks(cp, false, false)
      configs.push(readJson(cp))

      const up = join(dir, 'cursor.json')
      upsertCursorHooks(up, false, false)
      configs.push(readJson(up))

      const commands: string[] = []
      const collect = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(collect)
        else if (v && typeof v === 'object') {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            // Copilot's schema carries the invocation in `bash`/`powershell`
            // rather than `command`; all three must name a real target.
            if ((k === 'command' || k === 'bash' || k === 'powershell') && typeof val === 'string') commands.push(val)
            else collect(val)
          }
        }
      }
      configs.forEach(collect)

      expect(commands.length).toBeGreaterThanOrEqual(22) // gemini/codex: the Claude block's 12 commands each; cursor: 4; copilot: 5 events × 2 shells
      for (const c of commands) {
        const tok = interpreterToken(c)
        expect(tok, c).not.toBe('node')
        expect(tok, c).not.toBe('treecontext')
        expect(tok, c).not.toBe(process.execPath)
        expect(isAbsolute(tok), c).toBe(true)
        expect(existsSync(tok), c).toBe(true)
      }
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hook script bodies never invoke bare node (win + posix forms)', () => {
    // The claim is a PROPERTY of the script — it never leaves the interpreter
    // to PATH — not the shape of either branch. Both dialects now pin the same
    // way, so it is checkable without knowing which one is in hand.
    //
    // This used to assert `toContain(process.execPath)`, which was only ever
    // right by accident: execPath is what the Windows branch hardcoded, and on
    // POSIX it happened to be what the probe verified. A machine where the
    // verified interpreter is NOT the one running the tests would have failed
    // it against a perfectly correct script.
    const body = hookScriptContent('post-tool-use')
    expect(body).not.toMatch(/(?:^|\r?\n)(?:TREECONTEXT_DEBUG=1 )?(?:exec )?node[ "]/)
    const pinned = launcherInterpreter(body)
    expect(pinned, 'the script must name a concrete interpreter, not a bare name').toBeTruthy()
    expect(isAbsolute(pinned!)).toBe(true)
    expect(existsSync(pinned!)).toBe(true)
  })

  // The companion claim to the one above, and the one that was missing while
  // an nvm v24.18→v24.20 bump took every wrapper on a machine down at once:
  // resolving the interpreter at runtime buys nothing if the MODULE beside it
  // is a version-stamped path into the directory that upgrade just deleted.
  it.each(['mcp launcher', 'hook'])('the %s body reaches cli.js through a variable, never inlined', which => {
    const body = which === 'hook' ? hookScriptContent('post-tool-use') : mcpLauncherScriptContent()
    const pinned = launcherCliPath(body)
    expect(pinned, 'the body must pin a concrete module path').toBeTruthy()
    expect(isAbsolute(pinned!)).toBe(true)

    // The invocation must name the variable. Asserting only that TC_CLI is
    // ASSIGNED would pass a body that assigns it and then execs the literal
    // anyway, which is the pre-fix shape wearing the fix's clothes.
    if (process.platform === 'win32') {
      expect(body).toContain('"%TC_NODE%" "%TC_CLI%"')
    } else {
      expect(body).toMatch(/exec "\$TC_NODE" "\$TC_CLI"/)
    }
  })

  // The exit-status guarantee, which the hook scripts did not keep.
  //
  // Ruling 2026-08-15: a hook NEVER exits non-zero. The CLI honours it from
  // the inside for every failure after it loads; the ones it cannot answer for
  // are failing to load at all (a dead TC_CLI pin whose fallback search comes
  // up empty exits MODULE_NOT_FOUND) and an interpreter that will not execute
  // (126/127) — and `exec` puts both beyond the reach of the trailing
  // `exit 0`, having already replaced the shell. So the resolution is checked
  // BEFORE the exec. Dropping exec instead is NOT available: node's ppid must
  // stay the claude pid, which is the session beacon's key
  // (docs/session-identity.md §3, rung 1).
  it('guards the exec so a failed resolution exits 0, and keeps exec for the beacon', () => {
    const body = hookScriptContent('post-tool-use')
    if (process.platform === 'win32') {
      expect(body).toContain('"%TC_NODE%" "%TC_CLI%"')
      expect(body).toContain('exit /b 0')
      return
    }
    expect(body).toContain('[ -x "$TC_NODE" ] && [ -f "$TC_CLI" ] || exit 0\n')
    const lines = body.split('\n')
    expect(lines.findIndex(l => l.startsWith('[ -x "$TC_NODE" ] && [ -f "$TC_CLI" ]')))
      .toBeLessThan(lines.findIndex(l => l.includes('exec "$TC_NODE"')))
    // The launcher keeps its own exec for the same ppid reason, and needs no
    // guard: it does not run under a host that reads exit codes as consent.
    expect(mcpLauncherScriptContent()).toMatch(/exec "\$TC_NODE" "\$TC_CLI"/)
  })
})

/**
 * Blank out the interpreter `install` pinned after verifying it can load the
 * native binding, so the wrapper's runtime discovery chain is what executes.
 *
 * That chain is the upgrade-survival path: it runs when the pinned node no
 * longer exists — exactly what an nvm version bump does when it deletes the
 * old version directory. The tests below are about that path, so they have to
 * put the wrapper in that state first.
 */
function withPinnedInterpreterMissing(body: string): string {
  return body.replace(/^TC_NODE="[^"]*"/m, 'TC_NODE="/nonexistent/tc-pinned/node"')
}

/**
 * The resolver prepends two absolute prefixes before consulting PATH, and a
 * test cannot make `/usr/local/bin/node` not exist. On this developer's box
 * neither prefix holds a node, so "node is nowhere on PATH" was true by
 * accident; on a GitHub runner `/usr/local/bin/node` is always there, so the
 * same tests resolved to it and failed. That is why they were green locally
 * and red in CI from the very first run.
 *
 * So the prefixes are redirected into the test's own sandbox, which makes the
 * environment something the test actually controls. The literal is asserted
 * before it is rewritten: if the shipped line ever changes shape, the redirect
 * fails loudly rather than silently landing nowhere and testing nothing.
 */
const WELL_KNOWN_PREFIX_LINE = 'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"'

function withWellKnownPrefixesRedirected(body: string, sandbox: string): string {
  expect(body, 'the well-known prefix line changed shape — this redirect no longer lands')
    .toContain(WELL_KNOWN_PREFIX_LINE)
  const empty = join(sandbox, 'no-system-node')
  mkdirSync(empty, { recursive: true })
  return body.replace(WELL_KNOWN_PREFIX_LINE, `PATH="${empty}:$PATH"`)
}

// POSIX by construction: these drive the emitted shell script through a real
// bash under `env -i`. Windows ships .cmd hooks resolved a different way, so
// there is nothing here for that platform to answer — which is a different
// thing from the tests being unable to run there, and is why the skip is
// named rather than left to a silently absent /bin/bash.
describe.skipIf(process.platform === 'win32')('POSIX hook script interpreter resolution (AC1.3)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /**
   * Build a probe from the real script: keep the resolver preamble verbatim,
   * replace the exec line with an echo, and run it under a controlled
   * environment. `home` is always passed explicitly — an unset HOME makes the
   * nvm glob expand against `/`, which is a different test than the one
   * whose name is on the tin.
   */
  /**
   * Everything the script does BEFORE it dispatches — the resolution chain,
   * stopping short of the exit-status guard as well as the exec. The guard
   * ends the script when TC_CLI names nothing, and under vitest the product
   * runs from source, where the baked `src/server/cli.js` has no built twin: a
   * probe that kept the guard would exit 0 having echoed nothing, and every
   * case below would fail for a reason none of them is about.
   */
  function resolutionPreamble(body: string): string[] {
    const lines = body.split('\n')
    const idx = lines.findIndex(l =>
      l.startsWith('[ -x "$TC_NODE" ] && [ -f "$TC_CLI" ]') || l.includes('exec "$TC_NODE"'))
    expect(idx).toBeGreaterThan(0)
    return lines.slice(0, idx)
  }

  function probeResolvedNode(
    envPath: string,
    opts: { pinnedMissing?: boolean; home?: string; name?: string } = {},
  ): string {
    const raw = opts.pinnedMissing
      ? withPinnedInterpreterMissing(hookScriptContent('post-tool-use'))
      : hookScriptContent('post-tool-use')
    const probe = [
      ...resolutionPreamble(withWellKnownPrefixesRedirected(raw, dir)),
      'echo "$TC_NODE"',
      '"$TC_NODE" -e "process.exit(0)" || exit 9',
    ].join('\n')
    const p = join(dir, `${opts.name ?? 'probe'}.sh`)
    writeFileSync(p, probe, { mode: 0o755 })
    const home = opts.home ?? join(dir, 'empty-home')
    mkdirSync(home, { recursive: true })
    return execSync(`env -i PATH=${envPath} HOME="${home}" /bin/bash "${p}"`, { encoding: 'utf8' }).trim()
  }

  /**
   * Drive the emitted TC_CLI chain with the baked path pointing nowhere — the
   * state an `nvm install` leaves behind when it deletes the version directory
   * the module lived under. A global install is seeded inside the sandbox HOME
   * so the glob has something real to find.
   *
   * The assertion is that TC_CLI lands on a file that EXISTS, not on one exact
   * path: /usr/local and /opt/homebrew are in the search list and no test can
   * make them not exist on a runner. Pinning the exact winner would be a test
   * of the developer's machine layout; "it resolved to a real module instead
   * of a stranded one" is the property the wrapper actually promises.
   */
  function probeResolvedCli(
    seedVersion = 'v99.0.0',
    pkgDir = 'treecontext-mcp',
    homeName = 'cli-home',
  ): { resolved: string; stranded: string; seededCli: string } {
    const home = join(dir, homeName)
    const seeded = join(home, '.nvm', 'versions', 'node', seedVersion,
      'lib', 'node_modules', pkgDir, 'dist', 'server')
    mkdirSync(seeded, { recursive: true })
    writeFileSync(join(seeded, 'cli.js'), '// seeded global install\n')

    const raw = hookScriptContent('post-tool-use')
    const stranded = '/nonexistent/tc-pinned/dist/server/cli.js'
    expect(raw, 'the TC_CLI pin changed shape — this probe no longer lands').toMatch(/^TC_CLI="/m)
    const body = raw.replace(/^TC_CLI="[^"]*"/m, `TC_CLI="${stranded}"`)

    const probe = [...resolutionPreamble(body), 'echo "$TC_CLI"'].join('\n')
    const p = join(dir, 'cli-probe.sh')
    writeFileSync(p, probe, { mode: 0o755 })
    const resolved = execSync(`env -i PATH=/usr/bin:/bin HOME="${home}" /bin/bash "${p}"`, { encoding: 'utf8' }).trim()
    return { resolved, stranded, seededCli: join(seeded, 'cli.js') }
  }

  it('recovers the module when the baked cli.js path is deleted out from under it', () => {
    const { resolved, stranded } = probeResolvedCli()
    expect(resolved, 'the stranded pin must not survive the search').not.toBe(stranded)
    expect(existsSync(resolved)).toBe(true)
  })

  it('recovers onto a treecontext-mcp copy, the published package name', () => {
    // The current-name version-manager globs are the last in the loop, so a
    // seeded copy there is the winner whatever the system prefixes hold.
    const { resolved, seededCli } = probeResolvedCli('v99.0.0', 'treecontext-mcp', 'cli-home-current')
    expect(resolved).toBe(seededCli)
  })

  it('still recovers onto a legacy treecontext copy, as every release candidate installed', () => {
    const { resolved, stranded, seededCli } = probeResolvedCli('v99.0.0', 'treecontext', 'cli-home-legacy')
    expect(resolved).not.toBe(stranded)
    // A current-name copy in a system prefix outranks the legacy one by
    // design; only where there is none is the legacy seed the exact winner.
    const systemCurrent = ['/opt/homebrew', '/usr/local'].some(p =>
      existsSync(join(p, 'lib', 'node_modules', 'treecontext-mcp', 'dist', 'server', 'cli.js')))
    if (systemCurrent) expect(existsSync(resolved)).toBe(true)
    else expect(resolved).toBe(seededCli)
  })

  it('prefers the treecontext-mcp copy when both names survive', () => {
    // v99 (legacy) sorts after v10 (current): version order alone would pick
    // the legacy copy. The package name is the outer key.
    probeResolvedCli('v99.0.0', 'treecontext', 'cli-home-both')
    const { resolved, seededCli } = probeResolvedCli('v10.0.0', 'treecontext-mcp', 'cli-home-both')
    expect(resolved).toBe(seededCli)
  })

  it('exits 0 when the module is gone and the search finds nothing', () => {
    // Ruling 2026-08-15: a hook NEVER exits non-zero. The CLI honours that
    // from the inside, but the failure it cannot answer for is failing to
    // LOAD — and `exec` had already replaced the shell, so node's
    // MODULE_NOT_FOUND status went straight to Claude Code and the trailing
    // `exit 0` never ran. Driven through a real bash, with both the pin and
    // the search neutralised, because the claim is about what the script DOES.
    const raw = hookScriptContent('post-tool-use')
    expect(raw, 'the TC_CLI pin changed shape — this probe no longer lands').toMatch(/^TC_CLI="/m)
    expect(raw, 'the TC_CLI search changed shape — this probe no longer lands').toMatch(/for _c in \S/)
    const body = raw
      .replace(/^TC_CLI="[^"]*"/m, 'TC_CLI="/nonexistent/tc-pinned/dist/server/cli.js"')
      .replace(/for _c in [^;]+;/, 'for _c in /nonexistent/tc-search/*.js;')

    const home = join(dir, 'exit-home')
    mkdirSync(home, { recursive: true })
    const run = (script: string, name: string): number | null => {
      const p = join(dir, name)
      writeFileSync(p, script, { mode: 0o755 })
      return spawnSync('/bin/bash', [p], {
        env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
      }).status
    }

    expect(run(body, 'exit-ok.sh'), 'a hook handed its host a non-zero status').toBe(0)
    // And the guard is load-bearing, not incidental: take that one line out
    // and the same script reports the MODULE_NOT_FOUND it was swallowing —
    // which is exactly what the host used to see.
    const unguarded = body.replace(/\n\[ -x "\$TC_NODE" \] && \[ -f "\$TC_CLI" \][^\n]*\n/, '\n')
    expect(unguarded, 'the guard line was not the one removed').not.toBe(body)
    expect(run(unguarded, 'exit-unguarded.sh'),
      'the dispatch did not actually fail — this probe proves nothing').not.toBe(0)
  })

  it('prepends the well-known interpreter prefixes ahead of PATH', () => {
    // Pinned separately from the tests that redirect it, so the redirect can
    // never quietly stop matching the thing it is supposed to neutralise.
    expect(hookScriptContent('post-tool-use')).toContain(WELL_KNOWN_PREFIX_LINE)
    expect(mcpLauncherScriptContent()).toContain(WELL_KNOWN_PREFIX_LINE)
  })

  it('resolves a working interpreter under a launchd-like PATH', () => {
    const resolved = probeResolvedNode('/usr/bin:/bin')
    expect(isAbsolute(resolved)).toBe(true)
    expect(existsSync(resolved)).toBe(true)
  })

  it('falls back to the embedded execPath when node is nowhere on PATH', () => {
    // Nothing on PATH, no system node at the well-known prefixes, no nvm
    // install in HOME: the embedded fallback is the only thing left, so this
    // asserts it exactly rather than accepting whatever the host happened to
    // have lying around.
    const resolved = probeResolvedNode('/nonexistent-tc-test', { pinnedMissing: true, name: 'probe-fallback' })
    expect(resolved).toBe(process.execPath)
    expect(existsSync(resolved)).toBe(true)
  })

  it('resolves node via the nvm/fnm glob when it is off PATH (upgrade-survivable)', () => {
    // Regression: a hardcoded version-stamped fallback is stranded when the
    // version manager upgrades node and removes the old dir. The glob must
    // discover whatever nvm/fnm currently has installed, without PATH help.
    const home = join(dir, 'home')
    const nvmBin = join(home, '.nvm/versions/node/v99.0.0/bin')
    mkdirSync(nvmBin, { recursive: true })
    const nvmNode = join(nvmBin, 'node')
    symlinkSync(process.execPath, nvmNode)

    const resolved = probeResolvedNode('/nonexistent-tc-test', {
      pinnedMissing: true, home, name: 'probe-nvm',
    })
    expect(resolved).toBe(nvmNode)
  })

  it('picks the newest node when the glob matches multiple versions', () => {
    const home = join(dir, 'home-multi')
    for (const v of ['v18.20.0', 'v20.11.0', 'v24.18.0']) {
      const bin = join(home, `.nvm/versions/node/${v}/bin`)
      mkdirSync(bin, { recursive: true })
      symlinkSync(process.execPath, join(bin, 'node'))
    }
    const resolved = probeResolvedNode('/nonexistent-tc-test', {
      pinnedMissing: true, home, name: 'probe-multi',
    })
    // Shell glob expands lexically ascending; last-wins in the loop yields newest.
    expect(resolved).toBe(join(home, '.nvm/versions/node/v24.18.0/bin/node'))
  })
})

describe('MCP launcher wrapper (upgrade-survivable stdio launch)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-mcp-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('never invokes bare node and execs the baked cli.js with forwarded args', () => {
    const body = mcpLauncherScriptContent()
    // No bare-node invocation (the exact regression class the wrapper prevents).
    expect(body).not.toMatch(/(?:^|\n)(?:exec )?node "/)
    if (process.platform === 'win32') {
      // The .cmd runs whatever the shared snippet resolved, and forwards MCP
      // args via %*. stderr stays unsuppressed for the same reason as POSIX.
      expect(body).toContain('"%TC_NODE%"')
      expect(body).toContain('%*')
      expect(body).not.toContain('2>nul')
    } else {
      // Reuses the shared resolver, then forwards MCP args via "$@".
      expect(body).toContain('exec "$TC_NODE"')
      expect(body).toContain('"$@"')
      // stderr must NOT be suppressed — swallowing it hid the original 127.
      expect(body).not.toContain('2>/dev/null')
    }
  })

  it('pins an interpreter proven to load the native binding, ahead of PATH', () => {
    // Runs on Windows now. It used to `return` early there — an invisible pass
    // that reported coverage of the claim on the one platform that did not
    // satisfy it: the .cmd asked PATH first and pinned an unverified execPath
    // behind it. Both dialects answer this test today.
    const body = mcpLauncherScriptContent()
    const pinned = launcherInterpreter(body)

    expect(pinned, 'wrapper should pin a verified interpreter').toBeTruthy()
    expect(isAbsolute(pinned!)).toBe(true)
    expect(existsSync(pinned!)).toBe(true)

    // Ahead of the PATH lookup: "first node on PATH" is a different question
    // from "a node this package works under". A Mac with Homebrew node 26 in
    // front answers the first one wrong, and the hooks then fail silently.
    const pathLookup = process.platform === 'win32' ? 'set "TC_NODE=node"' : 'command -v node'
    expect(body.indexOf(pinned!)).toBeLessThan(body.indexOf(pathLookup))

    // And it must genuinely load the binding — the point of the probe.
    const binding = createRequire(import.meta.url).resolve('better-sqlite3')
    expect(() => execFileSync(pinned!, ['-e', `require(${JSON.stringify(binding)})`], {
      stdio: 'ignore', timeout: 20_000,
    })).not.toThrow()
  }, 60_000)

  // itPosix, not an `if (win32) return`: this drives the emitted script through
  // a real bash under `env -i` and symlinks an nvm layout Windows does not use,
  // so it genuinely has nothing to answer there. Saying so with a skip keeps it
  // in the skip count instead of reporting a silent pass — the difference that
  // let three unexamined win32 gates read as coverage for five releases.
  itPosix('resolves node via the nvm glob when off PATH (survives a version bump)', () => {
    const home = join(dir, 'home')
    const nvmBin = join(home, '.nvm/versions/node/v99.0.0/bin')
    mkdirSync(nvmBin, { recursive: true })
    const nvmNode = join(nvmBin, 'node')
    symlinkSync(process.execPath, nvmNode)

    const lines = withWellKnownPrefixesRedirected(
      withPinnedInterpreterMissing(mcpLauncherScriptContent()), dir,
    ).split('\n')
    const execIdx = lines.findIndex(l => l.includes('exec "$TC_NODE"'))
    expect(execIdx).toBeGreaterThan(0)
    const probe = [
      ...lines.slice(0, execIdx),
      'echo "$TC_NODE"',
      '"$TC_NODE" -e "process.exit(0)" || exit 9',
    ].join('\n')
    const p = join(dir, 'probe-mcp.sh')
    writeFileSync(p, probe, { mode: 0o755 })
    const resolved = execSync(`env -i PATH=/nonexistent-tc-test HOME="${home}" /bin/bash "${p}"`, { encoding: 'utf8' }).trim()
    expect(resolved).toBe(nvmNode)
  })

  it('the emitted MCP command points at the launcher basename', () => {
    expect(mcpLauncherPath().endsWith('tc-mcp-serve') || mcpLauncherPath().endsWith('tc-mcp-serve.cmd')).toBe(true)
    expect(mcpCommand(false).command).toBe(mcpLauncherPath())
  })
})

describe('legacy bare-node config convergence (AC1.5)', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-inst-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('gemini: legacy bare-node hook commands are upgraded in place', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/gemini/session-start.js"' }] }],
      },
    }))
    upsertGeminiHooks(p, false)
    const after = readJson(p)
    const json = JSON.stringify(after)
    expect(json).not.toContain('node \\"/old/')
    const hooks = after.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    // Replaced by the copy of the Claude Code block, entry for entry: no
    // duplicate beside it.
    expect(hooks.SessionStart).toEqual(translateHookBlockForGemini(claudeHooksBlock())['SessionStart'])
    // idempotent: second run leaves content unchanged
    const snapshot = readFileSync(p, 'utf8')
    upsertGeminiHooks(p, false)
    expect(readFileSync(p, 'utf8')).toBe(snapshot)
  })

  it('vscode: legacy bare-node config is updated, then skipped', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ type: 'command', command: 'node "/old/hooks/vscode/session-start.js"', timeout: 10 }] },
    }))
    const r1 = upsertVscodeHooks(p, false, false)
    expect(r1.status).toBe('updated')
    expect(JSON.stringify(readJson(p))).not.toContain('node \\"')
    const r2 = upsertVscodeHooks(p, false, false)
    expect(r2.status).toBe('skipped')
  })

  it('codex: legacy bare-node config is updated, preserving foreign keys, then skipped', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      SomethingElse: { keep: true },
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/hooks/codex/session-start.js"' }] }],
    }))
    const r1 = upsertCodexHooks(p, false, false)
    expect(r1.status).toBe('updated')
    const after = readJson(p)
    expect(after.SomethingElse).toEqual({ keep: true })
    expect(JSON.stringify(after)).not.toContain('node \\"')
    const r2 = upsertCodexHooks(p, false, false)
    expect(r2.status).toBe('skipped')
  })

  it('cursor: legacy bare-node config is updated, preserving foreign hooks, then skipped', () => {
    const p = join(dir, 'hooks.json')
    writeFileSync(p, JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: 'node "/old/hooks/cursor/session-start.js"' }],
        somethingForeign: [{ command: 'other-tool run' }],
      },
    }))
    const r1 = upsertCursorHooks(p, false, false)
    expect(r1.status).toBe('updated')
    const after = readJson(p)
    const hooks = after.hooks as Record<string, Array<{ command: string }>>
    expect(hooks.somethingForeign![0]!.command).toBe('other-tool run')
    expect(interpreterToken(hooks.sessionStart![0]!.command)).toBe(writtenWrapper('cursor', 'session-start'))
    const r2 = upsertCursorHooks(p, false, false)
    expect(r2.status).toBe('skipped')
  })
})

/**
 * Agent hook wrappers: the four agents whose configs once carried
 * `"<execPath>" "<entry.js>"` verbatim — BOTH halves version-stamped for a
 * global install, so the same nvm upgrade that motivated the TC_CLI fallback
 * stranded these four and their interpreter in one stroke, with no chain to
 * survive on. The wrappers must carry the full resolution machinery, and the
 * stems must name entry points that actually exist.
 */
describe('agent hook wrappers (gemini/vscode/codex/cursor)', () => {
  const combos = (Object.entries(AGENT_HOOK_WRAPPER_STEMS) as Array<
    [keyof typeof AGENT_HOOK_WRAPPER_STEMS, readonly string[]]
  >).flatMap(([agent, stems]) => stems.map(stem => [agent, stem] as [keyof typeof AGENT_HOOK_WRAPPER_STEMS, string]))

  it.each(combos)('%s/%s: pins TC_NODE and TC_CLI, dispatches through the variables', (agent, stem) => {
    const body = agentHookWrapperContent(agent, stem)

    // Read the pin with the product's own parser, so a shape drift that
    // blinds doctor fails here too.
    const pinnedCli = launcherCliPath(body)
    expect(pinnedCli, 'the wrapper must pin a concrete module path').toBeTruthy()
    expect(isAbsolute(pinnedCli!)).toBe(true)
    expect(pinnedCli!.replace(/\\/g, '/')).toContain(`hooks/${agent}/${stem}.js`)

    // The fallback search must be re-rooted at THIS entry point — a wrapper
    // whose glob still hunts for cli.js would "recover" by execing the MCP
    // server as a hook.
    expect(body.replace(/\\/g, '/')).toContain(`node_modules/treecontext/dist/hooks/${agent}/${stem}.js`)

    // The invocation must name the variables — the same assertion the
    // claude-hook test makes, for the same pre-fix-shape reason — and must
    // NOT exec: the exit-0 line after it is what keeps a stranded install
    // from handing exit-code-sensitive hosts a 126/127.
    if (process.platform === 'win32') {
      expect(body).toContain('"%TC_NODE%" "%TC_CLI%"')
      expect(body).toContain('exit /b 0')
    } else {
      expect(body).toMatch(/^"\$TC_NODE" "\$TC_CLI"/m)
      expect(body).not.toContain('exec ')
      expect(body).toMatch(/\nexit 0\n/)
    }

    // Healthy under the product's grader: the fallback is present, so a
    // stale pin is recoverable, not reportable.
    expect(hookScriptIssue(body)).toBeNull()
  })

  it.each(combos)('%s/%s: the stem names a real entry point', (agent, stem) => {
    // The wrapper dispatches to dist/hooks/<agent>/<stem>.js, which a build
    // emits exactly when src/hooks/<agent>/<stem>.ts exists. A stem typo in
    // AGENT_HOOK_WRAPPER_STEMS would otherwise ship a wrapper aimed at
    // nothing, and nothing else in this suite would notice.
    const src = fileURLToPath(new URL(`../../src/hooks/${agent}/${stem}.ts`, import.meta.url))
    expect(existsSync(src), src).toBe(true)
  })

  it('install writes exactly the wrappers the stems declare, tc-prefixed for the uninstall sweep', () => {
    const home = mkdtempSync(join(tmpdir(), 'tc-agent-wrap-'))
    const restore = redirectHome(home)
    try {
      for (const agent of Object.keys(AGENT_HOOK_WRAPPER_STEMS) as Array<keyof typeof AGENT_HOOK_WRAPPER_STEMS>) {
        installAgentHookWrappers(agent, false)
      }
      const written = readdirSync(join(home, '.claude', 'hooks')).sort()
      const expected = combos.map(([a, s]) => basename(agentHookWrapperPath(a, s))).sort()
      expect(written).toEqual(expected)
      expect(written.every(n => n.startsWith('tc-'))).toBe(true)
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("uninstalling claude spares the other agents' wrappers; each agent's removal takes exactly its own", () => {
    // The coupling that shipped broken in the first draft of this change:
    // `uninstall claude` swept every tc-* file, deleting wrappers a
    // still-installed gemini config referenced — a working config aimed at
    // nothing, the F1-defect shape. And no agent's own uninstall removed
    // its wrappers at all.
    const home = mkdtempSync(join(tmpdir(), 'tc-agent-unwrap-'))
    const restore = redirectHome(home)
    try {
      installClaudeHookScripts(false)
      installAgentHookWrappers('gemini', false)
      installAgentHookWrappers('cursor', false)
      const hooksDir = join(home, '.claude', 'hooks')

      removeClaudeHookScripts(false)
      const afterClaude = readdirSync(hooksDir).sort()
      const geminiSet = AGENT_HOOK_WRAPPER_STEMS.gemini.map(s => basename(agentHookWrapperPath('gemini', s)))
      const cursorSet = AGENT_HOOK_WRAPPER_STEMS.cursor.map(s => basename(agentHookWrapperPath('cursor', s)))
      expect(afterClaude).toEqual([...geminiSet, ...cursorSet].sort())

      removeAgentHookWrappers('gemini', false)
      expect(readdirSync(hooksDir).sort()).toEqual([...cursorSet].sort())
      removeAgentHookWrappers('cursor', false)
      expect(readdirSync(hooksDir)).toEqual([])
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a wrapper the config references but which is missing from disk is reported', () => {
    // Absence used to be waved through here on the claim that the
    // config-command grading catches it. It did not: that grading walked
    // `command` keys only, while the Copilot config carries the invocation
    // under `bash`/`powershell` — so a deleted tc-vscode-* wrapper was
    // invisible from both sides at once and capture died in silence.
    const home = mkdtempSync(join(tmpdir(), 'tc-wrap-missing-'))
    const restore = redirectHome(home)
    try {
      const config = buildVscodeHooksConfig()
      const referenced = JSON.stringify(config).match(/"([^"]*tc-vscode-[^"]*)"/g)!
        .map(s => s.slice(1, -1))
      expect(referenced.length, 'the built config names no wrapper').toBeGreaterThan(0)

      // Nothing installed yet: every wrapper the config names is absent.
      expect(agentHookWrapperIssue('vscode', referenced))
        .toContain('missing from disk')
      // A config that references nothing is not judged — an agent installed
      // without --experimental-capture legitimately has no wrappers.
      expect(agentHookWrapperIssue('vscode', [])).toBeNull()

      installAgentHookWrappers('vscode', false)
      expect(agentHookWrapperIssue('vscode', referenced)).toBeNull()
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('treecontext-reference skill (AC3.3/AC3.4)', () => {
  let dir: string
  let restoreHome: () => void

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-skill-home-'))
    // Not process.env.HOME alone: installClaudeSkill resolves through
    // os.homedir(), which ignores HOME on Windows. A HOME-only redirect made
    // these four cases install into — and then delete — the runner's real
    // ~/.claude/skills/treecontext-reference while asserting about `dir`.
    restoreHome = redirectHome(dir)
  })
  afterEach(() => {
    restoreHome()
    rmSync(dir, { recursive: true, force: true })
  })

  const skillPath = (): string => join(dir, '.claude', 'skills', SKILL_REFERENCE_NAME, 'SKILL.md')

  it('install writes SKILL.md; re-run skips; uninstall removes the directory', () => {
    const r1 = installClaudeSkill(false)
    expect(r1.status).toBe('created')
    expect(existsSync(skillPath())).toBe(true)

    const r2 = installClaudeSkill(false)
    expect(r2.status).toBe('skipped')

    const r3 = removeClaudeSkill(false)
    expect(r3).not.toBeNull()
    expect(r3!.status).toBe('updated')
    expect(existsSync(join(dir, '.claude', 'skills', SKILL_REFERENCE_NAME))).toBe(false)
  })

  it('updates an outdated skill file in place', () => {
    installClaudeSkill(false)
    writeFileSync(skillPath(), '---\nname: treecontext-reference\ndescription: old\n---\nold body\n')
    const r = installClaudeSkill(false)
    expect(r.status).toBe('updated')
    expect(readFileSync(skillPath(), 'utf8')).toBe(skillFileContent())
  })

  it('respects dry-run', () => {
    const r = installClaudeSkill(true)
    expect(r.status).toBe('dry-run')
    expect(existsSync(skillPath())).toBe(false)
  })

  it('remove returns null when never installed', () => {
    expect(removeClaudeSkill(false)).toBeNull()
  })

  it('frontmatter is valid: name matches directory, description has trigger phrases (AC3.4)', () => {
    const content = skillFileContent()
    const fm = content.match(/^---\n([\s\S]*?)\n---\n/)
    expect(fm).not.toBeNull()
    expect(fm![1]).toContain(`name: ${SKILL_REFERENCE_NAME}`)
    const desc = fm![1]!.match(/^description: (.+)$/m)?.[1]
    expect(desc).toBeTruthy()
    expect(desc!.length).toBeGreaterThan(0)
    expect(desc!.length).toBeLessThanOrEqual(1024)
    // concrete trigger phrases, not generic filler
    expect(desc).toMatch(/query/i)
    expect(desc).toMatch(/temporal|time/i)
    expect(desc).toMatch(/media|summar/i)
    // single-line description (frontmatter-safe)
    expect(desc).not.toContain('\n')
  })
})

describe('interpreterIssue (AC1.4 detection)', () => {
  it('flags bare node and bare treecontext', () => {
    expect(interpreterIssue('node "/x/hook.js"')).toContain("bare 'node'")
    // D251: the `exec` of a written hook command is stripped before the
    // interpreter token is read, so a vanished target is still named.
    expect(interpreterIssue('exec "/gone/x"')).toContain('interpreter missing: /gone/x')
    expect(interpreterIssue('node')).toContain("bare 'node'")
    expect(interpreterIssue('treecontext')).toContain("bare 'treecontext'")
  })

  it('accepts npx and healthy absolute paths', () => {
    expect(interpreterIssue('npx')).toBeNull()
    expect(interpreterIssue(`"${process.execPath}" "/x/hook.js"`)).toBeNull()
    expect(interpreterIssue(process.execPath)).toBeNull()
  })

  it('flags stale absolute interpreter paths', () => {
    expect(interpreterIssue('"/nonexistent/cellar/node" "/x/hook.js"')).toContain('interpreter missing')
    expect(interpreterIssue('/nonexistent/cellar/node')).toContain('interpreter missing')
  })

  it('does not flag other tools or relative script invocations', () => {
    expect(interpreterIssue('other-tool start')).toBeNull()
    expect(interpreterIssue('~/.claude/hooks/tc-session-reminder')).toBeNull()
  })
})

/**
 * launcherInterpreter reads the pin out of a wrapper body. It is what doctor's
 * "Hook interpreter" check probes, so a dialect it mis-reads is a check that
 * silently stops working — the failure that gated it off Windows in the first
 * place.
 *
 * These run on EVERY platform: the function is pure and takes the body as an
 * argument, so the Windows dialect is testable from Linux. Nothing here needs
 * a Windows runner, and leaving it to one would mean the .cmd branch was only
 * ever exercised on the platform least likely to run the suite.
 */
describe('launcherInterpreter reads the pin from both wrapper dialects', () => {
  const cli = 'C:\\Users\\dev\\cli.js'
  const winBody = (resolve: string): string =>
    `@echo off\r\nREM treecontext: MCP stdio launcher\r\nsetlocal\r\n${resolve}"%TC_NODE%" "${cli}" %*\r\n`

  it('reads a pinned interpreter out of the .cmd dialect', () => {
    const body = winBody('set "TC_NODE=C:\\Program Files\\nodejs\\node.exe"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n')
    expect(launcherInterpreter(body)).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('reports NOTHING pinned when the .cmd falls through to runtime resolution', () => {
    // `set "TC_NODE=node"` is the snippet's sentinel for "no interpreter
    // verified — resolve at runtime". Returning the literal 'node' here would
    // make doctor probe a bare name and report a PATH-dependent guess as the
    // pinned interpreter, which is the opposite of what the check is for.
    const body = winBody(`set "TC_NODE=node"\r\nwhere node >nul 2>nul || set "TC_NODE=${'C:\\fallback\\node.exe'}"\r\n`)
    expect(launcherInterpreter(body)).toBeNull()
  })

  it('reads a pinned interpreter out of the POSIX dialect', () => {
    const body = '#!/bin/bash\nTC_NODE="/usr/local/bin/node"\nif [ ! -x "$TC_NODE" ]; then\nTC_NODE="$(command -v node || true)"\nfi\nexec "$TC_NODE" "/x/cli.js" "$@"\n'
    expect(launcherInterpreter(body)).toBe('/usr/local/bin/node')
  })

  it('reports nothing pinned when the POSIX dialect verified none', () => {
    const body = '#!/bin/bash\nTC_NODE=""\nif true; then\nTC_NODE="$(command -v node || true)"\nfi\nexec "$TC_NODE" "/x/cli.js" "$@"\n'
    expect(launcherInterpreter(body)).toBeNull()
  })

  it('does not mistake the debug line or the fallback for the pin', () => {
    // A hook body sets TREECONTEXT_DEBUG before TC_NODE, and the verified
    // dialect mentions TC_NODE twice — once as the pin, once in the `if not
    // exist` fallback. Only the first is the answer.
    const body = `@echo off\r\nREM treecontext: post-tool-use hook\r\nsetlocal\r\nset TREECONTEXT_DEBUG=1\r\nset "TC_NODE=C:\\pinned\\node.exe"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n"%TC_NODE%" "${cli}" hook post-tool-use 2>nul\r\n`
    expect(launcherInterpreter(body)).toBe('C:\\pinned\\node.exe')
  })
})

// ── hookScriptIssue: per-dialect wrapper-body grading (0.1 pull-in) ────────
//
// Dialect comes from the BODY, never process.platform — doctor must be able
// to judge a .cmd found on disk from any host, and these tests run the
// Windows cases on the Linux lane for exactly that reason.
describe('hookScriptIssue grades wrapper bodies per dialect', () => {
  // Host-style paths by construction, so the existence probe runs on
  // every lane: the grader skips pins whose path style is not the
  // host's (a C:\ pin judged from POSIX would always read as vanished).
  const goneNode = `${process.execPath}.gone-${Date.now()}`
  // Host-style module paths, for the same reason: one that exists, one that
  // does not, both spelled the way this platform spells a path.
  const liveCli = process.execPath
  const goneCli = `${process.execPath}.cli-gone-${Date.now()}.js`

  it('a current POSIX wrapper is healthy', () => {
    expect(hookScriptIssue(hookScriptContent('post-tool-use'))).toBeNull()
  })

  it('the generated session reminder is not an interpreter wrapper — never graded', () => {
    // Fifth-pass review finding 1: this @echo-off body runs nothing, and
    // grading it as a "legacy wrapper" put every healthy Windows install
    // in an unclearable warn loop.
    const reminder = '@echo off\r\nREM treecontext: session-start orientation reminder\r\nREM Installed by: treecontext install\r\necho line one of the orientation text\r\necho line two of the orientation text\r\n'
    expect(hookScriptIssue(reminder)).toBeNull()
  })

  it('the legacy POSIX bare-node wrapper is flagged', () => {
    const legacy = '#!/bin/bash\n# treecontext: stop hook\nexec node "/repo/dist/server/cli.js" hook stop 2>/dev/null\nexit 0\n'
    expect(hookScriptIssue(legacy)).toContain("bare 'node'")
  })

  it('the pre-0.0.15 pinned-only Windows wrapper is flagged — the shape that shipped 0.0.13/14', () => {
    const legacy = '@echo off\r\nREM treecontext: stop hook\r\n"C:\\nodejs\\node.exe" "C:\\repo\\dist\\server\\cli.js" hook stop 2>nul\r\n'
    expect(hookScriptIssue(legacy)).toContain('no fallback chain')
  })

  it('a current Windows wrapper with a live pinned interpreter is healthy', () => {
    // The module path is liveCli, not a `C:\repo\cli.js` placeholder, for the
    // same reason as the unverified-POSIX case below: grading now reads that
    // path, and on the Windows release lane a host-style placeholder would be
    // probed, found missing, and fail this test for a reason unrelated to the
    // interpreter pin it is named for.
    const body = `@echo off\r\nsetlocal\r\nset "TC_NODE=${process.execPath}"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n"%TC_NODE%" "${liveCli}" hook stop 2>nul\r\n`
    expect(hookScriptIssue(body)).toBeNull()
  })

  it('a Windows wrapper whose pinned interpreter vanished is flagged as unverified fallback', () => {
    const body = `@echo off\r\nsetlocal\r\nset "TC_NODE=${goneNode}"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n"%TC_NODE%" "C:\\repo\\cli.js" hook stop 2>nul\r\n`
    const issue = hookScriptIssue(body)
    expect(issue).toContain('no longer exists')
    expect(issue).toContain('unverified PATH node')
  })

  it('a POSIX wrapper whose pinned interpreter vanished is flagged too — same treatment, both dialects', () => {
    // Fifth-pass review finding 3: the vanished-pin class existed only in
    // the Windows branch while the POSIX wrapper pins identically.
    const body = `#!/bin/bash\n# treecontext: stop hook\nTC_NODE="${goneNode}"\nif [ ! -x "$TC_NODE" ]; then\nTC_NODE="$(command -v node || true)"\nfi\nexec "$TC_NODE" "/repo/cli.js" hook stop 2>/dev/null\nexit 0\n`
    const issue = hookScriptIssue(body)
    expect(issue).toContain('no longer exists')
  })

  it('a cross-host pin style is never probed for existence', () => {
    // The INTERPRETER pin is the foreign one under test; the module path must
    // be a live host file so the module grader (which reads it host-style
    // here) cannot fail the test on the placeholder's behalf.
    const foreign = process.platform === 'win32' ? '/usr/local/bin/node' : 'C:\\gone\\node.exe'
    const body = `@echo off\r\nsetlocal\r\nset "TC_NODE=${foreign.replace(/\\/g, '\\\\')}"\r\nif not exist "%TC_NODE%" set "TC_NODE=node"\r\n"%TC_NODE%" "${liveCli}" hook stop 2>nul\r\n`
    expect(hookScriptIssue(body)).toBeNull()
  })

  it('the no-verified-node Windows form (where-node fallback) is healthy', () => {
    // Module path is liveCli for the same placeholder reason as the cases
    // above — the sentinel interpreter is what this test is about.
    const body = `@echo off\r\nsetlocal\r\nset "TC_NODE=node"\r\nwhere node >nul 2>nul || set "TC_NODE=C:\\exec\\node.exe"\r\n"%TC_NODE%" "${liveCli}" hook stop 2>nul\r\n`
    expect(hookScriptIssue(body)).toBeNull()
  })

  it('an unverified POSIX wrapper (empty pin, discovery chain only) is healthy', () => {
    // The module path is a REAL file here, where it used to be a `/repo/cli.js`
    // placeholder. Grading now reads that path, so a stand-in that does not
    // exist would fail this test for a reason that has nothing to do with the
    // empty interpreter pin it is named for.
    const body = `#!/bin/bash\nTC_NODE=""\nif true; then\nTC_NODE="$(command -v node || true)"\nfi\nexec "$TC_NODE" "${liveCli}" hook stop 2>/dev/null\nexit 0\n`
    expect(hookScriptIssue(body)).toBeNull()
  })

  // ── the module path, same grading, both dialects ──

  it('a POSIX wrapper whose module path was deleted, with no fallback, is flagged', () => {
    // The shape found in the wild after an nvm v24.18→v24.20 bump: a healthy
    // interpreter chain handing a perfectly good node a file that is gone.
    const body = `#!/bin/bash\nTC_NODE="${process.execPath}"\nif [ ! -x "$TC_NODE" ]; then\nTC_NODE="$(command -v node || true)"\nfi\nexec "$TC_NODE" "${goneCli}" hook stop 2>/dev/null\nexit 0\n`
    const issue = hookScriptIssue(body)
    expect(issue).toContain('MODULE_NOT_FOUND')
    expect(issue).toContain(goneCli)
  })

  // The shape every release before the rename wrote: its search names only
  // the old package directory. Such wrappers stay on disk until `install`
  // is re-run, so they stay graded.
  const fallbackBody = `#!/bin/bash\nTC_NODE="${process.execPath}"\nTC_CLI="${goneCli}"\nif [ ! -f "$TC_CLI" ]; then for _c in "$HOME"/.nvm/versions/node/*/lib/node_modules/treecontext/dist/server/cli.js; do [ -f "$_c" ] && TC_CLI="$_c"; done; fi\nexec "$TC_NODE" "$TC_CLI" hook stop 2>/dev/null\nexit 0\n`

  it('a missing module path is NOT flagged when the fallback search would land on a real copy', () => {
    // Silence is the point: with a search that RESOLVES the wrapper recovers,
    // and unlike an unpinned interpreter there is no native-binding question
    // about which copy of the same package it lands on. Warning here would
    // train the user to ignore doctor. The copy is seeded in a sandboxed
    // HOME because the grader probes the real managed layouts.
    const home = mkdtempSync(join(tmpdir(), 'tc-fallback-home-'))
    const restore = redirectHome(home)
    try {
      const seeded = join(home, '.nvm', 'versions', 'node', 'v99.0.0',
        'lib', 'node_modules', 'treecontext', 'dist', 'server')
      mkdirSync(seeded, { recursive: true })
      writeFileSync(join(seeded, 'cli.js'), '// seeded global install\n')
      expect(hookScriptIssue(fallbackBody)).toBeNull()
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a missing module path IS flagged when the fallback search would come up empty', () => {
    // Machinery is not recovery: the same body, with no copy anywhere the
    // search looks, dies MODULE_NOT_FOUND exactly as if the fallback did not
    // exist — a volta/asdf/moved-checkout install must not read as healthy
    // just because the body contains the search text.
    //
    // The system prefixes cannot be sandboxed (same constraint the
    // probeResolvedCli comment documents), so on a host that genuinely has a
    // global copy there the search genuinely lands and healthy is the
    // correct verdict — the flagged claim is only assertable where it is
    // true.
    const systemCopy = ['/opt/homebrew', '/usr/local'].some(p => ['treecontext-mcp', 'treecontext'].some(n =>
      existsSync(join(p, 'lib', 'node_modules', n, 'dist', 'server', 'cli.js'))))
    const home = mkdtempSync(join(tmpdir(), 'tc-nofallback-home-'))
    const restore = redirectHome(home)
    try {
      const issue = hookScriptIssue(fallbackBody)
      if (systemCopy) {
        expect(issue).toBeNull()
      } else {
        expect(issue).toContain('no fallback copy was found')
        expect(issue).toContain(goneCli)
      }
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('the managed-layout scan is read once and re-read on the reset seam', () => {
    // doctor grades up to ~25 wrapper bodies per run and this probe used to
    // walk the nvm/fnm roots from scratch for every one of them. It is
    // memoized now, so a copy that appears MID-RUN is not seen until the seam
    // doctor calls at the top of each run clears it — one report, one
    // consistent snapshot of the disk.
    //
    // The system prefixes cannot be sandboxed (see the case above), so on a
    // host that has a global copy there the answer is legitimately "found"
    // throughout and there is no memo to observe.
    const systemCopy = ['/opt/homebrew', '/usr/local'].some(p => ['treecontext-mcp', 'treecontext'].some(n =>
      existsSync(join(p, 'lib', 'node_modules', n, 'dist', 'server', 'cli.js'))))
    const home = mkdtempSync(join(tmpdir(), 'tc-memo-home-'))
    const restore = redirectHome(home)
    try {
      resetManagedLayoutScan()
      if (systemCopy) {
        expect(hookScriptIssue(fallbackBody)).toBeNull()
        return
      }
      expect(hookScriptIssue(fallbackBody)).toContain('no fallback copy was found')

      const seeded = join(home, '.nvm', 'versions', 'node', 'v99.0.0',
        'lib', 'node_modules', 'treecontext', 'dist', 'server')
      mkdirSync(seeded, { recursive: true })
      writeFileSync(join(seeded, 'cli.js'), '// seeded global install\n')
      expect(hookScriptIssue(fallbackBody), 'the scan was not memoized')
        .toContain('no fallback copy was found')

      resetManagedLayoutScan()
      expect(hookScriptIssue(fallbackBody), 'the reset seam did not re-read the disk').toBeNull()
    } finally {
      restore()
      resetManagedLayoutScan()
      rmSync(home, { recursive: true, force: true })
    }
  })

  // POSIX-only fixture (sh `TC_CLI="..."` pin, ~/.nvm layout); Windows writes a .cmd body.
  describe.skipIf(process.platform === 'win32')('across the package rename', () => {
    // The wrapper this build writes, its pin swapped for a dead one. Its
    // search names `treecontext-mcp` and `treecontext`; the grader must probe
    // exactly the names the body's own search names.
    const currentBody = (): string => {
      const raw = hookScriptContent('stop')
      expect(raw, 'the TC_CLI pin changed shape — this fixture no longer applies').toMatch(/^TC_CLI="/m)
      return raw.replace(/^TC_CLI="[^"]*"/m, `TC_CLI="${goneCli}"`)
    }
    const systemHas = (names: string[]): boolean => ['/opt/homebrew', '/usr/local'].some(p =>
      names.some(n => existsSync(join(p, 'lib', 'node_modules', n, 'dist', 'server', 'cli.js'))))

    function withHome(seedDir: string | null, fn: () => void): void {
      const home = mkdtempSync(join(tmpdir(), 'tc-rename-home-'))
      const restore = redirectHome(home)
      try {
        if (seedDir) {
          const seeded = join(home, '.nvm', 'versions', 'node', 'v99.0.0', 'lib', 'node_modules', seedDir, 'dist', 'server')
          mkdirSync(seeded, { recursive: true })
          writeFileSync(join(seeded, 'cli.js'), '// seeded global install\n')
        }
        resetManagedLayoutScan()
        fn()
      } finally {
        restore()
        resetManagedLayoutScan()
        rmSync(home, { recursive: true, force: true })
      }
    }

    it('a current wrapper is not flagged when a treecontext-mcp copy survives', () => {
      expect(currentBody()).toContain('node_modules/treecontext-mcp/')
      withHome('treecontext-mcp', () => expect(hookScriptIssue(currentBody())).toBeNull())
    })

    it('a current wrapper is not flagged when only a legacy treecontext copy survives', () => {
      withHome('treecontext', () => expect(hookScriptIssue(currentBody())).toBeNull())
    })

    it('a current wrapper IS flagged when neither name survives anywhere', () => {
      withHome(null, () => {
        const issue = hookScriptIssue(currentBody())
        if (systemHas(['treecontext-mcp', 'treecontext'])) expect(issue).toBeNull()
        else expect(issue).toContain('no fallback copy was found')
      })
    })

    it('a pre-rename wrapper IS flagged beside a treecontext-mcp copy its own search cannot reach', () => {
      // Its shell loop names only `treecontext`; probing wider would call a
      // dying wrapper healthy.
      withHome('treecontext-mcp', () => {
        const issue = hookScriptIssue(fallbackBody)
        if (systemHas(['treecontext'])) expect(issue).toBeNull()
        else expect(issue).toContain('no fallback copy was found')
      })
    })
  })

  it('a cross-host module pin is never probed for existence either', () => {
    const foreign = process.platform === 'win32' ? '/gone/cli.js' : 'C:\\gone\\cli.js'
    const body = `#!/bin/bash\nTC_NODE="${process.execPath}"\nexec "$TC_NODE" "${foreign.replace(/\\/g, '\\\\')}" hook stop 2>/dev/null\nexit 0\n`
    expect(hookScriptIssue(body)).toBeNull()
  })

  it('launcherCliPath reports nothing when the body only names the variable', () => {
    // `$TC_CLI` is not a path. Returning it would hand the grader a shell
    // fragment to probe -- the same trap launcherInterpreter documents for
    // `$(command -v node || true)`.
    const body = '#!/bin/bash\nTC_NODE="/x/node"\nexec "$TC_NODE" "$TC_CLI" hook stop 2>/dev/null\n'
    expect(launcherCliPath(body)).toBeNull()
  })
})
