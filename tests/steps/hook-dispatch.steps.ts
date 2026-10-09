/**
 * hook-dispatch.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * The never-non-zero hook ring (ruling 2026-08-15). Every scenario
 * spawns the real CLI: the contract under test is the process exit code
 * of `treecontext hook <event>`, and the ring it pins begins before
 * parseArgs — no import-level call can exercise it. "a sandboxed home"
 * and "the hook exits zero" merge across their four scenarios each,
 * executing once per scenario; every When keeps its own invocation.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import type { Registry } from 'gherkin-node-test/vitest'

import { spawnCli } from '../helpers/cli-spawn.js'

interface HookRun {
  status: number | null
  stderr: string
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  home?: string
  run?: HookRun
}

export const hookDispatchDefiner = (reg: Registry<World>): void => {
  // Merged: four scenarios start from a pristine sandbox and prove it.
  reg.define(/^a sandboxed home$/, (w) => {
    const home = mkdtempSync(join(tmpdir(), 'tc-hook-dispatch-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    expect(existsSync(join(home, '.treecontext'))).toBe(false)
    w.home = home
  })

  reg.define(/^a sandboxed home whose global config file is unparseable$/, (w) => {
    const home = mkdtempSync(join(tmpdir(), 'tc-hook-dispatch-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.treecontext'), { recursive: true })
    writeFileSync(join(home, '.treecontext', 'config.toml'), '[server\ncapture = maybe')
    w.home = home
  })

  reg.define(/^the hook command runs with an event no dispatcher knows$/, (w) => {
    w.run = spawnCli(['hook', 'some-future-event'], { home: w.home! })
  })

  reg.define(/^a known hook event runs with empty input$/, (w) => {
    w.run = spawnCli(['hook', 'post-tool-use'], { home: w.home! })
  })

  reg.define(/^the hook command runs with a flag where the event belongs$/, (w) => {
    w.run = spawnCli(['hook', '--definitely-not-an-event'], { home: w.home! })
  })

  reg.define(/^a known hook event runs with junk on stdin$/, (w) => {
    w.run = spawnCli(['hook', 'user-prompt-submit'], { home: w.home!, input: 'this is not JSON' })
  })

  reg.define(/^the CLI runs with a flag before the hook token$/, (w) => {
    w.run = spawnCli(['--no-debug', 'hook', 'post-tool-use'], { home: w.home! })
  })

  // Merged: the four never-non-zero scenarios share this observable;
  // executes once per scenario.
  reg.define(/^the hook exits zero$/, (w) => {
    expect(w.run!.status, w.run!.stderr).toBe(0)
  })

  reg.define(/^it is refused as an ordinary command-line error$/, (w) => {
    expect(w.run!.status, w.run!.stderr).toBe(1)
    expect(w.run!.stderr).toMatch(/Unexpected argument/)
  })

  reg.define(/^the debug log records the unknown event by name$/, (w) => {
    const logsDir = join(w.home!, '.treecontext', 'logs')
    let logs = ''
    if (existsSync(logsDir)) {
      logs = readdirSync(logsDir)
        .map((f) => readFileSync(join(logsDir, f), 'utf8'))
        .join('\n')
    }
    expect(logs).toMatch(/unknown hook event/)
    expect(logs).toMatch(/some-future-event/)
  })
}
