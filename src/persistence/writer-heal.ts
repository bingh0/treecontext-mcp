/**
 * The echo heal of a writer (D190, D240): exact per-call attribution of a
 * row written through the tools.
 *
 * The orchestrator and its subagents share one session and one server
 * connection, so the insert itself cannot say who called. Its echo can:
 * Claude Code fires PostToolUse for the treecontext_insert call with the
 * CALLER's agent fields — a subagent's agent_id and agent_type, nothing
 * for the session's own agent (probe of 2026-09-25) — and the echo's
 * output names the row the call created (echo-correlation.ts, the same
 * exact correlation the V2 session heal uses). At the drain the row's
 * writer is set from the echo, `_writer_src` `echo`, whatever the
 * registry guessed at insert.
 *
 * The insert-time guess may have acted on lanes in the meantime, and when
 * the echo moves the row to another lane every such act is put right as
 * D169 would have had it:
 *  1. pointers the row RETIRED that its true lane does not own are
 *     restored — to the flags they held, or to the earlier retirement they
 *     carried, from the `_superseded_prior` trace retireMeta keeps — and
 *     named in the row's refs instead;
 *  2. a retirement the row SUFFERED from a writer of another lane than its
 *     true one is undone the same way, and recorded as a reference on the
 *     retiring row;
 *  3. supersessions the row asked for but could not perform under its
 *     first stamp (`_supersedes_referenced`) that its true lane owns are
 *     performed now.
 * A restored bookmark never makes two live in one session's lane (D241):
 * when a newer one is live there, the restored one stays retired, pointing
 * at it. Only a creating call of the same session heals; a deduplicated
 * call names a row someone else wrote. A second heal of the same echo
 * finds the lane unchanged and changes nothing.
 */
import type { Database } from './database.js'
import { laneWriterOf } from '../references.js'
import { sessionOf, NO_SESSION } from '../dedup-identity.js'
import { agentWriterOf, selfOf, selfWriterOf } from './session-registry.js'

const BOOKMARK = 'bookmark'

export type WriterHealOutcome =
  | 'not-found' | 'not-curated' | 'deduplicated' | 'outside-window' | 'other-session' | 'confirmed' | 'corrected' | 'unreadable'

export interface WriterHealResult {
  outcome: WriterHealOutcome
  /** Pointers the guess retired that the true writer does not own, restored. */
  reverted?: string[]
  /** The healed row's own retirement by another lane, undone. */
  unretired?: string
  /** Supersessions of the true lane performed at the heal. */
  retired?: string[]
}

function parse(json: string | null): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

function refsOf(meta: Record<string, unknown>): string[] {
  const v = meta['refs']
  if (typeof v === 'string' && v !== '') return [v]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

const isLive = (m: Record<string, unknown>): boolean => m['next_session'] === true || m['status'] === 'active'

/**
 * Retire a pointer's metadata in place and return it: the flags cleared,
 * `superseded_by` set, and `_superseded_prior` keeping what it was — its
 * flags, and the retirement it already carried with that one's own prior
 * — so the act can be undone exactly. The one spelling FlatStore's
 * supersession and the heal share.
 */
export function retireMeta(meta: Record<string, unknown>, by: string, now: number): Record<string, unknown> {
  const prior: Record<string, unknown> = {
    ...(meta['next_session'] === true ? { next_session: true } : {}),
    ...(meta['status'] === 'active' ? { status: 'active' } : {}),
    ...(typeof meta['superseded_by'] === 'string' ? { superseded_by: meta['superseded_by'], superseded_at: meta['superseded_at'] } : {}),
    ...(meta['_superseded_prior'] !== undefined && typeof meta['superseded_by'] === 'string' ? { prior: meta['_superseded_prior'] } : {}),
  }
  meta['_superseded_prior'] = prior
  delete meta['next_session']
  if (meta['status'] === 'active') meta['status'] = 'superseded'
  meta['superseded_by'] = by
  meta['superseded_at'] = now
  return meta
}

/** The newest live bookmark of `meta`'s session in `lane`, newer than
 *  `after`, other than `self`. */
function newerLiveBookmark(db: Database, treeId: number, meta: Record<string, unknown>, after: number, self: string, lane: string): string | null {
  const session = sessionOf(meta)
  if (session === NO_SESSION) return null
  const rows = db.prepare(
    `SELECT node_id, metadata_json FROM nodes WHERE tree_id = ? AND session_key = ? AND node_id != ? AND created_at > ?
        AND json_extract(metadata_json, '$.kind') = '${BOOKMARK}' AND json_extract(metadata_json, '$.next_session') = 1
      ORDER BY created_at DESC, rowid DESC`,
  ).all(treeId, session, self, after) as Array<{ node_id: string; metadata_json: string | null }>
  return rows.find((r) => laneWriterOf(parse(r.metadata_json)) === lane)?.node_id ?? null
}

/**
 * Undo the retirement `meta` carries, in place. Back to the earlier
 * retirement it carried before, when there was one (its history kept);
 * else back to its flags — except a bookmark whose lane already has a
 * newer live bookmark of its session, which stays retired, pointing at
 * that one (D241).
 */
function unretire(db: Database, treeId: number, id: string, createdAt: number, meta: Record<string, unknown>, now: number): void {
  const prior = (meta['_superseded_prior'] ?? { next_session: true }) as Record<string, unknown>
  delete meta['superseded_by']
  delete meta['superseded_at']
  delete meta['_superseded_prior']
  if (typeof prior['superseded_by'] === 'string') {
    meta['superseded_by'] = prior['superseded_by']
    meta['superseded_at'] = prior['superseded_at']
    if (prior['prior'] !== undefined) meta['_superseded_prior'] = prior['prior']
    return
  }
  if (prior['next_session'] === true && meta['kind'] === BOOKMARK) {
    const newer = newerLiveBookmark(db, treeId, meta, createdAt, id, laneWriterOf(meta))
    if (newer) {
      meta['superseded_by'] = newer
      meta['superseded_at'] = now
      meta['_superseded_prior'] = { next_session: true }
      return
    }
  }
  if (prior['next_session'] === true) meta['next_session'] = true
  if (prior['status'] === 'active' && meta['status'] === 'superseded') meta['status'] = 'active'
}

export function healWriterFromEcho(db: Database, opts: {
  nodeId: string
  echoSessionId: string
  echoTs: number
  deduplicated: boolean
  agentId: string | null
  agentType: string | null
  windowSecs: number
}): WriterHealResult {
  return db.transaction((): WriterHealResult => {
    const row = db.prepare('SELECT tree_id, created_at, dedup_class, metadata_json FROM nodes WHERE node_id = ?').get(opts.nodeId) as
      | { tree_id: number; created_at: number; dedup_class: string; metadata_json: string | null }
      | undefined
    if (!row) return { outcome: 'not-found' }
    if (row.dedup_class === 'auto') return { outcome: 'not-curated' }
    if (opts.deduplicated) return { outcome: 'deduplicated' }
    if (Math.abs(opts.echoTs - row.created_at) > opts.windowSecs) return { outcome: 'outside-window' }
    const meta = parse(row.metadata_json)
    if (!meta) return { outcome: 'unreadable' }
    // Same session: a row the server attributed to another session is
    // not this echo's to re-stamp. A row it could not attribute at all
    // (no session) is the one the session heal adopts from this echo.
    const rowSession = sessionOf(meta)
    if (rowSession !== NO_SESSION && rowSession !== opts.echoSessionId) return { outcome: 'other-session' }

    // The echo's writer: the caller's own agent fields, or — none sent —
    // the session's own agent, its self as the registry holds it.
    const isAgent = opts.agentId !== null || opts.agentType !== null
    const self = isAgent ? null : (() => { try { return selfOf(db, opts.echoSessionId) } catch { return null } })()
    const writer = isAgent ? agentWriterOf(opts.agentType, opts.agentId) : selfWriterOf(self)
    const before = { writer: (meta['_writer'] as string | undefined) ?? null, src: (meta['_writer_src'] as string | undefined) ?? null }
    const oldLane = laneWriterOf(meta)
    const next: Record<string, unknown> = { ...meta, _writer: writer, _writer_src: 'echo' }
    if (isAgent && opts.agentId !== null) next['_writer_agent_id'] = opts.agentId
    else delete next['_writer_agent_id']
    delete next['_writer_candidates']
    if (!isAgent && self?.worktree) next['_worktree'] = self.worktree
    const changed = before.writer !== writer || (meta['_writer_agent_id'] ?? null) !== (next['_writer_agent_id'] ?? null)
    if (changed) next['_writer_stamped'] = before
    const newLane = laneWriterOf(next)

    const now = Date.now() / 1000
    const result: WriterHealResult = { outcome: changed ? 'corrected' : 'confirmed' }
    if (newLane !== oldLane) {
      const sel = db.prepare('SELECT created_at, read_only, metadata_json FROM nodes WHERE node_id = ? AND tree_id = ?')
      const upd = db.prepare('UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE node_id = ?')
      const notes: string[] = []

      // 1. What the row retired that its true lane does not own.
      const reverted: string[] = []
      const targets = db.prepare(
        "SELECT node_id, created_at, metadata_json FROM nodes WHERE tree_id = ? AND json_extract(metadata_json, '$.superseded_by') = ?",
      ).all(row.tree_id, opts.nodeId) as Array<{ node_id: string; created_at: number; metadata_json: string | null }>
      for (const t of targets) {
        const tm = parse(t.metadata_json)
        if (!tm || laneWriterOf(tm) === newLane) continue
        unretire(db, row.tree_id, t.node_id, t.created_at, tm, now)
        upd.run(JSON.stringify(tm), now, t.node_id)
        reverted.push(t.node_id)
      }
      if (reverted.length > 0) {
        next['refs'] = [...new Set([...refsOf(next), ...reverted])]
        next['_writer_heal_reverted'] = reverted
        result.reverted = reverted
        notes.push(`the ${reverted.length === 1 ? 'pointer' : 'pointers'} it retired under the first stamp ${reverted.length === 1 ? 'was' : 'were'} restored and recorded as references`)
      }

      // 2. A retirement the row suffered from another lane than its own.
      const by = next['superseded_by']
      if (typeof by === 'string') {
        const r = sel.get(by, row.tree_id) as { metadata_json: string | null } | undefined
        const rm = r ? parse(r.metadata_json) : null
        if (rm && laneWriterOf(rm) !== newLane) {
          unretire(db, row.tree_id, opts.nodeId, row.created_at, next, now)
          rm['refs'] = [...new Set([...refsOf(rm), opts.nodeId])]
          upd.run(JSON.stringify(rm), now, by)
          next['_writer_heal_unretired'] = by
          result.unretired = by
          notes.push(`its retirement by ${by}, another lane's, was undone and recorded there as a reference`)
        }
      }

      // 3. Supersessions the first stamp could not perform, now its own.
      const asked = Array.isArray(next['_supersedes_referenced']) ? (next['_supersedes_referenced'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
      const retired: string[] = []
      for (const id of asked) {
        const t = sel.get(id, row.tree_id) as { created_at: number; read_only: number; metadata_json: string | null } | undefined
        const tm = t ? parse(t.metadata_json) : null
        if (!t || !tm || t.read_only || laneWriterOf(tm) !== newLane || !isLive(tm)) continue
        upd.run(JSON.stringify(retireMeta(tm, opts.nodeId, now)), now, id)
        retired.push(id)
      }
      if (retired.length > 0) {
        next['_writer_heal_retired'] = retired
        next['_supersedes_referenced'] = asked.filter((id) => !retired.includes(id))
        result.retired = retired
        notes.push(`the ${retired.length === 1 ? 'pointer' : 'pointers'} it asked to supersede in its own lane ${retired.length === 1 ? 'is' : 'are'} retired now`)
      }

      next['_writer_heal_note'] = `stamped ${before.writer ?? 'with no writer'} (${before.src ?? 'unstamped'}) at insert; its echo names ${writer}. `
        + (notes.length > 0 ? `${notes.join('; ')}.` : 'Nothing it did under the first stamp needed undoing.')
    }
    // A replayed echo that changes nothing writes nothing.
    if (JSON.stringify(next) !== JSON.stringify(meta)) {
      db.prepare('UPDATE nodes SET metadata_json = ?, updated_at = ? WHERE node_id = ?').run(JSON.stringify(next), now, opts.nodeId)
    }
    return result
  })
}
