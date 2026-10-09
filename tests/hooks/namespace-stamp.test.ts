/**
 * C1 hook-side namespace stamp (tests/server/design/multi-user.md §C1).
 *
 * writeStaging stamps the namespace of the session it belongs to,
 * resolved through the server's pid annotation via the hook's own ppid.
 * Two honesty properties pinned here:
 *  - unresolved is NULL, never a guess — the drain applies the 'project'
 *    default visibly at drain time;
 *  - JF-8 (hooks never run migrations): on a pre-020 store the stamp is
 *    dropped and the row still lands — semantically identical to an
 *    unresolved stamp.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import Database from 'better-sqlite3'
import { writeStaging } from '../../src/hooks/shared.js'
import { writeNamespaceAnnotation } from '../../src/session-beacon.js'
import { NS_LEASE_TTL_SECS } from '../../src/persistence/leases.js'

const STAGING_20 = `
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
    attempts INTEGER NOT NULL DEFAULT 0,
    namespace TEXT
  )
`

const LEASES = `
  CREATE TABLE leases (
    role TEXT PRIMARY KEY,
    holder_pid INTEGER NOT NULL,
    holder_host TEXT NOT NULL,
    holder_token TEXT NOT NULL DEFAULT '',
    holder_label TEXT,
    acquired_at REAL NOT NULL,
    heartbeat_at REAL NOT NULL,
    ttl_secs REAL NOT NULL
  )
`

describe('writeStaging namespace stamp (C1)', () => {
  let tempDir: string

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tc-ns-stamp-')) })
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

  function makeDb(path: string, schema: string): void {
    const db = new Database(path)
    db.exec(schema)
    db.close()
  }

  /** Stand in for a serving process: hold `ns:<namespace>` with a
   *  heartbeat `ageSecs` old (default fresh). */
  function holdNsLease(path: string, namespace: string, pid: number, ageSecs = 0): void {
    const db = new Database(path)
    try {
      db.prepare(
        'INSERT OR REPLACE INTO leases (role, holder_pid, holder_host, holder_token, holder_label, acquired_at, heartbeat_at, ttl_secs) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(`ns:${namespace}`, pid, hostname(), 'tok', null, Date.now() / 1000, Date.now() / 1000 - ageSecs, NS_LEASE_TTL_SECS)
    } finally {
      db.close()
    }
  }

  function readRow(path: string): Record<string, unknown> {
    const db = new Database(path)
    try {
      return db.prepare('SELECT * FROM staging').get() as Record<string, unknown>
    } finally {
      db.close()
    }
  }

  it('an explicit stamp lands in the namespace column', () => {
    const dbPath = join(tempDir, 'explicit.db')
    makeDb(dbPath, STAGING_20)
    writeStaging(dbPath, {
      sessionId: 's', role: 'user', content: 'stamped', timestamp: 1, priority: 1,
      namespace: 'agent-a',
    })
    expect(readRow(dbPath)['namespace']).toBe('agent-a')
  })

  it('without an explicit stamp, the hook resolves its session\'s namespace via its own ppid annotation', () => {
    const dbPath = join(tempDir, 'resolved.db')
    makeDb(dbPath, `${STAGING_20};${LEASES}`)
    // The test process stands in for claude (the calling hook's ppid) and
    // for the server — which since the 2026-08-16 ruling means holding
    // the namespace lease, not merely owning a live pid.
    writeNamespaceAnnotation(dbPath, process.ppid, 'agent-resolved')
    holdNsLease(dbPath, 'agent-resolved', process.pid)
    writeStaging(dbPath, { sessionId: 's', role: 'user', content: 'resolved', timestamp: 1, priority: 1 })
    expect(readRow(dbPath)['namespace']).toBe('agent-resolved')
  })

  it('an annotation whose server no longer holds the lease does not stamp', () => {
    const dbPath = join(tempDir, 'expired.db')
    makeDb(dbPath, `${STAGING_20};${LEASES}`)
    writeNamespaceAnnotation(dbPath, process.ppid, 'agent-resolved')
    holdNsLease(dbPath, 'agent-resolved', process.pid, NS_LEASE_TTL_SECS + 1)
    writeStaging(dbPath, { sessionId: 's', role: 'user', content: 'expired', timestamp: 1, priority: 1 })
    expect(readRow(dbPath)['namespace']).toBeNull()
  })

  it('a store with no leases table stamps nothing rather than throwing — pre-021 stores still capture', () => {
    const dbPath = join(tempDir, 'nolease.db')
    makeDb(dbPath, STAGING_20)
    writeNamespaceAnnotation(dbPath, process.ppid, 'agent-resolved')
    writeStaging(dbPath, { sessionId: 's', role: 'user', content: 'nolease', timestamp: 1, priority: 1 })
    const row = readRow(dbPath)
    expect(row['content']).toBe('nolease')
    expect(row['namespace']).toBeNull()
  })

  it('unresolved stays NULL — never a guess', () => {
    const dbPath = join(tempDir, 'unresolved.db')
    makeDb(dbPath, STAGING_20)
    writeStaging(dbPath, { sessionId: 's', role: 'user', content: 'unresolved', timestamp: 1, priority: 1 })
    expect(readRow(dbPath)['namespace']).toBeNull()
  })

  it('pre-020 fallback: the stamp is dropped and the row still lands (JF-8)', () => {
    const dbPath = join(tempDir, 'pre020.db')
    makeDb(dbPath, STAGING_20.replace(/,\n    namespace TEXT/, ''))
    writeStaging(dbPath, {
      sessionId: 's', role: 'user', content: 'pre-020 capture', timestamp: 1, priority: 1,
      namespace: 'agent-a',
    })
    const row = readRow(dbPath)
    expect(row['content']).toBe('pre-020 capture')
    expect('namespace' in row).toBe(false)
  })
})
