/**
 * The ticket door below the charter (unit 3 of the beta.3 build; D288,
 * D291, D292, D298, D303, D307, D313, D315, D316, D329, D332, D335, D340,
 * D341, D342): the ticket reader on whole, damaged, blank-keyed, keyless
 * and silent tickets; the first message composed with none, one and two
 * checkpoints in effect, the flag and treecontext's own line; the
 * send-back decision table; the first-moment row's boundaries; and the
 * door's processes end to end against a real store file, a real stand-in
 * worker and, for D307, a real lock held by another process. Every store
 * claim is read back through a separate handle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { readTicket, mintTicket, declaresDoor, ticketClaimOf, TICKET_ENV, WORKER_SESSION_ENV } from '../src/ticket.js'
import {
  composeFirstMessage, STATE_NOT_HISTORY_LINE, PROMPT_HEADING, doorRowBoundaries, FIRST_MOMENT_PREVIEW_LEN, NO_CHECKPOINTER_LINE, sendBackReason,
} from '../src/first-moment.js'
import {
  sendBackDecision, spawnWorker, claimTicket, NOT_STARTED_EXIT, TICKET_REFUSED_EXIT, TIMEOUT_GRACE_MS, STDOUT_DRAIN_MS, type SendBackInput,
  reapedGroupIsOurs, StreamTail, summaryOf, GROUP_GRACE_MS,
} from '../src/ticket-door.js'
import { workerEnvironment, CLIENT_SESSION_VARIABLE_NAMES } from '../src/client-session-env.js'
import { decodeContent } from '../src/persistence/content-codec.js'
import { hostProbe, type ProcessProbe } from '../src/persistence/process-probe.js'
import { registerSelf } from '../src/persistence/session-registry.js'
import { NO_SESSION } from '../src/dedup-identity.js'
import { checkpointerFlag } from '../src/key-lookup.js'
import { INDEX_CAP_TOOL_DEFAULT } from '../src/persistence/capture-constants.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import { nodeTsArgs, CLI_TS, sandboxedSpawnEnv } from './helpers/cli-spawn.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client } from '@modelcontextprotocol/client'
import { parseRunArgs, RunUsageError, RUN_USAGE, runCommand, wantsRunHelp } from '../src/server/run-command.js'
import { TS_ROOT } from './journal/proc.js'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'tc-door-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

const path = (): string => join(tmpDir, 'door.db')
const open = (): Promise<FlatStore> => FlatStore.open({ database: openNodeSqlite(new DatabaseSync(path())), retentionInterval: 1_000_000 })
function raw<T>(sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path(), { readOnly: true })
  try { return db.prepare(sql).all(...(params as never[])) as T[] } finally { db.close() }
}

const STANDIN = join(TS_ROOT, 'tests', 'helpers', 'standin-worker.ts')
const standin = (plan: unknown, log = join(tmpDir, 'standin.jsonl')): { command: string; args: string[]; env: NodeJS.ProcessEnv } => ({
  command: process.execPath, args: nodeTsArgs(STANDIN),
  env: { ...process.env, STANDIN_DB: path(), STANDIN_LOG: log, STANDIN_PLAN: JSON.stringify(plan) },
})

// ── The ticket reader ──────────────────────────────────────────────

describe('readTicket', () => {
  const whole = mintTicket({ run: 'r1', key: 'login-form', role: 'builder', checkpointer: 'reviewer', checkpointedBy: 'builder', parent: { id: 'p1', cli: 'codex', branch: 'main' }, mintedAt: 1000 })

  it('reads a minted ticket whole, every field, nothing absent and no raw text kept', () => {
    const r = readTicket(whole)
    expect(r.valid).toBe(true)
    expect(r.absent).toEqual([])
    expect(r.ticket).toEqual({
      parent: { id: 'p1', cli: 'codex', branch: 'main' }, run: 'r1', key: 'login-form', role: 'builder',
      checkpointer: 'reviewer', checkpointedBy: 'builder', mintedAt: 1000, canWrite: null,
    })
    expect(r.ticket.raw).toBeUndefined()
  })

  it('reads a ticket truncated after the role for what it still yields, every field after the cut absent, the raw text kept', () => {
    const cut = whole.slice(0, whole.indexOf('"role":"builder"') + '"role":"builder"'.length)
    const r = readTicket(cut)
    expect(r.valid).toBe(false)
    expect([r.ticket.run, r.ticket.key, r.ticket.role]).toEqual(['r1', 'login-form', 'builder'])
    expect(r.absent).toEqual(['checkpointer', 'checkpointed_by', 'can_write', 'parent', 'minted_at'])
    expect(r.ticket.raw).toBe(cut)
    expect(r.ticket.absent).toEqual(r.absent)
  })

  it('reads a hand-edited ticket missing its run as damaged, the run absent', () => {
    const o = JSON.parse(whole) as Record<string, unknown>
    delete o['run']
    const r = readTicket(JSON.stringify(o))
    expect([r.valid, r.absent, r.ticket.role]).toEqual([false, ['run'], 'builder'])
  })

  it('reads a ticket of another shape as damaged, still reading the role it names', () => {
    const r = readTicket(JSON.stringify({ v: 0, role: 'reviewer', task: 'login-form', session: 'p1' }))
    expect(r.valid).toBe(false)
    expect(r.ticket.role).toBe('reviewer')
    expect(r.absent).toEqual(['v', 'run', 'key', 'parent'])
  })

  it('reads a blank key as damage (D341), the key absent', () => {
    const r = readTicket(mintTicket({ run: 'r1', key: '  ', role: 'builder', parent: { id: 'p1' } }))
    expect([r.valid, r.absent, r.noKey, r.ticket.key]).toEqual([false, ['key'], false, null])
  })

  it('reads a ticket that says in words the worker has no key as a one-off (D341)', () => {
    const r = readTicket(mintTicket({ run: 'r1', noKey: true, role: 'explorer', parent: { id: 'p1' } }))
    expect([r.valid, r.noKey, r.ticket.key, r.ticket.noKey]).toEqual([true, true, null, true])
  })

  it('reads a key given beside the words that there is none as not read whole', () => {
    const r = readTicket(JSON.stringify({ v: 1, run: 'r1', key: 'k', no_key: true, role: 'b', parent: { id: 'p1' } }))
    expect([r.valid, r.absent]).toEqual([false, ['key']])
  })

  it('reads silence about the door as declaring one (D340), and false as door-less (D316)', () => {
    const silent = readTicket(whole)
    expect([silent.ticket.canWrite, declaresDoor(silent.ticket)]).toEqual([null, true])
    const doorless = readTicket(mintTicket({ run: 'r1', key: 'k', role: 'b', parent: { id: 'p1' }, canWrite: false }))
    expect([doorless.valid, declaresDoor(doorless.ticket)]).toEqual([true, false])
    const odd = readTicket(JSON.stringify({ ...JSON.parse(whole) as object, can_write: 'yes' }))
    expect([odd.valid, odd.absent]).toEqual([false, ['can_write']])
  })
})

// ── The first message ──────────────────────────────────────────────

describe('composeFirstMessage', () => {
  it('composes the brief, the in-effect line, each checkpoint with number, writer and moment, the line, then the prompt; none, one and two', async () => {
    const s = await open()
    try {
      await s.writeBrief('BRIEF: build the login form', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
      const none = composeFirstMessage(s.firstMomentFacts({ run: 'r1', key: 'k', role: 'builder' }), 'PROMPT')
      expect(none).toContain('No checkpoint is in effect under "k" on the run "r1".')
      const order = (m: string, parts: string[]): void => {
        const at = parts.map((p) => m.indexOf(p))
        expect(at.every((i) => i >= 0), `all of ${parts.join(' | ')} in the message`).toBe(true)
        expect([...at].sort((a, b) => a - b)).toEqual(at)
      }
      order(none, ['BRIEF: build the login form', 'No checkpoint is in effect', STATE_NOT_HISTORY_LINE, `${PROMPT_HEADING}\nPROMPT`])
      const c1 = await s.writeCheckpoint('STATE ONE', { run: 'r1', key: 'k', declared: { role: 'builder' }, at: 1_700_000_000 })
      const one = composeFirstMessage(s.firstMomentFacts({ run: 'r1', key: 'k', role: 'builder' }), 'PROMPT')
      order(one, ['BRIEF', 'Checkpoint number 1 is in effect', `Checkpoint number 1 under "k" (row ${c1.nodeId}), written by "builder" at 2023-11-14T22:13:20.000Z`, 'STATE ONE', STATE_NOT_HISTORY_LINE, 'PROMPT'])
      // Two legs from checkpoint 1 write 2 and 3: both in effect (D329).
      await s.writeCheckpoint('STATE TWO', { run: 'r1', key: 'k', declared: { role: 'builder' }, supersedes: [c1.nodeId] })
      await s.writeCheckpoint('STATE THREE', { run: 'r1', key: 'k', declared: { role: 'intruder' }, supersedes: [c1.nodeId] })
      const facts = s.firstMomentFacts({ run: 'r1', key: 'k', role: 'builder' })
      const two = composeFirstMessage(facts, 'PROMPT')
      order(two, ['BRIEF', '2 checkpoints are in effect under "k" on the run "r1" (number 2 and number 3)', 'STATE TWO', 'STATE THREE', STATE_NOT_HISTORY_LINE, 'PROMPT'])
      // D315: the flag beside the stranger's checkpoint, the key lookup's own sentence.
      const intruder = facts.checkpoints.find((c) => c.writer === 'intruder')!
      expect(facts.flags).toEqual([{ nodeId: intruder.nodeId, sentence: checkpointerFlag(intruder, facts.named) }])
      expect(two.indexOf(checkpointerFlag(intruder, facts.named))).toBeGreaterThan(two.indexOf('STATE THREE'))
      expect(s.lookupKey({ run: 'r1', key: 'k' }).checkpoints.find((c) => c.nodeId === intruder.nodeId)!.flag).toBe(facts.flags[0]!.sentence)
    } finally { await s.close() }
  })

  it('says treecontext\'s own line whatever the brief says, and an empty prompt is still the prompt', async () => {
    const s = await open()
    try {
      const m = composeFirstMessage(s.firstMomentFacts({ run: 'r1', key: 'k', role: 'b' }), '')
      expect(m).toContain('state of the work as it now stands')
      expect(m).toContain('what it supersedes and what it rests on')
      expect(m).toContain('never pastes the history in')
      expect(m.endsWith(`${PROMPT_HEADING}\n`)).toBe(true)
      expect(m).toContain('No brief is in effect for the b role')
    } finally { await s.close() }
  })
})

// ── The send-back decision table ───────────────────────────────────

describe('sendBackDecision', () => {
  const base: SendBackInput = {
    exit: { code: 0, signal: null }, ticketValid: true, noKey: false, role: 'builder', checkpointer: 'builder',
    canWrite: null, sendBacks: 0, checkpointSinceStart: false, storeWritable: true,
  }
  const row = (o: Partial<SendBackInput>): [boolean, string] => {
    const v = sendBackDecision({ ...base, ...o })
    return [v.sendBack, v.ending]
  }
  it.each([
    ['an own exit, code 0, owing its checkpoint', {}, [true, 'retired']],
    ['an own exit on its own error, code 1 (D292)', { exit: { code: 1, signal: null } }, [true, 'retired']],
    ['an exit by signal is a cut (D292)', { exit: { code: null, signal: 'SIGTERM' } }, [false, 'cut']],
    ['another role named as checkpointer (D281)', { checkpointer: 'reviewer' }, [false, 'retired']],
    ['nobody named as checkpointer', { checkpointer: null }, [false, 'retired']],
    ['a door declared', { canWrite: true }, [true, 'retired']],
    ['no door declared (D316)', { canWrite: false }, [false, 'retired']],
    ['silence about the door (D340)', { canWrite: null }, [true, 'retired']],
    ['already sent back once, by either door (D279, D295)', { sendBacks: 1 }, [false, 'retired']],
    ['the store cannot be written (D279, D307)', { storeWritable: false }, [false, 'retired']],
    ['a checkpoint newer than its start', { checkpointSinceStart: true }, [false, 'retired']],
    ['a one-off with no key (D341)', { noKey: true }, [false, 'retired']],
    ['a ticket not read whole (D303)', { ticketValid: false }, [false, 'invalid']],
    ['a run the door signalled is a cut whatever its exit code (D292)', { exit: { code: 143, signal: null }, doorSignalled: true }, [false, 'cut']],
    ['a run the door never signalled, exiting 143 on its own, is finished (D292)', { exit: { code: 143, signal: null }, doorSignalled: false }, [true, 'retired']],
    ['a signal outranks everything', { exit: { code: null, signal: 'SIGKILL' }, ticketValid: false }, [false, 'cut']],
  ] as Array<[string, Partial<SendBackInput>, [boolean, string]]>)('%s', (_name, o, want) => {
    expect(row(o)).toEqual(want)
  })
})

// ── The first-moment row's boundaries ──────────────────────────────

describe('doorRowBoundaries', () => {
  it('stamps the index view at the tool cap and the display preview only past it, the text kept whole', () => {
    expect(doorRowBoundaries('short')).toEqual({ _index_len: 5 })
    const long = 'x'.repeat(300_000)
    expect(doorRowBoundaries(long)).toEqual({ _index_len: INDEX_CAP_TOOL_DEFAULT, _preview_len: FIRST_MOMENT_PREVIEW_LEN })
  })
})

// ── The door's processes, end to end ───────────────────────────────

describe('spawnWorker', () => {
  it('registers, writes the first moment first, sends back once for the missing checkpoint, and retires with the summary', async () => {
    const s = await open()
    try {
      await s.writeBrief('build the form', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
      const w = standin({ first: { notes: 2, print: 'not yet' }, rerun: { notes: 1, checkpoint: 'state: done', print: 'done' } })
      const r = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, prompt: 'go', ...w })
      expect([r.started, r.ended, r.sentBack, r.exitCode, r.runs.length]).toEqual([true, 'retired', true, 0, 2])
      const lane = raw<{ kind: string | null; c: string }>(
        "SELECT json_extract(metadata_json, '$.kind') AS kind, node_id AS c FROM nodes WHERE session_key = ? ORDER BY created_at, rowid", r.sessionId)
      // D335's lane: the first moment, the first run's rows, the second
      // run's first message, the second run's rows, then the return. What
      // the first run printed went to the spawner and is no row.
      expect(lane.map((x) => x.kind)).toEqual(['first-moment', null, null, 'send-back', null, 'checkpoint', 'subagent-summary'])
      expect(lane[0]!.c).toBe(r.firstMomentId)
      expect(r.runs[0]!.output).toBe('not yet')
      // The library path's own writes carry the parent and the directory.
      const note = raw<{ m: string }>("SELECT metadata_json AS m FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') IS NULL LIMIT 1", r.sessionId)[0]!
      const nm = JSON.parse(note.m) as Record<string, unknown>
      expect([nm['_writer'], nm['_parent'], nm['_parent_src'], nm['_door'], typeof nm['_cwd']]).toEqual(['builder', 'p1', 'declared', 'ticket', 'string'])
      const reg = raw<Record<string, unknown>>("SELECT * FROM session_registry WHERE session_id = ? AND agent_id = 'worker'", r.sessionId)[0]!
      expect([reg['ended'], reg['send_backs'], reg['door'], reg['kind']]).toEqual(['retired', 1, 'ticket', 'worker'])
      expect((JSON.parse(String(reg['processes'])) as Array<{ pid: number }>).map((p) => p.pid)).toEqual(r.runs.map((x) => x.pid))
      const log = readFileSync(join(tmpDir, 'standin.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { stdin: string; lane: string; ticket: string; rerun: boolean })
      expect(log.map((l) => [l.rerun, l.lane])).toEqual([[false, r.sessionId], [true, r.sessionId]])
      expect(log[0]!.stdin).toBe(r.firstMessage)
      expect(log[1]!.stdin).toBe(r.runs[1]!.input.stdin)
      // The re-run's message: the first moment composed again (the brief,
      // the state line, the prompt as written), the reason, the trail.
      const second = log[1]!.stdin
      const at = (t: string): number => second.indexOf(t)
      const order = ['build the form', STATE_NOT_HISTORY_LINE, `${PROMPT_HEADING}\ngo`, sendBackReason('builder', 'r1', 'k'), `the row ${r.firstMomentId}`]
      expect(order.map(at).every((i) => i >= 0)).toBe(true)
      expect(order.map(at).sort((a, b) => a - b)).toEqual(order.map(at))
      expect(readTicket(log[0]!.ticket).valid).toBe(true)
      expect(r.line).toContain(`its return is the summary row ${r.summaryId} (writer "builder", run "r1", key "k")`)
    } finally { await s.close() }
  }, 60_000)

  it('cuts a worker its spawner\'s timeout signals: no summary, no send-back', async () => {
    const s = await open()
    try {
      const w = standin({ first: { notes: 1, exit: 'hang' } })
      const r = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, timeoutMs: 3000, ...w })
      expect([r.ended, r.sentBack, r.runs.length, r.runs[0]!.exit.signal, r.exitCode]).toEqual(['cut', false, 1, 'SIGTERM', 143])
      expect(raw("SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary'", r.sessionId)).toHaveLength(0)
      expect(raw<{ ended: string }>("SELECT ended FROM session_registry WHERE session_id = ?", r.sessionId)[0]!.ended).toBe('cut')
    } finally { await s.close() }
  }, 60_000)

  it('starts no worker while the store is locked past the busy wait, and writes nothing (D307)', async () => {
    const s = await open()
    await s.close()
    const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', 'store-locker.cjs'), path()], { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await new Promise<void>((resolve, reject) => {
        locker.stdout!.on('data', (c: Buffer) => { if (c.toString().includes('locked')) resolve() })
        locker.on('exit', () => reject(new Error('locker exited')))
      })
      const w = standin({ first: { notes: 1 } })
      const t0 = Date.now()
      const r = await spawnWorker({ store: path(), ticket: { run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }, ...w })
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4500)
      expect([r.started, r.ended, r.exitCode, r.runs.length]).toEqual([false, 'not-started', NOT_STARTED_EXIT, 0])
      expect(r.line).toMatch(/could not be read after waiting 5 s .*no worker was started and nothing was written/)
    } finally {
      locker.kill('SIGKILL')
      await new Promise((resolve) => locker.once('exit', resolve))
    }
    expect(raw('SELECT 1 FROM session_registry')).toHaveLength(0)
    expect(raw('SELECT 1 FROM nodes')).toHaveLength(0)
  }, 60_000)
})

describe('claimTicket', () => {
  it('registers a process holding a ticket with no wrapper in its own lane, and returns the door\'s registration when a door started it', async () => {
    const s = await open()
    try {
      const ticket = mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'c7' } })
      const c = await claimTicket({ store: s, env: { [TICKET_ENV]: ticket } })
      expect(c.claimed).toBe(true)
      expect(c.leg).toEqual({ sessionId: c.registration!.sessionId, agentId: WORKER_AGENT_ID, door: 'ticket' })
      expect([c.registration!.pid, c.registration!.door, c.registration!.parentSrc]).toEqual([process.pid, 'ticket', 'declared'])
      const again = await claimTicket({ store: s, env: { [TICKET_ENV]: ticket, [WORKER_SESSION_ENV]: c.leg!.sessionId } })
      expect([again.claimed, again.leg?.sessionId]).toEqual([false, c.leg!.sessionId])
      expect(raw("SELECT 1 FROM session_registry WHERE kind = 'worker'")).toHaveLength(1)
      const none = await claimTicket({ store: s, env: {} })
      expect([none.claimed, none.leg]).toEqual([false, null])
    } finally { await s.close() }
  })
})

describe('a server inside a worker the door registered', () => {
  it('stamps the rows written through the tools into the worker\'s own lane, by its role (D288)', async () => {
    const s = await open()
    let session: string
    const ticket = mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } })
    try {
      const c = await claimTicket({ store: s, env: { [TICKET_ENV]: ticket } })
      session = c.leg!.sessionId
    } finally { await s.close() }
    const home = mkdtempSync(join(tmpdir(), 'tc-door-home-'))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', path()]),
      env: { ...sandboxedSpawnEnv(home), [WORKER_SESSION_ENV]: session, [TICKET_ENV]: ticket } as Record<string, string>,
      cwd: tmpDir, stderr: 'pipe',
    })
    const client = new Client({ name: 'worker-lane', version: '0' })
    try {
      await client.connect(transport)
      await client.callTool({ name: 'treecontext_insert', arguments: { content: 'state: the worker wrote this through its tools' } })
    } finally {
      await client.close()
      rmSync(home, { recursive: true, force: true })
    }
    const row = raw<{ session_key: string; m: string }>("SELECT session_key, metadata_json AS m FROM nodes WHERE CAST(content AS TEXT) = 'state: the worker wrote this through its tools'")
    expect(row).toHaveLength(1)
    const m = JSON.parse(row[0]!.m) as Record<string, unknown>
    expect([row[0]!.session_key, m['_writer'], m['_writer_src'], m['_writer_agent_id'], m['_door'], m['_identity']])
      .toEqual([session, 'builder', 'declared', WORKER_AGENT_ID, 'tools', 'declared'])
    // D288, D293: the parent as the ticket declared it and the directory.
    expect([m['_parent'], m['_parent_src'], typeof m['_cwd']]).toEqual(['p1', 'declared', 'string'])
  }, 60_000)
})

describe('parseRunArgs', () => {
  it('reads the ticket flags, the prompt and the command after --, and refuses what it cannot run', () => {
    const a = parseRunArgs(['--run', 'r1', '--key', 'k', '--role', 'builder', '--parent', 'p1', '--door', '--prompt', 'go', '--timeout', '30', '--', 'codex', 'exec', '--json'])
    expect([a.ticketFlags, a.prompt, a.timeoutSecs, a.command]).toEqual([{ run: 'r1', key: 'k', role: 'builder', parent: 'p1', door: true }, 'go', 30, ['codex', 'exec', '--json']])
    expect(() => parseRunArgs(['--run', 'r1'])).toThrow(RunUsageError)
    expect(() => parseRunArgs(['--run', 'r1', '--role', 'b', '--parent', 'p', '--', 'x'])).toThrow(/--key, or --no-key/)
    expect(() => parseRunArgs(['--run', 'r1', '--key', 'k', '--no-key', '--role', 'b', '--parent', 'p', '--', 'x'])).toThrow(/not both/)
    expect(() => parseRunArgs(['--ticket', '{}', '--run', 'r1', '--key', 'k', '--role', 'b', '--parent', 'p', '--', 'x'])).toThrow(/not both/)
    expect(parseRunArgs(['--', 'claude', '-p']).command).toEqual(['claude', '-p'])
  })

  it('--help or -h before -- prints the usage on stdout and exits 0; after -- it is the worker\'s', async () => {
    expect([wantsRunHelp(['--help']), wantsRunHelp(['--run', 'r1', '-h']), wantsRunHelp(['--', 'claude', '--help']), wantsRunHelp(['--run', 'r1'])])
      .toEqual([true, true, false, false])
    let out = ''
    let err = ''
    const sink = (f: (s: string) => void) => ({ write: (s: string) => { f(s); return true } }) as unknown as NodeJS.WritableStream
    const code = await runCommand(['--help'], {
      dbPathFor: () => { throw new Error('help opens no store') },
      stdout: sink((s) => { out += s }),
      stderr: sink((s) => { err += s }),
    })
    expect([code, out, err]).toEqual([0, `usage: ${RUN_USAGE}\n`, ''])
  })
})

// ── The review's findings, each lit (unit 3's failure-ladder review) ──

describe('the cut reaches the whole worker', () => {
  it('a timeout ends a worker whose subprocess holds its stdout: a cut within the timeout and the grace, exit 143, nothing of its group left (D292)', async () => {
    const s = await open()
    try {
      const t0 = Date.now()
      const r = await spawnWorker({
        store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } },
        command: 'sh', args: ['-c', 'cat >/dev/null; sleep 777; echo after'], timeoutMs: 2000,
      })
      const took = Date.now() - t0
      expect([r.ended, r.exitCode, r.sentBack, r.output]).toEqual(['cut', 143, false, ''])
      expect(took).toBeLessThan(2000 + TIMEOUT_GRACE_MS + STDOUT_DRAIN_MS)
      const pid = r.runs[0]!.pid!
      // The worker led its own process group; no member of it is left. A
      // member killed a moment ago may still be a zombie awaiting its reaper,
      // which macOS answers with EPERM, not ESRCH: wait for the reap (2 s).
      const gone = async (): Promise<string> => {
        for (let i = 0; i < 40; i++) {
          try { process.kill(-pid, 0) } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? ''
            if (code !== 'EPERM') return code
          }
          await new Promise((res) => setTimeout(res, 50))
        }
        return 'still there'
      }
      expect(await gone()).toBe('ESRCH')
      expect(raw<{ ended: string }>('SELECT ended FROM session_registry WHERE session_id = ?', r.sessionId)[0]!.ended).toBe('cut')
    } finally { await s.close() }
  }, 30_000)
})

describe('the group is signalled after its leader is reaped only while its number is ours', () => {
  // A failing run must leave no TERM-ignoring survivor behind: whatever
  // pid a test's script wrote, killed by pid after the test.
  const survivors = (): number[] => ['child.pid', 'clean-child.pid'].flatMap((f) => {
    try { return [Number(readFileSync(join(tmpDir, f), 'utf8').trim())] } catch { return [] }
  })
  afterEach(() => { for (const pid of survivors()) { if (pid > 0) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } } })

  // A worker whose child ignores SIGTERM: the timeout's SIGTERM ends the
  // leader, the child lives on in the group, and the door's SIGKILL after
  // the leader's reap is what ends it. The child writes its own pid first.
  const stubborn = (pidFile: string): { command: string; args: string[] } => ({
    command: 'sh',
    args: ['-c', `(trap "" TERM; exec sh -c 'echo $$ > "${pidFile}"; exec sleep 777') </dev/null >/dev/null 2>&1 & cat >/dev/null; wait`],
  })
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
  }
  const waitGone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)) }
    return false
  }

  it.skipIf(process.platform === 'win32')('with no process holding the number, the survivor is killed with the group (D292)', async () => {
    const s = await open()
    const pidFile = join(tmpDir, 'child.pid')
    try {
      const r = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, timeoutMs: 1500, ...stubborn(pidFile) })
      expect([r.ended, r.runs[0]!.exit.signal]).toEqual(['cut', 'SIGTERM'])
      const child = Number(readFileSync(pidFile, 'utf8').trim())
      expect(await waitGone(child)).toBe(true)
    } finally { await s.close() }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('with a process holding the number, a stranger that reused it, nothing is signalled by it', async () => {
    const s = await open()
    const pidFile = join(tmpDir, 'child.pid')
    let child = 0
    try {
      // The OS stand-in: every number reads as held, as the leader's number
      // reads once a stranger has reused it. The leader is reaped by then,
      // so the holder can only be a stranger.
      const probe = { ...hostProbe, exists: (): boolean => true }
      const r = await spawnWorker({
        store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, timeoutMs: 1500, probe, ...stubborn(pidFile),
      })
      expect([r.ended, r.runs[0]!.exit.signal]).toEqual(['cut', 'SIGTERM'])
      child = Number(readFileSync(pidFile, 'utf8').trim())
      // No SIGKILL went to the number: the survivor of the SIGTERM lives.
      await new Promise((res) => setTimeout(res, 300))
      expect(alive(child)).toBe(true)
    } finally {
      if (child > 0) { try { process.kill(child, 'SIGKILL') } catch { /* gone */ } }
      await s.close()
    }
  }, 30_000)

  // D393: a worker ended by a signal the door did not send (the harness,
  // the system) takes its group with it too: SIGTERM first, SIGKILL after
  // the grace for a member still there. The leader writes its own pid and
  // waits; the test kills it.
  const killedFromOutside = async (s: FlatStore, script: string, leaderFile: string, probe?: ProcessProbe): Promise<Awaited<ReturnType<typeof spawnWorker>>> => {
    const p = spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, command: 'sh', args: ['-c', script], ...(probe ? { probe } : {}) })
    for (let i = 0; i < 200 && !existsSync(leaderFile); i++) await new Promise((res) => setTimeout(res, 25))
    await new Promise((res) => setTimeout(res, 200))
    process.kill(Number(readFileSync(leaderFile, 'utf8').trim()), 'SIGKILL')
    return p
  }

  it.skipIf(process.platform === 'win32')('a worker killed by a signal the door did not send: its group gets SIGTERM, then its grace (D393)', async () => {
    const s = await open()
    const pidFile = join(tmpDir, 'child.pid')
    const leader = join(tmpDir, 'leader.pid')
    const mark = join(tmpDir, 'term')
    try {
      // The survivor notes the SIGTERM it is given and then exits.
      const script = `(trap 'echo term > "${mark}"; exit 0' TERM; sh -c 'echo $PPID' > "${pidFile}"; while :; do sleep 0.05; done) </dev/null >/dev/null 2>&1 & cat >/dev/null; echo $$ > "${leader}"; wait`
      const r = await killedFromOutside(s, script, leader)
      expect([r.ended, r.runs[0]!.exit.signal, r.runs[0]!.doorSignalled, r.sentBack]).toEqual(['cut', 'SIGKILL', false, false])
      expect(readFileSync(mark, 'utf8').trim(), 'the survivor was given SIGTERM before anything else').toBe('term')
      expect(await waitGone(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(true)
    } finally { await s.close() }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('a survivor that ignores the SIGTERM is killed once the grace is out (D393)', async () => {
    const s = await open()
    const pidFile = join(tmpDir, 'child.pid')
    const leader = join(tmpDir, 'leader.pid')
    try {
      const script = `(trap "" TERM; exec sh -c 'echo $$ > "${pidFile}"; exec sleep 777') </dev/null >/dev/null 2>&1 & cat >/dev/null; echo $$ > "${leader}"; wait`
      const t0 = Date.now()
      const r = await killedFromOutside(s, script, leader)
      const took = Date.now() - t0
      expect([r.ended, r.runs[0]!.exit.signal]).toEqual(['cut', 'SIGKILL'])
      const child = Number(readFileSync(pidFile, 'utf8').trim())
      expect(await waitGone(child)).toBe(true)
      // The run settled only after the grace, never before the group's end.
      expect(took).toBeGreaterThanOrEqual(GROUP_GRACE_MS)
    } finally { await s.close() }
  }, 30_000)

  // Every signal the door sends to a group (a negative pid), the null
  // signal (a liveness probe) aside.
  const watchGroupSignals = (): { sent: string[]; stop: () => void; seen: () => boolean } => {
    const real = process.kill
    const sent: string[] = []
    process.kill = ((pid: number, sig?: string | number): true => {
      if (pid < 0 && sig !== 0 && sig !== undefined) sent.push(String(sig))
      return real.call(process, pid, sig as never) as true
    }) as typeof process.kill
    return { sent, stop: () => { process.kill = real }, seen: () => sent.includes('SIGTERM') }
  }

  it.skipIf(process.platform === 'win32')('a number a stranger takes once the SIGTERM is sent gets no SIGKILL, though a member is still there (D393)', async () => {
    const s = await open()
    const pidFile = join(tmpDir, 'child.pid')
    const leader = join(tmpDir, 'leader.pid')
    const watch = watchGroupSignals()
    try {
      // The number reads as free until the SIGTERM goes out, then as held:
      // a stranger reused it during the grace.
      const probe: ProcessProbe = { ...hostProbe, exists: (pid: number): boolean | null => (watch.seen() ? true : hostProbe.exists(pid)) }
      const script = `(trap "" TERM; exec sh -c 'echo $$ > "${pidFile}"; exec sleep 777') </dev/null >/dev/null 2>&1 & cat >/dev/null; echo $$ > "${leader}"; wait`
      const r = await killedFromOutside(s, script, leader, probe)
      expect(r.runs[0]!.exit.signal).toBe('SIGKILL')
      expect(watch.sent, 'the group got its SIGTERM and nothing after it').toEqual(['SIGTERM'])
      expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(true)
    } finally { watch.stop(); await s.close() }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('a clean exit settles at once and sends its group no signal, whatever it left running (current behaviour)', async () => {
    const s = await open()
    const watch = watchGroupSignals()
    try {
      const pidFile = join(tmpDir, 'clean-child.pid')
      const script = `cat >/dev/null; (trap "" TERM; exec sleep 777) </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; exit 0`
      const t0 = Date.now()
      const r = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }, command: 'sh', args: ['-c', script] })
      const took = Date.now() - t0
      expect([r.runs[0]!.exit.code, r.runs[0]!.exit.signal, r.runs[0]!.doorSignalled]).toEqual([0, null, false])
      expect(watch.sent).toEqual([])
      // Far under the grace: a clean exit never waits for the group's end.
      expect(took).toBeLessThan(GROUP_GRACE_MS / 2)
    } finally { watch.stop(); await s.close() }
  }, 30_000)

  it('reads the number as ours only when the host says no process holds it', () => {
    const says = (v: boolean | null) => ({ ...hostProbe, exists: (): boolean | null => v })
    const groups = process.platform !== 'win32'
    expect([reapedGroupIsOurs(4242, says(false)), reapedGroupIsOurs(4242, says(true)), reapedGroupIsOurs(4242, says(null)), reapedGroupIsOurs(undefined, says(false))])
      .toEqual([groups, false, false, false])
  })
})

describe('the end of the error stream (D384)', () => {
  it('keeps the last characters as code points across split chunks, and counts them all', () => {
    const t = new StreamTail(5)
    const bytes = Buffer.from('abc😀défgh😀')
    // Every split point, a four-byte character among them, cut mid-way.
    for (const b of bytes) t.push(Buffer.from([b]))
    t.end()
    expect([t.text(), t.total]).toEqual(['éfgh😀', 10])
    const whole = new StreamTail(2000)
    whole.push(Buffer.from('error: x\n'))
    whole.end()
    expect([whole.text(), whole.total]).toEqual(['error: x\n', 9])
  })

  it('a clean exit with output is its output alone; a failed or silent one adds treecontext\'s line', () => {
    const rec = (output: string, code: number, tail: string, total = tail.length) => ({ output, exit: { code, signal: null }, errorTail: tail, errorChars: total })
    expect(summaryOf(rec('done\n', 0, 'warning: cold\n'))).toBe('done')
    expect(summaryOf(rec('', 0, ''))).toBe('treecontext: the worker exited with code 0 having printed nothing, and wrote nothing to its error stream.')
    expect(summaryOf(rec('half', 2, 'boom\n'))).toBe('half\n\ntreecontext: the worker exited with code 2; its error stream, all 5 characters of it:\nboom\n')
    expect(summaryOf(rec('', 1, 'x'.repeat(2000), 50000)))
      .toBe(`treecontext: the worker exited with code 1 having printed nothing; the last 2000 of the 50000 characters it wrote to its error stream, the earlier part was left out:\n${'x'.repeat(2000)}`)
  })
})

describe('a run the door signalled is a cut, whatever its exit code (D292)', () => {
  const trap = ['-c', 'trap "exit 143" TERM; cat >/dev/null; sleep 777 & wait']
  const ticket = { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }
  // A signal cannot be trapped on Windows: the worker ends by it, with no code.
  it.skipIf(process.platform === 'win32')('a worker that traps the door\'s SIGTERM and exits with a code is retired cut: no summary row, no send-back, a recovery leg next', async () => {
    const s = await open()
    try {
      const r = await spawnWorker({ store: s, ticket, command: 'sh', args: trap, timeoutMs: 1000 })
      expect([r.runs[0]!.exit.signal, r.runs[0]!.exit.code, r.runs[0]!.doorSignalled]).toEqual([null, 143, true])
      expect([r.ended, r.sentBack, r.runs.length, r.summaryId, r.exitCode]).toEqual(['cut', false, 1, null, 143])
      expect(r.line).toContain('exited with code 143 after the door signalled it: a cut')
      expect(raw("SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') IN ('subagent-summary', 'send-back')", r.sessionId)).toHaveLength(0)
      expect(raw<{ ended: string; send_backs: number }>('SELECT ended, send_backs FROM session_registry WHERE session_id = ?', r.sessionId)[0]).toEqual({ ended: 'cut', send_backs: 0 })
      // The next leg of the role starts as a recovery leg.
      const next = await spawnWorker({ store: s, ticket, command: 'true', args: [] })
      expect(next.firstMessage).toContain(r.sessionId)
    } finally { await s.close() }
  }, 60_000)

  it('the same worker exiting 143 on its own, never signalled, is finished and sent back once', async () => {
    const s = await open()
    try {
      const r = await spawnWorker({ store: s, ticket, command: 'sh', args: ['-c', 'cat >/dev/null; exit 143'] })
      expect([r.ended, r.sentBack, r.runs.length]).toEqual(['retired', true, 2])
      expect(r.runs.map((x) => x.doorSignalled)).toEqual([false, false])
    } finally { await s.close() }
  }, 60_000)
})

describe('the error stream is read through a pipe, and what that costs (D384)', () => {
  const ticket = { run: 'r1', key: 'k', role: 'builder', checkpointer: 'reviewer', parent: { id: 'p1' } }
  const stray = (): void => { for (const pid of strays) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } } }
  const strays: number[] = []
  afterEach(stray)

  it('(a) a run whose worker has exited waits out the drain while something holds its stderr', async () => {
    const s = await open()
    try {
      const t0 = Date.now()
      // The background process keeps the stderr pipe (its stdout goes away).
      const r = await spawnWorker({ store: s, ticket, command: 'sh', args: ['-c', 'cat >/dev/null; sleep 30 >/dev/null & exit 0'], stderr: 'ignore' })
      const took = Date.now() - t0
      strays.push(r.runs[0]!.pid!)
      expect(r.exitCode).toBe(0)
      expect(took).toBeGreaterThanOrEqual(STDOUT_DRAIN_MS - 100)
      expect(took).toBeLessThan(STDOUT_DRAIN_MS + 4000)
    } finally { await s.close() }
  }, 30_000)

  it('a worker that holds nothing on stderr is not made to wait', async () => {
    const s = await open()
    try {
      const t0 = Date.now()
      const r = await spawnWorker({ store: s, ticket, command: 'sh', args: ['-c', 'cat >/dev/null; exit 0'], stderr: 'ignore' })
      strays.push(r.runs[0]!.pid!)
      expect(Date.now() - t0).toBeLessThan(STDOUT_DRAIN_MS)
    } finally { await s.close() }
  }, 30_000)

  // D397, amending unit 5's cost (b): the door no longer closes its end at
  // the settle, so a shell's background writer is heard, never SIGPIPE'd
  // (it was ended with status 141 here before). The charter binds the same
  // with a node writer through the library spawner (journal-workers).
  for (const mode of ['handed on', 'ignored'] as const) {
    it.skipIf(process.platform === 'win32')(`(b) a background process that writes to stderr after the run settled is not sent SIGPIPE (D397), the stream ${mode}`, async () => {
      const s = await open()
      try {
        const mark = join(tmpDir, 'late-status')
        const script = `cat >/dev/null; ( ( sleep 3.5; echo late >&2 ) >/dev/null; echo "status $?" > '${mark}' ) & exit 0`
        const heard: Buffer[] = []
        const r = await spawnWorker({
          store: s, ticket, command: 'sh', args: ['-c', script],
          ...(mode === 'ignored' ? { stderr: 'ignore' as const } : { onStderr: (c: Buffer): void => { heard.push(c) } }),
        })
        strays.push(r.runs[0]!.pid!)
        expect(existsSync(mark), 'the run settled after the late write').toBe(false)
        for (let i = 0; i < 100 && !existsSync(mark); i++) await new Promise((res) => setTimeout(res, 100))
        expect(readFileSync(mark, 'utf8').trim()).toBe('status 0')
        if (mode === 'handed on') expect(Buffer.concat(heard).toString('utf8')).toBe('late\n')
      } finally { await s.close() }
    }, 30_000)
  }
})

describe('the cut marker counts characters (D384)', () => {
  const ticket = { run: 'r1', key: 'k', role: 'builder', checkpointer: 'reviewer', parent: { id: 'p1' } }
  const summaryText = (sessionId: string | null): string =>
    raw<{ c: Buffer | string }>("SELECT content AS c FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'subagent-summary'", sessionId)
      .map((r) => decodeContent(r.c)).join('')

  it('1500 two-byte characters, none cut, read "all 1500 characters"; 3000 of them read "the last 2000 of the 3000"', async () => {
    const s = await open()
    try {
      const small = await spawnWorker({ store: s, ticket, stderr: 'ignore', ...standin({ first: { stderr: 'é'.repeat(1500), exit: 1 } }) })
      expect(summaryText(small.sessionId)).toContain('its error stream, all 1500 characters of it:')
      const big = await spawnWorker({ store: s, ticket, stderr: 'ignore', ...standin({ first: { stderr: 'é'.repeat(3000), exit: 1 } }) })
      expect(summaryText(big.sessionId)).toContain('the last 2000 of the 3000 characters it wrote')
    } finally { await s.close() }
  }, 60_000)
})

describe('the send-back re-run\'s environment is scrubbed too (D389)', () => {
  it('a worker sent back once holds none of the six session variables on either run', async () => {
    const s = await open()
    try {
      const f1 = join(tmpDir, 'env-1.json')
      const f2 = join(tmpDir, 'env-2.json')
      const w = standin({ first: { envTo: f1 }, rerun: { envTo: f2 } })
      const session = Object.fromEntries(CLIENT_SESSION_VARIABLE_NAMES.map((n) => [n, `fake-${n}`]))
      const r = await spawnWorker({
        store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } },
        ...w, env: { ...w.env, ...session, CLAUDE_CONFIG_DIR: '/fake/config' },
      })
      expect([r.sentBack, r.runs.length]).toEqual([true, 2])
      for (const f of [f1, f2]) {
        const env = JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>
        expect(CLIENT_SESSION_VARIABLE_NAMES).toHaveLength(6)
        for (const n of CLIENT_SESSION_VARIABLE_NAMES) expect([f, n, env[n]]).toEqual([f, n, undefined])
        expect(env['CLAUDE_CONFIG_DIR']).toBe('/fake/config')
        expect(env[WORKER_SESSION_ENV]).toBe(r.sessionId)
      }
    } finally { await s.close() }
  }, 60_000)
})

describe('the worker\'s environment (D389)', () => {
  it('leaves out every named session variable, keeps the rest, sets the door\'s own, and changes nothing of the spawner\'s', () => {
    const spawner = {
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '9', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
      CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', PATH: '/bin', [TICKET_ENV]: 'old',
    }
    const before = { ...spawner }
    const env = workerEnvironment(spawner, { [TICKET_ENV]: 'new', [WORKER_SESSION_ENV]: 'lane' })
    expect(CLIENT_SESSION_VARIABLE_NAMES).toEqual(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET'])
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', PATH: '/bin', [TICKET_ENV]: 'new', [WORKER_SESSION_ENV]: 'lane' })
    expect(spawner).toEqual(before)
  })
})

describe('the lane variable is honoured only for its own ticket', () => {
  it('a nested process that inherited the lane with a ticket of its own is registered as its own worker, never as the builder (D293)', async () => {
    const s = await open()
    try {
      const builderTicket = mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } })
      const builder = await claimTicket({ store: s, env: { [TICKET_ENV]: builderTicket } })
      const lane = builder.leg!.sessionId
      // The same lane, its own ticket: the builder's lane is not its own.
      const own = mintTicket({ run: 'r2', key: 'k2', role: 'explorer', parent: { id: 'p9' } })
      const nested = await claimTicket({ store: s, env: { [TICKET_ENV]: own, [WORKER_SESSION_ENV]: lane } })
      expect(nested.claimed).toBe(true)
      expect(nested.leg!.sessionId).not.toBe(lane)
      expect([nested.registration!.role, nested.registration!.run]).toEqual(['explorer', 'r2'])
      // The builder's own ticket with its lane is honoured.
      const same = await claimTicket({ store: s, env: { [TICKET_ENV]: builderTicket, [WORKER_SESSION_ENV]: lane } })
      expect([same.claimed, same.leg!.sessionId]).toEqual([false, lane])
      expect(s.trustedWorkerLane({ [TICKET_ENV]: own, [WORKER_SESSION_ENV]: lane })).toBeNull()
      expect(s.trustedWorkerLane({ [WORKER_SESSION_ENV]: lane })).toBeNull()
    } finally { await s.close() }
  })

  it('serve given a ticket and a lane this store holds no registration for stamps the ticket\'s claim, never a registered worker\'s stamp (D424)', async () => {
    const s = await open()
    await s.close()
    const home = mkdtempSync(join(tmpdir(), 'tc-door-home-'))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: nodeTsArgs(CLI_TS, ['serve', '--lexical', '--store', path()]),
      env: { ...sandboxedSpawnEnv(home), [WORKER_SESSION_ENV]: 'worker-invented', [TICKET_ENV]: mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }) } as Record<string, string>,
      cwd: tmpDir, stderr: 'pipe',
    })
    const client = new Client({ name: 'worker-lane', version: '0' })
    try {
      await client.connect(transport)
      await client.callTool({ name: 'treecontext_insert', arguments: { content: 'state: a row from an invented lane' } })
    } finally {
      await client.close()
      rmSync(home, { recursive: true, force: true })
    }
    const row = raw<{ session_key: string | null; m: string | null }>("SELECT session_key, metadata_json AS m FROM nodes WHERE CAST(content AS TEXT) = 'state: a row from an invented lane'")
    expect(row).toHaveLength(1)
    const m = JSON.parse(row[0]!.m ?? '{}') as Record<string, unknown>
    // The door registered the worker in another store: the row is keyed to
    // the session the door named, under the ticket's role, as a claim.
    expect([row[0]!.session_key, m['_cc_session_id'], m['_writer'], m['_writer_src'], m['_parent'], m['_parent_src']])
      .toEqual(['worker-invented', 'worker-invented', 'builder', 'ticket-claim', 'p1', 'declared'])
    // Never the stamp the store writes from a worker's registration, and
    // no registration is written for it.
    expect(m['_writer_agent_id']).toBeUndefined()
    expect(raw('SELECT 1 FROM session_registry')).toHaveLength(0)
  }, 60_000)

  it('a ticket claims a lane only where the store holds no registration for it, and only with both variables (D424)', async () => {
    const s = await open()
    try {
      const t = mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } })
      const db = new DatabaseSync(path(), { readOnly: true })
      try {
        const h = openNodeSqlite(db)
        expect(ticketClaimOf(h, { [TICKET_ENV]: t, [WORKER_SESSION_ENV]: 'worker-elsewhere' })).toEqual({ session: 'worker-elsewhere', role: 'builder', parent: 'p1' })
        // The lane alone, or the ticket alone, claims nothing.
        expect(ticketClaimOf(h, { [WORKER_SESSION_ENV]: 'worker-elsewhere' })).toBeNull()
        expect(ticketClaimOf(h, { [TICKET_ENV]: t })).toBeNull()
        // A ticket that names no role claims as a worker.
        expect(ticketClaimOf(h, { [TICKET_ENV]: '{"v":1,"run":"r1"', [WORKER_SESSION_ENV]: 'worker-elsewhere' })?.role).toBe('worker')
      } finally { db.close() }
      // A lane this store registered, under another ticket: never claimed.
      const { leg } = s.startWorker({ reading: readTicket(t), prompt: 'go', host: 'laptop' })
      const other = mintTicket({ run: 'r2', key: 'k2', role: 'reviewer', parent: { id: 'p9' } })
      const db2 = new DatabaseSync(path(), { readOnly: true })
      try {
        expect(ticketClaimOf(openNodeSqlite(db2), { [TICKET_ENV]: other, [WORKER_SESSION_ENV]: leg.sessionId })).toBeNull()
      } finally { db2.close() }
      expect(s.trustedWorkerLane({ [TICKET_ENV]: other, [WORKER_SESSION_ENV]: leg.sessionId })).toBeNull()
    } finally { await s.close() }
  })
})

describe('the checkpointer is recorded at registration (D281)', () => {
  const start = (s: FlatStore, t: string) => s.startWorker({ reading: readTicket(t), prompt: 'go', host: 'laptop' })
  it('the ticket\'s, else the in-effect brief\'s in each tense, else nobody, and the first message says which', async () => {
    const s = await open()
    try {
      await s.writeBrief('BRIEF', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'reviewer', checkpointedBy: 'writer', by: 'harness' })
      const fromTicket = start(s, mintTicket({ run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }))
      expect([fromTicket.leg.checkpointer, fromTicket.leg.checkpointedBy]).toEqual(['builder', 'writer'])
      const fromBrief = start(s, mintTicket({ run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }))
      expect([fromBrief.leg.checkpointer, fromBrief.leg.checkpointedBy]).toEqual(['reviewer', 'writer'])
      expect(fromBrief.firstMessage).toContain('"reviewer" as the one who will checkpoint "k" at the end')
      const nobody = start(s, mintTicket({ run: 'r1', key: 'other', role: 'builder', parent: { id: 'p1' } }))
      expect([nobody.leg.checkpointer, nobody.leg.checkpointedBy]).toEqual([null, null])
      expect(nobody.firstMessage).toContain(`${NO_CHECKPOINTER_LINE} "other".`)
      expect(nobody.firstMessage).not.toContain('as the one who will checkpoint')
    } finally { await s.close() }
  })

  it('a ticket silent where the brief names the worker itself earns the send-back; silent everywhere earns none', async () => {
    const s = await open()
    try {
      await s.writeBrief('BRIEF', { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', by: 'harness' })
      const named = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', parent: { id: 'p1' } }, ...standin({ first: {}, rerun: { checkpoint: 'state: done' } }) })
      expect([named.sentBack, named.runs.length]).toEqual([true, 2])
      const silent = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'none-named', role: 'builder', parent: { id: 'p1' } }, ...standin({ first: {} }, join(tmpDir, 'b.jsonl')) })
      expect([silent.sentBack, silent.runs.length, silent.ended]).toEqual([false, 1, 'retired'])
    } finally { await s.close() }
  }, 60_000)
})

describe("a damaged ticket's worker writing through the insert tool (D303, D342)", () => {
  // The worker's own server, as `serve` opens it in a trusted worker lane:
  // the insert tool's door, the worker's session its lane.
  const insertAsWorker = async (s: FlatStore, lane: string, content: string, metadata: Record<string, unknown>): Promise<void> => {
    const { createServer } = await import('../src/server/server.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/client')
    const server = createServer(s, { ccSessionId: lane })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'worker', version: '0' })
    await server.connect(st)
    await c.connect(ct)
    try { await c.callTool({ name: 'treecontext_insert', arguments: { content, metadata } }) } finally { await c.close(); await server.close() }
  }
  it.each([
    ['an ordinary note', { kind: 'note' }],
    ['labelled as a door row (kind first-moment)', { kind: 'first-moment' }],
    ['labelled as a door row (kind send-back)', { kind: 'send-back' }],
    ['labelled as a handed prompt (an auto-capture user turn)', { source: 'auto-capture', role: 'user' }],
  ])('its one row, %s, is still its own write: the leg ends invalid', async (_what, metadata) => {
    const s = await open()
    try {
      const damaged = s.startWorker({ reading: readTicket('{"v":1,"run":"r1","role":"builder"'), prompt: '', host: 'laptop' })
      const ref = { sessionId: damaged.leg.sessionId, agentId: WORKER_AGENT_ID }
      expect(s.legOf(ref)!.ended).toBeNull()
      await insertAsWorker(s, damaged.leg.sessionId, 'my instructions were invalid', metadata)
      expect(s.legOf(ref)!.ended).toBe('invalid')
    } finally { await s.close() }
  })
})

describe('a process record never undoes how a leg ended', () => {
  it('a damaged ticket\'s worker whose one row landed before its process was recorded stays invalid; a cut is never undone by a re-run', async () => {
    const s = await open()
    try {
      const damaged = s.startWorker({ reading: readTicket('{"v":1,"run":"r1","role":"builder"'), prompt: '', host: 'laptop' })
      const ref = { sessionId: damaged.leg.sessionId, agentId: WORKER_AGENT_ID }
      await s.insert('my instructions were invalid', { leg: ref })
      expect(s.legOf(ref)!.ended).toBe('invalid')
      s.recordWorkerRerun(ref, { pid: 4242, start: 1, host: 'laptop', at: 2 })
      expect(s.legOf(ref)!.ended).toBe('invalid')
      s.recordWorkerRerun(ref, { pid: 4243, start: 1, host: 'laptop', at: 3 }, { rerun: true })
      expect(s.legOf(ref)!.ended).toBe('invalid')
      const cut = s.startWorker({ reading: readTicket(mintTicket({ run: 'r1', key: 'k', role: 'b', parent: { id: 'p1' } })), prompt: '', host: 'laptop' })
      const cref = { sessionId: cut.leg.sessionId, agentId: WORKER_AGENT_ID }
      s.retireLeg(cref, 'cut')
      s.recordWorkerRerun(cref, { pid: 1, start: 1, host: 'laptop', at: 2 }, { rerun: true })
      expect(s.legOf(cref)!.ended).toBe('cut')
      s.retireLeg({ sessionId: (await claimTicket({ store: s, env: { [TICKET_ENV]: mintTicket({ run: 'r1', key: 'k3', role: 'b', parent: { id: 'p1' } }) } })).leg!.sessionId, agentId: WORKER_AGENT_ID }, 'retired')
      const retired = s.legsOfRun('r1').find((l) => l.key === 'k3')!
      s.recordWorkerRerun({ sessionId: retired.sessionId, agentId: WORKER_AGENT_ID }, { pid: 2, start: 1, host: 'laptop', at: 3 }, { rerun: true })
      expect(s.legOf({ sessionId: retired.sessionId, agentId: WORKER_AGENT_ID })!.ended).toBeNull()
    } finally { await s.close() }
  })
})

describe('the first moment is written with the registration, or neither is', () => {
  it('a first-moment row the store refuses leaves no registration and no open row (M16)', async () => {
    const s = await open()
    try {
      const p = s.store as unknown as { insertNode: (tree: number, node: { metadata: Record<string, unknown> | null }) => boolean }
      const real = p.insertNode.bind(p)
      p.insertNode = (tree, node) => {
        if (node.metadata?.['kind'] === 'first-moment') throw new Error('the disk filled between the registration and its first row')
        return real(tree, node)
      }
      expect(() => s.startWorker({ reading: readTicket(mintTicket({ run: 'r-crash', key: 'k', role: 'b', parent: { id: 'p1' } })), prompt: 'go', host: 'laptop' })).toThrow(/disk filled/)
      p.insertNode = real
    } finally { await s.close() }
    expect(raw('SELECT 1 FROM session_registry')).toHaveLength(0)
    expect(raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.run') = 'r-crash'")).toHaveLength(0)
  })
})

describe('the door is a reader of the registry (D297)', () => {
  it('a predecessor gone with nobody having looked is retired by the door, and the next leg starts as its recovery (M8)', async () => {
    const s = await open()
    try {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      const pid = child.pid!
      const gone = new Promise((resolve) => child.once('exit', resolve))
      const prev = await s.registerWorker({
        door: 'library', ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } },
        process: { pid, start: hostProbe.startMoment(pid), token: hostProbe.startToken?.(pid) ?? null, host: hostProbe.host() },
      })
      child.kill('SIGKILL')
      await gone
      const r = await spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, ...standin({ first: { checkpoint: 'state: recovered' } }) })
      expect(r.firstMessage).toContain(`your predecessor, the builder leg in the lane of session ${prev.sessionId}, was found gone and retired as a phantom`)
      const reg = s.legOf({ sessionId: prev.sessionId, agentId: WORKER_AGENT_ID })!
      expect([reg.ended, reg.noticedBy]).toEqual(['phantom', 'ticket door'])
    } finally { await s.close() }
  }, 60_000)
})

describe('a checkpoint another writer left under the key since the start counts', () => {
  it('no send-back when the key was checkpointed by anyone while the worker ran (M14, D291)', async () => {
    const s = await open()
    try {
      const go = join(tmpDir, 'go')
      const p = spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, ...standin({ first: { waitFor: go } }) })
      const deadline = Date.now() + 30_000
      while (!existsSync(`${go}.ready`)) {
        if (Date.now() > deadline) throw new Error('the worker never got ready')
        await new Promise((r) => setTimeout(r, 25))
      }
      await s.writeCheckpoint('state: the reviewer checkpointed it', { run: 'r1', key: 'k', declared: { role: 'reviewer' } })
      writeFileSync(go, 'go')
      const r = await p
      expect([r.sentBack, r.runs.length, r.ended]).toEqual([false, 1, 'retired'])
    } finally { await s.close() }
  }, 60_000)
})

describe('a refused ticket', () => {
  it('leaves a row per refusal, never one row for two (identity, not text)', async () => {
    const s = await open()
    try {
      const reading = readTicket('{"v":1,"run":"r1","role":"builder"')
      const a = await s.writeRefusedTicket({ reading, spawner: { role: 'p1' } })
      const b = await s.writeRefusedTicket({ reading, spawner: { role: 'p1' } })
      expect(a.nodeId).not.toBe(b.nodeId)
    } finally { await s.close() }
    expect(raw("SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'ticket-refused'")).toHaveLength(2)
  })

  it('through the wrapper with no --spawner is a declared row by the ticket\'s parent in no session\'s lane; --spawner names a registered session\'s lane', async () => {
    const s = await open()
    const db = new DatabaseSync(path())
    try { registerSelf(db, 'p1', { worktree: null, branch: 'main', cwd: tmpDir, toplevel: null, commonDir: null }, 1) } finally { db.close() }
    await s.close()
    const truncated = '{"v":1,"run":"r1","key":"k","role":"builder","parent":{"id":"p1"'
    const home = mkdtempSync(join(tmpdir(), 'tc-door-home-'))
    try {
      const run = (extra: string[]) => spawnSync(process.execPath, nodeTsArgs(CLI_TS, ['run', '--store', path(), '--check-ticket', ...extra, '--', process.execPath, '-e', '0']), {
        env: { ...sandboxedSpawnEnv(home), [TICKET_ENV]: truncated }, cwd: tmpDir, encoding: 'utf8',
      })
      const plain = run([])
      expect(plain.status, plain.stderr).toBe(TICKET_REFUSED_EXIT)
      const named = run(['--spawner', 'p1'])
      expect(named.status, named.stderr).toBe(TICKET_REFUSED_EXIT)
    } finally { rmSync(home, { recursive: true, force: true }) }
    const rows = raw<{ session_key: string; m: string }>("SELECT session_key, metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'ticket-refused' ORDER BY rowid")
      .map((r) => ({ session: r.session_key, ...(JSON.parse(r.m) as Record<string, unknown>) }) as Record<string, unknown>)
    expect(rows.map((r) => [r['session'], r['_writer'], r['_writer_src'], r['_identity'], r['_door']])).toEqual([
      [NO_SESSION, 'p1', 'declared', 'declared', 'ticket'],
      ['p1', 'main', 'self', 'hook', 'ticket'],
    ])
  }, 60_000)
})
