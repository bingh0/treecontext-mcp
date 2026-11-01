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
import { readTicket, mintTicket, declaresDoor, TICKET_ENV, WORKER_SESSION_ENV } from '../src/ticket.js'
import {
  composeFirstMessage, STATE_NOT_HISTORY_LINE, PROMPT_HEADING, doorRowBoundaries, FIRST_MOMENT_PREVIEW_LEN, NO_CHECKPOINTER_LINE, sendBackReason,
} from '../src/first-moment.js'
import {
  sendBackDecision, spawnWorker, claimTicket, NOT_STARTED_EXIT, TICKET_REFUSED_EXIT, TIMEOUT_GRACE_MS, STDOUT_DRAIN_MS, type SendBackInput,
} from '../src/ticket-door.js'
import { hostProbe } from '../src/persistence/process-probe.js'
import { registerSelf } from '../src/persistence/session-registry.js'
import { NO_SESSION } from '../src/dedup-identity.js'
import { checkpointerFlag } from '../src/key-lookup.js'
import { INDEX_CAP_TOOL_DEFAULT } from '../src/persistence/capture-constants.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import { nodeTsArgs, CLI_TS, sandboxedSpawnEnv } from './helpers/cli-spawn.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client } from '@modelcontextprotocol/client'
import { parseRunArgs, RunUsageError } from '../src/server/run-command.js'
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
      // The re-run's message: the reason, the first moment composed again
      // (the brief, the state line, the prompt as written), the trail.
      const second = log[1]!.stdin
      const at = (t: string): number => second.indexOf(t)
      const order = [sendBackReason('builder', 'r1', 'k'), 'build the form', STATE_NOT_HISTORY_LINE, `${PROMPT_HEADING}\ngo`, `the row ${r.firstMomentId}`]
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
      // The worker led its own process group; no member of it is left.
      expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/)
      expect(raw<{ ended: string }>('SELECT ended FROM session_registry WHERE session_id = ?', r.sessionId)[0]!.ended).toBe('cut')
    } finally { await s.close() }
  }, 30_000)
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

  it('serve given a lane nobody registered writes by the ordinary ladder, never into the invented lane', async () => {
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
    expect([row[0]!.session_key === 'worker-invented', m['_cc_session_id'] === 'worker-invented', m['_writer'] === 'builder']).toEqual([false, false, false])
  }, 60_000)
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
