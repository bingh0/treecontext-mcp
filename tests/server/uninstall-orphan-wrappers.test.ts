/**
 * A full uninstall leaves no tc-<agent>-* wrapper behind, even when the agent
 * that used it has no config left.
 *
 * The selection at the top of `uninstall` keeps only agents whose config path
 * still EXISTS, so a user who removed ~/.gemini never ran the gemini branch —
 * and removeClaudeHookScripts spares every tc-<agent>-* name on purpose, for
 * the branch that was supposed to take them. The four gemini wrappers
 * therefore survived `treecontext uninstall` permanently, with nothing left on
 * the machine that could ever name them again. Gemini CLI is retired since
 * D399 (its wrappers go with the archived sweep, below); Cursor's wrappers,
 * which an earlier build's --experimental-capture wrote, keep the shape.
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
const cursorDir = join(fakeHome, '.cursor')

/** Cursor installed with capture wrappers by an earlier build, then its config deleted by hand. */
function seedOrphanedCursor(): void {
  mkdirSync(cursorDir, { recursive: true })
  writeFileSync(join(cursorDir, 'hooks.json'), JSON.stringify({ hooks: {} }))
  installClaudeHookScripts(false)
  installAgentHookWrappers('cursor', false)
  expect(readdirSync(hooksDir).filter(f => f.startsWith('tc-cursor-')).length).toBeGreaterThan(0)
  rmSync(cursorDir, { recursive: true, force: true })
}

/** The wrappers an earlier build wrote for Gemini CLI, before its retirement (D399). */
function seedGeminiWrappers(): void {
  installAgentHookWrappers('gemini', false)
  expect(geminiWrappers().length).toBe(4)
}

const quietly = async (run: () => Promise<unknown>): Promise<void> => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* quiet */ })
  try { await run() } finally { logSpy.mockRestore() }
}

const cursorWrappers = (): string[] =>
  readdirSync(hooksDir).filter(f => f.startsWith('tc-cursor-'))
const geminiWrappers = (): string[] =>
  readdirSync(hooksDir).filter(f => f.startsWith('tc-gemini-'))

afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('full uninstall sweeps orphaned agent wrappers', () => {
  it('takes tc-cursor-* even though the cursor config is gone', async () => {
    seedOrphanedCursor()
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: null }))
    expect(cursorWrappers(), 'wrappers were orphaned with nothing left to name them').toEqual([])
  })

  it('honours dry-run', async () => {
    seedOrphanedCursor()
    await quietly(() => uninstall({ yes: true, dryRun: true, agents: null }))
    expect(cursorWrappers().length, 'dry-run deleted files').toBeGreaterThan(0)
  })

  it('still spares them when the run names another agent', async () => {
    // The F1 shape the sparing rule exists for: `uninstall claude` on a
    // machine that still runs cursor capture must not delete the scripts
    // cursor's config points at. Only a FULL uninstall owns them.
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: ['claude'] }))
    expect(cursorWrappers().length, 'an unrelated agent uninstall took the cursor wrappers')
      .toBeGreaterThan(0)

    await quietly(() => uninstall({ yes: true, dryRun: false, agents: null }))
    expect(cursorWrappers()).toEqual([])
  })

  it("takes Gemini CLI's wrappers on any uninstall that is not hooks-only: nothing runs them since its retirement (D399)", async () => {
    seedGeminiWrappers()
    await quietly(() => uninstall({ yes: true, dryRun: true, agents: ['gemini'] }))
    expect(geminiWrappers().length, 'dry-run deleted files').toBe(4)
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: ['gemini'], hooksOnly: true }))
    expect(geminiWrappers().length, 'a hooks-only run swept the archived platforms').toBe(4)
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: ['gemini'] }))
    expect(geminiWrappers()).toEqual([])
    seedGeminiWrappers()
    await quietly(() => uninstall({ yes: true, dryRun: false, agents: ['claude'] }))
    expect(geminiWrappers()).toEqual([])
  })
})
