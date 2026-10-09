/**
 * Claude Code's MCP registration must land in the file Claude Code reads
 * (macOS beta-1 field report).
 *
 * 0.0.9-beta wrote `~/.claude/.mcp.json`. Claude Code never reads that path at
 * any scope, so `install` succeeded, `doctor` reported "MCP configured" by
 * reading back its own dead file, and no treecontext_* tool ever appeared in a
 * session. Verified against the real CLI: with only `~/.claude/.mcp.json`
 * present, `claude mcp list` reports "No MCP servers configured"; moving the
 * same entry to `~/.claude.json` makes it appear.
 *
 * Own-file isolation: agents.ts freezes AGENTS paths from homedir() at module
 * load, so HOME must be redirected before the module graph is imported.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { redirectHome } from '../helpers/home.js'

const realConfigDir = process.env.CLAUDE_CONFIG_DIR
const fakeHome = mkdtempSync(join(tmpdir(), 'tc-claudepath-home-'))
// Every home variable, before the dynamic imports: agents.ts freezes its
// AGENTS paths from os.homedir() at module load, and that ignores HOME on
// Windows.
const restoreHome = redirectHome(fakeHome)
delete process.env.CLAUDE_CONFIG_DIR

mkdirSync(join(fakeHome, '.claude'), { recursive: true })

const {
  getConfigPath, claudeUserConfigPath, getAgent,
} = await import('../../src/server/agents.js')
const { install, doctor } = await import('../../src/server/installer.js')

const userConfig = join(fakeHome, '.claude.json')
const legacyConfig = join(fakeHome, '.claude', '.mcp.json')

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
})

afterAll(() => {
  restoreHome()
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('Claude Code MCP config location', () => {
  it('targets ~/.claude.json, not the ~/.claude/.mcp.json Claude Code ignores', () => {
    const claude = getAgent('claude')!
    expect(getConfigPath(claude, process.platform as 'linux' | 'darwin' | 'win32')).toBe(userConfig)
    expect(getConfigPath(claude, process.platform as 'linux' | 'darwin' | 'win32')).not.toBe(legacyConfig)
  })

  it('follows CLAUDE_CONFIG_DIR when a launcher relocates the config dir', () => {
    process.env.CLAUDE_CONFIG_DIR = '/somewhere/instance-a'
    expect(claudeUserConfigPath()).toBe(join('/somewhere/instance-a', '.claude.json'))

    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeUserConfigPath()).toBe(userConfig)
  })

  it('installs into the read location and clears the dead beta-1 entry', async () => {
    // An upgraded 0.0.9-beta user: registration sitting in the ignored file,
    // alongside an entry that belongs to somebody else.
    writeFileSync(legacyConfig, JSON.stringify({
      mcpServers: {
        treecontext: { command: '/old/dist/server/cli.js', args: ['serve'] },
        'someone-elses-server': { command: 'other-tool' },
      },
    }))

    await install({
      yes: true, dryRun: false, force: true, agents: ['claude'],
      useNpx: false, experimentalCapture: false, debug: true, lexical: true,
    })

    const written = JSON.parse(readFileSync(userConfig, 'utf8')) as Record<string, Record<string, unknown>>
    expect(written.mcpServers!.treecontext, 'entry must land where Claude Code reads').toBeDefined()

    const legacy = JSON.parse(readFileSync(legacyConfig, 'utf8')) as Record<string, Record<string, unknown>>
    expect(legacy.mcpServers!.treecontext, 'dead entry should not be left behind').toBeUndefined()
    expect(legacy.mcpServers!['someone-elses-server'], 'other servers are not ours to remove').toBeDefined()
  }, 120_000)

  it('backs up the live state file as it was BEFORE the write', async () => {
    // ~/.claude.json also holds Claude Code's own state. The backup is only
    // worth anything if it captures what was there first — a copy taken after
    // the upsert preserves our own output and protects nothing.
    const sentinel = { mcpServers: {}, projects: { '/some/repo': { lastCwd: '/some/repo' } } }
    writeFileSync(userConfig, JSON.stringify(sentinel))

    await install({
      yes: true, dryRun: false, force: true, agents: ['claude'],
      useNpx: false, experimentalCapture: false, debug: true, lexical: true,
    })

    const backup = JSON.parse(readFileSync(`${userConfig}.treecontext-backup`, 'utf8')) as typeof sentinel
    expect(backup).toEqual(sentinel)
    expect(backup.mcpServers, 'backup must predate our entry').toEqual({})

    // And the real file kept Claude Code's unrelated state.
    const written = JSON.parse(readFileSync(userConfig, 'utf8')) as Record<string, Record<string, unknown>>
    expect(written.projects!['/some/repo']).toEqual({ lastCwd: '/some/repo' })
  }, 120_000)

  it('doctor reads back the same file install wrote', async () => {
    expect(existsSync(userConfig)).toBe(true)
    const results = await doctor()
    const claude = results.find(r => r.check === 'Claude Code')!
    expect(claude.detail).toContain('MCP configured')
  }, 120_000)
})
