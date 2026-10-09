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
