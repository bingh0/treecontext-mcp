#!/usr/bin/env node
/**
 * Falsification: does the bench actually catch a regression?
 *
 * `npm run bench` reports and never fails. This command is the opposite —
 * it is a TEST OF THE INSTRUMENT, so it exits non-zero when the detector
 * gets an answer wrong. The distinction matters: a bench run failing would
 * mean the product regressed; a falsify run failing means the bench cannot
 * be trusted to tell us when the product regresses.
 *
 * Method: run the arm clean to establish a reference, then re-run it once
 * per mutation and ask the same detector the report uses whether it sees a
 * regression. Each mutation declares what it expects. Both directions are
 * checked — a defect must be flagged, and a harmless change must not be.
 *
 *   npm run bench:falsify
 *   npm run bench:falsify -- --max 120       # faster, still meaningful
 *   npm run bench:falsify -- --mutation rank-collapse
 */
import BetterSqlite3 from 'better-sqlite3'
import { createRequire } from 'node:module'
import { ARMS, findArm } from './arms/index.js'
import { advisoryFloor, clusterBootstrapSE, mean, queryBootstrapSE } from './lib/metrics.js'
import { compareRuns, compareSlices, type RunRecord, type SliceResult } from './lib/report.js'
import { MUTATIONS, expectationFor, findMutation, type Mutation } from './mutations.js'
import type { Arm } from './arms/types.js'

const require = createRequire(import.meta.url)

interface Outcome {
  mutation: Mutation
  value: number
  deltaPp: number
  sigmas: number
  verdict: string
  /** Worst per-slice regression that trips the same 3-SE test — this is
   *  what localizes a failure confined to one category. */
  worstSlice: { slice: string; deltaPp: number; sigmas: number; flagged: boolean } | null
  aggregateFlagged: boolean
  sliceFlagged: boolean
  /** Smallest drop this comparison could have resolved, in pp. */
  mdePp: number
  pass: boolean
}

function toRecord(
  arm: Arm,
  values: number[],
  clusters: string[],
  extra: { sqlite: string; betterSqlite3: string },
): RunRecord {
  const value = mean(values)
  const se = queryBootstrapSE(values)
  const slices = [...new Map(clusters.map(c => [c, [] as number[]])).entries()]
  for (let i = 0; i < values.length; i++) {
    slices.find(([c]) => c === clusters[i])![1].push(values[i]!)
  }
  return {
    schema: 1,
    arm: arm.id,
    metric: arm.metric,
    value,
    n: values.length,
    se,
    se_cluster: clusterBootstrapSE(values, clusters),
    advisory_floor: advisoryFloor(value, se),
    slices: slices.map(([slice, xs]) => ({
      slice, metric: arm.metric, value: mean(xs), n: xs.length, se: queryBootstrapSE(xs),
    })),
    corpus: { id: '', sha256: '', bytes: 0, pinned: true, mismatch: false },
    mapping_version: arm.mappingVersion,
    slice_rule: arm.sliceRule,
    code_sha: null,
    code_dirty: false,
    better_sqlite3: extra.betterSqlite3,
    sqlite: extra.sqlite,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    elapsed_s: 0,
    measured_at: new Date().toISOString(),
    partial: false,
  }
}

async function main(): Promise<void> {
  const argv = process.argv
  const armId = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'lme-s-questions'
  const maxArg = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : undefined
  const only = argv.includes('--mutation') ? argv[argv.indexOf('--mutation') + 1] : undefined

  const arm = findArm(armId!)
  if (!arm) {
    console.error(`unknown arm: ${armId}\narms: ${ARMS.map(a => a.id).join(', ')}`)
    process.exit(1)
  }
  const mutations = only ? [findMutation(only)].filter(Boolean) as Mutation[] : MUTATIONS
  if (mutations.length === 0) {
    console.error(`unknown mutation: ${only}\nmutations: ${MUTATIONS.map(m => m.id).join(', ')}`)
    process.exit(1)
  }

  const sqlite = (new BetterSqlite3(':memory:').prepare('select sqlite_version() v').get() as { v: string }).v
  const betterSqlite3 = (require('better-sqlite3/package.json') as { version: string }).version
  const extra = { sqlite, betterSqlite3 }

  process.stderr.write(`falsify: reference run of ${arm.id}${maxArg ? ` (max ${maxArg})` : ''}…\n`)
  const clean = await arm.run({ max: maxArg })
  const reference = toRecord(arm, clean.values, clean.clusters, extra)
  process.stderr.write(`falsify: reference ${(reference.value * 100).toFixed(2)}% (n=${reference.n}, SE ${(reference.se * 100).toFixed(2)}%)\n`)

  // The slice subgroup-collapse damages: the largest in this arm, so the
  // mutation is never inert just because a cluster name changed.
  const target = [...reference.slices].sort((a, b) => b.n - a.n)[0]?.slice
  process.stderr.write(`falsify: subgroup target = ${target ?? '(none)'}\n`)

  const outcomes: Outcome[] = []
  for (const mutation of mutations) {
    process.stderr.write(`falsify: ${mutation.id}…\n`)
    // Rebind onRanked so the subgroup target travels with the context,
    // without adding an explicit `undefined` property to the mutation.
    const scoped: Mutation = target && mutation.onRanked
      ? { ...mutation, onRanked: (r, ctx) => mutation.onRanked!(r, { ...ctx, target }) }
      : mutation
    const run = mutation.id === 'identity' ? clean : await arm.run({ max: maxArg, mutation: scoped })
    const record = toRecord(arm, run.values, run.clusters, extra)
    const cmp = compareRuns(record, reference)

    let worstSlice: Outcome['worstSlice'] = null
    let sliceFlagged = false
    for (const slice of record.slices) {
      const before = reference.slices.find((s: SliceResult) => s.slice === slice.slice)
      if (!before) continue
      const sc = compareSlices(slice, before)
      const flaggedHere = sc.verdict === 'regression'
      sliceFlagged ||= flaggedHere
      if (worstSlice === null || sc.delta * 100 < worstSlice.deltaPp) {
        worstSlice = { slice: slice.slice, deltaPp: sc.delta * 100, sigmas: sc.sigmas, flagged: flaggedHere }
      }
    }

    // `identity` is compared against itself, so the detector sees a
    // difference of exactly zero. That is the intended control: any
    // non-zero verdict here means the comparison logic is unsound.
    const aggregateFlagged = cmp.verdict === 'regression'

    // A slice flag counts for 'flag-aggregate' too: the requirement is that
    // the defect is VISIBLE, and the aggregate is only the first place we
    // look. The reverse does not hold — 'no-flag' means nothing anywhere.
    // Minimum detectable effect: the smallest drop a 3-SE rule could have
    // resolved given this run's precision.
    const mdePp = 3 * cmp.jointSe * 100

    const expect = expectationFor(mutation, arm.id)
    const pass =
      expect === 'flag-aggregate' ? aggregateFlagged
      : expect === 'flag-slice' ? sliceFlagged
      // Passing here means the defect really is below the floor, OR the
      // instrument got sharper and caught it anyway. Neither is a failure.
      : expect === 'below-sensitivity' ? (aggregateFlagged || Math.abs(cmp.delta * 100) < mdePp)
      : !aggregateFlagged && !sliceFlagged

    outcomes.push({
      mutation,
      value: record.value,
      deltaPp: cmp.delta * 100,
      sigmas: cmp.sigmas,
      verdict: cmp.verdict,
      worstSlice,
      aggregateFlagged,
      sliceFlagged,
      mdePp,
      pass,
    })
  }

  console.log(`\n# Falsification — ${arm.id}\n`)
  console.log(`Reference: **${(reference.value * 100).toFixed(2)}%** (n=${reference.n}, SE ${(reference.se * 100).toFixed(2)}%)`)
  console.log(`Detector: regression when the drop exceeds 3 SE of the difference.`)
  console.log(`Resolution: a drop smaller than ~${(3 * Math.sqrt(2) * reference.se * 100).toFixed(1)}pp cannot be distinguished at this sample size — regressions below that will pass unnoticed.\n`)
  console.log('| mutation | expect | seen | aggregate Δ | SE | worst slice |')
  console.log('| --- | --- | --- | ---: | ---: | --- |')
  for (const o of outcomes) {
    const seen = o.aggregateFlagged ? 'aggregate' : o.sliceFlagged ? 'slice only' : 'nothing'
    const worst = o.worstSlice && o.worstSlice.deltaPp < -0.005
      ? `${o.worstSlice.flagged ? '⚠️ ' : ''}${o.worstSlice.slice} ${o.worstSlice.deltaPp.toFixed(1)}pp (${o.worstSlice.sigmas.toFixed(1)} SE)`
      : '—'
    console.log(
      `| \`${o.mutation.id}\` | ${expectationFor(o.mutation, arm.id)} | ${o.pass ? '✅ ' : '❌ '}${seen} | ` +
      `${o.deltaPp >= 0 ? '+' : ''}${o.deltaPp.toFixed(2)}pp | ${o.sigmas.toFixed(1)} | ${worst} |`,
    )
  }

  console.log('')
  for (const o of outcomes) {
    console.log(`- \`${o.mutation.id}\` — ${o.mutation.description}`)
  }

  const failures = outcomes.filter(o => !o.pass)
  console.log('')
  if (failures.length === 0) {
    console.log(`✅ Detector behaved correctly on all ${outcomes.length} mutations.`)
    return
  }
  console.log(`❌ Detector got ${failures.length} of ${outcomes.length} wrong:`)
  for (const f of failures) {
    console.log(
      `   \`${f.mutation.id}\` expected ${f.mutation.expect} but the verdict was ` +
      `"${f.verdict}" (${f.deltaPp.toFixed(2)}pp, ${f.sigmas.toFixed(1)} SE)`,
    )
  }
  console.log('')
  console.log('A bench that cannot see a deliberate defect cannot be trusted to see an accidental one.')
  process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
