/**
 * The curated unique indexes, spelled once (D164, D221, D391).
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

/**
 * A ticket-door worker's curated dedup is its own lane's (D391): its lane
 * is its whole session, so two workers, or a worker and the main session,
 * writing the same text leave two rows, one in each lane. Such a row takes
 * this dedup class, which the curated index above does not cover (its
 * predicate names `'curated'` alone, so it needed no rebuild), and the
 * worker index below keys it by its session as well: a worker's own
 * repeat still dedups, within its session.
 *
 * The class is chosen at insert from the store's own stamp
 * (dedup-identity.ts dedupClassOf, isWorkerLaneStamp): `_writer_agent_id`
 * `worker` with `_writer_src` `declared`, which the store writes only from
 * the registry's worker registration (the tools door's resolveWriter for
 * the lane serve trusts, the library door's leg stamp), and a caller's copy
 * of either key is dropped at the insert tool. A hooks-door subagent leg
 * shares its parent's session and carries its own agent id, so it keeps
 * the curated class until `0.1.0-beta.5` (D392). Migration 033 adds the
 * index; no existing row changes class.
 */
export const WORKER_CURATED_CLASS = 'worker_curated'

export const WORKER_INDEX_WHERE = `dedup_class = '${WORKER_CURATED_CLASS}'`

export const WORKER_INDEX_DDL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_worker_curated_fp ON nodes(tree_id, session_key, fingerprint) WHERE ${WORKER_INDEX_WHERE};`
