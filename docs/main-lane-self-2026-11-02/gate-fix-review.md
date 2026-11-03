# Review: the D379 gate fix (5c5c7a7 on d9daa16, branch beta3-pointer-lane)

Reviewer: Opus failure-ladder reviewer, in a detached worktree at 5c5c7a7 (`git log -1` confirmed). Read-only: no commits, no treecontext MCP calls, no store writes. Every mutation was applied from a scratchpad script (`probe.py` + `probes.json`): the file was backed up, the filtered tests were run, the file was restored byte for byte (sha256 checked), and `run-manifest.ndjson` was checked out after each run. One reviewer scratch test (`tests/zz-review-d379.test.ts`, worlds Z1 to Z3) was in `tests/` for the probe runs and is removed. node_modules was symlinked for the runs and the link is removed. `git status` is clean.

Each probe ran two sets. The unit set was `session-registry`, `references`, `lane-door`, `search-placement` and the scratch test. The scenario set was `features.test.ts -t "Orchestration inside one store|Re-orientation after a clear"`, which is every journal-orchestration scenario plus D186's re-orientation scenario. Unmutated baseline: all of them green (the @D379 scenario passed in 1.5 s). After the run: typecheck 0 (ratchet held), lint 0. I did not rerun the full suite or the docket lint; those numbers are the builder's.

## Verdict

**Accept with fixes.** The commit fixes what gate finding #1 named: status, the packet's self lines, the other-lanes line, supersession's targets, the echo heal, the target lane of the referrer shown, and a subagent's scope now read a pointer's lane from the registry before the stamp. No real door's helper row becomes a checkout's own (R8). No row from before writers were recorded changes lanes, and the D378 door cannot disagree with the placement.

Two findings should be fixed before release, because they bear on the promise D379 itself makes:

- **F1:** "one lane for every reader" is still false in three verified cases. One of them is gate finding #1's own shape: main's status and packet against main's search, for an unstamped chapter in a ticket-door worker's session.
- **F2:** the new rule's exclusions (R7, R8, D235, D243) are held at no reader at all. Every probe of mine is silent at scenario level, including dropping the own-agent test entirely, and five probes are caught only by the pure-function test of `laneOfRow`.

## The builder's claims, checked

- **Every reader uses `laneOfRow`.** Verified by grep.
  - These call it: `livePointers` (checkpoints.ts:685), status `laneKeys` (flat-store.ts:2385), `subagentScopeFor` (:694), the bookmark chain (:1570), `splitSupersedes` targets (:1804), the inserting row (`FlatStore.laneOf`, :1823, lazy), the heal (`laneReader`, memoised per session), and `referencedBy`'s target and referrers (references.ts:315).
  - These `laneWriterOf` calls remain, and each is legitimate:
    - :687 and :2392 turn a registry self or a lane name into a lane key.
    - `FlatStore.laneOf`, the heal's `laneReader`, and `laneOfRow`'s fallback use it only for rows that are not the session's own agent's.
  - The remaining `writerOf` calls (references.ts:324, runs.ts:371/613, key-lookup.ts:304/346) give the writer that is *shown*, not a lane. They are display only and legitimate. An unstamped library referrer is shown by its session id, as before.
- **"Search is unchanged."** Mostly true, with one exception: the per-hit referrer annotation (flat-store.ts:2165 → `referencedBy`) now reads the registry. See F7. The search's *scope* (`laneRowsSql`) and its own-chapter seat (`laneReach`) are unchanged, and that is the source of F1.
- **"Own agent" mirrors the trail's helper subtraction.** True of the **trail** reading (`laneRowsSql` 'trail': no `_writer_agent_id`, not `unregistered` or `ambiguous`, `_writer` a checkout's or null with no `agent_type`). It is **not** true of the **search** reading, which subtracts only `_writer_agent_id` (unless the row is a report) and `unregistered`. See F1 (a) and (b).
- **The D378 door is untouched and never opens for a row whose session the registry holds.** Verified read-only. `splitSupersedes`' `doorOpen` and `isPreStampChapter` are unchanged. The door requires a session the registry never held. Never held implies placed nowhere, so the target's lane falls to its stamp, which is main for an unstamped chapter with no `agent_type`. The door's precondition and the placement cannot disagree. The four @D378 scenarios are green, and green under every probe.
- **Charter.** D379 [I] is a dated amendment, and D376 is not edited. The @D379 scenario is at journal-orchestration.feature:272 (the header reflow keeps the line count). The audit rows are added. The text is honest except where F1 and F6 say otherwise.
- **"Every reader reverted alone goes red."** Partly. I did not redo the builder's status and packet reverts. My own probes were each reader's *own half* or each guard of `isSessionOwnRow`. Every one of them is silent at scenario level, and four are silent everywhere (P6, P8, P12, P13). See the probe table, F2, F3 and F4.
- **Disclosed: the @D379 search Then held before the fix.** Confirmed by reading. The search's scope was already from the registry, so that Then binds agreement only.
- **Disclosed: `_writer_agent_id` with no `_writer` lands in main.** Not reachable through any real door. See F8.

## Questions 1 to 6, in brief

1. **Correctness.** At every changed reader the rule matches R7, R7a and R10. One case follows the D379 text but not R7/R7a's era cut: a session the registry holds but places nowhere. `laneOfRow` gives that session's unstamped rows to main, while the search, the trail and D378 treat it as "held, so not pre-stamp". See F1 (c).
2. **Helpers.** No real door produces a helper row that `isSessionOwnRow` accepts:
   - The hooks door, `legStampFor`, a provisional stamp, the drain's subagent stamp and the drain's worker stamp all carry `_writer_agent_id` *and* a role `_writer`.
   - `declaredStampFor` carries a role `_writer`.
   - `agentWriterOf` escapes `main` and `worktree:` into `agent:`.
   - A worker's session has no self row (agent_id `worker`), so it is never placed.

   The disclosed `_writer_agent_id`-without-`_writer` case is reachable only by a library caller that writes the stamp keys by hand. But a ticket-door worker's session *can* get an unstamped chapter counted as main's own: F1 (c), verified.
3. **Pre-stamp rows and D378.** No row whose session the registry never held changes lanes. The rows that move are unstamped rows in sessions the registry places, for example an earlier release's worktree session resumed after the upgrade. They move to that checkout, which matches D374's search and the "earlier release's conversation" scenario. D378: see above. They cannot disagree.
4. **Hollow green.** The @D379 scenario is not hollow. It uses the real SessionStart hook per checkout, the library door under test, the real status tool, the real hook packet and the real query tool, and it reads expected lanes from the test's own record. But it binds only the status and packet halves. Every other part of the rule lives at unit tier or nowhere. See F2, F3, F4 and the probe table.
5. **Charter.** The text is owner-language, and the amendment form is right. Three overclaims: "a pointer's lane is read as a lane's default search reads it", "and the search read[s] the one lane", and the CHANGELOG's "as the search already read it". F1 refutes all three. D379 amends D376 but restates and replaces D378's resp, and D378 has no forward pointer. See F6.
6. **Cost.**
   - Captured-row inserts read no registry: `writerLaneOf` is lazy, `splitSupersedes` returns before it when there are no ids, and the bookmark chain runs only for non-auto bookmarks.
   - Status, the packet and the subagent scope make one placement read per call (chunked at 500 ids).
   - The heal makes one placement read per distinct session per heal.
   - **The search adds one placement read per hit that has referrers** (F7). That is bounded by `top_k` and is a primary-key lookup.

## Findings

| # | Sev | Rung | Evidence | Fix |
|---|---|---|---|---|
| F1 | **med** | half-lit: D379's "one lane for every reader" promise, with the search left on its own reading (`cino:` producer-agnostic promise bound through some producers only) | Verified with scratch worlds. **(a) Z1:** a chapter written through the real insert tool in worktree `wt` while two subagents were live (stamped `ambiguous`). The worktree's status lists no pointer of its own and counts it under "ambiguous writer". The worktree's packet says "No chapter summary … starts fresh" and names "ambiguous writer" among the other lanes. The worktree's lane-scoped search finds it, and `laneReach('worktree:feature-login').ownChapters` **holds it**: the search seats it as the worktree's *own* chapter. D379's resp says "a row stamped `ambiguous` is never a worktree's own chapter". **(b) Z2:** a library chapter in `wt`'s session claiming `agent_type: tester`, no stamp. Status gives it to the lane "tester". The worktree's search scope finds it, and it is eligible for the seat. **(c) Z3, gate finding #1's shape:** main and `wt` are registered, a ticket-door worker `wk` (parent `wt`) is registered through `registerWorkerLeg`, and a library chapter with no stamp is written under `_cc_session_id: wk`. **Main's status lists it as main's own**, and **main's packet opens on it** ("The main lane's own chapter summary … plan: zebra quokka worker notes"). Main's lane-scoped search does not find it, and `writerTrail('main')` does not include it. Cause: `laneOfRow`'s fallback sends an unstamped row whose session is "placed in no checkout" to main. The search, the trail and D378 all use "the registry never held the session" (R7a's era cut). The same split covers a session whose self registration failed while a subagent's landed. This is not a regression (D376 behaved the same), but D379 now promises it away, and a worker's session is a helper's, so R8 is touched as well. | (c): make `laneOfRow`'s unstamped fallback main **only for a session the registry never held**. Have `placementsOf` also return the held set. An own-agent unstamped row in a held but unplaced session is then "writer unknown", which is R7's reading (written while writers were recorded, writer not identified) and the search's and D378's cut. Add Z3 as a unit test, and preferably as a scenario Then (a worker's library chapter never opens main's packet). (a) and (b): filter `laneReach`'s `ownChapters` (and, preferably, the pointers whose refs form the lane's reach) through `laneOfRow(...) === lane`, so the seat never calls a non-own chapter "own". Then either reword D379 to say the search's *scope* is wider than the lane's own pointers (helper reports, imports, rows its own agent could not be told apart), or subtract `ambiguous` and role claims from the search scope too. That choice may be the coordinator's or the owner's. |
| F2 | **med** | narrowed: R7, R8, D235 and D243's exclusions of the new rule are bound only by the pure function, never by a reader (and nothing at scenario level) | P1 (drop `isSessionOwnRow` from `laneOfRow`, so every helper's pointer in a placed session becomes the checkout's own) is **silent in every scenario**. Only the direct `laneOfRow` unit test catches it. P2 (role claims), P3 (`unregistered`), P5 ("whatever its stamp" narrowed to unstamped rows) and P16 behave the same way. P4 (`ambiguous`) is also caught by the older reader-level ambiguous test. The subagent scenarios stay green under P1 because `FlatStore.laneOf` re-checks `isSessionOwnRow` itself for the *writer*, so supersession is guarded twice while status and the packet are guarded once. | Add at least one reader-level guard of R8 under the new rule, preferably a scenario: a worktree session with a hooks-door-registered subagent that writes a live chapter through the real tool. The worktree's status and its next packet list it under the subagent's role, never as the worktree's own. Add a status-level unit test for an `unregistered` row in a session that was registered later, and one for a stamped row whose placement differs (P5's "whatever its stamp"). |
| F3 | low-med | unlit: claimed reader with no test | P8: the inserting row's own lane (`FlatStore.laneOf`) put back on the stamp alone. **Green everywhere.** In the unit test "supersession reads the same lane" the writers are tool callers whose stamp equals their placement, so the writer half is never exercised. The case is reachable through D379's own door: a program writes a second chapter through the library in `wt`'s session with `supersedes` naming the first. Under P8 the first stays live as "referenced", and the worktree keeps two live chapters. | Unit test: a library insert (no stamp, `_cc_session_id: wt`) that supersedes the earlier library chapter of `wt` is superseded. The same insert under main's session id leaves it referenced. |
| F4 | low | unlit | P6 (the bookmark chain's prior bookmarks read by the stamp) and P12 (`referencedBy`'s referrers read by the stamp) are **green everywhere**. Both differ only for unstamped library rows in placed sessions, which no test builds. P13 (`placementsOf` counting non-self registrations, such as a worker or a subagent's own worktree) is **green everywhere** as well. | Unit cases: (i) two unstamped library bookmarks in `wt`'s chain, where the second retires the first; (ii) an unstamped library referrer in `wt` to a main chapter is shown as the other lane's; (iii) `placementsOf` places nothing for a worker registration or a subagent-only session. |
| F5 | low | process: the probe claim overstated | The commit and audit say "each reader put back on the stamp alone is red in its own test". That holds for the target side of each reader. It does not hold for the writer side of supersession (F3), the bookmark chain or the referrers (F4). The audit row's "silent 0" is not accurate. | Correct the audit's D379 row: list P6, P8, P12 and P13 as silent until F3 and F4 land, and P1 to P5 as unit-only (F2). |
| F6 | low | charter: self-consistency | D379 is written "amends D376", but its resp restates D378's whole resp and replaces its lane clause. D378 has no forward pointer, so a reader of D378 meets a superseded resp. D379's "a pointer's lane is read as a lane's default search reads it" and the CHANGELOG's "as the search already read it" are refuted by F1 (a) and (b). The D379 resp also cuts the pointer lane at "places in no checkout" and the trail at "never held", which is F1 (c) inside one entry. | Mark D379 as amending D378 as well (or add the forward note in D378's comment, if the docket grammar takes one amendee). Replace "as a lane's default search reads it" with "from the registry, as the lane's own rows are read". After the F1 fix, use one cut (never held) in both clauses. |
| F7 | info | cost | `referencedBy` now runs `placementsOf` once per call. The search calls it for each result (flat-store.ts:2165), so a hit with referrers costs one extra registry read. The read is bounded by `top_k`, is indexed by primary key, and is skipped for hits with no referrers. Captured-row inserts read nothing new. | None needed. Optionally pass one placement map for the whole result page. Correct "Search is unchanged" in the record. |
| F8 | info | disclosed residual, unreachable | A `_writer_agent_id` with no `_writer` lands in main. No real door writes that. The drain sets `_writer` whenever it sets `_writer_agent_id` (ingestion.ts:661-688). `stampMetadata` (provisional, worker), `legStampFor` and the heal set both. The insert tool drops a caller's stamp keys. Imports sit in `handoff:` lanes, which are never placed. Only a library caller that writes the stamp by hand reaches it. P16 (the handoff test inside `isSessionOwnRow`) is likewise redundant for real readers. | None. Keep it disclosed. |

## Probe table (reviewer's own; the builder's status, packet and whole-fix reverts were not redone)

| Probe | Mutation | Unit set | Scenarios |
|---|---|---|---|
| P1 | `laneOfRow`: placement for every row (`isSessionOwnRow` dropped; R8) | RED (laneOfRow unit only) | **GREEN** |
| P2 | `isSessionOwnRow`: a role claim (`agent_type`) still own | RED (laneOfRow unit only) | **GREEN** |
| P3 | `isSessionOwnRow`: an `unregistered` row own | RED (laneOfRow unit only) | **GREEN** |
| P4 | `isSessionOwnRow`: an `ambiguous` row own | RED (laneOfRow unit + D190 ambiguous unit) | **GREEN** |
| P5 | placement only for unstamped rows ("whatever its stamp" narrowed) | RED (laneOfRow unit only) | **GREEN** |
| P6 | bookmark chain: prior bookmarks by the stamp | **GREEN** | **GREEN** |
| P7 | `splitSupersedes` targets by the stamp | RED (D379 supersession unit) | **GREEN** |
| P8 | the inserting row's lane by the stamp (`FlatStore.laneOf`) | **GREEN** | **GREEN** |
| P9 | the heal's `laneReader` = the stamp | RED (D379 heal unit) | **GREEN** |
| P10 | the heal's step 3 (asked targets) by the stamp | RED (D379 heal unit) | **GREEN** |
| P11 | `referencedBy` target lane by the stamp | RED (D379 referrer unit) | **GREEN** |
| P12 | `referencedBy` referrers' lanes by the stamp | **GREEN** | **GREEN** |
| P13 | `placementsOf` counts non-self registrations | **GREEN** | **GREEN** |
| P15 | `subagentScopeFor` by the stamp | RED (D379 scope unit) | **GREEN** |
| P16 | `isSessionOwnRow`: the handoff test dropped | RED (laneOfRow unit, with a placement no real import has) | **GREEN** |
| Z1 | scratch: an `ambiguous` chapter via the real tool in `wt` | status and packet: "ambiguous writer"; search: found, **seated as wt's own** (F1a) | n/a |
| Z2 | scratch: a role-claimed library chapter in `wt` | status: "tester"; search: found (F1b) | n/a |
| Z3 | scratch: an unstamped library chapter in a ticket-door worker's session | **main's status own, main's packet opens on it**; main's search and main's trail: absent (F1c) | n/a |

## Instrumentation (D379 gate fix)

bound 1 scenario + 6 units / hollow 0 / vacuous 0 (the search Then is agreement only, disclosed) / narrowed 1 (F2: the rule's exclusions bound only by the pure function) / half-lit 1 (F1: the search's own reading, and the held but unplaced cut) / unlit 4 (P6, P8, P12, P13) / probes run 15 + 3 scratch worlds / probes silent at scenario level 15 of 15; silent everywhere 4.

---

## Re-check of 79e468c (the fix for this review), 2026-11-03

This was a short, bounded re-check in the same detached worktree at 79e468c, with the same read-only rules. I used my own harness (`probe2.py` + `probes2.json`): each mutation was restored byte for byte and `run-manifest.ndjson` was checked out after each run. The unit set was `session-registry`, `references`, `lane-door` and `search-placement`; the scenario set was the orchestration and re-orientation scenarios. I re-pointed my 15 probes at the new code, added the three reverts of the fix, and added two probes of my own (H1, K2). The node_modules link is removed and `git status` is clean.

**Verdict: Accept.** F1 through F6 are closed as claimed. The builder's probe table reproduces line for line, and no new finding is above info.

### (a) Probe table at 79e468c

| Probe | Unit set | Scenarios | Builder's table |
|---|---|---|---|
| P1 own-agent test dropped | RED ×4 | **RED** (the new @D379 helper scenario) | matches |
| P2 role claim own | RED ×2 (incl. Z2) | green | matches |
| P3 `unregistered` own | RED ×2 (incl. the new status-level test) | green | matches |
| P4 `ambiguous` own | RED ×3 (incl. Z1) | green | matches |
| P5 "whatever its stamp" narrowed | RED ×2 (incl. the new status-level test) | green | matches |
| P6 bookmark chain by the stamp | RED (new bookmark-chain unit) | green | matches |
| P7 supersession targets by the stamp | RED ×2 | green | matches |
| P8 the inserting row's lane by the stamp | RED ×3 | green | matches |
| P9 heal reader = the stamp | RED | green | matches |
| P10 heal step 3 by the stamp | RED | green | matches |
| P11 referrer target by the stamp | RED | green | matches |
| P12 referrers by the stamp | RED (new unit) | green | matches |
| P13 non-self registrations place | RED ×4 | green | matches |
| P15 subagent scope by the stamp | RED | green | matches |
| P16 handoff test dropped | RED (pure-function unit) | green | matches |
| R-F1c (held-unplaced cut removed, so main again) | RED ×4 (Z3, subagent-only session, door gate, laneOfRow unit) | green | matches |
| R-seat (seat back to the scope's chapters) | RED ×2 (Z1, Z2) | green | matches |
| R-door (`stampedUnknown` gate dropped) | RED (door-gate unit) | green | matches |
| **H1 (mine)**: every never-held session read as held (R7a's cut gone) | RED ×9 | **RED ×4** (main's status scoped, rows from before writers stay main's, the boundary opens for writer-unknown alone, once main has run) | n/a |
| **K2 (mine)**: the seat's lane key for main left as `main`, not MAIN_LANE | RED ×2 (seat units) | **RED** (two hundred helpers) | n/a |

Every probe is red somewhere. The never-held cut (H1) and main's seat (K2) are held at scenario level. F1c's held-but-unplaced cut is held at unit tier only, which is acceptable because no scenario world has a worker or a subagent-only session with a library chapter. Optionally, the audit can say so.

### (b) The door gate (`stampedUnknown`)

At 5c5c7a7, `writer === UNKNOWN_LANE` could arise only from a row stamped `unregistered`, because `laneWriterOf` yields UNKNOWN_LANE only through `isUnknownWriter`. At 79e468c, UNKNOWN_LANE also arises for an unstamped row in a session the registry holds but places nowhere. The gate `isUnknownWriter(meta)` therefore puts the door's set of writers back exactly where it was, so D378's scenarios and R14 promise the same thing as before. All four @D378 scenarios are green, and H1 shows that their guard is live.

Which real doors write an unplaced retiring row that is not stamped `unregistered`?

- **Tools:** none. `resolveWriter` stamps `unregistered` for any session with no self and no live subagent. A worker is `declared` under its role, not unplaced.
- **Hooks door and ticket door:** none. Both stamp through `legStampFor` or `hooksDoorStamp`.
- **Library:** only an unstamped library write in a held-but-unplaced session (a worker's session, or a subagent-only session).

That library writer no longer opens the door. It also no longer retires main's chapters as its own, which it could do at 5c5c7a7 and before, because it read as main. That is the R8-correct change. R14 is not touched, because nothing becomes orphaned. A pre-stamp chapter is still retirable by main, or by an `unregistered` writer while the door is open. The library writer's own chapters are writer unknown, and that lane's writers (stamped or unstamped) retire them as one lane, by D379's "rows of undetermined writers are one lane for supersession". The record's "who" stays true, because only a row actually stamped `unregistered` can be named "writer unknown, `unregistered`".

### (c) The new @D379 scenario (journal-orchestration.feature:285)

It is not hollow:

- The worktree's session registers through the real SessionStart hook and writes its chapter through the real insert tool.
- The tester registers through the real SubagentStart hook in the worktree.
- The tester's chapter goes through the real tool (`provisional`). The real PostToolUse echo and the production drain then heal it to `_writer: tester`, `echo`, with its agent id. The Given asserts this from SQLite.
- Status is the real tool, and the packet is the real hook's output.

Under P1 it fails at the first Then's `expect(pointersOf(status)).not.toContain(tester.id)`. The tester's chapter was listed among the worktree's own pointers. That is the right reason: the registry placed a helper's row. The Then also pins `block.lanes` to the "tester" entry, and it pins the packet's other-lanes line. The second Then pins that the worktree's own chapter still leads.

### (d) The D379 and D378 text against R7, R7a, R10 and R12

- **R7.** A row with no stamp in a session the registry holds but places nowhere is now "writer unknown", never main's. That is R7's reading. ✓
- **R7a.** Main receives unstamped rows only where the registry never held the session. That is the era cut, the same cut as the search, the trail and D378. One residual remains, inherent and named in the text: a post-upgrade library write under a fresh, never-held session id is still main's. ✓
- **R10.** "read from the registry at the moment of the read … never written onto a row", and "no row already stored is rewritten". ✓
- **R12.** "a lane's default search may find a row that is not the lane's own … and never presents it as the lane's own chapter". That matches the seat filter, and the scope is unchanged by design (a road not taken, with its reason). ✓

The overclaim ("as a lane's default search reads it") is gone. Both clauses now use one cut. D378 carries the forward note to D379. The door clause now says "its row stamped `unregistered` … never by a row carrying no stamp", which matches the code. One phrase in D379's original comment is older than the gate: "The D378 door is unchanged: it opens only for a chapter whose session the registry never held". It is still true of the target, and the appended correction states the writer gate. This is acceptable.

### Residual (info, not from this commit)

`resolveWriter`'s `concurrent` branch stamps `writer: selfWriterOf(self)` even when `self` is null, which gives `main`. A session whose self registration failed, while a subagent's registration landed and the main agent was seen, therefore writes rows stamped `main`/`concurrent`. They read as main's, because `laneOfRow`'s held-unplaced cut applies only to unstamped rows. The heal's `selfWriterOf(null)` has the same shape. This edge predates D379 and is narrow (it needs a failed SessionStart plus a SubagentStart plus a later main event). The `ambiguous` branch already omits the writer when there is no self. Optional fix: have `concurrent` with no self stamp `unregistered`.
