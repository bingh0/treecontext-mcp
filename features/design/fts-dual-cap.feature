Feature: C2 — dual caps, index text != stored content, FTS recompute

  indexTextFor derives a bounded FTS-index view from decoded content plus a
  node's metadata. Because nodes_fts is a contentless FTS5 table, delete and
  update must recompute the exact original indexed text from (decoded
  content, parsed metadata) rather than the raw stored content — the
  highest-risk part of this change.

  Scenario: insert then delete leaves the FTS index empty for a plain row
    Given an auto-capture user node with short content inserted
    When the node is deleted
    Then a query for its content returns no hits

  Scenario: insert then delete leaves the FTS index empty for a compressed row
    Given an auto-capture assistant node with zstd-sized content inserted
    When the node is deleted
    Then a query for its content returns no hits

  Scenario: insert then delete leaves the FTS index empty when the index text is a proper prefix of content
    Given an auto-capture user node whose content exceeds the user index cap, inserted
    And the within-cap token matches before deletion
    When the node is deleted
    Then a query for the within-cap token returns no hits
    And a query for the beyond-cap token also returns no hits

  Scenario: insert then update keeps the FTS index in sync
    Given an auto-capture assistant node inserted with an initial unique token
    When the node is updated to new content with a different unique token
    Then a query for the old token returns no hits
    And a query for the new token returns the updated node

  Scenario: a marker-less legacy row recomputes from the frozen 2000-char cap
    Given an auto-capture user node without an index marker, with a marker within the frozen 2000-char legacy cap and a marker past it
    When it is inserted and indexed
    Then a query for the within-cap marker returns the node
    And a query for the beyond-cap marker returns no hits
    # Rows without _index_len are pre-expansion captures: their view
    # recomputes from the FROZEN legacy constants. Post-expansion captures
    # stamp their own boundary and index prose in full — pinned in
    # tests/hooks/index-cap-expansion.test.ts.

  Scenario: a marker-less prose assistant row recomputes from the frozen 4000-char cap
    Given an auto-capture assistant node without an index marker or tool name, with a marker within the frozen 4000-char legacy cap and a marker past it
    When it is inserted and indexed
    Then a query for the within-cap marker returns the node
    And a query for the beyond-cap marker returns no hits
    # INDEX_CAP_ASSISTANT — the assistant twin of the 2000-char user cap
    # above — is a FROZEN legacy-recompute constant: marker-less rows
    # (pre-016 producers) index by it forever. It was pinned by zero
    # tests repo-wide (corpus audit); changing it would silently ghost
    # or grow FTS entries for every legacy assistant row.

  Scenario: FlatStore query hits return the full decoded content, never truncated by the index cap
    Given a FlatStore with an auto-capture user node whose content exceeds the index cap
    When querying for a term near the start of the content
    Then the returned hit's content is the full original content, not the truncated index text
