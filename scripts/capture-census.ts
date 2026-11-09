/**
 * Capture census: the dogfood routine's far-side check (D402).
 *
 * Counts a real Claude Code transcript's tool calls against the store. The
 * transcript is the client's account of what it ran; the store is what
 * treecontext kept. Two kinds of answer, never mixed:
 *
 * OBSERVED, matched by the client's call id:
 *   stored        a node whose metadata `tool_use_id` is the call's id
 *   staged        a staging row with the id the drain has not processed yet
 * INFERRED, unverified (no id to match):
 *   before-id     the call predates the build that stores ids: an unclaimed
 *                 node of the same session and tool, with no `tool_use_id`,
 *                 made within INFER_WINDOW_SECS of the call's result, whose
 *                 Input section holds the call's input text. One node
 *                 accounts for at most one call.
 *   deduplicated  session-scoped dedup (D80): an EARLIER node of the same
 *                 session and tool, inside the product's dedup window, whose
 *                 Input section equals the call's composed input exactly.
 *                 One node may stand for several calls. Output equality is
 *                 NOT checked.
 * LOST            none of the above
 *
 * Exit 0 only when every call is observed; 1 when any call is LOST; 3 when
 * none is LOST but some are inferred. Needs a real client: nothing here runs
 * under `npm test` (the classifier is unit-tested on a synthetic transcript
 * and store, tests/capture-census.test.ts).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { lookupStoreName } from '../src/server/bindings.js'
import { resolveStorePath } from '../src/server/cli.js'
import { decodeContent } from '../src/persistence/content-codec.js'
import { composeToolText } from '../src/hooks/post-tool-use.js'
import { DEDUP_WINDOW_SECS, FULL_TAIL_SEPARATOR } from '../src/persistence/capture-constants.js'

// ── Types ──────────────────────────────────────────────────────────────

export type Outcome = 'succeeded' | 'failed' | 'no result'
export type Status = 'stored' | 'staged' | 'before-id' | 'deduplicated' | 'LOST'
export const OUTCOMES: readonly Outcome[] = ['succeeded', 'failed', 'no result']
export const OBSERVED: readonly Status[] = ['stored', 'staged']
export const INFERRED: readonly Status[] = ['before-id', 'deduplicated']
export const STATUSES: readonly Status[] = [...OBSERVED, ...INFERRED, 'LOST']

/** How far a node's moment may be from the call's result moment in the
 *  transcript for the node to be taken for that call. A hook fires as the
 *  client resolves the call, so the two moments differ by the hook's start
 *  and the client's write, milliseconds on an idle machine; a few seconds
 *  allows a busy one without letting a neighbouring call's node stand in. */
export const INFER_WINDOW_SECS = 5

export interface TranscriptCall {
  id: string
  name: string
  input: Record<string, unknown>
  /** The transcript's own word: `failed` is a tool_result with is_error
   *  true (a denied, rejected or interrupted call included). */
  outcome: Outcome
  /** The session the call's line names (a subagent's transcript names its parent's). */
  session: string
  /** The call's result moment, else its own, in epoch seconds; null if the line has none. */
  at: number | null
  /** The assistant message the call was made in. */
  messageId: string | null
  file: string
}

export interface CensusRow { call: TranscriptCall; status: Status }

export interface NodeView { text: string; toolUseId: string | null; at: number | null }

/** What the classifier asks of a store. */
export interface StoreView {
  hasNodeWithId(id: string): boolean
  hasStagedWithId(id: string): boolean
  /** The nodes of one session and tool. */
  nodesOf(session: string, tool: string): NodeView[]
}

// ── Transcript ─────────────────────────────────────────────────────────

/** The text a call's input is looked for by in a node's Input section: its
 *  longest string value's first line, up to 80 characters; '' when the
 *  input has none (an empty input then matches on tool and time alone). */
export function inputNeedle(input: Record<string, unknown>): string {
  let best = ''
  for (const v of Object.values(input)) if (typeof v === 'string' && v.length > best.length) best = v
  return (best.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 80)
}

/**
 * The calls of one transcript (JSONL). An assistant `tool_use` block gives
 * id, name and input; a user `tool_result` block gives `tool_use_id` and
 * `is_error`. Only lines of type `assistant` and `user` count: the client
 * also writes request blobs that repeat earlier blocks. A call seen twice
 * (a streamed message written in parts) counts once. The session is the one
 * the call's own line names.
 */
export function parseTranscript(jsonl: string, file: string, since?: Date): TranscriptCall[] {
  const calls = new Map<string, TranscriptCall>()
  const results = new Map<string, { error: boolean; at: number | null }>()
  const epoch = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t / 1000 }
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (d['type'] !== 'assistant' && d['type'] !== 'user') continue
    const message = d['message'] as { content?: unknown; id?: unknown } | undefined
    const content = message?.content
    if (!Array.isArray(content)) continue
    const at = epoch(d['timestamp'])
    const session = typeof d['sessionId'] === 'string' ? d['sessionId'] : ''
    for (const block of content as Array<Record<string, unknown>>) {
      if (d['type'] === 'assistant' && block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        if (since && at !== null && at < since.getTime() / 1000) continue
        if (!calls.has(block['id'])) {
          calls.set(block['id'], {
            id: block['id'], name: String(block['name']),
            input: (block['input'] && typeof block['input'] === 'object' ? block['input'] : {}) as Record<string, unknown>,
            outcome: 'no result', session, at, messageId: typeof message?.id === 'string' ? message.id : null, file,
          })
        }
      } else if (d['type'] === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        results.set(block['tool_use_id'], { error: block['is_error'] === true, at })
      }
    }
  }
  for (const c of calls.values()) {
    const r = results.get(c.id)
    if (r) { c.outcome = r.error ? 'failed' : 'succeeded'; if (r.at !== null) c.at = r.at }
  }
  return [...calls.values()]
}

/** A session transcript and the subagent transcripts beside it. */
export function transcriptFiles(sessionFile: string): string[] {
  const sub = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents')
  const subs = existsSync(sub) ? readdirSync(sub).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(sub, f)) : []
  return [sessionFile, ...subs]
}

export function callsOf(sessionFile: string, since?: Date): TranscriptCall[] {
  const out: TranscriptCall[] = []
  for (const f of transcriptFiles(sessionFile)) {
    const calls = parseTranscript(readFileSync(f, 'utf8'), f, since)
    for (const c of calls) if (c.session === '') c.session = sessionFile.split('/').pop()!.replace(/\.jsonl$/, '')
    out.push(...calls)
  }
  return out
}

// ── Classification ─────────────────────────────────────────────────────

/** A node's Input section: from `Input:` to the last `Output:` of the
 *  preview, or of the full tail when the node has one (the tail holds the
 *  whole input, the preview a cut one); never the Output. */
export function inputSectionOf(content: string): string | null {
  const sep = `\n${FULL_TAIL_SEPARATOR}\n`
  const cut = content.indexOf(sep)
  const region = cut === -1 ? content : content.slice(cut + sep.length)
  const at = region.startsWith('Input:\n') ? 0 : region.indexOf('\nInput:\n') + 1
  if (at <= 0 && !region.startsWith('Input:\n')) return null
  const rest = region.slice(at + 'Input:\n'.length)
  const end = rest.lastIndexOf('\nOutput:\n')
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\n$/, '')
}

export function classify(calls: TranscriptCall[], store: StoreView): CensusRow[] {
  const claimed = new Set<NodeView>()
  const ordered = [...calls].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const status = new Map<TranscriptCall, Status>()
  for (const call of ordered) {
    if (store.hasNodeWithId(call.id)) { status.set(call, 'stored'); continue }
    if (store.hasStagedWithId(call.id)) { status.set(call, 'staged'); continue }
    const nodes = store.nodesOf(call.session, call.name)
    const needle = inputNeedle(call.input)
    const emptyInput = composeToolText(call.input) === '{}'
    let best: NodeView | null = null
    if (call.at !== null) {
      for (const n of nodes) {
        if (n.toolUseId !== null || claimed.has(n) || n.at === null) continue
        if (Math.abs(n.at - call.at) > INFER_WINDOW_SECS) continue
        if (!emptyInput) {
          const input = inputSectionOf(n.text)
          if (input === null || (needle !== '' ? !input.includes(needle) : input.trim() === '')) continue
        }
        if (best === null || Math.abs(n.at - call.at) < Math.abs(best.at! - call.at)) best = n
      }
    }
    if (best) { claimed.add(best); status.set(call, 'before-id'); continue }
    if (call.at !== null && !emptyInput) {
      const composed = composeToolText(call.input)
      const survivor = nodes.some((n) => n.at !== null && n.at < call.at! && call.at! - n.at <= DEDUP_WINDOW_SECS && inputSectionOf(n.text) === composed)
      if (survivor) { status.set(call, 'deduplicated'); continue }
    }
    status.set(call, 'LOST')
  }
  return calls.map((call) => ({ call, status: status.get(call)! }))
}

/** Outcome × status counts. */
export function tabulate(rows: CensusRow[]): Record<Outcome, Record<Status, number>> {
  const t = {} as Record<Outcome, Record<Status, number>>
  for (const o of OUTCOMES) { t[o] = {} as Record<Status, number>; for (const s of STATUSES) t[o][s] = 0 }
  for (const r of rows) t[r.call.outcome][r.status]++
  return t
}

export function renderTable(rows: CensusRow[]): string {
  const t = tabulate(rows)
  const w = 13
  const lines = [
    ''.padEnd(w) + 'OBSERVED (by id)'.padStart(2 * w) + 'INFERRED (unverified)'.padStart(2 * w) + 'LOST'.padStart(w),
    ['outcome'.padEnd(w), ...STATUSES.map((s) => s.padStart(w)), 'total'.padStart(w)].join(''),
  ]
  for (const o of OUTCOMES) {
    const total = STATUSES.reduce((n, s) => n + t[o][s], 0)
    lines.push([o.padEnd(w), ...STATUSES.map((s) => String(t[o][s]).padStart(w)), String(total).padStart(w)].join(''))
  }
  return lines.join('\n')
}

const describe = (c: TranscriptCall): string => JSON.stringify(inputNeedle(c.input) || JSON.stringify(c.input).slice(0, 80))

export function renderLost(rows: CensusRow[]): string {
  return rows.filter((r) => r.status === 'LOST').map((r) => `  LOST ${r.call.name} ${r.call.id} (${r.call.outcome}) ${describe(r.call)}`).join('\n')
}

export function renderInferred(rows: CensusRow[]): string {
  return rows.filter((r) => INFERRED.includes(r.status)).map((r) => `  ${r.status} ${r.call.name} ${r.call.id} (${r.call.outcome}) ${describe(r.call)}`).join('\n')
}

/** The census's exit code: 0 all observed, 1 any LOST, 3 none LOST but some
 *  inferred. `stagedIsPresent` is false in --live, where a staged row is a
 *  drain that did not finish. */
export function exitCodeOf(rows: CensusRow[], stagedIsPresent = true): number {
  if (rows.some((r) => r.status === 'LOST')) return 1
  if (!stagedIsPresent && rows.some((r) => r.status === 'staged')) return 1
  return rows.some((r) => INFERRED.includes(r.status)) ? 3 : 0
}

// ── The store, read-only ───────────────────────────────────────────────

export function storeViewOf(db: DatabaseSync): StoreView {
  const hasStagingId = (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).some((c) => c.name === 'tool_use_id')
  const byId = db.prepare("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.tool_use_id') = ? LIMIT 1")
  const staged = hasStagingId ? db.prepare('SELECT 1 FROM staging WHERE tool_use_id = ? AND processed = 0 LIMIT 1') : null
  const nodes = db.prepare(
    "SELECT content, json_extract(metadata_json, '$.tool_use_id') AS tool_use_id, " +
    "COALESCE(json_extract(metadata_json, '$.created_at'), created_at) AS at FROM nodes " +
    "WHERE json_extract(metadata_json, '$.session_id') = ? AND json_extract(metadata_json, '$.tool_name') = ?")
  const cache = new Map<string, NodeView[]>()
  return {
    hasNodeWithId: (id) => byId.get(id) !== undefined,
    hasStagedWithId: (id) => (staged ? staged.get(id) !== undefined : false),
    nodesOf: (session, tool) => {
      const key = `${session}\n${tool}`
      let hit = cache.get(key)
      if (!hit) {
        hit = (nodes.all(session, tool) as Array<{ content: string | Uint8Array; tool_use_id: string | null; at: number | null }>)
          .map((r) => ({ text: decodeContent(r.content as string | Uint8Array), toolUseId: r.tool_use_id ?? null, at: typeof r.at === 'number' ? r.at : null }))
        cache.set(key, hit)
      }
      return hit
    },
  }
}

/** The store a project directory is bound to, opened read-only. Reads the
 *  bindings; never writes one. */
export function openProjectStore(projectDir: string): { name: string; path: string; db: DatabaseSync } {
  const name = lookupStoreName(projectDir)
  if (!name) throw new Error(`no store is bound to ${projectDir} (treecontext has never captured there)`)
  const path = resolveStorePath(name)
  if (!existsSync(path)) throw new Error(`store ${name} has no database at ${path}`)
  return { name, path, db: new DatabaseSync(path, { readOnly: true }) }
}

// ── The event list (D402) ──────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const EVENTS_JSON = join(HERE, '..', 'tests', 'fixtures', 'claude-code-hooks', 'events.json')

export function eventList(): { version: string; events: string[] } {
  const j = JSON.parse(readFileSync(EVENTS_JSON, 'utf8')) as { version: string; events: Array<{ event: string }> }
  return { version: j.version, events: j.events.map((e) => e.event) }
}

// ── CLI ────────────────────────────────────────────────────────────────

const HELP = `capture-census: count a real Claude Code session's tool calls against the store

  npm run dogfood:census -- --transcript <session.jsonl> [--transcript ...] [--since <ISO date>] [--project <dir>] [--verbose]
  npm run dogfood:census -- --session <id> [--since <ISO date>] [--project <dir>] [--verbose]
  npm run dogfood:census -- --live
  npm run dogfood:census -- --help

--transcript  a session transcript (repeatable); the subagent transcripts under
              <session>/subagents/ are included
--session     a session id, resolved under ~/.claude/projects/ for the project
              directory (--project, default: the current directory)
--since       only calls made at or after this moment
--project     the project directory whose store is read (default: the one the
              transcript ran in, else the current directory)
--verbose     list every inferred call
--live        run one real headless session (claude -p, haiku) in a fresh
              temporary project with the installed hooks, making one of each
              outcome (a success, a failing Bash, a Read of a missing file, an
              Edit that is rejected, a Write that is denied, a parallel pair);
              check it made them; start the installed treecontext server for
              the project the way a client does so staging drains; then count.
              Needs the build under test installed globally.
              WHAT --live WRITES OUTSIDE ITS TEMPORARY DIRECTORY: a store and a
              binding under ~/.treecontext for the temporary project, and the
              session's transcript under ~/.claude/projects. It removes the
              temporary directory only. Remove the store with the command it
              prints: treecontext stores rm <name> --yes

What is counted:
  OBSERVED  stored (a node carries the call's id) and staged (a staging row
            carries it, not yet drained; present only in --transcript mode)
  INFERRED  before-id and deduplicated, unverified: matched by session, tool,
            time and input text, one node per call (a deduplicated survivor
            may stand for several; output equality is not checked)
  LOST      none of these. A session the retention valve archived or
            tombstoned reads LOST: the script does not read archives.
"failed" is the transcript's own is_error: a denied, rejected or interrupted
call is failed.

Exit codes: 0 every call observed; 1 any call LOST (in --live, also any row
still staged after the drain); 2 the script could not run, or --live's probe
did not run as scripted; 3 nothing LOST but some calls inferred (unverified),
or --live's client version differs from the event list's.`

interface Args { transcripts: string[]; session: string | null; since: Date | undefined; project: string | null; live: boolean; verbose: boolean; help: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = { transcripts: [], session: null, since: undefined, project: null, live: false, verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    const v = (): string => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x }
    if (k === '--transcript') a.transcripts.push(resolve(v()))
    else if (k === '--session') a.session = v()
    else if (k === '--since') { const d = new Date(v()); if (Number.isNaN(d.getTime())) throw new Error('--since needs an ISO date'); a.since = d }
    else if (k === '--project') a.project = resolve(v())
    else if (k === '--live') a.live = true
    else if (k === '--verbose') a.verbose = true
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Error(`unknown argument ${k}`)
  }
  return a
}

/** Claude Code's directory name for a project: every character that is not a letter or digit is a dash. */
export function projectsDirName(cwd: string): string { return cwd.replace(/[^A-Za-z0-9]/g, '-') }

function firstCwd(file: string): string | null {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { const d = JSON.parse(line) as { cwd?: unknown }; if (typeof d.cwd === 'string') return d.cwd } catch { /* next */ }
  }
  return null
}

function report(rows: CensusRow[], store: { name: string }, verbose: boolean): void {
  console.log(`store: ${store.name}`)
  console.log(`calls: ${rows.length}\n`)
  console.log(renderTable(rows))
  const inferred = rows.filter((r) => INFERRED.includes(r.status))
  if (inferred.length > 0) {
    console.log(`\n${inferred.length} call(s) are INFERRED, unverified: matched by session, tool, time and input text, not by id (output equality is not checked).`)
    if (verbose) console.log(renderInferred(rows))
    else console.log('  (--verbose lists them)')
  }
  const lost = renderLost(rows)
  if (lost) console.log(`\n${rows.filter((r) => r.status === 'LOST').length} call(s) LOST:\n${lost}`)
}

function censusTranscripts(a: Args): number {
  const files = [...a.transcripts]
  const projectDir = a.project ?? process.cwd()
  if (a.session) files.push(join(homedir(), '.claude', 'projects', projectsDirName(projectDir), `${a.session}.jsonl`))
  if (files.length === 0) throw new Error('give --transcript, --session or --live (--help)')
  const calls: TranscriptCall[] = []
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`no transcript at ${f}`)
    calls.push(...callsOf(f, a.since))
  }
  const dir = a.project ?? firstCwd(files[0]!) ?? projectDir
  const store = openProjectStore(dir)
  try {
    const rows = classify(calls, storeViewOf(store.db))
    report(rows, store, a.verbose)
    return exitCodeOf(rows)
  } finally { store.db.close() }
}

// ── --live ─────────────────────────────────────────────────────────────

const LIVE_PROMPT = [
  'Make exactly these tool calls, in this order, one at a time except where told, and do not retry or fix any that fail.',
  '1. Bash: echo census-ok',
  '2. Bash: sh -c "echo census-fail >&2; exit 3"',
  '3. Read the file ./no-such-file-census.txt',
  '4. Edit ./seed.txt replacing the text "string-that-is-not-there" with "x"',
  '5. Write the file /etc/census-denied.txt with the text "x"',
  '6. In ONE message, make these two calls in parallel: Bash: echo census-par-a and Bash: echo census-par-b',
  'Then reply with the single word done.',
].join('\n')

/** What the prompt asks for, as the transcript must show it. Returns what is missing. */
export function scriptedCallsMissing(calls: TranscriptCall[]): string[] {
  const text = (c: TranscriptCall): string => JSON.stringify(c.input)
  const find = (name: string, outcome: Outcome, has: string): TranscriptCall | undefined =>
    calls.find((c) => c.name === name && c.outcome === outcome && text(c).includes(has))
  const missing: string[] = []
  const need = (label: string, c: TranscriptCall | undefined): TranscriptCall | undefined => { if (!c) missing.push(label); return c }
  need('a Bash call that succeeded (census-ok)', find('Bash', 'succeeded', 'census-ok'))
  need('a Bash call that failed (census-fail)', find('Bash', 'failed', 'census-fail'))
  need('a Read of a missing file that failed', find('Read', 'failed', 'no-such-file-census'))
  need('an Edit that failed', find('Edit', 'failed', 'string-that-is-not-there'))
  need('a Write that failed', find('Write', 'failed', 'census-denied'))
  const a = need('the parallel Bash census-par-a', calls.find((c) => c.name === 'Bash' && text(c).includes('census-par-a')))
  const b = need('the parallel Bash census-par-b', calls.find((c) => c.name === 'Bash' && text(c).includes('census-par-b')))
  if (a && b && (a.messageId === null || a.messageId !== b.messageId)) missing.push('the two parallel calls in one assistant message')
  return missing
}

/** Start the installed `treecontext serve` for the project directory the way
 *  a client does (the entry Claude Code's own config holds, stdio, an
 *  `initialize` sent), wait until the session's staging rows are processed or
 *  `capMs` passes, then close its stdin and wait for it to exit. Only a
 *  running server drains staging (IngestionLoop). Returns the unprocessed
 *  count at the end. */
async function drainWithServer(dir: string, session: string, capMs: number): Promise<{ remaining: number; waitedMs: number }> {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: string[] }> }
  const entry = cfg.mcpServers?.['treecontext']
  if (!entry?.command) throw new Error("no treecontext entry in Claude Code's config (~/.claude.json): is the build under test installed?")
  const child = spawn(entry.command, entry.args ?? [], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.resume()
  child.stderr.resume()
  const exited = new Promise<void>((r) => { child.once('exit', () => r()); child.once('error', () => r()) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capture-census', version: '1' } } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const started = Date.now()
  let remaining = 1
  try {
    for (;;) {
      try {
        const s = openProjectStore(dir)
        try { remaining = (s.db.prepare('SELECT count(*) AS n FROM staging WHERE session_id = ? AND processed = 0').get(session) as { n: number }).n } finally { s.db.close() }
      } catch { remaining = 1 }
      if (remaining === 0 || Date.now() - started >= capMs || child.exitCode !== null) break
      await sleep(1000)
    }
  } finally {
    child.stdin.end()
    const killer = setTimeout(() => child.kill('SIGTERM'), 15_000)
    await exited
    clearTimeout(killer)
  }
  return { remaining, waitedMs: Date.now() - started }
}

function clientVersion(): string | null {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  return /\d+\.\d+\.\d+/.exec(r.stdout ?? '')?.[0] ?? null
}

async function censusLive(): Promise<number> {
  const list = eventList()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-census-')))
  let exit = 0
  try {
    writeFileSync(join(dir, 'seed.txt'), 'census seed\n')
    const dump = join(dir, '.census-events.ndjson')
    const hooks: Record<string, unknown> = {}
    for (const ev of list.events) hooks[ev] = [{ hooks: [{ type: 'command', command: `cat >> '${dump}'; echo >> '${dump}'` }] }]
    const settings = join(dir, '.census-settings.json')
    writeFileSync(settings, JSON.stringify({ hooks }))
    console.log(`running a real headless session in ${dir} (claude -p, haiku)`)
    const r = spawnSync('claude', ['-p', LIVE_PROMPT, '--model', 'haiku', '--settings', settings, '--allowedTools', 'Bash,Read,Edit'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
    })
    if (r.error) throw new Error(`could not run claude: ${r.error.message}`)
    if (r.status !== 0) console.log(`claude exited ${String(r.status)}: ${(r.stderr ?? '').slice(0, 300)}`)
    if (!existsSync(dump)) throw new Error('no hook event was recorded: is the client installed and are hooks enabled?')
    const events = readFileSync(dump, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
    const fired = new Map<string, number>()
    for (const e of events) fired.set(String(e['hook_event_name']), (fired.get(String(e['hook_event_name'])) ?? 0) + 1)
    console.log('\nevents the client fired:')
    for (const [k, n] of [...fired].sort()) console.log(`  ${k.padEnd(22)} ${n}`)

    const transcript = events.map((e) => e['transcript_path']).find((p): p is string => typeof p === 'string')
    const session = events.map((e) => e['session_id']).find((p): p is string => typeof p === 'string')
    if (!transcript || !session) throw new Error('the recorded events name no transcript or session')
    const calls = callsOf(transcript)
    const missing = scriptedCallsMissing(calls)
    if (missing.length > 0) {
      console.error(`\nthe probe did not run as scripted; the session did not make: ${missing.join('; ')}`)
      return 2
    }
    const drain = await drainWithServer(dir, session, 90_000)
    console.log(drain.remaining === 0
      ? `\nstaging drained (waited ${(drain.waitedMs / 1000).toFixed(0)}s)`
      : `\n${drain.remaining} staged row(s) of the session were not processed after ${(drain.waitedMs / 1000).toFixed(0)}s`)
    const store = openProjectStore(dir)
    try {
      const rows = classify(calls, storeViewOf(store.db))
      console.log('')
      report(rows, store, true)
      exit = exitCodeOf(rows, false)
      const staged = rows.filter((x) => x.status === 'staged')
      if (staged.length > 0) console.log(`\nstill staged after the drain (a failure in --live): ${staged.map((x) => `${x.call.name} ${x.call.id}`).join(', ')}`)
      console.log(`\nthe temporary project is bound to store "${store.name}"; remove it with: treecontext stores rm ${store.name} --yes`)
      console.log('(not removed here: the name is derived from the project path, and this script does not own the bindings file)')
    } finally { store.db.close() }
    const version = clientVersion()
    if (version !== list.version) {
      console.log(`\nthe event list was read at Claude Code ${list.version}, this client is ${version ?? 'of unknown version'}: the hooks reference must be re-read before the list is trusted`)
      if (exit === 0) exit = 3
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    console.log(`removed ${dir}`)
  }
  return exit
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2))
  if (a.help) { console.log(HELP); return 0 }
  return a.live ? censusLive() : censusTranscripts(a)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((c) => process.exit(c), (e: unknown) => { console.error(`capture-census: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) })
}
