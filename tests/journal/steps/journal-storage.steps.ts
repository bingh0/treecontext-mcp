import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import {
  runMigrations, currentSchemaVersion, type MigrationReport,
} from '../../../src/persistence/migrations.js'
import { migrations, maxSupportedVersion } from '../../../src/persistence/migrations/index.js'
import { MigrationRequiredError } from '../../../src/errors/index.js'
import { FlatStore } from '../../../src/flat-store.js'
import { createMemoryStore } from '../../../src/memory-store-factory.js'
import { IngestionLoop } from '../../../src/server/ingestion.js'
import { LeaseClient, leaseHolders, NS_LEASE_TTL_SECS, DRAIN_LEASE_TTL_SECS } from '../../../src/persistence/leases.js'
import { MAX_INGEST_ATTEMPTS } from '../../../src/persistence/capture-constants.js'
import { type World, T0, mcpOver, nsClaimHook, parseTool, openLiveStore, exportNode, rawAll } from '../world.js'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CLI_TS, nodeTsArgs, sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { loadConfigFile } from '../../../src/server/config.js'
import { readVerdict } from '../../../src/persistence/backup-verdict.js'

// ── journal-storage ─────────────────────────────────────────────────────


/**
 * The storage wave's world: the core `World` plus the before/after evidence
 * its durability scenarios carry between steps — a migration's own report,
 * the rows and bytes it must not have eaten, what the poison retry and the
 * failed sweep actually did, and what a SIGKILLed writer said it had
 * committed. Nothing outside this feature reads any of it.
 */
export interface StorageWorld extends World {
  /** Schema-migration scenario: the store as an older binary left it. */
  oldSchemaVersion?: number
  migrationReport?: MigrationReport
  /** Rows written before a migration, to prove it ate none of them. */
  preMigrationRows?: Array<{ id: string; content: string }>
  /** File size before migrating, to prove the VACUUM actually shrank it. */
  preMigrationBytes?: number
  /** Poison scenario: staging state while the dead-letter was also failing. */
  poisonBlocked?: { attempts: number; processed: number; gapNodes: number }
  /** Poison scenario: staging state once the dead-letter could be written. */
  poisonRetired?: { attempts: number; processed: number; gapNodes: number }
  poisonTicksToRetire?: number
  /** Over-budget scenario: what the failed reclaim actually did. */
  sweepOutcome?: { evicted: number; demoted: number }
  /** Crash scenario: event numbers the victim reported committed pre-kill. */
  crashCommitted?: number[]
  /** Crash scenario: integrity_check rows read through a fresh connection. */
  crashIntegrity?: Array<{ integrity_check: string }>
  /** Concurrent-sessions scenario: the second process's stdout protocol. */
  concurrentChildOut?: string
  /** D141 budget scenarios: the sandboxed home and project directory a
   *  real `serve` is spawned from, the store it opens, and its client. */
  budgetHome?: string
  budgetProject?: string
  budgetDb?: string
  budgetClient?: Client
  budgetStatus?: Record<string, unknown>
  /** Seeded demotable rows (id → stored byte length) the valve must spare. */
  budgetSeed?: Map<string, number>
  /** The cap-that-bites scenario: its raw handle, sprint shape and sweep. */
  sprintRaw?: BetterSqlite3.Database
  sprintSessions?: number
  sprintPer?: number
  sprintSweep?: { evicted: number; demoted: number }
  /** Additive-backup scenario: the store, its version and rows before, the
   *  rows a concurrent writer added in the window. */
  additive?: { path: string; from: number; seeded: string[]; late: string[]; report?: MigrationReport }
  /** Retention scenario: the archive file the valve wrote a whole session
   *  to, in export format, carried from the write to the restore that
   *  reads it back. (It was `attachedPath` in the core World, where it
   *  collided with journal-media's meaning of that name — its own
   *  attached file — and so belonged to neither wave.) */
  archivePath?: string
}

export const storageDefiner = (reg: Registry<StorageWorld>): void => {
  const autoMeta = (session: string, extra?: Record<string, unknown>) => ({
    source: 'auto-capture',
    role: 'tool',
    session_id: session,
    ...extra,
  })

  /** Open a FRESH store with tight retention knobs so the valve is
   *  drivable (never reuses a prior Given's dir — the knobs must apply
   *  from first open). */
  async function openValveStore(w: StorageWorld, opts: { maxSessions?: number; maxStoreBytes?: number }): Promise<FlatStore> {
    delete w.dir
    delete w.dbPath
    return openLiveStore(w, {
      retentionInterval: 1_000_000, // manual sweeps only — the When drives the valve
      ...opts,
    })
  }

  // S1: byte-for-byte + zstd at rest.
  const FULL_EVENT = `Tool: Bash — full test log\n${'assertion output with distinctive tokens like quasar-8843\n'.repeat(40)}`
  reg.define(/^a full-fidelity event captured and ingested$/, async (w: StorageWorld) => {
    await openLiveStore(w)
    w.nodeId = (
      await w.store!.insert(FULL_EVENT, { metadata: autoMeta('s-zstd', { _index_len: 500 }) })
    ).nodeId
  })
  reg.define(/^its node is exported$/, (w: StorageWorld) => {
    w.exported = { nodes: [exportNode(w, w.nodeId!)] }
  })
  reg.define(/^the content matches what the hook staged, byte for byte$/, (w: StorageWorld) => {
    expect(w.exported!.nodes[0]!['content']).toBe(FULL_EVENT)
  })
  reg.define(/^the stored blob is zstd-compressed at rest$/, (w: StorageWorld) => {
    const [row] = rawAll<{ content: unknown }>(w, 'SELECT content FROM nodes WHERE node_id = ?', w.nodeId!)
    expect(row, 'row missing').toBeTruthy()
    expect(Buffer.isBuffer(row!.content), 'content stored as plain text, not an encoded blob').toBe(true)
    expect((row!.content as Buffer)[0], 'codec flag is not zstd').toBe(0x01)
  })

  // S2: index is a bounded view; the journal is the record.
  const HEAD_TOKEN = 'nebula-head-4471'
  const TAIL_TOKEN = 'krypton-tail-9925'
  reg.define(/^an oversized full-fidelity event staged by the hook$/, (w: StorageWorld) => {
    const head = `Tool: WebFetch — findings mention ${HEAD_TOKEN} early. `
    const content = head + 'padding sentence for bulk. '.repeat(80) + `Closing line mentions ${TAIL_TOKEN} only here.`
    w.descriptions = [content, head]
  })
  reg.define(/^it is ingested into the journal$/, async (w: StorageWorld) => {
    await openLiveStore(w)
    w.nodeId = (
      await w.store!.insert(w.descriptions![0]!, {
        metadata: autoMeta('s-bounded', { _index_len: w.descriptions![1]!.length }),
      })
    ).nodeId
  })
  reg.define(/^the FTS index holds only the recorded bounded view$/, (w: StorageWorld) => {
    // The fts5 table is contentless — column reads return '' by design —
    // so the index is probed the only way it answers: MATCH, on a raw
    // readonly handle, no store code in the loop.
    const matches = (token: string) =>
      rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?', `"${token}"`)[0]!.n
    expect(matches(HEAD_TOKEN), 'preview token missing from the index').toBeGreaterThan(0)
    expect(matches(TAIL_TOKEN), 'tail token leaked into the index').toBe(0)
  })
  reg.define(/^ranking is computed from that view alone$/, async (w: StorageWorld) => {
    const headHits = await w.store!.query(HEAD_TOKEN, { topK: 5 })
    const tailHits = await w.store!.query(TAIL_TOKEN, { topK: 5 })
    expect(headHits.map((r) => r.nodeId)).toContain(w.nodeId)
    expect(tailHits.map((r) => r.nodeId)).not.toContain(w.nodeId)
  })
  reg.define(/^the recorded boundary says exactly where the indexed view ends$/, (w: StorageWorld) => {
    const [row] = rawAll<{ metadata_json: string }>(w, 'SELECT metadata_json FROM nodes WHERE node_id = ?', w.nodeId!)
    const len = (JSON.parse(row!.metadata_json) as Record<string, unknown>)['_index_len']
    expect(len).toBe(`Tool: WebFetch — findings mention ${HEAD_TOKEN} early. `.length)
  })

  // S3: bounded growth — whole-session eviction, newest protected.
  reg.define(/^a store pushed past its retention caps by continued capture$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 2, maxStoreBytes: 8_192 })
    w.nodeIds = []
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        w.nodeIds.push(
          (
            await w.store!.insert(`session ${s + 1} event ${i + 1}: ${'bulk payload text '.repeat(60)}`, {
              metadata: autoMeta(`valve-s${s + 1}`),
              createdAt: T0 + s * 1000 + i * 10,
            })
          ).nodeId,
        )
      }
    }
  })
  reg.define(/^the valve runs$/, (w: StorageWorld) => {
    w.store!.retentionSweep()
  })
  reg.define(/^the store returns under its caps$/, (w: StorageWorld) => {
    const [row] = rawAll<{ total: number | null }>(w, 'SELECT SUM(LENGTH(content)) AS total FROM nodes')
    expect(row!.total ?? 0).toBeLessThanOrEqual(8_192)
  })
  reg.define(/^eviction removes oldest whole sessions, never fragments of one$/, (w: StorageWorld) => {
    const counts = new Map<string, number>()
    for (const r of rawAll<{ metadata_json: string }>(w, 'SELECT metadata_json FROM nodes')) {
      const s = (JSON.parse(r.metadata_json) as Record<string, string>)['session_id']!
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    // Evicted sessions vanish entirely; surviving sessions keep all 5 rows.
    expect(counts.get('valve-s1')).toBeUndefined()
    expect(counts.get('valve-s2')).toBeUndefined()
    expect(counts.get('valve-s3')).toBe(5)
    expect(counts.get('valve-s4')).toBe(5)
  })
  reg.define(/^the newest session is never evicted$/, (w: StorageWorld) => {
    const [row] = rawAll<{ n: number }>(
      w,
      "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.session_id') = 'valve-s4'",
    )
    expect(row!.n).toBe(5)
  })

  // S4: curated synthesis outlives auto-captured bulk.
  const CURATED = 'DECISION: keep the valve session-granular — fragments would hole the window'
  reg.define(/^a store under budget pressure holding curated notes and auto-captured events$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 10, maxStoreBytes: 4_096 })
    w.nodeId = (await w.store!.insert(CURATED, { metadata: { type: 'decision' }, createdAt: T0 })).nodeId
    w.nodeIds = []
    for (let i = 0; i < 6; i++) {
      // Incompressible bulk: repetitive filler zstd-compresses below the
      // budget and the pressure never arrives; random hex stays ~1:1.
      w.nodeIds.push(
        (
          await w.store!.insert(`auto bulk ${i + 1}: ${randomBytes(2000).toString('hex')}`, {
            metadata: autoMeta('bulk-session', { _index_len: 40 }),
            createdAt: T0 + 100 + i * 10,
          })
        ).nodeId,
      )
    }
  })
  reg.define(/^the valve evicts$/, (w: StorageWorld) => {
    w.store!.retentionSweep()
  })
  reg.define(/^auto-captured bulk is demoted to archive before curated notes and active plans$/, (w: StorageWorld) => {
    // The curated note — OLDER than every auto row — survives byte-for-byte…
    expect(exportNode(w, w.nodeId!)['content']).toBe(CURATED)
    // …while auto bulk got demoted (stripped to its index text) to make
    // the budget. This world names no archive dir, so the store's default
    // applies (`archive/` beside the database file, flat-store.ts), and
    // demotion writes its archive file before it shrinks, as the
    // 2026-07-31 ruling requires; a store with no archive destination
    // would demote nothing. This step checks only that demotion fired;
    // the archive-file form is pinned below by the tombstone/archive
    // scenarios.
    const demoted = rawAll<{ metadata_json: string }>(w, 'SELECT metadata_json FROM nodes').filter(
      (r) => (JSON.parse(r.metadata_json) as Record<string, unknown>)['_demoted'] === true,
    )
    expect(demoted.length).toBeGreaterThan(0)
  })

  // S5: vacuum reclaims disk.
  reg.define(/^a store holding months of bulky sessions$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 1, maxStoreBytes: 64 * 1024 * 1024 })
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 10; i++) {
        await w.store!.insert(`vacuum filler s${s} i${i}: ${'x'.repeat(4000)} ${i}`, {
          metadata: autoMeta(`vac-s${s}`),
          createdAt: T0 + s * 1000 + i * 10,
        })
      }
    }
    // Flush WAL so the main file carries the bulk, then record its size.
    const raw = new BetterSqlite3(w.dbPath!)
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    w.descriptions = [String(statSync(w.dbPath!).size)]
  })
  reg.define(/^retention evicts most of them$/, (w: StorageWorld) => {
    w.store!.retentionSweep() // evicts 4 of 5 sessions → >25% dead space → VACUUM
  })
  reg.define(/^the file on disk shrinks once free space crosses the vacuum threshold$/, (w: StorageWorld) => {
    const before = Number(w.descriptions![0])
    const after = statSync(w.dbPath!).size
    expect(after, `file did not shrink (before ${before}, after ${after})`).toBeLessThan(before)
  })

  // S7: eviction archives — never destroys.
  reg.define(/^a session about to be evicted by session-count retention$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 1 })
    w.descriptions = [
      'old session finding: the tokenizer drops NUL separators',
      'old session finding: the cache key needed the dialect version',
    ]
    w.nodeIds = []
    for (let i = 0; i < w.descriptions.length; i++) {
      w.nodeIds.push(
        (await w.store!.insert(w.descriptions[i]!, { metadata: autoMeta('arch-old'), createdAt: T0 + i * 10 })).nodeId,
      )
    }
    await w.store!.insert('newer session keeps the valve away from the present', {
      metadata: autoMeta('arch-new'),
      createdAt: T0 + 1000,
    })
  })
  reg.define(/^the whole session is written to an archive file in export format first$/, (w: StorageWorld) => {
    const dir = join(w.dir!, 'archive')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    w.archivePath = join(dir, files[0]!)
    const parsed = JSON.parse(readFileSync(w.archivePath, 'utf8')) as { version: number; nodes: Array<{ content: string }> }
    expect(parsed.version).toBe(1)
    expect(parsed.nodes.map((n) => n.content)).toEqual(expect.arrayContaining(w.descriptions!))
  })
  reg.define(/^importing that archive into a store restores the session verbatim$/, async (w: StorageWorld) => {
    const dir2 = mkdtempSync(join(tmpdir(), 'tc-journal-restore-'))
    w.defer(() => rmSync(dir2, { recursive: true, force: true }))
    const restore = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir2, 'restore.db'))),
      ownsDatabase: true,
    })
    w.defer(() => restore.close())
    await restore.importJson(readFileSync(w.archivePath!, 'utf8'))
    for (let i = 0; i < w.nodeIds!.length; i++) {
      const node = (JSON.parse(restore.exportJson({ nodeId: w.nodeIds![i]! })) as { nodes: Array<{ content: string }> }).nodes[0]!
      expect(node.content).toBe(w.descriptions![i])
    }
  })

  // S8: tombstone + the load-bearing ordering.
  reg.define(/^an old session and a newer one under a session cap of one$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 1 })
    await w.store!.insert('archived era note: the runner decision was ratified here', {
      metadata: autoMeta('tomb-old'),
      createdAt: T0,
    })
    await w.store!.insert('present era note: the binding phase is live', {
      metadata: autoMeta('tomb-new'),
      createdAt: T0 + 500,
    })
  })
  reg.define(/^a tombstone records that the session existed and where its archive lives$/, (w: StorageWorld) => {
    const rows = rawAll<{ content: unknown; metadata_json: string }>(
      w,
      "SELECT content, metadata_json FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1",
    )
    expect(rows).toHaveLength(1)
    const meta = JSON.parse(rows[0]!.metadata_json) as Record<string, unknown>
    expect(meta['_archived_session']).toBe('tomb-old')
    expect(existsSync(meta['_archive_path'] as string), 'tombstone points at a missing archive').toBe(true)
  })
  reg.define(/^the ordering is archive written, then tombstone, then deletion$/, async (w: StorageWorld) => {
    // Falsifiable via fault injection: a valve that cannot write its
    // archive must leave the session intact and write NO tombstone —
    // deletion gated on the archive is the observable form of the order.
    const dir = mkdtempSync(join(tmpdir(), 'tc-journal-order-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'order.db')
    const archiveDir = join(dir, 'archive')
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
      ownsDatabase: true,
      retentionInterval: 1_000_000,
      maxSessions: 1,
      archiveDir,
    })
    w.defer(() => store.close())
    await store.insert('evictable ordering row', { metadata: autoMeta('ord-old'), createdAt: T0 })
    await store.insert('protected ordering row', { metadata: autoMeta('ord-new'), createdAt: T0 + 100 })
    // Fault injection by SHAPE, not by permission: a regular file sits where
    // the archive directory has to be, so every write beneath it fails with
    // ENOTDIR. The previous form chmod'ed the directory to 0o555, which is a
    // no-op on Windows — NTFS has no POSIX permission bits, so the archive
    // write SUCCEEDED there, `failed` stayed false, and this scenario reported
    // that the valve had evicted without archiving when it had done no such
    // thing. A file-in-the-way denies the write on every platform.
    writeFileSync(archiveDir, 'not a directory\n')
    let failed = false
    try {
      store.retentionSweep()
    } catch {
      failed = true
    }
    rmSync(archiveDir, { force: true })
    expect(failed, 'the valve evicted without being able to archive').toBe(true)
    const raw = new BetterSqlite3(dbPath, { readonly: true })
    try {
      const count = (sql: string) => (raw.prepare(sql).get() as { n: number }).n
      expect(count("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1")).toBe(0)
      expect(count('SELECT COUNT(*) AS n FROM nodes')).toBe(2) // over-honest: everything intact
    } finally {
      raw.close()
    }
    // With the archive writable, the same sweep completes end to end.
    store.retentionSweep()
    const raw2 = new BetterSqlite3(dbPath, { readonly: true })
    try {
      const tombs = (raw2.prepare("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1").get() as { n: number }).n
      expect(tombs).toBe(1)
    } finally {
      raw2.close()
    }
  })

  // S8b: eviction refuses when it cannot archive (bound via an
  // archiveless in-memory store — no db path ⇒ no default archive dir).
  reg.define(/^a store past its session cap with no archive destination available$/, async (w: StorageWorld) => {
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(':memory:')),
      ownsDatabase: true,
      maxSessions: 1,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.store = store
    await store.insert('refusal-era old row', { metadata: autoMeta('refuse-old'), createdAt: T0 })
    await store.insert('refusal-era new row', { metadata: autoMeta('refuse-new'), createdAt: T0 + 1000 })
  })
  reg.define(/^no session is deleted$/, (w: StorageWorld) => {
    const nodes = (JSON.parse(w.store!.exportJson()) as { nodes: Array<{ content: string }> }).nodes
    expect(nodes.map((n) => n.content)).toEqual(
      expect.arrayContaining(['refusal-era old row', 'refusal-era new row']),
    )
  })

  // S9: only an explicit command destroys.
  reg.define(/^a store wired for months of capture under tight caps$/, async (w: StorageWorld) => {
    // Both destruction paths must actually run: a tight byte budget so the
    // demotion valve fires (the original fixture inherited the 64MB default
    // and demotion never ran — the hole the 2026-07-31 adversarial review
    // caught), and DEMOTABLE row shapes — full-view user prose above the
    // demotion floor, incompressible so the codec can't shrink it under
    // budget. Marker-less tool rows are unshrinkable by design, so a
    // tool-only fixture can't exercise demotion at any budget.
    await openValveStore(w, { maxSessions: 1, maxStoreBytes: 8_192 })
  })
  reg.define(/^valves, vacuums, and migrations run again and again over the months$/, async (w: StorageWorld) => {
    w.descriptions = []
    for (let sess = 0; sess < 4; sess++) {
      for (let i = 0; i < 6; i++) {
        const prose = i % 2 === 0
        const body = prose ? randomBytes(2400).toString('base64') : randomBytes(300).toString('hex')
        const c = `months item s${sess}i${i}: ${body}`
        w.descriptions.push(c)
        await w.store!.insert(c, {
          metadata: prose
            ? autoMeta(`months-s${sess}`, { role: 'user', _index_len: c.length })
            : autoMeta(`months-s${sess}`),
          createdAt: T0 + sess * 1000 + i * 10,
        })
      }
      w.store!.retentionSweep() // the valve runs again and again over the months
    }
  })
  reg.define(/^every entry ever captured is either live, or archived with a tombstone$/, (w: StorageWorld) => {
    const archiveDir = join(w.dir!, 'archive')
    const archived = readdirSync(archiveDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => (JSON.parse(readFileSync(join(archiveDir, f), 'utf8')) as { nodes: Array<{ content: string }> }).nodes.map((n) => n.content))
    const liveRows = rawAll<{ content: unknown; metadata_json: string | null }>(
      w,
      'SELECT content, metadata_json FROM nodes',
    ).map((r) => ({
      content: decodeContent(r.content as string | Buffer | null),
      meta: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
    }))
    const tombSessions = new Set(
      rawAll<{ metadata_json: string }>(w, "SELECT metadata_json FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1").map(
        (r) => (JSON.parse(r.metadata_json) as Record<string, unknown>)['_archived_session'],
      ),
    )
    for (const c of w.descriptions!) {
      const isLive = liveRows.some((r) => r.content === c) // exact match — a silent stump fails it
      const isArchived = archived.includes(c)
      expect(isLive || isArchived, `entry lost with no archive: ${c.slice(0, 24)}…`).toBe(true)
      if (!isLive) {
        // Not live in full ⇒ the loss must be on the record: either the
        // whole session was evicted behind a tombstone, or the row was
        // demoted and its surviving stump itself names the loss
        // (_demoted + _full_len + _archive_path).
        const sess = `months-s${/ s(\d)i/.exec(c)![1]}`
        const stump = liveRows.find((r) => r.meta?.['_demoted'] === true && c.startsWith(r.content))
        const stumpHonest =
          stump !== undefined &&
          stump.meta?.['_full_len'] === c.length &&
          typeof stump.meta?.['_archive_path'] === 'string'
        expect(
          tombSessions.has(sess) || stumpHonest,
          `entry gone with neither tombstone nor demotion record: ${c.slice(0, 24)}…`,
        ).toBe(true)
      }
    }
  })
  // S9b: demotion archives before it shrinks (ruled 2026-07-31).
  reg.define(/^a store over its byte budget holding demotable full-view prose$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 10, maxStoreBytes: 2_048 })
    // Incompressible full-view user prose past the demotion floor — the
    // only row shape the byte valve can shrink.
    const c = `demotable prose landmark vermilion-3307 ${randomBytes(2400).toString('base64')}`
    w.descriptions = [c]
    w.nodeId = (
      await w.store!.insert(c, { metadata: autoMeta('s-demote-arch', { role: 'user', _index_len: c.length }) })
    ).nodeId
  })
  reg.define(/^the shrunk row records its loss and the full text is in a demotion archive$/, (w: StorageWorld) => {
    const c = w.descriptions![0]!
    const [row] = rawAll<{ content: unknown; metadata_json: string }>(
      w,
      'SELECT content, metadata_json FROM nodes WHERE node_id = ?',
      w.nodeId!,
    )
    const stump = decodeContent(row!.content as string | Buffer | null)
    expect(stump.length).toBeLessThan(c.length)
    expect(c.startsWith(stump)).toBe(true)
    const meta = JSON.parse(row!.metadata_json) as Record<string, unknown>
    expect(meta['_demoted']).toBe(true)
    expect(meta['_full_len']).toBe(c.length)
    const archivePath = meta['_archive_path']
    expect(typeof archivePath, 'demoted row does not name its archive').toBe('string')
    const archived = (JSON.parse(readFileSync(archivePath as string, 'utf8')) as { nodes: Array<{ content: string }> })
      .nodes
    expect(archived.some((n) => n.content === c), 'full text missing from the demotion archive').toBe(true)
  })

  reg.define(/^an explicit clear or delete command removes content with no archive$/, (w: StorageWorld) => {
    const archiveDir = join(w.dir!, 'archive')
    const filesBefore = readdirSync(archiveDir).length
    const res = w.store!.clear()
    expect(res.cleared).toBe(true)
    expect(rawAll<{ n: number }>(w, 'SELECT COUNT(*) AS n FROM nodes')[0]!.n).toBe(0)
    expect(readdirSync(archiveDir).length, 'explicit clear must not archive').toBe(filesBefore)
  })

  // S6: full disk fails loudly, corrupts nothing.
  reg.define(/^a store on a volume with no room left to grow$/, async (w: StorageWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'journal.db')
    const raw = new BetterSqlite3(w.dbPath)
    const store = await FlatStore.open({ database: wrapBetterSqlite(raw), ownsDatabase: true })
    w.defer(() => store.close())
    w.store = store
    w.nodeIds = [
      (await store.insert('committed fact one: the budget is 64MB by default')).nodeId,
      (await store.insert('committed fact two: WAL mode is on')).nodeId,
    ]
    // Clamp the page ceiling to the current allocation: the next write that
    // needs a page gets SQLITE_FULL — the same surface a full volume gives.
    const pages = raw.pragma('page_count', { simple: true }) as number
    raw.pragma(`max_page_count = ${pages}`)
  })
  reg.define(/^a capture attempts to write$/, async (w: StorageWorld) => {
    try {
      await w.store!.insert(`incoming capture that cannot fit: ${'y'.repeat(64_000)}`, {
        metadata: autoMeta('full-disk'),
      })
    } catch (err) {
      w.insertError = err
    }
  })
  reg.define(/^the write fails with an explicit error$/, (w: StorageWorld) => {
    expect(w.insertError, 'the write silently succeeded or silently vanished').toBeTruthy()
    expect(String(w.insertError)).toMatch(/full|disk/i)
  })
  reg.define(/^every previously committed entry remains intact and queryable$/, async (w: StorageWorld) => {
    const hits = await w.store!.query('committed fact', { topK: 5 })
    expect(hits.map((r) => r.nodeId)).toEqual(expect.arrayContaining(w.nodeIds!))
    expect(exportNode(w, w.nodeIds![0]!)['content']).toContain('budget is 64MB')
    expect(exportNode(w, w.nodeIds![1]!)['content']).toContain('WAL mode is on')
  })

  // S: schema changes never eat a store.
  //
  // Not a hypothetical on this machine: 39 of the owner's 41 stores sit below
  // schema 19, and migration #19 is DESTRUCTIVE, so every one of them reaches
  // the current schema only through the opt-in gate below. This scenario is
  // the thing standing between that gate working and 39 stores finding out
  // the hard way.
  //
  // The old store is built by REPLAYING THE REAL MIGRATION BODIES up to the
  // target version rather than by hand-writing a schema snapshot or by
  // rewinding user_version on a current database. A snapshot drifts from the
  // migrations it stands in for, and a rewind leaves today's columns in place
  // while claiming to be old — both make the migration run against a shape no
  // older binary ever produced, which is the one thing this scenario must not
  // do.
  reg.define(/^a database created by an older binary$/, (w: StorageWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'old.db')

    // 17 is the modal version among the owner's real stores, and it sits
    // below the destructive #19 — so it exercises both halves of the claim.
    w.oldSchemaVersion = 17
    const raw = new BetterSqlite3(w.dbPath)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })
    const db = wrapBetterSqlite(raw)
    for (const m of migrations.filter((x) => x.version <= w.oldSchemaVersion!)) {
      m.up(db)
    }
    raw.pragma(`user_version = ${w.oldSchemaVersion}`)
    expect(currentSchemaVersion(db), 'the fixture did not land at the old version')
      .toBe(w.oldSchemaVersion)

    // Content an older binary would have written, so "ate the store" is a
    // claim about rows and not merely about the version number moving.
    w.preMigrationRows = [
      { id: 'n-old-1', content: 'a decision recorded by the older binary' },
      { id: 'n-old-2', content: 'a second entry that must survive the upgrade' },
    ]
    const existing = raw.prepare('SELECT tree_id FROM trees LIMIT 1').get() as { tree_id?: number } | undefined
    const treeId = existing?.tree_id ?? Number(
      raw.prepare('INSERT INTO trees (namespace, ensemble_index, created_at) VALUES (?, ?, ?)')
        .run('project', 0, 0).lastInsertRowid,
    )
    const ins = raw.prepare(
      'INSERT INTO nodes (node_id, tree_id, content, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
    )
    for (const r of w.preMigrationRows) ins.run(r.id, treeId, r.content)

    // The tree-era tables have to be created BY HAND, and that is a fact
    // about the ladder rather than a shortcut: migration 019 emptied the
    // bodies of the migrations that used to create them (see its own
    // comment), so replaying 1..17 today produces a store WITHOUT them. A
    // replay alone therefore cannot reproduce a genuine pre-19 store — the
    // one thing the replay approach is otherwise good for. This DDL is
    // copied from a real v17 store on the owner's machine.
    raw.exec(`
      CREATE TABLE knn_index (
        key TEXT PRIMARY KEY, data BLOB NOT NULL, meta TEXT,
        updated_at REAL NOT NULL DEFAULT (unixepoch('now'))
      );
      CREATE TABLE flat_journal (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'journaling',
        content TEXT NOT NULL, embedding BLOB NOT NULL, created_at REAL NOT NULL,
        metadata_json TEXT, access_count INTEGER NOT NULL DEFAULT 0,
        evicted INTEGER NOT NULL DEFAULT 0, last_accessed_at REAL
      );
    `)

    // Tree-era DATA in those tables. Without it the fixture proves nothing
    // about reclaiming space: dropping empty tables frees almost no pages, so
    // a VACUUM assertion would pass whether or not the VACUUM ran. The
    // owner's real stores carry exactly this — a shadow trigram index with a
    // row per node, 65% of 630MB across 39 stores.
    const knn = raw.prepare('INSERT INTO knn_index (key, data, updated_at) VALUES (?, ?, 0)')
    const fj = raw.prepare(
      'INSERT INTO flat_journal (id, content, embedding, created_at) VALUES (?, ?, ?, 0)',
    )
    const blob = Buffer.alloc(16 * 1024, 7)
    for (let i = 0; i < 40; i++) {
      knn.run(`k-${i}`, blob)
      fj.run(`f-${i}`, `tree-era journal row ${i}`, blob)
    }
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    w.preMigrationBytes = statSync(w.dbPath).size
  })

  reg.define(/^a newer binary opens it$/, (w: StorageWorld) => {
    const raw = new BetterSqlite3(w.dbPath!)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })
    // No flags. This is the ordinary open a library consumer performs, and
    // the point of the ruling is that it now completes rather than demanding
    // an opt-in nothing but `serve` ever passed.
    w.migrationReport = runMigrations(wrapBetterSqlite(raw), {})
    raw.close()
  })

  reg.define(/^the legacy store is copied aside before anything destructive runs$/, (w: StorageWorld) => {
    const report = w.migrationReport!
    expect(report.backupPath, 'a destructive migration ran with no backup taken').toBeTruthy()
    expect(existsSync(report.backupPath!)).toBe(true)

    // A real store, not a file that merely exists: it opens, it still reports
    // the OLD schema version — which is what proves it was taken before and
    // not after — and its rows are unchanged.
    const bak = new BetterSqlite3(report.backupPath!, { readonly: true })
    w.defer(() => { try { bak.close() } catch { /* already closed */ } })
    // Raw pragma read, not the write-pragma wrapper: the backup is a
    // VACUUM INTO snapshot (pass-3 fix) in rollback-journal mode, and
    // wrapping it would try to flip journal_mode on a readonly handle.
    expect(bak.pragma('user_version', { simple: true }), 'the backup was taken AFTER migrating')
      .toBe(w.oldSchemaVersion)
    const inBackup = bak.prepare('SELECT node_id, content FROM nodes ORDER BY node_id').all() as
      Array<{ node_id: string; content: string }>
    expect(inBackup.map((r) => r.content)).toEqual(w.preMigrationRows!.map((r) => r.content))
    // And the tree-era tables the upgrade drops are still THERE in the copy.
    // The backup is the escape hatch, so it has to hold what was dropped.
    const held = bak.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('knn_index','flat_journal')",
    ).get() as { c: number }
    expect(held.c, 'the backup does not contain the tables the upgrade dropped').toBe(2)
    bak.close()
  })

  reg.define(/^every pending migration applies, additive and destructive alike$/, (w: StorageWorld) => {
    const report = w.migrationReport!
    expect(report.to).toBe(maxSupportedVersion)
    const kinds = new Set(report.applied.map((a) => a.kind))
    expect(kinds.has('additive'), 'no additive migration applied').toBe(true)
    expect(kinds.has('destructive'), 'no destructive migration applied').toBe(true)
    // Every pending version, none skipped and none left for later.
    expect(report.applied.map((a) => a.version)).toEqual(
      migrations.filter((m) => m.version > w.oldSchemaVersion!).map((m) => m.version),
    )

    const raw = new BetterSqlite3(w.dbPath!)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })
    expect(currentSchemaVersion(wrapBetterSqlite(raw))).toBe(maxSupportedVersion)
    const after = raw.prepare('SELECT node_id, content FROM nodes ORDER BY node_id').all() as
      Array<{ node_id: string; content: string }>
    expect(after.map((r) => r.content), 'the migration lost rows')
      .toEqual(w.preMigrationRows!.map((r) => r.content))
    raw.close()
  })

  reg.define(/^the space the dropped tables held is returned to the filesystem$/, (w: StorageWorld) => {
    const raw = new BetterSqlite3(w.dbPath!)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })

    const dead = raw.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('knn_index','flat_journal')",
    ).get() as { c: number }
    expect(dead.c, 'the destructive migration left its tables behind').toBe(0)

    // Their pages went back to the FILESYSTEM, not to SQLite's freelist.
    // This is what separates a real reclaim from a bare DROP: dropping a
    // table leaves the file exactly as large as it was, with the freed pages
    // parked for reuse. On the owner's machine that distinction was 65% of
    // 630MB — space a drop-without-VACUUM would not have returned.
    const free = raw.pragma('freelist_count', { simple: true }) as number
    expect(free, 'pages were freed but never vacuumed back').toBe(0)
    expect(statSync(w.dbPath!).size, 'the file never shrank')
      .toBeLessThan(w.preMigrationBytes!)
    raw.close()
  })

  reg.define(/^a store that cannot be written refuses rather than half-migrating$/, (w: StorageWorld) => {
    // A read-only open passes migrate:false (store.ts). It cannot write, so
    // the honest outcome is "migrations pending", not a half-applied ladder.
    // Run against a pristine copy of the OLD store — the one above is now
    // upgraded — which the backup conveniently is.
    const path = join(w.dir!, 'readonly-case.db')
    copyFileSync(w.migrationReport!.backupPath!, path)
    const raw = new BetterSqlite3(path)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })
    let err: unknown
    try {
      runMigrations(wrapBetterSqlite(raw), { migrate: false })
    } catch (e) { err = e }
    expect(err, 'an opted-out open migrated anyway').toBeInstanceOf(MigrationRequiredError)
    for (const m of migrations.filter((x) => x.version > w.oldSchemaVersion! && x.kind === 'destructive')) {
      expect(String(err)).toContain(`#${m.version}`)
    }
    expect(currentSchemaVersion(wrapBetterSqlite(raw)), 'the refusal still moved the schema')
      .toBe(w.oldSchemaVersion)
    raw.close()
  })


  // S: a poison event cannot wedge ingestion.
  //
  // Both helpers read through a SEPARATE connection rather than the store's
  // own: the claim is about what is DURABLE on disk, and a value read back
  // through the handle that wrote it can be true of the connection without
  // being true of the file.
  //
  // ingestion-fidelity.feature already binds three poison scenarios: the
  // three-attempt bound, a whole batch of poison self-healing, and the
  // dead-letter never embedding the payload. What none of them exercise is
  // the RETIREMENT-ORDERING clause this scenario owns — that a row is
  // retired only once its dead-letter record actually exists. That path runs
  // when the dead-letter insert fails for the SAME reason the row did, and
  // marking the row processed anyway would destroy a backlog while recording
  // no gap at all: silent loss dressed as a successful drain.
  reg.define(/^a staged event that fails ingestion repeatedly$/, async (w: StorageWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'poison.db')
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true,
    })
    w.defer(() => store.close())
    w.store = store

    const t = 1_700_000_000
    store.store.insertStaging({
      sessionId: 's-poison', role: 'user', priority: 1, timestamp: t,
      content: 'POISONROW an event whose ingestion fails deterministically',
    })
    // Healthy work queued behind it, so "drains past it" is a claim about a
    // real backlog rather than about an empty queue.
    for (let i = 0; i < 3; i++) {
      store.store.insertStaging({
        sessionId: 's-poison', role: 'user', priority: 1, timestamp: t + i + 1,
        content: `a healthy capture queued behind the poison row, number ${i}`,
      })
    }

    // Fault injection in the chmod tradition — a real SQLite abort on the
    // production insert path, no code seams.
    //
    // The condition matches the poison token alone, which blocks the row AND
    // its own dead-letter: the capture-gap node quotes a prefix of the failing
    // content, so it carries the token too. That is not a trick, it is the
    // shape of the real hazard — a dead-letter that fails for the same reason
    // its subject did.
    const raw = new BetterSqlite3(w.dbPath)
    try {
      raw.exec(
        'CREATE TRIGGER poison_block BEFORE INSERT ON nodes ' +
        "WHEN new.content LIKE '%POISONROW%' " +
        "BEGIN SELECT RAISE(ABORT, 'injected ingestion fault'); END",
      )
    } finally { raw.close() }
  })

  reg.define(/^the ingestion loop works the backlog$/, async (w: StorageWorld) => {
    const loop = new IngestionLoop(w.store!, { batchSize: 50 })
    const stagingRow = (): { attempts: number; processed: number } =>
      readStagingPoisonRow(w.dbPath!)

    // Phase A: the dead-letter cannot be written either. Run well past the
    // attempt bound so "it eventually gave up and dropped it" would show.
    for (let i = 0; i < MAX_INGEST_ATTEMPTS + 3; i++) await loop.ingestBatch()
    w.poisonBlocked = { ...stagingRow(), gapNodes: countCaptureGapNodes(w.dbPath!) }

    // Phase B: the dependency recovers — the capture-gap record can now land,
    // while the poison row itself still cannot. Same trigger idiom the
    // ingestion-fidelity binding uses.
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      raw.exec('DROP TRIGGER poison_block')
      raw.exec(
        'CREATE TRIGGER poison_block BEFORE INSERT ON nodes ' +
        "WHEN new.content LIKE '%POISONROW%' " +
        "AND COALESCE(json_extract(new.metadata_json, '$.source'), '') != 'capture-gap' " +
        "BEGIN SELECT RAISE(ABORT, 'injected ingestion fault'); END",
      )
    } finally { raw.close() }

    w.poisonTicksToRetire = 0
    for (let i = 0; i < 10; i++) {
      await loop.ingestBatch()
      w.poisonTicksToRetire++
      if (stagingRow().processed === 1) break
    }
    w.poisonRetired = { ...stagingRow(), gapNodes: countCaptureGapNodes(w.dbPath!) }
  })

  reg.define(/^it is retired to a dead-letter record after bounded attempts$/, (w: StorageWorld) => {
    expect(w.poisonRetired!.processed, 'the poison row never retired').toBe(1)
    expect(w.poisonRetired!.gapNodes, 'no capture-gap record was written').toBe(1)
    // Bounded: once the dead-letter could be written it took a single tick,
    // and the attempt counter is not still climbing.
    expect(w.poisonTicksToRetire, 'retirement took more than one recovered tick').toBe(1)
    expect(w.poisonRetired!.attempts).toBeGreaterThanOrEqual(MAX_INGEST_ATTEMPTS)
    // DELIBERATELY insensitive to the value of the bound — the tick count in
    // the When derives from the same constant, so raising MAX_INGEST_ATTEMPTS
    // does not fail this scenario. That is the right division: this charter
    // says "bounded attempts", and the specific three is pinned where the
    // charter says three (ingestion-fidelity.feature, plus journal-capture's
    // gap-marker scenario — verified by mutation that all four catch it).
    // Duplicating the number here would give two places to update and no
    // extra coverage.
  })

  reg.define(/^retirement happens only after the dead-letter record exists$/, (w: StorageWorld) => {
    // The clause this scenario exists for. While the dead-letter could not be
    // written, the row had already failed more than the bound — and stayed
    // QUEUED. A runner that retires on the attempt count alone would have
    // marked it processed here, with no record anywhere that the event ever
    // existed.
    expect(w.poisonBlocked!.attempts, 'the fixture never reached the attempt bound')
      .toBeGreaterThanOrEqual(MAX_INGEST_ATTEMPTS)
    expect(w.poisonBlocked!.gapNodes, 'a dead-letter record existed while it was meant to be failing').toBe(0)
    expect(w.poisonBlocked!.processed, 'the row was retired with no dead-letter record to show for it').toBe(0)
  })

  reg.define(/^the rest of the backlog continues to drain past it$/, async (w: StorageWorld) => {
    // The wedge this whole path exists to prevent: oldest-first fetch kept
    // returning the same failing rows forever, so nothing behind them ever
    // drained.
    expect(w.store!.store.countUnprocessedStaging(), 'the backlog is still wedged').toBe(0)
    const hits = await w.store!.query('healthy capture queued behind', { topK: 10 })
    const healthy = hits.filter((h) => h.content.includes('healthy capture queued behind'))
    expect(healthy.length, 'the rows behind the poison row never made it in').toBe(3)
  })

  reg.define(/^an older hook binary against a newer schema stages events without loss$/, (w: StorageWorld) => {
    // JF-8: hooks never run migrations (src/hooks/shared.ts). So a hook from
    // an older install, pointed at a store a newer server has already
    // upgraded, must still be able to STAGE — its write is the capture that
    // would otherwise be dropped on the floor while the user sees nothing.
    const raw = new BetterSqlite3(w.dbPath!)
    w.defer(() => { try { raw.close() } catch { /* already closed */ } })
    expect(currentSchemaVersion(wrapBetterSqlite(raw)), 'this step assumes the store is already upgraded')
      .toBe(maxSupportedVersion)

    // The column list an OLDER hook knows about — deliberately NOT the current
    // one. `index_len`, `attempts` and `preview_len` all arrived after this
    // spelling (migrations 16 and 18), so every one of them must carry a
    // default or an old hook's insert fails outright and the capture is lost.
    const staged = raw.prepare(
      'INSERT INTO staging (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    )
    expect(() => staged.run('s-old-hook', 'user', 'a capture written by an older hook binary', 0))
      .not.toThrow()

    const row = raw.prepare('SELECT content, attempts FROM staging WHERE session_id = ?')
      .get('s-old-hook') as { content: string; attempts: number } | undefined
    expect(row, 'the older hook staged nothing').toBeTruthy()
    expect(row!.content).toBe('a capture written by an older hook binary')
    // The dead-letter counter a newer schema added must default, not be NULL —
    // the drain compares it against a bound and NULL would never retire.
    expect(row!.attempts).toBe(0)
    raw.close()
  })

  // S: a store that cannot get under budget says so.
  //
  // Protection is exercised through the real predicate, all three ways it
  // guards a row: agent-authored curated notes, a decay-exempt capture,
  // and the newest session's absolute protection. The valve genuinely
  // RUNS — archive destination present, nothing refusing — and reclaims
  // nothing because everything it may touch is protected. The condition
  // must then be REPORTED at both surfaces: status().retention (the
  // gauge the valve itself steers by) and the MCP status panel's
  // storage_warning (the surface an agent actually reads). Never a
  // resolution by destroying protected rows — the counts prove it.
  reg.define(/^a store over budget where everything remaining is protected$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 10, maxStoreBytes: 2_048 })
    // Incompressible payloads (the curated-notes scenario's lesson):
    // repetitive filler compresses under the budget and the pressure
    // never arrives; random hex stays ~1:1.
    w.nodeIds = [
      (await w.store!.insert(
        `DECISION: agent-authored synthesis, protected by authorship — ${randomBytes(1200).toString('hex')}`,
        { metadata: { type: 'decision' }, createdAt: T0 },
      )).nodeId,
      (await w.store!.insert(
        `pinned capture in an old session, protected by decay_exempt — ${randomBytes(1200).toString('hex')}`,
        { metadata: autoMeta('overbudget-s1'), decayExempt: true, createdAt: T0 + 10 },
      )).nodeId,
      (await w.store!.insert(
        `capture in the newest session, protected absolutely — ${randomBytes(1200).toString('hex')}`,
        { metadata: autoMeta('overbudget-s2'), createdAt: T0 + 20 },
      )).nodeId,
    ]
    // TreeStatus.retention is optional for legacy payloads; the lexical
    // store always reports it, so its absence is a failure, not a skip.
    const budget = w.store!.status().retention
    expect(budget, 'the lexical store must report a retention gauge').toBeDefined()
    expect(budget!.overBudget, 'the Given must actually be over budget').toBe(true)
  })
  reg.define(/^the valve runs and fails to reclaim$/, (w: StorageWorld) => {
    const gauge = (): { n: number; bytes: number } =>
      rawAll<{ n: number; bytes: number }>(
        w, 'SELECT COUNT(*) AS n, SUM(LENGTH(CAST(content AS BLOB))) AS bytes FROM nodes',
      )[0]!
    const before = gauge()
    w.sweepOutcome = w.store!.retentionSweep()
    // "Fails to reclaim" is verified, not assumed: the valve took
    // nothing, demoted nothing, and every byte survived.
    expect(w.sweepOutcome).toEqual({ evicted: 0, demoted: 0 })
    expect(gauge()).toEqual(before)
  })
  reg.define(/^status reports the condition instead of staying silent$/, async (w: StorageWorld) => {
    const st = w.store!.status()
    expect(st.retention, 'the lexical store must report a retention gauge').toBeDefined()
    expect(st.retention!.overBudget).toBe(true)
    expect(st.retention!.storeBytes).toBeGreaterThan(st.retention!.budgetBytes)

    const client = await mcpOver(w)
    const panel = parseTool(await client.callTool({ name: 'treecontext_status', arguments: {} }))
    const storage = panel['storage'] as { over_budget: boolean; store_bytes: number; budget_bytes: number }
    expect(storage.over_budget).toBe(true)
    expect(typeof panel['storage_warning'], 'the panel must warn in words, not only in numbers').toBe('string')
    expect(panel['storage_warning'] as string).toContain('protected')
  })

  // S: a crash mid-write never corrupts the store.
  //
  // A REAL victim: a separate node process (tests/helpers/crash-writer.cjs)
  // hammering capture/ingestion-shaped transactions — staging row + nodes
  // row, committed atomically — under the production pragmas (WAL,
  // synchronous=NORMAL), SIGKILLed while its loop runs flat out. No code
  // seams, no mocks: the kill lands wherever it lands, which is the
  // fidelity the charter's power-loss ruling asks for. What SIGKILL is
  // allowed to cost is the not-yet-committed tail; what it may never cost
  // is a committed transaction (the OS survives a process kill) or the
  // store's integrity.
  reg.define(/^a process killed during capture, ingestion, or eviction$/, async (w: StorageWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'crash.db')
    // A real store with a pre-crash committed entry that must survive.
    const pre = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true,
    })
    await pre.insert('pre-crash sentinel: the journal that existed before the victim ran', {
      metadata: { type: 'note' }, createdAt: T0,
    })
    pre.close()
    const [tree] = rawAll<{ tree_id: number }>(w, 'SELECT tree_id FROM trees LIMIT 1')

    const helper = fileURLToPath(new URL('../../helpers/crash-writer.cjs', import.meta.url))
    const child = spawn(process.execPath, [helper, w.dbPath, String(tree!.tree_id)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const committed: number[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const bail = setTimeout(
          () => reject(new Error(`victim committed only ${committed.length} before the deadline`)), 30_000)
        let buffer = ''
        child.stdout!.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const m = /^committed (\d+)$/.exec(buffer.slice(0, nl))
            buffer = buffer.slice(nl + 1)
            if (m) committed.push(Number(m[1]))
          }
          // Kill mid-stream: the loop is still running flat out when this
          // fires — there is no quiescing, that is the point.
          if (committed.length >= 25) { clearTimeout(bail); resolve() }
        })
        child.on('error', (err) => { clearTimeout(bail); reject(err) })
      })
    } finally {
      // The victim never exits on its own — the kill must survive every
      // failure path or a slow-CI bail leaks an infinite-loop process
      // hammering unlinked inodes forever (third-pass review).
      child.kill('SIGKILL')
    }
    await once(child, 'exit')
    w.crashCommitted = committed
    // The recovery in the Then must be real: the victim left WAL residue.
    expect(existsSync(`${w.dbPath}-wal`), 'no -wal file — nothing for recovery to recover').toBe(true)
  })
  reg.define(/^the next session opens the store$/, async (w: StorageWorld) => {
    // Integrity through a fresh raw connection first — the durable file,
    // not any surviving handle.
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      w.crashIntegrity = raw.pragma('integrity_check') as Array<{ integrity_check: string }>
    } finally {
      raw.close()
    }
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)), ownsDatabase: true,
    })
    w.defer(() => store.close())
    w.store = store
  })
  reg.define(/^the database opens clean under WAL recovery$/, async (w: StorageWorld) => {
    expect(w.crashIntegrity).toEqual([{ integrity_check: 'ok' }])
    // The production open path serves, and pre-crash data survived it.
    const hits = await w.store!.query('pre-crash sentinel journal', { topK: 3 })
    expect(hits.some((h) => h.content.includes('pre-crash sentinel'))).toBe(true)
  })
  reg.define(/^every event is either fully present or fully absent, never half-written$/, (w: StorageWorld) => {
    const eventNo = (content: string): number => {
      const m = /^crash event (\d+) ::/.exec(content)
      expect(m, `a row that is not even prefix-whole: ${content.slice(0, 60)}`).toBeTruthy()
      return Number(m![1])
    }
    const nodes = rawAll<{ content: string }>(
      w, "SELECT content FROM nodes WHERE node_id LIKE 'crash-node-%' ORDER BY created_at",
    )
    const staged = rawAll<{ content: string }>(
      w, "SELECT content FROM staging WHERE session_id = 'crash-session' ORDER BY timestamp",
    )
    // 1. No torn rows: every surviving row carries its own end marker.
    for (const r of [...nodes, ...staged]) {
      expect(r.content, 'a half-written row survived the crash').toMatch(/:: END-(\d+)$/)
      expect(Number(/:: END-(\d+)$/.exec(r.content)![1])).toBe(eventNo(r.content))
    }
    // 2. Atomic pairs: the staging row and the nodes row of one event
    //    committed in one transaction — after the crash they exist
    //    together or not at all.
    const nodeSet = new Set(nodes.map((r) => eventNo(r.content)))
    const stagedSet = new Set(staged.map((r) => eventNo(r.content)))
    expect([...nodeSet].sort((a, b) => a - b)).toEqual([...stagedSet].sort((a, b) => a - b))
    // 3. A commit the victim REPORTED before the kill is durable — a
    //    process kill may cost the uncommitted tail, never a committed
    //    transaction.
    for (const i of w.crashCommitted!) {
      expect(nodeSet.has(i), `committed event ${i} vanished in the crash`).toBe(true)
    }
    expect(w.crashCommitted!.length).toBeGreaterThanOrEqual(25)
    // 4. The nodes↔FTS pair committed atomically too: the contentless
    //    index (written in the victim's same transaction, as production
    //    does) must agree with the surviving rows exactly — no ghost
    //    entries for rolled-back rows, no unindexed survivors. Checked
    //    through the search path because PRAGMA integrity_check cannot
    //    see a contentless-table desync (third-pass review).
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    let ftsRowids: Set<number>
    let nodeRowids: Set<number>
    try {
      // 'payload' is victim-only vocabulary — 'crash' would also match
      // the PRE-crash sentinel through the tokenizer.
      ftsRowids = new Set((raw.prepare(
        "SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'payload'",
      ).all() as Array<{ rowid: number }>).map((r) => r.rowid))
      nodeRowids = new Set((raw.prepare(
        "SELECT rowid FROM nodes WHERE node_id LIKE 'crash-node-%'",
      ).all() as Array<{ rowid: number }>).map((r) => r.rowid))
    } finally {
      raw.close()
    }
    expect([...ftsRowids].sort((a, b) => a - b), 'FTS index and nodes table disagree after recovery')
      .toEqual([...nodeRowids].sort((a, b) => a - b))
  })

  // S: frequently relied-on history evicts last.
  //
  // Reliance travels the PRODUCTION path end to end: the entry is fetched
  // by id through the real MCP treecontext_export tool (the act the
  // 2026-07-23 ruling defines as reliance — query hits never count), the
  // counter lands in the row's metadata, and retentionSweep reads it back
  // to order eviction. The stronger form is deliberate: the relied-on
  // session is the OLDER of the two, so reliance must beat a recency
  // disadvantage, not ride along with one.
  reg.define(/^two old sessions of equal size, one whose entries have been exported by later sessions and one never touched$/, async (w: StorageWorld) => {
    await openValveStore(w, { maxSessions: 2, maxStoreBytes: 10_000_000 })
    const insertSession = async (session: string, base: number): Promise<string[]> => {
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        ids.push((await w.store!.insert(
          `${session} entry ${i}: notes from that stretch of work`,
          { metadata: autoMeta(session), createdAt: base + i * 10 },
        )).nodeId)
      }
      return ids
    }
    const reliedIds = await insertSession('relied-old', T0)
    await insertSession('untouched-old', T0 + 1_000)
    await w.store!.insert('the present session, absolutely protected', {
      metadata: autoMeta('current'), createdAt: T0 + 2_000,
    })

    // Later sessions relied on the OLD session's entry: fetched in full,
    // twice, through the real tool surface.
    const client = await mcpOver(w)
    for (let i = 0; i < 2; i++) {
      await client.callTool({ name: 'treecontext_export', arguments: { node_id: reliedIds[0] } })
    }
    const [row] = rawAll<{ n: number }>(
      w, "SELECT json_extract(metadata_json,'$._relied_count') AS n FROM nodes WHERE node_id = ?", reliedIds[0]!,
    )
    expect(row!.n, 'the export tool must have recorded the reliance').toBe(2)
    w.nodeIds = reliedIds
  })
  reg.define(/^the untouched session is archived first$/, (w: StorageWorld) => {
    // One session over the cap, so exactly one eviction — and it must be
    // the untouched one, despite being NEWER than the relied-on one.
    const perSession = (s: string): number =>
      rawAll<{ n: number }>(
        w, "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.session_id') = ?", s,
      )[0]!.n
    expect(perSession('untouched-old'), 'the untouched session must be gone').toBe(0)
    expect(perSession('relied-old'), 'the relied-on session must survive whole').toBe(5)
    expect(perSession('current'), 'the newest session is untouchable').toBe(1)

    // Archived, not destroyed: the tombstone names the untouched session
    // and its archive file exists on disk.
    const tombs = rawAll<{ metadata_json: string }>(
      w, "SELECT metadata_json FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1",
    ).map((r) => JSON.parse(r.metadata_json) as { _archived_session: string; _archive_path: string })
    expect(tombs.map((t) => t._archived_session)).toEqual(['untouched-old'])
    expect(existsSync(tombs[0]!._archive_path)).toBe(true)
  })

  // S: concurrent sessions do not corrupt each other.
  //
  // The writer roles are the C2 lock pair (store-lock.ts): the
  // tool-writer lock for the namespace and the store's drain lock. The
  // second session is a real process, and its refusals come from the
  // actual exclusion primitive on the actual lockfile paths —
  // O_CREAT|O_EXCL, exercised cross-process — not from a
  // reimplementation agreeing with itself; the in-process acquire
  // attempts then pin the full production semantics (live holder →
  // StoreLockedError). Meanwhile its captures land the way hooks land
  // them: staged directly, no lock held — staging is exactly the
  // letterbox that makes a locked-out session lossless.
  reg.define(/^two live sessions pointed at the same store$/, async (w: StorageWorld) => {
    w.dir = mkdtempSync(join(tmpdir(), 'tc-journal-bind-'))
    w.defer(() => rmSync(w.dir!, { recursive: true, force: true }))
    w.dbPath = join(w.dir, 'concurrent.db')
    const store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(w.dbPath)), ownsDatabase: true,
    })
    w.defer(() => store.close())
    w.store = store
    // THIS process is session A and takes both roles, as serve does —
    // through the store's lease table (G4): the trunk's tool-writer
    // lease and the store's drain lease.
    const leases = new LeaseClient(store.store.database, { pid: process.pid, host: hostname() })
    leases.tryAcquire('ns:project', NS_LEASE_TTL_SECS)
    leases.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)
    w.defer(() => leases.releaseAll())
  })
  reg.define(/^both capture and ingest at once$/, async (w: StorageWorld) => {
    // tsx runtime so the child runs the PRODUCTION LeaseClient from a
    // real second pid (G4 review, finding 10).
    const helper = fileURLToPath(new URL('../../helpers/concurrent-session.ts', import.meta.url))
    const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const B_COUNT = 40
    const child = spawn(process.execPath, [tsxCli, helper, w.dbPath!, String(B_COUNT)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let childOut = ''
    child.stdout!.on('data', (c: Buffer) => { childOut += c.toString() })

    // Session A stages its own captures and runs ingestion WHILE session
    // B is writing — interleaved for real, not sequenced.
    const loop = new IngestionLoop(w.store!, { batchSize: 10 })
    const A_COUNT = 40
    for (let i = 0; i < A_COUNT; i++) {
      w.store!.store.insertStaging({
        sessionId: 'concurrent-a', role: 'user', priority: 1, timestamp: 1_700_000_000 + i,
        content: `concurrent capture a-${i} :: written by the writer session mid-drain`,
      })
      if (i % 5 === 0) await loop.ingestBatch()
    }
    // 'close', not 'exit': pending pipe data is delivered after 'exit'
    // fires, so an exit-time snapshot can miss the tail lines on a
    // loaded box (third-pass review).
    const [exitCode] = (await once(child, 'close')) as [number | null]
    expect(exitCode).toBe(0)
    w.concurrentChildOut = childOut
    // The writer drains the backlog — both sessions' rows, however the
    // interleaving fell out.
    for (let i = 0; i < 30 && w.store!.store.countUnprocessedStaging() > 0; i++) {
      await loop.ingestBatch()
    }
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
  })
  reg.define(/^claims and constraints make the concurrent writers safe: every capture lands exactly once$/, (w: StorageWorld) => {
    // Safety is the STORE's doing now (G2/G3), observed through the
    // STORE's own truth: the session_key COLUMN, not the metadata
    // annotation — a stamping regression fails here. Exact-once means
    // the staging letterbox fully drained AND each session's captures
    // count exactly once under the arbiter columns. (The mechanism —
    // fenced retirement, claim marks — is pinned in
    // staging-claims.test.ts; this step binds the outcome.)
    const counts = rawAll<{ s: string; n: number }>(
      w,
      "SELECT session_key AS s, COUNT(*) AS n FROM nodes " +
        "WHERE session_key IN ('concurrent-a','concurrent-b') GROUP BY s",
    )
    const bySession = new Map(counts.map((c) => [c.s, c.n]))
    expect(bySession.get('concurrent-a')).toBe(40)
    expect(bySession.get('concurrent-b')).toBe(40)
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
  })
  reg.define(/^the drain lease keeps draining efficient — one drain owner per store at a time$/, (w: StorageWorld) => {
    // The second PROCESS was refused by the real arbiter — the lease row
    // in the shared store…
    expect(w.concurrentChildOut).toContain('drain lease denied')
    // step-lint: allow unearned-absence -- guarded: the paired positive two lines up asserts 'drain lease denied' in the same child output, and leaseHolders below pins THIS process as holder
    expect(w.concurrentChildOut).not.toContain('drain lease acquired')
    // …and the production client refuses a live foreign holder too.
    const foreign = new LeaseClient(w.store!.store.database, { pid: process.pid + 1, host: hostname() })
    expect(() => foreign.tryAcquire('drain', DRAIN_LEASE_TTL_SECS)).toThrow(/Only one drain owner per store/)
    // The role is held by THIS process, not merely by nobody else.
    const drain = leaseHolders(w.store!.store.database).find((l) => l.role === 'drain')
    expect(drain?.holderPid).toBe(process.pid)
    expect(drain?.live).toBe(true)
  })
  reg.define(/^a second server on the same namespace serves too — the store's constraints, not a lease, are what keep writers safe$/, async (w: StorageWorld) => {
    // Contention is real and unchanged: cross-process, the second pid is
    // refused the lease row in the shared store…
    expect(w.concurrentChildOut).toContain('ns lease denied')
    // step-lint: allow unearned-absence -- guarded: paired positive directly above asserts 'ns lease denied'; the holder check below completes the pair
    expect(w.concurrentChildOut).not.toContain('ns lease acquired')
    // …the production client's refusal still NAMES the namespace…
    const foreign = new LeaseClient(w.store!.store.database, { pid: process.pid + 1, host: hostname() })
    expect(() => foreign.tryAcquire('ns:project', NS_LEASE_TTL_SECS)).toThrow(/Namespace 'project'.*Only one writer per namespace/)
    // …and the claim stays with session A, one holder, live.
    const ns = leaseHolders(w.store!.store.database).find((l) => l.role === 'ns:project')
    expect(ns?.holderPid).toBe(process.pid)
    expect(ns?.live).toBe(true)
    // What retired (amendment 8, 2026-08-20) is that refusal stopping a
    // server: a second same-namespace server runs serve's hook, which
    // swallows the contention, so its tool call reaches the store and
    // the store's constraints are what decide the write.
    const client = await mcpOver(w, { lockHook: nsClaimHook(w.store!.store.database, 'project', process.pid + 1) })
    const res = await client.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'SECONDSERVER5140: written by a server that was refused the namespace claim' },
    })
    expect((res as { isError?: boolean }).isError, JSON.stringify((res as { content: unknown }).content)).toBeFalsy()
    const landed = rawAll<{ n: number }>(
      w, "SELECT COUNT(*) AS n FROM nodes WHERE content LIKE '%SECONDSERVER5140%'",
    )
    expect(landed[0]!.n, 'the non-holder\'s insert never reached the store').toBe(1)
  })
  reg.define(/^the other's captures are staged, not lost, and drain when the drain owner runs$/, (w: StorageWorld) => {
    // The child reported all 40 staged; after the writer's drain, all 40
    // exist as nodes — none lost to contention, none double-ingested.
    expect(w.concurrentChildOut!.match(/^staged \d+$/gm)).toHaveLength(40)
    const bRows = rawAll<{ content: string }>(
      w,
      "SELECT content FROM nodes WHERE json_extract(metadata_json,'$.session_id') = 'concurrent-b'",
    )
    expect(bRows).toHaveLength(40)
    const bNums = new Set(bRows.map((r) => Number(/capture b-(\d+) ::/.exec(r.content)![1])))
    expect(bNums.size).toBe(40)
    // The writer's own session survived the contention too.
    const aRows = rawAll<{ n: number }>(
      w,
      "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.session_id') = 'concurrent-a'",
    )
    expect(aRows[0]!.n).toBe(40)
  })
}

function readStagingPoisonRow(dbPath: string): { attempts: number; processed: number } {
  const raw = new BetterSqlite3(dbPath, { readonly: true })
  try {
    const r = raw.prepare(
      "SELECT attempts, processed FROM staging WHERE content LIKE '%POISONROW%'",
    ).get() as { attempts: number; processed: number } | undefined
    if (!r) throw new Error('the poison staging row vanished from staging entirely')
    return { attempts: Number(r.attempts), processed: Number(r.processed) }
  } finally { raw.close() }
}

function countCaptureGapNodes(dbPath: string): number {
  const raw = new BetterSqlite3(dbPath, { readonly: true })
  try {
    const r = raw.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE json_extract(metadata_json, '$.source') = 'capture-gap'",
    ).get() as { c: number }
    return Number(r.c)
  } finally { raw.close() }
}

export const storageRefusalDefiner = (reg: Registry<StorageWorld>): void => {
  reg.define(/^a store whose recorded mode names a backend this build no longer ships$/, async (w: StorageWorld) => {
    await openLiveStore(w) // migrations create the schema; FlatStore.open records no mode
    await w.store!.insert('rows written before the backend left')
    w.store!.close()
    const raw = new BetterSqlite3(w.dbPath!)
    try {
      // What TreeContext.open used to leave behind: an embedding_model row
      // and no backend_mode record — resolution says 'tree'.
      raw.prepare(
        "INSERT INTO embedding_model (id, model_name, dim, pooling, normalize) VALUES (1, 'all-MiniLM-L6-v2', 384, 'mean', 1)",
      ).run()
    } finally {
      raw.close()
    }
  })
  reg.define(/^this build tries to open it$/, async (w: StorageWorld) => {
    // Hold the handle here rather than inline: when the open REFUSES — which
    // is the whole point of this scenario — nothing ever takes ownership, so
    // the database stayed open and Windows would not unlink the directory in
    // teardown. close() is idempotent, so this is a no-op on the path where
    // the store did take it.
    const db = wrapBetterSqlite(new BetterSqlite3(w.dbPath!))
    try {
      await createMemoryStore({ database: db, ownsDatabase: true })
      w.insertError = null
    } catch (err) {
      w.insertError = err
    } finally {
      db.close()
    }
  })
  reg.define(/^the open fails with a message naming the recovery options$/, (w: StorageWorld) => {
    expect(w.insertError, 'the open succeeded — a deleted backend was opened blind').toBeTruthy()
    const msg = (w.insertError as Error).message
    expect(msg).toMatch(/no longer\s+ships/)
    expect(msg).toContain('pre-deletion-phase')
    expect(msg).toContain('untouched')
  })
  reg.define(/^every row and the mode record are untouched by the refusal$/, (w: StorageWorld) => {
    const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
    try {
      const n = (raw.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n
      expect(n).toBeGreaterThan(0)
      const model = raw.prepare('SELECT model_name FROM embedding_model WHERE id = 1').get() as { model_name: string }
      expect(model.model_name).toBe('all-MiniLM-L6-v2')
    } finally {
      raw.close()
    }
  })
}


// ── D141 / D255: the byte budget and the session cap ────────────────────
//
// Bound through the real door: a `serve` child spawned with its cwd in a
// temp project directory (so config discovery finds ./treecontext.toml, or
// nothing), HOME sandboxed (so ~/.treecontext/config.toml is out of reach
// unless a scenario writes it), every config-steering env var stripped,
// and status read over MCP stdio exactly as an agent reads it. Never the
// constant, never applyConfigFile in-process.
export const storageBudgetDefiner = (reg: Registry<StorageWorld>): void => {
  const MiB = 1024 * 1024
  const autoMeta = (session: string, extra?: Record<string, unknown>) => ({
    source: 'auto-capture', role: 'tool', session_id: session, ...extra,
  })

  function budgetProject(w: StorageWorld, toml: string | null): void {
    const root = mkdtempSync(join(tmpdir(), 'tc-budget-'))
    w.defer(() => rmSync(root, { recursive: true, force: true }))
    w.budgetHome = join(root, 'home')
    w.budgetProject = join(root, 'project')
    mkdirSync(w.budgetHome, { recursive: true })
    mkdirSync(w.budgetProject, { recursive: true })
    w.budgetDb = join(root, 'store', 'treecontext.db')
    mkdirSync(join(root, 'store'), { recursive: true })
    if (toml !== null) writeFileSync(join(w.budgetProject, 'treecontext.toml'), toml)
  }

  async function serveFromProject(w: StorageWorld): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', w.budgetDb!]),
      env: sandboxedSpawnEnv(w.budgetHome!) as Record<string, string>,
      cwd: w.budgetProject!,
      stderr: 'pipe',
    })
    let serverErr = ''
    transport.stderr?.on('data', (d: Buffer) => { serverErr += d.toString() })
    const client = new Client({ name: 'budget-operator', version: '0' })
    try {
      await client.connect(transport)
    } catch (err) {
      throw new Error(`serve did not start from the project: ${String(err)}\n${serverErr}`)
    }
    w.defer(async () => { await client.close() })
    w.budgetClient = client
    return client
  }

  async function statusOver(w: StorageWorld): Promise<Record<string, unknown>> {
    w.budgetStatus = parseTool(await w.budgetClient!.callTool({ name: 'treecontext_status', arguments: {} }))
    return w.budgetStatus
  }

  const storageOf = (w: StorageWorld): { budget_bytes: number; session_cap: number } => {
    const storage = w.budgetStatus!['storage'] as { budget_bytes: number; session_cap: number } | undefined
    expect(storage, 'status carries no storage gauge').toBeDefined()
    return storage!
  }

  // S: the default.
  reg.define(/^a store opened with no budget configured$/, async (w: StorageWorld) => {
    budgetProject(w, null)
    await serveFromProject(w)
  })
  reg.define(/^status is read$/, async (w: StorageWorld) => {
    await statusOver(w)
  })
  reg.define(/^the byte budget it reports is (\d+) MiB$/, (w: StorageWorld, ...captures) => {
    const [mib] = captures as string[]
    expect(storageOf(w).budget_bytes).toBe(Number(mib) * MiB)
  })
  reg.define(/^the session cap it reports is (\d+)$/, (w: StorageWorld, ...captures) => {
    const [cap] = captures as string[]
    expect(storageOf(w).session_cap).toBe(Number(cap))
  })

  // S: the operator's figures, per project.
  reg.define(
    /^a project whose config file sets the byte budget to (\d+) MiB and the session cap to (\d+)$/,
    (w: StorageWorld, ...captures) => {
      const [mib, cap] = captures as string[]
      budgetProject(w, `[retention]\nmax_store_bytes = ${Number(mib) * MiB}\nmax_sessions = ${Number(cap)}\n`)
    },
  )
  reg.define(/^the server is started from that project and opens its store$/, async (w: StorageWorld) => {
    await serveFromProject(w)
  })
  reg.define(
    /^status over that server reports a budget of (\d+) MiB and a session cap of (\d+)$/,
    async (w: StorageWorld, ...captures) => {
      const [mib, cap] = captures as string[]
      await statusOver(w)
      expect(storageOf(w)).toMatchObject({ budget_bytes: Number(mib) * MiB, session_cap: Number(cap) })
    },
  )

  // S: a budget the file cannot mean.
  reg.define(/^a project whose config file sets the byte budget to zero$/, async (w: StorageWorld) => {
    budgetProject(w, '[retention]\nmax_store_bytes = 0\n')
    // Demotable rows already in the store, in an OLD session (the newest
    // session is absolutely protected): incompressible full-view prose past
    // the demotion floor, the one shape the byte valve shrinks. A zero
    // budget obeyed would strip every one of them on the next sweep.
    const raw = new BetterSqlite3(w.budgetDb!)
    const store = await FlatStore.open({ database: wrapBetterSqlite(raw), ownsDatabase: true, migrate: true })
    const ids: string[] = []
    try {
      for (let i = 0; i < 4; i++) {
        const c = `demotable prose ${i} ${randomBytes(1600).toString('base64')}`
        ids.push((await store.insert(c, { metadata: autoMeta('s-budget-old', { role: 'user', _index_len: c.length }), createdAt: T0 + i })).nodeId)
      }
      await store.insert('the newest session, protected absolutely', { metadata: autoMeta('s-budget-new', { role: 'user' }), createdAt: T0 + 100 })
    } finally {
      await store.close()
    }
    const ro = new BetterSqlite3(w.budgetDb!, { readonly: true })
    try {
      const len = ro.prepare('SELECT LENGTH(CAST(content AS BLOB)) AS n FROM nodes WHERE node_id = ?')
      w.budgetSeed = new Map(ids.map((id) => [id, (len.get(id) as { n: number } | undefined)?.n ?? -1]))
    } finally {
      ro.close()
    }
    expect(w.budgetSeed.size, 'the Given seeded no demotable rows').toBe(4)
  })
  reg.define(/^status over that server reports the default budget$/, async (w: StorageWorld) => {
    await statusOver(w)
    // The default, read from a second real serve with no file in reach —
    // the default as the operator sees it, never the constant.
    const home = w.budgetHome!
    const project = mkdtempSync(join(tmpdir(), 'tc-budget-bare-'))
    w.defer(() => rmSync(project, { recursive: true, force: true }))
    const bare = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', join(project, 'treecontext.db')]),
      env: sandboxedSpawnEnv(home) as Record<string, string>,
      cwd: project,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'budget-default', version: '0' })
    await client.connect(bare)
    try {
      const st = parseTool(await client.callTool({ name: 'treecontext_status', arguments: {} }))
      const def = (st['storage'] as { budget_bytes: number }).budget_bytes
      expect(def).toBeGreaterThan(0)
      expect(storageOf(w).budget_bytes, 'the file\'s zero was obeyed, or the default was not').toBe(def)
    } finally {
      await client.close()
    }
  })
  reg.define(/^a store well under that budget loses nothing when the valve runs$/, async (w: StorageWorld) => {
    // The valve runs inside the serving process, every 50th insert: drive
    // it there through the tool an agent calls.
    for (let i = 0; i < 55; i++) {
      await w.budgetClient!.callTool({
        name: 'treecontext_insert',
        arguments: { content: `budget note ${i} ${randomBytes(6).toString('hex')}` },
      })
    }
    await w.budgetClient!.close()
    const ro = new BetterSqlite3(w.budgetDb!, { readonly: true })
    try {
      for (const [id, n] of w.budgetSeed!) {
        const row = ro.prepare('SELECT LENGTH(CAST(content AS BLOB)) AS n, metadata_json FROM nodes WHERE node_id = ?').get(id) as { n: number; metadata_json: string } | undefined
        expect(row, `seeded row ${id} is gone`).toBeDefined()
        expect(row!.n, `seeded row ${id} was demoted under a budget of zero`).toBe(n)
        expect(JSON.parse(row!.metadata_json ?? '{}')['_demoted']).toBeUndefined()
      }
    } finally {
      ro.close()
    }
  })

  // S: the warning names the knob.
  reg.define(/^the storage warning names the config key that raises the budget and the file it lives in$/, async (w: StorageWorld) => {
    const client = await mcpOver(w)
    const panel = parseTool(await client.callTool({ name: 'treecontext_status', arguments: {} }))
    const warning = panel['storage_warning']
    expect(typeof warning, 'an over-budget store must warn in words').toBe('string')
    w.budgetStatus = panel
    expect(warning as string).toContain('max_store_bytes')
    expect(warning as string).toMatch(/treecontext\.toml/)
    expect(warning as string).toContain('~/.treecontext/config.toml')
  })
  reg.define(/^a config file that sets that key, spelled as the warning spells it, is read as the budget$/, async (w: StorageWorld) => {
    const warning = w.budgetStatus!['storage_warning'] as string
    // No code constant: camelCase or SCREAMING identifiers are the code's
    // spelling. The needle is proven on the warning this ruling retired.
    const codeSpelling = /\b(?:[a-z]+[A-Z][A-Za-z]*|[A-Z]+_[A-Z_]+)\b/
    expect('Export and clear old entries, or raise maxStoreBytes.').toMatch(codeSpelling)
    expect(warning).not.toMatch(codeSpelling)
    const m = /\[([a-z_]+)\]\s+([a-z_]+)/.exec(warning)
    expect(m, `the warning spells no "[table] key": ${warning}`).not.toBeNull()
    const [, table, key] = m!
    const budget = 300 * MiB
    budgetProject(w, `[${table}]\n${key} = ${budget}\n`)
    expect(loadConfigFile(join(w.budgetProject!, 'treecontext.toml')).retention.maxStoreBytes).toBe(budget)
    await serveFromProject(w)
    await statusOver(w)
    expect(storageOf(w).budget_bytes, 'the key as the warning spells it does not set the budget').toBe(budget)
  })

  // S: the cap the operator sets is the cap that bites (the net scales).
  //
  // The cap is read from a real project config file by the real loader and
  // reaches the store as the [retention] figures serve hands over; the entry net is whatever the store derives —
  // no maxAutoEntries is passed. The sprint goes in through the library
  // insert with session ids, batched in one transaction for speed (the
  // amortized sweep is pushed out of the batch), and the real retention
  // sweep runs when the When says so.
  const sprintSession = (i: number): string => `sprint-s${String(i).padStart(3, '0')}`
  const sprintSessionsLive = (w: StorageWorld): string[] =>
    (w.sprintRaw!.prepare(
      "SELECT DISTINCT json_extract(metadata_json,'$.session_id') AS s FROM nodes "
      + "WHERE json_extract(metadata_json,'$.source') = 'auto-capture' AND json_extract(metadata_json,'$._tombstone') IS NULL ORDER BY s",
    ).all() as Array<{ s: string }>).map((r) => r.s)

  async function sprintSessionInsert(w: StorageWorld, session: number, per: number): Promise<void> {
    for (let i = 0; i < per; i++) {
      await w.store!.insert(`sprint ${session} entry ${i}: subagent output ${randomBytes(4).toString('hex')}`, {
        metadata: autoMeta(sprintSession(session)),
        createdAt: T0 + session * 1_000 + i,
      })
    }
  }

  reg.define(/^a project whose config file sets the session cap to (\d+)$/, async (w: StorageWorld, ...captures) => {
    const [cap] = captures as string[]
    budgetProject(w, `[retention]\nmax_sessions = ${Number(cap)}\n`)
    const cfg = loadConfigFile(null, w.budgetProject!)
    expect(cfg.retention.maxSessions, 'the loader did not read the cap').toBe(Number(cap))
    const raw = new BetterSqlite3(w.budgetDb!)
    // The file's figures as serve hands them over; the amortized sweep is
    // the one setting added — the When drives the valve, so none runs
    // inside the Given's batch transaction. No maxAutoEntries: the store
    // derives its own net from the cap.
    const store = await FlatStore.open({
      database: wrapBetterSqlite(raw),
      ownsDatabase: true,
      ...cfg.retention,
      retentionInterval: 1_000_000,
    })
    w.defer(() => store.close())
    w.store = store
    w.sprintRaw = raw
    expect(store.status().retention!.sessionCap).toBe(Number(cap))
  })
  reg.define(/^a sprint of (\d+) sessions each carrying (\d+) entries, ([\d ]+) in all$/, async (w: StorageWorld, ...captures) => {
    const [sessions, per, total] = (captures as string[]).map((c) => Number(c.replace(/ /g, '')))
    expect(sessions! * per!).toBe(total)
    w.sprintSessions = sessions!
    w.sprintPer = per!
    w.sprintRaw!.exec('BEGIN')
    try {
      for (let s = 0; s < sessions!; s++) await sprintSessionInsert(w, s, per!)
      w.sprintRaw!.exec('COMMIT')
    } catch (err) {
      w.sprintRaw!.exec('ROLLBACK')
      throw err
    }
    const n = (w.sprintRaw!.prepare("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$.source') = 'auto-capture'").get() as { n: number }).n
    expect(n, 'the sprint did not land whole').toBe(total)
  })
  reg.define(/^the valve runs after the (\d+)(?:st|nd|rd|th) session$/, (w: StorageWorld, ...captures) => {
    const [nth] = captures as string[]
    expect(Number(nth)).toBe(w.sprintSessions)
    w.sprintSweep = w.store!.retentionSweep()
  })
  reg.define(/^no session is evicted until the (\d+)(?:st|nd|rd|th) begins$/, (w: StorageWorld, ...captures) => {
    const [nth] = captures as string[]
    expect(Number(nth)).toBe(w.sprintSessions! + 1)
    expect(w.sprintSweep!.evicted, 'the valve evicted inside the operator\'s cap').toBe(0)
    const live = sprintSessionsLive(w)
    expect(live, 'sessions were evicted before the cap was reached').toHaveLength(w.sprintSessions!)
    const tombs = (w.sprintRaw!.prepare("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1").get() as { n: number }).n
    expect(tombs).toBe(0)
  })
  reg.define(/^the (\d+)(?:st|nd|rd|th) session's arrival evicts exactly the oldest, archived and tombstoned$/, async (w: StorageWorld, ...captures) => {
    const [nth] = captures as string[]
    const newest = Number(nth) - 1
    expect(newest).toBe(w.sprintSessions)
    await sprintSessionInsert(w, newest, 1)
    const outcome = w.store!.retentionSweep()
    expect(outcome.evicted, 'exactly one session\'s entries leave').toBe(w.sprintPer)
    const live = sprintSessionsLive(w)
    expect(live).toHaveLength(w.sprintSessions!)
    expect(live).not.toContain(sprintSession(0))
    expect(live).toContain(sprintSession(1))
    expect(live).toContain(sprintSession(newest))
    const tombs = w.sprintRaw!.prepare(
      "SELECT metadata_json FROM nodes WHERE json_extract(metadata_json,'$._tombstone') = 1",
    ).all() as Array<{ metadata_json: string }>
    expect(tombs).toHaveLength(1)
    const meta = JSON.parse(tombs[0]!.metadata_json) as Record<string, unknown>
    expect(meta['_archived_session']).toBe(sprintSession(0))
    const archive = meta['_archive_path'] as string
    expect(existsSync(archive), 'the tombstone points at a missing archive').toBe(true)
    const archived = (JSON.parse(readFileSync(archive, 'utf8')) as { nodes: Array<{ content: string }> }).nodes
    expect(archived, 'the archive does not hold the whole oldest session').toHaveLength(w.sprintPer!)
    expect(archived.every((n) => n.content.startsWith('sprint 0 entry '))).toBe(true)
  })
}

// ── D59 / D256: an additive migration also runs behind a backup ──────────
//
// A real store on disk, one additive step behind the head (the head's
// migration is idempotent DDL, so rewinding user_version replays the real
// step). It is opened through FlatStore.open — the library's migrate-on-
// open door — over a handle that lets a second connection write the
// moment the backup is taken: the window an additive (non-exclusive) run
// leaves open. Raw SQLite reads the backup's own user_version and rows.
export const storageAdditiveBackupDefiner = (reg: Registry<StorageWorld>): void => {
  reg.define(/^a store one additive migration behind the current schema$/, async (w: StorageWorld) => {
    const head = migrations.at(-1)!
    expect(head.kind, 'the newest migration is not additive').toBe('additive')
    const dir = mkdtempSync(join(tmpdir(), 'tc-additive-bak-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'treecontext.db')
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true })
    const seeded: string[] = []
    for (let i = 0; i < 6; i++) {
      seeded.push((await store.insert(`entry ${i} written before the migration`, { metadata: { source: 'auto-capture', role: 'tool', session_id: 'pre' }, createdAt: T0 + i })).nodeId)
    }
    await store.close()
    // The ladder from an empty file crossed destructive steps and left
    // their backup; this scenario is about the next one only.
    for (const f of readdirSync(dir)) if (f.includes('.pre-migration-')) rmSync(join(dir, f), { force: true })
    const raw = new BetterSqlite3(path)
    raw.pragma(`user_version = ${head.version - 1}`)
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    w.additive = { path, from: head.version - 1, seeded, late: [] }
  })
  reg.define(/^the store is opened and migrated$/, async (w: StorageWorld) => {
    const a = w.additive!
    const writer = (): void => {
      const w2 = new BetterSqlite3(a.path)
      try {
        const tree = (w2.prepare("SELECT tree_id FROM trees WHERE namespace = 'project' AND ensemble_index = 0").get() as { tree_id: number }).tree_id
        const ins = w2.prepare("INSERT INTO nodes (node_id, tree_id, content, summary, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)")
        for (let i = 0; i < 4; i++) {
          const id = `late-writer-${i}`
          ins.run(id, tree, `written by another session during the migration ${i}`, T0 + 100 + i, T0 + 100 + i)
          a.late.push(id)
        }
      } finally {
        w2.close()
      }
    }
    const db = wrapBetterSqlite(new BetterSqlite3(a.path))
    const watched = new Proxy(db, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string): void => {
            target.exec(sql)
            if (sql.startsWith('VACUUM INTO')) writer()
          }
        }
        const v = Reflect.get(target, prop) as unknown
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v
      },
    })
    // The migrate-on-open door itself; its report is read back from disk.
    const store = await FlatStore.open({ database: watched, ownsDatabase: true })
    await store.close()
    a.report = { from: a.from, to: maxSupportedVersion, applied: [], backupPath: `${a.path}.pre-migration-v${a.from}.bak` }
  })
  reg.define(/^a backup of the store as it was lies beside it, taken before the change, with a success verdict$/, (w: StorageWorld) => {
    const a = w.additive!
    const bak = a.report!.backupPath!
    expect(existsSync(bak), 'the additive migration ran with no backup beside the store').toBe(true)
    const b = new BetterSqlite3(bak, { readonly: true })
    try {
      expect(b.pragma('user_version', { simple: true }), 'the backup was taken after the change').toBe(a.from)
      const ids = (b.prepare('SELECT node_id FROM nodes').all() as Array<{ node_id: string }>).map((r) => r.node_id)
      expect(ids.sort()).toEqual([...a.seeded].sort())
    } finally {
      b.close()
    }
    const live = new BetterSqlite3(a.path, { readonly: true })
    try {
      expect(live.pragma('user_version', { simple: true })).toBe(maxSupportedVersion)
    } finally {
      live.close()
    }
    expect(readVerdict(bak)?.verdict).toBe('success')
  })
  reg.define(/^a writer active during the migration costs no row and makes no verdict fail$/, (w: StorageWorld) => {
    const a = w.additive!
    expect(a.late, 'no writer ran in the window').toHaveLength(4)
    const live = new BetterSqlite3(a.path, { readonly: true })
    try {
      const ids = new Set((live.prepare('SELECT node_id FROM nodes').all() as Array<{ node_id: string }>).map((r) => r.node_id))
      for (const id of [...a.seeded, ...a.late]) expect(ids.has(id), `row ${id} was lost`).toBe(true)
    } finally {
      live.close()
    }
    const record = readVerdict(a.report!.backupPath!)
    expect(record).toMatchObject({ verdict: 'success', backupEntries: a.seeded.length, migratedEntries: a.seeded.length + a.late.length })
  })
}

