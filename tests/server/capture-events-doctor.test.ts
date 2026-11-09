/**
 * D402's doctor clause, bound as a plain test while the @D402 scenario's
 * event list and its guard are unit 8b's: an installation whose Claude Code
 * settings were wired by a build from before PostToolUseFailure and
 * PostToolBatch (D400, D401) is reported by doctor with the command that
 * wires them, and that command clears the report. The real CLI, under a
 * redirected HOME (tests/journal/install-harness.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { type InstallWorld, openInstallWorld, tcCli } from '../journal/install-harness.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f() })

describe('doctor: an installation wired before a capture event was added', () => {
  it('names the unwired events and what is lost, with `treecontext install --force --agent claude`, which clears it', async () => {
    const w = { defer: (f: () => unknown) => { cleanups.push(f) } } as unknown as InstallWorld
    await openInstallWorld(w, ['.claude'])
    expect(tcCli(w, ['install', '--yes']).status).toBe(0)
    const settingsPath = join(w.ihome!, '.claude', 'settings.json')
    const fresh = tcCli(w, ['doctor']).stdout
    expect(fresh, 'a fresh install already reports unwired events').not.toMatch(/capture events/)
    // The block as a build from before D400 and D401 wrote it.
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown> }
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']))
    delete settings.hooks['PostToolUseFailure']
    delete settings.hooks['PostToolBatch']
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    const doc = tcCli(w, ['doctor']).stdout.split('\n')
    const i = doc.findIndex((l) => /capture events: not wired: wired by a build from before these events were added: PostToolUseFailure \(a tool call that fails is not journaled\); PostToolBatch \(/.test(l))
    expect(i, `doctor did not name the old wiring:\n${doc.join('\n')}`).toBeGreaterThanOrEqual(0)
    expect(doc[i + 1]).toMatch(/^\s+fix: treecontext install --force --agent claude$/)
    expect(tcCli(w, ['install', '--force', '--agent', 'claude', '--yes']).status).toBe(0)
    expect(tcCli(w, ['doctor']).stdout).not.toMatch(/capture events/)
  }, 120_000)
})
