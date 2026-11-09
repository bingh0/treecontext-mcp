Feature: Orchestration inside one store — lanes that stay their own

  The store is a flat, decentralised set of lanes, like git: the main
  lane and every derivative, a subagent, a worktree, a teammate's
  machine. Nothing is edited in place. Any writer may append into any
  lane so long as the row names its writer and what it refers to; nothing
  outside the writer's own lane is modified; a cross-lane reference is a
  pointer the owning lane sees, never a flag flip, save one door: a client
  the server cannot place may retire a chapter written before the store
  recorded writers, recorded, where no session has run in the main
  checkout.
  Self is recovered from where a session runs, not from its process, so a
  stopped worktree, or the main checkout beside one, resumes its own
  thread; the main checkout is a lane like any worktree, and a lane is
  read from where its sessions ran, never stamped after the fact.
  Namespaces stay the process-level boundary
  (D196); lanes are metadata inside them.

  Rulings D147, D148, D150, D167, D169, D186, D190 of the hackathon
  interview, 2026-10-05 to 2026-10-07; D263 of 2026-10-10; D372 to D376
  and D378 of 2026-11-02 (the main checkout's own lane: status, the fresh
  start, the search scope read from the registry, the recovery snapshot's
  lane, the unknown writer, the chapter from before writers were
  recorded); D379 of 2026-11-03 (one lane rule for every reader); D391 of
  2026-11-09 (a curated dedup hit modifies no other lane's row). Group
  orientation (D168) is deferred with groups configuration (D209), no scenario yet.

  @D147
  Scenario: the orchestrator finds the subagent's summary by search
    Given an orchestrating session that spawned a subagent in the role "tester"
    And the tester made 40 tool calls and reported "12 tests pass, CSRF fails; next: refresh the token"
    When the tester finishes
    Then the orchestrator searching "CSRF" finds that report marked as the tester subagent's summary

  @D263
  Scenario: the client's own internal agent is marked as such, never as a subagent
    Given a session in which the client's compaction summarizer finishes, with an agent id nobody registered and no agent type
    When its report is captured and ingested
    Then the entry carries the kind "internal-summary" and the writer "claude-code"
    And the orchestrator searching the report's own words finds it
    And it is not marked as any subagent's summary
    # Claude Code fires SubagentStop for agents nobody spawned, the
    # compaction summarizer and prompt-suggestion side calls; on the
    # owner's store they outnumbered real subagents ten to one over two
    # days and led the default handoff file. Captured whole, nothing is
    # filtered; only the marking changes (D263).

  @D263
  Scenario: internal summaries already stored are re-marked when a newer treecontext opens the store
    Given a store in which an earlier treecontext stored an untyped SubagentStop report as a subagent's summary beside a typed subagent's summary
    When this treecontext opens the store
    Then the untyped report carries the kind "internal-summary" and the writer "claude-code", its content unchanged
    And the typed subagent's summary is unchanged

  @D148
  Scenario: the orchestrator reads the subagent's trail on its own
    Given an orchestrating session holding 300 entries of its own
    And a finished tester subagent whose trail is 40 tool calls and one report
    When the orchestrator asks for the tester's trail
    Then the orchestrator sees the 40 tool calls and the report
    And the orchestrator sees none of its own 300 entries in that trail

  @D150
  Scenario: a new subagent starts from its role's prior trail and the plan it was spawned under
    Given an earlier tester subagent whose trail mentions "login form fixtures"
    And the orchestrator's current plan reads "plan: wire the login form"
    And 300 entries of the orchestrator's own that mention "login"
    When a new tester subagent starts and searches "login"
    Then the new tester finds the earlier tester's trail and the plan
    And the new tester sees none of those 300 entries unless it asks for the whole store

  @D167
  Scenario: a restarted worktree session resumes its own thread
    Given a session in the worktree "feature-login" that wrote the chapter summary "plan: wire the login form; next: write its tests" and then stopped
    When a new session starts in the worktree "feature-login" under a new session id
    Then the packet handed to the new session's agent carries that chapter summary, labeled as the worktree's own
    And the packet handed to a session starting in the main checkout at the same time does not carry it

  @D167
  Scenario: a new worktree is treated as a new subagent process
    Given a worktree "feature-search" that has never run a session
    And the worktree "feature-login" holds the chapter summary "plan: wire the login form"
    And the orchestrator injected the brief "build the search box; the plan is in the main lane" at its start
    When a session starts in the worktree "feature-search"
    Then the packet handed to its agent carries the injected brief
    And the packet carries no chapter summary from any other worktree

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
    And neither chapter carries a retirement across the pre-stamp boundary

  @D376
  Scenario: rows from before the store recorded writers stay the main lane's
    Given a store whose chapter summary "plan: the first release" was written before the store recorded writers
    When the main checkout's session calls status and searches "first release"
    Then the chapter is listed and found as the main lane's own
    And a session in the worktree "subproject" sees it counted among other lanes, never as its own

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

  @D379
  Scenario: a chapter a program wrote through the library in a worktree's session is the worktree's in every reader
    Given a session in the main checkout and a session in the worktree "subproject", each registered by its session-start hook
    And a chapter summary written through the library with no writer stamp in the worktree "subproject"'s session
    When the main checkout's session calls status and then starts a new session
    Then neither the status nor the packet lists the chapter as the main lane's own, and both count it under the worktree "subproject"
    And the worktree's session calling status lists the chapter as its own, and the packet of a new session in the worktree opens on it
    And the main checkout's search for the chapter's words does not find it as its own, and the worktree's search does
    # Gate finding #1, 2026-11-03: the panel and the packet read the
    # chapter's lane from its writer stamp, and it has none, so they gave
    # it to main; the search read the registry and gave it to the
    # worktree. One rule now: the registry places the session first.

  @D379
  Scenario: a subagent's chapter in a worktree's session is its role's, never the worktree's own
    Given the worktree "subproject"'s own live chapter summary, written through the tools
    And a tester subagent the worktree's session spawned, which writes a newer live chapter summary through the tools
    When the worktree's session calls status and a new session starts in the worktree
    Then neither the status nor the packet lists the tester's chapter as the worktree's own, and both count it under "tester"
    And the worktree's own chapter still leads both
    # The gate-fix review, 2026-11-03, F2: the registry places the
    # session's own agent's rows, never a helper's (R8).

  @D190
  Scenario: the session-start hook registers self and the server stamps rows from it
    Given a session starting in the worktree "feature-login" on the branch "login-form"
    When the session-start hook fires
    Then the store holds a registration of that session whose worktree and branch equal what git reports for that directory
    And a chapter summary written through the tools from that session is stamped with "feature-login"

  @D410
  Scenario: a Codex CLI main registers itself at its start and the server stamps its rows from it
    Given a Codex CLI 0.167.0 session starting in a worktree of its checkout, as recorded, with the hooks install wrote trusted
    When its session-start hook receives the start as Codex sends it
    Then the store holds a self registration of that Codex session whose worktree and branch equal what git reports for that directory
    And a chapter summary written through the tools from that session is stamped with that worktree's name, never "unregistered"

  @D410 @D167
  Scenario: a Codex CLI main's fresh start is handed its lane's chapter
    Given a store holding a live chapter summary of the main checkout's lane
    And a Codex CLI 0.167.0 main starting fresh in the main checkout, with the hooks install wrote trusted
    When its session-start hook receives the start as Codex sends it
    Then the hook's reply hands Codex, as context to add to the session, the packet a Claude Code session gets at a fresh start, opening with that chapter as the lane's own
    # Recorded live, 2026-11-09, Codex CLI 0.167.0: a SessionStart hook's
    # added context reached the model. Only a fresh start was recorded;
    # what a resumed Codex session is handed is not promised (D410).

  @D410
  Scenario: at a Codex CLI turn's end treecontext's hooks print nothing
    Given a Codex CLI 0.167.0 main with the hooks install wrote trusted, whose turn has run long enough that a Claude Code session would be asked for a bookmark
    When its stop hook receives the turn's end as Codex sends it
    Then the hook printed nothing, and asked Codex for no bookmark and no further turn
    # Recorded live, 2026-11-09: Codex honours a Stop hook's block, and
    # `codex exec` prints only the last reply, so the turn a block causes
    # replaces a headless run's real answer. A hook cannot yet tell
    # `codex exec` from Codex's interactive interface, so the Stop hook's
    # bookmark ask and send-back wait for beta.5 on Codex (the fence).

  @D190
  Scenario: a subagent's tool-written note carries its own writer though it shares the session
    Given a tester subagent and its orchestrator sharing one session id and one server
    When each of them inserts a note through the tools
    Then the orchestrator reading the notes sees the tester's note stamped with the tester as writer and its own note stamped with the orchestrator

  @D169
  Scenario: a subagent appends into the main lane with its writer and reference stamped
    Given the orchestrator's chapter summary "plan: wire the login form; next: write its tests" in the main lane
    When the tester subagent appends a note into the main lane that names that chapter and reads "CSRF blocks the plan's next step"
    Then the orchestrator reading the note sees the tester named as its writer and the chapter's id as its reference
    And the orchestrator's chapter summary is unchanged byte for byte
    And the orchestrator's chapter summary is still a live pointer

  @D169
  Scenario: a subagent cannot retire the orchestrator's pointer
    Given the orchestrator's chapter summary "plan: wire the login form; next: write its tests" in the main lane
    When the tester subagent writes an entry that supersedes that chapter
    Then the orchestrator calling status still sees the chapter as a live pointer
    And the tester's entry carries the pointer to the chapter
    And the orchestrator's next packet after a /clear lists the tester's entry under referenced-by

  @D420 @D240
  Scenario Outline: an orchestrator's bookmark written while one subagent was live supersedes its own earlier one once its echo names the orchestrator, <how>
    Given the orchestrator's bookmark "next: wire the submit button" in the main lane
    And one tester subagent live, the orchestrator silent since it started
    When the orchestrator inserts the bookmark "next: write the form's tests" through the tools, <how>
    Then the reply says the supersession of "next: wire the submit button" is pending until the call's echo names the writer, and never that it was left live as another writer's
    When the call's echo is captured and ingestion runs
    Then "next: wire the submit button" is retired, superseded by "next: write the form's tests"
    And the orchestrator calling status sees "next: write the form's tests" as the main lane's one live bookmark

    Examples:
      | how                                   |
      | naming the earlier one in supersedes  |
      | naming nothing to supersede           |
    # Found 2026-11-09 (D420): the store stamped such a bookmark as the
    # subagent's until its echo, and its reply told the orchestrator the
    # earlier bookmark was another writer's, left live. The echo heal
    # already retires a target named in supersedes; a bookmark's own
    # retirement of its lane's earlier one was never run again at the heal.

  @D420 @D169
  Scenario Outline: a supersession held under a provisional stamp leaves <owner>'s entry live after the echo
    Given <target>
    And one tester subagent live, the orchestrator silent since it started
    When the orchestrator inserts a bookmark through the tools superseding that entry, and the call's echo is captured and ingestion runs
    Then that entry is still live and unchanged
    And the orchestrator's bookmark records it as referenced, where its writer sees it as referenced-by

    Examples:
      | owner                    | target                                                                   |
      | the tester               | the tester subagent's bookmark "tests: three of five pass"                |
      | the worktree "subproject" | the chapter summary "plan: wire the login form" in the worktree "subproject" |

  @D420
  Scenario: a supersession whose echo never comes stays pending, and says so
    Given the orchestrator's bookmark "next: wire the submit button" in the main lane
    And one tester subagent live, the orchestrator silent since it started
    When the orchestrator inserts a bookmark superseding it through the tools, and no echo of that call is ever captured
    Then "next: wire the submit button" is still live
    And the new bookmark shows its supersession of "next: wire the submit button" as pending
    And the orchestrator calling status sees that supersession listed as pending, naming "next: wire the submit button"

  @D391 @D169
  Scenario: a dedup hit's reply names the surviving row's writer and lane and says nothing landed in the caller's
    Given the note "the login form posts to /api/session" written by the worktree "subproject"'s own agent
    When a session in the main checkout inserts "the login form posts to /api/session" through the tools
    Then the reply says the insert was deduplicated onto the worktree's row, naming its writer and the lane "worktree:subproject"
    And the reply says that nothing landed in the main checkout's lane
    And the store holds one row of that text, in the worktree's lane

  @D391 @D169
  Scenario: a dedup hit never arms another lane's resume pointer
    Given the chapter summary "plan: wire the login form" in the worktree "subproject", which the worktree's own agent has since superseded
    When a session in the main checkout inserts "plan: wire the login form" through the tools with next_session set
    Then the worktree's chapter summary is unchanged byte for byte and is still no live pointer
    And the main checkout's status lists no pointer to it
    # Today the hit arms next_session on the survivor whoever's lane it
    # is in (mergePointerFlags), while the references beside it are
    # already refused across lanes (D169); the binding reads the
    # worktree's row with SQL before and after the insert.

  @D391 @D86
  Scenario: a dedup hit's echo from another lane leaves the surviving row's writer and lane as they were
    Given the note "the login form posts to /api/session" written by the worktree "subproject"'s own agent through a server that read its session from the beacon, its echo drained
    When a session in the main checkout inserts "the login form posts to /api/session" through the tools
    And the drain processes that insert's echo
    Then the worktree's row is unchanged byte for byte, its writer and its lane still "worktree:subproject"
    # A session read from the beacon is an attribution an in-window echo
    # may change (an exact one never is, D86), so the drain's heal of the
    # main checkout's echo is what this reaches; the binding reads the
    # worktree's row with SQL after its own echo is drained and after the
    # main checkout's.

  @D391 @D169
  Scenario: a dedup hit from another lane records no reference on the surviving row, and the reply says so
    Given the note "the login form posts to /api/session" written by the worktree "subproject"'s own agent
    And the main checkout's own note "the CSRF token rides in a header"
    When a session in the main checkout inserts "the login form posts to /api/session" through the tools naming that note in its refs
    And the drain processes that insert's echo
    Then the worktree's row is unchanged byte for byte and records no reference to the main checkout's note
    And the reply says that reference was not recorded

  @D186
  Scenario: references resolve one hop deep, the rest on request
    Given an entry A, an entry B that names A, and an entry C that names B
    When the orchestrator searches and hits A
    Then the orchestrator sees A referenced by B with B's writer, age and first line, and a count of 1
    And the orchestrator does not see C until it fetches B by id

  # Antigravity CLI's main (D416, 2026-11-09, beta.4): with treecontext's
  # named hook installed, an agy main registers itself at its session
  # start, keyed by its conversation, as a Claude Code main does.

  @D416 @D190
  Scenario: an Antigravity CLI main registers itself at its session start and the server stamps its notes from it
    Given an Antigravity session starting in a worktree of its checkout, its SessionStart as Antigravity sends it
    When the hook install writes for Antigravity CLI receives it, and the session writes a chapter summary through the tools
    Then the store holds a self registration keyed by the session's conversation id, whose worktree and branch equal what git reports for that directory
    And the chapter summary is stamped as that session's own, in that worktree's lane, never as writer unknown
    # Before beta.4 an agy main registered nothing: its chapter summaries
    # read as written by an unplaced client (the fence's Antigravity CLI
    # entry, amended by D416).

  @D416 @D418
  Scenario Outline: an Antigravity CLI main whose subagent has started still writes as itself, <linked>
    Given an Antigravity main session registered at its SessionStart, which starts a subagent through agy's own subagent tool, the subagent's events as Antigravity sends them reaching the hook install writes
    And <link>
    When the main writes a chapter summary through the tools after the subagent's session has started
    Then the chapter summary is stamped as the main's own, in the main's lane
    And no row the main writes is stamped as the subagent's

    Examples:
      | linked                         | link                                                                     |
      | the subagent linked            | the parent's call result naming the subagent has been read               |
      | the subagent not yet linked    | the parent's call result naming the subagent has not yet been read       |
    # One agy process hosts the subagent's conversation as well as the
    # main's, and agy ran its hooks through `sh` in the recording of
    # 2026-11-09. A subagent's start that took over the identity keyed to
    # that process would stamp every later note of the main as the
    # subagent's (D416).
