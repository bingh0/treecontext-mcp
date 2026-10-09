/**
 * ingestion-fidelity.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Honest timestamps, drain-all backlog with tombstones, poison
 * dead-letter. All scenarios run in-process against tmpdir FlatStores;
 * stores close via scenario defers (the old binding closed inside the
 * final step of each scenario — same point in the lifecycle, Windows
 * open-handle note included).
 *
 * "The valve trips" serves three scenarios: two drain to quiescence,
 * but the tombstone-refusal scenario must face the drop decision on a
 * single small-batch tick while its refusal stands — its Given sets
 * valveSingleTick and the merged When honors it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop, type IngestibleStore } from '../../src/server/ingestion.js'
import type { InsertOptions, InsertResult } from '../../src/core/types.js'

const T0 = 1_700_000_000

interface World {
  defer: (fn: () => void | Promise<void>) => void
  store?: FlatStore
  wrapped?: IngestibleStore
  loop?: IngestionLoop
  hit?: { createdAt: number; content: string; metadata: Record<string, unknown> | null }
  tombstoneId?: string
  valveSingleTick?: boolean
}

export const ingestionFidelityDefiner = (reg: Registry<World>): void => {
  async function freshStore(w: World, opts: Partial<Parameters<typeof FlatStore.open>[0]> = {}): Promise<FlatStore> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-ingest-fid-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'flat.db')))
    const store = await FlatStore.open({ database: db, ownsDatabase: true, ...opts })
    // Close here, not in teardown steps: Windows refuses to remove a dir
    // whose db handle is still open (full-matrix run 2026-08-15).
    w.defer(() => store.close())
    return store
  }

  function stage(store: FlatStore, content: string, session: string, timestamp: number, role: 'user' | 'assistant' = 'user'): void {
    store.store.insertStaging({ sessionId: session, role, content, timestamp, priority: 1 })
  }

  async function drain(store: IngestibleStore, loop: IngestionLoop, maxTicks = 200): Promise<number> {
    let total = 0
    for (let i = 0; i < maxTicks; i++) {
      const n = await loop.ingestBatch()
      total += n
      if (store.store.countUnprocessedStaging() === 0) break
    }
    return total
  }

  /** Wrap a FlatStore so inserts of poison content fail deterministically. */
  function poisonWrapper(store: FlatStore): IngestibleStore {
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (content: string, opts?: InsertOptions): Promise<InsertResult> => {
            if (content.startsWith('POISON')) throw new Error('deterministic poison failure')
            return target.insert(content, opts)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as unknown as IngestibleStore
  }

  reg.define(/^staged rows captured hours before the server started$/, async (w) => {
    w.store = await freshStore(w)
    stage(w.store, 'old captured directive about flangewhistle', 'sess-old', T0)
  })

  reg.define(/^the ingestion loop drains them$/, async (w) => {
    const loop = new IngestionLoop(w.store!, { batchSize: 10 })
    await loop.ingestBatch()
    const hits = await w.store!.query('flangewhistle', { topK: 3 })
    expect(hits.length).toBe(1)
    w.hit = hits[0]!
  })

  reg.define(/^each node's created_at and metadata created_at equal the hook's capture timestamp$/, (w) => {
    expect(w.hit!.createdAt).toBe(T0)
    expect(w.hit!.metadata!['created_at']).toBe(T0)
  })

  reg.define(/^metadata ingested_at records the drain time$/, (w) => {
    const ingestedAt = w.hit!.metadata!['ingested_at'] as number
    expect(Math.abs(ingestedAt - Date.now() / 1000)).toBeLessThan(60)
  })

  reg.define(/^a multi-hour staging backlog from one session$/, async (w) => {
    w.store = await freshStore(w)
    // Staged in capture order across three hours.
    stage(w.store, 'chronology probe step one', 'sess-c', T0)
    stage(w.store, 'chronology probe step two', 'sess-c', T0 + 3600)
    stage(w.store, 'chronology probe step three', 'sess-c', T0 + 7200)
  })

  reg.define(/^it is drained in batches$/, async (w) => {
    const loop = new IngestionLoop(w.store!, { batchSize: 2 })
    await drain(w.store!, loop)
  })

  reg.define(/^chronological queries and conversation windows order the entries by capture time$/, async (w) => {
    const chrono = await w.store!.query('chronology probe', { topK: 5, sortBy: 'chronological' })
    expect(chrono.map((r) => r.createdAt)).toEqual([T0, T0 + 3600, T0 + 7200])
    const hits = await w.store!.query('chronology probe step two', { topK: 1, conversationWindow: 1 })
    const win = hits[0]!.window!
    expect(win.before[0]?.content).toContain('step one')
    expect(win.after[0]?.content).toContain('step three')
  })

  reg.define(/^more than a thousand unprocessed staging rows across several sessions$/, async (w) => {
    w.store = await freshStore(w, { retentionInterval: 1_000_000 })
    for (let i = 0; i < 1200; i++) {
      stage(w.store, `backlog row ${i} distinct payload`, `sess-${i % 5}`, T0 + i)
    }
  })

  reg.define(/^the ingestion loop runs to quiescence$/, async (w) => {
    const loop = new IngestionLoop(w.store!, { batchSize: 100 })
    await drain(w.store!, loop, 500)
  })

  reg.define(/^every row is ingested or dead-lettered and none is dropped for count reasons$/, async (w) => {
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
    expect(w.store!.status().totalNodes).toBe(1200)
  })

  reg.define(/^unprocessed staging exceeding the byte safety valve across many sessions$/, async (w) => {
    w.store = await freshStore(w)
    // Three sessions, ~3KB each; valve at 5KB forces dropping the oldest.
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 3; i++) {
        stage(w.store, `sessiontoken${s} row ${i} ` + 'v'.repeat(1000), `sess-${s}`, T0 + s * 1000 + i)
      }
    }
    w.loop = new IngestionLoop(w.store, { batchSize: 100, stagingMaxBytes: 5000 })
  })

  // Merged over world state: the refusal scenario's Given below sets
  // valveSingleTick — it must face the drop decision on one small-batch
  // tick while the refusal stands; the others drain to quiescence.
  reg.define(/^the valve trips$/, async (w) => {
    if (w.valveSingleTick) {
      await w.loop!.ingestBatch()
      return
    }
    await drain(w.store!, w.loop!)
  })

  reg.define(/^only the oldest whole sessions are dropped, never part of one$/, async (w) => {
    // EVERY session is checked, including the budget-marginal middle one
    // (round-2 R11): a valve that dropped a FRAGMENT of sess-1 — the exact
    // "never part of one" violation — used to pass here unexamined.
    const gapSessions = new Set(
      (await w.store!.query('capture gap', { topK: 10, metadataFilter: { event: 'capture_gap' } })).map(
        (g) => g.metadata?.['session_id'] as string,
      ),
    )
    for (const s of [0, 1, 2]) {
      const hits = await w.store!.query(`sessiontoken${s}`, { topK: 10 })
      const whole = hits.length === 3
      const absent = hits.length === 0
      expect(whole || absent, `sess-${s} was fragmented: ${hits.length} of 3 rows survived`).toBe(true)
      // Whichever fate it got must be on the record: survivors have no
      // gap node, dropped sessions have exactly one.
      expect(gapSessions.has(`sess-${s}`), `sess-${s} dropped without a capture-gap node`).toBe(absent)
    }
    // The pinned outcome at this budget: the newest survives, the oldest goes.
    expect((await w.store!.query('sessiontoken2', { topK: 10 })).length).toBe(3)
    expect((await w.store!.query('sessiontoken0', { topK: 10 })).length).toBe(0)
  })

  reg.define(/^each dropped session yields one capture-gap node naming its session, row count and time span$/, async (w) => {
    const gaps = await w.store!.query('capture gap', { topK: 10, metadataFilter: { event: 'capture_gap' } })
    expect(gaps.length).toBeGreaterThanOrEqual(1)
    const gap0 = gaps.find((g) => g.metadata?.['session_id'] === 'sess-0')!
    expect(gap0).toBeDefined()
    expect(gap0.metadata!['dropped_count']).toBe(3)
    expect(gap0.metadata!['span_start']).toBe(T0)
    expect(gap0.metadata!['span_end']).toBe(T0 + 2)
  })

  reg.define(/^a single live session whose staged bytes exceed the byte valve$/, async (w) => {
    w.store = await freshStore(w)
    for (let i = 0; i < 3; i++) {
      stage(w.store, `livetoken row ${i} ` + 'v'.repeat(3000), 'sess-live', T0 + i)
    }
    w.loop = new IngestionLoop(w.store, { batchSize: 100, stagingMaxBytes: 5000 })
  })

  reg.define(/^nothing is dropped and every capture drains into the journal$/, async (w) => {
    const hits = await w.store!.query('livetoken', { topK: 10 })
    expect(hits).toHaveLength(3)
    const gaps = await w.store!.query('capture gap', { topK: 10, metadataFilter: { event: 'capture_gap' } })
    expect(gaps).toHaveLength(0)
  })

  reg.define(/^sessions exceeding the valve and a store that refuses capture-gap inserts$/, async (w) => {
    w.store = await freshStore(w)
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < 3; i++) {
        stage(w.store, `refusetoken${s} row ${i} ` + 'v'.repeat(2000), `sess-${s}`, T0 + s * 1000 + i)
      }
    }
    // The refusal is a real insert failure on exactly the tombstone
    // shape — same poison-trigger technique the dead-letter scenarios
    // use elsewhere in the corpus.
    w.store.store.database.exec(
      "CREATE TRIGGER refuse_gaps BEFORE INSERT ON nodes WHEN new.content LIKE '[capture gap]%' " +
        "BEGIN SELECT RAISE(ABORT, 'tombstones refused'); END",
    )
    // Small batches: the drain must not simply catch up and dissolve
    // the overage — the valve has to face the drop decision while the
    // refusal stands.
    w.loop = new IngestionLoop(w.store, { batchSize: 2, stagingMaxBytes: 5000 })
    w.valveSingleTick = true
  })

  reg.define(/^the refused session stays staged in full for a later tick$/, async (w) => {
    // Not dropped, not tombstoned — and since the valve refused to
    // reduce, the oldest session's rows are still in the letterbox.
    const gaps = await w.store!.query('capture gap', { topK: 10, metadataFilter: { event: 'capture_gap' } })
    expect(gaps).toHaveLength(0)
    expect(w.store!.store.countUnprocessedStaging()).toBeGreaterThan(0)
  })

  reg.define(/^once the refusal clears, the drop happens with its tombstone in place$/, async (w) => {
    w.store!.store.database.exec('DROP TRIGGER refuse_gaps')
    await drain(w.store!, w.loop!)
    const gaps = await w.store!.query('capture gap', { topK: 10, metadataFilter: { event: 'capture_gap' } })
    expect(gaps.length).toBeGreaterThan(0)
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
  })

  reg.define(/^a capture-gap tombstone older than every retained session$/, async (w) => {
    w.store = await freshStore(w, { maxSessions: 2, retentionInterval: 1_000_000 })
    w.tombstoneId = (
      await w.store.insert('[capture gap] 9 staged events from session ancient were dropped.', {
        createdAt: T0 - 100_000,
        metadata: { source: 'capture-gap', event: 'capture_gap', session_id: 'ancient' },
      })
    ).nodeId
    // Three newer auto-capture sessions — more than maxSessions retains.
    for (let s = 0; s < 3; s++) {
      await w.store.insert(`filler for session ${s}`, {
        createdAt: T0 + s * 1000,
        metadata: { source: 'auto-capture', role: 'user', session_id: `sess-${s}` },
      })
    }
  })

  reg.define(/^retention sweeps run$/, (w) => {
    w.store!.retentionSweep()
  })

  reg.define(/^the tombstone survives, pinning that gap records are never evicted$/, async (w) => {
    const parsed = JSON.parse(w.store!.exportJson({ nodeId: w.tombstoneId! })) as { nodes: unknown[] }
    expect(parsed.nodes.length).toBe(1)
  })

  reg.define(/^a backlog-drained session genuinely older than the hundred newest sessions$/, async (w) => {
    w.store = await freshStore(w, { maxSessions: 2, retentionInterval: 1_000_000 })
    // The rescued old session, drained with honest (old) timestamps.
    stage(w.store, 'rescued ancient session content pterodactylglow', 'sess-ancient', T0 - 500_000)
    const loop = new IngestionLoop(w.store, { batchSize: 10 })
    await loop.ingestBatch()
    // Newer sessions beyond maxSessions.
    for (let s = 0; s < 3; s++) {
      await w.store.insert(`recent session ${s} content`, {
        createdAt: T0 + s * 1000,
        metadata: { source: 'auto-capture', role: 'user', session_id: `sess-${s}` },
      })
    }
  })

  reg.define(/^the next retention sweep runs$/, (w) => {
    w.store!.retentionSweep()
  })

  reg.define(/^the session's rows are evicted as any old session's would be$/, async (w) => {
    const hits = await w.store!.query('pterodactylglow', { topK: 5 })
    expect(hits.length).toBe(0)
  })

  reg.define(/^this is pinned as intended: retention is a recency policy and rescue is not resurrection$/, async (w) => {
    // The newest maxSessions=2 sessions survive. The evicted session's
    // tombstone (charter valve, 2026-07-24) also mentions "session" —
    // filter it out; it is a marker, not surviving session content.
    const recent = await w.store!.query('recent session content', { topK: 10 })
    const surviving = recent.filter((r) => r.metadata?.['_tombstone'] !== true)
    expect(surviving.length).toBe(2)
  })

  reg.define(/^a staging row claiming to be a recovery snapshot whose content is not valid JSON$/, async (w) => {
    w.store = await freshStore(w)
    w.store.store.insertStaging({
      sessionId: 'snap-session', role: 'snapshot',
      content: '{ this is MALFORMEDSNAP not json', timestamp: 1_700_000_000, priority: 1,
    })
  })

  reg.define(/^the drain processes it$/, async (w) => {
    const loop = new IngestionLoop(w.store as unknown as IngestibleStore, { batchSize: 10 })
    await drain(w.store as unknown as IngestibleStore, loop)
  })

  reg.define(/^the row is retired and a capture-gap node records the drop$/, async (w) => {
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
    const hits = await w.store!.query('malformed recovery snapshot dropped', { topK: 5 })
    const gap = hits.find((h) => h.metadata?.['source'] === 'capture-gap'
      && h.metadata?.['event'] === 'malformed_snapshot')
    expect(gap, 'the drop left no tombstone').toBeTruthy()
    expect(gap!.metadata!['session_id']).toBe('snap-session')
  })

  reg.define(/^the capture-gap node names the malformed snapshot without embedding it whole$/, async (w) => {
    const hits = await w.store!.query('MALFORMEDSNAP', { topK: 5 })
    const gap = hits.find((h) => h.metadata?.['source'] === 'capture-gap')!
    // A prefix, not the payload: the JF-7 rule the dead-letter path follows.
    expect(gap.content).toContain('Content prefix:')
    expect(gap.content.length).toBeLessThan(1200)
  })

  reg.define(/^a staging row whose insert fails deterministically$/, async (w) => {
    w.store = await freshStore(w)
    stage(w.store, 'POISON row content', 'sess-p', T0)
    w.wrapped = poisonWrapper(w.store)
    w.loop = new IngestionLoop(w.wrapped, { batchSize: 10 })
  })

  reg.define(/^three drain ticks pass$/, async (w) => {
    await w.loop!.ingestBatch()
    await w.loop!.ingestBatch()
    await w.loop!.ingestBatch()
  })

  reg.define(/^the row is marked processed and a capture-gap node records the failure$/, async (w) => {
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
    const gaps = await w.store!.query('dead-lettered', { topK: 5, metadataFilter: { event: 'ingest_failure' } })
    expect(gaps.length).toBe(1)
    expect(gaps[0]!.metadata!['error']).toContain('deterministic poison failure')
  })

  reg.define(/^subsequent ticks ingest fresh rows normally$/, async (w) => {
    stage(w.store!, 'healthy row after poison gyroscopemint', 'sess-p', T0 + 10)
    await w.loop!.ingestBatch()
    const hits = await w.store!.query('gyroscopemint', { topK: 5 })
    expect(hits.length).toBe(1)
  })

  reg.define(/^more deterministically-failing rows than one batch holds$/, async (w) => {
    w.store = await freshStore(w)
    for (let i = 0; i < 25; i++) {
      stage(w.store, `POISON batch row ${i}`, 'sess-p', T0 + i)
    }
    stage(w.store, 'healthy survivor row kelpwhisker', 'sess-p', T0 + 100)
    w.wrapped = poisonWrapper(w.store)
    w.loop = new IngestionLoop(w.wrapped, { batchSize: 20 })
  })

  reg.define(/^drain ticks continue$/, async (w) => {
    await drain(w.wrapped!, w.loop!, 30)
  })

  reg.define(/^within three ticks per batch the drain resumes ingesting healthy rows$/, async (w) => {
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
    const hits = await w.store!.query('kelpwhisker', { topK: 5 })
    expect(hits.length).toBe(1)
  })

  reg.define(/^a failing staging row carrying a quarter-megabyte of content$/, async (w) => {
    w.store = await freshStore(w)
    stage(w.store, 'POISON ' + 'q'.repeat(250_000), 'sess-p', T0)
    w.loop = new IngestionLoop(poisonWrapper(w.store), { batchSize: 10 })
  })

  reg.define(/^it dead-letters$/, async (w) => {
    await w.loop!.ingestBatch()
    await w.loop!.ingestBatch()
    await w.loop!.ingestBatch()
  })

  reg.define(/^the capture-gap node carries the error and at most a short content prefix$/, async (w) => {
    const gaps = await w.store!.query('dead-lettered', { topK: 5, metadataFilter: { event: 'ingest_failure' } })
    expect(gaps.length).toBe(1)
    expect(gaps[0]!.content.length).toBeLessThan(1500)
    expect(gaps[0]!.metadata!['error']).toContain('deterministic poison failure')
  })
}
