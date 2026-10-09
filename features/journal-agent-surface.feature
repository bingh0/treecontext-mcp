Feature: Journal agent surface — the parts the agent reads are product

  A journal no agent consults is dead weight. The agent-facing text — MCP
  tool descriptions, handshake instructions, hook reminders, the AGENTS.md
  block, the reference skill — is what turns the store into recall
  behavior, so it is specified and guarded like code. The channels must
  agree with each other, fit the platforms that carry them, and never
  describe a capability the running backend does not have.

  Charter detail (g): tool descriptions, hooks, and agent instructions as
  first-class surface. History: the verbose instruction variant measurably
  SUPPRESSED memory use before eval t10 caught it — prose here has
  behavioral consequences and gets measured, not assumed.

  Platform scope (ruled 2026-07-23): the MCP tool surface is universal —
  any MCP client gets the whole journal — and the library capture surface
  is platform-independent by contract. What is VERIFIED end-to-end is
  Claude Code, the reference platform. Hook adapters for other platforms
  exist in the tree unverified, and nothing the agent reads may claim
  them as working until each earns a live-payload pass — the
  never-advertise rule below, applied to platforms.

  @D8
  Scenario: every channel teaches the same session-start protocol
    Given a configured install
    When the handshake instructions, the session-start hook reminder, the AGENTS.md block, and the reference skill are read side by side
    Then each names status, then export, then query, in that order, before any other journal tool
    And each carries the gate phrase making orientation precede the user's request

  @D39
  Scenario: the lexical backend never advertises machinery it lacks
    Given a server running on the lexical backend
    When the MCP handshake sends its instructions
    Then no tree-era checkpoint or summarize machinery is named
    And status never demands a summarize action
    # Telling the agent to run a tool the backend does not register
    # erodes trust in every other line of the instructions.

  @D39
  Scenario: the media guidance in the lexical instructions is honest
    Given a server running on the lexical backend
    When the MCP handshake sends its instructions
    Then they tell the agent to attach a media_ref to file insertions
    And an entry inserted with a media reference exports with the media reference intact
    # Rewritten from its @bug form when the media path landed 2026-07-23:
    # the guidance stays only as long as the backend delivers it. The
    # never-advertises scenario above guards the class; this pins the one
    # instance that was caught advertising a dropped capability in the wild.

  @D8
  Scenario: instructions survive the platform's size cap un-truncated
    Given a server running on the lexical backend
    When the MCP handshake sends its instructions
    Then the default instruction text fits under the cap whole
    # A truncated instruction block silently drops whatever came last;
    # fitting is a spec obligation, not a formatting nicety.

  @D8
  Scenario: the instructions explain the preview marker before the agent meets one
    Given a server running on the lexical backend
    When the MCP handshake sends its instructions
    Then they describe the availability marker and name the export tool it points to
    # The marker's runtime behavior — where it appears, that export returns
    # the full content — is journal-recall's scenario. This pins only that
    # the agent is told about it up front, because a marker nobody
    # explained reads as decoration and gets ignored.

  @D8
  Scenario: gap markers are explained where the agent will meet them
    Given a journal containing capture-gap entries
    When the MCP handshake sends its instructions
    Then the instructions state that gap entries mark holes to be trusted over assumed completeness

  @D39
  Scenario: tool schemas describe only what the backend does
    Given a running journal server
    When the MCP handshake registers its tool schemas
    Then no parameter description names retrieval machinery the backend lacks
    And a parameter accepted only for compatibility says so in its description
    # Found at critic pass 3 (2026-07-25): the query schema still described
    # subtree drilling, multimodal retrieval, and dense fusion after the
    # tree era left — the never-advertises scenario above covers the
    # handshake instructions, but tool schemas are the most-read channel
    # of all. Spec-ahead: binds with the search-modes wave, which owns
    # reconciling the mode surface with lexical reality.

  @D43
  Scenario: the tool surface is exactly the ruled set
    Given a running journal server
    When the MCP handshake registers its tools under the full policy
    Then the eight journal tools and no others are present
    # "Under the full policy" is load-bearing, not filler: journal-policy
    # owns the tiers, where the registered set shrinks to three tools
    # (read_only) or four (contributor). This scenario pins the ceiling —
    # full's membership — the tiers subtract from it, never add.
    # Added at critic pass 4 (2026-07-26), pinning the two rulings that
    # shrank the surface: the feedback tool left by ruling (2026-07-25,
    # on the fence) and the code tool left with the deletion phase. Every
    # registered tool is context tax on every session (the t10 lesson),
    # so membership itself is spec: a tool appearing or vanishing is an
    # owner decision made in a feature-file diff, never silent drift.

  @D8
  Scenario: installing the AGENTS.md block twice yields one block
    Given a repository where the init command has already added its block
    When init runs again
    Then the block appears once, updated in place

  # The hackathon interview of 2026-10-05 to 2026-10-07 added the
  # checkpoint protocol to what the instructions must teach (D174), and
  # ruled that re-orientation scenarios bind on the packet and on these
  # instructions, never on a live model reply (D188).

  @D174
  Scenario: the instructions teach the checkpoint protocol
    Given an agent connected to the server
    When it reads the handshake instructions
    Then the agent reads that two kinds of checkpoint exist, the bookmark the stop hook writes and the chapter summary written on the developer's word
    And the agent reads the word that writes a chapter summary
    And the agent reads what the first reply after a /clear shows, in order
    And the agent reads the steps of a handoff through the shared repository

  @D188
  Scenario: the instructions tell the agent to show the packet first after a clear
    Given an agent connected to the server
    When it reads the handshake instructions
    Then the agent reads that its first reply after a /clear opens with the re-orientation packet shown to the developer as is

  @D173
  Scenario: the instructions tell the agent to suggest a clear after a chapter summary
    Given an agent connected to the server
    When it reads the handshake instructions
    Then the agent reads that after writing a chapter summary it suggests that this is a good moment to /clear

  @D179
  Scenario: the instructions name doctor as the first move when something looks wrong
    Given an agent connected to the server
    When it reads the handshake instructions
    Then the agent reads that when capture or recall looks wrong it runs doctor before anything else

  @D210
  Scenario: the handshake stays a card and the long form lives in the skill reference
    Given an agent connected to the server
    When it reads the handshake instructions
    Then the agent reads the whole checkpoint protocol in under 2500 characters of handshake text
    And the agent reads where the protocol's long form can be loaded on demand
