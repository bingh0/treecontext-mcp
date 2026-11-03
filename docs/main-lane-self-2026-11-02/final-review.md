# Final review: U3b (e4617c1), U34-fix (b1f9d2f), U5 (806c309)

Reviewer: Opus failure-ladder reviewer, in the detached worktree `.claude/worktrees/review-final` at 806c309. Read-only: no commits, nothing written to the store. Every mutation was applied from a scratchpad script (`probe.py` + `probes.json`: file backup, run, byte-for-byte restore, `run-manifest.ndjson` checked out after each run). One reviewer scratch test (`zz-review-door.test.ts`) was copied into `tests/` for one run and removed. `git status` is clean.

Gates at 806c309: typecheck 0 errors (ratchet held), lint 0, docket lint **62** findings (as expected), full suite **132 files, 2321 passed, 3 todo** (exit 0). D378 + @D376 filter alone: 6 passed.

## Verdicts

| Commit | Verdict |
|---|---|
| e4617c1 U3b | **Accept with fixes** (one medium: the door bypasses the read_only refusal) |
| b1f9d2f U34-fix | **Accept** (two low) |
| 806c309 U5 | **Accept with fixes** (wording only) |

---

## e4617c1 — U3b: the pre-stamp door (D378), the status fields restored, U1/U2 honesty fixes

### Builder's claims, checked

- **5 scenarios bound and un-wipped.** Verified: the wip block for journal-orchestration is gone (features.test.ts:168-170) and the 4 @D378 scenarios plus the @D376 supersession scenario run (6 pass in the filtered set).
- **Probes all red except "liveness alone".** Reproduced: P4b (liveness alone) is green, P4 (liveness and the handoff test together, v2's probe iii) is red. See the probe table.
- **`other_lanes` restored, `other_lane_count` added, `left_out` gone.** `other_lanes` = `status.resumePointerOtherLanes`, the same expression beta.2 shipped (`git show v0.1.0-beta.2:src/server/server.ts:906-910`). `left_out` never shipped; nothing reads it.

### Disclosed deviations, judged

- **(a) I-kind fails only in a direct summarizeLanes unit test.** Acceptable. Status feeds `summarizeLanes` newest-first, so "kind of the first-seen pointer" and "kind of the newest" coincide on every production path. The unit test pins the function's contract against any order. I-age is red through the real server (P21).
- **(b) F1's two numbers told apart only in unit worlds.** Confirmed: P15 (`other_lanes` := lane count) is red in `session-registry.test.ts` (2 tests, through the real server and client), **silent at scenario level**. U2-F1 asked for one scenario world with a lane that holds two pointers; that was not done. → F3 below.
- **(c) F5: an unplaced start omits the self lines, with no "could not be placed" line.** Consistent with the record. It is the first of the options U2-F5 offered. Without the self lines the base payload (`buildRehydrationPayload`) carries no pointer of any lane, so the packet claims no checkout and never hands the session another lane's chapter. Status says "could not be placed", and the two do not disagree. However, D373's trig ("a session starts … in the main checkout") literally covers a start whose registration failed, and its resp promises the self lines. The packet now goes silent there, and no docket residual says so. → F4 (disclosure, coordinator).
- **(d) `_writer_heal_reverted` instead of v2's `_writer_heal_unretired`.** Correct. D240's resp names `_writer_heal_reverted` as the retiring row's list of what it restored ("listed as `_writer_heal_reverted`, with a `_writer_heal_note`"). `_writer_heal_unretired` is the other heal path's key (a retirement the row suffered, writer-heal.ts:243). v2's "as it does today" was wrong about which key. Both keys are in WRITER_STAMP_KEYS (session-registry.ts:98-100). D378 names no undo key ("the heal's own record saying so"), so nothing in the charter is contradicted.
- **(e) Two older bindings and a references test now drive a registered tester or a registered main.** Not narrowed, judged legitimate:
  - The D187 Given reads "a note from **the tester subagent**". The old binding wrote it as an `agent_type` claim from an unregistered session, which is now "writer unknown" (D376, U1-F5). A SubagentStart-registered tester through the real hook is closer to the scenario's words, and the binding asserts `writer: 'tester', writer_src: 'provisional'`.
  - D186's "B's writer" names no writer, so the claim was the binding's choice. The real SessionStart plus SubagentStart is the faithful door. The orchestration header comment was updated to say so.
  - `references.test.ts` D169 ("says what a cross-writer supersedes did") registers main `m0`, so that the door is shut and the test keeps its subject: an unplaced caller's reply over a library plan. The open-door case of the same world is D378 scenario 1. Removing the registration would make the test assert the wrong (pre-D378) behaviour.

### Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | **med** | blind:surface (the door bypasses a guard the ordinary retirement keeps) | `retireAcross` (flat-store.ts:1797-1815) updates the target with `retireMeta` directly. It never reads `read_only`, while `applySupersedes` refuses a read_only target (`reason: 'read_only'`, :1856). Reviewer scratch test: a library chapter inserted with `readOnly: true`, `next_session: true`, and a session never registered. An unplaced tool caller superseding it gets `retired_across: [id]` and the target retired with an across record. The same target superseded through the library comes back `supersedeMisses: [{reason: 'read_only'}]` and stays live. The docstring says "each through the ordinary retirement". D378 adds an exception to *who* may retire, not to what can be retired. | In `isPreStampChapter`, or in `retireAcross`, skip a `read_only` row (select `read_only` in `splitSupersedes`). Report it as `supersede_misses` read_only, as the ordinary path does. Add the scratch test's world as a unit test. |
| F2 | low | vacuous at scenario level | The Then added to @D376 ("neither chapter carries a retirement across the pre-stamp boundary") runs in a world where `openGitWorld` registered main (steps :924), so the door is shut and the Then holds whatever the guard does. Probe P13 (the door's stamp test reads `_writer` only, v2's probe for this Then): the scenario stays **green**, and only `lane-door.test.ts` "leaves no across record … while the door is open" is red. The guard is held, but at unit tier through the real tool. | Accept the unit coverage and record the Then as vacuous in the audit, or bind the @D376 Given's unplaced supersession before main's session-start, so that the door is open when the client supersedes its own. |
| F3 | low | narrowed vs the U2-F1 ask | P15 (`other_lanes` := lane count) is silent in every scenario. Every scenario world still holds one pointer per other lane. The reply-shape fix is held by `session-registry.test.ts` only. | Give one scenario world (for example main status with the worktree holding a chapter and a bookmark) two pointers in one lane, so that `other_lanes` 2 ≠ `other_lane_count` 1 at charter level. |
| F4 | low | blind:surface (charter text silent) | The unplaced start's packet (deviation c) is a D373 residual that no docket comment discloses. | The coordinator adds one residual sentence to D373's comment ("a start whose registration did not land claims no checkout in the packet, status saying it could not be placed"), or a packet line. Not an owner question. |
| F5 | low | binding note not met (charter Then met) | v2 §3 asked the export Then to assert that `referencedBy` on "plan: the first release" names the retiring entry. The step def (:2263-2273) asserts the record only. The charter's Then ("both show the record") is met. | Optional: assert `referencedBy`, or record that supersession is not a reference (refs are not written for an across target). |
| F6 | info | edge, unreachable today | On a curated dedup hit, `across` targets are reported in `referenced` with the "Written by another writer" note (`missed`, :1559). That is untrue of a pre-stamp chapter, but harmless: the target is untouched and no record is written. | none, or a note variant |
| F7 | info | process | `docs/beta3-bindings-audit.md` carries no D372–D378 rows. v2 §4 listed it as touched. | The coordinator collates. |

### Probe table (U3b)

| Probe | Result |
|---|---|
| P1 incident: `hasMainCheckoutSession` → false | RED (scenario 4 "once a session has run…"; references D169) |
| P2 drop the registry-held guard (victim A) | RED (scenario 2) |
| P3 drop `agent_type` from "names no writer" (victim B) | RED (scenario 2) |
| P4 drop liveness and the handoff test (victim C, v2 iii) | RED (scenario 2) |
| P4b drop liveness alone | GREEN, as disclosed: the handoff test still guards C |
| P5 the two keys out of WRITER_STAMP_KEYS (forged record) | RED (scenario 2) |
| P6 the record's `writer` = the claimed role | RED (scenario 1) |
| P7 door open to every non-main writer | RED (scenario 3; references D169 ×2) |
| P8 drop the reply's `retired_across` | RED (scenario 1; lane-door undo) |
| P9 drop `_supersedes_across` on the retiring row | RED (scenario 1; lane-door undo) |
| P10 the undo keeps `_retired_across` | RED (lane-door undo) |
| P11 the undo keeps `_supersedes_across` | RED (lane-door undo) |
| P12 drop the bookmark exclusion | RED (lane-door bookmark) |
| P13 the stamp test reads `_writer` only | RED (lane-door own-lane); **@D376 scenario GREEN** (F2) |
| P14 self lines without the registration landing | RED (lane-door fresh start) |
| P15 `other_lanes` := lane count | RED (unit ×2); **scenario GREEN** (F3) |
| P16 `writerOf` shows a claimed role for an unplaced row | RED (unit) |
| P17 the insert reply silent for `unregistered` | RED (scenario 1; lane-door; unit) |
| P19 the packet's bookmark from any lane (U2 I-bookmark-any) | RED (unit, U2-F3 fixed) |
| P20 lane kind not the newest's (U2 I-kind) | RED (unit, U2-F4 fixed) |
| P21 lane age of the oldest (U2 I-age) | RED (unit through the real server, U2-F4 fixed) |
| zz read_only pre-stamp chapter, unplaced caller | **retired across** (F1) |

### Instrumentation (U3b)

bound 9 (4 @D378 scenarios, the @D376 scenario, plus 4 lane-door tests and 3 session-registry tests, counted as 4 unit rows) / hollow 0 / vacuous 1 (the @D376 added Then, F2) / narrowed 0 (the deviation-e rebinds judged faithful) / half-lit 0 / unlit 0 (all scenarios executing) / probes run 20 + 1 scratch / probes silent 1 at scenario level with unit cover (P15), plus 1 as disclosed (P4b)

---

## b1f9d2f — U34-fix: the U3 and U4 reviews' fixes

### Builder's claims, checked

- **Seat at k ≥ 2, and each part of the clause tested.** The guard is `k < 2` (flat-store.ts:2278). The new unit test covers each part: k = 1 keeps the best hit; k = 2 puts the chapter second; scores are equal to those on a wide page; the adaptive count is kept; a metadata filter and a time range exclude the chapter. Q1 (back to `k < 1`) and Q2 (seat first) are red. The temporal case now runs with placement on (`excludeNamespaces` widens the pool), so the listing itself is what excludes the seat. That is a better probe than before.
- **U3-2 and U3-9b now red.** Reproduced. Q3 (concurrent and ambiguous callers scoped to main) is red in "pins provisional, concurrent and ambiguous replies"; Q4 (an unplaced caller with a session id folded into main) is red in the new U3-F4 test.
- **F5 "the review's premise was wrong".** Correct. The Given writes checkpoints as `state: built/reviewed the login form` (journal-runs.steps.ts:591), so no text of a checkpoint contains "r1", and no search scope finds one by the name. U3-F5's "`scope: "all"` returns r1's checkpoints" could not hold. The rebinding:
  - asserts the scenario's Then on both the default and the widened hits (only r1's, none of r2's, both non-empty);
  - asserts the default block's lane and widen, and that r1's run-open is among the default hits;
  - walks the run by the `run` the open hit carries (`metadata_filter`, scope all), asserting both of r1's checkpoints and none of r2's. That is D309's "walks the run from them".

  The walk's query text ("state login form") is the binding's choice, not the scenario's, but it is an added assertion above an unchanged Then. Faithful.
- **Recovery identity outside the curated class, no migration.** Consequences checked:
  - **Retention is unchanged.** `isProtected` (flat-store.ts:270) reads `source_label`, `isRunAuthored`, `decay_exempt`, `read_only` and the pointer flags, never `dedup_class`. The recovery row's label is `recovery-snapshot` (`effectiveSource` from `metadata.source`, :1509), not `auto-capture`, so it was protected (agent-authored) before this commit and still is. The valve, demotion classes (`isDoorCapture`) and eviction never read the class. No row changes valve treatment.
  - **D375/D286.** The display and index boundaries ride in metadata (`recoverySnapshotBoundaries`) and are untouched. `isRecoverySnapshot` keys on `source`, so the never-quote-a-recovery-row filter still holds.
  - **Resume pointers.** A recovery row carries no `next_session` or `status`. Unchanged.
  - **The curated partial unique index.** `CURATED_INDEX_WHERE` is `dedup_class = 'curated'`; new recovery rows sit outside it, which is the point. Old rows (no `snapshot_id`/`staging_id`) keep `curated` (`recoveryIdentityOf` null). Two rows of the same text can now coexist; no index can refuse one.
  - **Export and handoff.** No export form selects by class. On import, `isDuplicateInStore` now asks `recoveryHolder` (snapshot or staging id plus `session_id`) instead of a content match. A file's recovery rows carry ids in every current form, so identity decides as before.
  - **The `run` class name.** Recovery rows share `RUN_DEDUP_CLASS` ('run'), whose doc comment reads "the dedup class of a run's rows". No code counts `dedup_class = 'run'` as run rows (grep: none in src). It is a naming wrinkle only (F9).
- **The 60 s backdate replaced by real order.** Verified (steps :2034-2058): main's PreCompact fires, then the worktree's, with no SQL on `snapshots`. Q9 (U4's P1, lane filter dropped) is red at scenario level now. U4-F2 is fixed.
- **Secret-word startup case.** It registers `sess-prior` through the real session-start main and asserts the packet line, `claimed_by` and the staged content including `snapshot_id`. U4-F4 is fixed.
- **U4-F3.** Both new snapshot tests are red under Q8 (U4's P10, `r.agent_id = ''` dropped).

### Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F8 | low | unlit | The `staging_id` fallback of `recoveryIdentityOf` (recovery-snapshot.ts:65-71) is for a snapshot claim staged by an earlier release, before the claim carried `snapshot_id`. No test reaches it: Q7 (drop `staging_id` from the identity) leaves every recovery, snapshot and D375 test **green**. The "drained twice" test stages content that carries `snapshot_id`, and it re-stages as a new staging row. A real re-drain re-reads the same staging id. | Add a unit case: stage `{queries, original_session_id}` with no `snapshot_id`, drain twice over the same staging row (or crash after the insert), and assert one row with `staging_id` set. Two such claims leave two rows. |
| F9 | info | naming | Recovery rows take `RUN_DEDUP_CLASS`, documented as "a run's rows". The behaviour is right: identity, not text. | Reword the constant's doc comment ("rows identified by their place, a run's or a recovery claim's"), or give the class its own name. Cosmetic. |
| F10 | info | edge | A tool caller may label its own metadata `source: 'recovery-snapshot'` with a `snapshot_id` and `session_id`. That row then takes the identity class and dedups onto a real recovery row of the same claim. This predates the commit in kind (`source` was already caller-writable), and it is harmless (it returns the existing id). | none |

### Probe table (U34-fix)

| Probe | Result |
|---|---|
| Q1 seat at k = 1 again | RED (seat unit) |
| Q2 seat first | RED (2 seat units) |
| Q3 U3-2: concurrent and ambiguous callers scoped to main | RED (unit; U3-F3 fixed) |
| Q4 U3-9b: an unplaced caller with a session folded into main | RED (unit; U3-F4 fixed) |
| Q5 recovery back to the curated class | RED (2 recovery-identity units) |
| Q6 no identity dedup (`recoveryHolder` always empty) | RED ("drained twice keeps one row") |
| Q7 drop the `staging_id` fallback | **GREEN (silent)** (F8) |
| Q8 U4 P10: drop `r.agent_id = ''` | RED (2 snapshot units; U4-F3 fixed) |
| Q9 U4 P1: lane filter dropped, real order | RED (**@D375 scenario**, 2 units; U4-F2 fixed) |

### Instrumentation (U34-fix)

bound 9 (D309 by name and Tuesday rebinds, @D375 real order, secret-word, plus 5 units: seat clause, concurrent/ambiguous hits, unplaced search, writer-unknown search, 3 recovery identity, 2 snapshots, counted as 5 rows) / hollow 0 / vacuous 0 / narrowed 0 (D309 by name judged faithful) / unlit 1 (staging fallback, F8) / probes run 9 / probes silent 1 (Q7)

---

## 806c309 — U5: the skill text, README and CHANGELOG

### Claims checked against the code

- **instructions.ts.** The new 15 lines are byte-identical to draft-v4 §4 (diffed). The card (`INSTRUCTIONS_BRIEF_LEXICAL`) is untouched (the diff touches `SKILL_REFERENCE_BODY` only), and the drift test passes in the full suite.
- **README and CHANGELOG, each against src:**
  - `other_lane_count` added and `other_lanes` keeping beta.2's pointer count: server.ts:1209-1213 against beta.2:906-910. True.
  - `writer_src` `unregistered`: server.ts:661-668 replies `writer: null`, `writer_src`, `writer_note`. True. The CHANGELOG does not mention that `writer` is now `null` instead of absent, nor the `writer_note` (F12).
  - The seat (last place, k ≥ 2, relevance only) matches flat-store.ts:2278.
  - The pre-stamp door, the record and `retired_across` match flat-store.ts and server.ts:713-721, including "bookmarks, stamped rows and imports never".
  - An unplaced caller's status and search are flat or whole-store, said in the reply: true (server.ts:982-986, 1153-1160).
  - A ticket worker searches the whole store: true (:957-964).
  - The recovery row is "deduplicated per snapshot and claimant": true.
  - Main's default status is now scoped: stated ("Scoped to the session's own lane: in the main checkout or a worktree, `treecontext_status` …"). Under beta.2 main listed every lane flat with no block, so this is the user-visible shape change, and the CHANGELOG states it honestly.

### Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F11 | low | doc inaccuracy | Both files say the Codex and Gemini adapters "register no session" and claim no snapshot. That holds for the scaffolding scripts in `src/hooks/{codex,gemini,cursor,opencode}`. But `install --experimental-capture` writes **the Claude Code block itself** for Codex (verbatim) and Gemini (translated) (installer.ts:1787-1804), and those hooks register a self and claim within the lane (U4-F5 found the same). A reader would take "Codex claims none" literally. | Say "the Cursor and opencode adapters, and Codex or Gemini without `--experimental-capture`, register no session"; with it, Codex and Gemini run the Claude Code hooks. |
| F12 | low | reply shape not fully stated | The insert reply for an unplaced caller changes from no `writer` key (beta.2) to `writer: null` plus a `writer_note`. The CHANGELOG says only "replies `writer_src` `unregistered`". A JSON consumer testing `'writer' in reply` would change behaviour. The new `retired_across_note` is unlisted too (additive). | Add "`writer` is `null` and a `writer_note` says why". |
| F13 | low | doc imprecision | README: "Such a client may retire **its** pre-upgrade chapters". The door retires any pre-stamp chapter of main (no stamp, session never registered); the store cannot tell whose it was. The CHANGELOG says it right ("a pre-stamp chapter of main"). | Use the CHANGELOG's wording. |
| F14 | info | skill text, drafted and approved | "Each reply says so, counts the other lanes and names the most recent three" is true of status and the packet. The **search** reply's block carries `lane`, `searched` and `widen` only, with no count (server.ts:971-978, D374). The text is draft-v4's, reproduced exactly. | Coordinator's call. If kept, the next draft could say "status and the fresh start count the other lanes". |
| F15 | info | U4-F5 carry | U4-F5 asked U5 for "a session the registry does not place adopts none". The CHANGELOG covers the adapters but not a hooked session whose registration failed (busy store). | Optional half-sentence. |

### Instrumentation (U5)

bound 0 new (docs; the drift test and journal-agent-surface green) / claims checked 14 / inaccurate 3 (F11–F13, low) / probes n/a

---

## Absent-surface hunt (all three commits)

- **New writers to the store:**
  - `retireAcross` (target `_retired_across`, retiring row `_supersedes_across`): D378, bound.
  - The heal's removal of both: D378's undo clause, bound at unit tier through the drain.
  - The drain's `snapshot_id`/`staging_id` keys and the identity class: D375, bound (the staging half unlit, F8).
  - The hook's staged `snapshot_id`: asserted in secret-word.

  No writer lacks a charter promise.
- **Half-lighting:**
  - D378's "the record is read … and the handoff export's whole form": not bound on the export side. The import side is held generically by `run-import-rule.test.ts`, which iterates WRITER_STAMP_KEYS and so now includes the two keys. Low; add a whole-form export assertion when the audit is collated.
  - The door's one producer is the insert tool, the only door that stamps `unregistered`. Not half-lit.

## Owner questions

None. Every finding resolves from the record.
