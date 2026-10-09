/**
 * flat-store-c4-read-view.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion preserved verbatim. Store
 * close moved from end-of-last-step to defer — no assertion depends on
 * closed state.)
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import type { QueryResult } from '../../src/core/types.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  store?: FlatStore
  dbPath?: string
  content?: string
  nodeId?: string
  exported?: string
  hits?: QueryResult[]
  windowTexts?: string[]
  noteContent?: string
  legacyContent?: string
  archivePath?: string
}

const PREVIEW = 'Tool: Bash\nInput:\nnpm test\nOutput:\nzephyrquark suite started...'
const TAIL = '\n--- FULL ---\nInput:\nnpm test\nOutput:\nzephyrquark suite started plus GLOMMED full detail ' + 'y'.repeat(3000)
const C4_CONTENT = PREVIEW + TAIL

function c4Meta(session = 's-read', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'auto-capture',
    role: 'assistant',
    tool_name: 'Bash',
    session_id: session,
    _index_len: PREVIEW.length,
    ...extra,
  }
}

export const flatStoreC4ReadViewDefiner = (reg: Registry<World>): void => {
  async function freshStore(w: World, opts: { maxStoreBytes?: number } = {}): Promise<FlatStore> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-c4-read-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    w.dbPath = join(dir, 'flat.db')
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath))
    const store = await FlatStore.open({ database: db, ownsDatabase: true, ...opts })
    w.defer(() => store.close())
    return store
  }

  reg.define(/^an ingested C4 tool event whose full tail exceeds its preview$/, async (w) => {
    w.store = await freshStore(w)
    await w.store.insert(C4_CONTENT, { metadata: c4Meta() })
  })

  reg.define(/^a query matches it$/, async (w) => {
    const hits = await w.store!.query('zephyrquark', { topK: 5 })
    expect(hits.length).toBe(1)
    w.content = hits[0]!.content
  })

  reg.define(/^the hit's content is the index view followed by the availability marker$/, (w) => {
    expect(w.content!.startsWith(PREVIEW)).toBe(true)
    expect(w.content!).toContain('…[preview; full content')
    // step-lint: allow unearned-absence -- guarded: the seed row carrying GLOMMED is asserted in PREVIEW+TAIL above — index-invisibility of tail content is the contract under test
    expect(w.content!).not.toContain('GLOMMED')
  })

  reg.define(/^the marker names the full content length$/, (w) => {
    expect(w.content!).toContain(`${C4_CONTENT.length} chars via treecontext_export`)
  })

  reg.define(/^a full-fidelity tool-event node$/, async (w) => {
    w.store = await freshStore(w)
    w.nodeId = (await w.store.insert(C4_CONTENT, { metadata: c4Meta() })).nodeId
  })

  reg.define(/^it is exported by node id$/, (w) => {
    const parsed = JSON.parse(w.store!.exportJson({ nodeId: w.nodeId! })) as { nodes: Array<{ content: string }> }
    w.exported = parsed.nodes[0]!.content
  })

  reg.define(/^the exported content is the complete preview plus tail with no marker$/, (w) => {
    expect(w.exported).toBe(C4_CONTENT)
    // step-lint: allow unearned-absence -- guarded: the preview marker's production is asserted by the first scenario's Then (formatter: src/flat-store.ts:255); export must return whole content
    expect(w.exported).not.toContain('…[preview;')
  })

  reg.define(/^a full-fidelity tool-event node returned by an earlier query$/, async (w) => {
    w.store = await freshStore(w)
    await w.store.insert(C4_CONTENT, { metadata: c4Meta() })
    const first = await w.store.query('zephyrquark', { topK: 5 })
    expect(first.length).toBe(1)
    expect(first[0]!.content).toContain('treecontext_export')
  })

  reg.define(/^a query is made for distinctive words from the marker text$/, async (w) => {
    w.hits = await w.store!.query('treecontext_export', { topK: 5 })
  })

  reg.define(/^the node does not match, pinning that the marker never enters storage or the index$/, (w) => {
    expect(w.hits!.length).toBe(0)
  })

  reg.define(/^a full-fidelity tool event adjacent to a query hit in the same session$/, async (w) => {
    w.store = await freshStore(w)
    const t = 1_700_000_000
    await w.store.insert(C4_CONTENT, { createdAt: t, metadata: c4Meta('s-win') })
    await w.store.insert('plovercrest anchor hit text', {
      createdAt: t + 5,
      metadata: { source: 'auto-capture', role: 'assistant', session_id: 's-win' },
    })
  })

  reg.define(/^the hit is returned with a conversation window$/, async (w) => {
    const hits = await w.store!.query('plovercrest', { topK: 3, conversationWindow: 2 })
    expect(hits.length).toBe(1)
    const win = hits[0]!.window!
    w.windowTexts = [...win.before, ...win.after].map((e) => e.content)
  })

  reg.define(/^the neighbor entry's text is based on the index view before the window cap applies$/, (w) => {
    expect(w.windowTexts!.length).toBeGreaterThan(0)
    for (const text of w.windowTexts!) {
      // step-lint: allow unearned-absence -- guarded: seed positive in C4_CONTENT above; window-recovery path under test here
      expect(text).not.toContain('GLOMMED')
    }
    expect(w.windowTexts!.some((t) => t.includes('zephyrquark'))).toBe(true)
  })

  reg.define(/^a curated note and a legacy preview-only tool event$/, async (w) => {
    w.store = await freshStore(w)
    await w.store.insert('curated finding: the sprocketflange design was ratified in full detail ' + 'n'.repeat(3000), {
      metadata: { type: 'finding' },
    })
    await w.store.insert('Tool: Bash\nInput:\nls\nOutput:\nlegacy sprocketflange preview only', {
      metadata: { source: 'auto-capture', role: 'assistant', tool_name: 'Bash', session_id: 's-legacy' },
    })
  })

  reg.define(/^queries match them$/, async (w) => {
    const hits = await w.store!.query('sprocketflange', { topK: 5 })
    expect(hits.length).toBe(2)
    w.noteContent = hits.find((h) => h.metadata?.['type'] === 'finding')!.content
    w.legacyContent = hits.find((h) => h.metadata?.['tool_name'] === 'Bash')!.content
  })

  reg.define(/^both hits return their full decoded content with no marker$/, (w) => {
    expect(w.noteContent!).toContain('n'.repeat(3000))
    // step-lint: allow unearned-absence -- guarded: marker production asserted by the first scenario's Then; note content must be untruncated
    expect(w.noteContent!).not.toContain('…[preview;')
    expect(w.legacyContent!).toContain('legacy sprocketflange preview only')
    // step-lint: allow unearned-absence -- guarded: marker production asserted by the first scenario's Then; legacy-row content must be untruncated
    expect(w.legacyContent!).not.toContain('…[preview;')
  })

  reg.define(/^a full-fidelity tool event demoted by the store-byte sweep$/, async (w) => {
    // Budget below the C4 row's size forces demotion down to the preview.
    w.store = await freshStore(w, { maxStoreBytes: 32 })
    await w.store.insert(C4_CONTENT, { createdAt: 1_700_000_000, metadata: c4Meta('s-demote') })
    const { demoted } = w.store.retentionSweep()
    expect(demoted).toBe(1)
  })

  reg.define(/^a query matches its preview text$/, async (w) => {
    const hits = await w.store!.query('zephyrquark', { topK: 5 })
    expect(hits.length).toBe(1)
    w.content = hits[0]!.content
    w.archivePath = hits[0]!.metadata?.['_archive_path'] as string
  })

  reg.define(/^the hit returns the demoted preview with a marker naming the archived tail$/, (w) => {
    expect(w.content!.startsWith(PREVIEW)).toBe(true)
    expect(w.content!).toContain(`…[demoted; full content ${C4_CONTENT.length} chars archived — path in _archive_path]`)
    // step-lint: allow unearned-absence -- guarded: seed positive in C4_CONTENT above; demotion path re-pins invisibility
    expect(w.content!).not.toContain('GLOMMED')
  })

  reg.define(/^preview findability is unchanged and the full event is recoverable from the demotion archive$/, async (w) => {
    const hits = await w.store!.query('zephyrquark suite', { topK: 5 })
    expect(hits.length).toBe(1)
    const archived = (JSON.parse(readFileSync(w.archivePath!, 'utf8')) as { nodes: Array<{ content: string }> }).nodes
    expect(archived.some((n) => n.content === C4_CONTENT)).toBe(true)
  })

  reg.define(/^a full-fidelity tool event whose metadata is later rewritten by supersede and then demotion$/, async (w) => {
    w.store = await freshStore(w, { maxStoreBytes: 32 })
    w.nodeId = (
      await w.store.insert(C4_CONTENT, {
        createdAt: 1_700_000_000,
        metadata: c4Meta('s-ghost', { next_session: true }),
      })
    ).nodeId
    // Supersede rewrites metadata_json (clears next_session, adds trace).
    await w.store.insert('successor note for the ghost pin', { supersedes: [w.nodeId] })
    // Demotion rewrites content + metadata again.
    const { demoted } = w.store.retentionSweep()
    expect(demoted).toBe(1)
  })

  reg.define(/^the node is deleted$/, (w) => {
    w.store!.delete(w.nodeId!)
  })

  reg.define(/^the FTS index holds no ghost entry for it$/, async (w) => {
    // The query path cannot see ghosts (nodes_fts JOINs nodes, so a
    // posting whose node row is gone never joins — audit run 1), so the
    // observable that can actually fail is the fts5vocab doc count:
    // read the index directly through a second, readonly connection.
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      raw.exec("CREATE VIRTUAL TABLE temp.ghost_vocab USING fts5vocab(main, 'nodes_fts', 'row')")
      const row = raw
        .prepare("SELECT doc FROM temp.ghost_vocab WHERE term = 'zephyrquark'")
        .get() as { doc: number } | undefined
      expect(row, 'a posting for the deleted node survived in nodes_fts').toBeUndefined()
    } finally {
      raw.close()
    }
    const hits = await w.store!.query('zephyrquark', { topK: 5 })
    expect(hits.length).toBe(0)
  })

  reg.define(/^the delete-time recompute sliced at the surviving _index_len matched the indexed text exactly$/, async (w) => {
    // Control for the Then above: the same query finds fresh content,
    // so its zero was a real zero, not a broken matcher.
    await w.store!.insert('post-delete sanity row zephyrquark redux', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-ghost' },
    })
    const hits = await w.store!.query('zephyrquark', { topK: 5 })
    expect(hits.length).toBe(1)
  })
}
