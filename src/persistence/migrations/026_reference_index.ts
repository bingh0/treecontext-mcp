import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { REFERENCE_INDEX_DDL } from '../reference-index.js'

// The reverse index of references (D186): an entry names the entries it
// responds to in `metadata.refs` (an id or a list of ids, git-style), and
// every read surface shows an entry's "referenced by" one hop deep. The
// forward pointer lives on the referring row and is never copied onto the
// target; this table is the store's reverse index of it, kept by triggers
// on `nodes` so every writer — the tools, ingestion, import, merge, the
// archive restore — maintains it without knowing it exists. The backfill
// reads the refs every existing row already carries. A new table, three
// triggers and one backfill that only reads `nodes`: additive.
const migration: Migration = {
  version: 26,
  kind: 'additive',
  description: 'Reverse index of metadata.refs (node_refs), kept by triggers on nodes',
  up(db) {
    if (!hasTable(db, 'nodes')) return
    db.exec(REFERENCE_INDEX_DDL)
    db.exec(`
      INSERT OR IGNORE INTO node_refs (ref_id, node_id)
        SELECT j.value, n.node_id FROM nodes n, json_each(n.metadata_json, '$.refs') j
         WHERE json_valid(n.metadata_json) AND json_type(n.metadata_json, '$.refs') IS NOT NULL
           AND j.type = 'text' AND j.value != n.node_id;
    `)
  },
}

export default migration
