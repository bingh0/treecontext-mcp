/**
 * A process that merely has the store open — the stand-in for a running
 * `treecontext serve` beside a lock (journal-reorientation, D175). It
 * opens the file and holds the handle, never a lock; doctor must list it
 * as open and never put it in the kill. Prints `open <pid>`, sleeps.
 *
 * argv: <dbPath>
 */
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync(process.argv[2], { readOnly: true })
process.stdout.write(`open ${process.pid}\n`)
// Kept reachable, or garbage collection would close the handle.
globalThis.storeReaderHandle = db
setInterval(() => { void globalThis.storeReaderHandle }, 1 << 30)
