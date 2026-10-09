Feature: conversation_window — read-time neighbor expansion around lexical hits

  W1-W9: a window is a read-time expansion, never a ranking change.
  Each hit optionally carries up to
  `n` same-session neighbors before/after (chronological, W3) plus the
  W9 anchor (nearest preceding user message in-session). Session is the
  page boundary (W2); overlap is deduplicated per reply, hits win, and a
  contested neighbor goes to whichever hit comes FIRST IN THE RETURNED
  ORDERING (W7) — under the default relevance sort that IS the
  higher-ranked hit; under an explicit chronological sort it is the
  earlier one, because allocation walks the reply as returned.
  (Wording corrected 2026-07-31, round-2 R7: the file previously said
  "ties go to the higher-ranked hit" unconditionally, which is false under
  chronological sort; the fixture passed only because its two hits tied.)
  Neighbors are truncated at 700
  chars, the anchor at 2000 (W5/W9); hits are never truncated. LIBRARY
  semantics: the option omitted = off (explicit-args API; the
  byte-identical scenario below). The shipped PRODUCT default lives at
  the MCP layer and is 2 as of the 2026-07-05 spec amendment (recorded
  in server/query-window-default.feature, retired 2026-07-25 per the
  tests/journal/README register) — EW2's tight-budget verdict governs
  the documented opt-out (set 0, raise top_k), not the default.

  Scenario: window 2 on a 7-entry session returns 2 before and 2 after, chronologically
    Given a 7-entry single session with a query hit on the middle entry
    When queried with conversation_window 2
    Then the hit's window has 2 before entries and 2 after entries in chronological order

  Scenario: the first entry of a session has no cross-session bleed
    Given a hit on the first entry of its session, preceded only by a different session's entries
    When queried with conversation_window 2
    Then the window has 0 before entries and no entries from the other session

  Scenario: interleaved sessions never bleed into each other's window
    Given two sessions interleaved in created_at with a hit in one of them
    When queried with conversation_window 3
    Then every window entry belongs to the hit's own session even though the other session's entries are closer in time

  Scenario: a hit with no session key gets an omitted, empty window
    Given a hit whose metadata carries none of session_id, _cc_session_id, or _session_id
    When queried with conversation_window 2
    Then window.omitted is "no-session-key" and both before and after are empty
    # Staleness repair 2026-08-12: the session KEY is the three-way
    # COALESCE (session_id, _cc_session_id, _session_id) since the
    # session-identity fix and migration 015 — this Given named only the
    # original two, so a row carrying only _cc_session_id would have
    # satisfied the old wording while windowing normally.

  Scenario: a hit is never duplicated as its own neighbor
    Given a session where the query matches an entry that is also adjacent to itself in time
    When queried with conversation_window 3
    Then the hit's own nodeId never appears in its before or after arrays

  Scenario: two hits one apart produce disjoint neighbor sets, first-claim to the first-returned hit
    Given two hits one entry apart in the same session and conversation_window 3
    When the query runs under relevance ordering
    Then the shared entry between them appears in only the stronger hit's window and never in both
    And the same query under chronological ordering gives it to the earlier hit instead
    # Both orderings asserted (round-2 R7): with only the chronological
    # case bound, "higher-ranked" and "first-returned" were
    # indistinguishable — the fixture's two hits tied lexically.

  Scenario: a returned hit is never also another hit's neighbor
    Given two hits close enough that each falls inside the other's window
    When the query runs with a conversation window
    Then neither hit appears in the other's before or after
    # W7's "hits win" half. Implemented since the window landed, bound
    # only at round-2 R7: deleting the pre-claim of hit rowids left every
    # scenario in this file green.

  Scenario: a neighbor over 700 chars is truncated but the hit itself never is
    Given a session containing one neighbor entry longer than 700 characters and a hit with a longer body
    When queried with conversation_window 2
    Then the neighbor is head-truncated with a truncation marker and truncated true, and the hit content is returned in full untruncated

  Scenario: created_at ties are broken by rowid
    Given a capture-burst session where several entries share one created_at timestamp
    When queried with conversation_window 2
    Then the window orders the tied entries by insertion (rowid) order

  Scenario: window 0 is byte-identical to today's results
    Given a session and a query that produces hits
    When queried once with conversation_window 0 and once with conversation_window omitted
    Then both results are byte-identical and neither carries a window field

  Scenario: the anchor recovers the nearest preceding user message
    Given a session with a user directive followed by a deep burst of non-user entries
    When a hit deep in the burst is queried with conversation_window 1
    Then the hit's anchor is the nearest preceding user message in its session

  Scenario: an oversized anchor is truncated at its own larger bound
    Given a session whose nearest preceding user message is longer than the anchor bound
    When a later entry is queried with a conversation window
    Then the anchor is truncated at the anchor bound, not the neighbor bound
    # W5/W9 use DIFFERENT bounds (700 neighbors, 2000 anchor) and only the
    # neighbor one was pinned — the anchor bound could regress to 700 or to
    # unbounded green (round-2 R11).

  Scenario: a hit that is itself a user message has no anchor
    Given a hit whose own entry has role user
    When queried with conversation_window 1
    Then the hit's anchor is null

  Scenario: an anchor already present in the reply is referenced, not duplicated
    Given a hit whose nearest preceding user message already appears in its own before-window
    When queried with conversation_window 5
    Then the anchor is a ref to that nodeId instead of a duplicated entry

  Scenario: the anchor is drawn only from the hit's own session
    Given a hit whose session has no preceding user message, but an earlier different session does
    When queried with conversation_window 2
    Then the hit's anchor is null

  Scenario: the MCP conversation_window parameter reaches the FlatStore query path end-to-end
    Given a server over a lexical store with a multi-entry session fixture
    When treecontext_query is called with conversation_window 2
    Then the response results carry a window with before/after entries
