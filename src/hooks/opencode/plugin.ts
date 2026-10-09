import type { Plugin, Hooks, PluginInput } from '@opencode-ai/plugin'
import Database from 'better-sqlite3'
import {
  resolveDbPath,
  writeStaging,
  writeSnapshot,
  buildRehydrationPayload,
  openHookDb,
  enforceCharCap,
  type SessionSource,
} from '../shared.js'
import { dbg, enableDebug } from '../../debug.js'

if (process.env.TREECONTEXT_DEBUG === '1') enableDebug()

interface PluginState {
  dbPath: string
  sessionId: string | null
  needsRehydration: boolean
  rehydrationSource: SessionSource
  lastTokenCount: number
  contextLimit: number
}

function openDb(dbPath: string): InstanceType<typeof Database> {
  return openHookDb(dbPath)
}

export const TreecontextPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const state: PluginState = {
    dbPath: resolveDbPath(input.directory),
    sessionId: null,
    needsRehydration: false,
    rehydrationSource: 'startup',
    lastTokenCount: 0,
    contextLimit: 0,
  }
  dbg('opencode', 'plugin init', { dir: input.directory, dbPath: state.dbPath })

  return {
    // Layer 2: capture user messages into staging
    'chat.message': async ({ sessionID }, { parts }) => {
      state.sessionId = sessionID
      dbg('opencode', 'chat.message', { sessionID, parts: parts.length })
      try {
        const textParts = parts.filter(p => p.type === 'text')
        const text = textParts.map(p => 'text' in p ? p.text : '').join('\n')
        if (text.length > 0) {
          writeStaging(state.dbPath, {
            sessionId: sessionID,
            role: 'user',
            content: text.substring(0, 2000),
            timestamp: Date.now() / 1000,
            priority: 1,
          })
        }
      } catch (err) {
        console.error('[treecontext] chat.message error:', err)
      }
    },

    // Layer 2: capture tool completions into staging
    'tool.execute.after': async ({ tool, sessionID, args }, { output }) => {
      state.sessionId = sessionID
      const skipTools = ['Read', 'Glob', 'Grep', 'LS', 'View', 'ListDir', 'find', 'file']
      if (skipTools.some(t => tool.includes(t))) {
        dbg('opencode', 'tool.execute.after skipped', { tool })
        return
      }
      dbg('opencode', 'tool.execute.after', { tool, sessionID })

      try {
        let priority = 3
        if (['Edit', 'Write', 'NotebookEdit'].some(t => tool.includes(t))) {
          priority = 1
        } else if (tool.includes('Bash') || tool.includes('shell')) {
          priority = 2
        }

        const content = [
          `Tool: ${tool}`,
          args ? `Input: ${JSON.stringify(args).substring(0, 500)}` : '',
          output ? `Output: ${output.substring(0, 1000)}` : '',
        ].filter(Boolean).join('\n')

        writeStaging(state.dbPath, {
          sessionId: sessionID,
          role: 'assistant',
          content,
          toolName: tool,
          timestamp: Date.now() / 1000,
          priority,
        })
      } catch (err) {
        console.error('[treecontext] tool.execute.after error:', err)
      }
    },

    // Layer 3: save snapshot before compaction + enrich compaction prompt
    'experimental.session.compacting': async ({ sessionID }, output) => {
      state.sessionId = sessionID
      dbg('opencode', 'session.compacting', { sessionID })
      try {
        const queries = [
          'current active plan and next steps',
          'recent decisions and their rationale',
          'what was I working on in the current task',
        ]
        const snapshotId = writeSnapshot(state.dbPath, sessionID, queries)
        state.needsRehydration = true
        state.rehydrationSource = 'compact'

        output.context.push(
          'IMPORTANT: The following working memory was checkpointed to an external ' +
          `store (snapshot #${snapshotId}). Preserve key decisions, active tasks, and ` +
          'next steps in your compaction summary — they will be used for session continuity.',
        )
      } catch (err) {
        console.error('[treecontext] session.compacting error:', err)
      }
    },

    // Layer 3: inject rehydration context into system prompt
    'experimental.chat.system.transform': async ({ sessionID }, output) => {
      if (!state.needsRehydration && !state.sessionId) return
      if (!state.needsRehydration) return
      dbg('opencode', 'system.transform rehydration', { sessionID, source: state.rehydrationSource })

      try {
        const source = state.rehydrationSource
        const db = openDb(state.dbPath)
        try {
          const payload = buildRehydrationPayload(db, sessionID ?? state.sessionId!, source, state.dbPath)
          if (payload && payload.length > 0) {
            output.system.push(enforceCharCap(
              '[treecontext working memory continuation]\n' + payload,
              2000,
            ))
          }
        } finally {
          db.close()
        }
        state.needsRehydration = false
      } catch (err) {
        console.error('[treecontext] system.transform error:', err)
      }
    },

    // Layer 3: track token usage from events
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        state.sessionId = event.properties.info.id
        state.needsRehydration = true
        state.rehydrationSource = 'startup'
      }

      if (event.type === 'message.updated') {
        const msg = event.properties.info
        if (msg.role === 'assistant' && 'tokens' in msg) {
          state.lastTokenCount = msg.tokens.input + msg.tokens.output
        }
      }

      if (event.type === 'session.compacted') {
        state.needsRehydration = true
        state.rehydrationSource = 'compact'
      }
    },
  }
}

export const id = 'treecontext'
export const server = TreecontextPlugin
