/**
 * "A store that refuses writes" (journal-workers, D307): opens an EXISTING
 * store file, takes SQLite's write lock (BEGIN IMMEDIATE, with a write
 * under it) and keeps it, then prints `locked <pid>` and sleeps until
 * killed. Unlike store-locker.cjs this leaves readers alone: a WAL store
 * reads on while no other connection can write, which is the moment a
 * door must tell apart from a store it cannot read at all. It needs no
 * other connection to let go first, so it can be taken while a door holds
 * the store open.
 *
 * The lock is announced only once a separate process has proved it: a
 * writer shut out with "database is locked", while a reader still reads.
 *
 * Plain CJS, a real node process running the real node:sqlite.
 *
 * argv: <dbPath>
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const dbPath = process.argv[2]

if (!existsSync(dbPath)) {
  process.stderr.write(`store-write-locker: no store at ${dbPath}\n`)
  process.exit(1)
}
const db = new DatabaseSync(dbPath, { timeout: 15000 })
db.exec('BEGIN IMMEDIATE')
const version = Number(db.prepare('PRAGMA user_version').get().user_version)
db.exec(`PRAGMA user_version = ${version}`)

const PROBE = `const { DatabaseSync } = require('node:sqlite');
const p = new DatabaseSync(${JSON.stringify(dbPath)}, { timeout: 100 });
let read = 'no'; try { p.prepare('SELECT 1 FROM nodes LIMIT 1').all(); read = 'yes' } catch (e) { read = 'no' }
try { p.exec('BEGIN IMMEDIATE'); p.exec('ROLLBACK'); console.log('wrote ' + read) } catch (e) { console.log((/locked/.test(e.message) ? 'blocked ' : 'error ') + read) }`

const deadline = Date.now() + 15_000
for (;;) {
  const r = spawnSync(process.execPath, ['-e', PROBE], { encoding: 'utf8' })
  if ((r.stdout ?? '').trim() === 'blocked yes') break
  if (Date.now() > deadline) {
    process.stderr.write(`store-write-locker: could not prove the write lock (${(r.stdout ?? '').trim()} ${r.stderr ?? ''})\n`)
    process.exit(1)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
}
process.stdout.write(`locked ${process.pid}\n`)
globalThis.storeWriteLockerHandle = db
setInterval(() => { void globalThis.storeWriteLockerHandle }, 1 << 30)
