# Scope runs — the installation's run record

Statistics on how the scope skill works on this repository's projects,
kept outside the plugin directory so a plugin update cannot delete it
(scope skill SKILL.md, "Run statistics"). One dated entry per run; a
follow-up line when a scoped project reaches build.

## 2026-10-05 to 2026-10-07 — treecontext, the hackathon re-cut

- Skill: scope 5.0.0, local checkout; gherkin-node-test 0.11.0 and
  docketry 0.1.0, local checkouts.
- Project scoped: a feature set inside the existing treecontext repo for
  the `0.1.0-beta.1` public release of 2026-10-12, target user a junior
  four-person hackathon team on macOS using Claude Code with /clear.
- Structured questions: about 60, of which 14 were rejected or reframed
  by the visionary before an answer landed (the reframes became the
  decision points: re-orientation feedback, the stop-hook bookmark, the
  two checkpoint kinds, git-convention references, the lane principle).
- Reviewed corpus: 4 new feature files, 38 scenarios and 4 outlines,
  plus 5 scenarios added to 2 bound files; whole corpus after the run 17
  files, 220 scenarios, 5 outlines, zero strict findings.
- Needs ledger: 4 new rows (N23–N26); 2 of them arrived only through the
  Phase 3¼ sweep (N25 usability, N26 ops burden); 9 of 10 checklist
  categories selected at triage, 3 domain items accepted.
- Electives (Phase 5½): offered, declined ("make it so"); 0 ruled
  electives; the design doc carries 8 `chosen` constraints beside 23
  `ruled` tags for the re-cut plus the structural index.
- Assumptions surfaced by the boundary question: 0 at every boundary
  (1½, 3, 3¼, 3½, 5).
- Protocol critiques (Phase 5, second question): 0.
- Adversarial pass (3½): 7 substantive objections and 2 small, every one
  ended as a ruling; two reversed a ratified ruling by dated amendment
  (D122 → D191, D106 → D194) and one amended the chosen re-orientation
  shape (D159 → D187).
- One research run on request (rule 6): the hook survey of five clients,
  which reshaped D152 into D153.
- Gate mode: interactive (ruled before the audit).
- Post-draft pass: a cold Fable CINO review of the feature files, by
  ruling D202, run before the visionary's read: 25 findings in layer
  order (8 cino:spec, 4 cino:assertion, 4 cino:binding, 1 cino:code,
  2 cino:decision, 5 blind:surface, 1 blind:need, plus a
  one-behaviour sweep). 20 were drafting defects or gaps derivable from
  a ruling's own text and were fixed before the read; 5 went to the
  visionary as questions under the interactive gate, in order: the
  imported entries' lane (D206), the interval boundary (D207 amends
  D156), the installer copy versus the experimental flag (D208 amends
  D161), group membership in beta.2 (D209 defers D168), the handshake
  length (D210). Every question produced a ruling; two amended the
  interview's own rulings and one deferred a scenario.
- Visionary's corrections during their own read, with review-order
  positions: 0 corrections across the four new files (read in weight
  order) and the ledger; the ledger's new rows were accepted with the
  note that the final `0.1.0` release will update, remove or
  generalize them.
- Visionary's self-reported read depth: superficial by their own
  account ("the scenarios are dense so it's hard to fully understand
  them, or negative scenarios are hard to think of; they superficially
  look okay"). Attention data for this run: WEAK. The density of a
  38-scenario corpus with concrete values is itself a finding for the
  protocol: a reviewer-facing rendering (one line per scenario, the
  failing world named) may be the missing surface.
- Ratifications at review (2026-10-08): N25 (D211), N26 (D212), D144
  (D213), and the interview's record by chain (D214 ratifies D145
  through D213). The backport's own queue of 27 lint findings remains
  the owner's, untouched by this run.
- Protocol changes the run motivated: none proposed yet. Two
  observations for the skill: the visionary rejected option sets to
  reframe 14 times, so a "reframe" answer may deserve first-class
  handling; docketry's lint keys spread and amends findings by the chain
  root, so an outline must carry the root's tag as well as the
  amendment's.
- Host inventory findings: a whole-feature WIP ruling must not coexist
  with a definer in the runner's map (feature-guards); moving DESIGN.md
  beside the corpus lit 40 pre-existing uncited structural rulings,
  indexed in the design doc rather than left dark.

## 2026-10-29 to 2026-10-31 — treecontext, the beta.3 subagent cut

- Skill: scope 5.2.0 (gherkin-node-test 0.11.0, docketry 0.1.0). Two
  sessions: 2026-10-29 (Phase 0 to mid-Phase 2, N27–N32 and D279–D285,
  paused by the beta.2.1 hotfix) and 2026-10-31 (Phase 2 resumed through
  drafting, D288–D323). Vision in the visionary's own words: subagent
  support — legs through Claude Code's hooks, headless workers of any of
  three CLIs through a ticket door, runs a harness reads by key with no
  model in the loop, and a run anyone reconstructs with plain SQL.
- Rulings: D279–D323 (45 entries, 6 needs N27–N32); 14 amendments by
  dated entry; 1 fence-assumption (D283); 1 fence-declined (D306); 1
  boundary (D282); 2 structural (D293, D308); 1 ratifies (D321); 2 means
  (D322, D323).
- Structured questions, 2026-10-31 session: about 49 (one at a time;
  the one sanctioned batch was the Phase 3¼ triage). Rejected option sets
  ("wants to clarify") in Phase 3: 7, each resolved by a direct
  recommendation with reasons and a yes; after the fourth the visionary
  asked that every option set end with a "discuss first" option, adopted
  from D300 on and taken 3 times.
- Corrections to the interviewer's record: 1 misread (a Claude Code
  internal-summary row taken for the visionary's confirmation of the
  workers path, caught by the journal's writer stamp before recording);
  1 rule-6 self-refutation (D308 and D313 claimed the retention valve
  carries first-moment rows; a read of the valve showed it evicts
  capture rows only, returned as objection 7 and ruled D319); 2 reframes
  by the visionary that became the decision point (the unknown-parent
  question from permission to traceability, D293; the big-checkpoint
  question from cut-or-cap to references-plus-cap, D299).
- Reviewed corpus, after the post-draft pass: 3 new feature files
  (journal-legs 29 scenarios and 1 outline; journal-workers 26 scenarios
  and 6 outlines; journal-runs 19 scenarios), plus 6 scenarios and 2
  outlines added to 3 bound files (journal-install, journal-reorientation,
  journal-storage); whole corpus after the run 20 files, 343 scenarios,
  14 outlines, zero strict findings.
- Needs ledger: 6 new rows (N27–N32), all from Phase 1; N26 widened by
  D308 from the sprint's day to the installed life. Checklist sweep: 7
  of 10 categories selected at triage (Performance declined, D306;
  Security confirmed by D293), 0 new needs from the sweep, 2 rulings
  from it (D307, D308). The domain question (interviewer's priors)
  produced 4 items, all accepted (D309–D312).
- Electives (Phase 5½): taken; 2 ruled (D322 dependencies at latest
  stable, D323 one store); 1 queued item left to the build bound by its
  behavior ruling (D320).
- Assumptions surfaced by the boundary question: 1 at Phase 1½ (D283),
  0 at 3, 3¼, 3½ and 5. Four "nothing" answers in one session count
  against the question.
- Protocol critiques (Phase 5, second question): 0 at the question; 2
  during the run: the "discuss first" option, adopted mid-run, and the
  gate's adversarial pre-resolution of its questions (D333).
- Adversarial pass (3½): 9 objections, 2 examined and dropped; 8 ended
  as amendments (D313–D320) and 1 as a reaffirmation (D321 ratifies
  D299). Two rested on platform facts verified through the hooks
  documentation before they were put (SubagentStart cannot block and
  carries no prompt).
- Host inventory: new feature files enter the suite through the
  whole-feature wip register with a dated reason, and added scenarios in
  bound files through scenario-scoped wip entries; bound scenarios
  touched: none (fence, Sanctioned changes). The runner's definer map
  carries no entry for an unbound file.
- Gate mode: interactive (D324, ruled before the audit).
- Post-draft pass: three Opus reviewers against the failure ladder, one
  per new feature file and one over the touched files, ledger, design
  doc and fence, gated by the interviewer (Fable) before the read, as the
  visionary's build-staffing rule asks. Findings in layer order: 25
  cino:spec, 13 cino:assertion, 10 cino:binding, 11 cino:decision, 20
  blind:surface, 6 blind:need, plus 17 on the ledger, design doc and
  fence. Drafting defects fixed before the read: the legs file and the
  workers file rewritten (every Then now reads the hook's context, the
  hook's output or the store, never a live reply; Givens carry the facts
  their Thens rely on; half-lit producers became outlines over door,
  spawner, reader and CLI pair), the runs file rewritten (plain SQL named
  in the When, the no-flag counter-case, the zero-checkpoint key, a
  second key and writer in the export), the ledger's N27 restored
  verbatim, the design doc's citations corrected, the fence's
  misfiled entries moved. Two rule-6 verifications during the pass
  against the hooks reference: SubagentStart carries no prompt (D320's
  premise), and a hook's injected context is capped at 10,000
  characters per string, which no ruling had seen. Contract-level
  findings held for the read as questions: 21.
- The interactive gate, 2026-10-31 to 2026-11-01: 8 questions put one
  at a time and ruled (D325 hooks-door cap, D326 inferred keys, D327
  brief lifetime, D328 cuts at the hooks door, D329 numbering and the
  two-in-effect first moment, D330 the pointer channel, D331 stamped
  supersession, D332 the state-not-history line); then the visionary's
  protocol critique, "these are a little bit too technical for me
  without more context. can i suggest an adversarial review of these,
  if they are clean, any of these that cannot be resolved, bring back
  to me?" (D333). The remaining 13 went through two Opus reviewers:
  7 resolved from the record and recorded as inferred entries awaiting
  ratification (D334 recovery after any end without a checkpoint and
  the unregistered stop, D335 the re-run is the same leg, D336 the
  lookup carries the leg's return, D337 the agent's door, D338 the
  settings line alone, D339 the valve's treatment of first moments, and
  two ledger ladderings, N28 and N31); 5 returned to the visionary in
  plain language and ruled (D340 ticket door default, D341 a blank key
  is damage, against the recommendation, D342 the garbled-ticket
  lookup, D343 the imported claim believed and flagged, D344 three
  sizes). Corpus after the gate: 20 files, 371 scenarios, 16 outlines,
  zero strict findings.
- Build staffing ruled by the visionary at the readback: triage, Sonnet
  and Opus builders by difficulty, Opus reviewers running the failure
  ladder, a Fable gate last.
