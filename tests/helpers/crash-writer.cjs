/**
 * The crash-mid-write scenario's victim process (journal-storage
 * charter). Opens an EXISTING store file with the production pragmas
 * (WAL, synchronous=NORMAL — better-sqlite.ts DEFAULT_PRAGMAS) and
 * hammers capture/ingestion-shaped transactions forever: each commit
 * writes a staging row AND its nodes row atomically, then reports
 * `committed <i>` on stdout. It never exits on its own — the parent
 * SIGKILLs it mid-stream, which is the whole point.
 *
 * Plain CJS on purpose: the victim must need no TS toolchain, so the
 * kill hits a real node process running real better-sqlite3, not a
 * loader.
 *
 * argv: <dbPath> <treeId>
 */
const { createRequire } = require('node:module')
const { join } = require('node:path')
// Resolve better-sqlite3 from the repo the test runs in, not from this
// helper's directory.
const repoRequire = createRequire(join(__dirname, '..', '..', 'package.json'))
const BetterSqlite3 = repoRequire('better-sqlite3')

const [dbPath, treeIdRaw] = process.argv.slice(2)
const treeId = Number(treeIdRaw)

const db = new BetterSqlite3(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 10000')

const insertStaging = db.prepare(
  'INSERT INTO staging (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
)
// index_col 2 = tool_text: the attribution production computes for an
// auto-capture tool row (fts-columns.ts). Content stays under the codec's
// 512-byte floor so plain TEXT is exactly the row shape production
// stores for it — no re-implemented encoder in this helper.
const insertNode = db.prepare(
  'INSERT INTO nodes (node_id, tree_id, content, created_at, updated_at, metadata_json, index_col) VALUES (?, ?, ?, ?, ?, ?, 2)',
)
// The contentless FTS5 index is maintained MANUALLY in the same
// transaction as the nodes row (store.ts insertNode) — a crash tear
// between the two tables is the likeliest real corruption surface, so
// omitting this write would certify a weaker shape than production's
// (third-pass review).
const insertFts = db.prepare(
  "INSERT INTO nodes_fts(rowid, user_text, assistant_text, tool_text, note_text) VALUES (?, '', '', ?, '')",
)

// Payload long enough that a torn write would be visible as a truncated
// row; the END marker is the tear detector.
const pair = db.transaction((i) => {
  const content = `crash event ${i} :: ${'payload '.repeat(40)}:: END-${i}`
  insertStaging.run('crash-session', 'user', content, 1_700_000_000 + i)
  const r = insertNode.run(
    `crash-node-${i}`, treeId, content, 1_700_000_000 + i, 1_700_000_000 + i,
    JSON.stringify({ source: 'auto-capture', role: 'tool', session_id: 'crash-session' }),
  )
  insertFts.run(r.lastInsertRowid, content)
})

let i = 0
for (;;) {
  pair(i)
  process.stdout.write(`committed ${i}\n`)
  i++
}
