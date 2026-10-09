Feature: stop.ts — Stop hook, assistant response capture (C4/AC4a)

  The Stop hook is the only capture path for assistant prose: before it
  existed, nothing captured what the assistant actually said. It reads the
  session transcript and stages the last assistant TEXT content block in it
  — never a tool_use block. Text-free turns (pure tool runs, interrupts) are
  scanned PAST, deliberately, so a turn that ended in tool calls still
  journals the prose that preceded it; the duplicate that would otherwise
  create on a Stop re-fire is caught by the stale-recapture guard rather
  than by refusing to look back.
  (Header corrected 2026-07-31, round-2 R6: it previously claimed "never an
  earlier turn's text", which the implementation deliberately violates and
  no scenario could bind. The guard it relies on was itself unpinned.)

  Fixture tier: the staging tables built here are PRE-016 (no index_len /
  preview_len / attempts), so the hook exercises writeStaging's oldest
  fallback branch. The current-schema path for Stop rows is covered by the
  real-subprocess capture wave in tests/journal/features.test.ts. Declared
  2026-07-31 (round-2 R11) — tool-event-fidelity declares its own tier the
  same way; an undeclared tier reads as "current path under test".

  Scenario: extracts the last assistant text block, skipping a trailing tool_use-only turn
    Given a transcript with an earlier assistant text turn, a middle turn with text and a tool_use block, and a final assistant turn that is tool_use only
    When the last assistant text is extracted
    Then it is the text from the middle turn, not the earlier turn and not any tool_use JSON

  Scenario: a re-fire on a text-free turn does not stage the same response twice
    Given a session whose last assistant response is already staged, and a transcript whose final turn is tool_use only
    When the Stop hook runs again
    Then no second staging row is written for that response
    # The other half of scanning past text-free turns (round-2 R6): the
    # scan finds the SAME earlier text, and the stale-recapture guard is
    # what keeps it from becoming a duplicate node at a new timestamp.
    # Unpinned until now — deleting the guard's call left every scenario
    # in this file green.

  Scenario: returns null when the transcript has no assistant text at all
    Given a transcript containing only user messages and tool_use blocks
    When the last assistant text is extracted
    Then the result is null

  Scenario: returns null when the transcript file does not exist
    Given a transcript path that does not exist on disk
    When the last assistant text is extracted
    Then the result is null

  Scenario: the hook stages the extracted text as an assistant row with no tool_name
    Given a hook input with a transcript_path resolving to a real transcript ending in assistant text
    When the Stop hook runs
    Then a staging row is written with role assistant, no tool_name, and the extracted text as content

  Scenario: the hook stages nothing when transcript_path is absent
    Given a hook input with no transcript_path
    When the Stop hook runs
    Then no staging row is written
