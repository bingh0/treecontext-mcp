/**
 * tool-event-fidelity.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion and both staging DDLs
 * preserved. The five scenarios sharing the When sentence "the
 * post-tool-use hook stages it" share one definition that stages whatever
 * event their Given steps placed in the world — including the Claude Code
 * tool_response payload shape, whose special casing travels with the
 * world. afterAll temp-dir cleanup became per-fixture defer.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import * as shared from '../../src/hooks/shared.js'
import { main as postToolUseMain, FULL_TAIL_SEPARATOR } from '../../src/hooks/post-tool-use.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { STORE_SAFETY_CAP } from '../../src/persistence/capture-constants.js'
import { EXPLICIT_INDEX_LEN_KEY } from '../../src/persistence/index-text.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  dbPath?: string
  row?: { content: string; index_len?: number | null } | undefined
  store?: FlatStore
  /** What the shared staging When-step sends, set by each Given. */
  toolInput?: string | Record<string, unknown>
  toolOutput?: string
  toolName?: string
  /** The Claude Code scenario: the result arrives under tool_response. */
  claudeResponse?: string
}

const STAGING_DDL = `
  CREATE TABLE staging (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT CHECK(role IN ('user', 'assistant', 'tool_result', 'snapshot')),
    content TEXT,
    tool_name TEXT,
    timestamp REAL,
    priority INTEGER DEFAULT 3,
    processed INTEGER DEFAULT 0,
    created_at REAL,
    index_len INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  )
`

const LEGACY_STAGING_DDL = STAGING_DDL.replace(/,\n\s*index_len INTEGER,\n\s*attempts INTEGER NOT NULL DEFAULT 0/, '')

export const toolEventFidelityDefiner = (reg: Registry<World>): void => {
  function freshHookDb(w: World, ddl = STAGING_DDL): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-fidelity-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'treecontext.db')
    const db = new BetterSqlite3(dbPath)
    db.exec(ddl)
    db.close()
    return dbPath
  }

  function runHook(w: World): void {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.dbPath!)
    if (w.claudeResponse !== undefined) {
      // The REAL Claude Code payload shape: tool_response, not tool_output.
      // Every other scenario uses the normalized name; this pin is what
      // catches the field-name regression that left the journal input-only
      // on the flagship platform.
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'fidelity-session',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_response: w.claudeResponse,
      })
    } else {
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'fidelity-session',
        cwd: '/tmp',
        tool_name: w.toolName ?? 'TestTool',
        tool_input: w.toolInput!,
        tool_output: w.toolOutput!,
      })
    }
    postToolUseMain()
    vi.restoreAllMocks()
  }

  function readRow(dbPath: string): { content: string; index_len: number | null } {
    const db = new BetterSqlite3(dbPath)
    const row = db.prepare('SELECT content, index_len FROM staging ORDER BY id DESC LIMIT 1').get() as {
      content: string
      index_len: number | null
    }
    db.close()
    return row
  }

  reg.define(/^a tool event whose input exceeds 500 chars and whose output exceeds 1000 chars$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.toolInput = 'I'.repeat(900)
    w.toolOutput = 'O'.repeat(4000)
  })

  reg.define(/^the post-tool-use hook stages it$/, (w) => {
    runHook(w)
    w.row = readRow(w.dbPath!)
  })

  reg.define(/^the hook stages it$/, (w) => {
    runHook(w)
    w.row = readRow(w.dbPath!)
  })

  reg.define(/^the staged content begins with exactly today's preview composition$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    const bigInput = w.toolInput as string
    const bigOutput = w.toolOutput as string
    const expectedPreview =
      `Tool: TestTool\n` +
      `Input:\n${bigInput.substring(0, 500)}...\n` +
      `Output:\n${bigOutput.substring(0, 1000)}...`
    expect(row.content.startsWith(expectedPreview)).toBe(true)
  })

  reg.define(/^the full input and full output follow after the tail separator$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    const tail = row.content.slice(row.index_len!)
    expect(tail).toContain(FULL_TAIL_SEPARATOR)
    expect(tail).toContain(w.toolInput as string)
    expect(tail).toContain(w.toolOutput as string)
  })

  reg.define(/^on this pre-expansion store staging.index_len equals the preview length in UTF-16 code units$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    const bigInput = w.toolInput as string
    const bigOutput = w.toolOutput as string
    const expectedPreview =
      `Tool: TestTool\n` +
      `Input:\n${bigInput.substring(0, 500)}...\n` +
      `Output:\n${bigOutput.substring(0, 1000)}...`
    expect(row.index_len).toBe(expectedPreview.length)
  })

  reg.define(/^a tool event whose input is under 500 chars and whose output is under 1000 chars$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.toolInput = 'small input'
    w.toolOutput = 'small output'
  })

  reg.define(/^the staged content is the preview alone with no tail$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    expect(row.content).toBe('Tool: TestTool\nInput:\nsmall input\nOutput:\nsmall output')
    expect(row.content).not.toContain(FULL_TAIL_SEPARATOR)
  })

  reg.define(/^staging.index_len is NULL$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    expect(row.index_len).toBeNull()
  })

  reg.define(/^a tool event whose output contains multibyte characters before the 1000-char cap$/, (w) => {
    w.dbPath = freshHookDb(w)
    // Multibyte (emoji = 2 code units, 4 utf8 bytes each) filling the whole
    // 1000-code-unit preview; the distinct token starts exactly at the cap.
    w.toolInput = 'in'
    w.toolOutput = '\u{1F680}'.repeat(500) + ' DISTINCTTAILTOKEN ' + 'Z'.repeat(2000)
  })

  reg.define(/^the hook stages it and ingestion inserts it$/, async (w) => {
    runHook(w)
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath!))
    w.store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => void w.store!.close())
    const loop = new IngestionLoop(w.store, { batchSize: 10 })
    await loop.ingestBatch()
  })

  reg.define(/^on this pre-expansion store the FTS index view sliced at _index_len equals the preview exactly$/, async (w) => {
    const hits = await w.store!.query('TestTool', { topK: 5 })
    expect(hits.length).toBe(1)
    const meta = hits[0]!.metadata!
    const len = meta[EXPLICIT_INDEX_LEN_KEY] as number
    const raw = JSON.parse(w.store!.exportJson({ nodeId: hits[0]!.nodeId })) as { nodes: Array<{ content: string }> }
    const full = raw.nodes[0]!.content
    const emojiOutput = w.toolOutput as string
    const expectedPreview =
      `Tool: TestTool\nInput:\nin\nOutput:\n${emojiOutput.substring(0, 1000)}...`
    expect(full.slice(0, len)).toBe(expectedPreview)
  })

  reg.define(/^no tail text is findable through this store's index$/, async (w) => {
    const hits = await w.store!.query('DISTINCTTAILTOKEN', { topK: 5 })
    expect(hits.length).toBe(0)
  })

  reg.define(/^a tool event whose full output alone approaches the 256KB store safety cap$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.toolInput = 'in'
    w.toolOutput = 'H'.repeat(STORE_SAFETY_CAP + 50_000)
  })

  reg.define(/^the composed content fits the cap$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    expect(row.content.length).toBeLessThanOrEqual(STORE_SAFETY_CAP)
  })

  reg.define(/^the preview is intact and the tail ends with the truncation notice$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    const hugeOutput = w.toolOutput as string
    const expectedPreview = `Tool: TestTool\nInput:\nin\nOutput:\n${hugeOutput.substring(0, 1000)}...`
    expect(row.content.startsWith(expectedPreview)).toBe(true)
    expect(row.index_len).toBe(expectedPreview.length)
    expect(row.content.endsWith('[full content truncated to fit store cap]')).toBe(true)
  })

  reg.define(/^a tool event with an oversized input whose output is a shielded-file pointer$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.toolInput = 'X'.repeat(700)
    w.toolOutput = JSON.stringify({ shielded: true, file: '/tmp/shield.txt', bytes: 12345 })
  })

  reg.define(/^the tail carries the full input and never the shielded output$/, (w) => {
    const row = w.row as { content: string; index_len: number | null }
    expect(row.content).toContain('Output: [shielded to /tmp/shield.txt, 12345 bytes]')
    expect(row.index_len).not.toBeNull()
    const tail = row.content.slice(row.index_len!)
    expect(tail).toContain(FULL_TAIL_SEPARATOR)
    expect(tail).toContain('X'.repeat(700))
    // step-lint: allow unearned-absence -- guarded: the head's shield marker is asserted positively at the top of this definition and the tail's X-repeat payload two lines up — the tail carries input, never the shield text
    expect(tail).not.toContain('shielded')
  })

  reg.define(/^a shielded event whose input fits stages the pointer preview alone with NULL index_len$/, (w) => {
    // The original binding re-staged with a fitting input here.
    w.toolInput = 'tiny'
    runHook(w)
    const row = readRow(w.dbPath!)
    expect(row.content).toContain('Output: [shielded to /tmp/shield.txt, 12345 bytes]')
    expect(row.content).not.toContain(FULL_TAIL_SEPARATOR)
    expect(row.index_len).toBeNull()
  })

  reg.define(/^a staging table without the index_len column$/, (w) => {
    w.dbPath = freshHookDb(w, LEGACY_STAGING_DDL)
    w.toolInput = 'in'
    w.toolOutput = 'B'.repeat(3000)
  })

  reg.define(/^the hook stages an oversized tool event$/, (w) => {
    runHook(w)
    const db = new BetterSqlite3(w.dbPath!)
    w.row = db.prepare('SELECT content FROM staging ORDER BY id DESC LIMIT 1').get() as { content: string } | undefined
    db.close()
  })

  reg.define(/^the event is staged through the legacy column list rather than lost$/, (w) => {
    expect(w.row).toBeDefined()
  })

  reg.define(/^the staged content is the preview alone — a tail without its boundary would be indexed whole$/, (w) => {
    const row = w.row as { content: string }
    // Pre-16 schemas have no boundary column; staging the tail would make
    // ingestion index the whole 256KB blob as-is. The fallback stages the
    // byte-identical pre-C4 preview instead.
    expect(row.content).not.toContain(FULL_TAIL_SEPARATOR)
    expect(row.content).toContain('B'.repeat(1000))
    // step-lint: allow unearned-absence -- guarded: the adjacent positive pins 'B'.repeat(1000) present — an exactly-at-cap boundary; 1001 excludes the off-by-one
    expect(row.content).not.toContain('B'.repeat(1001))
  })

  reg.define(/^a PostToolUse payload carrying the result under tool_response, as Claude Code sends it$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.claudeResponse = 'claudecoderesponsetoken output body'
  })

  reg.define(/^the staged content carries an Output section with that result$/, (w) => {
    const row = w.row as { content: string }
    expect(row.content).toContain('Output:\nclaudecoderesponsetoken output body')
  })

  reg.define(/^a staged row with index_len set$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.toolInput = 'in'
    w.toolName = 'BoundedTool'
    w.toolOutput = 'C'.repeat(3000)
    runHook(w)
  })

  reg.define(/^the ingestion loop inserts it$/, async (w) => {
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath!))
    w.store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => void w.store!.close())
    const loop = new IngestionLoop(w.store, { batchSize: 10 })
    await loop.ingestBatch()
  })

  reg.define(/^the node's metadata _index_len equals the staged index_len$/, async (w) => {
    const raw = new BetterSqlite3(w.dbPath!)
    const staged = raw.prepare('SELECT index_len FROM staging WHERE tool_name = ?').get('BoundedTool') as { index_len: number }
    raw.close()
    const hits = await w.store!.query('BoundedTool', { topK: 5 })
    expect(hits.length).toBe(1)
    expect(hits[0]!.metadata![EXPLICIT_INDEX_LEN_KEY]).toBe(staged.index_len)
  })

  reg.define(/^a staged row with NULL index_len produces a node without the marker$/, async (w) => {
    w.store!.store.insertStaging({
      sessionId: 'fidelity-session',
      role: 'assistant',
      content: 'Tool: PlainTool\nInput:\ntiny\nOutput:\ntiny result',
      toolName: 'PlainTool',
      timestamp: Date.now() / 1000,
      priority: 2,
    })
    const loop = new IngestionLoop(w.store!, { batchSize: 10 })
    await loop.ingestBatch()
    const hits = await w.store!.query('PlainTool', { topK: 5 })
    expect(hits.length).toBe(1)
    expect(hits[0]!.metadata![EXPLICIT_INDEX_LEN_KEY]).toBeUndefined()
    // step-lint: allow unearned-absence -- guarded: the raw blob is asserted present above via hits[0]; '…[preview;' is the truncation formatter (src/flat-store.ts:255) whose presence would mean formatted rather than byte-identical staging
    expect(hits[0]!.content).not.toContain('…[preview;')
  })

  reg.define(/^two runs of the same command whose previews match but whose full outputs differ$/, (w) => {
    w.dbPath = freshHookDb(w)
    const commonHead = 'D'.repeat(1500)
    w.toolInput = 'same input'
    w.toolName = 'TestTool'
    w.toolOutput = commonHead + 'FIRST TAIL'
    runHook(w)
    w.toolOutput = commonHead + 'SECOND TAIL'
    runHook(w)
  })

  reg.define(/^both are ingested inside the dedup window, in one session$/, async (w) => {
    // Same session, seconds apart: the ONLY thing keeping these two rows
    // distinct is that the fingerprint covers the composed content past
    // the identical preview head.
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath!))
    w.store = await FlatStore.open({ database: db, ownsDatabase: true })
    w.defer(() => void w.store!.close())
    const loop = new IngestionLoop(w.store, { batchSize: 10 })
    await loop.ingestBatch()
  })

  reg.define(/^two nodes exist, pinning that fingerprints cover the composed content$/, (w) => {
    expect(w.store!.status().totalNodes).toBe(2)
  })
}
