/**
 * The census script's classification (scripts/capture-census.ts), on a
 * SYNTHETIC transcript and a SYNTHETIC store built here: neither is a
 * client's or treecontext's own output; they exist to pin how a call is
 * judged. The script's far-side check (a real client, a real store) is
 * `npm run dogfood:census`.
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  parseTranscript, classify, tabulate, renderLost, storeViewOf, inputNeedle, inputSectionOf, exitCodeOf, parseArgs, projectsDirName,
  scriptedCallsMissing, INFER_WINDOW_SECS,
} from '../scripts/capture-census.js'
import { DEDUP_WINDOW_SECS } from '../src/persistence/capture-constants.js'

const S = 'synthetic-session'
const T0 = Date.parse('2026-11-09T10:00:00Z') / 1000
const iso = (secs: number): string => new Date((T0 + secs) * 1000).toISOString()
const line = (o: Record<string, unknown>, at: number): string => JSON.stringify({ sessionId: S, timestamp: iso(at), ...o })
const use = (id: string, name: string, input: Record<string, unknown>, at: number, msg = `m_${id}`): string =>
  line({ type: 'assistant', message: { id: msg, content: [{ type: 'tool_use', id, name, input }] } }, at)
const result = (id: string, isError: boolean, at: number): string =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } }, at)
const call = (id: string, name: string, input: Record<string, unknown>, at: number, isError = false): string =>
  [use(id, name, input, at), result(id, isError, at + 1)].join('\n')

const TRANSCRIPT = [
  call('t_stored', 'Bash', { command: 'echo stored-call' }, 0),
  call('t_failed', 'Bash', { command: 'ls /synthetic-missing' }, 10, true),
  call('t_staged', 'Read', { file_path: '/synthetic/staged.txt' }, 20),
  call('t_old', 'Grep', { pattern: 'synthetic-old' }, 30),
  call('t_empty', 'mcp__x__status', {}, 40),
  call('t_twin1', 'Bash', { command: 'echo twin' }, 50),
  call('t_twin2', 'Bash', { command: 'echo twin' }, 51),
  call('t_output_only', 'Bash', { command: 'echo only-in-output' }, 70),
  call('t_late', 'Bash', { command: 'echo late-call' }, 80),
  use('t_noresult', 'Bash', { command: 'sleep 99' }, 90),
  line({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 't_blob', name: 'Bash', input: { command: 'x' } }] } }, 0),
  use('t_stored', 'Bash', { command: 'echo stored-call' }, 0),
].join('\n')

function syntheticStore(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, content TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL DEFAULT 0, source_label TEXT DEFAULT 'auto-capture')")
  db.exec('CREATE TABLE staging (id INTEGER PRIMARY KEY, session_id TEXT, tool_use_id TEXT, processed INTEGER NOT NULL DEFAULT 0)')
  let n = 0
  const node = (content: string, meta: Record<string, unknown>, at: number): void => {
    db.prepare('INSERT INTO nodes (node_id, content, metadata_json) VALUES (?, ?, ?)')
      .run(`n${++n}`, content, JSON.stringify({ session_id: S, created_at: T0 + at, ...meta }))
  }
  node('Tool: Bash\nInput:\ncommand:\necho stored-call\nOutput:\nstored-call', { tool_name: 'Bash', tool_use_id: 't_stored' }, 1)
  node('Tool: Grep\nInput:\npattern:\nsynthetic-old\nOutput:\nx', { tool_name: 'Grep' }, 31)
  node('Tool: mcp__x__status\nOutput:\n{"ok":true}', { tool_name: 'mcp__x__status' }, 41)
  // one node for two identical calls: the first call's own, no id
  node('Tool: Bash\nInput:\ncommand:\necho twin\nOutput:\ntwin', { tool_name: 'Bash' }, 51)
  // the needle only in an Output section
  node('Tool: Bash\nInput:\ncommand:\necho something-else\nOutput:\necho only-in-output', { tool_name: 'Bash' }, 71)
  // a node for t_late, but far outside the window
  node('Tool: Bash\nInput:\ncommand:\necho late-call\nOutput:\nx', { tool_name: 'Bash' }, 81 + INFER_WINDOW_SECS + 30)
  db.prepare("INSERT INTO staging (session_id, tool_use_id, processed) VALUES (?, 't_staged', 0)").run(S)
  // A note whose metadata names a lost call's id (any caller can write the
  // key): not a captured tool row, so never the call's (constructed).
  db.prepare("INSERT INTO nodes (node_id, content, metadata_json, source_label) VALUES ('note1', 'a note about t_failed', ?, 'manual')")
    .run(JSON.stringify({ session_id: S, created_at: T0 + 2, tool_use_id: 't_failed', tool_name: 'Bash' }))
  return db
}

describe('capture census classification (synthetic transcript and store)', () => {
  const calls = parseTranscript(TRANSCRIPT, 'synthetic.jsonl')
  const statusOf = (db = syntheticStore(), cs = calls): Record<string, string> =>
    Object.fromEntries(classify(cs, storeViewOf(db)).map((r) => [r.call.id, r.status]))

  it('reads calls, outcomes and the session of each line, each call once', () => {
    expect(calls.map((c) => [c.id, c.outcome]).slice(0, 3)).toEqual([['t_stored', 'succeeded'], ['t_failed', 'failed'], ['t_staged', 'succeeded']])
    expect(calls.find((c) => c.id === 't_noresult')!.outcome).toBe('no result')
    expect(calls.filter((c) => c.id === 't_stored')).toHaveLength(1)
    expect(calls.every((c) => c.session === S)).toBe(true)
    const two = parseTranscript([
      JSON.stringify({ type: 'assistant', sessionId: 'a', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'assistant', sessionId: 'b', message: { content: [{ type: 'tool_use', id: 'x2', name: 'Bash', input: {} }] } }),
    ].join('\n'), 'f')
    expect(two.map((c) => c.session)).toEqual(['a', 'b'])
  })

  it('--since drops earlier calls', () => {
    expect(parseTranscript(TRANSCRIPT, 'f', new Date('2026-11-10T00:00:00Z'))).toEqual([])
  })

  it('observes by id; infers one node per call; an empty input matches on tool and time', () => {
    const s = statusOf()
    expect(s['t_stored']).toBe('stored')
    expect(s['t_staged']).toBe('staged')
    expect(s['t_old']).toBe('before-id')
    expect(s['t_empty']).toBe('before-id')
    expect(s['t_failed']).toBe('LOST')
  })

  it('two identical calls with one node: the first claims it, the second is deduplicated, never a second claim', () => {
    const s = statusOf()
    expect(s['t_twin1']).toBe('before-id')
    expect(s['t_twin2']).toBe('deduplicated')
  })

  it('a needle that appears only in an Output section does not match', () => {
    expect(statusOf()['t_output_only']).toBe('LOST')
  })

  it('a call with nothing within the window is LOST', () => {
    expect(statusOf()['t_late']).toBe('LOST')
    expect(statusOf()['t_noresult']).toBe('LOST')
  })

  it('a survivor outside the dedup window, or later than the call, does not deduplicate', () => {
    const db = syntheticStore()
    db.prepare("UPDATE nodes SET metadata_json = json_set(metadata_json, '$.created_at', ?) WHERE node_id = 'n4'").run(T0 + 51 - DEDUP_WINDOW_SECS - 10)
    expect(statusOf(db)['t_twin2']).toBe('LOST')
  })

  it('counts by outcome and status, and says which are observed', () => {
    const rows = classify(calls, storeViewOf(syntheticStore()))
    const t = tabulate(rows)
    expect(t.succeeded).toMatchObject({ stored: 1, staged: 1 })
    expect(t.failed.LOST).toBe(1)
    expect(renderLost(rows)).toContain('Bash t_failed')
  })

  it('exits 0 only when all observed, 1 on LOST, 3 on inferred only', () => {
    const rows = (...s: string[]) => s.map((status) => ({ call: calls[0]!, status })) as Parameters<typeof exitCodeOf>[0]
    expect(exitCodeOf(rows('stored', 'staged'))).toBe(0)
    expect(exitCodeOf(rows('stored', 'before-id'))).toBe(3)
    expect(exitCodeOf(rows('before-id', 'LOST'))).toBe(1)
    expect(exitCodeOf(rows('staged'), false)).toBe(1)
  })

  it("reads a node's Input section only", () => {
    expect(inputSectionOf('Tool: Bash\nInput:\ncommand:\nls\nOutput:\nout')).toBe('command:\nls')
    expect(inputSectionOf('Tool: Bash\nInput:\ncommand:\nls...\nOutput:\nout\n--- FULL ---\nInput:\ncommand:\nls -la\nOutput:\nlong')).toBe('command:\nls -la')
    expect(inputSectionOf('Tool: x\nOutput:\nonly')).toBeNull()
  })

  it('reads the longest string of an input, first line, 80 characters', () => {
    expect(inputNeedle({ a: 'x', b: 'first line\nsecond' })).toBe('first line')
    expect(inputNeedle({ n: 3 })).toBe('')
    expect(inputNeedle({ a: 'y'.repeat(200) })).toHaveLength(80)
  })

  it("checks a live run made the scripted calls, by name, outcome and message", () => {
    const mk = (id: string, name: string, cmd: Record<string, unknown>, outcome: 'succeeded' | 'failed', messageId: string) =>
      ({ id, name, input: cmd, outcome, session: S, at: T0, messageId, file: 'f' })
    const full = [
      mk('1', 'Bash', { command: 'echo census-ok' }, 'succeeded', 'a'), mk('2', 'Bash', { command: 'exit 3 census-fail' }, 'failed', 'b'),
      mk('3', 'Read', { file_path: './no-such-file-census.txt' }, 'failed', 'c'), mk('4', 'Edit', { old_string: 'string-that-is-not-there' }, 'failed', 'd'),
      mk('5', 'Write', { file_path: '/etc/census-denied.txt' }, 'failed', 'e'),
      mk('6', 'Bash', { command: 'echo census-par-a' }, 'succeeded', 'f'), mk('7', 'Bash', { command: 'echo census-par-b' }, 'succeeded', 'f'),
    ]
    expect(scriptedCallsMissing(full)).toEqual([])
    expect(scriptedCallsMissing(full.filter((c) => c.id !== '3'))).toHaveLength(1)
    expect(scriptedCallsMissing(full.map((c) => (c.id === '7' ? { ...c, messageId: 'g' } : c)))).toEqual(['the two parallel calls in one assistant message'])
  })

  it('parses the command line and names the project directory as the client does', () => {
    expect(parseArgs(['--transcript', 'a.jsonl', '--transcript', 'b.jsonl', '--since', '2026-11-09', '--verbose']).verbose).toBe(true)
    expect(() => parseArgs(['--since', 'nope'])).toThrow(/ISO/)
    expect(() => parseArgs(['--probe-event', 'X'])).toThrow(/unknown/)
    expect(projectsDirName('/a/b.c_d')).toBe('-a-b-c-d')
  })
})
