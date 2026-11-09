/**
 * D402's event list guard, held to account: it is green on the list as kept
 * and red on each way the list can drift from the client, from install's
 * block and from the recordings (the red-proof, kept as tests). The @D402
 * scenario (features/journal-install.feature) binds the same checks.
 */
import { describe, it, expect } from 'vitest'
import { claudeHooksBlock } from '../../src/server/installer.js'
import { recordedSession, replayRecordedSession, isRecordedEvent } from '../journal/standins.js'
import type { CaptureWorld } from '../journal/capture-harness.js'
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
  it('goes red when a wired event is misspelled in the list and the block alike', () => {
    const l = clone()
    l.events.find((e) => e.event === 'Stop')!.event = 'Stopp'
    expect(all(l, Object.keys(claudeHooksBlock()).map((e) => (e === 'Stop' ? 'Stopp' : e)))).toEqual(expect.arrayContaining([
      expect.stringMatching(/Stopp is wired but no recording shows it/), expect.stringMatching(/recording shows Stop, which is not on the list/),
    ]))
  })
  it('goes red when the provenance note is missing', () => {
    const l = clone()
    l.provenance = ''
    expect(provenanceProblems(l)).toEqual([expect.stringMatching(/provenance note/)])
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

describe('the replay refuses a payload that is not a recording', () => {
  const world = {} as CaptureWorld // the refusal comes before the world is touched
  it('brands what recordedSession returns and nothing else', () => {
    const [first] = recordedSession('2.1.319', 'serial-failures-and-denials.ndjson')
    expect(isRecordedEvent(first!)).toBe(true)
    expect(isRecordedEvent({ ...first! })).toBe(false)
  })
  it('throws on a hand-written event and on a copy of a recorded one', () => {
    const [first] = recordedSession('2.1.319', 'serial-failures-and-denials.ndjson')
    expect(() => replayRecordedSession(world, [{ hook_event_name: 'PostToolUse', tool_name: 'Bash' }])).toThrow(/did not come from recordedSession/)
    expect(() => replayRecordedSession(world, [{ ...first! }])).toThrow(/did not come from recordedSession/)
  })
})
