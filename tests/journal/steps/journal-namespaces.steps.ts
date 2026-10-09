import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { runMigrations } from '../../../src/persistence/migrations.js'
import { FlatStore } from '../../../src/flat-store.js'
import { writeNamespaceAnnotation } from '../../../src/session-beacon.js'
import { LeaseClient, leaseHolders, NS_LEASE_TTL_SECS } from '../../../src/persistence/leases.js'
import type { Client } from '@modelcontextprotocol/client'
import type { InsertResult, QueryResult } from '../../../src/core/types.js'
import { T0, mcpOver, nsClaimHook, parseTool, openLiveStore } from '../world.js'
import { type CaptureWorld, openCaptureWorld, spawnHook, drainStaging } from '../capture-harness.js'

// ── journal-namespaces ──────────────────────────────────────────────────

/** Two FlatStore handles over ONE on-disk SQLite file, each scoped to its
 *  own namespace — the many-writers shape the feature describes. The
 *  connection is shared (ownsDatabase: false) so both worlds live in the
 *  same file; assertions read it back through a separate readonly handle
 *  (verification rule). Returns [a, b]; w.store = a, w.storeB = b. */
async function openNamespacePair(w: NamespacesWorld, nsA: string, nsB: string): Promise<[FlatStore, FlatStore]> {
  w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-ns-'))
  w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
  w.dbPath = join(w.dir, 'journal.db')
  const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath))
  const a = await FlatStore.open({ database: db, namespace: nsA, ownsDatabase: false })
  const b = await FlatStore.open({ database: db, namespace: nsB, ownsDatabase: false })
  w.defer(() => { a.close(); b.close(); db.close() })
  w.store = a
  w.storeB = b
  return [a, b]
}

/** All decoded rows in a namespace, via a separate readonly connection —
 *  never the store handle under test. */
function rawNamespaceRows(w: NamespacesWorld, namespace: string): Array<{ content: string; metadata: Record<string, unknown> }> {
  const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
  try {
    const rows = raw
      .prepare('SELECT n.content, n.metadata_json FROM nodes n JOIN trees t ON t.tree_id = n.tree_id WHERE t.namespace = ?')
      .all(namespace) as Array<{ content: string | Buffer | null; metadata_json: string | null }>
    return rows.map((r) => ({
      content: decodeContent(r.content),
      metadata: JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>,
    }))
  } finally {
    raw.close()
  }
}

/** The shared-namespace world's rows, carrying the arbiter's own
 *  attribution column beside the annotation — read through a separate
 *  readonly connection, never through either server's handle. */
function sharedNamespaceRows(w: NamespacesWorld): Array<{ content: string; sessionKey: string; meta: Record<string, unknown> }> {
  const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
  try {
    const rows = raw
      .prepare(
        'SELECT n.content, n.session_key, n.metadata_json FROM nodes n JOIN trees t ON t.tree_id = n.tree_id ' +
        "WHERE t.namespace = 'project'",
      )
      .all() as Array<{ content: string | Buffer | null; session_key: string | null; metadata_json: string | null }>
    return rows.map((r) => ({
      content: decodeContent(r.content),
      sessionKey: r.session_key ?? '',
      meta: JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>,
    }))
  } finally {
    raw.close()
  }
}


/**
 * The namespaces wave's world. It extends CaptureWorld because the
 * worktree-isolation scenarios stamp their namespace through a real hook
 * subprocess and drain it, which is the only way the capture-side
 * attribution is exercised for real.
 */
export interface NamespacesWorld extends CaptureWorld {
  /** A raw handle on the store file, for reading the lease table directly. */
  leaseDb?: ReturnType<typeof wrapBetterSqlite>
  /** Results of the exclusion query. */
  nsExcluded?: Array<{ content: string; metadata?: Record<string, unknown> }>
  // Two handles over one file
  storeB?: FlatStore
  resultsB?: QueryResult[]
  insertResultB?: InsertResult
  pointerIds?: string[]
  mergeCount?: number
  mergeRepeats?: Array<{ importedCount: number; skippedDuplicate: number; skippedAlreadyMerged: number }>
  mergeError?: unknown
  siblingContents?: string[]
  // Two servers over ONE namespace (amendment 8, 2026-08-20)
  nsShared?: Array<{
    sessionId: string
    client: Client
    contents: string[]
    nodeIds: string[]
    queryHits: number
    failures: string[]
  }>
}
export const namespacesDefiner = (reg: Registry<NamespacesWorld>): void => {
  // ── writers in different namespaces never see each other by default ──
  reg.define(/^two agents journaling into the same store under different namespaces$/, async (w: NamespacesWorld) => {
    const [a, b] = await openNamespacePair(w, 'agent-a', 'agent-b')
    // Both entries match the SAME query terms — the namespace alone
    // decides who sees which.
    await a.insert('deploy pipeline observation from writer alpha')
    await b.insert('deploy pipeline observation from writer beta')
  })
  reg.define(/^each agent queries its own store handle$/, async (w: NamespacesWorld) => {
    w.results = await w.store!.query('deploy pipeline observation')
    w.resultsB = await w.storeB!.query('deploy pipeline observation')
  })
  reg.define(/^each sees hits only from its own namespace$/, (w: NamespacesWorld) => {
    expect(w.results!.map((r) => r.content)).toEqual(['deploy pipeline observation from writer alpha'])
    expect(w.resultsB!.map((r) => r.content)).toEqual(['deploy pipeline observation from writer beta'])
  })

  // ── resume pointers are scoped to their namespace ────────────────────
  reg.define(/^an active plan tagged next_session in a subagent namespace$/, async (w: NamespacesWorld) => {
    const [, scout] = await openNamespacePair(w, 'project', 'scout')
    w.nodeId = (await scout.insert('PLAN: bind the namespace charter scenarios next', {
      metadata: { type: 'plan', next_session: true, status: 'active' },
    })).nodeId
    // The tag machinery works — the pointer IS visible where it lives.
    // Without this control, a broken next_session tag greens the Then.
    expect(scout.status().resumePointers.map((p) => p.nodeId)).toContain(w.nodeId)
  })
  reg.define(/^the project namespace calls status$/, (w: NamespacesWorld) => {
    w.pointerIds = w.store!.status().resumePointers.map((p) => p.nodeId)
  })
  reg.define(/^that plan is not among the project's resume pointers$/, (w: NamespacesWorld) => {
    expect(w.pointerIds!).not.toContain(w.nodeId)
  })

  // ── dedup never reaches across namespaces ────────────────────────────
  reg.define(/^two writers journaling into separate namespaces$/, async (w: NamespacesWorld) => {
    await openNamespacePair(w, 'agent-a', 'agent-b')
  })
  reg.define(/^identical auto-captured content arrives in each$/, async (w: NamespacesWorld) => {
    const content = 'auto-captured: retention sweep finished with zero evictions'
    const meta = { source: 'auto-capture', session_id: 'sess-shared' }
    w.insertResult = await w.store!.insert(content, { metadata: { ...meta } })
    w.insertResultB = await w.storeB!.insert(content, { metadata: { ...meta } })
  })
  reg.define(/^each namespace holds its own distinct entry$/, async (w: NamespacesWorld) => {
    expect(w.insertResultB!.deduplicated ?? false).toBe(false)
    expect(w.insertResultB!.nodeId).not.toBe(w.insertResult!.nodeId)
    expect(rawNamespaceRows(w, 'agent-a')).toHaveLength(1)
    expect(rawNamespaceRows(w, 'agent-b')).toHaveLength(1)
    // Discriminating control: the same pair DOES collapse inside one
    // namespace — same content, session, and window. Namespace is the
    // only variable separating the two outcomes.
    const again = await w.store!.insert('auto-captured: retention sweep finished with zero evictions', {
      metadata: { source: 'auto-capture', session_id: 'sess-shared' },
    })
    expect(again.deduplicated).toBe(true)
    expect(rawNamespaceRows(w, 'agent-a')).toHaveLength(1)
  })

  // ── a merge carries a subagent's journal into the trunk with provenance ──
  reg.define(/^a subagent namespace holding findings$/, async (w: NamespacesWorld) => {
    const [, scout] = await openNamespacePair(w, 'project', 'scout')
    await scout.insert('finding: the retention valve measured characters, not bytes')
    await scout.insert('finding: dedup lost suppression when sessions interleaved')
    // Raw library writes carry no provenance of their own — if
    // `_namespace` shows up in the trunk, the MERGE stamped it (the gap
    // the feature's own comment names; F5's second half).
    for (const row of rawNamespaceRows(w, 'scout')) {
      expect(row.metadata['_namespace']).toBeUndefined()
    }
  })
  reg.define(/^a merge from that namespace into the project runs$/, (w: NamespacesWorld) => {
    w.mergeCount = w.store!.mergeFromNamespace('scout', { label: 'scout-close-out' }).importedCount
  })
  reg.define(/^the entries are queryable from the project namespace$/, async (w: NamespacesWorld) => {
    expect(w.mergeCount).toBe(2)
    expect(await w.store!.query('retention valve measured characters')).toHaveLength(1)
    expect(await w.store!.query('dedup lost suppression')).toHaveLength(1)
  })
  reg.define(/^each merged entry records the namespace it came from$/, (w: NamespacesWorld) => {
    const merged = rawNamespaceRows(w, 'project')
    expect(merged).toHaveLength(2)
    for (const row of merged) {
      expect(row.metadata['_namespace']).toBe('scout')
      // R3's label half: recorded ON the entries, not just echoed.
      expect(row.metadata['_merge_label']).toBe('scout-close-out')
    }
  })

  // ── a merge can carry a single entry, not the whole branch ───────────
  reg.define(/^a subagent namespace holding many entries$/, async (w: NamespacesWorld) => {
    const [, scout] = await openNamespacePair(w, 'project', 'scout')
    w.siblingContents = [
      'branch entry one: flamewatch profiling notes',
      'branch entry two: quotaguard rollout notes',
      'branch entry three: signalmap tracing notes',
    ]
    w.nodeIds = []
    for (const c of w.siblingContents) w.nodeIds.push((await scout.insert(c)).nodeId)
  })
  reg.define(/^a merge names one entry id$/, (w: NamespacesWorld) => {
    // Pins R3: the implementation ignored opts.nodeId and merged the
    // whole branch (importedCount 3).
    w.mergeCount = w.store!.mergeFromNamespace('scout', { label: 'cherry-pick', nodeId: w.nodeIds![1]! }).importedCount
  })
  reg.define(/^only that entry lands in the trunk, with provenance stamped$/, (w: NamespacesWorld) => {
    expect(w.mergeCount).toBe(1)
    const trunk = rawNamespaceRows(w, 'project')
    expect(trunk).toHaveLength(1)
    expect(trunk[0]!.content).toBe(w.siblingContents![1])
    expect(trunk[0]!.metadata['_namespace']).toBe('scout')
    expect(trunk[0]!.metadata['_merge_label']).toBe('cherry-pick')
  })
  reg.define(/^the rest of the branch stays where it was$/, (w: NamespacesWorld) => {
    const branch = rawNamespaceRows(w, 'scout').map((r) => r.content).sort()
    expect(branch).toEqual([...w.siblingContents!].sort())
  })

  // ── merging the same lane twice adds nothing (D144) ──────────────────
  reg.define(/^a subagent namespace whose session repeated one tool output more than five minutes apart$/, async (w: NamespacesWorld) => {
    const [, scout] = await openNamespacePair(w, 'project', 'scout')
    // Two legitimate observations of ONE tool output in ONE session,
    // further apart than DEDUP_WINDOW_SECS (300): the lane keeps both,
    // which is correct — and is exactly the pair the merge's content
    // predicate could not keep straight across runs.
    const content = 'Tool: Read\nInput: {"file_path":"CLAUDE.md"}\nOutput: # Working on treecontext REPEAT9143'
    const opts = { sourceLabel: 'auto-capture', metadata: { session_id: 'sess-lane', role: 'tool', tool_name: 'Read' } }
    w.nodeIds = []
    w.nodeIds.push((await scout.insert(content, { ...opts, createdAt: T0 })).nodeId)
    const second = await scout.insert(content, { ...opts, createdAt: T0 + 1000 })
    expect(second.deduplicated, 'the lane must hold both observations').toBe(false)
    w.nodeIds.push(second.nodeId)
    expect(rawNamespaceRows(w, 'scout')).toHaveLength(2)
  })
  reg.define(/^that namespace has been merged into the trunk once$/, (w: NamespacesWorld) => {
    const first = w.store!.mergeFromNamespace('scout', { label: 'wave' })
    expect(first.importedCount).toBe(2)
    expect(rawNamespaceRows(w, 'project')).toHaveLength(2)
  })
  reg.define(/^the same merge runs again$/, (w: NamespacesWorld) => {
    // Three repeats, the tester's cadence in miniature: every run after
    // the first must be exactly zero, not approximately zero.
    w.mergeCount = 0
    w.mergeRepeats = []
    for (let i = 0; i < 3; i++) {
      const r = w.store!.mergeFromNamespace('scout', { label: 'wave' })
      w.mergeCount += r.importedCount
      w.mergeRepeats.push(r)
    }
  })
  reg.define(/^no entry is added to the trunk$/, (w: NamespacesWorld) => {
    expect(w.mergeCount, 'a repeated merge re-imported rows').toBe(0)
    expect(rawNamespaceRows(w, 'project'), 'the trunk grew on a repeated merge').toHaveLength(2)
    // The already-carried class is disclosed as its own number, so a
    // re-run's zero reads as "all present", not as "nothing to merge".
    for (const r of w.mergeRepeats!) {
      expect(r.skippedAlreadyMerged).toBe(2)
      expect(r.skippedDuplicate).toBe(0)
    }
  })
  reg.define(/^each trunk copy still names the source entry it came from$/, (w: NamespacesWorld) => {
    const pointers = rawNamespaceRows(w, 'project').map((r) => r.metadata['_merged_from_node_id'])
    expect(new Set(pointers)).toEqual(new Set(w.nodeIds))
  })

  // ── a namespace cannot merge into itself ─────────────────────────────
  reg.define(/^a store whose current namespace is the trunk$/, async (w: NamespacesWorld) => {
    const store = await openLiveStore(w) // default namespace: 'project'
    await store.insert('trunk entry standing guard')
  })
  reg.define(/^a merge names the current namespace as its source$/, (w: NamespacesWorld) => {
    try {
      w.store!.mergeFromNamespace('project', { label: 'self' })
      w.mergeError = undefined
    } catch (err) {
      w.mergeError = err
    }
  })
  reg.define(/^the merge is refused with an error naming the namespace$/, (w: NamespacesWorld) => {
    expect(w.mergeError, 'self-merge was accepted').toBeTruthy()
    expect(String((w.mergeError as Error).message)).toContain("'project'")
    // Refused means refused: nothing was copied.
    expect(rawNamespaceRows(w, 'project')).toHaveLength(1)
  })

  // ── clearing one namespace leaves the others whole ───────────────────
  reg.define(/^two populated namespaces in one store file$/, async (w: NamespacesWorld) => {
    const [a, b] = await openNamespacePair(w, 'agent-a', 'agent-b')
    await a.insert('surviving alpha note about lockfiles')
    await a.insert('surviving alpha note about migrations')
    await b.insert('doomed beta note about scaffolding')
  })
  reg.define(/^one namespace is explicitly cleared$/, (w: NamespacesWorld) => {
    const res = w.storeB!.clear()
    expect(res.previousNodeCount, 'the clear had nothing to clear').toBe(1)
  })
  reg.define(/^the other namespace's entries remain intact and queryable$/, async (w: NamespacesWorld) => {
    expect(rawNamespaceRows(w, 'agent-a')).toHaveLength(2)
    expect((await w.store!.query('surviving alpha note')).length).toBe(2)
    expect(rawNamespaceRows(w, 'agent-b')).toHaveLength(0) // …and the cleared one is empty
  })

  // ── servers on different namespaces of one store serve concurrently ──
  //
  // The production lease client on the production lease table —
  // coexistence is the point (C2), so both acquisitions must SUCCEED,
  // and the third, same-namespace attempt must fail naming its target.
  // Distinct pids simulate distinct server processes: leases never
  // probe pids, so identity is purely what the row records.
  reg.define(/^a server holding the tool-writer role for one namespace$/, (w: NamespacesWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-nslease-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'nslease.db')
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath))
    runMigrations(db, { migrate: true })
    w.leaseDb = db
    w.defer(() => db.close())
    new LeaseClient(db, { pid: 11111, host: hostname() }).tryAcquire('ns:agent-a', NS_LEASE_TTL_SECS)
  })
  reg.define(/^a second server takes the tool-writer role for a different namespace of the same store$/, (w: NamespacesWorld) => {
    new LeaseClient(w.leaseDb!, { pid: 22222, host: hostname() }).tryAcquire('ns:agent-b', NS_LEASE_TTL_SECS)
  })
  reg.define(/^both hold their roles at once$/, (w: NamespacesWorld) => {
    const holders = new Map(leaseHolders(w.leaseDb!).map((l) => [l.role, l]))
    expect(holders.get('ns:agent-a')?.holderPid).toBe(11111)
    expect(holders.get('ns:agent-a')?.live).toBe(true)
    expect(holders.get('ns:agent-b')?.holderPid).toBe(22222)
    expect(holders.get('ns:agent-b')?.live).toBe(true)
    // Case-collision proofing (program-C review, finding 6): namespaces
    // differing only in case are distinct lease rows — the role column
    // is BINARY-collated TEXT, so no filesystem case-folding can merge
    // them (the hazard the retired lockfile paths had to hash around).
    new LeaseClient(w.leaseDb!, { pid: 33333, host: hostname() }).tryAcquire('ns:Agent-a', NS_LEASE_TTL_SECS)
    expect(leaseHolders(w.leaseDb!).filter((l) => l.role.toLowerCase() === 'ns:agent-a')).toHaveLength(2)
  })
  reg.define(/^a third server naming an already-held namespace serves alongside the holder, which keeps the primary claim$/, async (w: NamespacesWorld) => {
    // The lease still refuses it, naming the namespace — the claim is
    // single, and that is the half amendment 8 (2026-08-20) kept.
    const third = new LeaseClient(w.leaseDb!, { pid: 44444, host: hostname() })
    expect(() => third.tryAcquire('ns:agent-a', NS_LEASE_TTL_SECS)).toThrow(/Namespace 'agent-a'.*Only one writer per namespace/)
    // Serving is what no longer depends on winning it: the same refusal,
    // taken through serve's hook, leaves the tool call working.
    const store = await FlatStore.open({ database: w.leaseDb!, namespace: 'agent-a', ownsDatabase: false })
    w.defer(() => store.close())
    w.store = store
    const client = await mcpOver(w, { lockHook: nsClaimHook(w.leaseDb!, 'agent-a', 44444) })
    const res = await client.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'THIRDSERVER7712: an unclaimed server writing into the claimed namespace' },
    })
    expect((res as { isError?: boolean }).isError, JSON.stringify((res as { content: unknown }).content)).toBeFalsy()
    const rows = rawNamespaceRows(w, 'agent-a')
    expect(rows.map((r) => r.content)).toContain('THIRDSERVER7712: an unclaimed server writing into the claimed namespace')
    // And the claim did not move under it.
    const holder = leaseHolders(w.leaseDb!).find((l) => l.role === 'ns:agent-a')
    expect(holder?.holderPid).toBe(11111)
    expect(holder?.live).toBe(true)
  })

  // ── two servers sharing one namespace keep their sessions apart ──────
  //
  // The ruling that retired the same-namespace refusal (amendment 8,
  // 2026-08-20) was conditional on attribution: two conversations may
  // share a namespace only while every row still names its own. Two
  // connections and two pids are two server processes over one file —
  // leases never probe pids, so identity is purely what the row records
  // — and the session identity is passed the way a daemon passes it, as
  // the server's explicit ccSessionId.
  reg.define(/^two servers over the same namespace of one store, each with its own session$/, async (w: NamespacesWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-nsshared-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'shared-ns.db')
    w.nsShared = []
    for (const [pid, sessionId] of [[81111, 'cc-share-alpha'], [82222, 'cc-share-beta']] as const) {
      const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath))
      const store = await FlatStore.open({ database: db, namespace: 'project', ownsDatabase: true })
      w.defer(() => store.close())
      w.store = store
      w.leaseDb = w.leaseDb ?? db // the first server's handle, for reading the claim
      const client = await mcpOver(w, {
        ccSessionId: sessionId,
        info: { storePath: w.dbPath },
        lockHook: nsClaimHook(db, 'project', pid),
      })
      w.nsShared.push({ sessionId, client, contents: [], nodeIds: [], queryHits: 0, failures: [] })
    }
  })
  reg.define(/^each of them inserts and queries through its own tools$/, async (w: NamespacesWorld) => {
    const record = (server: { failures: string[] }, what: string, res: unknown): Record<string, unknown> => {
      if ((res as { isError?: boolean }).isError) {
        server.failures.push(`${what}: ${JSON.stringify((res as { content: unknown }).content)}`)
      }
      return parseTool(res)
    }
    // Interleaved, not sequenced: the two servers take turns on the one
    // namespace, which is the shape the field report described.
    for (let i = 0; i < 3; i++) {
      for (const server of w.nsShared!) {
        const content = `SHAREDNS note ${i} of ${server.sessionId} :: two servers, one namespace, one store file`
        const parsed = record(server, 'insert', await server.client.callTool({
          name: 'treecontext_insert', arguments: { content },
        }))
        server.contents.push(content)
        if (parsed['node_id']) server.nodeIds.push(String(parsed['node_id']))
      }
    }
    for (const server of w.nsShared!) {
      const parsed = record(server, 'query', await server.client.callTool({
        // top_k above the six rows on purpose: the read must be capable
        // of returning the OTHER server's entries too, so a short result
        // is isolation, not a budget.
        name: 'treecontext_query', arguments: { query: 'SHAREDNS note two servers one namespace', top_k: 10 },
      }))
      server.queryHits = (parsed['results'] as unknown[] | undefined)?.length ?? 0
    }
  })
  reg.define(/^every one of those tool calls succeeds$/, (w: NamespacesWorld) => {
    for (const server of w.nsShared!) {
      expect(server.failures, `${server.sessionId} had failing tool calls`).toEqual([])
      expect(server.nodeIds, `${server.sessionId} lost an insert`).toHaveLength(3)
      // Reads answer on both too — six rows are in the shared namespace,
      // and neither server is querying a private view of it.
      expect(server.queryHits, `${server.sessionId} saw no hits`).toBe(6)
    }
    // Contention was genuine: one claim, held by the first server, while
    // the second served the whole scenario without it.
    const holders = leaseHolders(w.leaseDb!).filter((l) => l.role === 'ns:project')
    expect(holders).toHaveLength(1)
    expect(holders[0]!.holderPid).toBe(81111)
    expect(holders[0]!.live).toBe(true)
  })
  reg.define(/^each entry carries the session identity of the server that wrote it$/, (w: NamespacesWorld) => {
    const rows = sharedNamespaceRows(w)
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      const writer = w.nsShared!.find((s) => row.content.includes(s.sessionId))!
      expect(writer, `no server owns ${row.content}`).toBeTruthy()
      // The store's own attribution column, not just the annotation: a
      // stamping regression that left session_key NULL fails here.
      expect(row.sessionKey, `session_key on ${row.content}`).toBe(writer.sessionId)
      expect(row.meta['_cc_session_id']).toBe(writer.sessionId)
      expect(row.meta['_cc_session_src']).toBe('explicit')
      expect(row.meta['_cc_session_ambiguous']).toBeUndefined()
    }
  })
  reg.define(/^each session's conversation is reconstructable from its session key alone$/, (w: NamespacesWorld) => {
    const byKey = new Map<string, string[]>()
    for (const row of sharedNamespaceRows(w)) {
      byKey.set(row.sessionKey, [...(byKey.get(row.sessionKey) ?? []), row.content])
    }
    expect([...byKey.keys()].sort()).toEqual(w.nsShared!.map((s) => s.sessionId).sort())
    for (const server of w.nsShared!) {
      // Exactly its own — nothing of the other conversation, nothing of
      // its own missing.
      expect([...byKey.get(server.sessionId)!].sort()).toEqual([...server.contents].sort())
    }
  })

  // ── the drain serves namespaces nobody is serving ────────────────────
  reg.define(/^staged events stamped for a namespace with no live server$/, async (w: NamespacesWorld) => {
    await openCaptureWorld(w)
    // Staged the way hooks stage (direct row, no lock), stamped for a
    // namespace whose server has exited — nothing serves 'agent-ghost'.
    w.store!.store.insertStaging({
      sessionId: 'ghost-sess', role: 'user', priority: 1, timestamp: 1_700_000_000,
      content: 'GHOSTFACT5519: found by a session whose server is gone',
      namespace: 'agent-ghost',
    })
  })
  reg.define(/^the drain owner drains$/, async (w: NamespacesWorld) => {
    await drainStaging(w)
  })
  reg.define(/^those events land in that namespace's journal, created on demand$/, (w: NamespacesWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      const rows = raw.prepare(
        "SELECT t.namespace AS ns FROM nodes n JOIN trees t ON n.tree_id = t.tree_id WHERE n.content LIKE '%GHOSTFACT5519%'",
      ).all() as Array<{ ns: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.ns).toBe('agent-ghost')
    } finally {
      raw.close()
    }
  })
  // S: auto-capture lands in the namespace of the session that produced it.
  //
  // Rebound in the SHIPPED configuration (audit D3; design note §C1): the
  // world's store — the drain owner — sits on the trunk, exactly as
  // production launches it. The subagent's identity travels the real
  // channel: its serving process wrote a namespace annotation (production
  // writer; this test process stands in for both claude and that server,
  // which is what makes the hook's own-ppid + live-server_pid rung hold),
  // a REAL hook subprocess resolves it and stamps the staging row, and
  // the trunk-owned drain attributes the row into the subagent's tree.
  // The old binding drained through a store handle opened directly under
  // the subagent namespace — a configuration nobody ships.
  reg.define(/^a subagent session journaling under its own namespace$/, async (w: NamespacesWorld) => {
    await openCaptureWorld(w)
    // No cleanup needed: annotations are never unlinked in production
    // either (guards defuse leftovers), and the world's temp dir dies
    // with the scenario.
    writeNamespaceAnnotation(w.dbPath!, process.pid, 'agent-sub')
    // A real subagent server holds `ns:agent-sub` (cli.ts serve takes it
    // at startup, and the shipped MCP launcher runs serve). This fixture
    // stands in for that server, so it must stand in for the lease too —
    // the annotation alone no longer speaks for a server (ruling
    // 2026-08-16), and without this the scenario would be testing an
    // arrangement the product never produces.
    {
      const raw = new BetterSqlite3(w.dbPath!)
      try {
        raw.prepare(
          'INSERT OR REPLACE INTO leases (role, holder_pid, holder_host, holder_token, holder_label, acquired_at, heartbeat_at, ttl_secs) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run('ns:agent-sub', process.pid, hostname(), 'tok', null, Date.now() / 1000, Date.now() / 1000, NS_LEASE_TTL_SECS)
      } finally {
        raw.close()
      }
    }
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'SUBFACT7731: the subagent found the drain valve regression',
    })
  })
  reg.define(/^its captured events are ingested$/, async (w: NamespacesWorld) => {
    await drainStaging(w)
  })
  reg.define(/^those entries live in the subagent's namespace$/, (w: NamespacesWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      const rows = raw.prepare(
        "SELECT t.namespace AS ns FROM nodes n JOIN trees t ON n.tree_id = t.tree_id WHERE n.content LIKE '%SUBFACT7731%'",
      ).all() as Array<{ ns: string }>
      expect(rows.length).toBeGreaterThanOrEqual(1)
      for (const r of rows) expect(r.ns).toBe('agent-sub')
    } finally {
      raw.close()
    }
  })
  reg.define(/^the project namespace gains them only through an explicit merge$/, async (w: NamespacesWorld) => {
    // The world's store already IS the trunk (the shipped drain owner) —
    // no handle swap: the drain ran here and must not have leaked the
    // subagent's capture into its own namespace.
    const trunk = w.store!
    const before = await trunk.query('SUBFACT7731', { topK: 5 })
    expect(before.some((r) => r.content.includes('SUBFACT7731')), 'capture leaked into the trunk without a merge').toBe(false)

    const client = await mcpOver(w)
    await client.callTool({
      name: 'treecontext_merge_from_agent',
      arguments: { source_namespace: 'agent-sub', label: 'subagent-findings' },
    })
    const after = await trunk.query('SUBFACT7731', { topK: 5 })
    const merged = after.find((r) => r.content.includes('SUBFACT7731'))
    expect(merged, 'the merge must deliver the capture').toBeTruthy()
    expect(merged!.metadata!['_namespace'], 'merged provenance must name the source').toBe('agent-sub')
  })

  // S: merged provenance is filterable and weightable at query time.
  //
  // Both halves bind against the server — the product's outer face — per
  // the surface note: exclusion is enforced in-store before the result
  // budget fills, down-weighting is applied at the MCP surface over
  // returned scores. The baseline order is asserted first so "ranked
  // lower" is a demonstrated REORDER, not an accident of the corpus.
  reg.define(/^merged entries carrying a source namespace$/, async (w: NamespacesWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'journal.db')
    const agentB = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true, namespace: 'agent-b',
    })
    // Stronger BM25 for the merged row: the token twice — so the
    // baseline ranks it ABOVE the trunk row and the down-weight has a
    // reorder to perform.
    await agentB.insert('ZEBRAPLAN ZEBRAPLAN: the subagent draft of the zebra plan', {
      metadata: { type: 'note' }, createdAt: T0,
    })
    agentB.close()

    const trunk = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true,
    })
    w.defer(() => trunk.close())
    w.store = trunk
    await trunk.insert('ZEBRAPLAN: the trunk note referencing the zebra plan once', {
      metadata: { type: 'note' }, createdAt: T0 + 10,
    })
    const client = await mcpOver(w)
    await client.callTool({
      name: 'treecontext_merge_from_agent',
      arguments: { source_namespace: 'agent-b', label: 'agent-b-findings' },
    })
  })
  reg.define(/^a query excludes that namespace$/, async (w: NamespacesWorld) => {
    w.nsExcluded = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'ZEBRAPLAN', top_k: 5, exclude_namespaces: ['agent-b'] },
    }))['results'] as Array<{ content: string; metadata?: Record<string, unknown> }>
  })
  reg.define(/^those entries are absent from the results$/, (w: NamespacesWorld) => {
    expect(w.nsExcluded!.length).toBeGreaterThanOrEqual(1)
    for (const r of w.nsExcluded!) {
      // step-lint: allow unearned-absence -- guarded: this same step asserts a trunk-note row IS returned, and the next Then's unfiltered baseline query over the same store finds the merged 'subagent draft' row (its presence guard) — exclusion, not emptiness; no earlier step queries agent-b rows
      expect(r.metadata?.['_namespace'], 'an excluded-namespace row leaked past the filter').not.toBe('agent-b')
    }
    expect(w.nsExcluded!.some((r) => r.content.includes('trunk note'))).toBe(true)
  })
  reg.define(/^a query that down-weights the namespace instead returns them ranked lower$/, async (w: NamespacesWorld) => {
    // findIndex's -1 makes absence read as rank-first, so every needle
    // gets an explicit presence guard before any order comparison — a
    // silently failed merge must fail the fixture guard, not green the
    // reorder (third-pass review).
    const rank = (rows: Array<{ content: string }>, needle: string): number => {
      const i = rows.findIndex((r) => r.content.includes(needle))
      expect(i, `'${needle}' missing from the results entirely`).toBeGreaterThanOrEqual(0)
      return i
    }
    const baseline = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'ZEBRAPLAN', top_k: 5 },
    }))['results'] as Array<{ content: string }>
    expect(rank(baseline, 'subagent draft'), 'fixture: the merged row must outrank the trunk row untouched')
      .toBeLessThan(rank(baseline, 'trunk note'))

    const weighted = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'ZEBRAPLAN', top_k: 5, namespace_weights: { 'agent-b': 0.1 } },
    }))['results'] as Array<{ content: string }>
    expect(rank(weighted, 'trunk note'), 'down-weighting must reorder below the trunk row')
      .toBeLessThan(rank(weighted, 'subagent draft'))
  })

}

