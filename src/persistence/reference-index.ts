/**
 * The reverse index of references (D186), spelled once for the migration
 * that creates it and for anything that must recreate it.
 *
 * `node_refs(ref_id, node_id)`: one row per (referenced entry, referring
 * entry) pair, read by `ref_id` through the primary key. The rows are
 * derived from the referring entry's `metadata.refs` — a string id or an
 * array of ids — by triggers on `nodes`:
 *   - after insert: index the new row's refs;
 *   - after a metadata update that changed `$.refs`: re-index that row
 *     (a supersession trace or a reliance bump leaves `$.refs` alone and
 *     does not fire the body);
 *   - after delete: drop the row's own outgoing references. References TO
 *     a deleted entry stay — the referrers still name it, and readers join
 *     `nodes`, so a referrer that is gone is never shown.
 * A self-reference is not indexed. Non-text array members are ignored.
 *
 * A future migration that rebuilds `nodes` (the 12-step ALTER) drops these
 * triggers with the old table and must run this DDL again.
 */
const REFS_OF = (row: 'NEW' | 'OLD'): string =>
  `(CASE WHEN json_valid(${row}.metadata_json) THEN json_extract(${row}.metadata_json, '$.refs') END)`

const INDEX_ROW = `
    INSERT OR IGNORE INTO node_refs (ref_id, node_id)
      SELECT j.value, NEW.node_id FROM json_each(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END, '$.refs') j
       WHERE j.type = 'text' AND j.value != NEW.node_id;`

export const REFERENCE_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS node_refs (
    ref_id  TEXT NOT NULL,
    node_id TEXT NOT NULL,
    PRIMARY KEY (ref_id, node_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_node_refs_node ON node_refs(node_id);
  CREATE TRIGGER IF NOT EXISTS trg_node_refs_insert AFTER INSERT ON nodes
    WHEN ${REFS_OF('NEW')} IS NOT NULL
  BEGIN${INDEX_ROW}
  END;
  CREATE TRIGGER IF NOT EXISTS trg_node_refs_update AFTER UPDATE OF metadata_json ON nodes
    WHEN ${REFS_OF('OLD')} IS NOT ${REFS_OF('NEW')}
  BEGIN
    DELETE FROM node_refs WHERE node_id = OLD.node_id;${INDEX_ROW}
  END;
  CREATE TRIGGER IF NOT EXISTS trg_node_refs_delete AFTER DELETE ON nodes
  BEGIN
    DELETE FROM node_refs WHERE node_id = OLD.node_id;
  END;
`
