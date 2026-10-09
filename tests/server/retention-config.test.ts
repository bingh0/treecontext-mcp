/**
 * D141 build item (D255): the store-byte budget default is 128 MiB, the
 * budget and the session cap are operator-settable per store through the
 * config file's [retention] table, and the over-budget warning names that
 * key — never the code constant it used to name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CLI_TS, nodeTsArgs, sandboxedSpawnEnv, spawnCli } from '../helpers/cli-spawn.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { loadConfigFile } from '../../src/server/config.js'
import { applyConfigFile, parseArgs, serveOptionsFrom } from '../../src/server/cli.js'
import { MAX_STORE_BYTES_DEFAULT, MAX_SESSIONS_DEFAULT } from '../../src/persistence/capture-constants.js'
import { FlatStore } from '../../src/flat-store.js'
import { createMemoryStore } from '../../src/memory-store-factory.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { createServer } from '../../src/server/server.js'
import { parseToolResult } from '../helpers/mcp-result.js'

const MiB = 1024 * 1024

describe('the store-byte budget and session cap (D141, D255)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-retcfg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the default budget is 128 MiB and the default session cap 100', async () => {
    expect(MAX_STORE_BYTES_DEFAULT).toBe(128 * MiB)
    expect(MAX_SESSIONS_DEFAULT).toBe(100)
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'd.db'))), ownsDatabase: true })
    try {
      expect(store.status().retention).toMatchObject({ budgetBytes: 128 * MiB, sessionCap: 100 })
    } finally {
      await store.close()
    }
  })

  it('[retention] max_store_bytes and max_sessions load from the config file', () => {
    const p = join(dir, 'treecontext.toml')
    writeFileSync(p, ['[retention]', 'max_store_bytes = 268435456', 'max_sessions = 12'].join('\n'))
    const cfg = loadConfigFile(p)
    expect(cfg.retention).toEqual({ maxStoreBytes: 256 * MiB, maxSessions: 12 })
  })

  it('a dropped [retention] key is announced on stderr, naming the file and the key', () => {
    const p = join(dir, 'loud.toml')
    writeFileSync(p, ['[retention]', 'max_store_bytes = 0', 'max_sessions = -3'].join('\n'))
    const seen: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { seen.push(a.join(' ')) }
    try {
      loadConfigFile(p)
    } finally {
      console.error = orig
    }
    expect(seen.find((l) => l.includes('max_store_bytes = 0') && l.includes(p))).toBeDefined()
    expect(seen.find((l) => l.includes('max_sessions = -3'))).toBeDefined()
  })

  it('a value that names no budget is ignored, never obeyed', () => {
    const p = join(dir, 'bad.toml')
    writeFileSync(p, ['[retention]', 'max_store_bytes = 0', 'max_sessions = "twelve"'].join('\n'))
    expect(loadConfigFile(p).retention).toEqual({})
    writeFileSync(p, ['[retention]', 'max_store_bytes = -5', 'max_sessions = 2.5'].join('\n'))
    expect(loadConfigFile(p).retention).toEqual({})
  })

  it('the keys reach the serve options; a silent file leaves the defaults', () => {
    const p = join(dir, 'treecontext.toml')
    writeFileSync(p, ['[retention]', 'max_store_bytes = 268435456', 'max_sessions = 12'].join('\n'))
    const args = parseArgs(['node', 'cli', 'serve'])
    applyConfigFile(args, loadConfigFile(p))
    expect(serveOptionsFrom(args)).toMatchObject({ maxStoreBytes: 256 * MiB, maxSessions: 12 })

    const bare = parseArgs(['node', 'cli', 'serve'])
    applyConfigFile(bare, { server: {}, retention: {}, path: null })
    const opts = serveOptionsFrom(bare)
    expect(opts.maxStoreBytes).toBeUndefined()
    expect(opts.maxSessions).toBeUndefined()
  })

  it('the factory forwards both to the store it opens', async () => {
    const store = await createMemoryStore({
      database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'f.db'))),
      ownsDatabase: true,
      maxStoreBytes: 256 * MiB,
      maxSessions: 12,
    })
    try {
      expect(store.status().retention).toMatchObject({ budgetBytes: 256 * MiB, sessionCap: 12 })
    } finally {
      await store.close()
    }
  })

  it('the over-budget warning names the config key, not the constant', async () => {
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(join(dir, 'o.db'))), ownsDatabase: true, maxStoreBytes: 1_024, retentionInterval: 1_000_000 })
    await store.insert(`DECISION: protected — ${randomBytes(1200).toString('hex')}`, { metadata: { type: 'decision' } })
    const server = createServer(store, {})
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    try {
      await server.connect(st)
      await client.connect(ct)
      const panel = parseToolResult(await client.callTool({ name: 'treecontext_status', arguments: {} }))
      expect(panel['storage']).toMatchObject({ over_budget: true, budget_bytes: 1_024, session_cap: 100 })
      const warning = panel['storage_warning'] as string
      expect(warning).toContain('[retention] max_store_bytes')
      expect(warning).not.toContain('maxStoreBytes')
    } finally {
      await client.close()
      await server.close()
      await store.close()
    }
  })
})

describe('the entry-count safety net scales with the session cap (D255)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-autonet-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function sessions(store: FlatStore, n: number, per: number): Promise<void> {
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < per; i++) {
        await store.insert(`s${s} entry ${i} ${randomBytes(4).toString('hex')}`, {
          metadata: { source: 'auto-capture', role: 'tool', session_id: `net-s${s}` }, createdAt: 1_700_000_000 + s * 1000 + i,
        })
      }
    }
  }
  it('derives 200 entries per configured session; an explicit option wins', async () => {
    const { autoEntriesFor } = await import('../../src/persistence/capture-constants.js')
    expect(autoEntriesFor(100)).toBe(20_000)
    expect(autoEntriesFor(300)).toBe(60_000)
    expect(autoEntriesFor(12)).toBe(2_400)
  })

  it('a cap of 3 nets 600: three sessions of 250 entries evict the oldest by the net', async () => {
    const path = join(dir, 'n.db')
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true, maxSessions: 3, retentionInterval: 1_000_000 })
    await sessions(store, 3, 250)
    store.retentionSweep()
    await store.close()
    const ro = new BetterSqlite3(path, { readonly: true })
    try {
      const n = (ro.prepare("SELECT COUNT(DISTINCT json_extract(metadata_json, '$.session_id')) AS n FROM nodes WHERE json_extract(metadata_json, '$.source') = 'auto-capture'").get() as { n: number }).n
      expect(n, 'the net did not scale down with the cap').toBe(2)
    } finally {
      ro.close()
    }
  })

  it('an explicit maxAutoEntries keeps its figure', async () => {
    const path = join(dir, 'e.db')
    const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(path)), ownsDatabase: true, maxSessions: 3, maxAutoEntries: 1_000_000, retentionInterval: 1_000_000 })
    await sessions(store, 3, 250)
    store.retentionSweep()
    await store.close()
    const ro = new BetterSqlite3(path, { readonly: true })
    try {
      expect((ro.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n).toBe(750)
    } finally {
      ro.close()
    }
  })
})

// ── the real doors: serve, its drain, merge, import (D255 review) ─────────
describe('the [retention] figures at the real doors (D255)', () => {
  let root: string
  let home: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tc-retdoors-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  async function serve(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(CLI_TS, ['serve', '--lexical', ...args]),
      env: { ...sandboxedSpawnEnv(home), ...env } as Record<string, string>,
      cwd,
      stderr: 'pipe',
    })
    let err = ''
    transport.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    const client = new Client({ name: 'retention-doors', version: '0' })
    try {
      await client.connect(transport)
    } catch (e) {
      throw new Error(`serve did not start: ${String(e)}\n${err}`)
    }
    return client
  }

  it('serve from a subdirectory reads the project root\'s treecontext.toml', async () => {
    const project = join(root, 'repo')
    mkdirSync(join(project, 'pkg', 'deep'), { recursive: true })
    execFileSync('git', ['init', '-q', project])
    writeFileSync(join(project, 'treecontext.toml'), '[retention]\nmax_store_bytes = 268435456\nmax_sessions = 12\n')
    const client = await serve(join(project, 'pkg', 'deep'), ['--store', join(root, 'sub.db')])
    try {
      const st = parseToolResult(await client.callTool({ name: 'treecontext_status', arguments: {} }))
      expect(st['storage']).toMatchObject({ budget_bytes: 256 * MiB, session_cap: 12 })
    } finally {
      await client.close()
    }
  })

  it('TREECONTEXT_PROJECT_DIR names the project the file is read from', () => {
    const project = join(root, 'elsewhere')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'treecontext.toml'), '[retention]\nmax_sessions = 7\n')
    const prevCfg = process.env.TREECONTEXT_CONFIG
    const prevDir = process.env.TREECONTEXT_PROJECT_DIR
    delete process.env.TREECONTEXT_CONFIG
    process.env.TREECONTEXT_PROJECT_DIR = project
    try {
      expect(loadConfigFile(null).retention.maxSessions).toBe(7)
    } finally {
      if (prevCfg !== undefined) process.env.TREECONTEXT_CONFIG = prevCfg
      if (prevDir !== undefined) process.env.TREECONTEXT_PROJECT_DIR = prevDir
      else delete process.env.TREECONTEXT_PROJECT_DIR
    }
  })

  it('the drain-side handle of another namespace sweeps by the file\'s session cap', async () => {
    const project = join(root, 'proj')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'treecontext.toml'), '[retention]\nmax_sessions = 1\n')
    const dbPath = join(root, 'drain.db')
    // Two old sessions already in namespace agent-z.
    const seed = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(dbPath)), ownsDatabase: true, namespace: 'agent-z', retentionInterval: 1_000_000 })
    for (const s of ['z-old-1', 'z-old-2']) {
      await seed.insert(`old ${s} capture ${randomBytes(4).toString('hex')}`, { metadata: { source: 'auto-capture', role: 'tool', session_id: s }, createdAt: 1_700_000_000 + (s.endsWith('1') ? 0 : 10) })
    }
    await seed.close()
    // Fifty staged events of a new agent-z session: the drain handle's
    // fiftieth insert runs its sweep.
    const { writeStaging } = await import('../../src/hooks/shared.js')
    for (let i = 0; i < 50; i++) {
      writeStaging(dbPath, { role: 'tool_result', toolName: 'Bash', sessionId: 'z-new', namespace: 'agent-z', content: `new capture ${i} ${randomBytes(4).toString('hex')}`, timestamp: Date.now() / 1000 + i })
    }
    {
      const pre = new BetterSqlite3(dbPath, { readonly: true })
      try {
        expect((pre.prepare('SELECT COUNT(*) AS n FROM staging WHERE processed = 0').get() as { n: number }).n, 'nothing was staged').toBe(50)
      } finally {
        pre.close()
      }
    }
    const client = await serve(project, ['--store', dbPath, '--capture'])
    try {
      const ro = (): number => {
        const db = new BetterSqlite3(dbPath, { readonly: true })
        try {
          return (db.prepare('SELECT COUNT(*) AS n FROM staging WHERE processed = 0').get() as { n: number }).n
        } finally {
          db.close()
        }
      }
      const deadline = Date.now() + 30_000
      while (ro() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
      expect(ro(), 'the drain never ran').toBe(0)
    } finally {
      await client.close()
    }
    const db = new BetterSqlite3(dbPath, { readonly: true })
    try {
      const live = (db.prepare(
        "SELECT DISTINCT json_extract(n.metadata_json,'$.session_id') AS s FROM nodes n JOIN trees t ON t.tree_id = n.tree_id "
        + "WHERE t.namespace = 'agent-z' AND json_extract(n.metadata_json,'$.source') = 'auto-capture' "
        + "AND json_extract(n.metadata_json,'$._tombstone') IS NULL",
      ).all() as Array<{ s: string }>).map((r) => r.s)
      const dump = db.prepare("SELECT t.namespace AS ns, n.metadata_json AS m FROM nodes n JOIN trees t ON t.tree_id = n.tree_id").all()
      expect(live, `the drain handle swept by the default cap, not the file's: ${JSON.stringify(dump).slice(0, 1500)}`).toEqual(['z-new'])
    } finally {
      db.close()
    }
  }, 60_000)

  /** A destination past the default session cap: any sweep would evict. */
  async function crowdedStore(dbPath: string, sessions: number, tag = 'crowd'): Promise<void> {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const s = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(dbPath)), ownsDatabase: true, retentionInterval: 1_000_000, maxSessions: 1_000 })
    for (let i = 0; i < sessions; i++) {
      await s.insert(`crowd ${i} ${randomBytes(4).toString('hex')}`, { metadata: { source: 'auto-capture', role: 'tool', session_id: `${tag}-${i}` }, createdAt: 1_700_000_000 + i })
    }
    await s.close()
    for (const f of readdirSync(join(dbPath, '..'))) if (f.includes('.pre-migration-')) rmSync(join(dbPath, '..', f), { force: true })
  }
  const liveSessions = (dbPath: string): number => {
    const db = new BetterSqlite3(dbPath, { readonly: true })
    try {
      return (db.prepare("SELECT COUNT(DISTINCT json_extract(metadata_json,'$.session_id')) AS n FROM nodes WHERE json_extract(metadata_json,'$.source') = 'auto-capture' AND json_extract(metadata_json,'$._tombstone') IS NULL").get() as { n: number }).n
    } finally {
      db.close()
    }
  }

  it('stores merge never sweeps the destination, at the command', async () => {
    const stores = join(home, '.treecontext', 'stores')
    const dst = join(stores, 'dst', 'treecontext.db')
    await crowdedStore(dst, 110)
    const src = join(stores, 'src', 'treecontext.db')
    await crowdedStore(src, 1, 'incoming')
    const { mergeBackupName } = await import('../../src/tools/store-merge.js')
    for (const n of ['src', 'dst']) copyFileSync(join(stores, n, 'treecontext.db'), join(stores, n, mergeBackupName()))
    const r = spawnCli(['stores', 'merge', 'src', 'dst', '--backup', '--yes'], { home, env: { TREECONTEXT_BINDINGS_FILE: join(home, 'bindings.json') } })
    expect(r.status, r.out).toBe(0)
    expect(liveSessions(dst), 'the merge ran the retention valve').toBe(111)
  }, 60_000)

  it('import never sweeps the store it opens, at the command', async () => {
    const dbPath = join(root, 'imp', 'treecontext.db')
    await crowdedStore(dbPath, 110)
    const file = join(root, 'handoff.json')
    const ex = spawnCli(['export', file, '--store', dbPath], { home, cwd: root })
    expect(ex.status, ex.out).toBe(0)
    const target = join(root, 'imp2', 'treecontext.db')
    await crowdedStore(target, 110)
    const im = spawnCli(['import', file, '--store', target], { home, cwd: root })
    expect(im.status, im.out).toBe(0)
    expect(liveSessions(target), 'the import ran the retention valve').toBe(110)
  }, 60_000)
})

describe('the install template names the [retention] keys (D255)', () => {
  it('both keys appear commented, so the written file still sets nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tc-tmpl-'))
    const { redirectHome } = await import('../helpers/home.js')
    const restore = redirectHome(home)
    try {
      const { installGlobalConfig } = await import('../../src/server/installer.js')
      installGlobalConfig(false)
      const path = join(home, '.treecontext', 'config.toml')
      const text = readFileSync(path, 'utf8')
      expect(text).toMatch(/^\[retention\]$/m)
      expect(text).toMatch(/^# max_store_bytes = \d+/m)
      expect(text).toMatch(/^# max_sessions = \d+/m)
      expect(loadConfigFile(path).retention).toEqual({})
    } finally {
      restore()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
