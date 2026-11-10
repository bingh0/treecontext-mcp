/**
 * Workers numbered apart from their readers (D403), below the charter's
 * scenarios in features/journal-workers.feature, through REAL sandboxes on
 * this host and the real doors:
 *
 *  - a door in a sandbox that numbers its own processes but keeps the
 *    machine's /proc (bwrap without `--proc`, `unshare --pid --fork`
 *    without `--mount-proc`): it records the start of its own worker, not
 *    of the machine's process that holds the same number, so a reader
 *    outside leaves the running worker live;
 *  - a door in a sandbox with no /proc of any kind: it records that it
 *    could not read its numbering, and no reader judges the id;
 *  - the session-start hook registering a `claude -p` child with a ticket
 *    from inside a sandbox, and a worker claiming its own ticket
 *    (`claimTicket`) there: both record the sandbox's numbering;
 *  - a reader inside a sandbox meeting a registration with no numbering:
 *    the reply says it cannot be checked from here.
 *
 * And, against the store alone: a phantom sent back reads live through its
 * re-run, a damaged ticket's phantom is set right by its first own row, and
 * the trail pane never counts a caller's `exit_by`.
 *
 * Every claim is read back from the SQLite file. A host that cannot make
 * a sandbox skips the test that needs it, with the reason.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { openNodeSqlite } from '../src/persistence/node-sqlite.js'
import { FlatStore } from '../src/flat-store.js'
import { createServer } from '../src/server/server.js'
import { hostProbe, linuxLookInNamespace, procHidesProcesses, seesEveryNumberingFrom, UNREAD_PID_NAMESPACE, MACHINE_PID_NAMESPACE, type ProcessProbe } from '../src/persistence/process-probe.js'
import { WORKER_AGENT_ID } from '../src/persistence/leg-registry.js'
import { mintTicket, readTicket, TICKET_ENV } from '../src/ticket.js'
import { nodeTsArgs, CLI_TS, sandboxedSpawnEnv } from './helpers/cli-spawn.js'
import { TS_ROOT } from './journal/proc.js'
import { PID_SANDBOX, STANDIN_WORKER, recordedSession } from './journal/standins.js'
import { openCaptureWorld, type CaptureWorld } from './journal/capture-harness.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f() })

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

/** Sandboxes of this host: each numbers its processes apart. */
const HOST_PROC_BWRAP = ['bwrap', '--unshare-user', '--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/']
const HOST_PROC_UNSHARE = ['unshare', '--user', '--map-current-user', '--pid', '--fork', '--kill-child']
const NO_PROC_BWRAP = ['bwrap', '--unshare-user', '--unshare-pid', '--die-with-parent', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--tmpfs', '/proc']

function canMake(sandbox: readonly string[]): boolean {
  if (process.platform !== 'linux') return false
  const r = spawnSync(sandbox[0]!, [...sandbox.slice(1), 'sh', '-c', 'echo $$'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 && /^\d+$/.test(r.stdout.trim()) && r.stdout.trim() !== String(process.pid)
}
const CAN = {
  hostProcBwrap: canMake(HOST_PROC_BWRAP),
  hostProcUnshare: canMake(HOST_PROC_UNSHARE),
  noProcBwrap: canMake(NO_PROC_BWRAP),
  ownProc: canMake(PID_SANDBOX),
}

async function waitFor(file: string, ms = 60_000): Promise<string> {
  const deadline = Date.now() + ms
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`)
    await new Promise((r) => setTimeout(r, 25))
  }
  await new Promise((r) => setTimeout(r, 50))
  return readFileSync(file, 'utf8').trim()
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  })
}

function rows<T>(db: string, sql: string, ...p: unknown[]): T[] {
  const d = new DatabaseSync(db, { readOnly: true })
  try { return d.prepare(sql).all(...(p as never[])) as T[] } finally { d.close() }
}
const registrationOf = (db: string, role: string): Record<string, unknown> =>
  rows<Record<string, unknown>>(db, "SELECT * FROM session_registry WHERE kind = 'worker' AND agent_type = ?", role)[0]!

/** The machine's own reading of a process found in a sandbox's numbering:
 *  its entry in this reader's /proc and the start token read there. */
function machineTokenOf(hostPid: number): string {
  const stat = readFileSync(`/proc/${hostPid}/stat`, 'utf8')
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`
}

/** A reader outside every sandbox: this process, through the library. */
async function readOutside(db: string, probe?: ProcessProbe): Promise<ReturnType<FlatStore['retirePhantoms']>> {
  const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), ownsDatabase: true, retentionInterval: 1_000_000 })
  try { return s.retirePhantoms({ noticedBy: 'lookup', ...(probe ? { probe } : {}) }) } finally { await s.close() }
}

/** A store file this build has migrated, and the `treecontext run` wrapper
 *  started in `sandbox` against it: the worker is a shell that writes its
 *  own id (in its numbering) to `ready` and waits for `go`. */
async function wrapperIn(sandbox: readonly string[], role: string): Promise<{ db: string; dir: string; door: ChildProcess; pid: number; home: string; proj: string }> {
  const dir = tmp('tc-sandboxed-')
  const home = join(dir, 'home')
  const proj = join(dir, 'proj')
  mkdirSync(proj, { recursive: true })
  const db = join(home, '.treecontext', 'stores', 'sbx', 'treecontext.db')
  const worker = `echo $$ > ${join(dir, 'ready')}; while [ ! -e ${join(dir, 'go')} ]; do sleep 0.05; done`
  const argv = [...sandbox, process.execPath, ...nodeTsArgs(CLI_TS, [
    'run', '--store', 'sbx', '--run', 'r', '--role', role, '--no-key', '--parent', 'p', '--', 'sh', '-c', worker,
  ])]
  const door = spawn(argv[0]!, argv.slice(1), { cwd: proj, env: sandboxedSpawnEnv(home), stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  door.stderr!.on('data', (d) => { err += String(d) })
  cleanups.push(async () => { if (!existsSync(join(dir, 'go'))) writeFileSync(join(dir, 'go'), 'go'); door.kill('SIGKILL'); await exited(door) })
  const pid = Number(await waitFor(join(dir, 'ready')).catch((e: Error) => { throw new Error(`${e.message}; door said: ${err}`) }))
  return { db, dir, door, pid, home, proj }
}

/** A second `treecontext run` of the same run, started in `sandbox`, whose
 *  door runs the phantom pass over the run before it starts its worker. */
function secondDoorIn(sandbox: readonly string[], w: { home: string; proj: string }): void {
  const argv = [...sandbox, process.execPath, ...nodeTsArgs(CLI_TS, ['run', '--store', 'sbx', '--run', 'r', '--role', 'prober', '--no-key', '--parent', 'p', '--', 'true'])]
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: w.proj, env: sandboxedSpawnEnv(w.home), encoding: 'utf8', timeout: 60_000 })
  expect(r.status, r.stderr).toBe(0)
}

/** Sandboxes whose processes read the clock since boot shifted (a time
 *  namespace), with and without a numbering of their own. */
const TIME_AND_PID = ['unshare', '--user', '--map-current-user', '--pid', '--fork', '--kill-child', '--mount-proc', '--time', '--boottime', '100000']
const TIME_ONLY = ['unshare', '--user', '--map-current-user', '--time', '--boottime', '100000']
const CAN_TIME = { pid: canMake(TIME_AND_PID), only: process.platform === 'linux' && spawnSync(TIME_ONLY[0]!, [...TIME_ONLY.slice(1), 'true'], { timeout: 10_000 }).status === 0 }
const NESTED_HOST_PROC = [...HOST_PROC_BWRAP, ...HOST_PROC_BWRAP]
const CAN_NESTED = canMake(NESTED_HOST_PROC)

describe('a reader that cannot read its own numbering judges no worker (D403)', () => {
  for (const [name, sandbox, can] of [
    ['a worker on the machine', [] as readonly string[], process.platform === 'linux'],
    ['a worker in a sandbox that keeps the machine\'s /proc', HOST_PROC_BWRAP, CAN.hostProcBwrap],
  ] as const) {
    it.skipIf(!can || !CAN.noProcBwrap)(`${name}: a door with no /proc runs its pass over the run and leaves the running worker live`, async () => {
      const w = await wrapperIn(sandbox, 'sleeper')
      secondDoorIn(NO_PROC_BWRAP, w)
      expect(registrationOf(w.db, 'prober')['proc_ns']).toBe(UNREAD_PID_NAMESPACE)
      expect(registrationOf(w.db, 'sleeper')).toMatchObject({ ended: null, stopped_at: null, noticed_at: null })
      writeFileSync(join(w.dir, 'go'), 'go')
      expect(await exited(w.door)).toBe(0)
      expect(registrationOf(w.db, 'sleeper')['ended']).toBe('retired')
    }, 120_000)
  }

  it('the reply says so, whether the registration records a numbering or none', async () => {
    const db = join(tmp('tc-unread-reader-'), 'legs.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), retentionInterval: 1_000_000 })
    cleanups.push(() => s.close())
    for (const [sid, ns] of [['numbered', MACHINE_PID_NAMESPACE], ['legacy', null]] as const) {
      await s.registerWorker({ sessionId: sid, door: 'library', ticket: { parent: { id: 'p' }, run: 'r', key: sid, role: 'w', checkpointer: 'w' }, process: { pid: 7, start: 1000, host: 'laptop', ...(ns ? { ns } : {}) } })
    }
    const blind: ProcessProbe = { host: () => 'laptop', exists: () => false, startMoment: () => null, pidNamespace: () => null }
    const pass = s.retirePhantoms({ noticedBy: 'lookup', probe: blind, at: 9 })
    if (process.platform !== 'linux') return
    expect(pass.retired).toEqual([])
    expect(pass.notes).toHaveLength(2)
    for (const n of pass.notes) expect(n).toContain('this reader cannot read which numbering of processes it runs in')
  })
})

describe('a start read in another time namespace is never compared (D403, D317)', () => {
  for (const [name, sandbox, can] of [
    ['a door in a time namespace and a numbering of its own', TIME_AND_PID, CAN_TIME.pid],
    ['a door in a time namespace alone', TIME_ONLY, CAN_TIME.only],
  ] as const) {
    it.skipIf(!can)(`${name}: a reader outside leaves the running worker live, saying why`, async () => {
      const w = await wrapperIn(sandbox, 'sleeper')
      const reg = registrationOf(w.db, 'sleeper')
      const proc = (JSON.parse(String(reg['processes'])) as Array<Record<string, unknown>>)[0]!
      expect(proc['tns']).toMatch(/^time:\[\d+\]$/)
      expect(proc['tns']).not.toBe(hostProbe.timeNamespace!('self'))
      const pass = await readOutside(w.db)
      expect(pass.retired).toEqual([])
      expect(pass.notes.join('\n')).toContain('was read in another time namespace')
      expect(registrationOf(w.db, 'sleeper')).toMatchObject({ ended: null, noticed_at: null })
      // A plain door's own pass over the run, as the reproduction ran it.
      secondDoorIn([], w)
      expect(registrationOf(w.db, 'sleeper')['ended']).toBeNull()
      writeFileSync(join(w.dir, 'go'), 'go')
      expect(await exited(w.door)).toBe(0)
      expect(registrationOf(w.db, 'sleeper')['ended']).toBe('retired')
    }, 120_000)
  }

  it('a registration with no time namespace recorded keeps the rule it had; one read in this reader\'s compares as before', async () => {
    const db = join(tmp('tc-time-'), 'legs.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), retentionInterval: 1_000_000 })
    cleanups.push(() => s.close())
    const own = 'time:[1]'
    const cases: Array<[string, string | undefined]> = [['legacy', undefined], ['same', own], ['other', 'time:[2]'], ['unread', 'time:[unread]']]
    for (const [sid, tns] of cases) {
      await s.registerWorker({ sessionId: sid, door: 'library', ticket: { parent: { id: 'p' }, run: 'r', key: sid, role: 'w', checkpointer: 'w' }, process: { pid: 7, start: 1000, host: 'laptop', ns: 'pid:[9]', ...(tns ? { tns } : {}) } })
    }
    // Process 7 exists with another start: a successor, where the starts compare.
    const reader: ProcessProbe = { host: () => 'laptop', exists: () => true, startMoment: () => 5000, pidNamespace: () => 'pid:[9]', timeNamespace: () => own }
    s.retirePhantoms({ noticedBy: 'lookup', probe: reader, at: 9 })
    const ended = Object.fromEntries(cases.map(([sid]) => [sid, s.legOf({ sessionId: sid, agentId: WORKER_AGENT_ID })!.ended]))
    expect(ended).toEqual({ legacy: 'phantom', same: 'phantom', other: null, unread: null })
  })
})

describe('a door two numberings deep that keeps the machine\'s /proc (D403)', () => {
  it.skipIf(!CAN_NESTED)('records its own worker\'s start, read through the entry in its own numbering', async () => {
    const { db, dir, door, pid } = await wrapperIn(NESTED_HOST_PROC, 'deep')
    const reg = registrationOf(db, 'deep')
    const found = linuxLookInNamespace(String(reg['proc_ns']), pid)
    expect(found.hostPid).not.toBeNull()
    expect(readFileSync(`/proc/${found.hostPid}/status`, 'utf8')).toMatch(/^NSpid:\s+\d+\s+\d+\s+\d+\s*$/m)
    expect(reg['proc_start_token']).toBe(machineTokenOf(found.hostPid!))
    await readOutside(db)
    expect(registrationOf(db, 'deep')['ended']).toBeNull()
    writeFileSync(join(dir, 'go'), 'go')
    expect(await exited(door)).toBe(0)
  }, 120_000)
})

describe('a /proc that hides processes does not show every numbering (D403)', () => {
  const HIDING = ['unshare', '--user', '--map-root-user', '--pid', '--fork', '--kill-child', '--mount', '--propagation', 'private', 'sh', '-c', 'mount -t proc -o hidepid=invisible proc /proc && cat /proc/self/mountinfo']
  const hiding = process.platform === 'linux' ? spawnSync(HIDING[0]!, HIDING.slice(1), { encoding: 'utf8', timeout: 10_000 }) : null
  it.skipIf(!hiding || hiding.status !== 0)('reads hidepid off a real /proc mount, and this host\'s own reader sees every numbering only where its /proc hides nothing', () => {
    expect(procHidesProcesses(hiding!.stdout)).toBe(true)
    const own = readFileSync('/proc/self/mountinfo', 'utf8')
    expect(hostProbe.seesEveryNumbering!()).toBe(hostProbe.pidNamespace!('self') === MACHINE_PID_NAMESPACE && !procHidesProcesses(own))
    // The rule over what a reader read of itself: the real mountinfo texts.
    const me = { ownNs: MACHINE_PID_NAMESPACE, procIsOwn: true, uid: 1000, mountinfo: own }
    expect(seesEveryNumberingFrom(me)).toBe(!procHidesProcesses(own))
    expect(seesEveryNumberingFrom({ ...me, mountinfo: hiding!.stdout })).toBe(false)
    expect(seesEveryNumberingFrom({ ...me, mountinfo: hiding!.stdout, uid: 0 })).toBe(true)
    expect(seesEveryNumberingFrom({ ...me, mountinfo: null })).toBe(false)
    expect(seesEveryNumberingFrom({ ...me, procIsOwn: false, mountinfo: hiding!.stdout.replaceAll('hidepid=invisible', 'hidepid=0') })).toBe(false)
    expect(seesEveryNumberingFrom({ ...me, ownNs: 'pid:[8]' })).toBe(false)
  })
})


describe('a door in a sandbox that keeps the machine\'s /proc (D403)', () => {
  for (const [name, sandbox, can] of [
    ['bwrap without --proc', HOST_PROC_BWRAP, CAN.hostProcBwrap],
    ['unshare --pid --fork without --mount-proc', HOST_PROC_UNSHARE, CAN.hostProcUnshare],
  ] as const) {
    it.skipIf(!can)(`${name}: records its own worker's start, and a reader outside leaves the running worker live`, async () => {
      const { db, dir, door, pid } = await wrapperIn(sandbox, 'sleeper')
      const live = registrationOf(db, 'sleeper')
      // The id the sandbox gave its worker, and the sandbox's numbering.
      expect(live['pid']).toBe(pid)
      expect(live['proc_ns']).toMatch(/^pid:\[\d+\]$/)
      expect(live['proc_ns']).not.toBe(hostProbe.pidNamespace!('self'))
      // The machine's process of that number is not the worker; the one
      // found in the sandbox's numbering is, and its start is what the door
      // recorded.
      const found = linuxLookInNamespace(String(live['proc_ns']), pid)
      expect(found.hostPid).not.toBeNull()
      expect(found.hostPid).not.toBe(pid)
      expect(live['proc_start_token']).toBe(machineTokenOf(found.hostPid!))
      const pass = await readOutside(db)
      expect(pass.retired).toEqual([])
      expect(registrationOf(db, 'sleeper')).toMatchObject({ ended: null, stopped_at: null, noticed_at: null })
      writeFileSync(join(dir, 'go'), 'go')
      expect(await exited(door)).toBe(0)
      expect(registrationOf(db, 'sleeper')['ended']).toBe('retired')
    }, 120_000)
  }

  it.skipIf(!CAN.hostProcBwrap)('a sandbox of that kind ended with every process in it: a reader outside retires its worker as a phantom', async () => {
    const { db, pid } = await wrapperIn(HOST_PROC_BWRAP, 'doomed')
    const ns = String(registrationOf(db, 'doomed')['proc_ns'])
    // The sandbox's first process ends: the kernel ends every process in it.
    const init = linuxLookInNamespace(ns, 1).hostPid
    expect(init).not.toBeNull()
    process.kill(init!, 'SIGKILL')
    const deadline = Date.now() + 10_000
    while (linuxLookInNamespace(ns, pid).seen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(registrationOf(db, 'doomed')['ended']).toBeNull()
    await readOutside(db)
    expect(registrationOf(db, 'doomed')).toMatchObject({ ended: 'phantom', noticed_by: 'lookup', stopped_at: null })
  }, 120_000)
})

describe('a door in a sandbox with no /proc at all (D403)', () => {
  it.skipIf(!CAN.noProcBwrap)('records that it could not read its numbering, and a reader outside leaves the worker live, saying why', async () => {
    const { db, dir, door, pid } = await wrapperIn(NO_PROC_BWRAP, 'blind')
    expect(registrationOf(db, 'blind')).toMatchObject({ pid, proc_ns: UNREAD_PID_NAMESPACE, proc_start: null, proc_start_token: null })
    const pass = await readOutside(db)
    expect(pass.retired).toEqual([])
    expect(pass.unchecked.map((u) => u.reason)).toEqual(['other-numbering'])
    expect(pass.notes[0]).toContain('runs where this reader cannot see its process')
    expect(pass.notes[0]).toContain('could not read which numbering of processes')
    expect(pass.notes[0]).toContain('cannot be checked from here')
    expect(registrationOf(db, 'blind')['ended']).toBeNull()
    writeFileSync(join(dir, 'go'), 'go')
    expect(await exited(door)).toBe(0)
    expect(registrationOf(db, 'blind')['ended']).toBe('retired')
  }, 120_000)
})

describe('the other doors record the sandbox\'s numbering (D403)', () => {
  it.skipIf(!CAN.ownProc)('the session-start hook registers a `claude -p` child with a ticket inside a sandbox in the sandbox\'s numbering (the recorded SessionStart)', async () => {
    const w = { defer: (f: () => unknown) => { cleanups.push(f) } } as unknown as CaptureWorld
    await openCaptureWorld(w)
    const dir = tmp('tc-sandboxed-hook-')
    // Claude Code's own SessionStart, as recorded; its cwd and session id
    // rewritten as the replay does (standins.ts replayRecordedSession).
    const recorded = recordedSession('2.1.321', 'success-reading-like-trouble.ndjson').find((e) => e['hook_event_name'] === 'SessionStart')!
    const payload = { ...recorded, cwd: w.proj, session_id: 'sbx-claude-p-child' }
    writeFileSync(join(dir, 'payload.json'), JSON.stringify(payload))
    // The client process the hook runs under is a shell that stays, as a
    // `claude -p` does after its SessionStart hook returns.
    const hook = [process.execPath, ...nodeTsArgs(CLI_TS, ['hook', 'session-start'])].map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ')
    const client = spawn(PID_SANDBOX[0]!, [...PID_SANDBOX.slice(1), 'sh', '-c',
      `${hook} < ${join(dir, 'payload.json')} > ${join(dir, 'out.json')}; echo $$ > ${join(dir, 'ready')}; while [ ! -e ${join(dir, 'go')} ]; do sleep 0.05; done`,
    ], {
      cwd: TS_ROOT, stdio: 'ignore',
      env: sandboxedSpawnEnv(w.home!, {
        TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'),
        [TICKET_ENV]: mintTicket({ run: 'r', noKey: true, role: 'child', parent: { id: 'p' } }),
      }),
    })
    cleanups.push(async () => { client.kill('SIGKILL'); await exited(client) })
    const shellPid = Number(await waitFor(join(dir, 'ready')))
    const reg = registrationOf(w.dbPath!, 'child')
    expect(reg['session_id']).toBe('sbx-claude-p-child')
    expect(reg['pid']).toBe(shellPid)
    expect(reg['proc_ns']).toMatch(/^pid:\[\d+\]$/)
    expect(reg['proc_ns']).not.toBe(hostProbe.pidNamespace!('self'))
    const found = linuxLookInNamespace(String(reg['proc_ns']), shellPid)
    expect(reg['proc_start_token']).toBe(machineTokenOf(found.hostPid!))
    await readOutside(w.dbPath!)
    expect(registrationOf(w.dbPath!, 'child')['ended']).toBeNull()
    // Its sandbox ends with the client in it: a reader outside sees so.
    client.kill('SIGKILL')
    await exited(client)
    const deadline = Date.now() + 10_000
    while (linuxLookInNamespace(String(reg['proc_ns']), shellPid).seen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    await readOutside(w.dbPath!)
    expect(registrationOf(w.dbPath!, 'child')['ended']).toBe('phantom')
  }, 120_000)

  it.skipIf(!CAN.ownProc)('a worker claiming its own ticket inside a sandbox (`claimTicket`) is registered in the sandbox\'s numbering', async () => {
    const dir = tmp('tc-sandboxed-claim-')
    const db = join(dir, 'treecontext.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), ownsDatabase: true })
    await s.close()
    const go = join(dir, 'go')
    const child = spawn(PID_SANDBOX[0]!, [...PID_SANDBOX.slice(1), process.execPath, ...nodeTsArgs(STANDIN_WORKER)], {
      cwd: TS_ROOT, stdio: 'ignore',
      env: sandboxedSpawnEnv(join(dir, 'home'), {
        STANDIN_DB: db, STANDIN_PLAN: JSON.stringify({ first: { waitFor: go } }),
        [TICKET_ENV]: mintTicket({ run: 'r', noKey: true, role: 'claimer', parent: { id: 'p' } }),
      }),
    })
    cleanups.push(async () => { if (!existsSync(go)) writeFileSync(go, 'go'); child.kill('SIGKILL'); await exited(child) })
    const pid = Number(await waitFor(`${go}.ready`))
    const reg = registrationOf(db, 'claimer')
    expect(reg['pid']).toBe(pid)
    expect(reg['proc_ns']).toMatch(/^pid:\[\d+\]$/)
    expect(reg['proc_ns']).not.toBe(hostProbe.pidNamespace!('self'))
    await readOutside(db)
    expect(registrationOf(db, 'claimer')['ended']).toBeNull()
    writeFileSync(go, 'go')
    await exited(child)
    // No door saw it end (it claimed its own ticket); its sandbox is gone.
    await readOutside(db)
    expect(registrationOf(db, 'claimer')['ended']).toBe('phantom')
  }, 120_000)
})

describe('a reader inside a sandbox meets a registration with no numbering (D403)', () => {
  it.skipIf(!CAN.ownProc)('leaves it live, and the reply says an earlier build recorded no numbering, so it cannot be checked from here', async () => {
    const dir = tmp('tc-sandboxed-legacy-')
    const db = join(dir, 'treecontext.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), ownsDatabase: true })
    // A registration as an earlier build wrote it: an id, a start, no
    // numbering. The process is this one, running, in the machine's.
    await s.registerWorker({
      sessionId: 'legacy', door: 'library', ticket: { parent: { id: 'p' }, run: 'r', key: 'k', role: 'old', checkpointer: 'old' },
      process: { pid: process.pid, start: hostProbe.startMoment(process.pid), token: hostProbe.startToken!(process.pid), host: hostProbe.host() },
    })
    await s.close()
    const r = spawnSync(PID_SANDBOX[0]!, [...PID_SANDBOX.slice(1), process.execPath, ...nodeTsArgs(join(TS_ROOT, 'tests', 'helpers', 'lookup-driver.ts'), [db, 'r', 'k'])], {
      cwd: TS_ROOT, encoding: 'utf8', timeout: 60_000, env: sandboxedSpawnEnv(join(dir, 'home')),
    })
    expect(r.status, r.stderr).toBe(0)
    const l = JSON.parse(r.stdout) as { legs: Array<{ sessionId: string; state: string }>; notes: string[]; unchecked: Array<{ sessionId: string; reason: string }> }
    expect(l.legs.find((g) => g.sessionId === 'legacy')?.state).toBe('live')
    expect(l.unchecked).toEqual([{ sessionId: 'legacy', reason: 'other-numbering' }])
    const said = l.notes.filter((n) => n.includes('legacy'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('registered by an earlier build that recorded no numbering of processes')
    expect(said[0]).toContain('cannot be checked from here')
    expect(said[0]).toContain(`not the machine's own ${MACHINE_PID_NAMESPACE}`)
    expect(rows<{ ended: string | null }>(db, "SELECT ended FROM session_registry WHERE session_id = 'legacy'")[0]!.ended).toBeNull()
  }, 120_000)
})

describe('the store\'s own rules beside a phantom (D403)', () => {
  const gone: ProcessProbe = { host: () => 'laptop', exists: () => false, startMoment: () => null }
  async function store(): Promise<{ s: FlatStore; db: string }> {
    const db = join(tmp('tc-phantom-'), 'legs.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), retentionInterval: 1_000_000 })
    cleanups.push(() => s.close())
    return { s, db }
  }

  it('a damaged ticket\'s worker taken for a phantom is set right to invalid by its first own row, at that row\'s moment, its notice kept', async () => {
    const { s } = await store()
    const damaged = s.startWorker({ reading: readTicket('{"v":1,"run":"r1","role":"builder"'), prompt: '', host: 'laptop' })
    const ref = { sessionId: damaged.leg.sessionId, agentId: WORKER_AGENT_ID }
    s.recordWorkerRerun(ref, { pid: 4242, start: 1, host: 'laptop', at: 2 })
    s.retirePhantoms({ noticedBy: 'lookup', probe: gone, at: 5 })
    expect(s.legOf(ref)).toMatchObject({ ended: 'phantom', noticedAt: 5, stoppedAt: null })
    const row = await s.insert('my instructions were invalid', { leg: ref })
    const leg = s.legOf(ref)!
    expect(leg).toMatchObject({ ended: 'invalid', noticedAt: 5, noticedBy: 'lookup' })
    const created = (s.store.database.prepare('SELECT created_at FROM nodes WHERE node_id = ?').get(row.nodeId) as { created_at: number }).created_at
    expect(leg.stoppedAt).toBe(created)
  })

  it('a phantom its door sends back reads live through its re-run, its notice kept (the real door, a worker taken for gone mid-run)', async () => {
    const { s, db } = await store()
    const dir = tmp('tc-phantom-rerun-')
    // Each run writes its number to ready<n> and waits for go<n>; it never
    // checkpoints, so its first exit earns the one send-back.
    const script = `n=$(cat ${dir}/count 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${dir}/count; echo $$ > ${dir}/ready$n; while [ ! -e ${dir}/go$n ]; do sleep 0.05; done`
    const { spawnWorker } = await import('../src/ticket-door.js')
    const run = spawnWorker({ store: s, ticket: { run: 'r1', key: 'k', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } }, prompt: 'p', command: 'sh', args: ['-c', script], onStderr: () => undefined })
    cleanups.push(async () => { for (const n of [1, 2]) if (!existsSync(join(dir, `go${n}`))) writeFileSync(join(dir, `go${n}`), 'go'); await run.catch(() => undefined) })
    await waitFor(join(dir, 'ready1'))
    const sid = rows<{ session_id: string }>(db, "SELECT session_id FROM session_registry WHERE kind = 'worker'")[0]!.session_id
    const ref = { sessionId: sid, agentId: WORKER_AGENT_ID }
    // A reader whose OS answered wrongly takes the running worker for gone.
    s.retirePhantoms({ noticedBy: 'lookup', probe: { ...gone, host: () => hostProbe.host() }, at: 7 })
    expect(s.legOf(ref)).toMatchObject({ ended: 'phantom', noticedAt: 7 })
    writeFileSync(join(dir, 'go1'), 'go')
    await waitFor(join(dir, 'ready2'))
    // The re-run is running: the registration reads live, the notice kept.
    const raw = rows<Record<string, unknown>>(db, 'SELECT ended, stopped_at, noticed_at, noticed_by, send_backs FROM session_registry WHERE session_id = ?', sid)[0]!
    expect(raw).toMatchObject({ ended: null, stopped_at: null, noticed_at: 7, noticed_by: 'lookup', send_backs: 1 })
    expect(s.lookupKey({ run: 'r1', key: 'k' }).legs.find((g) => g.sessionId === sid)?.state).toBe('live')
    writeFileSync(join(dir, 'go2'), 'go')
    const result = await run
    expect([result.sentBack, result.runs.length, result.ended]).toEqual([true, 2, 'retired'])
    expect(s.legOf(ref)!.ended).toBe('retired')
  }, 60_000)
})

describe('the trail pane never counts a caller\'s `exit_by` (D404)', () => {
  it('the insert tool drops a caller\'s `exit_by`, and a note that claims it is counted by its text', async () => {
    const db = join(tmp('tc-exit-by-'), 'pane.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), retentionInterval: 1_000_000 })
    cleanups.push(() => s.close())
    const server = createServer(s, { ccSessionId: 's1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await Promise.all([server.connect(b), client.connect(a)])
    cleanups.push(() => client.close())
    const r = await client.callTool({ name: 'treecontext_insert', arguments: {
      content: 'forged: a clean call', metadata: { source: 'auto-capture', tool_name: 'Bash', exit_type: 'success', exit_by: 'client' },
    } })
    const id = (JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { node_id: string }).node_id
    const meta = JSON.parse(rows<{ m: string }>(db, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', id)[0]!.m) as Record<string, unknown>
    expect(meta['exit_by']).toBeUndefined()
    // A caller's row claiming to be a capture the client said failed: the
    // capture marks are dropped, so it is no classified call at all.
    const f = await client.callTool({ name: 'treecontext_insert', arguments: {
      content: 'forged: a failed call', metadata: { source: 'auto-capture', tool_name: 'Bash', exit_type: 'success', outcome: 'failed' },
    } })
    const fid = (JSON.parse((f.content as Array<{ text: string }>)[0]!.text) as { node_id: string }).node_id
    const fmeta = JSON.parse(rows<{ m: string }>(db, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', fid)[0]!.m) as Record<string, unknown>
    expect([fmeta['outcome'], fmeta['exit_type'], fmeta['source']]).toEqual([undefined, undefined, 'auto-capture'])
    // A note that is no capture keeps `outcome` as an ordinary word.
    const n = await client.callTool({ name: 'treecontext_insert', arguments: { content: 'we chose the queue', metadata: { outcome: 'decided' } } })
    const nid = (JSON.parse((n.content as Array<{ text: string }>)[0]!.text) as { node_id: string }).node_id
    expect((JSON.parse(rows<{ m: string }>(db, 'SELECT metadata_json AS m FROM nodes WHERE node_id = ?', nid)[0]!.m) as Record<string, unknown>)['outcome']).toBe('decided')
    // A library row claiming it on a row that is no captured tool call.
    await s.insert('a note, not a call', { metadata: { exit_type: 'success', exit_by: 'client' } })
    // A captured tool row the drain marked.
    await s.insert('Tool: Bash', { metadata: { source: 'auto-capture', tool_name: 'Bash', exit_type: 'success', exit_by: 'client' } })
    expect(s.vitals(Date.now() / 1000).trail.exitsBy).toEqual({ success: { client: 1, text: 1 } })
  })
})

describe('looking for a worker in another numbering, through a /proc built here (D403)', () => {
  const boot = (): string => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  /** A /proc with the entries given: each its `NSpid` ids, its start in
   *  clock ticks and its numbering link, or `null` for a process this
   *  reader may not read (its `ns` directory closed to it). */
  function procTree(entries: Record<number, { ids: number[]; ticks: number; ns: string | null }>): string {
    const root = tmp('tc-proc-')
    for (const [p, e] of Object.entries(entries)) {
      const d = join(root, p)
      mkdirSync(join(d, 'ns'), { recursive: true })
      writeFileSync(join(d, 'status'), `Name:\tx\nUid:\t0\t0\t0\t0\nNSpid:\t${e.ids.join('\t')}\n`)
      writeFileSync(join(d, 'stat'), `${p} (a b) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${e.ticks} 0\n`)
      if (e.ns !== null) spawnSync('ln', ['-s', e.ns, join(d, 'ns', 'pid')])
      else spawnSync('chmod', ['000', join(d, 'ns')])
    }
    cleanups.push(() => { for (const p of Object.keys(entries)) spawnSync('chmod', ['755', join(root, p, 'ns')]) })
    return root
  }
  const SBX = 'pid:[555]'

  it.skipIf(process.platform !== 'linux')('finds the worker by its id in its numbering and reads its start there; an unreadable process is the worker only with its id and its start', () => {
    const root = procTree({
      100: { ids: [100, 7], ticks: 500, ns: SBX },
      200: { ids: [200, 7], ticks: 999, ns: null },
      300: { ids: [300, 9], ticks: 500, ns: null },
      400: { ids: [400], ticks: 1, ns: MACHINE_PID_NAMESPACE },
    })
    expect(linuxLookInNamespace(SBX, 7, { start: null, token: `${boot()}:500` }, root))
      .toEqual({ seen: true, hostPid: 100, unreadable: false, start: expect.any(Number), token: `${boot()}:500` })
    // Not in the numbering looked for: the readable one is not seen; the
    // unreadable one numbered 7 with another start is not the worker, and
    // the one numbered 9 is not it whatever its start.
    expect(linuxLookInNamespace('pid:[556]', 7, { start: null, token: `${boot()}:500` }, root)).toEqual({ seen: false, hostPid: null, unreadable: false })
    // An unreadable process numbered 7 with the worker's start may be it.
    expect(linuxLookInNamespace('pid:[556]', 7, { start: null, token: `${boot()}:999` }, root)).toMatchObject({ seen: false, hostPid: null, unreadable: true })
    // With no registered start to compare, it may be it too.
    expect(linuxLookInNamespace('pid:[556]', 7, { start: null, token: null }, root)).toMatchObject({ unreadable: true })
    expect(linuxLookInNamespace('pid:[556]', 9, { start: null, token: `${boot()}:1` }, root)).toMatchObject({ unreadable: false })
  })

  const reader = (o: { self: string; look: { seen: boolean; hostPid: number | null; unreadable: boolean; start?: number | null; token?: string | null }; seesAll?: boolean }): ProcessProbe => ({
    host: () => 'laptop', exists: () => true, startMoment: () => 1000,
    pidNamespace: (p) => (p === 'self' ? o.self : null),
    lookInNamespace: () => o.look,
    ...(o.seesAll === undefined ? {} : { seesEveryNumbering: () => o.seesAll! }),
  })
  async function judged(probe: ProcessProbe, ns: string): Promise<{ ended: unknown; notes: string[] }> {
    const db = join(tmp('tc-judged-'), 'legs.db')
    const s = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(db)), retentionInterval: 1_000_000 })
    try {
      await s.registerWorker({ sessionId: 'w', door: 'library', ticket: { parent: { id: 'p' }, run: 'r', key: 'k', role: 'b', checkpointer: 'b' }, process: { pid: 7, start: 1000, host: 'laptop', ns } })
      const pass = s.retirePhantoms({ noticedBy: 'lookup', probe, at: 9 })
      return { ended: s.legOf({ sessionId: 'w', agentId: WORKER_AGENT_ID })!.ended, notes: pass.notes }
    } finally { await s.close() }
  }

  it('a process that may be the worker, unreadable, keeps it live even where its numbering is seen; a reader that does not see every numbering never takes "not seen" for gone', async () => {
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: true, hostPid: null, unreadable: true } }), SBX)).ended).toBeNull()
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: true, hostPid: null, unreadable: false } }), SBX)).ended).toBe('phantom')
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: false, hostPid: null, unreadable: false }, seesAll: false }), SBX)).ended).toBeNull()
    // A reader in a sandbox of its own that sees the worker's numbering
    // with no process numbered so: gone, whatever it sees of the rest.
    expect((await judged(reader({ self: 'pid:[8]', look: { seen: true, hostPid: null, unreadable: false } }), SBX)).ended).toBe('phantom')
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: false, hostPid: null, unreadable: false }, seesAll: true }), SBX)).ended).toBe('phantom')
  })

  it('the worker found in its numbering is judged by the start read where it was found, never by the reader\'s own table', async () => {
    // The reader's own table says process 7 exists with start 1000; the
    // worker's numbering holds 7 with another start: gone.
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: true, hostPid: 42, unreadable: false, start: 3000, token: null } }), SBX)).ended).toBe('phantom')
    expect((await judged(reader({ self: MACHINE_PID_NAMESPACE, look: { seen: true, hostPid: 42, unreadable: false, start: 1000, token: null } }), SBX)).ended).toBeNull()
    // A probe whose look reads no start: the start is read by the id the
    // worker was found at, never by its id in its own numbering.
    const byId: ProcessProbe = { ...reader({ self: MACHINE_PID_NAMESPACE, look: { seen: true, hostPid: 42, unreadable: false } }), startMoment: (p) => (p === 42 ? 3000 : 1000) }
    expect((await judged(byId, SBX)).ended).toBe('phantom')
  })

  it('the reply names the machine\'s numbering as the machine\'s, and a sandbox\'s as another than the reader\'s', async () => {
    const outside = await judged(reader({ self: 'pid:[8]', look: { seen: false, hostPid: null, unreadable: false } }), MACHINE_PID_NAMESPACE)
    expect(outside.ended).toBeNull()
    expect(outside.notes[0]).toContain(`numbered in the machine's own numbering of processes (${MACHINE_PID_NAMESPACE})`)
    expect(outside.notes[0]).toContain('numbered apart in pid:[8]')
    expect(outside.notes[0]).not.toContain("a sandbox's")
    const other = await judged(reader({ self: 'pid:[8]', look: { seen: false, hostPid: null, unreadable: false } }), SBX)
    expect(other.notes[0]).toContain(`another numbering of processes (${SBX}) than this reader's (pid:[8])`)
    for (const n of [...outside.notes, ...other.notes]) {
      expect(n).toContain('runs where this reader cannot see its process')
      expect(n).toContain('cannot be checked from here')
    }
  })
})
