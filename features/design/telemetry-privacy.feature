Feature: Telemetry privacy — counts by default, content only by consent

  Two instruments, opposite postures, both deliberate. SessionStats is
  always on and privacy-clean: counts, latencies, one hardcoded mode
  key, a two-value source split — in memory only, surfaced through
  status, gone at shutdown. Nothing a user or agent writes can put
  content into it or mint a new key in it. query-telemetry.jsonl is the
  opposite: it records query text VERBATIM, which is exactly why it is
  opt-in (TREECONTEXT_QUERY_TELEMETRY) and documented as consent — and
  why its second sink matters: while opted in, a 40-character query
  fragment also lands in the debug logs, which README tells users to
  paste into public issues. The fragment is bounded here and the sink
  is documented in security.md §6; the redaction rules for sharing logs
  live in debug-log-sharing.feature.

  Scenario: session stats carry counts, never content
    Given a served journal that has captured a distinctive query and entry
    When status reports the session stats
    Then the stats hold totals and latencies
    And the distinctive text appears nowhere in them

  Scenario: telemetry keys are bounded by the server, not the caller
    Given an entry inserted with a source of the caller's invention
    When status reports the session stats
    Then the insert sources are the two the server mints
    And the invented source is not among them

  Scenario: query telemetry stays off without the opt-in
    Given a served journal with no telemetry opt-in
    When a query runs
    Then no telemetry file appears beside the store

  Scenario: the opted-in debug fragment is bounded at forty characters
    Given telemetry is opted in and a query far longer than the bound runs
    When the debug log's telemetry line is read
    Then it holds the first forty characters and not the full query
    # The fragment is the second sink the opt-in creates — inside the
    # consent gate, but in a file users are told to share. Bounding it
    # is what keeps "paste your logs" compatible with "your queries
    # stay on your machine".
