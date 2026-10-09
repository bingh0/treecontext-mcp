import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { type Client } from '@modelcontextprotocol/client'
import { FlatStore } from '../../../src/flat-store.js'
import { writeSessionBeacon } from '../../../src/session-beacon.js'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { mcpOver, parseTool, rawAll } from '../world.js'
import { spawnCli } from '../../helpers/cli-spawn.js'
import { type CaptureWorld, openCaptureSandbox, runHook, hookJson, writeTranscript } from '../capture-harness.js'

// ── journal-handoff ─────────────────────────────────────────────────────
//
// The beta.1 set (D197): the import rule. Two developers, two machines,
// two stores — each its own SQLite file in its own directory. A's file is
// what A's own server exports through the real treecontext_export tool,
// written to A's repository as a teammate would commit it; B reads that
// file and imports it through B's own server's treecontext_import tool,
// the door the handshake teaches. Every Then reads B's store directly
// (a separate readonly SQLite handle) or the production surface B sees:
// the import's reply, search and status over MCP, and — for the packet —
// the real session-start hook run as a subprocess on a /clear.
//
// The beta.2 set (D170, D172, D177, D199): the file-bound door. A's file
// is what A's own server WRITES through treecontext_export with a path —
// the agent's door — into A's repository, the project directory the
// server was started for; B's import reads it through treecontext_import
// with a path into B's own project directory, where B's pull put it. The
// shell door runs the real CLI as a subprocess against the same store.
// Every Then reads the file off the disk or the store off its SQLite file.
//
// The file's head (D172) says who exported it (`exported_by`, the
// exporting machine's `<user>@<host>`), when, from which project, which
// treecontext version wrote it, what it holds and the one step that
// imports it; on import every head field is the file's claim. (Both
// "machines" run as this test's own user on this host, so the sender A's
// file names is that pair; what is bound is that the packet names exactly
// what A's file claims, and marks it as a claim.)

export interface HandoffWorld extends CaptureWorld {
  /** Developer A's machine: a store of A's own and A's server over it. */
  aDir?: string
  aStore?: FlatStore
  aClient?: Client
  aSession?: string
  /** The handoff file as committed, and its name in the repository. */
  filePath?: string
  fileName?: string
  /** The file's entries as A's export wrote them. */
  fileNodes?: Array<Record<string, unknown>>
  /** B's server. */
  bClient?: Client
  /** Every import reply B was given, in order. */
  replies?: Array<Record<string, unknown>>
  /** Whatever an import call threw or flagged, for "does not fail". */
  importFailure?: string
  /** B's own rows before the import, for "unchanged". */
  bSnapshot?: Array<Record<string, unknown>>
  /** Ids and texts the Thens name. */
  aChapterId?: string
  aChapterText?: string
  aChapterAt?: number
  bChapterId?: string
  bChapterText?: string
  /** The packet the session-start hook emitted on the /clear. */
  packet?: string
  /** A's repository: the project directory A's server was started for. */
  aRepo?: string
  /** The path the developer asked for, as the agent passes it. */
  askedPath?: string
  /** Export replies, in order, and whether the file existed after each. */
  exportReplies?: Array<{ res: { isError?: boolean; content?: Array<{ text?: string }> }; fileAfter: boolean }>
  /** Contents the Thens name. */
  bookmarkText?: string
  testerText?: string
  /** The file as B read it off the disk. */
  openedText?: string
  /** The shell door's run, its file's bytes, and its time window. */
  cliRun?: { status: number | null; stdout: string; stderr: string }
  cliBytes?: string
  cliWindow?: [number, number]
}

const now = (): number => Date.now() / 1000

/** What A's machine calls itself in the head of the file it exports. */
const SENDER = `${userInfo().username}@${hostname()}`

// ── Two machines ────────────────────────────────────────────────────────

/** Developer A's machine: its own directory, store and server, and A's
 *  repository — two levels down, so a path that climbs out of it still
 *  lands inside this test's own directory. */
async function openA(w: HandoffWorld, project = 'hackathon-app'): Promise<void> {
  w.aDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-handoff-a-')))
  w.defer(() => rmSync(w.aDir!, { recursive: true, force: true }))
  w.aRepo = join(w.aDir, 'work', project)
  mkdirSync(w.aRepo, { recursive: true })
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(join(w.aDir, 'treecontext.db'))),
    ownsDatabase: true,
    retentionInterval: 1_000_000_000,
  })
  w.defer(() => store.close())
  w.aStore = store
  w.aSession = `cc-a-${randomBytes(6).toString('hex')}`
  w.aClient = await mcpOver(w, { ccSessionId: w.aSession, projectDir: w.aRepo }, store)
}

/** Developer B's machine: the capture sandbox the hooks resolve, B's
 *  store at its derived path, B's session beacon, and B's server. */
async function openB(w: HandoffWorld): Promise<void> {
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
    ownsDatabase: true,
    retentionInterval: 1_000_000_000,
  })
  w.defer(() => store.close())
  w.store = store
  writeSessionBeacon(w.dbPath!, process.pid, w.sessionId!, w.proj!, { rewrite: true })
  w.bClient = await mcpOver(w, { ccSessionId: w.sessionId!, projectDir: w.proj! }, store)
}

/** A chapter summary written through a server's real insert tool. */
async function chapter(client: Client, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = parseTool(await client.callTool({
    name: 'treecontext_insert', arguments: { content: text, metadata: { next_session: true, ...extra } },
  }))
  return res['node_id'] as string
}

/** A's clock wrote this moment: the row's created_at, set in A's file. */
function dateInA(w: HandoffWorld, nodeId: string, at: number): void {
  const raw = new BetterSqlite3(join(w.aDir!, 'treecontext.db'))
  try { raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(at, nodeId) } finally { raw.close() }
}

type ToolRes = { isError?: boolean; content?: Array<{ text?: string }> }

/** One export call through A's server, and whether the file at `path`
 *  existed when the reply came back. */
async function exportCall(w: HandoffWorld, args: Record<string, unknown>, client: Client = w.aClient!): Promise<ToolRes> {
  const res = await client.callTool({ name: 'treecontext_export', arguments: args }) as ToolRes
  const path = typeof args['path'] === 'string' ? resolve(w.aRepo!, args['path']) : null
  w.exportReplies = [...(w.exportReplies ?? []), { res, fileAfter: path !== null && existsSync(path) }]
  return res
}

/** The whole journal, as a developer chooses it: the first call is
 *  answered with the secrets warning and writes nothing; the second,
 *  acknowledging it, exports. */
async function exportWhole(w: HandoffWorld, extra: Record<string, unknown>, client: Client = w.aClient!): Promise<ToolRes> {
  const warned = await exportCall(w, { form: 'whole', ...extra }, client)
  expect(warned.isError, warned.content?.[0]?.text).toBeFalsy()
  return exportCall(w, { form: 'whole', secrets_acknowledged: true, ...extra }, client)
}

/** A has their agent write the whole journal to a file in A's repository
 *  through A's own server — the server writes it — and commits it; `edit`
 *  is a hand edit made before the commit. */
async function exportFromA(
  w: HandoffWorld, client: Client = w.aClient!,
  edit: ((file: Record<string, unknown>) => void) | null = null,
): Promise<void> {
  w.fileName = 'handoffs/login-plan.json'
  w.filePath = join(w.aRepo!, w.fileName)
  const res = await exportWhole(w, { path: w.fileName }, client)
  expect(res.isError, res.content?.[0]?.text).toBeFalsy()
  const file = JSON.parse(readFileSync(w.filePath, 'utf8')) as Record<string, unknown> & { nodes: Array<Record<string, unknown>> }
  // The head the real export wrote: who exported it, as that machine
  // describes itself.
  expect(file['exported_by']).toBe(SENDER)
  if (edit) {
    edit(file)
    writeFileSync(w.filePath, JSON.stringify(file, null, 2))
  }
  w.fileNodes = file.nodes
}

/** B pulls the file into B's own repository and has B's agent import it
 *  by path through B's server's tool — the server reads the file. */
async function importOnB(w: HandoffWorld): Promise<Record<string, unknown>> {
  const pulled = join(w.proj!, w.fileName!)
  if (resolve(pulled) !== resolve(w.filePath!)) {
    mkdirSync(dirname(pulled), { recursive: true })
    copyFileSync(w.filePath!, pulled)
  }
  const res = await w.bClient!.callTool({ name: 'treecontext_import', arguments: { path: w.fileName! } }) as ToolRes
  if (res.isError) {
    w.importFailure = res.content?.[0]?.text ?? 'import failed'
    throw new Error(w.importFailure)
  }
  const reply = parseTool(res)
  w.replies = [...(w.replies ?? []), reply]
  return reply
}

/** "B is told": the reply's counts and the sentence it says them in. */
function expectTold(reply: Record<string, unknown>, landed: number, present: number): void {
  expect(reply['landed']).toBe(landed)
  expect(reply['already_present']).toBe(present)
  const entries = landed === 1 ? 'entry' : 'entries'
  expect(String(reply['message'])).toContain(`${landed} ${entries} landed; ${present} ${present === 1 ? 'was' : 'were'} already present.`)
}

type Row = { node_id: string; created_at: number; session_key: string | null; metadata_json: string | null; content: Buffer | string | null }
const meta = (r: Row): Record<string, unknown> => JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>
const text = (r: Row): string => decodeContent(r.content)

/** B's rows a handoff import marked, read straight off B's SQLite file. */
function importedRows(w: HandoffWorld): Row[] {
  return rawAll<Row>(w,
    "SELECT node_id, created_at, session_key, metadata_json, content FROM nodes WHERE json_extract(metadata_json, '$._handoff_file') IS NOT NULL")
}

/** B searching, as B's agent does. */
async function searchOnB(w: HandoffWorld, q: string): Promise<Array<{ nodeId: string; content: string; createdAt: number; metadata: Record<string, unknown> }>> {
  const res = parseTool(await w.bClient!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 10 } }))
  return res['results'] as Array<{ nodeId: string; content: string; createdAt: number; metadata: Record<string, unknown> }>
}

/** "Marked as A's own writing": any claim a store reader would take as
 *  fact — a top-level identity, provenance, pointer or bookkeeping key, or
 *  a lane. The importer's own marks (`_handoff_file`, `_handoff_importer`,
 *  `_handoff_imported_at`, `_handoff_sender` as the named claim) and the
 *  claims key are allowed. */
const IMPORTER_KEYS = new Set(['_handoff_file', '_handoff_importer', '_handoff_imported_at', '_handoff_sender', '_handoff_claims'])
const CLAIM_KEYS = ['_writer', 'author', 'agent_type', 'agent_id', '_session_id', '_namespace',
  '_merge_label', '_merged_from_node_id', '_merge_source_store', 'supersedes', 'superseded_by', 'superseded_at',
  'next_session', 'status']
function claimsAsOwn(m: Record<string, unknown>, sessionKey: string | null, aClaims: string[]): string[] {
  const found: string[] = []
  for (const k of Object.keys(m)) {
    if (CLAIM_KEYS.includes(k) || k.startsWith('_cc_session') || k.startsWith('_relied')
      || (k.startsWith('_handoff_') && !IMPORTER_KEYS.has(k))) found.push(`${k}=${JSON.stringify(m[k])}`)
  }
  if (typeof m['session_id'] === 'string' && !String(m['session_id']).startsWith('handoff:')) found.push(`session_id=${String(m['session_id'])}`)
  if (sessionKey !== null && (aClaims.includes(sessionKey) || !sessionKey.startsWith('handoff:'))) found.push(`session_key=${sessionKey}`)
  return found
}

/** A real /clear (D216): a new session id, SessionStart "clear" under it,
 *  the beacon still naming the session the clear ends. */
function clearOnB(w: HandoffWorld): string {
  writeTranscript(w, 'the turn before the clear')
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  const run = runHook(w, 'session-start', {
    hook_event_name: 'SessionStart', source: 'clear', transcript_path: join(w.proj!, 'transcript.jsonl'),
  })
  const out = hookJson(run.stdout)
  w.packet = String((out?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
  return w.packet
}

// ── The file-bound door (D170, D172, D177, D199) ────────────────────────

/** A's journal, filled through the library: captured tool output (four in
 *  five, the Bash outputs a day of work leaves) and A's own notes, one
 *  second apart so "newest" is unambiguous. */
async function fillA(w: HandoffWorld, n: number, at0: number = now() - 86400): Promise<void> {
  for (let i = 0; i < n; i++) {
    const note = i % 5 === 0
    await w.aStore!.insert(
      note ? `A's note ${i}: the login form posts to /session` : `A's capture ${i}: npm test run ${i} — 41 passed`,
      { metadata: note ? { _cc_session_id: w.aSession } : { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: w.aSession }, createdAt: at0 + i },
    )
  }
}

/** A's lane, read straight off A's SQLite file. */
function aRows(w: HandoffWorld, sql = 'SELECT node_id, content FROM nodes ORDER BY created_at ASC, node_id ASC'): Array<{ node_id: string; content: Buffer | string | null }> {
  const raw = new BetterSqlite3(join(w.aDir!, 'treecontext.db'), { readonly: true })
  try { return raw.prepare(sql).all() as Array<{ node_id: string; content: Buffer | string | null }> } finally { raw.close() }
}

/** The file A commits, off A's disk. */
function committed(w: HandoffWorld, rel: string = w.askedPath ?? 'handoffs/login-plan.json'): Record<string, unknown> & { nodes: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(w.aRepo!, rel), 'utf8')) as Record<string, unknown> & { nodes: Array<Record<string, unknown>> }
}

const lastExport = (w: HandoffWorld): ToolRes => w.exportReplies!.at(-1)!.res
const replyText = (r: ToolRes): string => r.content?.map((c) => c.text ?? '').join('\n') ?? ''

/** "Only the file's name and the counts": the reply's every field is the
 *  file's name, the count, or the sentence saying those two — and no
 *  entry's content appears in it. */
function expectNameAndCountsOnly(w: HandoffWorld, rel: string, n: number): void {
  const res = lastExport(w)
  expect(res.isError, replyText(res)).toBeFalsy()
  const reply = parseTool(res)
  expect(Object.keys(reply).sort()).toEqual(['entries', 'file', 'message'])
  expect(reply['file']).toBe(rel)
  expect(reply['entries']).toBe(n)
  expect(reply['message']).toBe(`Wrote ${n} ${n === 1 ? 'entry' : 'entries'} to ${rel}.`)
  const said = replyText(res)
  expect(said.length).toBeLessThan(300)
  for (const r of aRows(w)) expect(said.includes(text(r as Row)), `the reply carried an entry's content`).toBe(false)
}

/** Every entry of A's lane is in the file, by id and content. */
function expectFileHoldsLane(w: HandoffWorld, file: { nodes: Array<Record<string, unknown>> }, n: number): void {
  const rows = aRows(w)
  expect(rows).toHaveLength(n)
  expect(file.nodes).toHaveLength(n)
  expect(file.nodes.map((x) => x['nodeId'])).toEqual(rows.map((r) => r.node_id))
  expect(file.nodes.map((x) => x['content'])).toEqual(rows.map((r) => text(r as Row)))
}

const PKG_VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version

const utc = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(0, 16)}Z`

export const handoffDefiner = (reg: Registry<HandoffWorld>): void => {
  // ── an imported summary is marked and counted (D151) ──
  reg.define(/^a handoff file from developer A holding the chapter summary "([^"]+)", written by A at (\d\d):(\d\d) universal time$/, async (w, text$, hh$, mm$) => {
    await openA(w)
    w.aChapterText = String(text$)
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    // Yesterday at 14:02 UTC by A's clock.
    const d = new Date()
    w.aChapterAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, Number(hh$), Number(mm$)) / 1000
    dateInA(w, w.aChapterId, w.aChapterAt)
    await exportFromA(w)
    expect(w.fileNodes!.map((n) => n['content'])).toEqual([w.aChapterText])
  })
  reg.define(/^(?:developer )?B imports it(?: on their machine)?$/, async (w) => {
    if (!w.bClient) await openB(w)
    await importOnB(w)
  })
  reg.define(/^B searching "([^"]+)" finds that summary marked as imported from that file by B, with A's time of (\d\d:\d\d)$/, async (w, q$, hhmm$) => {
    const hits = await searchOnB(w, String(q$))
    const hit = hits.find((h) => h.content === w.aChapterText)
    expect(hit, `B's search for "${String(q$)}" did not find A's summary`).toBeTruthy()
    expect(hit!.metadata['_handoff_file']).toBe(w.fileName)
    expect(hit!.metadata['_handoff_importer']).toBe(w.sessionId)
    expect(new Date(hit!.createdAt * 1000).toISOString().slice(11, 16)).toBe(String(hhmm$))
    // The same off B's SQLite file: A's moment kept, the importer's marks
    // on the row, and the drain's own clock nowhere in created_at.
    const [row] = rawAll<Row>(w, 'SELECT node_id, created_at, session_key, metadata_json, content FROM nodes WHERE node_id = ?', hit!.nodeId)
    expect(row!.created_at).toBe(w.aChapterAt)
    expect(meta(row!)['_handoff_file']).toBe(w.fileName)
    expect(meta(row!)['_handoff_importer']).toBe(w.sessionId)
    expect(meta(row!)['_handoff_sender']).toBe(SENDER)
    expect(Number(meta(row!)['_handoff_imported_at'])).toBeGreaterThan(w.aChapterAt!)
  })
  reg.define(/^B is told that (\d+) (?:entry |entries )?landed and (\d+) were already present$/, (w, landed$, present$) => {
    expectTold(w.replies!.at(-1)!, Number(landed$), Number(present$))
  })

  // ── a whole journal twice lands once (D164) ──
  reg.define(/^developer B's store holding (\d+) entries of their own$/, async (w, n$) => {
    await openB(w)
    const n = Number(n$)
    for (let i = 0; i < n; i++) {
      const auto = i % 5 !== 0
      await w.store!.insert(
        // B's notes read word for word like findings A also wrote: two
        // developers on one project reach the same sentence. Each is still
        // two entries, one per writer (D164: identity, not content, where
        // the file carries ids).
        auto ? `B's own capture ${i}: vitest run ${i} passed` : `finding ${i / 5}: the CSRF token rotates per form`,
        { metadata: auto ? { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: w.sessionId } : { _cc_session_id: w.sessionId }, createdAt: now() - 7200 + i },
      )
    }
    w.bSnapshot = rawAll<Record<string, unknown>>(w, 'SELECT * FROM nodes ORDER BY node_id')
    expect(w.bSnapshot).toHaveLength(n)
  })
  reg.define(/^a handoff file from developer A holding (\d+) entries$/, async (w, n$) => {
    await openA(w)
    const n = Number(n$)
    // A's whole journal: captures across sessions — some of them second
    // observations of the same output in the same session, further apart
    // than the dedup window, which content alone cannot tell from repeats
    // (D164's note) — and A's curated notes.
    for (let i = 0; i < n; i++) {
      const session = `cc-a-${i % 4}`
      const curated = i % 10 === 0
      const repeat = !curated && i % 7 === 0
      await w.aStore!.insert(
        curated ? `finding ${i / 10}: the CSRF token rotates per form` : repeat ? `A's capture: npm test passed (session ${session})` : `A's capture ${i}: built the login form step ${i}`,
        { metadata: curated ? { _cc_session_id: session } : { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: session }, createdAt: now() - 86400 + i * 60 },
      )
    }
    await exportFromA(w)
    expect(w.fileNodes).toHaveLength(n)
  })
  reg.define(/^B imports the file, then imports the same file again$/, async (w) => {
    await importOnB(w)
    await importOnB(w)
  })
  reg.define(/^after the (first|second) import B is told that (\d+) landed and (\d+) were already present$/, (w, which$, landed$, present$) => {
    expectTold(w.replies![which$ === 'first' ? 0 : 1]!, Number(landed$), Number(present$))
    // Direct inspection: the file landed exactly once, every entry of it.
    const rows = importedRows(w)
    expect(rows).toHaveLength(w.fileNodes!.length)
    expect(new Set(rows.map((r) => r.node_id))).toEqual(new Set(w.fileNodes!.map((n) => n['nodeId'])))
  })
  reg.define(/^B's own (\d+) entries are unchanged$/, (w, n$) => {
    const ids = w.bSnapshot!.map((r) => r['node_id'])
    expect(ids).toHaveLength(Number(n$))
    const after = rawAll<Record<string, unknown>>(w,
      `SELECT * FROM nodes WHERE node_id IN (${ids.map(() => '?').join(',')}) ORDER BY node_id`, ...ids)
    expect(after).toEqual(w.bSnapshot)
  })

  // ── a file born in this store (D164, the 2026-10-05 crash) ──
  reg.define(/^a file exported from a lane of developer B's own store, holding (\d+) entries$/, async (w, n$) => {
    await openB(w)
    // The tester subagent's lane: a namespace of B's own store, on B's
    // own SQLite file, exported through a server over that lane.
    const lane = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
      ownsDatabase: true, namespace: 'tester', retentionInterval: 1_000_000_000,
    })
    w.defer(() => lane.close())
    for (let i = 0; i < Number(n$); i++) {
      await lane.insert(`tester's entry ${i}: 12 tests pass, CSRF fails at step ${i}`, {
        metadata: i % 2 ? { _cc_session_id: 'cc-tester' } : { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: 'cc-tester' },
        createdAt: now() - 3600 + i,
      })
    }
    // The lane's server serves B's own project: the file lands in B's
    // own repository.
    w.aRepo = w.proj!
    const laneClient = await mcpOver(w, { ccSessionId: 'cc-tester', projectDir: w.proj! }, lane)
    await exportFromA(w, laneClient)
    expect(w.fileNodes).toHaveLength(Number(n$))
    w.bSnapshot = rawAll<Record<string, unknown>>(w, 'SELECT * FROM nodes ORDER BY node_id')
  })
  reg.define(/^B imports that file into the same store$/, async (w) => {
    try {
      await importOnB(w)
    } catch (e) {
      w.importFailure = w.importFailure ?? String(e)
    }
  })
  reg.define(/^the import does not fail$/, (w) => {
    expect(w.importFailure).toBeUndefined()
    expect(w.replies).toHaveLength(1)
    // And nothing moved: the store is byte-for-byte the store it was.
    expect(rawAll<Record<string, unknown>>(w, 'SELECT * FROM nodes ORDER BY node_id')).toEqual(w.bSnapshot)
  })

  // ── the file's claims are data, not identity (D165) ──
  reg.define(/^a handoff file whose entries claim to be developer A's chapter summaries, edited by hand before it was committed$/, async (w) => {
    await openA(w)
    await openB(w)
    for (const t of ['plan: wire the login form; next: write its tests', 'plan: rotate the CSRF token; next: the form tests']) {
      await chapter(w.aClient!, t)
    }
    // The hand edit: every entry now claims a writer, an author, and —
    // the dangerous one — B's own session, as if to join B's self.
    await exportFromA(w, w.aClient!, (file) => {
      for (const n of file['nodes'] as Array<Record<string, unknown>>) {
        n['metadata'] = {
          ...(n['metadata'] as Record<string, unknown>),
          _writer: 'developer A', author: 'developer A', agent_type: 'developer A', agent_id: 'developer A',
          _cc_session_id: w.sessionId, session_id: w.sessionId, _session_id: w.sessionId,
          _cc_session_src: 'explicit', _cc_session_candidates: [w.sessionId], _relied_count: 99,
          _namespace: 'developer-a', _merge_label: 'developer A', _merged_from_node_id: 'f'.repeat(32),
          _handoff_file: 'a-forged-earlier-handoff.json', _handoff_importer: w.sessionId,
          status: 'active',
        }
        // And the row's own columns, as the file states them.
        Object.assign(n, { readOnly: false, decayExempt: true, utilityScore: 0.99, sourceLabel: 'developer A' })
      }
    })
  })
  reg.define(/^every entry B sees is marked as imported from that file by B$/, async (w) => {
    const rows = importedRows(w)
    expect(rows).toHaveLength(w.fileNodes!.length)
    for (const r of rows) {
      expect(meta(r)['_handoff_file']).toBe(w.fileName)
      expect(meta(r)['_handoff_importer']).toBe(w.sessionId)
    }
    // As B's agent sees them through search, too.
    const hits = (await searchOnB(w, 'plan')).filter((h) => w.fileNodes!.some((n) => n['content'] === h.content))
    expect(hits).toHaveLength(w.fileNodes!.length)
    for (const h of hits) expect(h.metadata['_handoff_file']).toBe(w.fileName)
  })
  reg.define(/^no entry B sees is marked as A's own writing$/, async (w) => {
    const aClaims = ['developer A', w.aSession!, w.sessionId!]
    for (const r of importedRows(w)) {
      expect(claimsAsOwn(meta(r), r.session_key, aClaims), `entry ${r.node_id} carries a claim as identity`).toEqual([])
      expect(r.session_key).toMatch(/^handoff:/)
      expect(meta(r)['_handoff_file']).toBe(w.fileName) // not the forged earlier file
    }
    // The row's own columns are the importer's, whatever the file stated.
    const cols = rawAll<{ read_only: number; decay_exempt: number; utility_score: number; source_label: string | null }>(w,
      "SELECT read_only, decay_exempt, utility_score, source_label FROM nodes WHERE json_extract(metadata_json, '$._handoff_file') IS NOT NULL")
    for (const c of cols) expect(c).toEqual({ read_only: 1, decay_exempt: 0, utility_score: 0.5, source_label: null })
    for (const h of await searchOnB(w, 'plan')) {
      expect(claimsAsOwn(h.metadata, null, ['developer A'])).toEqual([])
    }
    // Nor did any become one of B's resume pointers (D206).
    const panel = parseTool(await w.bClient!.callTool({ name: 'treecontext_status', arguments: {} }))
    expect(panel['resume_pointers'] ?? []).toEqual([])
  })
  reg.define(/^the file's claims are kept on each entry as data$/, (w) => {
    const byContent = new Map(importedRows(w).map((r) => [text(r), meta(r)]))
    for (const n of w.fileNodes!) {
      const m = byContent.get(String(n['content']))
      expect(m, `file entry "${String(n['content'])}" did not land`).toBeTruthy()
      expect(m!['_handoff_claims']).toEqual(n['metadata'])
    }
  })

  // ── a claimed supersession lands as a reference (D165) ──
  reg.define(/^a handoff file holding an entry that supersedes developer B's own chapter summary by id$/, async (w) => {
    await openB(w)
    w.bChapterText = 'plan: wire the session store; next: the beacon tests'
    w.bChapterId = await chapter(w.bClient!, w.bChapterText)
    await openA(w)
    w.aChapterText = 'plan: the login form replaces the session-store plan'
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    await exportFromA(w, w.aClient!, (file) => {
      const n = (file['nodes'] as Array<Record<string, unknown>>)[0]!
      n['metadata'] = { ...(n['metadata'] as Record<string, unknown>), supersedes: [w.bChapterId] }
    })
  })
  reg.define(/^B calling status still sees that chapter summary as a live pointer$/, async (w) => {
    const panel = parseTool(await w.bClient!.callTool({ name: 'treecontext_status', arguments: {} }))
    const live = (panel['resume_pointers'] as Array<{ node_id: string; kind: string }>).find((p) => p.node_id === w.bChapterId)
    expect(live, "B's chapter is no longer a live pointer").toBeTruthy()
    expect(live!.kind).toBe('chapter summary')
    const [row] = rawAll<Row>(w, 'SELECT node_id, created_at, session_key, metadata_json, content FROM nodes WHERE node_id = ?', w.bChapterId)
    expect(meta(row!)['next_session']).toBe(true)
    expect(meta(row!)['superseded_by']).toBeUndefined()
  })
  reg.define(/^the entry lands carrying the chapter's id as a reference, not as a supersession$/, (w) => {
    const [row] = importedRows(w).filter((r) => text(r) === w.aChapterText)
    expect(row, "A's entry did not land").toBeTruthy()
    const m = meta(row!)
    expect(m['refs']).toEqual([w.bChapterId])
    expect(m['supersedes']).toBeUndefined()
    expect((m['_handoff_claims'] as Record<string, unknown>)['supersedes']).toEqual([w.bChapterId])
    // Nothing anywhere in B's store names it as having superseded anything.
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.superseded_by') IS NOT NULL")).toHaveLength(0)
  })

  // ── the packet announces a handoff, skew disclosed (D206, D184) ──
  reg.define(/^a handoff file from developer A holding (\d+) entries whose newest chapter summary is timestamped (\d+) hours in developer B's future$/, async (w, n$, h$) => {
    // B's session as it stands: B's own chapter summary, an hour old.
    await openB(w)
    w.bChapterText = 'plan: wire the session store; next: the beacon tests'
    w.bChapterId = await chapter(w.bClient!, w.bChapterText)
    const raw = new BetterSqlite3(w.dbPath!)
    try { raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(now() - 3600, w.bChapterId) } finally { raw.close() }
    // A's machine: an older chapter, a note, and the newest chapter, whose
    // clock runs ahead of B's.
    await openA(w)
    const older = await chapter(w.aClient!, 'plan: sketch the login form; next: wire it')
    dateInA(w, older, now() - 86400)
    const note = parseTool(await w.aClient!.callTool({
      name: 'treecontext_insert', arguments: { content: 'finding: the CSRF token rotates per form' },
    }))['node_id'] as string
    dateInA(w, note, now() - 7200)
    w.aChapterText = 'plan: wire the login form; next: write its tests'
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    w.aChapterAt = Math.floor(now() + Number(h$) * 3600 + 10 * 60)
    dateInA(w, w.aChapterId, w.aChapterAt)
    await exportFromA(w)
    expect(w.fileNodes).toHaveLength(Number(n$))
  })
  reg.define(/^B imports it and then types \/clear and sends the next prompt$/, async (w) => {
    await importOnB(w)
    clearOnB(w)
  })
  reg.define(/^the packet handed to B's agent carries one line for the handoff naming A, (\d+) entries, and that chapter summary with its universal time$/, (w, n$) => {
    const lines = w.packet!.split('\n').filter((l) => l.startsWith('Handoff '))
    expect(lines, w.packet).toHaveLength(1)
    const line = lines[0]!
    // The sender as A's file claims it, and marked as a claim (D165). The
    // packet clips the name the way src/checkpoints.ts clip() does at
    // HANDOFF_NAME_CHARS (40); hosted macOS runners have GUID hostnames long
    // enough to reach it.
    const sender = SENDER.length <= 40 ? SENDER : `${SENDER.slice(0, 39)}…`
    expect(line.startsWith(`Handoff claimed from ${sender} (handoffs/login-plan.json): `), line).toBe(true)
    expect(line).toContain(`${String(n$)} entries`)
    expect(line).toContain(`newest chapter summary ${utc(w.aChapterAt!)}`)
    expect(line).toContain(`(id ${w.aChapterId!})`)
    expect(line).toContain(`"${w.aChapterText!}"`)
  })
  reg.define(/^the packet says that chapter summary is timestamped in the future rather than correcting it$/, (w) => {
    const line = w.packet!.split('\n').find((l) => l.startsWith('Handoff '))!
    expect(line).toContain("timestamped 3 hours in the future by the sender's clock, shown as written, not corrected")
    // Not corrected: B's store holds A's moment as A's clock wrote it.
    const [row] = rawAll<{ created_at: number }>(w, 'SELECT created_at FROM nodes WHERE node_id = ?', w.aChapterId)
    expect(row!.created_at).toBe(w.aChapterAt)
  })
  reg.define(/^the packet's own chapter line is still B's newest chapter summary, not A's$/, (w) => {
    const first = w.packet!.split('\n')[0]!
    expect(first).toMatch(/^Chapter summary, 1 hour|^Chapter summary, 60 minutes/)
    expect(first).toContain(w.bChapterId!)
    expect(first).toContain(w.bChapterText!)
    expect(first).not.toContain(w.aChapterId!)
  })

  // ── the default export carries summaries only (D177, D149) ──
  reg.define(/^developer A's store holding (\d+) entries, among them the chapter summary "([^"]+)", a bookmark, and the tester subagent's summary "([^"]+)"$/, async (w, n$, chapter$, tester$) => {
    await openA(w)
    await fillA(w, Number(n$) - 3)
    w.aChapterText = String(chapter$)
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    // The bookmark the stop hook asks for: a pointer too, but not a summary.
    w.bookmarkText = 'bookmark: login form wired, next the CSRF test'
    parseTool(await w.aClient!.callTool({ name: 'treecontext_insert', arguments: { content: w.bookmarkText, metadata: { kind: 'bookmark' } } }))
    // The tester's summary, as the orchestration chunk captures it from
    // SubagentStop: the contract is metadata kind "subagent-summary".
    w.testerText = String(tester$)
    await w.aStore!.insert(w.testerText, {
      metadata: { kind: 'subagent-summary', agent_type: 'tester', agent_id: 'tester-1', _cc_session_id: w.aSession },
      createdAt: now() - 60,
    })
    expect(aRows(w)).toHaveLength(Number(n$))
    // The bookmark is a live pointer in A's store: the selection must
    // exclude it by kind, not by luck.
    expect(aRows(w, "SELECT node_id, content FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'bookmark' AND json_extract(metadata_json, '$.next_session') = 1")).toHaveLength(1)
  })
  reg.define(/^A exports a handoff without choosing a form$/, async (w) => {
    w.askedPath = 'handoffs/login-plan.json'
    await exportCall(w, { path: w.askedPath })
  })
  reg.define(/^the file A commits holds (\d+) entries, the chapter summary and the tester's summary, and no bookmark$/, (w, n$) => {
    const file = committed(w)
    expect(file.nodes).toHaveLength(Number(n$))
    expect(file.nodes.map((x) => x['content']).sort()).toEqual([w.aChapterText, w.testerText].sort())
    expect(file.nodes.some((x) => x['content'] === w.bookmarkText)).toBe(false)
    expect(file['form']).toBe('summaries')
    expect(file['node_count']).toBe(Number(n$))
  })
  reg.define(/^the tool's reply carries no warning$/, (w) => {
    const res = lastExport(w)
    expect(res.isError, replyText(res)).toBeFalsy()
    // The reply is the file's name and the counts, every field of it.
    expect(Object.keys(parseTool(res)).sort()).toEqual(['entries', 'file', 'message'])
    // One call wrote it: no second, acknowledging call was needed.
    expect(w.exportReplies).toHaveLength(1)
    expect(w.exportReplies![0]!.fileAfter).toBe(true)
  })

  // ── a whole-journal export warns before it writes (D177) ──
  reg.define(/^developer A's store holding (\d+) entries including captured tool output$/, async (w, n$) => {
    await openA(w)
    await fillA(w, Number(n$) - 1)
    // The output a developer would not want in the repository.
    await w.aStore!.insert('$ env | grep TOKEN\nGITHUB_TOKEN=ghp_examplenotarealtoken0000000000000000', {
      metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: w.aSession }, createdAt: now() - 30,
    })
    expect(aRows(w)).toHaveLength(Number(n$))
  })
  reg.define(/^A exports the whole journal for a handoff$/, async (w) => {
    w.askedPath = 'handoffs/login-plan.json'
    await exportWhole(w, { path: w.askedPath })
  })
  reg.define(/^the tool's reply carries the warning that captured tool output can hold secrets, tokens and keys, and the file is written only after it$/, (w) => {
    const [warned, wrote] = w.exportReplies!
    expect(w.exportReplies).toHaveLength(2)
    // The warning came back first, and nothing was on the disk with it.
    expect(warned!.res.isError, replyText(warned!.res)).toBeFalsy()
    const first = parseTool(warned!.res)
    expect(String(first['warning'])).toMatch(/captured tool output can hold secrets, tokens and keys/i)
    expect(first['written']).toBe(false)
    expect(warned!.fileAfter).toBe(false)
    // Only the acknowledging call wrote it.
    expect(wrote!.res.isError, replyText(wrote!.res)).toBeFalsy()
    expect(wrote!.fileAfter).toBe(true)
  })
  reg.define(/^the file A commits holds (\d+) entries$/, (w, n$) => {
    const file = committed(w)
    expectFileHoldsLane(w, file, Number(n$))
    expect(file['form']).toBe('whole')
  })

  // ── a whole journal of any size lands in a file (D170) ──
  reg.define(/^developer A's store holding (\d+) entries$/, async (w, n$) => {
    await openA(w)
    await fillA(w, Number(n$))
    expect(aRows(w)).toHaveLength(Number(n$))
  })
  reg.define(/^A exports the whole journal to a file$/, async (w) => {
    w.askedPath = 'handoffs/whole-journal.json'
    await exportWhole(w, { path: w.askedPath })
  })
  reg.define(/^the file holds all (\d+) entries$/, (w, n$) => {
    const file = committed(w)
    expectFileHoldsLane(w, file, Number(n$))
    expect(file['node_count']).toBe(Number(n$))
  })
  reg.define(/^the tool's reply carries only the file's name and the counts, none of the content$/, (w) => {
    expectNameAndCountsOnly(w, w.askedPath!, committed(w).nodes.length)
  })

  // ── inline keeps today's cap, says what it left out (D170) ──
  reg.define(/^A exports the whole journal inline into the conversation$/, async (w) => {
    await exportWhole(w, {})
  })
  reg.define(/^the tool's reply holds the newest (\d+) entries$/, (w, n$) => {
    const res = lastExport(w)
    expect(res.isError, replyText(res)).toBeFalsy()
    const reply = parseTool(res) as Record<string, unknown> & { nodes: Array<Record<string, unknown>> }
    const newest = aRows(w, `SELECT node_id, content FROM nodes ORDER BY created_at DESC, node_id DESC LIMIT ${Number(n$)}`).reverse()
    expect(reply.nodes).toHaveLength(Number(n$))
    expect(reply.nodes.map((x) => x['nodeId'])).toEqual(newest.map((r) => r.node_id))
    expect(reply['node_count']).toBe(Number(n$))
  })
  reg.define(/^the tool's reply states that (\d+) were omitted and names the way to reach the rest$/, (w, n$) => {
    const reply = parseTool(lastExport(w))
    expect(reply['omitted']).toBe(Number(n$))
    const rest = String(reply['to_reach_the_rest'])
    expect(rest.startsWith(`${n$} older ${Number(n$) === 1 ? 'entry was' : 'entries were'} omitted`), rest).toBe(true)
    // The way to the rest is the file door: path, and no cap on a file.
    expect(rest).toMatch(/export with path/)
    expect(rest).toMatch(/A file carries every entry/)
    // And it is a way that works: the file door reaches every entry.
    const total = aRows(w).length
    expect(total - (reply['node_count'] as number)).toBe(Number(n$))
  })

  // ── the file says how to use itself (D172) ──
  reg.define(/^developer A exported a handoff file on (\d{4}-\d\d-\d\d) from the project "([^"]+)"$/, async (w, day$, project$) => {
    await openA(w, String(project$))
    w.aChapterText = 'plan: wire the login form; next: write its tests'
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    // A's clock on the day the export ran; only Date is faked, so the
    // server's I/O runs as ever.
    vi.useFakeTimers({ toFake: ['Date'] })
    w.defer(() => { vi.useRealTimers() })
    vi.setSystemTime(new Date(`${String(day$)}T14:02:31Z`))
    w.askedPath = 'handoffs/login-plan.json'
    await exportCall(w, { path: w.askedPath })
    vi.useRealTimers()
    w.fileName = w.askedPath
    w.filePath = join(w.aRepo!, w.askedPath)
  })
  reg.define(/^developer B opens the file$/, (w) => {
    w.openedText = readFileSync(w.filePath!, 'utf8')
  })
  reg.define(/^B reads at its head who exported it, when, from which project, which treecontext version wrote it, what it holds, and the one step that imports it$/, async (w) => {
    const t = w.openedText!
    const file = JSON.parse(t) as Record<string, unknown>
    // At its head: every one of these lines comes before the first entry.
    const nodesAt = t.indexOf('"nodes"')
    for (const k of ['exported_by', 'exported_at', 'project', 'treecontext_version', 'holds', 'to_import']) {
      const at = t.indexOf(`"${k}"`)
      expect(at, `the head has no ${k}`).toBeGreaterThan(-1)
      expect(at, `${k} is not at the head`).toBeLessThan(nodesAt)
    }
    expect(file['exported_by']).toBe(SENDER)
    expect(file['exported_at']).toBe('2026-10-17T14:02:31Z')
    expect(file['project']).toBe('hackathon-app')
    expect(file['treecontext_version']).toBe(PKG_VERSION)
    expect(file['holds']).toBe('1 entry: the chapter summaries and subagent summaries of one journal, the default handoff (no bookmarks, no captured tool output)')
    const step = String(file['to_import'])
    expect(step).toBe('Ask your agent to import "handoffs/login-plan.json" (treecontext_import with path "handoffs/login-plan.json"), '
      + "or run in this project's directory: treecontext import handoffs/login-plan.json")
    // The one step works as written: B's agent takes it on B's machine.
    await openB(w)
    const reply = await importOnB(w)
    expectTold(reply, 1, 0)
    const [row] = importedRows(w)
    expect(text(row!)).toBe(w.aChapterText)
    expect(meta(row!)['_handoff_file']).toBe('handoffs/login-plan.json')
  })

  // ── the agent writes the file; a path outside is refused (D199) ──
  reg.define(/^developer A asks their agent for a handoff file at "([^"]+)"(?: in the repository)?$/, async (w, path$) => {
    await openA(w)
    w.aChapterText = 'plan: wire the login form; next: write its tests'
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    await fillA(w, 20)
    w.askedPath = String(path$)
  })
  reg.define(/^the agent calls export with that path$/, async (w) => {
    await exportCall(w, { path: w.askedPath })
  })
  reg.define(/^the server writes the file at that path$/, (w) => {
    const at = join(w.aRepo!, w.askedPath!)
    expect(w.exportReplies![0]!.fileAfter).toBe(true)
    const file = committed(w)
    // The summaries of A's store, as A's SQLite file holds them.
    const summaries = aRows(w, "SELECT node_id, content FROM nodes WHERE json_extract(metadata_json, '$.next_session') = 1 ORDER BY created_at")
    expect(file.nodes.map((x) => x['nodeId'])).toEqual(summaries.map((r) => r.node_id))
    expect(statSync(at).isFile()).toBe(true)
  })
  reg.define(/^only the file's name and the counts appear in the tool's reply$/, (w) => {
    expectNameAndCountsOnly(w, w.askedPath!, committed(w).nodes.length)
  })
  reg.define(/^the server refuses the path and writes nothing$/, (w) => {
    const res = lastExport(w)
    expect(res.isError).toBe(true)
    // Nothing where the path points, nothing anywhere in A's directory but
    // the store and the empty repository.
    expect(existsSync(resolve(w.aRepo!, w.askedPath!))).toBe(false)
    const files = (readdirSync(w.aDir!, { recursive: true }) as string[]).map((f) => f.split('\\').join('/')).sort()
    expect(files.filter((f) => !f.startsWith('treecontext.db'))).toEqual(['work', 'work/hackathon-app'])
  })
  reg.define(/^the tool's reply names the project directory as the only place a handoff may be written$/, (w) => {
    const said = replyText(lastExport(w))
    const reply = parseTool(lastExport(w))
    expect(reply['project_dir']).toBe(w.aRepo)
    expect(String(reply['error'])).toContain(`A handoff may be written only inside the project directory, ${w.aRepo}`)
    expect(said).toContain('Nothing was written.')
  })

  // ── a shell command writes the same file (D199) ──
  reg.define(/^developer A's store holding the chapter summary "([^"]+)"$/, async (w, chapter$) => {
    await openA(w)
    w.aChapterText = String(chapter$)
    w.aChapterId = await chapter(w.aClient!, w.aChapterText)
    await fillA(w, 10)
    w.askedPath = 'handoffs/login-plan.json'
  })
  reg.define(/^A runs the export command in a shell with an output path$/, (w) => {
    // A's shell, in A's repository, naming A's store by its path.
    const home = join(w.aDir!, 'home')
    mkdirSync(home, { recursive: true })
    const t0 = Math.floor(Date.now() / 1000)
    const run = spawnCli(['export', w.askedPath!, '--store', join(w.aDir!, 'treecontext.db'), '--no-debug'], { home, cwd: w.aRepo! })
    w.cliWindow = [t0, Math.ceil(Date.now() / 1000)]
    w.cliRun = run
    expect(run.status, run.out).toBe(0)
    w.cliBytes = readFileSync(join(w.aRepo!, w.askedPath!), 'utf8')
    rmSync(join(w.aRepo!, w.askedPath!))
  })
  reg.define(/^the file at that path holds the same content the tool would have written$/, async (w) => {
    expect(w.cliRun!.stdout.trim()).toBe(`Wrote 1 entry to ${w.askedPath}.`)
    const t0 = Math.floor(Date.now() / 1000)
    await exportCall(w, { path: w.askedPath })
    const t1 = Math.ceil(Date.now() / 1000)
    const toolBytes = readFileSync(join(w.aRepo!, w.askedPath!), 'utf8')
    const cliHead = JSON.parse(w.cliBytes!) as Record<string, unknown>
    const toolHead = JSON.parse(toolBytes) as Record<string, unknown>
    // Each door stamped its own moment, inside its own run.
    const sec = (v: unknown): number => Date.parse(String(v)) / 1000
    expect(sec(cliHead['exported_at'])).toBeGreaterThanOrEqual(w.cliWindow![0])
    expect(sec(cliHead['exported_at'])).toBeLessThanOrEqual(w.cliWindow![1])
    expect(sec(toolHead['exported_at'])).toBeGreaterThanOrEqual(t0)
    expect(sec(toolHead['exported_at'])).toBeLessThanOrEqual(t1)
    // Byte for byte the same file, the moment aside.
    const sameMoment = w.cliBytes!.replace(`"exported_at": "${String(cliHead['exported_at'])}"`, `"exported_at": "${String(toolHead['exported_at'])}"`)
    expect(sameMoment).toBe(toolBytes)
    expect((toolHead['nodes'] as unknown[])).toHaveLength(1)
  })
}
