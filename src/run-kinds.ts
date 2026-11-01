/**
 * The rows a run is made of, by kind (D289, D302, D309, D327, D329). A leaf
 * module: the dedup identity (dedup-identity.ts) classifies these rows and
 * may import nothing that imports it back.
 *
 * Every row a run is made of is a journal row carrying the run, and the
 * key where it has one, in its metadata (D309): its open and its close,
 * each brief, each checkpoint, each leg's first moment and each leg's
 * summary row. Nothing about a run lives only in the registry's table.
 */

/** A checkpoint: the state of a key's work as it now stands (D280, D299),
 *  numbered by the store when it lands (D329). */
export const CHECKPOINT_KIND = 'checkpoint'

/** A brief: what a role is told for a key on a run (D281, D327). */
export const BRIEF_KIND = 'brief'

/** A run's open (D302): at its first leg's registration, or explicit. */
export const RUN_OPEN_KIND = 'run-open'

/** A run's close (D302): declared by the harness or the main agent, with
 *  a reason. */
export const RUN_CLOSE_KIND = 'run-close'

/** A leg's first moment (D298, D313, D329): the spawner's prompt with
 *  references to the brief and checkpoint rows it was composed from. Its
 *  composition and its writer are the doors' (the ticket door, the hooks
 *  door); defined here so the run's reads and the dedup identity know it. */
export const FIRST_MOMENT_KIND = 'first-moment'

/** A leg's summary row, its return (D284, D288, D336): the SubagentStop
 *  report the drain stamps, or the worker's last output the ticket door
 *  writes at its exit. Defined here, the leaf, so the dedup identity can
 *  name it; handoff.ts re-exports it under the same name. */
export const SUBAGENT_SUMMARY_KIND = 'subagent-summary'

/** D335: the row holding a worker's second run's first message, naming
 *  the missing checkpoint, between the first run's rows and the second's.
 *  The door's capture in the worker's lane, like the first moment. */
export const SEND_BACK_KIND = 'send-back'

/** D303, D342: the row a spawner's door writes in the spawner's lane when
 *  it sees before spawning that a ticket cannot be read whole, keeping the
 *  raw ticket text; no worker is started. */
export const TICKET_REFUSED_KIND = 'ticket-refused'

/** D300, D310: a leg's registration as a row of a run's export, so the
 *  registration facts (role, run, key, parent, door, how it ended) cross
 *  stores as data. It exists only in an export file and, once imported,
 *  in a handoff lane; the exporting store's registry is a table and never
 *  grows one. See run-export.ts. */
export const LEG_REGISTRATION_KIND = 'leg-registration'

/** The metadata key a registration row carries its facts under. A claim
 *  on import like any other (D165): it lands under `_handoff_claims`. */
export const LEG_REGISTRATION_KEY = '_leg_registration'

/** The key the importer stamps on an imported registration row whose facts
 *  differ from this store's registration of the same leg: the list of the
 *  facts that differ (D360). The importer's word, not the file's. */
export const REGISTRATION_DIFFERS_KEY = 'registration_differs'

/** The metadata keys a run's rows carry (D284, D289). */
export const RUN_META_KEY = 'run'
export const KEY_META_KEY = 'key'

/** The kinds whose identity is their place in the run, never their
 *  content: two checkpoints that read alike are two checkpoints (D329),
 *  so these rows never deduplicate by text. A leg's summary row naming
 *  its run is one of them (D288, D336): two workers that print the same
 *  last line leave two returns, each in its own lane, never one row in
 *  the first lane. (A first moment is the leg's capture, deduplicated
 *  within its own session only, so it needs no class of its own.) */
export const RUN_ROW_KINDS: readonly string[] = [CHECKPOINT_KIND, BRIEF_KIND, RUN_OPEN_KIND, RUN_CLOSE_KIND, SUBAGENT_SUMMARY_KIND]

const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * The run-row kind a row's metadata makes it, or null. A row is a run's
 * only when it names its run: a checkpoint and a brief also name their key
 * (a brief its role, `brief_for`). A note that merely says `kind:
 * "checkpoint"` with no run and key is a note, as it always was.
 */
export function runRowKindOf(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null
  const kind = meta['kind']
  if (typeof kind !== 'string' || !RUN_ROW_KINDS.includes(kind)) return null
  if (!named(meta[RUN_META_KEY])) return null
  if ((kind === CHECKPOINT_KIND || kind === BRIEF_KIND) && !named(meta[KEY_META_KEY])) return null
  if (kind === BRIEF_KIND && !named(meta['brief_for'])) return null
  return kind
}

/** The dedup class of a run's rows (dedup-identity.ts dedupClassOf):
 *  outside both content classes, by identity alone. */
export const RUN_DEDUP_CLASS = 'run'

/** Rows identified by their moment, never their text, whether or not they
 *  name a run: a ticket refused twice is two faults, two rows (D303). */
export const IDENTITY_ROW_KINDS: readonly string[] = [TICKET_REFUSED_KIND]

/** Whether a row is identified by its place or moment rather than its
 *  text: a run's row, or one of IDENTITY_ROW_KINDS. */
export function isIdentityRow(meta: Record<string, unknown> | null | undefined): boolean {
  if (runRowKindOf(meta) !== null) return true
  const kind = meta?.['kind']
  return typeof kind === 'string' && IDENTITY_ROW_KINDS.includes(kind)
}
