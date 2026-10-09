#!/usr/bin/env node
/**
 * Cap sweep: what does an index-prefix cap cost, per corpus?
 *
 * Production indexes a bounded PREFIX of each captured entry — the full
 * text is stored, but only `content.slice(0, cap)` is searchable
 * (INDEX_CAP_USER = 2000, INDEX_CAP_ASSISTANT = 4000, tool previews
 * 500 + 1000; see src/persistence/capture-constants.ts and
 * src/persistence/index-text.ts). The falsification suite already showed
 * truncation is the most visible defect class this bench can see
 * (`index-preview-only` at 300 chars: −22pp on lme-s), and the lme-v2
 * comparison corpus measured a 2000-char cap costing BM25 ~17pp. This
 * script turns those two point observations into a curve.
 *
 * METHOD. Each cap is the existing `onInsert` mutation seam applied as
 * `text.slice(0, cap)` — byte-for-byte the same operation the production
 * caps perform. Retrieval is deterministic and the arm's query order is
 * fixed, so per-query scores from two runs of the same arm align, and the
 * paired machinery from lib/paired.ts applies: the reported cost of a cap
 * is a PAIRED difference against the full-index baseline of the same arm
 * in the same process, not a difference of independent means.
 *
 * SPLIT MODES. `--split prefix` (default) indexes the first `cap` chars.
 * `--split head-tail` spends the same budget half on the head and half on
 * the tail — the shape that protects a question typed after a large paste.
 * `--split both` runs each cap under both modes and additionally reports
 * head-tail vs prefix PAIRED AT EQUAL BUDGET, which is the comparison that
 * decides whether smarter truncation is worth anything.
 *
 * CAVEAT ON READING THE NUMBERS. The sweep caps every entry uniformly;
 * production caps by role, and its per-EVENT entries are shorter than
 * lme-s's per-SESSION entries. So a cap's absolute cost here bounds the
 * production cost from above on lme-s (whole sessions) and approximates it
 * on lme-v2 (one state ≈ one tool event). The shape of the curve — where
 * the knee is — is the transferable finding, not the absolute pp at a
 * given cap.
 *
 *   npm run bench:capsweep                       # lme-s, default caps, prefix
 *   npm run bench:capsweep -- --arm lme-v2-goals --caps 500,1000,2000,4000,8000
 *   npm run bench:capsweep -- --arm lme-s-questions --split both --caps 1000,2000,4000,8000
 *
 * Reports; never gates. Writes nothing to history.jsonl — a capped
 * mapping is a different mapping, not a new datapoint on the same series.
 */
import { ARMS, findArm } from './arms/index.js'
import { pairedCompare } from './lib/paired.js'
import type { Mutation } from './mutations.js'
import type { ArmRun } from './arms/types.js'

const DEFAULT_CAPS = [300, 500, 1000, 2000, 4000, 8000]

type SplitMode = 'prefix' | 'head-tail'

function pct(x: number): string { return (x * 100).toFixed(2) + '%' }
function pp(x: number): string { return (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' }

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]!
}

/** The capped index view. Head-tail keeps the budget but spends it on both
 *  ends; the separator prevents the head's last token fusing with the
 *  tail's first into a word that exists in neither. */
function capText(text: string, cap: number, mode: SplitMode): string {
  if (text.length <= cap) return text
  if (mode === 'prefix') return text.slice(0, cap)
  const tail = Math.floor(cap / 2)
  const head = cap - tail
  return text.slice(0, head) + '\n…\n' + text.slice(text.length - tail)
}

async function main(): Promise<void> {
  const argv = process.argv
  const armId = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1]! : 'lme-s-questions'
  const maxArg = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : undefined
  const capsArg = argv.includes('--caps') ? argv[argv.indexOf('--caps') + 1]! : undefined
  const splitArg = argv.includes('--split') ? argv[argv.indexOf('--split') + 1]! : 'prefix'
  if (!['prefix', 'head-tail', 'both'].includes(splitArg)) {
    console.error(`unknown split: ${splitArg} (expected prefix | head-tail | both)`)
    process.exit(1)
  }
  const modes: SplitMode[] = splitArg === 'both' ? ['prefix', 'head-tail'] : [splitArg as SplitMode]
  const caps = (capsArg ? capsArg.split(',').map(Number) : DEFAULT_CAPS)
    .filter(c => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b)

  const arm = findArm(armId)
  if (!arm) {
    console.error(`unknown arm: ${armId}\narms: ${ARMS.map(a => a.id).join(', ')}`)
    process.exit(1)
  }

  // Baseline: full index. The recorder is an identity mutation that also
  // collects insert lengths, so "% of inserts a cap truncates" comes from
  // the same pass that produces the reference scores.
  const lengths: number[] = []
  const recorder: Mutation = {
    id: 'cap-full',
    description: 'identity, recording insert lengths',
    expect: 'no-flag',
    onInsert: t => { lengths.push(t.length); return t },
  }
  process.stderr.write(`cap-sweep: ${arm.id} — baseline (full index)${maxArg ? `, max ${maxArg}` : ''}…\n`)
  const base = await arm.run({ max: maxArg, mutation: recorder })
  const sortedLens = [...lengths].sort((a, b) => a - b)
  process.stderr.write(`cap-sweep: baseline ${pct(base.values.reduce((a, b) => a + b, 0) / base.values.length)} over ${base.values.length} queries\n`)

  const runs: { cap: number; mode: SplitMode; run: ArmRun }[] = []
  for (const cap of caps) {
    for (const mode of modes) {
      process.stderr.write(`cap-sweep: cap ${cap} (${mode})…\n`)
      const mutation: Mutation = {
        id: `cap-${cap}-${mode}`,
        description: `index a ${cap}-char ${mode} view of each entry`,
        expect: 'no-flag',
        onInsert: t => capText(t, cap, mode),
      }
      const run = await arm.run({ max: maxArg, mutation })
      runs.push({ cap, mode, run })
    }
  }

  const meanBase = base.values.reduce((a, b) => a + b, 0) / base.values.length

  console.log(`\n# Index-cap sweep — ${arm.id}, ${arm.metric}, n=${base.values.length}, split=${splitArg}\n`)
  console.log(
    `Entry lengths (chars, at insert): median ${quantile(sortedLens, 0.5)}, ` +
    `p90 ${quantile(sortedLens, 0.9)}, p99 ${quantile(sortedLens, 0.99)}, ` +
    `max ${sortedLens[sortedLens.length - 1] ?? 0} — ${sortedLens.length} inserts.`,
  )
  console.log(`Paired against the full index; negative Δ is what the cap costs.\n`)
  console.log('| indexed view | recall | Δ vs full | paired SE | SE units | hurt/helped | McNemar p | inserts truncated |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const { cap, mode, run } of runs) {
    const cmp = pairedCompare(base.values, run.values)
    const truncated = sortedLens.length
      ? sortedLens.filter(l => l > cap).length / sortedLens.length
      : 0
    // B is the capped run, so `poisoned` = queries the cap hurt.
    console.log(
      `| ${cap} ${mode} | ${pct(cmp.meanB)} | ${pp(cmp.meanDelta)} | ${pct(cmp.se)} | ${cmp.sigmas.toFixed(1)} | ` +
      `${cmp.poisoned}/${cmp.rescued} | ${cmp.pValue.toFixed(4)} | ${pct(truncated)} |`,
    )
  }
  console.log(`| full | ${pct(meanBase)} | — | — | — | — | — | 0.00% |`)

  // The decision table for `both`: head-tail vs prefix at the SAME budget,
  // paired query by query. This is the only comparison that can say whether
  // spending the budget differently helps — both arms against `full` cannot,
  // because their deltas share the baseline.
  if (splitArg === 'both') {
    console.log('\n## head-tail vs prefix, equal budget (positive Δ favours head-tail)\n')
    console.log('| budget | prefix | head-tail | Δ | paired SE | SE units | ht-hurt/ht-helped | McNemar p |')
    console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const cap of caps) {
      const prefix = runs.find(r => r.cap === cap && r.mode === 'prefix')!
      const headTail = runs.find(r => r.cap === cap && r.mode === 'head-tail')!
      const cmp = pairedCompare(prefix.run.values, headTail.run.values)
      console.log(
        `| ${cap} | ${pct(cmp.meanA)} | ${pct(cmp.meanB)} | ${pp(cmp.meanDelta)} | ${pct(cmp.se)} | ` +
        `${cmp.sigmas.toFixed(1)} | ${cmp.poisoned}/${cmp.rescued} | ${cmp.pValue.toFixed(4)} |`,
      )
    }
  }

  // Slice grid per mode: recall by cap for every cluster, because an
  // aggregate that holds while one slice collapses is this project's
  // recorded failure mode.
  const clusters = [...new Set(base.clusters)]
  for (const mode of modes) {
    const modeRuns = runs.filter(r => r.mode === mode)
    console.log(`\n### slices — ${mode}\n`)
    console.log('| slice | n | ' + modeRuns.map(r => String(r.cap)).join(' | ') + ' | full |')
    console.log('| --- | ---: | ' + modeRuns.map(() => '---:').join(' | ') + ' | ---: |')
    for (const cluster of clusters) {
      const idx = base.clusters.map((c, i) => (c === cluster ? i : -1)).filter(i => i >= 0)
      const cells = modeRuns.map(({ run }) => {
        const sub = idx.map(i => run.values[i]!)
        return pct(sub.reduce((a, b) => a + b, 0) / sub.length)
      })
      const baseCell = pct(idx.map(i => base.values[i]!).reduce((a, b) => a + b, 0) / idx.length)
      console.log(`| ${cluster} | ${idx.length} | ${cells.join(' | ')} | ${baseCell} |`)
    }
  }

  console.log(
    `\n> Caps sweep the same seam production uses: indexTextFor slices a prefix; ` +
    `full text is always stored. Uniform-cap costs on per-session entries (lme-s) ` +
    `upper-bound the per-event production cost; per-state entries (lme-v2) approximate it.`,
  )
}

main().catch(err => { console.error(err); process.exit(1) })
