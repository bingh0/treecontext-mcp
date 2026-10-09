/**
 * telemetry-privacy.feature bindings — gherkin-node-test executor.
 * (Executor-migration Phase 2, 2026-08-26: translated from the
 * vitest-cucumber binding; every assertion preserved verbatim.)
 *
 * Privacy pins (F3): no content in stats, server-bounded keys, no sink
 * without consent, and the 40-character bound on the debug-log fragment
 * the opt-in creates. session-stats.test.ts proves the arithmetic;
 * query-telemetry.test.ts proves the opt-in line shape.
 *
 * The fragment scenario cannot run in this worker: the debug sink's
 * directory freezes from homedir() at import (src/debug.ts), and other
 * steps modules have already imported the module graph with the real
 * home. It drives the same served surface through a fresh process whose
 * HOME is redirected before any module evaluates — see
 * helpers/telemetry-fragment-child.ts.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { Registry } from 'gherkin-node-test/vitest'

import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { createServer } from '../../src/server/server.js'
import { telemetryPath } from '../../src/server/query-telemetry.js'
import { SessionStats } from '../../src/server/session-stats.js'
import { spawnNodeTs } from '../helpers/cli-spawn.js'
import { parseToolResult } from '../helpers/mcp-result.js'
import { fileURLToPath } from 'node:url'

const CHILD_TS = fileURLToPath(new URL('../helpers/telemetry-fragment-child.ts', import.meta.url))

const GATE = 'TREECONTEXT_QUERY_TELEMETRY'

interface World {
  defer: (fn: () => void | Promise<void>) => void
  client?: Client
  storePath?: string
  status?: Record<string, unknown>
  stats?: Record<string, unknown>
  bySource?: Record<string, number>
  fakeHome?: string
  telemetryLines?: string[]
}

export const telemetryPrivacyDefiner = (reg: Registry<World>): void => {
  /** Capture-and-restore hygiene for the opt-in gate, per scenario. */
  function setGate(w: World, value: string | undefined): void {
    const prev = process.env[GATE]
    w.defer(() => {
      if (prev === undefined) delete process.env[GATE]
      else process.env[GATE] = prev
    })
    if (value === undefined) delete process.env[GATE]
    else process.env[GATE] = value
  }

  async function servedJournal(w: World): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'tc-telemetry-scenario-'))
    w.defer(() => rmSync(dir, { recursive: true, force: true }))
    const storePath = join(dir, 'store.db')
    const db = wrapBetterSqlite(new BetterSqlite3(storePath))
    const store = await FlatStore.open({ database: db, ownsDatabase: true })
    // info.storePath is the telemetry sink's anchor — the serve path
    // always passes it, so the harness does too. A fresh SessionStats per
    // harness: the module-level instance is a process singleton, and a
    // count pinned to "exactly 1" must not read a previous scenario's
    // inserts.
    const server = createServer(store, { info: { storePath }, sessionStats: new SessionStats() })
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
    w.storePath = storePath
  }

  reg.define(/^a served journal that has captured a distinctive query and entry$/, async (w) => {
    setGate(w, undefined)
    await servedJournal(w)
    const sentinel = 'the cobalt heron audits the ledger'
    await w.client!.callTool({ name: 'treecontext_insert', arguments: { content: sentinel } })
    await w.client!.callTool({ name: 'treecontext_query', arguments: { query: sentinel, top_k: 1 } })
  })

  reg.define(/^an entry inserted with a source of the caller's invention$/, async (w) => {
    setGate(w, undefined)
    await servedJournal(w)
    await w.client!.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'an entry', metadata: { source: 'my-invented-source' } },
    })
  })

  reg.define(/^a served journal with no telemetry opt-in$/, async (w) => {
    setGate(w, undefined)
    await servedJournal(w)
    await w.client!.callTool({ name: 'treecontext_insert', arguments: { content: 'quiet entry' } })
  })

  reg.define(/^telemetry is opted in and a query far longer than the bound runs$/, (w) => {
    setGate(w, '1')
    const longQuery = 'aurora basilisk chandelier dromedary estuary foxglove gargoyle harpsichord icicle juniper'
    const fakeHome = mkdtempSync(join(tmpdir(), 'tc-telemetry-privacy-'))
    w.defer(() => rmSync(fakeHome, { recursive: true, force: true }))
    w.fakeHome = fakeHome
    const child = spawnNodeTs(CHILD_TS, [longQuery], {
      home: fakeHome,
      env: { [GATE]: '1' },
    })
    // Fixture precondition: the isolated query process must have run its
    // served surface cleanly, or the log assertions below would grade an
    // empty directory.
    expect(child.status, `fragment child failed: ${child.stderr}`).toBe(0)
  })

  // Shared by the two stats scenarios: one status call per scenario,
  // each Then reads its slice of the same parsed report.
  reg.define(/^status reports the session stats$/, async (w) => {
    const res = await w.client!.callTool({ name: 'treecontext_status', arguments: {} })
    w.status = parseToolResult(res)
  })

  reg.define(/^a query runs$/, async (w) => {
    await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'quiet entry', top_k: 1 } })
  })

  reg.define(/^the debug log's telemetry line is read$/, (w) => {
    const logsDir = join(w.fakeHome!, '.treecontext', 'logs')
    w.telemetryLines = readdirSync(logsDir)
      .flatMap((f) => readFileSync(join(logsDir, f), 'utf8').split('\n'))
      .filter((l) => l.includes('query-telemetry'))
  })

  reg.define(/^the stats hold totals and latencies$/, (w) => {
    w.stats = w.status!['session_stats'] as Record<string, unknown>
    const query = w.stats!['query'] as { total: number; byMode: Record<string, number> }
    expect(query.total).toBeGreaterThanOrEqual(1)
    expect(Object.keys(query.byMode)).toEqual(['bm25'])
    expect((w.stats!['insert'] as { total: number }).total).toBeGreaterThanOrEqual(1)
  })

  reg.define(/^the distinctive text appears nowhere in them$/, (w) => {
    const flat = JSON.stringify(w.stats)
    // Control (audit run 1): the serializer demonstrably renders
    // content-bearing strings — if a leak ever put the sentinel into a
    // stats value, the two absence assertions below could see it.
    expect(flat).toContain('bm25')
    // step-lint: allow unearned-absence -- guarded: cobalt was seeded into telemetry content in this scenario's Given; opt-out must drop it entirely
    expect(flat).not.toContain('cobalt')
    // step-lint: allow unearned-absence -- guarded: heron seeded likewise; opt-out must drop it entirely
    expect(flat).not.toContain('heron')
  })

  reg.define(/^the insert sources are the two the server mints$/, (w) => {
    w.bySource = (w.status!['session_stats'] as { insert: { bySource: Record<string, number> } }).insert.bySource
    for (const key of Object.keys(w.bySource!)) {
      expect(['manual', 'auto-capture']).toContain(key)
    }
  })

  reg.define(/^the invented source is not among them$/, (w) => {
    expect(w.bySource!['my-invented-source']).toBeUndefined()
    expect(w.bySource!['manual']).toBe(1)
  })

  reg.define(/^no telemetry file appears beside the store$/, async (w) => {
    expect(existsSync(telemetryPath(w.storePath!))).toBe(false)
    // Control (audit run 1): the positive lives in another file — prove
    // here, in this world, that the sink path can fire. Same store, one
    // opted-in query, the file must appear; the scenario-scoped defer
    // restores the pre-scenario gate either way.
    process.env[GATE] = '1'
    await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'quiet entry', top_k: 1 } })
    expect(existsSync(telemetryPath(w.storePath!))).toBe(true)
  })

  reg.define(/^it holds the first forty characters and not the full query$/, (w) => {
    const longQuery = 'aurora basilisk chandelier dromedary estuary foxglove gargoyle harpsichord icicle juniper'
    expect(w.telemetryLines!.length).toBeGreaterThan(0)
    const joined = w.telemetryLines!.join('\n')
    expect(joined).toContain(longQuery.slice(0, 40))
    expect(joined).not.toContain(longQuery)
    // step-lint: allow unearned-absence -- guarded: juniper seeded in the child's opted-in run; only the bounded fragment may appear
    expect(joined).not.toContain('juniper')
  })
}
