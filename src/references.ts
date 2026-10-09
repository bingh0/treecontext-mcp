/**
 * References and lanes (features/journal-orchestration.feature, rulings
 * D186 and D169).
 *
 * A reference follows git conventions: the new entry names the earlier one
 * by id in `metadata.refs` (one id or a list) and says in its own words
 * what it responds to. Nothing is copied and nothing is modified; the
 * store keeps the reverse index (`node_refs`, see
 * persistence/reference-index.ts), and every read surface shows an
 * entry's "referenced by" ONE hop deep: the newest referrer's id, writer,
 * age and first line, and the count of all of them. Walking further is a
 * deliberate fetch by id, so a trail the agent never asked for never
 * enters its context.
 *
 * The write side is D169's: any writer may append into any lane, but only
 * a lane's own writer retires that lane's pointers. A supersession of an
 * entry another writer owns is turned into a reference on the new entry
 * (FlatStore.insert), never a flag flip on the target.
 *
 * Reads take any handle with `prepare` — a FlatStore's wrapped database
 * and a hook's raw better-sqlite3 handle alike.
 */
import { decodeContent } from './persistence/content-codec.js'
import { sessionOf } from './dedup-identity.js'
import { HANDOFF_LANE_PREFIX } from './handoff.js'
import { MAIN_WRITER } from './persistence/session-registry.js'

interface Prepared { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
/** The one capability the reads need from a database handle. */
export interface ReadHandle { prepare(sql: string): Prepared }

/** The longest first line a referrer is shown with — the packet's clip. */
export const REFERRER_LINE_CHARS = 80

/** The lane key of rows that name no writer of their own: the main lane,
 *  whichever session of the main checkout wrote them (D167: the main
 *  session's self is the main checkout, not the process). */
export const MAIN_LANE = ''

/** The ids an entry's `refs` names: a string or the strings of an array. */
/** A writer-ish value that names something: an empty one names nothing
 *  and falls through to the next key, so `_writer: ""` cannot mask a
 *  claimed `agent_type`. */
function named(v: unknown): string | undefined {
  return v === undefined || v === null || String(v).trim() === '' ? undefined : String(v)
}

export function refIdsOf(meta: Record<string, unknown> | null | undefined): string[] {
  const v = meta?.['refs']
  if (typeof v === 'string' && v !== '') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '')
  return []
}

/**
 * The writer an entry is SHOWN with: an imported entry by the importer's
 * mark, never the file's claim (D165); otherwise `_writer` — stamped by
 * the store (D190): by ingestion from a hook payload's agent fields, by
 * the server from the session registry for a tool-written row — then
 * `agent_type` (a claim an older or library-written row may carry), then
 * the session.
 */
export function writerOf(meta: Record<string, unknown> | null | undefined): string {
  const imported = meta?.['_handoff_file']
  if (imported !== undefined && imported !== null) return `imported from ${String(imported)}`
  return named(meta?.['_writer']) ?? named(meta?.['agent_type']) ?? named(meta?.['_cc_session_id'])
    ?? named(meta?.['session_id']) ?? 'unknown writer'
}

/** The lane key of a row written while more than one subagent of its
 *  session was live (D190's ambiguity): the store could not tell its
 *  writer, so it owns no lane's pointers and retires none — a
 *  supersession from it is recorded as a reference, never a flag flip. */
export const AMBIGUOUS_LANE = '\u0000ambiguous'

/**
 * The lane an entry's writer owns, for D169's "only a lane's own writer
 * retires that lane's pointers": an imported entry's lane is its session
 * key, `handoff:<claimed session>` (D223); a row written while the store
 * could not tell its writer apart (`_writer_src` `ambiguous`) owns no
 * lane; a row naming a writer (`_writer`, else `agent_type`) is that
 * writer's lane; a row naming none is the main lane. The session is NOT
 * part of the key: a new session of the main checkout is the same writer
 * as the last one, and its close-out retiring the previous session's
 * chapter is the resume-pointer lifecycle working, not a cross-lane edit.
 *
 * One main lane across the stamp (D228's reconciliation): a row the
 * server stamped `_writer` `main` (the main agent in the main checkout)
 * and an older row naming no writer at all are the same lane. A linked
 * worktree's main agent is `worktree:<name>`, its own lane (D167).
 *
 * `_writer` is the store's stamp on every row a registered session writes
 * through the tools, and on every row a subagent's hook captured; the
 * insert tool drops a caller's copy. `agent_type` stays a fallback for
 * rows the stamp never reached (library writes, unregistered sessions).
 */
export function laneWriterOf(meta: Record<string, unknown> | null | undefined): string {
  const session = sessionOf(meta ?? null)
  if (session.startsWith(HANDOFF_LANE_PREFIX)) return session
  if (meta?.['_writer_src'] === 'ambiguous') return AMBIGUOUS_LANE
  const writer = named(meta?.['_writer']) ?? named(meta?.['agent_type'])
  return writer === undefined || writer === MAIN_WRITER ? MAIN_LANE : writer
}

/** One referrer as every read surface shows it. */
export interface Referrer {
  nodeId: string
  writer: string
  /** The age at the moment of the read, as the packet says it. */
  age: string
  /** The referrer's first line, clipped to REFERRER_LINE_CHARS. */
  firstLine: string
}

/** "referenced by", one hop deep: how many entries refer to this one, and
 *  the one shown — the newest from ANOTHER lane when there is one (the
 *  cross-lane pointer D169 and D187 exist to surface must not be masked by
 *  the owner's own notes), else the newest. Absent (null) when nothing
 *  refers to the entry. */
export interface ReferencedBy {
  count: number
  newest: Referrer
}

export function plural(n: number, unit: string, many = `${unit}s`): string {
  return `${n} ${n === 1 ? unit : many}`
}

/** An age from two universal timestamps (D184), in the coarsest unit that
 *  still says something: minutes under two hours, hours under two days. */
export function ageText(fromSec: number, nowSec: number): string {
  const min = Math.max(0, Math.floor((nowSec - fromSec) / 60))
  if (min < 120) return plural(min, 'minute')
  const h = Math.floor(min / 60)
  if (h < 48) return plural(h, 'hour')
  return plural(Math.floor(h / 24), 'day')
}

export function firstLineOf(text: string): string {
  const nl = text.search(/\r?\n/)
  return (nl === -1 ? text : text.slice(0, nl)).trim()
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function hasRefIndex(db: ReadHandle): boolean {
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_refs'").get() !== undefined
  } catch {
    return false
  }
}

/**
 * The entries that name `nodeId` in their refs, one hop deep, read from
 * the reverse index: the count, and one referrer's id, writer, age and
 * first line — never its full content, and never what refers to IT.
 * Referrers are read inside the entry's own namespace (its tree): a
 * namespace is the process boundary (D196), and another namespace's text
 * never leaks into this one's read. A store the reverse index has not
 * reached yet (opened by a hook before any migrating open) has no
 * references to show.
 */
export function referencedBy(db: ReadHandle, nodeId: string, nowSec: number = Date.now() / 1000): ReferencedBy | null {
  if (!hasRefIndex(db)) return null
  const target = db.prepare('SELECT tree_id, metadata_json FROM nodes WHERE node_id = ?').get(nodeId) as
    | { tree_id: number; metadata_json: string | null }
    | undefined
  if (!target) return null
  const rows = db.prepare(
    `SELECT n.node_id, n.created_at, n.metadata_json FROM node_refs r JOIN nodes n ON n.node_id = r.node_id
      WHERE r.ref_id = ? AND n.tree_id = ? ORDER BY n.created_at DESC, n.rowid DESC`,
  ).all(nodeId, target.tree_id) as Array<{ node_id: string; created_at: number; metadata_json: string | null }>
  if (rows.length === 0) return null
  const lane = laneWriterOf(parseMetaSafe(target.metadata_json))
  const parsed = rows.map((r) => ({ ...r, meta: parseMetaSafe(r.metadata_json) }))
  const top = parsed.find((r) => laneWriterOf(r.meta) !== lane) ?? parsed[0]!
  const content = (db.prepare('SELECT content FROM nodes WHERE node_id = ?').get(top.node_id) as { content: unknown }).content
  return {
    count: rows.length,
    newest: {
      nodeId: top.node_id,
      writer: writerOf(top.meta),
      age: ageText(top.created_at, nowSec),
      firstLine: clipText(firstLineOf(decodeContent(content as string | Buffer | null)), REFERRER_LINE_CHARS),
    },
  }
}

function parseMetaSafe(json: string | null): Record<string, unknown> | null {
  try { return JSON.parse(json ?? 'null') as Record<string, unknown> | null } catch { return null }
}
