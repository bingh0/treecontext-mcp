import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
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
import { drainStaging, runHook } from '../capture-harness.js'
import { sandboxedSpawnEnv, nodeTsArgs, spawnCli, CLI_TS } from '../../helpers/cli-spawn.js'
import { agentConfigPath } from '../install-harness.js'
import { mintTicket, readTicket, TICKET_ENV, WORKER_SESSION_ENV, type TicketFields } from '../../../src/ticket.js'
import { DOOR_LINE_PREFIX, DOOR_BUSY_WAIT_MS, NOT_STARTED_EXIT } from '../../../src/ticket-door.js'
import {
  momentText, PROMPT_HEADING, STATE_NOT_HISTORY_LINE, sendBackReason, invalidInstructionsMessage, firstMomentFactsOf, composeFirstMessage,
} from '../../../src/first-moment.js'
import { readSessionBeacon } from '../../../src/session-beacon.js'
import { FIRST_MOMENT_KIND, SEND_BACK_KIND, CHECKPOINT_KIND } from '../../../src/run-kinds.js'
import { keyLookupReply, type KeyLookup } from '../../../src/key-lookup.js'
import { storesDirIn } from '../../helpers/store-fixtures.js'
import {
  runWorker, registerThroughLibrary, lookupInSandbox, osAnsweringGone, STANDIN_WORKER, recordedSession, replayRecordedSession, type ReplayedEvent, type Spawner, type WorkerPlan, type WorkerSpec, type Outcome, type StandinRecord,
} from '../standins.js'
import {
  type RunWorld, openRunWorld, sessionStartHook, sleeper, killAndReap, localMoment, rawOne, rawRegistration, stringSteps, liveProcess,
  seedCheckpoints, cpLabel, rawCheckpoints, rawContentOf, rawRowOf, lockStore, waitForFile, readerOf, insertEchoed,
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
// A worker in these registry scenarios is registered through the library
// door a spawner holding the ticket registers through (the stand-in
// harness's registerThroughLibrary, ../standins.ts); the ticket door itself (the ticket read from the environment,
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
async function openGitSession(w: WorkersWorld, sessionId: string | null, branch: string): Promise<void> {
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
  w.dbPath = join(storesDirIn(w.home), resolvedStoreName(w, repo), 'treecontext.db')
  w.legs = {}; w.cps = {}; w.ids = {}; w.moments = {}; w.lookups = {}; w.stops = {}; w.before = {}; w.facts = {}; w.children = []
  // A session that never spoke to the store (D294) starts no hook here.
  if (sessionId !== null) {
    w.sessionId = sessionId
    sessionStartHook(w)
  } else mkdirSync(dirname(w.dbPath), { recursive: true, mode: 0o700 })
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath)), ownsDatabase: true })
  w.defer(() => store.close())
  w.store = store
}

/** The store name the production resolver derives for a directory, asked
 *  of it in a subprocess under the sandbox's home. */
function resolvedStoreName(w: WorkersWorld, dir: string): string {
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'tests', 'helpers', 'resolve-driver.ts'), dir), {
    env: sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') }),
    cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  expect(r.status, r.stderr).toBe(0)
  return (JSON.parse(r.stdout) as { storeName: string }).storeName
}

/** A worker of the run registered through the library door, its process
 *  as the door read it. */
async function libraryWorker(w: WorkersWorld, name: string, proc: { pid: number | null; start: number | null; host: string; token?: string | null }): Promise<void> {
  await registerThroughLibrary(w, name, { door: 'library', ticket: ticketFor({ id: 'p1' }), process: proc })
}

function lookup(w: WorkersWorld): void {
  w.lookups![RUN] = w.store!.lookupKey({ run: RUN, key: 'login-form' })
}

const READERS: Record<string, string> = {
  "harness's lookup": NOTICED_BY_LOOKUP,
  'status call': NOTICED_BY_STATUS,
  'session-start hook': NOTICED_BY_SESSION_START,
  // The ticket door's word for itself on the registration, as the row names it.
  'ticket door': 'ticket door',
}

export const workersDefiner = (reg: Registry<WorkersWorld>): void => {
  const define = stringSteps(reg)
  ticketDoorSteps(define)
  claudeChildSteps(define)
  workerLaneSteps(define)
  workerDedupSteps(define)
  failedRunSteps(define)
  sessionVariableSteps(define)
  groupAndStreamSteps(define)
  sandboxSteps(define)

  // ── D294: the parent as declared, or as a hook registered it ──
  //
  // The main (Codex CLI, Antigravity CLI) is the party on the far side of
  // the door: what it does is run the real `treecontext run` wrapper from
  // its shell, with `--parent` and `--parent-cli` (the stand-in harness's
  // runWorker, the ticket flags as written), from two real checkouts of
  // one repository, each resolved by the production resolver to the one
  // store. The wrapper mints each ticket from where it runs; each Then reads
  // the store file, and the ticket each worker carried in its environment.

  define(/^an? (Codex CLI|Antigravity CLI) main session "([^"]+)" that never spoke to the store$/, async (w, _main, parent) => {
    await openGitSession(w, null, 'main')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const wt = join(dirname(w.proj!), 'login-wt')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'login', wt], { cwd: w.proj!, env })
    w.facts!['checkouts'] = { main: w.proj!, login: realpathSync.native(wt) }
    // Both checkouts are the one project: the resolver gives them one store.
    expect(resolvedStoreName(w, realpathSync.native(wt))).toBe(resolvedStoreName(w, w.proj!))
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE session_id = ?', parent)).toHaveLength(0)
    expect(rawAll(w, 'SELECT 1 FROM session_registry')).toHaveLength(0)
  })

  define(/^it starts two workers through the `treecontext run` wrapper with `--parent ([^`]+)` and `--parent-cli ([^`]+)`, one from a checkout on the branch "([^"]+)" and the other from a checkout on the branch "([^"]+)"$/, async (w, parent, cli, a, b) => {
    const checkouts = w.facts!['checkouts'] as Record<string, string>
    for (const [name, branch] of [['first', a], ['second', b]] as const) {
      const cwd = checkouts[branch]!
      expect(cwd, `no checkout on the branch "${branch}"`).toBeTruthy()
      const o = await runWorker(w, {
        spawner: 'wrapper', prompt: 'wire the submit button', cwd,
        ticket: { run: RUN, key: 'login-form', role: 'builder', checkpointer: 'reviewer', parent: { id: parent, cli } },
        plan: { first: { texts: [`note from the ${name} worker: wired the ${branch} branch's form`], print: `${name} done` } },
      }, name)
      expect(o.exitCode, o.stderr).toBe(0)
      w.facts![`${name}-branch`] = branch
      w.facts![`${name}-cwd`] = cwd
    }
  })

  define(/^each worker's registration carries the parent id "([^"]+)", the CLI "([^"]+)", and the directory, worktree and branch its own ticket declared, marked declared, with the ticket's mint moment$/, (w, parent, cli) => {
    for (const name of ['first', 'second']) {
      const o = outOf(w, name)
      const r = rawRegistration(w, w.legs![name]!)
      expect([r['kind'], r['door'], r['parent_session'], r['parent_src'], r['identity']], name).toEqual(['worker', 'ticket', parent, 'declared', 'declared'])
      // What the wrapper minted, as the worker carried it.
      const carried = readTicket(o.log[0]!.ticket!)
      expect(carried.valid, name).toBe(true)
      const declared = JSON.parse(String(r['parent_declared'])) as Record<string, unknown>
      expect(declared, `${name}: the registration's description is its own ticket's`).toEqual(carried.ticket.parent)
      // And that is the main as its shell ran: the CLI its flag named, the
      // checkout it ran from, the worktree and branch git reads there.
      const cwd = w.facts![`${name}-cwd`] as string
      expect([declared['id'], declared['cli'], declared['cwd'], declared['branch']], name).toEqual([parent, cli, cwd, w.facts![`${name}-branch`]])
      expect(declared['worktree'], name).toBe(name === 'first' ? null : 'login-wt')
      expect(r['ticket_minted_at'], `${name}: the mint moment`).toBe(carried.ticket.mintedAt)
      expect(typeof r['ticket_minted_at']).toBe('number')
    }
    // Two tickets, two moments: each registration carries its own.
    expect(rawRegistration(w, w.legs!['first']!)['ticket_minted_at']).not.toBe(rawRegistration(w, w.legs!['second']!)['ticket_minted_at'])
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
    await registerThroughLibrary(w, 'worker', {
      door: 'library', ticket: ticketFor({ id: parent, branch: 'what-the-ticket-said' }), process: liveProcess(),
    })
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
    await registerThroughLibrary(w, 'worker', {
      door: 'library', ticket: w.facts!['ticket'] as Parameters<typeof registerThroughLibrary>[2]['ticket'],
      process: { pid: Number(pid), start: localMoment(started), host },
    })
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
    await libraryWorker(w, 'worker', { pid: child.pid!, start, token: hostProbe.startToken?.(child.pid!) ?? null, host: hostname() })
    await killAndReap(child)
    expect(hostProbe.exists(child.pid!)).toBe(false)
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['stopped_at']]).toEqual([null, null])
  })

  define(/^the (harness's lookup|status call|session-start hook|ticket door) next reads the registry on this host$/, async (w, reader) => {
    w.moments!['before-read'] = Date.now() / 1000
    if (reader === "harness's lookup") lookup(w)
    else if (reader === 'status call') {
      await mcpOver(w, { ccSessionId: w.sessionId! })
      w.facts!['status'] = parseTool(await w.client!.callTool({ name: 'treecontext_status', arguments: {} }))
    } else if (reader === 'ticket door') {
      // The next worker of the run started on this host through the real
      // `treecontext run` wrapper: the door reads the registry before it
      // composes. Its ticket names the reviewer to checkpoint, so it owes
      // nothing, writes no checkpoint and is not sent back.
      const next = await runWorker(w, {
        spawner: 'wrapper', prompt: 'continue the login form', ticket: ticketFields(w, { checkpointer: 'reviewer' }), plan: { first: {} },
      }, 'next')
      expect([next.exitCode, next.log.length], next.stderr).toEqual([0, 1])
      expect(next.sessionId).not.toBe(w.legs!['worker']!.sessionId)
    } else sessionStartHook(w, 'resume')
    w.moments!['after-read'] = Date.now() / 1000
    w.facts!['reader'] = reader
  })

  define(/^the worker's registration reads retired as a phantom, with the moment it was noticed and the (harness's lookup|status call|session-start hook|ticket door) as what noticed it$/, (w, reader) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['noticed_by']]).toEqual(['phantom', READERS[reader]])
    expect(r['noticed_at'] as number).toBeGreaterThanOrEqual(w.moments!['before-read']! - 1)
    expect(r['noticed_at'] as number).toBeLessThanOrEqual(w.moments!['after-read']! + 1)
    if (reader === 'status call') {
      const workers = (w.facts!['status'] as Record<string, unknown>)['workers'] as Record<string, unknown>
      expect((workers['retired_as_phantoms'] as Array<Record<string, unknown>>).map((p) => p['session_id'])).toEqual([w.legs!['worker']!.sessionId])
    }
    if (reader === 'ticket door') {
      // The reader that noticed it is the ticket door of the next worker,
      // a worker registered through that door. (The pass runs before the
      // door composes, in the same transaction and at the same moment as
      // the registration, so the two moments cannot order it; the row's
      // noticed_by, asserted above, is what names the reader.)
      const next = rawRegistration(w, w.legs!['next']!)
      expect([next['kind'], next['door']]).toEqual(['worker', 'ticket'])
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
    await libraryWorker(w, 'worker', { pid: 1, start: 0, host: there })
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
    await libraryWorker(w, 'worker', { pid: child.pid!, start: registered, token, host: hostname() })
  })

  define(/^the process (?:\d+) that started at (?:\d\d:\d\d:\d\d) still running$/, async (w) => {
    const child = sleeper(w)
    const actual = hostProbe.startMoment(child.pid!)
    expect(actual, 'this host reads process start moments').not.toBeNull()
    // The registration carries the start moment the OS reports for it.
    await libraryWorker(w, 'worker', { pid: child.pid!, start: actual, token: hostProbe.startToken?.(child.pid!) ?? null, host: hostname() })
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
    await libraryWorker(w, 'worker', { pid: child.pid!, start: null, host: hostname() })
  })

  define(/^the reply says the worker cannot be told from a successor that took its number$/, (w) => {
    expect(w.lookups![RUN]!.notes.some((n) => n.includes('cannot be told from a successor that took its number'))).toBe(true)
  })
}

/** The words of the fault a scenario sets in the store (a SQLite trigger
 *  refusing any first-moment row), as SQLite raises them. */
const FIRST_MOMENT_REFUSAL = 'this store refuses the first-moment row'

/** The store takes writes again: the fault is dropped through a handle of
 *  its own. */
function dropFirstMomentRefusal(w: WorkersWorld): void {
  const db = new DatabaseSync(w.dbPath!)
  try { db.exec('DROP TRIGGER IF EXISTS refuse_first_moment') } finally { db.close() }
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
  const r = o.log[0]!
  // A `claude -p` child its own session-start hook was the door for (no
  // lane in its environment): its first message is that hook's context.
  if (r.ccSession !== undefined && r.lane === null) return r.context ?? ''
  return r.stdin
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

const WORKER_CLI = /`(codex exec|claude -p|agy -p)`/.source

/** Codex's session start, as the install writes it and Codex runs it: the
 *  block install writes for Codex in ~/.codex/hooks.json from Codex CLI
 *  0.167.0 (the Codex on PATH; D406),
 *  its SessionStart command run through a shell with the hook payload on
 *  stdin. The script it execs is the install's, pointed at this checkout's
 *  source (its interpreter and module pins, the rest untouched), as the
 *  sh-dispatch test points it. */
function runCodexSessionStart(w: WorkersWorld, session: string): void {
  mkdirSync(dirname(agentConfigPath('codex', w.home!)), { recursive: true })
  const install = spawnCli(['install', '--yes', '--agent', 'codex'], { home: w.home!, cwd: w.proj! })
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
  // Code's own session-start hook, or the block `treecontext install
  // --agent codex` writes into Codex's hooks.json (D406), run as Codex runs it (its command, through a
  // shell, the same JSON on stdin). The outline has no Antigravity row
  // (owner, 2026-11-09, under D288): an Antigravity CLI main registers no
  // self, so no parent of it is ever registered; its case is the declared
  // parent of the D294 outline, bound above through the wrapper.
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

  define(/^the worker's registration reads retired$/, (w) => {
    // A run through both spawners (D384's bindings) has a leg of each.
    for (const name of w.facts!['both-spawners'] ? ['worker', 'worker:library'] : ['worker']) {
      const r = rawRegistration(w, w.legs![name]!)
      expect([r['kind'], r['door'], r['ended']], name).toEqual(['worker', 'ticket', 'retired'])
      expect(r['stopped_at']).not.toBeNull()
    }
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
  const startByDoor = async (w: WorkersWorld, o: { role: string; prompt: string; spawner?: Spawner; checkpointer?: string | null; plan?: WorkerPlan }): Promise<void> => {
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
    expect(run.input.argv).toEqual(nodeTsArgs(STANDIN_WORKER))
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
    const log = outOf(w).log[0]!
    if (log.ccSession === undefined) {
      // Through the hook-less door, the wrapper: the row is the first the
      // lane holds, written before the worker started (it saw only it).
      expect(log.laneRowsSeen).toBe(1)
    } else {
      // Through the wrapper of a `claude -p` child: its session-start hook
      // linked the child's own Claude Code session to the lane the door
      // registered, wrote no first moment of its own, and the child's
      // captured rows landed in the lane after it.
      const lane = outOf(w).sessionId!
      const links = JSON.parse(String(rawRegistration(w, w.legs!['worker']!)['client_sessions'])) as Array<{ id: string; linked_by: string }>
      expect(links.map((l) => [l.id, l.linked_by])).toEqual([[log.ccSession, 'session-start hook']])
      const rows = laneRows(w, lane)
      expect(rows.filter((x) => x.kind === FIRST_MOMENT_KIND)).toHaveLength(1)
      expect(rows.length).toBeGreaterThan(1)
      // After it: the child's hook captures (its own session kept beside),
      // the note it wrote through its own tools (the server inside it
      // stamped it into the lane), and its return.
      const note = rows.find((x) => x.content === CHILD_NOTE)
      expect(note, 'the note the child wrote through its tools').toBeTruthy()
      expect([note!.m['_writer'], note!.m['_writer_agent_id'], note!.m['_writer_src']]).toEqual(['builder', WORKER_AGENT_ID, 'declared'])
      // Its insert's echo landed in the lane as the child's capture, and the
      // drain healed nothing from it (a worker's lane is stamped exactly).
      const echo = rows.find((x) => x.m['tool_name'] === 'mcp__treecontext__treecontext_insert')
      expect(echo, 'the insert echo').toBeTruthy()
      expect([echo!.m['_client_session_id'], echo!.m['_writer'], echo!.m['_door']]).toEqual([log.ccSession, 'builder', 'hooks'])
      expect(note!.m['_writer_heal_note']).toBeUndefined()
      expect(rows.slice(1).every((x) => x.m['_client_session_id'] === log.ccSession || x.kind === SUBAGENT_SUMMARY_KIND || x === note)).toBe(true)
      expect(rawAll(w, 'SELECT 1 FROM nodes WHERE session_key = ?', log.ccSession)).toHaveLength(0)
    }
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
    // The spawner's own search is scoped to its lane (D374), which holds a
    // worker's return but not its first moment, the worker's own capture in
    // the worker's lane: the default says so and how to widen, and the
    // widened search is the one that reaches the row.
    const own = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'quokkaconfig deploy configuration', top_k: 5 } }))
    expect(own['scope']).toMatchObject({ lane: 'main', widen: 'pass scope "all" to search the whole store' })
    const r = parseTool(await w.client!.callTool({ name: 'treecontext_query', arguments: { query: 'quokkaconfig deploy configuration', top_k: 5, scope: 'all' } }))
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

  // ── D291: a checkpoint another writer leaves under the key while it runs ──

  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", with the ticket naming the worker as its checkpointer$`), async (w, _cli, key) => {
    await openRunWorld(w)
    // Checkpoint number 1 is in effect when the worker starts.
    await seedCheckpoints(w, RUN, key, 1, 'builder')
    const spec = owing(w, 'wrapper', { key })
    // The ticket names the worker to checkpoint and says nothing about a
    // way to write (read as declaring one, D340): owed, it would be sent
    // back.
    delete (spec.ticket as TicketFields).canWrite
    const go = join(w.home!, 'other-writer-go')
    w.facts!['go'] = go
    // It writes two notes, waits while the other writer checkpoints, and
    // exits with no checkpoint of its own; a re-run, were there one,
    // would write a note and nothing else.
    spec.plan = { first: { notes: 2, waitFor: go, print: 'wired half the submit' }, rerun: { notes: 1, label: 'second run' } }
    w.facts!['spec'] = spec
  })

  define(/^the main agent writes checkpoint number (\d+) under "([^"]+)" while the worker runs, and the worker then exits having written none itself$/, async (w, num, key) => {
    const go = w.facts!['go'] as string
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${go}.ready`)
      // The worker is running. The main agent writes through the tools on
      // its own session, superseding number 1, its echo fired as Claude
      // Code fires it and drained.
      const reply = await insertEchoed(w, null, 'state: the main agent wired the submit itself; next: the error states',
        { kind: 'checkpoint', run: RUN, key }, [w.cps![cpLabel(RUN, key, 1)]!])
      w.ids!['main-checkpoint'] = reply['node_id'] as string
      await drainStaging(w)
      // Still running when the checkpoint landed: registered, not ended.
      w.facts!['while-running'] = rawAll<{ ended: string | null }>(w, "SELECT ended FROM session_registry WHERE kind = 'worker'")
      writeFileSync(go, 'go')
    })
    expect(w.facts!['while-running']).toEqual([{ ended: null }])
    const mine = rawCheckpoints(w, RUN, key).find((c) => c.node_id === w.ids!['main-checkpoint'])
    expect(mine?.n, 'the main agent\'s checkpoint, numbered by the store').toBe(Number(num))
    // The worker wrote none: every checkpoint under the key is the seed's or the main agent's.
    expect(rawCheckpoints(w, RUN, key).map((c) => c.node_id)).toEqual([w.cps![cpLabel(RUN, key, 1)], w.ids!['main-checkpoint']])
  })

  define(/^the wrapper runs the worker no second time, and its registration reads retired with no send-back counted$/, (w) => {
    const o = outOf(w)
    expect(o.spawner).toBe('wrapper')
    // One process, one run, as the stand-in recorded and the registration holds.
    expect(o.log.map((r) => r.rerun)).toEqual([false])
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['kind'], reg['ended'], reg['send_backs'], reg['checkpointer']]).toEqual(['worker', 'retired', 0, 'builder'])
    expect((JSON.parse(String(reg['processes'])) as Array<{ pid: number }>).map((p) => p.pid)).toEqual([o.log[0]!.pid])
    // Its lane: the door's first moment, its two notes, its return; no
    // send-back row between them.
    expect(laneRows(w, o.sessionId!).map((r) => r.kind)).toEqual(['first-moment', null, null, 'subagent-summary'])
    // The spawner's line: exited once and retired, the pointer after.
    expect(o.line).toMatch(/ exited with code 0 and is retired; its return is the summary row [0-9a-f]{32} /)
    expect(o.stdout).toBe('wired half the submit')
  })

  define(/^the harness's lookup receives number (\d+) as the one in effect, flagged against the named checkpointer$/, (w, num) => {
    const l = harnessLookup(w)
    expect(l.checkpoints.map((c) => [c.number, c.nodeId])).toEqual([[Number(num), w.ids!['main-checkpoint']]])
    const cp = l.checkpoints[0]!
    // The main agent wrote it; the ticket named the builder.
    expect(cp.writer).toBe('main')
    const reply = keyLookupReply(l)
    expect(reply.named_checkpointer.names).toEqual(['builder'])
    expect(reply.checkpoints[0]!.flag, 'the checkpoint is flagged').toBeTruthy()
    expect(reply.checkpoints[0]!.flag).toContain(`"${cp.writer}"`)
    expect(reply.checkpoints[0]!.flag).toContain('is not the checkpointer')
    expect(reply.checkpoints[0]!.flag).toContain('"builder"')
    // The leg that wrote none is shown retired, its own checkpoints none.
    const leg = l.legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)
    expect([leg?.state, leg?.checkpointsWritten]).toEqual(['retired', 0])
  })

  define(/^the second run exits with no checkpoint written$/, async (w) => {
    await runWorker(w, specOf(w))
  })

  define(/^the (`treecontext run` wrapper|wrapper|library call) runs the worker once more with the reason naming the missing checkpoint under "([^"]+)"$/, (w, by, key) => {
    const o = outOf(w)
    expect(o.spawner).toBe(by === 'library call' ? 'library' : 'wrapper')
    expect(o.log.map((r) => r.rerun)).toEqual([false, true])
    const second = o.log[1]!.stdin
    expect(second).toContain(sendBackReason('builder', RUN, key))
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

  // The door of a worker whose hooks do not run (reworded 2026-11-09 from
  // "hook-less", D406: a Codex worker's hooks may run now): the stand-in
  // worker, which runs no hook, through the real `treecontext run`.
  define(new RegExp(`^a worker starts through the door of a ${WORKER_CLI} worker whose hooks do not run with the spawner's prompt "([^"]+)"$`), async (w, _cli, prompt) => {
    await startByDoor(w, { role: 'builder', prompt, spawner: 'wrapper', checkpointer: 'reviewer', plan: { first: {} } })
  })
  define(new RegExp(`^a ticket in the environment, (truncated after the role "builder"|minted in an older shape that still reads as the role "reviewer"), so that the door of a ${WORKER_CLI} worker whose hooks do not run cannot read it whole$`), async (w, damage, _cli) => {
    await openRunWorld(w)
    const raw = damage!.startsWith('truncated')
      ? truncatedAfterRole('builder')
      // An older treecontext's shape: no version this build knows, the
      // task by another name, the parent as a bare session.
      : JSON.stringify({ ticket_version: 0, v: 0, role: 'reviewer', task: 'login-form', session: 'p1' })
    w.facts!['raw'] = raw
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: raw, plan: { first: { invalidRow: true, print: 'my instructions were invalid; stopped' } } } satisfies WorkerSpec
  })
  define(new RegExp(`^the worker starts through the door of a ${WORKER_CLI} worker whose hooks do not run$`), async (w, _cli) => {
    await runWorker(w, specOf(w))
  })

  // ── D410: a `codex exec` worker with Codex's hooks ──────────────────
  // The worker is started by the real `treecontext run`; the process the
  // door launches is the stand-in (no model), which writes its environment
  // to a file and waits. While it runs, Codex's hooks fire as the recorded
  // ticketed worker's did on 2026-11-09 (tests/fixtures/codex-hooks,
  // worker.ndjson): its start, a shell command and its turn's end, replayed
  // through the commands of Codex's block with the environment the door
  // handed the worker (its ticket and lane, the two variables the
  // recording shows every hook held). The worker's Codex session is the
  // recorded one.
  define(/^a `codex exec` worker at Codex CLI 0\.167\.0, with the hooks install wrote trusted, started by the wrapper under the key "([^"]+)" with the role "([^"]+)"$/, async (w, key, role) => {
    await openRunWorld(w)
    const go = join(w.home!, `codex-worker-go-${randomUUID().slice(0, 8)}`)
    const envFile = join(w.home!, `codex-worker-env-${randomUUID().slice(0, 8)}.json`)
    w.facts!['go'] = go
    w.facts!['env-file'] = envFile
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button',
      ticket: ticketFields(w, { key: String(key), role: String(role), checkpointer: 'reviewer' }),
      plan: { first: { envTo: envFile, waitFor: go } },
    } satisfies WorkerSpec
  })
  define(/^its hooks receive, as Codex sends them, its start, a shell command it runs and the end of its turn$/, async (w) => {
    const events = recordedSession('0.167.0', 'worker.ndjson', 'codex')
    const shell = events.find((e) => e['hook_event_name'] === 'PostToolUse' && e['tool_name'] === 'Bash')!
    const picked = new Set([
      events.find((e) => e['hook_event_name'] === 'SessionStart')!,
      ...events.filter((e) => e['tool_use_id'] === shell['tool_use_id']),
      events.find((e) => e['hook_event_name'] === 'Stop')!,
    ])
    w.facts!['codex-session'] = String(events[0]!['session_id'])
    w.facts!['codex-shell'] = shell
    w.facts!['codex-stop'] = events.find((e) => e['hook_event_name'] === 'Stop')
    const go = w.facts!['go'] as string
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${go}.ready`)
      const env = JSON.parse(readFileSync(w.facts!['env-file'] as string, 'utf8')) as Record<string, string>
      expect(env[TICKET_ENV], 'the door handed the worker no ticket').toBeTruthy()
      expect(env[WORKER_SESSION_ENV], 'the door handed the worker no lane').toBeTruthy()
      w.facts!['codex-replay'] = replayRecordedSession(w, events, {
        lines: (_l, e) => picked.has(e), env: { [TICKET_ENV]: env[TICKET_ENV]!, [WORKER_SESSION_ENV]: env[WORKER_SESSION_ENV]! },
      })
      writeFileSync(go, 'go')
    })
    expect(outOf(w).exitCode).toBe(0)
    await drainStaging(w)
  })
  define(/^the store holds no self registration for its Codex session and one first-moment row in the worker's lane$/, (w) => {
    const codex = w.facts!['codex-session'] as string
    expect(rawAll(w, "SELECT kind FROM session_registry WHERE session_id = ? AND agent_id = ''", codex)).toEqual([])
    const lane = outOf(w).sessionId!
    expect(lane).not.toBe(codex)
    const firsts = rawAll<{ n: number }>(w, "SELECT COUNT(*) AS n FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'first-moment'", lane)
    expect(firsts).toEqual([{ n: 1 }])
    // Codex's session is linked to the worker's lane.
    expect(JSON.stringify(rawRegistration(w, { sessionId: lane, agentId: WORKER_AGENT_ID }))).toContain(codex)
  })
  define(/^the shell command and the turn's last assistant message are in the worker's lane with the writer "([^"]+)"$/, (w, writer) => {
    const lane = outOf(w).sessionId!
    const shell = w.facts!['codex-shell'] as Record<string, unknown>
    const stop = w.facts!['codex-stop'] as Record<string, unknown>
    const rows = rawAll<{ c: string | Buffer; m: string }>(w, 'SELECT content AS c, metadata_json AS m FROM nodes WHERE session_key = ?', lane)
      .map((r) => ({ content: decodeContent(r.c), meta: JSON.parse(r.m) as Record<string, unknown> }))
    const call = rows.filter((r) => r.meta['tool_use_id'] === shell['tool_use_id'])
    expect(call, 'the shell command is not in the worker\'s lane').toHaveLength(1)
    expect(call[0]!.meta['_writer']).toBe(writer)
    const reply = rows.filter((r) => r.meta['event'] === 'response' && r.content === stop['last_assistant_message'])
    expect(reply, 'the turn\'s last reply is not in the worker\'s lane').toHaveLength(1)
    expect(reply[0]!.meta['_writer']).toBe(writer)
  })
  define(/^none of its hooks printed anything to Codex, its first moment being the door's$/, (w) => {
    const replay = w.facts!['codex-replay'] as ReplayedEvent[]
    expect(replay.map((r) => r.event)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'])
    for (const r of replay) {
      expect(r.hooks.length, `${r.event} reached no hook`).toBe(1)
      expect(r.stdout.join(''), `${r.event} printed to Codex`).toBe('')
    }
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

  // ── D298, D302, D307: a first-moment row the store refuses ──

  define(/^a brief row for the builder role naming the key "([^"]+)", and a store that refuses the first-moment row at the moment the ticket door composes it$/, async (w, key) => {
    await openRunWorld(w)
    w.facts!['key'] = key
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the login form for the r9 pass', { run: 'r9', key, role: 'builder', checkpointer: 'builder', by: 'harness' })).nodeId
    // A real fault in the real store, set through a handle of its own:
    // SQLite refuses any row whose kind is a first moment, whoever writes
    // it, until it is dropped.
    const db = new DatabaseSync(w.dbPath!)
    try {
      db.exec(`CREATE TRIGGER refuse_first_moment BEFORE INSERT ON nodes
        WHEN json_extract(NEW.metadata_json, '$.kind') = 'first-moment'
        BEGIN SELECT RAISE(ABORT, '${FIRST_MOMENT_REFUSAL}'); END`)
    } finally { db.close() }
    w.defer(() => dropFirstMomentRefusal(w))
  })

  define(/^the ticket door is asked to start a builder worker under the key "([^"]+)" on a run "([^"]+)" no leg has opened$/, async (w, key, run) => {
    // No leg has opened the run: its one row in the file is the brief, and
    // nothing is registered under it.
    expect(rawAll<{ k: string }>(w, "SELECT json_extract(metadata_json, '$.kind') AS k FROM nodes WHERE json_extract(metadata_json, '$.run') = ?", run).map((r) => r.k)).toEqual(['brief'])
    expect(rawAll(w, 'SELECT 1 FROM session_registry WHERE run = ?', run)).toHaveLength(0)
    await runWorker(w, {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { run, key, role: 'builder', checkpointer: 'builder' }), plan: { first: { notes: 1 } },
    })
  })

  define(/^the ticket door starts no worker and the spawner is told in words that nothing was written$/, (w) => {
    const o = outOf(w)
    // The wrapper's own exit (EX_TEMPFAIL), and no worker process ran: the
    // stand-in never recorded a run.
    expect([o.exitCode, o.log.length, existsSync(o.logPath)]).toEqual([75, 0, false])
    expect(o.stdout).toBe('')
    expect(o.line).toMatch(/^treecontext: .*no worker was started and nothing was written\.$/)
    // What stopped it is the store's refusal of the composed first-moment
    // row: the fault's own words reach the spawner.
    expect(o.line).toContain(FIRST_MOMENT_REFUSAL)
  })

  define(/^once the store takes writes again, it holds no registration for that worker, no first-moment row and no open row for "([^"]+)"$/, async (w, run) => {
    dropFirstMomentRefusal(w)
    // It takes writes again: a note lands and reads back from the file.
    const note = await w.store!.insert('harness note: the store takes writes again', {})
    const raw = readerOf(w)
    expect(raw.prepare('SELECT node_id FROM nodes WHERE node_id = ?').all(note.nodeId)).toHaveLength(1)
    // No registration for the worker: the only one in the file is the
    // session's self, registered by its session-start hook.
    expect(raw.prepare('SELECT session_id, agent_id FROM session_registry').all().map((r) => ({ ...r }))).toEqual([{ session_id: w.sessionId, agent_id: '' }])
    // Every row naming the run is the brief: no open row, no first moment.
    expect(raw.prepare("SELECT node_id, json_extract(metadata_json, '$.kind') AS k FROM nodes WHERE json_extract(metadata_json, '$.run') = ?").all(run).map((r) => ({ ...r })))
      .toEqual([{ node_id: w.ids!['brief'], k: 'brief' }])
    // And no first-moment row anywhere in the file, in any lane: the kind
    // the fault matched on (its refusal reached the spawner) is in no row.
    const kinds = (raw.prepare("SELECT DISTINCT json_extract(metadata_json, '$.kind') AS k FROM nodes").all() as Array<{ k: string | null }>).map((r) => r.k)
    expect(kinds).toContain('brief')
    expect(kinds.filter((k) => k === 'first-moment' || k === 'run-open')).toEqual([])
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

// ── The `claude -p` child through its hooks (unit 4 of the beta.3 build) ──
//
// D295, D298, D303, D342: the worker here is the stand-in `claude -p` child
// (tests/helpers/standin-claude-p.ts), which fires the REAL hooks Claude
// Code fires, as subprocesses with the platform's payloads and its own
// environment, the ticket and the lane the spawner put there inherited:
// SessionStart, UserPromptSubmit, PostToolUse and Stop. The wrapper that
// spawns it is the real `treecontext run`; a child with no wrapper holds
// its ticket alone. Every Then reads the hooks' output as the child
// recorded it, the wrapper's line, or the store file.

const STANDIN_FINAL = 'half the submit wired; stopping'
const CHILD_NOTE = 'note: the submit handler is wired to /api/login (written through the tools)'
// A brief and a checkpoint whose words the child's identity line could
// carry only by copying them.
const IDENTITY_BRIEF = 'BRIEF: implement credential validation, inline error banners and keyboard navigation across the signup fields'
const IDENTITY_CHECKPOINT = 'STATE: password strength meter rendered; remaining: debounce, accessibility labelling, analytics instrumentation'

function claudeChildSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(/^a worker starts through the wrapper of a `claude -p` child, whose session-start hook links the lane with the spawner's prompt "([^"]+)"$/, async (w, prompt) => {
    await runWorker(w, {
      spawner: 'wrapper', prompt: prompt!, ticket: ticketFields(w, { role: 'builder', checkpointer: 'reviewer' }),
      plan: { first: {} }, claudeP: { tools: 2, toolNotes: [CHILD_NOTE], final: STANDIN_FINAL },
    })
    expect(outOf(w).log[0]!.ccSession, 'the claude -p stand-in ran').toBeTruthy()
    await drainStaging(w)
  })

  define(/^a `codex exec` worker and a `claude -p` child each start with the spawner's prompt "([^"]+)"$/, async (w, prompt) => {
    const ticket = ticketFields(w, { role: 'builder', checkpointer: 'reviewer' })
    await runWorker(w, { spawner: 'wrapper', prompt: prompt!, ticket, plan: { first: {} } }, 'codex')
    await runWorker(w, { spawner: 'wrapper', prompt: prompt!, ticket, plan: { first: {} }, claudeP: { tools: 1, final: STANDIN_FINAL } }, 'claude')
    await drainStaging(w)
  })

  const firstMomentOf = (raw: DatabaseSync, lane: string): Record<string, unknown> => {
    const rows = raw.prepare("SELECT * FROM nodes WHERE session_key = ? AND json_extract(metadata_json, '$.kind') = 'first-moment'").all(lane) as Array<Record<string, unknown>>
    expect(rows, `one first-moment row in ${lane}`).toHaveLength(1)
    return rows[0]!
  }

  // What differs between two doors' rows by construction: the row's own
  // identity, its moments, its lane and its writer stamp.
  const OWN_COLUMNS = new Set(['node_id', 'created_at', 'updated_at', 'session_key', 'last_accessed_at'])
  const STAMP_KEYS = new Set(['session_id', '_cc_session_id', '_writer', '_writer_src', '_writer_agent_id'])

  define(/^a reader with the store file and plain SQL sees the two first-moment rows equal column for column apart from their writer stamps, lanes and moments$/, (w) => {
    const raw = readerOf(w)
    const a = firstMomentOf(raw, outOf(w, 'codex').sessionId!)
    const b = firstMomentOf(raw, outOf(w, 'claude').sessionId!)
    const differing = Object.keys(a).filter((c) => JSON.stringify(a[c]) !== JSON.stringify(b[c]))
    for (const c of differing.filter((x) => x !== 'metadata_json')) expect(OWN_COLUMNS.has(c), `column ${c} differs`).toBe(true)
    const ma = JSON.parse(String(a['metadata_json'])) as Record<string, unknown>
    const mb = JSON.parse(String(b['metadata_json'])) as Record<string, unknown>
    for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
      if (STAMP_KEYS.has(k)) continue
      expect(mb[k], `metadata ${k}`).toEqual(ma[k])
    }
    expect([ma['session_id'], mb['session_id']]).toEqual([outOf(w, 'codex').sessionId, outOf(w, 'claude').sessionId])
    // The claude -p child's own session-start hook ran, and wrote no row
    // of its own into the lane's head.
    expect(outOf(w, 'claude').log[0]!.systemMessage).toContain('worker of the lane')
  })

  define(/^no file outside the store is needed to read what either worker saw$/, (w) => {
    const raw = readerOf(w)
    for (const name of ['codex', 'claude']) {
      const o = outOf(w, name)
      const row = firstMomentOf(raw, o.sessionId!)
      const reg = raw.prepare("SELECT * FROM session_registry WHERE session_id = ? AND agent_id = 'worker'").get(o.sessionId!) as Record<string, unknown>
      // Recomposed from the file alone, through a read-only handle: the
      // first message the worker received on its stdin, byte for byte.
      const facts = firstMomentFactsOf(raw, null, {
        run: String(reg['run']), key: reg['run_key'] as string, role: String(reg['agent_type']),
        checkpointer: reg['checkpointer'] as string | null, checkpointedBy: reg['checkpointed_by'] as string | null,
        self: { sessionId: o.sessionId!, agentId: WORKER_AGENT_ID },
      })
      expect(composeFirstMessage(facts, decodeContent(row['content'] as Buffer | string))).toBe(o.log[0]!.stdin)
    }
  })

  const handEdited = (): string => {
    const t = JSON.parse(mintTicket({ run: RUN, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } })) as Record<string, unknown>
    delete t['run']
    return JSON.stringify(t)
  }
  const truncated = (): string => {
    const t = mintTicket({ run: RUN, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } })
    return t.slice(0, t.indexOf('"role":"builder"') + '"role":"builder"'.length)
  }

  define(/^a ticket in the environment, (hand-edited so that the run is missing|truncated after the role "builder"), so that the session-start hook of a `claude -p` child cannot read it whole$/, async (w, damage) => {
    await openRunWorld(w)
    const raw = damage!.startsWith('hand-edited') ? handEdited() : truncated()
    expect(readTicket(raw).valid).toBe(false)
    w.facts!['raw'] = raw
    // The child holds the ticket alone, no wrapper: its own session-start
    // hook is the door. It does what its first message asks: one row
    // saying its instructions were invalid (its turn's text, captured by
    // its Stop hook), and a stop.
    w.facts!['spec'] = {
      spawner: 'none', prompt: '', ticket: raw, plan: { first: {} },
      claudeP: { final: 'my instructions were invalid; I did no work and stop here' },
    } satisfies WorkerSpec
  })

  define(/^the worker starts through the session-start hook of a `claude -p` child$/, async (w) => {
    await runWorker(w, specOf(w))
    await drainStaging(w)
    const log = outOf(w).log[0]!
    // The hook registered the child in its own session's lane, the worker
    // row the one row there: no self, and its context is the statement
    // that its instructions were invalid.
    expect(log.lane).toBeNull()
    expect(rawAll(w, 'SELECT agent_id FROM session_registry WHERE session_id = ?', log.ccSession)).toEqual([{ agent_id: WORKER_AGENT_ID }])
    expect(log.context).toContain('your instructions were invalid')
    const fm = laneRows(w, log.ccSession!)[0]!
    expect(fm.kind).toBe(FIRST_MOMENT_KIND)
    expect(fm.content).toMatch(/through the session-start hook of a `claude -p` child: its ticket could not be read whole/)
  })

  define(/^a ticket in the environment naming the parent "([^"]+)", the run "([^"]+)", the key "([^"]+)" and the role "([^"]+)"$/, async (w, parent, run, key, role) => {
    await openRunWorld(w)
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: build the login form', { run: run!, key: key!, role: role!, checkpointer: 'reviewer', by: 'harness' })).nodeId
    w.facts!['spec'] = {
      spawner: 'none', prompt: '', plan: { first: {} },
      ticket: { run: run!, key: key!, role: role!, checkpointer: 'reviewer', parent: { id: parent!, cli: 'claude-code' } },
      claudeP: { tools: 2, final: 'looked at the login form; nothing to wire yet' },
    } satisfies WorkerSpec
  })

  define(/^a `claude -p` process starts and its session-start hook fires$/, async (w) => {
    await runWorker(w, specOf(w))
    await drainStaging(w)
  })

  define(/^the store holds a worker registration for it with the role "([^"]+)", the run "([^"]+)", the key "([^"]+)" and the parent "([^"]+)", marked as the ticket door read by the hook$/, (w, role, run, key, parent) => {
    const log = outOf(w).log[0]!
    const lane = log.ccSession!
    const reg = rawRegistration(w, { sessionId: lane, agentId: WORKER_AGENT_ID })
    expect([reg['kind'], reg['agent_type'], reg['run'], reg['run_key'], reg['parent_session'], reg['parent_src']]).toEqual(['worker', role, run, key, parent, 'declared'])
    // The ticket door, read by the hook: the door is the ticket's, and the
    // child's own session is linked, by the session-start hook, at its start.
    expect([reg['door'], reg['identity']]).toEqual(['ticket', 'declared'])
    const links = JSON.parse(String(reg['client_sessions'])) as Array<{ id: string; linked_by: string; at: number }>
    expect(links.map((l) => [l.id, l.linked_by])).toEqual([[lane, 'session-start hook']])
    expect(Math.abs(links[0]!.at - Number(reg['started_at']))).toBeLessThan(5)
    const procs = JSON.parse(String(reg['processes'])) as Array<{ pid: number }>
    expect(procs.map((p) => p.pid)).toEqual([log.pid])
    // Its first moment, composed from the store by the hook, is the first
    // row of its lane and is what the hook handed it.
    const rows = laneRows(w, lane)
    expect(rows[0]!.kind).toBe(FIRST_MOMENT_KIND)
    expect(rows[0]!.m['refs']).toEqual([w.ids!['brief']])
    expect(log.context).toContain('BRIEF: build the login form')
    expect(log.context).toContain(STATE_NOT_HISTORY_LINE)
  })

  define(/^the store holds no self registration and no beacon for it$/, (w) => {
    const log = outOf(w).log[0]!
    expect(rawAll(w, "SELECT 1 FROM session_registry WHERE session_id = ? AND agent_id = ''", log.ccSession)).toHaveLength(0)
    // The beacon is keyed by the client's process: none names the child.
    expect(readSessionBeacon(w.dbPath!, log.pid)).toBeNull()
  })

  define(/^every row the child writes carries the writer "([^"]+)" and the parent "([^"]+)" as declared$/, (w, writer, parent) => {
    const lane = outOf(w).log[0]!.ccSession!
    const rows = laneRows(w, lane).filter((r) => r.kind !== FIRST_MOMENT_KIND)
    // Its two tool calls and its turn's text, captured by its hooks (its
    // prompt was its own argument, empty here, which the prompt hook skips).
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const r of rows) {
      expect([r.m['_writer'], r.m['_parent'], r.m['_parent_src'], r.m['_writer_agent_id'], r.m['_door']], r.content.slice(0, 80))
        .toEqual([writer, parent, 'declared', WORKER_AGENT_ID, 'hooks'])
    }
    expect(rawAll(w, "SELECT 1 FROM nodes WHERE json_extract(metadata_json, '$._writer') = 'main'")).toHaveLength(0)
  })

  // ── D295, D298: the child the wrapper started is told who it is, once ──

  define(/^a `claude -p` worker started by the wrapper under the key "([^"]+)", with a brief and a checkpoint in effect$/, async (w, key) => {
    await openRunWorld(w)
    w.ids!['brief'] = (await w.store!.writeBrief(IDENTITY_BRIEF, { run: RUN, key, role: 'builder', checkpointer: 'reviewer', by: 'harness' })).nodeId
    const cp = await w.store!.writeCheckpoint(IDENTITY_CHECKPOINT, { run: RUN, key, declared: { role: 'reviewer' } })
    w.ids!['checkpoint'] = cp.nodeId
    expect(w.store!.checkpointsInEffect(RUN, key).map((c) => c.nodeId)).toEqual([cp.nodeId])
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { key, role: 'builder', checkpointer: 'reviewer' }),
      plan: { first: {} }, claudeP: { tools: 1, final: STANDIN_FINAL },
    } satisfies WorkerSpec
  })

  define(/^the child's session-start hook fires$/, async (w) => {
    // The child fires it itself, as Claude Code does at its start, with the
    // ticket and the lane the wrapper put in its environment.
    await runWorker(w, specOf(w))
    await drainStaging(w)
    const log = outOf(w).log[0]
    expect(log?.ccSession, 'the claude -p stand-in ran').toBeTruthy()
    expect(log!.lane, 'the wrapper named the lane').toBe(outOf(w).sessionId)
  })

  /** What the child's session-start hook printed, as Claude Code reads it:
   *  its hookSpecificOutput's additionalContext. */
  const emittedContext = (w: WorkersWorld): string => {
    const out = JSON.parse((outOf(w).log[0]!.startStdout ?? '').trim() || '{}') as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown } }
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    const ctx = out.hookSpecificOutput?.additionalContext
    expect(typeof ctx, 'the hook emitted context').toBe('string')
    return ctx as string
  }

  define(/^the context the hook emits is one line naming the worker's role, run, key and lane and its first-moment row by id, and saying no re-orientation packet follows$/, (w) => {
    const o = outOf(w)
    const ctx = emittedContext(w)
    // One line: nothing before it, nothing after it.
    expect(ctx.split(/\r?\n/)).toEqual([ctx])
    expect(ctx.trim()).toBe(ctx)
    // The registration the wrapper made, and the lane's one first-moment
    // row, read from the file.
    const raw = readerOf(w)
    const reg = raw.prepare("SELECT agent_type AS role, run, run_key AS key FROM session_registry WHERE session_id = ? AND agent_id = 'worker'").get(o.sessionId!) as { role: string; run: string; key: string }
    expect({ ...reg }).toEqual({ role: 'builder', run: RUN, key: 'login-form' })
    const firsts = raw.prepare("SELECT node_id FROM nodes WHERE json_extract(metadata_json, '$.kind') = 'first-moment'").all() as Array<{ node_id: string }>
    // Not spent twice: the one first-moment row in the whole file is the
    // wrapper's, in the lane; the hook wrote none of its own.
    expect(firsts).toHaveLength(1)
    expect(raw.prepare('SELECT session_key FROM nodes WHERE node_id = ?').get(firsts[0]!.node_id)).toEqual({ session_key: o.sessionId })
    for (const part of [`${reg.role} worker`, `"${reg.run}"`, `"${reg.key}"`, o.sessionId!, firsts[0]!.node_id]) {
      expect(ctx, `the line names ${part}`).toContain(part)
    }
    expect(ctx).toContain('no re-orientation packet follows')
  })

  define(/^that line holds none of the brief's or the checkpoint's text, which the child already received as its prompt$/, (w) => {
    const ctx = emittedContext(w)
    const prompt = outOf(w).log[0]!.stdin
    const brief = rawContentOf(w, w.ids!['brief']!)
    const cp = rawContentOf(w, w.ids!['checkpoint']!)
    // The child's prompt, the wrapper's first message on its stdin, holds
    // both whole ...
    expect(prompt).toContain(brief)
    expect(prompt).toContain(cp)
    // ... and every word of either the line could carry only by copying
    // (seven letters or more) fires on the prompt and not on the line.
    const words = [...new Set(`${brief} ${cp}`.split(/[^A-Za-z]+/).filter((x) => x.length >= 7))]
    expect(words.length).toBeGreaterThanOrEqual(10)
    for (const word of words) {
      expect(prompt, `the prompt holds "${word}"`).toContain(word)
      expect(ctx.includes(word), `the line copies "${word}"`).toBe(false)
    }
    expect(ctx.length).toBeLessThan(prompt.length)
  })

  define(/^a `claude -p` worker started by the wrapper, naming itself as checkpointer, whose stop hook fires before its process exits$/, async (w) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, 'login-form', 3, 'builder')
    w.facts!['spec'] = { ...owingSpec(w), claudeP: { tools: 3, final: STANDIN_FINAL } }
  })

  define(/^the worker stops with no checkpoint under the key "([^"]+)"$/, async (w, key) => {
    expect((specOf(w).ticket as TicketFields).key).toBe(key)
    await runWorker(w, specOf(w))
    await drainStaging(w)
  })

  define(/^the stop hook sends it back once with the reason naming the missing checkpoint under "([^"]+)"$/, (w, key) => {
    const log = outOf(w).log[0]!
    expect(log.sentBack, 'the stop hook blocked').not.toBeNull()
    expect(log.sentBack!).toContain(sendBackReason('builder', RUN, key!))
    expect(log.sentBack!).toContain(`no checkpoint under the key "${key}"`)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect(reg['send_backs']).toBe(1)
    const sent = laneRows(w, outOf(w).sessionId!).filter((r) => r.kind === SEND_BACK_KIND)
    expect(sent).toHaveLength(1)
    expect([sent[0]!.content, sent[0]!.m['_door']]).toEqual([log.sentBack, 'hooks'])
  })

  define(/^when the process then exits with still no checkpoint, the wrapper starts no second run$/, (w) => {
    const o = outOf(w)
    expect(o.log).toHaveLength(1)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect((JSON.parse(String(reg['processes'])) as unknown[]).length).toBe(1)
    expect([reg['send_backs'], reg['ended']]).toEqual([1, 'retired'])
    // The wrapper's line says it exited and was retired, with no send-back
    // of its own between the two (its words when it sends back are
    // "exited with code 0 after its one send-back and is retired").
    expect(o.line).toMatch(/ exited with code \d+ and is retired; /)
  })

  define(/^a `claude -p` worker started by the wrapper, naming itself as checkpointer, whose store refuses writes at the moment its stop hook fires$/, async (w) => {
    await openRunWorld(w)
    await seedCheckpoints(w, RUN, 'login-form', 3, 'builder')
    const before = join(w.home!, 'stop-go')
    const after = join(w.home!, 'exit-go')
    w.facts!['go'] = [before, after]
    w.facts!['spec'] = { ...owingSpec(w), claudeP: { tools: 2, final: STANDIN_FINAL, waitBeforeStop: before, waitAfterStop: after } }
  })

  define(/^the worker stops with no checkpoint and its process exits with the store writable again$/, async (w) => {
    const [before, after] = w.facts!['go'] as [string, string]
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${before}.ready`)
      chmodSync(w.dbPath!, 0o444)
      w.defer(() => { try { chmodSync(w.dbPath!, 0o644) } catch { /* gone */ } })
      writeFileSync(before, 'go')
      await waitForFile(`${after}.ready`)
      chmodSync(w.dbPath!, 0o644)
      writeFileSync(after, 'go')
    })
  })

  define(/^the stop hook sent it back no time$/, (w) => {
    const first = outOf(w).log[0]!
    expect(first.sentBack).toBeNull()
    expect(first.stops!.map((s) => s.trim())).toEqual([''])
  })
}

/** A `claude -p` worker the wrapper spawns, its ticket naming it as the
 *  checkpointer of the key and declaring a way to write. */
function owingSpec(w: WorkersWorld): WorkerSpec {
  return {
    spawner: 'wrapper', prompt: 'wire the submit button',
    ticket: ticketFields(w, { checkpointer: 'builder', canWrite: true }),
    plan: { first: {} },
  }
}

// ── D374, D372: a worker's search and status, every lane flat ──
//
// The spawner and the worktree are real checkouts of one git repository,
// each session started there by the real SessionStart hook, each chapter
// written through the tools by that session (stamped from the registry);
// the worker runs through the real ticket door (the library spawner) and
// reads through its own tools, as a hook-less worker's CLI does (a real
// `treecontext serve` it starts with the ticket and the lane the door
// named): the replies are what that serve said to it, recorded whole.

// ── D391, D288: a worker's curated dedup is its own lane's ──
//
// The main session is a real git checkout's, started by the real
// SessionStart hook and writing through the tools of a server opened under
// its session; each worker runs through the real ticket door (the library
// spawner) and writes through its own tools, a real `treecontext serve` it
// starts with the ticket and the lane the door named, the reply its CLI
// received recorded whole (the stand-in's `inserts`). Both workers take the
// role "builder", so the writer stamp alone cannot tell their rows apart:
// only the lane, the worker's whole session, does. Every Then reads the
// store file with SQL.

/** The worker's run: one note through its own tools, then "done". */
async function workerInserts(w: WorkersWorld, name: string, text: string): Promise<void> {
  const out = await runWorker(w, {
    spawner: 'library', prompt: 'record what you found about the login form',
    ticket: ticketFields(w, { run: 'r-dedup', key: 'login-form', role: 'builder', checkpointer: 'builder' }),
    plan: { first: { viaTools: true, texts: [text], print: 'done' } },
  }, name)
  expect(out.exitCode).toBe(0)
  const replies = out.log[0]?.inserts ?? []
  expect(replies, 'the reply its CLI received').toHaveLength(1)
  w.facts![`insert:${name}`] = replies[0]
  w.facts!['dedup-text'] = text
}

/** The rows of a text, with their lane, stamp and dedup class, from the file. */
function rowsOfText(w: WorkersWorld, text: string): Array<{ node_id: string; session_key: string; cls: string; m: Record<string, unknown> }> {
  return rawAll<{ node_id: string; session_key: string; cls: string; c: Buffer | string; m: string }>(w,
    'SELECT node_id, session_key, dedup_class AS cls, content AS c, metadata_json AS m FROM nodes ORDER BY created_at, rowid')
    .filter((r) => decodeContent(r.c) === text)
    .map((r) => ({ node_id: r.node_id, session_key: r.session_key, cls: r.cls, m: JSON.parse(r.m) as Record<string, unknown> }))
}

export function workerDedupSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(/^the main session in the main checkout that has inserted the note "([^"]+)"$/, async (w, text) => {
    await openGitSession(w, `cc-${randomUUID().slice(0, 12)}`, 'main')
    const client = await mcpOver(w, { ccSessionId: w.sessionId! })
    const reply = parseTool(await client.callTool({ name: 'treecontext_insert', arguments: { content: text } }))
    expect(reply).toMatchObject({ deduplicated: false, writer: 'main', writer_src: 'self' })
    w.facts!['first'] = { lane: w.sessionId!, writer: 'main', src: 'self', id: reply['node_id'] }
  })
  define(/^a `codex exec` worker that has inserted the note "([^"]+)"$/, async (w, text) => {
    await openGitSession(w, `cc-${randomUUID().slice(0, 12)}`, 'main')
    await workerInserts(w, 'first', text!)
    const reply = w.facts!['insert:first'] as Record<string, unknown>
    expect(reply).toMatchObject({ deduplicated: false, writer: 'builder', writer_src: 'declared' })
    w.facts!['first'] = { lane: outOf(w, 'first').sessionId!, writer: 'builder', src: 'declared', id: reply['node_id'] }
  })
  define(/^a (?:second )?`codex exec` worker inserts "([^"]+)" through its tools$/, async (w, text) => {
    await workerInserts(w, 'second', text!)
  })
  define(/^the store holds two rows of that text, one in each lane, each stamped with its own writer$/, (w) => {
    const first = w.facts!['first'] as { lane: string; writer: string; src: string; id: string }
    const second = outOf(w, 'second').sessionId!
    const rows = rowsOfText(w, w.facts!['dedup-text'] as string)
    expect(rows.map((r) => r.session_key)).toEqual([first.lane, second])
    expect(first.lane).not.toBe(second)
    const [a, b] = rows as [typeof rows[0], typeof rows[0]]
    expect(a.node_id).toBe(first.id)
    expect([a.m['_writer'], a.m['_writer_src']]).toEqual([first.writer, first.src])
    // The worker's row: its role as writer, the door's agent id, its own
    // session, which is its lane (D288), under its registration.
    expect([b.m['_writer'], b.m['_writer_src'], b.m['_writer_agent_id'], b.m['_door']]).toEqual(['builder', 'declared', WORKER_AGENT_ID, 'tools'])
    expect(rawOne(w, "SELECT kind, agent_type FROM session_registry WHERE session_id = ? AND agent_id = 'worker'", second)).toMatchObject({ kind: 'worker', agent_type: 'builder' })
    // A worker's row dedups in its own lane's class; the main session's in the curated one.
    expect(b.cls).toBe('worker_curated')
    expect(a.cls).toBe(first.writer === 'main' ? 'curated' : 'worker_curated')
  })
  define(/^the second insert's reply says its row landed, not that it was deduplicated$/, (w) => {
    const reply = w.facts!['insert:second'] as Record<string, unknown>
    const rows = rowsOfText(w, w.facts!['dedup-text'] as string)
    expect(reply['deduplicated']).toBe(false)
    expect(reply['node_id']).toBe(rows[1]!.node_id)
    expect([reply['writer'], reply['writer_src']]).toEqual(['builder', 'declared'])
    for (const k of ['landed', 'lane', 'caller_lane', 'dedup_note']) expect(reply[k], k).toBeUndefined()
  })
}

const ORIENTATION_QUERY = 'what was I working on, what was the next step'

export function workerLaneSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(/^a spawner in the main checkout holding its live chapter summary, and a worktree "([^"]+)" holding its own$/, async (w, name) => {
    await openGitSession(w, `cc-${randomUUID().slice(0, 12)}`, 'main')
    const spawner = w.sessionId!
    const chapterBy = async (session: string, text: string, writer: string): Promise<string> => {
      const client = await mcpOver(w, { ccSessionId: session })
      const reply = parseTool(await client.callTool({ name: 'treecontext_insert', arguments: { content: text, metadata: { next_session: true } } }))
      expect(reply).toMatchObject({ writer, writer_src: 'self' })
      return reply['node_id'] as string
    }
    w.ids!['main'] = await chapterBy(spawner, 'plan: rewrite the README install section; next: the doctor table', 'main')
    // The worktree: `git worktree add` beside the main checkout, its own
    // session started there by the real hook.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const path = join(dirname(w.proj!), name)
    execFileSync('git', ['worktree', 'add', '-q', '-b', `${name}-branch`, path], { cwd: w.proj!, env })
    const wtSession = `cc-${randomUUID().slice(0, 12)}`
    runHook(w, 'session-start', { session_id: wtSession, hook_event_name: 'SessionStart', source: 'startup', cwd: realpathSync.native(path) })
    w.ids![`worktree:${name}`] = await chapterBy(wtSession, 'plan: scaffold the subproject; next: its first test', `worktree:${name}`)
    w.sessionId = spawner
    w.facts!['lanes'] = ['main', `worktree:${name}`]
  })
  define(/^a worker the spawner launched through the ticket door with its brief and key$/, async (w) => {
    w.ids!['brief'] = (await w.store!.writeBrief('BRIEF: write the doctor table from the README install section', {
      run: 'r-lanes', key: 'doctor-table', role: 'builder', checkpointer: 'builder', by: 'harness',
    })).nodeId
    w.facts!['spec'] = {
      spawner: 'library', prompt: 'write the doctor table',
      ticket: ticketFields(w, { run: 'r-lanes', key: 'doctor-table', role: 'builder', checkpointer: 'builder' }),
      plan: { first: {} },
    } satisfies WorkerSpec
  })
  define(/^the worker searches through its tools and calls status$/, async (w) => {
    const spec = specOf(w)
    spec.plan.first.reads = { query: { query: ORIENTATION_QUERY, top_k: 10 }, status: {} }
    const out = await runWorker(w, spec)
    expect(out.exitCode).toBe(0)
    // A worker of the door, its parent the spawner as its hook registered it.
    expect(rawOne(w, 'SELECT kind, parent_session FROM session_registry WHERE session_id = ?', out.sessionId))
      .toMatchObject({ kind: 'worker', parent_session: w.sessionId })
  })
  define(/^its search covers the whole store, the reply saying a worker searches as its harness feeds it$/, (w) => {
    const reply = outOf(w).log[0]!.reads!.query!
    const scope = reply['scope'] as Record<string, unknown> | undefined
    expect(scope, JSON.stringify(reply).slice(0, 1500)).toMatchObject({ searched: 'the whole store' })
    expect(scope!['worker']).toContain('a worker searches the whole store as its harness feeds it')
    expect(scope!['lane']).toBeUndefined()
    const hits = (reply['results'] as Array<{ nodeId: string }>).map((h) => h.nodeId)
    for (const lane of w.facts!['lanes'] as string[]) expect(hits, lane).toContain(w.ids![lane])
  })
  define(/^its status lists both chapters flat, the block naming it a worker, never calling it unplaced$/, (w) => {
    const reply = outOf(w).log[0]!.reads!.status!
    const pointers = (reply['resume_pointers'] as Array<{ node_id: string; lane?: string }> | undefined) ?? []
    for (const lane of w.facts!['lanes'] as string[]) expect(pointers.map((p) => [p.node_id, p.lane])).toContainEqual([w.ids![lane], lane])
    const scope = reply['scope'] as Record<string, unknown> | undefined
    expect(scope, JSON.stringify(reply).slice(0, 1500)).toBeTruthy()
    expect(scope!['listed']).toBe("every lane's resume pointers, flat, each naming its lane")
    expect(scope!['worker']).toContain('this session is a worker of the ticket door (builder)')
    for (const k of ['unplaced', 'lane', 'left_out', 'other_lanes', 'other_lane_count']) expect(scope![k], k).toBeUndefined()
  })
}

// ── D384, D288: a failed or silent worker's summary row says why ──
//
// The worker is the hook-less stand-in (../standins.ts, its `stderr` plan
// word), launched through the real door by both spawners in turn: the
// `treecontext run` wrapper, a real subprocess whose own stdout and stderr
// bytes are the spawner's side, and the library's spawnWorker, whose
// handed-on chunks are. Each run is a leg of its own in the one store. The
// summary row is read with SQL, its content decoded and its kind read,
// from the id the spawner's line names; treecontext's line is checked by
// its parts here, never by calling the code that composes it.

/** The two spawners every D384 run goes through, the wrapper first. */
const FAILED_RUN_SPAWNERS = [['wrapper', 'worker'], ['library', 'worker:library']] as const

async function runThroughBothSpawners(w: WorkersWorld, spec: WorkerSpec): Promise<void> {
  for (const [spawner, name] of FAILED_RUN_SPAWNERS) await runWorker(w, { ...spec, spawner }, name)
  w.facts!['both-spawners'] = true
}

/** Each outcome of the run, by spawner, with the leg's name. */
function bothOutcomes(w: WorkersWorld): Array<[Spawner, Outcome, string]> {
  expect(w.facts!['both-spawners'], 'the run went through both spawners').toBe(true)
  return FAILED_RUN_SPAWNERS.map(([spawner, name]) => {
    const o = outOf(w, name)
    expect(o.spawner).toBe(spawner)
    return [spawner, o, name]
  })
}

/** The summary row the spawner's line points at, read with SQL. */
function summaryRowOf(w: WorkersWorld, o: Outcome): { content: string; kind: unknown; writer: unknown; session: string } {
  const id = /the summary row ([0-9a-f]{32})/.exec(o.line)?.[1]
  expect(id, `a summary row named in: ${o.line}`).toBeTruthy()
  const row = rawOne<{ c: Buffer | string; m: string; session_key: string }>(w, 'SELECT content AS c, metadata_json AS m, session_key FROM nodes WHERE node_id = ?', id)
  expect(row, `the row ${id} in the store`).toBeTruthy()
  const m = JSON.parse(row!.m) as Record<string, unknown>
  return { content: decodeContent(row!.c), kind: m['kind'], writer: m['_writer'], session: row!.session_key }
}

/** treecontext's line, split into its first line and what follows it. */
function treecontextLine(text: string): { head: string; body: string } {
  expect(text.startsWith('treecontext: '), `treecontext's line opens with its name:\n${text.slice(0, 300)}`).toBe(true)
  const nl = text.indexOf('\n')
  return nl === -1 ? { head: text, body: '' } : { head: text.slice(0, nl), body: text.slice(nl + 1) }
}

/** The spawner's side. The wrapper's own stderr is its own diagnostic
 *  lines (each `[treecontext] …`, before the worker starts), then the
 *  worker's stream as written, then the door's one line on a line of its
 *  own; the library's handed-on chunks are the worker's stream alone.
 *  Stdout is the worker's, byte for byte, through either. */
function spawnerReceived(spawner: Spawner, o: Outcome, stderr: string, stdout: string): void {
  expect(o.stdout, `${spawner}: the output byte for byte`).toBe(stdout)
  if (spawner === 'library') {
    expect(o.stderr, 'the library: the error stream as written').toBe(stderr)
    return
  }
  const tail = `${stderr}${stderr === '' || stderr.endsWith('\n') ? '' : '\n'}${o.line}\n`
  expect(o.line).toMatch(/^treecontext: /)
  expect(o.stderr.endsWith(tail), `the wrapper: the error stream as written, then the door's line:\n${o.stderr.slice(-600)}`).toBe(true)
  const own = o.stderr.slice(0, o.stderr.length - tail.length)
  for (const l of own.split('\n').filter((x) => x !== '')) expect(l, 'only the wrapper\'s own diagnostic lines before the worker\'s stream').toMatch(/^\[treecontext\] /)
}

export function failedRunSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  // D288, amended by D384: a clean exit after printing keeps its output alone.
  define(/^the worker prints "([^"]+)" as its last output, writes "([^"]+)" to its error stream, and exits with code (\d+)$/, async (w, printed, err, code) => {
    w.facts!['printed'] = printed
    w.facts!['stderr'] = `${err}\n`
    await runThroughBothSpawners(w, { ...specOf(w), plan: { first: { print: printed, stderr: `${err}\n`, exit: Number(code) } } })
  })

  define(/^the spawner is handed one line pointing at a summary row reading "([^"]+)" with the writer "([^"]+)", and nothing from its error stream$/, (w, text, writer) => {
    for (const [spawner, o] of bothOutcomes(w)) {
      expect(o.line, `${spawner}: one line`).toMatch(/^treecontext: [^\n]+\.$/)
      expect(o.line).toContain(`writer "${writer}"`)
      const row = summaryRowOf(w, o)
      expect([row.content, row.kind, row.writer, row.session], spawner).toEqual([text, SUBAGENT_SUMMARY_KIND, writer, o.sessionId])
      spawnerReceived(spawner, o, String(w.facts!['stderr']), text)
    }
  })

  // D384's outline: a failed or silent run.
  define(/^the worker prints (nothing|"[^"]+") to its output, writes "([^"]+)" to its error stream, and exits with code (\d+)$/, async (w, output, err, code) => {
    const printed = output === 'nothing' ? '' : output.slice(1, -1)
    w.facts!['printed'] = printed
    w.facts!['stderr'] = `${err}\n`
    await runThroughBothSpawners(w, { ...specOf(w), plan: { first: { ...(printed !== '' ? { print: printed } : {}), stderr: `${err}\n`, exit: Number(code) } } })
  })

  define(/^the summary row the spawner's line points at reads (nothing|"[^"]+"), then treecontext's line naming the exit code (\d+) and the end of its error stream, "([^"]+)"$/, (w, output, code, err) => {
    const printed = output === 'nothing' ? '' : output.slice(1, -1)
    for (const [spawner, o] of bothOutcomes(w)) {
      const row = summaryRowOf(w, o)
      expect([row.kind, row.writer, row.session], spawner).toEqual([SUBAGENT_SUMMARY_KIND, 'builder', o.sessionId])
      let rest = row.content
      if (printed !== '') {
        expect(rest.startsWith(`${printed}\n\n`), `${spawner}: the output first:\n${rest}`).toBe(true)
        rest = rest.slice(printed.length + 2)
      }
      const { head, body } = treecontextLine(rest)
      expect(head, spawner).toMatch(new RegExp(`\\bexited with code ${code}\\b`))
      expect(head.includes('printed nothing'), spawner).toBe(printed === '')
      // step-lint: allow unearned-absence -- the long-stream step ("a long error stream is kept as its end") asserts this same needle present in the same line's head, and the cut-marker mutation turns it red
      expect(head).not.toContain('the earlier part was left out')
      // The stream whole, as the worker wrote it, and nothing after it.
      expect(body, spawner).toBe(`${err}\n`)
      // The spawner's line and exit code name the same exit.
      expect(o.line).toContain(`exited with code ${code}`)
      expect(o.exitCode).toBe(Number(code))
    }
  })

  define(/^the spawner received the error stream as the worker wrote it, and the output byte for byte$/, (w) => {
    for (const [spawner, o] of bothOutcomes(w)) spawnerReceived(spawner, o, String(w.facts!['stderr']), String(w.facts!['printed']))
  })

  // A long stream: its end, marked as cut.
  define(new RegExp(`^an? ${WORKER_CLI} worker under the run "([^"]+)", whose ticket names the reviewer as the one who will checkpoint$`), async (w, _cli, run) => {
    await openRunWorld(w)
    w.facts!['spec'] = { spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { run, checkpointer: 'reviewer' }), plan: { first: {} } } satisfies WorkerSpec
  })

  define(/^the worker writes (\d+) characters to its error stream, the last line "([^"]+)", and exits with code (\d+)$/, async (w, n, last, code) => {
    // Numbered lines, each with a character UTF-8 writes in two bytes, so
    // characters and bytes differ; the stream ends on its last line.
    const total = Number(n)
    let filler = ''
    for (let i = 1; filler.length < total; i++) filler += `stderr line ${String(i).padStart(5, '0')}: réessai of the request\n`
    const stream = `${filler.slice(0, total - last.length - 1)}\n${last}`
    expect(stream.length).toBe(total)
    w.facts!['stderr'] = stream
    w.facts!['printed'] = ''
    await runThroughBothSpawners(w, { ...specOf(w), plan: { first: { stderr: stream, exit: Number(code) } } })
  })

  define(/^the summary row holds the last (\d+) characters of the error stream, ending "([^"]+)", and says the earlier part was left out$/, (w, n, last) => {
    const stream = String(w.facts!['stderr'])
    for (const [spawner, o] of bothOutcomes(w)) {
      const row = summaryRowOf(w, o)
      expect(row.kind).toBe(SUBAGENT_SUMMARY_KIND)
      const { head, body } = treecontextLine(row.content)
      expect(head, spawner).toContain('the earlier part was left out')
      expect(head).toMatch(/\bexited with code 1\b/)
      // The marker's total counts characters, not bytes: the stream's filler
      // is multi-byte, so the two differ.
      const chars = [...stream].length
      expect(Buffer.byteLength(stream)).toBeGreaterThan(chars)
      expect(head, spawner).toContain(`the last ${n} of the ${chars} characters it wrote`)
      // Exactly the stream's last characters: none fewer, none more.
      expect(body.length, spawner).toBe(Number(n))
      expect(body).toBe(stream.slice(-Number(n)))
      expect(body.endsWith(last)).toBe(true)
    }
  })

  define(/^the spawner received all (\d+) characters$/, (w, n) => {
    const stream = String(w.facts!['stderr'])
    expect(stream.length).toBe(Number(n))
    for (const [spawner, o] of bothOutcomes(w)) spawnerReceived(spawner, o, stream, '')
  })

  // Failed, run once more, failed again: the last run's reason.
  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)", naming itself as checkpointer$`), async (w, _cli, key) => {
    await openRunWorld(w)
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button',
      ticket: ticketFields(w, { key, checkpointer: 'builder' }), plan: { first: {} },
    } satisfies WorkerSpec
  })

  define(/^its first run writes "([^"]+)" to its error stream and exits with code (\d+), and its second run writes "([^"]+)" and exits with code (\d+), neither writing a checkpoint$/, async (w, e1, c1, e2, c2) => {
    w.facts!['stderr'] = `${e1}\n${e2}\n`
    w.facts!['first-error'] = e1
    await runThroughBothSpawners(w, { ...specOf(w), plan: { first: { stderr: `${e1}\n`, exit: Number(c1) }, rerun: { stderr: `${e2}\n`, exit: Number(c2) } } })
  })

  define(/^the summary row names the exit code (\d+) and "([^"]+)"$/, (w, code, err) => {
    for (const [spawner, o, name] of bothOutcomes(w)) {
      // Two runs, the second the send-back's, as the worker recorded them.
      expect(o.log.map((r) => r.rerun), spawner).toEqual([false, true])
      expect(rawRegistration(w, w.legs![name]!)['send_backs']).toBe(1)
      const row = summaryRowOf(w, o)
      expect(row.kind).toBe(SUBAGENT_SUMMARY_KIND)
      const { head, body } = treecontextLine(row.content)
      expect(head, spawner).toMatch(new RegExp(`\\bexited with code ${code}\\b`))
      expect(body, spawner).toBe(`${err}\n`)
      expect(row.content).not.toContain(String(w.facts!['first-error']))
      // Both runs' streams reached the spawner, in order.
      spawnerReceived(spawner, o, String(w.facts!['stderr']), '')
    }
  })
}

// ── D389: no client-session variable handed to a worker ──
//
// The spawner's environment holds Claude Code's session variables and
// two of its settings, with values made here (a token this run alone
// knows). The worker is the stand-in, launched through the real door by
// the spawner the row names: the `treecontext run` wrapper as a real
// subprocess with that environment; the library call given no
// environment, this process's own then holding it (put there for the call
// and restored after); or the library call given it. The stand-in writes
// its whole environment to a file (its `envTo` plan word) and prints none
// of it.

const SPAWNER_ROWS: Record<string, { spawner: Spawner; own?: boolean }> = {
  '`treecontext run` wrapper': { spawner: 'wrapper' },
  "library call, in the process's own environment": { spawner: 'library', own: true },
  'library call, with an environment it passes': { spawner: 'library' },
}

const nameList = (text: string): string[] => text.split(/, | and /).map((s) => s.trim()).filter((s) => s !== '')

export function sessionVariableSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(/^a spawner whose environment holds Claude Code's session variables (.+), and the settings (.+)$/, async (w, sessionText, settingsText) => {
    await openRunWorld(w)
    const session = nameList(sessionText)
    const settings = nameList(settingsText)
    expect(session).toHaveLength(6)
    expect(settings).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK'])
    const token = `tok-${randomUUID()}`
    const values: Record<string, string> = {
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_MESSAGING_TOKEN: token, CLAUDE_CODE_MESSAGING_SOCKET: join(w.home!, 'cc-messaging.sock'),
      CLAUDE_CONFIG_DIR: join(w.home!, 'claude-config'), CLAUDE_CODE_USE_BEDROCK: '1',
    }
    for (const name of [...session, ...settings]) expect(values[name], name).toBeDefined()
    w.facts!['session-vars'] = session
    w.facts!['settings-vars'] = settings
    w.facts!['spawner-env'] = values
    w.facts!['token'] = token
  })

  define(new RegExp(`^the ticket door starts an? ${WORKER_CLI} worker through the (.+)$`), async (w, _cli, row) => {
    const how = SPAWNER_ROWS[row]
    expect(how, `a spawner row: ${row}`).toBeDefined()
    const envFile = join(w.home!, `worker-env-${randomUUID().slice(0, 8)}.json`)
    w.facts!['env-file'] = envFile
    const ticket = ticketFields(w, { checkpointer: 'reviewer' })
    w.facts!['ticket'] = ticket
    await runWorker(w, {
      spawner: how!.spawner, prompt: 'wire the submit button', ticket,
      plan: { first: { envTo: envFile, envToStderr: 'CLAUDE' } },
      spawnerEnv: w.facts!['spawner-env'] as Record<string, string>, ...(how!.own ? { libraryOwnEnv: true } : {}),
    })
    expect(outOf(w).exitCode).toBe(0)
  })

  const workerEnv = (w: WorkersWorld): Record<string, string> => {
    const file = String(w.facts!['env-file'])
    expect(existsSync(file), 'the worker wrote its environment').toBe(true)
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  }

  define(/^the worker's environment holds none of the six session variables$/, (w) => {
    const env = workerEnv(w)
    const session = w.facts!['session-vars'] as string[]
    expect(session).toHaveLength(6)
    for (const name of session) expect(env[name], name).toBeUndefined()
    // Nor does the token reach the worker under another name, or the
    // store. The worker wrote its CLAUDE* variables to its error stream and
    // exited 0 having printed nothing, so its summary row carries that
    // stream's tail (D384): a token the door had left in would be in it.
    const token = String(w.facts!['token'])
    expect(Object.values(env)).not.toContain(token)
    const row = summaryRowOf(w, outOf(w))
    const had = w.facts!['spawner-env'] as Record<string, string>
    // The row does hold the worker's variables (the setting it kept), so the
    // absence below is read off a row that would have shown the token.
    expect(row.content).toContain(`CLAUDE_CONFIG_DIR=${had['CLAUDE_CONFIG_DIR']}`)
    expect(row.content.includes(token)).toBe(false)
    const rows = rawAll<{ c: Buffer | string; m: string }>(w, 'SELECT content AS c, metadata_json AS m FROM nodes')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(`${decodeContent(r.c)}${r.m}`).not.toContain(token)
  })

  define(/^it holds CLAUDE_CONFIG_DIR and CLAUDE_CODE_USE_BEDROCK as the spawner had them$/, (w) => {
    const env = workerEnv(w)
    const had = w.facts!['spawner-env'] as Record<string, string>
    for (const name of w.facts!['settings-vars'] as string[]) expect([name, env[name]]).toEqual([name, had[name]])
  })

  define(/^it holds the ticket and the worker's lane the door set$/, (w) => {
    const env = workerEnv(w)
    const o = outOf(w)
    const t = w.facts!['ticket'] as TicketFields
    const read = readTicket(env['TREECONTEXT_TICKET'] ?? '')
    expect(read.valid).toBe(true)
    expect([read.ticket.run, read.ticket.key, read.ticket.role, read.ticket.checkpointer]).toEqual([t.run, t.key, t.role, t.checkpointer])
    expect(o.sessionId).toBeTruthy()
    expect(env['TREECONTEXT_WORKER_SESSION']).toBe(o.sessionId)
    expect(rawOne(w, "SELECT kind, door FROM session_registry WHERE session_id = ? AND agent_id = 'worker'", o.sessionId)).toMatchObject({ kind: 'worker', door: 'ticket' })
  })
}

// ── D393: a signal's end takes the worker's process group with it ──────
//
// The long-running command is a real `sleep 600` the stand-in worker
// starts in its own process group, which the door made the worker's (the
// plan's `groupChild`); the binding finds it by the group's id, the
// worker's pid, while the worker runs, and reads the host's process table
// for the group afterwards. The signal is the wrapper's own `--timeout`, or
// a SIGKILL this test sends to the worker's process, which the door never
// sent: the harness or the system killing it.
//
// ── D397: the error stream after the run settled ───────────────────────
//
// The background process is a real node process the stand-in starts
// holding its error stream alone (the plan's `bgStderr`), which outlives
// the worker; the spawner is the library call, whose handed-on chunks the
// binding reads after the run settled, for as long as this process lives.

/** The live members of a process group, from the host's process table
 *  (a zombie awaiting its reaper is not running). */
function groupMembers(pgid: number): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
  return out.split('\n').map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3 && Number(p[1]) === pgid && !p[2]!.startsWith('Z'))
    .map((p) => Number(p[0]))
}

/** Whether a process is running: it exists and is not a zombie. */
function running(pid: number): boolean {
  try { process.kill(pid, 0) } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false }
  if (process.platform === 'win32') return true
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  const stat = r.stdout.trim()
  return stat !== '' && !stat.startsWith('Z')
}

/** The stand-in's first log line, once it has written it (it writes it
 *  before it hangs). */
async function firstStandinLine(logPath: string): Promise<StandinRecord> {
  await waitForFile(logPath)
  for (let i = 0; i < 200; i++) {
    const text = readFileSync(logPath, 'utf8')
    if (text.includes('\n')) return JSON.parse(text.split('\n')[0]!) as StandinRecord
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`the stand-in never finished its log line in ${logPath}`)
}

/** The numbers of the background writer's lines in a stretch of stream. */
const backgroundLines = (text: string): number[] => [...text.matchAll(/^background line (\d+)$/gm)].map((m) => Number(m[1]))

export function groupAndStreamSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(new RegExp(`^an? ${WORKER_CLI} worker started by the wrapper under the key "([^"]+)" that has started a long-running command in its own process group$`), async (w, _cli, key) => {
    await openRunWorld(w)
    // Owed a send-back were it to exit on its own, so "no send-back" below
    // is the cut's doing.
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button', expectEnd: 'cut',
      ticket: ticketFields(w, { key, checkpointer: 'builder', canWrite: true }),
      plan: { first: { notes: 1, groupChild: true, exit: 'hang' }, rerun: { checkpoint: 'state: never written', print: 'never' } },
    } satisfies WorkerSpec
  })

  define(/^(the wrapper's timeout|a kill the door did not send, sent to the worker's process) ends the worker$/, async (w, how) => {
    const spec = specOf(w)
    const byDoor = how === "the wrapper's timeout"
    if (byDoor) spec.timeoutSecs = 8
    const o = await runWorker(w, spec, 'worker', async (logPath) => {
      const rec = await firstStandinLine(logPath)
      const child = rec.groupChild
      expect(child, 'the stand-in started no long-running command').toBeTypeOf('number')
      w.defer(() => { try { process.kill(child!, 'SIGKILL') } catch { /* gone */ } })
      // Before the signal: the command runs, in the worker's own group,
      // whose id is the worker's pid (the door made it the leader).
      const members = groupMembers(rec.pid)
      expect(members, 'the worker leads no group of its own').toContain(rec.pid)
      expect(members, 'the long-running command is not in the worker\'s group').toContain(child)
      w.facts!['group'] = { leader: rec.pid, child }
      if (!byDoor) process.kill(rec.pid, 'SIGKILL')
    })
    // Who sent it is in how the worker ended.
    expect([o.exitCode, o.line.includes(`was ended by ${byDoor ? 'SIGTERM' : 'SIGKILL'}`)], o.stderr).toEqual([byDoor ? 143 : 137, true])
  })

  define(/^the worker's registration reads cut, with no summary row and no send-back$/, (w) => {
    const o = outOf(w)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect([reg['kind'], reg['door'], reg['ended'], reg['send_backs']]).toEqual(['worker', 'ticket', 'cut', 0])
    const lane = laneRows(w, w.legs!['worker']!.sessionId)
    expect(lane.filter((r) => r.content.startsWith('first run note '))).toHaveLength(1)
    expect(lane.filter((r) => r.kind === SUBAGENT_SUMMARY_KIND || r.kind === SEND_BACK_KIND)).toHaveLength(0)
    expect(o.log.map((r) => r.rerun), 'the worker was run again').toEqual([false])
    expect(o.line).toContain('a cut, so it is not sent back and left no summary row')
  })

  define(/^no process of the worker's process group is still running, the long-running command included$/, async (w) => {
    const g = w.facts!['group'] as { leader: number; child: number } | undefined
    expect(g, 'the group was never seen running').toBeTruthy()
    // A member killed a moment ago may be a zombie awaiting its reaper.
    let left = groupMembers(g!.leader)
    for (let i = 0; i < 60 && (left.length > 0 || running(g!.child)); i++) {
      await new Promise((r) => setTimeout(r, 50))
      left = groupMembers(g!.leader)
    }
    expect(left, 'processes of the worker\'s group still running').toEqual([])
    expect(running(g!.child), 'the long-running command is still running').toBe(false)
  })

  define(new RegExp(`^an? ${WORKER_CLI} worker started through the library call that starts a background process writing a line to its error stream every second, and then prints "([^"]+)" and exits with code (\\d+)$`), async (w, _cli, printed, code) => {
    await openRunWorld(w)
    w.facts!['spec'] = {
      spawner: 'library', prompt: 'wire the submit button', ticket: ticketFields(w, { checkpointer: 'reviewer' }),
      plan: { first: { bgStderr: { lines: 60, everyMs: 1000 }, print: printed, exit: Number(code) } },
    } satisfies WorkerSpec
  })

  define(/^the run has settled and the background process writes three more lines$/, async (w) => {
    const o = await runWorker(w, specOf(w))
    const bg = o.log[0]?.background
    expect(bg, 'the stand-in started no background process').toBeTypeOf('number')
    w.defer(() => { try { process.kill(bg!, 'SIGKILL') } catch { /* gone */ } })
    // The run has settled (its promise resolved) while the background
    // process still holds the stream: what the spawner had by then.
    expect(running(bg!), 'the background process was not running once the run had settled').toBe(true)
    const atSettle = o.stderr
    const deadline = Date.now() + 15_000
    let after = ''
    while (Date.now() < deadline) {
      after = o.stderrSoFar!().slice(atSettle.length)
      if (backgroundLines(after).length >= 3) break
      await new Promise((r) => setTimeout(r, 100))
    }
    w.facts!['bg'] = { pid: bg, atSettle, after }
  })

  define(/^the spawner receives those three lines on its error stream$/, (w) => {
    const { atSettle, after } = w.facts!['bg'] as { atSettle: string; after: string }
    const before = backgroundLines(atSettle)
    const later = backgroundLines(after)
    expect(later.length, `the spawner heard ${later.length} lines after the run settled:\n${after}`).toBeGreaterThanOrEqual(3)
    // The stream goes on where it was at the settle, no line lost.
    const first = before.length > 0 ? before.at(-1)! + 1 : 1
    expect(later.slice(0, 3)).toEqual([first, first + 1, first + 2])
  })

  define(/^the background process is still running, not ended by SIGPIPE$/, (w) => {
    const { pid } = w.facts!['bg'] as { pid: number }
    expect(running(pid), 'the background process was ended after the run settled').toBe(true)
  })

  define(/^the summary row the spawner's line points at reads "([^"]+)"$/, (w, text) => {
    const o = outOf(w)
    const row = summaryRowOf(w, o)
    expect([row.content, row.kind, row.writer, row.session]).toEqual([text, SUBAGENT_SUMMARY_KIND, 'builder', o.sessionId])
    expect(o.stdout).toBe(text)
  })
}

/** The one row a worker with invalid instructions writes (D303, D342). */
const INVALID_ROW = 'my instructions were invalid; I did no work and stop here'

// ── D403: a worker and a reader whose processes are numbered apart ──
//
// The sandbox is real: a user and pid namespace of its own on this host
// (the stand-in harness's PID_SANDBOX, as Codex CLI's bwrap sandbox is on
// Linux), so a process in it holds one id there and another outside. The
// worker is the hook-less stand-in run through the real `treecontext run`
// wrapper, inside the sandbox or outside it; the harness's lookup is the
// library's, made in this process (outside any sandbox) or in a process of
// its own inside one (lookupInSandbox). A registration "by a build that
// recorded no numbering" is the stand-in harness's `earlierBuild` wrapper.
// The worker runs until the binding lets it go (`waitFor`) or a signal ends
// it. Every Then reads the store file. A host that cannot make the sandbox
// shows these scenarios skipped (features.test.ts HOST_SKIPS).

/** A worker of the run started through the wrapper and left running: its
 *  registration is read once the worker says it is running. */
async function runningWorker(w: WorkersWorld, o: { sandbox: boolean | 'keeps-machine-proc'; earlierBuild: boolean; after?: 'print'; sendBack?: boolean }): Promise<void> {
  const go = join(w.home!, `go-${randomUUID().slice(0, 8)}`)
  w.facts!['go'] = go
  // A worker that will exit without its checkpoint is its own checkpointer
  // (D281), so its door sends it back once; its re-run waits on `go2`.
  const go2 = `${go}-rerun`
  w.facts!['go2'] = go2
  const spec: WorkerSpec = {
    spawner: 'wrapper', prompt: 'wire the submit button', ticket: ticketFields(w, { checkpointer: o.sendBack ? 'builder' : 'reviewer' }),
    plan: { first: { waitFor: go, ...(o.after === 'print' ? { print: 'done' } : {}) }, ...(o.sendBack ? { rerun: { waitFor: go2 } } : {}) },
    ...(o.sandbox ? { sandbox: o.sandbox } : {}), ...(o.earlierBuild ? { earlierBuild: true } : {}),
  }
  const done = runWorker(w, spec, 'worker')
  w.facts!['running'] = done
  w.defer(async () => { for (const f of [go, go2]) if (!existsSync(f)) writeFileSync(f, 'go'); await done.catch(() => undefined) })
  await waitForFile(`${go}.ready`, 60_000)
  const reg = rawAll<{ session_id: string }>(w, "SELECT session_id FROM session_registry WHERE kind = 'worker' AND agent_type = 'builder'")
  expect(reg, 'the running worker is registered once').toHaveLength(1)
  w.legs!['worker'] = { sessionId: reg[0]!.session_id, agentId: WORKER_AGENT_ID }
  const r = rawRegistration(w, w.legs!['worker']!)
  expect([r['ended'], r['stopped_at']], 'the worker is live').toEqual([null, null])
  // What the door recorded of its numbering: the sandbox's own, or none.
  const own = hostProbe.pidNamespace?.('self') ?? null
  if (o.earlierBuild) expect(r['proc_ns'], 'an earlier build records no numbering').toBeNull()
  else if (o.sandbox) expect([r['proc_ns'] !== null, r['proc_ns'] !== own], 'the sandbox numbers its processes apart').toEqual([true, true])
  else expect(r['proc_ns']).toBe(own)
  w.facts!['ready-pid'] = Number(readFileSync(`${go}.ready`, 'utf8'))
  if (o.sandbox) {
    // The id the door recorded is the one the sandbox gave its worker.
    expect(r['pid'], 'the door recorded the id the sandbox gave its worker').toBe(w.facts!['ready-pid'])
  }
  if (o.sandbox === 'keeps-machine-proc') {
    // The start the door recorded is its own worker's, found in the
    // sandbox's numbering, not the machine's process of the same number.
    const found = hostProbe.lookInNamespace!(String(r['proc_ns']), r['pid'] as number).hostPid
    expect(found, 'the worker is found in its sandbox').not.toBeNull()
    expect(r['proc_start_token'], 'the door recorded its own worker\'s start').toBe(hostProbe.startToken!(found!))
  }
}

/** The numbering of processes of the sandbox a worker was started in, read
 *  from the sandbox's own first process. */
function sandboxNamespaceOf(w: WorkersWorld): string {
  const unshare = w.facts!['sandbox:worker'] as number
  const children = readFileSync(`/proc/${unshare}/task/${unshare}/children`, 'utf8').trim().split(/\s+/).map(Number)
  const ns = hostProbe.pidNamespace?.(children[0]!) ?? null
  expect(ns, 'the sandbox numbers its processes apart').not.toBeNull()
  expect(ns).not.toBe(hostProbe.pidNamespace?.('self') ?? null)
  return ns!
}

function sandboxSteps(define: (re: RegExp, fn: (w: WorkersWorld, ...caps: string[]) => void | Promise<void>) => void): void {
  define(/^a worker under the key "([^"]+)", still running, started through the `treecontext run` wrapper (inside a sandbox on this host that numbers its own processes and still shows the machine's list of processes|inside a sandbox on this host that numbers its own processes|on this host, outside any sandbox,(?: by a build that recorded no numbering,)?)$/, async (w, key, where) => {
    expect(key).toBe('login-form')
    await openRunWorld(w)
    const sandbox = where.includes("machine's list") ? 'keeps-machine-proc' as const : where.startsWith('inside')
    await runningWorker(w, { sandbox, earlierBuild: where.includes('recorded no numbering') })
  })

  define(/^a worker under the key "([^"]+)", still running, registered on this host outside any sandbox$/, async (w, key) => {
    expect(key).toBe('login-form')
    await openRunWorld(w)
    await runningWorker(w, { sandbox: false, earlierBuild: false })
  })

  define(/^the harness (on this host, outside the sandbox,|inside a sandbox on this host that numbers its own processes) looks up the key "([^"]+)"$/, (w, where, key) => {
    expect(key).toBe('login-form')
    w.moments!['before-read'] = Date.now() / 1000
    if (where.startsWith('inside')) w.lookups![RUN] = lookupInSandbox(w, RUN, key) as unknown as KeyLookup
    else lookup(w)
    w.moments!['after-read'] = Date.now() / 1000
  })

  define(/^the reply says the worker runs where this reader cannot see its process, so it cannot be checked from here$/, (w) => {
    const sid = w.legs!['worker']!.sessionId
    const said = w.lookups![RUN]!.notes.filter((n) => n.includes(sid))
    expect(said, 'the reply says nothing of the worker').toHaveLength(1)
    expect(said[0]).toContain('runs where this reader cannot see its process')
    expect(said[0]).toContain('cannot be checked from here')
  })

  define(/^a worker under the key "([^"]+)" registered from inside a sandbox on this host that numbers its own processes$/, async (w, key) => {
    expect(key).toBe('login-form')
    await openRunWorld(w)
    await runningWorker(w, { sandbox: true, earlierBuild: false })
  })

  define(/^the sandbox has since ended with every process in it, nothing having retired the worker$/, async (w) => {
    const ns = sandboxNamespaceOf(w)
    // The sandbox's own process ended: it takes every process in it along.
    process.kill(w.facts!['sandbox:worker'] as number, 'SIGKILL')
    await (w.facts!['running'] as Promise<Outcome>)
    const deadline = Date.now() + 10_000
    while (hostProbe.lookInNamespace!(ns, 1).seen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(hostProbe.lookInNamespace!(ns, 1).seen, 'a process of the sandbox is left').toBe(false)
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['stopped_at'], r['noticed_at']], 'nothing retired it').toEqual([null, null, null])
  })

  // D403's correction outline. The worker waits to be let go and then
  // prints "done" and exits; a signal sent while it waits ends it before it
  // prints anything.
  define(/^a worker under the key "([^"]+)", still running, started through the `treecontext run` wrapper of this build(, that will exit without its checkpoint)?$/, async (w, key, sendBack) => {
    expect(key).toBe('login-form')
    await openRunWorld(w)
    await runningWorker(w, { sandbox: false, earlierBuild: false, after: 'print', sendBack: sendBack !== undefined && sendBack !== '' })
  })

  define(/^a reader on this host has wrongly taken it for gone and retired it as a phantom$/, (w) => {
    // No reader of this build takes this build's running worker for gone
    // (every route found is closed): the wrong answer comes from the
    // stand-in for the operating system's answer about the worker's one
    // process (standins.ts `osAnsweringGone`), handed to the harness's
    // own lookup.
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect(reg['proc_ns'], 'this build\'s door recorded its numbering').not.toBeNull()
    w.moments!['before-read'] = Date.now() / 1000
    const l = w.store!.lookupKey({ run: RUN, key: 'login-form', probe: osAnsweringGone(reg['pid'] as number, reg['proc_ns'] as string) })
    w.lookups![RUN] = l
    w.moments!['after-read'] = Date.now() / 1000
    const taken = rawRegistration(w, w.legs!['worker']!)
    expect([taken['ended'], taken['noticed_by'], taken['stopped_at']], 'the reader took the running worker for a phantom').toEqual(['phantom', NOTICED_BY_LOOKUP, null])
    expect(l.legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)?.state).toBe('phantom')
    w.facts!['noticed_at'] = taken['noticed_at']
  })

  define(/^the worker exits and its door sends it back$/, async (w) => {
    expect(rawRegistration(w, w.legs!['worker']!)['ended'], 'the worker was taken for a phantom first').toBe('phantom')
    writeFileSync(w.facts!['go'] as string, 'go')
    // The re-run is running once it says so.
    await waitForFile(`${w.facts!['go2'] as string}.ready`, 60_000)
  })

  define(/^while the re-run runs, the worker's registration reads live$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['ended'], r['stopped_at'], r['send_backs']]).toEqual([null, null, 1])
    expect(JSON.parse(String(r['processes']))).toHaveLength(2)
    // The harness's lookup, its own pass over a running re-run included.
    expect(harnessLookup(w).legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)?.state).toBe('live')
    expect(existsSync(w.facts!['go2'] as string), 'the re-run is still running').toBe(false)
  })

  define(/^a worker whose ticket the door of this build could not read whole, still running$/, async (w) => {
    await openRunWorld(w)
    const t = mintTicket({ run: RUN, key: 'login-form', role: 'builder', checkpointer: 'builder', parent: { id: 'p1' } })
    const raw = t.slice(0, t.indexOf('"role":"builder"') + '"role":"builder"'.length)
    w.facts!['raw'] = raw
    const go = join(w.home!, `go-${randomUUID().slice(0, 8)}`)
    const held = `${go}-held`
    Object.assign(w.facts!, { go, go2: held })
    // It runs with nothing of its own in the store until let go, then
    // writes its one row through its own tools, and keeps running.
    const done = runWorker(w, {
      spawner: 'wrapper', prompt: 'wire the submit button', ticket: raw,
      plan: { first: { waitBeforeWrites: go, viaTools: true, texts: [INVALID_ROW], waitFor: held } },
    }, 'worker')
    w.facts!['running'] = done
    w.defer(async () => { for (const f of [go, held]) if (!existsSync(f)) writeFileSync(f, 'go'); await done.catch(() => undefined) })
    await waitForFile(`${go}.ready`, 60_000)
    const reg = rawAll<{ session_id: string; ticket_absent: string }>(w, "SELECT session_id, ticket_absent FROM session_registry WHERE kind = 'worker'")
    expect(reg).toHaveLength(1)
    expect(JSON.parse(reg[0]!.ticket_absent).length, 'the door could not read the ticket whole').toBeGreaterThan(0)
    w.legs!['worker'] = { sessionId: reg[0]!.session_id, agentId: WORKER_AGENT_ID }
    expect(rawRegistration(w, w.legs!['worker']!)).toMatchObject({ ended: null, stopped_at: null })
  })

  define(/^the worker's one row lands$/, async (w) => {
    expect(rawRegistration(w, w.legs!['worker']!)['ended'], 'the worker was taken for a phantom first').toBe('phantom')
    writeFileSync(w.facts!['go'] as string, 'go')
    // Its row has landed once it waits again; it is still running.
    await waitForFile(`${w.facts!['go2'] as string}.ready`, 60_000)
  })

  define(/^the store records the leg as having ended with no valid instructions at the moment the row landed, no longer a phantom$/, (w) => {
    const rows = laneRows(w, w.legs!['worker']!.sessionId).filter((r) => r.content === INVALID_ROW)
    expect(rows, 'the worker\'s one row, written through its own tools').toHaveLength(1)
    expect(rows[0]!.m['_writer_agent_id']).toBe(WORKER_AGENT_ID)
    const reg = rawRegistration(w, w.legs!['worker']!)
    expect(reg['ended']).toBe('invalid')
    expect(reg['stopped_at']).toBe(rows[0]!.created_at)
    expect(existsSync(w.facts!['go2'] as string), 'the worker is still running').toBe(false)
  })

  define(/^the worker (exits on its own after printing "done"|is ended by a signal)$/, async (w, ends) => {
    const exits = ends.startsWith('exits')
    expect(rawRegistration(w, w.legs!['worker']!)['ended'], 'the worker was taken for a phantom first').toBe('phantom')
    w.moments!['end-from'] = Date.now() / 1000
    if (exits) {
      writeFileSync(w.facts!['go'] as string, 'go')
    } else {
      const host = w.facts!['sandbox:worker'] === undefined
        ? w.facts!['ready-pid'] as number
        : hostProbe.lookInNamespace!(sandboxNamespaceOf(w), w.facts!['ready-pid'] as number).hostPid
      expect(host, 'the worker is found').not.toBeNull()
      process.kill(host!, 'SIGTERM')
    }
    const o = await (w.facts!['running'] as Promise<Outcome>)
    w.moments!['end-to'] = Date.now() / 1000
    expect(o.line, o.stderr).toContain(exits ? 'is retired' : 'cut')
  })

  define(/^the worker's registration reads (retired|cut) at the moment it ended, no longer a phantom$/, (w, ending) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect(r['ended']).toBe(ending)
    expect(r['stopped_at'] as number).toBeGreaterThanOrEqual(w.moments!['end-from']! - 0.001)
    expect(r['stopped_at'] as number).toBeLessThanOrEqual(w.moments!['end-to']! + 0.001)
    expect(harnessLookup(w).legs.find((g) => g.sessionId === w.legs!['worker']!.sessionId)?.state).toBe(ending)
  })

  define(/^it still shows when it was taken for a phantom and what took it for one$/, (w) => {
    const r = rawRegistration(w, w.legs!['worker']!)
    expect([r['noticed_at'], r['noticed_by']]).toEqual([w.facts!['noticed_at'], NOTICED_BY_LOOKUP])
    expect(r['noticed_at'] as number).toBeGreaterThanOrEqual(w.moments!['before-read']! - 0.001)
    expect(r['noticed_at'] as number).toBeLessThanOrEqual(w.moments!['after-read']! + 0.001)
  })

  define(/^the worker's summary row holds "([^"]+)"$/, (w, text) => {
    const rows = laneRows(w, w.legs!['worker']!.sessionId).filter((x) => x.kind === SUBAGENT_SUMMARY_KIND)
    expect(rows.map((x) => x.content)).toEqual([text])
    // A registration that reads phantom never stands beside it.
    expect(rawRegistration(w, w.legs!['worker']!)['ended']).not.toBe('phantom')
  })

  define(/^the worker left no summary row$/, (w) => {
    expect(laneRows(w, w.legs!['worker']!.sessionId).filter((x) => x.kind === SUBAGENT_SUMMARY_KIND)).toEqual([])
  })

  // ── D416's worker clause, D421: an `agy -p` worker with agy's named hook ──
  // The worker is started by the real `treecontext run`; the process the
  // door launches is the stand-in (no model), which writes its environment
  // to a file, writes its note through a real `treecontext serve` started
  // with that environment (agy's MCP server's place), and waits. While it
  // runs, agy's named hook fires as the recorded ticketed worker's did on
  // 2026-11-09 (tests/fixtures/agy-hooks, worker.ndjson), every event and
  // its transcript as they stood, through the commands install writes for
  // agy, with the two variables the recording shows every hook held (the
  // ticket and the lane the door handed the worker). The worker's agy
  // conversation is the recorded one.
  define(/^an `agy -p` worker started by the wrapper with a ticket naming the parent "([^"]+)", the run "([^"]+)", the key "([^"]+)" and the role "([^"]+)", on an Antigravity CLI whose named hook install wrote$/, async (w, parent, run, key, role) => {
    await openRunWorld(w)
    const go = join(w.home!, `agy-worker-go-${randomUUID().slice(0, 8)}`)
    const envFile = join(w.home!, `agy-worker-env-${randomUUID().slice(0, 8)}.json`)
    w.facts!['go'] = go
    w.facts!['env-file'] = envFile
    w.facts!['spec'] = {
      spawner: 'wrapper', prompt: 'wire the submit button',
      ticket: ticketFields(w, { parent: { id: String(parent), cli: 'agy' }, run: String(run), key: String(key), role: String(role) }),
      plan: { first: { envTo: envFile, waitFor: go, notes: 1, viaTools: true, label: 'agy worker' } },
    } satisfies WorkerSpec
  })
  define(/^the worker's events, as Antigravity sends them, reach the hook install writes, the worker runs a shell command and inserts a note, and ingestion runs$/, async (w) => {
    const events = recordedSession('1.5.3', 'worker.ndjson', 'agy')
    w.facts!['agy-conversation'] = String(events[0]!['conversationId'])
    w.facts!['agy-events'] = events
    const go = w.facts!['go'] as string
    await runWorker(w, specOf(w), 'worker', async () => {
      await waitForFile(`${go}.ready`)
      const env = JSON.parse(readFileSync(w.facts!['env-file'] as string, 'utf8')) as Record<string, string>
      expect(env[TICKET_ENV], 'the door handed the worker no ticket').toBeTruthy()
      expect(env[WORKER_SESSION_ENV], 'the door handed the worker no lane').toBeTruthy()
      replayRecordedSession(w, events, { env: { [TICKET_ENV]: env[TICKET_ENV]!, [WORKER_SESSION_ENV]: env[WORKER_SESSION_ENV]! } })
      writeFileSync(go, 'go')
    })
    expect(outOf(w).exitCode).toBe(0)
    await drainStaging(w)
  })
  define(/^the store holds no self registration for the worker's conversation$/, (w) => {
    const conv = w.facts!['agy-conversation'] as string
    expect(rawAll(w, 'SELECT kind FROM session_registry WHERE session_id = ?', conv)).toEqual([])
    // Its conversation is linked to the worker's lane, nobody's self.
    const lane = outOf(w).sessionId!
    expect(lane).not.toBe(conv)
    expect(JSON.stringify(rawRegistration(w, { sessionId: lane, agentId: WORKER_AGENT_ID }))).toContain(conv)
  })
  define(/^the shell command's entry and the note sit in the worker's own lane, stamped with the writer "([^"]+)" and the parent session "([^"]+)"$/, (w, writer, parent) => {
    const lane = outOf(w).sessionId!
    const rows = laneRows(w, lane)
    const shell = rows.filter((r) => r.m['tool_name'] === 'run_command' && r.content.includes('head -c 13 package.json'))
    const note = rows.filter((r) => r.content.startsWith('agy worker note 1 of '))
    expect(shell, 'the shell command\'s entry is not in the worker\'s lane').toHaveLength(1)
    expect(note, 'the note is not in the worker\'s lane').toHaveLength(1)
    expect(shell[0]!.content).toContain('\nOutput:\n')
    for (const r of [...shell, ...note]) expect([r.m['_writer'], r.m['_writer_src'], r.m['_parent']]).toEqual([writer, 'declared', parent])
    // The captured call keeps agy's conversation beside the lane.
    expect(shell[0]!.m['_client_session_id']).toBe(w.facts!['agy-conversation'])
  })
  define(/^the main lane holds none of the worker's rows$/, (w) => {
    const lane = outOf(w).sessionId!
    const conv = w.facts!['agy-conversation'] as string
    const outside = rawAll<{ session_key: string }>(w,
      "SELECT session_key FROM nodes WHERE session_key <> ? AND (json_extract(metadata_json, '$.session_id') = ? OR json_extract(metadata_json, '$._client_session_id') = ? OR CAST(content AS TEXT) LIKE 'agy worker note %')",
      lane, conv, conv)
    expect(outside).toEqual([])
    // Every captured call of the recording is in the lane.
    const calls = (w.facts!['agy-events'] as Array<Record<string, unknown>>).filter((e) => e['toolCall'] !== undefined)
    expect(laneRows(w, lane).filter((r) => typeof r.m['tool_name'] === 'string')).toHaveLength(calls.length)
  })
}
