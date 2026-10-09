import type { Migration } from '../migrations.js'

const migration: Migration = {
  version: 3,
  kind: 'additive',
  description: 'Add modal embedding columns and modal model metadata',
  up() {
    // Emptied 2026-07-29: everything this migration created was dead
    // tree-era weight, dropped for existing stores by migration 019
    // (019_drop_dead_tables.ts). The version number must stay on the
    // ladder — maxSupportedVersion derives from the last entry and
    // deleting a file would brick stores already past this version.
  },
}

export default migration