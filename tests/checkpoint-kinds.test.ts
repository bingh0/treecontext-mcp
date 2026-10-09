/**
 * Bookmark supersession at the store (D166, D216): a bookmark the server
 * could not attribute to a session still supersedes the lane's previous
 * unattributed bookmark, so a failed attribution never grows the panel.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { FlatStore } from '../src/flat-store.js'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

it('an unattributed bookmark supersedes the previous unattributed one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-kinds-'))
  dirs.push(dir)
  const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'j.db'))), ownsDatabase: true })
  try {
    const a = await store.insert('at: first, no session', { metadata: { kind: 'bookmark' } })
    const b = await store.insert('at: second, no session', { metadata: { kind: 'bookmark' } })
    // An attributed bookmark is another session's, and is left alone.
    const c = await store.insert('at: someone else', { metadata: { kind: 'bookmark', _cc_session_id: 'cc-other' } })
    const live = store.status().resumePointers.filter((p) => p.kind === 'bookmark').map((p) => p.nodeId)
    expect(live.sort()).toEqual([b.nodeId, c.nodeId].sort())
    expect(b.superseded).toEqual([a.nodeId])
  } finally {
    await store.close()
  }
})
