/**
 * The curated unique index, spelled once (D164, D221).
 *
 * Curated dedup is a partial unique index on (tree_id, fingerprint): two
 * curated rows of one lane with the same content cannot both exist, and
 * insertNode's ON CONFLICT target names this predicate. A handoff lane
 * (`session_key` behind the `handoff:` prefix, ./../handoff.ts) is outside
 * it: an imported entry is present or new by IDENTITY — its id, or a
 * back-pointer — never by content, so a teammate's chapter that happens to
 * read like one of the receiver's own still lands (D164: content only
 * where the file carries no identity).
 *
 * Every site that creates the index or asks who holds a curated slot uses
 * these strings — the DDL in migrations 023, 024 and 025, insertNode's
 * conflict target, and curatedHolder — so no rebuild can resurrect the
 * old, unpartitioned definition and the predicate the index enforces is
 * the one the holder lookup reads. `substr` rather than LIKE, so the
 * case_sensitive_like pragma cannot change what the index covers.
 */
export const CURATED_INDEX_WHERE =
  "dedup_class = 'curated' AND (session_key IS NULL OR substr(session_key, 1, 8) != 'handoff:')"

export const CURATED_INDEX_DDL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_curated_fp ON nodes(tree_id, fingerprint) WHERE ${CURATED_INDEX_WHERE};`
