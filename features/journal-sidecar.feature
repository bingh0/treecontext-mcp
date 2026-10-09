Feature: The sidecar pane — treecontext's half of a schema-blind display

  A running session is a black box. The journal fills, or it quietly does
  not, and nothing on screen says which — the failure that matters most is
  the one that looks like silence. treecontext answers by dropping a small
  JSON file beside its own store, which a renderer that knows nothing about
  treecontext can draw. The renderer never asks treecontext anything, never
  runs treecontext's code, and never triggers a refresh; it reads bytes.
  That asymmetry is the design: the pane is data, so a hostile renderer is
  contained by never executing ours, and hostile bytes are contained by the
  renderer validating every field it draws.

  The moment the pane stands on is the DRAIN — the tick that moves staged
  events into the journal. That is when the numbers change, and it is the
  only moment treecontext can honestly claim. A server that does not own
  the drain has no such moment and writes nothing at all. A drain that
  fails says so in the file, because a file cannot refuse a read the way a
  query surface can: stale health left on screen reads as an all-clear.

  Consumer contract: ccr's docs/PANE-CONTRACT.md v1. Neither project
  depends on the other; the join is one path named in the reader's own
  config. The panes therefore assert nothing about how they are drawn —
  only about what treecontext puts in the file and when.

  Naming that path by hand is where the whole thing died in the closed
  beta: not one macOS or Windows tester got a pane on screen, because a
  reader that survives a typo by drawing nothing makes every wiring
  mistake invisible — a backslash path, a byte-order mark, a bare string,
  the wrong directory. So treecontext offers to write the entry itself,
  the way it already writes its agent's config. The promises below are
  therefore about someone else's file, and they are conservative ones: we
  merge, we never clobber, we repair what a reader would skip, and we
  refuse rather than discard what we cannot understand.

  Post-charter surface (ruled 2026-08-27): chartered work under §1's
  "Sidecar (blob offload)" row, but no lettered detail — (h) is
  multi-agent orchestration (journal-namespaces). Consumer contract:
  ccr's PANE-CONTRACT.md v1; coverage row in tests/journal/README.md.

  @D102
  Scenario: no pane exists before the first drain has run
    Given a server started against a store whose drain has not yet run
    When a reader looks beside the store for a pane
    Then there is no pane file to read
    # Absence is the honest display. A placeholder pane written at startup
    # would claim health for a drain that has never happened.

  @D102
  Scenario: the first drain leaves a pane that a schema-blind reader accepts
    Given staged events waiting to be drained
    When the drain runs
    Then a pane file sits beside the store
    And a reader applying the published pane contract accepts it without knowing what treecontext is

  @D102
  Scenario: a pane names its producer and the moment its numbers were taken
    Given a drain that has written a pane
    When the pane is read
    Then it names treecontext as the producer of every claim on it
    And it names the drain as the moment those claims were counted

  @D102
  Scenario: every signal family appears, including the ones with nothing to report
    Given a store holding one drained event and nothing else
    When the drain writes the pane
    Then the pane carries a row for captured events, for the drain backlog, for gap markers, for curated notes, and for open threads
    And a family with nothing to report is present and readable rather than missing
    # The floor is the point: a family that vanishes when it has nothing to
    # say is indistinguishable from one that was never measured.

  @D102
  Scenario: a drain that fails confesses rather than leaving yesterday's health up
    Given a drain that cannot complete
    When the pane is written
    Then the pane reports itself broken and names what failed
    And it carries no rows that a reader would draw as health

  @D102
  Scenario: shutting down cleanly does not leave a pane claiming a failure
    Given a healthy pane and a drain still working when the server is told to stop
    When the store closes behind that drain
    Then the pane still on disk is the healthy one
    # A cancelled drain is not a failed drain. Stopping does not wait for a
    # batch already in flight, so that batch finishes against a closed
    # database and reports the connection as gone. Confessing that would
    # leave a pane accusing treecontext of breaking, outliving the session
    # that shut down cleanly — an all-clear's exact opposite, and just as
    # false. An observer hears about drains that happened, not about one
    # interrupted on the way out.

  @D102
  Scenario: a server that does not own the drain writes no pane
    Given a store already held by another treecontext server
    When a second server starts against that store and is refused the drain
    Then no pane appears beside the store
    # Refusal, not failure: the holder's data still stands, so writing
    # numbers from a drain that never ran would be the lie. Only the drain
    # owner ever reaches the producer, so the holder is the only writer
    # there can be — which is why nothing here has to check for that.

  @D102
  Scenario: the pane is a function of the journal and the drain moment, and nothing else
    Given an unchanged journal
    When a pane is computed twice for the same drain moment
    Then the two panes are byte-for-byte identical
    And every count on them is fixed at the moment it was taken rather than recomputed against whoever reads it later

  @D102
  Scenario: text that entered the journal from outside cannot carry terminal control onto the pane
    Given a curated note whose topic carries terminal escape bytes
    When the drain writes the pane
    Then the topic reaches the pane as inert text
    And no escape byte from the journal survives into the file
    # The reader strips too, and cannot trust us. Stripping twice is the
    # point: neither side is the only thing standing between a journal and
    # a terminal.

  @D102
  Scenario: a reader never catches the pane half-written
    Given a pane being rewritten many times in succession
    When a reader reads the file at arbitrary moments throughout
    Then every read yields a whole pane, never a partial one
    And no leftover temporary file is left beside the store

  @D102
  Scenario: the open threads pane names what the session is in the middle of
    Given a journal entry tagged to resume next session
    When the drain writes the panes
    Then one pane lists that thread under its own topic
    And a thread that a later entry superseded is listed as closed rather than dropped

  @D102
  Scenario: the trail pane reports what the journal is made of without grading it
    Given a journal of classified tool events alongside turns nothing classified
    When the drain writes the panes
    Then the trail pane reports how many events were classified each way
    And each share is taken against the events that were classified, not against the whole journal
    And none of those rows is coloured as a problem
    And the row a reader would misread says what produced its number
    # exit_type comes from matching substrings in tool output, so a grep
    # whose results mention an error is itself filed as one. Reporting that
    # as a defect rate would put a word search on screen dressed as a
    # measurement. Composition is honest; grading it is not.
    #
    # The denominator is load-bearing for the same reason: user turns and
    # curated notes carry no exit type, so counting them in would make every
    # share shrink as the agent wrote more notes — the trail would look
    # steadily cleaner while nothing about the tool calls had changed.

  @D102
  Scenario: the trail pane grades the one thing it can stand behind
    Given a journal whose stored bytes exceed the retention budget
    When the drain writes the panes
    Then the trail pane reports the store as over its budget
    And that row is coloured as worth a glance
    # The valve archives and demotes but never destroys, so over-budget is
    # "look at this", not "something was lost".

  @D102
  Scenario: a classification the journal learns later still reaches the pane
    Given a journal holding a user turn whose intent nothing here anticipated
    When the drain writes the panes
    Then the trail pane accounts for that turn alongside the ones it knows
    # Counted by grouping over what the journal recorded, never by summing
    # a fixed list — a list is how a new category silently becomes zero.

  @D102
  Scenario: the pane is rewritten on every drain, so its age is the drain's age
    Given two consecutive drains over a journal that did not change between them
    When each drain finishes
    Then the pane file is rewritten both times
    # Write time is the only currency signal the reader has. Skipping a
    # rewrite because the numbers matched would make a live session read as
    # stale, which is the exact misreading the pane exists to prevent.

  # ── Wiring the join (2026-08-22) ─────────────────────────────────────

  @D98
  Scenario: the wiring is written for the operator, in the reader's own config
    Given a machine with no reader config at all
    When the operator asks treecontext to wire this project's pane in
    Then the reader's config lists this project's pane
    And the file written carries no byte-order mark

  @D98
  Scenario: wiring twice is the same as wiring once
    Given a machine with no reader config at all
    When the operator asks treecontext to wire this project's pane in
    And the operator asks a second time
    Then the config is byte-for-byte what the first run wrote

  @D98
  Scenario: another tool's panes and settings survive the wiring
    Given a reader config that already lists another tool's pane and a setting of its own
    When the operator asks treecontext to wire this project's pane in
    Then both panes are listed, the other tool's first
    And the other tool's setting is still there

  @D98
  Scenario: an encoding the reader cannot parse is repaired, not discarded
    Given a reader config saved with a byte-order mark, listing another tool's pane
    When the operator asks treecontext to wire this project's pane in
    Then both panes are listed, the other tool's first
    And the file written carries no byte-order mark
    # The content was never the problem — the encoding was. Rewriting it
    # keeps what the operator had; retyping it is what we are here to end.

  @D98
  Scenario: a config that is not JSON at all is refused rather than overwritten
    Given a reader config that is not valid JSON
    When the operator asks treecontext to wire this project's pane in
    Then the command refuses and names the reason
    And the config is left exactly as it was
    # A file we cannot parse may hold panes we cannot see. Discarding it to
    # make our own entry fit would be the same silence we are fixing.

  @D98
  Scenario: an entry the reader ignores is still the operator's
    Given a reader config listing an entry treecontext does not understand
    When the operator asks treecontext to wire this project's pane in
    Then the reader's config lists this project's pane
    And the entry treecontext does not understand is still there
    # The reader skips it; that is the reader's business. Deleting it
    # because we could not read it would be our own silent failure.

  @D98
  Scenario: a config kept as a symlink stays a symlink
    Given a reader config that is a symlink into a dotfiles directory
    When the operator asks treecontext to wire this project's pane in
    Then the config is still a symlink
    And the pane landed in the file the link points at
    # Replacing the link with a regular file breaks the operator's
    # dotfiles and wires a pane their real config never sees.
