Feature: stores list — the at-a-glance inventory

  Doctor remains the authoritative disk-debt surface (the fence's
  2026-08-12 amendment, pulling this in from the 2026-08-06 deferrals):
  the listing gains exactly two honesty fixes and nothing more — backup
  bytes split from live bytes, and a shell directory labeled as what it
  is instead of reading as an ordinary empty store.

  Scenario: backup bytes are split out of the size column
    Given store "notes" has a live database and a 128 KB pre-migration backup
    And store "scratch" has a live database and no backups
    When the user lists the stores
    Then the "notes" row carries the backup bytes in their own column
    And the "scratch" row's backups column is empty
    And the size column reports the database's bytes alone

  Scenario: a shell directory is labeled as one
    Given store "lectures" is a shell directory holding only a spared pre-migration backup
    When the user lists the stores
    Then the "lectures" row is labeled a shell
    And its backups column carries the backup's size

  Scenario: a shell holding a zero-byte backup shows 0B, not an empty cell
    Given store "interrupted" is a shell directory holding only a zero-byte backup
    When the user lists the stores
    Then the "interrupted" row is the only row, and it is labeled a shell
    And its backups column reads 0B rather than empty
    # An interrupted copy leaves an empty .bak behind. Presence, not
    # bytes, drives both the label and the cell — a row that says shell
    # while its backups column says nothing is the listing hiding the
    # file it can see.

  Scenario: an empty stores directory reports itself plainly
    Given a stores directory with nothing in it
    When the user lists the stores
    Then the listing says there are no stores and names the directory
    And no table header is printed

  Scenario: an unopenable database shows dashes, not a crash
    Given store "mangled" whose database file holds garbage bytes
    When the user lists the stores
    Then the "mangled" row shows dashes for its node counts
    And the healthy rows still render
    # One broken store must not take the inventory down with it: the
    # row degrades to dashes and every other store still reports.

  Scenario: a stray home-hash store is labeled
    Given an empty store named like this machine's home-hash derivation
    When the user lists the stores
    Then that row is labeled stray

  Scenario: user backups are invisible to the backups column
    Given store "keeper" has a live database and a user-made backup file beside it
    When the user lists the stores
    Then the "keeper" row's backups column is empty
    # Only pre-migration backups are counted — doctor stays the
    # authoritative disk-debt surface. A file the user copied there with
    # `backup <dst>` is the user's file, not the tool's debt.

  Scenario: the wal sibling is not part of the size column
    Given store "hot" has a live database beside a write-ahead log file
    When the user lists the stores
    Then the "hot" row's size column reports the database file's bytes alone
