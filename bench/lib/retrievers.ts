/**
 * Retrievers: the things being compared.
 *
 * `bm25` is the product path — a real FlatStore, the same code a user's
 * journal runs. The dense and fused retrievers exist only here, so a
 * comparison never changes what ships.
 *
 * Fusion is reciprocal rank fusion, matching the shape the fence
 * prescribes if dense ever earns a seat: "a fused, opt-in second ranked
 * list", not a replacement for BM25.
 */
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { cosine, type Embedder } from '../embedders/types.js'

export interface Doc {
  id: string
  text: string
  /** Metadata carried into the store; drives FTS column attribution. */
  metadata?: Record<string, unknown>
}

export interface Retriever {
  id: string
  description: string
  index(docs: Doc[]): Promise<void>
  search(query: string, k: number): Promise<string[]>
  close(): Promise<void>
}

/** The product path: FlatStore's FTS5 BM25, role weights and all. */
export class Bm25Retriever implements Retriever {
  readonly id = 'bm25'
  readonly description = 'FlatStore FTS5 bm25 — the shipping retrieval path'
  private store: FlatStore | null = null

  async index(docs: Doc[]): Promise<void> {
    this.store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
      maxSessions: Number.MAX_SAFE_INTEGER,
      maxAutoEntries: Number.MAX_SAFE_INTEGER,
      retentionInterval: Number.MAX_SAFE_INTEGER,
    })
    for (const doc of docs) {
      await this.store.insert(doc.text, { metadata: { ...doc.metadata, _docId: doc.id } })
    }
  }

  async search(query: string, k: number): Promise<string[]> {
    if (!this.store) throw new Error('index() first')
    const hits = await this.store.query(query, { topK: k })
    return hits.map(h => String((h.metadata as { _docId?: string } | null)?._docId ?? ''))
  }

  async close(): Promise<void> {
    await this.store?.close()
    this.store = null
  }
}

/** Brute-force cosine over embedded documents. Exact, not approximate:
 *  an ANN index would add a recall loss that has nothing to do with the
 *  question being asked. */
export class DenseRetriever implements Retriever {
  readonly id: string
  readonly description: string
  private vectors: { id: string; vec: Float32Array }[] = []

  constructor(private embedder: Embedder) {
    this.id = `dense-${embedder.id}`
    this.description = `brute-force cosine over ${embedder.description}`
  }

  async index(docs: Doc[]): Promise<void> {
    const batch = 32
    this.vectors = []
    for (let i = 0; i < docs.length; i += batch) {
      const slice = docs.slice(i, i + batch)
      const vecs = await this.embedder.embed(slice.map(d => d.text))
      slice.forEach((doc, j) => this.vectors.push({ id: doc.id, vec: vecs[j]! }))
      if (i > 0 && i % 512 === 0) process.stderr.write(`  embedded ${i}/${docs.length}\n`)
    }
  }

  async search(query: string, k: number): Promise<string[]> {
    return (await this.searchScored(query, k)).map(v => v.id)
  }

  /** Ranked with cosine scores retained. A caller fusing this list into
   *  another needs the scores: an unfiltered dense ranking always returns
   *  k candidates whether or not any of them are relevant, and fusing that
   *  unconditionally injects noise at full weight. */
  async searchScored(query: string, k: number): Promise<{ id: string; score: number }[]> {
    const [qv] = await this.embedder.embed([query])
    return this.vectors
      .map(v => ({ id: v.id, score: cosine(qv!, v.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }

  async close(): Promise<void> {
    this.vectors = []
    await this.embedder.close()
  }
}

/**
 * Reciprocal rank fusion of two rankings.
 *
 * RRF needs no score normalization, which is what makes it safe across
 * retrievers whose scores are not comparable — BM25 is unbounded, cosine
 * is [-1, 1]. k=60 is the conventional constant.
 */
export class FusedRetriever implements Retriever {
  readonly id: string
  readonly description: string

  constructor(
    private lexical: Retriever,
    private dense: DenseRetriever,
    /** Minimum cosine for a dense candidate to be fused. 0 fuses the whole
     *  dense ranking, which is what a naive RRF does — and what let an
     *  irrelevant dense list crowd out correct lexical hits. */
    private minCosine = 0,
    private rrfK = 60,
  ) {
    this.id = minCosine > 0 ? `fused-${lexical.id}+${dense.id}@${minCosine}` : `fused-${lexical.id}+${dense.id}`
    this.description =
      `reciprocal rank fusion (k=${rrfK}) of ${lexical.id} and ${dense.id}` +
      (minCosine > 0 ? `, dense candidates below cosine ${minCosine} discarded` : '')
  }

  async index(docs: Doc[]): Promise<void> {
    await this.lexical.index(docs)
    await this.dense.index(docs)
  }

  async search(query: string, k: number): Promise<string[]> {
    // Fuse over a deeper pool than k: a document that ranks 30th in both
    // lists can legitimately fuse into the top 5, and truncating first
    // would hide exactly the rescues fusion is supposed to provide.
    const depth = Math.max(k * 4, 50)
    const [a, scored] = await Promise.all([
      this.lexical.search(query, depth),
      this.dense.searchScored(query, depth),
    ])
    const b = scored.filter(s => s.score >= this.minCosine).map(s => s.id)

    const scores = new Map<string, number>()
    const add = (ranked: string[]): void => {
      ranked.forEach((id, i) => {
        if (!id) return
        scores.set(id, (scores.get(id) ?? 0) + 1 / (this.rrfK + i + 1))
      })
    }
    add(a)
    add(b)

    return [...scores.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, k)
      .map(([id]) => id)
  }

  async close(): Promise<void> {
    await this.lexical.close()
    await this.dense.close()
  }
}

/**
 * Fusion restricted to prose.
 *
 * The two arms of this bench disagree, and they disagree along a line the
 * product already draws. Dense retrieval helped on the coding fixture
 * (paraphrase +10pp, error +14pp) and lost decisively on web-agent
 * trajectories (-14.87pp at 13.8 SE). The difference is not the corpus's
 * subject matter — it is whether the text is PROSE or TOOL OUTPUT.
 * Mean-pooling washes out the exact tokens that identify a DOM dump, while
 * costing nothing on a sentence someone wrote.
 *
 * treecontext already attributes every entry to an FTS column by role, so
 * this reuses `attributeColumn` — the SHIPPING rule, not a bench copy — to
 * decide what the embedder is allowed to see: agent notes and user
 * messages, never tool events.
 *
 * The lexical arm still indexes everything, so nothing becomes
 * unreachable; the dense arm only ever adds prose candidates to a ranking
 * BM25 produced. On a corpus that is entirely tool output this reduces to
 * plain BM25 and cannot do harm — which is the property that makes it
 * worth testing at all.
 */
export class RoleConditionalFusedRetriever implements Retriever {
  readonly id: string
  readonly description: string
  private prose = 0
  private skipped = 0

  constructor(
    private lexical: Retriever,
    private dense: DenseRetriever,
    /**
     * Minimum cosine a dense candidate must reach to be fused at all.
     *
     * Without this the first version of this retriever destroyed the
     * lexical slices — `command` fell from 100% to 31.25% — because the
     * dense arm returns a full ranking for EVERY query, and RRF cannot
     * tell "my best match, which is excellent" from "my best match, which
     * is irrelevant". Ranking a prose subcorpus that cannot contain the
     * answer to `npm run soak --writers 8`, it still contributed fifty
     * confident-looking candidates that crowded out BM25's correct hits.
     *
     * The floor makes the dense arm abstain instead. It is a
     * hyperparameter, so results are reported across a sweep rather than
     * at whichever value flatters the outcome.
     */
    private minCosine = 0.5,
    private rrfK = 60,
  ) {
    this.id = `role-fused-${lexical.id}+${dense.id}@${minCosine}`
    this.description =
      `RRF(k=${rrfK}) of ${lexical.id} over everything and ${dense.id} over PROSE ONLY ` +
      `(note/user columns), dense candidates below cosine ${minCosine} discarded`
  }

  async index(docs: Doc[]): Promise<void> {
    const { attributeColumn } = await import('../../src/persistence/fts-columns.js')
    const proseDocs = docs.filter(d => {
      const col = attributeColumn(d.metadata ?? null)
      return col === 'note_text' || col === 'user_text'
    })
    this.prose = proseDocs.length
    this.skipped = docs.length - proseDocs.length
    process.stderr.write(
      `  role-conditional: embedding ${this.prose} prose docs, skipping ${this.skipped} tool docs\n`,
    )
    await this.lexical.index(docs)
    await this.dense.index(proseDocs)
  }

  async search(query: string, k: number): Promise<string[]> {
    const depth = Math.max(k * 4, 50)
    const [lex, scored] = await Promise.all([
      this.lexical.search(query, depth),
      this.prose > 0
        ? this.dense.searchScored(query, depth)
        : Promise.resolve([] as { id: string; score: number }[]),
    ])
    const den = scored.filter(s => s.score >= this.minCosine).map(s => s.id)

    const scores = new Map<string, number>()
    const add = (ranked: string[]): void => {
      ranked.forEach((id, i) => {
        if (!id) return
        scores.set(id, (scores.get(id) ?? 0) + 1 / (this.rrfK + i + 1))
      })
    }
    add(lex)
    add(den)
    return [...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([id]) => id)
  }

  async close(): Promise<void> {
    await this.lexical.close()
    await this.dense.close()
  }
}
