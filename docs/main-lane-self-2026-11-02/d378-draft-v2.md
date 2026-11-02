# D378 draft v2: no chapter is orphaned (R14)

v2 merges the v1 draft with the review in `d378-review.md`. The coordinator accepted these resolutions:

- (a) bookmarks are excluded;
- (b) the door is open only while the registry holds no session placed in the main checkout;
- F1 to F14 are all applied.

Sources:

- the record: R14 and R7a (main-self-rulings.md); U1 review F3, F4 and F5; D166, D169, D223, D235, D240, D241, D243, D293, D373, D374 and D376;
- the code at 7df7bd6: `splitSupersedes` (src/flat-store.ts:1722), `applySupersedes` (:1738), `retireMeta` (src/persistence/writer-heal.ts:83), `laneWriterOf` (src/references.ts:134), LIVE_POINTER (src/checkpoints.ts:247), HANDOFF_CLAIM_KEYS (src/handoff.ts:60-83), WRITER_STAMP_KEYS (src/persistence/session-registry.ts:99), and the reply (src/server/server.ts:691-701).

Nothing in the repo was edited.

**For the owner, in one line:** A tool without hooks (Codex, Cursor) can clear out an old plan written before the upgrade, and every such clearing records who, what, when and how. It can do so only in a store where Claude Code has never run in the main folder since the upgrade. Wherever main has run, only main clears main's plans, so main never comes back to find its plan gone.

## Position

1. **Which chapters.** A *pre-stamp chapter* must meet all of the following:
   - It is a live chapter summary: `next_session` true or `status` `active`.
   - It is of the main lane and names no writer: it carries none of `_writer`, `_writer_src` or `agent_type`. So `laneWriterOf` reads it as `main`, and no role claims it.
   - Its session the registry never held, by `session_key`, which is the lane read's own spelling (lane-scope.ts:97).

   A bookmark is never a pre-stamp chapter. An imported entry never is either: D223 moves its pointer state and every writer key under its claims, so it is never live, and its lane is `handoff:`.

   The test reads the row's own facts and the registry's, at the moment of the write.
2. **When.** The door is open only while the registry holds no session placed in the main checkout. That means no self row with an empty agent id and no worktree (D235's spelling), read at the write.
   - R14 reaches "a chapter that no lane can otherwise retire". Where main has registered, main can retire every pre-stamp chapter.
   - R7a says: "Do not let main's old chapters drop out of main's own thread."
3. **Who.** An unplaced writer only, that is, a row stamped `unregistered`, and only for a chapter it names in `supersedes`.
   - A worktree never gets the door: a worktree retiring main's chapter is the incident.
   - `ambiguous` retires nothing (D235).
   - Main needs no door, since it retires its own chapters today.
4. **Record.** The record is written in three places:
   - On the retired entry: `_retired_across` = `{by, writer, writer_src, session, at, how}`.
   - On the retiring entry: `_supersedes_across`.
   - In the reply: `retired_across` and `retired_across_note`.

   Both keys belong to the store. The insert tool drops a caller's copy (WRITER_STAMP_KEYS), and an import keeps a file's copy among its claims; HANDOFF_CLAIM_KEYS already spreads WRITER_STAMP_KEYS. The echo heal's undo (D240) removes both keys, and the heal's own keys record the undo.
5. **Amendment.** D378 amends D376 by restating it, with the clause inserted. It is the second disclosed departure from D169's last clause, after D376's, and it does not amend D169 [I>V] in place.

---

## §1 Docket text: paste-ready, append to features/DOCKET.md after D377

The resp is D376's text verbatim, except for two changes:

- "never a placed lane's," is removed from the supersession sentence, because the new clause states it;
- one clause is inserted, from "an unplaced writer never retires a placed lane's pointer" to "the heal's own record saying so".

The resp contains no entry ids, so the form layer is clean (see §1 lint below).

```
D378 2026-11-02 [I] amends D376
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row; or a writer the store could not place names in `supersedes` a chapter summary of the main lane that names no writer [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, and a placed lane's writer never retires one of them, recording it as a reference; an unplaced writer never retires a placed lane's pointer, with one door so that no chapter is orphaned: while the registry holds no session placed in the main checkout, an unplaced writer that names in `supersedes` a pre-stamp chapter, a live chapter summary of the main lane that names no writer, carrying neither `_writer`, `_writer_src` nor `agent_type`, whose session the registry never held, retires it, and never otherwise: never a bookmark, never by the bookmark chain, never a pointer naming a writer or carrying a stamp of any source, never one whose session the registry holds, never an imported entry, and never once a session has registered in the main checkout, each of those staying a reference as before; every such retirement is recorded on the retired entry beside the ordinary trace under one key `_retired_across`: who, the writer as the store stamped it at the retirement, "writer unknown" with the stamp source `unregistered` and the retiring row's session when it carries one, never a role the row claims; what, the retiring entry's id; when, the moment of the retirement; and how, `pre-stamp`; the retiring entry lists what it retired that way under `_supersedes_across`, beside `_supersedes_referenced`; both keys are the store's, the insert tool dropping a caller's copy and an import keeping a file's copy among its claims; the reply lists those chapters under `retired_across`, apart from the lane's own supersessions, with a note saying who, what and how; the record is read wherever the entry's metadata is read, export by id, the writer trail by `main` and the handoff export's whole form; when an echo moves the retiring row into a lane that does not own the target, the echo heal's undo restores the target and removes its `_retired_across` and the retiring row's `_supersedes_across`, the heal's own record saying so; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a live chapter that no writer in the store can ever retire, growing a client's panel forever, is the orphan this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D376 D169 D235 D240 D241 D243 D166 D223 D293 D372 D373 D374
# the U1 failure-ladder review, 2026-11-02 (finding F3): a client without hooks, Codex or Cursor, upgrades to beta.3 holding chapters it wrote before the store recorded writers, which are main's by D376, and writes its next chapter stamped `unregistered`; its `supersedes` of the old one comes back as referenced, "Written by another writer", and both stay live pointers forever, since no placed writer is present to retire main's; probe P-UPG confirmed it. Put to the owner as three options (an unplaced writer may retire a pre-stamp chapter, traced; doctor lists them for a human; disclose only): "i agree there has to be mechanism to retire so nothing is orphaned, as long as who/what/when/how is recorded". The door is the unknown lane's alone, and only where the registry holds no session placed in the main checkout. R14 reaches "a chapter that no lane can otherwise retire"; where main has registered, its writer can retire every pre-stamp chapter, and by R7a "do not let main's old chapters drop out of main's own thread": a hookless client retiring main's chapter there would leave main's next start without its thread (D373), the incident's shape (D372). A worktree retiring main's is the incident; an `ambiguous` writer retires nothing (D235). Bookmarks stay out: D166 keeps one live per ended session by design, so a pre-stamp bookmark is no orphan; they are written at the stop hook's request, so the pre-stamp ones are hooked main sessions' own, and D373 makes one main's anchor. The test is the row's own facts and the registry's, read at the write, never a release or a date: a chapter naming no writer, not even a claimed `agent_type`, which would be a role's (D243), in a session the registry never held, the same reading by which D374 and D376 give such rows to main; an imported entry is never live (D223). The record lives on the retired entry because that is the row that changed and the row main's trail reads; the retiring entry carries the list so a reader of the unknown lane finds it too; both keys are the store's, like the stamp, and travel as claims in a handoff file (D223); D293's who, when, how and what are the owner's own words for a writer no hook vouched for. The echo heal's undo of D240 removes the record with the retirement, so a live chapter never carries one. The second departure from D169's "only a lane's own writer retires that lane's pointers", beside D376's two-unplaced-writers residual, both kept so a hookless client's panel stays bounded (D166). Residuals, disclosed: main registered once and never returns, leaving its pre-stamp chapter live in its own lane for its next session; a hooked session whose registration failed is unplaced, whichever checkout it ran in, and reaches the door only where main never registered; in a store where main has registered, a hookless client's own pre-upgrade chapters stay main's (D376) and its new ones reference them; the record keeps the writer as stamped at the retirement, a later heal saying what it became in its own keys. Roads not taken: doctor listing the orphans for a human to retire by hand (a new surface, and the human is not always there); disclosure only (the panel grows without bound, D166); any writer retiring a pre-stamp chapter (a worktree's writer would retire main's, the incident); the door open in a store where main has registered until main supersedes the chapter itself (the first draft; R7a, and that window closes only by chance); bookmarks through the door (no orphan, and main's anchor); a packet line telling main its chapter was retired across the boundary (a new packet surface, needless once main's chapters are shut to the door); amending D169 [I>V] in place (D376 set the precedent of a disclosed departure)
```

No existing docket entry is edited in place; the docket never edits in place. D376 stays as written, and D378 supersedes it in effect. D378 is `[I]` and can be ratified by the same entry that ratifies D372 to D377.

**§1 lint**, run with `docketry lint DOCKET.md --corpus features --json` on a scratch copy with §1 appended and §6 applied:

| Copy | Findings |
|---|---|
| Baseline (the repo as it stands) | 59 |
| With §1 and §6 | 62 |

The 3 new findings are of the expected kinds only:
- `inferred` on the D378 trig;
- `inferred` on the D378 resp;
- `rewrite`: "D378 amends D376 under [I], below the chain's [I>V]", the same kind D376 already carries.

There is no new form finding.

---

## §2 Scenarios: paste-ready

**Target file:** `features/journal-orchestration.feature`.

**Insertion point:** after the `@D376` scenario "rows from before the store recorded writers stay the main lane's", which ends at line 227 at 7df7bd6, and before the `@D190` scenario "the session-start hook registers self and the server stamps rows from it" (line 229).

**Edit to an existing scenario:** one line added to the `@D376` scenario "an unplaced writer's chapters still supersede one another" (lines 215-220). It is shown in the second block below.

```gherkin
  @D378
  Scenario: a client without hooks retires its chapter from before the upgrade, and the retirement says who, what, when and how
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers, where no session has registered in the main checkout since
    And a client the server cannot place, after the store recorded writers, that claims the role "tester"
    When that client writes the chapter summary "plan: the second release" superseding "plan: the first release"
    Then the reply lists "plan: the first release" as retired across the pre-stamp boundary, apart from the lane's own supersessions
    And "plan: the first release" is retired, its record naming who as "writer unknown" with the stamp source and the retiring session and never the role it claims, what as the retiring entry, when as the moment, and how as "pre-stamp"
    And "plan: the second release" lists "plan: the first release" as retired across the boundary
    And that client calling status sees "plan: the second release" as a live pointer labeled "writer unknown" and no pointer of "plan: the first release" in any lane
    And exporting "plan: the first release" by id and reading the main lane's writer trail both show the record

  @D378
  Scenario: the boundary opens to no pointer that names a writer, whose session the registry holds, or that was imported
    Given the worktree "subproject"'s own live chapter summary, where no session has registered in the main checkout
    And a chapter summary written through the library with no writer stamp in the worktree "subproject"'s session
    And a chapter summary from before the store recorded writers that claims the role "tester"
    And a chapter summary imported from a teammate's handoff file
    And a client the server cannot place, after the store recorded writers, whose metadata carries a retirement record of its own making
    When that client writes a chapter summary superseding all four
    Then each of the four is as it was, the reply listing each as referenced, written by another writer, and none as retired across the boundary
    And no entry in the store carries a retirement across the pre-stamp boundary

  @D378
  Scenario: the boundary opens for the writer-unknown lane alone
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers, where no session has registered in the main checkout since
    When a session in the worktree "subproject" writes a chapter summary superseding it
    Then "plan: the first release" stays live, the reply listing it as referenced, written by another writer
    When the main checkout's session writes a chapter summary superseding it
    Then "plan: the first release" is retired as the main lane's own, carrying the ordinary trace and no record of a retirement across the boundary

  @D378
  Scenario: once a session has run in the main checkout, a client without hooks cannot retire the main checkout's chapter from before the upgrade
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    And a client the server cannot place, after the store recorded writers
    When that client writes a chapter summary superseding "plan: the first release"
    Then "plan: the first release" stays live and unchanged, the reply listing it as referenced, written by another writer, and no entry carries a retirement across the boundary
    And the main checkout's next fresh start opens on "plan: the first release" as its own chapter
```

The edit to the existing `@D376` scenario, with the added last line:

```gherkin
  @D376
  Scenario: an unplaced writer's chapters still supersede one another
    Given a client the server cannot place that wrote the chapter summary "plan: the first draft" and then a chapter summary that supersedes it
    When the main checkout's session calls status asking for every lane
    Then the developer sees the newer chapter as the one live pointer labeled "writer unknown", the first superseded
    And the main checkout's own chapter summary is still live
    And neither chapter carries a retirement across the pre-stamp boundary
```

How the Givens relate to the existing steps:

- **Existing Given, reused.** The Given "a store whose chapter summary "…" was written before the store recorded writers" (anchored regex, steps :917) runs `openGitWorld`, and that registers main's self. Only the fourth scenario uses it as it is. That is the store where main has registered.
- **New Given.** The variant ending ", where no session has registered in the main checkout since" is a new anchored step. It builds the git world without main's session-start.
- **Third scenario.** Its first When registers a worktree only, which is placed and still refused. Its second When registers main.

**Gherkin lint** (`lintFeature` from gherkin-node-test 0.11.0) on the scratch copy with §2 inserted, the `@D376` edit made and §6's header edit applied: 0 findings, the same as the repo's file today (0).

---

## §3 Binding notes: what each Then must observe

**General.** Use the real doors:
- `treecontext_insert` over `mcpOver(w, { ccSessionId })`;
- `treecontext_import` for a teammate's file;
- the session-start hook through `runHook`;
- `store.insert`, the library door, for rows with no stamp.

Every state assertion is made by direct SQLite (`rawMeta`, `rawAll` on `nodes.metadata_json` and `session_registry`), never by the reply alone.

Each Given asserts its own precondition by SQL:
- **No main registration:** `SELECT 1 FROM session_registry WHERE agent_id = '' AND worktree IS NULL AND COALESCE(kind,'') != 'worker'` is empty.
- **The unplaced client:** no registry row.
- **Pre-stamp rows:** no `_writer`, `_writer_src`, `agent_type`, `_door` or `_identity`.

"Live" means `next_session` is true or `status` is `active` (LIVE_POINTER).

**Scenario 1** (a store with no main registration; the client's metadata carries `agent_type: tester`):

- **The reply lists the first release as retired across.**
  - Assert: `retired_across` = `[first.id]`; the lane's own `superseded` does not contain `first.id`; `referenced` is absent or empty; `retired_across_note` contains "writer unknown" and "pre-stamp".
  - Probe: revert `splitSupersedes` to its two classes. The reply then gives `referenced: [first.id]`, so the Then goes red.
  - Probe: drop the `retired_across` list. The Then goes red.
- **The first release is retired, with its record.** SQL on `first.id`:
  - `next_session` is absent; `superseded_by` = `second.id`; `_superseded_prior` = `{next_session: true}`;
  - `_retired_across` deep-equals `{by: second.id, writer: "writer unknown", writer_src: "unregistered", session: <the unplaced cc id>, how: "pre-stamp"}`, with `at` = `superseded_at`;
  - the serialized record does not contain "tester".

  Probes:
  - Write only `superseded_by`. The Then goes red.
  - Put the row's claimed `agent_type` in `writer` (the slip U1 F5 found). The Then goes red.
- **The second release lists the first.** SQL on `second.id`: `_supersedes_across` = `[first.id]`, and `_supersedes_referenced` is absent.
  - Probe: drop the key. The Then goes red.
- **Status.** `treecontext_status` is called under the unplaced client's own session. Per D372, an unplaced caller sees every lane flat.
  - Assert: the pointer ids contain `second.id` labelled "writer unknown", and the serialized reply never contains `first.id`.
  - Probe: leave `first` live. The Then goes red.
  - Probe: label `second` as `main`. The Then goes red.
- **Export and trail.**
  - `treecontext_export({node_id: first.id})`: the metadata carries the record, and `referencedBy` names `second.id`.
  - `treecontext_export({writer: "main"})`: the trail includes `first.id` with the same record.
  - Probe: strip `_retired_across` from the export's metadata projection. The Then goes red.

**Scenario 2** (the side door). The world is a registered worktree "subproject" and no main registration, so the store-level guard is open and each victim fails exactly one other guard:

| Victim | Its single guard | Probe that turns it red |
|---|---|---|
| A: library row, no stamp, in the worktree's registered session | registry guard (session held) | (i) drop the registry guard → A retired |
| B: pre-stamp row claiming `agent_type: tester`, session never held | lane guard (`laneWriterOf` = `tester`, not main) | (ii) drop the `agent_type` part of "names no writer" → B retired |
| C: imported chapter (`handoff:` session, never in the registry, pointer state under claims) | liveness, and the handoff test | (iii) drop the liveness and handoff tests together → C retired (D223 makes C never live, so the handoff test has no victim of its own; disclosed) |
| D: the worktree's own stamped chapter | stamp and registry guards, both | regression victim only; no single-guard probe (disclosed) |
| forged `_retired_across` and `_supersedes_across` in the client's own metadata | WRITER_STAMP_KEYS drop | (iv) remove the two keys from WRITER_STAMP_KEYS → the forged record lands on the new row |

- **Then each of the four is as it was.** For each of A to D, `metadata_json` and `updated_at` are byte-equal before and after. The reply's `referenced` equals the four, `retired_across` is absent or `[]`, and `superseded` is `[]`. Probes (i) to (iii) above.
- **Then no entry carries a retirement across.** `SELECT count(*) FROM nodes WHERE json_extract(metadata_json,'$._retired_across') IS NOT NULL OR json_extract(metadata_json,'$._supersedes_across') IS NOT NULL` = 0. Probes (i) to (iv), with (iv) caught here only.

**Scenario 3** (who may):

- **The worktree writer's attempt.** SQL shows the row byte-equal; the reply gives `referenced: [first.id]`, and `retired_across` is absent.
  - Probe: open the door to every writer (`writer !== MAIN_LANE` instead of `writer === UNKNOWN_LANE`). The worktree retires the chapter, so the Then goes red.
- **The main writer's retirement.** Under main's registered session: `superseded_by` = the new id; `_superseded_prior` is set; `_retired_across` is absent; the new row has no `_supersedes_across`; the reply gives `superseded: [first.id]`, and `retired_across` is absent.
  - Probe: stamp the record on every retirement of an unstamped target. The Then goes red.

**Scenario 4** (the incident guard; main registered through `openGitWorld`):

- **The chapter stays live and unchanged.** SQL shows the row byte-equal and live; the reply's `referenced` = `[first.id]`; the store-wide count is 0.
  - Probe: delete the store-level guard (no main-checkout registration). The chapter is retired, so the Then goes red. This is the incident probe.
- **Main's next fresh start.** A real startup SessionStart runs through `runHook` for a new main-checkout session. The packet's self line (D373) names "plan: the first release" as the main lane's own chapter, by its id. Read the packet, never the reply.
  - The same probe turns this Then red: the packet says it starts fresh.

**Existing `@D376` scenario, the added Then:** both chapters have neither `_retired_across` nor `_supersedes_across`.
- Probe: make the door's stamp test read `_writer` only, not `_writer_src`. The unknown lane's own earlier chapter, which has `_writer_src` `unregistered` and no `_writer`, then gets the across record, so the Then goes red.

**Unit test for the undo (D240; no scenario).** This is end-to-end through the drain:
1. An unplaced Claude Code session retires a pre-stamp chapter across.
2. A PostToolUse echo of that insert call, carrying a subagent's agent fields, is staged and drained.

SQL asserts:
- the target is live again, with no `_retired_across`;
- the retiring row has no `_supersedes_across`, and its `_writer_heal_unretired` names the target.

Probe: leave the record in place on the undo. The test goes red. The self-unplaced echo returns early in the heal (U1 F8), so the echo must carry agent fields.

**Unlit check** (the lesson of U1 F1): the four `@D378` scenarios and the edited `@D376` scenario must leave the `wip` list in `tests/journal/features.test.ts` before the unit closes. Every probe above is re-run against the executed step definitions.

Every Then here is observed by the reply plus direct SQLite through a real door. None can be checked only by reading code.

---

## §4 Build notes

**The unit.** A small unit of its own, after U2 and before U3 closes. Sonnet can build it with the probes spelled out in §3; then an Opus failure-ladder review. Record the per-unit binding counts (R11).

**Files likely touched:**

- **`src/flat-store.ts`.** `splitSupersedes` (:1722) gains a third class, `across`. A target is `across` when all of these hold:
  1. the writer is `UNKNOWN_LANE`;
  2. the target is live (LIVE_POINTER's two flags);
  3. it is not a bookmark (`kind` is not `bookmark`);
  4. `laneWriterOf(target) === MAIN_LANE`, and it has none of `_writer`, `_writer_src` or `agent_type`;
  5. its `session_key` is not in `SELECT session_id FROM session_registry`;
  6. there is no row in `session_registry` with an empty agent id and no worktree. Read this once per insert, excluding a ticket door worker's registration (`notWorker`, `kind` `worker`): a worker is never a session's self (D288).

  Then:
  - the insert transaction applies `across` through `applySupersedes` with the record;
  - it sets `_supersedes_across` on the new row;
  - it returns `retiredAcross` in `InsertResult`.

  The bookmark chain (`withPriorBookmarks`) is untouched.
- **`src/persistence/writer-heal.ts`.**
  - `retireMeta` takes an optional `across` record and writes `_retired_across`.
  - The undo (`unretire`, and the heal's revert path) deletes `_retired_across` from the target and `_supersedes_across` from the retiring row, and lists the target under `_writer_heal_unretired` as it does today.
- **`src/references.ts`.**
  - Add the constants `RETIRED_ACROSS_KEY`, `SUPERSEDES_ACROSS_KEY` and `PRE_STAMP_HOW = 'pre-stamp'`.
  - The record's `writer` is `UNKNOWN_WRITER_LABEL`, never `writerOf(meta)`, because `writerOf` still returns a claimed `agent_type` for an unplaced row (U1 F5, fixed separately).
- **`src/persistence/session-registry.ts`.** Add `_retired_across` and `_supersedes_across` to WRITER_STAMP_KEYS. The insert tool's drop (server.ts:476) and the import's claims (handoff.ts:81) then follow with no further edit.
- **`src/server/server.ts`.**
  - Add `retired_across` and `retired_across_note` to the reply (:691-701).
  - The `supersedes` description (:415-421) gains one sentence: "A client the server cannot place may retire a chapter written before the store recorded writers, where no session has run in the main checkout; the retirement is recorded on both entries."
  - The fix for the reply's `writer_src` `unregistered` (U1 F4) is made under D235, not D378.
- **`src/server/instructions.ts`.** No change; the door is a corner, not a protocol step.
- **`tests/journal/steps/journal-orchestration.steps.ts`.** Reuse `olderChapter`, `unplacedChapter`, `laneChapter`, `mcpOver`, `rawMeta`, `runHook`, and the handoff steps' import helper. Add:
  - a git world without main's session-start;
  - `unplacedChapter` with extra metadata (`agent_type`, forged keys);
  - a role-claiming `olderChapter`;
  - a library chapter in a registered worktree session.
- **Also touched:**
  - `tests/journal/features.test.ts` (the wip list);
  - a unit test for the undo (writer-heal or ingestion tests);
  - `features/DOCKET.md` (§1);
  - `features/journal-orchestration.feature` (§2 and §6);
  - `features/OUT-OF-SCOPE.md` (§6);
  - `docs/beta3-bindings-audit.md`: five scenarios, with their rungs and the two disclosed non-single-guard victims (C's handoff test, D).

---

## §5 Open questions

None. Choices (a) and (b) were resolved from the record (R14's reach, R7a, D166, D169, D373) and accepted by the coordinator. The one-line summary at the top is for the ratifying read.

---

## §6 Header and fence edits: paste-ready

**1. `features/journal-orchestration.feature`, the narrative (lines 5-8).**

Replace:

```
  lane so long as the row names its writer and what it refers to; nothing
  outside the writer's own lane is modified; a cross-lane reference is a
  pointer the owning lane sees, never a flag flip.
```

with:

```
  lane so long as the row names its writer and what it refers to; nothing
  outside the writer's own lane is modified; a cross-lane reference is a
  pointer the owning lane sees, never a flag flip, save one door: a client
  the server cannot place may retire a chapter written before the store
  recorded writers, recorded, where no session has run in the main
  checkout.
```

**2. `features/journal-orchestration.feature`, the rulings list (lines 16-20).**

Replace:

```
  interview, 2026-10-05 to 2026-10-07; D263 of 2026-10-10; D372 to D376
  of 2026-11-02 (the main checkout's own lane: status, the fresh start,
  the search scope read from the registry, the recovery snapshot's lane,
  the unknown writer). Group orientation (D168) is
```

with:

```
  interview, 2026-10-05 to 2026-10-07; D263 of 2026-10-10; D372 to D376
  and D378 of 2026-11-02 (the main checkout's own lane: status, the fresh
  start, the search scope read from the registry, the recovery snapshot's
  lane, the unknown writer, the chapter from before writers were
  recorded). Group orientation (D168) is
```

**3. `features/OUT-OF-SCOPE.md`, the declined-alternatives list.** Insert after the D376 line ("- Lane derivation: … (D376, 2026-11-02)", about line 456):

```
- Orphaned pre-stamp chapters: doctor listing them for a human to
  retire; disclosure only; any writer retiring one; the door open where
  main has registered; bookmarks through the door; a packet line telling
  main its chapter was retired. (D378, 2026-11-02)
```

The fence's line "Lane model: cross-lane supersession that retires the target; …" (D169) stays as it is. D378 is a disclosed departure, as D376's is, not a reversal of that declined road.
