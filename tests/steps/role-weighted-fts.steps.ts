/**
 * role-weighted-fts.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated 1:1 from the
 * vitest-cucumber binding; every sentence in this feature is unique and
 * every assertion preserved verbatim. Footguns: FG-1..FG-10.)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'
import { ftsSearch } from '../helpers/fts-search.js'
import { makePersistedNode as makeNode } from '../helpers/persisted-node.js'
import { encodeContent, decodeContent } from '../../src/persistence/content-codec.js'
import { indexTextFor } from '../../src/persistence/index-text.js'
import { ZSTD_MIN_BYTES } from '../../src/persistence/capture-constants.js'
import { currentSchemaVersion, runMigrations } from '../../src/persistence/migrations.js'
import { ContentDecodeError, ValidationError } from '../../src/errors/index.js'

// ── Legacy (pre-migration) fixture builder ───────────────────────────
//
// Hand-rolled DDL matching what a store at schema version 12 looked like:
// single-column nodes_fts, no nodes.index_col. Persistence.openLexical()
// then drives migration 013 exactly like it would against a real old store.

const LEGACY_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE store_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE trees (
  tree_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'project',
  ensemble_index INTEGER NOT NULL, created_at INTEGER NOT NULL,
  import_labels_json TEXT, UNIQUE(namespace, ensemble_index)
);
CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY, tree_id INTEGER NOT NULL REFERENCES trees(tree_id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES nodes(node_id) ON DELETE CASCADE,
  depth INTEGER NOT NULL DEFAULT 0, is_leaf INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  embedding_raw BLOB, embedding_compressed BLOB, embedding_modal_raw BLOB, embedding_modal_compressed BLOB,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, summary_stale INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0, decay_exempt INTEGER NOT NULL DEFAULT 0, decay_rate REAL,
  utility_score REAL NOT NULL DEFAULT 0.5, insert_generation INTEGER,
  source_label TEXT, metadata_json TEXT
);
CREATE VIRTUAL TABLE nodes_fts USING fts5(content, content='', tokenize='unicode61 remove_diacritics 2');
INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0);
PRAGMA user_version = 12;
`

interface LegacyRow {
  nodeId: string
  content: string | Buffer
  metadata: Record<string, unknown> | null
  summary?: string
}

/**
 * The fixture opens a real SQLite file, so it registers its own close.
 *
 * Two scenarios never closed it by hand and did not have to on POSIX, where
 * unlinking an open file is legal — so `rmSync` in stageDir's defer succeeded
 * and the leak was invisible. On Windows the same rmSync is EPERM, and the
 * scenario fails in teardown having asserted everything correctly. Closing here
 * rather than in each step keeps the pairing with the open, and the defer is
 * registered AFTER stageDir's so LIFO teardown closes before it removes.
 */
function buildLegacyStore(w: World, rows: LegacyRow[]): Database {
  const db = wrapBetterSqlite(new BetterSqlite3(join(w.dir!, 'legacy.db')))
  // The wrapper's close() is idempotent, so the steps that also close by hand
  // (and reopen onto a fresh handle) are unaffected.
  w.defer(() => db.close())
  db.exec(LEGACY_DDL)
  const insNode = db.prepare(
    'INSERT INTO nodes (node_id, tree_id, parent_id, depth, is_leaf, content, summary, created_at, updated_at, metadata_json) ' +
      "VALUES (?, 1, NULL, 0, 1, ?, ?, 0, 0, ?)",
  )
  const insFts = db.prepare('INSERT INTO nodes_fts(rowid, content) VALUES (?, ?)')
  for (const r of rows) {
    const result = insNode.run(r.nodeId, r.content, r.summary ?? '', r.metadata ? JSON.stringify(r.metadata) : null)
    const rowid = Number(result.lastInsertRowid)
    // Mirrors production's pre-role-weighting insertNode: decode (zstd-aware)
    // then index the (role/cap-bounded) text — the legacy build already had
    // the capture batch's content-codec + index-text machinery (FG-10).
    const decoded = decodeContent(r.content)
    if (decoded) insFts.run(rowid, indexTextFor(decoded, r.metadata))
  }
  return db
}

function legacyHits(db: Database, term: string): number[] {
  return db
    .prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?')
    .all(term)
    .map((r) => Number((r as { rowid: unknown }).rowid))
}

function columnHits(db: Database, column: 'user_text' | 'assistant_text' | 'tool_text' | 'note_text', term: string): string[] {
  return db
    .prepare(`SELECT n.node_id AS node_id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid WHERE ${column} MATCH ?`)
    .all(term)
    .map((r) => String((r as { node_id: unknown }).node_id))
}

function indexColOf(db: Database, nodeId: string): number | null {
  const row = db.prepare('SELECT index_col FROM nodes WHERE node_id = ?').get(nodeId) as { index_col: number | null } | undefined
  return row?.index_col ?? null
}

interface World {
  defer: (fn: () => void | Promise<void>) => void
  dir?: string
  db?: Database
  persistence?: Persistence
  plainId?: string
  compressedId?: string
  captureId?: string
  noteId?: string
  okId?: string
  corruptId?: string
  nodeId?: string
  userNodeId?: string
  noteNodeId?: string
  raw?: InstanceType<typeof BetterSqlite3>
  threeArg?: number
  fourArg?: number
  belowZero?: number
  aboveTen?: number
  store?: FlatStore
}

export const roleWeightedFtsDefiner = (reg: Registry<World>): void => {
  function stageDir(w: World): string {
    const dir = mkdtempSync(join(tmpdir(), 'tc-role-fts-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    w.dir = dir
    return dir
  }

  function openDb(w: World, name: string): Database {
    const dir = stageDir(w)
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, name)))
    w.defer(() => db.close())
    return db
  }

  reg.define(/^a legacy store with plain, compressed, capture and note rows indexed single-column$/, (w) => {
    stageDir(w)
    w.plainId = randomUUID()
    w.compressedId = randomUUID()
    w.captureId = randomUUID()
    w.noteId = randomUUID()
    const plainMarker = 'plainLegacyMarker'
    const compressedMarker = 'compressedLegacyMarker'
    const captureMarker = 'captureLegacyMarker'
    const noteMarker = 'noteLegacyMarker'
    const compressedText = `${compressedMarker} ${'padding text to cross the zstd floor. '.repeat(20)}`
    expect(Buffer.byteLength(compressedText, 'utf8')).toBeGreaterThan(ZSTD_MIN_BYTES)
    // Tail markers (round-2 R10): first-token probes survive ANY
    // truncation, so every row also carries a distinctive LAST token
    // and the Then probes both ends of the rebuilt index text.
    w.db = buildLegacyStore(w, [
      { nodeId: w.plainId, content: `${plainMarker} short note plainTailMarker`, metadata: null },
      {
        nodeId: w.compressedId,
        content: encodeContent(compressedText) as Buffer,
        metadata: { source: 'auto-capture', role: 'assistant' },
      },
      {
        nodeId: w.captureId,
        content: `${captureMarker} tool output preview captureTailMarker`,
        metadata: { source: 'auto-capture', role: 'assistant', tool_name: 'Bash' },
      },
      { nodeId: w.noteId, content: `${noteMarker} curated decision noteTailMarker`, metadata: { source: 'manual' } },
    ])
  })

  reg.define(/^the store is opened with the role-weighted schema version$/, (w) => {
    Persistence.openLexical(w.db!, { migrate: true }).close()
    const dir = w.dir!
    w.db!.close()
    w.db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'legacy.db')))
    w.defer(() => w.db!.close())
  })

  reg.define(/^each row matches via its attributed column and index_col is backfilled$/, (w) => {
    const db = w.db!
    const plainMarker = 'plainLegacyMarker'
    const compressedMarker = 'compressedLegacyMarker'
    const captureMarker = 'captureLegacyMarker'
    const noteMarker = 'noteLegacyMarker'
    expect(currentSchemaVersion(db)).toBeGreaterThanOrEqual(13)
    // plain/legacy (no metadata) -> user_text, index_col 0
    expect(columnHits(db, 'user_text', plainMarker)).toEqual([w.plainId])
    expect(columnHits(db, 'user_text', 'plainTailMarker')).toEqual([w.plainId])
    expect(columnHits(db, 'tool_text', 'captureTailMarker')).toEqual([w.captureId])
    expect(columnHits(db, 'note_text', 'noteTailMarker')).toEqual([w.noteId])
    expect(indexColOf(db, w.plainId!)).toBe(0)
    // compressed assistant (no tool_name) -> assistant_text, index_col 1
    expect(columnHits(db, 'assistant_text', compressedMarker)).toEqual([w.compressedId])
    expect(indexColOf(db, w.compressedId!)).toBe(1)
    // capture (assistant + tool_name) -> tool_text, index_col 2
    expect(columnHits(db, 'tool_text', captureMarker)).toEqual([w.captureId])
    expect(indexColOf(db, w.captureId!)).toBe(2)
    // note (agent-authored) -> note_text, index_col 3
    expect(columnHits(db, 'note_text', noteMarker)).toEqual([w.noteId])
    expect(indexColOf(db, w.noteId!)).toBe(3)
  })

  reg.define(/^a legacy store and a rebuild that fails partway$/, (w) => {
    stageDir(w)
    w.okId = randomUUID()
    w.corruptId = randomUUID()
    const okMarker = 'atomicOkMarker'
    w.db = buildLegacyStore(w, [
      { nodeId: w.okId, content: `${okMarker} healthy row`, metadata: null },
      { nodeId: w.corruptId, content: 'row to be corrupted', metadata: null },
    ])
    // Corrupt the second row's content with an unrecognized flag byte so
    // decodeContent() throws mid-backfill (0xFF is neither the plain nor
    // zstd flag byte content-codec.ts recognizes).
    w.db.prepare('UPDATE nodes SET content = ? WHERE node_id = ?').run(Buffer.from([0xff, 0x00, 0x01]), w.corruptId)
  })

  reg.define(/^the failed migration is rolled back$/, (w) => {
    expect(() => Persistence.openLexical(w.db!, { migrate: true })).toThrow(ContentDecodeError)
  })

  reg.define(/^queries against the legacy index still return every row$/, (w) => {
    const db = w.db!
    // Version stamp unchanged — the migration never committed.
    expect(currentSchemaVersion(db)).toBe(12)
    // The legacy single-column table is still there with its original row.
    expect(legacyHits(db, 'atomicOkMarker')).toHaveLength(1)
    // nodes.index_col was never added (ALTER TABLE rolled back too).
    expect(() => db.prepare('SELECT index_col FROM nodes').all()).toThrow()
  })

  reg.define(/^a store already migrated to the role-weighted schema$/, (w) => {
    w.db = openDb(w, 'migrated.db')
    Persistence.openLexical(w.db, { migrate: true })
    expect(currentSchemaVersion(w.db)).toBeGreaterThanOrEqual(13)
  })

  reg.define(/^it is opened again$/, () => {
    // direct
  })

  reg.define(/^the version stamp is unchanged and no rebuild occurs$/, (w) => {
    const before = currentSchemaVersion(w.db!)
    const report = runMigrations(w.db!, { migrate: true })
    expect(report.applied).toHaveLength(0)
    expect(currentSchemaVersion(w.db!)).toBe(before)
  })

  reg.define(/^nodes for a user message, an assistant response, a tool event and an agent note$/, (w) => {
    w.db = openDb(w, 'route.db')
    w.persistence = Persistence.openLexical(w.db)
    w.db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
  })

  reg.define(/^they are inserted$/, (w) => {
    const userMarker = 'roleUserMarker'
    const assistantMarker = 'roleAssistantMarker'
    const toolMarker = 'roleToolMarker'
    const noteMarker = 'roleNoteMarker'
    w.persistence!.insertNode(1, makeNode({ content: `${userMarker} hi`, metadata: { source: 'auto-capture', role: 'user' } }))
    w.persistence!.insertNode(1, makeNode({ content: `${assistantMarker} reply`, metadata: { source: 'auto-capture', role: 'assistant' } }))
    w.persistence!.insertNode(1, makeNode({ content: `${toolMarker} output`, metadata: { source: 'auto-capture', role: 'assistant', tool_name: 'Bash' } }))
    w.persistence!.insertNode(1, makeNode({ content: `${noteMarker} decision`, metadata: { source: 'manual' } }))
  })

  reg.define(/^each is findable via exactly its attributed column and no other$/, (w) => {
    const columns = ['user_text', 'assistant_text', 'tool_text', 'note_text'] as const
    const expectations: Record<string, (typeof columns)[number]> = {
      'roleUserMarker': 'user_text',
      'roleAssistantMarker': 'assistant_text',
      'roleToolMarker': 'tool_text',
      'roleNoteMarker': 'note_text',
    }
    for (const [marker, expectedCol] of Object.entries(expectations)) {
      for (const col of columns) {
        const hits = columnHits(w.db!, col, marker)
        if (col === expectedCol) expect(hits).toHaveLength(1)
        else expect(hits).toHaveLength(0)
      }
    }
  })

  reg.define(
    /^an inserted capture node whose metadata is later rewritten by supersede, demotion, and the export reliance bump$/,
    (w) => {
      w.db = openDb(w, 'meta-edit.db')
      w.persistence = Persistence.openLexical(w.db)
      w.db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
      w.nodeId = randomUUID()
      const marker = 'supersedeDemoteMarker'
      w.persistence.insertNode(
        1,
        makeNode({
          nodeId: w.nodeId,
          content: `${marker} tool output`,
          metadata: { source: 'auto-capture', role: 'assistant', tool_name: 'Bash' },
        }),
      )
      expect(columnHits(w.db, 'tool_text', marker)).toEqual([w.nodeId])
      // Direct-SQL metadata rewrite, bypassing Persistence.updateNode — this
      // mirrors FlatStore.applySupersedes (supersede) + demoteOverBudget
      // (demotion), both of which mutate metadata_json directly. Strip
      // tool_name so a NAIVE recompute-from-metadata would misattribute
      // this row to assistant_text instead of tool_text.
      w.db.prepare('UPDATE nodes SET metadata_json = ? WHERE node_id = ?').run(
        JSON.stringify({ source: 'auto-capture', role: 'assistant', status: 'superseded', _demoted: true }),
        w.nodeId,
      )
      // …and the third shipped rewriter (staleness repair 2026-08-12):
      // the export reliance bump, applied EXACTLY as exportJson applies
      // it — json_set on the live metadata_json.
      w.db.prepare(
        "UPDATE nodes SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$._relied_count', " +
          "COALESCE(json_extract(metadata_json, '$._relied_count'), 0) + 1) WHERE node_id = ?",
      ).run(w.nodeId)
    },
  )

  reg.define(/^the node is deleted$/, (w) => {
    w.persistence!.deleteNode(w.nodeId!)
  })

  reg.define(/^the FTS index holds no ghost entry for it in any column$/, (w) => {
    for (const col of ['user_text', 'assistant_text', 'tool_text', 'note_text'] as const) {
      expect(columnHits(w.db!, col, 'supersedeDemoteMarker')).toEqual([])
    }
  })

  reg.define(/^a compressed node whose index text is a prefix of its content$/, (w) => {
    w.db = openDb(w, 'compressed-roundtrip.db')
    w.persistence = Persistence.openLexical(w.db)
    w.db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
    w.nodeId = randomUUID()
    const content = `compressedOriginalMarker ${'pad '.repeat(600)}`
    w.persistence.insertNode(1, makeNode({ nodeId: w.nodeId, content, metadata: { source: 'auto-capture', role: 'user' } }))
    expect(columnHits(w.db, 'user_text', 'compressedOriginalMarker')).toEqual([w.nodeId])
  })

  reg.define(/^it is updated and then deleted$/, (w) => {
    const updatedContent = `compressedUpdatedMarker ${'pad '.repeat(600)}`
    w.persistence!.updateNode(makeNode({ nodeId: w.nodeId!, content: updatedContent, metadata: { source: 'auto-capture', role: 'user' } }))
    expect(columnHits(w.db!, 'user_text', 'compressedOriginalMarker')).toEqual([])
    expect(columnHits(w.db!, 'user_text', 'compressedUpdatedMarker')).toEqual([w.nodeId])
    w.persistence!.deleteNode(w.nodeId!)
  })

  reg.define(/^no stale text matches and the updated text matched while it lived$/, (w) => {
    expect(columnHits(w.db!, 'user_text', 'compressedUpdatedMarker')).toEqual([])
    expect(columnHits(w.db!, 'user_text', 'compressedOriginalMarker')).toEqual([])
  })

  reg.define(/^a four-column index and a bm25 call passing only three weights$/, (w) => {
    const raw = new BetterSqlite3(':memory:')
    w.defer(() => { raw.close() })
    raw.exec("CREATE VIRTUAL TABLE fts USING fts5(user_text, assistant_text, tool_text, note_text, content='')")
    raw.prepare('INSERT INTO fts(rowid, user_text, assistant_text, tool_text, note_text) VALUES (1, ?, ?, ?, ?)').run(
      '', '', '', 'the note column target term',
    )
    w.raw = raw
  })

  reg.define(/^the engine ranks a note-column match$/, (w) => {
    w.threeArg = (w.raw!.prepare('SELECT bm25(fts, 1.0, 1.0, 1.0) AS score FROM fts WHERE fts MATCH ?').get('target') as { score: number }).score
    w.fourArg = (w.raw!.prepare('SELECT bm25(fts, 1.0, 1.0, 1.0, 1.0) AS score FROM fts WHERE fts MATCH ?').get('target') as { score: number }).score
  })

  reg.define(/^the note column scores at full weight, pinning why the helper must always pass all four$/, (w) => {
    // The omitted 4th weight silently defaults to 1.0 — identical to
    // passing it explicitly. This is exactly the arity footgun
    // roleWeightVector() (FG-3) exists to make structurally impossible.
    expect(w.threeArg).toBe(w.fourArg)
  })

  reg.define(/^a row whose user text contains the literal phrase assistant_text colon term$/, (w) => {
    w.db = openDb(w, 'colfilter.db')
    w.persistence = Persistence.openLexical(w.db)
    w.db.prepare("INSERT INTO trees (tree_id, namespace, ensemble_index, created_at) VALUES (1, 'project', 0, 0)").run()
    w.userNodeId = randomUUID()
    w.noteNodeId = randomUUID()
    const phrase = 'assistant_text: term'
    w.persistence.insertNode(1, makeNode({ nodeId: w.userNodeId, content: `the config key is ${phrase} for testing`, metadata: { source: 'auto-capture', role: 'user' } }))
    // Second row in a DIFFERENT column, containing the same tokens — if
    // "assistant_text:" were ever interpreted as a column filter, this
    // note row (indexed in note_text, not assistant_text) would be the
    // only place a filtered search for "assistant_text: term" could even
    // theoretically match — and it should NOT, because there IS no
    // column-filter interpretation at all once tokens are quoted.
    w.persistence.insertNode(1, makeNode({ nodeId: w.noteNodeId, content: `another ${phrase} appears in a note`, metadata: { source: 'manual' } }))
  })

  reg.define(/^the escaped match query built from that phrase runs$/, () => {
    // Round-2 R10: the earlier binding tested a PRIVATE COPY of
    // buildFtsMatch's quoting — production could regress unnoticed. The
    // Then now drives the colon phrase through FlatStore.query itself.
  })

  reg.define(/^it matches as literal tokens and applies no column restriction$/, async (w) => {
    const store = await FlatStore.open({ database: w.db!, ownsDatabase: false })
    const hits = (await store.query('assistant_text: term', { topK: 10 })).map((h) => h.nodeId)
    await store.close()
    // Both rows match (one indexed in user_text, one in note_text) — proof
    // the query was NOT restricted to the literal "assistant_text" column,
    // which is empty for both rows and would have matched zero rows under
    // a column-filter misinterpretation.
    expect(new Set(hits)).toEqual(new Set([w.userNodeId, w.noteNodeId]))
  })

  reg.define(/^weight inputs below zero and above ten$/, async (w) => {
    // Round-2 R10: the earlier binding called validateRoleWeights directly —
    // no query surface anywhere, so dropping the validator from
    // FlatStore.query would have stayed green. Drive the real surface.
    w.belowZero = -1
    w.aboveTen = 11
    const dir = mkdtempSync(join(tmpdir(), 'tc-role-fts-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'weights.db')))
    w.defer(() => db.close())
    const store = await FlatStore.open({
      database: db,
      ownsDatabase: true,
    })
    w.defer(() => store.close())
    w.store = store
    await store.insert('a row so the query has something to rank')
  })

  reg.define(/^a query is attempted$/, () => {
    // The attempts and their rejection are one observable — asserted in
    // the Then against store.query itself.
  })

  reg.define(/^the weights are rejected before reaching bm25$/, async (w) => {
    await expect(w.store!.query('row', { roleWeights: { assistant: w.belowZero! } })).rejects.toThrow(ValidationError)
    await expect(w.store!.query('row', { roleWeights: { tool: w.aboveTen! } })).rejects.toThrow(ValidationError)
    const ok = await w.store!.query('row', { roleWeights: { user: 2 } })
    expect(ok.length).toBeGreaterThan(0)
  })

  reg.define(/^a node with distinctive summary text absent from its content$/, (w) => {
    stageDir(w)
    w.nodeId = randomUUID()
    const summaryMarker = 'distinctiveSummaryOnlyMarker'
    w.db = buildLegacyStore(w, [
      { nodeId: w.nodeId, content: 'ordinary content with no special markers', summary: summaryMarker, metadata: null },
    ])
    // Not indexed before migration either.
    expect(legacyHits(w.db, summaryMarker)).toHaveLength(0)
  })

  reg.define(/^the store is migrated and queried for the summary text$/, (w) => {
    Persistence.openLexical(w.db!, { migrate: true })
  })

  reg.define(/^nothing matches, before and after$/, (w) => {
    expect(ftsSearch(w.db!, 'distinctiveSummaryOnlyMarker', 10)).toHaveLength(0)
  })
}
