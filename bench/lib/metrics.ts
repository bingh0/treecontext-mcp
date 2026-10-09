/**
 * Retrieval metrics and the uncertainty around them.
 *
 * The bench reports; it does not gate. So the number alone is not the
 * product — the number *with its sampling error* is, because that is what
 * separates "retrieval regressed" from "we drew a different sample of
 * questions". A drop inside the error band is noise and should not cost
 * anyone an afternoon.
 */

/** Graded relevance: id → gain. Absent ids score 0. */
export type Relevance = Record<string, number>

/**
 * Fraction of the relevant items that appear in the top k.
 *
 * Kept identical to the harness that produced the historical numbers —
 * comparability across two years of runs is worth more than a tidier
 * definition.
 */
export function recallAtK(ranked: string[], relevance: Relevance, k: number): number {
  const relevant = Object.keys(relevance).filter(id => (relevance[id] ?? 0) > 0)
  if (relevant.length === 0) return 0
  const top = new Set(ranked.slice(0, k))
  const found = relevant.filter(id => top.has(id)).length
  return found / relevant.length
}

/** Reciprocal rank of the first relevant hit within k; 0 if none. */
export function reciprocalRank(ranked: string[], relevance: Relevance, k: number): number {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if ((relevance[ranked[i]!] ?? 0) > 0) return 1 / (i + 1)
  }
  return 0
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Standard error of the mean, by bootstrap over CLUSTERS rather than over
 * individual queries.
 *
 * Clustering matters here and is easy to get wrong. LongMemEval questions
 * that share an ability category — and, in v2, every question within a
 * domain — draw on overlapping haystacks, so their errors are correlated.
 * Resampling individual questions would treat those as independent
 * evidence and report an error bar narrower than the truth, which is the
 * failure mode that turns noise into a false alarm.
 *
 * Deterministic: seeded PRNG, so a rerun of the same data reproduces the
 * same interval. A bench whose own uncertainty wobbles is not evidence.
 */
export function clusterBootstrapSE(
  values: number[],
  clusters: string[],
  iterations = 2000,
  seed = 20260728,
): number {
  if (values.length !== clusters.length) {
    throw new Error(`values (${values.length}) and clusters (${clusters.length}) must align`)
  }
  if (values.length === 0) return 0

  const byCluster = new Map<string, number[]>()
  for (let i = 0; i < values.length; i++) {
    const key = clusters[i]!
    const bucket = byCluster.get(key)
    if (bucket) bucket.push(values[i]!)
    else byCluster.set(key, [values[i]!])
  }
  const groups = [...byCluster.values()]
  if (groups.length < 2) return 0

  // xorshift32 — small, fast, and reproducible across platforms.
  let state = seed >>> 0
  const next = (): number => {
    state ^= state << 13; state >>>= 0
    state ^= state >> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }

  const means: number[] = []
  for (let b = 0; b < iterations; b++) {
    let sum = 0, n = 0
    for (let g = 0; g < groups.length; g++) {
      const picked = groups[Math.floor(next() * groups.length)]!
      for (const v of picked) { sum += v; n++ }
    }
    means.push(n === 0 ? 0 : sum / n)
  }

  const m = mean(means)
  const variance = mean(means.map(x => (x - m) ** 2))
  return Math.sqrt(variance)
}

/**
 * Bootstrap over individual queries — each query is its own cluster.
 *
 * This is the scale reference for the advisory band. Two runs over the
 * SAME corpus have no sampling noise at all (BM25 is deterministic), so
 * the band is not a noise threshold in the usual sense: it is a statement
 * about what size of difference is large relative to the precision of the
 * measurement itself, and therefore worth someone's attention.
 */
export function queryBootstrapSE(values: number[], iterations = 2000, seed = 20260728): number {
  return clusterBootstrapSE(values, values.map((_, i) => String(i)), iterations, seed)
}

/**
 * The advisory band. Three standard errors below the reference.
 *
 * Derived from the QUERY-level error, not the cluster-level one. With only
 * a handful of ability categories, the cluster bootstrap is dominated by
 * between-category spread and answers a generalization question this
 * report is not asking ("would the figure hold on a different sample of
 * categories?"). Using it here would produce a band so wide that a
 * genuinely alarming drop could sit inside it. The cluster SE is still
 * reported, as the honest caveat on generalizing the headline number.
 *
 * Advisory, not a gate — nothing here fails a build.
 */
export function advisoryFloor(reference: number, se: number, sigma = 3): number {
  return reference - sigma * se
}
