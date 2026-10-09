/**
 * The handoff import rule (features/journal-handoff.feature, rulings D151,
 * D164, D165, D184, D206).
 *
 * A handoff file crosses a trust boundary: the shared repository, which
 * anyone with push access can edit. So an imported entry is marked by the
 * IMPORTER — the file it came from, who imported it, when — and the file's
 * own claims about who wrote the entry, which session it belonged to, and
 * what it supersedes are kept on the entry as data under
 * `_handoff_claims`, never trusted as identity (D165). The entry keeps the
 * sender's own `created_at` (D151, D184: the event's moment, never
 * corrected) and lands in a lane of its own, keyed from the sender's
 * claimed session behind a `handoff:` prefix, so it can never join the
 * receiver's self (D206). A supersession the file claims becomes a
 * reference only (D165, D169): the target's flags are never touched.
 *
 * Pure functions over metadata; the import loop itself lives in
 * FlatStore.importJson, where the store-wide identity check (D164) runs.
 */
import { type Stats, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sessionOf, NO_SESSION } from './dedup-identity.js'

/** Where an import came from and who ran it — the importer's own marks. */
export interface HandoffSource {
  /** The handoff file's name as the importer gave it (the import label). */
  file: string
  /** The file's own claim of who exported it (its `exported_by` field),
   *  shown in the packet as the sender and kept as the file's claim. */
  sender: string | null
  /** The importing session, when the server could resolve it. */
  importer: string | null
}

/** The prefix of an imported entry's lane key. A real session id never
 *  carries it, so an imported entry can never join the receiver's self. */
export const HANDOFF_LANE_PREFIX = 'handoff:'

/**
 * Keys whose values are claims of identity, authorship, provenance,
 * supersession or pointer state. On import they move into
 * `_handoff_claims` and leave the entry's top level, where the store's own
 * readers would otherwise take them as fact: the session keys decide the
 * lane, `_writer`/`agent_*` name a writer, the merge and handoff keys name
 * a provenance, `supersedes`/`superseded_by` name a supersession the
 * importer never performed, and `next_session`/`status` say what was a
 * live pointer in the SENDER's store — a receiver's resume pointers are
 * its own (D206). Every key under the `_cc_session`, `_relied` and
 * `_handoff_` prefixes is a claim too: session attribution evidence,
 * reliance bookkeeping and earlier importers' marks all describe the
 * sender's store, not this one. Everything else in the file's metadata
 * (`kind`, `role`, `source`, `tool_name`, `refs`, …) describes the entry
 * and stays, because search attributes by it.
 */
export const HANDOFF_CLAIM_KEYS: readonly string[] = [
  'session_id', '_session_id',
  '_writer', 'agent_id', 'agent_type', 'author', '_namespace',
  '_merge_label', '_merged_from_node_id', '_merge_source_store',
  'supersedes', 'superseded_by', 'superseded_at',
  'next_session', 'status',
]

/** Key prefixes whose every key is a claim (see HANDOFF_CLAIM_KEYS). */
export const HANDOFF_CLAIM_PREFIXES: readonly string[] = ['_cc_session', '_relied', '_handoff_']

const CLAIMS = new Set(HANDOFF_CLAIM_KEYS)

/** True when an imported entry's metadata key is the file's claim. */
export function isHandoffClaimKey(key: string): boolean {
  return CLAIMS.has(key) || HANDOFF_CLAIM_PREFIXES.some((p) => key.startsWith(p))
}

function idList(v: unknown): string[] {
  if (typeof v === 'string' && v !== '') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '')
  return []
}

/**
 * The metadata an imported entry lands with: the file's descriptive keys,
 * the importer's marks, a lane of the sender's own, any claimed
 * supersession turned into references, and the file's claims verbatim.
 */
export function handoffMetadata(
  claimed: Record<string, unknown> | null,
  source: HandoffSource,
  importedAt: number,
): Record<string, unknown> {
  const claims = claimed ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(claims)) if (!isHandoffClaimKey(k)) out[k] = v
  const supersedes = idList(claims['supersedes'])
  if (supersedes.length > 0) out['refs'] = [...new Set([...idList(claims['refs']), ...supersedes])]
  const claimedSession = sessionOf(claims)
  out['session_id'] = `${HANDOFF_LANE_PREFIX}${claimedSession !== NO_SESSION ? claimedSession : source.file}`
  out['_handoff_file'] = source.file
  if (source.sender !== null) out['_handoff_sender'] = source.sender
  if (source.importer !== null) out['_handoff_importer'] = source.importer
  out['_handoff_imported_at'] = importedAt
  if (Object.keys(claims).length > 0) out['_handoff_claims'] = claims
  return out
}

/** The file's claim of its exporter, read from its own head. A missing or
 *  non-string claim is no claim: the packet then says "an unnamed sender". */
export function claimedSender(parsed: Record<string, unknown>): string | null {
  const v = parsed['exported_by']
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null
}

/** The exporting machine's self-description for a file's head: the OS
 *  user at the host. A claim on import like any other (D165); the first
 *  piece of the self-describing head of D172. */
export function exporterName(): string {
  let user = 'unknown'
  try { user = userInfo().username || user } catch { /* no passwd entry: say unknown */ }
  return `${user}@${hostname()}`
}

// ── The file-bound handoff (D170, D172, D177, D199) ─────────────────────
//
// One file format, two doors: the export and import tools take a path
// the server reads or writes itself, and the `treecontext export` and
// `treecontext import` commands do the same from a shell. Both doors build
// the file here, so the same store and form write the same bytes.

/** A subagent summary's metadata kind — the contract with the
 *  orchestration chunk, which stamps it from the SubagentStop capture. */
export const SUBAGENT_SUMMARY_KIND = 'subagent-summary'

/** What a handoff carries: the default `summaries` (the chapter summaries
 *  and the subagent summaries, D177), or the `whole` journal, a deliberate
 *  choice behind the secrets warning. */
export type HandoffForm = 'summaries' | 'whole'

/** The cap on an export returned inline into the conversation (D170):
 *  today's cap, kept. A file carries none. */
export const INLINE_EXPORT_CAP = 10_000

/** D177: said before a whole-journal export writes anything. */
export const SECRETS_WARNING =
  'Captured tool output can hold secrets, tokens and keys: a whole-journal handoff carries every '
  + 'command output and file read this journal captured, to everyone who can read the file. '
  + 'Read it before you commit it.'

/** The rows a handoff reads — FlatStore.handoffRows, structurally. */
export interface HandoffExporter {
  readonly namespace: string
  handoffRows(form: HandoffForm, limit?: number): { nodes: unknown[]; total: number }
}

/** The version of treecontext that wrote a file: this package's own. Both
 *  layouts — src/handoff.ts in a checkout, dist/handoff.js installed — sit
 *  one directory under the package root. */
export function treecontextVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** A path as a shell reads it: bare when it is plain, quoted otherwise. */
function shellWord(p: string): string {
  return /^[A-Za-z0-9._/@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** The one step that imports a file (D172), named for the path the file
 *  sits at in the repository, or for a file not yet saved. */
export function importStep(path: string | null, outsideProject = false): string {
  if (path === null) {
    return 'Save this export as a file in the repository; the teammate who pulls it asks their agent to '
      + 'import it (treecontext_import with path set to the file), or runs: treecontext import <file>'
  }
  const first = outsideProject ? 'Copy this file into the project first, then ask' : 'Ask'
  return `${first} your agent to import ${JSON.stringify(path)} (treecontext_import with path ${JSON.stringify(path)}), `
    + `or run in this project's directory: treecontext import ${shellWord(path)}`
}

function holdsSentence(form: HandoffForm, n: number): string {
  const entries = `${n} ${n === 1 ? 'entry' : 'entries'}`
  return form === 'summaries'
    ? `${entries}: the chapter summaries and subagent summaries of one journal, the default handoff (no bookmarks, no captured tool output)`
    : `${entries}: the whole journal, captured tool output included, which can hold secrets, tokens and keys`
}

export interface BuildHandoffOptions {
  form: HandoffForm
  /** The project the file is exported from, by name. */
  project: string
  /** Where the file sits, relative to the project directory; null for an
   *  inline export the agent has not saved yet. */
  path: string | null
  /** The file lies outside the project (a shell export): `path` is then
   *  its name alone, and the step says to copy it in first. */
  outsideProject?: boolean
  /** Inline only: the cap on entries returned into the conversation. */
  inlineLimit?: number
  /** The export's moment; defaults to now. */
  now?: Date
}

export interface BuiltHandoff {
  /** The file's (or the inline reply's) exact text. */
  text: string
  /** Entries it carries. */
  entries: number
  /** Entries the form holds in the store. */
  total: number
  /** Entries left out by the inline cap (always 0 for a file). */
  omitted: number
}

/**
 * The handoff file (D172): a head that says who exported it, when, from
 * which project, which treecontext version wrote it, what it holds and the
 * one step that imports it; then the entries. A file is pretty-printed for
 * a reader and a diff; an inline reply is compact, and carries the
 * omitted count and the way to reach the rest (D170). On import every head
 * field is the file's claim: only `exported_by` is read, as the claimed
 * sender, never as identity (D165).
 */
export function buildHandoff(store: HandoffExporter, opts: BuildHandoffOptions): BuiltHandoff {
  const inline = opts.inlineLimit !== undefined
  const { nodes, total } = store.handoffRows(opts.form, inline ? opts.inlineLimit : undefined)
  const omitted = total - nodes.length
  const at = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const head: Record<string, unknown> = {
    exported_by: exporterName(),
    exported_at: at,
    project: opts.project,
    treecontext_version: treecontextVersion(),
    holds: holdsSentence(opts.form, nodes.length),
    to_import: importStep(opts.path, opts.outsideProject === true),
    form: opts.form,
    node_count: nodes.length,
    version: 1,
    namespace: store.namespace,
  }
  if (inline) {
    head['omitted'] = omitted
    head['to_reach_the_rest'] = `${omitted} older ${omitted === 1 ? 'entry was' : 'entries were'} omitted: an inline export `
      + `holds the newest ${opts.inlineLimit} at most. A file carries every entry and nothing of it enters the `
      + 'conversation: export with path set to a file in the repository, e.g. "handoffs/<name>.json".'
  }
  const file = { ...head, nodes }
  const text = inline ? JSON.stringify(file) : `${JSON.stringify(file, null, 2)}\n`
  return { text, entries: nodes.length, total, omitted }
}

/** A path resolved against the project directory, or the refusal. */
export type ProjectPath =
  | { ok: true; abs: string; rel: string; root: string }
  | { ok: false; root: string; reason: string }

function realOr(p: string): string {
  try { return realpathSync.native(p) } catch {
    try { return realpathSync(p) } catch { return resolve(p) }
  }
}

function lstatOrNull(p: string): Stats | null {
  try { return lstatSync(p) } catch { return null }
}

/**
 * The tool door's path rule (D199): a handoff is read or written only
 * inside the project directory, the directory the server was started for,
 * never one the agent claims. The requested path is resolved against it;
 * every directory that already exists on the way is resolved through its
 * symbolic links, and the result must still lie inside the project's own
 * real path; the file itself may not be a symbolic link. So neither `..`
 * nor a link planted in the repository can steer the server elsewhere.
 */
export function resolveProjectPath(projectDir: string, requested: string, purpose: 'write' | 'read'): ProjectPath {
  const root = realOr(projectDir)
  const outside = (why: string): ProjectPath => ({
    ok: false, root,
    reason: `Refused: ${JSON.stringify(requested)} ${why}. A handoff may be ${purpose === 'write' ? 'written' : 'read'} only `
      + `inside the project directory, ${root} (for example "handoffs/<name>.json"). Nothing was ${purpose === 'write' ? 'written' : 'read'}.`,
  })
  if (requested.includes('\0')) return outside('is not a path')
  const wanted = resolve(root, requested)
  // The deepest part of the path that exists, and what lies below it.
  let existing = wanted
  const below: string[] = []
  let st = lstatOrNull(existing)
  while (st === null) {
    const up = dirname(existing)
    if (up === existing) break
    below.unshift(basename(existing))
    existing = up
    st = lstatOrNull(existing)
  }
  if (below.length === 0 && st !== null) {
    if (st.isSymbolicLink()) return outside('is a symbolic link')
    if (!st.isFile()) return outside('is not a plain file')
  } else if (purpose === 'read') {
    return outside('does not exist')
  } else {
    // What exists on the way must be a directory, reached through links
    // that resolve: a dangling link or a path through a file leads nowhere
    // a handoff can be written.
    let dirOk = false
    try { dirOk = statSync(existing).isDirectory() } catch { dirOk = false }
    if (!dirOk) return outside('does not lead to a directory inside the project')
  }
  const real = below.length === 0 ? realOr(wanted) : join(realOr(existing), ...below)
  const rel = relative(root, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return outside('is outside the project directory')
  }
  const segments = rel.split(sep)
  // The repository's own machinery is never a handoff's place (D234).
  if (segments[0]!.toLowerCase() === '.git') return outside("is inside the repository's .git directory")
  // An existing file is replaced only when it is itself a handoff (D234):
  // never a project file the agent was steered at.
  if (purpose === 'write' && below.length === 0 && !isHandoffFile(real)) {
    return outside('already exists and is not a treecontext handoff file, so it is not overwritten')
  }
  return { ok: true, abs: real, rel: segments.join('/'), root }
}

/** True when the file at `abs` reads as a treecontext handoff: a JSON
 *  object whose head carries `form` and `exported_by`. */
export function isHandoffFile(abs: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && 'form' in parsed && 'exported_by' in parsed
  } catch {
    return false
  }
}

/**
 * Write a handoff file whole or not at all: a sibling temporary file,
 * fsynced, renamed over the target. A rename replaces a link rather than
 * following it, so even a link planted after the path check cannot carry
 * the write elsewhere.
 */
export function writeHandoffFile(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o644)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, abs)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** The import's counts as the developer is told them. */
export function importToldMessage(result: {
  importedCount: number; alreadyPresent: number; idConflicts: number; skippedMalformed: number
  claimsArchivedSessions?: number
}): string {
  const landed = result.importedCount
  return `${landed} ${landed === 1 ? 'entry' : 'entries'} landed; ${result.alreadyPresent} ${result.alreadyPresent === 1 ? 'was' : 'were'} already present.`
    + (result.idConflicts > 0 ? ` ${result.idConflicts} carried an id this store holds with different content and ${result.idConflicts === 1 ? 'was' : 'were'} left alone.` : '')
    + (result.skippedMalformed > 0 ? ` ${result.skippedMalformed} ${result.skippedMalformed === 1 ? 'was' : 'were'} not an entry at all and could not land.` : '')
    // D222: an import cannot tell an archive from a handoff; it says when
    // the file looks like this store's own archive.
    + ((result.claimsArchivedSessions ?? 0) > 0 ? `\n${result.claimsArchivedSessions} entries claim sessions this store archived; restoring an archive is not an import — see the changelog` : '')
}
