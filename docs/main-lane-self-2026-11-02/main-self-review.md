# Review: D372 draft, the main checkout's half of D167

Reviewer: adversarial pass, read-only, against `beta.3/node-sqlite` at add7004.
Draft: main-self-draft.md. Brief: main-self-brief.md.

## Verdict

The diagnosis is right and checks out against the code: the main checkout's
status is one flat newest-first list (server.ts:1078-1093, flat-store.ts:2169-2183),
the fresh-start self lines exist for a worktree only (checkpoints.ts:691-694;
session-start.ts:310-320), and the D167 Then at
journal-orchestration.steps.ts:656 is vacuous. The position (do not scope main;
label what is its own and set the other lanes apart) is sound and consistent
with D169's declined top-down model. The draft is **not ready to ratify** as
written, for five reasons. (1) The docket entry is malformed: `trig` with
`-> structural` is a docketry form finding, and an `amends` must restate its
target in full, so as drafted D372 would erase D242's worktree half. It also
leaves D236's "the main checkout's fresh start keeps its packet unchanged" in
effect, which contradicts D372. (2) The corrected D167 Then is a reversal, not
a repair: "does not carry it" becomes "carries it", and the draft presents
this as a vacuity fix. (3) The incident walk is fixed at handshake step 1 and
in the packet, but not at step 2. The orientation query is still lane-blind,
and the draft's reason for declining it ("hits already show their writer") is
the same raw-metadata label the draft calls the cause of the incident.
(4) A worktree chapter written by a session the server could not place is
stamped `unregistered`, which names no writer, so it falls in the main lane.
D372 would then label a stranger's chapter as "the main checkout's own", which
is worse than today's flat list. (5) The draft does not examine one fresh-start
channel: on `startup`, the session-start hook claims the newest unclaimed
recovery snapshot of *any* other session (shared.ts:464-497, 522-536). That
puts another session's recovery queries in main's packet and has the drain
write their lane-blind results into main's session. Most of the rest are
wording fixes.

## Findings

**F1. blocker. Docket form: `trig` with a resolution.**
D372 carries `trig:`, `sib:` and `-> structural` together. Docketry's grammar
lists `trigger-with-resolution` as a form finding (docketry GRAMMAR.md:106; its
D68: "only fence kinds carry a trigger"). In features/DOCKET.md, every entry
with `trig` and `->` is a fence kind (12 fence-deferred, 4 fence-assumption), and
no entry anywhere carries both `sib` and `->`. Fix: pick one shape. The
draft has scenarios and an unwanted case, so it should take the behavioural
shape of D167 and D206: keep `trig` and `sib`, and drop the `->` line. The
alternative is D242's shape: no `trig`, no `sib`, `-> structural`.

**F2. blocker. `amends D242` does not restate D242. D236 is contradicted and
not amended.**
GRAMMAR.md:40 and :96 say an amends entry "restates the target in full and
becomes its effective shape". D372's resp says nothing about the worktree
session's scoped list, the `scope` block, the count of other lanes' pointers
or the widen (D242, DOCKET.md:1753). After ratification, D242's effective shape
would have no worktree half. Separately, D236 (DOCKET.md:1711, [I>V]) still
says "the main checkout's fresh start keeps its packet unchanged", and D372
changes that packet. The grammar has one relation per header, and no existing
entry amends two targets. Fix: split the entry in two.
- `D372 2026-11-02 [I] amends D242`. Its resp restates the worktree half
  verbatim ("a session registered in a linked worktree calls status and sees
  the live pointers of that worktree's own lane, with a block naming the lane,
  the count of other lanes' live pointers left out and how to widen; asking for
  every lane lists every lane's"), then gives the main checkout's new status
  and the unplaced session.
- `D373 2026-11-02 [I] amends D236`. It restates the worktree fresh start
  verbatim and replaces "the main checkout's fresh start keeps its packet
  unchanged" with the main-checkout packet rule.

Both entries should touch D167, and D373 should touch D372.

**F3. major. Ladder: none; this is a silent reversal of a [V]-ruling scenario.**
The draft's replacement for journal-orchestration.feature:66 turns "the packet
handed to a session starting in the main checkout at the same time does not
carry it" into "…names that chapter as the worktree's own thread". The
original Then promised that the stranger's chapter stays out of main's packet;
the replacement promises that it is in, labelled. That changes behaviour under
D167 [V], and the draft only calls it "the vacuous Then becomes a non-vacuous
one". The draft also missed a road: main's packet could carry its own lines
plus *one count line* ("N other lanes hold live chapter summaries; status
lists them apart, as context"). That road keeps the original Then true and
non-vacuous, keeps the stranger's text out of the fresh context entirely (the
incident's hazard is anchoring on text in front of the model, labelled or
not), and bounds the packet (see F8). Fix: keep the D167 Then's words and bind
them non-vacuously. Replacement wording:
`And the packet handed to a session starting in the main checkout at the same time opens with the main checkout's own line and does not carry that chapter summary`
The packet-content choice goes to the owner (Q-A).

**F4. major. Ladder: unlit, at incident step 2. The orientation query is
declined on a false premise.**
The handshake's step 2 ("what was I working on, what was the next step";
journal-agent-surface.feature:145, D264) runs store-wide with recency 0.25, and
the worktree's newer chapter is the most likely top hit. A hit's writer
appears only as raw `metadata._writer` in the query reply (server.ts:1029,
`{ results }` returned as-is). D186 is about *referrers*, not about hits, and
D243 is about naming. So "hits already show their writer (D186/D243)" is the
same signal the draft rejects for status as "what produced the incident". The
draft's handshake sentence asks the agent to compare a raw `_writer` against
its own lane name, but never tells it that its own name is `main`. The worktree
half has the same hole: D242 scoped a worktree's status, not its query. The
fence cannot decline this alone: D167 [V] makes *default re-orientation* anchor
on self, and the query is a mandatory step of the default handshake. Declining
it narrows a [V] ruling, so the owner must decide (Q-B). A middle road the
draft did not weigh, which keeps D264 ("no parameter for orientation beyond
those it had"): the query reply marks, in words, each hit from another lane
than the caller's self (for example, "another lane's: worktree subproject").
That adds no parameter and no scoping, and the orchestrator still sees
everything.

**F5. major. Ladder: over-asserted. "Own" includes rows written by an unplaced
session.**
D235 stamps a row from an unknown session `unregistered` with no writer.
`laneWriterOf` (references.ts:97-103) reads a missing writer as `main`. D372's
"the rows stamped main and the older rows naming no writer" therefore labels as
*main's own* any worktree chapter whose server could not resolve its session
(a stale pid beacon or an ambiguous beacon, session-beacon.ts:473-530).
Today that row is merely first in a flat list; under D372 the packet would
call it "the main checkout's own chapter summary". This is exactly the
incident, now asserted by treecontext. The rows can be told apart:
post-registry unplaced rows carry `_writer_src` `unregistered`, and pre-registry
rows carry none. Fix, resolvable from the record by the draft's own reasoning
for ambiguous rows (D235's comment: a guess must not act as a lane's own): own
= stamped main, plus rows from before the store recorded writers. A row whose
writer could not be determined is listed apart with the ambiguous ones.
Replacement resp clause: "…the rows stamped main and the rows written before
the store recorded writers; a row stamped while its writer could not be
placed, or stamped ambiguous, is listed apart as of an undetermined writer,
never as the main lane's own…". Owner confirmation is light (Q-E).

**F6. major. Ladder: absent. The startup snapshot claim is a cross-lane
fresh-start channel.**
`buildRehydrationPayload` on `startup` (shared.ts:522-536) claims the newest
unclaimed snapshot whose `session_id != ?` (shared.ts:472-487). The claim has
no lane, worktree or cwd filter. It writes `[Prior session snapshot #N from
session <other>] Recovery queries: …` into the packet and stages a `snapshot`
row, which the drain answers with store-wide queries ("what was I working on
in the current task", pre-compact.ts:14-18), writing a recovery row in the
*new* session (ingestion.ts:570-600). A worktree session that compacts leaves
its snapshot unclaimed, because only `startup` claims one. The next main
startup takes it. Whether this fired in the owner's incident cannot be known
(another machine's store), but it would produce exactly that incident. The
fence (OUT-OF-SCOPE.md:98-122; D286) keeps "the pre-compact snapshot and the
session-start claim" with ccr. Still, the claim writes into the packet and
causes a drain write, and "a fence may decline a promise, never a writer".
Fix: name the channel in D372's comment. Give it either a scenario ("a fresh
start in the main checkout does not claim a worktree's recovery snapshot") or
an explicit owner ruling (Q-C).

**F7. major. The handshake card has no room for the step-1 clause.**
`INSTRUCTIONS_BRIEF_LEXICAL` is 1979 characters (built dist). The file header
(instructions.ts:8-9) records Claude Code's 2KB instruction cap, separate from
D210's 2500-character binding (journal-agent-surface.steps.ts:281). The draft's
step-1 clause (about 70 characters) in "both copies, the short instructions and
the reference body" would push the card past 2048 characters. Fix: put the
rule only in the skill body's "Subagents, worktrees and writers" section (where
the worktree bullet already lives, instructions.ts:180-182) and in the status
reply's own self block. The status reply is what the agent reads at step 1
anyway. If any card change is needed, it must replace words, not add them.

**F8. major. The packet and the other-lanes block are unbounded.**
The worktree self lines are prepended *outside* the startup budget
(session-start.ts:314-315; the 5000-character budget applies to the rehydration
payload only). The draft's "one line per other lane with a live chapter" has
no cap. An orchestrator with many worktrees and subagent roles that write
`next_session` rows (the D169 tester's entry is one) grows the packet without
limit, against D162's small budget and the client's 10,000-character context
cap. Status has the same problem: one entry per lane with no cap. Fix: the
packet gets one count line, or at most `{3}` other-lane lines plus "N more
lanes; status lists them". The status other-lanes block keeps D166's cap of
`{20}` with the count of lanes omitted.

**F9. major. Ladder: narrowed. Two existing negative bindings lose half their
reach.**
journal-orchestration.steps.ts:478-479 (D263, "Nor a resume pointer: the status
panel the next session reads") and journal-handoff.steps.ts:514-515 (D206, "Nor
did any become one of B's resume pointers") check only `resume_pointers`.
Under D372 a row can sit in the status panel's other-lanes block and these
negatives still pass. The draft's claim that the bindings "keep meaning what
they meant" holds for the positive ones (orch:823, 838; handoff:541;
recall:276; reorientation:813, 839, 1125), not for these two. Fix: the build
unit extends both negatives to the other-lanes block, and the binding notes
should say so.

**F10. minor. Bookmark-only main thread.**
Main's packet says "the main lane has no chapter summary of its own" even when
the stopped session left a live bookmark, the likely state of a documentation
session nobody checkpointed. The packet would then carry only the stranger's
thread. D160 [V] already has a bookmark-only path ("says no chapter summary
exists"). Replacement Then for scenario 2: `Then the packet handed to its agent says the main lane has no chapter summary of its own and names its newest bookmark, with its age and id, when it has one`.

**F11. minor. Vague Thens on "as before".**
Scenario 5's "lists the chapter and the bookmark as it did before" and "the
packet is the one a main checkout received before this ruling" compare against
history. A golden fixture captured from today's build freezes whatever the
build happens to print, and the gherkin `vague-then` lint may flag them.
Replacements:
`Then the status lists the chapter and the bookmark as the main lane's own live pointers and lists no other lane`
`And the fresh start's packet carries no line about this session's own thread or any other lane`

**F12. minor. Owner language.**
"the older unstamped chapter" (scenario 3, line 132) becomes "the older chapter
written before the store recorded writers". The Given at line 130 already says
it that way. Docket resp: "a lane named undetermined" becomes "listed apart as
of an undetermined writer". The other-lanes entry should still say "chapter
summary" (D158: kinds distinguishable wherever they appear).

**F13. minor. Handoff lanes cannot appear in status.**
D206 (DOCKET.md:1499) puts imported entries outside the receiver's pointers, and
handoff:515 binds `[]`. The draft's "handoff label" in the other-lanes list
names something that never occurs. Also, D243 names a handoff lane by
`handoff:<claimed session>`, not by its label. Fix: drop handoff lanes from the
list.

**F14. minor. Sources are not stated.**
The worktree lines are prepended on every non-clear source, `startup`,
`resume` and `compact` alike (session-start.ts:308-320). D372 says "starts in
the main checkout other than by a /clear" but scenario 1 binds `startup` only.
Fix: say in the resp which sources carry the main lines, mirroring the
worktree, and bind at least `resume` in the binding note.

**F15. minor. A binding note names a helper that does not exist, at the wrong
seat.**
The draft says "the standins' pre-stamp fixture". tests/journal/standins.ts has
no such helper, and standins.ts is for parties beyond a door, not for history
in the store. The precedent for "a row an earlier release wrote" is the D263
binding (journal-orchestration.steps.ts:483-503: written as the earlier
release wrote it, then the real drain). Also note this trap:
`statusPanel` (journal-reorientation.steps.ts:294-297) reuses `w.client`, so a
binding that switches from the worktree session to the main session must open
a fresh client under the main session's id, or status runs as the wrong self.

**F16. minor. Tags and header.**
`@D372 @D169` on the orchestrator scenario claims a proof of D169's lane model
that the scenario does not exercise. Use `@D372` alone. The header addition
"D236, D242 and D243 of the chunk-5b review" lists rulings that no scenario in
the file carries (except the optional @D242). List only the tags the file
carries: add D263 (already missing from the header), D372 and, if adopted,
D242.

**F17. minor. Fence grammar.**
The draft appends "; the main lane's own chapter in every fresh-start packet,
other lanes or none (D372)" inside the D167 line at OUT-OF-SCOPE.md:436-437.
Fence entries end with *one* trailing parenthetical (OUT-OF-SCOPE.md:11-13).
Fix: write a new line, "Main checkout fresh start: its own chapter in every
fresh-start packet whether or not another lane holds one. (D372, 2026-11-02)".
Note also that OUT-OF-SCOPE.md:356-359 already declines "re-orienting from the
project's newest chapter regardless of who wrote it". Main's flat status is
that declined road, live in the build since D242. D372's comment should say so,
because it is the strongest argument for the amendment.

**F18. minor. Bindings-audit placement.**
docs/beta3-bindings-audit.md is scoped to D279-D361 (its line 6). Entering D167
or D242 there is out of its scope. Record them in the build unit's own audit
note instead.

## Open questions resolved from the record

- **Drafter Q1 (main's own chapter at every restart, or only beside another
  lane):** resolved, conditional. D236 [I>V] ratified main's fresh start as
  unchanged because "the status panel already serves it". The only case the
  record shows failing is the one beside another lane (the incident; D242's
  comment). D162 weighs every automatic character against the token bill.
  The unconditional form stays a fence line (F17). D373 must amend D236
  explicitly (F2).
- **Drafter Q2 (newest chapter per lane, or every pointer):** resolved, per
  lane, capped. D166's comment holds status at 20 because of panel growth.
  D186 takes the one-hop default with counts and deliberate fetch. The
  per-lane entry carries the lane's pointer count, and export reaches the
  rest.
- **Drafter Q3 (other lanes' bookmarks):** resolved, counted and not shown.
  D158 calls a bookmark "low in signal like the journal itself", and D241
  bounds bookmarks per session per lane. A worktree's position is one
  `export` with `writer` away (D237). One exception: a lane that holds *only*
  a bookmark must still show something. Show its bookmark labelled as a
  bookmark (D158), or the entry carries nothing (F10's twin).
- **Drafter Q5 ("the return you were waiting for"):** resolved, drop it. The
  store does not know who spawned whom (the draft's own premise), and D188 keeps
  the charter on what treecontext produces. A sentence that guesses the
  agent's role is the agent's own business. Keep the neutral sentence "context
  for this session, never its own thread".
- **Missed: two concurrent sessions in the main checkout.** D167 [V] says the
  main session's self is "the main checkout", not the session, so a peer
  main session's chapter *is* this session's own thread by ruling. Disclose
  this in D372's comment as a residual. It is not a defect.
- **Missed: unplaced-writer rows (F5).** Resolved by D235's own reasoning for
  ambiguous rows. Owner confirmation is light (Q-E).

## Questions for the owner (plain language)

**Q-A. When the main session restarts beside a worktree, should its opening
note show the worktree's latest plan (clearly labelled "not yours"), or only
say that other work exists and where to look?**
Showing it helps a main session that is coordinating the worktrees: it sees
their progress at once. Leaving it out is the safer fix for what happened to
you. An agent that starts by reading someone else's plan can still slide into
it, label or no label, and the opening note stays short however many
worktrees you run. The original promise (D167) was "leave it out". The draft
quietly turned that into "show it labelled".

**Q-B. After the status panel, the agent's next startup step is a search for
"what was I working on". That search still ranks the worktree's newer plan
first and marks it only in fine print. Fix it, or rely on the instructions
alone?**
Options: (1) leave the search alone and tell the agent in its instructions to
check who wrote each hit (cheap, but it depends on the model reading fine
print, which is what failed); (2) have the search reply say plainly, next to
each hit from another worktree or subagent, that it is another lane's (no new
knobs, nothing hidden); (3) limit the startup search to the session's own lane
by default (the strongest fix, but it hides context from a coordinating main
session). Your earlier ruling says a restart orients on its own thread by
default. Option 1 alone arguably falls short of that ruling.

**Q-C. A fresh session currently "adopts" the last recovery note left by any
other session that compacted, including a worktree's, and searches the
journal on its behalf. Should a main session ever adopt a worktree's recovery
note?**
That mechanism was fenced as compaction plumbing belonging to the companion
tool, but it writes into the opening note and into the journal. It may have
been part of what you saw. Options: limit it to sessions in the same checkout,
retire it, or leave it and record why.

**Q-D. Should the worktree half get its own test scenario now (the draft's
optional one)?**
That behaviour exists and has a unit test, but no promise in the feature files
describes it. The amendment changes the same status panel. Without the
scenario, a builder can change the worktree behaviour with no promise to
check against.

**Q-E. A plan written by a session that treecontext could not identify: should
the main session treat it as its own, or set it apart as "writer unknown"?**
Today such plans count as the main checkout's. After this change they would be
*labelled* the main session's own, so a worktree plan written while
identification failed would be presented to the main session as its own
thread, the incident again with treecontext vouching for it. Recommended: set
it apart.

## Factual claims checked

| Draft claim | Result |
|---|---|
| status scopes only for a worktree self (server.ts ~1081) | true, server.ts:1078-1093 |
| main's pointer writer visible only in raw metadata | true, server.ts:1121-1131 (`metadata: p.metadata`) |
| fresh-start self lines are worktree-only, "Empty for the main checkout" | true, checkpoints.ts:689-694 |
| /clear packet is chain-scoped (`session_key IN chain`) | true, checkpoints.ts:283-305 |
| orientation query is lane-blind, recency 0.25 | true; scoping only for a `provisional` subagent caller, server.ts:914-921 |
| worktree bullet at instructions.ts ~180 | true, but it lives in SKILL_REFERENCE_BODY, not the card |
| D167 Then at steps.ts:656 is vacuous | true: main's packet has no self lines by construction (steps 656-662; checkpoints.ts:694) |
| "eight bindings read resume_pointers by node id" | approximately; at least nine reads (orch 479, 823, 838; handoff 515, 541; recall 276; reorientation 813, 839, 1125), two of them negatives that D372 narrows (F9) |
| D242 has no scenario | true for features (no `@D242`); a unit test exists, tests/session-registry.test.ts:254 |
| D236 is the "status panel already serves it" comment | true, DOCKET.md:1716 (the brief misattributed it to D190; the draft corrected this) |
| next free number is D372 | true (D371 is last, DOCKET.md:2757) |
| an existing `openGitWorld` / `addWorktree` | true, journal-orchestration.steps.ts:286, 313 |
| a "standins' pre-stamp fixture" | false: no such helper (F15) |
| "hits already show their writer (D186/D243)" | misleading: only raw `_writer` metadata; D186 covers referrers (F4) |
| fence lines ~356 and ~437 | true, OUT-OF-SCOPE.md:356-359, 436-437 |
| an ambiguous row has its own lane | true, `AMBIGUOUS_LANE`, references.ts:100 |
