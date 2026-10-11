#!/usr/bin/env node
/**
 * Role-weight sweep: what does the tool column's weight do to recall on a
 * mature journal? (D260 chose 0.25 for captured tool output, "the one
 * value ever measured", and named the mature-store arm as the instrument
 * that may move it.)
 *
 * METHOD. The mature-journal arm's query set is re-run once per candidate
 * weight for ONE role (`--role`, default `tool`), every other weight at
 * its default, through the same `role_weights` override the query tool
 * takes. Retrieval is deterministic and the query order fixed, so each
 * weight is PAIRED per query against the reference weight (default the
 * shipped value, 0.1 since D272), as cap-sweep.ts pairs caps against the full index.
 * Reported per slice: MRR@5, recall@5, and the paired MRR delta with its
 * query-bootstrap SE. For the orientation slice it also lists the kind of
 * the first result per query at each weight (curated / developer /
 * assistant / shell / echo).
 *
 *   npm run bench:weights -- --arm mature-journal
 *   npm run bench:weights -- --arm mature-journal --weights 1,0.5,0.25,0.1,0 --role tool
 *   npm run bench:weights -- --arm mature-journal --recency 0   # pure lexical, for contrast
 *
 * Only the mature-journal arm carries tool rows, curated notes and echoes
 * in a realistic ratio; no other arm is accepted. Reports; never gates.
 * Writes nothing to history.jsonl: a re-weighted query is a different
 * mapping, not a new datapoint on the arm's series.
 */
import { pairedCompare } from './lib/paired.js'
import { sigmasCell } from './lib/report.js'
import { scoreMatureJournal, type MatureScore } from './arms/mature-journal.js'
import type { RoleWeights } from '../src/core/types.js'
import { DEFAULT_ROLE_WEIGHTS } from '../src/persistence/fts.js'

const DEFAULT_WEIGHTS = [1.0, 0.5, 0.25, 0.1, 0]
const ROLES = ['user', 'assistant', 'tool', 'note'] as const
type Role = typeof ROLES[number]

function pct(x: number): string { return (x * 100).toFixed(2) + '%' }
function pp(x: number): string { return (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' }
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

async function main(): Promise<void> {
  const argv = process.argv
  const arg = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const armId = arg('--arm') ?? 'mature-journal'
  if (armId !== 'mature-journal') {
    console.error(`weight-sweep: only the mature-journal arm carries tool rows, notes and echoes in a realistic ratio (got ${armId})`)
    process.exit(1)
  }
  const role = (arg('--role') ?? 'tool') as Role
  if (!ROLES.includes(role)) {
    console.error(`unknown role: ${role} (expected ${ROLES.join(' | ')})`)
    process.exit(1)
  }
  const reference = Number(arg('--reference') ?? DEFAULT_ROLE_WEIGHTS[role])
  const weights = (arg('--weights') ? arg('--weights')!.split(',').map(Number) : DEFAULT_WEIGHTS)
    .filter(w => Number.isFinite(w) && w >= 0)
  if (!weights.includes(reference)) weights.push(reference)
  weights.sort((a, b) => b - a)
  const max = arg('--max') !== undefined ? Number(arg('--max')) : undefined
  const recencyWeight = arg('--recency') !== undefined ? Number(arg('--recency')) : undefined

  const runs = new Map<number, MatureScore>()
  for (const w of weights) {
    process.stderr.write(`weight-sweep: ${role} = ${w}…\n`)
    const roleWeights: RoleWeights = { [role]: w }
    runs.set(w, await scoreMatureJournal({ max, roleWeights, recencyWeight }))
  }
  const ref = runs.get(reference)!
  const slices = ['all', ...new Set(ref.clusters)]

  console.log(`\n# Role-weight sweep — mature-journal, ${role} weight, n=${ref.rr.length}\n`)
  console.log(
    `Other weights at default (${ROLES.filter(r => r !== role).map(r => `${r} ${DEFAULT_ROLE_WEIGHTS[r]}`).join(', ')}); ` +
    `${recencyWeight === undefined ? 'served recency fusion' : `recency weight ${recencyWeight}`}. Paired per query against ${role} = ${reference}; positive Δ favours the row's weight.\n`,
  )
  console.log(`| slice | n | ${role} | MRR@5 | recall@5 | Δ MRR vs ${reference} | paired SE | SE units | hurt/helped | McNemar p |`)
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const slice of slices) {
    const idx = ref.clusters.map((c, i) => (slice === 'all' || c === slice ? i : -1)).filter(i => i >= 0)
    for (const w of weights) {
      const run = runs.get(w)!
      const rr = idx.map(i => run.rr[i]!)
      const rec = idx.map(i => run.recall[i]!)
      const base = idx.map(i => ref.rr[i]!)
      const cmp = pairedCompare(base, rr)
      const paired = w === reference
        ? '— | — | — | — | —'
        : `${pp(cmp.meanDelta)} | ${pct(cmp.se)} | ${sigmasCell(cmp.sigmas)} | ${cmp.poisoned}/${cmp.rescued} | ${cmp.pValue.toFixed(4)}`
      console.log(`| ${slice} | ${idx.length} | ${w} | ${pct(mean(rr))} | ${pct(mean(rec))} | ${paired} |`)
    }
  }

  const orient = ref.clusters.map((c, i) => (c === 'orientation' ? i : -1)).filter(i => i >= 0)
  if (orient.length > 0) {
    // MRR reads the gold's rank only; it is blind to shell rows crowding
    // ranks 2-5 under a gold plan at rank 1, the effect D260 was ruled on.
    // So the first five are counted by kind as well.
    const shells = (run: MatureScore, i: number): number => run.topKinds[i]!.filter(k => k === 'shell').length
    console.log(`\n## Orientation: first result's kind, and shell rows in the first five, per query\n`)
    console.log(`| query | ${weights.map(w => `${role} ${w}`).join(' | ')} |`)
    console.log(`| --- | ${weights.map(() => '---').join(' | ')} |`)
    for (const i of orient) {
      const cells = weights.map(w => {
        const run = runs.get(w)!
        return `${run.firstKind[i]}${run.rr[i] === 1 ? ' (gold)' : ''}, ${shells(run, i)} shell`
      })
      console.log(`| ${ref.queries[i]!.text} | ${cells.join(' | ')} |`)
    }
    const totals = weights.map(w => orient.reduce((n, i) => n + shells(runs.get(w)!, i), 0))
    console.log(`| **shell rows in the first five, all ${orient.length} queries** | ${totals.map(t => `**${t}** of ${orient.length * 5}`).join(' | ')} |`)
  }
  console.log(
    `\n> Reports; never gates. A weight the evidence argues for is a dated clarification ` +
    `of D260 for the owner, never a change to DEFAULT_ROLE_WEIGHTS made here.`,
  )
}

main().catch(err => { console.error(err); process.exit(1) })
