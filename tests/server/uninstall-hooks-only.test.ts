/**
 * `uninstall --hooks-only` — the command doctor offers for hooks left behind
 * on a platform install does not manage.
 *
 * The stale hooks must go, but the MCP registration on that agent is working
 * and the user did not ask to lose it. A cleanup that takes the tools with it
 * would trade one broken instruction for another.
 *
 * Own-file isolation: agents.ts computes AGENTS paths from homedir() at
 * module load, so HOME must be redirected before the installer graph loads.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { redirectHome } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-hooksonly-home-'))
const restoreHome = redirectHome(fakeHome)

// From the registry, not a literal: `~/.config/Code/User` is the Linux
// location only, so the hardcoded form asserted a property of Linux and this
// file's one scenario failed on macOS. Imported after redirectHome — agents.ts
// freezes its paths from homedir() at module evaluation.
const { getAgent, getConfigPath } = await import('../../src/server/agents.js')
const vscodeAgent = getAgent('vscode')
if (!vscodeAgent) throw new Error('agent registry no longer defines a vscode agent')
const vscodeMcp = getConfigPath(vscodeAgent)
if (!vscodeMcp) throw new Error(`agent registry defines no vscode config path for ${process.platform}`)
mkdirSync(dirname(vscodeMcp), { recursive: true })

const copilotHooksFile = join(fakeHome, '.copilot', 'hooks', 'treecontext.json')
mkdirSync(join(fakeHome, '.copilot', 'hooks'), { recursive: true })

// An arrow const, not a hoisted declaration: hoisting would put this body
// before the `if (!vscodeMcp) throw` above, so the registry path would read
// back as possibly-null here while the `it` bodies below see it narrowed.
const seed = (): void => {
  writeFileSync(vscodeMcp, JSON.stringify({
    servers: {
      treecontext: { command: process.execPath, args: ['cli.js', '--capture'] },
      unrelated: { command: 'other-tool' },
    },
  }))
  writeFileSync(copilotHooksFile, JSON.stringify({
    version: 1,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/dist/hooks/vscode/session-start.js"' }] }],
    },
  }))
}

const { uninstall } = await import('../../src/server/installer.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('uninstall --hooks-only', () => {
  it('removes hook config and leaves MCP registration intact', async () => {
    seed()
    await uninstall({ yes: true, dryRun: false, agents: ['vscode'], hooksOnly: true })

    expect(existsSync(copilotHooksFile)).toBe(false)

    const mcp = JSON.parse(readFileSync(vscodeMcp, 'utf8')) as Record<string, Record<string, unknown>>
    expect(mcp.servers!.treecontext, 'MCP registration should survive a hooks-only cleanup').toBeDefined()
    expect(mcp.servers!.unrelated).toBeDefined()
  })

  it('still removes MCP when the flag is absent', async () => {
    seed()
    await uninstall({ yes: true, dryRun: false, agents: ['vscode'] })

    const mcp = JSON.parse(readFileSync(vscodeMcp, 'utf8')) as Record<string, Record<string, unknown>>
    expect(mcp.servers!.treecontext).toBeUndefined()
    expect(mcp.servers!.unrelated, 'other servers are never touched').toBeDefined()
  })

  it('honours dry-run', async () => {
    seed()
    await uninstall({ yes: true, dryRun: true, agents: ['vscode'], hooksOnly: true })

    expect(existsSync(copilotHooksFile), 'dry-run must not delete anything').toBe(true)
    const mcp = JSON.parse(readFileSync(vscodeMcp, 'utf8')) as Record<string, Record<string, unknown>>
    expect(mcp.servers!.treecontext).toBeDefined()
  })
})
