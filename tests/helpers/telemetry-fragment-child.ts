/**
 * The telemetry-privacy fragment scenario's isolated query process.
 *
 * The 40-character bound lives in the server's query handler
 * (src/server/server.ts dbg('server', 'query-telemetry', …)), and the
 * debug sink's directory freezes from homedir() at import
 * (src/debug.ts LOGS_DIR). Inside the shared vitest worker that freeze
 * has already happened with the REAL home — earlier steps modules pull
 * src/flat-store.ts, which imports debug.js — so the only honest way to
 * exercise "the log file users are told to paste" is a fresh process
 * whose module graph starts with HOME already redirected. The parent
 * spawns this script through spawnNodeTs (helpers/cli-spawn.ts), which
 * sets HOME/USERPROFILE/APPDATA from its `home` argument before any
 * module here evaluates.
 *
 * Drives the same served-journal surface the scenario always used:
 * createServer + InMemoryTransport + Client, one insert, one query.
 * argv: <longQuery>
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import BetterSqlite3 from 'better-sqlite3'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { SessionStats } from '../../src/server/session-stats.js'
import { enableDebug } from '../../src/debug.js'

import { runChildMain } from './child-main.js'

runChildMain(async () => {
  const longQuery = process.argv[2]
  if (!longQuery) throw new Error('usage: telemetry-fragment-child.ts <longQuery>')

  enableDebug()

  const dir = mkdtempSync(join(tmpdir(), 'tc-telemetry-fragment-'))
  const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
  const store = await FlatStore.open({ database: db, ownsDatabase: true })
  const server = createServer(store, { info: { storePath: join(dir, 'store.db') }, sessionStats: new SessionStats() })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0' })
  await server.connect(st)
  await client.connect(ct)

  await client.callTool({ name: 'treecontext_insert', arguments: { content: 'aurora basilisk chandelier' } })
  await client.callTool({ name: 'treecontext_query', arguments: { query: longQuery, top_k: 1 } })

  await client.close()
  await server.close()
  await store.close()
})
