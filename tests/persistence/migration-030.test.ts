/**
 * Migration 030 (D286): every recovery-snapshot row an earlier treecontext
 * left without boundaries gets the display and index boundaries the drain
 * now stamps; its stored content is untouched; a row already at its
 * boundaries and every other row are left alone. Seeded in the shape
 * beta.2 left them, the store rewound to schema 29, opened by this build,
 * and read straight from SQLite.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmTree } from '../helpers/fs.js'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { RECOVERY_SNAPSHOT_SOURCE, RECOVERY_PREVIEW_LEN, RECOVERY_INDEX_LEN } from '../../src/persistence/recovery-snapshot.js'

type Raw = { node_id: string; metadata_json: string; content: Buffer | string; index_len: number | null; preview_len: number | null }

describe('migration 030 (D286)', () => {
  it('bounds the beta.2-shaped recovery rows, keeps their words, and leaves everything else alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m030-'))
    try {
      const path = join(dir, 's.db')
      const open = (): Promise<FlatStore> => FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true })
      const store = await open()
      const ids: Record<string, string> = {}
      const put = async (name: string, text: string, metadata: Record<string, unknown>): Promise<void> => {
        ids[name] = (await store.insert(text, { metadata })).nodeId
      }
      const far = 'fartoken030'
      const quoted = `${'the plan and its next step, quoted whole. '.repeat(400)}closing ${far}`
      // The row the migration exists for: beta.2's recovery snapshot, far
      // past both boundaries, nothing stamped.
      await put('bloated', `# Recovery Query: current active plan and next steps\n\n## \n${quoted}\n\n## \n${quoted}\n\n`, { source: RECOVERY_SNAPSHOT_SOURCE, original_session_id: 's1', recovered_at: 1 })
      // A short one: shorter than either boundary, so the stamps equal its length.
      await put('short', '# Recovery Query: recent decisions\n\n## \na short quote\n\n', { source: RECOVERY_SNAPSHOT_SOURCE, original_session_id: 's2', recovered_at: 2 })
      // A row already at its boundaries (this build wrote it): untouched.
      const already = `# Recovery 1 of 1\n\n## entry x\n${'quoted at the cap. '.repeat(600)}`
      await put('already', already, { source: RECOVERY_SNAPSHOT_SOURCE, original_session_id: 's3', recovered_at: 3, _index_len: Math.min(RECOVERY_INDEX_LEN, already.length), _preview_len: Math.min(RECOVERY_PREVIEW_LEN, already.length) })
      // Not recovery rows: a curated note and a tool event with its own boundary.
      await put('note', `a curated note that also says ${far}`, { type: 'note' })
      await put('tool', `Tool: Bash\n${'output line\n'.repeat(500)}`, { source: 'auto-capture', role: 'tool', session_id: 's', _index_len: 1000 })
      await store.close()

      const raw = new BetterSqlite3(path)
      const read = (): Record<string, Raw> => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k,
        raw.prepare('SELECT node_id, metadata_json, content, index_len, preview_len FROM nodes WHERE node_id = ?').get(id) as Raw]))
      const fts = (term: string): string[] => (raw.prepare(
        'SELECT n.node_id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?',
      ).all(`"${term}"`) as Array<{ node_id: string }>).map((r) => r.node_id)
      const before = read()
      expect(before['bloated']!.preview_len).toBeNull()
      expect(before['bloated']!.index_len).toBeNull()
      expect(fts(far), 'before: the bloated row is found by its far words').toContain(ids['bloated'])
      raw.pragma('user_version = 29')
      raw.close()

      const reopened = await open()
      await reopened.close()

      const raw2 = new BetterSqlite3(path, { readonly: true })
      try {
        expect(raw2.pragma('user_version', { simple: true })).toBe(30)
        const after = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k,
          raw2.prepare('SELECT node_id, metadata_json, content, index_len, preview_len FROM nodes WHERE node_id = ?').get(id) as Raw]))
        const fts2 = (term: string): string[] => (raw2.prepare(
          'SELECT n.node_id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?',
        ).all(`"${term}"`) as Array<{ node_id: string }>).map((r) => r.node_id)
        // The bloated row: stamped at the boundaries, columns lifted, words kept, reach shrunk.
        const bloatedLen = decodeContent(after['bloated']!.content).length
        const bm = JSON.parse(after['bloated']!.metadata_json) as Record<string, unknown>
        expect(bm['_preview_len']).toBe(RECOVERY_PREVIEW_LEN)
        expect(bm['_index_len']).toBe(RECOVERY_INDEX_LEN)
        expect(after['bloated']!.preview_len).toBe(RECOVERY_PREVIEW_LEN)
        expect(after['bloated']!.index_len).toBe(RECOVERY_INDEX_LEN)
        expect(bloatedLen).toBeGreaterThan(RECOVERY_INDEX_LEN)
        expect(decodeContent(after['bloated']!.content)).toBe(decodeContent(before['bloated']!.content))
        expect(bm['original_session_id']).toBe('s1')
        expect(fts2(far)).not.toContain(ids['bloated'])
        expect(fts2(far), 'the note still carries the word').toContain(ids['note'])
        expect(fts2('plan'), 'words inside the boundary still find it').toContain(ids['bloated'])
        // The short row: stamps equal its length (nothing to cut, and the
        // read side shows it whole).
        const shortLen = decodeContent(after['short']!.content).length
        const sm = JSON.parse(after['short']!.metadata_json) as Record<string, unknown>
        expect(sm['_preview_len']).toBe(shortLen)
        expect(sm['_index_len']).toBe(shortLen)
        // Already bounded: byte-identical metadata.
        expect(after['already']!.metadata_json).toBe(before['already']!.metadata_json)
        // Not recovery rows: untouched.
        for (const k of ['note', 'tool']) {
          expect(after[k]!.metadata_json).toBe(before[k]!.metadata_json)
          expect(after[k]!.index_len).toBe(before[k]!.index_len)
          expect(after[k]!.preview_len).toBe(before[k]!.preview_len)
        }
      } finally {
        raw2.close()
      }
    } finally {
      rmTree(dir)
    }
  })
})
