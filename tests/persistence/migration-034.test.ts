/**
 * Migration 034 (D400, D401): staging gains the client's id for a tool
 * call, its outcome and where it was captured from, and the index the
 * PostToolBatch hook's lookup reads. Additive: a store at 033 with staged
 * rows climbs behind its backup, every row intact with NULLs, and the
 * migration is safe to run again.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite, setPragma } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { runMigrations } from '../../src/persistence/migrations.js'
import m034, { STAGING_TOOL_USE_INDEX_DDL } from '../../src/persistence/migrations/034_staging_tool_call.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const cols = (db: DatabaseSync): string[] => (db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>).map((c) => c.name)

describe('migration 034: staging carries a tool call\'s id, outcome and source', () => {
  it('a store at 033 with staged rows climbs to 034 behind its backup, its rows intact, the lookup on the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m034-'))
    dirs.push(dir)
    const path = join(dir, 'treecontext.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path)), ownsDatabase: true })
    await s.insert('a journal row', { metadata: {} })
    s.store.insertStaging({ sessionId: 'cc-1', role: 'assistant', content: 'Tool: Bash', toolName: 'Bash', timestamp: 1 })
    await s.close()
    const db = new DatabaseSync(path)
    db.exec('DROP INDEX idx_staging_tool_use; ALTER TABLE staging DROP COLUMN tool_use_id; ALTER TABLE staging DROP COLUMN outcome; ALTER TABLE staging DROP COLUMN captured_from')
    setPragma(db, 'user_version = 33')
    const before = db.prepare('SELECT id, session_id, role, content, tool_name, timestamp FROM staging').all()
    try {
      const report = runMigrations(openNodeSqlite(db), { migrate: true })
      expect(report.applied.map((a) => [a.version, a.kind])).toEqual([[34, 'additive'], [35, 'additive'], [36, 'additive'], [37, 'additive']])
      expect(cols(db)).toEqual(expect.arrayContaining(['tool_use_id', 'outcome', 'captured_from']))
      expect(db.prepare('SELECT id, session_id, role, content, tool_name, timestamp FROM staging').all()).toEqual(before)
      expect(db.prepare('SELECT tool_use_id, outcome, captured_from FROM staging').all()).toEqual([{ tool_use_id: null, outcome: null, captured_from: null }])
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_staging_tool_use'").get() as { sql: string }).sql
      expect(sql).toBe(STAGING_TOOL_USE_INDEX_DDL.replace('IF NOT EXISTS ', ''))
      const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT tool_use_id FROM staging WHERE session_id = ? AND tool_use_id IN (?, ?)").all('cc-1', 'a', 'b') as Array<{ detail: string }>).map((r) => r.detail).join(' ')
      expect(plan).toMatch(/idx_staging_tool_use/)
      // Safe to run again (the replay guard every additive migration keeps).
      m034.up(openNodeSqlite(db))
    } finally { db.close() }
    expect(existsSync(`${path}.pre-migration-v33.bak`)).toBe(true)
  })
})
