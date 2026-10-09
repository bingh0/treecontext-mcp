import type { Migration } from '../migrations.js'
import { hasTable } from './guards.js'
import { runArbiterBackfill } from './arbiter-backfill.js'

// The arbiter backfill (store-as-arbiter amendment 8, final position
// after the G5 review): 021 lays the shape, this recomputes every
// row's arbiter columns — metadata-only columns stamped even for rows
// whose content cannot be decoded — resolves curated twins, seeds the
// window anchors, and (re)builds the curated and session indexes, so
// an upgrading store pays the whole-store decode exactly once and
// every interim-migrated store is healed by the same step.
// Deterministic and replay-idempotent by value.
const migration: Migration = {
  version: 23,
  kind: 'additive',
  description: 'The arbiter backfill: full column classification, twin resolution, anchor seeding, index builds',
  up(db) {
    if (!hasTable(db, 'nodes')) return
    runArbiterBackfill(db)
  },
}

export default migration
