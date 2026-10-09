/**
 * Paired comparison — the right instrument for A vs B.
 *
 * The regression detector compares two INDEPENDENT means, which is correct
 * for watching one arm drift over time and wrong for comparing two
 * retrievers. Both retrievers answer the SAME queries, so the pairing is
 * real information, and discarding it throws away most of the power: at
 * n=470 the independent-means test cannot resolve anything under ~4.2pp,
 * while a paired test on the same data resolves far smaller differences
 * because between-query variance cancels.
 *
 * This is also how the original 2026-06 work reached its conclusion — "8
 * rescued, 9 poisoned" is a paired count, not a difference of averages,
 * and it is why a −0.21pp result was still interpretable.
 *
 * Two statistics are reported because they answer different questions:
 *
 *   - the paired bootstrap gives the mean per-query difference with an
 *     interval, i.e. HOW MUCH better;
 *   - McNemar's exact test counts queries that changed direction —
 *     rescued vs poisoned — i.e. WHETHER the change is one-sided or a
 *     wash of wins and losses that happen to net out.
 *
 * A retriever that rescues 40 queries and poisons 39 has a tiny mean
 * difference and is not doing nothing; it is churning. Only the second
 * statistic can tell you that.
 */

export interface PairedResult {
  n: number
  meanA: number
  meanB: number
  /** meanB − meanA. Positive means B is better. */
  meanDelta: number
  /** Bootstrap SE of the paired difference. */
  se: number
  /** |meanDelta| in units of se. */
  sigmas: number
  /** Queries B got strictly better. */
  rescued: number
  /** Queries B got strictly worse. */
  poisoned: number
  /** Queries where neither differs. */
  unchanged: number
  /** Two-sided exact binomial p over the discordant pairs (McNemar). */
  pValue: number
  verdict: 'B better' | 'A better' | 'no detectable difference'
}

/** Bootstrap over per-query DIFFERENCES, which is what makes it paired. */
function bootstrapSE(deltas: number[], iterations = 5000, seed = 20260728): number {
  if (deltas.length === 0) return 0
  let state = seed >>> 0
  const next = (): number => {
    state ^= state << 13; state >>>= 0
    state ^= state >> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
  const means: number[] = []
  for (let b = 0; b < iterations; b++) {
    let sum = 0
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(next() * deltas.length)]!
    means.push(sum / deltas.length)
  }
  const m = means.reduce((a, b) => a + b, 0) / means.length
  const varc = means.reduce((a, b) => a + (b - m) ** 2, 0) / means.length
  return Math.sqrt(varc)
}

/** log(n choose k), via lgamma, so large n does not overflow. */
function lnChoose(n: number, k: number): number {
  const lgamma = (x: number): number => {
    // Lanczos approximation; ample precision for a sign test.
    const g = 7
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ]
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
    x -= 1
    let a = c[0]!
    const t = x + g + 0.5
    for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i)
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
  }
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
}

/**
 * Two-sided exact binomial test on the discordant pairs: under the null
 * that a change is equally likely to help or hurt, how surprising is this
 * split? The exact form is used rather than the chi-square approximation
 * because discordant counts here are often small.
 */
function mcnemarExactP(rescued: number, poisoned: number): number {
  const n = rescued + poisoned
  if (n === 0) return 1
  const k = Math.min(rescued, poisoned)
  let tail = 0
  for (let i = 0; i <= k; i++) tail += Math.exp(lnChoose(n, i) + n * Math.log(0.5))
  return Math.min(1, 2 * tail)
}

/**
 * @param a per-query scores for the baseline, in query order
 * @param b per-query scores for the challenger, same order
 */
export function pairedCompare(a: number[], b: number[], sigma = 3): PairedResult {
  if (a.length !== b.length) throw new Error(`paired inputs differ: ${a.length} vs ${b.length}`)
  const deltas = b.map((x, i) => x - a[i]!)

  let rescued = 0, poisoned = 0, unchanged = 0
  for (const d of deltas) {
    if (d > 0) rescued++
    else if (d < 0) poisoned++
    else unchanged++
  }

  const mean = (xs: number[]): number => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : 0)
  const meanDelta = mean(deltas)
  const se = bootstrapSE(deltas)
  const sigmas = se > 0 ? Math.abs(meanDelta) / se : 0

  return {
    n: a.length,
    meanA: mean(a),
    meanB: mean(b),
    meanDelta,
    se,
    sigmas,
    rescued,
    poisoned,
    unchanged,
    pValue: mcnemarExactP(rescued, poisoned),
    verdict: sigmas < sigma
      ? 'no detectable difference'
      : meanDelta > 0 ? 'B better' : 'A better',
  }
}
