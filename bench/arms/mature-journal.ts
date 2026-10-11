/**
 * Arm: the mature journal — the capture-path arm (D266).
 *
 * Every other arm inserts straight into FlatStore. This one builds its
 * corpus the way a developer's journal is really made: real Claude Code
 * hook payloads through the real hook subprocesses into staging, the
 * production drain into the journal, the agent's curated notes and the
 * echoes of its own treecontext calls through the real MCP server. So it
 * is the first arm that can see a capture-side regression (the hook's
 * composition, the drain's stamps, the index boundaries and the echo
 * rule), and the one arm with tool rows, curated notes and echoes in a
 * realistic ratio, which is what a tool weight needs (D260).
 *
 * The corpus is bench/fixtures/mature-journal/ (seeded, deterministic,
 * shared with the charter suite's journal-recall scenarios). Queries run
 * through `store.query` at the SERVED defaults, mirroring what the MCP
 * query tool does for a call that names no recency: recency fusion at
 * DEFAULT_RECENCY_WEIGHT, default role weights. The scored list is the
 * first five; the served top_k default is 3, and fusion's candidate pool
 * is 50 at either, so the first three here are what the tool returns.
 * The conversation window the tool attaches is left off: it decorates
 * hits and never reorders them.
 *
 * Metric: reciprocal rank at 5. The corpus is small (360 rows) and many
 * queries have one gold row; README: recall@5 measures retrieval, not
 * ranking, once the candidate list is short, and this arm exists to read
 * ranking. The runner carries one metric per arm, so recall@5 is reported
 * by the weight sweep (bench/weight-sweep.ts), not here.
 */
import { createHash } from 'node:crypto'
import { copyFileSync } from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { FlatStore } from '../../src/flat-store.js'
import { DEFAULT_RECENCY_WEIGHT } from '../../src/server/query-telemetry.js'
import { DEFAULT_ROLE_WEIGHTS } from '../../src/persistence/fts.js'
import type { RoleWeights } from '../../src/core/types.js'
import { recallAtK, reciprocalRank, type Relevance } from '../lib/metrics.js'
import {
  MATURE,
  buildMatureJournal, checkShellOrdering, matureQueries, matureTemplate, scratchFile, type MatureJournal, type MatureQuery,
} from '../fixtures/mature-journal/index.js'
import type { CorpusProvenance } from '../lib/corpus.js'
import type { Arm, ArmCorpus, ArmRun } from './types.js'
import type { Mutation } from '../mutations.js'

/** What kind of row a result is, for the orientation slice's first hit. */
export type ResultKind = 'curated' | 'developer' | 'assistant' | 'shell' | 'echo' | 'none'

export function resultKind(meta: Record<string, unknown> | null): ResultKind {
  if (!meta || meta['source'] !== 'auto-capture') return 'curated'
  const tool = meta['tool_name']
  if (typeof tool === 'string') return tool.startsWith('mcp__treecontext__') ? 'echo' : 'shell'
  return meta['role'] === 'user' ? 'developer' : 'assistant'
}

export interface MatureScore {
  /** Reciprocal rank at 5, per query. */
  rr: number[]
  /** Recall at 5, per query. */
  recall: number[]
  clusters: string[]
  /** Kind of the first result, per query. */
  firstKind: ResultKind[]
  /** Kinds of the first five results, per query. */
  topKinds: ResultKind[][]
  queries: MatureQuery[]
  /** Node ids of the first five, per query, as scored. */
  ranked: string[][]
  /** Node ids from a second, deeper query (`depth` results), per query;
   *  empty unless `depth` > 5. A separate call because the fusion pool
   *  widens with top_k (max(4 x top_k, 50)), so a deep list is not the
   *  scored list extended. */
  deepRanked: string[][]
  /** The build the queries ran on (its logical keys and node ids). */
  journal: MatureJournal
  /** Seconds spent building the journal in this call (0 when cached). */
  buildS: number
  /** Seconds spent querying. */
  queryS: number
}

/** The clean build's shell-ordering sanity result. */
export let shellOrderingCheck: { first: number; of: number } | null = null

let cleanQueries: { journal: MatureJournal; file: string; queries: MatureQuery[] } | null = null

/** The clean build and its query set, once per process. */
async function clean(): Promise<{ journal: MatureJournal; file: string; queries: MatureQuery[]; buildS: number }> {
  if (cleanQueries) return { ...cleanQueries, buildS: 0 }
  const t0 = performance.now()
  const { file, journal } = await matureTemplate()
  const queries = matureQueries(journal)
  // The shell-ordering slice's sanity floor: pure lexical at the default
  // role weights puts its golds first (checkShellOrdering throws below it).
  const scratch = scratchFile('tc-mature-check-')
  copyFileSync(file, scratch.file)
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(scratch.file, { readonly: true })), ownsDatabase: true, readOnly: true,
  })
  try {
    const check = await checkShellOrdering(journal, queries, async (text) => (await store.query(text, { topK: 5, recencyWeight: 0 }))[0]?.nodeId)
    shellOrderingCheck = check
    process.stderr.write(`mature-journal: shell-ordering gold first under pure lexical on ${check.first} of ${check.of}\n`)
  } finally {
    await store.close()
    scratch.remove()
  }
  cleanQueries = { journal, file, queries }
  return { ...cleanQueries, buildS: (performance.now() - t0) / 1000 }
}

/**
 * Score the query set. The clean journal is built once per process; a
 * mutation with `onInsert` gets its own build, its texts passed through
 * the mutation on their way into the pipeline. `roleWeights` overrides
 * the defaults per query, as the tool's `role_weights` does (the sweep).
 */
export async function scoreMatureJournal(opts: {
  max?: number | undefined
  mutation?: Mutation | undefined
  roleWeights?: RoleWeights | undefined
  /** Defaults to the served DEFAULT_RECENCY_WEIGHT; 0 is pure lexical. */
  recencyWeight?: number | undefined
  /** How deep `deepRanked` reads (default 5: no deep query). */
  depth?: number | undefined
}): Promise<MatureScore> {
  const base = await clean()
  let buildS = base.buildS
  let journal = base.journal
  let source = base.file
  let remove: (() => void) | null = null
  if (opts.mutation?.onInsert) {
    const t0 = performance.now()
    const scratch = scratchFile('tc-mature-mut-')
    remove = scratch.remove
    journal = await buildMatureJournal(scratch.file, { mutateText: opts.mutation.onInsert })
    source = scratch.file
    buildS += (performance.now() - t0) / 1000
  }
  // A private copy, opened read-only: the template is never touched.
  const scratch = scratchFile('tc-mature-run-')
  copyFileSync(source, scratch.file)
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(scratch.file, { readonly: true })),
    ownsDatabase: true,
    readOnly: true,
  })
  const t1 = performance.now()
  try {
    const queries = opts.max !== undefined ? base.queries.slice(0, opts.max) : base.queries
    const depth = opts.depth ?? 5
    const out: MatureScore = {
      rr: [], recall: [], clusters: [], firstKind: [], topKinds: [], queries, ranked: [], deepRanked: [], journal, buildS, queryS: 0,
    }
    for (const q of queries) {
      const ctx = { cluster: q.kind }
      const text = opts.mutation?.onQuery ? opts.mutation.onQuery(q.text, ctx) : q.text
      const queryOpts = {
        recencyWeight: opts.recencyWeight ?? DEFAULT_RECENCY_WEIGHT,
        ...(opts.roleWeights ? { roleWeights: opts.roleWeights } : {}),
      }
      const hits = await store.query(text, { topK: 5, ...queryOpts })
      if (depth > 5) out.deepRanked.push((await store.query(text, { topK: depth, ...queryOpts })).map(h => h.nodeId))
      const rankedRaw = hits.map(h => h.nodeId)
      out.ranked.push(rankedRaw)
      const ranked = opts.mutation?.onRanked ? opts.mutation.onRanked(rankedRaw, ctx) : rankedRaw
      const relevance: Relevance = {}
      for (const key of q.gold) {
        const id = journal.ids[key]
        if (id) relevance[id] = 1
      }
      out.rr.push(reciprocalRank(ranked, relevance, 5))
      out.recall.push(recallAtK(ranked, relevance, 5))
      out.clusters.push(q.kind)
      const first = hits.find(h => h.nodeId === ranked[0])
      out.firstKind.push(first ? resultKind(first.metadata) : 'none')
      const byId = new Map(hits.map(h => [h.nodeId, h]))
      out.topKinds.push(ranked.slice(0, 5).map(id => resultKind(byId.get(id)?.metadata ?? null)))
    }
    out.queryS = (performance.now() - t1) / 1000
    return out
  } finally {
    await store.close()
    scratch.remove()
    remove?.()
  }
}

/** The fixture is version-controlled, so what it generates is its
 *  provenance: every text the generator handed the pipeline and its kind,
 *  keyed by logical row, plus the query set (texts, slices, gold keys). A
 *  change to the shape that changes no generated text does not move it. */
function provenance(journal: MatureJournal, queries: MatureQuery[]): CorpusProvenance {
  const payload = JSON.stringify({ texts: journal.texts, kinds: journal.kinds, queries })
  return {
    id: 'mature-journal',
    path: 'bench/fixtures/mature-journal/',
    bytes: Buffer.byteLength(payload),
    sha256: createHash('sha256').update(payload).digest('hex'),
    pinned: true,
    mismatch: false,
  }
}

const SESSIONS = MATURE.sessionDays.length

export const matureJournal: Arm = {
  id: 'mature-journal',
  metric: 'mrr@5',
  description:
    'A synthesized mature journal built through the capture pipeline (hooks, staging, drain, MCP echoes): ' +
    'orientation, note, checkpoint, bookmark, shell lookups, shell ordering and developer-turn lookups at the served defaults.',
  // 2: the shell-lookup hashes are chosen from the generator's own text
  // (unique among the generated outputs, at a seeded line) instead of from
  // the index under test; the corpus mapping is unchanged, the query set is
  // not, and a version-1 record scored a different question.
  // 3: the query set gains the shell-ordering slice (twelve words found
  // only in shell outputs, gold the output where each occurs most), and
  // the corpus is captured under D270 (an object tool payload stored as
  // its text), so every line's first word is its own token; a version-2
  // record scored a different corpus and a different question set.
  // 4: the shell-ordering slice is rebuilt from each row's INDEXED text
  // (a Read indexes its preview only, so four version-3 golds were
  // unreachable), five or more matching rows per word, gold the row with
  // strictly the most occurrences that is also the densest, Bash and Grep
  // golds preferred; a version-3 record scored a different question.
  mappingVersion: 4,
  /** Counts read from the clean build once it exists (the runner reads
   *  this after `run`). */
  get sliceRule(): string {
    const c = cleanQueries?.journal.counts
    const rows = c
      ? `${c.rows} rows (${c.toolRows} captured tool rows, echoes among them, against ${c.curatedRows} curated, ` +
        `${(c.toolRows / c.curatedRows).toFixed(1)}:1; ${c.developerRows} developer and ${c.assistantRows} assistant turns)`
      : 'rows counted at build'
    return `bench/fixtures/mature-journal/ seed 0x${MATURE.seed.toString(16)}: ${SESSIONS} sessions over ` +
      `${MATURE.sessionDays.at(-1)! + 1} days, ${MATURE.turnsPerSession} turns of ${MATURE.shellEventsPerTurn} shell events each, ` +
      `${rows}, every captured row made through the real hooks and drain; ` +
      'queries built from the generator\'s own content, sliced by kind, scored at the served defaults ' +
      `(role weights user ${DEFAULT_ROLE_WEIGHTS.user}, assistant ${DEFAULT_ROLE_WEIGHTS.assistant}, tool ${DEFAULT_ROLE_WEIGHTS.tool}, ` +
      `note ${DEFAULT_ROLE_WEIGHTS.note}; recency ${DEFAULT_RECENCY_WEIGHT}; live chapters placed above bookmarks after fusion, D275)`
  },

  async corpus(opts: { max?: number | undefined }): Promise<ArmCorpus> {
    const { journal, file, queries } = await clean()
    const raw = new BetterSqlite3(file, { readonly: true })
    try {
      const rows = raw.prepare('SELECT node_id, content, metadata_json FROM nodes').all() as Array<{
        node_id: string; content: string | Buffer | null; metadata_json: string | null
      }>
      return {
        docs: rows.map(r => ({
          id: r.node_id,
          text: decodeContent(r.content),
          metadata: JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>,
        })),
        queries: (opts.max !== undefined ? queries.slice(0, opts.max) : queries).map(q => ({
          text: q.text,
          gold: q.gold.map(k => journal.ids[k]!).filter(Boolean),
          cluster: q.kind,
        })),
      }
    } finally {
      raw.close()
    }
  },

  async run(opts: { max?: number | undefined; mutation?: Mutation | undefined }): Promise<ArmRun> {
    const started = performance.now()
    const s = await scoreMatureJournal(opts)
    process.stderr.write(
      `mature-journal: ${s.queries.length} queries; build ${s.buildS.toFixed(1)}s, queries ${s.queryS.toFixed(2)}s\n`,
    )
    return {
      values: s.rr,
      clusters: s.clusters,
      corpus: provenance(cleanQueries!.journal, cleanQueries!.queries),
      elapsedS: (performance.now() - started) / 1000,
    }
  },
}
