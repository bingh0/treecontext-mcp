/**
 * D268: a metadata filter's flat scalar keys narrow the candidates in the
 * query itself; what the query cannot carry still sifts the pool. The
 * predicate builder in isolation, then end to end through FlatStore.query
 * over a real SQLite file, read back by the rows the store returns.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { FlatStore } from '../../src/flat-store.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { metadataFilterSql, isFlatFilterEntry } from '../../src/persistence/metadata-filter.js'

describe('metadataFilterSql: which keys the query carries', () => {
  const COL = 'n.metadata_json'
  it('a string, a number, a boolean and null each become one typed predicate', () => {
    const r = metadataFilterSql({ kind: 'bookmark', n: 3, live: true, gone: false, z: null }, COL)
    expect(r.residue).toBeUndefined()
    const g = (p: string): string => `(CASE WHEN json_valid(${COL}) THEN ${p} ELSE 0 END)`
    expect(r.where).toEqual([
      g(`(json_type(${COL}, ?) = 'text' AND json_extract(${COL}, ?) = ?)`),
      g(`(json_type(${COL}, ?) IN ('integer', 'real') AND json_extract(${COL}, ?) = ?)`),
      g(`json_type(${COL}, ?) = 'true'`),
      g(`json_type(${COL}, ?) = 'false'`),
      g(`json_type(${COL}, ?) = 'null'`),
    ])
    expect(r.params).toEqual(['$.kind', '$.kind', 'bookmark', '$.n', '$.n', 3, '$.live', '$.gone', '$.z'])
  })
  it('a nested object, an array, a non-finite number stay on the post-filter', () => {
    const r = metadataFilterSql({ kind: 'x', _media: { mimeType: 'image/png' }, tags: ['a'], inf: Infinity }, COL)
    expect(r.where).toHaveLength(1)
    expect(r.residue).toEqual({ _media: { mimeType: 'image/png' }, tags: ['a'], inf: Infinity })
  })
  it('a key name that is not a plain identifier is never spliced into a JSON path', () => {
    for (const key of ['a.b', "x') OR 1=1 --", '$', '1abc', 'with space', '']) {
      expect(isFlatFilterEntry(key, 'v'), key).toBe(false)
      expect(metadataFilterSql({ [key]: 'v' }, COL)).toMatchObject({ where: [], residue: { [key]: 'v' } })
    }
  })
  it('the lifted boundary keys stay on the post-filter (served from columns)', () => {
    const r = metadataFilterSql({ _index_len: 10, _preview_len: 5 }, COL)
    expect(r.where).toEqual([])
    expect(r.residue).toEqual({ _index_len: 10, _preview_len: 5 })
  })
  it('a row whose metadata is not valid JSON matches nothing and never throws', () => {
    // The store's own schema refuses invalid JSON on write today (its
    // json-expression indexes and the reference trigger), so the guard is
    // exercised on a bare table: the predicates as built, over a valid and
    // an invalid row, filtered with no FTS narrowing.
    const db = new BetterSqlite3(':memory:')
    try {
      db.exec('CREATE TABLE nodes (id TEXT, metadata_json TEXT)')
      db.prepare('INSERT INTO nodes VALUES (?, ?)').run('good', '{"kind":"k","n":1,"b":true,"z":null}')
      db.prepare('INSERT INTO nodes VALUES (?, ?)').run('bad', '{"kind": "k", broken')
      db.prepare('INSERT INTO nodes VALUES (?, ?)').run('none', null)
      const r = metadataFilterSql({ kind: 'k', n: 1, b: true, z: null }, 'n.metadata_json')
      const rows = db.prepare(`SELECT id FROM nodes n WHERE ${r.where.join(' AND ')}`).all(...(r.params as never[])) as Array<{ id: string }>
      expect(rows.map((x) => x.id)).toEqual(['good'])
      // The unguarded form is what would have thrown.
      expect(() => db.prepare("SELECT id FROM nodes n WHERE json_type(n.metadata_json, '$.kind') = 'text'").all()).toThrow(/malformed JSON/)
    } finally { db.close() }
  })

  it('an empty filter is all residue, keeping its old meaning', () => {
    expect(metadataFilterSql({}, COL)).toEqual({ where: [], params: [], residue: {} })
  })
})

describe('FlatStore.query: the filter in the query (D268)', () => {
  let dir: string
  let store: FlatStore
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-metafilter-'))
    store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'j.db'))), ownsDatabase: true })
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const ids = async (filter: Record<string, unknown>, q = 'gauge'): Promise<string[]> =>
    (await store.query(q, { topK: 20, metadataFilter: filter })).map((r) => r.nodeId)

  it('compares each scalar type exactly: a boolean never matches a stored number, null only null, a missing key nothing', async () => {
    const one = (await store.insert('gauge reading one', { metadata: { flag: 1, label: 'a' } })).nodeId
    const yes = (await store.insert('gauge reading true', { metadata: { flag: true, label: 'b' } })).nodeId
    const str = (await store.insert('gauge reading string', { metadata: { flag: '1', label: 'c' } })).nodeId
    const nul = (await store.insert('gauge reading null', { metadata: { flag: null, label: 'd' } })).nodeId
    const real = (await store.insert('gauge reading real', { metadata: { flag: 2.5, label: 'e' } })).nodeId
    const none = (await store.insert('gauge reading none', { metadata: { label: 'f' } })).nodeId
    expect(await ids({ flag: 1 })).toEqual([one])
    expect(await ids({ flag: true })).toEqual([yes])
    expect(await ids({ flag: '1' })).toEqual([str])
    expect(await ids({ flag: null })).toEqual([nul])
    expect(await ids({ flag: 2.5 })).toEqual([real])
    expect(await ids({ flag: false })).toEqual([])
    expect(await ids({ absent: 'x' })).toEqual([])
    expect((await ids({ label: 'f' }))).toEqual([none])
  })

  it('a flat key finds a row however deep its words rank; the pool filter alone would not', async () => {
    const target = (await store.insert('a long aside where the gauge is mentioned once among many other words about calibration rigs and bench schedules', {
      metadata: { kind: 'bookmark', _cc_session_id: 'cc-x' },
    })).nodeId
    for (let i = 0; i < 260; i++) await store.insert(`gauge gauge note ${i}`, { metadata: { type: 'note' } })
    // Its words alone do not reach it: past the post-filter's pool of 200.
    const lexical = (await store.query('gauge', { topK: 20 })).map((r) => r.nodeId)
    expect(lexical).not.toContain(target)
    expect(await ids({ kind: 'bookmark' })).toEqual([target])
    // A residue key keeps the pool filter, so the same filter with an
    // unflattenable key added cannot reach it — the old behaviour.
    expect(await ids({ kind: 'bookmark', _media: { x: 1 } })).toEqual([])
  })

  it('a residue key still sifts the pool exactly as before', async () => {
    const a = (await store.insert('gauge with media', { metadata: { kind: 'k', _media: { uri: 'file:///a.png', mimeType: 'image/png' } } })).nodeId
    await store.insert('gauge without media', { metadata: { kind: 'k' } })
    // Strict equality never matches an object value: unchanged.
    expect(await ids({ kind: 'k', _media: { uri: 'file:///a.png', mimeType: 'image/png' } })).toEqual([])
    expect((await store.query('gauge', { topK: 20, metadataFilter: { kind: 'k' }, mediaFilter: { mimePrefix: 'image/' } })).map((r) => r.nodeId)).toEqual([a])
  })

  it('an imported row in a handoff lane is found by a flat-key filter', async () => {
    const file = JSON.stringify({
      version: 1, exported_by: 'a@host-a',
      nodes: [{ nodeId: 'b'.repeat(32), content: 'plan: gauge rollout chapter', createdAt: Date.now() / 1000, metadata: { next_session: true, thread: 'rollout', _cc_session_id: 'cc-a' } }],
    })
    expect((await store.importJson(file, { handoff: { file: 'handoffs/a.json', importer: 'cc-b' } })).importedCount).toBe(1)
    await store.insert('gauge rollout local note', { metadata: { thread: 'other' } })
    const hits = await store.query('gauge rollout', { topK: 5, metadataFilter: { thread: 'rollout' } })
    expect(hits.map((h) => h.nodeId)).toEqual(['b'.repeat(32)])
    expect(String(hits[0]!.metadata?.['session_id'])).toMatch(/^handoff:/)
  })
})
