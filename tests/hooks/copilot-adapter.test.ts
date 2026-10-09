import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCopilotPayload, normalizeTimestamp } from '../../src/hooks/vscode/normalize.js'
import { upsertVscodeHooks } from '../../src/server/installer.js'

/**
 * The defect these tests exist for: the adapter read `tool_name` while
 * Copilot sends `toolName`, so every tool event exited early and captured
 * nothing — silently, on a platform we told people was supported. Reading
 * the source did not catch it four separate times; asserting on the
 * documented payload shapes does.
 */
describe('Copilot payload normalization', () => {
  describe('camelCase shape (Copilot CLI, cloud agent)', () => {
    it('finds the tool name, args and result text', () => {
      const out = normalizeCopilotPayload({
        sessionId: 'sess-1',
        cwd: '/repo',
        toolName: 'bash',
        toolArgs: '{"command":"ls"}',
        toolResult: { resultType: 'success', textResultForLlm: 'a.ts\nb.ts' },
      })

      expect(out.session_id).toBe('sess-1')
      expect(out.cwd).toBe('/repo')
      expect(out.tool_name).toBe('bash')
      expect(out.tool_input).toBe('{"command":"ls"}')
      expect(out.tool_output).toBe('a.ts\nb.ts')
    })

    it('keeps a tool result that is a bare string', () => {
      const out = normalizeCopilotPayload({ toolName: 'bash', toolResult: 'done' })
      expect(out.tool_output).toBe('done')
    })

    it('never silently loses an unrecognized result shape', () => {
      const out = normalizeCopilotPayload({ toolName: 'bash', toolResult: { weird: 1 } })
      expect(out.tool_output).toBe('{"weird":1}')
    })
  })

  describe('VS Code compatibility shape', () => {
    it('finds the same fields under snake_case names', () => {
      const out = normalizeCopilotPayload({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-2',
        cwd: '/repo',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/x.ts' },
        tool_response: 'file contents',
      })

      expect(out.session_id).toBe('sess-2')
      expect(out.tool_name).toBe('Read')
      expect(out.tool_output).toBe('file contents')
    })
  })

  describe('prompts and sessions', () => {
    it('exposes a prompt as both prompt and user_message', () => {
      const out = normalizeCopilotPayload({ sessionId: 's', prompt: 'fix the parser' })
      expect(out.prompt).toBe('fix the parser')
      expect(out.user_message).toBe('fix the parser')
    })

    it('maps Copilot’s "new" session source onto the journal vocabulary', () => {
      expect(normalizeCopilotPayload({ source: 'new' }).source).toBe('startup')
    })

    it('carries inline assistant text for turn-end capture', () => {
      const out = normalizeCopilotPayload({ sessionId: 's', response: 'here is the fix' })
      expect(out.assistant_message).toBe('here is the fix')
    })
  })

  describe('timestamps', () => {
    it('converts epoch milliseconds to seconds', () => {
      expect(normalizeTimestamp(1704614400000)).toBe(1704614400)
    })

    it('passes epoch seconds through unchanged', () => {
      expect(normalizeTimestamp(1704614400)).toBe(1704614400)
    })

    it('parses the ISO 8601 form VS Code sends', () => {
      expect(normalizeTimestamp('2026-01-07T08:00:00.000Z')).toBe(1767772800)
    })

    it('returns null rather than inventing a moment', () => {
      expect(normalizeTimestamp(undefined)).toBeNull()
      expect(normalizeTimestamp('not a date')).toBeNull()
    })
  })

  it('survives an empty payload without throwing', () => {
    const out = normalizeCopilotPayload({})
    expect(out.tool_name).toBeNull()
    expect(out.session_id).toBeNull()
  })
})

/**
 * The config file Copilot reads. Every assertion here is a field the
 * previous version got wrong — and each one fails silently at runtime:
 * a config Copilot rejects produces no error, just no capture.
 */
describe('Copilot hook config file', () => {
  const write = (): Record<string, any> => {
    const path = join(mkdtempSync(join(tmpdir(), 'tc-copilot-')), 'treecontext.json')
    const result = upsertVscodeHooks(path, false, false)
    expect(result.status).toBe('created')
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  }

  it('declares the schema version Copilot requires', () => {
    expect(write().version).toBe(1)
  })

  it('registers the events under Copilot’s own vocabulary', () => {
    expect(Object.keys(write().hooks).sort()).toEqual(
      ['agentStop', 'postToolUse', 'preCompact', 'sessionStart', 'userPromptSubmitted'],
    )
  })

  it('gives every event a runnable command on both shells', () => {
    const { hooks } = write()
    for (const [event, entries] of Object.entries(hooks as Record<string, any[]>)) {
      const entry = entries[0]
      expect(entry.type, event).toBe('command')
      // Windows had nothing runnable at all when only `command` was emitted.
      // The command now names the generated tc-vscode-* wrapper (which
      // resolves node and the entry point at runtime), not the entry's .js
      // path — an inlined .js path is the version-stamped shape a node
      // upgrade strands.
      expect(entry.bash, event).toContain('tc-vscode-')
      expect(entry.powershell, event).toContain('tc-vscode-')
      expect(entry.bash, event).not.toContain('.js')
      expect(entry.timeoutSec, event).toBeGreaterThan(0)
      // `timeout` is the Claude Code key; Copilot ignores it.
      expect(entry.timeout, event).toBeUndefined()
    }
  })

  it('points assistant-turn capture at the stop adapter', () => {
    expect(write().hooks.agentStop[0].bash).toContain('tc-vscode-stop')
  })
})
