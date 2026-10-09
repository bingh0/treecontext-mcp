/**
 * purgeProcessedStaging — the one live staging-expiry path (2026-07-29
 * audit found it shipped with zero coverage). Contract: processed rows
 * whose CAPTURE time is older than the retention window are deleted;
 * unprocessed rows and recent processed rows are untouched. The cutoff
 * reads `timestamp` (event age) deliberately, so a rescued month-old
 * backlog purges on the first sweep after it drains rather than
 * lingering another 24h.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-purge-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

function openDb(): Database { return wrapBetterSqlite(new BetterSqlite3(join(tmpDir, 'purge.db'))) }

function stageRow(p: Persistence, opts: { timestamp: number; processed: boolean }): number {
  const id = p.insertStaging({ sessionId: 's1', role: 'user', content: 'purge fixture', timestamp: opts.timestamp })
  if (opts.processed) {
    // Through the LIVE path (claim then mark-owned), not raw SQL: a
    // bare processed=1 UPDATE minted rows no production write can
    // produce, silently diverging from the G3 claim-clearing pin
    // (pass-3 review 2026-08-15).
    p.claimStagingBatch('purge-fixture', 1_000, 120)
    p.markStagingProcessedOwned([id], 'purge-fixture')
    p.releaseStagingClaims('purge-fixture')
  }
  return id
}

describe('Persistence.purgeProcessedStaging', () => {
  it('deletes processed rows older than the window, keeps everything else', () => {
    const db = openDb()
    const p = Persistence.openLexical(db)
    const now = Date.now() / 1000

    const oldProcessed = stageRow(p, { timestamp: now - 100_000, processed: true })
    const oldUnprocessed = stageRow(p, { timestamp: now - 100_000, processed: false })
    const freshProcessed = stageRow(p, { timestamp: now - 60, processed: true })

    const purged = p.purgeProcessedStaging() // default window: 86400s
    expect(purged).toBe(1)

    const surviving = (db.prepare('SELECT id FROM staging ORDER BY id').all() as Array<{ id: number }>)
      .map((r) => r.id)
    expect(surviving).toEqual([oldUnprocessed, freshProcessed])
    expect(surviving).not.toContain(oldProcessed)
    p.close()
  })

  it('honors a custom max age', () => {
    const db = openDb()
    const p = Persistence.openLexical(db)
    const now = Date.now() / 1000
    stageRow(p, { timestamp: now - 500, processed: true })

    expect(p.purgeProcessedStaging(1_000)).toBe(0) // still inside the window
    expect(p.purgeProcessedStaging(100)).toBe(1)   // window shrunk past it
    p.close()
  })

  it('is wired into the ingestion loop sweep', async () => {
    const db = openDb()
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    const now = Date.now() / 1000
    stageRow(store.store, { timestamp: now - 100_000, processed: true })
    stageRow(store.store, { timestamp: now - 100_000, processed: false })

    const loop = new IngestionLoop(store)
    const purged = await loop.runSweep()
    expect(purged).toBe(1)
    // The unprocessed row is the drain's business, never the sweep's.
    expect(store.store.countUnprocessedStaging()).toBe(1)
    await store.close()
  })
})
