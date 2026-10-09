Feature: C3 — retention: demote, then delete (FlatStore)

  Once the store's byte budget is exceeded, the retention sweep demotes
  non-protected auto-capture rows by replacing their stored content with
  the row's demotion floor — tool bulk before conversational prose,
  oldest-first within each class — before ever considering deletion at
  the far session/entry horizons. Deletion ORDER at those horizons is
  journal-storage's contract, not this file's: reliance-weighted since
  the 2026-07-23 ruling ("frequently relied-on history evicts last"),
  with oldest-first only as the zero-reliance baseline. Demotion never touches protected rows,
  and it never destroys: the full victim rows are written to a demotion
  archive (export format, fsynced) before the first shrink commits, each
  demoted row records its pre-demotion length and archive path, and hits
  on a demoted row carry a marker advertising the loss. Without an
  archive destination the sweep refuses to demote at all — the same rule
  eviction follows. For pre-expansion rows the FTS index never covered
  the truncated tail, so findability is unchanged; for post-018 rows,
  whose index view is wider than the demotion floor, findability narrows
  to that floor and the tail stays recoverable from the archive.
  (Ruled 2026-07-31: journal-storage's "only an explicit command
  destroys content" governs demotion too, not just eviction.)

  Scenario: a demoted pre-expansion row is query-findable exactly as before demotion
    Given a legacy-shape auto-capture user node whose content exceeds the index cap, with a tiny store-byte budget
    When the retention sweep runs
    Then the node's content now equals its index text and is flagged demoted
    And a query for a term within the index cap still finds the same node
    And a query for a term beyond the index cap misses, exactly as it did before demotion
    And the full pre-demotion content is recoverable from the demotion archive

  Scenario: a demoted full-view row narrows to the floor but its tail survives the shrink
    Given a full-view auto-capture user node findable by a term beyond the demotion floor, with a tiny store-byte budget
    When the retention sweep runs
    Then a query for the beyond-floor term no longer finds the node
    And a hit on the demoted node carries a marker naming the pre-demotion length and archive path
    And the full pre-demotion content is recoverable from the demotion archive

  Scenario: importing the demotion archive restores a stump to the full row
    Given a demoted full-view row whose tail lives only in the demotion archive
    When the archive file is imported back into the store
    Then the row holds its full pre-demotion content and the beyond-floor term finds it again
    And a second import of the same archive restores nothing further
    # Ruled 2026-07-31 (replace-when-stump): an id collision where the
    # resident row is a demoted stump and the incoming row is longer
    # RESTORES the full row — this is the archive's whole recovery path,
    # promised by every "recoverable from the archive" clause above.
    # Every other id collision is skipped, keeping import idempotent —
    # which is exactly what the second import proves.

  Scenario: demotion refuses when there is no archive destination
    Given an over-budget in-memory store with no archive destination
    When the retention sweep runs
    Then no row is demoted and every row's content is intact

  Scenario: a row whose demotion floor is empty is never demoted
    Given an over-budget store whose only candidate has a zero-length display floor
    When the retention sweep runs
    Then the row keeps its full content and stays findable
    # A zero-length stump would leave the row unfindable forever and
    # silently dropped by any archive restore (round-2 R11). The sweep
    # proves the row unshrinkable and leaves it whole — staying over
    # budget is a state the valve reports; an unfindable row is a loss.

  Scenario: a row whose shrink would reclaim nothing is left intact
    Given an over-budget store whose only candidate stores smaller compressed than its raw stump
    When the retention sweep runs
    Then the row is not demoted and its stored form is unchanged
    # Savings are priced against the ENCODED stump (round-2 R4): this
    # row's compressed full form is smaller than the raw sub-floor stump
    # demotion would write, so shrinking it would GROW the store. The
    # sweep proves it unshrinkable instead of demoting for a negative
    # return.

  Scenario: tool bulk demotes before conversational prose
    Given an over-budget store where demoting its newer tool bulk alone satisfies the budget, alongside older prose
    When the retention sweep runs
    Then the tool row is demoted and the older prose row is untouched

  Scenario: demotion never touches protected rows even when they are the oldest
    Given an oldest protected authored node and a newer non-protected auto-capture node, both oversized, with a tiny store-byte budget
    When the retention sweep runs
    Then the protected node's content is untouched
    And the non-protected node's content is demoted

  Scenario: deletion at the far horizons still happens exactly as before, ahead of demotion
    Given an entry-count-capped store with old and new auto-capture sessions and a tiny store-byte budget
    When the retention sweep runs
    Then the oldest session is hard-deleted as usual
    And the surviving oversized node is demoted in the same sweep
    # "Oldest ... as usual" is the zero-reliance baseline this world
    # constructs (no exports have touched either session); the eviction
    # ORDER itself belongs to journal-storage — this file pins that the
    # demote-then-delete pipeline still fires both stages in one sweep,
    # not which session goes first when reliance reorders.
