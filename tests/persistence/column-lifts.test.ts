import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'

// G5 (store-as-arbiter §4 + amendment 7): the lifted columns are the
// read-side truth. These tests force a divergence between a column and
// its metadata copy — the state a backfill-skipped row or a foreign
// import can produce — and assert every read path follows the COLUMN.
describe('column lifts are the read truth (G5)', () => {
  let dir: string
  let store: FlatStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-lifts-'))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    store = await FlatStore.open({ database: db, ownsDatabase: true })
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a hit’s display cut follows the index_len column, not a diverged metadata copy', async () => {
    const content = 'boundary truth: the engine decides where the preview ends, not annotation'
    const { nodeId } = await store.insert(content, {
      sourceLabel: 'auto-capture',
      metadata: { session_id: 'sess', _index_len: 20 },
    })
    // Diverge: metadata claims a much wider cut; the column keeps 20.
    store.store.database
      .prepare("UPDATE nodes SET metadata_json = json_set(metadata_json, '$._index_len', 9999) WHERE node_id = ?")
      .run(nodeId)

    const [hit] = await store.query('boundary truth engine', { topK: 1 })
    expect(hit).toBeDefined()
    // Cut at the COLUMN's 20 chars, marker appended — 9999 would have
    // returned the whole content unmarked.
    expect(hit!.content.startsWith(content.slice(0, 20))).toBe(true)
    expect(hit!.content).toContain('…[preview')
    // And the served metadata carries the column's value under the
    // metadata name (read-compat, sourced from the lift).
    expect(hit!.metadata?.['_index_len']).toBe(20)
  })

  it('conversation windows are keyed by the session_key column', async () => {
    for (let i = 0; i < 3; i++) {
      await store.insert(`window row number ${i} anchor-topic`, {
        sourceLabel: 'auto-capture',
        metadata: { session_id: 'sess-w', role: 'user' },
        createdAt: 1000 + i * 400, // outside the dedup window of each other
      })
    }
    // Strip the metadata session keys from the middle row: the column
    // still knows its session, so the window must still include it.
    store.store.database
      .prepare(
        "UPDATE nodes SET metadata_json = json_remove(metadata_json, '$.session_id') WHERE content LIKE '%number 1%'",
      )
      .run()

    const [hit] = await store.query('window row number 2 anchor-topic', { topK: 1, conversationWindow: 2 })
    expect(hit).toBeDefined()
    const windowIds = [...(hit!.window?.before ?? []), ...(hit!.window?.after ?? [])].map((e) => e.content)
    expect(windowIds.some((c) => c.includes('number 1'))).toBe(true)
  })

  it('status counts sessions and previews from the columns, through the full identity ladder', async () => {
    // A hook-captured row (session_id) and a note-only row
    // (_cc_session_id): the old bare $.session_id count saw one session;
    // the session_key ladder sees two. Ruled a fix, not a regression.
    await store.insert('hook captured row', {
      sourceLabel: 'auto-capture',
      metadata: { session_id: 'sess-hook', _index_len: 5 },
    })
    await store.insert('a note through the server', { metadata: { _cc_session_id: 'sess-note' } })

    const vitals = store.vitals(Date.now() / 1000) as unknown as { trail: { sessions: number; previewed: number } }
    expect(vitals.trail.sessions).toBe(2)
    expect(vitals.trail.previewed).toBe(1)
  })

  it('a sessionless row is not a session, and an all-content boundary is not a preview', async () => {
    await store.insert('a real session row', { metadata: { session_id: 'sess-real', _index_len: 4 } })
    // Sessionless: the sentinel bucket must not inflate the count (G5
    // review — the column stores '__nosession__', never NULL).
    await store.insert('a note with no session identity at all')
    // Boundary == content length: nothing behind the cut, so nothing is
    // "previewed" — the stricter column semantics are the ruled meaning.
    const wholeText = 'boundary covers everything'
    await store.insert(wholeText, { metadata: { session_id: 'sess-real', _index_len: wholeText.length } })

    const vitals = store.vitals(Date.now() / 1000) as unknown as { trail: { sessions: number; previewed: number } }
    expect(vitals.trail.sessions).toBe(1)
    expect(vitals.trail.previewed).toBe(1)
  })
})
