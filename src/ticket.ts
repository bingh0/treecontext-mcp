/**
 * The ticket: what a headless worker's spawner declares about it, carried
 * in the worker's environment (features/journal-workers.feature; rulings
 * D281, D288, D294, D303, D340, D341, D342).
 *
 * A ticket is declared, never discovered (D288): whatever spawns a worker,
 * a harness, a main CLI of any of the three or the worker itself (D293, a
 * self-minted ticket is read like any other), puts it in the process's
 * environment, and every door that reads it reads it with readTicket: the
 * ticket door here (the library's spawnWorker and the `treecontext run`
 * wrapper), and the hooks door of a `claude -p` child (unit 4 of the
 * build). The store checks nothing it says.
 *
 * The encoding is one JSON object in one variable, TICKET_ENV, minted by
 * mintTicket in a fixed field order (run, key, role first, so a ticket cut
 * short keeps what a reader most needs). A ticket the door cannot read
 * whole, truncated, hand-edited or minted in another shape, is read for
 * every field it still yields, each unreadable field named absent, the raw
 * text kept (D303, D342): the door registers the worker with that and
 * tells it its instructions were invalid, never guessing at the rest.
 */
import type { WorkerTicket, DeclaredParent, LegRegistration } from './persistence/leg-registry.js'
import { legOf, WORKER_AGENT_ID } from './persistence/leg-registry.js'
import type { RegistryHandle } from './persistence/session-registry.js'

// ── Names ──────────────────────────────────────────────────────────

/** D288: the environment variable a worker's ticket travels in, one JSON
 *  object (mintTicket). Declared by whatever spawned the worker; the door
 *  passes it to the worker unchanged, so the worker and any door inside
 *  it (a hook, the server) read what its spawner wrote. */
export const TICKET_ENV = 'TREECONTEXT_TICKET'

/** D288, D335: the environment variable naming the lane the ticket door
 *  registered the worker in, its own session. The door's fact, not the
 *  spawner's declaration, so it is not part of the ticket: a server started
 *  inside the worker stamps the worker's rows into that lane, under the
 *  role its ticket declared, and the re-run of D335 gets the same one. */
export const WORKER_SESSION_ENV = 'TREECONTEXT_WORKER_SESSION'

/** The ticket shape this build mints and reads. A ticket that names
 *  another shape (`v`) was minted by another treecontext: damage (D303). */
export const TICKET_VERSION = 1

/** The fields a ticket must carry to be read whole (D288, D341): its run,
 *  its role, its parent's id, and its key or the words that it has none. */
export const REQUIRED_TICKET_FIELDS = ['run', 'key', 'role', 'parent'] as const

/** Every field this shape knows, in the order mintTicket writes them. */
export const TICKET_FIELDS = ['v', 'run', 'key', 'no_key', 'role', 'checkpointer', 'checkpointed_by', 'can_write', 'parent', 'minted_at'] as const

// ── Minting ────────────────────────────────────────────────────────

/** What a spawner declares, in the library's spelling. */
export interface TicketFields {
  run: string
  /** The key; omit with `noKey` for a one-off worker (D341). */
  key?: string | null
  /** D341: says in words that the worker has no key. */
  noKey?: boolean
  role: string
  /** D281: who will checkpoint the key at the end. */
  checkpointer?: string | null
  /** D281: who checkpointed the work this worker resumes. */
  checkpointedBy?: string | null
  /** D316, D340: whether the worker has a way to write to the store;
   *  left out, it is read as having one. */
  canWrite?: boolean | null
  /** D294: the parent, its id and whatever else the spawner declares. */
  parent: DeclaredParent
  /** The mint moment, unix seconds; now when left out. */
  mintedAt?: number
}

/** The ticket's text, as it sits in the environment. */
export function mintTicket(f: TicketFields): string {
  const o: Record<string, unknown> = { v: TICKET_VERSION, run: f.run }
  if (f.noKey) o['no_key'] = true
  else o['key'] = f.key ?? null
  o['role'] = f.role
  if (f.checkpointer !== undefined && f.checkpointer !== null) o['checkpointer'] = f.checkpointer
  if (f.checkpointedBy !== undefined && f.checkpointedBy !== null) o['checkpointed_by'] = f.checkpointedBy
  if (f.canWrite !== undefined && f.canWrite !== null) o['can_write'] = f.canWrite
  const p: Record<string, unknown> = { id: f.parent.id }
  for (const k of ['cli', 'cwd', 'worktree', 'branch'] as const) if (f.parent[k] !== undefined) p[k] = f.parent[k]
  o['parent'] = p
  o['minted_at'] = f.mintedAt ?? Date.now() / 1000
  return JSON.stringify(o)
}

// ── Reading ────────────────────────────────────────────────────────

/** What a door read of a ticket. */
export interface TicketReading {
  /** Read whole: every required field, nothing malformed, this shape. */
  valid: boolean
  /** The ticket as the registry takes it: every field read, and when it
   *  was not read whole, the raw text and the absent fields (D303). */
  ticket: WorkerTicket
  /** The fields the door could not read; empty when valid. */
  absent: string[]
  /** D341: the ticket said in words the worker has no key. */
  noKey: boolean
  /** The text as it sat in the environment. */
  raw: string
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** A JSON string, number, boolean or null literal at the start of `s`. */
const LITERAL = String.raw`("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)`

/** The `"name": literal` pairs a text that is not whole JSON still yields,
 *  outside and inside its parent object (truncated, a stray comma). */
function salvage(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const pairs = (text: string): Record<string, unknown> => {
    const got: Record<string, unknown> = {}
    const re = new RegExp(String.raw`"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*` + LITERAL, 'g')
    for (const m of text.matchAll(re)) {
      try { if (!(m[1]! in got)) got[m[1]!] = JSON.parse(m[2]!) } catch { /* not a literal after all */ }
    }
    return got
  }
  const parentAt = /"parent"\s*:\s*\{/.exec(raw)
  let outside = raw
  if (parentAt) {
    const open = parentAt.index + parentAt[0].length
    const close = raw.indexOf('}', open)
    const inner = raw.slice(open, close === -1 ? raw.length : close)
    out['parent'] = pairs(inner)
    outside = raw.slice(0, parentAt.index) + (close === -1 ? '' : raw.slice(close + 1))
  }
  for (const [k, v] of Object.entries(pairs(outside))) if (k !== 'parent') out[k] = v
  return out
}

/**
 * Read a ticket's text as every door reads it (D303, D340, D341, D342).
 * Whole: one JSON object of this shape with its run, role and parent id,
 * and its key or `no_key: true` (the words that the worker has none). A
 * blank key with no such words is damage (D341), as is a field of the
 * wrong type or another shape's `v`. Silence about `can_write` is read as
 * declaring a way to write (D340). A text that is not whole yields every
 * field still readable; for a text that does not parse at all every field
 * not recovered is named absent, since the door cannot tell what the cut
 * took.
 */
export function readTicket(raw: string): TicketReading {
  let o: Record<string, unknown> | null = null
  let parsed = false
  try {
    const v = JSON.parse(raw) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) { o = v as Record<string, unknown>; parsed = true }
  } catch { /* salvaged below */ }
  if (o === null) o = salvage(raw)
  const absent = new Set<string>()
  const textOf = (k: string): string | null => {
    const v = o![k]
    if (v === undefined || v === null) return null
    if (isText(v)) return v
    absent.add(k)
    return null
  }
  const version = o['v']
  if (version !== undefined && version !== TICKET_VERSION) absent.add('v')
  const run = textOf('run')
  if (run === null) absent.add('run')
  const role = textOf('role')
  if (role === null) absent.add('role')
  const noKeyRaw = o['no_key']
  if (noKeyRaw !== undefined && noKeyRaw !== null && typeof noKeyRaw !== 'boolean') absent.add('no_key')
  const noKey = noKeyRaw === true
  const keyRaw = o['key']
  let key: string | null = null
  if (isText(keyRaw)) key = keyRaw
  // D341: a one-off is declared in words, never inferred from an empty
  // field; a key both given and said not to exist is not read whole.
  if (noKey ? key !== null : key === null) absent.add('key')
  if (noKey && key !== null) key = null
  const checkpointer = textOf('checkpointer')
  const checkpointedBy = textOf('checkpointed_by')
  const canWriteRaw = o['can_write']
  let canWrite: boolean | null = null
  if (typeof canWriteRaw === 'boolean') canWrite = canWriteRaw
  else if (canWriteRaw !== undefined && canWriteRaw !== null) absent.add('can_write')
  const mintedRaw = o['minted_at']
  let mintedAt: number | null = null
  if (typeof mintedRaw === 'number' && Number.isFinite(mintedRaw)) mintedAt = mintedRaw
  else if (typeof mintedRaw === 'string' && Number.isFinite(Date.parse(mintedRaw))) mintedAt = Date.parse(mintedRaw) / 1000
  else if (mintedRaw !== undefined && mintedRaw !== null) absent.add('minted_at')
  const parentRaw = o['parent']
  const parent: DeclaredParent = { id: '' }
  if (parentRaw !== null && typeof parentRaw === 'object' && !Array.isArray(parentRaw)) {
    const p = parentRaw as Record<string, unknown>
    if (isText(p['id'])) parent.id = p['id']
    for (const k of ['cli', 'cwd', 'worktree', 'branch'] as const) {
      const v = p[k]
      if (typeof v === 'string') parent[k] = v
      else if (v === null) parent[k] = null
    }
  }
  if (parent.id === '') absent.add('parent')
  // A text that is not whole JSON: what the cut took cannot be told, so
  // every field of the shape not recovered is unreadable.
  if (!parsed) for (const f of TICKET_FIELDS) if (o[f] === undefined && !(f === 'key' && noKey) && !(f === 'no_key' && key !== null)) absent.add(f)
  const absentList = TICKET_FIELDS.filter((f) => absent.has(f))
  const valid = absentList.length === 0
  const ticket: WorkerTicket = {
    parent, run, key, role,
    ...(noKey ? { noKey: true } : {}),
    checkpointer, checkpointedBy, mintedAt, canWrite,
    ...(valid ? {} : { raw, absent: absentList }),
  }
  return { valid, ticket, absent: absentList, noKey, raw }
}

/** The ticket text in an environment, or null when it carries none. */
export function ticketTextIn(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env[TICKET_ENV]
  return t === undefined ? null : t
}

/** The worker's lane the ticket door named in an environment, or null. */
export function workerSessionIn(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env[WORKER_SESSION_ENV]
  return s !== undefined && s.trim() !== '' ? s : null
}

/** D340: a ticket that says nothing about the door declares one. */
export function declaresDoor(t: Pick<WorkerTicket, 'canWrite'>): boolean {
  return t.canWrite !== false
}

/**
 * Whether a worker registration is the one this ticket describes: the raw
 * text it kept when the door could not read it whole, or else the run,
 * key, role and parent id the door registered it under.
 */
export function ticketMatches(leg: Pick<LegRegistration, 'ticketRaw' | 'run' | 'key' | 'role' | 'parentSession'>, reading: TicketReading): boolean {
  if (leg.ticketRaw !== null) return leg.ticketRaw === reading.raw
  if (!reading.valid) return false
  const t = reading.ticket
  return leg.run === t.run && leg.key === t.key && leg.role === t.role && (leg.parentSession ?? '') === t.parent.id
}

/**
 * The worker lane an environment may be honoured as (D288, D293): the one
 * WORKER_SESSION_ENV names, only when a worker registration exists there
 * and the ticket in the same environment is the one it was registered
 * with. A process that inherited the variable with a ticket of its own (a
 * nested worker, a self-minted ticket) is not the registered worker and
 * never writes as it; a lane nobody registered names no one. Null: read
 * the ticket as any other, or fall back to the ordinary identity ladder.
 */
export function trustedWorkerLane(db: RegistryHandle, env: NodeJS.ProcessEnv = process.env): string | null {
  const lane = workerSessionIn(env)
  const raw = ticketTextIn(env)
  if (lane === null || raw === null) return null
  let leg: LegRegistration | null
  try { leg = legOf(db, { sessionId: lane, agentId: WORKER_AGENT_ID }) } catch { return null }
  if (!leg || leg.kind !== 'worker') return null
  return ticketMatches(leg, readTicket(raw)) ? lane : null
}

/** A worker's claim on a store that holds no registration for it (D424). */
export interface TicketClaim {
  /** The session the door named (WORKER_SESSION_ENV): the same id the
   *  door's own store registered the worker under. */
  session: string
  /** The role the ticket names; `worker` where it names none. */
  role: string
  /** The parent the ticket declares, when it names one. */
  parent: string | null
}

/**
 * What a server holding a worker's ticket and the lane its door named may
 * stamp when this store holds no registration at all for that lane (D424):
 * the door registered the worker in another store (`treecontext run
 * --store`, or a project bound elsewhere) and the worker's server resolved
 * this one from its directory. The process is a worker, never the session
 * of whichever client last ran here, so its rows take the ticket's own
 * words, marked as a claim. Null where the lane is trusted
 * (trustedWorkerLane decides first), where either variable is missing, or
 * where the registry holds any registration under that session: a lane
 * registered with another ticket (a nested worker's inherited variable)
 * is never claimed (D288), and falls to the ordinary identity ladder.
 */
export function ticketClaimOf(db: RegistryHandle, env: NodeJS.ProcessEnv = process.env): TicketClaim | null {
  const session = workerSessionIn(env)
  const raw = ticketTextIn(env)
  if (session === null || raw === null) return null
  try {
    const held = db.prepare('SELECT 1 AS one FROM session_registry WHERE session_id = ? LIMIT 1').get(session)
    if (held) return null
  } catch { /* a store with no registry holds no registration */ }
  const t = readTicket(raw).ticket
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return { session, role: text(t.role) ?? WORKER_AGENT_ID, parent: text(t.parent?.id) }
}
