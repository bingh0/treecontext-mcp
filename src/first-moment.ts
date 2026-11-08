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
import { CHECKPOINT_CAP_CHARS, charactersOf, briefsInEffect, checkpointsInEffect, checkpointsUnder, inEffectLine, type BriefRecord, type CheckpointRecord, type RunReadHandle } from './runs.js'
import { namedCheckpointerOf, isNamedCheckpointer, checkpointerFlag, importFlag, checkpointNameOf, checkpointsWrittenBy, type NamedCheckpointer } from './key-lookup.js'
import { legsOfRun, isLiveLeg, legOwnsKey, WORKER_AGENT_ID, type LegRegistration } from './persistence/leg-registry.js'
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
export function sendBackReason(role: string, run: string, key: string, refused?: { size: number } | null): string {
  return `treecontext: you are run once more because you exited with no checkpoint under the key "${key}" on the run "${run}" newer than your start, `
    + `and your instructions name the ${role} as the one who will checkpoint it.${capClause(refused ?? null)} `
    + 'This is your one send-back; there is no other.'
}

/** D299: what a send-back says when the leg's checkpoint under the key was
 *  refused at the cap and it wrote no other: the size refused, the cap, and
 *  the shape asked for. Empty when no refusal is on record. */
export function capClause(refused: { size: number } | null): string {
  if (refused === null) return ''
  return ` The checkpoint you wrote under it, ${refused.size} characters, was refused for being past the ${CHECKPOINT_CAP_CHARS}-character cap, and nothing of it was written. `
    + 'Write a shorter one: the state of the work as it now stands, naming what it supersedes and what it rests on, with the history left out '
    + `(a second write past the cap by you under this key would be accepted and marked as over it).`
}

/** D321: what a first moment and the lookup say beside a checkpoint the
 *  store marked as over the cap: it was accepted on its second write. */
export function overCapWords(m: { size: number; cap: number; second?: boolean }): string {
  return m.second === false
    ? `written over the ${m.cap}-character cap by a writer the store keeps no refusal for`
    : `accepted over the ${m.cap}-character cap on its second write`
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
  // A cut or gone leg's key is its key whether or not it ever wrote under
  // it (D328: "the next leg of its role under its key starts as a
  // recovery leg"): a leg killed mid-work had no stop to settle anything.
  // A leg that stopped on its own with its key still inferred wrote
  // nothing under it and is keyless (D326), never recovered from.
  const ended = legsOfRun(db, opts.run).filter((l) =>
    l.role === opts.role && l.key === opts.key
    && (legOwnsKey(l) || (l.keySrc === 'inferred' && (l.ended === 'cut' || l.ended === 'phantom')))
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

/** How a first message is composed at each door. */
export interface ComposeOptions {
  /** The hooks door (a subagent leg, D284, D320): the leg is named a leg,
   *  its key said to be inferred from its role's brief, and no spawner's
   *  prompt follows, since the Agent tool carries the prompt itself. */
  door?: 'ticket' | 'hooks'
  /** The text each checkpoint is given as (the hooks door's cut at the
   *  client's cap, D325); whole by default. */
  contentOf?: (cp: CheckpointRecord) => string
  /** The hooks door: the key is the leg's own (it wrote under it), not the
   *  one inferred from its brief (D320, D326); said so in the first line. */
  keyOwn?: boolean
}

/**
 * The first message (D298, D315, D329, D332): the brief, then the
 * checkpoint(s) in effect with number, writer and moment, each whole (the
 * ticket door never cuts one, D332) with its flag beside it, the recovery
 * line when there is a predecessor to recover, treecontext's own line, and
 * the spawner's prompt as written. A one-off worker (D341) is told it owes
 * no checkpoint. At the hooks door (`door: 'hooks'`) the same parts, the
 * leg named a leg and no prompt: the Agent tool delivers the prompt.
 */
export function composeFirstMessage(f: FirstMomentFacts, prompt: string | null, opts: ComposeOptions = {}): string {
  const hooks = opts.door === 'hooks'
  const parts: string[] = []
  if (f.key === null) {
    parts.push(`treecontext: you are a one-off ${f.role} worker of the run "${f.run}". Your ticket says you have no key, so you owe no checkpoint.`)
  } else {
    parts.push(hooks
      ? opts.keyOwn
        ? `treecontext: you are the ${f.role} leg of the run "${f.run}", under the key "${f.key}", your own: you wrote under it.`
        : `treecontext: you are the ${f.role} leg of the run "${f.run}", under the key "${f.key}", inferred from the brief in effect for your role. `
          + 'Your first write under a key of the run makes that key your own.'
      : `treecontext: you are the ${f.role} worker of the run "${f.run}", under the key "${f.key}".`)
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
      const text = opts.contentOf ? opts.contentOf(cp) : cp.content
      parts.push(`${capital(checkpointNameOf(cp))} under "${f.key}" (row ${cp.nodeId}), written by "${cp.writer}" at ${momentText(cp.createdAt)}, `
        + `${cp.size} characters${cp.overCap ? `, ${overCapWords(cp.overCap)}` : ''}:\n${text}${flag ? `\n${flag.sentence}` : ''}`)
    }
    if (f.predecessor) parts.push(recoveryLine(f.predecessor, f.key))
  }
  parts.push(STATE_NOT_HISTORY_LINE)
  if (prompt !== null) parts.push(`${PROMPT_HEADING}\n${prompt}`)
  return parts.join('\n\n')
}

// ── The hooks door's cap (D325, D332) ──────────────────────────────

/** D325: the client's cap on what one hook may inject, in characters (its
 *  additionalContext, systemMessage and plain stdout each; Claude Code's
 *  hooks reference). Above it the client writes the text to a file the
 *  store never records and the leg is never asked to read, so the hooks
 *  door keeps every injection at or under it. Counted as the client
 *  counts, in JavaScript string length. */
export const HOOK_CONTEXT_CAP = 10_000

/** The line that ends a checkpoint the hooks door cut at the client's cap
 *  (D325): the checkpoint row's id and how many characters were left out,
 *  and the door that fetches the whole. */
export function hookCutMarker(nodeId: string, leftOut: number): string {
  return `\n…[cut at the client's ${HOOK_CONTEXT_CAP}-character hook cap: checkpoint row ${nodeId}, ${leftOut} characters left out; `
    + 'fetch it whole with treecontext_export]'
}

/** The line that ends a first moment cut whole at the cap, when even the
 *  brief and the lines around the checkpoints do not fit (a brief past the
 *  cap): the rows it was composed from, to fetch by export. */
export function hookWholeCutMarker(leftOut: number, ids: string[]): string {
  return `\n…[cut at the client's ${HOOK_CONTEXT_CAP}-character hook cap: ${leftOut} characters left out; `
    + `fetch the rows it was composed from whole with treecontext_export: ${ids.join(', ')}]`
}

/** What the hooks door cut of each checkpoint, for the first-moment row. */
export interface HookCut {
  cap: number
  /** The whole first moment's length, before any cut. */
  whole_chars: number
  /** Each checkpoint cut, with the characters left out of it. */
  checkpoints: Array<{ node_id: string; number: number | null; size: number; left_out: number }>
  /** Characters left out of the message as a whole, when it was cut whole
   *  (a brief past the cap). */
  left_out?: number
}

/** Code units of `text` within its first `max` units, never splitting a
 *  surrogate pair. */
function headOf(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/**
 * The hooks door's first moment under the client's cap (D325, D332): whole
 * when it fits; otherwise the brief and every line around the checkpoints
 * whole, and as much of each checkpoint as fits, in order, each cut one
 * ending in its row's id and the count left out, so the leg fetches the
 * rest by export. Never above the cap.
 */
export function fitHookCap(f: FirstMomentFacts, opts: { door?: 'hooks'; compose?: (o: ComposeOptions) => string } = {}): { message: string; cut: HookCut | null } {
  const compose = opts.compose ?? ((o: ComposeOptions): string => composeFirstMessage(f, null, { door: 'hooks', ...o }))
  const whole = compose({})
  if (whole.length <= HOOK_CONTEXT_CAP) return { message: whole, cut: null }
  const base = compose({ contentOf: (cp) => hookCutMarker(cp.nodeId, cp.size) })
  let budget = HOOK_CONTEXT_CAP - base.length
  if (budget < 0 || f.checkpoints.length === 0) {
    // D332: treecontext's own line is in every first moment, a cut one
    // too: it and the marker are reserved before the cut, and the line
    // closes the message whatever the cut took.
    const ids = [...f.briefs.map((b) => b.nodeId), ...f.checkpoints.map((c) => c.nodeId)]
    const tail = `\n\n${STATE_NOT_HISTORY_LINE}`
    const at = whole.lastIndexOf(STATE_NOT_HISTORY_LINE)
    const body = at >= 0 ? whole.slice(0, at).replace(/\n+$/, '') + whole.slice(at + STATE_NOT_HISTORY_LINE.length) : whole
    const probe = hookWholeCutMarker(charactersOf(body), ids)
    const kept = headOf(body, HOOK_CONTEXT_CAP - probe.length - tail.length)
    const leftOut = charactersOf(body) - charactersOf(kept)
    return {
      message: kept + hookWholeCutMarker(leftOut, ids) + tail,
      cut: { cap: HOOK_CONTEXT_CAP, whole_chars: charactersOf(whole), checkpoints: [], left_out: leftOut },
    }
  }
  const kept = new Map<string, string>()
  for (const cp of f.checkpoints) {
    const k = headOf(cp.content, budget)
    kept.set(cp.nodeId, k)
    budget -= k.length
  }
  const checkpoints: HookCut['checkpoints'] = []
  const message = compose({
    contentOf: (cp) => {
      const k = kept.get(cp.nodeId) ?? cp.content
      if (k.length >= cp.content.length) return cp.content
      const leftOut = cp.size - charactersOf(k)
      checkpoints.push({ node_id: cp.nodeId, number: cp.number, size: cp.size, left_out: leftOut })
      return k + hookCutMarker(cp.nodeId, leftOut)
    },
  })
  return { message, cut: { cap: HOOK_CONTEXT_CAP, whole_chars: charactersOf(whole), checkpoints } }
}

/** D320: the first moment of a leg whose role has more than one brief in
 *  effect: its key is ambiguous, the candidates named with their briefs,
 *  and no checkpoint carried, since no key is its own until it writes
 *  under one; treecontext's own line closes it, as every first moment. */
export function ambiguousFirstMessage(role: string, briefs: BriefRecord[]): string {
  const parts = [
    `treecontext: you are a ${role} leg whose key is ambiguous: ${briefs.length} briefs are in effect for your role, `
      + `under ${briefs.map((b) => `"${b.key}" on the run "${b.run}"`).join(' and ')}. Your first write under one of those keys makes it your own; `
      + 'until then no checkpoint is yours to start from, and you can read the one in effect under a key with treecontext_query\'s key_lookup.',
    ...briefs.map((b) => `The brief for the ${role} role under "${b.key}" on the run "${b.run}" (row ${b.nodeId}, written by "${b.writer}" at ${momentText(b.createdAt)}):\n${b.content}`),
    STATE_NOT_HISTORY_LINE,
  ]
  return parts.join('\n\n')
}

/**
 * D284, D285, D330: the one line naming a leg's return, its summary row,
 * with its writer, run and key (the key only when it is the leg's own or
 * declared, as the summary row carries it). The hooks door adds it to what
 * the main agent receives when the Agent tool returns; the ticket door
 * hands the same facts to its spawner.
 */
export function returnPointerLine(o: { role: string | null; writer: string; run: string | null; key: string | null; summaryId: string }): string {
  return `treecontext: the ${o.role ?? 'unnamed'} leg's return is the summary row ${o.summaryId} (writer "${o.writer}"`
    + `${o.run ? `, run "${o.run}"` : ''}${o.key ? `, key "${o.key}"` : ''}); fetch it with treecontext_export.`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The message a worker's second run opens on (D279, D291, D298, D332,
 * D335, D382): the whole first moment composed again from the store as it
 * now stands (the brief, the checkpoint(s) in effect now, each whole with
 * number, writer and moment and its flag, treecontext's own line, the
 * spawner's prompt as written), so the re-run needs no query, and so it
 * opens on the worker line the instruction block names; then the reason
 * naming the missing checkpoint; then the pointer to its own trail, the
 * lane's row count and its first-moment row, any row fetched whole by
 * export.
 */
export function composeSendBackMessage(o: {
  facts: FirstMomentFacts; prompt: string | null; sessionId: string; firstMomentId: string | null; rows: number
  /** The hooks door: a subagent leg's lane is its agent's rows in its
   *  session, and its first moment carries no prompt (composeFirstMessage). */
  agentId?: string; door?: 'ticket' | 'hooks'
  /** The first moment as composed again (the hooks door's, fitted to the
   *  client's cap); composed here when not given. */
  firstMessage?: string
  /** D299: the refusal of the cap on the leg's registration under its key,
   *  named in the reason when the leg wrote no other. */
  capRefused?: { size: number } | null
}): string {
  const f = o.facts
  const lane = o.agentId ? `the lane of session ${o.sessionId}, agent ${o.agentId}` : `the lane of session ${o.sessionId}`
  return [
    o.firstMessage ?? composeFirstMessage(f, o.prompt, o.door ? { door: o.door } : {}),
    sendBackReason(f.role, f.run, f.key ?? '', o.capRefused ?? null),
    `treecontext: your trail is in the store: ${lane}, ${o.rows} ${o.rows === 1 ? 'row' : 'rows'} of your first run`
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
  /** The hooks door: what it cut at the client's cap, or null when the
   *  first moment went whole (D325: the row records the cut). */
  hookCut?: HookCut | null
  /** D320: the hooks door's ambiguous registration, the candidate briefs. */
  ambiguousBriefs?: string[]
}): Record<string, unknown> {
  const f = o.facts
  const refs = f ? [...f.briefs.map((b) => b.nodeId), ...f.checkpoints.map((c) => c.nodeId)] : [...(o.ambiguousBriefs ?? [])]
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
    // D321: the first-moment row shows the next leg what an over-cap
    // checkpoint cost; each checkpoint's own mark is in `first_moment`.
    ...(f && f.checkpoints.some((c) => c.overCap) ? { checkpoint_over_cap: true } : {}),
    [FIRST_MOMENT_META_KEY]: {
      brief_ids: f ? f.briefs.map((b) => b.nodeId) : (o.ambiguousBriefs ?? []),
      checkpoints: f ? f.checkpoints.map((c) => ({ node_id: c.nodeId, number: c.number, writer: c.writer, moment: c.createdAt, size: c.size, ...(c.overCap ? { over_cap: c.overCap } : {}) })) : [],
      in_effect: f?.inEffect ?? null,
      flags: f ? f.flags.map((x) => x.sentence) : [],
      recovers: f?.predecessor
        ? { session_id: f.predecessor.sessionId, agent_id: f.predecessor.agentId, role: f.predecessor.role, ended: f.predecessor.ended, rows: f.predecessor.rows }
        : null,
      state_line: true,
      message_chars: charactersOf(o.firstMessage),
      ...(o.invalid ? { invalid: { absent: o.invalid.absent } } : {}),
      ...(o.hookCut !== undefined ? { cut: o.hookCut } : {}),
      ...(o.ambiguousBriefs ? { ambiguous: o.ambiguousBriefs } : {}),
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
