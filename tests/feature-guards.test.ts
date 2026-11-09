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
import { GUARDED_DOOR_CALLS, DOOR_ROW_KINDS } from './journal/standins.js'

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

    test('a ruling says which of its scenarios are open once any of it binds', () => {
      // Stale-ruling ratchet: a ruling with nothing bound has no definer; a
      // ruling whose surface has partly bound carries the scenarios still
      // open, so the runner holds those and no more, while the gate keeps
      // refusing on the ruling until its own leaving condition holds. gnt
      // fails a scenario entry that has become fully bound, so the list
      // cannot outlive that signal silently either.
      const runnerSrc = read('tests/journal/features.test.ts')
      for (const ruling of WHOLE_FEATURE_WIP) {
        const bound = runnerSrc.includes(`'${ruling.feature}': `)
        expect(bound ? (ruling.scenarios?.length ?? 0) > 0 : ruling.scenarios === undefined,
          bound
            ? `${ruling.feature} has a definer registered: its ruling must list the scenarios still open, or be removed`
            : `${ruling.feature} has no definer: its ruling holds the whole feature and lists no scenarios`)
          .toBe(true)
      }
    })
  })
})

describe('no binding stands in for a door outside the stand-in harness', () => {
  // A door's own acts (a registration, a retirement, a send-back, a key
  // settled, a worker started, claimed or re-run, a door row composed, the
  // echo heal: GUARDED_DOOR_CALLS) are the door's to make. A binding that
  // needs one already made, because its scenario's Given is history, makes
  // it through a named helper of tests/journal/standins.ts, where each
  // stand-in says what it stands in for; anywhere else a mention of the
  // act would stand in for the door silently.
  //
  // What is checked, in every steps file of both tiers, every journal
  // harness module but standins.ts, and every file under tests/helpers:
  //  1. a guarded name anywhere outside comments and strings, as a word:
  //     a call (split across lines or not), `.call`/`.bind`/`.apply`, an
  //     import and its alias; and a string whose whole text is a guarded
  //     name (`store['retireLeg']`). A template literal's text is a string;
  //     its `${}` expressions are code. A regex literal is skipped whole.
  //  2. a plain `insert(` whose arguments name a door's row kind
  //     (DOOR_ROW_KINDS, quoted or by its constant).
  // Each finding outside the harness fails unless ALLOWED names its file
  // and line with a reason; an ALLOWED entry that no longer matches fails.
  // Not checked: a name assembled at run time (`store['retire' + 'Leg']`),
  // a door reached through a variable holding the store's prototype, or a
  // door row written through raw SQL.
  const HARNESS = 'tests/journal/standins.ts'
  const ALLOWED: Array<{ file: string; finding: string; line: string; why: string }> = [
    // The stand-in headless worker is the worker: a worker started with a
    // ticket and no wrapper claims it itself through claimTicket, the
    // production surface such a worker calls (D291), and under the door it
    // takes the lane the door registered. It never registers through the
    // registry directly.
    { file: 'tests/helpers/standin-worker.ts', finding: 'claimTicket', line: "import { claimTicket } from '../../src/ticket-door.js'", why: 'the worker imports its own claim surface' },
    { file: 'tests/helpers/standin-worker.ts', finding: 'claimTicket', line: 'const claim = await claimTicket({ store, ...(plan.claim?.prompt !== undefined ? { prompt: plan.claim.prompt } : {}) })', why: 'the worker claims its ticket as a real worker does' },
    // The run-open race (D302, tests/legs-and-runs.test.ts) needs two
    // processes registering first legs of the same runs at once; the
    // library door a spawner calls is the act under test there.
    { file: 'tests/helpers/run-opener.ts', finding: 'registerWorker', line: 'await store.registerWorker({', why: 'the run-open race is two spawners registering through the library door at once' },
    // A beta.1 handoff Given (journal-handoff, "the default export carries
    // summaries only"): a plain subagent's summary row as the drain writes
    // it, seeded so the export's selection by kind is under test, not the
    // door. Older than the harness; a plain subagent is no leg.
    { file: 'tests/journal/steps/journal-handoff.steps.ts', finding: 'insert kind subagent-summary', line: 'await w.aStore!.insert(w.testerText, {', why: "the export's selection by kind is under test; the row is seeded as the drain writes it" },
  ]
  const NAMES = new Set<string>(GUARDED_DOOR_CALLS)
  const KIND_CONSTS: Record<string, string> = { FIRST_MOMENT_KIND: 'first-moment', SEND_BACK_KIND: 'send-back', SUBAGENT_SUMMARY_KIND: 'subagent-summary' }

  /** The source as code alone, line for line: comments dropped, a string's
   *  text blanked unless it is exactly a guarded name, a template's text
   *  blanked with its `${}` kept, a regex literal blanked. `keepStrings`
   *  keeps every string's text (for the insert check). */
  const codeOf = (src: string, keepStrings = false): string => {
    let out = ''
    let i = 0
    const exprDepth: number[] = []
    let depth = 0
    let prev = ''
    const blank = (t: string): string => t.replace(/[^\n]/g, ' ')
    const str = (t: string): string => (keepStrings ? t : NAMES.has(t.slice(1, -1)) ? ` ${t.slice(1, -1)} ` : blank(t))
    const template = (): void => {
      // at the char after ` or after the } closing a ${}
      let t = ''
      while (i < src.length) {
        if (src[i] === '\\') { t += src.slice(i, i + 2); i += 2; continue }
        if (src[i] === '`') { out += keepStrings ? t + '`' : blank(t) + ' '; i++; prev = '`'; return }
        if (src[i] === '$' && src[i + 1] === '{') { out += (keepStrings ? t : blank(t)) + '  '; i += 2; exprDepth.push(depth); depth++; prev = '{'; return }
        t += src[i]; i++
      }
      out += keepStrings ? t : blank(t)
    }
    while (i < src.length) {
      const c = src[i]!
      const n = src[i + 1]
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
      if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); const stop = end === -1 ? src.length : end + 2; out += blank(src.slice(i, stop)); i = stop; continue }
      if (c === '/' && (prev === '' || /[(,=:[!&|?{};\n]/.test(prev))) {
        // A regex literal: to its unescaped closing slash outside a class.
        let j = i + 1
        let cls = false
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '[') cls = true
          else if (src[j] === ']') cls = false
          else if (src[j] === '/' && !cls) break
          j++
        }
        while (j + 1 < src.length && /[a-z]/.test(src[j + 1]!)) j++
        out += blank(src.slice(i, j + 1)); i = j + 1; prev = '/'; continue
      }
      if (c === "'" || c === '"') {
        let j = i + 1
        while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
        out += str(src.slice(i, j + 1)); i = j + 1; prev = c; continue
      }
      if (c === '`') { out += ' '; i++; template(); continue }
      if (c === '{') depth++
      if (c === '}') {
        depth--
        if (exprDepth.length > 0 && exprDepth[exprDepth.length - 1] === depth) { exprDepth.pop(); out += ' '; i++; template(); continue }
      }
      out += c
      if (!/\s/.test(c) || c === '\n') prev = c
      i++
    }
    return out
  }
  const lineAt = (text: string, at: number): number => text.slice(0, at).split('\n').length
  /** Each finding: its line number, what was found. */
  const findingsIn = (src: string): Array<{ n: number; finding: string }> => {
    const found: Array<{ n: number; finding: string }> = []
    const code = codeOf(src)
    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) if (NAMES.has(m[0])) found.push({ n: lineAt(code, m.index), finding: m[0] })
    const kept = codeOf(src, true)
    for (const m of kept.matchAll(/(?<![\w$])insert\s*\(/g)) {
      let d = 0
      let j = m.index + m[0].length - 1
      for (; j < kept.length; j++) { if (kept[j] === '(') d++; else if (kept[j] === ')' && --d === 0) break }
      const args = kept.slice(m.index, j + 1)
      const quoted = new RegExp(`kind\\s*:\\s*['"\`](${DOOR_ROW_KINDS.join('|')})['"\`]`).exec(args)?.[1]
      const named = /kind\s*:\s*([A-Z_]+_KIND)\b/.exec(args)?.[1]
      const kind = quoted ?? (named ? KIND_CONSTS[named] : undefined)
      if (kind) found.push({ n: lineAt(kept, m.index), finding: `insert kind ${kind}` })
    }
    return found
  }
  const scanned = (): string[] => [
    ...walkFrom(TESTS_DIR, 'tests/', '.steps.ts'),
    ...walkFrom(join(TESTS_DIR, 'journal'), 'tests/journal/', '.ts').filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.steps.ts')),
    ...walkFrom(join(TESTS_DIR, 'helpers'), 'tests/helpers/', '.ts').filter((f) => !f.endsWith('.test.ts')),
    ...walkFrom(join(TESTS_DIR, 'helpers'), 'tests/helpers/', '.cjs'),
  ].filter((f) => f !== HARNESS)
  const names = (src: string): string[] => findingsIn(src).map((x) => x.finding)

  test('the matcher finds every shape of a door act and passes over prose', () => {
    // The anti-vacuity half: each evasion shape a binding could write is
    // found; a comment, a string mentioning the name, a look-alike name and
    // a regex literal are not.
    expect(names("    expect(w.store!.retireLeg(ref, 'cut')).toBe(true)")).toEqual(['retireLeg'])
    expect(names("  w.store!['retireLeg'](ref, 'cut')")).toEqual(['retireLeg'])
    expect(names('  w.store!.retireLeg\n    (ref, "cut")')).toEqual(['retireLeg'])
    expect(names('  w.store!.retireLeg.call(w.store, ref, "cut")')).toEqual(['retireLeg'])
    expect(names('  const r = w.store!.retireLeg.bind(w.store)')).toEqual(['retireLeg'])
    expect(names("import { retireLeg as end } from '../../src/persistence/leg-registry.js'\nend(db, ref, 'cut', 0)")).toEqual(['retireLeg'])
    expect(names('  const msg = `${w.store!.recordSendBack(ref)} sent back`')).toEqual(['recordSendBack'])
    expect(names("  define(/^the \"([^\"]+)\" leg ends$/, (w) => w.store!.registerWorker({ door: 'library' }))")).toEqual(['registerWorker'])
    expect(names("  await w.store!.insert('x', { metadata: { kind: 'first-moment', run: 'r1' } })")).toEqual(['insert kind first-moment'])
    expect(names('  await store.insert(text, {\n    metadata: { kind: SEND_BACK_KIND },\n  })')).toEqual(['insert kind send-back'])
    expect(names("  // the hook calls retireLeg(db, ref) at its stop\n  /* registerWorker( */")).toEqual([])
    expect(names("  const why = 'the retireLeg of a leg, said in prose'")).toEqual([])
    expect(names('  await w.store!.retireLegacy(ref)\n  const reRegisterWorker = 1')).toEqual([])
    expect(names("  define(/^a leg retireLeg\\(s\\) here$/, () => {})")).toEqual([])
    expect(names("  await w.store!.insert('x', { metadata: { kind: 'checkpoint' } })")).toEqual([])
  })

  test('the harness is where the door acts are', () => {
    const inHarness = new Set(names(read(HARNESS)))
    // The library-door stand-ins the bindings use live here, so the scan
    // below has something it would have found elsewhere.
    for (const n of ['registerWorker', 'retireLeg', 'retireWorker']) expect(inHarness, n).toContain(n)
  })

  test('no steps file, journal harness module or test helper stands in for a door outside its allowlist', () => {
    const files = scanned()
    expect(files.filter((f) => f.endsWith('.steps.ts')).length, 'no steps files found').toBeGreaterThan(20)
    expect(files, 'the scan roots').toEqual(expect.arrayContaining(['tests/journal/run-world.ts', 'tests/journal/world.ts', 'tests/helpers/standin-worker.ts', 'tests/helpers/standin-claude-p.ts']))
    const problems: string[] = []
    const used = new Set<number>()
    for (const f of files) {
      const src = read(f)
      const lines = src.split('\n')
      for (const x of findingsIn(src)) {
        const text = lines[x.n - 1]!.trim()
        const k = ALLOWED.findIndex((a) => a.file === f && a.finding === x.finding && a.line === text)
        if (k === -1) problems.push(`${f}:${x.n}: ${x.finding} — ${text}`)
        else used.add(k)
      }
    }
    expect(problems, `a binding stands in for a door's own act; go through a named stand-in in ${HARNESS}, or allowlist the line with its reason`).toEqual([])
    const stale = ALLOWED.filter((_, k) => !used.has(k)).map((a) => `${a.file}: ${a.finding} — ${a.line}`)
    expect(stale, 'stale ALLOWED entries (the line no longer holds the finding — remove them)').toEqual([])
  })
})

describe('a step that says an event is as Claude Code sends it replays a recording', () => {
  // D402: "as Claude Code sends it" is a claim about the far side of the
  // hooks door, and the only evidence the repository holds of it is the
  // recorded sessions under tests/fixtures/claude-code-hooks. A step whose
  // text says a payload or event is as Claude Code sends (or sent) it must
  // be bound by a step definition whose body takes the payload from a
  // recording through the stand-in helpers (`recordedSession` or
  // `replayRecordedSession`, tests/journal/standins.ts), not from a literal
  // in the steps file.
  //
  // What is checked: every step line of every feature file whose text
  // matches CLAIM; the steps files' `reg.define(/…/, …)` whose regex matches
  // that text (one must, so does the executor); and that its body, up to the
  // next `reg.define(`, calls one of the two helpers and that the file
  // imports it from the stand-ins module.
  // Not seen: a claim in other words ("the real payload", "a Claude
  // Code-shaped payload" is in a scenario title, not a step), a step's claim
  // carried by a neighbouring step, what the body does with the recorded
  // event after taking it (a call to the helper beside a hand-written
  // payload would pass), and a definition built from a computed regex.
  const CLAIM = /\bas Claude Code sen(?:ds|t)\b/i
  const HELPERS = /\b(?:recordedSession|replayRecordedSession)\s*\(/

  interface Definition { file: string; regex: RegExp; body: string; imports: boolean }
  const definitionsIn = (file: string, src: string): Definition[] => {
    const starts = [...src.matchAll(/reg\.define\(\//g)]
    const imports = /import\s*\{[^}]*\b(?:recordedSession|replayRecordedSession)\b[^}]*\}\s*from\s*'[^']*standins\.js'/.test(src)
    return starts.flatMap((m, i) => {
      let j = m.index + m[0].length
      let cls = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        else if (src[j] === '/' && !cls) break
        j++
      }
      const source = src.slice(m.index + m[0].length, j)
      const flags = /^[a-z]*/.exec(src.slice(j + 1))![0]
      try {
        return [{ file, regex: new RegExp(source, flags), body: src.slice(m.index, starts[i + 1]?.index ?? src.length), imports }]
      } catch { return [] }
    })
  }
  const stepsFiles = walkFrom(TESTS_DIR, 'tests/', '.steps.ts')
  const definitions = stepsFiles.flatMap((f) => definitionsIn(f, read(f)))
  const claims = featureFiles.flatMap((f) => read(f).split('\n').map((line, n) => ({ f, n: n + 1, line: line.trim() }))
    .filter((x) => /^(Given|When|Then|And|But)\s/.test(x.line) && CLAIM.test(x.line))
    .map((x) => ({ ...x, text: x.line.replace(/^(Given|When|Then|And|But)\s+/, '') })))

  const unreplayed = (cs: Array<{ text: string }>, defs: Definition[]): string[] => cs.flatMap(({ text }) => {
    const bound = defs.filter((d) => d.regex.test(text))
    if (bound.length === 0) return [`${text}: no step definition matches`]
    return bound.filter((d) => !(HELPERS.test(d.body) && d.imports)).map((d) => `${text}: bound in ${d.file} without replaying a recording`)
  })

  test('every such step is bound by a definition that replays a recording', () => {
    expect(claims.length, 'no "as Claude Code sends it" step found: the phrasing the guard reads has moved').toBeGreaterThanOrEqual(2)
    expect(unreplayed(claims, definitions), 'a step says its payload is as Claude Code sends it but its binding does not take it from tests/fixtures/claude-code-hooks').toEqual([])
  })

  test('the matcher is not vacuous: a literal-payload binding is found, a replaying one is not', () => {
    const literal = definitionsIn('x.steps.ts', "reg.define(/^a payload as Claude Code sends it$/, (w) => {\n  w.payload = { tool_response: 'hand written' }\n})\n")
    const replay = definitionsIn('y.steps.ts', "import { recordedSession } from '../journal/standins.js'\nreg.define(/^a payload as Claude Code sends it$/, (w) => {\n  w.payload = recordedSession('2.1.319', 'f.ndjson')[0]\n})\n")
    const claim = [{ text: 'a payload as Claude Code sends it' }]
    expect(unreplayed(claim, literal)).toHaveLength(1)
    expect(unreplayed(claim, replay)).toEqual([])
    expect(unreplayed(claim, [])).toHaveLength(1)
  })
})
