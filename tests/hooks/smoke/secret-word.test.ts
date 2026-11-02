import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import os from 'os'
import * as shared from '../../../src/hooks/shared.js'
import { main as preCompactMain } from '../../../src/hooks/pre-compact.js'
import { main as sessionStartMain } from '../../../src/hooks/session-start.js'
import { openNodeSqlite } from '../../../src/persistence/node-sqlite.js'
import { runMigrations } from '../../../src/persistence/migrations.js'

describe('Secret word smoke test (round-trip)', () => {
  let tempDbPath: string
  let tempDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'))
    tempDbPath = path.join(tempDir, 'treecontext.db')

    // The store's schema as the server creates it (the session registry
    // included: the snapshot claim reads each session's lane from it, D375).
    const db = openNodeSqlite(new DatabaseSync(tempDbPath))
    runMigrations(db, { migrate: true })
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
    const db = new DatabaseSync(tempDbPath)
    db.prepare(
      `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
       VALUES (?, 'user', ?, ?, 1, 0, ?)`
    ).run('sess-origin', 'The secret word is bamboozle', Date.now() / 1000, Date.now() / 1000)
    db.close()

    // Step 0: the original session started in this checkout, which
    // registers its self (D375: a snapshot is claimed only from the
    // claimant's own lane, read from the registry).
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-origin', cwd: '/tmp', source: 'startup',
    })
    sessionStartMain()
    stdoutSpy.mockClear()

    // Step 1: PreCompact fires in the original session (silent — no stdout)
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-origin', cwd: '/tmp',
    })
    preCompactMain()

    expect(stdoutSpy).not.toHaveBeenCalled()

    // Verify snapshot was written to DB
    const checkDb = new DatabaseSync(tempDbPath)
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
      const db = new DatabaseSync(tempDbPath)
      db.prepare(
        `INSERT INTO staging (session_id, role, content, timestamp, priority, processed, created_at)
         VALUES (?, 'user', ?, ?, 1, 0, ?)`
      ).run('sess-1', 'The secret word is bamboozle', Date.now() / 1000, Date.now() / 1000)

      let prior = 0
      if (source === 'startup') {
        prior = Number(db.prepare('INSERT INTO snapshots (session_id, queries) VALUES (?, ?)')
          .run('sess-prior', JSON.stringify(['what was I doing'])).lastInsertRowid)
      }
      db.close()
      if (source === 'startup') {
        // The prior session started in this checkout through the real
        // hook, which registers its self, so the startup's claim reaches
        // its snapshot (D375: claimed only from the claimant's own lane).
        vi.spyOn(shared, 'parseHookInput').mockReturnValue({
          session_id: 'sess-prior', cwd: '/tmp', source: 'startup',
        })
        sessionStartMain()
        stdoutSpy.mockClear()
      }

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
      if (source === 'startup') {
        // The startup claimed the prior session's snapshot: its line in the
        // packet, the snapshot marked claimed, and the claim staged.
        const context = output.hookSpecificOutput.additionalContext as string
        expect(context).toContain(`[Prior session snapshot #${prior} from session sess-prior]`)
        expect(context).toContain('Recovery queries: what was I doing')
        const check = new DatabaseSync(tempDbPath)
        try {
          expect(check.prepare('SELECT claimed_by AS c FROM snapshots WHERE id = ?').get(prior)).toEqual({ c: 'sess-1' })
          const staged = check.prepare("SELECT session_id AS s, content AS c FROM staging WHERE role = 'snapshot'").all() as Array<{ s: string; c: string }>
          expect(staged.map((r) => [r.s, JSON.parse(r.c)])).toEqual([['sess-1', { queries: ['what was I doing'], original_session_id: 'sess-prior', snapshot_id: prior }]])
        } finally { check.close() }
      }
    })
  }

  it('20 sequential pre-compact → session-start cycles do not leak snapshots', () => {
    // The first session started in this checkout before it compacted
    // (D375: the claim reads each session's lane from the registry).
    vi.spyOn(shared, 'parseHookInput').mockReturnValue({
      session_id: 'sess-0', cwd: '/tmp', source: 'startup',
    })
    sessionStartMain()
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

    const db = new DatabaseSync(tempDbPath)
    const unclaimed = db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE claimed_by IS NULL').get() as any
    const total = db.prepare('SELECT COUNT(*) as c FROM snapshots').get() as any
    db.close()

    expect(total.c).toBe(20)
    // The last snapshot won't be claimed (no session after sess-20 to claim it)
    expect(unclaimed.c).toBeLessThanOrEqual(1)
  })
})
