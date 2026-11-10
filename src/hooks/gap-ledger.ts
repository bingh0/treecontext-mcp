/**
 * The hooks' gap ledger (D314, D279, D2): an event a hook could not write
 * because the store refused it (locked past the hook's budget, read-only,
 * unreachable) is recorded OUTSIDE the store, beside it, and the next
 * writer of the store, the drain, turns each record into a capture-gap
 * row at the moment the event was dropped. So a hooks-door leg that
 * started cold, or a stop whose summary could not land, is visibly so in
 * the journal once the store takes writes again ("the gap is marked when
 * the store is next written").
 *
 * The ledger is one JSON line per dropped event in `hook-gaps.jsonl` in
 * the store's directory, or, when that directory takes no file, in the
 * temp directory under a name keyed by the store's path. A record keeps
 * what a reader needs to name the dropped event: the hook, the session,
 * the agent, the moment, the error, and a bounded prefix of the payload's
 * text, and an id of its own, so the capture-gap row written from it is
 * written once however many times the record is read.
 *
 * The claim (claimHookGaps) is two-phase, so no line is lost to a race:
 *  - a tick renames the live ledger aside as `<ledger>.claimed-<ms>-<pid>`;
 *    a hook appends with O_APPEND to the live name only (appendFileSync
 *    opens, writes and closes in one call), so a hook that starts after the
 *    rename creates a fresh live ledger;
 *  - a claimed file is read only once it is older than the grace
 *    (GAP_CLAIM_GRACE_MS, by the moment in its name), so a hook that opened
 *    the ledger just before the rename has finished its one write into the
 *    claimed file by then. The window that remains: a hook stalled for
 *    longer than the grace between the open and the write of a single
 *    appendFileSync call, which no hook's code allows for;
 *  - the claimed file is unlinked only after the drain's rows for it have
 *    landed (the claim's `done`), and a claimed file that was not read,
 *    or whose rows did not land, or whose unlink failed, is read again by
 *    the next tick, the gap ids keeping its rows single.
 */
import { appendFileSync, readFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** The ledger's file name beside the store. */
export const GAP_LEDGER_FILE = 'hook-gaps.jsonl'

/** How much of a dropped event's own text a record keeps (the dead-letter
 *  path's prefix, JF-7). */
export const GAP_TEXT_PREFIX = 500

/** How old a claimed ledger must be before it is read: time for a hook
 *  that opened the ledger just before the rename to finish its write. */
export const GAP_CLAIM_GRACE_MS = 1000

/** One dropped event. */
export interface HookGap {
  /** The record's own id: the capture-gap row written from it is written
   *  once (claims are read again until their rows land). */
  id?: string
  /** The hook whose write was refused (`subagent-start`, `subagent-stop`,
   *  `stop`, ...). */
  hook: string
  /** The platform's session id the event belongs to. */
  sessionId: string | null
  agentId?: string | null
  agentType?: string | null
  /** When the event happened, unix seconds. */
  at: number
  /** Why the write was refused, as the store said it. */
  error: string
  /** What was lost, in words (no registration, no first moment, no
   *  summary row). */
  lost: string
  /** A bounded prefix of the event's own text, when it had one. */
  text?: string | null
  /** The client's id for the tool call the dropped event carried (D408:
   *  a call whose result was ledgered is never journaled as one the
   *  client reported no result for). */
  toolUseId?: string | null
  /** The client a hook's command named, where its hooks register no self
   *  (D421, hooks/hook-client.ts CLIENTS_REGISTERING_NO_SELF): the drain
   *  files the gap row as it files that client's captured rows (a worker's
   *  lane, else writer unknown). */
  client?: string | null
}

/** The ledger paths for a store, in the order a hook tries them. */
export function gapLedgerPaths(dbPath: string): string[] {
  const keyed = createHash('sha1').update(dbPath).digest('hex').slice(0, 12)
  return [join(dirname(dbPath), GAP_LEDGER_FILE), join(tmpdir(), `treecontext-${keyed}-${GAP_LEDGER_FILE}`)]
}

/** Record a dropped event. Best-effort: a ledger nobody can write leaves
 *  the debug log's line as the only trace, and the hook still exits 0. */
export function recordHookGap(dbPath: string, gap: HookGap): boolean {
  const id = gap.id ?? `${Math.round(gap.at * 1000).toString(36)}-${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`
  const line = JSON.stringify({ ...gap, id, ...(gap.text ? { text: gap.text.slice(0, GAP_TEXT_PREFIX) } : {}) }) + '\n'
  for (const path of gapLedgerPaths(dbPath)) {
    try {
      appendFileSync(path, line, { mode: 0o600, flag: 'a' })
      return true
    } catch { /* the next place */ }
  }
  return false
}

/** What a claim found, and how to let go of it once its rows landed. */
export interface GapClaim {
  gaps: HookGap[]
  /** Unlink the claimed files read; call only once every gap's row landed. */
  done: () => void
}

const CLAIMED = '.claimed-'

/** Claim the ledgers of a store (see the module comment): the live ledger
 *  renamed aside, and every claimed file older than the grace read. */
export function claimHookGaps(dbPath: string, opts: { graceMs?: number; now?: number } = {}): GapClaim {
  const grace = opts.graceMs ?? GAP_CLAIM_GRACE_MS
  const now = opts.now ?? Date.now()
  const gaps: HookGap[] = []
  const read: string[] = []
  for (const path of gapLedgerPaths(dbPath)) {
    if (existsSync(path)) {
      try { renameSync(path, `${path}${CLAIMED}${now}-${process.pid}`) } catch { /* another claimed it */ }
    }
    let names: string[] = []
    try { names = readdirSync(dirname(path)) } catch { continue }
    const prefix = `${basename(path)}${CLAIMED}`
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const at = Number(name.slice(prefix.length).split('-')[0])
      if (!Number.isFinite(at) || now - at < grace) continue
      const file = join(dirname(path), name)
      let text: string
      try { text = readFileSync(file, 'utf8') } catch { continue }
      read.push(file)
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const g = JSON.parse(line) as HookGap
          gaps.push({ ...g, id: g.id ?? createHash('sha1').update(line).digest('hex').slice(0, 16) })
        } catch {
          gaps.push({ id: createHash('sha1').update(line).digest('hex').slice(0, 16), hook: 'unknown', sessionId: null, at: now / 1000, error: 'unreadable ledger line', lost: 'an event', text: line.slice(0, GAP_TEXT_PREFIX) })
        }
      }
    }
  }
  return { gaps, done: () => { for (const f of read) { try { unlinkSync(f) } catch { /* read again next tick; the ids keep it single */ } } } }
}

/** The capture-gap row's text for a dropped hook event. */
export function hookGapText(g: HookGap): string {
  const who = g.agentId ? `the ${g.agentType ?? 'untyped'} subagent (agent ${g.agentId}) of session ${g.sessionId ?? 'unknown'}` : `session ${g.sessionId ?? 'unknown'}`
  return `[capture gap] The ${g.hook} event of ${who} at ${new Date(g.at * 1000).toISOString()} was dropped: `
    + `the store could not be written (${g.error}). ${g.lost}`
    + (g.text ? `\nText prefix: ${g.text}` : '')
}

/** The key a ledgered call is named by: its client session and its id, so
 *  that a line of one session never answers for another's call. */
export function ledgeredCallKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}\n${toolUseId}`
}

/** The client's calls the store's ledgers name, live or claimed and not
 *  yet written (D408), each by its session and id (ledgeredCallKey). A
 *  read: a ledger nobody can read names none. */
export function ledgeredCallIds(dbPath: string): Set<string> {
  const ids = new Set<string>()
  for (const path of gapLedgerPaths(dbPath)) {
    let names: string[] = []
    try { names = readdirSync(dirname(path)) } catch { continue }
    for (const name of names) {
      if (name !== basename(path) && !name.startsWith(`${basename(path)}${CLAIMED}`)) continue
      let text = ''
      try { text = readFileSync(join(dirname(path), name), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        try { const g = JSON.parse(line) as HookGap; if (g.toolUseId && g.sessionId) ids.add(ledgeredCallKey(g.sessionId, g.toolUseId)) } catch { /* a torn line */ }
      }
    }
  }
  return ids
}
