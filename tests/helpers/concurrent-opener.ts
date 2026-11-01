/**
 * Subprocess for the simultaneous-open regression (node-sqlite.ts, the
 * wrapped opener's pragmas): waits for the barrier's go file, then wraps a
 * DatabaseSync built with node:sqlite's OWN defaults (busy timeout 0 — the
 * shape checkpoint-writer.ts and every `openNodeSqlite(new DatabaseSync())`
 * caller has) and runs the opener's pragma list, then a short write so
 * the openers overlap. Exit 0 on success; the error on stderr and exit 1
 * otherwise.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'

const [dbPath, barrier] = process.argv.slice(2)
if (!dbPath || !barrier) throw new Error('usage: concurrent-opener <db> <barrierDir>')
const deadline = Date.now() + 30_000
while (!existsSync(join(barrier, 'go'))) {
  if (Date.now() > deadline) throw new Error('barrier go-file never appeared')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
}
try {
  const raw = new DatabaseSync(dbPath)
  const db = openNodeSqlite(raw)
  for (let i = 0; i < 20; i++) db.exec('BEGIN IMMEDIATE; COMMIT')
  raw.close()
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
}
