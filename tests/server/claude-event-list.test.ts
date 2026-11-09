/**
 * D402's event list guard, held to account: it is green on the list as kept
 * and red on each way the list can drift from the client, from install's
 * block and from the recordings (the red-proof, kept as tests). The @D402
 * scenario (features/journal-install.feature) binds the same checks.
 */
import { describe, it, expect } from 'vitest'
import { claudeHooksBlock } from '../../src/server/installer.js'
import {
  type EventList, readEventList, recordedEventNames, provenanceProblems, dispositionProblems, unlistedWiredProblems, recordingProblems,
} from '../journal/event-list.js'

const all = (l: EventList, wired = Object.keys(claudeHooksBlock())): string[] => [
  ...provenanceProblems(l), ...dispositionProblems(l, wired), ...unlistedWiredProblems(l, wired), ...recordingProblems(l),
]
const clone = (): EventList => structuredClone(readEventList())

describe('the Claude Code event list', () => {
  it('is green as kept', () => { expect(all(readEventList())).toEqual([]) })
  it('holds 33 events and every recorded event', () => {
    expect(readEventList().events).toHaveLength(33)
    expect(recordedEventNames().size).toBeGreaterThan(5)
  })
  it('goes red when an event is removed from the list', () => {
    const l = clone()
    l.events = l.events.filter((e) => e.event !== 'PostToolBatch')
    expect(all(l)).toEqual(expect.arrayContaining([expect.stringMatching(/install wires PostToolBatch/), expect.stringMatching(/recording shows PostToolBatch/)]))
  })
  it('goes red when install wires an event the list lacks', () => {
    expect(all(readEventList(), [...Object.keys(claudeHooksBlock()), 'SomeNewEvent'])).toEqual([expect.stringMatching(/install wires SomeNewEvent/)])
  })
  it('goes red when a not-captured event names nothing it loses', () => {
    const l = clone()
    l.events.find((e) => e.disposition === 'not-captured')!.lost = ''
    expect(all(l)).toEqual([expect.stringMatching(/names nothing it loses/)])
  })
  it('goes red when an event is listed twice, or wired and not-captured at once', () => {
    const l = clone()
    l.events.push({ ...l.events[0]! })
    expect(provenanceProblems(l)).toEqual([expect.stringMatching(/on the list twice/)])
    const m = clone()
    m.events.find((e) => e.event === 'Stop')!.disposition = 'not-captured'
    expect(all(m).join('\n')).toMatch(/Stop is not captured and names nothing[\s\S]*Stop is listed as not captured but install's block wires it/)
  })
})
