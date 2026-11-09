/**
 * The census script's classification (scripts/capture-census.ts), on a
 * SYNTHETIC transcript and a SYNTHETIC store built here: neither is a
 * client's or treecontext's own output; they exist to pin how a call is
 * judged. The script's far-side check (a real client, a real store) is
 * `npm run dogfood:census`.
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { parseTranscript, classify, tabulate, renderLost, storeViewOf, inputNeedle, parseArgs, projectsDirName } from '../scripts/capture-census.js'

const S = 'synthetic-session'
const line = (o: Record<string, unknown>): string => JSON.stringify({ sessionId: S, timestamp: '2026-11-09T10:00:00Z', ...o })
const use = (id: string, name: string, input: Record<string, unknown>): string =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, isError: boolean): string =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } })

const TRANSCRIPT = [
  use('t_stored', 'Bash', { command: 'echo stored-call' }), result('t_stored', false),
  use('t_failed', 'Bash', { command: 'ls /synthetic-missing' }), result('t_failed', true),
  use('t_staged', 'Read', { file_path: '/synthetic/staged.txt' }), result('t_staged', false),
  use('t_dedup', 'Bash', { command: 'echo same-text' }), result('t_dedup', false),
  use('t_old', 'Grep', { pattern: 'synthetic-old' }), result('t_old', false),
  use('t_lost', 'Edit', { file_path: '/synthetic/lost.txt', old_string: 'a' }), result('t_lost', true),
  use('t_noresult', 'Bash', { command: 'sleep 99' }),
  // a request blob repeating an earlier block, and a repeated streamed line
  line({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 't_blob', name: 'Bash', input: { command: 'x' } }] } }),
  use('t_stored', 'Bash', { command: 'echo stored-call' }),
].join('\n')

function syntheticStore(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE nodes (node_id TEXT PRIMARY KEY, content TEXT NOT NULL, metadata_json TEXT)')
  db.exec('CREATE TABLE staging (id INTEGER PRIMARY KEY, session_id TEXT, tool_use_id TEXT, processed INTEGER NOT NULL DEFAULT 0)')
  const node = (id: string, content: string, meta: Record<string, unknown>): void => {
    db.prepare('INSERT INTO nodes (node_id, content, metadata_json) VALUES (?, ?, ?)').run(id, content, JSON.stringify({ session_id: S, ...meta }))
  }
  node('n1', 'Tool: Bash\nInput:\ncommand:\necho stored-call', { tool_name: 'Bash', tool_use_id: 't_stored' })
  node('n2', 'Tool: Bash\nInput:\ncommand:\necho same-text', { tool_name: 'Bash', tool_use_id: 't_other' })
  node('n3', 'Tool: Grep\nInput:\npattern:\nsynthetic-old', { tool_name: 'Grep' })
  db.prepare("INSERT INTO staging (session_id, tool_use_id, processed) VALUES (?, 't_staged', 0)").run(S)
  return db
}

describe('capture census classification (synthetic transcript and store)', () => {
  const calls = parseTranscript(TRANSCRIPT, 'synthetic.jsonl')

  it('reads calls and outcomes from assistant and user lines only, each call once', () => {
    expect(calls.map((c) => [c.id, c.outcome])).toEqual([
      ['t_stored', 'succeeded'], ['t_failed', 'failed'], ['t_staged', 'succeeded'], ['t_dedup', 'succeeded'],
      ['t_old', 'succeeded'], ['t_lost', 'failed'], ['t_noresult', 'no result'],
    ])
    expect(calls.every((c) => c.session === S)).toBe(true)
  })

  it('--since drops earlier calls', () => {
    expect(parseTranscript(TRANSCRIPT, 'f', new Date('2026-11-10T00:00:00Z'))).toEqual([])
  })

  it('classifies stored, staged, deduplicated, before-id and LOST', () => {
    const rows = classify(calls, storeViewOf(syntheticStore()))
    expect(Object.fromEntries(rows.map((r) => [r.call.id, r.status]))).toEqual({
      t_stored: 'stored', t_failed: 'LOST', t_staged: 'staged', t_dedup: 'deduplicated',
      t_old: 'before-id', t_lost: 'LOST', t_noresult: 'LOST',
    })
    const t = tabulate(rows)
    expect(t.succeeded).toMatchObject({ stored: 1, staged: 1, deduplicated: 1, 'before-id': 1, LOST: 0 })
    expect(t.failed.LOST).toBe(2)
    expect(t['no result'].LOST).toBe(1)
    expect(renderLost(rows).split('\n')).toHaveLength(3)
    expect(renderLost(rows)).toContain('Edit t_lost')
  })

  it('a processed staging row does not count as staged', () => {
    const db = syntheticStore()
    db.exec('UPDATE staging SET processed = 1')
    expect(classify(calls, storeViewOf(db)).find((r) => r.call.id === 't_staged')!.status).toBe('LOST')
  })

  it('reads the longest string of an input, first line, 80 characters', () => {
    expect(inputNeedle({ a: 'x', b: 'first line\nsecond' })).toBe('first line')
    expect(inputNeedle({ n: 3 })).toBe('')
    expect(inputNeedle({ a: 'y'.repeat(200) })).toHaveLength(80)
  })

  it('parses the command line and names the project directory as the client does', () => {
    expect(parseArgs(['--transcript', 'a.jsonl', '--transcript', 'b.jsonl', '--since', '2026-11-09']).transcripts).toHaveLength(2)
    expect(() => parseArgs(['--since', 'nope'])).toThrow(/ISO/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown/)
    expect(projectsDirName('/a/b.c_d')).toBe('-a-b-c-d')
  })
})
