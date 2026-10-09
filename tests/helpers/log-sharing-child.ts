/**
 * The debug-log-sharing redaction scenarios' isolated printer process.
 *
 * installer.ts reads src/debug.ts's LOGS_DIR, which freezes from
 * homedir() at import — inside the shared vitest worker that freeze has
 * already happened with the REAL home. A fresh process spawned through
 * spawnNodeTs starts its module graph with HOME already redirected, so
 * "the logs directory" here is genuinely the sandbox's.
 *
 * Modes:
 *   dump  — seed one debug log naming <secretPath>, print
 *           dumpDebugLogs()'s console output
 *   crash — seed one fatal log line naming <secretPath>, print
 *           doctor()'s console output
 *
 * Prints ONLY the captured console output to stdout (its own diagnostics,
 * if any, go to stderr and the parent treats them as failure noise).
 * argv: <mode> <secretPath>
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { captureConsole, runChildMain } from './child-main.js'

runChildMain(async () => {
  const [mode, secretPath] = process.argv.slice(2)
  if (!mode || !secretPath || !['dump', 'crash'].includes(mode)) {
    throw new Error('usage: log-sharing-child.ts <dump|crash> <secretPath>')
  }

  // Frozen HERE means the redirected home: this process's module graph
  // started with HOME/USERPROFILE/APPDATA pointing at the sandbox.
  const { LOGS_DIR } = await import('../../src/debug.js')
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 })
  const logPath = join(LOGS_DIR, 'debug-2026-01-01T00-00-00-000Z-12345.log')

  const line =
    mode === 'dump'
      ? `[treecontext:dbg +1ms] [bindings] resolving store {"cwd":"${secretPath}"}\n`
      : `[treecontext:fatal +8ms] [serve] Error: SQLITE_CANTOPEN: unable to open ${secretPath}/treecontext.db\n`
  writeFileSync(logPath, '')
  appendFileSync(logPath, line)

  const { dumpDebugLogs, doctor } = await import('../../src/server/installer.js')

  const { lines } = await captureConsole(async () => {
    if (mode === 'dump') await dumpDebugLogs()
    else await doctor()
  })
  process.stdout.write(lines.join('\n'))
})
