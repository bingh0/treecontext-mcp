import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'
import { type Registry } from 'gherkin-node-test/vitest'
import { createServer } from '../../../src/server/server.js'
import { writeSessionBeacon } from '../../../src/session-beacon.js'
import { mcpOver, parseTool, reopenAsLaterSession, exportNode, rawAll } from '../world.js'
import { type CaptureWorld, openCaptureWorld, spawnHook, drainStaging } from '../capture-harness.js'

// ── journal-session-echo ────────────────────────────────────────────────
//
// V2 echo heal (docs/session-identity.md §7.3 + §7.7): real curated
// inserts through the real MCP server, real PostToolUse hook
// subprocesses staging the echoes — the tool_response fed to the hook
// is the ACTUAL content array the MCP client received, never a
// hand-built fixture — and the production drain doing the correlation.
// Assertions read the store raw (verification rule).

/** The insert tool's wire name, and the key an ACCEPTED insert answers
 *  with. Named rather than spelled inline at each use so the refusal
 *  binding below reads a needle it has proved live against a real accepted
 *  payload in the same scenario. */
const INSERT_TOOL = 'treecontext_insert'
const NODE_ID_KEY = /node_id/


/**
 * The v2-heal world, shared with the session-namespace wave: a curated note
 * inserted through the real MCP surface, and the hook's echo of that same
 * insert. Both features drive that one path — echo heals the note's session
 * identity, session-namespace rides the healed note to check the namespace
 * annotation — so the two fields live here and
 * journal-session-namespace.steps.ts imports them rather than either file
 * restating them. Only what BOTH waves read: what each does with the healed
 * row afterwards is its own field, in its own interface below.
 *
 * It extends CaptureWorld because the echo IS a real hook subprocess.
 */
export interface EchoWorld extends CaptureWorld {
  /** The note id the MCP insert returned. */
  eNoteId?: string
  /** The hook payload's tool_response, echoing that insert back. */
  eToolResponse?: unknown
}

/**
 * Echo's own.
 *
 * The last two here, plus `nsResolved` in the namespace wave, were a single
 * field named `eNoteBefore` carrying three unrelated shapes: a metadata row,
 * a parsed tool response, and a ladder verdict. One name for three meanings
 * is the disease the world split exists to cure, so each shape has its own
 * name and its own type now.
 */
export interface SessionEchoWorld extends EchoWorld {
  /** The second session whose echo must not claim the note. */
  eSessionB?: string
  /** The note's exported metadata before the echo drained — the "before"
   *  half of the before/after export. */
  eNoteMeta?: Record<string, unknown>
  /** The parsed insert response that deduplicated onto the note, held for
   *  the assertion that dedup really collapsed the two. */
  eDedupResponse?: Record<string, unknown>
}

export const sessionEchoDefiner = (reg: Registry<SessionEchoWorld>): void => {
  function echoPayload(w: SessionEchoWorld, toolInput: unknown, sessionId?: string): Record<string, unknown> {
    return {
      ...(sessionId ? { session_id: sessionId } : {}),
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      hook_event_name: 'PostToolUse',
      permission_mode: 'default',
      tool_name: 'mcp__treecontext__treecontext_insert',
      tool_input: toolInput,
      tool_response: w.eToolResponse,
    }
  }

  async function insertThroughServer(w: SessionEchoWorld, content: string, serverOpts: Parameters<typeof createServer>[1] = {}): Promise<void> {
    // info.storePath is how production servers find the beacon directory
    // (the CLI passes it); without it the ladder cannot see beacons at all.
    const client = await mcpOver(w, { claudeCwd: w.proj!, info: { storePath: w.dbPath! }, ...serverOpts })
    const res = await client.callTool({ name: INSERT_TOOL, arguments: { content } })
    w.eToolResponse = (res as { content: unknown }).content
    w.eNoteId = String(parseTool(res)['node_id'])
  }

  function healedRow(w: SessionEchoWorld): { meta: Record<string, unknown>; sessionKey: string } {
    const [row] = rawAll<{ metadata_json: string; session_key: string }>(
      w, 'SELECT metadata_json, session_key FROM nodes WHERE node_id = ?', w.eNoteId!,
    )
    expect(row, 'the curated row under heal must exist').toBeTruthy()
    return { meta: JSON.parse(row!.metadata_json ?? '{}') as Record<string, unknown>, sessionKey: row!.session_key }
  }

  const NOTE = 'ECHO NOTE: the valve ruling was recorded before the beacon could say who wrote it'

  reg.define(/^a curated insert whose ladder resolution came up absent$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    await insertThroughServer(w, NOTE)
  })
  reg.define(/^the hook's echo of that insert sits in staging$/, (w: SessionEchoWorld) => {
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }))
    expect(w.store!.store.countUnprocessedStaging()).toBeGreaterThan(0)
  })
  reg.define(/^the drain runs$/, async (w: SessionEchoWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the row carries the echo's session id with source "echo"$/, (w: SessionEchoWorld) => {
    const { meta } = healedRow(w)
    expect(meta['_cc_session_id']).toBe(w.sessionId)
    expect(meta['_cc_session_src']).toBe('echo')
  })
  reg.define(/^the row's session-key column agrees with the healed metadata$/, (w: SessionEchoWorld) => {
    expect(healedRow(w).sessionKey).toBe(w.sessionId)
  })

  reg.define(/^a curated insert awaiting its echo$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    await insertThroughServer(w, NOTE)
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }))
  })
  reg.define(/^the journal is exported before the drain runs$/, (w: SessionEchoWorld) => {
    w.eNoteMeta = (exportNode(w, w.eNoteId!)['metadata'] ?? {}) as Record<string, unknown>
  })
  reg.define(/^the exported row shows the provisional attribution$/, (w: SessionEchoWorld) => {
    expect(w.eNoteMeta!['_cc_session_id']).toBeUndefined()
    expect(w.eNoteMeta!['_cc_session_src']).toBeUndefined()
  })
  reg.define(/^the same export after the drain shows the echo attribution$/, async (w: SessionEchoWorld) => {
    await drainStaging(w)
    const after = exportNode(w, w.eNoteId!)['metadata'] as Record<string, unknown>
    expect(after['_cc_session_id']).toBe(w.sessionId)
    expect(after['_cc_session_src']).toBe('echo')
  })

  reg.define(/^a curated row the ladder attributed by beacon unanimity$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    writeSessionBeacon(w.dbPath!, 4242, 'cc-beacon-guess', w.proj!, { rewrite: true })
    await insertThroughServer(w, NOTE)
    // Precondition, not an assumption: the ladder really did guess.
    expect(healedRow(w).meta['_cc_session_src']).toBe('beacon-unanimous')
  })
  reg.define(/^an in-window echo naming a different session$/, (w: SessionEchoWorld) => {
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }))
  })
  reg.define(/^the row carries the echo's session id with the displaced guess preserved in the trace field$/, (w: SessionEchoWorld) => {
    const { meta, sessionKey } = healedRow(w)
    expect(meta['_cc_session_id']).toBe(w.sessionId)
    expect(meta['_cc_session_src']).toBe('echo')
    expect(meta['_cc_session_prev']).toBe('cc-beacon-guess')
    expect(sessionKey).toBe(w.sessionId)
  })

  reg.define(/^a curated row attributed by an explicit client header$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    await insertThroughServer(w, NOTE, { ccSessionId: 'cc-explicit-owner' })
  })
  reg.define(/^the row's attribution and source are unchanged$/, (w: SessionEchoWorld) => {
    const { meta, sessionKey } = healedRow(w)
    expect(meta['_cc_session_id']).toBe('cc-explicit-owner')
    expect(meta['_cc_session_src']).toBe('explicit')
    expect(meta['_cc_session_prev']).toBeUndefined()
    expect(sessionKey).toBe('cc-explicit-owner')
  })

  reg.define(/^an old attributed curated row$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    const r = await w.store!.insert(NOTE, {
      createdAt: Date.now() / 1000 - 3600,
      metadata: { _cc_session_id: 'cc-old-owner', _cc_session_src: 'beacon-unanimous' },
    })
    w.eNoteId = r.nodeId
  })
  reg.define(/^a new identical insert from another session that deduplicated onto it$/, async (w: SessionEchoWorld) => {
    const client = await mcpOver(w, { claudeCwd: w.proj! })
    const res = await client.callTool({ name: 'treecontext_insert', arguments: { content: NOTE } })
    const parsed = parseTool(res)
    expect(parsed['deduplicated'], 'the second insert must dedup onto the survivor').toBe(true)
    expect(parsed['node_id']).toBe(w.eNoteId)
    w.eToolResponse = (res as { content: unknown }).content
    w.eSessionB = `cc-${randomBytes(6).toString('hex')}`
  })
  reg.define(/^the drain processes the new insert's echo$/, async (w: SessionEchoWorld) => {
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }, w.eSessionB))
    await drainStaging(w)
  })
  reg.define(/^the old row's attribution and session-key column are unchanged$/, (w: SessionEchoWorld) => {
    const { meta, sessionKey } = healedRow(w)
    expect(meta['_cc_session_id']).toBe('cc-old-owner')
    expect(meta['_cc_session_src']).toBe('beacon-unanimous')
    expect(meta['_cc_session_ambiguous']).toBeUndefined()
    expect(sessionKey).toBe('cc-old-owner')
  })

  reg.define(/^two sessions that insert identical content within one correlation window$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    await insertThroughServer(w, NOTE)
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }))
    const clientB = await mcpOver(w, { claudeCwd: w.proj! })
    const resB = await clientB.callTool({ name: 'treecontext_insert', arguments: { content: NOTE } })
    w.eToolResponse = (resB as { content: unknown }).content
    w.eSessionB = `cc-${randomBytes(6).toString('hex')}`
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }, w.eSessionB))
    w.eDedupResponse = parseTool(resB)
  })
  reg.define(/^curated dedup collapsed them to a single row$/, (w: SessionEchoWorld) => {
    expect(w.eDedupResponse!['deduplicated']).toBe(true)
    expect(w.eDedupResponse!['node_id']).toBe(w.eNoteId)
  })
  reg.define(/^the drain processes both echoes$/, async (w: SessionEchoWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the row is flagged ambiguous with both session ids as candidates$/, (w: SessionEchoWorld) => {
    const { meta } = healedRow(w)
    expect(meta['_cc_session_ambiguous']).toBe(true)
    const candidates = meta['_cc_session_candidates'] as string[]
    expect(candidates).toContain(w.sessionId)
    expect(candidates).toContain(w.eSessionB)
    // The creator stays primary — ambiguity is disclosed alongside, not
    // instead of, the causal attribution.
    expect(meta['_cc_session_id']).toBe(w.sessionId)
    expect(meta['_cc_session_src']).toBe('echo')
  })

  reg.define(/^a server with capture off whose insert resolved by beacon unanimity$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    writeSessionBeacon(w.dbPath!, 777, 'cc-lone', w.proj!, { rewrite: true })
    await insertThroughServer(w, NOTE)
  })
  reg.define(/^the drain runs with no echo present$/, async (w: SessionEchoWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the row keeps the beacon attribution unchanged$/, (w: SessionEchoWorld) => {
    const { meta, sessionKey } = healedRow(w)
    expect(meta['_cc_session_id']).toBe('cc-lone')
    expect(meta['_cc_session_src']).toBe('beacon-unanimous')
    expect(sessionKey).toBe('cc-lone')
  })
  reg.define(/^no session id is invented$/, (w: SessionEchoWorld) => {
    const { meta } = healedRow(w)
    expect(meta['_cc_session_prev']).toBeUndefined()
    expect(meta['_cc_session_candidates']).toBeUndefined()
  })

  reg.define(/^a curated insert whose echo was staged but the server died before draining$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    await insertThroughServer(w, NOTE)
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: NOTE }))
  })
  reg.define(/^a new server opens the store and its drain runs$/, async (w: SessionEchoWorld) => {
    await reopenAsLaterSession(w)
    await drainStaging(w)
  })

  reg.define(/^a curated insert long enough that its echo truncates the input preview$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    const long = `LONG ECHO NOTE: ${'the preview cap cuts the input long before the content ends. '.repeat(12)}`
    await insertThroughServer(w, long)
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: long }))
    // Precondition: the input really overflows the 500-char preview cap.
    expect(JSON.stringify({ content: long }).length).toBeGreaterThan(500)
  })

  reg.define(/^a rejected insert whose echo carries only the error payload$/, async (w: SessionEchoWorld) => {
    await openCaptureWorld(w)
    // A control row in-window with no echo of its own: if the failed
    // echo healed ANYTHING, this is what it would hit.
    await insertThroughServer(w, NOTE)
    // Needle liveness, in-world: the accepted insert just made above is
    // this step's own control — its payload carries the very key the
    // refusal must not, so a dead needle fails here rather than passing
    // the exclusion below forever. (Audit run 2: the old marker named
    // provers in OTHER files.)
    expect(JSON.stringify(w.eToolResponse), 'an accepted insert did not answer with the key').toMatch(NODE_ID_KEY)
    const client = w.client!
    // The refusal arrives as a flagged result, not a throw: the tool's
    // content schema (z.string().min(1), src/server/server.ts) rejects the
    // empty string at the MCP input-validation boundary. A throw here is
    // itself a failure of that contract and surfaces as one.
    const res = await client.callTool({ name: INSERT_TOOL, arguments: { content: '' } })
    const response = (res as { content: unknown }).content
    const flagged = (res as { isError?: unknown }).isError
    const said = (res as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n')
    // The refusal states itself: an error flag, and text naming the tool
    // and the field it rejected. Pinned beside the absence so a payload
    // that quietly dropped its refusal fields cannot pass as a refusal.
    expect(flagged, 'the refusal must flag itself as an error').toBe(true)
    expect(said, 'the refusal must say it rejected the input').toMatch(/validation error/i)
    expect(said, 'the refusal must name the tool it refused').toContain(INSERT_TOOL)
    expect(said, 'the refusal must name the field it rejected').toMatch(/content/)
    expect(JSON.stringify(response), 'a refusal must not answer like an accepted insert').not.toMatch(NODE_ID_KEY)
    w.eToolResponse = response
    spawnHook(w, 'post-tool-use', echoPayload(w, { content: '' }))
  })
  reg.define(/^no curated row gains an attribution from that echo$/, (w: SessionEchoWorld) => {
    const { meta } = healedRow(w)
    expect(meta['_cc_session_id']).toBeUndefined()
    expect(meta['_cc_session_src']).toBeUndefined()
    const echoSourced = rawAll<{ n: number }>(
      w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$._cc_session_src') = 'echo'",
    )
    expect(echoSourced[0]!.n).toBe(0)
  })
}

