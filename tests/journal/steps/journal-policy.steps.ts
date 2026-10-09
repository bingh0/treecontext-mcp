import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { type Registry } from 'gherkin-node-test/vitest'
import { wrapBetterSqlite } from '../../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../../src/flat-store.js'
import { type World, mcpOver, parseTool, openLiveStore } from '../world.js'
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import { TS_ROOT, tsxArgv, sleep, killAndWait } from '../proc.js'

// ── Policy wave: one real MCP surface per trust tier ────────────────────
//
// The claim is about ABSENCE — "a tier's excluded tools are not refused,
// they are absent" — so the assertion has to be the registered tool list a
// client actually receives over the transport, not a permission predicate.
// policyAllows() is already unit-tested; asking it here would be asking the
// implementation whether it agrees with itself.

const TC = (n: string) => `treecontext_${n}`

async function toolsUnder(w: PolicyWorld, policy: 'read_only' | 'contributor' | 'full'): Promise<string[]> {
  await openLiveStore(w)
  const client = await mcpOver(w, { policy })
  const listed = await client.listTools()
  return listed.tools.map(t => t.name).sort()
}

// Observe the capture face of a real `serve` subprocess under one policy
// tier: stage an event against its store and report what the ingestion
// loop did with it. Shared by the read_only refusal (with its full-policy
// control) and the contributor acceptance scenarios.
const observeCaptureUnder = async (policy: 'read_only' | 'contributor' | 'full') => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `tc-policy-${policy}-`)))
  const env = sandboxedSpawnEnv(home)

  const child = spawn(process.execPath, tsxArgv(
    join(TS_ROOT, 'src', 'server', 'cli.ts'), 'serve',
    '--transport', 'stdio', '--policy', policy,
    '--capture', '--lexical', '--store', 'policyprobe',
  ), { env, cwd: TS_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })

  const dbPath = join(storesDirIn(home), 'policyprobe', 'treecontext.db')
  try {
    for (let i = 0; i < 50 && !existsSync(dbPath); i++) await sleep(100)
    expect(existsSync(dbPath), `server never created its store at ${dbPath}`).toBe(true)
    await sleep(500) // let initCapture finish wiring before staging

    const probe = await FlatStore.open({
      database: wrapBetterSqlite(new BetterSqlite3(dbPath)), ownsDatabase: true,
    })
    try {
      probe.store.insertStaging({
        sessionId: 'policy-probe', role: 'user',
        content: 'a reader must not quietly become one of its writers',
        timestamp: Date.now() / 1000, priority: 1,
      })
      // The loop polls on an interval; give it real chances to run
      // before concluding it did not. A pass that depends on being too
      // quick to notice is not a pass.
      for (let i = 0; i < 24 && probe.store.countUnprocessedStaging() > 0; i++) await sleep(500)
      return {
        ingested: (await probe.query('reader must not quietly become')).length,
        unprocessed: probe.store.countUnprocessedStaging(),
      }
    } finally {
      await probe.close()
    }
  } finally {
    await killAndWait(child)()
    rmSync(home, { recursive: true, force: true })
  }
}

// All three policy probes launch together on the first request: each
// builds its own temp home and serve subprocess (independent by
// construction), and a probe costs ~7-12s of wall time (subprocess boot +
// settle + one ingestion tick) — the contributor scenario's probe used to
// run serially after the read_only/full pair, doubling the slowest part
// for nothing (review of E chunk 3). The no-op catch marks the
// not-yet-awaited promises handled so an early rejection cannot trip the
// runner's unhandled-rejection detector; awaiting the original later
// still surfaces the error in the scenario that owns it.
let captureProbes: Record<'read_only' | 'contributor' | 'full', ReturnType<typeof observeCaptureUnder>> | null = null
const captureProbe = (policy: 'read_only' | 'contributor' | 'full'): ReturnType<typeof observeCaptureUnder> => {
  if (!captureProbes) {
    captureProbes = {
      read_only: observeCaptureUnder('read_only'),
      contributor: observeCaptureUnder('contributor'),
      full: observeCaptureUnder('full'),
    }
    for (const p of Object.values(captureProbes)) p.catch(() => {})
  }
  return captureProbes[policy]
}


/**
 * The policy wave's world: one tool surface per trust tier, and what a
 * server under each tier did with a staged event. Both fields are keyed by
 * tier name because every scenario here compares tiers against each other —
 * a single-tier observation would prove nothing about exclusion.
 */
export interface PolicyWorld extends World {
  toolsByPolicy?: Record<string, string[]>
  stagedUnderPolicy?: Record<string, { ingested: number; unprocessed: number }>
}

export const policyDefiner = (reg: Registry<PolicyWorld>): void => {
  reg.define(/^a server configured with the (read_only|contributor) policy$/, async (w: PolicyWorld, policy) => {
    const tier = policy as 'read_only' | 'contributor'
    w.toolsByPolicy = { [tier]: await toolsUnder(w, tier) }
  })

  reg.define(/^it starts and registers its tool surface$/, (w: PolicyWorld) => {
    const registered = Object.values(w.toolsByPolicy!)[0]!
    expect(registered.length, 'the server registered no tools at all').toBeGreaterThan(0)
  })

  reg.define(/^query, status, and export are the only tools registered$/, (w: PolicyWorld) => {
    expect(w.toolsByPolicy!['read_only']).toEqual([TC('export'), TC('query'), TC('status')])
  })

  reg.define(/^captured events are not ingested into the journal$/, async (w: PolicyWorld) => {
    // Read-only on both faces. The gate that decides this lives in
    // startServer's initCapture, NOT in createServer — so an in-process
    // createServer never reaches it, and this clause would pass by never
    // having wired capture at all. Run the real `serve` command as a
    // subprocess, the way the MCP launcher does.
    //
    // The control matters as much as the claim: the identical event under
    // the full policy MUST ingest, or "nothing was ingested" passes for the
    // boring reason that the harness never captured anything. The first
    // draft of this binding failed exactly there, which is why it stayed.
    // All tiers run concurrently through captureProbe — separate homes,
    // separate stores, and the read_only side has to wait out the
    // ingestion interval to prove a negative, so doing them in series
    // doubles the slowest part for nothing.
    const [readOnly, full] = await Promise.all([captureProbe('read_only'), captureProbe('full')])
    w.stagedUnderPolicy = { read_only: readOnly, full }

    expect(full.ingested,
      'control failed: the same event did not ingest under the full policy either, so this scenario proves nothing')
      .toBeGreaterThan(0)
    expect(readOnly.ingested, 'a read_only server ingested a captured event').toBe(0)
    expect(readOnly.unprocessed,
      'the staged event should still be sitting unprocessed under read_only').toBeGreaterThan(0)
  })

  reg.define(/^insert is registered alongside the reading tools$/, (w: PolicyWorld) => {
    const tools = w.toolsByPolicy!['contributor']!
    for (const n of ['query', 'status', 'export', 'insert']) {
      expect(tools, `contributor is missing ${TC(n)}`).toContain(TC(n))
    }
  })

  reg.define(/^delete, clear, import, and merge are absent$/, (w: PolicyWorld) => {
    const tools = w.toolsByPolicy!['contributor']!
    for (const n of ['delete', 'clear', 'import', 'merge_from_agent']) {
      expect(tools, `contributor must not be able to call ${TC(n)}`).not.toContain(TC(n))
    }
  })

  reg.define(/^servers configured with each policy tier in turn$/, async (w: PolicyWorld) => {
    w.toolsByPolicy = {
      read_only: await toolsUnder(w, 'read_only'),
      contributor: await toolsUnder(w, 'contributor'),
      full: await toolsUnder(w, 'full'),
    }
  })

  reg.define(/^each starts and registers its tool surface$/, (w: PolicyWorld) => {
    for (const [tier, tools] of Object.entries(w.toolsByPolicy!)) {
      expect(tools.length, `${tier} registered no tools`).toBeGreaterThan(0)
    }
  })

  reg.define(/^merge_from_agent is registered only under the full policy$/, (w: PolicyWorld) => {
    expect(w.toolsByPolicy!['full'], 'full must grant the merge tool').toContain(TC('merge_from_agent'))
    for (const tier of ['read_only', 'contributor']) {
      expect(w.toolsByPolicy![tier], `${tier} must not be able to call ${TC('merge_from_agent')}`)
        .not.toContain(TC('merge_from_agent'))
    }
  })

  // ── the contributor's write faces actually function ─────────────────
  reg.define(/^a live store served under the contributor policy$/, async (w: PolicyWorld) => {
    await openLiveStore(w)
    await mcpOver(w, { policy: 'contributor' })
  })

  reg.define(/^the contributor inserts a finding through the tool surface$/, async (w: PolicyWorld) => {
    const res = parseTool(await w.client!.callTool({
      name: 'treecontext_insert',
      arguments: { content: 'contributor finding: the flange corrodes under salt spray' },
    }))
    w.nodeId = res['node_id'] as string
  })

  reg.define(/^the entry is in the store for every other reader$/, async (w: PolicyWorld) => {
    // Read through the LIBRARY handle, not the contributor's own client —
    // the write must be visible to any other consumer of the same file.
    const hits = await w.store!.query('flange corrodes salt spray')
    expect(hits.map((h) => h.nodeId), "the contributor's insert never landed").toContain(w.nodeId)
  })

  reg.define(/^a server configured with the contributor policy and capture requested$/, () => {
    // Nothing to arrange in-process: the When below runs the real `serve`
    // subprocess with --policy contributor --capture, the way the MCP
    // launcher would. This Given names the configuration under test.
  })

  reg.define(/^a captured event is staged$/, async (w: PolicyWorld) => {
    w.stagedUnderPolicy = { contributor: await captureProbe('contributor') }
  })

  reg.define(/^the event drains into the journal$/, (w: PolicyWorld) => {
    const c = w.stagedUnderPolicy!['contributor']!
    expect(c.ingested, 'the contributor server must ingest the staged event').toBeGreaterThan(0)
    expect(c.unprocessed, 'nothing may be left sitting in staging').toBe(0)
  })

  // ── reliance bookkeeping is a full-only write ───────────────────────
  reg.define(/^a store holding an entry that later sessions fetch by id$/, async (w: PolicyWorld) => {
    await openLiveStore(w)
    w.nodeId = (await w.store!.insert('the load-bearing decision every later session fetches')).nodeId
  })

  reg.define(/^a contributor server exports the entry twice$/, async (w: PolicyWorld) => {
    const client = await mcpOver(w, { policy: 'contributor' })
    for (let i = 0; i < 2; i++) {
      // The exports must demonstrably happen: server refusals come back
      // as isError envelopes rather than throws (house style), so a
      // discarded result would let a policy regression that removes
      // contributor export certify the no-stamp contract vacuously
      // (review of E chunk 3).
      const exported = parseTool(await client.callTool({
        name: 'treecontext_export', arguments: { node_id: w.nodeId },
      })) as { nodes?: Array<{ nodeId?: string }> }
      expect(exported.nodes?.[0]?.nodeId, 'the contributor export must return the node').toBe(w.nodeId)
    }
  })

  // The probe itself must not bump the meter it measures: an id export
  // with recordReliance: false is the caller-side opt-out the policy
  // gate rides on, so reading the row this way leaves the count honest.
  const reliedCountOfRow = (w: PolicyWorld): unknown => {
    const parsed = JSON.parse(w.store!.exportJson({ nodeId: w.nodeId!, recordReliance: false })) as {
      nodes: Array<{ metadata: Record<string, unknown> | null }>
    }
    return parsed.nodes[0]!.metadata?.['_relied_count']
  }

  reg.define(/^the row carries no reliance count$/, (w: PolicyWorld) => {
    expect(reliedCountOfRow(w), 'a contributor export must leave no reliance trace').toBeUndefined()
  })

  reg.define(/^the same two fetches through a full server stamp it$/, async (w: PolicyWorld) => {
    const client = await mcpOver(w, { policy: 'full' })
    for (let i = 0; i < 2; i++) {
      await client.callTool({ name: 'treecontext_export', arguments: { node_id: w.nodeId } })
    }
    expect(reliedCountOfRow(w), 'the identical fetches under full must record the reliance').toBe(2)
  })
}

