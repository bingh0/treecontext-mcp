Feature: dedup matrix — time-bounded for auto-capture, global for curated, never cross-source

  Global-forever content dedup swallows every recurrence of an identical
  message: the second "proceed" a user ever types inserts nothing and its
  session, timestamp and metadata are discarded, corrupting chronology and
  window/anchor reconstruction. Owner decision D2: auto-capture dedups only
  within DEDUP_WINDOW_SECS (which still suppresses Stop-hook double-fire);
  curated notes keep global idempotent dedup; the two classes never dedup
  against each other.
  Footguns: JF-4, JF-11.

  Scenario: a repeated user directive outside the window becomes its own node
    Given an auto-captured user message and an identical one twenty minutes later
    When both are inserted with their capture timestamps
    Then two nodes exist, each with its own session and capture time

  Scenario: Stop-hook double-fire inside the window still dedups
    Given an auto-captured assistant response staged twice seconds apart
    When both are inserted
    Then one node exists and the second insert reports deduplicated

  Scenario: the dedup window slides with the newest occurrence
    Given three identical auto-captured messages each spaced just inside the window of the previous
    When all are inserted in order
    Then one node exists, pinning that the window anchors to the most recent occurrence

  Scenario: identical content from another session inside the window is a distinct event
    Given an auto-captured message and an identical one from a different session seconds later
    When both are inserted
    Then two nodes exist, one per session timeline

  Scenario: dedup compares capture timestamps, not drain time
    Given two identical auto-captured messages captured hours apart while the server was off
    When a backlog drain inserts both within the same second
    Then two nodes exist, pinning that wall clock at drain time plays no part

  Scenario: curated notes keep global idempotent dedup across sessions
    Given an agent-authored note and an identical insert in a later session
    When both are inserted
    Then one node exists and the second insert reports deduplicated

  Scenario: a curated insert never dedups onto an auto-capture node
    Given an auto-captured row and a later curated insert with identical content
    When the curated insert runs
    Then a new curated node exists distinct from the evictable auto-capture row

  Scenario: anchors resolve to the current occurrence, not a stale first one
    Given a user directive repeated across two sessions outside the dedup window
    When a query hit from the second session requests its window anchor
    Then the anchor is the second session's occurrence

  Scenario: the fingerprint map rebuilds its dedup classes on reopen
    Given a store containing auto-capture and curated rows with known fingerprints
    When the store is closed and reopened
    Then time-bounded and global dedup behave identically to before the reopen

  Scenario: a dedup hit re-arms resume-pointer tags on the surviving note
    Given a curated note whose resume-pointer tags were superseded away
    When the same content is recorded again with next_session set
    Then no new node is created and the original carries the pointer tags again
    # Re-recording a fact with next_session/active is how an agent
    # re-arms an old note as a pointer — a dedup hit must merge those
    # tags onto the survivor, never silently discard them (post-G, the
    # merge rides the same transaction as the refused insert).
