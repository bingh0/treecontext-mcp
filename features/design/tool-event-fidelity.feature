Feature: C4 producer — tool-event full-fidelity staging

  The producer composes preview + full tail so the journal is
  full-fidelity. Since the index-cap expansion (schema 18) a tool event
  carries TWO boundaries: preview_len marks the display cut, index_len
  the searchable view (up to 8000 chars of preview plus tail) — that
  path, and the three-tier degradation chain for older stores, are
  pinned in index-cap-expansion.test.ts. THIS suite stages into a
  schema 16/17 fixture (index_len, no preview_len), pinning the middle
  tier: a single boundary at the preview, byte-for-byte the pre-expansion
  composition for a string payload, because old readers treat index_len
  as display cut too; an object or content-block payload composes as its
  text since D270 (2026-10-10). One scenario below, the old server
  stepping aside (D265), is a drain scenario with no hook in it and runs
  its own world: a real ingestion loop and a real lease client over one
  store.
  Footguns: JF-1, JF-3, JF-8, JF-10, JF-12.

  Scenario: an oversized tool event stages preview plus full tail with the boundary recorded
    Given a tool event whose input exceeds 500 chars and whose output exceeds 1000 chars
    When the post-tool-use hook stages it
    Then the staged content begins with exactly today's preview composition
    And the full input and full output follow after the tail separator
    And on this pre-expansion store staging.index_len equals the preview length in UTF-16 code units

  Scenario: an event that fits its caps stages exactly what it stages today
    Given a tool event whose input is under 500 chars and whose output is under 1000 chars
    When the post-tool-use hook stages it
    Then the staged content is the preview alone with no tail
    And staging.index_len is NULL

  Scenario: the index boundary is measured in code units, not bytes
    Given a tool event whose output contains multibyte characters before the 1000-char cap
    When the hook stages it and ingestion inserts it
    Then on this pre-expansion store the FTS index view sliced at _index_len equals the preview exactly
    And no tail text is findable through this store's index

  Scenario: the composed row respects the store safety cap by cutting the tail, never the preview
    Given a tool event whose full output alone approaches the 256KB store safety cap
    When the hook stages it
    Then the composed content fits the cap
    And the preview is intact and the tail ends with the truncation notice

  Scenario: shielded outputs never enter a tail, but an overflowed input still does
    Given a tool event with an oversized input whose output is a shielded-file pointer
    When the hook stages it
    Then the tail carries the full input and never the shielded output
    And a shielded event whose input fits stages the pointer preview alone with NULL index_len

  Scenario: a new hook binary degrades cleanly against a not-yet-migrated database
    Given a staging table without the index_len column
    When the hook stages an oversized tool event
    Then the event is staged through the legacy column list rather than lost
    And the staged content is the preview alone — a tail without its boundary would be indexed whole

  Scenario: an old server degrades cleanly against a newer-migrated database
    Given a server built for one schema version draining a store that a newer treecontext has since migrated past it
    When its next drain tick takes the drain lease
    Then it releases the lease and its staging claims, writes one warning, and stops its drain and its sweeps
    And a newer server takes the drain on its next tick
    And every staged event is drained by the newer server, none lost
    # D265, the mirror of the scenario above. On the beta.1 night the
    # still-running rc.7 server retried five staging rows every five
    # seconds for two hours and twenty minutes against a migrated store;
    # the valve was right to keep the rows, the gap was in noticing.

  Scenario: a Claude Code-shaped payload's tool_response is captured as the output
    Given a PostToolUse payload carrying the result under tool_response, as Claude Code sends it
    When the post-tool-use hook stages it
    Then the staged content carries an Output section with that result

  Scenario: an object or content-block tool_response and an object tool_input are composed as their text, line breaks and tabs real
    Given a PostToolUse payload whose tool_response is an object holding stdout with several lines and a tab and an interrupted flag, and whose tool_input is an object holding a multi-line command
    When the post-tool-use hook stages it
    Then the Output section carries the stdout text as its lines after its name, with the tab as a character
    And every other field of the response is in the Output section as its name and value
    And the Input section carries the command's lines as lines after its name

  Scenario: a file read's nested content and an MCP content block compose as their text
    Given a PostToolUse payload whose tool_response nests a file's content under file.content across several lines
    And a second payload whose tool_response is a list of content blocks whose text is a JSON document
    When the post-tool-use hook stages both
    Then the file's content lines stand under their field path in the Output section
    And the content block's text is written verbatim, so a key quoted inside it is still readable by key
    # D270. The preview is the FTS index view, so this is a composition
    # change that moves what is findable: the word after each line break
    # becomes its own token. Rows staged before it recompute their index
    # text from their stored (encoded) content, exactly as before. The
    # echo readers that parse an Output by key are pinned end to end by
    # journal-session-echo and journal-session-namespace, which stage a
    # real echo through this hook. A shielded pointer inside a content
    # block is recognized as the pointer it is.

  Scenario: ingestion carries the boundary into node metadata verbatim
    Given a staged row with index_len set
    When the ingestion loop inserts it
    Then the node's metadata _index_len equals the staged index_len
    And a staged row with NULL index_len produces a node without the marker

  Scenario: identical previews with different full outputs are distinct nodes
    Given two runs of the same command whose previews match but whose full outputs differ
    When both are ingested inside the dedup window, in one session
    Then two nodes exist, pinning that fingerprints cover the composed content
    # In-window is load-bearing (round-2 R9): outside the window two nodes
    # exist no matter what fingerprints cover — the scenario was true by
    # construction. Inside it, a preview-only fingerprint collapses the
    # pair to one node and turns this red.
