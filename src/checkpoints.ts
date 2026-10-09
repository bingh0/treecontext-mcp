/**
 * Checkpoints: the two kinds, the interval that asks for a bookmark, and
 * the packet a /clear hands the agent (features/journal-reorientation.feature,
 * rulings D156-D163, D166, D183, D187, D198, D206, D207).
 *
 * Two kinds, one mechanism. A CHAPTER SUMMARY is a curated entry carrying
 * `next_session = true` — the resume pointer the journal has always had. A
 * BOOKMARK is the same with `kind = "bookmark"`, written by the agent when
 * the Stop hook asks for one. Everything here reads the store through a raw
 * better-sqlite3 handle, because the hooks that call it hold exactly that:
 * no FlatStore, no migrations, nothing a short-lived hook process cannot
 * afford. Content may be zstd-encoded and is always decoded through the
 * production codec.
 *
 * Nothing in this module decides on the agent's behalf (D187: the packet
 * discloses rather than decides): every count it knows is stated.
 */
import type { Database as DatabaseType } from 'better-sqlite3'
import { decodeContent } from './persistence/content-codec.js'
import { referencedBy, ageText, plural } from './references.js'

export { ageText, plural }

// ── Kinds ──────────────────────────────────────────────────────────

export type CheckpointKind = 'chapter' | 'bookmark'

/** The metadata value that marks a bookmark. A chapter summary carries no
 *  kind (or any other value): it is today's resume pointer, unchanged. */
export const BOOKMARK_KIND = 'bookmark'

/** BM25 multiplier for a bookmark in search (D183): a chapter outranks a
 *  bookmark the way curated notes outrank assistant prose — by a weight,
 *  not a filter, so a bookmark that is the only match still surfaces. The
 *  same 0.25 the role weights give assistant prose (persistence/fts.ts). */
export const BOOKMARK_RANK_FACTOR = 0.25

export function checkpointKindOf(meta: Record<string, unknown> | null | undefined): CheckpointKind {
  return meta?.['kind'] === BOOKMARK_KIND ? 'bookmark' : 'chapter'
}

/** The label status and the packet print for a kind. */
export function checkpointKindLabel(kind: CheckpointKind): string {
  return kind === 'bookmark' ? 'bookmark' : 'chapter summary'
}

// ── The interval (D156, D157, D163, D207) ──────────────────────────

/** Where the interval lives: a row of the store's own `store_config`
 *  table, so the setting is per store and the Stop hook reads it on the
 *  connection it already holds. */
export const CHECKPOINT_INTERVAL_KEY = 'checkpoint_interval'

/** `null` on a component means that component never trips. Both null is off. */
export interface CheckpointInterval {
  rounds: number | null
  minutes: number | null
}

/** D157: 20 rounds or 45 minutes, whichever comes first. */
export const DEFAULT_CHECKPOINT_INTERVAL: CheckpointInterval = { rounds: 20, minutes: 45 }

/** The sprint D157's arithmetic was done for: about 300 rounds in a day.
 *  An interval no component of which can trip inside one is honored and
 *  said to be effectively off (D163). */
const SPRINT_ROUNDS = 300
const SPRINT_MINUTES = 24 * 60

const UNIT_MINUTES: Array<[RegExp, number]> = [
  [/^(?:m|mins?|minutes?)$/, 1],
  [/^(?:h|hrs?|hours?)$/, 60],
  [/^(?:d|days?)$/, 24 * 60],
  [/^(?:w|wks?|weeks?)$/, 7 * 24 * 60],
]

/**
 * Parse an interval as a developer would say it: "20 rounds", "45 minutes",
 * "20 rounds or 45 minutes", "1000 rounds and 1 week", "off". "or" and
 * "and" both join limits, and whichever is reached first trips (D207). A
 * zero component is that component switched off; no value is refused
 * (D163). Returns null only for text that names no interval at all.
 */
export function parseCheckpointInterval(text: string): CheckpointInterval | null {
  const t = text.trim().toLowerCase()
  if (t === '') return null
  if (t === 'off' || t === 'none' || t === 'never' || t === 'disabled') return { rounds: null, minutes: null }
  const parts = t.split(/\s*(?:,|\+|\bor\b|\band\b|\bwhichever(?:\s+comes)?\s+first\b)\s*/).filter((p) => p !== '')
  if (parts.length === 0) return null
  let rounds: number | null | undefined
  let minutes: number | null | undefined
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(part)
    if (!m) return null
    const n = Number(m[1])
    const unit = m[2]!
    if (/^(?:rounds?|turns?|stops?)$/.test(unit)) {
      rounds = n > 0 ? Math.ceil(n) : null
      continue
    }
    const scale = UNIT_MINUTES.find(([re]) => re.test(unit))?.[1]
    if (scale === undefined) return null
    minutes = n > 0 ? n * scale : null
  }
  return { rounds: rounds ?? null, minutes: minutes ?? null }
}

function minutesPhrase(minutes: number): string {
  const week = 7 * 24 * 60
  if (minutes % week === 0) return plural(minutes / week, 'week')
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), 'day')
  if (minutes % 60 === 0 && minutes >= 120) return plural(minutes / 60, 'hour')
  return plural(minutes, 'minute')
}

/** The interval echoed back as it will behave (D163). */
export function describeCheckpointInterval(i: CheckpointInterval): string {
  if (i.rounds === null && i.minutes === null) return 'off'
  if (i.rounds === 1) return 'a bookmark at every stop'
  if ((i.rounds === null || i.rounds > SPRINT_ROUNDS) && (i.minutes === null || i.minutes > SPRINT_MINUTES)) {
    return 'honored, which is effectively off'
  }
  const limits: string[] = []
  if (i.rounds !== null) limits.push(plural(i.rounds, 'round'))
  if (i.minutes !== null) limits.push(minutesPhrase(i.minutes))
  return `a bookmark when the newest checkpoint is ${limits.join(' or ')} old${limits.length > 1 ? ', whichever comes first' : ''}`
}

/** The store's interval, or the default when none was ever set (or the row
 *  is unreadable — a broken setting must not switch bookmarks off). */
export function readCheckpointInterval(db: DatabaseType): CheckpointInterval {
  try {
    const row = db.prepare('SELECT value FROM store_config WHERE key = ?').get(CHECKPOINT_INTERVAL_KEY) as
      | { value: string }
      | undefined
    if (!row) return DEFAULT_CHECKPOINT_INTERVAL
    const v = JSON.parse(row.value) as Record<string, unknown>
    const comp = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null)
    return { rounds: comp(v['rounds']), minutes: comp(v['minutes']) }
  } catch {
    return DEFAULT_CHECKPOINT_INTERVAL
  }
}

export function writeCheckpointInterval(db: DatabaseType, interval: CheckpointInterval, said: string): void {
  db.prepare('INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)').run(
    CHECKPOINT_INTERVAL_KEY,
    JSON.stringify({ rounds: interval.rounds, minutes: interval.minutes, said }),
  )
}

// ── The session chain (D216) ───────────────────────────────────────
//
// A /clear mints a NEW Claude Code session id. What the developer thinks
// of as "this session" is therefore a chain: the id after the latest
// clear, the one before it, and so on back to the session's start. The
// session-start hook learns each link from the pid beacon (which still
// names the predecessor when the clear's SessionStart fires) and records
// it here, in the store, so every reader — the packet, the Stop hook,
// the bookmark supersession — walks the same chain.

export const SESSION_LINK_PREFIX = 'session_chain:'
const MAX_CHAIN = 64

/** Record that `sessionId` continues `predecessor` across a /clear. */
export function recordSessionLink(db: DatabaseType, sessionId: string, predecessor: string): void {
  if (sessionId === predecessor) return
  db.prepare('INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)').run(
    SESSION_LINK_PREFIX + sessionId, JSON.stringify(predecessor),
  )
}

/** The chain ending at `sessionId`, newest first. `lookup` reads one
 *  store_config value — so a FlatStore's handle and a hook's raw one walk
 *  it alike. Bounded and cycle-safe. */
export function sessionChainWith(lookup: (key: string) => string | undefined, sessionId: string): string[] {
  const chain = [sessionId]
  for (let cur = sessionId; chain.length < MAX_CHAIN;) {
    let prev: unknown
    try { prev = JSON.parse(lookup(SESSION_LINK_PREFIX + cur) ?? 'null') } catch { prev = null }
    if (typeof prev !== 'string' || chain.includes(prev)) break
    chain.push(prev)
    cur = prev
  }
  return chain
}

export function sessionChain(db: DatabaseType, sessionId: string): string[] {
  const stmt = db.prepare('SELECT value FROM store_config WHERE key = ?')
  return sessionChainWith((k) => (stmt.get(k) as { value: string } | undefined)?.value, sessionId)
}

// ── Session reads ──────────────────────────────────────────────────

// Every session read names tree_id through the trees table so the
// (tree_id, session_key, created_at) index serves it: a hook does not
// know its namespace, and a session id is unique across them anyway.
const IN_TREES = 'tree_id IN (SELECT tree_id FROM trees)'
const inList = (n: number): string => `(${Array.from({ length: n }, () => '?').join(',')})`

/** A curated row of one of the two kinds (D158): a bookmark, live or
 *  superseded, or a chapter summary — a pointer, live or since
 *  superseded by another pointer. A superseded plain note is neither. */
const CHECKPOINT_ROW = `COALESCE(source_label, '') != 'auto-capture' AND (
  json_extract(metadata_json, '$.kind') = '${BOOKMARK_KIND}'
  OR json_extract(metadata_json, '$.next_session') = 1
  OR json_extract(metadata_json, '$.status') IN ('active', 'superseded'))`

const LIVE_POINTER = `COALESCE(source_label, '') != 'auto-capture' AND (
  json_extract(metadata_json, '$.next_session') = 1
  OR json_extract(metadata_json, '$.status') = 'active')`

/** Not a subagent's row (D169: a subagent's checkpoints are always marked
 *  as its own). A subagent shares its orchestrator's session id, so the
 *  session chain alone would hand the orchestrator a subagent's pointer as
 *  its own chapter; the store's stamp keeps them apart: every row stamped
 *  as a subagent's — by its hook, by the registry's provisional reading or
 *  by its insert's echo — names the subagent's agent id, and a row the
 *  echo moves back to the session's own agent loses it. */
const NOT_SUBAGENT = `json_extract(metadata_json, '$._writer_agent_id') IS NULL`

export interface CheckpointRow {
  nodeId: string
  kind: CheckpointKind
  createdAt: number
  content: string
  metadata: Record<string, unknown>
}

interface RawRow { node_id: string; created_at: number; metadata_json: string | null; content: unknown }

function toCheckpoint(r: RawRow): CheckpointRow {
  let meta: Record<string, unknown> = {}
  try { meta = JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown> } catch { /* metadata is advisory */ }
  return {
    nodeId: r.node_id,
    kind: checkpointKindOf(meta),
    createdAt: r.created_at,
    content: decodeContent(r.content as string | Buffer | null),
    metadata: meta,
  }
}

/** The chain's newest checkpoint of either kind, live or superseded. (A
 *  superseded `next_session` chapter loses its flag, but whatever
 *  superseded it is newer, so the newest is never missed.) */
export function newestCheckpoint(db: DatabaseType, chain: string[]): CheckpointRow | null {
  const r = db.prepare(
    `SELECT node_id, created_at, metadata_json, content FROM nodes
      WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)} AND ${CHECKPOINT_ROW} AND ${NOT_SUBAGENT}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...chain) as RawRow | undefined
  return r ? toCheckpoint(r) : null
}

/** The chain's newest LIVE pointer of one kind, never a subagent's. */
export function newestLive(db: DatabaseType, chain: string[], kind: CheckpointKind): CheckpointRow | null {
  const kindClause = kind === 'bookmark'
    ? `json_extract(metadata_json, '$.kind') = '${BOOKMARK_KIND}'`
    : `COALESCE(json_extract(metadata_json, '$.kind'), '') != '${BOOKMARK_KIND}'`
  const r = db.prepare(
    `SELECT node_id, created_at, metadata_json, content FROM nodes
      WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)} AND ${LIVE_POINTER} AND ${kindClause} AND ${NOT_SUBAGENT}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...chain) as RawRow | undefined
  return r ? toCheckpoint(r) : null
}

function hasTable(db: DatabaseType, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

/** Entries of the chain strictly after `after` (and before `before`):
 *  journal rows plus staged rows the drain has not reached yet, so a
 *  count never waits on the server. */
export function countSessionEntries(db: DatabaseType, chain: string[], after: number, before = Infinity): number {
  const hi = Number.isFinite(before) ? before : 1e15
  const nodes = (db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)} AND created_at > ? AND created_at < ?`,
  ).get(...chain, after, hi) as { n: number }).n
  const staged = hasTable(db, 'staging')
    ? (db.prepare(
      `SELECT COUNT(*) AS n FROM staging WHERE session_id IN ${inList(chain.length)} AND processed = 0 AND timestamp > ? AND timestamp < ?`,
    ).get(...chain, after, hi) as { n: number }).n
    : 0
  return Number(nodes) + Number(staged)
}

const USER_TURN = `COALESCE(source_label, '') = 'auto-capture' AND json_extract(metadata_json, '$.role') = 'user'`

/** The developer's own captured turns since `after` — a round is one. */
export function countUserTurns(db: DatabaseType, chain: string[], after: number): number {
  const nodes = (db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)} AND created_at > ? AND ${USER_TURN}`,
  ).get(...chain, after) as { n: number }).n
  const staged = hasTable(db, 'staging')
    ? (db.prepare(
      `SELECT COUNT(*) AS n FROM staging WHERE session_id IN ${inList(chain.length)} AND processed = 0 AND role = 'user' AND timestamp > ?`,
    ).get(...chain, after) as { n: number }).n
    : 0
  return Number(nodes) + Number(staged)
}

export interface UserTurn { at: number; content: string }

/** The newest `limit` developer turns since `after`, oldest first. */
export function newestUserTurns(db: DatabaseType, chain: string[], after: number, limit: number): UserTurn[] {
  const turns: UserTurn[] = (db.prepare(
    `SELECT created_at, content FROM nodes WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)} AND created_at > ? AND ${USER_TURN}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(...chain, after, limit) as Array<{ created_at: number; content: unknown }>)
    .map((r) => ({ at: r.created_at, content: decodeContent(r.content as string | Buffer | null) }))
  if (hasTable(db, 'staging')) {
    for (const r of db.prepare(
      `SELECT timestamp, content FROM staging WHERE session_id IN ${inList(chain.length)} AND processed = 0 AND role = 'user' AND timestamp > ?
        ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(...chain, after, limit) as Array<{ timestamp: number; content: string }>) {
      turns.push({ at: r.timestamp, content: r.content })
    }
  }
  return turns.sort((a, b) => b.at - a.at).slice(0, limit).reverse()
}

/** The moment the chain's record begins — what a checkpoint's age is
 *  measured from when the session never wrote one. */
export function sessionStart(db: DatabaseType, chain: string[]): number | null {
  const n = (db.prepare(
    `SELECT MIN(created_at) AS t FROM nodes WHERE ${IN_TREES} AND session_key IN ${inList(chain.length)}`,
  ).get(...chain) as { t: number | null }).t
  const s = hasTable(db, 'staging')
    ? (db.prepare(`SELECT MIN(timestamp) AS t FROM staging WHERE session_id IN ${inList(chain.length)}`).get(...chain) as { t: number | null }).t
    : null
  if (n === null) return s
  if (s === null) return n
  return Math.min(n, s)
}

// ── The Stop hook's second duty (D156, D207, D216) ─────────────────

/** store_config key of the moment the Stop hook last asked this session
 *  for a bookmark. An ask restarts the interval like a checkpoint does, so
 *  the hook never asks twice within one interval — whether the agent
 *  ignored the ask or its bookmark landed somewhere the chain cannot see. */
export const BOOKMARK_ASKED_PREFIX = 'bookmark_asked:'

export function markBookmarkAsked(db: DatabaseType, sessionId: string, atSec: number): void {
  db.prepare('INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)').run(BOOKMARK_ASKED_PREFIX + sessionId, JSON.stringify(atSec))
}

function newestAsk(db: DatabaseType, chain: string[]): number | null {
  const rows = db.prepare(`SELECT value FROM store_config WHERE key IN ${inList(chain.length)}`)
    .all(...chain.map((s) => BOOKMARK_ASKED_PREFIX + s)) as Array<{ value: string }>
  let best: number | null = null
  for (const r of rows) {
    const v = Number(JSON.parse(r.value))
    if (Number.isFinite(v) && (best === null || v > best)) best = v
  }
  return best
}

export interface CheckpointDue {
  due: boolean
  rounds: number
  minutes: number
  /** What the age is measured from: a kind of checkpoint, the previous
   *  ask, or null when the session has neither. */
  since: CheckpointKind | 'ask' | null
  interval: CheckpointInterval
}

/** Is a bookmark due at this stop? At or beyond either limit (D207),
 *  measured from the later of the chain's newest checkpoint and the
 *  newest ask. */
export function checkpointDue(db: DatabaseType, sessionId: string, nowSec: number): CheckpointDue {
  const interval = readCheckpointInterval(db)
  const chain = sessionChain(db, sessionId)
  const cp = newestCheckpoint(db, chain)
  const asked = newestAsk(db, chain)
  let from = cp?.createdAt ?? null
  let since: CheckpointDue['since'] = cp?.kind ?? null
  if (asked !== null && (from === null || asked > from)) { from = asked; since = 'ask' }
  // A session with neither counts from just before its first entry, so
  // that first entry's turn is a round.
  if (from === null) {
    const start = sessionStart(db, chain)
    if (start === null) return { due: false, rounds: 0, minutes: 0, since: null, interval }
    from = start - 1e-6
  }
  const rounds = countUserTurns(db, chain, from)
  const minutes = Math.max(0, (nowSec - from) / 60)
  const due = (interval.rounds !== null && rounds >= interval.rounds)
    || (interval.minutes !== null && minutes >= interval.minutes)
  return { due, rounds, minutes, since, interval }
}

export function bookmarkRequest(d: CheckpointDue): string {
  const age = `${plural(d.rounds, 'round')} and ${plural(Math.floor(d.minutes), 'minute')}`
  const since = d.since === null
    ? 'since this session began, with no checkpoint yet'
    : d.since === 'ask' ? 'since treecontext last asked for a bookmark' : `since this session's newest ${checkpointKindLabel(d.since)}`
  // Routine housekeeping, read by two audiences at once: the agent, who
  // acts on it, and the developer, to whom Claude Code shows every block
  // reason as a "Stop hook blocking error". Nothing is wrong, and the
  // developer has nothing to do — the text says both.
  return `treecontext housekeeping: ${age} ${since}, so a routine bookmark is due. Agent: write a bookmark now — one short treecontext_insert saying where the work stands and the next step, with metadata {"kind": "bookmark", "next_session": true} — then finish the turn as planned. Nothing is wrong, and the developer has nothing to do.`
}

/** The clock the Stop hook reads. TREECONTEXT_TEST_NOW (unix seconds) is
 *  honored only under the test runner (VITEST set), so the interval's
 *  minute boundary can be bound exactly; production always reads the
 *  wall clock. */
export function hookNowSec(): number {
  const injected = process.env['VITEST'] ? Number(process.env['TREECONTEXT_TEST_NOW']) : NaN
  return Number.isFinite(injected) && injected > 0 ? injected : Date.now() / 1000
}

// ── The /clear packet (D187, D162, D198, D206) ─────────────────────

export const PACKET_BUDGET_CHARS = 3000
export const PACKET_TURNS = 5
// The clips that keep the packet inside its budget by construction. Worst
// case, every piece at its clip (two referrer lines, five turns, the
// handoff lines and the reminder) sums to about 2700 characters; the
// final cut below is a backstop that a passing suite never reaches.
const CHAPTER_LINE_CHARS = 280
const BOOKMARK_LINE_CHARS = 200
const TURN_LINE_CHARS = 100
const HANDOFF_NAME_CHARS = 40
const MAX_HANDOFF_LINES = 2
const HANDOFF_CHAPTER_CHARS = 60
/** How far ahead of this machine's clock a sender's timestamp may sit
 *  before the packet calls it the future: ordinary clock jitter is not
 *  skew worth a sentence. */
const FUTURE_SLACK_SECS = 5 * 60

/** The one-line reminder, verbatim wherever it appears. */
export const CHAPTER_HOWTO =
  'To leave a chapter summary, ask the agent to "write a chapter summary": one treecontext_insert with metadata.next_session=true saying where the work stands and the next step.'

/** The once-a-day nudge for a session with no chapter summary (D198). */
export const CHAPTER_NUDGE = `Tip for the developer, once today: before the next clear, leave a chapter summary. ${CHAPTER_HOWTO}`

function firstLine(text: string): string {
  const nl = text.search(/\r?\n/)
  return (nl === -1 ? text : text.slice(0, nl)).trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A checkpoint's body as the packet shows it: its first line, clipped,
 *  with what was left out said and the id to fetch it by. */
function checkpointBody(cp: CheckpointRow): string {
  const line = clip(firstLine(cp.content), cp.kind === 'bookmark' ? BOOKMARK_LINE_CHARS : CHAPTER_LINE_CHARS)
  const rest = cp.content.length - line.length
  return rest > 0 ? `${line} [${plural(cp.content.length, 'character')} in full; treecontext_export("${cp.nodeId}")]` : line
}

/** "referenced by", one hop deep (D186, D187): the entries whose refs
 *  name this one, read from the store's reverse index — the newest one's
 *  id, writer, age and first line, and the count when there are more.
 *  Never the referrer in full, and never what refers to the referrer. */
function referencedByLine(db: DatabaseType, cp: CheckpointRow, nowSec: number): string {
  const by = referencedBy(db, cp.nodeId, nowSec)
  if (!by) return '  referenced by: none'
  const top = by.newest
  const more = by.count > 1 ? ` (newest of ${by.count})` : ''
  return `  referenced by: ${top.nodeId}${more}, ${clip(top.writer, HANDOFF_NAME_CHARS)}, ${top.age} old: "${top.firstLine}"`
}

function turnLines(turns: UserTurn[]): string[] {
  return turns.map((t) => `  - "${clip(firstLine(t.content), TURN_LINE_CHARS)}" (${plural(t.content.length, 'character')})`)
}

/** One line per handoff present (D206): entries an import marked with the
 *  file they came from, grouped by that file, each naming the sender the
 *  file claims, the count, and the newest entry the file claims as a
 *  chapter summary (its `next_session`, kept among the claims — never a
 *  pointer of this store's, D221) with its
 *  universal time as the sender's clock wrote it. A time ahead of this
 *  machine's clock is disclosed, never corrected (D184). */
function handoffLines(db: DatabaseType, nowSec: number): string[] {
  const groups = db.prepare(
    `SELECT json_extract(metadata_json, '$._handoff_file') AS file,
            MAX(json_extract(metadata_json, '$._handoff_sender')) AS sender,
            COUNT(*) AS n
       FROM nodes WHERE json_extract(metadata_json, '$._handoff_file') IS NOT NULL
      GROUP BY file ORDER BY MAX(created_at) DESC`,
  ).all() as Array<{ file: string; sender: string | null; n: number }>
  const lines: string[] = []
  for (const g of groups.slice(0, MAX_HANDOFF_LINES)) {
    const chapter = db.prepare(
      `SELECT node_id, created_at, content FROM nodes WHERE json_extract(metadata_json, '$._handoff_file') = ?
          AND json_extract(metadata_json, '$._handoff_claims.next_session') = 1
          AND COALESCE(json_extract(metadata_json, '$.kind'), '') != '${BOOKMARK_KIND}'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(g.file) as { node_id: string; created_at: number; content: unknown } | undefined
    let when = 'no chapter summary'
    if (chapter) {
      const utc = `${new Date(chapter.created_at * 1000).toISOString().slice(0, 16)}Z`
      const text = clip(firstLine(decodeContent(chapter.content as string | Buffer | null)), HANDOFF_CHAPTER_CHARS)
      const ahead = chapter.created_at - nowSec > FUTURE_SLACK_SECS
        ? ` It is timestamped ${ageText(nowSec, chapter.created_at)} in the future by the sender's clock, shown as written, not corrected.`
        : ''
      when = `newest chapter summary ${utc} (id ${chapter.node_id}): "${text}".${ahead}`
    }
    // The sender is the file's claim (D165), and the line says so.
    lines.push(`Handoff ${g.sender ? `claimed from ${clip(g.sender, HANDOFF_NAME_CHARS)}` : 'from an unnamed sender'} (${clip(g.file, HANDOFF_NAME_CHARS)}): ${plural(g.n, 'entry', 'entries')}, ${chapter ? when : `${when}.`}`)
  }
  if (groups.length > MAX_HANDOFF_LINES) lines.push(`…and ${groups.length - MAX_HANDOFF_LINES} more handoffs; search for them.`)
  return lines
}

/** The store_config key of the once-a-day nudge mark: session and the
 *  machine's local calendar day (D198). */
export function nudgeMarkKey(sessionId: string, localDate: string): string {
  return `reorient_nudge:${sessionId}:${localDate}`
}

/** The machine's local calendar day, YYYY-MM-DD. */
export function localDateOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface ClearPacket {
  text: string
  /** True when the packet carries the nudge, so the caller can mark it. */
  nudged: boolean
}

/**
 * The packet after a /clear, in the order D187 rules: the chapter with its
 * age and referrers; the bookmark with its age, the entries between, and
 * its referrers; the newest developer turns since the newest checkpoint,
 * each its first line and length, the omitted count stated; one line per
 * handoff; the reminder. Bounded by PACKET_BUDGET_CHARS by construction —
 * every variable-length line is clipped — with a final cut as a backstop.
 */
export function buildClearPacket(db: DatabaseType, chain: string[], nowSec: number, localDate: string): ClearPacket {
  // The chain's root names "this session" for the once-a-day nudge: every
  // clear mints a new id, and a mark keyed on the newest would never be
  // found again (D216).
  const root = chain.at(-1)!
  const lines: string[] = []
  const chapter = newestLive(db, chain, 'chapter')
  const bookmark = newestLive(db, chain, 'bookmark')
  let nudged = false

  if (chapter) {
    lines.push(`Chapter summary, ${ageText(chapter.createdAt, nowSec)} old (id ${chapter.nodeId}): ${checkpointBody(chapter)}`)
    lines.push(referencedByLine(db, chapter, nowSec))
  }
  if (bookmark) {
    const between = chapter
      ? `, ${plural(countSessionEntries(db, chain, Math.min(chapter.createdAt, bookmark.createdAt), Math.max(chapter.createdAt, bookmark.createdAt)), 'entry', 'entries')} between it and the chapter summary`
      : ''
    lines.push(`Bookmark, ${ageText(bookmark.createdAt, nowSec)} old (id ${bookmark.nodeId})${between}: ${checkpointBody(bookmark)}`)
    lines.push(referencedByLine(db, bookmark, nowSec))
  }
  if (!chapter && bookmark) lines.push('No chapter summary exists for this session.')

  // The tail runs from the newer of the two checkpoints.
  const anchor = [chapter, bookmark].filter((c): c is CheckpointRow => c !== null)
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  const after = anchor?.createdAt ?? -Infinity
  const afterSql = Number.isFinite(after) ? after : -1e15
  const label = anchor ? `the ${checkpointKindLabel(anchor.kind)}` : null
  const turnsTotal = countUserTurns(db, chain, afterSql)
  const turns = newestUserTurns(db, chain, afterSql, PACKET_TURNS)
  const omitted = turnsTotal - turns.length

  if (!anchor) {
    const entries = countSessionEntries(db, chain, -1e15)
    lines.push(`No chapter summary or bookmark exists for this session; re-oriented from its ${plural(entries, 'recent entry', 'recent entries')}.`)
    if (turns.length === 0) lines.push('No developer turn is in the journal for this session yet.')
    else lines.push(`Your newest ${turns.length} of ${plural(turnsTotal, 'turn')}, oldest first (${omitted} older turns omitted):`)
  } else if (turns.length === 0) {
    lines.push(`No developer turn has arrived since ${label} (${plural(countSessionEntries(db, chain, afterSql), 'entry', 'entries')} since it).`)
  } else {
    const entries = countSessionEntries(db, chain, afterSql)
    lines.push(`Since ${label}: ${plural(entries, 'entry', 'entries')}, ${turnsTotal} of them your turns. The newest ${turns.length}, oldest first (${omitted} older turns omitted):`)
  }
  lines.push(...turnLines(turns))

  lines.push(...handoffLines(db, nowSec))

  if (chapter) {
    lines.push(CHAPTER_HOWTO)
  } else {
    const marked = db.prepare('SELECT 1 FROM store_config WHERE key = ?').get(nudgeMarkKey(root, localDate)) !== undefined
    if (!marked) {
      lines.push(CHAPTER_NUDGE)
      nudged = true
    }
  }

  let text = lines.join('\n')
  if (text.length > PACKET_BUDGET_CHARS) text = `${text.slice(0, PACKET_BUDGET_CHARS - 40)}\n… (packet cut at its budget)`
  return { text, nudged }
}

/** Record that today's nudge was shown. Best effort: a store that cannot
 *  take the mark repeats the nudge, which is the harmless failure. */
export function markNudged(db: DatabaseType, chain: string[], localDate: string): void {
  const sessionId = chain.at(-1)!
  db.prepare('INSERT OR REPLACE INTO store_config (key, value) VALUES (?, ?)').run(
    nudgeMarkKey(sessionId, localDate),
    JSON.stringify(Date.now() / 1000),
  )
}

// ── Self on a fresh start (D167, D190) ─────────────────────────────
//
// A session that starts in a linked worktree, by restart or brand new,
// orients on its self: the worktree it runs in, whatever its process or
// session id. Its own thread is the newest live chapter summary written by
// that worktree's own lane (`_writer` `worktree:<name>`, stamped by the
// server from the registry), across every session that ever ran there; a
// chapter of another worktree or of the main checkout is never its own. A
// new worktree has no chapter yet and is a new subagent process: it orients
// on the brief addressed to it, an entry whose `brief_for` names the
// worktree (written by the orchestrator, typically before the worktree's
// first session starts). The main checkout's fresh start is unchanged.

/** The metadata key that addresses an entry to a worktree or a subagent
 *  role as its brief. */
export const BRIEF_FOR_KEY = 'brief_for'

function newestOfWorktree(db: DatabaseType, writer: string): CheckpointRow | null {
  const r = db.prepare(
    `SELECT node_id, created_at, metadata_json, content FROM nodes
      WHERE ${IN_TREES} AND ${LIVE_POINTER} AND json_extract(metadata_json, '$._writer') = ?
        AND COALESCE(json_extract(metadata_json, '$._writer_src'), '') != 'ambiguous'
        AND COALESCE(json_extract(metadata_json, '$.kind'), '') != '${BOOKMARK_KIND}'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(writer) as RawRow | undefined
  return r ? toCheckpoint(r) : null
}

function newestBrief(db: DatabaseType, addressee: string): CheckpointRow | null {
  const r = db.prepare(
    `SELECT node_id, created_at, metadata_json, content FROM nodes
      WHERE ${IN_TREES} AND COALESCE(source_label, '') != 'auto-capture'
        AND json_extract(metadata_json, '$.${BRIEF_FOR_KEY}') = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(addressee) as RawRow | undefined
  return r ? toCheckpoint(r) : null
}

/** The lines a fresh start in a linked worktree opens its packet with:
 *  the worktree's own chapter, labeled as its own, and the brief addressed
 *  to it. Empty for the main checkout. */
export function worktreeSelfLines(
  db: DatabaseType, self: { worktree: string | null; branch: string | null }, nowSec: number,
): string[] {
  if (!self.worktree) return []
  const lines: string[] = []
  const name = self.worktree
  lines.push(`This session runs in the worktree "${name}"${self.branch ? ` on the branch "${self.branch}"` : ''}; it re-orients on that worktree's own thread.`)
  const chapter = newestOfWorktree(db, `worktree:${name}`)
  if (chapter) {
    lines.push(`The worktree's own chapter summary, ${ageText(chapter.createdAt, nowSec)} old (id ${chapter.nodeId}): ${checkpointBody(chapter)}`)
    lines.push(referencedByLine(db, chapter, nowSec))
  }
  const brief = newestBrief(db, name)
  if (brief) {
    lines.push(`Brief for this worktree from ${clip(String(brief.metadata['_writer'] ?? 'an unnamed writer'), HANDOFF_NAME_CHARS)}, ${ageText(brief.createdAt, nowSec)} old (id ${brief.nodeId}): ${checkpointBody({ ...brief, kind: 'chapter' })}`)
  }
  if (!chapter && !brief) lines.push(`No chapter summary or brief exists for the worktree "${name}" yet; it starts fresh.`)
  else if (!chapter) lines.push(`The worktree "${name}" has no chapter summary of its own yet; it starts from the brief.`)
  return lines
}
