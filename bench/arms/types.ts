import type { CorpusProvenance } from '../lib/corpus.js'
import type { Mutation } from '../mutations.js'
import type { Doc } from '../lib/retrievers.js'

/** What an arm hands back: per-query scores plus the provenance of the
 *  bytes they were computed over. Aggregation, error bars and reporting
 *  are the runner's job, so every arm gets them identically. */
export interface ArmRun {
  /** One score per query, in query order. */
  values: number[]
  /** Cluster label per query, aligned with `values`. Used for the
   *  bootstrap and for the per-slice table. */
  clusters: string[]
  corpus: CorpusProvenance
  elapsedS: number
}

export interface Arm {
  /** Stable id — the series key in bench/history.jsonl. */
  id: string
  /** Metric name, e.g. 'recall@5'. Part of the series key. */
  metric: string
  description: string
  /**
   * Bump whenever the corpus→journal mapping changes. Records with
   * different mapping versions are NOT comparable, and the report says so
   * rather than quietly plotting them together.
   */
  mappingVersion: number
  /** Human-readable statement of exactly which rows were scored. */
  sliceRule: string
  /** `mutation` deliberately corrupts the pipeline; used only by the
   *  falsification runner to prove the detector can see a defect. */
  run(opts: { max?: number | undefined; mutation?: Mutation | undefined }): Promise<ArmRun>

  /**
   * Expose the corpus and judgments so a different retriever can be swapped
   * in. Optional: an arm that builds a distinct corpus per query (as
   * lme-s-questions does) has no single index to hand over, and simply
   * cannot take part in a retriever comparison.
   */
  corpus?(opts: { max?: number | undefined }): Promise<ArmCorpus>
}

export interface ArmCorpus {
  docs: Doc[]
  queries: { text: string; gold: string[]; cluster: string }[]
  /**
   * Collapse a document id to the unit being scored, when they differ.
   * lme-v2-goals indexes one document per STATE but scores whole
   * TRAJECTORIES, so ranked states are deduped into trajectories before
   * recall is computed. Absent means documents are the scoring unit.
   */
  group?: (docId: string) => string
}
