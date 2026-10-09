import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { FlatStore } from '../../../src/flat-store.js'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { writeSessionBeacon } from '../../../src/session-beacon.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { mcpOver, parseTool, rawAll } from '../world.js'
import { TS_ROOT, tsxArgv } from '../proc.js'
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import { ageText } from '../../../src/references.js'
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

/** The subagent finishes: SubagentStop with its last assistant message. */
function subagentStop(w: OrchestrationWorld, agentId: string, agentType: string, report: string): void {
  runHook(w, 'subagent-stop', {
    hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, stop_hook_active: false,
    agent_transcript_path: join(w.proj!, `agent-${agentId}.jsonl`), last_assistant_message: report,
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
  const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true })
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
    subagentStop(w, w.testerId!, 'tester', w.report!)
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
    expect(main).not.toContain(String(w.chapterRow!['text']))
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

}
