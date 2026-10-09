/**
 * flat-store-role-weights.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion preserved verbatim. Teardown
 * became per-fixture defer with close-before-unlink ordering preserved —
 * the Windows open-handle constraint the original comments on.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { parseToolResult } from '../helpers/mcp-result.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  userId?: string
  assistantId?: string
  order?: string[]
  newRanked?: Array<{ rowid: number; score: number }>
  legacyRanked?: Array<{ rowid: number; score: number }>
  client?: Client
  server?: Awaited<ReturnType<typeof createServer>>
  /** Scenario-local store and fixture ids (S1/S2/S4 share shapes). */
  s?: FlatStore
  u1?: string
  u2?: string
  newDb?: InstanceType<typeof BetterSqlite3>
  legacyDb?: InstanceType<typeof BetterSqlite3>
}

/** This tier reads tool responses loosely — the shared cast lives in
 *  helpers/mcp-result, the loose shape stays local. */
const parse = (res: unknown): any => parseToolResult(res)

export const flatStoreRoleWeightsDefiner = (reg: Registry<World>): void => {
  function freshTmp(w: World, prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  async function freshStore(w: World, dir: string, name = 'flat.db'): Promise<FlatStore> {
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    // Registered after the dir's rm defer: defer runs LIFO, so the store
    // closes before its directory unlinks (the Windows constraint).
    w.defer(() => store.close())
    return store
  }

  reg.define(/^two nodes matching the query equally, one via user text and one via assistant text$/, async (w) => {
    const dir = freshTmp(w, 'tc-role-weights-')
    const store = await freshStore(w, dir)
    // The assistant node is inserted FIRST (audit run 1): scores tie
    // here and `ORDER BY score ASC` has no tie-break, so insertion
    // order wins a tie — the user node can only rank first if the
    // default weight differential genuinely re-ranked it.
    w.assistantId = (
      await store.insert('shared query term beta', { metadata: { source: 'auto-capture', role: 'assistant' } })
    ).nodeId
    w.userId = (await store.insert('shared query term alpha', { metadata: { source: 'auto-capture', role: 'user' } })).nodeId
    w.s = store
  })

  reg.define(/^queried with default weights$/, async (w) => {
    const store = w.s!
    const results = await store.query('shared query term', { topK: 5 })
    w.order = results.map((r) => r.nodeId)
  })

  reg.define(/^the user-text node ranks first$/, (w) => {
    expect(w.order!.indexOf(w.userId!)).toBeLessThan(w.order!.indexOf(w.assistantId!))
  })

  reg.define(/^the same two nodes$/, async (w) => {
    const dir = freshTmp(w, 'tc-role-weights-')
    const store = await freshStore(w, dir)
    w.userId = (await store.insert('shared query term alpha', { metadata: { source: 'auto-capture', role: 'user' } })).nodeId
    w.assistantId = (
      await store.insert('shared query term beta', { metadata: { source: 'auto-capture', role: 'assistant' } })
    ).nodeId
    w.s = store
  })

  reg.define(/^queried with the assistant weight raised above the user weight$/, async (w) => {
    const results = await w.s!.query('shared query term', {
      topK: 5,
      roleWeights: { user: 1.0, assistant: 5.0 },
    })
    w.order = results.map((r) => r.nodeId)
  })

  reg.define(/^the assistant-text node overtakes$/, (w) => {
    expect(w.order!.indexOf(w.assistantId!)).toBeLessThan(w.order!.indexOf(w.userId!))
  })

  reg.define(
    /^a fixture corpus split across the 4 role columns per production's exclusive attribution rule$/,
    (w) => {
      const rows: Array<{ user: string; assistant: string; tool: string; note: string }> = [
        { user: 'target word here', assistant: '', tool: '', note: '' },
        { user: '', assistant: 'target word here', tool: '', note: '' },
        { user: '', assistant: '', tool: 'target appears here too', note: '' },
        { user: '', assistant: '', tool: '', note: 'unrelated filler padding text more filler here' },
        { user: '', assistant: '', tool: '', note: 'unrelated filler padding text more filler here' },
      ]

      const newDb = new BetterSqlite3(':memory:')
      newDb.exec("CREATE VIRTUAL TABLE fts USING fts5(user_text, assistant_text, tool_text, note_text, content='')")
      const insNew = newDb.prepare('INSERT INTO fts(rowid, user_text, assistant_text, tool_text, note_text) VALUES (?, ?, ?, ?, ?)')

      const legacyDb = new BetterSqlite3(':memory:')
      legacyDb.exec("CREATE VIRTUAL TABLE fts USING fts5(content, content='')")
      const insLegacy = legacyDb.prepare('INSERT INTO fts(rowid, content) VALUES (?, ?)')

      rows.forEach((r, i) => {
        insNew.run(i + 1, r.user, r.assistant, r.tool, r.note)
        insLegacy.run(i + 1, [r.user, r.assistant, r.tool, r.note].filter(Boolean).join(' '))
      })
      w.newDb = newDb
      w.legacyDb = legacyDb
    },
  )

  reg.define(
    /^ranked multi-column with all-ones weights and compared to a single-column control over the same effective text$/,
    (w) => {
      w.newRanked = w.newDb!
        .prepare('SELECT rowid, bm25(fts, 1.0, 1.0, 1.0, 1.0) AS score FROM fts WHERE fts MATCH ? ORDER BY score, rowid')
        .all('target') as Array<{ rowid: number; score: number }>
      w.legacyRanked = w.legacyDb!
        .prepare('SELECT rowid, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY score, rowid')
        .all('target') as Array<{ rowid: number; score: number }>
      w.newDb!.close()
      w.legacyDb!.close()
    },
  )

  reg.define(
    /^the orderings and raw scores are identical, correcting FG-1's all-ones-vs-legacy claim \(see spec Deviation Log D1\)$/,
    (w) => {
      expect(w.newRanked!.map((r) => r.rowid)).toEqual(w.legacyRanked!.map((r) => r.rowid))
      expect(w.newRanked!.map((r) => r.score)).toEqual(w.legacyRanked!.map((r) => r.score))
    },
  )

  reg.define(/^a node matching only via assistant text among user-text matches$/, async (w) => {
    const dir = freshTmp(w, 'tc-role-weights-')
    const store = await freshStore(w, dir)
    const userId1 = (await store.insert('needle term in user text one', { metadata: { source: 'auto-capture', role: 'user' } })).nodeId
    const userId2 = (await store.insert('needle term in user text two', { metadata: { source: 'auto-capture', role: 'user' } })).nodeId
    w.assistantId = (
      await store.insert('needle term only in assistant text', { metadata: { source: 'auto-capture', role: 'assistant' } })
    ).nodeId
    w.s = store
    w.u1 = userId1
    w.u2 = userId2
  })

  reg.define(/^queried with assistant weight zero$/, async (w) => {
    const results = await w.s!.query('needle term', { topK: 10, roleWeights: { assistant: 0 } })
    w.order = results.map((r) => r.nodeId)
  })

  reg.define(/^the node appears after every user-text match instead of disappearing$/, (w) => {
    
    expect(w.order!).toContain(w.assistantId!)
    const assistantRank = w.order!.indexOf(w.assistantId!)
    expect(assistantRank).toBeGreaterThan(w.order!.indexOf(w.u1!))
    expect(assistantRank).toBeGreaterThan(w.order!.indexOf(w.u2!))
  })

  reg.define(/^a server over a lexical store with the two-node fixture$/, async (w) => {
    const dir = freshTmp(w, 'tc-role-weights-mcp-')
    const store = await freshStore(w, dir, 'mcp.db')
    w.server = createServer(store, {})
    const [ct, st] = InMemoryTransport.createLinkedPair()
    w.client = new Client({ name: 't', version: '0' })
    await w.server.connect(st)
    await w.client.connect(ct)
    w.defer(async () => {
      await w.client!.close()
      await w.server!.close()
      await store.close()
    })

    const userRes = parse(
      await w.client.callTool({
        name: 'treecontext_insert',
        arguments: { content: 'shared query term alpha', metadata: { source: 'auto-capture', role: 'user' } },
      }),
    )
    w.userId = userRes.node_id
    const assistantRes = parse(
      await w.client.callTool({
        name: 'treecontext_insert',
        arguments: { content: 'shared query term beta', metadata: { source: 'auto-capture', role: 'assistant' } },
      }),
    )
    w.assistantId = assistantRes.node_id
  })

  reg.define(/^treecontext_query passes role_weights favoring assistant text$/, async (w) => {
    const res = parse(
      await w.client!.callTool({
        name: 'treecontext_query',
        arguments: {
          query: 'shared query term',
          top_k: 5,
          role_weights: { user: 1.0, assistant: 5.0 },
        },
      }),
    )
    w.order = res.results.map((r: { nodeId: string }) => r.nodeId)
  })

  reg.define(/^the result order reflects the override$/, (w) => {
    expect(w.order!.indexOf(w.assistantId!)).toBeLessThan(w.order!.indexOf(w.userId!))
  })
}
