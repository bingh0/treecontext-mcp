import { resolveDbPath, writeStaging, parseHookInput, isDirectInvocation } from './shared.js'
import { dbg } from '../debug.js'
import { writeSessionBeacon } from '../session-beacon.js'
import { STORE_SAFETY_CAP, activeIndexCap } from '../persistence/capture-constants.js'

export function main(preParsed?: Record<string, unknown>) {
  try {
    const input = preParsed ?? parseHookInput()

    dbg('hook:user-prompt', 'invoked', { hasMessage: !!(input.user_message || input.prompt), cwd: input.cwd ?? null })

    // Find user message explicitly
    let userMessage = input.user_message || input.prompt

    // Extract from transcript_path if requested and available
    if (!userMessage && input.transcript_path) {
      // For now we don't read full transcript unless necessary,
      // but the prompt says to extract from transcript_path if needed.
    }

    if (!userMessage) {
      dbg('hook:user-prompt', 'no user message found — skipping')
      process.exit(0)
      return
    }

    const { session_id, cwd } = input
    const dbPath = resolveDbPath(cwd)

    // Session-identity fix (docs/session-identity.md §3):
    // refresh last_seen on the same pid-keyed beacon SessionStart wrote (see
    // session-start.ts) — rewrite:false preserves cc_session_id/started_at,
    // only bumping last_seen, unless no beacon exists yet (SessionStart
    // missed/hasn't landed), in which case this creates one defensively.
    if (session_id) {
      try {
        writeSessionBeacon(dbPath, process.ppid, session_id, cwd ?? process.cwd(), { rewrite: false })
      } catch (err) {
        dbg('hook:user-prompt', 'beacon refresh FAILED', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    // C4/AC4b: stage the full message (capped only at the generous
    // STORE_SAFETY_CAP). The searchable view is bounded by indexLen,
    // stamped here so the row is self-describing at FTS recompute time —
    // by default the whole message is indexed (activeIndexCap('user') is
    // Infinity unless TREECONTEXT_INDEX_CAP narrows it).
    const content = userMessage.substring(0, STORE_SAFETY_CAP)
    writeStaging(dbPath, {
      sessionId: session_id,
      role: 'user',
      content,
      timestamp: Date.now() / 1000,
      priority: 1,
      indexLen: Math.min(activeIndexCap('user'), content.length),
    })

  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message)
    }
  }
  process.exit(0)
}


const isMain = isDirectInvocation(import.meta.url)
if (isMain) {
  main()
}
