/**
 * References and lanes (D186, D169) below the charter: the reverse index's
 * upkeep through every row change, its backfill on an existing store, and
 * the supersession rule's two sides. The charter scenarios live in
 * features/journal-orchestration.feature; these pin what they lean on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { migrations } from '../src/persistence/migrations/index.js'
import { referencedBy, laneWriterOf, MAIN_LANE } from '../src/references.js'
import { createServer } from '../src/server/server.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-refs-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'refs.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path())), retentionInterval: 1_000_000 })
function index(): Array<{ ref_id: string; node_id: string }> {
  const raw = new BetterSqlite3(path(), { readonly: true })
  try { return raw.prepare('SELECT ref_id, node_id FROM node_refs ORDER BY ref_id, node_id').all() as Array<{ ref_id: string; node_id: string }> } finally { raw.close() }
}
function meta(id: string): Record<string, unknown> {
  const raw = new BetterSqlite3(path(), { readonly: true })
  try { return JSON.parse((raw.prepare('SELECT metadata_json AS m FROM nodes WHERE node_id = ?').get(id) as { m: string }).m) as Record<string, unknown> } finally { raw.close() }
}

describe('the reverse index (D186)', () => {
  it('indexes a string ref and every text member of an array, never a self-reference', async () => {
    const s = await open()
    const a = (await s.insert('entry a')).nodeId
    const b = (await s.insert('entry b')).nodeId
    const c = (await s.insert('entry c names a', { metadata: { refs: a } })).nodeId
    const d = (await s.insert('entry d names a and b', { metadata: { refs: [a, b, 7, null] } })).nodeId
    expect(index()).toEqual([
      { ref_id: a, node_id: c }, { ref_id: a, node_id: d }, { ref_id: b, node_id: d },
    ].sort((x, y) => (x.ref_id + x.node_id).localeCompare(y.ref_id + y.node_id)))
    await s.close()
  })

  it('follows a change of refs and a deletion, and ignores metadata changes that leave refs alone', async () => {
    const s = await open()
    const a = (await s.insert('entry a')).nodeId
    const b = (await s.insert('entry b')).nodeId
    const c = (await s.insert('entry c', { metadata: { refs: [a] } })).nodeId
    const raw = new BetterSqlite3(path())
    try {
      raw.prepare("UPDATE nodes SET metadata_json = json_set(metadata_json, '$._relied_count', 3) WHERE node_id = ?").run(c)
      expect(index()).toEqual([{ ref_id: a, node_id: c }])
      raw.prepare("UPDATE nodes SET metadata_json = json_set(metadata_json, '$.refs', json_array(?)) WHERE node_id = ?").run(b, c)
      expect(index()).toEqual([{ ref_id: b, node_id: c }])
      raw.prepare('DELETE FROM nodes WHERE node_id = ?').run(c)
      expect(index()).toEqual([])
    } finally { raw.close() }
    await s.close()
  })

  it('migration 026 backfills the refs an existing store already carries', async () => {
    const s = await open()
    const a = (await s.insert('entry a')).nodeId
    const c = (await s.insert('entry c', { metadata: { refs: [a] } })).nodeId
    await s.close()
    const raw = new BetterSqlite3(path())
    try {
      raw.exec('DROP TRIGGER trg_node_refs_insert; DROP TRIGGER trg_node_refs_update; DROP TRIGGER trg_node_refs_delete; DROP TABLE node_refs')
      migrations.find((m) => m.version === 26)!.up(wrapBetterSqlite(raw))
    } finally { raw.close() }
    expect(index()).toEqual([{ ref_id: a, node_id: c }])
  })

  it('shows one hop: the newest referrer, the count, and nothing of the referrer beyond its first line', async () => {
    const s = await open()
    const a = (await s.insert('entry a')).nodeId
    await s.insert('older referrer\nsecond line', { metadata: { refs: a, agent_type: 'tester' }, createdAt: Date.now() / 1000 - 600 })
    const newest = (await s.insert('newest referrer\nits second line', { metadata: { refs: a, _writer: 'reviewer' } })).nodeId
    await s.insert('a referrer of the referrer', { metadata: { refs: newest } })
    const raw = new BetterSqlite3(path(), { readonly: true })
    try {
      const by = referencedBy(raw, a)!
      expect(by).toMatchObject({ count: 2, newest: { nodeId: newest, writer: 'reviewer', firstLine: 'newest referrer', age: '0 minutes' } })
    } finally { raw.close() }
    await s.close()
  })
  it('reads referrers from the index, not by scanning metadata', async () => {
    const s = await open()
    const a = (await s.insert('entry a')).nodeId
    const b = (await s.insert('entry b, which names nothing')).nodeId
    const raw = new BetterSqlite3(path())
    try {
      // An index row whose referrer's metadata names nothing: only a reader
      // of the index can see it.
      raw.prepare('INSERT INTO node_refs (ref_id, node_id) VALUES (?, ?)').run(a, b)
      expect(referencedBy(raw, a)?.newest.nodeId).toBe(b)
    } finally { raw.close() }
    await s.close()
  })
})

describe('supersession across lanes (D169)', () => {
  it('the same writer still retires its own pointer', async () => {
    const s = await open()
    const plan = (await s.insert('plan: one', { metadata: { next_session: true, agent_type: 'tester' } })).nodeId
    const r = await s.insert('plan: two', { metadata: { next_session: true, agent_type: 'tester' }, supersedes: [plan] })
    expect(r.superseded).toEqual([plan])
    expect(r.referenced).toBeUndefined()
    expect(meta(plan)['next_session']).toBeUndefined()
    expect(meta(plan)['superseded_by']).toBe(r.nodeId)
    await s.close()
  })

  it('a new session of the main lane retires the last session\'s chapter: the session is not the writer', async () => {
    const s = await open()
    const plan = (await s.insert('plan: one', { metadata: { next_session: true, _cc_session_id: 'cc-1' } })).nodeId
    const r = await s.insert('plan: two', { metadata: { next_session: true, _cc_session_id: 'cc-2' }, supersedes: [plan] })
    expect(r.superseded).toEqual([plan])
    expect(laneWriterOf({ _cc_session_id: 'cc-2' })).toBe(MAIN_LANE)
    await s.close()
  })

  it('another writer\'s target is left untouched and becomes a reference on the new entry', async () => {
    const s = await open()
    const plan = (await s.insert('plan: the orchestrator\'s', { metadata: { next_session: true } })).nodeId
    const row = (): unknown => { const raw = new BetterSqlite3(path(), { readonly: true }); try { return raw.prepare('SELECT * FROM nodes WHERE node_id = ?').get(plan) } finally { raw.close() } }
    const before = row()
    const r = await s.insert('tester: this plan fails', { metadata: { agent_type: 'tester', refs: ['other'] }, supersedes: [plan] })
    expect(r.superseded).toEqual([])
    expect(r.referenced).toEqual([plan])
    expect(row()).toEqual(before) // every column, byte for byte
    expect(meta(r.nodeId)['refs']).toEqual(['other', plan])
    await s.close()
  })

  it('a bookmark supersedes the session\'s previous bookmark in its own lane only (D241: one live per session per lane)', async () => {
    const s = await open()
    const mine = (await s.insert('at: orchestrating; next: review', { metadata: { kind: 'bookmark', _cc_session_id: 'cc-1' } })).nodeId
    const theirs = await s.insert('at: testing; next: CSRF', { metadata: { kind: 'bookmark', agent_type: 'tester', _cc_session_id: 'cc-1' } })
    expect(theirs.superseded ?? []).toEqual([])
    expect(meta(mine)['next_session']).toBe(true)
    const theirs2 = await s.insert('at: tested; next: report', { metadata: { kind: 'bookmark', agent_type: 'tester', _cc_session_id: 'cc-1' } })
    expect(theirs2.superseded).toEqual([theirs.nodeId])
    const mine2 = await s.insert('at: reviewing; next: merge', { metadata: { kind: 'bookmark', _cc_session_id: 'cc-1' } })
    expect(mine2.superseded).toEqual([mine])
    expect(meta(theirs2.nodeId)['next_session']).toBe(true)
    await s.close()
  })

  it('an empty _writer does not mask a claimed agent_type', () => {
    expect(laneWriterOf({ agent_type: 'tester', _writer: '' })).toBe('tester')
    expect(laneWriterOf({ _writer: '  ' })).toBe(MAIN_LANE)
  })

  it('an imported entry\'s lane is its session key, the claimed session behind handoff: (D223)', () => {
    expect(laneWriterOf({ session_id: 'handoff:cc-alice', _handoff_file: 'handoffs/alice.json' })).toBe('handoff:cc-alice')
    expect(laneWriterOf({ session_id: 'handoff:cc-alice', _handoff_file: 'handoffs/other.json' })).toBe('handoff:cc-alice')
  })

  it('a dedup hit records no refs and says so, and the survivor is never modified', async () => {
    const s = await open()
    const plan = (await s.insert('plan: the orchestrator\'s', { metadata: { next_session: true } })).nodeId
    const a = (await s.insert('entry a')).nodeId
    const first = (await s.insert('tester: same finding', { metadata: { agent_type: 'tester' } })).nodeId
    const before = meta(first)
    const r = await s.insert('tester: same finding', { metadata: { agent_type: 'tester', refs: [a] }, supersedes: [plan] })
    expect(r).toMatchObject({ nodeId: first, deduplicated: true, superseded: [] })
    expect(r.refsNotRecorded).toEqual([a, plan])
    expect(r.supersedeMisses).toEqual([{ nodeId: plan, reason: 'other_writer' }])
    expect(r.referenced).toBeUndefined()
    expect(meta(first)).toEqual(before)
    expect(meta(plan)['next_session']).toBe(true)
    await s.close()
  })
})

describe('which referrer is shown, and from where (D186, D187, D196)', () => {
  it('the newest referrer from another lane is shown over newer same-lane notes; the count is all', async () => {
    const s = await open()
    const c = (await s.insert('plan: the chapter', { metadata: { next_session: true } })).nodeId
    const t = (await s.insert('CSRF blocks the plan', { metadata: { agent_type: 'tester', refs: [c] }, createdAt: Date.now() / 1000 - 600 })).nodeId
    for (let i = 0; i < 3; i++) await s.insert(`orchestrator note ${i}`, { metadata: { refs: [c] } })
    const raw = new BetterSqlite3(path(), { readonly: true })
    try {
      expect(referencedBy(raw, c)).toMatchObject({ count: 4, newest: { nodeId: t, writer: 'tester', firstLine: 'CSRF blocks the plan' } })
      // With no other-lane referrer, the newest same-lane one is shown.
      const own = (await s.insert('another plan', { metadata: { next_session: true } })).nodeId
      const note = (await s.insert('a note on it', { metadata: { refs: own } })).nodeId
      expect(referencedBy(raw, own)?.newest.nodeId).toBe(note)
    } finally { raw.close() }
    await s.close()
  })

  it('a referrer in another namespace never shows in this one', async () => {
    const db = wrapBetterSqlite(new BetterSqlite3(path()))
    const x = await FlatStore.open({ database: db, ownsDatabase: false, namespace: 'x', retentionInterval: 1_000_000 })
    const y = await FlatStore.open({ database: db, ownsDatabase: false, namespace: 'y', retentionInterval: 1_000_000 })
    const a = (await x.insert('decision in x: the session cookie')).nodeId
    await y.insert('secret of y names x', { metadata: { refs: [a] } })
    expect(index()).toHaveLength(1) // the pair is indexed …
    const hit = (await x.query('session cookie', { topK: 1 }))[0]!
    expect(hit.nodeId).toBe(a)
    expect(hit.referencedBy).toBeUndefined() // … and never read across the boundary
    const yText = (await y.query('secret', { topK: 1 }))[0]!.content // the needle, as y holds it
    expect(yText).toBe('secret of y names x')
    expect(x.exportJson({ nodeId: a, recordReliance: false })).not.toContain(yText)
    await x.close(); await y.close(); db.close()
  })
})

describe('the insert tool (D165, D169)', () => {
  async function tool(): Promise<{ call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => Promise<void> }> {
    const ctx = await open()
    const server = createServer(ctx, {})
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0.0.0' })
    await server.connect(st)
    await client.connect(ct)
    return {
      call: async (args) => {
        const res = await client.callTool({ name: 'treecontext_insert', arguments: args }) as { content: Array<{ text: string }> }
        return JSON.parse(res.content[0]!.text) as Record<string, unknown>
      },
      close: async () => { await client.close(); await server.close(); await ctx.close() },
    }
  }

  it('drops a caller\'s _handoff_* keys: the importer\'s marks cannot be forged', async () => {
    const t = await tool()
    const r = await t.call({ content: 'a note pretending to be imported', metadata: { _handoff_file: 'alice.json', _handoff_sender: 'alice@x', kind: 'note' } })
    const m = meta(r['node_id'] as string)
    expect(m['kind']).toBe('note')
    expect(Object.keys(m).filter((k) => k.startsWith('_handoff_'))).toEqual([])
    await t.close()
  })

  it('says what a cross-writer supersedes did, and what a dedup hit could not record', async () => {
    const t = await tool()
    const plan = (await t.call({ content: 'plan: wire the form', metadata: { next_session: true } }))['node_id'] as string
    const r = await t.call({ content: 'tester: CSRF first', metadata: { agent_type: 'tester' }, supersedes: [plan] })
    expect(r['superseded']).toEqual([])
    expect(r['referenced']).toEqual([plan])
    expect(r['referenced_note']).toMatch(/another writer.*refs.*referenced-by/)
    const other = (await t.call({ content: 'an earlier finding' }))['node_id'] as string
    const again = await t.call({ content: 'tester: CSRF first', metadata: { agent_type: 'tester', refs: [other] }, supersedes: [plan] })
    expect(again['deduplicated']).toBe(true)
    expect(again['supersede_misses']).toEqual([{ nodeId: plan, reason: 'other_writer' }])
    // The survivor already carries the plan; only the new ref went nowhere.
    expect(again['refs_not_recorded']).toEqual([other])
    expect(again['refs_note']).toMatch(/not recorded/)
    await t.close()
  })
})
