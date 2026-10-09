import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'

let tmpDir: string
let db: Database

function createDb(): Database {
  const raw = new BetterSqlite3(join(tmpDir, `staging-${Date.now()}.db`))
  return wrapBetterSqlite(raw)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tc-staging-'))
  db = createDb()
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // ignore close races in cleanup
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('staging CRUD', () => {
  it('inserts, reads, and marks staging rows as processed', () => {
    const store = Persistence.openLexical(db)

    const firstId = store.insertStaging({
      sessionId: 'session-1',
      role: 'user',
      content: 'first event',
      timestamp: 10,
      priority: 2,
    })
    const secondId = store.insertStaging({
      sessionId: 'session-1',
      role: 'assistant',
      content: 'second event',
      toolName: 'treecontext_query',
      timestamp: 20,
      priority: 5,
    })

    // Through the LIVE drain path (claim → mark-owned → release): the
    // unclaimed read/mark pair left with its last caller (pass-2
    // cleanup ruling, 2026-08-15).
    const unprocessed = store.claimStagingBatch('probe', 10, 120)
    expect(unprocessed.map((row) => row.id)).toEqual([firstId, secondId])
    expect(unprocessed[0]!.processed).toBe(false)
    expect(unprocessed[1]!.toolName).toBe('treecontext_query')

    store.markStagingProcessedOwned([firstId], 'probe')
    store.releaseStagingClaims('probe')

    const remaining = store.claimStagingBatch('probe', 10, 120)
    expect(remaining.map((row) => row.id)).toEqual([secondId])

    const processed = store.database
      .prepare('SELECT processed FROM staging WHERE id = ?')
      .get(firstId) as { processed: number }
    expect(processed.processed).toBe(1)

    store.close()
  })

  it('enforces the staging role check constraint', () => {
    const store = Persistence.openLexical(db)

    expect(() =>
      store.database
        .prepare(
          'INSERT INTO staging (role, content, timestamp) VALUES (?, ?, ?)',
        )
        .run('invalid-role', 'bad event', 1),
    ).toThrow()

    store.close()
  })
})