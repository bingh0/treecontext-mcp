import type { Migration } from '../migrations.js'

const migration: Migration = {
  version: 8,
  kind: 'additive',
  description: 'Add insert_generation column for activity-gated decay',
  up(db) {
    try {
      db.exec(`ALTER TABLE nodes ADD COLUMN insert_generation INTEGER;`)
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('duplicate column')) throw err
    }
  },
}

export default migration
