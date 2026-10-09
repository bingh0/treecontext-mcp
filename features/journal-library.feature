Feature: Journal library — the store is a library first, a server second

  The MCP server is one consumer of the journal, not its gatekeeper. Any
  Node program that can open the SQLite file gets the same journal through
  the library API: same inserts, same search, same export. No server
  process, no network, no model download — and no Claude Code either: the
  capture surface accepts platform events, and Claude Code is the
  reference platform, not the boundary.

  Charter detail (f): library API usable without the MCP server.

  @D7
  Scenario: a plain Node program journals without any server
    Given a program that imports the library and opens a store on a database file
    And no MCP server is running
    When it inserts an entry and queries for its words
    Then the entry is found and exported intact

  @D7
  Scenario: library and server read the same truth
    Given entries written through the library API
    When the MCP server opens the same database file
    Then the server's query results match the library's for the same query and knobs
    # "Same truth" means same rows and same ranking under the SAME KNOBS
    # — the MCP surface serves a recency-fused default (ruling 2026-08-01;
    # search-modes preamble) that the library does not, so a
    # defaults-to-defaults comparison is comparing different questions.
    # Binding rule (staleness repair 2026-08-12): the corpus must be one
    # recency fusion DEMONSTRABLY reorders, the surface default shown to
    # reorder it (the discriminating control), and exact-equality parity
    # asserted with the knobs equalized — parity proven exactly where
    # divergence would show, not by fixture luck on same-aged rows.

  @D7
  Scenario: a reader can watch a live store without stopping the writer
    Given the MCP server holding a store open
    When a library consumer opens the same file read-only
    Then committed entries are readable while the server keeps writing

  @D7
  Scenario: the whole journal exports through the tool surface
    Given a populated journal
    When export is called with no node id and the whole journal chosen, its secrets warning acknowledged
    Then portable JSON of the whole journal returns, bounded by the export node cap
    And importing it elsewhere reproduces the entries verbatim

  @D7
  Scenario: exports are portable across consumers
    Given an export produced through the library API
    When another store imports it through the MCP server
    Then the imported session reads back verbatim

  @D7
  Scenario: an import larger than the size guardrail is refused whole
    Given a journal holding one entry
    And an import payload just over the size guardrail
    When the payload is imported through the library API
    Then the import is refused with an error naming the size limit
    And the journal still holds exactly its one entry
    # The guardrails are frozen contract — 5 MB of JSON, 10,000 nodes —
    # and refusal precedes every write: import runs in one transaction
    # (round-2 R2), so a refused import is never a partial one.

  @D7
  Scenario: an import holding more nodes than the count guardrail is refused whole
    Given a journal holding one entry
    And an import payload holding one node more than the count guardrail
    When the payload is imported through the library API
    Then the import is refused with an error naming the node limit
    And the journal still holds exactly its one entry

  @D16
  Scenario: events from any platform journal identically
    Given events staged through the library's capture surface rather than Claude Code hooks
    When ingestion drains them
    Then the resulting entries match hook-captured ones in role, capture time, and searchable text
    # Pointer from the capture spec (owner comment 1, 2026-07-17): the
    # platform-independent capture surface lives HERE; journal-capture
    # pins concrete payloads on the reference platform.

  @D4
  Scenario: closing the store loses nothing that was written
    Given entries inserted through the library
    When the store is closed and reopened
    Then every entry written before close is present after reopen

  @D16
  Scenario: closing the store loses nothing that was staged
    Given events staged but not yet ingested when the store closes
    When the store is reopened
    Then the staged events drain into the journal on the next ingestion
    # Written and staged are different promises with different failure
    # modes — a close that flushed entries but dropped the staging backlog
    # would pass the scenario above while losing captures. Staging
    # durability across PROCESSES is journal-storage's concern; this pins
    # it across a clean close.
