import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { parseTool, rawAll } from '../world.js'
import { runHook, bashPayload, drainStaging } from '../capture-harness.js'
import { RUN_ROWS_SQL, charactersOf } from '../../../src/runs.js'
import { KEY_LOOKUP_PARAM, keyLookupReply, type KeyLookup, type KeyLookupReply } from '../../../src/key-lookup.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { STORE_WRITER } from '../../../src/persistence/session-registry.js'
import {
  type RunWorld, openRunWorld, hooksLeg, workerLeg, seedCheckpoints, sessionClient, localMoment, readerOf,
  rawOne, rawMetaOf, rawContentOf, rawRowOf, rawRegistration, rawCheckpoints, cpLabel, stringSteps, insertEchoed, subagentStopHook,
} from '../run-world.js'
import { runWorker } from './journal-workers.steps.js'

// ── journal-runs ────────────────────────────────────────────────────────
//
// A run as a unit (D289, D302, D309, D311): its open and close are journal
// rows, its legs name it on their registrations, a captured row reaches it
// through its leg's lane, and anyone with the file reads it back by plain
// SQL in the order of each row's own moment.
//
// The harness here is a program with the library and no model: it spawns
// workers through registerWorker (the library door a spawner registers
// through), writes and reads checkpoints through the library, and opens
// and closes runs through openRun and closeRun. A hooks-door leg is
// registered by the real SubagentStart hook and given its run and key by
// the registry call the hooks door makes. Every Then reads the store file
// through a separate read-only handle, the harness's lookup, or the agent's
// own query tool. The lookup's whole reply (D296, D301, D312, D336, D337,
// D344) is read twice: as the harness receives it through the library
// (lookupKey, and keyLookupReply for the plain reply), and as an agent
// receives it through the query tool's key_lookup mode; a leg's return is
// the summary row the real SubagentStop hook staged and the drain wrote.

export type RunsWorld = RunWorld

type Hit = { nodeId: string; content: string; metadata: Record<string, unknown> | null }

const HOUR = 3600

/** Words a reply that judged a leg's liveness would use (D312: the store
 *  shows the moments and judges nothing). */
const VERDICT_NEEDLE = /stuck|hung|stall|idle|slow|unresponsive|timed? ?out/i

/** The harness's one lookup of the scenario, by the run it asked on. */
function harnessLookup(w: RunsWorld, run = 'r1'): KeyLookup {
  const l = w.lookups![run]
  expect(l, `the harness never looked up a key on the run "${run}"`).toBeTruthy()
  return l!
}

/** A checkpoint's text of exactly `size` characters. */
function sized(label: string, size: number): string {
  const head = `state: ${label}; `
  return head.length >= size ? head.slice(0, size) : head + 'x'.repeat(size - head.length)
}

/** The sizes of a key's checkpoints straight from the file, by number. */
function rawSizes(w: RunsWorld, run: string, key: string): number[] {
  return rawCheckpoints(w, run, key).sort((a, b) => a.n - b.n).map((c) => charactersOf(rawContentOf(w, c.node_id)))
}

async function query(w: RunsWorld, q: string, extra: Record<string, unknown> = {}): Promise<Hit[]> {
  await sessionClient(w)
  const read = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: q, top_k: 10, ...extra } }))
  return read['results'] as Hit[]
}

/** The ids of every row a run is made of, by the reader's recipe. */
function runRowIds(w: RunsWorld, run: string): Set<string> {
  return new Set(rawAll<{ node_id: string }>(w, RUN_ROWS_SQL, run, run).map((r) => r.node_id))
}

function openRowOf(w: RunsWorld, run: string): { node_id: string; created_at: number; m: Record<string, unknown> } {
  const r = rawOne<{ node_id: string; created_at: number; m: string }>(w,
    "SELECT node_id, created_at, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)
  expect(r, `no open row for the run "${run}" in the store file`).toBeTruthy()
  return { node_id: r!.node_id, created_at: r!.created_at, m: JSON.parse(r!.m) as Record<string, unknown> }
}

/** A reader's walk of a run with plain SQL: its legs, the runs those legs
 *  say they opened, and theirs, to any depth (D311). */
function walk(w: RunsWorld, run: string): Record<string, Array<Record<string, unknown>>> {
  const raw = readerOf(w)
  const out: Record<string, Array<Record<string, unknown>>> = {}
  const todo = [run]
  while (todo.length > 0) {
    const r = todo.shift()!
    if (out[r]) continue
    const legs = raw.prepare('SELECT * FROM session_registry WHERE run = ? ORDER BY started_at').all(r) as Array<Record<string, unknown>>
    out[r] = legs
    for (const leg of legs) for (const inner of JSON.parse(String(leg['opened_runs'] ?? '[]')) as string[]) todo.push(inner)
  }
  return out
}

/** A worker of a run that writes its checkpoint under the key and is
 *  retired at exit, its start the checkpoint in effect before it. */
async function finishedWorker(w: RunsWorld, name: string, role: string, run: string, key: string, text: string): Promise<string> {
  const start = w.store!.checkpointsInEffect(run, key).map((c) => c.nodeId)
  const ref = await workerLeg(w, name, { role, run, key, startCheckpoints: start })
  const r = await w.store!.writeCheckpoint(text, { run, key, leg: ref })
  w.cps![cpLabel(run, key, r.checkpoint!.number)] = r.nodeId
  expect(w.store!.retireLeg(ref, 'retired')).toBe(true)
  return r.nodeId
}

export const runsDefiner = (reg: Registry<RunsWorld>): void => {
  const define = stringSteps(reg)

  // ── D309: a run found by time through the rows the ticket door wrote ──
  //
  // Each worker is a real process (the stand-in) started through the real
  // ticket door, the library call; the door's clock is set to the run's
  // own day, so the first-moment rows, the registrations and the summary
  // rows carry that day's moments, and the stand-in writes its checkpoint
  // at a moment of the same day. Nothing else is staged.

  /** The local start of the most recent Tuesday before today. */
  const lastTuesday = (): number => {
    const d = new Date()
    const back = ((d.getDay() - 2 + 7) % 7) || 7
    d.setDate(d.getDate() - back)
    d.setHours(0, 0, 0, 0)
    return d.getTime() / 1000
  }

  define(/^a store holding a run from last Tuesday with (\d+) first-moment rows, and runs from other days$/, async (w, n) => {
    await openRunWorld(w)
    const tuesday = lastTuesday()
    w.moments!['tuesday'] = tuesday
    const day = [
      { run: 'the-tuesday-run', base: tuesday + 10 * HOUR, workers: Number(n) },
      { run: 'the-monday-run', base: tuesday - 14 * HOUR, workers: 1 },
      { run: 'the-latest-run', base: null, workers: 1 },
    ]
    const keys = ['login-form', 'login-api', 'login-tests']
    for (const d of day) {
      for (let i = 0; i < d.workers; i++) {
        let t = (d.base ?? Date.now() / 1000) + i * 600
        const clock = d.base === null ? undefined : (): number => (t += 1)
        const key = keys[i % keys.length]!
        await runWorker(w, {
          spawner: 'library', prompt: `build the login piece ${key} for ${d.run}`,
          ticket: { run: d.run, key, role: 'builder', checkpointer: 'builder', parent: { id: w.sessionId! } },
          plan: { first: { checkpoint: `state: login piece ${key} done`, print: `login piece ${key} done`, ...(d.base !== null ? { at: t + 30 } : {}) } },
          ...(clock ? { clock } : {}),
        }, `${d.run}:${i}`)
      }
    }
  })

  define(/^an agent queries for what ran last Tuesday$/, async (w) => {
    const after = w.moments!['tuesday']!
    w.facts!['hits'] = await query(w, 'login piece', { top_k: 20, time_range: { after, before: after + 24 * HOUR } })
  })

  define(/^the agent's hits include that run's (\d+) first-moment rows, each carrying the run and its key$/, (w, n) => {
    const hits = w.facts!['hits'] as Hit[]
    const firsts = hits.filter((h) => h.metadata?.['kind'] === 'first-moment')
    expect(firsts).toHaveLength(Number(n))
    expect(new Set(firsts.map((h) => h.metadata!['run']))).toEqual(new Set(['the-tuesday-run']))
    expect(firsts.map((h) => h.metadata!['key']).sort()).toEqual(['login-api', 'login-form', 'login-tests'])
    // The rows are the ones the door wrote, at the run's own moments,
    // and nothing from another day's run is among the hits.
    const tuesday = w.moments!['tuesday']!
    for (const h of firsts) {
      const r = rawOne<{ t: number; s: string }>(w, 'SELECT created_at AS t, source_label AS s FROM nodes WHERE node_id = ?', h.nodeId)!
      expect(r.t).toBeGreaterThanOrEqual(tuesday)
      expect(r.t).toBeLessThan(tuesday + 24 * HOUR)
      expect(r.s).toBe('auto-capture')
    }
    expect(hits.every((h) => h.metadata?.['run'] === undefined || h.metadata['run'] === 'the-tuesday-run')).toBe(true)
    w.facts!['found-run'] = firsts[0]!.metadata!['run']
  })

  define(/^a query filtered by the run those rows carry returns the run's checkpoints and summary rows$/, async (w) => {
    const run = w.facts!['found-run'] as string
    const hits = await query(w, 'login piece', { top_k: 20, metadata_filter: { run } })
    const want = rawAll<{ node_id: string }>(w,
      `SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.run') = ? AND json_extract(metadata_json, '$.kind') IN ('checkpoint', ?)`, run, SUBAGENT_SUMMARY_KIND)
      .map((r) => r.node_id)
    expect(want).toHaveLength(6)
    const got = new Set(hits.map((h) => h.nodeId))
    for (const id of want) expect(got.has(id), `the run's row ${id} among the filtered hits`).toBe(true)
    expect(hits.every((h) => h.metadata?.['run'] === run)).toBe(true)
  })
  // ── D289: the harness's lookup, by run and key, with no model ──

  define(/^a run "([^"]+)" with (\d+) legs, all exited, whose key "([^"]+)" holds checkpoints number 1 to (\d+), number \4 written by the reviewer role$/, async (w, run, legs, key, last) => {
    await openRunWorld(w, { sessionStart: false })
    const n = Number(last)
    expect(Number(legs)).toBe(n)
    for (let i = 1; i <= n; i++) {
      await finishedWorker(w, `${run}-leg${i}`, i === n ? 'reviewer' : 'builder', run!, key!, `state after leg ${i} of ${run}: part ${i} done`)
    }
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds its own checkpoint number (\d+) and a live builder leg$/, async (w, run, key, num) => {
    await openRunWorld(w, { sessionStart: false })
    for (let i = 1; i <= Number(num); i++) await finishedWorker(w, `${run}-done${i}`, 'builder', run!, key!, `state of ${run}: own part ${i}`)
    await workerLeg(w, `${run}-live`, { role: 'builder', run: run!, key: key!, startCheckpoints: w.store!.checkpointsInEffect(run!, key!).map((c) => c.nodeId) })
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds no checkpoint and one live builder leg$/, async (w, run, key) => {
    await openRunWorld(w, { sessionStart: false })
    await workerLeg(w, `${run}-live`, { role: 'builder', run: run!, key: key!, startCheckpoints: [] })
    // Checkpoints under other keys and other runs, which an honest nothing
    // must not borrow from.
    await seedCheckpoints(w, run!, 'login-form', 2)
    await seedCheckpoints(w, 'r9', key!, 2)
  })

  define(/^a harness with no model asks for the checkpoint in effect under the key "([^"]+)" on the run "([^"]+)"$/, (w, key, run) => {
    w.lookups![run!] = w.store!.lookupKey({ run: run!, key: key! })
  })

  define(/^the harness receives checkpoint number (\d+) of "([^"]+)" with the writer "([^"]+)", never the checkpoint of "([^"]+)"$/, (w, num, run, writer, other) => {
    const l = w.lookups![run!]!
    expect(l.checkpoints).toHaveLength(1)
    const cp = l.checkpoints[0]!
    expect(cp.nodeId).toBe(w.cps![cpLabel(run!, l.key, Number(num))])
    expect(cp.number).toBe(Number(num))
    expect(cp.writer).toBe(writer)
    // The file agrees: that row is the reviewer's, numbered so by the store.
    const m = rawMetaOf(w, cp.nodeId)
    expect([m['_writer'], m['_checkpoint_number'], m['run']]).toEqual([writer, Number(num), run])
    const others = Object.entries(w.cps!).filter(([label]) => label.startsWith(`${other}:`)).map(([, id]) => id)
    expect(others.length).toBeGreaterThan(0)
    for (const id of others) expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(id)
  })

  define(/^the harness sees each of the (\d+) legs of "([^"]+)" as retired$/, (w, n, run) => {
    const l = w.lookups![run!]!
    expect(l.legs).toHaveLength(Number(n))
    for (const leg of l.legs) expect(leg.state).toBe('retired')
    for (const r of rawAll<{ stopped_at: number | null; ended: string | null }>(w, 'SELECT stopped_at, ended FROM session_registry WHERE run = ?', run)) {
      expect(r.ended).toBe('retired')
      expect(r.stopped_at).not.toBeNull()
    }
  })

  define(/^the same harness asking on the run "([^"]+)" sees its builder leg as live$/, (w, run) => {
    const l = w.store!.lookupKey({ run: run!, key: 'login-form' })
    const live = l.legs.filter((leg) => leg.state === 'live')
    expect(live.map((leg) => leg.role)).toEqual(['builder'])
    const r = rawRegistration(w, w.legs![`${run}-live`]!)
    expect([r['ended'], r['stopped_at']]).toEqual([null, null])
  })

  define(/^the harness receives no checkpoint and a line saying none is in effect under "([^"]+)"$/, (w, key) => {
    const l = Object.values(w.lookups!)[0]!
    expect(l.checkpoints).toEqual([])
    expect(l.line).toContain('No checkpoint is in effect')
    expect(l.line).toContain(`"${key}"`)
  })

  define(/^the harness sees the builder leg as live$/, (w) => {
    const l = Object.values(w.lookups!)[0]!
    expect(l.legs.map((leg) => [leg.role, leg.state])).toEqual([['builder', 'live']])
  })

  define(/^the harness receives no checkpoint of any other key or run$/, (w) => {
    const l = Object.values(w.lookups!)[0]!
    // There were checkpoints to borrow: two under another key, two under another run.
    expect(Object.keys(w.cps!).length).toBe(4)
    expect(l.checkpoints).toHaveLength(0)
  })

  // ── D289: the run read back by plain SQL ──

  define(/^a run "([^"]+)" whose builder leg wrote a row at (\d\d:\d\d:\d\d) that the drain ingested after the reviewer's row of (\d\d:\d\d:\d\d)$/, async (w, run, builderAt, reviewerAt) => {
    await openRunWorld(w)
    // The builder: a hooks-door leg of the session, captured by the real
    // PostToolUse hook with its agent fields, dated where the scenario
    // needs it (the hook stamps its own clock), and drained LAST.
    const builder = await hooksLeg(w, 'builder', 'builder', { run: run!, key: 'login-form' })
    runHook(w, 'post-tool-use', { ...bashPayload(w, 'npx vitest run login', 'login form: 12 passed (zebrafinch)'), agent_id: builder.agentId, agent_type: 'builder' })
    const tBuilder = localMoment(builderAt!)
    const tReviewer = localMoment(reviewerAt!)
    const rw = new DatabaseSync(w.dbPath!)
    try {
      const staged = rw.prepare("UPDATE staging SET timestamp = ? WHERE processed = 0 AND agent_id = ? AND content LIKE '%zebrafinch%'").run(tBuilder, builder.agentId)
      expect(staged.changes).toBe(1)
    } finally { rw.close() }
    // The reviewer: a worker of the same run under the same parent session,
    // whose checkpoint lands in the journal before the drain runs.
    const reviewer = await workerLeg(w, 'reviewer', { role: 'reviewer', run: run!, key: 'login-form', parent: w.sessionId! })
    const r = await w.store!.writeCheckpoint('state: reviewed the login form; next: ship', { run: run!, key: 'login-form', leg: reviewer, at: tReviewer })
    w.ids!['reviewer'] = r.nodeId
    w.moments!['builder'] = tBuilder
    w.moments!['reviewer'] = tReviewer
    await drainStaging(w)
    const b = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE content LIKE '%zebrafinch%'")
    expect(b, 'the builder row was drained').toBeTruthy()
    w.ids!['builder'] = b!.node_id
  })

  define(/^a run "([^"]+)" with (\d+) rows of its own$/, async (w, run, n) => {
    const ref = await workerLeg(w, `${run}-worker`, { role: 'builder', run: run!, key: 'search-box' })
    const ids: string[] = []
    for (let i = 0; i < Number(n); i++) {
      ids.push((await w.store!.insert(`${run} note ${i}: the search box debounces at ${i * 10} ms`, { leg: ref })).nodeId)
    }
    w.facts![`${run}-rows`] = ids
  })

  define(/^a reader runs plain SQL against the store file for the run "([^"]+)"$/, (w, run) => {
    w.sqlRows = readerOf(w).prepare(RUN_ROWS_SQL).all(run!, run!) as Array<Record<string, unknown>>
    expect(w.sqlRows.length).toBeGreaterThan(0)
  })

  define(/^the reader sees the builder's row before the reviewer's, each row naming its writer and its moment$/, (w) => {
    const order = w.sqlRows!.map((r) => r['node_id'])
    const b = order.indexOf(w.ids!['builder']!)
    const r = order.indexOf(w.ids!['reviewer']!)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(r).toBeGreaterThan(b)
    // The drain wrote the builder's row after the reviewer's: its rowid is
    // later, its moment earlier. The order is the rows' own moments.
    const rowid = (id: string) => rawOne<{ rowid: number }>(w, 'SELECT rowid FROM nodes WHERE node_id = ?', id)!.rowid
    expect(rowid(w.ids!['builder']!)).toBeGreaterThan(rowid(w.ids!['reviewer']!))
    const bm = rawMetaOf(w, w.ids!['builder']!)
    expect(bm['ingested_at']).toBeGreaterThan(w.moments!['reviewer']!)
    for (const row of w.sqlRows!) {
      expect(typeof row['writer'], `row ${String(row['node_id'])} names no writer`).toBe('string')
      expect(typeof row['created_at']).toBe('number')
    }
    const byId = Object.fromEntries(w.sqlRows!.map((row) => [row['node_id'], row]))
    expect(byId[w.ids!['builder']!]!['created_at']).toBe(w.moments!['builder'])
    expect(byId[w.ids!['reviewer']!]!['created_at']).toBe(w.moments!['reviewer'])
    expect([byId[w.ids!['builder']!]!['writer'], byId[w.ids!['reviewer']!]!['writer']]).toEqual(['builder', 'reviewer'])
  })

  define(/^every leg of "([^"]+)" names the run "\1", its key and its parent session, and the builder's captured rows reach "\1" through the builder's lane$/, (w, run) => {
    const legs = rawAll<{ session_id: string; agent_id: string; run: string; run_key: string | null; parent_session: string | null }>(w,
      'SELECT session_id, agent_id, run, run_key, parent_session FROM session_registry WHERE run = ?', run)
    expect(legs).toHaveLength(2)
    for (const leg of legs) {
      expect(leg.run).toBe(run)
      expect(leg.run_key).toBe('login-form')
      expect(leg.parent_session).toBe(w.sessionId)
    }
    // The captured row carries neither run nor key; it reaches the run
    // through the registration of its session and its writer agent.
    const bm = rawMetaOf(w, w.ids!['builder']!)
    expect(bm['run']).toBeUndefined()
    expect(bm['key']).toBeUndefined()
    const row = w.sqlRows!.find((r) => r['node_id'] === w.ids!['builder'])!
    expect([row['leg_session'], row['leg_agent'], row['key']]).toEqual([w.sessionId, w.legs!['builder']!.agentId, 'login-form'])
  })

  define(/^none of the (\d+) rows of "([^"]+)" read back among them$/, (w, n, other) => {
    const theirs = w.facts![`${other}-rows`] as string[]
    expect(theirs).toHaveLength(Number(n))
    // They are the other run's by the same recipe...
    const otherRows = runRowIds(w, other!)
    for (const id of theirs) expect(otherRows.has(id)).toBe(true)
    // ...and none of the other run's rows is among this one's.
    const mine = new Set(w.sqlRows!.map((r) => r['node_id'] as string))
    for (const id of otherRows) expect(mine.has(id)).toBe(false)
  })

  // ── D302: a run's open and close ──

  define(/^a store holding no run "([^"]+)"$/, async (w, run) => {
    await openRunWorld(w)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(0)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(0)
  })

  // Through registerWorker, the library door a spawner registers a worker
  // through (D291): the first registration under the run opens it.
  define(/^a builder leg registers under the run "([^"]+)"$/, async (w, run) => {
    await workerLeg(w, 'builder', { role: 'builder', run, key: 'login-form' })
  })

  define(/^a reader with the store file sees the run "([^"]+)" opened at that registration's moment$/, (w, run) => {
    const leg = rawRegistration(w, w.legs!['builder']!)
    const open = openRowOf(w, run!)
    expect(open.created_at).toBe(leg['started_at'])
    expect(open.m['opened_via']).toBe('registration')
    expect(open.m['_writer']).toBe(STORE_WRITER)
    expect(open.m['first_leg']).toEqual({ session_id: leg['session_id'], agent_id: leg['agent_id'], role: 'builder' })
    expect(rawContentOf(w, open.node_id)).toContain(`run ${run} opened`)
    // One open row, written by the same immediate transaction as the
    // registration.
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(1)
  })

  define(/^a harness opens the run "([^"]+)" through the door with no leg yet$/, async (w, run) => {
    const at = Date.now() / 1000
    const r = await w.store!.openRun({ run: run!, by: 'harness', at })
    expect(r.opened).toBe(true)
    w.moments!['open'] = at
  })

  define(/^a reader with the store file sees the run "([^"]+)" opened by the harness at that moment, with no legs$/, (w, run) => {
    const open = openRowOf(w, run!)
    expect(open.created_at).toBe(w.moments!['open'])
    expect([open.m['opened_by'], open.m['opened_via'], open.m['_writer'], open.m['_identity']]).toEqual(['harness', 'explicit', 'harness', 'declared'])
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(0)
  })

  define(/^a run "([^"]+)" whose builder leg wrote the checkpoint "([^"]+)" that the harness's grammar cannot parse$/, async (w, run, text) => {
    await openRunWorld(w, { sessionStart: false })
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: 'login-form' })
    const r = await w.store!.writeCheckpoint(text!, { run: run!, key: 'login-form', leg: ref })
    w.ids!['checkpoint'] = r.nodeId
    w.before!['checkpoint'] = rawRowOf(w, r.nodeId)
  })

  define(/^the harness retires the leg and closes the run "([^"]+)" through the door with the reason "([^"]+)"$/, async (w, run, reason) => {
    const at = Date.now() / 1000
    expect(w.store!.retireLeg(w.legs!['builder']!, 'retired', at)).toBe(true)
    await w.store!.closeRun({ run: run!, by: 'harness', reason: reason!, at })
    w.moments!['close'] = at
  })

  define(/^a reader running plain SQL against the store file sees the run "([^"]+)" ended at that moment, by the harness, with the reason "([^"]+)"$/, (w, run, reason) => {
    const rows = rawAll<{ created_at: number; by: string; why: string; writer: string }>(w,
      `SELECT created_at, json_extract(metadata_json, '$.closed_by') AS by, json_extract(metadata_json, '$.reason') AS why,
              json_extract(metadata_json, '$._writer') AS writer
         FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?`, run)
    expect(rows).toEqual([{ created_at: w.moments!['close'], by: 'harness', why: reason, writer: 'harness' }])
  })

  define(/^the checkpoint "([^"]+)" is stored unchanged, never parsed or refused by the store$/, (w, text) => {
    expect(rawContentOf(w, w.ids!['checkpoint']!)).toBe(text)
    expect(rawRowOf(w, w.ids!['checkpoint']!)).toEqual(w.before!['checkpoint'])
  })

  // ── D309: an agent finds a run through the query it already has ──

  define(/^a run "([^"]+)" with (\d+) legs, and a run "([^"]+)" with (\d+) legs$/, async (w, a, na, b, nb) => {
    await openRunWorld(w)
    for (const [run, n] of [[a!, Number(na)], [b!, Number(nb)]] as const) {
      for (let i = 0; i < n; i++) {
        const ref = await workerLeg(w, `${run}-${i}`, { role: i === 0 ? 'builder' : 'reviewer', run, key: 'login-form' })
        await w.store!.writeCheckpoint(`state: ${i === 0 ? 'built' : 'reviewed'} the login form`, { run, key: 'login-form', leg: ref })
      }
    }
  })

  define(/^an agent queries "([^"]+)"$/, async (w, q) => {
    w.facts!['hits'] = await query(w, q!)
  })

  define(/^the agent's hits are rows of "([^"]+)" and none of "([^"]+)"$/, (w, mine, theirs) => {
    const hits = w.facts!['hits'] as Hit[]
    expect(hits.length).toBeGreaterThan(0)
    const ours = runRowIds(w, mine!)
    const other = runRowIds(w, theirs!)
    expect(other.size).toBeGreaterThan(0)
    for (const h of hits) {
      expect(ours.has(h.nodeId), `hit ${h.nodeId} (${h.content.slice(0, 60)}) is not a row of "${mine}"`).toBe(true)
      expect(other.has(h.nodeId)).toBe(false)
    }
  })

  define(/^a run "([^"]+)" opened on Tuesday and closed on Wednesday with the reason "([^"]+)"$/, async (w, run, reason) => {
    await openRunWorld(w)
    const d = new Date()
    d.setDate(d.getDate() - (((d.getDay() - 2) + 7) % 7 || 7))
    d.setHours(10, 0, 0, 0)
    const tuesday = d.getTime() / 1000
    const wednesday = tuesday + 86400
    const open = await w.store!.openRun({ run: run!, by: 'harness', at: tuesday })
    const close = await w.store!.closeRun({ run: run!, by: 'harness', reason: reason!, at: wednesday })
    w.ids!['open'] = open.nodeId
    w.ids!['close'] = close.nodeId
    // Other work in the journal the query must rank past.
    await w.store!.insert('the deploy pipeline delivered the keys to staging on Monday', { metadata: { type: 'note' } })
  })

  define(/^the agent's hit is the run's close row, carrying the run "([^"]+)" and the reason$/, (w, run) => {
    const hits = w.facts!['hits'] as Hit[]
    expect(hits[0]!.nodeId).toBe(w.ids!['close'])
    expect(hits[0]!.metadata!['run']).toBe(run)
    expect(hits[0]!.metadata!['reason']).toBe('all keys delivered')
    expect(rawMetaOf(w, w.ids!['close']!)['kind']).toBe('run-close')
  })

  define(/^the open row of "([^"]+)" is reachable from it by the run$/, async (w, run) => {
    const hits = w.facts!['hits'] as Hit[]
    const carried = hits[0]!.metadata!['run']
    expect(carried).toBe(run)
    const opens = await query(w, `run ${String(carried)} opened`, { metadata_filter: { run: carried, kind: 'run-open' } })
    expect(opens.map((h) => h.nodeId)).toEqual([w.ids!['open']])
    // The close names its open by id as well, one hop.
    expect(rawMetaOf(w, w.ids!['close']!)['refs']).toEqual([w.ids!['open']])
  })

  // ── D311: a run opened inside a run ──

  define(/^a run "([^"]+)" whose reviewer leg, under the key "([^"]+)", spawns (\d+) workers under a run "([^"]+)" it opens, with their own key "\2"$/, async (w, outer, key, n, inner) => {
    await openRunWorld(w, { sessionStart: false })
    const reviewer = await workerLeg(w, 'reviewer', { role: 'reviewer', run: outer!, key: key! })
    const own = await w.store!.writeCheckpoint('state: original plus review; two fixes asked for', { run: outer!, key: key!, leg: reviewer })
    w.ids!['reviewer-checkpoint'] = own.nodeId
    await w.store!.openRun({ run: inner!, leg: reviewer, parentRun: outer!, parentLeg: reviewer })
    const innerIds: string[] = []
    for (let i = 0; i < Number(n); i++) {
      const fixer = await workerLeg(w, `fixer${i}`, { role: 'fixer', run: inner!, key: key!, parent: reviewer.sessionId })
      innerIds.push((await w.store!.writeCheckpoint(`state: fix ${i} applied`, { run: inner!, key: key!, leg: fixer })).nodeId)
    }
    w.facts!['inner-checkpoints'] = innerIds
  })

  define(/^a reader walks the run "([^"]+)"$/, (w, run) => {
    w.facts!['walk'] = walk(w, run!)
  })

  define(/^the reviewer leg's facts say it opened the run "([^"]+)"$/, (w, inner) => {
    const r = rawRegistration(w, w.legs!['reviewer']!)
    expect(JSON.parse(String(r['opened_runs']))).toEqual([inner])
    const walked = w.facts!['walk'] as Record<string, unknown[]>
    expect(Object.keys(walked)).toContain(inner)
  })

  define(/^the open row of "([^"]+)" names the run "([^"]+)" and the reviewer leg as declared$/, (w, inner, outer) => {
    const open = openRowOf(w, inner!)
    const reviewer = w.legs!['reviewer']!
    expect(open.m['parent_run']).toBe(outer)
    expect(open.m['parent_leg']).toEqual({ session_id: reviewer.sessionId, agent_id: reviewer.agentId, role: 'reviewer' })
    expect(open.m['_identity']).toBe('declared')
  })

  define(/^the run "([^"]+)" counts the reviewer leg as one leg, not three$/, (w, run) => {
    const walked = w.facts!['walk'] as Record<string, Array<Record<string, unknown>>>
    expect(walked[run!]).toHaveLength(1)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(1)
  })

  define(/^the harness looking up the key "([^"]+)" on the run "([^"]+)" receives the reviewer leg's checkpoint, never a checkpoint of "([^"]+)"$/, (w, key, run, inner) => {
    const l = w.store!.lookupKey({ run: run!, key: key! })
    // The inner run's checkpoints are there, under the same key, in the inner run.
    for (const id of w.facts!['inner-checkpoints'] as string[]) expect(rawMetaOf(w, id)['run']).toBe(inner)
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([w.ids!['reviewer-checkpoint']])
    for (const id of w.facts!['inner-checkpoints'] as string[]) expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(id)
  })

  define(/^a run "([^"]+)" whose leg opened "([^"]+)", whose leg opened "([^"]+)"$/, async (w, outer, mid, innermost) => {
    await openRunWorld(w, { sessionStart: false })
    const top = await workerLeg(w, 'top', { role: 'reviewer', run: outer!, key: 'login-form' })
    await w.store!.openRun({ run: mid!, leg: top, parentRun: outer!, parentLeg: top })
    const middle = await workerLeg(w, 'middle', { role: 'reviewer', run: mid!, key: 'login-form', parent: top.sessionId })
    await w.store!.openRun({ run: innermost!, leg: middle, parentRun: mid!, parentLeg: middle })
    await workerLeg(w, 'fixer', { role: 'fixer', run: innermost!, key: 'login-form', parent: middle.sessionId })
  })

  define(/^the reader reaches the legs of "([^"]+)" through "([^"]+)"$/, (w, innermost, mid) => {
    const walked = w.facts!['walk'] as Record<string, Array<Record<string, unknown>>>
    const mids = walked[mid!]!
    expect(mids).toHaveLength(1)
    expect(JSON.parse(String(mids[0]!['opened_runs']))).toEqual([innermost])
    expect(walked[innermost!]!.map((l) => l['agent_type'])).toEqual(['fixer'])
  })

  define(/^the open row of "([^"]+)" names "([^"]+)" and the leg that opened it$/, (w, innermost, mid) => {
    const open = openRowOf(w, innermost!)
    const middle = w.legs!['middle']!
    expect(open.m['parent_run']).toBe(mid)
    expect(open.m['parent_leg']).toEqual({ session_id: middle.sessionId, agent_id: middle.agentId, role: 'reviewer' })
  })

  // ── D296: a stranger's checkpoint, flagged against the named checkpointer ──

  define(/^a brief stored on the run "([^"]+)" naming the builder as the checkpointer of the key "([^"]+)"$/, async (w, run, key) => {
    await openRunWorld(w, { sessionStart: false })
    const b = await w.store!.writeBrief(`build the ${key}; the builder checkpoints it at the end`, { run: run!, key: key!, role: 'builder', checkpointer: 'builder', by: 'harness' })
    w.ids!['brief'] = b.nodeId
    expect(rawMetaOf(w, b.nodeId)['checkpointer']).toBe('builder')
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)" written by the builder role, and checkpoint number (\d+), the newest in effect, written by the writer "([^"]+)"$/, async (w, num, key, newer, stranger) => {
    await seedCheckpoints(w, 'r1', key!, Number(num))
    const r = await w.store!.writeCheckpoint('state: rewritten by another hand; the form is done', {
      run: 'r1', key: key!, declared: { role: stranger! }, supersedes: [w.cps![cpLabel('r1', key!, Number(num))]!],
    })
    expect(r.checkpoint!.number).toBe(Number(newer))
    w.cps![cpLabel('r1', key!, Number(newer))] = r.nodeId
  })

  define(/^checkpoint number (\d+) under the key "([^"]+)", the newest in effect, written by the builder role$/, async (w, num, key) => {
    await seedCheckpoints(w, 'r1', key!, Number(num))
  })

  define(/^the harness looks up the key "([^"]+)" on the run "([^"]+)"$/, (w, key, run) => {
    w.lookups![run!] = w.store!.lookupKey({ run: run!, key: key! })
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)", not number (\d+)$/, (w, num, writer, older) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel('r1', l.key, Number(num))], Number(num), writer]])
    const m = rawMetaOf(w, l.checkpoints[0]!.nodeId)
    expect([m['_writer'], m['_checkpoint_number']]).toEqual([writer, Number(num)])
    // Number 5 is there, the builder's, and not what the lookup returned.
    const old = w.cps![cpLabel('r1', l.key, Number(older))]!
    expect(rawMetaOf(w, old)['_writer']).toBe('builder')
    expect(l.checkpoints.map((c) => c.nodeId)).not.toContain(old)
  })

  define(/^the same reply says its writer is not the checkpointer the brief names$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    expect(reply.checkpoints).toHaveLength(1)
    const cp = reply.checkpoints[0]!
    expect(cp.flag).toBe(`The writer of checkpoint number ${cp.number}, "${cp.writer}", is not the checkpointer the brief names ("builder").`)
    expect(reply.named_checkpointer).toEqual({ names: ['builder'], by: 'brief' })
    // Nothing withheld: the stranger's row is the reply's, whole.
    expect(cp.content).toBe(rawContentOf(w, cp.node_id))
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)"$/, (w, num, writer) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel('r1', l.key, Number(num))], Number(num), writer]])
    expect(rawMetaOf(w, l.checkpoints[0]!.nodeId)['_writer']).toBe(writer)
  })

  define(/^the reply carries no flag about its writer$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    // A flag was possible (the brief names a checkpointer), and none is said.
    expect(reply.named_checkpointer).toEqual({ names: ['builder'], by: 'brief' })
    expect(reply.checkpoints.map((c) => c.flag)).toEqual([null])
    // Nor anywhere else in the reply: the phantom pass had nothing to say.
    expect(reply.notes).toEqual([])
  })

  // ── D301, D344: the run's facts beside the checkpoint ──

  define(/^a run "([^"]+)" started (\d+) hours ago on which (\d+) legs have run and whose key "([^"]+)" holds (\d+) checkpoints, the last three of (\d+), (\d+) and (\d+) characters$/, async (w, run, hours, legs, key, count, s1, s2, s3) => {
    await openRunWorld(w, { sessionStart: false })
    const start = Date.now() / 1000 - Number(hours) * HOUR
    await w.store!.openRun({ run: run!, by: 'harness', at: start })
    w.moments!['start'] = start
    const nLegs = Number(legs)
    const nCps = Number(count)
    const sizes = [...Array.from({ length: nCps - 3 }, (_, i) => 400 + i), Number(s1), Number(s2), Number(s3)]
    for (let i = 0; i < nLegs; i++) {
      const at = start + (i + 1) * 600
      const ref = await workerLeg(w, `leg${i}`, { role: 'builder', run: run!, key: key!, at, startCheckpoints: w.store!.checkpointsInEffect(run!, key!).map((c) => c.nodeId) })
      // The last legs each write one checkpoint; the first ones only worked.
      const k = i - (nLegs - nCps)
      if (k >= 0) {
        const r = await w.store!.writeCheckpoint(sized(`leg ${i} of ${run}`, sizes[k]!), { run: run!, key: key!, leg: ref, at: at + 300 })
        w.cps![cpLabel(run!, key!, r.checkpoint!.number)] = r.nodeId
      }
      expect(w.store!.retireLeg(ref, 'retired', at + 400)).toBe(true)
    }
  })

  define(/^the harness receives, beside the checkpoint, the leg count (\d+), the checkpoint count (\d+), the run age of (\d+) hours and the sizes (\d+), (\d+) and (\d+)$/, (w, legs, count, hours, s1, s2, s3) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(count)])
    const f = keyLookupReply(l).facts
    expect([f.legs_run, f.checkpoints_under_key, f.last_sizes]).toEqual([Number(legs), Number(count), [Number(s1), Number(s2), Number(s3)]])
    expect(f.run_started_at).toBe(w.moments!['start'])
    expect(Math.abs(f.run_age_seconds! - Number(hours) * HOUR)).toBeLessThan(120)
    // The file agrees on every number.
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', l.run)).toHaveLength(Number(legs))
    expect(rawSizes(w, l.run, l.key).slice(-3)).toEqual([Number(s1), Number(s2), Number(s3)])
    expect(rawCheckpoints(w, l.run, l.key)).toHaveLength(Number(count))
    expect(rawOne<{ t: number }>(w, "SELECT created_at AS t FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", l.run)!.t).toBe(w.moments!['start'])
  })

  // ── D312: a live leg's start and last write ──

  define(/^a run "([^"]+)" with a live builder leg that started (\d+) hours ago and last wrote a row (\d+) minutes ago$/, async (w, run, hours, minutes) => {
    await openRunWorld(w, { sessionStart: false })
    const start = Date.now() / 1000 - Number(hours) * HOUR
    const last = Date.now() / 1000 - Number(minutes) * 60
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: 'login-form', at: start })
    await w.store!.insert('npx vitest run login: 3 failing, the submit handler is missing', { leg: ref, createdAt: start + 120 })
    await w.store!.insert('waiting on the login API to answer the submit', { leg: ref, createdAt: last })
    w.moments!['start'] = start
    w.moments!['last'] = last
  })

  define(/^the harness receives, for the builder leg, its start moment (\d+) hours ago and its last write (\d+) minutes ago$/, (w, hours, minutes) => {
    const reply = keyLookupReply(harnessLookup(w))
    const legs = reply.legs.filter((g) => g.role === 'builder')
    expect(legs).toHaveLength(1)
    const leg = legs[0]!
    expect([leg.state, leg.started_at, leg.last_write_at]).toEqual(['live', w.moments!['start'], w.moments!['last']])
    expect(Math.abs(reply.facts.as_of - leg.started_at - Number(hours) * HOUR)).toBeLessThan(60)
    expect(Math.abs(reply.facts.as_of - leg.last_write_at! - Number(minutes) * 60)).toBeLessThan(60)
    // The file: the registration's start, and the newest row of the lane by
    // its own moment.
    const r = rawRegistration(w, w.legs!['builder']!)
    expect([r['started_at'], r['stopped_at'], r['ended']]).toEqual([w.moments!['start'], null, null])
    expect(rawOne<{ t: number }>(w, 'SELECT MAX(created_at) AS t FROM nodes WHERE session_key = ?', w.legs!['builder']!.sessionId)!.t).toBe(w.moments!['last'])
  })

  define(/^the reply judges nothing about whether the leg is stuck$/, (w) => {
    const reply = keyLookupReply(harnessLookup(w))
    const leg = reply.legs.find((g) => g.role === 'builder')!
    // Moments and states, no verdict: the leg's fields are the registry's
    // facts and its last write, and no word of the reply judges it.
    expect(Object.keys(leg).sort()).toEqual([
      'agent_id', 'checkpoints_written', 'key', 'key_src', 'keyless', 'kind', 'last_write_at', 'noticed_at', 'noticed_by',
      'opened_runs', 'role', 'session_id', 'started_at', 'state', 'stopped_at',
    ])
    expect(leg.state).toBe('live')
    // Needle liveness first: the verdict words fire on a reply that judges.
    expect('the builder leg looks stuck; it has been idle for 90 minutes', 'the verdict needle is dead').toMatch(VERDICT_NEEDLE)
    expect(JSON.stringify(reply)).not.toMatch(VERDICT_NEEDLE)
  })

  // ── D336: the pointer to the return of the leg that wrote the checkpoint ──

  define(/^a run "([^"]+)" whose key "([^"]+)" holds checkpoint number (\d+), written by a reviewer leg that finished with the report "([^"]+)"$/, async (w, run, key, num, report) => {
    await openRunWorld(w)
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    // Through the hooks door: the harness's brief names the reviewer as the
    // key's checkpointer, and the real SubagentStart hook infers the leg's
    // run, key and start from it.
    const leg = await hooksLeg(w, 'reviewer', 'reviewer', { run: run!, key: key!, checkpointer: 'reviewer' })
    expect(JSON.parse(String(rawRegistration(w, leg)['start_checkpoints']))).toEqual([ids.at(-1)!])
    const wrote = await insertEchoed(w, { agentId: leg.agentId, agentType: 'reviewer' }, 'state: original plus review; two fixes asked for', { kind: 'checkpoint', run: run!, key: key! })
    expect((wrote['checkpoint'] as Record<string, unknown>)['number']).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = wrote['node_id'] as string
    w.stops!['reviewer'] = subagentStopHook(w, leg.agentId, 'reviewer', report!)
    await drainStaging(w)
  })

  define(/^the harness receives checkpoint number (\d+) with the writer "([^"]+)" and a pointer to the reviewer leg's summary row reading "([^"]+)"$/, (w, num, writer, report) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.writer])).toEqual([[w.cps![cpLabel(l.run, l.key, Number(num))], Number(num), writer]])
    const ret = l.checkpoints[0]!.legReturn
    expect(ret.leg).toEqual({ sessionId: w.sessionId, agentId: w.legs!['reviewer']!.agentId, role: 'reviewer', state: 'retired' })
    expect(ret.summary, ret.line).not.toBeNull()
    const id = ret.summary!.nodeId
    expect(ret.line).toBe(`Return of the reviewer leg that wrote checkpoint number ${num}: the summary row ${id} (writer "reviewer", run "${l.run}", key "${l.key}").`)
    // The row it points at is the reviewer's summary the SubagentStop hook
    // staged and the drain wrote, carrying the run and the key.
    expect(rawContentOf(w, id)).toBe(report)
    const m = rawMetaOf(w, id)
    expect([m['kind'], m['_writer'], m['_writer_agent_id'], m['run'], m['key']]).toEqual([SUBAGENT_SUMMARY_KIND, 'reviewer', w.legs!['reviewer']!.agentId, l.run, l.key])
    expect(rawRowOf(w, id)['session_key']).toBe(w.sessionId)
  })

  define(/^a run "([^"]+)" whose key "([^"]+)" holds checkpoint number (\d+), written by a builder leg that was cut after writing it and left no summary row$/, async (w, run, key, num) => {
    await openRunWorld(w, { sessionStart: false })
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    const ref = await workerLeg(w, 'builder', { role: 'builder', run: run!, key: key!, startCheckpoints: [ids.at(-1)!] })
    const r = await w.store!.writeCheckpoint('state: half the submit wired; next: the other half', { run: run!, key: key!, leg: ref })
    expect(r.checkpoint!.number).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = r.nodeId
    // The harness's timeout cut it (D292): retired as cut, no summary row.
    expect(w.store!.retireLeg(ref, 'cut')).toBe(true)
  })

  define(/^the harness receives checkpoint number (\d+) and a line saying the builder leg left no return$/, (w, num) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.nodeId, c.number])).toEqual([[w.cps![cpLabel(l.run, l.key, Number(num))], Number(num)]])
    const ret = l.checkpoints[0]!.legReturn
    expect(ret.summary).toBeNull()
    expect(ret.line).toBe(`The builder leg that wrote checkpoint number ${num} left no return: it ended cut, with no summary row.`)
    // Never guessed: the file holds no summary row in the builder's lane,
    // and the registration says it was cut.
    const lane = w.legs!['builder']!.sessionId
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = ?", lane, SUBAGENT_SUMMARY_KIND)).toHaveLength(0)
    expect(rawRegistration(w, w.legs!['builder']!)['ended']).toBe('cut')
  })

  // ── D337: the agent's door to the same reply, and to a run's close ──

  define(/^a run "([^"]+)" started (\d+) hours ago whose key "([^"]+)" holds checkpoint number (\d+), written by the writer "([^"]+)" against a brief naming the builder$/, async (w, run, hours, key, num, stranger) => {
    await openRunWorld(w)
    const start = Date.now() / 1000 - Number(hours) * HOUR
    await w.store!.openRun({ run: run!, by: 'harness', at: start })
    await w.store!.writeBrief(`build the ${key}`, { run: run!, key: key!, role: 'builder', checkpointer: 'builder', by: 'harness', at: start + 60 })
    const n = Number(num)
    const ids = await seedCheckpoints(w, run!, key!, n - 1)
    // The stranger is a leg of the run with no brief of its own: no brief
    // names it, so through the hooks door it would be a plain subagent
    // (D305), which no run counts and whose return no key names. It is a
    // worker its spawner registered under the run (the library door,
    // declared, its ticket naming no checkpointer), writing its checkpoint
    // as itself and returning its report at its exit, the summary row its
    // pointer names.
    const leg = await workerLeg(w, 'stranger', { role: stranger!, run: run!, key: key!, checkpointer: null, startCheckpoints: [ids.at(-1)!] })
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.brief_for') = ?", stranger)).toHaveLength(0)
    const wrote = await w.store!.writeCheckpoint('state: rewritten by another hand; ship it', { run: run!, key: key!, leg })
    expect(wrote.checkpoint!.number).toBe(n)
    w.cps![cpLabel(run!, key!, n)] = wrote.nodeId
    await w.store!.retireWorker(leg, { output: `${stranger} done: shipped the form`, how: 'retired', summary: true })
    w.moments!['start'] = start
  })

  define(/^an agent asks through treecontext's tools for the checkpoint in effect under the key "([^"]+)" on the run "([^"]+)"$/, async (w, key, run) => {
    await sessionClient(w)
    const reply = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { [KEY_LOOKUP_PARAM]: { run, key } } }))
    w.facts!['agent-reply'] = reply
    w.facts!['agent-asked'] = { run, key }
  })

  define(/^the agent receives checkpoint number (\d+) with the writer "([^"]+)", the flag that its writer is not the named checkpointer, the run's facts and the pointer to the leg's return, the same as the harness's reply$/, (w, num, writer) => {
    const agent = w.facts!['agent-reply'] as unknown as KeyLookupReply
    const asked = w.facts!['agent-asked'] as { run: string; key: string }
    expect(agent.checkpoints.map((c) => [c.node_id, c.number, c.writer])).toEqual([[w.cps![cpLabel(asked.run, asked.key, Number(num))], Number(num), writer]])
    const cp = agent.checkpoints[0]!
    expect(cp.flag).toBe(`The writer of checkpoint number ${num}, "${writer}", is not the checkpointer the brief names ("builder").`)
    expect(agent.facts.checkpoints_under_key).toBe(Number(num))
    expect(agent.facts.legs_run).toBe(1)
    expect(agent.facts.run_started_at).toBe(w.moments!['start'])
    expect(agent.facts.last_sizes).toEqual(rawSizes(w, asked.run, asked.key).slice(-3))
    // The pointer names the stranger's summary row, as the file holds it.
    const id = cp.return.summary_node_id
    expect(id, cp.return.line).not.toBeNull()
    const m = rawMetaOf(w, id!)
    expect([m['kind'], m['_writer'], m['run'], m['key']]).toEqual([SUBAGENT_SUMMARY_KIND, writer, asked.run, asked.key])
    expect(rawContentOf(w, id!)).toBe(`${writer} done: shipped the form`)
    // The harness's reply, asked the same thing through the library: the
    // same object, but for the moment each was read.
    const harness = keyLookupReply(w.store!.lookupKey(asked))
    const unclocked = (r: KeyLookupReply): unknown => ({ ...r, facts: { ...r.facts, as_of: 0, run_age_seconds: 0 } })
    expect(unclocked(agent)).toEqual(unclocked(harness))
    expect(Math.abs(agent.facts.as_of - harness.facts.as_of)).toBeLessThan(60)
    expect(Math.abs(agent.facts.run_age_seconds! - 3 * HOUR)).toBeLessThan(120)
  })

  define(/^a run "([^"]+)" open with (\d+) legs retired$/, async (w, run, n) => {
    await openRunWorld(w)
    for (let i = 0; i < Number(n); i++) {
      const ref = await workerLeg(w, `leg${i}`, { role: i === 0 ? 'builder' : 'reviewer', run: run!, key: 'login-form' })
      expect(w.store!.retireLeg(ref, 'retired')).toBe(true)
    }
    w.ids!['open'] = rawOne<{ node_id: string }>(w, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-open' AND json_extract(metadata_json, '$.run') = ?", run)!.node_id
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?", run)).toHaveLength(0)
  })

  define(/^the main agent declares the run "([^"]+)" closed through treecontext's tools with the reason "([^"]+)"$/, async (w, run, reason) => {
    const before = Date.now() / 1000
    const reply = await insertEchoed(w, null, reason!, { kind: 'run-close', run, reason })
    w.moments!['before'] = before
    w.moments!['after'] = Date.now() / 1000
    w.ids!['close'] = reply['node_id'] as string
    expect(reply['run']).toEqual({ kind: 'run-close', run, closed_by: 'main', reason })
    // The call's own echo is drained, as Claude Code's capture would.
    await drainStaging(w)
  })

  define(/^a reader with the store file sees the run "([^"]+)" ended at that moment, by the main agent, with the reason "([^"]+)"$/, (w, run, reason) => {
    const rows = rawAll<{ node_id: string; created_at: number; by: string; why: string; writer: string; src: string; refs: string; door: string }>(w,
      `SELECT node_id, created_at, json_extract(metadata_json, '$.closed_by') AS by, json_extract(metadata_json, '$.reason') AS why,
              json_extract(metadata_json, '$._writer') AS writer, json_extract(metadata_json, '$._writer_src') AS src,
              json_extract(metadata_json, '$.refs') AS refs, json_extract(metadata_json, '$._door') AS door
         FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close' AND json_extract(metadata_json, '$.run') = ?`, run)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect([r.node_id, r.by, r.why, r.writer, r.door]).toEqual([w.ids!['close'], 'main', reason, 'main', 'tools'])
    expect(r.created_at).toBeGreaterThanOrEqual(w.moments!['before']!)
    expect(r.created_at).toBeLessThanOrEqual(w.moments!['after']!)
    // The harness's record: the line closeRun writes, pointing at the open.
    expect(JSON.parse(r.refs)).toEqual([w.ids!['open']])
    expect(rawContentOf(w, r.node_id)).toBe(`run ${run} closed by main: ${reason}`)
    // The echo confirmed the writer the store stamped.
    expect(['self', 'echo']).toContain(r.src)
  })

  // ── D344: the sizes of the last {3} ──

  define(/^a run "([^"]+)" whose key "([^"]+)" holds (\d+) checkpoints$/, async (w, run, key, count) => {
    await openRunWorld(w, { sessionStart: false })
    let prev: string | null = null
    for (let i = 1; i <= Number(count); i++) {
      const r = await w.store!.writeCheckpoint(sized(`after leg ${i}`, 100 + i * 7), {
        run: run!, key: key!, declared: { role: 'builder' }, ...(prev ? { supersedes: [prev] } : {}),
      })
      expect(r.checkpoint!.number).toBe(i)
      prev = r.nodeId
    }
  })

  define(/^the harness receives the sizes of the last (\d+) checkpoints under the key, newest last$/, (w, shown) => {
    const l = harnessLookup(w)
    const all = rawSizes(w, l.run, l.key)
    const n = Number(shown)
    expect(l.facts.lastSizes).toEqual(all.slice(all.length - n))
    expect(l.facts.lastSizes).toHaveLength(n)
    // Newest last: the sizes grow with the number, so the order shows.
    expect([...l.facts.lastSizes].sort((a, b) => a - b)).toEqual(l.facts.lastSizes)
    expect(keyLookupReply(l).facts.last_sizes).toEqual(l.facts.lastSizes)
  })
}
