/**
 * A full uninstall leaves no tc-<agent>-* wrapper behind, even when the agent
 * that used it has no config left.
 *
 * The selection at the top of `uninstall` keeps only agents whose config path
 * still EXISTS, so a user who removed ~/.gemini never ran the gemini branch —
 * and removeClaudeHookScripts spares every tc-<agent>-* name on purpose, for
 * the branch that was supposed to take them. The four gemini wrappers
 * therefore survived `treecontext uninstall` permanently, with nothing left on
 * the machine that could ever name them again.
 *
 * Own-file isolation: agents.ts computes AGENTS paths from homedir() at module
 * load, so HOME must be redirected before the installer graph loads.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { redirectHome } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-orphan-wrappers-'))
const restoreHome = redirectHome(fakeHome)

const {
  installAgentHookWrappers, installClaudeHookScripts, uninstall,
} = await import('../../src/server/installer.js')

const hooksDir = join(fakeHome, '.claude', 'hooks')
const geminiDir = join(fakeHome, '.gemini')

/** Gemini installed with capture wrappers, then its config deleted by hand. */
function seedOrphanedGemini(): void {
  mkdirSync(geminiDir, { recursive: true })
  writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ hooks: {} }))
  installClaudeHookScripts(false)
  installAgentHookWrappers('gemini', false)
  expect(readdirSync(hooksDir).filter(f => f.startsWith('tc-gemini-')).length).toBeGreaterThan(0)
  rmSync(geminiDir, { recursive: true, force: true })
}

const quietly = async (run: () => Promise<unknown>): Promise<void> => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* quiet */ })
  try { await run() } finally { logSpy.mockRestore() }
}

const geminiWrappers = (): string[] =>
  readdirSync(hooksDir).filter(f => f.startsWith('tc-gemini-'))

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('full uninstall sweeps orphaned agent wrappers', () => {
  it('takes tc-gemini-* even though the gemini config is gone', async () => {
    seedOrphanedGemini()
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: null }))
    expect(geminiWrappers(), 'wrappers were orphaned with nothing left to name them').toEqual([])
  })

  it('honours dry-run', async () => {
    seedOrphanedGemini()
    await quietly(() => uninstall({ yes: true, dryRun: true, agents: null }))
    expect(geminiWrappers().length, 'dry-run deleted files').toBeGreaterThan(0)
  })

  it('still spares them when the run names another agent', async () => {
    // The F1 shape the sparing rule exists for: `uninstall claude` on a
    // machine that still runs gemini capture must not delete the scripts
    // gemini's config points at. Only a FULL uninstall owns them.
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: ['claude'] }))
    expect(geminiWrappers().length, 'an unrelated agent uninstall took the gemini wrappers')
      .toBeGreaterThan(0)

    await quietly(() => uninstall({ yes: true, dryRun: false, agents: null }))
    expect(geminiWrappers()).toEqual([])
  })
})
