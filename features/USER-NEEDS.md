# USER-NEEDS.md — treecontext

*The needs ledger. Added 2026-08-25 as a **post-hoc characterization
distillation**: this repo predates its own ledger. The corpus was born in
the early-scope era (v2-era skill, before ledgers and design docs existed)
and was bound onto an existing implementation by hand; everything below is
reconstructed from the ratification record the intervening months left
behind — the charter (2026-07-16), the two fences' dated rulings,
DESIGN.md, docs/release-charter-0.1.md, and the feature corpus itself.
Method note: the ratification layer is primary evidence; design-tier
features corroborate; implementation code is used only for discrepancy
detection, never as a source of need (a behavior the code exhibits but
nothing ratified is a decision point, not a need).*

**Status: provisionally ratified 2026-08-25; rulings cited per row and rows N18–N22 added at the docket backport of 2026-09-28; rows N23–N26 and the hackathon interview's ruling citations added 2026-10-07 (see `features/DOCKET.md`)** ("ok on weights for now,
proceed") — the H/M/L weights below stand as drafted, revisitable at
review rather than final; corrections remain Phase-2-style readback
material. Per the standing contract, at build time only the feature
files bind; this ledger explains and prioritizes, it never specifies. A
`partial` or `absence` status is a recorded stopping point, not debt.

Evidence conventions: "fence" = `OUT-OF-SCOPE.md` (Part 1 = charter,
Part 2 = migration-backup corpus); scenario coverage names files under
`features/` and `features/design/`.

---

## The needs

- **N1 — Cold-start orientation.**
  "When I start a session — or survive a context clear — I can recover what
  I was working on and what comes next by asking, instead of re-deriving it;
  my prompt cache stays warm because orientation is one query."
  Beneficiary: the working agent (and the operator, through token economics).
  Weight: **H** — the product's reason to exist.
  Evidence: charter pitch (2026-07-16); DESIGN.md §What-it-is.
  Rulings: D2, D113, D145, D146, D156, D158, D159, D162, D166, D173, D183, D185, D187, D188, D198.
  Coverage: `scenario` — journal-recall, journal-search-modes, flat-store-conversation-window.

- **N2 — Honest silence.**
  "I trust what the journal does NOT show as much as what it shows: dropped
  or failed captures leave visible gap markers, nothing is filtered
  silently, and retention refuses rather than loses."
  Beneficiary: agent; operator (auditability).
  Weight: **H** — without it recall lies.
  Evidence: charter detail g; fence §Capture; DESIGN.md load-bearing decision 2.
  Rulings: D118, D171, D175, D179.
  Coverage: `scenario` — journal-capture, ingestion-fidelity, journal-storage, retention-demotion.

- **N3 — Automatic capture, every platform.**
  "What happened in my session enters the journal without anyone curating
  it, on whatever platform I work in that day."
  Beneficiary: agent; operator.
  Weight: **H** for the mechanism, with an honest boundary.
  Evidence: charter detail a; fence §Capture-and-platforms (unverified adapters
  stay unadvertised until each earns a live-payload verification pass).
  Rulings: D3, D16, D29, D30, D58, D119, D152, D153.
  Coverage: `partial` — Claude Code is the verified reference platform
  (journal-capture; the Claude Code hooks in `src/hooks/*.ts`, pinned by
  `features/design/tool-event-fidelity.feature`,
  `features/design/user-prompt-fidelity.feature` and
  `features/design/stop.feature` — revised 2026-10-08, this line first
  read "hooks/*", which names no feature path); copilot ships opt-in preview
  (release-charter §3); other adapters fenced pending verification.

- **N4 — Lexical honesty in ranking.**
  "Search ranks by the words actually written — role-weighted so my
  directives outrank my tools' chatter — and when nothing distinguishes the
  candidates, the newest thread wins; I can always turn recency off and get
  pure BM25."
  Beneficiary: agent.
  Weight: **H**.
  Evidence: owner ruling 2026-08-01 (recency default 0.5, explicit 0 opts
  out); fence §Retrieval (reference-frequency never; score fusion declined
  on measurement).
  Rulings: D5, D6, D18, D21, D41, D44, D47, D54, D56, D183.
  Coverage: `scenario` — journal-search-modes, role-weighted-fts, flat-store-role-weights.

- **N5 — Many agents, one store, deliberate contact.**
  "My concurrent sessions, subagents, and worktree clones journal into
  namespaces of one store — isolated by default, mergeable on purpose, and
  the merge never destroys either side."
  Beneficiary: operator running agent fleets.
  Weight: **H**.
  Evidence: charter detail h; amendment-8 ruling 2026-08-20 (same-namespace
  servers serve alongside; writer safety lives in store constraints).
  Rulings: D9, D78, D80, D81, D96, D97, D110, D148, D149, D151, D164, D165, D167, D169, D170, D180, D184, D186, D196, D199.
  Coverage: `scenario` — journal-namespaces, stores-merge, store-as-arbiter.

- **N6 — The journal survives the project's own history.**
  "Renaming, gaining a remote, changing URL form, or working in a worktree
  never silently orphans my journal; succession is announced, ambiguity
  fails closed, and past splits are detectable and repairable without data
  loss."
  Beneficiary: operator.
  Weight: **H** — born from a field defect, ruled in full (2026-08-16).
  Evidence: docs/project-identity.md (implemented program); node 60432cf2/7e74a334 rulings.
  Rulings: D92, D93, D116, D167, D180, D181, D190.
  Coverage: `scenario` — store-bindings, stores-merge, backup-lifecycle (verdicts).

- **N7 — Retention shrinks, never destroys.**
  "Under storage pressure the journal archives whole sessions to disk before
  deleting anything, refuses to evict what it cannot archive, never touches
  the newest session, and evicts least-relied-on history first."
  Beneficiary: operator.
  Weight: **M-H**.
  Evidence: fence §Storage (per-entry eviction declined 2026-07-23); DESIGN.md decision 2.
  Rulings: D22, D23, D25, D36, D40, D48, D49, D55.
  Coverage: `scenario` — journal-storage, retention-demotion, fts-dual-cap.

- **N8 — Local, private, and quiet about it.**
  "Everything stays on this machine in modes the OS enforces; there is no
  network surface; telemetry is counts-only unless I explicitly opt in; logs
  never contain message bodies; sharing surfaces redact."
  Beneficiary: operator.
  Weight: **H** — a journal of work sessions is privileged by definition.
  Evidence: DESIGN.md trust model; docs/security.md; fence §Media (byte
  storage never).
  Rulings: D28, D77, D91, D114.
  Coverage: `scenario` — telemetry-privacy, debug-log-sharing, output-shielding, config-file.

- **N9 — Wiring that asks permission and undoes itself.**
  "Install detects what exists, shows a dry-run plan, merges rather than
  clobbers my own prose, and doctor diagnoses honestly with fix commands;
  uninstall reverses the wiring and never the record."
  Beneficiary: operator.
  Weight: **M**.
  Evidence: release-charter §1 (post-charter surface, 2026-07-30).
  Rulings: D51, D53, D57, D104, D115, D120, D154, D161, D175, D181.
  Coverage: `scenario` — journal-install, hook-dispatch, doctor tests.

- **N10 — One truth, two consumers.**
  "A program that wants a memory but not an agent gets the same journal
  through the library that the MCP server serves — same results for the
  same query and knobs."
  Beneficiary: tool builders.
  Weight: **M**.
  Evidence: charter detail f.
  Rulings: D7, D199.
  Coverage: `scenario` — journal-library.

- **N11 — Attachments by reference, findable by description.**
  "A pdf/image/video/audio attachment becomes a searchable entry carrying
  its URI and my description of it — the bytes stay out of the store."
  Beneficiary: agent.
  Weight: **L-M**.
  Evidence: charter detail i; fence §Media (event-not-asset framing).
  Rulings: D10, D26.
  Coverage: `scenario` — journal-media.

- **N12 — Dangerous operations leave evidence.**
  "Destructive migrations back up while store and backup are twins and
  record a completion verdict; the sweep deletes only verified backups;
  nothing automatic ever deletes what might be the last copy."
  Beneficiary: operator.
  Weight: **H** — data loss here is unrecoverable.
  Evidence: fence Part 2 (2026-08-06 through 2026-08-15 amendments);
  verdict-record design note.
  Rulings: D59, D60, D61, D62, D64, D65, D69, D70, D71, D72, D83, D84, D87, D88.
  Coverage: `scenario` — backup-lifecycle, backup-sweep, backup-visibility, stores-list, stores-merge.

- **N13 — The corpus is load-bearing (the aBDD requirement).**
  "The feature suite structurally cannot lie about what it checked — one
  parser where possible, ratcheted debt registers, guards over the whole
  corpus — so the spec remains the artifact the human audits instead of the
  code."
  Beneficiary: the owner-as-visionary; downstream agents building on the repo.
  Weight: **H** — this is the methodology's home test bed.
  Evidence: journal README §Runner-dialect-guards; ARCHITECTURE invariants index.
  Rulings: D15, D17, D31, D34, D74, D79, D101, D106, D121, D188, D192, D194, D195, D197, D200, D201, D202.
  Coverage: `structural` — feature-guards.test.ts and the runner/guard
  machinery; partially scenario-pinned via binding-ratchet contracts in the
  gnt exemplar.

- **N14 — The agent teaches itself the protocol.**
  "The surfaces the agent reads — tool descriptions, session-start reminder,
  AGENTS.md block — describe only what the backend does and carry enough
  protocol that a cold agent uses the journal correctly unprompted."
  Beneficiary: agent.
  Weight: **M**.
  Evidence: charter detail g; fence §Server-side-LLM (instructions must not
  advertise tree-era checkpoint or summarize machinery; the agent-written
  checkpoint, a bookmark or a chapter summary, is taught, not advertised
  machinery — revised 2026-10-08 under D215's amendment of D14, the line
  first read "must not advertise checkpoint machinery").
  Rulings: D8, D14, D39, D43, D174.
  Coverage: `scenario` — journal-agent-surface.

- **N15 — Tool surfaces sized to trust.** *(ratified 2026-08-27)*
  "When I hand my store to a lesser-trusted agent, the tools its tier
  excludes are absent, not refused — a reader cannot be talked into
  writing on either face, a contributor adds but never removes, and
  reliance recording stays a full-tier privilege."
  Beneficiary: operator sharing one store across agents of unequal trust.
  Weight: **M**.
  Evidence: DESIGN.md §Two-consumption-modes (the policy gate named as
  part of the server's shape); release-charter §1 MVP inventory
  (Namespaces & policy row); release-charter §2 reliance rule
  (full-policy-only exports record).
  Rulings: D50, D82.
  Coverage: `scenario` — journal-policy.

- **N16 — The journal shows itself filling.** *(ratified 2026-08-27)*
  "I can see on screen, live, whether capture is landing or silently
  failing — through a pane that is pure data: the renderer never runs
  treecontext's code, stale health never reads as an all-clear, and
  treecontext offers to write the wiring itself because a reader that
  survives a typo by drawing nothing makes every mistake invisible."
  Beneficiary: operator (most acutely the newcomer verifying wiring — the
  closed beta's macOS/Windows testers got zero panes by hand-naming paths).
  Weight: **M**.
  Evidence: post-charter surface (journal README coverage table — NOT a
  charter detail; the feature header's former "(h)" citation was drift,
  corrected by ruling 2026-08-27); ccr docs/PANE-CONTRACT.md v1 (consumer
  contract); the beta-failure ruling that pulled auto-wiring into rc.3
  (2026-08-24).
  Rulings: D98, D102.
  Coverage: `scenario` — journal-sidecar.

- **N17 — Attribution earned, never guessed.** *(ratified 2026-08-27)*
  "Every journal row ends up attributed to the exact session that made it
  when evidence exists — the store's own capture echoing its tool calls —
  and degrades honestly when it doesn't: a guess never outranks evidence,
  never publishes a namespace, and a missing echo never invents an id."
  Beneficiary: operator reconstructing conversation threads across
  concurrent sessions; the agent (windows and anchors it can trust).
  Weight: **M-H** — attribution was the ruled *condition* for
  relaxing the same-namespace refusal ("as long as concurrent writers is
  safe, with clear attribution", 2026-08-20), so this need is load-bearing
  for N5's concurrency posture.
  Evidence: docs/session-identity.md §7 (echo-correlated identity, ruled
  2026-08-14, implemented 2026-08-15); §7.8 namespace channel re-affirmed
  by owner ruling 2026-08-20; amendment-8 ruling (attribution as the
  concurrency condition).
  Rulings: D86, D90, D94, D95.
  Coverage: `scenario` — journal-session-echo, journal-session-namespace.

- **N18 — Every row stands on its own.** *(recorded 2026-09-23, attribution program, interview open)*
  "Each row stands on its own for traceability: who wrote it, when it was
  written, how it was written, journal hook or manual insert, and under
  what situation, main project, subagent, worktree, or any other."
  Beneficiary: operator.
  Weight: **H**.
  Evidence: docs/proposal-attribution-2026-09-24.md §2; review findings node a85c6b3c.
  Rulings: D122, D123, D126, D191, D193.
  Coverage: `absence` — scenarios follow the interview. Revised
  2026-10-08, checked and kept: the writer stamp shipped with the
  self-registration build and journal-orchestration's writer scenarios
  exercise it, but no scenario cites a ruling that serves N18.

- **N19 — Every touch is recorded.** *(recorded 2026-09-23)*
  "Every touch of an entry is recorded, searched, read, and by whom,
  because more data is better forensics later."
  Beneficiary: operator.
  Weight: **M**.
  Evidence: proposal §2; owner note (a) of 2026-09-23.
  Rulings: D125, D128.
  Coverage: `absence`.

- **N20 — A subagent searches its own space.** *(recorded 2026-09-23)*
  "A subagent can search only its own space, its journal and its manual
  entries, while the whole store stays open to it."
  Beneficiary: agent.
  Weight: **M-H**.
  Evidence: proposal §2; beta feedback round one (the orchestration platform's developer, Q1 and Q2).
  Rulings: D124, D127, D129, D150, D167, D169, D196.
  Coverage: `scenario` — journal-orchestration, its scenarios tagged
  D148, D150, D167, D169 and D190, each of which serves N20. Revised
  2026-10-08: this line read `absence` until the orchestration build
  bound those scenarios.

- **N21 — The hand-back is findable.** *(recorded 2026-09-23)*
  "When a worktree is folded back, the subagent's summary of its work
  exists and is findable by search."
  Beneficiary: agent.
  Weight: **M**.
  Evidence: proposal §2 and §3.5; hook probe of 2026-09-25 (node bfa3af9c).
  Rulings: D147, D169.
  Coverage: `scenario` — journal-orchestration, its scenarios tagged
  D147 and D169, each of which serves N21. Revised 2026-10-08: this line
  read `absence` until the orchestration build bound those scenarios.

- **N22 — Subagents are findable as a group.** *(recorded 2026-09-23)*
  "A group of subagents doing related work, such as a cybersecurity set,
  can be found as a group without each being its own namespace."
  Beneficiary: operator.
  Weight: **M**.
  Evidence: proposal §2 and §3.6; owner note (f) of 2026-09-25.
  Rulings: D168.
  Coverage: `absence`.

- **N23 — The hackathon team's memory.** *(recorded 2026-10-05, hackathon re-cut interview)*
  "I need treecontext, within one week, to be the memory of a junior
  four-person hackathon team on macOS working the full aBDD toolchain
  through Claude Code: installable publicly, learnable from clear
  instructions, and reliable through a multi-day scoping prep and a
  day-long sprint of /clear-driven work, with cheap re-orientation after
  every clear, one set of mechanisms, hook-driven and tool-driven alike,
  serving both handoff between teammates and orchestration of subagents,
  and no show-stopper bugs in capture, resume, or handoff, so that the
  aBDD stack gets its first small-team stress test."
  (Revised 2026-10-08: "day-long sprint" is the docket's ratified
  wording of N23; this quote first read "24-hour sprint".)
  Beneficiary: hackathon-developer.
  Weight: **H** (5).
  Evidence: D145, D146, D147, D148, D149, D150, D151, D152, D153, D154, D155, D156, D157, D158, D159, D160, D161, D162, D163, D164, D165, D166, D167, D168, D169, D170, D171, D172, D173, D175, D176, D177, D178, D180, D183, D184, D185, D186, D187, D188, D189, D190, D191, D192, D193, D194, D197, D198, D199, D201, D202 — the root of the interview; three corrections before the yes (handoff and orchestration as one set of mechanisms, hooks and tools alike; the stack named as the environment).
  Rulings: D155.
  Coverage: `scenario` — journal-reorientation, journal-orchestration, journal-handoff, journal-clients; the other four stack tools are out of reach by construction and sit on the fence.

- **N24 — The novice is carried.** *(recorded 2026-10-05)*
  "I need treecontext to carry a developer who never learned its
  workflow, no resume pointer, no supersedes, no namespace, through a
  /clear and a handoff without losing their place."
  Beneficiary: hackathon-developer.
  Weight: **H** (4).
  Evidence: D146, D156, D157, D158, D159, D162, D163, D166, D167, D174, D185, D187, D198 — the visionary's "imagine 3/4 are new users"; the stop-hook bookmark and the once-a-day nudge are its means.
  Rulings: D155.
  Coverage: `scenario` — journal-reorientation, journal-agent-surface.

- **N25 — Usable by a junior who never reads the README.** *(recorded 2026-10-07, checklist sweep)*
  "I need treecontext to be usable by a junior who never reads the
  README: the agent's own instructions carry them, they can see that
  capture is working, a /clear costs them one reply rather than a
  ritual, and a handoff file tells its receiver how to import it."
  Beneficiary: hackathon-developer.
  Weight: **H** (4).
  Evidence: D171, D172, D173, D174, D175, D177, D179, D199 — all four usability probes selected; the suggestion to clear was the visionary's own idea.
  Rulings: D211, ratified 2026-10-08 (revised 2026-10-08: this line read
  "none yet — ratification at review").
  Coverage: `scenario` — journal-reorientation, journal-handoff, journal-agent-surface.

- **N26 — Zero maintenance for the sprint.** *(recorded 2026-10-07, checklist sweep)*
  "I need treecontext to run the whole day-long sprint with zero
  maintenance, no backups to run, no store to prune, no server to
  restart by hand, and a single doctor run as the only operation I ever
  need."
  (Revised 2026-10-08: "day-long sprint" is the docket's wording of N26;
  this quote first read "24-hour sprint".)
  Beneficiary: hackathon-developer.
  Weight: **H** (4).
  Evidence: D178, D179 — the ops-burden row; retention already never asks and the server's lifecycle runs itself.
  Rulings: D212, ratified 2026-10-08 (revised 2026-10-08: this line read
  "none yet — ratification at review").
  Coverage: `structural` — D178; doctor's scenarios in journal-install and journal-clients beside it.

## Tension links (ratified resolutions)

- N3 (capture everything) ↔ N8 (privacy): resolved local-only +
  redaction-at-sharing-surfaces; content never leaves the machine unless
  the operator runs the sharing command.
- N7 (never destroy) ↔ storage bounds: resolved archive-before-delete
  with refusal on failure (fence §Storage).
- N5 (many agents) ↔ N6 (identity): resolved by worktree→primary-root
  identity unification so subagent lanes land mergeable
  (project-identity §3.4).

## Fenced intent (declared out of scope — see the fence for whys and dates)

Trees in the journal · dense retrieval as dependency or default · query
fusion across journals · server-side LLM/summarization · the tree-sitter
code tool · designing around unbuilt addons · feedback tool · compaction
Layer-3 interaction (ccr owns it) · product renaming · performance
release-gate numbers (shapes pinned, numbers bench-tunable) · media byte
storage/versioning/thumbnailing · multi-reference entries.

## Open items for the visionary

1. **Re-weight at review if wanted** — the H/M/L weights were
   provisionally ratified as drafted (2026-08-25); corrections are
   Phase-2-style readback material, not edits-in-passing.
2. **The stripped-down-vision check**: N3's partial status and N13's
   structural status encode the current ambition; confirm neither should
   be promoted now that the circle closes.
3. **N15–N17 ratified 2026-08-27** as drafted — rows, weights (M / M /
   M-H), and N17's N5 linkage all stand. The one trailing piece — the
   journal-sidecar.feature header's "(h)" citation drift — was ruled
   the same day: the header now cites the post-charter surface, and
   (h) stays with journal-namespaces.
4. **Discrepancy sweep deferred, method fixed**: behaviors present in code
   but pinned nowhere get classified on sight into the four reconciliation
   buckets (matches / contradicts / uncovered-by-scenario /
   green-by-construction) during Phase 2 conversion — each becomes a
   decision point, never silent debt.
