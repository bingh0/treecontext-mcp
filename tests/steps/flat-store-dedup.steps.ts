/**
 * flat-store-dedup.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion preserved verbatim. The three
 * scenarios sharing "both are inserted" stage their inserts in the Given
 * via world state; their shared Then reads world results. Store close
 * moved to defer.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { DEDUP_WINDOW_SECS } from '../../src/persistence/capture-constants.js'

type InsertOpts = Parameters<FlatStore['insert']>[1]
type InsertResult = Awaited<ReturnType<FlatStore['insert']>>

interface World {
  defer: (fn: () => void | Promise<void>) => void
  path?: string
  store?: FlatStore
  /** Staged by Givens for the shared "both are inserted" When. */
  pendingInserts?: Array<{ content: string; opts?: InsertOpts }>
  results?: InsertResult[]
  anchorNodeId?: string | undefined
  secondUserId?: string
  originalId?: string
}

const T0 = 1_700_000_000

function autoMeta(session: string, role = 'user'): Record<string, unknown> {
  return { source: 'auto-capture', role, session_id: session }
}

export const flatStoreDedupDefiner = (reg: Registry<World>): void => {
  function freshDbPath(w: World): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-dedup-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    return join(dir, 'flat.db')
  }

  async function openStore(w: World, path: string): Promise<FlatStore> {
    const db = wrapBetterSqlite(new BetterSqlite3(path))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => store.close())
    return store
  }

  reg.define(/^an auto-captured user message and an identical one twenty minutes later$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    w.pendingInserts = [
      { content: 'proceed', opts: { createdAt: T0, metadata: autoMeta('sess-a') } },
      { content: 'proceed', opts: { createdAt: T0 + 1200, metadata: autoMeta('sess-b') } },
    ]
  })

  reg.define(/^both are inserted with their capture timestamps$/, async (w) => {
    w.results = []
    for (const i of w.pendingInserts!) w.results.push(await w.store!.insert(i.content, i.opts))
  })

  reg.define(/^two nodes exist, each with its own session and capture time$/, async (w) => {
    const [first, second] = w.results!
    expect(first!.deduplicated).toBe(false)
    expect(second!.deduplicated).toBe(false)
    expect(second!.nodeId).not.toBe(first!.nodeId)
    const results = await w.store!.query('proceed', { topK: 5 })
    expect(results.length).toBe(2)
    const sessions = new Set(results.map((r) => r.metadata?.['session_id']))
    expect(sessions).toEqual(new Set(['sess-a', 'sess-b']))
    const times = new Set(results.map((r) => r.createdAt))
    expect(times).toEqual(new Set([T0, T0 + 1200]))
  })

  reg.define(/^an auto-captured assistant response staged twice seconds apart$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    w.pendingInserts = [
      { content: 'Final turn response text.', opts: { createdAt: T0, metadata: autoMeta('sess-a', 'assistant') } },
      { content: 'Final turn response text.', opts: { createdAt: T0 + 3, metadata: autoMeta('sess-a', 'assistant') } },
    ]
  })

  reg.define(/^both are inserted$/, async (w) => {
    w.results = []
    for (const i of w.pendingInserts ?? []) w.results.push(await w.store!.insert(i.content, i.opts))
  })

  reg.define(/^one node exists and the second insert reports deduplicated$/, (w) => {
    const [first, second] = w.results!
    expect(second!.deduplicated).toBe(true)
    expect(second!.nodeId).toBe(first!.nodeId)
    expect(w.store!.status().totalNodes).toBe(1)
  })

  reg.define(/^three identical auto-captured messages each spaced just inside the window of the previous$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
  })

  reg.define(/^all are inserted in order$/, async (w) => {
    const step = DEDUP_WINDOW_SECS - 10 // inside the window of the previous, outside the first's
    await w.store!.insert('sliding dedup probe', { createdAt: T0, metadata: autoMeta('s') })
    await w.store!.insert('sliding dedup probe', { createdAt: T0 + step, metadata: autoMeta('s') })
    await w.store!.insert('sliding dedup probe', { createdAt: T0 + 2 * step, metadata: autoMeta('s') })
  })

  reg.define(/^one node exists, pinning that the window anchors to the most recent occurrence$/, (w) => {
    // 2*step > DEDUP_WINDOW_SECS: had the window anchored to the FIRST
    // occurrence, the third insert would have created a second node.
    const step = DEDUP_WINDOW_SECS - 10
    expect(2 * step).toBeGreaterThan(DEDUP_WINDOW_SECS)
    expect(w.store!.status().totalNodes).toBe(1)
  })

  reg.define(/^an auto-captured message and an identical one from a different session seconds later$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    w.pendingInserts = [
      { content: 'git status output identical', opts: { createdAt: T0, metadata: autoMeta('sess-a', 'assistant') } },
      { content: 'git status output identical', opts: { createdAt: T0 + 30, metadata: autoMeta('sess-b', 'assistant') } },
    ]
  })

  reg.define(/^two nodes exist, one per session timeline$/, (w) => {
    expect(w.store!.status().totalNodes).toBe(2)
  })

  reg.define(/^two identical auto-captured messages captured hours apart while the server was off$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
  })

  reg.define(/^a backlog drain inserts both within the same second$/, async (w) => {
    await w.store!.insert('backlog probe message', { createdAt: T0, metadata: autoMeta('s') })
    await w.store!.insert('backlog probe message', { createdAt: T0 + 7200, metadata: autoMeta('s') })
  })

  reg.define(/^two nodes exist, pinning that wall clock at drain time plays no part$/, (w) => {
    expect(w.store!.status().totalNodes).toBe(2)
  })

  reg.define(/^an agent-authored note and an identical insert in a later session$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    w.pendingInserts = [
      { content: '## DECISION: the flange is locked', opts: { metadata: { type: 'decision' } } },
      { content: '## DECISION: the flange is locked', opts: { metadata: { type: 'decision' } } },
    ]
  })

  reg.define(/^an auto-captured row and a later curated insert with identical content$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    w.results = [await w.store.insert('the flange tolerance is 0.3mm', { createdAt: T0, metadata: autoMeta('s') })]
  })

  reg.define(/^the curated insert runs$/, async (w) => {
    w.results!.push(await w.store!.insert('the flange tolerance is 0.3mm', { metadata: { type: 'finding' } }))
  })

  reg.define(/^a new curated node exists distinct from the evictable auto-capture row$/, (w) => {
    const [auto, curated] = w.results!
    expect(curated!.deduplicated).toBe(false)
    expect(curated!.nodeId).not.toBe(auto!.nodeId)
    expect(w.store!.status().totalNodes).toBe(2)
  })

  reg.define(/^a user directive repeated across two sessions outside the dedup window$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    await w.store.insert('run the quibbleflux experiment', { createdAt: T0, metadata: autoMeta('sess-1') })
    w.secondUserId = (
      await w.store.insert('run the quibbleflux experiment', { createdAt: T0 + 4000, metadata: autoMeta('sess-2') })
    ).nodeId
    await w.store.insert('Tool: Bash\nInput:\nquibbleflux.sh\nOutput:\nstarted wombatstride runner', {
      createdAt: T0 + 4010,
      metadata: { ...autoMeta('sess-2', 'assistant'), tool_name: 'Bash' },
    })
  })

  reg.define(/^a query hit from the second session requests its window anchor$/, async (w) => {
    const hits = await w.store!.query('wombatstride', { topK: 3, conversationWindow: 1 })
    expect(hits.length).toBe(1)
    const anchor = hits[0]!.window?.anchor
    w.anchorNodeId = anchor && 'nodeId' in anchor ? anchor.nodeId : anchor && 'ref' in anchor ? anchor.ref : undefined
  })

  reg.define(/^the anchor is the second session's occurrence$/, (w) => {
    expect(w.anchorNodeId).toBe(w.secondUserId)
  })

  reg.define(/^a store containing auto-capture and curated rows with known fingerprints$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    await w.store.insert('auto probe row', { createdAt: T0, metadata: autoMeta('s') })
    await w.store.insert('curated probe note', { metadata: { type: 'note' } })
    await w.store.close()
  })

  reg.define(/^the store is closed and reopened$/, async (w) => {
    w.store = await openStore(w, w.path!)
  })

  reg.define(/^time-bounded and global dedup behave identically to before the reopen$/, async (w) => {
    // Curated: still globally idempotent.
    const curated = await w.store!.insert('curated probe note', { metadata: { type: 'note' } })
    expect(curated.deduplicated).toBe(true)
    // Auto inside the window of the stored occurrence: dedups.
    const autoNear = await w.store!.insert('auto probe row', {
      createdAt: T0 + DEDUP_WINDOW_SECS - 5,
      metadata: autoMeta('s'),
    })
    expect(autoNear.deduplicated).toBe(true)
    // Auto far outside the window: a genuine recurrence, new node.
    const autoFar = await w.store!.insert('auto probe row', { createdAt: T0 + 7200, metadata: autoMeta('s') })
    expect(autoFar.deduplicated).toBe(false)
  })

  reg.define(/^a curated note whose resume-pointer tags were superseded away$/, async (w) => {
    w.path = freshDbPath(w)
    w.store = await openStore(w, w.path)
    const first = await w.store.insert('the plan for tomorrow morning', { metadata: { next_session: true } })
    w.originalId = first.nodeId
    // A later close-out supersedes it: the tags clear.
    await w.store.insert('the close-out that replaced the plan', { supersedes: [w.originalId] })
    const meta = readMeta(w.store, w.originalId)
    expect(meta['next_session']).toBeUndefined()
  })

  reg.define(/^the same content is recorded again with next_session set$/, async (w) => {
    const again = await w.store!.insert('the plan for tomorrow morning', { metadata: { next_session: true } })
    expect(again.deduplicated).toBe(true)
    expect(again.nodeId).toBe(w.originalId)
  })

  reg.define(/^no new node is created and the original carries the pointer tags again$/, (w) => {
    const meta = readMeta(w.store!, w.originalId!)
    expect(meta['next_session']).toBe(true)
  })

  // Through the public export surface, not raw SQL on the internal
  // handle — raw SQL pins the metadata_json storage encoding, while
  // exportJson serves the same merged tags (recordReliance: false so
  // the probe never bumps the meter it reads).
  function readMeta(s2: FlatStore, id: string): Record<string, unknown> {
    const parsed = JSON.parse(s2.exportJson({ nodeId: id, recordReliance: false })) as {
      nodes: Array<{ metadata: Record<string, unknown> | null }>
    }
    return parsed.nodes[0]!.metadata ?? {}
  }
}
