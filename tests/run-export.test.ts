/**
 * A run's export forms and the way a leg's rows come back into a run by
 * the handoff, below the charter (unit 6 of the beta.3 build; D300, D310,
 * D318, D319, D343): the skeleton's row set against the whole form's, the
 * file's head, the registrations as claims, the believed supersession, the
 * run's facts counting an imported leg, the pointer into the handoff lane,
 * and a run whose legs span two stores reconstructed whole. Every store
 * claim is read back through a separate handle on the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { buildHandoff, exportRun, checkRunForm, RUN_SECRETS_WARNING, writeHandoffFile, resolveProjectPath, isHandoffFile } from '../src/handoff.js'
import { RUN_ROWS_SQL, HANDOFF_CLAIMS_KEY } from '../src/runs.js'
import { FIRST_MOMENTS_NOTE, PROMPT_UNSEEN_SENTENCE, isDoorLine, doorLineNote, registrationRowId } from '../src/run-export.js'
import { hooksFirstMomentText } from '../src/flat-store.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../src/handoff.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../src/server/server.js'
import { spawnCli } from './helpers/cli-spawn.js'
import { mkdirSync } from 'node:fs'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-runexp-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const dbOf = (name: string): string => join(tmpDir, `${name}.db`)
const open = (name: string): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbOf(name))), retentionInterval: 1_000_000 })
function raw<T>(name: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(dbOf(name), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
const metaIn = (name: string, id: string): Record<string, unknown> =>
  JSON.parse(raw<{ m: string }>(name, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
const here = { pid: process.pid, start: null, host: hostname() }

interface Made { builder: { sessionId: string; agentId: string }; reviewer: { sessionId: string; agentId: string }; cps: string[]; summaries: string[] }

/** A run of two workers, three checkpoints, two summaries, a run open and
 *  a close, and tool output captured in each leg's lane. */
async function makeRun(s: FlatStore, run = 'r1'): Promise<Made> {
  await s.openRun({ run, by: 'harness', at: 1_000 })
  await s.writeBrief('build the login form', { run, key: 'login-form', role: 'builder', checkpointer: 'builder', by: 'harness', at: 1_001 })
  const out: Made = { builder: null as never, reviewer: null as never, cps: [], summaries: [] }
  for (const [role, base] of [['builder', 2_000], ['reviewer', 3_000]] as const) {
    const leg = await s.registerWorker({
      door: 'library', ticket: { parent: { id: 'p1' }, run, key: 'login-form', role, checkpointer: role, mintedAt: base - 1 },
      process: here, at: base,
      startCheckpoints: s.checkpointsInEffect(run, 'login-form').map((c) => c.nodeId),
    })
    const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
    out[role] = ref
    await s.insert(`first moment of ${role}: build the login form (the spawner's prompt)`, {
      leg: ref, createdAt: base + 1,
      metadata: { kind: 'first-moment', source: 'auto-capture', role: 'user', run, key: 'login-form' },
    })
    for (let i = 0; i < 5; i++) {
      await s.insert(`$ npx vitest run ${role} ${i}\nsecret-looking output sk-${role}-${i}`, {
        leg: ref, createdAt: base + 2 + i, metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash' },
      })
    }
    const cp = await s.writeCheckpoint(`state after ${role}: step done`, { run, key: 'login-form', leg: ref, at: base + 10 })
    out.cps.push(cp.nodeId)
    const ret = await s.retireWorker(ref, { output: `${role} done`, how: 'retired', summary: true, at: base + 20 })
    out.summaries.push(ret.summaryId!)
  }
  await s.closeRun({ run, by: 'harness', reason: 'all keys delivered', at: 4_000 })
  return out
}

describe('the forms of a run export (D300)', () => {
  it('the skeleton holds the run\'s own rows and the registrations and no captured tool output; the whole form adds every leg\'s lane', async () => {
    const s = await open('a')
    const made = await makeRun(s)
    // Another run's rows, which no form of r1 may carry.
    await makeRun(s, 'r2')
    const skeleton = s.runRows('r1', 'skeleton')
    const whole = s.runRows('r1', 'whole')
    // A count asks for no content and agrees with what a build holds.
    expect([s.runRows('r1', 'skeleton', 0).total, s.runRows('r1', 'whole', 0).total]).toEqual([skeleton.total, whole.total])
    expect(s.runRows('r1', 'skeleton', 0).nodes).toEqual([])
    await s.close()
    const kinds = (rows: Array<{ metadata: Record<string, unknown> | null }>): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of rows) { const k = String(r.metadata?.['kind'] ?? 'capture'); out[k] = (out[k] ?? 0) + 1 }
      return out
    }
    expect(kinds(skeleton.nodes)).toEqual({ 'run-open': 1, 'run-close': 1, brief: 1, checkpoint: 2, 'first-moment': 2, 'subagent-summary': 2, 'leg-registration': 2 })
    expect(skeleton.total).toBe(skeleton.nodes.length)
    // Whole: the skeleton plus 10 captured calls, nothing of r2.
    expect(kinds(whole.nodes)).toEqual({ ...kinds(skeleton.nodes), capture: 10 })
    const ids = new Set(skeleton.nodes.map((n) => String(n.nodeId)))
    for (const n of whole.nodes) if (ids.has(String(n.nodeId))) ids.delete(String(n.nodeId))
    expect(ids.size).toBe(0)
    for (const n of [...skeleton.nodes, ...whole.nodes]) expect(JSON.stringify(n)).not.toContain('r2')
    // The checkpoints and summaries are the ones written, in moment order.
    expect(skeleton.nodes.filter((n) => n.metadata?.['kind'] === 'checkpoint').map((n) => n.nodeId)).toEqual(made.cps)
    expect(skeleton.nodes.map((n) => n.createdAt)).toEqual(skeleton.nodes.map((n) => Number(n.createdAt)).sort((a, b) => a - b))
    // No captured row in the skeleton by any key.
    expect(skeleton.nodes.some((n) => JSON.stringify(n).includes('secret-looking'))).toBe(false)
    expect(whole.nodes.filter((n) => JSON.stringify(n).includes('secret-looking'))).toHaveLength(10)
  })

  it('a run reads the same by the store file\'s plain SQL: the whole form is the reader\'s recipe plus the registrations', async () => {
    const s = await open('a')
    await makeRun(s)
    const whole = s.runRows('r1', 'whole')
    await s.close()
    const sql = raw<{ node_id: string }>('a', RUN_ROWS_SQL, 'r1', 'r1').map((r) => r.node_id)
    const mine = whole.nodes.filter((n) => (n.metadata as Record<string, unknown>)['kind'] !== 'leg-registration').map((n) => String(n.nodeId))
    expect(new Set(mine)).toEqual(new Set(sql))
  })

  it('refuses a form that is not a run\'s, and names which run is wanted', () => {
    expect(() => checkRunForm('r1', 'summaries')).toThrow(/skeleton \(the default\) or whole/)
    expect(() => checkRunForm(undefined, 'skeleton')).toThrow(/name the run/)
    expect(() => checkRunForm('', undefined)).toThrow(/name/)
    expect(checkRunForm('r1', undefined)).toBe('skeleton')
    expect(checkRunForm('r1', 'whole')).toBe('whole')
    expect(checkRunForm(undefined, undefined)).toBe('summaries')
  })
})

describe('the file and its reply', () => {
  it('the head names the run and the form; the entries are the skeleton; a run the store holds nothing of writes nothing', async () => {
    const s = await open('a')
    await makeRun(s)
    const out = exportRun(s, { run: 'r1', project: 'proj', path: 'handoffs/r1.json', abs: join(tmpDir, 'r1.json') })
    const none = exportRun(s, { run: 'nope', project: 'proj', path: 'handoffs/nope.json', abs: join(tmpDir, 'nope.json') })
    await s.close()
    expect(out.status).toBe('built')
    expect(none.status).toBe('empty')
    expect(existsSync(join(tmpDir, 'nope.json'))).toBe(false)
    const file = JSON.parse(readFileSync(join(tmpDir, 'r1.json'), 'utf8')) as Record<string, unknown>
    expect(file['form']).toBe('skeleton')
    expect(file['run']).toBe('r1')
    expect(file['node_count']).toBe((file['nodes'] as unknown[]).length)
    expect(String(file['holds'])).toMatch(/skeleton of the run "r1".*no captured tool output/)
    expect(String(file['first_moments'])).toBe(FIRST_MOMENTS_NOTE)
    expect(typeof file['exported_by']).toBe('string')
    expect(String(file['to_import'])).toContain('handoffs/r1.json')
    expect(isHandoffFile(join(tmpDir, 'r1.json'))).toBe(true)
  })

  it('the whole form writes nothing without the acknowledgement and says the warning; with it the file holds the lanes', async () => {
    const s = await open('a')
    await makeRun(s)
    const refused = exportRun(s, { run: 'r1', form: 'whole', project: 'proj', path: 'w.json', abs: join(tmpDir, 'w.json') })
    expect(refused.status).toBe('warning')
    expect(refused.status === 'warning' && refused.warning).toBe(RUN_SECRETS_WARNING)
    expect(RUN_SECRETS_WARNING).toMatch(/whole run export/)
    expect(RUN_SECRETS_WARNING).not.toMatch(/whole-journal handoff/)
    expect(existsSync(join(tmpDir, 'w.json'))).toBe(false)
    const given = exportRun(s, { run: 'r1', form: 'whole', project: 'proj', path: 'w.json', abs: join(tmpDir, 'w.json'), acknowledged: true })
    await s.close()
    expect(given.status).toBe('built')
    const file = JSON.parse(readFileSync(join(tmpDir, 'w.json'), 'utf8')) as { form: string; nodes: Array<{ content: string }> }
    expect(file.form).toBe('whole')
    expect(file.nodes.filter((n) => n.content.includes('secret-looking'))).toHaveLength(10)
  })

  it('the skeleton asks no acknowledgement and its notes say what first moments are, and which are a door\'s line', async () => {
    const s = await open('a')
    const made = await makeRun(s)
    // A hooks-door leg's first moment is the door's line.
    await s.insert(hooksFirstMomentText('reviewer', 'a1b2', 'r1', 'login-form', 1, 1), {
      createdAt: 3_500, metadata: { kind: 'first-moment', source: 'auto-capture', role: 'user', run: 'r1', key: 'login-form', session_id: made.reviewer.sessionId, _writer: 'reviewer', _writer_agent_id: 'a1b2' },
    })
    const out = exportRun(s, { run: 'r1', project: 'proj', path: null, inlineLimit: 100 })
    await s.close()
    expect(out.status).toBe('built')
    if (out.status !== 'built') return
    expect(out.written).toBe(false)
    expect(out.built.notes[0]).toBe(FIRST_MOMENTS_NOTE)
    expect(out.built.notes[1]).toContain(PROMPT_UNSEEN_SENTENCE)
    expect(out.built.notes[1]).toContain('1 of the 3 first moments')
    expect(out.built.notes).toHaveLength(2)
  })

  it('a first moment is a door\'s line only when it reads as one', () => {
    expect(isDoorLine(hooksFirstMomentText('builder', 'a1', 'r1', 'k', 1, 0))).toBe(true)
    expect(isDoorLine('please build the thing. treecontext: the first moment of nothing; not seen by this door.')).toBe(false)
    expect(isDoorLine("The prompt as the spawner wrote it, 'not seen by this door.'")).toBe(false)
    expect(doorLineNote([{ content: 'a prompt', leg: 'builder' }])).toBeNull()
  })
})

describe('a leg that ran on another machine comes back by the handoff (D310, D343)', () => {
  /** laptop holds a run of two legs, checkpoint 2 the newest; build-02, a
   *  store of its own, was handed the run's skeleton, ran a third leg
   *  that wrote checkpoint 3 on top of it, and exports its run. */
  async function laptopAndBuild(): Promise<{ laptop: FlatStore; made: Made; fileA: string; fileB: string; third: { sessionId: string; agentId: string }; thirdCp: string; thirdSummary: string }> {
    const laptop = await open('laptop')
    const made = await makeRun(laptop)
    // The skeleton goes out, ...
    const fileA = join(tmpDir, 'out.json')
    exportRun(laptop, { run: 'r1', project: 'proj', path: 'out.json', abs: fileA })
    const build = await open('build')
    await build.importJson(readFileSync(fileA, 'utf8'), { label: 'out.json', handoff: { file: 'out.json', importer: 'build-02' }, fromFile: true })
    // ... a third leg runs there, starting from what is in effect there ...
    const start = build.checkpointsInEffect('r1', 'login-form')
    const leg = await build.registerWorker({
      door: 'library', ticket: { parent: { id: 'build-parent' }, run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'builder', mintedAt: 4_999 },
      process: here, at: 5_000, startCheckpoints: start.map((c) => c.nodeId),
    })
    const third = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
    await build.insert('first moment of the third leg', { leg: third, createdAt: 5_001, metadata: { kind: 'first-moment', source: 'auto-capture', role: 'user', run: 'r1', key: 'login-form' } })
    const cp = await build.writeCheckpoint('state after build-02: finished the login form', { run: 'r1', key: 'login-form', leg: third, at: 5_100 })
    const ret = await build.retireWorker(third, { output: 'build-02 finished', how: 'retired', summary: true, at: 5_200 })
    // ... and its export goes home.
    const fileB = join(tmpDir, 'back.json')
    exportRun(build, { run: 'r1', project: 'proj', path: 'back.json', abs: fileB })
    await build.close()
    return { laptop, made, fileA, fileB, third, thirdCp: cp.nodeId, thirdSummary: ret.summaryId! }
  }

  it('the remote store numbers the new checkpoint in its own sequence, the imported ones taking none, and the leg supersedes what it started from', async () => {
    const { laptop, made, thirdCp } = await laptopAndBuild()
    await laptop.close()
    const m = metaIn('build', thirdCp)
    expect(m['_checkpoint_number']).toBe(1)
    expect(m['supersedes']).toEqual([made.cps[1]])
    // The laptop's checkpoints sit in build-02's handoff lanes with no number of its sequence.
    for (const id of made.cps) expect(metaIn('build', id)['_checkpoint_number']).toBeUndefined()
  })

  it('imports into the lanes of the legs, keeps ids, keeps the claims as claims, believes the supersession and counts the leg', async () => {
    const { laptop, made, fileB, third, thirdCp, thirdSummary } = await laptopAndBuild()
    const before = raw<Record<string, unknown>>('laptop', 'SELECT * FROM nodes WHERE node_id = ?', made.cps[1]!)[0]!
    const result = await laptop.importJson(readFileSync(fileB, 'utf8'), { label: 'back.json', handoff: { file: 'back.json', importer: 'laptop' }, fromFile: true })
    // The run's rows already here are present, the new leg's land: checkpoint, summary, first moment, registration (the laptop's own two legs are not a second registration).
    expect(result.importedCount).toBeGreaterThanOrEqual(4)
    expect(result.idConflicts).toBe(0)
    // Ids kept: the third leg's checkpoint is the row the remote store wrote.
    const row = raw<{ session_key: string; m: string }>('laptop', 'SELECT session_key, metadata_json AS m FROM nodes WHERE node_id = ?', thirdCp)[0]!
    expect(row.session_key).toBe(`handoff:${third.sessionId}`)
    const meta = JSON.parse(row.m) as Record<string, unknown>
    // The claim is the file's claim: under the claims, never the row's own identity.
    expect(meta['supersedes']).toBeUndefined()
    expect(meta['superseded_by']).toBeUndefined()
    expect(meta['_writer']).toBeUndefined()
    expect(meta['_checkpoint_number']).toBeUndefined()
    expect([meta['_door'], meta['_identity']]).toEqual(['import', 'imported'])
    expect(meta['_handoff_file']).toBe('back.json')
    const claims = meta[HANDOFF_CLAIMS_KEY] as Record<string, unknown>
    expect(claims['supersedes']).toEqual([made.cps[1]])
    expect(claims['_checkpoint_number']).toBe(1)
    expect(claims['_writer']).toBe('builder')
    expect(claims['run']).toBe('r1')
    // The local checkpoint 2 is unchanged byte for byte.
    expect(raw<Record<string, unknown>>('laptop', 'SELECT * FROM nodes WHERE node_id = ?', made.cps[1]!)[0]).toEqual(before)
    // The lookup: 3 legs, the imported checkpoint in effect and flagged, 2 not.
    const l = laptop.lookupKey({ run: 'r1', key: 'login-form' })
    expect(l.facts.legsRun).toBe(3)
    expect(l.facts.importedLegs).toBe(1)
    expect(l.facts.checkpointsUnderKey).toBe(3)
    // Numbered 1 in build-02's sequence, a number this store's local 1 shares and collides with none.
    expect(l.checkpoints.map((c) => [c.nodeId, c.number, c.claimedNumber, c.imported])).toEqual([[thirdCp, null, 1, true]])
    expect(l.checkpoints[0]!.flag).toContain('Checkpoint number 1 as numbered there arrived by import from "back.json"')
    expect(l.checkpoints[0]!.flag).toContain('claims it supersedes checkpoint number 2')
    expect(l.line).toBe('Checkpoint number 1 as numbered there is in effect under "login-form" on the run "r1".')
    const importedLeg = l.legs.find((g) => g.imported !== null)!
    expect(importedLeg.sessionId).toBe(third.sessionId)
    expect([importedLeg.state, importedLeg.role, importedLeg.imported!.file]).toEqual(['retired', 'builder', 'back.json'])
    expect(l.legs.filter((g) => g.imported === null)).toHaveLength(2)
    expect(l.notes.join(' ')).toMatch(/1 of the 3 legs of this run arrived by import/)
    // The lookup's return line points into the handoff lane and says it arrived by import.
    const ret = l.checkpoints[0]!.legReturn
    expect(ret.summary?.nodeId).toBe(thirdSummary)
    expect(ret.line).toContain(thirdSummary)
    expect(ret.line).toContain('checkpoint number 1 as numbered there, which arrived by import')
    expect(ret.line).toContain(`handoff:${third.sessionId}`)
    expect(ret.summary?.writer).toBe('imported from back.json')
    laptop.close()
  })

  it('imports a second time to the same state: every row present, no leg counted twice', async () => {
    const { laptop, fileB } = await laptopAndBuild()
    await laptop.importJson(readFileSync(fileB, 'utf8'), { label: 'back.json', handoff: { file: 'back.json', importer: 'laptop' }, fromFile: true })
    const again = await laptop.importJson(readFileSync(fileB, 'utf8'), { label: 'back.json', handoff: { file: 'back.json', importer: 'laptop' }, fromFile: true })
    expect(again.importedCount).toBe(0)
    expect(laptop.lookupKey({ run: 'r1', key: 'login-form' }).facts.legsRun).toBe(3)
    await laptop.close()
  })

  it('a leg this store registered, exported and coming back is not a second leg', async () => {
    const laptop = await open('laptop')
    const made = await makeRun(laptop)
    const file = join(tmpDir, 'own.json')
    exportRun(laptop, { run: 'r1', project: 'proj', path: 'own.json', abs: file })
    const r = await laptop.importJson(readFileSync(file, 'utf8'), { label: 'own.json', handoff: { file: 'own.json', importer: 'me' }, fromFile: true })
    const l = laptop.lookupKey({ run: 'r1', key: 'login-form' })
    await laptop.close()
    expect(r.importedCount).toBe(0)
    expect(r.alreadyPresent).toBeGreaterThan(0)
    expect(l.facts.legsRun).toBe(2)
    expect(l.facts.importedLegs).toBe(0)
    expect(l.checkpoints.map((c) => c.nodeId)).toEqual([made.cps[1]])
    expect(l.checkpoints[0]!.imported).toBe(false)
  })

  it('the run reads back whole from one store by plain SQL: the handoff lane\'s rows in their own moments\' order, each naming its writer as imported', async () => {
    const { laptop, made, fileB, thirdCp } = await laptopAndBuild()
    await laptop.importJson(readFileSync(fileB, 'utf8'), { label: 'back.json', handoff: { file: 'back.json', importer: 'laptop' }, fromFile: true })
    await laptop.close()
    const rows = raw<{ node_id: string; created_at: number; writer: string; kind: string; key: string | null }>('laptop', RUN_ROWS_SQL, 'r1', 'r1')
    expect(rows.map((r) => r.created_at)).toEqual(rows.map((r) => r.created_at).sort((a, b) => a - b))
    const imported = rows.filter((r) => r.created_at >= 5_000)
    // (build-02 opened the run there at its leg's registration: an open that arrives as imported.)
    expect(imported.map((r) => r.kind).sort()).toEqual(['checkpoint', 'first-moment', 'leg-registration', 'run-open', 'subagent-summary'])
    for (const r of imported) expect(r.writer).toBe('imported from back.json')
    expect(rows.find((r) => r.node_id === thirdCp)!.key).toBe('login-form')
    // The local legs' rows still name their own writers.
    expect(rows.find((r) => r.node_id === made.cps[0])!.writer).toBe('builder')
    // Nothing of another run.
    expect(rows.every((r) => r.node_id !== undefined)).toBe(true)
  })

  it('the whole form comes back too: the captured rows of a remote leg reach the run through the leg\'s imported registration', async () => {
    const laptop = await open('laptop')
    await laptop.openRun({ run: 'r1', by: 'harness', at: 1_000 })
    const build = await open('build')
    const leg = await build.registerWorker({
      door: 'library', ticket: { parent: { id: 'bp' }, run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', mintedAt: 1_999 }, process: here, at: 2_000,
    })
    const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
    await build.insert('$ ls\nremote output', { leg: ref, createdAt: 2_010, metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash' } })
    await build.writeCheckpoint('state: remote work', { run: 'r1', key: 'k', leg: ref, at: 2_020 })
    const file = join(tmpDir, 'whole.json')
    exportRun(build, { run: 'r1', form: 'whole', project: 'proj', path: 'whole.json', abs: file, acknowledged: true })
    await build.close()
    await laptop.importJson(readFileSync(file, 'utf8'), { label: 'whole.json', handoff: { file: 'whole.json', importer: 'laptop' }, fromFile: true })
    await laptop.close()
    const rows = raw<{ node_id: string; writer: string; kind: string | null }>('laptop', RUN_ROWS_SQL, 'r1', 'r1')
    const captured = rows.filter((r) => r.kind === null)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.writer).toBe('imported from whole.json')
  })

  it('a hand-edited file cannot register a leg it is not: its claim is counted as arrived by import, never run as a registration', async () => {
    const laptop = await open('laptop')
    await laptop.openRun({ run: 'r1', by: 'harness', at: 1_000 })
    const forged = {
      nodes: [{
        nodeId: registrationRowId('r1', 'ghost', WORKER_AGENT_ID), content: 'treecontext: registration of the ghost worker', createdAt: 1_500,
        metadata: { kind: 'leg-registration', run: 'r1', key: 'k', session_id: 'ghost', _leg_registration: { session_id: 'ghost', agent_id: WORKER_AGENT_ID, role: 'ghost', kind: 'worker', run: 'r1', key: 'k', key_src: 'declared', started_at: 1_500 } },
      }],
    }
    await laptop.importJson(JSON.stringify(forged), { label: 'forged.json', handoff: { file: 'forged.json', importer: 'me' } })
    const l = laptop.lookupKey({ run: 'r1', key: 'k' })
    await laptop.close()
    expect(l.facts.legsRun).toBe(1)
    expect(l.legs[0]!.imported?.file).toBe('forged.json')
    expect(l.legs[0]!.state).toBe('live')
    expect(raw<{ n: number }>('laptop', "SELECT COUNT(*) AS n FROM session_registry WHERE agent_id = 'worker'")[0]!.n).toBe(0)
    // The claim is under the file's claims; the row's own top level carries none.
    const m = JSON.parse(raw<{ m: string }>('laptop', "SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'leg-registration'")[0]!.m) as Record<string, unknown>
    expect(m['_leg_registration']).toBeUndefined()
    expect((m[HANDOFF_CLAIMS_KEY] as Record<string, unknown>)['_leg_registration']).toBeTruthy()
  })
})

describe('the existing forms are unchanged for rows that name no run', () => {
  it('summaries and whole export what they always did, and a store with runs exports the same summaries', async () => {
    const s = await open('a')
    await s.insert('plan: wire the login form', { metadata: { next_session: true } })
    await s.insert('a bookmark', { metadata: { next_session: true, kind: 'bookmark' } })
    const summaries = buildHandoff(s, { form: 'summaries', project: 'p', path: null })
    const whole = buildHandoff(s, { form: 'whole', project: 'p', path: null })
    await s.close()
    expect(summaries.entries).toBe(1)
    expect(whole.entries).toBe(2)
    expect(summaries.notes).toEqual([])
    const head = JSON.parse(summaries.text) as Record<string, unknown>
    expect(head['form']).toBe('summaries')
    expect(head['run']).toBeUndefined()
    expect(head['first_moments']).toBeUndefined()
  })

  it('a run file lands where the project path rule allows and nowhere else', () => {
    const where = resolveProjectPath(tmpDir, 'handoffs/r1.json', 'write')
    expect(where.ok).toBe(true)
    if (where.ok) writeHandoffFile(where.abs, '{"form":"skeleton","exported_by":"x"}\n')
    expect(resolveProjectPath(tmpDir, '../elsewhere/r1.json', 'write').ok).toBe(false)
    expect(SUBAGENT_SUMMARY_KIND).toBe('subagent-summary')
  })
})

describe('the export tool and the shell take the run', () => {
  async function serveOver(s: FlatStore, projectDir: string): Promise<{ c: Client; done: () => Promise<void> }> {
    const server = createServer(s, { projectDir, ccSessionId: 'cc-test' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'runexp', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    return { c, done: async () => { await c.close(); await server.close() } }
  }
  const call = async (c: Client, args: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, unknown>; text: string }> => {
    const res = await c.callTool({ name: 'treecontext_export', arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
    const text = res.content[0]!.text
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) as Record<string, unknown> } catch { /* inline text */ }
    return { isError: res.isError === true, json, text }
  }

  it('run is the skeleton by default, whole is behind the acknowledgement, other forms are refused, an unknown run writes nothing', async () => {
    const proj = join(tmpDir, 'proj')
    mkdirSync(proj, { recursive: true })
    const s = await open('a')
    await makeRun(s)
    const { c, done } = await serveOver(s, proj)
    const skeleton = await call(c, { run: 'r1', path: 'handoffs/r1.json' })
    expect(skeleton.isError).toBe(false)
    expect(skeleton.json['form']).toBe('skeleton')
    expect(skeleton.json['warning']).toBeUndefined()
    expect((JSON.parse(readFileSync(join(proj, 'handoffs', 'r1.json'), 'utf8')) as { form: string }).form).toBe('skeleton')
    const unacked = await call(c, { run: 'r1', form: 'whole', path: 'handoffs/r1-whole.json' })
    expect(unacked.json['warning']).toBe(RUN_SECRETS_WARNING)
    expect(unacked.json['written']).toBe(false)
    expect(existsSync(join(proj, 'handoffs', 'r1-whole.json'))).toBe(false)
    const acked = await call(c, { run: 'r1', form: 'whole', path: 'handoffs/r1-whole.json', secrets_acknowledged: true })
    expect(acked.json['form']).toBe('whole')
    expect((JSON.parse(readFileSync(join(proj, 'handoffs', 'r1-whole.json'), 'utf8')) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(skeleton.json['entries'] as number)
    expect((await call(c, { run: 'r1', form: 'summaries', path: 'handoffs/x.json' })).isError).toBe(true)
    expect((await call(c, { form: 'skeleton', path: 'handoffs/x.json' })).isError).toBe(true)
    expect((await call(c, { run: 'r1', node_id: 'abc' })).isError).toBe(true)
    const none = await call(c, { run: 'nope', path: 'handoffs/nope.json' })
    expect([none.isError, none.json['written'], none.json['entries']]).toEqual([false, false, 0])
    expect(existsSync(join(proj, 'handoffs', 'nope.json'))).toBe(false)
    // The path rule: a run file goes inside the project and nowhere else.
    const out = await call(c, { run: 'r1', path: '../../outside.json' })
    expect(out.isError).toBe(true)
    // An inline run export is the compact text with the newest entries, capped.
    const inline = await call(c, { run: 'r1', max_export_nodes: 3 })
    expect(inline.isError).toBe(false)
    const body = JSON.parse(inline.text) as { nodes: unknown[]; omitted: number; run: string }
    expect([body.nodes.length, body.run]).toEqual([3, 'r1'])
    expect(body.omitted).toBeGreaterThan(0)
    // The old forms still export what they did, with no run in the head.
    const old = await call(c, { path: 'handoffs/old.json' })
    expect(old.json['entries']).toBe(2)
    expect((JSON.parse(readFileSync(join(proj, 'handoffs', 'old.json'), 'utf8')) as Record<string, unknown>)['run']).toBeUndefined()
    await done()
    await s.close()
  })

  it('the shell exports the same run file as the tool, the warning first for the whole form', async () => {
    const proj = join(tmpDir, 'proj2')
    mkdirSync(proj, { recursive: true })
    const s = await open('a')
    await makeRun(s)
    const { c, done } = await serveOver(s, proj)
    await call(c, { run: 'r1', path: 'handoffs/by-tool.json' })
    await done()
    await s.close()
    const home = join(tmpDir, 'home')
    mkdirSync(home, { recursive: true })
    const args = ['export', 'handoffs/by-shell.json', '--run', 'r1', '--store', dbOf('a'), '--project-dir', proj, '--no-debug']
    const sk = spawnCli(args, { home, cwd: proj })
    expect(sk.status, sk.out).toBe(0)
    expect(sk.stdout).toContain('Wrote ')
    expect(sk.stdout).toContain(FIRST_MOMENTS_NOTE)
    const strip = (t: string): string => t.replace(/"exported_at": "[^"]+"/, '"exported_at": ""').replace(/by-(shell|tool)/g, 'by-x')
    expect(strip(readFileSync(join(proj, 'handoffs', 'by-shell.json'), 'utf8'))).toBe(strip(readFileSync(join(proj, 'handoffs', 'by-tool.json'), 'utf8')))
    const whole = spawnCli([...args.map((a) => (a === 'handoffs/by-shell.json' ? 'handoffs/w.json' : a)), '--whole'], { home, cwd: proj })
    expect(whole.status).toBe(1)
    expect(whole.stderr).toContain(RUN_SECRETS_WARNING)
    expect(existsSync(join(proj, 'handoffs', 'w.json'))).toBe(false)
    const nope = spawnCli(['export', 'handoffs/n.json', '--run', 'nope', '--store', dbOf('a'), '--project-dir', proj, '--no-debug'], { home, cwd: proj })
    expect(nope.status).toBe(1)
    expect(existsSync(join(proj, 'handoffs', 'n.json'))).toBe(false)
  })
})
