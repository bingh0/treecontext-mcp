/**
 * Step 1 (MVP lexical spec): MemoryStore interface + backend selection.
 * Covers AC1.1 (TreeContext conforms; capability narrowing),
 * AC1.2 (factory selects backend), AC1.4 (mode persistence + legacy/D7).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'
import type { Database } from '../src/persistence/database.js'
import { FlatStore } from '../src/flat-store.js'
import { createMemoryStore, resolveBackendMode } from '../src/memory-store-factory.js'
import type { MemoryStore } from '../src/memory-store.js'
import { getBackendMode, storeHasEmbeddingModel } from '../src/persistence/store.js'
import { SCHEMA_SQL } from '../src/persistence/schema.js'
import { migrations, maxSupportedVersion } from '../src/persistence/migrations/index.js'
import { currentSchemaVersion } from '../src/persistence/migrations.js'

// CreateMemoryStoreOptions.embedding is `unknown` post-deletion: the factory
// only passes it through (never calls it), so an opaque literal suffices.
function createProvider(): unknown {
  return { modelName: 'test-model', dim: 8 }
}

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tc-ms-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function openDb(name = 'store.db'): Database {
  return wrapBetterSqlite(new BetterSqlite3(join(tmpDir, name)))
}

describe('MemoryStore conformance (AC1.1)', () => {
  it('FlatStore is a MemoryStore', async () => {
    const store = await FlatStore.open({ database: openDb() })
    const asStore: MemoryStore = store
    expect(typeof asStore.insert).toBe('function')
    await store.close()
  })
})

describe('backend selection (AC1.2)', () => {
  it('new store, no embedder/backend → FlatStore (default-off)', async () => {
    const store = await createMemoryStore({ database: openDb() })
    expect(store).toBeInstanceOf(FlatStore)
    await store.close()
  })

  it('explicit tree backend refuses loudly — the tree era no longer ships (deletion phase 2026-07-25)', async () => {
    const db = openDb()
    await expect(
      createMemoryStore({ database: db, backend: 'tree', embedding: createProvider() }),
    ).rejects.toThrow(/no longer\s+ships|pre-deletion/)
    db.close()
  })
})

describe('mode persistence + legacy detection (AC1.4 / D7)', () => {
  it('persists resolved mode on init and preserves it on reopen', async () => {
    const db1 = openDb()
    const s1 = await createMemoryStore({ database: db1 }) // → lexical
    expect(getBackendMode(db1)).toBe('lexical')
    await s1.close()

    // Reopen with an embedder AVAILABLE but no explicit backend: the
    // recorded 'lexical' mode must win (D7 — existing store keeps mode).
    const db2 = openDb()
    const s2 = await createMemoryStore({ database: db2, embedding: createProvider() })
    expect(s2).toBeInstanceOf(FlatStore)
    await s2.close()
  })

  it('legacy tree store (embedding_model, no backend_mode) resolves to tree and refuses — never opened blind, never touched', async () => {
    // Simulate a pre-backend_mode tree store: schema present (via a
    // throwaway FlatStore open — it never records a mode; only the
    // factory does), embedding_model recorded, backend_mode absent —
    // what TreeContext.open used to leave behind.
    const setupStore = await FlatStore.open({ database: openDb('legacy.db'), ownsDatabase: true })
    await setupStore.close()
    const dbSetup = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, 'legacy.db')))
    dbSetup.exec(
      "INSERT INTO embedding_model (id, model_name, dim, pooling, normalize) VALUES (1, 'all-MiniLM-L6-v2', 384, 'mean', 1)",
    )
    dbSetup.close()

    const db = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, 'legacy.db')))
    expect(getBackendMode(db)).toBeNull()
    expect(storeHasEmbeddingModel(db)).toBe(true)
    expect(resolveBackendMode(db)).toBe('tree')

    await expect(createMemoryStore({ database: db })).rejects.toThrow(/no longer\s+ships|pre-deletion/)
    // Refusal is read-only: the store's rows and mode record are untouched.
    expect(storeHasEmbeddingModel(db)).toBe(true)
    db.close()
  })

  it('fresh store resolves to lexical', () => {
    const db = openDb('fresh.db')
    expect(getBackendMode(db)).toBeNull()
    expect(storeHasEmbeddingModel(db)).toBe(false)
    expect(resolveBackendMode(db)).toBe('lexical')
    db.close()
  })
})

// Field report (0.0.10-beta, macOS): a store left at schema 12 by an older
// build killed the MCP server on every startup — Claude Code surfaced only
// "-32000: Connection closed", and the debug log stopped dead at
// "[migration] pending migrations {count:7,destructive:1}".
//
// `serve` passes migrate:true (cli.ts) and FlatStore.open forwards it to
// Persistence.openLexical — but createMemoryStore sat between them and
// declared `migrate` without ever passing it on, so the 019 destructive
// gate rejected every pre-19 store and the process exited before stdio
// came up. The store stayed at 12, so the next start failed identically.
//
// Every prior factory test opened a FRESH database, and openLexical forces
// migrate:true when fresh — which is exactly why 934 tests stayed green.
// These bind against the far side: a store that already exists below 19.
describe('createMemoryStore forwards migrate: to the store it opens', () => {
  /** A store an older build would have left behind at `version`. */
  function seedStoreAt(version: number, name = 'legacy.db'): Database {
    const db = wrapBetterSqlite(new BetterSqlite3(join(tmpDir, name)))
    db.exec(SCHEMA_SQL) // base schema, user_version = 5
    for (const m of migrations.filter((x) => x.version > 5 && x.version <= version)) {
      m.up(db)
      db.pragma('user_version', m.version)
    }
    expect(currentSchemaVersion(db)).toBe(version)
    return db
  }

  it('migrate:true carries through the factory — a v12 store opens and reaches head', async () => {
    const db = seedStoreAt(12)
    const store = await createMemoryStore({ database: db, migrate: true })
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)
    await store.close()
  })

  it('migrate:false refuses — the flag is honoured, not ignored', async () => {
    // Was "without migrate the destructive gate still refuses". Owner ruling
    // 2026-08-05 inverted the default: a backup is taken and the ladder runs,
    // so ABSENCE of the flag no longer proves it is forwarded. An explicit
    // opt-out does, and it is the case that still matters — a read-only open
    // passes exactly this and cannot write.
    const db = seedStoreAt(12)
    await expect(createMemoryStore({ database: db, migrate: false })).rejects.toThrow(
      /requires destructive migration/,
    )
    expect(currentSchemaVersion(db)).toBe(12)
    db.close()
  })

  it('without the flag the store is migrated, not refused', async () => {
    const db = seedStoreAt(12)
    const store = await createMemoryStore({ database: db })
    expect(currentSchemaVersion(db)).toBe(maxSupportedVersion)
    await store.close?.()
    db.close()
  })
})
