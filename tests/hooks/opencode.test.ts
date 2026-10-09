import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../src/hooks/shared.js'
import { TreecontextPlugin } from '../../src/hooks/opencode/plugin.js'
import type { PluginInput, Hooks } from '@opencode-ai/plugin'

function setupDb(dbPath: string) {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS staging (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_name TEXT,
      timestamp REAL,
      priority INTEGER DEFAULT 3,
      processed INTEGER DEFAULT 0,
      created_at REAL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      queries TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at REAL,
      created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_unclaimed ON snapshots(claimed_by) WHERE claimed_by IS NULL;
  `)
  return db
}

describe('opencode plugin (Layers 2 + 3)', () => {
  let tempDbPath: string
  let tempDir: string
  let hooks: Hooks

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    const db = setupDb(tempDbPath)
    db.close()

    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(tempDbPath)

    const mockInput = {
      client: {} as any,
      project: { id: 'test-project' } as any,
      directory: tempDir,
      worktree: tempDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:3000'),
      $: {} as any,
    } satisfies PluginInput

    hooks = await TreecontextPlugin(mockInput)
  })

  afterEach(() => {
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)
      if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal')
      if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm')
      fs.rmdirSync(tempDir)
    } catch {}
    vi.restoreAllMocks()
  })

  describe('Layer 2: chat.message', () => {
    it('captures user message to staging', async () => {
      await hooks['chat.message']!(
        { sessionID: 'sess-1', model: { providerID: 'test', modelID: 'test' } },
        {
          message: { id: 'm1', sessionID: 'sess-1', role: 'user', time: { created: Date.now() }, agent: 'build', model: { providerID: 'test', modelID: 'test' } },
          parts: [{ id: 'p1', sessionID: 'sess-1', messageID: 'm1', type: 'text' as const, text: 'fix the bug in parser.ts' }],
        },
      )

      const db = new Database(tempDbPath)
      const row = db.prepare('SELECT * FROM staging').get() as any
      db.close()

      expect(row).toBeDefined()
      expect(row.role).toBe('user')
      expect(row.content).toContain('fix the bug')
      expect(row.session_id).toBe('sess-1')
    })
  })

  describe('Layer 2: tool.execute.after', () => {
    it('captures Edit tool with priority 1', async () => {
      await hooks['tool.execute.after']!(
        { tool: 'Edit', sessionID: 'sess-1', callID: 'c1', args: { file: 'a.ts' } },
        { title: 'Edited a.ts', output: 'done', metadata: {} },
      )

      const db = new Database(tempDbPath)
      const row = db.prepare('SELECT * FROM staging').get() as any
      db.close()

      expect(row).toBeDefined()
      expect(row.priority).toBe(1)
      expect(row.tool_name).toBe('Edit')
    })

    it('skips read-only tools', async () => {
      await hooks['tool.execute.after']!(
        { tool: 'Read', sessionID: 'sess-1', callID: 'c1', args: {} },
        { title: 'Read file', output: 'contents', metadata: {} },
      )

      const db = new Database(tempDbPath)
      const row = db.prepare('SELECT * FROM staging').get()
      db.close()

      expect(row).toBeUndefined()
    })
  })

  describe('Layer 3: session.compacting', () => {
    it('writes snapshot and enriches compaction prompt', async () => {
      const output: { context: string[]; prompt?: string } = { context: [] }

      await hooks['experimental.session.compacting']!(
        { sessionID: 'sess-1' },
        output,
      )

      const db = new Database(tempDbPath)
      const snapshot = db.prepare('SELECT * FROM snapshots').get() as any
      db.close()

      expect(snapshot).toBeDefined()
      expect(snapshot.session_id).toBe('sess-1')

      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain('snapshot #')
      expect(output.context[0]).toContain('Preserve key decisions')
    })
  })

  describe('Layer 3: system.transform rehydration', () => {
    it('injects rehydration context after session.created event', async () => {
      const db = new Database(tempDbPath)
      db.prepare(
        `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
         VALUES (?, 'user', ?, ?, 1, 0, ?)`
      ).run('sess-1', 'working on parser refactor', Date.now() / 1000, Date.now() / 1000)
      db.close()

      // Simulate session.created event
      await hooks.event!({
        event: {
          type: 'session.created',
          properties: {
            info: { id: 'sess-1', projectID: 'p1', directory: tempDir, title: 'test', version: '1', time: { created: Date.now(), updated: Date.now() } },
          },
        },
      })

      // Now system.transform should inject context
      const output = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']!(
        { sessionID: 'sess-1', model: { id: 'test', providerID: 'p', name: 'test', api: {} as any, capabilities: {} as any, cost: {} as any, limit: { context: 200000, output: 8192 }, status: 'active', options: {}, headers: {} } },
        output,
      )

      expect(output.system.length).toBeGreaterThan(0)
      expect(output.system[0]).toContain('[treecontext working memory continuation]')
    })

    it('does not inject when no rehydration needed', async () => {
      // Set sessionId but don't trigger needsRehydration
      await hooks.event!({
        event: {
          type: 'message.updated',
          properties: {
            info: { id: 'm1', sessionID: 'sess-1', role: 'assistant', time: { created: Date.now() }, parentID: 'p', modelID: 'm', providerID: 'p', mode: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
          },
        },
      })

      const output = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']!(
        { sessionID: 'sess-1', model: {} as any },
        output,
      )

      expect(output.system).toHaveLength(0)
    })
  })

  describe('Layer 3: round-trip', () => {
    it('compacting → system.transform rehydration cycle', async () => {
      // Seed staging
      const db = new Database(tempDbPath)
      db.prepare(
        `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
         VALUES (?, 'user', ?, ?, 1, 0, ?)`
      ).run('sess-1', 'The secret word is bamboozle', Date.now() / 1000, Date.now() / 1000)
      db.close()

      // Step 1: compaction fires
      const compactOutput: { context: string[]; prompt?: string } = { context: [] }
      await hooks['experimental.session.compacting']!(
        { sessionID: 'sess-1' },
        compactOutput,
      )
      expect(compactOutput.context.length).toBeGreaterThan(0)

      // Step 2: session.compacted event
      await hooks.event!({
        event: { type: 'session.compacted', properties: { sessionID: 'sess-1' } },
      })

      // Step 3: system.transform injects rehydration
      const systemOutput = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']!(
        { sessionID: 'sess-1', model: {} as any },
        systemOutput,
      )

      expect(systemOutput.system.length).toBeGreaterThan(0)
      expect(systemOutput.system[0]).toContain('[treecontext working memory continuation]')

      // Step 4: second call should NOT reinject (needsRehydration cleared)
      const systemOutput2 = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']!(
        { sessionID: 'sess-1', model: {} as any },
        systemOutput2,
      )
      expect(systemOutput2.system).toHaveLength(0)
    })
  })
})
