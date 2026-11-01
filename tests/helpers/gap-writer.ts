/**
 * A hook that drops events, many of them, as fast as it can: each line
 * through the production writer of the gap ledger (recordHookGap), for the
 * claim's race test. argv: <dbPath> <label> <count>.
 */
import { recordHookGap } from '../../src/hooks/gap-ledger.js'

const [dbPath, label, count] = process.argv.slice(2)
for (let i = 0; i < Number(count); i++) {
  recordHookGap(dbPath!, { id: `${label}-${i}`, hook: 'post-tool-use', sessionId: label!, at: Date.now() / 1000, error: 'locked', lost: 'a tool call' })
}
