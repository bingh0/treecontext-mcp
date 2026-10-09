/**
 * Run records, history, and the rendered report.
 *
 * The bench reports and never gates, so this module is the whole point of
 * the exercise: what a run emits, and how a later reader decides whether
 * something moved.
 *
 * Every record carries its own provenance — corpus checksum, slice rule,
 * mapping version, code revision, and the SQLite that actually did the
 * ranking. Without those a number is an anecdote: FTS5 ranking depends on
 * the bundled SQLite, so a better-sqlite3 bump can legitimately move every
 * figure, and a reader needs to be able to see that rather than deduce it.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function historyPath(): string {
  return join(HERE, '..', 'history.jsonl')
}

export interface SliceResult {
  slice: string
  metric: string
  value: number
  n: number
  /** Query-level bootstrap SE within this slice. Present so a slice can be
   *  compared run-to-run on the same footing as the aggregate — a failure
   *  confined to one category is invisible in the mean, so the slice table
   *  has to be a detector, not a decoration. */
  se: number
}

export interface RunRecord {
  schema: 1
  arm: string
  metric: string
  value: number
  n: number
  /** Query-level bootstrap SE — the scale reference for the band. */
  se: number
  /** Cluster-bootstrap SE over ability categories. Wider by construction;
   *  reported as the caveat on generalizing beyond these categories. */
  se_cluster: number
  /** Advisory only — nothing fails on it. */
  advisory_floor: number
  slices: SliceResult[]
  corpus: { id: string; sha256: string; bytes: number; pinned: boolean; mismatch: boolean }
  /** How the corpus was turned into journal entries. Bump on any change:
   *  a different mapping makes the number incomparable to earlier ones. */
  mapping_version: number
  slice_rule: string
  code_sha: string | null
  code_dirty: boolean
  better_sqlite3: string
  sqlite: string
  node: string
  platform: string
  elapsed_s: number
  measured_at: string
  /** True for a truncated run (--max). Partial runs score a different,
   *  easier question set, so they are neither recorded nor compared
   *  against full ones — an unguarded comparison reports a spurious
   *  multi-sigma "improvement" and teaches readers to distrust the whole
   *  report. */
  partial: boolean
  notes?: string
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function codeRevision(): { sha: string | null; dirty: boolean } {
  const sha = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain'])
  return { sha, dirty: status !== null && status.length > 0 }
}

export function readHistory(): RunRecord[] {
  const path = historyPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as RunRecord)
}

export function appendRun(record: RunRecord): void {
  appendFileSync(historyPath(), JSON.stringify(record) + '\n')
}

const pct = (x: number): string => (x * 100).toFixed(2) + '%'
const pp = (x: number): string => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp'

export type Verdict = 'within-noise' | 'regression' | 'improvement'

export interface Comparison {
  delta: number
  /** Standard error of the DIFFERENCE — both runs contribute. */
  jointSe: number
  /** |delta| expressed in units of jointSe. */
  sigmas: number
  verdict: Verdict
}

/**
 * The detector. One function, so that what the report prints and what the
 * falsification test asserts cannot drift apart.
 *
 * Three sigma on the difference of two means. Deliberately blunt: this
 * exists to catch the catastrophic class, not to adjudicate small moves.
 */
export function compareValues(
  value: number, se: number, refValue: number, refSe: number, sigma = 3,
): Comparison {
  const delta = value - refValue
  const jointSe = Math.sqrt(se ** 2 + refSe ** 2)
  const sigmas = jointSe > 0 ? Math.abs(delta) / jointSe : 0
  const verdict: Verdict = sigmas < sigma
    ? 'within-noise'
    : delta < 0 ? 'regression' : 'improvement'
  return { delta, jointSe, sigmas, verdict }
}

export function compareRuns(record: RunRecord, baseline: RunRecord, sigma = 3): Comparison {
  return compareValues(record.value, record.se, baseline.value, baseline.se, sigma)
}

/** Same test, applied within one slice. */
export function compareSlices(slice: SliceResult, baseline: SliceResult, sigma = 3): Comparison {
  return compareValues(slice.value, slice.se, baseline.value, baseline.se, sigma)
}

/**
 * Compare against the arm's previous run and its first, and say plainly
 * whether the difference is distinguishable from sampling noise.
 *
 * "Within noise" is the expected verdict and the useful one: it is what
 * lets a reader skip the row.
 */
export function renderReport(record: RunRecord, history: RunRecord[]): string {
  // A different mapping version is a different measurement. Comparing
  // across one would put a corpus change and a code regression in the same
  // column, which is the one thing this report must never do.
  const superseded = history.filter(
    r => r.arm === record.arm && r.metric === record.metric && r.mapping_version !== record.mapping_version,
  )
  const prior = history.filter(
    r => r.arm === record.arm && r.metric === record.metric && r.mapping_version === record.mapping_version,
  )
  const previous = prior[prior.length - 1]
  const first = prior[0]

  const lines: string[] = []
  lines.push(`## ${record.arm} — ${record.metric}`)
  lines.push('')
  lines.push(`**${pct(record.value)}**  (n=${record.n}, SE ${pct(record.se)}, ${record.elapsed_s.toFixed(1)}s)`)
  // Degenerate on a single-cluster sample; the caveat would read as noise.
  if (record.se_cluster > 0) {
    lines.push('')
    lines.push(`<sub>Cluster SE across ability categories: ${pct(record.se_cluster)} — wider because the categories genuinely differ; use it when generalizing beyond this question mix, not for reading run-to-run movement.</sub>`)
  }
  lines.push('')

  const compare = (label: string, other: RunRecord | undefined): void => {
    if (!other) return
    const { delta, sigmas, verdict } = compareRuns(record, other)
    const phrase = verdict === 'within-noise'
      ? 'within noise'
      : verdict === 'regression' ? '⚠️ REGRESSION beyond 3 SE' : 'improvement beyond 3 SE'
    lines.push(`- vs ${label} (${other.measured_at.slice(0, 10)}, ${pct(other.value)}): ${pp(delta)} — ${sigmas.toFixed(1)} SE, ${phrase}`)
  }
  if (record.partial) {
    lines.push(`- partial run (${record.n} queries) — not comparable to full runs, and not recorded`)
  } else {
    compare('previous run', previous)
    if (first && first !== previous) compare('first record', first)
    if (!previous) lines.push('- first recorded run for this arm — nothing to compare against yet')
  }

  lines.push(`- advisory floor (3 SE below this run): ${pct(record.advisory_floor)}`)

  if (superseded.length > 0 && !previous) {
    const last = superseded[superseded.length - 1]!
    lines.push(
      `- ${superseded.length} earlier run(s) exist at mapping version ${last.mapping_version} ` +
      `(latest ${pct(last.value)}), deliberately NOT compared: a different corpus is a different measurement`,
    )
  }

  if (record.corpus.mismatch) {
    lines.push('')
    lines.push(`> ⚠️ **Corpus checksum does not match the pinned value.** The number below was computed over different bytes than the pin claims. Investigate before reading anything into it.`)
  } else if (!record.corpus.pinned) {
    lines.push('')
    lines.push(`> ℹ️ Corpus checksum not yet pinned. Observed \`${record.corpus.sha256.slice(0, 16)}…\` — pin it in the arm definition to make later runs comparable.`)
  }

  if (record.slices.length > 0) {
    lines.push('')
    lines.push('### By slice')
    lines.push('')
    lines.push('| slice | n | value | vs previous | |')
    lines.push('| --- | ---: | ---: | ---: | --- |')
    for (const s of [...record.slices].sort((a, b) => b.n - a.n)) {
      const before = record.partial ? undefined : previous?.slices.find(p => p.slice === s.slice)
      // Reported, never gated. An aggregate that holds while one category
      // collapses is a failure this project has already had, and it is
      // invisible in a mean — so each slice gets the same 3-SE test.
      const cmp = before ? compareSlices(s, before) : null
      const delta = cmp ? pp(cmp.delta) : '—'
      const mark = cmp === null
        ? ''
        : cmp.verdict === 'regression' ? `⚠️ ${cmp.sigmas.toFixed(1)} SE`
        : cmp.verdict === 'improvement' ? `↑ ${cmp.sigmas.toFixed(1)} SE` : ''
      lines.push(`| ${s.slice} | ${s.n} | ${pct(s.value)} | ${delta} | ${mark} |`)
    }
  }

  lines.push('')
  lines.push('<details><summary>Provenance</summary>')
  lines.push('')
  lines.push(`- corpus: \`${record.corpus.id}\` · sha256 \`${record.corpus.sha256.slice(0, 16)}…\` · ${(record.corpus.bytes / 1e6).toFixed(1)} MB`)
  lines.push(`- slice rule: ${record.slice_rule}`)
  lines.push(`- mapping version: ${record.mapping_version}`)
  lines.push(`- code: \`${record.code_sha?.slice(0, 12) ?? 'unknown'}\`${record.code_dirty ? ' (dirty working tree)' : ''}`)
  lines.push(`- better-sqlite3 ${record.better_sqlite3} · SQLite ${record.sqlite} · Node ${record.node} · ${record.platform}`)
  lines.push('')
  lines.push('</details>')
  return lines.join('\n')
}
