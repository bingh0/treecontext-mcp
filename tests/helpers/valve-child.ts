/**
 * The mid-sprint valve run (journal-reorientation, D178): opens an
 * EXISTING store the way a long-lived server does — the library open with
 * its default archive destination beside the store — under a byte budget
 * the store is already past, runs the retention valve once, and reports.
 *
 * Its own process on purpose: stdin is left open and never written, so a
 * valve that ever stopped to ask the developer anything would hang here
 * rather than pass, and everything it says lands on the two streams the
 * binding reads.
 *
 * argv: <dbPath> <maxStoreBytes>. stdout: one JSON line
 * { before, after, budget, swept }.
 */
import BetterSqlite3 from 'better-sqlite3'
import { FlatStore } from '../../src/flat-store.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'

const [dbPath, budgetRaw] = process.argv.slice(2)
const store = await FlatStore.open({
  database: wrapBetterSqlite(new BetterSqlite3(dbPath!)),
  ownsDatabase: true,
  maxStoreBytes: Number(budgetRaw),
  retentionInterval: 1_000_000,
})
const before = store.status().retention!.storeBytes
const swept = store.retentionSweep()
const after = store.status().retention!.storeBytes
store.close()
process.stdout.write(JSON.stringify({ before, after, budget: Number(budgetRaw), swept }) + '\n')
process.exit(0)
