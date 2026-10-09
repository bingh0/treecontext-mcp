/**
 * flat-store-conversation-window.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim. W1-W9,
 * default settled by the EW1-EW4 experiment verdicts: ships opt-in
 * (default 0). Ten scenarios share the "queried with conversation_window N"
 * When — one regex definition querying the Given-staged needle; the two
 * "the hit's anchor is null" Thens merge over world state. Store close
 * moved to per-fixture defer, close-before-rm (Windows constraint).)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { parseToolResult } from '../helpers/mcp-result.js'
import type { QueryResult, WindowEntry } from '../../src/core/types.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  db?: Database
  store?: FlatStore
  /** Staged by Givens for the shared "queried with conversation_window N" When. */
  queryTerm?: string
  results?: QueryResult[]
  ids?: string[]
  hitId?: string
  x1?: string
  x2?: string
  x3?: string
  weakEarly?: string
  strongLate?: string
  e3?: string
  hitA?: string
  hitB?: string
  neighborContent?: string
  hitContent?: string
  directiveId?: string
  anchor?: { content: string; truncated?: boolean } | undefined
  withZero?: QueryResult[]
  withoutOpt?: QueryResult[]
  response?: { results: Array<{ nodeId: string; window?: { before: unknown[]; after: unknown[] } }> }
  client?: Client
  server?: Awaited<ReturnType<typeof createServer>>
}

/** This tier reads tool responses loosely — the shared cast lives in
 *  helpers/mcp-result, the loose shape stays local. */
const parse = (res: unknown): any => parseToolResult(res)

export const flatStoreConversationWindowDefiner = (reg: Registry<World>): void => {
  async function freshStore(w: World, name = 'flat.db'): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-window-'))
    // Registered before the store's close defer: defer runs LIFO, so the
    // store closes before its directory unlinks (the Windows constraint —
    // an unclosed store passes on POSIX and fails the whole file on Windows,
    // in teardown, with every assertion green).
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => store.close())
    w.db = db
    w.store = store
  }

  /** Insert a node and pin its created_at directly (raw SQL) — insert() only
   *  ever stamps "now", and the window/anchor mechanics are order-sensitive. */
  async function insertAt(
    w: World,
    content: string,
    opts: { createdAt: number; sessionId?: string; role?: string; toolName?: string },
  ): Promise<string> {
    const metadata: Record<string, unknown> = { source: 'auto-capture' }
    if (opts.sessionId !== undefined) metadata['session_id'] = opts.sessionId
    if (opts.role !== undefined) metadata['role'] = opts.role
    if (opts.toolName !== undefined) metadata['tool_name'] = opts.toolName
    const res = await w.store!.insert(content, { metadata })
    w.db!.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(opts.createdAt, res.nodeId)
    return res.nodeId
  }

  function byId(entries: WindowEntry[], nodeId: string): WindowEntry | undefined {
    return entries.find((e) => e.nodeId === nodeId)
  }

  reg.define(/^a 7-entry single session with a query hit on the middle entry$/, async (w) => {
    await freshStore(w)
    w.ids = []
    w.queryTerm = 'needleAlpha'
    for (let i = 1; i <= 7; i++) {
      const content = i === 4 ? 'needleAlpha entry four' : `filler entry ${String(i)}`
      w.ids.push(await insertAt(w, content, { createdAt: i, sessionId: 's1' }))
    }
  })

  reg.define(/^a hit on the first entry of its session, preceded only by a different session's entries$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'other session filler one', { createdAt: 1, sessionId: 'other' })
    await insertAt(w, 'other session filler two', { createdAt: 2, sessionId: 'other' })
    await insertAt(w, 'other session filler three', { createdAt: 3, sessionId: 'other' })
    w.hitId = await insertAt(w, 'needleFirst only entry in its session', { createdAt: 10, sessionId: 'mine' })
    w.queryTerm = 'needleFirst'
  })

  reg.define(/^two sessions interleaved in created_at with a hit in one of them$/, async (w) => {
    await freshStore(w)
    w.queryTerm = 'needleInterleave'
    w.x1 = await insertAt(w, 'x session filler one', { createdAt: 1, sessionId: 'x' })
    await insertAt(w, 'y session filler one', { createdAt: 2, sessionId: 'y' })
    w.x2 = await insertAt(w, 'needleInterleave x session hit', { createdAt: 3, sessionId: 'x' })
    await insertAt(w, 'y session filler two', { createdAt: 4, sessionId: 'y' })
    w.x3 = await insertAt(w, 'x session filler two', { createdAt: 5, sessionId: 'x' })
    await insertAt(w, 'y session filler three', { createdAt: 6, sessionId: 'y' })
  })

  reg.define(/^a hit whose metadata carries none of session_id, _cc_session_id, or _session_id$/, async (w) => {
    await freshStore(w)
    const res = await w.store!.insert('needleNoSession orphaned entry', { metadata: { source: 'auto-capture', role: 'user' } })
    w.hitId = res.nodeId
    w.db!.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(1, w.hitId!)
    w.queryTerm = 'needleNoSession'
  })

  reg.define(/^a session where the query matches an entry that is also adjacent to itself in time$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'before filler', { createdAt: 1, sessionId: 's1' })
    w.hitId = await insertAt(w, 'needleSelf adjacency check', { createdAt: 2, sessionId: 's1' })
    await insertAt(w, 'after filler', { createdAt: 3, sessionId: 's1' })
    w.queryTerm = 'needleSelf'
  })

  reg.define(/^two hits one entry apart in the same session and conversation_window 3$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'e1 filler', { createdAt: 1, sessionId: 's1' })
    // Rank and time DISAGREE (round-2 R7): the later hit repeats the
    // term and outranks the earlier one lexically, so "higher-ranked"
    // and "first in returned order" name different rows under
    // chronological sort.
    w.weakEarly = await insertAt(w, 'needleShared position beta one', { createdAt: 2, sessionId: 's1' })
    w.e3 = await insertAt(w, 'e3 contested filler', { createdAt: 3, sessionId: 's1' })
    w.strongLate = await insertAt(w, 'needleShared needleShared needleShared position beta two', {
      createdAt: 4,
      sessionId: 's1',
    })
    await insertAt(w, 'e5 filler', { createdAt: 5, sessionId: 's1' })
  })

  reg.define(/^two hits close enough that each falls inside the other's window$/, async (w) => {
    await freshStore(w)
    w.hitA = await insertAt(w, 'clamshellToken alpha side', { createdAt: 1, sessionId: 's1' })
    await insertAt(w, 'plain filler between them', { createdAt: 2, sessionId: 's1' })
    w.hitB = await insertAt(w, 'clamshellToken beta side', { createdAt: 3, sessionId: 's1' })
  })

  reg.define(/^a session containing one neighbor entry longer than 700 characters and a hit with a longer body$/, async (w) => {
    await freshStore(w)
    w.neighborContent = 'neighborLongMarker ' + 'pad'.repeat(300) // > 700 chars
    w.hitContent = 'needleLongHit ' + 'body'.repeat(400) // > 700 chars too, but never truncated
    await insertAt(w, w.neighborContent, { createdAt: 1, sessionId: 's1' })
    await insertAt(w, w.hitContent, { createdAt: 2, sessionId: 's1' })
    w.queryTerm = 'needleLongHit'
  })

  reg.define(/^a capture-burst session where several entries share one created_at timestamp$/, async (w) => {
    await freshStore(w)
    w.ids = []
    w.queryTerm = 'needleBurst'
    const contents = ['burst one', 'burst two', 'needleBurst hit three', 'burst four', 'burst five']
    for (const c of contents) {
      w.ids.push(await insertAt(w, c, { createdAt: 100, sessionId: 's1' }))
    }
  })

  reg.define(/^a session and a query that produces hits$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'needleRegression first', { createdAt: 1, sessionId: 's1' })
    await insertAt(w, 'needleRegression second', { createdAt: 2, sessionId: 's1' })
  })

  reg.define(/^a session with a user directive followed by a deep burst of non-user entries$/, async (w) => {
    await freshStore(w)
    w.directiveId = await insertAt(w, 'directive alpha content', { createdAt: 1, sessionId: 's1', role: 'user' })
    for (let i = 2; i <= 9; i++) {
      await insertAt(w, `burst entry ${String(i)}`, { createdAt: i, sessionId: 's1', role: 'assistant' })
    }
    await insertAt(w, 'needleDeep buried hit', { createdAt: 10, sessionId: 's1', role: 'assistant' })
  })

  reg.define(/^a session whose nearest preceding user message is longer than the anchor bound$/, async (w) => {
    await freshStore(w)
    // The anchor must sit OUTSIDE the neighbor range — otherwise it is
    // claimed as a neighbor first and returned as a {ref}, which is the
    // separate "referenced, not duplicated" scenario.
    await insertAt(w, 'u '.repeat(3000) + 'directiveTailWord', {
      createdAt: 1,
      sessionId: 's1',
      role: 'user',
    })
    await insertAt(w, 'filler one between', { createdAt: 2, sessionId: 's1' })
    await insertAt(w, 'filler two between', { createdAt: 3, sessionId: 's1' })
    await insertAt(w, 'anchorProbeToken assistant reply', { createdAt: 4, sessionId: 's1' })
  })

  reg.define(/^a hit whose own entry has role user$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'needleUserHit itself is the directive', { createdAt: 1, sessionId: 's1', role: 'user' })
    w.queryTerm = 'needleUserHit'
  })

  reg.define(/^a hit whose nearest preceding user message already appears in its own before-window$/, async (w) => {
    await freshStore(w)
    w.directiveId = await insertAt(w, 'directive ref content', { createdAt: 1, sessionId: 's1', role: 'user' })
    await insertAt(w, 'needleRef hit right after directive', { createdAt: 2, sessionId: 's1', role: 'assistant' })
    w.queryTerm = 'needleRef'
  })

  reg.define(/^a hit whose session has no preceding user message, but an earlier different session does$/, async (w) => {
    await freshStore(w)
    await insertAt(w, 'other session directive', { createdAt: 1, sessionId: 'other', role: 'user' })
    await insertAt(w, 'needleCrossSession hit with no in-session directive', {
      createdAt: 10, sessionId: 'mine', role: 'assistant',
    })
    w.queryTerm = 'needleCrossSession'
  })

  reg.define(/^a server over a lexical store with a multi-entry session fixture$/, async (w) => {
    await freshStore(w, 'mcp.db')
    w.server = createServer(w.store!, {})
    const [ct, st] = InMemoryTransport.createLinkedPair()
    w.client = new Client({ name: 't', version: '0' })
    await w.server.connect(st)
    await w.client.connect(ct)
    w.defer(async () => {
      await w.client!.close()
      await w.server!.close()
    })
    const contents = ['mcp one', 'mcp two', 'needleMcp middle hit', 'mcp four', 'mcp five']
    for (const c of contents) {
      await w.client.callTool({
        name: 'treecontext_insert',
        arguments: { content: c, metadata: { session_id: 'mcp-session' } },
      })
    }
  })

  // Ten scenarios share this When (conversation_window 2 ×6, 3 ×2, 1, 5),
  // identical but for the Given-staged needle and the captured N.
  reg.define(/^queried with conversation_window (\d+)$/, async (w, n) => {
    w.results = await w.store!.query(w.queryTerm!, { topK: 5, conversationWindow: Number(n) })
  })

  reg.define(/^the query runs under relevance ordering$/, async (w) => {
    w.results = await w.store!.query('needleShared', { topK: 5, conversationWindow: 3 })
  })

  reg.define(/^the query runs with a conversation window$/, async (w) => {
    w.results = await w.store!.query('clamshellToken', { topK: 5, conversationWindow: 3 })
  })

  reg.define(/^queried once with conversation_window 0 and once with conversation_window omitted$/, async (w) => {
    w.withZero = await w.store!.query('needleRegression', { topK: 5, conversationWindow: 0 })
    w.withoutOpt = await w.store!.query('needleRegression', { topK: 5 })
  })

  reg.define(/^a hit deep in the burst is queried with conversation_window 1$/, async (w) => {
    w.results = await w.store!.query('needleDeep', { topK: 5, conversationWindow: 1 })
  })

  reg.define(/^a later entry is queried with a conversation window$/, async (w) => {
    const hits = await w.store!.query('anchorProbeToken', { topK: 3, conversationWindow: 1 })
    expect(hits).toHaveLength(1)
    w.anchor = hits[0]!.window!.anchor as { content: string; truncated?: boolean }
  })

  reg.define(/^treecontext_query is called with conversation_window 2$/, async (w) => {
    w.response = parse(
      await w.client!.callTool({
        name: 'treecontext_query',
        arguments: { query: 'needleMcp', top_k: 5, conversation_window: 2 },
      }),
    )
  })

  reg.define(/^the hit's window has 2 before entries and 2 after entries in chronological order$/, (w) => {
    expect(w.results).toHaveLength(1)
    expect(w.results![0]!.nodeId).toBe(w.ids![3])
    const window = w.results![0]!.window!
    expect(window.before.map((e) => e.nodeId)).toEqual([w.ids![1], w.ids![2]])
    expect(window.after.map((e) => e.nodeId)).toEqual([w.ids![4], w.ids![5]])
  })

  reg.define(/^the window has 0 before entries and no entries from the other session$/, (w) => {
    expect(w.results).toHaveLength(1)
    expect(w.results![0]!.nodeId).toBe(w.hitId)
    expect(w.results![0]!.window!.before).toHaveLength(0)
  })

  reg.define(
    /^every window entry belongs to the hit's own session even though the other session's entries are closer in time$/,
    (w) => {
      expect(w.results).toHaveLength(1)
      expect(w.results![0]!.nodeId).toBe(w.x2)
      const window = w.results![0]!.window!
      expect(window.before.map((e) => e.nodeId)).toEqual([w.x1])
      expect(window.after.map((e) => e.nodeId)).toEqual([w.x3])
    },
  )

  reg.define(/^window\.omitted is "no-session-key" and both before and after are empty$/, (w) => {
    expect(w.results).toHaveLength(1)
    const window = w.results![0]!.window!
    expect(window.omitted).toBe('no-session-key')
    expect(window.before).toHaveLength(0)
    expect(window.after).toHaveLength(0)
  })

  reg.define(/^the hit's own nodeId never appears in its before or after arrays$/, (w) => {
    const window = w.results![0]!.window!
    expect(window.before.map((e) => e.nodeId)).not.toContain(w.hitId)
    expect(window.after.map((e) => e.nodeId)).not.toContain(w.hitId)
  })

  reg.define(
    /^the shared entry between them appears in only the stronger hit's window and never in both$/,
    (w) => {
      expect(w.results![0]!.nodeId, 'fixture precondition: the repeated-term hit must rank first').toBe(w.strongLate)
      const strongWindow = w.results!.find((r) => r.nodeId === w.strongLate)!.window!
      const weakWindow = w.results!.find((r) => r.nodeId === w.weakEarly)!.window!
      expect(byId(strongWindow.before, w.e3!)).toBeDefined()
      expect(byId(weakWindow.after, w.e3!)).toBeUndefined()
      expect(byId(weakWindow.before, w.e3!)).toBeUndefined()
      const allIds = [...strongWindow.before, ...strongWindow.after, ...weakWindow.before, ...weakWindow.after].map(
        (e) => e.nodeId,
      )
      expect(new Set(allIds).size).toBe(allIds.length)
    },
  )

  reg.define(/^the same query under chronological ordering gives it to the earlier hit instead$/, async (w) => {
    const chrono = await w.store!.query('needleShared', {
      topK: 5,
      conversationWindow: 3,
      sortBy: 'chronological',
    })
    expect(chrono.map((r) => r.nodeId)).toEqual([w.weakEarly, w.strongLate])
    expect(byId(chrono[0]!.window!.after, w.e3!), 'first-returned hit claims the contested neighbor').toBeDefined()
    expect(byId(chrono[1]!.window!.before, w.e3!)).toBeUndefined()
  })

  reg.define(/^neither hit appears in the other's before or after$/, (w) => {
    expect(w.results).toHaveLength(2)
    const wA = w.results!.find((r) => r.nodeId === w.hitA)!.window!
    const wB = w.results!.find((r) => r.nodeId === w.hitB)!.window!
    const neighborsOfA = [...wA.before, ...wA.after].map((e) => e.nodeId)
    const neighborsOfB = [...wB.before, ...wB.after].map((e) => e.nodeId)
    expect(neighborsOfA).not.toContain(w.hitB)
    expect(neighborsOfB).not.toContain(w.hitA)
    // …and neither is its own neighbor either.
    expect(neighborsOfA).not.toContain(w.hitA)
    expect(neighborsOfB).not.toContain(w.hitB)
  })

  reg.define(
    /^the neighbor is head-truncated with a truncation marker and truncated true, and the hit content is returned in full untruncated$/,
    (w) => {
      const hit = w.results![0]!
      expect(hit.content).toBe(w.hitContent)
      const neighbor = hit.window!.before[0]!
      expect(neighbor.truncated).toBe(true)
      expect(neighbor.content.startsWith(w.neighborContent!.slice(0, 700))).toBe(true)
      expect(neighbor.content).toContain('…[truncated')
      expect(neighbor.content).toContain(`${String(w.neighborContent!.length - 700)} chars]`)
    },
  )

  reg.define(/^the window orders the tied entries by insertion \(rowid\) order$/, (w) => {
    expect(w.results).toHaveLength(1)
    expect(w.results![0]!.nodeId).toBe(w.ids![2])
    const window = w.results![0]!.window!
    expect(window.before.map((e) => e.nodeId)).toEqual([w.ids![0], w.ids![1]])
    expect(window.after.map((e) => e.nodeId)).toEqual([w.ids![3], w.ids![4]])
  })

  reg.define(/^both results are byte-identical and neither carries a window field$/, (w) => {
    expect(w.withZero).toEqual(w.withoutOpt)
    for (const r of [...w.withZero!, ...w.withoutOpt!]) expect(r.window).toBeUndefined()
  })

  reg.define(/^the hit's anchor is the nearest preceding user message in its session$/, (w) => {
    const anchor = w.results![0]!.window!.anchor
    expect(anchor).not.toBeNull()
    expect((anchor as WindowEntry).nodeId).toBe(w.directiveId)
    expect((anchor as WindowEntry).content).toBe('directive alpha content')
    expect((anchor as WindowEntry).role).toBe('user')
  })

  reg.define(/^the anchor is truncated at the anchor bound, not the neighbor bound$/, (w) => {
    expect(w.anchor, 'no anchor returned').toBeDefined()
    // The distinguishing observable: the anchor keeps decisively more
    // than a NEIGHBOR would (700) and no more than its own bound (2000).
    // A regression to the neighbor bound, or to unbounded, fails here.
    expect(w.anchor!.content.length).toBeGreaterThan(1000)
    expect(w.anchor!.content.length).toBeLessThanOrEqual(2100)
    // step-lint: allow unearned-absence -- guarded: the Given seeds directiveTailWord at the very end of a 6000-plus-char user message, past the anchor bound, so its absence proves the anchor was cut; the length assertions just above (over 1000, at most 2100) prove the cut fell at the anchor bound, not the neighbor's
    expect(w.anchor!.content).not.toContain('directiveTailWord')
  })

  // Merged: scenarios "a hit that is itself a user message has no anchor"
  // and "the anchor is drawn only from the hit's own session" assert the
  // identical observable over world state; executes once per scenario.
  reg.define(/^the hit's anchor is null$/, (w) => {
    expect(w.results![0]!.window!.anchor).toBeNull()
  })

  reg.define(/^the anchor is a ref to that nodeId instead of a duplicated entry$/, (w) => {
    const window = w.results![0]!.window!
    expect(window.before.map((e) => e.nodeId)).toContain(w.directiveId)
    expect(window.anchor).toEqual({ ref: w.directiveId })
  })

  reg.define(/^the response results carry a window with before\/after entries$/, async (w) => {
    expect(w.response!.results).toHaveLength(1)
    const window = w.response!.results[0]!.window!
    expect(window).toBeDefined()
    expect(Array.isArray(window.before)).toBe(true)
    expect(Array.isArray(window.after)).toBe(true)
    expect(window.before.length + window.after.length).toBeGreaterThan(0)
    // Control (audit run 1): 2 is DEFAULT_CONVERSATION_WINDOW, so a
    // server that silently dropped the parameter would still pass the
    // assertions above. The hit sits mid-session with two neighbors
    // on each side, so re-querying at 1 must shrink the window.
    const narrowed = parse(
      await w.client!.callTool({
        name: 'treecontext_query',
        arguments: { query: 'needleMcp', top_k: 5, conversation_window: 1 },
      }),
    )
    const wide = window.before.length + window.after.length
    const tight =
      narrowed.results[0]!.window!.before.length + narrowed.results[0]!.window!.after.length
    expect(tight).toBeLessThan(wide)
  })
}
