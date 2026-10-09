/**
 * The hook dispatcher — its own leaf module, NOT part of installer.ts:
 * this is the hot path of every hook fire (five per tool call on an
 * active session), and importing it used to drag the whole 3k-line
 * installer graph (agents registry, TOML codec, lease client) into
 * every capture spawn (F review 2026-08-15).
 */
import { dbg } from '../debug.js'

export async function dispatchHook(event: string): Promise<void> {
  // Each hook's main() calls process.exit(0) internally, which is the
  // expected behavior — this is a short-lived CLI command, not a library call.
  try {
    switch (event) {
      case 'session-start': {
        const mod = await import('../hooks/session-start.js')
        mod.main()
        break
      }
      case 'pre-compact': {
        const mod = await import('../hooks/pre-compact.js')
        mod.main()
        break
      }
      case 'post-tool-use': {
        const mod = await import('../hooks/post-tool-use.js')
        mod.main()
        break
      }
      case 'user-prompt-submit': {
        const mod = await import('../hooks/user-prompt-submit.js')
        mod.main()
        break
      }
      case 'stop': {
        const mod = await import('../hooks/stop.js')
        mod.main()
        break
      }
      case 'subagent-start': {
        const mod = await import('../hooks/subagent-start.js')
        mod.main()
        break
      }
      case 'subagent-stop': {
        const mod = await import('../hooks/subagent-stop.js')
        mod.main()
        break
      }
      default:
        // Ruling 2026-08-15: capture may be lost for a reason, never for
        // a formality. An event this dispatcher does not know still exits
        // 0 — a hook must never break the agent — but its name lands in
        // the debug log instead of vanishing.
        dbg('hook', 'unknown hook event', { event })
        process.exit(0)
    }
  } catch (err) {
    try {
      dbg('hook', 'hook dispatch failed', { event, error: String(err) })
    } catch { /* the exit code stays 0 regardless */ }
    process.exit(0)
  }
}
