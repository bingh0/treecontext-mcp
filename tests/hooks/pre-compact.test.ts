import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import * as shared from '../../src/hooks/shared.js'
import { main } from '../../src/hooks/pre-compact.js'

describe('PreCompact hook (Layer 3)', () => {
  let tempDbPath: string
  let tempDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let mockExit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompact-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    const db = new Database(tempDbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        queries TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at REAL,
        created_at REAL NOT NULL DEFAULT (unixepoch('subsec'))
      )
    `)
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

  it('does not emit stdout (silent checkpoint)', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp',
    })

    main()

    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('writes a snapshot row to the database', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp',
    })

    main()

    const db = new Database(tempDbPath)
    const row = db.prepare('SELECT * FROM snapshots').get() as any
    db.close()

    expect(row).toBeDefined()
    expect(row.session_id).toBe('sess-1')
    expect(JSON.parse(row.queries)).toHaveLength(3)
  })

  it('is idempotent: two calls produce two snapshot rows', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp',
    })

    main()
    main()

    const db = new Database(tempDbPath)
    const rows = db.prepare('SELECT * FROM snapshots').all()
    db.close()

    expect(rows).toHaveLength(2)
  })

  it('exits 0 when session_id is missing', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({ cwd: '/tmp' })

    main()

    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('exits 0 on DB error', () => {
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-1', cwd: '/tmp',
    })
    vi.spyOn(shared, 'resolveDbPath').mockReturnValue('/nonexistent/path/treecontext.db')

    expect(() => main()).not.toThrow()
    expect(mockExit).toHaveBeenCalledWith(0)
  })
})
