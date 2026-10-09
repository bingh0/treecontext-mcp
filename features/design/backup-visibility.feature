Feature: Migration-backup visibility in doctor

  Migrations copy a store aside before destructively rewriting it, and the
  copies are invisible disk debt until someone looks. Doctor is the single
  INTERPRETING surface: it names every pre-migration backup, its verdict,
  and the one command that reclaims the space. (Staleness repair
  2026-08-12: stores-list also SHOWS backup bytes — a column split out of
  the size figure, no verdicts, no advice. The division is deliberate:
  the listing states sizes, doctor alone explains them and says what to
  do.) Silence when there is nothing to say is part of the contract —
  the pointer must be unobtrusive.

  A pre-migration backup is exactly the file the migration writes beside the
  store's database: `treecontext.db.pre-migration-v<N>.bak`, where N is the
  schema version the store held before migrating. Anything else — including
  a bare `pre-migration-v<N>.bak` missing the database prefix — is a foreign
  file and invisible here.

  Advice travels in each row's fix channel — the same field journal-install's
  universal clause ("every failing check is accompanied by the command that
  fixes it") enumerates over doctor's whole registry. A row's detail states
  what the backup is; its fix says what to do about it, and a by-hand
  decision is stated as one rather than dressed up as a command.

  Scenario: doctor reports each pre-migration backup and the total
    Given a stores directory holding stores "notes", "lectures", and "scratch"
    And store "notes" has a pre-migration backup from schema version 12 of 308 KB with a recorded success verdict
    And store "lectures" has a pre-migration backup from schema version 17 of 1200 KB with a recorded success verdict
    And store "scratch" has no backup files
    When the user runs doctor
    Then the report lists the "notes" backup with its store name, source schema version 12, size 308 KB, and a success verdict
    And the report lists the "lectures" backup with its store name, source schema version 17, size 1200 KB, and a success verdict
    And the report states a total of 2 backups occupying 1508 KB
    And the backup section ends with a single line naming the exact sweep command to run

  Scenario: doctor prints no backup section when no backups exist
    Given a stores directory where no store has a pre-migration backup
    When the user runs doctor
    Then the report contains no backup section

  Scenario: doctor labels a backup that has no recorded migration verdict
    Given store "ml-lecture" has a pre-migration backup from schema version 12 created before verdict recording existed
    When the user runs doctor
    Then the report lists that backup labeled "no migration verdict"
    And the listing says removing it is a by-hand decision

  Scenario: doctor points out an orphaned spared backup
    Given store "notes" is a shell directory holding only a spared pre-migration backup with a failed verdict
    When the user runs doctor
    Then the report lists that backup and states its live store is gone
    And the listing says restoring or deleting it is a by-hand decision

  Scenario: doctor points out an orphaned verified backup and names the reclaim command
    Given store "notes" is a shell directory holding only a pre-migration backup with a recorded success verdict
    When the user runs doctor
    Then the report lists that backup and states its live store is gone
    And the listing names the exact stores rm command that reclaims it

  Scenario: doctor is honest about an orphan the CLI cannot address
    Given a shell directory named "notes copy" holding only a pre-migration backup with a recorded success verdict
    When the user runs doctor
    Then the report lists that backup and states its live store is gone
    And the listing says the directory is removed by hand because the CLI cannot address its name

  Scenario: doctor lists an orphaned verdict sidecar and names the sweep
    Given store "notes" has a verdict sidecar file whose backup no longer exists
    When the user runs doctor
    Then the report lists the sidecar as an orphaned verdict sidecar
    And the listing names the exact sweep command to run

  Scenario: every backup warning carries its remediation in the fix channel
    Given store "notes" has a pre-migration backup from schema version 12 created before verdict recording existed
    And store "lectures" is a shell directory holding only a spared pre-migration backup with a failed verdict
    And store "scratch" has a verdict sidecar file whose backup no longer exists
    When the user runs doctor
    Then every backup row that warns carries a fix entry
    # The cross-feature conflict this closes (E chunk 3): these rows used
    # to put their advice in detail, green against journal-install's
    # universal fix-command clause only because its enumerated worlds
    # happened to hold no backups.

  Scenario: files not matching the pre-migration pattern are invisible to doctor
    Given store "notes" has a hand-made file "treecontext.db.bak" beside its database
    And store "notes" has a hand-made file "backup-old.bak" beside its database
    And store "notes" has a hand-made file "pre-migration-v12.bak" beside its database
    And no store has a pre-migration backup
    When the user runs doctor
    Then the report contains no backup section
    And none of the hand-made files is mentioned anywhere in the report
