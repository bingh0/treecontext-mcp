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
import { runFeatures, type Definer, type Registry } from 'gherkin-node-test/vitest'
import { wholeFeatureWip } from './wip-register.js'
import { type SidecarWorld } from './sidecar-world.js'
import { type InstallWorld } from './install-harness.js'
import { type CaptureWorld } from './capture-harness.js'
import { type MediaWorld, mediaDefiner } from './steps/journal-media.steps.js'
import { type LibraryWorld, libraryDefiner } from './steps/journal-library.steps.js'
import { type RecallWorld, recallDefiner, recallNoModelDefiner } from './steps/journal-recall.steps.js'
import { type AgentSurfaceWorld, agentSurfaceDefiner, agentSurfaceSchemaDefiner } from './steps/journal-agent-surface.steps.js'
import { type StorageWorld, storageDefiner, storageRefusalDefiner, storageBudgetDefiner, storageAdditiveBackupDefiner } from './steps/journal-storage.steps.js'
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
const HERE = fileURLToPath(new URL('.', import.meta.url))


// ── Runner ──────────────────────────────────────────────────────────────

runFeatures(join(HERE, '../../features'), {
  'journal-sidecar': sidecarDefiner satisfies Definer<SidecarWorld>,
  'journal-capture': captureDefiner satisfies Definer<CaptureWorld>,
  'journal-media': mediaDefiner satisfies Definer<MediaWorld>,
  'journal-agent-surface': (reg: Registry<AgentSurfaceWorld>) => { agentSurfaceDefiner(reg); agentSurfaceSchemaDefiner(reg) },
  'journal-search-modes': searchModesDefiner satisfies Definer<SearchModesWorld>,
  'journal-library': libraryDefiner satisfies Definer<LibraryWorld>,
  'journal-recall': (reg: Registry<RecallWorld>) => { recallDefiner(reg); recallNoModelDefiner(reg) },
  'journal-storage': (reg: Registry<StorageWorld>) => { storageDefiner(reg); storageRefusalDefiner(reg); storageBudgetDefiner(reg); storageAdditiveBackupDefiner(reg) },
  'journal-namespaces': namespacesDefiner satisfies Definer<NamespacesWorld>,
  'journal-session-echo': sessionEchoDefiner satisfies Definer<SessionEchoWorld>,
  'journal-session-namespace': sessionNamespaceDefiner satisfies Definer<SessionNamespaceWorld>,
  'journal-install': installDefiner satisfies Definer<InstallWorld>,
  'journal-policy': policyDefiner satisfies Definer<PolicyWorld>,
  'journal-reorientation': reorientationDefiner satisfies Definer<ReorientationWorld>,
  'journal-clients': clientsDefiner satisfies Definer<ClientsWorld>,
  'journal-handoff': handoffDefiner satisfies Definer<HandoffWorld>,
  'journal-orchestration': orchestrationDefiner satisfies Definer<OrchestrationWorld>,
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
    ...wholeFeatureWip(),
    // Scenarios added 2026-10-07 to two bound features by the hackathon
    // re-cut (fence: Sanctioned changes, D174/D188/D173/D179/D156);
    // bound at the beta.1 build (D197). The five agent-surface scenarios
    // (D174, D188, D173, D179, D210) bound 2026-10-08 against the live
    // handshake.
    // journal-clients left this list 2026-10-08 at the beta.2 build: the
    // beta.1 set (the matrix D153, tools-only for a copying client D208,
    // the teammate on another agent D152) and doctor per client with the
    // copied-configuration rows (D161, D208) are all bound.
    // journal-handoff left the register 2026-10-08 — fully bound. The
    // beta.1 set (the import rule: marked and counted D151, store-wide
    // identity D164, claims as data D165, the packet's handoff line with
    // skew disclosed D206/D184) bound at beta.1; the beta.2 set (the
    // file-bound export and its head, the summaries-only default, the
    // path door and the shell command: D170, D172, D177, D199) bound at
    // the beta.2 build, chunk 4.
    // ('a stop that asks for a bookmark still captures the response' bound
    // 2026-10-08 with the beta.1 build: the Stop hook captures, then asks.)
    // journal-reorientation left the register 2026-10-08: its references
    // scenario bound with the reverse index of beta.2 (D186, D197).
    // journal-orchestration left this list 2026-10-08 at the last beta.2
    // chunk, fully bound: the subagent's summary and trail (D147, D148),
    // scoped subagent search (D150), the worktree's own self (D167), self
    // registration with server-stamped writers (D190), and the two lane
    // scenarios (D169), rebound on the writer the store stamps from the
    // session registry rather than one the writer claims.
    // journal-capture left the register 2026-08-12 — fully bound. The
    // 'combined harness' the audit predicted existed on both halves:
    // hook subprocesses stage with session_id, the MCP server's
    // ccSessionId option stamps _cc_session_id on the note, and the
    // window COALESCE proves they read as one conversation.
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




