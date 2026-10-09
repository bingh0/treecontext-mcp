import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../../src/flat-store.js'
import { type World, mcpOver, parseTool, openLiveStore } from '../world.js'


/**
 * The search-modes wave's world: the orderings a scenario has to hold side
 * by side to prove a weight changed a ranking — the default order, the
 * order under custom weights, and which ids the query was supposed to
 * favour. A ranking claim with only one ordering in hand cannot fail.
 */
export interface SearchModesWorld extends World {
  baseline?: string[]
  customRanking?: string[]
  strongIds?: string[]
}

export const searchModesDefiner = (reg: Registry<SearchModesWorld>): void => {
  // ── the user's words outrank the assistant's paraphrase ─────────────
  reg.define(/^a user directive and an assistant reply restating the same words$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    w.oldId = (await w.store!.insert('ship the beacon fix before the binding wave starts', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
    })).nodeId
    w.freshId = (await w.store!.insert('Understood — I will ship the beacon fix before the binding wave starts.', {
      metadata: { source: 'auto-capture', role: 'assistant', session_id: 's1' },
    })).nodeId
  })
  reg.define(/^those words are queried under default weights$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('ship beacon fix binding wave', { topK: 5 })
  })
  reg.define(/^the user entry ranks above the assistant entry$/, (w: SearchModesWorld) => {
    const ids = w.results!.map((r) => r.nodeId)
    expect(ids).toContain(w.oldId!)
    expect(ids).toContain(w.freshId!)
    expect(ids.indexOf(w.oldId!)).toBeLessThan(ids.indexOf(w.freshId!))
  })

  // ── a zero role weight down-ranks — it never hides ──────────────────
  reg.define(/^an entry whose only query match sits in a role weighted zero$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    // The target matches ONLY through assistant text; distractors match
    // through weighted roles (user, note).
    w.freshId = (await w.store!.insert('the quorum election protocol stalls on split votes', {
      metadata: { source: 'auto-capture', role: 'assistant', session_id: 's1' },
    })).nodeId
    w.strongIds = []
    w.strongIds.push((await w.store!.insert('why does the quorum election stall here', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
    })).nodeId)
    w.strongIds.push((await w.store!.insert('Decision: quorum election stall root-caused to split votes', {
      metadata: { type: 'decision' },
    })).nodeId)
  })
  reg.define(/^the query runs with a result budget large enough to reach it$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('quorum election stall', {
      topK: 10,
      roleWeights: { assistant: 0 },
    })
  })
  reg.define(/^the entry appears, ranked below every weighted match$/, (w: SearchModesWorld) => {
    const ids = w.results!.map((r) => r.nodeId)
    expect(ids, 'weight 0 must down-rank, never hide').toContain(w.freshId!)
    for (const sid of w.strongIds!) {
      expect(ids.indexOf(sid)).toBeLessThan(ids.indexOf(w.freshId!))
    }
  })

  // ── role weights are per-query, the store is untouched ──────────────
  reg.define(/^a query that passes custom role weights$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    await w.store!.insert('cache invalidation strategy for the render layer', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
    })
    await w.store!.insert('I profiled the cache invalidation strategy in the render layer today.', {
      metadata: { source: 'auto-capture', role: 'assistant', session_id: 's1' },
    })
    await w.store!.insert('Decision: cache invalidation moves to generation counters', {
      metadata: { type: 'decision' },
    })
    w.customRanking = (await w.store!.query('cache invalidation strategy', {
      topK: 5, roleWeights: { user: 0.1, assistant: 5, note: 0.1 },
    })).map((r) => r.nodeId)
  })
  reg.define(/^a second query runs with no weights specified$/, async (w: SearchModesWorld) => {
    w.baseline = (await w.store!.query('cache invalidation strategy', { topK: 5 })).map((r) => r.nodeId)
  })
  reg.define(/^the second query's ranking follows the default weights$/, async (w: SearchModesWorld) => {
    // A separate identically-seeded store queried only with defaults gives
    // the reference default ranking — sticky weight state would diverge.
    const refDir = mkdtempSync(join(tmpdir(), 'tc-rw-ref-'))
    const ref = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(refDir, 'ref.db'))),
      ownsDatabase: true,
    })
    try {
      await ref.insert('cache invalidation strategy for the render layer', {
        metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
      })
      await ref.insert('I profiled the cache invalidation strategy in the render layer today.', {
        metadata: { source: 'auto-capture', role: 'assistant', session_id: 's1' },
      })
      await ref.insert('Decision: cache invalidation moves to generation counters', {
        metadata: { type: 'decision' },
      })
      const refRanking = (await ref.query('cache invalidation strategy', { topK: 5 })).map((r) => r.nodeId)
      // The reference store earns its keep by providing a ranking, not a
      // count (audit run 1). Node ids are fresh UUIDs per store, so the
      // comparison rides on which seeded doc occupies each rank.
      const shape = (ids: string[], contents: Map<string, string>) =>
        ids.map((id) => {
          const c = contents.get(id) ?? ''
          if (/profiled/.test(c)) return 'assistant'
          if (/generation counters/.test(c)) return 'note'
          return 'user'
        })
      const baseContents = new Map(
        (await w.store!.query('cache invalidation strategy', { topK: 25 })).map((r) => [r.nodeId, r.content ?? '']),
      )
      const refContents = new Map(
        (await ref.query('cache invalidation strategy', { topK: 25 })).map((r) => [r.nodeId, r.content ?? '']),
      )
      expect(shape(w.baseline!, baseContents)).toEqual(shape(refRanking, refContents))
    } finally {
      ref.close()
      rmSync(refDir, { recursive: true, force: true })
    }
    // And the custom ranking genuinely differed (weights had an effect).
    expect(w.baseline).not.toEqual(w.customRanking)
  })
  reg.define(/^re-running the first query with the same custom weights reproduces its ranking$/, async (w: SearchModesWorld) => {
    const rerun = (await w.store!.query('cache invalidation strategy', {
      topK: 5, roleWeights: { user: 0.1, assistant: 5, note: 0.1 },
    })).map((r) => r.nodeId)
    expect(rerun).toEqual(w.customRanking!)
  })

  // ── adaptive: clear break ───────────────────────────────────────────
  reg.define(/^entries where a clear score break separates three strong matches from the rest$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    w.strongIds = []
    for (const t of ['first', 'second', 'third']) {
      w.strongIds.push((await w.store!.insert(`flywheel flywheel flywheel — the ${t} strong match`, {
        metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
      })).nodeId)
    }
    for (let i = 0; i < 12; i++) {
      await w.store!.insert(
        `entry ${String(i)} mentions the flywheel once inside a much longer passage about unrelated build scheduling, cache tiers, deployment windows, and review queues that dilutes the match substantially`,
        { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } },
      )
    }
  })
  reg.define(/^the query runs with adaptive result count and an anchor of five$/, async (w: SearchModesWorld) => {
    await mcpOver(w)
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'flywheel', top_k: 5, adaptive: true },
    }))
  })
  reg.define(/^exactly the three strong matches return$/, (w: SearchModesWorld) => {
    const results = w.mcpResponse!['results'] as Array<{ nodeId: string }>
    expect(results.map((r) => r.nodeId).sort()).toEqual([...w.strongIds!].sort())
  })
  reg.define(/^the response discloses the adaptive count and a confidence signal$/, (w: SearchModesWorld) => {
    const meta = w.mcpResponse!['_adaptive'] as { returnedK: number; confidence: number; flat: boolean }
    expect(meta.returnedK).toBe(3)
    expect(meta.confidence).toBeGreaterThan(0)
    expect(meta.flat).toBe(false)
  })

  // ── adaptive: cap + flat honesty ────────────────────────────────────
  reg.define(/^a query whose score distribution shows no clear break$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    for (let i = 0; i < 20; i++) {
      await w.store!.insert(`turbine note ${String(i).padStart(2, '0')} carries one mention and equal weight`, {
        metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
      })
    }
  })
  reg.define(/^it runs with adaptive result count and an explicit maximum$/, async (w: SearchModesWorld) => {
    await mcpOver(w)
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'turbine', top_k: 5, adaptive: true, adaptive_max: 10 },
    }))
  })
  reg.define(/^no more than the maximum returns$/, (w: SearchModesWorld) => {
    const results = w.mcpResponse!['results'] as unknown[]
    expect(results.length).toBeLessThanOrEqual(10)
  })
  reg.define(/^the disclosed confidence says the distribution gave no clear cutoff$/, (w: SearchModesWorld) => {
    const meta = w.mcpResponse!['_adaptive'] as { returnedK: number; confidence: number; flat: boolean }
    expect(meta.flat).toBe(true)
  })

  // ── without adaptive: exactly k ─────────────────────────────────────
  reg.define(/^a store and a query matching more entries than the budget$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    for (let i = 0; i < 9; i++) {
      await w.store!.insert(`gearbox observation number ${String(i)} in the maintenance log`, {
        metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
      })
    }
  })
  reg.define(/^the query runs without adaptive result count$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('gearbox', { topK: 4 })
  })
  reg.define(/^exactly the requested number of results return in relevance order$/, (w: SearchModesWorld) => {
    expect(w.results!.length).toBe(4)
    for (let i = 1; i < w.results!.length; i++) {
      expect(w.results![i - 1]!.similarity).toBeGreaterThanOrEqual(w.results![i]!.similarity)
    }
  })

  // ── recency fusion ──────────────────────────────────────────────────
  reg.define(/^two entries matching a query with equal lexical strength, one recent and one months old$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    const now = Date.now() / 1000
    w.oldId = (await w.store!.insert('the argo pipeline deploys the staging manifests nightly', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-old' }, createdAt: now - 60 * 86400,
    })).nodeId
    w.freshId = (await w.store!.insert('the argo pipeline deploys the release manifests weekly', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-new' }, createdAt: now,
    })).nodeId
  })
  reg.define(/^the query runs with recency fusion enabled$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('argo pipeline deploys manifests', { topK: 5, recencyWeight: 0.5 })
  })
  reg.define(/^the recent entry ranks above the old one$/, (w: SearchModesWorld) => {
    const ids = w.results!.map((r) => r.nodeId)
    expect(ids.indexOf(w.freshId!)).toBeLessThan(ids.indexOf(w.oldId!))
  })
  reg.define(/^an entry with decisively stronger lexical match still outranks a merely recent one$/, async (w: SearchModesWorld) => {
    const now = Date.now() / 1000
    const strongOld = (await w.store!.insert('helm rollback helm rollback helm rollback procedure', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-old' }, createdAt: now - 60 * 86400,
    })).nodeId
    const weakFresh = (await w.store!.insert('one passing mention of helm inside a long unrelated passage about review queue staffing and calendar rotation for the platform group this quarter', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's-new' }, createdAt: now,
    })).nodeId
    const ids = (await w.store!.query('helm rollback', { topK: 5, recencyWeight: 0.5 })).map((r) => r.nodeId)
    expect(ids.indexOf(strongOld)).toBeLessThan(ids.indexOf(weakFresh))
  })

  // ── adaptive + recency composed: budget with flat disclosure ────────
  reg.define(/^entries matching a query at varied lexical strength and age$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    const now = Date.now() / 1000
    for (let i = 0; i < 8; i++) {
      await w.store!.insert(
        i % 2 === 0
          ? `dynamo dynamo calibration note ${String(i)}`
          : `a passing dynamo mention inside longer prose about scheduling and review rotation, item ${String(i)}`,
        { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' }, createdAt: now - i * 86_400 },
      )
    }
  })
  reg.define(/^the query runs with adaptive result count and recency fusion together$/, async (w: SearchModesWorld) => {
    await mcpOver(w)
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'dynamo', top_k: 5, adaptive: true, recency_weight: 0.5 },
    }))
  })
  reg.define(/^no more than the anchor budget returns$/, (w: SearchModesWorld) => {
    expect((w.mcpResponse!['results'] as unknown[]).length).toBeLessThanOrEqual(5)
  })
  reg.define(/^the disclosure says the fused ordering gave no clear cutoff$/, (w: SearchModesWorld) => {
    const meta = w.mcpResponse!['_adaptive'] as { returnedK: number; confidence: number; flat: boolean }
    expect(meta.flat, 'a fused ordering has no score breaks — flat must be disclosed').toBe(true)
    expect(meta.returnedK).toBe(5) // the budget, filled — never a fabricated break below it
  })

  // ── high-DF pruning (specced 2026-07-31, adversarial review F4) ─────
  const pruneMeta = (i: number) => ({ source: 'auto-capture', role: 'tool', session_id: 's-prune', _seq: i })
  const COMMON = 'the common filler discussion entry number'
  async function seedPruneCorpus(w: SearchModesWorld, docs: number): Promise<void> {
    await openLiveStore(w)
    for (let i = 0; i < docs; i++) {
      await w.store!.insert(`${COMMON} ${String(i)}`, { metadata: pruneMeta(i) })
    }
  }
  reg.define(/^a corpus large enough for pruning where one entry holds a rare token amid common bulk$/, async (w: SearchModesWorld) => {
    await seedPruneCorpus(w, 300) // ≥256: pruning is live, every COMMON token df≈1.0
    w.nodeId = (
      await w.store!.insert(`${COMMON} finale, also naming zebrafinch9912 exactly once`, { metadata: pruneMeta(300) })
    ).nodeId
  })
  reg.define(/^a query mixes near-universal tokens with the rare token$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('the common filler zebrafinch9912', { topK: 5 })
  })
  reg.define(/^the rare entry is found exactly as if nothing were pruned$/, (w: SearchModesWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId!)
  })
  reg.define(/^a corpus large enough for pruning where every token of a query is near-universal$/, async (w: SearchModesWorld) => {
    await seedPruneCorpus(w, 300)
  })
  reg.define(/^that query runs$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('the common filler', { topK: 5 })
  })
  reg.define(/^entries still match, exactly as if nothing were pruned$/, (w: SearchModesWorld) => {
    // Saturating topK is the control (audit run 1): every one of the 300
    // seeded entries matches, so a fallback that silently dropped tokens
    // shows up as a thinner page, not just an empty one.
    expect(w.results!.length).toBe(5)
  })
  reg.define(/^a corpus below the pruning floor where every entry shares the query's common tokens$/, async (w: SearchModesWorld) => {
    await seedPruneCorpus(w, 20)
  })
  reg.define(/^a query of those common tokens runs$/, async (w: SearchModesWorld) => {
    w.results = await w.store!.query('the common filler', { topK: 5 })
  })
  reg.define(/^entries match with no pruning in play$/, (w: SearchModesWorld) => {
    // Saturating topK (audit run 1): all 20 below-floor entries match.
    expect(w.results!.length).toBe(5)
  })

  // ── the served recency default's two carve-outs ─────────────────────
  //
  // Same corpus shape as the library-parity control: one old entry with
  // decisively stronger lexical match, 19 fresh weak matches — enough
  // candidates that fusion at 0.5 not only reorders the top-5 but
  // replaces its MEMBERSHIP (measured: fused page = the five newest,
  // strongest match gone). Both carve-outs assert against that cliff.
  reg.define(/^a corpus the served recency default demonstrably reorders$/, async (w: SearchModesWorld) => {
    await openLiveStore(w)
    const now = Date.now() / 1000
    w.oldId = (await w.store!.insert('alpha decision: drain valve drain valve drain valve ordering', {
      createdAt: now - 90 * 86400,
    })).nodeId
    w.nodeIds = [w.oldId]
    for (let i = 0; i < 19; i++) {
      w.nodeIds.push((await w.store!.insert(`fresh note ${i}: the drain valve came up in passing today`, {
        createdAt: now - 3600 + i * 60, // distinct capture times, newest last
      })).nodeId)
    }
    const client = await mcpOver(w)
    // Discriminating control: the served default must actually reshape
    // this corpus's page, or the carve-out assertions prove nothing.
    w.baseline = (await w.store!.query('drain valve', { topK: 5 })).map((r) => r.nodeId)
    const fused = parseTool(await client.callTool({
      name: 'treecontext_query', arguments: { query: 'drain valve', top_k: 5 },
    }))
    const fusedIds = (fused['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(fusedIds, 'the corpus must discriminate: the served default reorders it').not.toEqual(w.baseline)
  })

  reg.define(/^an adaptive query runs with no recency weight given$/, async (w: SearchModesWorld) => {
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_query', arguments: { query: 'drain valve', top_k: 5, adaptive: true },
    }))
  })

  reg.define(/^its ordering is the pure lexical one, not the fused one$/, (w: SearchModesWorld) => {
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(ids.length).toBeGreaterThan(0)
    // Adaptive may cut anywhere; wherever it cuts, the list must be a
    // prefix of the un-fused lexical ordering — old strong match first.
    expect(ids, 'adaptive must serve the un-fused lexical ordering').toEqual(w.baseline!.slice(0, ids.length))
  })

  reg.define(/^the query runs sorted chronologically with no recency weight given$/, async (w: SearchModesWorld) => {
    w.mcpResponse = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'drain valve', top_k: 5, sort_by: 'chronological' },
    }))
  })

  reg.define(/^the listing holds the strongest lexical matches, oldest first$/, (w: SearchModesWorld) => {
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    // The un-fused relevance page, time-sorted — DERIVED from the
    // captured library baseline, never hard-coded: the 19 fresh notes'
    // BM25 scores are bit-identical, and which four survive the top-5 is
    // FTS5's unspecified tie order (de facto rowid today; an SQLite
    // upgrade may pick a different tied subset without anything being
    // wrong). The contract is membership + chronology, not the
    // tie-break (review of E chunk 3). Baseline is library-side and the
    // served page is server-side, so a leaked server default (fused page
    // = the five newest, strongest match gone) still diverges.
    expect(w.baseline, 'fixture regressed: the strong old match fell off the un-fused page')
      .toContain(w.oldId!)
    const expected = [...w.baseline!].sort((a, b) => w.nodeIds!.indexOf(a) - w.nodeIds!.indexOf(b))
    expect(ids, 'a leaked default replaces this page wholesale').toEqual(expected)
  })

  reg.define(/^it is identical to the same listing with fusion explicitly declined$/, async (w: SearchModesWorld) => {
    const optOut = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'drain valve', top_k: 5, sort_by: 'chronological', recency_weight: 0 },
    }))
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect((optOut['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId),
      'no knob and explicit opt-out must serve the identical listing').toEqual(ids)
  })

  // "a present embedding model changes nothing until asked" moved to the
  // wip register 2026-07-31: its Given ("an ONNX model is installed and
  // reachable") is unestablishable — no code in this build reads a model
  // path, so the old binding wrote 64 random bytes to a tree-era location
  // nothing consults and asserted a tautology. It re-binds alongside the
  // dense-fusion opt-in, whose real activation path the Given must name.
}

