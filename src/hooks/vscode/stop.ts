/**
 * Copilot agentStop → assistant turn-end capture.
 *
 * The reference platform reads the assistant's last message out of a
 * JSONL transcript, because that is what Claude Code hands its Stop hook.
 * Copilot's agentStop payload is not documented to carry a transcript
 * path, so this adapter covers both:
 *
 *   - transcript path present → delegate to the reference hook, which
 *     already knows how to find the last assistant text and how to skip a
 *     stale recapture of a turn already journaled.
 *   - assistant text inline → stage it directly.
 *   - neither → exit quietly. Capture is best-effort at turn end; the
 *     tool and prompt events already carry the session.
 *
 * Which branch actually fires on a live Copilot session is the open
 * question this adapter's verification pass has to answer — see
 * src/hooks/README.md.
 */
import { parseAndNormalize } from './normalize.js'
import { main as referenceMain } from '../stop.js'
import { resolveDbPath, writeStaging, isDirectInvocation } from '../shared.js'
import { STORE_SAFETY_CAP } from '../../persistence/capture-constants.js'
import { dbg } from '../../debug.js'

export function main(): void {
  try {
    const input = parseAndNormalize()

    if (input.transcript_path) {
      referenceMain(input)
      return
    }

    const text = input.assistant_message
    if (!text) {
      dbg('hook:vscode:stop', 'no transcript and no inline assistant text — skipping')
      process.exit(0)
      return
    }

    dbg('hook:vscode:stop', 'staging inline assistant text', {
      sessionId: input.session_id, length: text.length,
    })
    writeStaging(resolveDbPath(input.cwd ?? undefined), {
      sessionId: input.session_id,
      role: 'assistant',
      content: text.substring(0, STORE_SAFETY_CAP),
      timestamp: typeof input.created_at === 'number' ? input.created_at : Date.now() / 1000,
      priority: 2,
    })
  } catch (error) {
    if (error instanceof Error) console.error(error.message)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
