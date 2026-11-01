/**
 * The reply ceiling (D287, the 0.1.0-beta.2.1 hotfix): no tool reply this
 * server writes to stdout may approach the client's stdio message guard.
 *
 * Claude Code drops a stdio server that writes more than 16 MB without a
 * JSON-RPC message boundary ("Closing transport (stdout overflow)"), and
 * one well-formed 30 MB treecontext_query reply did exactly that on
 * 2026-10-29. The bounded preview (D4) is the first defence; this is the
 * last: a query reply over the ceiling has its entries' contents cut, each
 * cut entry saying so and naming the export door, until it fits; an export
 * of one entry over the ceiling is refused with its size, since export
 * promises the whole content and a cut would be a lie.
 *
 * A quarter of the guard: far above any reply the preview bound produces
 * (twenty hits with ten-entry windows at the 8000-char tool view is under
 * 4 MB), far below the point where the connection dies.
 */
export const REPLY_CEILING_BYTES = 4 * 1024 * 1024

/** The per-entry caps tried in order until the reply fits. */
const CUT_LADDER = [65_536, 16_384, 4_096, 1_024]

export interface CeilingNote {
  ceiling_bytes: number
  /** Chars each cut entry keeps. */
  cut_at: number
  /** Entries that were cut: hits and window entries of a search, the
   *  checkpoints of a key lookup. */
  cut_entries: number
  /** The ids of the cut entries that carry one, so each can be fetched
   *  whole by export. */
  cut_ids: string[]
  /** Present, and true, only when even the shortest cut left the reply
   *  over the ceiling: said, never hidden. */
  still_over?: true
}

function cutText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}…[cut to fit the reply ceiling; full content ${text.length} chars via treecontext_export]`
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Serialize a query response, cutting entry contents when the whole would
 * exceed the ceiling. Every producer of the query tool is read as it
 * shapes its reply: a search's `results` (hits with `content`, optional
 * `window.before/after[].content` and `window.anchor.content`) and a key
 * lookup's `checkpoints` (each with `content`, D337), so no producer's
 * reply approaches the transport's limit (D287). The response is cloned
 * before any cut, and a cut response carries `_reply_ceiling`, which
 * names what was cut and says so when even the shortest cut did not fit.
 */
export function serializeUnderCeiling(response: Record<string, unknown>, ceiling: number = REPLY_CEILING_BYTES): string {
  const whole = JSON.stringify(response, null, 2)
  if (byteLength(whole) <= ceiling) return whole
  let clone: Record<string, unknown> = {}
  for (const cap of CUT_LADDER) {
    // Every rung cuts the ORIGINAL entries, never an earlier rung's cut:
    // a cut of a cut would carry the wrong full length in its marker.
    clone = JSON.parse(whole) as Record<string, unknown>
    const results = Array.isArray(clone['results']) ? (clone['results'] as Array<Record<string, unknown>>) : []
    const checkpoints = Array.isArray(clone['checkpoints']) ? (clone['checkpoints'] as Array<Record<string, unknown>>) : []
    let cut = 0
    const ids: string[] = []
    const cutField = (o: Record<string, unknown> | null | undefined): void => {
      if (!o || typeof o['content'] !== 'string') return
      const before = o['content'] as string
      const after = cutText(before, cap)
      if (after !== before) {
        o['content'] = after
        cut++
        const id = o['node_id'] ?? o['nodeId']
        if (typeof id === 'string') ids.push(id)
      }
    }
    for (const c of checkpoints) cutField(c)
    for (const r of results) {
      cutField(r)
      const w = r['window'] as Record<string, unknown> | undefined
      if (w) {
        for (const k of ['before', 'after'] as const) {
          const list = w[k]
          if (Array.isArray(list)) for (const e of list) cutField(e as Record<string, unknown>)
        }
        cutField(w['anchor'] as Record<string, unknown> | undefined)
      }
    }
    const note: CeilingNote = { ceiling_bytes: ceiling, cut_at: cap, cut_entries: cut, cut_ids: ids }
    clone['_reply_ceiling'] = note
    const text = JSON.stringify(clone, null, 2)
    if (byteLength(text) <= ceiling) return text
    // Over still: the next rung cuts shorter.
  }
  const last = clone['_reply_ceiling'] as CeilingNote
  last.still_over = true
  return JSON.stringify(clone, null, 2)
}

/** True when a serialized export would cross the ceiling; the caller
 *  refuses with `exportOverCeilingMessage` instead of writing it. */
export function exceedsCeiling(text: string, ceiling: number = REPLY_CEILING_BYTES): boolean {
  return byteLength(text) > ceiling
}

export function exportOverCeilingMessage(nodeId: string, bytes: number, ceiling: number = REPLY_CEILING_BYTES): string {
  return `entry ${nodeId} serializes to ${bytes} bytes, over the reply ceiling of ${ceiling} bytes: a reply that size `
    + 'would end the connection (the client drops a stdio server past 16 MB in one message). The entry is intact in '
    + 'the store; read it with the library or SQLite, or narrow what you ask for.'
}
