/**
 * Arm: curated coding sessions — the claims no public corpus can reach.
 *
 * Both LongMemEval arms are somebody else's data, which is what makes them
 * credible and also what makes them incomplete. Neither contains a file
 * path, a symbol name, a compiler error code, or a shell invocation, so
 * neither can test the reasoning that justified deleting dense retrieval:
 * that a single-author, identifier-dense corpus has ~1.7% vocabulary
 * mismatch, and therefore little for embeddings to fix.
 *
 * This arm tests exactly that, on authored data, and reports it BY QUERY
 * KIND. The slice table is the result here — not the aggregate. Lexical
 * retrieval should be strong on identifiers, paths, error codes and
 * commands, and weak on paraphrase, where the user remembers the substance
 * and none of the words. If dense retrieval ever earns a seat in this
 * product, that contrast is where the evidence will come from, and a
 * single averaged number would hide it completely.
 *
 * It also exercises role weighting, which arm A cannot: LongMemEval
 * sessions carry no role metadata, so every entry lands in one FTS column.
 * Here the fixture's roles are mapped onto the real attribution rule
 * (`src/persistence/fts-columns.ts`), so user prompts, tool events and
 * agent notes land in their own columns and the configured weights
 * actually apply.
 *
 * The fixture is fiction with a real shape — see bench/fixtures/.
 */
import BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { recallAtK, type Relevance } from '../lib/metrics.js'
import { ENTRIES, QUERIES, type FixtureEntry } from '../fixtures/code-sessions.js'
import type { CorpusProvenance } from '../lib/corpus.js'
import type { Arm, ArmCorpus, ArmRun } from './types.js'
import type { Mutation } from '../mutations.js'

/**
 * Map a fixture role onto the metadata the real attribution rule reads.
 * Getting this wrong would silently put every entry in `user_text` and
 * quietly disable the role weighting this arm exists to exercise.
 */
function metadataFor(entry: FixtureEntry): Record<string, unknown> {
  const base = { eid: entry.id, session: entry.session }
  switch (entry.role) {
    case 'user':
      return { ...base, source: 'auto-capture', role: 'user' }
    case 'assistant':
      return { ...base, source: 'auto-capture', role: 'assistant' }
    case 'tool': {
      // `tool_name` is what distinguishes a tool event from assistant prose.
      const name = /^Tool:\s*(\S+)/.exec(entry.text)?.[1] ?? 'Tool'
      return { ...base, source: 'auto-capture', role: 'assistant', tool_name: name }
    }
    case 'note':
      // Agent-authored: anything not from auto-capture lands in note_text.
      return base
  }
}

/** The fixture is the corpus, so its own content is its provenance. A
 *  changed fixture is a changed corpus and must show up as such — the hash
 *  is over the entries and judgments together, so editing either one
 *  breaks comparability with earlier runs, which is correct.
 *
 *  Reported as pinned because the corpus is version-controlled in this
 *  repository: git is the pin, and there is no upstream that could move
 *  under us. */
function fixtureProvenance(): CorpusProvenance {
  const payload = JSON.stringify({ entries: ENTRIES, queries: QUERIES })
  return {
    id: 'code-fixture',
    path: 'bench/fixtures/code-sessions.ts',
    bytes: Buffer.byteLength(payload),
    sha256: createHash('sha256').update(payload).digest('hex'),
    pinned: true,
    mismatch: false,
  }
}

export const codeFixture: Arm = {
  id: 'code-fixture',
  metric: 'recall@5',
  description:
    'Curated coding sessions: identifiers, paths, error codes, commands, and paraphrases — reported by query kind.',
  // 2: fixture expanded from 129 entries / 36 queries to 199 / 120. Records
  // from version 1 are NOT comparable — a different corpus is a different
  // measurement, and the report says so rather than plotting them together.
  mappingVersion: 2,
  sliceRule:
    'bench/fixtures/code-sessions.ts — 199 entries across 48 sessions, one entry per journal event, ' +
    'roles mapped onto the real FTS column attribution; 120 queries sliced by kind',

  /** The whole fixture as an index-once corpus, for retriever comparison. */
  async corpus(opts: { max?: number | undefined }): Promise<ArmCorpus> {
    return {
      docs: ENTRIES.map(e => ({ id: e.id, text: e.text, metadata: metadataFor(e) })),
      queries: (opts.max !== undefined ? QUERIES.slice(0, opts.max) : QUERIES).map(q => ({
        text: q.query,
        gold: q.gold,
        cluster: q.kind,
      })),
    }
  },

  async run(opts: { max?: number | undefined; mutation?: Mutation | undefined }): Promise<ArmRun> {
    const mutate: Mutation = opts.mutation ?? { id: 'identity', description: '', expect: 'no-flag' }

    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
      maxSessions: Number.MAX_SAFE_INTEGER,
      maxAutoEntries: Number.MAX_SAFE_INTEGER,
      retentionInterval: Number.MAX_SAFE_INTEGER,
    })

    const started = performance.now()
    try {
      for (const entry of ENTRIES) {
        await store.insert(mutate.onInsert ? mutate.onInsert(entry.text) : entry.text, {
          metadata: metadataFor(entry),
        })
      }

      const queries = opts.max !== undefined ? QUERIES.slice(0, opts.max) : QUERIES
      const values: number[] = []
      const clusters: string[] = []

      for (const q of queries) {
        const ctx = { cluster: q.kind }
        const text = mutate.onQuery ? mutate.onQuery(q.query, ctx) : q.query
        const hits = await store.query(text, { topK: 20 })
        const rankedRaw = hits.map(h => String((h.metadata as { eid?: string } | null)?.eid ?? ''))
        const ranked = mutate.onRanked ? mutate.onRanked(rankedRaw, ctx) : rankedRaw

        const relevance: Relevance = {}
        for (const gold of q.gold) relevance[gold] = 1

        values.push(recallAtK(ranked, relevance, 5))
        clusters.push(q.kind)
      }

      return {
        values,
        clusters,
        corpus: fixtureProvenance(),
        elapsedS: (performance.now() - started) / 1000,
      }
    } finally {
      await store.close()
    }
  },
}
