import { pragmaValue, setPragma } from '../../../src/persistence/node-sqlite.js'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { TOOL_OUTPUT_PREVIEW_CAP } from '../../../src/persistence/capture-constants.js'
import { INGESTION_TICK_MS } from '../../../src/server/ingestion.js'
import { WARN_PREFIX } from '../../../src/debug.js'
import { mcpOver, openLiveStore, exportNode } from '../world.js'
import { TS_ROOT, sleep } from '../proc.js'
import { maxSupportedVersion } from '../../../src/persistence/migrations/index.js'
import { T0 } from '../world.js'
import { RECOVERY_SNAPSHOT_SOURCE, RECOVERY_QUERIES_KEY, RECOVERY_QUOTE_CAP, RECOVERY_PREVIEW_LEN, RECOVERY_INDEX_LEN } from '../../../src/persistence/recovery-snapshot.js'
import { ftsNodeIds } from '../../helpers/echo-capture.js'
import { recordedSession, replayRecordedSession, agyEventOf, agyTranscriptOf, agyTranscriptLinesOf, type ReplayedEvent } from '../standins.js'
import { placementsOf } from '../../../src/persistence/lane-scope.js'
import { laneOfRow, UNKNOWN_LANE } from '../../../src/references.js'
import { classifyExit, EXIT_BY_KEY } from '../../../src/server/event-processing.js'
import { composeToolEntry } from '../../../src/hooks/post-tool-use.js'
import { NO_RESULT_LINE, NO_TURN_END_LINE } from '../../../src/persistence/capture-marks.js'
import { type CaptureWorld, openCaptureSandbox, adoptCaptureStore, openCaptureWorld, runHook, spawnHook, spawnHooksAtOnce, spawnServeChild, waitForServeLog, drainStaging, type RawNode, rawJournal, bashPayload, writeTranscript, seedCheckpointAge, expectBookmarkAsked } from '../capture-harness.js'

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

/** The D270 scenario's extra world. */
type D270World = CaptureWorld & { lineWords?: string[]; tabWord?: string; legacyWords?: string[] }

/** The one captured Bash row whose content carries `word`. */
function d270Row(w: CaptureWorld, word: string): RawNode {
  const rows = rawJournal(w).filter((r) => r.metadata['tool_name'] === 'Bash' && r.content.includes(word))
  expect(rows, `no single captured row carries ${word}`).toHaveLength(1)
  return rows[0]!
}

/** Node ids whose FTS row matches `token` as a whole token, read straight
 *  from nodes_fts (the verification rule). */
function ftsRowsMatching(w: CaptureWorld, token: string): string[] {
  const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
  try {
    return (raw.prepare(
      'SELECT n.node_id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ? ORDER BY n.rowid',
    ).all(`"${token}"`) as Array<{ node_id: string }>).map((r) => r.node_id)
  } finally {
    raw.close()
  }
}

/** The recorded Claude Code sessions these bindings replay (D402). */
const RECORDED_VERSION = '2.1.319'
const SERIAL = 'serial-failures-and-denials.ndjson'
const PARALLEL = 'parallel-batch-hook-block-mcp-errors-subagent.ndjson'
const REPO_READING = 'repo-reading-and-long-output.ndjson'
/** The parallel session's first batch: Bash `echo par-ok-slow-hook`
 *  (succeeds), Bash `ls /nonexistent-par` (exit 2), an Edit rejected for
 *  its input, and a ToolSearch (succeeds). */
const PARALLEL_OK = 'toolu_01ExmFevbQgvcsxnJm65RtcV'
const PARALLEL_FAILED = 'toolu_01CJ3mnjPCSEkJMQDpg4Hs9a'
const PARALLEL_REJECTED = 'toolu_01GNi6XzvVa1DEG9jzB5ePuH'
const PARALLEL_TOOLSEARCH = 'toolu_01JgTCyS5FH3JHaaVBfwvfFH'

interface NamedCall { id: string; tool: string; what: string }
/** D404's recording: Claude Code 2.1.321, four calls that succeeded with
 *  output that reads like trouble (the fixture README's table). */
const TROUBLE_VERSION = '2.1.321'
const TROUBLE = 'success-reading-like-trouble.ndjson'
const TROUBLE_CALLS: NamedCall[] = [
  { id: 'toolu_01GDmjXWabPpieoJbbUASiPG', tool: 'Bash', what: 'a shell command printing "error: 0 found, 0 failed"' },
  { id: 'toolu_01DdMYpiSoMgssKrFRavkBQB', tool: 'Bash', what: 'a shell command printing "warning: deprecated"' },
  { id: 'toolu_01MPYedMaj7A1poAntXnC4N7', tool: 'mcp__probe__seen', what: 'an MCP tool answering "failed call seen"' },
  { id: 'toolu_018hPJpgR4WUwxgBNvTDw4eH', tool: 'Read', what: 'a file read of a file that holds a Python traceback' },
]
/** D400's failures, by the client's id (the fixture README's table). */
const FAILED_CALLS: NamedCall[] = [
  { id: 'toolu_01FvqNcZYBnuCsHBiwp6o3Mj', tool: 'Bash', what: 'a shell command that exits non-zero (ls, exit 2)' },
  { id: 'toolu_01Uce7kGn9KwGNm8bkJRj8rr', tool: 'Bash', what: 'a shell command that exits non-zero (exit 7, stdout and stderr)' },
  { id: 'toolu_01FE2NPXLRRYkKKuSzvA5WpZ', tool: 'Read', what: 'a file read that fails' },
  { id: 'toolu_01VZtRcwK5BmD25XRcfhTkLj', tool: 'Bash', what: 'a command that times out' },
  { id: 'toolu_011BwmKDpXffq2ToBYPufCmD', tool: 'mcp__probe__fail_iserror', what: 'an MCP tool answering isError' },
  { id: 'toolu_01QcTUn2pcrYwiMYKGYEP5x5', tool: 'mcp__probe__fail_throw', what: 'an MCP tool answering a protocol error' },
]
/** D401's calls resolved without running, by the client's id. */
const REFUSED_CALLS: NamedCall[] = [
  { id: 'toolu_011vY6TQFTBGEGvzxAU1gH2z', tool: 'Edit', what: 'a call rejected for its input (serial)' },
  { id: PARALLEL_REJECTED, tool: 'Edit', what: 'a call rejected for its input (in a parallel batch)' },
  { id: 'toolu_016tYJEkXhrUAYW9DceAdgQY', tool: 'Write', what: 'a call denied permission (Write)' },
  { id: 'toolu_01Eh6sZA8krzkd9tRXFMms21', tool: 'WebFetch', what: 'a call denied permission (WebFetch)' },
  { id: 'toolu_01RdX9DY9gPKMbLdBeuKpre2', tool: 'Bash', what: 'a call a PreToolUse hook blocked' },
  { id: 'toolu_01M7pR8G3pzPXhq8xQkcfzSY', tool: 'Write', what: "a subagent's call denied permission" },
  { id: 'toolu_01VCEYEndqs8NLCYxquxWvuZ', tool: 'Edit', what: "a subagent's call rejected for its input" },
]

/** The replay scenarios' world (D400, D401). */
type ReplayWorld = CaptureWorld & {
  recorded?: Array<{ events: Array<Record<string, unknown>>; through?: number }>
  replays?: ReplayedEvent[][]
  calls?: Array<NamedCall & { payload: Record<string, unknown> }>
  batchIds?: string[]
  /** Codex's id for the interrupted turn (D408). */
  codexTurn?: string
  /** The moment staging held for a call's PreToolUse account (D408). */
  accountAt?: number
  /** agy (D415): how the replay hands the transcript; the two conversations of a subagent set. */
  agyTranscript?: 'recorded' | 'unreadable'
  agyParent?: string
  agyChild?: string
}

/** A named call as the recorded files hold it: the payload of the event
 *  of `kind` carrying it (the call itself, from a batch's account). */
function recordedCall(w: ReplayWorld, id: string, kind: 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch'): { payload: Record<string, unknown> } {
  for (const e of w.recorded!.flatMap((r) => r.events)) {
    if (e['hook_event_name'] !== kind) continue
    if (kind === 'PostToolBatch') {
      const call = (e['tool_calls'] as Array<Record<string, unknown>>).find((t) => t['tool_use_id'] === id)
      if (call) return { payload: call }
    } else if (e['tool_use_id'] === id) {
      return { payload: e }
    }
  }
  throw new Error(`no ${kind} event in the recorded files carries ${id}`)
}

/** The one journal entry carrying the client's id for a call. */
function onlyEntryOf(w: CaptureWorld, id: string): RawNode {
  const rows = rawJournal(w).filter((r) => r.metadata['tool_use_id'] === id)
  expect(rows, `the journal holds ${rows.length} entries for the call ${id}, not one`).toHaveLength(1)
  return rows[0]!
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
  // D402: "as Claude Code sends it" is a recorded event, never a payload
  // written here: the serial session's one successful Bash call (`echo
  // probe-ok`, its PostToolUse as Claude Code 2.1.319 fired it).
  reg.define(/^a PostToolUse payload shaped exactly as Claude Code sends it$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const events = recordedSession(RECORDED_VERSION, SERIAL)
    const line = events.findIndex((e) => e['hook_event_name'] === 'PostToolUse' && e['tool_use_id'] === 'toolu_017WkjHRbHSjGabaDwQkTWJE')
    expect(line, 'the recorded PostToolUse event is not in the fixture').toBeGreaterThanOrEqual(0)
    w.recorded = [{ events: [events[line]!] }]
    w.toolCommand = String((events[line]!['tool_input'] as Record<string, unknown>)['command'])
    w.toolStdout = String((events[line]!['tool_response'] as Record<string, unknown>)['stdout'])
    expect(w.toolCommand).toBe('echo probe-ok')
    expect(w.toolStdout).toBe('probe-ok')
  })
  reg.define(/^the hook stages it and ingestion runs$/, async (w: ReplayWorld) => {
    const replayed = replayRecordedSession(w, w.recorded![0]!.events)
    expect(replayed.map((r) => r.hooks), 'the PostToolUse event reached no hook install wires').toEqual([['post-tool-use']])
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
    expect(c.slice(c.indexOf('\nOutput:'))).toContain(w.toolStdout!)
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

  // ── D270: a tool event's output is captured as text, a line a line ──
  reg.define(/^a shell command whose output spans several lines and carries a tab$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    const d = w as D270World
    const tag = randomBytes(3).toString('hex').replace(/[0-9]/g, 'q')
    // One distinctive word to begin each line, the second line's after a
    // tab; and a word after the tab on the third.
    d.lineWords = [`alderline${tag}`, `birchline${tag}`, `cedarline${tag}`]
    d.tabWord = `tabbedword${tag}`
    w.toolStdout = `${d.lineWords[0]} first line of the log\n\t${d.lineWords[1]} indented second line\n${d.lineWords[2]}\t${d.tabWord} third`
    w.toolCommand = 'git log --format=%s -3'
    w.pendingPayload = bashPayload(w, w.toolCommand, w.toolStdout)
    // An entry captured before this rule: staged in the composition the
    // hook wrote until D270, the JSON encoding of the object payload.
    d.legacyWords = [`oakline${tag}`, `pineline${tag}`]
    const legacyInput = { command: 'git log --format=%s -2', description: 'Run command' }
    const legacyResponse = { stdout: `${d.legacyWords[0]} old first\n${d.legacyWords[1]} old second`, stderr: '', interrupted: false, isImage: false }
    w.store!.store.insertStaging({
      sessionId: w.sessionId!,
      role: 'assistant',
      content: `Tool: Bash\nInput:\n${JSON.stringify(legacyInput)}\nOutput:\n${JSON.stringify(legacyResponse)}`,
      toolName: 'Bash',
      timestamp: Date.now() / 1000 - 60,
      priority: 2,
    })
  })
  reg.define(/^the event is captured and ingested$/, async (w: CaptureWorld) => {
    spawnHook(w, 'post-tool-use', w.pendingPayload!)
    await drainStaging(w)
  })
  reg.define(/^the word that begins each line is findable by itself$/, async (w: CaptureWorld) => {
    const d = w as D270World
    const row = d270Row(w, d.lineWords![0]!)
    for (const word of [...d.lineWords!, d.tabWord!]) {
      // The index itself: the bare word is its own token in this row.
      expect(ftsRowsMatching(w, word), `${word} is not its own token`).toEqual([row.nodeId])
      // And the query surface finds the row by it.
      const hits = await w.store!.query(word, { topK: 5 })
      expect(hits.map((h) => h.nodeId), `${word} does not find the captured row`).toContain(row.nodeId)
    }
  })
  reg.define(/^the stored entry shows the output's lines as lines, not as escape sequences$/, (w: CaptureWorld) => {
    const d = w as D270World
    const row = d270Row(w, d.lineWords![0]!)
    const exported = exportNode(w, row.nodeId)['content'] as string
    // The control: the JSON encoding this rule replaced carries both
    // escape needles, so the absences below can fire.
    const encoded = JSON.stringify(w.toolStdout!)
    expect(encoded).toContain('\\n')
    expect(encoded).toContain('\\t')
    for (const c of [row.content, exported]) {
      expect(c).toContain(`Output:\nstdout:\n${w.toolStdout!}\n`)
      expect(c).toContain(`Input:\ncommand:\n${w.toolCommand!}\n`)
      // step-lint: allow unearned-absence -- guarded: the control above proves JSON.stringify of this stdout carries the needle
      expect(c).not.toContain('\\n')
      // step-lint: allow unearned-absence -- guarded: the control above proves JSON.stringify of this stdout carries the needle
      expect(c).not.toContain('\\t')
    }
  })
  reg.define(/^an entry captured before this rule is still found by its glued word and shows its escape sequences$/, async (w: CaptureWorld) => {
    const d = w as D270World
    const row = d270Row(w, d.legacyWords![0]!)
    // Its second line's word was indexed glued to the escape's letter.
    const glued = `n${d.legacyWords![1]!}`
    expect(ftsRowsMatching(w, glued)).toEqual([row.nodeId])
    const hits = await w.store!.query(glued, { topK: 5 })
    expect(hits.map((h) => h.nodeId)).toContain(row.nodeId)
    // Its stored text is what it was: the escape sequences, untouched.
    const exported = exportNode(w, row.nodeId)['content'] as string
    expect(exported).toContain(`${d.legacyWords![0]!} old first\\n${d.legacyWords![1]!} old second`)
    expect(row.content).toBe(exported)
  })

  // ── D286: the recovery snapshot quotes the journal at its preview ─────
  const RECOVERY_QUERY = 'current active plan and next steps'
  const recoverySeeds = new WeakMap<CaptureWorld, { noteId: string; longNoteId: string; toolId: string; oldId: string; longNote: string; toolPreviewMarker: RegExp }>()
  reg.define(/^a journal holding curated notes, an oversized tool event, and an earlier recovery snapshot that matches the recovery queries$/, async (w: CaptureWorld) => {
    await openCaptureWorld(w)
    const noteId = (await w.store!.insert('the active plan: finish the valve rework, then the next step is the budget report', { metadata: { type: 'plan' } })).nodeId
    const sentence = 'the plan carries one next step per decision and its rationale, kept for the next session. '
    const longNote = sentence.repeat(Math.ceil((RECOVERY_QUOTE_CAP * 2) / sentence.length)) + 'closing marker deepquote'
    const longNoteId = (await w.store!.insert(longNote, { metadata: { type: 'note' } })).nodeId
    // A tool event with the hook's boundary: its display view is the
    // preview plus the availability marker, and that is what gets quoted.
    const toolFull = `Tool: Bash plan step runner\n${'next step of the plan: compiling and emitting diagnostics\n'.repeat(400)}`
    const toolId = (await w.store!.insert(toolFull, { metadata: { source: 'auto-capture', role: 'tool', session_id: 's-tool', _index_len: 1000 } })).nodeId
    // An earlier recovery snapshot in the beta.2 shape: the query text in
    // its content, so it is the best match for the query it answered.
    const oldId = (await w.store!.insert(`# Recovery Query: ${RECOVERY_QUERY}\n\n## \noldsnapshot quoted the plan and the next steps whole\n\n`, {
      metadata: { source: RECOVERY_SNAPSHOT_SOURCE, original_session_id: 's-older', recovered_at: T0 },
    })).nodeId
    recoverySeeds.set(w, { noteId, longNoteId, toolId, oldId, longNote, toolPreviewMarker: /…\[preview; full content \d+ chars via treecontext_export\]/ })
  })
  reg.define(/^the drain processes a claimed snapshot$/, async (w: CaptureWorld) => {
    w.store!.store.insertStaging({
      sessionId: 's-after-compaction', role: 'snapshot', priority: 0, timestamp: T0 + 100,
      content: JSON.stringify({ queries: [RECOVERY_QUERY], original_session_id: 's-before-compaction' }),
    })
    await drainStaging(w)
  })
  const newRecoveryRow = (w: CaptureWorld): RawNode => {
    const rows = rawJournal(w).filter((r) => r.metadata['source'] === RECOVERY_SNAPSHOT_SOURCE && r.metadata['original_session_id'] === 's-before-compaction')
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  reg.define(/^the recovery row quotes each hit at its display view, cut at the quote cap and named by its entry$/, (w: CaptureWorld) => {
    const seeds = recoverySeeds.get(w)!
    const row = newRecoveryRow(w)
    // The short plan: quoted whole, named.
    expect(row.content).toContain(`## entry ${seeds.noteId}\nthe active plan: finish the valve rework`)
    // The long note: cut at the cap, with the marker naming the export door and the entry.
    expect(row.content).toContain(`## entry ${seeds.longNoteId}\n${seeds.longNote.slice(0, RECOVERY_QUOTE_CAP)}…[quoted to ${RECOVERY_QUOTE_CAP} chars; full content ${seeds.longNote.length} chars via treecontext_export(${seeds.longNoteId})]`)
    // The needle is proven on the source: the note ends in the marker the cut removed.
    expect(seeds.longNote).toContain('deepquote')
    // step-lint: allow unearned-absence -- guarded: the control directly above proves the source note carries the needle; the cut quote is asserted present at the cap just above it
    expect(row.content).not.toContain('deepquote')
    // The tool event: its display view, preview plus marker, never its full tail.
    const toolSection = row.content.split(`## entry ${seeds.toolId}\n`)[1]
    expect(toolSection, 'the tool event is quoted').toBeTruthy()
    const toolQuote = toolSection!.split('\n\n')[0]!
    expect(toolQuote).toMatch(seeds.toolPreviewMarker)
    expect(toolQuote.length).toBeLessThan(RECOVERY_QUOTE_CAP)
    // The needle is proven in scope: the long note's quote carries the cut marker; the tool's does not.
    expect(row.content).toContain('…[quoted to')
    // step-lint: allow unearned-absence -- guarded: the control directly above proves the same row carries the marker (the long note's quote); the tool's quote is the slice asserted shorter than the cap
    expect(toolQuote).not.toContain('…[quoted to')
  })
  reg.define(/^the earlier recovery snapshot is not quoted$/, (w: CaptureWorld) => {
    const seeds = recoverySeeds.get(w)!
    const row = newRecoveryRow(w)
    // The needle is proven on the earlier row itself, which still holds it.
    const older = rawJournal(w).find((r) => r.nodeId === seeds.oldId)!
    expect(older.content).toContain('oldsnapshot')
    expect(row.content).not.toContain(seeds.oldId)
    // step-lint: allow unearned-absence -- guarded: the control two lines above proves the earlier row in the same journal carries the needle
    expect(row.content).not.toContain('oldsnapshot')
  })
  reg.define(/^the recovery queries sit in the row's metadata, not in its indexed words$/, (w: CaptureWorld) => {
    const seeds = recoverySeeds.get(w)!
    const row = newRecoveryRow(w)
    expect(row.metadata[RECOVERY_QUERIES_KEY]).toEqual([RECOVERY_QUERY])
    expect(row.content).not.toContain(RECOVERY_QUERY)
    const ids = ftsNodeIds(w.dbPath!, RECOVERY_QUERY)
    expect(ids, 'control: the beta.2-shaped row matches its own query').toContain(seeds.oldId)
    expect(ids).not.toContain(row.nodeId)
  })
  reg.define(/^the row carries its own display and index boundaries$/, (w: CaptureWorld) => {
    const row = newRecoveryRow(w)
    expect(row.metadata['_preview_len']).toBe(Math.min(RECOVERY_PREVIEW_LEN, row.content.length))
    expect(row.metadata['_index_len']).toBe(Math.min(RECOVERY_INDEX_LEN, row.content.length))
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
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    let indexCol: number
    try {
      indexCol = (raw.prepare('SELECT index_col FROM nodes WHERE node_id = ?').get(w.noteId!) as { index_col: number }).index_col
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
  // A recorded session (D402): ls through Bash, Glob, Grep and Read beside
  // shell work, one of whose commands fails after a long output, replayed
  // through the hooks install wires. The census is the client's own: every
  // call any PostToolBatch of the session names.
  reg.define(/^a session that runs ls, grep, and file reads alongside substantive work$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const events = recordedSession(RECORDED_VERSION, REPO_READING)
    const tools = new Set(events.filter((e) => e['hook_event_name'] === 'PreToolUse').map((e) => String(e['tool_name'])))
    expect([...tools].sort(), 'the recording is not the session the Given names').toEqual(['Bash', 'Glob', 'Grep', 'Read'])
    w.recorded = [{ events }]
    w.replays = [replayRecordedSession(w, events)]
  })
  reg.define(/^every call's tool name and input are in the journal$/, (w: ReplayWorld) => {
    const events = w.recorded![0]!.events
    const calls = events.filter((e) => e['hook_event_name'] === 'PostToolBatch')
      .flatMap((e) => e['tool_calls'] as Array<Record<string, unknown>>)
    expect(calls.length, 'the session\'s batches name no call').toBeGreaterThan(0)
    expect(new Set(calls.map((c) => c['tool_use_id'])).size).toBe(calls.length)
    for (const c of calls) {
      const id = String(c['tool_use_id'])
      const row = onlyEntryOf(w, id)
      expect(row.metadata['tool_name'], id).toBe(c['tool_name'])
      expect(row.content.startsWith(`Tool: ${String(c['tool_name'])}\n`), id).toBe(true)
      // D270: the input as its text, each field as the client sent it.
      const out = row.content.indexOf('\nOutput:')
      const input = out > 0 ? row.content.slice(0, out) : row.content
      for (const v of Object.values(c['tool_input'] as Record<string, unknown>)) {
        expect(input, `${id}: the input lacks ${String(v)}`).toContain(String(v))
      }
    }
  })

  // ── D400: a tool call that fails is journaled ───────────────────────
  // The calls are named by the client's id, each checked against the
  // recorded file: the Given's words pick them, the fixture must agree.
  reg.define(/^the events Claude Code sent for a shell command that exits non-zero, a file read that fails, a command that times out and an MCP tool that answers with an error$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(RECORDED_VERSION, SERIAL) }, { events: recordedSession(RECORDED_VERSION, PARALLEL) }]
    w.calls = FAILED_CALLS.map((c) => ({ ...c, ...recordedCall(w, c.id, 'PostToolUseFailure') }))
  })
  reg.define(/^the hooks install wires receive those events and ingestion runs$/, async (w: ReplayWorld) => {
    w.replays = w.recorded!.map((r) => replayRecordedSession(w, r.events, r.through !== undefined ? { lines: (line) => line <= r.through! } : {}))
    await drainStaging(w)
  })
  reg.define(/^each failed call is in the journal with its tool name, its input and the client's error text as its output$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['tool_name'], c.what).toBe(c.tool)
      expect(row.content.startsWith(`Tool: ${c.tool}\n`), c.what).toBe(true)
      const out = row.content.indexOf('\nOutput:\n')
      expect(out, `${c.what}: no Output section`).toBeGreaterThan(0)
      // The input, each of its fields as the client sent it.
      for (const v of Object.values(c.payload['tool_input'] as Record<string, unknown>)) {
        expect(row.content.slice(0, out), `${c.what}: the input lacks ${String(v)}`).toContain(String(v))
      }
      // The client's error text is the Output section, whole.
      const error = c.payload['error']
      expect(typeof error, `${c.what}: the recorded failure has no error text`).toBe('string')
      expect(row.content.slice(out + '\nOutput:\n'.length), c.what).toBe(String(error).trimEnd())
    }
  })
  reg.define(/^each is marked as failed and carries the client's own id for the call$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['outcome'], c.what).toBe('failed')
      expect(row.metadata['tool_use_id'], c.what).toBe(c.id)
      expect(row.metadata['captured_from'], `${c.what}: the batch's account, not the failure's own event`).toBeUndefined()
    }
    // A call that succeeded, in the same sessions, carries its id and no
    // outcome: the mark is the failure's, not every row's.
    for (const id of ['toolu_017WkjHRbHSjGabaDwQkTWJE', 'toolu_01ExmFevbQgvcsxnJm65RtcV']) {
      const ok = onlyEntryOf(w, id)
      expect(ok.metadata['outcome'], `the successful call ${id} is marked`).toBeUndefined()
    }
  })
  reg.define(/^each entry's moment is when its failure arrived$/, (w: ReplayWorld) => {
    const ordered: Array<{ id: string; at: number; replayAt: number }> = []
    for (const c of w.calls!) {
      const delivered = w.replays!.flat().filter((r) => r.event === 'PostToolUseFailure' && r.payload['tool_use_id'] === c.id)
      expect(delivered, `${c.what}: its failure was not delivered once`).toHaveLength(1)
      expect(delivered[0]!.hooks, `${c.what}: its failure reached no hook`).toEqual(['post-tool-use'])
      const at = onlyEntryOf(w, c.id).metadata['created_at'] as number
      expect(at, `${c.what}: before its failure arrived`).toBeGreaterThanOrEqual(delivered[0]!.startedAt)
      expect(at, `${c.what}: after its failure's hook ended`).toBeLessThanOrEqual(delivered[0]!.endedAt)
      // Never the batch's moment: the batch that names it came after.
      const batch = w.replays!.flat().find((r) => r.event === 'PostToolBatch'
        && (r.payload['tool_calls'] as Array<Record<string, unknown>>).some((t) => t['tool_use_id'] === c.id))!
      expect(at, `${c.what}: stamped at its batch`).toBeLessThan(batch.startedAt)
      ordered.push({ id: c.id, at, replayAt: delivered[0]!.startedAt })
    }
    // The entries' order is the order the failures arrived in.
    expect([...ordered].sort((a, b) => a.at - b.at).map((o) => o.id)).toEqual([...ordered].sort((a, b) => a.replayAt - b.replayAt).map((o) => o.id))
  })

  // ── D401: a call the client refused before running it ───────────────
  reg.define(/^the events Claude Code sent for a call rejected for its input, a call denied permission and a call a hook blocked$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(RECORDED_VERSION, SERIAL) }, { events: recordedSession(RECORDED_VERSION, PARALLEL) }]
    w.calls = REFUSED_CALLS.map((c) => ({ ...c, ...recordedCall(w, c.id, 'PostToolBatch') }))
    // None of them has an event of its own, as the client fired them.
    for (const c of w.calls) {
      const own = w.recorded.flatMap((r) => r.events).filter((e) => (e['hook_event_name'] === 'PostToolUse' || e['hook_event_name'] === 'PostToolUseFailure') && e['tool_use_id'] === c.id)
      expect(own, `${c.what}: the client fired an event of its own for it`).toEqual([])
    }
  })
  reg.define(/^each such call is in the journal with its tool name, its input and what the client told the model about it$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['tool_name'], c.what).toBe(c.tool)
      expect(row.content.startsWith(`Tool: ${c.tool}\n`), c.what).toBe(true)
      const out = row.content.indexOf('\nOutput:\n')
      expect(out, `${c.what}: no Output section`).toBeGreaterThan(0)
      for (const v of Object.values(c.payload['tool_input'] as Record<string, unknown>)) {
        expect(row.content.slice(0, out), `${c.what}: the input lacks ${String(v)}`).toContain(String(v))
      }
      const told = c.payload['tool_response']
      expect(typeof told, `${c.what}: the batch's account gives no text`).toBe('string')
      // Whole, as a successful call's response is: the entry's layout trims
      // the text's trailing line break, as it always has.
      expect(row.content.slice(out + '\nOutput:\n'.length), c.what).toBe(String(told).trimEnd())
    }
  })
  reg.define(/^each says it was captured from the client's account of the batch and carries the client's own id for the call$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['captured_from'], c.what).toBe('batch')
      expect(row.metadata['tool_use_id'], c.what).toBe(c.id)
      // It says what the client said and does not classify why.
      expect(row.metadata['outcome'], c.what).toBeUndefined()
      // D401: as its writer's: a subagent's batch names the subagent, and
      // the entry is stamped with it; the main agent's names none.
      const batch = w.recorded!.flatMap((r) => r.events).find((e) => e['hook_event_name'] === 'PostToolBatch'
        && (e['tool_calls'] as Array<Record<string, unknown>>).some((t) => t['tool_use_id'] === c.id))!
      if (typeof batch['agent_id'] === 'string') {
        expect(row.metadata['_writer_agent_id'], c.what).toBe(batch['agent_id'])
        expect(row.metadata['_writer'], c.what).toBe(batch['agent_type'])
        expect(row.metadata['_writer_src'], c.what).toBe('hook')
      } else {
        expect(row.metadata['_writer_agent_id'], c.what).toBeUndefined()
      }
    }
    // The recording holds a subagent's refused calls, so the clause is lit.
    expect(w.calls!.filter((c) => typeof onlyEntryOf(w, c.id).metadata['_writer_agent_id'] === 'string').map((c) => c.id).sort())
      .toEqual(['toolu_01M7pR8G3pzPXhq8xQkcfzSY', 'toolu_01VCEYEndqs8NLCYxquxWvuZ'])
  })

  // ── D401: a call is journaled once, whichever events carried it ──────
  reg.define(/^the events Claude Code sent for one batch of parallel calls, one succeeding, one failing and one rejected for its input$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const events = recordedSession(RECORDED_VERSION, PARALLEL)
    // The session up to and including its first batch's account.
    const through = events.findIndex((e) => e['hook_event_name'] === 'PostToolBatch')
    const batch = events[through]!['tool_calls'] as Array<Record<string, unknown>>
    expect(batch.map((t) => t['tool_use_id'])).toEqual([PARALLEL_OK, PARALLEL_FAILED, PARALLEL_REJECTED, PARALLEL_TOOLSEARCH])
    w.recorded = [{ events, through }]
    w.batchIds = batch.map((t) => String(t['tool_use_id']))
  })
  reg.define(/^the journal holds exactly one entry for each call of the batch$/, (w: ReplayWorld) => {
    for (const id of w.batchIds!) onlyEntryOf(w, id)
    // And no entry for a call outside it, nor a second without its id.
    const tool = rawJournal(w).filter((r) => typeof r.metadata['tool_name'] === 'string')
    expect(tool.map((r) => r.metadata['tool_use_id']).sort()).toEqual([...w.batchIds!].sort())
  })
  reg.define(/^the succeeding and the failing call are the entries their own events produced, not the batch's account of them$/, (w: ReplayWorld) => {
    const own = (id: string, event: string): void => {
      const row = onlyEntryOf(w, id)
      expect(row.metadata['captured_from'], `${id}: the batch's account landed for it`).toBeUndefined()
      const delivered = w.replays!.flat().find((r) => r.event === event && r.payload['tool_use_id'] === id)!
      const at = row.metadata['created_at'] as number
      expect(at).toBeGreaterThanOrEqual(delivered.startedAt)
      expect(at).toBeLessThanOrEqual(delivered.endedAt)
      // Its own event's composition: the success's response, the failure's error.
      const p = delivered.payload
      const out = row.content.slice(row.content.indexOf('\nOutput:\n'))
      if (event === 'PostToolUse') expect(out).toContain(String((p['tool_response'] as Record<string, unknown>)['stdout']))
      else expect(out).toBe(`\nOutput:\n${String(p['error']).trimEnd()}`)
    }
    own(PARALLEL_OK, 'PostToolUse')
    own(PARALLEL_FAILED, 'PostToolUseFailure')
    expect(onlyEntryOf(w, PARALLEL_OK).metadata['outcome']).toBeUndefined()
    expect(onlyEntryOf(w, PARALLEL_FAILED).metadata['outcome']).toBe('failed')
    // The rejected call has no event of its own: its entry is the batch's.
    expect(onlyEntryOf(w, PARALLEL_REJECTED).metadata['captured_from']).toBe('batch')
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
    // As in expectCall: the input is journaled as its text (D270), the
    // path raw on every OS.
    expect(c).toContain(join(w.proj!, 'src', 'flat-store.ts'))
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
    const raw = new DatabaseSync(w.dbPath!)
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
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      const row = raw.prepare(`SELECT processed, attempts, content FROM staging WHERE content LIKE '%' || ? || '%'`).get(w.deepToken!) as
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
    // Wait for the transport, not for the db FILE: node:sqlite creates
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
      const raw = new DatabaseSync(w.serveDbPath!)
      try {
        setPragma(raw, 'busy_timeout = 5000')
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
    const db = new DatabaseSync(w.serveDbPath!, { readOnly: true })
    try {
      setPragma(db, 'busy_timeout = 5000')
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
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      expect(pragmaValue(raw, 'user_version')).toBe(maxSupportedVersion)
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
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      expect(pragmaValue(raw, 'user_version')).toBe(maxSupportedVersion)
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
    const shell = new DatabaseSync(w.dbPath!)
    setPragma(shell, 'journal_mode = WAL')
    shell.close()
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
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


  // ── D404: a call's class is the client's word where the client states it ──
  // The calls are named by the client's id, each checked against the
  // recorded file (Claude Code 2.1.321, recorded for this ruling: four calls
  // that succeeded with output that reads like trouble, the README's table).
  reg.define(/^the events Claude Code sent for calls that succeeded with output that reads like trouble: a shell command printing "error: 0 found, 0 failed", a shell command printing "warning: deprecated", an MCP tool answering "failed call seen" and a file read of a file that holds a Python traceback$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(TROUBLE_VERSION, TROUBLE) }]
    w.calls = TROUBLE_CALLS.map((c) => ({ ...c, ...recordedCall(w, c.id, 'PostToolUse') }))
    // Each arrived by the client's success event, and its output reads as
    // the Given says: the text alone would class it otherwise.
    const said = w.calls.map((c) => JSON.stringify(c.payload['tool_response']))
    for (const [i, needle] of ['error: 0 found, 0 failed', 'warning: deprecated', 'failed call seen', 'Traceback (most recent call last)'].entries()) {
      expect(said[i], w.calls[i]!.what).toContain(needle)
    }
    for (const c of w.calls) {
      const own = w.recorded[0]!.events.filter((e) => e['tool_use_id'] === c.id && (e['hook_event_name'] === 'PostToolUse' || e['hook_event_name'] === 'PostToolUseFailure'))
      expect(own.map((e) => e['hook_event_name']), c.what).toEqual(['PostToolUse'])
    }
  })
  reg.define(/^each call's entry is classed a success, never an error or a soft fail$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['exit_type'], c.what).toBe('success')
      // Not vacuous: its text alone reads as trouble.
      expect(classifyExit(row.content), `${c.what}: the text would not have said otherwise`).not.toBe('success')
    }
  })
  reg.define(/^each says its class is the client's word$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata[EXIT_BY_KEY], c.what).toBe('client')
      // The mark is the class's, never an outcome: a success carries none.
      expect(row.metadata['outcome'], c.what).toBeUndefined()
    }
  })

  // A client whose events state nothing: the hook's command names no
  // client (as a command an earlier build wrote, or a copy written for
  // another client, does), so the hook runs for no named client.
  reg.define(/^a tool event from a client whose events do not say whether a call succeeded, its output reading "([^"]+)"$/, async (w: ReplayWorld, out) => {
    await openCaptureWorld(w)
    w.sessionId = 'silent-client-session'
    const payload = { ...bashPayload(w, 'sqlite3 app.db "select * from users"', String(out)), tool_use_id: 'call_silent_1' }
    const r = runHook(w, 'post-tool-use', payload)
    expect(r.status, r.stderr).toBe(0)
    w.calls = [{ id: 'call_silent_1', tool: 'Bash', what: 'a call from a client that states nothing', payload }]
  })
  reg.define(/^ingestion runs$/, async (w: ReplayWorld) => {
    await drainStaging(w)
  })
  reg.define(/^the call's entry is classed an error$/, (w: ReplayWorld) => {
    expect(onlyEntryOf(w, w.calls![0]!.id).metadata['exit_type']).toBe('error')
  })
  // The class each recorded text earns where the text decides (D404),
  // written down here from the recordings, never asked of the classifier
  // (a mirror would pass whatever it said): Claude Code's succeeded call
  // printing "error: 0 found, 0 failed" (2.1.321) holds "error:", the
  // classifier's first word list, so an older store reads it error, the
  // misreading the stated-success mark ends on a current one; Codex's
  // `ls /no-such-path-fixture` (0.167.0) prints "No such file or
  // directory", a soft fail.
  const TEXT_DECIDES: Record<string, string> = {
    'toolu_01GDmjXWabPpieoJbbUASiPG': 'error',
    'exec-1fecf91f-8828-47db-9e35-bcab3d0bb3d0': 'soft_fail',
    // The hand payload of a client that states nothing: its output reads
    // "error: no such table", and the scenario's own Then says an error.
    'call_silent_1': 'error',
  }
  const textClassOf = (id: string): string => {
    expect(TEXT_DECIDES[id], `no class written down for ${id}`).toBeDefined()
    return TEXT_DECIDES[id]!
  }
  reg.define(/^it says its class was read from its output$/, (w: ReplayWorld) => {
    const row = onlyEntryOf(w, w.calls![0]!.id)
    expect(row.metadata[EXIT_BY_KEY]).toBe('text')
    expect(row.metadata['exit_type']).toBe(textClassOf(w.calls![0]!.id))
  })

  // A store one schema below this build's (036): the stated-success column
  // is not there, and the hook never migrates.
  const SCHEMA_BEFORE_STATED_MARK = 35
  reg.define(/^a store at the schema before this build's, met by a hook of this build$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    // One journal row, so no hook takes it for a fresh store to bootstrap.
    await w.store!.insert('a row from before', { metadata: {} })
    await w.store!.close()
    const db = new DatabaseSync(w.dbPath!)
    try {
      // The schema that keeps no stated-success mark is 035: migration 036
      // adds `stated_by`, and 037 `client` after it. Both columns go, so the
      // store is a true 035 and not a later one with a column missing.
      db.exec(`ALTER TABLE staging DROP COLUMN client; ALTER TABLE staging DROP COLUMN stated_by; PRAGMA user_version = ${SCHEMA_BEFORE_STATED_MARK}`)
    } finally { db.close() }
  })
  reg.define(/^the events Claude Code sent, as recorded, for a call that succeeded$/, (w: ReplayWorld) => {
    const events = recordedSession(TROUBLE_VERSION, TROUBLE)
    const call = TROUBLE_CALLS[0]!
    w.recorded = [{ events: events.filter((e) => e['tool_use_id'] === call.id && e['hook_event_name'] === 'PostToolUse') }]
    expect(w.recorded[0]!.events, 'the recorded success').toHaveLength(1)
    w.calls = [{ ...call, payload: w.recorded[0]!.events[0]! }]
  })
  reg.define(/^the hook receives those events and ingestion runs once the server has opened the store$/, async (w: ReplayWorld) => {
    const replayed = replayRecordedSession(w, w.recorded![0]!.events)
    expect(replayed.map((r) => r.hooks)).toEqual([['post-tool-use']])
    // Staged at the store's own schema: no stated-success column, and the
    // hook did not migrate.
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_BEFORE_STATED_MARK)
      const rows = raw.prepare('SELECT * FROM staging').all() as Array<Record<string, unknown>>
      expect(rows.map((r) => r['tool_use_id'])).toEqual([w.calls![0]!.id])
      expect('stated_by' in rows[0]!).toBe(false)
    } finally { raw.close() }
    await adoptCaptureStore(w)
    await drainStaging(w)
  })
  reg.define(/^the call's entry takes the class its text decides$/, (w: ReplayWorld) => {
    const row = onlyEntryOf(w, w.calls![0]!.id)
    expect(row.metadata['exit_type']).toBe(textClassOf(w.calls![0]!.id))
  })


  // ── Codex CLI 0.167.0 captured through its own hooks (D408, D404, D406) ──
  // Every event is Codex's own, recorded on 2026-11-09 (tests/fixtures/
  // codex-hooks), replayed through the commands of the block install writes
  // for Codex (each naming Codex, `--client codex`), and read back from the
  // store file. The calls are named by Codex's id for each, checked against
  // the recording first, so a Given cannot drift from what Codex sent.
  const CODEX = '0.167.0'
  /** The recorded calls the Codex scenarios name, by Codex's id. */
  const CODEX_CALLS = {
    head: 'exec-108faeb3-f0b8-4aed-8e5b-b185b88798a7',
    ls: 'exec-1fecf91f-8828-47db-9e35-bcab3d0bb3d0',
    touch: 'exec-ed7d47c4-e6b1-4911-88a2-6cc988ad89ae',
    insert: 'exec-f8a07c3f-8904-4da2-9f71-2c55e020b724',
    query: 'exec-43bc9c5a-dc6f-4ffa-b6b0-b76ca399dd69',
    exportMissing: 'exec-457ba960-c00f-46c9-a267-39841080fe6e',
    patchMismatch: 'exec-de7bcb71-2211-458e-b99a-0f5a406787b5',
    patchOk: 'exec-db6f870f-2b54-4f7c-acb4-a4fc1067cf11',
  } as const
  /** The events Codex fired for one call, by name, from the recording. */
  const codexEventsOf = (w: ReplayWorld, id: string): string[] =>
    w.recorded!.flatMap((r) => r.events).filter((e) => e['tool_use_id'] === id).map((e) => String(e['hook_event_name']))
  const codexCall = (w: ReplayWorld, id: string, what: string): NamedCall & { payload: Record<string, unknown> } => {
    const events = w.recorded!.flatMap((r) => r.events).filter((e) => e['tool_use_id'] === id)
    expect(events.length, `the recording holds no event for ${what} (${id})`).toBeGreaterThan(0)
    return { id, tool: String(events[0]!['tool_name']), what, payload: events[events.length - 1]! }
  }
  /** Replay every recorded set of the world through Codex's block, then drain. */
  const replayCodex = async (w: ReplayWorld): Promise<void> => {
    w.replays = w.recorded!.map((r) => replayRecordedSession(w, r.events, r.through !== undefined ? { lines: (l) => l <= r.through! } : {}))
    for (const ev of w.replays.flat()) {
      // Every event Codex's list marks wired reached its hook, and printed
      // nothing but a main's start context.
      if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt'].includes(ev.event)) {
        expect(ev.hooks.length, `${ev.event} at line ${ev.line} reached no hook install wires for Codex`).toBe(1)
        expect(ev.stdout.join(''), `${ev.event} printed to Codex`).toBe('')
      }
    }
    await drainStaging(w)
  }

  reg.define(/^the events Codex CLI sent, as recorded, for sessions that submit a prompt, run a shell command, call treecontext's insert tool and end their turns$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(CODEX, 'headless-session.ndjson', 'codex') }]
    const kinds = w.recorded[0]!.events.map((e) => e['hook_event_name'])
    expect(kinds).toContain('UserPromptSubmit')
    expect(kinds).toContain('Stop')
    w.calls = [codexCall(w, CODEX_CALLS.head, 'a shell command'), codexCall(w, CODEX_CALLS.insert, "treecontext's insert tool")]
    expect(w.calls.map((c) => c.tool)).toEqual(['Bash', 'mcp__treecontext__treecontext_insert'])
  })
  reg.define(/^the hooks install writes for Codex receive those events and ingestion runs$/, async (w: ReplayWorld) => {
    await replayCodex(w)
  })
  reg.define(/^the journal holds the prompt with role "user"$/, (w: ReplayWorld) => {
    const prompts = w.recorded!.flatMap((r) => r.events).filter((e) => e['hook_event_name'] === 'UserPromptSubmit').map((e) => String(e['prompt']))
    const users = rawJournal(w).filter((r) => r.metadata['role'] === 'user').map((r) => r.content)
    expect(users).toEqual(prompts)
  })
  reg.define(/^each tool call with its tool name, its input, what Codex returned as its output and Codex's own id for the call$/, (w: ReplayWorld) => {
    // Every call the recording carries a PostToolUse for, not only the two
    // the Given names.
    const posts = w.recorded!.flatMap((r) => r.events).filter((e) => e['hook_event_name'] === 'PostToolUse')
    expect(posts.length).toBe(5)
    for (const e of posts) {
      const row = onlyEntryOf(w, String(e['tool_use_id']))
      expect(row.metadata['tool_name']).toBe(e['tool_name'])
      expect(row.content).toContain(`Tool: ${String(e['tool_name'])}`)
      const input = e['tool_input'] as Record<string, unknown>
      for (const v of Object.values(input)) if (typeof v === 'string') expect(row.content.slice(0, row.content.indexOf('\nOutput:'))).toContain(v)
      const said = typeof e['tool_response'] === 'string' ? e['tool_response'] : ((e['tool_response'] as { content: Array<{ text: string }> }).content[0]!.text)
      expect(row.content.slice(row.content.indexOf('\nOutput:'))).toContain(said.trim().split('\n')[0]!)
    }
  })
  reg.define(/^the turn's last assistant message as Codex sent it at the turn's end$/, (w: ReplayWorld) => {
    const said = w.recorded!.flatMap((r) => r.events).filter((e) => e['hook_event_name'] === 'Stop').map((e) => String(e['last_assistant_message']))
    const replies = rawJournal(w).filter((r) => r.metadata['event'] === 'response').map((r) => r.content)
    expect(replies).toEqual(said)
  })
  reg.define(/^each entry's moment is when its event arrived$/, (w: ReplayWorld) => {
    const events = w.replays!.flat()
    for (const row of rawJournal(w)) {
      const at = row.metadata['created_at'] as number
      const id = row.metadata['tool_use_id']
      // The event that carried the entry: a call's PostToolUse, a prompt's
      // submit, a reply's Stop.
      const ev = id !== undefined
        ? events.find((e) => e.payload['tool_use_id'] === id && e.event === 'PostToolUse') ?? events.find((e) => e.payload['tool_use_id'] === id && e.event === 'Stop')
        : row.metadata['role'] === 'user' ? events.find((e) => e.event === 'UserPromptSubmit')
          : events.find((e) => e.event === 'Stop')
      if (!ev) {
        // A call Codex reported no result for is journaled at its turn's
        // end, at the call's own moment: the moment its PreToolUse arrived.
        const pre = events.find((e) => e.payload['tool_use_id'] === id && e.event === 'PreToolUse')!
        expect(at).toBeGreaterThanOrEqual(pre.startedAt)
        expect(at).toBeLessThanOrEqual(pre.endedAt)
        continue
      }
      expect(at, `${row.content.slice(0, 40)}`).toBeGreaterThanOrEqual(ev.startedAt)
      expect(at).toBeLessThanOrEqual(ev.endedAt)
    }
  })

  reg.define(/^the events Codex CLI sent, as recorded, for a shell command that exits non-zero and a write its sandbox refused$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const all = recordedSession(CODEX, 'headless-session.ndjson', 'codex')
    w.recorded = [{ events: all.filter((e) => e['tool_use_id'] === CODEX_CALLS.ls || e['tool_use_id'] === CODEX_CALLS.touch) }]
    w.calls = [codexCall(w, CODEX_CALLS.ls, 'a shell command that exits non-zero'), codexCall(w, CODEX_CALLS.touch, 'a write the sandbox refused')]
    expect(codexEventsOf(w, CODEX_CALLS.ls)).toEqual(['PreToolUse', 'PostToolUse'])
    expect(codexEventsOf(w, CODEX_CALLS.touch)).toEqual(['PreToolUse', 'PostToolUse'])
    expect(String(w.calls[1]!.payload['tool_response'])).toContain('Read-only file system')
  })
  reg.define(/^the events Codex CLI sent for a shell command that exits non-zero, as recorded$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const all = recordedSession(CODEX, 'headless-session.ndjson', 'codex')
    w.recorded = [{ events: all.filter((e) => e['tool_use_id'] === CODEX_CALLS.ls) }]
    w.calls = [codexCall(w, CODEX_CALLS.ls, 'a shell command that exits non-zero')]
    // It arrived by Codex's PostToolUse, the event a Claude Code reading
    // would take for a stated success.
    expect(codexEventsOf(w, CODEX_CALLS.ls)).toEqual(['PreToolUse', 'PostToolUse'])
  })
  reg.define(/^each call is in the journal with its command and the text Codex returned as its output$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.content).toContain(String((c.payload['tool_input'] as Record<string, unknown>)['command']))
      expect(row.content.slice(row.content.indexOf('\nOutput:'))).toContain(String(c.payload['tool_response']).trim())
    }
  })
  reg.define(/^neither entry carries a failed mark, since Codex states no outcome for a shell command$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['outcome'], c.what).toBeUndefined()
      expect(row.metadata['captured_from'], c.what).toBeUndefined()
    }
  })
  // The class each recorded text earns, written down rather than asked of
  // the classifier (a mirror would pass whatever it said): ls's "No such
  // file or directory" is a soft fail; the sandbox's "Read-only file system"
  // is in none of the classifier's word lists, so that text decides
  // success, a miss of the vocabulary reported in unit 10, not changed here.
  const TEXT_CLASS: Record<string, string> = { [CODEX_CALLS.ls]: 'soft_fail', [CODEX_CALLS.touch]: 'success' }
  reg.define(/^each entry takes the exit class its text decides$/, (w: ReplayWorld) => {
    for (const c of w.calls!) {
      const row = onlyEntryOf(w, c.id)
      expect(row.metadata['exit_type'], c.what).toBe(TEXT_CLASS[c.id])
      expect(row.metadata[EXIT_BY_KEY], c.what).toBe('text')
    }
  })
  reg.define(/^it says its class was read from its output, never that the client stated it$/, (w: ReplayWorld) => {
    const row = onlyEntryOf(w, w.calls![0]!.id)
    expect(row.metadata[EXIT_BY_KEY]).toBe('text')
    expect(row.metadata[EXIT_BY_KEY]).not.toBe('client')
    // Not vacuous: had the hook read Codex's PostToolUse as a stated
    // success, the class would be success, which this text is not.
    expect(classifyExit(row.content)).not.toBe('success')
  })

  const NO_RESULT_CALLS: Record<string, { set: string; id: string; tool: string }> = {
    'an MCP tool call Codex got an error reply for': { set: 'headless-session.ndjson', id: CODEX_CALLS.exportMissing, tool: 'mcp__treecontext__treecontext_export' },
    'a file edit whose patch did not match the file': { set: 'file-edit.ndjson', id: CODEX_CALLS.patchMismatch, tool: 'apply_patch' },
  }
  reg.define(/^the events Codex CLI sent, as recorded, for (an MCP tool call Codex got an error reply for|a file edit whose patch did not match the file), its PreToolUse with no PostToolUse by the turn's end$/, async (w: ReplayWorld, which) => {
    await openCaptureWorld(w)
    const c = NO_RESULT_CALLS[String(which)]!
    w.recorded = [{ events: recordedSession(CODEX, c.set, 'codex') }]
    w.calls = [codexCall(w, c.id, String(which))]
    expect(w.calls[0]!.tool).toBe(c.tool)
    expect(codexEventsOf(w, c.id)).toEqual(['PreToolUse'])
    // The turn ended after it: Codex's Stop is in the set, after the call.
    const events = w.recorded[0]!.events
    expect(events.findIndex((e) => e['hook_event_name'] === 'Stop')).toBeGreaterThan(events.findIndex((e) => e['tool_use_id'] === c.id))
  })
  reg.define(/^the journal holds one entry for the call, with its tool name, its input and Codex's own id for it$/, (w: ReplayWorld) => {
    const c = w.calls![0]!
    const row = onlyEntryOf(w, c.id)
    expect(row.metadata['tool_name']).toBe(c.tool)
    for (const v of Object.values(c.payload['tool_input'] as Record<string, unknown>)) {
      if (typeof v === 'string') expect(row.content).toContain(v.split('\n')[0]!)
    }
  })
  reg.define(/^the entry is marked as a call Codex reported no result for, with no exit class and no word on why$/, (w: ReplayWorld) => {
    const row = onlyEntryOf(w, w.calls![0]!.id)
    expect(row.metadata['captured_from']).toBe('no-result')
    expect(row.metadata['exit_type']).toBeUndefined()
    expect(row.metadata[EXIT_BY_KEY]).toBeUndefined()
    expect(row.metadata['outcome']).toBeUndefined()
    // Exactly the call as Codex sent it and the one line saying no result
    // was reported: no Output section, and no word on why.
    const c = w.calls![0]!
    expect(row.content).toBe(`${composeToolEntry(c.tool, c.payload['tool_input'], undefined).content}\n${NO_RESULT_LINE}`)
  })

  // D408's last clauses: a turn that ended in no event the hooks received
  // (a crash, a kill, a worker cut at its timeout) leaves its call's
  // account in staging; the purge of processed staging journals it.
  reg.define(/^the events Codex CLI sent, as recorded, for a file edit whose patch did not match the file, its turn ended by no Stop or Interrupt the hooks received$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const all = recordedSession(CODEX, 'file-edit.ndjson', 'codex')
    expect(all.some((e) => e['hook_event_name'] === 'Stop'), 'the recording ends its turn').toBe(true)
    // The client never sent its turn's end: the replay leaves it out.
    w.recorded = [{ events: all.filter((e) => e['hook_event_name'] !== 'Stop' && e['hook_event_name'] !== 'Interrupt') }]
    w.calls = [codexCall(w, CODEX_CALLS.patchMismatch, 'a file edit whose patch did not match the file')]
    expect(codexEventsOf(w, CODEX_CALLS.patchMismatch)).toEqual(['PreToolUse'])
  })
  reg.define(/^ingestion runs and the processed staging is later purged$/, async (w: ReplayWorld) => {
    await replayCodex(w)
    const id = w.calls![0]!.id
    // Before the purge the call has no entry: no turn's end staged one.
    expect(rawJournal(w).filter((r) => r.metadata['tool_use_id'] === id)).toEqual([])
    const db = new DatabaseSync(w.dbPath!, { readOnly: true })
    try { w.accountAt = (db.prepare("SELECT timestamp AS t FROM staging WHERE tool_use_id = ? AND captured_from = 'pre-tool-use'").get(id) as { t: number }).t } finally { db.close() }
    // The store's own purge of processed staging, as the server's sweep
    // runs it a day later; every processed row is past a cutoff of now.
    w.store!.store.purgeProcessedStaging(0)
    await drainStaging(w)
  })
  reg.define(/^the journal holds one entry for the call, with its tool name, its input and Codex's own id for it, dated at the moment Codex started the call$/, (w: ReplayWorld) => {
    const c = w.calls![0]!
    const row = onlyEntryOf(w, c.id)
    expect(row.metadata['tool_name']).toBe(c.tool)
    for (const v of Object.values(c.payload['tool_input'] as Record<string, unknown>)) {
      if (typeof v === 'string') expect(row.content).toContain(v.split('\n')[0]!)
    }
    expect(row.metadata['created_at']).toBe(w.accountAt)
    expect(Number(row.metadata['ingested_at'])).toBeGreaterThanOrEqual(w.accountAt!)
  })
  reg.define(/^the entry says Codex started the call and neither its result nor the end of its turn reached the journal, with no exit class$/, (w: ReplayWorld) => {
    const c = w.calls![0]!
    const row = onlyEntryOf(w, c.id)
    expect(row.metadata['captured_from']).toBe('no-turn-end')
    expect(row.content).toBe(`${composeToolEntry(c.tool, c.payload['tool_input'], undefined).content}\n${NO_TURN_END_LINE}`)
    expect(row.metadata['exit_type']).toBeUndefined()
    expect(row.metadata[EXIT_BY_KEY]).toBeUndefined()
    expect(row.metadata['outcome']).toBeUndefined()
  })

  reg.define(/^the events Codex CLI sent, as recorded, for a file edit that succeeded, its PreToolUse and its PostToolUse$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(CODEX, 'file-edit-ok.ndjson', 'codex') }]
    w.calls = [codexCall(w, CODEX_CALLS.patchOk, 'a file edit that succeeded')]
    expect(codexEventsOf(w, CODEX_CALLS.patchOk)).toEqual(['PreToolUse', 'PostToolUse'])
  })
  reg.define(/^the journal holds one entry for the call, from its PostToolUse, with what Codex returned as its output$/, (w: ReplayWorld) => {
    const c = w.calls![0]!
    const row = onlyEntryOf(w, c.id)
    expect(row.metadata['captured_from']).toBeUndefined()
    expect(row.content.slice(row.content.indexOf('\nOutput:'))).toContain(String(c.payload['tool_response']).trim().split('\n')[0]!)
  })

  // The interrupted turn: the interactive set's third turn, from its
  // prompt to Codex's Interrupt (lines 11 to 16), which fired no Stop.
  reg.define(/^the events Codex CLI sent, as recorded, for a turn the developer interrupted, ending in Codex's interrupt and no turn's end$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    const all = recordedSession(CODEX, 'interactive.ndjson', 'codex')
    const end = all.findIndex((e) => e['hook_event_name'] === 'Interrupt')
    const turn = all[end]!['turn_id']
    const start = all.findIndex((e) => e['turn_id'] === turn)
    expect(all[start]!['hook_event_name']).toBe('UserPromptSubmit')
    const events = all.slice(start, end + 1)
    expect(events.some((e) => e['hook_event_name'] === 'Stop')).toBe(false)
    w.recorded = [{ events }]
    w.codexTurn = String(turn)
  })
  reg.define(/^the journal says the turn was interrupted, with a capture-gap entry naming its reply as not captured$/, (w: ReplayWorld) => {
    const gaps = rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap' && r.metadata['event'] === 'turn_interrupted')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.content).toMatch(/^\[capture gap\] The developer interrupted this turn/)
    expect(gaps[0]!.content).toContain(w.codexTurn!)
    expect(gaps[0]!.content).toMatch(/its reply was not captured/)
  })
  reg.define(/^the journal holds no assistant entry for that turn$/, (w: ReplayWorld) => {
    expect(rawJournal(w).filter((r) => r.metadata['event'] === 'response')).toEqual([])
    expect(rawJournal(w).filter((r) => r.metadata['role'] === 'assistant' && !r.metadata['tool_name'] && r.metadata['source'] !== 'capture-gap')).toEqual([])
  })
  reg.define(/^every call of the turn whose PreToolUse had no PostToolUse is journaled as a call Codex reported no result for$/, (w: ReplayWorld) => {
    const events = w.recorded![0]!.events
    const pre = events.filter((e) => e['hook_event_name'] === 'PreToolUse').map((e) => String(e['tool_use_id']))
    const post = new Set(events.filter((e) => e['hook_event_name'] === 'PostToolUse').map((e) => String(e['tool_use_id'])))
    const unresolved = pre.filter((id) => !post.has(id)).sort()
    const noResult = rawJournal(w).filter((r) => r.metadata['captured_from'] === 'no-result').map((r) => String(r.metadata['tool_use_id'])).sort()
    // Exactly those calls, each once; every call that had its PostToolUse
    // is journaled once, from it. (The recorded turn's two calls both had
    // theirs, so this turn holds no call with no result.)
    expect(noResult).toEqual(unresolved)
    for (const id of post) expect(onlyEntryOf(w, id).metadata['captured_from']).toBeUndefined()
  })

  // ── Antigravity CLI 1.5.3 captured through its named hook (D415, D421) ──
  // Every event and transcript is agy's own, recorded on 2026-11-09
  // (tests/fixtures/agy-hooks), replayed through the commands of the named
  // hook install writes for agy (each naming agy, `--client agy`), the
  // transcript as it stood when each event fired written where the event
  // points, and read back from the store file.
  const AGY = '1.5.3'
  type AgyCall = { step: number; name: string; args: Record<string, unknown>; conversation: string; payload: Record<string, unknown> }
  /** Every call the recording carries, from its PostToolUse events. */
  const agyCallsOf = (w: ReplayWorld): AgyCall[] => w.recorded!.flatMap((r) => r.events)
    .filter((e) => agyEventOf(e) === 'PostToolUse')
    .map((e) => {
      const call = e['toolCall'] as { name: string; args: Record<string, unknown> }
      return { step: e['stepIdx'] as number, name: call.name, args: call.args, conversation: String(e['conversationId']), payload: e }
    })
  /** A call's result step as the recorded transcript holds it. */
  const agyResultOf = (c: AgyCall): string => {
    const steps = agyTranscriptOf(c.payload).map((l) => JSON.parse(l) as Record<string, unknown>)
    const s = steps.find((x) => x['step_index'] === c.step)
    expect(s, `the transcript holds no step ${c.step}`).toBeDefined()
    return String(s!['content'] ?? s!['error'])
  }
  /** The entries of one call: its conversation's captured rows naming its tool and its arguments. */
  const agyEntriesOf = (w: ReplayWorld, c: AgyCall): RawNode[] => rawJournal(w).filter((r) => r.metadata['tool_name'] === c.name
    && (r.metadata['_client_session_id'] ?? r.metadata['session_id']) === c.conversation
    && Object.values(c.args).every((v) => typeof v !== 'string' || r.content.includes(v)))
  const replayAgy = async (w: ReplayWorld, opts: { transcript?: 'recorded' | 'unreadable' } = {}): Promise<void> => {
    w.replays = w.recorded!.map((r) => replayRecordedSession(w, r.events, opts))
    await drainStaging(w)
  }

  reg.define(/^the events and the transcript of an Antigravity session, as Antigravity sends them, that runs a shell command, reads a file, inserts a note through treecontext and replies$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'headless-session.ndjson', 'agy') }]
    const calls = agyCallsOf(w)
    expect(calls.map((c) => c.name)).toEqual(expect.arrayContaining(['run_command', 'read_file', 'call_mcp_tool']))
    expect(calls.some((c) => c.name === 'call_mcp_tool' && c.args['ToolName'] === 'treecontext_insert')).toBe(true)
  })
  reg.define(/^the journal holds the session's prompt once, with role "user"$/, (w: ReplayWorld) => {
    const prompt = String(w.recorded![0]!.events[0]!['lastUserInput'])
    // agy repeats it on every event of the turn.
    expect(w.recorded![0]!.events.every((e) => e['lastUserInput'] === prompt)).toBe(true)
    const users = rawJournal(w).filter((r) => r.metadata['role'] === 'user')
    expect(users.map((r) => r.content)).toEqual([prompt])
  })
  reg.define(/^each tool call is in the journal with agy's tool name, its arguments and an Output section holding what the transcript records for it$/, (w: ReplayWorld) => {
    const calls = agyCallsOf(w)
    expect(calls.length).toBe(6)
    for (const c of calls) {
      const rows = agyEntriesOf(w, c)
      expect(rows, `${c.name} step ${c.step}`).toHaveLength(1)
      const row = rows[0]!
      expect(row.content.startsWith(`Tool: ${c.name}\nInput:\n`)).toBe(true)
      const out = row.content.slice(row.content.indexOf('\nOutput:\n') + '\nOutput:\n'.length)
      expect(row.content.indexOf('\nOutput:\n'), row.content).toBeGreaterThan(0)
      // The output as agy's transcript recorded it (a long one past its
      // preview, behind the full tail; a repo read's preview alone).
      const said = agyResultOf(c)
      expect(out, `${c.name} step ${c.step}`).toContain(said.slice(0, 100))
    }
  })
  reg.define(/^the reply is in the journal with role "assistant"$/, (w: ReplayWorld) => {
    const steps = agyTranscriptOf(w.recorded![0]!.events[0]!).map((l) => JSON.parse(l) as Record<string, unknown>)
    const reply = String([...steps].reverse().find((s) => s['type'] === 'PLANNER_RESPONSE' && typeof s['content'] === 'string')!['content'])
    const rows = rawJournal(w).filter((r) => r.metadata['role'] === 'assistant' && r.metadata['tool_name'] === undefined)
    expect(rows.map((r) => r.content)).toEqual([reply])
  })
  reg.define(/^every hook answered agy with a JSON object and decided no permission$/, (w: ReplayWorld) => {
    const events = w.replays!.flat()
    expect(events.length).toBe(w.recorded![0]!.events.length)
    for (const ev of events) {
      expect(ev.hooks, `${ev.event} at line ${ev.line} reached no hook`).toEqual(['agy'])
      // A JSON object, and an empty one: no decision of any kind.
      expect(JSON.parse(ev.stdout.join('')) as unknown, ev.stdout.join('')).toEqual({})
    }
  })

  reg.define(/^the events of an Antigravity session, as Antigravity sends them, and its transcript as it stood when each event fired, the call's result missing at its PostToolUse and present at the PostInvocation that follows$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'shell-nonzero-ls.ndjson', 'agy') }]
    const events = w.recorded![0]!.events
    const i = events.findIndex((e) => agyEventOf(e) === 'PostToolUse')
    const step = events[i]!['stepIdx'] as number
    const at = (e: Record<string, unknown>): Array<Record<string, unknown>> => agyTranscriptOf(e, agyTranscriptLinesOf(e) ?? 0).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(at(events[i]!).some((s) => s['step_index'] === step), 'the result is already in the transcript at its PostToolUse').toBe(false)
    expect(agyEventOf(events[i + 1]!)).toBe('PostInvocation')
    expect(at(events[i + 1]!).some((s) => s['step_index'] === step), 'the result is not in the transcript at the PostInvocation that follows').toBe(true)
  })
  reg.define(/^the call is in the journal once, with an Output section holding the result the transcript recorded$/, (w: ReplayWorld) => {
    const [c] = agyCallsOf(w)
    const rows = agyEntriesOf(w, c!)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain(`\nOutput:\n${agyResultOf(c!).trimEnd()}`)
  })
  reg.define(/^the entry's moment is when the call's PostToolUse arrived$/, (w: ReplayWorld) => {
    const [c] = agyCallsOf(w)
    const row = agyEntriesOf(w, c!)[0]!
    const post = w.replays!.flat().find((e) => e.event === 'PostToolUse')!
    const at = row.metadata['created_at'] as number
    expect(at).toBeGreaterThanOrEqual(post.startedAt)
    expect(at).toBeLessThanOrEqual(post.endedAt)
  })

  reg.define(/^the events of an Antigravity session of two turns, as Antigravity sends them, whose second prompt is the same text as its first$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'two-turns.ndjson', 'agy') }]
    const events = w.recorded![0]!.events
    expect(events.filter((e) => agyEventOf(e) === 'SessionStart')).toHaveLength(1)
    const openers = events.filter((e) => agyEventOf(e) === 'PreInvocation' && e['invocationNum'] === 0)
    expect(openers).toHaveLength(2)
    expect(openers[0]!['lastUserInput']).toBe(openers[1]!['lastUserInput'])
  })
  reg.define(/^the journal holds two prompt entries with role "user", one for each turn$/, (w: ReplayWorld) => {
    const prompt = String(w.recorded![0]!.events[0]!['lastUserInput'])
    const users = rawJournal(w).filter((r) => r.metadata['role'] === 'user')
    expect(users.map((r) => r.content)).toEqual([prompt, prompt])
    // Each at its turn's opening model call.
    const openers = w.replays!.flat().filter((e) => e.event === 'PreInvocation' && e.payload['invocationNum'] === 0)
    const ats = users.map((r) => r.metadata['created_at'] as number).sort()
    ats.forEach((at, k) => { expect(at).toBeGreaterThanOrEqual(openers[k]!.startedAt); expect(at).toBeLessThanOrEqual(openers[k]!.endedAt) })
  })

  reg.define(/^the events of an Antigravity session, as Antigravity sends them, whose transcript cannot be read, or holds no result for a call by the conversation's Stop$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'headless-session.ndjson', 'agy') }]
    w.agyTranscript = 'unreadable'
  })
  reg.define(/^the hook install writes for Antigravity CLI receives those events and ingestion runs$/, async (w: ReplayWorld) => {
    await replayAgy(w, w.agyTranscript ? { transcript: w.agyTranscript } : {})
  })
  reg.define(/^each tool call is in the journal with agy's tool name and its arguments, saying its output was not captured$/, (w: ReplayWorld) => {
    for (const c of agyCallsOf(w)) {
      const rows = agyEntriesOf(w, c)
      expect(rows, `${c.name} step ${c.step}`).toHaveLength(1)
      expect(rows[0]!.content).toContain(`Tool: ${c.name}\nInput:\n`)
      // step-lint: allow unearned-absence -- the same row's Input header is asserted just above, and `\nOutput:` is the header every captured call of this set carries when its transcript is read (the first scenario of this block)
      expect(rows[0]!.content).not.toContain('\nOutput:')
      expect(rows[0]!.content).toMatch(/\n\[output not captured\] agy's transcript .* could not be read/)
    }
  })
  reg.define(/^the journal holds a capture-gap entry naming the reply that could not be read$/, (w: ReplayWorld) => {
    const gaps = rawJournal(w).filter((r) => r.metadata['source'] === 'capture-gap')
    expect(gaps.map((g) => g.content)).toEqual([expect.stringMatching(/The reply of this agy turn was not captured/)])
    expect(gaps[0]!.metadata['session_id']).toBe(w.recorded![0]!.events[0]!['conversationId'])
  })
  reg.define(/^no tool call of the session is missing from the journal$/, (w: ReplayWorld) => {
    const calls = agyCallsOf(w)
    const toolRows = rawJournal(w).filter((r) => typeof r.metadata['tool_name'] === 'string')
    expect(toolRows).toHaveLength(calls.length)
    for (const c of calls) expect(agyEntriesOf(w, c)).toHaveLength(1)
  })

  reg.define(/^the events and the transcript of a shell command that exits non-zero, as Antigravity sends them$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'shell-nonzero-ls.ndjson', 'agy') }]
    const [c] = agyCallsOf(w)
    expect(c!.name).toBe('run_command')
    // agy states nothing: its PostToolUse's error is empty.
    expect(c!.payload['error']).toBe('')
    expect(agyResultOf(c!)).toMatch(/Command exited with code [1-9]/)
  })
  reg.define(/^the call is in the journal with an Output section holding the exit code and what the command printed, as the transcript records them$/, (w: ReplayWorld) => {
    const [c] = agyCallsOf(w)
    const row = agyEntriesOf(w, c!)[0]!
    const said = agyResultOf(c!)
    expect(row.content).toContain(`\nOutput:\n${said.trimEnd()}`)
    expect(said).toMatch(/Command exited with code 2\.[\s\S]*No such file or directory/)
  })
  reg.define(/^the entry carries no outcome mark of the client's, agy having stated none$/, (w: ReplayWorld) => {
    const [c] = agyCallsOf(w)
    const row = agyEntriesOf(w, c!)[0]!
    expect(row.metadata['outcome']).toBeUndefined()
    expect(row.metadata['stated_by']).toBeUndefined()
    expect(row.metadata['tool_use_id']).toBeUndefined()
    // Its ending read from its text (D404).
    expect(row.metadata[EXIT_BY_KEY]).toBe('text')
    expect(row.metadata['exit_type']).toBe(classifyExit(row.content))
    expect(row.metadata['exit_type']).toBe('error')
  })

  reg.define(/^the events and transcripts of an Antigravity session that starts a subagent and of the subagent's own conversation, as Antigravity sends them$/, async (w: ReplayWorld) => {
    await openCaptureWorld(w)
    w.recorded = [{ events: recordedSession(AGY, 'subagent.ndjson', 'agy') }]
    const ids = [...new Set(w.recorded![0]!.events.map((e) => String(e['conversationId'])))]
    expect(ids).toHaveLength(2)
    const invoke = agyCallsOf(w).find((c) => c.name === 'invoke_subagent')!
    w.agyParent = invoke.conversation
    w.agyChild = ids.find((i) => i !== invoke.conversation)!
    // Nothing in the child's events names its parent but its message's recipient.
    const child = w.recorded![0]!.events.filter((e) => e['conversationId'] === w.agyChild)
    expect(child[0]!['lastUserInput']).toBe('')
  })
  reg.define(/^the parent's journal holds the subagent call with its prompt and role as input and an Output section naming the subagent's conversation$/, (w: ReplayWorld) => {
    const invoke = agyCallsOf(w).find((c) => c.name === 'invoke_subagent')!
    const row = agyEntriesOf(w, invoke)[0]!
    expect(row.metadata['session_id']).toBe(w.agyParent)
    const input = row.content.slice(0, row.content.indexOf('\nOutput:\n'))
    expect(input).toContain(String(invoke.args['Prompt']))
    expect(input).toContain(String(invoke.args['Role']))
    expect(row.content.slice(row.content.indexOf('\nOutput:\n'))).toContain(w.agyChild!)
  })
  reg.define(/^the subagent's rows sit in their own session, in no checkout's lane, read as writer unknown, and none is stamped as the parent's$/, (w: ReplayWorld) => {
    const childRows = rawJournal(w).filter((r) => r.metadata['session_id'] === w.agyChild)
    expect(childRows.length).toBe(3)
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    let placements: Map<string, string | null>
    try { placements = placementsOf(raw, [w.agyChild!, w.agyParent!]) } finally { raw.close() }
    expect(placements.has(w.agyChild!), 'the registry holds the subagent\'s conversation').toBe(false)
    for (const r of childRows) {
      expect(r.metadata['_writer_src']).toBe('unregistered')
      expect(laneOfRow(r.metadata, placements.get(w.agyChild!))).toBe(UNKNOWN_LANE)
      expect(r.metadata['_writer']).toBeUndefined()
    }
    // The parent's rows are their own session's, never the child's.
    for (const r of rawJournal(w).filter((x) => x.metadata['session_id'] === w.agyParent)) expect(r.metadata['_client_session_id']).toBeUndefined()
  })
  reg.define(/^no helper, key, first moment, send-back or pointer is recorded for the subagent$/, (w: ReplayWorld) => {
    const raw = new DatabaseSync(w.dbPath!, { readOnly: true })
    try {
      const reg = raw.prepare('SELECT COUNT(*) AS n FROM session_registry').get() as { n: number }
      expect(reg.n, 'the session registry holds a registration').toBe(0)
    } finally { raw.close() }
    for (const r of rawJournal(w)) {
      expect(['first-moment', 'send-back', 'subagent-summary']).not.toContain(r.metadata['kind'])
      expect(r.metadata['key']).toBeUndefined()
    }
  })
}
