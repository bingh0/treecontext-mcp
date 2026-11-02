# U1 review: the lane read (commit 8245420)

Reviewer: Opus failure-ladder reviewer, in a separate worktree checked out at 8245420. No commits were made, every mutation was reverted (`git status` clean apart from the reviewer's untracked temp dir, which has since been removed), and nothing was written to the store.

## Verdict

**Accept, with three medium fixes before U2 and U3 build on it.** There are no blockers. The predicate is correct and every one of the triage's eight probes turns the unit tests red. The server change (a) and the heal change (b) follow D235 and D376 as written. D235 already said "an unknown session is stamped `unregistered`", and before this commit the code never wrote that stamp. Problems:

- None of U1's charter step definitions run in the suite. All of them sit in scenarios still on the wip list (22 todo).
- The one-hop reach in `laneReferencedIds` is never exercised. That path is shaped like the incident.
- Upgrading strands a hookless client's old chapters, and nothing discloses it.

Gates: typecheck 0, lint 0, full suite 130 files, 2274 passed, 22 todo.

## Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | med | unlit | All 11 new step defs (tests/journal/steps/journal-orchestration.steps.ts:859-967) sit in scenarios still listed as wip (tests/journal/features.test.ts:170-188). The suite registers those scenarios as todo, so none of the defs execute. I removed the wip entries for two scenarios and stubbed their U2/U3 Thens: both ran green. Probe R3 (no stamp for an unplaced caller) turned them red, and so did U1-6 (the trail read by `_writer`). U1-4 (`unregistered` keyed as main) stayed green at scenario level. | Read "U1 Thens bound" as "bound, not yet executed". U2 and U3 must re-run U1's probes against these step defs once the scenarios leave wip. The unplaced-supersession Given should also try to retire main's chapter, so that U1-4 can fail at scenario level. |
| F2 | med | unlit, incident-shaped | `FlatStore.laneReferencedIds` (src/flat-store.ts:609-628) is untested. These mutations all leave the suite green: let briefs to any lane in (R-6), drop the one-hop refs (R-7), drop the lane filter on pointers (R-8). Under R-8, whatever another worktree's live chapter references enters main's default search. That is the incident through the side door, and `notUnknown` is the only filter the `ids` part of the scope keeps. | Extend the unit world with a worktree chapter that has `refs`, a `brief_for: "main"` entry and a `brief_for: "<worktree>"` entry. Assert that each lane reaches only its own. |
| F3 | med | blind:surface (undisclosed residual) | This comes from the server change (src/server/server.ts:498-514). A hookless client (Codex/Cursor, or any client with no beacon) that upgrades to beta.3 has old chapters with no stamp (main lane) and writes new ones stamped `unregistered`. A new chapter's `supersedes: [old]` comes back as `referenced`, "Written by another writer" (my probe P-UPG, .tmp-review/upgrade.ts). Both stay live pointers. With no placed writer present, nothing can ever retire the old ones. This follows D376 to the letter, but none of D376's residuals mentions it. Nothing that was main's before has become unknown (stored rows are not rewritten, and library writes remain main's), but continuity breaks at the upgrade. | Bring it to the owner. Either disclose it in D376's residuals, or rule that an unplaced writer may retire pointers that carry no stamp and whose session the registry never held. |
| F4 | low | honesty (R7) | The insert reply stays silent for an `unregistered` stamp (server.ts:636 `if (stamp.src !== 'unregistered')`), although the row now carries the stamp. D235 says "the reply says the writer stamped". The caller is not told that its chapter went into the "writer unknown" lane. | Return `writer: null, writer_src: 'unregistered'` and a `writer_note`. |
| F5 | low | honesty (R7) | `writerOf` (src/references.ts:68) shows an unplaced row's *claimed* `agent_type` as its writer. D376 says it should be "shown as writer unknown". | Return "writer unknown" and leave the claim in the metadata, or show it as "writer unknown (claims tester)". |
| F6 | low | narrowed | tests/references.test.ts:243-245 now writes the plan through the library. The tool call that claims `agent_type: tester` is now the unknown lane. So this test no longer covers a role lane against main through the tool, only unknown against main. The change is legitimate (the old setup would now supersede), but D169's "role vs main" reply wording lost its tool-door case. | Add a case where a registered subagent (`registerSubagent`, provisional or echo) supersedes main's plan through the tool. |
| F7 | low | half-lit | `laneReferencedIds` keys a pointer's lane by its stamp (`laneWriterOf`), but the scope reads the lane from the registry. An unstamped chapter in a worktree session from an earlier release counts as main's, so its refs enter main's search. | Place pointers by `session_key` through the same registry read. |
| F8 | info | — | (c) The D166 Given now fires a real startup SessionStart (journal-reorientation.steps.ts:799-803). That is more faithful to Claude Code, not narrower; the chain assertions are unchanged. (b) The heal's early return applies only to the session's own agent, unplaced, with an existing `unregistered` stamp. An echo that carries agent fields, a worker, or a self registered later still heals exactly (probe R-4 is red). | none |
| F9 | info | triage deviation | The triage gave U1 "the lane half of the helpers scenario". None of its charter steps are bound. It is covered only by a unit world with hand-stamped `_writer_agent_id`. On the owner's real store, the drain does stamp agent ids: of 20,390 rows, only 2 helper-ish rows lack one, both `treecontext` run-opens. | U3 binds it through `hooksSubagent` and `runWorker`. |

Performance, measured on a read-only copy of the owner's store (20,390 rows, 100 registry rows, 5 runs, median):

| Measurement | Lane scope | Whole store |
|---|---|---|
| Orientation query | 55 ms | 36 ms |
| Query with `conversationWindow` 3 | 105 ms | 23 ms (4.5× cost) |

- `laneReferencedIds`: 20 ms. It scans every pointer through `json_extract` with no index, on every scoped query.
- `writerTrail('main')`: 82 ms.

All of this is acceptable at this size. The window cost and the pointer scan grow with the store, so keep them on the dogfood watch list.

## Probe table

| Probe | Result |
|---|---|
| U1-1 drop the helper-trail subtraction | RED (scope and window unit tests) |
| U1-2 drop the worker parent link | RED |
| U1-3 UNKNOWN→AMBIGUOUS | RED (2 tests) |
| U1-4 `unregistered`→main lane key | RED (unit, 3 tests); **GREEN at scenario level** (F1) |
| U1-5 `unregistered` rows in main's scope | RED |
| U1-6 trail by `_writer`, not the registry | RED (unit, and the export Then of the earlier-release scenario) |
| U1-6b search by `_writer`, not the registry | RED |
| U1-7 `internal-summary` not a report | RED |
| U1-8 orphan worker folded into main | RED |
| R-1 (incident) every live pointer reachable from any lane | RED |
| R-2 main's `placed()` ignores worktree | RED |
| R-3 server: no stamp for an unplaced caller (pre-U1) | RED (unit, and the scenario Given) |
| R-4 echo heal folds unplaced into main | RED |
| R-5 windows not scoped by lane | RED |
| R-6 briefs to other lanes reachable | **GREEN (silent)** |
| R-7 drop the one-hop refs | **GREEN (silent)** |
| R-8 (incident, side door) other lanes' pointer refs reachable | **GREEN (silent)** |
| P-UPG hookless upgrade supersession | behaviour confirmed (F3) |

## Instrumentation

bound 9 (7 unit tests, the D166 Given, the references test) / hollow 0 / vacuous 0 / narrowed 1 (references.test.ts) / unlit 11 (the scenario step defs under wip) / probes run 19 / probes silent 4 (R-6, R-7, R-8, U1-4 at scenario level)
