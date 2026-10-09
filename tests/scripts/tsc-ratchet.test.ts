/**
 * The ratchet's pure half, pinned.
 *
 * Everything here feeds the parser strings. Spawning a real compiler to test
 * the comparison would make the assertions depend on the repo's current debt,
 * which is the one number this suite must not be coupled to — the baseline
 * moves whenever somebody fixes or adds an error, and a test that reads it
 * would go red for reasons that have nothing to do with the ratchet logic.
 *
 * The four claims worth holding are the four ways this gate can be wrong:
 * missing a new error, missing one more of an error it already knows, missing
 * a baseline that over-claims (free budget for the next regression), and
 * splitting Windows paths into keys that never match the committed file.
 */
import { describe, it, expect } from 'vitest'

import {
  diffAgainstBaseline,
  parseTscOutput,
  serializeBaseline,
  tally,
  totalErrors,
  type Baseline,
} from '../../scripts/tsc-ratchet.js'

/** Real output shape, including the indented continuation lines a failure
 *  report has to quote back. Two codes in one file, one of them twice. */
const OUTPUT = [
  "tests/a.ts(12,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "  Type 'undefined' is not assignable to type 'string'.",
  "tests/a.ts(40,9): error TS2322: Type 'number' is not assignable to type 'string'.",
  "tests/a.ts(51,1): error TS6133: 'w' is declared but its value is never read.",
  'tests/b.ts(7,19): error TS2769: No overload matches this call.',
  '  The last overload gave the following error.',
].join('\n')

const BASE: Baseline = {
  'tests/a.ts': { TS2322: 2, TS6133: 1 },
  'tests/b.ts': { TS2769: 1 },
}

describe('parseTscOutput', () => {
  it('reads the header shape and keeps continuation lines with their diagnostic', () => {
    const { diagnostics, unparsed } = parseTscOutput(OUTPUT)
    expect(unparsed).toEqual([])
    expect(diagnostics).toHaveLength(4)
    expect(diagnostics[0]).toMatchObject({ file: 'tests/a.ts', line: 12, column: 3, code: 'TS2322' })
    // The detail line is what makes a regression report actionable, so it
    // travels with the header rather than being dropped as noise.
    expect(diagnostics[0]?.text).toContain("Type 'undefined' is not assignable")
    expect(diagnostics[3]?.text.split('\n')).toHaveLength(2)
  })

  it('normalizes backslash paths so a win32 lane keys the same file as linux', () => {
    const { diagnostics } = parseTscOutput(
      String.raw`tests\helpers\platform.ts(18,14): error TS4023: Exported variable cannot be named.`,
    )
    expect(diagnostics[0]?.file).toBe('tests/helpers/platform.ts')
    expect(tally(diagnostics)).toEqual({ 'tests/helpers/platform.ts': { TS4023: 1 } })
  })

  it('reports anything it cannot read rather than counting zero errors', () => {
    // A fileless diagnostic is the broken-config shape. Treating it as "no
    // errors found" is the silent pass this whole script exists to prevent.
    const { diagnostics, unparsed } = parseTscOutput(
      "error TS18003: No inputs were found in config file 'tsconfig.json'.",
    )
    expect(diagnostics).toEqual([])
    expect(unparsed).toEqual(["error TS18003: No inputs were found in config file 'tsconfig.json'."])
  })
})

describe('diffAgainstBaseline', () => {
  it('passes when reality matches the baseline exactly', () => {
    const diff = diffAgainstBaseline(BASE, tally(parseTscOutput(OUTPUT).diagnostics))
    expect(diff).toEqual({ regressions: [], stale: [] })
  })

  it('passes on nothing at all — zero errors against an empty baseline', () => {
    const { diagnostics, unparsed } = parseTscOutput('')
    expect(unparsed).toEqual([])
    expect(diffAgainstBaseline({}, tally(diagnostics))).toEqual({ regressions: [], stale: [] })
  })

  it('catches a code the file has never carried', () => {
    // The world-partition case: a step body reading outside its wave is a
    // fresh TS2339 in a file whose baseline has no TS2339 key at all.
    const worse = `${OUTPUT}\ntests/b.ts(80,5): error TS2339: Property 'wave' does not exist on type 'CaptureWorld'.`
    const { regressions, stale } = diffAgainstBaseline(BASE, tally(parseTscOutput(worse).diagnostics))
    expect(stale).toEqual([])
    expect(regressions).toEqual([{ file: 'tests/b.ts', code: 'TS2339', baseline: 0, actual: 1 }])
  })

  it('catches one MORE of a code the file already carries', () => {
    // Without the count, a third TS2322 in tests/a.ts would land inside an
    // existing key and pass — which is how a per-file allowlist decays.
    const worse = `${OUTPUT}\ntests/a.ts(99,2): error TS2322: Type 'boolean' is not assignable to type 'string'.`
    const { regressions, stale } = diffAgainstBaseline(BASE, tally(parseTscOutput(worse).diagnostics))
    expect(stale).toEqual([])
    expect(regressions).toEqual([{ file: 'tests/a.ts', code: 'TS2322', baseline: 2, actual: 3 }])
  })

  it('catches a baseline that over-claims — both a shrunk count and a cleared file', () => {
    const fixed = OUTPUT.split('\n')
      .filter(l => !l.startsWith('tests/a.ts(40,9)') && !l.startsWith('tests/b.ts('))
      .filter(l => l !== '  The last overload gave the following error.')
      .join('\n')
    const { regressions, stale } = diffAgainstBaseline(BASE, tally(parseTscOutput(fixed).diagnostics))
    expect(regressions).toEqual([])
    expect(stale).toEqual([
      { file: 'tests/a.ts', code: 'TS2322', baseline: 2, actual: 1 },
      { file: 'tests/b.ts', code: 'TS2769', baseline: 1, actual: 0 },
    ])
  })

  it('reports drift in both directions from one run', () => {
    const churned = [
      "tests/a.ts(12,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
      "tests/a.ts(51,1): error TS6133: 'w' is declared but its value is never read.",
      "tests/c.ts(1,1): error TS2304: Cannot find name 'foo'.",
    ].join('\n')
    const { regressions, stale } = diffAgainstBaseline(BASE, tally(parseTscOutput(churned).diagnostics))
    expect(regressions).toEqual([{ file: 'tests/c.ts', code: 'TS2304', baseline: 0, actual: 1 }])
    expect(stale).toEqual([
      { file: 'tests/a.ts', code: 'TS2322', baseline: 2, actual: 1 },
      { file: 'tests/b.ts', code: 'TS2769', baseline: 1, actual: 0 },
    ])
  })
})

describe('serializeBaseline', () => {
  it('sorts every key so the committed file is diff-stable', () => {
    const shuffled: Baseline = {
      'tests/b.ts': { TS2769: 1 },
      'tests/a.ts': { TS6133: 1, TS2322: 2 },
    }
    expect(serializeBaseline(shuffled)).toBe(serializeBaseline(BASE))
    expect(serializeBaseline(shuffled)).toBe(
      `{\n  "tests/a.ts": {\n    "TS2322": 2,\n    "TS6133": 1\n  },\n  "tests/b.ts": {\n    "TS2769": 1\n  }\n}\n`,
    )
  })

  it('round-trips through JSON with the counts intact', () => {
    expect(totalErrors(JSON.parse(serializeBaseline(BASE)) as Baseline)).toBe(4)
  })
})
