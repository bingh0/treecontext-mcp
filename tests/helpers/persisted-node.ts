/**
 * One PersistedNode builder for the whole corpus.
 *
 * Three copies had accumulated (the fts-dual-cap and role-weighted-fts
 * definers, the persistence store tests) — each a full literal of every
 * required field, and each already drifting: two carried tree-era
 * `embedding`/`modalEmbedding` keys the interface has not had for
 * migrations, one defaulted `sourceLabel` and the others did not. A
 * builder that differs per file is a fixture that means something
 * different per file.
 *
 * Overrides win per field, exactly as the copies did: a key whose value
 * is undefined is not an override and gets the default. That is why this
 * is fifteen `??`s and not one trailing `...partial` spread — the spread
 * hands back the undefined, and `{ createdAt: undefined }` (which is what
 * a caller spreading its own optional partial produces) would then reach
 * the store as an undefined timestamp.
 */
import { randomUUID } from 'node:crypto'

import type { PersistedNode } from '../../src/persistence/store.js'

export function makePersistedNode(partial: Partial<PersistedNode> = {}): PersistedNode {
  const now = Date.now() / 1000
  return {
    nodeId: partial.nodeId ?? randomUUID(),
    treeId: partial.treeId ?? 1,
    parentId: partial.parentId ?? null,
    depth: partial.depth ?? 0,
    isLeaf: partial.isLeaf ?? true,
    content: partial.content ?? '',
    summary: partial.summary ?? '',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    summaryStale: partial.summaryStale ?? false,
    readOnly: partial.readOnly ?? false,
    decayExempt: partial.decayExempt ?? false,
    // The one optional field on PersistedNode: absent is a value here
    // (the store applies its own default), so it passes through as given.
    decayRate: partial.decayRate,
    utilityScore: partial.utilityScore ?? 0.5,
    sourceLabel: partial.sourceLabel ?? null,
    metadata: partial.metadata ?? null,
  }
}
