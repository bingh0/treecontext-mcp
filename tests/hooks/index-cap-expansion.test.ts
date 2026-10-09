/**
 * Index-cap expansion (2026-07-28 cap sweep): the FTS view widens past the
 * display preview, the two boundaries split (index_len / preview_len), and
 * TREECONTEXT_INDEX_CAP becomes the field lever for slow stores.
 *
 * The fixtures here carry the schema-18 staging table (WITH preview_len);
 * tests/hooks/hooks.test.ts keeps a pre-018 fixture, so between the two
 * files both writeStaging paths stay covered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../src/hooks/shared.js'
import { main as postToolUseMain } from '../../src/hooks/post-tool-use.js'
import { main as userPromptSubmitMain } from '../../src/hooks/user-prompt-submit.js'
import {
  activeIndexCap,
  envIndexCapOverride,
  INDEX_CAP_TOOL_DEFAULT,
  INDEX_CAP_ENV_FLOOR,
  INDEX_CAP_USER,
} from '../../src/persistence/capture-constants.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import migration018 from '../../src/persistence/migrations/018_staging_preview_len.js'

const STAGING_18 = `
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
    preview_len INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  )
`

describe('index-cap expansion', () => {
  let tempDir: string
  let tempDbPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-cap-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')
    const db = new Database(tempDbPath)
    db.exec(STAGING_18)
    db.close()
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(tempDbPath)
  })

  afterEach(() => {
    delete process.env['TREECONTEXT_INDEX_CAP']
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const readRow = (): any => {
    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get()
    db.close()
    return row
  }

  describe('activeIndexCap', () => {
    it('defaults: user/assistant full, tool at INDEX_CAP_TOOL_DEFAULT', () => {
      expect(activeIndexCap('user')).toBe(Infinity)
      expect(activeIndexCap('assistant')).toBe(Infinity)
      expect(activeIndexCap('tool')).toBe(INDEX_CAP_TOOL_DEFAULT)
    })

    it('TREECONTEXT_INDEX_CAP overrides every role', () => {
      process.env['TREECONTEXT_INDEX_CAP'] = '4000'
      expect(activeIndexCap('user')).toBe(4000)
      expect(activeIndexCap('assistant')).toBe(4000)
      expect(activeIndexCap('tool')).toBe(4000)
    })

    it('values below the floor (and garbage) are ignored', () => {
      process.env['TREECONTEXT_INDEX_CAP'] = String(INDEX_CAP_ENV_FLOOR - 1)
      expect(activeIndexCap('tool')).toBe(INDEX_CAP_TOOL_DEFAULT)
      process.env['TREECONTEXT_INDEX_CAP'] = 'fast'
      expect(activeIndexCap('user')).toBe(Infinity)
    })

    it('envIndexCapOverride reports null for rejected values — status must not claim env as source', () => {
      expect(envIndexCapOverride()).toBeNull()
      process.env['TREECONTEXT_INDEX_CAP'] = String(INDEX_CAP_ENV_FLOOR - 1)
      expect(envIndexCapOverride()).toBeNull()
      process.env['TREECONTEXT_INDEX_CAP'] = 'fast'
      expect(envIndexCapOverride()).toBeNull()
      process.env['TREECONTEXT_INDEX_CAP'] = '8000'
      expect(envIndexCapOverride()).toBe(8000)
    })
  })

  describe('post-tool-use producer', () => {
    it('long output: preview_len at the display boundary, index_len covering the tail up to the cap', () => {
      const longOutput = 'A'.repeat(5000)
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'short', tool_output: longOutput,
      })
      postToolUseMain()
      const row = readRow()

      // Display boundary: the bounded preview, exactly the pre-018 shape.
      expect(row.preview_len).toBeGreaterThan(0)
      expect(row.preview_len).toBeLessThan(2000)
      expect(row.content.slice(0, row.preview_len)).toContain('...')
      // Index boundary: the whole composed event (it fits inside 8000).
      expect(row.index_len).toBe(row.content.length)
      expect(row.index_len).toBeGreaterThan(row.preview_len)
      expect(row.content.slice(row.preview_len, row.index_len)).toContain('A'.repeat(4999))
    })

    it('an event larger than the cap indexes exactly cap chars', () => {
      const hugeOutput = 'B'.repeat(12000)
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'x', tool_output: hugeOutput,
      })
      postToolUseMain()
      const row = readRow()
      expect(row.index_len).toBe(INDEX_CAP_TOOL_DEFAULT)
      expect(row.content.length).toBeGreaterThan(INDEX_CAP_TOOL_DEFAULT)
    })

    it('JF-3 still holds: an event that fits stages NULL boundaries', () => {
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'x', tool_output: 'brief',
      })
      postToolUseMain()
      const row = readRow()
      expect(row.index_len).toBeNull()
      expect(row.preview_len).toBeNull()
    })

    it('an env cap narrower than the preview bounds even a no-tail event', () => {
      process.env['TREECONTEXT_INDEX_CAP'] = '300'
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'i'.repeat(400), tool_output: 'brief',
      })
      postToolUseMain()
      const row = readRow()
      expect(row.index_len).toBe(300)
    })
  })

  describe('user-prompt-submit producer', () => {
    it('stamps index_len at the full message length (self-describing full index)', () => {
      const message = 'giant paste '.repeat(500) + ' why does the build fail on ARM?'
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', prompt: message,
      })
      userPromptSubmitMain()
      const row = readRow()
      expect(row.index_len).toBe(message.length)
      expect(row.preview_len).toBeNull()
    })

    it('TREECONTEXT_INDEX_CAP bounds the user view', () => {
      process.env['TREECONTEXT_INDEX_CAP'] = '500'
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 't', cwd: '/tmp', prompt: 'p'.repeat(3000),
      })
      userPromptSubmitMain()
      const row = readRow()
      expect(row.index_len).toBe(500)
    })
  })

  describe('writeStaging pre-018 fallback', () => {
    it('degrades index_len to the preview boundary on a store without preview_len', () => {
      const legacyPath = path.join(tempDir, 'legacy.db')
      const db = new Database(legacyPath)
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', ''))
      db.close()
      shared.writeStaging(legacyPath, {
        sessionId: 't', role: 'assistant', content: 'preview-part' + 'tail'.repeat(100),
        toolName: 'X', timestamp: 1, priority: 3, indexLen: 250, previewLen: 12,
      })
      const check = new Database(legacyPath)
      const row = check.prepare('SELECT * FROM staging').get() as any
      check.close()
      // Pre-018 readers treat index_len as BOTH boundaries, so the widened
      // value must not reach them: the preview boundary wins.
      expect(row.index_len).toBe(12)
    })

    it('16/17 fallback: a full-length prose index_len degrades to NULL (legacy caps apply)', () => {
      const legacyPath = path.join(tempDir, 'legacy-prose.db')
      const db = new Database(legacyPath)
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', ''))
      db.close()
      const content = 'long user message '.repeat(300)
      shared.writeStaging(legacyPath, {
        sessionId: 't', role: 'user', content,
        timestamp: 1, priority: 1, indexLen: content.length,
      })
      const check = new Database(legacyPath)
      const row = check.prepare('SELECT * FROM staging').get() as any
      check.close()
      // A full-length marker is not a boundary. Staging it would make the
      // old server index the whole text — index growth on a server that was
      // never updated. NULL restores the exact old semantics (legacy caps).
      expect(row.index_len).toBeNull()
      expect(row.content).toBe(content)
    })

    it('16/17 fallback: an env-narrowed index_len wins over the preview boundary', () => {
      const legacyPath = path.join(tempDir, 'legacy-env.db')
      const db = new Database(legacyPath)
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', ''))
      db.close()
      shared.writeStaging(legacyPath, {
        sessionId: 't', role: 'assistant', content: 'p'.repeat(1500) + 't'.repeat(4000),
        toolName: 'X', timestamp: 1, priority: 3, indexLen: 300, previewLen: 1500,
      })
      const check = new Database(legacyPath)
      const row = check.prepare('SELECT * FROM staging').get() as any
      check.close()
      expect(row.index_len).toBe(300)
    })

    it('pre-16 fallback: prose is stored in FULL even when an env cap stamped index_len', () => {
      const ancientPath = path.join(tempDir, 'ancient.db')
      const db = new Database(ancientPath)
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', '').replace('index_len INTEGER,\n', ''))
      db.close()
      const content = 'user message that must never be truncated in storage '.repeat(50)
      shared.writeStaging(ancientPath, {
        sessionId: 't', role: 'user', content,
        timestamp: 1, priority: 1, indexLen: 300,
      })
      const check = new Database(ancientPath)
      const row = check.prepare('SELECT * FROM staging').get() as any
      check.close()
      // The env cap is an INDEX lever; on a store too old to carry the
      // boundary it must not shorten stored text.
      expect(row.content).toBe(content)
    })

    it('pre-16 fallback: a tailed tool event still drops exactly the tail', () => {
      const ancientPath = path.join(tempDir, 'ancient-tool.db')
      const db = new Database(ancientPath)
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', '').replace('index_len INTEGER,\n', ''))
      db.close()
      const preview = 'preview!'.repeat(100)
      shared.writeStaging(ancientPath, {
        sessionId: 't', role: 'assistant', content: preview + '\nTAIL'.repeat(500),
        toolName: 'X', timestamp: 1, priority: 3, indexLen: 8000, previewLen: preview.length,
      })
      const check = new Database(ancientPath)
      const row = check.prepare('SELECT * FROM staging').get() as any
      check.close()
      expect(row.content).toBe(preview)
    })
  })

  describe('ingestion boundary propagation', () => {
    it('carries both staged boundaries into node metadata verbatim', async () => {
      const preview = 'Tool: X\nOutput:\npreview...'
      const content = preview + '\n--- FULL ---\ntail '.repeat(400)
      shared.writeStaging(tempDbPath, {
        sessionId: 't', role: 'assistant', content, toolName: 'X',
        timestamp: 1, priority: 3,
        indexLen: Math.min(8000, content.length), previewLen: preview.length,
      })
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new Database(tempDbPath) as any),
        ownsDatabase: true,
      })
      await new IngestionLoop(store, { batchSize: 10 }).ingestBatch()
      const node = (JSON.parse(store.exportJson()) as { nodes: Array<{ metadata?: Record<string, unknown> }> })
        .nodes.find((n) => n.metadata?.['tool_name'] === 'X')!
      expect(node.metadata?.['_preview_len']).toBe(preview.length)
      expect(node.metadata?.['_index_len']).toBe(Math.min(8000, content.length))
      await store.close()
    })
  })

  describe('C3 demotion of post-018 rows', () => {
    // File-backed stores: demotion archives before it shrinks (ruled
    // 2026-07-31) and refuses outright on an archiveless in-memory store.
    function demotionDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-capexp-demote-'))
      cleanupDirs.push(dir)
      return dir
    }
    const cleanupDirs: string[] = []
    afterEach(() => {
      for (const d of cleanupDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    })

    it('a fully-indexed prose row still demotes — to the frozen legacy cap', async () => {
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new Database(path.join(demotionDir(), 'd.db')) as any),
        ownsDatabase: true,
        maxStoreBytes: 1,
        maxSessions: 1_000_000,
        maxAutoEntries: 1_000_000,
        retentionInterval: 1_000_000,
      })
      // Incompressible: a repeated-char body stores at ~30 bytes and the
      // valve correctly treats shrinking it as zero-saving (round-2 R4).
      const content = 'demoteMarkerTerm ' + randomBytes(INDEX_CAP_USER + 3000).toString('base64').slice(0, INDEX_CAP_USER + 3000)
      const res = await store.insert(content, {
        // Post-018 shape: hooks stamp a full-length _index_len.
        metadata: { source: 'auto-capture', role: 'user', session_id: 's1', _index_len: content.length },
      })
      store.retentionSweep()
      const node = (await store.query('demoteMarkerTerm', { topK: 1 }))[0]
      expect(node).toBeDefined()
      const exported = (JSON.parse(store.exportJson()) as { nodes: Array<{ nodeId: string; content: string; metadata?: Record<string, unknown> }> })
        .nodes.find((n) => n.nodeId === res.nodeId)!
      expect(exported.metadata?.['_demoted']).toBe(true)
      expect(exported.content.length).toBe(INDEX_CAP_USER)
      // The marker was restamped to the shrunk length — no stale wide view.
      expect(exported.metadata?.['_index_len']).toBe(INDEX_CAP_USER)
      await store.close()
    })

    it('a tailed tool row demotes to its display preview, dropping the indexed tail', async () => {
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new Database(path.join(demotionDir(), 'd.db')) as any),
        ownsDatabase: true,
        maxStoreBytes: 1,
        maxSessions: 1_000_000,
        maxAutoEntries: 1_000_000,
        retentionInterval: 1_000_000,
      })
      const preview = 'Tool: Bash\nOutput:\npreviewTerm...'
      const content = preview + '\n--- FULL ---\ntailOnlyTerm ' + 'x'.repeat(6000)
      const res = await store.insert(content, {
        metadata: {
          source: 'auto-capture', role: 'assistant', tool_name: 'Bash', session_id: 's1',
          _preview_len: preview.length, _index_len: Math.min(8000, content.length),
        },
      })
      // Pre-demotion the tail is findable through the widened view.
      expect((await store.query('tailOnlyTerm', { topK: 1 })).length).toBe(1)
      store.retentionSweep()
      const exported = (JSON.parse(store.exportJson()) as { nodes: Array<{ nodeId: string; content: string; metadata?: Record<string, unknown> }> })
        .nodes.find((n) => n.nodeId === res.nodeId)!
      expect(exported.metadata?.['_demoted']).toBe(true)
      expect(exported.content).toBe(preview)
      expect(exported.metadata?.['_preview_len']).toBeUndefined()
      // FTS recompute stayed consistent: the preview is findable, the
      // dropped tail is not.
      expect((await store.query('previewTerm', { topK: 1 })).length).toBe(1)
      expect((await store.query('tailOnlyTerm', { topK: 1 })).length).toBe(0)
      await store.close()
    })
  })

  describe('flat-store read side', () => {
    it('searches the widened index view but displays only the preview', async () => {
      const store = await FlatStore.open({
        database: wrapBetterSqlite(new Database(':memory:') as any),
      })
      const preview = 'Tool: Bash\nOutput:\nstarted...'
      const tail = '\n--- FULL ---\nOutput:\nstarted then failed with XERROXQUARK at line 9\n' + 'pad '.repeat(200)
      const content = preview + tail
      await store.insert(content, {
        metadata: {
          source: 'auto-capture', role: 'assistant', tool_name: 'Bash', session_id: 's',
          _preview_len: preview.length,
          _index_len: Math.min(8000, content.length - 1),
        },
      })

      // The distinctive token lives PAST the preview but INSIDE the index
      // view — pre-expansion this query found nothing.
      const hits = await store.query('XERROXQUARK', { topK: 5 })
      expect(hits.length).toBe(1)
      // Display stays bounded at the preview with the availability marker.
      expect(hits[0]!.content.startsWith(preview)).toBe(true)
      expect(hits[0]!.content).toContain('…[preview; full content')
      expect(hits[0]!.content).not.toContain('XERROXQUARK')
      await store.close()
    })
  })

  describe('migration 018', () => {
    it('adds preview_len and tolerates re-application', () => {
      const db = new Database(':memory:')
      db.exec(STAGING_18.replace('preview_len INTEGER,\n', ''))
      migration018.up(db as any)
      migration018.up(db as any)
      const cols = db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>
      expect(cols.filter((c) => c.name === 'preview_len').length).toBe(1)
      db.close()
    })
  })
})
