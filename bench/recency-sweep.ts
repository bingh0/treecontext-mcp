#!/usr/bin/env node
/**
 * Recency sweep: what does the recency fusion weight do on a mature
 * journal? (D56 ruled 0.5, the served DEFAULT_RECENCY_WEIGHT, for
 * orientation; the mature-journal arm is the first to price it on lookups,
 * and D273 lowered it to 0.25 on this sweep.)
 *
 * METHOD. The mature-journal arm's query set is re-run once per recency
 * weight, role weights at their defaults, through the same `recencyWeight`
 * the query tool takes. Retrieval is deterministic and the query order
 * fixed, so each weight is PAIRED per query against the reference (default
 * the served value, 0.25 since D273). Reported per slice: MRR@5, recall@5, the paired
 * MRR delta with its query-bootstrap SE and McNemar exact p; for the
 * orientation slice, per query, the first result's kind, the shell rows in
 * the first five, and the rank of the fresh plan (the newest live
 * checkpoint, the orientation gold): its place in the served first five,
 * else its place in a second query at top_k 50 (marked "deep"; the fusion
 * pool widens with top_k, so that list is a neighbour of the scored one,
 * not its extension).
 *
 *   npm run bench:recency
 *   npm run bench:recency -- --weights 0.5,0.35,0.25,0.1,0 --reference 0.5
 *
 * Reports; never gates. Writes nothing to history.jsonl.
 */
import { pairedCompare } from './lib/paired.js'
import { sigmasCell } from './lib/report.js'
import { scoreMatureJournal, type MatureScore } from './arms/mature-journal.js'
import { DEFAULT_RECENCY_WEIGHT } from '../src/server/query-telemetry.js'

const DEFAULT_WEIGHTS = [0.5, 0.35, 0.25, 0.1, 0]
/** How deep the fresh plan's rank is read. */
const DEPTH = 50

function pct(x: number): string { return (x * 100).toFixed(2) + '%' }
function pp(x: number): string { return (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' }
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

async function main(): Promise<void> {
  const argv = process.argv
  const arg = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const reference = Number(arg('--reference') ?? DEFAULT_RECENCY_WEIGHT)
  const weights = (arg('--weights') ? arg('--weights')!.split(',').map(Number) : DEFAULT_WEIGHTS)
    .filter(w => Number.isFinite(w) && w >= 0)
  if (!weights.includes(reference)) weights.push(reference)
  weights.sort((a, b) => b - a)
  const max = arg('--max') !== undefined ? Number(arg('--max')) : undefined

  const runs = new Map<number, MatureScore>()
  for (const w of weights) {
    process.stderr.write(`recency-sweep: recency = ${w}…\n`)
    runs.set(w, await scoreMatureJournal({ max, recencyWeight: w, depth: DEPTH }))
  }
  const ref = runs.get(reference)!
  const slices = ['all', ...new Set(ref.clusters)]

  console.log(`\n# Recency sweep — mature-journal, n=${ref.rr.length}\n`)
  console.log(`Role weights at default. Paired per query against recency = ${reference}; positive Δ favours the row's weight.\n`)
  console.log(`| slice | n | recency | MRR@5 | recall@5 | Δ MRR vs ${reference} | paired SE | SE units | hurt/helped | McNemar p |`)
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const slice of slices) {
    const idx = ref.clusters.map((c, i) => (slice === 'all' || c === slice ? i : -1)).filter(i => i >= 0)
    for (const w of weights) {
      const run = runs.get(w)!
      const rr = idx.map(i => run.rr[i]!)
      const rec = idx.map(i => run.recall[i]!)
      const cmp = pairedCompare(idx.map(i => ref.rr[i]!), rr)
      const paired = w === reference
        ? '— | — | — | — | —'
        : `${pp(cmp.meanDelta)} | ${pct(cmp.se)} | ${sigmasCell(cmp.sigmas)} | ${cmp.poisoned}/${cmp.rescued} | ${cmp.pValue.toFixed(4)}`
      console.log(`| ${slice} | ${idx.length} | ${w} | ${pct(mean(rr))} | ${pct(mean(rec))} | ${paired} |`)
    }
  }

  const orient = ref.clusters.map((c, i) => (c === 'orientation' ? i : -1)).filter(i => i >= 0)
  if (orient.length > 0) {
    const fresh = ref.journal.freshPlanId
    const shells = (run: MatureScore, i: number): number => run.topKinds[i]!.filter(k => k === 'shell').length
    const rankOf = (run: MatureScore, i: number): string => {
      const at = run.ranked[i]!.indexOf(fresh)
      if (at !== -1) return String(at + 1)
      const deep = run.deepRanked[i]!.indexOf(fresh)
      return deep === -1 ? `>${DEPTH} deep` : `${deep + 1} deep`
    }
    console.log(`\n## Orientation: first result's kind, shell rows in the first five, and the fresh plan's rank, per query\n`)
    console.log(`| query | ${weights.map(w => `recency ${w}`).join(' | ')} |`)
    console.log(`| --- | ${weights.map(() => '---').join(' | ')} |`)
    for (const i of orient) {
      const cells = weights.map(w => {
        const run = runs.get(w)!
        return `${run.firstKind[i]}${run.rr[i] === 1 ? ' (gold)' : ''}, ${shells(run, i)} shell, plan #${rankOf(run, i)}`
      })
      console.log(`| ${ref.queries[i]!.text} | ${cells.join(' | ')} |`)
    }
    const totals = weights.map(w => orient.reduce((n, i) => n + shells(runs.get(w)!, i), 0))
    console.log(`| **shell rows in the first five, all ${orient.length} queries** | ${totals.map(t => `**${t}** of ${orient.length * 5}`).join(' | ')} |`)
  }
  console.log(`\n> Reports; never gates. D56 ruled the served recency weight; a value the evidence argues for is the owner's to rule.`)
}

main().catch(err => { console.error(err); process.exit(1) })
