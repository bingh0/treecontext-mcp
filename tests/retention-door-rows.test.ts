/**
 * The retention valve and the rows the beta.3 doors write, below the
 * charter (D319, D339, D305, D221; unit 7 of the beta.3 build). The charter
 * binds the ticketed worker's first moment under the session cap and the
 * byte budget (journal-storage); these pin the rest of the rule: which
 * demotion class a door's row falls in, that a subagent's summary row is
 * agent-authored for the valve whichever door or label wrote it, that no
 * handoff-lane row is ever the valve's, and what the hooks door's own
 * first-moment row does. Every store claim is read back from the SQLite
 * file through a separate handle, and the archive from the disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { decodeContent } from '../src/persistence/content-codec.js'
import { FlatStore } from '../src/flat-store.js'
import { IngestionLoop } from '../src/server/ingestion.js'
import { exportRun } from '../src/handoff.js'
import { readTicket, mintTicket } from '../src/ticket.js'
import { registerSelf, registerSubagent, type GitSelf } from '../src/persistence/session-registry.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import {
  DOOR_CAPTURE_KINDS, isDoorCapture, isRunAuthored, FIRST_MOMENT_KIND, SEND_BACK_KIND, SUBAGENT_SUMMARY_KIND,
} from '../src/run-kinds.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-valve-door-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const dbOf = (name: string): string => join(tmpDir, `${name}.db`)
const archiveOf = (name: string): string => join(tmpDir, `${name}-archive`)
const open = (name: string, knobs: { maxSessions?: number; maxStoreBytes?: number } = {}): Promise<FlatStore> =>
  FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbOf(name))), retentionInterval: 1_000_000_000, archiveDir: archiveOf(name), ...knobs })
function raw<T>(name: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(dbOf(name), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
const rowOf = (name: string, id: string): Record<string, unknown> | undefined => raw<Record<string, unknown>>(name, 'SELECT * FROM nodes WHERE node_id = ?', id)[0]
const metaOf = (name: string, id: string): Record<string, unknown> =>
  JSON.parse((rowOf(name, id)!['metadata_json'] as string | null) ?? '{}') as Record<string, unknown>
const contentOf = (name: string, id: string): string => decodeContent(rowOf(name, id)!['content'] as string | Uint8Array)
const storedBytes = (name: string): number =>
  raw<{ b: number }>(name, 'SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS b FROM nodes')[0]!.b
const bytesOf = (name: string, id: string): number =>
  raw<{ b: number }>(name, 'SELECT LENGTH(CAST(content AS BLOB)) AS b FROM nodes WHERE node_id = ?', id)[0]!.b
const hex = (chars: number): string => randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars)
const MAIN: GitSelf = { worktree: null, branch: 'main', cwd: '/repo', toplevel: '/repo', commonDir: '/repo/.git' }

/** A person's words in a session of their own: auto-captured user prose. */
const prose = (s: FlatStore, session: string, at: number, chars = 12_000): Promise<{ nodeId: string }> =>
  s.insert(`the developer asks: ${hex(chars)}`, { metadata: { source: 'auto-capture', role: 'user', session_id: session }, createdAt: at })
/** Captured tool output with a bounded preview behind it (the C4 shape). */
const toolBulk = (s: FlatStore, session: string, at: number): Promise<{ nodeId: string }> =>
  s.insert(`Tool: Bash — ${hex(6_000)}`, { metadata: { source: 'auto-capture', role: 'tool', session_id: session, _index_len: 40 }, createdAt: at })

/** A ticketed worker started through the ticket door's store half. */
function startWorker(s: FlatStore, prompt: string, at: number, role = 'builder') {
  const reading = readTicket(mintTicket({ run: 'r1', key: 'login-form', role, parent: { id: 'p1' }, checkpointer: role, mintedAt: at - 1 }))
  const started = s.startWorker({ reading, prompt, host: hostname(), at })
  return { ...started, ref: { sessionId: started.leg.sessionId, agentId: WORKER_AGENT_ID } }
}

describe('the door rows\' kinds (run-kinds.ts)', () => {
  it('the first moment and the send-back are the door\'s capture; a summary naming its run and a run\'s own rows are agent-authored; a summary naming no run is capture; nothing is both', () => {
    expect([...DOOR_CAPTURE_KINDS].sort()).toEqual([FIRST_MOMENT_KIND, SEND_BACK_KIND].sort())
    for (const kind of [FIRST_MOMENT_KIND, SEND_BACK_KIND]) {
      expect(isDoorCapture({ kind })).toBe(true)
      expect(isRunAuthored({ kind, run: 'r1', key: 'k' }), `${kind} must stay capture`).toBe(false)
    }
    for (const meta of [
      { kind: SUBAGENT_SUMMARY_KIND, run: 'r1' },
      { kind: SUBAGENT_SUMMARY_KIND, run: 'r1', key: 'k' },
      { kind: 'checkpoint', run: 'r1', key: 'k' },
      { kind: 'brief', run: 'r1', key: 'k', brief_for: 'builder' },
      { kind: 'run-open', run: 'r1' },
      { kind: 'run-close', run: 'r1' },
    ]) {
      expect(isRunAuthored(meta), JSON.stringify(meta)).toBe(true)
      expect(isDoorCapture(meta), JSON.stringify(meta)).toBe(false)
    }
    // A note that merely says it is a checkpoint, naming no run, is a note
    // (and is agent-authored for the valve by its label, as every note is);
    // the client's own internal report is not a subagent's summary.
    expect(isRunAuthored({ kind: 'checkpoint' })).toBe(false)
    expect(isRunAuthored({ kind: 'internal-summary' })).toBe(false)
    // A plain subagent's summary names no run: summarised exactly as today
    // (D305), drained like any capture (D263), and capture to the valve.
    expect(isRunAuthored({ kind: SUBAGENT_SUMMARY_KIND })).toBe(false)
    expect(isRunAuthored(null)).toBe(false)
  })
})

describe('the demotion class of a door row (D339: like captured tool output)', () => {
  it('a first moment demotes with the tool bulk, ahead of a person\'s words that are older than it', async () => {
    const setup = await open('class')
    const words = await prose(setup, 'people', 1_000)
    const w = startWorker(setup, hex(20_000), 2_000)
    // The first moment is the later row and carries `role: user` as the
    // leg's user turn; as user prose it would go second, behind the words.
    const meta = metaOf('class', w.firstMomentId)
    expect(meta['role']).toBe('user')
    expect(meta['source']).toBe('auto-capture')
    await setup.close()
    const budget = storedBytes('class') - 100
    const valve = await open('class', { maxStoreBytes: budget })
    expect(valve.retentionSweep()).toEqual({ evicted: 0, demoted: 1 })
    await valve.close()
    expect(metaOf('class', w.firstMomentId)['_demoted'], 'the first moment was demoted').toBe(true)
    expect(metaOf('class', words.nodeId)['_demoted'], 'the person\'s words were left whole').toBeUndefined()
    expect(contentOf('class', words.nodeId).length).toBeGreaterThan(10_000)
  })

  it('so does a send-back row, the door\'s other capture; the words are demoted only when the tool bulk is not enough', async () => {
    const setup = await open('sendback')
    const words = await prose(setup, 'people', 1_000)
    const w = startWorker(setup, hex(20_000), 2_000)
    const sb = setup.recordWorkerSendBack(w.ref, { message: hex(20_000), refs: [w.firstMomentId], at: 2_500 })!
    expect(metaOf('sendback', sb.sendBackId)['kind']).toBe(SEND_BACK_KIND)
    await setup.close()
    // Room for both door rows to shrink and no more.
    const budget = storedBytes('sendback') - bytesOf('sendback', w.firstMomentId) - bytesOf('sendback', sb.sendBackId) + 5_000
    const valve = await open('sendback', { maxStoreBytes: budget })
    expect(valve.retentionSweep()).toEqual({ evicted: 0, demoted: 2 })
    await valve.close()
    for (const id of [w.firstMomentId, sb.sendBackId]) {
      expect(metaOf('sendback', id)['_demoted'], id).toBe(true)
      expect(metaOf('sendback', id)['_full_len']).toBe(20_000)
    }
    expect(metaOf('sendback', words.nodeId)['_demoted'], 'the person\'s words were left whole').toBeUndefined()
    // A budget that even the tool bulk's shrinking cannot meet takes the
    // words last: the class order is tool bulk, then prose.
    const tight = await open('sendback', { maxStoreBytes: 1 })
    expect(tight.retentionSweep().demoted).toBe(1)
    await tight.close()
    expect(metaOf('sendback', words.nodeId)['_demoted']).toBe(true)
  })

  it('a first moment demotes to its bounded preview, whole text archived first, full length and archive path on the row', async () => {
    const setup = await open('preview')
    const prompt = hex(20_000)
    const w = startWorker(setup, prompt, 2_000)
    const previewLen = metaOf('preview', w.firstMomentId)['_preview_len'] as number
    expect(previewLen).toBeGreaterThan(0)
    await setup.close()
    const valve = await open('preview', { maxStoreBytes: 100 })
    expect(valve.retentionSweep().demoted).toBe(1)
    await valve.close()
    const meta = metaOf('preview', w.firstMomentId)
    expect(contentOf('preview', w.firstMomentId)).toBe(prompt.slice(0, previewLen))
    expect(meta['_full_len']).toBe(20_000)
    const archive = meta['_archive_path'] as string
    expect(existsSync(archive)).toBe(true)
    const nodes = (JSON.parse(readFileSync(archive, 'utf8')) as { nodes: Array<{ nodeId: string; content: string }> }).nodes
    expect(nodes.find((n) => n.nodeId === w.firstMomentId)?.content).toBe(prompt)
  })
})

describe('a leg\'s summary row is agent-authored for the valve; a plain subagent\'s is capture as today (D319, D339, D305, D263)', () => {
  /** Every column of the rows, to compare before and after a sweep. */
  const snapshot = (name: string, ids: string[]): Array<Record<string, unknown> | undefined> => ids.map((id) => rowOf(name, id))
  /** The harshest sweeps there are: one session kept and nothing else
   *  newer than it, then one byte of budget. */
  async function sweepHard(name: string): Promise<void> {
    const cap = await open(name, { maxSessions: 1 })
    cap.retentionSweep()
    await cap.close()
    const budget = await open(name, { maxStoreBytes: 1 })
    budget.retentionSweep()
    await budget.close()
  }

  it('the ticket door\'s: written by the door with no capture label, it stays with its checkpoint when the worker\'s whole lane is swept', async () => {
    const s = await open('ticket')
    const w = startWorker(s, hex(2_000), 1_000)
    const cp = await s.writeCheckpoint('state: the form validates', { run: 'r1', key: 'login-form', leg: w.ref, at: 1_100 })
    const ret = await s.retireWorker(w.ref, { output: hex(9_000), how: 'retired', summary: true, at: 1_200 })
    await prose(s, 'newer', 9_000_000)
    await s.close()
    expect(rowOf('ticket', ret.summaryId!)!['source_label']).toBeNull()
    const before = snapshot('ticket', [ret.summaryId!, cp.nodeId])
    await sweepHard('ticket')
    expect(snapshot('ticket', [ret.summaryId!, cp.nodeId])).toEqual(before)
    expect(rowOf('ticket', w.firstMomentId), 'the first moment went with its lane').toBeUndefined()
  })

  it('the hooks door\'s: written into the parent session\'s lane by the door, it stays when the parent session is swept', async () => {
    const s = await open('hooks')
    await s.writeBrief('wire the submit', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    const db = new DatabaseSync(dbOf('hooks'))
    try { registerSelf(db, 's1', MAIN, 1); registerSubagent(db, 's1', 'a1', 'builder', MAIN, 2) } finally { db.close() }
    s.startHooksLeg({ sessionId: 's1', agentId: 'a1', role: 'builder', at: 3, where: MAIN })
    const ret = s.retireHooksLeg({ sessionId: 's1', agentId: 'a1' }, { report: hex(9_000), at: 4 })
    await prose(s, 'newer', 9_000_000)
    await s.close()
    expect(rowOf('hooks', ret.summaryId!)!['source_label']).toBeNull()
    expect(metaOf('hooks', ret.summaryId!)['kind']).toBe(SUBAGENT_SUMMARY_KIND)
    const before = snapshot('hooks', [ret.summaryId!])
    await sweepHard('hooks')
    expect(snapshot('hooks', [ret.summaryId!])).toEqual(before)
  })

  /** A parent session's drained reports: a leg's, a plain subagent's, the
   *  client's own internal agent's, and a captured tool call. */
  async function drained(name: string): Promise<{ leg: string; plain: string; internal: string; tool: string }> {
    const s = await open(name)
    await s.writeBrief('wire the submit', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    const db = new DatabaseSync(dbOf(name))
    try { registerSelf(db, 's1', MAIN, 1); registerSubagent(db, 's1', 'leg', 'builder', MAIN, 2); registerSubagent(db, 's1', 'plain', 'lookup', MAIN, 2) } finally { db.close() }
    s.startHooksLeg({ sessionId: 's1', agentId: 'leg', role: 'builder', at: 3, where: MAIN })
    const report = (agentId: string, agentType: string | undefined, kind: string, at: number): void => {
      s.store.insertStaging({ sessionId: 's1', role: 'assistant', content: `report of ${agentId}: ${hex(30_000)}`, timestamp: at, agentId, ...(agentType ? { agentType } : {}), kind })
    }
    report('leg', 'builder', SUBAGENT_SUMMARY_KIND, 10)
    report('plain', 'lookup', SUBAGENT_SUMMARY_KIND, 11)
    report('agent-internal', undefined, 'internal-summary', 12)
    s.store.insertStaging({ sessionId: 's1', role: 'assistant', content: `Tool: Bash\n${hex(6_000)}`, toolName: 'Bash', timestamp: 13 })
    await new IngestionLoop(s).ingestBatch()
    await prose(s, 'newer', 9_000_000)
    await s.close()
    const landed = raw<{ node_id: string; source_label: string | null; m: string }>(name, "SELECT node_id, source_label, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') IN ('subagent-summary', 'internal-summary')")
    const byAgent = new Map(landed.map((r) => [(JSON.parse(r.m) as Record<string, unknown>)['_writer_agent_id'] as string, r]))
    // They all arrive as the drain labels every captured row...
    for (const r of landed) expect(r.source_label).toBe('auto-capture')
    // ... a leg's naming its run from its registration (D336), a plain
    // subagent's naming none.
    expect(JSON.parse(byAgent.get('leg')!.m)).toMatchObject({ run: 'r1', kind: SUBAGENT_SUMMARY_KIND })
    expect(JSON.parse(byAgent.get('plain')!.m)['run']).toBeUndefined()
    const tool = raw<{ node_id: string }>(name, "SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.tool_name') = 'Bash'")[0]!
    return { leg: byAgent.get('leg')!.node_id, plain: byAgent.get('plain')!.node_id, internal: byAgent.get('agent-internal')!.node_id, tool: tool.node_id }
  }

  it('the drain\'s: a leg\'s report lands labelled auto-capture and naming its run, and the valve leaves it through the cap and the budget; a plain subagent\'s and the client\'s own internal report are capture and go with their session', async () => {
    const ids = await drained('drain')
    const before = snapshot('drain', [ids.leg])
    await sweepHard('drain')
    // The label is not what the valve reads: the run is.
    expect(snapshot('drain', [ids.leg])).toEqual(before)
    for (const [what, id] of [['plain subagent\'s summary', ids.plain], ['internal report', ids.internal], ['tool output', ids.tool]] as const) {
      expect(rowOf('drain', id), `the ${what} went with its session`).toBeUndefined()
    }
  })

  it('over the byte budget a plain subagent\'s long summary is demoted like any capture, archived first, as on a store of the last release; a leg\'s is untouched', async () => {
    const ids = await drained('plainbudget')
    const legBefore = snapshot('plainbudget', [ids.leg])
    const full = contentOf('plainbudget', ids.plain)
    const budget = await open('plainbudget', { maxStoreBytes: 1 })
    budget.retentionSweep()
    await budget.close()
    expect(snapshot('plainbudget', [ids.leg])).toEqual(legBefore)
    expect(metaOf('plainbudget', ids.plain)['_demoted']).toBe(true)
    expect(metaOf('plainbudget', ids.plain)['_full_len']).toBe(full.length)
    const archive = metaOf('plainbudget', ids.plain)['_archive_path'] as string
    const nodes = (JSON.parse(readFileSync(archive, 'utf8')) as { nodes: Array<{ nodeId: string; content: string }> }).nodes
    expect(nodes.find((n) => n.nodeId === ids.plain)?.content).toBe(full)
  })
})

describe('a handoff lane\'s rows are never the valve\'s (D221, D222, D343)', () => {
  it('a run\'s whole export imported into another store lands read-only, and no sweep, session cap or byte budget, evicts, demotes or touches one row of it', async () => {
    // The sender: a real door-started worker, its captured rows, a
    // checkpoint and a summary row, the run opened and closed.
    const build = await open('build')
    await build.openRun({ run: 'r1', by: 'harness', at: 500 })
    const w = startWorker(build, hex(20_000), 1_000)
    for (let i = 0; i < 3; i++) {
      await build.insert(`$ npx vitest run ${i}\n${hex(3_000)}`, { leg: w.ref, createdAt: 1_001 + i, metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash' } })
    }
    await build.writeCheckpoint('state: the form validates', { run: 'r1', key: 'login-form', leg: w.ref, at: 1_100 })
    await build.retireWorker(w.ref, { output: 'builder done', how: 'retired', summary: true, at: 1_200 })
    await build.closeRun({ run: 'r1', by: 'harness', reason: 'delivered', at: 1_300 })
    const file = join(tmpDir, 'whole.json')
    exportRun(build, { run: 'r1', form: 'whole', project: 'proj', path: 'whole.json', abs: file, acknowledged: true })
    await build.close()

    // The receiver: its own sessions, and the file imported through the
    // handoff door (the importer's marks, the lane prefixed `handoff:`).
    const laptop = await open('laptop')
    for (let i = 0; i < 3; i++) await prose(laptop, `local-${i}`, 5_000 + i * 100, 8_000)
    await laptop.importJson(readFileSync(file, 'utf8'), { label: 'whole.json', handoff: { file: 'whole.json', importer: 'laptop' }, fromFile: true })
    await laptop.close()

    const imported = (): Array<Record<string, unknown>> =>
      raw<Record<string, unknown>>('laptop', "SELECT * FROM nodes WHERE session_key LIKE 'handoff:%' ORDER BY node_id")
    const before = imported()
    const kinds = before.map((r) => (JSON.parse(r['metadata_json'] as string) as Record<string, unknown>)['kind'])
    // The imported first moment, registration and summary rows among them,
    // and the captured tool output the whole form carries.
    for (const kind of ['first-moment', 'leg-registration', SUBAGENT_SUMMARY_KIND, 'checkpoint', 'run-open', 'run-close']) {
      expect(kinds, `the import carried a ${kind} row`).toContain(kind)
    }
    expect(before.filter((r) => (JSON.parse(r['metadata_json'] as string) as Record<string, unknown>)['tool_name'] === 'Bash')).toHaveLength(3)
    expect(before.every((r) => r['read_only'] === 1), 'the importer\'s rows are read-only').toBe(true)
    const archived = (): number => (existsSync(archiveOf('laptop')) ? readdirSync(archiveOf('laptop')).length : 0)

    // The cap alone evicts the receiver's own sessions...
    const cap = await open('laptop', { maxSessions: 1 })
    const swept = cap.retentionSweep()
    await cap.close()
    expect(swept.evicted, 'the cap evicted the receiver\'s own sessions').toBeGreaterThan(0)
    expect(imported()).toEqual(before)
    // ... and one byte of budget demotes what it can reach...
    const budget = await open('laptop', { maxStoreBytes: 1 })
    const demoted = budget.retentionSweep()
    await budget.close()
    expect(demoted.demoted, 'the byte budget demoted the receiver\'s own prose').toBeGreaterThan(0)
    // ... neither takes a row of the handoff lanes, and neither wrote an
    // archive of one.
    expect(imported()).toEqual(before)
    expect(archived()).toBeGreaterThan(0)
    for (const f of readdirSync(archiveOf('laptop'))) {
      const nodes = (JSON.parse(readFileSync(join(archiveOf('laptop'), f), 'utf8')) as { nodes: Array<{ nodeId: string }> }).nodes
      for (const n of nodes) expect(before.map((r) => r['node_id']), `${f} archived an imported row`).not.toContain(n.nodeId)
    }
    expect(raw('laptop', "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$._archived_session') LIKE 'handoff:%'")).toHaveLength(0)
  })
})

describe('the hooks door\'s first-moment row (D284, D320, D339)', () => {
  async function aHooksLeg(name: string): Promise<{ firstMomentId: string; toolId: string; summaryId: string }> {
    const s = await open(name)
    await s.writeBrief('wire the submit', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
    const db = new DatabaseSync(dbOf(name))
    try { registerSelf(db, 's1', MAIN, 1); registerSubagent(db, 's1', 'a1', 'builder', MAIN, 2) } finally { db.close() }
    const started = s.startHooksLeg({ sessionId: 's1', agentId: 'a1', role: 'builder', at: 3, where: MAIN })!
    const tool = await toolBulk(s, 's1', 4)
    const ret = s.retireHooksLeg({ sessionId: 's1', agentId: 'a1' }, { report: 'builder done', at: 5 })
    await prose(s, 'newer', 9_000_000)
    await s.close()
    return { firstMomentId: started.firstMomentId, toolId: tool.nodeId, summaryId: ret.summaryId! }
  }

  it('is written in the parent session\'s lane as capture, with the subagent as its writer', async () => {
    const rows = await aHooksLeg('lane')
    const row = rowOf('lane', rows.firstMomentId)!
    expect(row['session_key']).toBe('s1')
    expect(row['source_label']).toBe('auto-capture')
    expect(metaOf('lane', rows.firstMomentId)).toMatchObject({ kind: FIRST_MOMENT_KIND, role: 'user', session_id: 's1', _writer: 'builder', _writer_agent_id: 'a1' })
  })

  it('goes with the parent\'s session under the session cap, archived whole first; the leg\'s summary row stays', async () => {
    const rows = await aHooksLeg('cap')
    const text = contentOf('cap', rows.firstMomentId)
    const summaryBefore = rowOf('cap', rows.summaryId)
    const valve = await open('cap', { maxSessions: 1 })
    expect(valve.retentionSweep().evicted).toBe(2) // the first moment and the tool output
    await valve.close()
    expect(rowOf('cap', rows.firstMomentId)).toBeUndefined()
    expect(rowOf('cap', rows.toolId)).toBeUndefined()
    expect(rowOf('cap', rows.summaryId)).toEqual(summaryBefore)
    const [tomb] = raw<{ m: string }>('cap', "SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$._archived_session') = 's1'")
    const archive = (JSON.parse(tomb!.m) as Record<string, unknown>)['_archive_path'] as string
    const nodes = (JSON.parse(readFileSync(archive, 'utf8')) as { nodes: Array<{ nodeId: string; content: string }> }).nodes
    expect(nodes.find((n) => n.nodeId === rows.firstMomentId)?.content).toBe(text)
  })

  it('is in the tool-bulk class over the byte budget; its text is its own preview, so there is nothing to shrink and it stays whole while the captured output is demoted', async () => {
    const rows = await aHooksLeg('budget')
    const before = rowOf('budget', rows.firstMomentId)
    expect(metaOf('budget', rows.firstMomentId)['_preview_len'], 'a door line is shorter than the preview').toBeUndefined()
    const valve = await open('budget', { maxStoreBytes: 1 })
    expect(valve.retentionSweep().demoted).toBeGreaterThan(0)
    await valve.close()
    expect(metaOf('budget', rows.toolId)['_demoted']).toBe(true)
    expect(rowOf('budget', rows.firstMomentId)).toEqual(before)
    expect(rowOf('budget', rows.summaryId)).toBeTruthy()
  })
})
