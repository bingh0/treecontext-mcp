/**
 * Subprocess writer for the checkpoint numbering race (D329): opens the
 * store file it is given, waits for the barrier's go file, then writes
 * `count` checkpoints under one run's key as fast as it can, printing the
 * numbers the store gave them as JSON. Two of these at once are two
 * genuinely separate writers on one file, which an in-process interleaving
 * of synchronous inserts can never be.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'

const [dbPath, barrier, who, countArg] = process.argv.slice(2)
if (!dbPath || !barrier || !who || !countArg) throw new Error('usage: checkpoint-writer <db> <barrierDir> <who> <count>')
const deadline = Date.now() + 30_000
while (!existsSync(join(barrier, 'go'))) {
  if (Date.now() > deadline) throw new Error('barrier go-file never appeared')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
}
const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
const numbers: number[] = []
for (let i = 0; i < Number(countArg); i++) {
  const r = await store.writeCheckpoint(`state from ${who}, write ${i}`, { run: 'race', key: 'one-key', declared: { role: who } })
  numbers.push(r.checkpoint!.number)
}
await store.close()
process.stdout.write(JSON.stringify(numbers))
