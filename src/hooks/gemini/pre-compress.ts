import { parseAndNormalize } from './normalize.js'
import { resolveDbPath, writeSnapshot, isDirectInvocation } from '../shared.js'
import { dbg } from '../../debug.js'

export function main() {
  try {
    const input = parseAndNormalize()
    const sessionId = input.session_id
    if (!sessionId) { process.exit(0); return }

    dbg('hook:gemini:pre-compress', 'invoked', { sessionId, trigger: input.trigger })
    const dbPath = resolveDbPath(input.cwd ?? undefined)
    writeSnapshot(dbPath, sessionId, [
      'current active plan and next steps',
      'recent decisions and their rationale',
      'what was I working on in the current task',
    ])
    dbg('hook:gemini:pre-compress', 'snapshot written', { sessionId })
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook:gemini] pre-compress: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
