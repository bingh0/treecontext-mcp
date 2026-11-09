/**
 * Journal charter suite — executed by gherkin-node-test's vitest adapter.
 * (Runner switch 2026-07-23; gnt — 0.11.0, the pinned version IS the
 * dialect version — has been sole linter and executor corpus-wide since
 * the executor migration closed 2026-08-26: the parse that lints each
 * file is the parse that runs it, and the two-parser rule is retired.
 * Dialect and spec-quality lints still run corpus-wide in
 * tests/feature-guards.test.ts.)
 *
 * The `wip:` list is this suite's debt register: whole-feature entries are
 * spec-first drafts with nothing bound; scenario-scoped entries hold open
 * exactly the scenarios still awaiting binding or the code they describe.
 * gnt ratchets the register in both directions — an unbound step outside
 * wip fails the suite, and a fully bound entry still listed fails until
 * removed.
 *
 * Binding rule (the verification rule in README.md): steps drive the real
 * library against a real on-disk store, and assertions inspect the SQLite
 * file or the production surface directly — never a mock, never "the code
 * says so".
 *
 * Layout (mega-runner extraction, 2026-08-26): step bodies live in
 * ./steps/, one definer module per feature, mapped here by basename —
 * the same shape as the design tier's tests/features-design.test.ts.
 * What every wave shares sits beside this file: world.ts (the core World
 * interface, T0, the store/MCP helpers), capture-harness.ts (real hook
 * subprocesses), install-harness.ts (the real CLI under a redirected
 * HOME), sidecar-world.ts (panes on disk beside a real store).
 * install-harness-dialects.test.ts is a harness self-test rather than a
 * runner: the install harness reads BOTH wrapper dialects but only ever
 * has batch bodies to read on win32, so that half is graded from fixtures
 * by a plain vitest file that runs on every lane.
 * Combo definers (recall+noModel, agent-surface+schema,
 * storage+refusal) stay composed in the map below, so a feature still
 * has exactly one entry.
 *
 * Worlds (split by usage, 2026-08-27): gnt types each map entry
 * separately — "each feature has its OWN world, and one type" — so no
 * wave sees another wave's fields. world.ts holds only what its own
 * helpers read plus what two or more wave families read; everything else
 * lives with its wave, beside its harness where there is one
 * (CaptureWorld, InstallWorld, SidecarWorld) or at the top of its steps
 * file otherwise. Extension edges are usage, not taxonomy: the five
 * worlds extending CaptureWorld are the five waves that spawn real hook
 * subprocesses, and AgentSurfaceWorld extends InstallWorld because its
 * init scenarios run the real CLI through tcCli.
 *
 * The annotations below are documentation, not the check. Worlds whose
 * fields are all optional are mutually assignable, so `satisfies
 * Definer<XWorld>` cannot fail on its own (verified by mutation). What
 * enforces the partition is each step body's own `w: XWorld` parameter:
 * reading a field outside that wave's interface is a hard TS2339 —
 * verified by mutation. The gate that sees it is `tsc -p tsconfig.json
 * --noEmit` (the per-chunk baseline ratchet), NOT the suite run: vitest's
 * typecheck covers only *.test-d.ts files, and the deletion probe left it
 * green (item-D gate, 2026-08-27). Skip the tsc pass and the partition is
 * unguarded.
 *
 * History: wave 1 bound two @bug scenarios pinning the media
 * accept-and-drop; the 2026-07-23 media fix turned them red on schedule
 * and they were rewritten into the correct-behavior bindings (now in
 * steps/journal-media.steps.ts) — journal-media is the first feature to
 * leave the wip register.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import gnt from 'gherkin-node-test'
import { type Definer, type Registry } from 'gherkin-node-test/vitest'
import { wholeFeatureWip } from './wip-register.js'
import { type SidecarWorld } from './sidecar-world.js'
import { type InstallWorld } from './install-harness.js'
import { type CaptureWorld } from './capture-harness.js'
import { type MediaWorld, mediaDefiner } from './steps/journal-media.steps.js'
import { type LibraryWorld, libraryDefiner } from './steps/journal-library.steps.js'
import { type RecallWorld, recallDefiner, recallNoModelDefiner } from './steps/journal-recall.steps.js'
import { type AgentSurfaceWorld, agentSurfaceDefiner, agentSurfaceSchemaDefiner } from './steps/journal-agent-surface.steps.js'
import { type StorageWorld, storageDefiner, storageRefusalDefiner, storageBudgetDefiner, storageAdditiveBackupDefiner, storageStaleServerDefiner, storageWorkerRowsDefiner } from './steps/journal-storage.steps.js'
import { type SearchModesWorld, searchModesDefiner } from './steps/journal-search-modes.steps.js'
import { installDefiner } from './steps/journal-install.steps.js'
import { type PolicyWorld, policyDefiner } from './steps/journal-policy.steps.js'
import { captureDefiner } from './steps/journal-capture.steps.js'
import { type SessionEchoWorld, sessionEchoDefiner } from './steps/journal-session-echo.steps.js'
import { type SessionNamespaceWorld, sessionNamespaceDefiner } from './steps/journal-session-namespace.steps.js'
import { type NamespacesWorld, namespacesDefiner } from './steps/journal-namespaces.steps.js'
import { sidecarDefiner } from './steps/journal-sidecar.steps.js'
import { type ReorientationWorld, reorientationDefiner } from './steps/journal-reorientation.steps.js'
import { type ClientsWorld, clientsDefiner } from './steps/journal-clients.steps.js'
import { type HandoffWorld, handoffDefiner } from './steps/journal-handoff.steps.js'
import { type OrchestrationWorld, orchestrationDefiner } from './steps/journal-orchestration.steps.js'
import { type RunsWorld, runsDefiner } from './steps/journal-runs.steps.js'
import { type LegsWorld, legsDefiner } from './steps/journal-legs.steps.js'
import { type WorkersWorld, workersDefiner } from './steps/journal-workers.steps.js'
const HERE = fileURLToPath(new URL('.', import.meta.url))

// ── Host skips ──────────────────────────────────────────────────────────
// A scenario whose promise this host's OS cannot keep is SKIPPED here, by
// title and with its reason, never passed hollow: gherkin-node-test has no
// per-platform tag, and an early return inside a step would be green while
// proving nothing. An entry that names no registered scenario fails below.
const HOST_SKIPS: Record<string, string> = process.platform === 'win32' ? {
  // process-probe.ts reads no process start moment on win32 (startMoment
  // returns null): telling a reused process number from the worker needs
  // one. Windows is the host of D317's "a host whose process start moment
  // cannot be read" scenario, which runs here; exists() works on win32,
  // so a dead worker is still a phantom.
  "a reused process number is told from the worker by the process's start moment": 'win32: no process start moment (process-probe.ts)',
  'a live worker with its own start moment stays live': 'win32: no process start moment (process-probe.ts)',
  "a worker's re-run for its missing checkpoint is the same leg in the same lane": 'win32: the scenario asserts each process carries its start moment (process-probe.ts)',
} : {}
const hostSkipped = new Set<string>()
type TestFn = (name: string, fn: () => unknown) => unknown
const hostTest = Object.assign((name: string, fn: () => unknown): unknown => {
  const hit = Object.keys(HOST_SKIPS).find((sc) => name.endsWith(` :: ${sc}`))
  if (hit === undefined) return (test as unknown as TestFn)(name, fn)
  hostSkipped.add(hit)
  return (test.skip as unknown as TestFn)(`${name} [host skip: ${HOST_SKIPS[hit]}]`, fn)
}, { skip: test.skip, todo: test.todo })
const { runFeatures } = gnt.bindRunner(hostTest) as { runFeatures: typeof import('gherkin-node-test/vitest').runFeatures }


// ── Runner ──────────────────────────────────────────────────────────────

runFeatures(join(HERE, '../../features'), {
  'journal-sidecar': sidecarDefiner satisfies Definer<SidecarWorld>,
  'journal-capture': captureDefiner satisfies Definer<CaptureWorld>,
  'journal-media': mediaDefiner satisfies Definer<MediaWorld>,
  'journal-agent-surface': (reg: Registry<AgentSurfaceWorld>) => { agentSurfaceDefiner(reg); agentSurfaceSchemaDefiner(reg) },
  'journal-search-modes': searchModesDefiner satisfies Definer<SearchModesWorld>,
  'journal-library': libraryDefiner satisfies Definer<LibraryWorld>,
  'journal-recall': (reg: Registry<RecallWorld>) => { recallDefiner(reg); recallNoModelDefiner(reg) },
  'journal-storage': (reg: Registry<StorageWorld>) => { storageDefiner(reg); storageRefusalDefiner(reg); storageBudgetDefiner(reg); storageAdditiveBackupDefiner(reg); storageStaleServerDefiner(reg); storageWorkerRowsDefiner(reg) },
  'journal-namespaces': namespacesDefiner satisfies Definer<NamespacesWorld>,
  'journal-session-echo': sessionEchoDefiner satisfies Definer<SessionEchoWorld>,
  'journal-session-namespace': sessionNamespaceDefiner satisfies Definer<SessionNamespaceWorld>,
  'journal-install': installDefiner satisfies Definer<InstallWorld>,
  'journal-policy': policyDefiner satisfies Definer<PolicyWorld>,
  'journal-reorientation': reorientationDefiner satisfies Definer<ReorientationWorld>,
  'journal-clients': clientsDefiner satisfies Definer<ClientsWorld>,
  'journal-handoff': handoffDefiner satisfies Definer<HandoffWorld>,
  'journal-orchestration': orchestrationDefiner satisfies Definer<OrchestrationWorld>,
  'journal-runs': runsDefiner satisfies Definer<RunsWorld>,
  'journal-legs': legsDefiner satisfies Definer<LegsWorld>,
  'journal-workers': workersDefiner satisfies Definer<WorkersWorld>,
}, {
  manifest: join(HERE, '../../run-manifest.ndjson'),
  wip: [
    // Seven of nine scenarios bound 2026-08-01 (round-2 register audit,
    // Tier 3) — including the two the audit predicted would bind red
    // (single-entry merge, provenance stamp); the R3/F5 fixes landed
    // first, so they bound green.
    // journal-namespaces left the register 2026-08-12 — fully bound.
    // The capture-side blocker was one namespace option on the world's
    // store open; provenance filter/weight bound against the server
    // with a demonstrated baseline reorder.
    // journal-install left the register 2026-08-03 — fully bound against
    // the real CLI in a redirected HOME, and (for the boundary scenarios)
    // against the agent's own config reader, the OS's interpreter lookup,
    // and the linked command a user actually types. The binding wave
    // falsified two clauses that had read true as prose: per-agent failure
    // isolation, and doctor's fix commands being ones that clear the
    // finding they are printed for.
    // Whole-feature entries live in wip-register.ts, where each one costs a
    // written ruling and the release gate can see it. A bare string here
    // would be an entire unbound surface with nobody having decided that is
    // acceptable — which is how 0.0.9-beta shipped.
    // The beta.3 subagent cut's three surfaces (journal-legs,
    // journal-workers, journal-runs) are whole-feature rulings in
    // wip-register.ts, partly bound by unit 1 on 2026-11-01: each ruling
    // carries the scenarios still unbound, with the unit that owns each.
    ...wholeFeatureWip(),
    // The beta.3 subagent cut (2026-10-31): scenarios added to bound files
    // by the scope run, unbound until their build (D295, D319). Scenario-
    // scoped so the rest of each file keeps gating. journal-install's
    // idle-compaction scenarios (D290, D304, D338) bound with unit 8 and
    // left this list, but one: the 2.1.295 scenario's install clause asked
    // for a line of a run where the key was already on, which D361 rules
    // out. The owner split it at the final gate (2026-11-01, D367): the key
    // absent at 2.1.295 is written off naming the settings line and no
    // /config row; the key on at 2.1.295 is doctor's settings-line-only row.
    // Both halves bind, and the file has no open scenario.
    // journal-workers left the whole-feature register 2026-11-01 (unit 4).
    // The D288 parent outline's Antigravity row, held open here by the
    // outline's title until the owner ruled, was removed on 2026-11-09
    // (owner, "Adopt all (Recommended)"; the fence's Antigravity CLI entry,
    // D370 amended by D383): an agy main registers no parent, and its case
    // moved to the D294 declared-parent outline below. The outline's Claude
    // Code and Codex rows bind, and its entry left this list.
    // The headless build's unit 5 (D384, D389) bound its five scenarios on
    // 2026-11-08, through both spawners, and they left this list.
    //
    // The seven rulings of 2026-11-09 (D391-D398; fence: Sanctioned
    // changes, "The seven rulings of 2026-11-09"): new and reworded
    // scenarios, unbound until the unit that owns each: unit 7a the store
    // and the export (D391 curated dedup and lanes, D398 the skeleton's
    // error-tail line), unit 7b the doors and the hooks (D382's fourth row,
    // D393 the cut's process group, D397 the error stream kept open, the
    // D294 outline). Scenario-scoped so the rest of each file keeps gating.
    // The reworded scenarios' old step definitions were deleted with no
    // consumer left; their units rebind them.
    {
      feature: 'journal-workers',
      scenarios: [
        // Unit 7a: D391 (a worker's curated dedup is its own lane's).
        'a <second> writing the same text as <first> leaves its own row in its own lane',
        // Unit 7b: D294 (the @D294 scenario reworded into an outline with
        // Codex CLI and Antigravity CLI mains spawning through
        // `treecontext run --parent --parent-cli`), D393 (a real grandchild
        // in the worker's process group), D397 (a real background process
        // holding the worker's error stream).
        'a parent no hook registered, a <main> main, is carried on each worker\'s registration as declared, never as a row of its own',
        'a worker ended by <signal> leaves no process of its group running',
        'a background process the worker left writing to its error stream is not cut off when the run settles',
      ],
    },
    {
      feature: 'journal-orchestration',
      scenarios: [
        // Unit 7a: D391 (a hit's reply names the survivor's writer and
        // lane; a hit arms no other lane's pointer).
        "a dedup hit's reply names the surviving row's writer and lane and says nothing landed in the caller's",
        "a dedup hit never arms another lane's resume pointer",
      ],
    },
    {
      feature: 'journal-session-echo',
      scenarios: [
        // Unit 7a: D391 (two @D86 scenarios reworded to sessions of one
        // lane, their Givens' old step definitions deleted).
        'a dedup-hit echo cannot re-stamp the older original',
        'identical concurrent inserts from two sessions of one lane disclose their ambiguity',
      ],
    },
    {
      feature: 'journal-runs',
      scenarios: [
        // Unit 7a: D398 (the skeleton's reply names the legs whose summary
        // row holds the end of an error stream).
        'the export\'s reply names the legs whose summary row carries the end of an error stream, and no other',
      ],
    },
    {
      feature: 'journal-agent-surface',
      scenarios: [
        // Unit 7b: D382's fourth row, tagged @D291 (the send-back's re-run,
        // read on the re-run's own first message through the real door);
        // the outline's three bound rows wait with it, held by its title.
        'the first message the ticket door composes for <case> opens with the line the block names',
      ],
    },
    // The headless build (2026-11-07, D381-D390; fence: Sanctioned changes,
    // "The headless build"): scenarios added to bound files and five bound
    // scenarios reworded, unbound until the unit of the draft's build plan
    // that owns each (unit 1 convergence and capture mode, unit 2 tool
    // approvals and doctor's Codex rows, unit 3 Antigravity CLI, unit 4
    // orientation, unit 6 documentation). Scenario-scoped so the rest of
    // each file keeps gating. The reworded scenarios' old step definitions
    // were deleted with no consumer left; their units rebind them.
    // journal-install left the register 2026-11-08 with unit 3 (D383):
    // unit 1 bound D385 and D386, unit 2 D381 and D390 for Codex CLI and
    // Claude Code, and unit 3 Antigravity CLI, the rows of the D386 and
    // off-and-on outlines that named it, the install message and the
    // `--no-tool-approvals` scenario whose Given names it, and the @D51
    // uninstall scenario reworded for the permission rules.
    // journal-agent-surface left this list 2026-11-08 with unit 4 (D382):
    // the @D8 scenario's new Then and the four worker scenarios bind.
    // journal-clients left this list 2026-11-08 with unit 6 (D388): the
    // README's headless-workers section and the matrices' permission modes
    // bound, the last of its open scenarios.
    // The main checkout's own lane (D372-D376, D378, 2026-11-02) left this
    // list with the main-lane build: the pre-stamp door's four scenarios
    // and the @D376 scenario's added Then bound with unit U3b.
    // The driver switch, D278 (2026-10-11): three @D51 install scenarios
    // reworded from "loads the native database binding" to "meets the Node
    // floor and runs this package" (fence: Sanctioned changes, 2026-10-11)
    // kept their bindings through the build; the two @D278 doctor rows and
    // the @D278 storage scenario sat here from the charter commit (c227c81)
    // until the chunk-1 build landed node:sqlite the same day, and left the
    // register with it — bound against doctor's real report, the manifest
    // and the lockfile's production tree.
    {
      feature: 'journal-search-modes',
      scenarios: [
        // Dense has no path in this build — stays open until the tier
        // ladder's bench gate ever admits it (see the fence).
        'dense fusion is an explicit opt-in that fuses, never replaces',
        // Unbindable until dense exists: no code reads a model path, so
        // "installed and reachable" cannot be established for real. The
        // old binding was vacuous (adversarial review 2026-07-31, F3).
        'a present embedding model changes nothing until asked',
      ],
    },
    // journal-capture left the register 2026-07-24 — fully bound (the
    // skipTools filter fell to the charter in the same change).
    // journal-storage left the register 2026-08-12 — fully bound; the
    // durability family closed in one wave (notes below).
    // (The archive/tombstone family bound 2026-07-24 when the valve
    // learned to archive.)
    // 'a store that cannot get under budget says so' left the
    // register 2026-08-12. The audit was right that no machinery was
    // missing: the binding drives all three protection classes
    // (authorship, decay_exempt, newest-session) past the byte
    // budget, proves the sweep reclaims nothing, and asserts the
    // condition at both surfaces — status().retention and the MCP
    // panel's storage_warning.
    // 'frequently relied-on history evicts last' left the register
    // 2026-08-12 — the one durability bind that was FEATURE work,
    // built to the 2026-07-23 ruling: exportJson's single-entry
    // branch records _relied_count (whole-journal exports are
    // backup, never reliance), retentionSweep orders eviction by
    // (reliance ASC, latest ASC) with the newest session outside
    // the order entirely. Zero reliance data reproduces the old
    // oldest-first order exactly, which is why every previously
    // bound eviction scenario passed unchanged.
    // 'a crash mid-write never corrupts the store' left the register
    // 2026-08-12 — the predicted "one SIGKILL subprocess script" was
    // exactly right: tests/helpers/crash-writer.cjs hammers atomic
    // staging+nodes pairs under production pragmas and dies
    // mid-stream; the binding then proves integrity, pair atomicity,
    // and that no REPORTED commit was lost.
    // 'concurrent sessions do not corrupt each other' left the
    // register 2026-08-12. The "subprocess harness" was one CJS
    // helper: the second session takes its lock refusal from the
    // real O_CREAT|O_EXCL primitive on the real lockfile path,
    // stages 40 captures hook-style while the writer ingests
    // interleaved, and the drain proves 40-of-40 landed — none lost,
    // none doubled.
    // 'a poison event cannot wedge ingestion' left the register
    // 2026-08-06. The register was right that no machinery was
    // needed: ingestion-fidelity's trigger-based fault injection
    // covered it, and the retirement-ordering clause only needed a
    // fault whose blast radius includes the dead-letter record
    // itself — which the capture-gap node earns for free by quoting
    // a prefix of the content that failed.
    // 'schema changes never eat a store' left the register 2026-08-05.
    // Its reason ("needs a migration harness") turned out to need no
    // harness at all: the real migration bodies replay onto an empty
    // database to build a genuine old store, which beats any fixture
    // snapshot because it cannot drift from the migrations it stands in
    // for. Binding it found that a pending DESTRUCTIVE migration gates
    // every pending ADDITIVE one too, and that since #19 landed no
    // pre-current store has an additive-only pending set — so the
    // charter's "additive run automatically" reading is unreachable for
    // every real store. Left as an owner question, not silently blessed.
    // journal-media left the register 2026-07-23 — fully bound.
    // journal-library left the register at critic pass 4 (2026-07-26):
    // its wip reason ("needs an in-process MCP server harness") expired
    // when the search-modes wave built mcpOver, and the last three
    // scenarios bound in the same pass.
    // journal-recall left the register 2026-08-12 — fully bound. The
    // latency probe bound with injected timings exactly as the audit
    // predicted (zero sleeps), and the index-cap knob bound through the
    // real hook route (env → subprocess → staging.index_len → FTS view),
    // floor rejection included.
    // (The broad-query scenario bound 2026-08-01 when the owner ruled
    // recency on by default at 0.5 — the ruling banked at critic
    // pass 4.)
    // The latency panel ships and CreateServerOptions.sessionStats is
    // a documented production seam — the register audit's probe bound
    // the count≥5 && mean>250ms hint with zero sleeps by injecting
    // recorded timings. Its old "needs a deterministic slowness
    // harness" reason went stale 2026-07-31; the scenario is bound and
    // manifest-passed (this note's "awaiting binding" tail outlived its
    // own resolution — corrected by audit run 1).
    // Renamed by the index-cap-expansion wave (the old titles were
    // 'a very long conversational message is findable by its beginning
    // and its end' — now bound under its new any-of-its-words name —
    // and 'full indexing of conversational text is a configuration
    // choice'). The knob scenario's machinery (TREECONTEXT_INDEX_CAP,
    // covered by tests/hooks/index-cap-expansion.test.ts) is bound
    // in-registry too, through the real hook route — the "no binding
    // yet" tail here was stale against the manifest (audit run 1).
    // 'recall needs no embedding model' bound at critic pass 3 — the
    // deletion phase made it checkable in-process (no embedder exists
    // to accidentally load).
    // journal-agent-surface left the register 2026-08-12 — fully bound.
    // (Channel comparison bound 2026-08-01: the owner admitted the
    // session-start reminder to the charter surface — it already
    // taught the protocol via SESSION_REMINDER_TEXT and its drift
    // test; the charter binding adds the live-handshake surface.)
    // 'installing the AGENTS.md block twice yields one block' left
    // the register 2026-08-12, CLI-driven as the note asked: the
    // real init subprocess, a stale block updated in place around
    // surviving hand-written prose, and a third run announcing the
    // fixed point.
    // ('tool schemas describe only what the backend does' bound with
    // the search-modes wave, 2026-07-26.)
  ],
})





test('every host skip names a scenario this run registered', () => {
  expect(Object.keys(HOST_SKIPS).filter((sc) => !hostSkipped.has(sc))).toEqual([])
})
