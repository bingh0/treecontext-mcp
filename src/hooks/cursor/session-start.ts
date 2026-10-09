import { parseAndNormalize } from './normalize.js'
import { resolveDbPath, normalizeSource, buildRehydrationPayload, openHookDb, isDirectInvocation } from '../shared.js'
import { dbg } from '../../debug.js'

export function main() {
  try {
    const input = parseAndNormalize()
    const sessionId = input.session_id
    if (!sessionId) { process.exit(0); return }

    const source = normalizeSource(input.source ?? 'startup')
    const dbPath = resolveDbPath(input.cwd ?? undefined)
    dbg('hook:cursor:session-start', 'invoked', { sessionId, source })

    const db = openHookDb(dbPath)
    try {
      const payload = buildRehydrationPayload(db, sessionId, source, dbPath)
      if (payload) {
        // Cursor uses additional_context at top level (not nested in hookSpecificOutput)
        const output = { additional_context: payload }
        process.stdout.write(JSON.stringify(output) + '\n')
      }
      dbg('hook:cursor:session-start', 'complete', { source, payloadChars: payload.length })
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook:cursor] session-start: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
