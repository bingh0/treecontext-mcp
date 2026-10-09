import { parseAndNormalize } from './normalize.js'
import { resolveDbPath, normalizeSource, buildRehydrationPayload, openHookDb, isDirectInvocation } from '../shared.js'
import { dbg } from '../../debug.js'

export function main() {
  try {
    const input = parseAndNormalize()
    const sessionId = input.session_id
    if (!sessionId) { process.exit(0); return }

    const source = normalizeSource(input.source)
    const dbPath = resolveDbPath(input.cwd ?? undefined)
    dbg('hook:gemini:session-start', 'invoked', { sessionId, source })

    const db = openHookDb(dbPath)
    try {
      const payload = buildRehydrationPayload(db, sessionId, source, dbPath)
      if (payload) {
        const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: payload } }
        process.stdout.write(JSON.stringify(output) + '\n')
      }
      dbg('hook:gemini:session-start', 'complete', { source, payloadChars: payload.length })
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook:gemini] session-start: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
