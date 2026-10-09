import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../src/hooks/shared.js'
import { main as postToolUseMain } from '../../src/hooks/post-tool-use.js'
import { main as userPromptSubmitMain } from '../../src/hooks/user-prompt-submit.js'
import { readSessionBeacon, writeSessionBeacon } from '../../src/session-beacon.js'

describe('Hooks tests', () => {
  let tempDbPath: string
  let tempDir: string
  let mockExit: any
  let mockConsoleError: any

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    const db = new Database(tempDbPath)
    db.exec(`
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
    `)
    db.close()

    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(tempDbPath)
  })

  afterEach(() => {
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)
      if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal')
      if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm')
      fs.rmdirSync(tempDir)
    } catch (e) { }
    vi.restoreAllMocks()
  })

  it('resolveDbPath returns a valid path string', () => {
    vi.spyOn(shared, 'resolveDbPath').mockRestore()
    const dbPath = shared.resolveDbPath('/fake/cwd')
    expect(typeof dbPath).toBe('string')
    expect(dbPath.endsWith('treecontext.db')).toBe(true)
  })

  it('writeStaging writes a row to a Temp SQLite database', () => {
    shared.writeStaging(tempDbPath, {
      role: 'user',
      content: 'test message',
      timestamp: 1000,
      priority: 1
    })

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get() as any
    db.close()

    expect(row).toBeDefined()
    expect(row.role).toBe('user')
    expect(row.content).toBe('test message')
    expect(row.priority).toBe(1)
  })

  it('journals repo-reading tools as trail: invocation staged, output bounded, no tail (charter 2026-07-24)', () => {
    // Flipped from the old "filters out low-value tools" pin when the
    // skipTools drop fell to journal-capture's "no invocation is ever
    // filtered out". Output far past the preview cap: a trail tool keeps
    // the bounded preview and never stages a full-fidelity tail.
    const bigOutput = 'line of repo content at that moment\n'.repeat(200) + 'TAILMARKER'
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'Read', tool_input: '{"file_path":"/repo/a.ts"}', tool_output: bigOutput
    })

    postToolUseMain()

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get() as any
    db.close()

    expect(row).toBeDefined()
    expect(row.tool_name).toBe('Read')
    expect(row.content).toContain('Tool: Read')
    expect(row.content).toContain('/repo/a.ts')
    expect(row.content).not.toContain('TAILMARKER')
    expect(row.content).not.toContain('--- FULL ---')
    expect(row.index_len).toBeNull()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('writes Edit tool with priority 1', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'Edit', tool_input: '{"file":"a.txt"}', tool_output: 'done'
    })

    postToolUseMain()

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get() as any
    db.close()

    expect(row).toBeDefined()
    expect(row.tool_name).toBe('Edit')
    expect(row.priority).toBe(1)
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('priority assignment: Bash -> 2, random -> 3', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'Bash', tool_input: 'ls', tool_output: 'ok'
    })
    postToolUseMain()

    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'mcp__treecontext__treecontext_query', tool_input: '', tool_output: ''
    })
    postToolUseMain()

    const db = new Database(tempDbPath)
    const rows = db.prepare('SELECT * FROM staging ORDER BY id ASC').all() as any[]
    db.close()

    expect(rows.length).toBe(2)
    expect(rows[0].tool_name).toBe('Bash')
    expect(rows[0].priority).toBe(2)

    expect(rows[1].tool_name).toBe('mcp__treecontext__treecontext_query')
    expect(rows[1].priority).toBe(3)
  })

  it('long output stages preview + full tail with index_len at the boundary (C4)', () => {
    const longOutput = 'A'.repeat(5000)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'short', tool_output: longOutput
    })

    postToolUseMain()

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get() as any
    db.close()

    expect(row.content).toContain('short')
    // Preview (the index view) is bounded and marked truncated...
    expect(row.index_len).toBeGreaterThan(0)
    expect(row.index_len).toBeLessThan(2000)
    const preview = row.content.slice(0, row.index_len)
    expect(preview).toContain('...')
    expect(preview).not.toContain('A'.repeat(1001))
    // ...while the staged content carries the full output after the boundary.
    expect(row.content.slice(row.index_len)).toContain('A'.repeat(5000))
  })

  it('short output stages preview only, no tail, NULL index_len (JF-3)', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'test', cwd: '/tmp', tool_name: 'TestTool', tool_input: 'short', tool_output: 'brief output'
    })

    postToolUseMain()

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM staging').get() as any
    db.close()

    expect(row.content).toContain('brief output')
    expect(row.content).not.toContain('--- FULL ---')
    expect(row.index_len).toBeNull()
  })

  it('errors do not throw, exit 0', () => {
    vi.spyOn(shared, 'parseHookInput').mockImplementation(() => { throw new Error('parse error') })

    expect(() => userPromptSubmitMain()).not.toThrow()
    expect(mockConsoleError).toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  // Session-identity fix (docs/session-identity.md §3):
  // UserPromptSubmit refreshes last_seen on the same pid-keyed beacon
  // SessionStart wrote, without touching cc_session_id/started_at.
  describe('PID beacon refresh (Fix 1 §3)', () => {
    it('refreshes last_seen on the existing beacon without changing cc_session_id/started_at', async () => {
      writeSessionBeacon(tempDbPath, process.ppid, 'sess-from-session-start', '/proj', { rewrite: true })
      const before = readSessionBeacon(tempDbPath, process.ppid)!

      await new Promise((r) => setTimeout(r, 20))
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-from-session-start', cwd: '/proj', prompt: 'hello',
      })
      userPromptSubmitMain()

      const after = readSessionBeacon(tempDbPath, process.ppid)!
      expect(after.cc_session_id).toBe(before.cc_session_id)
      expect(after.started_at).toBe(before.started_at)
      expect(after.last_seen).toBeGreaterThan(before.last_seen)
    })

    it('creates a beacon defensively when SessionStart never ran for this pid', () => {
      expect(readSessionBeacon(tempDbPath, process.ppid)).toBeNull()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-defensive', cwd: '/proj', prompt: 'hello',
      })
      userPromptSubmitMain()
      expect(readSessionBeacon(tempDbPath, process.ppid)!.cc_session_id).toBe('sess-defensive')
    })
  })
})
