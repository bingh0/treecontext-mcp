Feature: Echo-correlated session identity — the store's own capture attributes its curated writes

  The capture pipeline echoes every treecontext tool call back into
  staging with the hook's session id, and the echo's output names the
  curated row the call touched. The drain correlates each echo with
  that row and upgrades its attribution to exact, causal identity. A
  missing echo degrades to the insert-time ladder; it never invents an
  id.

  @D86
  Scenario: a curated insert unresolved at write time is healed by its own echo
    Given a curated insert whose ladder resolution came up absent
    And the hook's echo of that insert sits in staging
    When the drain runs
    Then the row carries the echo's session id with source "echo"
    And the row's session-key column agrees with the healed metadata

  @D86
  Scenario: an export taken before the drain shows the pre-heal state honestly
    Given a curated insert awaiting its echo
    When the journal is exported before the drain runs
    Then the exported row shows the provisional attribution
    And the same export after the drain shows the echo attribution

  @D86
  Scenario: the echo outranks a freshest-beacon guess that disagrees
    Given a curated row the ladder attributed by beacon unanimity
    And an in-window echo naming a different session
    When the drain runs
    Then the row carries the echo's session id with the displaced guess preserved in the trace field

  @D86
  Scenario: an exact insert-time attribution is never overwritten
    Given a curated row attributed by an explicit client header
    And an in-window echo naming a different session
    When the drain runs
    Then the row's attribution and source are unchanged

  @D86
  Scenario: a dedup-hit echo cannot re-stamp the older original
    Given an old attributed curated row
    And a new identical insert from another session that deduplicated onto it
    When the drain processes the new insert's echo
    Then the old row's attribution and session-key column are unchanged

  @D86
  Scenario: identical concurrent inserts from two sessions disclose their ambiguity
    Given two sessions that insert identical content within one correlation window
    And curated dedup collapsed them to a single row
    When the drain processes both echoes
    Then the row is flagged ambiguous with both session ids as candidates

  @D86
  Scenario: a capture-disabled server's inserts keep their ladder attribution
    Given a server with capture off whose insert resolved by beacon unanimity
    When the drain runs with no echo present
    Then the row keeps the beacon attribution unchanged
    And no session id is invented

  @D86
  Scenario: an echo stranded by a crash heals the row on the next start
    Given a curated insert whose echo was staged but the server died before draining
    When a new server opens the store and its drain runs
    Then the row carries the echo's session id with source "echo"

  @D86
  Scenario: an insert whose input overflows the echo preview still correlates
    Given a curated insert long enough that its echo truncates the input preview
    When the drain runs
    Then the row carries the echo's session id with source "echo"

  @D86
  Scenario: a failed insert's echo heals nothing
    Given a rejected insert whose echo carries only the error payload
    When the drain runs
    Then no curated row gains an attribution from that echo
