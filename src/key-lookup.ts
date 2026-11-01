/**
 * The key lookup, the harness's and the agent's one reply
 * (features/journal-runs.feature, journal-legs.feature; rulings D289,
 * D296, D301, D312, D320, D326, D336, D337, D341, D343, D344).
 *
 * By run and key together, with no model in the loop (D289): the phantom
 * pass on this host first (the lookup is a reader of the registry, D297),
 * then every checkpoint in effect under the key with its writer (two as
 * two, none as an honest nothing, runs.ts), each with
 *  - the flag in words when its writer is not the checkpointer the brief
 *    or ticket named, or when it arrived by import (D296, D343);
 *  - the pointer to the return of the leg that wrote it, its summary row,
 *    or the plain statement that it left none (D336);
 * and beside them the run's facts: legs run, keyless legs among them,
 * checkpoints under the key, the run's start and age, the sizes of the
 * last {3} checkpoints under the key (D301, D320, D344), and each leg of
 * the run as live or how it ended, a live leg with its start and its last
 * write (D289, D312).
 *
 * The store judges nothing (D293, D296, D301, D312): nothing is withheld,
 * re-ranked or called stuck; the flag says a fact about a writer, the
 * facts are numbers and moments, and the harness or the next leg decides.
 *
 * The library door returns a KeyLookup (lookupKey, FlatStore.lookupKey);
 * keyLookupReply turns it into the reply both doors hand over, the
 * harness's through the library and the agent's through the query tool's
 * key_lookup mode (D337), so the two are one shape by construction.
 */
import {
  legsOfRun, legOf, retirePhantoms, isLiveLeg, NOTICED_BY_LOOKUP, WORKER_AGENT_ID,
  type LegRegistration, type PhantomPass,
} from './persistence/leg-registry.js'
import { agentWriterOf, type RegistryHandle } from './persistence/session-registry.js'
import type { ProcessProbe } from './persistence/process-probe.js'
import { SUBAGENT_SUMMARY_KIND } from './handoff.js'
import { parseMeta } from './dedup-identity.js'
import { writerOf } from './references.js'
import { RUN_META_KEY, KEY_META_KEY } from './run-kinds.js'
import {
  checkpointsUnder, inEffectAmong, inEffectLine, briefsOfKey, runOpenOf, HANDOFF_CLAIMS_KEY,
  type CheckpointRecord, type RunReadHandle,
} from './runs.js'

// ── Names ──────────────────────────────────────────────────────────

/** D344: the reply carries the sizes of the last {3} checkpoints under the
 *  key, newest last ({3} chosen at the gate over {5}: enough to see a
 *  trend, small enough to read in one line). */
export const LAST_SIZES_SHOWN = 3

/** D337 (the carrier [chosen] in DESIGN.md): the query tool's run-and-key
 *  lookup mode, the parameter that names the run and the key. With it the
 *  tool returns this module's reply, not search hits. */
export const KEY_LOOKUP_PARAM = 'key_lookup'

const treeClause = (treeId: number | null): string => (treeId === null ? 'tree_id IN (SELECT tree_id FROM trees)' : 'tree_id = ?')
const treeParams = (treeId: number | null): unknown[] => (treeId === null ? [] : [treeId])

/** How a reply names a checkpoint: by its number, or as unnumbered. */
export function checkpointName(number: number | null): string {
  return number === null ? 'an unnumbered checkpoint' : `checkpoint number ${number}`
}
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ── Legs ───────────────────────────────────────────────────────────

/**
 * Whether a leg counts as keyless in the run's facts (D320, D326, D341):
 * a worker whose ticket declared in words that it has no key; or a leg
 * whose key never became its own or declared (inferred from a brief,
 * ambiguous between briefs, or none) and that has ended, so it wrote under
 * no key. A live leg whose key is inferred is not yet either: its first
 * write under a key may still settle it.
 */
export function isKeylessLeg(leg: Pick<LegRegistration, 'key' | 'keySrc' | 'ended' | 'stoppedAt'>): boolean {
  if (leg.keySrc === 'declared') return leg.key === null
  if (leg.keySrc === 'own') return false
  return !isLiveLeg(leg)
}

/** A leg of the run as the lookup shows it: live or how it ended (D289),
 *  keyless or not (D320), and for a live leg its last write (D312). */
export interface LegState {
  sessionId: string
  agentId: string
  role: string | null
  kind: LegRegistration['kind']
  key: string | null
  keySrc: LegRegistration['keySrc']
  state: 'live' | 'retired' | 'cut' | 'phantom' | 'invalid'
  /** D320, D326, D341: see isKeylessLeg. */
  keyless: boolean
  /** D279, D291, D316: how many checkpoints the leg wrote in its lane
   *  under the run's key it is registered for; null for a leg with no key
   *  of its own or declared. An ended leg with none ended without a
   *  checkpoint, visibly so; the store says the count, never a verdict. */
  checkpointsWritten: number | null
  startedAt: number
  /** D312: the moment of the newest row in the leg's lane, by the row's
   *  own moment, never the drain's; read for a live leg, null otherwise
   *  and for a live leg that has written nothing. */
  lastWriteAt: number | null
  stoppedAt: number | null
  noticedAt: number | null
  noticedBy: string | null
  openedRuns: string[]
  registration: LegRegistration
}

export function legStateOf(leg: LegRegistration, lastWriteAt: number | null = null, checkpointsWritten: number | null = null): LegState {
  const state: LegState['state'] = isLiveLeg(leg) ? 'live' : (leg.ended ?? 'retired')
  return {
    sessionId: leg.sessionId, agentId: leg.agentId, role: leg.role, kind: leg.kind, key: leg.key, keySrc: leg.keySrc,
    state, keyless: isKeylessLeg(leg), checkpointsWritten, startedAt: leg.startedAt, lastWriteAt, stoppedAt: leg.stoppedAt,
    noticedAt: leg.noticedAt, noticedBy: leg.noticedBy, openedRuns: leg.openedRuns, registration: leg,
  }
}

/** The SQL that picks a leg's lane (D289's recipe): a worker's lane is its
 *  whole session; a subagent's is its session and its own agent id. */
function laneWhere(leg: Pick<LegRegistration, 'kind' | 'agentId'>): string {
  return leg.kind === 'worker' || leg.agentId === WORKER_AGENT_ID
    ? 'session_key = ?'
    : "session_key = ? AND json_extract(metadata_json, '$._writer_agent_id') = ?"
}
function laneParams(leg: Pick<LegRegistration, 'kind' | 'agentId' | 'sessionId'>): unknown[] {
  return leg.kind === 'worker' || leg.agentId === WORKER_AGENT_ID ? [leg.sessionId] : [leg.sessionId, leg.agentId]
}

/** The checkpoints a leg wrote in its own lane under a run's key (D279,
 *  D291): none means it ended, or is live, without one. */
export function checkpointsWrittenBy(
  db: RunReadHandle, treeId: number | null, leg: Pick<LegRegistration, 'kind' | 'agentId' | 'sessionId'>, run: string, key: string,
): CheckpointRecord[] {
  const worker = leg.kind === 'worker' || leg.agentId === WORKER_AGENT_ID
  return checkpointsUnder(db, treeId, run, key)
    .filter((c) => !c.imported && c.sessionKey === leg.sessionId && (worker || c.writerAgentId === leg.agentId))
}

/** D312: the moment of the newest row in a leg's lane, or null. */
export function lastWriteOf(db: RunReadHandle, treeId: number | null, leg: Pick<LegRegistration, 'kind' | 'agentId' | 'sessionId'>): number | null {
  const r = db.prepare(`SELECT MAX(created_at) AS t FROM nodes WHERE ${treeClause(treeId)} AND ${laneWhere(leg)}`)
    .get(...treeParams(treeId), ...laneParams(leg)) as { t: number | null } | undefined
  return r?.t ?? null
}

// ── The checkpointer named (D281, D296) ────────────────────────────

/** Who the run named as the checkpointer of the key, and where. */
export interface NamedCheckpointer {
  names: string[]
  /** `brief`: the briefs of the run's key; `ticket`: the run's workers'
   *  tickets under the key, read when no brief names one; null: nobody
   *  named one, so no writer is flagged against a name. */
  by: 'brief' | 'ticket' | null
}

/**
 * The checkpointer the run named for its key (D281, D296): who will
 * checkpoint it at the end and who checkpointed the work it resumes, both
 * of a brief's tenses (`checkpointer`, `checkpointed_by`), from every brief
 * of the run's key that no newer brief for its role supersedes, whatever
 * its role; when no brief of the key names either, the same two facts the
 * tickets of the run's workers under the key declared (D281: the harness
 * puts them in each ticket). Briefs first because a brief is the run's
 * word for the key and a ticket is minted from it; a ticket a worker
 * minted for itself (D293) names only what its minter wanted. A writer
 * either tense names is not flagged: D296 flags only a writer other than
 * the one named.
 */
export function namedCheckpointerOf(db: RunReadHandle, treeId: number | null, run: string, key: string, legs: LegRegistration[]): NamedCheckpointer {
  const uniq = (xs: Array<string | null>): string[] => [...new Set(xs.filter((c): c is string => c !== null && c.trim() !== ''))]
  const fromBriefs = uniq(briefsOfKey(db, treeId, run, key).flatMap((b) => [b.checkpointer, b.checkpointedBy]))
  if (fromBriefs.length > 0) return { names: fromBriefs, by: 'brief' }
  const fromTickets = uniq(legs.filter((l) => l.kind === 'worker' && l.key === key).flatMap((l) => [l.checkpointer, l.checkpointedBy]))
  if (fromTickets.length > 0) return { names: fromTickets, by: 'ticket' }
  return { names: [], by: null }
}

/** Whether a writer is one of the named checkpointers: a role as named,
 *  or as the store spells a role's writer (agentWriterOf). */
export function isNamedCheckpointer(writer: string, named: NamedCheckpointer): boolean {
  return named.names.some((n) => writer === n || writer === agentWriterOf(n, null))
}

/**
 * D296: the sentence the reply carries beside a checkpoint whose writer is
 * not the checkpointer the brief or ticket named. A fact about the writer,
 * never a verdict: the checkpoint is returned in effect all the same.
 */
export function checkpointerFlag(cp: Pick<CheckpointRecord, 'number' | 'writer'>, named: NamedCheckpointer): string {
  const names = named.names.map((n) => `"${n}"`).join(' or ')
  return `The writer of ${checkpointName(cp.number)}, "${cp.writer}", is not the checkpointer the ${named.by ?? 'brief'} names (${names}).`
}

/**
 * D343: the sentence beside a checkpoint that arrived by import. Its claim
 * that it supersedes a checkpoint of the key is the file's claim, believed
 * by this lookup (runs.ts checkpointsInEffect) and said so, as D296 says a
 * stranger's writer; the local checkpoint it names is untouched.
 */
export function importFlag(cp: Pick<CheckpointRecord, 'number' | 'importedFrom' | 'claimedSupersedes' | 'metadata'>, under: readonly CheckpointRecord[] = []): string {
  const claims = cp.metadata[HANDOFF_CLAIMS_KEY]
  const claimedWriter = claims !== null && typeof claims === 'object' && !Array.isArray(claims)
    && typeof (claims as Record<string, unknown>)['_writer'] === 'string' ? (claims as Record<string, string>)['_writer'] : null
  const named = cp.claimedSupersedes.map((id) => {
    const local = under.find((c) => c.nodeId === id)
    return local ? checkpointName(local.number) : id
  })
  return `${capital(checkpointName(cp.number))} arrived by import${cp.importedFrom ? ` from "${cp.importedFrom}"` : ''}`
    + (claimedWriter ? `, written there by "${claimedWriter}"` : '')
    + (named.length > 0 ? `; the file claims it supersedes ${named.join(' and ')}, and this lookup believes the claim` : '')
    + '.'
}

// ── The leg's return (D336) ────────────────────────────────────────

/** The pointer to the return of the leg that wrote a checkpoint. */
export interface LegReturn {
  /** The leg that wrote it, by its registration; null when no registered
   *  leg did (the main agent, a declared writer, an import). */
  leg: { sessionId: string; agentId: string; role: string | null; state: LegState['state'] } | null
  /** Its summary row, the newest in its lane; null when it left none. */
  summary: { nodeId: string; writer: string; run: string | null; key: string | null; createdAt: number } | null
  /** One line: the pointer, or why there is none, never a guess. */
  line: string
}

const endedWords: Record<Exclude<LegState['state'], 'live'>, string> = {
  retired: 'retired', cut: 'cut', phantom: 'as a phantom', invalid: 'with no valid instructions',
}

/**
 * D336 (ratified D348): the leg that wrote a checkpoint is the
 * registration of the checkpoint's lane, its session and writer agent; its
 * return is the newest summary row in that lane (the SubagentStop summary
 * the drain stamped with the run and key, or the ticket door's at a
 * worker's exit). A leg that left none is said so, live or ended; a
 * checkpoint no registered leg wrote has no leg return, and is said so.
 */
export function legReturnOf(db: RunReadHandle & RegistryHandle, treeId: number | null, cp: CheckpointRecord): LegReturn {
  const name = checkpointName(cp.number)
  if (cp.imported) {
    return { leg: null, summary: null, line: `${capital(name)} arrived by import, so no leg registered in this store wrote it and there is no leg return to point to here.` }
  }
  const reg = cp.sessionKey !== null && cp.writerAgentId !== null && cp.writerAgentId !== ''
    ? legOf(db, { sessionId: cp.sessionKey, agentId: cp.writerAgentId }) : null
  if (!reg) {
    return { leg: null, summary: null, line: `${capital(name)} was written by "${cp.writer}", not by a registered leg, so there is no leg return to point to.` }
  }
  const state = legStateOf(reg).state
  const leg = { sessionId: reg.sessionId, agentId: reg.agentId, role: reg.role, state }
  const role = reg.role ?? reg.agentId
  const row = db.prepare(
    `SELECT node_id, created_at, metadata_json FROM nodes
      WHERE ${treeClause(treeId)} AND ${laneWhere(reg)} AND json_extract(metadata_json, '$.kind') = '${SUBAGENT_SUMMARY_KIND}'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...treeParams(treeId), ...laneParams(reg)) as { node_id: string; created_at: number; metadata_json: string | null } | undefined
  if (!row) {
    const line = state === 'live'
      ? `The ${role} leg that wrote ${name} left no return yet: it is live.`
      : `The ${role} leg that wrote ${name} left no return: it ended ${endedWords[state]}, with no summary row.`
    return { leg, summary: null, line }
  }
  const meta = parseMeta(row.metadata_json) ?? {}
  const run = typeof meta[RUN_META_KEY] === 'string' ? meta[RUN_META_KEY] : null
  const key = typeof meta[KEY_META_KEY] === 'string' ? meta[KEY_META_KEY] : null
  const writer = writerOf(meta)
  return {
    leg,
    summary: { nodeId: row.node_id, writer, run, key, createdAt: row.created_at },
    line: `Return of the ${role} leg that wrote ${name}: the summary row ${row.node_id} (writer "${writer}"`
      + `${run !== null ? `, run "${run}"` : ''}${key !== null ? `, key "${key}"` : ''}).`,
  }
}

// ── The run's facts (D301, D312, D320, D344) ───────────────────────

export interface RunFacts {
  /** D301: how many legs have run on the run, live or ended. A leg that
   *  opened a run of its own counts once here (D311). */
  legsRun: number
  /** D320, D326, D341: how many of them are keyless (isKeylessLeg). */
  keylessLegs: number
  /** D301: how many checkpoints sit under the key, imported ones too. */
  checkpointsUnderKey: number
  /** D301: when the run started: its open row's moment, else its first
   *  leg's start; null for a run the store holds nothing of. */
  runStartedAt: number | null
  /** D301: how long ago that was, in seconds, as of `asOf`. */
  runAgeSeconds: number | null
  /** D344: the sizes in characters of the last LAST_SIZES_SHOWN
   *  checkpoints under the key, by number, newest last. */
  lastSizes: number[]
  /** The moment the lookup read the store. */
  asOf: number
}

/** A checkpoint as the lookup returns it. */
export interface LookupCheckpoint extends CheckpointRecord {
  /** D296, D343: the flag in words, or null when there is nothing to say. */
  flag: string | null
  /** D336: the pointer to the return of the leg that wrote it. */
  legReturn: LegReturn
}

export interface KeyLookup {
  run: string
  key: string
  /** The checkpoints in effect, in number order: none, one, or more. */
  checkpoints: LookupCheckpoint[]
  /** The line saying what is in effect. */
  line: string
  /** Every leg registered under the run, live or how it ended. */
  legs: LegState[]
  /** The run's facts beside the checkpoint. */
  facts: RunFacts
  /** Who the run named as the key's checkpointer, and where. */
  namedCheckpointer: NamedCheckpointer
  /** The phantom pass this lookup ran (D297): who it retired, and one
   *  sentence per worker it could not check. */
  phantoms: PhantomPass
  notes: string[]
}

/**
 * The harness's lookup by run and key together (D289), with no model in
 * the loop: see the module comment. `phantomPass: false` reads without
 * writing the registry (a read-only server), and the notes say so.
 */
export function lookupKey(db: RunReadHandle & RegistryHandle, treeId: number | null, opts: {
  run: string
  key: string
  probe?: ProcessProbe
  noticedBy?: string
  at?: number
  phantomPass?: boolean
}): KeyLookup {
  const at = opts.at ?? Date.now() / 1000
  let phantoms: PhantomPass
  if (opts.phantomPass === false) {
    phantoms = { retired: [], unchecked: [], notes: ['This reader does not write the registry, so no gone worker was retired; a worker shown live may be gone.'] }
  } else {
    try {
      phantoms = retirePhantoms(db, {
        noticedBy: opts.noticedBy ?? NOTICED_BY_LOOKUP,
        run: opts.run,
        ...(opts.probe ? { probe: opts.probe } : {}),
        at,
      })
    } catch (err) {
      // A reader that cannot write (a read-only handle) still reads; it
      // says it retired nothing, never that nothing was gone.
      phantoms = { retired: [], unchecked: [], notes: [`The registry could not be written from this handle, so no gone worker was retired: ${err instanceof Error ? err.message : String(err)}`] }
    }
  }
  const registrations = legsOfRun(db, opts.run)
  const legs = registrations.map((leg) => legStateOf(leg, isLiveLeg(leg) ? lastWriteOf(db, treeId, leg) : null,
    leg.run !== null && leg.key !== null && (leg.keySrc === 'own' || leg.keySrc === 'declared')
      ? checkpointsWrittenBy(db, treeId, leg, leg.run, leg.key).length : null))
  const all = checkpointsUnder(db, treeId, opts.run, opts.key)
  const named = namedCheckpointerOf(db, treeId, opts.run, opts.key, registrations)
  const checkpoints: LookupCheckpoint[] = inEffectAmong(all).map((cp) => ({
    ...cp,
    flag: cp.imported ? importFlag(cp, all) : (named.by !== null && !isNamedCheckpointer(cp.writer, named) ? checkpointerFlag(cp, named) : null),
    legReturn: legReturnOf(db, treeId, cp),
  }))
  const open = runOpenOf(db, treeId, opts.run)
  const runStartedAt = open?.createdAt ?? (registrations.length > 0 ? Math.min(...registrations.map((l) => l.startedAt)) : null)
  const facts: RunFacts = {
    legsRun: legs.length,
    keylessLegs: legs.filter((l) => l.keyless).length,
    checkpointsUnderKey: all.length,
    runStartedAt,
    runAgeSeconds: runStartedAt === null ? null : Math.max(0, at - runStartedAt),
    lastSizes: all.slice(-LAST_SIZES_SHOWN).map((c) => c.size),
    asOf: at,
  }
  return {
    run: opts.run,
    key: opts.key,
    checkpoints,
    line: inEffectLine(opts.run, opts.key, checkpoints),
    legs,
    facts,
    namedCheckpointer: named,
    phantoms,
    notes: [...phantoms.notes],
  }
}

// ── The reply both doors hand over (D337) ──────────────────────────

/** The key lookup's reply, plain JSON: what the harness receives through
 *  the library (keyLookupReply over lookupKey) and the agent through the
 *  query tool's key_lookup mode, the same object (D337, ratified D349). */
export interface KeyLookupReply {
  run: string
  key: string
  /** D280, D289, D329: none, one, or how many are in effect. */
  line: string
  /** D289: each checkpoint in effect with its writer and moment. */
  checkpoints: Array<{
    node_id: string
    number: number | null
    writer: string
    writer_src: string | null
    moment: number
    size: number
    content: string
    supersedes: string[]
    supersedes_src: string | null
    rests_on: string[]
    /** D343: arrived by import, and from which file. */
    imported: boolean
    imported_from: string | null
    claimed_supersedes: string[]
    /** D296, D343: the flag in words, or null. */
    flag: string | null
    /** D336: the leg's return, or the line saying there is none. */
    return: {
      line: string
      summary_node_id: string | null
      leg: { session_id: string; agent_id: string; role: string | null; state: LegState['state'] } | null
    }
  }>
  /** D301, D320, D344: the run's facts. */
  facts: {
    legs_run: number
    keyless_legs: number
    checkpoints_under_key: number
    run_started_at: number | null
    run_age_seconds: number | null
    last_sizes: number[]
    as_of: number
  }
  /** D289, D312: each leg of the run, live or how it ended; a live leg
   *  with its start and its last write. */
  legs: Array<{
    session_id: string
    agent_id: string
    role: string | null
    kind: string | null
    key: string | null
    key_src: string | null
    state: LegState['state']
    keyless: boolean
    /** D279, D291, D316: see LegState.checkpointsWritten. */
    checkpoints_written: number | null
    started_at: number
    last_write_at: number | null
    stopped_at: number | null
    noticed_at: number | null
    noticed_by: string | null
    opened_runs: string[]
  }>
  /** D296: who the run named as the key's checkpointer, and where. */
  named_checkpointer: { names: string[]; by: NamedCheckpointer['by'] }
  /** D297: the phantom pass's sentences. */
  notes: string[]
}

export function keyLookupReply(l: KeyLookup): KeyLookupReply {
  return {
    run: l.run,
    key: l.key,
    line: l.line,
    checkpoints: l.checkpoints.map((c) => ({
      node_id: c.nodeId, number: c.number, writer: c.writer, writer_src: c.writerSrc, moment: c.createdAt, size: c.size,
      content: c.content, supersedes: c.supersedes, supersedes_src: c.supersedesSrc, rests_on: c.restsOn,
      imported: c.imported, imported_from: c.importedFrom, claimed_supersedes: c.claimedSupersedes,
      flag: c.flag,
      return: {
        line: c.legReturn.line,
        summary_node_id: c.legReturn.summary?.nodeId ?? null,
        leg: c.legReturn.leg
          ? { session_id: c.legReturn.leg.sessionId, agent_id: c.legReturn.leg.agentId, role: c.legReturn.leg.role, state: c.legReturn.leg.state }
          : null,
      },
    })),
    facts: {
      legs_run: l.facts.legsRun,
      keyless_legs: l.facts.keylessLegs,
      checkpoints_under_key: l.facts.checkpointsUnderKey,
      run_started_at: l.facts.runStartedAt,
      run_age_seconds: l.facts.runAgeSeconds,
      last_sizes: l.facts.lastSizes,
      as_of: l.facts.asOf,
    },
    legs: l.legs.map((g) => ({
      session_id: g.sessionId, agent_id: g.agentId, role: g.role, kind: g.kind, key: g.key, key_src: g.keySrc,
      state: g.state, keyless: g.keyless, checkpoints_written: g.checkpointsWritten, started_at: g.startedAt, last_write_at: g.lastWriteAt,
      stopped_at: g.stoppedAt, noticed_at: g.noticedAt, noticed_by: g.noticedBy, opened_runs: g.openedRuns,
    })),
    named_checkpointer: { names: l.namedCheckpointer.names, by: l.namedCheckpointer.by },
    notes: l.notes,
  }
}
