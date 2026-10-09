/**
 * Persistence layer tests — schema, migrations, store CRUD, FTS5,
 * tree/namespace management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import type { Database } from '../../src/persistence/database.js'
import { Persistence } from '../../src/persistence/store.js'
import type { PersistedNode } from '../../src/persistence/store.js'
import { SCHEMA_SQL } from '../../src/persistence/schema.js'
import { currentSchemaVersion, runMigrations } from '../../src/persistence/migrations.js'
import { maxSupportedVersion } from '../../src/persistence/migrations/index.js'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { FlatStore } from '../../src/flat-store.js'
import { SchemaVersionError } from '../../src/errors/index.js'
import { escapeFtsQuery, ftsSearch } from '../helpers/fts-search.js'
import { makePersistedNode } from '../helpers/persisted-node.js'

// ── Helpers ─────────────────────────────────────────────────────────

/** The shared builder (helpers/persisted-node) under this file's two own
 *  defaults: whole-second stamps, and a body — the cascade test leans on
 *  a parent whose content is there and differs from its child's. */
function makeNode(partial: Partial<PersistedNode> = {}): PersistedNode {
  const now = Math.floor(Date.now() / 1000)
  return makePersistedNode({ content: 'test content', createdAt: now, updatedAt: now, ...partial })
}

interface NodeRow {
  node_id: string
  tree_id: number
  parent_id: string | null
  depth: number
  is_leaf: number
  content: string
  summary: string
  summary_stale: number
  read_only: number
  decay_exempt: number
  decay_rate: number | null
  utility_score: number
  source_label: string | null
  metadata_json: string | null
}

/** Read a node row back via raw SQL, decoding the content codec. */
function readNode(targetDb: Database, nodeId: string): NodeRow | undefined {
  const row = targetDb
    .prepare(
      'SELECT node_id, tree_id, parent_id, depth, is_leaf, content, summary, ' +
        'summary_stale, read_only, decay_exempt, decay_rate, utility_score, ' +
        'source_label, metadata_json FROM nodes WHERE node_id = ?',
    )
    .get(nodeId) as (Omit<NodeRow, 'content'> & { content: string | Buffer }) | undefined
  if (!row) return undefined
  return { ...row, content: decodeContent(row.content) }
}

function countNodes(targetDb: Database): number {
  return Number(
    (targetDb.prepare('SELECT COUNT(*) AS cnt FROM nodes').get() as { cnt: unknown }).cnt,
  )
}

let tmpDir: string
let db: Database

function createDb(): Database {
  const raw = new BetterSqlite3(join(tmpDir, `test-${Date.now()}.db`))
  return wrapBetterSqlite(raw)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tc-test-'))
  db = createDb()
})

afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Schema ──────────────────────────────────────────────────────────

describe('Schema', () => {
  it('applies cleanly to an empty database', () => {
    db.exec(SCHEMA_SQL)
    // Tables should exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)

    expect(tables).toContain('nodes')
    expect(tables).toContain('trees')
    expect(tables).toContain('schema_meta')
    expect(tables).toContain('store_config')
    expect(tables).toContain('embedding_model')
    expect(tables).toContain('staging')
    // FTS5
    expect(tables).toContain('nodes_fts')
    // Dead tree-era tables left the base schema with migration 019.
    expect(tables).not.toContain('quantizer')
    expect(tables).not.toContain('nodes_trigram')
    expect(tables).not.toContain('flat_journal')
    expect(tables).not.toContain('modal_embedding_model')

    const nodeColumns = db
      .prepare("SELECT name FROM pragma_table_info('nodes') ORDER BY cid")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(nodeColumns).toContain('decay_rate')
  })

  it('refuses both embedding columns populated', () => {
    db.exec(SCHEMA_SQL)
    db.prepare(
      'INSERT INTO trees (tree_id, ensemble_index, created_at) VALUES (1, 0, 0)',
    ).run()

    const blob = new Uint8Array(32)
    expect(() =>
      db.prepare(
        'INSERT INTO nodes (node_id, tree_id, depth, is_leaf, content, summary, ' +
          'embedding_raw, embedding_compressed, created_at, updated_at, summary_stale, ' +
          'read_only, decay_exempt, utility_score) ' +
          'VALUES (?, 1, 0, 1, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0.5)',
      ).run('n1', 'content', '', blob, blob),
    ).toThrow()
  })
})

// ── Migrations ──────────────────────────────────────────────────────

describe('Migrations', () => {
  it('reports user_version 0 for a blank database', () => {
    expect(currentSchemaVersion(db)).toBe(0)
  })

  it('applies initial migration and stamps version', () => {
    const report = runMigrations(db, { migrate: true })
    expect(report.from).toBe(0)
    expect(report.to).toBe(maxSupportedVersion)
    expect(report.applied.length).toBeGreaterThan(0)
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)
  })

  it('is idempotent when already at max version', () => {
    runMigrations(db, { migrate: true })
    const report = runMigrations(db, { migrate: true })
    expect(report.applied).toHaveLength(0)
  })

  it('throws SchemaVersionError for future versions', () => {
    db.pragma('user_version', 9999)
    expect(() => runMigrations(db)).toThrow(SchemaVersionError)
  })
})

// ── Persistence.openLexical ─────────────────────────────────────────

describe('Persistence.openLexical', () => {
  it('creates schema on first open', () => {
    const store = Persistence.openLexical(db)
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)
    store.close()
  })

  it('stamps last_opened_at on every open', () => {
    Persistence.openLexical(db)
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'last_opened_at'").get() as
      | { value: string }
      | undefined
    expect(row).toBeDefined()
    expect(Number(row!.value)).toBeGreaterThan(0)
  })
})

// ── Node CRUD ───────────────────────────────────────────────────────

describe('Node CRUD', () => {
  let store: Persistence

  beforeEach(() => {
    store = Persistence.openLexical(db)
    store.ensureTree(0)
  })

  afterEach(() => {
    store.close()
  })

  it('inserts a single leaf node', () => {
    const node = makeNode({ treeId: 1, content: 'hello world' })
    store.insertNode(1, node)

    expect(countNodes(db)).toBe(1)
    const row = readNode(db, node.nodeId)!
    expect(row.content).toBe('hello world')
    expect(row.node_id).toBe(node.nodeId)
    expect(row.is_leaf).toBe(1)
  })

  it('round-trips all node fields', () => {
    const node = makeNode({
      treeId: 1,
      content: 'content text',
      summary: 'summary text',
      depth: 2,
      isLeaf: false,
      summaryStale: true,
      readOnly: true,
      decayExempt: true,
      decayRate: 4.0,
      utilityScore: 0.75,
      sourceLabel: 'test-label',
      metadata: { key: 'value' },
    })
    store.insertNode(1, node)

    const row = readNode(db, node.nodeId)!
    expect(row.content).toBe('content text')
    expect(row.summary).toBe('summary text')
    expect(row.depth).toBe(2)
    expect(row.is_leaf).toBe(0)
    expect(row.summary_stale).toBe(1)
    expect(row.read_only).toBe(1)
    expect(row.decay_exempt).toBe(1)
    expect(row.decay_rate).toBe(4.0)
    expect(row.utility_score).toBeCloseTo(0.75)
    expect(row.source_label).toBe('test-label')
    expect(JSON.parse(row.metadata_json!)).toEqual({ key: 'value' })
  })

  it('updates a node', () => {
    const node = makeNode({ treeId: 1, content: 'original' })
    store.insertNode(1, node)

    node.content = 'updated'
    node.summary = 'new summary'
    node.summaryStale = false
    node.decayRate = 2.0
    store.updateNode(node)

    const row = readNode(db, node.nodeId)!
    expect(row.content).toBe('updated')
    expect(row.summary).toBe('new summary')
    expect(row.decay_rate).toBe(2.0)
  })

  it('deletes a node', () => {
    const node = makeNode({ treeId: 1 })
    store.insertNode(1, node)
    expect(countNodes(db)).toBe(1)

    store.deleteNode(node.nodeId)
    expect(countNodes(db)).toBe(0)
  })

  it('cascade deletes children', () => {
    const root = makeNode({ treeId: 1, nodeId: 'root', depth: 0, isLeaf: false })
    // Distinct content: since G2 the curated unique index refuses a
    // same-tree fingerprint twin at the engine (insertNode returns false),
    // and this test is about cascade deletion, not dedup.
    const child = makeNode({ treeId: 1, nodeId: 'child', parentId: 'root', depth: 1, isLeaf: true, content: 'child content' })
    expect(store.insertNode(1, root)).toBe(true)
    expect(store.insertNode(1, child)).toBe(true)
    expect(countNodes(db)).toBe(2)

    store.deleteNode('root')
    expect(countNodes(db)).toBe(0)
  })
})

describe('mediaRef persistence roundtrip', () => {
  it('preserves mediaRef metadata across close and reopen', async () => {
    const dbPath = join(tmpDir, 'media-roundtrip.db')

    const raw1 = new BetterSqlite3(dbPath)
    const db1 = wrapBetterSqlite(raw1)
    const ctx1 = await FlatStore.open({ database: db1, ownsDatabase: true })

    await ctx1.insert('screenshot of the auth timeout banner', {
      mediaRef: {
        uri: 'file:///tmp/auth-timeout.png',
        mimeType: 'image/png',
        filename: 'auth-timeout.png',
        extension: 'png',
      },
    })
    await ctx1.close()

    const raw2 = new BetterSqlite3(dbPath)
    const db2 = wrapBetterSqlite(raw2)
    const ctx2 = await FlatStore.open({ database: db2, ownsDatabase: true })

    const results = await ctx2.query('auth timeout banner screenshot', {
      topK: 5,
      mediaFilter: { mimePrefix: 'image/' },
    })

    expect(results).toHaveLength(1)
    const media = results[0]?.metadata?._media as Record<string, unknown> | undefined
    expect(media?.uri).toBe('file:///tmp/auth-timeout.png')
    expect(media?.mimeType).toBe('image/png')
    expect(media?.filename).toBe('auth-timeout.png')
    expect(media?.extension).toBe('png')

    await ctx2.close()
  })
})

// ── FTS5 ────────────────────────────────────────────────────────────

describe('FTS5', () => {
  let store: Persistence

  beforeEach(() => {
    store = Persistence.openLexical(db)
    store.ensureTree(0)
  })

  afterEach(() => {
    store.close()
  })

  it('indexes content on insert', () => {
    store.insertNode(1, makeNode({ treeId: 1, content: 'banana smoothie recipe' }))
    store.insertNode(1, makeNode({ treeId: 1, content: 'apple pie baking guide' }))
    store.insertNode(1, makeNode({ treeId: 1, content: 'banana bread tutorial' }))

    const hits = ftsSearch(db, 'banana', 10)
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => h.score > 0)).toBe(true)
  })

  it('updates FTS index on node update', () => {
    const node = makeNode({ treeId: 1, content: 'original banana content' })
    store.insertNode(1, node)

    // Before update: should find "banana"
    expect(ftsSearch(db, 'banana', 10)).toHaveLength(1)

    // Update content
    node.content = 'updated apple content'
    store.updateNode(node)

    expect(ftsSearch(db, 'banana', 10)).toHaveLength(0)
    expect(ftsSearch(db, 'apple', 10)).toHaveLength(1)
  })

  it('removes FTS entries on delete', () => {
    const node = makeNode({ treeId: 1, content: 'unique keyword xyzzy' })
    store.insertNode(1, node)
    expect(ftsSearch(db, 'xyzzy', 10)).toHaveLength(1)

    store.deleteNode(node.nodeId)
    expect(ftsSearch(db, 'xyzzy', 10)).toHaveLength(0)
  })

  it('escapeFtsQuery wraps in double quotes', () => {
    expect(escapeFtsQuery('hello world')).toBe('"hello world"')
    expect(escapeFtsQuery('say "hi"')).toBe('"say ""hi"""')
    expect(escapeFtsQuery('')).toBe('')
  })
})

// ── Tree management ─────────────────────────────────────────────────

describe('Tree management', () => {
  let store: Persistence

  beforeEach(() => {
    store = Persistence.openLexical(db)
  })

  afterEach(() => {
    store.close()
  })

  // A type alias, not an interface: only an alias carries the implicit index
  // signature that lets the driver's `Record<string, unknown>` rows be
  // asserted into this shape without laundering them through `unknown`.
  type TreeRow = {
    tree_id: number
    namespace: string
    ensemble_index: number
  }

  function listTreeRows(namespace?: string): TreeRow[] {
    const sql =
      'SELECT tree_id, namespace, ensemble_index FROM trees' +
      (namespace ? ' WHERE namespace = ?' : '') +
      ' ORDER BY tree_id ASC'
    const stmt = db.prepare(sql)
    return (namespace ? stmt.all(namespace) : stmt.all()) as TreeRow[]
  }

  it('creates trees with ensureTree', () => {
    store.ensureTree(0)
    store.ensureTree(1)
    store.ensureTree(2)

    const trees = listTreeRows()
    expect(trees).toHaveLength(3)
    expect(trees[0]!.ensemble_index).toBe(0)
    expect(trees[1]!.ensemble_index).toBe(1)
    expect(trees[2]!.ensemble_index).toBe(2)
  })

  it('ensureTree is idempotent', () => {
    const id1 = store.ensureTree(0)
    const id2 = store.ensureTree(0)
    expect(id1).toBe(id2)
    expect(listTreeRows()).toHaveLength(1)
  })

  it('isolates ensemble_index across namespaces', () => {
    const p0 = store.ensureTree(0)                  // default 'project'
    const a0 = store.ensureTree(0, 'agent-a')
    const a1 = store.ensureTree(1, 'agent-a')
    expect(p0).not.toBe(a0)
    expect(a0).not.toBe(a1)

    // Re-calling is idempotent per (namespace, ensemble_index)
    expect(store.ensureTree(0, 'agent-a')).toBe(a0)

    const all = listTreeRows()
    expect(all).toHaveLength(3)
    expect(all.map((t) => t.namespace).sort()).toEqual(['agent-a', 'agent-a', 'project'])

    const onlyAgent = listTreeRows('agent-a')
    expect(onlyAgent).toHaveLength(2)
    expect(onlyAgent.every((t) => t.namespace === 'agent-a')).toBe(true)
  })
})
