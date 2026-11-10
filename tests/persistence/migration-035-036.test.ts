/**
 * Migrations 035 (D403) and 036 (D404). 035: a worker registration gains the
 * numbering of processes its first process's id belongs to (`proc_ns`);
 * 036: a staged tool call gains the client whose own event stated it
 * succeeded (`stated_by`). Both additive: a store at 034 with a registration
 * and a staged row climbs behind its backup, every row intact with NULLs (a
 * registration an earlier build wrote reads as recording no numbering, a
 * staged row as stating nothing), and each migration is safe to run again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite, setPragma } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import { WORKER_AGENT_ID, legOf } from '../../src/persistence/leg-registry.js'
import m035 from '../../src/persistence/migrations/035_worker_pid_namespace.js'
import m036 from '../../src/persistence/migrations/036_staging_stated_by.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const cols = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

describe('migrations 035 and 036: the numbering of a worker\'s process, and a stated success', () => {
  it('a store at 034 climbs to 036 behind its backup, its registration and staged rows intact with NULLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m035-'))
    dirs.push(dir)
    const path = join(dir, 'treecontext.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
    await s.insert('a journal row', { metadata: {} })
    await s.registerWorker({
      sessionId: 'w1', door: 'library',
      ticket: { parent: { id: 'p1' }, run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder' },
      process: { pid: 4242, start: 1000, host: 'laptop' },
    })
    s.store.insertStaging({ sessionId: 'cc-1', role: 'assistant', content: 'Tool: Bash', toolName: 'Bash', timestamp: 1, toolUseId: 'toolu_1' })
    await s.close()
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE session_registry DROP COLUMN proc_ns; ALTER TABLE staging DROP COLUMN stated_by')
    setPragma(db, 'user_version = 34')
    const registryBefore = db.prepare('SELECT session_id, agent_id, pid, proc_start, processes FROM session_registry').all()
    const stagingBefore = db.prepare('SELECT id, session_id, content, tool_use_id, outcome, captured_from FROM staging').all()
    try {
      const report = runMigrations(openNodeSqlite(db), { migrate: true })
      expect(report.applied.map((a) => [a.version, a.kind])).toEqual([[35, 'additive'], [36, 'additive']])
      expect(cols(db, 'session_registry')).toContain('proc_ns')
      expect(cols(db, 'staging')).toContain('stated_by')
      expect(db.prepare('SELECT session_id, agent_id, pid, proc_start, processes FROM session_registry').all()).toEqual(registryBefore)
      expect(db.prepare('SELECT id, session_id, content, tool_use_id, outcome, captured_from FROM staging').all()).toEqual(stagingBefore)
      expect(db.prepare('SELECT proc_ns FROM session_registry').all()).toEqual([{ proc_ns: null }])
      expect(db.prepare('SELECT stated_by FROM staging').all()).toEqual([{ stated_by: null }])
      // The registration reads as an earlier build's: no numbering.
      expect(legOf(openNodeSqlite(db) as never, { sessionId: 'w1', agentId: WORKER_AGENT_ID })!.procNs).toBeNull()
      // Safe to run again.
      m035.up(openNodeSqlite(db))
      m036.up(openNodeSqlite(db))
    } finally { db.close() }
    expect(existsSync(`${path}.pre-migration-v34.bak`)).toBe(true)
  })

  it('a registration from this build records its numbering on the column and on each process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m035-'))
    dirs.push(dir)
    const path = join(dir, 'treecontext.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
    const leg = await s.registerWorker({
      sessionId: 'w2', door: 'library',
      ticket: { parent: { id: 'p1' }, run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder' },
      process: { pid: 13, start: 1000, host: 'laptop', ns: 'pid:[4026533181]' },
    })
    s.recordWorkerRerun({ sessionId: 'w2', agentId: WORKER_AGENT_ID }, { pid: 14, start: 2000, host: 'laptop', ns: 'pid:[4026533999]', at: 3 })
    await s.close()
    expect(leg.procNs).toBe('pid:[4026533181]')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const r = db.prepare('SELECT proc_ns, processes FROM session_registry WHERE session_id = ?').get('w2') as { proc_ns: string; processes: string }
      expect(r.proc_ns).toBe('pid:[4026533181]')
      expect((JSON.parse(r.processes) as Array<{ ns: string }>).map((p) => p.ns)).toEqual(['pid:[4026533181]', 'pid:[4026533999]'])
    } finally { db.close() }
  })
})
