/**
 * Arm: LongMemEval-V2 — goal → trajectory (known-item retrieval).
 *
 * WHY THIS ARM EXISTS: LongMemEval-S is human↔assistant chat, and BM25
 * scores 91.5% on it — so little headroom that no plausible change is
 * distinguishable from noise. This corpus is agentic: web-agent
 * trajectories of actions and observations, structurally much closer to a
 * journal of tool events, and BM25 finds it genuinely hard. That headroom
 * is what makes it able to adjudicate a question, rather than merely
 * confirm one.
 *
 * GOLD LABELS ARE OURS, DERIVED. The published benchmark evaluates
 * answers, and carries no question→trajectory mapping (verified: no such
 * field exists in questions.jsonl or trajectories.jsonl, and haystacks are
 * shared per domain). Deriving labels by grounding the answer text failed
 * — of 30 sampled questions only 4 grounded to exactly one trajectory, and
 * all 4 were the same question type.
 *
 * What does work is known-item retrieval: a trajectory's `goal` describes
 * what the agent was doing, and the trajectory itself is then
 * unambiguously the right answer. 1,870 labels, no judge, no ambiguity —
 * and it mirrors treecontext's actual use, where an agent describes what
 * it was working on and needs the right session back. These labels are not
 * part of the published benchmark and must not be cited as such.
 *
 * TWO MAPPING DECISIONS, both load-bearing:
 *
 *  1. `thought` is EXCLUDED from the index. Measured on a 200-trajectory
 *     sample: including it lifts recall@1 from 0.465 to 0.670, because the
 *     agent restates its goal in its own prose. That measures paraphrase
 *     matching, not retrieval, and it would produce misleading evidence
 *     about role weighting. Only `action` and `accessibility_tree` — the
 *     tool-event analogues — are indexed.
 *  2. ONE ENTRY PER STATE, not per trajectory. A trajectory averages
 *     755 KB of text; indexing that as a single entry resembles nothing
 *     this product stores. One entry per state is the analogue of one
 *     captured tool call, and it puts ~40 entries per trajectory into the
 *     journal — a corpus of ~75k entries at full size.
 *
 * Retrieval is therefore state-level and scored at trajectory level: a
 * trajectory's rank is the rank of its best-placed state.
 */
import BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { recallAtK, type Relevance } from '../lib/metrics.js'
import type { CorpusProvenance } from '../lib/corpus.js'
import type { Arm, ArmCorpus, ArmRun } from './types.js'
import type { Doc } from '../lib/retrievers.js'
import type { Mutation } from '../mutations.js'

/** Pinned from the first recorded run (2026-07-28). A mismatch is surfaced
 *  in the report rather than silently absorbed — a number computed over
 *  different bytes is a different number. */
/** Per-state character cap used ONLY by the comparison corpus.
 *
 *  A 256-token window consumes roughly the first thousand characters, so
 *  2000 still gives the embedder everything it can read while halving the
 *  corpus held in memory — 48,609 states at 4000 characters exhausted a
 *  14 GB machine that already had 7 GB in use. Both retrievers see the
 *  same capped text, so the cap cannot favour either. */
const COMPARISON_TEXT_CAP = 2000

const PINNED_SHA256 = '363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6'

/** The dataset is a git-lfs checkout rather than one downloadable file, so
 *  it is located rather than fetched. Apache-2.0; see bench/NOTICE.md. */
function corpusDir(): string {
  return process.env['TREECONTEXT_LME_V2_DIR'] ?? join(homedir(), 'gitrepos', 'longmemeval-v2')
}

interface V2State {
  action?: string | null
  thought?: string | null
  accessibility_tree?: string | null
}

interface V2Trajectory {
  id: string
  domain: string
  environment: string
  goal: string
  states: V2State[]
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Indexed text for one state: the tool-event analogue. `thought` is
 *  deliberately absent — see the header. */
function stateText(state: V2State): string {
  const parts: string[] = []
  if (typeof state.action === 'string') parts.push(state.action)
  if (typeof state.accessibility_tree === 'string') parts.push(state.accessibility_tree)
  return parts.join('\n')
}

export const lmeV2Goals: Arm = {
  id: 'lme-v2-goals',
  metric: 'recall@5',
  description:
    'LongMemEval-V2 web-agent trajectories: does describing what the agent was doing retrieve the right session?',
  mappingVersion: 1,
  sliceRule:
    'LongMemEval-V2 trajectories; one entry per state, text = action + accessibility_tree ' +
    '(thought EXCLUDED — it restates the goal); query = the trajectory goal; gold = that ' +
    'trajectory (derived, not published); trajectory rank = rank of its best-placed state',

  /**
   * The corpus as one index, for retriever comparison.
   *
   * TWO DECISIONS THAT DIFFER FROM `run()`, both forced and both documented
   * because they change what the numbers mean:
   *
   *  1. State text is capped at COMPARISON_TEXT_CAP characters. An embedder
   *     with a 256-token window sees roughly the first thousand characters
   *     of a 19 KB accessibility tree no matter what we do, so the cap is
   *     not a handicap we are imposing — it is the truncation that already
   *     exists, made explicit and applied to BOTH retrievers. Giving BM25
   *     the full text and the embedder a truncated one would confound
   *     "dense vs lexical" with "truncated vs whole", which is the one
   *     comparison nobody wants.
   *  2. The full corpus is ~1.45 GB of text and cannot be materialised as
   *     an array — an earlier version of this bench exhausted the heap
   *     doing less. The cap is what makes an in-memory corpus possible at
   *     all; `max` bounds it further.
   *
   * So absolute numbers here are NOT the recorded 65.29% baseline, and are
   * not comparable to it. What is comparable is the paired difference
   * between two retrievers over the same capped documents.
   */
  async corpus(opts: { max?: number | undefined }): Promise<ArmCorpus> {
    const dir = corpusDir()
    const trajectoriesPath = join(dir, 'trajectories.jsonl')
    const docs: Doc[] = []
    const queries: { text: string; gold: string[]; cluster: string }[] = []

    const reader = createInterface({
      input: createReadStream(trajectoriesPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let loaded = 0
    for await (const line of reader) {
      if (line.trim().length === 0) continue
      if (opts.max !== undefined && loaded >= opts.max) break
      const traj = JSON.parse(line) as V2Trajectory
      if (!traj.goal || traj.goal.trim().length === 0) continue

      let kept = 0
      traj.states?.forEach((state, i) => {
        const text = stateText(state).slice(0, COMPARISON_TEXT_CAP)
        if (text.trim().length === 0) return
        // Role metadata matters for role-conditional retrieval: a
        // trajectory state IS a tool event (an action and its observation),
        // so it must attribute to tool_text exactly as a captured tool call
        // would. Leaving it unset would default to note_text and make the
        // whole corpus look like agent prose, which is the opposite of true.
        docs.push({
          id: `${traj.id}#${i}`,
          text,
          metadata: { tid: traj.id, source: 'auto-capture', role: 'assistant', tool_name: 'browser' },
        })
        kept++
      })
      if (kept === 0) continue
      queries.push({
        // Gold is the TRAJECTORY, not its states. Scoring collapses ranked
        // states into trajectories first (see `group` below), exactly as
        // run() does — scoring against 40 gold states instead would cap
        // recall@5 at 5/40 and measure nothing.
        text: traj.goal,
        gold: [traj.id],
        cluster: traj.environment || traj.domain,
      })
      loaded++
      if (loaded % 200 === 0) process.stderr.write(`  loaded ${loaded} trajectories\n`)
    }
    reader.close()
    return { docs, queries, group: (docId: string) => docId.split('#')[0]! }
  },

  async run(opts: { max?: number | undefined; mutation?: Mutation | undefined }): Promise<ArmRun> {
    const mutate: Mutation = opts.mutation ?? { id: 'identity', description: '', expect: 'no-flag' }
    const dir = corpusDir()
    const trajectoriesPath = join(dir, 'trajectories.jsonl')
    if (!existsSync(trajectoriesPath)) {
      throw new Error(
        `LongMemEval-V2 not found at ${dir}.\n` +
        `Clone it (Apache-2.0) from https://huggingface.co/datasets/xiaowu0162/longmemeval-v2\n` +
        `or set TREECONTEXT_LME_V2_DIR to an existing checkout.`,
      )
    }

    const observed = await sha256(trajectoriesPath)
    const provenance: CorpusProvenance = {
      id: 'longmemeval-v2-trajectories',
      path: trajectoriesPath,
      bytes: statSync(trajectoriesPath).size,
      sha256: observed,
      pinned: true,
      mismatch: observed !== PINNED_SHA256,
    }

    // File-backed: the full corpus is ~1.45 GB of text and will not sit in
    // memory. Streamed in and inserted as it is read, so neither the parsed
    // JSONL nor the text is ever held whole.
    const scratch = join(tmpdir(), `tc-bench-v2-${process.pid}`)
    mkdirSync(scratch, { recursive: true })
    const dbPath = join(scratch, 'corpus.db')
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
      maxSessions: Number.MAX_SAFE_INTEGER,
      maxAutoEntries: Number.MAX_SAFE_INTEGER,
      retentionInterval: Number.MAX_SAFE_INTEGER,
    })

    const goals: { tid: string; goal: string; cluster: string }[] = []
    const started = performance.now()

    try {
      const reader = createInterface({
        input: createReadStream(trajectoriesPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      let loaded = 0
      for await (const line of reader) {
        if (line.trim().length === 0) continue
        if (opts.max !== undefined && loaded >= opts.max) break
        const traj = JSON.parse(line) as V2Trajectory
        if (!traj.goal || traj.goal.trim().length === 0) continue

        for (const state of traj.states ?? []) {
          const text = stateText(state)
          if (text.trim().length === 0) continue
          await store.insert(mutate.onInsert ? mutate.onInsert(text) : text, {
            metadata: { tid: traj.id },
          })
        }
        goals.push({ tid: traj.id, goal: traj.goal, cluster: traj.environment || traj.domain })
        loaded++
        if (loaded % 100 === 0) process.stderr.write(`  indexed ${loaded} trajectories\n`)
      }
      reader.close()

      const values: number[] = []
      const clusters: string[] = []

      for (const { tid, goal, cluster } of goals) {
        const ctx = { cluster }
        const query = mutate.onQuery ? mutate.onQuery(goal, ctx) : goal
        // Ask for well beyond 5 states: many states can belong to one
        // trajectory, so state-level depth is not trajectory-level depth.
        const hits = await store.query(query, { topK: 200 })

        // Trajectory rank = rank of its best-placed state, deduped in order.
        const seen = new Set<string>()
        const rankedRaw: string[] = []
        for (const hit of hits) {
          const t = String((hit.metadata as { tid?: string } | null)?.tid ?? '')
          if (t.length === 0 || seen.has(t)) continue
          seen.add(t)
          rankedRaw.push(t)
        }
        const ranked = mutate.onRanked ? mutate.onRanked(rankedRaw, ctx) : rankedRaw

        const relevance: Relevance = { [tid]: 1 }
        values.push(recallAtK(ranked, relevance, 5))
        clusters.push(cluster)
      }

      return { values, clusters, corpus: provenance, elapsedS: (performance.now() - started) / 1000 }
    } finally {
      await store.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  },
}
