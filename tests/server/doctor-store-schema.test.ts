/**
 * Doctor's store-schema check and crash reporting.
 *
 * Field report (0.0.10-beta, macOS): doctor printed every row [ok] on a
 * machine whose MCP server refused to start on every launch. Every check it
 * ran validated an installation artifact — config files, MCP registration,
 * hook scripts, interpreter — and none of them opened a store, so a store
 * left below the schema head by an older build was invisible to it.
 *
 * Own file because agents.ts computes AGENTS paths from homedir() at module
 * load: HOME must be redirected BEFORE the installer graph is imported, and
 * only file-level isolation guarantees that.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'

import { redirectHome, storesDirIn } from '../helpers/home.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'tc-doctor-schema-'))
// Before the dynamic imports below, and via every home variable rather than
// HOME alone: doctor resolves STORES_DIR/LOGS_DIR through os.homedir(), which
// ignores HOME on Windows — so a HOME-only redirect graded the real machine
// and every row this file looks for was simply absent.
const restoreHome = redirectHome(fakeHome)

const storesDir = storesDirIn(fakeHome)
const logsDir = join(fakeHome, '.treecontext', 'logs')

const { doctor } = await import('../../src/server/installer.js')
const { maxSupportedVersion } = await import('../../src/persistence/migrations/index.js')
const { SCHEMA_SQL } = await import('../../src/persistence/schema.js')
const { FATAL_PREFIX } = await import('../../src/debug.js')

/** A store an older (or newer) build would have left behind at `version`. */
function seedStore(name: string, version: number): void {
  const dir = join(storesDir, name)
  mkdirSync(dir, { recursive: true })
  const db = new BetterSqlite3(join(dir, 'treecontext.db'))
  db.exec(SCHEMA_SQL)
  db.pragma(`user_version = ${version}`)
  db.close()
}

function reset(): void {
  rmSync(storesDir, { recursive: true, force: true })
  rmSync(logsDir, { recursive: true, force: true })
  rmSync(join(fakeHome, '.treecontext', 'bindings.json'), { force: true })
  mkdirSync(storesDir, { recursive: true })
}

beforeEach(reset)
afterAll(() => {
  restoreHome()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('doctor: store schema', () => {
  it('flags a store left below the schema head, naming the destructive step', async () => {
    seedStore('legacy-home', 12)
    const row = (await doctor()).find((r) => r.check === 'Store schema')
    expect(row).toBeDefined()
    expect(row!.status).toBe('warn')
    expect(row!.detail).toContain('legacy-home')
    expect(row!.detail).toContain('v12')
    expect(row!.detail).toContain(`v${maxSupportedVersion}`)
    expect(row!.detail).toContain('destructive')
  })

  it('errors on a store newer than this build — the one case that cannot self-heal', async () => {
    seedStore('from-the-future', maxSupportedVersion + 7)
    const row = (await doctor()).find((r) => r.check === 'Store schema' && r.status === 'error')
    expect(row).toBeDefined()
    expect(row!.detail).toContain('newer than this build')
    expect(row!.fix).toMatch(/npm install -g treecontext/)
  })

  it('reports ok when every store is at head', async () => {
    seedStore('current', maxSupportedVersion)
    const row = (await doctor()).find((r) => r.check === 'Store schema')
    expect(row!.status).toBe('ok')
    expect(row!.detail).toContain(`v${maxSupportedVersion}`)
  })

  it('never migrates the store it inspects — doctor diagnoses, it does not repair', async () => {
    seedStore('untouched', 12)
    await doctor()
    const db = new BetterSqlite3(join(storesDir, 'untouched', 'treecontext.db'), { readonly: true })
    const v = (db.pragma('user_version') as Array<{ user_version: number }>)[0]!.user_version
    db.close()
    expect(v).toBe(12)
    // A read-only inspection must not leave WAL sidecars behind either.
    expect(readdirSync(join(storesDir, 'untouched'))).toEqual(['treecontext.db'])
  })

  // Shipped in 0.0.11-beta: naming the bound store used resolveStoreName,
  // which WRITES a binding on a miss — so running doctor anywhere quietly
  // registered that directory. The store-file assertion above passed
  // throughout, because the mutation landed in bindings.json instead.
  it('writes no binding for the directory it is run from', async () => {
    seedStore('present', 12)
    const bindings = join(fakeHome, '.treecontext', 'bindings.json')
    rmSync(bindings, { force: true })
    await doctor()
    expect(existsSync(bindings)).toBe(false)
  })

  it('names the bound store only when that store is actually on disk', async () => {
    seedStore('present', maxSupportedVersion)
    // A binding pointing at a store that no longer exists must not be
    // reported as though it were one of the stores just listed.
    mkdirSync(join(fakeHome, '.treecontext'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.treecontext', 'bindings.json'),
      JSON.stringify({ version: 1, projects: {} }),
    )
    const row = (await doctor()).find((r) => r.check === 'Store schema')
    expect(row!.status).toBe('ok')
    expect(row!.detail).not.toContain('this directory')
  })
})

describe('doctor: recent crashes', () => {
  it('surfaces a recorded fatal instead of leaving it in a log nobody reads', async () => {
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(
      join(logsDir, 'debug-2026-08-04T00-00-00-000Z-999.log'),
      `[treecontext:dbg +1ms] [config] loading\n${FATAL_PREFIX} +73ms] [serve] SchemaVersionError: store is newer\n  at runMigrations\n`,
    )
    const row = (await doctor()).find((r) => r.check === 'Recent crashes')
    expect(row).toBeDefined()
    expect(row!.status).toBe('error')
    expect(row!.detail).toContain('1 fatal error')
    expect(row!.detail).toContain('[serve] SchemaVersionError')
    // The machine prefix is dropped, the context tag is kept.
    expect(row!.detail).not.toContain('+73ms')
    expect(row!.fix).toContain('--dump-logs')
  })

  it('reports clean when logs exist with no fatals', async () => {
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'debug-2026-08-04T00-00-00-000Z-998.log'), '[treecontext:dbg +1ms] [config] loading\n')
    const row = (await doctor()).find((r) => r.check === 'Recent crashes')
    expect(row!.status).toBe('ok')
  })
})
