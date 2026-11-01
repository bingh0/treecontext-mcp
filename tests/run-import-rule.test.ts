/**
 * The import rule for a run's rows (unit 6's gate; D165, D293, D343,
 * D360), below the charter: the sender's stamps and trace under the file's
 * claims and never at the top level, an imported brief in effect for no
 * role and an imported close ending none, an imported number the file's
 * claim and in no sequence here, a namespace's export holding only its own
 * legs, a registration agreeing or differing, a run's inner runs named in
 * the head. Every store claim is read back through a separate handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { exportRun, buildHandoff, RUN_SECRETS_WARNING } from '../src/handoff.js'
import { WRITER_STAMP_KEYS } from '../src/persistence/session-registry.js'
import { RUN_ROWS_SQL, HANDOFF_CLAIMS_KEY, importedLegsOf } from '../src/runs.js'
import { registrationRowId } from '../src/run-export.js'
import { WORKER_AGENT_ID, legsOfRun } from '../src/persistence/leg-registry.js'
import { REGISTRATION_DIFFERS_KEY } from '../src/run-kinds.js'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createServer } from '../src/server/server.js'
import { spawnCli } from './helpers/cli-spawn.js'
import { openRunWorld, hooksSubagent, startContext, rawRegistration, type RunWorld } from './journal/run-world.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-runimp-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const dbOf = (name: string): string => join(tmpDir, `${name}.db`)
const open = (name: string, namespace?: string): Promise<FlatStore> =>
  FlatStore.open({ database: openNodeSqlite(new DatabaseSync(dbOf(name))), retentionInterval: 1_000_000, ...(namespace ? { namespace } : {}) })
function raw<T>(name: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(dbOf(name), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}
const metaIn = (name: string, id: string): Record<string, unknown> =>
  JSON.parse(raw<{ m: string }>(name, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
const here = { pid: process.pid, start: null, host: hostname() }
const handoff = (file: string) => ({ label: file, handoff: { file, importer: 'me' }, fromFile: true as const })

/** A leg of a run, registered, with its first moment, one checkpoint and its summary. */
async function legWithCheckpoint(s: FlatStore, run: string, key: string, role: string, at: number, supersedes?: string[]): Promise<{ ref: { sessionId: string; agentId: string }; cp: string }> {
  const leg = await s.registerWorker({
    door: 'library', ticket: { parent: { id: 'p1' }, run, key, role, checkpointer: role, mintedAt: at - 1 }, process: here, at,
    startCheckpoints: s.checkpointsInEffect(run, key).map((c) => c.nodeId),
  })
  const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  await s.insert(`first moment of the ${role}`, { leg: ref, createdAt: at + 1, metadata: { kind: 'first-moment', source: 'auto-capture', role: 'user', run, key } })
  const cp = await s.writeCheckpoint(`state of ${key} after the ${role}`, { run, key, leg: ref, at: at + 10, ...(supersedes ? { supersedes } : {}) })
  await s.retireWorker(ref, { output: `${role} done`, how: 'retired', summary: true, at: at + 20 })
  return { ref, cp: cp.nodeId }
}

describe('the sender\'s stamps and trace sit under the file\'s claims (D293, D360)', () => {
  it('a forged file keeps none of the sender\'s stamps, trace or number at the top level; the receiving store stamps only that it arrived by import', async () => {
    const s = await open('a')
    const forged: Record<string, unknown> = {}
    for (const k of [...WRITER_STAMP_KEYS, '_cap_refused', '_by_src', '_supersedes_src', '_checkpoint_number']) forged[k] = `forged:${k}`
    Object.assign(forged, {
      kind: 'checkpoint', run: 'r1', key: 'k', session_id: 'sender-session', _checkpoint_number: 7, _writer: 'reviewer', _writer_agent_id: 'agent-x',
      _writer_src: 'hook', _door: 'hooks', _identity: 'hook', _worktree: 'wt', _branch: 'main', _writer_stamped: true, _cwd: '/sender/dir',
    })
    await s.importJson(JSON.stringify({ nodes: [{ nodeId: 'forged-cp', content: 'state: a forged one', createdAt: 100, metadata: forged }] }), handoff('forged.json'))
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    const m = metaIn('a', 'forged-cp')
    for (const k of [...WRITER_STAMP_KEYS, '_cap_refused', '_by_src', '_supersedes_src', '_checkpoint_number']) {
      if (k === '_door' || k === '_identity') continue
      expect(m[k], `${k} at the top level`).toBeUndefined()
      expect((m[HANDOFF_CLAIMS_KEY] as Record<string, unknown>)[k], `${k} under the claims`).toBeDefined()
    }
    expect([m['_door'], m['_identity']]).toEqual(['import', 'imported'])
    expect((m[HANDOFF_CLAIMS_KEY] as Record<string, unknown>)['_door']).toBe('hooks')
    expect(m['session_id']).toBe('handoff:sender-session')
    // The readers take the claims: the writer agent and number are the file's, said as such.
    expect(l.checkpoints[0]!.writerAgentId).toBe('agent-x')
    expect([l.checkpoints[0]!.number, l.checkpoints[0]!.claimedNumber, l.checkpoints[0]!.writer]).toEqual([null, 7, 'imported from forged.json'])
  })
})

describe('an imported brief and an imported close (D327, D360)', () => {
  it('a brief that arrived by import is in effect for no role, and a close that arrived ends no brief here; both read back as imported', async () => {
    const remote = await open('remote')
    await remote.openRun({ run: 'r1', by: 'harness', at: 1_000 })
    await remote.writeBrief('review the form', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness', at: 1_001 })
    await remote.closeRun({ run: 'r1', by: 'harness', reason: 'done there', at: 1_100 })
    const file = join(tmpDir, 'r1.json')
    exportRun(remote, { run: 'r1', project: 'p', path: 'r1.json', abs: file })
    await remote.close()

    const s = await open('local')
    // A brief of this store's own for the same role and key, on a run open here.
    const mine = await s.writeBrief('build the form here', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness', at: 2_000 })
    await s.importJson(readFileSync(file, 'utf8'), handoff('r1.json'))
    expect(s.briefsInEffect('builder').map((b) => b.nodeId)).toEqual([mine.nodeId])
    // The close that arrived ended nothing here: the brief is still in effect.
    expect(raw<{ n: number }>('local', "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'run-close'")[0]!.n).toBe(1)
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    expect([l.facts.importedBriefs, l.facts.importedCloses, l.facts.importedOpens]).toEqual([1, 1, 1])
    expect(l.notes.join(' ')).toMatch(/1 brief\(s\) of this key and 1 close\(s\) of this run arrived by import/)
    // The run started here, not where the file says it began.
    expect(l.facts.runStartedAt).not.toBe(1_000)
    const rows = raw<{ kind: string; writer: string }>('local', RUN_ROWS_SQL, 'r1', 'r1')
    expect(rows.filter((r) => r.writer === 'imported from r1.json').map((r) => r.kind).sort()).toEqual(['brief', 'run-close', 'run-open'])
    // This store's own close, by contrast, ends its briefs.
    await s.closeRun({ run: 'r1', by: 'harness', reason: 'done here', at: 3_000 })
    expect(s.briefsInEffect('builder')).toEqual([])
    await s.close()
  })

  it('an imported brief names no checkpointer here, so no writer is flagged against it', async () => {
    const s = await open('local')
    await s.importJson(JSON.stringify({ nodes: [
      { nodeId: 'imp-brief', content: 'the brief', createdAt: 10, metadata: { kind: 'brief', run: 'r1', key: 'k', brief_for: 'builder', checkpointer: 'someone-else', session_id: 'sx' } },
    ] }), handoff('b.json'))
    await s.writeCheckpoint('state: mine', { run: 'r1', key: 'k', declared: { role: 'builder' } })
    const l = s.lookupKey({ run: 'r1', key: 'k' })
    await s.close()
    expect(l.namedCheckpointer).toEqual({ names: [], by: null })
    expect(l.checkpoints[0]!.flag).toBeNull()
  })

  it('through the real SubagentStart hook, the next local builder subagent is a plain subagent: no leg, no context', async () => {
    const cleanups: Array<() => unknown> = []
    const w = { defer: (f: () => unknown) => { cleanups.push(f) } } as unknown as RunWorld
    try {
      await openRunWorld(w)
      await w.store!.importJson(JSON.stringify({ nodes: [
        { nodeId: 'imp-brief', content: 'build the form of r1', createdAt: 10, metadata: { kind: 'brief', run: 'r1', key: 'login-form', brief_for: 'builder', checkpointer: 'builder', session_id: 'sx' } },
      ] }), handoff('b.json'))
      expect(w.store!.briefsInEffect('builder')).toEqual([])
      const ref = hooksSubagent(w, 'builder', 'builder')
      expect(startContext(w.facts![`start:builder`] as string)).toBeNull()
      const reg = rawRegistration(w, ref)
      expect([reg['run'], reg['run_key'], reg['kind'], reg['door']]).toEqual([null, null, null, null])
    } finally {
      for (const f of cleanups.reverse()) await f()
    }
  })
})

describe('an imported checkpoint\'s number is the file\'s claim (D329, D343, D360)', () => {
  it('an imported number 2 beside a local number 2 is one local number 2 and one imported claim; the next local write is 3 and supersedes the local 2 it started from', async () => {
    const remote = await open('remote')
    const theirs = await legWithCheckpoint(remote, 'r1', 'k', 'builder', 100)
    await legWithCheckpoint(remote, 'r1', 'k', 'builder', 200, [theirs.cp])
    const file = join(tmpDir, 'r.json')
    exportRun(remote, { run: 'r1', project: 'p', path: 'r.json', abs: file })
    expect(metaIn('remote', theirs.cp)['_checkpoint_number']).toBe(1)
    await remote.close()

    const s = await open('local')
    const l1 = await legWithCheckpoint(s, 'r1', 'k', 'builder', 1_000)
    const l2 = await legWithCheckpoint(s, 'r1', 'k', 'builder', 2_000)
    // Local numbers 1 and 2; the file's are 1 and 2 as well.
    await s.importJson(readFileSync(file, 'utf8'), handoff('r.json'))
    const rows = raw<{ node_id: string; n: number | null; c: number | null }>('local',
      `SELECT node_id, json_extract(metadata_json, '$._checkpoint_number') AS n,
              json_extract(metadata_json, '$._handoff_claims._checkpoint_number') AS c
         FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint' ORDER BY created_at`)
    expect(rows.filter((r) => r.n !== null).map((r) => r.n)).toEqual([1, 2])
    expect(rows.filter((r) => r.c !== null).map((r) => r.c)).toEqual([1, 2])
    expect(rows.filter((r) => r.n === 2)).toHaveLength(1)
    // The lookup: the imported 2 supersedes the imported 1 (believed); the local chain ends at the local 2. Two in effect, neither numbered like the other.
    const before = s.lookupKey({ run: 'r1', key: 'k' })
    expect(before.checkpoints.map((c) => [c.number, c.claimedNumber, c.imported])).toEqual([[2, null, false], [null, 2, true]])
    expect(before.line).toBe('2 checkpoints are in effect under "k" on the run "r1" (number 2 and number 2 as numbered there); none supersedes the other, and the store picks none of them.')
    // The next local write takes the next local number, past the local 2 only.
    const next = await legWithCheckpoint(s, 'r1', 'k', 'reviewer', 3_000)
    expect(metaIn('local', next.cp)['_checkpoint_number']).toBe(3)
    // It started from both in effect, so it supersedes both (D331); the claim of the imported one is unchanged.
    expect(new Set(metaIn('local', next.cp)['supersedes'] as string[])).toEqual(new Set([l2.cp, before.checkpoints[1]!.nodeId]))
    expect(l1.cp).not.toBe(l2.cp)
    const after = s.lookupKey({ run: 'r1', key: 'k' })
    expect(after.checkpoints.map((c) => c.number)).toEqual([3])
    await s.close()
  })

  it('a leg that did not start from the imported checkpoint supersedes only the local one', async () => {
    const remote = await open('remote')
    await legWithCheckpoint(remote, 'r1', 'k', 'builder', 100)
    const file = join(tmpDir, 'r.json')
    exportRun(remote, { run: 'r1', project: 'p', path: 'r.json', abs: file })
    await remote.close()
    const s = await open('local')
    const l1 = await legWithCheckpoint(s, 'r1', 'k', 'builder', 1_000)
    // The leg registers BEFORE the file arrives, so its start is the local 1 alone.
    const leg = await s.registerWorker({
      door: 'library', ticket: { parent: { id: 'p1' }, run: 'r1', key: 'k', role: 'reviewer', checkpointer: 'reviewer', mintedAt: 1_999 }, process: here, at: 2_000,
      startCheckpoints: [l1.cp],
    })
    await s.importJson(readFileSync(file, 'utf8'), handoff('r.json'))
    const cp = await s.writeCheckpoint('state: reviewed', { run: 'r1', key: 'k', leg: { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID } })
    expect(cp.checkpoint!.number).toBe(2)
    expect(metaIn('local', cp.nodeId)['supersedes']).toEqual([l1.cp])
    await s.close()
  })
})

describe('an export is one namespace\'s (D196)', () => {
  it('a registration counts only when its lane has rows in the namespace; a run with no row there writes nothing', async () => {
    const a = await open('shared', 'ns-a')
    const b = await open('shared', 'ns-b')
    await legWithCheckpoint(a, 'r1', 'k', 'builder', 100)
    await legWithCheckpoint(b, 'r1', 'k', 'reviewer', 200)
    await legWithCheckpoint(b, 'r2', 'k', 'builder', 300)
    const forA = a.runRows('r1', 'skeleton')
    const forB = b.runRows('r1', 'skeleton')
    const regs = (rows: { nodes: Array<{ metadata: Record<string, unknown> | null }> }): string[] =>
      rows.nodes.filter((n) => n.metadata?.['kind'] === 'leg-registration').map((n) => String((n.metadata!['_leg_registration'] as Record<string, unknown>)['role']))
    expect(regs(forA)).toEqual(['builder'])
    expect(regs(forB)).toEqual(['reviewer'])
    expect(a.runRows('r1', 'whole', 0).total).toBe(forA.total)
    expect(forA.nodes.every((n) => !JSON.stringify(n).includes('reviewer'))).toBe(true)
    // r2 has rows only in ns-b: ns-a's export writes nothing and says so.
    const none = exportRun(a, { run: 'r2', project: 'p', path: 'r2.json', abs: join(tmpDir, 'r2.json') })
    expect(none.status).toBe('empty')
    expect(a.runRows('r2', 'whole', 0).total).toBe(0)
    expect(exportRun(b, { run: 'r2', project: 'p', path: 'r2.json', abs: join(tmpDir, 'r2.json') }).status).toBe('built')
    await a.close()
    await b.close()
  })
})

describe('a registration the file carries, against the one this store holds (D165, D360)', () => {
  async function exported(): Promise<{ file: string; ref: { sessionId: string; agentId: string } }> {
    const s = await open('origin')
    const { ref } = await legWithCheckpoint(s, 'r1', 'k', 'builder', 100)
    const file = join(tmpDir, 'o.json')
    exportRun(s, { run: 'r1', project: 'p', path: 'o.json', abs: file })
    await s.close()
    return { file, ref }
  }

  it('agrees: already present; differs: lands as an imported registration row saying which facts differ', async () => {
    const { file } = await exported()
    // The origin store re-imports its own file: the registration is present.
    const origin = await open('origin')
    const agree = await origin.importJson(readFileSync(file, 'utf8'), handoff('o.json'))
    expect(agree.importedCount).toBe(0)
    expect(raw<{ n: number }>('origin', "SELECT COUNT(*) AS n FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'leg-registration'")[0]!.n).toBe(0)
    // The file is edited: the same leg, another role and parent.
    const edited = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Array<{ nodeId: string; metadata: { _leg_registration?: Record<string, unknown>; kind?: string } }> }
    const reg = edited.nodes.find((n) => n.metadata.kind === 'leg-registration')!
    reg.metadata._leg_registration!['role'] = 'reviewer'
    reg.metadata._leg_registration!['parent_session'] = 'someone-else'
    reg.nodeId = 'edited-reg'
    const differ = await origin.importJson(JSON.stringify({ nodes: [reg] }), handoff('edited.json'))
    expect(differ.importedCount).toBe(1)
    expect(metaIn('origin', 'edited-reg')[REGISTRATION_DIFFERS_KEY]).toEqual(['role', 'parent_session'])
    // The leg is still counted once, as the registration it is here; the lookup says what differs.
    const l = origin.lookupKey({ run: 'r1', key: 'k' })
    expect(l.facts.legsRun).toBe(1)
    expect(l.notes.join(' ')).toMatch(/differs from what this store holds in: role, parent_session/)
    await origin.close()
  })

  it('a claim that names another session than its lane\'s takes the lane\'s session and is flagged', async () => {
    const { file, ref } = await exported()
    const edited = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Array<{ nodeId: string; metadata: { session_id?: string; _leg_registration?: Record<string, unknown>; kind?: string } }> }
    const reg = edited.nodes.find((n) => n.metadata.kind === 'leg-registration')!
    reg.metadata.session_id = 'forged-lane'
    reg.nodeId = 'lane-reg'
    const s = await open('other')
    await s.importJson(JSON.stringify({ nodes: [reg] }), handoff('lane.json'))
    await s.close()
    const db = new DatabaseSync(dbOf('other'), { readOnly: true })
    const legs = importedLegsOf(db, null, 'r1')
    db.close()
    expect(legs).toHaveLength(1)
    expect(legs[0]!.leg.sessionId).toBe('forged-lane')
    expect(legs[0]!.claimedSession).toBe(ref.sessionId)
    expect(metaIn('other', 'lane-reg')[REGISTRATION_DIFFERS_KEY]).toEqual(['session_id'])
  })

  it('the registration row the store composes bears the store\'s name, the leg\'s writer inside', async () => {
    const s = await open('origin')
    await legWithCheckpoint(s, 'r1', 'k', 'builder', 100)
    const reg = s.runRows('r1', 'skeleton').nodes.find((n) => n.metadata?.['kind'] === 'leg-registration')!
    await s.close()
    const db = new DatabaseSync(dbOf('origin'), { readOnly: true })
    expect(legsOfRun(db, 'r1')).toHaveLength(1)
    db.close()
    expect([reg.metadata!['_writer'], reg.metadata!['_writer_src']]).toEqual(['treecontext', 'store'])
    expect((reg.metadata!['_leg_registration'] as Record<string, unknown>)['writer']).toBe('builder')
    expect(reg.nodeId).toBe(registrationRowId('r1', String(reg.metadata!['session_id']), WORKER_AGENT_ID))
  })
})

describe('a run\'s inner runs are named, not carried (D311, D360)', () => {
  it('the head lists the runs the legs opened, the tool reply and the shell print one line, and the skeleton holds none of their rows', async () => {
    const s = await open('a')
    const { ref } = await legWithCheckpoint(s, 'r1', 'k', 'reviewer', 100)
    await s.openRun({ run: 'r1.review', by: 'harness', leg: ref, parentRun: 'r1', parentLeg: ref, at: 150 })
    await legWithCheckpoint(s, 'r1.review', 'k', 'worker', 200)
    const built = buildHandoff(s, { form: 'skeleton', run: 'r1', project: 'p', path: 'x.json' })
    const head = JSON.parse(built.text) as { inner_runs?: string[]; nodes: Array<{ metadata: Record<string, unknown> }> }
    expect(head.inner_runs).toEqual(['r1.review'])
    expect(head.nodes.some((n) => n.metadata['run'] === 'r1.review')).toBe(false)
    expect(built.innerRunsLine).toBe('This run opened the run r1.review, which this file does not carry: export it by name.')
    // A run that opened none says nothing.
    expect(buildHandoff(s, { form: 'skeleton', run: 'r1.review', project: 'p', path: 'y.json' }).innerRunsLine).toBeNull()
    expect((JSON.parse(buildHandoff(s, { form: 'skeleton', run: 'r1.review', project: 'p', path: 'y.json' }).text) as Record<string, unknown>)['inner_runs']).toBeUndefined()
    // The tool and the shell.
    const proj = join(tmpDir, 'proj')
    mkdirSync(proj, { recursive: true })
    const server = createServer(s, { projectDir: proj, ccSessionId: 'cc-t' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 't', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    const res = await c.callTool({ name: 'treecontext_export', arguments: { run: 'r1', path: 'handoffs/r1.json' } }) as { content: Array<{ text: string }> }
    expect((JSON.parse(res.content[0]!.text) as Record<string, unknown>)['inner_runs']).toBe('This run opened the run r1.review, which this file does not carry: export it by name.')
    await c.close()
    await server.close()
    await s.close()
    const home = join(tmpDir, 'home')
    mkdirSync(home, { recursive: true })
    const cli = spawnCli(['export', 'handoffs/cli.json', '--run', 'r1', '--store', dbOf('a'), '--project-dir', proj, '--no-debug'], { home, cwd: proj })
    expect(cli.status, cli.out).toBe(0)
    expect(cli.stdout.split('\n')).toContain('This run opened the run r1.review, which this file does not carry: export it by name.')
  })
})

describe('hygiene (unit 6\'s gate)', () => {
  it('holds says "its open and close" only when the close exists', async () => {
    const s = await open('a')
    await legWithCheckpoint(s, 'r1', 'k', 'builder', 100)
    const open1 = JSON.parse(buildHandoff(s, { form: 'skeleton', run: 'r1', project: 'p', path: 'a.json' }).text) as { holds: string }
    await s.closeRun({ run: 'r1', by: 'harness', reason: 'done', at: 9_000 })
    const closed = JSON.parse(buildHandoff(s, { form: 'skeleton', run: 'r1', project: 'p', path: 'a.json' }).text) as { holds: string }
    await s.close()
    expect(open1.holds).toContain('its open, every brief')
    expect(open1.holds).not.toContain('open and close')
    expect(closed.holds).toContain('its open and close, every brief')
    expect(RUN_SECRETS_WARNING).toContain('run export')
  })

  it('RUN_ROWS_SQL gives an imported captured row its key and leg columns from the claims', async () => {
    const remote = await open('remote')
    const leg = await remote.registerWorker({
      door: 'library', ticket: { parent: { id: 'bp' }, run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', mintedAt: 99 }, process: here, at: 100,
    })
    const ref = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
    await remote.insert('$ ls\nremote output', { leg: ref, createdAt: 110, metadata: { source: 'auto-capture', role: 'tool', tool_name: 'Bash' } })
    const file = join(tmpDir, 'w.json')
    exportRun(remote, { run: 'r1', form: 'whole', project: 'p', path: 'w.json', abs: file, acknowledged: true })
    await remote.close()
    const s = await open('local')
    await s.importJson(readFileSync(file, 'utf8'), handoff('w.json'))
    await s.close()
    const rows = raw<{ kind: string | null; writer: string; key: string | null; leg_session: string; leg_agent: string; leg_role: string; leg_parent: string }>('local', RUN_ROWS_SQL, 'r1', 'r1')
    const captured = rows.find((r) => r.kind === null)!
    expect([captured.writer, captured.key, captured.leg_session, captured.leg_agent, captured.leg_role, captured.leg_parent])
      .toEqual(['imported from w.json', 'k', ref.sessionId, WORKER_AGENT_ID, 'builder', 'bp'])
  })
})
