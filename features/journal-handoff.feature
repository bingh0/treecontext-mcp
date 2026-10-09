Feature: Handoff between teammates — a file through the shared repository

  Two developers, two machines, two stores. A handoff is a file one
  exports and commits and the other imports: summaries by default, the
  whole journal by deliberate choice with a warning. Everything new lands;
  anything truly already present is left alone, and the import never
  fails on a duplicate. Every imported entry is marked as imported from
  that file by the importer; the file's own claims are data, not
  identity. Content bound to or from a file never passes through the
  agent's conversation and carries no cap.

  Rulings D149, D151, D164, D165, D170, D172, D177, D184, D199 of the
  hackathon interview, 2026-10-05 to 2026-10-07.

  @D177 @D149
  Scenario: the default export carries summaries only
    Given developer A's store holding 2000 entries, among them the chapter summary "plan: wire the login form; next: write its tests", a bookmark, and the tester subagent's summary "12 tests pass, CSRF fails"
    When A exports a handoff without choosing a form
    Then the file A commits holds 2 entries, the chapter summary and the tester's summary, and no bookmark
    And the tool's reply carries no warning

  @D177 @D149
  Scenario: a whole-journal export warns about secrets before it writes
    Given developer A's store holding 2000 entries including captured tool output
    When A exports the whole journal for a handoff
    Then the tool's reply carries the warning that captured tool output can hold secrets, tokens and keys, and the file is written only after it
    And the file A commits holds 2000 entries

  @D151
  Scenario: an imported summary is marked as imported and counted
    Given a handoff file from developer A holding the chapter summary "plan: wire the login form; next: write its tests", written by A at 14:02 universal time
    When developer B imports it on their machine
    Then B searching "login" finds that summary marked as imported from that file by B, with A's time of 14:02
    And B is told that 1 entry landed and 0 were already present

  @D164
  Scenario: importing a whole journal twice lands it once
    Given developer B's store holding 500 entries of their own
    And a handoff file from developer A holding 2000 entries
    When B imports the file, then imports the same file again
    Then after the first import B is told that 2000 landed and 0 were already present
    And after the second import B is told that 0 landed and 2000 were already present
    And B's own 500 entries are unchanged

  @D164
  Scenario: a file born in this store imports without failing
    Given a file exported from a lane of developer B's own store, holding 40 entries
    When B imports that file into the same store
    Then the import does not fail
    And B is told that 0 landed and 40 were already present

  @D165
  Scenario: the file's authorship claims are data, not identity
    Given a handoff file whose entries claim to be developer A's chapter summaries, edited by hand before it was committed
    When developer B imports it
    Then every entry B sees is marked as imported from that file by B
    And no entry B sees is marked as A's own writing
    And the file's claims are kept on each entry as data

  @D170
  Scenario: a whole journal of any size lands in a file without transiting the conversation
    Given developer A's store holding 12000 entries
    When A exports the whole journal to a file
    Then the file holds all 12000 entries
    And the tool's reply carries only the file's name and the counts, none of the content

  @D170
  Scenario Outline: <entries> entries exported inline write <written> and state <omitted> omitted
    Given developer A's store holding <entries> entries
    When A exports the whole journal inline into the conversation
    Then the tool's reply holds the newest <written> entries
    And the tool's reply states that <omitted> were omitted and names the way to reach the rest

    Examples:
      | entries | written | omitted |
      | 12000   | 10000   | 2000    |
      | 500     | 500     | 0       |

  @D172
  Scenario: the handoff file says how to use itself
    Given developer A exported a handoff file on 2026-10-17 from the project "hackathon-app"
    When developer B opens the file
    Then B reads at its head who exported it, when, from which project, which treecontext version wrote it, what it holds, and the one step that imports it

  @D184 @D206
  Scenario: a handoff is announced in the packet from the sender's universal timestamps and a skewed clock is disclosed
    Given a handoff file from developer A holding 3 entries whose newest chapter summary is timestamped 3 hours in developer B's future
    When B imports it and then types /clear and sends the next prompt
    Then the packet handed to B's agent carries one line for the handoff naming A, 3 entries, and that chapter summary with its universal time
    And the packet says that chapter summary is timestamped in the future rather than correcting it
    And the packet's own chapter line is still B's newest chapter summary, not A's

  @D199
  Scenario: the agent writes the handoff file on the developer's request
    Given developer A asks their agent for a handoff file at "handoffs/login-plan.json" in the repository
    When the agent calls export with that path
    Then the server writes the file at that path
    And only the file's name and the counts appear in the tool's reply

  @D199
  Scenario: an export path outside the project is refused
    Given developer A asks their agent for a handoff file at "../../.ssh/handoff.json"
    When the agent calls export with that path
    Then the server refuses the path and writes nothing
    And the tool's reply names the project directory as the only place a handoff may be written

  @D165
  Scenario: an imported entry that claims to supersede a chapter lands as a reference only
    Given a handoff file holding an entry that supersedes developer B's own chapter summary by id
    When B imports it
    Then B calling status still sees that chapter summary as a live pointer
    And the entry lands carrying the chapter's id as a reference, not as a supersession

  @D199
  Scenario: a shell command writes the same file
    Given developer A's store holding the chapter summary "plan: wire the login form; next: write its tests"
    When A runs the export command in a shell with an output path
    Then the file at that path holds the same content the tool would have written
