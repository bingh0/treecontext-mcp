/**
 * Capture census: the dogfood routine's far-side check (D402).
 *
 * Counts a real Claude Code transcript's tool calls against the store, by the
 * client's own call id. The transcript is the client's account of what it
 * ran; the store is what treecontext kept. Every call is reported as one of:
 *
 *   stored        a node whose metadata `tool_use_id` is the call's id
 *   staged        a staging row with the id the drain has not processed yet
 *   deduplicated  no node with the id, but a node of the same session, tool
 *                 name and input text exists and carries another id:
 *                 session-scoped dedup (D80). INFERRED, not proved.
 *   before-id     the call predates the build that stores ids: a node of the
 *                 same session, tool name and input text with no
 *                 `tool_use_id`. INFERRED, not proved.
 *   LOST          none of the above
 *
 * Exit 1 when any call is LOST (and, in --live, when the client fired an
 * event events.json does not hold), 0 otherwise.
 *
 * Needs a real client: nothing here runs under `npm test` (the classifier is
 * unit-tested on a synthetic transcript and store, tests/capture-census.test.ts).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { lookupStoreName } from '../src/server/bindings.js'
import { resolveStorePath } from '../src/server/cli.js'
import { decodeContent } from '../src/persistence/content-codec.js'

// ── Types ──────────────────────────────────────────────────────────────

export type Outcome = 'succeeded' | 'failed' | 'no result'
export type Status = 'stored' | 'staged' | 'deduplicated' | 'before-id' | 'LOST'
export const OUTCOMES: readonly Outcome[] = ['succeeded', 'failed', 'no result']
export const STATUSES: readonly Status[] = ['stored', 'staged', 'deduplicated', 'before-id', 'LOST']

export interface TranscriptCall {
  id: string
  name: string
  input: Record<string, unknown>
  outcome: Outcome
  /** The session the call belongs to (a subagent's transcript names its parent's). */
  session: string
  /** The transcript file it came from. */
  file: string
}

export interface CensusRow { call: TranscriptCall; status: Status }

/** What the classifier asks of a store. */
export interface StoreView {
  hasNodeWithId(id: string): boolean
  hasStagedWithId(id: string): boolean
  /** The nodes of one session and tool: their text and the id they carry. */
  nodesOf(session: string, tool: string): Array<{ text: string; toolUseId: string | null }>
}

// ── Transcript ─────────────────────────────────────────────────────────

/** The text a call's input is looked for by in a node: its longest string
 *  value's first line, up to 80 characters; '' when the input has none. */
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
 * (a streamed message written in parts) counts once.
 */
export function parseTranscript(jsonl: string, file: string, since?: Date): TranscriptCall[] {
  const calls = new Map<string, TranscriptCall>()
  const results = new Map<string, boolean>()
  let session = ''
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (typeof d['sessionId'] === 'string' && session === '') session = d['sessionId']
    if (d['type'] !== 'assistant' && d['type'] !== 'user') continue
    const message = d['message']
    const content = (message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    const at = typeof d['timestamp'] === 'string' ? new Date(d['timestamp']) : null
    for (const block of content as Array<Record<string, unknown>>) {
      if (d['type'] === 'assistant' && block['type'] === 'tool_use' && typeof block['id'] === 'string') {
        if (since && at && at < since) continue
        if (!calls.has(block['id'])) {
          calls.set(block['id'], {
            id: block['id'], name: String(block['name']),
            input: (block['input'] && typeof block['input'] === 'object' ? block['input'] : {}) as Record<string, unknown>,
            outcome: 'no result', session: '', file,
          })
        }
      } else if (d['type'] === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        results.set(block['tool_use_id'], block['is_error'] === true)
      }
    }
  }
  for (const c of calls.values()) {
    c.session = session
    const r = results.get(c.id)
    c.outcome = r === undefined ? 'no result' : r ? 'failed' : 'succeeded'
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
    // A subagent's transcript names the parent session on its lines; a file
    // that names none belongs to the session whose directory holds it.
    for (const c of calls) if (c.session === '') c.session = sessionFile.split('/').pop()!.replace(/\.jsonl$/, '')
    out.push(...calls)
  }
  return out
}

// ── Classification ─────────────────────────────────────────────────────

export function classify(calls: TranscriptCall[], store: StoreView): CensusRow[] {
  return calls.map((call) => {
    if (store.hasNodeWithId(call.id)) return { call, status: 'stored' as const }
    if (store.hasStagedWithId(call.id)) return { call, status: 'staged' as const }
    const needle = inputNeedle(call.input)
    if (needle !== '') {
      const same = store.nodesOf(call.session, call.name).filter((n) => n.text.includes(needle))
      if (same.some((n) => n.toolUseId === null)) return { call, status: 'before-id' as const }
      if (same.length > 0) return { call, status: 'deduplicated' as const }
    }
    return { call, status: 'LOST' as const }
  })
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
  const w = 14
  const head = ['outcome'.padEnd(w), ...STATUSES.map((s) => s.padStart(w)), 'total'.padStart(w)].join('')
  const lines = [head]
  for (const o of OUTCOMES) {
    const total = STATUSES.reduce((n, s) => n + t[o][s], 0)
    lines.push([o.padEnd(w), ...STATUSES.map((s) => String(t[o][s]).padStart(w)), String(total).padStart(w)].join(''))
  }
  return lines.join('\n')
}

export function renderLost(rows: CensusRow[]): string {
  const lost = rows.filter((r) => r.status === 'LOST')
  return lost.map((r) => `  LOST ${r.call.name} ${r.call.id} (${r.call.outcome}) ${JSON.stringify(inputNeedle(r.call.input) || JSON.stringify(r.call.input).slice(0, 80))}`).join('\n')
}

// ── The store, read-only ───────────────────────────────────────────────

export function storeViewOf(db: DatabaseSync): StoreView {
  const hasStagingId = (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).some((c) => c.name === 'tool_use_id')
  const byId = db.prepare("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.tool_use_id') = ? LIMIT 1")
  const staged = hasStagingId ? db.prepare('SELECT 1 FROM staging WHERE tool_use_id = ? AND processed = 0 LIMIT 1') : null
  const nodes = db.prepare(
    "SELECT content, json_extract(metadata_json, '$.tool_use_id') AS tool_use_id FROM nodes " +
    "WHERE json_extract(metadata_json, '$.session_id') = ? AND json_extract(metadata_json, '$.tool_name') = ?")
  const cache = new Map<string, Array<{ text: string; toolUseId: string | null }>>()
  return {
    hasNodeWithId: (id) => byId.get(id) !== undefined,
    hasStagedWithId: (id) => (staged ? staged.get(id) !== undefined : false),
    nodesOf: (session, tool) => {
      const key = `${session}\n${tool}`
      let hit = cache.get(key)
      if (!hit) {
        hit = (nodes.all(session, tool) as Array<{ content: string | Uint8Array; tool_use_id: string | null }>)
          .map((r) => ({ text: decodeContent(r.content as string | Uint8Array), toolUseId: r.tool_use_id ?? null }))
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

export function listedEvents(): string[] {
  return (JSON.parse(readFileSync(EVENTS_JSON, 'utf8')) as { events: Array<{ event: string }> }).events.map((e) => e.event)
}

// ── CLI ────────────────────────────────────────────────────────────────

const HELP = `capture-census: count a real Claude Code session's tool calls against the store

  npm run dogfood:census -- --transcript <session.jsonl> [--transcript ...] [--since <ISO date>] [--project <dir>]
  npm run dogfood:census -- --session <id> [--since <ISO date>] [--project <dir>]
  npm run dogfood:census -- --live [--probe-event <Name> ...]
  npm run dogfood:census -- --help

--transcript  a session transcript (repeatable); the subagent transcripts under
              <session>/subagents/ are included
--session     a session id, resolved under ~/.claude/projects/ for the project
              directory (--project, default: the current directory)
--since       only calls made at or after this moment
--project     the project directory whose store is read (default: the one the
              transcript ran in, else the current directory)
--live        run one real headless session (claude -p, haiku) in a fresh
              temporary project with the installed hooks and one of each
              outcome: a success, a failing Bash, a Read of a missing file, an
              Edit that is rejected, a Write that is denied and a parallel
              pair; then count it, and name every event the client fired that
              tests/fixtures/claude-code-hooks/events.json does not hold.
              Needs the build under test installed globally
--probe-event an extra hook event name for --live to register (repeatable); an
              event the client has can only be seen if its name is registered

Statuses: stored, staged (in staging, not yet drained), deduplicated (inferred:
session-scoped dedup), before-id (inferred: stored before ids were), LOST.
Exit 1 when any call is LOST or --live saw an unlisted event.`

interface Args { transcripts: string[]; session: string | null; since: Date | undefined; project: string | null; live: boolean; probes: string[]; help: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = { transcripts: [], session: null, since: undefined, project: null, live: false, probes: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    const v = (): string => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x }
    if (k === '--transcript') a.transcripts.push(resolve(v()))
    else if (k === '--session') a.session = v()
    else if (k === '--since') { const d = new Date(v()); if (Number.isNaN(d.getTime())) throw new Error('--since needs an ISO date'); a.since = d }
    else if (k === '--project') a.project = resolve(v())
    else if (k === '--live') a.live = true
    else if (k === '--probe-event') a.probes.push(v())
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

function report(rows: CensusRow[], store: { name: string; path: string }): boolean {
  console.log(`store: ${store.name}`)
  console.log(`calls: ${rows.length}\n`)
  console.log(renderTable(rows))
  const inferred = rows.filter((r) => r.status === 'deduplicated' || r.status === 'before-id').length
  if (inferred > 0) console.log(`\n${inferred} call(s) are deduplicated or before-id: those two statuses are inferred from session, tool name and input text, not matched by id.`)
  const lost = renderLost(rows)
  if (lost) console.log(`\n${rows.filter((r) => r.status === 'LOST').length} call(s) LOST:\n${lost}`)
  return lost === ''
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
    return report(classify(calls, storeViewOf(store.db)), store) ? 0 : 1
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

/** Poll until the store holds no unprocessed staging row of the session, or
 *  `timeoutMs` passes. Returns the unprocessed count at the end. Only a
 *  running `treecontext serve` drains staging (IngestionLoop, every
 *  INGESTION_TICK_MS), so with none running nothing will change. */
function waitForDrain(dir: string, session: string, timeoutMs: number): { remaining: number; waitedMs: number } {
  const started = Date.now()
  for (;;) {
    let remaining = 0
    try {
      const s = openProjectStore(dir)
      try { remaining = (s.db.prepare('SELECT count(*) AS n FROM staging WHERE session_id = ? AND processed = 0').get(session) as { n: number }).n } finally { s.db.close() }
    } catch { remaining = 1 }
    if (remaining === 0 || Date.now() - started >= timeoutMs) return { remaining, waitedMs: Date.now() - started }
    spawnSync('sleep', ['1'])
  }
}

function censusLive(a: Args): number {
  const listed = new Set(listedEvents())
  const probes = ['ProbeUnlistedEventA', 'ProbeUnlistedEventB', ...a.probes]
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-census-')))
  let exit = 0
  try {
    writeFileSync(join(dir, 'seed.txt'), 'census seed\n')
    const dump = join(dir, '.census-events.ndjson')
    const hooks: Record<string, unknown> = {}
    for (const ev of [...listed, ...probes]) {
      hooks[ev] = [{ hooks: [{ type: 'command', command: `cat >> '${dump}'; echo >> '${dump}'` }] }]
    }
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
    for (const [k, n] of [...fired].sort()) console.log(`  ${k.padEnd(22)} ${n}${listed.has(k) ? '' : '   NOT ON THE LIST'}`)
    // A registered name the client has is an event the list lacks; a name it
    // does not have never fires (the client ignores it).
    const unlisted = [...fired.keys()].filter((k) => !listed.has(k))
    if (unlisted.length > 0) { exit = 1; console.log(`\nthe client fired events events.json does not hold: ${unlisted.join(', ')}`) }

    const transcript = events.map((e) => e['transcript_path']).find((p): p is string => typeof p === 'string')
    const session = events.map((e) => e['session_id']).find((p): p is string => typeof p === 'string')
    if (!transcript || !session) throw new Error('the recorded events name no transcript or session')
    const drain = waitForDrain(dir, session, 60_000)
    console.log(drain.remaining === 0
      ? `\nstaging drained (waited ${(drain.waitedMs / 1000).toFixed(0)}s)`
      : `\n${drain.remaining} staged row(s) not drained after ${(drain.waitedMs / 1000).toFixed(0)}s: only a running treecontext server drains staging, none runs now; counting them as staged`)
    const store = openProjectStore(dir)
    try {
      const rows = classify(callsOf(transcript), storeViewOf(store.db))
      console.log('')
      if (!report(rows, store)) exit = 1
      console.log(`\nthe temporary project is bound to store "${store.name}"; remove it with: treecontext stores rm ${store.name} --yes`)
      console.log('(not removed here: the name is derived from the project path, and this script does not own the bindings file)')
    } finally { store.db.close() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    console.log(`removed ${dir}`)
  }
  return exit
}

function main(): number {
  const a = parseArgs(process.argv.slice(2))
  if (a.help) { console.log(HELP); return 0 }
  return a.live ? censusLive(a) : censusTranscripts(a)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exit(main()) } catch (e) { console.error(`capture-census: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) }
}
