# Draft v2: the main checkout's half of D167, under the owner's rulings R1–R7a

Repo read-only; nothing touched. Line refs are `beta.3/node-sqlite` at
add7004. Next free number D372; this draft takes D372–D376, one amendment
per target, each restating its target in full (review F2).

## What the rulings move, and what the repo says on the new ground

- **R2 reverses v1.** Main is a lane like any worktree: status scoped to
  the own lane by default (D242's worktree rule extended), scope block,
  `scope: "all"` to widen. An orchestrating main widens.
- **R3.** Awareness, not content: a count and at most a few lane names and
  where to look; no other lane's chapter text in packet or status.
- **R4 and the query tool (server.ts:907-930).** Today only a
  `provisional` subagent caller is scoped (D237); `concurrent` and
  `ambiguous` search the whole store with a `why`; every other caller is
  lane-blind. The lane scope is SQL over the store-stamped writer
  (flat-store.ts:376, `_writer IN (...)` or named ids). **New ground the
  rulings expose:** the drain stamps a writer on captured rows only for a
  subagent, the client's internal agent or a ticketed worker
  (ingestion.ts:638-646, 657-665); a worktree session's own captured turns
  and tool output carry no writer and read as the main lane
  (references.ts:97-103, "a row naming none is the main lane"). A
  worktree's lane-scoped search would therefore miss the worktree's own
  conversation, and main's would include it. R4 cannot be honoured without
  stamping a registered session's captured rows with that session's self;
  D376 rules it (amends D235) with a one-time stamp on open for the rows
  already there, the D263/D286 precedent.
- **R5 and the snapshot claim (shared.ts:464-497, 522-536).** On `startup`
  the hook claims the newest unclaimed snapshot of *any other session*, no
  lane filter, writes its queries into the packet and stages a `snapshot`
  row the drain answers store-wide ("what was I working on in the current
  task", pre-compact.ts:14-18). Only `startup` claims, so a worktree's
  compaction leaves a snapshot main's next start takes. The fence
  (OUT-OF-SCOPE.md:98-122) keeps "the pre-compact snapshot and the
  session-start claim" with ccr (D286). The claim writes to the packet and
  causes a drain write: a fence may decline a promise, never a writer.
  D375 brings the claim into the charter (amends D286).
- **R7/R7a and the unknown writer.** A tool row from a session the server
  cannot place is stamped `unregistered` with no writer (D235;
  session-registry.ts:370, 407; server.ts:376-381), and the lane key then
  reads it as main. A row from before the registry carries no stamp at
  all. The two are distinguishable: a mark that says identification
  failed, versus no mark. D376 keeps the pre-registry rows main's (D243)
  and sets the marked ones apart as "writer unknown".
- **Terminology** (the owner asked): *lane* is a writer's own trail inside
  one namespace; lanes are named `main` and `worktree:<name>` (D243, the
  filesystem; R1), a subagent's by its role. *Namespace* is the
  process-level boundary (D196). *Checkout* is git's word; the branch is
  shown on the self line as a signpost, never the lane's name.
- **Handshake card:** 1979 characters built; header says the client caps
  at 2KB. v2 adds nothing to the card (the status and query replies are
  self-describing, as D237's are); one optional swap is specified exactly
  in §4.

## The position under the rulings

Symmetry. Every placed session, main or worktree, is scoped to its own
lane by default at all three points of the handshake: status (D372), the
fresh-start packet (D373) and the orientation search (D374). At each
point the session is made aware that other lanes exist: a count, at most
{3} lane names (the most recently active, each with the kind and age of
its newest live pointer; never its text or id), and how to look (`scope:
"all"`; export by writer). Main's own thread is what main stamped, plus
the rows from before the store recorded writers (R7a); a row whose writer
could not be identified while writers were recorded is "writer unknown",
set apart in every view and never anyone's own (R7). A fresh session
adopts a recovery snapshot only from its own lane (R5). The orchestrator
story is "widen when you need to", which the replies tell it how to do.

The one place v2 reads symmetry past the owner's literal words: main's
fresh start gets its own self line and own chapter *at every start*, as a
worktree's does today, not only beside another lane. Reason: R2 ("I do
not see a difference between main and a worktree"), and D236's premise
for leaving main's start alone, "the status panel already serves it", is
the premise that failed. Cost: one self line plus main's own chapter on
every main start, which a worktree already pays. Listed in §5 as a light
confirmation.

## 1. Docket entries

Behavioural shape throughout (`trig`/`resp`/`sib`, no `->`), as D167 and
D206 (review F1). The quoted owner words are from the rulings file.

```
D372 2026-11-02 [I] amends D242
  trig:  a session calls status, registered in the main checkout, in a linked worktree, or one the server cannot place [I]
  resp:  a session registered in a linked worktree calls status and sees the live pointers of that worktree's own lane, with a `scope` block naming the lane, the count of other lanes' live pointers left out and how to widen; a session registered in the main checkout sees the same, scoped to the main lane, the rows stamped main and the rows written before the store recorded writers, under the same block; in either case the block also says how many other lanes hold live pointers and names at most {3} of them, the most recently active first, each with the kind and age of its newest live pointer and the count of its live pointers, never its text or id, a lane of rows whose writer could not be identified named "writer unknown" among them and never folded into any lane's own; the own list keeps the cap of {20} with the total stated; `scope: "all"` lists every lane's pointers flat as before, each pointer naming its lane, with no block; a session the server cannot place sees every lane flat with the block saying it could not be placed [I]
  sib:   none -- a main checkout orienting on a worktree's chapter because it was newest in a flat list is the confusion D167 removes, not a behaviour
  serves: N23 N24 N20 N5
  touches: D242 D167 D190 D243 D169 D166 D158 D376
# the owner's incident, 2026-11-02, on another machine's store: two Claude Code sessions on one store and one repo, A in the main checkout (documentation), B in a linked worktree (a new subproject); A quit and restarted while B wrote a chapter summary; the restarted A oriented on B's chapter as its own thread and recovered only by replaying its own transcript. D242 scoped the worktree's status and left main's flat, every lane newest first, the writer inside raw metadata only: the road the fence declines, "re-orienting from the project's newest chapter regardless of who wrote it" (D167), live in the build for the main checkout since D242. A first draft kept main unscoped and labelled; the owner reversed it: "fundamentally, i do not see a difference between "main" and a worktree - they are all reflections and separate spaces within the store. So labeling each writer, including main, would make searching/filtering very easy, yes? A) be aware of other lanes or namespaces or checkouts … when main starts, but no need to auto fill - would get messy if there are a 1000 worktrees." The lane names stay the filesystem's: "my idea of labeling by branch won't work then. i think the worktree: nomenclature will ahve to do since it's the file system truth." Residual, disclosed: two sessions in one main checkout share one self by D167 [V], so a peer main session's chapter is this session's own thread by ruling, not a defect. Roads not taken: main unscoped with its own pointers labelled and the other lanes' chapters listed apart (the first draft; the orchestrator's convenience bought with the peer's confusion, and content auto-filled against R3); a flat list labelled by writer in each preview (order still says "newest is yours"); naming other lanes without a cap (a thousand worktrees); asking the main session at start whether it orchestrates (an interactive gate, and the answer changes mid-session)

D373 2026-11-02 [I] amends D236
  trig:  a session starts in a linked worktree or in the main checkout other than by a /clear, at a startup, a resume or after a compaction alike [I]
  resp:  a session starting in a linked worktree opens its packet with that worktree's own thread: the newest live chapter summary whose writer is that worktree, from any session that ran there, labeled as the worktree's own with its age and referrers; and the brief addressed to it, the newest entry whose metadata `brief_for` names the worktree, with its writer and age; a session starting in the main checkout opens its packet the same way, with a line saying it runs in the main checkout and re-orients on the main lane's own thread, the main lane's newest live chapter summary labeled as its own with its age, id and referrers, and the brief addressed to `main` when one exists; either lane with no chapter summary of its own but a live bookmark is handed that bookmark named as a bookmark with its age and id, and says no chapter summary exists; a lane with neither says it starts fresh; the packet then says how many other lanes hold live pointers and names at most {3}, the most recently active first, each with the kind and age of its newest live pointer, and where to look, status with `scope: "all"` and export by writer, never another lane's text or id, nothing when no other lane holds one; the self lines count toward the start's budget; the /clear packet is unchanged [I]
  sib:   none -- a packet that hands a session another lane's chapter, labelled or not, is the anchoring this prevents, not a behaviour
  serves: N23 N24 N20 N5
  touches: D236 D167 D372 D160 D162 D190
# the incident of D372. D236 had left the main checkout's fresh start unchanged "because no scenario binds it and the status panel already serves it"; the panel did not, and the D167 Then "the packet handed to a session starting in the main checkout at the same time does not carry it" was bound against a packet that carried no self line by construction, vacuously green; the Then keeps its words and binds against a packet that opens with main's own line. The owner on content: "be aware of other lanes … but no need to auto fill - would get messy if there are a 1000 worktrees." Main's own line at every start, not only beside another lane, reads the owner's symmetry ("i do not see a difference") against D236's failed premise; the cost is what a worktree already pays. The bookmark line is D160's bookmark-only path carried to the fresh start, since a documentation session nobody checkpointed leaves a bookmark and nothing else. Roads not taken: the other lanes' newest chapters in the packet, labelled as theirs (the first draft; anchoring on text in front of the model is the hazard, label or none); main's self line only beside another lane (D162's economy, declined for symmetry; reopens if the owner prefers the conditional form); one line per other lane with no cap

D374 2026-11-02 [I] amends D237
  trig:  a session searches without asking for the whole store: the session's own agent in the main checkout or a linked worktree, a subagent, or a caller the server cannot place [I]
  resp:  a search by a caller the registry resolves to the session's one live subagent defaults to that subagent's scope: rows the store stamped with its role as writer, the live resume pointers of the lane that spawned it, the session's self, the entries whose `brief_for` names its role, and the entries those pointers and briefs reference, one hop; a search by the session's own agent, in the main checkout or in a linked worktree, defaults to its own lane: the rows the store stamped with its self, for the main lane also the rows written before the store recorded writers, the entries whose `brief_for` names it, and the entries its live pointers and briefs reference, one hop; a subagent that cannot be told apart from the session's own agent, `concurrent` or `ambiguous`, searches the session's own lane the same way, the reply saying why no subagent scope applied; a caller the server cannot place searches the whole store, the reply saying so; the scope is applied in the store before the result count and to every hit's conversation window; the reply names the lane searched, the count of hits the scope left out when the store can say it cheaply, and how to widen, and `scope: "all"` searches the whole store with no scope block; no new parameter is added; a writer's whole trail is read by `treecontext_export` with `writer`, a role, one subagent's agent id, `main` or `worktree:<name>`, oldest first [I]
  sib:   none -- an orientation query answered by another lane's newest chapter is the confusion D167 removes at the handshake's second step, not a behaviour
  serves: N20 N21 N23 N24
  touches: D237 D167 D264 D150 D240 D186 D376
# the handshake's second step, "what was I working on, what was the next step", runs store-wide with recency fusion at 0.25 (D264, D273), so in the incident of D372 the worktree's newer chapter is the likeliest top hit after the panel is fixed; the review of the first draft found the step unlit. The owner: "what i was working on depends on what lane/namespace we are in. main should get main, worktree gets it's own worktree, subagent gets whatever the supervising agent or harness feeds it." The subagent's half is D237 and the run's key lookup (D300s) unchanged; the `concurrent` and `ambiguous` cases fall to the session's own lane because status already scopes them to it (D372) and the two surfaces must agree. D264's "no new query parameter" holds: `scope: "all"` existed. Requires D376: a lane's captured conversation must carry the lane's stamp or the scoped search returns a worktree's notes without its history. Roads not taken: the search left store-wide with a label on each other-lane hit (the review's middle road; a label in front of the model is what failed in the incident, and the owner ruled scope); a parameter for orientation (D264 declined it); scoping the search and not the window (the window would leak the other lane around every hit)

D375 2026-11-02 [I] amends D286
  trig:  a session starts after a compaction and the drain runs the recovery queries the pre-compact snapshot recorded; a fresh session starts while an unclaimed recovery snapshot exists; or a store an earlier release left with recovery snapshot rows is opened [I]
  resp:  the recovery snapshot row is machine output quoting the journal, bounded like a tool event: it quotes each hit at the hit's display view and no further than the quote cap, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display and index boundaries, so a hit on it is a bounded preview with the availability marker and its reach into the index is the tool default; on first open this build stamps the same boundaries on every recovery snapshot row a store already holds, content untouched; a fresh session claims a recovery snapshot only when the session that left it had the same self, the main checkout's for a main session and the same worktree's for a worktree session, newest first; a snapshot left by another lane is left for that lane; a snapshot whose session the registry does not hold is claimed by no one and stays where it is; the recovery queries the drain runs for a claimed snapshot are scoped to that lane as a search by that session would be; the pre-compact snapshot itself and the compaction interaction stay with ccr [I]
  sib:   none -- a main checkout answering a worktree's recovery queries into its own session is a writer crossing lanes unasked, not a behaviour
  serves: N1 N4 N23 N5
  touches: D286 D35 D167 D372 D374
# found by the review of the first draft, 2026-11-02 (F6): on a startup the session-start hook claims the newest unclaimed snapshot of any other session, with no lane, worktree or directory test, writes its queries into the packet and stages a row the drain answers store-wide; only a startup claims, so a worktree's compaction leaves a snapshot the main checkout's next start takes. Whether it fired in the owner's incident cannot be known (another machine's store); it would produce exactly that incident. The owner, asked whether a main session should ever adopt a worktree's recovery note: "C) I don't think so." D286 kept "the session-start claim" with ccr; the claim writes to the packet and makes the drain write, and a fence may decline a promise, never a writer (D286's own rule), so the claim's lane test is in the charter from here. Roads not taken: retiring the claim (it is the only automatic recovery after a compaction that was not a /clear); the claim unfiltered and disclosed in the packet (the disclosure arrives after the queries are already staged)

D376 2026-11-02 [I] amends D235
  trig:  the store stamps a row's writer, through the tools or at the drain, or reads a row's lane; or a store this build opens holds captured rows of registered worktree sessions written before this build [I]
  resp:  self and its writers live in a store table `session_registry`, created by migration `027`, one row per session and agent: the session's own row has an empty agent id and holds the worktree, a linked worktree's directory name or none for the main checkout, the branch, the directory, git's top level and common dir; a subagent's row holds its agent id and agent type, started and stopped; the session-start hook registers the self on every start, SubagentStart registers a subagent under the parent's session id and SubagentStop retires it; a row a subagent's hook captured is stamped from the payload's agent fields at the drain, `_writer` its agent type and `_writer_src` `hook`; a row the hooks captured for the session's own agent, naming no agent, is stamped at the drain with the self the registry holds for that session, `main` or `worktree:<name>`, so a lane's captured conversation is the lane's; a row written through the tools is stamped by the server from the session it already resolves: exactly one live subagent, that subagent with `_writer_src` `registry`; none, the self, `main` in the main checkout and `worktree:<name>` in a linked worktree, with `_worktree` and `_branch`; more than one, the self with `_writer_src` `ambiguous` and the live candidates, the reply saying so, and every target it supersedes recorded as a reference, never retired; a row whose session the server or the drain cannot place while the registry exists is stamped `unregistered`, names no writer, and is read, listed and labeled "writer unknown", apart from every lane and no lane's own, its other metadata left for the reader; the reply says the writer stamped; the insert tool drops every caller copy of the stamp; the lane key reads `_writer`, a row stamped `main` and a row carrying no stamp at all, written before the store recorded writers, being one main lane; on first open this build stamps the self on every captured row of a session the registry holds with a worktree, content untouched, so those rows leave the main lane for their own [I]
  sib:   none -- a worktree's own conversation read as the main lane's, or a stranger's chapter vouched for as main's own, is the mislabelling this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D235 D190 D167 D169 D228 D243 D372 D374
# the review of the first draft, 2026-11-02 (F5): a row stamped `unregistered` names no writer, so the lane key read it as main's and the first draft would have labelled a stranger's chapter "the main checkout's own". The owner: "E) honesty first - if writer is uknown, indicate as such. agent can explore other metadata to figure out what it is. could be a human injected instruction which is fine", and to the nuance that rows from before the store recorded writers were the main session's (no worktrees then) and stay main's as D243 reads them: "a) agree with your more nuanced explanation about unknown writers." The captured-row stamp is what D374's scoped search stands on: the drain stamps a writer only for a subagent, the client's internal agent or a ticketed worker, so a worktree session's own turns and tool output read as the main lane today; the registry already holds the session's self, read at the drain as the worker lane is. The stamp on open follows D263 and D286 (re-marked on first open, content untouched) and is additive. Roads not taken: leaving captured rows unstamped and scoping search by session key (D167 makes self the checkout, not the session); folding unplaced rows into main with a note (the incident, vouched for); refusing an unplaced write (capture is never filtered, D3)
```

## 2. Scenarios (owner language), features/journal-orchestration.feature

### The `@D167` Then at line 66 keeps its words

```
    And the packet handed to a session starting in the main checkout at the same time does not carry it
```

Binding (§6) now requires the main packet to open with main's self line
and to name the worktree among other lanes, so "does not carry it" is a
negative inside a non-empty positive.

### New scenarios, after line 75 (the two `@D167` scenarios)

```
  @D372
  Scenario: a worktree's status lists its own lane's pointers and says what else exists
    Given the main checkout's live chapter summary "plan: rewrite the README's install section"
    And a live chapter summary written later from the worktree "feature-login" that reads "plan: wire the login form"
    When the session in the worktree "feature-login" calls status
    Then the developer sees the worktree's chapter as the only live pointer listed
    And the status names the worktree's lane, counts 1 live pointer of other lanes left out, names the main lane with the kind and age of its newest pointer, and says how to widen
    And the status carries none of the main checkout's chapter's text or id

  @D372
  Scenario: the main checkout's status is scoped to the main lane the same way
    Given the main checkout's live chapter summary "plan: rewrite the README's install section"
    And an older chapter summary written before the store recorded writers, reading "plan: the first release"
    And a live chapter summary written later from the worktree "subproject" that reads "plan: scaffold the subproject"
    When the main checkout's session calls status
    Then the developer sees the main checkout's chapter and the older chapter as the main lane's live pointers, newest first, and nothing else
    And the status names the main lane, counts 1 live pointer of other lanes left out, names the worktree "subproject" with the kind and age of its newest pointer, and says how to widen
    And the worktree's chapter is not listed though it is the newest in the store, and none of its text or id appears

  @D372
  Scenario: asking for every lane lists them flat, each pointer naming its lane
    Given the main checkout's live chapter summary and a live chapter summary from the worktree "subproject"
    When the main checkout's session calls status asking for every lane
    Then the developer sees both chapters in one list, newest first, each naming its lane
    And no lane is set apart and no count of lanes left out is given

  @D372
  Scenario: the other lanes are counted and at most three named, however many there are
    Given live chapter summaries from the main checkout and from 25 worktrees
    When the main checkout's session calls status
    Then the status counts 25 other lanes and names the 3 whose newest pointer is most recent, newest first
    And it names no other lane and carries no chapter text of any of them

  @D373
  Scenario: a restarted main checkout opens on its own thread and is told what else exists
    Given a session in the main checkout that wrote the chapter summary "plan: rewrite the README's install section" and then stopped
    And a session in the worktree "subproject" that wrote the newer chapter summary "plan: scaffold the subproject; next: its first test"
    When a new session starts in the main checkout under a new session id, by a startup and again by a resume
    Then the packet handed to its agent opens by saying the session runs in the main checkout and re-orients on the main lane's own thread
    And the packet carries the main checkout's chapter summary labeled as its own, with its age and id
    And the packet says 1 other lane holds a live pointer, names the worktree "subproject" with the kind and age of that pointer, and says where to look
    And the packet carries none of the worktree's chapter's text or id

  @D373
  Scenario: a main checkout with only a bookmark is handed the bookmark, never a worktree's chapter
    Given a main checkout whose only checkpoint is the live bookmark "at: README install section half rewritten"
    And a session in the worktree "subproject" that wrote the chapter summary "plan: scaffold the subproject"
    When a session starts in the main checkout
    Then the packet says the main lane has no chapter summary of its own and carries the bookmark, named as a bookmark, with its age and id
    And the packet names the worktree "subproject" among other lanes and carries none of its chapter's text or id

  @D373
  Scenario: a main checkout alone in its store opens on its own thread and names no other lane
    Given a store in which only the main checkout ever wrote, holding one live chapter summary
    When a session starts in the main checkout
    Then the packet opens with the main checkout's own line and carries its chapter summary labeled as its own
    And the packet carries no line about other lanes

  @D374
  Scenario: the orientation search is scoped to the session's own lane
    Given a main checkout session whose captured conversation and chapter summary "plan: rewrite the README's install section; next: the doctor table" are its own
    And a worktree "subproject" session whose captured conversation and newer chapter summary "plan: scaffold the subproject; next: its first test" are its own
    When the main checkout's session searches "what was I working on, what was the next step"
    Then the main checkout's hits are its own chapter and its own conversation, and none of the worktree's
    And the reply says the main lane was searched and how to widen
    And the worktree's session running the same search gets its own chapter and conversation and none of the main checkout's
    And either session asking for the whole store gets both

  @D374
  Scenario: a worktree's captured conversation belongs to the worktree's lane
    Given a session in the worktree "subproject" whose developer typed "let us scaffold the subproject" and whose tools ran
    When that worktree's session searches "scaffold the subproject"
    Then it finds the developer's turn and the tool output as the worktree's own
    And the main checkout's session searching the same words finds neither until it asks for the whole store

  @D376
  Scenario: a chapter whose writer could not be identified is set apart as writer unknown
    Given a chapter summary written through the tools by a session the server could not place, after the store recorded writers
    And the main checkout's own live chapter summary
    When the main checkout's session calls status, and then starts a new session
    Then the status and the packet list the main checkout's chapter as the main lane's own, and not the unplaced one
    And both count the unplaced chapter under a lane named "writer unknown"
    And asking for every lane lists it labeled "writer unknown", its other metadata readable

  @D376
  Scenario: rows from before the store recorded writers stay the main lane's
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    When the main checkout's session calls status and searches "first release"
    Then the chapter is listed and found as the main lane's own
    And a session in the worktree "subproject" sees it counted among other lanes, never as its own

  @D376
  Scenario: a worktree's captured rows from an earlier release move to the worktree's lane when this treecontext opens the store
    Given a store in which an earlier treecontext captured a worktree "subproject" session's turns and tool output with no writer, the worktree registered
    When this treecontext opens the store
    Then those rows carry the worktree as their writer, content unchanged
    And the main checkout's captured rows are unchanged

  @D375
  Scenario: a fresh start adopts a recovery snapshot only from its own lane
    Given a session in the worktree "subproject" that compacted, leaving a recovery snapshot unclaimed
    And a session in the main checkout that compacted earlier, leaving its own unclaimed
    When a new session starts in the main checkout
    Then its packet carries the main checkout's recovery snapshot and not the worktree's
    And the recovery row the drain writes for it quotes the main lane only
    And a session then starting in the worktree "subproject" is handed the worktree's snapshot
```

Existing scenarios unaffected in meaning: `@D169` "cannot retire the
orchestrator's pointer" (the chapter is main's own; main's scoped status
still lists it); handoff `@D165` (B's own chapter); reorientation `@D166`,
`@D158`, `@D185` (single lane). Two negatives are narrowed and must be
extended (review F9, §6).

## 3. Header and fence text

- `features/journal-orchestration.feature` header, rulings paragraph:
  append "D263 of 2026-10-10; D372 to D376 of 2026-11-02 (the main
  checkout's own lane: status, the fresh start, the orientation search,
  the recovery snapshot's lane, the captured row's stamp and the unknown
  writer)". Second paragraph: "so a stopped worktree resumes its own
  thread" becomes "so a stopped worktree, or the main checkout beside
  one, resumes its own thread; the main checkout is a lane like any
  worktree".
- `features/OUT-OF-SCOPE.md`:
  - Compaction lifecycle entry (lines 98-122): append "Amended
    2026-11-02 (D375): the session-start claim is in the charter, a
    fresh session claiming a recovery snapshot only from its own lane;
    the pre-compact snapshot and the compaction interaction stay with
    ccr."
  - New declined-alternative lines near line 356:
    "Declined alternative, The main checkout's status unscoped, its own
    pointers labelled and other lanes' chapters listed beside them — the
    main checkout is a lane like any worktree: scoped to its own by
    default, aware of the others by count and name, widened on request.
    (D372, 2026-11-02)"
    "Declined alternative, Other lanes' chapter text in a fresh start's
    packet or status — awareness is a count, at most three lane names and
    where to look; content is fetched deliberately. (D373, 2026-11-02)"
    "Declined alternative, An orientation search left store-wide with a
    label on each other lane's hit — the search is scoped to the
    session's own lane, `scope: "all"` widens. (D374, 2026-11-02)"
  - New line in the roads-not-taken block near line 437 (one trailing
    parenthetical, review F17): "Main checkout fresh start: its own line
    only beside another lane; the other lanes' chapters in the packet.
    (D373, 2026-11-02)".
  - The D167 line at 356-359 gains nothing; D372's comment records that
    main's flat status was that declined road.
- `docs/beta3-bindings-audit.md` is scoped D279–D361 (review F18): the
  vacuous D167 binding and the absent D242 go in the build unit's own
  audit note, not there.

## 4. Handshake wording (prose)

**Card (`INSTRUCTIONS_BRIEF_LEXICAL`, 1979 of 2000): no change
required.** The status reply's scope block and the query reply's scope
block say, at the moment of reading, which lane was listed or searched
and how to widen, the D237 pattern. If the owner wants the card to say
it, the exact swap, net −22 characters: in step 1 replace
`("newest N of M" means` + newline + `   stale pointers need supersession cleanup).`
with `(your own lane's; scope "all" for every lane).` The dropped hygiene
cue survives verbatim in the status reply's own `resume_message`
("supersede stale pointers to clean up the orientation panel"). Nothing
else on the card moves; the drift test's tool order and gate phrase are
untouched.

**Skill body, "Subagents, worktrees and writers"**, the last bullet
becomes:

- Every session is a lane: `main` in the main checkout, `worktree:<name>`
  in a git worktree, a role for a subagent. status lists your own lane's
  pointers, and the search "what was I working on" searches your own
  lane; each reply says so and counts the other lanes, naming the most
  recent few. scope "all" widens either to every lane; export with
  writer reads one lane's trail. A fresh start is handed your lane's own
  newest chapter (or bookmark) and the other lanes' names, never their
  text. A pointer labeled "writer unknown" belongs to no lane: read its
  metadata before trusting it. Brief a worktree or role with
  metadata.brief_for; its start and its search carry it.

The subagent-search bullet above it keeps its text; add after "otherwise
the whole store": "otherwise the session's own lane, the reply saying
why".

## 5. Open questions (only what the record and rulings do not settle)

1. **Main's own line at every start, or only beside another lane?** v2
   reads R2's symmetry as "every start", as a worktree has today. D236
   chose the conditional on a premise that failed, and D162's economy
   argues the other way. At stake: one self line and main's own chapter
   added to every main start, versus one rule with a condition to
   explain. Light confirmation; the scenarios above assume every start.
2. **The one-time stamp on open for worktree captures already stored
   (D376).** It is additive and follows D263/D286, but it moves existing
   rows out of the main lane's trail, which an owner reading an old store
   with `export writer main` will notice. Alternative: stamp only from
   this build forward and let old worktree captures stay main's,
   disclosed. At stake: whether a worktree's pre-beta.3 history is
   findable by the worktree's scoped search.

## 6. Binding notes — what each Then must observe

General. Sessions start through the stand-in for Claude Code's hooks
(`tests/journal/standins.ts`, the existing `sessionStart` helper with a
real `git worktree add` through `openGitWorld`/`addWorktree`,
journal-orchestration.steps.ts:286, 313). Chapters are written through
the insert tool from the registered session so the stamp is the store's.
Status and query run through an MCP client opened under the session's own
id: `statusPanel` (journal-reorientation.steps.ts:294) reuses `w.client`,
so a step that switches between the main and the worktree session must
open a fresh client with `mcpOver(w, { ccSessionId })` or status runs as
the wrong self (review F15). The worktree's chapter is always written
*after* main's so newest-first would have led with it. "A row written
before the store recorded writers" is inserted the way D263's binding
writes an earlier release's row (steps 483-503): staged as that release
staged it, no writer and no writer source, then the real drain; no
helper for it exists in standins.ts.

- **D167 Then, "does not carry it"**: the main packet's first line is
  main's self sentence (proves the placed-main branch ran); a line in it
  names the worktree `feature-login` among other lanes (proves the packet
  saw the lane); no line contains the chapter's text or id. A binding
  that passes on an empty packet fails the first two asserts.
- **Worktree status scoped**: `resume_pointers` has exactly the worktree
  chapter's id; the block names the lane `worktree:feature-login`, counts
  1 left out, lists one lane entry naming `main` with kind "chapter
  summary" and an age; the serialized reply does not contain main's
  chapter text or id outside that lane name.
- **Main status scoped**: own list is [main chapter, pre-registry
  chapter] in that order by id; the block names `main`; other-lane count
  1; lane entry `worktree:subproject`, kind, age, pointer count 1; assert
  by SQL that the worktree chapter's `created_at` is the maximum among
  live pointers, and that its id and text are absent from the whole
  serialized reply except nowhere (search the JSON string).
- **Every lane flat**: with the widen, both ids in one list, worktree's
  first, each pointer carrying a lane name; no block.
- **25 worktrees**: 25 `git worktree add`s and 25 registered sessions,
  each with one chapter at increasing moments; block count 25; exactly 3
  lane entries, the three newest by chapter time; no chapter text in the
  reply.
- **Main fresh start**: run `sessionStart` for `startup` and again for
  `resume` under new session ids (review F14); each packet: first line
  the self sentence; an own-chapter line matching the own label with an
  age and `(id <main chapter id>)`; the other-lanes line with count 1,
  `subproject`, kind and age, and the words for status scope all and
  export by writer; the worktree chapter's text and id absent from the
  whole packet.
- **Bookmark-only main**: the no-chapter sentence present; a bookmark
  line with "bookmark", age and the bookmark's id; the worktree named;
  its chapter text and id absent.
- **Main alone**: self sentence first; own-chapter line; no other-lanes
  line at all (assert the absence of the count sentence, not merely of a
  name).
- **Scoped search (D374)**: the main session's hits' ids are a subset of
  main's rows (SQL: `_writer` main or no stamp, for that store), include
  main's chapter and at least one captured turn, exclude every worktree
  row; the reply's scope block names `main` and the widen; the worktree
  session symmetrically; `scope: "all"` returns both chapters and no
  scope block (the D150 binding already asserts `scope` undefined for
  `all`; keep it). Conversation windows of main's hits contain no
  worktree row.
- **Captured rows in the worktree's lane**: stage a user turn and a tool
  event through the real hooks' stand-in under the worktree session, run
  the drain, read back `_writer` = `worktree:subproject` on both rows by
  SQL; then the two searches as above.
- **Writer unknown**: write the chapter through a client whose session
  id the registry does not hold (the server stamps `unregistered`;
  verify by SQL); main's status own list excludes it; block names a lane
  "writer unknown" with count 1; main's packet likewise; `scope: "all"`
  shows it with the label and its metadata.
- **Pre-registry rows stay main's**: the unstamped chapter in main's own
  list and in main's scoped search hits; the worktree's status block
  counts it under `main`.
- **Stamp on open**: a store prepared as an earlier release left it
  (registry holding the worktree session; its captured rows with no
  writer), opened by this build; SQL shows `_writer` `worktree:subproject`
  on those rows, content bytes unchanged (compare before/after), and
  main's captured rows unchanged; a second open changes nothing.
- **Snapshot lane (D375)**: write two snapshots through the pre-compact
  hook's stand-in, one per session (worktree's newer); start main; the
  packet names the main snapshot's id and not the worktree's; the
  `snapshots` table shows the worktree's still unclaimed; drain; the
  recovery row's quoted entries are all main-lane rows (SQL on the row's
  refs); start the worktree; its packet names the worktree's snapshot.
- **Narrowed negatives to extend (F9)**: journal-orchestration.steps.ts
  478-479 (D263) and journal-handoff.steps.ts 514-515 (D206) assert only
  `resume_pointers`; each must also assert the scope block counts 0
  other-lane pointers and names no lane for the row in question, so a
  row cannot hide in the block.
- **Hollow traps to refuse**: asserting on raw `metadata._writer` of a
  flat list (today's behaviour); calling status or query from a session
  the server cannot place (falls into the unplaced branch and passes for
  the wrong reason; assert the block names the lane); writing a worktree
  chapter by raw SQL with a hand-stamped writer (bypasses the registry
  D190 makes the stamp come from); a "25 worktrees" binding that registers
  sessions by inserting registry rows directly.

## Review findings → v2

| Finding | v2 |
|---|---|
| F1 docket form (`trig` + `->`) | All five entries take the behavioural shape: `trig`, `resp`, `sib`, no `->`. |
| F2 amends must restate; D236 contradicted | Split into D372 (amends D242), D373 (amends D236), D374 (amends D237), D375 (amends D286), D376 (amends D235); each restates its target in full; D373 touches D372. |
| F3 D167 Then reversed | Words kept verbatim; bound non-vacuously (self line first, worktree named, text and id absent). Q-A ruled R3: no other lane's content. |
| F4 orientation query unlit | R4: D374 scopes the search to the own lane for every placed session; subagent rules kept coherent (provisional → D237; concurrent/ambiguous → own lane with why; unplaced → whole store). |
| F5 unplaced rows as main's own | R7/R7a: D376 — marked rows are "writer unknown", apart from every lane; unmarked pre-registry rows stay main's. |
| F6 snapshot claim cross-lane | R5: D375 — claim only from the own lane; recovery queries scoped; fence amended; scenario added. |
| F7 card at 1979/2000 | No card change; optional swap specified exactly, net −22; rule lives in the skill body and in the replies' scope blocks. |
| F8 unbounded packet and block | Caps: own list {20}; other lanes counted and at most {3} named; no content; self lines inside the start budget. |
| F9 narrowed negatives | Named in §6 with the extension both bindings need. |
| F10 bookmark-only main | D373: the lane's live bookmark named as a bookmark; scenario added (for both lanes by symmetry). |
| F11 vague "as before" Thens | Replaced with positive Thens (own line present, no other-lanes line; block absent under every-lane). |
| F12 owner language | "written before the store recorded writers"; "writer unknown"; "chapter summary" kept as the kind word. |
| F13 handoff lanes in status | Dropped; imported entries are never pointers (D206). |
| F14 sources unstated | D373 trig names startup, resume and after a compaction; the fresh-start scenario binds startup and resume. |
| F15 nonexistent helper; client reuse | Pre-registry rows written as the D263 binding writes an earlier release's row; `mcpOver` per session noted. |
| F16 tags and header | One ruling tag per new scenario; header lists only tags the file carries (D263 added, D372–D376). |
| F17 fence grammar | New lines with one trailing parenthetical; the D167 line untouched; main's flat status named as that declined road in D372's comment. |
| F18 audit placement | Build unit's own audit note, not beta3-bindings-audit.md. |
| Q-A content in packet | R3: names and counts only. |
| Q-B the search | R4: scoped by default. |
| Q-C snapshot | R5: own lane only. |
| Q-D worktree scenarios | R6: four worktree-side scenarios (status, restart kept, new-worktree kept, captured lane, unknown writer seen from a worktree). |
| Q-E unknown writer | R7/R7a. |
| Reviewer's resolved Q2/Q3/Q5 | Per lane with counts and no text (stronger than "newest chapter per lane": R3 forbids content); bookmarks counted, shown only as the own lane's bookmark-only line; the "return you were waiting for" sentence dropped. |
| Residual: two main sessions | Disclosed in D372's comment. |
