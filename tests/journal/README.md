# Flat-journal charter suite

Product-level BDD spec for the flat journal store, written in owner
language and verified against a **live database**, not by reading source.
Unit-level `.feature` files under `features/design/` pin implementation
details (byte caps, dedup windows, codec framing); this suite pins the
promises the product makes. When the two disagree, this suite wins.

Charter (owner, 2026-07-16): a TypeScript library + MCP server providing a
searchable chat-session journal, so an agent can recall prior-session
context at cold start or after a clear — replacing context compaction as
the recall mechanism and preserving prompt-cache economics. The system
serves **multiple agents**: concurrent sessions, subagents, and worktree
clones journal into namespaces of the same store, isolated by default and
mergeable on purpose (detail h).

## Design stance

This design is the **minimum necessary** to honor the charter, with
extension points placed where evidence says growth actually happens. The
minimalism is earned, not aesthetic: trees (RAPTOR, MemTree, BIRCH-PCA),
the dual-tree + promotion pipeline, and query fusion were each built,
benchmarked, and removed — machinery a single-author chat journal
measurably did not need. What survived is a flat SQLite store with BM25.
The places the dead ends proved we may someday need more are held open as
explicit seams, not speculative code: dense retrieval enters (if ever) as
a fused, opt-in second ranked list (search-modes); embedder tiers swap
behind the provider interface (BM25 | +static | +int8 ONNX — every tier
BM25-anchored); capture accepts any platform's events through the library
surface, with Claude Code as the reference platform; namespaces already
carry the multi-agent story. We know where the extension points go
because we paid to find out where they don't.

## File map

| File | Covers | Charter detail |
| ---- | ------ | -------------- |
| `journal-capture.feature` | What enters the journal: user/tool/agent events, filtering, platform payload shapes, honesty about gaps | a, g |
| `journal-recall.feature` | The core job: cold-start orientation, search, temporal access, full-fidelity export | pitch, e |
| `journal-storage.feature` | SQLite + zstd full journal, preview/index split, retention, budget valve | b |
| `journal-search-modes.feature` | BM25 default, role weights, optional dense+RRF fusion (off by default) | a, c, e |
| `journal-namespaces.feature` | Multi-agent orchestration, worktree isolation, merge | h |
| `journal-media.feature` | Stored descriptions with URI links to pdf/image/video/audio | i |
| `journal-library.feature` | Library API usable without the MCP server | f |
| `journal-agent-surface.feature` | MCP tool descriptions, hooks, AGENTS.md block, skills — the parts the agent reads | g |
| `journal-install.feature` | Installer honesty: detection, dry-run plan, merge-not-clobber, doctor, reversible uninstall | post-charter surface (2026-07-30) |
| `journal-policy.feature` | Trust tiers at the tool surface: read_only / contributor / full | post-charter surface (2026-07-29) |
| `journal-session-echo.feature` | Curated-node session identity healed from hook echoes of MCP inserts | post-charter surface (v2 heal, 2026-08-15) |
| `journal-session-namespace.feature` | Session-keyed namespace annotation ahead of the ppid rung | post-charter surface (§7.8, 2026-08-15) |
| `journal-sidecar.feature` | Pane files on disk beside the store, conformant to ccr's pane contract as written | post-charter surface |

## The scope fence

Declined scope is as load-bearing as accepted scope. The full register —
every option raised, considered, and ruled out, with its why and date —
is **[`OUT-OF-SCOPE.md`](OUT-OF-SCOPE.md)**, maintained as a first-class
artifact: a new ruling that declines or defers something goes on the
fence in the same change that makes the ruling. An agent that finds
itself building a fence entry is off the charter; re-opening one is an
owner decision, made on the fence, not an implementation decision made
in code. Headlines (details and more on the fence): no trees in the
journal, no query fusion, no server-side LLM, dense never a dependency.

## Runner, dialect, and guards

This suite follows the gherkin-node-test philosophy
([`gherkin-node-test` on npm](https://www.npmjs.com/package/gherkin-node-test),
and its Rust sibling): feature files are
the **control layer** — the one artifact the owner reads, audits, and
carries between implementations; everything underneath is regenerable.
The enemy is the false green, so the suite must be structurally unable to
lie about what it checked.

- **Runner (ratified 2026-07-17 as linter-only; switch landed 2026-07-23,
  6ed236f; sole executor corpus-wide since 2026-08-26, bc78987):
  gherkin-node-test 0.11.0 is both linter and executor for the whole
  corpus.** `features.test.ts` runs every `.feature` sitting directly in
  `features/` (the intent tier — the corpus moved out of this directory
  in the 2026-08-25 reorg) through the `gherkin-node-test/vitest`
  adapter; `runFeatures` reads one directory, not a tree, so the design
  tier under `features/design/` is its own runner call in
  `tests/features-design.test.ts` — one directory, one runner file, one
  manifest, which is also why the design tier is one serialized vitest
  file rather than several. The
  parse that lints a file is the parse that runs it. vitest-cucumber,
  which had stayed on as executor for the legacy implementation-pin
  suites, retired when the last of them converted (bc78987). Step
  bodies live in definer modules — `tests/journal/steps/` for this
  tier, `tests/steps/` for the design tier — with the journal tier's
  shared world and wave harnesses beside the runner (see the layout
  note in `features.test.ts`). Each journal feature is typed against
  its OWN world (gnt annotates map entries `Definer<MyWorld>`): a core
  `World` in `world.ts` holding only what its helpers and two-or-more
  waves read, plus one interface per wave — beside its harness
  (`CaptureWorld`, `InstallWorld`, `SidecarWorld`) or at the top of its
  steps file. A step reading a field outside its wave's interface is a
  type error — caught by the `tsc --noEmit` baseline ratchet, not by the
  suite run (vitest's typecheck sees only *.test-d.ts files), so the
  partition is only as guarded as that pass; `feature-guards.test.ts` lints both
  tiers, whichever runner executes them. (The ts-graph suite
  vitest-cucumber also ran left with the code tool, 2026-07-25.)
- **Dialect**: the gherkin-node-test supported subset only — no doc
  strings, no `Rule:`, no i18n, regex step matching. Enforced by the
  guard test over every `.feature` in `features/`, both tiers (it walks
  `tests/` too, which has held no feature file since the 2026-08-25
  reorg — the walk stays so a stray one cannot hide there); this also keeps every
  feature file portable verbatim to gherkin-cargo-test for a future
  N-version port. The pinned gherkin-node-test version is the dialect
  version.
- **Binding ratchet / debt registers**: the debt register is a runner's
  `wip:` list — gnt registers unbound scenarios as visible TODO
  and ratchets the list in both directions (an unbound step outside wip
  fails; a fully bound feature still listed fails). Only the journal
  runner carries one now: the design runner's transitional list shrank to
  empty as the migration closed (bc78987) and the option went with it, so
  every design scenario is bound or the run fails. Whole-feature
  entries additionally cost a written ruling in `wip-register.ts`, which
  the release gate reads. The `wip:` list itself is the live state —
  this README does not snapshot it (a snapshot here rotted once, caught
  by critic pass 2); files that have left it fully bound are noted
  inline where they exit (media 2026-07-23, capture 2026-07-24).
- **Two-parser rule** (adversarial review 2026-07-16) — **retired
  2026-08-26 with the second executor**: while vitest-cucumber ran any
  file, its homegrown parser and gnt's `parseFeature` were different
  parsers over the same text, and the guard test cross-checked scenario
  titles between them. One parser now lints and executes the whole
  corpus, so there is nothing left to cross-check; the guard retired the
  day its checked set went empty (its anti-vacuity assertion was the
  designed retirement signal). The conservative-subset habit it taught
  (no escape sequences in table cells, no exotic placeholders) stays,
  because it keeps every file portable to gherkin-cargo-test.
- **Executor tag hazards** — the vitest-cucumber hazard class (silent
  `@ignore` exclusion; `VITEST_INCLUDE_TAGS` / `VITEST_EXCLUDE_TAGS`
  narrowing a run without a repo diff) retired with that executor, and
  the env-var guard went with it: those variables no longer reach
  anything. On the gnt side the class is smaller by construction:
  `@only` and near-miss tags are rejected loudly by the parser, and
  unknown tags are inert — the `@bug`-only allowlist still applies so an
  inert tag can't accumulate as folklore, and skipping stays a
  wip-register decision, not a tag.

### Guards in place — the inventory

| Guard | Lives in | What it catches |
| ----- | -------- | --------------- |
| Dialect gate | `feature-guards.test.ts` | any file outside the restricted dialect (per `file:line`), unless registered `EXECUTOR_ONLY`; stale register entries fail |
| Spec-quality lints | `feature-guards.test.ts` | `no-then`, `vague-then`, `single-row-outline`, `near-miss-keyword`, `unused-column`, `duplicate-title`; warn-level debt must match `LINT_DEBT` exactly, both directions |
| Orphan binding | `feature-guards.test.ts` | a `.feature` outside every `GNT_RUN_DIRS` directory (no runner discovers it); a registered runner that fails to import the adapter or call `runFeatures`; duplicate basenames that would break the join keys |
| Step-source lint | `feature-guards.test.ts` | unearned-absence shapes (gnt 0.11 `lintStepDefinitionSource`) across the runners, every `*.steps.ts` in both tiers, the journal tier's harness modules, and `tests/helpers/`; unsanctioned or stale `step-lint: allow` markers |
| Tag allowlist | `feature-guards.test.ts` | any tag other than `@bug` or a ruling-id tag `@D<n>` naming a `features/DOCKET.md` entry (the vitest-cucumber env-var guard retired with that executor, 2026-08-26; ruling-id tags admitted at the docket backport, 2026-09-28) |
| Whole-feature WIP rulings | `feature-guards.test.ts` | a whole-feature wip entry without a reasoned, dated ruling in `wip-register.ts`; a ruling whose feature now has a definer; inline bare-string wip entries |
| Step ambiguity | both gnt runners (per feature) | a step matching more than one definition — asserted at suite start, wip or not |
| Unbound-step ratchet | both gnt runners (per feature) | any unbound step outside the `wip:` list (paste-ready failing snippet); stale wip entries; orphaned definer keys |
| Home-sandbox guard | `home-sandbox-guard.test.ts` | a test file touching a home variable outside `helpers/home.ts`'s `redirectHome()`/`sandboxedEnv()`, unless register-exempted with a reason; stale exemptions fail (it caught the mega-runner extraction moving the install probe, in both directions) |
| `@only` / duplicate titles | gnt parser + runner | committed focus and copy-paste titles register as failing tests, never as narrowed runs |

### Known limits — what no guard here can see

- **Binding fidelity is unchecked.** A step body can do something subtly
  different from its sentence and stay green — coverage honesty is not
  meaning honesty. The live-DB verification rule below is the manual
  control; mutation-ratchet / spec-critic tooling is the designated
  future guard (bdd-v2-plan territory).
- **Goodhart-to-green.** An agent optimizing for a green suite can
  satisfy a scenario's letter while missing its point. The owner's review
  of feature-file diffs is the control layer; that is why these files are
  written in owner language and frozen during review.
- **Comments carry no enforcement.** The linter and runner treat `#`
  comments as vacuum, so the rule is: **a comment may explain a step,
  never substitute for one.** A requirement that matters gets a scenario
  (or a fence entry); a comment that states a checkable fact about the
  suite itself ("the guard test enforces X") must be backed by the guard
  it names — a claimed-but-absent guard has already happened once (the
  tag-allowlist claim, caught and implemented 2026-07-23). The
  completeness critic below audits comment claims each pass.
- **Expansion guidance.** A new corpus-wide check belongs in
  `feature-guards.test.ts` as a register-backed ratchet: a violation set,
  a named debt register, and staleness checks in both directions — loud
  on unregistered violations AND on stale exemptions. Per-suite execution
  guards belong in that suite's runner file. Never add an allowlist
  without its staleness check; a register that can rot silently holds a
  door open for nothing.

- **Spec-lint rules** (from the v2 plan, applied at drafting time):
  every scenario has a `Then`; no banned vagueness in `Then` lines
  (*works, correctly, properly, as expected, handles, appropriate*);
  stated thresholds get boundary pairs when the numbers become spec
  (here most numbers are deliberately bench-tunable — the shape is the
  spec, so scenarios pin shapes, not constants).
- **Bug convention**: a discovered defect gets an ordinary scenario
  pinning the *current wrong behavior*, tagged `@bug` (inert tag, grep-able
  register). The fix turns it red, which forces rewriting it as the
  correct-behavior scenario. Deliberately-red spec-ahead-of-code
  scenarios (like the over-budget status signal) are *not* `@bug` — they
  are unbound wip until built.

## Legacy feature-file register

Ruling (owner, 2026-07-16): the charter suite is the living spec. The
pre-existing unit-level `.feature` files are **legacy until earned in** —
nothing is grandfathered. As each charter file is drafted and the code
under it refactored, the overlapping legacy file is either absorbed
(its still-true scenarios rewritten here or explicitly kept as the
implementation-level pin under a charter scenario) or retired. Update
the status column when that happens; never silently duplicate a legacy
scenario in a new file.

| Legacy file | Overlaps charter file | Status |
| ----------- | --------------------- | ------ |
| `features/design/user-prompt-fidelity.feature` | journal-capture | **kept** (absorb pass 2026-07-25): implementation pin under the oversized-event charter scenarios — the 2000-char index cap and full-store/decodable split |
| `features/design/tool-event-fidelity.feature` | journal-capture | **kept** (absorb pass 2026-07-25): implementation pin under capture's trail/treasure scenarios — C4 composition, code-unit boundary, safety-cap tail cut, shield rules, JF-8 degraded staging |
| `features/design/stop.feature` | journal-capture | **kept** (absorb pass 2026-07-25): implementation pin under turn-end capture — transcript-extraction edge cases (no text, missing file, absent path) |
| `features/design/ingestion-fidelity.feature` | journal-capture / journal-storage | **kept** (absorb pass 2026-07-25): implementation pin under honest-timestamps + gap-marker scenarios — chronology, staging byte valve, bounded poison retries, prefix-only dead-letter |
| `features/design/flat-store-dedup.feature` | journal-capture | **kept** (absorb pass 2026-07-25): implementation pin under the dedup charter scenario — window slide, capture-time comparison, curated/auto separation, anchor re-resolution, rebuild-on-reopen |
| `features/design/flat-store-c4-read-view.feature` | journal-recall / journal-storage | **kept** (absorb pass 2026-07-24): implementation-level pin under the charter's C4 scenarios — marker-not-findable, tail-never-leaks-through-window, demotion interplay |
| `features/design/flat-store-conversation-window.feature` | journal-recall | **kept** (absorb pass 2026-07-24): implementation-level pin under the charter's window scenario — W1-W9 mechanics, caps (700/2000), tie-breaks, cross-session bleed |
| `ts/tests/server/query-window-default.feature` | journal-recall | **retired** (absorb pass 2026-07-25): its ten scenarios were executed by nothing while `query-window-default.test.ts` covered every unique pin as plain vitest with mirrored names — the spec now lives in that test's doc header; the charter's window scenario owns the promise |
| `features/design/flat-store-role-weights.feature` | journal-search-modes | **kept** (critic pass 5, 2026-08-01; round-2 review cleared it as a strong suite): implementation pin under the role-weight scenarios — 4×4 attribution matrix, D1 ranking evidence, FG-2 metadata-rewrite attack |
| `features/design/role-weighted-fts.feature` | journal-search-modes | **kept** (critic pass 5, 2026-08-01; hardened by the round-2 R10 fixes): validation and column-filter scenarios now drive `FlatStore.query`, migration probes per-column tails; atomicity scenario pins real mid-table corruption rollback |
| `features/design/fts-dual-cap.feature` | journal-search-modes / journal-storage | **kept** (critic pass 5, 2026-08-01; scoped 2026-07-29 to the frozen-cap legacy tier): implementation pin under the preview/index split |
| `features/design/content-codec.feature` | journal-storage | **kept** (critic pass 5, 2026-08-01; round-2 R8 rewrite): decode contract for flag-0x00 plus the encode-side plain fallback via the `__setZstdCapabilityForTests` seam; NUL fixture verified real |
| `features/design/retention-demotion.feature` | journal-storage | **kept** (critic pass 5, 2026-08-01; rewritten in the round-1 fix wave): the demotion/archive implementation pin under journal-storage's archive-before-shrink scenario |
| `ts/tests/server/code-hints.feature` | (AST-tool track) | **retired** (deleted with the code tool, 2026-07-25 — recover via `pre-deletion-phase` tag) |

Benchmark-harness `.feature` files under `ts/tests/benchmarks/` spec the
measurement instruments, not the product — out of this register's scope.

## The completeness critic

A reviewer can spot a wrong scenario but is structurally bad at spotting
a missing one — and so is the process that drafted the suite. The critic
is therefore a **recurring pass, not a phase that ends**: it runs at
every phase close (a binding wave completed, a review closed, a deletion
finished), before the commit that closes the phase. It asks, per file
and for the suite as a whole:

1. **Missing scenarios** — walk each charter detail and each actor
   (user, agent, subagent, platform, time, failure): is there a behavior
   the file implies but never pins? New rulings since the last pass that
   produced no scenario?
2. **Comment claims** — every comment stating a checkable fact about the
   suite or its guards: does the named guard/scenario exist? (The rule
   above.)
3. **Fence drift** — did any ruling since the last pass decline or defer
   something that isn't on `OUT-OF-SCOPE.md`? Anything being built that a
   fence entry forbids?
4. **Register health** — beyond the automated staleness ratchets: entries
   whose *reason* has expired even though their letter still matches
   (e.g. a wip entry for a feature whose interface has since been built).
5. **Aging gaps** — open items in the project-memory gap audit: still
   open, still relevant, or quietly resolved and unrecorded?

Findings become banked review comments (owner rules) or scenarios/fence
entries (agent applies), in the same change discipline as everything
else. A critic pass that finds nothing is recorded as run — silence and
absence must stay distinguishable.

## Verification rule

A scenario only counts as passing when it has been exercised end-to-end:
real hook payloads (or real MCP calls) in, direct SQLite inspection out.
Reviews that reason about source code without touching the store do not
close a scenario — that method missed `tool_response` four times.
