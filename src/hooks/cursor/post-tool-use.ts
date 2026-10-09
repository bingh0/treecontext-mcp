import { parseAndNormalize } from './normalize.js'
import { resolveDbPath, writeStaging, isDirectInvocation } from '../shared.js'
import { dbg } from '../../debug.js'

export function main() {
  try {
    const input = parseAndNormalize()
    const { session_id, cwd, tool_name, tool_input, tool_output } = input
    if (!tool_name) { process.exit(0); return }

    const skipTools = ['Read', 'Glob', 'Grep', 'LS', 'View', 'ListDir']
    if (skipTools.includes(tool_name)) { process.exit(0); return }

    dbg('hook:cursor:post-tool', 'invoked', { tool_name, cwd })

    let priority = 3
    if (['Edit', 'Write', 'NotebookEdit', 'Shell'].includes(tool_name)) priority = 1
    else if (tool_name === 'Bash' || tool_name.startsWith('MCP:')) priority = 2

    const safeInput = typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input) || ''
    const safeOutput = typeof tool_output === 'string' ? tool_output : JSON.stringify(tool_output) || ''

    let content = `Tool: ${tool_name}\n`
    if (safeInput) content += `Input:\n${safeInput.substring(0, 500)}${safeInput.length > 500 ? '...' : ''}\n`
    if (safeOutput) content += `Output:\n${safeOutput.substring(0, 1000)}${safeOutput.length > 1000 ? '...' : ''}\n`

    const dbPath = resolveDbPath(cwd ?? undefined)
    writeStaging(dbPath, {
      sessionId: session_id,
      role: 'assistant',
      content: content.trim(),
      toolName: tool_name,
      timestamp: Date.now() / 1000,
      priority,
    })
  } catch (error) {
    if (error instanceof Error) console.error(`[treecontext-hook:cursor] post-tool-use: ${error.message}`)
  }
  process.exit(0)
}

const isMain = isDirectInvocation(import.meta.url)
if (isMain) main()
