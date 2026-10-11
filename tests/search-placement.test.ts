/**
 * D275 (amends D262): the bookmark's score factor is retired; a chapter
 * summary is placed above the bookmarks it shares a match with after the
 * candidates are chosen and recency fusion has ordered them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { FlatStore } from '../src/flat-store.js'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../src/server/server.js'
import { parseToolResult } from './helpers/mcp-result.js'
import { placeChaptersAboveBookmarks, searchCheckpointKindOf, type CheckpointKind } from '../src/checkpoints.js'

describe('placeChaptersAboveBookmarks: a stable pass', () => {
  const kinds: Record<string, CheckpointKind | null> = { C1: 'chapter', C2: 'chapter', B1: 'bookmark', B2: 'bookmark' }
  const place = (xs: string[]): string[] => placeChaptersAboveBookmarks(xs, (x) => kinds[x] ?? null)
  it('moves a chapter to the first bookmark that precedes it; the rest keep their order', () => {
    expect(place(['a', 'B1', 'b', 'c', 'C1', 'd'])).toEqual(['a', 'C1', 'B1', 'b', 'c', 'd'])
  })
  it('several chapters keep their own order, all above the first bookmark', () => {
    expect(place(['B1', 'x', 'C1', 'B2', 'C2'])).toEqual(['C1', 'C2', 'B1', 'x', 'B2'])
  })
  it('a chapter already above every bookmark, or no bookmark at all, leaves the list as it is', () => {
    expect(place(['C1', 'a', 'B1', 'b'])).toEqual(['C1', 'a', 'B1', 'b'])
    expect(place(['a', 'C1', 'b'])).toEqual(['a', 'C1', 'b'])
  })
})

describe('searchCheckpointKindOf', () => {
  it('names a curated bookmark and a live curated chapter, and nothing else', () => {
    expect(searchCheckpointKindOf({ kind: 'bookmark' }, null)).toBe('bookmark')
    expect(searchCheckpointKindOf({ kind: 'bookmark', superseded_by: 'x' }, null)).toBe('bookmark')
    expect(searchCheckpointKindOf({ next_session: true }, null)).toBe('chapter')
    expect(searchCheckpointKindOf({ status: 'active' }, null)).toBe('chapter')
    // A superseded chapter is not lifted: it ranks as fusion left it.
    expect(searchCheckpointKindOf({ superseded_by: 'x', _superseded_prior: { next_session: true } }, null)).toBeNull()
    expect(searchCheckpointKindOf({ type: 'decision' }, null)).toBeNull()
    expect(searchCheckpointKindOf({ next_session: true }, 'auto-capture')).toBeNull()
    expect(searchCheckpointKindOf(null, null)).toBeNull()
  })
})

describe('FlatStore.query: the chapter placed above the bookmark (D275)', () => {
  let dir: string
  let store: FlatStore
  let raw: BetterSqlite3.Database
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-place-'))
    store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'j.db'))), ownsDatabase: true })
    raw = new BetterSqlite3(join(dir, 'j.db'))
  })
  afterEach(async () => {
    raw.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const at = (id: string, t: number): void => { raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(t, id) }

  it('a chapter ranked sixth behind a bookmark ranked third lands on a page of five, above it, pure lexical', async () => {
    const T = 1_800_000_000
    const notes: string[] = []
    for (let i = 0; i < 2; i++) notes.push((await store.insert(`rotor rotor rotor note ${i}`)).nodeId)
    const bookmark = (await store.insert('at: rotor rotor balance', { metadata: { kind: 'bookmark' } })).nodeId
    for (let i = 2; i < 6; i++) notes.push((await store.insert(`rotor note ${i} with a few more words around the rotor`)).nodeId)
    const chapter = (await store.insert('plan: the rotor balance lands after the bench rig is calibrated and the fixtures are checked; next: the spin test', { metadata: { next_session: true } })).nodeId
    for (const [i, id] of [...notes, bookmark, chapter].entries()) at(id, T + i)
    // Without the placement the chapter is below the page: its raw score
    // is the weakest of the eight matches.
    const scored = await store.query('rotor', { topK: 8 })
    const sim = new Map(scored.map((r) => [r.nodeId, r.similarity]))
    expect(Math.min(...sim.values())).toBe(sim.get(chapter))
    expect([...sim.values()].filter((s) => s > sim.get(bookmark)!).length).toBe(2)
    const page = (await store.query('rotor', { topK: 5 })).map((r) => r.nodeId)
    expect(page).toContain(chapter)
    expect(page.indexOf(chapter)).toBe(2)
    expect(page.indexOf(bookmark)).toBe(3)
    // Placement changes order, never a score.
    const placed = await store.query('rotor', { topK: 5 })
    expect(placed.find((r) => r.nodeId === chapter)!.similarity).toBe(sim.get(chapter))
  })

  /** The rotor fixture: two strong notes, a bookmark third, four weaker
   *  notes, the chapter the weakest match; capture times in that order. */
  async function rotor(): Promise<{ chapter: string; bookmark: string }> {
    const T = 1_800_000_000
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push((await store.insert(`rotor rotor rotor note ${i}`)).nodeId)
    const bookmark = (await store.insert('at: rotor rotor balance', { metadata: { kind: 'bookmark' } })).nodeId
    for (let i = 2; i < 6; i++) ids.push((await store.insert(`rotor note ${i} with a few more words around the rotor`)).nodeId)
    const chapter = (await store.insert('plan: the rotor balance lands after the bench rig is calibrated and the fixtures are checked; next: the spin test', { metadata: { next_session: true } })).nodeId
    for (const [i, id] of [...ids, bookmark, chapter].entries()) at(id, T + i)
    return { chapter, bookmark }
  }

  it('chapterPlacement: false leaves the lexical page unplaced', async () => {
    const { chapter } = await rotor()
    expect((await store.query('rotor', { topK: 5 })).map((r) => r.nodeId)).toContain(chapter)
    expect((await store.query('rotor', { topK: 5, chapterPlacement: false })).map((r) => r.nodeId)).not.toContain(chapter)
  })

  it('at the MCP surface a chronological listing gets no placement: it holds the strongest lexical matches', async () => {
    const { chapter } = await rotor()
    const server = createServer(store, {})
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'placement', version: '0' })
    await server.connect(st)
    await client.connect(ct)
    try {
      const page = async (args: Record<string, unknown>): Promise<string[]> => (parseToolResult(await client.callTool({
        name: 'treecontext_query', arguments: { query: 'rotor', top_k: 5, conversation_window: 0, ...args },
      }))['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
      // Discriminating control: the relevance page does place the chapter.
      expect(await page({ recency_weight: 0 })).toContain(chapter)
      for (const sort_by of ['chronological', 'reverse_chronological']) {
        const listing = await page({ sort_by })
        expect(listing, sort_by).not.toContain(chapter)
        expect(listing).toHaveLength(5)
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('a bookmark is ranked by its own score: no factor in the ordering that chooses the candidates', async () => {
    const bookmark = (await store.insert('at: impeller impeller', { metadata: { kind: 'bookmark' } })).nodeId
    const note = (await store.insert('impeller note with several more words around it')).nodeId
    const hits = await store.query('impeller', { topK: 2 })
    expect(hits.map((h) => h.nodeId)).toEqual([bookmark, note])
  })

  it('fusion orders first, placement after: a newer, stronger bookmark still sits below its chapter', async () => {
    const T = 1_800_000_000
    const chapter = (await store.insert('plan: stator winding lands before the enclosure ships; next: the thermal run, then the tests', { metadata: { next_session: true } })).nodeId
    const bookmark = (await store.insert('at: stator winding', { metadata: { kind: 'bookmark' } })).nodeId
    at(chapter, T); at(bookmark, T + 60)
    const fused = await store.query('stator winding', { topK: 5, recencyWeight: 0.25 })
    expect(fused.map((h) => h.nodeId)).toEqual([chapter, bookmark])
    expect(fused[1]!.similarity).toBeGreaterThan(fused[0]!.similarity)
    // A chronological listing is not a relevance ordering: no placement.
    const chrono = await store.query('stator winding', { topK: 5, sortBy: 'reverse_chronological' })
    expect(chrono.map((h) => h.nodeId)).toEqual([bookmark, chapter])
  })

  it('adaptive counts from the scores before placement, then cuts the placed order', async () => {
    let seen: { returnedK: number } | undefined
    await store.insert('plan: the valve seat is reground after the leak test and the bench rig recalibrated, next the pressure soak', { metadata: { next_session: true } })
    await store.insert('at: valve seat', { metadata: { kind: 'bookmark' } })
    const hits = await store.query('valve seat', { topK: 5, adaptive: true, onAdaptive: (m) => { seen = m } })
    expect(seen!.returnedK).toBe(hits.length)
    expect(searchCheckpointKindOf(hits[0]!.metadata, null)).toBe('chapter')
  })
})
