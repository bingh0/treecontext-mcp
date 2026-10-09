/**
 * Uninstall cleans the archived-build five's configs (fifth-pass review,
 * finding 2). The agents left the registry at the 0.1 cold-read, but a
 * 0.0.x install may have written 'treecontext' MCP entries into their
 * configs — entries pointing at the launcher uninstall deletes. Without
 * this cleanup those agents error on a nonexistent path forever, and no
 * treecontext command can find or fix them.
 *
 * Own-file isolation: agents.ts computes paths from homedir() at module
 * load, so HOME must be redirected before the installer graph loads.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { redirectHome } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-legacy-uninstall-'))
const restoreHome = redirectHome(fakeHome)

const { uninstall } = await import('../../src/server/installer.js')
const { legacyMcpConfigs } = await import('../../src/server/agents.js')

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('uninstall cleans archived-build configs', () => {
  it('removes the treecontext entry from every legacy config, sparing neighbors', async () => {
    // Seed all five with the entry a 0.0.x install would have written,
    // each under its own rootKey, beside an unrelated neighbor.
    for (const legacy of legacyMcpConfigs()) {
      mkdirSync(dirname(legacy.path), { recursive: true })
      writeFileSync(legacy.path, JSON.stringify({
        [legacy.rootKey]: {
          treecontext: { command: join(fakeHome, '.claude', 'hooks', 'tc-mcp-serve') },
          unrelated: { command: 'other-tool' },
        },
      }, null, 2))
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* quiet */ })
    try {
      await uninstall({ yes: true, dryRun: false, agents: null })
    } finally {
      logSpy.mockRestore()
    }

    for (const legacy of legacyMcpConfigs()) {
      expect(existsSync(legacy.path), `${legacy.slug} config vanished entirely`).toBe(true)
      const data = JSON.parse(readFileSync(legacy.path, 'utf8')) as Record<string, Record<string, unknown>>
      expect(data[legacy.rootKey]!['treecontext'], `${legacy.slug} still points at the deleted launcher`)
        .toBeUndefined()
      expect(data[legacy.rootKey]!['unrelated'], `${legacy.slug}'s unrelated entry was collateral`)
        .toBeDefined()
    }
  })

  it('names an unknown --agent slug instead of silently dropping it', async () => {
    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    try {
      await uninstall({ yes: true, dryRun: true, agents: ['windsurf'] })
    } finally {
      logSpy.mockRestore()
    }
    const line = lines.find((l) => l.includes('unknown agent: windsurf'))
    expect(line, 'the dropped slug must be named — silence reads as "uninstalled"').toBeDefined()
    expect(line!).toContain('archived-build')
  })
})
