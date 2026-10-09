/**
 * The stores-list scenarios' isolated listing process.
 *
 * src/tools/stores.ts's DEFAULT_STORES_DIR freezes from homedir() at
 * import, and runStores() passes no directory — the default parameters
 * in listStores() bound that constant when the module graph evaluated.
 * Inside the shared vitest worker the real home is already frozen (and
 * a scoped redirect could only help consumers resolving per call), so
 * the honest listing of a sandboxed stores directory comes from a fresh
 * process whose HOME was redirected before any module here evaluates
 * (spawnNodeTs sets HOME/USERPROFILE/APPDATA first).
 *
 * Captures runStores({ storesAction: 'list' })'s console.log lines and
 * prints them joined to stdout; console.error chatter is silenced, as
 * the in-process capture did. argv: none.
 */
import type { CliArgs } from '../../src/server/cli.js'

import { captureConsole, runChildMain } from './child-main.js'

runChildMain(async () => {
  const { runStores } = await import('../../src/server/cli.js')
  const { lines } = await captureConsole(() => runStores({ storesAction: 'list' } as CliArgs))
  process.stdout.write(lines.join('\n'))
})
