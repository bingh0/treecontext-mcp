/**
 * "Another process holds the store locked" (journal-reorientation, D175):
 * opens an EXISTING store file, takes SQLite's exclusive lock and keeps
 * it — locking_mode EXCLUSIVE plus an open write transaction, the one
 * shape that makes even a WAL store's readers wait — then prints
 * `locked <pid>` and sleeps until killed. Releasing the lock is the
 * process going away, which is exactly what doctor's fix does.
 *
 * Robust to however the store was made (review finding 9): it waits out
 * any connection still finishing on the file, takes the lock with a write
 * that needs no table (user_version rewritten to its own value), and does
 * not announce the lock until a separate process has PROVED it — a reader
 * shut out with "database is locked". Until then it writes again and
 * re-checks, for up to 15 s; a lock it cannot prove is an exit 1, never a
 * false "locked".
 *
 * Plain CJS, like crash-writer.cjs: a real node process running the real
 * node:sqlite, no loader in between.
 *
 * argv: <dbPath>
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const dbPath = process.argv[2]

// An EXISTING store only: node:sqlite has no fileMustExist, and a lock on a
// file this helper minted would be a false "locked" (its own rule above).
if (!existsSync(dbPath)) {
  process.stderr.write(`store-locker: no store at ${dbPath}\n`)
  process.exit(1)
}
const db = new DatabaseSync(dbPath, { timeout: 15000 })
db.exec('PRAGMA locking_mode = EXCLUSIVE')
db.exec('BEGIN EXCLUSIVE')
const version = Number(db.prepare('PRAGMA user_version').get().user_version)

const PROBE = `const { DatabaseSync } = require('node:sqlite');
const p = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true, timeout: 100 });
try { p.prepare('PRAGMA user_version').get(); console.log('read') } catch (e) { console.log(/locked/.test(e.message) ? 'blocked' : 'error ' + e.message) }`

const deadline = Date.now() + 15_000
for (;;) {
  db.exec(`PRAGMA user_version = ${version}`)
  const r = spawnSync(process.execPath, ['-e', PROBE], { encoding: 'utf8' })
  if ((r.stdout ?? '').trim() === 'blocked') break
  if (Date.now() > deadline) {
    process.stderr.write(`store-locker: could not prove the lock (${(r.stdout ?? '').trim()} ${r.stderr ?? ''})\n`)
    process.exit(1)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
}
process.stdout.write(`locked ${process.pid}\n`)
// The handle must stay reachable: nothing else refers to `db` once this
// module body returns, and a garbage-collected Database is closed — the
// lock with it. That was the fixture's sensitivity (finding 9): whether
// the lock survived depended on when V8 happened to collect.
globalThis.storeLockerHandle = db
setInterval(() => { void globalThis.storeLockerHandle }, 1 << 30)
