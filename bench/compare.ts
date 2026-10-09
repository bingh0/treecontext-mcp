#!/usr/bin/env node
/**
 * Retriever A/B, paired.
 *
 * `bench` watches one retriever drift over time. `compare` puts two
 * retrievers on the SAME queries and asks whether one is actually better —
 * which is a different statistical question and needs a different test.
 * See bench/lib/paired.ts for why the pairing matters so much here.
 *
 *   npm run bench:compare -- --arm code-fixture --b static
 *   npm run bench:compare -- --arm code-fixture --b onnx --fused
 *   npm run bench:compare -- --arm code-fixture --b static --role-fused
 *
 * Baseline (A) is always bm25 — the shipping path. `--fused` compares
 * against RRF(bm25, dense) rather than dense alone, which is the shape the
 * fence prescribes if dense ever earns a seat.
 *
 * Exits 0 always: this reports, it does not gate.
 */
import { findArm } from './arms/index.js'
import { recallAtK, type Relevance } from './lib/metrics.js'
import { pairedCompare } from './lib/paired.js'
import { Bm25Retriever, DenseRetriever, FusedRetriever, RoleConditionalFusedRetriever, type Retriever } from './lib/retrievers.js'
import type { Embedder } from './embedders/types.js'

const K = 5

async function loadEmbedder(kind: string): Promise<Embedder> {
  if (kind === 'static') {
    const { StaticEmbedder } = await import('./embedders/static.js')
    return StaticEmbedder.load()
  }
  if (kind === 'onnx') {
    const { OnnxInt8Embedder } = await import('./embedders/onnx.js')
    return OnnxInt8Embedder.load()
  }
  throw new Error(`unknown embedder: ${kind} (expected "static" or "onnx")`)
}

function pct(x: number): string { return (x * 100).toFixed(2) + '%' }
function pp(x: number): string { return (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' }

async function scoreAll(
  retriever: Retriever,
  queries: { text: string; gold: string[]; cluster: string }[],
  group?: (docId: string) => string,
): Promise<number[]> {
  const out: number[] = []
  for (const q of queries) {
    // When documents and scoring units differ, collapse ranked documents
    // into units FIRST and then take the top K. Truncating to K documents
    // and grouping afterwards would score five states of one trajectory as
    // five candidates, which is not what recall@5 is supposed to mean.
    const depth = group ? K * 40 : K
    const ranked = await retriever.search(q.text, depth)
    let units = ranked
    if (group) {
      const seen = new Set<string>()
      units = []
      for (const id of ranked) {
        if (!id) continue
        const unit = group(id)
        if (seen.has(unit)) continue
        seen.add(unit)
        units.push(unit)
      }
    }
    const relevance: Relevance = {}
    for (const g of q.gold) relevance[g] = 1
    out.push(recallAtK(units, relevance, K))
  }
  return out
}

async function main(): Promise<void> {
  const argv = process.argv
  const armId = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1]! : 'code-fixture'
  const bKind = argv.includes('--b') ? argv[argv.indexOf('--b') + 1]! : 'static'
  const maxArg = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : undefined
  const fused = argv.includes('--fused')
  const roleFused = argv.includes('--role-fused')
  const minCos = argv.includes('--min-cos') ? Number(argv[argv.indexOf('--min-cos') + 1]) : 0.5

  const arm = findArm(armId)
  if (!arm) { console.error(`unknown arm: ${armId}`); process.exit(1) }
  if (!arm.corpus) {
    console.error(
      `arm ${armId} cannot take part in a retriever comparison: it builds a ` +
      `separate corpus per query, so there is no single index to swap.`,
    )
    process.exit(1)
  }

  const { docs, queries, group } = await arm.corpus({ max: maxArg })
  process.stderr.write(`compare: ${armId} — ${docs.length} docs, ${queries.length} queries\n`)

  const a: Retriever = new Bm25Retriever()
  const embedder = await loadEmbedder(bKind)
  const dense = new DenseRetriever(embedder)
  const b: Retriever = roleFused
    ? new RoleConditionalFusedRetriever(new Bm25Retriever(), dense, minCos)
    : fused ? new FusedRetriever(new Bm25Retriever(), dense, minCos) : dense

  process.stderr.write(`compare: indexing ${a.id}…\n`)
  await a.index(docs)
  process.stderr.write(`compare: indexing ${b.id}…\n`)
  await b.index(docs)

  const scoresA = await scoreAll(a, queries, group)
  const scoresB = await scoreAll(b, queries, group)
  const overall = pairedCompare(scoresA, scoresB)

  console.log(`\n# ${a.id} vs ${b.id} — ${armId}, recall@${K}\n`)
  console.log(`- ${a.id}: **${pct(overall.meanA)}**`)
  console.log(`- ${b.id}: **${pct(overall.meanB)}**`)
  console.log(`- difference: **${pp(overall.meanDelta)}** (paired SE ${pct(overall.se)}, ${overall.sigmas.toFixed(1)} SE) — ${overall.verdict}`)
  console.log(`- per-query: **${overall.rescued} rescued, ${overall.poisoned} poisoned**, ${overall.unchanged} unchanged (McNemar exact p = ${overall.pValue.toFixed(4)})`)
  console.log('')
  console.log(`> ${b.description}`)

  // The slice table is the point on an arm like code-fixture: a retriever
  // that wins on paraphrase and loses on identifiers has a mean near zero
  // and is telling you something important.
  const kinds = [...new Set(queries.map(q => q.cluster))]
  console.log('\n| slice | n | ' + a.id + ' | ' + b.id + ' | Δ | rescued/poisoned |')
  console.log('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const kind of kinds) {
    const idx = queries.map((q, i) => (q.cluster === kind ? i : -1)).filter(i => i >= 0)
    const sub = pairedCompare(idx.map(i => scoresA[i]!), idx.map(i => scoresB[i]!))
    console.log(
      `| ${kind} | ${sub.n} | ${pct(sub.meanA)} | ${pct(sub.meanB)} | ${pp(sub.meanDelta)} | ${sub.rescued}/${sub.poisoned} |`,
    )
  }

  await a.close()
  await b.close()
}

main().catch(err => { console.error(err); process.exit(1) })
