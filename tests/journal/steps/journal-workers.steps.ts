import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
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
import { sandboxedSpawnEnv } from '../../helpers/cli-spawn.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import {
  type RunWorld, openRunWorld, sessionStartHook, sleeper, killAndReap, localMoment, rawOne, rawRegistration, stringSteps, liveProcess,
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
// A worker here is registered through registerWorker, the library door a
// spawner holding the ticket registers through (the ticket's reading from
// the environment, the `treecontext run` wrapper and the first message are
// the ticket door's build, and their scenarios stay in the wip register).
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

  // ── D293: a writer no hook registered, through the library ──
  //
  // The library example of the outline binds here; its ticket-door example
  // waits on the ticket door (unit 3), which is why the step sentences
  // below name the library call literally.

  define(/^a process the store never registered, that declares the role "([^"]+)" and the parent "([^"]+)" through the library call$/, async (w, role, parent) => {
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
    w.facts!['declared'] = { role, parent, cwd: realpathSync.native(wt) }
  })

  define(/^that process inserts the note "([^"]+)"$/, async (w, text) => {
    const d = w.facts!['declared'] as { role: string; parent: string; cwd: string }
    w.moments!['before'] = Date.now() / 1000
    const r = await w.store!.insert(text, { declared: { role: d.role, parent: d.parent, cwd: d.cwd } })
    w.moments!['after'] = Date.now() / 1000
    expect(r.deduplicated).toBe(false)
    w.ids!['note'] = r.nodeId
  })

  define(/^a reader of the row sees it stored, with when it was written, the directory, worktree and branch the door could read, the library call as the door that wrote it, that its identity was declared by the writer and not registered by a hook, the writer stamp "([^"]+)", the declared parent "([^"]+)", and the note's text$/, (w, writer, parent) => {
    const d = w.facts!['declared'] as { cwd: string }
    const row = rawOne<{ created_at: number; c: Buffer | string; m: string }>(w, 'SELECT created_at, content AS c, metadata_json AS m FROM nodes WHERE node_id = ?', w.ids!['note'])
    expect(row, 'the row is stored, never refused').toBeTruthy()
    const m = JSON.parse(row!.m) as Record<string, unknown>
    expect(row!.created_at).toBeGreaterThanOrEqual(w.moments!['before']!)
    expect(row!.created_at).toBeLessThanOrEqual(w.moments!['after']!)
    expect([m['_cwd'], m['_worktree'], m['_branch']]).toEqual([d.cwd, 'login-wt', 'login'])
    expect([m['_door'], m['_identity'], m['_writer_src']]).toEqual(['library', 'declared', 'declared'])
    expect([m['_writer'], m['_parent'], m['_parent_src']]).toEqual([writer, parent, 'declared'])
    expect(decodeContent(row!.c)).toBe('state: all tests pass')
    // No registration was minted for the writer or its parent.
    expect(rawAll(w, 'SELECT 1 FROM session_registry')).toHaveLength(0)
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
