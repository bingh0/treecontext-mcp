import { describe, it, expect } from 'vitest'
import { SessionStats } from '../../src/server/session-stats.js'

describe('SessionStats', () => {
  it('starts with all zeros', () => {
    const s = new SessionStats()
    const snap = s.toJSON()
    expect(snap.query.total).toBe(0)
    expect(snap.insert.total).toBe(0)
    expect(snap.delete.calls).toBe(0)
    expect(snap.clear.calls).toBe(0)
    expect(snap.export.calls).toBe(0)
    expect(snap.import.calls).toBe(0)
    expect(snap.startedAt).toMatch(/^\d{4}-/)
  })

  it('latency bucket min is 0 when empty', () => {
    const s = new SessionStats()
    const snap = s.toJSON()
    expect(snap.query.latency.min).toBe(0)
    expect(snap.query.latency.max).toBe(0)
    expect(snap.query.latency.count).toBe(0)
  })

  it('recordQuery increments total and byMode', () => {
    // 'bm25' is the only mode production ever records (server.ts
    // hardcodes it at the call site) — the strings pinned here used to
    // be tree-era modes that no longer exist, which advertised a
    // multi-mode telemetry the product does not have (F3, 2026-08-15).
    const s = new SessionStats()
    s.recordQuery('bm25', 10, 3)
    s.recordQuery('bm25', 15, 2)
    s.recordQuery('bm25', 50, 5)

    const snap = s.toJSON()
    expect(snap.query.total).toBe(3)
    expect(snap.query.byMode['bm25']).toBe(3)
    expect(Object.keys(snap.query.byMode)).toEqual(['bm25'])
    expect(snap.query.resultCountTotal).toBe(10)
  })

  it('latency bucket tracks min/max/sum/count', () => {
    const s = new SessionStats()
    s.recordQuery('bm25', 5, 1)
    s.recordQuery('bm25', 20, 1)
    s.recordQuery('bm25', 10, 1)

    const snap = s.toJSON()
    expect(snap.query.latency.count).toBe(3)
    expect(snap.query.latency.min).toBe(5)
    expect(snap.query.latency.max).toBe(20)
    expect(snap.query.latency.sum).toBe(35)
  })

  it('recordInsert distinguishes sources', () => {
    const s = new SessionStats()
    s.recordInsert('auto-capture', 50)
    s.recordInsert('auto-capture', 55)
    s.recordInsert('manual', 30)

    const snap = s.toJSON()
    expect(snap.insert.total).toBe(3)
    expect(snap.insert.bySource['auto-capture']).toBe(2)
    expect(snap.insert.bySource['manual']).toBe(1)
    expect(snap.insert.latency.count).toBe(3)
  })

  it('simple counters increment', () => {
    const s = new SessionStats()
    s.recordDelete()
    s.recordDelete()
    s.recordClear()

    const snap = s.toJSON()
    expect(snap.delete.calls).toBe(2)
    expect(snap.clear.calls).toBe(1)
  })

  it('recordExport and recordImport track counts', () => {
    const s = new SessionStats()
    s.recordExport(50)
    s.recordExport(30)
    s.recordImport(10)

    const snap = s.toJSON()
    expect(snap.export.calls).toBe(2)
    expect(snap.export.nodesExported).toBe(80)
    expect(snap.import.calls).toBe(1)
    expect(snap.import.nodesImported).toBe(10)
  })

  it('toJSON returns copies, not references', () => {
    const s = new SessionStats()
    s.recordQuery('bm25', 10, 3)
    const snap1 = s.toJSON()
    s.recordQuery('bm25', 20, 5)
    const snap2 = s.toJSON()

    expect(snap1.query.total).toBe(1)
    expect(snap2.query.total).toBe(2)
    expect(snap1.query.byMode).not.toBe(snap2.query.byMode)
  })

  it('reset clears everything', () => {
    const s = new SessionStats()
    s.recordQuery('bm25', 10, 3)
    s.recordInsert('manual', 50)
    s.recordDelete()
    s.recordClear()
    s.recordExport(20)
    s.recordImport(10)

    s.reset()
    const snap = s.toJSON()

    expect(snap.query.total).toBe(0)
    expect(snap.insert.total).toBe(0)
    expect(snap.delete.calls).toBe(0)
    expect(snap.clear.calls).toBe(0)
    expect(snap.export.calls).toBe(0)
    expect(snap.import.calls).toBe(0)
  })
})
