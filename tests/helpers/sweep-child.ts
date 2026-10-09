/**
 * The backup-sweep scenarios' isolated sweep process.
 *
 * The sweep reads DEFAULT_STORES_DIR, frozen from homedir() at import of
 * src/tools/stores.ts — in the shared vitest worker that freeze has
 * already happened with the REAL home, so the sweep runs here, in a
 * process whose module graph starts with HOME redirected (the
 * doctor-backup-child resolution).
 *
 * Deletion-failure worlds ("the filesystem will not let the sweep …")
 * arrive as TC_FAIL_RM: the exact path rmSync must refuse. The old
 * binding staged these with vi.mock('node:fs'), which in the shared gnt
 * runner would leak the mock into every other feature; here fs.rmSync
 * is patched on the CJS exports BEFORE the CLI graph is imported, and
 * syncBuiltinESMExports() propagates the patch into the ESM named
 * binding src/tools/stores.ts holds. chmod staging is POSIX-only (and
 * root ignores it), and a sidecar-only failure cannot be staged on a
 * real filesystem at all — any permission state that blocks the sidecar
 * blocks the backup beside it.
 *
 * argv: sweep flags verbatim (--yes, --store <name>). stdout: one JSON
 * object { logs, exitCode } — logs is every console.log/error line the
 * sweep printed, exitCode is the process.exitCode the run left behind
 * (undefined is what the OS reads as 0, normalized here, once).
 */
import { createRequire } from 'node:module'

import { captureConsole, runChildMain } from './child-main.js'

const requireCjs = createRequire(import.meta.url)

const failPath = process.env.TC_FAIL_RM
if (failPath) {
  const fs = requireCjs('node:fs') as typeof import('node:fs')
  const realRmSync = fs.rmSync
  fs.rmSync = ((path: Parameters<typeof realRmSync>[0], opts?: Parameters<typeof realRmSync>[1]) => {
    if (String(path) === failPath) {
      throw Object.assign(new Error('EPERM: pinned by test (sweep-child)'), { code: 'EPERM' })
    }
    return realRmSync(path, opts)
  }) as typeof realRmSync
  ;(requireCjs('node:module') as typeof import('node:module')).syncBuiltinESMExports()
}

runChildMain(async () => {
  const yes = process.argv.includes('--yes')
  const storeIdx = process.argv.indexOf('--store')
  const store = storeIdx === -1 ? null : process.argv[storeIdx + 1]!

  // captureError: the CLI's log() prints to stderr — stdout is the MCP
  // protocol channel — so both streams are one transcript here.
  const { lines: logs } = await captureConsole(async () => {
    const { runStores } = await import('../../src/server/cli.js')
    type CliArgs = Parameters<typeof runStores>[0]
    await runStores({ storesAction: 'sweep', yes, store } as CliArgs)
  }, { captureError: true })
  process.stdout.write(JSON.stringify({
    logs,
    exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode),
  }))
})
