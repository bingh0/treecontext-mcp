/**
 * A leg's first moment, composed from the store (features/journal-workers.feature,
 * journal-legs.feature; rulings D279, D281, D292, D298, D303, D313, D315,
 * D319, D329, D332, D334, D335, D339).
 *
 * At its first moment a leg sees its brief and the checkpoint(s) in effect
 * under its key and makes no query (D298, D329): the brief in effect for
 * its role and key, then one checkpoint whole with its number, writer and
 * moment, or both with the line that two are in effect, or the line that
 * none is; beside a checkpoint whose writer is not the checkpointer the run
 * named, the sentence the key lookup gives (D315, the same builder); a leg
 * whose predecessor of its role ended without a checkpoint is told so and
 * starts as a recovery leg (D279, D292, D334); treecontext's own line that
 * a checkpoint is state, not history, is in every first moment (D332); then
 * the spawner's prompt as written.
 *
 * The door writes that first moment as the first row of the leg's lane
 * (D298): the prompt text, with references to the brief and checkpoint
 * rows it was composed from, never copies, so what the leg saw is
 * reconstructable from the store with plain SQL; the row keeps a prompt of
 * any size whole behind a bounded preview, as captured tool output is kept
 * (D313), carries the checkpoints' size, and is the leg's capture, so the
 * valve reaches it with the leg's session (D319, D339).
 *
 * One module for both doors: the ticket door (ticket-door.ts) composes
 * here today, and the hooks door's subagent-start hook composes with the
 * same functions, so the two doors leave the same row (D298) and say the
 * same lines.
 */
import { charactersOf, briefsInEffect, checkpointsInEffect, checkpointsUnder, inEffectLine, type BriefRecord, type CheckpointRecord, type RunReadHandle } from './runs.js'
import { namedCheckpointerOf, isNamedCheckpointer, checkpointerFlag, importFlag, checkpointName, checkpointsWrittenBy, type NamedCheckpointer } from './key-lookup.js'
import { legsOfRun, isLiveLeg, WORKER_AGENT_ID, type LegRegistration } from './persistence/leg-registry.js'
import type { RegistryHandle } from './persistence/session-registry.js'
import { FIRST_MOMENT_KIND, SEND_BACK_KIND, RUN_META_KEY, KEY_META_KEY } from './run-kinds.js'
import { activeIndexCap, TOOL_OUTPUT_PREVIEW_CAP } from './persistence/capture-constants.js'
import { EXPLICIT_INDEX_LEN_KEY, EXPLICIT_PREVIEW_LEN_KEY } from './persistence/index-text.js'
import { TICKET_ENV } from './ticket.js'

// ── Lines treecontext says in its own words ────────────────────────

/** D332: treecontext's own line, in every first moment at both doors,
 *  whatever the brief says about checkpoints. */
export const STATE_NOT_HISTORY_LINE =
  'treecontext: a checkpoint is the state of the work as it now stands. It names what it supersedes and what it rests on, '
  + 'and it never pastes the history in.'

/** D303, D342: the first message of a worker whose ticket the door could
 *  not read whole, in place of the composition: the statement that its
 *  instructions were invalid and the ask for one row and a stop. */
export function invalidInstructionsMessage(absent: readonly string[], read: { role: string | null; run: string | null; key: string | null }): string {
  const what = [read.role ? `the role "${read.role}"` : null, read.run ? `the run "${read.run}"` : null, read.key ? `the key "${read.key}"` : null]
    .filter((s): s is string => s !== null)
  return `treecontext: your instructions were invalid. The ticket in your environment (${TICKET_ENV}) could not be read whole: `
    + `${absent.length > 0 ? `unreadable ${absent.join(', ')}` : 'unreadable'}`
    + `${what.length > 0 ? `; it still reads as ${what.join(', ')}` : ''}. `
    + 'Do no work on it. Write one row to the store saying your instructions were invalid, then stop.'
}

/** D279, D291, D335: the reason a worker is run once more, naming the
 *  missing checkpoint: the first line of the second run's first message. */
export function sendBackReason(role: string, run: string, key: string): string {
  return `treecontext: you are run once more because you exited with no checkpoint under the key "${key}" on the run "${run}" newer than your start, `
    + `and your instructions name the ${role} as the one who will checkpoint it. This is your one send-back; there is no other.`
}

// ── Moments ────────────────────────────────────────────────────────

/** A row's moment as a first message states it. */
export function momentText(at: number): string {
  return new Date(at * 1000).toISOString()
}

// ── The facts a first moment is composed from ──────────────────────

/** A leg of the same role and key that ended before this one started
 *  without a checkpoint under the key (D279, D292, D334): this leg
 *  starts as a recovery leg. */
export interface Predecessor {
  sessionId: string
  agentId: string
  role: string | null
  /** How it ended: cut, retired (finished, or after its one send-back,
   *  with no checkpoint), or as a phantom. */
  ended: 'cut' | 'retired' | 'phantom'
  /** The rows it left in its lane, the door's own rows not counted. */
  rows: number
}

export interface FirstMomentFacts {
  run: string
  key: string | null
  role: string
  /** D341: a one-off worker the ticket declared keyless. */
  noKey: boolean
  /** The brief(s) in effect for the role under the run's key, newest
   *  first (D327); usually one. */
  briefs: BriefRecord[]
  /** The checkpoints in effect under the key (D280, D329). */
  checkpoints: CheckpointRecord[]
  /** D280, D329: the line saying none, one, or how many are in effect. */
  inEffect: string | null
  /** Who the run named as the key's checkpointer (D281, D296). */
  named: NamedCheckpointer
  /** D296, D315, D343: the flag beside each checkpoint that has one, the
   *  same sentence the key lookup gives. */
  flags: Array<{ nodeId: string; sentence: string }>
  /** What the leg's own ticket or brief names about checkpointing (D281). */
  checkpointer: string | null
  checkpointedBy: string | null
  predecessor: Predecessor | null
}

/** The SQL that picks a leg's lane, a worker's whole session or a
 *  subagent's own rows in its session (the key lookup's recipe, D289). */
function laneOf(leg: Pick<LegRegistration, 'kind' | 'agentId' | 'sessionId'>): { where: string; params: unknown[] } {
  return leg.kind === 'worker' || leg.agentId === WORKER_AGENT_ID
    ? { where: 'session_key = ?', params: [leg.sessionId] }
    : { where: "session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?", params: [leg.sessionId, leg.agentId] }
}

/** The rows a leg left in its lane, the door's own rows (its first moment,
 *  a send-back's message) not counted. */
export function laneRowsOf(db: RunReadHandle, leg: Pick<LegRegistration, 'kind' | 'agentId' | 'sessionId'>): number {
  const lane = laneOf(leg)
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE ${lane.where}
        AND COALESCE(json_extract(metadata_json, '$.kind'), '') NOT IN ('${FIRST_MOMENT_KIND}', '${SEND_BACK_KIND}')`,
  ).get(...lane.params) as { n: number } | undefined
  return Number(r?.n ?? 0)
}

/** Whether a leg owed the checkpoint of its key (D281, D291): its brief
 *  or ticket names its own role as the one who will checkpoint it. */
export function owesCheckpoint(leg: Pick<LegRegistration, 'checkpointer' | 'role'>): boolean {
  return leg.checkpointer !== null && leg.role !== null && leg.checkpointer === leg.role
}

/**
 * The leg this one recovers from (D279, D292, D316, D334): the newest leg
 * of the same role registered under the same run and key (its key its own
 * or declared), ended before now, that wrote no checkpoint under the key
 * in its lane, and was cut, found gone, or finished owing the checkpoint
 * (a leg that finished while another role was named to checkpoint the key
 * owed none, D281). A leg that ended with invalid instructions did no
 * work and left no trail to recover (D303), so it is passed over; a newest
 * ended leg that did write a checkpoint means there is nothing to recover.
 */
export function predecessorOf(
  db: RunReadHandle & RegistryHandle, treeId: number | null,
  opts: { run: string; key: string; role: string; except?: { sessionId: string; agentId: string } },
): Predecessor | null {
  const ended = legsOfRun(db, opts.run).filter((l) =>
    l.role === opts.role && l.key === opts.key && (l.keySrc === 'own' || l.keySrc === 'declared')
    && !isLiveLeg(l) && l.ended !== 'invalid'
    && !(opts.except && l.sessionId === opts.except.sessionId && l.agentId === opts.except.agentId))
  if (ended.length === 0) return null
  const endOf = (l: LegRegistration): number => l.stoppedAt ?? l.noticedAt ?? l.startedAt
  const last = ended.reduce((a, b) => (endOf(b) >= endOf(a) ? b : a))
  if (checkpointsWrittenBy(db, treeId, last, opts.run, opts.key).length > 0) return null
  if ((last.ended === null || last.ended === 'retired') && !owesCheckpoint(last)) return null
  return {
    sessionId: last.sessionId, agentId: last.agentId, role: last.role,
    ended: last.ended === 'cut' ? 'cut' : last.ended === 'phantom' ? 'phantom' : 'retired',
    rows: laneRowsOf(db, last),
  }
}

/** The line a recovery leg's first moment carries (D279, D292, D334): its
 *  predecessor's ending, its lane and how many rows it left, and what to
 *  do. The checkpoint in effect is the in-effect line beside it. */
export function recoveryLine(p: Predecessor, key: string): string {
  const role = p.role ?? 'unnamed'
  const how = p.ended === 'cut' ? 'was cut' : p.ended === 'phantom' ? 'was found gone and retired as a phantom' : 'ended without a checkpoint'
  const lane = p.agentId === WORKER_AGENT_ID ? `the lane of session ${p.sessionId}` : `the lane of session ${p.sessionId}, agent ${p.agentId}`
  return `treecontext: your predecessor, the ${role} leg in ${lane}, ${how}, leaving ${p.rows} ${p.rows === 1 ? 'row' : 'rows'} `
    + `and no checkpoint under "${key}". You start as a recovery leg: read its trail in the store, write the checkpoint it did not, and continue.`
}

/**
 * Read what a leg's first moment is composed from (D298, D315, D329):
 * the brief(s) in effect for its role and key, the checkpoints in effect
 * under the key, the flag beside each, and the predecessor it recovers
 * from. `legs` are the run's registrations the named checkpointer is read
 * from when no brief names one, the leg's own among them once registered.
 */
export function firstMomentFactsOf(
  db: RunReadHandle & RegistryHandle, treeId: number | null,
  opts: {
    run: string; key: string | null; role: string; noKey?: boolean
    checkpointer?: string | null; checkpointedBy?: string | null
    self?: { sessionId: string; agentId: string }
  },
): FirstMomentFacts {
  const keyed = opts.key !== null && !opts.noKey
  const briefs = keyed ? briefsInEffect(db, treeId, opts.role).filter((b) => b.run === opts.run && b.key === opts.key) : []
  const checkpoints = keyed ? checkpointsInEffect(db, treeId, opts.run, opts.key!) : []
  const named = keyed ? namedCheckpointerOf(db, treeId, opts.run, opts.key!, legsOfRun(db, opts.run)) : { names: [], by: null }
  const all = keyed ? checkpointsUnder(db, treeId, opts.run, opts.key!) : []
  const flags: FirstMomentFacts['flags'] = []
  for (const cp of checkpoints) {
    const sentence = cp.imported ? importFlag(cp, all)
      : named.by !== null && !isNamedCheckpointer(cp.writer, named) ? checkpointerFlag(cp, named) : null
    if (sentence !== null) flags.push({ nodeId: cp.nodeId, sentence })
  }
  const briefNamed = (k: 'checkpointer' | 'checkpointedBy'): string | null => briefs.find((b) => b[k] !== null)?.[k] ?? null
  return {
    run: opts.run, key: keyed ? opts.key : null, role: opts.role, noKey: opts.noKey === true,
    briefs, checkpoints,
    inEffect: keyed ? inEffectLine(opts.run, opts.key!, checkpoints) : null,
    named, flags,
    // Given (null included), the door's word stands: the registration
    // records who was named (D281); left out, the brief's.
    checkpointer: opts.checkpointer !== undefined ? opts.checkpointer : briefNamed('checkpointer'),
    checkpointedBy: opts.checkpointedBy !== undefined ? opts.checkpointedBy : briefNamed('checkpointedBy'),
    predecessor: keyed ? predecessorOf(db, treeId, { run: opts.run, key: opts.key!, role: opts.role, ...(opts.self ? { except: opts.self } : {}) }) : null,
  }
}

// ── The first message ──────────────────────────────────────────────

/** D281: said when neither the ticket nor the brief names who will
 *  checkpoint the key; the key follows it. */
export const NO_CHECKPOINTER_LINE = 'Neither your ticket nor your brief names who will checkpoint at the end, so no one is named to checkpoint'

/** The heading the spawner's prompt sits under in a first message. */
export const PROMPT_HEADING = "The spawner's prompt:"

/**
 * The first message (D298, D315, D329, D332): the brief, then the
 * checkpoint(s) in effect with number, writer and moment, each whole (the
 * ticket door never cuts one, D332) with its flag beside it, the recovery
 * line when there is a predecessor to recover, treecontext's own line, and
 * the spawner's prompt as written. A one-off worker (D341) is told it owes
 * no checkpoint.
 */
export function composeFirstMessage(f: FirstMomentFacts, prompt: string): string {
  const parts: string[] = []
  if (f.key === null) {
    parts.push(`treecontext: you are a one-off ${f.role} worker of the run "${f.run}". Your ticket says you have no key, so you owe no checkpoint.`)
  } else {
    parts.push(`treecontext: you are the ${f.role} worker of the run "${f.run}", under the key "${f.key}".`)
    if (f.briefs.length === 0) parts.push(`No brief is in effect for the ${f.role} role under "${f.key}" on the run "${f.run}".`)
    for (const b of f.briefs) {
      parts.push(`The brief for the ${f.role} role under "${f.key}" (row ${b.nodeId}, written by "${b.writer}" at ${momentText(b.createdAt)}):\n${b.content}`)
    }
    const owe: string[] = []
    if (f.checkpointer) owe.push(`"${f.checkpointer}" as the one who will checkpoint "${f.key}" at the end`)
    if (f.checkpointedBy) owe.push(`"${f.checkpointedBy}" as the one who checkpointed the work you resume`)
    if (owe.length > 0) parts.push(`Your instructions name ${owe.join(', and ')}.`)
    if (!f.checkpointer) parts.push(`${NO_CHECKPOINTER_LINE} "${f.key}".`)
    parts.push(f.inEffect!)
    for (const cp of f.checkpoints) {
      const flag = f.flags.find((x) => x.nodeId === cp.nodeId)
      parts.push(`${capital(checkpointName(cp.number))} under "${f.key}" (row ${cp.nodeId}), written by "${cp.writer}" at ${momentText(cp.createdAt)}, `
        + `${cp.size} characters:\n${cp.content}${flag ? `\n${flag.sentence}` : ''}`)
    }
    if (f.predecessor) parts.push(recoveryLine(f.predecessor, f.key))
  }
  parts.push(STATE_NOT_HISTORY_LINE)
  parts.push(`${PROMPT_HEADING}\n${prompt}`)
  return parts.join('\n\n')
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The message a worker's second run opens on (D279, D291, D298, D332,
 * D335): the reason naming the missing checkpoint, then the whole first
 * moment composed again from the store as it now stands (the brief, the
 * checkpoint(s) in effect now, each whole with number, writer and moment
 * and its flag, treecontext's own line, the spawner's prompt as written),
 * so the re-run needs no query; then the pointer to its own trail, the
 * lane's row count and its first-moment row, any row fetched whole by
 * export.
 */
export function composeSendBackMessage(o: { facts: FirstMomentFacts; prompt: string; sessionId: string; firstMomentId: string | null; rows: number }): string {
  const f = o.facts
  return [
    sendBackReason(f.role, f.run, f.key ?? ''),
    composeFirstMessage(f, o.prompt),
    `treecontext: your trail is in the store: the lane of session ${o.sessionId}, ${o.rows} ${o.rows === 1 ? 'row' : 'rows'} of your first run`
      + `${o.firstMomentId ? `, after your first moment, the row ${o.firstMomentId}` : ''}; fetch any of them whole by export. `
      + `Write the next checkpoint under "${f.key ?? ''}" on the run "${f.run}", then stop.`,
  ].join('\n\n')
}

// ── The rows the door writes in the leg's lane ─────────────────────

/** D313: the display boundary of a first-moment row, a captured tool
 *  output's (TOOL_OUTPUT_PREVIEW_CAP): a hit shows this much and the
 *  availability marker, an export the whole. */
export const FIRST_MOMENT_PREVIEW_LEN = TOOL_OUTPUT_PREVIEW_CAP

/** D313: a door row's boundaries, as a captured tool event's are stamped:
 *  the index view at the tool cap, the display preview when the text runs
 *  past it. The text itself is kept whole. */
export function doorRowBoundaries(content: string): Record<string, number> {
  const len = content.length
  return {
    [EXPLICIT_INDEX_LEN_KEY]: Math.min(activeIndexCap('tool'), len),
    ...(len > FIRST_MOMENT_PREVIEW_LEN ? { [EXPLICIT_PREVIEW_LEN_KEY]: FIRST_MOMENT_PREVIEW_LEN } : {}),
  }
}

/** The key the first-moment row keeps what it was composed from under. */
export const FIRST_MOMENT_META_KEY = 'first_moment'

/**
 * The first-moment row's metadata (D298, D313, D315, D319, D329, D339),
 * the same at both doors apart from the writer stamp, the lane and the
 * moment, which the door adds: the leg's capture (`source` auto-capture,
 * the spawner's prompt as the leg's user turn), the run and key, the
 * references to the brief and checkpoint rows (never copies), the
 * checkpoints' size in characters, the flags and the recovery the first
 * message carried, and the row's own boundaries. `invalid` records that
 * the first message was the invalid-instructions statement instead
 * (D303), with the fields that could not be read.
 */
export function firstMomentMetadata(o: {
  sessionId: string
  run: string | null
  key: string | null
  prompt: string
  firstMessage: string
  facts: FirstMomentFacts | null
  invalid?: { absent: string[] }
}): Record<string, unknown> {
  const f = o.facts
  const refs = f ? [...f.briefs.map((b) => b.nodeId), ...f.checkpoints.map((c) => c.nodeId)] : []
  const size = f ? f.checkpoints.reduce((n, c) => n + c.size, 0) : 0
  return {
    kind: FIRST_MOMENT_KIND,
    source: 'auto-capture',
    role: 'user',
    session_id: o.sessionId,
    ...(o.run ? { [RUN_META_KEY]: o.run } : {}),
    ...(o.key ? { [KEY_META_KEY]: o.key } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    checkpoint_size: size,
    [FIRST_MOMENT_META_KEY]: {
      brief_ids: f ? f.briefs.map((b) => b.nodeId) : [],
      checkpoints: f ? f.checkpoints.map((c) => ({ node_id: c.nodeId, number: c.number, writer: c.writer, moment: c.createdAt, size: c.size })) : [],
      in_effect: f?.inEffect ?? null,
      flags: f ? f.flags.map((x) => x.sentence) : [],
      recovers: f?.predecessor
        ? { session_id: f.predecessor.sessionId, agent_id: f.predecessor.agentId, role: f.predecessor.role, ended: f.predecessor.ended, rows: f.predecessor.rows }
        : null,
      state_line: true,
      message_chars: charactersOf(o.firstMessage),
      ...(o.invalid ? { invalid: { absent: o.invalid.absent } } : {}),
    },
    ...doorRowBoundaries(o.prompt),
  }
}

/** D335: the row with a re-run's first message, in the leg's lane between
 *  the first run's rows and the second's. */
export function sendBackMetadata(o: { sessionId: string; run: string; key: string; message: string; refs: string[] }): Record<string, unknown> {
  return {
    kind: SEND_BACK_KIND,
    source: 'auto-capture',
    role: 'user',
    session_id: o.sessionId,
    [RUN_META_KEY]: o.run,
    [KEY_META_KEY]: o.key,
    ...(o.refs.length > 0 ? { refs: o.refs } : {}),
    ...doorRowBoundaries(o.message),
  }
}
