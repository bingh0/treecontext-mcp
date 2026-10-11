import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { echoReindexer, ECHO_REINDEX_PAGE } from '../echo-reindex.js'

// D261: a treecontext echo enters the index by its arguments alone. Since
// beta.1 every echo indexed up to the 8000-character tool view: a query
// echo its hits' previews, an insert echo its note again, a status echo
// its resume pointers. This re-stamps every echo a store already holds
// with the boundary the drain now stamps (the shared helper, so the two
// cannot drift) and re-indexes it, through the row-level routine the
// drain's echo heal shares (../echo-reindex.ts): the OLD index text is recomputed from
// the row's old stamp (the contentless-FTS delete form, in the row's
// immutable index_col), the new one inserted from the new stamp. Stored
// content is never touched. Runs inside the runner's one additive
// transaction, paged by rowid, so it lands with the version bump or not
// at all; the version makes it run once.
const migration: Migration = {
  version: 28,
  kind: 'additive',
  description: 'Re-stamp and re-index treecontext echoes by their arguments alone (D261)',
  up(db) {
    if (!hasTable(db, 'nodes') || !hasTable(db, 'nodes_fts')) return
    const reindex = echoReindexer(db, { skipHandoffLanes: false })
    let after = 0
    for (;;) {
      const r = reindex.pass(after, ECHO_REINDEX_PAGE)
      if (r.scanned === 0) break
      after = r.last
    }
  },
}

export default migration
