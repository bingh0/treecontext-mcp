#!/usr/bin/env node
/**
 * Bench runner.
 *
 * Reports. Never gates. Exit code is 0 whether the number rose, fell, or
 * fell a lot — a regression shows up as a line in the report and a record
 * in the history, not as a broken build. If that ever changes it should be
 * a deliberate decision, not a drift.
 *
 *   npm run bench                        all arms, full corpora
 *   npm run bench -- --arm lme-s-questions
 *   npm run bench -- --max 25            quick smoke over a slice
 *   npm run bench -- --no-record         print the report, write nothing
 */
import { createRequire } from 'node:module'
import BetterSqlite3 from 'better-sqlite3'
import { ARMS, findArm } from './arms/index.js'
import { advisoryFloor, clusterBootstrapSE, mean, queryBootstrapSE } from './lib/metrics.js'
import { appendRun, codeRevision, readHistory, renderReport, type RunRecord, type SliceResult } from './lib/report.js'

const require = createRequire(import.meta.url)

function parseArgs(argv: string[]): { arm?: string | undefined; max?: number | undefined; record: boolean } {
  const out: { arm?: string | undefined; max?: number | undefined; record: boolean } = { record: true }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--arm') out.arm = argv[++i]
    else if (a === '--max') out.max = Number(argv[++i])
    else if (a === '--no-record') out.record = false
    else if (a === '--help' || a === '-h') {
      console.log('usage: bench [--arm <id>] [--max <n>] [--no-record]')
      console.log(`arms: ${ARMS.map(x => x.id).join(', ')}`)
      process.exit(0)
    }
  }
  return out
}

function sliceResults(values: number[], clusters: string[], metric: string): SliceResult[] {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < values.length; i++) {
    const key = clusters[i]!
    const bucket = groups.get(key)
    if (bucket) bucket.push(values[i]!)
    else groups.set(key, [values[i]!])
  }
  return [...groups.entries()].map(([slice, xs]) => ({
    slice, metric, value: mean(xs), n: xs.length, se: queryBootstrapSE(xs),
  }))
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv)
  const selected = opts.arm ? [findArm(opts.arm)] : ARMS
  if (selected.some(a => a === undefined)) {
    console.error(`unknown arm: ${opts.arm}\narms: ${ARMS.map(a => a.id).join(', ')}`)
    process.exit(1)
  }

  const sqliteVersion = new BetterSqlite3(':memory:').prepare('select sqlite_version() v').get() as { v: string }
  const betterSqliteVersion = (require('better-sqlite3/package.json') as { version: string }).version
  const { sha, dirty } = codeRevision()
  const history = readHistory()

  for (const arm of selected as NonNullable<typeof selected[number]>[]) {
    process.stderr.write(`bench: running ${arm.id}${opts.max ? ` (max ${opts.max})` : ''}…\n`)
    const run = await arm.run({ max: opts.max })

    const value = mean(run.values)
    const se = queryBootstrapSE(run.values)
    const seCluster = clusterBootstrapSE(run.values, run.clusters)

    const record: RunRecord = {
      schema: 1,
      arm: arm.id,
      metric: arm.metric,
      value,
      n: run.values.length,
      se,
      se_cluster: seCluster,
      advisory_floor: advisoryFloor(value, se),
      slices: sliceResults(run.values, run.clusters, arm.metric),
      corpus: {
        id: run.corpus.id,
        sha256: run.corpus.sha256,
        bytes: run.corpus.bytes,
        pinned: run.corpus.pinned,
        mismatch: run.corpus.mismatch,
      },
      mapping_version: arm.mappingVersion,
      slice_rule: arm.sliceRule,
      code_sha: sha,
      code_dirty: dirty,
      better_sqlite3: betterSqliteVersion,
      sqlite: sqliteVersion.v,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      elapsed_s: run.elapsedS,
      measured_at: new Date().toISOString(),
      partial: opts.max !== undefined,
      ...(opts.max !== undefined ? { notes: `partial run: --max ${opts.max}` } : {}),
    }

    console.log(renderReport(record, history))
    console.log('')

    if (opts.record && opts.max === undefined) {
      appendRun(record)
      process.stderr.write(`bench: recorded to bench/history.jsonl\n`)
    } else if (opts.max !== undefined) {
      process.stderr.write(`bench: partial run — not recorded\n`)
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
