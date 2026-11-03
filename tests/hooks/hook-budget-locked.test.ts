/**
 * The hook budget, measured. The constants pinned in shared.test.ts
 * ("hook db timeout vs platform kill budgets") can stay green while the
 * real number is over: unit 4's review timed the real hooks against a
 * store another process holds whole-locked and found Stop at 9.09 s,
 * SubagentStop 9.08 s and SubagentStart 8.09 s, against a 9 s rule (VS
 * Code's adapter then killed a hook at 10 s, and a second is left to fail
 * gracefully). The kill is now 15 s and the rule 14 s, the same on every
 * OS (2026-11-03: the macOS runner's cold start put Stop at 11.2 s). This runs the real hook subprocess against a store
 * tests/helpers/store-locker.cjs holds, and asserts the wall time two ways:
 *
 *  - absolutely, under the 9 s rule; and
 *  - relative to the same hook on the same store unlocked in the same run,
 *    so a slow machine's process start (tsx, a cold disk, a Windows-sized
 *    CI runner) is not charged to the budget: what the lock added may not
 *    exceed the hook's busy budgets plus half a second.
 *
 * The built hooks (dist) run when they are newer than the sources; else
 * tsx runs the sources. The locker helper is POSIX (a lock another process
 * holds is proved with a second process), so the suite skips on win32.
 */
import { describe, it, expect } from 'vitest'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { type CaptureWorld, openCaptureWorld } from '../journal/capture-harness.js'
import { lockStore } from '../journal/run-world.js'
import type { RunWorld } from '../journal/run-world.js'
import { TS_ROOT, tsxArgv } from '../journal/proc.js'
import { sandboxedSpawnEnv } from '../helpers/cli-spawn.js'
import { HOOK_DB_TIMEOUT_MS, STOP_GUARD_TIMEOUT_MS, openHookDb, writeStaging } from '../../src/hooks/shared.js'
import { writeCheckpointInterval } from '../../src/checkpoints.js'
import { buildVscodeHooksConfig } from '../../src/server/installer.js'

/** The rule: the smallest hook kill treecontext installs (VS Code's
 *  timeoutSec, read from the generated config) less a second to fail
 *  gracefully. One rule on every OS: a slow runner gets the same bar. */
const RULE_MS = (() => {
  const cfg = buildVscodeHooksConfig() as { hooks: Record<string, Array<{ timeoutSec: number }>> }
  return Math.min(...Object.values(cfg.hooks).flat().map((e) => e.timeoutSec * 1000)) - 1000
})()
/** Slack on the relative bound, the same on every OS: scheduler jitter
 *  between two spawns and SQLite's busy-wait sleeps on a loaded runner
 *  (the macOS runner overran a 0.5 s slack by 2–4 s, run 41654065600).
 *  The regression this bound exists for, an open granted a fresh budget,
 *  adds a whole 7 s and still fails it. */
const JITTER_MS = 3000

type W = CaptureWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }

type Hook = 'stop' | 'subagent-stop' | 'subagent-start' | 'post-tool-use' | 'user-prompt-submit' | 'pre-compact' | 'session-start'

/** dist/hooks/<hook>.js when the build is newer than src/hooks/shared.ts
 *  (and every hook source), else the sources under tsx. */
function hookArgv(hook: Hook): { argv: string[]; via: 'dist' | 'tsx' } {
  const dist = join(TS_ROOT, 'dist', 'hooks', `${hook}.js`)
  const newest = Math.max(...['shared', 'hook-store', 'hook-deadline', hook].map((f) => statSync(join(TS_ROOT, 'src', 'hooks', `${f}.ts`)).mtimeMs))
  if (existsSync(dist) && statSync(dist).mtimeMs >= newest) return { argv: [dist], via: 'dist' }
  return { argv: tsxArgv(join(TS_ROOT, 'src', 'hooks', `${hook}.ts`)), via: 'tsx' }
}

function run(w: W, hook: Hook, payload: Record<string, unknown>): { ms: number; via: string } {
  const { argv, via } = hookArgv(hook)
  const t0 = Date.now()
  const r = spawnSync(process.execPath, argv, {
    input: JSON.stringify({ session_id: w.sessionId, cwd: w.proj, ...payload }),
    env: sandboxedSpawnEnv(w.home!, { TREECONTEXT_BINDINGS_FILE: join(w.home!, '.treecontext', 'bindings.json') }),
    cwd: TS_ROOT, encoding: 'utf8', timeout: 30_000,
  })
  const ms = Date.now() - t0
  expect(r.status, `hook ${hook} exited ${r.status}${r.error ? ` — ${r.error.message}` : ''}\n${r.stderr ?? ''}`).toBe(0)
  return { ms, via }
}

/** What the busy budgets add to a hook's wall time when the store is held:
 *  the Stop-shaped hooks open twice (guard, then write). */
const BUDGET_OF: Record<Hook, number> = {
  'stop': STOP_GUARD_TIMEOUT_MS + HOOK_DB_TIMEOUT_MS,
  'subagent-stop': STOP_GUARD_TIMEOUT_MS + HOOK_DB_TIMEOUT_MS,
  'subagent-start': HOOK_DB_TIMEOUT_MS,
  'post-tool-use': HOOK_DB_TIMEOUT_MS,
  'user-prompt-submit': HOOK_DB_TIMEOUT_MS,
  'pre-compact': HOOK_DB_TIMEOUT_MS,
  'session-start': HOOK_DB_TIMEOUT_MS,
}

const HOOKS: Array<{ hook: Hook; payload: (w: W) => Record<string, unknown> }> = [
  { hook: 'stop', payload: (w) => ({ hook_event_name: 'Stop', transcript_path: join(w.proj!, 't.jsonl'), last_assistant_message: 'the turn that ended' }) },
  { hook: 'subagent-stop', payload: (w) => ({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'builder', stop_hook_active: false, agent_transcript_path: join(w.proj!, 'a.jsonl'), last_assistant_message: 'the report' }) },
  { hook: 'subagent-start', payload: () => ({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'builder' }) },
  { hook: 'post-tool-use', payload: () => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make test' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false } }) },
  { hook: 'user-prompt-submit', payload: () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'carry on' }) },
  { hook: 'pre-compact', payload: () => ({ hook_event_name: 'PreCompact' }) },
  { hook: 'session-start', payload: () => ({ hook_event_name: 'SessionStart', source: 'startup' }) },
]

describe.skipIf(process.platform === 'win32')('the real hooks against a whole-locked store (wall time)', () => {
  it('the budgets themselves leave room under the rule', () => {
    expect(BUDGET_OF.stop).toBeLessThan(RULE_MS - JITTER_MS)
  })

  it.each(HOOKS.map((h) => [h.hook, h] as const))('%s: under the rule, and the lock adds no more than its budgets', async (_name, h) => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      // lockStore wants every other connection on the file let go first.
      await w.store!.close()
      const baseline = run(w, h.hook, h.payload(w))
      await lockStore(w as unknown as RunWorld, 'whole')
      const locked = run(w, h.hook, h.payload(w))
      const added = locked.ms - baseline.ms
      if (process.env['HOOK_BUDGET_LOG']) appendFileSync(process.env['HOOK_BUDGET_LOG'], `${h.hook} (${locked.via}): baseline ${baseline.ms} ms, locked ${locked.ms} ms, added ${added} ms\n`)
      expect(locked.ms, `${h.hook} took ${locked.ms} ms against a locked store (${locked.via})`).toBeLessThan(RULE_MS)
      expect(added, `the lock added ${added} ms to ${h.hook}; its budgets are ${BUDGET_OF[h.hook]} ms`).toBeLessThanOrEqual(BUDGET_OF[h.hook] + JITTER_MS)
    } finally { await done(w) }
  }, 60_000)

  // The Stop shape with three opens: a store that refuses writes but
  // still reads (the guard reads it whole and finds a bookmark due), so
  // the staging write waits its budget and fails, and the bookmark ask's
  // mark is then written on a third connection. That open waits what is
  // left of the hook's budget, never a fresh 7 s (review of f812992: a
  // fresh one measured 14,074 ms).
  it('stop with a bookmark due, against a store that refuses writes: under the rule, and the lock adds no more than its budgets', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      await w.store!.close()
      // A bookmark due at the next stop: one round per checkpoint, three
      // developer turns staged since none.
      const db = openHookDb(w.dbPath!)
      try { writeCheckpointInterval(db, { rounds: 1, minutes: null }, 'test') } finally { db.close() }
      for (let i = 0; i < 3; i++) writeStaging(w.dbPath!, { sessionId: w.sessionId!, role: 'user', content: `turn ${i}`, timestamp: Date.now() / 1000 - 100 + i })
      const payload = (active: boolean): Record<string, unknown> => ({ hook_event_name: 'Stop', last_assistant_message: active ? 'the baseline turn' : 'the turn that ended', stop_hook_active: active })
      // The baseline asks nothing (a stop the platform marks as continuing
      // is never asked), so the locked stop's ask is still due.
      const baseline = run(w, 'stop', payload(true))
      await lockStore(w as unknown as RunWorld, 'writes')
      const locked = run(w, 'stop', payload(false))
      const added = locked.ms - baseline.ms
      if (process.env['HOOK_BUDGET_LOG']) appendFileSync(process.env['HOOK_BUDGET_LOG'], `stop, bookmark due, writes refused (${locked.via}): baseline ${baseline.ms} ms, locked ${locked.ms} ms, added ${added} ms\n`)
      expect(locked.ms, `stop took ${locked.ms} ms against a write-locked store (${locked.via})`).toBeLessThan(RULE_MS)
      expect(added, `the lock added ${added} ms to stop; its budgets are ${BUDGET_OF.stop} ms`).toBeLessThanOrEqual(BUDGET_OF.stop + JITTER_MS)
    } finally { await done(w) }
  }, 60_000)
})
