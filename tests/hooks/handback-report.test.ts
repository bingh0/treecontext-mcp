/**
 * The hand-back reader of the SubagentStop hook (D371): on Claude Code
 * 2.1.271 and later in auto mode a subagent delivers its report through
 * the `SubagentHandback` tool, so the report is that call's `message` in
 * the subagent's own transcript and the payload's `last_assistant_message`
 * is only its closing text. These are the shapes the charter's bindings do
 * not reach (the owner ruled the shape below the feature layer, D371): the
 * finish just ended against an earlier one, a denied-and-retried
 * hand-back, a blank message, an unreadable file. Transcript lines follow
 * what Claude Code 2.1.316 wrote on 2026-11-02.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractHandbackReport, extractLastAssistantText, HANDBACK_TOOL } from '../../src/hooks/stop.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type Entry = Record<string, unknown>
const user = (text: string): Entry => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const userString = (text: string): Entry => ({ type: 'user', message: { role: 'user', content: text } })
const toolResult = (id: string): Entry => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '{"success":true}' }] }] } })
const toolUse = (name: string, input: Record<string, unknown>, id = 'toolu_x'): Entry => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const handback = (message: string, id = 'toolu_hb'): Entry => toolUse(HANDBACK_TOOL, { message }, id)
const text = (t: string): Entry => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })

function transcript(entries: Entry[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-handback-'))
  dirs.push(dir)
  const p = join(dir, 'agent-a1.jsonl')
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return p
}

describe('extractHandbackReport', () => {
  it('reads the hand-back message of the finish just ended, past its tool result and closing text', () => {
    const p = transcript([user('do the work'), toolUse('Bash', { command: 'npm test' }), handback('12 tests pass'), toolResult('toolu_hb'), text('Report delivered.')])
    expect(extractHandbackReport(p)).toBe('12 tests pass')
    // The text reader still sees only the closing text: the report is never a text block.
    expect(extractLastAssistantText(p)).toBe('Report delivered.')
  })

  it('is null when the finish made no hand-back, even though an earlier finish did (a resumed subagent)', () => {
    const p = transcript([user('do the work'), handback('first finish'), toolResult('toolu_hb'), user('one more thing'), text('second finish, as text')])
    expect(extractHandbackReport(p)).toBeNull()
    expect(extractLastAssistantText(p)).toBe('second finish, as text')
  })

  it('a resume sent as a plain string prompt bounds the scan too', () => {
    const p = transcript([user('do the work'), handback('first finish'), toolResult('toolu_hb'), userString('one more thing'), toolUse('Bash', { command: 'ls' })])
    expect(extractHandbackReport(p)).toBeNull()
  })

  it('takes the newest hand-back of the finish when a denied one was made again', () => {
    const p = transcript([user('do the work'), handback('draft', 'toolu_1'), toolResult('toolu_1'), handback('final', 'toolu_2'), toolResult('toolu_2')])
    expect(extractHandbackReport(p)).toBe('final')
  })

  it('a blank newest hand-back is no report, and no older one stands in', () => {
    const p = transcript([user('do the work'), handback('older'), toolResult('toolu_hb'), handback('   ', 'toolu_2'), toolResult('toolu_2')])
    expect(extractHandbackReport(p)).toBeNull()
  })

  it('is null for a transcript with no hand-back, an unreadable file, and lines that are not JSON', () => {
    expect(extractHandbackReport(transcript([user('do the work'), text('ok')]))).toBeNull()
    expect(extractHandbackReport(join(tmpdir(), 'tc-handback-none', 'missing.jsonl'))).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'tc-handback-'))
    dirs.push(dir)
    const p = join(dir, 'agent.jsonl')
    writeFileSync(p, 'not json\n' + JSON.stringify(handback('still read')) + '\n{broken\n')
    expect(extractHandbackReport(p)).toBe('still read')
  })
})
