/**
 * The mature journal (D266): a synthesized store that looks like a
 * developer's real journal after weeks of use, built THROUGH THE CAPTURE
 * PIPELINE so the hook's composition and the drain's stamps are what the
 * ranking sees.
 *
 * Generator, per session (one session per working day, several days):
 *  1. Session start, as the handshake asks: the agent calls
 *     `treecontext_status`, then the orientation query "what was I working
 *     on, what was the next step". Both go through the real MCP server;
 *     their responses (the earlier sessions' resume pointers and notes, with
 *     previews) are what the echoes carry.
 *  2. Turns: a developer prompt (user-prompt-submit hook), a run of shell
 *     tool events (Bash, Read, Grep through post-tool-use, with output in
 *     the project's vocabulary and, here and there, the orientation query's
 *     own words: "working on", "next step"), and the turn's final assistant
 *     text (Stop hook, `last_assistant_message`).
 *  3. Curated rows through `treecontext_insert` (a decision, a finding, the
 *     chapter checkpoint with `next_session` superseding the previous one,
 *     and a bookmark), each followed by its insert echo.
 *  Every hook payload is a real Claude Code payload fed to the real hook
 *  subprocess; the production drain (IngestionLoop) ingests the session.
 *
 * Honest time: the hooks stamp wall-clock time, so before each session
 * drains, every staged row's `timestamp` is moved to its synthesized moment
 * (the drain carries it into `created_at`), and the session's curated rows'
 * `created_at` likewise; an insert echo lands one second after its row, so
 * the echo heal correlates them as it would live.
 *
 * Deterministic: content comes from a seeded PRNG over fixed vocabularies
 * (./shape.ts); only node ids (uuid) differ between builds, which is why
 * every row the generator makes is also reported under a LOGICAL key
 * (`s2:shell:1:5`, `s5:checkpoint`) that is the same in every build. Built
 * once per process and copied per use (a file copy after a clean close
 * keeps rowids, which the contentless FTS index is keyed on).
 *
 * No vitest here: the charter suite wraps this in
 * tests/helpers/mature-journal.ts with its assertions, and the bench arm
 * (bench/arms/mature-journal.ts) reads it directly. A build that cannot
 * account for its own rows throws.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../../src/server/server.js'
import { IngestionLoop } from '../../../src/server/ingestion.js'
import { openNodeSqlite, pragmaRows } from '../../../src/persistence/node-sqlite.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { FlatStore } from '../../../src/flat-store.js'
import { composeToolText } from '../../../src/hooks/post-tool-use.js'
import { applyLiftedBoundaries, indexTextFor } from '../../../src/persistence/index-text.js'
import { Gen, MATURE, OLD_THREAD, ORIENTATION_QUERY, PROMPTS, SAID, SHELL_ONLY_TERM, TOPICS, shellEvent } from './shape.js'

/** The repository root: the hooks run from here, as the charter suite runs them. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// ── What a build reports ──────────────────────────────────────────────

/** Where a logical row came from: the kind the bench slices by. */
export type RowKind = 'user' | 'shell' | 'said' | 'decision' | 'finding' | 'checkpoint' | 'bookmark'

export interface MatureJournal {
  /** The oldest session's opening developer turn (OLD_THREAD). */
  oldThreadId: string
  /** The newest session's chapter checkpoint (FRESH_PLAN), status active. */
  freshPlanId: string
  /** Every curated row (notes, checkpoints, bookmarks). */
  curatedIds: string[]
  /** The shell event whose output alone carries SHELL_ONLY_TERM ('' when a
   *  mutated build lost it; the charter wrapper asserts it is there). */
  shellOnlyId: string
  counts: {
    toolRows: number; curatedRows: number; toolBytes: number; curatedBytes: number; queryEchoes: number
    /** Every row, and the captured developer and assistant (non-tool) turns. */
    rows: number; developerRows: number; assistantRows: number
  }
  /**
   * Every row the generator made, by logical key → node id. Keys:
   * `s{k}:user:{turn}`, `s{k}:shell:{turn}:{i}`, `s{k}:said:{turn}`,
   * `s{k}:decision`, `s{k}:finding`, `s{k}:checkpoint`, `s{k}:bookmark`.
   * The same key names the same planned row in every build of the seed.
   */
  ids: Record<string, string>
  /** The text the generator handed the pipeline for each key, before any
   *  bench mutation: the prompt, the tool output, the assistant text, the
   *  curated content. */
  texts: Record<string, string>
  /** Per key: its kind and, for a shell event, the tool. */
  kinds: Record<string, { kind: RowKind; tool?: string }>
  /** Per shell key: the row's INDEXED text as the built database holds it
   *  (decoded content sliced at its index boundary), what FTS sees. A
   *  trail tool (Read) indexes its preview only, so this is narrower than
   *  `texts` for a long read. */
  indexed: Record<string, string>
}

export interface BuildOptions {
  /** argv for one hook entry point under tsx; defaults to the bench's own
   *  spelling (the charter suite passes its one recipe, which adds the
   *  coverage preload under `npm run test:coverage`). */
  hookArgv?: (script: string) => string[]
  /** The hook subprocess environment for a sandbox home; defaults to the
   *  bench's mirror of tests/helpers/cli-spawn.ts's sandboxedSpawnEnv. */
  hookEnv?: (home: string) => Record<string, string | undefined>
  /** A bench mutation's `onInsert`, applied to every prompt, tool output,
   *  assistant text and curated content the generator hands the pipeline.
   *  The capture path has no single insert seam; this is the nearest one.
   *  A mutation that makes a staged row unmatchable to its planned event
   *  throws rather than moving numbers. Absent for the charter suite. */
  mutateText?: (text: string) => string
}

// ── The sandbox and the hook subprocesses ─────────────────────────────

/** Ambient variables product code resolves real-machine state from; a
 *  mirror of LEAK_KEYS in tests/helpers/cli-spawn.ts. */
const LEAK_KEYS = ['NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'TREECONTEXT_CONFIG', 'TREECONTEXT_BINDINGS_FILE', 'TREECONTEXT_PROJECT_DIR', 'XDG_CONFIG_HOME', 'CCR_CONFIG']
/** The bench also scrubs the capture-shaping seams a developer's shell may
 *  carry (the index cap lever, the test clock), so a bench number never
 *  depends on the shell it was run from. */
const BENCH_SCRUB_KEYS = ['TREECONTEXT_INDEX_CAP', 'TREECONTEXT_TEST_NOW']

function defaultHookEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') }
  for (const k of [...LEAK_KEYS, ...BENCH_SCRUB_KEYS]) delete env[k]
  env['TREECONTEXT_BINDINGS_FILE'] = join(home, '.treecontext', 'bindings.json')
  return env
}

const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const defaultHookArgv = (script: string): string[] => ['--import', TSX_LOADER, script]

/** Where the spawned hooks derive the store for `proj` under `home`: the
 *  no-git fallback of bindings.ts deriveName under the stores directory
 *  (the mirror tests/journal/capture-harness.ts keeps). A wrong mirror
 *  cannot pass silently: staging stays empty and the retime throws. */
function derivedStorePath(home: string, proj: string): string {
  const base = (proj.split(/[\\/]/).filter(Boolean).pop() ?? 'unnamed').replace(/[^A-Za-z0-9._-]/g, '-')
  const hash = createHash('sha1').update(`path:${proj}`).digest('hex').slice(0, 6)
  return join(home, '.treecontext', 'stores', `${base}-${hash}`, 'treecontext.db')
}

interface Sandbox { home: string; proj: string; dbPath: string; store: FlatStore; client: Client }

type HookName = 'user-prompt-submit' | 'post-tool-use' | 'stop'

interface PlannedEvent {
  hook: HookName
  payload: Record<string, unknown>
  /** Seconds after the session start this event happened. */
  at: number
  /** Identifies the staged row this event produced. */
  role: 'user' | 'assistant'
  toolName: string | null
  sig: string
  /** The logical key of the row (absent for echoes). */
  key?: string
}

async function spawnAll(sb: Sandbox, events: PlannedEvent[], opts: BuildOptions): Promise<void> {
  const env = (opts.hookEnv ?? defaultHookEnv)(sb.home)
  const argv = opts.hookArgv ?? defaultHookArgv
  let next = 0
  const failures: string[] = []
  const worker = async (): Promise<void> => {
    while (next < events.length) {
      const e = events[next++]!
      const r = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, argv(join(REPO_ROOT, 'src', 'hooks', `${e.hook}.ts`)), { env, cwd: REPO_ROOT })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (d: string) => { stderr += d })
        child.stdout.resume()
        child.on('error', reject)
        child.on('exit', (status) => resolve({ status, stderr }))
        child.stdin.end(JSON.stringify({ cwd: sb.proj, ...e.payload }))
      })
      if (r.status !== 0) failures.push(`${e.hook} exited ${r.status}: ${r.stderr}`)
    }
  }
  await Promise.all(Array.from({ length: MATURE.spawnLimit }, worker))
  if (failures.length > 0) throw new Error(`mature journal: ${failures.length} hook run(s) failed:\n${failures.join('\n')}`)
}

/** Move every staged row of this session to its synthesized moment. Each
 *  planned event must account for exactly one staged row. */
function retimeStaged(dbPath: string, events: PlannedEvent[], start: number): void {
  const raw = new DatabaseSync(dbPath)
  try {
    const rows = raw.prepare('SELECT id, role, tool_name, content FROM staging WHERE processed = 0').all() as Array<{
      id: number; role: string; tool_name: string | null; content: string
    }>
    const set = raw.prepare('UPDATE staging SET timestamp = ? WHERE id = ?')
    const used = new Set<number>()
    for (const e of events) {
      const hits = rows.filter((r) => !used.has(r.id) && r.role === e.role && (r.tool_name ?? null) === e.toolName && r.content.includes(e.sig))
      if (hits.length !== 1) throw new Error(`mature journal: event ${e.toolName ?? e.role} "${e.sig.slice(0, 60)}" staged ${hits.length} rows`)
      used.add(hits[0]!.id)
      set.run(start + e.at, hits[0]!.id)
    }
    if (used.size !== rows.length) throw new Error(`mature journal: ${rows.length - used.size} staged row(s) no planned event accounts for`)
  } finally {
    raw.close()
  }
}

/** The production drain, configured as the serving CLI configures it (the
 *  attribution factory and the store path), run until staging is empty. */
async function drain(sb: Sandbox): Promise<void> {
  const handles = new Map<string, FlatStore>([[sb.store.namespace, sb.store]])
  const extras: FlatStore[] = []
  const storeFor = async (ns: string): Promise<FlatStore> => {
    let h = handles.get(ns)
    if (!h) {
      h = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(sb.dbPath)), ownsDatabase: true, namespace: ns })
      handles.set(ns, h)
      extras.push(h)
    }
    return h
  }
  const loop = new IngestionLoop(sb.store, { batchSize: 50, storeFor, storePath: sb.dbPath })
  try {
    for (let i = 0; i < 200; i++) {
      await loop.ingestBatch()
      if (sb.store.store.countUnprocessedStaging() === 0) break
    }
    const left = sb.store.store.countUnprocessedStaging()
    if (left !== 0) throw new Error(`mature journal: the drain left ${left} staged row(s)`)
  } finally {
    for (const h of extras) await h.close()
  }
}

/** Call a treecontext tool through the real server and return the hook
 *  payload that echoes it (the content array the client received, as
 *  Claude Code hands it to PostToolUse), plus the parsed response. */
async function callEchoed(
  sb: Sandbox, tool: string, input: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; response: Record<string, unknown> }> {
  const res = await sb.client.callTool({ name: tool, arguments: input })
  const content = (res as { content: Array<{ text: string }> }).content
  return {
    payload: {
      transcript_path: join(sb.proj, 'transcript.jsonl'),
      hook_event_name: 'PostToolUse',
      permission_mode: 'default',
      tool_name: `mcp__treecontext__${tool}`,
      tool_input: input,
      tool_response: content,
    },
    response: JSON.parse(content[0]!.text) as Record<string, unknown>,
  }
}

/** A tool response with every text leaf passed through `f`. */
function mutateResponse(response: unknown, f: (s: string) => string): unknown {
  const r = response as Record<string, unknown>
  if (typeof r['stdout'] === 'string') return { ...r, stdout: f(r['stdout']) }
  const file = r['file'] as Record<string, unknown> | undefined
  if (file && typeof file['content'] === 'string') return { ...r, file: { ...file, content: f(file['content']) } }
  if (typeof r['content'] === 'string') return { ...r, content: f(r['content']) }
  return response
}

function responseText(response: unknown): string {
  const r = response as Record<string, unknown>
  if (typeof r['stdout'] === 'string') return r['stdout']
  const file = r['file'] as Record<string, unknown> | undefined
  if (file && typeof file['content'] === 'string') return file['content']
  return typeof r['content'] === 'string' ? r['content'] : ''
}

// ── The build ─────────────────────────────────────────────────────────

const CURATED_KINDS = ['decision', 'finding', 'checkpoint', 'bookmark'] as const

async function buildInto(sb: Sandbox, opts: BuildOptions): Promise<MatureJournal> {
  const g = new Gen(MATURE.seed)
  const m = opts.mutateText ?? ((s: string): string => s)
  const now = Math.floor(Date.now() / 1000)
  const lastDay = MATURE.sessionDays.at(-1)!
  const curatedIds: string[] = []
  const ids: Record<string, string> = {}
  const texts: Record<string, string> = {}
  const kinds: MatureJournal['kinds'] = {}
  let freshPlanId = ''
  let prevCheckpoint: string | null = null

  for (const [k, day] of MATURE.sessionDays.entries()) {
    const t = TOPICS[k]!
    const sessionId = `cc-mature-s${k}`
    // 09:00-ish on the session's day, counted back from now.
    const start = now - (lastDay - day + MATURE.newestDaysAgo) * 86400 + 9 * 3600 - 43200
    const events: PlannedEvent[] = []
    const curatedAt: Array<{ id: string; at: number }> = []
    const echo = (payload: Record<string, unknown>, at: number, sig: string): void => {
      events.push({ hook: 'post-tool-use', payload: { ...payload, session_id: sessionId }, at, role: 'assistant', toolName: String(payload['tool_name']), sig })
    }

    // 1. Session start: status, then the orientation query.
    const status = await callEchoed(sb, 'treecontext_status', {})
    echo(status.payload, 2, 'Tool: mcp__treecontext__treecontext_status\n')
    const orient = await callEchoed(sb, 'treecontext_query', { query: ORIENTATION_QUERY, top_k: 5 })
    echo(orient.payload, 5, 'Tool: mcp__treecontext__treecontext_query\n')

    // 2. Turns.
    for (let turn = 0; turn < MATURE.turnsPerSession; turn++) {
      const base = 60 + turn * 900
      const clean = k === 0 && turn === 0
        ? OLD_THREAD
        : `${g.fill(t, g.pick(PROMPTS))} (${t.name}, turn ${turn + 1})`
      const prompt = m(clean)
      const userKey = `s${k}:user:${turn}`
      texts[userKey] = clean
      kinds[userKey] = { kind: 'user' }
      events.push({
        hook: 'user-prompt-submit', payload: { session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt },
        at: base, role: 'user', toolName: null, sig: prompt, key: userKey,
      })
      for (let i = 0; i < MATURE.shellEventsPerTurn; i++) {
        const s = shellEvent(g, t, k, turn, i)
        const key = `s${k}:shell:${turn}:${i}`
        texts[key] = responseText(s.response)
        kinds[key] = { kind: 'shell', tool: s.toolName }
        events.push({
          hook: 'post-tool-use',
          payload: {
            session_id: sessionId, transcript_path: join(sb.proj, 'transcript.jsonl'), hook_event_name: 'PostToolUse',
            permission_mode: 'default', tool_name: s.toolName, tool_input: s.input,
            tool_response: opts.mutateText ? mutateResponse(s.response, m) : s.response,
          },
          at: base + 20 + i * 60, role: 'assistant', toolName: s.toolName, sig: composeToolText(s.input).slice(0, 120), key,
        })
      }
      // 3. Curated rows, one per turn from the second on, each echoed.
      const curated: Array<{ content: string; metadata: Record<string, unknown>; supersedes?: string[] }> = [
        { content: t.decision, metadata: { type: 'decision' } },
        { content: t.finding, metadata: { type: 'finding' } },
        {
          content: t.checkpoint,
          metadata: k === MATURE.sessionDays.length - 1 ? { type: 'plan', status: 'active', next_session: true } : { type: 'checkpoint', next_session: true },
          ...(prevCheckpoint ? { supersedes: [prevCheckpoint] } : {}),
        },
        { content: t.bookmark, metadata: { kind: 'bookmark', next_session: true } },
      ]
      if (turn >= 1) {
        const c = curated[turn - 1]!
        const input: Record<string, unknown> = { content: m(c.content), metadata: c.metadata, ...(c.supersedes ? { supersedes: c.supersedes } : {}) }
        const ins = await callEchoed(sb, 'treecontext_insert', input)
        const id = String(ins.response['node_id'])
        const at = base + 20 + MATURE.shellEventsPerTurn * 60 + 30
        const key = `s${k}:${CURATED_KINDS[turn - 1]!}`
        ids[key] = id
        texts[key] = c.content
        kinds[key] = { kind: CURATED_KINDS[turn - 1]! }
        curatedIds.push(id)
        curatedAt.push({ id, at })
        echo(ins.payload, at + 1, composeToolText(input).slice(0, 120))
        if (turn === 3) prevCheckpoint = id
        if (turn === 3 && k === MATURE.sessionDays.length - 1) freshPlanId = id
      }
      const saidClean = `${g.fill(t, g.pick(SAID))} (s${k}t${turn})`
      const said = m(saidClean)
      const saidKey = `s${k}:said:${turn}`
      texts[saidKey] = saidClean
      kinds[saidKey] = { kind: 'said' }
      events.push({
        hook: 'stop',
        payload: {
          session_id: sessionId, transcript_path: join(sb.proj, 'transcript.jsonl'), hook_event_name: 'Stop',
          stop_hook_active: false, permission_mode: 'default', last_assistant_message: said,
        },
        at: base + 20 + MATURE.shellEventsPerTurn * 60 + 120, role: 'assistant', toolName: null, sig: said, key: saidKey,
      })
    }

    // The curated rows' honest moments, before the drain heals from their echoes.
    const raw = new DatabaseSync(sb.dbPath)
    try {
      const set = raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?')
      for (const c of curatedAt) set.run(start + c.at, c.id)
    } finally {
      raw.close()
    }
    await spawnAll(sb, events, opts)
    retimeStaged(sb.dbPath, events, start)
    await drain(sb)
    resolveCapturedIds(sb, sessionId, events, ids)
  }

  const raw = new DatabaseSync(sb.dbPath, { readOnly: true })
  let counts: MatureJournal['counts']
  let shellOnlyId = ''
  const indexed: Record<string, string> = {}
  try {
    const one = (sql: string): number => Number((raw.prepare(sql).get() as { c: number }).c)
    const TOOL = "json_extract(metadata_json, '$.source') = 'auto-capture' AND json_extract(metadata_json, '$.tool_name') IS NOT NULL"
    const CURATED = "COALESCE(json_extract(metadata_json, '$.source'), '') != 'auto-capture'"
    counts = {
      toolRows: one(`SELECT COUNT(*) AS c FROM nodes WHERE ${TOOL}`),
      curatedRows: one(`SELECT COUNT(*) AS c FROM nodes WHERE ${CURATED}`),
      toolBytes: one(`SELECT SUM(LENGTH(CAST(content AS BLOB))) AS c FROM nodes WHERE ${TOOL}`),
      curatedBytes: one(`SELECT SUM(LENGTH(CAST(content AS BLOB))) AS c FROM nodes WHERE ${CURATED}`),
      queryEchoes: one("SELECT COUNT(*) AS c FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'mcp__treecontext__treecontext_query'"),
      rows: one('SELECT COUNT(*) AS c FROM nodes'),
      developerRows: one("SELECT COUNT(*) AS c FROM nodes WHERE json_extract(metadata_json, '$.source') = 'auto-capture' AND json_extract(metadata_json, '$.role') = 'user' AND json_extract(metadata_json, '$.tool_name') IS NULL"),
      assistantRows: one("SELECT COUNT(*) AS c FROM nodes WHERE json_extract(metadata_json, '$.source') = 'auto-capture' AND json_extract(metadata_json, '$.role') = 'assistant' AND json_extract(metadata_json, '$.tool_name') IS NULL"),
    }
    const shellIds = (raw.prepare("SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'Bash'").all() as Array<{ node_id: string }>)
      .map((r) => r.node_id).filter((id) => (sb.store.store.getContent(id) ?? '').includes(SHELL_ONLY_TERM))
    if (shellIds.length === 1) shellOnlyId = shellIds[0]!
    const byId = raw.prepare('SELECT content, metadata_json, index_len, preview_len FROM nodes WHERE node_id = ?')
    for (const [key, k] of Object.entries(kinds)) {
      if (k.kind !== 'shell' || !ids[key]) continue
      const r = byId.get(ids[key]) as { content: string | Buffer | null; metadata_json: string | null; index_len: number | null; preview_len: number | null } | undefined
      if (!r) continue
      const meta = applyLiftedBoundaries(JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>, r.index_len, r.preview_len)
      indexed[key] = indexTextFor(decodeContent(r.content), meta)
    }
  } finally {
    raw.close()
  }
  return { oldThreadId: ids['s0:user:0'] ?? '', freshPlanId, curatedIds, shellOnlyId, counts, ids, texts, kinds, indexed }
}

/** After a session drains, find each captured planned row's node: same
 *  session, role and tool, content carrying the event's signature. Each
 *  must be exactly one row. */
function resolveCapturedIds(sb: Sandbox, sessionId: string, events: PlannedEvent[], ids: Record<string, string>): void {
  const raw = new DatabaseSync(sb.dbPath, { readOnly: true })
  try {
    const rows = (raw.prepare(
      "SELECT node_id, content, json_extract(metadata_json, '$.role') AS role, json_extract(metadata_json, '$.tool_name') AS tool " +
        "FROM nodes WHERE json_extract(metadata_json, '$.session_id') = ? AND json_extract(metadata_json, '$.source') = 'auto-capture'",
    ).all(sessionId) as Array<{ node_id: string; content: string | Buffer | null; role: string | null; tool: string | null }>)
      .map((r) => ({ id: r.node_id, content: decodeContent(r.content), role: r.role, tool: r.tool }))
    const used = new Set<string>()
    for (const e of events) {
      if (!e.key) continue
      const hits = rows.filter((r) => !used.has(r.id) && r.role === e.role && (r.tool ?? null) === e.toolName && r.content.includes(e.sig))
      if (hits.length !== 1) throw new Error(`mature journal: ${e.key} matched ${hits.length} captured rows`)
      used.add(hits[0]!.id)
      ids[e.key] = hits[0]!.id
    }
  } finally {
    raw.close()
  }
}

async function openSandbox(cleanups: Array<() => void | Promise<void>>): Promise<Sandbox> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-mature-home-')))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-mature-proj-')))
  cleanups.push(() => rmSync(proj, { recursive: true, force: true }))
  // Pin project-root discovery to the temp dir itself (an empty .git is
  // not a valid repo, so identity stays path-based and deterministic).
  mkdirSync(join(proj, '.git'))
  const dbPath = derivedStorePath(home, proj)
  mkdirSync(dirname(dbPath), { recursive: true })
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), ownsDatabase: true })
  cleanups.push(() => store.close())
  const server = createServer(store, { claudeCwd: proj, info: { storePath: dbPath } })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mature-journal', version: '0' })
  await server.connect(st)
  await client.connect(ct)
  cleanups.push(async () => { await client.close(); await server.close() })
  return { home, proj, dbPath, store, client }
}

/**
 * Build one mature journal into `file`: through the sandboxed pipeline,
 * then a clean close (client, server, store) and the WAL folded into the
 * file, so a plain copy of `file` carries every row with its rowid.
 */
export async function buildMatureJournal(file: string, opts: BuildOptions = {}): Promise<MatureJournal> {
  const cleanups: Array<() => void | Promise<void>> = []
  let removals: Array<() => void | Promise<void>> = []
  try {
    const sb = await openSandbox(cleanups)
    const journal = await buildInto(sb, opts)
    removals = cleanups.splice(0, 2) // the sandbox home and project removals
    for (const fn of cleanups.splice(0).reverse()) await fn()
    const raw = new DatabaseSync(sb.dbPath)
    pragmaRows(raw, 'wal_checkpoint(TRUNCATE)')
    raw.close()
    copyFileSync(sb.dbPath, file)
    return journal
  } finally {
    for (const fn of cleanups.reverse()) await fn()
    for (const fn of removals) await fn()
  }
}

// ── Built once per process, copied per use ────────────────────────────

let template: Promise<{ file: string; journal: MatureJournal }> | null = null

/** The per-process template: the clean (unmutated) mature journal, built
 *  on first call with `opts`, then shared. Copy `file` before writing to it. */
export function matureTemplate(opts: Omit<BuildOptions, 'mutateText'> = {}): Promise<{ file: string; journal: MatureJournal }> {
  template ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-mature-template-'))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'mature.db')
    const journal = await buildMatureJournal(file, opts)
    return { file, journal }
  })()
  return template
}

/** A fresh private name for a one-off build (the bench's mutated builds). */
export function scratchFile(prefix = 'tc-mature-'): { file: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { file: join(dir, `${randomBytes(4).toString('hex')}.db`), remove: () => rmSync(dir, { recursive: true, force: true }) }
}
