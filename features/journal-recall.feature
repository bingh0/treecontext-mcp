Feature: Journal recall — a cold-started agent recovers prior context

  This is the product. After a cold start or a context clear, an agent
  with zero conversational memory must re-orient from the journal alone:
  what was I working on, what was decided, what comes next. Recall beats
  compaction when it surfaces the branching detail compaction destroys —
  rejected paths, tangents, exact prior findings — without rewriting the
  prompt prefix and voiding the cache.

  Charter: elevator pitch (cold-start recall, compaction avoidance,
  prompt-cache economics), detail (e) single-author session structure —
  time, turn sequence, and role are ranking signals, not just filters.

  @D2
  Scenario: a cold-started agent finds the active plan without knowing any IDs
    Given a prior session tagged a plan node with next_session true
    When a new session calls status
    Then the plan appears as a resume pointer with a preview
    And exporting the pointer's node id returns the full plan text

  @D56
  Scenario: a broad "what was I working on" query surfaces the latest thread
    Given several sessions of journaled work on distinct topics
    When the agent queries "what was I working on, what was the next step"
    Then the most recent active thread ranks above older completed ones

  @D6
  Scenario: a keyword recalls the exact prior finding, not a paraphrase
    Given a prior session recorded a specific finding naming a symbol or file
    When a later session searches for that identifier
    Then the original entry is a top result with its content intact

  @D6
  Scenario: a hit can be read in its conversational context
    Given a query hit from the middle of a prior session
    When the query requests a conversation window
    Then the surrounding entries from the same session accompany the hit in order
    And the nearest preceding user message is attached as the anchor

  @D6
  Scenario: temporal questions get temporal answers
    Given work journaled across multiple days
    When the agent queries with a time range and chronological ordering
    Then results are the entries from that window, oldest first

  @D47
  Scenario: a hit on conversational text returns the whole message
    Given a user message whose final sentence is a critical "never do X" directive
    And a long curated note whose final line records the decision it exists for
    When any part of either matches a query
    Then each full text is returned with no truncation
    # Conversational roles (user, assistant, note) are sacred: lowest volume,
    # highest authority, and a preview-plus-marker design would bet on the
    # reading agent bothering to export — a bet agents demonstrably lose.
    # The note clause is deliberate: notes are the distilled decisions,
    # the role where truncation would hurt most.

  @D4
  Scenario: a hit on an oversized tool event returns a preview with an honest marker
    Given a tool event whose full content exceeds the preview bound
    When it appears in query results
    Then the preview ends with an availability marker naming the export escape hatch
    And export of that node returns the full content byte-for-byte

  @D47
  Scenario: a very long conversational message is findable by any of its words
    Given a user message far beyond the old index caps, with a pasted log in the middle
    And a closing directive in its final sentence
    When a later session searches for words from that directive
    Then the message is a hit, returned in full
    And words appearing only inside the pasted middle also find it
    # Ruled by measurement (2026-07-28 cap sweep): the old 2000/4000-char
    # prose prefixes cost up to 14 points of recall, and head-plus-tail
    # beat full only at budgets the product no longer uses. Authored text
    # indexes in full; the paste comes along — BM25 term saturation, not
    # exclusion, is what keeps pasted bulk from dominating ranking.

  @D47
  Scenario: bounding the indexed view is a configuration choice, not the default
    Given a store whose operator capped new captures with the index-cap variable
    When text longer than the cap is captured
    Then words beyond the cap in newly captured text do not match a search on their own
    And entries captured before the cap was set keep their original searchable view
    And a cap below the measured floor is ignored rather than obeyed
    # The inverse of the pre-expansion draft: full indexing IS the default;
    # TREECONTEXT_INDEX_CAP is the narrowing lever for stores where
    # retrieval is slow. It bounds what NEW captures index, never what they
    # store, and never rewrites history. The floor (300) exists because
    # retrieval measurably collapses below it (bench: −22 points on
    # LongMemEval-S).

  @D4
  Scenario: a tool event's searchable reach extends past its displayed preview
    Given a tool event whose indexed view reaches beyond its display preview
    When a query matches words that sit past the preview but inside the indexed view
    Then the event is a hit
    And the hit's content still ends at the display preview with the availability marker
    # The index-cap expansion widened what a tool event exposes to search
    # (up to 8000 chars of preview plus tail) without widening what a hit
    # pays into the reader's context: the display cut and the searchable
    # boundary are separate numbers.

  @D2
  Scenario: retrieval performance is observable where the agent can act on it
    Given a session that has run queries against a store
    When the agent calls status
    Then the response reports the store size and this session's query latency
    And persistently slow queries produce a hint naming the index-cap lever

  @D6
  Scenario: temporal questions can read newest first
    Given work journaled across multiple days
    When the agent queries with reverse chronological ordering
    Then results are the matching entries, newest first

  @D2
  Scenario: a metadata filter narrows recall to matching entries only
    Given entries carrying distinct metadata key-value pairs
    When a query passes a metadata filter requiring two pairs
    Then only entries carrying both pairs are returned
    And the same query without the filter also surfaces the others

  @D2
  Scenario: superseding a missing id succeeds and names the miss
    Given a live plan from a prior session
    When a close-out is inserted with supersedes naming that plan and one nonexistent id
    Then the live plan stops being a resume pointer
    And the insert succeeds with the missing id reported, not silently dropped

  @D2
  Scenario: superseded plans stop appearing as live pointers
    Given a new close-out inserted with supersedes listing the old plan
    When the next session calls status
    Then the old plan is no longer a resume pointer
    But it remains fully queryable as history

  @D5
  Scenario: recall needs no embedding model
    Given a store on a machine with no ONNX runtime or model download
    When an agent inserts an entry and queries for its words
    Then the entry is stored, found by BM25, and exported intact
    And status reports the store as lexical with no degraded-mode warning

  @D2
  Scenario: the orientation surface stays small enough to be read
    Given a store with dozens of accumulated resume pointers
    When a session calls status
    Then only the newest bounded set is shown with an explicit count of the hidden rest
