import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../../src/hooks/shared.js'
import { main as preCompactMain } from '../../../src/hooks/pre-compact.js'
import { main as sessionStartMain } from '../../../src/hooks/session-start.js'

describe('Secret word smoke test (round-trip)', () => {
  let tempDbPath: string
  let tempDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    const db = new Database(tempDbPath)
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
    db.close()

    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(tempDbPath)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('round-trip: pre-compact writes snapshot, session-start reads it', () => {
    // Seed staging with the secret word
    const db = new Database(tempDbPath)
    db.prepare(
      `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
       VALUES (?, 'user', ?, ?, 1, 0, ?)`
    ).run('sess-origin', 'The secret word is bamboozle', Date.now() / 1000, Date.now() / 1000)
    db.close()

    // Step 1: PreCompact fires in the original session (silent — no stdout)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-origin', cwd: '/tmp',
    })
    preCompactMain()

    expect(stdoutSpy).not.toHaveBeenCalled()

    // Verify snapshot was written to DB
    const checkDb = new Database(tempDbPath)
    const snap = checkDb.prepare('SELECT * FROM snapshots WHERE session_id = ?').get('sess-origin') as any
    checkDb.close()
    expect(snap).toBeDefined()
    expect(JSON.parse(snap.queries)).toHaveLength(3)

    // Step 2: SessionStart fires in a new session (source=startup claims cross-session snapshot)
    stdoutSpy.mockClear()
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-new', cwd: '/tmp', source: 'startup',
    })
    sessionStartMain()

    const sessionOutput = JSON.parse(stdoutSpy.mock.calls[0]![0] as string)
    const context = sessionOutput.hookSpecificOutput.additionalContext
    expect(context).toContain('sess-origin')
  })

  const sources = ['startup', 'clear', 'compact', 'resume'] as const

  for (const source of sources) {
    it(`source=${source} produces valid JSON with additionalContext`, () => {
      const db = new Database(tempDbPath)
      db.prepare(
        `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
         VALUES (?, 'user', ?, ?, 1, 0, ?)`
      ).run('sess-1', 'The secret word is bamboozle', Date.now() / 1000, Date.now() / 1000)

      if (source === 'startup') {
        db.prepare('INSERT INTO snapshots (session_id, queries) VALUES (?, ?)')
          .run('sess-prior', JSON.stringify(['what was I doing']))
      }
      db.close()

      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-1', cwd: '/tmp', source,
      })

      sessionStartMain()

      expect(stdoutSpy).toHaveBeenCalled()
      const raw = stdoutSpy.mock.calls[0]![0] as string
      const output = JSON.parse(raw)

      expect(output.hookSpecificOutput).toBeDefined()
      expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
      expect(typeof output.hookSpecificOutput.additionalContext).toBe('string')
      expect(output.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0)
    })
  }

  it('20 sequential pre-compact → session-start cycles do not leak snapshots', () => {
    for (let i = 0; i < 20; i++) {
      stdoutSpy.mockClear()

      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: `sess-${i}`, cwd: '/tmp',
      })
      preCompactMain()

      stdoutSpy.mockClear()
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: `sess-${i + 1}`, cwd: '/tmp', source: 'startup',
      })
      sessionStartMain()
    }

    const db = new Database(tempDbPath)
    const unclaimed = db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE claimed_by IS NULL').get() as any
    const total = db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as any
    db.close()

    expect(total.c).toBe(20)
    // The last snapshot won't be claimed (no session after sess-20 to claim it)
    expect(unclaimed.c).toBeLessThanOrEqual(1)
  })
})
