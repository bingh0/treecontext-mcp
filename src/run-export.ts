/**
 * A run's export, the rows it is made of and what its reply says
 * (features/journal-runs.feature; rulings D300, D310, D318, D319, D343).
 *
 * A run is exported as a unit by an agent, a harness or a human, with or
 * without a form named (D300). The form is the caller's:
 *
 *  - `skeleton`, the run's default: its open and close, every brief, every
 *    checkpoint under every key in order, every leg's first-moment row
 *    whole (D318) and summary row, and each leg's registration as data;
 *    enough to resume or review the run elsewhere, and no captured tool
 *    output but the end of a failed worker's error stream its summary row
 *    holds (D384, D398). No acknowledgement is asked for it, so its reply
 *    says in one line what the first moments are (FIRST_MOMENTS_NOTE), in
 *    another which first moments are a door's line (D368), and in a third
 *    which summary rows hold an error stream's end (D398).
 *  - `whole`: the skeleton plus every row of every leg's lane, behind the
 *    same secrets acknowledgement as the whole journal (D177).
 *
 * D300 declined "no run form, a run filter on the existing forms" because
 * the `summaries` form carries no checkpoint and no first moment, so the
 * default of a filtered `summaries` could not resume a run. So `run` names
 * which run is exported and the run has a form of its own for the default
 * (`skeleton`); `whole` keeps its name and its gate, and `summaries` is
 * not a run's form.
 *
 * A leg's registration is a row of the session registry's table, which is
 * no journal row. It crosses stores as one synthesized row of the file,
 * `leg-registration`, whose facts sit under `_leg_registration`: a claim
 * on import like any other (D165), so the importing store counts the leg
 * as arrived by import (D310) and never registers it, never retires it as
 * a phantom, never trusts its identity. The exporting store's own table is
 * not changed; the row's id is derived from the leg, so importing the same
 * leg twice lands it once.
 */
import { createHash } from 'node:crypto'
import {
  RUN_OPEN_KIND, RUN_CLOSE_KIND, BRIEF_KIND, CHECKPOINT_KIND, FIRST_MOMENT_KIND, SUBAGENT_SUMMARY_KIND,
  LEG_REGISTRATION_KIND, LEG_REGISTRATION_KEY, RUN_META_KEY, KEY_META_KEY, HANDOFF_CLAIMS_KEY,
} from './run-kinds.js'
import { STORE_WRITER } from './persistence/session-registry.js'
import { legWriterOf, WORKER_AGENT_ID, type LegRegistration, type LegKind, type LegDoor, type LegIdentity, type KeySource, type LegEnding } from './persistence/leg-registry.js'

/** The forms of a run's export (D300). */
export type RunForm = 'skeleton' | 'whole'

/** The kinds a run's skeleton is made of: the run's open and close, each
 *  brief, each checkpoint, each leg's first moment and summary row, and
 *  the registrations an earlier import brought. */
export const SKELETON_KINDS: readonly string[] = [
  RUN_OPEN_KIND, RUN_CLOSE_KIND, BRIEF_KIND, CHECKPOINT_KIND, FIRST_MOMENT_KIND, SUBAGENT_SUMMARY_KIND, LEG_REGISTRATION_KIND,
]

/** D318: the one line the reply of a run export says about the first
 *  moments it carries whole. */
export const FIRST_MOMENTS_NOTE =
  "First moments carry the spawners' prompts as written and may hold what was pasted into them."

/** What a hooks-door subagent leg's first-moment row says of the prompt it
 *  never saw: the Agent tool carried it. The row's own last sentence. */
export const PROMPT_UNSEEN_SENTENCE = 'Its prompt rode on the Agent tool and is not seen by this door.'

/** How every door's line in a first-moment row opens (the hooks door's
 *  subagent line, a `claude -p` child's session-start line). */
export const DOOR_LINE_OPENING = 'treecontext: the first moment of '

/** A first-moment row whose text is a door's own line, not a prompt: the
 *  prompt was never seen by the door that wrote it (D298, D320). */
export function isDoorLine(content: string): boolean {
  return content.startsWith(DOOR_LINE_OPENING) && /\bnot seen by this door\.\s*$/.test(content)
}

/** The sentence a door's line ends on, the part that says the prompt is
 *  not in the row. */
function doorLineTail(content: string): string {
  const body = content.trimEnd()
  const cut = body.lastIndexOf('. ', body.length - 2)
  return cut === -1 ? body : body.slice(cut + 2)
}

/** The one reply line for the first moments that are a door's line and not
 *  a prompt (D318): which legs, why, and how the row reads. Null when
 *  every first moment is a prompt. */
export function doorLineNote(rows: ReadonlyArray<{ content: string; leg: string }>): string | null {
  const doors = rows.filter((r) => isDoorLine(r.content))
  if (doors.length === 0) return null
  const legs = [...new Set(doors.map((r) => r.leg))].join(', ')
  const tails = [...new Set(doors.map((r) => doorLineTail(r.content)))].map((t) => `"${t}"`).join(' or ')
  return `${doors.length} of the ${rows.length} first moments ${doors.length === 1 ? 'is' : 'are'} the door's own line, not a prompt (${legs}): `
    + `the prompt of ${doors.length === 1 ? 'that leg' : 'those legs'} rode on the Agent tool or the client's own argument and is not in the row, which ends ${tails}.`
}

/** D398: the shape of the failed-run line (first-moment.ts failedRunLine,
 *  D384) when it holds the end of the error stream, all of it or its last
 *  characters, never the empty stream's line: the one pattern a reader of
 *  a summary row tells such a row by. Spelled here rather than beside the
 *  composer because first-moment.ts reads runs.ts, which reads this
 *  module; tests/run-export.test.ts holds the two together. */
const ERROR_TAIL_LINE = /^treecontext: the worker exited with code -?\d+(?: having printed nothing)?; (?:its error stream, all \d+ characters of it|the last \d+ of the \d+ characters it wrote to its error stream, the earlier part was left out):$/m

/** Whether a summary row holds the end of its worker's error stream: it
 *  carries the failed-run line with a stream after it (D384, D398). */
export function holdsErrorTail(content: string): boolean {
  return ERROR_TAIL_LINE.test(content)
}

/**
 * D398: the one reply line for the summary rows that hold the end of their
 * worker's error stream (D384, D397: a worker that failed or printed
 * nothing), told by the failed-run line (holdsErrorTail):
 * which legs, and that a CLI may write command output there, so for those
 * legs the skeleton carries captured output after all; nothing is redacted
 * and nothing left out. Null when no summary row holds one.
 */
export function errorTailNote(rows: ReadonlyArray<{ content: string; leg: string }>): string | null {
  const tails = rows.filter((r) => holdsErrorTail(r.content))
  if (tails.length === 0) return null
  const legs = [...new Set(tails.map((r) => r.leg))].join(', ')
  const one = tails.length === 1
  return `${tails.length} of the ${rows.length} summary rows ${one ? 'holds' : 'hold'} the end of ${one ? 'its' : 'their'} worker's error stream (${legs}): `
    + `a CLI may write command output there, so for ${one ? 'that leg' : 'those legs'} this skeleton carries captured output after all, `
    + 'as written: nothing is redacted and nothing is left out.'
}

/** How a summary row's leg is named in the reply (D398): its writer, and
 *  its agent id, or for a ticket-door worker (its agent id the door's
 *  `worker`) its session, which is its lane. An imported row is named
 *  from its sender's stamps under the file's claims. */
export function summaryLegName(meta: Record<string, unknown> | null): string {
  const claims = meta?.[HANDOFF_CLAIMS_KEY]
  const claimed = claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : {}
  const stamp = (k: string): string | null => {
    const own = meta?.[k]
    if (typeof own === 'string' && own !== '') return own
    const c = claimed[k]
    return typeof c === 'string' && c !== '' ? c : null
  }
  const writer = stamp('_writer') ?? 'a leg'
  const agentId = stamp('_writer_agent_id')
  const session = typeof meta?.['session_id'] === 'string' ? meta['session_id'] : stamp('_cc_session_id')
  if (agentId !== null && agentId !== WORKER_AGENT_ID) return `${writer} (agent ${agentId})`
  return session !== null ? `${writer} worker in session ${session}` : `${writer} worker`
}

// ── A leg's registration, as a row ─────────────────────────────────

const stepOf = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The registration facts a run's export carries for a leg, plain JSON.
 *  What a process did on the exporting host (its pid and start token), a
 *  ticket's raw text and a client session link mean nothing elsewhere and
 *  are left out. */
export function legFactsOf(leg: LegRegistration): Record<string, unknown> {
  return {
    session_id: leg.sessionId, agent_id: leg.agentId, role: leg.role, kind: leg.kind, door: leg.door, identity: leg.identity,
    run: leg.run, key: leg.key, key_src: leg.keySrc, brief_id: leg.briefId,
    checkpointer: leg.checkpointer, checkpointed_by: leg.checkpointedBy, start_checkpoints: leg.startCheckpoints,
    parent_session: leg.parentSession, parent_src: leg.parentSrc, parent_declared: leg.parentDeclared,
    // The writer the leg's rows carried in its own store.
    writer: legWriterOf(leg),
    host: leg.host, ended: leg.ended, noticed_at: leg.noticedAt, noticed_by: leg.noticedBy,
    opened_runs: leg.openedRuns, send_backs: leg.sendBacks,
    worktree: leg.worktree, branch: leg.branch, cwd: leg.cwd, started_at: leg.startedAt, stopped_at: leg.stoppedAt,
  }
}

const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A leg as the importing store reads the file's claim of it: the same
 * shape a registration has, every field the file's word and the ones a
 * file cannot honestly carry (a process, a ticket, a cap refusal) empty.
 * Null when the claim is not a registration of any leg (no session, no
 * agent id).
 */
export function legFromFacts(facts: unknown): LegRegistration | null {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return null
  const f = facts as Record<string, unknown>
  const sessionId = textOrNull(f['session_id'])
  const agentId = textOrNull(f['agent_id'])
  if (!stepOf(sessionId) || agentId === null) return null
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const parentDeclared = f['parent_declared']
  return {
    sessionId, agentId, role: textOrNull(f['role']),
    kind: textOrNull(f['kind']) as LegKind | null, door: textOrNull(f['door']) as LegDoor | null, identity: textOrNull(f['identity']) as LegIdentity | null,
    run: textOrNull(f['run']), key: textOrNull(f['key']), keySrc: textOrNull(f['key_src']) as KeySource | null,
    keyCandidates: [], briefId: textOrNull(f['brief_id']),
    checkpointer: textOrNull(f['checkpointer']), checkpointedBy: textOrNull(f['checkpointed_by']), startCheckpoints: list(f['start_checkpoints']),
    parentSession: textOrNull(f['parent_session']), parentSrc: textOrNull(f['parent_src']) as 'hook' | 'declared' | null,
    parentDeclared: parentDeclared !== null && typeof parentDeclared === 'object' && !Array.isArray(parentDeclared)
      ? parentDeclared as LegRegistration['parentDeclared'] : null,
    ticketMintedAt: null, ticketRaw: null, ticketAbsent: [], canWrite: null,
    host: textOrNull(f['host']), pid: null, procStart: null, procStartToken: null, procNs: null, processes: [],
    sendBacks: numOrNull(f['send_backs']) ?? 0, ended: textOrNull(f['ended']) as LegEnding | null,
    noticedAt: numOrNull(f['noticed_at']), noticedBy: textOrNull(f['noticed_by']), openedRuns: list(f['opened_runs']),
    keySettledFrom: null, capRefused: [], clientSessions: [],
    worktree: textOrNull(f['worktree']), branch: textOrNull(f['branch']), cwd: textOrNull(f['cwd']),
    startedAt: numOrNull(f['started_at']) ?? 0, stoppedAt: numOrNull(f['stopped_at']),
  }
}

/** The registration facts that define which leg a registration is, those a
 *  registration never changes after it is made: its role, kind, run, door,
 *  the parent that spawned it and the moment it started. What a leg does
 *  later (its key settling, how it ended) is not among them. */
const DEFINING_FACTS: ReadonlyArray<[name: string, of: (l: LegRegistration) => unknown]> = [
  ['role', (l) => l.role], ['kind', (l) => l.kind], ['run', (l) => l.run], ['door', (l) => l.door],
  ['parent_session', (l) => l.parentSession], ['started_at', (l) => l.startedAt],
]

/** The defining facts on which a file's registration of a leg disagrees
 *  with the registration a store holds of the same leg (D360). Empty when
 *  they agree: the leg is then already present. */
export function differingFacts(held: LegRegistration, claimed: LegRegistration): string[] {
  return DEFINING_FACTS.filter(([, of]) => of(held) !== of(claimed)).map(([name]) => name)
}

/** The id of a leg's registration row, derived from the leg so the same
 *  leg exported twice, or re-exported from a store it was imported into,
 *  is one row wherever it lands (D164). */
export function registrationRowId(run: string, sessionId: string, agentId: string): string {
  return createHash('sha256').update(`${LEG_REGISTRATION_KIND}\0${run}\0${sessionId}\0${agentId}`).digest('hex').slice(0, 32)
}

/** How a leg is named in a row's text and a reply: its role and door. */
export function legNameOf(leg: Pick<LegRegistration, 'role' | 'kind' | 'agentId'>): string {
  const role = leg.role ?? 'unnamed'
  return leg.kind === 'worker' ? `${role} worker` : `${role} leg (agent ${leg.agentId})`
}

/** The text of a registration row: one line a person and a search read. */
export function registrationText(leg: LegRegistration): string {
  const key = leg.key !== null ? ` under the key "${leg.key}"` : ' with no key'
  const end = leg.ended !== null ? `it ended ${leg.ended}` : leg.stoppedAt !== null ? 'it was retired' : 'it was live when this was exported'
  return `treecontext: registration of the ${legNameOf(leg)} of the run "${leg.run ?? ''}"${key}, through the ${leg.door ?? 'unrecorded'} door`
    + `${leg.parentSession !== null ? `, spawned from session ${leg.parentSession}` : ''}; ${end}.`
}

/** A node of a run's export, the shape every export file carries
 *  (flat-store.ts ExportedNode, structurally). */
export interface RunExportNode {
  nodeId: string
  parentId: null
  depth: 0
  isLeaf: true
  content: string
  summary: ''
  createdAt: number
  updatedAt: number
  summaryStale: false
  readOnly: false
  decayExempt: false
  utilityScore: 0.5
  sourceLabel: null
  metadata: Record<string, unknown>
}

/**
 * A leg's registration as the row of a run's export (D300: "the legs'
 * registrations"; D310). `session_id` is the leg's own, so the row lands
 * in the same handoff lane as the leg's other rows; the facts are the
 * file's claim under `_leg_registration`, the leg's writer among them; the
 * row's own writer is the store's name, since the store composed it. No `role` key at the top level: that is
 * the conversation's role (user, assistant, tool), not the leg's.
 */
export function registrationNode(leg: LegRegistration): RunExportNode {
  const run = leg.run ?? ''
  return {
    nodeId: registrationRowId(run, leg.sessionId, leg.agentId),
    parentId: null, depth: 0, isLeaf: true,
    content: registrationText(leg),
    summary: '',
    createdAt: leg.startedAt, updatedAt: leg.stoppedAt ?? leg.startedAt,
    summaryStale: false, readOnly: false, decayExempt: false, utilityScore: 0.5, sourceLabel: null,
    metadata: {
      kind: LEG_REGISTRATION_KIND,
      [RUN_META_KEY]: run,
      ...(leg.key !== null ? { [KEY_META_KEY]: leg.key } : {}),
      session_id: leg.sessionId,
      // A row the store composes bears the store's own name, as a run's open
      // at a registration does (D354, D360); the leg's writer is inside.
      _writer: STORE_WRITER,
      _writer_src: 'store',
      [LEG_REGISTRATION_KEY]: legFactsOf(leg),
    },
  }
}

/** The leg a first-moment row belongs to, by the row's own metadata, for
 *  the reply to name: its lane's session and the writer the row carries. */
export function firstMomentLegName(meta: Record<string, unknown> | null): string {
  // A row that arrived by import carries its sender's stamps under the
  // file's claims, never at its top level (D360): the leg is named from
  // there when the row's own stamps are absent.
  const claims = meta?.[HANDOFF_CLAIMS_KEY]
  const claimed = claims !== null && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : {}
  const stamp = (k: string): string | null => {
    const own = meta?.[k]
    if (typeof own === 'string' && own !== '') return own
    const c = claimed[k]
    return typeof c === 'string' && c !== '' ? c : null
  }
  const writer = stamp('_writer')
  const agentId = stamp('_writer_agent_id')
  const agent = agentId !== null ? ` (agent ${agentId})` : ''
  const session = typeof meta?.['session_id'] === 'string' ? meta['session_id'] : null
  return `${writer ?? 'a leg'}${agent}${session !== null && agent === '' ? ` in session ${session}` : ''}`
}
