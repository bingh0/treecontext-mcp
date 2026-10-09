/**
 * The recency-ruling instrument (src/server/query-telemetry.ts): each MCP
 * query appends one JSONL line next to the store file; un-fused relevance
 * queries also record a shadow fusion at the reference weight. The
 * contract under test: lines are written and shaped, the shadow arm
 * appears exactly when it should, opt-out works, and the response the
 * caller sees is never touched by any of it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BetterSqlite3 from 'better-sqlite3'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../../src/server/server.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { SHADOW_RECENCY_WEIGHT, recordQueryTelemetry, telemetryPath } from '../../src/server/query-telemetry.js'
import { itPosix } from '../helpers/platform.js'

interface TelemetryLine {
  ts: number
  q: string
  top_k: number
  recency_weight: number
  returned: number
  ages_d: number[]
  roles: string[]
  shadow?: { weight: number; overlap: number; top1_pos: number; ages_d: number[] }
}

describe('query telemetry (recency-ruling instrument)', () => {
  let dir: string
  let dbPath: string
  let store: FlatStore
  let client: Client
  let closers: Array<() => Promise<void> | void>
  const envBefore = process.env['TREECONTEXT_QUERY_TELEMETRY']

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-telemetry-'))
    dbPath = join(dir, 'journal.db')
    store = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(dbPath)),
      ownsDatabase: true,
    })
    const now = Date.now() / 1000
    await store.insert('the turbine schedule was revised last quarter', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's1' },
      createdAt: now - 30 * 86_400,
    })
    await store.insert('the turbine schedule holds for this sprint', {
      metadata: { source: 'auto-capture', role: 'user', session_id: 's2' },
      createdAt: now,
    })
    const server = createServer(store, { info: { storePath: dbPath } })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'telemetry-test', version: '0' })
    await server.connect(st)
    await client.connect(ct)
    closers = [() => client.close(), () => server.close(), () => store.close()]
  })

  afterEach(async () => {
    for (const c of closers) await c()
    rmSync(dir, { recursive: true, force: true })
    if (envBefore === undefined) delete process.env['TREECONTEXT_QUERY_TELEMETRY']
    else process.env['TREECONTEXT_QUERY_TELEMETRY'] = envBefore
  })

  const lines = (): TelemetryLine[] =>
    readFileSync(telemetryPath(dbPath), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as TelemetryLine)

  const runQuery = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'treecontext_query', arguments: { query: 'turbine schedule', top_k: 5, ...args } })
    return JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>
  }

  it('an explicit opt-out records the shadow arm at the default weight', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '1'
    const response = await runQuery({ recency_weight: 0 })
    const [line] = lines()
    expect(line!.q).toBe('turbine schedule')
    expect(line!.recency_weight).toBe(0)
    expect(line!.returned).toBe(2)
    expect(line!.ages_d).toHaveLength(2)
    expect(line!.roles).toEqual(['user', 'user'])
    expect(line!.shadow?.weight).toBe(SHADOW_RECENCY_WEIGHT)
    expect(line!.shadow?.ages_d).toHaveLength(2)
    expect(line!.shadow?.top1_pos).toBeGreaterThanOrEqual(0)
    // Observation only: nothing telemetry-shaped leaks into the response.
    expect(Object.keys(response).sort()).toEqual(['results'])
  })

  it('an omitted recency_weight serves and records the 0.5 default (ruling 2026-08-01)', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '1'
    await runQuery({})
    const [line] = lines()
    expect(line!.recency_weight).toBe(0.5)
    expect(line!.shadow?.weight).toBe(0) // fused response shadows the pure lexical ordering
  })

  it('a fused query records its weight and the pure-lexical shadow', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '1'
    await runQuery({ recency_weight: 0.5 })
    const [line] = lines()
    expect(line!.recency_weight).toBe(0.5)
    expect(line!.shadow?.weight).toBe(0)
    expect(line!.shadow?.ages_d).toHaveLength(2)
  })

  it('sort_by temporal queries are served without the recency default (round-3 S4)', async () => {
    // Old strong-lexical history rows + fresh weak mentions, more matches
    // than top_k: fusion inside candidate SELECTION would evict the
    // oldest strong match from a chronological "history" answer and
    // inject a fresh weak one. The schema promises the weight applies to
    // relevance ordering only.
    const T0 = 1_700_000_000
    const ids: string[] = []
    const ins = async (text: string, key: string) => {
      ids.push((await store.insert(text, { metadata: { role: 'user', session_id: key } })).nodeId)
    }
    await ins('beacon calibration: step one, mounted the beacon rig and measured beacon drift', 'old-1')
    await ins('beacon calibration: step two, beacon offsets recomputed against the beacon reference', 'old-2')
    await ins('beacon calibration: step three, sealed the beacon housing after final beacon check', 'old-3')
    await ins('release notes drafted; one line mentions the beacon fix', 'new-1')
    await ins('sprint retro summary; beacon came up briefly', 'new-2')
    await ins('triaged issues; tagged one beacon ticket', 'new-3')
    const raw = new BetterSqlite3(dbPath)
    const at = raw.prepare('UPDATE nodes SET created_at = ? WHERE node_id = ?')
    const stamps = [T0, T0 + 3600, T0 + 7200, T0 + 30 * 86_400 + 180, T0 + 30 * 86_400 + 60, T0 + 30 * 86_400 + 120]
    ids.forEach((id, i) => at.run(stamps[i], id))
    raw.close()
    const q = async (args: Record<string, unknown>) => {
      const r = await runQuery({ query: 'history of the beacon calibration', top_k: 3, conversation_window: 0, ...args })
      return (r['results'] as Array<{ nodeId: string }>).map((x) => x.nodeId)
    }
    const served = await q({ sort_by: 'chronological' })
    expect(served).toEqual(await q({ sort_by: 'chronological', recency_weight: 0 }))
    expect(served).toEqual(ids.slice(0, 3)) // the actual history, oldest first
    const servedRev = await q({ sort_by: 'reverse_chronological' })
    expect(servedRev).toEqual(await q({ sort_by: 'reverse_chronological', recency_weight: 0 }))
  })

  it('a non-relevance ordering records no shadow arm', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '1'
    await runQuery({ sort_by: 'reverse_chronological' })
    const [line] = lines()
    expect(line!.shadow).toBeUndefined()
  })

  it('the sink is OFF unless explicitly opted in', async () => {
    delete process.env['TREECONTEXT_QUERY_TELEMETRY']
    await runQuery({})
    expect(existsSync(telemetryPath(dbPath))).toBe(false)
  })

  it('TREECONTEXT_QUERY_TELEMETRY=0 disables the sink entirely', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '0'
    await runQuery({})
    expect(existsSync(telemetryPath(dbPath))).toBe(false)
  })

  it('the sink and the shadow never change what the caller sees', async () => {
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '1'
    const withTelemetry = await runQuery({})
    process.env['TREECONTEXT_QUERY_TELEMETRY'] = '0'
    const without = await runQuery({})
    expect(withTelemetry).toEqual(without)
  })

  itPosix('the telemetry file lands 0600 on create, never umask-default (docs/security.md §3)', () => {
    recordQueryTelemetry(dbPath, { q: 'mode-pin' })
    expect(statSync(telemetryPath(dbPath)).mode & 0o777).toBe(0o600)
  })
})
