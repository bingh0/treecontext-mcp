/**
 * stop.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion preserved. Scenario-local
 * closures became world state; AfterEachScenario cleanup became defer.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi, expect } from 'vitest'
import Database from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import * as shared from '../../src/hooks/shared.js'
import { extractLastAssistantText, main as stopMain } from '../../src/hooks/stop.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  tmpDir?: string
  tempDbPath?: string
  transcriptPath?: string
  extracted?: string | null
  mockExit?: ReturnType<typeof vi.spyOn>
}

function transcriptLine(entry: unknown): string {
  return JSON.stringify(entry)
}

/** The pre-expansion staging schema stop.ts writes into. */
const STOP_STAGING_DDL = `
  CREATE TABLE staging (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT CHECK(role IN ('user', 'assistant', 'tool_result', 'snapshot')),
    content TEXT,
    tool_name TEXT,
    timestamp REAL,
    priority INTEGER DEFAULT 3,
    processed INTEGER DEFAULT 0,
    created_at REAL
  )
`

function freshTmp(w: World, prefix: string): string {
  w.tmpDir = mkdtempSync(join(tmpdir(), prefix))
  w.defer(() => rmSync(w.tmpDir!, { recursive: true, force: true }))
  return w.tmpDir
}

export const stopDefiner = (reg: Registry<World>): void => {
  reg.define(/^a transcript with an earlier assistant text turn, a middle turn with text and a tool_use block, and a final assistant turn that is tool_use only$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-')
    w.transcriptPath = join(tmpDir, 'transcript.jsonl')
    const lines = [
      transcriptLine({ type: 'user', message: { role: 'user', content: 'hi' } }),
      transcriptLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier turn text' }] } }),
      transcriptLine({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      transcriptLine({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'the final answer' },
            { type: 'tool_use', id: 'abc', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      transcriptLine({ type: 'tool_result', message: { role: 'tool', content: 'output' } }),
      transcriptLine({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'def', name: 'Read', input: {} }] },
      }),
    ]
    writeFileSync(w.transcriptPath, lines.join('\n') + '\n')
  })

  reg.define(/^the last assistant text is extracted$/, (w) => {
    w.extracted = extractLastAssistantText(w.transcriptPath!)
  })

  reg.define(/^it is the text from the middle turn, not the earlier turn and not any tool_use JSON$/, (w) => {
    expect(w.extracted).toBe('the final answer')
  })

  reg.define(/^a session whose last assistant response is already staged, and a transcript whose final turn is tool_use only$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-refire-')
    w.tempDbPath = join(tmpDir, 'treecontext.db')
    const db = new Database(w.tempDbPath)
    db.exec(STOP_STAGING_DDL)
    db.close()
    // The transcript the first Stop already captured, now with a
    // tool_use-only turn appended: extraction scans past it and finds
    // the SAME text again.
    const RESPONSE = 'the response text that must not double-stage'
    w.transcriptPath = join(tmpDir, 'transcript.jsonl')
    writeFileSync(
      w.transcriptPath,
      transcriptLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: RESPONSE }] } }) + '\n' +
        transcriptLine({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
        }) + '\n',
    )
    w.mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.tempDbPath)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-refire',
      cwd: '/tmp',
      transcript_path: w.transcriptPath,
    })
    w.defer(() => { vi.restoreAllMocks() })
    stopMain() // the first fire — stages the response
    const check = new Database(w.tempDbPath)
    const n = (check.prepare('SELECT COUNT(*) AS n FROM staging').get() as { n: number }).n
    check.close()
    expect(n, 'fixture precondition: the first fire must stage the response').toBe(1)
  })

  reg.define(/^the Stop hook runs again$/, () => {
    stopMain()
  })

  reg.define(/^no second staging row is written for that response$/, (w) => {
    const db = new Database(w.tempDbPath!)
    const rows = db.prepare('SELECT content FROM staging').all() as Array<{ content: string }>
    db.close()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('the response text that must not double-stage')
  })

  reg.define(/^a transcript containing only user messages and tool_use blocks$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-')
    w.transcriptPath = join(tmpDir, 'transcript.jsonl')
    const lines = [
      transcriptLine({ type: 'user', message: { role: 'user', content: 'hi' } }),
      transcriptLine({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
      }),
    ]
    writeFileSync(w.transcriptPath, lines.join('\n') + '\n')
  })

  reg.define(/^the result is null$/, (w) => {
    expect(w.extracted).toBeNull()
  })

  reg.define(/^a transcript path that does not exist on disk$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-')
    w.transcriptPath = join(tmpDir, 'nope.jsonl')
  })

  reg.define(/^a hook input with a transcript_path resolving to a real transcript ending in assistant text$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-')
    w.tempDbPath = join(tmpDir, 'treecontext.db')
    const db = new Database(w.tempDbPath)
    db.exec(STOP_STAGING_DDL)
    db.close()

    w.transcriptPath = join(tmpDir, 'transcript.jsonl')
    writeFileSync(
      w.transcriptPath,
      transcriptLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the response text' }] } }) + '\n',
    )

    w.mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.tempDbPath)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1',
      cwd: '/tmp',
      transcript_path: w.transcriptPath,
    })
    w.defer(() => { vi.restoreAllMocks() })
  })

  reg.define(/^the Stop hook runs$/, () => {
    stopMain()
  })

  reg.define(/^a staging row is written with role assistant, no tool_name, and the extracted text as content$/, (w) => {
    const db = new Database(w.tempDbPath!)
    const row = db.prepare('SELECT * FROM staging').get() as
      | { role: string; content: string; tool_name: string | null; priority: number }
      | undefined
    db.close()
    expect(row).toBeDefined()
    expect(row!.role).toBe('assistant')
    expect(row!.tool_name).toBeNull()
    expect(row!.content).toBe('the response text')
    expect(row!.priority).toBe(2)
    expect(w.mockExit).toHaveBeenCalledWith(0)
  })

  reg.define(/^a hook input with no transcript_path$/, (w) => {
    const tmpDir = freshTmp(w, 'tc-stop-')
    w.tempDbPath = join(tmpDir, 'treecontext.db')
    const db = new Database(w.tempDbPath)
    db.exec(STOP_STAGING_DDL)
    db.close()
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.tempDbPath)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({ session_id: 'sess-1', cwd: '/tmp' })
    w.defer(() => { vi.restoreAllMocks() })
  })

  reg.define(/^no staging row is written$/, (w) => {
    const db = new Database(w.tempDbPath!)
    const row = db.prepare('SELECT * FROM staging').get()
    db.close()
    expect(row).toBeUndefined()
  })
}
