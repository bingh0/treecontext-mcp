/**
 * The concurrent-sessions scenario's second session (journal-storage
 * charter). A separate process that does what a second live session's
 * hooks actually do: stage captures directly into the shared store —
 * and what a second same-namespace server would try first: take the
 * tool-writer lease for its namespace and the store's drain lease
 * (G4, tests/server/design/store-as-arbiter.md §3).
 *
 * Runs under tsx so the lease attempts go through the PRODUCTION
 * LeaseClient against the shared table from a genuinely different pid —
 * denial here is the real mechanism refusing a second writer, not a
 * reimplementation agreeing with itself (G4 review, finding 10).
 *
 * argv: <dbPath> <count>
 * stdout protocol: `ns lease denied` | `ns lease acquired` and
 * `drain lease denied` | `drain lease acquired`, then `staged <i>` per
 * committed capture.
 */
import BetterSqlite3 from 'better-sqlite3'
import { hostname } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { LeaseClient, NS_LEASE_TTL_SECS, DRAIN_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import { StoreLockedError } from '../../src/errors/index.js'

const [dbPath, countRaw] = process.argv.slice(2)
const count = Number(countRaw)

const db = wrapBetterSqlite(new BetterSqlite3(dbPath!))
const leases = new LeaseClient(db, { pid: process.pid, host: hostname(), label: 'concurrent-session-b' })

// 1. A second same-namespace writer and a second drain owner must both
//    be refused: live foreign lease rows in the shared table.
function attempt(role: string, ttlSecs: number, label: string): void {
  try {
    leases.tryAcquire(role, ttlSecs)
    process.stdout.write(`${label} acquired\n`) // the test fails on this line
  } catch (err) {
    if (!(err instanceof StoreLockedError)) throw err
    process.stdout.write(`${label} denied\n`)
  }
}
attempt('ns:project', NS_LEASE_TTL_SECS, 'ns lease')
attempt('drain', DRAIN_LEASE_TTL_SECS, 'drain lease')

// 2. Captures are staged anyway — hooks never hold a writer role.
const insert = db.prepare(
  'INSERT INTO staging (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
)
for (let i = 0; i < count; i++) {
  insert.run(
    'concurrent-b',
    'user',
    `concurrent capture b-${i} :: written by the second session while the writer ingested`,
    1_700_000_000 + i,
  )
  process.stdout.write(`staged ${i}\n`)
}
db.close()
