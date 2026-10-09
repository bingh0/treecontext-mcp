import type { Migration } from '../migrations.js'

// Superseded in place (G5 review, finding 2): interim builds of this
// migration ran an earlier body of the arbiter backfill, and the G5
// index swap was later — wrongly — retrofitted into already-applied
// 021. Editing shipped ladder steps cannot heal stores that already
// climbed them, so the whole pass moved to 023: upgraded (≤20),
// interim-021, and interim-022 stores alike run it there exactly once.
// This step remains as a version-number tombstone — a ladder position,
// once released to any store, is never renumbered.
const migration: Migration = {
  version: 22,
  kind: 'additive',
  description: 'Tombstone: the arbiter backfill moved to 023 (interim builds ran an earlier body here)',
  up() {
    /* no-op — see 023 */
  },
}

export default migration
