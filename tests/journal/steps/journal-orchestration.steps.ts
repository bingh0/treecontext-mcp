import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { maxSupportedVersion } from '../../../src/persistence/migrations/index.js'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { FlatStore } from '../../../src/flat-store.js'
import { openNodeSqlite, setPragma } from '../../../src/persistence/node-sqlite.js'
import { writeSessionBeacon } from '../../../src/session-beacon.js'
import { SUBAGENT_SUMMARY_KIND, INTERNAL_SUMMARY_KIND, CLIENT_WRITER } from '../../../src/handoff.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { mcpOver, parseTool, rawAll } from '../world.js'
import { writeAgentTranscript } from '../capture-harness.js'
import { TS_ROOT, tsxArgv } from '../proc.js'
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import { ageText, UNKNOWN_WRITER_LABEL } from '../../../src/references.js'
import {
  runHook, hookJson, spawnHooksAtOnce, drainStaging, bashPayload,
} from '../capture-harness.js'
import {
  type ReorientationWorld, openWorld, now, toolEntry, mcpNote, clear, statusPanel,
} from './journal-reorientation.steps.js'

// ── journal-orchestration ───────────────────────────────────────────────
//
// References (D186) and lanes (D169), the subagent's summary and trail
// (D147, D148), its scoped search (D150), the worktree's self (D167) and
// self registration with server-stamped writers (D190).
//
// The shared-session hazard is the subject: the orchestrator and every
// subagent it spawns share ONE Claude Code session id and ONE MCP server
// connection, so these bindings drive exactly that shape — one session id
// for the hooks, one in-process MCP client for every tool call of the
// session, orchestrator's and tester's alike. Who is speaking is never
// told to the server by the test: the real hook subprocesses (SessionStart,
// SubagentStart, PostToolUse, SubagentStop) receive Claude Code-shaped
// payloads — a subagent's carry agent_id and agent_type beside the
// parent's session_id, as the probe of 2026-09-25 recorded — and the
// server stamps each tool-written row from the registry those hooks keep.
// A tool call made between a tester's SubagentStart and SubagentStop, with
// the orchestrator waiting on it, is read at insert as the tester's,
// provisionally; each insert's own PostToolUse echo (the caller's agent
// fields on the tester's) then makes the writer exact at the drain. That
// foreground case is what these scenarios bind. The background case — the
// orchestrator active beside a live subagent, its rows stamped as its own
// and a wrong guess undone by the echo — is driven through the same real
// hooks in tests/background-subagent.test.ts; the ambiguous case and the
// reply fields are pinned in tests/session-registry.test.ts.
//
// Every Then reads a production surface — search, fetch by id, a writer's
// trail, status, the packet a session-start hook emits — or the SQLite
// file directly. D186's writer B is still a metadata claim (`agent_type`)
// written from an unregistered session: D186's claim is about the block,
// which names whatever writer the row holds.

/** The orchestration wave's world: the reorientation world (a capture
 *  sandbox, a real store, an MCP client, the /clear hook driver — the
 *  D169 and D190 bindings will need the last) plus what these scenarios
 *  carry from a Given to a Then. */
export interface OrchestrationWorld extends ReorientationWorld {
  /** Named entries of the D186 chain and their texts. */
  entries?: Record<string, { id: string; text: string }>
  /** The parsed response of the last search or fetch. */
  read?: Record<string, unknown>
  /** The tester subagent's report, its agent id, its tool calls' markers. */
  report?: string
  testerId?: string
  trailMarkers?: string[]
  /** The orchestrator's own entries' ids. */
  ownIds?: string[]
  /** The orchestrator's plan / chapter, and its raw row before the act. */
  planId?: string
  chapterRow?: Record<string, unknown>
  /** Ids of rows the tester's trail holds (the earlier tester, D150). */
  trailIds?: string[]
  /** The tester's note or superseding entry, and the insert's reply. */
  noteId?: string
  noteReply?: Record<string, unknown>
  /** Both notes of the shared-session scenario. */
  notes?: { tester: { id: string; reply: Record<string, unknown> }; orchestrator: { id: string; reply: Record<string, unknown> } }
  /** The git sandbox: the main checkout and its worktrees. */
  repo?: string
  worktrees?: Record<string, string>
  /** The packets the session-start hook emitted, by who started. */
  startPackets?: Record<string, string>
  /** The brief the orchestrator injected. */
  briefText?: string
  /** The client's own internal agent (D263): its agent id and report. */
  internalId?: string
  internalReport?: string
  /** Rows exactly as SQLite held them before this treecontext opened the
   *  store (D263's migration), by node id. */
  rowsBefore?: Record<string, { metadata_json: string; content: Buffer | string | null }>
  /** The main-lane build (D372-D376): the session ids by the lane they
   *  ran in (`main`, `worktree:<name>`, `unplaced`), the words a Given's
   *  rows carry, and the replies a When kept. */
  laneSessions?: Record<string, string>
  laneWords?: string
  turnIds?: string[]
  statusReply?: Record<string, unknown>
}

type Hit = { nodeId: string; content: string; metadata: Record<string, unknown> | null; referencedBy?: RefBy }
type RefBy = { count: number; newest: { nodeId: string; writer: string; age: string; firstLine: string } }

async function query(w: OrchestrationWorld, q: string): Promise<Hit[]> {
  w.read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 5 } }))
  return w.read['results'] as Hit[]
}

async function fetchById(w: OrchestrationWorld, id: string): Promise<Record<string, unknown>> {
  w.read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: id } }))
  const nodes = w.read['nodes'] as Array<Record<string, unknown>>
  expect(nodes).toHaveLength(1)
  return nodes[0]!
}

/** Captured tool events between two notes, so a hit's conversation window
 *  (the ± 2 same-session entries every search carries) holds the session's
 *  ordinary work, as a real session's would, and never the next note. */
async function work(w: OrchestrationWorld, at: number, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await toolEntry(w, `vitest run ${i}: 12 passed`, at + i)
}


// ── The session's hooks, as Claude Code fires them ──────────────────────

/** A session starts: the real SessionStart hook, in `cwd`, under the
 *  world's session id — which registers the session's self (D190). */
function sessionStart(w: OrchestrationWorld, cwd: string = w.proj!, source = 'startup'): string {
  const run = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source, cwd })
  const out = hookJson(run.stdout)
  return String((out?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
}

/** The orchestrator spawns a subagent: SubagentStart under the PARENT's
 *  session id, with the subagent's own agent_id and agent_type. */
function subagentStart(w: OrchestrationWorld, agentId: string, agentType: string): void {
  runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: agentType })
}

/** The subagent finishes: SubagentStop with its last assistant message,
 *  or, through the client's hand-back tool (Claude Code 2.1.271 and later
 *  in auto mode, D371), with the report as the `SubagentHandback` call's
 *  message in the subagent's own transcript and the payload's text only
 *  its closing words. Both shapes are the reference platform's; the
 *  D147 summary scenario takes the hand-back, the others the text. */
function subagentStop(w: OrchestrationWorld, agentId: string, agentType: string, report: string, handback?: { closing: string }): void {
  const transcript = handback ? writeAgentTranscript(w, agentId, { handback: report, closing: handback.closing }) : join(w.proj!, `agent-${agentId}.jsonl`)
  runHook(w, 'subagent-stop', {
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, stop_hook_active: false,
    agent_transcript_path: transcript, last_assistant_message: handback ? handback.closing : report,
  })
}

/** A subagent's tool calls, each through the real PostToolUse hook with
 *  the reference platform's Bash shape plus the subagent's agent fields,
 *  launched together the way a busy subagent's hooks contend. */
async function subagentToolCalls(
  w: OrchestrationWorld, agentId: string, agentType: string, outputs: string[],
): Promise<void> {
  await spawnHooksAtOnce(w, 'post-tool-use', outputs.map((out, i) => ({
    ...bashPayload(w, `npx vitest run case-${i}`, out), agent_id: agentId, agent_type: agentType,
  })))
}

/** One MCP client for the whole session: the orchestrator's calls and its
 *  subagents' arrive on the same connection under the same session id. */
async function sessionClient(w: OrchestrationWorld): Promise<void> {
  await mcpOver(w, { ccSessionId: w.sessionId! })
  w.clientSession = w.sessionId!
}

async function insert(w: OrchestrationWorld, text: string, metadata: Record<string, unknown>, supersedes?: string[]): Promise<Record<string, unknown>> {
  return parseTool(await w.client!.callTool({
    name: 'treecontext_insert',
    arguments: { content: text, metadata, ...(supersedes ? { supersedes } : {}) },
  }))
}

/** An insert through the tools AND its PostToolUse echo, as Claude Code
 *  fires it right after the call returns: the real post-tool-use hook,
 *  tool_name `mcp__treecontext__treecontext_insert`, the call's input and
 *  the tool's own result, plus the CALLER's agent fields when a subagent
 *  made the call (none for the session's own agent). The drain's echo
 *  heal reads the writer from it. */
async function insertEchoed(
  w: OrchestrationWorld, who: { agentId: string; agentType: string } | null,
  text: string, metadata: Record<string, unknown>, supersedes?: string[],
): Promise<Record<string, unknown>> {
  const input = { content: text, metadata, ...(supersedes ? { supersedes } : {}) }
  const res = await w.client!.callTool({ name: 'treecontext_insert', arguments: input })
  runHook(w, 'post-tool-use', {
    transcript_path: join(w.proj!, 'transcript.jsonl'), hook_event_name: 'PostToolUse', permission_mode: 'default',
    tool_name: 'mcp__treecontext__treecontext_insert', tool_input: input,
    tool_response: (res as { content: unknown }).content,
    ...(who ? { agent_id: who.agentId, agent_type: who.agentType } : {}),
  })
  return parseTool(res)
}

function rawMeta(w: OrchestrationWorld, id: string): Record<string, unknown> {
  const row = rawAll<{ m: string | null }>(w, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]
  expect(row, `no row ${id}`).toBeTruthy()
  return JSON.parse(row!.m ?? '{}') as Record<string, unknown>
}

function rawRow(w: OrchestrationWorld, id: string): Record<string, unknown> {
  return rawAll<Record<string, unknown>>(w, 'SELECT * FROM nodes WHERE node_id = ?', id)[0]!
}

/** The orchestrator's own entries, in the shape the journal holds its
 *  captured work: auto-capture tool rows of the session naming no writer
 *  (the main agent's payloads carry no agent fields). Three go through
 *  the real PostToolUse hook to prove that shape; the rest are seeded. */
async function orchestratorOwn(w: OrchestrationWorld, n: number, word: string): Promise<void> {
  const real = 3
  for (let i = 0; i < real; i++) {
    runHook(w, 'post-tool-use', bashPayload(w, `grep -rn ${word} src/ # ${i}`, `src/${word}-${i}.ts: the orchestrator's own ${word} work ${i}`))
  }
  await drainStaging(w)
  const t = now() - 7200
  for (let i = real; i < n; i++) await toolEntry(w, `orchestrator ${word} step ${i}: reviewed the ${word} module`, t + i)
  const own = rawAll<{ node_id: string; m: string }>(w,
    "SELECT node_id, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$._writer') IS NULL AND content LIKE ?", `%${word}%`)
  expect(own.length).toBe(n)
  w.ownIds = own.map((r) => r.node_id)
}

/** The tester's trail: tool calls through the real hook, then its report
 *  through the real SubagentStop, drained by the production drain. */
async function testerTrail(w: OrchestrationWorld, agentId: string, outputs: string[], report: string): Promise<void> {
  subagentStart(w, agentId, 'tester')
  await subagentToolCalls(w, agentId, 'tester', outputs)
  subagentStop(w, agentId, 'tester', report)
  await drainStaging(w)
}

// ── The client's own internal agent (D263) ──────────────────────────────

/** What Claude Code's compaction summarizer hands back: a long, structured
 *  summary of the conversation so far (the owner's largest was 11 KB). One
 *  word in it, `quokkaledger`, is in no other row, so a search for the
 *  report's own words has one right answer. */
export function compactionSummary(): string {
  const sections = [
    'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:',
    'Analysis: the developer asked for the login form, then for the CSRF test; the quokkaledger migration was discussed and deferred.',
    '1. Primary Request and Intent: wire the login form to POST /session and make the CSRF test pass.',
    '2. Key Technical Concepts: SameSite cookies, double-submit tokens, the session middleware.',
    '3. Files and Code Sections: src/routes/session.ts (the POST handler), test/csrf.test.ts (the failing case).',
    '4. Errors and fixes: the token was read from the body before the parser ran; moved the parser up.',
    '5. Pending Tasks: rerun the CSRF suite; write the chapter summary.',
  ]
  const detail = Array.from({ length: 60 }, (_, i) => `   - step ${i}: reviewed the session middleware ordering against case ${i} and noted the result`)
  return [...sections, ...detail].join('\n')
}

/** A SubagentStop for an agent nobody spawned, as Claude Code fires it: the
 *  parent's session id, an agent id, no agent_type, the report. */
function internalStop(w: OrchestrationWorld, agentId: string, report: string): void {
  runHook(w, 'subagent-stop', {
    hook_event_name: 'SubagentStop', agent_id: agentId, stop_hook_active: false,
    agent_transcript_path: join(w.proj!, `agent-${agentId}.jsonl`), last_assistant_message: report,
  })
}

type StoredRow = { node_id: string; metadata_json: string; content: Buffer | string | null }
function storedRows(w: OrchestrationWorld, where: string, ...params: unknown[]): StoredRow[] {
  return rawAll<StoredRow>(w, `SELECT node_id, metadata_json, content FROM nodes WHERE ${where} ORDER BY created_at, node_id`, ...params)
}
const contentBytes = (c: Buffer | string | null): Buffer => Buffer.isBuffer(c) ? c : Buffer.from(c ?? '', 'utf8')

// ── A real repository with real worktrees (D167, D190) ──────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()
}

/** A sandboxed home and a real git repository whose main checkout is
 *  `repo/`, with the store the production resolve chain derives for it
 *  — asked of the real resolver in a subprocess under the sandbox's
 *  home, so a worktree and its main checkout are seen to share it the
 *  way the hooks see it. */
async function openGitWorld(w: OrchestrationWorld): Promise<void> {
  w.home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-orch-home-')))
  w.defer(() => rmSync(w.home!, { recursive: true, force: true }))
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-orch-repo-')))
  w.defer(() => rmSync(root, { recursive: true, force: true }))
  w.repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', w.repo])
  git(w.repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  w.proj = w.repo
  w.worktrees = {}
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'resolve-driver.ts'), w.repo), {
    env: sandboxedSpawnEnv(w.home, { TREECONTEXT_BINDINGS_FILE: join(w.home, '.treecontext', 'bindings.json') }),
    cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  expect(r.status, r.stderr).toBe(0)
  const { storeName } = JSON.parse(r.stdout) as { storeName: string }
  w.dbPath = join(storesDirIn(w.home), storeName, 'treecontext.db')
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  // The store as the first hook mints it: the session-start hook of the
  // orchestrator's main checkout, then the library open a server makes.
  sessionStart(w, w.repo)
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath)), ownsDatabase: true })
  w.defer(() => store.close())
  w.store = store
  writeSessionBeacon(w.dbPath, process.pid, w.sessionId, w.repo, { rewrite: true })
}

function addWorktree(w: OrchestrationWorld, name: string, branch: string): string {
  const path = join(w.repo!, '..', name)
  git(w.repo!, 'worktree', 'add', '-q', '-b', branch, path)
  w.worktrees![name] = realpathSync.native(path)
  return w.worktrees![name]!
}

/** A new Claude Code session: a new id, its own server connection. */
async function newSession(w: OrchestrationWorld): Promise<void> {
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  await sessionClient(w)
}

export const orchestrationDefiner = (reg: Registry<OrchestrationWorld>): void => {
  // ── D186: one hop deep, the rest on request ──
  reg.define(/^an entry A, an entry B that names A, and an entry C that names B$/, async (w) => {
    await openWorld(w)
    const t = now()
    const a = { text: 'decision: the session cookie is SameSite=Lax for the login form', at: t - 3600 }
    const b = { text: 'tester: SameSite=Lax breaks the OAuth callback\nThe callback arrives cross-site and drops the cookie; see the failing e2e run.', at: t - 1800 }
    const c = { text: 'follow-up: the OAuth callback now uses a state token\nNo cookie is needed across the redirect.', at: t - 600 }
    const ids: Record<string, string> = {}
    ids['A'] = (await mcpNote(w, a.text, {}, { at: a.at }))['node_id'] as string
    await work(w, a.at + 1)
    ids['B'] = (await mcpNote(w, b.text, { agent_type: 'tester', refs: [ids['A']] }, { at: b.at }))['node_id'] as string
    await work(w, b.at + 1)
    ids['C'] = (await mcpNote(w, c.text, { refs: ids['B'] }, { at: c.at }))['node_id'] as string
    await work(w, c.at + 1)
    w.entries = { A: { id: ids['A']!, text: a.text }, B: { id: ids['B']!, text: b.text }, C: { id: ids['C']!, text: c.text } }
    // The reverse index, read straight from SQLite: one row per hop.
    expect(rawAll(w, 'SELECT ref_id, node_id FROM node_refs ORDER BY ref_id = ? DESC', ids['A'])).toEqual([
      { ref_id: ids['A'], node_id: ids['B'] }, { ref_id: ids['B'], node_id: ids['C'] },
    ])
  })
  reg.define(/^the orchestrator searches and hits A$/, async (w) => {
    // Words only A holds: the hit is A alone, so whatever else the
    // response shows of B or C came through A's referenced-by.
    const hits = await query(w, 'decision login form')
    expect(hits.map((h) => h.nodeId)).toEqual([w.entries!['A']!.id])
  })
  reg.define(/^the orchestrator sees A referenced by B with B's writer, age and first line, and a count of 1$/, (w) => {
    const hit = (w.read!['results'] as Hit[]).find((h) => h.nodeId === w.entries!['A']!.id)!
    const B = w.entries!['B']!
    const createdB = rawAll<{ t: number }>(w, 'SELECT created_at AS t FROM nodes WHERE node_id = ?', B.id)[0]!.t
    expect(hit.referencedBy).toEqual({
      count: 1,
      newest: {
        nodeId: B.id,
        writer: 'tester',
        age: ageText(createdB, now()),
        firstLine: 'tester: SameSite=Lax breaks the OAuth callback',
      },
    })
    expect(hit.referencedBy!.newest.age).toBe('30 minutes')
  })
  reg.define(/^the orchestrator does not see C until it fetches B by id$/, async (w) => {
    const { A, B, C } = w.entries as Record<string, { id: string; text: string }>
    const [, bRest] = B!.text.split('\n')
    const [cFirst, cRest] = C!.text.split('\n')
    // The search response, whole: neither C's id nor any line of it, and
    // nothing of B beyond its first line.
    const seen = JSON.stringify(w.read)
    expect(seen).not.toContain(C!.id)
    expect(seen).not.toContain(cFirst!)
    expect(seen).not.toContain(bRest!)
    // A fetched by id shows the same one hop, never two.
    const a = await fetchById(w, A!.id)
    expect((a['referencedBy'] as RefBy).newest.nodeId).toBe(B!.id)
    expect(JSON.stringify(w.read)).not.toContain(C!.id)
    // B fetched by id: the deliberate step. B is there in full (so the
    // bRest needle fires), and C one hop from it: id and first line (so
    // the cFirst needle fires), never C in full.
    const b = await fetchById(w, B!.id)
    expect(b['content']).toContain(bRest!)
    expect(b['referencedBy']).toMatchObject({ count: 1, newest: { nodeId: C!.id, firstLine: cFirst } })
    expect(JSON.stringify(w.read)).not.toContain(cRest!)
    // …and C's rest is a needle that fires when C itself is fetched.
    expect((await fetchById(w, C!.id))['content']).toContain(cRest!)
  })

  // ── D147: the subagent's summary, found by search ──
  reg.define(/^an orchestrating session that spawned a subagent in the role "([^"]+)"$/, async (w, role$) => {
    const role = String(role$)
    expect(role).toBe('tester')
    await openWorld(w)
    sessionStart(w)
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
    subagentStart(w, w.testerId, 'tester')
    // The registration, straight from SQLite: live, under the PARENT's id.
    expect(rawAll(w, "SELECT agent_type, stopped_at FROM session_registry WHERE session_id = ? AND agent_id = ?", w.sessionId, w.testerId))
      .toEqual([{ agent_type: 'tester', stopped_at: null }])
  })
  reg.define(/^the tester made (\d+) tool calls and reported "([^"]+)"$/, async (w, n$, report$) => {
    const n = String(n$)
    const report = String(report$)
    w.trailMarkers = Array.from({ length: Number(n) }, (_, i) => `case ${i}: ok (${randomBytes(3).toString('hex')})`)
    await subagentToolCalls(w, w.testerId!, 'tester', w.trailMarkers)
    w.report = report
  })
  reg.define(/^the tester finishes$/, async (w) => {
    // Through the hand-back tool, with closing words that are not the
    // report: the summary the orchestrator finds must be the report.
    subagentStop(w, w.testerId!, 'tester', w.report!, { closing: 'Report delivered to the orchestrator.' })
    await drainStaging(w)
    // Retired: the registration is no longer live.
    const [reg0] = rawAll<{ stopped_at: number | null }>(w, 'SELECT stopped_at FROM session_registry WHERE agent_id = ?', w.testerId)
    expect(reg0!.stopped_at).not.toBeNull()
  })
  reg.define(/^the orchestrator searching "([^"]+)" finds that report marked as the tester subagent's summary$/, async (w, q$) => {
    const q = String(q$)
    await sessionClient(w)
    const res = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 5 } }))
    // The orchestrator's search is the whole store: no subagent is live.
    expect(res['scope']).toBeUndefined()
    const hits = res['results'] as Array<{ nodeId: string; content: string; metadata: Record<string, unknown> }>
    const hit = hits.find((h) => h.content === w.report)
    expect(hit, JSON.stringify(hits.map((h) => h.content))).toBeTruthy()
    for (const m of [hit!.metadata, rawMeta(w, hit!.nodeId)]) {
      expect(m).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: 'tester', _writer_agent_id: w.testerId, _writer_src: 'hook', session_id: w.sessionId })
    }
  })

  // ── D263: the client's own internal agent, marked as such ──
  reg.define(/^a session in which the client's compaction summarizer finishes, with an agent id nobody registered and no agent type$/, async (w) => {
    await openWorld(w)
    sessionStart(w)
    w.internalId = `a${randomBytes(8).toString('hex')}`
    w.internalReport = compactionSummary()
    // Nobody registered it: the registry holds the session's self only.
    expect(rawAll(w, 'SELECT agent_id FROM session_registry WHERE session_id = ?', w.sessionId)).toEqual([{ agent_id: '' }])
  })
  reg.define(/^its report is captured and ingested$/, async (w) => {
    internalStop(w, w.internalId!, w.internalReport!)
    // Staged as the hook wrote it: the agent id, no agent type, the kind.
    expect(rawAll(w, 'SELECT agent_id, agent_type, kind, length(content) AS n FROM staging WHERE agent_id = ?', w.internalId)).toEqual([
      { agent_id: w.internalId, agent_type: null, kind: INTERNAL_SUMMARY_KIND, n: w.internalReport!.length },
    ])
    await drainStaging(w)
  })
  reg.define(/^the entry carries the kind "([^"]+)" and the writer "([^"]+)"$/, (w, kind$, writer$) => {
    expect([String(kind$), String(writer$)]).toEqual([INTERNAL_SUMMARY_KIND, CLIENT_WRITER])
    const rows = storedRows(w, "json_extract(metadata_json, '$._writer_agent_id') = ?", w.internalId)
    expect(rows).toHaveLength(1)
    // Captured whole: the stored bytes decode to the report itself.
    expect(decodeContent(rows[0]!.content)).toBe(w.internalReport)
    expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({
      kind: String(kind$), _writer: String(writer$), _writer_src: 'hook', _writer_agent_id: w.internalId,
      role: 'assistant', source: 'auto-capture', session_id: w.sessionId,
    })
    w.noteId = rows[0]!.node_id
  })
  reg.define(/^the orchestrator searching the report's own words finds it$/, async (w) => {
    await sessionClient(w)
    const hits = await query(w, 'quokkaledger migration deferred')
    expect(hits[0]?.nodeId, JSON.stringify(hits.map((h) => h.content.slice(0, 80)))).toBe(w.noteId)
    expect(hits[0]!.metadata).toMatchObject({ kind: INTERNAL_SUMMARY_KIND, _writer: CLIENT_WRITER })
  })
  reg.define(/^it is not marked as any subagent's summary$/, async (w) => {
    const m = rawMeta(w, w.noteId!)
    expect(m['kind']).not.toBe(SUBAGENT_SUMMARY_KIND)
    // Not under the agent id as a writer either, the lane a subagent's
    // report would have joined.
    expect(m['_writer']).not.toBe(w.internalId)
    expect(rawAll(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = ?", SUBAGENT_SUMMARY_KIND)).toEqual([])
    // Nor a resume pointer: the status panel the next session reads.
    const panel = await statusPanel(w)
    expect(JSON.stringify(panel['resume_pointers'] ?? [])).not.toContain(w.noteId!)
    // Nor named in the scope block, nor listed when every lane is asked for.
    expect(JSON.stringify(panel['scope'] ?? {})).not.toContain(w.noteId!)
    const every = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
    expect(every['scope']).toBeUndefined()
    expect(JSON.stringify(every)).not.toContain(w.noteId!)
  })

  // ── D263: what an earlier treecontext stored, re-marked on open ──
  reg.define(/^a store in which an earlier treecontext stored an untyped SubagentStop report as a subagent's summary beside a typed subagent's summary$/, async (w) => {
    await openWorld(w)
    sessionStart(w)
    // The typed subagent, through the real hooks and the drain.
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
    w.report = '12 tests pass, CSRF fails on the login form'
    subagentStart(w, w.testerId, 'tester')
    subagentStop(w, w.testerId, 'tester', w.report)
    // The untyped one as the earlier SubagentStop hook staged it — the
    // agent id, no agent type, kind subagent-summary, the columns that
    // hook's staging writer filled — then the same drain.
    w.internalId = `a${randomBytes(8).toString('hex')}`
    w.internalReport = compactionSummary()
    const stage = new DatabaseSync(w.dbPath!)
    try {
      stage.prepare(
        `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at, index_len, preview_len, namespace, agent_id, agent_type, kind)
         VALUES (?, 'assistant', ?, NULL, ?, 1, 0, ?, ?, NULL, NULL, ?, NULL, ?)`,
      ).run(w.sessionId!, w.internalReport, now(), now(), w.internalReport.length, w.internalId!, SUBAGENT_SUMMARY_KIND)
    } finally { stage.close() }
    await drainStaging(w)
    const untyped = storedRows(w, "json_extract(metadata_json, '$._writer_agent_id') = ?", w.internalId)
    const typed = storedRows(w, "json_extract(metadata_json, '$._writer_agent_id') = ?", w.testerId)
    expect([untyped.length, typed.length]).toEqual([1, 1])
    // As the earlier treecontext left them: both subagent summaries, the
    // untyped one under its agent id.
    expect(JSON.parse(untyped[0]!.metadata_json)).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: w.internalId, _writer_src: 'hook' })
    expect(JSON.parse(typed[0]!.metadata_json)).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: 'tester', _writer_src: 'hook' })
    w.noteId = untyped[0]!.node_id
    w.planId = typed[0]!.node_id
    w.rowsBefore = Object.fromEntries([...untyped, ...typed].map((r) => [r.node_id, { metadata_json: r.metadata_json, content: r.content }]))
    // ...at that treecontext's schema.
    await w.store!.close()
    const raw = new DatabaseSync(w.dbPath!)
    try { setPragma(raw, 'user_version = 28') } finally { raw.close() }
  })
  reg.define(/^this treecontext opens the store$/, async (w) => {
    const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true })
    w.defer(() => store.close())
    w.store = store
    expect(rawAll<{ v: number }>(w, 'SELECT user_version AS v FROM pragma_user_version')[0]!.v).toBe(maxSupportedVersion)
  })
  reg.define(/^the untyped report carries the kind "([^"]+)" and the writer "([^"]+)", its content unchanged$/, (w, kind$, writer$) => {
    const [row] = storedRows(w, 'node_id = ?', w.noteId)
    const before = w.rowsBefore![w.noteId!]!
    expect(JSON.parse(row!.metadata_json)).toEqual({ ...JSON.parse(before.metadata_json), kind: String(kind$), _writer: String(writer$) })
    expect(contentBytes(row!.content).equals(contentBytes(before.content))).toBe(true)
    expect(decodeContent(row!.content)).toBe(w.internalReport)
  })
  reg.define(/^the typed subagent's summary is unchanged$/, (w) => {
    const [row] = storedRows(w, 'node_id = ?', w.planId)
    const before = w.rowsBefore![w.planId!]!
    expect(row!.metadata_json).toBe(before.metadata_json)
    expect(contentBytes(row!.content).equals(contentBytes(before.content))).toBe(true)
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: 'tester' })
  })

  // ── D148: the subagent's trail, read on its own ──
  reg.define(/^an orchestrating session holding (\d+) entries of its own$/, async (w, n$) => {
    const n = String(n$)
    await openWorld(w)
    sessionStart(w)
    await orchestratorOwn(w, Number(n), 'session')
  })
  reg.define(/^a finished tester subagent whose trail is (\d+) tool calls and one report$/, async (w, n$) => {
    const n = String(n$)
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
    w.trailMarkers = Array.from({ length: Number(n) }, (_, i) => `tester case ${i} passed (${randomBytes(3).toString('hex')})`)
    w.report = '40 cases run; 38 pass, 2 fail on the session cookie; next: fix the cookie flags'
    await testerTrail(w, w.testerId, w.trailMarkers, w.report)
  })
  reg.define(/^the orchestrator asks for the tester's trail$/, async (w) => {
    await sessionClient(w)
    w.read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { writer: 'tester' } }))
  })
  reg.define(/^the orchestrator sees the (\d+) tool calls and the report$/, (w, n$) => {
    const n = String(n$)
    const nodes = w.read!['nodes'] as Array<{ nodeId: string; content: string; metadata: Record<string, unknown> }>
    const calls = nodes.filter((x) => x.metadata['tool_name'] === 'Bash')
    expect(calls).toHaveLength(Number(n))
    for (const marker of w.trailMarkers!) expect(calls.some((c) => c.content.includes(marker)), marker).toBe(true)
    const reports = nodes.filter((x) => x.metadata['kind'] === SUBAGENT_SUMMARY_KIND)
    expect(reports.map((r) => r.content)).toEqual([w.report])
    expect(nodes).toHaveLength(Number(n) + 1)
    // Separable by the store's stamp, read straight from SQLite.
    expect(rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$._writer') = 'tester'")[0]!.n).toBe(Number(n) + 1)
  })
  reg.define(/^the orchestrator sees none of its own (\d+) entries in that trail$/, (w, n$) => {
    const n = String(n$)
    expect(w.ownIds).toHaveLength(Number(n))
    const seen = JSON.stringify(w.read)
    for (const id of w.ownIds!) expect(seen).not.toContain(id)
    // They share the tester's session id: the trail is attribution, not a session.
    const shared = rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM nodes WHERE session_key = ?', w.sessionId)[0]!.n
    expect(shared).toBeGreaterThanOrEqual(Number(n) + 41)
  })

  // ── D150: a new subagent's default scope ──
  reg.define(/^an earlier tester subagent whose trail mentions "([^"]+)"$/, async (w, phrase$) => {
    const phrase = String(phrase$)
    await openWorld(w)
    sessionStart(w)
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
    await testerTrail(w, w.testerId, [
      `wrote the ${phrase} under tests/fixtures/login.json`,
      `loaded the ${phrase} into the e2e harness`,
    ], `${phrase} ready; the login e2e suite runs against them`)
    w.trailIds = rawAll<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$._writer') = 'tester'").map((r) => r.node_id)
    expect(w.trailIds).toHaveLength(3)
  })
  reg.define(/^the orchestrator's current plan reads "([^"]+)"$/, async (w, plan$) => {
    const plan = String(plan$)
    await sessionClient(w)
    const reply = await insert(w, plan, { next_session: true })
    expect(reply).toMatchObject({ writer: 'main', writer_src: 'self' })
    w.planId = reply['node_id'] as string
  })
  reg.define(/^(\d+) entries of the orchestrator's own that mention "([^"]+)"$/, async (w, n$, word$) => {
    const n = String(n$)
    const word = String(word$)
    await orchestratorOwn(w, Number(n), word)
  })
  reg.define(/^a new tester subagent starts and searches "([^"]+)"$/, async (w, q$) => {
    const q = String(q$)
    const second = `agent-${randomBytes(4).toString('hex')}`
    subagentStart(w, second, 'tester')
    w.read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 10 } }))
  })
  reg.define(/^the new tester finds the earlier tester's trail and the plan$/, (w) => {
    const ids = (w.read!['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    for (const id of [...w.trailIds!, w.planId!]) expect(ids).toContain(id)
    // The reply says which scope ran and how to widen it.
    expect(w.read!['scope']).toMatchObject({ writer: 'tester' })
  })
  reg.define(/^the new tester sees none of those (\d+) entries unless it asks for the whole store$/, async (w, n$) => {
    const n = String(n$)
    expect(w.ownIds).toHaveLength(Number(n))
    const scoped = JSON.stringify(w.read)
    for (const id of w.ownIds!) expect(scoped).not.toContain(id)
    // Widened by the explicit ask, the same search reaches them.
    const all = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'login', top_k: 10, scope: 'all' } }))
    expect(all['scope']).toBeUndefined()
    const wide = (all['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    expect(wide.filter((id) => w.ownIds!.includes(id)).length).toBeGreaterThan(0)
  })

  // ── D167: the worktree's own thread ──
  reg.define(/^a session in the worktree "([^"]+)" that wrote the chapter summary "([^"]+)" and then stopped$/, async (w, name$, text$) => {
    const name = String(name$)
    const text = String(text$)
    await openGitWorld(w)
    const path = addWorktree(w, name, 'login-form')
    await newSession(w)
    sessionStart(w, path)
    const reply = await insert(w, text, { next_session: true })
    expect(reply).toMatchObject({ writer: `worktree:${name}`, writer_src: 'self' })
    w.planId = reply['node_id'] as string
    w.chapterRow = { text }
  })
  reg.define(/^a new session starts in the worktree "([^"]+)" under a new session id$/, (w, name$) => {
    const name = String(name$)
    const before = w.sessionId
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    expect(w.sessionId).not.toBe(before)
    w.startPackets = { [name]: sessionStart(w, w.worktrees![name]!) }
  })
  reg.define(/^the packet handed to the new session's agent carries that chapter summary, labeled as the worktree's own$/, (w) => {
    const packet = Object.values(w.startPackets!)[0]!
    const line = packet.split('\n').find((l) => l.includes(String(w.chapterRow!['text'])))
    expect(line, packet).toBeTruthy()
    expect(line).toMatch(/^The worktree's own chapter summary, \d+ minutes? old \(id [0-9a-f]+\): /)
    expect(line).toContain(`(id ${w.planId})`)
  })
  reg.define(/^the packet handed to a session starting in the main checkout at the same time does not carry it$/, (w) => {
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    const main = sessionStart(w, w.repo!)
    // D373: the packet it is checked against is one that orients: it opens
    // on the main lane's own line and names the worktree's lane among the
    // others, by kind and age, so an absence below is the lane rule's.
    expect(main.split('\n')[0], main).toBe(MAIN_SELF_LINE)
    expect(namedInLine(otherLanesLineOf(main) ?? '')).toEqual([{
      lane: 'worktree:feature-login', kind: 'chapter summary', age: `${ageText(createdAtOf(w, w.planId!), now())} old`, pointers: 1,
    }])
    expect(main).not.toContain(String(w.chapterRow!['text']))
    expect(main).not.toContain(String(w.chapterRow!['text']).slice(0, 20))
    expect(main).not.toContain(w.planId!)
    // The main checkout registered as itself: no worktree.
    expect(rawAll(w, "SELECT worktree FROM session_registry WHERE session_id = ? AND agent_id = ''", w.sessionId)).toEqual([{ worktree: null }])
  })

  reg.define(/^a worktree "([^"]+)" that has never run a session$/, async (w, name$) => {
    const name = String(name$)
    await openGitWorld(w)
    addWorktree(w, name, `${name}-branch`)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE worktree = ?', name)).toEqual([])
  })
  reg.define(/^the worktree "([^"]+)" holds the chapter summary "([^"]+)"$/, async (w, name$, text$) => {
    const name = String(name$)
    const text = String(text$)
    const orchestrator = w.sessionId!
    const path = addWorktree(w, name, 'login-form')
    await newSession(w)
    sessionStart(w, path)
    const reply = await insert(w, text, { next_session: true })
    expect(rawMeta(w, reply['node_id'] as string)).toMatchObject({ _worktree: name, _writer: `worktree:${name}` })
    w.planId = reply['node_id'] as string
    w.chapterRow = { text }
    w.sessionId = orchestrator
  })
  reg.define(/^the orchestrator injected the brief "([^"]+)" at its start$/, async (w, brief$) => {
    const brief = String(brief$)
    // The means (D167, D150): an entry addressed to the worktree by
    // `brief_for`, written by the orchestrator through the insert tool
    // before the worktree's first session starts; that session's
    // session-start hook hands it to the agent.
    await sessionClient(w)
    const target = Object.keys(w.worktrees!).find((k) => k !== 'feature-login')!
    const reply = await insert(w, brief, { brief_for: target })
    expect(reply).toMatchObject({ writer: 'main', writer_src: 'self' })
    w.briefText = brief
  })
  reg.define(/^a session starts in the worktree "([^"]+)"$/, (w, name$) => {
    const name = String(name$)
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    w.startPackets = { [name]: sessionStart(w, w.worktrees![name]!) }
  })
  reg.define(/^the packet handed to its agent carries the injected brief$/, (w) => {
    const packet = Object.values(w.startPackets!)[0]!
    const line = packet.split('\n').find((l) => l.startsWith('Brief for this worktree'))
    expect(line, packet).toBeTruthy()
    expect(line).toContain(w.briefText!)
    expect(line).toMatch(/^Brief for this worktree from main, \d+ minutes? old/)
  })
  reg.define(/^the packet carries no chapter summary from any other worktree$/, (w) => {
    const packet = Object.values(w.startPackets!)[0]!
    expect(packet).not.toContain(String(w.chapterRow!['text']))
    expect(packet).not.toContain(w.planId!)
    expect(packet).toContain('has no chapter summary of its own yet')
  })

  // ── D190: self registration and the server's stamp ──
  reg.define(/^a session starting in the worktree "([^"]+)" on the branch "([^"]+)"$/, async (w, name$, branch$) => {
    const name = String(name$)
    const branch = String(branch$)
    await openGitWorld(w)
    addWorktree(w, name, branch)
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  })
  reg.define(/^the session-start hook fires$/, (w) => {
    const name = Object.keys(w.worktrees!)[0]!
    sessionStart(w, w.worktrees![name]!)
  })
  reg.define(/^the store holds a registration of that session whose worktree and branch equal what git reports for that directory$/, (w) => {
    const dir = Object.values(w.worktrees!)[0]!
    const reported = {
      worktree: basename(git(dir, 'rev-parse', '--show-toplevel')),
      branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
      toplevel: git(dir, 'rev-parse', '--show-toplevel'),
    }
    expect(reported.worktree).toBe('feature-login')
    expect(reported.branch).toBe('login-form')
    expect(rawAll(w, "SELECT worktree, branch, toplevel, cwd FROM session_registry WHERE session_id = ? AND agent_id = ''", w.sessionId))
      .toEqual([{ ...reported, cwd: dir }])
  })
  reg.define(/^a chapter summary written through the tools from that session is stamped with "([^"]+)"$/, async (w, name$) => {
    const name = String(name$)
    await sessionClient(w)
    const reply = await insert(w, 'plan: wire the login form; next: write its tests', { next_session: true })
    expect(rawMeta(w, reply['node_id'] as string)).toMatchObject({
      _worktree: name, _branch: 'login-form', _writer: `worktree:${name}`, _writer_src: 'self', _cc_session_id: w.sessionId,
    })
  })

  reg.define(/^a tester subagent and its orchestrator sharing one session id and one server$/, async (w) => {
    await openWorld(w)
    sessionStart(w)
    await sessionClient(w)
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
  })
  reg.define(/^each of them inserts a note through the tools$/, async (w) => {
    // Same client, same session id: nothing in the call says who speaks.
    // The orchestrator writes, then spawns the tester (a foreground
    // subagent: the orchestrator waits); the tester writes; each call's
    // own PostToolUse echo fires as it returns, the tester's carrying its
    // agent fields. The insert stamps the registry's reading — the
    // tester's provisionally — and the drain's echo heal makes both exact.
    const tester = { agentId: w.testerId!, agentType: 'tester' }
    const orchestrator = await insertEchoed(w, null, 'orchestrator: the login form goes behind the feature flag', {})
    subagentStart(w, w.testerId!, 'tester')
    const testerReply = await insertEchoed(w, tester, 'tester: the feature flag hides the login form from the e2e run', {})
    expect(testerReply).toMatchObject({ writer: 'tester', writer_src: 'provisional' })
    expect(String(testerReply['writer_note'])).toMatch(/provisionally/)
    subagentStop(w, w.testerId!, 'tester', 'flag checked')
    await drainStaging(w)
    w.notes = {
      orchestrator: { id: orchestrator['node_id'] as string, reply: orchestrator },
      tester: { id: testerReply['node_id'] as string, reply: testerReply },
    }
  })
  reg.define(/^the orchestrator reading the notes sees the tester's note stamped with the tester as writer and its own note stamped with the orchestrator$/, async (w) => {
    const { tester, orchestrator } = w.notes!
    expect(orchestrator.reply).toMatchObject({ writer: 'main', writer_src: 'self' })
    for (const [id, want] of [[tester.id, { _writer: 'tester', _writer_src: 'echo', _writer_agent_id: w.testerId }], [orchestrator.id, { _writer: 'main', _writer_src: 'echo' }]] as const) {
      const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: id } }))
      const meta = (read['nodes'] as Array<{ metadata: Record<string, unknown> }>)[0]!.metadata
      expect(meta).toMatchObject({ ...want, _cc_session_id: w.sessionId })
      expect(rawMeta(w, id)).toMatchObject(want)
    }
    expect(rawMeta(w, orchestrator.id)['_writer_agent_id']).toBeUndefined()
    // Both echoes were captured with their callers' fields, straight from staging.
    expect(rawAll(w, "SELECT agent_type FROM staging WHERE tool_name = 'mcp__treecontext__treecontext_insert' ORDER BY id"))
      .toEqual([{ agent_type: null }, { agent_type: 'tester' }])
  })

  // ── D169: lanes, on server-stamped writers ──
  reg.define(/^the orchestrator's chapter summary "([^"]+)" in the main lane$/, async (w, text$) => {
    const text = String(text$)
    await openWorld(w)
    sessionStart(w)
    await sessionClient(w)
    const reply = await insertEchoed(w, null, text, { next_session: true })
    expect(reply).toMatchObject({ writer: 'main', writer_src: 'self' })
    w.planId = reply['node_id'] as string
    await drainStaging(w)
    w.chapterRow = rawRow(w, w.planId)
    w.testerId = `agent-${randomBytes(4).toString('hex')}`
  })
  reg.define(/^the tester subagent appends a note into the main lane that names that chapter and reads "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    subagentStart(w, w.testerId!, 'tester')
    w.noteReply = await insertEchoed(w, { agentId: w.testerId!, agentType: 'tester' }, text, { refs: w.planId })
    subagentStop(w, w.testerId!, 'tester', 'CSRF reported to the orchestrator')
    await drainStaging(w)
    w.noteId = w.noteReply['node_id'] as string
  })
  reg.define(/^the orchestrator reading the note sees the tester named as its writer and the chapter's id as its reference$/, async (w) => {
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: w.noteId } }))
    const meta = (read['nodes'] as Array<{ metadata: Record<string, unknown> }>)[0]!.metadata
    expect(meta).toMatchObject({ _writer: 'tester', _writer_src: 'echo', _writer_agent_id: w.testerId, refs: w.planId })
    // …and from the chapter's side, one hop: the tester, by the stamp.
    const chap = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: w.planId } }))
    expect((chap['nodes'] as Array<Record<string, unknown>>)[0]!['referencedBy']).toMatchObject({ count: 1, newest: { nodeId: w.noteId, writer: 'tester' } })
  })
  reg.define(/^the orchestrator's chapter summary is unchanged byte for byte$/, (w) => {
    expect(rawRow(w, w.planId!)).toEqual(w.chapterRow)
  })
  reg.define(/^the orchestrator's chapter summary is still a live pointer$/, async (w) => {
    const panel = await statusPanel(w)
    expect((panel['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toContain(w.planId)
  })
  reg.define(/^the tester subagent writes an entry that supersedes that chapter$/, async (w) => {
    subagentStart(w, w.testerId!, 'tester')
    w.noteReply = await insertEchoed(w, { agentId: w.testerId!, agentType: 'tester' },
      'plan: rework the login form around the CSRF token; next: rotate it on refresh', { next_session: true }, [w.planId!])
    subagentStop(w, w.testerId!, 'tester', 'proposed a CSRF rework')
    await drainStaging(w)
    w.noteId = w.noteReply['node_id'] as string
    // The reply says the chapter was another writer's: referenced, not retired.
    expect(w.noteReply).toMatchObject({ writer: 'tester', writer_src: 'provisional', superseded: [], referenced: [w.planId] })
    expect(rawMeta(w, w.noteId)).toMatchObject({ _writer: 'tester', _writer_src: 'echo' })
  })
  reg.define(/^the orchestrator calling status still sees the chapter as a live pointer$/, async (w) => {
    const panel = await statusPanel(w)
    expect((panel['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toContain(w.planId)
    expect(rawRow(w, w.planId!)).toEqual(w.chapterRow)
  })
  reg.define(/^the tester's entry carries the pointer to the chapter$/, (w) => {
    expect(rawMeta(w, w.noteId!)).toMatchObject({ _writer: 'tester', refs: [w.planId] })
  })
  reg.define(/^the orchestrator's next packet after a \/clear lists the tester's entry under referenced-by$/, (w) => {
    const packet = clear(w)
    const lines = packet.split('\n')
    const at = lines.findIndex((l) => l.startsWith('Chapter summary,') && l.includes(`(id ${w.planId})`))
    expect(at, packet).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1]).toMatch(new RegExp(`^ {2}referenced by: ${w.noteId}, tester, \\d+ minutes? old: "plan: rework the login form`))
  })

  // ── D376: a lane read from the registry ──
  //
  // The undetermined writers: a client the server cannot place writes
  // through the tools of a store that records writers, and the store says
  // so (`_writer_src` `unregistered`); its chapters are one lane apart,
  // never main's. The checkout's lanes are read from the registry the
  // session-start hook keeps, in a real repository with real worktrees.
  reg.define(/^a chapter summary written through the tools by a session the server could not place, after the store recorded writers$/, async (w) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    const unplaced = await unplacedChapter(w, 'plan: an unplaced client\'s chapter')
    w.entries = { unknown: unplaced }
  })
  reg.define(/^the main checkout's own live chapter summary and the worktree "([^"]+)"'s own$/, async (w, name$) => {
    const name = String(name$)
    w.entries!['main'] = await laneChapter(w, 'main', 'plan: rewrite the README\'s install section')
    w.entries![`worktree:${name}`] = await laneChapter(w, `worktree:${name}`, 'plan: scaffold the subproject')
  })

  reg.define(/^a client the server cannot place that wrote the chapter summary "([^"]+)" and then a chapter summary that supersedes it$/, async (w, text$) => {
    const text = String(text$)
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    // The main checkout's own chapter, which the Then reads as still live.
    w.entries = { main: await laneChapter(w, 'main', 'plan: rewrite the README\'s install section') }
    const first = await unplacedChapter(w, text)
    const reply = await insert(w, 'plan: the second draft, which replaces the first', { next_session: true }, [first.id])
    // One lane for supersession: the unplaced writer retired its own.
    expect(reply).toMatchObject({ superseded: [first.id] })
    expect(rawMeta(w, reply['node_id'] as string)).toMatchObject({ _writer_src: 'unregistered' })
    w.entries['first'] = first
    w.entries['second'] = { id: reply['node_id'] as string, text: 'plan: the second draft, which replaces the first' }
  })
  reg.define(/^the main checkout's session calls status asking for every lane$/, async (w) => {
    await mcpOver(w, { ccSessionId: w.laneSessions!['main']! })
    w.statusReply = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: { scope: 'all' } }))
  })
  reg.define(/^the main checkout's own chapter summary is still live$/, (w) => {
    const main = w.entries!['main']!
    expect(rawMeta(w, main.id)).toMatchObject({ next_session: true, _writer: 'main' })
    expect(rawMeta(w, main.id)['superseded_by']).toBeUndefined()
    expect((w.statusReply!['resume_pointers'] as Array<{ node_id: string }>).map((p) => p.node_id)).toContain(main.id)
  })

  reg.define(/^a store whose chapter summary "([^"]+)" was written before the store recorded writers$/, async (w, text$) => {
    const text = String(text$)
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { older: { id: await olderChapter(w, text), text } }
  })
  reg.define(/^the main checkout's session calls status and searches "([^"]+)"$/, async (w, q$) => {
    await mcpOver(w, { ccSessionId: w.laneSessions!['main']! })
    w.statusReply = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
    w.read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: String(q$), top_k: 10 } }))
  })

  // ── D374, D376: a worktree's conversation an earlier release captured ──
  reg.define(/^a store in which an earlier treecontext captured a worktree "([^"]+)" session's turns with no writer$/, async (w, name$) => {
    const name = String(name$)
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    // The main checkout's own work, so its trail is not empty.
    runHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'rewrite the README install section', cwd: w.repo })
    const path = addWorktree(w, name, `${name}-branch`)
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    sessionStart(w, path)
    w.laneSessions[`worktree:${name}`] = w.sessionId
    // The worktree session's own turns, captured by the real hooks: the
    // session's own agent sends no agent fields, and the drain stamps no
    // writer on them, exactly as every earlier release left them.
    w.laneWords = 'quillmarsh scaffolding'
    runHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: `set up the ${w.laneWords} for the subproject`, cwd: path })
    runHook(w, 'post-tool-use', { ...bashPayload(w, 'mkdir -p subproject/src', `created the ${w.laneWords} directories`), cwd: path })
    await drainStaging(w)
    const turns = storedRows(w, 'session_key = ? AND content LIKE ?', w.sessionId, '%quillmarsh%')
    expect(turns.length).toBe(2)
    for (const t of turns) {
      const m = JSON.parse(t.metadata_json) as Record<string, unknown>
      for (const k of ['_writer', '_writer_src', '_writer_agent_id', 'agent_type']) expect(m[k], k).toBeUndefined()
    }
    w.turnIds = turns.map((t) => t.node_id)
    w.rowsBefore = Object.fromEntries(storedRows(w, '1').map((r) => [r.node_id, { metadata_json: r.metadata_json, content: r.content }]))
  })
  reg.define(/^the session in the worktree "([^"]+)" searches those turns' words$/, async (w, name$) => {
    await mcpOver(w, { ccSessionId: w.laneSessions![`worktree:${String(name$)}`]! })
    w.read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: w.laneWords!, top_k: 10 } }))
  })
  reg.define(/^an export of the worktree's trail carries those turns, and the main checkout's trail does not$/, async (w) => {
    const lane = Object.keys(w.laneSessions!).find((k) => k.startsWith('worktree:'))!
    const trail = async (writer: string): Promise<string[]> =>
      ((parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { writer } }))['nodes']) as Array<{ nodeId: string }>).map((n) => n.nodeId)
    const own = await trail(lane)
    for (const id of w.turnIds!) expect(own).toContain(id)
    const main = await trail('main')
    for (const id of w.turnIds!) expect(main).not.toContain(id)
    // The main checkout's trail is read, not empty: its own prompt is there.
    expect(main.length).toBeGreaterThan(0)
  })
  reg.define(/^the store's rows are unchanged byte for byte$/, (w) => {
    const now = Object.fromEntries(storedRows(w, '1').map((r) => [r.node_id, r]))
    for (const [id, before] of Object.entries(w.rowsBefore!)) {
      expect(now[id], id).toBeTruthy()
      expect(now[id]!.metadata_json).toBe(before.metadata_json)
      expect(contentBytes(now[id]!.content).equals(contentBytes(before.content))).toBe(true)
    }
  })

  // ── D372, D373: status and the fresh start, scoped to the session's lane ──
  //
  // Every lane's chapter is written through the tools by a session the
  // real SessionStart hook registered in its checkout (laneChapter), so
  // its stamp is the registry's; every status is read through a client
  // opened under the session under test (statusOf), never a client left
  // over from a Given; every packet is the real hook's output for a new
  // session id in that checkout (startIn).
  reg.define(/^the main checkout's live chapter summary "([^"]+)"$/, async (w, text$) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { main: await laneChapter(w, 'main', String(text$)) }
  })
  reg.define(/^a live chapter summary written later from the worktree "([^"]+)" that reads "([^"]+)"$/, async (w, name$, text$) => {
    const lane = `worktree:${String(name$)}`
    w.entries![lane] = await laneChapter(w, lane, String(text$))
    expect(createdAtOf(w, w.entries![lane]!.id)).toBeGreaterThan(createdAtOf(w, w.entries!['main']!.id))
  })
  reg.define(/^an older chapter summary written before the store recorded writers, reading "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    w.entries!['older'] = { id: await olderChapter(w, text), text }
  })
  reg.define(/^the main checkout's live chapter summary and a live chapter summary from the worktree "([^"]+)"$/, async (w, name$) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { main: await laneChapter(w, 'main', 'plan: rewrite the README\'s install section') }
    const lane = `worktree:${String(name$)}`
    w.entries[lane] = await laneChapter(w, lane, 'plan: scaffold the subproject')
  })
  reg.define(/^the main checkout's live chapter summary and live chapter summaries from (\d+) worktrees, each written later than the last$/, async (w, n$) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { main: await laneChapter(w, 'main', 'plan: rewrite the README\'s install section') }
    for (let i = 1; i <= Number(n$); i++) {
      const lane = `worktree:wt-${i}`
      w.entries[lane] = await laneChapter(w, lane, `plan: the wt-${i} worktree's own chapter, number ${i}`)
    }
  })

  reg.define(/^the session in the worktree "([^"]+)" calls status$/, async (w, name$) => {
    w.statusReply = await statusOf(w, w.laneSessions![`worktree:${String(name$)}`]!)
  })
  reg.define(/^the main checkout's session calls status$/, async (w) => {
    w.statusReply = await statusOf(w, w.laneSessions!['main']!)
  })
  reg.define(/^the main checkout's session calls status and then starts a new session$/, async (w) => {
    w.statusReply = await statusOf(w, w.laneSessions!['main']!)
    w.startPackets = { main: startIn(w, 'main') }
  })

  reg.define(/^the developer sees the worktree's chapter as the only live pointer listed$/, (w) => {
    const lane = Object.keys(w.entries!).find((k) => k.startsWith('worktree:'))!
    expect(pointersOf(w.statusReply!).map((p) => [p.node_id, p.lane])).toEqual([[w.entries![lane]!.id, lane]])
  })
  reg.define(/^the developer sees the main checkout's chapter and the older chapter as the main lane's live pointers, newest first, and nothing else$/, (w) => {
    const { main, older } = w.entries!
    expect(createdAtOf(w, main!.id)).toBeGreaterThan(createdAtOf(w, older!.id))
    expect(pointersOf(w.statusReply!).map((p) => [p.node_id, p.lane])).toEqual([[main!.id, 'main'], [older!.id, 'main']])
    expect(w.statusReply!['resume_message']).toMatch(/^2 resume pointer\(s\)/)
  })
  reg.define(/^the status names the (worktree's|main) lane, counts (\d+) live pointers? of other lanes left out, names (?:the main lane|the worktree "([^"]+)") with the kind and age of its newest pointer, and says how to widen$/, (w, whose$, n$, other$) => {
    const own = whose$ === 'main' ? 'main' : Object.keys(w.laneSessions!).find((k) => k.startsWith('worktree:'))!
    const other = other$ ? `worktree:${String(other$)}` : 'main'
    const block = blockOf(w.statusReply!)
    expect(block.lane).toBe(own)
    expect(block.listed).toContain(`(${own})`)
    expect(block.left_out).toBe(Number(n$))
    expect(block.other_lanes).toBe(1)
    expect(block.lanes).toEqual([lanePanelEntry(w, other)])
    expect(block.widen).toContain('scope "all"')
  })
  reg.define(/^the status carries none of the main checkout's chapter's text or id$/, (w) => {
    expectNoneOf(JSON.stringify(w.statusReply), [w.entries!['main']!])
  })
  reg.define(/^the worktree's chapter is not listed though it is the newest in the store, and none of its text or id appears$/, (w) => {
    const lane = Object.keys(w.entries!).find((k) => k.startsWith('worktree:'))!
    const wt = w.entries![lane]!
    const newest = rawAll<{ node_id: string }>(w,
      "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.next_session') = 1 ORDER BY created_at DESC LIMIT 1")
    expect(newest).toEqual([{ node_id: wt.id }])
    expect(pointersOf(w.statusReply!).map((p) => p.node_id)).not.toContain(wt.id)
    expectNoneOf(JSON.stringify(w.statusReply), [wt])
  })

  reg.define(/^the developer sees both chapters in one list, newest first, each naming its lane$/, (w) => {
    const lane = Object.keys(w.entries!).find((k) => k.startsWith('worktree:'))!
    expect(pointersOf(w.statusReply!).map((p) => [p.node_id, p.lane])).toEqual([[w.entries![lane]!.id, lane], [w.entries!['main']!.id, 'main']])
  })
  reg.define(/^no lane is set apart and no count of lanes left out is given$/, (w) => {
    expect(w.statusReply!['scope']).toBeUndefined()
    const text = JSON.stringify(w.statusReply)
    for (const k of ['"other_lanes"', '"left_out"', '"lanes"', '"listed"']) expect(text).not.toContain(k)
  })

  reg.define(/^the status and the packet each count (\d+) other lanes and name the (\d+) whose newest pointer is most recent, newest first$/, (w, n$, named$) => {
    const n = Number(n$)
    const named = Number(named$)
    // The other lanes, newest first, as SQLite holds their chapters.
    const others = Object.keys(w.entries!).filter((k) => k !== 'main')
      .sort((a, b) => createdAtOf(w, w.entries![b]!.id) - createdAtOf(w, w.entries![a]!.id))
    expect(others).toHaveLength(n)
    const block = blockOf(w.statusReply!)
    expect(block.lane).toBe('main')
    expect(block.other_lanes).toBe(n)
    expect(block.left_out).toBe(n)
    expect((block.lanes ?? []).map((l) => l.lane)).toEqual(others.slice(0, named))
    for (const l of block.lanes ?? []) expect(l).toEqual(lanePanelEntry(w, l.lane))
    const packet = w.startPackets!['main']!
    const line = otherLanesLineOf(packet)
    if (n === 0) {
      expect(line, packet).toBeUndefined()
      return
    }
    expect(line, packet).toBeTruthy()
    expect(line).toMatch(new RegExp(`^${n === 1 ? '1 other lane holds a live pointer' : `${n} other lanes hold live pointers`}, `))
    expect(namedInLine(line!).map((l) => l.lane)).toEqual(others.slice(0, named))
    if (n > named) expect(line).toContain(`; and ${n - named} more.`)
    else expect(line).toMatch(/ live pointers?\)\. To look: /)
  })
  reg.define(/^neither carries any other lane's chapter text or id$/, (w) => {
    const others = Object.entries(w.entries!).filter(([k]) => k !== 'main').map(([, e]) => e)
    expectNoneOf(JSON.stringify(w.statusReply), others)
    expectNoneOf(w.startPackets!['main']!, others)
    // The main lane's own chapter is what both lead with.
    expect(pointersOf(w.statusReply!).map((p) => p.node_id)).toEqual([w.entries!['main']!.id])
    expect(w.startPackets!['main']!).toContain(`(id ${w.entries!['main']!.id})`)
  })

  // ── D373: the restarted main checkout (the owner's incident) ──
  reg.define(/^a session in the main checkout that wrote the chapter summary "([^"]+)" and then stopped$/, async (w, text$) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { main: await laneChapter(w, 'main', String(text$)) }
  })
  reg.define(/^a session in the worktree "([^"]+)" that wrote the newer chapter summary "([^"]+)"$/, async (w, name$, text$) => {
    const lane = `worktree:${String(name$)}`
    w.entries![lane] = await laneChapter(w, lane, String(text$))
    expect(createdAtOf(w, w.entries![lane]!.id)).toBeGreaterThan(createdAtOf(w, w.entries!['main']!.id))
  })
  reg.define(/^a new session starts in the main checkout under a new session id, by a startup and again by a resume$/, (w) => {
    const before = w.laneSessions!['main']
    const startup = startIn(w, 'main', 'startup')
    w.laneSessions!['main:startup'] = w.sessionId!
    const resume = startIn(w, 'main', 'resume')
    w.laneSessions!['main:resume'] = w.sessionId!
    expect(new Set([before, w.laneSessions!['main:startup'], w.laneSessions!['main:resume']]).size).toBe(3)
    w.startPackets = { startup, resume }
  })
  reg.define(/^the packet handed to its agent opens by saying the session runs in the main checkout and re-orients on the main lane's own thread$/, (w) => {
    for (const packet of Object.values(w.startPackets!)) expect(packet.split('\n')[0], packet).toBe(MAIN_SELF_LINE)
  })
  reg.define(/^the packet carries the main checkout's chapter summary labeled as its own, with its age and id$/, (w) => {
    const main = w.entries!['main']!
    for (const [source, packet] of Object.entries(w.startPackets!)) {
      const lines = packet.split('\n')
      expect(lines[1], packet).toBe(`The main lane's own chapter summary, ${ageText(createdAtOf(w, main.id), now())} old (id ${main.id}): ${main.text}`)
      if (source === 'resume') {
        // The self lines stand whole outside a resume's budget of 500
        // characters; only what follows them is the budget's.
        const selfEnd = lines.findIndex((l) => /^(No prior snapshot|Snapshot #)/.test(l))
        expect(selfEnd, packet).toBeGreaterThan(2)
        expect(otherLanesLineOf(lines.slice(0, selfEnd).join('\n'))).toMatch(/To look: treecontext_status with scope "all", or treecontext_export with writer naming the lane\.$/)
        expect(lines.slice(selfEnd).join('\n').length).toBeLessThanOrEqual(500)
      }
    }
  })
  reg.define(/^the packet says (\d+) other lanes? holds? a live pointer, names the worktree "([^"]+)" with the kind and age of that pointer, and says where to look$/, (w, n$, name$) => {
    const lane = `worktree:${String(name$)}`
    for (const packet of Object.values(w.startPackets!)) {
      const line = otherLanesLineOf(packet)
      expect(line, packet).toMatch(new RegExp(`^${Number(n$)} other lanes? holds? a live pointer, `))
      expect(namedInLine(line!)).toEqual([packetEntry(w, lane)])
      expect(line).toContain('To look: treecontext_status with scope "all", or treecontext_export with writer naming the lane.')
    }
  })
  reg.define(/^the packet carries none of the worktree's chapter's text or id$/, (w) => {
    const others = Object.entries(w.entries!).filter(([k]) => k.startsWith('worktree:')).map(([, e]) => e)
    for (const packet of Object.values(w.startPackets!)) expectNoneOf(packet, others)
  })
  reg.define(/^the status it calls lists the main checkout's chapter as its own and not the worktree's$/, async (w) => {
    // A fresh client under the restarted session's own id: what its own
    // server would read.
    const reply = await statusOf(w, w.laneSessions!['main:resume']!)
    const lane = Object.keys(w.entries!).find((k) => k.startsWith('worktree:'))!
    expect(pointersOf(reply).map((p) => [p.node_id, p.lane])).toEqual([[w.entries!['main']!.id, 'main']])
    const block = blockOf(reply)
    expect(block.lane).toBe('main')
    expect(block.lanes).toEqual([lanePanelEntry(w, lane)])
    expectNoneOf(JSON.stringify(reply), [w.entries![lane]!])
  })

  // ── D373: a bookmark only; the main checkout alone ──
  reg.define(/^a main checkout whose only checkpoint is the live bookmark "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    await mcpOver(w, { ccSessionId: w.sessionId! })
    const reply = await insert(w, text, { kind: 'bookmark' })
    expect(reply).toMatchObject({ writer: 'main', writer_src: 'self' })
    w.entries = { bookmark: { id: reply['node_id'] as string, text } }
    expect(rawAll(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.next_session') = 1")).toEqual([{ node_id: w.entries['bookmark']!.id }])
  })
  reg.define(/^a session in the worktree "([^"]+)" that wrote the chapter summary "([^"]+)"$/, async (w, name$, text$) => {
    const lane = `worktree:${String(name$)}`
    w.entries![lane] = await laneChapter(w, lane, String(text$))
  })
  reg.define(/^a session starts in the main checkout$/, (w) => {
    w.startPackets = { main: startIn(w, 'main') }
  })
  reg.define(/^the packet says the main lane has no chapter summary of its own and carries the bookmark, named as a bookmark, with its age and id$/, (w) => {
    const packet = w.startPackets!['main']!
    const bm = w.entries!['bookmark']!
    const lines = packet.split('\n')
    expect(lines[0], packet).toBe(MAIN_SELF_LINE)
    expect(lines[1]).toBe(`The main lane has no chapter summary of its own; its live bookmark, ${ageText(createdAtOf(w, bm.id), now())} old (id ${bm.id}): ${bm.text}`)
    // No chapter line anywhere among the self lines: the bookmark line is
    // followed directly by the other lanes' line.
    expect(lines[2]).toBe(otherLanesLineOf(packet))
  })
  reg.define(/^the packet names the worktree "([^"]+)" among other lanes and carries none of its chapter's text or id$/, (w, name$) => {
    const lane = `worktree:${String(name$)}`
    const packet = w.startPackets!['main']!
    expect(namedInLine(otherLanesLineOf(packet) ?? '')).toEqual([packetEntry(w, lane)])
    expectNoneOf(packet, [w.entries![lane]!])
  })
  reg.define(/^a store in which only the main checkout ever wrote, holding one live chapter summary$/, async (w) => {
    await openGitWorld(w)
    w.laneSessions = { main: w.sessionId! }
    w.entries = { main: await laneChapter(w, 'main', 'plan: rewrite the README\'s install section') }
    expect(rawAll(w, 'SELECT DISTINCT worktree FROM session_registry')).toEqual([{ worktree: null }])
    expect(rawAll(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.next_session') = 1")).toEqual([{ node_id: w.entries['main']!.id }])
  })
  reg.define(/^the packet opens with the main checkout's own line and carries its chapter summary labeled as its own$/, (w) => {
    const packet = w.startPackets!['main']!
    const main = w.entries!['main']!
    const lines = packet.split('\n')
    expect(lines[0], packet).toBe(MAIN_SELF_LINE)
    expect(lines[1]).toBe(`The main lane's own chapter summary, ${ageText(createdAtOf(w, main.id), now())} old (id ${main.id}): ${main.text}`)
  })
  reg.define(/^the packet carries no line about other lanes$/, (w) => {
    const packet = w.startPackets!['main']!
    expect(otherLanesLineOf(packet), packet).toBeUndefined()
    // The self lines end with the chapter's referrers; what follows is the
    // start's own payload, a fresh session's with nothing staged.
    expect(packet.split('\n').slice(2)).toEqual(['  referenced by: none', 'No prior context available. Use treecontext_query to search project memory.'])
  })

  // ── D376: the undetermined writers in status and the packet ──
  reg.define(/^the status and the packet list the main checkout's chapter as the main lane's own, and not the unplaced one$/, (w) => {
    const { main, unknown } = w.entries!
    expect(pointersOf(w.statusReply!).map((p) => [p.node_id, p.lane])).toEqual([[main!.id, 'main']])
    expect(blockOf(w.statusReply!).lane).toBe('main')
    const packet = w.startPackets!['main']!
    expect(packet.split('\n')[0]).toBe(MAIN_SELF_LINE)
    expect(packet.split('\n')[1]).toBe(`The main lane's own chapter summary, ${ageText(createdAtOf(w, main!.id), now())} old (id ${main!.id}): ${main!.text}`)
    expectNoneOf(JSON.stringify(w.statusReply), [unknown!])
    expectNoneOf(packet, [unknown!])
  })
  reg.define(/^both count the unplaced chapter under a lane named "writer unknown"$/, (w) => {
    const block = blockOf(w.statusReply!)
    expect(block.other_lanes).toBe(2)
    expect(block.lanes).toContainEqual(lanePanelEntry(w, UNKNOWN_WRITER_LABEL))
    expect(namedInLine(otherLanesLineOf(w.startPackets!['main']!) ?? '')).toContainEqual(packetEntry(w, UNKNOWN_WRITER_LABEL))
  })
  reg.define(/^a session in the worktree "([^"]+)" calling status counts the unplaced chapter under "writer unknown", never as its own, and its packet does the same$/, async (w, name$) => {
    const lane = `worktree:${String(name$)}`
    const { unknown } = w.entries!
    const reply = await statusOf(w, w.laneSessions![lane]!)
    expect(pointersOf(reply).map((p) => [p.node_id, p.lane])).toEqual([[w.entries![lane]!.id, lane]])
    const block = blockOf(reply)
    expect(block.lane).toBe(lane)
    expect(block.lanes).toContainEqual(lanePanelEntry(w, UNKNOWN_WRITER_LABEL))
    expectNoneOf(JSON.stringify(reply), [unknown!])
    const packet = startIn(w, lane)
    expect(packet.split('\n')[1]).toContain(`(id ${w.entries![lane]!.id})`)
    expect(namedInLine(otherLanesLineOf(packet) ?? '')).toContainEqual(packetEntry(w, UNKNOWN_WRITER_LABEL))
    expectNoneOf(packet, [unknown!])
  })
  reg.define(/^asking for every lane lists it labeled "writer unknown", its other metadata readable$/, async (w) => {
    const { unknown } = w.entries!
    const reply = await statusOf(w, w.laneSessions!['main']!, { scope: 'all' })
    expect(reply['scope']).toBeUndefined()
    const p = pointersOf(reply).find((x) => x.node_id === unknown!.id)
    expect(p).toBeTruthy()
    expect(p!.lane).toBe(UNKNOWN_WRITER_LABEL)
    expect(p!.metadata).toMatchObject({ _writer_src: 'unregistered', _cc_session_id: w.laneSessions!['unplaced'], next_session: true })
    expect(new Set(pointersOf(reply).map((x) => x.lane))).toEqual(new Set(['main', 'worktree:subproject', UNKNOWN_WRITER_LABEL]))
  })
  reg.define(/^the developer sees the newer chapter as the one live pointer labeled "writer unknown", the first superseded$/, (w) => {
    const { first, second } = w.entries!
    const unknown = pointersOf(w.statusReply!).filter((p) => p.lane === UNKNOWN_WRITER_LABEL)
    expect(unknown.map((p) => p.node_id)).toEqual([second!.id])
    expect(unknown[0]!.supersedes).toEqual([first!.id])
    expect(pointersOf(w.statusReply!).map((p) => p.node_id)).not.toContain(first!.id)
    expect(rawMeta(w, first!.id)).toMatchObject({ superseded_by: second!.id })
    expect(rawMeta(w, first!.id)['next_session']).not.toBe(true)
  })
  reg.define(/^a session in the worktree "([^"]+)" sees it counted among other lanes, never as its own$/, async (w, name$) => {
    const lane = `worktree:${String(name$)}`
    const { older } = w.entries!
    const path = addWorktree(w, String(name$), `${String(name$)}-branch`)
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    const packet = sessionStart(w, path)
    w.laneSessions![lane] = w.sessionId
    const reply = await statusOf(w, w.sessionId)
    expect(pointersOf(reply)).toEqual([])
    const block = blockOf(reply)
    expect(block.lane).toBe(lane)
    expect(block).toMatchObject({ left_out: 1, other_lanes: 1 })
    expect(block.lanes).toEqual([lanePanelEntry(w, 'main')])
    expectNoneOf(JSON.stringify(reply), [older!])
    expect(namedInLine(otherLanesLineOf(packet) ?? '')).toEqual([packetEntry(w, 'main')])
    expectNoneOf(packet, [older!])
  })
}

/** A chapter summary written through the tools by the session the world
 *  keeps for `lane` (`main`, or `worktree:<name>`, a new session started
 *  in that worktree by the real SessionStart hook), stamped from the
 *  registry with that lane's writer. */
async function laneChapter(w: OrchestrationWorld, lane: string, text: string): Promise<{ id: string; text: string }> {
  w.laneSessions ??= {}
  if (!w.laneSessions[lane]) {
    const name = lane.slice('worktree:'.length)
    const path = w.worktrees![name] ?? addWorktree(w, name, `${name}-branch`)
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    sessionStart(w, path)
    w.laneSessions[lane] = w.sessionId
  }
  await mcpOver(w, { ccSessionId: w.laneSessions[lane] })
  const reply = await insert(w, text, { next_session: true })
  expect(reply).toMatchObject({ writer: lane, writer_src: 'self' })
  return { id: reply['node_id'] as string, text }
}

/** A chapter summary written through the tools by a client the server
 *  cannot place: a Claude Code session no hook registered. The store
 *  records writers, so the row says its writer is undetermined. */
async function unplacedChapter(w: OrchestrationWorld, text: string): Promise<{ id: string; text: string }> {
  w.laneSessions ??= {}
  w.laneSessions['unplaced'] ??= `cc-${randomBytes(6).toString('hex')}`
  const session = w.laneSessions['unplaced']
  expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', session)).toEqual([])
  await mcpOver(w, { ccSessionId: session })
  const reply = await insert(w, text, { next_session: true })
  const m = rawMeta(w, reply['node_id'] as string)
  expect(m).toMatchObject({ _writer_src: 'unregistered', _cc_session_id: session, next_session: true })
  expect(m['_writer']).toBeUndefined()
  return { id: reply['node_id'] as string, text }
}

/** A chapter summary as a release before the store recorded writers wrote
 *  it through the tools: the metadata that insert tool stamped (the
 *  Claude Code session it resolved, the connection) and no writer, no
 *  door, no identity, from a session the registry never held. Written
 *  through the library, which stamps nothing of its own. */
async function olderChapter(w: OrchestrationWorld, text: string): Promise<string> {
  const session = `cc-${randomBytes(6).toString('hex')}`
  const r = await w.store!.insert(text, {
    metadata: { next_session: true, _cc_session_id: session, _cc_session_src: 'env', _session_id: 'conn-old', _conn_id: 'conn-old' },
    createdAt: now() - 86_400 * 30,
  })
  const m = rawMeta(w, r.nodeId)
  for (const k of ['_writer', '_writer_src', '_door', '_identity']) expect(m[k], k).toBeUndefined()
  expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', session)).toEqual([])
  return r.nodeId
}

// ── Status and the fresh start, as the session under test reads them ────

/** The first line of a fresh start in the main checkout of the git world
 *  (branch "main"), the line D373 says the packet opens with. */
const MAIN_SELF_LINE = 'This session runs in the main checkout on the branch "main"; it re-orients on the main lane\'s own thread.'

type PanelPointer = { node_id: string; kind: string; lane?: string; supersedes?: string[]; metadata?: Record<string, unknown> }
type LaneEntry = { lane: string; kind: string; age: string; pointers: number }
type ScopeBlock = { lane?: string; listed?: string; left_out?: number; other_lanes?: number; lanes?: LaneEntry[]; widen?: string; worker?: string; unplaced?: string }

/** Status as the session `session` reads it: a client opened under that
 *  session id, never one a Given left behind. */
async function statusOf(w: OrchestrationWorld, session: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  await mcpOver(w, { ccSessionId: session })
  w.clientSession = session
  return parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: args }))
}

/** A new Claude Code session in the checkout `lane` names (`main` or
 *  `worktree:<name>`): a new id, the real SessionStart hook in that
 *  directory; returns the packet the hook handed the agent. */
function startIn(w: OrchestrationWorld, lane: string, source = 'startup'): string {
  const cwd = lane === 'main' ? w.repo! : w.worktrees![lane.slice('worktree:'.length)]!
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  return sessionStart(w, cwd, source)
}

const pointersOf = (reply: Record<string, unknown>): PanelPointer[] => (reply['resume_pointers'] as PanelPointer[] | undefined) ?? []
function blockOf(reply: Record<string, unknown>): ScopeBlock {
  const block = reply['scope'] as ScopeBlock | undefined
  expect(block, JSON.stringify(reply)).toBeTruthy()
  return block!
}

function createdAtOf(w: OrchestrationWorld, id: string): number {
  return rawAll<{ t: number }>(w, 'SELECT created_at AS t FROM nodes WHERE node_id = ?', id)[0]!.t
}

/** The lane a Given's named entry was written into, as the test knows it
 *  (never read back through the production lane key). */
function laneOfEntry(key: string): string {
  if (key === 'main' || key === 'older' || key === 'bookmark') return 'main'
  if (key === 'unknown' || key === 'first' || key === 'second') return UNKNOWN_WRITER_LABEL
  return key
}

/** What status and the packet must say of `lane`: the kind and age of its
 *  newest live pointer and how many it holds, from SQLite directly. */
function laneEntry(w: OrchestrationWorld, lane: string): LaneEntry {
  const live = Object.entries(w.entries!).filter(([k]) => laneOfEntry(k) === lane)
    .map(([, e]) => ({ e, m: rawMeta(w, e.id), at: createdAtOf(w, e.id) }))
    .filter((x) => x.m['next_session'] === true)
    .sort((a, b) => b.at - a.at)
  expect(live.length, `no live pointer of ${lane}`).toBeGreaterThan(0)
  return {
    lane, kind: live[0]!.m['kind'] === 'bookmark' ? 'bookmark' : 'chapter summary',
    age: `${ageText(live[0]!.at, now())} old`, pointers: live.length,
  }
}
const lanePanelEntry = laneEntry
const packetEntry = laneEntry

/** The packet's one line about the other lanes, if it has one. */
function otherLanesLineOf(packet: string): string | undefined {
  return packet.split('\n').find((l) => /^\d+ other lanes? holds? (a )?live pointers?, /.test(l))
}

/** The lanes that line names, in its order, each as status gives it. */
function namedInLine(line: string): LaneEntry[] {
  const m = /the most recent: (.*?)(?:; and \d+ more)?\. To look: /.exec(line)
  expect(m, line).toBeTruthy()
  return m![1]!.split('; ').map((part) => {
    const p = /^(.+) \((chapter summary|bookmark), (\d+ \w+ old), (\d+) live pointers?\)$/.exec(part)
    expect(p, part).toBeTruthy()
    return { lane: p![1]!, kind: p![2]!, age: p![3]!, pointers: Number(p![4]) }
  })
}

/** Neither the text (whole, or its first words) nor the id of any of
 *  `entries` appears in `text`. */
function expectNoneOf(text: string, entries: Array<{ id: string; text: string }>): void {
  for (const e of entries) {
    expect(text).not.toContain(e.id)
    expect(text).not.toContain(e.text)
    expect(text).not.toContain(e.text.slice(0, 20))
  }
}
