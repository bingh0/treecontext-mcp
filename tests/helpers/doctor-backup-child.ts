/**
 * The backup-visibility scenarios' isolated doctor process.
 *
 * doctor() resolves the stores directory from homedir() per call, so a
 * scoped redirect would cover every section but one: the debug-log
 * section imports src/debug.ts, whose LOGS_DIR freezes from homedir()
 * at import — inside the shared vitest worker that freeze has already
 * happened with the REAL home. A fresh process spawned through
 * spawnNodeTs starts its module graph with HOME already redirected, so
 * the whole report — logs section included — describes genuinely the
 * sandbox (same resolution as log-sharing-child).
 *
 * doctor() prints its banner and rendered sections to the console;
 * those lines are captured and discarded — the scenarios assert on the
 * structured result, which this process prints as one JSON array.
 * argv: none.
 */
import { captureConsole, runChildMain } from './child-main.js'

runChildMain(async () => {
  const { result: rows } = await captureConsole(async () => {
    const { doctor } = await import('../../src/server/installer.js')
    return doctor()
  })
  process.stdout.write(JSON.stringify(rows))
})
