/**
 * output-shielding.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Shielding lockdown (ruling 2026-08-15): what an agent actually
 * receives over MCP. shielding.test.ts proves the branch table
 * unit-by-unit; the lockdown file modes live in
 * tests/server/shield-modes.test.ts (POSIX-only, feature-independent).
 *
 * The default-shield-dir scenario redirects HOME only around its own
 * Given→Then window (defer-restored): src/server/shielding.ts resolves
 * defaultShieldDir() per call and os.homedir() reads $HOME live on
 * POSIX, so a scoped redirect is enough — unlike the import-frozen
 * LOGS_DIR elsewhere. The shutdown-sweep scenario drives a real server
 * process because the sweep hangs off stdin-end in the stdio branch
 * only (audit run 1).
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { Registry } from 'gherkin-node-test/vitest'

import { redirectHome } from '../helpers/home.js'
import { CLI_TS, spawnNodeTsAsync } from '../helpers/cli-spawn.js'
import { waitForServeLog } from '../helpers/serve-log.js'
import { parseToolResult, toolResultText } from '../helpers/mcp-result.js'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { shieldResponse, defaultShieldConfig } from '../../src/server/shielding.js'

/** The compact pointer an agent gets back in place of a shielded body. */
interface ShieldReference { shielded?: boolean; file?: string; bytes?: number; tool?: string }

interface World {
  defer: (fn: () => void | Promise<void>) => void
  client?: Client
  shieldDir?: string
  reference?: ShieldReference
  statusText?: string
  result?: { shielded: boolean; text: string }
  remaining?: string[]
}

const BIG = `the shielded haystack sentinel ${'x'.repeat(4096)}`

export const outputShieldingDefiner = (reg: Registry<World>): void => {
  async function servedJournal(w: World, opts: Record<string, unknown>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    const server = createServer(store, opts)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await server.connect(st)
    await client.connect(ct)
    w.defer(async () => {
      await client.close()
      await server.close()
      await store.close()
    })
    w.client = client
  }

  // Merged: both shielded-response scenarios share this Given.
  reg.define(/^a served journal with shielding at a small threshold$/, async (w) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    w.shieldDir = join(dir, 'shield')
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    const server = createServer(store, { shieldThreshold: 512, shieldDir: w.shieldDir })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await server.connect(st)
    await client.connect(ct)
    w.defer(async () => {
      await client.close()
      await server.close()
      await store.close()
    })
    w.client = client
  })

  // Merged: both shielded-response scenarios stage the same oversized entry.
  reg.define(/^an entry large enough to cross it$/, async (w) => {
    await w.client!.callTool({ name: 'treecontext_insert', arguments: { content: BIG } })
  })

  reg.define(/^a served journal with shielding enabled and no shield directory configured$/, async (w) => {
    // Scoped HOME redirect: the default shield dir resolves from
    // homedir() when the server constructs its config, so the sandboxed
    // home must be current during this scenario — restored by defer.
    const home = mkdtempSync(join(tmpdir(), 'tc-shield-lockdown-'))
    w.defer(() => rmSync(home, { recursive: true, force: true }))
    const restore = redirectHome(home)
    w.defer(restore)
    await servedJournal(w, { shieldThreshold: 512 })
    await w.client!.callTool({ name: 'treecontext_insert', arguments: { content: BIG } })
    w.shieldDir = join(home, '.treecontext', 'shield')
  })

  reg.define(/^a served journal whose shield threshold is a single byte$/, async (w) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const db = wrapBetterSqlite(new BetterSqlite3(join(dir, 'store.db')))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    const server = createServer(store, { shieldThreshold: 1, shieldDir: join(dir, 'shield') })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await server.connect(st)
    await client.connect(ct)
    w.defer(async () => {
      await client.close()
      await server.close()
      await store.close()
    })
    w.client = client
  })

  reg.define(/^a shield threshold equal to the response's byte count$/, (w) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    w.shieldDir = join(dir, 'shield')
  })

  reg.define(/^a shield directory that cannot be created$/, (w) => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const blockedDir = join(dir, 'not-a-dir')
    writeFileSync(blockedDir, 'a file where the directory must go')
    w.shieldDir = blockedDir
  })

  reg.define(
    /^a served stdio journal whose shield directory holds an aged minted file, a young minted file, and an aged foreign one$/,
    async (w) => {
      const dir = mkdtempSync(join(tmpdir(), 'tc-shield-scenario-'))
      w.defer(() => rmSync(dir, { recursive: true, force: true }))
      const fakeHome = mkdtempSync(join(tmpdir(), 'tc-shield-lockdown-'))
      w.defer(() => rmSync(fakeHome, { recursive: true, force: true }))
      const shieldDir = join(dir, 'shield-sweep')
      mkdirSync(shieldDir, { recursive: true })
      const agedMinted = join(shieldDir, 'treecontext_query-1700000000000-deadbeef.json')
      const youngMinted = join(shieldDir, 'treecontext_export-1700000000001-cafe1234.json')
      const agedForeign = join(shieldDir, 'run-1723600000-abcd1234.json')
      for (const f of [agedMinted, youngMinted, agedForeign]) writeFileSync(f, '{}\n')
      // fs timestamps are epoch SECONDS here — ms values land in the
      // far future and the file reads as brand new forever.
      const aged = Math.floor((Date.now() - 2 * 3_600_000) / 1000)
      utimesSync(agedMinted, aged, aged)
      utimesSync(agedForeign, aged, aged)
      // The sweep hangs off stdin-end in the stdio branch only — no
      // InMemoryTransport path reaches it — so the contract is driven
      // through a real server process. Env and loader come from the
      // shared spawn harness: the hand-rolled scrub this replaced had
      // drifted from LEAK_KEYS and left TREECONTEXT_PROJECT_DIR standing.
      const tsRoot = fileURLToPath(new URL('../../', import.meta.url))
      const child = spawnNodeTsAsync(
        CLI_TS,
        ['serve', '--transport', 'stdio', '--lexical',
          '--store', 'shield-sweep-probe', '--no-capture',
          '--shield-threshold', '512', '--shield-dir', shieldDir],
        { home: fakeHome, cwd: tsRoot },
      )
      child.stdout.resume()
      // Ending stdin before the shutdown listeners attach races the
      // boot: the transport sees EOF first and the event loop drains
      // with exit 0 and no sweep. Hold stdin until the server announces
      // its transport — a diagnostic, so under D258 it lands in the
      // sandbox HOME's log file, not on stderr — after the stdin
      // handlers went on (plus a tick of grace) so shutdown runs the sweep.
      const exited = new Promise<never>((_, reject) => {
        child.once('exit', (code) => reject(new Error(`server exited before ready (code ${code})`)))
      })
      // The clean exit after stdin closes settles this too; only the race reads it.
      exited.catch(() => { /* observed by the race below */ })
      const seen = await Promise.race([waitForServeLog(fakeHome, 'stdio transport connected'), exited])
      if (!seen.includes('stdio transport connected')) throw new Error(`server never announced its transport:\n${seen}`)
      await new Promise((r) => setTimeout(r, 300))
      child.stdin.end()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sweep-probe server did not exit')), 25_000)
        child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`exit ${code}`)) })
      })
      w.remaining = readdirSync(shieldDir).sort()
    },
  )

  reg.define(/^the journal is queried for that entry$/, async (w) => {
    const res = await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'shielded haystack sentinel', top_k: 1 } })
    w.reference = parseToolResult<ShieldReference>(res)
  })

  reg.define(/^an oversize query response is shielded$/, async (w) => {
    const res = await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'shielded haystack sentinel', top_k: 1 } })
    w.reference = parseToolResult<ShieldReference>(res)
  })

  reg.define(/^status is asked for$/, async (w) => {
    w.statusText = toolResultText(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
  })

  reg.define(/^the response is considered for shielding$/, (w) => {
    const text = 'exactly-this-many-bytes'
    // The staged directory verbatim: the Given already spelled the
    // `shield` segment, and appending a second one aimed the config at a
    // directory nothing else knows. Unreachable today (this response is
    // exactly at the threshold, and shieldResponse returns before it
    // touches shieldDir) — which is why the wrong path stayed green.
    const config = defaultShieldConfig({
      thresholdBytes: Buffer.byteLength(text, 'utf8'),
      shieldDir: w.shieldDir!,
    })
    w.result = shieldResponse('treecontext_query', text, config)
  })

  reg.define(/^an oversize response is considered for shielding$/, (w) => {
    const config = defaultShieldConfig({ thresholdBytes: 8, shieldDir: w.shieldDir! })
    w.result = shieldResponse('treecontext_query', BIG, config)
  })

  reg.define(/^the whole journal is exported, its secrets warning acknowledged$/, async (w) => {
    // The whole journal, its secrets warning acknowledged (D177): the
    // export large enough to need shielding.
    const res = await w.client!.callTool({ name: 'treecontext_export', arguments: { form: 'whole', secrets_acknowledged: true } })
    w.reference = parseToolResult<ShieldReference>(res)
  })

  reg.define(/^the server shuts down cleanly$/, (w) => {
    expect(w.remaining!.length).toBeGreaterThan(0)
  })

  reg.define(/^the response is a reference naming the file, the bytes, and the tool$/, (w) => {
    expect(w.reference!.shielded).toBe(true)
    expect(w.reference!.tool).toBe('treecontext_query')
    expect(w.reference!.bytes).toBeGreaterThan(512)
    expect(w.reference!.file).toContain(w.shieldDir!)
  })

  reg.define(/^the file holds the full response verbatim$/, (w) => {
    const onDisk = readFileSync(w.reference!.file!, 'utf8')
    expect(Buffer.byteLength(onDisk, 'utf8')).toBe(w.reference!.bytes)
    expect(onDisk).toContain('shielded haystack sentinel')
  })

  reg.define(/^the file's path is inside the home treecontext shield directory$/, (w) => {
    expect(w.reference!.file!.startsWith(w.shieldDir!)).toBe(true)
  })

  reg.define(/^the full status report comes back inline$/, (w) => {
    const status = JSON.parse(w.statusText!) as Record<string, unknown>
    expect(status['shielded']).toBeUndefined()
    expect(status['total_nodes']).toBeDefined()
  })

  reg.define(/^it passes through unshielded$/, (w) => {
    expect(w.result!.shielded).toBe(false)
    expect(w.result!.text).toBe('exactly-this-many-bytes')
  })

  reg.define(/^the full response comes back inline$/, (w) => {
    expect(w.result!.shielded).toBe(false)
    expect(w.result!.text).toBe(BIG)
  })

  reg.define(/^the response is a reference and the file holds the full export$/, (w) => {
    expect(w.reference!.shielded).toBe(true)
    expect(w.reference!.tool).toBe('treecontext_export')
    expect(readFileSync(w.reference!.file!, 'utf8')).toContain('shielded haystack sentinel')
  })

  reg.define(/^only the aged minted file is gone and the young and foreign files survive$/, (w) => {
    expect(w.remaining).toEqual([
      'run-1723600000-abcd1234.json',
      'treecontext_export-1700000000001-cafe1234.json',
    ])
  })
}
