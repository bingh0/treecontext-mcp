# Fable gate: beta.3 "main-lane self" (add7004..d9daa16), 2026-11-03

Reviewer: Fable 5.1, read-only, in the worktree `.claude/worktrees/agent-a5cf34b462f48f06b`.
The worktree was handed to me at 5d30000 (beta.2.1) on the branch
`worktree-agent-a5cf34b462f48f06b`, not at d9daa16 as the brief said; I detached
it to d9daa16 for the review and put it back on its branch afterwards. No commits,
nothing written to any store, no treecontext tool called. Every mutation went
through a scratchpad script (backup, replace once, run, restore byte for byte,
`git checkout run-manifest.ndjson`); one scratch test was placed in `tests/` for
two runs and deleted. `git status` is clean.

## Verdict: PASS WITH FIXES

The result does what the rulings asked. Status, the packet, the search (hits and
windows), the writer trail, the recovery claim and the drain's recovery row are all
scoped to the session's own lane; the pre-stamp door is narrow, recorded, undone by
the heal and shut once main registers; the F1 packet fix is pinned by a scenario.
Nothing here blocks the push. Two things should be settled before or right after
release: one charter-internal split that the code faithfully reproduces (#1), and
a handful of disclosures.

## Findings

| # | Sev | Rung | Evidence | Fix | Who |
|---|-----|------|----------|-----|-----|
| 1 | **med** | charter splits against itself; `cino:` the incident's shape by a narrower door | **Verified (scratch test, library tier).** D376 says a pointer's lane is its writer stamp ("a row carrying no stamp at all, written … by a program writing through the library without one, [is] the main lane"). D374 says the search's lane is the registry's (the sessions placed in that checkout). The code does both: `status()` and `selfLines` use `laneWriterOf` (src/flat-store.ts:2357, src/checkpoints.ts:686); the search, its reach and the own-chapter seat use `laneRowsSql` (src/persistence/lane-scope.ts). World: main and a worktree `subproject` both registered; a chapter with `next_session` and the worktree session's id, no stamp, inserted through the library. Result: main's status lists it as main's own and **main's packet opens on it** ("The main lane's own chapter summary … plan: scaffold the subproject zebra"); main's search does not find it; the worktree's status lists nothing and its packet says it "starts fresh", while the worktree's search finds it as its own. The D378 scenario at journal-orchestration.feature:246 stages exactly this row and asserts only that the door leaves it alone. Reach in production is narrow (a library writer, or a future door, landing a pointer with a registered session's id and no stamp; the insert tool always stamps, the drain never writes pointers), but it is the incident's shape, through the library. | Either (a) rule one reading for pointers too: a pointer whose session the registry places is that checkout's, its stamp otherwise, so status and the packet read the lane as the search does (R10's direction, one `laneOf(meta, registry)` used by all four); or (b) keep D376's stamp rule and disclose in D376's comment that a library-written, unstamped pointer in a registered worktree session is main's for status and the packet and the worktree's for the search. (a) is a small code change plus a D376 amendment; (b) is a comment. | Owner for (a) vs (b); the coordinator can do (b) alone |
| 2 | low | half-lit at scenario level, unit cover | **Verified (probe P-L).** The D376 guard in `healWriterFromEcho` (src/persistence/writer-heal.ts:184) keeps a row stamped `unregistered` undetermined when its echo arrives from a hooked session whose registration did not land. Removed, every D376/D378 scenario stays green; only `tests/session-registry.test.ts` "an echo of an unplaced session's own agent leaves the row undetermined" goes red. Legitimate: the scenarios' unplaced client has no hooks, so no echo; the hooked-but-unplaced case (busy store) is the audit's own "unit-tier only" list. Without the guard, that case folds the row into main at the echo, the R7 violation. | Accept as unit cover; add it to the audit's "unit-tier only, by design" list (it is not there now; the list names Q4 for the search, not the heal). | Coordinator |
| 3 | low | disclosure | **Read-only.** A session in a directory that is not a git checkout registers with `worktree NULL` and is the main lane: `selfLines` even says so ("runs outside any git checkout, in the main lane", src/checkpoints.ts:710), `hasMainCheckoutSession` counts it (closes the D378 door), and `claimSnapshot` lets it claim main's snapshots. No docket line under D372/D373/D376/D378 says a non-git session is main (grep: nothing). Mostly harmless (a store is per project), but the D378 door's "no session placed in the main checkout" is literally false for it. | One residual sentence in D376's or D378's comment: a session outside any checkout is the main lane. | Coordinator |
| 4 | info | wording | **Read-only.** After the F1 fix, a *resume* packet still ends with the resume branch's own line ("No prior snapshot. Call treecontext_query for context if needed." or "Snapshot #N available…", src/hooks/shared.ts:567-575) after the self lines; the walk's step uses that line as the self-lines' end marker (steps:1199). Not a contradiction (it is about the snapshots table), but a reader who just saw "The main lane's own chapter summary …" may read "No prior snapshot" as "nothing prior". | Optional: "No compaction snapshot to recover." or drop the line on a resume when the self lines are shown, as the startup fallback was. | Coordinator, after release |
| 5 | info | F2 (known) | Self registrations never get `stopped_at`. Nothing in this slice reads a self's liveness: `hasMainCheckoutSession` is "ever registered", the lane read is by placement, `claimSnapshot` by checkout, the other-lanes order by pointer age. Does not matter for this release. | none now | — |
| 6 | info | closures checked | F1 (read_only through the door): fixed in 07cdc85, `splitSupersedes` routes a read-only pre-stamp target to the ordinary refusal; lane-door test present. F2/F3 (vacuous Then, `other_lanes` scenario-silent): cured at scenario level per the audit (P13, P15 red). F4 (unplaced start's packet): D373 comment now carries the residual (2ea33ea). F5: recorded as optional in the audit. F8 (staging fallback): unit tests added, Q7 red per audit. F11–F13 (README/CHANGELOG wording): README:323 says "a pre-stamp chapter of main", CHANGELOG:10 says `writer` `null` with the note, README:332 names `--experimental-capture` copying the block. F14 (skill text): 2ea33ea reworded to "status and the fresh start also count the other lanes". F6, F9, F10: info, left as is. All closed or honestly recorded. | — | — |

Charter ↔ rulings, read against the code (read-only unless marked): R1 lane names
are the filesystem's (worktreeLaneName); R2 symmetry (status `lane` for main and
worktree alike, server.ts:1147-1160); R3 count + at most three names, no text
(`OTHER_LANES_NAMED`, `otherLanesLine`); R4 search scoped per session, the worker
and the D240 cases whole-store with the reply saying why (server.ts:940-990); R5
own-lane claim (`claimSnapshot` joins the registry on the checkout); R6 worktree
scenarios present (o88, o128, o181, o210); R7/R7a `unregistered` is its own lane,
unstamped rows are main's (`laneWriterOf`, `laneRowsSql` main's `neverHeld`,
probe P-H red at scenario level); R8/R8a helpers' reports by parent link, never
their trails (probe P-R red at scenario level through the real hooks), flood
scenario o189; R10 nothing stamped, nothing rewritten (D376 scenario "byte for
byte"); R12 found-never-contradicted plus the seat; R14 the door with who/what/
when/how (`retireAcross`, `_retired_across`). Half-lighting hunt: every lane
reader goes through `laneRowsSql`/`placedLaneOf` (flat-store search, windows,
reach, trail; ingestion's recovery row; server status and query) or `laneWriterOf`
(status pointers, packet, supersession); the hooks door's leg rows and the ticket
door's worker rows carry `_writer_agent_id` or sit in the worker's own session,
so the subtraction and the parent link reach them; handoff lanes are read by
`_handoff_importer`. The one place two readings diverge is finding #1.

## Probe table

| Probe | Mutation | Result |
|-------|----------|--------|
| P-J | restore the start's "No prior context available" fallback beside the self lines (src/hooks/shared.ts:607) | **RED** at scenario level (o151 "alone in its store"); the F1 fix is pinned |
| P-H | drop main's never-held rows from the search reading (lane-scope.ts, `OR neverHeld`) | **RED** at scenario level (o228 "rows from before the store recorded writers"); o97/o128/o158 green as expected (status reads the stamp) |
| P-L | remove the D376 heal guard for an `unregistered` echo (writer-heal.ts:184) | scenario **GREEN (silent)**; RED in session-registry.test.ts (finding #2) |
| P-R | drop `_writer_agent_id` on hook-captured subagent rows (ingestion.ts:668) | **RED** at scenario level: o168 (helpers' reports), o189 (flood), D147 summary search, two legs scenarios, a runs scenario; plus 3 unit tests. The helper-trail subtraction is bound through the real hooks, not half-lit |
| S-1 | scratch test (no mutation): unstamped library chapter in a registered worktree session; status, packet and search by lane | status/packet: main's; search: the worktree's (finding #1) |

Gate runs: `features.test.ts` filtered sets only (the full suite is the coordinator's
number, 2323 passed on d9daa16); each probe restored and `git status` clean after.

## LSP

Loaded (`select:LSP`) but unusable: the workspace's TypeScript is 7.0.2 (tsgo) with
no `tsserver.js`, so every `incomingCalls` request failed at initialize. Reachability
was done by grep on `laneRowsSql`, `placedLaneOf`, `retireAcross`,
`buildRehydrationPayload` and the registry writers in about one minute, which was
enough for a codebase whose callers are spelled by name. It did not earn its keep
here; add it to the recipe only if the harness grows tsgo support or the repo pins a
TypeScript that ships tsserver.
