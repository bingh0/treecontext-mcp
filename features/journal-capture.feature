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

  @D400
  Scenario: a tool call that fails is journaled with what the client said went wrong
    Given the events Claude Code sent for a shell command that exits non-zero, a file read that fails, a command that times out and an MCP tool that answers with an error
    When the hooks install wires receive those events and ingestion runs
    Then each failed call is in the journal with its tool name, its input and the client's error text as its output
    And each is marked as failed and carries the client's own id for the call
    And each entry's moment is when its failure arrived
    # Found on the first beta.4 load, 2026-11-09: Claude Code fires
    # PostToolUse only for a call that succeeds. A call that fails fires
    # PostToolUseFailure, which install never wired, so no failed call was
    # ever journaled: 9 of 469 shell calls across four sessions, the ones a
    # future agent most needs ("what did the failing test print?"). The
    # scenario above this one was green throughout: its binding wrote four
    # successful PostToolUse payloads by hand and ran the script itself, so
    # neither what the client sends nor what install subscribes was in the
    # world. The events here are the client's, recorded from a real run and
    # kept with the client's version; they reach the hooks through what
    # install wires, an event install does not wire reaching nothing, as on
    # the client.

  @D401
  Scenario: a call the client refused before running it is journaled from the client's own account
    Given the events Claude Code sent for a call rejected for its input, a call denied permission and a call a hook blocked
    When the hooks install wires receive those events and ingestion runs
    Then each such call is in the journal with its tool name, its input and what the client told the model about it
    And each says it was captured from the client's account of the batch and carries the client's own id for the call
    # Found by the same live pass: for these three the client fires neither
    # PostToolUse nor PostToolUseFailure (a call rejected for its input
    # fires no event of its own at all). The one place the client names
    # every call it resolved is the batch's account, PostToolBatch, sent
    # after the calls' own events and before the model is called again.

  @D401
  Scenario: a call is journaled once, whichever events carried it
    Given the events Claude Code sent for one batch of parallel calls, one succeeding, one failing and one rejected for its input
    When the hooks install wires receive those events and ingestion runs
    Then the journal holds exactly one entry for each call of the batch
    And the succeeding and the failing call are the entries their own events produced, not the batch's account of them

  @D404
  Scenario: a call the client says succeeded is classed a success, whatever its output says
    Given the events Claude Code sent for calls that succeeded with output that reads like trouble: a shell command printing "error: 0 found, 0 failed", a shell command printing "warning: deprecated", an MCP tool answering "failed call seen" and a file read of a file that holds a Python traceback
    When the hooks install wires receive those events and ingestion runs
    Then each call's entry is classed a success, never an error or a soft fail
    And each says its class is the client's word
    # Found on the installed build, 2026-11-09: successful
    # treecontext_status and treecontext_export calls were classed errors,
    # a doctor run a soft fail, and a treecontext_insert whose note said
    # "failed call seen" an error, because the class of a call with no
    # failure mark was still read from its text. On Claude Code a call that
    # failed, a shell command's non-zero exit and timeout among them,
    # arrives by an event of its own (D400), so a call that arrives as a
    # success is one. The events here must be recorded from a real client
    # before this scenario is bound: no recording kept today holds a
    # success whose output carries those words.

  @D404
  Scenario: a call whose client says nothing of how it ended is still classed by its output
    Given a tool event from a client whose events do not say whether a call succeeded, its output reading "error: no such table"
    When ingestion runs
    Then the call's entry is classed an error
    And it says its class was read from its output
    # Codex CLI is such a client for shell commands: its hook reports a
    # non-zero exit as an ordinary result, with no exit code. Classing
    # every event that carries no failure mark a success would file that
    # client's failing commands as clean; where the client is silent, the
    # text is still the only witness, and the entry says so.

  @D404 @D406
  Scenario: a failing Codex shell command replayed through Codex's hooks is classed by its text, never by the client's word
    Given the events Codex CLI sent for a shell command that exits non-zero, as recorded
    When the hooks install writes for Codex receive those events and ingestion runs
    Then the call's entry takes the class its text decides
    And it says its class was read from its output, never that the client stated it
    # Codex's payloads are shaped like Claude Code's, and its failing
    # command arrives by PostToolUse. A hook that took its client from the
    # payload would read that PostToolUse as Claude Code's stated success.
    # The hook takes its client from the command install wrote for Codex.

  @D404
  Scenario: on a store whose schema keeps no stated-success mark, a call that succeeded is classed by its text
    Given a store at the schema before this build's, met by a hook of this build
    And the events Claude Code sent, as recorded, for a call that succeeded
    When the hook receives those events and ingestion runs once the server has opened the store
    Then the call's entry takes the class its text decides
    And it says its class was read from its output
    # A hook meeting an older store drops the marks it cannot write (the
    # tier walk, D400), so the drain cannot tell a stated success there.

  @D408
  Scenario: a Codex session's prompt, tool calls and last reply are journaled
    Given the events Codex CLI sent, as recorded, for sessions that submit a prompt, run a shell command, call treecontext's insert tool and end their turns
    When the hooks install writes for Codex receive those events and ingestion runs
    Then the journal holds the prompt with role "user"
    And each tool call with its tool name, its input, what Codex returned as its output and Codex's own id for the call
    And the turn's last assistant message as Codex sent it at the turn's end
    And each entry's moment is when its event arrived
    # Recorded live, 2026-11-09, Codex CLI 0.167.0. The last reply is read
    # from the event's own payload: Codex's documentation calls its
    # transcript file no stable interface.

  @D408
  Scenario: a Codex shell command that fails is journaled with what Codex said, and no outcome the client never gave
    Given the events Codex CLI sent, as recorded, for a shell command that exits non-zero and a write its sandbox refused
    When the hooks install writes for Codex receive those events and ingestion runs
    Then each call is in the journal with its command and the text Codex returned as its output
    And neither entry carries a failed mark, since Codex states no outcome for a shell command
    And each entry takes the exit class its text decides
    # Codex sends a shell command's result as one plain text: no exit
    # code, no split between output and errors, and a failure arrives as
    # an ordinary PostToolUse. The journal keeps what was said and invents
    # nothing; the README says what a Codex entry does not hold.

  @D408 @D404
  Scenario Outline: a Codex call that ends with no result reported is journaled once, unclassified, <call>
    Given the events Codex CLI sent, as recorded, for <call>, its PreToolUse with no PostToolUse by the turn's end
    When the hooks install writes for Codex receive those events and ingestion runs
    Then the journal holds one entry for the call, with its tool name, its input and Codex's own id for it
    And the entry is marked as a call Codex reported no result for, with no exit class and no word on why

    Examples:
      | call                                                  |
      | an MCP tool call Codex got an error reply for          |
      | a file edit whose patch did not match the file         |
    # Recorded live, 2026-11-09, Codex CLI 0.167.0: a call that fails,
    # other than a shell command, fires PreToolUse and no PostToolUse.
    # A call still running at an interrupt looks the same, so the entry
    # says Codex reported no result, never that the call failed.

  @D408
  Scenario: a Codex call whose turn never reached an end the journal heard is kept, and says only what is known
    Given the events Codex CLI sent, as recorded, for a file edit whose patch did not match the file, its turn ended by no Stop or Interrupt the hooks received
    When ingestion runs and the processed staging is later purged
    Then the journal holds one entry for the call, with its tool name, its input and Codex's own id for it, dated at the moment Codex started the call
    And the entry says Codex started the call and neither its result nor the end of its turn reached the journal, with no exit class
    # Ruled in on 2026-11-10, from the review of the build: a session
    # that crashes, is killed, or is a worker ended at its timeout sends
    # no Stop, and the call's only trace was dropped with the staging it
    # sat in. No invocation is ever filtered out: before it leaves
    # staging it becomes an entry that claims nothing it does not know.

  @D408
  Scenario: a Codex call that succeeded is journaled once, though two events carried it
    Given the events Codex CLI sent, as recorded, for a file edit that succeeded, its PreToolUse and its PostToolUse
    When the hooks install writes for Codex receive those events and ingestion runs
    Then the journal holds one entry for the call, from its PostToolUse, with what Codex returned as its output

  @D408
  Scenario: a Codex turn the developer interrupted is journaled as interrupted, its partial reply named as not captured
    Given the events Codex CLI sent, as recorded, for a turn the developer interrupted, ending in Codex's interrupt and no turn's end
    When the hooks install writes for Codex receive those events and ingestion runs
    Then the journal says the turn was interrupted, with a capture-gap entry naming its reply as not captured
    And the journal holds no assistant entry for that turn
    And every call of the turn whose PreToolUse had no PostToolUse is journaled as a call Codex reported no result for
    # Recorded live, 2026-11-09, in Codex's interactive interface: Esc
    # mid-turn fired Interrupt and no Stop, and the partial reply was in
    # no payload. The journal writes no text the client never sent.

  @D270
  Scenario: a tool event's output is captured as text, a line a line
    Given a shell command whose output spans several lines and carries a tab
    When the event is captured and ingested
    Then the word that begins each line is findable by itself
    And the stored entry shows the output's lines as lines, not as escape sequences
    And an entry captured before this rule is still found by its glued word and shows its escape sequences
    # Found by the bench's capture-path arm, 2026-10-10: the client hands
    # a tool's response over as an object, the hook stored its JSON
    # encoding, and every line break became the two characters backslash
    # and n, glued onto the next word by the tokenizer. Only each
    # output's first line was findable.

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

  @D286
  Scenario: a recovery snapshot quotes the journal at its preview and never quotes a snapshot
    Given a journal holding curated notes, an oversized tool event, and an earlier recovery snapshot that matches the recovery queries
    When the drain processes a claimed snapshot
    Then the recovery row quotes each hit at its display view, cut at the quote cap and named by its entry
    And the earlier recovery snapshot is not quoted
    And the recovery queries sit in the row's metadata, not in its indexed words
    And the row carries its own display and index boundaries
    # The snapshot path was fenced as "working mechanics, unspecced" (D35)
    # while it wrote rows into the store on every compaction. A fence may
    # decline a promise, never a writer: what the drain writes is in the
    # charter from here (D286).

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

  # Antigravity CLI (D415, D418, 2026-11-09, beta.4): agy's events carry
  # the prompt on every event and no tool output, no reply and no call id;
  # the output and the reply are in agy's transcript of the conversation,
  # which the step a PostToolUse names points into. The step is written
  # by the end of the model call that made the call, not when its
  # PostToolUse fires (recorded 2026-11-09). Every event and
  # transcript here is agy's own, recorded from a real agy 1.5.3 and kept
  # with its version under tests/fixtures, replayed through the hook
  # install writes.

  @D415
  Scenario: an Antigravity session's prompt, tool calls and reply are journaled with the output agy's transcript holds
    Given the events and the transcript of an Antigravity session, as Antigravity sends them, that runs a shell command, reads a file, inserts a note through treecontext and replies
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then the journal holds the session's prompt once, with role "user"
    And each tool call is in the journal with agy's tool name, its arguments and an Output section holding what the transcript records for it
    And the reply is in the journal with role "assistant"
    And every hook answered agy with a JSON object and decided no permission

  @D415
  Scenario: a call's output is read from agy's transcript at the end of the model call that made it
    Given the events of an Antigravity session, as Antigravity sends them, and its transcript as it stood when each event fired, the call's result missing at its PostToolUse and present at the PostInvocation that follows
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then the call is in the journal once, with an Output section holding the result the transcript recorded
    And the entry's moment is when the call's PostToolUse arrived
    # Recorded live, 2026-11-09, agy 1.5.3: at PostToolUse the transcript
    # ends at the response that made the call; the result is there at the
    # PostInvocation that follows, in every run. With parallel calls a
    # later PostToolUse may or may not see an earlier call's result.

  @D415
  Scenario: a prompt Antigravity repeats on every event is journaled once per turn
    Given the events of an Antigravity session of two turns, as Antigravity sends them, whose second prompt is the same text as its first
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then the journal holds two prompt entries with role "user", one for each turn
    # agy has no prompt event: `lastUserInput` rides on every event of a
    # turn, around every model call. Journaled on each event, one prompt
    # would be ten entries; told apart by its text alone, a prompt typed
    # twice would be one. Recorded 2026-11-09 (agy 1.5.3, `agy -c -p`): a
    # second turn fires no SessionStart and opens with a model call
    # numbered 0 again, which is where its prompt is journaled.
    # A subagent's message back to its parent reopens the parent's turn
    # the same way, so the parent's prompt is journaled again there.

  @D415
  Scenario: a call whose output agy's transcript does not hold is kept, and says its output was not captured
    Given the events of an Antigravity session, as Antigravity sends them, whose transcript cannot be read, or holds no result for a call by the conversation's Stop
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then each tool call is in the journal with agy's tool name and its arguments, saying its output was not captured
    And the journal holds a capture-gap entry naming the reply that could not be read
    And no tool call of the session is missing from the journal

  @D415
  Scenario: a shell command that fails on Antigravity is journaled with what it printed, its ending read from its text
    Given the events and the transcript of a shell command that exits non-zero, as Antigravity sends them
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then the call is in the journal with an Output section holding the exit code and what the command printed, as the transcript records them
    And the entry carries no outcome mark of the client's, agy having stated none
    # agy sends a PostToolUse with an empty `error` for a command that
    # exits non-zero; the exit code is only in the transcript's text.
    # Where the client states nothing, the text decides (D404).

  @D421 @D418
  Scenario: an Antigravity subagent's conversation is journaled as its own session, writer unknown, and its parent keeps the call that started it
    Given the events and transcripts of an Antigravity session that starts a subagent and of the subagent's own conversation, as Antigravity sends them
    When the hook install writes for Antigravity CLI receives those events and ingestion runs
    Then the parent's journal holds the subagent call with its prompt and role as input and an Output section naming the subagent's conversation
    And the subagent's rows sit in their own session, in no checkout's lane, read as writer unknown, and none is stamped as the parent's
    And no helper, key, first moment, send-back or pointer is recorded for the subagent
    # agy 1.5.3 has no subagent event, and nothing in the subagent's
    # events names its parent. Ruled 2026-11-10 (D421): linking the child
    # to its parent as a helper, through the parent's call result, waits
    # for beta.5 or a user's request; until then every child stays as
    # D418 had it before its link is read, never passing for a main of
    # the checkout or for its parent. Legs on agy are fenced to beta.5.
