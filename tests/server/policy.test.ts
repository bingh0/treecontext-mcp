/**
 * Policy tool-gating tests.
 *
 * Verifies each policy registers exactly the expected subset of tools
 * by driving `createServer` over an in-memory MCP transport and
 * calling `client.listTools()`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { policyAllows, POLICIES, type Policy } from '../../src/server/policy.js'

async function listToolsForPolicy(
  tmp: string,
  policy: Policy,
): Promise<{ tools: string[]; close: () => Promise<void> }> {
  const raw = new BetterSqlite3(join(tmp, `${policy}.db`))
  const db = wrapBetterSqlite(raw)
  const ctx = await FlatStore.open({ database: db, ownsDatabase: true })
  const server = createServer(ctx, { policy })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const list = await client.listTools()
  const tools = list.tools.map((t) => t.name).sort()
  return {
    tools,
    close: async () => {
      await client.close()
      await server.close()
      await ctx.close()
    },
  }
}

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tc-policy-'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('policyAllows', () => {
  it('full grants every tool', () => {
    expect(policyAllows('full', 'treecontext_delete')).toBe(true)
    expect(policyAllows('full', 'treecontext_import')).toBe(true)
    expect(policyAllows('full', 'treecontext_merge_from_agent')).toBe(true)
  })
  it('read_only denies mutations', () => {
    expect(policyAllows('read_only', 'treecontext_insert')).toBe(false)
    expect(policyAllows('read_only', 'treecontext_delete')).toBe(false)
    expect(policyAllows('read_only', 'treecontext_merge_from_agent')).toBe(false)
    expect(policyAllows('read_only', 'treecontext_query')).toBe(true)
    expect(policyAllows('read_only', 'treecontext_export')).toBe(true)
  })
  it('contributor permits insert but blocks delete/clear/import/merge', () => {
    expect(policyAllows('contributor', 'treecontext_insert')).toBe(true)
    expect(policyAllows('contributor', 'treecontext_delete')).toBe(false)
    expect(policyAllows('contributor', 'treecontext_clear')).toBe(false)
    expect(policyAllows('contributor', 'treecontext_import')).toBe(false)
    expect(policyAllows('contributor', 'treecontext_merge_from_agent')).toBe(false)
  })
})

describe('createServer tool registration by policy', () => {
  it('full registers all 8 tools', async () => {
    const { tools, close } = await listToolsForPolicy(tmp, 'full')
    expect(tools.length).toBe(8)
    expect(tools).toContain('treecontext_delete')
    expect(tools).toContain('treecontext_import')
    expect(tools).toContain('treecontext_merge_from_agent')
    await close()
  })

  it('read_only registers only the read-side tools', async () => {
    const { tools, close } = await listToolsForPolicy(tmp, 'read_only')
    expect(tools.sort()).toEqual([
      'treecontext_export',
      'treecontext_query',
      'treecontext_status',
    ])
    await close()
  })

  it('contributor registers reads + insert', async () => {
    const { tools, close } = await listToolsForPolicy(tmp, 'contributor')
    expect(tools).toContain('treecontext_insert')
    expect(tools).not.toContain('treecontext_delete')
    expect(tools).not.toContain('treecontext_clear')
    expect(tools).not.toContain('treecontext_import')
    expect(tools).not.toContain('treecontext_merge_from_agent')
    await close()
  })

  it('covers all declared policies', () => {
    expect(POLICIES).toContain('full')
    expect(POLICIES).toContain('read_only')
    expect(POLICIES).toContain('contributor')
  })
})
