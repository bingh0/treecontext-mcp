/**
 * user-prompt-fidelity.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-25: translated 1:1 from the
 * vitest-cucumber binding; every assertion preserved. The two scenarios
 * sharing the Then sentence 'the node is found and its returned content
 * is the full original message' share one definition over world state;
 * store close moved from mid-step to defer — no assertion depends on
 * closed state.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import * as shared from '../../src/hooks/shared.js'
import { main as userPromptSubmitMain } from '../../src/hooks/user-prompt-submit.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { INDEX_CAP_USER } from '../../src/persistence/index-text.js'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  tmpDir?: string
  tempDbPath?: string
  message?: string
  store?: FlatStore
  fullMessage?: string
  hits?: Awaited<ReturnType<FlatStore['query']>>
}

/** The pre-expansion staging schema user-prompt-submit.ts writes into. */
const UPSF_STAGING_DDL = `
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

export const userPromptFidelityDefiner = (reg: Registry<World>): void => {
  reg.define(/^a user message of 5000 characters$/, (w) => {
    w.tmpDir = mkdtempSync(join(tmpdir(), 'tc-upsf-'))
    w.defer(() => rmSync(w.tmpDir!, { recursive: true, force: true }))
    w.tempDbPath = join(w.tmpDir, 'treecontext.db')
    const db = new BetterSqlite3(w.tempDbPath)
    db.exec(UPSF_STAGING_DDL)
    db.close()
    w.message = 'm'.repeat(5000)
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(w.tempDbPath)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({ session_id: 'sess-1', cwd: '/tmp', prompt: w.message })
    w.defer(() => { vi.restoreAllMocks() })
  })

  reg.define(/^the user-prompt-submit hook runs$/, () => {
    userPromptSubmitMain()
  })

  reg.define(/^the staged content is the full 5000-character message, not truncated to 2000$/, (w) => {
    const db = new BetterSqlite3(w.tempDbPath!)
    const row = db.prepare('SELECT content FROM staging').get() as { content: string } | undefined
    db.close()
    expect(row).toBeDefined()
    expect(row!.content).toBe(w.message)
    expect(row!.content.length).toBe(5000)
  })

  reg.define(/^a 5000-character message stored as an auto-capture user node without an index marker$/, async (w) => {
    w.tmpDir = mkdtempSync(join(tmpdir(), 'tc-upsf-flat-'))
    w.defer(() => rmSync(w.tmpDir!, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(w.tmpDir, 'flat.db')))
    w.store = await FlatStore.open({ database: db })
    w.defer(() => void w.store!.close())
    w.fullMessage = `withinCapMarker9000 ${'m'.repeat(INDEX_CAP_USER + 2000)} pastCapMarker9000`
    await w.store.insert(w.fullMessage, { metadata: { source: 'auto-capture', role: 'user', session_id: 's1' } })
  })

  reg.define(/^querying for a marker placed within the first 2000 characters$/, async (w) => {
    w.hits = await w.store!.query('withinCapMarker9000')
  })

  reg.define(/^the node is found and its returned content is the full original message$/, async (w) => {
    expect(w.hits!.length).toBe(1)
    expect(w.hits![0]!.content).toBe(w.fullMessage)
  })

  reg.define(/^querying for a marker placed only after the first 2000 characters returns no hits$/, async (w) => {
    const pastHits = await w.store!.query('pastCapMarker9000')
    expect(pastHits.length).toBe(0)
  })

  reg.define(/^the same 5000-character message stored with the expansion's full-length marker$/, async (w) => {
    w.tmpDir = mkdtempSync(join(tmpdir(), 'tc-upsf-post18-'))
    w.defer(() => rmSync(w.tmpDir!, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(w.tmpDir, 'flat.db')))
    w.store = await FlatStore.open({ database: db })
    w.defer(() => void w.store!.close())
    w.fullMessage = `withinCapMarker9000 ${'m'.repeat(INDEX_CAP_USER + 2000)} pastCapMarker9000`
    await w.store.insert(w.fullMessage, {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: w.fullMessage.length },
    })
  })

  reg.define(/^querying for the marker placed only after the first 2000 characters$/, async (w) => {
    w.hits = await w.store!.query('pastCapMarker9000')
  })
}
