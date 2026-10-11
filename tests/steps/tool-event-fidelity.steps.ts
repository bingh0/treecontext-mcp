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
import { hostname, tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
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
import { extractInsertEcho } from '../../src/server/echo-correlation.js'
import { LeaseClient, DRAIN_LEASE_TTL_SECS } from '../../src/persistence/leases.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { decodeContent } from '../../src/persistence/content-codec.js'

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
  claudeResponse?: unknown
  /** The D270 scenarios: whole Claude Code-shaped payloads (tool_name,
   *  tool_input, tool_response), staged in order by the When step. */
  payloads?: Array<Record<string, unknown>>
  /** The staged rows of `payloads`, in order. */
  rows?: Array<{ content: string; index_len: number | null }>
  /** D265: the stale drain, the store it serves, and what it was seen doing. */
  stale?: {
    loop: IngestionLoop
    staged: string[]
    /** ingestBatch / runSweep calls once the step-aside tick had run. */
    ticksAtAside?: number
    sweepsAtAside?: number
    ticksToRelease?: number
    warnings?: string[]
    asideAt?: number
  }
}

/** Raw read of the store a scenario serves — its own handle, closed after. */
function rawRead<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
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

  /** Stage each of `w.payloads` through the real hook, in order (D270). */
  function runPayloads(w: World): void {
    for (const p of w.payloads!) {
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.dbPath!)
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({ session_id: 'fidelity-session', cwd: '/tmp', ...p })
      postToolUseMain()
      vi.restoreAllMocks()
    }
    const db = new BetterSqlite3(w.dbPath!)
    w.rows = db.prepare('SELECT content, index_len FROM staging ORDER BY id').all() as Array<{ content: string; index_len: number | null }>
    db.close()
    w.row = w.rows.at(-1)
  }

  /** The text between `Output:\n` and the end (or the tail separator). */
  function outputOf(content: string): string {
    const at = content.lastIndexOf('\nOutput:\n')
    expect(at).toBeGreaterThan(-1)
    return content.slice(at + '\nOutput:\n'.length)
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
    if (w.payloads) {
      runPayloads(w)
      return
    }
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
    // D270: the object tool_input is composed as its text, a field's name
    // then its value on the next line, not as its JSON encoding.
    expect(row.content).toBe('Tool: Bash\nInput:\ncommand:\necho hi\nOutput:\nclaudecoderesponsetoken output body')
  })

  // D270 — object and content-block payloads compose as their text.
  reg.define(/^a PostToolUse payload whose tool_response is an object holding stdout with several lines and a tab and an interrupted flag, and whose tool_input is an object holding a multi-line command$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.payloads = [{
      tool_name: 'Bash',
      tool_input: { command: 'git status --short\r\ngit log --oneline -3', description: 'Show status and log' },
      tool_response: {
        stdout: 'a1b2c3d first line\nM\tsrc/hooks/post-tool-use.ts\nfe9e8d7 third line',
        stderr: '',
        interrupted: false,
        isImage: false,
      },
    }]
  })

  reg.define(/^the Output section carries the stdout text as its lines after its name, with the tab as a character$/, (w) => {
    const out = outputOf(w.row!.content)
    expect(out.startsWith('stdout:\na1b2c3d first line\nM\tsrc/hooks/post-tool-use.ts\nfe9e8d7 third line\n')).toBe(true)
    // The JSON encoding's two-character escapes are gone. The control: that
    // encoding of this response carries both needles.
    const encoded = JSON.stringify(w.payloads![0]!['tool_response'])
    expect(encoded).toContain('\\n')
    expect(encoded).toContain('\\t')
    // step-lint: allow unearned-absence -- guarded: the control above proves JSON.stringify of this response carries the needle
    expect(w.row!.content).not.toContain('\\n')
    // step-lint: allow unearned-absence -- guarded: the control above proves JSON.stringify of this response carries the needle
    expect(w.row!.content).not.toContain('\\t')
  })

  reg.define(/^every other field of the response is in the Output section as its name and value$/, (w) => {
    const out = outputOf(w.row!.content)
    expect(out).toBe(
      'stdout:\na1b2c3d first line\nM\tsrc/hooks/post-tool-use.ts\nfe9e8d7 third line\n' +
        'stderr:\n' +
        'interrupted: false\n' +
        'isImage: false',
    )
  })

  reg.define(/^the Input section carries the command's lines as lines after its name$/, (w) => {
    const c = w.row!.content
    const input = c.slice(c.indexOf('Input:\n') + 'Input:\n'.length, c.lastIndexOf('\nOutput:\n'))
    expect(input).toBe('command:\ngit status --short\ngit log --oneline -3\ndescription:\nShow status and log')
    expect(c.startsWith('Tool: Bash\nInput:\n')).toBe(true)
  })

  reg.define(/^a PostToolUse payload whose tool_response nests a file's content under file.content across several lines$/, (w) => {
    w.dbPath = freshHookDb(w)
    w.payloads = [{
      tool_name: 'Read',
      tool_input: { file_path: '/repo/src/quillwort.ts' },
      tool_response: {
        type: 'text',
        file: { filePath: '/repo/src/quillwort.ts', content: 'export const cadence = 7\n\tquillwortRotation()\nsigningCeremony()', numLines: 3 },
      },
    }]
  })

  reg.define(/^a second payload whose tool_response is a list of content blocks whose text is a JSON document$/, (w) => {
    w.payloads!.push({
      tool_name: 'mcp__treecontext__treecontext_insert',
      tool_input: { content: 'DECISION: quillwort weekly', metadata: { type: 'decision' } },
      tool_response: [{ type: 'text', text: JSON.stringify({ node_id: 'ab'.repeat(16), deduplicated: false }, null, 2) }],
    })
  })

  reg.define(/^the post-tool-use hook stages both$/, (w) => {
    runPayloads(w)
    expect(w.rows!.length).toBe(2)
  })

  reg.define(/^the file's content lines stand under their field path in the Output section$/, (w) => {
    const read = w.rows![0]!.content
    expect(read).toBe(
      'Tool: Read\nInput:\nfile_path:\n/repo/src/quillwort.ts\nOutput:\n' +
        'type:\ntext\n' +
        'file.filePath:\n/repo/src/quillwort.ts\n' +
        'file.content:\nexport const cadence = 7\n\tquillwortRotation()\nsigningCeremony()\n' +
        'file.numLines: 3',
    )
  })

  reg.define(/^the content block's text is written verbatim, so a key quoted inside it is still readable by key$/, (w) => {
    const echo = w.rows![1]!.content
    const text = JSON.stringify({ node_id: 'ab'.repeat(16), deduplicated: false }, null, 2)
    expect(outputOf(echo)).toBe(text)
    // A reader that reads by key, as the echo heal does, finds the id.
    expect(extractInsertEcho(echo)).toEqual({ nodeId: 'ab'.repeat(16), deduplicated: false })
    // The object input composes as its text, a nested object under its path.
    expect(echo).toContain('Input:\ncontent:\nDECISION: quillwort weekly\nmetadata.type:\ndecision\nOutput:\n')
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

  // ── D265: an old server degrades cleanly against a newer-migrated store ──
  // Its own world: a real FlatStore over one on-disk file, real
  // LeaseClients on the leases table, the production IngestionLoop on its
  // real timers. The stale side runs the real maxSupportedVersion against
  // a store whose user_version is raised past it — what a newer release's
  // migration leaves; the newer side is this binary given one version more
  // through the test-only schemaCeiling seam.
  reg.define(/^a server built for one schema version draining a store that a newer treecontext has since migrated past it$/, async (w) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-stale-drain-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    w.dbPath = join(dir, 'treecontext.db')
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true })
    w.store = store
    w.defer(() => store.close())
    const staged: string[] = []
    for (let i = 0; i < 6; i++) {
      const content = `stale-drain marker ${i} kept for the newer server`
      store.store.insertStaging({ sessionId: 'stale-session', role: 'user', content, timestamp: Date.now() / 1000 - 60 + i })
      staged.push(content)
    }
    const leases = new LeaseClient(store.store.database, { pid: process.pid, host: hostname(), label: 'stale' })
    const loop = new IngestionLoop(store, {
      batchSize: 2, intervalMs: 40, sweepIntervalMs: 60,
      drainLease: { client: leases, ttlSecs: DRAIN_LEASE_TTL_SECS },
    })
    w.defer(() => loop.stop())
    // It has been draining: one ordinary tick at its own schema takes the
    // lease and ingests a batch.
    expect(await loop.ingestBatch()).toBe(2)
    expect(rawRead<{ holder_label: string }>(w.dbPath, "SELECT holder_label FROM leases WHERE role = 'drain'"))
      .toEqual([{ holder_label: 'stale' }])
    // A batch in flight when the migration lands: rows claimed under this
    // drain's own claimant through the real claim API.
    const claimant = (loop as unknown as { claimant: string }).claimant
    expect(store.store.claimStagingBatch(claimant, 2, 120)).toHaveLength(2)
    // The newer treecontext migrates the store past this build.
    const raw = new BetterSqlite3(w.dbPath)
    raw.pragma(`user_version = ${maxSupportedVersion + 1}`)
    raw.close()
    w.stale = { loop, staged }
  })

  reg.define(/^its next drain tick takes the drain lease$/, async (w) => {
    const st = w.stale!
    const warnings: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    w.defer(() => errSpy.mockRestore())
    const tickSpy = vi.spyOn(st.loop, 'ingestBatch')
    const sweepSpy = vi.spyOn(st.loop, 'runSweep')
    w.defer(() => { tickSpy.mockRestore(); sweepSpy.mockRestore() })
    st.loop.start()
    // Wait for the lease row to go; count the ticks it took.
    const deadline = Date.now() + 10_000
    while (rawRead(w.dbPath!, "SELECT 1 FROM leases WHERE role = 'drain'").length > 0) {
      if (Date.now() > deadline) throw new Error('the stale drain never released the lease')
      await sleep(5)
    }
    st.asideAt = Date.now()
    st.ticksToRelease = tickSpy.mock.calls.length
    st.ticksAtAside = tickSpy.mock.calls.length
    st.sweepsAtAside = sweepSpy.mock.calls.length
    // Several more of its tick and sweep intervals pass.
    await sleep(400)
    st.warnings = warnings
    expect(tickSpy.mock.calls.length, 'the stale drain ticked again after stepping aside').toBe(st.ticksAtAside)
    expect(sweepSpy.mock.calls.length, 'the stale drain swept again after stepping aside').toBe(st.sweepsAtAside)
  })

  reg.define(/^it releases the lease and its staging claims, writes one warning, and stops its drain and its sweeps$/, (w) => {
    const st = w.stale!
    // The lease: gone from the table on the step-aside tick itself.
    expect(st.ticksToRelease).toBe(1)
    expect(rawRead(w.dbPath!, "SELECT role FROM leases WHERE role = 'drain'")).toEqual([])
    // The claims: none left on any row; nothing processed, nothing dropped.
    expect(rawRead(w.dbPath!, 'SELECT id FROM staging WHERE claimed_by IS NOT NULL')).toEqual([])
    expect(rawRead<{ n: number }>(w.dbPath!, 'SELECT COUNT(*) AS n FROM staging WHERE processed = 0')[0]!.n).toBe(4)
    expect(rawRead<{ n: number }>(w.dbPath!, 'SELECT COUNT(*) AS n FROM nodes')[0]!.n).toBe(2)
    // One warning across every tick since, naming the newer schema.
    const lines = st.warnings!.filter((l) => /migrated by a newer treecontext/.test(l))
    expect(lines, st.warnings!.join('\n')).toHaveLength(1)
    expect(lines[0]).toContain(`schema ${maxSupportedVersion + 1}; this build understands ${maxSupportedVersion}`)
    expect(st.warnings).toHaveLength(1)
    // Stopped for good: a direct tick neither acquires nor drains.
    return st.loop.ingestBatch().then((n) => {
      expect(n).toBe(0)
      expect(rawRead(w.dbPath!, "SELECT role FROM leases WHERE role = 'drain'")).toEqual([])
    })
  })

  reg.define(/^a newer server takes the drain on its next tick$/, async (w) => {
    const newer = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)), ownsDatabase: true,
      schemaCeiling: maxSupportedVersion + 1,
    })
    w.defer(() => newer.close())
    const leases = new LeaseClient(newer.store.database, { pid: process.pid, host: hostname(), label: 'newer' })
    const loop = new IngestionLoop(newer, {
      batchSize: 2, schemaCeiling: maxSupportedVersion + 1,
      drainLease: { client: leases, ttlSecs: DRAIN_LEASE_TTL_SECS },
    })
    w.defer(() => loop.stop())
    // Its first tick, with no wait for the 60 s lease TTL: the row is gone.
    expect(await loop.ingestBatch()).toBe(2)
    expect(rawRead(w.dbPath!, "SELECT holder_label FROM leases WHERE role = 'drain'")).toEqual([{ holder_label: 'newer' }])
    for (let i = 0; i < 10 && newer.store.countUnprocessedStaging() > 0; i++) await loop.ingestBatch()
  })

  reg.define(/^every staged event is drained by the newer server, none lost$/, (w) => {
    const st = w.stale!
    expect(rawRead<{ n: number }>(w.dbPath!, 'SELECT COUNT(*) AS n FROM staging WHERE processed = 0')[0]!.n).toBe(0)
    const nodes = rawRead<{ content: Buffer | string }>(w.dbPath!, 'SELECT content FROM nodes')
      .map((r) => decodeContent(r.content))
    expect(nodes).toHaveLength(st.staged.length)
    for (const c of st.staged) expect(nodes.filter((n) => n.includes(c)), c).toHaveLength(1)
    expect(nodes.filter((n) => n.includes('[capture gap]'))).toEqual([])
  })
}
