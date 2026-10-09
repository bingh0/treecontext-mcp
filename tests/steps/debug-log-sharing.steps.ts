/**
 * debug-log-sharing.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Redaction at the print surfaces (ruling 2026-08-15). The dump and
 * crash-excerpt scenarios cannot run in this worker — installer.ts
 * reads src/debug.ts's LOGS_DIR, frozen from the REAL homedir by
 * earlier imports here — so they drive dumpDebugLogs()/doctor() through
 * a fresh redirected-home process (helpers/log-sharing-child.ts) and
 * assert on its captured stdout. The additive-doctor and no-bodies
 * scenarios spawn the real CLI exactly as before. The two scenarios
 * sharing "a debug log recording an absolute path inside home" seed one
 * representative line apiece from a single definition.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import { spawnCli, spawnNodeTs, type CliSpawnResult } from '../helpers/cli-spawn.js'

const CHILD_TS = fileURLToPath(new URL('../helpers/log-sharing-child.ts', import.meta.url))

interface World {
  defer: (fn: () => void | Promise<void>) => void
  fakeHome?: string
  printed?: string
  report?: string
  out?: string
  status?: number | null
  logText?: string
  sentinel?: string
}

export const debugLogSharingDefiner = (reg: Registry<World>): void => {
  function freshHome(w: World): string {
    const home = mkdtempSync(join(tmpdir(), 'tc-log-sharing-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    w.fakeHome = home
    return home
  }

  function runChild(w: World, mode: 'dump' | 'crash'): string {
    const secretPath = join(w.fakeHome!, 'projects', 'secret-repo')
    const r: CliSpawnResult = spawnNodeTs(CHILD_TS, [mode, secretPath], { home: w.fakeHome! })
    // Fixture precondition: the isolated printer must have run cleanly,
    // or the assertions below would grade an empty capture.
    expect(r.status, `log-sharing child failed: ${r.stderr}`).toBe(0)
    return r.stdout
  }

  reg.define(/^a debug log recording an absolute path inside home$/, (w) => {
    freshHome(w)
  })

  reg.define(/^a fatal log line naming a path inside home$/, (w) => {
    freshHome(w)
  })

  reg.define(/^a home with a recorded debug log$/, (w) => {
    freshHome(w)
  })

  reg.define(/^a prompt holding a distinctive sentence is captured by the hook$/, (w) => {
    const fakeHome = freshHome(w)
    w.sentinel = 'the amethyst walrus signs the treaty at dusk'
    const proj = join(fakeHome, 'proj')
    mkdirSync(proj, { recursive: true })
    const r = spawnCli(['hook', 'user-prompt-submit'], {
      home: fakeHome, cwd: proj,
      env: { TREECONTEXT_BINDINGS_FILE: join(fakeHome, '.treecontext', 'bindings.json') },
      input: JSON.stringify({
        session_id: 'log-sharing-session', cwd: proj,
        hook_event_name: 'UserPromptSubmit', prompt: w.sentinel,
      }),
    })
    expect(r.status, r.stderr).toBe(0)
  })

  // Merged: both redaction scenarios share this When over world state.
  reg.define(/^the logs are dumped for sharing$/, (w) => {
    w.printed = runChild(w, 'dump')
  })

  reg.define(/^doctor reports recent crashes$/, (w) => {
    w.report = runChild(w, 'crash')
  })

  reg.define(/^doctor runs with the dump flag$/, (w) => {
    const r = spawnCli(['doctor', '--dump-logs'], { home: w.fakeHome! })
    w.status = r.status
    w.out = r.out
  })

  reg.define(/^every debug log is read$/, (w) => {
    const logsDir = join(w.fakeHome!, '.treecontext', 'logs')
    w.logText = readdirSync(logsDir)
      .map((f) => readFileSync(join(logsDir, f), 'utf8'))
      .join('\n')
  })

  reg.define(/^the printed output spells that path with a tilde$/, (w) => {
    expect(w.printed).toContain(join('~', 'projects', 'secret-repo'))
  })

  reg.define(/^the home directory appears nowhere in it$/, (w) => {
    expect(w.printed).not.toContain(w.fakeHome)
  })

  reg.define(/^the log file on disk still holds the real path$/, (w) => {
    const logsDir = join(w.fakeHome!, '.treecontext', 'logs')
    const onDisk = readdirSync(logsDir)
      .map((f) => readFileSync(join(logsDir, f), 'utf8'))
      .join('\n')
    expect(onDisk).toContain(join(w.fakeHome!, 'projects', 'secret-repo'))
  })

  reg.define(/^the excerpt spells that path with a tilde$/, (w) => {
    const crashRow = w.report!.split('\n').find((l) => l.includes('Recent crashes'))
    expect(crashRow, w.report).toBeDefined()
    expect(crashRow!).toContain(join('~', 'projects', 'secret-repo'))
    expect(crashRow!).not.toContain(w.fakeHome)
  })

  reg.define(/^the output holds both the diagnosis and the log dump$/, (w) => {
    expect(w.status, w.out).toBe(0)
    expect(w.out).toMatch(/\[ok\]/)
    expect(w.out).toMatch(/=== treecontext debug logs/)
  })

  reg.define(/^the sentence appears nowhere in them$/, (w) => {
    expect(w.logText).not.toContain(w.sentinel)
    // step-lint: allow unearned-absence -- guarded: amethyst is the scenario's own seeded canary; the same paired work-proof below shows the logs were read where it would have appeared
    expect(w.logText).not.toContain('amethyst')
  })

  reg.define(/^the logs still show the hook did its work$/, (w) => {
    expect(w.logText).toMatch(/user-prompt/)
  })
}
