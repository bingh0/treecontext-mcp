Feature: ingestion fidelity — honest timestamps, drain-all backlog with tombstones, poison dead-letter

  Three ingestion footguns make the journal lie about what happened and
  when: capture timestamps are discarded (nodes get drain time), a backlog
  over 200 rows is silently mass-dropped (sessions run while the server is
  off simply vanish), and a deterministically-failing staging row is
  retried forever (twenty of them wedge the drain permanently). Owner
  decision D3: drain everything, honestly timestamped; only a byte-based
  safety valve may drop, oldest whole sessions first, and every drop or
  dead-letter leaves a protected tombstone so the journal records its own
  holes.
  Footguns: JF-5, JF-6, JF-7.

  Scenario: nodes carry capture time, not drain time
    Given staged rows captured hours before the server started
    When the ingestion loop drains them
    Then each node's created_at and metadata created_at equal the hook's capture timestamp
    And metadata ingested_at records the drain time

  Scenario: a backlog drain preserves intra-session chronology
    Given a multi-hour staging backlog from one session
    When it is drained in batches
    Then chronological queries and conversation windows order the entries by capture time

  Scenario: a large backlog drains completely with no row-count drop
    Given more than a thousand unprocessed staging rows across several sessions
    When the ingestion loop runs to quiescence
    Then every row is ingested or dead-lettered and none is dropped for count reasons

  Scenario: the byte valve drops oldest whole sessions and leaves one tombstone each
    Given unprocessed staging exceeding the byte safety valve across many sessions
    When the valve trips
    Then only the oldest whole sessions are dropped, never part of one
    And each dropped session yields one capture-gap node naming its session, row count and time span

  Scenario: the newest session is never dropped, even when it alone exceeds the valve
    Given a single live session whose staged bytes exceed the byte valve
    When the valve trips
    Then nothing is dropped and every capture drains into the journal
    # The live capture stream outranks the byte budget: the valve exists
    # for months-old pathology, and a session currently speaking is never
    # the pathology. It logs the overage and waits.

  Scenario: a session whose tombstone cannot be written is not dropped
    Given sessions exceeding the valve and a store that refuses capture-gap inserts
    When the valve trips
    Then the refused session stays staged in full for a later tick
    And once the refusal clears, the drop happens with its tombstone in place
    # Tombstone FIRST, drop SECOND, always: a permanent unrecorded hole
    # is worse than staying over the valve for another tick.

  Scenario: tombstones outlive retention
    Given a capture-gap tombstone older than every retained session
    When retention sweeps run
    Then the tombstone survives, pinning that gap records are never evicted

  Scenario: a rescued old session is still honestly subject to retention
    Given a backlog-drained session genuinely older than the hundred newest sessions
    When the next retention sweep runs
    Then the session's rows are evicted as any old session's would be
    And this is pinned as intended: retention is a recency policy and rescue is not resurrection

  Scenario: a malformed recovery snapshot is dead-lettered, never silently dropped
    Given a staging row claiming to be a recovery snapshot whose content is not valid JSON
    When the drain processes it
    Then the row is retired and a capture-gap node records the drop
    And the capture-gap node names the malformed snapshot without embedding it whole
    # Corpus audit D2 (2026-08-12): this path used to mark the row
    # processed with only a stderr line — a hole the journal never
    # recorded, against this feature's own "every drop or dead-letter
    # leaves a protected tombstone."

  Scenario: a poison row dead-letters after three attempts instead of wedging the drain
    Given a staging row whose insert fails deterministically
    When three drain ticks pass
    Then the row is marked processed and a capture-gap node records the failure
    And subsequent ticks ingest fresh rows normally

  Scenario: a batch full of poison rows self-heals
    Given more deterministically-failing rows than one batch holds
    When drain ticks continue
    Then within three ticks per batch the drain resumes ingesting healthy rows

  Scenario: a dead-letter node never embeds the poison payload
    Given a failing staging row carrying a quarter-megabyte of content
    When it dead-letters
    Then the capture-gap node carries the error and at most a short content prefix
