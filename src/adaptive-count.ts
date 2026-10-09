/**
 * Adaptive result count — BM25-native redesign of the deleted CAR cutoff.
 *
 * Measured before built. The deleted implementation was tuned on cosine
 * score distributions and failed on real BM25 lists three ways: its
 * confidence gate tripped on 10/12 live queries, its linear position
 * REWARD degenerated to return-the-max on BM25's long smooth tails, and
 * its anchor-as-floor design was blind to the top-1..3 breaks where real
 * BM25 structure lives. This redesign:
 *
 *   - anchor is a BUDGET, not a floor — the cut may land below it when
 *     the break is emphatic;
 *   - position is a mild PENALTY (earlier breaks preferred), never a
 *     reward for expanding;
 *   - near-tied top gaps resolve to the LATEST of them, so a two-step
 *     cliff keeps the whole cliff;
 *   - flat distributions (low confidence) return the budget and say so —
 *     on BM25 a flat list usually means nothing matches strongly, so
 *     expanding on flatness (the deleted behavior) is backwards.
 *
 * Every constant is a bench-tunable shape parameter; the value gate for
 * the feature itself runs on the probe against the post-fusion ranking.
 */

export interface AdaptiveCountOptions {
  /** Below this maxGap/scoreRange ratio the distribution is treated as
   *  flat. Default 0.25 (the deleted 0.35 gate, cosine-tuned, tripped on
   *  10/12 real BM25 queries). */
  minConfidence?: number
  /** Position penalty slope: gapScore = gap/maxGap − lambda·i/N.
   *  Default 0.15. */
  positionLambda?: number
  /** Gap scores within this of the best tie toward the LATEST position,
   *  keeping a multi-step cliff intact. Default 0.08. */
  tieDelta?: number
}

export interface AdaptiveCountResult {
  /** How many results to return. */
  k: number
  /** maxGap / scoreRange — how emphatic the best break is. */
  confidence: number
  /** True when no trustworthy break existed and k fell back to the
   *  budget. */
  flat: boolean
}

const EPS = 1e-12

export function computeAdaptiveCount(
  scoresDesc: readonly number[],
  anchor: number,
  max: number,
  opts?: AdaptiveCountOptions,
): AdaptiveCountResult {
  const minConfidence = opts?.minConfidence ?? 0.25
  const positionLambda = opts?.positionLambda ?? 0.15
  const tieDelta = opts?.tieDelta ?? 0.08

  const N = Math.min(scoresDesc.length, Math.max(1, max))
  if (N === 0) return { k: 0, confidence: 0, flat: true }
  if (N === 1) return { k: 1, confidence: 1, flat: false }

  const gaps: number[] = []
  for (let i = 0; i < N - 1; i++) gaps.push(scoresDesc[i]! - scoresDesc[i + 1]!)
  const maxGap = Math.max(...gaps)
  const range = scoresDesc[0]! - scoresDesc[N - 1]!

  if (range < EPS || maxGap < EPS) {
    return { k: Math.min(anchor, N), confidence: 0, flat: true }
  }

  const confidence = maxGap / range
  if (confidence < minConfidence) {
    return { k: Math.min(anchor, N), confidence, flat: true }
  }

  let best = -Infinity
  const gapScores: number[] = []
  for (let i = 0; i < N - 1; i++) {
    const gs = gaps[i]! / maxGap - positionLambda * (i / N)
    gapScores.push(gs)
    if (gs > best) best = gs
  }
  // Latest position within tieDelta of the best — a two-step cliff cuts
  // after its last step, not its first.
  let bestPos = 0
  for (let i = 0; i < gapScores.length; i++) {
    if (gapScores[i]! >= best - tieDelta) bestPos = i
  }

  const k = Math.max(1, Math.min(bestPos + 1, N))
  return { k, confidence, flat: false }
}
