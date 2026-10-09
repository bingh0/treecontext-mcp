import { parseHookInput, resolveDbPath, writeSnapshot, isDirectInvocation } from './shared.js'
import { dbg } from '../debug.js'

export function main(preParsed?: Record<string, unknown>) {
  try {
    const input = preParsed ?? parseHookInput()
    const sessionId = input.session_id
    const cwd = input.cwd

    dbg('hook:pre-compact', 'invoked', { sessionId: sessionId ?? null, cwd: cwd ?? null })

    if (sessionId) {
      const dbPath = resolveDbPath(cwd)
      const queries = [
        "current active plan and next steps",
        "recent decisions and their rationale",
        "what was I working on in the current task"
      ]
      writeSnapshot(dbPath, sessionId, queries)
      dbg('hook:pre-compact', 'snapshot written', { sessionId })
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[treecontext-hook] pre-compact error: ${error.message}`)
    }
  }
  process.exit(0)
}


const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
