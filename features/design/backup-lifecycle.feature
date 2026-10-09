Feature: Migration-backup lifecycle

  A backup is verified once, at the completion of the migration run that
  copied it, while it and the live store are still twins — the verdict
  recorded then is what the sweep trusts later, because sweep-time content
  comparison breaks against eviction and ordinary drift. A retry that kept
  an earlier attempt's backup records no verdict: that file is no one's
  twin, and a guessed verdict whose warning advises restoring a stale copy
  would be worse than none. And a backup leaves the world three ways:
  swept after verification, taken by stores rm or stores prune along with
  its store, or — when its verdict is success and its live store is
  already gone — taken by an explicit stores rm of the shell that holds
  it. A backup whose verdict is failed or missing is still a live
  rollback: rm and prune leave it behind, and it leaves only by hand.

  Removing a store means its database is gone. Because backups live beside
  the database inside the store's directory, sparing a backup means the
  directory survives as a shell holding nothing but that backup — and
  neither rm nor prune ever takes a spared backup, on the first run or any
  later one; a spared backup leaves only by hand, and doctor points it out.

  Exit status follows action, not the fence (ruled 2026-08-11, second-pass
  amendment): an rm that removed what it could and spared the rest is a
  completed removal and exits as success, while a rollback-only shell rm
  can do nothing to is a refusal and exits as one. The asymmetry is
  refusal-vs-partial-action, stated here rather than accidental.

  Scenario: a destructive migration records a success verdict at completion
    Given a store at schema version 12 holding 36 entries
    When the store is opened and migrates to the current schema version
    Then a pre-migration backup from schema version 12 exists beside the store
    And the migrated store still holds all 36 entries
    And a success verdict is recorded for that backup
    And doctor lists that backup with a success verdict

  Scenario: a retry that kept an earlier backup records no verdict
    Given a store at schema version 12 holding 36 entries
    And a pre-migration backup from an earlier unfinished attempt already sits beside it
    When the store is opened and migrates to the current schema version
    Then the earlier backup file is kept byte-for-byte
    And no verdict is recorded for that backup
    And doctor lists that backup labeled "no migration verdict"

  Scenario: a migration whose completion comparison fails records a failed verdict
    Given a destructive migration finished with the migrated store holding 35 of the backup's 36 entries
    When the completion comparison runs
    Then a failed verdict is recorded for that backup
    And a warning at migration time names the backup file as the intact pre-migration copy
    And the store still opens and serves
    And doctor lists that backup with a failed verdict
    And the doctor listing for that backup states the one action that restores it by hand

  Scenario: stores rm names the backup it would take
    Given store "notes" has a pre-migration backup with a recorded success verdict
    When the user runs stores rm for "notes" without --yes
    Then the output names both the store and its backup as what would be removed
    And both files still exist

  Scenario: stores rm with --yes takes verified backups with the store
    Given store "notes" has a pre-migration backup with a recorded success verdict
    When the user runs stores rm for "notes" with --yes
    Then the store no longer exists
    And the backup file no longer exists

  Scenario Outline: stores rm spares a backup whose verdict is <verdict state>
    Given store "notes" has a pre-migration backup whose verdict is <verdict state>
    When the user runs stores rm for "notes" with --yes
    Then the store's database no longer exists
    And the backup file still exists in the store's directory
    And the output says the backup was left behind because its verdict is <verdict state>
    And the exit status indicates success

    Examples:
      | verdict state |
      | failed        |
      | missing       |

  Scenario: stores rm refuses a shell that holds only a spared backup
    Given store "notes" is a shell directory holding only a spared pre-migration backup with a failed verdict
    When the user runs stores rm for "notes" with --yes
    Then the backup file still exists
    And the output says only a spared backup remains and that it is removed by hand
    And the exit status indicates refusal

  Scenario: stores rm without --yes names an orphaned verified backup as reclaimable
    Given store "notes" is a shell directory holding only a pre-migration backup with a recorded success verdict
    When the user runs stores rm for "notes" without --yes
    Then the output names both the shell directory and its orphaned verified backup as what would be removed
    And the backup file still exists

  Scenario: stores rm reclaims a shell holding only an orphaned verified backup
    Given store "notes" is a shell directory holding only a pre-migration backup with a recorded success verdict
    When the user runs stores rm for "notes" with --yes
    Then the store directory no longer exists
    And the output says it removed an orphaned verified backup

  Scenario: stores rm on a shell holding both an orphaned verified backup and a live rollback
    Given store "notes" is a shell directory holding a pre-migration backup with a recorded success verdict and another whose verdict is failed
    When the user runs stores rm for "notes" with --yes
    Then the verified backup no longer exists
    And the failed-verdict backup still exists in the store's directory
    And the output says the directory survives as a shell
    And the exit status indicates success

  Scenario: stores prune without --yes previews the removals and the spare rule
    Given a stray autostore whose live store holds zero entries
    And that store has a pre-migration backup whose recorded verdict is failure
    When the user runs stores prune without --yes
    Then the stray is listed with its size as what would be removed
    And the preview says the backup would be left behind as a live rollback
    And the store and its backup still exist
    And the output says to re-run with --yes to actually delete
    # The dry-run promises what --yes delivers, spare rule included — a
    # preview that hides the surviving shell undersells the outcome (the
    # 2026-08-11 amendment's defect class, "prune's silent shell"; the fix
    # landed on both surfaces, the scenario only on rm's until E chunk 3).

  Scenario: stores prune takes a stray's verified backup with the store
    Given a stray autostore whose live store holds zero entries
    And that store has a pre-migration backup with a recorded success verdict
    When the user runs stores prune with --yes
    Then the store no longer exists
    And the backup file no longer exists

  Scenario: stores prune spares a live-rollback backup just like rm
    Given a stray autostore whose live store holds zero entries
    And that store has a pre-migration backup whose recorded verdict is failure
    When the user runs stores prune with --yes
    Then the store's database no longer exists
    And the backup file still exists in the store's directory
    And the output says the backup was left behind because its verdict is failed
