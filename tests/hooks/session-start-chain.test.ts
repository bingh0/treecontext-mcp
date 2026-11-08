/**
 * The /clear chain (D216) at its edges, against the real session-start
 * hook as a subprocess: a clear mints a new session id, and the packet is
 * built from the session the pid beacon names as the one the clear ends.
 * When no beacon names one, the packet says so — it never claims the
 * session has no checkpoint (the charter scenarios bind the main path in
 * features/journal-reorientation.feature).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FlatStore } from '../../src/flat-store.js'
import { openNodeSqlite } from '../../src/persistence/node-sqlite.js'
import { writeSessionBeacon } from '../../src/session-beacon.js'
import { type CaptureWorld, openCaptureSandbox, runHook, hookJson } from '../journal/capture-harness.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function world(): Promise<CaptureWorld & { root: string }> {
  const w = { defer: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as CaptureWorld
  openCaptureSandbox(w)
  mkdirSync(dirname(w.dbPath!), { recursive: true })
  const store = await FlatStore.open({ database: openNodeSqlite(new DatabaseSync(w.dbPath!)), ownsDatabase: true })
  cleanups.push(() => store.close())
  w.store = store
  await store.insert('plan: the chapter before the clear; next: its tests', {
    metadata: { next_session: true, _cc_session_id: w.sessionId }, createdAt: Date.now() / 1000 - 600,
  })
  return Object.assign(w, { root: w.sessionId! })
}

function clearAs(w: CaptureWorld, newId: string): string {
  w.sessionId = newId
  const run = runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'clear', transcript_path: join(w.proj!, 't.jsonl') })
  const out = hookJson(run.stdout)?.['hookSpecificOutput'] as Record<string, unknown> | undefined
  return String(out?.['additionalContext'] ?? '')
}

describe('session-start on /clear follows the session chain (D216)', () => {
  it('reads the predecessor named by the pid beacon, across two clears', async () => {
    const w = await world()
    writeSessionBeacon(w.dbPath!, process.pid, w.root, w.proj!, { rewrite: true })
    const first = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(first.split('\n')[0]).toMatch(/^Chapter summary, 10 minutes old .*the chapter before the clear/)
    // The second clear's beacon names the first clear's id; the chain
    // still reaches the chapter written two sessions back.
    const second = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(second.split('\n')[0]).toMatch(/^Chapter summary, 10 minutes old/)
  })

  it('says it cannot tell which session the clear continues when no beacon names one', async () => {
    const w = await world()
    // No beacon for this process: the startup hook never ran here.
    const packet = clearAs(w, `cc-${randomBytes(6).toString('hex')}`)
    expect(packet).toMatch(/could not tell which session this clear continues/)
    expect(packet).toMatch(/rather than assuming none exist/)
    expect(packet.split('\n').some((l) => l.startsWith('No chapter summary'))).toBe(false)
  })
})

describe('a /clear stops the self of the session it continues (F2)', () => {
  it('the predecessor\'s self gets its stop at the clear\'s moment; the new self has none; a resume opens it again', async () => {
    const w = await world()
    const self = (id: string): { stopped_at: number | null; started_at: number } | undefined => {
      const db = new DatabaseSync(w.dbPath!, { readOnly: true })
      try {
        return db.prepare("SELECT stopped_at, started_at FROM session_registry WHERE session_id = ? AND agent_id = ''").get(id) as { stopped_at: number | null; started_at: number } | undefined
      } finally { db.close() }
    }
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', transcript_path: join(w.proj!, 't.jsonl') })
    expect(self(w.root)?.stopped_at).toBeNull()
    writeSessionBeacon(w.dbPath!, process.pid, w.root, w.proj!, { rewrite: true })
    const before = Date.now() / 1000
    const next = `cc-${randomBytes(6).toString('hex')}`
    clearAs(w, next)
    const after = Date.now() / 1000
    const stopped = self(w.root)!.stopped_at
    expect(stopped).not.toBeNull()
    expect(stopped!).toBeGreaterThanOrEqual(before - 1)
    expect(stopped!).toBeLessThanOrEqual(after + 1)
    // The clear's own session is registered, open, at the same moment.
    expect(self(next)).toMatchObject({ stopped_at: null })
    expect(self(next)!.started_at).toBe(stopped)
    // A later resume of the continued session registers it open again.
    w.sessionId = w.root
    runHook(w, 'session-start', { hook_event_name: 'SessionStart', source: 'resume', transcript_path: join(w.proj!, 't.jsonl') })
    expect(self(w.root)?.stopped_at).toBeNull()
  })
})
