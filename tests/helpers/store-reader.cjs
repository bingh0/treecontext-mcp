/**
 * A process that merely has the store open — the stand-in for a running
 * `treecontext serve` beside a lock (journal-reorientation, D175). It
 * opens the file and holds the handle, never a lock; doctor must list it
 * as open and never put it in the kill. Prints `open <pid>`, sleeps.
 *
 * argv: <dbPath>
 */
const { createRequire } = require('node:module')
const { join } = require('node:path')
const repoRequire = createRequire(join(__dirname, '..', '..', 'package.json'))
const BetterSqlite3 = repoRequire('better-sqlite3')

const db = new BetterSqlite3(process.argv[2], { readonly: true, fileMustExist: true })
process.stdout.write(`open ${process.pid}\n`)
// Kept reachable, or garbage collection would close the handle.
globalThis.storeReaderHandle = db
setInterval(() => { void globalThis.storeReaderHandle }, 1 << 30)
