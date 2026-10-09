/**
 * retention-demotion.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.
 * "the retention sweep runs" merges across all nine scenarios over
 * world state; the archive-recovery And merges across the two demotion
 * scenarios. The old createTeardown/ownsDatabase-false regime becomes
 * paired idempotent defers — store close, raw-db close, then unlink.)
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { FlatStore } from '../../src/flat-store.js'
import { INDEX_CAP_USER } from '../../src/persistence/index-text.js'

interface ExportedNode {
  nodeId: string
  content: string
  metadata: Record<string, unknown> | null
}
function nodesOf(store: FlatStore): ExportedNode[] {
  return (JSON.parse(store.exportJson()) as { nodes: ExportedNode[] }).nodes
}

/** Every content string in the demotion archives under `<dir>/archive`. */
function demotionArchiveContents(dir: string): string[] {
  const archDir = join(dir, 'archive')
  if (!existsSync(archDir)) return []
  return readdirSync(archDir)
    .filter((f) => f.startsWith('demoted'))
    .flatMap((f) =>
      (JSON.parse(readFileSync(join(archDir, f), 'utf8')) as { nodes: Array<{ content: string }> }).nodes.map(
        (n) => n.content,
      ),
    )
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  dir?: string
  store?: FlatStore
  db?: Database
  swept?: { evicted: number; demoted: number }
  nodeId?: string
  content?: string
  /** Staged by both demotion Givens for the merged archive-recovery And. */
  archiveJson?: string
  restored?: { importedCount: number }
  proseId?: string
  toolId?: string
  proseContent?: string
  protectedId?: string
  plainId?: string
  protectedContent?: string
  oldSessionId?: string
  survivorId?: string
}

export const retentionDemotionDefiner = (reg: Registry<World>): void => {
  function freshDir(w: World): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-demote-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  /** `database` is the one option this helper owns — it opens the file and
   *  defers both closes — so callers name only the tuning knobs. */
  async function openStore(
    w: World,
    name: string,
    opts: Omit<Parameters<typeof FlatStore.open>[0], 'database'>,
  ): Promise<FlatStore> {
    const dir = freshDir(w)
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    const store = await FlatStore.open({ database: db, ...opts })
    w.defer(() => store.close())
    w.defer(() => db.close())
    w.dir = dir
    return store
  }

  function setCreatedAt(db: Database, nodeId: string, ts: number): void {
    db.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(ts, nodeId)
  }

  reg.define(/^a legacy-shape auto-capture user node whose content exceeds the index cap, with a tiny store-byte budget$/, async (w) => {
    w.store = await openStore(w, 'a.db', {
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    // Legacy shape: no _index_len marker — the pre-expansion capture
    // path, whose index view was already capped at INDEX_CAP_USER. The
    // beyond-cap tail was never indexed, so it is unfindable from day one.
    const withinCapTerm = 'demotionWithinCapTerm'
    const beyondCapTerm = 'demotionBeyondCapTerm'
    w.content = `${withinCapTerm} ${'w'.repeat(INDEX_CAP_USER + 2000)} ${beyondCapTerm}`
    const res = await w.store.insert(w.content, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } })
    w.nodeId = res.nodeId
    expect((await w.store.query(beyondCapTerm)).length).toBe(0)
  })

  reg.define(/^a full-view auto-capture user node findable by a term beyond the demotion floor, with a tiny store-byte budget$/, async (w) => {
    w.store = await openStore(w, 'f.db', {
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    // Post-018 shape: _index_len stamped to the full length, the way
    // user-prompt-submit stages a capture — the whole message is indexed.
    const withinTerm = 'fullViewWithinTerm'
    const beyondTerm = 'fullViewBeyondFloorTerm'
    w.content = `${withinTerm} ${'w'.repeat(INDEX_CAP_USER + 500)} ${beyondTerm}`
    const res = await w.store.insert(w.content, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: w.content.length },
    })
    w.nodeId = res.nodeId
    expect((await w.store.query(beyondTerm)).map((h) => h.nodeId)).toContain(w.nodeId)
  })

  reg.define(/^a demoted full-view row whose tail lives only in the demotion archive$/, async (w) => {
    w.store = await openStore(w, 'restore.db', {
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    const beyondTerm = 'restoreBeyondFloorTerm'
    w.content = `restoreWithinTerm ${'w'.repeat(INDEX_CAP_USER + 500)} ${beyondTerm}`
    const res = await w.store.insert(w.content, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: w.content.length },
    })
    w.nodeId = res.nodeId
    w.store.retentionSweep()
    // Demoted for real: the tail term now misses, and its only copy is
    // the archive file this scenario is about to import.
    expect((await w.store.query(beyondTerm)).map((h) => h.nodeId)).not.toContain(w.nodeId)
    const archDir = join(w.dir!, 'archive')
    const file = readdirSync(archDir).find((f) => f.startsWith('demoted'))!
    w.archiveJson = readFileSync(join(archDir, file), 'utf8')
  })

  reg.define(/^an over-budget in-memory store with no archive destination$/, async (w) => {
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
      ownsDatabase: true,
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.store = store
    w.content = `refuseProbeTerm ${'x'.repeat(INDEX_CAP_USER + 2000)}`
    const res = await store.insert(w.content, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } })
    w.nodeId = res.nodeId
  })

  reg.define(/^an over-budget store whose only candidate has a zero-length display floor$/, async (w) => {
    w.store = await openStore(w, 'z.db', {
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    // `_preview_len: 0` lifts to the boundary column (0 is a valid
    // boundary), so the row's demotion floor is the empty string.
    w.content = `zeroStumpProbeTerm ${'x'.repeat(INDEX_CAP_USER + 2000)}`
    const res = await w.store.insert(w.content, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: w.content.length, _preview_len: 0 },
    })
    w.nodeId = res.nodeId
  })

  reg.define(/^an over-budget store whose only candidate stores smaller compressed than its raw stump$/, async (w) => {
    const stumpLen = 400 // under the codec's 512-byte floor: the stump stores raw
    const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), 's.db')))
    w.defer(() => db.close())
    const store = await FlatStore.open({
      database: db,
      maxStoreBytes: 1,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.db = db
    w.store = store
    const head = 'compact entry prose '.repeat(20).slice(0, stumpLen)
    w.content = `${head} savingProbeTerm ${'journal entry '.repeat(10_000)}`
    const res = await store.insert(w.content, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: w.content.length, _preview_len: stumpLen },
    })
    w.nodeId = res.nodeId
    // Discriminating control: the fixture only exercises the guard if
    // the codec really stored the full row in fewer bytes than the raw
    // sub-floor stump demotion would write in its place.
    const row = db.prepare('SELECT LENGTH(CAST(content AS BLOB)) AS byte_len FROM nodes WHERE node_id = ?').get(w.nodeId) as { byte_len: number }
    expect(row.byte_len, 'fixture needs the real codec: the compressed row must undercut its raw stump').toBeLessThan(stumpLen)
  })

  reg.define(/^an over-budget store where demoting its newer tool bulk alone satisfies the budget, alongside older prose$/, async (w) => {
    const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), 'o.db')))
    w.defer(() => db.close())
    w.db = db
    // Two passes: write the rows first, measure their STORED sizes (the
    // codec compresses ≥512-byte content, so char counts lie), then
    // reopen with a budget only tool-shrinkage can satisfy.
    const seed = await FlatStore.open({
      database: db,
      ownsDatabase: false,
      maxStoreBytes: 1_000_000_000,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    // Incompressible bodies: the codec zstd-compresses ≥512-byte content,
    // and repeated characters shrink to ~30 stored bytes — too small to
    // discriminate the demotion order. Random base64 keeps stored size
    // near char count.
    const noise = (n: number) => randomBytes(n).toString('base64').slice(0, n)
    w.proseContent = `oldProseTerm ${noise(INDEX_CAP_USER + 1000)}`
    const toolContent = `toolBulkTerm ${noise(6000)}`
    w.proseId = (
      await seed.insert(w.proseContent, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } })
    ).nodeId
    w.toolId = (
      await seed.insert(toolContent, {
        metadata: { source: 'auto-capture', role: 'tool', session_id: 's2', _index_len: 12 },
      })
    ).nodeId
    setCreatedAt(db, w.proseId, 1000)
    setCreatedAt(db, w.toolId, 2000)
    await seed.close()
    const stored = db
      .prepare('SELECT node_id, LENGTH(content) AS n FROM nodes')
      .all() as Array<{ node_id: string; n: number }>
    const proseBytes = stored.find((r) => r.node_id === w.proseId)!.n
    const toolBytes = stored.find((r) => r.node_id === w.toolId)!.n
    // Over budget by less than the tool row's saving: the sweep must
    // stop after shrinking the (newer) tool row, leaving prose whole.
    // The old oldest-first order would have demoted prose instead.
    expect(toolBytes).toBeGreaterThan(1000)
    const store = await FlatStore.open({
      database: db,
      ownsDatabase: false,
      maxStoreBytes: proseBytes + toolBytes - Math.floor((toolBytes - 12) / 2),
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.store = store
  })

  reg.define(
    /^an oldest protected authored node and a newer non-protected auto-capture node, both oversized, with a tiny store-byte budget$/,
    async (w) => {
      const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), 'b.db')))
      w.defer(() => db.close())
      const store = await FlatStore.open({
        database: db,
        ownsDatabase: false,
        maxStoreBytes: 1,
        maxSessions: 1_000_000,
        maxAutoEntries: 1_000_000,
        retentionInterval: 1_000_000,
      })
      w.defer(() => store.close())
      w.db = db
      w.store = store
      // Incompressible: a repeated-char body compresses to ~30 stored
      // bytes, which the valve now correctly treats as zero-saving and
      // skips (round-2 R4).
      const noise2 = (n: number) => randomBytes(n).toString('base64').slice(0, n)
      w.protectedContent = `protectedTerm ${noise2(INDEX_CAP_USER + 2000)}`
      const oversizedAuto = `nonProtectedTerm ${noise2(INDEX_CAP_USER + 2000)}`
      // authored (source !== 'auto-capture') is protected regardless of age
      const pRes = await store.insert(w.protectedContent, { metadata: { source: 'user', role: 'user' } })
      w.protectedId = pRes.nodeId
      const nRes = await store.insert(oversizedAuto, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } })
      w.plainId = nRes.nodeId
      setCreatedAt(db, w.protectedId, 1000)
      setCreatedAt(db, w.plainId, 2000)
    },
  )

  reg.define(/^an entry-count-capped store with old and new auto-capture sessions and a tiny store-byte budget$/, async (w) => {
    const db = wrapBetterSqlite(new BetterSqlite3(join(freshDir(w), 'c.db')))
    w.defer(() => db.close())
    const store = await FlatStore.open({
      database: db,
      ownsDatabase: false,
      maxSessions: 1,
      maxStoreBytes: 1,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.db = db
    w.store = store
    const oldRes = await store.insert('oldSessionMarker plain short note', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-old' },
    })
    w.oldSessionId = oldRes.nodeId
    const survivorContent = `survivorTerm ${randomBytes(INDEX_CAP_USER + 2000).toString('base64').slice(0, INDEX_CAP_USER + 2000)}`
    const newRes = await store.insert(survivorContent, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-new' },
    })
    w.survivorId = newRes.nodeId
    setCreatedAt(db, w.oldSessionId, 1000)
    setCreatedAt(db, w.survivorId, 2000)
  })

  // Merged: every scenario in this feature sweeps here; the result is
  // captured for the scenarios whose Thens read it.
  reg.define(/^the retention sweep runs$/, (w) => {
    w.swept = w.store!.retentionSweep()
  })

  reg.define(/^the archive file is imported back into the store$/, async (w) => {
    w.restored = await w.store!.importJson(w.archiveJson!)
  })

  reg.define(/^the node's content now equals its index text and is flagged demoted$/, (w) => {
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!
    expect(node.metadata?.['_demoted']).toBe(true)
    expect(node.content.length).toBeLessThanOrEqual(INDEX_CAP_USER)
    expect(node.content.startsWith('demotionWithinCapTerm')).toBe(true)
  })

  reg.define(/^a query for a term within the index cap still finds the same node$/, async (w) => {
    const hits = await w.store!.query('demotionWithinCapTerm')
    expect(hits.map((h) => h.nodeId)).toContain(w.nodeId)
  })

  reg.define(/^a query for a term beyond the index cap misses, exactly as it did before demotion$/, async (w) => {
    expect((await w.store!.query('demotionBeyondCapTerm')).length).toBe(0)
  })

  reg.define(/^a query for the beyond-floor term no longer finds the node$/, async (w) => {
    expect((await w.store!.query('fullViewBeyondFloorTerm')).map((h) => h.nodeId)).not.toContain(w.nodeId)
  })

  reg.define(/^a hit on the demoted node carries a marker naming the pre-demotion length and archive path$/, async (w) => {
    const hit = (await w.store!.query('fullViewWithinTerm')).find((h) => h.nodeId === w.nodeId)!
    expect(hit.content).toContain(`…[demoted; full content ${w.content!.length} chars archived — path in _archive_path]`)
    expect(hit.metadata?.['_full_len']).toBe(w.content!.length)
    expect(typeof hit.metadata?.['_archive_path']).toBe('string')
  })

  // Merged: both demotion scenarios prove archive recovery identically;
  // executes once per scenario.
  reg.define(/^the full pre-demotion content is recoverable from the demotion archive$/, (w) => {
    expect(demotionArchiveContents(w.dir!)).toContain(w.content)
  })

  reg.define(/^the row holds its full pre-demotion content and the beyond-floor term finds it again$/, async (w) => {
    expect(w.restored!.importedCount).toBe(1)
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!
    expect(node.content).toBe(w.content) // byte for byte
    expect(node.metadata?.['_demoted']).toBeUndefined() // the archive carries pre-demotion metadata
    expect((await w.store!.query('restoreBeyondFloorTerm')).map((h) => h.nodeId)).toContain(w.nodeId)
  })

  reg.define(/^a second import of the same archive restores nothing further$/, async (w) => {
    expect((await w.store!.importJson(w.archiveJson!)).importedCount).toBe(0)
    expect(nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!.content).toBe(w.content)
  })

  reg.define(/^no row is demoted and every row's content is intact$/, (w) => {
    expect(w.swept!.demoted).toBe(0)
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!
    expect(node.content).toBe(w.content)
    expect(node.metadata?.['_demoted']).toBeFalsy()
  })

  reg.define(/^the row keeps its full content and stays findable$/, async (w) => {
    expect(w.swept!.demoted).toBe(0)
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!
    expect(node.content).toBe(w.content)
    expect(node.metadata?.['_demoted']).toBeFalsy()
    expect((await w.store!.query('zeroStumpProbeTerm')).map((h) => h.nodeId)).toContain(w.nodeId)
  })

  reg.define(/^the row is not demoted and its stored form is unchanged$/, (w) => {
    expect(w.swept!.demoted).toBe(0)
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.nodeId)!
    expect(node.content).toBe(w.content)
    expect(node.metadata?.['_demoted']).toBeFalsy()
    // still the compressed full form
    const stumpLen = 400
    const after = w.db!.prepare('SELECT LENGTH(CAST(content AS BLOB)) AS byte_len FROM nodes WHERE node_id = ?').get(w.nodeId) as { byte_len: number }
    expect(after.byte_len).toBeLessThan(stumpLen)
  })

  reg.define(/^the tool row is demoted and the older prose row is untouched$/, async (w) => {
    const nodes = nodesOf(w.store!)
    const tool = nodes.find((n) => n.nodeId === w.toolId)!
    const prose = nodes.find((n) => n.nodeId === w.proseId)!
    expect(tool.metadata?.['_demoted']).toBe(true)
    expect(tool.content).toBe('toolBulkTerm')
    expect(prose.metadata?.['_demoted']).toBeFalsy()
    expect(prose.content).toBe(w.proseContent)
  })

  reg.define(/^the protected node's content is untouched$/, (w) => {
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.protectedId)!
    expect(node.content).toBe(w.protectedContent)
    expect(node.metadata?.['_demoted']).toBeFalsy()
  })

  reg.define(/^the non-protected node's content is demoted$/, (w) => {
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.plainId)!
    expect(node.metadata?.['_demoted']).toBe(true)
    expect(node.content.length).toBeLessThanOrEqual(INDEX_CAP_USER)
  })

  reg.define(/^the oldest session is hard-deleted as usual$/, async (w) => {
    const ids = nodesOf(w.store!).map((n) => n.nodeId)
    expect(ids).not.toContain(w.oldSessionId)
    expect((await w.store!.query('oldSessionMarker')).length).toBe(0)
  })

  reg.define(/^the surviving oversized node is demoted in the same sweep$/, (w) => {
    const node = nodesOf(w.store!).find((n) => n.nodeId === w.survivorId)!
    expect(node.metadata?.['_demoted']).toBe(true)
    expect(node.content.length).toBeLessThanOrEqual(INDEX_CAP_USER)
  })
}
