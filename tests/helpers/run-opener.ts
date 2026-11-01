/**
 * Subprocess registrar for the run-open race (D302): opens the store file
 * it is given, waits for the barrier's go file, then registers one worker
 * in each of `count` fresh runs, as fast as it can. Two of these at once
 * are two first legs of every run registering together.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'

const [dbPath, barrier, who, countArg] = process.argv.slice(2)
if (!dbPath || !barrier || !who || !countArg) throw new Error('usage: run-opener <db> <barrierDir> <who> <count>')
const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
const deadline = Date.now() + 30_000
while (!existsSync(join(barrier, 'go'))) {
  if (Date.now() > deadline) throw new Error('barrier go-file never appeared')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
}
for (let i = 0; i < Number(countArg); i++) {
  await store.registerWorker({
    sessionId: `${who}-${i}`, door: 'library',
    ticket: { parent: { id: 'p1' }, run: `race-${i}`, key: 'k', role: who },
    process: { pid: null, start: null, host: 'laptop' },
  })
}
await store.close()
