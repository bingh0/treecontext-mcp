import { describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { clusterBootstrapSE, queryBootstrapSE, recallAtK, advisoryFloor } from '../../bench/lib/metrics.js'
import { compareValues, compareSlices, renderReport, sigmasCell, sigmasPhrase, type RunRecord, type SliceResult } from '../../bench/lib/report.js'
import { pairedCompare } from '../../bench/lib/paired.js'
import { MUTATIONS, findMutation } from '../../bench/mutations.js'

/**
 * Guards the bench's detector without needing the 265 MB corpus, so it
 * runs everywhere `npm test` runs.
 *
 * `npm run bench:falsify` is the full article — it breaks retrieval on
 * purpose against real data and checks the detector notices. These tests
 * cover the arithmetic underneath it, which is what would silently rot.
 */

const slice = (name: string, value: number, n: number, se: number): SliceResult =>
  ({ slice: name, metric: 'recall@5', value, n, se })

describe('the 3-SE detector', () => {
  it('calls an identical rerun noise, not a change', () => {
    const cmp = compareValues(0.9148, 0.01, 0.9148, 0.01)
    expect(cmp.delta).toBe(0)
    expect(cmp.verdict).toBe('within-noise')
  })

  it('flags a collapse as a regression', () => {
    const cmp = compareValues(0.69, 0.012, 0.9148, 0.01)
    expect(cmp.verdict).toBe('regression')
    expect(cmp.sigmas).toBeGreaterThan(3)
  })

  it('does not call an improvement a regression', () => {
    const cmp = compareValues(0.98, 0.01, 0.9148, 0.01)
    expect(cmp.verdict).toBe('improvement')
  })

  it('stays quiet for a drop inside the band', () => {
    // ~2 SE of the difference: real, but below what this instrument resolves.
    const cmp = compareValues(0.8868, 0.01, 0.9148, 0.01)
    expect(cmp.sigmas).toBeLessThan(3)
    expect(cmp.verdict).toBe('within-noise')
  })

  it('accounts for BOTH runs’ error in the difference', () => {
    // A noisier comparison run must widen the band, not leave it unchanged.
    const tight = compareValues(0.88, 0.01, 0.9148, 0.01)
    const loose = compareValues(0.88, 0.05, 0.9148, 0.01)
    expect(loose.jointSe).toBeGreaterThan(tight.jointSe)
    expect(loose.sigmas).toBeLessThan(tight.sigmas)
  })
})

describe('per-slice detection', () => {
  it('catches a concentrated failure the aggregate misses', () => {
    // The case this project has already had: one category collapses while
    // the mean barely moves. The falsification run reproduces it exactly —
    // subgroup-collapse reads -4.46pp aggregate (2.9 SE, quiet) and
    // -17.3pp in the affected slice (4.7 SE, flagged).
    // Figures taken from the recorded falsification run, not invented:
    // reference 91.48% (SE 1.00%), mutated 87.02% (SE 1.17%) → 2.9 SE.
    const aggregate = compareValues(0.8702, 0.0117, 0.9148, 0.0100)
    expect(aggregate.sigmas).toBeLessThan(3)
    expect(aggregate.verdict).toBe('within-noise')

    // Same run, the affected slice: 83.8% → 66.5% at 4.7 SE.
    const affected = compareSlices(
      slice('multi-session', 0.665, 121, 0.027),
      slice('multi-session', 0.838, 121, 0.025),
    )
    expect(affected.verdict).toBe('regression')
    expect(affected.sigmas).toBeGreaterThan(3)
  })

  it('leaves untouched slices alone', () => {
    const same = compareSlices(slice('knowledge-update', 0.986, 72, 0.014), slice('knowledge-update', 0.986, 72, 0.014))
    expect(same.verdict).toBe('within-noise')
  })
})

describe('a change over a zero standard error (D271)', () => {
  it('flags a nonzero drop when neither side has any variance', () => {
    // The chunk-2 case: a checkpoint slice at 100% on the reference and at
    // 50% on a mutated run, each with SE 0, read "0.0 SE, within noise".
    const cmp = compareSlices(slice('checkpoint-lookup', 0.5, 8, 0), slice('checkpoint-lookup', 1, 8, 0))
    expect(cmp.verdict).toBe('regression')
    expect(cmp.jointSe).toBe(0)
    expect(cmp.sigmas).toBe(Number.POSITIVE_INFINITY)
  })

  it('flags a nonzero gain by its sign', () => {
    expect(compareValues(1, 0, 0.5, 0).verdict).toBe('improvement')
  })

  it('keeps a zero change over a zero error within noise', () => {
    const cmp = compareValues(1, 0, 1, 0)
    expect(cmp.verdict).toBe('within-noise')
    expect(cmp.sigmas).toBe(0)
  })

  it('never renders Infinity', () => {
    expect(sigmasCell(Number.POSITIVE_INFINITY)).toBe('exact (SE 0)')
    expect(sigmasPhrase(Number.POSITIVE_INFINITY)).toBe('exact (SE 0)')
    expect(sigmasPhrase(3.21)).toBe('3.2 SE')
    const run = (value: number, sliceValue: number): RunRecord => ({
      schema: 1, arm: 'a', metric: 'mrr@5', value, se: 0.01, se_cluster: 0, n: 100, advisory_floor: 0,
      elapsed_s: 1, measured_at: '2026-10-10T00:00:00Z', mapping_version: 1, partial: false,
      corpus: { id: 'c', path: 'p', bytes: 1, sha256: 'x'.repeat(64), pinned: true, mismatch: false },
      slices: [slice('s', sliceValue, 8, 0)], slice_rule: 'r', code_sha: null, code_dirty: false,
      better_sqlite3: 'x', sqlite: 'x', node: 'x', platform: 'x',
    } as unknown as RunRecord)
    const text = renderReport(run(0.9, 0.5), [run(0.9, 1)])
    expect(text).toContain('⚠️ exact (SE 0)')
    expect(text).not.toContain('Infinity')
  })

  it('keeps a slice flag a slice flag: the aggregate verdict is its own test', () => {
    // A slice that lost everything inside an aggregate that barely moved.
    const sliceCmp = compareSlices(slice('s', 0, 4, 0), slice('s', 1, 4, 0))
    const aggregate = compareValues(0.98, 0.01, 0.99, 0.01)
    expect(sliceCmp.verdict).toBe('regression')
    expect(aggregate.verdict).toBe('within-noise')
  })
})

describe('the paired comparison over a zero standard error (D271)', () => {
  it('flags a change every query shares by its sign', () => {
    const a = [1, 1, 1, 1]
    const worse = pairedCompare(a, [0.5, 0.5, 0.5, 0.5])
    expect(worse.se).toBe(0)
    expect(worse.verdict).toBe('A better')
    expect(sigmasCell(worse.sigmas)).toBe('exact (SE 0)')
    expect(pairedCompare(a.map(() => 0.5), a).verdict).toBe('B better')
  })

  it('reads no change as no change', () => {
    const same = pairedCompare([1, 0.5, 0], [1, 0.5, 0])
    expect(same.verdict).toBe('no detectable difference')
    expect(same.sigmas).toBe(0)
  })
})

describe('error estimates', () => {
  const values = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? 0 : 1))

  it('is deterministic — a rerun reproduces the interval exactly', () => {
    expect(queryBootstrapSE(values)).toBe(queryBootstrapSE(values))
  })

  it('reports no error when there is nothing to resample', () => {
    expect(queryBootstrapSE([])).toBe(0)
    expect(clusterBootstrapSE([1, 1, 1], ['a', 'a', 'a'])).toBe(0)
  })

  it('widens when clusters genuinely differ', () => {
    // Two categories, one perfect and one poor: resampling whole clusters
    // must be less certain than resampling individual queries. This is why
    // the report carries both and uses the query-level one for the band.
    const split = [...Array(100).fill(1), ...Array(100).fill(0)] as number[]
    const clusters = [...Array(100).fill('easy'), ...Array(100).fill('hard')] as string[]
    expect(clusterBootstrapSE(split, clusters)).toBeGreaterThan(queryBootstrapSE(split))
  })

  it('places the advisory floor three errors below', () => {
    expect(advisoryFloor(0.9148, 0.01)).toBeCloseTo(0.8848, 4)
  })
})

describe('mutations', () => {
  it('every mutation declares a distinct id and a real expectation', () => {
    const ids = MUTATIONS.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MUTATIONS) {
      expect(['flag-aggregate', 'flag-slice', 'no-flag', 'below-sensitivity']).toContain(m.expect)
      expect(m.description.length).toBeGreaterThan(20)
    }
  })

  it('the control mutation really does nothing', () => {
    const identity = findMutation('identity')!
    expect(identity.onInsert).toBeUndefined()
    expect(identity.onQuery).toBeUndefined()
    expect(identity.onRanked).toBeUndefined()
  })

  it('scrambling is deterministic and keeps every candidate', () => {
    const collapse = findMutation('rank-collapse')!
    const input = ['a', 'b', 'c', 'd', 'e', 'f']
    const once = collapse.onRanked!(input, { cluster: 'x' })
    expect(collapse.onRanked!(input, { cluster: 'x' })).toEqual(once)
    expect([...once].sort()).toEqual([...input].sort())
    expect(once).not.toEqual(input)
  })

  it('subgroup-collapse touches only its target category', () => {
    const sub = findMutation('subgroup-collapse')!
    const input = ['a', 'b', 'c', 'd']
    expect(sub.onRanked!(input, { cluster: 'multi-session' })).not.toEqual(input)
    expect(sub.onRanked!(input, { cluster: 'knowledge-update' })).toEqual(input)
  })
})

describe('a mutation degrades real retrieval', () => {
  it('indexing only a preview loses answers that live in the tail', async () => {
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
      maxSessions: Number.MAX_SAFE_INTEGER,
      maxAutoEntries: Number.MAX_SAFE_INTEGER,
      retentionInterval: Number.MAX_SAFE_INTEGER,
    })
    const preview = findMutation('index-preview-only')!

    // The answer term sits past the 300-character preview boundary.
    const filler = 'routine session chatter about scheduling and logistics. '.repeat(12)
    const full = `${filler}the deployment failed because of a xylophone misconfiguration`
    await store.insert(preview.onInsert!(full), { metadata: { sid: 'mutated' } })
    await store.insert('unrelated notes about invoices and billing', { metadata: { sid: 'other' } })

    const hits = await store.query('xylophone misconfiguration', { topK: 5 })
    const ranked = hits.map(h => String((h.metadata as { sid?: string } | null)?.sid ?? ''))
    expect(recallAtK(ranked, { mutated: 1 }, 5)).toBe(0)

    await store.close()
  })
})
