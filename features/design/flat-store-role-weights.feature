Feature: FlatStore role-weighted ranking surface

  The lexical query path ranks with bm25(nodes_fts, wUser, wAssistant,
  wTool, wNote), defaults {1.0, 0.25, 1.0, 1.0} — assistant down-weight
  per the two-corpus evidence (weighted-arm ledger); tool/note untested
  and deliberately 1.0. Weight zero is NOT omission: rows stay matchable
  through zero-weighted columns (row-global statistics, pinned in
  the D1 scenario below, which measures the engine directly).
  (Staleness repair 2026-08-12: this preamble once carved out the
  tree/hybrid backends; those left with the tree era's deletion phase,
  2026-07-25 — the flat lexical path below is the only ranking surface
  that ships.)

  Scenario: default weights rank a user-column match above an equal assistant-column match
    Given two nodes matching the query equally, one via user text and one via assistant text
    When queried with default weights
    Then the user-text node ranks first

  Scenario: a roleWeights override changes the ranking monotonically
    Given the same two nodes
    When queried with the assistant weight raised above the user weight
    Then the assistant-text node overtakes

  Scenario: all-ones weights reproduce the legacy single-column ranking exactly
    Given a fixture corpus split across the 4 role columns per production's exclusive attribution rule
    When ranked multi-column with all-ones weights and compared to a single-column control over the same effective text
    Then the orderings and raw scores are identical, correcting FG-1's all-ones-vs-legacy claim (see spec Deviation Log D1)

  Scenario: weight zero still returns assistant-only matches, ranked last
    Given a node matching only via assistant text among user-text matches
    When queried with assistant weight zero
    Then the node appears after every user-text match instead of disappearing

  Scenario: the MCP role_weights parameter reaches the ranking
    Given a server over a lexical store with the two-node fixture
    When treecontext_query passes role_weights favoring assistant text
    Then the result order reflects the override
