import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { type Registry } from 'gherkin-node-test/vitest'
import { FlatStore } from '../../../src/flat-store.js'
import { openNodeSqlite } from '../../../src/persistence/node-sqlite.js'
import { hostProbe } from '../../../src/persistence/process-probe.js'
import { WORKER_AGENT_ID, NOTICED_BY_LOOKUP, NOTICED_BY_STATUS, NOTICED_BY_SESSION_START } from '../../../src/persistence/leg-registry.js'
import { SUBAGENT_SUMMARY_KIND } from '../../../src/handoff.js'
import { decodeContent } from '../../../src/persistence/content-codec.js'
import { parseTool, rawAll, mcpOver } from '../world.js'
import { TS_ROOT, tsxArgv } from '../proc.js'
import { sandboxedSpawnEnv, nodeTsArgs, spawnCli, CLI_TS } from '../../helpers/cli-spawn.js'
import { agentConfigPath } from '../install-harness.js'
import { mintTicket, readTicket, TICKET_ENV, type TicketFields } from '../../../src/ticket.js'
import { spawnWorker, DOOR_LINE_PREFIX, DOOR_BUSY_WAIT_MS, NOT_STARTED_EXIT, type WorkerRunResult } from '../../../src/ticket-door.js'
import {
  momentText, PROMPT_HEADING, STATE_NOT_HISTORY_LINE, sendBackReason, invalidInstructionsMessage,
} from '../../../src/first-moment.js'
import { FIRST_MOMENT_KIND, SEND_BACK_KIND, CHECKPOINT_KIND } from '../../../src/run-kinds.js'
import { keyLookupReply, type KeyLookup } from '../../../src/key-lookup.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import {
  type RunWorld, openRunWorld, sessionStartHook, sleeper, killAndReap, localMoment, rawOne, rawRegistration, stringSteps, liveProcess,
  seedCheckpoints, cpLabel, rawCheckpoints, rawContentOf, rawRowOf,
} from '../run-world.js'

// ── journal-workers ─────────────────────────────────────────────────────
//
// The registry half of the ticket door (D288, D293, D294, D297, D317): a
// worker's registration carries what its ticket declared and what the
// door read of its process, its parent linked by id when a hook
// registered that parent and carried as declared when none did, and a
// worker whose process is gone is retired as a phantom by the next reader
// of the registry on its host.
//
// A worker in these registry scenarios is registered through
// registerWorker, the library call a spawner holding the ticket registers
// through; the ticket door itself (the ticket read from the environment,
// the `treecontext run` wrapper, the first message and the send-back) is
// bound further down, through real worker processes.
// Liveness is read from this host's real operating system: a worker's
// process is a real child process this test starts, kills and reaps, and
// the start moment is what the OS reports for it; the scenario's process
// number and clock times are stand-ins for whatever the OS hands out, so
// the bindings use the real child's number and a start moment that is,
// or is not, the real one. Every Then reads the store file through a
// separate read-only handle, the harness's lookup, or the status tool.

export type WorkersWorld = RunWorld

const RUN = 'r1'

/** A Codex-or-Antigravity-shaped ticket the spawner holds (D288, D294). */
function ticketFor(parent: { id: string; branch?: string | null }, extra: { mintedAt?: number; canWrite?: boolean | null } = {}) {
  return {
    parent: { id: parent.id, cli: 'codex', cwd: '/work/app', worktree: null, branch: parent.branch ?? null },
    run: RUN, key: 'login-form', role: 'builder', checkpointer: 'reviewer', checkpointedBy: 'builder',
    mintedAt: extra.mintedAt ?? Date.now() / 1000 - 5,
    ...(extra.canWrite !== undefined ? { canWrite: extra.canWrite } : {}),
  }
}

/** A sandboxed home and a real git repository on `branch`, its store
 *  where the production resolve chain derives it (asked of the real
 *  resolver in a subprocess under the sandbox's home), and the session
 *  started there by the real SessionStart hook. */
async function openGitSession(w: WorkersWorld, sessionId: string, branch: string): Promise<void> {
  w.home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-workers-home-')))
  w.defer(() => rmSync(w.home!, { recursive: true, force: true }))
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-workers-repo-')))
  w.defer(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q', '-b', branch, repo], { env })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env })
  w.proj = repo
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'resolve-driver.ts'), repo), {
    env: sandboxedSpawnEnv(w.home, { TREECONTEXT_BINDINGS_FILE: join(w.home, '.treecontext', 'bindings.json') }),
    cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  expect(r.status, r.stderr).toBe(0)
  const { storeName } = JSON.parse(r.stdout) as { storeName: string }
  w.dbPath = join(storesDirIn(w.home), storeName, 'treecontext.db')
  w.sessionId = sessionId
  w.legs = {}; w.cps = {}; w.ids = {}; w.moments = {}; w.lookups = {}; w.stops = {}; w.before = {}; w.facts = {}; w.children = []
  sessionStartHook(w)
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath)), ownsDatabase: true })
  w.defer(() => store.close())
  w.store = store
}

/** A worker of the run registered through the library door, its process
 *  as the door read it. */
async function registerWorker(w: WorkersWorld, name: string, proc: { pid: number | null; start: number | null; host: string; token?: string | null }): Promise<void> {
  const leg = await w.store!.registerWorker({ door: 'library', ticket: ticketFor({ id: 'p1' }), process: proc })
  w.legs![name] = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
}

function lookup(w: WorkersWorld): void {
  w.lookups![RUN] = w.store!.lookupKey({ run: RUN, key: 'login-form' })
}

const READERS: Record<string, string> = {
  "harness's lookup": NOTICED_BY_LOOKUP,
  'status call': NOTICED_BY_STATUS,
  'session-start hook': NOTICED_BY_SESSION_START,
}

export const workersDefiner = (reg: Registry<WorkersWorld>): void => {
  const define = stringSteps(reg)
  ticketDoorSteps(define)

  // ── D294: the parent as declared, or as a hook registered it ──

  define(/^a Codex main session "([^"]+)" that never spoke to the store$/, async (w, parent) => {
    await openRunWorld(w, { sessionStart: false })
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', parent)).toHaveLength(0)
  })

  define(/^two workers start with tickets naming the parent "([^"]+)", one declaring the branch "([^"]+)" and the other the branch "([^"]+)"$/, async (w, parent, a, b) => {
    for (const [name, branch, minted] of [['first', a, 100], ['second', b, 200]] as const) {
      const at = Date.now() / 1000
      const leg = await w.store!.registerWorker({
        door: 'library', ticket: ticketFor({ id: parent, branch }, { mintedAt: at - minted }), process: liveProcess(),
      })
      w.legs![name] = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
      w.moments![`${name}-minted`] = at - minted
      w.facts![`${name}-branch`] = branch
      // Each writes into its own lane.
      await w.store!.insert(`note from the ${name} worker: wired the ${branch} branch's form`, { leg: w.legs![name]! })
    }
  })

  define(/^the store holds no registration for "([^"]+)" and no row in any lane with the writer or the session "\1"$/, (w, parent) => {
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', parent)).toHaveLength(0)
    expect(rawAll(w,
      `SELECT 1 FROM nodes WHERE session_key = ? OR json_extract(metadata_json, '$._writer') = ?
          OR json_extract(metadata_json, '$._cc_session_id') = ? OR json_extract(metadata_json, '$.session_id') = ?`,
      parent, parent, parent, parent)).toHaveLength(0)
    // The workers' rows are there, in their own lanes, naming the parent as declared.
    const notes = rawAll<{ session_key: string; p: string; src: string }>(w,
      "SELECT session_key, json_extract(metadata_json, '$._parent') AS p, json_extract(metadata_json, '$._parent_src') AS src FROM nodes WHERE content LIKE 'note from the %'")
    expect(notes.map((n) => [n.p, n.src])).toEqual([[parent, 'declared'], [parent, 'declared']])
    expect(new Set(notes.map((n) => n.session_key)).size).toBe(2)
  })

  define(/^each worker's registration carries the parent id "([^"]+)", its CLI, directory, worktree and branch as its own ticket declared, marked declared, with the ticket's mint moment$/, (w, parent) => {
    for (const name of ['first', 'second']) {
      const r = rawRegistration(w, w.legs![name]!)
      expect([r['parent_session'], r['parent_src'], r['identity']]).toEqual([parent, 'declared', 'declared'])
      expect(JSON.parse(String(r['parent_declared']))).toEqual({ id: parent, cli: 'codex', cwd: '/work/app', worktree: null, branch: w.facts![`${name}-branch`] })
      expect(r['ticket_minted_at']).toBe(w.moments![`${name}-minted`])
    }
  })

  define(/^a reader grouping workers by declared parent sees both under "([^"]+)" with their two branches, unreconciled$/, (w, parent) => {
    const groups = rawAll<{ parent: string; n: number; branches: string }>(w,
      `SELECT parent_session AS parent, COUNT(*) AS n, group_concat(json_extract(parent_declared, '$.branch'), ',') AS branches
         FROM session_registry WHERE kind = 'worker' AND parent_src = 'declared' GROUP BY parent_session`)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.parent).toBe(parent)
    expect(groups[0]!.n).toBe(2)
    expect(groups[0]!.branches.split(',').sort()).toEqual([w.facts!['first-branch'], w.facts!['second-branch']].sort())
    expect(w.store!.workersOfParent(parent).map((l) => l.parentDeclared?.branch).sort()).toEqual(groups[0]!.branches.split(',').sort())
  })

  define(/^a Claude Code session "([^"]+)" registered by its session-start hook on the branch "([^"]+)"$/, async (w, parent, branch) => {
    await openGitSession(w, parent, branch)
    const self = rawOne<Record<string, unknown>>(w, "SELECT * FROM session_registry WHERE session_id = ? AND agent_id = ''", parent)
    expect(self?.['branch']).toBe(branch)
    w.facts!['parent-branch'] = branch
  })

  define(/^a worker starts with a ticket naming the parent "([^"]+)"$/, async (w, parent) => {
    // The ticket declares a branch of its own; a registered parent is
    // linked, so the declaration is not copied.
    const leg = await w.store!.registerWorker({
      door: 'library', ticket: ticketFor({ id: parent, branch: 'what-the-ticket-said' }), process: liveProcess(),
    })
    w.legs!['worker'] = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  })

  define(/^the worker's registration links the parent by the id "([^"]+)"$/, (w, parent) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['parent_session'], r['parent_src']]).toEqual([parent, 'hook'])
  })

  define(/^the parent's branch is read from the parent's own registration, not stored again on the worker's$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    // What the ticket declared is kept as the ticket wrote it, a
    // description (D294); the parent's own branch is nowhere on the
    // worker's row: it is read through the link.
    expect(JSON.parse(String(r['parent_declared']))).toEqual({ id: 'p1', cli: 'codex', cwd: '/work/app', worktree: null, branch: 'what-the-ticket-said' })
    expect(Object.values(r)).not.toContain(w.facts!['parent-branch'])
    const joined = rawOne<{ branch: string }>(w,
      "SELECT p.branch AS branch FROM session_registry k JOIN session_registry p ON p.session_id = k.parent_session AND p.agent_id = '' WHERE k.session_id = ? AND k.agent_id = ?",
      w.legs!['worker']!.sessionId, w.legs!['worker']!.agentId)
    expect(joined?.branch).toBe(w.facts!['parent-branch'])
  })

  // ── D293: a writer no hook registered, through either door ──
  //
  // Through the library call, the process writes with the role and parent
  // it declares; through the ticket door, a real process holding a ticket
  // it minted for itself claims it (claimTicket, with no wrapper) and
  // writes as the leg the door registered, the ticket read like any other.

  define(/^a process the store never registered, that declares the role "([^"]+)" and the parent "([^"]+)" through the (library call|ticket door, with a self-minted ticket)$/, async (w, role, parent, door) => {
    await openRunWorld(w, { sessionStart: false })
    // Where the process runs: a linked worktree of a real repository, on
    // its own branch, which the library door reads for the trace.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-declared-')))
    w.defer(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env })
    const wt = join(root, 'login-wt')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'login', wt], { cwd: repo, env })
    expect(rawAll(w, 'SELECT 1 FROM session_registry')).toHaveLength(0)
    w.facts!['declared'] = { role, parent, cwd: realpathSync.native(wt), door: door === 'library call' ? 'library' : 'ticket' }
  })

  define(/^that process inserts the note "([^"]+)"$/, async (w, text) => {
    const d = w.facts!['declared'] as { role: string; parent: string; cwd: string; door: 'library' | 'ticket' }
    w.moments!['before'] = Date.now() / 1000
    if (d.door === 'library') {
      const r = await w.store!.insert(text, { declared: { role: d.role, parent: d.parent, cwd: d.cwd } })
      expect(r.deduplicated).toBe(false)
      w.ids!['note'] = r.nodeId
    } else {
      // A real process, in the worktree, with its self-minted ticket in its
      // environment and no door around it.
      const ticket = mintTicket({ run: 'own-run', key: 'own-key', role: d.role, parent: { id: d.parent } })
      const o = await runWorker(w, { spawner: 'none', ticket, prompt: '', plan: { first: { texts: [text] } }, cwd: d.cwd })
      expect(o.exitCode).toBe(0)
      w.ids!['note'] = rawOne<{ id: string }>(w, 'SELECT node_id AS id FROM nodes WHERE session_key = ? AND CAST(content AS TEXT) = ?', o.sessionId, text)!.id
    }
    w.moments!['after'] = Date.now() / 1000
  })

  define(/^a reader of the row sees it stored, with when it was written, the directory, worktree and branch the door could read, the (library call|ticket door, with a self-minted ticket) as the door that wrote it, that its identity was declared by the writer and not registered by a hook, the writer stamp "([^"]+)", the declared parent "([^"]+)", and the note's text$/, (w, door, writer, parent) => {
    const d = w.facts!['declared'] as { cwd: string }
    const via = door === 'library call' ? 'library' : 'ticket'
    const row = rawOne<{ created_at: number; c: Buffer | string; m: string }>(w, 'SELECT created_at, content AS c, metadata_json AS m FROM nodes WHERE node_id = ?', w.ids!['note'])
    expect(row, 'the row is stored, never refused').toBeTruthy()
    const m = JSON.parse(row!.m) as Record<string, unknown>
    expect(row!.created_at).toBeGreaterThanOrEqual(w.moments!['before']!)
    expect(row!.created_at).toBeLessThanOrEqual(w.moments!['after']!)
    expect([m['_cwd'], m['_worktree'], m['_branch']]).toEqual([d.cwd, 'login-wt', 'login'])
    expect([m['_door'], m['_identity'], m['_writer_src']]).toEqual([via, 'declared', 'declared'])
    expect([m['_writer'], m['_parent'], m['_parent_src']]).toEqual([writer, parent, 'declared'])
    expect(decodeContent(row!.c)).toBe('state: all tests pass')
    // No registration was minted for its parent; through the library none
    // for the writer either, and through the ticket door the one the door
    // registers for any worker, its identity declared, never a hook's.
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', parent)).toHaveLength(0)
    expect(rawAll<{ kind: string; identity: string; door: string }>(w, 'SELECT kind, identity, door FROM session_registry'))
      .toEqual(via === 'library' ? [] : [{ kind: 'worker', identity: 'declared', door: 'ticket' }])
  })

  // ── D294, D297, D317: what the registration carries ──

  define(/^a ticket minted at (\d\d:\d\d:\d\d) naming the parent "([^"]+)", the run "([^"]+)", the key "([^"]+)", the role "([^"]+)", the reviewer as the one who will checkpoint, and that the worker has a way to write$/, async (w, minted, parent, run, key, role) => {
    await openRunWorld(w, { sessionStart: false })
    w.facts!['ticket'] = {
      parent: { id: parent }, run, key, role, checkpointer: 'reviewer', mintedAt: localMoment(minted), canWrite: true,
    }
  })

  define(/^a `codex exec` worker starts with that ticket on the host "([^"]+)" as the process (\d+) started at (\d\d:\d\d:\d\d)$/, async (w, host, pid, started) => {
    const leg = await w.store!.registerWorker({
      door: 'library', ticket: w.facts!['ticket'] as Parameters<FlatStore['registerWorker']>[0]['ticket'],
      process: { pid: Number(pid), start: localMoment(started), host },
    })
    w.legs!['worker'] = { sessionId: leg.sessionId, agentId: WORKER_AGENT_ID }
  })

  define(/^a reader of the registration sees the parent "([^"]+)", the run "([^"]+)", the key "([^"]+)", the role "([^"]+)", the checkpointer "([^"]+)", the door declared, the mint moment (\d\d:\d\d:\d\d), the host "([^"]+)", the process id (\d+) and the start moment (\d\d:\d\d:\d\d)$/, (w, parent, run, key, role, checkpointer, minted, host, pid, started) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['parent_session'], r['run'], r['run_key'], r['agent_type'], r['checkpointer']]).toEqual([parent, run, key, role, checkpointer])
    expect(r['can_write']).toBe(1)
    expect(r['ticket_minted_at']).toBe(localMoment(minted))
    expect([r['host'], r['pid'], r['proc_start']]).toEqual([host, Number(pid), localMoment(started)])
    expect(JSON.parse(String(r['processes']))).toEqual([{ pid: Number(pid), start: localMoment(started), token: null, host, at: r['started_at'] }])
  })

  // ── D297, D317: phantoms ──

  define(/^a worker registration under the key "([^"]+)" whose process on this host has exited, with nothing having retired it$/, async (w, key) => {
    expect(key).toBe('login-form')
    await openRunWorld(w)
    const child = sleeper(w)
    const start = hostProbe.startMoment(child.pid!)
    await registerWorker(w, 'worker', { pid: child.pid!, start, token: hostProbe.startToken?.(child.pid!) ?? null, host: hostname() })
    await killAndReap(child)
    expect(hostProbe.exists(child.pid!)).toBe(false)
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['stopped_at']]).toEqual([null, null])
  })

  define(/^the (harness's lookup|status call|session-start hook) next reads the registry on this host$/, async (w, reader) => {
    w.moments!['before-read'] = Date.now() / 1000
    if (reader === "harness's lookup") lookup(w)
    else if (reader === 'status call') {
      await mcpOver(w, { ccSessionId: w.sessionId! })
      w.facts!['status'] = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
    } else sessionStartHook(w, 'resume')
    w.moments!['after-read'] = Date.now() / 1000
    w.facts!['reader'] = reader
  })

  define(/^the worker's registration reads retired as a phantom, with the moment it was noticed and the (harness's lookup|status call|session-start hook) as what noticed it$/, (w, reader) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['noticed_by']]).toEqual(['phantom', READERS[reader]])
    expect(r['noticed_at'] as number).toBeGreaterThanOrEqual(w.moments!['before-read']! - 1)
    expect(r['noticed_at'] as number).toBeLessThanOrEqual(w.moments!['after-read']! + 1)
    if (reader === 'status call') {
      const workers = (w.facts!['status'] as Record<string, unknown>)['workers'] as Record<string, unknown>
      expect((workers['retired_as_phantoms'] as Array<Record<string, unknown>>).map((p) => p['session_id'])).toEqual([w.legs!['worker']!.sessionId])
    }
  })

  define(/^the registration carries no guessed exit time, no checkpoint and no summary row$/, (w) => {
    const ref = w.legs!['worker']!
    expect(rawRegistration(w, ref)['stopped_at']).toBeNull()
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') IN ('checkpoint', ?)", ref.sessionId, SUBAGENT_SUMMARY_KIND)).toHaveLength(0)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'checkpoint'")).toHaveLength(0)
  })

  // "This host" is whatever host the suite runs on; the sentence's name
  // for it stands for that.
  define(/^a worker registration under the key "([^"]+)" whose host is "([^"]+)" and this host is "(?:[^"]+)"$/, async (w, key, there) => {
    expect(key).toBe('login-form')
    expect(hostname()).not.toBe(there)
    await openRunWorld(w, { sessionStart: false })
    // A process number that, on THIS host, belongs to a live process: were
    // the host ignored, the pass could not tell; it must not even look.
    await registerWorker(w, 'worker', { pid: 1, start: 0, host: there })
  })

  define(/^the harness(?: on "[^"]+")? looks up the key "([^"]+)"$/, (w, key) => {
    expect(key).toBe('login-form')
    lookup(w)
  })

  define(/^the worker's registration still reads live$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['stopped_at'], r['noticed_at']]).toEqual([null, null, null])
    expect(w.lookups![RUN]!.legs.find((l) => l.sessionId === w.legs!['worker']!.sessionId)?.state).toBe('live')
  })

  define(/^the reply says the worker on "([^"]+)" cannot be checked from here$/, (w, there) => {
    const notes = w.lookups![RUN]!.notes
    expect(notes.some((n) => n.includes(`"${there}"`) && n.includes('cannot be checked from here'))).toBe(true)
  })

  define(/^a worker registration under the key "([^"]+)" carrying the process id (\d+) and the start moment (\d\d:\d\d:\d\d) on this host$/, async (w, key, _pid, started) => {
    expect(key).toBe('login-form')
    await openRunWorld(w, { sessionStart: false })
    // Registered by the next step, once the process holding the number is
    // known: the start moment it carries is this one.
    w.facts!['registered-start'] = localMoment(started)
  })

  // The number and the moment are the OS's: a real process holds the
  // number the registration carries, started at a moment other than the
  // one the registration carries.
  define(/^a different process now holding the id (?:\d+) that started at (?:\d\d:\d\d:\d\d)$/, async (w) => {
    const child = sleeper(w)
    const actual = hostProbe.startMoment(child.pid!)
    expect(actual, 'this host reads process start moments').not.toBeNull()
    const registered = w.facts!['registered-start'] as number
    expect(Math.abs(actual! - registered)).toBeGreaterThan(60)
    // Where the host has an exact start token, the registration's is the
    // same boot's, an hour of ticks earlier: the worker it describes
    // started then.
    const now = hostProbe.startToken?.(child.pid!) ?? null
    const token = now === null ? null : now.replace(/:(\d+)$/, (_m, t: string) => `:${Number(t) - 360000}`)
    await registerWorker(w, 'worker', { pid: child.pid!, start: registered, token, host: hostname() })
  })

  define(/^the process (?:\d+) that started at (?:\d\d:\d\d:\d\d) still running$/, async (w) => {
    const child = sleeper(w)
    const actual = hostProbe.startMoment(child.pid!)
    expect(actual, 'this host reads process start moments').not.toBeNull()
    // The registration carries the start moment the OS reports for it.
    await registerWorker(w, 'worker', { pid: child.pid!, start: actual, token: hostProbe.startToken?.(child.pid!) ?? null, host: hostname() })
  })

  define(/^the worker's registration reads retired as a phantom$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['noticed_by'], r['stopped_at']]).toEqual(['phantom', NOTICED_BY_LOOKUP, null])
    expect(hostProbe.exists(r['pid'] as number)).toBe(true)
  })

  define(/^a worker registration under the key "([^"]+)" carrying the process id (?:\d+) and no start moment, on a host where the start moment could not be read$/, async (w, key) => {
    expect(key).toBe('login-form')
    await openRunWorld(w, { sessionStart: false })
  })

  define(/^a process holding the id (?:\d+)$/, async (w) => {
    const child = sleeper(w)
    await registerWorker(w, 'worker', { pid: child.pid!, start: null, host: hostname() })
  })

  define(/^the reply says the worker cannot be told from a successor that took its number$/, (w) => {
    expect(w.lookups![RUN]!.notes.some((n) => n.includes('cannot be told from a successor that took its number'))).toBe(true)
  })
}

// ── The ticket door (unit 3 of the beta.3 build) ────────────────────────
//
// D288, D291, D292, D293, D298, D303, D307, D313, D315, D316, D329, D332,
// D335, D340, D341, D342: every worker here is a real process started
// through the real door, the library's spawnWorker in this process or the
// real `treecontext run` wrapper in a subprocess under the sandboxed home,
// and the process it starts is the stand-in headless worker
// (tests/helpers/standin-worker.ts): the CLI the scenario names is what the
// stand-in stands in for, since the model inside a real worker is out of
// reach (the feature's Background). Every outcome is read from the door's
// output (the wrapper's stdout, its one line on stderr, its exit code, the
// library's result), from what the stand-in recorded it was given, or from
// the store file through a separate read-only handle.

const STANDIN = join(TS_ROOT, 'tests', 'helpers', 'standin-worker.ts')

interface StandinStep {
  notes?: number; label?: string; texts?: string[]; checkpoint?: string; invalidRow?: boolean; print?: string
  exit?: number | 'hang'; waitFor?: string; at?: number; viaTools?: boolean
}
export interface StandinPlan { first: StandinStep; rerun?: StandinStep }
interface StandinRecord {
  pid: number; start: number | null; rerun: boolean; stdin: string; argv: string[]; ticket: string | null; lane: string | null
  claimed: boolean; session: string | null; laneRowsSeen: number; firstRunNotesSeen: number; firstMessage: string | null
}

/** What spawns the worker: the wrapper, the library call, or nothing (a
 *  process that holds its ticket and claims it itself). */
export type Spawner = 'wrapper' | 'library' | 'none'

export interface WorkerSpec {
  spawner: Spawner
  /** The ticket: fields (minted by the wrapper's flags or by the library
   *  call) or its text as the spawner put it in the environment. */
  ticket: TicketFields | string
  prompt: string
  plan: StandinPlan
  timeoutSecs?: number
  checkTicket?: boolean
  /** How the leg is expected to read once ended (for the lookup's Then). */
  expectEnd?: 'retired' | 'phantom' | 'cut'
  cwd?: string
  /** The door's clock (the library call's), for a run replayed at its
   *  own moments. */
  clock?: () => number
}

export interface Outcome {
  spawner: Spawner
  stdout: string
  stderr: string
  line: string
  exitCode: number | null
  elapsedMs: number
  sessionId: string | null
  log: StandinRecord[]
  logPath: string
  result: WorkerRunResult | null
}

const specOf = (w: WorkersWorld): WorkerSpec => {
  const s = w.facts!['spec'] as WorkerSpec | undefined
  expect(s, 'a worker spec from the Given').toBeTruthy()
  return s!
}
const outOf = (w: WorkersWorld, name = 'worker'): Outcome => {
  const o = w.facts![`out:${name}`] as Outcome | undefined
  expect(o, `the door's outcome for ${name}`).toBeTruthy()
  return o!
}

/** The ticket of the run's worker under a key, as a harness mints it. */
function ticketFields(w: WorkersWorld, o: Partial<TicketFields> & { role?: string }): TicketFields {
  return {
    run: RUN, key: 'login-form', role: 'builder', parent: { id: w.sessionId ?? 'p1', cli: 'claude-code' },
    ...o,
  } as TicketFields
}

/** The wrapper's ticket flags for minted fields. */
function ticketFlags(t: TicketFields): string[] {
  const out = ['--run', t.run, '--role', t.role, '--parent', t.parent.id]
  if (t.noKey) out.push('--no-key')
  else out.push('--key', t.key!)
  if (t.checkpointer) out.push('--checkpointer', t.checkpointer)
  if (t.checkpointedBy) out.push('--checkpointed-by', t.checkpointedBy)
  if (t.parent.cli) out.push('--parent-cli', t.parent.cli)
  if (t.canWrite === true) out.push('--door')
  if (t.canWrite === false) out.push('--no-door')
  return out
}

let standinRuns = 0

/** Run a worker through its spawner's door to its end. `during` runs
 *  while it is alive (the library's promise or the wrapper's process). */
export async function runWorker(w: RunWorld, spec: WorkerSpec, name = 'worker', during?: () => Promise<void>): Promise<Outcome> {
  const logPath = join(w.home!, `standin-${++standinRuns}.jsonl`)
  const standinEnv = { STANDIN_DB: w.dbPath!, STANDIN_LOG: logPath, STANDIN_PLAN: JSON.stringify(spec.plan) }
  const sandbox = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'), ...standinEnv })
  const cwd = spec.cwd ?? w.proj!
  const t0 = Date.now()
  let out: Omit<Outcome, 'log' | 'sessionId' | 'logPath' | 'elapsedMs'>
  if (spec.spawner === 'library') {
    const p = spawnWorker({
      store: w.store!, ticket: spec.ticket, prompt: spec.prompt, command: process.execPath, args: nodeTsArgs(STANDIN), cwd,
      env: sandbox, ...(spec.timeoutSecs ? { timeoutMs: spec.timeoutSecs * 1000 } : {}),
      ...(spec.checkTicket ? { checkTicket: true, spawner: { sessionId: w.sessionId! } } : {}),
      ...(spec.clock ? { clock: spec.clock } : {}),
    })
    await during?.()
    const result = await p
    out = { spawner: 'library', stdout: result.output, stderr: '', line: result.line, exitCode: result.exitCode, result }
  } else {
    const raw = typeof spec.ticket === 'string' ? spec.ticket : mintTicket(spec.ticket)
    let args: string[]
    let env: NodeJS.ProcessEnv = sandbox
    if (spec.spawner === 'none') {
      // No door at all: the worker holds its ticket and claims it itself.
      args = nodeTsArgs(STANDIN)
      env = { ...sandbox, [TICKET_ENV]: raw }
    } else {
      const promptFile = join(w.home!, `prompt-${standinRuns}.txt`)
      writeFileSync(promptFile, spec.prompt)
      // Fields are minted by the wrapper's flags; a ticket given as text
      // sits in the wrapper's environment, where its spawner put it.
      const ticketArgs = typeof spec.ticket === 'string' ? [] : ticketFlags(spec.ticket)
      if (typeof spec.ticket === 'string') env = { ...sandbox, [TICKET_ENV]: spec.ticket }
      args = nodeTsArgs(CLI_TS, [
        'run', ...ticketArgs, '--prompt-file', promptFile,
        ...(spec.timeoutSecs ? ['--timeout', String(spec.timeoutSecs)] : []),
        ...(spec.checkTicket ? ['--check-ticket'] : []),
        '--', process.execPath, ...nodeTsArgs(STANDIN),
      ])
    }
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    w.defer(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { stderr += c.toString() })
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
    await during?.()
    const exitCode = await exited
    const line = stderr.split('\n').filter((l) => l.startsWith(DOOR_LINE_PREFIX)).at(-1) ?? ''
    out = { spawner: spec.spawner, stdout, stderr, line, exitCode, result: null }
  }
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as StandinRecord) : []
  const sessionId = out.result?.sessionId ?? log[0]?.session ?? /\(session ([^,)]+)/.exec(out.line)?.[1] ?? null
  const full: Outcome = { ...out, log, logPath, sessionId, elapsedMs: Date.now() - t0 }
  w.facts![`out:${name}`] = full
  if (sessionId) w.legs![name] = { sessionId, agentId: WORKER_AGENT_ID }
  return full
}

/** The rows of a worker's lane, oldest first, straight from the file. */
function laneRows(w: WorkersWorld, sessionId: string): Array<{ node_id: string; created_at: number; kind: string | null; content: string; m: Record<string, unknown> }> {
  return rawAll<{ node_id: string; created_at: number; c: Buffer | string; m: string }>(w,
    'SELECT node_id, created_at, content AS c, metadata_json AS m FROM nodes WHERE session_key = ? ORDER BY created_at, rowid', sessionId)
    .map((r) => {
      const m = JSON.parse(r.m) as Record<string, unknown>
      return { node_id: r.node_id, created_at: r.created_at, kind: (m['kind'] as string | undefined) ?? null, content: decodeContent(r.c), m }
    })
}

/** The first message the worker was given, as it recorded receiving it. */
function firstMessageOf(w: WorkersWorld, name = 'worker'): string {
  const o = outOf(w, name)
  expect(o.log.length, 'the worker recorded what it was given').toBeGreaterThan(0)
  return o.log[0]!.stdin
}

/** Each part found in the message, in this order. */
function inOrder(message: string, parts: string[]): void {
  let from = 0
  for (const p of parts) {
    const at = message.indexOf(p, from)
    expect(at, `"${p.slice(0, 80)}" after offset ${from} in the first message:\n${message}`).toBeGreaterThanOrEqual(0)
    from = at + p.length
  }
}

function harnessLookup(w: WorkersWorld, key = 'login-form', run = RUN): KeyLookup {
  const l = w.store!.lookupKey({ run, key })
  w.lookups![run] = l
  return l
}

/** A real lock another process holds on the store: the whole store
 *  (store-locker.cjs, which needs every other connection let go first),
 *  or its writes alone (store-write-locker.cjs, readers left reading). */
async function lockStore(w: WorkersWorld, what: 'whole' | 'writes' = 'whole'): Promise<ChildProcess> {
  const helper = what === 'whole' ? 'store-locker.cjs' : 'store-write-locker.cjs'
  const locker = spawn(process.execPath, [join(TS_ROOT, 'tests', 'helpers', helper), w.dbPath!], { stdio: ['ignore', 'pipe', 'inherit'] })
  w.defer(() => { try { locker.kill('SIGKILL') } catch { /* gone */ } })
  let seen = ''
  await new Promise<void>((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error(`the locker never locked: ${seen}`)), 20_000)
    locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
    locker.once('exit', (code) => { clearTimeout(bail); reject(new Error(`the locker exited ${code}: ${seen}`)) })
  })
  return locker
}

async function waitForFile(path: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const WORKER_CLI = /`(codex exec|claude -p|agy -p)`/.source

/** Codex's session start, as the install writes it and Codex runs it: the
 *  install's verbatim copy of the Claude Code block in ~/.codex/hooks.json,
 *  its SessionStart command run through a shell with the hook payload on
 *  stdin. The script it execs is the install's, pointed at this checkout's
 *  source (its interpreter and module pins, the rest untouched), as the
 *  sh-dispatch test points it. */
function runCodexSessionStart(w: WorkersWorld, session: string): void {
  mkdirSync(dirname(agentConfigPath('codex', w.home!)), { recursive: true })
  const install = spawnCli(['install', '--yes', '--agent', 'codex', '--experimental-capture'], { home: w.home!, cwd: w.proj! })
  expect(install.status, install.out).toBe(0)
  const copy = JSON.parse(readFileSync(join(dirname(agentConfigPath('codex', w.home!)), 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  }
  const groups = copy.hooks['SessionStart'] ?? []
  const command = (groups.find((g) => g.matcher === undefined || g.matcher === '' || /startup/.test(g.matcher)) ?? groups[0])
    ?.hooks.find((h) => h.command.includes('tc-session-start'))?.command
  expect(command, 'the Codex copy has a session-start command').toBeTruthy()
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const env = sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') })
  let r: ReturnType<typeof spawnSync>
  const payload = JSON.stringify({ session_id: session, cwd: w.proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: join(w.proj!, 'transcript.jsonl') })
  if (process.platform !== 'win32') {
    const wrapper = join(w.home!, '.claude', 'hooks', 'tc-session-start')
    const shim = join(w.home!, 'node-tsx')
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --import "${loader}" "$@"\n`)
    chmodSync(shim, 0o755)
    const body = readFileSync(wrapper, 'utf8').replace(/^TC_NODE=.*$/m, `TC_NODE="${shim}"`).replace(/^TC_CLI=.*$/m, `TC_CLI="${CLI_TS}"`)
    expect(body).toMatch(/exec "\$TC_NODE" "\$TC_CLI" hook session-start/)
    writeFileSync(wrapper, body)
    r = spawnSync('/bin/sh', ['-c', command!], { input: payload, env, cwd: w.proj, encoding: 'utf8', timeout: 30_000 })
  } else {
    const wrapper = join(w.home!, '.claude', 'hooks', 'tc-session-start.cmd')
    const body = readFileSync(wrapper, 'utf8').replace('"%TC_NODE%" "%TC_CLI%"', `"${process.execPath}" --import "${loader}" "${CLI_TS}"`)
    writeFileSync(wrapper, body)
    r = spawnSync(command!, { input: payload, env, cwd: w.proj, encoding: 'utf8', timeout: 30_000, shell: true })
  }
  expect(r.status, String(r.stderr)).toBe(0)
}

export function ticketDoorSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  // ── D288: a worker writes into its own lane, its role as writer ──

  // The parent's session start, through the hook its CLI runs: Claude
  // Code's own session-start hook, or the verbatim copy of the Claude Code
  // block `treecontext install --experimental-capture --agent codex` writes
  // into Codex's hooks.json, run as Codex runs it (its command, through a
  // shell, the same JSON on stdin). The Antigravity row is not bound: this
  // build writes no hooks for Antigravity (an archived-build platform, MCP
  // config only), so there is no hook of its to register a parent through.
  define(/^an? (Claude Code|Codex) session registered as the parent "([^"]+)"$/, async (w, cli, parent) => {
    await openRunWorld(w, { sessionStart: false })
    w.sessionId = parent
    if (cli === 'Claude Code') sessionStartHook(w)
    else runCodexSessionStart(w, parent)
    expect(rawOne(w, "SELECT 1 AS one FROM session_registry WHERE session_id = ? AND agent_id = ''", parent)).toBeTruthy()
    w.facts!['parent-cli'] = cli === 'Codex' ? 'codex' : 'claude-code'
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started with a ticket naming the parent "([^"]+)", the run "([^"]+)", the key "([^"]+)", the role "([^"]+)" and the reviewer as the one who will checkpoint$`), (w, _cli, parent, run, key, role) => {
    w.facts!['spec'] = {
      spawner: 'library', prompt: 'wire the submit button',
      ticket: { run, key, role, checkpointer: 'reviewer', parent: { id: parent, cli: w.facts!['parent-cli'] as string } },
      plan: { first: {} },
    } satisfies WorkerSpec
  })

  define(/^the worker inserts (\d+) notes and exits$/, async (w, n) => {
    const spec = specOf(w)
    // Through its tools: a real `treecontext serve` inside the worker, the
    // way a worker's CLI writes (the library path is unit-tested beside).
    spec.plan.first.notes = Number(n)
    spec.plan.first.viaTools = true
    await runWorker(w, spec)
  })

  define(/^every row the worker wrote sits in the worker's own lane, stamped with the writer "([^"]+)" and the parent session "([^"]+)"$/, (w, writer, parent) => {
    const o = outOf(w)
    const notes = rawAll<{ session_key: string; m: string }>(w, "SELECT session_key, metadata_json AS m FROM nodes WHERE CAST(content AS TEXT) LIKE 'first run note %'")
    expect(notes).toHaveLength(3)
    for (const r of notes) {
      const m = JSON.parse(r.m) as Record<string, unknown>
      expect([r.session_key, m['_writer'], m['_writer_src'], m['_parent'], m['_parent_src'], m['_door'], m['_identity']])
        .toEqual([o.sessionId, writer, 'declared', parent, 'hook', 'tools', 'declared'])
      // Where the door read the worker runs (D293): its directory.
      expect(m['_cwd']).toBe(w.proj)
    }
    // The lane is the worker's own session, never the parent's, and every
    // row in it carries the worker's role and the parent.
    expect(o.sessionId).not.toBe(parent)
    for (const r of laneRows(w, o.sessionId!)) expect([r.m['_writer'], r.m['_parent']]).toEqual([writer, parent])
  })

  define(/^the parent's lane holds none of the worker's (\d+) notes$/, (w, n) => {
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE CAST(content AS TEXT) LIKE 'first run note %'")).toHaveLength(Number(n))
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE session_key = ? AND CAST(content AS TEXT) LIKE 'first run note %'", w.sessionId)).toHaveLength(0)
  })

  // ── D288: retired at exit, its last output the summary row ──

  define(new RegExp(`^an? ${WORKER_CLI} worker with the role "([^"]+)" under the run "([^"]+)" and the key "([^"]+)", whose ticket names the reviewer as the one who will checkpoint$`), async (w, _cli, role, run, key) => {
    await openRunWorld(w)
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { run, key, role, checkpointer: 'reviewer' }), plan: { first: {} } } satisfies WorkerSpec
  })

  define(/^the worker prints "([^"]+)" as its last output and exits$/, async (w, text) => {
    const spec = specOf(w)
    spec.plan.first.print = text
    await runWorker(w, spec)
  })

  define(/^the worker's registration reads retired$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['kind'], r['door'], r['ended']]).toEqual(['worker', 'ticket', 'retired'])
    expect(r['stopped_at']).not.toBeNull()
  })

  define(/^the spawner is handed (?:one line pointing at|a pointer to) (?:a|the) summary row reading "([^"]+)"(?: with the writer "([^"]+)")?$/, (w, text, writer) => {
    const o = outOf(w)
    expect(o.line, 'one line').toMatch(/^treecontext: [^\n]+\.$/)
    const id = /the summary row ([0-9a-f]{32})/.exec(o.line)?.[1]
    expect(id, `a summary row named in: ${o.line}`).toBeTruthy()
    const row = rawOne<{ c: Buffer | string; m: string; session_key: string }>(w, 'SELECT content AS c, metadata_json AS m, session_key FROM nodes WHERE node_id = ?', id)
    const m = JSON.parse(row!.m) as Record<string, unknown>
    expect(decodeContent(row!.c)).toBe(text)
    expect([m['kind'], row!.session_key]).toEqual([SUBAGENT_SUMMARY_KIND, o.sessionId])
    if (writer !== undefined) expect([m['_writer'], o.line.includes(`writer "${writer}"`)]).toEqual([writer, true])
    // The worker's last output also reached its spawner whole (D307).
    expect(o.stdout).toBe(text)
  })

  // ── D298, D313, D315, D329, D332: the first message and first-moment row ──

  define(/^a brief for the builder role under the key "([^"]+)" and checkpoint number 3 under that key, written by the builder role$/, async (w, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the login form, fields and validation', { run: RUN, key, role: 'builder', checkpointer: 'builder', by: 'harness' })).nodeId
    await seedCheckpoints(w, RUN, key, 3, 'builder')
  })

  define(/^a brief for the builder role under the key "([^"]+)" and no checkpoint under that key$/, async (w, key) => {
    await openRunWorld(w)
    w.facts!['key'] = key
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the search box', { run: RUN, key, role: 'builder', checkpointer: 'builder', by: 'harness' })).nodeId
    expect(rawCheckpoints(w, RUN, key)).toHaveLength(0)
  })

  define(/^a brief row and a checkpoint row under the key "([^"]+)"$/, async (w, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the login form', { run: RUN, key, role: 'builder', checkpointer: 'reviewer', by: 'harness' })).nodeId
    await seedCheckpoints(w, RUN, key, 1, 'reviewer')
  })

  define(/^a brief for the builder role naming the builder as the checkpointer of the key "([^"]+)"$/, async (w, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the login form', { run: RUN, key, role: 'builder', checkpointer: 'builder', by: 'harness' })).nodeId
  })

  define(/^the newest checkpoint in effect under the key "([^"]+)" written by the writer "([^"]+)"$/, async (w, key, writer) => {
    await seedCheckpoints(w, RUN, key, 2, 'builder', writer)
    const inEffect = w.store!.checkpointsInEffect(RUN, key)
    expect(inEffect.map((c) => c.writer)).toEqual([writer])
  })

  define(/^a brief for the builder role under the key "([^"]+)" that says nothing about checkpoints$/, async (w, key) => {
    await openRunWorld(w)
    const brief = 'BRIEF: build the login form: email and password fields, submit wired to /api/login'
    // The needle fires on treecontext's own line, which the Then finds.
    expect(STATE_NOT_HISTORY_LINE.toLowerCase(), 'the checkpoint needle is dead').toContain('checkpoint')
    // step-lint: allow unearned-absence -- guarded: the line above proves the needle fires on the state-not-history line
    expect(brief.toLowerCase()).not.toContain('checkpoint')
    w.ids!['brief'] = (await w.store!.writeBrief(brief, { run: RUN, key, role: 'builder', by: 'harness' })).nodeId
  })

  define(/^checkpoint number 4 and checkpoint number 5 both in effect under the key "([^"]+)", and a brief for the reviewer role naming the reviewer as the checkpointer$/, async (w, key) => {
    await openRunWorld(w)
    const [, , three] = await seedCheckpoints(w, RUN, key, 3, 'builder')
    // Two legs started from number 3 and wrote 4 and 5 (D329).
    for (const n of [4, 5]) {
      const r = await w.store!.writeCheckpoint(`STATE ${n}: the form as leg ${n} left it`, { run: RUN, key, supersedes: [three!], declared: { role: 'builder' } })
      expect(r.checkpoint?.number).toBe(n)
      w.cps![cpLabel(RUN, key, n)] = r.nodeId
    }
    expect(w.store!.checkpointsInEffect(RUN, key).map((c) => c.number)).toEqual([4, 5])
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: review the login form and reconcile', { run: RUN, key, role: 'reviewer', checkpointer: 'reviewer', by: 'harness' })).nodeId
  })

  // The ticket door, asked by the library call, starts the worker; the
  // stand-in writes a checkpoint of its own so the leg owes nothing at its
  // exit unless the scenario says otherwise.
  const startByDoor = async (w: WorkersWorld, o: { role: string; prompt: string; spawner?: Spawner; checkpointer?: string | null; plan?: StandinPlan }): Promise<void> => {
    await runWorker(w, {
      spawner: o.spawner ?? 'library', prompt: o.prompt,
      ticket: ticketFields(w, { role: o.role, key: (w.facts!['key'] as string | undefined) ?? 'login-form', ...(o.checkpointer !== null ? { checkpointer: o.checkpointer ?? o.role } : {}) }),
      plan: o.plan ?? { first: { checkpoint: `state: the ${o.role} worker's work as it now stands` } },
    })
  }

  define(new RegExp(`^the ticket door starts an? ${WORKER_CLI} worker with the spawner's prompt "([^"]+)"$`), async (w, _cli, prompt) => {
    // Every search the store can run on anyone's behalf, counted while the
    // door composes and the worker runs: the door's composition is reads
    // of the store's own records, never a query (D298).
    const store = w.store!
    const real = store.query.bind(store)
    let queries = 0
    store.query = async (...args: Parameters<FlatStore['query']>) => { queries++; return real(...args) }
    try {
      await startByDoor(w, { role: 'builder', prompt })
    } finally { store.query = real }
    w.facts!['queries'] = queries
  })

  define(new RegExp(`^the ticket door starts an? ${WORKER_CLI} (builder|reviewer) worker(?: with the spawner's prompt "([^"]+)")?$`), async (w, _cli, role, prompt) => {
    await startByDoor(w, { role: role!, prompt: prompt ?? 'continue the login form' })
  })

  define(/^the ticket door starts a builder worker$/, async (w) => {
    // The ticket names no checkpointer, so the registration takes the
    // brief's, the builder (D281): the worker owes the checkpoint and is
    // sent back once for it; neither run writes one, so the stranger's
    // stays the one in effect for the lookup after.
    await startByDoor(w, { role: 'builder', prompt: 'continue the login form', checkpointer: null, plan: { first: {}, rerun: {} } })
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['checkpointer'], reg['send_backs']]).toEqual(['builder', 1])
  })

  define(new RegExp(`^a worker starts through the hook-less door of a ${WORKER_CLI} worker with the spawner's prompt "([^"]+)"$`), async (w, _cli, prompt) => {
    await startByDoor(w, { role: 'builder', prompt, spawner: 'wrapper', checkpointer: 'reviewer', plan: { first: {} } })
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker starts with an empty spawner's prompt$`), async (w, _cli) => {
    await startByDoor(w, { role: 'builder', prompt: '', spawner: 'wrapper', checkpointer: 'reviewer', plan: { first: {} } })
  })

  define(/^the worker's first message carries the brief, then checkpoint number (\d+) with its writer "([^"]+)" and its moment, then "([^"]+)"$/, (w, num, writer, prompt) => {
    const cp = rawCheckpoints(w, RUN, 'login-form').find((c) => c.n === Number(num))!
    const at = rawOne<{ t: number }>(w, 'SELECT created_at AS t FROM nodes WHERE node_id = ?', cp.node_id)!.t
    inOrder(firstMessageOf(w), [
      'BRIEF: build the login form',
      `Checkpoint number ${num} under "login-form" (row ${cp.node_id}), written by "${writer}" at ${momentText(at)}`,
      rawContentOf(w, cp.node_id),
      `${PROMPT_HEADING}\n${prompt}`,
    ])
  })

  define(/^the door's record shows the first message as the whole of the worker's input and no query issued on the worker's behalf$/, (w) => {
    const o = outOf(w)
    const run = o.result!.runs[0]!
    // The door's record of the worker's input: its stdin, the first
    // message, and its argv, the command alone.
    expect(run.input.stdin).toBe(o.result!.firstMessage)
    expect(run.input.argv).toEqual(nodeTsArgs(STANDIN))
    expect(o.log[0]!.stdin).toBe(run.input.stdin)
    expect(o.log[0]!.argv).toEqual([])
    // When the worker started, the door had written one row in its lane,
    // the first moment, and nothing else: no query's echo, no search on
    // its behalf; the rows after it are the worker's own and its return.
    expect(o.log[0]!.laneRowsSeen).toBe(1)
    expect(laneRows(w, o.sessionId!).map((r) => r.kind)).toEqual([FIRST_MOMENT_KIND, CHECKPOINT_KIND, SUBAGENT_SUMMARY_KIND])
    // No query on its behalf: the store's search ran no time while the door
    // composed and the worker ran (the counter wraps FlatStore.query) ...
    expect(w.facts!['queries']).toBe(0)
    // ... and none is needed: the brief and every checkpoint in effect when
    // it started are in its input whole.
    const input = run.input.stdin!
    expect(input).toContain(rawContentOf(w, w.ids!['brief']!))
    const fm = laneRows(w, o.sessionId!)[0]!
    for (const id of fm.m['refs'] as string[]) expect(input).toContain(rawContentOf(w, id))
    expect((fm.m['refs'] as string[]).length).toBe(2)
  })

  define(/^the worker's first message carries the brief, a line saying no checkpoint is in effect under "([^"]+)", then "([^"]+)"$/, (w, key, prompt) => {
    inOrder(firstMessageOf(w), ['BRIEF: build the search box', `No checkpoint is in effect under "${key}" on the run "${RUN}".`, `${PROMPT_HEADING}\n${prompt}`])
  })

  const firstRow = (w: WorkersWorld): ReturnType<typeof laneRows>[number] => {
    const rows = laneRows(w, outOf(w).sessionId!)
    expect(rows[0]?.kind).toBe(FIRST_MOMENT_KIND)
    return rows[0]!
  }

  define(/^the first row of the worker's lane references the brief row and no checkpoint row$/, (w) => {
    const r = firstRow(w)
    expect(r.m['refs']).toEqual([w.ids!['brief']])
    expect((r.m['first_moment'] as Record<string, unknown>)['checkpoints']).toEqual([])
    expect(r.m['checkpoint_size']).toBe(0)
  })

  define(/^the first row of the worker's lane holds (?:the text "([^"]+)"|empty prompt text) and references to the brief row and the checkpoint row by id$/, (w, text) => {
    const r = firstRow(w)
    expect(r.content).toBe(text ?? '')
    const cp = w.cps![cpLabel(RUN, 'login-form', 1)]!
    expect(r.m['refs']).toEqual([w.ids!['brief'], cp])
    expect([r.m['run'], r.m['key'], r.m['source'], r.m['_writer'], r.m['_door']]).toEqual([RUN, 'login-form', 'auto-capture', 'builder', 'ticket'])
    expect(r.m['checkpoint_size']).toBe(rawContentOf(w, cp).length)
    // Through the hook-less door, the wrapper: the row is the first the
    // lane holds, written before the worker started (it saw only it).
    expect(outOf(w).log[0]!.laneRowsSeen).toBe(1)
  })

  define(/^that row holds no copy of the brief or the checkpoint$/, (w) => {
    const r = firstRow(w)
    const all = JSON.stringify(rawRowOf(w, r.node_id)) + r.content
    for (const id of [w.ids!['brief']!, w.cps![cpLabel(RUN, 'login-form', 1)]!]) {
      const text = rawContentOf(w, id)
      expect(all, `the row copies ${id}`).not.toContain(text)
    }
  })

  define(/^a spawner's prompt of (\d+) characters that pastes a configuration file$/, async (w, n) => {
    await openRunWorld(w)
    const head = '# the deploy configuration, pasted whole: quokkaconfig\n'
    let body = head
    for (let i = 0; body.length < Number(n); i++) body += `setting_${String(i).padStart(6, '0')} = value_${i}\n`
    w.facts!['prompt'] = body.slice(0, Number(n))
    expect((w.facts!['prompt'] as string).length).toBe(Number(n))
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker starts with that prompt$`), async (w, _cli) => {
    // Through the wrapper, from a prompt file: a prompt this size is past
    // what one argument may carry (Linux's 128 KiB), which is one reason
    // the first message goes on the worker's stdin.
    await startByDoor(w, { role: 'builder', prompt: w.facts!['prompt'] as string, spawner: 'wrapper', checkpointer: 'reviewer', plan: { first: {} } })
  })

  define(/^the worker's first-moment row holds all (\d+) characters$/, (w, n) => {
    const r = firstRow(w)
    expect(r.content.length).toBe(Number(n))
    expect(r.content).toBe(w.facts!['prompt'])
    // And the worker was handed all of it, in its first message.
    expect(firstMessageOf(w).endsWith(`${PROMPT_HEADING}\n${w.facts!['prompt'] as string}`)).toBe(true)
  })

  define(/^an agent searching the prompt's words sees a bounded preview ending in the availability marker$/, async (w) => {
    await mcpOver(w, { ccSessionId: w.sessionId! })
    const r = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'quokkaconfig deploy configuration', top_k: 5 } }))
    const hit = (r['results'] as Array<{ nodeId: string; content: string }>).find((h) => h.nodeId === firstRow(w).node_id)
    expect(hit, 'the first-moment row is a hit').toBeTruthy()
    const n = (w.facts!['prompt'] as string).length
    expect(hit!.content.endsWith(`…[preview; full content ${n} chars via treecontext_export]`)).toBe(true)
    expect(hit!.content.length).toBeLessThan(2000)
  })

  define(/^an export of that row returns all (\d+) characters$/, async (w, n) => {
    const read = parseTool(await w.client!.callTool({ name: 'treecontext_export', arguments: { node_id: firstRow(w).node_id } }))
    const nodes = read['nodes'] as Array<{ content: string }>
    expect(nodes[0]!.content.length).toBe(Number(n))
    expect(nodes[0]!.content).toBe(w.facts!['prompt'])
  })

  const intruderFlag = (w: WorkersWorld): string => {
    const l = harnessLookup(w)
    const cp = l.checkpoints.find((c) => c.writer === 'intruder')
    expect(cp?.flag, 'the lookup flags the stranger').toBeTruthy()
    return cp!.flag!
  }

  define(/^the worker's first message carries that checkpoint and the sentence that its writer "([^"]+)" is not the checkpointer the brief names$/, (w, writer) => {
    const cp = rawCheckpoints(w, RUN, 'login-form').at(-1)!
    const sentence = intruderFlag(w)
    expect(sentence).toContain(`"${writer}", is not the checkpointer the brief names`)
    inOrder(firstMessageOf(w), [`written by "${writer}"`, rawContentOf(w, cp.node_id), sentence, PROMPT_HEADING])
  })

  define(/^the worker's first-moment row carries the same flag$/, (w) => {
    const fm = firstRow(w).m['first_moment'] as { flags: string[] }
    expect(fm.flags).toEqual([intruderFlag(w)])
  })

  define(/^the harness looking up the key "([^"]+)" sees the same flag in the run's facts$/, (w, key) => {
    const l = harnessLookup(w, key)
    expect(l.checkpoints.map((c) => c.flag)).toEqual([(firstRow(w).m['first_moment'] as { flags: string[] }).flags[0]])
    expect(keyLookupReply(l).checkpoints[0]!.flag).toBe(l.checkpoints[0]!.flag)
  })

  define(/^the worker's first message carries the brief, then number 4 and number 5 with a line saying two are in effect, then "([^"]+)"$/, (w, prompt) => {
    inOrder(firstMessageOf(w), [
      'BRIEF: review the login form',
      `2 checkpoints are in effect under "login-form" on the run "${RUN}" (number 4 and number 5)`,
      'Checkpoint number 4 under "login-form"', 'STATE 4:',
      'Checkpoint number 5 under "login-form"', 'STATE 5:',
      `${PROMPT_HEADING}\n${prompt}`,
    ])
  })

  define(/^the first row of the worker's lane references the brief row and both checkpoint rows by id$/, (w) => {
    expect(firstRow(w).m['refs']).toEqual([w.ids!['brief'], w.cps![cpLabel(RUN, 'login-form', 4)], w.cps![cpLabel(RUN, 'login-form', 5)]])
  })

  define(/^the worker's first message says a checkpoint is the state of the work as it now stands, names what it supersedes and rests on, and never pastes the history in$/, (w) => {
    const m = firstMessageOf(w)
    expect(m).toContain(STATE_NOT_HISTORY_LINE)
    for (const words of ['state of the work as it now stands', 'what it supersedes and what it rests on', 'never pastes the history in']) expect(m).toContain(words)
    // Treecontext's own words, not the brief's: the brief said nothing.
    expect(m.toLowerCase(), 'the checkpoint needle is dead').toContain('checkpoint')
    // step-lint: allow unearned-absence -- guarded: the line above proves the needle fires on this same first message
    expect(rawContentOf(w, w.ids!['brief']!).toLowerCase()).not.toContain('checkpoint')
    expect((firstRow(w).m['first_moment'] as Record<string, unknown>)['state_line']).toBe(true)
  })

  // ── D291, D292, D295, D316, D335, D340: the send-back once ──

  const owing = (w: WorkersWorld, spawner: Spawner, o: Partial<TicketFields> = {}): WorkerSpec => ({
    spawner, prompt: 'wire the submit button',
    ticket: ticketFields(w, { checkpointer: 'builder', canWrite: true, ...o }),
    plan: { first: {}, rerun: { checkpoint: 'state: submit wired after the send-back', print: 'submit wired' } },
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the (\`treecontext run\` wrapper|wrapper|library call) under the key "([^"]+)", with the ticket naming the worker as its checkpointer and declaring that it has a way to write$`), async (w, _cli, by, key) => {
    await openRunWorld(w)
    w.facts!['spec'] = owing(w, by === 'library call' ? 'library' : 'wrapper', { key })
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", naming itself as checkpointer, whose ticket says nothing about whether it can write$`), async (w, _cli, key) => {
    await openRunWorld(w)
    const spec = owing(w, 'wrapper', { key })
    delete (spec.ticket as TicketFields).canWrite
    w.facts!['spec'] = spec
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", with the ticket naming the project-manager as the one who will checkpoint$`), async (w, _cli, key) => {
    await openRunWorld(w)
    w.facts!['spec'] = owing(w, 'wrapper', { key, checkpointer: 'project-manager' })
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", with the ticket naming the worker as its checkpointer and declaring that it has no way to write to the store$`), async (w, _cli, key) => {
    await openRunWorld(w)
    w.facts!['spec'] = { ...owing(w, 'wrapper', { key, canWrite: false }), expectEnd: 'retired' }
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker already run once more for the missing checkpoint under the key "([^"]+)"$`), async (w, _cli, key) => {
    await openRunWorld(w)
    // Its first run wrote 2 notes and no checkpoint, and its one re-run
    // (the When) writes 1 more and no checkpoint either.
    w.facts!['spec'] = { ...owing(w, 'wrapper', { key }), plan: { first: { notes: 2 }, rerun: { notes: 1 } }, expectEnd: 'retired' }
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker that claimed a ticket by token under the key "([^"]+)", naming itself as checkpointer, with no wrapper watching its exit$`), async (w, _cli, key) => {
    await openRunWorld(w)
    // The ticket sits in the worker's environment as a harness minted it;
    // the worker claims it through the ticket door itself (claimTicket),
    // and no door watches it.
    w.facts!['spec'] = { ...owing(w, 'none', { key }), plan: { first: { notes: 3 } }, expectEnd: 'phantom' }
  })

  define(/^the worker exits with no checkpoint under the key "([^"]+)"(?: newer than its start)?$/, async (w, key) => {
    const spec = specOf(w)
    expect((spec.ticket as TicketFields).key).toBe(key)
    if (spec.plan.first.notes === undefined) spec.plan.first.notes = 25
    spec.plan.first.label = 'first run'
    await runWorker(w, spec)
  })

  define(/^the worker exits with code (\d+) and no checkpoint written$/, async (w, code) => {
    const spec = specOf(w)
    spec.plan.first.exit = Number(code)
    await runWorker(w, spec)
    expect(outOf(w).log[0]).toBeTruthy()
  })

  define(/^the worker prints "([^"]+)" and exits with no checkpoint$/, async (w, text) => {
    const spec = specOf(w)
    spec.plan.first.print = text
    await runWorker(w, spec)
  })

  define(/^the second run exits with no checkpoint written$/, async (w) => {
    await runWorker(w, specOf(w))
  })

  define(/^the (`treecontext run` wrapper|wrapper|library call) runs the worker once more with the reason naming the missing checkpoint under "([^"]+)"$/, (w, by, key) => {
    const o = outOf(w)
    expect(o.spawner).toBe(by === 'library call' ? 'library' : 'wrapper')
    expect(o.log.map((r) => r.rerun)).toEqual([false, true])
    const second = o.log[1]!.stdin
    expect(second.startsWith(sendBackReason('builder', RUN, key))).toBe(true)
    expect(second).toContain(`no checkpoint under the key "${key}"`)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['send_backs'], reg['ended']]).toEqual([1, 'retired'])
    expect(o.line).toContain('after its one send-back')
    // Silence about the door is read as one (D340): the ticket the worker
    // carried said nothing of it.
    const t = JSON.parse(o.log[0]!.ticket!) as Record<string, unknown>
    if (!('can_write' in t)) expect((specOf(w).ticket as TicketFields).canWrite).toBeUndefined()
  })

  define(/^the second run is a fresh process whose first message names that reason, with the first run's (\d+) inserted rows in the store for it to read$/, (w, n) => {
    const o = outOf(w)
    expect(o.log[1]!.pid).not.toBe(o.log[0]!.pid)
    expect(o.log[1]!.lane).toBe(o.log[0]!.lane)
    expect(o.log[1]!.stdin).toContain('This is your one send-back')
    expect(o.log[1]!.firstRunNotesSeen).toBe(Number(n))
    const procs = JSON.parse(String(rawRegistration(w, w.legs!['worker']!)['processes'])) as Array<{ pid: number }>
    expect(procs.map((p) => p.pid)).toEqual([o.log[0]!.pid, o.log[1]!.pid])
  })

  define(/^the wrapper starts no (second|third) run$/, (w, which) => {
    const o = outOf(w)
    const runs = which === 'second' ? 1 : 2
    expect(o.log).toHaveLength(runs)
    const procs = JSON.parse(String(rawRegistration(w, w.legs!['worker']!)['processes'])) as unknown[]
    expect(procs).toHaveLength(runs)
    expect(rawRegistration(w, w.legs!['worker']!)['send_backs']).toBe(runs - 1)
  })

  define(/^the harness looking up the key "([^"]+)" sees the leg retired as having ended without a checkpoint$/, (w, key) => {
    const spec = specOf(w)
    const l = harnessLookup(w, key)
    const leg = l.legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)
    expect(leg, 'the leg is listed under the run').toBeTruthy()
    expect([leg!.state, leg!.checkpointsWritten]).toEqual([spec.expectEnd ?? 'retired', 0])
    if (spec.expectEnd === 'phantom') expect(leg!.noticedBy).toBe(NOTICED_BY_LOOKUP)
    expect(keyLookupReply(l).legs.find((g) => g.session_id === leg!.sessionId)!.checkpoints_written).toBe(0)
  })

  define(/^the next builder leg under the key "([^"]+)" starts as a recovery leg$/, async (w, key) => {
    const prev = w.legs!['worker']!
    const rows = laneRows(w, prev.sessionId).filter((r) => r.kind !== FIRST_MOMENT_KIND && r.kind !== SEND_BACK_KIND).length
    await runWorker(w, {
      spawner: 'library', prompt: 'continue the login form',
      ticket: ticketFields(w, { key, checkpointer: 'builder' }), plan: { first: { checkpoint: 'state: recovered; submit wired' } },
    }, 'next')
    const m = firstMessageOf(w, 'next')
    const how = { cut: 'was cut', phantom: 'was found gone and retired as a phantom', retired: 'ended without a checkpoint' }[specOf(w).expectEnd ?? 'retired']
    expect(m).toContain(`your predecessor, the builder leg in the lane of session ${prev.sessionId}, ${how}, leaving ${rows} ${rows === 1 ? 'row' : 'rows'} and no checkpoint under "${key}"`)
    expect(m).toContain('You start as a recovery leg')
    inOrder(m, [w.store!.checkpointsInEffect(RUN, key).length === 0 ? `No checkpoint is in effect under "${key}"` : 'is in effect under', 'your predecessor'])
    const fm = laneRows(w, outOf(w, 'next').sessionId!)[0]!
    expect((fm.m['first_moment'] as { recovers: Record<string, unknown> }).recovers).toMatchObject({ session_id: prev.sessionId, rows })
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", with checkpoint number (\\d+) in effect, that inserted (\\d+) rows and no checkpoint$`), async (w, _cli, key, num, n) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key, Number(num), 'builder')
    w.facts!['spec'] = { ...owing(w, 'wrapper', { key }), plan: { first: { notes: Number(n), exit: 'hang' } }, timeoutSecs: 6, expectEnd: 'cut' }
  })

  define(/^the harness's timeout kills the worker with a signal$/, async (w) => {
    await runWorker(w, specOf(w))
    const o = outOf(w)
    // The wrapper's --timeout signalled it (SIGTERM); its exit code says so.
    expect(o.exitCode).toBe(143)
  })

  define(/^the worker's registration reads cut, its (\d+) rows remain in its lane, and no summary row exists$/, (w, n) => {
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['ended'], reg['send_backs']]).toEqual(['cut', 0])
    const lane = laneRows(w, w.legs!['worker']!.sessionId)
    expect(lane.filter((r) => r.content.startsWith('first run note '))).toHaveLength(Number(n))
    expect(lane.filter((r) => r.kind === SUBAGENT_SUMMARY_KIND)).toHaveLength(0)
    expect(outOf(w).line).toContain('a cut, so it is not sent back and left no summary row')
  })

  define(/^the harness looking up the key "([^"]+)" receives checkpoint number (\d+) with the leg shown as cut$/, (w, key, num) => {
    const l = harnessLookup(w, key)
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(num)])
    expect(l.legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)?.state).toBe('cut')
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker, the process (?:\\d+) started at (?:\\d\\d:\\d\\d:\\d\\d), started by the wrapper under the key "([^"]+)", that exits with no checkpoint$`), async (w, _cli, key) => {
    await openRunWorld(w)
    // The process numbers and moments are the OS's: the stand-in's own.
    const go = join(w.home!, 'second-run-go')
    w.facts!['go'] = go
    w.facts!['spec'] = { ...owing(w, 'wrapper', { key }), plan: { first: { notes: 3, label: 'first run' }, rerun: { notes: 2, label: 'second run', waitFor: go } } }
  })

  define(/^the wrapper runs it once more as the process (?:\d+) started at (?:\d\d:\d\d:\d\d)$/, async (w) => {
    const go = w.facts!['go'] as string
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${go}.ready`)
      // While the second process runs: the harness's liveness check.
      const session = readFileSync(`${go}.ready`, 'utf8')
      const l = harnessLookup(w)
      const leg = l.legs.find((g) => g.kind === 'worker')!
      w.facts!['live-during'] = { state: leg.state, newest: leg.registration.processes.at(-1)?.pid, pid: Number(session) }
      writeFileSync(go, 'go')
    })
  })

  define(/^the store holds one registration for the leg, carrying both processes with their ids and start moments$/, (w) => {
    const o = outOf(w)
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', o.sessionId)).toHaveLength(1)
    const procs = JSON.parse(String(rawRegistration(w, w.legs!['worker']!)['processes'])) as Array<{ pid: number; start: number | null }>
    expect(procs.map((p) => [p.pid, p.start])).toEqual(o.log.map((r) => [r.pid, r.start]))
    expect(new Set(procs.map((p) => p.pid)).size).toBe(2)
    for (const p of procs) expect(p.start).not.toBeNull()
  })

  define(/^the leg's lane holds one first-moment row, then the first run's rows, then a row with the second run's first message naming the missing checkpoint, then the second run's rows$/, (w) => {
    const o = outOf(w)
    const lane = laneRows(w, o.sessionId!)
    const shape = lane.map((r) => r.kind ?? (r.content.startsWith('first run note') ? 'first' : r.content.startsWith('second run note') ? 'second' : 'other'))
    expect(shape).toEqual([FIRST_MOMENT_KIND, 'first', 'first', 'first', SEND_BACK_KIND, 'second', 'second', SUBAGENT_SUMMARY_KIND])
    const sendBack = lane.find((r) => r.kind === SEND_BACK_KIND)!
    expect(sendBack.content).toBe(o.log[1]!.stdin)
    expect(sendBack.content).toContain('no checkpoint under the key "login-form"')
  })

  define(/^a liveness check while the process (?:\d+) runs reads the leg as live$/, (w) => {
    const seen = w.facts!['live-during'] as { state: string; newest: number; pid: number }
    expect(seen).toEqual({ state: 'live', newest: outOf(w).log[1]!.pid, pid: outOf(w).log[1]!.pid })
  })

  // ── D341: a one-off worker, declared keyless ──

  define(/^a ticket naming the parent "([^"]+)", the run "([^"]+)" and the role "([^"]+)", and saying in words that the worker has no key$/, async (w, parent, run, role) => {
    await openRunWorld(w)
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'find where the login form lives', ticket: { run, noKey: true, role, parent: { id: parent } }, plan: { first: {} } } satisfies WorkerSpec
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker starts with it, prints "([^"]+)" and exits with no checkpoint$`), async (w, _cli, text) => {
    const spec = specOf(w)
    spec.plan.first = { texts: [`the login form lives at ${text}`], print: text }
    await runWorker(w, spec)
  })

  define(/^the worker's rows sit in its own lane with the writer "([^"]+)" and the parent "([^"]+)"$/, (w, writer, parent) => {
    const lane = laneRows(w, outOf(w).sessionId!)
    expect(lane.map((r) => r.kind)).toEqual([FIRST_MOMENT_KIND, null, SUBAGENT_SUMMARY_KIND])
    for (const r of lane) expect([r.m['_writer'], r.m['_parent'], r.m['_parent_src']]).toEqual([writer, parent, 'declared'])
    expect(rawAll(w, 'SELECT 1 FROM nodes WHERE session_key = ?', parent)).toHaveLength(0)
  })

  define(/^the harness looking up the run "([^"]+)" counts one keyless leg among the run's facts, with its summary row reading "([^"]+)"$/, (w, run, text) => {
    const l = harnessLookup(w, 'login-form', run)
    expect(l.facts.keylessLegs).toBe(1)
    const leg = l.legs.find((g) => g.keyless)!
    expect([leg.sessionId, leg.state, leg.checkpointsWritten]).toEqual([outOf(w).sessionId, 'retired', null])
    const summary = laneRows(w, leg.sessionId).find((r) => r.kind === SUBAGENT_SUMMARY_KIND)!
    expect([summary.content, summary.m['run'], summary.m['key']]).toEqual([text, run, undefined])
  })

  // ── D303, D341, D342: a ticket the door cannot read whole ──

  const truncatedAfterRole = (role: string): string => {
    const t = mintTicket({ run: RUN, key: 'login-form', role, checkpointer: role, parent: { id: 'p1' } })
    return t.slice(0, t.indexOf(`"role":"${role}"`) + `"role":"${role}"`.length)
  }

  define(new RegExp(`^a ticket in the environment, (truncated after the role "builder"|minted in an older shape that still reads as the role "reviewer"), so that the hook-less door of a ${WORKER_CLI} worker cannot read it whole$`), async (w, damage, _cli) => {
    await openRunWorld(w)
    const raw = damage!.startsWith('truncated')
      ? truncatedAfterRole('builder')
      // An older treecontext's shape: no version this build knows, the
      // task by another name, the parent as a bare session.
      : JSON.stringify({ ticket_version: 0, v: 0, role: 'reviewer', task: 'login-form', session: 'p1' })
    w.facts!['raw'] = raw
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: raw, plan: { first: { invalidRow: true, print: 'my instructions were invalid; stopped' } } } satisfies WorkerSpec
  })

  define(new RegExp(`^the worker starts through the hook-less door of a ${WORKER_CLI} worker$`), async (w, _cli) => {
    await runWorker(w, specOf(w))
  })

  define(/^the worker's registration sits in its own lane with every field the door could read, each unreadable field marked absent, and the raw ticket text kept$/, (w) => {
    const raw = w.facts!['raw'] as string
    const read = readTicket(raw)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['kind'], reg['agent_id'], reg['door']]).toEqual(['worker', WORKER_AGENT_ID, 'ticket'])
    expect(reg['session_id']).not.toBe(w.sessionId)
    expect([reg['agent_type'], reg['run'], reg['run_key']]).toEqual([read.ticket.role, read.ticket.run, read.ticket.key])
    expect(reg['ticket_raw']).toBe(raw)
    expect(JSON.parse(String(reg['ticket_absent']))).toEqual(read.absent)
    expect(read.absent.length).toBeGreaterThan(0)
  })

  define(/^the store holds no self registration for it$/, (w) => {
    const session = w.legs!['worker']!.sessionId
    expect(rawAll(w, "SELECT agent_id FROM session_registry WHERE session_id = ?", session)).toEqual([{ agent_id: WORKER_AGENT_ID }])
    expect(rawAll(w, "SELECT 1 FROM session_registry WHERE session_id = ? AND agent_id = ''", session)).toHaveLength(0)
  })

  define(/^the worker's first message says its instructions were invalid and asks it to write one row saying so and stop$/, (w) => {
    const m = firstMessageOf(w)
    const read = readTicket(outOf(w).log[0]!.ticket!)
    expect(m).toBe(invalidInstructionsMessage(read.absent, { role: read.ticket.role, run: read.ticket.run, key: read.ticket.key }))
    expect(m).toContain('your instructions were invalid')
    expect(m).toContain('Write one row to the store saying your instructions were invalid, then stop.')
    // The worker was told nothing to work on: no brief, no checkpoint, no prompt.
    expect(m).not.toContain(PROMPT_HEADING)
  })

  define(/^the store records the leg as having ended with no valid instructions once the worker's one row lands$/, (w) => {
    const reg = rawRegistration(w, w.legs!['worker']!)
    const row = laneRows(w, w.legs!['worker']!.sessionId).find((r) => r.content.startsWith('my instructions were invalid'))!
    expect(reg['ended']).toBe('invalid')
    // Retired at the moment the row landed, by the store, not at the exit.
    expect(reg['stopped_at']).toBe(row.created_at)
  })

  define(/^the spawner is told in the line it receives at the worker's exit that the worker ended with invalid instructions$/, (w) => {
    const o = outOf(w)
    expect(o.line).toContain('ended with invalid instructions')
    expect(o.line).toContain(`session ${o.sessionId}`)
  })

  define(/^a ticket naming the parent "([^"]+)", the run "([^"]+)" and the role "([^"]+)", with its key blank and no words saying the worker has no key$/, async (w, parent, run, role) => {
    await openRunWorld(w)
    const raw = mintTicket({ run, key: '', role, checkpointer: role, parent: { id: parent } })
    w.facts!['raw'] = raw
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: raw, plan: { first: { invalidRow: true } } } satisfies WorkerSpec
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker starts with it$`), async (w, _cli) => {
    await runWorker(w, specOf(w))
  })

  define(/^the worker's registration keeps the raw ticket text with the key marked absent$/, (w) => {
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect(reg['ticket_raw']).toBe(w.facts!['raw'])
    expect(JSON.parse(String(reg['ticket_absent']))).toEqual(['key'])
    expect([reg['run_key'], reg['ended']]).toEqual([null, 'invalid'])
  })

  define(/^a worker whose ticket named the parent "([^"]+)" and the run "([^"]+)" and lost its key, and another whose ticket named the parent "\1" and lost both run and key, each having written its one row and stopped$/, async (w, parent, run) => {
    await openRunWorld(w)
    const lostKey = JSON.stringify({ v: 1, run, role: 'builder', parent: { id: parent } })
    const lostBoth = JSON.stringify({ v: 1, role: 'builder', parent: { id: parent } })
    for (const [name, raw] of [['first', lostKey], ['second', lostBoth]] as const) {
      w.facts![`raw:${name}`] = raw
      await runWorker(w, { spawner: 'library', prompt: 'wire the submit button', ticket: raw, plan: { first: { invalidRow: true } } }, name)
      expect(rawRegistration(w, w.legs![name]!)['ended']).toBe('invalid')
    }
  })

  define(/^the harness looks up the run "([^"]+)"$/, (w, run) => {
    harnessLookup(w, 'login-form', run)
  })

  define(/^the harness sees the first worker under the run "([^"]+)" as having ended with no valid instructions$/, (w, run) => {
    const legs = w.lookups![run]!.legs
    expect(legs.map((g) => [g.sessionId, g.state])).toEqual([[w.legs!['first']!.sessionId, 'invalid']])
  })

  define(/^the second worker appears under no run, and a reader grouping workers by declared parent finds it under "([^"]+)" with its raw ticket text$/, (w, parent) => {
    const second = w.legs!['second']!.sessionId
    expect(rawRegistration(w, w.legs!['second']!)['run']).toBeNull()
    expect(rawAll(w, 'SELECT 1 FROM nodes WHERE session_key = ? AND json_extract(metadata_json, \'$.run\') IS NOT NULL', second)).toHaveLength(0)
    const grouped = rawAll<{ session_id: string; ticket_raw: string }>(w,
      "SELECT session_id, ticket_raw FROM session_registry WHERE kind = 'worker' AND parent_session = ? ORDER BY started_at", parent)
    expect(grouped.find((g) => g.session_id === second)?.ticket_raw).toBe(w.facts!['raw:second'])
    expect(w.store!.workersOfParent(parent).map((l) => l.sessionId)).toContain(second)
    // Its exit line, the other place it is reachable, names it and says how it ended.
    expect(outOf(w, 'second').line).toContain(`session ${second}`)
    expect(outOf(w, 'second').line).toContain('ended with invalid instructions')
  })

  define(/^a spawner asking the ticket door to start a worker with a ticket truncated after the role "([^"]+)"$/, async (w, role) => {
    await openRunWorld(w)
    const raw = truncatedAfterRole(role)
    w.facts!['raw'] = raw
    w.facts!['spec'] = { spawner: 'library', prompt: 'wire the submit button', ticket: raw, checkTicket: true, plan: { first: { notes: 1 } } } satisfies WorkerSpec
  })

  define(/^the ticket door checks the ticket before spawning$/, async (w) => {
    await runWorker(w, specOf(w))
  })

  define(/^the ticket door writes one row in the spawner's lane, with the spawner as its writer, saying the ticket was invalid and keeping the raw ticket text$/, (w) => {
    const o = outOf(w)
    const id = o.result!.refusedId!
    const row = rawOne<{ session_key: string; m: string; c: Buffer | string }>(w, 'SELECT session_key, metadata_json AS m, content AS c FROM nodes WHERE node_id = ?', id)!
    const m = JSON.parse(row.m) as Record<string, unknown>
    const spawnerWriter = w.store!.writerStampFor(w.sessionId!).writer
    expect([row.session_key, m['_writer'], m['kind'], m['ticket_raw'], m['_door']]).toEqual([w.sessionId, spawnerWriter, 'ticket-refused', w.facts!['raw'], 'ticket'])
    expect(decodeContent(row.c)).toContain("a worker's ticket was invalid")
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'ticket-refused'")).toHaveLength(1)
  })

  define(/^no worker process is started$/, (w) => {
    const o = outOf(w)
    expect([o.result!.started, o.result!.runs.length, o.log.length, existsSync(o.logPath)]).toEqual([false, 0, 0, false])
    expect(rawAll(w, "SELECT 1 FROM session_registry WHERE kind = 'worker'")).toHaveLength(0)
  })

  // ── D307: a store that cannot be read or written ──

  define(/^a store locked by another process for longer than the busy wait$/, async (w) => {
    await openRunWorld(w)
    // This process lets go of the store first: an idle WAL reader would
    // keep the other process from taking the whole store.
    await w.store!.close()
    w.facts!['locker'] = await lockStore(w, 'whole')
  })

  define(/^the ticket door is asked to start a builder worker under the key "([^"]+)"$/, async (w, key) => {
    await runWorker(w, { spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { key, checkpointer: 'builder' }), plan: { first: { notes: 1 } } })
  })

  define(/^the ticket door waits the busy wait and then starts no worker$/, (w) => {
    const o = outOf(w)
    expect(o.elapsedMs).toBeGreaterThanOrEqual(DOOR_BUSY_WAIT_MS)
    expect([o.exitCode, o.log.length, existsSync(o.logPath)]).toEqual([NOT_STARTED_EXIT, 0, false])
  })

  define(/^the spawner is told in words that the store was unreachable and nothing was written$/, (w) => {
    expect(outOf(w).line).toMatch(new RegExp(`^${DOOR_LINE_PREFIX} the store at .* could not be read after waiting ${DOOR_BUSY_WAIT_MS / 1000} s .*; no worker was started and nothing was written\\.$`))
  })

  define(/^once the lock clears, the store holds no registration and no row for that worker$/, async (w) => {
    await killAndReap(w.facts!['locker'] as ChildProcess)
    expect(rawAll(w, "SELECT 1 FROM session_registry WHERE kind = 'worker'")).toHaveLength(0)
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$.run') IS NOT NULL OR session_key LIKE 'worker-%'")).toHaveLength(0)
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker under the key "([^"]+)", with checkpoint number (\\d+) in effect, that prints its checkpoint as its last output$`), async (w, _cli, key, num) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, key, Number(num), 'builder')
    const go = join(w.home!, 'exit-go')
    w.facts!['go'] = go
    const checkpoint = 'state: submit wired to /api/login\nrests on: the form scaffold\nnext: error states\n'
    w.facts!['printed'] = checkpoint
    w.facts!['spec'] = { ...owing(w, 'wrapper', { key }), plan: { first: { notes: 2, print: checkpoint, waitFor: go } }, expectEnd: 'phantom' }
  })

  define(/^a store that refuses writes at the moment the worker exits$/, (w) => {
    w.facts!['lock-at-exit'] = true
  })

  define(/^the worker exits$/, async (w) => {
    expect(w.facts!['lock-at-exit']).toBe(true)
    const go = w.facts!['go'] as string
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${go}.ready`)
      w.facts!['locker'] = await lockStore(w, 'writes')
      writeFileSync(go, 'go')
    })
  })

  define(/^the spawner is handed the worker's last output whole$/, (w) => {
    const o = outOf(w)
    expect(o.stdout).toBe(w.facts!['printed'])
    expect(o.line).toContain('the store could not be written')
    expect(o.exitCode).toBe(0)
  })

  define(/^the harness next looking up the key "([^"]+)" on this host receives checkpoint number (\d+), the earlier one in effect, with the leg retired as a phantom by that lookup$/, async (w, key, num) => {
    await killAndReap(w.facts!['locker'] as ChildProcess)
    // Nothing of the exit was recorded: the leg is still live, with no
    // checkpoint under the key and no summary row.
    const before = rawRegistration(w, w.legs!['worker']!)
    expect([before['ended'], before['stopped_at']]).toEqual([null, null])
    expect(laneRows(w, w.legs!['worker']!.sessionId).filter((r) => r.kind === SUBAGENT_SUMMARY_KIND || r.kind === CHECKPOINT_KIND)).toHaveLength(0)
    const l = harnessLookup(w, key)
    expect(l.checkpoints.map((c) => c.number)).toEqual([Number(num)])
    const leg = l.legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)!
    expect([leg.state, leg.noticedBy]).toEqual(['phantom', NOTICED_BY_LOOKUP])
  })
}
