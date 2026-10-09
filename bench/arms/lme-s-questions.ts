/**
 * Arm: LongMemEval-S — question → session retrieval.
 *
 * A published benchmark with published gold labels, which is what makes it
 * worth having: `answer_session_ids` means the score is computed by string
 * comparison against the dataset's own answer key. No LLM judge, no API
 * key, no grader to disagree with.
 *
 * WHAT THIS MEASURES: given a user's question and a haystack of prior
 * chat sessions, does the journal's BM25 ranking put the session that
 * actually holds the answer in the top 5? That is treecontext's core
 * promise, evaluated on somebody else's data.
 *
 * WHAT IT DOES NOT MEASURE: the corpus is human↔assistant chat. It has no
 * tool calls, no file paths, no identifiers, no stack traces. So it cannot
 * exercise role weighting, the preview/index split, or FTS5 tokenization
 * of `flat-store.ts` and `TS2345` — the parts of the product most likely
 * to regress silently. Those need their own arm; do not read this number
 * as covering them.
 *
 * METHODOLOGY is preserved verbatim from the probe that produced the
 * historical figure (bm25 arm = 0.9151 recall@5): per-question in-memory
 * corpus, one entry per haystack session, retention disabled, query with
 * the raw question text. Changing
 * any of that makes the series incomparable — bump `mappingVersion` if you
 * ever do.
 */
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { recallAtK, type Relevance } from '../lib/metrics.js'
import { resolveCorpus, type CorpusSpec } from '../lib/corpus.js'
import type { Arm, ArmRun } from './types.js'
import type { Mutation } from '../mutations.js'

export const CORPUS: CorpusSpec = {
  id: 'longmemeval-s-cleaned',
  filename: 'longmemeval_s_cleaned.json',
  url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
  // Pinned from the first recorded run; see bench/README.md on repinning.
  sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
}

interface LongMemTurn { role: 'user' | 'assistant'; content: string }
interface LongMemInstance {
  question_id: string
  question_type: string
  question: string
  haystack_session_ids: string[]
  haystack_sessions: LongMemTurn[][]
  answer_session_ids: string[]
}

/** The dataset's own convention: `_abs` questions are unanswerable by
 *  design, so recall against them is undefined rather than zero. Excluding
 *  them is what makes this the "470 of 500" slice. */
const isAbstention = (inst: LongMemInstance): boolean => inst.question_id.endsWith('_abs')

const sessionToText = (session: LongMemTurn[]): string =>
  session.map(t => `${t.role}: ${t.content}`).join('\n')

/** Ability category — the cluster for bootstrapping, and the slice
 *  breakdown. Questions in one category share haystack construction, so
 *  their errors are correlated; resampling questions independently would
 *  understate the interval. */
function ability(questionType: string): string {
  return questionType
}

/** Only the fields scoring needs. The parsed corpus is ~1.5 GB of nested
 *  arrays; extracting this and dropping the rest is what lets the
 *  falsification runner score eight times in one process instead of
 *  exhausting the heap on the second pass. */
interface SlimQuestion {
  question: string
  cluster: string
  haystackSessionIds: string[]
  answerSessionIds: string[]
}

interface LoadedCorpus {
  questions: SlimQuestion[]
  /** Session id → its text, UNMUTATED. Mutations are applied per insert so
   *  one cache serves every run. */
  sessionText: Map<string, string>
  provenance: Awaited<ReturnType<typeof resolveCorpus>>
}

let cached: { key: string; corpus: LoadedCorpus } | null = null

async function loadCorpus(max: number | undefined): Promise<LoadedCorpus> {
  const key = String(max ?? 'all')
  if (cached?.key === key) return cached.corpus

  const provenance = await resolveCorpus(CORPUS)
  const { readFile } = await import('node:fs/promises')
  const parsed = JSON.parse(await readFile(provenance.path, 'utf8')) as LongMemInstance[]
  const limited = max !== undefined ? parsed.slice(0, max) : parsed

  const sessionText = new Map<string, string>()
  const questions: SlimQuestion[] = []
  for (const inst of limited) {
    if (isAbstention(inst)) continue
    for (let i = 0; i < inst.haystack_session_ids.length; i++) {
      const sid = inst.haystack_session_ids[i]!
      if (!sessionText.has(sid)) sessionText.set(sid, sessionToText(inst.haystack_sessions[i]!))
    }
    questions.push({
      question: inst.question,
      cluster: ability(inst.question_type),
      haystackSessionIds: inst.haystack_session_ids,
      answerSessionIds: inst.answer_session_ids,
    })
  }
  // `parsed` goes out of scope here; only the slim structures survive.

  const corpus: LoadedCorpus = { questions, sessionText, provenance }
  cached = { key, corpus }
  return corpus
}

export const lmeSQuestions: Arm = {
  id: 'lme-s-questions',
  metric: 'recall@5',
  description: 'LongMemEval-S: does the answer-bearing session rank top-5 for the user’s question?',
  mappingVersion: 1,
  sliceRule: 'LongMemEval-S, non-abstention questions only (470 of 500); one entry per haystack session, "role: content" per turn',

  async run(opts: { max?: number | undefined; mutation?: Mutation | undefined }): Promise<ArmRun> {
    const mutate: Mutation = opts.mutation ?? { id: 'identity', description: '', expect: 'no-flag' }
    const { questions, sessionText, provenance } = await loadCorpus(opts.max)

    const values: number[] = []
    const clusters: string[] = []
    const started = performance.now()

    for (const q of questions) {
      // Fresh in-memory journal per question — the haystack is per-question.
      // Retention bounds are lifted so no eviction perturbs the corpus.
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
        maxSessions: Number.MAX_SAFE_INTEGER,
        maxAutoEntries: Number.MAX_SAFE_INTEGER,
        retentionInterval: Number.MAX_SAFE_INTEGER,
      })
      for (const sid of q.haystackSessionIds) {
        const raw = sessionText.get(sid)!
        await store.insert(mutate.onInsert ? mutate.onInsert(raw) : raw, { metadata: { sid } })
      }

      const ctx = { cluster: q.cluster }
      const question = mutate.onQuery ? mutate.onQuery(q.question, ctx) : q.question
      // topK = corpus size so the full ranking comes back; recall@5 then
      // reads the top 5, mirroring the original scoring path.
      const results = await store.query(question, { topK: q.haystackSessionIds.length })
      const rankedRaw = results.map(r => String((r.metadata as { sid?: string } | null)?.sid ?? ''))
      const ranked = mutate.onRanked ? mutate.onRanked(rankedRaw, ctx) : rankedRaw

      const relevance: Relevance = {}
      for (const sid of q.answerSessionIds) relevance[sid] = 1

      values.push(recallAtK(ranked, relevance, 5))
      clusters.push(q.cluster)
      await store.close()
    }

    return {
      values,
      clusters,
      corpus: provenance,
      elapsedS: (performance.now() - started) / 1000,
    }
  },
}
