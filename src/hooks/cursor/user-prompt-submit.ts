import { parseAndNormalize } from './normalize.js'
import { resolveDbPath, writeStaging, isDirectInvocation } from '../shared.js'
import { dbg } from '../../debug.js'

export function main() {
  try {
    const input = parseAndNormalize()
    const userMessage = input.prompt
    if (!userMessage) { process.exit(0); return }

    dbg('hook:cursor:user-prompt', 'invoked', { cwd: input.cwd })
    const dbPath = resolveDbPath(input.cwd ?? undefined)
    writeStaging(dbPath, {
      sessionId: input.session_id,
      role: 'user',
      content: userMessage.substring(0, 2000),
      timestamp: Date.now() / 1000,
      priority: 1,
    })
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook:cursor] user-prompt-submit: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
