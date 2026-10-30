/**
 * Migration 029 (D263): the untyped, unregistered SubagentStop reports a
 * store holds are re-marked as the client's internal summaries — and
 * nothing else is. Each row of the matrix is seeded in the shape an earlier
 * treecontext left it, the store is rewound to schema 28 and opened by this
 * build, and every row is read straight from SQLite.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmTree } from '../helpers/fs.js'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { handoffMetadata, SUBAGENT_SUMMARY_KIND } from '../../src/handoff.js'
import { CLIENT_WRITER, INTERNAL_SUMMARY_KIND, registerSubagent } from '../../src/persistence/session-registry.js'

type Raw = { node_id: string; metadata_json: string; content: Buffer | string | null; source_label: string | null; session_key: string | null }

describe('migration 029 (D263)', () => {
  it('re-marks only the untyped, unregistered hook capture outside a handoff lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-m029-'))
    try {
      const path = join(dir, 's.db')
      const open = (): Promise<FlatStore> => FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true })
      const store = await open()
      const S = 'cc-sess'
      const hook = (writer: string, agentId: string): Record<string, unknown> => ({
        source: 'auto-capture', role: 'assistant', session_id: S, priority: 1, kind: SUBAGENT_SUMMARY_KIND,
        _writer: writer, _writer_agent_id: agentId, _writer_src: 'hook',
      })
      const ids: Record<string, string> = {}
      const put = async (name: string, text: string, metadata: Record<string, unknown>): Promise<void> => {
        ids[name] = (await store.insert(text, { metadata })).nodeId
      }
      // The one row the migration exists for: the hook's capture of an
      // untyped stop under an agent id nobody registered.
      await put('internal', 'compaction summary: the login form is wired', hook('a-internal', 'a-internal'))
      // A typed subagent's report: its writer is its role.
      await put('typed', 'tester: 12 tests pass, CSRF fails', hook('tester', 'a-tester'))
      // An untyped report whose agent a SubagentStart DID register (retired
      // since): a subagent, kept.
      await put('registered', 'untyped but registered subagent report', hook('a-reg', 'a-reg'))
      // A row a caller wrote through the library, marked subagent-summary by
      // its own word, before any writer stamp existed: not the hook's.
      await put('curated', 'a hand-written subagent summary note', { kind: SUBAGENT_SUMMARY_KIND, _cc_session_id: S })
      // Imported rows, through the real import rule: a typed summary and an
      // untyped one, each in its handoff lane, writer only under the claims.
      const source = { file: 'handoffs/beta1.json', sender: 'a@host', importer: S }
      await put('importedTyped', 'imported: tester says 12 pass', handoffMetadata(hook('tester', 'b-tester'), source, 1))
      await put('importedUntyped', 'imported: an untyped compaction summary', handoffMetadata(hook('b-internal', 'b-internal'), source, 1))
      // A row whose metadata does not parse.
      await put('invalid', 'a row whose metadata is an array', { note: 'x' })
      await put('nullMeta', 'a row with no metadata', { note: 'y' })
      // Its own connection, closed before the directory goes: a handle left
      // open here is what made the temp dir unremovable on Windows (the
      // beta.2 matrix, 2026-10-11: EPERM at the final rmSync).
      const reg = new BetterSqlite3(path)
      registerSubagent(wrapBetterSqlite(reg), S, 'a-reg', null,
        { worktree: null, branch: null, cwd: dir, toplevel: null, commonDir: null }, 1)
      reg.close()
      await store.close()

      const raw = new BetterSqlite3(path)
      // Metadata that is not an object: JSON that does not parse cannot be
      // stored at all (the expression indexes on metadata_json evaluate it
      // on write and refuse it), so the robust shapes left are a NULL and a
      // JSON array; the migration reads past both.
      expect(() => raw.prepare('UPDATE nodes SET metadata_json = ? WHERE node_id = ?').run('{not json', ids['invalid'])).toThrow(/malformed JSON/)
      raw.prepare('UPDATE nodes SET metadata_json = ? WHERE node_id = ?').run('[1,2]', ids['invalid'])
      raw.prepare('UPDATE nodes SET metadata_json = NULL WHERE node_id = ?').run(ids['nullMeta'])
      raw.prepare("UPDATE session_registry SET stopped_at = 2 WHERE agent_id = 'a-reg'").run()
      raw.pragma('user_version = 28')
      const read = (): Record<string, Raw> => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k,
        raw.prepare('SELECT node_id, metadata_json, content, source_label, session_key FROM nodes WHERE node_id = ?').get(id) as Raw]))
      const before = read()
      raw.close()
      // The seeds are the shapes they claim to be.
      expect(before['internal']!.source_label).toBe('auto-capture')
      expect(before['curated']!.source_label).not.toBe('auto-capture')
      for (const k of ['importedTyped', 'importedUntyped']) {
        expect(before[k]!.session_key).toMatch(/^handoff:/)
        const m = JSON.parse(before[k]!.metadata_json) as Record<string, unknown>
        expect(m['kind']).toBe(SUBAGENT_SUMMARY_KIND)
        expect(m['_writer']).toBeUndefined()
      }

      const reopened = await open() // neither odd row makes the open throw
      await reopened.close()
      const db = new BetterSqlite3(path, { readonly: true })
      expect(db.pragma('user_version', { simple: true })).toBe(maxSupportedVersion)
      const after = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k,
        db.prepare('SELECT node_id, metadata_json, content, source_label, session_key FROM nodes WHERE node_id = ?').get(id) as Raw]))
      db.close()

      // Re-marked: kind and writer, nothing else; content bytes identical.
      expect(JSON.parse(after['internal']!.metadata_json)).toEqual({
        ...JSON.parse(before['internal']!.metadata_json), kind: INTERNAL_SUMMARY_KIND, _writer: CLIENT_WRITER,
      })
      expect(Buffer.from(after['internal']!.content as Buffer).equals(Buffer.from(before['internal']!.content as Buffer))).toBe(true)
      // Every other row: byte for byte as it was.
      for (const k of ['typed', 'registered', 'curated', 'importedTyped', 'importedUntyped', 'invalid', 'nullMeta']) {
        expect(after[k], k).toEqual(before[k])
      }
    } finally {
      rmTree(dir)
    }
  })
})
