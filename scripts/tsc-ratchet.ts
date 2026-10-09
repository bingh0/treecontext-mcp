/**
 * Full-project typecheck ratchet — hold the type-error debt still, in both
 * directions.
 *
 * `npm run typecheck` and CI only ever compiled tsconfig.build.json and
 * tsconfig.bench.json. Both are clean; `tsconfig.json` — the one that also
 * includes `tests` — was not, for months. That gap became load-bearing
 * on 2026-08-27: the world-split docs (tests/journal/README.md, and the header
 * of tests/journal/features.test.ts) name `tsc -p tsconfig.json --noEmit` as
 * the gate that enforces the per-wave world partition, because the deletion
 * probe proved vitest's in-run typecheck cannot see it — vitest reads only
 * *.test-d.ts, and the suite stayed green with a wave field deleted while tsc
 * surfaced all ten TS2339 sites. The paper named a ratchet that did not exist.
 * This is it.
 *
 * It was born holding an owner-gated debt of 84 errors; the owner authorized
 * the burn-down the same day and the baseline reached `{}` — so today this is
 * a zero-new-errors gate. The baseline machinery stays, not as ceremony: any
 * future ruling that parks a known error parks it HERE, visibly and counted,
 * instead of un-wiring the gate.
 *
 * Both directions matter, and the second is the one that gets skipped:
 *
 *   - UP is the obvious half. A new error, or one more of an existing code in
 *     a file already carrying some, fails. That is what makes the partition
 *     enforceable — a step body reading outside its wave's interface is a new
 *     TS2339 in a file that has none, and it stops the build.
 *   - DOWN is the half that keeps the file honest. A baseline that still
 *     claims errors somebody has since fixed is a pocket of free budget: the
 *     next real regression in that (file, code) lands under the old count and
 *     passes. A one-way ratchet decays into a rubber stamp. So a stale entry
 *     fails too, with `--update` as the fix.
 *
 * Keyed per file per error code, with a COUNT and no line numbers. Line
 * numbers churn on every edit above them and would turn the baseline into a
 * merge-conflict generator that nobody reads; the count is the smallest key
 * that still refuses to let a new error hide behind a fixed one of the same
 * shape in the same file.
 *
 * Usage:
 *   tsx scripts/tsc-ratchet.ts            # check (wired into `npm run typecheck`)
 *   tsx scripts/tsc-ratchet.ts --update   # rewrite the baseline from reality
 *
 * Exit codes are split on purpose: 1 means the ratchet caught drift (a human
 * has to decide what to do), 2 means the ratchet could not run at all. CI
 * treats both as red, but they are not the same news, and a run that cannot
 * spawn tsc must never be readable as a pass.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'tsc-ratchet-baseline.json')
const PROJECT = 'tsconfig.json'

/** Exit(1): the baseline and reality disagree. Exit(2): tsc never answered. */
const EXIT_DRIFT = 1
const EXIT_BROKEN = 2

// ---------------------------------------------------------------------------
// Pure core — parse and compare. Exported so tests/scripts/tsc-ratchet.test.ts
// can drive every branch off strings instead of spawning a compiler.
// ---------------------------------------------------------------------------

/** One `path(line,col): error TSxxxx: message` diagnostic, plus its indented
 *  continuation lines — those carry the "Type 'undefined' is not assignable"
 *  detail that makes a failure report actionable. */
export interface TscDiagnostic {
  /** Path as tsc printed it, separators normalized to `/`. */
  readonly file: string
  readonly line: number
  readonly column: number
  /** `TS2345`, with the prefix — a bare number reads as a count in the JSON. */
  readonly code: string
  /** The header line and every continuation line under it, verbatim. */
  readonly text: string
}

/** `{ "tests/foo.ts": { "TS2341": 3 } }` — file → error code → count. */
export type Baseline = Readonly<Record<string, Readonly<Record<string, number>>>>

export interface ParsedTscOutput {
  readonly diagnostics: readonly TscDiagnostic[]
  /**
   * Every line that was neither a diagnostic header, a continuation, nor a
   * known-benign summary. Non-empty means the output has a shape this parser
   * does not model — a fileless `error TS18003:` from a broken config, a
   * crash, a future tsc that reformats. The caller must treat that as a hard
   * failure: silently counting zero errors from output we cannot read is
   * exactly the pass this gate exists to make impossible.
   */
  readonly unparsed: readonly string[]
}

/** `tests/steps/a.ts(59,19): error TS2769: No overload matches this call.`
 *
 *  The file group is greedy so it backtracks to the LAST `(l,c): error TS…:`
 *  in the line — a path containing parentheses still splits correctly, which
 *  a non-greedy group would not. */
const HEADER = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/
/** tsc's own tally line, when a version prints one. Not a diagnostic. */
const SUMMARY = /^Found \d+ errors? in \d+ files?\.?$/

export function parseTscOutput(output: string): ParsedTscOutput {
  const diagnostics: TscDiagnostic[] = []
  const unparsed: string[] = []
  // Continuation lines belong to the header above them, so the block is built
  // incrementally and only sealed when the next header (or the end) arrives.
  let openText: string[] | undefined

  const seal = (): void => {
    if (openText === undefined) return
    const last = diagnostics.at(-1)
    if (last !== undefined) diagnostics[diagnostics.length - 1] = { ...last, text: openText.join('\n') }
    openText = undefined
  }

  for (const raw of output.split(/\r?\n/)) {
    if (raw.trim() === '') continue

    const m = HEADER.exec(raw)
    if (m !== null) {
      seal()
      const [, file, line, column, code] = m
      diagnostics.push({
        file: (file ?? '').replaceAll('\\', '/'),
        line: Number(line),
        column: Number(column),
        code: code ?? '',
        text: raw,
      })
      openText = [raw]
      continue
    }

    if (openText !== undefined && /^\s/.test(raw)) {
      openText.push(raw)
      continue
    }

    seal()
    if (SUMMARY.test(raw)) continue
    unparsed.push(raw)
  }
  seal()

  return { diagnostics, unparsed }
}

/** Collapse diagnostics into the baseline shape, keys sorted so the committed
 *  file is diff-stable regardless of the order tsc happened to report in. */
export function tally(diagnostics: readonly TscDiagnostic[]): Baseline {
  const counts = new Map<string, Map<string, number>>()
  for (const d of diagnostics) {
    let byCode = counts.get(d.file)
    if (byCode === undefined) {
      byCode = new Map<string, number>()
      counts.set(d.file, byCode)
    }
    byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1)
  }

  const out: Record<string, Record<string, number>> = {}
  for (const file of [...counts.keys()].sort()) {
    const byCode = counts.get(file)
    if (byCode === undefined) continue
    const codes: Record<string, number> = {}
    for (const code of [...byCode.keys()].sort()) codes[code] = byCode.get(code) ?? 0
    out[file] = codes
  }
  return out
}

/** One (file, code) key whose count moved. `baseline: 0` is a key that is new;
 *  `actual: 0` is one the baseline still claims and reality no longer has. */
export interface CountDelta {
  readonly file: string
  readonly code: string
  readonly baseline: number
  readonly actual: number
}

export interface RatchetDiff {
  /** Counts that grew, or keys absent from the baseline. Fix the errors. */
  readonly regressions: readonly CountDelta[]
  /** Counts the baseline over-claims. Rerun with `--update`. */
  readonly stale: readonly CountDelta[]
}

export function diffAgainstBaseline(baseline: Baseline, actual: Baseline): RatchetDiff {
  const regressions: CountDelta[] = []
  const stale: CountDelta[] = []

  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(actual)])].sort()) {
    const b = baseline[file] ?? {}
    const a = actual[file] ?? {}
    for (const code of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      const before = b[code] ?? 0
      const now = a[code] ?? 0
      if (now > before) regressions.push({ file, code, baseline: before, actual: now })
      else if (now < before) stale.push({ file, code, baseline: before, actual: now })
    }
  }

  return { regressions, stale }
}

/** Sorted keys, two-space indent, trailing newline — the file is committed, so
 *  two runs over the same tree must produce byte-identical output. */
export function serializeBaseline(baseline: Baseline): string {
  const out: Record<string, Record<string, number>> = {}
  for (const file of Object.keys(baseline).sort()) {
    const codes = baseline[file] ?? {}
    const sorted: Record<string, number> = {}
    for (const code of Object.keys(codes).sort()) sorted[code] = codes[code] ?? 0
    out[file] = sorted
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

export function totalErrors(baseline: Baseline): number {
  let n = 0
  for (const codes of Object.values(baseline)) for (const c of Object.values(codes)) n += c
  return n
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function die(code: number, lines: readonly string[]): never {
  for (const l of lines) console.error(l)
  process.exit(code)
}

/**
 * Spawn the compiler without a shell and without `npx`.
 *
 * `require.resolve('typescript/package.json')` is the portable handle: the
 * package's exports map publishes it, and `lib/tsc.js` beside it is the JS
 * entry that locates the platform binary itself (TypeScript 7 ships a native
 * compiler behind that shim). Going through `node <that file>` rather than the
 * `.bin/tsc` shim is what makes this work identically on the win32 lane of the
 * 3-OS mirror matrix, where `.bin/tsc` is a `.cmd` that a shell-less spawn
 * cannot execute.
 *
 * `--pretty false` is explicit rather than inherited from "stdout is a pipe":
 * ANSI decoration would break the line parser, and that must not depend on how
 * the caller happened to wire its file descriptors.
 */
function runTsc(): { output: string; status: number } {
  const req = createRequire(import.meta.url)
  let entry: string
  try {
    entry = join(dirname(req.resolve('typescript/package.json')), 'lib', 'tsc.js')
  } catch (e) {
    return die(EXIT_BROKEN, [
      'tsc-ratchet: cannot resolve the typescript package — is `npm ci` done?',
      `  ${String(e)}`,
    ])
  }

  const run = spawnSync(process.execPath, [entry, '-p', PROJECT, '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    // The baseline is keyed on the paths tsc prints, which are relative to
    // cwd; ROOT above pins those regardless of where the script was invoked.
    maxBuffer: 64 * 1024 * 1024,
  })

  if (run.error !== undefined) {
    return die(EXIT_BROKEN, ['tsc-ratchet: could not spawn tsc.', `  ${String(run.error)}`])
  }
  if (run.signal !== null) {
    return die(EXIT_BROKEN, [`tsc-ratchet: tsc was killed by signal ${run.signal}.`])
  }

  return { output: `${run.stdout ?? ''}${run.stderr ?? ''}`, status: run.status ?? EXIT_BROKEN }
}

/** Everything that means "we did not get a readable answer from tsc". Each of
 *  these would otherwise parse to zero diagnostics and sail through as a pass. */
function assertReadable(parsed: ParsedTscOutput, status: number, output: string): void {
  if (parsed.unparsed.length > 0) {
    die(EXIT_BROKEN, [
      'tsc-ratchet: tsc printed lines this parser does not understand — refusing to',
      'report a result from output it cannot read.\n',
      ...parsed.unparsed.slice(0, 20).map(l => `  ${l}`),
      '',
      'A fileless `error TSxxxx:` here usually means the project config is broken.',
    ])
  }
  if (status !== 0 && parsed.diagnostics.length === 0) {
    die(EXIT_BROKEN, [
      `tsc-ratchet: tsc exited ${status} but reported no diagnostics.`,
      '',
      output.trim() === '' ? '  (no output at all)' : output.trim(),
    ])
  }
  if (status === 0 && parsed.diagnostics.length > 0) {
    die(EXIT_BROKEN, [
      `tsc-ratchet: tsc exited 0 while printing ${parsed.diagnostics.length} diagnostics.`,
      'That contradiction means the output shape moved; the parser needs updating.',
    ])
  }
}

/** Shape complaints for a parsed baseline candidate; empty means valid.
 *  Hand edits are expected — the sanity drill for this gate is to inflate a
 *  count by hand — so the shape is checked rather than trusted. */
function baselineProblems(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['  the file must be a JSON object of file → code → count']
  }
  const problems: string[] = []
  for (const [file, codes] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof codes !== 'object' || codes === null || Array.isArray(codes)) {
      problems.push(`  ${file}: expected an object of code → count`)
      continue
    }
    for (const [code, count] of Object.entries(codes as Record<string, unknown>)) {
      if (!/^TS\d+$/.test(code)) problems.push(`  ${file}: "${code}" is not an error code`)
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        problems.push(`  ${file}.${code}: expected a positive integer, got ${JSON.stringify(count)}`)
      }
    }
  }
  return problems
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    die(EXIT_BROKEN, [
      `tsc-ratchet: no baseline at ${BASELINE_PATH}.`,
      '',
      'It is a committed file. Generate it with:',
      '',
      '  tsx scripts/tsc-ratchet.ts --update',
    ])
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch (e) {
    return die(EXIT_BROKEN, [
      `tsc-ratchet: ${BASELINE_PATH} is not valid JSON.`,
      `  ${String(e)}`,
      '',
      'Repair it by hand, or regenerate it: tsx scripts/tsc-ratchet.ts --update',
    ])
  }

  const problems = baselineProblems(raw)
  if (problems.length > 0) {
    return die(EXIT_BROKEN, [
      `tsc-ratchet: ${BASELINE_PATH} is malformed.`,
      '',
      ...problems,
      '',
      'Repair it by hand, or regenerate it: tsx scripts/tsc-ratchet.ts --update',
    ])
  }

  return raw as Baseline
}

/** The previous baseline for --update's change report — tolerant on purpose.
 *  --update is the advertised repair path for a botched hand edit, so a
 *  malformed or unreadable file must read as empty here rather than kill the
 *  one command that can fix it; the content is about to be overwritten and
 *  feeds nothing but the report. */
function previousBaselineForUpdate(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    if (baselineProblems(raw).length === 0) return raw as Baseline
  } catch {
    // fall through: unreadable is the same news as malformed here
  }
  console.log('tsc-ratchet: the previous baseline was unreadable — the change report below is from empty.')
  return {}
}

function describe(b: Baseline): string {
  const files = Object.keys(b).length
  return `${totalErrors(b)} error${totalErrors(b) === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'}`
}

function update(actual: Baseline): void {
  const previous = previousBaselineForUpdate()
  writeFileSync(BASELINE_PATH, serializeBaseline(actual))

  const { regressions, stale } = diffAgainstBaseline(previous, actual)
  console.log(`tsc-ratchet: baseline rewritten — ${describe(actual)}.`)
  if (regressions.length === 0 && stale.length === 0) {
    console.log('             no change from the previous baseline.')
    return
  }
  for (const d of regressions) {
    console.log(`  + ${d.file} ${d.code}: ${d.baseline} -> ${d.actual}${d.baseline === 0 ? '  (new)' : ''}`)
  }
  for (const d of stale) {
    console.log(`  - ${d.file} ${d.code}: ${d.baseline} -> ${d.actual}${d.actual === 0 ? '  (cleared)' : ''}`)
  }
  console.log(`\nReview the diff before committing: ${regressions.length} up, ${stale.length} down.`)
}

function check(actual: Baseline, diagnostics: readonly TscDiagnostic[]): void {
  const baseline = loadBaseline()
  const { regressions, stale } = diffAgainstBaseline(baseline, actual)

  if (regressions.length > 0) {
    console.error('tsc-ratchet: NEW type errors — `tsc -p tsconfig.json --noEmit` got worse.\n')
    for (const d of regressions) {
      console.error(`  ${d.file}  ${d.code}: baseline allows ${d.baseline}, found ${d.actual}`)
      for (const diag of diagnostics.filter(x => x.file === d.file && x.code === d.code)) {
        for (const line of diag.text.split('\n')) console.error(`    ${line}`)
      }
      console.error('')
    }
    console.error('Fix these. The baseline holds a debt that is owner-gated and shrinking-only —')
    console.error('it is not a place to park new errors, and `--update` will not make these legal.')
    process.exit(EXIT_DRIFT)
  }

  if (stale.length > 0) {
    console.error('tsc-ratchet: the baseline is STALE — it claims errors that no longer exist.\n')
    for (const d of stale) {
      console.error(`  ${d.file}  ${d.code}: baseline claims ${d.baseline}, found ${d.actual}`)
    }
    console.error('\nEvery over-claimed count is free budget for the next real regression to hide in.')
    console.error('Bank the fix:\n')
    console.error('  tsx scripts/tsc-ratchet.ts --update\n')
    console.error('then commit scripts/tsc-ratchet-baseline.json with the change that earned it.')
    process.exit(EXIT_DRIFT)
  }

  console.log(`tsc-ratchet: held — ${describe(actual)}, exactly as baselined.`)
}

function main(): void {
  const args = process.argv.slice(2)
  const unknown = args.filter(a => a !== '--update')
  if (unknown.length > 0) {
    // A typo'd `--updat` must not quietly run a check and report "held".
    die(EXIT_BROKEN, [
      `tsc-ratchet: unknown argument(s): ${unknown.join(', ')}`,
      '',
      'Usage: tsx scripts/tsc-ratchet.ts [--update]',
    ])
  }

  const { output, status } = runTsc()
  const parsed = parseTscOutput(output)
  assertReadable(parsed, status, output)

  const actual = tally(parsed.diagnostics)
  if (args.includes('--update')) update(actual)
  else check(actual, parsed.diagnostics)
}

// Guarded so tests/scripts/tsc-ratchet.test.ts can import the pure half without
// spawning a compiler as a side effect of the import.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main()
