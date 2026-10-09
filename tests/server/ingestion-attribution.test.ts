/**
 * C1 drain attribution (tests/server/design/multi-user.md).
 *
 * The drain serves every namespace of the store: each staged row drains
 * into the tree its namespace stamp names, through the injected
 * per-namespace handle factory — the shape the serving process always
 * passes. Pinned here, beyond the feature binding's resolved-stamp path:
 *
 * - NULL stamp → the SERVING namespace (the drain owner's own handle),
 *   exactly where every capture drained before attribution existed —
 *   not the literal 'project' (program-C review, finding 4).
 * - A stamp naming a namespace with no live server still drains into
 *   that namespace's tree, create-if-absent (the drain owner serves
 *   namespaces nobody is serving).
 * - An invalid stamp is poison: the row dead-letters after bounded
 *   attempts, and its capture-gap tombstone lands in the serving
 *   journal — the hole is recorded even though its stamp is garbage.
 * - A transient factory failure for a VALID stamp propagates: the row
 *   stays queued and retries, never wrongly tombstoned elsewhere
 *   (finding 7).
 * - Valve drops tombstone each (session, namespace) group's hole into
 *   that group's own journal — and the LIVE SESSION is protected whole,
 *   even when its rows straddle a NULL and a stamped group (finding 3).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop, type IngestibleStore } from '../../src/server/ingestion.js'
import { MAX_INGEST_ATTEMPTS } from '../../src/persistence/capture-constants.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-attr-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

let dbN = 0
let dbPath = ''
function openServing(namespace?: string): Promise<FlatStore> {
  dbPath = join(tmpDir, `attr-${dbN++}.db`)
  return FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
    ownsDatabase: true,
    ...(namespace ? { namespace } : {}),
  })
}

interface DrainWorld {
  trunk: FlatStore
  loop: IngestionLoop
  extras: FlatStore[]
}

/** Serving store + drain wired the way the serving process wires it: the
 *  serving handle seeds the per-namespace cache; other namespaces open
 *  create-if-absent on their own connection. `failFor` injects a
 *  transient factory failure for one namespace (finding 7's pin). */
async function openDrainWorld(
  loopOpts: { stagingMaxBytes?: number } = {},
  world: { namespace?: string; failFor?: string } = {},
): Promise<DrainWorld> {
  const trunk = await openServing(world.namespace)
  const handles = new Map<string, FlatStore>([[trunk.namespace, trunk]])
  const extras: FlatStore[] = []
  const storeFor = async (ns: string): Promise<IngestibleStore> => {
    if (ns === world.failFor) throw new Error(`transient failure opening '${ns}'`)
    let h = handles.get(ns)
    if (!h) {
      h = await FlatStore.open({
        database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
        ownsDatabase: true,
        namespace: ns,
      })
      handles.set(ns, h)
      extras.push(h)
    }
    return h
  }
  return { trunk, loop: new IngestionLoop(trunk, { batchSize: 50, storeFor, ...loopOpts }), extras }
}

async function closeWorld(w: DrainWorld): Promise<void> {
  for (const h of w.extras) await h.close()
  await w.trunk.close()
}

let ts = 1_000_000
function stage(trunk: FlatStore, content: string, namespace: string | null, sessionId = 's1'): void {
  trunk.store.insertStaging({
    sessionId, role: 'user', content, timestamp: ts++, priority: 1, namespace,
  })
}

/** All rows of one namespace's tree, raw (verification rule: separate
 *  readonly handle, no production query surface). */
function treeRows(ns: string): Array<{ content: string; metadata: Record<string, unknown> }> {
  const raw = new BetterSqlite3(dbPath, { readonly: true })
  try {
    return (raw.prepare(
      'SELECT n.content AS content, n.metadata_json AS meta FROM nodes n JOIN trees t ON n.tree_id = t.tree_id WHERE t.namespace = ?',
    ).all(ns) as Array<{ content: string | Buffer; meta: string | null }>)
      .map((r) => ({ content: String(r.content), metadata: JSON.parse(r.meta ?? '{}') as Record<string, unknown> }))
  } finally {
    raw.close()
  }
}

describe('C1 drain attribution', () => {
  it('a NULL stamp drains into the SERVING namespace — not the literal project', async () => {
    // The drain owner runs --namespace work: unresolved captures must
    // stay visible in ITS journal, exactly as they did pre-attribution,
    // not reroute into an unserved trunk tree nobody queries.
    const w = await openDrainWorld({}, { namespace: 'work' })
    stage(w.trunk, 'UNRESOLVED4471: captured with no namespace stamp', null)
    await w.loop.ingestBatch()
    expect(treeRows('work').some((r) => r.content.includes('UNRESOLVED4471'))).toBe(true)
    expect(treeRows('project').some((r) => r.content.includes('UNRESOLVED4471'))).toBe(false)
    expect(w.extras, 'the default must reuse the serving handle, not open a new one').toHaveLength(0)
    await closeWorld(w)
  })

  it('a stamped row drains into its namespace, create-if-absent — no server for it required', async () => {
    const w = await openDrainWorld()
    stage(w.trunk, 'STAMPED9182: subagent capture', 'agent-nobody-serves')
    await w.loop.ingestBatch()
    expect(treeRows('agent-nobody-serves').some((r) => r.content.includes('STAMPED9182'))).toBe(true)
    expect(treeRows('project').some((r) => r.content.includes('STAMPED9182'))).toBe(false)
    await closeWorld(w)
  })

  it('an invalid stamp dead-letters, and the tombstone lands in the trunk', async () => {
    const w = await openDrainWorld()
    stage(w.trunk, 'POISON3327: stamped with an unusable namespace', 'not a/valid ns')
    for (let i = 0; i < MAX_INGEST_ATTEMPTS + 1; i++) await w.loop.ingestBatch()
    expect(w.trunk.store.countUnprocessedStaging(), 'the poison row must retire').toBe(0)
    const gap = treeRows('project').find((r) => (r.metadata['source'] as string) === 'capture-gap')
    expect(gap, 'the hole must be recorded despite the garbage stamp').toBeTruthy()
    expect(gap!.content).toContain('[capture gap]')
    // The payload itself must not have landed anywhere as a journal row.
    expect(treeRows('project').some((r) => r.content === 'POISON3327: stamped with an unusable namespace')).toBe(false)
    await closeWorld(w)
  })

  it('a transient factory failure for a valid stamp leaves the row queued — never wrongly tombstoned', async () => {
    const w = await openDrainWorld({}, { failFor: 'agent-flaky' })
    stage(w.trunk, 'FLAKY8823: valid stamp, factory down', 'agent-flaky')
    for (let i = 0; i < MAX_INGEST_ATTEMPTS + 2; i++) await w.loop.ingestBatch()
    // The stamp is valid, so the failure is the factory's — propagating
    // leaves the row queued for the next tick (self-healing), where a
    // trunk tombstone would file the hole in the wrong journal forever.
    expect(w.trunk.store.countUnprocessedStaging(), 'the row must stay queued').toBe(1)
    expect(
      treeRows('project').some((r) => (r.metadata['source'] as string) === 'capture-gap'),
      'no capture-gap may land in the serving journal for a foreign-namespace row',
    ).toBe(false)
    await closeWorld(w)
  })

  it('the live session is protected whole, even straddling a NULL and a stamped group', async () => {
    // The live session's first rows staged before its server's annotation
    // landed (NULL stamp); later rows carry the stamp. Two groups, one
    // live stream — the valve must drop neither, only the older session.
    const w = await openDrainWorld({ stagingMaxBytes: 1_000 })
    stage(w.trunk, 'x'.repeat(2_000), 'agent-old', 'sess-old')
    stage(w.trunk, 'LIVEPREFIX7714 ' + 'y'.repeat(2_000), null, 'sess-live')
    stage(w.trunk, 'LIVESUFFIX7715: stamped after the annotation landed', 'agent-live', 'sess-live')
    await w.loop.ingestBatch()
    // The older session was dropped and tombstoned; both halves of the
    // live session survived the valve and drained normally.
    expect(
      treeRows('agent-old').some((r) => (r.metadata['event'] as string) === 'capture_gap'),
    ).toBe(true)
    expect(treeRows('project').some((r) => r.content.includes('LIVEPREFIX7714'))).toBe(true)
    expect(treeRows('agent-live').some((r) => r.content.includes('LIVESUFFIX7715'))).toBe(true)
    const liveGaps = [...treeRows('project'), ...treeRows('agent-live')]
      .filter((r) => (r.metadata['event'] as string) === 'capture_gap')
    expect(liveGaps, 'no hole may be torn in the live session').toHaveLength(0)
    await closeWorld(w)
  })

  it('valve drops tombstone each (session, namespace) group into its own journal', async () => {
    // Two old groups in different namespaces plus a newest live group;
    // a tiny byte valve forces both old groups out.
    const w = await openDrainWorld({ stagingMaxBytes: 1_000 })
    stage(w.trunk, 'x'.repeat(2_000), 'agent-a', 'sess-old-a')
    stage(w.trunk, 'y'.repeat(2_000), null, 'sess-old-null')
    stage(w.trunk, 'live', 'agent-live', 'sess-live')
    await w.loop.ingestBatch()
    const gapsIn = (ns: string) =>
      treeRows(ns).filter((r) => (r.metadata['event'] as string) === 'capture_gap')
    expect(gapsIn('agent-a'), "agent-a's hole belongs to agent-a's journal").toHaveLength(1)
    expect(gapsIn('project'), "the unresolved group's hole belongs to the trunk").toHaveLength(1)
    // The live (newest) group survived and drained normally.
    expect(treeRows('agent-live').some((r) => r.content === 'live')).toBe(true)
    await closeWorld(w)
  })
})
