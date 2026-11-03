/**
 * The archive writer makes the file's directory entry durable, not only the
 * file (D55: "archived whole and fsynced before any row moves"). A crash
 * after the file's fsync but before the directory's could lose the entry
 * while the rows it archives are deleted next.
 *
 * The order is read off the real fsyncs: fs.fsyncSync is spied, each call is
 * classified by fstat (file or directory), and at each one the store is read
 * through a separate handle.
 */
import { describe, it, expect } from 'vitest'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'

const T0 = 1_700_000_000
const auto = (session: string) => ({ source: 'auto-capture', role: 'tool', session_id: session })

// The order is read off /proc/self/fd, which only Linux has: elsewhere a
// file's fsync cannot be told from the store's own, so the test runs on Linux.
describe.skipIf(process.platform !== 'linux')('archive writer fsyncs the archive directory', () => {
  it.skipIf(process.platform === 'win32')('file, then its directory, both before the first row moves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-archdir-'))
    const dbPath = join(dir, 'a.db')
    const archiveDir = join(dir, 'archive')
    const store = await FlatStore.open({
      database: openNodeSqlite(new DatabaseSync(dbPath)), ownsDatabase: true,
      retentionInterval: 1_000_000, maxSessions: 1, archiveDir,
    })
    const realFsync = fs.fsyncSync
    const events: Array<{ kind: 'file' | 'dir'; liveRows: number; tombstones: number; path: string | null }> = []
    try {
      await store.insert('evictable row', { metadata: auto('old'), createdAt: T0 })
      await store.insert('protected row', { metadata: auto('new'), createdAt: T0 + 100 })
      fs.fsyncSync = ((fd: number) => {
        const isDir = fs.fstatSync(fd).isDirectory()
        let path: string | null = null
        try { path = fs.readlinkSync(`/proc/self/fd/${fd}`) } catch { /* not Linux */ }
        // only the archive's own fsyncs: the store's database files are synced by SQLite itself
        if (isDir || (path !== null && path.startsWith(archiveDir))) {
          const reader = new DatabaseSync(dbPath, { readOnly: true })
          try {
            const n = (sql: string): number => Number((reader.prepare(sql).get() as { n: number }).n)
            events.push({
              kind: isDir ? 'dir' : 'file', path,
              liveRows: n("SELECT COUNT(*) AS n FROM nodes WHERE COALESCE(json_extract(metadata_json,'$._tombstone'), 0) != 1"),
              tombstones: n("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1"),
            })
          } finally { reader.close() }
        }
        return realFsync(fd)
      }) as typeof fs.fsyncSync
      syncBuiltinESMExports()
      store.retentionSweep()
    } finally {
      fs.fsyncSync = realFsync
      syncBuiltinESMExports()
    }
    try {
      expect(events.map((e) => e.kind), 'the archive file, then its directory').toEqual(['file', 'dir'])
      // at the directory's fsync the evictable row has not moved and no tombstone stands yet
      expect(events[1]).toMatchObject({ liveRows: 2, tombstones: 0 })
      expect(events[1]!.path === null || events[1]!.path === archiveDir).toBe(true)
      // and the sweep then completed: the tombstone stands, the row is gone
      const reader = new DatabaseSync(dbPath, { readOnly: true })
      try {
        expect(Number((reader.prepare("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1").get() as { n: number }).n)).toBe(1)
      } finally { reader.close() }
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
