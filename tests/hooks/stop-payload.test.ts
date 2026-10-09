/**
 * The Stop hook captures the turn that just ended (D249), through the real
 * hook subprocess and the production drain, read back from SQLite.
 *
 * The fixture holds the seven Stop payloads Claude Code 2.1.293 sent in
 * the live headless probe of 2026-10-08 (five runs), byte for byte except
 * the raw logger's envelope and the home directory's user name, which the
 * release scan forbids. At each of those Stops the session transcript
 * still ended at the PREVIOUS turn: the hook that read it captured every
 * turn one late and the session's final answer never. Each payload is run
 * here against a transcript in that state, so only the payload's own
 * `last_assistant_message` can put the right text in the journal.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { type CaptureWorld, openCaptureWorld, runHook, drainStaging, rawJournal } from '../journal/capture-harness.js'

type W = CaptureWorld & { cleanups: Array<() => unknown> }
function mkWorld(): W {
  const cleanups: Array<() => unknown> = []
  return { cleanups, defer: (fn: () => unknown) => { cleanups.push(fn) } } as unknown as W
}
async function done(w: W): Promise<void> { for (const f of w.cleanups.reverse()) await f() }

const FIXTURE = join(import.meta.dirname, 'fixtures', 'stop-payloads-cc-2.1.293.jsonl')
const payloads = (): Array<Record<string, unknown>> =>
  readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)

/** A transcript as Claude Code holds it when Stop fires: its last
 *  assistant text is the turn before the one that just ended. */
function staleTranscript(w: W, previousTurn: string): string {
  const p = join(w.proj!, 'transcript.jsonl')
  writeFileSync(p, [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go on' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: previousTurn }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  return p
}

/** A recorded payload pointed at the sandbox: its cwd (which the store
 *  resolves from) and its transcript path; every other field verbatim. */
function sandboxed(w: W, p: Record<string, unknown>, previousTurn: string): Record<string, unknown> {
  return { ...p, cwd: w.proj, transcript_path: staleTranscript(w, previousTurn) }
}

const responses = (w: W): Array<{ content: string; session: unknown }> =>
  rawJournal(w)
    .filter((r) => r.metadata['role'] === 'assistant' && !r.metadata['tool_name'])
    .sort((a, b) => (a.metadata['created_at'] as number) - (b.metadata['created_at'] as number))
    .map((r) => ({ content: r.content, session: r.metadata['session_id'] }))

describe('the Stop hook captures the turn that just ended (D249)', () => {
  it('the seven recorded Claude Code 2.1.293 Stop payloads each journal their own last_assistant_message', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      const recorded = payloads()
      expect(recorded).toHaveLength(7)
      let previous = 'the turn before the first recorded stop'
      for (const p of recorded) {
        expect(p['hook_event_name']).toBe('Stop')
        runHook(w, 'stop', sandboxed(w, p, previous))
        previous = String(p['last_assistant_message'])
      }
      await drainStaging(w)
      expect(responses(w)).toEqual(recorded.map((p) => ({ content: p['last_assistant_message'], session: p['session_id'] })))
    } finally { await done(w) }
  })

  it('a payload without last_assistant_message falls back to the transcript', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      const p = { ...payloads()[0]! }
      delete p['last_assistant_message']
      runHook(w, 'stop', sandboxed(w, p, 'the transcript is all an older platform gives'))
      await drainStaging(w)
      expect(responses(w).map((r) => r.content)).toEqual(['the transcript is all an older platform gives'])
    } finally { await done(w) }
  })

  it('a blank last_assistant_message falls back to the transcript', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      runHook(w, 'stop', sandboxed(w, { ...payloads()[0]!, last_assistant_message: '  \n' }, 'the transcript text'))
      await drainStaging(w)
      expect(responses(w).map((r) => r.content)).toEqual(['the transcript text'])
    } finally { await done(w) }
  })

  it('a re-fired Stop carrying the same last_assistant_message stages nothing new', async () => {
    const w = mkWorld()
    try {
      await openCaptureWorld(w)
      const p = payloads()[2]!
      runHook(w, 'stop', sandboxed(w, p, 'an earlier turn'))
      runHook(w, 'stop', sandboxed(w, p, 'an earlier turn'))
      const raw = new BetterSqlite3(w.dbPath!, { readonly: true })
      try {
        const n = (raw.prepare(`SELECT COUNT(*) AS n FROM staging WHERE role = 'assistant' AND tool_name IS NULL`).get() as { n: number }).n
        expect(n, 'the stale-recapture guard compares the payload text').toBe(1)
      } finally { raw.close() }
    } finally { await done(w) }
  })
})
