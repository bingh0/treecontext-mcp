Feature: Runs — a run is a unit the harness reads by key and anyone reconstructs with plain SQL

  A run is the unit a harness or a main agent works in: a run id, the
  keys its legs checkpoint under, an opening and a close. With no model
  in the loop the harness asks by run and key together and receives the
  one checkpoint in effect, its writer, the run's facts and each live
  leg's age. The store judges nothing: a stranger's checkpoint comes
  back flagged, never withheld; a checkpoint's shape is the harness's
  grammar, never parsed here. The rows a run is made of, the first-moment
  row, each checkpoint, each summary row and the run's open and close,
  are journal rows carrying the run and the key, so an agent finds a run
  by time or by name with no id in hand; a captured row reaches the run
  through its leg's lane. A run's legs across stores come back by the
  handoff, and a run opened inside a run is reachable from both ends.

  Rulings D289, D296, D300, D301, D302, D309, D310, D311, D312, D318,
  D336, D337, D343, D344 of the beta.3 interview, 2026-10-30 to 2026-10-31. The legs are
  journal-legs; the workers are journal-workers.

  @D289
  Scenario: the harness asks by run and key with no model and receives the one checkpoint in effect
    Given a run "r1" with 4 legs, all exited, whose key "login-form" holds checkpoints number 1 to 4, number 4 written by the reviewer role
    And a run "r2" whose key "login-form" holds its own checkpoint number 2 and a live builder leg
    When a harness with no model asks for the checkpoint in effect under the key "login-form" on the run "r1"
    Then the harness receives checkpoint number 4 of "r1" with the writer "reviewer", never the checkpoint of "r2"
    And the harness sees each of the 4 legs of "r1" as retired
    And the same harness asking on the run "r2" sees its builder leg as live

  @D289
  Scenario: a key that holds no checkpoint yet comes back as an honest nothing
    Given a run "r1" whose key "search-box" holds no checkpoint and one live builder leg
    When a harness with no model asks for the checkpoint in effect under the key "search-box" on the run "r1"
    Then the harness receives no checkpoint and a line saying none is in effect under "search-box"
    And the harness sees the builder leg as live
    And the harness receives no checkpoint of any other key or run

  @D289
  Scenario: a run's rows read back by plain SQL in the order of their own moments, each naming its writer and moment, each leg naming its run and key
    Given a run "r1" whose builder leg wrote a row at 09:14:02 that the drain ingested after the reviewer's row of 09:15:30
    And a run "r2" with 10 rows of its own
    When a reader runs plain SQL against the store file for the run "r1"
    Then the reader sees the builder's row before the reviewer's, each row naming its writer and its moment
    And every leg of "r1" names the run "r1", its key and its parent session, and the builder's captured rows reach "r1" through the builder's lane
    And none of the 10 rows of "r2" read back among them

  @D296
  Scenario: a stranger's checkpoint comes back as the one in effect, flagged against the named checkpointer
    Given a brief stored on the run "r1" naming the builder as the checkpointer of the key "login-form"
    And checkpoint number 5 under the key "login-form" written by the builder role, and checkpoint number 6, the newest in effect, written by the writer "intruder"
    When the harness looks up the key "login-form" on the run "r1"
    Then the harness receives checkpoint number 6 with the writer "intruder", not number 5
    And the same reply says its writer is not the checkpointer the brief names

  @D296
  Scenario: a checkpoint by the named checkpointer comes back with no flag
    Given a brief stored on the run "r1" naming the builder as the checkpointer of the key "login-form"
    And checkpoint number 5 under the key "login-form", the newest in effect, written by the builder role
    When the harness looks up the key "login-form" on the run "r1"
    Then the harness receives checkpoint number 5 with the writer "builder"
    And the reply carries no flag about its writer

  @D344 @D301
  Scenario: every key lookup carries the run's facts beside the checkpoint
    Given a run "r1" started 3 hours ago on which 7 legs have run and whose key "login-form" holds 4 checkpoints, the last three of 900, 1200 and 15000 characters
    When the harness looks up the key "login-form" on the run "r1"
    Then the harness receives, beside the checkpoint, the leg count 7, the checkpoint count 4, the run age of 3 hours and the sizes 900, 1200 and 15000

  @D312
  Scenario: the run's facts show each live leg's start and last write
    Given a run "r1" with a live builder leg that started 2 hours ago and last wrote a row 90 minutes ago
    When the harness looks up the key "login-form" on the run "r1"
    Then the harness receives, for the builder leg, its start moment 2 hours ago and its last write 90 minutes ago
    And the reply judges nothing about whether the leg is stuck

  @D302
  Scenario: a run opens on its first leg's registration
    Given a store holding no run "r1"
    When a builder leg registers under the run "r1"
    Then a reader with the store file sees the run "r1" opened at that registration's moment

  @D302
  Scenario: a harness may open a run explicitly before any leg
    Given a store holding no run "r2"
    When a harness opens the run "r2" through the door with no leg yet
    Then a reader with the store file sees the run "r2" opened by the harness at that moment, with no legs

  @D302
  Scenario: the harness closes a run with a reason and plain SQL shows who ended it and why
    Given a run "r1" whose builder leg wrote the checkpoint "done, I think" that the harness's grammar cannot parse
    When the harness retires the leg and closes the run "r1" through the door with the reason "checkpoint did not parse"
    Then a reader running plain SQL against the store file sees the run "r1" ended at that moment, by the harness, with the reason "checkpoint did not parse"
    And the checkpoint "done, I think" is stored unchanged, never parsed or refused by the store

  @D309
  Scenario: an agent finds a run by time with no id in hand
    Given a store holding a run from last Tuesday with 3 first-moment rows, and runs from other days
    When an agent queries for what ran last Tuesday
    Then the agent's hits include that run's 3 first-moment rows, each carrying the run and its key
    And a query filtered by the run those rows carry returns the run's checkpoints and summary rows

  @D309
  Scenario: an agent finds a run by its name
    Given a run "r1" with 2 legs, and a run "r2" with 2 legs
    When an agent queries "r1"
    Then the agent's hits are rows of "r1" and none of "r2"

  @D309
  Scenario: a run's open and close are journal rows the query reaches
    Given a run "r1" opened on Tuesday and closed on Wednesday with the reason "all keys delivered"
    When an agent queries "all keys delivered"
    Then the agent's hit is the run's close row, carrying the run "r1" and the reason
    And the open row of "r1" is reachable from it by the run

  @D343 @D310
  Scenario: a leg that ran on another machine comes back into the run by the handoff, and its claim is believed, flagged
    Given a run "r1" in the store on "laptop" with 2 legs whose key "login-form" holds checkpoint number 2, and a third leg of "r1" that ran on "build-02" and wrote checkpoint number 3 under "login-form" there, naming number 2 as superseded
    When the run "r1" is exported on "build-02" and imported on "laptop"
    Then the harness on "laptop" looking up the key "login-form" on the run "r1" counts 3 legs
    And the harness receives the imported number 3 as the one in effect, flagged as arrived by import, and not number 2
    And checkpoint number 2 is unchanged byte for byte and still readable by its id
    And the imported row keeps its claim under the file's claims, not as its own identity

  @D311
  Scenario: a leg opens a run of its own and both runs reach each other
    Given a run "r1" whose reviewer leg, under the key "login-form", spawns 2 workers under a run "r1.review" it opens, with their own key "login-form"
    When a reader walks the run "r1"
    Then the reviewer leg's facts say it opened the run "r1.review"
    And the open row of "r1.review" names the run "r1" and the reviewer leg as declared
    And the run "r1" counts the reviewer leg as one leg, not three
    And the harness looking up the key "login-form" on the run "r1" receives the reviewer leg's checkpoint, never a checkpoint of "r1.review"

  @D311
  Scenario: nesting is not limited to one level
    Given a run "r1" whose leg opened "r1.review", whose leg opened "r1.review.fix"
    When a reader walks the run "r1"
    Then the reader reaches the legs of "r1.review.fix" through "r1.review"
    And the open row of "r1.review.fix" names "r1.review" and the leg that opened it

  @D300
  Scenario: a run's default export is its skeleton, with no captured tool output
    Given a run "r1" with a builder leg and a reviewer leg, 4 checkpoints under the key "login-form" and 2 under the key "search-box", 2 summary rows, 2 first-moment rows and 120 captured tool calls
    When an agent exports the run "r1" without naming a form
    Then the file holds the 6 checkpoints under both keys in order, the 2 summary rows with their writers "builder" and "reviewer", the 2 first-moment rows and the 2 registrations
    And the file holds none of the 120 tool calls
    And the file's head names the form as the run's skeleton

  @D300
  Scenario: the whole form adds every row of every leg behind the secrets acknowledgement
    Given a run "r1" with 120 captured tool calls across its legs
    When a harness exports the run "r1" naming the whole form
    Then the reply carries the warning that captured tool output can hold secrets, tokens and keys, and the file is written only after it
    And the file holds the 120 tool calls under each leg's lane

  @D318
  Scenario: the skeleton carries first moments whole and its reply says they are the spawners' prompts as written
    Given a run "r1" whose builder's first-moment row holds a 300000-character prompt
    When an agent exports the run "r1" without naming a form
    Then the file holds all 300000 characters of that first-moment row
    And the reply says in one line that first moments carry the spawners' prompts as written and may hold what was pasted into them
    And no acknowledgement is asked for

  @D336 @D289
  Scenario: the lookup reply carries the pointer to the return of the leg that wrote the checkpoint
    Given a run "r1" whose key "login-form" holds checkpoint number 4, written by a reviewer leg that finished with the report "review done; two fixes"
    When a harness with no model asks for the checkpoint in effect under the key "login-form" on the run "r1"
    Then the harness receives checkpoint number 4 with the writer "reviewer" and a pointer to the reviewer leg's summary row reading "review done; two fixes"

  @D336 @D289
  Scenario: a leg that left no return is said so, never guessed
    Given a run "r1" whose key "login-form" holds checkpoint number 4, written by a builder leg that was cut after writing it and left no summary row
    When a harness with no model asks for the checkpoint in effect under the key "login-form" on the run "r1"
    Then the harness receives checkpoint number 4 and a line saying the builder leg left no return

  @D337 @D301
  Scenario: an agent gets the same lookup reply as the harness through the tools
    Given a run "r1" started 3 hours ago whose key "login-form" holds checkpoint number 4, written by the writer "intruder" against a brief naming the builder
    When an agent asks through treecontext's tools for the checkpoint in effect under the key "login-form" on the run "r1"
    Then the agent receives checkpoint number 4 with the writer "intruder", the flag that its writer is not the named checkpointer, the run's facts and the pointer to the leg's return, the same as the harness's reply

  @D337 @D302
  Scenario: an agent closes a run through the tools and the record is the same as the harness's
    Given a run "r1" open with 2 legs retired
    When the main agent declares the run "r1" closed through treecontext's tools with the reason "all keys delivered"
    Then a reader with the store file sees the run "r1" ended at that moment, by the main agent, with the reason "all keys delivered"

  @D344 @D301
  Scenario Outline: a key with <count> checkpoints returns the sizes of the last <shown>
    Given a run "r1" whose key "login-form" holds <count> checkpoints
    When the harness looks up the key "login-form" on the run "r1"
    Then the harness receives the sizes of the last <shown> checkpoints under the key, newest last

    Examples:
      | count | shown |
      | 0     | 0     |
      | 1     | 1     |
      | 3     | 3     |
      | 40    | 3     |
