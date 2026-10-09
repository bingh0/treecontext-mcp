Feature: role-weighted FTS — migration and contentless-index integrity

  nodes_fts grows from one content column to four role columns
  (user_text, assistant_text, tool_text, note_text). The index is
  derived data: the migration's promise is findability equivalence and
  atomicity, NOT ranking equivalence (FTS5 statistics are row-global
  and length normalization is row-global — pinned in
  tests/flat-store-role-weights.feature, whose D1 scenario measures it).
  Column attribution is immutable and persisted
  (index_col) because contentless deletes must replay the exact
  original text into the exact original column.
  Footguns: FG-1..FG-10.

  Scenario: migration rebuilds a legacy index and every old row stays findable
    Given a legacy store with plain, compressed, capture and note rows indexed single-column
    When the store is opened with the role-weighted schema version
    Then each row matches via its attributed column and index_col is backfilled

  Scenario: migration is atomic — a mid-rebuild failure leaves the legacy index intact
    Given a legacy store and a rebuild that fails partway
    When the failed migration is rolled back
    Then queries against the legacy index still return every row

  Scenario: the rebuild runs exactly once
    Given a store already migrated to the role-weighted schema
    When it is opened again
    Then the version stamp is unchanged and no rebuild occurs

  Scenario: insert routes content to exactly one column by role attribution
    Given nodes for a user message, an assistant response, a tool event and an agent note
    When they are inserted
    Then each is findable via exactly its attributed column and no other

  Scenario: metadata edits between insert and delete do not corrupt the index
    Given an inserted capture node whose metadata is later rewritten by supersede, demotion, and the export reliance bump
    When the node is deleted
    Then the FTS index holds no ghost entry for it in any column
    # The enumeration is the load-bearing part (staleness repair
    # 2026-08-12: the reliance bump — exportJson's _relied_count
    # json_set — was a shipped metadata rewriter missing from it). The
    # invariant that makes ALL of them safe, previously unstated:
    # contentless deletes replay index text from the PERSISTED index_col
    # and stored boundaries, so a metadata rewrite is harmless exactly
    # because _relied_count, supersession flags, and demotion markers
    # feed neither indexTextFor nor attributeColumn. Any future metadata
    # writer that touches role, tool_name, or the boundary keys breaks
    # this scenario — that is what it is for.

  Scenario: delete and update round-trip cleanly for compressed rows
    Given a compressed node whose index text is a prefix of its content
    When it is updated and then deleted
    Then no stale text matches and the updated text matched while it lived

  Scenario: an omitted trailing weight silently means one point zero
    # Engine-property scenario (owner-ruled design tier 2026-08-24):
    # deliberately product-free — the observable is FTS5's omitted-weight
    # default, the reason the query helper must always pass all four.
    Given a four-column index and a bm25 call passing only three weights
    When the engine ranks a note-column match
    Then the note column scores at full weight, pinning why the helper must always pass all four

  Scenario: a query naming a column is not a column filter
    Given a row whose user text contains the literal phrase assistant_text colon term
    When the escaped match query built from that phrase runs
    Then it matches as literal tokens and applies no column restriction

  Scenario: role weights are validated at the query surface
    Given weight inputs below zero and above ten
    When a query is attempted
    Then the weights are rejected before reaching bm25

  Scenario: summaries remain unindexed across the migration
    Given a node with distinctive summary text absent from its content
    When the store is migrated and queried for the summary text
    Then nothing matches, before and after
