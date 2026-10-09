/**
 * Step 6A — auto-capture journal on the lexical (FlatStore) backend.
 *
 * The flat backend has no separate journal structure: the agent store and the
 * auto-capture journal are the *same* FlatStore, separated only by
 * `source_label` + D6 retention (no BIRCH, no promotion). 6A is the capture
 * *wiring* — staging drains straight into FlatStore.insert as `auto-capture`
 * nodes via a BIRCH-free IngestionLoop (dualTree = null).
 *
 * AC6A.1 staging → auto-capture node w/ session_id (warn-and-drop removed);
 * AC6A.2 captured nodes queryable via bm25 alongside agent-authored;
 * (AC6A.3 — code_refs annotation — deleted with the code tool, 2026-07-25.)
 * AC6A.4 D6 retention applies to captured nodes; authored stays protected;
 * AC6A.5 read-only policy suppresses capture (captureEnabled gate);
 * AC6A.6 the capture path loads no embedder / ONNX native modules.
 *
 * Imports are deliberately ML-free (FlatStore + IngestionLoop + policy only)
 * so AC6A.6's module-registry assertion is meaningful.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { captureEnabled } from '../../src/server/policy.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-cap-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

let dbN = 0
function openDb(): Database {
  return wrapBetterSqlite(new BetterSqlite3(join(tmpDir, `cap-${dbN++}.db`)))
}

interface ExportedNode {
  content: string
  sourceLabel: string | null
  metadata: Record<string, unknown> | null
}
function nodesOf(store: FlatStore): ExportedNode[] {
  return (JSON.parse(store.exportJson()) as { nodes: ExportedNode[] }).nodes
}

let ts = 1_000_000
function stage(
  store: FlatStore,
  content: string,
  e: { role?: 'user' | 'assistant' | 'tool_result'; sessionId?: string; toolName?: string; priority?: number } = {},
): void {
  store.store.insertStaging({
    sessionId: e.sessionId ?? 's1',
    role: e.role ?? 'user',
    content,
    toolName: e.toolName ?? null,
    timestamp: ts++,
    priority: e.priority ?? 1,
  })
}

describe('AC6A.1 + AC6A.2 — staging drains to a queryable auto-capture node', () => {
  it('stores a captured event as an auto-capture node with session_id, queryable beside authored', async () => {
    const store = await FlatStore.open({ database: openDb() })
    await store.insert('authored note about widgets and gizmos', {}) // agent-authored leaf
    stage(store, 'captured user message about gadgets and sprockets', { sessionId: 'sess-7' })

    const loop = new IngestionLoop(store, {})
    const processed = await loop.ingestBatch()
    expect(processed).toBe(1)

    // AC6A.1: stored as auto-capture, tagged with the originating session.
    const captured = nodesOf(store).find((n) => n.content.includes('gadgets'))
    expect(captured).toBeTruthy()
    expect(captured!.sourceLabel).toBe('auto-capture')
    expect(captured!.metadata?.['session_id']).toBe('sess-7')

    // AC6A.2: one unified store — bm25 query reaches both authored and captured.
    const gq = await store.query('gadgets sprockets', { topK: 5 })
    expect(gq.some((r) => r.content.includes('gadgets'))).toBe(true)
    const wq = await store.query('widgets gizmos', { topK: 5 })
    expect(wq.some((r) => r.content.includes('widgets'))).toBe(true)

    await store.close()
  })
})


describe('AC6A.4 — D6 retention through the live capture path', () => {
  it('evicts captured nodes past the entry-count bound; agent-authored is never evicted', async () => {
    const store = await FlatStore.open({ database: openDb(), maxAutoEntries: 2, retentionInterval: 1_000_000 })
    await store.insert('authored protected note alpha', {}) // protected (source !== auto-capture)
    // Two sessions: the entry cap peels whole OLD sessions (charter valve,
    // 2026-07-24) — the newest session is never evicted, so the overflow
    // must live in an older one for the cap to act.
    for (let i = 0; i < 2; i++) {
      stage(store, `captured event number ${i} with enough length to survive the priority filter`, { sessionId: 'old-sess' })
    }
    for (let i = 2; i < 4; i++) {
      stage(store, `captured event number ${i} with enough length to survive the priority filter`, { sessionId: 'new-sess' })
    }
    const loop = new IngestionLoop(store, {})
    await loop.ingestBatch()
    store.retentionSweep()

    const all = nodesOf(store)
    const auto = all.filter((n) => n.sourceLabel === 'auto-capture')
    expect(auto.length).toBeLessThanOrEqual(2) // entry-count cap enforced on captures
    expect(all.some((n) => n.content.includes('alpha'))).toBe(true) // authored survives

    await store.close()
  })
})

describe('AC6A.5 — read-only policy suppresses capture', () => {
  it('captureEnabled is false under read_only, true under contributor/full when requested', () => {
    // This is the exact gate startServer.initCapture consults before wiring
    // the ingestion drain (server.ts).
    expect(captureEnabled(true, 'read_only')).toBe(false)
    expect(captureEnabled(true, 'full')).toBe(true)
    expect(captureEnabled(true, 'contributor')).toBe(true)
    expect(captureEnabled(false, 'full')).toBe(false)
    expect(captureEnabled(undefined, 'full')).toBe(false)
  })
})

describe('AC6A.6 — capture path loads no embedder / ONNX', () => {
  it('drains staging into FlatStore with no native-ML modules loaded', async () => {
    const store = await FlatStore.open({ database: openDb() })
    stage(store, 'captured content used to exercise the no-ML capture assertion path')
    const loop = new IngestionLoop(store, {})
    await loop.ingestBatch()
    await store.query('captured content', { topK: 3 })

    const req = createRequire(import.meta.url)
    const loaded = Object.keys(req.cache)
    expect(loaded.some((p) => /onnxruntime-node|[\\/]tokenizers[\\/]|[\\/]usearch[\\/]/.test(p))).toBe(false)

    await store.close()
  })
})
