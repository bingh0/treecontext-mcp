/**
 * D409's event list for Codex CLI, held to account as D402's is for Claude
 * Code (tests/server/claude-event-list.test.ts): green on the list as kept,
 * red on each way it can drift from Codex, from the block install writes
 * for Codex and from Codex's recordings. The @D409 scenario
 * (features/journal-install.feature) binds the same checks.
 */
import { describe, it, expect } from 'vitest'
import { codexHooksBlock } from '../../src/server/codex-hooks.js'
import { claudeHooksBlock } from '../../src/server/installer.js'
import { RECORDED_CODEX_EVENTS, recordedSession, recordedClientOf } from '../journal/standins.js'
import {
  type EventList, CODEX_LIST, readClientEventList, recordedEventNames, provenanceProblems, dispositionProblems, unlistedWiredProblems, recordingProblems,
} from '../journal/event-list.js'

const wired = (): string[] => CODEX_LIST.wired()
const all = (l: EventList, w = wired()): string[] => [
  ...provenanceProblems(l, 'Codex CLI'), ...dispositionProblems(l, w), ...unlistedWiredProblems(l, w), ...recordingProblems(l, recordedEventNames(RECORDED_CODEX_EVENTS)),
]
const clone = (): EventList => structuredClone(readClientEventList(CODEX_LIST))

describe('the Codex CLI event list', () => {
  it('is green as kept, at the version recorded', () => {
    const l = readClientEventList(CODEX_LIST)
    expect(all(l)).toEqual([])
    expect(l.version).toBe('0.167.0')
  })
  it('names the fourteen events Codex has and the two Claude Code events it does not', () => {
    const l = readClientEventList(CODEX_LIST)
    expect(l.events.filter((e) => e.disposition !== 'not-in-client')).toHaveLength(14)
    expect(l.events.filter((e) => e.disposition === 'not-in-client').map((e) => e.event).sort()).toEqual(['PostToolBatch', 'PostToolUseFailure'])
  })
  it('wires neither PostToolUseFailure nor PostToolBatch, which Claude Code\'s block wires', () => {
    expect(wired()).not.toContain('PostToolUseFailure')
    expect(wired()).not.toContain('PostToolBatch')
    expect(Object.keys(claudeHooksBlock())).toEqual(expect.arrayContaining(['PostToolUseFailure', 'PostToolBatch']))
  })
  it('goes red when install wires an event Codex does not have', () => {
    expect(all(readClientEventList(CODEX_LIST), [...wired(), 'PostToolBatch'])).toEqual([expect.stringMatching(/PostToolBatch is listed as not in the client but install's block wires it/), expect.stringMatching(/install wires PostToolBatch/)])
  })
  it('goes red when install wires an event the list lacks, or the list drops a wired one', () => {
    expect(all(readClientEventList(CODEX_LIST), [...wired(), 'SomeNewEvent'])).toEqual([expect.stringMatching(/install wires SomeNewEvent/)])
    const l = clone()
    l.events = l.events.filter((e) => e.event !== 'Interrupt')
    expect(all(l)).toEqual(expect.arrayContaining([expect.stringMatching(/install wires Interrupt/), expect.stringMatching(/recording shows Interrupt/)]))
  })
  it('goes red when an event Codex does not have names nothing lost', () => {
    const l = clone()
    l.events.find((e) => e.event === 'PostToolUseFailure')!.lost = ''
    expect(all(l)).toEqual([expect.stringMatching(/not in the client and names nothing/)])
  })
  it('goes red when the list is Claude Code\'s', () => {
    const l = clone()
    l.client = 'Claude Code'
    expect(provenanceProblems(l, 'Codex CLI')).toEqual([expect.stringMatching(/not Codex CLI/)])
  })
  it('reads Codex\'s recordings from Codex\'s own directory, branded as Codex\'s', () => {
    const events = recordedSession('0.167.0', 'interactive.ndjson', 'codex')
    expect(events.length).toBe(30)
    expect(recordedClientOf(events[0]!)).toBe('codex')
    expect(() => recordedSession('0.167.0', 'interactive.ndjson')).toThrow(/ENOENT/)
  })
})

describe('Codex\'s block', () => {
  it('wires exactly the events the list marks wired, each naming Codex', () => {
    const l = readClientEventList(CODEX_LIST)
    expect(wired().sort()).toEqual(l.events.filter((e) => e.disposition === 'wired').map((e) => e.event).sort())
    for (const groups of Object.values(codexHooksBlock())) {
      expect(groups).toHaveLength(1)
      for (const h of groups[0]!.hooks) expect(h.command).toMatch(/ --client codex$/)
    }
  })
})
