import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { SessionStats } from '../../../src/server/session-stats.js'
import { T0, mcpOver, parseTool, openLiveStore, reopenAsLaterSession, exportNode } from '../world.js'
import { type CaptureWorld, openCaptureWorld, spawnHook, drainStaging } from '../capture-harness.js'

// ── journal-recall ──────────────────────────────────────────────────────


/**
 * The recall wave's world. It extends CaptureWorld for the index-cap
 * scenario, which drives the real hook route end to end (env -> subprocess
 * -> staging.index_len -> FTS view) rather than inserting through the API.
 */
export interface RecallWorld extends CaptureWorld {
  /** Recall latency scenario: the parsed treecontext_status panel. */
  statusPanel?: Record<string, unknown>
}
export const recallDefiner = (reg: Registry<RecallWorld>): void => {
  const PLAN_TEXT = 'PLAN: rework the ingestion valve — drain-all first, then tombstone ordering, then the budget report'

  // Broad orientation query — bound 2026-08-01 with the recency-default
  // ruling (the MCP surface serves recency_weight 0.5 unless opted out).
  reg.define(/^several sessions of journaled work on distinct topics$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    // The OLDEST thread is deliberately the strongest lexical match for
    // the orientation query — pure BM25 ranks it first. Only recency
    // fusion puts the latest thread on top, which is the promise here.
    w.oldId = (await w.store!.insert(
      'Working on the ingestion valve refactor. Next step was tombstone ordering; next step after that, the budget report. Working through it step by step — refactor complete.',
      { metadata: { source: 'auto-capture', role: 'user', session_id: 'sess-old' } },
    )).nodeId
    const fillers: string[] = []
    for (let i = 0; i < 6; i++) {
      fillers.push((await w.store!.insert(
        `working notes on distinct topic ${['bench corpus pinning', 'hooks doc rewrite', 'lint debt sweep', 'migration ladder', 'archive layout', 'skill wording'][i]}`,
        { metadata: { source: 'auto-capture', role: 'user', session_id: `sess-mid-${i}` } },
      )).nodeId)
    }
    w.freshId = (await w.store!.insert(
      'PLAN: working on the release checklist; next step is the signing-key rotation',
      { metadata: { type: 'plan', session_id: 'sess-new', status: 'active' } },
    )).nodeId
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      const set = raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?')
      set.run(T0, w.oldId)
      fillers.forEach((id, i) => set.run(T0 + 600 * (i + 1), id))
      set.run(T0 + 7200, w.freshId)
    } finally {
      raw.close()
    }
  })
  reg.define(/^the agent queries "what was I working on, what was the next step"$/, async (w: RecallWorld) => {
    const client = await mcpOver(w)
    w.mcpResponse = parseTool(await client.callTool({
      name: 'treecontext_query',
      arguments: { query: 'what was I working on, what was the next step', top_k: 5 },
    }))
  })
  reg.define(/^the most recent active thread ranks above older completed ones$/, async (w: RecallWorld) => {
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(ids[0], 'latest active thread is not the top hit').toBe(w.freshId)
    expect(ids, 'older thread fell out of the results entirely').toContain(w.oldId)
    // Fixture proof: with fusion explicitly off, the old thread's lexical
    // strength wins — the served default is what reordered.
    const optOut = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'what was I working on, what was the next step', top_k: 5, recency_weight: 0 },
    }))
    const pureIds = (optOut['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(pureIds[0], 'fixture is not discriminating: old thread must win pure BM25').toBe(w.oldId)
  })

  // Resume pointers.
  reg.define(/^a prior session tagged a plan node with next_session true$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeId = (await w.store!.insert(PLAN_TEXT, { metadata: { type: 'plan', next_session: true } })).nodeId
  })
  reg.define(/^a new session calls status$/, async (w: RecallWorld) => {
    await reopenAsLaterSession(w)
  })
  reg.define(/^the plan appears as a resume pointer with a preview$/, (w: RecallWorld) => {
    const pointer = w.store!.status().resumePointers.find((p) => p.nodeId === w.nodeId)
    expect(pointer, 'plan is not among the resume pointers').toBeTruthy()
    expect(pointer!.preview.length).toBeGreaterThan(0)
    expect(PLAN_TEXT.startsWith(pointer!.preview.slice(0, 20))).toBe(true)
  })
  reg.define(/^exporting the pointer's node id returns the full plan text$/, (w: RecallWorld) => {
    expect(exportNode(w, w.nodeId!)['content']).toBe(PLAN_TEXT)
  })

  // Exact identifier recall.
  reg.define(/^a prior session recorded a specific finding naming a symbol or file$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeId = (
      await w.store!.insert('Found the rowid tie-break inverted in FlatStore.attachWindows — neighbors crossed sessions')
    ).nodeId
  })
  reg.define(/^a later session searches for that identifier$/, async (w: RecallWorld) => {
    await reopenAsLaterSession(w)
    w.results = await w.store!.query('attachWindows', { topK: 5 })
  })
  reg.define(/^the original entry is a top result with its content intact$/, (w: RecallWorld) => {
    expect(w.results!.length).toBeGreaterThan(0)
    expect(w.results![0]!.nodeId).toBe(w.nodeId)
    expect(w.results![0]!.content).toBe('Found the rowid tie-break inverted in FlatStore.attachWindows — neighbors crossed sessions')
  })

  // Conversation window + anchor.
  reg.define(/^a query hit from the middle of a prior session$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const session = 'recall-window-session'
    const mk = (content: string, role: string, at: number) =>
      w.store!.insert(content, { metadata: { source: 'auto-capture', role, session_id: session }, createdAt: at })
    // The user message sits FAR enough back that a window of 2 cannot
    // reach it — the anchor mechanism, not neighbor overlap, must carry it.
    w.nodeIds = [
      (await mk('please investigate the flaky checkpoint test', 'user', T0)).nodeId,
      (await mk('Tool: Read — checkpoint.test.ts, 210 lines', 'tool', T0 + 10)).nodeId,
      (await mk('Tool: Grep — setTimeout usage in checkpoint paths, 3 hits', 'tool', T0 + 20)).nodeId,
      (await mk('Tool: Read — retry helper implementation, 80 lines', 'tool', T0 + 30)).nodeId,
      (await mk('Tool: Bash — vitest run checkpoint, 1 flake in 50 runs reproduced', 'tool', T0 + 40)).nodeId,
      (await mk('Tool: Read — fake timers documentation', 'tool', T0 + 50)).nodeId,
    ]
  })
  reg.define(/^the query requests a conversation window$/, async (w: RecallWorld) => {
    w.results = await w.store!.query('flake reproduced vitest', { topK: 1, conversationWindow: 2 })
    expect(w.results).toHaveLength(1)
    expect(w.results![0]!.nodeId).toBe(w.nodeIds![4])
  })
  reg.define(/^the surrounding entries from the same session accompany the hit in order$/, (w: RecallWorld) => {
    const win = w.results![0]!.window
    expect(win, 'hit carries no window').toBeTruthy()
    expect(win!.before.map((e) => e.nodeId)).toEqual([w.nodeIds![2], w.nodeIds![3]])
    expect(win!.after.map((e) => e.nodeId)).toEqual([w.nodeIds![5]])
    const times = [...win!.before, ...win!.after].map((e) => e.createdAt)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
  reg.define(/^the nearest preceding user message is attached as the anchor$/, (w: RecallWorld) => {
    const anchor = w.results![0]!.window!.anchor
    expect(anchor, 'no anchor attached').toBeTruthy()
    // Out of window reach, so the anchor must arrive as a full entry
    // (the { ref } form is only for an anchor already present as a
    // neighbor), carrying the directive the window alone cannot recover.
    expect(anchor).toHaveProperty('nodeId', w.nodeIds![0])
    expect((anchor as { content: string }).content).toContain('flaky checkpoint test')
  })

  // Temporal access.
  reg.define(/^work journaled across multiple days$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const DAY = 86_400
    w.nodeIds = []
    for (let day = 0; day < 3; day++) {
      for (let i = 0; i < 2; i++) {
        w.nodeIds.push(
          (await w.store!.insert(`journal fact day${day + 1} item${i + 1}`, { createdAt: T0 + day * DAY + i * 60 })).nodeId,
        )
      }
    }
  })
  reg.define(/^the agent queries with a time range and chronological ordering$/, async (w: RecallWorld) => {
    // Both bounds are inclusive (created_at >= after AND <= before), so the
    // window brackets day 2 with clearance on each side.
    const DAY = 86_400
    w.results = await w.store!.query('journal fact', {
      topK: 10,
      timeRange: { after: T0 + DAY - 30, before: T0 + DAY + 90 },
      sortBy: 'chronological',
    })
  })
  reg.define(/^results are the entries from that window, oldest first$/, (w: RecallWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toEqual([w.nodeIds![2], w.nodeIds![3]])
    const times = w.results!.map((r) => r.createdAt)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  // Whole-message return for conversational roles.
  const DIRECTIVE = 'never delete the production database without a checked backup'
  const NOTE_FINAL = 'DECISION: eviction stays whole-session; fragments are forbidden'
  reg.define(/^a user message whose final sentence is a critical "never do X" directive$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const long = `context preamble about the deploy pipeline ${'and its many stages '.repeat(150)}. ${DIRECTIVE}`
    expect(long.length).toBeGreaterThan(2000) // beyond INDEX_CAP_USER: return must not clip to the indexed head
    w.nodeIds = [
      (await w.store!.insert(long, { metadata: { source: 'auto-capture', role: 'user', session_id: 's-whole' } })).nodeId,
    ]
    w.descriptions = [long]
  })
  reg.define(/^a long curated note whose final line records the decision it exists for$/, async (w: RecallWorld) => {
    const note = `debugging trail for the eviction work ${'with intermediate observations '.repeat(120)}. ${NOTE_FINAL}`
    w.nodeIds!.push((await w.store!.insert(note, { metadata: { role: 'note' } })).nodeId)
    w.descriptions!.push(note)
  })
  reg.define(/^any part of either matches a query$/, async (w: RecallWorld) => {
    const users = await w.store!.query('deploy pipeline preamble', { topK: 5 })
    const notes = await w.store!.query('debugging trail eviction', { topK: 5 })
    w.results = [
      users.find((r) => r.nodeId === w.nodeIds![0])!,
      notes.find((r) => r.nodeId === w.nodeIds![1])!,
    ]
    expect(w.results[0], 'user message is not a hit').toBeTruthy()
    expect(w.results[1], 'curated note is not a hit').toBeTruthy()
  })
  reg.define(/^each full text is returned with no truncation$/, (w: RecallWorld) => {
    expect(w.results![0]!.content).toBe(w.descriptions![0])
    expect(w.results![0]!.content).toContain(DIRECTIVE)
    expect(w.results![1]!.content).toBe(w.descriptions![1])
    expect(w.results![1]!.content).toContain(NOTE_FINAL)
  })

  // ── temporal questions can read newest first ────────────────────────
  reg.define(/^the agent queries with reverse chronological ordering$/, async (w: RecallWorld) => {
    w.results = await w.store!.query('journal fact', { topK: 6, sortBy: 'reverse_chronological' })
  })
  reg.define(/^results are the matching entries, newest first$/, (w: RecallWorld) => {
    expect(w.results!.length).toBe(6)
    const times = w.results!.map((r) => r.createdAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  // ── a metadata filter narrows recall to matching entries only ───────
  reg.define(/^entries carrying distinct metadata key-value pairs$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeIds = []
    w.nodeIds.push(
      (await w.store!.insert('filtered fact: valve calibration ruling', { metadata: { topic: 'valve', phase: 'beta' } })).nodeId,
      (await w.store!.insert('filtered fact: valve sweep note', { metadata: { topic: 'valve', phase: 'alpha' } })).nodeId,
      (await w.store!.insert('filtered fact: codec ruling', { metadata: { topic: 'codec', phase: 'beta' } })).nodeId,
    )
  })
  reg.define(/^a query passes a metadata filter requiring two pairs$/, async (w: RecallWorld) => {
    w.results = await w.store!.query('filtered fact', {
      topK: 5,
      metadataFilter: { topic: 'valve', phase: 'beta' },
    })
  })
  reg.define(/^only entries carrying both pairs are returned$/, (w: RecallWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toEqual([w.nodeIds![0]])
  })
  reg.define(/^the same query without the filter also surfaces the others$/, async (w: RecallWorld) => {
    const all = await w.store!.query('filtered fact', { topK: 5 })
    expect(all.map((r) => r.nodeId).sort()).toEqual([...w.nodeIds!].sort())
  })

  // ── superseding a missing id succeeds and names the miss ────────────
  reg.define(/^a live plan from a prior session$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeId = (
      await w.store!.insert('active plan: ship the beta', { metadata: { next_session: true, type: 'plan' } })
    ).nodeId
  })
  reg.define(/^a close-out is inserted with supersedes naming that plan and one nonexistent id$/, async (w: RecallWorld) => {
    w.insertResult = await w.store!.insert('close-out: beta shipped', {
      supersedes: [w.nodeId!, 'feedbeef00000000000000000000dead'],
    })
  })
  reg.define(/^the live plan stops being a resume pointer$/, (w: RecallWorld) => {
    const meta = exportNode(w, w.nodeId!)['metadata'] as Record<string, unknown>
    expect(meta['next_session']).toBeFalsy()
    expect(meta['superseded_by']).toBeTruthy()
  })
  reg.define(/^the insert succeeds with the missing id reported, not silently dropped$/, (w: RecallWorld) => {
    const res = w.insertResult!
    expect(res.nodeId).toBeTruthy()
    expect(res.superseded).toEqual([w.nodeId])
    expect(res.supersedeMisses).toEqual([{ nodeId: 'feedbeef00000000000000000000dead', reason: 'not_found' }])
  })

  // ── a very long conversational message is findable by any of its words ─
  // (index-cap expansion: authored text indexes in full by default)
  const LONG_DIRECTIVE = 'never rotate the signing key without the escrow custodian present'
  const PASTE_TOKEN = 'ERR_CONNTRACK_TABLE_FULL_7731'
  reg.define(/^a user message far beyond the old index caps, with a pasted log in the middle$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const paste =
      `[pasted log]\nline 1 ok\nline 2 ${PASTE_TOKEN} dropping packets\n` +
      'filler log line with routine noise\n'.repeat(200)
    w.descriptions = [`deploy context preamble. ${'context sentence filler. '.repeat(300)}\n${paste}`]
  })
  reg.define(/^a closing directive in its final sentence$/, async (w: RecallWorld) => {
    const content = `${w.descriptions![0]!}\nClosing: ${LONG_DIRECTIVE}.`
    w.descriptions = [content]
    w.nodeId = (
      await w.store!.insert(content, {
        // Shaped as user-prompt-submit stages it: full content, _index_len
        // stamped to the full length (activeIndexCap('user') is Infinity
        // unless TREECONTEXT_INDEX_CAP narrows it).
        metadata: { source: 'auto-capture', role: 'user', session_id: 's-long', _index_len: content.length },
      })
    ).nodeId
  })
  reg.define(/^a later session searches for words from that directive$/, async (w: RecallWorld) => {
    w.results = await w.store!.query('escrow custodian signing key', { topK: 5 })
  })
  reg.define(/^the message is a hit, returned in full$/, (w: RecallWorld) => {
    const hit = w.results!.find((r) => r.nodeId === w.nodeId)
    expect(hit, 'directive words did not find the long message').toBeTruthy()
    expect(hit!.content).toBe(w.descriptions![0])
  })
  reg.define(/^words appearing only inside the pasted middle also find it$/, async (w: RecallWorld) => {
    const hits = await w.store!.query(PASTE_TOKEN, { topK: 5 })
    expect(hits.map((r) => r.nodeId)).toContain(w.nodeId)
  })

  // ── a tool event's searchable reach extends past its displayed preview ─
  // (post-018 split: _preview_len is the display cut, _index_len the wider
  // searchable boundary)
  const REACH_TOKEN = 'conntrack_reach_token_5519'
  reg.define(/^a tool event whose indexed view reaches beyond its display preview$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const preview = 'Tool: Bash\nOutput:\nreach preview head line'
    const content =
      `${preview}\nextended diagnostics ${REACH_TOKEN} deep in the widened view\n` +
      'routine padding diagnostics line\n'.repeat(40)
    w.descriptions = [content, preview]
    w.nodeId = (
      await w.store!.insert(content, {
        metadata: {
          source: 'auto-capture',
          role: 'tool',
          session_id: 's-reach',
          _preview_len: preview.length,
          _index_len: content.length,
        },
      })
    ).nodeId
  })
  reg.define(/^a query matches words that sit past the preview but inside the indexed view$/, async (w: RecallWorld) => {
    w.results = await w.store!.query(REACH_TOKEN, { topK: 5 })
  })
  reg.define(/^the event is a hit$/, (w: RecallWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId)
  })
  reg.define(/^the hit's content still ends at the display preview with the availability marker$/, (w: RecallWorld) => {
    const hit = w.results!.find((r) => r.nodeId === w.nodeId)!
    expect(hit.content.startsWith(w.descriptions![1]!)).toBe(true)
    expect(hit.content).toMatch(/…\[preview; full content \d+ chars via treecontext_export\]$/)
    expect(hit.content).not.toContain(REACH_TOKEN)
  })

  // C4 preview + marker for oversized tool events.
  reg.define(/^a tool event whose full content exceeds the preview bound$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const full = `Tool: Bash — full build log follows\n${'compiling module and emitting diagnostics line\n'.repeat(120)}`
    w.descriptions = [full]
    w.nodeId = (
      await w.store!.insert(full, {
        metadata: { source: 'auto-capture', role: 'tool', session_id: 's-c4', _index_len: 1000 },
      })
    ).nodeId
  })
  reg.define(/^it appears in query results$/, async (w: RecallWorld) => {
    w.results = await w.store!.query('build log diagnostics', { topK: 5 })
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId)
  })
  reg.define(/^the preview ends with an availability marker naming the export escape hatch$/, (w: RecallWorld) => {
    const hit = w.results!.find((r) => r.nodeId === w.nodeId)!
    expect(hit.content.length).toBeLessThan(w.descriptions![0]!.length)
    expect(hit.content).toMatch(/…\[preview; full content \d+ chars via treecontext_export\]$/)
  })
  reg.define(/^export of that node returns the full content byte-for-byte$/, (w: RecallWorld) => {
    expect(exportNode(w, w.nodeId!)['content']).toBe(w.descriptions![0])
  })

  // Supersession.
  reg.define(/^a new close-out inserted with supersedes listing the old plan$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeIds = [(await w.store!.insert(PLAN_TEXT, { metadata: { type: 'plan', next_session: true } })).nodeId]
    w.nodeIds.push(
      (
        await w.store!.insert('CLOSE-OUT: valve rework shipped; ordering and budget report live', {
          metadata: { type: 'progress', next_session: true },
          supersedes: [w.nodeIds[0]!],
        })
      ).nodeId,
    )
  })
  reg.define(/^the next session calls status$/, async (w: RecallWorld) => {
    await reopenAsLaterSession(w)
  })
  reg.define(/^the old plan is no longer a resume pointer$/, (w: RecallWorld) => {
    const ids = w.store!.status().resumePointers.map((p) => p.nodeId)
    expect(ids).not.toContain(w.nodeIds![0])
    expect(ids).toContain(w.nodeIds![1])
  })
  reg.define(/^it remains fully queryable as history$/, async (w: RecallWorld) => {
    const hits = await w.store!.query('rework the ingestion valve', { topK: 5 })
    expect(hits.map((r) => r.nodeId)).toContain(w.nodeIds![0])
    expect(exportNode(w, w.nodeIds![0]!)['content']).toBe(PLAN_TEXT)
  })

  // Bounded orientation surface.
  reg.define(/^a store with dozens of accumulated resume pointers$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    w.nodeIds = []
    for (let i = 0; i < 25; i++) {
      w.nodeIds.push(
        (
          await w.store!.insert(`stale plan number ${i + 1} awaiting supersession`, {
            metadata: { next_session: true },
            createdAt: T0 + i * 60,
          })
        ).nodeId,
      )
    }
  })
  reg.define(/^a session calls status$/, () => {
    // Assertions live in the Then; the call is repeated there against the
    // same open store to keep the step order honest.
  })
  reg.define(/^only the newest bounded set is shown with an explicit count of the hidden rest$/, (w: RecallWorld) => {
    const status = w.store!.status()
    expect(status.resumePointers.length).toBeLessThan(25)
    expect(status.resumePointerTotal).toBe(25)
    // Newest first: the cap must elide the oldest, never the newest.
    expect(status.resumePointers.map((p) => p.nodeId)).toContain(w.nodeIds![24])
    expect(status.resumePointers.map((p) => p.nodeId)).not.toContain(w.nodeIds![0])
  })
  // S: retrieval performance is observable where the agent can act on it.
  //
  // Timings are INJECTED through CreateServerOptions.sessionStats — the
  // documented production seam — so the "persistently slow" condition is
  // established in zero wall-clock time: six recorded queries averaging
  // well past the 250ms hint threshold. The panel must carry the store's
  // size on disk, this session's latency, and the one lever the agent
  // can actually pull (TREECONTEXT_INDEX_CAP), in the same response.
  reg.define(/^a session that has run queries against a store$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    await w.store!.insert('an entry so the store has real bytes on disk', { metadata: { type: 'note' } })
    const stats = new SessionStats()
    for (let i = 0; i < 6; i++) stats.recordQuery('lexical', 400 + i * 10, 3)
    // info.storePath is how serve tells the server where the file lives
    // (db_bytes reads it) — the same wiring cli.ts does in production.
    await mcpOver(w, { sessionStats: stats, info: { storePath: w.dbPath! } })
  })
  reg.define(/^the agent calls status$/, async (w: RecallWorld) => {
    w.statusPanel = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
  })
  reg.define(/^the response reports the store size and this session's query latency$/, (w: RecallWorld) => {
    const retrieval = w.statusPanel!['retrieval'] as {
      db_bytes?: number
      query_latency_ms?: { count: number; mean: number; max: number }
    }
    expect(retrieval.db_bytes, 'store size missing from the panel').toBeGreaterThan(0)
    expect(retrieval.query_latency_ms?.count).toBe(6)
    expect(retrieval.query_latency_ms!.mean).toBeGreaterThan(250)
  })
  reg.define(/^persistently slow queries produce a hint naming the index-cap lever$/, (w: RecallWorld) => {
    const retrieval = w.statusPanel!['retrieval'] as { performance_hint?: string }
    expect(retrieval.performance_hint, 'no hint for a persistently slow session').toBeTruthy()
    expect(retrieval.performance_hint!).toContain('TREECONTEXT_INDEX_CAP')
  })

  // S: bounding the indexed view is a configuration choice, not the default.
  //
  // The knob travels its real route: process.env flows through
  // sandboxedEnv into the REAL hook subprocess, which stamps the resolved
  // cap into staging.index_len; ingestion carries it to the row and the
  // FTS view obeys it. Nothing here sets index lengths by hand.
  reg.define(/^a store whose operator capped new captures with the index-cap variable$/, async (w: RecallWorld) => {
    await openCaptureWorld(w)
    // Captured BEFORE the cap exists: full prose indexing is the default,
    // so its beyond-300 tail must stay searchable forever.
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `precap preamble ${'filler words about the migration plan '.repeat(12)}PRECAPTAIL9931 at the end`,
    })
    const prev = process.env['TREECONTEXT_INDEX_CAP']
    w.defer(() => {
      if (prev === undefined) delete process.env['TREECONTEXT_INDEX_CAP']
      else process.env['TREECONTEXT_INDEX_CAP'] = prev
    })
    process.env['TREECONTEXT_INDEX_CAP'] = '300' // the floor: smallest accepted value
  })
  reg.define(/^text longer than the cap is captured$/, async (w: RecallWorld) => {
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `CAPHEAD4417 capped prompt ${'filler words about the drain valve '.repeat(12)}CAPTAIL8850 at the end`,
    })
    await drainStaging(w)
  })
  reg.define(/^words beyond the cap in newly captured text do not match a search on their own$/, async (w: RecallWorld) => {
    const head = await w.store!.query('CAPHEAD4417', { topK: 5 })
    expect(head.some((r) => r.content.includes('CAPHEAD4417')), 'the in-cap head must match').toBe(true)
    const tail = await w.store!.query('CAPTAIL8850', { topK: 5 })
    expect(tail.some((r) => r.content.includes('CAPHEAD4417')), 'the beyond-cap tail must not match').toBe(false)
  })
  reg.define(/^entries captured before the cap was set keep their original searchable view$/, async (w: RecallWorld) => {
    const hits = await w.store!.query('PRECAPTAIL9931', { topK: 5 })
    expect(hits.some((r) => r.content.includes('PRECAPTAIL9931')), 'history was rewritten by the knob').toBe(true)
  })
  reg.define(/^a cap below the measured floor is ignored rather than obeyed$/, async (w: RecallWorld) => {
    process.env['TREECONTEXT_INDEX_CAP'] = '100' // below the 300 floor — must be ignored
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: `floor probe ${'filler words about the budget report '.repeat(12)}FLOORTAIL2214 at the end`,
    })
    await drainStaging(w)
    // Ignored means FULL prose indexing (the default), so the tail —
    // beyond both 100 and 300 — matches.
    const hits = await w.store!.query('FLOORTAIL2214', { topK: 5 })
    expect(hits.some((r) => r.content.includes('FLOORTAIL2214')), 'a sub-floor cap was obeyed').toBe(true)
  })

}

export const recallNoModelDefiner = (reg: Registry<RecallWorld>): void => {
  reg.define(/^a store on a machine with no ONNX runtime or model download$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    // "No ONNX runtime" is asserted on what can actually observe module
    // loading. The original check scanned require.cache, which can never
    // see ESM modules — it could not fail (audit run 1). The honest
    // observable: the package ships no inference/embedder dependency at
    // all, so nothing on the recall path exists to load or download a
    // model. If dense retrieval ever enters (the fence's fused,
    // opt-in seam), this binding updates with it — deliberately.
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const shipped = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]
    expect(shipped.filter((d) => /onnx|transformers|tensorflow|llama|embed/i.test(d))).toEqual([])
  })
  reg.define(/^an agent inserts an entry and queries for its words$/, async (w: RecallWorld) => {
    w.nodeId = (await w.store!.insert('the retention valve archives before it deletes')).nodeId
    w.results = await w.store!.query('retention valve archives', { topK: 5 })
  })
  reg.define(/^the entry is stored, found by BM25, and exported intact$/, (w: RecallWorld) => {
    expect(w.results!.map((r) => r.nodeId)).toContain(w.nodeId)
    expect(exportNode(w, w.nodeId!)['content']).toBe('the retention valve archives before it deletes')
  })
  reg.define(/^status reports the store as lexical with no degraded-mode warning$/, (w: RecallWorld) => {
    const status = w.store!.status()
    expect(status.backend).toBe('lexical')
    expect(status.staleSummaryCount).toBe(0) // nothing ever demands a summarize
  })
}

