import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'

// G2 review regressions: the auto-dedup window anchors live in the store
// and must obey TWO clocks — last_seen is honest capture time (the
// window, JF-4), updated_at is wall time (the hygiene sweep). Mixing
// them silently broke dedup for drained backlogs; and the relied_count
// dual write must read one source so divergence heals instead of
// persisting.
describe('dedup anchors (G2)', () => {
  let dir: string
  let store: FlatStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-anchors-'))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    store = await FlatStore.open({ database: db, ownsDatabase: true })
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a drained backlog keeps its window: capture-time anchors survive the wall-clock sweep', async () => {
    const threeDaysAgo = Date.now() / 1000 - 3 * 86400
    const first = await store.insert('Tool: Bash replayed twice', {
      sourceLabel: 'auto-capture',
      metadata: { session_id: 'backlog' },
      createdAt: threeDaysAgo,
    })
    // The 5-minute hygiene sweep runs between the two backlog rows. The
    // anchor's last_seen is 3 days in the past (capture time), but it was
    // written moments ago — pruning on wall time must keep it.
    expect(store.store.pruneDedupAnchors()).toBe(0)

    const second = await store.insert('Tool: Bash replayed twice', {
      sourceLabel: 'auto-capture',
      metadata: { session_id: 'backlog' },
      createdAt: threeDaysAgo + 60,
    })
    expect(second.deduplicated).toBe(true)
    expect(second.nodeId).toBe(first.nodeId)
  })

  it('an anchor untouched for the full retention window is pruned', async () => {
    await store.insert('Tool: Bash long forgotten', {
      sourceLabel: 'auto-capture',
      metadata: { session_id: 'old' },
      createdAt: Date.now() / 1000,
    })
    // Age the anchor's WALL clock (not its capture clock) past retention.
    store.store.database.prepare('UPDATE dedup_anchors SET updated_at = ?').run(Date.now() / 1000 - 90000)
    expect(store.store.pruneDedupAnchors()).toBe(1)
  })

  it('the reliance bump heals a diverged column instead of preserving the gap', async () => {
    const { nodeId } = await store.insert('a decision someone keeps exporting')
    // Simulate a backfill-skipped row: metadata says 7, column says 0.
    store.store.database
      .prepare("UPDATE nodes SET metadata_json = json_set(COALESCE(metadata_json,'{}'), '$._relied_count', 7), relied_count = 0 WHERE node_id = ?")
      .run(nodeId)

    store.exportJson({ nodeId })

    const row = store.store.database
      .prepare("SELECT relied_count, json_extract(metadata_json, '$._relied_count') AS meta_count FROM nodes WHERE node_id = ?")
      .get(nodeId) as { relied_count: number; meta_count: number }
    expect(row.meta_count).toBe(8)
    expect(row.relied_count).toBe(8)
  })
})
