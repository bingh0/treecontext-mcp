/**
 * Round-3 adversarial review regression pins (ADVERSARIAL-REVIEW-2026-08-01-ROUND3.md,
 * Tier 1 + S7). Plain vitest, same convention as round2-regressions: each pin
 * belongs in its owning feature file when that suite's next wave lands —
 * S1/S2 → journal-storage (eviction/archive honesty), S3/S7 → journal-library
 * (import/merge atomicity).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { INDEX_CAP_USER } from '../../src/persistence/index-text.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tc-round3-'))
  dirs.push(d)
  return d
}
async function open(dir: string, opts: Partial<Parameters<typeof FlatStore.open>[0]> = {}, file = 'r.db'): Promise<FlatStore> {
  return FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(join(dir, file))),
    ownsDatabase: true,
    maxSessions: 1_000_000,
    maxAutoEntries: 1_000_000,
    maxStoreBytes: 1_000_000_000,
    retentionInterval: 1_000_000,
    ...opts,
  })
}
function archiveJson(dir: string, name: string): { nodes: Array<Record<string, unknown>> } {
  const f = readdirSync(join(dir, 'archive')).find((x) => x.startsWith(name))!
  return JSON.parse(readFileSync(join(dir, 'archive', f), 'utf8')) as { nodes: Array<Record<string, unknown>> }
}
const nowS = () => Date.now() / 1000

describe('round-3 tier-1 regressions', () => {
  it('S1: evicting zstd-compressed rows forgets their fingerprints — the session archive re-imports whole', async () => {
    const dir = tmp()
    const store = await open(dir, { maxSessions: 1 })
    // One row above the 512-byte codec floor (stored as a Buffer), one
    // below it (stored as TEXT). The old forget loop skipped Buffers, so
    // the stale fingerprint made re-import skip the big row as a
    // "duplicate" of a node that no longer exists.
    await store.insert(`compressed row marker ${'z'.repeat(1500)}`, {
      metadata: { source: 'auto-capture', role: 'tool', session_id: 'old-sess' },
      createdAt: nowS() - 7200,
    })
    await store.insert('plain old row under the floor', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 'old-sess' },
      createdAt: nowS() - 7100,
    })
    await store.insert('fresh session row', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 'new-sess' },
      createdAt: nowS(),
    })
    const swept = store.retentionSweep()
    expect(swept.evicted).toBe(2)
    const archive = archiveJson(dir, 'old-sess')
    expect(archive.nodes).toHaveLength(2)
    const restored = await store.importJson(JSON.stringify(archive))
    expect(restored.importedCount).toBe(2) // the advertised restore path, whole
    // OR-joined tokens also hit the other restored rows via 'row' — the
    // pin is on the compressed row's restoration, so select it exactly.
    const hits = (await store.query('compressed row marker')).filter((h) => h.content.startsWith('compressed row marker'))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content.length).toBeGreaterThan(1500) // full content, not a truncation
    await store.close()
  })

  it('S2: a non-string session_id archives the rows it deletes — never an empty archive under a tombstone', async () => {
    const dir = tmp()
    const store = await open(dir, { maxSessions: 1 })
    // session_id is caller-controlled metadata; a numeric id stringifies
    // in the JS grouping but the old archive SQL re-match compared the
    // raw JSON value — INTEGER 123 never equals TEXT '123', so the
    // archive was written EMPTY and the delete proceeded anyway.
    await store.insert('numeric session first entry about the relay probe', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 123 },
      createdAt: nowS() - 7200,
    })
    await store.insert('numeric session second entry about the relay probe', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 123 },
      createdAt: nowS() - 7100,
    })
    await store.insert('fresh session row', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 'new-sess' },
      createdAt: nowS(),
    })
    const swept = store.retentionSweep()
    expect(swept.evicted).toBe(2)
    const archive = archiveJson(dir, '123')
    expect(archive.nodes).toHaveLength(2) // the tombstone's claim must be true
    const restored = await store.importJson(JSON.stringify(archive))
    expect(restored.importedCount).toBe(2)
    expect(await store.query('relay probe')).toHaveLength(2)
    await store.close()
  })

  it('S3: a failed import rolls back the fingerprint maps too — the retry imports the good rows', async () => {
    const dir = tmp()
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 's3.db')))
    const a = await FlatStore.open({ database: db, namespace: 'ns-a', ownsDatabase: false })
    // Payload: one good fresh row, then a row the store refuses mid-loop,
    // which throws and rolls the transaction back. The old code left the
    // good row's fingerprint in the in-memory map — the retry then
    // "deduplicated" it against a row that was never committed and
    // imported nothing. (The fault was once an id colliding with an ns-a
    // row, which crashed the import because the id check was tree-scoped;
    // D164 made that collision an already-present entry, never a failure,
    // so the fault is now injected by trigger, as the stump variant does.)
    const good = {
      nodeId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      content: 'good imported row about the flux survey',
      createdAt: nowS(), updatedAt: nowS(), summary: '', metadata: null,
    }
    const raw = new BetterSqlite3(join(dir, 's3.db'))
    raw.exec(
      `CREATE TRIGGER poison_import BEFORE INSERT ON nodes ` +
      `WHEN new.content LIKE '%POISONROW%' BEGIN SELECT RAISE(ABORT, 'injected import fault'); END`,
    )
    raw.close()
    const bad = { nodeId: 'cccccccccccccccccccccccccccccccc', content: 'POISONROW refused row content', createdAt: nowS(), updatedAt: nowS(), summary: '', metadata: null }
    const b = await FlatStore.open({ database: db, namespace: 'ns-b', ownsDatabase: false })
    await expect(b.importJson(JSON.stringify({ nodes: [good, bad] }))).rejects.toThrow()
    expect(await b.query('flux survey')).toHaveLength(0) // DB rolled back
    const retry = await b.importJson(JSON.stringify({ nodes: [good] }))
    expect(retry.importedCount).toBe(1) // the maps rolled back with it
    expect(await b.query('flux survey')).toHaveLength(1)
    a.close(); b.close(); db.close()
  })

  it('S3 (stump variant): a rolled-back stump restore cannot swallow the next capture of the full content', async () => {
    const dir = tmp()
    const store = await open(dir, { maxStoreBytes: 1 })
    const full = `restoreRollback ${'q'.repeat(INDEX_CAP_USER + 500)} deepTailToken`
    const at = nowS()
    const { nodeId } = await store.insert(full, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: full.length },
      createdAt: at,
    })
    store.retentionSweep() // demotes to the stump, archives the full row
    expect((await store.query('deepTailToken'))).toHaveLength(0)
    const archive = archiveJson(dir, 'demoted')
    // Import: the stump restore succeeds mid-transaction, then a poison
    // row aborts the whole import. The old code kept the restored row's
    // full-content fingerprint pointing at the (still-existing) stump —
    // so the next real capture of that content deduplicated onto the
    // stump and was silently swallowed.
    const raw = new BetterSqlite3(join(dir, 'r.db'))
    raw.exec(
      `CREATE TRIGGER poison_import BEFORE INSERT ON nodes ` +
      `WHEN new.content LIKE '%POISONROW%' BEGIN SELECT RAISE(ABORT, 'injected import fault'); END`,
    )
    raw.close()
    const poison = { nodeId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', content: 'POISONROW small', createdAt: at, updatedAt: at, summary: '', metadata: null }
    await expect(store.importJson(JSON.stringify({ nodes: [...archive.nodes, poison] }))).rejects.toThrow()
    expect((await store.query('deepTailToken'))).toHaveLength(0) // still the stump — rolled back
    const recapture = await store.insert(full, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: full.length },
      createdAt: at + 10,
    })
    expect(recapture.deduplicated ?? false).toBe(false) // not swallowed onto the stump
    expect(recapture.nodeId).not.toBe(nodeId)
    await store.close()
  })

  it('S7: a failing merge commits nothing — retry after the fault merges the whole branch', async () => {
    const dir = tmp()
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 's7.db')))
    const scout = await FlatStore.open({ database: db, namespace: 'scout', ownsDatabase: false })
    await scout.insert('merge good row about the ledger audit')
    await scout.insert('POISONMERGE second row of the branch')
    const project = await FlatStore.open({ database: db, namespace: 'project', ownsDatabase: false })
    const raw = new BetterSqlite3(join(dir, 's7.db'))
    raw.exec(
      `CREATE TRIGGER poison_merge BEFORE INSERT ON nodes ` +
      `WHEN new.content LIKE '%POISONMERGE%' BEGIN SELECT RAISE(ABORT, 'injected merge fault'); END`,
    )
    expect(() => project.mergeFromNamespace('scout', { label: 'wave' })).toThrow()
    expect(await project.query('ledger audit')).toHaveLength(0) // nothing committed
    raw.exec('DROP TRIGGER poison_merge')
    raw.close()
    const retry = project.mergeFromNamespace('scout', { label: 'wave' })
    expect(retry.importedCount).toBe(2) // maps rolled back — the good row is not "already merged"
    expect(await project.query('ledger audit')).toHaveLength(1)
    scout.close(); project.close(); db.close()
  })
})
