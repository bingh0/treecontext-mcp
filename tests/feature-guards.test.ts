/**
 * Feature-file guards — gherkin-node-test lints AND executes the whole
 * corpus. (Original runner decision ratified 2026-07-17; runner switch
 * 2026-07-23 put GNT_RUN_DIRS on gnt's vitest adapter; the executor
 * migration completed 2026-08-26 when the last vitest-cucumber binding
 * converted, retiring the second parser and the two-parser cross-check
 * with it. This file lives at tests/ root because it guards the whole
 * corpus, not just the journal charter.)
 *
 * The executor fails loudly on scenario- and step-level drift within the
 * files it runs. This guard adds only what the executor cannot see:
 *
 *  1. DIALECT — every feature file parses under gherkin-node-test's
 *     restricted dialect, keeping the corpus portable to gherkin-cargo-test
 *     verbatim. The pinned gherkin-node-test version in package.json is the
 *     de-facto dialect version.
 *  2. ORPHANS — every feature file sits under a GNT_RUN_DIRS directory
 *     whose runner discovers it, so a spec can't sit in the tree silently
 *     decorating nothing; the runner file must exist and actually call
 *     runFeatures.
 *  3. SPEC QUALITY — the deterministic lints (no-then / vague-then /
 *     single-row-outline / near-miss-keyword / unused-column), plus the
 *     step-source lint over every definer module.
 *
 * Every exemption lives in a register below with a reason, and each register
 * is a RATCHET, checked in both directions: an unregistered violation fails
 * the suite, and a stale entry (one whose violation no longer exists) also
 * fails, so the registers can only shrink truthfully.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { lintFeature, lintStepDefinitionSource, parseFeature } from 'gherkin-node-test'
import { WHOLE_FEATURE_WIP } from './journal/wip-register.js'

// ── Debt registers ──────────────────────────────────────────────────────────

// Files that legitimately use full Gherkin (doc strings) and are executor-only:
// NOT portable to gherkin-cargo-test. Emptied at the deletion phase
// (2026-07-25) when the ts-graph specs left with the code tool; the register
// stays because the hazard class (doc-string features splitting the dialect)
// outlives any one suite. The click: rework a file, delete its entry.
const EXECUTOR_ONLY = new Set<string>([])

// Directories whose features are EXECUTED by gnt's vitest adapter: one
// runner .test.ts per directory calls runFeatures(dir), which discovers
// every .feature in the directory itself and enforces its own binding
// ratchet — the unbound-step debt register is the runner file's `wip:`
// list (grep-able there, scenario-scoped, ratcheted in both directions by
// gnt). Features under these directories are therefore banned from the WIP
// register below: one debt ledger per feature, never two.
const GNT_RUN_DIRS = new Map([
  // Most-specific prefix first: the design tier is a subdirectory of the
  // intent tier's root.
  ['features/design/', 'tests/features-design.test.ts'],
  ['features/', 'tests/journal/features.test.ts'],
])
const gntRunnerFor = (file: string): string | undefined => {
  for (const [dir, runner] of GNT_RUN_DIRS) if (file.startsWith(dir)) return runner
  return undefined
}

// The spec-first WIP register retired with the second executor
// (2026-08-26): its role — a debt ledger for features bound to nothing —
// lives entirely in the runners' wip lists now, scenario-scoped and
// ratcheted in both directions by gnt itself. Its history (the absorb
// pass 2026-07-25, the migration-backup corpus's same-day full cycle
// 2026-08-06) is in git.

// Accepted warn-level lint findings, as `${rule} ${file}:${line}`. Empty is
// the goal state and the current state; an entry needs a `// why` comment.
const LINT_DEBT = new Set<string>([])

// ── Corpus discovery ─────────────────────────────────────────────────────────

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
// Since the 2026-08-25 reorg the corpus lives in two roots: bindings,
// guards, and runners stay under tests/, while the feature files sit at
// features/ (intent tier) and features/design/ (builder tier). Both roots
// are walked; every path is reported repo-relative with POSIX separators.
const FEATURES_DIR = join(TESTS_DIR, '..', 'features')
// POSIX separators, always. readdirSync({recursive}) yields paths with the
// PLATFORM separator, and every register above (GNT_RUN_DIRS,
// EXECUTOR_ONLY, LINT_DEBT — the spec-first WIP register retired with the
// second executor) plus the basename splits below are written with
// '/'. Joining with the platform separator therefore produced
// `tests\journal\x.feature` on Windows, where startsWith('tests/journal/') is
// false for every entry: GNT_RUN_DIRS covered nothing, `split('/').pop()`
// returned the whole path instead of a basename, and all 23 features reported
// "no binding .test.ts". This file is the abdd ratchet — a guard that reads
// differently per platform grades a different corpus than it claims to.
const walkFrom = (root: string, prefix: string, ext: string): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => `${prefix}${f.split(sep).join('/')}`)
    .sort()
const walk = (ext: string): string[] =>
  [...walkFrom(TESTS_DIR, 'tests/', ext), ...walkFrom(FEATURES_DIR, 'features/', ext)]

const featureFiles = walk('.feature')
const read = (rel: string) => readFileSync(join(TESTS_DIR, '..', rel), 'utf8')
const lintOf = new Map(featureFiles.map((f) => [f, lintFeature(read(f), f)]))

describe('feature-file guards (gherkin-node-test lints and executes the corpus)', () => {
  test('the corpus is where the registers think it is', () => {
    expect(featureFiles.length).toBeGreaterThan(0)
    for (const f of EXECUTOR_ONLY) {
      expect(featureFiles, `register entry names a missing file: ${f}`).toContain(f)
    }
    for (const [dir, runner] of GNT_RUN_DIRS) {
      expect(featureFiles.some((f) => f.startsWith(dir)),
        `GNT_RUN_DIRS entry covers no feature files: ${dir}`).toBe(true)
      // The runner must exist and genuinely execute — an empty or renamed
      // runner file would otherwise leave a whole directory bound to nothing.
      const src = read(runner)
      expect(src, `${runner}: does not import the gnt vitest adapter`).toContain('gherkin-node-test/vitest')
      expect(src, `${runner}: does not call runFeatures`).toContain('runFeatures(')
    }
  })

  test('every feature file is in-dialect, or registered executor-only', () => {
    const problems: string[] = []
    for (const [file, findings] of lintOf) {
      const dialect = findings.filter((f) => f.severity === 'error')
      if (dialect.length && !EXECUTOR_ONLY.has(file)) {
        problems.push(...dialect.map((f) => `${file}:${f.line}: ${f.message}`))
      }
      // Stale-exemption ratchet: an entry whose file now parses clean must go.
      if (!dialect.length && EXECUTOR_ONLY.has(file)) {
        problems.push(`${file}: parses in-dialect — remove its EXECUTOR_ONLY entry`)
      }
    }
    expect(problems).toEqual([])
  })

  test('warn-level lint findings match the debt register exactly', () => {
    const found = new Set<string>()
    for (const [file, findings] of lintOf) {
      for (const f of findings) {
        if (f.severity === 'warn') found.add(`${f.rule} ${file}:${f.line}`)
      }
    }
    const unregistered = [...found].filter((k) => !LINT_DEBT.has(k))
    const stale = [...LINT_DEBT].filter((k) => !found.has(k))
    expect(unregistered, 'unregistered lint findings (fix the spec or register with a why)').toEqual([])
    expect(stale, 'stale LINT_DEBT entries (finding no longer exists — remove them)').toEqual([])
  })

  test('every step definition earns its absences (gnt 0.11 step-source lint)', () => {
    // lintStepDefinitionSource (gh#4 §4.2) reads the OTHER side of the
    // contract from lintFeature above: binding source, not feature text.
    // The default rule — unearned-absence — fires on literal-needle
    // negations, the shape of an assertion that cannot fail. Scan-root
    // coverage is this caller's job: the gnt runners' inline definers, the
    // extracted definer modules (every *.steps.ts, both tiers), and the
    // journal tier's shared harness layer (tests/journal/*.ts — world,
    // wave harnesses, wip register), whose helpers carry assertions the
    // steps lean on and which lived inside the runner's scan until the
    // 2026-08-26 mega-runner extraction. Sanction is a
    // statement-attached `// step-lint: allow <rule> -- <reason>` marker
    // naming its prover; a marker whose rule no longer fires is itself a
    // finding.
    const runnerFiles = [...GNT_RUN_DIRS.values()]
    const stepsFiles = walk('.steps.ts')
    const harnessFiles = walkFrom(join(TESTS_DIR, 'journal'), 'tests/journal/', '.ts')
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.steps.ts'))
    const helperFiles = walkFrom(join(TESTS_DIR, 'helpers'), 'tests/helpers/', '.ts')
    const sources = [...runnerFiles, ...stepsFiles, ...harnessFiles, ...helperFiles]
    expect(sources.length, 'step-source discovery found no bindings').toBeGreaterThan(0)
    const problems: string[] = []
    for (const file of sources) {
      for (const x of lintStepDefinitionSource(read(file), file)) {
        problems.push(`${file}:${x.line}: [${x.rule}] ${x.message}`)
      }
    }
    expect(problems, 'hollow-absence shapes in step definitions — prove the needle, rewrite positive, or sanction with a prover-naming marker').toEqual([])
  })

  test('every feature file sits under a gnt runner directory', () => {
    // The one-executor orphan guard: each directory's runner discovers
    // every .feature under it and holds its own binding ratchet (unbound
    // steps land in its wip list, loudly), so the only way a spec can
    // silently decorate nothing is to sit OUTSIDE every runner's
    // directory. Unique basenames stay load-bearing: the definer maps and
    // the gt journal join key on them.
    const bases = featureFiles.map((f) => f.split('/').pop()!)
    expect(new Set(bases).size, 'duplicate .feature basenames break the orphan guard').toBe(bases.length)

    const problems: string[] = []
    for (const file of featureFiles) {
      if (!gntRunnerFor(file)) problems.push(`${file}: outside every GNT_RUN_DIRS directory — no runner discovers it`)
    }
    expect(problems).toEqual([])
  })

  test('only @bug and ruling-id tags are tagged', () => {
    // gnt rejects @only and near-misses natively and treats unknown tags
    // as inert; the allowlist applies so an inert tag can't accumulate as
    // folklore. Skipping is a wip-register decision, not a tag. (The
    // VITEST_INCLUDE_TAGS/EXCLUDE_TAGS env guards retired with
    // vitest-cucumber 2026-08-26 — those variables were its run-narrowing
    // seam and no longer reach anything.)
    const problems: string[] = []
    for (const [file, findings] of lintOf) {
      if (findings.some((f) => f.severity === 'error')) continue // executor-only: unparseable here
      const parsed = parseFeature(read(file), file)
      // Feature-level tags propagate onto every scenario in gnt's parse, so
      // scanning scenarios covers both levels.
      const tags = parsed.scenarios.flatMap((s) => s.tags)
      for (const t of tags) {
        // A ruling-id tag (@D41) names the docket entry the scenario proves —
        // the join key docketry reads (features/DOCKET.md, backport 2026-09-28).
        if (t !== '@bug' && !/^@D\d+$/u.test(t)) problems.push(`${file}: tag ${t} is not on the allowlist (@bug and @D<n> only)`)
      }
    }
    expect(problems).toEqual([])
  })

  // The two-parser cross-check ('linter and executor agree on every
  // in-dialect file's scenario titles') retired here 2026-08-26, the day
  // store-bindings — the last vitest-cucumber-bound feature — converted
  // to gnt: its anti-vacuity guard fired over an empty checked set, which
  // was the designed retirement signal. One parser now lints and executes
  // the whole corpus; the outline-collapse comparison logic it carried
  // exists only in git history.

  // ── Whole-feature WIP needs a ruling ──────────────────────────────────
  //
  // Scenario-scoped debt is ordinary. An entire unbound feature is not: it
  // means a whole surface has a charter that has never executed, which is
  // how 0.0.9-beta shipped journal-install — added and released in the same
  // commit, thirteen scenarios of prose, zero of them run. The ratchet below
  // makes that state cost a written ruling, and scripts/release-gate.ts
  // makes it cost a decision at release time.
  describe('whole-feature WIP rulings', () => {
    test('every whole-feature wip entry carries a reasoned ruling', () => {
      for (const ruling of WHOLE_FEATURE_WIP) {
        expect(featureFiles.some(f => f.endsWith(`/${ruling.feature}.feature`)),
          `ruling names a feature file that does not exist: ${ruling.feature}`).toBe(true)
        expect(ruling.reason.length,
          `${ruling.feature}: a ruling needs a reason, not a placeholder`).toBeGreaterThan(60)
        expect(ruling.ruledOn, `${ruling.feature}: ruling needs an ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    })

    test('the runner declares no whole-feature wip outside the register', () => {
      const runnerSrc = read('tests/journal/features.test.ts')
      const wipBlock = runnerSrc.slice(runnerSrc.indexOf('wip: ['))
      const bare = [...wipBlock.slice(0, wipBlock.indexOf('\n  ],')).matchAll(/^\s{4}'([a-z0-9-]+)',$/gm)]
        .map(m => m[1])
      expect(bare,
        'a whole-feature wip entry was added inline instead of as a ruling in wip-register.ts')
        .toEqual([])
      expect(runnerSrc, 'the runner no longer sources whole-feature wip from the register')
        .toContain('...wholeFeatureWip()')
    })

    test('a ruling whose feature is now fully bound must be removed', () => {
      // Stale-ruling ratchet: if the feature binds, the register must shrink.
      // gnt already fails a wip entry that is fully bound, so this asserts
      // the register cannot outlive that signal silently.
      for (const ruling of WHOLE_FEATURE_WIP) {
        const runnerSrc = read('tests/journal/features.test.ts')
        expect(runnerSrc.includes(`'${ruling.feature}': `),
          `${ruling.feature} has a definer registered but is still ruled whole-feature wip — remove the ruling`)
          .toBe(false)
      }
    })
  })
})
