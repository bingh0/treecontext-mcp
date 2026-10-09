Feature: Re-orientation after a clear — the first reply carries the thread

  A developer who clears context to save tokens must not pay those tokens
  back re-orienting. Two kinds of checkpoint exist: the bookmark, written
  by the stop hook on an interval, cheap and low in signal; and the
  chapter summary, written on the developer's word, deliberate and high
  in signal. After a clear the session-start hook hands the agent one
  bounded packet — chapter, bookmark, the tail since the bookmark — with
  every count disclosed, and the agent decides what to fetch beyond it.
  No heuristic can prove a pointer current, so the packet discloses
  rather than decides.

  The packet is what treecontext produces; what the model does with it is
  out of reach (D188). Every Then here reads the packet the hook emits or
  the instructions the server hands the agent, never a live reply.

  Rulings D145-D147, D156-D163, D166, D171, D173, D175, D183, D185-D189,
  D198 of the hackathon interview, 2026-10-05 to 2026-10-07.

  @D187 @D216
  Scenario: the packet after a clear carries the chapter, the bookmark and the tail
    Given a session whose newest chapter summary is 3 days old and reads "plan: wire the login form; next: write its tests"
    And its newest bookmark is 40 minutes old, reads "at: CSRF test failing in login.test; next: fix token", with 1400 entries between the chapter and the bookmark
    And 30 entries since the bookmark, 12 of them the developer's own turns
    And no entry in any lane refers to the chapter or the bookmark
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent opens with the chapter summary and its age of 3 days
    And the packet's chapter line is followed by a referenced-by line that reads none
    And the packet continues with the bookmark, its age of 40 minutes, and the 1400 entries between
    And the packet's bookmark line is followed by a referenced-by line that reads none
    And the packet lists the newest 5 of the developer's turns since the bookmark and states that 7 were omitted
    And each listed turn is cut to its first line with its character count
    And the packet ends with the one-line reminder of how to leave a chapter summary

  @D187
  Scenario: a chapter referenced from another lane shows its referrer one hop deep
    Given a session whose newest chapter summary reads "plan: wire the login form; next: write its tests"
    And a note from the tester subagent, 20 minutes old, that names that chapter and opens "CSRF blocks the plan's next step"
    When the developer types /clear and sends the next prompt
    Then the packet's chapter line is followed by a referenced-by line naming the tester, 20 minutes, and "CSRF blocks the plan's next step"
    And the packet does not carry the tester's note in full

  @D198 @D216
  Scenario: a developer with no checkpoint is re-oriented from recent entries and nudged once a day
    Given a session holding 12 journal entries and no checkpoint of either kind
    And no /clear has happened yet on the machine's local calendar day
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent says it re-oriented from the 12 recent entries
    And the packet lists the newest 5 of the developer's turns
    And the packet tells the developer once how to leave a chapter summary before the next clear
    And the packet after a second /clear that same day carries no nudge
    And the packet after the first /clear of the next local calendar day carries the nudge again

  @D158 @D198
  Scenario: bookmarks without a chapter say that no chapter summary exists
    Given a session holding two bookmarks and no chapter summary
    And no /clear has happened yet on the machine's local calendar day
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent opens with the newest bookmark and its age
    And the packet states that no chapter summary exists
    And the packet lists the developer's turns since that bookmark
    And the packet tells the developer once how to leave a chapter summary before the next clear

  @D162 @D145
  Scenario Outline: the tail keeps its shape with <turns> turns since the bookmark
    Given a session whose newest bookmark is 10 minutes old
    And <turns> of the developer's turns since that bookmark
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent lists the newest <shown> of those turns
    And the packet states that <omitted> turns were omitted

    Examples:
      | turns | shown | omitted |
      | 1     | 1     | 0       |
      | 5     | 5     | 0       |
      | 6     | 5     | 1       |
      | 10000 | 5     | 9995    |

  @D162
  Scenario: no turn since the bookmark is said in one line
    Given a session whose newest bookmark is 10 minutes old
    And no developer turn since that bookmark
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent says in one line that no developer turn has arrived since the bookmark

  @D162
  Scenario: a pasted log shows as its first line and its length
    Given a session whose newest developer turn is a pasted log of 40000 characters opening "npm ERR! code ELIFECYCLE"
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent shows that turn as "npm ERR! code ELIFECYCLE" and states 40000 characters
    And the whole packet is under 3000 characters

  @D156 @D207
  Scenario: the stop hook asks for a bookmark when the interval has elapsed
    Given a session whose checkpoint interval is 20 rounds or 45 minutes
    And the session's newest checkpoint is 21 rounds old
    When the agent is about to stop its turn
    Then the stop hook asks the agent to write a bookmark before it stops

  @D156
  Scenario: a fresh checkpoint of either kind lets the agent stop
    Given a session whose checkpoint interval is 20 rounds or 45 minutes
    And the session's newest checkpoint is a bookmark 1 round old
    When the agent is about to stop its turn
    Then the stop hook lets the agent stop
    And with a chapter summary 1 round old in place of the bookmark, the stop hook lets the agent stop

  @D157 @D207
  Scenario Outline: the default interval trips when the newest checkpoint is <age> old
    Given a developer who never set a checkpoint interval
    And the session's newest checkpoint is <age> old
    When the agent is about to stop its turn
    Then the stop hook <outcome>

    Examples:
      | age                      | outcome                                        |
      | 19 rounds and 44 minutes | lets the agent stop                            |
      | 19 rounds and 46 minutes | asks the agent to write a bookmark before it stops |
      | 20 rounds and 0 minutes  | asks the agent to write a bookmark before it stops |
      | 0 rounds and 45 minutes  | asks the agent to write a bookmark before it stops |
      | 0 rounds and 0 minutes   | lets the agent stop                            |

  @D163
  Scenario Outline: an interval of <value> is echoed back as <behaviour>
    Given a developer in their own session
    When the developer sets the checkpoint interval to <value>
    Then the developer sees the setting echoed back as "<behaviour>"

    Examples:
      | value                    | behaviour                          |
      | 0 rounds                 | off                                |
      | off                      | off                                |
      | 1 round                  | a bookmark at every stop           |
      | 1000 rounds and 1 week   | honored, which is effectively off  |

  @D163
  Scenario: a bookmark that cannot be written is reported once and never blocks
    Given a session whose store is read-only for this session
    And the session's newest checkpoint is 21 rounds old
    When the agent is about to stop its turn
    Then the stop hook's message to the developer reports once that the bookmark could not be written
    And the stop hook lets the agent stop
    And at the next stop, with the write still failing and the stop hook already active, the stop hook lets the agent stop without asking
    And the stop hook's message to the developer at that next stop carries no repeat of the report

  @D166
  Scenario: a new bookmark supersedes the previous one
    Given a session in which 3 bookmarks were written
    When the developer calls status
    Then the developer sees exactly one live bookmark for that session, the newest

  @D166
  Scenario: a superseded bookmark stays searchable
    Given a session in which 3 bookmarks were written, the oldest reading "at: scaffolding the login form"
    When the developer searches "scaffolding the login form"
    Then the developer finds the oldest bookmark

  @D158
  Scenario: status labels each live pointer with its kind
    Given a session holding one live chapter summary and one live bookmark
    When the developer calls status
    Then the developer sees each live pointer carry its kind, chapter summary or bookmark

  @D183
  Scenario: a chapter summary outranks a bookmark in search
    Given a bookmark written after a chapter summary, both containing "CSRF token refresh"
    When the developer searches "CSRF token refresh"
    Then the developer sees the chapter summary ranked above the bookmark

  @D171
  Scenario: the developer sees early that the session is being journaled
    Given a fresh session with capture on
    When the session starts
    Then the session-start hook's message to the developer names the store the session journals into

  @D171
  Scenario: a session that is not being journaled says so
    Given a fresh session whose store cannot be opened
    When the session starts
    Then the session-start hook's message to the developer says that the session is not being journaled and why

  @D175
  Scenario: the packet says what it could not read when the store is locked
    Given a session whose store is locked by another process at the moment of a /clear
    When the developer types /clear and sends the next prompt
    Then the packet handed to the agent says what it could not read
    And the session-start hook exits within its timeout without blocking the prompt

  @D175
  Scenario: doctor names a locked store as the cause with one command
    Given a session whose store is locked by another process
    When the developer runs doctor
    Then the developer sees the lock named as the cause and one command that clears it

  @D178
  Scenario: a sprint that pushes the store past its byte budget asks nothing of the developer
    Given a store pushed past its byte budget in the middle of a sprint
    When the retention valve runs
    Then no prompt or question reaches the developer
    And the developer running doctor sees the store reported healthy

  @D185
  Scenario: a retraction becomes the live pointer and the chapter it names is superseded
    Given a session whose newest chapter summary reads "plan: drop the login form"
    When the developer writes a retraction that names that chapter and reads "retracted: the login form stays"
    Then the developer calling status sees the retraction as the live pointer and the old chapter as superseded
    And the next packet after a /clear carries the retraction

  @D185
  Scenario: a retracted chapter summary stays findable by search
    Given a session whose chapter summary "plan: drop the login form" was retracted by a newer entry
    When the developer searches "drop the login form"
    Then the developer finds the retracted chapter summary
