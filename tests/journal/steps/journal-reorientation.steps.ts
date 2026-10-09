import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { FlatStore } from '../../../src/flat-store.js'
import { writeSessionBeacon } from '../../../src/session-beacon.js'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { mcpOver, parseTool, rawAll } from '../world.js'
import { TS_ROOT, tsxArgv, killAndWait } from '../proc.js'
import { spawnCli, sandboxedSpawnEnv, type CliSpawnResult } from '../../helpers/cli-spawn.js'
import {
  type CaptureWorld, type HookRun, openCaptureSandbox, runHook, hookJson, writeTranscript,
  expectBookmarkAsked, expectAgentMayStop, seedCheckpointAge,
} from '../capture-harness.js'

// ── journal-reorientation ───────────────────────────────────────────────
//
// D188: every Then reads what treecontext produces — the packet the
// session-start hook emits on a /clear (its additionalContext), the sign
// it shows the developer (its systemMessage), the Stop hook's decision,
// the CLI's echo, status and search over the real MCP surface. Never the
// model's reply. The hooks run as real subprocesses with Claude
// Code-shaped stdin against the sandboxed store the production resolve
// chain derives; seeds go in through the library in the shapes the
// journal really holds (a checkpoint as the MCP insert stamps it, a
// developer turn as ingestion drains it), or through the MCP insert tool
// itself where the write path is part of the claim.

/** The reorientation wave's world: the capture sandbox plus what the
 *  scenarios carry from a Given to a Then. */
export interface ReorientationWorld extends CaptureWorld {
  /** The last session-start run, and the packet + sign it emitted. */
  ssRun?: HookRun
  packet?: string
  sign?: string
  /** Every packet the scenario produced, in order (the nudge cadence). */
  packets?: string[]
  /** Seeded ids and texts the Thens name. */
  chapterId?: string
  chapterText?: string
  bookmarkIds?: string[]
  bookmarkText?: string
  turnTexts?: string[]
  /** The stop hook's runs, in order. */
  stopRuns?: HookRun[]
  /** The CLI's run (config echo, doctor). */
  cli?: CliSpawnResult
  /** A process with the store merely open (a server stand-in). */
  reader?: ChildProcess
  readerPid?: number
  /** The process holding the store locked, and its pid. */
  locker?: ChildProcess
  lockerPid?: number
  /** A parsed MCP response (status or query). */
  panel?: Record<string, unknown>
  /** The valve child's report and streams. */
  valve?: { out: string; err: string; status: number | null; report: Record<string, unknown> }
  /** The machine's zone for the hooks, when a scenario pins its day. */
  tz?: string
  /** The store is read-only for this session. */
  readOnly?: boolean
  /** The session id the world began with — the root of its /clear chain. */
  rootSession?: string
  /** The session id the current MCP client stamps. */
  clientSession?: string
  /** Every id the session has had, oldest first. */
  chainIds?: string[]
  /** Packet sizes measured, for the report. */
  packetChars?: number
}

const LOCKER = fileURLToPath(new URL('../../helpers/store-locker.cjs', import.meta.url))
const READER = fileURLToPath(new URL('../../helpers/store-reader.cjs', import.meta.url))
const VALVE_CHILD = fileURLToPath(new URL('../../helpers/valve-child.ts', import.meta.url))

/** The sandbox and an open store at the derived path, with the valve
 *  parked so tens of thousands of seeds never trigger a sweep mid-Given. */
export async function openWorld(w: ReorientationWorld): Promise<void> {
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
    ownsDatabase: true,
    retentionInterval: 1_000_000_000,
  })
  w.defer(() => store.close())
  w.store = store
  w.rootSession = w.sessionId!
  // The session started as Claude Code starts one: the startup
  // SessionStart wrote the pid beacon naming it. The hooks this world
  // spawns are children of this process, so their ppid is this pid.
  writeSessionBeacon(w.dbPath!, process.pid, w.sessionId!, w.proj!, { rewrite: true })
}

export const now = (): number => Date.now() / 1000

async function turn(w: ReorientationWorld, text: string, at: number): Promise<void> {
  await w.store!.insert(text, { metadata: { source: 'auto-capture', role: 'user', session_id: w.sessionId }, createdAt: at })
}

export async function toolEntry(w: ReorientationWorld, text: string, at: number): Promise<void> {
  await w.store!.insert(text, { metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: w.sessionId }, createdAt: at })
}

/** A checkpoint as the MCP insert stamps it: the server resolves the
 *  Claude Code session and writes _cc_session_id; `kind` makes a bookmark. */
async function checkpoint(w: ReorientationWorld, text: string, at: number, kind?: 'bookmark'): Promise<string> {
  const meta: Record<string, unknown> = { next_session: true, _cc_session_id: w.sessionId }
  if (kind) meta['kind'] = kind
  return (await w.store!.insert(text, { metadata: meta, createdAt: at })).nodeId
}

/** The same through the real MCP insert tool (session stamped by the
 *  server), then dated where the scenario needs it. */
export async function mcpCheckpoint(
  w: ReorientationWorld, text: string, opts: { kind?: 'bookmark'; supersedes?: string[]; at?: number } = {},
): Promise<string> {
  // After a /clear the server resolves the NEW session id: a fresh client
  // per id, as the agent's own server would stamp it.
  if (!w.client || w.clientSession !== w.sessionId) {
    await mcpOver(w, { ccSessionId: w.sessionId! })
    w.clientSession = w.sessionId!
  }
  const client = w.client!
  // A bookmark is written as the stop hook's reason asks, but the store
  // must not depend on the writer remembering next_session: here the
  // bookmark carries its kind alone.
  const metadata: Record<string, unknown> = opts.kind ? { kind: opts.kind } : { next_session: true }
  const res = parseTool(await client.callTool({
    name: 'treecontext_insert',
    arguments: { content: text, metadata, ...(opts.supersedes ? { supersedes: opts.supersedes } : {}) },
  }))
  const id = res['node_id'] as string
  if (opts.at !== undefined) {
    const raw = new BetterSqlite3(w.dbPath!)
    try { raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(opts.at, id) } finally { raw.close() }
  }
  return id
}

/** Any note through the real MCP insert tool, under the current
 *  session's own server (a subagent shares its orchestrator's session id
 *  and server), with the metadata the caller names, dated where the
 *  scenario needs it. Returns the tool's parsed reply. */
export async function mcpNote(
  w: ReorientationWorld, text: string, metadata: Record<string, unknown>, opts: { supersedes?: string[]; at?: number } = {},
): Promise<Record<string, unknown>> {
  if (!w.client || w.clientSession !== w.sessionId) {
    await mcpOver(w, { ccSessionId: w.sessionId! })
    w.clientSession = w.sessionId!
  }
  const res = parseTool(await w.client!.callTool({
    name: 'treecontext_insert',
    arguments: { content: text, metadata, ...(opts.supersedes ? { supersedes: opts.supersedes } : {}) },
  }))
  if (opts.at !== undefined) {
    const raw = new BetterSqlite3(w.dbPath!)
    try { raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?').run(opts.at, res['node_id']) } finally { raw.close() }
  }
  return res
}

/** A real /clear (D216): Claude Code mints a NEW session id and fires
 *  SessionStart with source "clear" under it, while the pid beacon still
 *  names the session the clear ends. */
export function clear(w: ReorientationWorld, env: Record<string, string> = w.tz ? { TZ: w.tz } : {}): string {
  writeTranscript(w, 'the turn before the clear')
  w.chainIds = [...(w.chainIds ?? [w.sessionId!])]
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
  w.chainIds.push(w.sessionId)
  const run = runHook(w, 'session-start', {
    hook_event_name: 'SessionStart', source: 'clear', transcript_path: join(w.proj!, 'transcript.jsonl'),
  }, env)
  w.ssRun = run
  const out = hookJson(run.stdout)
  const packet = String((out?.['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'] ?? '')
  w.packet = packet
  w.sign = String(out?.['systemMessage'] ?? '')
  w.packets = [...(w.packets ?? []), packet]
  w.packetChars = packet.length
  return packet
}

function stop(w: ReorientationWorld, active = false): HookRun {
  // As Claude Code sends it (D249): the transcript still ends at the turn
  // before, and the turn that just ended rides in last_assistant_message.
  writeTranscript(w, `assistant turn before ${randomBytes(3).toString('hex')}`)
  const run = runHook(w, 'stop', {
    hook_event_name: 'Stop', stop_hook_active: active, transcript_path: join(w.proj!, 'transcript.jsonl'),
    last_assistant_message: `assistant turn ${randomBytes(3).toString('hex')}`,
  }, w.clockNow !== undefined ? { VITEST: 'true', TREECONTEXT_TEST_NOW: String(w.clockNow) } : {})
  w.stopRuns = [...(w.stopRuns ?? []), run]
  return run
}

export const lines = (p: string): string[] => p.split('\n')
const listed = (p: string): string[] => lines(p).filter((l) => /^ {2}- "/.test(l))

/** The CLI under the sandbox home, from the project directory, with the
 *  bindings file the hooks use — so it resolves the session's own store. */
function cli(w: ReorientationWorld, args: string[]): CliSpawnResult {
  const r = spawnCli(args, {
    home: w.home!, cwd: w.proj!,
    env: { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') },
  })
  w.cli = r
  return r
}

async function lockStore(w: ReorientationWorld): Promise<void> {
  const child = spawn(process.execPath, [LOCKER, w.dbPath!], { stdio: ['ignore', 'pipe', 'inherit'] })
  w.locker = child
  w.defer(killAndWait(child))
  let seen = ''
  await new Promise<void>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error(`locker never locked: ${seen}`)), 20_000)
    child.stdout!.on('data', (c: Buffer) => {
      seen += c.toString()
      const m = /locked (\d+)/.exec(seen)
      if (m) { clearTimeout(bail); w.lockerPid = Number(m[1]); resolve() }
    })
    child.on('exit', (code) => { clearTimeout(bail); reject(new Error(`locker exited ${code}: ${seen}`)) })
  })
  // The fixture is discriminating: the locker announces the lock only
  // after a SEPARATE process was shut out by it (see store-locker.cjs). The
  // proof is not re-run here, in the test worker: SQLite's unix VFS keeps
  // one lock table per process, so a probe from this process is no
  // witness for the hook and doctor, which run as processes of their own.
  expect(w.lockerPid).toBeGreaterThan(0)
}

export async function statusPanel(w: ReorientationWorld): Promise<Record<string, unknown>> {
  const client = w.client ?? await mcpOver(w, { ccSessionId: w.sessionId! })
  w.panel = parseTool(await client.callTool({ name: 'treecontext_status', arguments: {} }))
  return w.panel
}

type Pointer = { node_id: string; kind: string; supersedes?: string[] }
const pointers = (panel: Record<string, unknown>): Pointer[] => (panel['resume_pointers'] as Pointer[] | undefined) ?? []

async function search(w: ReorientationWorld, q: string): Promise<string[]> {
  const client = w.client ?? await mcpOver(w, { ccSessionId: w.sessionId! })
  w.panel = parseTool(await client.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 10 } }))
  return (w.panel['results'] as Array<{ nodeId: string }>).map((r) => r.nodeId)
}

/** "19 rounds and 44 minutes", "21 rounds", "a bookmark 1 round" … */
function parseAge(text: string): { rounds: number; minutes: number } {
  const r = /(\d+) rounds?/.exec(text)
  const m = /(\d+) minutes?/.exec(text)
  return { rounds: r ? Number(r[1]) : 0, minutes: m ? Number(m[1]) : 0 }
}

/** A long single-line text of exactly `n` characters. */
const longLine = (head: string, n: number): string => (head + ' ' + 'x'.repeat(n)).slice(0, n)

export const reorientationDefiner = (reg: Registry<ReorientationWorld>): void => {
  // The machine's local day is moved the way a machine's is: its zone.
  // Etc/GMT+12 and Etc/GMT-14 are 26 hours apart, so a clear under the
  // second always falls on a later local date than one under the first.
  const TODAY = { TZ: 'Etc/GMT+12' }
  const TOMORROW = { TZ: 'Etc/GMT-14' }
  // ── the packet carries the chapter, the bookmark and the tail (D187) ──
  reg.define(/^a session whose newest chapter summary is 3 days old and reads "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    await openWorld(w)
    w.chapterText = text
    w.chapterId = await checkpoint(w, text, now() - 3 * 86400 - 60)
  })
  reg.define(/^its newest bookmark is 40 minutes old, reads "([^"]+)", with (\d+) entries between the chapter and the bookmark$/, async (w, text$, n$) => {
    const [text, n] = [String(text$), String(n$)]
    const chapterAt = now() - 3 * 86400 - 60
    const bookmarkAt = now() - 40 * 60 - 20
    const between = Number(n)
    const step = (bookmarkAt - chapterAt) / (between + 1)
    for (let i = 0; i < between; i++) {
      await toolEntry(w, `between entry ${i}: npm test run ${i} ${randomBytes(3).toString('hex')}`, chapterAt + step * (i + 1))
    }
    w.bookmarkText = text
    w.bookmarkIds = [await checkpoint(w, text, bookmarkAt, 'bookmark')]
  })
  reg.define(/^(\d+) entries since the bookmark, (\d+) of them the developer's own turns$/, async (w, total$, mine$) => {
    const [total, mine] = [String(total$), String(mine$)]
    const start = now() - 40 * 60
    w.turnTexts = []
    const nTurns = Number(mine)
    for (let i = 0; i < Number(total); i++) {
      const at = start + i * 10
      if (i % 2 === 0 && w.turnTexts.length < nTurns) {
        // Multi-line on purpose: the packet must cut each to its first line.
        const text = `turn ${w.turnTexts.length + 1}: fix the token refresh\nwith the detail on its second line ${'d'.repeat(i)}`
        w.turnTexts.push(text)
        await turn(w, text, at)
      } else {
        await toolEntry(w, `tail entry ${i}: vitest run ${randomBytes(3).toString('hex')}`, at)
      }
    }
    expect(w.turnTexts).toHaveLength(nTurns)
  })
  reg.define(/^no entry in any lane refers to the chapter or the bookmark$/, (w) => {
    const refs = rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.refs') IS NOT NULL")
    expect(refs[0]!.n).toBe(0)
  })
  reg.define(/^the developer types \/clear and sends the next prompt$/, (w) => {
    clear(w)
  })
  reg.define(/^the packet handed to the agent opens with the chapter summary and its age of 3 days$/, (w) => {
    const first = lines(w.packet!)[0]!
    expect(first).toMatch(/^Chapter summary, 3 days old/)
    expect(first).toContain(w.chapterText!)
    expect(first).toContain(w.chapterId!)
  })
  reg.define(/^the packet's chapter line is followed by a referenced-by line that reads none$/, (w) => {
    const ls = lines(w.packet!)
    const i = ls.findIndex((l) => l.startsWith('Chapter summary'))
    expect(i, 'no chapter line').toBeGreaterThanOrEqual(0)
    expect(ls[i + 1]).toBe('  referenced by: none')
  })
  reg.define(/^the packet continues with the bookmark, its age of 40 minutes, and the (\d+) entries between$/, (w, n$) => {
    const n = String(n$)
    const ls = lines(w.packet!)
    const c = ls.findIndex((l) => l.startsWith('Chapter summary'))
    const b = ls.findIndex((l) => l.startsWith('Bookmark'))
    expect(b, 'the bookmark does not follow the chapter').toBe(c + 2)
    expect(ls[b]).toMatch(/^Bookmark, 40 minutes old/)
    expect(ls[b]).toContain(`${n} entries between it and the chapter summary`)
    expect(ls[b]).toContain(w.bookmarkText!)
  })
  reg.define(/^the packet's bookmark line is followed by a referenced-by line that reads none$/, (w) => {
    const ls = lines(w.packet!)
    const b = ls.findIndex((l) => l.startsWith('Bookmark'))
    expect(ls[b + 1]).toBe('  referenced by: none')
  })
  reg.define(/^the packet lists the newest 5 of the developer's turns since the bookmark and states that (\d+) were omitted$/, (w, omitted$) => {
    const omitted = String(omitted$)
    const shown = listed(w.packet!)
    expect(shown).toHaveLength(5)
    // The newest five, oldest first: turns 8..12 of 12.
    const newest = w.turnTexts!.slice(-5)
    shown.forEach((l, i) => expect(l).toContain(`"${newest[i]!.split('\n')[0]}"`))
    expect(w.packet!).toContain(`(${omitted} older turns omitted)`)
    expect(w.packet!).toContain(`${w.turnTexts!.length} of them your turns`)
  })
  reg.define(/^each listed turn is cut to its first line with its character count$/, (w) => {
    const newest = w.turnTexts!.slice(-5)
    listed(w.packet!).forEach((l, i) => {
      expect(l).toBe(`  - "${newest[i]!.split('\n')[0]}" (${newest[i]!.length} characters)`)
    })
  })
  reg.define(/^the packet ends with the one-line reminder of how to leave a chapter summary$/, (w) => {
    const last = lines(w.packet!).at(-1)!
    expect(last).toMatch(/^To leave a chapter summary/)
    expect(last).toContain('next_session=true')
  })

  // ── no checkpoint: recent entries, and the once-a-day nudge (D198) ──
  const NUDGE = /leave a chapter summary/i
  reg.define(/^a session holding (\d+) journal entries and no checkpoint of either kind$/, async (w, n$) => {
    const n = String(n$)
    await openWorld(w)
    const total = Number(n)
    const start = now() - 3600
    w.turnTexts = []
    for (let i = 0; i < total; i++) {
      if (i % 3 !== 2) {
        const text = `request ${w.turnTexts.length + 1}: wire the login form`
        w.turnTexts.push(text)
        await turn(w, text, start + i * 30)
      } else {
        await toolEntry(w, `tool output ${i} ${randomBytes(3).toString('hex')}`, start + i * 30)
      }
    }
    expect(w.turnTexts.length).toBeGreaterThan(5) // so "the newest 5" is a cut
  })
  reg.define(/^no \/clear has happened yet on the machine's local calendar day$/, (w) => {
    // The machine's day, pinned by its zone so "that same day" and "the
    // next day" are facts of the world, not of when the suite runs.
    w.tz = TODAY.TZ
    expect(rawAll(w, "SELECT key FROM store_config WHERE key LIKE 'reorient_nudge:%'")).toHaveLength(0)
  })
  // The machine's local day is moved the way a machine's is: its zone.
  // Etc/GMT+12 and Etc/GMT-14 are 26 hours apart, so a clear under the
  // second always falls on a later local date than one under the first.
  reg.define(/^the packet handed to the agent says it re-oriented from the (\d+) recent entries$/, (w, n$) => {
    const n = String(n$)
    expect(lines(w.packet!)[0]).toBe(`No chapter summary or bookmark exists for this session; re-oriented from its ${n} recent entries.`)
  })
  reg.define(/^the packet lists the newest 5 of the developer's turns$/, (w) => {
    const shown = listed(w.packet!)
    expect(shown).toHaveLength(5)
    const newest = w.turnTexts!.slice(-5)
    shown.forEach((l, i) => expect(l).toBe(`  - "${newest[i]}" (${newest[i]!.length} characters)`))
    expect(w.packet!).toContain(`(${w.turnTexts!.length - 5} older turns omitted)`)
  })
  reg.define(/^the packet tells the developer once how to leave a chapter summary before the next clear$/, (w) => {
    const packet = w.packet!
    const nudge = lines(packet).filter((l) => NUDGE.test(l))
    expect(nudge, 'no nudge on the first clear of the day').toHaveLength(1)
    expect(nudge[0]).toMatch(/before the next clear/)
    // Exactly once: the mark is in the store, keyed by session and day.
    const marks = rawAll<{ key: string }>(w, "SELECT key FROM store_config WHERE key LIKE 'reorient_nudge:%'")
    expect(marks.map((m) => m.key)).toEqual([expect.stringContaining(`reorient_nudge:${w.rootSession}:`)])
  })
  reg.define(/^the packet after a second \/clear that same day carries no nudge$/, (w) => {
    const second = clear(w, TODAY)
    expect(second).not.toMatch(NUDGE)
    expect(listed(second)).toHaveLength(Math.min(5, w.turnTexts!.length)) // still a packet, only no nudge
  })
  reg.define(/^the packet after the first \/clear of the next local calendar day carries the nudge again$/, (w) => {
    const next = clear(w, TOMORROW)
    expect(lines(next).filter((l) => NUDGE.test(l))).toHaveLength(1)
    const again = clear(w, TOMORROW)
    expect(again).not.toMatch(NUDGE)
  })

  // ── bookmarks without a chapter (D158, D198) ──
  reg.define(/^a session holding two bookmarks and no chapter summary$/, async (w) => {
    await openWorld(w)
    const t0 = now() - 30 * 60
    await turn(w, 'start the login form', t0 - 60)
    const first = await mcpCheckpoint(w, 'at: login form scaffolded; next: CSRF', { kind: 'bookmark', at: t0 })
    await turn(w, 'now the CSRF token', t0 + 60)
    const second = await mcpCheckpoint(w, 'at: CSRF test failing; next: fix token', { kind: 'bookmark', at: now() - 12 * 60 - 20 })
    w.bookmarkIds = [first, second]
    w.turnTexts = ['did the token fix land?', 'run the login tests again']
    await turn(w, w.turnTexts[0]!, now() - 10 * 60)
    await turn(w, w.turnTexts[1]!, now() - 5 * 60)
  })
  reg.define(/^the packet handed to the agent opens with the newest bookmark and its age$/, (w) => {
    const first = lines(w.packet!)[0]!
    expect(first).toMatch(/^Bookmark, 12 minutes old/)
    expect(first).toContain(w.bookmarkIds!.at(-1)!)
    expect(first).toContain('at: CSRF test failing; next: fix token')
    expect(w.packet!).not.toContain(w.bookmarkIds![0]!)
  })
  reg.define(/^the packet states that no chapter summary exists$/, (w) => {
    expect(lines(w.packet!)).toContain('No chapter summary exists for this session.')
  })
  reg.define(/^the packet lists the developer's turns since that bookmark$/, (w) => {
    expect(listed(w.packet!)).toEqual(w.turnTexts!.map((t) => `  - "${t}" (${t.length} characters)`))
    expect(w.packet!).toContain('Since the bookmark:')
    expect(w.packet!).toContain('(0 older turns omitted)')
  })

  // ── the tail keeps its shape (D162) ──
  reg.define(/^a session whose newest bookmark is 10 minutes old$/, async (w) => {
    await openWorld(w)
    await turn(w, 'a turn before the bookmark', now() - 20 * 60)
    w.bookmarkIds = [await checkpoint(w, 'at: tail shape; next: keep it', now() - 10 * 60 - 20, 'bookmark')]
  })
  reg.define(/^(\d+) of the developer's turns since that bookmark$/, async (w, n$) => {
    const n = String(n$)
    const count = Number(n)
    const start = now() - 10 * 60
    w.turnTexts = []
    // Big counts go in one transaction — the library's own insert, in the
    // shape ingestion drains, just batched.
    for (let i = 0; i < count; i++) {
      const text = `tail turn ${i + 1}`
      w.turnTexts.push(text)
      await turn(w, text, start + (i * 500) / Math.max(count, 1))
    }
  })
  reg.define(/^the packet handed to the agent lists the newest (\d+) of those turns$/, (w, n$) => {
    const n = String(n$)
    const shown = listed(w.packet!)
    expect(shown).toHaveLength(Number(n))
    const newest = w.turnTexts!.slice(-Number(n))
    shown.forEach((l, i) => expect(l).toBe(`  - "${newest[i]}" (${newest[i]!.length} characters)`))
  })
  reg.define(/^the packet states that (\d+) turns were omitted$/, (w, n$) => {
    const n = String(n$)
    expect(w.packet!).toContain(`(${n} older turns omitted)`)
    expect(w.packet!).toContain(`${w.turnTexts!.length} of them your turns`)
  })
  reg.define(/^no developer turn since that bookmark$/, (w) => {
    expect(rawAll<{ n: number }>(w,
      "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.role') = 'user' AND created_at > ?",
      now() - 10 * 60 - 20)[0]!.n).toBe(0)
  })
  reg.define(/^the packet handed to the agent says in one line that no developer turn has arrived since the bookmark$/, (w) => {
    const hits = lines(w.packet!).filter((l) => /no developer turn has arrived since the bookmark/i.test(l))
    expect(hits).toHaveLength(1)
    expect(listed(w.packet!)).toHaveLength(0)
  })

  // ── a pasted log, and the budget (D162) ──
  reg.define(/^a session whose newest developer turn is a pasted log of (\d+) characters opening "([^"]+)"$/, async (w, n$, head$) => {
    const [n, head] = [String(n$), String(head$)]
    await openWorld(w)
    // The stressing world: every variable-length piece of the packet at
    // or past its clip — a long chapter, a long bookmark, long turns, and
    // more handoffs than the packet lists.
    w.chapterId = await checkpoint(w, longLine('plan: the long chapter', 6000), now() - 2 * 3600)
    for (let f = 0; f < 5; f++) {
      await w.store!.insert(`imported chapter ${f}: ${'h'.repeat(300)}`, {
        // The shape a handoff import lands (D219, D221): the sender's
        // chapter flag is a claim, the lane is the sender's own.
        metadata: {
          session_id: `handoff:teammate-${f}`, _handoff_claims: { next_session: true },
          _handoff_file: `handoffs/teammate-${f}-${'n'.repeat(80)}.json`, _handoff_sender: `teammate-${f}-${'s'.repeat(60)}`,
        },
        createdAt: now() - 3600,
      })
    }
    w.bookmarkIds = [await checkpoint(w, longLine('at: the long bookmark', 6000), now() - 3000, 'bookmark')]
    // Referrers on both checkpoints, so both referenced-by lines are full.
    for (const target of [w.chapterId, w.bookmarkIds[0]!]) {
      await w.store!.insert(longLine(`a teammate's long note on ${target}`, 2000), {
        metadata: { refs: [target], _writer: `tester-subagent-${'w'.repeat(80)}` }, createdAt: now() - 2500,
      })
    }
    for (let i = 0; i < 6; i++) await turn(w, longLine(`a long single-line turn ${i}`, 3000), now() - 2000 + i)
    // The log itself arrives through the real hook, staged and not yet
    // drained — the packet must read what the drain has not reached.
    const lines40k: string[] = [head]
    while (lines40k.join('\n').length < Number(n)) lines40k.push('npm ERR! errno 1 at some/deep/path/in/node_modules/that/goes/on')
    const log = lines40k.join('\n').slice(0, Number(n))
    expect(log.length).toBe(Number(n))
    runHook(w, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit', transcript_path: join(w.proj!, 'transcript.jsonl'), prompt: log })
    expect(rawAll(w, "SELECT 1 FROM staging WHERE role = 'user' AND processed = 0")).toHaveLength(1)
    w.turnTexts = [log]
  })
  reg.define(/^the packet handed to the agent shows that turn as "([^"]+)" and states (\d+) characters$/, (w, head$, n$) => {
    const [head, n] = [String(head$), String(n$)]
    expect(listed(w.packet!).at(-1)).toBe(`  - "${head}" (${n} characters)`)
  })
  reg.define(/^the whole packet is under 3000 characters$/, (w) => {
    expect(w.packet!.length).toBeLessThan(3000)
    expect(w.packet!.length).toBeGreaterThan(1500) // the stress reached the clips
    // Under budget by construction, not by the backstop: nothing was cut,
    // and the packet still ends with what it must end with.
    expect(lines(w.packet!).at(-1)).toMatch(/^To leave a chapter summary/)
  })

  // ── the stop hook's second duty (D156, D157, D207) ──
  reg.define(/^a session whose checkpoint interval is 20 rounds or 45 minutes$/, async (w) => {
    await openWorld(w)
    const r = cli(w, ['config', 'checkpoint-interval', '20 rounds or 45 minutes', '--no-debug'])
    expect(r.status, r.out).toBe(0)
    const [row] = rawAll<{ value: string }>(w, "SELECT value FROM store_config WHERE key = 'checkpoint_interval'")
    expect(JSON.parse(row!.value)).toMatchObject({ rounds: 20, minutes: 45 })
  })
  reg.define(/^a developer who never set a checkpoint interval$/, async (w) => {
    await openWorld(w)
    expect(rawAll(w, "SELECT 1 FROM store_config WHERE key = 'checkpoint_interval'")).toHaveLength(0)
  })
  reg.define(/^the session's newest checkpoint is (?:a bookmark )?(.+?) old$/, async (w, age$) => {
    const age = String(age$)
    const { rounds, minutes } = parseAge(age)
    await seedCheckpointAge(w, rounds, minutes, 'bookmark')
    // Then the developer clears, as the team does (D216): the stop below
    // runs under the NEW session id, and the checkpoint and its rounds
    // are the predecessor's. (A read-only store cannot record the link,
    // so that world stops in the session that wrote the checkpoint.)
    if (!w.readOnly) clear(w)
  })
  reg.define(/^the agent is about to stop its turn$/, (w) => {
    stop(w)
  })
  reg.define(/^the stop hook (lets the agent stop|asks the agent to write a bookmark before it stops)$/, (w, outcome$) => {
    const outcome = String(outcome$)
    if (outcome === 'lets the agent stop') {
      expectAgentMayStop(w.stopRuns!.at(-1)!.stdout)
      return
    }
    expectBookmarkAsked(w.stopRuns!.at(-1)!.stdout)
    // The ask restarts the interval (D216): it is recorded under the
    // payload's session, and the very next stop — not marked active, the
    // agent having ignored the ask or its bookmark gone astray — is let
    // go rather than asked again.
    expect(rawAll(w, 'SELECT 1 FROM store_config WHERE key = ?', `bookmark_asked:${w.sessionId}`)).toHaveLength(1)
    expectAgentMayStop(stop(w).stdout)
  })
  reg.define(/^with a chapter summary 1 round old in place of the bookmark, the stop hook lets the agent stop$/, async (w) => {
    // A second session of the same store, identical but for the kind.
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    await seedCheckpointAge(w, 1, 0, 'chapter')
    expectAgentMayStop(stop(w).stdout)
    // Discriminating: a chapter 21 rounds old, in a third session, is due —
    // so the stop above was let go for its age, not for its kind.
    w.sessionId = `cc-${randomBytes(6).toString('hex')}`
    await seedCheckpointAge(w, 21, 0, 'chapter')
    expectBookmarkAsked(stop(w).stdout)
  })

  // ── the interval echoed back as it will behave (D163) ──
  reg.define(/^a developer in their own session$/, async (w) => {
    await openWorld(w)
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' })
  })
  reg.define(/^the developer sets the checkpoint interval to (.+)$/, (w, value$) => {
    const value = String(value$)
    const r = cli(w, ['config', 'checkpoint-interval', value, '--no-debug'])
    expect(r.status, r.out).toBe(0)
  })
  reg.define(/^the developer sees the setting echoed back as "([^"]+)"$/, async (w, behaviour$) => {
    const behaviour = String(behaviour$)
    expect(w.cli!.stdout.split('\n')[0]).toBe(`checkpoint interval: ${behaviour}`)
    // Stored, in the store the session's hooks read…
    expect(rawAll(w, "SELECT 1 FROM store_config WHERE key = 'checkpoint_interval'")).toHaveLength(1)
    // …and it behaves as echoed (D163), at the Stop hook that reads it.
    if (behaviour === 'a bookmark at every stop') {
      await seedCheckpointAge(w, 1, 0, 'bookmark')
      expectBookmarkAsked(stop(w).stdout)
    } else {
      // Off, or effectively off: a checkpoint the default would long since
      // have tripped on (21 rounds, 50 minutes) is let go.
      await seedCheckpointAge(w, 21, 50, 'bookmark')
      expectAgentMayStop(stop(w).stdout)
    }
  })

  // ── a bookmark that cannot be written (D163) ──
  reg.define(/^a session whose store is read-only for this session$/, async (w) => {
    await openWorld(w)
    // Read-only at the file: nothing this session starts can write it.
    // (The world's own handle, opened before, seeds the Given below.)
    chmodSync(w.dbPath!, 0o444)
    w.defer(() => chmodSync(w.dbPath!, 0o600))
    w.readOnly = true
    // The once-per-session report mark lives in the temp directory.
    const sid = w.sessionId!
    w.defer(() => rmSync(join(tmpdir(), `treecontext-bookmark-unwritable-${sid}`), { force: true }))
  })
  reg.define(/^the stop hook's message to the developer reports once that the bookmark could not be written$/, (w) => {
    const out = hookJson(w.stopRuns!.at(-1)!.stdout)
    expect(String(out?.['systemMessage'] ?? '')).toMatch(/bookmark was due but could not be written — the store is read-only/)
  })
  reg.define(/^at the next stop, with the write still failing and the stop hook already active, the stop hook lets the agent stop without asking$/, (w) => {
    const run = stop(w, true)
    expect(hookJson(run.stdout)?.['decision']).toBeUndefined()
  })
  reg.define(/^the stop hook's message to the developer at that next stop carries no repeat of the report$/, (w) => {
    const prior = hookJson(w.stopRuns!.at(-2)!.stdout)?.['systemMessage']
    expect(String(prior), 'the report this denies a repeat of').toMatch(/could not be written/)
    expect(hookJson(w.stopRuns!.at(-1)!.stdout)?.['systemMessage']).toBeUndefined()
    // Once per session, not once per active stop: a later turn's stop,
    // stop_hook_active false and the write still failing, says nothing
    // and does not block.
    const later = stop(w, false)
    expect(hookJson(later.stdout)).toBeNull()
  })

  // ── bookmark supersession and search (D166) ──
  reg.define(/^a session in which 3 bookmarks were written(?:, the oldest reading "([^"]+)")?$/, async (w, oldest$) => {
    const oldest = typeof oldest$ === 'string' ? oldest$ : undefined
    await openWorld(w)
    const texts = [oldest ?? 'at: first bookmark', 'at: second bookmark, CSRF next', 'at: third bookmark, tests green']
    w.bookmarkIds = []
    // A /clear between bookmarks, as the team works (D216): each bookmark
    // lands under a new session id, and still supersedes the one before.
    for (const [i, t] of texts.entries()) {
      if (i > 0) clear(w)
      w.bookmarkIds.push(await mcpCheckpoint(w, t, { kind: 'bookmark' }))
    }
    expect(new Set(rawAll<{ s: string }>(w,
      "SELECT json_extract(metadata_json, '$._cc_session_id') AS s FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'bookmark'").map((r) => r.s)).size).toBe(3)
  })
  reg.define(/^the developer calls status$/, async (w) => {
    await statusPanel(w)
  })
  reg.define(/^the developer sees exactly one live bookmark for that session, the newest$/, (w) => {
    const live = pointers(w.panel!).filter((p) => p.kind === 'bookmark')
    expect(live.map((p) => p.node_id)).toEqual([w.bookmarkIds!.at(-1)])
    // The two older ones were superseded, not removed.
    const rows = rawAll<{ node_id: string; by: string | null }>(w,
      "SELECT node_id, json_extract(metadata_json, '$.superseded_by') AS by FROM nodes WHERE node_id IN (?, ?)",
      w.bookmarkIds![0], w.bookmarkIds![1])
    expect(rows.map((r) => r.by)).toEqual([expect.any(String), expect.any(String)])
  })
  reg.define(/^the developer searches "([^"]+)"$/, async (w, q$) => {
    const q = String(q$)
    w.nodeIds = await search(w, q)
  })
  reg.define(/^the developer finds the oldest bookmark$/, (w) => {
    expect(w.nodeIds).toContain(w.bookmarkIds![0])
    expect(rawAll<{ live: number | null }>(w,
      "SELECT json_extract(metadata_json, '$.next_session') AS live FROM nodes WHERE node_id = ?", w.bookmarkIds![0])[0]!.live).toBeNull()
  })

  // ── status labels each pointer's kind (D158) ──
  reg.define(/^a session holding one live chapter summary and one live bookmark$/, async (w) => {
    await openWorld(w)
    w.chapterId = await mcpCheckpoint(w, 'plan: wire the login form; next: write its tests')
    w.bookmarkIds = [await mcpCheckpoint(w, 'at: login form wired; next: tests', { kind: 'bookmark' })]
  })
  reg.define(/^the developer sees each live pointer carry its kind, chapter summary or bookmark$/, (w) => {
    const ps = pointers(w.panel!)
    expect(ps.find((p) => p.node_id === w.chapterId)?.kind).toBe('chapter summary')
    expect(ps.find((p) => p.node_id === w.bookmarkIds![0])?.kind).toBe('bookmark')
    expect(ps.every((p) => p.kind === 'chapter summary' || p.kind === 'bookmark')).toBe(true)
  })

  // ── a chapter outranks a bookmark (D183) ──
  reg.define(/^a bookmark written after a chapter summary, both containing "([^"]+)"$/, async (w, phrase$) => {
    const phrase = String(phrase$)
    await openWorld(w)
    // The bookmark is the newer AND the lexically stronger (shorter)
    // match — pure BM25 with recency puts it first; only the kind ranks
    // the chapter above it.
    w.chapterId = await mcpCheckpoint(w, `plan: ${phrase} lands before the login form ships; next: wire the retry path, then the expiry banner, then the tests`, { at: now() - 3600 })
    w.bookmarkIds = [await mcpCheckpoint(w, `at: ${phrase}`, { kind: 'bookmark' })]
  })
  reg.define(/^the developer sees the chapter summary ranked above the bookmark$/, (w) => {
    const ids = w.nodeIds!
    expect(ids).toContain(w.bookmarkIds![0])
    expect(ids.indexOf(w.chapterId!), `ranking: ${ids.join(', ')}`).toBeLessThan(ids.indexOf(w.bookmarkIds![0]!))
  })

  // ── the capture sign (D171) ──
  reg.define(/^a fresh session with capture on$/, (w) => {
    openCaptureSandbox(w)
  })
  reg.define(/^a fresh session whose store cannot be opened$/, (w) => {
    openCaptureSandbox(w)
    mkdirSync(dirname(w.dbPath!), { recursive: true })
    writeFileSync(w.dbPath!, 'this is not a SQLite database, it is a text file left where the store should be\n'.repeat(100))
  })
  reg.define(/^the session starts$/, (w) => {
    const run = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: join(w.proj!, 'transcript.jsonl') })
    w.ssRun = run
    w.sign = String(hookJson(run.stdout)?.['systemMessage'] ?? '')
  })
  reg.define(/^the session-start hook's message to the developer names the store the session journals into$/, (w) => {
    const name = basename(dirname(w.dbPath!))
    expect(w.sign).toContain(`journals into store "${name}"`)
    expect(w.sign).toContain(w.dbPath!)
    // And it is that store the session journals into: the hook minted it.
    expect(rawAll(w, "SELECT 1 FROM sqlite_master WHERE name = 'staging'")).toHaveLength(1)
  })
  reg.define(/^the session-start hook's message to the developer says that the session is not being journaled and why$/, (w) => {
    expect(w.sign).toMatch(/this session is NOT being journaled/)
    expect(w.sign).toContain(w.dbPath!)
    expect(w.sign).toMatch(/file is not a database/)
  })

  // ── a locked store (D175) ──
  reg.define(/^a session whose store is locked by another process(?: at the moment of a \/clear)?$/, async (w) => {
    await openWorld(w)
    w.chapterId = await checkpoint(w, 'plan: survive a locked store; next: doctor', now() - 600)
    await turn(w, 'is the store locked?', now() - 60)
    // This process lets go of the store first: an idle WAL reader would
    // otherwise keep the locker from ever taking it.
    await w.store!.close()
    await lockStore(w)
    // And a process that merely has the store open, as a running server
    // does: not the cause, and never to be killed for it.
    const reader = spawn(process.execPath, [READER, w.dbPath!], { stdio: ['ignore', 'pipe', 'inherit'] })
    w.reader = reader
    w.defer(killAndWait(reader))
    w.readerPid = await new Promise<number>((resolve, reject) => {
      let seen = ''
      const bail = setTimeout(() => reject(new Error(`reader never opened: ${seen}`)), 20_000)
      reader.stdout!.on('data', (c: Buffer) => {
        seen += c.toString()
        const m = /open (\d+)/.exec(seen)
        if (m) { clearTimeout(bail); resolve(Number(m[1])) }
      })
    })
  })
  reg.define(/^the packet handed to the agent says what it could not read$/, (w) => {
    expect(w.packet!).toMatch(/could not read this session's journal/)
    expect(w.packet!).toMatch(/locked by another process/)
    expect(w.packet!).toMatch(/No chapter summary, bookmark or recent developer turn was read/)
  })
  reg.define(/^the session-start hook exits within its timeout without blocking the prompt$/, (w) => {
    const run = w.ssRun!
    expect(run.status).toBe(0)
    // Bound to the 1.5 s clear-read budget, not to the 8 s write budget a
    // hook would wait out without it (and well inside VS Code's 10 s).
    expect(run.ms, `session-start took ${run.ms} ms`).toBeLessThan(4_000)
    expect(hookJson(run.stdout)?.['decision']).toBeUndefined()
  })
  reg.define(/^the developer runs doctor$/, (w) => {
    cli(w, ['doctor', '--no-debug'])
  })
  reg.define(/^the developer sees the lock named as the cause and one command that clears it$/, async (w) => {
    const out = w.cli!.stdout
    const ls = out.split('\n')
    const i = ls.findIndex((l) => /^\[err\]\s+Store lock: .* is locked by another process/.test(l))
    expect(i, out).toBeGreaterThanOrEqual(0)
    expect(ls[i]).toContain(`pid ${w.lockerPid}`)
    const fix = /^\s+fix: (.+)$/.exec(ls[i + 1] ?? '')?.[1]
    expect(fix, 'no fix command under the lock row').toBeDefined()
    // Two honest shapes of the same ruling. Linux reads /proc/locks and
    // names the write-lock holder exactly, so the fix kills that one and
    // the reader is left be. Darwin's lsof cannot see fcntl locks, and
    // Windows has no lock-holder API without native code, so there doctor
    // says it cannot tell, calls nobody "not the cause", and its one
    // command stops every process with the store open — which, D175's
    // point, still clears it.
    if (process.platform === 'linux') {
      expect(fix).toBe(`kill ${w.lockerPid}`)
      // The reader is named as open and not the cause — and is not in the kill.
      expect(ls[i]).toContain(`not the cause: pid ${w.readerPid}`)
      // The one command clears it: run it, and the store reads again.
      const r = spawnSync('sh', ['-c', fix!], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      if (w.locker!.exitCode === null && w.locker!.signalCode === null) await once(w.locker!, 'exit')
      expect(() => process.kill(w.readerPid!, 0), 'the fix killed the reader').not.toThrow()
    } else {
      const os = process.platform === 'win32' ? 'Windows' : 'macOS'
      expect(ls[i]).toContain(`${os} cannot say which of the processes holding it open owns the lock`)
      expect(ls[i]).toContain(`pid ${w.readerPid}`)
      // step-lint: allow unearned-absence -- guarded: the Linux branch above proves the needle (`not the cause: pid` asserted present in the same row shape), and the positive claim this row must carry ("cannot say which ... owns the lock") is asserted just above
      expect(ls[i]).not.toContain('not the cause')
      expect(fix).toMatch(process.platform === 'win32' ? /^taskkill \/F (\/PID \d+ ?)+/ : /^kill (\d+ ?)+/)
      const killed = [...fix!.split(/\s+#|\s+&\s+rem\b/)[0]!.matchAll(/\d+/g)].map((m) => Number(m[0]))
      expect(killed).toEqual(expect.arrayContaining([w.lockerPid, w.readerPid]))
      // Both must be gone afterwards; a bounded wait, never a hang.
      const gone = async (c: ChildProcess): Promise<void> => {
        if (c.exitCode !== null || c.signalCode !== null) return
        let timer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            once(c, 'exit'),
            new Promise((_, no) => { timer = setTimeout(() => no(new Error(`pid ${c.pid} outlived the fix`)), 10_000) }),
          ])
        } finally { clearTimeout(timer) }
      }
      const exits = Promise.all([gone(w.locker!), gone(w.reader!)])
      exits.catch(() => undefined)   // awaited below; never an unhandled rejection if an expect throws first
      // The one command clears it: run it through the platform shell.
      const r = process.platform === 'win32'
        ? spawnSync(fix!, { encoding: 'utf8', shell: true })
        : spawnSync('sh', ['-c', fix!], { encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      await exits
    }
    const db = new BetterSqlite3(w.dbPath!, { readonly: true, timeout: 2000 })
    try { expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0) } finally { db.close() }
  })

  // ── a sprint past the byte budget asks nothing (D178) ──
  reg.define(/^a store pushed past its byte budget in the middle of a sprint$/, async (w) => {
    await openWorld(w)
    // The sprint's session started through the real hook: the project is
    // bound to this store, as it is for the developer.
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' })
    // Earlier sessions of the sprint, then this one: incompressible
    // captures, so the bytes are real.
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 8; i++) {
        await w.store!.insert(`sprint session ${s} output ${i}: ${randomBytes(2000).toString('base64')}`, {
          // As capture stages treasure: kept in full behind a bounded
          // preview (_index_len), the shape the valve demotes.
          metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash', session_id: `cc-sprint-${s}`, _index_len: 40 },
          createdAt: now() - (5 - s) * 3600 + i,
        })
      }
    }
    await checkpoint(w, 'plan: keep sprinting; next: the login tests', now() - 120)
    await turn(w, 'keep going', now() - 60)
    const bytes = w.store!.status().retention!.storeBytes
    expect(bytes).toBeGreaterThan(40_000)
    await w.store!.close()
  })
  reg.define(/^the retention valve runs$/, async (w) => {
    const child = spawn(process.execPath, tsxArgv(VALVE_CHILD, w.dbPath!, '40000'), {
      env: sandboxedSpawnEnv(w.home!), cwd: TS_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    })
    // stdin stays open and is never written: a valve that asked would hang.
    let out = ''
    let err = ''
    child.stdout!.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { err += c.toString() })
    const bail = setTimeout(() => child.kill('SIGKILL'), 60_000)
    const [status] = await once(child, 'exit') as [number | null]
    clearTimeout(bail)
    child.stdin!.destroy()
    w.valve = { out, err, status, report: JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown> }
  })
  reg.define(/^no prompt or question reaches the developer$/, (w) => {
    const v = w.valve!
    expect(v.status, `valve child: ${v.err}`).toBe(0) // it finished on its own, stdin unread
    const said = `${v.out}\n${v.err}`
    const ASKS = /\?\s*$|\(y\/n\)|\[y\/N\]|confirm|press (?:enter|any key)|are you sure/im
    expect('Store over budget. Archive old sessions? (y/n)').toMatch(ASKS) // the needle fires on a question
    expect(said).not.toMatch(ASKS)
    // Not vacuous: the valve really moved the store under its budget.
    expect(v.report['before'] as number).toBeGreaterThan(v.report['budget'] as number)
    expect(v.report['after'] as number).toBeLessThanOrEqual(v.report['budget'] as number)
  })
  reg.define(/^the developer running doctor sees the store reported healthy$/, (w) => {
    const r = cli(w, ['doctor', '--no-debug'])
    const name = basename(dirname(w.dbPath!))
    const ls = r.stdout.split('\n')
    expect(ls.find((l) => l.startsWith('[ok]   Store schema:')), r.stdout).toContain(name)
    const bad = ls.filter((l) => /^\[(warn|err)/.test(l) && (l.includes(name) || /Store|retention|budget|Capture debt/i.test(l)))
    expect(bad, r.stdout).toEqual([])
  })

  // ── a retraction (D185) ──
  reg.define(/^a session whose newest chapter summary reads "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    await openWorld(w)
    w.chapterText = text
    w.chapterId = await mcpCheckpoint(w, text, { at: now() - 3600 })
  })
  reg.define(/^the developer writes a retraction that names that chapter and reads "([^"]+)"$/, async (w, text$) => {
    const text = String(text$)
    w.bookmarkText = text // the retraction's text, carried to the Thens
    w.nodeId = await mcpCheckpoint(w, text, { supersedes: [w.chapterId!] })
  })
  reg.define(/^the developer calling status sees the retraction as the live pointer and the old chapter as superseded$/, async (w) => {
    const ps = pointers(await statusPanel(w))
    const retraction = ps.find((p) => p.node_id === w.nodeId)
    expect(retraction, 'the retraction is not a live pointer').toBeTruthy()
    expect(retraction!.kind).toBe('chapter summary')
    expect(retraction!.supersedes).toEqual([w.chapterId])
    expect(ps.map((p) => p.node_id)).not.toContain(w.chapterId)
  })
  reg.define(/^the next packet after a \/clear carries the retraction$/, (w) => {
    const packet = clear(w)
    expect(lines(packet)[0]).toContain(w.bookmarkText!)
    expect(packet).not.toContain(w.chapterText!)
  })
  reg.define(/^a session whose chapter summary "([^"]+)" was retracted by a newer entry$/, async (w, text$) => {
    const text = String(text$)
    await openWorld(w)
    w.chapterId = await mcpCheckpoint(w, text, { at: now() - 3600 })
    w.nodeId = await mcpCheckpoint(w, 'retracted: the login form stays', { supersedes: [w.chapterId] })
  })
  reg.define(/^the developer finds the retracted chapter summary$/, (w) => {
    expect(w.nodeIds).toContain(w.chapterId)
    expect(rawAll<{ by: string }>(w, "SELECT json_extract(metadata_json, '$.superseded_by') AS by FROM nodes WHERE node_id = ?", w.chapterId)[0]!.by).toBe(w.nodeId)
  })

  // ── a chapter referenced from another lane (D187, D186) ──
  // The tester's writer is a metadata claim, `agent_type: "tester"`,
  // written so the line has a writer other than the session to name: no
  // real subagent row carries one today, and the server stamping `_writer`
  // from the session registry is D190's. D187's claim is the line's shape,
  // which names whatever writer the row holds. The reference is `refs`,
  // written through the real insert tool; the packet reads it from the
  // store's reverse index through the real session-start hook.
  reg.define(/^a note from the tester subagent, (\d+) minutes old, that names that chapter and opens "([^"]+)"$/, async (w, min$, head$) => {
    const head = String(head$)
    const text = `${head}\nThe refresh endpoint rejects the token the fixture mints; the tests after step 3 cannot run until it does.`
    const res = await mcpNote(w, text, { agent_type: 'tester', refs: [w.chapterId!] }, { at: now() - Number(min$) * 60 - 5 })
    w.nodeId = res['node_id'] as string
    w.bookmarkText = text // the note's full text, carried to the Thens
    // The reverse index holds the pair, read straight from SQLite.
    expect(rawAll(w, 'SELECT node_id FROM node_refs WHERE ref_id = ?', w.chapterId)).toEqual([{ node_id: w.nodeId }])
  })
  reg.define(/^the packet's chapter line is followed by a referenced-by line naming the tester, (\d+) minutes, and "([^"]+)"$/, (w, min$, head$) => {
    const ls = lines(w.packet!)
    const i = ls.findIndex((l) => l.startsWith('Chapter summary'))
    expect(i, 'no chapter line').toBeGreaterThanOrEqual(0)
    expect(ls[i]).toContain(w.chapterId!)
    expect(ls[i + 1]).toBe(`  referenced by: ${w.nodeId}, tester, ${String(min$)} minutes old: "${String(head$)}"`)
  })
  reg.define(/^the packet does not carry the tester's note in full$/, (w) => {
    const [, rest] = w.bookmarkText!.split('\n')
    expect(w.packet!).not.toContain(rest!)
    // The needle can fire: the note's full text is in the store verbatim.
    expect(rawAll(w, 'SELECT 1 FROM nodes WHERE node_id = ?', w.nodeId)).toHaveLength(1)
    expect(w.store!.exportJson({ nodeId: w.nodeId!, recordReliance: false })).toContain(rest!)
  })
}
