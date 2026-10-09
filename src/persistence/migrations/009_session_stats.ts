import type { Migration } from '../migrations.js'

const migration: Migration = {
  version: 9,
  kind: 'additive',
  description: 'Add session_stats and logistic_state tables for analytics persistence',
  up() {
    // Emptied 2026-07-29: everything this migration created was dead
    // tree-era weight, dropped for existing stores by migration 019
    // (019_drop_dead_tables.ts). The version number must stay on the
    // ladder — maxSupportedVersion derives from the last entry and
    // deleting a file would brick stores already past this version.
  },
}

export default migration
