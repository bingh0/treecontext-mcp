# U4 review: the snapshot's lane (commit b9ab9bf, D375)

Reviewer: Opus failure-ladder reviewer, in the detached worktree `.claude/worktrees/review-u4` at b9ab9bf. No commits were made and every mutation was reverted. `git status` is clean: the test runs rewrite `run-manifest.ndjson`, and it was restored each time. Nothing was written to the store. Probe scripts and logs are in the scratchpad under `u4probe/`.

## Verdict

**Accept, with one medium fix before beta.3 ships (F1) and three low ones.** There are no blockers. These parts of the builder's report reproduce:

- The claim is lane-filtered through the registry, and an unplaced claimant claims nothing.
- The drain writes the recovery row with the claiming session's `session_id`, so its `session_key` is that session, and runs its queries under that session's lane.
- All four triage probes turn the scenario red.

At realistic size the recovery row stays bounded and does not quote itself (F6). The one behavioural defect predates U4. D375 now promises it away, and the build does not keep that promise: curated dedup can leave the claiming session with no recovery row, and the only copy can sit in another lane (F1).

Gates: typecheck 0, lint 0, full suite 130 files, 2302 passed, 8 todo. The D375 scenario alone: 1 passed.

## Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | med | blind:surface (a writer's promise unkept) | D375 says the recovery row "is written in the claiming session and so in its lane, never in no session". The drain inserts the row as `curated`, and curated dedup is store-wide per tree (`idx_nodes_curated_fp ON nodes(tree_id, fingerprint)`). **Same lane:** main compacts again with no new rows in between, a new main session claims, the drain runs, and the store still holds 2 recovery rows, 0 of them in the claimant's session (probe Q4c). **Across lanes:** two fresh worktrees `emptyone` and `emptytwo` each compact and restart. Each packet carries its own claim line. `emptyone`'s session gets the row "(nothing to quote)" ×3. `emptytwo`'s session gets none, because its identical row was deduped onto `emptyone`'s, which is another lane's (Q4c, read in SQLite). No other lane's content leaks, since the row quotes nothing. But the claimant's own lane holds no record of the claim, and "never in no session" fails whenever the content repeats. This predates U4 (the session-less rows always deduped), and U4's promise now makes it a defect. | Give the recovery row identity, not text dedup. Either put it in the identity class as `isIdentityRow` does for run rows, keyed by the snapshot id and the claimant, or record the snapshot id and the claimant in its metadata and dedup on those. Add a Then or unit test: two identical recoveries leave two rows, one per claiming session. |
| F2 | low | binding: timeline edited by hand | The second Given backdates main's snapshot by 60 s with a raw `UPDATE snapshots SET created_at` (journal-orchestration.steps.ts:2023-2027). It is not a stand-in for a party beyond a door, and the repo has precedent: raw `created_at` updates on nodes in handoff.steps.ts:144 and :574, and reorientation.steps.ts:198 and :220. It also does not let a Then pass for the wrong reason. It is what makes the negative bite: with it removed, P1 (drop the lane filter) stays **green** at scenario level (P1b). But it edits a PreCompact hook's own write, which the stand-in guard cannot see, and it leaves main's snapshot older than main's own turns. Real ordering does the same job (probe RO): Given 1 holds back the worktree's `preCompact`, and Given 2 compacts main and then the worktree. That run is green, and P1 against it is **red**. The patch is in `u4probe/real-order.patch`. | Adopt the real-ordering binding, or keep the backdate and move it into `standins.ts` as a named helper with its reason. |
| F3 | low | unlit | Dropping `r.agent_id = ''` from the claim's join (P10) leaves the whole suite green. That condition is what keeps a ticket worker's snapshot (registry `agent_id 'worker'`) and a subagent's registration row out of a self's claim, as the `claimSnapshot` docstring promises. The reviewer's unit probes P7 and P8 pass on b9ab9bf and turn red under P10. Before U4, a main startup would have claimed a worker's snapshot (a `claude -p` child's PreCompact). U4 closes that, but nothing pins it. | Add P7 and P8 to tests/persistence/snapshots.test.ts. |
| F4 | low | narrowed | The four changed unit tests now build the server schema and register the compacting session first. That is faithful: their old hand-rolled schemas had no registry, so registration silently did nothing. What they assert is unchanged. The secret-word "round-trip" never asserted the secret word before either; it asserts the claim line names `sess-origin`, and that still holds. One case lost its subject: `source=startup produces valid JSON` (secret-word.test.ts:88-115) still seeds a snapshot for an unregistered `sess-prior`, so the startup case no longer reaches the claim branch. The setup is dead and the test stays green. | Register `sess-prior` in that case, or assert the claim line. |
| F5 | info / disclosure | — | The adapters (Q3). `src/hooks/{cursor,codex,gemini}/session-start.ts` and the OpenCode plugin register no self, so they now never claim. None is wired by this build: Codex and Gemini copy the Claude Code block, so the reference hooks register and claim within the lane; Cursor and VS Code read the Claude settings file as-is (`AS_IS_CLIENTS`, the installer writes nothing); OpenCode is "documented only" in the README. Only a config an earlier build wrote, which doctor flags as a second route, still runs them. Their PreCompact still writes snapshots that no lane claims. D375's resp covers those rows ("claimed by no one and stays in its table"), so the writer has a charter promise and the fence rule holds. The `snapshots` table has no retention at all. That predates U4: claimed rows are never deleted either. The growth is one row of roughly 150 B per compaction, which is immaterial. Also undisclosed: registration at SessionStart is best-effort, so a busy store now silently skips the claim; the snapshot waits for the lane's next start. | U5: add a CHANGELOG line saying a fresh start adopts a recovery snapshot only from its own lane, and that a session the registry does not place adopts none. Owner's call, not blocking: delete the unwired adapters' PreCompact writers, or leave them out of the build. |
| F6 | info | D286 re-verified | Probe Q4: lane turns of about 3.7 K characters each, and a second main compaction. In SQLite, R1 is 12,951 characters with `session_key` the claimant. Its `preview_len`/`index_len` columns hold 2000/8000, matching `_preview_len`/`_index_len` in its metadata, and it carries 6 "quoted to" markers. The next recovery row, R3, is 19,398 characters with columns 2000/8000 and does not quote R1, although R1 is the lane's top hit for 2 of the 3 recovery queries. So the `isRecoverySnapshot` filter is load-bearing and holds. A hit on R1 is a 2,059-character preview ending in the availability marker. Size is capped at 3 queries × 3 hits × about 2.1 K. Watch item, not verified: the 2× quota (6 hits) can fill with a lane's own recovery rows after a few compactions, leaving "(nothing to quote)". Lane scope shrinks the pool, so this becomes more likely. | Dogfood watch (U6). |
| F7 | info | — | Other probes. A worktree of the same name under another top level registers as `name@hash` and is another lane; its snapshot is not claimed (P5, green). A /clear start never claims, before or after U4, so a /clear successor's start claims nothing. A subagent fires no SessionStart. A ticket worker returns before the payload (D295) and never claims. Two main checkouts of different repos on one store both read as `main` (`worktree IS NULL`), which matches U1's lane read and is a residual of D376, not of U4. | none |

## Probe table

| Probe | Result |
|---|---|
| P1 drop the lane filter (`r.worktree IS ? OR 1`) | RED (scenario, first Then; unit) |
| P2 drop `session_id` on the recovery insert | RED (scenario) |
| P3 recovery queries unscoped | RED (scenario: "quoted … not a session of main") |
| P4 today's claim (`session_id != ?` alone, no registry) | RED (scenario, first Then; 3 unit tests) |
| P4′ every claimant read as main (accidental variant) | RED (scenario, third Then) |
| P9 an unplaced claimant claims main's | scenario GREEN (no unplaced case); RED in unit |
| P10 drop `r.agent_id = ''` | **GREEN (silent)**; RED on the reviewer's P7/P8 (F3) |
| P1b backdate removed, plus P1 | **scenario GREEN (silent)**; RED in unit (F2) |
| P1c backdate removed alone | green |
| RO the real-ordering binding / RO plus P1 | green / RED (F2's fix works) |
| P5 same worktree name, another top level | separate lane, not claimed |
| P7 a subagent row of a worktree session / P8 a worker's snapshot | not claimed (red under P10) |
| Q4 D286 at realistic size, second compaction | bounded, not self-quoting (F6) |
| Q4c an identical recovery, same lane and across empty lanes | **defect** (F1) |

## Instrumentation

bound 1 scenario (3 Thens) plus 4 new unit tests / hollow 0 / vacuous 0 / narrowed 1 (secret-word startup JSON case, F4) / unlit 1 (the worker and subagent exclusion, F3) / probes run 14 / probes silent 2 (P10, and P1 without the backdate)
