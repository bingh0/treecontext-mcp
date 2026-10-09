import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../src/hooks/shared.js'
import { main } from '../../src/hooks/session-start.js'
import { readSessionBeacon } from '../../src/session-beacon.js'

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

describe('SessionStart hook (Layer 3)', () => {
  let tempDbPath: string
  let tempDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstart-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    const db = setupDb(tempDbPath)
    db.close()

    vi.spyOn(shared, 'resolveDbPath').mockReturnValue(tempDbPath)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
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

  it('emits hookSpecificOutput with additionalContext', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp', source: 'clear',
    })

    main()

    expect(stdoutSpy).toHaveBeenCalled()
    const output = JSON.parse(stdoutSpy.mock.calls[0]![0] as string)
    expect(output.hookSpecificOutput).toBeDefined()
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(typeof output.hookSpecificOutput.additionalContext).toBe('string')
  })

  describe('source-based budget enforcement', () => {
    const budgets: Record<string, number> = {
      startup: 5000,
      clear: 3000,
      compact: 2000,
      resume: 500,
    }

    for (const [source, budget] of Object.entries(budgets)) {
      it(`source=${source} stays within ${budget} chars`, () => {
        const db = new Database(tempDbPath)
        for (let i = 0; i < 50; i++) {
          db.prepare(
            `INSERT INTO staging (session_id, role, content, tool_name, timestamp, priority, processed, created_at)
             VALUES (?, 'user', ?, NULL, ?, 1, 0, ?)`
          ).run('sess-1', `Message ${i}: ${'x'.repeat(200)}`, Date.now() / 1000 - i, Date.now() / 1000)
        }
        db.close()

        vi.spyOn(shared, 'parseHookInput').mockReturnValue({
          session_id: 'sess-1', cwd: '/tmp', source,
        })

        main()

        const output = JSON.parse(stdoutSpy.mock.calls[0]![0] as string)
        const context = output.hookSpecificOutput.additionalContext
        expect(context.length).toBeLessThanOrEqual(budget + 60) // sentinel overhead
      })
    }
  })

  it('snapshot-claim only fires on startup', () => {
    const db = new Database(tempDbPath)
    db.prepare('INSERT INTO snapshots (session_id, queries) VALUES (?, ?)')
      .run('old-session', JSON.stringify(['what was I doing']))
    db.close()

    // clear source should NOT claim
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp', source: 'clear',
    })
    main()

    const db2 = new Database(tempDbPath)
    const unclaimed = db2.prepare('SELECT * FROM snapshots WHERE claimed_by IS NULL').get()
    db2.close()
    expect(unclaimed).toBeDefined()

    // startup source SHOULD claim
    stdoutSpy.mockClear()
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-2', cwd: '/tmp', source: 'startup',
    })
    main()

    const db3 = new Database(tempDbPath)
    const claimed = db3.prepare('SELECT * FROM snapshots WHERE claimed_by = ?').get('sess-2')
    db3.close()
    expect(claimed).toBeDefined()
  })

  it('handles unknown source gracefully (defaults to clear budget)', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp', source: 'some-new-value',
    })

    main()

    expect(stdoutSpy).toHaveBeenCalled()
    const output = JSON.parse(stdoutSpy.mock.calls[0]![0] as string)
    expect(output.hookSpecificOutput.additionalContext).toBeDefined()
  })

  it('handles missing source field', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp',
    })

    main()

    expect(stdoutSpy).toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('exits 0 when session_id is missing', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({ cwd: '/tmp' })

    main()

    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('writes snapshot claim to staging for journaling tree', () => {
    const db = new Database(tempDbPath)
    db.prepare('INSERT INTO snapshots (session_id, queries) VALUES (?, ?)')
      .run('old-session', JSON.stringify(['what was I doing']))
    db.close()

    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp', source: 'startup',
    })

    main()

    const db2 = new Database(tempDbPath)
    const stagingRow = db2.prepare(
      "SELECT * FROM staging WHERE role = 'snapshot'"
    ).get() as any
    db2.close()

    expect(stagingRow).toBeDefined()
    expect(stagingRow.session_id).toBe('sess-1')
    const content = JSON.parse(stagingRow.content)
    expect(content.original_session_id).toBe('old-session')
  })

  // Session-identity fix (docs/session-identity.md §3,
  // ladder rung 1 "pid"): the hook wrapper `exec`s into this process (see
  // installer.ts hookScriptContent), so process.ppid IS the claude PID in
  // production. The test process's own process.ppid stands in for it here.
  describe('PID beacon (Fix 1 §3)', () => {
    it('writes a beacon keyed by process.ppid with the session payload cc_session_id/cwd', () => {
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-beacon-1', cwd: '/proj', source: 'startup',
      })

      main()

      const beacon = readSessionBeacon(tempDbPath, process.ppid)
      expect(beacon).not.toBeNull()
      expect(beacon!.cc_session_id).toBe('sess-beacon-1')
      expect(beacon!.cwd).toBe('/proj')
    })

    it('resume: a second SessionStart for the same pid rewrites cc_session_id', () => {
      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-original', cwd: '/proj', source: 'startup',
      })
      main()
      expect(readSessionBeacon(tempDbPath, process.ppid)!.cc_session_id).toBe('sess-original')

      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-resumed', cwd: '/proj', source: 'resume',
      })
      main()
      expect(readSessionBeacon(tempDbPath, process.ppid)!.cc_session_id).toBe('sess-resumed')
    })

    it('a beacon write failure does not prevent the rehydration payload from being emitted', () => {
      // Block only the beacon's sessions/ dir (a plain file occupies the
      // path a directory needs to go) while leaving the staging DB at
      // tempDbPath fully valid — isolates the beacon write's own try/catch
      // (session-start.ts) from the unrelated DB-open path.
      const sessionsPath = path.join(path.dirname(tempDbPath), 'sessions')
      fs.writeFileSync(sessionsPath, 'x')

      vi.spyOn(shared, 'parseHookInput').mockReturnValue({
        session_id: 'sess-1', cwd: '/tmp', source: 'startup',
      })

      expect(() => main()).not.toThrow()
      expect(stdoutSpy).toHaveBeenCalled()
      const output = JSON.parse(stdoutSpy.mock.calls[0]![0] as string)
      expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
      expect(mockExit).toHaveBeenCalledWith(0)

      fs.unlinkSync(sessionsPath)
    })
  })
})
