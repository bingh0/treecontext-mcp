# D378 draft — no pointer is orphaned (R14)

Drafted 2026-11-02 from the record: R14 (main-self-rulings.md:51), the U1
review's F3 (with F4, F5 for the reply's and the label's honesty), D169,
D235, D240, D241, D243, D376, and the code as it stands at 7df7bd6
(`splitSupersedes` src/flat-store.ts:1722, `applySupersedes` :1738,
`retireMeta` src/persistence/writer-heal.ts:83, the reply
src/server/server.ts:691-701, `laneWriterOf` src/references.ts:134).
Nothing in the repo was edited.

## Position, derived (not invented)

1. **Which pointers.** A *pre-stamp pointer* is a live resume pointer
   (chapter summary or bookmark, `next_session` true) that (a) carries no
   writer stamp at all — neither `_writer` nor `_writer_src` — and (b)
   whose session (`_cc_session_id`, else its session key) the session
   registry holds no row for, and (c) sits in no `handoff:` lane. Both
   facts are the row's own and the registry's, readable at the moment of
   the write; nothing is inferred from dates or releases. This is the
   reviewer's own definition in F3's fix ("pointers that carry no stamp
   and whose session the registry never held") and D374's phrase "the
   rows of sessions the registry never held". A library-written pointer in
   a session the registry never held is indistinguishable from one written
   before beta.3 and is treated the same; disclosed in the comment.
   **Side door closed:** main's and a worktree's chapters are stamped
   (`_writer` `main` / `worktree:<name>`, `_writer_src` `self`/`echo`),
   so they fail (a); an unstamped row of a session the registry holds
   (a library write in a registered session, an earlier release's
   worktree conversation re-registered, F7's case) fails (b); an imported
   chapter fails (c). All of these stay "referenced", exactly as today.
2. **Who.** The writer-unknown lane only (a row stamped `unregistered`).
   R14's parenthetical names it. Main needs no door (a pre-stamp pointer
   is main's own by R7a/D376, main retires it today); a worktree must not
   have one (a worktree retiring main's pointer is the incident, D372);
   an `ambiguous` writer retires nothing (D235) and that stands. R2's
   symmetry is between main and the worktrees, lanes that each have a
   writer of their own; the unknown lane is the one lane that may *be*
   main's client (a hookless Codex/Cursor) without being main's writer,
   so it alone is orphaned, and it alone gets the door. The door opens
   only to a pointer named in `supersedes`; the bookmark chain never
   crosses it.
3. **Who/what/when/how, recorded.** On the retired entry, beside the
   ordinary trace (`status` `superseded`, `superseded_by`,
   `superseded_at`, `_superseded_prior` for D241's undo), one key
   `_retired_across` = `{by, writer, writer_src, session, at, how}`:
   `by` the retiring entry's id (what), `writer` the label `writer
   unknown` with `writer_src` `unregistered` and `session` the retiring
   row's `_cc_session_id` when it has one (who, as the store knows it —
   never the role the row claims, F5), `at` the moment (when), `how`
   `pre-stamp` (the mechanism: supersession across the pre-stamp
   boundary). On the retiring entry `_supersedes_across: [ids]` (what,
   beside `_supersedes_referenced`). The insert reply lists them as
   `retired_across` with a `retired_across_note` and says the writer it
   stamped is undetermined (`writer: null`, `writer_src: "unregistered"`,
   F4's fix for this call). A human sees it where every trace is seen
   today: `treecontext_export(node_id)` of the retired entry, the writer
   trail `treecontext_export({writer: "main"})`, and the handoff export's
   whole form; status `scope: "all"` shows the retiring chapter as the
   unknown lane's live pointer and the retired one gone from main's. No
   doctor row, no packet line (roads not taken, in the comment).
4. **Amendment.** D378 amends D376 (restating it, as the grammar
   requires) and is the second disclosed departure from D169's last clause
   ("only a lane's own writer retires that lane's pointers"), following
   D376's precedent of naming the departure in the comment with the
   owner's words rather than amending D169 [I>V] itself. D241's reversal
   clause applies unchanged (an echo that moves the retiring row into a
   lane that does not own the target undoes the retirement; into `main`,
   which owns it, nothing to undo).

---

## §1 Docket text — paste-ready, append to features/DOCKET.md after D377

Lint check: quantities braced, literals backticked, no bare digit run in
`trig`/`resp`/`sib`; `touches` names only earlier entries; `sib: none --`
carries a reason of three words or more. The resp restates D376 whole;
the inserted clause runs from "an unplaced writer never retires a placed
lane's pointer" to "D241's reversal applies unchanged"; everything else is
D376's text verbatim.

```
D378 2026-11-02 [I] amends D376
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row; or a writer the store could not place names in `supersedes` a pointer that carries no writer stamp [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, and a placed lane's writer never retires one of them, recording it as a reference; an unplaced writer never retires a placed lane's pointer, with one door so that no pointer is orphaned: a pre-stamp pointer, a live chapter summary or bookmark that carries no writer stamp at all, neither `_writer` nor `_writer_src`, whose session the registry holds no row for, and that sits in no `handoff:` lane, is retired by an unplaced writer that names it in `supersedes`, and never otherwise, never by the bookmark chain, never a pointer carrying a stamp of any source, never one whose session the registry holds, never one in a handoff lane, each of those staying a reference as before; every such retirement is recorded on the retired entry beside the ordinary trace, under one key `_retired_across`: who, the writer as the store knows it, the label "writer unknown" with the stamp source `unregistered` and the retiring row's session when it carries one, never a role the row claims; what, the retiring entry's id; when, the moment of the retirement; and how, `pre-stamp`, the two facts that opened the door; the retiring entry lists what it retired that way under `_supersedes_across`, beside `_supersedes_referenced`; the reply lists those pointers under `retired_across`, apart from the lane's own supersessions, with a note saying who, what and how, and says the writer it stamped is undetermined, `writer_src` `unregistered`, as it says every other stamp; the record travels with the entry wherever its metadata is read, export by id, the writer trail by `main` and the handoff export's whole form, and D241's reversal applies unchanged when an echo moves the retiring row into a lane that does not own the target; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a live pointer that no writer in the store can ever retire, growing a client's panel forever, is the orphan this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D376 D169 D235 D240 D241 D243 D166 D372 D373 D374
# the U1 failure-ladder review, 2026-11-02 (finding F3): a client without hooks, Codex or Cursor, upgrades to beta.3 holding chapters it wrote before the store recorded writers, which are main's by D376, and writes its next chapter stamped `unregistered`; its `supersedes` of the old one comes back as referenced, "Written by another writer", and both stay live pointers forever, since no placed writer is present to retire main's; probe P-UPG confirmed it. Put to the owner as three options (an unplaced writer may retire a pre-stamp pointer, traced; doctor lists them for a human; disclose only): "i agree there has to be mechanism to retire so nothing is orphaned, as long as who/what/when/how is recorded". The pre-stamp test is the row's own facts and the registry's, read at the write, never a release or a date, so a library-written pointer in a session the registry never held opens the door too, as it is main's by the same reading (D374); a stamped pointer of main's or a worktree's never does, so the incident of D372 has no side door here, and an unstamped pointer of a session the registry holds never does, so a worktree's earlier-release conversation stays its own (D374). The door is the unknown lane's alone: main retires its own today, a worktree retiring main's is the incident, and an `ambiguous` writer retires nothing (D235). The record lives on the retired entry because that is the row that changed and the row main's trail reads; the retiring entry carries the list so a reader of the unknown lane finds it too; both are plain metadata, read by the export and trail surfaces that exist, no new one. The second departure from D169's "only a lane's own writer retires that lane's pointers", beside D376's two-unplaced-writers residual, both kept so a hookless client's panel stays bounded (D166) and continuity holds across the upgrade. The stressing case accepted: in a store with both a hooked main session and a hookless client, the hookless client can retire main's pre-stamp chapter until main's first stamped chapter retires it itself; main's next start then opens on its bookmark or fresh, the retired chapter and its record readable by export and in main's trail. Roads not taken: doctor listing the orphans for a human to retire by hand (a new surface, and the human is not always there); disclosure only (the panel grows without bound, D166); any writer retiring a pre-stamp pointer (a worktree's writer would retire main's, the incident); a packet line telling main its pre-stamp chapter was retired across the boundary (a new packet surface; the record is readable where every trace is); amending D169 [I>V] in place (D376 set the precedent of a disclosed departure)
```

Amendment lines to existing entries: none in place (the docket never edits
in place). D376's residual list is carried into D378's comment; D376 stays
as written, superseded in effect by D378.

Sanity against the lint kinds present today: no new `form` kind (checked
for bare digit runs: `D241`, `D374`, `D376` are ids, not digit runs;
`{3}` not needed, no quantity in the resp); `touches` all earlier;
provenance `[I]` until the owner reads it, so one more `inferred` of the
kind already counted; D378 can be ratified by the same entry that ratifies
D372 to D377.

---

## §2 Scenarios — paste-ready

Target file: `features/journal-orchestration.feature`. Insertion point:
after the `@D376` scenario "rows from before the store recorded writers
stay the main lane's" (ends at line 227 at 7df7bd6), before the `@D190`
scenario "the session-start hook registers self and the server stamps
rows from it" (line 229). Add "D378" to the feature header's list ("D372
to D376 of 2026-11-02" becomes "D372 to D378 of 2026-11-02 (…, the unknown
writer, the pre-stamp boundary)").

```gherkin
  @D378
  Scenario: a client without hooks retires its chapter from before the upgrade, and the retirement says who, what, when and how
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    And a client the server cannot place, after the store recorded writers
    When that client writes the chapter summary "plan: the second release" superseding "plan: the first release"
    Then the reply lists "plan: the first release" as retired across the pre-stamp boundary, apart from the lane's own supersessions, and says the writer it stamped is undetermined
    And "plan: the first release" is retired, its record naming who as "writer unknown" with the stamp source and the retiring session, what as the retiring entry, when as the moment, and how as "pre-stamp"
    And "plan: the second release" lists "plan: the first release" as retired across the boundary
    And the main checkout's session calling status asking for every lane sees "plan: the second release" as the one live pointer labeled "writer unknown" and no pointer of "plan: the first release" in any lane
    And exporting "plan: the first release" by id and reading the main lane's writer trail both show the record

  @D378
  Scenario: the boundary opens to no pointer a lane of its own can still retire
    Given the main checkout's own live chapter summary and the worktree "subproject"'s own
    And a chapter summary written through the library with no writer stamp by a session the registry holds
    And a chapter summary imported from a teammate's handoff file
    And a client the server cannot place, after the store recorded writers
    When that client writes a chapter summary superseding all four
    Then all four stay live and unchanged, the reply listing each as referenced, written by another writer, and none as retired across the boundary
    And no entry in the store carries a retirement across the pre-stamp boundary

  @D378
  Scenario: the boundary opens for the writer-unknown lane alone
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    When a session in the worktree "subproject" writes a chapter summary superseding it
    Then "plan: the first release" stays live, the reply listing it as referenced, written by another writer
    When the main checkout's session writes a chapter summary superseding it
    Then "plan: the first release" is retired as the main lane's own, carrying the ordinary trace and no record of a retirement across the boundary
```

Note on the second scenario's "all four": main's chapter, the worktree's,
the unstamped registered-session chapter, the imported one. The import
Given reuses the handoff feature's existing stand-in for a teammate's file
(`treecontext_import` with a file claiming another session), so the
`handoff:` lane is real, not hand-stamped.

---

## §3 Binding notes — what each Then must observe

General: the real doors as the D376 steps use them — `openGitWorld` (a
real repository, the session-start hook through `runHook` registering
main's self), `olderChapter` (a library write with `_cc_session_id` the
registry never held and no `_writer`/`_writer_src`/`_door`/`_identity`,
asserted in the Given), `unplacedChapter`'s session (a `cc-` id with no
registry row, asserted) over `mcpOver(w, { ccSessionId })`, the insert
through `treecontext_insert` with `supersedes: [id]`; every state
assertion by direct SQLite (`rawMeta`, `rawAll` on `nodes.metadata_json`
and `session_registry`), never by the reply alone.

Scenario 1:

- **Then the reply lists … retired across … and says the writer is
  undetermined.** Reply has `retired_across` equal to `[first.id]`,
  `superseded` does not contain `first.id` under the lane's own
  supersessions (or, if the builder keeps one `superseded` list, the
  across list is the disjoint addition and the note names it), `referenced`
  is absent or empty, `writer` is `null` and `writer_src` is
  `"unregistered"`, `retired_across_note` contains "writer unknown" and
  "pre-stamp". Mutation probes: (i) revert `splitSupersedes` to today's
  two classes → `referenced: [first.id]`, red; (ii) keep the retirement
  but drop the `retired_across` list → red; (iii) keep server.ts:637's
  `if (stamp.src !== 'unregistered')` silence → `writer_src` missing, red.
- **Then "plan: the first release" is retired, its record naming who …
  what … when … how.** SQL on `first.id`: `next_session` absent,
  `status` `superseded` (if it was `active`), `superseded_by` =
  `second.id`, `superseded_at` a number within the test's window,
  `_superseded_prior` = `{next_session: true}`, and `_retired_across` =
  `{by: second.id, writer: "writer unknown", writer_src: "unregistered",
  session: <the unplaced cc id>, at: <= superseded_at, how: "pre-stamp"}`
  (deep-equal on `by`, `writer`, `writer_src`, `session`, `how`; `at`
  equal to `superseded_at`). Mutation probes: write `superseded_by` and
  nothing under `_retired_across` → red; put the row's claimed
  `agent_type` in `writer` (F5's slip) → red because the Given claims
  none and the step asserts the label verbatim, and the second scenario's
  world should add `agent_type: tester` to the unplaced client's metadata
  so a claimed role is on the row and still not in the record.
- **Then "plan: the second release" lists "plan: the first release" as
  retired across the boundary.** SQL on `second.id`: `_supersedes_across`
  = `[first.id]`, `_supersedes_referenced` absent, `refs` does not list
  `first.id` as a mere reference (or lists it, if the builder keeps refs
  for every supersession — then assert `_supersedes_referenced` absent).
  Probe: drop the key → red.
- **Then status asking for every lane sees the second as the one live
  pointer labeled "writer unknown" and no pointer of the first in any
  lane.** `treecontext_status` with `scope: "all"` under main's session
  (`mcpOver(w, { ccSessionId: main })`): `resume_pointers` ids contain
  `second.id`, labeled `writer unknown`, and not `first.id`; the
  serialized reply does not contain `first.id` at all. Probe: leave the
  first live → red; label it `main` → red.
- **Then exporting the first by id and reading the main lane's writer
  trail both show the record.** `treecontext_export` with `node_id:
  first.id`: the node's metadata carries `_retired_across` as above and
  `referencedBy` names `second.id`; `treecontext_export` with `writer:
  "main"`: the trail includes `first.id` and its metadata carries the same
  record (the trail must not drop a retired row, D376's trail reads rows,
  not pointers). Probe: strip `_retired_across` in export's metadata
  projection → red.

Scenario 2 (the side door; every Then negative, each with its probe):

- **Then all four stay live and unchanged, the reply listing each as
  referenced, and none as retired across.** For each of the four ids, SQL
  before and after byte-equal on `metadata_json` and `updated_at`;
  `next_session` true; reply `referenced` equals the four, `retired_across`
  absent or `[]`, `superseded` `[]`. Probes, one per guard: (i) drop the
  `_writer`/`_writer_src` test → main's chapter (`_writer` `main`) still
  fails on the stamp but the registered-session library row passes only
  the registry guard, so additionally (ii) drop the registry guard → the
  registered-session row is retired, red; (iii) drop the handoff-lane guard
  → the imported row is retired, red; (iv) make the door read "lane is
  main" instead of "no stamp" → main's own stamped chapter is retired,
  red (this is the incident probe). All four rows must be present for the
  four probes to each have a victim; the imported row's `next_session`
  must be live in its handoff lane (D223 keeps imported pointers out of
  the receiver's self but live in their lane; if the import clears the
  flag, assert instead that the row is byte-equal and named in
  `referenced`).
- **Then no entry carries a retirement across the pre-stamp boundary.**
  `SELECT count(*) FROM nodes WHERE json_extract(metadata_json,
  '$._retired_across') IS NOT NULL OR json_extract(metadata_json,
  '$._supersedes_across') IS NOT NULL` = 0. Probe: any of (ii)-(iv).

Scenario 3 (who may):

- **Then the first stays live, listed as referenced (worktree writer).**
  SQL byte-equal; reply `referenced: [first.id]`, `retired_across`
  absent. Probe: open the door to every writer (`writer !== MAIN_LANE`
  instead of `writer === UNKNOWN_LANE`) → the worktree retires it, red.
- **Then the first is retired as the main lane's own, with the ordinary
  trace and no across record.** Under main's registered session: SQL
  `superseded_by` = the new id, `_superseded_prior` set, `_retired_across`
  absent; the new row has no `_supersedes_across`; reply `superseded:
  [first.id]`, `retired_across` absent. Probe: stamp the record on every
  retirement of an unstamped target → red. This Then keeps the ordinary
  path byte-identical to today's and is what stops the record from
  leaking onto main's own supersessions.

Unlit-check (F1's lesson): the three scenarios must leave the `wip` list in
`tests/journal/features.test.ts` before the unit closes, and the probes
above re-run against the executed step defs, not the stubs.

---

## §4 Build notes

Unit: a small unit of its own after U2, before U3 closes (R14 says
"before U3 closes"); Sonnet-buildable with the probes spelled above, Opus
failure-ladder review; per-unit binding counts recorded as R11 asks.

Files likely touched:

- `src/flat-store.ts` — `splitSupersedes` (:1722) grows a third class,
  `across`: target lane `MAIN_LANE` by `laneWriterOf`, no `_writer` and
  no `_writer_src` on the row, `session_registry` holds no row for the
  target's `_cc_session_id`/session key (one prepared `SELECT 1`), session
  key not under `handoff:`, and the writer is `UNKNOWN_LANE`; the insert
  transaction applies `across` through `applySupersedes` with the record,
  sets `_supersedes_across` on the new row, returns `retiredAcross` in
  `InsertResult`; the bookmark chain (`withPriorBookmarks`) untouched.
- `src/persistence/writer-heal.ts` — `retireMeta` takes an optional
  `across` record and writes `_retired_across`; the heal's reversal path
  reads nothing new (D241 unchanged), but its undo should leave
  `_retired_across` in `_superseded_prior`'s history as it does
  `superseded_by`, or delete it with the flags — builder's choice, stated
  in the step.
- `src/references.ts` — constants `RETIRED_ACROSS_KEY`,
  `SUPERSEDES_ACROSS_KEY`; `writerOf` returns `UNKNOWN_WRITER_LABEL` for
  an unknown writer with the claim left in metadata (F5), which the
  record's `writer` field reuses.
- `src/server/server.ts` — reply `retired_across` + `retired_across_note`
  (:691-701); `writer: null, writer_src: 'unregistered'` for an
  unregistered stamp (:637, F4); the `supersedes` parameter's description
  (:415-421) gains one sentence on the pre-stamp door.
- `src/server/instructions.ts` — probably nothing; the handshake text's
  supersession line is a charter surface (journal-agent-surface.feature)
  and the door is a corner, not a protocol step. If a line is added it
  needs that feature's review.
- `tests/journal/steps/journal-orchestration.steps.ts` — the three
  scenarios' steps; reuse `olderChapter`, `unplacedChapter`,
  `laneChapter`, `mcpOver`, `rawMeta`; a library-written registered-session
  chapter (store.insert under `w.sessionId`'s `_cc_session_id`); the
  imported chapter via the handoff steps' import helper.
- `tests/journal/features.test.ts` — the wip list; `features/DOCKET.md`;
  `docs/beta3-bindings-audit.md` (three scenarios, their rungs);
  `features/journal-orchestration.feature` header list.
- `WRITER_STAMP_KEYS` / the insert tool's dropped-keys list: add
  `_retired_across` and `_supersedes_across` so a caller cannot forge the
  record (AGENTS.md: stamps are the store's, never trusted from a caller);
  the handoff import must move them under `_handoff_claims` with the rest
  of the trace keys (D223's list names `superseded_by`, `superseded_at`;
  the new keys go the same way — one line in `src/handoff.ts`).

---

## §5 Open questions

None left unresolved from the record. Two choices were made by the drafter
and are stated as such in the comment, for the owner's eye at the
ratifying read:

- The door covers a bookmark as well as a chapter summary (R14 says
  "chapter"; "no pointer is orphaned" covers both, and D376 names both).
- In a store where a hooked main session and a hookless client share the
  upgrade window, the hookless client can retire main's pre-stamp chapter
  (recorded); main's own first stamped chapter closes the window. If the
  owner would rather the door stay shut whenever the registry holds any
  main session, say so in plain words: "only when nobody with hooks has
  ever been in the store". The draft did not choose that, because the rule
  would flip the moment the first hooked session appears, and the record
  is what the owner asked for.
