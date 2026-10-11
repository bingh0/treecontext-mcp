/**
 * D265 — the server's per-call schema check, the parts the charter
 * scenario (journal-storage, "a stale server tells the agent to restart")
 * does not reach: the cache window, the uncached re-read on a tool error
 * inside it, and that a stale server takes no lease.
 *
 * Real FlatStore on disk, the production MCP server through the real
 * client handshake; the "newer treecontext's migration" is the store's
 * user_version raised past this build's maxSupportedVersion.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../src/server/server.js'
import { FlatStore } from '../../src/flat-store.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { newerSchemaLine } from '../../src/persistence/migrations.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  cleanups.length = 0
})

async function serve(opts: { lockHook?: () => void } = {}): Promise<{ client: Client; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-stale-reply-'))
  const dbPath = join(dir, 'treecontext.db')
  const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(dbPath)), ownsDatabase: true })
  const server = createServer(store, opts)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stale', version: '0' })
  await server.connect(st)
  await client.connect(ct)
  cleanups.push(async () => {
    await client.close(); await server.close(); await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { client, dbPath }
}

function migratePast(dbPath: string): void {
  const raw = new BetterSqlite3(dbPath)
  raw.pragma(`user_version = ${maxSupportedVersion + 1}`)
  raw.close()
}

const LINE = newerSchemaLine(maxSupportedVersion + 1, maxSupportedVersion)
const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]!.text)

describe('D265: the stale server\'s reply', () => {
  it('a tool error inside the cache window re-reads the version and answers with the line, not the raw error', async () => {
    const { client, dbPath } = await serve()
    // Prime the cache: the store is at this build's head.
    expect((await client.callTool({ name: 'treecontext_status', arguments: {} })).isError).toBeFalsy()
    migratePast(dbPath)
    // Within the window a call that fails — here an export of a missing node — is
    // answered with the restart line, never the error it raised.
    const res = await client.callTool({ name: 'treecontext_export', arguments: { node_id: 'no-such-node' } })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(LINE)
  })

  it('a stale server takes no lease: the version check comes before the lock hook', async () => {
    let locks = 0
    const { client, dbPath } = await serve({ lockHook: () => { locks++ } })
    migratePast(dbPath)
    for (const [name, args] of [['treecontext_query', { query: 'x' }], ['treecontext_insert', { content: 'y' }], ['treecontext_status', {}]] as const) {
      const res = await client.callTool({ name, arguments: args })
      expect(textOf(res), name).toBe(LINE)
    }
    expect(locks).toBe(0)
  })

  it('a store at this build\'s head is served as ever', async () => {
    const { client } = await serve()
    const res = await client.callTool({ name: 'treecontext_insert', arguments: { content: 'an ordinary note' } })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).not.toBe(LINE)
  })
})
