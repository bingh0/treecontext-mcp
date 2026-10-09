/**
 * Deliberate defects, for testing the instrument rather than the product.
 *
 * A regression report that has never caught anything is a decoration. The
 * only way to know it works is to break retrieval on purpose and check
 * that the number moves far enough to be noticed — and, just as
 * importantly, that a harmless change does NOT move it. A detector that
 * fires at everything is as useless as one that fires at nothing.
 *
 * These simulate the OBSERVABLE EFFECT of a defect class; they are not
 * reproductions of specific historical bugs. `rank-collapse` stands in for
 * the stale sparse-weight heuristic that collapsed MRR, and
 * `subgroup-collapse` for the agent-source bias that read 0.61 vs 0.11
 * recall — but they arrive at that effect by mutating the pipeline, not by
 * reintroducing the original code.
 *
 * Mutations never touch `src/`. They wrap the seams the arm already has:
 * what goes in, what is asked, what comes back.
 */

export interface MutationContext {
  /** Cluster label of the query being scored — lets a mutation target one
   *  slice, which is how subgroup collapse is simulated. */
  cluster: string
  /** The slice `subgroup-collapse` should damage, chosen per arm by the
   *  runner (the largest cluster in the reference run). Hardcoding a name
   *  made the mutation silently inert on every arm but the first — it
   *  targeted `multi-session`, which only LongMemEval-S has. */
  target?: string
}

export interface Mutation {
  id: string
  /** What real defect this stands in for. */
  description: string
  /**
   * What the detector must conclude.
   *   'flag-aggregate' — the headline number must trip the 3-SE test.
   *   'flag-slice'     — at least one per-slice figure must trip it; the
   *                      aggregate may or may not, which is the whole
   *                      reason the slice table exists.
   *   'no-flag'        — neither may trip. Harmless changes must stay quiet.
   *   'below-sensitivity' — a genuine defect whose effect is smaller than
   *                      this arm can resolve. Not a failure of the
   *                      detector but a measurement of its floor, which is
   *                      more useful published than hidden.
   */
  expect: 'flag-aggregate' | 'flag-slice' | 'no-flag' | 'below-sensitivity'
  /** Corrupt content on the way into the journal. */
  onInsert?: (text: string) => string
  /** Corrupt the query text. */
  onQuery?: (query: string, ctx: MutationContext) => string
  /** Corrupt the ranking that comes back. */
  onRanked?: (ranked: string[], ctx: MutationContext) => string[]
}

/** Deterministic shuffle — a seeded rotation-and-interleave. Same input,
 *  same output, so a falsification run is reproducible. */
function scramble(xs: string[]): string[] {
  const out = [...xs]
  const mid = Math.floor(out.length / 2)
  const head = out.slice(0, mid)
  const tail = out.slice(mid)
  const woven: string[] = []
  for (let i = 0; i < Math.max(head.length, tail.length); i++) {
    if (tail[i] !== undefined) woven.push(tail[i]!)
    if (head[i] !== undefined) woven.push(head[i]!)
  }
  return woven
}

export const MUTATIONS: Mutation[] = [
  {
    id: 'identity',
    description: 'No change at all. The control: if this flags, the detector is broken.',
    expect: 'no-flag',
  },
  {
    id: 'whitespace-normalize',
    description:
      'Collapse runs of whitespace on the way in. A harmless normalization of the ' +
      'kind a refactor might introduce — it must NOT read as a regression.',
    expect: 'no-flag',
    onInsert: text => text.replace(/[ \t]+/g, ' '),
  },
  {
    id: 'index-preview-only',
    description:
      'Index only the first 300 characters of each entry. Simulates the preview/index ' +
      'split regressing so that the bounded preview is searchable but the full tail is not.',
    expect: 'flag-aggregate',
    onInsert: text => text.slice(0, 300),
  },
  {
    id: 'rank-collapse',
    description:
      'Deterministically scramble the ranking. Stands in for the stale sparse-weight ' +
      'heuristic that collapsed MRR: retrieval still returns everything, in the wrong order.',
    expect: 'flag-aggregate',
    onRanked: ranked => scramble(ranked),
  },
  {
    id: 'topk-clip',
    description:
      'Return only the top 3 results against a recall@5 metric, so only questions whose ' +
      'gold session ranked 4th or 5th are lost. MEASURED at -4.53pp (2.9 SE) on n=470 — a ' +
      'real defect that lands just under the resolution of a 3-SE rule. It is here to ' +
      'measure that floor: this arm cannot see a regression smaller than roughly 4.7pp.',
    expect: 'below-sensitivity',
    onRanked: ranked => ranked.slice(0, 3),
  },
  {
    id: 'query-drop-short-terms',
    description:
      'Strip words of four characters or fewer from the query. MEASURED at -0.17pp: BM25 ' +
      'already discounts short low-IDF words, so losing them costs almost nothing. Kept as ' +
      'a recorded property of the ranker — and as a second specificity check — rather than ' +
      'as a defect. The expectation here was wrong before it was measured.',
    expect: 'no-flag',
    onQuery: query => query.split(/\s+/).filter(w => w.length > 4).join(' ') || query,
  },
  {
    id: 'query-drop-rare-terms',
    description:
      'Strip the three longest words from the query — length proxies for rarity, and rare ' +
      'terms carry the IDF mass BM25 ranks on. The complement of the mutation above: this ' +
      'is what losing query signal actually looks like.',
    expect: 'flag-aggregate',
    onQuery: query => {
      const words = query.split(/\s+/)
      const longest = [...words].sort((a, b) => b.length - a.length).slice(0, 3)
      const dropped = words.filter(w => !longest.includes(w))
      return dropped.length > 0 ? dropped.join(' ') : query
    },
  },
  {
    id: 'subgroup-collapse',
    description:
      'Scramble the ranking for ONE ability category only, leaving the rest intact. ' +
      'Stands in for the agent-source bias (0.61 vs 0.11 recall): a real failure confined ' +
      'to one slice. MEASURED: the aggregate moved -9.4pp at 2.8 SE — under the 3-SE line — ' +
      'while the affected slice moved -23.2pp. Precisely the case the aggregate misses and ' +
      'the slice table catches, which is why it expects a slice flag rather than an aggregate one.',
    expect: 'flag-slice',
    onRanked: (ranked, ctx) =>
      ctx.cluster === (ctx.target ?? SUBGROUP_TARGET) ? scramble(ranked) : ranked,
  },
]

/** Fallback target when the runner does not supply one. */
export const SUBGROUP_TARGET = 'multi-session'

/**
 * Per-arm expectation overrides.
 *
 * A mutation's effect depends on the corpus it is applied to, so a single
 * global expectation is a lie. Measured examples, both from real runs:
 *   - `index-preview-only` truncates to 300 characters, which is a NO-OP
 *     on the code fixture, whose entries are mostly shorter than that.
 *   - `rank-collapse` barely moves recall@5 on the code fixture because
 *     most queries there return five or fewer candidates in total, so
 *     reordering them cannot push gold out of the top five. That is a
 *     property of the metric on a small corpus, not of the ranker.
 */
export const ARM_EXPECTATIONS: Record<string, Record<string, Mutation['expect']>> = {
  'code-fixture': {
    'index-preview-only': 'no-flag',
    'rank-collapse': 'below-sensitivity',
    'query-drop-rare-terms': 'below-sensitivity',
    'subgroup-collapse': 'below-sensitivity',
  },
}

export function expectationFor(mutation: Mutation, armId: string): Mutation['expect'] {
  return ARM_EXPECTATIONS[armId]?.[mutation.id] ?? mutation.expect
}

export function findMutation(id: string): Mutation | undefined {
  return MUTATIONS.find(m => m.id === id)
}
