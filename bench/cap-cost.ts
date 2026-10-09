#!/usr/bin/env node
/**
 * Cost of an index-cap change: bytes and milliseconds, not recall.
 *
 * The cap sweep (cap-sweep.ts) measures what a cap COSTS IN RECALL. This
 * measures what removing one costs in resources, which is the other half
 * of the decision: FTS index size on disk, insert throughput, and query
 * latency, at each candidate cap over the same corpus.
 *
 * METHOD. Full text is stored in every configuration; only the indexed
 * view differs, controlled through the `_index_len` metadata marker — the
 * SAME mechanism production's tool-event pipeline uses (see
 * src/persistence/index-text.ts, EXPLICIT_INDEX_LEN_KEY). So the stored
 * content bytes are identical across configs and any size difference is
 * attributable to the FTS index, exactly as it would be in production.
 *
 * Sources:
 *   --source v2     LongMemEval-V2 states — tool-event-shaped, median 14k
 *                   chars. The realistic stand-in for captured tool output.
 *   --source lme-s  LongMemEval-S unique sessions — prose, median ~10k
 *                   chars. Upper-bound stand-in for user/assistant prose
 *                   (production entries are per-turn and shorter).
 *
 *   npm run bench:capcost -- --source v2 --caps 1500,8000,full
 *   npm run bench:capcost -- --source lme-s --caps 2000,4000,full
 *
 * Reports; never gates; writes nothing to history.jsonl.
 */
import BetterSqlite3 from 'better-sqlite3'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { EXPLICIT_INDEX_LEN_KEY } from '../src/persistence/index-text.js'
import { resolveCorpus } from './lib/corpus.js'
import { CORPUS as LME_S_CORPUS } from './arms/lme-s-questions.js'

interface Source {
  id: string
  /** Entry texts, streamed or materialized. */
  texts(max: number | undefined): AsyncGenerator<string>
  /** Query texts for the latency measurement. */
  queries(max: number | undefined): Promise<string[]>
}

const v2Source: Source = {
  id: 'longmemeval-v2 states',
  async *texts(max) {
    const dir = process.env['TREECONTEXT_LME_V2_DIR'] ?? join(homedir(), 'gitrepos', 'longmemeval-v2')
    const path = join(dir, 'trajectories.jsonl')
    if (!existsSync(path)) throw new Error(`LongMemEval-V2 not found at ${dir}`)
    const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    let loaded = 0
    for await (const line of reader) {
      if (line.trim().length === 0) continue
      if (max !== undefined && loaded >= max) break
      const traj = JSON.parse(line) as {
        states?: { action?: string | null; accessibility_tree?: string | null }[]
      }
      for (const state of traj.states ?? []) {
        const parts: string[] = []
        if (typeof state.action === 'string') parts.push(state.action)
        if (typeof state.accessibility_tree === 'string') parts.push(state.accessibility_tree)
        const text = parts.join('\n')
        if (text.trim().length > 0) yield text
      }
      loaded++
    }
    reader.close()
  },
  async queries(max) {
    const dir = process.env['TREECONTEXT_LME_V2_DIR'] ?? join(homedir(), 'gitrepos', 'longmemeval-v2')
    const path = join(dir, 'trajectories.jsonl')
    const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    const out: string[] = []
    let loaded = 0
    for await (const line of reader) {
      if (line.trim().length === 0) continue
      if (max !== undefined && loaded >= max) break
      const traj = JSON.parse(line) as { goal?: string }
      if (traj.goal && traj.goal.trim().length > 0) out.push(traj.goal)
      loaded++
    }
    reader.close()
    return out
  },
}

const lmeSSource: Source = {
  id: 'longmemeval-s unique sessions',
  async *texts(max) {
    const provenance = await resolveCorpus(LME_S_CORPUS)
    const { readFile } = await import('node:fs/promises')
    const parsed = JSON.parse(await readFile(provenance.path, 'utf8')) as {
      haystack_session_ids: string[]
      haystack_sessions: { role: string; content: string }[][]
    }[]
    const limited = max !== undefined ? parsed.slice(0, max) : parsed
    const seen = new Set<string>()
    for (const inst of limited) {
      for (let i = 0; i < inst.haystack_session_ids.length; i++) {
        const sid = inst.haystack_session_ids[i]!
        if (seen.has(sid)) continue
        seen.add(sid)
        yield inst.haystack_sessions[i]!.map(t => `${t.role}: ${t.content}`).join('\n')
      }
    }
  },
  async queries(max) {
    const provenance = await resolveCorpus(LME_S_CORPUS)
    const { readFile } = await import('node:fs/promises')
    const parsed = JSON.parse(await readFile(provenance.path, 'utf8')) as { question: string }[]
    return (max !== undefined ? parsed.slice(0, max) : parsed).map(p => p.question)
  },
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

function mb(bytes: number): string { return (bytes / 1024 / 1024).toFixed(1) + ' MB' }

interface ConfigResult {
  label: string
  inserts: number
  indexedChars: number
  storedChars: number
  insertS: number
  dbBytes: number
  queryMs: { mean: number; p50: number; p95: number; n: number }
}

async function measure(
  source: Source,
  cap: number | 'full',
  max: number | undefined,
  queryCount: number,
): Promise<ConfigResult> {
  const scratch = join(tmpdir(), `tc-capcost-${process.pid}-${cap}`)
  mkdirSync(scratch, { recursive: true })
  const dbPath = join(scratch, 'store.db')
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
    maxSessions: Number.MAX_SAFE_INTEGER,
    maxAutoEntries: Number.MAX_SAFE_INTEGER,
    retentionInterval: Number.MAX_SAFE_INTEGER,
  })

  let inserts = 0
  let indexedChars = 0
  let storedChars = 0
  const t0 = performance.now()
  for await (const text of source.texts(max)) {
    const metadata: Record<string, unknown> =
      cap === 'full' ? {} : { [EXPLICIT_INDEX_LEN_KEY]: Math.min(cap, text.length) }
    await store.insert(text, { metadata })
    inserts++
    storedChars += text.length
    indexedChars += cap === 'full' ? text.length : Math.min(cap, text.length)
    if (inserts % 5000 === 0) process.stderr.write(`  [${cap}] inserted ${inserts}\n`)
  }
  const insertS = (performance.now() - t0) / 1000

  const queries = (await source.queries(max)).slice(0, queryCount)
  const times: number[] = []
  for (const q of queries) {
    const q0 = performance.now()
    await store.query(q, { topK: 50 })
    times.push(performance.now() - q0)
  }
  times.sort((a, b) => a - b)
  const queryMs = {
    mean: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
    p50: quantile(times, 0.5),
    p95: quantile(times, 0.95),
    n: times.length,
  }

  await store.close()
  // Closing the last connection checkpoints and removes the WAL, so the
  // main file is the whole story; -wal/-shm are counted anyway in case a
  // future change keeps them alive.
  let dbBytes = statSync(dbPath).size
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) dbBytes += statSync(p).size
  }
  rmSync(scratch, { recursive: true, force: true })

  return { label: String(cap), inserts, indexedChars, storedChars, insertS, dbBytes, queryMs }
}

async function main(): Promise<void> {
  const argv = process.argv
  const sourceId = argv.includes('--source') ? argv[argv.indexOf('--source') + 1]! : 'v2'
  const maxArg = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : undefined
  const capsArg = argv.includes('--caps') ? argv[argv.indexOf('--caps') + 1]! : '1500,8000,full'
  const queryCount = argv.includes('--queries') ? Number(argv[argv.indexOf('--queries') + 1]) : 300
  const caps: (number | 'full')[] = capsArg.split(',').map(c => (c === 'full' ? 'full' : Number(c)))

  const source = sourceId === 'v2' ? v2Source : sourceId === 'lme-s' ? lmeSSource : null
  if (!source) {
    console.error(`unknown source: ${sourceId} (expected v2 | lme-s)`)
    process.exit(1)
  }

  const results: ConfigResult[] = []
  for (const cap of caps) {
    process.stderr.write(`cap-cost: ${source.id} @ cap ${cap}${maxArg ? `, max ${maxArg}` : ''}…\n`)
    results.push(await measure(source, cap, maxArg, queryCount))
  }

  const smallest = results.reduce((a, b) => (a.dbBytes <= b.dbBytes ? a : b))
  console.log(`\n# Index-cap cost — ${source.id}${maxArg ? ` (max ${maxArg})` : ''}\n`)
  console.log(
    `${smallest === results[0] ? '' : ''}Stored content is identical in every row; ` +
    `only the FTS-indexed view varies (via ${EXPLICIT_INDEX_LEN_KEY}).\n`,
  )
  console.log('| indexed view | inserts | indexed chars | insert wall | inserts/s | db size | Δ vs smallest | query mean | p50 | p95 |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of results) {
    const delta = r.dbBytes - smallest.dbBytes
    console.log(
      `| ${r.label} | ${r.inserts} | ${(r.indexedChars / 1e6).toFixed(1)}M | ${r.insertS.toFixed(1)}s | ` +
      `${Math.round(r.inserts / r.insertS)} | ${mb(r.dbBytes)} | ${delta === 0 ? '—' : '+' + mb(delta)} | ` +
      `${r.queryMs.mean.toFixed(1)}ms | ${r.queryMs.p50.toFixed(1)}ms | ${r.queryMs.p95.toFixed(1)}ms |`,
    )
  }
  const stored = results[0] ? results[0].storedChars : 0
  console.log(`\nStored text: ${(stored / 1e6).toFixed(1)}M chars across ${results[0]?.inserts ?? 0} entries (identical in every config).`)
  console.log(`Query latency measured over ${results[0]?.queryMs.n ?? 0} queries, topK 50, after all inserts.`)
}

main().catch(err => { console.error(err); process.exit(1) })
