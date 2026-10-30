import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { SessionStats } from '../../../src/server/session-stats.js'
import { FlatStore } from '../../../src/flat-store.js'
import { openNodeSqlite, pragmaValue, setPragma } from '../../../src/persistence/node-sqlite.js'
import { T0, mcpOver, parseTool, openLiveStore, reopenAsLaterSession, exportNode, rawAll } from '../world.js'
import { type CaptureWorld, openCaptureWorld, spawnHook, drainStaging } from '../capture-harness.js'
import { type MatureJournal, MATURE, seedMatureJournal, rawOutranking, ORIENTATION_QUERY, SHELL_ONLY_TERM } from '../../helpers/mature-journal.js'
import { type RawEcho, callEchoed, echoTool, ftsNodeIds, ftsVocab, rawEcho, rawEchoes } from '../../helpers/echo-capture.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { IngestionLoop } from '../../../src/server/ingestion.js'
import { maxSupportedVersion } from '../../../src/persistence/migrations/index.js'
import { RECOVERY_SNAPSHOT_SOURCE, RECOVERY_PREVIEW_LEN, RECOVERY_INDEX_LEN, RECOVERY_QUOTE_CAP } from '../../../src/persistence/recovery-snapshot.js'
import { REPLY_CEILING_BYTES } from '../../../src/server/reply-ceiling.js'

// ── journal-recall ──────────────────────────────────────────────────────


/**
 * The recall wave's world. It extends CaptureWorld for the index-cap
 * scenario, which drives the real hook route end to end (env -> subprocess
 * -> staging.index_len -> FTS view) rather than inserting through the API.
 */
export interface RecallWorld extends CaptureWorld {
  /** Recall latency scenario: the parsed treecontext_status panel. */
  statusPanel?: Record<string, unknown>
  /** The mature journal the broad-orientation scenarios seed (D266). */
  mature?: MatureJournal
  /** D261: the echoes a scenario drained, by tool, and the words it searches. */
  echoes?: Record<string, RawEcho>
  phrase?: string
  label?: string
  /** D261: the parsed results of a search the agent ran, in rank order. */
  hits?: Array<{ nodeId: string; content: string }>
  /** D286: the recovery snapshot under test, its far token and its source entries. */
  recovery?: { nodeId: string; full: string; farToken: string; previewWord: string; sourceIds: string[]; before?: string }
  /** D287: the serialized reply of the ceiling scenario and the oversized entry's id. */
  ceiling?: { text: string; parsed: Record<string, unknown>; bigId: string; bigLen: number }
  /** D261 upgrade: the echoes as the earlier treecontext left them, and as the first open left them. */
  echoesBefore?: RawEcho[]
  echoesAfterFirstOpen?: RawEcho[]
  vocabAfterFirstOpen?: string[]
  importedIds?: string[]
}
// ── Helpers for the D260/D261 bindings ─────────────────────────────────

/** Node ids matching a WHERE over `nodes`, read raw (verification rule). */
function rawAllIds(w: RecallWorld, where: string, ...params: unknown[]): string[] {
  const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
  try {
    return (raw.prepare(`SELECT node_id FROM nodes WHERE ${where} ORDER BY rowid`).all(...(params as never[])) as Array<{ node_id: string }>)
      .map((r) => r.node_id)
  } finally {
    raw.close()
  }
}

/** A row's metadata as SQLite holds it. */
function rawMetaOf(w: RecallWorld, nodeId: string): Record<string, unknown> {
  const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
  try {
    const row = raw.prepare('SELECT metadata_json FROM nodes WHERE node_id = ?').get(nodeId) as { metadata_json: string | null } | undefined
    expect(row, `no row ${nodeId}`).toBeTruthy()
    return JSON.parse(row!.metadata_json ?? '{}') as Record<string, unknown>
  } finally {
    raw.close()
  }
}

/** The agent's search: treecontext_query over the scenario's MCP client. */
async function agentSearch(w: RecallWorld, query: string, topK = 5): Promise<Array<{ nodeId: string; content: string }>> {
  const res = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query, top_k: topK } }))
  return res['results'] as Array<{ nodeId: string; content: string }>
}

/** A teammate's handoff: their own store's export of the given notes. */
async function teammateHandoff(w: RecallWorld, notes: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-teammate-'))
  w.defer(() => rmSync(dir, { recursive: true, force: true }))
  const theirs = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(join(dir, 'theirs.db'))), ownsDatabase: true })
  try {
    for (const n of notes) await theirs.insert(n, { metadata: { type: 'plan' } })
    return theirs.exportJson()
  } finally {
    await theirs.close()
  }
}

/** Open the scenario's store file the way a server starting on it would. */
async function reopenStore(w: RecallWorld): Promise<FlatStore> {
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true })
  w.defer(() => store.close())
  return store
}

/** The one echo of `tool` as the store holds it now. */
function echoOf(w: RecallWorld, tool: string): RawEcho {
  return rawEcho(w.dbPath!, tool)
}

/**
 * The 0.1.0-beta.1 drain, for a store "indexed in full by an earlier
 * treecontext": each staged row lands with the metadata that drain wrote
 * (source, role, session, tool, priority, the honest timestamps and the
 * hook's own boundaries) and no echo rule, through the store's ordinary
 * insert, so its index text is exactly beta.1's. That hook wrote no Label
 * line either, so an import echo's is taken out of the staged content (the
 * one composition change since; the import here fits its caps, so no
 * boundary moves with it).
 */
async function beta1Drain(w: RecallWorld): Promise<void> {
  const raw = new DatabaseSync(w.dbPath!)
  try {
    const rows = raw.prepare('SELECT id, session_id, role, content, tool_name, timestamp, priority, index_len, preview_len FROM staging WHERE processed = 0 ORDER BY id').all() as Array<{
      id: number; session_id: string | null; role: string; content: string; tool_name: string | null
      timestamp: number; priority: number; index_len: number | null; preview_len: number | null
    }>
    for (const r of rows) {
      let content = r.content
      if (r.tool_name === echoTool('treecontext_import')) {
        expect(r.index_len, 'the beta.1 import echo must fit its caps').toBeNull()
        content = content.replace(/^(Tool: [^\n]*\n)Label: [^\n]*\n/, '$1')
      }
      const meta: Record<string, unknown> = {
        source: 'auto-capture', role: r.role, session_id: r.session_id ?? undefined, tool_name: r.tool_name ?? undefined,
        priority: r.priority, created_at: r.timestamp, ingested_at: Date.now() / 1000,
      }
      if (r.index_len != null) meta['_index_len'] = r.index_len
      if (r.preview_len != null) meta['_preview_len'] = r.preview_len
      await w.store!.insert(content, { createdAt: r.timestamp, metadata: meta })
      raw.prepare('UPDATE staging SET processed = 1 WHERE id = ?').run(r.id)
    }
  } finally {
    raw.close()
  }
}

export const recallDefiner = (reg: Registry<RecallWorld>): void => {
  const PLAN_TEXT = 'PLAN: rework the ingestion valve — drain-all first, then tombstone ordering, then the budget report'

  // Broad orientation query — bound 2026-08-01 with the recency-default
  // ruling (the MCP surface serves recency_weight 0.5 unless opted out;
  // 0.25 since D273).
  // Re-seeded for the beta.2 cut (D266): the Given now seeds the mature
  // journal, where the oldest session's opening developer turn is the
  // strongest lexical match for the orientation query and the newest
  // session's active plan is the latest thread, among hundreds of captured
  // tool rows and echoes — so the latest thread must still win with tool
  // text at a tenth of the weight (D272). The Then is unchanged.
  reg.define(/^several sessions of journaled work on distinct topics$/, async (w: RecallWorld) => {
    w.mature = await seedMatureJournal(w)
    w.oldId = w.mature.oldThreadId
    w.freshId = w.mature.freshPlanId
  })
  reg.define(/^the agent queries "what was I working on, what was the next step"$/, async (w: RecallWorld) => {
    const client = await mcpOver(w)
    w.mcpResponse = parseTool(await client.callTool({
      name: 'treecontext_query',
      arguments: { query: 'what was I working on, what was the next step', top_k: 5 },
    }))
  })
  reg.define(/^the most recent active thread ranks above older completed ones$/, async (w: RecallWorld) => {
    const top = (w.mcpResponse!['results'] as Array<{ nodeId: string }>)[0]?.nodeId
    expect(top, 'latest active thread is not the top hit').toBe(w.freshId)
    // A page that holds both threads (the When's five does not, on a
    // mature journal): each thread is its session's rows, read from the
    // store's session_key column.
    const page = parseTool(await w.client!.callTool({
      name: 'treecontext_query', arguments: { query: 'what was I working on, what was the next step', top_k: 20 },
    }))
    const ids = (page['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    const keys = new Map(rawAll<{ node_id: string; session_key: string }>(w, 'SELECT node_id, session_key FROM nodes').map((r) => [r.node_id, r.session_key]))
    const latest = keys.get(w.freshId!)
    const older = keys.get(w.oldId!)
    expect(latest).not.toBe(older)
    const ranks = (thread: string | undefined): number[] => ids.flatMap((id, i) => (keys.get(id) === thread ? [i] : []))
    const latestRanks = ranks(latest)
    const olderRanks = ranks(older)
    expect(olderRanks.length, 'the page does not hold the older thread').toBeGreaterThan(0)
    expect(Math.min(...latestRanks), 'the latest thread does not lead the older one').toBeLessThan(Math.min(...olderRanks))
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(latestRanks), 'the latest thread\'s rows do not rank above the older thread\'s').toBeLessThan(mean(olderRanks))
    // Fixture proof: with fusion explicitly off, the old thread's lexical
    // strength wins — the served default is what reordered.
    const optOut = parseTool(await w.client!.callTool({
      name: 'treecontext_query',
      arguments: { query: 'what was I working on, what was the next step', top_k: 5, recency_weight: 0 },
    }))
    const pureIds = (optOut['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(pureIds[0], 'fixture is not discriminating: old thread must win pure BM25').toBe(w.oldId)
  })

  // ── D260: on a mature journal, directives and notes outrank tool output ──
  reg.define(/^a mature journal where captured tool output, echoes of earlier orientation queries among it, outnumbers the curated notes many times over and matches the query's own words$/, async (w: RecallWorld) => {
    w.mature = await seedMatureJournal(w)
    const c = w.mature.counts
    // The shape the Given claims, read from SQLite.
    expect(c.toolRows, 'tool rows must outnumber curated rows by an order of magnitude').toBeGreaterThanOrEqual(10 * c.curatedRows)
    expect(c.toolBytes, 'tool bytes must exceed curated bytes by more').toBeGreaterThan(20 * c.curatedBytes)
    expect(c.queryEchoes, 'every session opened with an orientation query').toBeGreaterThanOrEqual(5)
    // The tool output matches the query's own words, through the index.
    const toolIds = new Set(rawAllIds(w, "json_extract(metadata_json, '$.tool_name') IN ('Bash', 'Read', 'Grep')"))
    // For each word, at least as many shell rows as there are sessions
    // carry it, and taken together the tool rows matching the words
    // outnumber the curated rows that do.
    const curatedIds = new Set(rawAllIds(w, "COALESCE(json_extract(metadata_json, '$.source'), '') != 'auto-capture'"))
    const anyTool = new Set<string>()
    const anyCurated = new Set<string>()
    for (const word of ['working', 'next', 'step']) {
      const ids = ftsNodeIds(w.dbPath!, word)
      const shell = ids.filter((id) => toolIds.has(id))
      expect(shell.length, `shell output matching "${word}"`).toBeGreaterThanOrEqual(MATURE.sessionDays.length)
      for (const id of ids) {
        if (curatedIds.has(id)) anyCurated.add(id)
        else if (rawMetaOf(w, id)['tool_name'] != null) anyTool.add(id)
      }
    }
    expect(anyTool.size, 'tool rows matching the query words').toBeGreaterThan(2 * anyCurated.size)
  })
  reg.define(/^a developer turn or a curated note is the first result$/, async (w: RecallWorld) => {
    const first = (w.mcpResponse!['results'] as Array<{ nodeId: string; metadata: Record<string, unknown> | null }>)[0]
    expect(first, 'the orientation query returned nothing').toBeTruthy()
    const meta = rawMetaOf(w, first!.nodeId)
    const developerTurn = meta['source'] === 'auto-capture' && meta['role'] === 'user'
    const curated = meta['source'] !== 'auto-capture'
    expect(developerTurn || curated, `first result is ${JSON.stringify(meta['tool_name'] ?? meta['role'])}`).toBe(true)
    // Fixture proof (as the recency scenario's): the default tool weight is
    // what keeps the shell rows off the page. The When again, with the tool
    // weight back at the notes' 1.0, puts shell rows in the first twenty;
    // at the default none is there, nor in the first five served.
    // (Read twenty deep since D275: with the bookmark's score factor
    // retired the bookmarks, which carry "next step" by construction, and
    // the live chapter placed above them hold the first five at any tool
    // weight, so at 1.0 the first shell row is sixth on this fixture.)
    const SHELL = new Set(['Bash', 'Read', 'Grep'])
    const shellIn = (res: Record<string, unknown>, depth = 5): string[] => (res['results'] as Array<{ nodeId: string }>)
      .slice(0, depth).map((r) => r.nodeId).filter((id) => SHELL.has(String(rawMetaOf(w, id)['tool_name'])))
    const deep = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => parseTool(await w.client!.callTool({
      name: 'treecontext_query', arguments: { query: ORIENTATION_QUERY, top_k: 20, ...args },
    }))
    const atTie = await deep({ role_weights: { tool: 1.0 } })
    expect(shellIn(atTie, 20).length, 'fixture is not discriminating: at tool 1.0 shell rows must reach the first twenty').toBeGreaterThan(0)
    expect(shellIn(await deep({}), 20), 'shell rows in the first twenty at the default tool weight').toEqual([])
    expect(shellIn(w.mcpResponse!), 'shell rows in the first five at the default tool weight').toEqual([])
  })
  reg.define(/^no echo of an earlier orientation query is among the first five results$/, (w: RecallWorld) => {
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).slice(0, 5).map((r) => r.nodeId)
    expect(ids.length).toBe(5)
    for (const id of ids) {
      expect(rawMetaOf(w, id)['tool_name'], `an orientation-query echo ranks in the first five (${id})`).not.toBe(echoTool('treecontext_query'))
    }
  })
  reg.define(/^a shell tool event is still a hit for a term that appears only in its own output$/, async (w: RecallWorld) => {
    const res = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: SHELL_ONLY_TERM, top_k: 5 } }))
    const ids = (res['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(ids, 'a quarter weight hid the shell event').toContain(w.mature!.shellOnlyId)
    expect(rawMetaOf(w, w.mature!.shellOnlyId)['tool_name']).toBe('Bash')
  })

  // ── D261: an echo is found by its arguments, never by its results ──
  const NOTE_PHRASE = 'quillwort cadence'
  const NOTE = `DECISION: the ${NOTE_PHRASE} stays weekly; working on the rotation, next step is the signing ceremony.`
  reg.define(/^a journal holding a curated note, the echo of the insert that wrote it, the echo of an orientation query that returned it, and the echo of the status call that listed it as a resume pointer$/, async (w: RecallWorld) => {
    await openCaptureWorld(w)
    const client = await mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! } })
    const input = { content: NOTE, metadata: { type: 'decision', next_session: true } }
    const insert = await callEchoed(w, client, 'treecontext_insert', input)
    w.nodeId = String(insert.response['node_id'])
    const query = await callEchoed(w, client, 'treecontext_query', { query: ORIENTATION_QUERY, top_k: 5 })
    expect((query.response['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)).toContain(w.nodeId)
    const status = await callEchoed(w, client, 'treecontext_status', {})
    expect((status.response['resume_pointers'] as Array<{ node_id?: string; nodeId?: string }>)
      .map((p) => p.node_id ?? p.nodeId)).toContain(w.nodeId)
    for (const e of [insert, query, status]) spawnHook(w, 'post-tool-use', e.payload)
    await drainStaging(w)
    w.echoes = Object.fromEntries(['treecontext_insert', 'treecontext_query', 'treecontext_status'].map((t) => [t, rawEcho(w.dbPath!, t)]))
    // Every echo carries the note's phrase in what it stored.
    for (const e of Object.values(w.echoes)) expect(e.content, `${e.toolName} stored no copy of the note`).toContain(NOTE_PHRASE)
    w.phrase = NOTE_PHRASE
  })
  reg.define(/^the agent searches for a phrase that appears only in the note$/, async (w: RecallWorld) => {
    w.hits = await agentSearch(w, w.phrase!)
  })
  reg.define(/^the note is the hit and no echo is$/, (w: RecallWorld) => {
    const ids = w.hits!.map((h) => h.nodeId)
    expect(ids).toEqual([w.nodeId])
    // And the index itself, read raw: no echo holds a posting for the phrase.
    const echoIds = Object.values(w.echoes!).map((e) => e.nodeId)
    for (const word of w.phrase!.split(' ')) {
      expect(ftsNodeIds(w.dbPath!, word).filter((id) => echoIds.includes(id))).toEqual([])
    }
  })
  reg.define(/^a search for the orientation query's own words finds no echo$/, async (w: RecallWorld) => {
    const echoIds = Object.values(w.echoes!).map((e) => e.nodeId)
    const hits = (await agentSearch(w, ORIENTATION_QUERY, 10)).map((h) => h.nodeId)
    expect(hits, 'control: the query finds the note').toContain(w.nodeId)
    expect(hits.filter((id) => echoIds.includes(id))).toEqual([])
    // Raw: no query word holds a posting for any echo, though the query
    // echo stores them all in its Input.
    expect(w.echoes!['treecontext_query']!.content).toContain(ORIENTATION_QUERY)
    for (const word of ORIENTATION_QUERY.match(/[\p{L}\p{N}_]+/gu)!) {
      expect(ftsNodeIds(w.dbPath!, word).filter((id) => echoIds.includes(id)), `an echo is indexed by "${word}"`).toEqual([])
    }
  })
  reg.define(/^exporting any of the echoes returns its full input and output$/, async (w: RecallWorld) => {
    for (const e of Object.values(w.echoes!)) {
      const res = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: e.nodeId } }))
      const exported = JSON.stringify(res)
      // The whole stored content, Input and Output, comes back.
      expect(exported, `${e.toolName} export is not whole`).toContain(JSON.stringify(e.content).slice(1, -1))
      expect(e.content).toContain('\nInput:\n')
      expect(e.content).toContain('\nOutput:\n')
    }
  })
  reg.define(/^a hit on an echo shows its output$/, async (w: RecallWorld) => {
    // An echo is found by its tool name; the hit shows what the call returned.
    const echo = w.echoes!['treecontext_query']!
    const hit = (await agentSearch(w, 'treecontext_query', 10)).find((h) => h.nodeId === echo.nodeId)
    expect(hit, 'the query echo is not found by its tool name').toBeTruthy()
    expect(hit!.content).toContain('\nOutput:\n')
    expect(hit!.content, 'the hit was cut at the tool name').toContain(NOTE_PHRASE)
  })

  // ── D261: an import echo is found by its label, never by the handoff ──
  const HANDOFF_PHRASE = 'saltmarsh quorum'
  reg.define(/^the echo of an import whose pasted handoff holds a distinctive phrase, imported under a label$/, async (w: RecallWorld) => {
    await openCaptureWorld(w)
    const client = await mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! } })
    w.label = 'handoffs/heron-ledger-brief.json'
    const data = await teammateHandoff(w, [
      `PLAN: the ${HANDOFF_PHRASE} ships behind the archive gate`,
      `FINDING: the ${HANDOFF_PHRASE} needs the fsync before the tombstone`,
    ])
    const imp = await callEchoed(w, client, 'treecontext_import', { data, label: w.label })
    expect(imp.response['imported_count']).toBe(2)
    spawnHook(w, 'post-tool-use', imp.payload)
    await drainStaging(w)
    const echo = rawEcho(w.dbPath!, 'treecontext_import')
    // The hook wrote the label on its own line, ahead of the handoff it carries.
    expect(echo.content.split('\n')[1]).toBe(`Label: ${w.label}`)
    expect(echo.content).toContain(HANDOFF_PHRASE)
    w.echoes = { treecontext_import: echo }
    w.importedIds = rawAllIds(w, "json_extract(metadata_json, '$._handoff_file') = ?", w.label)
    expect(w.importedIds).toHaveLength(2)
    w.phrase = HANDOFF_PHRASE
  })
  reg.define(/^the agent searches for that phrase$/, async (w: RecallWorld) => {
    w.hits = await agentSearch(w, w.phrase!)
  })
  reg.define(/^the imported entries are hits and the import echo is not$/, (w: RecallWorld) => {
    const ids = w.hits!.map((h) => h.nodeId)
    expect([...ids].sort()).toEqual([...w.importedIds!].sort())
    expect(ftsNodeIds(w.dbPath!, w.phrase!)).not.toContain(w.echoes!['treecontext_import']!.nodeId)
  })
  reg.define(/^a search for the label finds the import echo$/, async (w: RecallWorld) => {
    const ids = (await agentSearch(w, 'heron ledger brief')).map((h) => h.nodeId)
    expect(ids).toContain(w.echoes!['treecontext_import']!.nodeId)
  })

  // ── D261: the upgrade re-indexes the echoes a store already holds ──
  const OLD_NOTE_PHRASE = 'bramblewick'
  const OLD_HANDOFF_PHRASE = 'cindergrove'
  reg.define(/^a store whose treecontext echoes were indexed in full by an earlier treecontext$/, async (w: RecallWorld) => {
    await openCaptureWorld(w)
    const client = await mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! } })
    const note = `CHECKPOINT: the ${OLD_NOTE_PHRASE} migration is half done; working on the ladder, next step the verdict.`
    const insert = await callEchoed(w, client, 'treecontext_insert', { content: note, metadata: { type: 'checkpoint', next_session: true } })
    w.nodeId = String(insert.response['node_id'])
    const query = await callEchoed(w, client, 'treecontext_query', { query: ORIENTATION_QUERY, top_k: 5 })
    const status = await callEchoed(w, client, 'treecontext_status', {})
    const data = JSON.stringify({ nodes: [{ content: `NOTE: the ${OLD_HANDOFF_PHRASE} brief, carried by hand` }] })
    const imp = await callEchoed(w, client, 'treecontext_import', { data, label: 'handoffs/old-brief.json' })
    for (const e of [insert, query, status, imp]) spawnHook(w, 'post-tool-use', e.payload)
    // The earlier treecontext's drain (beta.1): the staged boundaries as
    // the hook stamped them, no echo rule; its hook wrote no Label line.
    await beta1Drain(w)
    const before = rawEchoes(w.dbPath!)
    expect(before).toHaveLength(4)
    const oldImport = before.find((e) => e.toolName === echoTool('treecontext_import'))!
    expect(oldImport.content.split('\n')[1], 'the beta.1 layout: Input follows the tool line').toBe('Input:')
    // Indexed in full: each echo is found by what it carried.
    const byNote = ftsNodeIds(w.dbPath!, OLD_NOTE_PHRASE)
    for (const t of ['treecontext_insert', 'treecontext_query']) {
      expect(byNote, `${t} echo was not indexed in full`).toContain(before.find((e) => e.toolName === echoTool(t))!.nodeId)
    }
    expect(ftsNodeIds(w.dbPath!, OLD_HANDOFF_PHRASE)).toContain(oldImport.nodeId)
    w.echoesBefore = before
    w.importedIds = rawAllIds(w, "json_extract(metadata_json, '$._handoff_file') = 'handoffs/old-brief.json'")
    // The store is left at the earlier treecontext's schema.
    await w.store!.close()
    const raw = new DatabaseSync(w.dbPath!)
    try { setPragma(raw, 'user_version = 27') } finally { raw.close() }
  })
  reg.define(/^this treecontext opens the store$/, async (w: RecallWorld) => {
    w.store = await reopenStore(w)
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try { expect(pragmaValue(raw, 'user_version')).toBe(maxSupportedVersion) } finally { raw.close() }
    w.echoesAfterFirstOpen = rawEchoes(w.dbPath!)
    w.vocabAfterFirstOpen = ftsVocab(w.dbPath!)
  })
  reg.define(/^a query echo no longer matches the results it returned nor the words of the query it recorded, and still matches its tool name$/, (w: RecallWorld) => {
    const echo = echoOf(w, 'treecontext_query')
    expect(echo.content).toContain(OLD_NOTE_PHRASE) // the results are still stored
    expect(echo.content).toContain(ORIENTATION_QUERY) // and so is the query
    expect(ftsNodeIds(w.dbPath!, OLD_NOTE_PHRASE)).not.toContain(echo.nodeId)
    for (const word of ['working', 'next', 'step']) {
      const hits = ftsNodeIds(w.dbPath!, word)
      expect(hits, `control: "${word}" is live in the index`).toContain(w.nodeId)
      expect(hits).not.toContain(echo.nodeId)
    }
    expect(ftsNodeIds(w.dbPath!, 'treecontext_query')).toContain(echo.nodeId)
    expect(echo.metadata['_index_len']).toBe(echo.content.indexOf('\n'))
  })
  reg.define(/^an insert echo no longer matches the note it wrote$/, (w: RecallWorld) => {
    const echo = echoOf(w, 'treecontext_insert')
    const hits = ftsNodeIds(w.dbPath!, OLD_NOTE_PHRASE)
    expect(hits).not.toContain(echo.nodeId)
    expect(hits, 'the note itself is still found').toContain(w.nodeId)
    expect(echo.metadata['_index_len']).toBe(echo.content.indexOf('\n'))
  })
  reg.define(/^an import echo stored before this rule matches its tool name and not the handoff it carried$/, (w: RecallWorld) => {
    const echo = echoOf(w, 'treecontext_import')
    expect(echo.metadata['_index_len']).toBe(echo.content.indexOf('\n'))
    expect(ftsNodeIds(w.dbPath!, 'treecontext_import')).toContain(echo.nodeId)
    const hits = ftsNodeIds(w.dbPath!, OLD_HANDOFF_PHRASE)
    expect(hits).not.toContain(echo.nodeId)
    expect(hits, 'the imported entry itself is still found').toEqual(w.importedIds)
    expect(ftsNodeIds(w.dbPath!, 'brief')).not.toContain(echo.nodeId) // nor by its label: there is no Label line
  })
  reg.define(/^every echo's stored content is unchanged, byte for byte$/, (w: RecallWorld) => {
    const after = new Map(w.echoesAfterFirstOpen!.map((e) => [e.nodeId, e]))
    expect(after.size).toBe(w.echoesBefore!.length)
    for (const b of w.echoesBefore!) {
      expect(after.get(b.nodeId)!.stored.equals(b.stored), `${b.toolName} content changed`).toBe(true)
    }
  })
  reg.define(/^opening the store again leaves the echoes exactly as the first open left them$/, async (w: RecallWorld) => {
    await w.store!.close()
    w.store = await reopenStore(w)
    const again = rawEchoes(w.dbPath!)
    const strip = (es: RawEcho[]) => es.map((e) => ({ ...e, stored: e.stored.toString('base64') }))
    expect(strip(again)).toEqual(strip(w.echoesAfterFirstOpen!))
    expect(ftsVocab(w.dbPath!)).toEqual(w.vocabAfterFirstOpen)
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

  // ── a metadata filter finds an entry wherever its words rank (D268) ──
  const BURIED_WORDS = 'quartz ledger reconciliation'
  reg.define(/^a mature journal in which a bookmark's words are outranked by more than two hundred other entries, so a search for them alone does not reach it$/, async (w: RecallWorld) => {
    w.mature = await seedMatureJournal(w)
    const client = await mcpOver(w, { ccSessionId: 'cc-d268' })
    // The bookmark, through the real insert tool, as the stop hook asks
    // for one: its words in a longer sentence.
    const bm = parseTool(await client.callTool({ name: 'treecontext_insert', arguments: {
      content: `at: halfway through the ${BURIED_WORDS} for the March close, totals still off by one row; next: diff the two exports`,
      metadata: { kind: 'bookmark' },
    } }))
    w.nodeId = bm['node_id'] as string
    // More than two hundred curated notes that carry the same words more
    // densely, through the same tool.
    for (let i = 0; i < 230; i++) {
      await client.callTool({ name: 'treecontext_insert', arguments: { content: `${BURIED_WORDS} batch ${i}: ${BURIED_WORDS} done` } })
    }
    // Read from SQLite: the row is a bookmark, and more than two hundred
    // rows outrank it at its own score, so the pool the filter used to
    // sift, at most two hundred candidates, never held it.
    expect(rawMetaOf(w, w.nodeId)['kind']).toBe('bookmark')
    const ranks = rawOutranking(w.dbPath!, BURIED_WORDS.split(' '), w.nodeId)
    expect(ranks.better, 'rows outranking the bookmark on its words').toBeGreaterThan(200)
    // And a search for the words alone, as deep as the tool reads, does not reach it.
    const plain = parseTool(await client.callTool({ name: 'treecontext_query', arguments: { query: BURIED_WORDS, top_k: 20 } }))
    expect((plain['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)).not.toContain(w.nodeId)
    const lexical = parseTool(await client.callTool({ name: 'treecontext_query', arguments: { query: BURIED_WORDS, top_k: 20, recency_weight: 0 } }))
    expect((lexical['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)).not.toContain(w.nodeId)
  })
  reg.define(/^a query for those words passes a metadata filter on the bookmark kind$/, async (w: RecallWorld) => {
    w.mcpResponse = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: {
      query: BURIED_WORDS, top_k: 10, metadata_filter: { kind: 'bookmark' },
    } }))
  })
  reg.define(/^the bookmark is returned$/, (w: RecallWorld) => {
    const ids = (w.mcpResponse!['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
    expect(ids).toContain(w.nodeId)
    // Every row returned is a bookmark, as SQLite holds it.
    for (const id of ids) expect(rawMetaOf(w, id)['kind'], id).toBe('bookmark')
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


  // ── D286: the recovery snapshot is bounded like a tool event ─────────
  const RECOVERY_QUERIES = ['current active plan and next steps', 'recent decisions and their rationale']
  /** Two note families, one per recovery query, so each query quotes its
   *  own three: `word` in every sentence, `far` (when given) only at the end. */
  const planSentence = (word: string): string => `the ${word} plan for the valve rework carries one next step per item. `
  const decisionSentence = (word: string): string => `the ${word} decision records its rationale for the valve rework. `
  const longNote = (sentence: (w: string) => string, word: string, far = ''): string =>
    sentence(word).repeat(Math.ceil((RECOVERY_QUOTE_CAP * 1.5) / sentence(word).length)) + (far ? `closing marker ${far}` : '')
  async function drainAll(w: RecallWorld): Promise<void> {
    const loop = new IngestionLoop(w.store!, { batchSize: 10 })
    for (let i = 0; i < 50 && w.store!.store.countUnprocessedStaging() > 0; i++) await loop.ingestBatch()
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
  }
  function recoveryRows(w: RecallWorld): Array<{ node_id: string; content: Buffer | string; metadata_json: string; index_len: number | null; preview_len: number | null }> {
    return rawAll(w, "SELECT node_id, content, metadata_json, index_len, preview_len FROM nodes WHERE json_extract(metadata_json, '$.source') = ? ORDER BY rowid", RECOVERY_SNAPSHOT_SOURCE)
  }
  reg.define(/^a recovery snapshot the drain wrote from entries far longer than its display boundary$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    // Six notes, three per query: every quote is cut at the cap, so the
    // row runs past its index boundary; the last note's own word is the
    // far token, quoted only beyond that boundary.
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await w.store!.insert(longNote(planSentence, `alpha${i}`), { metadata: { type: 'note', seed: i } })).nodeId)
    for (let i = 3; i < 6; i++) ids.push((await w.store!.insert(longNote(decisionSentence, `alpha${i}`), { metadata: { type: 'note', seed: i } })).nodeId)
    const far = 'alpha5'
    const sourceIds = [ids[5]!]
    w.store!.store.insertStaging({
      sessionId: 's-recovery', role: 'snapshot', priority: 0, timestamp: T0 + 10,
      content: JSON.stringify({ queries: RECOVERY_QUERIES, original_session_id: 's-before-compaction' }),
    })
    await drainAll(w)
    const rows = recoveryRows(w)
    expect(rows).toHaveLength(1)
    const full = decodeContent(rows[0]!.content)
    expect(full.length).toBeGreaterThan(RECOVERY_INDEX_LEN)
    expect(full.indexOf(far), 'the far word is quoted, and only past the index boundary').toBeGreaterThan(RECOVERY_INDEX_LEN)
    w.recovery = { nodeId: rows[0]!.node_id, full, farToken: far, previewWord: 'alpha', sourceIds }
  })
  reg.define(/^a query matches words inside its preview$/, async (w: RecallWorld) => {
    // The first quote's words sit inside the preview; the hit is the row itself.
    const firstQuoted = w.recovery!.full.match(/the (alpha\d) plan/)![1]!
    w.results = await w.store!.query(`${firstQuoted} plan valve rework`, { topK: 10 })
    expect(w.results.map((r) => r.nodeId)).toContain(w.recovery!.nodeId)
  })
  reg.define(/^its content ends at the display boundary with the availability marker$/, (w: RecallWorld) => {
    const hit = w.results!.find((r) => r.nodeId === w.recovery!.nodeId)!
    expect(hit.content).toMatch(/…\[preview; full content \d+ chars via treecontext_export\]$/)
    expect(hit.content.startsWith(w.recovery!.full.slice(0, RECOVERY_PREVIEW_LEN))).toBe(true)
    expect(hit.content.indexOf('…[preview;')).toBe(RECOVERY_PREVIEW_LEN)
  })
  reg.define(/^words past its index boundary do not find it$/, (w: RecallWorld) => {
    const ids = ftsNodeIds(w.dbPath!, w.recovery!.farToken)
    expect(ids, 'control: the source notes still carry the token').toEqual(expect.arrayContaining(w.recovery!.sourceIds))
    expect(ids).not.toContain(w.recovery!.nodeId)
  })
  reg.define(/^export of that entry returns its full content$/, (w: RecallWorld) => {
    expect(exportNode(w, w.recovery!.nodeId)['content']).toBe(w.recovery!.full)
  })

  // ── D286: migration 030 heals the rows an earlier treecontext left ────
  reg.define(/^a store whose recovery snapshots an earlier treecontext wrote without boundaries$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const far = `fartoken${Math.random().toString(16).slice(2, 8)}`
    const noteId = (await w.store!.insert(longNote(planSentence, 'beta', far), { metadata: { type: 'note' } })).nodeId
    // The beta.2 shape: the query text in the content, every hit quoted
    // whole, no boundary of any kind; the far word sits past the index
    // boundary and nowhere before it.
    const old = `# Recovery Query: ${RECOVERY_QUERIES[0]}\n\n## \n${longNote(planSentence, 'beta')}\n\n## \n${longNote(planSentence, 'gamma')}\n\n## \n${longNote(planSentence, 'delta', far)}\n\n`
    expect(old.indexOf(far)).toBeGreaterThan(RECOVERY_INDEX_LEN)
    expect(old.length).toBeGreaterThan(RECOVERY_INDEX_LEN)
    const id = (await w.store!.insert(old, { metadata: { source: RECOVERY_SNAPSHOT_SOURCE, original_session_id: 's-old', recovered_at: T0 } })).nodeId
    expect(ftsNodeIds(w.dbPath!, far), 'before: the whole row is indexed').toContain(id)
    await w.store!.close()
    const raw = new DatabaseSync(w.dbPath!)
    try { setPragma(raw, 'user_version = 29') } finally { raw.close() }
    w.recovery = { nodeId: id, full: old, farToken: far, previewWord: 'beta', sourceIds: [noteId], before: old }
  })
  reg.define(/^each recovery snapshot carries a display boundary and an index boundary$/, (w: RecallWorld) => {
    const rows = recoveryRows(w)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const meta = JSON.parse(r.metadata_json) as Record<string, unknown>
      const len = decodeContent(r.content).length
      expect(meta['_preview_len']).toBe(Math.min(RECOVERY_PREVIEW_LEN, len))
      expect(meta['_index_len']).toBe(Math.min(RECOVERY_INDEX_LEN, len))
      expect(r.preview_len).toBe(meta['_preview_len'])
      expect(r.index_len).toBe(meta['_index_len'])
    }
    // The indexed view shrank to the boundary: the far token no longer finds the row.
    const ids = ftsNodeIds(w.dbPath!, w.recovery!.farToken)
    expect(ids, 'control: the source note still carries the token').toContain(w.recovery!.sourceIds[0])
    expect(ids).not.toContain(w.recovery!.nodeId)
  })
  reg.define(/^a hit on one is a bounded preview$/, async (w: RecallWorld) => {
    const results = await w.store!.query(`${w.recovery!.previewWord} plan valve rework`, { topK: 10 })
    const hit = results.find((r) => r.nodeId === w.recovery!.nodeId)
    expect(hit, 'the row is still findable by the words inside its boundary').toBeTruthy()
    expect(hit!.content).toMatch(/…\[preview; full content \d+ chars via treecontext_export\]$/)
    expect(hit!.content.indexOf('…[preview;')).toBe(RECOVERY_PREVIEW_LEN)
  })
  reg.define(/^its stored content is unchanged$/, (w: RecallWorld) => {
    const row = recoveryRows(w).find((r) => r.node_id === w.recovery!.nodeId)!
    expect(decodeContent(row.content)).toBe(w.recovery!.before)
    expect(exportNode(w, w.recovery!.nodeId)['content']).toBe(w.recovery!.before)
  })

  // ── D287: the reply ceiling ──────────────────────────────────────────
  reg.define(/^a store whose entries, returned whole, would make a reply far over the reply ceiling$/, async (w: RecallWorld) => {
    await openLiveStore(w)
    const line = 'ceilingcorpus: the valve rework decision and its rationale, kept whole as a curated note. '
    // Ten curated notes of ~450 K chars (notes return whole under D47),
    // and one of ~4.5 M chars that is over the ceiling on its own.
    const bulk = line.repeat(Math.ceil(450_000 / line.length))
    for (let i = 0; i < 10; i++) await w.store!.insert(`note ${i} of the ceiling corpus\n${bulk}`, { metadata: { type: 'note', seed: i } })
    const big = `the oversized entry of the ceiling corpus\n${line.repeat(Math.ceil((REPLY_CEILING_BYTES * 1.1) / line.length))}`
    const bigId = (await w.store!.insert(big, { metadata: { type: 'note', seed: 'big' } })).nodeId
    w.ceiling = { text: '', parsed: {}, bigId, bigLen: big.length }
  })
  reg.define(/^a broad query returns them$/, async (w: RecallWorld) => {
    const client = await mcpOver(w)
    const res = await client.callTool({ name: 'treecontext_query', arguments: { query: 'ceilingcorpus valve rework', top_k: 20 } }) as { content: Array<{ type: string; text: string }> }
    const text = res.content[0]!.text
    w.ceiling!.text = text
    w.ceiling!.parsed = JSON.parse(text) as Record<string, unknown>
    expect((w.ceiling!.parsed['results'] as unknown[]).length).toBe(11)
  })
  reg.define(/^the reply is under the ceiling$/, (w: RecallWorld) => {
    expect(Buffer.byteLength(w.ceiling!.text, 'utf8')).toBeLessThanOrEqual(REPLY_CEILING_BYTES)
    const note = w.ceiling!.parsed['_reply_ceiling'] as Record<string, unknown>
    expect(note).toBeTruthy()
    expect(note['ceiling_bytes']).toBe(REPLY_CEILING_BYTES)
    expect(note['cut_entries']).toBeGreaterThan(0)
  })
  reg.define(/^each cut entry says so and names the export escape hatch$/, (w: RecallWorld) => {
    const results = w.ceiling!.parsed['results'] as Array<{ nodeId: string; content: string }>
    const cut = results.filter((r) => /…\[cut to fit the reply ceiling; full content \d+ chars via treecontext_export\]$/.test(r.content))
    expect(cut.length).toBe((w.ceiling!.parsed['_reply_ceiling'] as Record<string, number>)['cut_entries'])
    expect(cut.length).toBeGreaterThan(0)
    const bigHit = results.find((r) => r.nodeId === w.ceiling!.bigId)!
    expect(bigHit.content).toContain(`full content ${w.ceiling!.bigLen} chars`)
  })
  reg.define(/^export of one entry over the ceiling is refused with its size, never cut$/, async (w: RecallWorld) => {
    const client = await mcpOver(w)
    const res = await client.callTool({ name: 'treecontext_export', arguments: { node_id: w.ceiling!.bigId } }) as { isError?: boolean; content: Array<{ type: string; text: string }> }
    expect(res.isError).toBe(true)
    const body = JSON.parse(res.content[0]!.text) as { error: string; node_id: string }
    expect(body.node_id).toBe(w.ceiling!.bigId)
    expect(body.error).toMatch(/over the reply ceiling of \d+ bytes/)
    expect(body.error).toMatch(new RegExp(`serializes to \\d+ bytes`))
    // Never cut: the entry is whole in the store.
    expect(exportNode(w, w.ceiling!.bigId)['content']).toHaveLength(w.ceiling!.bigLen)
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

