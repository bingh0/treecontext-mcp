Feature: Journal capture — everything worth recalling enters the journal

  The journal exists so a future session can recall this one. Capture is
  therefore judged by one question: if a future agent needed this moment,
  is it in the store? User messages, tool events, and assistant responses
  enter with no agent effort, delivered by whatever the platform provides —
  hooks today, which are the current mechanism, not the contract. Claude
  Code is the reference platform: the first of several, not the boundary;
  the platform-independent capture surface is journal-library's contract.
  Scenarios here stay concrete about payloads on purpose — the
  tool_response bug survived precisely because nothing pinned the real
  shape. The agent adds curated notes only for synthesis the raw stream
  can't carry (decisions, rejected alternatives, the *why*). Where capture
  is impossible or an event is dropped, the journal says so — a silent
  hole is worse than a gap marker, because it reads as "nothing happened".

  Charter details: (a) capture with filtering, (g) platform payload shapes.
  History: tool outputs were silently un-captured on Claude Code for the
  project's entire life because the hook read `tool_output` while the
  platform sends `tool_response`. Every scenario here must be verified
  against real platform payloads and the live store, never by reading
  hook source.

  @D3
  Scenario: a user message is captured verbatim
    Given a session where the user submits a prompt
    When the session's events are ingested
    Then the journal contains that prompt with role "user"
    And its capture timestamp reflects when it was said, not when it was ingested

  @D3
  Scenario: a tool event is captured with both its input and its response
    Given a PostToolUse payload shaped exactly as Claude Code sends it
    When the hook stages it and ingestion runs
    Then the journal entry carries the tool name, the input, and an Output section with the response

  @D3
  Scenario: an assistant response is captured at turn end
    Given a completed assistant turn on Claude Code
    When the platform signals the turn has ended
    Then the assistant's prose is in the journal with role "assistant"
    # On the reference platform the signal is the Stop hook; the contract
    # is turn-end capture, whatever delivers it.

  @D156
  Scenario: a stop that asks for a bookmark still captures the response
    Given a completed assistant turn on Claude Code whose session's newest checkpoint is 21 rounds old
    When the platform signals the turn has ended
    Then the assistant's prose is in the journal with role "assistant"
    And the stop hook asks the agent to write a bookmark before it stops
    # Added 2026-10-07 (D156): the stop hook gained a second duty, and the
    # first, capture, must not be displaced by it.

  @D3
  Scenario: every entry carries the moment its event happened
    Given a user message, a tool event, and an assistant response from one session
    When ingestion runs some time later
    Then each entry's capture timestamp reflects its own event's moment
    And a tool event's moment is when its response arrived, not when ingestion ran
    # Generalizes the user-message clause above to every role: staging
    # records the moment, ingestion inherits it. Honest timestamps are
    # what make temporal recall and the conversation window trustworthy.

  @D16
  Scenario: platforms without a Stop hook still journal user and tool events
    Given a platform with no assistant-response hook equivalent
    When its user and tool hooks fire without a turn-end signal
    Then user messages and tool events are still captured
    And the platform's capture limitation is documented where the agent can read it

  @D3
  Scenario: every tool invocation is journaled, even the boring ones
    Given a session that runs ls, grep, and file reads alongside substantive work
    When the session's events are ingested
    Then every call's tool name and input are in the journal
    # The trail is finite and predictable because tools are code — it is how
    # a future agent reconstructs "what was being worked on" without
    # remembering it. Invocations are tiny; dedup handles repetition.
    # No invocation is ever filtered out.

  @D3
  Scenario: outputs of repo-reading tools are trail, not treasure
    Given a Read or ls call whose output is repo content at that moment
    When it is captured and ingested
    Then the journal keeps the invocation and a bounded output preview
    But no full-fidelity tail is stored — the repo and its git history are the source of truth
    # Grep is classed here (owner-confirmed 2026-07-16): its output is a
    # "finding" but fully re-derivable by re-running the search.

  @D3
  Scenario: outputs of execution and external tools are kept in full
    Given a failing test run whose output reflects code that has since changed
    When it is captured and ingested
    Then the full output is retrievable from the journal
    # Bash runs, builds, web fetches, MCP calls: their outputs are historical
    # facts, not re-derivable later. Retention is earned by non-re-derivability.

  @D3
  Scenario: a dropped or failed event leaves a visible gap marker
    Given a staged event that will fail every ingestion attempt
    When ingestion retries it to exhaustion
    Then the journal contains a capture-gap entry in its place
    And the poisoned payload is retired to a dead-letter record, not deleted

  @D58
  Scenario: the first hook on a fresh install captures without waiting for a server
    Given a fresh install whose bound store no server has ever opened
    When a user prompt hook fires before any server has started
    Then the event is staged in that store at the current schema
    And a server opening the store later ingests it with its original moment
    # Issue #2 (2026-08-05): the store's directory and schema were minted
    # only by the serving process, so every hook that fired in the window
    # between `install` and the server's first boot lost its event — exit
    # 0, one discarded stderr line, and no store to hold a gap marker.
    # That window is exactly where the README says "you are done". A hook
    # that can mint a binding can mint the store the binding names: it
    # applies the ONE definition of fresh (version 0 AND an empty
    # sqlite_master) and the full ladder — the same open the library and
    # the server perform — and nothing else. A store holding journal rows
    # is never migrated by a hook; that stays the server's job, behind a
    # backup. A second starter — the server booting beside the hook, or
    # another hook — waits for the first one's lock and finishes the same
    # ladder, so no write ever lands on a half-built schema.

  @D119
  Scenario: a tool event can be the first thing a fresh install ever captures
    Given a fresh install whose bound store no server has ever opened
    When a tool hook fires before any session or prompt hook has run
    Then the event is staged in that store at the current schema
    # Found by the release review (2026-09-02): the first cut minted the
    # schema but not the directory, and only the two hooks that write a
    # session beacon happened to create it as a side effect. PostToolUse,
    # Stop, PreCompact and every non-Claude adapter open through the same
    # door with no beacon in front of them. The door makes the directory.

  @D119
  Scenario: a schema-less store file left by an earlier hook is healed, not abandoned
    Given a bound store file that holds no schema at all
    When a capture hook fires against it
    Then the event is staged in that store at the current schema
    # rc.6's shape of the same bug: the binding layer had learned to
    # create the directory, so the hook's open minted a 4KB file with no
    # tables, the insert died on "no such table: staging", and doctor
    # graded the leftover "v0→v24, 3 destructive" forever. Empty is
    # fresh; fresh gets the schema.

  @D119
  Scenario: hooks racing to create one fresh store all land on the finished schema
    Given a fresh install whose bound store no server has ever opened
    When six capture hooks fire at once before any server has started
    Then every one of them is staged at the current schema with its content intact
    # The race that building the fix surfaced (2026-09-02): between the
    # winner's base-schema commit and its first exclusive migration batch,
    # a second starter that read the store as "already versioned" wrote
    # through the legacy column tier — stamps and tail dropped — three
    # times in four. Fresh is "below the ladder's head with an empty
    # journal", and a starter that loses the lock finishes the ladder
    # rather than writing under it.

  @D80
  Scenario: repeated identical events dedup without losing distinct ones
    Given a session with capture hooks live
    When the same auto-captured event arrives twice within the dedup window
    Then one journal entry exists
    But the same content from a different session or outside the window is a distinct entry

  @D3
  Scenario: an oversized non-re-derivable event keeps its full content
    Given an execution or external tool event far larger than the indexed preview caps
    When it is captured and ingested
    Then the full content is retrievable from the journal
    And the searchable view is bounded, with the deepest tail beyond it unindexed
    # "Full" has one honest bound: the store safety cap (256Ki chars per
    # event). Beyond it the HOOK cuts the tail — never the preview — and
    # writes a truncation notice into the record; that contract is pinned
    # in tool-event-fidelity ("respects the store safety cap"). The
    # journal never claims fidelity capture already dropped.

  @D3
  Scenario: every capture carries the session that produced it
    Given hooks capturing events for a known platform session
    When those events are ingested and the agent inserts a note in the same session
    Then the captures and the note carry the same session identity
    And conversation windows group them as one session
    # When the platform session cannot be resolved, nothing is guessed — an
    # entry without an identity is honest; one with a wrong identity poisons
    # every window built over it.

  @D3
  Scenario: curated notes carry what the raw stream cannot
    Given a session already holding the assistant's prose on a topic
    When the agent inserts a decision note with file pointers and metadata
    Then the note is stored with role "note" and ranks with full weight in search

  @D118
  Scenario: a server abandoned by its client shuts down instead of spinning
    Given a live capture server whose client has abandoned its stderr
    When the server's next warning lands on the dead stream
    And the client closes the conversation channel
    Then the server process exits cleanly
    # The observed failure (2026-08-30, live on the owner's machine): an
    # Electron-family client closed only stderr and left stdin open; the
    # first EPIPE became an uncaughtException whose own logging re-raised
    # it — a self-sustaining 100%-CPU loop that even SIGTERM could not
    # enter, survivable only by SIGKILL. A dead peer earns a swallowed
    # write or a shutdown, never a storm: capture may be lost for a
    # reason, never at the price of the machine it runs on.
    # Under D258 (2026-10-08) a serving server's diagnostics go to its
    # log file only, so the write that meets the dead stream is a genuine
    # warning: the drain dead-lettering a malformed staged event, a real
    # payload the binding stages.

  @D118
  Scenario: a client that dies before the server finishes starting leaves no orphan
    Given a capture server that has only just opened its stdio channel
    When the client closes the conversation channel
    Then the server process exits cleanly
    # stdin announces its EOF exactly once. The dead-peer watch used to
    # be wired only after the transport connected AND capture
    # initialized, so a client that died inside that window — a slow
    # migration, a big store open — was never heard, and the server
    # outlived it forever holding the store open. A dead peer earns a
    # shutdown whether it dies mid-session or mid-startup.
