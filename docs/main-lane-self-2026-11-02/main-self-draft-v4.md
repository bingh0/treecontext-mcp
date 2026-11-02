# Draft v4 (final wording): the main checkout's half of D167, D372–D377

Repo read-only; nothing touched; no journal writes. Line refs are
`beta.3/node-sqlite` at add7004. Everything in §1–§4 is paste-ready and
was applied to a fresh scratch copy of `features/` at
`/tmp/claude-1000/-home-<user>-Documents-treecontext-mcp/bd91acc7-8f45-4fe0-ba79-b27f76ef86c1/scratchpad/lint4/features`
(the edited files there are the exact post-edit text).

**Lint delta** (`docketry lint features/DOCKET.md --corpus features --json`):
45 findings before, 59 after; the 14 new are `inferred` ×9 (D372, D373,
D374, D376 trig+resp, D377 resp: provenance under [I], cleared by the
owner's ratifying entry) and `rewrite` ×5 (an [I] amending a ratified
chain; precedent D357). Nothing else: no `touches-later`, `unspread`,
`spread-no-outline`, `uncited-trigger`, `bare-digit-run`, `not-in-design`,
`not-in-fence`, `trigger-with-resolution`.

## v3-review claims verified against the repo

| Claim | Checked |
|---|---|
| the export trail reads the writer stamp (`writerTrail`, flat-store.ts:2546-2556) | true: `_writer = ?` or `_writer_agent_id = ?` or (`_writer IS NULL AND agent_type = ?`) |
| `pruneHighDfTokens` drops a term in more than half the corpus once the store holds `DF_PRUNE_MIN_DOCS` rows (flat-store.ts:1749-1767) | true; falls back only when every survivor has df 0 |
| a ticket-door worker is stamped `declared` (session-registry.ts:373-385) | true |
| `parent_session` can be NULL (`t.parent.id === ''`, leg-registry.ts:518) and `parent_src` `declared` when the parent is unregistered | true |
| a moved worktree registers under `<name>@<hex>` (`worktreeLaneName`, session-registry.ts:169-179) | true: a new top level whose directory name another top level holds |
| `internal-summary` rows carry `_writer_agent_id` (ingestion.ts:639-642) | true |
| the Fable limit runs to Thursday 2026-11-06 (memory) | true; R13 defers the gate |

## Position (unchanged from v3, with R12 and R13)

Symmetry read from the registry, nothing stamped, no backfill. Every
placed session is scoped to its own lane at status, packet and search;
a lane's search is the sessions that ran in its checkout plus its
helpers' reports by the parent link plus its imports, never a helper's
trail; the export trail reads the lane the same way (v3 F1). The search
promise after a restart is "found, never contradicted" (R12); the panel
and the packet carry the lead. A worker of the ticket door searches as
its harness feeds it, whole store (D237's "every other caller" restored).
"Writer unknown" is its own supersession lane; unstamped rows stay
main's. The Fable gate is deferred (R13); everything else proceeds,
dogfood on the desktop included.

## 1. Docket entries — final text, append to features/DOCKET.md after D371

```

D372 2026-11-02 [I] amends D242
  trig:  a session calls status, registered in the main checkout, in a linked worktree, a worker of the ticket door, or one the server cannot place [I]
  resp:  a session registered in a linked worktree calls status and sees the live pointers of that worktree's own lane, with a `scope` block naming the lane, the count of other lanes' live pointers left out and how to widen; a session registered in the main checkout sees the same, scoped to the main lane, under the same block; in either case the block also says how many other lanes hold live pointers and names at most {3} of them, the most recently active first, each with the kind and age of its newest live pointer and the count of its live pointers, never its text or id, the lane of pointers whose writer could not be identified named "writer unknown" among them and never any lane's own; the own list keeps the cap D166 sets, with the total stated; `scope: "all"` lists every lane's pointers flat as before, each pointer naming its lane, with no block; a worker of the ticket door sees every lane flat, the block naming it a worker; a session the server cannot place sees every lane flat, the block saying it could not be placed; a session whose caller cannot be told apart from a live subagent is scoped to its self as before, since status has no caller but the session [I]
  sib:   none -- a main checkout orienting on a worktree's chapter because it was newest in a flat list is the confusion D167 removes, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D242 D167 D190 D243 D169 D166 D158 D240 D288
# the owner's incident, 2026-11-02, on another machine's store: two Claude Code sessions on one store and one repo, A in the main checkout (documentation), B in a linked worktree (a new subproject); A quit and restarted while B wrote a chapter summary; the restarted A oriented on B's chapter as its own thread and recovered only by replaying its own transcript. D242 scoped the worktree's status and left main's flat, every lane newest first, the writer inside raw metadata only: the road the fence declines, "re-orienting from the project's newest chapter regardless of who wrote it" (D167), live in the build for the main checkout since D242. A first draft kept main unscoped and labelled; the owner reversed it: "fundamentally, i do not see a difference between "main" and a worktree - they are all reflections and separate spaces within the store. So labeling each writer, including main, would make searching/filtering very easy, yes? A) be aware of other lanes or namespaces or checkouts … when main starts, but no need to auto fill - would get messy if there are a 1000 worktrees." The lane names stay the filesystem's: "my idea of labeling by branch won't work then. i think the worktree: nomenclature will ahve to do since it's the file system truth." On the worktree half carrying full scenarios: "D) I believe that git worktrees are fairly fundamental unit for subagents and should be fully described in feature file scenarios." Residual, disclosed: two sessions in one main checkout share one self by D167 [V], so a peer main session's chapter is this session's own thread by ruling, not a defect. Roads not taken: main unscoped with its own pointers labelled and the other lanes' chapters listed apart (the first draft; the orchestrator's convenience bought with the peer's confusion, and content auto-filled against the owner's A); a flat list labelled by writer in each preview (order still says "newest is yours"); naming other lanes without a cap (a thousand worktrees); asking the main session at start whether it orchestrates (an interactive gate, and the answer changes mid-session)

D373 2026-11-02 [I] amends D236
  trig:  a session starts in a linked worktree or in the main checkout other than by a /clear, at a startup, a resume or after a compaction alike [I]
  resp:  a session starting in a linked worktree opens its packet with that worktree's own thread: the newest live chapter summary whose `_writer` is `worktree:<name>`, from any session that ran there, labeled as the worktree's own with its age and referrers; and the brief addressed to it, the newest entry whose metadata `brief_for` names the worktree, with its writer and age; a session starting in the main checkout opens its packet the same way: a line saying it runs in the main checkout and re-orients on the main lane's own thread, the main lane's newest live chapter summary labeled as its own with its age, id and referrers, and the brief addressed to `main` when one exists; either lane with no chapter summary of its own but a live bookmark is handed that bookmark named as a bookmark with its age and id, and says no chapter summary exists; a lane with neither says it starts fresh; the brief is the means of "the orchestrator injected the brief at its start": an entry the orchestrator writes through the insert tool before the worktree's first session; the packet then says how many other lanes hold live pointers and names at most {3}, the most recently active first, each with the kind and age of its newest live pointer, and where to look, status with `scope: "all"` and export by writer, never another lane's text or id, and nothing when no other lane holds one; the self lines stay outside the start's budget, each bounded: the chapter by its first line, the other lanes by the count and the names; the /clear packet is unchanged [I]
  sib:   none -- a packet that hands a session another lane's chapter, labelled or not, is the anchoring this prevents, not a behaviour
  spread: the other lanes are counted and at most three named with <lanes> other lanes
  serves: N23 N24 N20 N5
  touches: D236 D167 D372 D160 D162 D190
# the incident of D372. D236 had left the main checkout's fresh start unchanged "because no scenario binds it and the status panel already serves it"; the panel did not, and the D167 Then "the packet handed to a session starting in the main checkout at the same time does not carry it" was bound against a packet that carried no self line by construction, vacuously green; the Then keeps its words and binds against a packet that opens with main's own line, and the restarted-main scenario walks the incident end to end, status, packet and search agreeing. The owner on content: "be aware of other lanes … but no need to auto fill - would get messy if there are a 1000 worktrees." Main's own line at every start, not only beside another lane, follows the owner's symmetry ("i do not see a difference") and "main should get main"; D236's premise, the panel serving it, is the one that failed; the cost is what a worktree already pays, and bounded. The bookmark line is D160's bookmark-only path carried to the fresh start, since a documentation session nobody checkpointed leaves a bookmark and nothing else. The self lines stay outside the budget because a resume's budget is {500} characters and the worktree's own anchor would be cut by its own line. Roads not taken: the other lanes' newest chapters in the packet, labelled as theirs (the first draft; anchoring on text in front of the model is the hazard, label or none); main's self line only beside another lane (D162's economy, declined for symmetry); one line per other lane with no cap; the self lines inside the budget

D374 2026-11-02 [I] amends D237
  trig:  a session searches without asking for the whole store: the session's own agent in the main checkout or a linked worktree, a subagent, a worker of the ticket door, or a caller the server cannot place [I]
  resp:  a search by a caller the registry resolves to the session's one live subagent defaults to that subagent's scope: rows the store stamped with its role as writer, the live resume pointers of the lane that spawned it, the session's self, the entries whose `brief_for` names its role, and the entries those pointers and briefs reference, one hop; a search by the session's own agent, in the main checkout or in a linked worktree, defaults to its own lane, read from the registry at the moment of the search as D376 rules: the rows of every session the registry places in that checkout, the session's own agent's rows, the client's own internal summaries and each helper's report alike, a subagent's summary row or a worker's, the worker's by the parent link of its registration, never a helper's trail, its tool calls and turns staying in its own lane; the entries imported by a session of that lane, or by none the registry places, which land in the main lane; for the main lane also the rows of sessions the registry never held; never a row of an undetermined writer; and the entries its live pointers and briefs reference, one hop; a worker whose parent the registry places in no checkout reports into no lane's default search, its return reached by the key lookup or by asking for the whole store; a caller that cannot be told apart from a live subagent, `concurrent` or `ambiguous`, searches the whole store as D240 rules, the reply saying why; a worker of the ticket door searches the whole store as before, its harness feeding it by brief and key lookup, the reply saying so; a caller the server cannot place searches the whole store, the reply saying so; every other caller searches as before; the scope is applied in the store before the result count and to every hit's conversation window; the reply names the lane searched and how to widen, and `scope: "all"` searches the whole store with no scope block; no new parameter is added; after a restart the lane's own chapter is among the orientation search's results and no result is presented as the session's own thread but its own lane's, the first place not promised, the status panel and the packet carrying the lead; a writer's whole trail is read by `treecontext_export` with `writer`, a role or one subagent's agent id, `main` or `worktree:<name>`, oldest first, by the same lane reading [I]
  sib:   none -- an orientation query answered by another lane's newest chapter is the confusion D167 removes at the handshake's second step, not a behaviour
  serves: N20 N21 N23 N24
  touches: D237 D167 D264 D150 D240 D147 D263 D151 D186 D336 D288
# the handshake's second step, "what was I working on, what was the next step", runs store-wide with recency fusion at {0.25} (D264, D273), so in the incident of D372 the worktree's newer chapter is the likeliest top hit after the panel is fixed; the review of the first draft found the step unlit. The owner: "what i was working on depends on what lane/namespace we are in. main should get main, worktree gets it's own worktree, subagent gets whatever the supervising agent or harness feeds it." A second draft scoped by writer stamp and would have hidden what D147 [V] promises the orchestrator (its subagents' reports), D263's internal summaries and D151's imports; the second review found it, and the owner, asked whether main's default search should still find what its helpers produced: "q1 - what about scenarios like flooding - there are dozens or hundreds of subagents or work trees - how do we manage that?", answered by the lane read from the registry (D376) and the flood scenario: one row per helper, ranked and previewed, never a resume pointer. On whether the lane's own chapter must rank first after a restart, the owner took the recommendation "found, never contradicted": "ok on #1 rec."; a rank-first promise would need a chapter-lifting rule and can fail when common words are discounted past {256} rows, which the status panel and the packet do not depend on. D240's whole-store rule for a caller that cannot be told apart stands, since a guess must not act as a lane's own (D235's comment); status still scopes such a session to its self, disclosed in D372. A worker of the ticket door is fed by its brief and the key lookup (D336), not by a scope, so it searches as before. D264's "no new query parameter" holds: `scope: "all"` existed. Roads not taken: the search left store-wide with a label on each other-lane hit (a label in front of the model is what failed in the incident, and the owner ruled scope); a parameter for orientation (D264 declined it); scoping the search and not the window (the window would leak the other lane around every hit); the scope by writer stamp (hides the helpers' reports); a worker scoped to its parent's lane (its harness feeds it); a rank-first promise for the orientation search

D375 2026-11-02 [I] amends D286
  trig:  a session starts after a compaction and the drain runs the recovery queries the pre-compact snapshot recorded; a fresh session starts while an unclaimed recovery snapshot exists; or a store an earlier release left with recovery snapshot rows is opened [I]
  resp:  the recovery snapshot row is machine output quoting the journal, bounded like a tool event: it quotes each hit at the hit's display view and no further than the quote cap, names the entry it quotes, never quotes another recovery snapshot, keeps the recovery queries in its metadata and out of its indexed words, and carries its own display and index boundaries, so a hit on it is a bounded preview with the availability marker and its reach into the index is the tool default; on first open this build stamps the same boundaries on every recovery snapshot row a store already holds, content untouched; a fresh session claims a recovery snapshot only when the session that left it had the same self, the main checkout's for a main session and the same worktree's for a worktree session, newest first; a snapshot left by another lane is left for that lane; a snapshot whose session the registry does not hold is claimed by no one and stays in its table; the recovery queries the drain runs for a claimed snapshot are scoped to that lane as a search by the claiming session would be, and the recovery row is written in the claiming session and so in its lane, never in no session; the pre-compact snapshot itself and the compaction interaction stay with ccr, but what the drain writes to the store is in the charter from here [I]
  sib:   none -- a row the store writes about itself growing without a boundary, or a session answering another lane's recovery queries into its own, is what this prevents, not a behaviour
  serves: N1 N4 N23 N5
  touches: D286 D35 D167 D372 D374
# found by the review of the first draft, 2026-11-02: on a startup the session-start hook claims the newest unclaimed snapshot of any other session, with no lane, worktree or directory test, writes its queries into the packet and stages a row the drain answers store-wide; only a startup claims, so a worktree's compaction leaves a snapshot the main checkout's next start takes. Whether it fired in the owner's incident cannot be known (another machine's store); it would produce exactly that incident. The owner, asked whether a main session should ever adopt a worktree's recovery note: "C) I don't think so." The second review found the drain's own write: the recovery row carried no session and no writer, so even a worktree's own recovery row read as the main lane's, the D286 specimen again. D286 kept "the session-start claim" with ccr; the claim writes to the packet and makes the drain write, and a fence may decline a promise, never a writer, so the claim's lane test and the row's session are in the charter from here. A snapshot left before the store recorded sessions is not claimed; it stays in its table, disclosed rather than claimed for main. Roads not taken: retiring the claim (it is the only automatic recovery after a compaction that was not a /clear); the claim unfiltered and disclosed in the packet (the disclosure arrives after the queries are already staged)

D376 2026-11-02 [I] amends D243
  trig:  the store reads a row's lane: to list or retire a pointer, to scope a lane's default search, to read a writer's trail, or to label a row [I]
  resp:  a detached HEAD registers no branch; a linked worktree whose directory name another registered top level already holds registers as `<name>@<six hex of its top level's path>`, a top level keeping the name it first registered under; a subagent type spelled `main`, or starting `worktree:` or `agent:`, is stamped under the prefix `agent:`; a pointer's lane is its writer stamp: `main` and a row carrying no stamp at all, written before the store recorded writers or by a program writing through the library without one, are one main lane, a role is its subagent's, and a row stamped `unregistered`, written while the store recorded writers by a caller it could not place, is the lane of undetermined writers, shown as "writer unknown", never folded into main and never any lane's own, its other metadata left for the reader; rows of undetermined writers are one lane for supersession: an unplaced writer's chapter or bookmark retires the earlier ones of that lane as before, never a placed lane's, and a placed lane's writer never retires one of them, recording it as a reference; a lane's default search scope is read from the registry at the moment of the read and never written onto a row: the sessions the registry places in that checkout, the main checkout's or the worktree's, with each helper's report by the parent link of its registration, as D374 lists them; a writer's trail by `main` or `worktree:<name>` is that lane's own rows as the lane is read from the registry, the session's own agent's rows of every session placed in that checkout, and for `main` the older rows naming no writer whose session the registry never held; by a role, its stamped rows and the older rows claiming it as `agent_type` with no stamp; a trail longer than the export's cap returns the newest within it, oldest first, stating `omitted`; a row stamped `ambiguous` is never a worktree's own chapter; the writer trail bypasses the summaries default of the handoff export; nothing is stamped at the drain beyond what is stamped today, and no row already stored is rewritten for its lane [I]
  sib:   none -- a worktree's own conversation read as the main lane's, or a stranger's chapter vouched for as main's own, is the mislabelling this prevents, not a behaviour
  serves: N5 N20 N21 N23
  touches: D243 D235 D228 D240 D190 D167 D169 D166 D372 D374
# the review of the first draft, 2026-11-02: a row stamped `unregistered` names no writer, so the lane key read it as main's and the first draft would have labelled a stranger's chapter "the main checkout's own". The owner: "E) honesty first - if writer is uknown, indicate as such. agent can explore other metadata to figure out what it is. could be a human injected instruction which is fine", and to the nuance that rows from before the store recorded writers were the main session's (no worktrees then) and stay main's as D243 reads them: "a) agree with your more nuanced explanation about unknown writers." The second review found that "no lane's own" read as the ambiguous lane, which retires nothing, would stop supersession for every client without hooks and grow its panel without bound against D166; the undetermined writers are therefore one lane for supersession, labelled and apart. The lane read at query time is the second review's design, adopted by the owner: the drain stamps no writer on a session's own captured rows today, so a worktree's turns and tool output read as the main lane by the lane key; a stamp at the drain would have broken the concurrent-caller evidence that reads those rows unstamped (D240), and a stamp on open would have rewritten rows in place from the registry's last registration, a later reading spelled like a live stamp; the registry already maps each session to its checkout and each helper to its parent, a fact of record read where it is used, covering old and new rows alike. The third review found the export trail still reading the stamp, so a worktree's trail missed its own conversation; the trail now reads the lane the same way. Residuals, disclosed: a session id started again in another checkout re-registers there, and its earlier rows follow it; a worktree moved on disk has a new top level and registers under a new name, so its lane splits, the restarted session starting fresh and the old lane counted among the others; a removed worktree's lane keeps its live pointers and stays counted until someone retires them; two unplaced writers are one lane for supersession and can retire each other's pointers, kept on purpose so an unplaced client's panel stays bounded (D166), though D169 reads "a lane's own writer"; an ambiguous beacon makes the caller unplaced, consistent with the whole-store search. Roads not taken: stamping the self on captured rows at the drain (D240's evidence, and a new writer source to name); a stamp on first open (an edit in place that changes which lane owns rows, on a later reading); folding unplaced rows into main with a note (the incident, vouched for); refusing an unplaced write (capture is never filtered, D3)

D377 2026-11-02 [I]
  resp:  the lane-scoped search of D374 ships in `0.1.0-beta.3`, the release waiting for it, dogfooded on the owner's machines first; the build follows the aBDD pathway though this slice was not formally scoped: failure-ladder reviews, model triage for builders by difficulty, per-unit binding counts recorded, and a Fable gate that runs after the build and the dogfood, when Fable tokens are available, else on `2026-11-06` [I]
  ->     boundary
  serves: N23 N24 N31
  touches: D374 D372 D373 D375 D376 D370
# the owner, 2026-11-02, after the second review: "q2 - i would prefer to hold up beta.3 to include the full filtering. we can dogfood it here." and "go ahead with v3, make sure we follow the aBDD pathway even though this wasn't formally scoped - failure ladder reviews, efficient subagent model triage, etc."; after the third review, on the search promise and the gate: "ok on #1 rec. let's do everything other than fable gate including dogfooding and we can see what the fable situation looks like when you are done - if there's available tokens we can do it, otherwise it waits until thursday." The resp is the drafter's reading of those words, so the tag is [I] until the owner reads it; the ratifying entry for D372 to D376 can ratify this one with them. Road not taken: the status panel, packet, snapshot rule and unknown writer in beta.3 with the search scope in beta.3.1 (the second review's option; leaves the handshake's second step able to surface a worktree's newer plan)
```

## 2. Scenarios — final text with target and insertion point

**features/journal-orchestration.feature, line 66** — the `@D167` Then
keeps its words, unchanged:
`    And the packet handed to a session starting in the main checkout at the same time does not carry it`

**features/journal-orchestration.feature, insert after line 75** (after
the `@D167` scenario "a new worktree is treated as a new subagent
process", before `@D190`):

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
    And the status it calls lists the main checkout's chapter as its own and not the worktree's
    And its search "what was I working on, what was the next step" finds the main checkout's chapter and none of the worktree's
    # The owner's incident, 2026-11-02, walked end to end: the main
    # session stopped, a worktree wrote the newer chapter, the main
    # session restarted; the packet, the panel and the search agree.

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
    And a worker spawned by a harness with no session, whose return reads "the orphan's table is written"
    When the main checkout's session searches without asking for the whole store
    Then it finds the tester's report, the worker's return and the imported plan by their words
    And it finds none of the tester's or the worker's tool calls until it asks for the whole store
    And it finds the subproject's tester's report only when it asks for the whole store
    And it finds the orphan worker's return only when it asks for the whole store, the key lookup reaching it as before

  @D374
  Scenario: a worktree's conversation from an earlier release is the worktree's own
    Given a store in which an earlier treecontext captured a worktree "subproject" session's turns with no writer
    When the session in the worktree "subproject" searches those turns' words
    Then it finds them as its own, and the main checkout's session finds them only when it asks for the whole store
    And an export of the worktree's trail carries those turns, and the main checkout's trail does not
    And the store's rows are unchanged byte for byte

  @D374
  Scenario: two hundred helpers do not displace the main checkout's own thread
    Given a main checkout session holding the chapter summary "plan: rewrite the README's install section; next: the doctor table"
    And 200 subagents that session spawned, each leaving a report that mentions its next step
    When the main checkout stops and a new session starts in it
    Then the status lists the chapter as the main lane's only live pointer and counts no other lane
    And the packet carries the chapter as the main checkout's own and no report
    And the orientation search finds the chapter, and no report it finds is offered as the main checkout's own thread
    # R8a: found, never contradicted. The panel and the packet carry the
    # lead; the search's rank is observed and recorded, not promised,
    # since common words are discounted once the store passes 256 rows.

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

**features/journal-workers.feature, append at the end of the file**
(the ticket-door world lives in its steps):

```

  @D374 @D372
  Scenario: a worker of the ticket door searches the whole store and sees every lane
    Given a spawner in the main checkout holding its live chapter summary, and a worktree "subproject" holding its own
    And a worker the spawner launched through the ticket door with its brief and key
    When the worker searches through its tools and calls status
    Then its search covers the whole store, the reply saying a worker searches as its harness feeds it
    And its status lists both chapters flat, the block naming it a worker, never calling it unplaced
```

## 3. Header, fence and DESIGN.md — final text

**features/journal-orchestration.feature header.** Replace the sentence
"Self is recovered from where a session runs, not from its process, so a
stopped worktree resumes its own thread." with:

```
  Self is recovered from where a session runs, not from its process, so a
  stopped worktree, or the main checkout beside one, resumes its own
  thread; the main checkout is a lane like any worktree, and a lane is
  read from where its sessions ran, never stamped after the fact.
```

Replace the rulings paragraph's last sentence block with:

```
  Rulings D147, D148, D150, D167, D169, D186, D190 of the hackathon
  interview, 2026-10-05 to 2026-10-07; D263 of 2026-10-10; D372 to D377
  of 2026-11-02 (the main checkout's own lane: status, the fresh start,
  the search scope read from the registry, the recovery snapshot's lane,
  the unknown writer, the beta.3 schedule). Group orientation (D168) is
  deferred with groups configuration (D209) and carries no scenario yet.
```

**features/journal-workers.feature header**: append to its rulings line
"D372 and D374 of 2026-11-02 (a worker's status and search)".

**features/OUT-OF-SCOPE.md**, three edits (applied in the scratch copy):

(a) In the compaction lifecycle entry, after "…the compaction interaction
itself stays with ccr, the one declined promise this entry still
fences." append:
```
 Amended 2026-11-02 (D375):
  the session-start claim is in the charter, a fresh session claiming a
  recovery snapshot only from its own lane and the recovery row written
  in the claiming session; the pre-compact snapshot and the compaction
  interaction stay with ccr.
```

(b) Immediately before "- Declined alternative, Re-orienting from the
project's newest chapter regardless of who" (~line 356):
```
- Declined alternative, The main checkout's status unscoped, its own pointers labelled and
  other lanes' chapters listed beside them — the main checkout is a lane
  like any worktree: scoped to its own by default, aware of the others by
  count and name, widened on request. (D372, 2026-11-02)
- Declined alternative, Other lanes' chapter text in a fresh start's packet or status —
  awareness is a count, at most three lane names and where to look;
  content is fetched deliberately. (D373, 2026-11-02)
- Declined alternative, An orientation search left store-wide with a label on each other
  lane's hit, scoped by writer stamp, or promised to rank the lane's own
  chapter first — the search is scoped to the session's own lane, read
  from the registry; the chapter is found and never contradicted;
  `scope: "all"` widens. (D374, 2026-11-02)
```

(c) Immediately before "- Lane model: cross-lane supersession that
retires the target; a" (~line 438):
```
- Main checkout fresh start: its own line only beside another lane; the
  other lanes' chapters in the packet. (D373, 2026-11-02)
- Lane derivation: a self stamped on captured rows at the drain; a stamp
  on first open rewriting stored rows. (D376, 2026-11-02)
```

**features/DESIGN.md**, after the D371 amendment paragraph (ends
"[ruled:\n  D371]" at ~:447), in the same form:
```
  Amended 2026-11-02: the main checkout is a lane like any worktree.
  Status is scoped to the session's own lane for both, the block
  counting other lanes and naming at most three with kind and age, never
  text; a main checkout's fresh start opens on the main lane's own
  chapter (or bookmark) the way a worktree's does, the other lanes
  counted and named, outside the budget. The default search is the
  session's own lane, read from the registry at the search: the sessions
  that ran in that checkout, each helper's report by its parent link,
  the lane's imports, never a helper's trail; the export trail reads the
  lane the same way; a caller that cannot be told apart still searches
  the whole store (D240), and a worker of the ticket door searches as
  its harness feeds it. After a restart the lane's own chapter is found
  by the orientation search and never contradicted; first place is not
  promised. A recovery snapshot is claimed only from the own lane and its
  row written in the claiming session. A row stamped `unregistered` is
  "writer unknown", its own lane for supersession, never main's; a row
  with no stamp at all stays main's. Nothing new is stamped and nothing
  stored is rewritten. [ruled: D372, D373, D374, D375, D376, D377]
```

## 4. src/server/instructions.ts — final text

**Card (`INSTRUCTIONS_BRIEF_LEXICAL`): unchanged.** (1979 characters;
pinned by tests/server/instructions-drift.test.ts.)

**`SKILL_REFERENCE_BODY`**, "Subagents, worktrees and writers": replace
the three lines
```
  '- In a git worktree, treecontext_status lists that worktree\'s own',
  '  pointers (scope: "all" for every lane), and a fresh start is handed',
  '  the worktree\'s own newest chapter.',
```
with
```
  '- Every session is a lane: "main" in the main checkout,',
  '  "worktree:<name>" in a git worktree, a role for a subagent. In the',
  '  main checkout or a worktree, treecontext_status lists your own lane\'s',
  '  pointers and your default search covers your own lane: what ran in',
  '  this checkout, your helpers\' reports (a subagent\'s summary, a',
  '  worker\'s return) and the handoffs imported here, never a helper\'s',
  '  tool calls. Each reply says so, counts the other lanes and names the',
  '  most recent three. scope: "all" widens either; treecontext_export',
  '  with writer reads one lane\'s trail. A fresh start is handed your',
  '  lane\'s own newest chapter (or bookmark) and the other lanes\' names,',
  '  never their text; after a restart your own chapter is in the',
  '  orientation search\'s results, not promised first. A pointer labeled',
  '  "writer unknown" belongs to no lane: read its metadata before',
  '  trusting it. A headless worker searches the whole store; its brief',
  '  and the key lookup feed it.',
```
The subagent-search bullet above it ("…otherwise the whole store…") is
unchanged (D240 stands).

## 5. Open questions

None. R12 settles the search promise; R13 the gate. Two disclosures for
the owner's ratifying read: an import whose importing session the
registry cannot place lands in the main lane (D151 must hold for a B that
never registered); D377 is tagged [I] because its resp is the drafter's
reading of the quoted words.

## 6. Binding notes — what each Then must observe

General (as v3): the real session-start hook through the local runner
`sessionStart` (journal-orchestration.steps.ts:127, `runHook`), real
`git worktree add` (`openGitWorld`/`addWorktree`, :286, :313), subagents
through `hooksSubagent` (standins.ts), workers through `runWorker` +
standin-worker, a new `preCompact` stand-in added to standins.ts beside
`hooksLeg`; status and query through `mcpOver(w, { ccSessionId })`
(tests/journal/world.ts:87) opened under the session under test; a
"written before the store recorded writers" row staged as D263's binding
stages an earlier release's row (:483-503). The worktree's chapter is
always written after main's. Bindings asserting no scope block are
revisited: orchestration.steps.ts:426 (D147), :624 (D150) expect the block
naming `main`; session-registry.test.ts:199 keeps the whole-store note
(D240), :271 and :275 expect main's block.

- **D167 Then**: main's packet's first line is the main self sentence; a
  line names `feature-login` among other lanes with kind and age; the
  chapter's text and id are absent from the whole packet.
- **Incident walk (restarted-main scenario)**: after the packet asserts,
  open a fresh client under the *new* main session id; status
  `resume_pointers` is exactly [main chapter id] and the block's lane
  entry is `worktree:subproject`; the canonical query verbatim returns
  main's chapter id among hits and no worktree row (SQL: hits'
  `session_key` all placed in main); the `scope` block names `main`.
- **Resume (v3-F9 fix)**: for the `resume` start, every self line is
  present whole, the chapter line carrying `(id <main chapter id>)`, and
  the text after the self lines is at most 500 characters.
- **Worktree status / main status / every lane / outline / bookmark-only
  / main alone**: as v3 (ids exact; block fields; "absent from the whole
  serialized reply"; the outline's 0-lane row asserts no other-lanes
  sentence at all).
- **Scoped search**: hits ⊆ rows whose `session_key` the registry places
  in the lane; chapter and a captured turn present; windows contain no
  other-lane row; `scope: "all"` has no `scope` key.
- **Helpers' reports and imports (v3-F9 fix)**: every one of the 70 tool
  rows carries the searched words, so the positive twin is mandatory:
  `scope: "all"` must return at least one tool row and the subproject
  tester's report, while the default returns the three reports and no
  tool row. The orphan worker is registered through `runWorker` with an
  empty parent (`parent_session` NULL): its return is absent from main's
  default hits, present under `scope: "all"`, and the key lookup returns
  it.
- **Earlier release's conversation + export**: `treecontext_export`
  with `writer: "worktree:subproject"` returns the turns' ids; with
  `writer: "main"` it does not; `SELECT content, metadata_json` before
  and after byte-equal.
- **Flood (R12)**: 200 `hooksSubagent` start/stop pairs with reports
  containing "next step" so the store exceeds 256 rows and pruning runs;
  restart main under a new id; `resume_pointers` = [chapter],
  `other_lanes` 0; packet's own line is the chapter and no report text;
  the canonical query verbatim returns the chapter's id among its hits
  (any rank, recorded in the audit note), and no hit other than the
  chapter carries a resume-pointer flag or the own-lane label.
- **Snapshot lane**: two `preCompact` firings; main's packet names main's
  snapshot id, the worktree's row still `claimed_by IS NULL`; after the
  drain the recovery row's `session_key` is main's new session, each
  quoted id a main-lane row; the worktree's later start claims its own
  and its row's `session_key` is the worktree's session.
- **Worker status and search (journal-workers)**: `runWorker` with a
  plan `viaTools` that calls query and status; the query reply's `scope`
  says a worker searches the whole store as its harness feeds it and
  the hits include both chapters; the status reply lists both pointers
  flat with `scope.worker` (or the block's wording naming it a worker)
  and no "could not be placed".
- **Writer unknown / unplaced supersession / pre-registry rows**: as v3.
- **Narrowed negatives (v1-F9)**: orchestration.steps.ts:478-479 and
  handoff.steps.ts:514-515 also assert the row is not named in the scope
  block and not listed under `scope: "all"`.

## 7. v3-review findings → v4

| Finding | v4 |
|---|---|
| F1 export trail reads the stamp | D376: the trail by `main`/`worktree:<name>` is the lane as read from the registry; D374 says "by the same lane reading"; Then added to the earlier-release scenario; DESIGN says it; U1 owns the predicate. |
| F2 flood Then over-asserts; pruning | R12: "the orientation search finds the chapter, and no report it finds is offered as the main checkout's own thread"; comment names pruning past 256 rows; D374 resp carries the "found, never contradicted" promise; binding records the rank. |
| F3 worker caller has no rule | D374 restores "every other caller searches as before" and adds the worker clause; D372 adds "a worker of the ticket door sees every lane flat, the block naming it a worker"; one scenario in journal-workers binds both. |
| F4 gate inside the Fable limit; no end-to-end probe | R13: U6 deferred, everything else proceeds; the restarted-main scenario walks the incident (two Thens); five probes added to the triage. |
| F5 trail subtraction drops `internal-summary` | D374 names "the client's own internal summaries"; U1's subtraction keeps `subagent-summary` and `internal-summary`; probe added. |
| F6 helper whose parent cannot be placed | D374: "reports into no lane's default search, its return reached by the key lookup or by asking for the whole store"; scenario Given/Then for the orphan worker. |
| F7 residuals | D376's comment discloses the moved worktree (new lane), the removed worktree (counted until retired), two unplaced writers retiring each other (kept for D166), the ambiguous beacon. |
| F8 D377 `[V]` on drafted text | D377 is `[I]`, quotes R9, R11, R12/R13 verbatim from the rulings file ("failure ladder reviews", no hyphen), and says the ratifying entry can ratify it with the rest. |
| F9 binding notes | Resume proof reworded (lines whole, tail ≤ 500); the helpers' negative has its mandatory positive twin (tool rows carry the words). |
| Triage 1 Fable gate | Deferred per R13: after the build and the dogfood, if tokens allow, else 2026-11-06. |
| Triage 2 U4 to Opus | Done (door unit; D286 specimen; standins.ts edit). |
| Triage 3 merge order | U1 → U2 → U3 in separate worktrees, charter suite after each merge. |
| Triage 4 Fable binder | None now; U2/U4 step definitions move to Fable after the reset only if a hollow negative class repeats. |
| Triage 5 incident probes | Added to U2, U2/U3, U3, U4. |

## 8. Build triage (R11, R13)

| Unit | Files | Binds | Builder | Reviewer (Opus) and mutation probes |
|---|---|---|---|---|
| **U1 the lane read** (foundation) | `src/references.ts` (UNKNOWN lane for `_writer_src` `unregistered`, distinct from AMBIGUOUS); `src/persistence/session-registry.ts` (the sessions a self owns; helpers by `agent_id` rows and `parent_session` from `leg-registry.ts`); `src/flat-store.ts` (session-based `laneScopeSql`: `session_key IN (lane's sessions)` minus helper trails — rows with `_writer_agent_id` whose kind is neither `subagent-summary` nor `internal-summary` — plus helpers' summary rows by parent, plus `_handoff_importer` in the lane or unplaced → main, plus for main rows whose session the registry never held, minus `_writer_src` `unregistered`; `writerTrail` on the same predicate for `main`/`worktree:<name>`; `splitSupersedes` and the bookmark chain treat UNKNOWN as its own lane); `tests/session-registry.test.ts` | @D376 ×3; @D374 earlier-release (search and export Thens); the lane half of the helpers scenario | **Opus** | (1) drop the trail subtraction → "never a helper's trail" fails; (2) drop the parent link → the worker's return vanishes; (3) UNKNOWN→AMBIGUOUS → unplaced-supersession fails; (4) `unregistered`→main → unknown-writer fails; (5) include `unregistered` rows in main's scope → fails; (6) registry join → `_writer` → earlier-release search and export Thens fail; (7) exclude `internal-summary` from kept kinds → @D263's search Then fails; (8) orphan worker (NULL parent) folded into main → its Then fails |
| **U2 status and the packet** (parallel with U1 against its two interfaces) | `src/server/server.ts` (status: scope for a placed main; block with `other_lanes`, ≤3 lane entries with kind/age/count, "writer unknown" lane, worker and unplaced wording; `scope: "all"` pointers naming their lane); `src/flat-store.ts` (`status({ lane })` per-lane summary); `src/checkpoints.ts` (`selfLines` for both selves: own chapter, bookmark-only, brief for `main`, other-lanes line); `src/hooks/session-start.ts` (prepend for main, outside the budget) | @D372 ×3 + outline; @D373 ×3 incl. the incident walk's status Then; the @D167 Then rebound; status/packet half of @D376 unknown-writer; the worker's status Then; v1-F9 negatives | **Opus** | (1) remove the self sentence → D167 Then fails (vacuity); (2) worktree chapter's first line in the lane entry → "none of its text" fails; (3) cap 3→5 → outline's 5-lane row fails; (4) lanes oldest first → "newest first" fails; (5) self lines inside the resume budget → resume binding fails; (6) unknown pointers in main's own list → fails; (7) **restore today's main branch** (lane set only for a worktree self) → main-status scenario and the walk fail (the incident's regression); (8) derive the lane from the newest pointer instead of the registry → fail; (9) run the walk's status on the reused `w.client` → the block names the wrong lane and must fail |
| **U3 the search scope** (after U1) | `src/server/server.ts` (query: default lane scope for a placed own-agent caller; `{ lane, searched, widen }`; worker and unplaced notes; D240 branch untouched); `src/flat-store.ts` (windows under the session scope); revisit orchestration.steps.ts:426, :624; session-registry.test.ts:199, :271, :275 | @D374 ×4 (scoped search; helpers; flood; the walk's search Then); the worker's search Then; D147/D263/D151 re-asserted with the block | **Opus** | (1) scope hits but not windows → windows assert fails; (2) scope `concurrent` callers → session-registry.test.ts:199 fails (D240 guard); (3) a block present on `scope: "all"` → D150's `all['scope']` undefined fails; (4) **scope by `_writer` instead of the registry** → the walk's search Then fails (worktree turns read as main's); (5) run the walk's search on the reused `w.client` → fails; (6) flood: present a report with the own-lane label → "offered as the main checkout's own thread" fails |
| **U4 the snapshot's lane** (parallel with U2; needs U1's predicate for the drain's queries) | `src/hooks/shared.ts` (`claimSnapshot` by the claimant's self; unplaced never claimed); `src/server/ingestion.ts` (recovery row with `session_id` of the claiming session; queries under the lane scope); `tests/journal/standins.ts` (`preCompact`) | @D375 | **Opus** (door unit: a session-start claim and a drain write; D286's specimen; the stand-in guard) | (1) drop the self filter → main's packet names the worktree's snapshot; (2) drop `session_id` on the insert → "the worktree's own, never the main lane's" fails; (3) unscoped queries → "quotes the main lane only" fails; (4) **claim by `session_id != ?` alone** (today's code) → the snapshot Then fails |
| **U5 handshake and docs** (after U2/U3) | `src/server/instructions.ts` (§4 text; card untouched; drift test green); README (lanes, scope, "writer unknown", the worker); CHANGELOG; the charter edits of §1–§3 (coordinator) | journal-agent-surface green (D264 unchanged) | **Sonnet** | light: card byte-length, drift test, README claims nothing unbound |
| **U6 dogfood** | the desktop and the laptop under R9: a main and a worktree session on one store, restart main, read the packet, panel and search | — | the coordinator | the incident reproduced and not reproduced |
| **U7 Fable gate** | the whole slice; per-unit binding counts collated | all | **Fable**, **deferred per R13**: after U1–U6, if tokens allow, else Thursday 2026-11-06 | — |

Order: charter edits first; U1 in its own worktree; U2 and U4 in their
own worktrees against U1's interfaces (the UNKNOWN constant; the
session-scope predicate); merge U1, then U2, then U3, then U4, the
charter suite re-run after each merge; U5 after U3; U6 after U5; U7
last. Per-unit binding counts (bound / hollow / narrowed / unlit) go in
each unit's audit note; if U2's counts show a hollow or vacuous negative
class repeating, move U2's and U4's step definitions to Fable after the
reset and compare.
