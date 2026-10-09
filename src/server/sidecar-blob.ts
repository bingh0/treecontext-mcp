/**
 * The sidecar pane — treecontext's half of a schema-blind display.
 *
 * Charter: `features/journal-sidecar.feature`.
 * Consumer contract: ccr's `docs/PANE-CONTRACT.md` v1.
 *
 * treecontext writes a small JSON file beside its own store; a renderer
 * that has never heard of treecontext reads the bytes and draws them. The
 * renderer never calls us, never loads our code, and never asks us to
 * refresh — which is what lets both sides distrust each other safely. We
 * hold no opinion about how any of this is drawn.
 *
 * Three rules do most of the work here, and each is a lie the pane could
 * otherwise tell:
 *
 *   THE MOMENT IS THE DRAIN. Every number is taken at one moment and frozen
 *   into its string. Nothing on the pane recomputes itself against whoever
 *   reads it later, so a stale file reads as old data rather than drifting
 *   into fresh-looking nonsense. The reader supplies the age from the
 *   file's own mtime; we supply what the numbers stood on.
 *
 *   FAILURE CONFESSES, REFUSAL IS SILENT. A file cannot decline to be read
 *   the way a query surface can, so a producing step that FAILS must
 *   overwrite the pane with its failure — stale health left on screen is an
 *   all-clear nobody issued. A step that is REFUSED (this process does not
 *   own the drain) writes nothing at all: the holder's data still stands.
 *
 *   TEXT FROM THE JOURNAL IS INERT. Thread topics are agent-authored and
 *   entry text is whatever passed through a session, so both are stripped
 *   of control bytes here. The reader strips again and cannot trust us;
 *   stripping twice is the point, because neither side should be the only
 *   thing standing between a journal and a terminal.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { warn } from '../debug.js'
import type { JournalVitals } from '../core/types.js'

/** Pane-contract version this producer writes. */
export const PANE_VERSION = 1

/** Producer identity, shown in the reader's chrome beside every claim. */
export const PANE_TOOL = 'treecontext'

/** The moment the panes stand on, in the producer's own vocabulary. */
export const PANE_BASIS_LABEL = 'drain'

export const SIDECAR_JOURNAL_FILE = 'sidecar.json'
export const SIDECAR_THREADS_FILE = 'sidecar-threads.json'
export const SIDECAR_TRAIL_FILE = 'sidecar-trail.json'

/** Pane name → filename. One entry here is one file and one cycle view. */
export const SIDECAR_FILES = {
  journal: SIDECAR_JOURNAL_FILE,
  threads: SIDECAR_THREADS_FILE,
  trail: SIDECAR_TRAIL_FILE,
} as const

export type PaneName = keyof typeof SIDECAR_FILES

/** Display fields are truncated here as well as by the reader. */
const MAX_FIELD_CHARS = 200

export type PaneRowStatus = 'ok' | 'warn' | 'alert' | 'dark' | 'off'

export interface PaneRow {
  label: string
  /** Preformatted by us; the reader computes nothing. */
  value: string
  status: PaneRowStatus
  detail?: string
  spark?: number[]
}

export interface PaneBlob {
  v: number
  tool: string
  title: string
  status: 'ok' | 'broken'
  basis: { label: string; at: string }
  message: string | null
  rows: PaneRow[]
}

export type SidecarPanes = Record<PaneName, PaneBlob>

/**
 * Strip C0/C1 control bytes and DEL, collapse the result to one line, and
 * bound it. Applied to every display string that came from outside this
 * file — which is all of them except our own labels.
 */
export function inert(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > MAX_FIELD_CHARS ? clean.slice(0, MAX_FIELD_CHARS) : clean
}

/** Where the panes live: beside the store, never in the reader's own dirs. */
export function sidecarPaths(storePath: string): Record<PaneName, string> {
  const dir = dirname(storePath)
  return {
    journal: join(dir, SIDECAR_JOURNAL_FILE),
    threads: join(dir, SIDECAR_THREADS_FILE),
    trail: join(dir, SIDECAR_TRAIL_FILE),
  }
}

/**
 * The basis stamp: a display string the reader shows verbatim and never
 * parses. Minute resolution — the pane's own currency comes from the file's
 * write age, so a second here would be false precision.
 */
export function basisStamp(atSec: number): string {
  // Marked UTC, because it is read next to a wall clock. Unmarked, "18:53"
  // beside a clock saying 13:53 reads as a pane five hours behind — the
  // reader would distrust a panel that is telling the truth. The suffix
  // costs a character and removes the misreading.
  return `${new Date(atSec * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/**
 * An elapsed span, resolved AT THE BASIS and frozen into the string. This is
 * why "4h" on a pane is honest even when the file is a day old: it says how
 * far apart two moments in the journal were, not how long ago anything was
 * from now.
 */
function span(fromSec: number, toSec: number): string {
  const d = Math.max(0, Math.floor(toSec - fromSec))
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}

/**
 * Thresholds, in one place so they can be argued with rather than hunted
 * for. Each is the point where a human would want to look, not a point
 * where anything is broken — `alert` on this pane means "eyes here", and
 * over-claiming it is how a panel becomes wallpaper.
 */
const T = {
  /** A backlog this deep means the drain is not keeping up. */
  backlogWarn: 20,
  backlogAlert: 50,
  /** Entries recorded since the last curated note. The journal's own
   *  guidance is "write at natural breaks"; this is the only measure of
   *  whether that is happening. */
  curatedDriftWarn: 150,
  /** A thread nobody has closed out in a week is probably finished. */
  threadStaleSec: 7 * 86400,
}

/** The pane's drain-backlog warning line, exported so doctor's
 *  capture-debt check warns at exactly the depth the pane does — two
 *  surfaces grading one drain must not disagree (Phase-2 review S3). */
export const DRAIN_BACKLOG_WARN = T.backlogWarn

/**
 * The journal pane: is memory working right now?
 *
 * The row floor is the contract here — capture, drain, requeued, gaps,
 * curated, threads, journal all appear in every reading. A family that
 * disappeared when it had nothing to report would be indistinguishable
 * from one that was never measured, and "nothing to report" is exactly the
 * state this pane exists to make legible.
 */
function journalPane(v: JournalVitals, storeName: string): PaneBlob {
  const captured = v.capturePerMinute.reduce((a, b) => a + b, 0)
  const backlog = v.staging.unprocessed

  const rows: PaneRow[] = [
    {
      label: 'capture',
      value: captured > 0 ? `${count(captured, 'event')} / 10m` : 'nothing staged',
      // Silence is the ambiguous state, not a healthy one: an idle session
      // and a hook that stopped firing look identical from here, and only
      // one of them is fine. Say so rather than picking.
      status: captured > 0 ? 'ok' : 'warn',
      detail: captured > 0 ? 'hook → staging' : 'idle session, or the hook stopped firing',
      spark: v.capturePerMinute,
    },
    {
      label: 'drain',
      value: backlog === 0 ? 'clear' : `${count(backlog, 'event')} pending`,
      status: backlog > T.backlogAlert ? 'alert' : backlog > T.backlogWarn ? 'warn' : 'ok',
      detail:
        v.staging.oldestPendingAt != null
          ? `oldest waiting ${span(v.staging.oldestPendingAt, v.at)}`
          : `${count(v.staging.total, 'row')} staged, all drained`,
    },
    {
      label: 'requeued',
      value: v.staging.retried === 0 ? 'none' : v.staging.retried.toLocaleString('en-US'),
      status: v.staging.retried === 0 ? 'ok' : 'warn',
      detail: 'staged events that failed a drain and are being retried',
    },
    {
      label: 'gaps',
      value: v.captureGaps === 0 ? 'none' : count(v.captureGaps, 'hole'),
      status: v.captureGaps === 0 ? 'ok' : 'alert',
      detail: 'holes the journal admitted in itself',
    },
    {
      label: 'curated',
      value: count(v.curated.count, 'note'),
      status: v.curated.entriesSince > T.curatedDriftWarn ? 'warn' : 'ok',
      detail:
        v.curated.newestAt == null
          ? 'nothing written by hand yet'
          : `newest ${span(v.curated.newestAt, v.at)} before this drain, ` +
            `${count(v.curated.entriesSince, 'entry', 'entries')} since`,
    },
    {
      label: 'threads',
      value: v.threads.openTotal === 0 ? 'none open' : `${v.threads.openTotal} open`,
      // No open thread is not a failure — it is how a finished session
      // looks. It is worth a glance only because it is also how a session
      // that forgot to close out looks.
      status: v.threads.openTotal === 0 ? 'warn' : 'ok',
      detail: `${count(v.threads.superseded, 'thread')} closed out`,
    },
    {
      label: 'journal',
      value: count(v.totalNodes, 'entry', 'entries'),
      status: 'ok',
      detail: `${bytes(v.storeBytes)} stored`,
    },
  ]

  return {
    v: PANE_VERSION,
    tool: PANE_TOOL,
    title: `journal · ${inert(storeName)}`,
    status: 'ok',
    basis: { label: PANE_BASIS_LABEL, at: basisStamp(v.at) },
    message: null,
    rows,
  }
}

/**
 * The threads pane: what is this session in the middle of?
 *
 * The topic goes in `value` rather than `label` on purpose — a reader's
 * label column is a narrow fixed cell, and a thread whose subject is
 * truncated to fit one is a thread you cannot recognize. The label carries
 * the thing that is genuinely short: how long the thread has been open.
 */
function threadsPane(v: JournalVitals, storeName: string): PaneBlob {
  const rows: PaneRow[] = v.threads.open.map((t) => {
    // A topic made entirely of control bytes sanitizes to nothing, and an
    // empty value renders as an empty cell — the thread would be on the
    // pane but unreadable, which looks like a rendering fault rather than
    // a hostile topic. Name it instead.
    const topic = inert(t.topic) || 'untitled thread'
    const line = inert(t.line)
    return {
      label: `open ${span(t.createdAt, v.at)}`,
      value: topic,
      status: v.at - t.createdAt > T.threadStaleSec ? 'warn' : 'ok',
      ...(line ? { detail: line } : {}),
    } satisfies PaneRow
  })

  const elided = v.threads.openTotal - v.threads.open.length
  if (elided > 0) {
    rows.push({
      label: `+${elided} more`,
      value: 'open threads',
      // Many open threads at once is the supersession-hygiene smell the
      // journal's own orientation panel warns about, so the overflow line
      // says so rather than reading as a neutral count.
      status: 'warn',
      detail: 'older pointers nothing has superseded',
    })
  }

  if (rows.length === 0) {
    // The empty state carries the closed-out count itself, so the standing
    // row below would say the same number twice on the one pane where
    // there is nothing else to read.
    rows.push({
      label: 'no thread',
      value: 'nothing tagged to resume',
      status: 'warn',
      detail:
        v.threads.superseded > 0
          ? `${count(v.threads.superseded, 'thread')} closed out`
          : 'a close-out here is what the next session starts from',
    })
  } else {
    rows.push({
      label: 'closed out',
      value: v.threads.superseded.toLocaleString('en-US'),
      status: 'off',
      detail: 'threads a later entry superseded',
    })
  }

  return {
    v: PANE_VERSION,
    tool: PANE_TOOL,
    title: `threads · ${inert(storeName)}`,
    status: 'ok',
    basis: { label: PANE_BASIS_LABEL, at: basisStamp(v.at) },
    message: null,
    rows,
  }
}

/**
 * The trail pane: what is the captured journal actually made of?
 *
 * COMPOSITION, NOT HEALTH — and the distinction is the reason this pane is
 * almost entirely dim. `exit_type` comes from `classifyExit`, which matches
 * substrings in tool OUTPUT: "failed", "exception", "enoent", "cannot
 * find". A grep whose results mention an error is filed as an error; so is
 * a test run that prints "0 failed". Rendering that as a red defect rate
 * would put a number on screen that looks like a measurement and is a word
 * search, which is the exact species of claim this whole seam exists to
 * refuse. So the exit rows report and never escalate, and the row that
 * would be misread says in its own detail what produced it.
 *
 * The one genuine health claim here is retention: whether the store is
 * inside the budget the valve steers by. That one earns a colour.
 */
function trailPane(v: JournalVitals, storeName: string): PaneBlob {
  const e = v.trail.exits
  const known = (k: string): number => e[k] ?? 0
  // Percentages are of CLASSIFIED events, not of the journal: user turns
  // and curated notes carry no exit type, and dividing by them would quietly
  // shrink every share as the agent wrote more notes.
  const classified = Object.values(e).reduce((a, b) => a + b, 0)
  const share = (n: number): string => (classified === 0 ? '—' : `${Math.round((n / classified) * 100)}%`)
  const withShare = (n: number): string => `${n.toLocaleString('en-US')}  ${share(n)}`

  const intents = Object.entries(v.trail.intents).sort((a, b) => b[1] - a[1])
  const intentTotal = intents.reduce((a, [, n]) => a + n, 0)

  const rows: PaneRow[] = [
    {
      label: 'clean',
      value: classified === 0 ? 'nothing classified yet' : withShare(known('success')),
      status: 'off',
      spark: [known('success'), known('soft_fail'), known('error')],
    },
    { label: 'soft fails', value: withShare(known('soft_fail')), status: 'off' },
    {
      label: 'errors',
      value: withShare(known('error')),
      status: 'off',
      detail: 'matched from output text — a mention counts, so this is a census, not a defect rate',
    },
    {
      label: 'user turns',
      value: intentTotal === 0 ? 'none classified' : intentTotal.toLocaleString('en-US'),
      status: 'off',
      detail: intents.length
        ? intents.map(([k, n]) => `${n} ${k}`).join(' · ')
        : 'no intent recorded yet',
    },
    {
      label: 'previewed',
      value: v.trail.previewed.toLocaleString('en-US'),
      status: 'off',
      detail: 'indexed on a bounded preview; the full text comes back on export',
    },
    {
      label: 'retention',
      value: v.retention.overBudget ? 'over budget' : 'within budget',
      // The valve archives and demotes but never destroys, so over-budget
      // is "look at this", not "something was lost".
      status: v.retention.overBudget ? 'warn' : 'ok',
      detail: `${bytes(v.retention.storeBytes)} of ${bytes(v.retention.budgetBytes)}`,
    },
    {
      label: 'sessions',
      value: v.trail.sessions.toLocaleString('en-US'),
      status: 'off',
      detail: `${count(v.totalNodes, 'entry', 'entries')} across them`,
    },
  ]

  return {
    v: PANE_VERSION,
    tool: PANE_TOOL,
    title: `trail · ${inert(storeName)}`,
    status: 'ok',
    basis: { label: PANE_BASIS_LABEL, at: basisStamp(v.at) },
    message: null,
    rows,
  }
}

/**
 * Every pane for one drain. Pure: same vitals in, same bytes out — which is
 * what makes "the pane is a function of the journal and the drain moment"
 * checkable rather than merely intended.
 */
export function computeSidecarPanes(v: JournalVitals, storeName: string): SidecarPanes {
  return {
    journal: journalPane(v, storeName),
    threads: threadsPane(v, storeName),
    trail: trailPane(v, storeName),
  }
}

/**
 * The confession. Rows are deliberately empty: a reader ignores a broken
 * pane's rows, and shipping them anyway would mean carrying numbers we have
 * just said we cannot stand behind.
 */
export function brokenSidecarPanes(message: string, atSec: number, storeName: string): SidecarPanes {
  const one = (title: string): PaneBlob => ({
    v: PANE_VERSION,
    tool: PANE_TOOL,
    title: `${title} · ${inert(storeName)}`,
    status: 'broken',
    basis: { label: PANE_BASIS_LABEL, at: basisStamp(atSec) },
    message: inert(message) || 'the drain failed and said nothing about why',
    rows: [],
  })
  return { journal: one('journal'), threads: one('threads'), trail: one('trail') }
}

/**
 * Write one pane, whole or not at all: temp file in the SAME directory,
 * then rename. A reader polling this path sees the old pane or the new one,
 * never half of either — and never a zero-length file, which is the shape a
 * plain overwrite leaves behind for as long as the write takes.
 */
function writePane(target: string, blob: PaneBlob): void {
  const tmp = `${target}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, `${JSON.stringify(blob, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (err) {
    // A failed rename can leave the temp file behind, and a directory
    // slowly filling with `sidecar.json.tmp.NNNN` is its own defect.
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best effort — the original failure is the one worth reporting */
    }
    throw err
  }
}

export function writeSidecarPanes(storePath: string, panes: SidecarPanes): void {
  const paths = sidecarPaths(storePath)
  for (const name of Object.keys(SIDECAR_FILES) as PaneName[]) writePane(paths[name], panes[name])
}

/** What a producer needs to read; `FlatStore` satisfies it. */
export interface VitalsSource {
  vitals(atSec: number): JournalVitals
}

/** A backend that can be asked for vitals. Legacy backends cannot, and get
 *  no pane rather than an invented one. */
export function isVitalsSource(x: unknown): x is VitalsSource {
  return !!x && typeof (x as Partial<VitalsSource>).vitals === 'function'
}

/**
 * Publish both panes for one drain.
 *
 * Total by construction: this runs inside the drain loop, and a pane that
 * could throw would take capture down with it — the display would have
 * killed the thing it exists to report on. Every failure path here ends in
 * either a confession on disk or a logged no-op.
 *
 * Callers must only reach this when they own the drain. That is not checked
 * here because it is not knowable here: ownership is a property of the
 * process's lock, and the caller is where the lock is.
 */
export function publishSidecarPanes(opts: {
  source: VitalsSource
  storePath: string
  storeName: string
  atSec: number
  /** Set when the drain this pane reports on failed. */
  failure?: string | undefined
}): void {
  const { source, storePath, storeName, atSec } = opts
  try {
    const panes = opts.failure
      ? brokenSidecarPanes(opts.failure, atSec, storeName)
      : computeSidecarPanes(source.vitals(atSec), storeName)
    writeSidecarPanes(storePath, panes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Try once to say so on the pane itself; if even that fails the pane
    // simply ages, and its write age is what tells the reader.
    try {
      writeSidecarPanes(storePath, brokenSidecarPanes(msg, atSec, storeName))
    } catch {
      warn(`[treecontext] sidecar pane not written: ${msg}`)
    }
  }
}
