# U2 review: status and the packet scoped to the session's own lane (commit 197c3b9)

Reviewer: Opus failure-ladder reviewer, in an isolated worktree. The worktree's branch started at 5d30000, not the 7df7bd6 named in the brief; I reset that worktree branch to 7df7bd6 and reviewed there. No commits, no pushes, nothing written to the store. Every mutation was applied from a scratchpad script (`probes/mutate.py`, file backup and restore) and reverted. The test runs rewrite `run-manifest.ndjson`; it was restored, and `git status` is clean.

## Verdict

**Accept, with fixes.** There are no blockers. Every Then U2 executes is bound through real doors and can fail:

- The D167 vacuity is cured: probe U2-1 turns the @D167 scenario red.
- 29 of 33 probes go red.
- The U1-F1 carry holds. U1-4 (`unregistered` read as main's lane key) is now **red at scenario level**, in both @D376 scenarios U2 un-wipped. U1-3 and R-3 are red there too.

Before U3 and U5 build on this, four things need fixing:

- The `other_lanes` field now means something else, and the charter never asked for that (F1).
- The incident walk's Thens are bound but still unlit. The resume-budget probe is silent in the suite as committed (F2).
- The packet's bookmark path has no lane test at all. It is the incident through the bookmark door (F3).
- "Newest pointer's kind and age" is unpinned (F4).

Gates: typecheck 0 errors (ratchet held), lint 0, full suite 130 files, 2288 passed, 11 todo.

## Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | med | reply shape changed in code, not by the charter (charter wins) | Before U2, the scope block's `other_lanes` was **the count of other lanes' live pointers left out**. That is D242's [I>V] field. It shipped in v0.1.0-beta.2 (`git show v0.1.0-beta.2:src/server/server.ts:910`) and was pinned at session-registry.test.ts:267@8245420 as `other_lanes: 2` (two main-lane pointers). U2 reuses the name for **the number of lanes** and moves the pointer count to a new key, `left_out` (server.ts:1156-1157). D372 asks for both numbers ("the count of other lanes' live pointers left out … how many other lanes hold live pointers") but names neither field. The drafts read `other_lanes` as the pointer count: draft v1:299 "no `other_lanes`-style count claiming pointers were left out", and v1:317 / v3:373 "`other_lanes` = 1". README, instructions.ts and the skill text never name the field, so no agent-facing text contradicts the change. A consumer of the beta.2 JSON is silently misread, though. No scenario can tell the two numbers apart: every scenario world holds one pointer per lane, and probe I-leftout (`left_out` := lane count) is red only in the unit test. | Keep `other_lanes` as D242's pointers-left-out and add the lane count under a new key (`lanes_holding`, say), or bring the rename to the owner and record it in U5's CHANGELOG as a reply-shape change. Either way, give one scenario world a lane holding two pointers, so that "counts N live pointers left out" and "N other lanes" differ (e.g. the main-status scenario's worktree with a chapter and a bookmark). |
| F2 | med | unlit (U1-F1 class, repeated) | The commit says U2 bound "the restarted-main and pre-registry scenarios' status/packet Thens". Both scenarios are still on the wip list (features.test.ts:178, :184), so none of those step defs run. Probe U2-5 (self lines cut by the resume budget) is **green in the suite as committed**. No unit test holds the resume budget. I removed the walk's wip entry and stubbed only its search Then (U3's). The baseline was green, and U2-1, U2-2b, U2-5, U2-7, U2-8, U2-9 and I-incident-packet each turned the walk **red**. So the bindings are honest but unlit. For the pre-registry scenario, the status half ("listed and found as the main lane's own") sits in a combined status-and-search Then with no definition, so only its worktree-counted Then is bound, and that is unlit as well. The worker's status Then (journal-workers, wip) is held only by a unit test through the library door's `registerWorker`. | U3, on un-wipping the walk and the pre-registry scenario, re-runs U2-5, U2-7 and U2-9 at scenario level and records them. Or bind a unit test for the resume budget now (a `resume` start: self lines whole, tail ≤ 500), so U2-5 has a home before U3. |
| F3 | med | half-lit, incident-shaped | `selfLines` falls back to the bookmark only when the own lane has no chapter (checkpoints.ts:149). Probe I-bookmark-any (take the newest bookmark of *any* lane) stays **green**. The only bookmark in any test world is main's own. A main checkout whose own lane holds nothing, beside a worktree that has left only a bookmark, would be handed the worktree's bookmark as "its live bookmark". That is D373's anchoring through the bookmark path. | Add a world where a worktree holds a live bookmark and main holds neither a chapter nor a bookmark. Assert "starts fresh" and that the bookmark's id and text are absent. Add the mirror for a worktree self. |
| F4 | low | unpinned | D372 and D373: "the kind and age of its **newest** live pointer". Probes I-kind (kind of the first-seen pointer) and I-age (age of the oldest pointer) both stay **green**. No world has a lane with two pointers of different kind or age: the unit test's main lane holds two chapters, both "0 minutes old". | Add a unit world where a lane holds an older chapter and a newer bookmark. Assert `kind: 'bookmark'` and the bookmark's age, in the status block and in the packet line. |
| F5 | low | blind:surface (status and packet disagree) | In session-start.ts, `self` is `gitSelfOf(cwd)` before `registerSelf`. If registration fails (busy store, no registry), the packet still says "runs in the main checkout … re-orients on the main lane's own thread" and hands it main's chapter. Meanwhile status says "could not be placed" and lists every lane flat, and the session's writes land in "writer unknown". This was already true for worktrees; U2 extends it to main (`if (self)` replaced `if (self?.worktree)`). D372 rules the unplaced status; D373 says nothing about an unplaced start. | Prepend the self lines only when the registration landed, or let the packet say the session could not be placed. Or disclose it in D373's residuals (owner's read). |
| F6 | low | none (legitimate); one D372 clause without a test | tests/background-subagent.test.ts `livePointers` now asks for scope `"all"`. These tests assert **store-wide liveness after the echo heal** across the main and tester lanes. For example, P12 expects `[c1, e]` with `e` the tester's chapter, which is exactly the flat list main's status gave before D372. Scope `"all"` keeps every old promise, and probe I-allignored turns P12 red, so the call carries weight. Nothing was narrowed. However, D372's clause "a session whose caller cannot be told apart from a live subagent is scoped to its self as before" has no test anywhere, and this world (a concurrent caller beside a background Explore) is where it belongs. | In the first test, after the drain, also call the default status. Assert `scope.lane === 'main'`, that it lists `c1` and `b1`, and that it does not list `e` (the heal moved `e` to Explore's lane). |
| F7 | info | — | Verification rule: every charter Then of U2 goes through real doors and checks SQLite. The doors are the real SessionStart hook subprocess in a real git repo with real `git worktree add`, the real MCP server (in-memory transport, with `ccSessionId` injected as the beacon resolution stand-in, as in every prior binding), and chapters inserted through the tool door with the reply's `writer`/`writer_src` asserted. The checks read `created_at`, `next_session`, metadata and the registry from SQLite. Expected lane entries come from SQLite plus the test's own lane map (`laneOfEntry`), never from the production lane key. Mild: expected ages use the production `ageText`. No status or packet claim rests on reading the code. The unit tests for `selfLines` use library inserts with hand-written stamps, which is acceptable at unit tier. | none |
| F8 | info | U1 carry | U1-4 is red at scenario level (writer-unknown and unplaced-supersession), caught through the "writer unknown" labels. U1-3 and R-3 are red there too. U1-F1's suggestion (the unplaced Given also tries to retire main's chapter) was not taken, but it is no longer needed for U1-4. U1-5, U1-6, U1-6b, U1-7 and U1-8 are search and trail probes on U3's wip scenarios and were not re-run. | U3 re-runs them when its scenarios leave wip. |
| F9 | info | process | U2's commit records no probe table or binding counts (docs/beta3-bindings-audit.md untouched). | The coordinator collates them from the builder's report and this review. |

## Probe table

Run against `-t "Orchestration inside one store|status lists the session|self lines of a fresh|background subagent"` (35 tests). "Walk" means the restarted-main scenario was un-wipped, with only its search Then stubbed.

| Probe | Result |
|---|---|
| U2-1 remove main's self sentence | RED (D167 restarted-worktree, bookmark-only, main-alone, writer-unknown, 2 unit); walk RED |
| U2-2a worktree chapter's first line in the status lane entry | RED (7: worktree status, main status, outline ×3, writer-unknown, unit) |
| U2-2b other lane's chapter line leaked into the packet | RED (8: D167 ×2, outline ×3, bookmark-only, 2 unit); walk RED |
| U2-3 cap 3→5 | RED (outline 5-lane row, unit) |
| I-cap4 cap 3→4 (name a 4th lane) | RED (outline 5-lane row, unit) |
| U2-4 lanes oldest first | RED (outline 3 and 5, unit) |
| U2-5 self lines inside the resume budget | **GREEN (silent) as committed**; walk RED (F2) |
| U2-6 unknown pointers in main's own list | RED (writer-unknown) |
| U2-7 restore beta.2's main branch (lane only for a worktree) | RED (main status, outline ×4, writer-unknown, unit); walk RED |
| U2-8 session lane from the newest pointer, not the registry | RED (7); walk RED |
| U2-9 status on a reused client (test-side) | RED (main status, outline ×3, writer-unknown); walk RED |
| I-incident-packet main's chapter = newest pointer of any lane | RED (8); walk RED |
| I-nofilter drop the lane filter on status's pointers | RED (7) |
| I-allignored scope "all" ignored | RED (6, incl. background P12) |
| I-nolane flat pointers lose their lane | RED (7) |
| I-leftout `left_out` := lane count | RED (unit only; scenario-silent, F1) |
| I-count1 per-lane pointer count always 1 | RED (unit only) |
| I-kind lane kind not the newest's | **GREEN (silent)** (F4) |
| I-age lane age of the oldest pointer | **GREEN (silent)** (F4) |
| I-unplaced-main unplaced session folded into main | RED (unit) |
| I-nobrief brief for `main` never read | RED (unit) |
| I-dropunknown "writer unknown" dropped from the summary | RED (writer-unknown, unit) |
| I-bookmark-any the packet's bookmark from any lane | **GREEN (silent)** (F3) |
| I-unstamped an unstamped pre-registry chapter not main's | RED (main status, unit) |
| U1-4 `unregistered`→main lane key (scenario level) | RED (writer-unknown, unplaced-supersession, unit) |
| U1-3 UNKNOWN→AMBIGUOUS (scenario level) | RED (same 3) |
| R-3 no stamp for an unplaced caller (scenario level) | RED (writer-unknown, unplaced-supersession) |

## Instrumentation

bound 17 (12 charter scenario rows: D372 worktree status, main status, every lane, outline ×4; D373 bookmark-only, main-alone; D376 writer-unknown, unplaced-supersession; the @D167 Then rebound. 5 unit tests: 2 for selfLines, 3 for status) / hollow 0 / vacuous 0 (the D167 vacuity cured) / narrowed 0 (background-subagent judged legitimate, F6) / unlit 8 (the walk's 6 U2 Thens, the pre-registry worktree-counted Then, the worker's status Then) / probes run 33 (27 in the table, plus 6 walk re-runs) / probes silent 4 (U2-5 as committed, I-kind, I-age, I-bookmark-any; I-leftout and I-count1 are silent at scenario level but red in the unit tests)
