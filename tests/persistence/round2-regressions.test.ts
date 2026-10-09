/**
 * Round-2 adversarial review regression pins (ADVERSARIAL-REVIEW-2026-07-31-ROUND2.md,
 * Tier 1). Plain vitest for now — each belongs in its owning feature file when
 * that suite's next wave lands: R1/R4 → retention-demotion, R2 → journal-storage,
 * R5 → flat-store-dedup. (R3's charter scenario bound 2026-08-01 in
 * journal-namespaces; the pin here stays as the engine-level check.)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { INDEX_CAP_USER } from '../../src/persistence/index-text.js'

const noise = (n: number) => randomBytes(n).toString('base64').slice(0, n)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tc-round2-'))
  dirs.push(d)
  return d
}
async function open(dir: string, maxStoreBytes: number, file = 'r.db'): Promise<FlatStore> {
  return FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(join(dir, file))),
    ownsDatabase: true,
    maxStoreBytes,
    maxSessions: 1_000_000,
    maxAutoEntries: 1_000_000,
    retentionInterval: 1_000_000,
  })
}
/** TreeStatus.retention is optional only for legacy payloads; the lexical
 *  store always reports it, so absence must fail the pin, not slip past it. */
function gauge(store: FlatStore): { storeBytes: number; budgetBytes: number; overBudget: boolean } {
  const r = store.status().retention
  expect(r, 'the lexical store must report a retention gauge').toBeDefined()
  return r!
}
function archiveJson(dir: string): { nodes: Array<{ nodeId: string; content: string }> } {
  const f = readdirSync(join(dir, 'archive')).find((x) => x.startsWith('demoted'))!
  return JSON.parse(readFileSync(join(dir, 'archive', f), 'utf8')) as { nodes: Array<{ nodeId: string; content: string }> }
}

describe('round-2 tier-1 regressions', () => {
  it('R1: the valve gauges bytes, not characters — multi-byte stores still demote', async () => {
    const dir = tmp()
    // 60 CJK rows under the codec's 512-byte TEXT floor: 170 chars ≈ 510
    // utf8 bytes each. A character gauge totals ~10.2K while the byte
    // gauge (status()'s) totals ~30.6K — under the old LENGTH(content)
    // the valve saw the store as under a 15K budget and never fired.
    const store = await open(dir, 15_000)
    const cjk = () => Array.from({ length: 170 }, () => String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x2000))).join('')
    for (let i = 0; i < 60; i++) {
      await store.insert(cjk(), { metadata: { source: 'auto-capture', role: 'tool', session_id: `s${i}` } })
    }
    const big = `bulkyProbeTerm ${noise(3000)}`
    await store.insert(big, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-big', _index_len: big.length },
    })
    const swept = store.retentionSweep()
    expect(swept.demoted).toBeGreaterThan(0)
    await store.close()
  })

  it('R4: savings are estimated against encoded size — a sliver overage no longer demotes the whole compressible corpus', async () => {
    const dir = tmp()
    // Each row: a compressible 2000-char head (the future stump, ~20
    // stored bytes) and a ~42k patterned tail that zstd still needs real
    // bytes for — so every demotion genuinely reclaims a few dozen bytes.
    // The old estimate was max(0, stored_bytes − utf8(stump)): for these
    // rows that clamps to zero, so the planner decremented nothing and
    // kept going until the ENTIRE corpus was narrowed to the floor over a
    // 40-byte overage. The fix prices victims at stored-minus-encoded-
    // stump, so a couple of demotions cover the overage and the rest of
    // the corpus keeps its full searchable view.
    const seed = await open(dir, 10_000_000, 'r4.db')
    const body = (i: number) => `${'a'.repeat(2000)} tailTerm${i} ${'journal entry '.repeat(3000)}`
    for (let i = 0; i < 10; i++) {
      // Post-018 full-prose shape: indexed in full (_index_len), displayed
      // and demotable at the 2000-char cut (_preview_len).
      await seed.insert(body(i), {
        metadata: {
          source: 'auto-capture', role: 'user', session_id: `s${i}`,
          _index_len: body(i).length, _preview_len: 2000,
        },
      })
    }
    const storedBytes = gauge(seed).storeBytes
    await seed.close()
    // Reopen 40 bytes over budget (computed, because zstd sets the size).
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'r4.db'))),
      ownsDatabase: true,
      maxStoreBytes: storedBytes - 40,
      maxSessions: 1_000_000,
      maxAutoEntries: 1_000_000,
      retentionInterval: 1_000_000,
    })
    expect(gauge(store).overBudget).toBe(true) // the valve has cause to fire
    const swept = store.retentionSweep()
    expect(swept.demoted).toBeGreaterThan(0)
    expect(swept.demoted).toBeLessThan(10) // the corpus survives the sliver
    expect(gauge(store).overBudget).toBe(false) // and the accounting was real
    // Spared rows keep their beyond-the-stump findability.
    let spared = 0
    for (let i = 0; i < 10; i++) {
      spared += (await store.query(`tailTerm${i}`)).length
    }
    expect(spared).toBe(10 - swept.demoted)
    await store.close()
  })

  it('R2: importing a demotion archive restores the stump to the full row (replace-when-stump)', async () => {
    const dir = tmp()
    const store = await open(dir, 1)
    const content = `restoreProbe ${noise(INDEX_CAP_USER + 500)} tailOnlyRestoreTerm`
    const { nodeId } = await store.insert(content, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: content.length },
    })
    store.retentionSweep()
    expect((await store.query('tailOnlyRestoreTerm')).length).toBe(0) // narrowed to the floor
    const archive = archiveJson(dir)
    const restored = await store.importJson(JSON.stringify(archive))
    expect(restored.importedCount).toBe(1)
    const node = (JSON.parse(store.exportJson({ nodeId })) as { nodes: Array<{ content: string; metadata: Record<string, unknown> }> }).nodes[0]!
    expect(node.content).toBe(content) // full row back, byte for byte
    expect(node.metadata['_demoted']).toBeUndefined() // archive carries pre-demotion metadata
    expect((await store.query('tailOnlyRestoreTerm')).map((h) => h.nodeId)).toContain(nodeId) // findability restored
    // Idempotent: a second import of the same archive skips the now-full row.
    expect((await store.importJson(JSON.stringify(archive))).importedCount).toBe(0)
    await store.close()
  })

  it('R3: mergeFromNamespace with nodeId merges exactly that entry, label stamped', async () => {
    const dir = tmp()
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'm.db')))
    const branch = await FlatStore.open({ database: db, ownsDatabase: false, namespace: 'branch', retentionInterval: 1_000_000 })
    const ids: string[] = []
    for (const c of ['branch finding one', 'branch finding two', 'branch finding three']) {
      ids.push((await branch.insert(c)).nodeId)
    }
    await branch.close()
    const trunk = await FlatStore.open({ database: db, ownsDatabase: true, retentionInterval: 1_000_000 })
    const res = trunk.mergeFromNamespace('branch', { label: 'one-entry', nodeId: ids[1]! })
    expect(res.importedCount).toBe(1)
    const nodes = (JSON.parse(trunk.exportJson()) as { nodes: Array<{ content: string; metadata: Record<string, unknown> | null }> }).nodes
    const merged = nodes.find((n) => n.content === 'branch finding two')!
    expect(merged).toBeTruthy()
    expect(nodes.some((n) => n.content === 'branch finding one')).toBe(false)
    expect(merged.metadata?.['_merge_label']).toBe('one-entry')
    expect(merged.metadata?.['_namespace']).toBe('branch')
    expect(() => trunk.mergeFromNamespace('branch', { label: 'x', nodeId: 'nope' })).toThrow(/not found/)
    await trunk.close()
  })

  it('R5: a foreign session interleaving identical content cannot defeat double-fire dedup', async () => {
    const dir = tmp()
    const store = await open(dir, 64 * 1024 * 1024)
    const content = 'proceed'
    const t0 = 1_700_000_000
    const first = await store.insert(content, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' }, createdAt: t0 })
    await store.insert(content, { metadata: { source: 'auto-capture', role: 'user', session_id: 's2' }, createdAt: t0 + 5 })
    const refire = await store.insert(content, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' }, createdAt: t0 + 20 })
    expect(refire.deduplicated).toBe(true)
    expect(refire.nodeId).toBe(first.nodeId)
    expect((JSON.parse(store.exportJson()) as { nodes: unknown[] }).nodes.length).toBe(2)
    await store.close()
  })
})
