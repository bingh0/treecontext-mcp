/**
 * conversation_window shipped default — MCP layer defaults to 2 on
 * windowing backends (spec amendment 2026-07-05). This doc header IS
 * the spec since the absorb pass (2026-07-25): the companion
 * query-window-default.feature was retired — its scenarios were executed
 * by nothing while the tests below covered every pin under mirrored
 * names. The pins: omitted parameter applies the default on a windowing
 * backend; explicit 0 disables; any explicit value (above OR below 2)
 * overrides; the default is exactly 2; time_range filters hits before
 * windows attach so anchor refs always resolve and excluded hits cannot
 * claim neighbors; session-less hits carry no window stub; namespace
 * exclusion filters before window claiming; the default changes only
 * decoration, never ranking. Library-level "omitted = off" semantics are
 * covered by features/design/flat-store-conversation-window.feature
 * (bound in tests/steps/flat-store-conversation-window.steps.ts since the
 * 2026-08-26 executor migration, which retired the .test.ts this header
 * used to name) and are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { DEFAULT_CONVERSATION_WINDOW } from '../../src/core/types.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-wdef-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

interface WindowEntryLite { nodeId: string; content?: string }
interface WindowLite {
  before: WindowEntryLite[]
  after: WindowEntryLite[]
  anchor?: WindowEntryLite | { ref: string } | null
  omitted?: string
}
interface ResultLite { nodeId: string; createdAt: number; window?: WindowLite }
interface QueryResponseLite { results: ResultLite[] }

function parse(res: unknown): QueryResponseLite {
  const first = (res as { content: Array<{ text: string }> }).content[0]
  if (!first) throw new Error('empty MCP response')
  return JSON.parse(first.text) as QueryResponseLite
}

async function flatHarness(name = 'flat.db') {
  const db = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, name)))
  const store = await FlatStore.open({ database: db, ownsDatabase: true })
  const server = createServer(store, {})
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0' })
  await server.connect(st); await client.connect(ct)
  return { client, close: async () => { await client.close(); await server.close(); await store.close() } }
}

/** Insert a session of `n` entries; the entry at `needleAt` carries the
 *  unique query token. Same session_id throughout (window page boundary). */
const tick = () => new Promise((r) => setTimeout(r, 15))

async function insertSession(client: Client, n: number, needleAt: number, sid = 's1') {
  for (let i = 0; i < n; i++) {
    const body = i === needleAt
      ? 'entry with the zanzibar needle token'
      : `filler entry number ${String(i)} about routine matters`
    await client.callTool({
      name: 'treecontext_insert',
      arguments: { content: body, metadata: { session_id: sid, role: 'assistant', source: 'auto-capture' } },
    })
  }
}

describe('conversation_window shipped default (AC: query-window-default.feature)', () => {
  it('omitted parameter on a FlatStore backend applies the default window of 2', async () => {
    const h = await flatHarness()
    await insertSession(h.client, 5, 2)
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 1 } }))
    expect(q.results.length).toBe(1)
    const w = q.results[0]?.window
    expect(w).toBeDefined()
    expect(w?.before.length).toBe(2)
    expect(w?.after.length).toBe(2)
    await h.close()
  })

  it('explicit 0 disables the window entirely', async () => {
    const h = await flatHarness('zero.db')
    await insertSession(h.client, 5, 2)
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 1, conversation_window: 0 } }))
    expect(q.results.length).toBe(1)
    expect(q.results[0]?.window).toBeUndefined()
    await h.close()
  })

  it('an explicit value overrides the default', async () => {
    const h = await flatHarness('four.db')
    await insertSession(h.client, 9, 4)
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 1, conversation_window: 4 } }))
    const w = q.results[0]?.window
    expect(w?.before.length).toBe(4)
    expect(w?.after.length).toBe(4)
    await h.close()
  })

  it('the default changes only decoration, never ranking', async () => {
    const h = await flatHarness('rank.db')
    await insertSession(h.client, 6, 1)
    const args = { query: 'filler entry routine matters', top_k: 4 }
    const defaulted = parse(await h.client.callTool({ name: 'treecontext_query', arguments: args }))
    const bare = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { ...args, conversation_window: 0 } }))
    const ids = (r: QueryResponseLite) => r.results.map((x) => x.nodeId)
    expect(ids(defaulted)).toEqual(ids(bare))
    await h.close()
  })

  it('the shipped default is exactly 2, not merely at-least-2; the constant pins to spec', async () => {
    expect(DEFAULT_CONVERSATION_WINDOW).toBe(2) // spec amendment 2026-07-05
    const h = await flatHarness('pin.db')
    await insertSession(h.client, 9, 4) // 4 available per side — a larger default would show
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 1 } }))
    const w = q.results[0]?.window
    expect(w?.before.length).toBe(DEFAULT_CONVERSATION_WINDOW)
    expect(w?.after.length).toBe(DEFAULT_CONVERSATION_WINDOW)
    await h.close()
  })

  it('an explicit value BELOW the default overrides it (not max(explicit, default))', async () => {
    const h = await flatHarness('one.db')
    await insertSession(h.client, 5, 2)
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 1, conversation_window: 1 } }))
    const w = q.results[0]?.window
    expect(w?.before.length).toBe(1)
    expect(w?.after.length).toBe(1)
    await h.close()
  })

  it('time_range filters hits before windows attach — anchor refs always resolve within the response', async () => {
    const h = await flatHarness('tr.db')
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'user directive zanzibar needle please investigate', metadata: { session_id: 's1', role: 'user', source: 'auto-capture' } } })
    await tick()
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'assistant answer zanzibar needle was found in the cache layer', metadata: { session_id: 's1', role: 'assistant', source: 'auto-capture' } } })
    const all = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 2, conversation_window: 0 } }))
    expect(all.results.length).toBe(2)
    const times = all.results.map((r) => r.createdAt).sort((a, b) => a - b)
    const mid = ((times[0] ?? 0) + (times[1] ?? 0)) / 2
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar needle', top_k: 2, time_range: { after: mid } } }))
    // The older (user) entry is out of range: it must not be a hit…
    expect(q.results.length).toBe(1)
    // …and every anchor must materialize or ref a node present in the response.
    const present = new Set<string>()
    for (const r of q.results) {
      present.add(r.nodeId)
      for (const e of [...(r.window?.before ?? []), ...(r.window?.after ?? [])]) present.add(e.nodeId)
    }
    for (const r of q.results) {
      const a = r.window?.anchor
      if (a && 'ref' in a) expect(present.has(a.ref)).toBe(true)
    }
    await h.close()
  })

  it('a hit excluded by time_range cannot claim neighbors away from surviving hits', async () => {
    const h = await flatHarness('claim.db')
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'first zanzibar match in this session', metadata: { session_id: 's1', role: 'assistant', source: 'auto-capture' } } })
    await tick()
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'filler bridge entry between the two others', metadata: { session_id: 's1', role: 'assistant', source: 'auto-capture' } } })
    await tick()
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'second zanzibar match in this session', metadata: { session_id: 's1', role: 'assistant', source: 'auto-capture' } } })
    const all = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar match', top_k: 2, conversation_window: 0 } }))
    expect(all.results.length).toBe(2)
    const times = all.results.map((r) => r.createdAt).sort((a, b) => a - b)
    const mid = ((times[0] ?? 0) + (times[1] ?? 0)) / 2
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'zanzibar match', top_k: 2, time_range: { after: mid } } }))
    expect(q.results.length).toBe(1)
    const beforeContents = (q.results[0]?.window?.before ?? []).map((e) => e.content ?? '')
    expect(beforeContents.some((c) => c.includes('filler bridge'))).toBe(true)
    await h.close()
  })

  it('session-less hits carry no window stub under the default; explicit keeps the diagnostic', async () => {
    const h = await flatHarness('curated.db')
    for (let i = 0; i < 3; i++) {
      await h.client.callTool({ name: 'treecontext_insert', arguments: { content: `curated zanzibar note number ${String(i)}` } })
    }
    const defaulted = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'curated zanzibar', top_k: 3 } }))
    for (const r of defaulted.results) expect(r.window).toBeUndefined()
    const explicit = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'curated zanzibar', top_k: 3, conversation_window: 2 } }))
    expect(explicit.results.length).toBeGreaterThan(0)
    for (const r of explicit.results) expect(r.window?.omitted).toBe('no-session-key')
    await h.close()
  })

  it('namespace exclusion filters hits before window claiming (library level)', async () => {
    const db = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, 'ns.db')))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    await store.insert('subagent zanzibar finding alpha', { metadata: { session_id: 's1', role: 'assistant', _namespace: 'sub' } })
    await store.insert('project zanzibar finding beta', { metadata: { session_id: 's1', role: 'assistant', _namespace: 'project' } })
    const hits = await store.query('zanzibar finding', { topK: 5, excludeNamespaces: ['sub'], conversationWindow: 2 })
    expect(hits.length).toBe(1)
    expect(hits[0]?.metadata?.['_namespace']).toBe('project')
    // The excluded node was never a hit, so it survives as a neighbor.
    const neigh = [...(hits[0]?.window?.before ?? []), ...(hits[0]?.window?.after ?? [])]
    expect(neigh.some((e) => e.content.includes('subagent zanzibar'))).toBe(true)
    await store.close()
  })

})
