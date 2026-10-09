Feature: user-prompt-submit.ts — full-fidelity user message staging (C4/AC4b)

  The hook stages the full user message (up to the generous
  STORE_SAFETY_CAP) and stamps the searchable boundary per capture.
  Since the index-cap expansion (schema 18) the default boundary is the
  whole message — prose indexes in full, with TREECONTEXT_INDEX_CAP as
  the narrowing lever (pinned in index-cap-expansion.test.ts). Rows
  captured before the expansion carry no marker; their searchable view
  recomputes from the FROZEN 2000-char legacy cap and must never move.
  Fixture-tier declaration (staleness repair 2026-08-12, previously
  unstated): no producer in this build can create a marker-less row —
  the hooks always stamp — so the pre-expansion scenario below binds
  against a CONSTRUCTED legacy fixture, the same declared-fixture tier
  the pre-018 staging fixtures in hooks.test.ts use. The claim is about
  the read side's treatment of rows old stores really hold, observable
  only through a fixture standing in for them.

  Scenario: a user message longer than 2000 chars is staged in full
    Given a user message of 5000 characters
    When the user-prompt-submit hook runs
    Then the staged content is the full 5000-character message, not truncated to 2000

  Scenario: a pre-expansion row keeps its frozen 2000-char searchable view
    Given a 5000-character message stored as an auto-capture user node without an index marker
    When querying for a marker placed within the first 2000 characters
    Then the node is found and its returned content is the full original message
    And querying for a marker placed only after the first 2000 characters returns no hits
    # The frozen legacy cap: contentless FTS recomputes these rows' index
    # text from INDEX_CAP_USER at delete/update time, so the constant —
    # and this pinned behavior — must never change again.

  Scenario: a post-expansion capture is findable by its last word
    Given the same 5000-character message stored with the expansion's full-length marker
    When querying for the marker placed only after the first 2000 characters
    Then the node is found and its returned content is the full original message
