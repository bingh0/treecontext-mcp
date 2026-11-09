/**
 * The client's hook event list and what is held against it (D402).
 *
 * `tests/fixtures/claude-code-hooks/events.json` is Claude Code's hook
 * events, kept with the client version and date they were read at. Each
 * event is wired by install or named with what the journal does not capture
 * because of it. Nothing here restates an event name: the wired set is read
 * from `claudeHooksBlock()`, the block install writes, and the observed set
 * from the recorded sessions.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHooksBlock } from '../../src/server/installer.js'
import { RECORDED_HOOK_EVENTS } from './standins.js'

export interface ListedEvent { event: string; when: string; disposition: string; lost?: string; observed: boolean }
export interface EventList { client: string; version: string; read_at: string; sources: string[]; events: ListedEvent[] }

export const EVENT_LIST_PATH = join(RECORDED_HOOK_EVENTS, 'events.json')

export function readEventList(path = EVENT_LIST_PATH): EventList {
  return JSON.parse(readFileSync(path, 'utf8')) as EventList
}

/** Every `hook_event_name` that occurs in any recorded .ndjson. */
export function recordedEventNames(root = RECORDED_HOOK_EVENTS): Set<string> {
  const seen = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(dir, e.name)); continue }
      if (!e.name.endsWith('.ndjson')) continue
      for (const line of readFileSync(join(dir, e.name), 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const name = (JSON.parse(line) as Record<string, unknown>)['hook_event_name']
        if (typeof name === 'string') seen.add(name)
      }
    }
  }
  walk(root)
  return seen
}

/** The list kept with its provenance: parses, names a client version and a
 *  date, holds no event twice. */
export function provenanceProblems(list: EventList): string[] {
  const out: string[] = []
  if (list.client !== 'Claude Code') out.push(`the list names client ${JSON.stringify(list.client)}, not Claude Code`)
  if (!/^\d+\.\d+\.\d+/.test(String(list.version))) out.push('the list names no client version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(list.read_at))) out.push('the list names no date it was read at')
  if (!Array.isArray(list.sources) || list.sources.length === 0) out.push('the list names no sources')
  const seen = new Set<string>()
  for (const e of list.events) {
    if (seen.has(e.event)) out.push(`${e.event} is on the list twice`)
    seen.add(e.event)
  }
  return out
}

/** Each listed event is wired (an event of the block install writes) or
 *  not-captured with a non-empty `lost`; never both, never neither. */
export function dispositionProblems(list: EventList, wiredByInstall: string[] = Object.keys(claudeHooksBlock())): string[] {
  const out: string[] = []
  for (const e of list.events) {
    const inBlock = wiredByInstall.includes(e.event)
    const lost = typeof e.lost === 'string' && e.lost.trim() !== ''
    if (e.disposition === 'wired') {
      if (!inBlock) out.push(`${e.event} is listed as wired but install's block does not hold it`)
      if (e.lost !== undefined) out.push(`${e.event} is wired and also names what is lost`)
    } else if (e.disposition === 'not-captured') {
      if (!lost) out.push(`${e.event} is not captured and names nothing it loses`)
      if (inBlock) out.push(`${e.event} is listed as not captured but install's block wires it`)
    } else {
      out.push(`${e.event} is neither wired nor not-captured (${JSON.stringify(e.disposition)})`)
    }
  }
  return out
}

/** Every event install wires is on the list, as wired. */
export function unlistedWiredProblems(list: EventList, wiredByInstall: string[] = Object.keys(claudeHooksBlock())): string[] {
  return wiredByInstall
    .filter((ev) => !list.events.some((e) => e.event === ev && e.disposition === 'wired'))
    .map((ev) => `install wires ${ev}, which is not on the list as wired`)
}

/** Every event a recording shows is on the list, and `observed` says so
 *  exactly. */
export function recordingProblems(list: EventList, recorded: Set<string> = recordedEventNames()): string[] {
  const out: string[] = []
  for (const ev of recorded) if (!list.events.some((e) => e.event === ev)) out.push(`a recording shows ${ev}, which is not on the list`)
  for (const e of list.events) {
    if (e.observed !== recorded.has(e.event)) out.push(`${e.event} says observed=${String(e.observed)} but the recordings ${recorded.has(e.event) ? 'show' : 'do not show'} it`)
  }
  return out
}
