/**
 * The SubagentStop hook's internal-agent rule (D263), both halves, through
 * the real hook subprocesses and the production drain, read from SQLite.
 * A report is marked the client's own internal agent only on positive
 * evidence: no agent type, and a registry that was read and holds no row
 * for the agent id. A registration, even an untyped or a retired one, is a
 * SubagentStart that happened; a lookup that cannot read is no evidence.
 * Either way the report stays a subagent summary (D3, D238).
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runHook, drainStaging } from './journal/capture-harness.js'
import { openWorld, type ReorientationWorld } from './journal/steps/journal-reorientation.steps.js'
import { rawAll } from './journal/world.js'
import { TS_ROOT, tsxArgv, killAndWait } from './journal/proc.js'
import { sandboxedSpawnEnv } from './helpers/cli-spawn.js'
import BetterSqlite3 from 'better-sqlite3'
import { SUBAGENT_SUMMARY_KIND } from '../src/handoff.js'
import { FlatStore } from '../src/flat-store.js'
import { wrapBetterSqlite } from '../src/persistence/better-sqlite.js'

type W = ReorientationWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }
const LOCKER = fileURLToPath(new URL('./helpers/store-locker.cjs', import.meta.url))

const stopPayload = (w: W, agentId: string, msg: string): Record<string, unknown> => ({
  session_id: w.sessionId, cwd: w.proj, hook_event_name: 'SubagentStop', agent_id: agentId, stop_hook_active: false,
  agent_transcript_path: join(w.proj!, `agent-${agentId}.jsonl`), last_assistant_message: msg,
})
const rowOf = (w: W, agentId: string): Record<string, unknown> => {
  const rows = rawAll<{ m: string }>(w, "SELECT metadata_json AS m FROM nodes WHERE json_extract(metadata_json, '$._writer_agent_id') = ?", agentId)
  expect(rows).toHaveLength(1)
  return JSON.parse(rows[0]!.m) as Record<string, unknown>
}

describe('SubagentStop: internal only on evidence (D263)', () => {
  it('an untyped stop of an agent a SubagentStart registered stays a subagent summary', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' })
      runHook(w, 'subagent-start', { hook_event_name: 'SubagentStart', agent_id: 'agent-X' })
      expect(rawAll(w, "SELECT agent_type, stopped_at FROM session_registry WHERE agent_id = 'agent-X'")).toEqual([{ agent_type: null, stopped_at: null }])
      runHook(w, 'subagent-stop', stopPayload(w, 'agent-X', 'agent X reports: 3 files reviewed'))
      await drainStaging(w)
      expect(rowOf(w, 'agent-X')).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: 'agent-X', _writer_src: 'hook' })
      // ...and the registration was retired, never deleted.
      expect(rawAll<{ s: number | null }>(w, "SELECT stopped_at AS s FROM session_registry WHERE agent_id = 'agent-X'")[0]!.s).not.toBeNull()
    } finally { await done(w) }
  })

  it('a stop whose registry lookup cannot read the locked store stays a subagent summary', async () => {
    const w = mkWorld()
    try {
      await openWorld(w)
      runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup' })
      // This process lets go of the store first (an idle WAL reader keeps
      // the locker from taking it); then another process holds it
      // exclusively, and readers wait.
      await w.store!.close()
      const locker = spawn(process.execPath, [LOCKER, w.dbPath!], { stdio: ['ignore', 'pipe', 'pipe'] })
      w.defer(killAndWait(locker))
      let seen = ''
      await new Promise<void>((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error(`locker never locked: ${seen}`)), 20_000)
        locker.stdout!.on('data', (c: Buffer) => { seen += c.toString(); if (/locked \d+/.test(seen)) { clearTimeout(bail); resolve() } })
        locker.on('exit', (code) => { clearTimeout(bail); reject(new Error(`locker exited ${code}: ${seen}`)) })
      })
      // The hook runs into the lock: its read-only lookup gives up after
      // its 1 s budget; the lock is released after 2.5 s, inside the
      // staging write's 8 s budget, so the capture itself lands.
      const hook = spawn(process.execPath, tsxArgv(join(TS_ROOT, 'src', 'hooks', 'subagent-stop.ts')), {
        env: sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json'), TREECONTEXT_DEBUG: '1' }),
        cwd: TS_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let err = ''
      hook.stderr!.on('data', (c: Buffer) => { err += c.toString() })
      hook.stdin!.end(JSON.stringify(stopPayload(w, 'agent-L', 'agent L reports: the lock held')))
      const t0 = Date.now()
      await new Promise((r) => setTimeout(r, 2500))
      await killAndWait(locker)()
      const code = await new Promise<number | null>((r) => hook.on('exit', r))
      expect(code, err).toBe(0)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2500)
      expect(err).toMatch(/kept as a subagent summary/)
      const store = await FlatStore.open({ database: wrapBetterSqlite(new BetterSqlite3(w.dbPath!)), ownsDatabase: true })
      w.defer(() => store.close())
      w.store = store
      await drainStaging(w)
      expect(rowOf(w, 'agent-L')).toMatchObject({ kind: SUBAGENT_SUMMARY_KIND, _writer: 'agent-L', _writer_src: 'hook' })
    } finally { await done(w) }
  }, 60_000)
})
