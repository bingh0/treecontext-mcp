/**
 * Where a checkpoint-cap refusal finds its writer (D299, D321, D359).
 *
 * A refusal made while the writer stamp was exact sits on the writer's own
 * registration. One made while it was not (provisional, concurrent,
 * ambiguous: a tool insert cannot say which of the session's agents called)
 * sits on the registration the stamp names, as pending, with its id and the
 * candidates it might be. The call's own PostToolUse echo names the caller
 * exactly and carries the id back; reading it moves the refusal to that
 * writer and settles that writer's key as its own, through the same settle
 * the writer heal can undo. Two readers share the one move: the insert (the
 * session's staged echoes, so a second write normally finds the first's) and
 * the drain's echo heal.
 *
 * A writer with no registration behind it has no refusal and is never
 * refused (D359): the store keeps no ledger of refusals outside the
 * registry.
 */
import { extractRefusalId, isInsertEchoTool } from '../server/echo-correlation.js'
import { SELF_AGENT_ID, type RegistryHandle } from './session-registry.js'
import {
  capRefusalsOf, setCapRefusals, settleLegKey, hasLegColumns, isConfirmedRefusal, legOf,
  type CapRefusal, type LegRef,
} from './leg-registry.js'

/** The synthetic "row" a settle made by a refusal's echo is kept under in
 *  `key_settled_from`, so the existing unsettle finds it. */
export const settleMarkOf = (refusalId: string): string => `cap-refusal:${refusalId}`

export interface CapMove {
  /** The refusal was found pending and now sits on the writer the echo names. */
  moved: boolean
  /** That writer's key was settled as its own by it. */
  settled: boolean
}

/**
 * The echo of the call that was refused names its caller: move the pending
 * refusal with `refusalId` in `sessionId` to that caller's registration,
 * confirmed, off the registration it sat on, and settle the caller's key.
 * `agentId` null is the session's own agent. A caller nothing registered
 * keeps no refusal (D359): the pending one is dropped. Idempotent: a
 * replayed echo finds the refusal already confirmed and changes nothing.
 */
export function resolveCapRefusal(db: RegistryHandle, o: { sessionId: string; refusalId: string; agentId: string | null }): CapMove {
  const none: CapMove = { moved: false, settled: false }
  if (!hasLegColumns(db)) return none
  const rows = db.prepare('SELECT agent_id FROM session_registry WHERE session_id = ? AND cap_refused IS NOT NULL').all(o.sessionId) as Array<{ agent_id: string }>
  const truth: LegRef = { sessionId: o.sessionId, agentId: o.agentId ?? SELF_AGENT_ID }
  let found: CapRefusal | null = null
  for (const r of rows) {
    const ref = { sessionId: o.sessionId, agentId: r.agent_id }
    const entries = capRefusalsOf(db, ref) ?? []
    const hit = entries.find((e) => e.id === o.refusalId && !isConfirmedRefusal(e))
    if (!hit) continue
    found = hit
    setCapRefusals(db, ref, entries.filter((e) => e !== hit && !(e.id === hit.id && !isConfirmedRefusal(e))))
  }
  if (!found) return none
  const have = capRefusalsOf(db, truth)
  if (have === null) return { moved: true, settled: false }
  const { candidates: _candidates, ...rest } = found
  const confirmed: CapRefusal = { ...rest, src: 'echo' }
  if (!have.some((e) => e.run === found!.run && e.key === found!.key && isConfirmedRefusal(e))) setCapRefusals(db, truth, [...have, confirmed])
  const leg = legOf(db, truth)
  const settled = leg !== null && leg.kind !== null && settleLegKey(db, truth, found.run, found.key, settleMarkOf(found.id ?? ''))
  return { moved: true, settled }
}

/**
 * Read the session's staged insert echoes and resolve every pending
 * refusal an echo names (D359). Cheap when nothing is pending. Returns how
 * many were resolved.
 */
export function resolveStagedCapRefusals(db: RegistryHandle, sessionId: string): number {
  if (!hasLegColumns(db)) return 0
  const pending = db.prepare("SELECT 1 FROM session_registry WHERE session_id = ? AND cap_refused LIKE '%\"pending\"%' LIMIT 1").get(sessionId)
  if (!pending) return 0
  let rows: Array<{ content: string; tool_name: string; preview_len: number | null; agent_id: string | null }>
  try {
    rows = db.prepare(
      // Only a call's own successful event is evidence (D400, D401).
      `SELECT content, tool_name, preview_len, agent_id FROM staging WHERE session_id = ? AND tool_name LIKE '%treecontext_insert'
          AND outcome IS NULL AND captured_from IS NULL ORDER BY id`,
    ).all(sessionId) as typeof rows
  } catch { return 0 }
  let n = 0
  for (const r of rows) {
    if (!isInsertEchoTool(r.tool_name)) continue
    const id = extractRefusalId(r.content, r.preview_len)
    if (id && resolveCapRefusal(db, { sessionId, refusalId: id, agentId: r.agent_id }).moved) n++
  }
  return n
}
