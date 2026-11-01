/**
 * The MCP initialize result's serverInfo.version is the package's own
 * version (it was a hard-coded '1.0.0' while package.json said beta.3).
 * The expectation reads package.json independently of the server module.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'

describe('serverInfo', () => {
  it('reports the package.json version and the server name to a connecting client', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-ver-'))
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }
      const db = openNodeSqlite(new DatabaseSync(join(dir, 'v.db')))
      const store = await FlatStore.open({ database: db, ownsDatabase: true })
      const server = createServer(store, {})
      const [ct, st] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 't', version: '0' })
      await server.connect(st)
      await client.connect(ct)
      const info = client.getServerVersion()
      expect(info?.name).toBe('treecontext')
      expect(info?.version).toBe(pkg.version)
      expect(info?.version).not.toBe('1.0.0')
      await client.close(); await server.close(); await store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
