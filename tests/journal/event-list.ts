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
import { codexHooksBlock } from '../../src/server/codex-hooks.js'
import { RECORDED_HOOK_EVENTS, RECORDED_CODEX_EVENTS } from './standins.js'

export interface ListedEvent { event: string; when: string; disposition: string; lost?: string; observed: boolean }
export interface EventList { client: string; version: string; read_at: string; sources: string[]; provenance: string; events: ListedEvent[] }

export const EVENT_LIST_PATH = join(RECORDED_HOOK_EVENTS, 'events.json')

/**
 * A client whose hook events the repository keeps as a list (D402 for
 * Claude Code, D409 for Codex CLI): its name as the list spells it, the
 * fixture directory its list and recordings sit in, and the events of the
 * block install writes for it, read from that block.
 */
export interface ListedClient { name: string; dir: string; wired: () => string[] }
export const CLAUDE_CODE_LIST: ListedClient = { name: 'Claude Code', dir: RECORDED_HOOK_EVENTS, wired: () => Object.keys(claudeHooksBlock()) }
export const CODEX_LIST: ListedClient = { name: 'Codex CLI', dir: RECORDED_CODEX_EVENTS, wired: () => Object.keys(codexHooksBlock()) }

/** A client's list (events.json in its fixture directory). */
export function readClientEventList(client: ListedClient): EventList {
  return readEventList(join(client.dir, 'events.json'))
}

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
export function provenanceProblems(list: EventList, client: string = 'Claude Code'): string[] {
  const out: string[] = []
  if (list.client !== client) out.push(`the list names client ${JSON.stringify(list.client)}, not ${client}`)
  if (!/^\d+\.\d+\.\d+/.test(String(list.version))) out.push('the list names no client version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(list.read_at))) out.push('the list names no date it was read at')
  if (!Array.isArray(list.sources) || list.sources.length === 0) out.push('the list names no sources')
  if (typeof list.provenance !== 'string' || !/re-read/.test(list.provenance)) out.push('the list carries no provenance note saying the hooks reference is re-read at every client upgrade')
  const seen = new Set<string>()
  for (const e of list.events) {
    if (seen.has(e.event)) out.push(`${e.event} is on the list twice`)
    seen.add(e.event)
  }
  return out
}

/** Each listed event is wired (an event of the block install writes) or
 *  not-captured with a non-empty `lost`; never both, never neither. An
 *  event the client does not have (`not-in-client`, D409: Claude Code's
 *  PostToolUseFailure and PostToolBatch on Codex's list) names what the
 *  journal does not capture because of it, and install never wires it. */
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
    } else if (e.disposition === 'not-in-client') {
      if (!lost) out.push(`${e.event} is not in the client and names nothing the journal loses for it`)
      if (inBlock) out.push(`${e.event} is listed as not in the client but install's block wires it`)
      if (e.observed) out.push(`${e.event} is listed as not in the client but says it was observed`)
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
    // A wired event no recording shows may be a misspelling in both the
    // list and the block: every wired event must have been recorded. There
    // is no exception list; one is added here, named with its reason, only
    // for an event that cannot yet be recorded.
    if (e.disposition === 'wired' && !recorded.has(e.event)) out.push(`${e.event} is wired but no recording shows it`)
    if (e.observed !== recorded.has(e.event)) out.push(`${e.event} says observed=${String(e.observed)} but the recordings ${recorded.has(e.event) ? 'show' : 'do not show'} it`)
  }
  return out
}
