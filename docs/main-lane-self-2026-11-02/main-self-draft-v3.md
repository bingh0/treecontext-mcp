# Draft v3: the main checkout's half of D167, under R1–R11

Repo read-only; nothing touched; no journal writes. Line refs are
`beta.3/node-sqlite` at add7004. Entries D372–D377 (D377 is the owner's
[V] schedule and process ruling, R9/R11). The docket entries, the
scenarios, the fence lines and the DESIGN.md paragraph below were
appended to a scratch copy of `features/` at
`/tmp/claude-1000/-home-<user>-Documents-treecontext-mcp/bd91acc7-8f45-4fe0-ba79-b27f76ef86c1/scratchpad/lint3/features`
and linted with `docketry lint features/DOCKET.md --corpus features --json`:
45 findings before, 58 after; the 13 new ones are exactly the expected
`inferred` (provenance under [I], cleared by the owner's ratifying entry)
and `rewrite` ×5 (an [I] amending a ratified chain; precedent D357). No
`touches-later`, `unspread`, `spread-no-outline`, `uncited-trigger`,
`bare-digit-run`, `not-in-design` or `not-in-fence` was added.

## Re-review claims verified against the repo

| Claim | Checked |
|---|---|
| D147 binding asserts no scope block and finds the tester's report (steps.ts:421-426) | true; the report is stamped the tester's writer, same session as the orchestrator |
| D263 "the orchestrator searching the report's own words finds it"; writer `claude-code` | true (feature:28; ingestion.ts:639-642) |
| D151 import in a `handoff:` lane; B's client placed by `ccSessionId` (handoff.steps.ts:130) | true; the importer's session is kept as `_handoff_importer` (handoff.ts:38, 132; server.ts:1528) |
| D240 in effect: `concurrent`/`ambiguous` search the whole store with `why` (server.ts:924-930) | true |
| recovery row carries no session and no writer (ingestion.ts:587-598) | true: `target.insert(recoveredText, { metadata: { source, original_session_id, … } })` |
| `newestMainEvent` reads unstamped captures as the main agent's evidence (session-registry.ts:293-310) | true; a drain stamp would have broken it |
| registry upsert records the last registration (session-registry.ts:184-191) | true (`ON CONFLICT … DO UPDATE SET worktree = excluded.worktree`) |
| ambiguous lane retires nothing (flat-store.ts:1466-1471, 1683-1686) | true; "writer unknown" must not be that lane |
| resume budget 500 characters; worktree self lines prepended outside it (shared.ts:442-447; session-start.ts:310-316) | true |
| DESIGN.md:428-447 is the `[ruled: D235 … D263]` passage with the D371 amendment after it | true |
| `sessionStart` is local to journal-orchestration.steps.ts:127; no pre-compact stand-in exists | true (standins.ts header lists none) |
| helpers' parent link: subagents share the parent's session id (D235); workers carry `parent_session` in the registry (leg-registry.ts:91, 388) | true |

## The position under R1–R11

Symmetry, read from the registry, nothing new stamped. Every placed
session, main or worktree, is scoped to its own lane by default at
status (D372), the fresh-start packet (D373) and the search (D374); each
reply counts the other lanes, names at most {3} with kind and age, never
text or id, and says how to widen. A lane's default search is **the
sessions the registry places in that checkout**, plus each helper's
report by the parent link (a subagent's summary in the shared session, a
worker's summary row by its registration's parent), plus the lane's
imports; never a helper's trail (R8). The lane of a *pointer* stays its
writer stamp (D228/D243, unchanged); a row stamped `unregistered` is
"writer unknown", its own lane for supersession so an unplaced client's
panel stays bounded (F6), never main's (R7); a row with no stamp at all
stays main's (R7a). A recovery snapshot is claimed only from the own
lane and its row is written in the claiming session (R5, F3). The flood
is bounded by construction (R8a): one row per helper, never a pointer,
ranked below the lane's own chapter by role weight, the other lanes
counted and three named. The search scope ships in beta.3 (R9, D377).

Two judgments the record settles, disclosed: main's own line at every
start (R2, R4; D236's premise failed; the self lines stay outside the
budget so a resume is not cut); an import whose importing session the
registry cannot place lands in the main lane (D151 [I>V] "B searching
finds that summary" must hold for a B that never registered).

## 1. Docket entries (as linted)

```

D372 2026-11-02 [I] amends D242
  trig:  a session calls status, registered in the main checkout, in a linked worktree, or one the server cannot place [I]
  resp:  a session registered in a linked worktree calls status and sees the live pointers of that worktree's own lane, with a `scope` block naming the lane, the count of other lanes' live pointers left out and how to widen; a session registered in the main checkout sees the same, scoped to the main lane, under the same block; in either case the block also says how many other lanes hold live pointers and names at most {3} of them, the most recently active first, each with the kind and age of its newest live pointer and the count of its live pointers, never its text or id, the lane of pointers whose writer could not be identified named "writer unknown" among them and never any lane's own; the own list keeps the cap D166 sets, with the total stated; `scope: "all"` lists every lane's pointers flat as before, each pointer naming its lane, with no block; a session the server cannot place sees every lane flat, the block saying it could not be placed; a session whose caller cannot be told apart from a live subagent is scoped to its self as before, since status has no caller but the session [I]
  sib:   none -- a main checkout orienting on a worktree's chapter because it was newest in a flat list is the confusion D167 removes, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D242 D167 D190 D243 D169 D166 D158 D240
# the owner's incident, 2026-11-02, on another machine's store: two Claude Code sessions on one store and one repo, A in the main checkout (documentation), B in a linked worktree (a new subproject); A quit and restarted while B wrote a chapter summary; the restarted A oriented on B's chapter as its own thread and recovered only by replaying its own transcript. D242 scoped the worktree's status and left main's flat, every lane newest first, the writer inside raw metadata only: the road the fence declines, "re-orienting from the project's newest chapter regardless of who wrote it" (D167), live in the build for the main checkout since D242. A first draft kept main unscoped and labelled; the owner reversed it: "fundamentally, i do not see a difference between "main" and a worktree - they are all reflections and separate spaces within the store. So labeling each writer, including main, would make searching/filtering very easy, yes? A) be aware of other lanes or namespaces or checkouts … when main starts, but no need to auto fill - would get messy if there are a 1000 worktrees." The lane names stay the filesystem's: "my idea of labeling by branch won't work then. i think the worktree: nomenclature will ahve to do since it's the file system truth." On the worktree half carrying full scenarios: "D) I believe that git worktrees are fairly fundamental unit for subagents and should be fully described in feature file scenarios." Residual, disclosed: two sessions in one main checkout share one self by D167 [V], so a peer main session's chapter is this session's own thread by ruling, not a defect. Roads not taken: main unscoped with its own pointers labelled and the other lanes' chapters listed apart (the first draft; the orchestrator's convenience bought with the peer's confusion, and content auto-filled against the owner's A); a flat list labelled by writer in each preview (order still says "newest is yours"); naming other lanes without a cap (a thousand worktrees); asking the main session at start whether it orchestrates (an interactive gate, and the answer changes mid-session)

D373 2026-11-02 [I] amends D236
  trig:  a session starts in a linked worktree or in the main checkout other than by a /clear, at a startup, a resume or after a compaction alike [I]
  resp:  a session starting in a linked worktree opens its packet with that worktree's own thread: the newest live chapter summary whose `_writer` is `worktree:<name>`, from any session that ran there, labeled as the worktree's own with its age and referrers; and the brief addressed to it, the newest entry whose metadata `brief_for` names the worktree, with its writer and age; a session starting in the main checkout opens its packet the same way: a line saying it runs in the main checkout and re-orients on the main lane's own thread, the main lane's newest live chapter summary labeled as its own with its age, id and referrers, and the brief addressed to `main` when one exists; either lane with no chapter summary of its own but a live bookmark is handed that bookmark named as a bookmark with its age and id, and says no chapter summary exists; a lane with neither says it starts fresh; the brief is the means of "the orchestrator injected the brief at its start": an entry the orchestrator writes through the insert tool before the worktree's first session; the packet then says how many other lanes hold live pointers and names at most {3}, the most recently active first, each with the kind and age of its newest live pointer, and where to look, status with `scope: "all"` and export by writer, never another lane's text or id, and nothing when no other lane holds one; the self lines stay outside the start's budget, each bounded: the chapter by its first line, the other lanes by the count and the names; the /clear packet is unchanged [I]
  sib:   none -- a packet that hands a session another lane's chapter, labelled or not, is the anchoring this prevents, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D236 D167 D372 D160 D162 D190
# the incident of D372. D236 had left the main checkout's fresh start unchanged "because no scenario binds it and the status panel already serves it"; the panel did not, and the D167 Then "the packet handed to a session starting in the main checkout at the same time does not carry it" was bound against a packet that carried no self line by construction, vacuously green; the Then keeps its words and binds against a packet that opens with main's own line. The owner on content: "be aware of other lanes … but no need to auto fill - would get messy if there are a 1000 worktrees." Main's own line at every start, not only beside another lane, follows the owner's symmetry ("i do not see a difference") and "main should get main"; D236's premise, the panel serving it, is the one that failed; the cost is what a worktree already pays, and bounded. The bookmark line is D160's bookmark-only path carried to the fresh start, since a documentation session nobody checkpointed leaves a bookmark and nothing else. The self lines stay outside the budget because a resume's budget is {500} characters and the worktree's own anchor would be cut by its own line. Roads not taken: the other lanes' newest chapters in the packet, labelled as theirs (the first draft; anchoring on text in front of the model is the hazard, label or none); main's self line only beside another lane (D162's economy, declined for symmetry); one line per other lane with no cap; the self lines inside the budget

D374 2026-11-02 [I] amends D237
  trig:  a session searches without asking for the whole store: the session's own agent in the main checkout or a linked worktree, a subagent, or a caller the server cannot place [I]
  resp:  a search by a caller the registry resolves to the session's one live subagent defaults to that subagent's scope: rows the store stamped with its role as writer, the live resume pointers of the lane that spawned it, the session's self, the entries whose `brief_for` names its role, and the entries those pointers and briefs reference, one hop; a search by the session's own agent, in the main checkout or in a linked worktree, defaults to its own lane, read from the registry at the moment of the search as D376 rules: the rows of every session the registry places in that checkout, the session's own agent's rows, the client's own internal summaries and each helper's report alike, a subagent's summary row or a worker's, the worker's by the parent link of its registration, never a helper's trail, its tool calls and turns staying in its own lane; the entries imported by a session of that lane, or by none the registry places, which land in the main lane; for the main lane also the rows of sessions the registry never held; never a row of an undetermined writer; and the entries its live pointers and briefs reference, one hop; a caller that cannot be told apart from a live subagent, `concurrent` or `ambiguous`, searches the whole store as D240 rules, the reply saying why; a caller the server cannot place searches the whole store, the reply saying so; the scope is applied in the store before the result count and to every hit's conversation window; the reply names the lane searched and how to widen, and `scope: "all"` searches the whole store with no scope block; no new parameter is added; a writer's whole trail is read by `treecontext_export` with `writer`, a role or one subagent's agent id, `main` or `worktree:<name>`, oldest first [I]
  sib:   none -- an orientation query answered by another lane's newest chapter is the confusion D167 removes at the handshake's second step, not a behaviour
  serves: N20 N21 N23 N24
  touches: D237 D167 D264 D150 D240 D147 D263 D151 D186 D336
# the handshake's second step, "what was I working on, what was the next step", runs store-wide with recency fusion at {0.25} (D264, D273), so in the incident of D372 the worktree's newer chapter is the likeliest top hit after the panel is fixed; the review of the first draft found the step unlit. The owner: "what i was working on depends on what lane/namespace we are in. main should get main, worktree gets it's own worktree, subagent gets whatever the supervising agent or harness feeds it." A second draft scoped by writer stamp and would have hidden what D147 [V] promises the orchestrator (its subagents' reports), D263's internal summaries and D151's imports; the second review found it, and the owner, asked whether main's default search should still find what its helpers produced: "q1 - what about scenarios like flooding - there are dozens or hundreds of subagents or work trees - how do we manage that?", answered by the lane read from the registry (D376) and the flood scenario: one row per helper, ranked and previewed, never a resume pointer. Shipping: "q2 - i would prefer to hold up beta.3 to include the full filtering. we can dogfood it here." D240's whole-store rule for a caller that cannot be told apart stands, since a guess must not act as a lane's own (D235's comment); status still scopes such a session to its self, disclosed in D372. D264's "no new query parameter" holds: `scope: "all"` existed. Roads not taken: the search left store-wide with a label on each other-lane hit (a label in front of the model is what failed in the incident, and the owner ruled scope); a parameter for orientation (D264 declined it); scoping the search and not the window (the window would leak the other lane around every hit); the scope by writer stamp (hides the helpers' reports)

D375 2026-11-02 [I] amends D286
  trig:  a session starts after a compaction and the drain runs the recovery queries the pre-compact snapshot recorded; a fresh session starts while an unclaimed recovery snapshot exists; or a store an earlier release left with recovery snapshot rows is opened [I]
  resp:  the recovery snapshot row is machine output quoting the journal, bounded like a tool event: it quotes each hit at the hit's display view and no further than the quote cap, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display and index boundaries, so a hit on it is a bounded preview with the availability marker and its reach into the index is the tool default; on first open this build stamps the same boundaries on every recovery snapshot row a store already holds, content untouched; a fresh session claims a recovery snapshot only when the session that left it had the same self, the main checkout's for a main session and the same worktree's for a worktree session, newest first; a snapshot left by another lane is left for that lane; a snapshot whose session the registry does not hold is claimed by no one and stays in its table; the recovery queries the drain runs for a claimed snapshot are scoped to that lane as a search by the claiming session would be, and the recovery row is written in the claiming session and so in its lane, never in no session; the pre-compact snapshot itself and the compaction interaction stay with ccr, but what the drain writes to the store is in the charter from here [I]
  sib:   none -- a row the store writes about itself growing without a boundary, or a session answering another lane's recovery queries into its own, is what this prevents, not a behaviour
  serves: N1 N4 N23 N5
  touches: D286 D35 D167 D372 D374
# found by the review of the first draft, 2026-11-02: on a startup the session-start hook claims the newest unclaimed snapshot of any other session, with no lane, worktree or directory test, writes its queries into the packet and stages a row the drain answers store-wide; only a startup claims, so a worktree's compaction leaves a snapshot the main checkout's next start takes. Whether it fired in the owner's incident cannot be known (another machine's store); it would produce exactly that incident. The owner, asked whether a main session should ever adopt a worktree's recovery note: "C) I don't think so." The second review found the drain's own write: the recovery row carried no session and no writer, so even a worktree's own recovery row read as the main lane's, the D286 specimen again. D286 kept "the session-start claim" with ccr; the claim writes to the packet and makes the drain write, and a fence may decline a promise, never a writer, so the claim's lane test and the row's session are in the charter from here. A snapshot left before the store recorded sessions is not claimed; it stays in its table, disclosed rather than claimed for main. Roads not taken: retiring the claim (it is the only automatic recovery after a compaction that was not a /clear); the claim unfiltered and disclosed in the packet (the disclosure arrives after the queries are already staged)

D376 2026-11-02 [I] amends D243
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, never a placed lane's, and a placed lane's writer never retires one of them, recording it as a reference; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` includes the older rows naming no writer, and by a role the older rows claiming it as `agent_type` with no stamp, as the lane key reads them; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a worktree's own conversation read as the main lane's, or a stranger's chapter vouched for as main's own, is the mislabelling this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D243 D235 D228 D240 D190 D167 D169 D166 D372 D374
# the review of the first draft, 2026-11-02: a row stamped `unregistered` names no writer, so the lane key read it as main's and the first draft would have labelled a stranger's chapter "the main checkout's own". The owner: "E) honesty first - if writer is uknown, indicate as such. agent can explore other metadata to figure out what it is. could be a human injected instruction which is fine", and to the nuance that rows from before the store recorded writers were the main session's (no worktrees then) and stay main's as D243 reads them: "a) agree with your more nuanced explanation about unknown writers." The second review found that "no lane's own" read as the ambiguous lane, which retires nothing, would stop supersession for every client without hooks and grow its panel without bound against D166; the undetermined writers are therefore one lane for supersession, labelled and apart. The lane read at query time is the second review's design, adopted by the owner: the drain stamps no writer on a session's own captured rows today, so a worktree's turns and tool output read as the main lane by the lane key; a stamp at the drain would have broken the concurrent-caller evidence that reads those rows unstamped (D240), and a stamp on open would have rewritten rows in place from the registry's last registration, a later reading spelled like a live stamp; the registry already maps each session to its checkout and each helper to its parent, a fact of record read where it is used, covering old and new rows alike. Residual, disclosed: a session id started again in another checkout re-registers there, and its earlier rows follow it. Roads not taken: stamping the self on captured rows at the drain (D240's evidence, and a new writer source to name); a stamp on first open (an edit in place that changes which lane owns rows, on a later reading); folding unplaced rows into main with a note (the incident, vouched for); refusing an unplaced write (capture is never filtered, D3)

D377 2026-11-02 [V]
  resp:  the lane-scoped search of D374 ships in `0.1.0-beta.3`, the release waiting for it, dogfooded on the owner's machines first; the build follows the aBDD pathway though this slice was not formally scoped: failure-ladder reviews, model triage for builders by difficulty, a Fable gate last, and per-unit binding counts recorded [V]
  ->     boundary
  serves: N23 N24 N31
  touches: D374 D372 D373 D375 D376 D370
# the owner, 2026-11-02, after the second review: "q2 - i would prefer to hold up beta.3 to include the full filtering. we can dogfood it here." and "go ahead with v3, make sure we follow the aBDD pathway even though this wasn't formally scoped - failure-ladder reviews, efficient subagent model triage, etc." Road not taken: the status panel, packet, snapshot rule and unknown writer in beta.3 with the search scope in beta.3.1 (the second review's option; leaves the handshake's second step able to surface a worktree's newer plan)
```

## 2. Scenarios, features/journal-orchestration.feature

The `@D167` Then at line 66 keeps its words:
`And the packet handed to a session starting in the main checkout at the same time does not carry it`
— bound non-vacuously (§6). The new scenarios go after line 75, the two
`@D167` scenarios, in this order:

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

  @D372 @D373
  Scenario Outline: the other lanes are counted and at most three named with <lanes> other lanes
    Given the main checkout's live chapter summary and live chapter summaries from <lanes> worktrees, each written later than the last
    When the main checkout's session calls status and then starts a new session
    Then the status and the packet each count <lanes> other lanes and name the <named> whose newest pointer is most recent, newest first
    And neither carries any other lane's chapter text or id

    Examples:
      | lanes | named |
      | 0     | 0     |
      | 1     | 1     |
      | 3     | 3     |
      | 5     | 3     |

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
  Scenario: a lane's search finds its helpers' reports and its imports, never a helper's trail
    Given a main checkout session that spawned a tester subagent whose 40 tool calls and report "12 tests pass, CSRF fails" are stored
    And a worker the same session spawned through the ticket door, whose return "the doctor table is written" is stored with its 30 tool calls
    And a handoff file from developer A holding "plan: wire the login form" that this session imported
    And a worktree "subproject" session that spawned its own tester whose report reads "the subproject's first test passes"
    When the main checkout's session searches without asking for the whole store
    Then it finds the tester's report, the worker's return and the imported plan by their words
    And it finds none of the tester's or the worker's tool calls until it asks for the whole store
    And it finds the subproject's tester's report only when it asks for the whole store

  @D374
  Scenario: a worktree's conversation from an earlier release is the worktree's own
    Given a store in which an earlier treecontext captured a worktree "subproject" session's turns with no writer
    When the session in the worktree "subproject" searches those turns' words
    Then it finds them as its own, and the main checkout's session finds them only when it asks for the whole store
    And the store's rows are unchanged byte for byte

  @D374
  Scenario: two hundred helpers do not displace the main checkout's own thread
    Given a main checkout session holding the chapter summary "plan: rewrite the README's install section; next: the doctor table"
    And 200 subagents that session spawned, each leaving a report that mentions its next step
    When the main checkout stops and a new session starts in it
    Then the status lists the chapter as the main lane's only live pointer and counts no other lane
    And the packet carries the chapter as the main checkout's own and no report
    And the orientation search places the chapter above every report, the reports found below it by their own words

  @D375
  Scenario: a fresh start adopts a recovery snapshot only from its own lane
    Given a session in the worktree "subproject" that compacted, leaving a recovery snapshot unclaimed
    And a session in the main checkout that compacted earlier, leaving its own unclaimed
    When a new session starts in the main checkout
    Then its packet carries the main checkout's recovery snapshot and not the worktree's
    And the recovery row the drain writes for it is the main lane's own and quotes the main lane only
    And a session then starting in the worktree "subproject" is handed the worktree's snapshot, and the recovery row written for it is the worktree's own, never the main lane's

  @D376
  Scenario: a chapter whose writer could not be identified is set apart as writer unknown in every lane
    Given a chapter summary written through the tools by a session the server could not place, after the store recorded writers
    And the main checkout's own live chapter summary and the worktree "subproject"'s own
    When the main checkout's session calls status and then starts a new session
    Then the status and the packet list the main checkout's chapter as the main lane's own, and not the unplaced one
    And both count the unplaced chapter under a lane named "writer unknown"
    And a session in the worktree "subproject" calling status counts the unplaced chapter under "writer unknown", never as its own, and its packet does the same
    And asking for every lane lists it labeled "writer unknown", its other metadata readable

  @D376
  Scenario: an unplaced writer's chapters still supersede one another
    Given a client the server cannot place that wrote the chapter summary "plan: the first draft" and then a chapter summary that supersedes it
    When the main checkout's session calls status asking for every lane
    Then the developer sees the newer chapter as the one live pointer labeled "writer unknown", the first superseded
    And the main checkout's own chapter summary is still live

  @D376
  Scenario: rows from before the store recorded writers stay the main lane's
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    When the main checkout's session calls status and searches "first release"
    Then the chapter is listed and found as the main lane's own
    And a session in the worktree "subproject" sees it counted among other lanes, never as its own
```

Existing scenarios whose meaning holds: `@D147`, `@D263`, `@D151` (the
lane's search includes helpers' reports, internal summaries and imports;
their bindings change only in asserting the scope block, §6); `@D169`
"cannot retire the orchestrator's pointer" (main's own); handoff `@D165`;
reorientation `@D166`, `@D158`, `@D185`.

## 3. Header, fence and DESIGN.md text (as applied to the scratch copy)

- **journal-orchestration.feature header**, rulings paragraph: append
  "D263 of 2026-10-10; D372 to D377 of 2026-11-02 (the main checkout's
  own lane: status, the fresh start, the search scope read from the
  registry, the recovery snapshot's lane, the unknown writer, the beta.3
  schedule)". Second paragraph: "so a stopped worktree resumes its own
  thread" → "so a stopped worktree, or the main checkout beside one,
  resumes its own thread; the main checkout is a lane like any worktree,
  and a lane is read from where its sessions ran, never stamped after
  the fact".
- **OUT-OF-SCOPE.md**: compaction entry (98-122) gains "Amended
  2026-11-02 (D375): the session-start claim is in the charter, a fresh
  session claiming a recovery snapshot only from its own lane and the
  recovery row written in the claiming session; the pre-compact snapshot
  and the compaction interaction stay with ccr." Three declined
  alternatives before the D167 line at ~356 (main unscoped and labelled,
  D372; other lanes' chapter text, D373; search store-wide with labels or
  scoped by writer stamp, D374), each with one trailing parenthetical.
  Two roads-not-taken lines before the lane-model line at ~438: "Main
  checkout fresh start: its own line only beside another lane; the other
  lanes' chapters in the packet. (D373, 2026-11-02)" and "Lane
  derivation: a self stamped on captured rows at the drain; a stamp on
  first open rewriting stored rows. (D376, 2026-11-02)".
- **DESIGN.md** after the D371 amendment at :447, in its form:
  "Amended 2026-11-02: the main checkout is a lane like any worktree.
  Status is scoped to the session's own lane for both, the block
  counting other lanes and naming at most three with kind and age, never
  text; a main checkout's fresh start opens on the main lane's own
  chapter (or bookmark) the way a worktree's does, the other lanes
  counted and named, outside the budget. The default search is the
  session's own lane, read from the registry at the search: the sessions
  that ran in that checkout, each helper's report by its parent link, the
  lane's imports, never a helper's trail; a caller that cannot be told
  apart still searches the whole store (D240). A recovery snapshot is
  claimed only from the own lane and its row written in the claiming
  session. A row stamped `unregistered` is "writer unknown", its own lane
  for supersession, never main's; a row with no stamp at all stays
  main's. Nothing new is stamped and nothing stored is rewritten.
  [ruled: D372, D373, D374, D375, D376, D377]"
- The vacuous D167 binding and the formerly absent D242 are recorded in
  the build unit's own audit note (not beta3-bindings-audit.md, scoped
  D279–D361).

## 4. Handshake wording (prose)

**Card: no change** (1979 characters; pinned lines in
tests/server/instructions-drift.test.ts:25-26; "measured, not assumed").
The status reply's scope block and the query reply's scope block carry
the rule at the moment of reading, the D237 pattern. The optional swap of
v2 is withdrawn (F15).

**Skill body, "Subagents, worktrees and writers"**: the last bullet
becomes:

- Every session is a lane: `main` in the main checkout, `worktree:<name>`
  in a git worktree, a role for a subagent. status lists your own lane's
  pointers, and your search covers your own lane: what ran in this
  checkout, your helpers' reports (a subagent's summary, a worker's
  return) and the handoffs imported here, never a helper's tool calls.
  Each reply says so, counts the other lanes and names the most recent
  three. scope "all" widens either; export with writer reads one lane's
  trail. A fresh start is handed your lane's own newest chapter (or
  bookmark) and the other lanes' names, never their text. A pointer
  labeled "writer unknown" belongs to no lane: read its metadata before
  trusting it. Brief a worktree or role with metadata.brief_for; its
  start and its search carry it.

The subagent-search bullet above it keeps "otherwise the whole store"
(D240 stands).

## 5. Open questions

None that the record and the rulings leave open. Two build risks are
named for the builder, not the owner: the flood scenario's "places the
chapter above every report" relies on the role weight (note 1.0 against
assistant 0.25, D272) outranking recency fusion at 0.25 for two hundred
newer reports; if a binding shows it does not, that is a D275-class
placement rule to raise, not a wording change. And a B that never
registered (the handoff bindings) searches the whole store as unplaced,
which still finds the import; the scenario's words hold either way.

## 6. Binding notes — what each Then must observe

General. Sessions start through the real session-start hook: the local
runner `sessionStart` at journal-orchestration.steps.ts:127 (`runHook`),
with real `git worktree add` through `openGitWorld`/`addWorktree`
(:286, :313). Subagents through `hooksSubagent` in standins.ts. The
pre-compact hook has no stand-in: add `preCompact` to standins.ts beside
`hooksLeg` (Claude Code firing PreCompact with its payload), per
AGENTS.md "stand-ins live in one place". Status and query run through
`mcpOver(w, { ccSessionId })` (tests/journal/world.ts:87) opened under
the session being tested; `statusPanel` reuses `w.client`, so a step
that switches sessions opens a fresh client or it runs as the wrong
self. The worktree's chapter is always written after main's. A row
"written before the store recorded writers" is staged as D263's binding
stages an earlier release's row (steps.ts:483-503: raw staging insert,
no writer and no writer source, then the real drain); no standins helper
exists for it and none is needed. Bindings that today assert no scope
block are revisited, not deleted: orchestration.steps.ts:426 (D147) and
:624 (D150) now expect the block naming `main`; session-registry.test.ts
:199 keeps the whole-store note (D240 stands), :271 and :275 expect
main's block.

- **D167 Then "does not carry it"**: main's packet's first line is the
  main self sentence; a line names `feature-login` among other lanes with
  kind and age; the chapter's text and id are absent from the whole
  packet. An empty packet fails the first two asserts.
- **Worktree status**: `resume_pointers` is exactly the worktree
  chapter's id; `scope.lane` is `worktree:feature-login`; `other_lanes`
  count 1; one lane entry naming `main` with kind "chapter summary" and
  an age; main's chapter text and id absent from the serialized reply.
- **Main status**: own list is [main chapter, pre-registry chapter] by
  id in that order; block names `main`; count 1; entry `worktree:subproject`
  with kind, age, pointer count 1; SQL shows the worktree chapter's
  `created_at` is the maximum among live pointers; its id and text absent
  from the whole serialized reply.
- **Every lane flat**: both ids in one list, worktree's first, each with
  a lane name; no `scope` key.
- **Outline (0/1/3/5 lanes)**: that many `git worktree add`s and
  registered sessions, each with one chapter at increasing moments;
  status block and packet line both count `<lanes>` and name exactly
  `<named>`, the newest by chapter time; for 0 the packet has no
  other-lanes sentence at all; no chapter text of any other lane in
  either.
- **Main fresh start (startup and resume)**: two new session ids, one
  per source; each packet: self sentence first; an own-chapter line
  with age and `(id <main chapter id>)`; the other-lanes line with count
  1, `subproject`, kind, age and the widen words; the worktree chapter's
  text and id absent. For `resume`, assert the packet is longer than the
  500-character budget would allow if the self lines were inside it
  (proves F7).
- **Bookmark-only main**: the no-chapter sentence; a bookmark line with
  "bookmark", age and id; the worktree named; its text and id absent.
- **Main alone**: self sentence first; own-chapter line; the other-lanes
  sentence absent (assert on the count phrase, not a name).
- **Scoped search**: main's hit ids are a subset of the rows whose
  `session_key` the registry places in main (SQL join), include its
  chapter and a captured turn, exclude every worktree row; `scope`
  names `main` and the widen; the worktree symmetric; `scope: "all"`
  returns both chapters with no `scope` key; conversation windows of
  main's hits contain no worktree row.
- **Helpers' reports and imports**: the tester through `hooksSubagent`
  and the real SubagentStop with 40 PostToolUse rows; the worker through
  the real ticket door (`runWorker` + standin-worker, 30 tool rows via
  `viaTools`, a summary at exit); the import through the import tool from
  main's placed client; the subproject's tester under the worktree's
  session. Main's default hits include the three reports by id and none
  of the 70 tool rows; `scope: "all"` reaches a tool row and the
  subproject tester's report.
- **Earlier release's worktree conversation**: staged as the earlier
  release staged it (no writer), drained, registry holding the worktree
  session; the worktree's default search finds the turns, main's does
  not, `scope: "all"` does; `SELECT content, metadata_json` before and
  after are byte-equal.
- **Flood**: 200 `hooksSubagent` starts and stops each with a report
  containing "next"; restart main under a new id; status own list is
  [chapter], `other_lanes` 0; packet's own line is the chapter and no
  report text appears; the orientation query's first hit is the chapter
  and at least one report is among the hits below it.
- **Snapshot lane**: two `preCompact` firings (main earlier, worktree
  later), rows in `snapshots`; main's startup packet names main's
  snapshot id and not the worktree's; the worktree's row still
  `claimed_by IS NULL`; drain; the recovery row's `session_key` is main's
  new session and the registry places it in main; each entry it quotes
  is a main-lane row; the worktree's later start claims its own, and its
  recovery row's session is the worktree's.
- **Writer unknown, every lane**: the chapter through a client with no
  resolvable session (`_writer_src` `unregistered` by SQL); main's own
  list excludes it; main's block and packet name "writer unknown" with
  count 1; the worktree's status and packet likewise and never in its own
  list; `scope: "all"` shows it labeled with its metadata.
- **Unplaced supersession**: two chapters from the unplaced client, the
  second with `supersedes` the first; `scope: "all"` lists one live
  pointer labeled "writer unknown", the first's `superseded_by` set by
  SQL; main's chapter untouched.
- **Pre-registry rows**: the unstamped chapter in main's own list and
  among main's default hits; the worktree's block counts it under `main`.
- **Narrowed negatives (v1 F9)**: orchestration.steps.ts:478-479 and
  handoff.steps.ts:514-515 additionally assert the row is not named in
  the scope block and not listed under `scope: "all"`.
- **Hollow traps**: asserting on raw `metadata._writer` of a flat list;
  running status or query from an unplaced session (assert the block
  names the lane); writing a worktree chapter by raw SQL with a hand
  stamp; registering lanes by inserting registry rows directly instead
  of firing the hook; a flood binding whose reports do not match the
  query's words (then "below it" proves nothing).

## 7. Re-review findings → v3

| Finding | v3 |
|---|---|
| F1 blocker: scope by writer hides D147/D263/D151 | D374 scopes by the registry's sessions plus helpers' reports (parent link) and the lane's imports; never a helper's trail (R8); scenario "finds its helpers' reports and its imports"; D147/D263/D151 bindings keep finding, asserting the block. |
| F2a blocker: D376 restated a stale D235 | D376 now amends D243 (the lane key), restated in full; D235 and D240 are touched, not restated. |
| F2b blocker: D374 overturned D240 | Kept: `concurrent`/`ambiguous` search the whole store as D240 rules; status's self scoping for them disclosed in D372. |
| F3 blocker: recovery row has no lane | D375: the row is written in the claiming session and so in its lane; scenario Then and SQL binding on `session_key`. |
| F4 drain stamp breaks `newestMainEvent` | Dropped: nothing stamped at the drain (R10); recorded as a road not taken in D376. |
| F5 stamp-on-open unnecessary | Dropped: lane read from the registry at query time; the "earlier release" scenario replaced with the read-only form and "unchanged byte for byte". |
| F6 unplaced writers lose supersession | D376: undetermined writers are one lane for supersession; scenario "an unplaced writer's chapters still supersede one another". |
| F7 self lines inside the budget | D373: outside the budget, each bounded; resume binding proves it. |
| F8 no unknown-writer case from a worktree | The unknown-writer scenario covers main and the worktree's status and packet. |
| F9 DESIGN.md | Amendment paragraph in the D371 form, cited `[ruled: D372–D377]`; lint shows no `not-in-design`. |
| F10 lint: touches-later, unspread | D376 removed from earlier `touches`; `spread:` on D372 and D373 with one outline tagged `@D372 @D373`; `{20}` replaced by "the cap D166 sets"; lint clean but for `inferred`/`rewrite`. |
| F11 restatements drop text | D373 restores D236's means clause; D375 restores "what the drain writes … is in the charter" and D286's sib reason. |
| F12 owner's R6 words absent | Quoted in D372's comment. |
| F13 "no stamp" over-asserts | "written before the store recorded writers or by a program writing through the library without one". |
| F14 optional count of hits left out | Dropped. |
| F15 card swap breaks the drift test | Withdrawn; card unchanged. |
| F16 binding notes | Real seats named (`sessionStart` local runner, `hooksSubagent`, `runWorker`, `mcpOver`); `preCompact` to be added to standins.ts; outline uses 0/1/3/5 lanes; the negatives' extension reworded; the no-scope-block bindings listed for revisiting. |
| F17 stranded pre-registry snapshots | Disclosed in D375's resp and comment ("claimed by no one and stays in its table"). |
| Q1 helpers' output in main's search | R8: yes, reports and imports, never trails. |
| Q2 schedule | R9: beta.3 waits; D377 [V]. |
| v2 open 1 (own line at every start) | Resolved as the re-review did: every start. |
| v2 open 2 (stamp on open) | Resolved: neither stamp nor backfill (R10). |

## 8. Build triage (R11: the aBDD pathway)

Units, in dependency order. Every unit records its binding count per
scenario (bound / hollow / narrowed / unlit) in its own audit note; every
unit gets a failure-ladder review by Opus before merge; a Fable gate runs
last over the whole slice with the dogfood on the desktop (R9).

| Unit | Files | Binds | Builder | Reviewer + mutation probes |
|---|---|---|---|---|
| **U1 the lane read** (foundation) | `src/references.ts` (`laneWriterOf`: `_writer_src` `unregistered` → an UNKNOWN lane constant, distinct from AMBIGUOUS); `src/persistence/session-registry.ts` (new read: the sessions a self owns, with helpers by `agent_id` rows and `parent_session` from `leg-registry.ts`); `src/flat-store.ts` (`laneScopeSql` grows a session-based form: `session_key IN (lane's sessions)` minus helper trails — rows with `_writer_agent_id` whose kind is not the summary — plus helpers' summary rows by parent, plus rows with `_handoff_importer` in the lane or, for main, unplaced, plus for main rows whose session the registry never held, minus `_writer_src` `unregistered`; `splitSupersedes` and the bookmark chain treat UNKNOWN as a lane of its own, not AMBIGUOUS); unit tests in `tests/session-registry.test.ts` | @D376 ×3; @D374 "earlier release's conversation"; the lane half of @D374 "helpers' reports" | **Opus** (set logic, four sources of membership, one subtraction) | Opus. Probes: (1) drop the helper-trail subtraction → "never a helper's trail" must fail; (2) drop the parent-link membership → the worker's return must vanish from main's hits; (3) map UNKNOWN to AMBIGUOUS → the supersession scenario must fail; (4) map `unregistered` to main → the unknown-writer scenario must fail; (5) include `unregistered` rows in main's search scope → "never a row of an undetermined writer" must fail; (6) replace the registry join with `_writer` → the earlier-release scenario must fail |
| **U2 status and the packet** | `src/server/server.ts` (status: scope for a placed main too; the block's `other_lanes` count, `lanes` list capped at 3 with kind/age/count, "writer unknown" as a lane, the unplaced note; `scope: "all"` pointers naming their lane); `src/flat-store.ts` (`status({ lane })` returns the per-lane summary); `src/checkpoints.ts` (`worktreeSelfLines` → `selfLines` for both selves: own chapter, bookmark-only line, brief for `main`, the other-lanes line); `src/hooks/session-start.ts` (prepend for main; outside the budget) | @D372 ×3 + outline; @D373 ×3; the @D167 Then rebound; the status/packet half of @D376 unknown-writer; the v1-F9 negative extensions; R8a status/packet Thens | **Opus** (two surfaces that must agree; the cap and ordering) | Opus. Probes: (1) remove the self sentence → the D167 Then must fail (vacuity check); (2) put the worktree chapter's first line into the lane entry → "none of its text" must fail; (3) raise the name cap to 5 → the outline's 5-lane row must fail; (4) sort lanes oldest first → the outline's "newest first" must fail; (5) count the self lines inside the resume budget → the resume binding must fail; (6) list unknown-writer pointers in main's own list → must fail. The Thens with "none of its text or id" are negative: the reviewer checks each has a positive twin in the same binding |
| **U3 the search scope** (after U1) | `src/server/server.ts` (query: default lane scope for a placed own-agent caller using U1's read; the block `{ lane, searched, widen }`; the unplaced note; D240's branch untouched); `src/flat-store.ts` (windows under the session scope); revisit orchestration.steps.ts:426, :624 and session-registry.test.ts:199, :271, :275 | @D374 ×4 (scoped search; helpers' reports; flood's search Then); D147/D263/D151 re-asserted with the block | **Opus** (ranking interplay; the flood Then) | Opus. Probes: (1) scope hits but not windows → the windows assert must fail; (2) scope `concurrent` callers to the lane → session-registry.test.ts:199 must fail (D240 guard); (3) drop the block on `scope: "all"` incorrectly present → D150's `all['scope']` undefined must fail; (4) flood: weight assistant rows at 1.0 → "places the chapter above every report" must fail |
| **U4 the snapshot's lane** (parallel with U2; needs U1's lane predicate for the drain's queries) | `src/hooks/shared.ts` (`claimSnapshot` takes the claimant's self and claims only a snapshot whose session the registry places in the same self; unplaced sessions never claimed); `src/server/ingestion.ts` (the recovery row inserted with `session_id` the claiming session and queries under the lane scope); `tests/journal/standins.ts` (`preCompact`) | @D375 | **Sonnet** (mechanical, well-specified) — with the verification rule: direct SQLite inspection of the row | Opus. Probes: (1) drop the self filter → main's packet names the worktree's snapshot; (2) drop `session_id` on the insert → "the worktree's own, never the main lane's" must fail; (3) run the queries unscoped → "quotes the main lane only" must fail |
| **U5 handshake and docs** (after U2/U3 wording settles) | `src/server/instructions.ts` (skill body bullet only; card untouched; drift test green); README (status/search scope, lanes, "writer unknown"); CHANGELOG; the charter edits of §1–§3 applied by the coordinator (owner-review territory) | journal-agent-surface stays green (D264 scenario unchanged) | **Sonnet** | Opus, light: the card's byte-length and the drift test; the README says nothing the scenarios do not bind |
| **U6 gate** | dogfood on the desktop and the laptop under R9; per-unit binding counts collated; the audit note | all of the above | **Fable** (the gate, per the staffing memory) | — |

Dependencies and parallelism: U1 first (one or two days of Opus). U2 and
U4 start in parallel with U1 against its two interfaces (the UNKNOWN lane
constant; the session-scope predicate), merging after U1 lands. U3 after
U1. U5 after U2 and U3. U6 last. The charter edits (§1–§3) go in before
U1 so every unit binds against ratified-pending text; the owner's [V]
ratifying entry closes the lint's `inferred`/`rewrite` findings.

Fable is proposed for no builder: the hard binding judgments here are
negative Thens ("none of its text or id", "never a helper's trail") and
the vacuity-removing D167 binding, which the Opus reviewers check with
the mutation probes above; if U2's binding count shows a hollow class
repeating, move its step definitions to Fable per the binding-honesty
memory.
