Feature: The backup command — a copy the user asked for, nothing more

  `backup <dst>` is the user-facing copy: an online SQLite backup of the
  resolved store, written adjacent-then-renamed so a crash never leaves
  a half-file at the destination. Its refusals are as much the contract
  as its copies — no destination is an error that names the shape, an
  existing destination is refused unless forced, and resolution is
  read-only (an unbound directory errors with guidance instead of
  minting a binding — pinned in store-bindings.feature). What it does
  NOT do is also deliberate and fenced: no integrity verdict is
  recorded for user backups — verdicts belong to migration backups,
  whose twin-state at completion is what makes them checkable
  (tests/server/OUT-OF-SCOPE.md).

  Scenario: backup without a destination is an error
    Given a machine with a bound store
    When backup runs with no destination
    Then it exits with an error naming the missing destination

  Scenario: backup refuses to overwrite an existing destination
    Given a store with rows and a destination file that already exists
    When backup runs at that destination
    Then it refuses and names the force flag
    And the destination's original bytes survive

  Scenario: a forced backup replaces the destination
    Given a store with rows and a destination file that already exists
    When backup runs at that destination with force
    Then the destination is a valid copy holding the store's rows

  Scenario: backup copies the named store's rows
    Given a store with rows
    When backup runs to a fresh destination
    Then the destination is a valid copy holding the store's rows
    And it reports the copy it made
