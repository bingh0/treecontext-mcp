/**
 * fts-dual-cap.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim. Three
 * sentence groups merge over world state: "the node is deleted" (three
 * scenarios), "it is inserted and indexed" and the within/beyond-marker
 * query steps (two legacy-cap scenarios each). Persistence-level
 * scenarios exercise the recompute constraint directly
 * (insertNode/updateNode/deleteNode); the last scenario exercises the
 * user-visible FlatStore.query() contract (AC2d).)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'
import type { PersistedNode } from '../../src/persistence/store.js'
import { ftsSearch } from '../helpers/fts-search.js'
import { makePersistedNode } from '../helpers/persisted-node.js'
import { FlatStore } from '../../src/flat-store.js'
import { INDEX_CAP_USER, INDEX_CAP_ASSISTANT } from '../../src/persistence/index-text.js'
import type { CaptureWorld } from '../journal/capture-harness.js'
import { type DrainedEcho, drainedDeleteEcho, ftsNodeIds, ftsVocab, rawEchoes } from '../helpers/echo-capture.js'

/** The shared builder under this feature's baseline: every scenario here
 *  stages an auto-capture row, so the label and the source metadata are
 *  the fixture's default rather than each call site's. */
const makeNode = (partial: Partial<PersistedNode>): PersistedNode =>
  makePersistedNode({ sourceLabel: 'auto-capture', metadata: { source: 'auto-capture' }, ...partial })

function hits(db: Database, term: string): string[] {
  return ftsSearch(db, term, 10).map((h) => h.nodeId)
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  db?: Database
  persistence?: Persistence
  nodeId?: string
  /** Staged by both Givens feeding the shared "it is inserted and indexed" When. */
  pendingNode?: PersistedNode
  /** Staged by both Givens feeding the merged "returns no hits" Then. */
  noHitTerm?: string
  withinMarker?: string
  beyondMarker?: string
  store?: FlatStore
  hit?: { content: string } | undefined
  fullContent?: string
  /** D261: the capture sandbox the echo scenario drains into, and what it drained. */
  cw?: CaptureWorld
  drained?: DrainedEcho
  /** Observations recorded inside the update-and-delete When, while the row lived. */
  livedIndexHits?: string[]
  livedResultHits?: string[]
  livedHitContent?: string | undefined
}

export const ftsDualCapDefiner = (reg: Registry<World>): void => {
  function freshDb(w: World): void {
    const dir = mkdtempSync(join(tmpdir(), 'tc-fts-dual-cap-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'test.db')))
    const persistence = Persistence.openLexical(db)
    w.defer(() => db.close())
    w.db = db
    w.persistence = persistence
    db.prepare('INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, ?, 0, ?)').run(
      'project',
      Math.floor(Date.now() / 1000),
    )
  }

  reg.define(/^an auto-capture user node with short content inserted$/, (w) => {
    freshDb(w)
    w.nodeId = randomUUID()
    w.persistence!.insertNode(1, makeNode({ nodeId: w.nodeId, content: 'short widgetAlpha note', metadata: { source: 'auto-capture', role: 'user' } }))
    // Control (audit run 1): the token is findable before deletion, so
    // the Then's empty result is a real delta, not a dead matcher.
    expect(hits(w.db!, 'widgetAlpha')).toEqual([w.nodeId])
    w.noHitTerm = 'widgetAlpha'
  })

  reg.define(/^an auto-capture assistant node with zstd-sized content inserted$/, (w) => {
    freshDb(w)
    w.nodeId = randomUUID()
    const content = `gizmoZstdMarker ${'padding text to cross the zstd floor. '.repeat(20)}`
    w.persistence!.insertNode(1, makeNode({ nodeId: w.nodeId, content, metadata: { source: 'auto-capture', role: 'assistant' } }))
    // Control (audit run 1): findable through the compressed path
    // before deletion, so the Then's empty result is a real delta.
    expect(hits(w.db!, 'gizmoZstdMarker')).toEqual([w.nodeId])
    w.noHitTerm = 'gizmoZstdMarker'
  })

  reg.define(/^an auto-capture user node whose content exceeds the user index cap, inserted$/, (w) => {
    freshDb(w)
    w.nodeId = randomUUID()
    const withinCapToken = 'earlyMarkerToken'
    const beyondCapToken = 'lateMarkerToken'
    const content = `${withinCapToken} ${'x'.repeat(INDEX_CAP_USER + 500)} ${beyondCapToken}`
    w.persistence!.insertNode(1, makeNode({ nodeId: w.nodeId, content, metadata: { source: 'auto-capture', role: 'user' } }))
    w.withinMarker = withinCapToken
    w.beyondMarker = beyondCapToken
  })

  reg.define(/^the within-cap token matches before deletion$/, (w) => {
    expect(hits(w.db!, w.withinMarker!)).toEqual([w.nodeId])
  })

  reg.define(/^an auto-capture assistant node inserted with an initial unique token$/, (w) => {
    freshDb(w)
    w.nodeId = randomUUID()
    w.persistence!.insertNode(1, makeNode({ nodeId: w.nodeId, content: 'initialTokenOne here', metadata: { source: 'auto-capture', role: 'assistant' } }))
    // Control (audit run 1): the old token is indexed before the
    // update, so the Then's absence is the update's doing.
    expect(hits(w.db!, 'initialTokenOne')).toEqual([w.nodeId])
  })

  reg.define(
    /^an auto-capture assistant node without an index marker or tool name, with a marker within the frozen 4000-char legacy cap and a marker past it$/,
    (w) => {
      freshDb(w)
      w.nodeId = randomUUID()
      const withinMarker = 'assistantWithinCap'
      const beyondMarker = 'assistantBeyondCap'
      const content = `${withinMarker} ${'y'.repeat(INDEX_CAP_ASSISTANT + 200)} ${beyondMarker}`
      w.pendingNode = makeNode({ nodeId: w.nodeId, content, metadata: { source: 'auto-capture', role: 'assistant' } })
      w.withinMarker = withinMarker
      w.beyondMarker = beyondMarker
    },
  )

  reg.define(
    /^an auto-capture user node without an index marker, with a marker within the frozen 2000-char legacy cap and a marker past it$/,
    (w) => {
      freshDb(w)
      w.nodeId = randomUUID()
      const withinMarker = 'withinCapMarker'
      const beyondMarker = 'beyondCapMarker'
      const content = `${withinMarker} ${'y'.repeat(INDEX_CAP_USER + 200)} ${beyondMarker}`
      w.pendingNode = makeNode({ nodeId: w.nodeId, content, metadata: { source: 'auto-capture', role: 'user' } })
      w.withinMarker = withinMarker
      w.beyondMarker = beyondMarker
    },
  )

  // ── D261: the echo's boundary is stamped, so the recompute replays it ──
  reg.define(/^a treecontext echo drained with its index boundary ahead of its output and its display boundary stamped in its metadata$/, async (w) => {
    w.cw = { defer: w.defer }
    // The echo of a real delete: a fitting event, its index boundary at the
    // end of its Input (the deleted entry's id), its Output the response.
    w.drained = await drainedDeleteEcho(w.cw)
    const { echo, indexTerm, resultTerm } = w.drained
    const outAt = echo.content.indexOf('\nOutput:')
    expect(outAt).toBeGreaterThan(0)
    expect(echo.content.slice(outAt)).toContain(resultTerm)
    expect(echo.content.slice(0, outAt)).toContain(indexTerm)
    expect(echo.metadata['_index_len']).toBe(outAt)
    expect(echo.indexLen, 'the boundary column carries the stamp').toBe(outAt)
    expect(echo.content.slice(0, echo.metadata['_index_len'] as number)).not.toContain(resultTerm)
    // The display boundary is stamped although the event fit its caps.
    expect(echo.metadata['_preview_len']).toBe(echo.content.length)
  })

  reg.define(/^the row is updated and then deleted by the store's ordinary update and delete, which read only the stamp$/, async (w) => {
    const dbPath = w.cw!.dbPath!
    const { echo, indexTerm, resultTerm } = w.drained!
    const store = w.cw!.store!
    const raw = new BetterSqlite3(dbPath, { readonly: true })
    let tree: number
    let createdAt: number
    try {
      const row = raw.prepare('SELECT tree_id, created_at FROM nodes WHERE node_id = ?').get(echo.nodeId) as { tree_id: number; created_at: number }
      tree = row.tree_id
      createdAt = row.created_at
    } finally {
      raw.close()
    }
    // The ordinary update: same content, the stamped metadata plus one
    // more key — the old index text is recomputed from the stamp alone.
    store.store.updateNode(makeNode({
      nodeId: echo.nodeId, treeId: tree, content: echo.content, createdAt,
      metadata: { ...echo.metadata, _relied_count: 1 },
    }))
    // While the row lives: what the index holds, and what a hit shows.
    w.livedIndexHits = ftsNodeIds(dbPath, indexTerm)
    w.livedResultHits = ftsNodeIds(dbPath, resultTerm)
    w.livedHitContent = (await store.query(indexTerm, { topK: 10 })).find((h) => h.nodeId === echo.nodeId)?.content
    await store.delete(echo.nodeId)
    expect(rawEchoes(dbPath)).toEqual([])
  })

  reg.define(/^the index held what the echo indexes and not its results while the row lived$/, (w) => {
    const { echo, noteId } = w.drained!
    expect(w.livedIndexHits, 'the echo was not findable by what it indexes').toContain(echo.nodeId)
    expect(w.livedResultHits, 'the echo was indexed by its results').not.toContain(echo.nodeId)
    // Control: the result word is live in the index — the note's own row.
    expect(w.livedResultHits).toContain(noteId)
  })

  reg.define(/^a hit on the echo showed its output while the row lived$/, (w) => {
    const { resultTerm } = w.drained!
    expect(w.livedHitContent, 'no hit on the echo').toBeDefined()
    expect(w.livedHitContent!).toContain('\nOutput:\n')
    expect(w.livedHitContent!, 'the hit was cut at the index boundary').toContain(resultTerm)
  })

  reg.define(/^the FTS index holds no ghost entry for it in any column after the delete$/, (w) => {
    // Every posting, every column, compared with the index before the echo
    // drained: the delete removed exactly what the insert and update put in.
    expect(ftsVocab(w.cw!.dbPath!)).toEqual(w.drained!.vocabBefore)
  })

  reg.define(/^a FlatStore with an auto-capture user node whose content exceeds the index cap$/, async (w) => {
    const flatDbDir = mkdtempSync(join(tmpdir(), 'tc-fts-dual-cap-flat-'))
    w.defer(() => rmSync(flatDbDir, { recursive: true, force: true }))
    const flatDb = wrapBetterSqlite(new BetterSqlite3(join(flatDbDir, 'flat.db')))
    const store = await FlatStore.open({ database: flatDb })
    w.defer(() => store.close())
    w.store = store
    const fullContent = `leadingSearchTerm ${'z'.repeat(INDEX_CAP_USER + 1000)} trailingTail`
    await store.insert(fullContent, { metadata: { source: 'auto-capture', role: 'user' } })
    w.fullContent = fullContent
  })

  // Merged: plain-row, compressed-row, and prefix-index-text scenarios
  // delete the staged node; executes once per scenario.
  reg.define(/^the node is deleted$/, (w) => {
    w.persistence!.deleteNode(w.nodeId!)
  })

  reg.define(/^the node is updated to new content with a different unique token$/, (w) => {
    w.persistence!.updateNode(
      makeNode({ nodeId: w.nodeId!, content: 'replacementTokenTwo here', metadata: { source: 'auto-capture', role: 'assistant' } }),
    )
  })

  // Merged: both legacy-cap scenarios insert their staged node here;
  // executes once per scenario.
  reg.define(/^it is inserted and indexed$/, (w) => {
    w.persistence!.insertNode(1, w.pendingNode!)
  })

  reg.define(/^querying for a term near the start of the content$/, async (w) => {
    const results = await w.store!.query('leadingSearchTerm')
    w.hit = results[0]
  })

  // Merged: the plain-row and compressed-row scenarios assert the same
  // observable over their staged token; executes once per scenario.
  reg.define(/^a query for its content returns no hits$/, (w) => {
    expect(hits(w.db!, w.noHitTerm!)).toEqual([])
  })

  reg.define(/^a query for the within-cap token returns no hits$/, (w) => {
    expect(hits(w.db!, w.withinMarker!)).toEqual([])
  })

  reg.define(/^a query for the beyond-cap token also returns no hits$/, (w) => {
    expect(hits(w.db!, w.beyondMarker!)).toEqual([])
  })

  reg.define(/^a query for the old token returns no hits$/, (w) => {
    expect(hits(w.db!, 'initialTokenOne')).toEqual([])
  })

  reg.define(/^a query for the new token returns the updated node$/, (w) => {
    expect(hits(w.db!, 'replacementTokenTwo')).toEqual([w.nodeId])
  })

  // Merged: both legacy-cap scenarios share these observables over their
  // staged markers; each definition executes once per scenario.
  reg.define(/^a query for the within-cap marker returns the node$/, (w) => {
    expect(hits(w.db!, w.withinMarker!)).toEqual([w.nodeId])
  })

  reg.define(/^a query for the beyond-cap marker returns no hits$/, (w) => {
    expect(hits(w.db!, w.beyondMarker!)).toEqual([])
  })

  reg.define(/^the returned hit's content is the full original content, not the truncated index text$/, (w) => {
    expect(w.hit).toBeDefined()
    expect(w.hit!.content).toBe(w.fullContent)
    expect(w.hit!.content.length).toBeGreaterThan(INDEX_CAP_USER)
  })
}
