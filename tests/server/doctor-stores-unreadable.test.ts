/**
 * Third-pass review finding 3: an unreadable stores directory must not
 * read as a healthy empty one. Before the fix, every doctor section
 * degraded to its empty case (schema: green 'no stores yet'; backups:
 * silence), actively steering the user away from the permission problem
 * on a machine full of stores doctor could not enumerate. The dedicated
 * Store-directory row now carries the error, and the sections below
 * stay silent rather than claim.
 *
 * POSIX-only: chmod 000 does not remove Windows ACL read rights; root
 * bypasses permission checks entirely.
 */
import { mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterAll } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

import { redirectHome, storesDirIn } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-doctor-unread-'))
const restoreHome = redirectHome(fakeHome)
const storesDir = storesDirIn(fakeHome)

const { doctor } = await import('../../src/server/installer.js')
const { maxSupportedVersion } = await import('../../src/persistence/migrations/index.js')
const { SCHEMA_SQL } = await import('../../src/persistence/schema.js')

const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0

afterAll(() => {
  try { chmodSync(storesDir, 0o755) } catch { /* absent */ }
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe.skipIf(!posixNonRoot)('doctor on an unreadable stores directory (finding 3)', () => {
  it('errors on the Store-directory row and claims nothing downstream', async () => {
    // A real store exists inside — the machine is NOT empty.
    mkdirSync(join(storesDir, 'notes'), { recursive: true })
    const db = new BetterSqlite3(join(storesDir, 'notes', 'treecontext.db'))
    db.exec(SCHEMA_SQL)
    db.pragma(`user_version = ${maxSupportedVersion}`)
    db.close()
    chmodSync(storesDir, 0o000)

    let rows: Array<{ check: string; status: string; detail: string }>
    try {
      rows = await doctor()
    } finally {
      chmodSync(storesDir, 0o755)
    }

    const dirRow = rows.find((r) => r.check === 'Store directory')
    expect(dirRow).toBeDefined()
    expect(dirRow!.status).toBe('error')
    expect(dirRow!.detail).toContain('cannot be read')

    // The schema section must not assert a green empty state it cannot
    // know; silence defers to the error row above.
    const schemaRows = rows.filter((r) => r.check === 'Store schema')
    expect(schemaRows.every((r) => !r.detail.includes('no stores yet'))).toBe(true)
  })
})
