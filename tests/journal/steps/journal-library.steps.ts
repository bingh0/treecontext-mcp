import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../../src/flat-store.js'
import { countNodesIn } from '../../helpers/store-fixtures.js'
import { mcpOver, parseTool, openLiveStore, reopenAsLaterSession, exportNode } from '../world.js'
import { type CaptureWorld, openCaptureWorld, spawnHook, drainStaging, rawJournal, bashPayload } from '../capture-harness.js'

// ── journal-library ─────────────────────────────────────────────────────


/**
 * The library wave's world. It extends CaptureWorld because the
 * "one journal, two doors" scenarios stage through the real hooks
 * (openCaptureWorld/spawnHook/drainStaging) and then read the same rows
 * back through the plain library API — w.prompt, w.saidAt and w.sessionId
 * are the hook side of that comparison.
 */
export interface LibraryWorld extends CaptureWorld {
  /** The whole-journal export, held as text so the reopen can re-import it. */
  exportedJson?: string
  /** A second FlatStore handle standing in for another Node program. */
  reader?: FlatStore
}
export const libraryDefiner = (reg: Registry<LibraryWorld>): void => {
  reg.define(/^a program that imports the library and opens a store on a database file$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
  })
  reg.define(/^no MCP server is running$/, () => {
    // Environmental constraint the binding honors by construction: this
    // process spawns no server; the store above is the library API alone.
  })
  reg.define(/^it inserts an entry and queries for its words$/, async (w: LibraryWorld) => {
    w.nodeId = (await w.store!.insert('The parser pool caps at four concurrent tree-sitter instances')).nodeId
    w.results = await w.store!.query('parser pool tree-sitter', { topK: 5 })
  })
  reg.define(/^the entry is found and exported intact$/, (w: LibraryWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId)
    expect(exportNode(w, w.nodeId!)['content']).toBe('The parser pool caps at four concurrent tree-sitter instances')
  })

  // ── library and server read the same truth (bound at critic pass 4,
  //    2026-07-25's wip reason — "needs an in-process MCP harness" —
  //    expired when the search-modes wave built mcpOver) ───────────────
  reg.define(/^entries written through the library API$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    // A corpus recency fusion demonstrably reorders: one old entry with
    // decisively stronger lexical match and enough fresh weak matches
    // that rank gaps overcome RRF's K=60 damping (with 3 rows, adjacent
    // ranks differ by ~1/60-1/61 and fusion at 0.5 can never flip #1 —
    // exactly the fixture luck the 2026-08-12 audit called; the measured
    // pathology this default fixes lived on ~44-candidate pools). Pure
    // bm25 puts the old row first; the served default lifts the newest.
    const now = Date.now() / 1000
    await w.store!.insert('alpha decision: drain valve drain valve drain valve ordering', {
      createdAt: now - 90 * 86400,
    })
    for (let i = 0; i < 19; i++) {
      await w.store!.insert(`fresh note ${i}: the drain valve came up in passing today`, {
        createdAt: now - 3600 + i * 60, // distinct capture times, newest last
      })
    }
  })
  reg.define(/^the MCP server opens the same database file$/, async (w: LibraryWorld) => {
    // A second, independent open of the same file — the server is a
    // separate consumer of the store, not a wrapper around the library's
    // handle.
    const serverStore = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
      ownsDatabase: true,
    })
    w.defer(() => serverStore.close())
    await mcpOver(w, {}, serverStore)
  })
  reg.define(/^the server's query results match the library's for the same query and knobs$/, async (w: LibraryWorld) => {
    const lib = (await w.store!.query('drain valve', { topK: 5 })).map((r) => r.nodeId)
    expect(lib.length).toBe(5)
    // Discriminating control: the surface's served recency default must
    // actually reorder this corpus — otherwise the parity assertion
    // below could not fail and proves nothing.
    const fused = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'drain valve', top_k: 5 },
    }))
    const srvFused = (fused['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(srvFused, 'the corpus must discriminate: the served default reorders it').not.toEqual(lib)
    // Parity, knobs equalized: same rows, same ranking — asserted exactly
    // where divergence would show.
    const res = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'drain valve', top_k: 5, recency_weight: 0 },
    }))
    const srv = (res['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(srv).toEqual(lib)
  })

  // ── a reader can watch a live store without stopping the writer ─────
  reg.define(/^the MCP server holding a store open$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    await mcpOver(w)
    await w.client!.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'first committed entry before the reader arrives' },
    })
  })
  reg.define(/^a library consumer opens the same file read-only$/, async (w: LibraryWorld) => {
    const reader = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!, { readonly: true })),
      ownsDatabase: true,
      readOnly: true,
    })
    w.defer(() => reader.close())
    w.reader = reader
  })
  reg.define(/^committed entries are readable while the server keeps writing$/, async (w: LibraryWorld) => {
    const before = (await w.reader!.query('committed entry', { topK: 5 })).map((r) => r.content)
    expect(before.some((c) => c.includes('first committed entry'))).toBe(true)
    // The server keeps writing — the read-only handle must not block it…
    await w.client!.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'second committed entry while the reader watches' },
    })
    // …and the new commit is visible to the reader's next query.
    const after = (await w.reader!.query('committed entry', { topK: 5 })).map((r) => r.content)
    expect(after.some((c) => c.includes('second committed entry'))).toBe(true)
  })

  // ── the whole journal exports through the tool surface ──────────────
  reg.define(/^a populated journal$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    await mcpOver(w)
    w.descriptions = [
      'whole-export entry: the first finding',
      'whole-export entry: the second finding',
      'whole-export entry: the third finding',
    ]
    for (const c of w.descriptions) await w.store!.insert(c)
  })
  reg.define(/^export is called with no node id and the whole journal chosen, its secrets warning acknowledged$/, async (w: LibraryWorld) => {
    // No node id, and the whole journal chosen deliberately: since D177 the
    // default export is the summaries-only handoff, and the whole journal
    // comes back once its secrets warning is acknowledged (journal-handoff,
    // D177; the sanctioned rewording of this step, D229).
    const warned = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { form: 'whole' } }))
    expect(warned['written']).toBe(false)
    w.exported = parseTool(
      await w.client!.callTool({ name: 'treecontext_export', arguments: { form: 'whole', secrets_acknowledged: true } }),
    ) as unknown as { nodes: Array<Record<string, unknown>> }
  })
  reg.define(/^portable JSON of the whole journal returns, bounded by the export node cap$/, (w: LibraryWorld) => {
    const nodes = w.exported!.nodes as Array<{ content: string }>
    expect(nodes.map((n) => n.content)).toEqual(expect.arrayContaining(w.descriptions!))
    // The cap is exercised, not merely asserted against a 3-row store
    // (round-2 R11): a low explicit cap must actually truncate the export.
    const capped = (JSON.parse(w.store!.exportJson({ maxExportNodes: 2 })) as { nodes: unknown[] }).nodes
    expect(capped.length).toBe(2)
  })
  reg.define(/^importing it elsewhere reproduces the entries verbatim$/, async (w: LibraryWorld) => {
    const dir2 = mkdtempSync(join(tmpdir(), 'tc-journal-wholeexp-'))
    w.defer(() => rmSync(dir2, { recursive: true, force: true }))
    const restore = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir2, 'restore.db'))),
      ownsDatabase: true,
    })
    w.defer(() => restore.close())
    await restore.importJson(JSON.stringify(w.exported))
    const contents = (JSON.parse(restore.exportJson()) as { nodes: Array<{ content: string }> }).nodes.map(
      (n) => n.content,
    )
    expect(contents).toEqual(expect.arrayContaining(w.descriptions!))
  })

  // ── exports are portable across consumers ───────────────────────────
  reg.define(/^an export produced through the library API$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    w.descriptions = [
      'exported finding: the codec flag is one byte',
      'exported finding: the preview cap is enforced at ingest',
    ]
    w.nodeIds = []
    for (const d of w.descriptions) w.nodeIds.push((await w.store!.insert(d)).nodeId)
    w.exportedJson = w.store!.exportJson()
  })
  reg.define(/^another store imports it through the MCP server$/, async (w: LibraryWorld) => {
    const dir2 = mkdtempSync(join(tmpdir(), 'tc-import-'))
    w.defer(() => rmSync(dir2, { recursive: true, force: true }))
    const store2 = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir2, 'second.db'))),
      ownsDatabase: true,
    })
    w.defer(() => store2.close())
    w.store = store2
    await mcpOver(w)
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_import',
      arguments: { data: w.exportedJson!, label: 'from-library' },
    }))
  })
  reg.define(/^the imported session reads back verbatim$/, (w: LibraryWorld) => {
    expect(w.mcpResponse!['imported_count']).toBe(2)
    const nodes = (JSON.parse(w.store!.exportJson()) as { nodes: Array<{ content: string }> }).nodes
    const contents = nodes.map((n) => n.content)
    for (const d of w.descriptions!) expect(contents).toContain(d)
  })

  // ── import guardrails: 5 MB / 10k nodes, refused whole ──────────────
  // Frozen constants pinned by VALUE, never by importing the source
  // symbol — a drifted guardrail must turn these red, not follow along.
  reg.define(/^a journal holding one entry$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    w.nodeId = (await w.store!.insert('the one resident entry the refusal must preserve')).nodeId
  })
  reg.define(/^an import payload just over the size guardrail$/, (w: LibraryWorld) => {
    const cap = 5 * 1024 * 1024
    // Valid JSON either way — the size check fires on the raw string,
    // before any parse, so the refusal costs no 5 MB parse either.
    w.exportedJson = JSON.stringify({ version: 1, nodes: [{ content: 'x'.repeat(cap) }] })
    expect(w.exportedJson.length).toBeGreaterThan(cap)
  })
  reg.define(/^an import payload holding one node more than the count guardrail$/, (w: LibraryWorld) => {
    const nodes = Array.from({ length: 10_000 + 1 }, (_, i) => ({ content: `guardrail filler node ${i}` }))
    w.exportedJson = JSON.stringify({ version: 1, nodes })
    // The discriminating control: this payload must trip the NODE guard,
    // not ride in under the size guard's refusal.
    expect(w.exportedJson.length).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
  reg.define(/^the payload is imported through the library API$/, async (w: LibraryWorld) => {
    w.insertError = undefined
    try {
      await w.store!.importJson(w.exportedJson!)
    } catch (e) {
      w.insertError = e
    }
  })
  reg.define(/^the import is refused with an error naming the size limit$/, (w: LibraryWorld) => {
    expect(w.insertError).toBeInstanceOf(Error)
    expect((w.insertError as Error).message).toMatch(/size limit/i)
  })
  reg.define(/^the import is refused with an error naming the node limit$/, (w: LibraryWorld) => {
    expect(w.insertError).toBeInstanceOf(Error)
    expect((w.insertError as Error).message).toMatch(/node limit/i)
  })
  reg.define(/^the journal still holds exactly its one entry$/, (w: LibraryWorld) => {
    // SQLite is ground truth: count rows through a fresh connection, not
    // through the handle that just refused.
    expect(countNodesIn(w.dbPath!)).toBe(1)
  })

  reg.define(/^entries inserted through the library$/, async (w: LibraryWorld) => {
    await openLiveStore(w)
    w.descriptions = ['first fact before close', 'second fact before close', 'third fact before close']
    w.nodeIds = []
    for (const d of w.descriptions) w.nodeIds.push((await w.store!.insert(d)).nodeId)
  })
  reg.define(/^the store is closed and reopened$/, async (w: LibraryWorld) => {
    await reopenAsLaterSession(w)
  })
  reg.define(/^every entry written before close is present after reopen$/, (w: LibraryWorld) => {
    for (let i = 0; i < w.nodeIds!.length; i++) {
      expect(exportNode(w, w.nodeIds![i]!)['content']).toBe(w.descriptions![i])
    }
  })

  // ── events from any platform journal identically ────────────────────
  // (Bound at critic pass 2, 2026-07-25: the capture wave's harness makes
  // the hook-captured comparator real, so the library-surface promise is
  // finally checkable side by side.)
  reg.define(/^events staged through the library's capture surface rather than Claude Code hooks$/, async (w: LibraryWorld) => {
    await openCaptureWorld(w)
    // The reference-platform comparator: one real hook-captured event.
    spawnHook(w, 'post-tool-use', bashPayload(w, 'git diff --stat', ' ts/src/flat-store.ts | 40 +++'))
    // The "other platform": the same logical event staged through the
    // library staging API — no hook process, no Claude Code, an honest
    // event-time timestamp supplied by the platform.
    w.saidAt = [Date.now() / 1000 - 90, Date.now() / 1000 - 90] // said 90s ago
    w.store!.store.insertStaging({
      sessionId: 'other-platform-session',
      role: 'assistant',
      content: 'Tool: Bash\nInput:\ngit diff --stat\nOutput:\n ts/src/flat-store.ts | 40 +++',
      toolName: 'Bash',
      timestamp: w.saidAt[0],
      priority: 2,
    })
  })
  reg.define(/^ingestion drains them$/, async (w: LibraryWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the resulting entries match hook-captured ones in role, capture time, and searchable text$/, async (w: LibraryWorld) => {
    const rows = rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Bash')
    expect(rows).toHaveLength(2)
    const hookRow = rows.find((r) => r.metadata['session_id'] === w.sessionId)!
    const libRow = rows.find((r) => r.metadata['session_id'] === 'other-platform-session')!
    expect(libRow.metadata['role']).toBe(hookRow.metadata['role'])
    // Capture time honored for both: the library event keeps its supplied
    // event moment (not drain time), exactly as the hook event does.
    expect(libRow.metadata['created_at']).toBe(w.saidAt![0])
    expect(hookRow.metadata['created_at'] as number).toBeGreaterThan(w.saidAt![0])
    // One query finds both — no privileged path into the index.
    const ids = (await w.store!.query('git diff flat-store', { topK: 10 })).map((r) => r.nodeId)
    expect(ids).toContain(hookRow.nodeId)
    expect(ids).toContain(libRow.nodeId)
  })

  // ── closing the store loses nothing that was staged ─────────────────
  reg.define(/^events staged but not yet ingested when the store closes$/, async (w: LibraryWorld) => {
    await openCaptureWorld(w)
    w.prompt = 'staged before the close, drained after the reopen'
    spawnHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: w.prompt })
    spawnHook(w, 'post-tool-use', bashPayload(w, 'npm run lint', 'clean'))
    w.store!.close() // no drain ran — the backlog is on disk, unprocessed
  })
  reg.define(/^the store is reopened$/, async (w: LibraryWorld) => {
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
      ownsDatabase: true,
    })
    w.defer(() => store.close())
    w.store = store
  })
  reg.define(/^the staged events drain into the journal on the next ingestion$/, async (w: LibraryWorld) => {
    await drainStaging(w)
    const rows = rawJournal(w)
    expect(rows.filter((r) => r.metadata['role'] === 'user').map((r) => r.content)).toContain(w.prompt!)
    expect(rows.filter((r) => r.metadata['tool_name'] === 'Bash')).toHaveLength(1)
  })
}

