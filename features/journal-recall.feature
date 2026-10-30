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
    # Since the beta.2 cut its binding seeds the mature journal (D266):
    # the latest thread must still win with tool text at a tenth of the weight.

  @D260
  Scenario: the developer's directives and the agent's notes outrank captured tool output
    Given a mature journal where captured tool output, echoes of earlier orientation queries among it, outnumbers the curated notes many times over and matches the query's own words
    When the agent queries "what was I working on, what was the next step"
    Then a developer turn or a curated note is the first result
    And no echo of an earlier orientation query is among the first five results
    And a shell tool event is still a hit for a term that appears only in its own output
    # Measured on the owner's live store, 2026-10-10: at a tie between the
    # tool and note columns the orientation query's first page was seven
    # echoes of its own earlier runs and one shell transcript, the first
    # curated note 45th. The tool weight alone lifted it to 12th, the echo
    # rule below alone to 43rd, the two together to 3rd with no echo on
    # the page. They ship together; the bench arm measures the weight.

  @D261
  Scenario: a treecontext echo is found by its arguments, never by its results
    Given a journal holding a curated note, the echo of the insert that wrote it, the echo of an orientation query that returned it, and the echo of the status call that listed it as a resume pointer
    When the agent searches for a phrase that appears only in the note
    Then the note is the hit and no echo is
    And a search for the orientation query's own words finds no echo
    And exporting any of the echoes returns its full input and output
    And a hit on an echo shows its output
    # The echo is the evidence attribution reads (journal-session-echo);
    # it is stored whole and displayed whole. Only its reach into the
    # index narrows: an insert echo to its tool name, since the note is
    # its own row; query, export and status echoes to the tool name (a
    # query echo indexing its own query text matched a repeat of that
    # query better than any note could, measured 2026-10-10 on the mature
    # journal); delete, merge and clear echoes to what they were given. The drain stamps the boundary on any echo
    # that arrives without one, so a hook copy that never learned the
    # rule still obeys it, and the import door does the same.

  @D261
  Scenario: an import echo is found by its label and tool name, never by the handoff it carried
    Given the echo of an import whose pasted handoff holds a distinctive phrase, imported under a label
    When the agent searches for that phrase
    Then the imported entries are hits and the import echo is not
    And a search for the label finds the import echo
    # The hook writes the label on its own line ahead of the handoff, so
    # the boundary can reach it; an import echo stored before this rule
    # has no such line and matches its tool name only (D261, 2026-10-10).

  @D261
  Scenario: echoes a store already holds are re-indexed when a newer treecontext opens it
    Given a store whose treecontext echoes were indexed in full by an earlier treecontext
    When this treecontext opens the store
    Then a query echo no longer matches the results it returned nor the words of the query it recorded, and still matches its tool name
    And an insert echo no longer matches the note it wrote
    And an import echo stored before this rule matches its tool name and not the handoff it carried
    And every echo's stored content is unchanged, byte for byte
    And opening the store again leaves the echoes exactly as the first open left them

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
    # A treecontext echo is the one exception since D261: its searchable
    # reach is its arguments, narrower than its preview, never wider.
    Given a tool event whose indexed view reaches beyond its display preview
    When a query matches words that sit past the preview but inside the indexed view
    Then the event is a hit
    And the hit's content still ends at the display preview with the availability marker
    # The index-cap expansion widened what a tool event exposes to search
    # (up to 8000 chars of preview plus tail) without widening what a hit
    # pays into the reader's context: the display cut and the searchable
    # boundary are separate numbers.

  @D286
  Scenario: a hit on a recovery snapshot is a bounded preview, like a tool event's
    Given a recovery snapshot the drain wrote from entries far longer than its display boundary
    When a query matches words inside its preview
    Then its content ends at the display boundary with the availability marker
    And words past its index boundary do not find it
    And export of that entry returns its full content
    # A recovery snapshot is machine output quoting the journal, never the
    # developer's words or the agent's note, so D47's whole-text promise
    # does not reach it. From beta.1 to beta.2 it carried no boundary and
    # quoted whole hits, itself among them, so it compounded per
    # compaction until one reply crossed the client's 16 MB stdio message
    # guard (2026-10-29, D286).

  @D286
  Scenario: recovery snapshots a store already holds are bounded when this treecontext opens it
    Given a store whose recovery snapshots an earlier treecontext wrote without boundaries
    When this treecontext opens the store
    Then each recovery snapshot carries a display boundary and an index boundary
    And a hit on one is a bounded preview
    And its stored content is unchanged
    # Migration 030. The words stay; only the display cut and the indexed
    # view change. Retention never destroys, and this heal keeps to that.

  @D287
  Scenario: a query reply never approaches the transport's message limit
    Given a store whose entries, returned whole, would make a reply far over the reply ceiling
    When a broad query returns them
    Then the reply is under the ceiling
    And each cut entry says so and names the export escape hatch
    And export of one entry over the ceiling is refused with its size, never cut
    # The ceiling is a quarter of the client's 16 MB guard. The bounded
    # preview is the first defence; this is the last, for any producer the
    # preview rule has not reached yet (D287).

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

  @D268
  Scenario: a metadata filter finds an entry wherever its words rank
    Given a mature journal in which a bookmark's words are outranked by more than two hundred other entries, so a search for them alone does not reach it
    When a query for those words passes a metadata filter on the bookmark kind
    Then the bookmark is returned
    # Measured on the owner's store, 2026-10-09: the filter sifted a pool
    # of at most two hundred candidates after the ranking, so a filter on
    # kind bookmark returned nothing for any query once six hundred rows
    # carried the word. A flat key narrows the candidates in the query
    # itself; a filter the query cannot carry still sifts the pool.

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
