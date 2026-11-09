/**
 * Doctor on a copying client after a tools-only install (D208).
 *
 * Gemini CLI kept its hooks in the same settings.json as its MCP
 * registration. Doctor used to walk the whole file for treecontext commands,
 * so the MCP launcher (`…/tc-mcp-serve`) read as a hook and a no-flag
 * install reported "hooks present (experimental capture)" when none existed
 * — and the row never named the flagged command that copies them. Gemini
 * CLI is retired (D399); the same read guards Codex's hooks.json, read at
 * its top level minus any MCP registration key.
 *
 * Own-file isolation, as in doctor-unmanaged-hooks.test.ts: agents.ts
 * freezes its paths from homedir() at module load, so HOME is redirected
 * before the installer module graph is imported.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { redirectHome } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-copying-home-'))
const restoreHome = redirectHome(fakeHome)

const { getAgent, getConfigPath, getHookSettingsPath } = await import('../../src/server/agents.js')
const { doctor, unmanagedHookState, mcpLauncherPath } = await import('../../src/server/installer.js')

const codex = getAgent('codex')!
const launcher = mcpLauncherPath()

// What a tools-only install leaves for each copying client: the MCP
// registration naming the launcher, and no hooks.
const codexConfig = getConfigPath(codex)!
mkdirSync(dirname(codexConfig), { recursive: true })
writeFileSync(codexConfig, `[mcp_servers.treecontext]\ncommand = "${launcher}"\nargs = ["serve", "--transport", "stdio", "--capture", "--lexical"]\n`)

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('doctor: a copying client with tools only', () => {
  const codexHooks = getHookSettingsPath(codex)!
  it("an MCP registration in a copying client's hook file is not read as a hook", () => {
    // Control: the launcher path is one the treecontext-command hint matches,
    // so this would have been the false "present" before the fix.
    expect(launcher).toMatch(/tc-mcp-serve/)
    writeFileSync(codexHooks, JSON.stringify({ mcpServers: { treecontext: { command: launcher } } }))
    try {
      expect(unmanagedHookState(codex, process.platform as 'linux' | 'darwin' | 'win32')).toEqual({ present: false, row: null })
    } finally {
      rmSync(codexHooks, { force: true })
    }
  })

  it("a real treecontext hook in a copying client's hook file still reads as present", () => {
    writeFileSync(codexHooks, JSON.stringify({
      mcpServers: { treecontext: { command: launcher } },
      SessionStart: [{ hooks: [{ type: 'command', command: join(fakeHome, '.claude', 'hooks', 'tc-codex-session-start') }] }],
    }))
    try {
      expect(unmanagedHookState(codex, process.platform as 'linux' | 'darwin' | 'win32').present).toBe(true)
    } finally {
      rmSync(codexHooks, { force: true })
    }
  })

  for (const [name, slug] of [['Codex CLI', 'codex']] as const) {
    it(`doctor's ${name} row names the flagged copy command`, async () => {
      const row = (await doctor()).find(r => r.check === name)
      expect(row, `doctor printed no ${name} row`).toBeDefined()
      expect(row!.detail).toContain('hooks not copied')
      expect(row!.detail).toContain(`to copy them: treecontext install --agent ${slug} --experimental-capture`)
    }, 60_000)
  }
})
