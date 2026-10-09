/**
 * Step 3 (MVP lexical spec): server wiring + tool/mode gating.
 * AC3.1 backend-agnostic tools work on FlatStore, AC3.2 tree-only tools
 * gated, AC3.3 embedding-only query modes handled, AC3.4 end-to-end,
 * AC3.5 no stale-summary nag on lexical.
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

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-srv-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(res: any): any { return JSON.parse(res.content[0].text) }

async function flatHarness(name = 'flat.db') {
  const db = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, name)))
  const store = await FlatStore.open({ database: db, ownsDatabase: true })
  const server = createServer(store, {})
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0' })
  await server.connect(st); await client.connect(ct)
  return { client, store, close: async () => { await client.close(); await server.close(); await store.close() } }
}

describe('AC3.2 tool gating by backend', () => {
  it('the journal server registers exactly the journal tools — no tree-era machinery', async () => {
    const h = await flatHarness()
    const flat = (await h.client.listTools()).tools.map((t) => t.name)
    for (const t of ['treecontext_checkpoint', 'treecontext_checkpoint_all', 'treecontext_update_summary', 'treecontext_recover']) {
      expect(flat).not.toContain(t)
    }
    for (const t of ['treecontext_insert', 'treecontext_query', 'treecontext_status', 'treecontext_delete', 'treecontext_export', 'treecontext_import', 'treecontext_merge_from_agent', 'treecontext_clear']) {
      expect(flat).toContain(t)
    }
    await h.close()
  })
})

describe('AC3.1 + AC3.4 + AC3.5 backend-agnostic end-to-end', () => {
  it('cold-start → capture → query → resume; no summarize nag', async () => {
    const h = await flatHarness()
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'the deploy pipeline uses argo and helm', metadata: { next_session: true } } })
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'unrelated note about coffee beans' } })
    const q = parse(await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'argo helm deploy', top_k: 3 } }))
    expect(q.results.length).toBeGreaterThan(0)
    expect(q.results[0].content).toContain('argo')
    const s = parse(await h.client.callTool({ name: 'treecontext_status', arguments: {} }))
    expect(s.total_nodes).toBe(2)
    expect(s.resume_pointers?.length ?? 0).toBe(1)
    expect(s.action_required).toBeUndefined()
    expect(s.stale_summary_count).toBe(0)
    await h.close()
  })

  it('export / delete work, and the retired feedback tool is absent', async () => {
    const h = await flatHarness('e.db')
    const ins = parse(await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'exportable node alpha' } }))
    const exp = parse(await h.client.callTool({ name: 'treecontext_export', arguments: { form: 'whole', secrets_acknowledged: true } }))
    expect(JSON.stringify(exp)).toContain('exportable node alpha')
    // treecontext_feedback was dropped 2026-07-25 (fence:
    // features/OUT-OF-SCOPE.md, "Feedback tool"). SDK v1's lenient
    // unknown-tool handling let this call resolve as an error result
    // nobody read, so the retirement sat unpinned; v2 answers with a
    // protocol error, which is the honest observable of absence.
    await expect(
      h.client.callTool({ name: 'treecontext_feedback', arguments: { node_id: ins.node_id, outcome: 'success' } }),
    ).rejects.toThrow(/not found/)
    await h.client.callTool({ name: 'treecontext_delete', arguments: { node_id: ins.node_id } })
    const s = parse(await h.client.callTool({ name: 'treecontext_status', arguments: {} }))
    expect(s.total_nodes).toBe(0)
    await h.close()
  })
})

describe('AC3.3 legacy mode params on the slimmed surface', () => {
  it('legacy retrieval_mode values are ignored — every call runs BM25', async () => {
    // The tree-era compat params left the schema at the slim-down
    // (2026-07-27). Unknown keys are stripped at the MCP layer, so an
    // old caller passing any tree-era mode — including the formerly
    // erroring cross_modal — gets lexical results, not a failure.
    const h = await flatHarness('m.db')
    await h.client.callTool({ name: 'treecontext_insert', arguments: { content: 'searchable lexical content here' } })
    for (const mode of ['cross_modal', 'expanded', 'similarity', 'hybrid', 'hybrid_dbsf', 'branch_diverse']) {
      const r = await h.client.callTool({ name: 'treecontext_query', arguments: { query: 'lexical', retrieval_mode: mode } })
      expect(Boolean(r.isError), `mode ${mode} errored on the slimmed surface`).toBe(false)
      expect(parse(r).results.length).toBeGreaterThan(0)
    }
    await h.close()
  })
})
