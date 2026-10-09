/**
 * Step 2 (MVP lexical spec): FlatStore read/write path.
 * AC2.1 round-trip+bm25, AC2.2 no native-ML, AC2.3 hostile-input safety,
 * AC2.4 metadata/time/sort, AC2.5 bm25-primary, AC2.6 resume/namespace/export,
 * AC2.7 dedup, AC2.8-2.11 retention (session/entry/protection/disk-bounded).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import type { Database } from '../src/persistence/database.js'
import { FlatStore, type FlatStoreOptions } from '../src/flat-store.js'
import { describePosix } from './helpers/platform.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-flat-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

function dbPath(name = 'flat.db'): string { return join(tmpDir, name) }
function openDb(name = 'flat.db'): Database { return wrapBetterSqlite(new BetterSqlite3(dbPath(name))) }
function open(opts?: Partial<FlatStoreOptions>, name = 'flat.db'): Promise<FlatStore> {
  return FlatStore.open({ database: openDb(name), ...opts })
}
function setCreatedAt(db: Database, nodeId: string, ts: number): void {
  db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(ts, nodeId)
}

describe('AC2.1 insert→query round-trip + bm25 ordering', () => {
  it('returns the most lexically relevant doc first', async () => {
    const s = await open()
    await s.insert('the cat sat on the mat')
    await s.insert('database persistence with sqlite and bm25 ranking')
    await s.insert('quantum chromodynamics and gluon fields')
    const r = await s.query('sqlite bm25 database', { topK: 3 })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.content).toContain('sqlite')
    await s.close()
  })
})

describe('AC2.2 no native-ML in the FlatStore path', () => {
  it('opens + inserts + queries with no embedder and loads no ML native modules', async () => {
    const s = await open()
    await s.insert('lexical only, no embeddings here')
    await s.query('lexical')
    s.retentionSweep()
    const req = createRequire(import.meta.url)
    const loaded = Object.keys(req.cache)
    expect(loaded.some((p) => /onnxruntime-node|[\\/]tokenizers[\\/]|[\\/]usearch[\\/]/.test(p))).toBe(false)
    await s.close()
  })
})

describe('AC2.3 query never throws on hostile input', () => {
  it('handles FTS5 operators / identifiers / paths / flags', async () => {
    const s = await open()
    await s.insert('content about _evictOne in ts/src/server/journal-context.ts')
    for (const q of ['_evictOne', 'ts/src/server/journal-context.ts', '--instructions none', 'a OR b NEAR("x")', 'foo*', '"unbalanced', '()', '']) {
      const r = await s.query(q)
      expect(Array.isArray(r)).toBe(true)
    }
    await s.close()
  })
})

describe('AC2.4 metadata_filter / time_range / sort_by', () => {
  it('filters by metadata (AND)', async () => {
    const s = await open()
    await s.insert('alpha doc', { metadata: { topic: 'x' } })
    await s.insert('beta doc', { metadata: { topic: 'y' } })
    const r = await s.query('doc', { metadataFilter: { topic: 'x' } })
    expect(r.map((h) => h.content)).toEqual(['alpha doc'])
    await s.close()
  })
  it('filters by time_range and orders by sort_by', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false })
    const a = (await s.insert('shared term one')).nodeId
    const b = (await s.insert('shared term two')).nodeId
    const c = (await s.insert('shared term three')).nodeId
    setCreatedAt(db, a, 1000); setCreatedAt(db, b, 2000); setCreatedAt(db, c, 3000)
    const chrono = await s.query('', { sortBy: 'chronological', topK: 10 })
    expect(chrono.map((h) => h.nodeId)).toEqual([a, b, c])
    const rev = await s.query('', { sortBy: 'reverse_chronological', topK: 10 })
    expect(rev.map((h) => h.nodeId)).toEqual([c, b, a])
    const windowed = await s.query('', { timeRange: { after: 1500, before: 2500 }, topK: 10 })
    expect(windowed.map((h) => h.nodeId)).toEqual([b])
    await s.close()
    db.close()
  })
})

describe('AC2.6 resume pointers / supersede / namespace / export-import', () => {
  it('surfaces resume pointers and clears them on supersede', async () => {
    const s = await open()
    const first = (await s.insert('plan A', { metadata: { next_session: true, status: 'active' } })).nodeId
    expect(s.status().resumePointers.map((p) => p.nodeId)).toContain(first)
    await s.insert('plan B supersedes A', { supersedes: [first] })
    expect(s.status().resumePointers.map((p) => p.nodeId)).not.toContain(first)
    await s.close()
  })
  it('isolates namespaces', async () => {
    const db = openDb()
    const a = await FlatStore.open({ database: db, namespace: 'agent-a', ownsDatabase: false })
    const b = await FlatStore.open({ database: db, namespace: 'agent-b', ownsDatabase: false })
    await a.insert('secret in a')
    expect((await b.query('secret')).length).toBe(0)
    expect(a.status().totalNodes).toBe(1)
    expect(b.status().totalNodes).toBe(0)
    await a.close(); await b.close(); db.close()
  })
  it('exports a node by id even when it sorts past maxExportNodes (LIMIT-before-filter regression)', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false })
    const older = (await s.insert('older node')).nodeId
    const newest = (await s.insert('the newest resume pointer')).nodeId
    setCreatedAt(db, older, 1000)
    setCreatedAt(db, newest, 2000)
    // maxExportNodes 1: the created_at-ordered scan only covers `older`, so a
    // LIMIT-before-filter implementation would export `newest` as [].
    const json = s.exportJson({ nodeId: newest, maxExportNodes: 1 })
    const parsed = JSON.parse(json) as { nodes: Array<{ nodeId: string; content: string }> }
    expect(parsed.nodes.map((n) => n.nodeId)).toEqual([newest])
    expect(parsed.nodes.map((n) => n.content)).toEqual(['the newest resume pointer'])
    // A genuinely missing id is an explicit error (MemTree semantics), not a
    // silent empty export.
    expect(() => s.exportJson({ nodeId: 'no-such-node' })).toThrow(/not found/)
    await s.close()
    db.close()
  })
  it('export → import round-trips across a fresh store', async () => {
    const s1 = await open({}, 'one.db')
    await s1.insert('exported content one')
    await s1.insert('exported content two')
    const json = s1.exportJson()
    await s1.close()
    const s2 = await open({}, 'two.db')
    const res = await s2.importJson(json)
    expect(res.importedCount).toBe(2)
    expect((await s2.query('exported content')).length).toBe(2)
    await s2.close()
  })
})

describe('AC2.7 content-fingerprint dedup', () => {
  it('dedups identical content but not shared-prefix content', async () => {
    const s = await open()
    const r1 = await s.insert('identical note')
    const r2 = await s.insert('identical note')
    expect(r2.deduplicated).toBe(true)
    expect(r2.nodeId).toBe(r1.nodeId)
    expect(s.status().totalNodes).toBe(1)
    const shared = 'X'.repeat(64)
    await s.insert(`${shared} TAIL-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
    await s.insert(`${shared} TAIL-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`)
    expect(s.status().totalNodes).toBe(3)
    await s.close()
  })
})

describe('AC2.8-2.11 retention (D6)', () => {
  function insertAuto(s: FlatStore, content: string, session: string, extra?: Record<string, unknown>) {
    return s.insert(content, { metadata: { source: 'auto-capture', session_id: session, ...extra } })
  }

  it('AC2.8 session-count: evicts whole oldest sessions atomically', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false, maxSessions: 2, retentionInterval: 1_000_000 })
    const a = (await insertAuto(s, 'sess one alpha', 's1')).nodeId
    const b = (await insertAuto(s, 'sess two beta', 's2')).nodeId
    const c = (await insertAuto(s, 'sess three gamma', 's3')).nodeId
    setCreatedAt(db, a, 1000); setCreatedAt(db, b, 2000); setCreatedAt(db, c, 3000)
    s.retentionSweep()
    // s1 is archived whole and replaced by its tombstone (charter valve,
    // 2026-07-24): s2 + s3 + tombstone.
    expect(s.status().totalNodes).toBe(3)
    expect((await s.query('alpha')).length).toBe(0) // s1 gone from FTS too
    expect((await s.query('gamma')).length).toBe(1)
    await s.close(); db.close()
  })

  it('AC2.9 entry-count safety net: peels whole oldest sessions, never fragments', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false, maxAutoEntries: 3, retentionInterval: 1_000_000 })
    const ids: string[] = []
    for (let sess = 0; sess < 3; sess++) {
      for (let i = 0; i < 2; i++) {
        ids.push((await insertAuto(s, `retentiondoc s${sess}marker${i}`, `s${sess}`)).nodeId)
      }
    }
    ids.forEach((id, i) => setCreatedAt(db, id, 1000 + i))
    s.retentionSweep()
    // 6 entries over a cap of 3: s0 and s1 peel WHOLE (the old oldest-first
    // ENTRY cap fragmented sessions — charter forbids it); s2 survives
    // complete; two tombstones stand in for the archived sessions.
    expect((await s.query('s0marker0')).length).toBe(0)
    expect((await s.query('s1marker1')).length).toBe(0)
    expect((await s.query('s2marker0')).length).toBe(1)
    expect((await s.query('s2marker1')).length).toBe(1)
    expect(s.status().totalNodes).toBe(4) // s2's 2 rows + 2 tombstones
    await s.close(); db.close()
  })

  it('AC2.9b the newest session is never evicted, even alone over the cap', async () => {
    const s = await open({ maxAutoEntries: 3, retentionInterval: 1_000_000 })
    for (let i = 0; i < 5; i++) await insertAuto(s, `solo marker${i}`, 'only')
    s.retentionSweep()
    // Over cap, but the only session is the newest: absolutely protected.
    expect(s.status().totalNodes).toBe(5)
    await s.close()
  })

  it('AC2.10 protects authored / decay-exempt / read-only / resume-pointer', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false, maxSessions: 1, retentionInterval: 1_000_000 })
    await s.insert('authored decision', { metadata: { source: 'user' } })
    const prot = [
      (await insertAuto(s, 'pinned nextfact', 's1', { next_session: true })).nodeId,
      (await s.insert('exempt note', { decayExempt: true, metadata: { source: 'auto-capture', session_id: 's1' } })).nodeId,
      (await s.insert('readonly note', { readOnly: true, metadata: { source: 'auto-capture', session_id: 's1' } })).nodeId,
    ]
    const plain = (await insertAuto(s, 'plain evictable capture', 's1')).nodeId
    const newer = (await insertAuto(s, 'newer capture', 's2')).nodeId
    ;[...prot, plain].forEach((id, i) => setCreatedAt(db, id, 1000 + i))
    setCreatedAt(db, newer, 2000)
    s.retentionSweep()
    // s1 is evicted as a session, but only its unprotected row goes; the
    // protected rows survive it, and a tombstone marks the archived rest.
    expect((await s.query('evictable')).length).toBe(0)
    expect((await s.query('authored decision')).length).toBe(1)
    expect((await s.query('nextfact')).length).toBe(1)
    expect((await s.query('exempt')).length).toBe(1)
    expect((await s.query('readonly')).length).toBe(1)
    expect(s.status().totalNodes).toBe(6) // 4 protected + s2 row + tombstone
    await s.close(); db.close()
  })

  it('AC2.11 hard-delete + VACUUM keeps the DB file bounded', async () => {
    const db = openDb('big.db')
    const s = await FlatStore.open({ database: db, ownsDatabase: false, maxSessions: 1, retentionInterval: 1_000_000 })
    for (let sess = 0; sess < 10; sess++) {
      for (let i = 0; i < 30; i++) {
        await s.insert(`bulk capture s${sess} entry ${i} ${'x'.repeat(200)}`, {
          metadata: { source: 'auto-capture', session_id: `sess${sess}` },
          createdAt: 1000 + sess * 100 + i,
        })
      }
    }
    const before = statSync(dbPath('big.db')).size
    s.retentionSweep()
    const after = statSync(dbPath('big.db')).size
    // 9 sessions archived whole; the newest survives with all 30 rows.
    expect(s.status().totalNodes).toBe(39) // 30 + 9 tombstones
    expect(after).toBeLessThan(before) // VACUUM reclaimed space
    await s.close(); db.close()
  })
})

describe('high-DF token pruning (query-side, 2026-07-29)', () => {
  // Build a corpus past DF_PRUNE_MIN_DOCS (256) where every row carries the
  // same stopwords and a few rows carry a rare marker.
  async function openBigStore() {
    const s = await open({ retentionInterval: 1_000_000, maxSessions: 100_000, maxAutoEntries: 1_000_000 })
    for (let i = 0; i < 300; i++) {
      const rare = i === 7 ? ' quixotebanner' : ''
      await s.insert(`the was what on next step working entry v${i.toString(36)}x${(i * 131 % 89).toString(36)}${rare}`, {
        metadata: { source: 'auto-capture', role: 'assistant', session_id: 's' + (i >> 6) },
        createdAt: 1000 + i,
      })
    }
    return s
  }

  it('a rare token stays findable when buried in stopwords', async () => {
    const s = await openBigStore()
    const hits = await s.query('what was the quixotebanner working on', { topK: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.content).toContain('quixotebanner')
    await s.close()
  })

  it('a pure-stopword query still matches (fallback, no silent empty)', async () => {
    const s = await openBigStore()
    const hits = await s.query('what was the next step', { topK: 5 })
    expect(hits.length).toBe(5)
    await s.close()
  })

  it('a query of stopwords plus an absent token still matches via fallback', async () => {
    // Every survivor of pruning would have df=0 ("zzznotincorpus") — the
    // pruner must fall back to the full list rather than return empty.
    const s = await openBigStore()
    const hits = await s.query('what was the zzznotincorpus next step', { topK: 5 })
    expect(hits.length).toBe(5)
    await s.close()
  })
})

// ── Reliance recording exclusions (fourth-pass review) ─────────────────
//
// The _relied_count bump has three refusals, each load-bearing:
// recordReliance:false is the read_only-policy server's "never mutates"
// hook; read_only ROWS honor the import contract's letter; and CURRENT
// resume pointers are the session-start ritual's mandated fetches —
// counting them would make the meter measure protocol frequency, not
// reliance. Plus: a foreign non-numeric count must degrade to 0, never
// poison the eviction comparator into engine-arbitrary order.
describe('reliance recording exclusions', () => {
  let dir: string
  let store: Awaited<ReturnType<typeof FlatStore.open>>

  const reliedCount = (nodeId: string): unknown => {
    const raw = new BetterSqlite3(join(dir, 'journal.db'), { readonly: true })
    try {
      const row = raw.prepare(
        "SELECT json_extract(metadata_json, '$._relied_count') AS c FROM nodes WHERE node_id = ?",
      ).get(nodeId) as { c: unknown }
      return row.c
    } finally {
      raw.close()
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-reliance-'))
    store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'journal.db'))),
      ownsDatabase: true,
    })
  })

  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an ordinary single-entry export bumps the counter', async () => {
    const { nodeId } = await store.insert('an ordinary entry the agent relied on')
    store.exportJson({ nodeId })
    store.exportJson({ nodeId })
    expect(reliedCount(nodeId)).toBe(2)
  })

  it('recordReliance: false records nothing (the read_only-policy hook)', async () => {
    const { nodeId } = await store.insert('fetched by a server that must never mutate')
    store.exportJson({ nodeId, recordReliance: false })
    expect(reliedCount(nodeId)).toBeNull()
  })

  it('a current resume pointer is ritual, not reliance', async () => {
    const pointer = await store.insert('RESUME POINTER: the active plan', {
      metadata: { next_session: true, status: 'active' },
    })
    store.exportJson({ nodeId: pointer.nodeId })
    expect(reliedCount(pointer.nodeId)).toBeNull()

    // Superseded, the flags gone, later exports count like any row's.
    const successor = await store.insert('the new plan', {
      metadata: { next_session: true }, supersedes: [pointer.nodeId],
    })
    void successor
    store.exportJson({ nodeId: pointer.nodeId })
    expect(reliedCount(pointer.nodeId)).toBe(1)
  })

  it('a stale-metadata update cannot roll the column back (release-diff review 2026-08-15)', async () => {
    // The demotion shrink and the archive stump restore both call
    // updateNode with metadata read earlier — bumps that landed in
    // between were erased from the column, and the sweep reads only the
    // column. relied_count is monotonic: MAX at update, MAX at bump.
    const { nodeId } = await store.insert('entry whose count must survive an update')
    store.exportJson({ nodeId })
    store.exportJson({ nodeId })
    store.exportJson({ nodeId })

    const raw = new BetterSqlite3(join(dir, 'journal.db'))
    const row = raw.prepare('SELECT * FROM nodes WHERE node_id = ?').get(nodeId) as Record<string, unknown>
    raw.close()
    expect(row['relied_count']).toBe(3)

    // An update carrying metadata from before the bumps (count 1).
    store.store.updateNode({
      nodeId,
      treeId: row['tree_id'] as number,
      parentId: null,
      depth: 0,
      isLeaf: true,
      content: 'entry whose count must survive an update',
      summary: '',
      createdAt: row['created_at'] as number,
      updatedAt: Date.now() / 1000,
      summaryStale: false,
      readOnly: false,
      decayExempt: false,
      utilityScore: 0.5,
      sourceLabel: null,
      metadata: { _relied_count: 1 },
    })

    const after = new BetterSqlite3(join(dir, 'journal.db'), { readonly: true })
    const col = after.prepare('SELECT relied_count FROM nodes WHERE node_id = ?').get(nodeId) as { relied_count: number }
    after.close()
    expect(col.relied_count).toBe(3)

    // And the next bump heals the lagging metadata copy upward from the
    // column instead of resuming from the stale value.
    store.exportJson({ nodeId })
    const healed = new BetterSqlite3(join(dir, 'journal.db'), { readonly: true })
    const final = healed.prepare(
      "SELECT relied_count, json_extract(metadata_json, '$._relied_count') AS m FROM nodes WHERE node_id = ?",
    ).get(nodeId) as { relied_count: number; m: number }
    healed.close()
    expect(final.relied_count).toBe(4)
    expect(final.m).toBe(4)
  })

  it('a read-only row is never written, even by reliance', async () => {
    const imported = await store.importJson(
      store.exportJson(),
      { label: 'reference', readOnly: true },
    )
    expect(imported.importedCount).toBeGreaterThanOrEqual(0)
    const { nodeId } = await store.insert('writable neighbor')
    const raw = new BetterSqlite3(join(dir, 'journal.db'))
    raw.prepare('UPDATE nodes SET read_only = 1 WHERE node_id = ?').run(nodeId)
    raw.close()
    store.exportJson({ nodeId })
    expect(reliedCount(nodeId)).toBeNull()
  })

  it('a foreign non-numeric count scores 0 instead of poisoning the eviction order', async () => {
    // Three sessions under a 2-session cap: the poisoned one (foreign
    // string count) must be treated as score 0 and evict first; the
    // genuinely relied-on session survives.
    const mk = async (session: string, base: number, extra: Record<string, unknown> = {}) => {
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        ids.push((await store.insert(`${session} entry ${i}`, {
          metadata: { source: 'auto-capture', role: 'tool', session_id: session, ...extra },
          createdAt: 1_700_000_000 + base + i,
        })).nodeId)
      }
      return ids
    }
    await store.close()
    store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'journal.db'))),
      ownsDatabase: true, maxSessions: 2, retentionInterval: 1_000_000,
    })
    const relied = await mk('relied', 0)
    await mk('poisoned', 100, { _relied_count: 'many' })
    await mk('newest', 200)
    store.exportJson({ nodeId: relied[0]! })

    store.retentionSweep()
    const raw = new BetterSqlite3(join(dir, 'journal.db'), { readonly: true })
    try {
      const bySession = (s: string): number => (raw.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.session_id') = ?",
      ).get(s) as { n: number }).n
      expect(bySession('poisoned'), 'the poisoned session must evict as score 0').toBe(0)
      expect(bySession('relied'), 'the relied-on session must survive').toBe(2)
      expect(bySession('newest')).toBe(2)
    } finally {
      raw.close()
    }
  })
})

describePosix('retention archives land private by mode (docs/security.md §3)', () => {
  it('the archive directory is 0700 and archived sessions are 0600 on create', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-archive-mode-'))
    try {
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'journal.db'))),
        ownsDatabase: true,
        maxSessions: 1,
        retentionInterval: 1_000_000, // manual sweeps only — this test drives the valve
      })
      try {
        await store.insert('old era: the archive mode pin rides a real eviction', {
          metadata: { source: 'auto-capture', role: 'tool', session_id: 'mode-old' },
          createdAt: 1,
        })
        await store.insert('new era: keeps the valve away from the present', {
          metadata: { source: 'auto-capture', role: 'tool', session_id: 'mode-new' },
          createdAt: 2,
        })
        store.retentionSweep()
        const archiveDir = join(dir, 'archive')
        expect(statSync(archiveDir).mode & 0o777).toBe(0o700)
        const files = readdirSync(archiveDir).filter((f) => f.endsWith('.json'))
        expect(files).toHaveLength(1)
        expect(statSync(join(archiveDir, files[0]!)).mode & 0o777).toBe(0o600)
      } finally {
        await store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// D164's two identity paths the charter scenarios do not reach on their
// own (mutation pass of the beta.1 handoff chunk, 2026-10-08): an entry
// present only as another lane's merge back-pointer, and an id this store
// holds with different content.
describe('D164 import identity: back-pointers and id conflicts', () => {
  it('an entry already carried into another lane by merge is present by its back-pointer', async () => {
    const db = openDb()
    const scout = await FlatStore.open({ database: db, namespace: 'scout', ownsDatabase: false })
    // A capture, not a curated note: the curated unique index would refuse
    // the twin on its own, and the back-pointer is what must decide here.
    const { nodeId } = await scout.insert('npm test: 12 pass, CSRF fails', {
      metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: 'cc-scout' },
    })
    const file = scout.exportJson()
    const project = await FlatStore.open({ database: db, namespace: 'project', ownsDatabase: false })
    expect(project.mergeFromNamespace('scout', { label: 'm' }).importedCount).toBe(1)
    scout.delete(nodeId) // the source row is gone; only the copy's pointer remains
    const r = await project.importJson(file, { handoff: { file: 'scout.json', importer: null } })
    expect(r).toMatchObject({ importedCount: 0, alreadyPresent: 1, idConflicts: 0 })
    await scout.close(); await project.close(); db.close()
  })

  it('an id held with different content is left alone and counted apart, never overwritten', async () => {
    const s = await open()
    const { nodeId } = await s.insert('the original entry under this id')
    const file = JSON.stringify({ nodes: [{ nodeId, content: 'a hand-edited entry reusing that id', metadata: null }] })
    const r = await s.importJson(file, { handoff: { file: 'edited.json', importer: null } })
    expect(r).toMatchObject({ importedCount: 0, alreadyPresent: 0, idConflicts: 1 })
    const node = (JSON.parse(s.exportJson({ nodeId })) as { nodes: Array<{ content: string }> }).nodes[0]!
    expect(node.content).toBe('the original entry under this id')
    await s.close()
  })
})

// The chunk-2 review fixes (2026-10-08, D221): the receiver's pointers,
// the curated index outside handoff lanes, the newest-session rule, and
// entries that are not entries.
describe('handoff import: review fixes', () => {
  const HANDOFF = { file: 'handoffs/a.json', importer: 'cc-b' }
  const fileOf = (nodes: unknown[]): string => JSON.stringify({ version: 1, exported_by: 'a@host-a', nodes })

  it("an imported chapter never becomes one of the receiver's resume pointers (F1)", async () => {
    const s = await open()
    const own = (await s.insert('plan: the receiver\'s own chapter', { metadata: { next_session: true, _cc_session_id: 'cc-b' } })).nodeId
    const ahead = Date.now() / 1000 + 3 * 3600
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      nodeId: `${'a'.repeat(30)}${String(i).padStart(2, '0')}`, content: `plan: sender chapter ${i}`,
      createdAt: ahead + i, metadata: { next_session: true, status: 'active', _cc_session_id: 'cc-a' },
    }))
    expect((await s.importJson(fileOf(nodes), { handoff: HANDOFF })).importedCount).toBe(25)
    const st = s.status()
    expect(st.resumePointers.map((p) => p.nodeId)).toEqual([own])
    expect(st.resumePointerTotal).toBe(1)
    // The pointer state survives as the file's claim.
    const raw = (JSON.parse(s.exportJson({ nodeId: nodes[0]!.nodeId })) as { nodes: Array<{ metadata: Record<string, unknown> }> }).nodes[0]!
    expect(raw.metadata['next_session']).toBeUndefined()
    expect((raw.metadata['_handoff_claims'] as Record<string, unknown>)['next_session']).toBe(true)
    await s.close()
  })

  it("a teammate's chapter that reads like the receiver's own still lands, by identity (F2)", async () => {
    const s = await open()
    const text = 'plan: wire the login form; next: write its tests'
    await s.insert(text, { metadata: { next_session: true, _cc_session_id: 'cc-b' } })
    const r = await s.importJson(fileOf([{ nodeId: 'b'.repeat(32), content: text, metadata: { next_session: true } }]), { handoff: HANDOFF })
    expect(r).toMatchObject({ importedCount: 1, alreadyPresent: 0 })
    expect(JSON.parse(s.exportJson({ nodeId: 'b'.repeat(32) })).nodes).toHaveLength(1)
    // The same file again is present by identity; an id-less twin by content.
    expect(await s.importJson(fileOf([{ nodeId: 'b'.repeat(32), content: text }]), { handoff: HANDOFF })).toMatchObject({ importedCount: 0, alreadyPresent: 1 })
    expect(await s.importJson(fileOf([{ content: text }]), { handoff: HANDOFF })).toMatchObject({ importedCount: 0, alreadyPresent: 1 })
    // And the receiver's own lane still refuses its own curated twin.
    expect((await s.insert(text, { metadata: { _cc_session_id: 'cc-b' } })).deduplicated).toBe(true)
    await s.close()
  })

  it('the curated unique index leaves handoff lanes out, in one definition (migration 025)', async () => {
    const s = await open()
    // Closed in a finally: an open handle pins the file on Windows and the
    // temp-dir cleanup fails EPERM.
    const ro = new BetterSqlite3(dbPath(), { readonly: true })
    try {
      const row = ro.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_curated_fp'").get() as { sql: string }
      expect(row.sql).toContain("substr(session_key, 1, 8) != 'handoff:'")
    } finally {
      ro.close()
    }
    await s.close()
  })

  it('a handoff lane is never the newest session, whatever its clock says (F4)', async () => {
    const db = openDb()
    const s = await FlatStore.open({ database: db, ownsDatabase: false, maxSessions: 1, retentionInterval: 1_000_000 })
    const mine = (await s.insert('my present capture', { metadata: { source: 'auto-capture', role: 'tool', session_id: 'cc-b' } })).nodeId
    const ahead = Date.now() / 1000 + 3 * 3600
    await s.importJson(fileOf([{ nodeId: 'c'.repeat(32), content: 'sender capture from the future', createdAt: ahead,
      metadata: { source: 'auto-capture', role: 'tool', session_id: 'cc-a' } }]), { handoff: HANDOFF, readOnly: false })
    s.retentionSweep()
    const ids = (JSON.parse(s.exportJson()) as { nodes: Array<{ nodeId: string }> }).nodes.map((n) => n.nodeId)
    expect(ids).toContain(mine)
    expect(ids).not.toContain('c'.repeat(32))
    await s.close(); db.close()
  })

  it('an entry that is not an object is counted, never a failure (F8)', async () => {
    const s = await open()
    const r = await s.importJson(fileOf([null, 7, ['x'], { nodeId: 'd'.repeat(32), content: 'a real entry' }]), { handoff: HANDOFF })
    expect(r).toMatchObject({ importedCount: 1, skippedMalformed: 3 })
    await s.close()
  })
})
