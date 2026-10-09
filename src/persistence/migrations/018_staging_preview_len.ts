import type { Migration } from '../migrations.js'

// Index-cap expansion (2026-07-28 cap sweep): the FTS view of a tool event
// grows beyond the display preview, so the two boundaries that used to be
// one number (`index_len`) split.
//
// - `preview_len`: where the DISPLAY preview ends within the staged
//   content. The read side slices hits here so a single hit cannot flood
//   the caller's context, regardless of how much of the row is indexed.
// - `index_len` (existing, semantics widened): how far the FTS view
//   reaches. Pre-018 rows set it at the preview boundary; post-018 hooks
//   set it up to activeIndexCap(role). Prose hooks always stamp it;
//   post-tool-use stamps it only when load-bearing (JF-3: an event that
//   fits stages NULL — its whole content is the index text and recomputes
//   stably without a marker). Either way a new row is self-describing at
//   contentless-FTS recompute time — the legacy role-cap constants are
//   frozen and only ever recompute pre-018 rows.
//
// Plain ALTER TABLE ADD COLUMN: no rewrite, no backfill; old rows get NULL
// (readers fall back to index_len for display, exactly the old behavior).
// Hooks built against this schema fall back to the pre-018 column list —
// and pre-018 SEMANTICS (index_len at the preview boundary) — when the
// column is absent (JF-8); hooks never run migrations themselves.
const migration: Migration = {
  version: 18,
  kind: 'additive',
  description: 'Add staging.preview_len (display boundary, split from the widened index_len FTS boundary)',
  up(db) {
    // Guarded like 016: additive migrations must tolerate marker-rollback
    // re-application and minimal legacy fixtures without a staging table.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
      .get()
    if (!table) return
    const cols = db.prepare('PRAGMA table_info(staging)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'preview_len')) {
      db.exec('ALTER TABLE staging ADD COLUMN preview_len INTEGER;')
    }
  },
}

export default migration
