import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { decodeContent } from '../../src/persistence/content-codec.js'
import { wrapBetterSqlite } from '../../src/persistence/better-sqlite.js'
import { FlatStore } from '../../src/flat-store.js'
import { IngestionLoop } from '../../src/server/ingestion.js'
import { sandboxedSpawnEnv } from '../helpers/cli-spawn.js'
import { storesDirIn } from '../helpers/store-fixtures.js'
import type { World } from './world.js'
import { TS_ROOT, tsxArgv, killAndWait } from './proc.js'

// ── Capture-wave harness: real hook subprocesses against a real store ──
//
// The verification rule demands real platform payloads in and direct
// SQLite inspection out. These helpers spawn the actual hook entry
// points (tsx, fresh process, payload piped to stdin — the same
// transport Claude Code uses), with HOME redirected to a temp dir so
// the production resolveDbPath chain (bindings file, derived store
// name) runs for real and writeStaging opens the same SQLite file the
// assertions later read. No mocks anywhere on the path.
//
// Payload shapes mirror live Claude Code payloads as observed on the
// reference platform 2026-07-24 (Bash tool_response is
// {stdout, stderr, interrupted, isImage}; UserPromptSubmit carries
// `prompt`; Stop carries `transcript_path` to the session JSONL, and —
// probe of 2026-10-08, Claude Code 2.1.293 — the ended turn's text in
// `last_assistant_message`, while the transcript still ends a turn
// earlier). The
// tool_response lesson applies: these shapes must track the platform,
// and a drifted shape fails loudly here because staging stays empty.

/**
 * The capture wave's world: the core `World` plus the sandbox the hooks run
 * in (`home`/`proj`/`sessionId`) and what each payload left behind.
 *
 * This is the tier's most-extended interface, because driving real hook
 * subprocesses is how five other waves get events into a store: library,
 * recall, namespaces, session-echo and session-namespace all call
 * openCaptureWorld/spawnHook/drainStaging, so their worlds extend this one
 * rather than restating the sandbox fields. The alternative — promoting
 * home/proj/sessionId into the shared World — would have hidden which waves
 * actually spawn a hook.
 */
export interface CaptureWorld extends World {
  home?: string
  proj?: string
  sessionId?: string
  prompt?: string
  saidAt?: [number, number]
  drainedAt?: number
  brackets?: Record<'user' | 'tool' | 'assistant', [number, number]>
  toolCommand?: string
  toolStdout?: string
  deepToken?: string
  assistantText?: string
  noteId?: string
  comparatorId?: string
  pendingPayload?: Record<string, unknown>
  /** The stdout of the last hook spawnHook ran — what the platform reads
   *  back from it (a Stop hook's block decision, a SessionStart packet). */
  hookStdout?: string
  /** The moment a seeded checkpoint's age is stated against (unix
   *  seconds); a Stop hook run with it set reads this clock (test-only
   *  TREECONTEXT_TEST_NOW), so minute boundaries bind exactly. */
  clockNow?: number
  /** The abandoned-server scenario's real `serve` subprocess. */
  serveChild?: import('node:child_process').ChildProcess
  /** That subprocess's sandbox HOME — its log file lives under it. */
  serveHome?: string
  /** That subprocess's store file. */
  serveDbPath?: string
}

/** Where the spawned hooks will derive the store for `proj` under `home` —
 *  mirrors resolveStoreName's no-git fallback (deriveName) under storesDirIn,
 *  the corpus's one spelling of the STORES_DIR layout.
 *  If deriveName ever changes, staging lands elsewhere and every capture
 *  binding fails loudly on an empty journal — a wrong mirror cannot go
 *  silently green. */
function derivedStorePath(home: string, proj: string): string {
  // Split on BOTH separators, exactly as bindings.ts deriveName does. Splitting
  // on '/' alone left a Windows path with no split point at all, so `base`
  // became the whole `C:\...\tc-capture-proj-x` mangled by the safe-character
  // replace — the mirror pointed at a store the hooks never wrote, and every
  // capture scenario read an empty journal. The header above says a wrong
  // mirror cannot go silently green; it did fail loudly, which is why this is
  // the first thing the Windows lane reported once the hooks could run at all.
  const base = (proj.split(/[\\/]/).filter(Boolean).pop() ?? 'unnamed').replace(/[^A-Za-z0-9._-]/g, '-')
  const hash = createHash('sha1').update(`path:${proj}`).digest('hex').slice(0, 6)
  return join(storesDirIn(home), `${base}-${hash}`, 'treecontext.db')
}

/** The sandbox alone — home, project, derived store path, session id —
 *  with NOTHING under the stores directory: the fresh-install shape, where
 *  the first hook ever to fire is what brings the store into being
 *  (issue #2). openCaptureWorld builds on this and then opens the store
 *  the way every other capture scenario expects to find it. */
export function openCaptureSandbox(w: CaptureWorld): void {
  w.home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-capture-home-')))
  w.defer(() => rmSync(w.home!, { recursive: true, force: true }))
  w.proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tc-capture-proj-')))
  w.defer(() => rmSync(w.proj!, { recursive: true, force: true }))
  // Pin project-root discovery to the temp dir itself (an empty .git is
  // not a valid repo, so identity stays path-based and deterministic).
  mkdirSync(join(w.proj, '.git'))
  w.dbPath = derivedStorePath(w.home, w.proj)
  w.sessionId = `cc-${randomBytes(6).toString('hex')}`
}

/** Open the store at w.dbPath the way a server starting later would: the
 *  library open over whatever file is there. Against a hook-minted store
 *  this is the "server boots after the fact" half of issue #2. */
export async function adoptCaptureStore(w: CaptureWorld): Promise<void> {
  const store = await FlatStore.open({
    database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
    ownsDatabase: true,
  })
  w.defer(() => store.close())
  w.store = store
}

export async function openCaptureWorld(w: CaptureWorld): Promise<void> {
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  await adoptCaptureStore(w)
}

export interface HookRun { status: number | null; stdout: string; stderr: string; ms: number }

/** Run one real hook subprocess and hand back everything it said — the
 *  form for scenarios that read what the platform reads from a hook's
 *  stdout. `env` adds to the sandbox (a TZ, say), never replaces it. */
export function runHook(
  w: CaptureWorld,
  hook: 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'session-start' | 'subagent-start' | 'subagent-stop',
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): HookRun {
  // The canonical sandboxed spawn env (home redirected for Windows homedir
  // semantics, every ambient leak key scrubbed), with the bindings file
  // deliberately re-pointed INTO the sandbox — that seam is the subject
  // here, not a leak.
  const spawnEnv = sandboxedSpawnEnv(w.home!, {
    TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'),
    ...env,
  })
  const t0 = Date.now()
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'src', 'hooks', `${hook}.ts`)), {
    input: JSON.stringify({ session_id: w.sessionId, cwd: w.proj, ...payload }),
    env: spawnEnv,
    cwd: TS_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const ms = Date.now() - t0
  // spawnSync reports a process that never started as status null with NO
  // stderr; r.error carries the errno.
  expect(r.status, `hook ${hook} exited ${r.status}${r.error ? ` — spawn failed: ${r.error.message}` : ''}\n${r.stderr ?? ''}`).toBe(0)
  w.hookStdout = r.stdout ?? ''
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms }
}

/** A hook's stdout as the platform parses it: one JSON object, or none. */
export function hookJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim()
  if (t === '') return null
  return JSON.parse(t) as Record<string, unknown>
}

/** The Stop hook asked for a bookmark: Claude Code's block decision, with
 *  a reason that tells the agent to write one, marked as a bookmark. */
export function expectBookmarkAsked(stdout: string): void {
  const out = hookJson(stdout)
  expect(out, 'the stop hook said nothing').not.toBeNull()
  expect(out!['decision'], `no block decision in ${stdout}`).toBe('block')
  const reason = String(out!['reason'] ?? '')
  expect(reason).toMatch(/write a bookmark/i)
  expect(reason).toContain('"kind": "bookmark"')
}

/** The Stop hook let the agent stop: no block decision at all. */
export function expectAgentMayStop(stdout: string): void {
  const out = hookJson(stdout)
  expect(out?.['decision'], `the stop hook blocked: ${stdout}`).toBeUndefined()
}

/** Seed the session's newest checkpoint `rounds` captured developer turns
 *  and `minutes` minutes old, in the shapes the journal really holds: the
 *  checkpoint as the MCP insert stamps it (_cc_session_id), each turn as
 *  ingestion drains it (auto-capture, role user, session_id). */
export async function seedCheckpointAge(
  w: CaptureWorld, rounds: number, minutes: number, kind: 'bookmark' | 'chapter' = 'bookmark',
): Promise<string> {
  // Whole seconds, so `clockNow - at` is exactly the stated age in
  // floating point and the hook's >= on the minute boundary is decidable.
  const at = Math.floor(Date.now() / 1000) - minutes * 60 - 2
  // The stated age exactly — except "0 minutes", which is a moment after
  // the checkpoint (the rounds since it took some seconds), never the
  // checkpoint's own instant.
  w.clockNow = at + (minutes > 0 ? minutes * 60 : 30)
  // The session has history from before its checkpoint — 25 turns, three
  // hours earlier — so only the checkpoint itself can make a stop early.
  for (let i = 0; i < 25; i++) {
    await w.store!.insert(`developer turn ${i + 1} before the checkpoint ${randomBytes(3).toString('hex')}`, {
      metadata: { source: 'auto-capture', role: 'user', session_id: w.sessionId },
      createdAt: at - 3 * 3600 + i,
    })
  }
  const meta: Record<string, unknown> = { next_session: true, _cc_session_id: w.sessionId }
  if (kind === 'bookmark') meta['kind'] = 'bookmark'
  const { nodeId } = await w.store!.insert(
    kind === 'bookmark' ? `at: seeded bookmark ${randomBytes(3).toString('hex')}; next: carry on` : `plan: seeded chapter ${randomBytes(3).toString('hex')}; next: carry on`,
    { metadata: meta, createdAt: at },
  )
  for (let i = 0; i < rounds; i++) {
    await w.store!.insert(`developer turn ${i + 1} since the checkpoint ${randomBytes(3).toString('hex')}`, {
      metadata: { source: 'auto-capture', role: 'user', session_id: w.sessionId },
      createdAt: at + (i + 1) / (rounds + 1),
    })
  }
  return nodeId
}

export function spawnHook(w: CaptureWorld, hook: 'user-prompt-submit' | 'post-tool-use' | 'stop', payload: Record<string, unknown>): void {
  // The canonical sandboxed spawn env (home redirected for Windows homedir
  // semantics, every ambient leak key scrubbed), with the bindings file
  // deliberately re-pointed INTO the sandbox — that seam is the subject
  // here, not a leak.
  const env = sandboxedSpawnEnv(w.home!, {
    TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'),
  })
  const r = spawnSync(process.execPath, tsxArgv(join(TS_ROOT, 'src', 'hooks', `${hook}.ts`)), {
    input: JSON.stringify({ session_id: w.sessionId, cwd: w.proj, ...payload }),
    env,
    cwd: TS_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })
  w.hookStdout = r.stdout ?? ''
  // spawnSync reports a process that never started as status null with NO
  // stderr, so a message built from stderr alone says nothing at all — that is
  // precisely how the Windows lane read for five releases. r.error carries the
  // errno; print it or the next spawn regression costs another investigation.
  expect(r.status, `hook ${hook} exited ${r.status}${r.error ? ` — spawn failed: ${r.error.message}` : ''}\n${r.stderr ?? ''}`).toBe(0)
}

/** spawnHook's concurrent form: every hook is launched before any is
 *  awaited, so they contend for the store together — the shape of a
 *  SessionStart racing the server it starts beside, or of several agents
 *  bound to one store. Each must exit 0 exactly as spawnHook demands. */
export async function spawnHooksAtOnce(
  w: CaptureWorld, hook: 'user-prompt-submit' | 'post-tool-use', payloads: Array<Record<string, unknown>>,
): Promise<void> {
  const env = sandboxedSpawnEnv(w.home!, {
    TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'),
  })
  const runs = payloads.map((payload) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, tsxArgv(join(TS_ROOT, 'src', 'hooks', `${hook}.ts`)), { env, cwd: TS_ROOT })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', reject)
    child.on('exit', (status) => resolve({ status, stderr }))
    child.stdin.end(JSON.stringify({ session_id: w.sessionId, cwd: w.proj, ...payload }))
  }))
  const results = await Promise.all(runs)
  for (const [i, r] of results.entries()) {
    expect(r.status, `hook ${hook} #${i} exited ${r.status}\n${r.stderr}`).toBe(0)
  }
}

/**
 * Spawn a real `serve` subprocess against a fresh sandboxed home, teardown
 * deferred on the world. The process-fate scenarios (the abandoned-stderr
 * storm, the mid-startup peer death) stage this same machine and differ
 * only in what they then do to the child's streams — so the machine is
 * spelled once.
 */
export function spawnServeChild(
  w: CaptureWorld, tmpPrefix: string, store: string,
): { child: ChildProcess; home: string } {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), tmpPrefix)))
  w.defer(() => rmSync(home, { recursive: true, force: true }))
  const child = spawn(process.execPath, tsxArgv(
    join(TS_ROOT, 'src', 'server', 'cli.ts'), 'serve',
    '--transport', 'stdio', '--capture', '--debug', '--lexical', '--store', store,
  ), { env: sandboxedSpawnEnv(home), cwd: TS_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  w.serveChild = child
  w.serveHome = home
  w.serveDbPath = join(storesDirIn(home), store, 'treecontext.db')
  w.defer(killAndWait(child))
  return { child, home }
}

export { readServeLog, waitForServeLog } from '../helpers/serve-log.js'

export async function drainStaging(w: CaptureWorld): Promise<void> {
  // The shipped drain always carries the attribution factory (C1,
  // tests/server/design/multi-user.md): each staged row drains into the
  // tree its namespace stamp names, create-if-absent. The helper mirrors
  // that configuration so every capture scenario drains the way
  // production does.
  const handles = new Map<string, FlatStore>([[w.store!.namespace, w.store!]])
  const extras: FlatStore[] = []
  const storeFor = async (ns: string): Promise<FlatStore> => {
    let h = handles.get(ns)
    if (!h) {
      h = await FlatStore.open({
        database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)),
        ownsDatabase: true,
        namespace: ns,
      })
      handles.set(ns, h)
      extras.push(h)
    }
    return h
  }
  // storePath mirrors production too (§7.8): the serving CLI always
  // passes it, and the session-namespace publisher is a no-op without it.
  const loop = new IngestionLoop(w.store!, { batchSize: 50, storeFor, storePath: w.dbPath! })
  try {
    for (let i = 0; i < 200; i++) {
      await loop.ingestBatch()
      if (w.store!.store.countUnprocessedStaging() === 0) break
    }
    expect(w.store!.store.countUnprocessedStaging()).toBe(0)
  } finally {
    for (const h of extras) await h.close()
  }
}

export interface RawNode { nodeId: string; content: string; metadata: Record<string, unknown> }

/** Raw-row read (verification rule): journal rows through a separate
 *  readonly handle, content decoded with the production codec. */
export function rawJournal(w: CaptureWorld): RawNode[] {
  const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
  try {
    return (raw.prepare('SELECT node_id, content, metadata_json FROM nodes').all() as Array<{ node_id: string; content: string | Buffer; metadata_json: string | null }>)
      .map((r) => ({
        nodeId: r.node_id,
        content: decodeContent(r.content),
        metadata: JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>,
      }))
  } finally {
    raw.close()
  }
}

/** A PostToolUse payload with the reference platform's Bash shape. */
export function bashPayload(w: CaptureWorld, command: string, stdout: string): Record<string, unknown> {
  return {
    transcript_path: join(w.proj!, 'transcript.jsonl'),
    hook_event_name: 'PostToolUse',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command, description: 'Run command' },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  }
}

/** A session transcript in the reference platform's JSONL shape: a user
 *  turn, a tool_use-only assistant entry (no text — must be skipped),
 *  then the turn-final assistant text. */
export function writeTranscript(w: CaptureWorld, finalText: string): string {
  const p = join(w.proj!, 'transcript.jsonl')
  const stamp = new Date().toISOString()
  const lines = [
    { type: 'user', sessionId: w.sessionId, cwd: w.proj, uuid: 'u-1', timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: 'proceed with the wave' }] } },
    { type: 'assistant', sessionId: w.sessionId, uuid: 'a-1', timestamp: stamp, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', sessionId: w.sessionId, uuid: 'a-2', timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } },
  ]
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

