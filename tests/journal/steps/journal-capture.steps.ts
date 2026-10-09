import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { TOOL_OUTPUT_PREVIEW_CAP } from '../../../src/persistence/capture-constants.js'
import { INGESTION_TICK_MS } from '../../../src/server/ingestion.js'
import { WARN_PREFIX } from '../../../src/debug.js'
import { mcpOver, openLiveStore, exportNode } from '../world.js'
import { TS_ROOT, sleep } from '../proc.js'
import { maxSupportedVersion } from '../../../src/persistence/migrations/index.js'
import { type CaptureWorld, openCaptureSandbox, adoptCaptureStore, openCaptureWorld, spawnHook, spawnHooksAtOnce, spawnServeChild, waitForServeLog, drainStaging, type RawNode, rawJournal, bashPayload, writeTranscript, seedCheckpointAge, expectBookmarkAsked } from '../capture-harness.js'

/** What the transcript still ends at when Stop fires: the turn before. */
const PREVIOUS_TURN = 'Reading the valve code first; the archive step runs before any row moves.'

/** A Stop payload in the shape Claude Code 2.1.293 sends it (live probe
 *  2026-10-08): the ended turn's text in `last_assistant_message`, beside
 *  the transcript path and the fields the hook does not read. */
function stopPayload(w: CaptureWorld, turn: string): Record<string, unknown> {
  return {
    transcript_path: join(w.proj!, 'transcript.jsonl'),
    prompt_id: randomBytes(8).toString('hex'),
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: turn,
    background_tasks: [],
    session_crons: [],
  }
}

export const captureDefiner = (reg: Registry<CaptureWorld>): void => {
  // ── a user message is captured verbatim ─────────────────────────────
  reg.define(/^a session where the user submits a prompt$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.prompt = 'Ship the valve before the demo — archive first, delete second, and never touch the newest session.'
    const before = Date.now() / 1000
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      prompt: w.prompt,
    })
    w.saidAt = [before, Date.now() / 1000]
  })
  reg.define(/^the session's events are ingested$/, async (w: CaptureWorld) => {
    await sleep(600) // a later drain, so said-time vs ingest-time is observable
    w.drainedAt = Date.now() / 1000
    await drainStaging(w)
  })
  reg.define(/^the journal contains that prompt with role "user"$/, (w: CaptureWorld) => {
    const rows = rawJournal(w).filter((r) => r.metadata['role'] === 'user')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(w.prompt) // verbatim, punctuation and all
  })
  reg.define(/^its capture timestamp reflects when it was said, not when it was ingested$/, (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['role'] === 'user')!
    const at = row.metadata['created_at'] as number
    expect(at).toBeGreaterThanOrEqual(w.saidAt![0])
    expect(at).toBeLessThanOrEqual(w.saidAt![1])
    expect(w.drainedAt! - at).toBeGreaterThan(0.4)
    expect(row.metadata['ingested_at'] as number).toBeGreaterThanOrEqual(w.drainedAt! - 0.1)
  })

  // ── a tool event is captured with both its input and its response ───
  reg.define(/^a PostToolUse payload shaped exactly as Claude Code sends it$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.toolCommand = 'npx vitest run tests/journal'
    w.toolStdout = 'Test Files  2 passed (2)\n     Tests  48 passed | 42 todo (90)'
  })
  reg.define(/^the hook stages it and ingestion runs$/, async (w: CaptureWorld) => {
    spawnHook(w, 'post-tool-use', bashPayload(w, w.toolCommand!, w.toolStdout!))
    await drainStaging(w)
  })
  reg.define(/^the journal entry carries the tool name, the input, and an Output section with the response$/, (w: CaptureWorld) => {
    const rows = rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Bash')
    expect(rows).toHaveLength(1)
    const c = rows[0]!.content
    expect(c).toContain('Tool: Bash')
    expect(c).toContain('Input:')
    expect(c).toContain(w.toolCommand!)
    expect(c).toMatch(/Output:/)
    expect(c).toContain('48 passed')
  })

  // ── an assistant response is captured at turn end ───────────────────
  reg.define(/^a completed assistant turn on Claude Code$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.assistantText = 'The valve now archives before it deletes; eviction can no longer destroy what it cannot archive.'
    // The transcript as Claude Code holds it when Stop fires: it still
    // ends at the PREVIOUS turn (live probe 2026-10-08, D249). The turn
    // that just ended travels in the payload's last_assistant_message.
    writeTranscript(w, PREVIOUS_TURN)
  })
  // ── a stop that asks for a bookmark still captures the response (D156) ──
  reg.define(/^a completed assistant turn on Claude Code whose session's newest checkpoint is 21 rounds old$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    await seedCheckpointAge(w, 21, 5)
    w.assistantText = 'The CSRF token now refreshes on every form render; the login tests pass.'
    writeTranscript(w, PREVIOUS_TURN)
  })
  reg.define(/^the stop hook asks the agent to write a bookmark before it stops$/, (w: CaptureWorld) => {
    expectBookmarkAsked(w.hookStdout ?? '')
  })
  reg.define(/^the platform signals the turn has ended$/, async (w: CaptureWorld) => {
    spawnHook(w, 'stop', stopPayload(w, w.assistantText!))
    await drainStaging(w)
  })
  reg.define(/^the assistant's prose is in the journal with role "assistant"$/, (w: CaptureWorld) => {
    const rows = rawJournal(w).filter((r) => r.metadata['role'] === 'assistant' && !r.metadata['tool_name'])
    expect(rows).toHaveLength(1)
    // The turn that just ended, from the payload — not the previous turn
    // the transcript still ends at, and not a tool_use fragment.
    expect(rows[0]!.content).toBe(w.assistantText)
    expect(rows[0]!.content).not.toBe(PREVIOUS_TURN)
  })

  // ── every entry carries the moment its event happened ───────────────
  reg.define(/^a user message, a tool event, and an assistant response from one session$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.brackets = {} as NonNullable<CaptureWorld['brackets']>
    const bracket = async (k: 'user' | 'tool' | 'assistant', fire: () => void) => {
      const a = Date.now() / 1000
      fire()
      w.brackets![k] = [a, Date.now() / 1000]
      await sleep(400) // keep the three moments disjoint on the clock
    }
    await bracket('user', () => spawnHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'trace the moments' }))
    await bracket('tool', () => spawnHook(w, 'post-tool-use', bashPayload(w, 'git status', 'clean')))
    w.assistantText = 'All three moments recorded.'
    writeTranscript(w, PREVIOUS_TURN)
    await bracket('assistant', () => spawnHook(w, 'stop', stopPayload(w, w.assistantText!)))
  })
  reg.define(/^ingestion runs some time later$/, async (w: CaptureWorld) => {
    await sleep(600)
    w.drainedAt = Date.now() / 1000
    await drainStaging(w)
  })
  reg.define(/^each entry's capture timestamp reflects its own event's moment$/, (w: CaptureWorld) => {
    const rows = rawJournal(w)
    const within = (r: RawNode | undefined, k: 'user' | 'tool' | 'assistant') => {
      expect(r, `${k} entry missing from the journal`).toBeTruthy()
      const at = r!.metadata['created_at'] as number
      const [a, b] = w.brackets![k]
      expect(at, `${k} captured at ${at}, expected within [${a}, ${b}]`).toBeGreaterThanOrEqual(a)
      expect(at).toBeLessThanOrEqual(b)
    }
    within(rows.find((r) => r.metadata['role'] === 'user'), 'user')
    within(rows.find((r) => r.metadata['tool_name'] === 'Bash'), 'tool')
    within(rows.find((r) => r.metadata['role'] === 'assistant' && !r.metadata['tool_name']), 'assistant')
  })
  reg.define(/^a tool event's moment is when its response arrived, not when ingestion ran$/, (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['tool_name'] === 'Bash')!
    const at = row.metadata['created_at'] as number
    expect(at).toBeLessThan(w.drainedAt! - 0.4)
    expect(row.metadata['ingested_at'] as number).toBeGreaterThanOrEqual(w.drainedAt! - 0.1)
  })

  // ── outputs of execution and external tools are kept in full ────────
  reg.define(/^a failing test run whose output reflects code that has since changed$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.deepToken = `assertfail${randomBytes(4).toString('hex')}`
    const lines: string[] = []
    while (lines.join('\n').length < TOOL_OUTPUT_PREVIEW_CAP * 3) {
      lines.push(`  FAIL tests/valve.test.ts > eviction case ${lines.length}: expected 'archived', got 'deleted'`)
    }
    lines.push(`  at retentionSweep (${w.deepToken}.ts:42)`) // deep in the tail, past every preview cap
    w.toolStdout = lines.join('\n')
    w.toolCommand = 'npx vitest run tests/valve.test.ts'
    w.pendingPayload = bashPayload(w, w.toolCommand, w.toolStdout)
  })
  reg.define(/^it is captured and ingested$/, async (w: CaptureWorld) => {
    spawnHook(w, 'post-tool-use', w.pendingPayload!)
    await drainStaging(w)
  })
  reg.define(/^the full output is retrievable from the journal$/, (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['tool_name'] === 'Bash')!
    expect(row.content).toContain(w.deepToken!) // stored in full…
    expect(exportNode(w, row.nodeId)['content'] as string).toContain(w.deepToken!) // …and retrievable
  })

  // ── an oversized non-re-derivable event keeps its full content ──────
  reg.define(/^an execution or external tool event far larger than the indexed preview caps$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.deepToken = `deeptail${randomBytes(4).toString('hex')}`
    const lines: string[] = []
    while (lines.join('\n').length < TOOL_OUTPUT_PREVIEW_CAP * 20) {
      lines.push(`fetched chunk ${lines.length} of the changelog with etag ${lines.length.toString(16)}`)
    }
    lines.push(`terminal marker ${w.deepToken}`)
    w.toolStdout = lines.join('\n')
    w.toolCommand = 'curl -s https://registry.example.org/changelog'
    w.pendingPayload = bashPayload(w, w.toolCommand, w.toolStdout)
  })
  reg.define(/^the full content is retrievable from the journal$/, (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['tool_name'] === 'Bash')!
    expect(exportNode(w, row.nodeId)['content'] as string).toContain(w.deepToken!)
  })
  reg.define(/^the searchable view is bounded, with the deepest tail beyond it unindexed$/, async (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['tool_name'] === 'Bash')!
    const indexLen = row.metadata['_index_len'] as number
    expect(indexLen).toBeGreaterThan(0)
    expect(indexLen).toBeLessThan(row.content.length)
    // The deep-tail token is invisible to search…
    const miss = await w.store!.query(w.deepToken!, { topK: 5 })
    expect(miss.map((r) => r.nodeId)).not.toContain(row.nodeId)
    // …while preview words find the same entry.
    const hit = await w.store!.query('fetched chunk changelog etag', { topK: 5 })
    expect(hit.map((r) => r.nodeId)).toContain(row.nodeId)
  })

  // ── repeated identical events dedup without losing distinct ones ────
  reg.define(/^a session with capture hooks live$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
  })
  reg.define(/^the same auto-captured event arrives twice within the dedup window$/, async (w: CaptureWorld) => {
    w.toolCommand = 'npm run build'
    w.toolStdout = 'tsc -p tsconfig.build.json completed'
    const p = bashPayload(w, w.toolCommand, w.toolStdout)
    spawnHook(w, 'post-tool-use', p)
    spawnHook(w, 'post-tool-use', p)
    await drainStaging(w)
  })
  reg.define(/^one journal entry exists$/, (w: CaptureWorld) => {
    expect(rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Bash')).toHaveLength(1)
  })
  reg.define(/^the same content from a different session or outside the window is a distinct entry$/, async (w: CaptureWorld) => {
    const otherSession = `cc-${randomBytes(6).toString('hex')}`
    spawnHook(w, 'post-tool-use', { ...bashPayload(w, w.toolCommand!, w.toolStdout!), session_id: otherSession })
    await drainStaging(w)
    expect(rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Bash')).toHaveLength(2)
  })

  // ── curated notes carry what the raw stream cannot ──────────────────
  reg.define(/^a session already holding the assistant's prose on a topic$/, async (w: CaptureWorld) => {
    await openLiveStore(w)
    // A comparable auto-captured assistant-PROSE row sharing the note's
    // key words (no tool_name — prose is the down-weighted role), so
    // "full weight" is observable as rank order, not asserted as a number.
    w.comparatorId = (await w.store!.insert(
      'Next I will review eviction ordering in flat-store and write it up',
      { metadata: { source: 'auto-capture', role: 'assistant', session_id: 's-cap' } },
    )).nodeId
  })
  reg.define(/^the agent inserts a decision note with file pointers and metadata$/, async (w: CaptureWorld) => {
    w.noteId = (await w.store!.insert(
      'Decision: eviction ordering stays whole-session; fragment eviction rejected — see ts/src/flat-store.ts retentionSweep',
      { metadata: { type: 'decision', files: ['ts/src/flat-store.ts'] } },
    )).nodeId
  })
  reg.define(/^the note is stored with role "note" and ranks with full weight in search$/, async (w: CaptureWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    let indexCol: number
    try {
      indexCol = (raw.prepare('SELECT index_col FROM nodes WHERE node_id = ?').get(w.noteId) as { index_col: number }).index_col
    } finally {
      raw.close()
    }
    expect(indexCol).toBe(3) // note_text — the note role's FTS column
    const ids = (await w.store!.query('eviction ordering flat-store', { topK: 10 })).map((r) => r.nodeId)
    expect(ids).toContain(w.noteId!)
    expect(ids).toContain(w.comparatorId!)
    expect(ids.indexOf(w.noteId!)).toBeLessThan(ids.indexOf(w.comparatorId!)) // full note weight beats the 0.25 assistant-prose weight
  })

  // ── platforms without a Stop hook still journal user and tool events ─
  reg.define(/^a platform with no assistant-response hook equivalent$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
  })
  reg.define(/^its user and tool hooks fire without a turn-end signal$/, async (w: CaptureWorld) => {
    // The platform shape IS the absence: user and tool hooks fire, no
    // turn-end signal ever arrives.
    spawnHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'platform without a stop signal' })
    spawnHook(w, 'post-tool-use', bashPayload(w, 'make lint', 'lint clean'))
    await drainStaging(w)
  })
  reg.define(/^user messages and tool events are still captured$/, (w: CaptureWorld) => {
    const rows = rawJournal(w)
    expect(rows.filter((r) => r.metadata['role'] === 'user')).toHaveLength(1)
    expect(rows.filter((r) => r.metadata['tool_name'] === 'Bash')).toHaveLength(1)
    expect(rows.filter((r) => r.metadata['role'] === 'assistant' && !r.metadata['tool_name'])).toHaveLength(0)
  })
  reg.define(/^the platform's capture limitation is documented where the agent can read it$/, () => {
    const readme = readFileSync(join(TS_ROOT, 'src', 'hooks', 'README.md'), 'utf8').replace(/\s+/g, ' ')
    expect(readme).toMatch(/[Nn]ot every platform has a Stop equivalent/)
    expect(readme).toMatch(/still journals user messages and tool events/)
  })

  // ── every tool invocation is journaled, even the boring ones ────────
  reg.define(/^a session that runs ls, grep, and file reads alongside substantive work$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    spawnHook(w, 'post-tool-use', bashPayload(w, 'npm test', 'ok'))
    spawnHook(w, 'post-tool-use', {
      hook_event_name: 'PostToolUse', permission_mode: 'default',
      tool_name: 'LS', tool_input: { path: w.proj }, tool_response: '- transcript.jsonl\n- .git/',
    })
    spawnHook(w, 'post-tool-use', {
      hook_event_name: 'PostToolUse', permission_mode: 'default',
      tool_name: 'Grep', tool_input: { pattern: 'retentionSweep', path: 'src' },
      tool_response: 'src/flat-store.ts:961: retentionSweep',
    })
    spawnHook(w, 'post-tool-use', {
      hook_event_name: 'PostToolUse', permission_mode: 'default',
      tool_name: 'Read', tool_input: { file_path: join(w.proj!, 'README.md') },
      tool_response: '     1\t# temp project',
    })
  })
  reg.define(/^every call's tool name and input are in the journal$/, (w: CaptureWorld) => {
    const rows = rawJournal(w)
    const expectCall = (tool: string, needle: string) => {
      const r = rows.find((x) => x.metadata['tool_name'] === tool)
      expect(r, `no journal entry for ${tool} — an invocation was filtered out`).toBeTruthy()
      expect(r!.content).toContain(`Tool: ${tool}`)
      // The tool input is journaled as JSON, so a Windows path arrives with
      // its separators escaped (C:\\Users\\...). Compare against the encoded
      // form; on POSIX JSON.stringify leaves an ordinary path untouched, so
      // this is the same assertion there.
      expect(r!.content).toContain(JSON.stringify(needle).slice(1, -1))
    }
    expectCall('Bash', 'npm test')
    expectCall('LS', w.proj!)
    expectCall('Grep', 'retentionSweep')
    expectCall('Read', join(w.proj!, 'README.md'))
  })

  // ── outputs of repo-reading tools are trail, not treasure ───────────
  reg.define(/^a Read or ls call whose output is repo content at that moment$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.deepToken = `repotail${randomBytes(4).toString('hex')}`
    const lines: string[] = []
    while (lines.join('\n').length < TOOL_OUTPUT_PREVIEW_CAP * 3) {
      lines.push(`    ${lines.length + 1}\texport function retention(line${lines.length}) {}`)
    }
    lines.push(`    9999\t// ${w.deepToken}`) // repo content beyond the preview cap
    w.toolStdout = lines.join('\n')
    w.pendingPayload = {
      hook_event_name: 'PostToolUse', permission_mode: 'default',
      tool_name: 'Read', tool_input: { file_path: join(w.proj!, 'src', 'flat-store.ts') },
      tool_response: w.toolStdout,
    }
  })
  reg.define(/^the journal keeps the invocation and a bounded output preview$/, (w: CaptureWorld) => {
    const rows = rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Read')
    expect(rows, 'the Read invocation was filtered out instead of kept').toHaveLength(1)
    const c = rows[0]!.content
    expect(c).toContain('Tool: Read')
    // As in expectCall: the tool input is journaled as JSON, so a Windows path
    // arrives with its separators escaped. Same assertion on POSIX.
    expect(c).toContain(JSON.stringify(join(w.proj!, 'src', 'flat-store.ts')).slice(1, -1))
    expect(c).toContain('Output:')
    expect(c).toContain('export function retention(line0)') // the preview's head
  })
  reg.define(/^no full-fidelity tail is stored — the repo and its git history are the source of truth$/, (w: CaptureWorld) => {
    const row = rawJournal(w).find((r) => r.metadata['tool_name'] === 'Read')!
    expect(row.content).not.toContain(w.deepToken!)
    // step-lint: allow unearned-absence -- guarded: the provers are the length assertion just below (the row strictly shorter than toolStdout, so no full copy rides along) and the previous Then's positive on the preview's head ('export function retention(line0)'); FULL_TAIL_SEPARATOR is the product's tail marker, absent from the fixture, so this line alone proves nothing
    expect(row.content).not.toContain('--- FULL ---')
    expect(row.metadata['_index_len'], 'a tail boundary implies a stored tail').toBeUndefined()
    expect(row.content.length).toBeLessThan(w.toolStdout!.length)
  })

  // ── a dropped or failed event leaves a visible gap marker ───────────
  reg.define(/^a staged event that will fail every ingestion attempt$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    w.deepToken = `POISON${randomBytes(4).toString('hex')}`
    // Fault injection in the chmod tradition: a real SQLite failure on
    // the production insert path, no code seams. The trigger aborts any
    // node insert carrying the poison token — except the capture-gap
    // record itself, which is the recovery this scenario exists to pin.
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      raw.exec(
        `CREATE TRIGGER poison_block BEFORE INSERT ON nodes ` +
        `WHEN new.content LIKE '%${w.deepToken}%' AND COALESCE(json_extract(new.metadata_json, '$.source'), '') != 'capture-gap' ` +
        `BEGIN SELECT RAISE(ABORT, 'injected storage fault'); END`,
      )
    } finally {
      raw.close()
    }
    spawnHook(w, 'post-tool-use', bashPayload(w, 'echo diagnostics', `diagnostic marker ${w.deepToken}`))
  })
  reg.define(/^ingestion retries it to exhaustion$/, async (w: CaptureWorld) => {
    await drainStaging(w) // retries happen inside the drain: attempt, attempt, dead-letter
  })
  reg.define(/^the journal contains a capture-gap entry in its place$/, (w: CaptureWorld) => {
    const rows = rawJournal(w)
    const gaps = rows.filter((r) => r.metadata['source'] === 'capture-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.content).toMatch(/^\[capture gap\]/)
    expect(gaps[0]!.content).toContain('Bash')
    expect(gaps[0]!.metadata['staging_id']).toBeTruthy()
    // "in its place": the event itself never became a journal entry.
    expect(rows.filter((r) => r.metadata['tool_name'] === 'Bash')).toHaveLength(0)
  })
  reg.define(/^the poisoned payload is retired to a dead-letter record, not deleted$/, (w: CaptureWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      const row = raw.prepare(`SELECT processed, attempts, content FROM staging WHERE content LIKE '%' || ? || '%'`).get(w.deepToken) as
        | { processed: number; attempts: number; content: string }
        | undefined
      expect(row, 'poisoned staging row was deleted').toBeTruthy()
      expect(row!.processed).toBe(1) // retired…
      expect(row!.attempts).toBeGreaterThanOrEqual(2) // …after real retries
      expect(row!.content).toContain(w.deepToken!) // …payload intact for post-mortem
    } finally {
      raw.close()
    }
  })
  // S: every capture carries the session that produced it.
  //
  // The register's "combined harness" now exists on both halves: real
  // hook subprocesses stage the captures (session_id from the platform
  // payload), and the agent's note arrives through the real MCP server
  // with the ccSessionId option — the identity ladder's explicit rung
  // (docs/session-identity.md). The two spellings meet in the window
  // lookup's COALESCE, which is what "one session" means at read time.
  reg.define(/^hooks capturing events for a known platform session$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit', prompt: 'wire the drain valve to the budget report',
    })
    spawnHook(w, 'post-tool-use', bashPayload(w, 'npm test', 'valve suite green'))
  })
  reg.define(/^those events are ingested and the agent inserts a note in the same session$/, async (w: CaptureWorld) => {
    await drainStaging(w)
    const client = await mcpOver(w, { ccSessionId: w.sessionId! })
    await client.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'NOTE: drain valve wired to the budget report — decision recorded mid-session' },
    })
  })
  reg.define(/^the captures and the note carry the same session identity$/, (w: CaptureWorld) => {
    const rows = rawJournal(w)
    const captures = rows.filter((r) => r.metadata['source'] === 'auto-capture')
    expect(captures.length).toBeGreaterThanOrEqual(2)
    for (const c of captures) {
      expect(c.metadata['session_id'], 'a capture without its platform session').toBe(w.sessionId)
    }
    const note = rows.find((r) => r.content.includes('NOTE: drain valve wired'))
    expect(note, 'the agent note must exist').toBeTruthy()
    expect(note!.metadata['_cc_session_id']).toBe(w.sessionId)
    expect(note!.metadata['_cc_session_src']).toBe('explicit')
  })
  reg.define(/^conversation windows group them as one session$/, async (w: CaptureWorld) => {
    const [hit] = await w.store!.query('decision recorded mid-session', { topK: 1, conversationWindow: 5 })
    expect(hit).toBeTruthy()
    expect(hit!.content).toContain('NOTE: drain valve wired')
    const neighbors = [...(hit!.window?.before ?? []), ...(hit!.window?.after ?? [])]
    // The hook-captured events sit in the note's window: two identity
    // spellings, one conversation.
    expect(neighbors.length).toBeGreaterThanOrEqual(2)
    const neighborText = neighbors.map((e) => e.content).join('\n')
    expect(neighborText).toContain('wire the drain valve to the budget report')
    expect(neighborText).toContain('npm test')
  })

  // ── a server abandoned by its client shuts down instead of spinning ──
  //
  // The one wave scenario that runs `serve` as a REAL subprocess with a
  // hostile client on the other end: the claim is about the process's
  // fate, so the assertion has to be the process's fate. The broken
  // build (pre-2026-08-30) hangs the Then forever — its event loop is a
  // dead-stderr exception storm that a closed stdin cannot shut down.
  reg.define(/^a live capture server whose client has abandoned its stderr$/, async (w: CaptureWorld) => {
    const { child, home } = spawnServeChild(w, 'tc-abandon-', 'abandonprobe')
    // Wait for the transport, not for the db FILE: better-sqlite creates
    // the file before the migration ladder runs, and a staging row
    // written into that window meets "no such table: staging". The
    // announcement is a diagnostic, so under D258 it is in the log file.
    const seen = await waitForServeLog(home, 'stdio transport connected')
    expect(seen, 'server never announced its transport').toContain('stdio transport connected')
    // The abandonment observed live: the client drops only its stderr
    // end and keeps the conversation open. Destroying the parent-side
    // stream closes the pipe, so the server's next write raises EPIPE.
    child.stderr!.destroy()
  })
  reg.define(/^the server's next warning lands on the dead stream$/, async (w: CaptureWorld) => {
    // Under D258 a serving server's diagnostics go to its log file only,
    // so the write that can meet the dead stream is a genuine warning.
    // Provoke warnings through the real path: malformed recovery
    // snapshots staged straight into the sandbox store, which the drain
    // dead-letters with a warning on stderr (ingestion.ts, the
    // malformed-snapshot branch). TWO of them, one tick apart: on Linux
    // the first write after the peer closes its end still lands in the
    // socket buffer and only the next one raises EPIPE — one warning
    // never reaches the storm this scenario exists to rule out.
    const stageMalformed = (): number => {
      const raw = new BetterSqlite3(w.serveDbPath!)
      try {
        raw.pragma('busy_timeout = 5000')
        return Number(raw.prepare(
          "INSERT INTO staging (session_id, role, content, timestamp) VALUES (?, 'snapshot', ?, ?)",
        ).run('abandon-probe-session', '{"queries": [unterminated', Date.now() / 1000).lastInsertRowid)
      } finally {
        raw.close()
      }
    }
    const awaitWarning = async (id: number): Promise<void> => {
      const warning = `Malformed snapshot JSON in staging row ${id} — dead-lettered`
      // The warning's copy in the log file says it was written — on
      // stderr as a warning, not as a diagnostic (the file marks which).
      const seen = await waitForServeLog(w.serveHome!, warning, INGESTION_TICK_MS * 3 + 5_000)
      const line = seen.split('\n').find((l) => l.includes(warning))
      expect(line, `the drain never warned about staging row ${id}:\n${seen.slice(-2000)}`).toBeTruthy()
      expect(line!.startsWith(WARN_PREFIX), `a warning, not a diagnostic: ${line}`).toBe(true)
    }
    const ids: number[] = []
    for (let i = 0; i < 2; i++) {
      const id = stageMalformed()
      ids.push(id)
      await awaitWarning(id)
    }
    // Wait one more tick past the second warning: a storm, had one
    // started, has had its turn of the loop.
    await sleep(INGESTION_TICK_MS + 1_500)
    expect(w.serveChild!.exitCode, 'stdin is still open — the server must still be serving').toBeNull()
    expect(w.serveChild!.signalCode, 'stdin is still open — the server must still be serving').toBeNull()
    // And the warnings were about real work done: each staged row is
    // retired, and the journal holds its capture-gap tombstone.
    const db = new BetterSqlite3(w.serveDbPath!, { readonly: true })
    try {
      db.pragma('busy_timeout = 5000')
      for (const id of ids) {
        const row = db.prepare('SELECT processed FROM staging WHERE id = ?').get(id) as { processed: number } | undefined
        expect(row?.processed, `staging row ${id} was not retired`).toBe(1)
        const gaps = db.prepare(
          "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.source') = 'capture-gap' "
          + "AND json_extract(metadata_json, '$.event') = 'malformed_snapshot' "
          + "AND json_extract(metadata_json, '$.staging_id') = ?",
        ).get(id) as { n: number }
        expect(gaps.n, `no malformed_snapshot capture gap for staging row ${id}`).toBe(1)
      }
    } finally {
      db.close()
    }
  })
  reg.define(/^the client closes the conversation channel$/, (w: CaptureWorld) => {
    w.serveChild!.stdin!.end()
  })

  // ── a client that dies before the server finishes starting ─────────
  //
  // The same claim aimed at the STARTUP window rather than a live
  // session: stdin announces its EOF once, and a watch wired after the
  // startup work missed it entirely (rc.6 review of ab58c27). The
  // channel is closed the moment the transport reports itself
  // connected, which is where capture initialization takes over.
  reg.define(/^a capture server that has only just opened its stdio channel$/, async (w: CaptureWorld) => {
    // The announcement is a diagnostic, so under D258 it lands in the
    // sandbox HOME's log file, not on stderr.
    const { home } = spawnServeChild(w, 'tc-startup-death-', 'startupdeath')
    const seen = await waitForServeLog(home, 'stdio transport connected')
    expect(seen, 'server never announced its transport').toContain('stdio transport connected')
  })
  reg.define(/^the server process exits cleanly$/, async (w: CaptureWorld) => {
    const child = w.serveChild!
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'exit'), sleep(10_000)])
    }
    expect(child.signalCode, 'exited by its own shutdown, not a signal').toBeNull()
    expect(child.exitCode).toBe(0)
  })

  // ── the first hook on a fresh install captures without waiting for a server ──
  // (issue #2). The sandbox has a home and a project and NOTHING under the
  // stores directory; the real hook subprocess is the first thing ever to
  // touch the store path, exactly as on a machine between `install` and
  // the server's first boot.
  reg.define(/^a fresh install whose bound store no server has ever opened$/, (w: CaptureWorld) => {
    openCaptureSandbox(w)
    expect(existsSync(dirname(w.dbPath!))).toBe(false)
  })
  reg.define(/^a user prompt hook fires before any server has started$/, (w: CaptureWorld) => {
    w.prompt = 'first words on a fresh install — said before any server has ever run'
    const before = Date.now() / 1000
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      prompt: w.prompt,
    })
    w.saidAt = [before, Date.now() / 1000]
  })
  reg.define(/^a tool hook fires before any session or prompt hook has run$/, (w: CaptureWorld) => {
    // PostToolUse writes no session beacon — nothing but the opener
    // itself stands between this hook and a missing directory.
    w.prompt = 'first-ever-tool-output-on-a-fresh-install'
    spawnHook(w, 'post-tool-use', bashPayload(w, 'echo first', w.prompt))
  })
  reg.define(/^the event is staged in that store at the current schema$/, (w: CaptureWorld) => {
    // Direct SQLite inspection (the verification rule): the file the hook
    // minted sits at the ladder's head, and the event waits in staging
    // unprocessed — a server has yet to see it. For a prompt, index_len
    // is the column the legacy tier cannot write, so a NULL there would
    // name a write that landed under the ladder; a tool event carries
    // one only past the preview cap, so it proves nothing there.
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(maxSupportedVersion)
      const rows = raw.prepare('SELECT role, content, processed, index_len FROM staging').all() as Array<{ role: string; content: string; processed: number; index_len: number | null }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toContain(w.prompt)
      expect(rows[0]!.processed).toBe(0)
      if (rows[0]!.role === 'user') expect(rows[0]!.index_len).not.toBeNull()
    } finally {
      raw.close()
    }
  })
  reg.define(/^a server opening the store later ingests it with its original moment$/, async (w: CaptureWorld) => {
    await sleep(600) // a later boot, so said-time vs ingest-time is observable
    w.drainedAt = Date.now() / 1000
    await adoptCaptureStore(w)
    await drainStaging(w)
    const row = rawJournal(w).find((r) => r.metadata['role'] === 'user')!
    expect(row.content).toBe(w.prompt)
    const at = row.metadata['created_at'] as number
    expect(at).toBeGreaterThanOrEqual(w.saidAt![0])
    expect(at).toBeLessThanOrEqual(w.saidAt![1])
    expect(w.drainedAt! - at).toBeGreaterThan(0.4)
  })

  // ── hooks racing to create one fresh store ──────────────────────────
  reg.define(/^six capture hooks fire at once before any server has started$/, async (w: CaptureWorld) => {
    // Six distinct prompts, a marker per racer so the assertion can name
    // the one that lost. The legacy tier stages a prompt's content whole
    // (it cuts only at a preview boundary, which prompts never carry), so
    // content alone cannot tell the tiers apart — index_len does, below.
    w.descriptions = Array.from({ length: 6 }, (_, i) => `racer ${i} — end of racer ${i}`)
    await spawnHooksAtOnce(w, 'user-prompt-submit', w.descriptions.map((prompt) => ({
      hook_event_name: 'UserPromptSubmit',
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      prompt,
    })))
  })
  reg.define(/^every one of them is staged at the current schema with its content intact$/, (w: CaptureWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(maxSupportedVersion)
      // index_len is the column the legacy tier cannot write (the pre-v16
      // fallback stages only content): a NULL here names a write that
      // landed under the ladder.
      const rows = raw.prepare("SELECT content, index_len FROM staging WHERE role = 'user' ORDER BY id").all() as Array<{ content: string; index_len: number | null }>
      expect(rows.map((r) => r.content).sort()).toEqual([...w.descriptions!].sort())
      for (const r of rows) expect(r.index_len, `staged under the ladder: ${r.content.slice(0, 12)}`).not.toBeNull()
    } finally {
      raw.close()
    }
  })

  // ── a schema-less store file left by an earlier hook is healed ──────
  reg.define(/^a bound store file that holds no schema at all$/, (w: CaptureWorld) => {
    openCaptureSandbox(w)
    mkdirSync(dirname(w.dbPath!), { recursive: true })
    // Exactly rc.6's leftover: an open, the WAL pragma, a close — a file
    // with a header and an empty sqlite_master.
    const shell = new BetterSqlite3(w.dbPath!)
    shell.pragma('journal_mode = WAL')
    shell.close()
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      expect(raw.prepare('SELECT count(*) AS c FROM sqlite_master').get()).toEqual({ c: 0 })
    } finally {
      raw.close()
    }
  })
  reg.define(/^a capture hook fires against it$/, (w: CaptureWorld) => {
    w.prompt = 'the hook that heals the shell it once left behind'
    spawnHook(w, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      transcript_path: join(w.proj!, 'transcript.jsonl'),
      prompt: w.prompt,
    })
  })

}

