/**
 * MemoryStore — the backend-agnostic contract the MCP server drives.
 */
import type {
  InsertOptions,
  InsertResult,
  QueryOptions,
  QueryResult,
  TreeStatus,
} from './core/types.js'

export type { BackendMode } from './core/types.js'

/** What an import did (D164): what landed, what was already present
 *  anywhere in the store, and the rest it left alone. */
export interface ImportResult {
  /** Entries that landed. */
  importedCount: number
  label: string
  /** Entries left alone because they are already in the store: by id or
   *  back-pointer in any lane, or by content where the file had no id. */
  alreadyPresent: number
  /** Entries whose id the store already holds with DIFFERENT content:
   *  left alone, never overwritten, counted apart so divergence shows. */
  idConflicts: number
  /** Entries with no content, which cannot land. */
  skippedEmpty: number
  /** Entries that are not objects at all (null, a number, an array),
   *  which cannot land and never fail the import (D165). */
  skippedMalformed: number
  /** Handoff only: entries whose claimed session this store holds as an
   *  archived (tombstoned) session — likely an archive pasted back
   *  through the import door, which lands as a handoff (D222). */
  claimsArchivedSessions?: number
  /** A handoff import's sender, as the file claims it (null: no claim). */
  sender?: string | null
}

export interface MemoryStore {
  insert(content: string, opts?: InsertOptions): Promise<InsertResult>
  query(text: string, opts?: QueryOptions): Promise<QueryResult[]>
  delete(nodeId: string): void
  exportJson(opts?: { maxExportNodes?: number; nodeId?: string }): string
  /** The rows of a handoff, oldest first: the default `summaries` or the
   *  `whole` lane; `limit` keeps the newest that many (the inline cap). */
  handoffRows(form: 'summaries' | 'whole', limit?: number): { nodes: unknown[]; total: number }
  importJson(
    json: string,
    opts?: { label?: string; readOnly?: boolean; handoff?: { file: string; importer: string | null }; fromFile?: boolean },
  ): Promise<ImportResult>
  mergeFromNamespace(
    sourceNamespace: string,
    opts: { label: string; nodeId?: string; readOnly?: boolean },
  ): {
    importedCount: number; label: string; sourceNamespace: string; replaced: boolean
    /** A7/§5.3 (docs/project-identity.md): entries the dedup predicate
     *  skipped. Additive — a run that dropped half its input used to look
     *  identical to a clean one. */
    skippedDuplicate: number
    /** D144: entries already carried across by an earlier merge, found by
     *  their `_merged_from_node_id` back-pointer. Additive. */
    skippedAlreadyMerged: number
  }
  clear(): { cleared: boolean; previousNodeCount: number }
  status(): TreeStatus
  close(): Promise<void>
  /** The namespace this store operates on. */
  readonly namespace: string
}

