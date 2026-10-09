Feature: Orchestration inside one store — lanes that stay their own

  The store is a flat, decentralised set of lanes, like git: the main
  lane and every derivative, a subagent, a worktree, a teammate's
  machine. Nothing is edited in place. Any writer may append into any
  lane so long as the row names its writer and what it refers to; nothing
  outside the writer's own lane is modified; a cross-lane reference is a
  pointer the owning lane sees, never a flag flip. Self is recovered from
  where a session runs, not from its process, so a stopped worktree
  resumes its own thread. Namespaces stay the process-level boundary
  (D196); lanes are metadata inside them.

  Rulings D147, D148, D150, D167, D169, D186, D190 of the hackathon
  interview, 2026-10-05 to 2026-10-07. Group orientation (D168) is
  deferred with groups configuration (D209) and carries no scenario yet.

  @D147
  Scenario: the orchestrator finds the subagent's summary by search
    Given an orchestrating session that spawned a subagent in the role "tester"
    And the tester made 40 tool calls and reported "12 tests pass, CSRF fails; next: refresh the token"
    When the tester finishes
    Then the orchestrator searching "CSRF" finds that report marked as the tester subagent's summary

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

  @D190
  Scenario: the session-start hook registers self and the server stamps rows from it
    Given a session starting in the worktree "feature-login" on the branch "login-form"
    When the session-start hook fires
    Then the store holds a registration of that session whose worktree and branch equal what git reports for that directory
    And a chapter summary written through the tools from that session is stamped with "feature-login"

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

  @D186
  Scenario: references resolve one hop deep, the rest on request
    Given an entry A, an entry B that names A, and an entry C that names B
    When the orchestrator searches and hits A
    Then the orchestrator sees A referenced by B with B's writer, age and first line, and a count of 1
    And the orchestrator does not see C until it fetches B by id
