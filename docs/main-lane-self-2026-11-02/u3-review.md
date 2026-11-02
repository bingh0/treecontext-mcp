# U3 review: the search scoped to the session's own lane (commit 1f78148)

Reviewer: Opus failure-ladder reviewer, in the detached worktree `.claude/worktrees/review-u3` at 1f78148. No commits, no pushes, nothing written to the store. Every mutation was applied from a scratchpad script (`u3/mutate.py` + `u3/probes.json`: file backup, run, byte-for-byte restore, `run-manifest.ndjson` restored after each run). A reviewer's scratch test (`u3/zz-review-seat.test.ts`) was copied into `tests/` for one run and removed. `git status` is clean.

## Verdict

**Accept, with fixes.** No blockers. The 7 scenarios are bound through real doors and can fail:

- 27 of the 30 mutation probes go red, 17 of them at scenario level.
- Every carry from U1 and U2 is discharged, with one exception: U1-5 is still red only in unit tests (F6).
- The seat (`seatOwnChapter`) does real work. Remove it and the flood scenario goes red: the chapter is not among the 3 hits. So the R12 "found" Then is not hollow.

Before U5 documents this, the following need fixing:

- The seat takes the **first** place on a page of one (F1).
- The seat is a page rule that applies to every lane-scoped search, and no docket line records it (F2).
- One D374 caller branch has no test that can fail: the concurrent caller's whole-store hits. Probe U3-2 is green across the whole suite (F3).
- The unplaced caller's search note is never asserted (F4).

Gates: typecheck 0 errors (ratchet held), lint 0, full suite **130 files, 2297 passed, 9 todo** (448 s).

## Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | med | invented rule past its own bound | `seatOwnChapter` (src/flat-store.ts:2189-2198) guards only `k < 1`. When k = 1 (`top_k: 1`, or adaptive `finalK` 1), the seat **replaces the best hit**. That is "first by rule", which the commit, the AGENTS.md note and D374 ("the first place not promised"; road not taken: "a rank-first promise") all disclaim. Scratch test: the query `"CSRF token"` with `top_k 1` gives the best hit on the whole store and main's chapter on the lane (`[zz] whole top1=best lane top1=plan`). On a copy of the owner's store, 8 of 80 sampled developer prompts at `top_k 1` were answered with main's chapter in place of their top hit. | Seat only when `k >= 2`. Add the k = 1 case to the unit test (`session-registry.test.ts` "keeps a seat"). |
| F2 | med | rule in code the docket does not name | The seat runs on **every** lane-scoped relevance search with a phrase, not only the orientation search after a restart (the store cannot tell them apart; D264 declined an orientation parameter). On the owner-store copy at the served `top_k 3`, recency 0.25, 6 of 80 sampled prompts had their third hit replaced by main's live chapter (4 of 80 at `top_k 5`). D275 is the precedent: a page rule after fusion has its own docket line. D273's lookup numbers were the owner's basis for 0.25. | See Adjudication A. Add one clause to D374's resp, with the measured cost in its comment, ratified with D372–D376. No separate owner question. |
| F3 | med | unlit (D240 hits) | Probe U3-2 applies the lane scope to `concurrent` and `ambiguous` callers while the block still says "the whole store". It is **green in the full suite** (130 files, 2297 passed). session-registry.test.ts:197 asserts the block's text only, never a hit. The triage expected this test to fail. | At :197, also assert that `q2`'s hits include `note one` (the tester's provisional row, which carries `_writer_agent_id` and so lies outside main's lane). |
| F4 | low | unasserted reply (D374 unplaced branch, R7) | Probe U3-9b folds an unplaced caller that has a session id (a hookless client with a beacon: the writer-unknown case) into main's lane. It is green in the targeted set and **red in the full suite**: 8 older tests search as an unregistered session (namespaces, D186, recall's metadata filter, 4 D275/D166 re-orientation scenarios). That catch is incidental: their rows drop out, because a self-stamped row lies outside main's lane once the caller is folded in. No test asserts the `unplaced: '... no session-start hook registered it ...'` search note. U3-9 (any unplaced caller folded into main) is red only through query-telemetry.test.ts:99, which has no session at all. | Add a unit test: a session id that the registry never placed, a worktree row that matches the query, and assertions that `scope.unplaced` is the hook sentence and the worktree row is a hit. |
| F5 | low | half-lit (D309 by name) | The D309 "by its name" binding is unchanged and green. The default lane search now reaches **one** row of r1, its run-open (captured: `[["run-open","run r1 opened at the registration of its","r1"]]`). r1's checkpoints sit in the workers' sessions. The Then holds on that one row, and its "none of r2" negative now only covers open rows. | With Adjudication B's clause: assert the scope block's `widen`, and that `scope: "all"` returns r1's checkpoints and none of r2's. |
| F6 | low | unlit at scenario level | U1-5 (`unregistered` rows in main's scope) is red only in the unit tests (scope, window). No scenario searches beside a writer-unknown row. The @D376 writer-unknown scenario covers status and the packet only. | Optional: in the writer-unknown scenario, have main search the unplaced chapter's words and assert it is absent from the default and present under `scope: "all"`. Or accept unit coverage. |
| F7 | low | weak positive | D309 "last Tuesday" (journal-runs.steps.ts:284-293) asserts only that the default reply carries `widen`. It does not check what the default reaches: the Tuesday run's summary rows, which belong to the spawner's lane by the parent link and each carry the run. | Also assert that the default hits include the Tuesday run's summary rows, so the agent sees the run before it widens. |
| F8 | info | — | The seat's reach is bounded, and the record should say so. It picks from the candidate pool only (`max(4·top_k, 50)`, after the WHERE and residue filters). It does nothing when every query word is pruned (`phrase` null, more than 256 rows) or the chapter ranks below the pool. In those cases "found" is still not guaranteed. The flood scenario's chapter ranks 3 of 3 **only because of the seat** (A1: rank "0 of 3", absent). | Put this in the D374 comment beside the clause (Adjudication A). |
| F9 | info | probe as specified is meaningless | U3-5 (run the walk's search on the reused `w.client`) stays green by construction. The walk's status Then (`statusOf`, journal-orchestration.steps.ts:1179) has already opened a client under `main:resume`, so the "reused" client is the right one. The binding never reuses a client anyway: `searchAs` opens its own. The meaningful variant, U3-5b (search on the stale worktree client), is **red**. The binding is not hollow. | none. Record U3-5b as the walk's client probe. |
| F10 | info | carries verified | U1-F1: U1-1, -2, -6, -6b, -7 and -8 are red at scenario level (U1-5 is unit-only, F6). U1-F2: R-6, R-7 and R-8 are red (the new unit test at session-registry.test.ts:577). U1-F6: the registered-subagent tool case was added (references.test.ts:242) and is green. U1-F7: pointers are placed by session (`laneReach` uses `own.sql`; an unstamped worktree chapter is the worktree's, R-8 red). U2-F2: the walk is un-wipped, and U2-5, U2-7 and U2-9 are **red at scenario level**. Windows perf: see below. | none |

## Probe table

The targeted set is `tests/journal/features.test.ts`, `tests/session-registry.test.ts` and `tests/background-subagent.test.ts`, filtered to the U1, U2 and U3 lane scenarios, D147/D150/D263, D309 ×3, D313, the worker scenario and the lane unit tests (31 tests). The baseline is green.

| Probe | Result |
|---|---|
| U3-1 scope the hits but not the windows | RED (window unit; helpers scenario) |
| U3-2 scope `concurrent`/`ambiguous` callers to the lane | **GREEN (silent)** in the targeted set (F3) |
| U3-3 a block on `scope: "all"` | RED (5: D150, scoped, helpers, earlier-release, the stamp-replies unit) |
| U3-4 scope by `_writer` instead of the registry | RED (10, incl. the walk, D147, D263, D309 by name and open/close) |
| U3-5 the walk's search on the reused `w.client` | GREEN, by construction (F9) |
| U3-5b the walk's search on the stale worktree client | RED (walk) |
| U3-6 a report presented with `_writer: main` | RED (flood) |
| U3-6b a report presented as `next_session` | RED (flood) |
| U3-7 main's search left unscoped (the incident) | RED |
| U3-8 a worker scoped like a self | RED (worker scenario) |
| U3-9 every unplaced caller folded into main | RED (query-telemetry only, no session) |
| U3-9b an unplaced caller with a session id folded into main | GREEN in the targeted set; RED in the full suite (8 incidental, F4) |
| U3-2 alone, full suite | **GREEN (silent)**: 130 files, 2297 passed, 9 todo (F3) |
| U3-2+9b together, full suite | RED: 8 tests, all from 9b (F4) |
| A1 remove the seat | RED (seat unit; **flood scenario**: the chapter is absent) |
| A2 seat first instead of last | RED (seat unit only) |
| Seat at `top_k 1` (scratch test, no mutation) | the chapter replaces the best hit (F1) |
| Seat under a metadata filter or `time_range` (scratch test) | the seat respects both (no seat outside the filtered pool) |
| U1-1 drop the helper-trail subtraction | RED (2 unit; helpers scenario) |
| U1-2 drop the worker parent link | RED (unit; helpers scenario) |
| U1-5 `unregistered` rows in main's scope | RED (unit only, F6) |
| U1-6 the trail by `_writer` | RED (unit; earlier-release export Then) |
| U1-6b the search by `_writer` | RED (= U3-4) |
| U1-7 `internal-summary` not a report | RED (unit; D263 scenario) |
| U1-8 orphan worker folded into main | RED (helpers scenario) |
| R-6 briefs to any lane | RED (reach unit) |
| R-7 drop the one-hop refs | RED (reach unit) |
| R-8 other lanes' pointer refs reachable | RED (reach unit) |
| U2-5 self lines inside the resume budget | RED (walk) |
| U2-7 beta.2's main branch (lane only for a worktree), status and packet | RED (7, incl. the walk, the flood, pre-registry, writer-unknown) |
| U2-9 the walk's status on the reused client | RED (walk) |

## Performance

Measured on a `VACUUM INTO` copy of the owner's store, taken read-only (19,430 rows, 114 registry rows, 4 live pointers). Medians of 9 runs, the orientation query, `top_k 3`, recency 0.25:

| Measurement | Lane `main` | Whole store |
|---|---|---|
| Orientation query | 33.2 ms | 14.9 ms |
| `conversationWindow` 3 | **37.0 ms** | 15.1 ms (2.5×; U1 measured 105 vs 23 ms) |
| `conversationWindow` 2 (the tool's default) | 33.7 ms | — |
| `laneReferencedIds('main')` | **3.5 ms** (U1 measured 20 ms) | — |

The builder's figures (window 3 at 37 ms, reach at 3 ms) are confirmed. I did not re-run the pre-U3 baseline; U1's numbers serve as the before. The seat's frequency on this store is in F1 and F2.

## Adjudication A: `seatOwnChapter`

**Resolved from the record. It is charter-sanctioned as the means of a chartered promise, provided it is bounded (F1) and the docket records it (F2). No owner question.**

- **The promise is chartered.** D374's resp, ruled by the owner in R12, says: "after a restart the lane's own chapter is among the orientation search's results and no result presents another lane's thread as the session's own, the first place not promised". The flood scenario's Then reads "the orientation search finds the chapter". The served page is `top_k 3` with fusion at 0.25 (D273). Without the seat, 200 newer reports push the chapter off that page: probe A1 turns the flood red. So some mechanism is needed to keep a promise the charter makes. The D374 comment says only a *rank-first* promise "would need a chapter-lifting rule". That premise was wrong for "found" too, at `top_k 3`. The seat is the weaker rule, and found is what it secures.
- **It is not rank-first, except at k = 1.** At k ≥ 2 it changes no score or count, keeps fusion's order for the first k-1 places, and takes the last place only when no own chapter made the cut. At k = 1 that last place is the first place, which is the declined road. Hence F1: guard `k >= 2`.
- **D56, D273 and D275 are not broken.**
  - Fusion order is preserved above the seat.
  - D275 placement still holds. Placement puts every matching live chapter above every matching bookmark, so a chapter left off the page means no bookmark is on it. A seated chapter can therefore never sit below a bookmark.
  - Temporal `sort_by` disables the seat: the server sets `chapterPlacement: false`, and the store checks `sortBy !== 'relevance'`.
  - Adaptive keeps its count.
  - `namespace_weights` re-ranks after the store, as before.
- **The edges hold:**
  - Several live chapters: one is seated, the best ranked, and only when none is on the page.
  - A worktree lane is symmetric.
  - `scope: "all"`, the D150 subagent scope, `concurrent`/`ambiguous`, workers and unplaced callers carry no `opts.lane`, so `reach` is undefined and nothing is seated.
  - Metadata filters and `time_range` are respected, because the seat picks from the filtered pool (scratch test).
  - Imports and bookmarks are never seated: `ownChapters` excludes `handoff:` rows and `kind: bookmark`, and pointers stamped `unregistered` are excluded by `notUnknown`.
- **It is not hollow.** A1 turns the flood red. The unit test pins the last place and the temporal exemption.
- **It is undocketed.** The cost lands on every lane-scoped search, at 6 of 80 sampled prompts on the owner's store. Proposed text, appended to D374's resp before ` [I]`, with the coordinator recording it and the owner's ratifying read of D372–D376 carrying it:

  > ; a lane-scoped relevance page of two or more places that holds none of the lane's own live chapter summaries the search matched gives its last place to the best ranked of them, never the first, never on a temporal listing and never past the filters; no score or count changes

  Proposed comment sentence: "found by the U3 build: at the served `top_k 3` with fusion, 200 newer reports pushed the chapter off the page, so 'among the results' needed a seat though not a lift; measured on the owner's store, the seat takes the third place of 6 in 80 sampled developer prompts; it reaches no chapter outside the candidate pool or when every query word is discounted."

## Adjudication B: D309 and D313 bindings widened with `scope: "all"`

**Resolved from the record: (i), the binding change is faithful, not narrowed. It needs a housekeeping clause in D374 (a light version of iii) that the coordinator can draft and the ratifying read can carry. Not an owner question.**

Derivation:

1. **A ticket-door worker spawned by a lane's session is that lane's helper.** D374: "each helper's report alike, a subagent's summary row or a worker's, the worker's by the parent link of its registration, never a helper's trail, its tool calls and turns staying in its own lane". R8, the owner's ruling: "the report (subagent summary / worker return) of each subagent or worker spawned by a session of this lane … Never a helper's whole trail."
2. **Where each run row falls under that reading:**

   | Row | Lane under D374 |
   |---|---|
   | Summary row | The spawning lane, by the parent link |
   | Open, close and brief, written through the library with no session | The main lane, as "sessions the registry never held"; observed as the one hit in the by-name scenario |
   | First-moment row | The worker's own session ("as the worker's capture … in its own session", AGENTS.md); it is the worker's first turn |
   | Checkpoints | The worker's own session, written by the worker |

   So by D374's words and R8, first-moment rows and checkpoints are the worker's trail, outside the spawner's default.
3. **D309 [I>V] promises findability "through the query the agent already has".** The visionary's words: "if the agent can figure it out, that's all that's necessary". The scoped reply "names the lane searched and how to widen" (D374), and `scope: "all"` is part of that same query: D374 notes D264's "no new query parameter" holds because `scope: "all"` existed. The agent figures it out from the block, which the rebinding asserts before widening.
4. **The scenario words are not narrowed.** "When an agent queries for what ran last Tuesday" and "an agent searching the prompt's words" do not say "without asking for the whole store". D374's own scenarios say exactly that when they mean the default. Every Then keeps its full strength (3 first-moment rows with run and key, 6 checkpoint and summary rows, the bounded preview with its marker).
5. **(ii), including the lane's runs' rows by parent link, would contradict R8.** It would put the worker's first turn into the spawner's default and stretch "report" to cover checkpoints. It would also be a new charter clause in its own right.
6. **The residual is textual.** D374's `touches` omit D309 and D313. D309's "an agent asked what ran on a day finds that day's first-moment rows" now reads like a default-search promise that holds only when widened. Proposed text, appended to D374's resp before ` [I]`:

   > ; a run's rows in a worker's own lane, its first moment and its checkpoints, are found by asking for the whole store, the scoped reply saying how, its summary row being the spawning lane's by the parent link and its open and close the lane of the session that wrote them, the main lane's for a write naming no session

   Add D309 and D313 to D374's `touches`. Tighten the two weak bindings as F5 and F7 describe.

## Instrumentation

bound 13: 7 charter scenarios un-wipped and 3 rebinds (D147, D309 Tuesday with its filtered-by-run step, D313), plus 3 unit tests (one-hop reach, seat, U1-F6 references). The query-telemetry adjustment is counted as legitimate, not as bound.

hollow 0 / vacuous 0 / narrowed 0 (D309 and D313 judged faithful, Adjudication B) / half-lit 1 (D309 by name, F5) / unlit 2 (the D240 concurrent hits F3, U1-5 at scenario level F6), plus 1 reply never asserted (the unplaced search note, F4) / probes run 32 (30 mutation probes, including 2 full-suite runs, plus 2 scratch-test checks) / probes silent 1 in the full suite (U3-2), 1 more in the targeted set only (U3-9b; U3-5 green by construction, not counted).
