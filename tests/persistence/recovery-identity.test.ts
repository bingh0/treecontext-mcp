/**
 * D375, U4-F1: the recovery row is written in the claiming session, and
 * identified by the claim (the snapshot and the claiming session), never by
 * its text. Driven through the hooks' own writers (the PreCompact snapshot,
 * the session-start claim and its staged row) and the real drain; the rows
 * are read back from SQLite directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { writeSnapshot, buildRehydrationPayload } from '../../src/hooks/shared.js'
import { registerSelf } from '../../src/persistence/session-registry.js'
import { RECOVERY_SNAPSHOT_SOURCE } from '../../src/persistence/recovery-snapshot.js'

let tmpDir: string
let dbPath: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tc-recovery-'))
  dbPath = join(tmpDir, 'store.db')
})
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

interface RecoveryRow { node_id: string; session_key: string | null; dedup_class: string; content: string; m: string }

function withRaw<T>(fn: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(dbPath)
  try { return fn(raw) } finally { raw.close() }
}
function recoveryRows(): RecoveryRow[] {
  return withRaw((db) => db.prepare(
    `SELECT node_id, session_key, dedup_class, content, metadata_json AS m FROM nodes
      WHERE json_extract(metadata_json, '$.source') = ? ORDER BY created_at, rowid`,
  ).all(RECOVERY_SNAPSHOT_SOURCE) as unknown as RecoveryRow[])
}
/** A session starting in a checkout, registered as the session-start hook
 *  registers it, and the claim its startup makes (the packet's line). */
function start(sessionId: string, worktree: string | null): string {
  return withRaw((db) => {
    registerSelf(db, sessionId, { worktree, branch: worktree ?? 'main', cwd: '/repo', toplevel: null, commonDir: null }, Date.now() / 1000)
    return buildRehydrationPayload(db, sessionId, 'startup', dbPath)
  })
}

describe('the recovery row is the claim\'s, never its text\'s (D375, U4-F1)', () => {
  it('two lanes whose recoveries read alike each keep their own row, in the claiming session', async () => {
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
    // Two empty worktrees compact, then a fresh session starts in each.
    start('one-1', 'emptyone')
    start('two-1', 'emptytwo')
    const one = writeSnapshot(dbPath, 'one-1', ['nothing matches this'])
    const two = writeSnapshot(dbPath, 'two-1', ['nothing matches this'])
    expect(start('one-2', 'emptyone')).toContain(`[Prior session snapshot #${one} from session one-1]`)
    expect(start('two-2', 'emptytwo')).toContain(`[Prior session snapshot #${two} from session two-1]`)
    await new IngestionLoop(s).ingestBatch()
    const rows = recoveryRows()
    expect(rows).toHaveLength(2)
    // The same text, two rows, each in its own claiming session.
    expect(rows[0]!.content).toBe(rows[1]!.content)
    expect(rows.map((r) => r.session_key)).toEqual(['one-2', 'two-2'])
    expect(rows.map((r) => JSON.parse(r.m) as Record<string, unknown>)).toMatchObject([
      { session_id: 'one-2', original_session_id: 'one-1', snapshot_id: one },
      { session_id: 'two-2', original_session_id: 'two-1', snapshot_id: two },
    ])
    // Outside the curated class, so the curated unique index never holds one.
    for (const r of rows) expect(r.dedup_class).not.toBe('curated')
    await s.close()
  })

  it('a lane compacting twice with nothing new between writes each claim\'s row in its own session', async () => {
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
    start('main-1', null)
    writeSnapshot(dbPath, 'main-1', ['nothing matches this'])
    start('main-2', null)
    await new IngestionLoop(s).ingestBatch()
    writeSnapshot(dbPath, 'main-2', ['nothing matches this'])
    start('main-3', null)
    await new IngestionLoop(s).ingestBatch()
    expect(recoveryRows().map((r) => r.session_key)).toEqual(['main-2', 'main-3'])
    await s.close()
  })

  it('a claim drained twice keeps one row', async () => {
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
    start('main-1', null)
    writeSnapshot(dbPath, 'main-1', ['nothing matches this'])
    start('main-2', null)
    // The drain wrote the row but died before it marked the staged row
    // processed: the same staged row comes round again.
    const staged = withRaw((db) => db.prepare("SELECT session_id AS s, content AS c, timestamp AS t FROM staging WHERE role = 'snapshot'").get() as { s: string; c: string; t: number })
    await new IngestionLoop(s).ingestBatch()
    s.store.insertStaging({ sessionId: staged.s, role: 'snapshot', content: staged.c, timestamp: staged.t })
    await new IngestionLoop(s).ingestBatch()
    expect(recoveryRows().map((r) => r.session_key)).toEqual(['main-2'])
    await s.close()
  })

  it('a claim staged before the claim carried its snapshot\'s id is identified by its staged row (U34 F8)', async () => {
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbPath)), retentionInterval: 1_000_000 })
    start('main-2', null)
    // The staged content an earlier release's session-start wrote: the
    // queries and the original session, no snapshot_id.
    const content = JSON.stringify({ queries: ['nothing matches this'], original_session_id: 'main-1' })
    const at = Date.now() / 1000
    s.store.insertStaging({ sessionId: 'main-2', role: 'snapshot', content, timestamp: at })
    const stagedId = withRaw((db) => (db.prepare("SELECT id FROM staging WHERE role = 'snapshot'").get() as { id: number }).id)
    await new IngestionLoop(s).ingestBatch()
    // The drain wrote the row and died before it marked the staged row
    // processed: the same staged row comes round again.
    withRaw((db) => db.prepare('UPDATE staging SET processed = 0 WHERE id = ?').run(stagedId))
    await new IngestionLoop(s).ingestBatch()
    const once = recoveryRows()
    expect(once).toHaveLength(1)
    const m = JSON.parse(once[0]!.m) as Record<string, unknown>
    expect(m).toMatchObject({ session_id: 'main-2', original_session_id: 'main-1', staging_id: stagedId })
    expect(m['snapshot_id']).toBeUndefined()
    expect(once[0]!.dedup_class).not.toBe('curated')
    // A second such claim, staged as its own row, reads alike and keeps its own row.
    s.store.insertStaging({ sessionId: 'main-2', role: 'snapshot', content, timestamp: at + 1 })
    await new IngestionLoop(s).ingestBatch()
    const rows = recoveryRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.content).toBe(rows[1]!.content)
    expect(rows.map((r) => (JSON.parse(r.m) as Record<string, unknown>)['staging_id'])).toEqual([stagedId, stagedId + 1])
    await s.close()
  })
})
