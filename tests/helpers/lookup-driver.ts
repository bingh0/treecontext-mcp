/**
 * The harness's key lookup (FlatStore.lookupKey, the library call a
 * harness makes, D289) as a process of its own, so a binding can make it
 * from where the scenario puts the harness: inside a sandbox that numbers
 * its own processes (D403, tests/journal/standins.ts `lookupInSandbox`).
 * It prints what the lookup returned of each leg and its notes, as JSON.
 *
 * argv: <store file> <run> <key>
 */
import { DatabaseSync } from 'node:sqlite'
import { FlatStore } from '../../src/flat-store.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'

const [dbPath, run, key] = process.argv.slice(2) as [string, string, string]
const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), ownsDatabase: true })
try {
  const l = store.lookupKey({ run, key })
  process.stdout.write(JSON.stringify({
    legs: l.legs.map((g) => ({ sessionId: g.sessionId, state: g.state, noticedAt: g.noticedAt, noticedBy: g.noticedBy })),
    notes: l.notes,
    unchecked: l.phantoms.unchecked.map((u) => ({ sessionId: u.ref.sessionId, reason: u.reason })),
    retired: l.phantoms.retired.map((r) => r.ref.sessionId),
  }))
} finally {
  await store.close()
}
