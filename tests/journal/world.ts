/**
 * Shared world for the journal charter suite: the core World interface, and
 * the store/MCP helpers common to all waves.
 *
 * Extracted from tests/journal/features.test.ts (the executor-migration
 * mega-runner) 2026-08-26 as one interface of ~97 optional fields; split by
 * usage 2026-08-27 into this core plus one interface per wave, each beside
 * its harness or at the top of its steps file. Wave-specific harnesses live
 * beside this file, definers in ./steps/, and the runner map — which names
 * every wave world — stays in features.test.ts.
 *
 * The dependency runs one way: a wave interface imports this one, never the
 * reverse. (It did once: sPanes/sRaw pulled PaneKey in from sidecar-world.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../src/server/server.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { LeaseClient, tryClaim, NS_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import type { InsertResult, MediaRef, QueryResult } from '../../src/core/types.js'
import { parseToolResult } from '../helpers/mcp-result.js'

export const T0 = 1_700_000_000

// ── Shared world helpers ────────────────────────────────────────────────

/**
 * The CORE world: what world.ts's own helpers read, plus every field two or
 * more wave families read. Everything else moved to a wave interface — see
 * the map in features.test.ts.
 *
 * The test for membership here is usage, not topic: a field stays only if
 * deleting it would break either a helper below or step files from two
 * different waves. Each one carries the readers that keep it. A field with
 * one wave left in this list is a field that should have moved.
 *
 * gnt gives every scenario a fresh world and lets each feature name its own
 * type (`Definer<MyWorld>`), so this narrowing is entirely type-level: no
 * step's runtime behaviour depends on which interface a field is declared in.
 */
export interface World {
  /** gnt's reserved key: scenario-scoped LIFO cleanup, run even on failure. */
  defer: (fn: () => void | Promise<void>) => void
  /** openLiveStore's temp dir; also agent-surface, media, namespaces, storage. */
  dir?: string
  /** openLiveStore/reopenAsLaterSession/rawMediaOf/rawAll, the capture harness,
   *  and seven waves' raw-row reads. */
  dbPath?: string
  /** Every helper here and all but one wave. */
  store?: FlatStore
  /** The refusal a step provoked on purpose: library (size/node limits),
   *  media (bare ref), storage (disk full, deleted backend). */
  insertError?: unknown
  /** agent-surface, library, media, namespaces, policy, recall, search-modes,
   *  storage — the id a scenario carries from a write to its read-back. */
  nodeId?: string
  /** The same, plural: library, media, namespaces, recall, search-modes, storage. */
  nodeIds?: string[]
  /** Seed contents held for the assertion: library, media, recall, storage. */
  descriptions?: string[]
  /** exportJson's parse: library, media, storage. */
  exported?: { nodes: Array<Record<string, unknown>> }
  /** The query under assertion: library, media, namespaces, recall, search-modes. */
  results?: QueryResult[]
  /** namespaces and recall. */
  insertResult?: InsertResult
  /** Set by mcpOver below, read by agent-surface, library, namespaces, policy,
   *  recall, search-modes, session-echo. */
  client?: Client
  /** A parsed tool response: library, recall, search-modes. */
  mcpResponse?: Record<string, unknown>
  /** The old/new pair the recency scenarios rank against each other — recall
   *  (temporal access) and search-modes (recency fusion) both need both. */
  oldId?: string
  freshId?: string
}

/** In-process MCP client over the world's store — the real handshake,
 *  transport, and tool schemas, no subprocess. Pass `store` to serve a
 *  different handle than w.store (e.g. a second handle over the same
 *  file, or a namespaced one). */
export async function mcpOver(w: World, opts: Parameters<typeof createServer>[1] = {}, store: FlatStore = w.store!): Promise<Client> {
  const server = createServer(store, opts)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'charter', version: '0' })
  await server.connect(st)
  await client.connect(ct)
  w.defer(async () => { await client.close(); await server.close() })
  w.client = client
  return client
}

/** Serve's namespace hook (src/server/cli.ts): every tool call re-tries
 *  the primary claim — the heartbeat and the takeover path — through the
 *  PRODUCTION tryClaim, whose swallow is the amendment-8 contract these
 *  scenarios bind: a live holder is not a refusal, a non-contention
 *  error still propagates and fails the call. `pid` is what identifies
 *  the server here: leases never probe pids, so a pid other than this
 *  process's is a genuinely foreign claimant. */
export function nsClaimHook(db: ReturnType<typeof wrapBetterSqlite>, namespace: string, pid: number): () => void {
  const leases = new LeaseClient(db, { pid, host: hostname(), label: `serve:${namespace}` })
  return () => {
    tryClaim(leases, `ns:${namespace}`, NS_LEASE_TTL_SECS)
  }
}

/** The journal tier's spelling of the shared reader (helpers/mcp-result):
 *  one cast for both tiers, one name per tier's steps. */
export function parseTool(res: unknown): Record<string, unknown> {
  return parseToolResult(res)
}

export async function openLiveStore(w: World, opts: Partial<Omit<Parameters<typeof FlatStore.open>[0], 'database' | 'ownsDatabase'>> = {}): Promise<FlatStore> {
  if (!w.dir) {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
  }
  w.dbPath = w.dbPath ?? join(w.dir, 'journal.db')
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)),
    ownsDatabase: true,
    ...opts,
  })
  w.defer(() => store.close())
  w.store = store
  return store
}

/** Close the current store and reopen the same file — "a later session". */
export async function reopenAsLaterSession(w: World): Promise<FlatStore> {
  w.store!.close()
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
    ownsDatabase: true,
  })
  w.defer(() => store.close())
  w.store = store
  return store
}

export function exportNode(w: World, nodeId: string): Record<string, unknown> {
  const exported = JSON.parse(w.store!.exportJson({ nodeId })) as { nodes: Array<Record<string, unknown>> }
  expect(exported.nodes).toHaveLength(1)
  return exported.nodes[0]!
}

export function mediaOf(node: Record<string, unknown>): MediaRef {
  const media = (node['metadata'] as Record<string, unknown> | null)?.['_media'] as MediaRef | undefined
  expect(media, 'entry carries no media reference').toBeTruthy()
  return media!
}

/** Raw-row inspection (verification rule): read metadata_json through a
 *  separate readonly SQLite handle, never through the store's own API. */
export function rawMediaOf(w: World, nodeId: string): MediaRef {
  const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
  try {
    const row = raw.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(nodeId) as
      | { metadata_json: string | null }
      | undefined
    expect(row, 'node row missing from the live store').toBeTruthy()
    const media = (JSON.parse(row!.metadata_json ?? '{}') as Record<string, unknown>)['_media'] as MediaRef | undefined
    expect(media, 'raw row carries no _media').toBeTruthy()
    return media!
  } finally {
    raw.close()
  }
}

export async function insertAttachment(
  w: World,
  description: string,
  ref: MediaRef,
  extra?: { createdAt?: number; metadata?: Record<string, unknown> },
): Promise<string> {
  const store = w.store ?? (await openLiveStore(w))
  const result = await store.insert(description, { mediaRef: ref, ...extra })
  return result.nodeId
}

/** Raw-row read of arbitrary SQL (verification rule): through a separate
 *  readonly handle, never the store's own API. One spelling for the whole
 *  suite — the extraction found it re-derived under three names. */
export function rawAll<T>(w: World, sql: string, ...params: unknown[]): T[] {
  const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
  try {
    return raw.prepare(sql).all(...(params as never[])) as T[]
  } finally {
    raw.close()
  }
}
