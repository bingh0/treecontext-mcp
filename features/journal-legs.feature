Feature: Legs — a subagent's bounded unit of work, briefed at its start and checkpointed at its end

  A leg is a subagent spawned through the hooks door whose brief names a
  run and a key. At its first moment it sees its brief and the checkpoint
  in effect under its key, and makes no query. At its end it writes the
  next checkpoint under that key, or is sent back once for the one it
  forgot, never twice, and never when the store cannot be written. A leg
  that is cut leaves its trail, and the next leg of its role starts as a
  recovery leg. The main agent never writes a leg's checkpoint and the
  store never synthesizes one. A subagent with no brief or no key is a
  subagent exactly as today.

  Rulings D279, D280, D281, D284, D285, D296, D299, D305, D314, D320,
  D321, D325, D326, D327, D328, D329, D330, D331, D332, D334 of the beta.3 interview, 2026-10-29 to 2026-10-31. The legs here
  run through Claude Code's hooks; the ticket door for headless workers
  is journal-workers, and the run as a unit is journal-runs. Every Then
  here reads the context the subagent-start hook emits, the output of
  the subagent-stop hook, or the store, never a live reply: what the
  model does with its packet is out of reach (D188).

  @D284
  Scenario: a leg's first moment is its brief and the checkpoint in effect, with no query made
    Given a run "r1" whose key "login-form" holds the checkpoint number 3, written by the builder role, reading "state: form renders; next: wire the submit"
    And a brief row for the builder role that names the run "r1", the key "login-form" and the builder as its checkpointer
    When a builder subagent starts
    Then the context the subagent-start hook emits for the builder carries the brief and checkpoint number 3's text whole, with its writer "builder" and its moment

  @D284
  Scenario: a fresh leg on a key with no checkpoint is told so, and its first checkpoint is number 1
    Given a brief row for the builder role naming the run "r1" and the key "search-box", with no checkpoint under that key
    When a builder subagent starts
    Then the context the subagent-start hook emits for the builder carries the brief and says no checkpoint is in effect under "search-box"
    And the harness looking up the key "search-box" on the run "r1" receives no checkpoint and a line saying so
    And the checkpoint the builder writes at its end is number 1 under the key "search-box"

  @D284
  Scenario: the checkpoint a leg writes at its end takes the next number and supersedes the one it started from
    Given a builder leg under the run "r1" that started from checkpoint number 3 under the key "login-form"
    When the builder writes the checkpoint "state: submit wired; next: validation" and stops
    Then the builder's stop is not blocked
    And the harness looking up the key "login-form" receives checkpoint number 4, superseding number 3
    And checkpoint number 4 carries the writer "builder" stamped by the store, its moment, the run "r1" and the builder's lane
    And checkpoint number 3 is unchanged byte for byte

  @D279 @D280
  Scenario: a leg that finishes with no checkpoint is sent back once with the missing checkpoint named
    Given a project whose configuration names no send-back setting and no checkpointer setting
    And a builder leg started from checkpoint number 3 under the key "login-form", named as its checkpointer
    When the builder stops after 40 tool calls with no checkpoint written under its key newer than its start
    Then the subagent-stop hook's output blocks the stop once, with the reason naming the key "login-form" and the missing checkpoint

  @D279 @D280
  Scenario: a leg sent back once that then writes its checkpoint stops unblocked
    Given a builder leg already sent back once for the missing checkpoint under the key "login-form"
    When the builder writes the checkpoint "state: submit wired" and stops
    Then the builder's stop is not blocked
    And the harness looking up the key "login-form" receives checkpoint number 4 with the writer "builder"

  @D279 @D280
  Scenario: a leg sent back once is never sent back a second time
    Given a builder leg already sent back once for the missing checkpoint under the key "login-form"
    When the builder stops again with no checkpoint written
    Then the builder's stop is not blocked
    And the harness looking up the key "login-form" sees the builder leg retired as having ended without a checkpoint
    And the context the subagent-start hook emits for the next builder says its predecessor ended without a checkpoint

  @D279 @D280
  Scenario: no send-back when the store cannot be written
    Given a builder leg started from checkpoint number 3 under the key "login-form", named as its checkpointer
    And a store that refuses writes
    When the builder stops with no checkpoint written
    Then the builder's stop is not blocked
    And the store, once writable, carries a capture-gap marker at the builder's stop

  @D279
  Scenario: a cut leg leaves its trail and the next leg of its role starts as a recovery leg
    Given a builder leg under the key "login-form" that started from checkpoint number 3, wrote 25 tool calls and was killed before writing any checkpoint
    When the next builder leg starts under the key "login-form"
    Then the context the subagent-start hook emits for the new builder says its predecessor was cut, names its predecessor's lane and the count 25, and names checkpoint number 3 as the one in effect

  @D279
  Scenario: a recovery leg writes the checkpoint its predecessor did not
    Given a builder leg started as a recovery leg under the key "login-form", with checkpoint number 3 in effect
    When the recovery builder writes the checkpoint "state: recovered; submit wired" and stops
    Then the harness looking up the key "login-form" receives checkpoint number 4 with the writer "builder"

  @D279
  Scenario: a cut leg leaves no checkpoint the store wrote
    Given a run "r1" whose key "login-form" holds checkpoint number 3, and a builder leg cut with no checkpoint
    When the drain runs and the harness looks up the key "login-form"
    Then the harness receives checkpoint number 3 with the builder leg shown as cut
    And a reader of the store file finds no checkpoint row under "login-form" newer than number 3

  @D296
  Scenario: a checkpoint the main agent writes under a leg's key comes back flagged, never withheld
    Given a brief naming the builder as the checkpointer of the key "login-form", and checkpoint number 3 under it
    When the main agent inserts a checkpoint under the key "login-form"
    Then the harness looking up the key "login-form" receives that checkpoint as number 4 with the writer "main"
    And the same reply says its writer is not the checkpointer the brief names

  @D280
  Scenario: a reviewer's original-plus-review supersedes the original and the lookup returns it
    Given checkpoint number 4 under the key "login-form", written by the builder role
    When the reviewer role writes checkpoint number 5 under the key "login-form" naming number 4 as superseded
    Then the harness looking up the key "login-form" receives checkpoint number 5 with the writer "reviewer"
    And checkpoint number 4 is still readable by its id

  @D280
  Scenario: two checkpoints in effect under one key come back as two, never a silent pick
    Given checkpoint number 4 under the key "login-form", written by the builder role
    And checkpoint number 5 under the key "login-form", written by the reviewer role, that names nothing as superseded
    When the harness looks up the key "login-form"
    Then the harness receives both number 4 and number 5 and a line saying two are in effect

  @D280
  Scenario: every checkpoint names what it supersedes and what it rests on, so a reader can walk back to the trail
    Given checkpoint number 5 under the key "login-form" that supersedes number 4 and rests on 3 trail entries
    When a reader walks from checkpoint number 5
    Then the reader reaches checkpoint number 4 by its supersedes reference and the 3 entries checkpoint number 5 rests on, each fetched by its id

  @D281
  Scenario: the brief names who checkpointed the work resumed and who will checkpoint at the end
    Given a brief row for the technical-writer role under the key "login-form" whose past checkpointer is the builder and whose future checkpointer is the project-manager
    When the technical-writer subagent starts
    Then the context the subagent-start hook emits for the technical-writer names the builder as the writer of the checkpoint it resumes and the project-manager as the one who will checkpoint

  @D281
  Scenario: a leg whose brief names another role as checkpointer is never sent back
    Given a technical-writer leg whose brief names the project-manager as the one who will checkpoint the key "login-form"
    When the technical-writer stops with no checkpoint written under the key "login-form"
    Then the technical-writer's stop is not blocked
    And the harness looking up the key "login-form" sees the technical-writer leg retired without a send-back

  @D284
  Scenario: the pointer to a leg's summary row carries the leg's role, run and key
    Given a builder leg under the run "r1" and the key "login-form" that wrote checkpoint number 4
    When the builder finishes with the report "submit wired; 12 tests pass"
    Then the main agent is handed one line pointing at a summary row whose writer is "builder" and which carries the run "r1" and the key "login-form"

  @D285
  Scenario: the pointer comes back every time and the next leg starts from the store whether or not it was followed
    Given a builder leg finished under the run "r1" and the key "login-form" having written checkpoint number 4, and no read of its summary row in the store
    When a builder subagent starts under the key "login-form"
    Then the main agent was handed the one-line pointer at the leg's finish all the same
    And the context the subagent-start hook emits for the new builder carries checkpoint number 4

  @D332 @D299 @D280 @D279
  Scenario Outline: a checkpoint of <chars> characters is <verdict> on its first write and <verdict2> on the second
    Given a builder leg under the key "login-form"
    When the builder writes a checkpoint of <chars> characters twice in a row
    Then the builder sees the first write <verdict>
    And the builder sees the second write <verdict2>

    Examples:
      | chars  | verdict                                          | verdict2                         |
      | 1      | accepted                                         | accepted                         |
      | 16000  | accepted                                         | accepted                         |
      | 16001  | refused with the reason and the shape asked for  | accepted and marked over the cap |
      | 300000 | refused with the reason and the shape asked for  | accepted and marked over the cap |

  @D299
  Scenario: a second over-cap write by another leg or under another key is refused again
    Given a builder leg whose 20000-character checkpoint under the key "login-form" was refused once
    When the reviewer leg writes a 20000-character checkpoint under the key "login-form", and the builder writes one under the key "search-box"
    Then the reviewer sees its write refused with the reason and the shape asked for
    And the builder sees its write under "search-box" refused with the reason and the shape asked for

  @D299 @D279
  Scenario: a leg refused once that stops without writing a shorter checkpoint is sent back for it
    Given a builder leg named as checkpointer whose 20000-character checkpoint under the key "login-form" was refused once
    When the builder stops without writing again
    Then the subagent-stop hook's output blocks the stop once, with the reason naming the key "login-form" and the missing checkpoint

  @D321 @D299
  Scenario: an over-cap checkpoint accepted on its second write is the one in effect, and the next leg's first-moment row shows what it cost
    Given a builder leg whose second write of a 20000-character checkpoint under the key "login-form" was accepted
    When the harness looks up the key "login-form" and the next builder leg starts under it
    Then the harness receives that checkpoint whole, marked as over the cap, with its size 20000
    And the store holds the next builder's first-moment row carrying the checkpoint size 20000

  @D305
  Scenario: a subagent with no brief or no key is registered and summarised exactly as today
    Given an orchestrating session with no brief row for the explorer role, that spawns an explorer subagent with the prompt "find where the login form is rendered"
    When the explorer finishes with the report "src/login/Form.tsx"
    Then the explorer's registration carries no run and no key
    And the orchestrator searching "login form" finds that report marked as the explorer subagent's summary
    And the explorer's stop is not blocked and no checkpoint is asked for

  @D305
  Scenario: a subagent whose brief names a run and a key gets the leg contract
    Given a brief row for the builder role naming the run "r1" and the key "login-form", and checkpoint number 3 under that key
    When a builder subagent starts through the hooks door
    Then the first row of the builder's lane is a first-moment row referencing the brief row and checkpoint number 3's row by id, not copies, and carrying the checkpoint's size
    And the harness looking up the key "login-form" on the run "r1" counts the builder among the run's legs

  @D320
  Scenario: the hooks door takes a leg's key from its role's newest brief and marks it inferred
    Given one brief row in effect for the builder role, naming the run "r1" and the key "login-form"
    When a builder subagent starts through the hooks door
    Then the builder's registration carries the run "r1" and the key "login-form", marked inferred

  @D320
  Scenario: an inferred key gives way to the key the leg first writes under
    Given a builder subagent registered with the key "login-form", marked inferred
    When the builder writes its first row under the key "search-box"
    Then the builder's registration carries the key "search-box", marked as the leg's own

  @D320
  Scenario: two briefs in effect for one role make the key ambiguous and name the candidates
    Given a brief row for the builder role naming the key "login-form" and another naming the key "search-box", both in effect
    When a builder subagent starts through the hooks door
    Then the builder's registration says its key is ambiguous and names "login-form" and "search-box" as the candidates

  @D320
  Scenario: the leg's first write under a key settles an ambiguous registration
    Given a builder subagent registered with an ambiguous key between "login-form" and "search-box"
    When the builder writes its first row under the key "search-box"
    Then the builder's registration carries the key "search-box", marked as the leg's own

  @D320
  Scenario: a leg that writes under no key stays keyless, stops unblocked, and the run's facts count it as such
    Given a builder subagent registered on the run "r1" with an ambiguous key between "login-form" and "search-box"
    When the builder stops having written under no key
    Then the builder's stop is not blocked
    And the harness looking up the key "login-form" on the run "r1" counts one keyless leg among the run's facts

  @D314
  Scenario: a leg through the hooks door starts cold when the store is unreachable, and the gap is marked
    Given a brief row for the builder role naming the key "login-form"
    And a store that is locked for longer than the hook's time budget
    When a builder subagent starts
    Then the context the subagent-start hook emits for the builder carries no brief
    And the store, once writable, holds no first-moment row for the builder and carries a capture-gap marker at the builder's start naming the dropped event

  @D325 @D299
  Scenario Outline: a first moment of <chars> characters through the hooks door is <injected>
    Given a brief row for the builder role of 1000 characters naming the key "login-form"
    And a checkpoint in effect under the key "login-form" whose size makes the first moment <chars> characters
    When a builder subagent starts
    Then the context the subagent-start hook emits for the builder is <injected>
    And the store holds the builder's first-moment row carrying the checkpoint's size and whether it was cut

    Examples:
      | chars | injected                                                                                                         |
      | 9000  | the brief and the checkpoint whole, with no query made                                                           |
      | 10000 | the brief and the checkpoint whole, with no query made                                                           |
      | 17000 | the brief, the checkpoint up to the client's cap, the checkpoint row's id and the count of characters left out    |
      | 40000 | the brief, the checkpoint up to the client's cap, the checkpoint row's id and the count of characters left out    |

  @D325
  Scenario: a leg fetches the rest of a cut checkpoint by export and gets it whole
    Given a builder leg whose first moment carried checkpoint number 4 cut at the client's cap, with its row id
    When the builder exports that row by id
    Then the builder receives checkpoint number 4 whole, all 17000 characters

  @D326
  Scenario: an inferred key never makes the stop ask for a checkpoint
    Given one brief row in effect for the builder role naming the run "r1" and the key "login-form"
    And a builder subagent spawned for a quick lookup, registered with the key "login-form" marked inferred
    When the builder stops having written under no key
    Then the builder's stop is not blocked
    And the harness looking up the key "login-form" on the run "r1" counts one keyless leg among the run's facts

  @D326
  Scenario: a key the leg wrote under, marked as its own, makes the stop ask for the missing checkpoint
    Given a builder subagent registered with the key "login-form" marked inferred, named as its checkpointer
    And the builder wrote one row under the key "login-form", so its registration carries the key marked as the leg's own
    When the builder stops with no checkpoint written under the key "login-form"
    Then the subagent-stop hook's output blocks the stop once, with the reason naming the key "login-form" and the missing checkpoint

  @D327
  Scenario: a newer brief for the same role and key supersedes the older one
    Given a brief row for the builder role under the key "login-form" on the run "r1", and a newer brief row for the builder role under the key "login-form" that names it as superseded
    When a builder subagent starts through the hooks door
    Then the builder's registration carries the key "login-form", marked inferred, with no ambiguity
    And the context the subagent-start hook emits for the builder carries the newer brief, and the older one stays readable by its id

  @D327
  Scenario: a run's close ends its briefs
    Given a brief row for the builder role under the key "login-form" on the run "r1", and the run "r1" closed
    And a brief row for the builder role under the key "search-box" on the open run "r2"
    When a builder subagent starts through the hooks door
    Then the builder's registration carries the run "r2" and the key "search-box", marked inferred, with no ambiguity

  @D328
  Scenario: a leg left live is retired as cut when its session next starts, and the next leg of its role recovers
    Given a builder leg under the key "login-form" registered live, whose stop hook never fired
    When the session starts again and its session-start hook fires
    Then the builder leg's registration reads cut, with the moment it was noticed and the session start as what noticed it, and no guessed exit time
    And the context the subagent-start hook emits for the next builder under "login-form" says its predecessor was cut

  @D328
  Scenario: until its session restarts, a silent leg reads as live with its ages shown
    Given a builder leg under the key "login-form" registered live 2 hours ago, whose last row is 90 minutes old, in a session still running
    When the harness looks up the key "login-form"
    Then the harness sees the builder leg as live, with its start 2 hours ago and its last write 90 minutes ago

  @D329 @D280
  Scenario: two legs that started from one checkpoint write 4 and 5, never two 4s, and both stay in effect
    Given two builder legs under the key "login-form" that both started from checkpoint number 3
    When each writes its checkpoint and stops
    Then the first to land is number 4 and the second is number 5, each naming number 3 as what it supersedes
    And the harness looking up the key "login-form" receives both number 4 and number 5 and a line saying two are in effect

  @D329
  Scenario: a leg starting while two checkpoints are in effect is handed both, flagged
    Given checkpoint number 4 and checkpoint number 5 both in effect under the key "login-form", and a brief row naming the reviewer as the checkpointer
    When a reviewer subagent starts
    Then the context the subagent-start hook emits for the reviewer carries both number 4 and number 5 and a line saying two are in effect
    And the store holds the reviewer's first-moment row referencing both checkpoint rows by id

  @D330
  Scenario: the pointer rides on the Agent tool's result and the subagent's final message is untouched
    Given a builder leg under the run "r1" and the key "login-form" that finishes with the final message "submit wired; 12 tests pass"
    When the Agent tool returns to the main agent
    Then the main agent receives the final message "submit wired; 12 tests pass" whole
    And the main agent receives one added line naming the summary row, its writer "builder", the run "r1" and the key "login-form"

  @D331
  Scenario: a checkpoint that names nothing as superseded is stamped from the leg's start, marked as the store's
    Given a builder leg that started from checkpoint number 3 under the key "login-form"
    When the builder writes the checkpoint "state: submit wired" naming nothing as superseded
    Then the harness looking up the key "login-form" receives that checkpoint as number 4, superseding number 3, with the supersession marked as stamped by the store
    And number 3 is no longer in effect

  @D331
  Scenario: a checkpoint that names another checkpoint is taken at its word
    Given checkpoint number 4 under the key "login-form", and a reviewer leg that started from it
    When the reviewer writes checkpoint number 5 naming number 4 as superseded
    Then the harness looking up the key "login-form" receives number 5, superseding number 4, with the supersession marked as written by the leg

  @D332 @D299
  Scenario: every first moment says in treecontext's own words that a checkpoint is state, not history
    Given a brief row for the builder role under the key "login-form" that says nothing about checkpoints
    When the builder subagent starts
    Then the context the subagent-start hook emits for the builder says a checkpoint is the state of the work as it now stands, names what it supersedes and rests on, and never pastes the history in

  @D334 @D279
  Scenario: a leg that ended without a checkpoint after its one send-back is followed by a recovery leg
    Given a builder leg under the key "login-form", started from checkpoint number 3, sent back once and stopped again with no checkpoint
    When the next builder leg starts under the key "login-form"
    Then the context the subagent-start hook emits for the new builder says its predecessor ended without a checkpoint, names its predecessor's lane, and names checkpoint number 3 as the one in effect

  @D334 @D314
  Scenario: a leg whose start was dropped stops unasked and its summary still lands
    Given a builder leg whose start was dropped at an unreachable store, with a capture-gap marker at its start
    When the builder stops with no checkpoint written, the store now writable
    Then the subagent-stop hook's output does not block the stop
    And the store holds the builder's summary row and no registration for it
