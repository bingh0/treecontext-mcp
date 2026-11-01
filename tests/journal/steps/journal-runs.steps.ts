import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { parseTool, rawAll } from '../world.js'
import { runHook, bashPayload, drainStaging } from '../capture-harness.js'
import { RUN_ROWS_SQL } from '../../../src/runs.js'
import { STORE_WRITER } from '../../../src/persistence/session-registry.js'
import {
  type RunWorld, openRunWorld, hooksLeg, workerLeg, seedCheckpoints, sessionClient, localMoment, readerOf,
  rawOne, rawMetaOf, rawContentOf, rawRowOf, rawRegistration, cpLabel, stringSteps,
} from '../run-world.js'

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
// own query tool. The lookup's run facts, its flag in words and the
// pointer to a leg's return (D296, D301, D312, D336, D337, D344) are the
// lookup reply's build and stay in the wip register until it lands.

export type RunsWorld = RunWorld

type Hit = { nodeId: string; content: string; metadata: Record<string, unknown> | null }

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
    const builder = await hooksLeg(w, 'builder', 'builder', { run: run!, key: 'login-form', keySrc: 'inferred' })
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
}
